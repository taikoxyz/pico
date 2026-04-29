import type { ChannelId } from '@tainnel/protocol';
import { describe, expect, it } from 'vitest';
import { InsufficientLiquidityError, LiquidityTracker } from './liquidity.js';

const cid = `0x${'a'.repeat(64)}`;

describe('LiquidityTracker', () => {
  it('tracks set + reserve + release', () => {
    const t = new LiquidityTracker();
    t.set(cid as ChannelId, { inbound: 0n, outbound: 100n });
    expect(t.availableOutbound(cid as ChannelId)).toBe(100n);
    t.reserveOutbound(cid as ChannelId, 30n);
    expect(t.availableOutbound(cid as ChannelId)).toBe(70n);
    t.releaseReservation(cid as ChannelId, 30n);
    expect(t.availableOutbound(cid as ChannelId)).toBe(100n);
  });

  it('throws when reserve exceeds available', () => {
    const t = new LiquidityTracker();
    t.set(cid as ChannelId, { inbound: 0n, outbound: 50n });
    t.reserveOutbound(cid as ChannelId, 30n);
    expect(() => t.reserveOutbound(cid as ChannelId, 25n)).toThrow(InsufficientLiquidityError);
  });

  it('release floor at zero', () => {
    const t = new LiquidityTracker();
    t.set(cid as ChannelId, { inbound: 0n, outbound: 50n });
    t.releaseReservation(cid as ChannelId, 999n);
    expect(t.availableOutbound(cid as ChannelId)).toBe(50n);
  });
});
