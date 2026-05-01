// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IWatchtower
/// @notice Surface a PaymentChannel exposes for trusted watchtower bots.
interface IWatchtower {
    /// @notice Submit a penalty proof showing a counterparty published an old state.
    /// @dev Both parties MUST have signed `penaltyState`. MUST revert if the proof is
    ///      older-or-equal to the currently posted state or the dispute window expired.
    function submitPenaltyProof(
        bytes32 channelId,
        bytes calldata penaltyState,
        bytes calldata sigA,
        bytes calldata sigB
    ) external;
}
