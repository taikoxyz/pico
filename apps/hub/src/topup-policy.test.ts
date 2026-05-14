import type { Address } from '@inferenceroom/pico-protocol';
import { ZERO_ADDRESS } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPUP_POLICY,
  type TopUpEvalContext,
  type TopUpPolicyConfig,
  evaluateTopUp,
  resolveDefaultOfferAmount,
  resolveMaxInboundPerChannel,
  resolveMaxInboundPerCounterparty,
} from './topup-policy.js';

const COUNTERPARTY: Address = '0x000000000000000000000000000000000000B0B0' as Address;
const USDC: Address = '0x000000000000000000000000000000000000C0C0' as Address;

function ctx(overrides: Partial<TopUpEvalContext> = {}): TopUpEvalContext {
  return {
    counterparty: COUNTERPARTY,
    token: USDC,
    hubHotWalletBalance: 100_000_000n,
    committedToCounterparty: 0n,
    outboundToCounterparty: 0n,
    totalCommitted: 0n,
    ...overrides,
  };
}

function policy(overrides: Partial<TopUpPolicyConfig> = {}): TopUpPolicyConfig {
  return { ...DEFAULT_TOPUP_POLICY, ...overrides };
}

describe('evaluateTopUp', () => {
  it('happy path returns the default offer amount', () => {
    const r = evaluateTopUp(policy(), ctx());
    expect(r.approve).toBe(5_000_000n);
  });

  it('rejects when hot-wallet headroom is exhausted', () => {
    const r = evaluateTopUp(policy(), ctx({ hubHotWalletBalance: 0n }));
    expect(r.approve).toBeNull();
    expect(r.reason).toContain('headroom');
  });

  it('rejects when totalCommitted equals hot-wallet (no headroom)', () => {
    const r = evaluateTopUp(
      policy(),
      ctx({ hubHotWalletBalance: 5_000_000n, totalCommitted: 5_000_000n }),
    );
    expect(r.approve).toBeNull();
  });

  it('rejects when per-counterparty cap is reached via committed', () => {
    const r = evaluateTopUp(
      policy({ maxInboundPerCounterparty: 10_000_000n }),
      ctx({ committedToCounterparty: 10_000_000n }),
    );
    expect(r.approve).toBeNull();
    expect(r.reason).toContain('counterparty');
  });

  it('rejects when per-counterparty cap is reached via existing outbound', () => {
    const r = evaluateTopUp(
      policy({ maxInboundPerCounterparty: 10_000_000n }),
      ctx({ outboundToCounterparty: 10_000_000n }),
    );
    expect(r.approve).toBeNull();
  });

  it('caps offer by remaining headroom', () => {
    const r = evaluateTopUp(policy(), ctx({ hubHotWalletBalance: 3_000_000n, totalCommitted: 0n }));
    expect(r.approve).toBe(3_000_000n);
  });

  it('caps offer by remaining per-counterparty allowance', () => {
    const r = evaluateTopUp(
      policy({ maxInboundPerCounterparty: 6_000_000n }),
      ctx({ committedToCounterparty: 4_000_000n }),
    );
    expect(r.approve).toBe(2_000_000n);
  });

  it('caps offer by per-channel maximum', () => {
    const r = evaluateTopUp(
      policy({ defaultOfferAmount: 100_000_000n, maxInboundPerChannel: 8_000_000n }),
      ctx({ hubHotWalletBalance: 1_000_000_000n }),
    );
    expect(r.approve).toBe(8_000_000n);
  });

  it('rejects when per-channel cap is zero', () => {
    const r = evaluateTopUp(policy({ maxInboundPerChannel: 0n }), ctx());
    expect(r.approve).toBeNull();
    expect(r.reason).toBe('capped to zero');
  });

  it('uses per-token defaultOfferAmount for native ETH', () => {
    const r = evaluateTopUp(
      DEFAULT_TOPUP_POLICY,
      ctx({
        token: ZERO_ADDRESS,
        hubHotWalletBalance: 5_000_000_000_000_000_000n, // 5 ETH
      }),
    );
    expect(r.approve).toBe(100_000_000_000_000n); // 0.0001 ETH
  });

  it('falls back to scalar defaultOfferAmount when token not in override map', () => {
    const r = evaluateTopUp(DEFAULT_TOPUP_POLICY, ctx({ token: USDC }));
    expect(r.approve).toBe(5_000_000n); // 5 USDC
  });
});

describe('resolveDefaultOfferAmount', () => {
  it('returns per-token override when present', () => {
    expect(resolveDefaultOfferAmount(DEFAULT_TOPUP_POLICY, ZERO_ADDRESS)).toBe(
      100_000_000_000_000n,
    );
  });

  it('returns scalar default when no per-token override', () => {
    expect(resolveDefaultOfferAmount(DEFAULT_TOPUP_POLICY, USDC)).toBe(5_000_000n);
  });

  it('matches address case-insensitively', () => {
    const upper = ZERO_ADDRESS.toUpperCase().replace('0X', '0x') as Address;
    expect(resolveDefaultOfferAmount(DEFAULT_TOPUP_POLICY, upper)).toBe(100_000_000_000_000n);
  });
});

describe('resolveMaxInboundPerChannel', () => {
  it('uses ETH override for native channels', () => {
    expect(resolveMaxInboundPerChannel(DEFAULT_TOPUP_POLICY, ZERO_ADDRESS)).toBe(
      100_000_000_000_000_000n,
    );
  });

  it('falls back to scalar for other tokens', () => {
    expect(resolveMaxInboundPerChannel(DEFAULT_TOPUP_POLICY, USDC)).toBe(10_000_000n);
  });
});

describe('resolveMaxInboundPerCounterparty', () => {
  it('uses ETH override for native channels', () => {
    expect(resolveMaxInboundPerCounterparty(DEFAULT_TOPUP_POLICY, ZERO_ADDRESS)).toBe(
      1_000_000_000_000_000_000n,
    );
  });

  it('falls back to scalar for other tokens', () => {
    expect(resolveMaxInboundPerCounterparty(DEFAULT_TOPUP_POLICY, USDC)).toBe(100_000_000n);
  });
});
