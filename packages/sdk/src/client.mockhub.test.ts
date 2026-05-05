import {
  type Address,
  CONTRACT_ADDRESSES,
  type Channel,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@pico/protocol';
import {
  InMemorySigner,
  MockChainAdapter,
  type MockHubHandle,
  startMockHub,
} from '@pico/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelClient } from './client.js';
import { generateKeysendKeypair } from './keysend.js';
import { MemoryStorage } from './storage.js';
import { WebSocketTransport } from './transport.js';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const VERIFYING_CONTRACT = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const TOKEN: Address = USDC_TOKENS[CHAIN_ID].address;

interface Party {
  readonly client: ChannelClient;
  readonly chain: MockChainAdapter;
  readonly storage: MemoryStorage;
  readonly transport: WebSocketTransport;
  readonly signer: InMemorySigner;
  readonly address: Address;
}

async function makeParty(
  privateKey: `0x${string}`,
  hubUrl: string,
  encryption?: { publicKey: `0x${string}`; secretKey: `0x${string}` },
): Promise<Party> {
  const signer = new InMemorySigner(privateKey);
  const address = await signer.address();
  const storage = new MemoryStorage();
  const chain = new MockChainAdapter({
    chainId: CHAIN_ID,
    contract: VERIFYING_CONTRACT,
    userA: address,
  });
  const transport = new WebSocketTransport({ url: hubUrl, autoReconnect: false });
  const client = new ChannelClient({
    signer,
    transport,
    storage,
    chain,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    defaultToken: TOKEN,
    htlcExpiryMs: 60_000n,
    settleTimeoutMs: 5_000,
    closeRequestTimeoutMs: 2_000,
    safetyMarginMs: 1_000n,
    hubFeeBps: 0n,
    hubFeeFlat: 0n,
    ...(encryption !== undefined
      ? { encryptionPubkey: encryption.publicKey, encryptionSecretKey: encryption.secretKey }
      : {}),
  });
  return { client, chain, storage, transport, signer, address };
}

describe('ChannelClient integration with MockHub', () => {
  let hub: MockHubHandle;
  let alice: Party;
  let bob: Party;

  beforeEach(async () => {
    hub = await startMockHub({
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      hubPrivateKey: BOB_KEY,
    });
    alice = await makeParty(ALICE_KEY, hub.url);
    const bobKeysend = generateKeysendKeypair();
    bob = await makeParty(BOB_KEY, hub.url, bobKeysend);
  });

  afterEach(async () => {
    await alice.transport.close();
    await bob.transport.close();
    await hub.stop();
  });

  async function openAliceBobChannel(): Promise<Channel> {
    // Alice opens a channel with Bob as counterparty.
    const channel = await alice.client.open({
      counterparty: bob.address,
      amount: 1_000_000n,
      token: TOKEN,
    });
    // Mirror the channel on Bob's side so Bob's storage knows about it.
    await bob.storage.saveChannel(channel);
    const initial = await alice.storage.loadLatestState(channel.id);
    if (!initial) throw new Error('no initial state');
    await bob.storage.saveState(channel.id, initial);
    // Register the channel with the hub so it routes between the two.
    hub.registerChannel(channel, initial);
    // Bob subscribes to start receiving HTLCs.
    await bob.client.ensureSubscribed([channel.id]);
    return channel;
  }

  it('open + invoice pay + settle round-trip', async () => {
    const channel = await openAliceBobChannel();

    const { invoice, preimage } = await bob.client.createInvoice({ amount: 100n, memo: 'thanks' });

    const settledEvents: { direction: string }[] = [];
    bob.client.on('htlc:settled', (e) => settledEvents.push({ direction: e.direction }));

    const result = await alice.client.pay({ invoice });

    expect(result.channelId).toBe(channel.id);
    expect(result.preimage).toBe(preimage);
    expect(settledEvents.some((e) => e.direction === 'incoming')).toBe(true);

    const aliceState = await alice.storage.loadLatestState(channel.id);
    expect(aliceState?.state.balanceA).toBe(1_000_000n - 100n);
    expect(aliceState?.state.balanceB).toBe(100n);
    expect(aliceState?.state.htlcs).toEqual([]);
    expect(hub.pendingHtlcs()).toEqual([]);

    const bobInvoice = await bob.storage.loadInvoice(invoice.paymentHash);
    expect(bobInvoice?.consumedAt).toBeGreaterThan(0);
  });

  it('rejects an expired invoice on the sender side', async () => {
    await openAliceBobChannel();
    const { invoice } = await bob.client.createInvoice({
      amount: 50n,
      expiryMs: BigInt(Date.now() - 1000),
    });
    await expect(alice.client.pay({ invoice })).rejects.toThrow(/expired/i);
  });

  it('keysend payment: sender encrypts preimage to bob, bob decrypts and settles', async () => {
    const channel = await openAliceBobChannel();
    // bob's encryption pubkey is randomly generated per beforeEach; recover it.
    // Alice needs Bob's encryption pubkey (out-of-band exchange in production).
    const bobPubkey = (bob.client as unknown as { opts: { encryptionPubkey: `0x${string}` } }).opts
      .encryptionPubkey;
    expect(bobPubkey).toBeDefined();

    const result = await alice.client.pay({
      to: bob.address,
      amount: 200n,
      keysend: true,
      recipientEncryptionPubkey: bobPubkey,
      memo: 'tip',
    });

    expect(result.channelId).toBe(channel.id);
    const aliceState = await alice.storage.loadLatestState(channel.id);
    expect(aliceState?.state.balanceA).toBe(1_000_000n - 200n);
    expect(aliceState?.state.balanceB).toBe(200n);
  });

  it('inbound HTLC with unknown paymentHash and no keysend payload is failed', async () => {
    await openAliceBobChannel();
    // Build a fake invoice that bob never created.
    const fakeInvoice = {
      paymentHash: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      amount: 50n,
      recipient: bob.address,
      expiryMs: BigInt(Date.now() + 60_000),
      nonce: '0x000102030405060708090a0b0c0d0e0f',
      signature: `0x${'00'.repeat(65)}`,
    } as const;
    await expect(alice.client.pay({ invoice: fakeInvoice })).rejects.toThrow();
  });

  it('payDirect: 2-party non-HTLC balance update with hub counter-sig', async () => {
    const channel = await openAliceBobChannel();
    const before = await alice.storage.loadLatestState(channel.id);
    expect(before?.state.version).toBe(1n);

    const result = await alice.client.payDirect(channel.id, { amount: 250n });
    expect(result.channelId).toBe(channel.id);
    expect(result.version).toBe(2n);

    const after = await alice.storage.loadLatestState(channel.id);
    expect(after?.state.version).toBe(2n);
    expect(after?.state.balanceA).toBe(1_000_000n - 250n);
    expect(after?.state.balanceB).toBe(250n);
    expect(after?.state.htlcs).toEqual([]);
  });

  it('payDirect: rejects when amount exceeds my balance', async () => {
    const channel = await openAliceBobChannel();
    await expect(alice.client.payDirect(channel.id, { amount: 2_000_000n })).rejects.toThrow(
      /insufficient balance/i,
    );
  });

  it('payDirect: rejects when in-flight HTLCs are present', async () => {
    const channel = await openAliceBobChannel();
    const signed = await alice.storage.loadLatestState(channel.id);
    if (!signed) throw new Error('no state');
    await alice.storage.saveState(channel.id, {
      ...signed,
      state: {
        ...signed.state,
        htlcs: [
          {
            id: 'fake-htlc',
            direction: 'AtoB',
            amount: 1n,
            paymentHash: `0x${'aa'.repeat(32)}`,
            expiryMs: BigInt(Date.now() + 60_000),
          },
        ],
      },
    });
    await expect(alice.client.payDirect(channel.id, { amount: 100n })).rejects.toThrow(
      /in-flight HTLCs/i,
    );
  });

  it('cooperative close goes through hub and chain', async () => {
    const channel = await openAliceBobChannel();
    const closedEvents: string[] = [];
    alice.client.on('channel:closed', (e) => closedEvents.push(e.channelId));
    await alice.client.close(channel.id);
    expect(closedEvents).toEqual([channel.id]);
    const reloaded = await alice.storage.loadChannel(channel.id);
    expect(reloaded?.status).toBe('closed');
  });

  it('persist-before-send: state is on disk before transport.send is called', async () => {
    const channel = await openAliceBobChannel();
    const { invoice } = await bob.client.createInvoice({ amount: 75n });

    // Patch alice's transport.send to capture storage state at the moment send fires.
    const sendSpy: { stateAtSend: bigint | undefined } = { stateAtSend: undefined };
    const realSend = alice.transport.send.bind(alice.transport);
    alice.transport.send = async (msg) => {
      if (msg.kind === 'pay') {
        const stored = await alice.storage.loadLatestState(channel.id);
        sendSpy.stateAtSend = stored?.state.version;
      }
      return realSend(msg);
    };
    await alice.client.pay({ invoice });
    expect(sendSpy.stateAtSend).toBe(2n); // initial v1 + locked v2 BEFORE send
  });
});
