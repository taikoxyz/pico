// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Adjudicator
/// @notice Verifies signed channel states for dispute resolution.
/// @dev EIP-712 typed-data verification will live here; bodies stubbed until protocol-spec lands.
contract Adjudicator {
    /// @notice EIP-712 domain separator computed at deployment time.
    bytes32 public immutable DOMAIN_SEPARATOR;

    constructor(uint256 chainId, address verifyingContract) {
        DOMAIN_SEPARATOR = keccak256(abi.encode(chainId, verifyingContract));
    }

    /// @notice Recover the signer of a typed-data digest covering the supplied state encoding.
    /// @return signer The recovered signer, or `address(0)` if the signature is invalid.
    function recoverStateSigner(bytes calldata, bytes calldata) external pure returns (address signer) {
        signer;
        revert("not implemented");
    }

    /// @notice Returns true when both signatures cover `stateEncoded` and come from `userA` and `userB`.
    function verifyDualSig(
        address, /* userA */
        address, /* userB */
        bytes calldata, /* stateEncoded */
        bytes calldata, /* sigA */
        bytes calldata /* sigB */
    ) external pure returns (bool) {
        revert("not implemented");
    }
}
