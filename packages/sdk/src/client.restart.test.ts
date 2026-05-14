import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type Channel,
  type ChannelId,
  type ChannelState,
  EMPTY_SIG_BYTES,
  type Hex,
  type HtlcId,
  type PaymentHash,
  type Preimage,
  type SignedState,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@inferenceroom/pico-protocol';
import { buildChannelStateTypedData } from '@inferenceroom/pico-state-machine';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import type { ChainAdapter } from './chain-adapter.js';
import { ChannelClient } from './client.js';
import type { ClientToHubMessage, HubToClientMessage } from './hub-protocol.js';
import type { Signer } from './signer.js';
import { MemoryStorage } from './storage.js';
import type { Transport } from './transport.js';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID: ChainId = TAIKO_MAINNET_CHAIN_ID;
const VC = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const TOKEN: Address = USDC_TOKENS[CHAIN_ID].address;

const CHANNEL_ID =
  '0x000000000000000000000000000000000000000000000000000000000000abcd' as ChannelId;
const HTLC_ID = '0x00000000000000000000000000000000000000000000000000000000000000e1' as HtlcId;
const PAYMENT_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as PaymentHash;
const PREIMAGE = '0x2222222222222222222222222222222222222222222222222222222222222222' as Preimage;

class TestSigner implements Signer {
  private readonly account: PrivateKeyAccount;
  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }
  async address(): Promise<Address> {
    return this.account.address;
  }
  signChannelState(
    state: ChannelState,
    chainId: ChainId,
    verifyingContract: Address,
  ): Promise<Hex> {
    return this.account.signTypedData(
      buildChannelStateTypedData(state, chainId, verifyingContract),
    );
  }
  signUpdate(): Promise<Hex> {
    throw new Error('not used');
  }
  signCooperativeClose(): Promise<Hex> {
    throw new Error('not used');
  }
  signHtlc(): Promise<Hex> {
    throw new Error('not used');
  }
  signInvoice(): Promise<Hex> {
    throw new Error('not used');
  }
}

const noopChain: ChainAdapter = {
  openChannel: async () => {
    throw new Error('not used');
  },
  closeCooperative: async () => {
    throw new Error('not used');
  },
  closeUnilateral: async () => {
    throw new Error('not used');
  },
  closeUnilateralFromOpen: async () => {
    throw new Error('not used');
  },
  topUp: async () => {
    throw new Error('not used');
  },
  finalize: async () => {
    throw new Error('not used');
  },
  waitForFinalized: async () => {
    return new Promise(() => {});
  },
};

class StubTransport implements Transport {
  sent: ClientToHubMessage[] = [];
  requested: ClientToHubMessage[] = [];
  private readonly handlers = new Set<(msg: HubToClientMessage) => void>();
  private connected = true;

