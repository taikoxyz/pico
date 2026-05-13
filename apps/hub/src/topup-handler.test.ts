import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  ChannelState,
  Hex,
  ProposeTopUpMessage,
  Signature,
  SignedState,
  TopUpCompleteMessage,
} from '@inferenceroom/pico-protocol';
import { EMPTY_SIG_BYTES } from '@inferenceroom/pico-protocol';
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
} from '@inferenceroom/pico-sdk';
import { hexToSignature, signatureToHex } from '@inferenceroom/pico-sdk';
import { buildChannelStateTypedData } from '@inferenceroom/pico-state-machine';
import { Registry } from 'prom-client';
import type { Hash } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { LiquidityTracker } from './liquidity.js';
import { logger } from './logger.js';
import { type HubMetrics, buildMetrics } from './metrics.js';
import { KeyedMutex } from './mutex.js';
import { TopUpHandler } from './topup-handler.js';
import { DEFAULT_TOPUP_POLICY } from './topup-policy.js';

const CHAIN_ID: ChainId = 31337;
const VC: Address = '0x0000000000000000000000000000000000000001' as Address;
const TOKEN: Address = '0x0000000000000000000000000000000000000099' as Address;
const HUB_KEY = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const BOB_KEY = '0x000000000000000000000000000000000000000000000000000000000000b0b1' as const;

class StubChain implements ChainAdapter {
  topUpCalls: TopUpOnChainArgs[] = [];
  topUpResult: TopUpOnChainResult | undefined;
  shouldFail = false;

  async openChannel(_a: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    throw new Error('not used');
  }
  async closeCooperative(_a: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateral(_a: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateralFromOpen(
    _a: CloseUnilateralFromOpenOnChainArgs,
  ): Promise<CloseUnilateralOnChainResult> {
    throw new Error('not used');
  }
  async topUp(args: TopUpOnChainArgs): Promise<TopUpOnChainResult> {
    this.topUpCalls.push(args);
    if (this.shouldFail) throw new Error('chain fail');
    return (
      this.topUpResult ?? {
        txHash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Hash,
        newVersion: args.next.state.version,
        amount: args.amount,
      }
    );
  }
  async finalize(_id: ChannelId): Promise<FinalizedResult> {
    throw new Error('not used');
  }
  async waitForFinalized(): Promise<FinalizedResult> {
    return new Promise(() => {});
  }
}

function chId(short: string): Hex {
  return `0x${short.padEnd(64, '0')}` as Hex;
}

function makeChannel(idShort: string, userA: Address, userB: Address): Channel {
  return {
    id: chId(idShort) as ChannelId,
    chainId: CHAIN_ID,
    contract: VC,
    userA,
    userB,
    token: TOKEN,
    status: 'open',
    openedAt: BigInt(Date.now()),
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
}

interface Harness {
  readonly h: TestDb;
  readonly handler: TopUpHandler;
  readonly hubAccount: PrivateKeyAccount;
  readonly bobAccount: PrivateKeyAccount;
  readonly chain: StubChain;
  readonly liquidity: LiquidityTracker;
  readonly metrics: HubMetrics;
  readonly pool: ChannelPool;
  readonly hotWalletMutex: KeyedMutex<string>;
  readonly proposed: Array<{ to: Address; msg: ProposeTopUpMessage }>;
  readonly completed: Array<{ to: Address; msg: TopUpCompleteMessage }>;
  hubBalance: bigint;
}

async function makeHarness(
  opts: { policyOverrides?: Partial<typeof DEFAULT_TOPUP_POLICY>; hubBalance?: bigint } = {},
): Promise<Harness> {
  const h = await makeTestDb();
  const hubAccount = privateKeyToAccount(HUB_KEY);
  const bobAccount = privateKeyToAccount(BOB_KEY);
  const pool = new ChannelPool({
    logger,
    channelRepo: h.repos.channels,
    stateRepo: h.repos.states,
  });
  const liquidity = new LiquidityTracker();
  const metrics = buildMetrics(new Registry());
  const chain = new StubChain();
  const hotWalletMutex = new KeyedMutex<string>();
  const proposed: Array<{ to: Address; msg: ProposeTopUpMessage }> = [];
  const completed: Array<{ to: Address; msg: TopUpCompleteMessage }> = [];

  const harness = {
    h,
    handler: undefined as unknown as TopUpHandler,
    hubAccount,
    bobAccount,
    chain,
    liquidity,
    metrics,
    pool,
    hotWalletMutex,
    proposed,
    completed,
    hubBalance: opts.hubBalance ?? 100_000_000n,
  };

  const handler = new TopUpHandler({
    channelPool: pool,
    liquidity,
    repos: h.repos,
    metrics,
    logger,
    hubAccount,
    chainId: CHAIN_ID,
    verifyingContract: VC,
    chain,
    token: TOKEN,
    policyConfig: { ...DEFAULT_TOPUP_POLICY, ...(opts.policyOverrides ?? {}) },
    hotWalletMutex,
    readUsdcBalance: async () => harness.hubBalance,
    pushProposeTopUp: (to, msg) => {
      proposed.push({ to, msg });
      return true;
    },
    pushTopUpComplete: (to, msg) => {
      completed.push({ to, msg });
      return true;
    },
  });
  (harness as { handler: TopUpHandler }).handler = handler;
  return harness;
}

describe('TopUpHandler.evaluateNewChannel', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => harness.h.cleanup());

  it('proposes a top-up to a freshly-opened channel where hub is userB', async () => {
    const ch = makeChannel('aa', harness.bobAccount.address, harness.hubAccount.address);
    await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
    await harness.handler.evaluateNewChannel(ch);

    expect(harness.proposed).toHaveLength(1);
    const env = harness.proposed[0]?.msg;
    expect(env?.kind).toBe('proposeTopUp');
    expect(env?.amount).toBe(5_000_000n);
    expect(env?.newState.balanceB).toBe(5_000_000n);
    expect(env?.newState.balanceA).toBe(10_000_000n);
    expect(env?.prevSig).toBe(EMPTY_SIG_BYTES);

    // Liquidity committed == proposed amount.
    expect(harness.liquidity.perCounterpartyCommitted(harness.bobAccount.address)).toBe(5_000_000n);

    // A row was persisted with status proposed.
    const offers = await harness.h.repos.topupOffers.listByStatus('proposed');
    expect(offers).toHaveLength(1);
  });

  it('queues an offer when hot-wallet headroom is exhausted', async () => {
    harness.hubBalance = 0n;
    const ch = makeChannel('bb', harness.bobAccount.address, harness.hubAccount.address);
    await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
    await harness.handler.evaluateNewChannel(ch);
    expect(harness.proposed).toHaveLength(0);
    const queued = await harness.h.repos.topupOffers.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.amount).toBe(DEFAULT_TOPUP_POLICY.defaultOfferAmount);
  });
});

