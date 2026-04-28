import type { Channel, ChannelId, Hex, SignedState } from '@tainnel/protocol';

export function serializeSignedState(s: SignedState): string {
  return JSON.stringify({
    state: {
      channelId: s.state.channelId,
      version: s.state.version.toString(),
      balanceA: s.state.balanceA.toString(),
      balanceB: s.state.balanceB.toString(),
      finalized: s.state.finalized,
      htlcs: s.state.htlcs.map((h) => ({
        id: h.id,
        direction: h.direction,
        amount: h.amount.toString(),
        paymentHash: h.paymentHash,
        expiryMs: h.expiryMs.toString(),
      })),
    },
    sigA: s.sigA,
    sigB: s.sigB,
  });
}

export function deserializeSignedState(json: string): SignedState {
  const p = JSON.parse(json) as {
    state: {
      channelId: Hex;
      version: string;
      balanceA: string;
      balanceB: string;
      finalized: boolean;
      htlcs: Array<{
        id: Hex;
        direction: 'AtoB' | 'BtoA';
        amount: string;
        paymentHash: Hex;
        expiryMs: string;
      }>;
    };
    sigA: SignedState['sigA'];
    sigB: SignedState['sigB'];
  };
  return {
    state: {
      channelId: p.state.channelId,
      version: BigInt(p.state.version),
      balanceA: BigInt(p.state.balanceA),
      balanceB: BigInt(p.state.balanceB),
      finalized: p.state.finalized,
      htlcs: p.state.htlcs.map((h) => ({
        id: h.id,
        direction: h.direction,
        amount: BigInt(h.amount),
        paymentHash: h.paymentHash,
        expiryMs: BigInt(h.expiryMs),
      })),
    },
    sigA: p.sigA,
    sigB: p.sigB,
  };
}

export function channelToRow(c: Channel): {
  id: string;
  chain_id: number;
  contract: string;
  user_a: string;
  user_b: string;
  token: string;
  status: string;
  opened_at: string;
  dispute_window_ms: number;
} {
  return {
    id: c.id,
    chain_id: c.chainId,
    contract: c.contract,
    user_a: c.userA,
    user_b: c.userB,
    token: c.token,
    status: c.status,
    opened_at: c.openedAt.toString(),
    dispute_window_ms: c.disputeWindowMs,
  };
}

export function rowToChannel(r: {
  id: string;
  chain_id: number;
  contract: string;
  user_a: string;
  user_b: string;
  token: string;
  status: string;
  opened_at: string;
  dispute_window_ms: number;
}): Channel {
  return {
    id: r.id as ChannelId,
    chainId: r.chain_id as Channel['chainId'],
    contract: r.contract as Channel['contract'],
    userA: r.user_a as Channel['userA'],
    userB: r.user_b as Channel['userB'],
    token: r.token as Channel['token'],
    status: r.status as Channel['status'],
    openedAt: BigInt(r.opened_at),
    disputeWindowMs: r.dispute_window_ms,
  };
}
