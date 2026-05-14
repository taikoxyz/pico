import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  ChannelState,
  Htlc,
  HtlcId,
  PaymentHash,
  Preimage,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { MAX_HTLC_VALUE_PER_COUNTERPARTY } from '@inferenceroom/pico-protocol';
import { hexToSignature, randomHtlcId } from '@inferenceroom/pico-sdk';
import {
  type HtlcAdmissionContext,
  addHtlc,
  buildChannelStateTypedData,
  checkHtlcAdmissible,
  checkTimeoutDelta,
  failHtlc,
  settleHtlc,
} from '@inferenceroom/pico-state-machine';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { ChannelPool } from './channel-pool.js';
import type { Repos } from './db/repos/index.js';
import type { FeePolicy } from './fee-policy.js';
import type { Logger } from './logger.js';

// Default outer-vs-inner expiry buffer. Per §4.3, T_outer − T_inner ≥
// HTLC_TIMEOUT_DELTA_MS (30 min) so the hub can claim from the sender after
// settling with the receiver. Mirroring the protocol default keeps router
// admission consistent with the state-machine `checkTimeoutDelta` helper.
const DEFAULT_EXPIRY_BUFFER_MS = 30n * 60n * 1000n;

export interface RouteRequest {
  readonly incomingChannel: Channel;
  readonly incomingSignedState: SignedState;
  readonly incomingHtlc: Htlc;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly paymentHash: PaymentHash;
}

export interface RouteResult {
  readonly outgoingChannel: Channel;
  readonly outgoingHtlc: Htlc;
  readonly outgoingHubSigned: SignedState;
  readonly fee: bigint;
}

export interface InflightHtlc {
  readonly incomingChannelId: ChannelId;
  readonly incomingHtlcId: HtlcId;
  readonly incomingSignedState: SignedState;
  readonly incomingSenderAddress: Address;
  readonly outgoingChannelId: ChannelId;
  readonly outgoingHtlcId: HtlcId;
  readonly outgoingHtlc: Htlc;
  readonly outgoingHubSigned: SignedState;
  readonly recipient: Address;
}

export interface RouterDeps {
  readonly channelPool: ChannelPool;
  readonly feePolicy: FeePolicy;
  readonly hubAccount: PrivateKeyAccount;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly expiryBufferMs?: bigint;
  readonly logger: Logger;
}

export class Router {
  private readonly inflightByOutgoingId = new Map<HtlcId, InflightHtlc>();
  private readonly inflightByIncomingId = new Map<HtlcId, InflightHtlc>();
  private readonly expiryBufferMs: bigint;

