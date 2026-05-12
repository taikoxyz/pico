import type {
  AcceptTopUpMessage,
  Address,
  ChainId,
  Channel,
  ChannelId,
  ChannelState,
  Hex,
  ProposeTopUpMessage,
  RejectTopUpMessage,
  Signature,
  SignedState,
  TopUpCompleteMessage,
} from '@inferenceroom/pico-protocol';
import { EMPTY_SIG_BYTES } from '@inferenceroom/pico-protocol';
import {
  type ChainAdapter,
  hexToSignature,
  randomHtlcId,
  signatureToHex,
} from '@inferenceroom/pico-sdk';
import {
  buildChannelStateTypedData,
  predictTopUpState,
  verifyChannelStateSignature,
} from '@inferenceroom/pico-state-machine';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { ChannelPool } from './channel-pool.js';
import type { Repos, TopUpOfferRow } from './db/repos/index.js';
import type { LiquidityTracker } from './liquidity.js';
import type { Logger } from './logger.js';
import type { HubMetrics } from './metrics.js';
import type { KeyedMutex } from './mutex.js';
import type { TopUpPolicyConfig } from './topup-policy.js';
import { evaluateTopUp } from './topup-policy.js';

export const HOT_WALLET_KEY = 'hot-wallet';

const SENTINEL_SIG: Signature = { r: EMPTY_SIG_BYTES, s: EMPTY_SIG_BYTES, v: 0 };

function buildSentinelPrev(
  channel: Channel,
  amounts: { amountA: bigint; amountB: bigint },
): SignedState {
  return {
    state: {
      channelId: channel.id,
      version: 0n,
      balanceA: amounts.amountA,
      balanceB: amounts.amountB,
      htlcs: [],
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: false,
    },
    sigA: SENTINEL_SIG,
    sigB: SENTINEL_SIG,
  };
}

function bytes32Random(): Hex {
  // Reuse the SDK's 32-byte random helper. Aliased for clarity at call sites.
  return randomHtlcId() as Hex;
}

export interface TopUpHandlerDeps {
  readonly channelPool: ChannelPool;
  readonly liquidity: LiquidityTracker;
  readonly repos: Repos;
  readonly metrics: HubMetrics;
  readonly logger: Logger;
  readonly hubAccount: PrivateKeyAccount;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly chain: ChainAdapter;
  readonly token: Address;
  readonly policyConfig: TopUpPolicyConfig;
  readonly hotWalletMutex: KeyedMutex<string>;
  /** Reads the hub's current USDC balance (RPC-backed in production). */
  readonly readUsdcBalance: () => Promise<bigint>;
  /** Push a `proposeTopUp` envelope to the user; returns true if a session was found. */
  readonly pushProposeTopUp: (toAddress: Address, msg: ProposeTopUpMessage) => boolean;
  /** Notify the user that the on-chain topUp has confirmed; returns true if delivered. */
  readonly pushTopUpComplete?: (toAddress: Address, msg: TopUpCompleteMessage) => boolean;
  readonly nowMs?: () => number;
}

export class TopUpHandler {
  private readonly now: () => number;

  constructor(private readonly deps: TopUpHandlerDeps) {
    this.now = deps.nowMs ?? (() => Date.now());
  }

  /**
   * Hydrate in-memory liquidity reservations from the durable offer table.
   * Anything in `proposed` / `accepted` is still committed to a counterparty;
   * `submitted` is in flight. Also expires any rows past `validUntil`.
   */
  async hydrate(): Promise<void> {
    const proposed = await this.deps.repos.topupOffers.listByStatus('proposed');
    const accepted = await this.deps.repos.topupOffers.listByStatus('accepted');
    const submitted = await this.deps.repos.topupOffers.listByStatus('submitted');
    const nowSec = BigInt(Math.floor(this.now() / 1000));

    for (const o of [...proposed, ...accepted]) {
      if (o.validUntilSec < nowSec) {
        await this.deps.repos.topupOffers.update(o.offerId, { status: 'expired' });
        continue;
      }
      this.deps.liquidity.noteCommit(o.counterparty, o.amount);
    }
    for (const o of submitted) {
      this.deps.liquidity.noteSubmitted(o.counterparty, o.amount);
    }
    this.deps.logger.info(
      {
        proposed: proposed.length,
        accepted: accepted.length,
        submitted: submitted.length,
      },
      'topup-handler hydrated',
    );
  }

