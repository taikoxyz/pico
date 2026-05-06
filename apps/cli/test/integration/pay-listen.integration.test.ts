import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_ADDRESSES,
  type Channel,
  type ChannelState,
  type SignedState,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@inferenceroom/pico-protocol';
import {
  ChannelClient,
  FileStorage,
  WebSocketTransport,
  generateKeysendKeypair,
  hexToSignature,
  localSigner,
} from '@inferenceroom/pico-sdk';
import { buildChannelStateTypedData } from '@inferenceroom/pico-state-machine';
import { type MockHubHandle, startMockHub } from '@inferenceroom/pico-test-utils';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invoiceCommand } from '../../src/commands/invoice.js';
import { payCommand } from '../../src/commands/pay.js';
import { decodeInvoiceEnvelope } from '../../src/runtime/invoice-envelope.js';

const ALICE_PK = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const PAYMENT_CHANNEL = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const VERIFYING_CONTRACT = CONTRACT_ADDRESSES[CHAIN_ID].Adjudicator;
const TOKEN = USDC_TOKENS[CHAIN_ID].address;

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

async function preopenChannel(
  aliceStorage: FileStorage,
  bobStorage: FileStorage,
  hub: MockHubHandle,
): Promise<Channel> {
  const aliceAddr = privateKeyToAccount(ALICE_PK).address;
  const bobAddr = privateKeyToAccount(BOB_PK).address;
  const channelId = `0x${'cd'.repeat(32)}` as `0x${string}`;
  const channel: Channel = {
    id: channelId,
    chainId: CHAIN_ID,
    contract: PAYMENT_CHANNEL,
    userA: aliceAddr,
    userB: bobAddr,
    token: TOKEN,
    status: 'open',
    openedAt: BigInt(Date.now()),
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
  await aliceStorage.saveChannel(channel);
  await bobStorage.saveChannel(channel);
  hub.registerChannel(channel);

  const state: ChannelState = {
    channelId,
    version: 1n,
    balanceA: 1_000_000n,
    balanceB: 0n,
    htlcs: [],
    finalized: false,
  };
  const aliceAccount = privateKeyToAccount(ALICE_PK);
  const bobAccount = privateKeyToAccount(BOB_PK);
  const typedData = buildChannelStateTypedData(state, CHAIN_ID, VERIFYING_CONTRACT);
  const sigA = hexToSignature(await aliceAccount.signTypedData(typedData));
  const sigB = hexToSignature(await bobAccount.signTypedData(typedData));
  const signedState: SignedState = { state, sigA, sigB };
  await aliceStorage.saveState(channelId, signedState);
  await bobStorage.saveState(channelId, signedState);

  return channel;
}

describe('pay → listen integration via mock hub', () => {
  let hub: MockHubHandle;
  let aliceDir: string;
  let bobDir: string;

  beforeEach(async () => {
    hub = await startMockHub({
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      hubPrivateKey: '0x00000000000000000000000000000000000000000000000000000000000000bb',
    });
    aliceDir = mkdtempSync(join(tmpdir(), 'alice-'));
    bobDir = mkdtempSync(join(tmpdir(), 'bob-'));
  });

  afterEach(async () => {
    await hub.stop();
  });

  it('Alice pays a Bob-issued invoice through the mock hub', async () => {
    const aliceStorage = new FileStorage({ root: join(aliceDir, 'db') });
    const bobStorage = new FileStorage({ root: join(bobDir, 'db') });
    await preopenChannel(aliceStorage, bobStorage, hub);

    // Bob creates an invoice via the CLI command (writes envelope to stdout, persists locally).
    const bobInvoiceOut = new StubStream();
    const bobInvoice = invoiceCommand({
      env: { PICO_CONFIG_DIR: bobDir, PICO_PRIVATE_KEY: BOB_PK },
      stdout: bobInvoiceOut,
      storageOverride: join(bobDir, 'db'),
    });
    await bobInvoice.parseAsync(['node', 'pico', 'create', '--amount', '50000', '--memo', 'svc']);
    const envelope = bobInvoiceOut.buf.trim();
    expect(envelope.startsWith('pico1:')).toBe(true);
    const decoded = decodeInvoiceEnvelope(envelope);

    // Bob runs as a listener (in-process, with the same FileStorage so he sees his own invoice).
    const bobKeysend = generateKeysendKeypair();
    const bobTransport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const bobChainAdapter = {
      openChannel: async () => {
        throw new Error('no');
      },
      closeCooperative: async () => {
        throw new Error('no');
      },
      closeUnilateral: async () => {
        throw new Error('no');
      },
      finalize: async () => {
        throw new Error('no');
      },
      waitForFinalized: async () => {
        throw new Error('no');
      },
    };
    const bobClient = new ChannelClient({
      signer: localSigner(BOB_PK),
      transport: bobTransport,
      storage: bobStorage,
      chain: bobChainAdapter as unknown as ConstructorParameters<typeof ChannelClient>[0]['chain'],
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      defaultToken: TOKEN,
      htlcExpiryMs: 60_000n,
      settleTimeoutMs: 5_000,
      encryptionPubkey: bobKeysend.publicKey,
      encryptionSecretKey: bobKeysend.secretKey,
    });
    await bobTransport.connect();
    await bobClient.ensureSubscribed([decoded.paymentHash as never]);

    // Alice runs `pico pay --invoice <env>` against the mock hub.
    const aliceOut = new StubStream();
    const aliceCmd = payCommand({
      env: { PICO_CONFIG_DIR: aliceDir, PICO_PRIVATE_KEY: ALICE_PK },
      stdout: aliceOut,
      storageOverride: join(aliceDir, 'db'),
      transportOverride: { url: hub.url, autoReconnect: false },
    });
    await aliceCmd.parseAsync([
      'node',
      'pico',
      '--invoice',
      envelope,
      '--via',
      hub.url,
      '--json',
      '--reveal-preimage',
    ]);

    expect(aliceOut.buf).toContain('"settled":true');
    expect(aliceOut.buf).toMatch(/"preimage":"0x[0-9a-f]{64}"/);

    // Bob's stored invoice should now be marked consumed.
    const stored = await bobStorage.loadInvoice(decoded.paymentHash);
    expect(stored?.consumedAt).toBeDefined();

    await bobTransport.close();
  }, 30_000);
});