  constructor(private readonly deps: RouterDeps) {
    this.expiryBufferMs = deps.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const hubAddr = this.deps.hubAccount.address;
    const outgoingChannel = this.findChannelBetween(hubAddr, req.recipient);
    if (!outgoingChannel) {
      throw new Error(`router: no channel between hub and ${req.recipient}`);
    }
    if (outgoingChannel.id === req.incomingChannel.id) {
      throw new Error('router: incoming and outgoing channel are the same');
    }

    const fee = this.deps.feePolicy.quote(req.amount);
    const outgoingAmount = req.amount - fee;
    if (outgoingAmount <= 0n) {
      throw new Error(`router: amount ${req.amount} <= fee ${fee}`);
    }

    const outgoingExpiry = req.incomingHtlc.expiryMs - this.expiryBufferMs;
    if (outgoingExpiry <= BigInt(Date.now())) {
      throw new Error('router: outgoing expiry would already be in the past');
    }

    const hubIsAOnOutgoing = outgoingChannel.userA.toLowerCase() === hubAddr.toLowerCase();
    const outgoingHtlc: Htlc = {
      id: randomHtlcId(),
      direction: hubIsAOnOutgoing ? 'AtoB' : 'BtoA',
      amount: outgoingAmount,
      paymentHash: req.paymentHash,
      expiryMs: outgoingExpiry,
    };

    const latestOutgoing = this.deps.channelPool.latest(outgoingChannel.id);
    if (!latestOutgoing) {
      throw new Error(`router: no signed state for outgoing channel ${outgoingChannel.id}`);
    }

    const hubBalance = hubIsAOnOutgoing
      ? latestOutgoing.state.balanceA
      : latestOutgoing.state.balanceB;
    if (hubBalance < outgoingAmount) {
      throw new Error(
        `router: hub liquidity ${hubBalance} < outgoing amount ${outgoingAmount} on ${outgoingChannel.id}`,
      );
    }

    // §4.3 admission caps. The state-machine helpers encode the protocol
    // defaults (count cap, per-channel value cap, per-counterparty value
    // cap, duration bounds, outer-vs-inner timeout delta). We construct the
    // context against the latest in-pool state plus any in-flight HTLCs we
    // have routed but not yet settled.
    const counterparty = hubIsAOnOutgoing ? outgoingChannel.userB : outgoingChannel.userA;
    const admissionCtx: HtlcAdmissionContext = {
      currentHtlcCount:
        latestOutgoing.state.htlcs.length + this.countPendingOnChannel(outgoingChannel.id),
      perChannelInflightValue:
        sumHtlcAmounts(latestOutgoing.state.htlcs) + this.sumPendingOnChannel(outgoingChannel.id),
      perCounterpartyInflightValue: this.sumInflightToCounterparty(counterparty),
      maxPerChannelValue: this.maxPerChannelValueFor(outgoingChannel),
      maxPerCounterpartyValue: this.maxPerCounterpartyValueFor(outgoingChannel.token),
      nowMs: BigInt(Date.now()),
    };
    const admit = checkHtlcAdmissible(outgoingHtlc, admissionCtx);
    if (!admit.ok) {
      throw new Error(`router: ${admit.reason}`);
    }
    const timing = checkTimeoutDelta(req.incomingHtlc.expiryMs, outgoingExpiry);
    if (!timing.ok) {
      throw new Error(`router: ${timing.reason}`);
    }

    const lockedState = addHtlc(latestOutgoing.state, outgoingHtlc);
    const newState: ChannelState = { ...lockedState, version: lockedState.version + 1n };
    const sigHex = await this.deps.hubAccount.signTypedData(
      buildChannelStateTypedData(newState, this.deps.chainId, this.deps.verifyingContract),
    );
    const sig = hexToSignature(sigHex);
    const outgoingHubSigned: SignedState = {
      state: newState,
      sigA: hubIsAOnOutgoing ? sig : latestOutgoing.sigA,
      sigB: hubIsAOnOutgoing ? latestOutgoing.sigB : sig,
    };

    return { outgoingChannel, outgoingHtlc, outgoingHubSigned, fee };
  }

  recordInflight(item: InflightHtlc): void {
    this.inflightByIncomingId.set(item.incomingHtlcId, item);
    this.inflightByOutgoingId.set(item.outgoingHtlcId, item);
  }

  /**
   * Rebuilds in-memory inflight maps from durable payment_routes rows.
   * Called on hub startup so that settle/fail messages for HTLCs that were
   * in flight before a crash can still be processed.
   */
  async hydrate(repos: Repos): Promise<void> {
    const rows = await repos.routes.loadInflight();
    for (const row of rows) {
      const item: InflightHtlc = {
        incomingChannelId: row.incomingChannelId,
        incomingHtlcId: row.incomingHtlcId,
        incomingSignedState: row.incomingSignedState,
        incomingSenderAddress: row.sender,
        outgoingChannelId: row.outgoingChannelId,
        outgoingHtlcId: row.outgoingHtlcId,
        outgoingHtlc: row.outgoingHtlc,
        outgoingHubSigned: row.outgoingHubSigned,
        recipient: row.recipient,
      };
      this.inflightByIncomingId.set(item.incomingHtlcId, item);
      this.inflightByOutgoingId.set(item.outgoingHtlcId, item);
    }
    this.deps.logger.info({ rehydrated: rows.length }, 'router: hydrated inflight routes from db');
  }

