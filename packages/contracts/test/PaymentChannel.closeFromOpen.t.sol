// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {IPaymentChannel} from "../src/interfaces/IPaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelCloseFromOpenTest
/// @notice Coverage for `closeUnilateralFromOpen` (§5.2 of `protocol-spec.md`,
///         Scenario 11 of `inbound-liquidity-scenarios.md`). The "anti-hostage" path
///         that lets a freshly-opened depositor recover their funds even if the
///         counterparty refuses to co-sign any state.
contract PaymentChannelCloseFromOpenTest is Fixtures {
    uint256 internal constant FUND_A = 10_000_000;
    uint256 internal constant FUND_B = 0;

    function setUp() public {
        _deployStack();
        _fund(alice, 1_000_000_000);
        _fund(bob, 1_000_000_000);
        _fund(carol, 1_000_000_000);
    }

    function test_closeUnilateralFromOpen_happyPath_finalizesFullDeposit() public {
        bytes32 id = _open();

        uint64 ts = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true, address(channel));
        emit IPaymentChannel.ChannelClosingUnilateral(id, 0, ts + channel.DISPUTE_WINDOW());
        vm.prank(alice);
        channel.closeUnilateralFromOpen(id);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.ClosingUnilateral));
        assertEq(ch.postedVersion, 0);
        assertEq(ch.postedBalanceA, FUND_A);
        assertEq(ch.postedBalanceB, FUND_B);
        assertEq(ch.closer, alice);

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);
        vm.expectEmit(true, false, false, true, address(channel));
        emit IPaymentChannel.ChannelFinalized(id, FUND_A, FUND_B);
        channel.finalize(id);

        // Caller (alice) deposited FUND_A and gets FUND_A back; bob deposited 0, gets 0.
        assertEq(token.balanceOf(alice), balA0 + FUND_A);
        assertEq(token.balanceOf(bob), balB0 + FUND_B);
        assertEq(uint256(channel.channels(id).status), uint256(PaymentChannel.Status.Closed));
    }

    function test_closeUnilateralFromOpen_calledByCounterparty_returnsToOriginalSides() public {
        // Same as above, but bob (counterparty / hub) calls. The implicit balances still
        // reflect the on-chain amounts (alice=FUND_A, bob=FUND_B).
        bytes32 id = _open();
        vm.prank(bob);
        channel.closeUnilateralFromOpen(id);

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);
        channel.finalize(id);
        assertEq(token.balanceOf(alice), balA0 + FUND_A);
        assertEq(token.balanceOf(bob), balB0 + FUND_B);
    }

    function test_closeUnilateralFromOpen_revertsIfNotOpen() public {
        bytes32 id = _open();
        vm.prank(alice);
        channel.closeUnilateralFromOpen(id);
        // Already in ClosingUnilateral now; second call must revert.
        vm.prank(alice);
        vm.expectRevert(bytes("!open"));
        channel.closeUnilateralFromOpen(id);
    }

    function test_closeUnilateralFromOpen_revertsIfPostedVersionNonZero() public {
        // Run a topUp first to bump postedVersion to 1, then closeUnilateralFromOpen must revert.
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = Adjudicator.SignedChannelState({
            state: Adjudicator.ChannelState({
                channelId: id,
                version: 0,
                balanceA: FUND_A,
                balanceB: FUND_B,
                htlcsRoot: bytes32(0),
                finalized: false
            }),
            sigA: hex"",
            sigB: hex""
        });
        Adjudicator.ChannelState memory nextState = Adjudicator.ChannelState({
            channelId: id,
            version: 1,
            balanceA: FUND_A,
            balanceB: FUND_B + 5_000_000,
            htlcsRoot: bytes32(0),
            finalized: false
        });
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState,
            sigA: _signState(alicePk, nextState),
            sigB: _signState(bobPk, nextState)
        });
        vm.prank(bob);
        channel.topUp(id, 5_000_000, prev, next);

        vm.prank(alice);
        vm.expectRevert(bytes("posted!=0"));
        channel.closeUnilateralFromOpen(id);
    }

    function test_closeUnilateralFromOpen_revertsOnNonParty() public {
        bytes32 id = _open();
        vm.prank(carol);
        vm.expectRevert(bytes("!party"));
        channel.closeUnilateralFromOpen(id);
    }

    function _open() internal returns (bytes32) {
        vm.prank(alice);
        return channel.openChannel(bob, address(token), FUND_A, FUND_B);
    }
}
