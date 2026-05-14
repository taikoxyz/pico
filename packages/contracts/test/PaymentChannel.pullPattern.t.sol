// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {IPaymentChannel} from "../src/interfaces/IPaymentChannel.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice ERC-20 with pause (U-01) and per-address blocklist (U-03).
contract PausableBlocklistERC20 is ERC20 {
    bool public paused;
    mapping(address => bool) public blocklisted;

    constructor() ERC20("Pausable USDC", "PUSDC") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function pause() external { paused = true; }
    function unpause() external { paused = false; }
    function blockAddress(address who) external { blocklisted[who] = true; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!paused, "paused");
        require(!blocklisted[msg.sender] && !blocklisted[to], "blocked");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!paused, "paused");
        require(!blocklisted[from] && !blocklisted[to], "blocked");
        return super.transferFrom(from, to, amount);
    }
}

/// @notice ETH receiver whose receive() always reverts — simulates U-02 (reverting counterparty).
contract RevertingReceiver {
    receive() external payable { revert("no ETH"); }
}

/// @notice Reentrancy attacker: on receiving ETH, tries to call withdraw again.
contract ReentrancyAttacker {
    PaymentChannel public immutable channel;
    bool internal _armed;

    constructor(PaymentChannel ch) { channel = ch; }

    receive() external payable {
        if (_armed) {
            _armed = false;
            channel.withdraw(address(0)); // attempt reentrant call
        }
    }

    function arm() external { _armed = true; }
}

