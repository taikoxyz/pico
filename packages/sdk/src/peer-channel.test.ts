import {
  type Address,
  CONTRACT_ADDRESSES,
  type Channel,
  type ChannelId,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@inferenceroom/pico-protocol';
import {
  InMemorySigner,
  MockChainAdapter,
  type MockHubHandle,
  startMockHub,
} from '@inferenceroom/pico-test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelClient } from './client.js';
import { MemoryStorage } from './storage.js';
import { RelayTransport, WebSocketTransport } from './transport.js';

// Direct (hub-less) peer channels: two users open a channel between themselves
// on-chain and exchange signed states through the hub acting only as a relay.
const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const VERIFYING_CONTRACT = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const TOKEN: Address = USDC_TOKENS[CHAIN_ID].address;

interface Peer {
  readonly client: ChannelClient;
  readonly chain: MockChainAdapter;
  readonly storage: MemoryStorage;
  readonly transport: RelayTransport;
  readonly address: Address;
}

async function makePeer(privateKey: `0x${string}`, hubUrl: string): Promise<Peer> {
  const signer = new InMemorySigner(privateKey);
  const address = await signer.address();
  const storage = new MemoryStorage();
  const chain = new MockChainAdapter({
    chainId: CHAIN_ID,
    contract: VERIFYING_CONTRACT,
    userA: address,
  });
  const base = new WebSocketTransport({ url: hubUrl, autoReconnect: false });
  const selfLower = address.toLowerCase();
  const transport = new RelayTransport({
    base,
    resolveCounterparty: async (channelId: ChannelId): Promise<Address | undefined> => {
      const ch = await storage.loadChannel(channelId);
      if (!ch) return undefined;
      return ch.userA.toLowerCase() === selfLower ? ch.userB : ch.userA;
    },
  });
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
    closeRequestTimeoutMs: 3_000,
    safetyMarginMs: 1_000n,
    peerMode: true,
  });
  return { client, chain, storage, transport, address };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('direct peer channel (hub as relay)', () => {
  let hub: MockHubHandle;
  let alice: Peer;
  let bob: Peer;

  beforeEach(async () => {
    hub = await startMockHub({
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      enableRelay: true,
    });
    alice = await makePeer(ALICE_KEY, hub.url);
    bob = await makePeer(BOB_KEY, hub.url);
    // Bob plays the responder: subscribe to the relay so the announce reaches him.
    await bob.transport.connect();
    await bob.client.ensureSubscribed([]);
  });

  afterEach(async () => {
    await alice.transport.close();
    await bob.transport.close();
    await hub.stop();
  });

  async function openChannel(amount = 1_000_000n): Promise<Channel> {
    const { channel } = await alice.client.open({
      counterparty: bob.address,
      amount,
      token: TOKEN,
    });
    return channel;
  }

  it('open handshake co-signs the v1 state on both sides', async () => {
    const channel = await openChannel();
    const a = await alice.storage.loadLatestState(channel.id);
    const b = await bob.storage.loadLatestState(channel.id);
    expect(a?.state.version).toBe(1n);
    expect(a?.state.balanceA).toBe(1_000_000n);
    expect(a?.state.balanceB).toBe(0n);
    // Both peers converge on the identical dual-signed initial state.
    expect(b?.state).toEqual(a?.state);
    expect(b?.sigA).toEqual(a?.sigA);
    expect(b?.sigB).toEqual(a?.sigB);
  });

  it('HTLC invoice payment settles directly between peers', async () => {
    const channel = await openChannel();
    const { invoice, preimage } = await bob.client.createInvoice({ amount: 100n, memo: 'thanks' });

    const settled: string[] = [];
    bob.client.on('htlc:settled', (e) => settled.push(e.direction));

    const result = await alice.client.pay({ invoice });
    expect(result.preimage).toBe(preimage);
    expect(settled).toContain('incoming');

    const a = await alice.storage.loadLatestState(channel.id);
    expect(a?.state.balanceA).toBe(1_000_000n - 100n);
    expect(a?.state.balanceB).toBe(100n);
    expect(a?.state.htlcs).toEqual([]);

    const b = await bob.storage.loadLatestState(channel.id);
    expect(b?.state.balanceA).toBe(1_000_000n - 100n);
    expect(b?.state.balanceB).toBe(100n);
  });

  it('payee converges on a fully dual-signed settled state', async () => {
    const channel = await openChannel();
    const { invoice } = await bob.client.createInvoice({ amount: 100n });
    await alice.client.pay({ invoice });

    // The payer returns the dual-signed settled state via htlcSettleAck
    // (fire-and-forget over the relay), so wait for Bob to apply it.
    await waitFor(async () => {
      const a = await alice.storage.loadLatestState(channel.id);
      const b = await bob.storage.loadLatestState(channel.id);
      return !!a && !!b && b.sigA.r === a.sigA.r && b.sigA.s === a.sigA.s;
    });

    const a = await alice.storage.loadLatestState(channel.id);
    const b = await bob.storage.loadLatestState(channel.id);
    // Both peers hold the identical, fully counter-signed settled state.
    expect(b?.state).toEqual(a?.state);
    expect(b?.sigA).toEqual(a?.sigA);
    expect(b?.sigB).toEqual(a?.sigB);
    expect(b?.state.htlcs).toEqual([]);
  });

  it('payDirect transfers balance with the peer co-signing', async () => {
    const channel = await openChannel();
    await alice.client.payDirect(channel.id, { amount: 250n });

    const a = await alice.storage.loadLatestState(channel.id);
    expect(a?.state.balanceA).toBe(1_000_000n - 250n);
    expect(a?.state.balanceB).toBe(250n);
    // payDirect is fully dual-signed on both sides.
    const b = await bob.storage.loadLatestState(channel.id);
    expect(b?.state).toEqual(a?.state);
    expect(b?.sigA).toEqual(a?.sigA);
    expect(b?.sigB).toEqual(a?.sigB);
  });

  it('cooperative close negotiated over the relay', async () => {
    const channel = await openChannel();
    await alice.client.payDirect(channel.id, { amount: 250n });
    const res = await alice.client.close(channel.id, { cooperative: true });
    expect(res.kind).toBe('cooperative');
  });
});