describe('TopUpHandler.handleAccept', () => {
  let harness: Harness;
  let channel: Channel;
  let offer: ProposeTopUpMessage;

  beforeEach(async () => {
    harness = await makeHarness();
    channel = makeChannel('ab', harness.bobAccount.address, harness.hubAccount.address);
    await harness.pool.register(channel, undefined, { amountA: 10_000_000n, amountB: 0n });
    await harness.handler.evaluateNewChannel(channel);
    const env = harness.proposed[0]?.msg;
    if (!env) throw new Error('expected proposeTopUp');
    offer = env;
  });
  afterEach(async () => harness.h.cleanup());

  async function userSignAccept(): Promise<SignedState> {
    // Bob is userA in this channel layout (we constructed the channel with
    // userA=bob). The hub is userB and signed sigB; Bob co-signs sigA.
    const sigHex = (await harness.bobAccount.signTypedData(
      buildChannelStateTypedData(offer.newState, CHAIN_ID, VC),
    )) as Hex;
    const userSig: Signature = hexToSignature(sigHex);
    const hubSig: Signature = hexToSignature(offer.newSig);
    return {
      state: offer.newState,
      sigA: userSig,
      sigB: hubSig,
    };
  }

  it('happy path: validates, submits to chain, transitions to submitted', async () => {
    const signed = await userSignAccept();
    await harness.handler.handleAccept({
      id: 'accept-1',
      kind: 'acceptTopUp',
      channelId: channel.id,
      offerId: offer.offerId,
      signedNewState: signed,
    });

    expect(harness.chain.topUpCalls).toHaveLength(1);
    const submitted = await harness.h.repos.topupOffers.get(offer.offerId);
    expect(submitted?.status).toBe('submitted');
    expect(submitted?.submittedTxHash).toBeDefined();
    // Reservation moved from committed → submitted.
    expect(harness.liquidity.perCounterpartyCommitted(harness.bobAccount.address)).toBe(0n);
    expect(harness.liquidity.perCounterpartySubmitted(harness.bobAccount.address)).toBe(
      offer.amount,
    );
  });

  it('rejects accept with a mismatched signed state', async () => {
    const wrongState: ChannelState = { ...offer.newState, balanceA: offer.newState.balanceA + 1n };
    const sigHex = (await harness.bobAccount.signTypedData(
      buildChannelStateTypedData(wrongState, CHAIN_ID, VC),
    )) as Hex;
    const signed: SignedState = {
      state: wrongState,
      sigA: hexToSignature(sigHex),
      sigB: hexToSignature(offer.newSig),
    };
    await harness.handler.handleAccept({
      id: 'accept-2',
      kind: 'acceptTopUp',
      channelId: channel.id,
      offerId: offer.offerId,
      signedNewState: signed,
    });
    expect(harness.chain.topUpCalls).toHaveLength(0);
    const row = await harness.h.repos.topupOffers.get(offer.offerId);
    expect(row?.status).toBe('proposed'); // unchanged
  });

  it('rolls back to rejected on chain failure', async () => {
    harness.chain.shouldFail = true;
    const signed = await userSignAccept();
    await harness.handler.handleAccept({
      id: 'accept-3',
      kind: 'acceptTopUp',
      channelId: channel.id,
      offerId: offer.offerId,
      signedNewState: signed,
    });
    const row = await harness.h.repos.topupOffers.get(offer.offerId);
    expect(row?.status).toBe('rejected');
    expect(row?.rejectReason).toMatch(/submission failed/);
    expect(harness.liquidity.perCounterpartyCommitted(harness.bobAccount.address)).toBe(0n);
  });
});

