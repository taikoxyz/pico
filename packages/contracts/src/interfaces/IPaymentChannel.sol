// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Adjudicator} from "../Adjudicator.sol";

/// @title IPaymentChannel
/// @notice Public surface for pico pairwise payment channels.
/// @dev Bodies are out of scope for the bootstrap; only events and signatures are stable.
interface IPaymentChannel {
    /// @notice Emitted when a channel is funded and ready for off-chain updates.
    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed userA,
        address indexed userB,
        address token,
        uint256 amountA,
        uint256 amountB
    );

    /// @notice Emitted when both parties cooperatively close.
    /// @dev `finalBalanceA` and `finalBalanceB` mirror the dual-signed `CooperativeClose`
    ///      payload (which also carries `version` and `validUntil` as replay defenses) so
    ///      off-chain indexers can verify the disbursement split from the event alone,
    ///      without re-decoding calldata.
    event ChannelClosedCooperative(
        bytes32 indexed channelId, uint256 finalBalanceA, uint256 finalBalanceB, uint64 signedAt
    );

    /// @notice Emitted when one party unilaterally posts a state on-chain and the dispute window starts.
    event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline);

    /// @notice Emitted when a counter-state with a higher version successfully challenges a unilateral close.
    event DisputeRaised(bytes32 indexed channelId, uint64 challengerVersion);

    /// @notice Emitted when funds are withdrawn after the dispute window expires.
    event ChannelFinalized(bytes32 indexed channelId, uint256 paidA, uint256 paidB);

    /// @notice Emitted when a depositor adds funds to their side of an open channel via `topUp`.
    event ToppedUp(bytes32 indexed channelId, address indexed depositor, uint256 amount, uint64 newVersion);

    /// @notice Open a new channel funded by `userA` and `userB`.
    /// @param userB The counterparty (typically a hub).
    /// @param token ERC-20 to use, or `address(0)` for ETH.
    /// @param amountA Initial funding from caller.
    /// @param amountB Initial funding from `userB` (often zero in the LSP model).
    /// @return channelId Deterministic id of the channel.
    function openChannel(address userB, address token, uint256 amountA, uint256 amountB)
        external
        payable
        returns (bytes32 channelId);

    /// @notice Close a channel by submitting a dual-signed `CooperativeClose` from both
    ///         parties. The `closeData` ABI-encodes `(Adjudicator.CooperativeClose)`, whose
    ///         `version` MUST be strictly greater than the channel's on-chain
    ///         `postedVersion` and whose `validUntil` MUST be `>= block.timestamp`.
    function closeCooperative(bytes32 channelId, bytes calldata closeData, bytes calldata sigA, bytes calldata sigB)
        external;

    /// @notice Begin a unilateral close with the most recent state the caller has.
    function closeUnilateral(bytes32 channelId, bytes calldata state, bytes calldata sigCounterparty) external;

    /// @notice Begin a unilateral close from the implicit version-0 state of a freshly-opened
    ///         channel. Requires `status == Open` and `postedVersion == 0`. Either party may
    ///         call; the counterparty may still challenge with a strictly-newer dual-signed
    ///         state during the dispute window.
    function closeUnilateralFromOpen(bytes32 channelId) external;

    /// @notice Challenge an in-progress unilateral close with a strictly newer dual-signed
    ///         state. Both parties MUST have signed `state` — a single-party signature
    ///         would allow self-forged states. The dispute window restarts on success.
    function dispute(bytes32 channelId, bytes calldata state, bytes calldata sigA, bytes calldata sigB) external;

    /// @notice Add funds to `msg.sender`'s side of an open channel, gated by a co-signed new
    ///         state that increments only the depositor's balance by exactly `amount`. The
    ///         `prev`/`next` arguments are dual-signed `(state, sigA, sigB)` tuples; see
    ///         §8 of the protocol spec for the full validation rules and the special
    ///         sentinel form for the first top-up on a channel that has no co-signed state
    ///         yet.
    function topUp(
        bytes32 channelId,
        uint256 amount,
        Adjudicator.SignedChannelState calldata prev,
        Adjudicator.SignedChannelState calldata next
    ) external payable;

    /// @notice After the dispute window, withdraw funds according to the latest accepted state.
    function finalize(bytes32 channelId) external;
}
