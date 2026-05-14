import type { Hex, Signature } from '@inferenceroom/pico-protocol';

// Sentinel-signature placeholder shape produced by hub v2.1.2's chain-watcher
// bootstrap and topup-handler. Both used `EMPTY_SIG_BYTES` (a 65-byte sig
// blob) for `Signature.r`/`s` (each of which should be 32 bytes), so
// `signatureToHex({r: 65b, s: 65b, v: 0})` produced a 264-char all-zero
// blob that was persisted to the hub DB. v2.1.3 corrects the source of
// these states; this codec tolerates the pre-existing rows on read so the
// hub can hydrate and start.
const MALFORMED_SENTINEL_LEN = 264; // "0x" + 130 + 130 + 02 hex chars
const NORMAL_SIG_LEN = 132; // "0x" + 64 + 64 + 02 hex chars

export function hexToSignature(hex: Hex): Signature {
  if (hex.length === MALFORMED_SENTINEL_LEN && /^0x0*$/.test(hex)) {
    const zero32: Hex = `0x${'00'.repeat(32)}` as Hex;
    return { r: zero32, s: zero32, v: 0 };
  }
  if (hex.length !== NORMAL_SIG_LEN) {
    throw new Error(`expected 65-byte hex signature, got length ${hex.length}`);
  }
  return {
    r: `0x${hex.slice(2, 66)}` as Hex,
    s: `0x${hex.slice(66, 130)}` as Hex,
    v: Number.parseInt(hex.slice(130, 132), 16),
  };
}

export function signatureToHex(sig: Signature): Hex {
  const r = sig.r.slice(2).padStart(64, '0');
  const s = sig.s.slice(2).padStart(64, '0');
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${r}${s}${v}` as Hex;
}