  /**
   * Called from chain-watcher on `ChannelOpened` with `userB == hub`. Decides
   * whether to immediately propose a top-up or queue. Holds the hot-wallet
   * mutex across the read-balance + decide + sign + persist sequence.
   */
  async evaluateNewChannel(channel: Channel): Promise<void> {
    const counterparty = this.counterpartyOf(channel);
    if (!counterparty) return;

    await this.deps.hotWalletMutex.run(HOT_WALLET_KEY, async () => {
      const ctx = await this.buildEvalContext(counterparty);
      const decision = evaluateTopUp(this.deps.policyConfig, ctx);
      if (decision.approve === null) {
        this.deps.logger.info(
          { channelId: channel.id, counterparty, reason: decision.reason },
          'topup: queuing — admission policy rejected',
        );
        await this.queueOffer(channel, counterparty, this.deps.policyConfig.defaultOfferAmount);
        return;
      }
      await this.proposeUnderLock(channel, counterparty, decision.approve);
    });
  }

  /**
   * Proposes a top-up of `amount` for `channel`. Acquires the hot-wallet
   * mutex; returns the inserted offer row. Used by `auto-recycle` after a
   * close frees liquidity.
   */
  async propose(channel: Channel, amount: bigint): Promise<TopUpOfferRow> {
    const counterparty = this.counterpartyOf(channel);
    if (!counterparty) {
      throw new Error(`topup: hub is not a party of channel ${channel.id}`);
    }
    return this.deps.hotWalletMutex.run(HOT_WALLET_KEY, () =>
      this.proposeUnderLock(channel, counterparty, amount),
    );
  }

  /** Handle an incoming `acceptTopUp` from the user. */
  async handleAccept(msg: AcceptTopUpMessage): Promise<void> {
    const offer = await this.deps.repos.topupOffers.get(msg.offerId);
    if (!offer) {
      this.deps.logger.warn({ offerId: msg.offerId }, 'topup: accept for unknown offer');
      return;
    }
    if (offer.status !== 'proposed') {
      this.deps.logger.warn(
        { offerId: msg.offerId, status: offer.status },
        'topup: accept on offer not in proposed state',
      );
      return;
    }
    if (offer.channelId !== msg.channelId) {
      this.deps.logger.warn(
        { offerId: msg.offerId, expected: offer.channelId, got: msg.channelId },
        'topup: accept channelId mismatch',
      );
      return;
    }
    const nowSec = BigInt(Math.floor(this.now() / 1000));
    if (offer.validUntilSec < nowSec) {
      await this.deps.repos.topupOffers.update(offer.offerId, { status: 'expired' });
      this.deps.liquidity.releaseCommit(offer.counterparty, offer.amount);
      this.deps.logger.warn({ offerId: msg.offerId }, 'topup: late accept; offer expired');
      return;
    }

    // Validate the user-signed state matches what we proposed.
    const signed = msg.signedNewState;
    if (
      signed.state.channelId !== offer.newState.channelId ||
      signed.state.version !== offer.newState.version ||
      signed.state.balanceA !== offer.newState.balanceA ||
      signed.state.balanceB !== offer.newState.balanceB ||
      signed.state.htlcs.length !== 0 ||
      signed.state.finalized !== false
    ) {
      this.deps.logger.warn({ offerId: msg.offerId }, 'topup: accept state mismatch');
      return;
    }

    // Verify the user's signature on the new state.
    const channel = this.deps.channelPool.get(offer.channelId);
    if (!channel) {
      this.deps.logger.warn({ offerId: msg.offerId }, 'topup: accept for unknown channel');
      return;
    }
    const hubIsA = channel.userA.toLowerCase() === this.deps.hubAccount.address.toLowerCase();
    const userSig = hubIsA ? signed.sigB : signed.sigA;
    const ok = await verifyChannelStateSignature(
      signed.state,
      signatureToHex(userSig),
      offer.counterparty,
      this.deps.chainId,
      this.deps.verifyingContract,
    );
    if (!ok) {
      this.deps.logger.warn({ offerId: msg.offerId }, 'topup: accept signature invalid');
      return;
    }

    await this.deps.repos.topupOffers.update(offer.offerId, {
      status: 'accepted',
      userSignedNewState: signed,
    });

    // Submit the on-chain topUp under the hot-wallet mutex so concurrent
    // proposes do not double-spend the same hot-wallet headroom.
    await this.deps.hotWalletMutex.run(HOT_WALLET_KEY, async () => {
      // Re-load the latest pre-top-up state for `prev`. If we have no
      // co-signed state yet (first top-up), use the sentinel.
      const latest = this.deps.channelPool.latest(offer.channelId);
      const amounts = this.deps.channelPool.amountsOf(offer.channelId);
      let prev: SignedState;
      if (latest && latest.state.version > 0n) {
        prev = latest;
      } else if (amounts) {
        prev = buildSentinelPrev(channel, amounts);
      } else {
        // No on-chain amounts cached and no latest state — derive from offer.
        const inferredA = hubIsA ? offer.newState.balanceA - offer.amount : offer.newState.balanceA;
        const inferredB = hubIsA ? offer.newState.balanceB : offer.newState.balanceB - offer.amount;
        prev = buildSentinelPrev(channel, { amountA: inferredA, amountB: inferredB });
      }

      try {
        const result = await this.deps.chain.topUp({
          channelId: offer.channelId,
          amount: offer.amount,
          prev,
          next: signed,
          token: this.deps.token,
          approve: true,
        });
        // Move the reservation from `committed` → `submitted` and persist.
        this.deps.liquidity.releaseCommit(offer.counterparty, offer.amount);
        this.deps.liquidity.noteSubmitted(offer.counterparty, offer.amount);
        await this.deps.repos.topupOffers.update(offer.offerId, {
          status: 'submitted',
          submittedTxHash: result.txHash as Hex,
        });
        this.deps.logger.info(
          { offerId: offer.offerId, txHash: result.txHash, channelId: offer.channelId },
          'topup: tx submitted',
        );
      } catch (err) {
        this.deps.logger.error(
          { err: (err as Error).message, offerId: offer.offerId },
          'topup: chain.topUp failed',
        );
        // Roll the offer back to proposed-then-rejected so the headroom
        // returns. (Spec §8.6 — failed submission == hub fails to provide.)
        await this.deps.repos.topupOffers.update(offer.offerId, {
          status: 'rejected',
          rejectReason: `submission failed: ${(err as Error).message}`,
        });
        this.deps.liquidity.releaseCommit(offer.counterparty, offer.amount);
      }
    });
  }

