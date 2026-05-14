// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {HTLC} from "../src/HTLC.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannel.htlcSettlement
/// @notice Foundry coverage for the v2 on-chain HTLC settlement surface:
///         claimHtlc, refundHtlc, the ResolvingHtlcs phase transition in
///         finalize, and the penalty short-circuit.
contract PaymentChannelHtlcSettlementTest is Fixtures {
    bytes32 internal constant PREIMAGE_AB =
        bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    bytes32 internal constant PAYMENT_HASH_AB = sha256(abi.encodePacked(PREIMAGE_AB));

    uint256 internal constant FUND_A = 10_000_000; // 10 USDC
    uint256 internal constant FUND_B = 10_000_000;
    uint256 internal constant HTLC_AMOUNT = 1_000_000; // 1 USDC

    bytes32 internal channelId;

    function setUp() public {
        _deployStack();
        _fund(alice, FUND_A);
        _fund(bob, FUND_B);
        vm.prank(alice);
        channelId = channel.openChannel(bob, address(token), FUND_A, FUND_B);
    }

    /// @dev Build an HTLC + a dual-signed state with `htlcsCount=1, htlcsTotalLocked=HTLC_AMOUNT`,
    ///      then post it via closeUnilateral and roll into ResolvingHtlcs.
    function _enterResolvingHtlcs() internal returns (Adjudicator.Htlc memory htlc, bytes32[] memory proof) {
        // Expiry must outlast the 24h dispute window so claim is still admissible
        // after `vm.warp` rolls past the deadline below.
        htlc = Adjudicator.Htlc({
            id: bytes32(uint256(0xAA)),
            amount: HTLC_AMOUNT,
            paymentHash: PAYMENT_HASH_AB,
            expiry: uint64(block.timestamp + channel.DISPUTE_WINDOW() + 30 minutes),
            direction: 0 // AtoB
        });

        Adjudicator.ChannelState memory s = Adjudicator.ChannelState({
            channelId: channelId,
            version: 1,
            balanceA: FUND_A - HTLC_AMOUNT,
            balanceB: FUND_B,
            htlcsRoot: _singleLeafRoot(htlc),
            htlcsCount: 1,
            htlcsTotalLocked: HTLC_AMOUNT,
            finalized: false
        });

        bytes memory sigB = _signState(bobPk, s);

        vm.prank(alice);
        channel.closeUnilateral(channelId, abi.encode(s), sigB);

        vm.warp(block.timestamp + channel.DISPUTE_WINDOW() + 1);
        channel.finalize(channelId); // transitions to ResolvingHtlcs

        proof = new bytes32[](0); // single-leaf tree
    }

    function _singleLeafRoot(Adjudicator.Htlc memory htlc) internal pure returns (bytes32) {
        HTLC.Lock memory lock = HTLC.Lock({
            id: htlc.id,
            amount: htlc.amount,
            paymentHash: htlc.paymentHash,
            expiry: htlc.expiry,
            direction: htlc.direction
        });
        return HTLC.hashLock(lock);
    }

    /* -------------------------------------------------------------------- */
    /*  claimHtlc                                                            */
    /* -------------------------------------------------------------------- */

    function test_claimHtlc_happyPath_creditsReceiverAndFinalizes() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();

        uint256 bobBalBefore = token.balanceOf(bob);

        channel.claimHtlc(channelId, htlc, proof, 0, 1, abi.encodePacked(PREIMAGE_AB));

        // htlcsCount drained -> finalize pays out
        channel.finalize(channelId);

        vm.prank(alice);
        channel.withdraw(address(token));
        vm.prank(bob);
        channel.withdraw(address(token));

        assertEq(token.balanceOf(bob), bobBalBefore + FUND_B + HTLC_AMOUNT, "bob payout");
        assertEq(token.balanceOf(alice), FUND_A - HTLC_AMOUNT, "alice payout");
    }

    function test_claimHtlc_rejectsBadPreimage() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();
        vm.expectRevert(bytes("preimage"));
        channel.claimHtlc(channelId, htlc, proof, 0, 1, abi.encodePacked(bytes32(uint256(0xDEAD))));
    }

    function test_claimHtlc_rejectsAfterExpiry() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();
        vm.warp(htlc.expiry + 1);
        vm.expectRevert(bytes("expired"));
        channel.claimHtlc(channelId, htlc, proof, 0, 1, abi.encodePacked(PREIMAGE_AB));
    }

    function test_claimHtlc_rejectsDoubleClaim() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();
        channel.claimHtlc(channelId, htlc, proof, 0, 1, abi.encodePacked(PREIMAGE_AB));
        vm.expectRevert(bytes("resolved"));
        channel.claimHtlc(channelId, htlc, proof, 0, 1, abi.encodePacked(PREIMAGE_AB));
    }

    function test_claimHtlc_rejectsBadProof() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();
        // mutate the htlc so the leaf no longer matches the posted root
        htlc.amount = HTLC_AMOUNT + 1;
        vm.expectRevert(bytes("bad proof"));
        channel.claimHtlc(channelId, htlc, proof, 0, 1, abi.encodePacked(PREIMAGE_AB));
    }

    /* -------------------------------------------------------------------- */
    /*  refundHtlc                                                           */
    /* -------------------------------------------------------------------- */

    function test_refundHtlc_happyPath_creditsSender() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();

        vm.warp(htlc.expiry + 1);
        channel.refundHtlc(channelId, htlc, proof, 0, 1);
        channel.finalize(channelId);

        vm.prank(alice);
        channel.withdraw(address(token));
        vm.prank(bob);
        channel.withdraw(address(token));

        // alice (sender) is refunded the locked amount
        assertEq(token.balanceOf(alice), FUND_A, "alice refunded");
        assertEq(token.balanceOf(bob), FUND_B, "bob unchanged");
    }

    function test_refundHtlc_rejectsBeforeExpiry() public {
        (Adjudicator.Htlc memory htlc, bytes32[] memory proof) = _enterResolvingHtlcs();
        vm.expectRevert(bytes("!expired"));
        channel.refundHtlc(channelId, htlc, proof, 0, 1);
    }

    /* -------------------------------------------------------------------- */
    /*  finalize                                                             */
    /* -------------------------------------------------------------------- */

    function test_finalize_blockedWhileHtlcsPending() public {
        _enterResolvingHtlcs();
        vm.expectRevert(bytes("htlcs pending"));
        channel.finalize(channelId);
    }

    /* -------------------------------------------------------------------- */
    /*  Audit fixes — H1 / H2 / H3                                          */
    /* -------------------------------------------------------------------- */

    /// @dev H1: a malicious state can sign an HTLC with `expiry` far beyond
    ///      `MAX_HTLC_DURATION`. Without the resolution-deadline escape hatch,
    ///      neither claim nor refund would be admissible inside the window, and
    ///      `finalize` would refuse to settle ("htlcs pending"). The grace
    ///      deadline (`block.timestamp + MAX_HTLC_DURATION + HTLC_RESOLUTION_GRACE`)
    ///      provides a forced-refund path back to the sender.
    function test_refundHtlc_forcedAfterResolutionDeadline() public {
        // Build the HTLC with an expiry beyond the resolution deadline.
        uint64 farFutureExpiry = uint64(block.timestamp + 100 * 365 days);
        Adjudicator.Htlc memory htlc = Adjudicator.Htlc({
            id: bytes32(uint256(0xBEEF)),
            amount: HTLC_AMOUNT,
            paymentHash: PAYMENT_HASH_AB,
            expiry: farFutureExpiry,
            direction: 0
        });
        Adjudicator.ChannelState memory s = Adjudicator.ChannelState({
            channelId: channelId,
            version: 1,
            balanceA: FUND_A - HTLC_AMOUNT,
            balanceB: FUND_B,
            htlcsRoot: _singleLeafRoot(htlc),
            htlcsCount: 1,
            htlcsTotalLocked: HTLC_AMOUNT,
            finalized: false
        });

        vm.prank(alice);
        channel.closeUnilateral(channelId, abi.encode(s), _signState(bobPk, s));
        vm.warp(block.timestamp + channel.DISPUTE_WINDOW() + 1);
        channel.finalize(channelId); // enter ResolvingHtlcs

        // Before the grace deadline, refund still refuses (expiry is far away).
        vm.expectRevert(bytes("!expired"));
        channel.refundHtlc(channelId, htlc, new bytes32[](0), 0, 1);

        // After the grace deadline, anyone can sweep the HTLC back to the sender.
        vm.warp(block.timestamp + channel.MAX_HTLC_DURATION() + channel.HTLC_RESOLUTION_GRACE() + 1);
        channel.refundHtlc(channelId, htlc, new bytes32[](0), 0, 1);
        channel.finalize(channelId);

        vm.prank(alice);
        channel.withdraw(address(token));
        vm.prank(bob);
        channel.withdraw(address(token));

        assertEq(token.balanceOf(alice), FUND_A, "alice refunded");
        assertEq(token.balanceOf(bob), FUND_B, "bob unchanged");
    }

    /// @dev H2: an HTLC with `direction > 1` was previously treated as BtoA in the
    ///      payout ternary; the new defense-in-depth check rejects at proof
    ///      verification time. The state would never reach this point under the
    ///      off-chain protocol, but the contract must not trust that.
    function test_claimHtlc_rejectsInvalidDirectionByte() public {
        Adjudicator.Htlc memory htlc = Adjudicator.Htlc({
            id: bytes32(uint256(0xCAFE)),
            amount: HTLC_AMOUNT,
            paymentHash: PAYMENT_HASH_AB,
            expiry: uint64(block.timestamp + channel.DISPUTE_WINDOW() + 30 minutes),
            direction: 7 // intentionally out of {0, 1}
        });
        Adjudicator.ChannelState memory s = Adjudicator.ChannelState({
            channelId: channelId,
            version: 1,
            balanceA: FUND_A - HTLC_AMOUNT,
            balanceB: FUND_B,
            htlcsRoot: _singleLeafRoot(htlc),
            htlcsCount: 1,
            htlcsTotalLocked: HTLC_AMOUNT,
            finalized: false
        });

        vm.prank(alice);
        channel.closeUnilateral(channelId, abi.encode(s), _signState(bobPk, s));
        vm.warp(block.timestamp + channel.DISPUTE_WINDOW() + 1);
        channel.finalize(channelId);

        vm.expectRevert(bytes("direction"));
        channel.claimHtlc(channelId, htlc, new bytes32[](0), 0, 1, abi.encodePacked(PREIMAGE_AB));
    }

    /// @dev H3 is defense-in-depth: the `require(ch.htlcsCount == 0)` guard in
    ///      `closeUnilateralFromOpen` fires only on protocol-unreachable states
    ///      (a version-0 channel can never carry HTLCs because `openChannel`
    ///      zeros the field and `topUp` blocks any change to the HTLC set).
    ///      Synthesizing such a state in Foundry requires precise per-channel
    ///      struct-slot poking that depends on OZ inheritance layout; we skip
    ///      a positive negative-path test because the protocol-reachable
    ///      happy paths in `PaymentChannel.closeFromOpen.t.sol` already cover
    ///      every scenario that could reach the guarded statement.
}
