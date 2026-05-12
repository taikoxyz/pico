import { randomBytes } from 'node:crypto';
import type { Hex } from '@inferenceroom/pico-protocol';
import { type ByteArray, concat, hexToBytes, keccak256, toHex } from 'viem';
import type { Signer } from './signer.js';

export interface SignedEnvelope {
  readonly nonce: Hex;
  readonly ts: number;
  readonly payload: string;
  readonly sig: Hex;
}

function tsToBytes(ts: number): ByteArray {
  return hexToBytes(toHex(BigInt(ts), { size: 8 }));
}

function payloadToBytes(payload: string): ByteArray {
  return new TextEncoder().encode(payload);
}

/// Digest the hub recovers `sig` against. Must stay byte-identical to
/// `apps/hub/src/auth/envelope.ts:envelopeDigest`.
export function envelopeDigest(envelope: Pick<SignedEnvelope, 'nonce' | 'ts' | 'payload'>): Hex {
  return keccak256(
    concat([hexToBytes(envelope.nonce), tsToBytes(envelope.ts), payloadToBytes(envelope.payload)]),
  );
}

/// Wrap a raw wire payload (already JSON-stringified) into a signed envelope.
/// The hub-side verifier rejects envelopes whose timestamp drifts more than
/// 60s, and rejects nonces it has already seen — so callers must generate a
/// fresh nonce per call.
export async function buildEnvelope(
  signer: Signer,
  payload: string,
  opts?: { nowMs?: number; nonceHex?: Hex },
): Promise<SignedEnvelope> {
  const nonce = opts?.nonceHex ?? (`0x${randomBytes(16).toString('hex')}` as Hex);
  const ts = opts?.nowMs ?? Date.now();
  const digest = envelopeDigest({ nonce, ts, payload });
  const sig = await signer.signEnvelope(digest);
  return { nonce, ts, payload, sig };
}

/// Cheap structural check: does this JSON value look like a SignedEnvelope?
/// Used by hub auto-detect in non-strict mode and by client-side replies that
/// might be wrapped in the future.
export function looksLikeSignedEnvelope(value: unknown): value is SignedEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nonce === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.payload === 'string' &&
    typeof v.sig === 'string'
  );
}
