// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelDrainAttacksTest
/// @notice Scenario 9 of `inbound-liquidity-scenarios.md`: drain attacks against the hub.
///         Verifies the two attack classes that an earlier (segregated-balance) design
///         would have permitted are eliminated by construction in the topUp model.
contract PaymentChannelDrainAttacksTest is Fixtures {
    uint256 internal constant FUND_A = 10_000_000;

    function setUp() public {
        _deployStack();
        _fund(alice, 1_000_000_000);
        _fund(bob, 1_000_000_000);
        _fund(carol, 1_000_000_000);
    }

    /// @notice 9.1 — Attacker (carol) calls `openChannel(bob /*hub*/, USDC, 0, 50_000_000)`.
    ///         The hub never grants any standing PaymentChannel allowance for the open
    ///         path, so `safeTransferFrom(bob, contract, 50_000_000)` reverts on
    ///         insufficient allowance. We model "no standing allowance" by having the
    ///         hub revoke its approval before the attack.
    function test_drain_openChannel_failsWithoutHubAllowance() public {
        // Revoke bob's (the "hub") allowance to simulate the production "no standing
        // allowance" invariant. _fund() granted max approval at setUp.
        vm.prank(bob);
        token.approve(address(channel), 0);

        vm.prank(carol);
        vm.expectRevert();
        channel.openChannel(bob, address(token), 0, 50_000_000);
    }

    /// @notice 9.2 — Attacker calls `topUp` against a channel they're not in. The
    ///         contract requires `msg.sender == userA || msg.sender == userB`, so
    ///         carol's call against alice/bob's channel reverts immediately.
    function test_drain_topUp_revertsOnNonParty() public {
        bytes32 id = _open();

        Adjudicator.SignedChannelState memory prev = Adjudicator.SignedChannelState({
            state: Adjudicator.ChannelState({
                channelId: id, version: 0, balanceA: FUND_A, balanceB: 0, htlcsRoot: bytes32(0), htlcsCount: 0, htlcsTotalLocked: 0, finalized: false
            }),
            sigA: hex"",
            sigB: hex""
        });
        Adjudicator.ChannelState memory nextState = Adjudicator.ChannelState({
            channelId: id, version: 1, balanceA: FUND_A, balanceB: 5_000_000, htlcsRoot: bytes32(0), htlcsCount: 0, htlcsTotalLocked: 0, finalized: false
        });
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        vm.prank(carol);
        vm.expectRevert(bytes("!party"));
        channel.topUp(id, 5_000_000, prev, next);
    }

    /// @notice The topUp credit always lands on `msg.sender`'s side regardless of which
    ///         party the (signed) state authorises. Even if alice signs a state where
    ///         bob's balance increases, alice's `topUp` call must revert because the
    ///         contract enforces "alice is msg.sender therefore alice's side increases
    ///         by exactly amount" — so a signed-but-malicious state would flunk the
    ///         per-side delta check ("A delta" or "B unchanged"). Demonstrates that the
    ///         contract pulls funds from msg.sender and credits msg.sender's side only.
    function test_drain_topUp_creditsCallerSide_evenWhenSigsAuthorizeOther() public {
        bytes32 id = _open();

        Adjudicator.SignedChannelState memory prev = Adjudicator.SignedChannelState({
            state: Adjudicator.ChannelState({
                channelId: id, version: 0, balanceA: FUND_A, balanceB: 0, htlcsRoot: bytes32(0), htlcsCount: 0, htlcsTotalLocked: 0, finalized: false
            }),
            sigA: hex"",
            sigB: hex""
        });
        // A "trick" next state with B credited rather than A. msg.sender will be alice,
        // who therefore expects A to be credited; the contract's "A delta" check fires.
        Adjudicator.ChannelState memory nextState = Adjudicator.ChannelState({
            channelId: id, version: 1, balanceA: FUND_A, balanceB: 5_000_000, htlcsRoot: bytes32(0), htlcsCount: 0, htlcsTotalLocked: 0, finalized: false
        });
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        vm.prank(alice);
        vm.expectRevert(bytes("A delta"));
        channel.topUp(id, 5_000_000, prev, next);

        // Conversely, if bob calls with the same (B-credited) next, the contract accepts it
        // because bob is msg.sender — funds flow from bob, not alice.
        uint256 aliceBalBefore = token.balanceOf(alice);
        vm.prank(bob);
        channel.topUp(id, 5_000_000, prev, next);
        // alice's wallet is untouched — no funds were pulled from her side.
        assertEq(token.balanceOf(alice), aliceBalBefore);
        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.amountA, FUND_A);
        assertEq(ch.amountB, 5_000_000);
    }

    function _open() internal returns (bytes32) {
        vm.prank(alice);
        return channel.openChannel(bob, address(token), FUND_A, 0);
    }
}
