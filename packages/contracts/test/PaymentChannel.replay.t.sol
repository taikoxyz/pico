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

        // v5 disputes successfully — both parties must have signed the disputed state.
        Adjudicator.ChannelState memory v5 = _state(id, 5, 10_000_000, 70_000_000);
        channel.dispute(id, abi.encode(v5), _signState(alicePk, v5), _signState(bobPk, v5));

        // Replaying v3 (older than v5) must revert as stale.
        Adjudicator.ChannelState memory v3 = _state(id, 3, 30_000_000, 50_000_000);
        vm.expectRevert(bytes("stale"));
        channel.dispute(id, abi.encode(v3), _signState(alicePk, v3), _signState(bobPk, v3));
    }

    function test_replay_disputeSameVersionAfterAccepted() public {
        bytes32 id = _open();

        Adjudicator.ChannelState memory v1 = _state(id, 1, 50_000_000, 30_000_000);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(v1), _signState(bobPk, v1));

        Adjudicator.ChannelState memory v2 = _state(id, 2, 40_000_000, 40_000_000);
        bytes memory sigAv2 = _signState(alicePk, v2);
        bytes memory sigBv2 = _signState(bobPk, v2);
        channel.dispute(id, abi.encode(v2), sigAv2, sigBv2);

        // Same version v2 again — must be rejected.
        vm.expectRevert(bytes("stale"));
        channel.dispute(id, abi.encode(v2), sigAv2, sigBv2);
    }

    function test_replay_penaltyProofStaleAfterAccepted() public {
        bytes32 id = _open();

        Adjudicator.ChannelState memory cheat = _state(id, 1, 70_000_000, 10_000_000);
        bytes memory sigB = _signState(bobPk, cheat);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheat), sigB);

        Adjudicator.ChannelState memory newer = _state(id, 5, 1, 79_999_999);
        bytes memory sigA5 = _signState(alicePk, newer);
        bytes memory sigB5 = _signState(bobPk, newer);
        channel.submitPenaltyProof(id, abi.encode(newer), sigA5, sigB5);

        // Older signed state — should be rejected as stale
        Adjudicator.ChannelState memory older = _state(id, 3, 1, 79_999_999);
        bytes memory sigA3 = _signState(alicePk, older);
        bytes memory sigB3 = _signState(bobPk, older);
        vm.expectRevert(bytes("stale"));
        channel.submitPenaltyProof(id, abi.encode(older), sigA3, sigB3);
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
        bytes memory sigA = _signState(alicePk, s);
        vm.expectRevert(bytes("!closing"));
        channel.dispute(id, abi.encode(s), sigA, sigB);

        Adjudicator.ChannelState memory s2 = _state(id, 2, 50_000_000, 30_000_000);
        bytes memory sigA2 = _signState(alicePk, s2);
        bytes memory sigB2 = _signState(bobPk, s2);
        vm.prank(alice);
        vm.expectRevert(bytes("!open"));
        channel.closeUnilateral(id, abi.encode(s2), sigB2);

        vm.expectRevert(bytes("!closing"));
        channel.submitPenaltyProof(id, abi.encode(s2), sigA2, sigB2);

        vm.expectRevert(bytes("!closing"));
        channel.finalize(id);
    }

    /* ====================================================================== */
    /*  CooperativeClose replay defenses (version + validUntil)                */
    /* ====================================================================== */

    function test_closeCoop_rejectsStaleVersion() public {
        bytes32 id = _open();
        // postedVersion is 0 on a fresh channel; version 0 must not satisfy `> 0`.
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 50_000_000, 30_000_000, 0, uint64(block.timestamp + 1 hours));
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        vm.expectRevert(bytes("stale version"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);
    }

    function test_closeCoop_rejectsExpired() public {
        bytes32 id = _open();
        // Build a coopClose with validUntil already past — block.timestamp at construction
        // becomes signedAt; choose validUntil < signedAt by using a fixed past timestamp.
        skip(2 hours);
        Adjudicator.CooperativeClose memory cc =
            _coopClose(id, 50_000_000, 30_000_000, 1, uint64(block.timestamp - 1));
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        vm.expectRevert(bytes("expired"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);
    }

    function test_closeCoop_rejectsReplayAfterFirstSucceeds() public {
        // Open a fresh channel, run a successful coopClose at version=2, then attempt to
        // post a second coopClose at version=2 again — must revert "stale version" because
        // postedVersion was bumped to 2 on the first call (even though channel is now Closed,
        // the !open check trips first; we re-open a sibling channel to isolate the version
        // gate). Spec demands: "submit a close that succeeds (postedVersion bumped), then
        // submit a second close with version == postedVersion, expect revert 'stale version'".
        // Since the channel transitions to Closed after a successful close, the most direct
        // way to exercise the postedVersion bump is to top-up first (bumps postedVersion
        // to 1) and then run a coopClose with version <= 1 — which trips "stale version".
        bytes32 id = _open();

        // Use topUp to bump postedVersion to 1 without closing the channel.
        // alice tops up by 5 USDC; pre-state is sentinel (version 0, balances == amounts).
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
            balanceA: FUND_A + 5_000_000,
            balanceB: FUND_B,
            htlcsRoot: bytes32(0),
            finalized: false
        });
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState,
            sigA: _signState(alicePk, nextState),
            sigB: _signState(bobPk, nextState)
        });
        vm.prank(alice);
        channel.topUp(id, 5_000_000, prev, next);

        // postedVersion is now 1. A coopClose at version=1 must be rejected as stale.
        Adjudicator.CooperativeClose memory cc =
            _coopClose(id, FUND_A + 5_000_000, FUND_B, 1, uint64(block.timestamp + 1 hours));
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        vm.expectRevert(bytes("stale version"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);
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

    function _coopClose(
        bytes32 channelId,
        uint256 finalA,
        uint256 finalB,
        uint64 version,
        uint64 validUntil
    ) internal view returns (Adjudicator.CooperativeClose memory) {
        return Adjudicator.CooperativeClose({
            channelId: channelId,
            version: version,
            finalBalanceA: finalA,
            finalBalanceB: finalB,
            signedAt: uint64(block.timestamp),
            validUntil: validUntil
        });
    }
}
