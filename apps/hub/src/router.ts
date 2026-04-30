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
} from '@tainnel/protocol';
import { hexToSignature, randomHtlcId } from '@tainnel/sdk';
import { addHtlc, buildChannelStateTypedData, failHtlc, settleHtlc } from '@tainnel/state-machine';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { ChannelPool } from './channel-pool.js';
import type { FeePolicy } from './fee-policy.js';
import type { Logger } from './logger.js';

const DEFAULT_EXPIRY_BUFFER_MS = 5n * 60n * 1000n;

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

  pendingForRecipient(recipient: Address): readonly InflightHtlc[] {
    const lower = recipient.toLowerCase();
    return Array.from(this.inflightByOutgoingId.values()).filter(
      (i) => i.recipient.toLowerCase() === lower,
    );
  }

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
    this.deps.channelPool.recordState(incoming.outgoingChannelId, bobSettledOutgoingState);

    const settled = settleHtlc(
      incoming.incomingSignedState.state,
      incoming.incomingHtlcId,
      preimage,
    );
    return this.signOnIncomingChannel(incoming, settled, incomingChannel);
  }

  async failIncoming(incoming: InflightHtlc): Promise<SignedState> {
    const incomingChannel = this.deps.channelPool.get(incoming.incomingChannelId);
    if (!incomingChannel) {
      throw new Error(`router: lost incoming channel ${incoming.incomingChannelId}`);
    }
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
}