  pendingForRecipient(recipient: Address): readonly InflightHtlc[] {
    const lower = recipient.toLowerCase();
    return Array.from(this.inflightByOutgoingId.values()).filter(
      (i) => i.recipient.toLowerCase() === lower,
    );
  }

  /** Look up an inflight entry without removing it. */
  peekByOutgoingId(outgoingHtlcId: HtlcId): InflightHtlc | undefined {
    return this.inflightByOutgoingId.get(outgoingHtlcId);
  }

  /** Remove and return an inflight entry. Use only after validation has passed. */
  takeByOutgoingId(outgoingHtlcId: HtlcId): InflightHtlc | undefined {
    const item = this.inflightByOutgoingId.get(outgoingHtlcId);
    if (!item) return undefined;
    this.inflightByOutgoingId.delete(outgoingHtlcId);
    this.inflightByIncomingId.delete(item.incomingHtlcId);
    return item;
  }

  async settleIncoming(
    incoming: InflightHtlc,
    preimage: Preimage,
    bobSettledOutgoingState: SignedState,
  ): Promise<SignedState> {
    const incomingChannel = this.deps.channelPool.get(incoming.incomingChannelId);
    if (!incomingChannel) {
      throw new Error(`router: lost incoming channel ${incoming.incomingChannelId}`);
    }
    await this.deps.channelPool.recordState(incoming.outgoingChannelId, bobSettledOutgoingState);

    const settled = settleHtlc(
      incoming.incomingSignedState.state,
      incoming.incomingHtlcId,
      preimage,
    );
    return this.signOnIncomingChannel(incoming, settled, incomingChannel);
  }

  async failIncoming(
    incoming: InflightHtlc,
    recipientFailedOutgoingState: SignedState,
  ): Promise<SignedState> {
    const incomingChannel = this.deps.channelPool.get(incoming.incomingChannelId);
    if (!incomingChannel) {
      throw new Error(`router: lost incoming channel ${incoming.incomingChannelId}`);
    }
    await this.deps.channelPool.recordState(
      incoming.outgoingChannelId,
      recipientFailedOutgoingState,
    );

    const failed = failHtlc(incoming.incomingSignedState.state, incoming.incomingHtlcId);
    return this.signOnIncomingChannel(incoming, failed, incomingChannel);
  }

  private async signOnIncomingChannel(
    incoming: InflightHtlc,
    nextState: ChannelState,
    incomingChannel: Channel,
  ): Promise<SignedState> {
    const advanced: ChannelState = { ...nextState, version: nextState.version + 1n };
    const sigHex = await this.deps.hubAccount.signTypedData(
      buildChannelStateTypedData(advanced, this.deps.chainId, this.deps.verifyingContract),
    );
    const sig = hexToSignature(sigHex);
    const hubIsAOnIncoming =
      incomingChannel.userA.toLowerCase() === this.deps.hubAccount.address.toLowerCase();
    return {
      state: advanced,
      sigA: hubIsAOnIncoming ? sig : incoming.incomingSignedState.sigA,
      sigB: hubIsAOnIncoming ? incoming.incomingSignedState.sigB : sig,
    };
  }

  private findChannelBetween(addrA: Address, addrB: Address): Channel | undefined {
    const a = addrA.toLowerCase();
    const b = addrB.toLowerCase();
    for (const ch of this.deps.channelPool.list()) {
      if (ch.status !== 'open') continue;
      const ua = ch.userA.toLowerCase();
      const ub = ch.userB.toLowerCase();
      if ((ua === a && ub === b) || (ua === b && ub === a)) return ch;
    }
    return undefined;
  }

  // R-01 (PR #127): expose pre-route outgoing channel lookup so ws.ts can
  // take the per-outgoing-channel mutex BEFORE route() reads + signs against
  // latestOutgoing. Without this the read+sign in route() races with another
  // concurrent pay through the same outgoing channel; recordState would
  // silently drop the second's signed v(N+1) but it still landed in payment_routes.
  resolveOutgoingChannel(recipient: Address): Channel | undefined {
    return this.findChannelBetween(this.deps.hubAccount.address, recipient);
  }

