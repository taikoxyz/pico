// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPaymentChannel} from "./interfaces/IPaymentChannel.sol";
import {IWatchtower} from "./interfaces/IWatchtower.sol";
import {Adjudicator} from "./Adjudicator.sol";

/// @title PaymentChannel
/// @notice Pairwise payment channel core for the tainnel 1-hop network.
/// @dev v1 simplifications (locked decisions):
///       - USDC-only. ETH (`token == address(0)`) is rejected at `openChannel`.
///       - Both parties co-fund: `safeTransferFrom` runs against `userA` and `userB`. Both
///         must have approved this contract before `openChannel` is called.
///       - 100% slash on penalty (the `closeUnilateral` caller forfeits *all* funds in the
///         channel to the honest counterparty when an `oldState` proof shows they posted a
///         stale state).
///       - Dispute and cooperative paths assume `htlcsRoot == bytes32(0)`. Posting a state
///         with in-flight HTLCs reverts. This is consistent with the 1-hop dogfood scope:
///         HTLCs only live inside a single payment, and any close happens between payments.
///       - UUPS upgradeable behind `ERC1967Proxy`. `_authorizeUpgrade` is gated by an owner.
contract PaymentChannel is
    IPaymentChannel,
    IWatchtower,
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Lifecycle state of a single channel.
    enum Status {
        None,
        Open,
        ClosingUnilateral,
        Closed
    }

    /// @notice On-chain channel record.
    struct Channel {
        address userA;
        address userB;
        address token;
        uint256 amountA;
        uint256 amountB;
        uint64 openedAt;
        uint64 disputeDeadline;
        uint64 postedVersion;
        uint256 postedBalanceA;
        uint256 postedBalanceB;
        bool penalized;
        Status status;
        address closer;
    }

    /// @notice Length of the dispute window in seconds. Mirrors
    ///         `DEFAULT_DISPUTE_WINDOW_MS` in `packages/protocol`.
    uint64 public constant DISPUTE_WINDOW = 24 hours;

    /// @notice Lower bound on initial channel funding. Denominated in the channel token's
    ///         smallest unit. v1 only allows USDC (6 decimals), so 10 USDC = 10_000_000.
    uint256 public constant MIN_CHANNEL_AMOUNT = 10_000_000;

    /// @notice EIP-712 verifier. Set once at `initialize`; can be rotated via UUPS upgrade.
    Adjudicator public adjudicator;

    /// @notice Allowlist of accepted ERC-20 tokens. Owner-managed via `setTokenAllowed`.
    mapping(address => bool) public allowedTokens;

    /// @notice Open and historical channels by id.
    mapping(bytes32 => Channel) internal _channels;

    /// @notice Monotonically incrementing nonce to keep `channelId` unique even when
    ///         `userA`, `userB`, `token` and `block.timestamp` collide.
    uint256 public openNonce;

    /// @dev Storage gap for upgrade safety.
    uint256[44] private __gap;

    /// @notice Emitted when the owner toggles a token's allowlist entry.
    event TokenAllowed(address indexed token, bool allowed);

    /// @notice Emitted when a successful penalty proof slashes the unilateral closer.
    event PenaltyApplied(bytes32 indexed channelId, address indexed cheater, address indexed beneficiary);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param initialOwner Owner that may toggle the token allowlist and authorize upgrades.
    /// @param adjudicator_ Address of the deployed `Adjudicator` proxy.
    function initialize(address initialOwner, address adjudicator_) external initializer {
        require(adjudicator_ != address(0), "adjudicator=0");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        adjudicator = Adjudicator(adjudicator_);
    }

    /// @notice Owner-only: add or remove a token from the channel-token allowlist.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        require(token != address(0), "token=0");
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice Read a channel record by id.
    function channels(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    /// @inheritdoc IPaymentChannel
    /// @dev Reverts if `token == address(0)` (D2.3: ETH disabled in v1) or if `token` is not
    ///      on the allowlist. Both `msg.sender` and `userB` must have approved this contract
    ///      for at least `amountA` and `amountB` respectively before calling.
    function openChannel(address userB, address token, uint256 amountA, uint256 amountB)
        external
        payable
        nonReentrant
        returns (bytes32 channelId)
    {
        require(msg.value == 0, "no ETH");
        require(token != address(0), "ETH disabled");
        require(allowedTokens[token], "token !allowed");
        require(userB != address(0), "userB=0");
        require(userB != msg.sender, "self-channel");
        require(amountA + amountB >= MIN_CHANNEL_AMOUNT, "amount<min");

        uint256 nonce = openNonce++;
        channelId = keccak256(abi.encode(msg.sender, userB, token, block.timestamp, nonce));
        require(_channels[channelId].status == Status.None, "exists");

        _channels[channelId] = Channel({
            userA: msg.sender,
            userB: userB,
            token: token,
            amountA: amountA,
            amountB: amountB,
            openedAt: uint64(block.timestamp),
            disputeDeadline: 0,
            postedVersion: 0,
            postedBalanceA: 0,
            postedBalanceB: 0,
            penalized: false,
            status: Status.Open,
            closer: address(0)
        });

        if (amountA > 0) IERC20(token).safeTransferFrom(msg.sender, address(this), amountA);
        if (amountB > 0) IERC20(token).safeTransferFrom(userB, address(this), amountB);

        emit ChannelOpened(channelId, msg.sender, userB, token, amountA, amountB);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev `finalState` MUST abi-encode to `(Adjudicator.ChannelState)`. The state must
    ///      match `channelId`, be marked `finalized`, conserve total balance and carry an
    ///      empty HTLC root.
    function closeCooperative(bytes32 channelId, bytes calldata finalState, bytes calldata sigA, bytes calldata sigB)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");

        Adjudicator.ChannelState memory state = abi.decode(finalState, (Adjudicator.ChannelState));
        require(state.channelId == channelId, "channelId");
        require(state.finalized, "!finalized");
        require(state.htlcsRoot == bytes32(0), "htlcs!=0");
        require(state.balanceA + state.balanceB == ch.amountA + ch.amountB, "!conserved");

        require(_verifyDualSig(ch.userA, ch.userB, state, sigA, sigB), "bad sig");

        address token = ch.token;
        address userA = ch.userA;
        address userB = ch.userB;
        uint64 version = state.version;
        uint256 payA = state.balanceA;
        uint256 payB = state.balanceB;

        ch.status = Status.Closed;

        if (payA > 0) IERC20(token).safeTransfer(userA, payA);
        if (payB > 0) IERC20(token).safeTransfer(userB, payB);

        emit ChannelClosedCooperative(channelId, version);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev `state` MUST abi-encode to `(Adjudicator.ChannelState)`. `sigCounterparty` is
    ///      the *other* party's signature on that state. `htlcsRoot` MUST be empty.
    function closeUnilateral(bytes32 channelId, bytes calldata state, bytes calldata sigCounterparty)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");
        require(msg.sender == ch.userA || msg.sender == ch.userB, "!party");

        Adjudicator.ChannelState memory s = abi.decode(state, (Adjudicator.ChannelState));
        require(s.channelId == channelId, "channelId");
        require(s.htlcsRoot == bytes32(0), "htlcs!=0");
        require(s.balanceA + s.balanceB == ch.amountA + ch.amountB, "!conserved");

        address counterparty = msg.sender == ch.userA ? ch.userB : ch.userA;
        address recovered = _recoverStateSigner(s, sigCounterparty);
        require(recovered == counterparty, "bad sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;
        ch.disputeDeadline = uint64(block.timestamp) + DISPUTE_WINDOW;
        ch.closer = msg.sender;
        ch.status = Status.ClosingUnilateral;

        emit ChannelClosingUnilateral(channelId, s.version, ch.disputeDeadline);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev Replaces the posted state with a strictly-newer version. The dispute deadline is
    ///      NOT extended (this is what bounds watchtower work). The signature MUST be the
    ///      *closer's* signature on the new state — that is what proves the state was
    ///      genuinely co-signed and overrides the closer's stale post. Verifying the
    ///      non-closer's signature would be useless: anyone could forge a self-signed
    ///      state and steal the pot.
    function dispute(bytes32 channelId, bytes calldata state, bytes calldata sigCloser) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ClosingUnilateral, "!closing");

        Adjudicator.ChannelState memory s = abi.decode(state, (Adjudicator.ChannelState));
        require(s.channelId == channelId, "channelId");
        require(s.version > ch.postedVersion, "stale");
        require(s.htlcsRoot == bytes32(0), "htlcs!=0");
        require(s.balanceA + s.balanceB == ch.amountA + ch.amountB, "!conserved");

        require(_recoverStateSigner(s, sigCloser) == ch.closer, "bad sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;

        emit DisputeRaised(channelId, s.version);
    }

    /// @inheritdoc IWatchtower
    /// @dev Watchtower path. `penaltyState` is an `oldState` that the closer signed but did
    ///      NOT publish — proving they unilaterally closed at a stale version on purpose.
    ///      Any caller may submit it. On success, `penalized = true` and the *closer* is
    ///      slashed for 100% of the channel funds at `finalize`.
    function submitPenaltyProof(bytes32 channelId, bytes calldata penaltyState, bytes calldata signature)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ClosingUnilateral, "!closing");

        Adjudicator.ChannelState memory s = abi.decode(penaltyState, (Adjudicator.ChannelState));
        require(s.channelId == channelId, "channelId");
        require(s.version > ch.postedVersion, "stale");
        require(s.htlcsRoot == bytes32(0), "htlcs!=0");
        require(s.balanceA + s.balanceB == ch.amountA + ch.amountB, "!conserved");

        require(_recoverStateSigner(s, signature) == ch.closer, "!closer sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;
        ch.penalized = true;

        address beneficiary = ch.closer == ch.userA ? ch.userB : ch.userA;
        emit PenaltyApplied(channelId, ch.closer, beneficiary);
        emit DisputeRaised(channelId, s.version);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev On `penalized == true`, the entire channel pot goes to the non-closer. Otherwise
    ///      the posted balance split is honoured.
    function finalize(bytes32 channelId) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ClosingUnilateral, "!closing");
        require(block.timestamp >= ch.disputeDeadline, "!ripe");

        address token = ch.token;
        address userA = ch.userA;
        address userB = ch.userB;
        uint256 payA;
        uint256 payB;

        if (ch.penalized) {
            uint256 pot = ch.amountA + ch.amountB;
            if (ch.closer == userA) {
                payB = pot;
            } else {
                payA = pot;
            }
        } else {
            payA = ch.postedBalanceA;
            payB = ch.postedBalanceB;
        }

        ch.status = Status.Closed;

        if (payA > 0) IERC20(token).safeTransfer(userA, payA);
        if (payB > 0) IERC20(token).safeTransfer(userB, payB);

        emit ChannelFinalized(channelId, payA, payB);
    }

    /// @dev Convenience wrapper around `Adjudicator.verifyDualSig` that takes a memory
    ///      `ChannelState` (the version we hold internally after `abi.decode`). The
    ///      Adjudicator's external surface uses `calldata`, so we re-encode through a small
    ///      `this.<external>` ABI hop. This costs ~1 staticcall but keeps the Adjudicator
    ///      interface clean for off-chain consumers.
    function _verifyDualSig(
        address userA,
        address userB,
        Adjudicator.ChannelState memory state,
        bytes calldata sigA,
        bytes calldata sigB
    ) internal view returns (bool) {
        return adjudicator.verifyDualSig(userA, userB, state, sigA, sigB);
    }

    /// @dev See `_verifyDualSig`. Same `memory -> calldata` hop trick for single-signer
    ///      recovery.
    function _recoverStateSigner(Adjudicator.ChannelState memory state, bytes calldata sig)
        internal
        view
        returns (address)
    {
        return adjudicator.recoverStateSigner(state, sig);
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
