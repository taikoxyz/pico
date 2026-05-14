import type { Address } from '@inferenceroom/pico-protocol';
import { ZERO_ADDRESS } from '@inferenceroom/pico-protocol';

/**
 * Configuration for the hub's inbound liquidity admission policy (§8.5).
 * Scalar amounts default to USDC base units (6-decimal). For tokens with
 * different decimals, set `perTokenDefaultOfferAmount`/`perTokenMaxInboundPerChannel`
 * keyed by the token address. Round-3 smoke (issue #100) showed that a
 * scalar `5_000_000n` is unusable on native-ETH channels — 5 picoether.
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
  /**
   * Optional per-token overrides for `defaultOfferAmount`. Address keys are
   * matched case-insensitively. A native-ETH channel uses `ZERO_ADDRESS`.
   */
  readonly perTokenDefaultOfferAmount?: Readonly<Record<string, bigint>>;
  /** Optional per-token overrides for `maxInboundPerChannel`. */
  readonly perTokenMaxInboundPerChannel?: Readonly<Record<string, bigint>>;
  /** Optional per-token overrides for `maxInboundPerCounterparty`. */
  readonly perTokenMaxInboundPerCounterparty?: Readonly<Record<string, bigint>>;
}

/**
 * Default policy for v1 hubs.
 * - USDC (6-decimal): 5 / 10 / 100 USDC offer/channel/counterparty.
 * - Native ETH (18-decimal): 0.0001 / 0.1 / 1 ETH offer/channel/counterparty.
 *   Round-4 smoke (issue #100 follow-up) lowered the ETH per-offer from
 *   0.05 ETH → 0.0001 ETH so a 0.05 ETH hub hot wallet can service ~500
 *   channels instead of 1. Per-channel and per-counterparty caps stay so
 *   multiple repeat top-ups can grow inbound to the same channel/user.
 * - PTST mainnet test token (18-decimal, allowlisted on the v2 contract):
 *   2 / 10 / 100 PTST offer/channel/counterparty. The scalar fallback
 *   (`5_000_000n`) is USDC-shaped and would resolve to 5e-12 PTST for
 *   any 18-decimal allowlisted ERC-20, breaking pay routing the same
 *   way it broke native-ETH before this override.
 */
const PTST_MAINNET = '0x3CF2321323C23c9F91daFe99E2b121cab5cE3759';
export const DEFAULT_TOPUP_POLICY: TopUpPolicyConfig = {
  maxInboundPerCounterparty: 100_000_000n, // 100 USDC
  maxInboundPerChannel: 10_000_000n, //  10 USDC
  defaultOfferAmount: 5_000_000n, //   5 USDC
  offerValidityMs: 5 * 60_000, //   5 minutes
  perTokenDefaultOfferAmount: {
    [ZERO_ADDRESS.toLowerCase()]: 100_000_000_000_000n, // 0.0001 ETH
    [PTST_MAINNET.toLowerCase()]: 2_000_000_000_000_000_000n, // 2 PTST
  },
  perTokenMaxInboundPerChannel: {
    [ZERO_ADDRESS.toLowerCase()]: 100_000_000_000_000_000n, // 0.1 ETH
    [PTST_MAINNET.toLowerCase()]: 10_000_000_000_000_000_000n, // 10 PTST
  },
  perTokenMaxInboundPerCounterparty: {
    [ZERO_ADDRESS.toLowerCase()]: 1_000_000_000_000_000_000n, // 1 ETH
    [PTST_MAINNET.toLowerCase()]: 100_000_000_000_000_000_000n, // 100 PTST
  },
};

/**
 * Returns the policy's `defaultOfferAmount` for `token`, preferring a
 * per-token override if one exists (case-insensitive on the address) and
 * falling back to the scalar default.
 */
export function resolveDefaultOfferAmount(cfg: TopUpPolicyConfig, token: Address): bigint {
  const override = cfg.perTokenDefaultOfferAmount?.[token.toLowerCase()];
  return override ?? cfg.defaultOfferAmount;
}

/**
 * Returns the policy's `maxInboundPerChannel` for `token`, preferring a
 * per-token override if one exists.
 */
export function resolveMaxInboundPerChannel(cfg: TopUpPolicyConfig, token: Address): bigint {
  const override = cfg.perTokenMaxInboundPerChannel?.[token.toLowerCase()];
  return override ?? cfg.maxInboundPerChannel;
}

/**
 * Returns the policy's `maxInboundPerCounterparty` for `token`, preferring
 * a per-token override if one exists.
 */
export function resolveMaxInboundPerCounterparty(cfg: TopUpPolicyConfig, token: Address): bigint {
  const override = cfg.perTokenMaxInboundPerCounterparty?.[token.toLowerCase()];
  return override ?? cfg.maxInboundPerCounterparty;
}

export interface TopUpEvalContext {
  readonly counterparty: Address;
  /** Token of the channel being evaluated; resolves per-token policy overrides. */
  readonly token: Address;
  /** Hub's spendable balance of `token` in its hot wallet (raw on-chain reading). */
  readonly hubHotWalletBalance: bigint;
  /** Already-promised `token` to this counterparty across pending offers. */
  readonly committedToCounterparty: bigint;
  /** Existing hub-side balance across this counterparty's open channels. */
  readonly outboundToCounterparty: bigint;
  /** Across all counterparties; for hot-wallet headroom. */
  readonly totalCommitted: bigint;
}

export interface TopUpEvalResult {
  /** `null` = reject; otherwise the approved amount in `ctx.token`'s base units. */
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
  const headroom = ctx.hubHotWalletBalance - ctx.totalCommitted;
  if (headroom <= 0n) {
    return { approve: null, reason: 'hot-wallet headroom exhausted' };
  }

  const maxPerCounterparty = resolveMaxInboundPerCounterparty(cfg, ctx.token);
  const remainingPerCounterparty =
    maxPerCounterparty - ctx.committedToCounterparty - ctx.outboundToCounterparty;
  if (remainingPerCounterparty <= 0n) {
    return { approve: null, reason: 'per-counterparty cap reached' };
  }

  const desired = resolveDefaultOfferAmount(cfg, ctx.token);
  const maxPerChannel = resolveMaxInboundPerChannel(cfg, ctx.token);
  const cappedByHeadroom = headroom < desired ? headroom : desired;
  const cappedByCounterparty =
    remainingPerCounterparty < cappedByHeadroom ? remainingPerCounterparty : cappedByHeadroom;
  const cappedByPerChannel =
    maxPerChannel < cappedByCounterparty ? maxPerChannel : cappedByCounterparty;

  if (cappedByPerChannel <= 0n) {
    return { approve: null, reason: 'capped to zero' };
  }

  return { approve: cappedByPerChannel };
}
