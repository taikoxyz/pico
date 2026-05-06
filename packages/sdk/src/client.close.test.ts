import {
  type Address,
  CONTRACT_ADDRESSES,
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
import { WebSocketTransport } from './transport.js';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const VC = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const TOKEN: Address = USDC_TOKENS[CHAIN_ID].address;

describe('ChannelClient.close fallback paths', () => {
  let hub: MockHubHandle;

  beforeEach(async () => {
    hub = await startMockHub({ chainId: CHAIN_ID, verifyingContract: VC });
  });
  afterEach(async () => {
    await hub.stop();
  });

  it('falls back to unilateral close when cooperative=false', async () => {
    const signer = new InMemorySigner(ALICE_KEY);
    const me = await signer.address();
    const storage = new MemoryStorage();
    const chain = new MockChainAdapter({ chainId: CHAIN_ID, contract: VC, userA: me });
    const transport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const bobAddr = await new InMemorySigner(BOB_KEY).address();
    const client = new ChannelClient({
      signer,
      transport,
      storage,
      chain,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      defaultToken: TOKEN,
      closeRequestTimeoutMs: 100,
    });
    const channel = await client.open({ counterparty: bobAddr, amount: 1_000_000n });
    let closed = false;
    client.on('channel:closed', () => {
      closed = true;
    });
    await client.close(channel.id, { cooperative: false });
    expect(closed).toBe(true);
    expect((await storage.loadChannel(channel.id))?.status).toBe('closing-unilateral');
    await transport.close();
  });

  it('throws on close for unknown channel', async () => {
    const signer = new InMemorySigner(ALICE_KEY);
    const me = await signer.address();
    const storage = new MemoryStorage();
    const chain = new MockChainAdapter({ chainId: CHAIN_ID, contract: VC, userA: me });
    const transport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const client = new ChannelClient({
      signer,
      transport,
      storage,
      chain,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      defaultToken: TOKEN,
    });
    await expect(
      client.close(
        '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as `0x${string}`,
      ),
    ).rejects.toThrow(/unknown channel/);
    await transport.close();
  });

  it('getBalance returns zero for unknown channel state', async () => {
    const signer = new InMemorySigner(ALICE_KEY);
    const me = await signer.address();
    const storage = new MemoryStorage();
    const chain = new MockChainAdapter({ chainId: CHAIN_ID, contract: VC, userA: me });
    const transport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const bobAddr = await new InMemorySigner(BOB_KEY).address();
    const client = new ChannelClient({
      signer,
      transport,
      storage,
      chain,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      defaultToken: TOKEN,
    });
    const channel = await client.open({ counterparty: bobAddr, amount: 500n });
    await storage.delete(channel.id);
    await storage.saveChannel(channel);
    const bal = await client.getBalance(channel.id);
    expect(bal).toEqual({ balanceUs: 0n, balanceCounterparty: 0n, pendingHtlcsTotal: 0n });
    await transport.close();
  });

  it('throws when pay() has no invoice and no keysend', async () => {
    const signer = new InMemorySigner(ALICE_KEY);
    const me = await signer.address();
    const storage = new MemoryStorage();
    const chain = new MockChainAdapter({ chainId: CHAIN_ID, contract: VC, userA: me });
    const transport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const bobAddr = await new InMemorySigner(BOB_KEY).address();
    const client = new ChannelClient({
      signer,
      transport,
      storage,
      chain,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      defaultToken: TOKEN,
    });
    const channel = await client.open({ counterparty: bobAddr, amount: 500n });
    hub.registerChannel(channel);
    await expect(client.pay({ to: bobAddr, amount: 10n })).rejects.toThrow(/invoice.*keysend/i);
    await transport.close();
  });

  it('throws when pay({keysend}) has no recipient encryption pubkey', async () => {
    const signer = new InMemorySigner(ALICE_KEY);
    const me = await signer.address();
    const storage = new MemoryStorage();
    const chain = new MockChainAdapter({ chainId: CHAIN_ID, contract: VC, userA: me });
    const transport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
    const bobAddr = await new InMemorySigner(BOB_KEY).address();
    const client = new ChannelClient({
      signer,
      transport,
      storage,
      chain,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      defaultToken: TOKEN,
    });
    const channel = await client.open({ counterparty: bobAddr, amount: 500n });
    hub.registerChannel(channel);
    await expect(client.pay({ to: bobAddr, amount: 10n, keysend: true })).rejects.toThrow(
      /encryptionPubkey/i,
    );
    await transport.close();
  });
});
