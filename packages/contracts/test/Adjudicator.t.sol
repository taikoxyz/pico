// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @title AdjudicatorTest
/// @notice Tests EIP-712 typed-data signing & recovery for `ChannelState`, `Update`,
///         `CooperativeClose`, and `Htlc`. The off-chain signer in `packages/protocol`
///         must produce identical digests; mismatches will surface here as failed
///         recovery tests.
contract AdjudicatorTest is Fixtures {
    function setUp() public {
        _deployStack();
    }

    /* -------------------------------------------------------------------- */
    /*  Initialization                                                       */
    /* -------------------------------------------------------------------- */

    function test_initialize_setsDomain() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            adjudicator.eip712Domain();
        assertEq(name, "pico");
        assertEq(version, "2");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(adjudicator));
    }

    function test_initialize_revertsIfCalledAgain() public {
        vm.expectRevert();
        adjudicator.initialize(address(this));
    }

    function test_initialize_revertsOnImplementationDirectly() public {
        Adjudicator impl = new Adjudicator();
        vm.expectRevert();
        impl.initialize(address(this));
    }

    /* -------------------------------------------------------------------- */
    /*  recoverStateSigner                                                   */
    /* -------------------------------------------------------------------- */

    function test_recoverStateSigner_recoversCorrectSigner() public view {
        Adjudicator.ChannelState memory state = _state(bytes32(uint256(0xC1)), 1, 100, 200, false);
        bytes memory sig = _signState(alicePk, state);
        assertEq(adjudicator.recoverStateSigner(state, sig), alice);
    }

    function test_recoverStateSigner_returnsZeroOnMalformedSig() public view {
        Adjudicator.ChannelState memory state = _state(bytes32(uint256(0xC1)), 1, 100, 200, false);
        bytes memory bad = hex"deadbeef";
        assertEq(adjudicator.recoverStateSigner(state, bad), address(0));
    }

    function test_recoverStateSigner_recoversWrongSignerWhenStateTampered() public view {
        Adjudicator.ChannelState memory original = _state(bytes32(uint256(0xC1)), 1, 100, 200, false);
        bytes memory sig = _signState(alicePk, original);

        Adjudicator.ChannelState memory tampered = original;
        tampered.balanceA = 999;
        address recovered = adjudicator.recoverStateSigner(tampered, sig);
        assertTrue(recovered != alice, "must not recover alice from tampered state");
    }

    /* -------------------------------------------------------------------- */
    /*  verifyDualSig                                                        */
    /* -------------------------------------------------------------------- */

    function test_verifyDualSig_happyPath() public view {
        Adjudicator.ChannelState memory state = _state(bytes32(uint256(0xC1)), 5, 100, 200, true);
        bytes memory sigA = _signState(alicePk, state);
        bytes memory sigB = _signState(bobPk, state);
        assertTrue(adjudicator.verifyDualSig(alice, bob, state, sigA, sigB));
    }

    function test_verifyDualSig_falseWhenSigASwappedWithThirdParty() public view {
        Adjudicator.ChannelState memory state = _state(bytes32(uint256(0xC1)), 5, 100, 200, true);
        bytes memory sigCarol = _signState(carolPk, state);
        bytes memory sigB = _signState(bobPk, state);
        assertFalse(adjudicator.verifyDualSig(alice, bob, state, sigCarol, sigB));
    }

    function test_verifyDualSig_falseWhenZeroAddressParticipant() public view {
        Adjudicator.ChannelState memory state = _state(bytes32(uint256(0xC1)), 5, 100, 200, true);
        bytes memory sigA = _signState(alicePk, state);
        bytes memory sigB = _signState(bobPk, state);
        assertFalse(adjudicator.verifyDualSig(address(0), bob, state, sigA, sigB));
        assertFalse(adjudicator.verifyDualSig(alice, address(0), state, sigA, sigB));
    }

    function test_verifyDualSig_falseOnMalformedSig() public view {
        Adjudicator.ChannelState memory state = _state(bytes32(uint256(0xC1)), 5, 100, 200, true);
        bytes memory sigB = _signState(bobPk, state);
        assertFalse(adjudicator.verifyDualSig(alice, bob, state, hex"00", sigB));
    }

    /* -------------------------------------------------------------------- */
    /*  Update                                                               */
    /* -------------------------------------------------------------------- */

    function test_recoverUpdateSigner_happyPath() public view {
        Adjudicator.ChannelState memory next = _state(bytes32(uint256(0xC1)), 2, 50, 250, false);
        Adjudicator.Update memory u =
            Adjudicator.Update({channelId: bytes32(uint256(0xC1)), fromVersion: 1, toVersion: 2, nextState: next});
        bytes memory sig = _signUpdate(alicePk, u);
        assertEq(adjudicator.recoverUpdateSigner(u, sig), alice);
    }

    function test_recoverUpdateSigner_tamperedFromVersionFails() public view {
        Adjudicator.ChannelState memory next = _state(bytes32(uint256(0xC1)), 2, 50, 250, false);
        Adjudicator.Update memory u =
            Adjudicator.Update({channelId: bytes32(uint256(0xC1)), fromVersion: 1, toVersion: 2, nextState: next});
        bytes memory sig = _signUpdate(alicePk, u);

        u.fromVersion = 99;
        assertTrue(adjudicator.recoverUpdateSigner(u, sig) != alice);
    }

    /* -------------------------------------------------------------------- */
    /*  CooperativeClose                                                     */
    /* -------------------------------------------------------------------- */

    function test_recoverCooperativeCloseSigner_happyPath() public view {
        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: bytes32(uint256(0xC1)),
            version: 1,
            finalBalanceA: 100,
            finalBalanceB: 200,
            signedAt: 1234,
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _signCoopClose(alicePk, cc);
        assertEq(adjudicator.recoverCooperativeCloseSigner(cc, sig), alice);
    }

    function test_verifyDualCooperativeClose_happyPath() public view {
        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: bytes32(uint256(0xC1)),
            version: 1,
            finalBalanceA: 100,
            finalBalanceB: 200,
            signedAt: 1234,
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        assertTrue(adjudicator.verifyDualCooperativeClose(alice, bob, cc, sigA, sigB));
    }

    function test_verifyDualCooperativeClose_falseOnZeroAddress() public view {
        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: bytes32(uint256(0xC1)),
            version: 1,
            finalBalanceA: 100,
            finalBalanceB: 200,
            signedAt: 1234,
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        assertFalse(adjudicator.verifyDualCooperativeClose(address(0), bob, cc, sigA, sigB));
        assertFalse(adjudicator.verifyDualCooperativeClose(alice, address(0), cc, sigA, sigB));
    }

    /* -------------------------------------------------------------------- */
    /*  Htlc                                                                 */
    /* -------------------------------------------------------------------- */

    function test_recoverHtlcSigner_happyPath() public view {
        Adjudicator.Htlc memory htlc = Adjudicator.Htlc({
            id: bytes32(uint256(0x01)), amount: 500, paymentHash: bytes32(uint256(0xAA)), expiry: 100, direction: 0
        });
        bytes memory sig = _signHtlc(alicePk, htlc);
        assertEq(adjudicator.recoverHtlcSigner(htlc, sig), alice);
    }

    /* -------------------------------------------------------------------- */
    /*  Hashing                                                              */
    /* -------------------------------------------------------------------- */

    function test_hashChannelState_matchesManualEncode() public view {
        Adjudicator.ChannelState memory s = _state(bytes32(uint256(0xC1)), 5, 100, 200, true);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,uint16 htlcsCount,uint256 htlcsTotalLocked,bool finalized)"
                ),
                s.channelId,
                s.version,
                s.balanceA,
                s.balanceB,
                s.htlcsRoot,
                s.htlcsCount,
                s.htlcsTotalLocked,
                s.finalized
            )
        );
        assertEq(this._hashChannelState(s), expected);
    }

    function _hashChannelState(Adjudicator.ChannelState calldata s) external view returns (bytes32) {
        return adjudicator.hashChannelState(s);
    }

    function test_hashHtlc_matchesManualEncode() public view {
        Adjudicator.Htlc memory htlc = Adjudicator.Htlc({
            id: bytes32(uint256(0x01)), amount: 500, paymentHash: bytes32(uint256(0xAA)), expiry: 100, direction: 0
        });
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("Htlc(bytes32 id,uint256 amount,bytes32 paymentHash,uint64 expiry,uint8 direction)"),
                htlc.id,
                htlc.amount,
                htlc.paymentHash,
                htlc.expiry,
                htlc.direction
            )
        );
        assertEq(this._hashHtlc(htlc), expected);
    }

    function _hashHtlc(Adjudicator.Htlc calldata h) external view returns (bytes32) {
        return adjudicator.hashHtlc(h);
    }

    function test_hashUpdate_matchesManualEncode() public view {
        Adjudicator.ChannelState memory next = _state(bytes32(uint256(0xC1)), 2, 50, 250, false);
        Adjudicator.Update memory u =
            Adjudicator.Update({channelId: bytes32(uint256(0xC1)), fromVersion: 1, toVersion: 2, nextState: next});
        bytes32 nextHash = keccak256(
            abi.encode(
                keccak256(
                    "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,uint16 htlcsCount,uint256 htlcsTotalLocked,bool finalized)"
                ),
                next.channelId,
                next.version,
                next.balanceA,
                next.balanceB,
                next.htlcsRoot,
                next.htlcsCount,
                next.htlcsTotalLocked,
                next.finalized
            )
        );
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "Update(bytes32 channelId,uint64 fromVersion,uint64 toVersion,ChannelState nextState)ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,uint16 htlcsCount,uint256 htlcsTotalLocked,bool finalized)"
                ),
                u.channelId,
                u.fromVersion,
                u.toVersion,
                nextHash
            )
        );
        assertEq(this._hashUpdate(u), expected);
    }

    function _hashUpdate(Adjudicator.Update calldata u) external view returns (bytes32) {
        return adjudicator.hashUpdate(u);
    }

    function test_hashCooperativeClose_matchesManualEncode() public view {
        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: bytes32(uint256(0xC1)),
            version: 1,
            finalBalanceA: 100,
            finalBalanceB: 200,
            signedAt: 1234,
            validUntil: uint64(block.timestamp + 1 hours)
        });
        bytes32 expected = keccak256(
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
        assertEq(this._hashCoopClose(cc), expected);
    }

    function _hashCoopClose(Adjudicator.CooperativeClose calldata cc) external view returns (bytes32) {
        return adjudicator.hashCooperativeClose(cc);
    }

    /* -------------------------------------------------------------------- */
    /*  UUPS upgrade authorisation                                           */
    /* -------------------------------------------------------------------- */

    function test_upgrade_onlyOwnerCanUpgrade() public {
        Adjudicator newImpl = new Adjudicator();
        vm.prank(alice);
        vm.expectRevert();
        adjudicator.upgradeTo(address(newImpl));
    }

    function test_upgrade_ownerSucceeds() public {
        Adjudicator newImpl = new Adjudicator();
        vm.prank(owner);
        adjudicator.upgradeTo(address(newImpl));
        // post-upgrade state: contract still functional, owner unchanged
        assertEq(adjudicator.owner(), owner);
    }

    /* -------------------------------------------------------------------- */
    /*  Fuzz: any private key recovers identically                           */
    /* -------------------------------------------------------------------- */

    function testFuzz_recoverStateSigner_any(uint256 pkSeed, bytes32 channelId, uint64 version) public view {
        uint256 pk = bound(pkSeed, 1, type(uint128).max);
        address signer = vm.addr(pk);
        Adjudicator.ChannelState memory state = _state(channelId, version, 0, 0, false);
        bytes memory sig = _signState(pk, state);
        assertEq(adjudicator.recoverStateSigner(state, sig), signer);
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
            htlcsCount: 0,
            htlcsTotalLocked: 0,
            finalized: finalized
        });
    }
}
