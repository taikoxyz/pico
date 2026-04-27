// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HTLC
/// @notice Hash-time-locked contract primitives shared across PaymentChannel and Adjudicator.
/// @dev Library form: stateless, side-effect-free helpers only.
library HTLC {
    /// @notice An HTLC commitment as it appears inside a channel state hash.
    struct Lock {
        bytes32 id;
        uint256 amount;
        bytes32 paymentHash;
        uint64 expiry;
        uint8 direction;
    }

    /// @notice Compute the canonical hash of a single HTLC lock, used for inclusion in `htlcsRoot`.
    /// @dev Returns keccak256(abi.encode(...)). Bodies revert until the protocol-spec is locked in.
    function hashLock(Lock memory) internal pure returns (bytes32) {
        revert("not implemented");
    }

    /// @notice Verify that `preimage` matches `paymentHash` (sha256 by default per spec).
    function verifyPreimage(bytes32, bytes calldata) internal pure returns (bool) {
        revert("not implemented");
    }

    /// @notice Aggregate an array of locks into a Merkle/poseidon root, anchoring HTLC set into a state.
    function rootOf(Lock[] memory) internal pure returns (bytes32) {
        revert("not implemented");
    }
}
