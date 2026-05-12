// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {Adjudicator} from "../../src/Adjudicator.sol";
import {PaymentChannel} from "../../src/PaymentChannel.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title Fixtures
/// @notice Shared deploy + sign helpers for the pico contract test suite.
abstract contract Fixtures is Test {
    address internal owner = makeAddr("owner");

    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;
    uint256 internal carolPk = 0xCAFE;

    address internal alice;
    address internal bob;
    address internal carol;

    Adjudicator internal adjudicator;
    PaymentChannel internal channel;
    MockERC20 internal token;

    bytes32 internal cachedDomainSeparator;

    function _deployStack() internal {
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        carol = vm.addr(carolPk);
        vm.label(alice, "alice");
        vm.label(bob, "bob");
        vm.label(carol, "carol");

        Adjudicator adjImpl = new Adjudicator();
        bytes memory adjInit = abi.encodeCall(Adjudicator.initialize, (owner));
        adjudicator = Adjudicator(address(new ERC1967Proxy(address(adjImpl), adjInit)));

        PaymentChannel pcImpl = new PaymentChannel();
        bytes memory pcInit = abi.encodeCall(PaymentChannel.initialize, (owner, address(adjudicator)));
        channel = PaymentChannel(address(new ERC1967Proxy(address(pcImpl), pcInit)));

        token = new MockERC20("USD Coin", "USDC", 6);
        vm.startPrank(owner);
        channel.setTokenAllowed(address(token), true);
        // Mirror the v1 USDC floor (10 USDC) so existing tests keep their `amount<min`
        // expectations. Per-token minimums default to 0; ERC-20 + ETH tokens added in
        // dedicated test files set their own floors.
        channel.setMinChannelAmount(address(token), 10_000_000);
        vm.stopPrank();

        cachedDomainSeparator = _computeDomainSeparator();
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            adjudicator.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    function _fund(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(channel), type(uint256).max);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return cachedDomainSeparator;
    }

    function _digestState(Adjudicator.ChannelState memory state) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)"
                ),
                state.channelId,
                state.version,
                state.balanceA,
                state.balanceB,
                state.htlcsRoot,
                state.finalized
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _digestUpdate(Adjudicator.Update memory u) internal view returns (bytes32) {
        bytes32 nextHash = keccak256(
            abi.encode(
                keccak256(
                    "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)"
                ),
                u.nextState.channelId,
                u.nextState.version,
                u.nextState.balanceA,
                u.nextState.balanceB,
                u.nextState.htlcsRoot,
                u.nextState.finalized
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Update(bytes32 channelId,uint64 fromVersion,uint64 toVersion,ChannelState nextState)ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)"
                ),
                u.channelId,
                u.fromVersion,
                u.toVersion,
                nextHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _digestCoopClose(Adjudicator.CooperativeClose memory cc) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "CooperativeClose(bytes32 channelId,uint64 version,uint256 finalBalanceA,uint256 finalBalanceB,uint64 signedAt,uint64 validUntil)"
                ),
                cc.channelId,
                cc.version,
                cc.finalBalanceA,
                cc.finalBalanceB,
                cc.signedAt,
                cc.validUntil
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _digestHtlc(Adjudicator.Htlc memory htlc) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Htlc(bytes32 id,uint256 amount,bytes32 paymentHash,uint64 expiry,uint8 direction)"),
                htlc.id,
                htlc.amount,
                htlc.paymentHash,
                htlc.expiry,
                htlc.direction
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _signState(uint256 pk, Adjudicator.ChannelState memory state) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digestState(state));
        return abi.encodePacked(r, s, v);
    }

    function _signCoopClose(uint256 pk, Adjudicator.CooperativeClose memory cc) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digestCoopClose(cc));
        return abi.encodePacked(r, s, v);
    }

    function _signUpdate(uint256 pk, Adjudicator.Update memory u) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digestUpdate(u));
        return abi.encodePacked(r, s, v);
    }

    function _signHtlc(uint256 pk, Adjudicator.Htlc memory htlc) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digestHtlc(htlc));
        return abi.encodePacked(r, s, v);
    }
}
