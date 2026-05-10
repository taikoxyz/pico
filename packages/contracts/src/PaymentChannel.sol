// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPaymentChannel} from "./interfaces/IPaymentChannel.sol";
import {IWatchtower} from "./interfaces/IWatchtower.sol";
import {Adjudicator} from "./Adjudicator.sol";

/// @title PaymentChannel
/// @notice Pairwise payment channel core for the pico 1-hop network.
/// @dev v1 simplifications (locked decisions):
///       - USDC-only. ETH (`token == address(0)`) is rejected at `openChannel`.
///       - Both parties co-fund: `safeTransferFrom` runs against `userA` and `userB`. Both
///         must have approved this contract before `openChannel` is called.
///       - 100% slash on penalty (the `closeUnilateral` caller forfeits *all* funds in the
///         channel to the honest counterparty when an `oldState` proof shows they posted a
///         stale state).
///       - Dispute, unilateral-close, and penalty paths assume `htlcsRoot == bytes32(0)`.
///         Posting a state with in-flight HTLCs reverts. Cooperative close signs a dedicated
///         `CooperativeClose` artifact without an HTLC root, so clients/hubs must only request
///         it after all in-flight HTLCs settle or fail. This is consistent with the 1-hop
///         dogfood scope: HTLCs only live inside a single payment, and any close happens
///         between payments. On-chain HTLC claim/refund is NOT implemented in v1; the frozen
///         spec and threat model have been updated to match.
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
        require(initialOwner != address(0), "owner=0");
        // Skip `__Ownable_init()` because in OZ v4.9.6 it would set the owner to the temp
        // proxy deployer and emit a spurious `OwnershipTransferred(0, deployer)`. Calling
        // `_transferOwnership(initialOwner)` directly produces a single canonical
        // `OwnershipTransferred(0, initialOwner)`. Safe inside `initializer`.
        _transferOwnership(initialOwner);
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
        channelId = keccak256(abi.encode(address(this), msg.sender, userB, token, block.timestamp, nonce));
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
    /// @dev `closeData` MUST abi-encode to `(Adjudicator.CooperativeClose)`. Both parties
    ///      sign a dedicated `CooperativeClose` typed-data message (EIP-712), distinct from
    ///      `ChannelState`, so operators can co-sign a one-shot close without committing to
    ///      a specific HTLC root or version. Balance conservation is checked against the
    ///      channel's on-chain funded amounts.
    function closeCooperative(bytes32 channelId, bytes calldata closeData, bytes calldata sigA, bytes calldata sigB)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");

        Adjudicator.CooperativeClose memory cc = abi.decode(closeData, (Adjudicator.CooperativeClose));
        require(cc.channelId == channelId, "channelId");
        require(cc.version > ch.postedVersion, "stale version");
        require(block.timestamp <= cc.validUntil, "expired");
        require(cc.finalBalanceA + cc.finalBalanceB == ch.amountA + ch.amountB, "!conserved");

        require(_verifyDualCooperativeClose(ch.userA, ch.userB, cc, sigA, sigB), "bad sig");

        address token = ch.token;
        address userA = ch.userA;
        address userB = ch.userB;
        uint256 payA = cc.finalBalanceA;
        uint256 payB = cc.finalBalanceB;

        ch.postedVersion = cc.version;
        ch.status = Status.Closed;

        if (payA > 0) IERC20(token).safeTransfer(userA, payA);
        if (payB > 0) IERC20(token).safeTransfer(userB, payB);

        emit ChannelClosedCooperative(channelId, payA, payB, cc.signedAt);
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
    /// @dev Anti-hostage path. After a fresh open with no co-signed state yet, either party
    ///      may unilaterally start the dispute window using the implicit version-0 state
    ///      (which mirrors the on-chain `(amountA, amountB)`). The counterparty can still
    ///      challenge during the window with any strictly-newer dual-signed state.
    ///      Required when a malicious counterparty refuses to co-sign anything after open;
    ///      without this entry point the depositor's funds would be stranded indefinitely.
    function closeUnilateralFromOpen(bytes32 channelId) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");
        require(ch.postedVersion == 0, "posted!=0");
        require(msg.sender == ch.userA || msg.sender == ch.userB, "!party");

        ch.postedVersion = 0; // explicit; already zero
        ch.postedBalanceA = ch.amountA;
        ch.postedBalanceB = ch.amountB;
        ch.disputeDeadline = uint64(block.timestamp) + DISPUTE_WINDOW;
        ch.closer = msg.sender;
        ch.status = Status.ClosingUnilateral;

        emit ChannelClosingUnilateral(channelId, 0, ch.disputeDeadline);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev `topUp` (§8) lets either party additively deposit into their own side of an
    ///      `Open` channel. Both `prevState` and `newState` are dual-signed `ChannelState`
    ///      tuples; the contract anchors against `prevState` (rather than the on-chain
    ///      `postedVersion`) so off-chain payment history is preserved. The depositor's
    ///      side increases by exactly `amount`; the counterparty's balance is unchanged.
    ///      A special "sentinel" form for the very first top-up on a freshly-opened
    ///      channel is accepted: `prevState.version == 0`, sigA/sigB empty, balances
    ///      equal to the on-chain `amountA`/`amountB`.
    function topUp(
        bytes32 channelId,
        uint256 amount,
        Adjudicator.SignedChannelState calldata prev,
        Adjudicator.SignedChannelState calldata next
    ) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");
        require(msg.sender == ch.userA || msg.sender == ch.userB, "!party");
        require(amount > 0, "amount=0");

        // prevState validation
        require(prev.state.channelId == channelId, "prev channelId");
        require(prev.state.htlcsRoot == bytes32(0), "prev htlcs!=0");
        require(!prev.state.finalized, "prev finalized");
        require(prev.state.version >= ch.postedVersion, "prev<posted");
        require(prev.state.balanceA + prev.state.balanceB == ch.amountA + ch.amountB, "prev !conserved");

        if (prev.state.version == 0) {
            // Sentinel branch: bytewise zero sigs + balances == amounts
            require(prev.sigA.length == 0 && prev.sigB.length == 0, "sentinel sigs");
            require(prev.state.balanceA == ch.amountA && prev.state.balanceB == ch.amountB, "sentinel bal");
        } else {
            require(_verifyDualSig(ch.userA, ch.userB, prev.state, prev.sigA, prev.sigB), "prev bad sig");
        }

        // newState validation
        require(next.state.channelId == channelId, "next channelId");
        require(next.state.version == prev.state.version + 1, "next version");
        require(next.state.htlcsRoot == bytes32(0), "next htlcs!=0");
        require(!next.state.finalized, "next finalized");

        if (msg.sender == ch.userA) {
            require(next.state.balanceA == prev.state.balanceA + amount, "A delta");
            require(next.state.balanceB == prev.state.balanceB, "B unchanged");
        } else {
            require(next.state.balanceB == prev.state.balanceB + amount, "B delta");
            require(next.state.balanceA == prev.state.balanceA, "A unchanged");
        }
        require(
            next.state.balanceA + next.state.balanceB == ch.amountA + ch.amountB + amount, "next !conserved"
        );
        require(_verifyDualSig(ch.userA, ch.userB, next.state, next.sigA, next.sigB), "next bad sig");

        // Pull funds and update state
        IERC20(ch.token).safeTransferFrom(msg.sender, address(this), amount);
        if (msg.sender == ch.userA) {
            ch.amountA += amount;
        } else {
            ch.amountB += amount;
        }
        ch.postedVersion = next.state.version;
        ch.postedBalanceA = next.state.balanceA;
        ch.postedBalanceB = next.state.balanceB;

        emit ToppedUp(channelId, msg.sender, amount, next.state.version);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev Replaces the posted state with a strictly-newer dual-signed version. Both
    ///      parties MUST have signed the disputed state, proving mutual agreement on the
    ///      newer balances. A single-party signature would let either party forge a
    ///      self-serving state and steal funds. Only callable while the dispute window
    ///      is still open.
    /// @dev Any successful dispute is implicit proof that the closer posted a stale state
    ///      (a strictly-newer dual-signed state existed at close time), so `penalized` is
    ///      set to true here as well — otherwise the closer could front-run a watchtower's
    ///      `submitPenaltyProof` by self-calling `dispute` (or paying any third party to
    ///      do so) with the latest dual-signed state, bumping `postedVersion` past the
    ///      proof's required threshold and escaping the 100% slash. `submitPenaltyProof`
    ///      remains as the `IWatchtower`-facing alias.
    /// @dev The dispute deadline is extended by a full window only on the FIRST successful
    ///      dispute. Once `penalized` is true the slash outcome is locked in (100% to the
    ///      non-closer regardless of further posted balances), so subsequent disputes only
    ///      bump `postedVersion` without restarting the deadline. This prevents the slashed
    ///      closer from griefing the honest party by repeatedly disputing with progressively
    ///      newer dual-signed states to push `finalize` eligibility further out.
    function dispute(bytes32 channelId, bytes calldata state, bytes calldata sigA, bytes calldata sigB)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ClosingUnilateral, "!closing");
        require(block.timestamp < ch.disputeDeadline, "deadline");

        Adjudicator.ChannelState memory s = abi.decode(state, (Adjudicator.ChannelState));
        require(s.channelId == channelId, "channelId");
        require(s.version > ch.postedVersion, "stale");
        require(s.htlcsRoot == bytes32(0), "htlcs!=0");
        require(s.balanceA + s.balanceB == ch.amountA + ch.amountB, "!conserved");

        require(_verifyDualSig(ch.userA, ch.userB, s, sigA, sigB), "bad sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;
        if (!ch.penalized) {
            ch.disputeDeadline = uint64(block.timestamp) + DISPUTE_WINDOW;
            ch.penalized = true;
        }

        address beneficiary = ch.closer == ch.userA ? ch.userB : ch.userA;
        emit PenaltyApplied(channelId, ch.closer, beneficiary);
        emit DisputeRaised(channelId, s.version);
    }

    /// @inheritdoc IWatchtower
    /// @dev Watchtower path. `penaltyState` is a strictly-newer `ChannelState` that BOTH
    ///      parties signed, proving the closer knowingly posted a stale version on-chain.
    ///      The dual-signature requirement prevents a party from forging a self-signed
    ///      "proof" against a counterparty. Any caller may submit. On success,
    ///      `penalized = true` and the *closer* is slashed for 100% of the channel funds
    ///      at `finalize`. Only callable while the dispute window is still open.
    function submitPenaltyProof(
        bytes32 channelId,
        bytes calldata penaltyState,
        bytes calldata sigA,
        bytes calldata sigB
    ) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ClosingUnilateral, "!closing");
        require(block.timestamp < ch.disputeDeadline, "deadline");

        Adjudicator.ChannelState memory s = abi.decode(penaltyState, (Adjudicator.ChannelState));
        require(s.channelId == channelId, "channelId");
        require(s.version > ch.postedVersion, "stale");
        require(s.htlcsRoot == bytes32(0), "htlcs!=0");
        require(s.balanceA + s.balanceB == ch.amountA + ch.amountB, "!conserved");

        require(_verifyDualSig(ch.userA, ch.userB, s, sigA, sigB), "bad sig");

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
    ///      recovery (used by `closeUnilateral` to verify the counterparty's signature).
    function _recoverStateSigner(Adjudicator.ChannelState memory state, bytes calldata sig)
        internal
        view
        returns (address)
    {
        return adjudicator.recoverStateSigner(state, sig);
    }

    /// @dev Same memory→calldata pattern for `CooperativeClose` dual-signature verification.
    function _verifyDualCooperativeClose(
        address userA,
        address userB,
        Adjudicator.CooperativeClose memory cc,
        bytes calldata sigA,
        bytes calldata sigB
    ) internal view returns (bool) {
        return adjudicator.verifyDualCooperativeClose(userA, userB, cc, sigA, sigB);
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
