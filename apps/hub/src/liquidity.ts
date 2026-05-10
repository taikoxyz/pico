import type { Address, ChannelId } from '@inferenceroom/pico-protocol';
import type { HtlcRepo } from './db/repos/index.js';

export interface LiquiditySnapshot {
  readonly inbound: bigint;
  readonly outbound: bigint;
}

export class InsufficientLiquidityError extends Error {
  readonly code = 'INSUFFICIENT_LIQUIDITY';
  constructor(channelId: ChannelId, requested: bigint, available: bigint) {
    super(`channel ${channelId} cannot reserve ${requested}; available outbound ${available}`);
    this.name = 'InsufficientLiquidityError';
  }
}

export class LiquidityTracker {
  private readonly state = new Map<ChannelId, LiquiditySnapshot>();
  private readonly reservations = new Map<ChannelId, bigint>();
  /**
   * USDC committed to a counterparty's not-yet-submitted top-up offer
   * (status `proposed` or `accepted`). Released on `rejected` / `expired`
   * / `submitted` (where the funds move into `submitted`). Drives the
   * hub's hot-wallet headroom check (§8.6).
   */
  private readonly committed = new Map<string, bigint>();
  /**
   * USDC committed to an in-flight `topUp(...)` tx (status `submitted`).
   * Released on `confirmed`. Tracked separately from `committed` so
   * crash recovery can distinguish reservations that need re-pushing
   * from reservations that just need the on-chain confirmation.
   */
  private readonly submitted = new Map<string, bigint>();

  set(channelId: ChannelId, snapshot: LiquiditySnapshot): void {
    this.state.set(channelId, snapshot);
  }

  get(channelId: ChannelId): LiquiditySnapshot | undefined {
    return this.state.get(channelId);
  }

  reservedOutbound(channelId: ChannelId): bigint {
    return this.reservations.get(channelId) ?? 0n;
  }

  availableOutbound(channelId: ChannelId): bigint {
    const snap = this.state.get(channelId);
    if (!snap) return 0n;
    return snap.outbound - this.reservedOutbound(channelId);
  }

  reserveOutbound(channelId: ChannelId, amount: bigint): void {
    if (amount <= 0n) return;
    const available = this.availableOutbound(channelId);
    if (available < amount) {
      throw new InsufficientLiquidityError(channelId, amount, available);
    }
    this.reservations.set(channelId, this.reservedOutbound(channelId) + amount);
  }

  releaseReservation(channelId: ChannelId, amount: bigint): void {
    if (amount <= 0n) return;
    const current = this.reservedOutbound(channelId);
    const next = current - amount;
    if (next <= 0n) {
      this.reservations.delete(channelId);
    } else {
      this.reservations.set(channelId, next);
    }
  }

  totalInbound(): bigint {
    let total = 0n;
    for (const snap of this.state.values()) total += snap.inbound;
    return total;
  }

  totalOutbound(): bigint {
    let total = 0n;
    for (const snap of this.state.values()) total += snap.outbound;
    return total;
  }

  totalReserved(): bigint {
    let total = 0n;
    for (const r of this.reservations.values()) total += r;
    return total;
  }

  // ───── Top-up accounting (§8) ─────

  /** USDC pre-committed to outstanding `proposed` / `accepted` offers for `addr`. */
  perCounterpartyCommitted(addr: Address): bigint {
    return this.committed.get(addr.toLowerCase()) ?? 0n;
  }

  /** USDC currently locked behind in-flight `topUp(...)` txs for `addr`. */
  perCounterpartySubmitted(addr: Address): bigint {
    return this.submitted.get(addr.toLowerCase()) ?? 0n;
  }

  /** Sum of hub-side balances across all open channels with `addr` as counterparty. */
  perCounterpartyOutbound(
    addr: Address,
    hubAddress: Address,
    walkChannels: ReadonlyMap<ChannelId, { userA: Address; userB: Address }>,
  ): bigint {
    const target = addr.toLowerCase();
    const hub = hubAddress.toLowerCase();
    let total = 0n;
    for (const [chId, ch] of walkChannels) {
      const a = ch.userA.toLowerCase();
      const b = ch.userB.toLowerCase();
      const isHubChannelWithAddr = (a === hub && b === target) || (b === hub && a === target);
      if (!isHubChannelWithAddr) continue;
      const snap = this.state.get(chId);
      if (snap) total += snap.outbound;
    }
    return total;
  }

  /** Sum of all `committed` reservations across counterparties. */
  totalCommitted(): bigint {
    let total = 0n;
    for (const v of this.committed.values()) total += v;
    return total;
  }

  /** Sum of all `submitted` reservations across counterparties. */
  totalSubmitted(): bigint {
    let total = 0n;
    for (const v of this.submitted.values()) total += v;
    return total;
  }

  /**
   * Headroom = totalUsdcInWallet − (committed + submitted). Anything
   * `committed` is already promised to a user; anything `submitted` is
   * already in flight as an on-chain `topUp(...)` and counts against the
   * hub's spendable balance until the receipt arrives.
   */
  hotWalletHeadroom(totalUsdcInWallet: bigint): bigint {
    return totalUsdcInWallet - this.totalCommitted() - this.totalSubmitted();
  }

  noteCommit(addr: Address, amount: bigint): void {
    if (amount <= 0n) return;
    const k = addr.toLowerCase();
    this.committed.set(k, (this.committed.get(k) ?? 0n) + amount);
  }

  releaseCommit(addr: Address, amount: bigint): void {
    if (amount <= 0n) return;
    const k = addr.toLowerCase();
    const cur = this.committed.get(k) ?? 0n;
    const next = cur - amount;
    if (next <= 0n) this.committed.delete(k);
    else this.committed.set(k, next);
  }

  noteSubmitted(addr: Address, amount: bigint): void {
    if (amount <= 0n) return;
    const k = addr.toLowerCase();
    this.submitted.set(k, (this.submitted.get(k) ?? 0n) + amount);
  }

  releaseSubmitted(addr: Address, amount: bigint): void {
    if (amount <= 0n) return;
    const k = addr.toLowerCase();
    const cur = this.submitted.get(k) ?? 0n;
    const next = cur - amount;
    if (next <= 0n) this.submitted.delete(k);
    else this.submitted.set(k, next);
  }

  async hydrate(htlcRepo: HtlcRepo): Promise<void> {
    this.reservations.clear();
    const inflight = await htlcRepo.listInflight();
    for (const r of inflight) {
      if (!r.outgoingChannelId) continue;
      if (r.channelId !== r.outgoingChannelId) continue;
      const cur = this.reservations.get(r.outgoingChannelId) ?? 0n;
      this.reservations.set(r.outgoingChannelId, cur + r.htlc.amount);
    }
  }
}