/// @title PaymentChannelPullPatternTest
/// @notice v2.1 pull-pattern acceptance criteria:
///   - Happy-path ERC-20 cooperative close + withdraw
///   - Happy-path ETH finalize + withdraw
///   - U-01: USDC pause — finalize/close advance state; withdraw resumes after unpause
///   - U-02: Reverting receiver — only blocks its own withdraw; counterparty unaffected
///   - U-03: Blocklist asymmetry — blocked party can't withdraw; other party can
///   - Penalty re-routed via pendingWithdrawals
///   - Reentrancy guard on withdraw
///   - Zero-balance withdraw reverts
///   - Withdrawn event
///   - Credit accumulates across multiple channels
contract PaymentChannelPullPatternTest is Fixtures {
    address internal constant ETH = address(0);
    uint256 internal constant ETH_MIN = 0.01 ether;
    uint256 internal constant FUND_ETH = 1 ether;

    PausableBlocklistERC20 internal ptoken;

    function setUp() public {
        _deployStack();

        // Enable ETH channels
        vm.startPrank(owner);
        channel.setTokenAllowed(ETH, true);
        channel.setMinChannelAmount(ETH, ETH_MIN);
        vm.stopPrank();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);

        // Deploy and configure the pausable/blocklist token
        ptoken = new PausableBlocklistERC20();
        vm.startPrank(owner);
        channel.setTokenAllowed(address(ptoken), true);
        channel.setMinChannelAmount(address(ptoken), 10_000_000);
        vm.stopPrank();

        ptoken.mint(alice, 1_000_000_000);
        ptoken.mint(bob, 1_000_000_000);
        vm.prank(alice);
        ptoken.approve(address(channel), type(uint256).max);
        vm.prank(bob);
        ptoken.approve(address(channel), type(uint256).max);
    }

    /* ====================================================================== */
    /*  Happy path — cooperative close                                         */
    /* ====================================================================== */

    function test_coopClose_creditsPendingWithdrawals_andWithdrawSends() public {
        // Open a USDC-style channel (using Fixtures' MockERC20)
        _fund(alice, 50_000_000);
        _fund(bob, 30_000_000);
        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), 50_000_000, 30_000_000);

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            version: 1,
            finalBalanceA: 20_000_000,
            finalBalanceB: 60_000_000,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        channel.closeCooperative(id, abi.encode(cc), _signCoopClose(alicePk, cc), _signCoopClose(bobPk, cc));

        // State is Closed; funds are in pendingWithdrawals, not yet sent
        assertEq(uint256(channel.channels(id).status), uint256(PaymentChannel.Status.Closed));
        assertEq(channel.pendingWithdrawals(address(token), alice), 20_000_000);
        assertEq(channel.pendingWithdrawals(address(token), bob), 60_000_000);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);

        vm.prank(alice);
        channel.withdraw(address(token));
        vm.prank(bob);
        channel.withdraw(address(token));

        assertEq(token.balanceOf(alice), aliceBefore + 20_000_000);
        assertEq(token.balanceOf(bob), bobBefore + 60_000_000);
        assertEq(channel.pendingWithdrawals(address(token), alice), 0);
        assertEq(channel.pendingWithdrawals(address(token), bob), 0);
    }

    /* ====================================================================== */
    /*  Happy path — finalize (ETH)                                            */
    /* ====================================================================== */

    function test_finalize_creditsPendingWithdrawals_andWithdrawSends() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel{value: FUND_ETH}(bob, ETH, FUND_ETH, 0);

        Adjudicator.ChannelState memory s = _ethState(id, 3, 0.3 ether, 0.7 ether);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));

        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);

        assertEq(channel.pendingWithdrawals(ETH, alice), 0.3 ether);
        assertEq(channel.pendingWithdrawals(ETH, bob), 0.7 ether);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;

        vm.prank(alice);
        channel.withdraw(ETH);
        vm.prank(bob);
        channel.withdraw(ETH);

        assertEq(alice.balance, aliceBefore + 0.3 ether);
        assertEq(bob.balance, bobBefore + 0.7 ether);
        assertEq(address(channel).balance, 0);
    }

    /* ====================================================================== */
    /*  U-01: USDC pause — state advances even when token is paused           */
    /* ====================================================================== */

    function test_u01_pausedToken_finalizeAdvancesState_withdrawResumesAfterUnpause() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(ptoken), 50_000_000, 30_000_000);

        Adjudicator.ChannelState memory s = _ptokenState(id, 1, 20_000_000, 60_000_000);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));

        skip(channel.DISPUTE_WINDOW() + 1);

        ptoken.pause();

        // Finalize MUST succeed even while token is paused — no transfer occurs yet
        channel.finalize(id);
        assertEq(uint256(channel.channels(id).status), uint256(PaymentChannel.Status.Closed));
        assertEq(channel.pendingWithdrawals(address(ptoken), alice), 20_000_000);
        assertEq(channel.pendingWithdrawals(address(ptoken), bob), 60_000_000);

        // withdraw reverts while paused
        vm.prank(alice);
        vm.expectRevert("paused");
        channel.withdraw(address(ptoken));

        // after unpause, withdraw succeeds
        ptoken.unpause();

        uint256 aliceBefore = ptoken.balanceOf(alice);
        vm.prank(alice);
        channel.withdraw(address(ptoken));
        assertEq(ptoken.balanceOf(alice), aliceBefore + 20_000_000);

        uint256 bobBefore = ptoken.balanceOf(bob);
        vm.prank(bob);
        channel.withdraw(address(ptoken));
        assertEq(ptoken.balanceOf(bob), bobBefore + 60_000_000);
    }

    function test_u01_pausedToken_coopCloseAdvancesState_withdrawResumesAfterUnpause() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(ptoken), 50_000_000, 30_000_000);

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            version: 1,
            finalBalanceA: 35_000_000,
            finalBalanceB: 45_000_000,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });

        ptoken.pause();
        // closeCooperative MUST succeed even while token is paused
        channel.closeCooperative(
            id, abi.encode(cc), _signCoopClose(alicePk, cc), _signCoopClose(bobPk, cc)
        );
        assertEq(uint256(channel.channels(id).status), uint256(PaymentChannel.Status.Closed));

        ptoken.unpause();
        vm.prank(alice);
        channel.withdraw(address(ptoken));
        vm.prank(bob);
        channel.withdraw(address(ptoken));
    }

    /* ====================================================================== */
    /*  U-02: reverting receiver — counterparty unaffected                    */
    /* ====================================================================== */

    /// @notice Demonstrates that each party's pending withdrawal is independent:
    ///         if one party's ETH receive() reverts (U-02), their credit stays
    ///         locked in pendingWithdrawals but the counterparty can withdraw freely.
    function test_u02_revertingReceiver_onlyBlocksItself_counterpartyUnaffected() public {
        RevertingReceiver rr = new RevertingReceiver();
        vm.deal(address(rr), 10 ether);

        // rr opens as userA, alice as userB (no amountB at open for ETH channels)
        vm.prank(address(rr));
        bytes32 id = channel.openChannel{value: FUND_ETH}(alice, ETH, FUND_ETH, 0);

        // alice (userB) invokes the anti-hostage path — no counterparty sig needed
        vm.prank(alice);
        channel.closeUnilateralFromOpen(id);

        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);

        // After finalize: rr credited amountA=FUND_ETH, alice credited amountB=0
        assertEq(channel.pendingWithdrawals(ETH, address(rr)), FUND_ETH);
        assertEq(channel.pendingWithdrawals(ETH, alice), 0);

        // rr's withdraw reverts (its receive() reverts); credit preserved
        vm.prank(address(rr));
        vm.expectRevert("ETH send fail");
        channel.withdraw(ETH);
        assertEq(channel.pendingWithdrawals(ETH, address(rr)), FUND_ETH, "rr credit preserved");

        // A second independent channel between alice and bob shows alice can
        // withdraw her own credits with no dependency on rr's failed withdrawal
        vm.prank(alice);
        bytes32 id2 = channel.openChannel{value: 0.5 ether}(bob, ETH, 0.5 ether, 0);
        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id2,
            version: 1,
            finalBalanceA: 0.5 ether,
            finalBalanceB: 0,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        channel.closeCooperative(id2, abi.encode(cc), _signCoopClose(alicePk, cc), _signCoopClose(bobPk, cc));

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        channel.withdraw(ETH); // alice's credit from id2, unaffected by rr's failure
        assertEq(alice.balance, aliceBefore + 0.5 ether);
    }

    /* ====================================================================== */
    /*  U-03: blocklist asymmetry                                              */
    /* ====================================================================== */

    function test_u03_blocklistedPartyCannotWithdraw_counterpartyCanWithdrawIndependently() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(ptoken), 50_000_000, 30_000_000);

        Adjudicator.ChannelState memory s = _ptokenState(id, 1, 20_000_000, 60_000_000);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));

        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);

        // Circle blocklists alice AFTER finalize — her credit is in pendingWithdrawals
        ptoken.blockAddress(alice);

        // alice's withdraw reverts (ERC-20 rejects the transfer to a blocked address)
        vm.prank(alice);
        vm.expectRevert("blocked");
        channel.withdraw(address(ptoken));

        // alice's credit survives the failed withdraw
        assertEq(channel.pendingWithdrawals(address(ptoken), alice), 20_000_000);

        // bob withdraws independently — alice's blocked status is irrelevant to him
        uint256 bobBefore = ptoken.balanceOf(bob);
        vm.prank(bob);
        channel.withdraw(address(ptoken));
        assertEq(ptoken.balanceOf(bob), bobBefore + 60_000_000);
        assertEq(channel.pendingWithdrawals(address(ptoken), bob), 0);
    }

    /* ====================================================================== */
    /*  Penalty re-routed via pendingWithdrawals                              */
    /* ====================================================================== */

    function test_penalty_reroutedViaPendingWithdrawals() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel{value: FUND_ETH}(bob, ETH, FUND_ETH, 0);

        // Alice cheats with a stale self-favouring state
        Adjudicator.ChannelState memory cheat = _ethState(id, 2, 0.9 ether, 0.1 ether);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheat), _signState(bobPk, cheat));

        // Watchtower submits a dual-signed strictly-newer state
        Adjudicator.ChannelState memory newer = _ethState(id, 5, 0.1 ether, 0.9 ether);
        vm.prank(carol);
        channel.submitPenaltyProof(id, abi.encode(newer), _signState(alicePk, newer), _signState(bobPk, newer));

        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);

        // Full pot credited to non-closer (bob); cheater (alice) gets 0
        assertEq(channel.pendingWithdrawals(ETH, bob), FUND_ETH);
        assertEq(channel.pendingWithdrawals(ETH, alice), 0);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        channel.withdraw(ETH);
        assertEq(bob.balance, bobBefore + FUND_ETH);
    }

    /* ====================================================================== */
    /*  Reentrancy guard on withdraw                                           */
    /* ====================================================================== */

    /// @notice A contract whose receive() re-enters withdraw cannot double-claim:
    ///         the nonReentrant guard causes the inner call to revert, which causes
    ///         the ETH send to fail, which causes the outer withdraw to revert and
    ///         roll back the CEI balance clear — credit is fully preserved.
    function test_withdraw_reentrancyAttemptFails_creditPreserved() public {
        ReentrancyAttacker attacker = new ReentrancyAttacker(channel);
        vm.deal(address(attacker), 10 ether);

        // attacker opens as userA; alice is userB (anti-hostage: no attacker sig needed)
        vm.prank(address(attacker));
        bytes32 id = channel.openChannel{value: FUND_ETH}(alice, ETH, FUND_ETH, 0);

        vm.prank(alice);
        channel.closeUnilateralFromOpen(id);

        skip(channel.DISPUTE_WINDOW() + 1);
        channel.finalize(id);

        assertEq(channel.pendingWithdrawals(ETH, address(attacker)), FUND_ETH);

        // Arm the attacker, then call withdraw; the reentrancy should cause the
        // outer ETH send to fail, reverting the entire withdraw call
        attacker.arm();
        vm.prank(address(attacker));
        vm.expectRevert("ETH send fail");
        channel.withdraw(ETH);

        // Credit is fully restored because the outer withdraw reverted
        assertEq(channel.pendingWithdrawals(ETH, address(attacker)), FUND_ETH);
    }

    /* ====================================================================== */
    /*  Zero-balance withdraw reverts                                          */
    /* ====================================================================== */

    function test_withdraw_nothingToWithdraw_reverts() public {
        vm.prank(alice);
        vm.expectRevert("nothing to withdraw");
        channel.withdraw(address(token));

        vm.prank(alice);
        vm.expectRevert("nothing to withdraw");
        channel.withdraw(ETH);
    }

    function test_withdraw_doubleWithdraw_reverts() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel{value: 0.5 ether}(bob, ETH, 0.5 ether, 0);

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            version: 1,
            finalBalanceA: 0.5 ether,
            finalBalanceB: 0,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        channel.closeCooperative(id, abi.encode(cc), _signCoopClose(alicePk, cc), _signCoopClose(bobPk, cc));

        vm.prank(alice);
        channel.withdraw(ETH);

        vm.prank(alice);
        vm.expectRevert("nothing to withdraw");
        channel.withdraw(ETH);
    }

    /* ====================================================================== */
    /*  Withdrawn event                                                        */
    /* ====================================================================== */

    function test_withdraw_emitsWithdrawnEvent() public {
        vm.prank(alice);
        bytes32 id = channel.openChannel{value: FUND_ETH}(bob, ETH, FUND_ETH, 0);

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            version: 1,
            finalBalanceA: FUND_ETH,
            finalBalanceB: 0,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        channel.closeCooperative(id, abi.encode(cc), _signCoopClose(alicePk, cc), _signCoopClose(bobPk, cc));

        vm.expectEmit(true, true, false, true, address(channel));
        emit PaymentChannel.Withdrawn(ETH, alice, FUND_ETH);
        vm.prank(alice);
        channel.withdraw(ETH);
    }

    /* ====================================================================== */
    /*  Credits accumulate across multiple channels                           */
    /* ====================================================================== */

    function test_withdraw_accumulatesAcrossMultipleChannels() public {
        vm.prank(alice);
        bytes32 id1 = channel.openChannel{value: 0.4 ether}(bob, ETH, 0.4 ether, 0);
        vm.prank(alice);
        bytes32 id2 = channel.openChannel{value: 0.6 ether}(bob, ETH, 0.6 ether, 0);

        Adjudicator.CooperativeClose memory cc1 = Adjudicator.CooperativeClose({
            channelId: id1,
            version: 1,
            finalBalanceA: 0.4 ether,
            finalBalanceB: 0,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        Adjudicator.CooperativeClose memory cc2 = Adjudicator.CooperativeClose({
            channelId: id2,
            version: 1,
            finalBalanceA: 0,
            finalBalanceB: 0.6 ether,
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });

        channel.closeCooperative(id1, abi.encode(cc1), _signCoopClose(alicePk, cc1), _signCoopClose(bobPk, cc1));
        channel.closeCooperative(id2, abi.encode(cc2), _signCoopClose(alicePk, cc2), _signCoopClose(bobPk, cc2));

        // Credits accumulate from both channels
        assertEq(channel.pendingWithdrawals(ETH, alice), 0.4 ether);
        assertEq(channel.pendingWithdrawals(ETH, bob), 0.6 ether);

        // Single withdraw drains accumulated credit
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        channel.withdraw(ETH);
        assertEq(alice.balance, aliceBefore + 0.4 ether);
        assertEq(channel.pendingWithdrawals(ETH, alice), 0);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        channel.withdraw(ETH);
        assertEq(bob.balance, bobBefore + 0.6 ether);
    }

    /* ====================================================================== */
    /*  Helpers                                                                */
    /* ====================================================================== */

    function _ethState(bytes32 channelId, uint64 version, uint256 balanceA, uint256 balanceB)
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

    function _ptokenState(bytes32 channelId, uint64 version, uint256 balanceA, uint256 balanceB)
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
