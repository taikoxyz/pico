import type {
  Address,
  ChannelId,
  ChannelState,
  Hex,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { hexToSignature, signatureToHex } from '@inferenceroom/pico-sdk';
import type { DbDriver } from '../types.js';

/**
 * Lifecycle of a top-up offer (see §8.6 / §8.8).
 *
 *   queued    — admission policy approved but waiting for hot-wallet headroom
 *               (auto-recycle target after a close).
 *   proposed  — `proposeTopUp` envelope sent to the user; awaiting `acceptTopUp`
 *               or `rejectTopUp`. Also reachable by `validUntil`-driven expiry.
 *   accepted  — user replied `acceptTopUp` and the hub validated the signed
 *               new state. Hub is about to submit the on-chain `topUp(...)` tx.
 *   submitted — on-chain `topUp(...)` broadcast; `submittedTxHash` recorded.
 *               Awaiting `ToppedUp` event from chain-watcher.
 *   confirmed — `ToppedUp` observed on-chain; channel amounts updated.
 *   rejected  — user replied `rejectTopUp`. Committed funds released.
 *   expired   — `validUntil` passed without `acceptTopUp`. Committed funds
 *               released.
 */
export type TopUpOfferStatus =
  | 'queued'
  | 'proposed'
  | 'accepted'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'expired';

export interface TopUpOfferRow {
  readonly offerId: Hex;
  readonly channelId: ChannelId;
  readonly counterparty: Address;
  readonly amount: bigint;
  readonly prevVersion: bigint;
  readonly newVersion: bigint;
  readonly newState: ChannelState;
  readonly hubSigPrev: Hex;
  readonly hubSigNew: Hex;
  readonly validUntilSec: bigint;
  readonly status: TopUpOfferStatus;
  readonly submittedTxHash?: Hex;
  readonly userSignedNewState?: SignedState;
  readonly rejectReason?: string;
  readonly priority: number;
  readonly queuedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ChannelStateJson {
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
}

interface SignedStateJson {
  readonly state: ChannelStateJson;
  readonly sigA: string;
  readonly sigB: string;
}

interface TopUpOfferDbRow {
  readonly offer_id: string;
  readonly channel_id: string;
  readonly counterparty: string;
  readonly amount: string;
  readonly prev_version: string;
  readonly new_version: string;
  readonly new_state_json: string;
  readonly hub_sig_prev: string;
  readonly hub_sig_new: string;
  readonly valid_until_sec: string;
  readonly status: TopUpOfferStatus;
  readonly submitted_tx_hash: string | null;
  readonly user_signed_new_state_json: string | null;
  readonly reject_reason: string | null;
  readonly priority: number;
  readonly queued_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function stateToJson(state: ChannelState): ChannelStateJson {
  return {
    channelId: state.channelId,
    version: state.version.toString(),
    balanceA: state.balanceA.toString(),
    balanceB: state.balanceB.toString(),
    htlcs: state.htlcs.map((h) => ({
      id: h.id,
      direction: h.direction,
      amount: h.amount.toString(),
      paymentHash: h.paymentHash,
      expiryMs: h.expiryMs.toString(),
    })),
    finalized: state.finalized,
  };
}

function jsonToState(p: ChannelStateJson): ChannelState {
  return {
    channelId: p.channelId as ChannelState['channelId'],
    version: BigInt(p.version),
    balanceA: BigInt(p.balanceA),
    balanceB: BigInt(p.balanceB),
    htlcs: p.htlcs.map((h) => ({
      id: h.id as Hex,
      direction: h.direction,
      amount: BigInt(h.amount),
      paymentHash: h.paymentHash as Hex,
      expiryMs: BigInt(h.expiryMs),
    })),
    finalized: p.finalized,
  };
}

function signedStateToJson(s: SignedState): string {
  const payload: SignedStateJson = {
    state: stateToJson(s.state),
    sigA: signatureToHex(s.sigA),
    sigB: signatureToHex(s.sigB),
  };
  return JSON.stringify(payload);
}

function jsonToSignedState(raw: string): SignedState {
  const p = JSON.parse(raw) as SignedStateJson;
  return {
    state: jsonToState(p.state),
    sigA: hexToSignature(p.sigA as Hex),
    sigB: hexToSignature(p.sigB as Hex),
  };
}

function rowToOffer(r: TopUpOfferDbRow): TopUpOfferRow {
  return {
    offerId: r.offer_id as Hex,
    channelId: r.channel_id as ChannelId,
    counterparty: r.counterparty as Address,
    amount: BigInt(r.amount),
    prevVersion: BigInt(r.prev_version),
    newVersion: BigInt(r.new_version),
    newState: jsonToState(JSON.parse(r.new_state_json) as ChannelStateJson),
    hubSigPrev: r.hub_sig_prev as Hex,
    hubSigNew: r.hub_sig_new as Hex,
    validUntilSec: BigInt(r.valid_until_sec),
    status: r.status,
    ...(r.submitted_tx_hash !== null ? { submittedTxHash: r.submitted_tx_hash as Hex } : {}),
    ...(r.user_signed_new_state_json !== null
      ? { userSignedNewState: jsonToSignedState(r.user_signed_new_state_json) }
      : {}),
    ...(r.reject_reason !== null ? { rejectReason: r.reject_reason } : {}),
    priority: Number(r.priority),
    queuedAt: Number(r.queued_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class TopUpOfferRepo {
  constructor(private readonly db: DbDriver) {}

  async insert(row: TopUpOfferRow): Promise<void> {
    await this.db.exec(
      `INSERT INTO topup_offers (
         offer_id, channel_id, counterparty, amount,
         prev_version, new_version, new_state_json,
         hub_sig_prev, hub_sig_new, valid_until_sec,
         status, submitted_tx_hash, user_signed_new_state_json, reject_reason,
         priority, queued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.offerId,
        row.channelId,
        row.counterparty.toLowerCase(),
        row.amount.toString(),
        row.prevVersion.toString(),
        row.newVersion.toString(),
        JSON.stringify(stateToJson(row.newState)),
        row.hubSigPrev,
        row.hubSigNew,
        row.validUntilSec.toString(),
        row.status,
        row.submittedTxHash ?? null,
        row.userSignedNewState ? signedStateToJson(row.userSignedNewState) : null,
        row.rejectReason ?? null,
        row.priority,
        String(row.queuedAt),
        String(row.createdAt),
        String(row.updatedAt),
      ],
    );
  }

  async update(offerId: Hex, patch: Partial<TopUpOfferRow>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    function push(col: string, val: unknown): void {
      fields.push(`${col} = ?`);
      values.push(val);
    }
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.submittedTxHash !== undefined) push('submitted_tx_hash', patch.submittedTxHash);
    if (patch.userSignedNewState !== undefined) {
      push('user_signed_new_state_json', signedStateToJson(patch.userSignedNewState));
    }
    if (patch.rejectReason !== undefined) push('reject_reason', patch.rejectReason);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.validUntilSec !== undefined) push('valid_until_sec', patch.validUntilSec.toString());
    if (patch.amount !== undefined) push('amount', patch.amount.toString());
    if (fields.length === 0) return;
    push('updated_at', String(Date.now()));
    values.push(offerId);
    await this.db.exec(`UPDATE topup_offers SET ${fields.join(', ')} WHERE offer_id = ?`, values);
  }

  async get(offerId: Hex): Promise<TopUpOfferRow | undefined> {
    const rows = await this.db.query<TopUpOfferDbRow>(
      'SELECT * FROM topup_offers WHERE offer_id = ?',
      [offerId],
    );
    return rows[0] ? rowToOffer(rows[0]) : undefined;
  }

  async listByStatus(status: TopUpOfferStatus): Promise<TopUpOfferRow[]> {
    const rows = await this.db.query<TopUpOfferDbRow>(
      'SELECT * FROM topup_offers WHERE status = ? ORDER BY priority DESC, queued_at ASC',
      [status],
    );
    return rows.map(rowToOffer);
  }

  async listQueued(): Promise<TopUpOfferRow[]> {
    return this.listByStatus('queued');
  }

  async listByCounterparty(addr: Address, statuses?: TopUpOfferStatus[]): Promise<TopUpOfferRow[]> {
    const counterparty = addr.toLowerCase();
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      const rows = await this.db.query<TopUpOfferDbRow>(
        `SELECT * FROM topup_offers
         WHERE counterparty = ? AND status IN (${placeholders})
         ORDER BY priority DESC, queued_at ASC`,
        [counterparty, ...statuses],
      );
      return rows.map(rowToOffer);
    }
    const rows = await this.db.query<TopUpOfferDbRow>(
      'SELECT * FROM topup_offers WHERE counterparty = ? ORDER BY priority DESC, queued_at ASC',
      [counterparty],
    );
    return rows.map(rowToOffer);
  }

  async listByChannel(channelId: ChannelId): Promise<TopUpOfferRow[]> {
    const rows = await this.db.query<TopUpOfferDbRow>(
      'SELECT * FROM topup_offers WHERE channel_id = ? ORDER BY priority DESC, queued_at ASC',
      [channelId],
    );
    return rows.map(rowToOffer);
  }
}
