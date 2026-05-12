// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HTLC
/// @notice Hash-time-locked contract primitives shared across `PaymentChannel` and `Adjudicator`.
/// @dev Library form: stateless, side-effect-free helpers only. Stays a library because libraries
///      are not upgradeable and we want this layer to be byte-for-byte stable across versions.
///      Hashing must match `packages/protocol/src/htlc-root.ts` exactly.
library HTLC {
    /// @notice An HTLC commitment as it appears inside a channel state hash.
    /// @param id Globally unique HTLC id (typically 32 random bytes).
    /// @param amount Amount of the channel token locked behind this HTLC.
    /// @param paymentHash sha256 hash of the preimage that unlocks the HTLC.
    /// @param expiry Absolute unix-seconds timestamp after which the HTLC can be refunded.
    /// @param direction 0 = AtoB, 1 = BtoA. Anything else is an invalid lock.
    struct Lock {
        bytes32 id;
        uint256 amount;
        bytes32 paymentHash;
        uint64 expiry;
        uint8 direction;
    }

    /// @notice Compute the canonical hash of a single HTLC lock.
    /// @dev `keccak256(abi.encode(id, amount, paymentHash, expiry, direction))`.
    ///      Must match `htlcLeaf` in `packages/protocol/src/htlc-root.ts`.
    function hashLock(Lock memory lock) internal pure returns (bytes32) {
        return keccak256(abi.encode(lock.id, lock.amount, lock.paymentHash, lock.expiry, lock.direction));
    }

    /// @notice Verify that `preimage` matches `paymentHash` using sha256 (per D1.2).
    /// @return true iff `sha256(preimage) == paymentHash`.
    function verifyPreimage(bytes32 paymentHash, bytes calldata preimage) internal pure returns (bool) {
        return sha256(preimage) == paymentHash;
    }

    /// @notice Build the Merkle root over a set of HTLC locks.
    /// @dev Sort ascending by `id`, hash leaves with `hashLock`, then pairwise concat-hash
    ///      `keccak256(left || right)` (raw bytes32 concat, no abi wrapper). On odd levels,
    ///      the trailing leaf is duplicated. Empty input yields `bytes32(0)`.
    ///      Must match `htlcMerkleRoot` in `packages/protocol/src/htlc-root.ts`.
    function rootOf(Lock[] memory locks) internal pure returns (bytes32) {
        uint256 n = locks.length;
        if (n == 0) return bytes32(0);

        bytes32[] memory level = new bytes32[](n);
        Lock[] memory sorted = _sortById(locks);
        for (uint256 i = 0; i < n; i++) {
            level[i] = hashLock(sorted[i]);
        }

        while (level.length > 1) {
            uint256 m = level.length;
            uint256 nextLen = (m + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLen);
            for (uint256 i = 0; i < m; i += 2) {
                bytes32 left = level[i];
                bytes32 right = i + 1 < m ? level[i + 1] : level[i];
                next[i / 2] = keccak256(abi.encodePacked(left, right));
            }
            level = next;
        }
        return level[0];
    }

    /// @notice Verify a Merkle inclusion proof for `leaf` against `root`, using the same
    ///         left/right pairing + odd-tail duplication scheme as `rootOf`.
    /// @dev Must match `htlcMerkleProof` in `packages/protocol/src/htlc-root.ts`. The verifier
    ///      walks the tree from `sortedIndex` upward: at each level it pairs the current node
    ///      with the next sibling in `proof` (right-of-pair) or the previous (left-of-pair),
    ///      depending on `sortedIndex` parity. When the node sits in the "odd tail" slot at
    ///      a given level (sole leaf left over), no sibling is consumed and the node is
    ///      hashed against itself.
    /// @param leaf Hash of the HTLC lock being proved (`hashLock(htlc)`).
    /// @param root Merkle root that `leaf` is being proved against (`rootOf(locks)`).
    /// @param proof Sibling hashes from leaf level upward, omitting odd-tail self-duplications.
    /// @param sortedIndex Position of `leaf` in the sort-by-id ordering of the original set.
    /// @param totalLeaves Number of leaves in the original set. Used to detect odd-tail levels.
    /// @return true iff `leaf` is part of the set that produces `root`.
    function verifyOrderedProof(
        bytes32 leaf,
        bytes32 root,
        bytes32[] calldata proof,
        uint256 sortedIndex,
        uint256 totalLeaves
    ) internal pure returns (bool) {
        if (totalLeaves == 0) return false;
        if (sortedIndex >= totalLeaves) return false;
        if (totalLeaves == 1) {
            return proof.length == 0 && leaf == root;
        }

        bytes32 node = leaf;
        uint256 index = sortedIndex;
        uint256 levelWidth = totalLeaves;
        uint256 cursor = 0;

        while (levelWidth > 1) {
            bool isRight = (index & 1) == 1;
            bool isOddTail = !isRight && (index + 1 == levelWidth);
            bytes32 sibling;
            if (isOddTail) {
                sibling = node;
            } else {
                if (cursor >= proof.length) return false;
                sibling = proof[cursor];
                unchecked {
                    cursor++;
                }
            }
            node = isRight ? keccak256(abi.encodePacked(sibling, node)) : keccak256(abi.encodePacked(node, sibling));

            unchecked {
                index = index >> 1;
                levelWidth = (levelWidth + 1) / 2;
            }
        }

        return cursor == proof.length && node == root;
    }

    /// @dev In-place insertion sort by `id` ascending. Operates on a defensive copy so callers
    ///      can rely on `rootOf` being a pure function of the input *set*. Insertion sort is fine
    ///      here: HTLC sets per channel are very small (typically <16 in flight, hard-cap is
    ///      enforced by the off-chain protocol).
    function _sortById(Lock[] memory locks) private pure returns (Lock[] memory) {
        uint256 n = locks.length;
        Lock[] memory out = new Lock[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = locks[i];
        }
        for (uint256 i = 1; i < n; i++) {
            Lock memory key = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1].id > key.id) {
                out[j] = out[j - 1];
                unchecked {
                    j--;
                }
            }
            out[j] = key;
        }
        return out;
    }
}
