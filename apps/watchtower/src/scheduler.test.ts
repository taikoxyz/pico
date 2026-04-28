import type { ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FraudDetector } from './detector.js';
import { logger } from './logger.js';
import { WatchtowerMetrics } from './metrics.js';
import { PenaltyScheduler } from './scheduler.js';
import { ObservationRepo, type SqliteHandle, openSqlite } from './storage.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000777' as ChannelId;

function makeSignedState(version: bigint): SignedState {
  return {
    state: {
      channelId,
      version,
      balanceA: 0n,
      balanceB: 0n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: '0x' as Hex, s: '0x' as Hex, v: 27 },
    sigB: { r: '0x' as Hex, s: '0x' as Hex, v: 27 },
  };
}

describe('PenaltyScheduler', () => {
  let handle: SqliteHandle;
  let repo: ObservationRepo;
  let detector: FraudDetector;
  let metrics: WatchtowerMetrics;
  let calls: Array<{ channelId: ChannelId; version: bigint }>;
  let responder: { submitPenalty: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    handle = openSqlite(':memory:');
    repo = new ObservationRepo(handle.raw);
    detector = new FraudDetector();
    metrics = new WatchtowerMetrics();
    calls = [];
    responder = {
      submitPenalty: vi.fn(async (id: ChannelId, evidence: SignedState) => {
        calls.push({ channelId: id, version: evidence.state.version });
        return `0x${'aa'.repeat(32)}` as Hex;
      }),
    };
  });

  afterEach(() => {
    handle.close();
    vi.useRealTimers();
  });

  it('runs catchup on start and submits pending observations', async () => {
    detector.remember(makeSignedState(10n));
    repo.record({
      channelId,
      postedVersion: 5n,
      postedAt: 0,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      submitBy: 0,
    });
    const scheduler = new PenaltyScheduler({
      observationRepo: repo,
      detector,
      responder: responder as never,
      metrics,
      logger,
      intervalMs: 10_000,
    });
    await scheduler.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.version).toBe(10n);
    const obs = repo.get(channelId);
    expect(obs?.txHash).toBeDefined();
    expect(metrics.get('penaltiesSubmittedTotal')).toBe(1);
    scheduler.stop();
  });

  it('skips observations with no detector evidence', async () => {
    repo.record({
      channelId,
      postedVersion: 5n,
      postedAt: 0,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      submitBy: 0,
    });
    const scheduler = new PenaltyScheduler({
      observationRepo: repo,
      detector,
      responder: responder as never,
      logger,
      intervalMs: 10_000,
    });
    await scheduler.start();
    expect(calls).toHaveLength(0);
    scheduler.stop();
  });

  it('triggers tick on interval', async () => {
    vi.useFakeTimers();
    detector.remember(makeSignedState(10n));
    const scheduler = new PenaltyScheduler({
      observationRepo: repo,
      detector,
      responder: responder as never,
      logger,
      intervalMs: 1_000,
    });
    await scheduler.start();
    expect(calls).toHaveLength(0);
    repo.record({
      channelId,
      postedVersion: 5n,
      postedAt: 0,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      submitBy: 0,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });
});
