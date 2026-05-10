import type { Address } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPUP_POLICY,
  type TopUpEvalContext,
  type TopUpPolicyConfig,
  evaluateTopUp,
} from './topup-policy.js';

const COUNTERPARTY: Address = '0x000000000000000000000000000000000000B0B0' as Address;

function ctx(overrides: Partial<TopUpEvalContext> = {}): TopUpEvalContext {
  return {
    counterparty: COUNTERPARTY,
    hubHotWalletUsdc: 100_000_000n,
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
    const r = evaluateTopUp(policy(), ctx({ hubHotWalletUsdc: 0n }));
    expect(r.approve).toBeNull();
    expect(r.reason).toContain('headroom');
  });

  it('rejects when totalCommitted equals hot-wallet (no headroom)', () => {
    const r = evaluateTopUp(
      policy(),
      ctx({ hubHotWalletUsdc: 5_000_000n, totalCommitted: 5_000_000n }),
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
    const r = evaluateTopUp(policy(), ctx({ hubHotWalletUsdc: 3_000_000n, totalCommitted: 0n }));
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
      ctx({ hubHotWalletUsdc: 1_000_000_000n }),
    );
    expect(r.approve).toBe(8_000_000n);
  });

  it('rejects when per-channel cap is zero', () => {
    const r = evaluateTopUp(policy({ maxInboundPerChannel: 0n }), ctx());
    expect(r.approve).toBeNull();
    expect(r.reason).toBe('capped to zero');
  });
});
