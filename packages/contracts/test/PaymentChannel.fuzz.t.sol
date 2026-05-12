// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelFuzzTest
/// @notice Property tests for the channel core: open/close/finalize commute with arbitrary
///         (but conserved) balance splits and arbitrary signed states from valid keys.
contract PaymentChannelFuzzTest is Fixtures {
    uint256 internal constant MIN = 10_000_000;
    uint256 internal constant CAP = 1_000_000_000_000;

    function setUp() public {
        _deployStack();
        _fund(alice, type(uint96).max);
        _fund(bob, type(uint96).max);
    }

    function testFuzz_openChannel_anyValidAmounts(uint256 amountA, uint256 amountB) public {
        amountA = bound(amountA, 0, CAP);
        amountB = bound(amountB, 0, CAP);
        vm.assume(amountA + amountB >= MIN);

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), amountA, amountB);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.amountA, amountA);
        assertEq(ch.amountB, amountB);
        assertEq(token.balanceOf(address(channel)), amountA + amountB);
    }

    function testFuzz_closeCooperative_conservedSplit(uint256 amountA, uint256 amountB, uint256 splitSeed) public {
        amountA = bound(amountA, 0, CAP);
        amountB = bound(amountB, 0, CAP);
        vm.assume(amountA + amountB >= MIN);

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), amountA, amountB);

        uint256 total = amountA + amountB;
        uint256 finalA = total == 0 ? 0 : (splitSeed % (total + 1));
        uint256 finalB = total - finalA;

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            version: 1,
            finalBalanceA: finalA,
            finalBalanceB: finalB,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);

        assertEq(token.balanceOf(alice), balA0 + finalA);
        assertEq(token.balanceOf(bob), balB0 + finalB);
    }

    function testFuzz_closeCooperative_revertsOnNonConserved(uint256 amountA, uint256 amountB, uint256 attackerA)
        public
    {
        amountA = bound(amountA, MIN, CAP);
        amountB = bound(amountB, 0, CAP);
        attackerA = bound(attackerA, amountA + amountB + 1, type(uint128).max);

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), amountA, amountB);

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            version: 1,
            finalBalanceA: attackerA,
            finalBalanceB: 0,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);

        vm.expectRevert(bytes("!conserved"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);
    }

    function testFuzz_dispute_alwaysReplacesIfStrictlyNewer(uint64 startV, uint64 deltaV) public {
        startV = uint64(bound(uint256(startV), 1, type(uint32).max));
        deltaV = uint64(bound(uint256(deltaV), 1, type(uint32).max));

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), 50_000_000, 30_000_000);

        Adjudicator.ChannelState memory startState = _state(id, startV, 50_000_000, 30_000_000);
        bytes memory sigB = _signState(bobPk, startState);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(startState), sigB);

        // A valid dispute requires both parties' signatures on the newer state.
        Adjudicator.ChannelState memory next = _state(id, startV + deltaV, 1, 79_999_999);
        bytes memory sigA = _signState(alicePk, next);
        bytes memory sigB2 = _signState(bobPk, next);
        channel.dispute(id, abi.encode(next), sigA, sigB2);

        assertEq(channel.channels(id).postedVersion, startV + deltaV);
    }

    function testFuzz_dispute_rejectsSinglePartySignature(uint64 startV, uint64 deltaV, uint256 splitSeed) public {
        startV = uint64(bound(uint256(startV), 1, type(uint32).max));
        deltaV = uint64(bound(uint256(deltaV), 1, type(uint32).max));

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), 50_000_000, 30_000_000);

        Adjudicator.ChannelState memory startState = _state(id, startV, 50_000_000, 30_000_000);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(startState), _signState(bobPk, startState));

        uint256 finalA = splitSeed % 80_000_001;
        uint256 finalB = 80_000_000 - finalA;
        Adjudicator.ChannelState memory forged = _state(id, startV + deltaV, finalA, finalB);

        // Single-party signatures (from either side) must be rejected.
        bytes memory sigBobOnly = _signState(bobPk, forged);
        vm.expectRevert(bytes("bad sig"));
        channel.dispute(id, abi.encode(forged), hex"", sigBobOnly);
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
}
