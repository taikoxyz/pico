import {
  type ChannelId,
  type Hex,
  type Htlc,
  type PaymentHash,
  htlcDirectionByte,
  htlcExpirySeconds,
  htlcMerkleProof,
} from '@inferenceroom/pico-protocol';
import type { ChainAdapter } from '@inferenceroom/pico-sdk';
import type { Logger } from './logger.js';
import type { WatchtowerStore } from './storage.js';

/**
 * H6: HTLC settlement resolver. Watches for channels whose stored signed
 * state has `htlcsCount > 0` and posts `claimHtlc` (when preimage is known)
 * or `refundHtlc` (after expiry, or after the channel-wide resolution
 * deadline per the H1 force-refund path).
 *
 * Architecture choice: the resolver doesn't own RPC subscriptions — it's
 * driven by the Scheduler's tick or the chain-watcher event stream. Each
 * call to `resolveChannel(channelId)` is idempotent: HTLCs already settled
 * on chain return Pending == false and are filtered out by the contract's
 * "resolved" check.
 *
 * Trust model: the watchtower trusts its store (only states admitted via
 * `remember()` land there). Preimages come from the hub forwarder (POST
 * /v1/preimage) or from clients reporting completed payments.
 */
export interface HtlcResolverDeps {
  readonly adapter: ChainAdapter;
  readonly store: WatchtowerStore;
  readonly logger: Logger;
  /** Optional: clock for tests. Defaults to `() => Date.now()`. */
  readonly nowMs?: () => number;
}

export interface ResolveOutcome {
  /** Preimage available → claimHtlc posted. */
  readonly claimed: readonly Hex[];
  /** Expiry passed (own or channel-wide grace) → refundHtlc posted. */
  readonly refunded: readonly Hex[];
  /** No preimage and not yet expired → wait. */
  readonly pending: readonly Hex[];
  /** Errors per HTLC id (e.g. proof build / tx failure). */
  readonly errors: ReadonlyMap<Hex, string>;
}

export class HtlcResolver {
  private readonly nowMs: () => number;

  constructor(private readonly deps: HtlcResolverDeps) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /**
   * Walk the stored signed state for `channelId` and post claim/refund txs
   * for each in-flight HTLC. Caller is responsible for invoking this only
   * when the channel is in `Status.ResolvingHtlcs` on chain — otherwise
   * the contract will revert `!resolving` and the resolver will surface
   * the error per-HTLC.
   *
   * The contract-level `htlcResolutionDeadline` allows refunds of any
   * pending HTLC after the channel-wide grace window regardless of the
   * HTLC's own expiry, so a malicious far-future expiry can't deadlock
   * `finalize`. We mirror that policy here by passing
   * `channelResolutionDeadlineMs` from the caller (sourced from the
   * `HtlcResolutionStarted` event).
   */
  async resolveChannel(
    channelId: ChannelId,
    opts: {
      /** Channel-wide resolution deadline in ms (Unix); enables forced refund. */
      readonly channelResolutionDeadlineMs?: number;
    } = {},
  ): Promise<ResolveOutcome> {
    const claimed: Hex[] = [];
    const refunded: Hex[] = [];
    const pending: Hex[] = [];
    const errors = new Map<Hex, string>();

    const states = this.deps.store.loadAllSignedStates();
    const stored = states.find((s) => s.state.channelId === channelId);
    if (!stored) {
      this.deps.logger.warn({ channelId }, 'htlc-resolver: no stored state for channel');
      return { claimed, refunded, pending, errors };
    }
    if (stored.state.htlcs.length === 0) {
      this.deps.logger.debug(
        { channelId },
        'htlc-resolver: stored state has no HTLCs; nothing to resolve',
      );
      return { claimed, refunded, pending, errors };
    }

    const nowMs = this.nowMs();
    const totalLeaves = BigInt(stored.state.htlcs.length);

    for (const htlc of stored.state.htlcs) {
      const expired = htlc.expiryMs <= BigInt(nowMs);
      const graceElapsed =
        opts.channelResolutionDeadlineMs !== undefined && nowMs >= opts.channelResolutionDeadlineMs;
      const preimage = this.deps.store.getPreimage(htlc.paymentHash as PaymentHash);

      try {
        if (preimage && !expired) {
          await this.postClaim(channelId, stored.state.htlcs, htlc, preimage.preimage, totalLeaves);
          claimed.push(htlc.id);
        } else if (expired || graceElapsed) {
          await this.postRefund(channelId, stored.state.htlcs, htlc, totalLeaves);
          refunded.push(htlc.id);
        } else {
          pending.push(htlc.id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.set(htlc.id, msg);
        this.deps.logger.error(
          { channelId, htlcId: htlc.id, err: msg },
          'htlc-resolver: settlement tx failed',
        );
      }
    }

    return { claimed, refunded, pending, errors };
  }

  /** Hub-forwarder entry point: persist a preimage learned off-chain. */
  rememberPreimage(paymentHash: Hex, preimage: Hex): void {
    this.deps.store.putPreimage({
      paymentHash,
      preimage,
      learnedAtMs: this.nowMs(),
    });
  }

  private async postClaim(
    channelId: ChannelId,
    set: readonly Htlc[],
    htlc: Htlc,
    preimage: Hex,
    totalLeaves: bigint,
  ): Promise<void> {
    const { proof, sortedIndex } = htlcMerkleProof(set, htlc.id);
    await this.deps.adapter.claimHtlc({
      channelId,
      htlc: {
        id: htlc.id,
        amount: htlc.amount,
        paymentHash: htlc.paymentHash,
        expiry: htlcExpirySeconds(htlc),
        direction: htlcDirectionByte(htlc.direction),
      },
      proof,
      sortedIndex: BigInt(sortedIndex),
      totalLeaves,
      preimage,
    });
  }

  private async postRefund(
    channelId: ChannelId,
    set: readonly Htlc[],
    htlc: Htlc,
    totalLeaves: bigint,
  ): Promise<void> {
    const { proof, sortedIndex } = htlcMerkleProof(set, htlc.id);
    await this.deps.adapter.refundHtlc({
      channelId,
      htlc: {
        id: htlc.id,
        amount: htlc.amount,
        paymentHash: htlc.paymentHash,
        expiry: htlcExpirySeconds(htlc),
        direction: htlcDirectionByte(htlc.direction),
      },
      proof,
      sortedIndex: BigInt(sortedIndex),
      totalLeaves,
    });
  }
}
