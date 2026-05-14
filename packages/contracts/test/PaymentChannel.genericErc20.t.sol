// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title PaymentChannelGenericErc20Test
/// @notice Lifecycle coverage for an ERC-20 with non-USDC decimals (18). Confirms
///         the contract is decimals-agnostic now that the funding floor is per-token
///         instead of a hardcoded USDC-scaled constant.
contract PaymentChannelGenericErc20Test is Fixtures {
    MockERC20 internal weth18;
    uint256 internal constant ONE = 1 ether; // 1e18 base units
    uint256 internal constant MIN = ONE / 100; // 0.01 token
    uint256 internal constant FUND_A = 5 * ONE;
    uint256 internal constant FUND_B = 3 * ONE;

    function setUp() public {
        _deployStack();

        weth18 = new MockERC20("Wrapped Ether", "WETH", 18);
        vm.startPrank(owner);
        channel.setTokenAllowed(address(weth18), true);
        channel.setMinChannelAmount(address(weth18), MIN);
        vm.stopPrank();

        _fundWeth(alice, 1_000 * ONE);
        _fundWeth(bob, 1_000 * ONE);
        _fundWeth(carol, 1_000 * ONE);
    }

    function test_open_happyPath_pullsFromBothParties() public {
        uint256 aliceBefore = weth18.balanceOf(alice);
        uint256 bobBefore = weth18.balanceOf(bob);

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(weth18), FUND_A, FUND_B);

        assertEq(weth18.balanceOf(alice), aliceBefore - FUND_A);
        assertEq(weth18.balanceOf(bob), bobBefore - FUND_B);
        assertEq(weth18.balanceOf(address(channel)), FUND_A + FUND_B);
        PaymentChannel.Channel memory ch = channel.channels(id);
        assertEq(ch.token, address(weth18));
        assertEq(ch.amountA, FUND_A);
        assertEq(ch.amountB, FUND_B);
    }

    function test_open_revertsBelowMin_perToken() public {
        // The hardcoded USDC floor is gone — each token has its own minimum. WETH's
        // floor (0.01 ether) is what gates here, not the 10-USDC scale.
        vm.prank(alice);
        vm.expectRevert(bytes("amount<min"));
        channel.openChannel(bob, address(weth18), MIN / 2, MIN / 2 - 1);
    }

    function test_closeCooperative_disbursesEighteenDecimalSplit() public {
        bytes32 id = _open();
        Adjudicator.CooperativeClose memory cc = _coopClose(id, 2 * ONE, 6 * ONE);
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);

        uint256 aliceBefore = weth18.balanceOf(alice);
        uint256 bobBefore = weth18.balanceOf(bob);

        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);

        vm.prank(alice);
        channel.withdraw(address(weth18));
        vm.prank(bob);
        channel.withdraw(address(weth18));

        assertEq(weth18.balanceOf(alice), aliceBefore + 2 * ONE);
        assertEq(weth18.balanceOf(bob), bobBefore + 6 * ONE);
        assertEq(weth18.balanceOf(address(channel)), 0);
    }

    function test_finalize_distributesPostedSplit() public {
        bytes32 id = _open();
        Adjudicator.ChannelState memory s = _state(id, 7, 4 * ONE, 4 * ONE);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), _signState(bobPk, s));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 aliceBefore = weth18.balanceOf(alice);
        uint256 bobBefore = weth18.balanceOf(bob);
        channel.finalize(id);

        vm.prank(alice);
        channel.withdraw(address(weth18));
        vm.prank(bob);
        channel.withdraw(address(weth18));

        assertEq(weth18.balanceOf(alice), aliceBefore + 4 * ONE);
        assertEq(weth18.balanceOf(bob), bobBefore + 4 * ONE);
    }

    function test_penalty_sendsAllToHonestParty() public {
        bytes32 id = _open();
        Adjudicator.ChannelState memory cheat = _state(id, 2, 7 * ONE, ONE);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(cheat), _signState(bobPk, cheat));

        Adjudicator.ChannelState memory newer = _state(id, 5, ONE, 7 * ONE);
        vm.prank(carol);
        channel.submitPenaltyProof(id, abi.encode(newer), _signState(alicePk, newer), _signState(bobPk, newer));

        skip(channel.DISPUTE_WINDOW() + 1);

        uint256 aliceBefore = weth18.balanceOf(alice);
        uint256 bobBefore = weth18.balanceOf(bob);
        channel.finalize(id);

        vm.prank(bob);
        channel.withdraw(address(weth18));

        assertEq(weth18.balanceOf(alice), aliceBefore, "cheater gets nothing");
        assertEq(weth18.balanceOf(bob), bobBefore + FUND_A + FUND_B, "honest party gets full pot");
    }

    function _fundWeth(address who, uint256 amount) internal {
        weth18.mint(who, amount);
        vm.prank(who);
        weth18.approve(address(channel), type(uint256).max);
    }

    function _open() internal returns (bytes32) {
        vm.prank(alice);
        return channel.openChannel(bob, address(weth18), FUND_A, FUND_B);
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
