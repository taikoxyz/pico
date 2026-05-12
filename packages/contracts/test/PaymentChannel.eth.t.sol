// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {IPaymentChannel} from "../src/interfaces/IPaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelEthTest
/// @notice Lifecycle coverage for native-ETH channels (`token == address(0)`):
///         open, top-up, cooperative close, unilateral close + finalize, and the
///         penalty path. Mirrors `PaymentChannel.t.sol` but with `msg.value` funding
///         and balance assertions against `address.balance`.
contract PaymentChannelEthTest is Fixtures {
    address internal constant ETH = address(0);
    uint256 internal constant ETH_MIN = 0.01 ether;
    uint256 internal constant FUND_A = 1 ether;
    uint256 internal constant TOP_UP = 0.5 ether;

    function setUp() public {
        _deployStack();
        // Allowlist ETH and set a 0.01-ETH floor to mirror the v1 USDC-style minimum.
        vm.startPrank(owner);
        channel.setTokenAllowed(ETH, true);
        channel.setMinChannelAmount(ETH, ETH_MIN);
        vm.stopPrank();
        // Fund the test actors with ETH instead of USDC.
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    /* ====================================================================== */
    /*  openChannel                                                            */
    /* ====================================================================== */

    function test_open_happyPath_pullsEthFromOpener() public {
        uint256 aliceBefore = alice.balance;
        uint256 channelBefore = address(channel).balance;

        vm.prank(alice);
        bytes32 id = channel.openChannel{value: FUND_A}(bob, ETH, FUND_A, 0);

        assertEq(alice.balance, aliceBefore - FUND_A);
        assertEq(address(channel).balance, channelBefore + FUND_A);

        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.token, ETH);
        assertEq(ch.amountA, FUND_A);
        assertEq(ch.amountB, 0);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));
    }

    function test_open_revertsOnAmountB() public {
        // For ETH channels, only the opener funds; counterparty side must be 0 at open.
        vm.prank(alice);
        vm.expectRevert(bytes("ETH amountB!=0"));
        channel.openChannel{value: FUND_A}(bob, ETH, FUND_A - 1, 1);
    }

    function test_open_revertsOnValueMismatch() public {
        vm.prank(alice);
        vm.expectRevert(bytes("ETH value!=amountA"));
        channel.openChannel{value: FUND_A - 1}(bob, ETH, FUND_A, 0);
    }

    function test_open_revertsBelowMin() public {
        vm.prank(alice);
        vm.expectRevert(bytes("amount<min"));
        channel.openChannel{value: ETH_MIN - 1}(bob, ETH, ETH_MIN - 1, 0);
    }

    /* ====================================================================== */
    /*  topUp                                                                  */
    /* ====================================================================== */

    function test_topUp_sentinelPrev_pullsEthFromCaller() public {
        bytes32 id = _open();

        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A + TOP_UP, 0);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        uint256 aliceBefore = alice.balance;
        uint256 channelBefore = address(channel).balance;

        vm.prank(alice);
        channel.topUp{value: TOP_UP}(id, TOP_UP, prev, next);

        assertEq(alice.balance, aliceBefore - TOP_UP);
        assertEq(address(channel).balance, channelBefore + TOP_UP);
        assertEq(channel.channels(id).amountA, FUND_A + TOP_UP);
    }

    function test_topUp_revertsOnValueMismatch() public {
        bytes32 id = _open();
        Adjudicator.SignedChannelState memory prev = _sentinelPrev(id);
        Adjudicator.ChannelState memory nextState = _state(id, 1, FUND_A + TOP_UP, 0);
        Adjudicator.SignedChannelState memory next = Adjudicator.SignedChannelState({
            state: nextState, sigA: _signState(alicePk, nextState), sigB: _signState(bobPk, nextState)
        });

        vm.prank(alice);
        vm.expectRevert(bytes("ETH value!=amount"));
        channel.topUp{value: TOP_UP - 1}(id, TOP_UP, prev, next);
    }

    /* ====================================================================== */
    /*  closeCooperative                                                       */
    /* ====================================================================== */

    function test_closeCooperative_disbursesEthToBothParties() public {
        // Open then cooperatively split: alice keeps 0.4, bob receives 0.6 (after some
        // notional off-chain payments alice -> bob).
        bytes32 id = _open();
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 0.4 ether, 0.6 ether);
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;

        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);

        assertEq(alice.balance, aliceBefore + 0.4 ether);
        assertEq(bob.balance, bobBefore + 0.6 ether);
        assertEq(address(channel).balance, 0);
    }

    /* ====================================================================== */
    /*  closeUnilateral + finalize                                             */
    /* ====================================================================== */

    function test_finalize_disbursesPostedEthSplit() public {
        bytes32 id = _open();
        Adjudicator.ChannelState memory s = _state(id, 7, 0.3 ether, 0.7 ether);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        channel.finalize(id);

        assertEq(alice.balance, aliceBefore + 0.3 ether);
        assertEq(bob.balance, bobBefore + 0.7 ether);
        assertEq(address(channel).balance, 0);
    }

    function test_penalty_sendsAllEthToHonestParty() public {
        bytes32 id = _open();

        // Alice cheats: posts a self-favouring stale state.
        Adjudicator.ChannelState memory cheat = _state(id, 2, 0.9 ether, 0.1 ether);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheat), _signState(bobPk, cheat));

        // Watchtower (carol) submits a strictly-newer dual-signed state.
        Adjudicator.ChannelState memory newer = _state(id, 5, 0.1 ether, 0.9 ether);
        vm.prank(carol);
        channel.submitPenaltyProof(id, abi.encode(newer), _signState(alicePk, newer), _signState(bobPk, newer));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        channel.finalize(id);

        // 100% slash: cheater (alice) gets nothing; full pot to honest party (bob).
        assertEq(alice.balance, aliceBefore, "cheater gets nothing");
        assertEq(bob.balance, bobBefore + FUND_A, "honest party gets full pot");
    }

    /* ====================================================================== */
    /*  helpers                                                                */
    /* ====================================================================== */

    function _open() internal returns (bytes32) {
        vm.prank(alice);
        return channel.openChannel{value: FUND_A}(bob, ETH, FUND_A, 0);
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

    function _sentinelPrev(bytes32 channelId) internal view returns (Adjudicator.SignedChannelState memory) {
        PaymentChannel.Channel memory ch = channel.channels(channelId);
        return Adjudicator.SignedChannelState({
            state: Adjudicator.ChannelState({
                channelId: channelId,
                version: 0,
                balanceA: ch.amountA,
                balanceB: ch.amountB,
                htlcsRoot: bytes32(0),
                finalized: false
            }),
            sigA: hex"",
            sigB: hex""
        });
    }

    function _coopClose(bytes32 channelId, uint256 balanceA, uint256 balanceB)
        internal
        view
        returns (Adjudicator.CooperativeClose memory)
    {
        return Adjudicator.CooperativeClose({
            channelId: channelId,
            version: 1,
            finalBalanceA: balanceA,
            finalBalanceB: balanceB,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
    }
}
