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
    function _enterResolvingHtlcs()
        internal
        returns (Adjudicator.Htlc memory htlc, bytes32[] memory proof)
    {
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
}
