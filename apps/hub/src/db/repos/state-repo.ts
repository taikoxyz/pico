import type {
  ChannelId,
  ChannelState,
  Hex,
  Signature,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { hexToSignature, signatureToHex } from '@inferenceroom/pico-sdk';
import type { DbDriver } from '../types.js';

interface StateRow {
  readonly channel_id: string;
  readonly version: string;
  readonly state_json: string;
  readonly sig_a: string;
  readonly sig_b: string;
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

function stateToJson(state: ChannelState): string {
  const payload: ChannelStateJson = {
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
  return JSON.stringify(payload);
}

function jsonToState(json: string): ChannelState {
  const p = JSON.parse(json) as ChannelStateJson;
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

function rowToSignedState(r: StateRow): SignedState {
  return {
    state: jsonToState(r.state_json),
    sigA: hexToSignature(r.sig_a as Hex),
    sigB: hexToSignature(r.sig_b as Hex),
  };
}

export class StaleVersionError extends Error {
  readonly code = 'STALE_VERSION';
  constructor(channelId: ChannelId, attempted: bigint, existing: bigint) {
    super(
      `state version ${attempted} for channel ${channelId} not greater than existing ${existing}`,
    );
    this.name = 'StaleVersionError';
  }
}

export class StateRepo {
  constructor(private readonly db: DbDriver) {}

  async save(signed: SignedState): Promise<void> {
    const channelId = signed.state.channelId;
    const version = signed.state.version;
    const existing = await this.latestVersion(channelId);
    if (existing !== undefined && version <= existing) {
      throw new StaleVersionError(channelId, version, existing);
    }
    await this.db.exec(
      `INSERT INTO signed_states (channel_id, version, state_json, sig_a, sig_b, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        channelId,
        version.toString(),
        stateToJson(signed.state),
        signatureToHex(signed.sigA),
        signatureToHex(signed.sigB),
        String(Date.now()),
      ],
    );
  }

  async latest(channelId: ChannelId): Promise<SignedState | undefined> {
    const rows = await this.db.query<StateRow>(
      `SELECT channel_id, version, state_json, sig_a, sig_b
       FROM signed_states
       WHERE channel_id = ?
       ORDER BY length(version) DESC, version DESC
       LIMIT 1`,
      [channelId],
    );
    return rows[0] ? rowToSignedState(rows[0]) : undefined;
  }

  async latestVersion(channelId: ChannelId): Promise<bigint | undefined> {
    const rows = await this.db.query<{ version: string }>(
      'SELECT version FROM signed_states WHERE channel_id = ? ORDER BY length(version) DESC, version DESC LIMIT 1',
      [channelId],
    );
    return rows[0] ? BigInt(rows[0].version) : undefined;
  }

  /**
   * Returns the highest-version signed state for a channel that is
   * dispute-eligible: empty HTLCs (matches PaymentChannel's
   * `htlcsRoot == bytes32(0)` invariant) and balances that conserve total.
   * Returns undefined if no such state exists. Used by the dispute handler
   * to avoid submitting states the contract will revert.
   */
  async latestDisputeEligible(channelId: ChannelId): Promise<SignedState | undefined> {
    const rows = await this.db.query<StateRow>(
      `SELECT channel_id, version, state_json, sig_a, sig_b
       FROM signed_states
       WHERE channel_id = ?
       ORDER BY length(version) DESC, version DESC`,
      [channelId],
    );
    for (const r of rows) {
      const signed = rowToSignedState(r);
      if (signed.state.htlcs.length === 0) {
        return signed;
      }
    }
    return undefined;
  }

  async loadAllLatest(): Promise<ReadonlyMap<ChannelId, SignedState>> {
    const rows = await this.db.query<StateRow>(
      `SELECT s.channel_id, s.version, s.state_json, s.sig_a, s.sig_b
       FROM signed_states s
       INNER JOIN (
         SELECT channel_id,
                MAX(length(version)) AS max_len
         FROM signed_states
         GROUP BY channel_id
       ) m ON m.channel_id = s.channel_id AND length(s.version) = m.max_len
       INNER JOIN (
         SELECT channel_id, length(version) AS len, MAX(version) AS max_v
         FROM signed_states
         GROUP BY channel_id, length(version)
       ) n ON n.channel_id = s.channel_id AND length(s.version) = n.len AND s.version = n.max_v`,
    );
    const out = new Map<ChannelId, SignedState>();
    for (const r of rows) {
      out.set(r.channel_id as ChannelId, rowToSignedState(r));
    }
    return out;
  }
}

export type { Signature };