  /** Handle an incoming `rejectTopUp` from the user. */
  async handleReject(msg: RejectTopUpMessage): Promise<void> {
    const offer = await this.deps.repos.topupOffers.get(msg.offerId);
    if (!offer) {
      this.deps.logger.warn({ offerId: msg.offerId }, 'topup: reject for unknown offer');
      return;
    }
    if (offer.status !== 'proposed' && offer.status !== 'queued') {
      this.deps.logger.warn(
        { offerId: msg.offerId, status: offer.status },
        'topup: reject on terminal-state offer',
      );
      return;
    }
    await this.deps.repos.topupOffers.update(offer.offerId, {
      status: 'rejected',
      rejectReason: msg.reason,
    });
    if (offer.status === 'proposed') {
      this.deps.liquidity.releaseCommit(offer.counterparty, offer.amount);
    }
    this.deps.logger.info(
      { offerId: offer.offerId, reason: msg.reason },
      'topup: rejected by user',
    );
  }

  /** Periodic sweep — flips overdue rows to expired and releases commits. */
  async expireDue(nowMs: number): Promise<void> {
    const nowSec = BigInt(Math.floor(nowMs / 1000));
    const candidates = [
      ...(await this.deps.repos.topupOffers.listByStatus('queued')),
      ...(await this.deps.repos.topupOffers.listByStatus('proposed')),
    ];
    for (const o of candidates) {
      if (o.validUntilSec >= nowSec) continue;
      await this.deps.repos.topupOffers.update(o.offerId, { status: 'expired' });
      if (o.status === 'proposed') {
        this.deps.liquidity.releaseCommit(o.counterparty, o.amount);
      }
      this.deps.logger.info({ offerId: o.offerId, channelId: o.channelId }, 'topup: offer expired');
    }
  }

