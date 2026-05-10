import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type Channel,
  type ChannelId,
  type ChannelState,
  EMPTY_SIG_BYTES,
  type Hex,
  type SignedState,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@inferenceroom/pico-protocol';
import { buildChannelStateTypedData } from '@inferenceroom/pico-state-machine';
import type { Hash } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import type {
  ChainAdapter,
  CloseCooperativeOnChainArgs,
  CloseOnChainResult,
  CloseUnilateralFromOpenOnChainArgs,
  CloseUnilateralOnChainArgs,
  CloseUnilateralOnChainResult,
  FinalizedResult,
  OpenChannelOnChainArgs,
  OpenChannelOnChainResult,
  TopUpOnChainArgs,
  TopUpOnChainResult,
} from './chain-adapter.js';
import { ChannelClient } from './client.js';
import type {
  ClientToHubMessage,
  HubToClientMessage,
  ProposeTopUpMessage,
} from './hub-protocol.js';
import type { Signer } from './signer.js';
import { MemoryStorage } from './storage.js';
import type { Transport } from './transport.js';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID: ChainId = TAIKO_MAINNET_CHAIN_ID;
const VC = CONTRACT_ADDRESSES[CHAIN_ID].PaymentChannel;
const TOKEN: Address = USDC_TOKENS[CHAIN_ID].address;

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
    throw new Error('not implemented in tests');
  }
  signCooperativeClose(): Promise<Hex> {
    throw new Error('not implemented in tests');
  }
  signHtlc(): Promise<Hex> {
    throw new Error('not implemented in tests');
  }
  signInvoice(): Promise<Hex> {
    throw new Error('not implemented in tests');
  }
}

class StubChainAdapter implements ChainAdapter {
  closeUnilateralFromOpenCalls: ChannelId[] = [];
  topUpCalls: TopUpOnChainArgs[] = [];