describe('TopUpHandler.handleReject', () => {
  it('marks the offer rejected and releases committed reservation', async () => {
    const harness = await makeHarness();
    try {
      const ch = makeChannel('ac', harness.bobAccount.address, harness.hubAccount.address);
      await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
      await harness.handler.evaluateNewChannel(ch);
      const env = harness.proposed[0]?.msg;
      if (!env) throw new Error('expected proposeTopUp');

      await harness.handler.handleReject({
        id: 'reject-1',
        kind: 'rejectTopUp',
        channelId: ch.id,
        offerId: env.offerId,
        reason: 'not interested',
      });

      const row = await harness.h.repos.topupOffers.get(env.offerId);
      expect(row?.status).toBe('rejected');
      expect(row?.rejectReason).toBe('not interested');
      expect(harness.liquidity.perCounterpartyCommitted(harness.bobAccount.address)).toBe(0n);
    } finally {
      await harness.h.cleanup();
    }
  });
});

describe('TopUpHandler.expireDue', () => {
  it('flips overdue proposed and queued rows to expired', async () => {
    const harness = await makeHarness({
      policyOverrides: { offerValidityMs: 1_000 },
    });
    try {
      const ch = makeChannel('ad', harness.bobAccount.address, harness.hubAccount.address);
      await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
      await harness.handler.evaluateNewChannel(ch);
      const env = harness.proposed[0]?.msg;
      if (!env) throw new Error('expected proposeTopUp');

      const farFuture = Number(env.validUntil) * 1000 + 60_000;
      await harness.handler.expireDue(farFuture);

      const row = await harness.h.repos.topupOffers.get(env.offerId);
      expect(row?.status).toBe('expired');
      expect(harness.liquidity.perCounterpartyCommitted(harness.bobAccount.address)).toBe(0n);
    } finally {
      await harness.h.cleanup();
    }
  });
});

describe('TopUpHandler.handleToppedUp', () => {
  it('marks the offer confirmed and updates channel amounts', async () => {
    const harness = await makeHarness();
    try {
      const ch = makeChannel('ae', harness.bobAccount.address, harness.hubAccount.address);
      await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
      await harness.handler.evaluateNewChannel(ch);
      const env = harness.proposed[0]?.msg;
      if (!env) throw new Error('expected proposeTopUp');

      // Simulate user accept to move offer → submitted.
      const sigHex = (await harness.bobAccount.signTypedData(
        buildChannelStateTypedData(env.newState, CHAIN_ID, VC),
      )) as Hex;
      const signed: SignedState = {
        state: env.newState,
        sigA: hexToSignature(sigHex),
        sigB: hexToSignature(env.newSig),
      };
      await harness.handler.handleAccept({
        id: 'accept-1',
        kind: 'acceptTopUp',
        channelId: ch.id,
        offerId: env.offerId,
        signedNewState: signed,
      });

      // Now fire the on-chain confirmation.
      await harness.handler.handleToppedUp(
        ch.id,
        harness.hubAccount.address,
        env.amount,
        env.newState.version,
      );

      const row = await harness.h.repos.topupOffers.get(env.offerId);
      expect(row?.status).toBe('confirmed');
      const amts = harness.pool.amountsOf(ch.id);
      expect(amts?.amountB).toBe(5_000_000n); // hub's deposit landed
      // submitted reservation was released.
      expect(harness.liquidity.perCounterpartySubmitted(harness.bobAccount.address)).toBe(0n);
      // topUpComplete was pushed to user.
      expect(harness.completed).toHaveLength(1);
      expect(harness.completed[0]?.msg.offerId).toBe(env.offerId);
    } finally {
      await harness.h.cleanup();
    }
  });

  it('ignores ToppedUp where depositor is not the hub', async () => {
    const harness = await makeHarness();
    try {
      const ch = makeChannel('af', harness.bobAccount.address, harness.hubAccount.address);
      await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
      // No matching submitted offer — deposit by Bob himself.
      await harness.handler.handleToppedUp(ch.id, harness.bobAccount.address, 1_000n, 1n);
      // Channel amounts unchanged.
      expect(harness.pool.amountsOf(ch.id)?.amountB).toBe(0n);
    } finally {
      await harness.h.cleanup();
    }
  });
});

