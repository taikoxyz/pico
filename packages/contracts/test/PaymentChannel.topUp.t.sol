// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {IPaymentChannel} from "../src/interfaces/IPaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelTopUpTest
/// @notice Coverage for `topUp` (§8 of `protocol-spec.md`). Exercises the sentinel
///         prev-state branch (Scenario 5 of `inbound-liquidity-scenarios.md`), the
///         co-signed prev-state branch, and every revert path the contract enforces.
contract PaymentChannelTopUpTest is Fixtures {
    uint256 internal constant FUND_A = 10_000_000; // alice's deposit at open
    uint256 internal constant FUND_B = 0; // hub-style one-sided open
    uint256 internal constant TOP_UP_AMOUNT = 5_000_000;

    function setUp() public {
        _deployStack();
        _fund(alice, 1_000_000_000);
        _fund(bob, 1_000_000_000);
        _fund(carol, 1_000_000_000);
    }

    /* ====================================================================== */
    /*  Happy paths                                                            */
    /* ====================================================================== */

    function test_topUp_happyPath_sentinelPrev_creditsCallerSide() public {
        // Scenario 5 step 5: hub (userB) tops up bob's channel by 5 USDC. The prev state
        // is the sentinel because the channel has no co-signed off-chain state yet.
        bytes32 id = _open();

        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        uint256 contractBefore = token.balanceOf(address(channel));
        uint256 bobBefore = token.balanceOf(bob);

        vm.expectEmit(true, true, false, true, address(channel));
        emit IPaymentChannel.ToppedUp(id, bob, TOP_UP_AMOUNT, 1);
        vm.prank(bob);
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.amountA, FUND_A);
        assertEq(ch.amountB, FUND_B + TOP_UP_AMOUNT);
        assertEq(ch.postedVersion, 1);
        assertEq(ch.postedBalanceA, FUND_A);
        assertEq(ch.postedBalanceB, FUND_B + TOP_UP_AMOUNT);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));
        assertEq(token.balanceOf(address(channel)), contractBefore + TOP_UP_AMOUNT);
        assertEq(token.balanceOf(bob), bobBefore - TOP_UP_AMOUNT);
    }

    function test_topUp_happyPath_signedPrev_creditsCallerSide() public {
        // After a first sentinel topUp brings postedVersion to 1, run a second topUp using
        // the v1 state as the now-co-signed prev. alice tops up by 3 USDC -> v2.
        bytes32 id = _open();
        _sentinelTopUpAlice(id, TOP_UP_AMOUNT);

        Adjudicator.ChannelState memory prevState = _state(id, 1, FUND_A + TOP_UP_AMOUNT, FUND_B);
        Adjudicator.SignedChannelState memory prev = Adjudicator.SignedChannelState({
            state: prevState, sigA: _signState(alicePk, prevState), sigB: _signState(bobPk, prevState)
        });
        uint256 secondAmount = 3_000_000;
        Adjudicator.ChannelState memory nextState = _state(id, 2, FUND_A + TOP_UP_AMOUNT + secondAmount, FUND_B);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        vm.expectEmit(true, true, false, true, address(channel));
        emit IPaymentChannel.ToppedUp(id, alice, secondAmount, 2);
        vm.prank(alice);
        channel.topUp(id, secondAmount, prev, next);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.amountA, FUND_A + TOP_UP_AMOUNT + secondAmount);
        assertEq(ch.amountB, FUND_B);
        assertEq(ch.postedVersion, 2);
    }

    /* ====================================================================== */
    /*  Reverts                                                                */
    /* ====================================================================== */

    function test_topUp_revertsOnNonParty() public {
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        vm.prank(carol);
        vm.expectRevert(bytes("!party"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsIfNotOpen() public {
        // After closeUnilateralFromOpen the channel status is ClosingUnilateral -> topUp must revert.
        bytes32 id = _open();
        vm.prank(alice);
        channel.closeUnilateralFromOpen(id);

        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("!open"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnPrevInconsistentHtlcTriple() public {
        // v2 accepts non-empty htlcsRoot in topUp's prevState as long as the htlc
        // triple is internally consistent. Setting only htlcsRoot trips the
        // consistency guard (formerly "prev htlcs!=0" in v1).
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        prev.state.htlcsRoot = bytes32(uint256(0xAA));
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState,
            sigA: _signState(alicePk, nextState),
            sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("htlcs root/count"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnNextVersionGap() public {
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        // next.version should be prev.version + 1 (i.e., 1); use 2 to trigger the check.
        Adjudicator.ChannelState memory nextState = _state(id, 2, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("next version"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnPrevConservationMismatch() public {
        bytes32 id = _open();
        // Build a fake prev state whose balances don't sum to amountA + amountB.
        Adjudicator.ChannelState memory bogusPrev = _state(id, 0, FUND_A + 1, FUND_B);
        Adjudicator.SignedChannelState memory prev =
            Adjudicator.SignedChannelState({state: bogusPrev, sigA: hex"", sigB: hex""});
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A + 1, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("prev !conserved"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnSentinelWithNonZeroSigs() public {
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        prev.sigA = hex"00";
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("sentinel sigs"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnSentinelWithBalanceMismatch() public {
        // Sentinel must have balanceA==amountA and balanceB==amountB; use a non-matching
        // sentinel that still satisfies the prev-conservation (sum) check but flunks the
        // sentinel-specific equality (balanceA != amountA).
        bytes32 id = _open();
        // prev sums to amountA+amountB but mismatches per-side: A=FUND_A-1, B=FUND_B+1.
        Adjudicator.ChannelState memory mismatched = _state(id, 0, FUND_A - 1, FUND_B + 1);
        Adjudicator.SignedChannelState memory prev =
            Adjudicator.SignedChannelState({state: mismatched, sigA: hex"", sigB: hex""});
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A - 1, FUND_B + 1 + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("sentinel bal"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnNextBadSig() public {
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B + TOP_UP_AMOUNT);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState,
            sigA: _signState(carolPk, nextState), // wrong signer
            sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("next bad sig"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnPrevBadSig() public {
        // Co-signed prev branch: a forged sigA fails verification, surfacing "prev bad sig".
        bytes32 id = _open();
        _sentinelTopUpAlice(id, TOP_UP_AMOUNT);
        // Now postedVersion=1; build a prev with version=1 and a bad sig.
        Adjudicator.ChannelState memory prevState = _state(id, 1, FUND_A + TOP_UP_AMOUNT, FUND_B);
        Adjudicator.SignedChannelState memory prev = Adjudicator.SignedChannelState({
            state: prevState,
            sigA: _signState(carolPk, prevState), // wrong signer
            sigB: _signState(bobPk, prevState)
        });
        Adjudicator.ChannelState memory nextState = _state(id, 2, FUND_A + TOP_UP_AMOUNT + 1_000_000, FUND_B);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(alice);
        vm.expectRevert(bytes("prev bad sig"));
        channel.topUp(id, 1_000_000, prev, next);
    }

    function test_topUp_revertsOnCounterpartyBalanceChange_BUnchanged() public {
        // alice tops up; next.balanceB must equal prev.balanceB. If we mutate B, "B unchanged"
        // fires before the conservation check.
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A + TOP_UP_AMOUNT, FUND_B + 1); // B mutated
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(alice);
        vm.expectRevert(bytes("B unchanged"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnCounterpartyBalanceChange_AUnchanged() public {
        // bob tops up; next.balanceA must equal prev.balanceA. Mutate A to trip "A unchanged".
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A + 1, FUND_B + TOP_UP_AMOUNT); // A mutated
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("A unchanged"));
        channel.topUp(id, TOP_UP_AMOUNT, prev, next);
    }

    function test_topUp_revertsOnZeroAmount() public {
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A, FUND_B);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        vm.expectRevert(bytes("amount=0"));
        channel.topUp(id, 0, prev, next);
    }

    /* ====================================================================== */
    /*  Helpers                                                                */
    /* ====================================================================== */

    function _open() internal returns (bytes32) {
        vm.prank(alice);
        return channel.openChannel(bob, address(token), FUND_A, FUND_B);
    }

    function _state(bytes32 channelId, uint64 version, uint256 balanceA, uint256 balanceB)
        internal
        pure
        returns (Adjudicator.ChannelState memory)
    {
        return Adjudicator.ChannelState({
            channelId: channelId,
            version: version,
            balanceA: balanceA,
            balanceB: balanceB,
            htlcsRoot: bytes32(0),
            htlcsCount: 0,
            htlcsTotalLocked: 0,
            finalized: false
        });
    }

    function _sentinelPrev(bytes32 id) internal view returns (Adjudicator.SignedChannelState memory) {
        PaymentChannel.Channel memory ch = channel.channels(id);
        return Adjudicator.SignedChannelState({state: _state(id, 0, ch.amountA, ch.amountB), sigA: hex"", sigB: hex""});
    }

    function _sentinelTopUpAlice(bytes32 id, uint256 amount) internal {
        PaymentChannel.Channel memory ch = channel.channels(id);
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, ch.amountA + amount, ch.amountB);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });
        vm.prank(alice);
        channel.topUp(id, amount, prev, next);
    }
}
