import type {
  Address,
  ChannelId,
  ChannelState,
  Hex,
  Signature,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';
import type { TopUpOfferRow } from './topup-offer-repo.js';

const ZERO_SIG: Signature = {
  r: `0x${'00'.repeat(32)}` as Hex,
  s: `0x${'00'.repeat(32)}` as Hex,
  v: 27,
};

const ZERO_HEX_65: Hex = `0x${'00'.repeat(65)}` as Hex;

function offerId(suffix: string): Hex {
  return `0x${suffix.padStart(64, '0')}` as Hex;
}

function makeState(channelId: ChannelId, version: bigint): ChannelState {
  return {
    channelId,
    version,
    balanceA: 10_000_000n,
    balanceB: 5_000_000n,
    htlcs: [],
    finalized: false,
  };
}

function makeRow(args: Partial<TopUpOfferRow> = {}): TopUpOfferRow {
  const channelId = (args.channelId ?? '0xaa') as ChannelId;
  const newState = args.newState ?? makeState(channelId, 1n);
  const now = Date.now();
  return {
    offerId: args.offerId ?? offerId('1'),
    channelId,
    counterparty: (args.counterparty ?? '0x000000000000000000000000000000000000B0B0') as Address,
    amount: args.amount ?? 5_000_000n,
    prevVersion: args.prevVersion ?? 0n,
    newVersion: args.newVersion ?? 1n,
    newState,
    hubSigPrev: args.hubSigPrev ?? ZERO_HEX_65,
    hubSigNew: args.hubSigNew ?? ZERO_HEX_65,
    validUntilSec: args.validUntilSec ?? BigInt(Math.floor(Date.now() / 1000) + 600),
    status: args.status ?? 'queued',
    priority: args.priority ?? 0,
    queuedAt: args.queuedAt ?? now,
    createdAt: args.createdAt ?? now,
    updatedAt: args.updatedAt ?? now,
    ...(args.submittedTxHash !== undefined ? { submittedTxHash: args.submittedTxHash } : {}),
    ...(args.userSignedNewState !== undefined
      ? { userSignedNewState: args.userSignedNewState }
      : {}),
    ...(args.rejectReason !== undefined ? { rejectReason: args.rejectReason } : {}),
  };
}

describe('TopUpOfferRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('inserts and retrieves an offer round-trip', async () => {
    const row = makeRow({ offerId: offerId('1'), amount: 7_000_000n, status: 'proposed' });
    await h.repos.topupOffers.insert(row);
    const got = await h.repos.topupOffers.get(row.offerId);
    expect(got?.offerId).toBe(row.offerId);
    expect(got?.amount).toBe(7_000_000n);
    expect(got?.status).toBe('proposed');
    expect(got?.newState.version).toBe(1n);
    expect(got?.newState.balanceA).toBe(10_000_000n);
  });

  it('updates status / submittedTxHash / userSignedNewState', async () => {
    const row = makeRow({ offerId: offerId('2') });
    await h.repos.topupOffers.insert(row);
    const userSigned: SignedState = {
      state: row.newState,
      sigA: ZERO_SIG,
      sigB: ZERO_SIG,
    };
    await h.repos.topupOffers.update(row.offerId, {
      status: 'submitted',
      submittedTxHash: '0xfeed' as Hex,
      userSignedNewState: userSigned,
    });
    const got = await h.repos.topupOffers.get(row.offerId);
    expect(got?.status).toBe('submitted');
    expect(got?.submittedTxHash).toBe('0xfeed');
    expect(got?.userSignedNewState?.state.version).toBe(1n);
  });

  it('listByStatus returns only matching rows', async () => {
    await h.repos.topupOffers.insert(makeRow({ offerId: offerId('3'), status: 'queued' }));
    await h.repos.topupOffers.insert(makeRow({ offerId: offerId('4'), status: 'queued' }));
    await h.repos.topupOffers.insert(makeRow({ offerId: offerId('5'), status: 'proposed' }));
    const queued = await h.repos.topupOffers.listByStatus('queued');
    expect(queued).toHaveLength(2);
    expect(queued.map((r) => r.offerId).sort()).toEqual([offerId('3'), offerId('4')].sort());
    const proposed = await h.repos.topupOffers.listByStatus('proposed');
    expect(proposed).toHaveLength(1);
  });

  it('listQueued orders by priority DESC, queued_at ASC', async () => {
    const t = Date.now();
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('6'), status: 'queued', priority: 0, queuedAt: t }),
    );
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('7'), status: 'queued', priority: 5, queuedAt: t + 1000 }),
    );
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('8'), status: 'queued', priority: 0, queuedAt: t - 1000 }),
    );
    const q = await h.repos.topupOffers.listQueued();
    // Priority 5 first; then priority 0 in queued_at ASC order.
    expect(q.map((r) => r.offerId)).toEqual([offerId('7'), offerId('8'), offerId('6')]);
  });

  it('listByCounterparty filters by address and optional statuses', async () => {
    const bob = '0x000000000000000000000000000000000000B0B0' as Address;
    const carol = '0x000000000000000000000000000000000000C0C0' as Address;
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('9'), counterparty: bob, status: 'proposed' }),
    );
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('a'), counterparty: bob, status: 'rejected' }),
    );
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('b'), counterparty: carol, status: 'proposed' }),
    );
    const all = await h.repos.topupOffers.listByCounterparty(bob);
    expect(all).toHaveLength(2);
    const onlyProposed = await h.repos.topupOffers.listByCounterparty(bob, ['proposed']);
    expect(onlyProposed).toHaveLength(1);
    expect(onlyProposed[0]?.offerId).toBe(offerId('9'));
  });

  it('listByChannel filters by channelId', async () => {
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('c'), channelId: '0xaa' as ChannelId }),
    );
    await h.repos.topupOffers.insert(
      makeRow({ offerId: offerId('d'), channelId: '0xbb' as ChannelId }),
    );
    const a = await h.repos.topupOffers.listByChannel('0xaa' as ChannelId);
    expect(a).toHaveLength(1);
    expect(a[0]?.offerId).toBe(offerId('c'));
  });
});
