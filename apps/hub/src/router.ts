import type { ChannelId, Hex, Htlc } from '@tainnel/protocol';
import type { ChannelPool } from './channel-pool.js';
import type { LiquidityTracker } from './liquidity.js';
import type { PreimageRegistry } from './preimage-registry.js';

export interface RouteRequest {
  readonly fromChannel: ChannelId;
  readonly toChannel: ChannelId;
  readonly htlc: Htlc;
}

export interface RouteResult {
  readonly outgoingHtlc: Htlc;
  readonly preimage: Hex;
  readonly feePaid: bigint;
}

export class UnknownPaymentHashError extends Error {
  readonly code = 'unknown_payment_hash';
  constructor(paymentHash: Hex) {
    super(`no preimage registered for ${paymentHash}`);
  }
}

export class ChannelNotOpenError extends Error {
  readonly code = 'channel_not_open';
  constructor(channelId: ChannelId, status: string) {
    super(`channel ${channelId} status=${status} (expected open)`);
  }
}

export interface RouterDeps {
  readonly channelPool: ChannelPool;
  readonly preimages: PreimageRegistry;
  readonly liquidity: LiquidityTracker;
}

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  async route(req: RouteRequest): Promise<RouteResult> {
    const from = this.deps.channelPool.get(req.fromChannel);
    const to = this.deps.channelPool.get(req.toChannel);
    if (!from) throw new ChannelNotOpenError(req.fromChannel, 'unknown');
    if (from.status !== 'open') throw new ChannelNotOpenError(req.fromChannel, from.status);
    if (!to) throw new ChannelNotOpenError(req.toChannel, 'unknown');
    if (to.status !== 'open') throw new ChannelNotOpenError(req.toChannel, to.status);
    this.deps.liquidity.reserveOutbound(req.toChannel, req.htlc.amount);
    const preimage = this.deps.preimages.get(req.htlc.paymentHash);
    if (!preimage) {
      this.deps.liquidity.releaseReservation(req.toChannel, req.htlc.amount);
      throw new UnknownPaymentHashError(req.htlc.paymentHash);
    }
    return {
      outgoingHtlc: req.htlc,
      preimage,
      feePaid: 0n,
    };
  }
}
