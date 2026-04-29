import type { Hex, Signature } from '@tainnel/protocol';

export function hexToSignature(hex: Hex): Signature {
  if (hex.length !== 132) {
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
