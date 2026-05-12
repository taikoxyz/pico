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

export interface HtlcMerkleProof {
  readonly proof: readonly Hex[];
  readonly sortedIndex: number;
  readonly totalLeaves: number;
}

/**
 * Build a Merkle inclusion proof for the HTLC with `targetId` against the root
 * produced by `htlcMerkleRoot`. Returns the sibling hashes (root→leaf order is
 * reversed: leaves first) plus the sorted-position index and total leaf count
 * the on-chain verifier needs to replay left/right pairing and odd-tail
 * duplication. Throws if `targetId` is not present in `htlcs`.
 */
export function htlcMerkleProof(htlcs: readonly Htlc[], targetId: Hex): HtlcMerkleProof {
  if (htlcs.length === 0) throw new Error('htlcMerkleProof: empty set');
  const sorted = [...htlcs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedIndex = sorted.findIndex((h) => h.id === targetId);
  if (sortedIndex < 0) throw new Error(`htlcMerkleProof: ${targetId} not present`);

  let level: Hex[] = sorted.map(htlcLeaf);
  let index = sortedIndex;
  const proof: Hex[] = [];

  while (level.length > 1) {
    const isRight = (index & 1) === 1;
    const m = level.length;
    if (isRight) {
      proof.push(level[index - 1] as Hex);
    } else if (index + 1 < m) {
      proof.push(level[index + 1] as Hex);
    }
    // else: leaf is the duplicated odd-tail — the verifier synthesizes
    // sibling = node and the proof omits this entry.

    const next: Hex[] = [];
    for (let i = 0; i < m; i += 2) {
      const left = level[i] as Hex;
      const right = (i + 1 < m ? level[i + 1] : level[i]) as Hex;
      const concat = `0x${left.slice(2)}${right.slice(2)}` as Hex;
      next.push(keccak256(concat));
    }
    level = next;
    index = index >> 1;
  }

  return { proof, sortedIndex, totalLeaves: sorted.length };
}