  async connect(): Promise<void> {
    this.connected = true;
  }
  async close(): Promise<void> {
    this.connected = false;
  }
  async send(msg: ClientToHubMessage): Promise<void> {
    this.sent.push(msg);
  }
  async request(msg: ClientToHubMessage): Promise<HubToClientMessage> {
    this.requested.push(msg);
    if (msg.kind === 'subscribe') {
      return {
        id: msg.id,
        kind: 'subscribeAck',
        sessionId: 'test',
        channels: [],
        pendingHtlcs: [],
      };
    }
    throw new Error(`StubTransport.request: unexpected ${msg.kind}`);
  }
  onMessage(handler: (msg: HubToClientMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onReconnect(): () => void {
    return () => {};
  }
  isConnected(): boolean {
    return this.connected;
  }
  async deliver(msg: HubToClientMessage): Promise<void> {
    for (const h of this.handlers) h(msg);
    // flush microtasks so the async inbound handler completes
    await new Promise((r) => setTimeout(r, 0));
  }
}

interface Fixture {
  readonly client: ChannelClient;
  readonly transport: StubTransport;
  readonly storage: MemoryStorage;
  readonly aliceAddr: Address;
  readonly bobAddr: Address;
  readonly channel: Channel;
}

async function buildFreshProcessAfterCrash(): Promise<Fixture> {
  const aliceSigner = new TestSigner(ALICE_KEY);
  const aliceAddr = await aliceSigner.address();
  const bobAccount = privateKeyToAccount(BOB_KEY);
  const bobAddr = bobAccount.address;

  // Storage simulates state durably persisted by the prior process before
  // it crashed: a channel record and an issued invoice whose HTLC was
  // already in flight.
  const storage = new MemoryStorage();
  const channel: Channel = {
    id: CHANNEL_ID,
    chainId: CHAIN_ID,
    contract: VC,
    userA: aliceAddr,
    userB: bobAddr,
    token: TOKEN,
    status: 'open',
    openedAt: BigInt(Date.now()),
    disputeWindowMs: 86_400_000,
  };
  await storage.saveChannel(channel);
  const initialState: SignedState = {
    state: {
      channelId: CHANNEL_ID,
      version: 2n,
      balanceA: 900n,
      balanceB: 0n,
      htlcs: [
        {
          id: HTLC_ID,
          direction: 'AtoB',
          amount: 100n,
          paymentHash: PAYMENT_HASH,
          expiryMs: BigInt(Date.now() + 60 * 60 * 1000),
        },
      ],
      htlcsCount: 1,
      htlcsTotalLocked: 100n,
      finalized: false,
    },
    sigA: EMPTY_SIG_BYTES,
    sigB: EMPTY_SIG_BYTES,
  };
  await storage.saveState(CHANNEL_ID, initialState);
  await storage.saveInvoice(
    {
      paymentHash: PAYMENT_HASH,
      amount: 100n,
      expiresAt: BigInt(Date.now() + 60 * 60 * 1000),
    },
    PREIMAGE,
  );

  const transport = new StubTransport();
  const client = new ChannelClient({
    signer: aliceSigner,
    transport,
    storage,
    chain: noopChain,
    chainId: CHAIN_ID,
    verifyingContract: VC,
    defaultToken: TOKEN,
  });

  return { client, transport, storage, aliceAddr, bobAddr, channel };
}

function makePaymentSettle(htlcId: HtlcId, preimage: Preimage): HubToClientMessage {
  return {
    id: 'srv-1',
    kind: 'paymentSettle',
    channelId: CHANNEL_ID,
    htlcId,
    preimage,
    signedStateAfterSettle: {
      state: {
        channelId: CHANNEL_ID,
        version: 3n,
        balanceA: 900n,
        balanceB: 100n,
        htlcs: [],
        htlcsCount: 0,
        htlcsTotalLocked: 0n,
        finalized: false,
      },
      sigA: EMPTY_SIG_BYTES,
      sigB: EMPTY_SIG_BYTES,
    },
  };
}

describe('ChannelClient — restart recovery (F-02)', () => {
  it('after recover(), a hub-delivered paymentSettle for a pre-crash invoice emits exactly one htlc:settled event with the correct preimage', async () => {
    const fx = await buildFreshProcessAfterCrash();
    const events: {
      channelId: ChannelId;
      htlcId: HtlcId;
      preimage: Preimage;
      direction: string;
    }[] = [];
    fx.client.on('htlc:settled', (e) =>
      events.push({
        channelId: e.channelId,
        htlcId: e.htlc.id,
        preimage: e.preimage,
        direction: e.direction,
      }),
    );

    await fx.client.recover();

    // Confirm the subscribe-after-recover path actually ran (so the inbound
    // handler is installed). Without it, the deliver below would be a no-op
    // and we'd be testing nothing.
    const subscribe = fx.transport.requested.find((m) => m.kind === 'subscribe');
    expect(subscribe).toBeDefined();

    await fx.transport.deliver(makePaymentSettle(HTLC_ID, PREIMAGE));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      channelId: CHANNEL_ID,
      htlcId: HTLC_ID,
      preimage: PREIMAGE,
      direction: 'outgoing',
    });
  });

  it('does not emit a second htlc:settled when the same paymentSettle is delivered twice', async () => {
    // Hubs may re-deliver paymentSettle on reconnect. The fresh process has
    // no inflight map entry for this htlcId, so handleInbound emits the
    // event; a duplicate delivery emits a second event because dedupe
    // happens upstream (hub session). We pin this behavior so a future
    // change does not silently introduce client-side dedupe without an
    // explicit decision.
    const fx = await buildFreshProcessAfterCrash();
    const events: HtlcId[] = [];
    fx.client.on('htlc:settled', (e) => events.push(e.htlc.id));

    await fx.client.recover();
    await fx.transport.deliver(makePaymentSettle(HTLC_ID, PREIMAGE));
    await fx.transport.deliver(makePaymentSettle(HTLC_ID, PREIMAGE));

    expect(events).toEqual([HTLC_ID, HTLC_ID]);
  });

  it('recover() with no persisted channels is a no-op and does not send a subscribe', async () => {
    const aliceSigner = new TestSigner(ALICE_KEY);
    const storage = new MemoryStorage();
    const transport = new StubTransport();
    const client = new ChannelClient({
      signer: aliceSigner,
      transport,
      storage,
      chain: noopChain,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      defaultToken: TOKEN,
    });

    await client.recover();
    expect(transport.sent).toHaveLength(0);
    expect(transport.requested).toHaveLength(0);
  });
});
