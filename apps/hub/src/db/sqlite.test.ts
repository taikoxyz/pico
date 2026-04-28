import type { Channel, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, buildRepos } from './index.js';
import { applyMigrations } from './migrations.js';

const channelA = '0x0000000000000000000000000000000000000000000000000000000000000aaa' as ChannelId;
const channelB = '0x0000000000000000000000000000000000000000000000000000000000000bbb' as ChannelId;
const userA = '0x1111111111111111111111111111111111111111' as Channel['userA'];
const userB = '0x2222222222222222222222222222222222222222' as Channel['userB'];
const token = '0x3333333333333333333333333333333333333333' as Channel['token'];
const contract = '0x4444444444444444444444444444444444444444' as Channel['contract'];

function makeChannel(id: ChannelId, status: Channel['status'] = 'open'): Channel {
  return {
    id,
    chainId: TAIKO_MAINNET_CHAIN_ID,
    contract,
    userA,
    userB,
    token,
    status,
    openedAt: 100n,
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
}

function makeSignedState(channelId: ChannelId, version: bigint): SignedState {
  return {
    state: {
      channelId,
      version,
      balanceA: 100n,
      balanceB: 200n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: '0xaa' as Hex, s: '0xbb' as Hex, v: 27 },
    sigB: { r: '0xcc' as Hex, s: '0xdd' as Hex, v: 28 },
  };
}

describe('SqliteDatabase + migrations', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = new SqliteDatabase(':memory:');
    await db.ready();
  });

  afterEach(async () => {
    await db.close();
  });

  it('applies migrations idempotently', () => {
    applyMigrations(db.raw());
    applyMigrations(db.raw());
    const rows = db.raw().prepare('SELECT version FROM _schema_migrations').all() as Array<{
      version: number;
    }>;
    expect(rows).toHaveLength(1);
  });
});

describe('repos round-trip', () => {
  let db: SqliteDatabase;
  let repos: ReturnType<typeof buildRepos>;

  beforeEach(async () => {
    db = new SqliteDatabase(':memory:');
    await db.ready();
    repos = buildRepos(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('ChannelRepo upsert/get/list/setStatus', () => {
    repos.channels.upsert(makeChannel(channelA));
    repos.channels.upsert(makeChannel(channelB, 'pending'));
    expect(repos.channels.get(channelA)?.status).toBe('open');
    expect(repos.channels.list()).toHaveLength(2);
    repos.channels.setStatus(channelA, 'closed');
    expect(repos.channels.get(channelA)?.status).toBe('closed');
  });

  it('StateRepo record/latest/list', () => {
    repos.states.record(channelA, makeSignedState(channelA, 1n));
    repos.states.record(channelA, makeSignedState(channelA, 5n));
    repos.states.record(channelA, makeSignedState(channelA, 3n));
    expect(repos.states.latest(channelA)?.state.version).toBe(5n);
    expect(repos.states.list(channelA)).toHaveLength(3);
  });

  it('HtlcRepo upsert + status transitions', () => {
    repos.htlcs.upsert({
      id: '0xdead' as Hex,
      channelId: channelA,
      paymentHash: '0xbeef' as Hex,
      amount: 100n,
      expiryMs: 1_000n,
      direction: 'AtoB',
      status: 'pending',
      createdAt: 1,
    });
    expect(repos.htlcs.pendingByChannel(channelA)).toHaveLength(1);
    repos.htlcs.setStatus('0xdead' as Hex, 'settled', '0xff' as Hex);
    expect(repos.htlcs.get('0xdead' as Hex)?.status).toBe('settled');
    expect(repos.htlcs.get('0xdead' as Hex)?.settledPreimage).toBe('0xff');
    expect(repos.htlcs.pendingByChannel(channelA)).toHaveLength(0);
  });

  it('PaymentRepo start/complete/fail', () => {
    repos.payments.start({
      id: '0xpay' as Hex,
      sourceChannel: channelA,
      amount: 100n,
      paymentHash: '0xbeef' as Hex,
    });
    expect(repos.payments.get('0xpay' as Hex)?.status).toBe('pending');
    repos.payments.complete('0xpay' as Hex, 1n);
    expect(repos.payments.get('0xpay' as Hex)?.status).toBe('settled');
    expect(repos.payments.byPaymentHash('0xbeef' as Hex)?.id).toBe('0xpay');
  });

  it('NonceRepo seenWithin24h', () => {
    expect(repos.nonces.seenWithin24h('abc')).toBe(false);
    repos.nonces.record('abc', '0x1');
    expect(repos.nonces.seenWithin24h('abc')).toBe(true);
  });

  it('DisputeRepo record/markResponded', () => {
    repos.disputes.record({
      channelId: channelA,
      attackerVersion: 1n,
      ourVersion: 2n,
      observedAt: 100,
    });
    expect(repos.disputes.get(channelA)?.ourVersion).toBe(2n);
    repos.disputes.markResponded(channelA, '0xtx' as Hex, 200);
  });
});
