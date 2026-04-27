// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPaymentChannel} from "./interfaces/IPaymentChannel.sol";
import {IWatchtower} from "./interfaces/IWatchtower.sol";

/// @title PaymentChannel
/// @notice Pairwise payment channel contract for the tainnel 1-hop network.
/// @dev Bootstrap stub: all mutating methods revert with `"not implemented"`.
contract PaymentChannel is IPaymentChannel, IWatchtower {
    /// @notice Address of the Adjudicator contract used to verify EIP-712 signed states.
    address public immutable adjudicator;

    constructor(address _adjudicator) {
        adjudicator = _adjudicator;
    }

    /// @inheritdoc IPaymentChannel
    function openChannel(address, address, uint256, uint256) external payable returns (bytes32) {
        revert("not implemented");
    }

    /// @inheritdoc IPaymentChannel
    function closeCooperative(bytes32, bytes calldata, bytes calldata, bytes calldata) external pure {
        revert("not implemented");
    }

    /// @inheritdoc IPaymentChannel
    function closeUnilateral(bytes32, bytes calldata, bytes calldata) external pure {
        revert("not implemented");
    }

    /// @inheritdoc IPaymentChannel
    function dispute(bytes32, bytes calldata, bytes calldata) external pure {
        revert("not implemented");
    }

    /// @inheritdoc IPaymentChannel
    function finalize(bytes32) external pure {
        revert("not implemented");
    }

    /// @inheritdoc IWatchtower
    function submitPenaltyProof(bytes32, bytes calldata, bytes calldata) external pure {
        revert("not implemented");
    }
}