  /**
   * Called from chain-watcher on `ToppedUp(channelId, depositor, amount, newVersion)`.
   * Marks the matching offer confirmed; bumps channel amounts; releases the
   * `submitted` reservation.
   */
  async handleToppedUp(
    channelId: ChannelId,
    depositor: Address,
    amount: bigint,
    newVersion: bigint,
  ): Promise<void> {
    // Only react to deposits *the hub* made (depositor == hub.address). User-
    // initiated top-ups follow a different code path and aren't tracked here.
    if (depositor.toLowerCase() !== this.deps.hubAccount.address.toLowerCase()) {
      return;
    }

    // Find the matching submitted offer for (channelId, amount). If multiple
    // exist, prefer the one whose newVersion matches.
    const offers = await this.deps.repos.topupOffers.listByChannel(channelId);
    const match =
      offers.find(
        (o) => o.status === 'submitted' && o.amount === amount && o.newVersion === newVersion,
      ) ?? offers.find((o) => o.status === 'submitted' && o.amount === amount);
    if (!match) {
      this.deps.logger.warn(
        { channelId, depositor, amount, newVersion },
        'topup: ToppedUp observed with no matching submitted offer',
      );
      return;
    }

    const channel = this.deps.channelPool.get(channelId);
    if (!channel) {
      this.deps.logger.warn({ channelId }, 'topup: ToppedUp for unknown channel');
      return;
    }
    const hubIsA = channel.userA.toLowerCase() === this.deps.hubAccount.address.toLowerCase();
    const amountsBefore = this.deps.channelPool.amountsOf(channelId) ?? {
      amountA: 0n,
      amountB: 0n,
    };
    const newAmountA = hubIsA ? amountsBefore.amountA + amount : amountsBefore.amountA;
    const newAmountB = hubIsA ? amountsBefore.amountB : amountsBefore.amountB + amount;

    await this.deps.channelPool.updateAmounts(channelId, newAmountA, newAmountB);
    if (match.userSignedNewState) {
      // Persist the post-top-up state so the router has a fresh balance view
      // and downstream paths see the new balanceA/balanceB.
      await this.deps.channelPool.recordState(channelId, match.userSignedNewState);
    }

    // Refresh the in-memory liquidity snapshot for routing decisions.
    const latest = this.deps.channelPool.latest(channelId);
    if (latest) {
      this.deps.liquidity.set(channelId, {
        outbound: hubIsA ? latest.state.balanceA : latest.state.balanceB,
        inbound: hubIsA ? latest.state.balanceB : latest.state.balanceA,
      });
    }
    this.deps.liquidity.releaseSubmitted(match.counterparty, amount);

    await this.deps.repos.topupOffers.update(match.offerId, { status: 'confirmed' });
    this.deps.logger.info(
      { offerId: match.offerId, channelId, newVersion: newVersion.toString() },
      'topup: confirmed on-chain',
    );

    // Notify the user via WS, if a session is active.
    if (this.deps.pushTopUpComplete) {
      const completeMsg: TopUpCompleteMessage = {
        id: `topUpComplete-${match.offerId}`,
        kind: 'topUpComplete',
        channelId,
        offerId: match.offerId,
        newVersion,
        txHash: (match.submittedTxHash ?? '0x') as Hex,
      };
      this.deps.pushTopUpComplete(match.counterparty, completeMsg);
    }
  }

  // ───── internal helpers ─────

  private counterpartyOf(channel: Channel): Address | undefined {
    const hub = this.deps.hubAccount.address.toLowerCase();
    const a = channel.userA.toLowerCase();
    const b = channel.userB.toLowerCase();
    if (a === hub) return channel.userB;
    if (b === hub) return channel.userA;
    return undefined;
  }

  private async buildEvalContext(counterparty: Address): Promise<{
    counterparty: Address;
    hubHotWalletUsdc: bigint;
    committedToCounterparty: bigint;
    outboundToCounterparty: bigint;
    totalCommitted: bigint;
  }> {
    const hubHotWalletUsdc = await this.deps.readUsdcBalance();
    const committedToCounterparty =
      this.deps.liquidity.perCounterpartyCommitted(counterparty) +
      this.deps.liquidity.perCounterpartySubmitted(counterparty);
    const channels = new Map(
      this.deps.channelPool.list().map((c) => [c.id, { userA: c.userA, userB: c.userB }]),
    );
    const outboundToCounterparty = this.deps.liquidity.perCounterpartyOutbound(
      counterparty,
      this.deps.hubAccount.address,
      channels,
    );
    const totalCommitted =
      this.deps.liquidity.totalCommitted() + this.deps.liquidity.totalSubmitted();
    return {
      counterparty,
      hubHotWalletUsdc,
      committedToCounterparty,
      outboundToCounterparty,
      totalCommitted,
    };
  }

