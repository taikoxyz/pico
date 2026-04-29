import type { Hex, HtlcId, Preimage } from '@tainnel/protocol';

function toHex(bytes: Uint8Array): Hex {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as Hex;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomPreimage(): Preimage {
  return toHex(randomBytes(32));
}

export function randomHtlcId(): HtlcId {
  return toHex(randomBytes(32));
}

export function randomNonce16(): Hex {
  return toHex(randomBytes(16));
}

export function bytesToHex(bytes: Uint8Array): Hex {
  return toHex(bytes);
}

export function hexToBytes(hex: Hex): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) throw new Error('invalid hex length');
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
