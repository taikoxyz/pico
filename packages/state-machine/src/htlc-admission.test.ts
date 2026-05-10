import {
  HTLC_TIMEOUT_DELTA_MS,
  type Htlc,
  MAX_HTLCS_PER_CHANNEL,
  MAX_HTLC_DURATION_MS,
  MAX_HTLC_VALUE_PER_COUNTERPARTY,
  MIN_HTLC_DURATION_MS,
} from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { type HtlcAdmissionContext, checkHtlcAdmissible, checkTimeoutDelta } from './htlc.js';

const NOW_MS = 10_000_000_000n;

function makeHtlc(amount: bigint, expiryMs: bigint): Htlc {
  return {
    id: '0x0000000000000000000000000000000000000000000000000000000000000001',
    direction: 'AtoB',
    amount,
    paymentHash: '0xabababababababababababababababababababababababababababababababab',
    expiryMs,
  };
}

function ctx(overrides: Partial<HtlcAdmissionContext> = {}): HtlcAdmissionContext {
  return {
    currentHtlcCount: 0,
    perChannelInflightValue: 0n,
    perCounterpartyInflightValue: 0n,
    maxPerChannelValue: 1_000_000_000n,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe('checkHtlcAdmissible', () => {
  it('happy path returns ok=true', () => {
    const htlc = makeHtlc(100n, NOW_MS + BigInt(MIN_HTLC_DURATION_MS));
    const result = checkHtlcAdmissible(htlc, ctx());
    expect(result.ok).toBe(true);
  });

  it('rejects when count cap is reached', () => {
    const htlc = makeHtlc(100n, NOW_MS + BigInt(MIN_HTLC_DURATION_MS));
    const result = checkHtlcAdmissible(htlc, ctx({ currentHtlcCount: MAX_HTLCS_PER_CHANNEL }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(String(MAX_HTLCS_PER_CHANNEL));
  });

  it('rejects when per-channel value cap would be exceeded', () => {
    const htlc = makeHtlc(100n, NOW_MS + BigInt(MIN_HTLC_DURATION_MS));
    const result = checkHtlcAdmissible(
      htlc,
      ctx({ perChannelInflightValue: 950n, maxPerChannelValue: 1_000n }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('per-channel');
  });

  it('rejects when per-counterparty aggregate cap would be exceeded', () => {
    const htlc = makeHtlc(2n, NOW_MS + BigInt(MIN_HTLC_DURATION_MS));
    const result = checkHtlcAdmissible(
      htlc,
      ctx({ perCounterpartyInflightValue: MAX_HTLC_VALUE_PER_COUNTERPARTY }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('per-counterparty');
  });

  it('rejects when expiry-now is below MIN_HTLC_DURATION', () => {
    const htlc = makeHtlc(100n, NOW_MS + BigInt(MIN_HTLC_DURATION_MS) - 1n);
    const result = checkHtlcAdmissible(htlc, ctx());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(String(MIN_HTLC_DURATION_MS));
  });

  it('rejects when expiry-now is above MAX_HTLC_DURATION', () => {
    const htlc = makeHtlc(100n, NOW_MS + BigInt(MAX_HTLC_DURATION_MS) + 1n);
    const result = checkHtlcAdmissible(htlc, ctx());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(String(MAX_HTLC_DURATION_MS));
  });

  it('accepts at the exact MIN/MAX boundaries', () => {
    const minHtlc = makeHtlc(100n, NOW_MS + BigInt(MIN_HTLC_DURATION_MS));
    const maxHtlc = makeHtlc(100n, NOW_MS + BigInt(MAX_HTLC_DURATION_MS));
    expect(checkHtlcAdmissible(minHtlc, ctx()).ok).toBe(true);
    expect(checkHtlcAdmissible(maxHtlc, ctx()).ok).toBe(true);
  });
});

describe('checkTimeoutDelta', () => {
  it('happy path: delta >= HTLC_TIMEOUT_DELTA_MS returns ok=true', () => {
    const inner = 1_000_000n;
    const outer = inner + BigInt(HTLC_TIMEOUT_DELTA_MS);
    const result = checkTimeoutDelta(outer, inner);
    expect(result.ok).toBe(true);
  });

  it('rejects when delta < HTLC_TIMEOUT_DELTA_MS', () => {
    const inner = 1_000_000n;
    const outer = inner + BigInt(HTLC_TIMEOUT_DELTA_MS) - 1n;
    const result = checkTimeoutDelta(outer, inner);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(String(HTLC_TIMEOUT_DELTA_MS));
  });

  it('rejects when outer < inner', () => {
    const result = checkTimeoutDelta(100n, 200n);
    expect(result.ok).toBe(false);
  });
});