  /** Persists a queued offer (no envelope sent; awaits liquidity). */
  private async queueOffer(
    channel: Channel,
    counterparty: Address,
    amount: bigint,
  ): Promise<TopUpOfferRow> {
    const now = this.now();
    const offerId = bytes32Random();
    const validUntilSec =
      BigInt(Math.floor(now / 1000)) +
      BigInt(Math.floor(this.deps.policyConfig.offerValidityMs / 1000));
    // Construct a placeholder newState so the row is queryable; auto-recycle
    // will rebuild it before pushing.
    const placeholderState: ChannelState = {
      channelId: channel.id,
      version: 1n,
      balanceA: 0n,
      balanceB: 0n,
      htlcs: [],
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: false,
    };
    const row: TopUpOfferRow = {
      offerId,
      channelId: channel.id,
      counterparty,
      amount,
      prevVersion: 0n,
      newVersion: 1n,
      newState: placeholderState,
      hubSigPrev: EMPTY_SIG_BYTES,
      hubSigNew: EMPTY_SIG_BYTES,
      validUntilSec,
      status: 'queued',
      priority: 0,
      queuedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repos.topupOffers.insert(row);
    return row;
  }

  /** Builds, signs, persists, and pushes a `proposeTopUp` envelope. */
  private async proposeUnderLock(
    channel: Channel,
    counterparty: Address,
    amount: bigint,
  ): Promise<TopUpOfferRow> {
    const hubIsA = channel.userA.toLowerCase() === this.deps.hubAccount.address.toLowerCase();
    const hubSide: 'A' | 'B' = hubIsA ? 'A' : 'B';

    const latest = this.deps.channelPool.latest(channel.id);
    const amounts = this.deps.channelPool.amountsOf(channel.id);

    const prevState: ChannelState =
      latest && latest.state.version > 0n
        ? latest.state
        : {
            channelId: channel.id,
            version: 0n,
            balanceA: amounts?.amountA ?? 0n,
            balanceB: amounts?.amountB ?? 0n,
            htlcs: [],
            htlcsCount: 0,
            htlcsTotalLocked: 0n,
            finalized: false,
          };

    const newState = predictTopUpState(prevState, hubSide, amount);

    // Sign the new state with the hub's key.
    const newSigHex = await this.deps.hubAccount.signTypedData(
      buildChannelStateTypedData(newState, this.deps.chainId, this.deps.verifyingContract),
    );

    // For `prevSig`, sign the prev state if it's a real co-signed state;
    // otherwise emit the EMPTY_SIG_BYTES sentinel (§8.6).
    const prevSigHex: Hex =
      latest && latest.state.version > 0n
        ? signatureToHex(hubIsA ? latest.sigA : latest.sigB)
        : EMPTY_SIG_BYTES;

    const now = this.now();
    const offerId = bytes32Random();
    const validUntilSec =
      BigInt(Math.floor(now / 1000)) +
      BigInt(Math.floor(this.deps.policyConfig.offerValidityMs / 1000));

    const row: TopUpOfferRow = {
      offerId,
      channelId: channel.id,
      counterparty,
      amount,
      prevVersion: prevState.version,
      newVersion: newState.version,
      newState,
      hubSigPrev: prevSigHex,
      hubSigNew: newSigHex,
      validUntilSec,
      status: 'proposed',
      priority: 0,
      queuedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repos.topupOffers.insert(row);
    this.deps.liquidity.noteCommit(counterparty, amount);

    const envelope: ProposeTopUpMessage = {
      id: `proposeTopUp-${offerId}`,
      kind: 'proposeTopUp',
      channelId: channel.id,
      offerId,
      amount,
      prevStateVersion: prevState.version,
      newState,
      validUntil: validUntilSec,
      feePolicy: null,
      minLifetime: null,
      maxInFlightHtlcs: 5,
      partialAccepted: false,
      prevSig: prevSigHex,
      newSig: newSigHex,
    };
    const delivered = this.deps.pushProposeTopUp(counterparty, envelope);
    this.deps.logger.info(
      {
        offerId,
        channelId: channel.id,
        counterparty,
        amount: amount.toString(),
        delivered,
      },
      'topup: proposed',
    );
    return row;
  }
}

export { hexToSignature };
