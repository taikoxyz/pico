import {
  type Address,
  CONTRACT_ADDRESSES,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@inferenceroom/pico-protocol';
import { InMemorySigner, MockChainAdapter } from '@inferenceroom/pico-test-utils';
import { describe, expect, it } from 'vitest';
import { ChannelClient } from './client.js';
import { PostOpenSubscribeError } from './errors.js';
import type { ClientToHubMessage, HubToClientMessage } from './hub-protocol.js';
import { MemoryStorage } from './storage.js';
import type { Transport } from './transport.js';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const VERIFYING_CONTRACT = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const TOKEN: Address = USDC_TOKENS[CHAIN_ID].address;

class RejectingSubscribeTransport implements Transport {
  private connected = false;
  async connect(): Promise<void> {
    this.connected = true;
  }
  async close(): Promise<void> {
    this.connected = false;
  }
  async send(_msg: ClientToHubMessage): Promise<void> {}
  async request(msg: ClientToHubMessage): Promise<HubToClientMessage> {
    if (msg.kind === 'subscribe') {
      throw new Error("transport request 'subscribe' timed out after 10000ms");
    }
    throw new Error(`unexpected request kind: ${msg.kind}`);
  }
  onMessage(): () => void {
    return () => {};
  }
  onReconnect(): () => void {
    return () => {};
  }
  isConnected(): boolean {
    return this.connected;
  }
}

describe('ChannelClient.open() post-open subscribe failure', () => {
  it('throws PostOpenSubscribeError carrying the persisted channel info', async () => {
    const signer = new InMemorySigner(ALICE_KEY);
    const aliceAddr = await signer.address();
    const bobAddr = await new InMemorySigner(BOB_KEY).address();
    const storage = new MemoryStorage();
    const chain = new MockChainAdapter({
      chainId: CHAIN_ID,
      contract: VERIFYING_CONTRACT,
      userA: aliceAddr,
    });
    const transport = new RejectingSubscribeTransport();
    const client = new ChannelClient({
      signer,
      transport,
      storage,
      chain,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      defaultToken: TOKEN,
    });

    await transport.connect();
    let caught: unknown;
    try {
      await client.open({ counterparty: bobAddr, amount: 1_000_000n, token: TOKEN });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PostOpenSubscribeError);
    const err = caught as PostOpenSubscribeError;
    expect(err.code).toBe('POST_OPEN_SUBSCRIBE');
    expect(err.opened.channel.userA).toBe(aliceAddr);
    expect(err.opened.channel.userB).toBe(bobAddr);
    expect(err.opened.txHash).toMatch(/^0x[0-9a-f]+$/);
    expect(err.opened.blockNumber).toBeTypeOf('bigint');
    expect(err.cause.message).toContain('timed out');

    const persisted = await storage.loadChannel(err.opened.channel.id);
    expect(persisted?.id).toBe(err.opened.channel.id);
    const persistedState = await storage.loadLatestState(err.opened.channel.id);
    expect(persistedState?.state.version).toBe(1n);
  });
});
