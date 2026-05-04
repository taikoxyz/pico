import { type Address, TAIKO_MAINNET_CHAIN_ID } from '@pico/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySigner,
  MockChainAdapter,
  type MockHubHandle,
  startMockHub,
} from './_test/index.js';
import { ChannelClient } from './client.js';
import { TransportClosedError } from './errors.js';
import { MemoryStorage } from './storage.js';
import { WebSocketTransport } from './transport.js';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const VERIFYING_CONTRACT = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as Address;
const TOKEN = '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b' as Address;

describe('persist-before-send', () => {
  let hub: MockHubHandle;

  beforeEach(async () => {
    hub = await startMockHub({ chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT });
  });

  afterEach(async () => {
    await hub.stop();
  });

  it('survives a crash between sign-and-send: state is persisted before transport.send fires', async () => {
    const aliceSigner = new InMemorySigner(ALICE_KEY);
    const aliceAddr = await aliceSigner.address();
    const bobSigner = new InMemorySigner(BOB_KEY);
    const bobAddr = await bobSigner.address();

    const aliceStorage = new MemoryStorage();
    const aliceChain = new MockChainAdapter({
      chainId: CHAIN_ID,
      contract: VERIFYING_CONTRACT,
      userA: aliceAddr,
    });
    const aliceTransport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const alice = new ChannelClient({
      signer: aliceSigner,
      transport: aliceTransport,
      storage: aliceStorage,
      chain: aliceChain,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      defaultToken: TOKEN,
    });

    const bobStorage = new MemoryStorage();
    const bobChain = new MockChainAdapter({
      chainId: CHAIN_ID,
      contract: VERIFYING_CONTRACT,
      userA: bobAddr,
    });
    const bobTransport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const bob = new ChannelClient({
      signer: bobSigner,
      transport: bobTransport,
      storage: bobStorage,
      chain: bobChain,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      defaultToken: TOKEN,
    });

    const channel = await alice.open({ counterparty: bobAddr, amount: 1_000_000n, token: TOKEN });
    await bobStorage.saveChannel(channel);
    const initial = await aliceStorage.loadLatestState(channel.id);
    if (!initial) throw new Error('no initial state');
    await bobStorage.saveState(channel.id, initial);
    hub.registerChannel(channel);
    await bob.ensureSubscribed([channel.id]);

    const { invoice } = await bob.createInvoice({ amount: 100n });

    // Patch alice.transport.send to throw simulating a crash AFTER persistence has happened.
    aliceTransport.send = async () => {
      throw new TransportClosedError();
    };

    await expect(alice.pay({ invoice })).rejects.toThrow();

    // Despite the send failing, the locked state must already be on disk.
    const storedAfterCrash = await aliceStorage.loadLatestState(channel.id);
    expect(storedAfterCrash?.state.version).toBeGreaterThanOrEqual(2n);
    expect(storedAfterCrash?.state.htlcs.length).toBe(1);
    expect(storedAfterCrash?.state.htlcs[0]?.paymentHash).toBe(invoice.paymentHash);

    await aliceTransport.close();
    await bobTransport.close();
  });
});
