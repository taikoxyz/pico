// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Adjudicator
/// @notice EIP-712 typed-data verifier for pico signed channel artefacts.
/// @dev Pure verification — never moves funds. The companion `PaymentChannel` is the only
///      contract that holds and pays out USDC; this contract just answers "did A and B sign
///      this exact thing?". Domain is `name="pico", version="1"` to match
///      `packages/protocol/src/eip712.ts`.
contract Adjudicator is Initializable, UUPSUpgradeable, OwnableUpgradeable, EIP712Upgradeable {
    /// @notice ABI-encodable channel state. Field order matches the off-chain typed-data spec.
    /// @param channelId Deterministic channel identifier.
    /// @param version Monotonically increasing per-channel version number.
    /// @param balanceA `userA`'s balance owed if the state is finalised.
    /// @param balanceB `userB`'s balance owed if the state is finalised.
    /// @param htlcsRoot Merkle root over outstanding HTLCs (`bytes32(0)` if none).
    /// @param finalized True when both parties have agreed this is the last state of the channel.
    struct ChannelState {
        bytes32 channelId;
        uint64 version;
        uint256 balanceA;
        uint256 balanceB;
        bytes32 htlcsRoot;
        bool finalized;
    }

    /// @notice ABI-encodable HTLC payload. Order matches the off-chain typed-data spec.
    struct Htlc {
        bytes32 id;
        uint256 amount;
        bytes32 paymentHash;
        uint64 expiry;
        uint8 direction;
    }

    /// @notice ABI-encodable channel-state update. `nextState` is signed transitively as a
    ///         nested `ChannelState`.
    struct Update {
        bytes32 channelId;
        uint64 fromVersion;
        uint64 toVersion;
        ChannelState nextState;
    }

    /// @notice ABI-encodable cooperative-close attestation. Distinct from `ChannelState` so
    ///         operators can sign a one-shot close without committing to a specific HTLC root.
    /// @param channelId Deterministic channel identifier.
    /// @param version Strictly greater than the channel's on-chain `postedVersion`. Replay defence.
    /// @param finalBalanceA `userA`'s final balance.
    /// @param finalBalanceB `userB`'s final balance.
    /// @param signedAt Unix-second timestamp at which both parties signed the close.
    /// @param validUntil Unix-second deadline; the contract rejects when `block.timestamp > validUntil`.
    struct CooperativeClose {
        bytes32 channelId;
        uint64 version;
        uint256 finalBalanceA;
        uint256 finalBalanceB;
        uint64 signedAt;
        uint64 validUntil;
    }

    /// @notice ABI-encodable bundle of a `ChannelState` and the dual signatures over it.
    ///         Used as the prev/new arguments to `PaymentChannel.topUp` (§8).
    struct SignedChannelState {
        ChannelState state;
        bytes sigA;
        bytes sigB;
    }

    bytes32 internal constant CHANNEL_STATE_TYPEHASH = keccak256(
        "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)"
    );

    bytes32 internal constant HTLC_TYPEHASH =
        keccak256("Htlc(bytes32 id,uint256 amount,bytes32 paymentHash,uint64 expiry,uint8 direction)");

    bytes32 internal constant UPDATE_TYPEHASH = keccak256(
        "Update(bytes32 channelId,uint64 fromVersion,uint64 toVersion,ChannelState nextState)ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)"
    );

    bytes32 internal constant COOPERATIVE_CLOSE_TYPEHASH = keccak256(
        "CooperativeClose(bytes32 channelId,uint64 version,uint256 finalBalanceA,uint256 finalBalanceB,uint64 signedAt,uint64 validUntil)"
    );

    /// @dev Reserved storage gap to allow future upgrades to add storage without colliding with
    ///      child-contract layouts. OZ pattern.
    uint256[50] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Sets the EIP-712 domain to `("pico", "1")` so digests
    ///         match the off-chain signer.
    /// @param initialOwner Address that may authorize UUPS upgrades.
    function initialize(address initialOwner) external initializer {
        require(initialOwner != address(0), "owner=0");
        // See PaymentChannel.initialize: skipping `__Ownable_init()` to avoid the
        // intermediate `OwnershipTransferred(0, deployer)` event that OZ v4.9.6 would emit.
        _transferOwnership(initialOwner);
        __UUPSUpgradeable_init();
        __EIP712_init("pico", "1");
    }

    /// @notice EIP-712 struct hash of a `ChannelState`.
    function hashChannelState(ChannelState calldata state) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH,
                state.channelId,
                state.version,
                state.balanceA,
                state.balanceB,
                state.htlcsRoot,
                state.finalized
            )
        );
    }

    /// @notice EIP-712 struct hash of an `Htlc`.
    function hashHtlc(Htlc calldata htlc) public pure returns (bytes32) {
        return keccak256(abi.encode(HTLC_TYPEHASH, htlc.id, htlc.amount, htlc.paymentHash, htlc.expiry, htlc.direction));
    }

    /// @notice EIP-712 struct hash of an `Update` (which transitively hashes `nextState`).
    function hashUpdate(Update calldata u) public pure returns (bytes32) {
        bytes32 nextHash = keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH,
                u.nextState.channelId,
                u.nextState.version,
                u.nextState.balanceA,
                u.nextState.balanceB,
                u.nextState.htlcsRoot,
                u.nextState.finalized
            )
        );
        return keccak256(abi.encode(UPDATE_TYPEHASH, u.channelId, u.fromVersion, u.toVersion, nextHash));
    }

    /// @notice EIP-712 struct hash of a `CooperativeClose`.
    function hashCooperativeClose(CooperativeClose calldata cc) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                COOPERATIVE_CLOSE_TYPEHASH,
                cc.channelId,
                cc.version,
                cc.finalBalanceA,
                cc.finalBalanceB,
                cc.signedAt,
                cc.validUntil
            )
        );
    }

    /// @notice Recover the signer of a `ChannelState` typed-data signature.
    /// @return signer Address that produced `sig`, or `address(0)` if the signature is malformed.
    function recoverStateSigner(ChannelState calldata state, bytes calldata sig) public view returns (address) {
        bytes32 digest = _hashTypedDataV4(hashChannelState(state));
        return _tryRecover(digest, sig);
    }

    /// @notice Recover the signer of an `Update` typed-data signature.
    function recoverUpdateSigner(Update calldata u, bytes calldata sig) public view returns (address) {
        bytes32 digest = _hashTypedDataV4(hashUpdate(u));
        return _tryRecover(digest, sig);
    }

    /// @notice Recover the signer of a `CooperativeClose` typed-data signature.
    function recoverCooperativeCloseSigner(CooperativeClose calldata cc, bytes calldata sig)
        public
        view
        returns (address)
    {
        bytes32 digest = _hashTypedDataV4(hashCooperativeClose(cc));
        return _tryRecover(digest, sig);
    }

    /// @notice Recover the signer of an `Htlc` typed-data signature. Provided for completeness;
    ///         the channel never gates on a single-HTLC signature, but watchtowers may.
    function recoverHtlcSigner(Htlc calldata htlc, bytes calldata sig) public view returns (address) {
        bytes32 digest = _hashTypedDataV4(hashHtlc(htlc));
        return _tryRecover(digest, sig);
    }

    /// @notice True iff `sigA` is valid for `userA` and `sigB` is valid for `userB` over `state`.
    /// @dev Returns false (rather than reverting) on malformed signatures so callers can branch.
    function verifyDualSig(
        address userA,
        address userB,
        ChannelState calldata state,
        bytes calldata sigA,
        bytes calldata sigB
    ) external view returns (bool) {
        if (userA == address(0) || userB == address(0)) return false;
        bytes32 digest = _hashTypedDataV4(hashChannelState(state));
        address recoveredA = _tryRecover(digest, sigA);
        address recoveredB = _tryRecover(digest, sigB);
        return recoveredA == userA && recoveredB == userB;
    }

    /// @notice Dual-signature helper for `CooperativeClose` (both parties co-signing a close).
    function verifyDualCooperativeClose(
        address userA,
        address userB,
        CooperativeClose calldata cc,
        bytes calldata sigA,
        bytes calldata sigB
    ) external view returns (bool) {
        if (userA == address(0) || userB == address(0)) return false;
        bytes32 digest = _hashTypedDataV4(hashCooperativeClose(cc));
        address recoveredA = _tryRecover(digest, sigA);
        address recoveredB = _tryRecover(digest, sigB);
        return recoveredA == userA && recoveredB == userB;
    }

    /// @dev `ECDSA.tryRecover` swallows malformed signatures by returning `(address(0), err)`
    ///      and we surface that as `address(0)` to callers.
    function _tryRecover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError) return address(0);
        return recovered;
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
