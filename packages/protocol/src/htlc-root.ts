import { encodeAbiParameters, keccak256 } from 'viem';
import type { Hex, Htlc } from './types.js';

export const HTLC_DIRECTION_ATOB = 0;
export const HTLC_DIRECTION_BTOA = 1;

export const EMPTY_HTLCS_ROOT: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

export function htlcDirectionByte(direction: 'AtoB' | 'BtoA'): number {
  return direction === 'AtoB' ? HTLC_DIRECTION_ATOB : HTLC_DIRECTION_BTOA;
}

export function htlcExpirySeconds(htlc: Htlc): bigint {
  return htlc.expiryMs / 1000n;
}

export function htlcLeaf(htlc: Htlc): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'bytes32' },
      { type: 'uint64' },
      { type: 'uint8' },
    ],
    [
      htlc.id,
      htlc.amount,
      htlc.paymentHash,
      htlcExpirySeconds(htlc),
      htlcDirectionByte(htlc.direction),
    ],
  );
  return keccak256(encoded);
}

export function htlcMerkleRoot(htlcs: readonly Htlc[]): Hex {
  if (htlcs.length === 0) return EMPTY_HTLCS_ROOT;
  const sorted = [...htlcs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let level: Hex[] = sorted.map(htlcLeaf);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = (i + 1 < level.length ? level[i + 1] : level[i]) as Hex;
      const concat = `0x${left.slice(2)}${right.slice(2)}` as Hex;
      next.push(keccak256(concat));
    }
    level = next;
  }
  return level[0] as Hex;
}