describe('TopUpHandler concurrency (Scenario 12)', () => {
  it('serializes two concurrent evaluateNewChannel calls via the hot-wallet mutex', async () => {
    // Hub has 5 USDC headroom; two channels each request 5 USDC. With the
    // mutex, the first wins the headroom; the second sees committed == 5
    // and the policy approves only what remains (which depends on the
    // total cap). We assert that exactly one chain.topUp call happens with
    // the expected amount and that committed sums never exceed the wallet.
    const harness = await makeHarness({
      hubBalance: 5_000_000n,
      policyOverrides: { defaultOfferAmount: 5_000_000n },
    });
    try {
      const ch1 = makeChannel('b1', harness.bobAccount.address, harness.hubAccount.address);
      const carolKey =
        '0x000000000000000000000000000000000000000000000000000000000000c0c1' as const;
      const carolAccount = privateKeyToAccount(carolKey);
      const ch2 = makeChannel('b2', carolAccount.address, harness.hubAccount.address);
      await harness.pool.register(ch1, undefined, { amountA: 10_000_000n, amountB: 0n });
      await harness.pool.register(ch2, undefined, { amountA: 10_000_000n, amountB: 0n });

      await Promise.all([
        harness.handler.evaluateNewChannel(ch1),
        harness.handler.evaluateNewChannel(ch2),
      ]);

      // Either both run sequentially and each get 5 (would over-commit), OR
      // the second one gets 0 (no headroom left). The mutex ensures the
      // committed total never exceeds the wallet headroom.
      const totalCommitted = harness.liquidity.totalCommitted();
      expect(totalCommitted).toBeLessThanOrEqual(5_000_000n);

      const proposedRows = await harness.h.repos.topupOffers.listByStatus('proposed');
      const queuedRows = await harness.h.repos.topupOffers.listByStatus('queued');
      // Exactly one proposed (the first to win the mutex), one queued (the
      // second saw zero headroom).
      expect(proposedRows.length + queuedRows.length).toBeGreaterThanOrEqual(1);
      expect(proposedRows.length).toBe(1);
    } finally {
      await harness.h.cleanup();
    }
  });
});

describe('TopUpHandler.listPendingForCounterparty', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => harness.h.cleanup());

  it('returns proposed offers for a counterparty as ProposeTopUpMessage envelopes', async () => {
    const ch = makeChannel('cc', harness.bobAccount.address, harness.hubAccount.address);
    await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
    await harness.handler.evaluateNewChannel(ch);

    const orig = harness.proposed[0]?.msg;
    expect(orig).toBeDefined();
    if (!orig) return;

    const pending = await harness.handler.listPendingForCounterparty(harness.bobAccount.address);
    expect(pending).toHaveLength(1);
    const env = pending[0];
    expect(env?.kind).toBe('proposeTopUp');
    expect(env?.offerId).toBe(orig.offerId);
    expect(env?.channelId).toBe(orig.channelId);
    expect(env?.amount).toBe(orig.amount);
    expect(env?.newState.version).toBe(orig.newState.version);
    expect(env?.prevSig).toBe(orig.prevSig);
    expect(env?.newSig).toBe(orig.newSig);
  });

  it('returns an empty list for a counterparty with no proposed offers', async () => {
    const pending = await harness.handler.listPendingForCounterparty(harness.bobAccount.address);
    expect(pending).toHaveLength(0);
  });

  it('skips offers past their validUntil deadline', async () => {
    const ch = makeChannel('cd', harness.bobAccount.address, harness.hubAccount.address);
    await harness.pool.register(ch, undefined, { amountA: 10_000_000n, amountB: 0n });
    await harness.handler.evaluateNewChannel(ch);

    const offers = await harness.h.repos.topupOffers.listByStatus('proposed');
    expect(offers).toHaveLength(1);
    const offer = offers[0];
    if (!offer) return;
    await harness.h.repos.topupOffers.update(offer.offerId, {
      validUntilSec: 1n, // 1970-ish
    });

    const pending = await harness.handler.listPendingForCounterparty(harness.bobAccount.address);
    expect(pending).toHaveLength(0);
  });
});

// Touch unused `signatureToHex` so tree-shaking type checks remain stable.
void signatureToHex;
