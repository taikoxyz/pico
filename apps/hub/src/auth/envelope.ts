import type { Address, Hex } from '@inferenceroom/pico-protocol';
import { type ByteArray, concat, hexToBytes, keccak256, recoverAddress, toHex } from 'viem';
import type { NonceRepo } from '../db/repos/index.js';

export interface SignedEnvelope {
  readonly nonce: Hex;
  readonly ts: number;
  readonly payload: string;
  readonly sig: Hex;
}

export interface EnvelopeVerifyOk {
  readonly ok: true;
  readonly signer: Address;
  readonly payload: string;
}

export interface EnvelopeVerifyFail {
  readonly ok: false;
  readonly reason: string;
}

export type EnvelopeVerifyResult = EnvelopeVerifyOk | EnvelopeVerifyFail;

export interface VerifyEnvelopeArgs {
  readonly envelope: SignedEnvelope;
  readonly knownSigners: ReadonlySet<Address>;
  readonly nonceRepo: NonceRepo;
  readonly nowMs?: number;
  readonly windowMs?: number;
  /**
   * When true, skip the `knownSigners` membership check and accept any
   * validly-recovered signer (replay/window protection still applies). Used by
   * the peer-channel relay: relayers need not share a channel with the hub, and
   * per-message authorization is enforced downstream (peers co-sign each other).
   */
  readonly allowUnknownSigner?: boolean;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

function tsToBytes(ts: number): ByteArray {
  return hexToBytes(toHex(BigInt(ts), { size: 8 }));
}

function payloadToBytes(payload: string): ByteArray {
  return new TextEncoder().encode(payload);
}

export function envelopeDigest(envelope: Pick<SignedEnvelope, 'nonce' | 'ts' | 'payload'>): Hex {
  return keccak256(
    concat([hexToBytes(envelope.nonce), tsToBytes(envelope.ts), payloadToBytes(envelope.payload)]),
  );
}

export async function verifyEnvelope(args: VerifyEnvelopeArgs): Promise<EnvelopeVerifyResult> {
  const now = args.nowMs ?? Date.now();
  const window = args.windowMs ?? DEFAULT_WINDOW_MS;
  const drift = Math.abs(now - args.envelope.ts);
  if (drift > window) {
    return { ok: false, reason: `timestamp drift ${drift}ms exceeds window ${window}ms` };
  }
  const digest = envelopeDigest(args.envelope);
  let signer: Address;
  try {
    signer = (await recoverAddress({ hash: digest, signature: args.envelope.sig })) as Address;
  } catch (err) {
    return { ok: false, reason: `signature recovery failed: ${(err as Error).message}` };
  }
  if (args.allowUnknownSigner !== true) {
    const lower = signer.toLowerCase();
    const known = Array.from(args.knownSigners).map((a) => a.toLowerCase());
    if (!known.includes(lower)) {
      return { ok: false, reason: `signer ${signer} not a known channel party` };
    }
  }

  if (await args.nonceRepo.isSeen(args.envelope.nonce)) {
    return { ok: false, reason: 'nonce replayed' };
  }
  try {
    await args.nonceRepo.record(args.envelope.nonce, signer, now + DEFAULT_NONCE_TTL_MS);
  } catch (err) {
    return { ok: false, reason: `nonce record failed: ${(err as Error).message}` };
  }
  return { ok: true, signer, payload: args.envelope.payload };
}
