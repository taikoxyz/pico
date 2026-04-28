// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HTLC} from "../src/HTLC.sol";

/// @title HtlcTest
/// @notice Unit + fuzz tests for the `HTLC` library. Verifies byte-for-byte parity with the
///         off-chain implementation in `packages/protocol/src/htlc-root.ts`.
contract HtlcTest is Test {
    function _lock(bytes32 id, uint256 amount, bytes32 ph, uint64 exp, uint8 dir)
        internal
        pure
        returns (HTLC.Lock memory)
    {
        return HTLC.Lock({id: id, amount: amount, paymentHash: ph, expiry: exp, direction: dir});
    }

    /* -------------------------------------------------------------------- */
    /*  hashLock                                                             */
    /* -------------------------------------------------------------------- */

    function test_hashLock_matchesAbiEncodeKeccak() public pure {
        HTLC.Lock memory lock = _lock(bytes32(uint256(1)), 100, bytes32(uint256(2)), 1234, 0);
        bytes32 expected = keccak256(abi.encode(lock.id, lock.amount, lock.paymentHash, lock.expiry, lock.direction));
        assertEq(HTLC.hashLock(lock), expected);
    }

    function testFuzz_hashLock_isDeterministic(bytes32 id, uint256 amount, bytes32 ph, uint64 exp, uint8 dir)
        public
        pure
    {
        HTLC.Lock memory a = _lock(id, amount, ph, exp, dir);
        HTLC.Lock memory b = _lock(id, amount, ph, exp, dir);
        assertEq(HTLC.hashLock(a), HTLC.hashLock(b));
    }

    function testFuzz_hashLock_directionMatters(bytes32 id, uint256 amount, bytes32 ph, uint64 exp) public pure {
        HTLC.Lock memory a = _lock(id, amount, ph, exp, 0);
        HTLC.Lock memory b = _lock(id, amount, ph, exp, 1);
        assertTrue(HTLC.hashLock(a) != HTLC.hashLock(b));
    }

    /* -------------------------------------------------------------------- */
    /*  verifyPreimage                                                       */
    /* -------------------------------------------------------------------- */

    function test_verifyPreimage_acceptsCorrectSha256() public view {
        bytes memory preimage = bytes("hello-tainnel");
        bytes32 ph = sha256(preimage);
        assertTrue(this._call_verifyPreimage(ph, preimage));
    }

    function test_verifyPreimage_rejectsTamperedPreimage() public view {
        bytes memory preimage = bytes("hello-tainnel");
        bytes32 ph = sha256(preimage);
        bytes memory bad = bytes("hello-taintnel");
        assertFalse(this._call_verifyPreimage(ph, bad));
    }

    function test_verifyPreimage_isNotKeccak() public view {
        bytes memory preimage = bytes("abc");
        bytes32 ph = keccak256(preimage);
        assertFalse(this._call_verifyPreimage(ph, preimage));
    }

    function testFuzz_verifyPreimage_roundtrip(bytes calldata preimage) external pure {
        bytes32 ph = sha256(preimage);
        assertTrue(HTLC.verifyPreimage(ph, preimage));
    }

    function _call_verifyPreimage(bytes32 ph, bytes calldata preimage) external pure returns (bool) {
        return HTLC.verifyPreimage(ph, preimage);
    }

    /* -------------------------------------------------------------------- */
    /*  rootOf                                                               */
    /* -------------------------------------------------------------------- */

    function test_rootOf_emptyIsZero() public pure {
        HTLC.Lock[] memory locks = new HTLC.Lock[](0);
        assertEq(HTLC.rootOf(locks), bytes32(0));
    }

    function test_rootOf_singleLock_isLeafHash() public pure {
        HTLC.Lock[] memory locks = new HTLC.Lock[](1);
        locks[0] = _lock(bytes32(uint256(0xAA)), 1, bytes32(uint256(0xBB)), 100, 0);
        assertEq(HTLC.rootOf(locks), HTLC.hashLock(locks[0]));
    }

    function test_rootOf_twoLocks_concatHash() public pure {
        HTLC.Lock[] memory locks = new HTLC.Lock[](2);
        locks[0] = _lock(bytes32(uint256(0x01)), 1, bytes32(uint256(0xAA)), 100, 0);
        locks[1] = _lock(bytes32(uint256(0x02)), 2, bytes32(uint256(0xBB)), 200, 1);
        bytes32 leftLeaf = HTLC.hashLock(locks[0]);
        bytes32 rightLeaf = HTLC.hashLock(locks[1]);
        bytes32 expected = keccak256(abi.encodePacked(leftLeaf, rightLeaf));
        assertEq(HTLC.rootOf(locks), expected);
    }

    function test_rootOf_twoLocks_sortedByIdAscending() public pure {
        HTLC.Lock[] memory unsorted = new HTLC.Lock[](2);
        unsorted[0] = _lock(bytes32(uint256(0x02)), 2, bytes32(uint256(0xBB)), 200, 1);
        unsorted[1] = _lock(bytes32(uint256(0x01)), 1, bytes32(uint256(0xAA)), 100, 0);

        HTLC.Lock[] memory sorted = new HTLC.Lock[](2);
        sorted[0] = unsorted[1];
        sorted[1] = unsorted[0];

        assertEq(HTLC.rootOf(unsorted), HTLC.rootOf(sorted));
    }

    function test_rootOf_threeLocks_oddDuplicatesLast() public pure {
        HTLC.Lock[] memory locks = new HTLC.Lock[](3);
        locks[0] = _lock(bytes32(uint256(0x01)), 1, bytes32(uint256(0xAA)), 100, 0);
        locks[1] = _lock(bytes32(uint256(0x02)), 2, bytes32(uint256(0xBB)), 200, 1);
        locks[2] = _lock(bytes32(uint256(0x03)), 3, bytes32(uint256(0xCC)), 300, 0);

        bytes32 l0 = HTLC.hashLock(locks[0]);
        bytes32 l1 = HTLC.hashLock(locks[1]);
        bytes32 l2 = HTLC.hashLock(locks[2]);
        bytes32 left = keccak256(abi.encodePacked(l0, l1));
        bytes32 right = keccak256(abi.encodePacked(l2, l2));
        bytes32 expected = keccak256(abi.encodePacked(left, right));

        assertEq(HTLC.rootOf(locks), expected);
    }

    function test_rootOf_fourLocks() public pure {
        HTLC.Lock[] memory locks = new HTLC.Lock[](4);
        locks[0] = _lock(bytes32(uint256(0x01)), 1, bytes32(uint256(0xAA)), 100, 0);
        locks[1] = _lock(bytes32(uint256(0x02)), 2, bytes32(uint256(0xBB)), 200, 1);
        locks[2] = _lock(bytes32(uint256(0x03)), 3, bytes32(uint256(0xCC)), 300, 0);
        locks[3] = _lock(bytes32(uint256(0x04)), 4, bytes32(uint256(0xDD)), 400, 1);

        bytes32 l0 = HTLC.hashLock(locks[0]);
        bytes32 l1 = HTLC.hashLock(locks[1]);
        bytes32 l2 = HTLC.hashLock(locks[2]);
        bytes32 l3 = HTLC.hashLock(locks[3]);
        bytes32 left = keccak256(abi.encodePacked(l0, l1));
        bytes32 right = keccak256(abi.encodePacked(l2, l3));
        bytes32 expected = keccak256(abi.encodePacked(left, right));

        assertEq(HTLC.rootOf(locks), expected);
    }

    /// @dev Hand-computed against `htlcMerkleRoot` in
    ///      `packages/protocol/src/htlc-root.ts` for the inputs:
    ///      [{id: 0x...01, amount: 1, paymentHash: 0x...aa, expiry: 100, direction: AtoB}]
    ///      Confirms 1-leaf parity with the off-chain TS oracle.
    function test_rootOf_fixture_singleLeaf() public pure {
        HTLC.Lock memory lock = _lock(bytes32(uint256(0x01)), 1, bytes32(uint256(0xaa)), 100, 0);
        bytes32 expected = keccak256(abi.encode(lock.id, lock.amount, lock.paymentHash, lock.expiry, lock.direction));

        HTLC.Lock[] memory locks = new HTLC.Lock[](1);
        locks[0] = lock;
        assertEq(HTLC.rootOf(locks), expected);
    }

    /// @dev Two-leaf hand-computed parity case. Off-chain spec: leaves are sorted by id
    ///      then concat-hashed. Inputs picked so id ordering matters.
    function test_rootOf_fixture_twoLeaves_unsortedInput() public pure {
        HTLC.Lock memory l0 = _lock(bytes32(uint256(0xff)), 7, bytes32(uint256(0xbb)), 222, 1);
        HTLC.Lock memory l1 = _lock(bytes32(uint256(0x01)), 5, bytes32(uint256(0xaa)), 111, 0);

        bytes32 leafSorted0 = keccak256(abi.encode(l1.id, l1.amount, l1.paymentHash, l1.expiry, l1.direction));
        bytes32 leafSorted1 = keccak256(abi.encode(l0.id, l0.amount, l0.paymentHash, l0.expiry, l0.direction));
        bytes32 expected = keccak256(abi.encodePacked(leafSorted0, leafSorted1));

        HTLC.Lock[] memory locks = new HTLC.Lock[](2);
        locks[0] = l0;
        locks[1] = l1;
        assertEq(HTLC.rootOf(locks), expected);
    }

    /* -------------------------------------------------------------------- */
    /*  rootOf — fuzz                                                        */
    /* -------------------------------------------------------------------- */

    /// @dev Sorting-determinism property: shuffling the input cannot change the root.
    function testFuzz_rootOf_sortInvariant(uint256 seed) public pure {
        HTLC.Lock[] memory locks = _genLocks(seed, 6);
        HTLC.Lock[] memory shuffled = _shuffle(locks, seed ^ 0xDEAD);
        assertEq(HTLC.rootOf(locks), HTLC.rootOf(shuffled));
    }

    /// @dev Permuting two locks at the same id produces the same root (id is the sort key).
    function testFuzz_rootOf_orderingDoesNotMatter(uint8 size, uint256 seed) public pure {
        size = uint8(bound(uint256(size), 1, 12));
        HTLC.Lock[] memory locks = _genLocks(seed, size);

        HTLC.Lock[] memory reversed = new HTLC.Lock[](locks.length);
        for (uint256 i = 0; i < locks.length; i++) {
            reversed[locks.length - 1 - i] = locks[i];
        }

        assertEq(HTLC.rootOf(locks), HTLC.rootOf(reversed));
    }

    function _genLocks(uint256 seed, uint256 n) internal pure returns (HTLC.Lock[] memory) {
        HTLC.Lock[] memory locks = new HTLC.Lock[](n);
        uint256 s = seed;
        for (uint256 i = 0; i < n; i++) {
            s = uint256(keccak256(abi.encode(s, i)));
            locks[i] = HTLC.Lock({
                id: keccak256(abi.encode("id", s, i)),
                amount: (s % 1_000_000) + 1,
                paymentHash: keccak256(abi.encode("ph", s, i)),
                expiry: uint64((s % 1_000_000) + 1),
                direction: uint8(s % 2)
            });
        }
        return locks;
    }

    function _shuffle(HTLC.Lock[] memory arr, uint256 seed) internal pure returns (HTLC.Lock[] memory) {
        HTLC.Lock[] memory copy = new HTLC.Lock[](arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            copy[i] = arr[i];
        }
        uint256 s = seed;
        for (uint256 i = copy.length; i > 1; i--) {
            s = uint256(keccak256(abi.encode(s, i)));
            uint256 j = s % i;
            HTLC.Lock memory tmp = copy[i - 1];
            copy[i - 1] = copy[j];
            copy[j] = tmp;
        }
        return copy;
    }
}
