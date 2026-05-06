import type {
  Address,
  ChannelId,
  Hex,
  Htlc,
  HtlcId,
  PaymentHash,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { hexToSignature, signatureToHex } from '@inferenceroom/pico-sdk';
import type { DbDriver } from '../types.js';

export type RouteState = 'inflight' | 'settled' | 'failed';

export interface PaymentRoute {
  readonly incomingChannelId: ChannelId;
  readonly incomingHtlcId: HtlcId;
  readonly outgoingChannelId: ChannelId;
  readonly outgoingHtlcId: HtlcId;
  readonly sender: Address;
  readonly recipient: Address;
  readonly paymentHash: PaymentHash;
  readonly incomingSignedState: SignedState;
  readonly outgoingHubSigned: SignedState;
  readonly outgoingHtlc: Htlc;
  readonly state: RouteState;
}

interface RouteRow {
  readonly incoming_channel_id: string;
  readonly incoming_htlc_id: string;
  readonly outgoing_channel_id: string;
  readonly outgoing_htlc_id: string;
  readonly sender: string;
  readonly recipient: string;
  readonly payment_hash: string;
  readonly incoming_signed_state: string;
  readonly outgoing_hub_signed: string;
  readonly outgoing_htlc_json: string;
  readonly state: RouteState;
}

interface SignedStateJson {
  readonly state: {
    readonly channelId: string;
    readonly version: string;
    readonly balanceA: string;
    readonly balanceB: string;
    readonly htlcs: ReadonlyArray<{
      id: string;
      direction: 'AtoB' | 'BtoA';
      amount: string;
      paymentHash: string;
      expiryMs: string;
    }>;
    readonly finalized: boolean;
  };
  readonly sigA: string;
  readonly sigB: string;
}

interface HtlcJson {
  readonly id: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amount: string;
  readonly paymentHash: string;
  readonly expiryMs: string;
}

function signedStateToJson(s: SignedState): string {
  const payload: SignedStateJson = {
    state: {
      channelId: s.state.channelId,
      version: s.state.version.toString(),
      balanceA: s.state.balanceA.toString(),
      balanceB: s.state.balanceB.toString(),
      htlcs: s.state.htlcs.map((h) => ({
        id: h.id,
        direction: h.direction,
        amount: h.amount.toString(),
        paymentHash: h.paymentHash,
        expiryMs: h.expiryMs.toString(),
      })),
      finalized: s.state.finalized,
    },
    sigA: signatureToHex(s.sigA),
    sigB: signatureToHex(s.sigB),
  };
  return JSON.stringify(payload);
}

function jsonToSignedState(json: string): SignedState {
  const p = JSON.parse(json) as SignedStateJson;
  return {
    state: {
      channelId: p.state.channelId as `0x${string}`,
      version: BigInt(p.state.version),
      balanceA: BigInt(p.state.balanceA),
      balanceB: BigInt(p.state.balanceB),
      htlcs: p.state.htlcs.map((h) => ({
        id: h.id as Hex,
        direction: h.direction,
        amount: BigInt(h.amount),
        paymentHash: h.paymentHash as Hex,
        expiryMs: BigInt(h.expiryMs),
      })),
      finalized: p.state.finalized,
    },
    sigA: hexToSignature(p.sigA as Hex),
    sigB: hexToSignature(p.sigB as Hex),
  };
}

function htlcToJson(h: Htlc): string {
  const payload: HtlcJson = {
    id: h.id,
    direction: h.direction,
    amount: h.amount.toString(),
    paymentHash: h.paymentHash,
    expiryMs: h.expiryMs.toString(),
  };
  return JSON.stringify(payload);
}

function jsonToHtlc(json: string): Htlc {
  const p = JSON.parse(json) as HtlcJson;
  return {
    id: p.id as Hex,
    direction: p.direction,
    amount: BigInt(p.amount),
    paymentHash: p.paymentHash as Hex,
    expiryMs: BigInt(p.expiryMs),
  };
}

function rowToRoute(r: RouteRow): PaymentRoute {
  return {
    incomingChannelId: r.incoming_channel_id as ChannelId,
    incomingHtlcId: r.incoming_htlc_id as HtlcId,
    outgoingChannelId: r.outgoing_channel_id as ChannelId,
    outgoingHtlcId: r.outgoing_htlc_id as HtlcId,
    sender: r.sender as Address,
    recipient: r.recipient as Address,
    paymentHash: r.payment_hash as PaymentHash,
    incomingSignedState: jsonToSignedState(r.incoming_signed_state),
    outgoingHubSigned: jsonToSignedState(r.outgoing_hub_signed),
    outgoingHtlc: jsonToHtlc(r.outgoing_htlc_json),
    state: r.state,
  };
}

export class RouteRepo {
  constructor(private readonly db: DbDriver) {}

  async insert(route: Omit<PaymentRoute, 'state'> & { state?: RouteState }): Promise<void> {
    const now = String(Date.now());
    await this.db.exec(
      `INSERT INTO payment_routes (
        incoming_channel_id, incoming_htlc_id, outgoing_channel_id, outgoing_htlc_id,
        sender, recipient, payment_hash,
        incoming_signed_state, outgoing_hub_signed, outgoing_htlc_json,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        route.incomingChannelId,
        route.incomingHtlcId,
        route.outgoingChannelId,
        route.outgoingHtlcId,
        route.sender,
        route.recipient,
        route.paymentHash,
        signedStateToJson(route.incomingSignedState),
        signedStateToJson(route.outgoingHubSigned),
        htlcToJson(route.outgoingHtlc),
        route.state ?? 'inflight',
        now,
        now,
      ],
    );
  }

  async markSettled(outgoingHtlcId: HtlcId): Promise<void> {
    const result = await this.db.exec(
      `UPDATE payment_routes SET state = 'settled', updated_at = ?
       WHERE outgoing_htlc_id = ? AND state = 'inflight'`,
      [String(Date.now()), outgoingHtlcId],
    );
    if (result.changes === 0) {
      throw new Error(
        `RouteRepo.markSettled: no inflight row for outgoing_htlc_id=${outgoingHtlcId}`,
      );
    }
  }

  async markFailed(outgoingHtlcId: HtlcId): Promise<void> {
    const result = await this.db.exec(
      `UPDATE payment_routes SET state = 'failed', updated_at = ?
       WHERE outgoing_htlc_id = ? AND state = 'inflight'`,
      [String(Date.now()), outgoingHtlcId],
    );
    if (result.changes === 0) {
      throw new Error(
        `RouteRepo.markFailed: no inflight row for outgoing_htlc_id=${outgoingHtlcId}`,
      );
    }
  }

  async loadInflight(): Promise<readonly PaymentRoute[]> {
    const rows = await this.db.query<RouteRow>(
      `SELECT incoming_channel_id, incoming_htlc_id, outgoing_channel_id, outgoing_htlc_id,
              sender, recipient, payment_hash,
              incoming_signed_state, outgoing_hub_signed, outgoing_htlc_json, state
       FROM payment_routes WHERE state = 'inflight'`,
    );
    return rows.map(rowToRoute);
  }

  async findByOutgoingHtlc(outgoingHtlcId: HtlcId): Promise<PaymentRoute | undefined> {
    const rows = await this.db.query<RouteRow>(
      `SELECT incoming_channel_id, incoming_htlc_id, outgoing_channel_id, outgoing_htlc_id,
              sender, recipient, payment_hash,
              incoming_signed_state, outgoing_hub_signed, outgoing_htlc_json, state
       FROM payment_routes WHERE outgoing_htlc_id = ? LIMIT 1`,
      [outgoingHtlcId],
    );
    return rows[0] ? rowToRoute(rows[0]) : undefined;
  }
}
