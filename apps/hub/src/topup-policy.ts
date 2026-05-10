import type { Address } from '@inferenceroom/pico-protocol';

/**
 * Configuration for the hub's inbound liquidity admission policy (§8.5).
 * All amounts are USDC base units (6-decimal).
 */
export interface TopUpPolicyConfig {
  /** Lifetime cap on inbound provisioned to a single counterparty. */
  readonly maxInboundPerCounterparty: bigint;
  /** Max inbound per individual channel; usually the initial top-up size. */
  readonly maxInboundPerChannel: bigint;
  /** Default amount the hub tries to provision when offering. */
  readonly defaultOfferAmount: bigint;
  /** How long a `proposeTopUp` envelope is valid before auto-expiry (ms). */
  readonly offerValidityMs: number;
}

/** Default policy for v1 hubs. Matches scenario 5 (5 USDC initial top-up). */
export const DEFAULT_TOPUP_POLICY: TopUpPolicyConfig = {
  maxInboundPerCounterparty: 100_000_000n, // 100 USDC
  maxInboundPerChannel: 10_000_000n, //  10 USDC
  defaultOfferAmount: 5_000_000n, //   5 USDC
  offerValidityMs: 5 * 60_000, //   5 minutes
};

export interface TopUpEvalContext {
  readonly counterparty: Address;
  /** Hub's spendable USDC in its hot wallet (raw on-chain reading). */
  readonly hubHotWalletUsdc: bigint;
  /** Already-promised USDC to this counterparty across pending offers. */
  readonly committedToCounterparty: bigint;
  /** Existing hub-side balance across this counterparty's open channels. */
  readonly outboundToCounterparty: bigint;
  /** Across all counterparties; for hot-wallet headroom. */
  readonly totalCommitted: bigint;
}

export interface TopUpEvalResult {
  /** `null` = reject; otherwise the approved amount in USDC base units. */
  readonly approve: bigint | null;
  readonly reason?: string;
}

/**
 * Pure-function policy evaluator (§4.3, §8.6). Returns the amount the hub
 * should offer (capped by per-counterparty / per-channel / hot-wallet
 * headroom) or `{ approve: null, reason }` to reject. Tested in
 * `topup-policy.test.ts`.
 */
export function evaluateTopUp(cfg: TopUpPolicyConfig, ctx: TopUpEvalContext): TopUpEvalResult {
  const headroom = ctx.hubHotWalletUsdc - ctx.totalCommitted;
  if (headroom <= 0n) {
    return { approve: null, reason: 'hot-wallet headroom exhausted' };
  }

  const remainingPerCounterparty =
    cfg.maxInboundPerCounterparty - ctx.committedToCounterparty - ctx.outboundToCounterparty;
  if (remainingPerCounterparty <= 0n) {
    return { approve: null, reason: 'per-counterparty cap reached' };
  }

  const desired = cfg.defaultOfferAmount;
  const cappedByHeadroom = headroom < desired ? headroom : desired;
  const cappedByCounterparty =
    remainingPerCounterparty < cappedByHeadroom ? remainingPerCounterparty : cappedByHeadroom;
  const cappedByPerChannel =
    cfg.maxInboundPerChannel < cappedByCounterparty
      ? cfg.maxInboundPerChannel
      : cappedByCounterparty;

  if (cappedByPerChannel <= 0n) {
    return { approve: null, reason: 'capped to zero' };
  }

  return { approve: cappedByPerChannel };
}
