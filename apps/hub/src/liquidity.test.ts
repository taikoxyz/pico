import type { Htlc } from '@inferenceroom/pico-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { InsufficientLiquidityError, LiquidityTracker } from './liquidity.js';

describe('LiquidityTracker', () => {
  it('tracks reservations against outbound capacity', () => {
    const t = new LiquidityTracker();
    t.set('0xaa', { inbound: 0n, outbound: 100n });
    t.reserveOutbound('0xaa', 30n);
    expect(t.availableOutbound('0xaa')).toBe(70n);
    t.releaseReservation('0xaa', 30n);
    expect(t.availableOutbound('0xaa')).toBe(100n);
  });

  it('rejects over-reservation', () => {
    const t = new LiquidityTracker();
    t.set('0xaa', { inbound: 0n, outbound: 50n });
    t.reserveOutbound('0xaa', 40n);
    expect(() => t.reserveOutbound('0xaa', 20n)).toThrow(InsufficientLiquidityError);
  });

  it('release with overshoot clears the reservation', () => {
    const t = new LiquidityTracker();
    t.set('0xaa', { inbound: 0n, outbound: 100n });
    t.reserveOutbound('0xaa', 40n);
    t.releaseReservation('0xaa', 100n);
    expect(t.reservedOutbound('0xaa')).toBe(0n);
  });

  it('totals across channels', () => {
    const t = new LiquidityTracker();
    t.set('0xaa', { inbound: 10n, outbound: 100n });
    t.set('0xbb', { inbound: 20n, outbound: 200n });
    expect(t.totalInbound()).toBe(30n);
    expect(t.totalOutbound()).toBe(300n);
  });
});

describe('LiquidityTracker.hydrate', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('restores reservations from in-flight HTLCs', async () => {
    const htlc: Htlc = {
      id: '0x01',
      direction: 'AtoB',
      amount: 50n,
      paymentHash: '0xph',
      expiryMs: 0n,
    };
    await h.repos.htlcs.save({
      htlc,
      channelId: '0xaa',
      state: 'inflight',
      outgoingChannelId: '0xaa',
    });
    const t = new LiquidityTracker();
    t.set('0xaa', { inbound: 0n, outbound: 100n });
    await t.hydrate(h.repos.htlcs);
    expect(t.reservedOutbound('0xaa')).toBe(50n);
  });

  it('skips HTLCs without an outgoing channel', async () => {
    const htlc: Htlc = {
      id: '0x02',
      direction: 'AtoB',
      amount: 10n,
      paymentHash: '0xph',
      expiryMs: 0n,
    };
    await h.repos.htlcs.save({ htlc, channelId: '0xaa', state: 'inflight' });
    const t = new LiquidityTracker();
    await t.hydrate(h.repos.htlcs);
    expect(t.totalReserved()).toBe(0n);
  });

  it('counts each multi-hop payment only once (no double-count of incoming + outgoing legs)', async () => {
    const incoming: Htlc = {
      id: '0xa1',
      direction: 'AtoB',
      amount: 100n,
      paymentHash: '0xph',
      expiryMs: 0n,
    };
    const outgoing: Htlc = {
      id: '0xb1',
      direction: 'AtoB',
      amount: 99n,
      paymentHash: '0xph',
      expiryMs: 0n,
    };
    await h.repos.htlcs.save({
      htlc: incoming,
      channelId: '0xin',
      state: 'inflight',
      incomingChannelId: '0xin',
      outgoingChannelId: '0xout',
    });
    await h.repos.htlcs.save({
      htlc: outgoing,
      channelId: '0xout',
      state: 'inflight',
      incomingChannelId: '0xin',
      outgoingChannelId: '0xout',
    });
    const t = new LiquidityTracker();
    t.set('0xout', { inbound: 0n, outbound: 1000n });
    await t.hydrate(h.repos.htlcs);
    expect(t.reservedOutbound('0xout')).toBe(99n);
  });
});