  /** Count of routed-but-unsettled HTLCs whose outgoing channel is `channelId`. */
  private countPendingOnChannel(channelId: ChannelId): number {
    let count = 0;
    for (const i of this.inflightByOutgoingId.values()) {
      if (i.outgoingChannelId === channelId) count++;
    }
    return count;
  }

  /** Sum of routed-but-unsettled HTLC amounts on `channelId`. */
  private sumPendingOnChannel(channelId: ChannelId): bigint {
    let total = 0n;
    for (const i of this.inflightByOutgoingId.values()) {
      if (i.outgoingChannelId === channelId) total += i.outgoingHtlc.amount;
    }
    return total;
  }

  /**
   * Aggregate in-flight HTLC value across **all** channels with the given
   * counterparty (sum of the outgoing-channel HTLCs we have routed plus the
   * HTLCs currently sitting in those channels' latest co-signed state).
   */
  private sumInflightToCounterparty(counterparty: Address): bigint {
    const target = counterparty.toLowerCase();
    const hub = this.deps.hubAccount.address.toLowerCase();
    let total = 0n;
    for (const ch of this.deps.channelPool.list()) {
      const a = ch.userA.toLowerCase();
      const b = ch.userB.toLowerCase();
      const isWithCounterparty = (a === hub && b === target) || (b === hub && a === target);
      if (!isWithCounterparty) continue;
      const latest = this.deps.channelPool.latest(ch.id);
      if (latest) total += sumHtlcAmounts(latest.state.htlcs);
      total += this.sumPendingOnChannel(ch.id);
    }
    return total;
  }

  /**
   * Per-counterparty aggregate value cap, in the channel token's base units.
   * The protocol-level `MAX_HTLC_VALUE_PER_COUNTERPARTY` constant (`1e8` = 100
   * USDC at 6 decimals) is the USDC default; for tokens with different decimal
   * places (native ETH at 18, PTST at 18) the same scalar would clamp away
   * any non-trivial payment. Round-4 smoke (issue #100 follow-up) showed
   * even a 0.00001 ETH payment (1e13 wei) was being rejected against the
   * 1e8 USDC scalar. Per-token overrides match the topup-policy intent
   * (1 ETH and 100 PTST counterparts).
   */
  private maxPerCounterpartyValueFor(token: Address): bigint {
    const ZERO = '0x0000000000000000000000000000000000000000';
    const PTST = '0x3CF2321323C23c9F91daFe99E2b121cab5cE3759';
    if (token.toLowerCase() === ZERO) return 1_000_000_000_000_000_000n; // 1 ETH
    if (token.toLowerCase() === PTST.toLowerCase()) return 100_000_000_000_000_000_000n; // 100 PTST
    return MAX_HTLC_VALUE_PER_COUNTERPARTY; // 100 USDC default
  }

  /**
   * `min(amountA, amountB)` per §4.3 — an HTLC may not lock more than the
   * smaller side. Falls back to the latest co-signed state's combined balance
   * if the channel-pool has no cached on-chain amounts (which is unusual).
   */
  private maxPerChannelValueFor(channel: Channel): bigint {
    const amts = this.deps.channelPool.amountsOf(channel.id);
    if (amts) {
      return amts.amountA < amts.amountB ? amts.amountA : amts.amountB;
    }
    // Fallback: derive from the latest balances + any in-flight HTLCs (so a
    // post-htlc-add reduction in balanceA doesn't underestimate amountA).
    const latest = this.deps.channelPool.latest(channel.id);
    if (!latest) return 0n;
    const sumHtlcs = sumHtlcAmounts(latest.state.htlcs);
    const totalA = latest.state.balanceA + sumHtlcs;
    const totalB = latest.state.balanceB + sumHtlcs;
    return totalA < totalB ? totalA : totalB;
  }
}

function sumHtlcAmounts(htlcs: readonly Htlc[]): bigint {
  let total = 0n;
  for (const h of htlcs) total += h.amount;
  return total;
}
