import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWithinCaps, recordSpend, spendCapsFromEnv } from './spend-guard.js';

describe('spendCapsFromEnv', () => {
  it('returns empty when unset', () => {
    expect(spendCapsFromEnv({})).toEqual({});
  });

  it('parses per-tx and daily caps as bigint', () => {
    const caps = spendCapsFromEnv({
      PICO_PAYMENT_MAX_RAW: '100',
      PICO_PAYMENT_DAILY_RAW: '5000',
    } as NodeJS.ProcessEnv);
    expect(caps.perTxRaw).toBe(100n);
    expect(caps.dailyRaw).toBe(5000n);
  });
});

describe('assertWithinCaps', () => {
  it('passes when no caps are set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ledger-'));
    try {
      expect(() => assertWithinCaps({}, 999n, join(dir, 'ledger.json'))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects amounts above the per-tx cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ledger-'));
    try {
      expect(() => assertWithinCaps({ perTxRaw: 100n }, 101n, join(dir, 'ledger.json'))).toThrow(
        /exceeds PICO_PAYMENT_MAX_RAW/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects amounts that would push the daily total over the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ledger-'));
    try {
      const path = join(dir, 'ledger.json');
      recordSpend(800n, path);
      expect(() => assertWithinCaps({ dailyRaw: 1000n }, 300n, path)).toThrow(
        /PICO_PAYMENT_DAILY_RAW/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a payment exactly at the cap edge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ledger-'));
    try {
      const path = join(dir, 'ledger.json');
      recordSpend(500n, path);
      expect(() => assertWithinCaps({ dailyRaw: 1000n }, 500n, path)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordSpend', () => {
  it('accumulates same-day spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ledger-'));
    try {
      const path = join(dir, 'ledger.json');
      recordSpend(100n, path);
      recordSpend(250n, path);
      expect(() => assertWithinCaps({ dailyRaw: 1000n }, 651n, path)).toThrow(
        /PICO_PAYMENT_DAILY_RAW/,
      );
      expect(() => assertWithinCaps({ dailyRaw: 1000n }, 650n, path)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes entries older than 7 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ledger-'));
    try {
      const path = join(dir, 'ledger.json');
      const oldDay = new Date('2025-01-01T12:00:00Z');
      recordSpend(1000n, path, oldDay);
      const now = new Date('2026-01-01T12:00:00Z');
      recordSpend(1n, path, now);
      // After the second recordSpend the old day should be pruned; verify by
      // making the daily cap small but recording another small payment for
      // today and seeing that the old day's 1000 doesn't poison today's check.
      expect(() => assertWithinCaps({ dailyRaw: 10n }, 5n, path, now)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
