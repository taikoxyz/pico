import type { ChannelId, Htlc } from '@tainnel/protocol';

export interface RouteRequest {
  readonly fromChannel: ChannelId;
  readonly toChannel: ChannelId;
  readonly htlc: Htlc;
}

export interface RouteResult {
  readonly outgoingHtlc: Htlc;
  readonly feePaid: bigint;
}

export class Router {
  async route(_req: RouteRequest): Promise<RouteResult> {
    throw new Error('not implemented');
  }
}
