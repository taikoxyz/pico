// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {IPaymentChannel} from "../src/interfaces/IPaymentChannel.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelTest
/// @notice End-to-end tests over the channel lifecycle: open, cooperative close,
///         unilateral close, dispute, watchtower penalty, and finalize. Plus every
///         revert path the contract is supposed to enforce.
contract PaymentChannelTest is Fixtures {
    uint256 internal constant MIN = 10_000_000;
    uint256 internal constant FUND_A = 50_000_000;
    uint256 internal constant FUND_B = 30_000_000;

    function setUp() public {
        _deployStack();
        _fund(alice, 1_000_000_000);
        _fund(bob, 1_000_000_000);
        _fund(carol, 1_000_000_000);
    }

    /* ====================================================================== */
    /*  Initialization                                                         */
    /* ====================================================================== */

    function test_initialize_revertsIfCalledAgain() public {
        vm.expectRevert();
        channel.initialize(owner, address(adjudicator));
    }

    function test_initialize_revertsOnImplementationDirectly() public {
        PaymentChannel impl = new PaymentChannel();
        vm.expectRevert();
        impl.initialize(owner, address(adjudicator));
    }

    function test_initialize_revertsOnZeroAdjudicator() public {
        PaymentChannel impl = new PaymentChannel();
        bytes memory init = abi.encodeCall(PaymentChannel.initialize, (owner, address(0)));
        vm.expectRevert();
        new ERC1967Proxy(address(impl), init);
    }

    /* ====================================================================== */
    /*  setTokenAllowed                                                        */
    /* ====================================================================== */

    function test_setTokenAllowed_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        channel.setTokenAllowed(address(token), false);
    }

    function test_setTokenAllowed_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(bytes("token=0"));
        channel.setTokenAllowed(address(0), true);
    }

    function test_setTokenAllowed_emitsEvent() public {
        MockERC20 t2 = new MockERC20("T2", "T2", 6);
        vm.expectEmit(true, false, false, true, address(channel));
        emit PaymentChannel.TokenAllowed(address(t2), true);
        vm.prank(owner);
        channel.setTokenAllowed(address(t2), true);
        assertTrue(channel.allowedTokens(address(t2)));
    }

    /* ====================================================================== */
    /*  openChannel                                                            */
    /* ====================================================================== */

    function test_openChannel_happyPath() public {
        uint256 balAliceBefore = token.balanceOf(alice);
        uint256 balBobBefore = token.balanceOf(bob);

        vm.recordLogs();
        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), FUND_A, FUND_B);

        assertEq(token.balanceOf(alice), balAliceBefore - FUND_A);
        assertEq(token.balanceOf(bob), balBobBefore - FUND_B);
        assertEq(token.balanceOf(address(channel)), FUND_A + FUND_B);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.userA, alice);
        assertEq(ch.userB, bob);
        assertEq(ch.token, address(token));
        assertEq(ch.amountA, FUND_A);
        assertEq(ch.amountB, FUND_B);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));
        assertEq(channel.openNonce(), 1);
    }

    function test_openChannel_revertsOnEthValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("no ETH"));
        channel.openChannel{value: 1}(bob, address(token), FUND_A, FUND_B);
    }

    function test_openChannel_revertsOnZeroToken() public {
        vm.prank(alice);
        vm.expectRevert(bytes("ETH disabled"));
        channel.openChannel(bob, address(0), FUND_A, FUND_B);
    }

    function test_openChannel_revertsOnDisallowedToken() public {
        MockERC20 unlisted = new MockERC20("UN", "UN", 6);
        unlisted.mint(alice, FUND_A);
        unlisted.mint(bob, FUND_B);
        vm.prank(alice);
        unlisted.approve(address(channel), type(uint256).max);
        vm.prank(bob);
        unlisted.approve(address(channel), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(bytes("token !allowed"));
        channel.openChannel(bob, address(unlisted), FUND_A, FUND_B);
    }

    function test_openChannel_revertsOnZeroUserB() public {
        vm.prank(alice);
        vm.expectRevert(bytes("userB=0"));
        channel.openChannel(address(0), address(token), FUND_A, FUND_B);
    }

    function test_openChannel_revertsOnSelfChannel() public {
        vm.prank(alice);
        vm.expectRevert(bytes("self-channel"));
        channel.openChannel(alice, address(token), FUND_A, FUND_B);
    }

    function test_openChannel_revertsBelowMin() public {
        vm.prank(alice);
        vm.expectRevert(bytes("amount<min"));
        channel.openChannel(bob, address(token), MIN / 2, MIN / 2 - 1);
    }

    function test_openChannel_acceptsExactlyMin() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), MIN, 0);
        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.amountA, MIN);
        assertEq(ch.amountB, 0);
    }

    function test_openChannel_distinctIdsForSameSecond() public {
        vm.prank(alice);
        bytes32 id1 = channel.openChannel(bob, address(token), FUND_A, FUND_B);
        vm.prank(alice);
        bytes32 id2 = channel.openChannel(bob, address(token), FUND_A, FUND_B);
        assertTrue(id1 != id2);
    }

    function test_openChannel_revertsOnInsufficientApproval() public {
        // alice revokes
        vm.prank(alice);
        token.approve(address(channel), 0);
        vm.prank(alice);
        vm.expectRevert();
        channel.openChannel(bob, address(token), FUND_A, FUND_B);
    }

    /* ====================================================================== */
    /*  closeCooperative                                                       */
    /* ====================================================================== */

    function test_closeCooperative_happyPath() public {
        bytes32 id = _openDefault();
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 30_000_000, 50_000_000);
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);

        uint64 ts = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true, address(channel));
        emit IPaymentChannel.ChannelClosedCooperative(id, ts);
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);

        assertEq(token.balanceOf(alice), balA0 + 30_000_000);
        assertEq(token.balanceOf(bob), balB0 + 50_000_000);
        assertEq(uint256(channel.channels(id).status), uint256(PaymentChannel.Status.Closed));
    }

    function test_closeCooperative_revertsIfNotOpen() public {
        bytes32 id = bytes32(uint256(0xDEAD));
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 0, 0);
        vm.expectRevert(bytes("!open"));
        channel.closeCooperative(id, abi.encode(cc), hex"", hex"");
    }

    function test_closeCooperative_revertsOnWrongChannelId() public {
        bytes32 id = _openDefault();
        Adjudicator.CooperativeClose memory cc = _coopClose(bytes32(uint256(0xBAD)), 50_000_000, 30_000_000);
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        vm.expectRevert(bytes("channelId"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);
    }

    function test_closeCooperative_revertsIfBalancesNotConserved() public {
        bytes32 id = _openDefault();
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 1_000_000_000, 1);
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        vm.expectRevert(bytes("!conserved"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);
    }

    function test_closeCooperative_revertsOnBadSig() public {
        bytes32 id = _openDefault();
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 50_000_000, 30_000_000);
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigCarol = _signCoopClose(carolPk, cc);
        vm.expectRevert(bytes("bad sig"));
        channel.closeCooperative(id, abi.encode(cc), sigA, sigCarol);
    }

    /* ====================================================================== */
    /*  closeUnilateral                                                        */
    /* ====================================================================== */

    function test_closeUnilateral_happyPath() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 7, 40_000_000, 40_000_000, false);
        bytes memory sigB = _signState(bobPk, s);

        uint64 ts = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true, address(channel));
        emit IPaymentChannel.ChannelClosingUnilateral(id, 7, ts + channel.DISPUTE_WINDOW());
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), sigB);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.ClosingUnilateral));
        assertEq(ch.postedVersion, 7);
        assertEq(ch.postedBalanceA, 40_000_000);
        assertEq(ch.postedBalanceB, 40_000_000);
        assertEq(ch.closer, alice);
    }

    function test_closeUnilateral_revertsIfNotParty() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 1, 50_000_000, 30_000_000, false);
        bytes memory sigB = _signState(bobPk, s);
        vm.prank(carol);
        vm.expectRevert(bytes("!party"));
        channel.closeUnilateral(id, abi.encode(s), sigB);
    }

    function test_closeUnilateral_revertsOnWrongChannelId() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(bytes32(uint256(0xBAD)), 1, 50_000_000, 30_000_000, false);
        bytes memory sigB = _signState(bobPk, s);
        vm.prank(alice);
        vm.expectRevert(bytes("channelId"));
        channel.closeUnilateral(id, abi.encode(s), sigB);
    }

    function test_closeUnilateral_revertsOnNonEmptyHtlcRoot() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 1, 50_000_000, 30_000_000, false);
        s.htlcsRoot = bytes32(uint256(0xAA));
        bytes memory sigB = _signState(bobPk, s);
        vm.prank(alice);
        vm.expectRevert(bytes("htlcs!=0"));
        channel.closeUnilateral(id, abi.encode(s), sigB);
    }

    function test_closeUnilateral_revertsOnBadSigFromSelf() public {
        // alice can't sign her own closeUnilateral state — needs counterparty's sig
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 1, 50_000_000, 30_000_000, false);
        bytes memory sigA = _signState(alicePk, s);
        vm.prank(alice);
        vm.expectRevert(bytes("bad sig"));
        channel.closeUnilateral(id, abi.encode(s), sigA);
    }

    function test_closeUnilateral_revertsIfNotConserved() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 1, 1, 1, false);
        bytes memory sigB = _signState(bobPk, s);
        vm.prank(alice);
        vm.expectRevert(bytes("!conserved"));
        channel.closeUnilateral(id, abi.encode(s), sigB);
    }

    function test_closeUnilateral_revertsIfNotOpen() public {
        bytes32 id = _openDefault();
        // Cooperatively close it first
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 50_000_000, 30_000_000);
        channel.closeCooperative(id, abi.encode(cc), _signCoopClose(alicePk, cc), _signCoopClose(bobPk, cc));

        Adjudicator.ChannelState memory s = _state(id, 2, 50_000_000, 30_000_000, false);
        bytes memory sigB = _signState(bobPk, s);
        vm.prank(alice);
        vm.expectRevert(bytes("!open"));
        channel.closeUnilateral(id, abi.encode(s), sigB);
    }

    /* ====================================================================== */
    /*  dispute                                                                */
    /* ====================================================================== */

    function test_dispute_replacesPostedState() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory stale = _state(id, 3, 50_000_000, 30_000_000, false);
        bytes memory sigBStale = _signState(bobPk, stale);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(stale), sigBStale);

        Adjudicator.ChannelState memory fresher = _state(id, 5, 10_000_000, 70_000_000, false);
        bytes memory sigA = _signState(alicePk, fresher);
        bytes memory sigB = _signState(bobPk, fresher);

        uint64 deadlineBefore = channel.channels(id).disputeDeadline;
        skip(1 hours); // advance time so the restart is observable
        vm.expectEmit(true, false, false, true, address(channel));
        emit IPaymentChannel.DisputeRaised(id, 5);
        vm.prank(bob);
        channel.dispute(id, abi.encode(fresher), sigA, sigB);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.postedVersion, 5);
        assertEq(ch.postedBalanceA, 10_000_000);
        assertEq(ch.postedBalanceB, 70_000_000);
        assertGt(ch.disputeDeadline, deadlineBefore, "deadline must restart");
    }

    function test_dispute_rejectsSinglePartySignature() public {
        // Proof that single-party forged disputes are rejected. Either party can fabricate
        // a self-signed state — dual signatures are required to prove mutual agreement.
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory honest = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(honest), _signState(bobPk, honest));

        Adjudicator.ChannelState memory forged = _state(id, 99, 0, FUND_A + FUND_B, false);

        // Non-closer (bob) self-signs a draining state — rejected.
        bytes memory sigBobOnly = _signState(bobPk, forged);
        bytes memory sigAEmpty = hex"";
        vm.prank(bob);
        vm.expectRevert(bytes("bad sig"));
        channel.dispute(id, abi.encode(forged), sigAEmpty, sigBobOnly);

        // Closer (alice) self-signs a draining state — also rejected.
        bytes memory sigAliceOnly = _signState(alicePk, forged);
        vm.prank(alice);
        vm.expectRevert(bytes("bad sig"));
        channel.dispute(id, abi.encode(forged), sigAliceOnly, sigAEmpty);
    }

    function test_dispute_revertsIfNotClosing() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 5, 50_000_000, 30_000_000, false);
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigB = _signState(bobPk, s);
        vm.expectRevert(bytes("!closing"));
        channel.dispute(id, abi.encode(s), sigA, sigB);
    }

    function test_dispute_revertsOnStaleVersion() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory posted = _state(id, 5, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(posted), _signState(bobPk, posted));

        Adjudicator.ChannelState memory equal_ = _state(id, 5, 1, 79_999_999, false);
        bytes memory sigA = _signState(alicePk, equal_);
        bytes memory sigB = _signState(bobPk, equal_);
        vm.expectRevert(bytes("stale"));
        channel.dispute(id, abi.encode(equal_), sigA, sigB);

        Adjudicator.ChannelState memory older = _state(id, 4, 1, 79_999_999, false);
        bytes memory sigA2 = _signState(alicePk, older);
        bytes memory sigB2 = _signState(bobPk, older);
        vm.expectRevert(bytes("stale"));
        channel.dispute(id, abi.encode(older), sigA2, sigB2);
    }

    function test_dispute_revertsOnWrongChannelId() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory posted = _state(id, 5, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(posted), _signState(bobPk, posted));

        Adjudicator.ChannelState memory s = _state(bytes32(uint256(0xBAD)), 6, 1, 79_999_999, false);
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigB = _signState(bobPk, s);
        vm.expectRevert(bytes("channelId"));
        channel.dispute(id, abi.encode(s), sigA, sigB);
    }

    function test_dispute_revertsOnNonEmptyHtlcRoot() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory posted = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(posted), _signState(bobPk, posted));

        Adjudicator.ChannelState memory s = _state(id, 2, 50_000_000, 30_000_000, false);
        s.htlcsRoot = bytes32(uint256(0xAA));
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigB = _signState(bobPk, s);
        vm.expectRevert(bytes("htlcs!=0"));
        channel.dispute(id, abi.encode(s), sigA, sigB);
    }

    function test_dispute_revertsOnBadSig() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory posted = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(posted), _signState(bobPk, posted));

        Adjudicator.ChannelState memory s = _state(id, 2, 1, 79_999_999, false);
        // One valid sig + one forged (carol) should revert
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigCarol = _signState(carolPk, s);
        vm.expectRevert(bytes("bad sig"));
        channel.dispute(id, abi.encode(s), sigA, sigCarol);
    }

    function test_dispute_revertsIfNotConserved() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory posted = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(posted), _signState(bobPk, posted));

        Adjudicator.ChannelState memory s = _state(id, 2, 1, 1, false);
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigB = _signState(bobPk, s);
        vm.expectRevert(bytes("!conserved"));
        channel.dispute(id, abi.encode(s), sigA, sigB);
    }

    function test_dispute_revertsAfterDeadline() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory posted = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(posted), _signState(bobPk, posted));

        skip(channel.DISPUTE_WINDOW() + 1);

        Adjudicator.ChannelState memory s = _state(id, 2, 40_000_000, 40_000_000, false);
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigB = _signState(bobPk, s);
        vm.expectRevert(bytes("deadline"));
        channel.dispute(id, abi.encode(s), sigA, sigB);
    }

    /* ====================================================================== */
    /*  submitPenaltyProof                                                     */
    /* ====================================================================== */

    function test_submitPenaltyProof_happyPath_slashesCloser() public {
        bytes32 id = _openDefault();

        // Alice cheats: posts an old state where she has 70M and Bob has 10M (favours her)
        Adjudicator.ChannelState memory cheatState = _state(id, 2, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        // Watchtower (carol) submits BOTH parties' signatures on a strictly newer state,
        // proving the closer knowingly posted a stale version.
        Adjudicator.ChannelState memory newer = _state(id, 5, 10_000_000, 70_000_000, false);
        bytes memory sigAlice = _signState(alicePk, newer);
        bytes memory sigBob = _signState(bobPk, newer);

        vm.expectEmit(true, true, true, true, address(channel));
        emit PaymentChannel.PenaltyApplied(id, alice, bob);
        vm.prank(carol);
        channel.submitPenaltyProof(id, abi.encode(newer), sigAlice, sigBob);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertTrue(ch.penalized);
        assertEq(ch.postedVersion, 5);
    }

    function test_submitPenaltyProof_revertsIfNotClosing() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 5, 50_000_000, 30_000_000, false);
        bytes memory sigA = _signState(alicePk, s);
        bytes memory sigB = _signState(bobPk, s);
        vm.expectRevert(bytes("!closing"));
        channel.submitPenaltyProof(id, abi.encode(s), sigA, sigB);
    }

    function test_submitPenaltyProof_revertsOnStaleVersion() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheatState = _state(id, 3, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        Adjudicator.ChannelState memory equal_ = _state(id, 3, 70_000_000, 10_000_000, false);
        bytes memory sigA = _signState(alicePk, equal_);
        bytes memory sigB = _signState(bobPk, equal_);
        vm.expectRevert(bytes("stale"));
        channel.submitPenaltyProof(id, abi.encode(equal_), sigA, sigB);
    }

    function test_submitPenaltyProof_revertsOnSinglePartySig() public {
        // A single-party signature does not prove mutual agreement; dual sigs are required.
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheatState = _state(id, 1, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        Adjudicator.ChannelState memory newer = _state(id, 5, 10_000_000, 70_000_000, false);

        // Only non-closer (bob) signs — rejected.
        bytes memory sigBob = _signState(bobPk, newer);
        vm.expectRevert(bytes("bad sig"));
        channel.submitPenaltyProof(id, abi.encode(newer), hex"", sigBob);

        // Only closer (alice) signs — also rejected.
        bytes memory sigAlice = _signState(alicePk, newer);
        vm.expectRevert(bytes("bad sig"));
        channel.submitPenaltyProof(id, abi.encode(newer), sigAlice, hex"");
    }

    function test_submitPenaltyProof_revertsOnNonEmptyHtlcRoot() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheatState = _state(id, 1, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        Adjudicator.ChannelState memory newer = _state(id, 5, 10_000_000, 70_000_000, false);
        newer.htlcsRoot = bytes32(uint256(0xAA));
        bytes memory sigA = _signState(alicePk, newer);
        bytes memory sigB = _signState(bobPk, newer);
        vm.expectRevert(bytes("htlcs!=0"));
        channel.submitPenaltyProof(id, abi.encode(newer), sigA, sigB);
    }

    function test_submitPenaltyProof_revertsOnWrongChannelId() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheatState = _state(id, 1, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        Adjudicator.ChannelState memory wrong = _state(bytes32(uint256(0xBAD)), 5, 1, 79_999_999, false);
        bytes memory sigA = _signState(alicePk, wrong);
        bytes memory sigB = _signState(bobPk, wrong);
        vm.expectRevert(bytes("channelId"));
        channel.submitPenaltyProof(id, abi.encode(wrong), sigA, sigB);
    }

    function test_submitPenaltyProof_revertsIfNotConserved() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheatState = _state(id, 1, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        Adjudicator.ChannelState memory newer = _state(id, 5, 1, 1, false);
        bytes memory sigA = _signState(alicePk, newer);
        bytes memory sigB = _signState(bobPk, newer);
        vm.expectRevert(bytes("!conserved"));
        channel.submitPenaltyProof(id, abi.encode(newer), sigA, sigB);
    }

    function test_submitPenaltyProof_revertsAfterDeadline() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheatState = _state(id, 1, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheatState), _signState(bobPk, cheatState));

        skip(channel.DISPUTE_WINDOW() + 1);

        Adjudicator.ChannelState memory newer = _state(id, 5, 10_000_000, 70_000_000, false);
        bytes memory sigA = _signState(alicePk, newer);
        bytes memory sigB = _signState(bobPk, newer);
        vm.expectRevert(bytes("deadline"));
        channel.submitPenaltyProof(id, abi.encode(newer), sigA, sigB);
    }

    /* ====================================================================== */
    /*  finalize                                                               */
    /* ====================================================================== */

    function test_finalize_revertsIfNotClosing() public {
        bytes32 id = _openDefault();
        vm.expectRevert(bytes("!closing"));
        channel.finalize(id);
    }

    function test_finalize_revertsBeforeDeadline() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));
        vm.expectRevert(bytes("!ripe"));
        channel.finalize(id);
    }

    function test_finalize_distributesPostedSplit() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 7, 60_000_000, 20_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);

        vm.expectEmit(true, false, false, true, address(channel));
        emit IPaymentChannel.ChannelFinalized(id, 60_000_000, 20_000_000);
        channel.finalize(id);

        assertEq(token.balanceOf(alice), balA0 + 60_000_000);
        assertEq(token.balanceOf(bob), balB0 + 20_000_000);
        assertEq(token.balanceOf(address(channel)), 0);
        assertEq(uint256(channel.channels(id).status), uint256(PaymentChannel.Status.Closed));
    }

    function test_finalize_penalizedSendsAllToHonestParty() public {
        bytes32 id = _openDefault();

        // Alice posts a stale, self-favouring state
        Adjudicator.ChannelState memory cheat = _state(id, 2, 70_000_000, 10_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheat), _signState(bobPk, cheat));

        // Watchtower proves cheat with dual-signed newer state
        Adjudicator.ChannelState memory newer = _state(id, 5, 1, 79_999_999, false);
        vm.prank(carol);
        channel.submitPenaltyProof(id, abi.encode(newer), _signState(alicePk, newer), _signState(bobPk, newer));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);
        channel.finalize(id);

        // 100% slash: full pot to honest party (bob)
        assertEq(token.balanceOf(alice), balA0, "cheater gets nothing");
        assertEq(token.balanceOf(bob), balB0 + FUND_A + FUND_B, "honest party gets full pot");
    }

    function test_finalize_penalizedWhenBobIsCheater() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory cheat = _state(id, 2, 10_000_000, 70_000_000, false);
        vm.prank(bob);
        channel.closeUnilateral(id, abi.encode(cheat), _signState(alicePk, cheat));

        Adjudicator.ChannelState memory newer = _state(id, 5, 79_999_999, 1, false);
        vm.prank(carol);
        channel.submitPenaltyProof(id, abi.encode(newer), _signState(alicePk, newer), _signState(bobPk, newer));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 balA0 = token.balanceOf(alice);
        uint256 balB0 = token.balanceOf(bob);
        channel.finalize(id);
        assertEq(token.balanceOf(bob), balB0, "cheater gets nothing");
        assertEq(token.balanceOf(alice), balA0 + FUND_A + FUND_B, "honest party gets full pot");
    }

    function test_finalize_doubleCallReverts() public {
        bytes32 id = _openDefault();
        Adjudicator.ChannelState memory s = _state(id, 1, 50_000_000, 30_000_000, false);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));
        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);
        vm.expectRevert(bytes("!closing"));
        channel.finalize(id);
    }

    /* ====================================================================== */
    /*  Reentrancy guard sanity                                                */
    /* ====================================================================== */

    function test_reentrancyGuard_initiallyUnlocked() public {
        // The first call should not revert (guard state is correctly initialised)
        bytes32 id = _openDefault();
        assertTrue(id != bytes32(0));
    }

    /* ====================================================================== */
    /*  UUPS upgrade authorisation                                             */
    /* ====================================================================== */

    function test_upgrade_onlyOwnerCanUpgrade() public {
        PaymentChannel newImpl = new PaymentChannel();
        vm.prank(alice);
        vm.expectRevert();
        channel.upgradeTo(address(newImpl));
    }

    function test_upgrade_ownerSucceeds() public {
        PaymentChannel newImpl = new PaymentChannel();
        vm.prank(owner);
        channel.upgradeTo(address(newImpl));
        // post-upgrade: state preserved, owner unchanged
        assertEq(channel.owner(), owner);
        assertTrue(channel.allowedTokens(address(token)));
    }

    /* ====================================================================== */
    /*  helpers                                                                */
    /* ====================================================================== */

    function _openDefault() internal returns (bytes32) {
        vm.prank(alice);
        return channel.openChannel(bob, address(token), FUND_A, FUND_B);
    }

    function _state(bytes32 channelId, uint64 version, uint256 balanceA, uint256 balanceB, bool finalized)
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
            finalized: finalized
        });
    }

    function _coopClose(bytes32 channelId, uint256 balanceA, uint256 balanceB)
        internal
        view
        returns (Adjudicator.CooperativeClose memory)
    {
        return Adjudicator.CooperativeClose({
            channelId: channelId,
            finalBalanceA: balanceA,
            finalBalanceB: balanceB,
            signedAt: uint64(block.timestamp)
        });
    }
}