  async openChannel(_args: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    throw new Error('not used');
  }
  async closeCooperative(_args: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateral(_args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateralFromOpen(
    args: CloseUnilateralFromOpenOnChainArgs,
  ): Promise<CloseUnilateralOnChainResult> {
    this.closeUnilateralFromOpenCalls.push(args.channelId);
    return {
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hash,
      disputeDeadlineMs: BigInt(Date.now() + 24 * 60 * 60 * 1000),
      postedVersion: 0n,
    };
  }
  async topUp(args: TopUpOnChainArgs): Promise<TopUpOnChainResult> {
    this.topUpCalls.push(args);
    return {
      txHash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Hash,
      newVersion: args.next.state.version,
      amount: args.amount,
    };
  }
  async finalize(_channelId: ChannelId): Promise<FinalizedResult> {
    throw new Error('not used');
  }
  async waitForFinalized(
    _channelId: ChannelId,
    _opts?: { timeoutMs?: number },
  ): Promise<FinalizedResult> {
    return new Promise<FinalizedResult>(() => {
      // Never resolve so the background watch in closeUnilateralFromOpen does
      // not interfere with test teardown.
    });
  }
}

class StubTransport implements Transport {
  sent: ClientToHubMessage[] = [];
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
  async request(_msg: ClientToHubMessage): Promise<HubToClientMessage> {
    throw new Error('not used');
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
  /** Test helper: deliver a hub→client message to the registered handler(s). */
  async deliver(msg: HubToClientMessage): Promise<void> {
    for (const h of this.handlers) h(msg);
    // Allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 0));
  }
}

interface Fixture {
  readonly client: ChannelClient;
  readonly storage: MemoryStorage;
  readonly transport: StubTransport;
  readonly chain: StubChainAdapter;
  readonly aliceAddr: Address;
  readonly bobAddr: Address;
  readonly channel: Channel;
  readonly channelId: ChannelId;
  readonly bobAccount: PrivateKeyAccount;
}

const CHANNEL_ID =
  '0x000000000000000000000000000000000000000000000000000000000000abcd' as ChannelId;

async function makeFixture(): Promise<Fixture> {
  const aliceSigner = new TestSigner(ALICE_KEY);
  const aliceAddr = await aliceSigner.address();
  const bobAccount = privateKeyToAccount(BOB_KEY);
  const bobAddr = bobAccount.address;
  const storage = new MemoryStorage();
  const transport = new StubTransport();
  const chain = new StubChainAdapter();
  const client = new ChannelClient({
    signer: aliceSigner,
    transport,
    storage,
    chain,
    chainId: CHAIN_ID,
    verifyingContract: VC,
    defaultToken: TOKEN,
  });
  const channel: Channel = {
    id: CHANNEL_ID,
    chainId: CHAIN_ID,
    contract: VC,
    userA: aliceAddr,
    userB: bobAddr,
    token: TOKEN,
    status: 'open',
    openedAt: BigInt(Date.now()),
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
  await storage.saveChannel(channel);
  return {
    client,
    storage,
    transport,
    chain,
    aliceAddr,
    bobAddr,
    channel,
    channelId: CHANNEL_ID,
    bobAccount,
  };
}

async function activateClientHandler(fixture: Fixture): Promise<void> {
  // The client's inbound handler is installed lazily by `ensureSubscribed`,
  // which sends a `subscribe` request and awaits a `subscribeAck`. Patch
  // `request` to immediately return that ack and call `recover()` once to
  // trigger the install path.
  const { transport } = fixture;
  (transport as { request: Transport['request'] }).request = async (
    msg: ClientToHubMessage,
  ): Promise<HubToClientMessage> => {
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
  };
  await fixture.client.recover();
}

function buildOfferEnvelope(args: {
  fixture: Fixture;
  amount: bigint;
  prevStateVersion: bigint;
  newState: ChannelState;
  validUntil?: bigint;
  newSig?: Hex;
  prevSig?: Hex;
  offerId?: Hex;
}): ProposeTopUpMessage {
  return {
    id: 'offer-1',
    kind: 'proposeTopUp',
    channelId: args.fixture.channelId,
    offerId:
      args.offerId ?? ('0xfeedbeefcafebabe000000000000000000000000000000000000000000000001' as Hex),
    amount: args.amount,
    prevStateVersion: args.prevStateVersion,
    newState: args.newState,
    validUntil: args.validUntil ?? BigInt(Math.floor(Date.now() / 1000) + 600),
    feePolicy: null,
    minLifetime: null,
    maxInFlightHtlcs: 5,
    partialAccepted: false,
    prevSig: args.prevSig ?? EMPTY_SIG_BYTES,
    newSig: args.newSig ?? EMPTY_SIG_BYTES,
  };
}

describe('ChannelClient.closeUnilateralFromOpen', () => {
  it('calls chain.closeUnilateralFromOpen and updates storage to closing-unilateral', async () => {
    const fx = await makeFixture();
    let closedEmitted: ChannelId | undefined;
    fx.client.on('channel:closed', (e) => {
      closedEmitted = e.channelId;
    });
    const result = await fx.client.closeUnilateralFromOpen(fx.channelId);
    expect(fx.chain.closeUnilateralFromOpenCalls).toEqual([fx.channelId]);
    expect(typeof result.disputeDeadlineMs).toBe('bigint');
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await fx.storage.loadChannel(fx.channelId))?.status).toBe('closing-unilateral');
    expect(closedEmitted).toBe(fx.channelId);
  });

  it('throws when channel is unknown', async () => {
    const fx = await makeFixture();
    await expect(
      fx.client.closeUnilateralFromOpen(
        '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as ChannelId,
      ),
    ).rejects.toThrow(/unknown channel/);
  });
});

describe('ChannelClient handleProposeTopUp', () => {
  it('replies with acceptTopUp for a valid offer', async () => {
    const fx = await makeFixture();
    await activateClientHandler(fx);

    // Sentinel-prev path: no local state. New state credits Bob (hubSide='B').
    const newState: ChannelState = {
      channelId: fx.channelId,
      version: 1n,
      balanceA: 1_000_000n,
      balanceB: 5_000_000n,
      htlcs: [],
      finalized: false,
    };
    // Hub (Bob) signs newState so the client can include the hub's sig.
    const hubSigHex = (await fx.bobAccount.signTypedData(
      buildChannelStateTypedData(newState, CHAIN_ID, VC),
    )) as Hex;

    const offer = buildOfferEnvelope({
      fixture: fx,
      amount: 5_000_000n,
      prevStateVersion: 0n,
      newState,
      newSig: hubSigHex,
    });
    await fx.transport.deliver(offer);

    const acceptMsg = fx.transport.sent.find((m) => m.kind === 'acceptTopUp');
    expect(acceptMsg).toBeDefined();
    if (acceptMsg && acceptMsg.kind === 'acceptTopUp') {
      expect(acceptMsg.channelId).toBe(fx.channelId);
      expect(acceptMsg.offerId).toBe(offer.offerId);
      expect(acceptMsg.signedNewState.state.version).toBe(1n);
      expect(acceptMsg.signedNewState.state.balanceA).toBe(1_000_000n);
      expect(acceptMsg.signedNewState.state.balanceB).toBe(5_000_000n);
      // Both sigA (alice) and sigB (hub) populated.
      expect(acceptMsg.signedNewState.sigA.r).not.toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
      expect(acceptMsg.signedNewState.sigB.r).not.toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
    }
    expect(fx.transport.sent.find((m) => m.kind === 'rejectTopUp')).toBeUndefined();
  });

  it('replies with rejectTopUp when validUntil is past', async () => {
    const fx = await makeFixture();
    await activateClientHandler(fx);
    const newState: ChannelState = {
      channelId: fx.channelId,
      version: 1n,
      balanceA: 1_000_000n,
      balanceB: 5_000_000n,
      htlcs: [],
      finalized: false,
    };
    const offer = buildOfferEnvelope({
      fixture: fx,
      amount: 5_000_000n,
      prevStateVersion: 0n,
      newState,
      validUntil: BigInt(Math.floor(Date.now() / 1000) - 10),
    });
    await fx.transport.deliver(offer);
    const rej = fx.transport.sent.find((m) => m.kind === 'rejectTopUp');
    expect(rej).toBeDefined();
    if (rej && rej.kind === 'rejectTopUp') {
      expect(rej.reason).toMatch(/expired/);
      expect(rej.offerId).toBe(offer.offerId);
    }
    expect(fx.transport.sent.find((m) => m.kind === 'acceptTopUp')).toBeUndefined();
  });

  it('replies with rejectTopUp when prevStateVersion mismatches local latest', async () => {
    const fx = await makeFixture();
    // Save a local state at version 3 — offer claims version 0, mismatch.
    const localState: SignedState = {
      state: {
        channelId: fx.channelId,
        version: 3n,
        balanceA: 600_000n,
        balanceB: 400_000n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: '0x01', s: '0x02', v: 27 },
      sigB: { r: '0x03', s: '0x04', v: 27 },
    };
    await fx.storage.saveState(fx.channelId, localState);
    await activateClientHandler(fx);

    const newState: ChannelState = {
      channelId: fx.channelId,
      version: 1n,
      balanceA: 1_000_000n,
      balanceB: 5_000_000n,
      htlcs: [],
      finalized: false,
    };
    const offer = buildOfferEnvelope({
      fixture: fx,
      amount: 5_000_000n,
      prevStateVersion: 0n,
      newState,
    });
    await fx.transport.deliver(offer);

    const rej = fx.transport.sent.find((m) => m.kind === 'rejectTopUp');
    expect(rej).toBeDefined();
    if (rej && rej.kind === 'rejectTopUp') {
      expect(rej.reason).toMatch(/prev version mismatch/);
    }
  });

  it('replies with rejectTopUp when newState balances do not match prediction', async () => {
    const fx = await makeFixture();
    // Anchor a real prev state so the client uses it (instead of inferring
    // sentinel-prev from the offer, which would tautologically validate).
    const prev: SignedState = {
      state: {
        channelId: fx.channelId,
        version: 5n,
        balanceA: 800_000n,
        balanceB: 200_000n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: '0x01', s: '0x02', v: 27 },
      sigB: { r: '0x03', s: '0x04', v: 27 },
    };
    await fx.storage.saveState(fx.channelId, prev);
    await activateClientHandler(fx);

    // Correct prediction would set balanceB = 200_000 + 5_000_000 = 5_200_000;
    // we propose 9_999_999n which violates conservation against prev.
    const newState: ChannelState = {
      channelId: fx.channelId,
      version: 6n,
      balanceA: 800_000n,
      balanceB: 9_999_999n,
      htlcs: [],
      finalized: false,
    };
    const offer = buildOfferEnvelope({
      fixture: fx,
      amount: 5_000_000n,
      prevStateVersion: 5n,
      newState,
    });
    await fx.transport.deliver(offer);
    const rej = fx.transport.sent.find((m) => m.kind === 'rejectTopUp');
    expect(rej).toBeDefined();
    if (rej && rej.kind === 'rejectTopUp') {
      expect(rej.reason).toMatch(/does not match prediction/);
    }
  });
});
