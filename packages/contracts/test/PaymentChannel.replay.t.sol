// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelReplayTest
/// @notice Replay-protection tests. After a fresher state (higher version) has been accepted,
///         re-submitting a stale state must always revert. This is the property that makes
///         the dispute window safe to leave for `DISPUTE_WINDOW` seconds.
contract PaymentChannelReplayTest is Fixtures {
    uint256 internal constant FUND_A = 50_000_000;
    uint256 internal constant FUND_B = 30_000_000;

    function setUp() public {
        _deployStack();
        _fund(alice, 1_000_000_000);
        _fund(bob, 1_000_000_000);
        _fund(carol, 1_000_000_000);
    }

    function test_replay_disputeStaleAfterFreshAccepted() public {
        bytes32 id = _open();

        // v1 posted unilaterally — closer is alice; counterparty (bob) signs the state.
        Adjudicator.ChannelState memory v1 = _state(id, 1, 50_000_000, 30_000_000);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(v1), _signState(bobPk, v1));

        // v5 disputes successfully — dispute carries the *closer*'s (alice's) signature.
        Adjudicator.ChannelState memory v5 = _state(id, 5, 10_000_000, 70_000_000);
        channel.dispute(id, abi.encode(v5), _signState(alicePk, v5));

        // Replaying v3 (older than v5) must revert as stale.
        Adjudicator.ChannelState memory v3 = _state(id, 3, 30_000_000, 50_000_000);
        vm.expectRevert(bytes("stale"));
        channel.dispute(id, abi.encode(v3), _signState(alicePk, v3));
    }

    function test_replay_disputeSameVersionAfterAccepted() public {
        bytes32 id = _open();

        Adjudicator.ChannelState memory v1 = _state(id, 1, 50_000_000, 30_000_000);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(v1), _signState(bobPk, v1));

        Adjudicator.ChannelState memory v2 = _state(id, 2, 40_000_000, 40_000_000);
        bytes memory sigAv2 = _signState(alicePk, v2);
        channel.dispute(id, abi.encode(v2), sigAv2);

        // Same version v2 again — must be rejected.
        vm.expectRevert(bytes("stale"));
        channel.dispute(id, abi.encode(v2), sigAv2);
    }

    function test_replay_penaltyProofStaleAfterAccepted() public {
        bytes32 id = _open();

        Adjudicator.ChannelState memory cheat = _state(id, 1, 70_000_000, 10_000_000);
        bytes memory sigB = _signState(bobPk, cheat);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheat), sigB);

        Adjudicator.ChannelState memory newer = _state(id, 5, 1, 79_999_999);
        bytes memory sigA5 = _signState(alicePk, newer);
        channel.submitPenaltyProof(id, abi.encode(newer), sigA5);

        // Older signed state by closer — should be rejected as stale
        Adjudicator.ChannelState memory older = _state(id, 3, 1, 79_999_999);
        bytes memory sigA3 = _signState(alicePk, older);
        vm.expectRevert(bytes("stale"));
        channel.submitPenaltyProof(id, abi.encode(older), sigA3);
    }

    function test_replay_finalizedChannelRejectsAllPaths() public {
        bytes32 id = _open();

        Adjudicator.ChannelState memory s = _state(id, 1, 50_000_000, 30_000_000);
        bytes memory sigB = _signState(bobPk, s);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), sigB);

        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);

        // After finalize all the path-gates must be tripped
        vm.expectRevert(bytes("!closing"));
        channel.dispute(id, abi.encode(s), sigB);

        Adjudicator.ChannelState memory s2 = _state(id, 2, 50_000_000, 30_000_000);
        bytes memory sigB2 = _signState(bobPk, s2);
        vm.prank(alice);
        vm.expectRevert(bytes("!open"));
        channel.closeUnilateral(id, abi.encode(s2), sigB2);

        vm.expectRevert(bytes("!closing"));
        channel.submitPenaltyProof(id, abi.encode(s2), sigB2);

        vm.expectRevert(bytes("!closing"));
        channel.finalize(id);
    }

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
            finalized: false
        });
    }
}
