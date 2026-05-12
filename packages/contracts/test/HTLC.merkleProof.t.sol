// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HTLC} from "../src/HTLC.sol";

/// @title HTLC.merkleProof
/// @notice Self-contained verification that `HTLC.verifyOrderedProof` accepts
///         every leaf in a set against the root produced by `HTLC.rootOf`,
///         and rejects perturbations. Off-chain `htlcMerkleProof` in
///         `packages/protocol/src/htlc-root.ts` must agree byte-for-byte
///         with this verifier; a TS round-trip test asserts that separately.
contract HtlcMerkleProofTest is Test {
    function _lock(uint256 seed) internal pure returns (HTLC.Lock memory) {
        return HTLC.Lock({
            id: keccak256(abi.encode("id", seed)),
            amount: (seed + 1) * 100,
            paymentHash: keccak256(abi.encode("ph", seed)),
            expiry: uint64(1_700_000_000 + seed * 60),
            direction: uint8(seed & 1)
        });
    }

    /// @dev Compute the proof for `targetIndex` inside the sorted-by-id ordering
    ///      of `locks`. Mirrors the off-chain `htlcMerkleProof` in TS.
    function _buildProof(HTLC.Lock[] memory locks, uint256 sortedIndex)
        internal
        pure
        returns (bytes32[] memory proof, uint256 totalLeaves)
    {
        // Re-sort by id (same scheme as `rootOf`).
        HTLC.Lock[] memory sorted = _sortById(locks);
        totalLeaves = sorted.length;
        bytes32[] memory level = new bytes32[](totalLeaves);
        for (uint256 i = 0; i < totalLeaves; i++) {
            level[i] = HTLC.hashLock(sorted[i]);
        }

        // Worst case 5 leaves -> 3 proof entries; alloc generously and trim.
        bytes32[] memory buf = new bytes32[](totalLeaves);
        uint256 cursor = 0;
        uint256 index = sortedIndex;

        while (level.length > 1) {
            uint256 m = level.length;
            bool isRight = (index & 1) == 1;
            bool isOddTail = !isRight && (index + 1 == m);
            if (!isOddTail) {
                buf[cursor] = isRight ? level[index - 1] : level[index + 1];
                cursor++;
            }
            bytes32[] memory next = new bytes32[]((m + 1) / 2);
            for (uint256 i = 0; i < m; i += 2) {
                bytes32 l = level[i];
                bytes32 r = i + 1 < m ? level[i + 1] : level[i];
                next[i / 2] = keccak256(abi.encodePacked(l, r));
            }
            level = next;
            index >>= 1;
        }

        proof = new bytes32[](cursor);
        for (uint256 i = 0; i < cursor; i++) {
            proof[i] = buf[i];
        }
    }

    function _sortById(HTLC.Lock[] memory locks) internal pure returns (HTLC.Lock[] memory) {
        uint256 n = locks.length;
        HTLC.Lock[] memory out = new HTLC.Lock[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = locks[i];
        }
        for (uint256 i = 1; i < n; i++) {
            HTLC.Lock memory key = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1].id > key.id) {
                out[j] = out[j - 1];
                j--;
            }
            out[j] = key;
        }
        return out;
    }

    function _wrap(bytes32 leaf) internal pure returns (bytes32 result) {
        result = leaf;
    }

    /// @dev External-call wrapper so we can pass a memory bytes32[] as calldata
    ///      to `verifyOrderedProof`.
    function verify(bytes32 leaf, bytes32 root, bytes32[] calldata proof, uint256 sortedIndex, uint256 totalLeaves)
        external
        pure
        returns (bool)
    {
        return HTLC.verifyOrderedProof(leaf, root, proof, sortedIndex, totalLeaves);
    }

    function _verifyExternal(
        bytes32 leaf,
        bytes32 root,
        bytes32[] memory proof,
        uint256 sortedIndex,
        uint256 totalLeaves
    ) internal view returns (bool) {
        return this.verify(leaf, root, proof, sortedIndex, totalLeaves);
    }

    function test_singleLeaf_acceptsEmptyProof() public view {
        HTLC.Lock[] memory locks = new HTLC.Lock[](1);
        locks[0] = _lock(1);
        bytes32 root = HTLC.rootOf(locks);
        bytes32 leaf = HTLC.hashLock(locks[0]);
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(_verifyExternal(leaf, root, proof, 0, 1));
    }

    function test_singleLeaf_rejectsWrongLeaf() public view {
        HTLC.Lock[] memory locks = new HTLC.Lock[](1);
        locks[0] = _lock(1);
        bytes32 root = HTLC.rootOf(locks);
        bytes32 leaf = HTLC.hashLock(_lock(2));
        bytes32[] memory proof = new bytes32[](0);
        assertFalse(_verifyExternal(leaf, root, proof, 0, 1));
    }

    function test_twoLeaves_bothAccepted() public view {
        HTLC.Lock[] memory locks = new HTLC.Lock[](2);
        locks[0] = _lock(1);
        locks[1] = _lock(2);
        bytes32 root = HTLC.rootOf(locks);
        HTLC.Lock[] memory sorted = _sortById(locks);
        for (uint256 i = 0; i < 2; i++) {
            (bytes32[] memory proof, uint256 n) = _buildProof(locks, i);
            assertTrue(_verifyExternal(HTLC.hashLock(sorted[i]), root, proof, i, n));
        }
    }

    function test_fiveLeaves_allAccepted_oddTailExercised() public view {
        HTLC.Lock[] memory locks = new HTLC.Lock[](5);
        for (uint256 i = 0; i < 5; i++) {
            locks[i] = _lock(i + 1);
        }
        bytes32 root = HTLC.rootOf(locks);
        HTLC.Lock[] memory sorted = _sortById(locks);
        for (uint256 i = 0; i < 5; i++) {
            (bytes32[] memory proof, uint256 n) = _buildProof(locks, i);
            assertTrue(_verifyExternal(HTLC.hashLock(sorted[i]), root, proof, i, n), "leaf rejected");
        }
    }

    function test_rejectsWrongIndex() public view {
        HTLC.Lock[] memory locks = new HTLC.Lock[](3);
        for (uint256 i = 0; i < 3; i++) {
            locks[i] = _lock(i + 1);
        }
        bytes32 root = HTLC.rootOf(locks);
        HTLC.Lock[] memory sorted = _sortById(locks);
        (bytes32[] memory proof, uint256 n) = _buildProof(locks, 0);
        // Submitting the proof with the wrong claimed index must fail
        assertFalse(_verifyExternal(HTLC.hashLock(sorted[0]), root, proof, 1, n));
    }

    function test_rejectsTamperedProof() public view {
        HTLC.Lock[] memory locks = new HTLC.Lock[](3);
        for (uint256 i = 0; i < 3; i++) {
            locks[i] = _lock(i + 1);
        }
        bytes32 root = HTLC.rootOf(locks);
        HTLC.Lock[] memory sorted = _sortById(locks);
        (bytes32[] memory proof, uint256 n) = _buildProof(locks, 0);
        if (proof.length > 0) {
            proof[0] = bytes32(uint256(proof[0]) ^ 1);
            assertFalse(_verifyExternal(HTLC.hashLock(sorted[0]), root, proof, 0, n));
        }
    }
}
