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
import {HTLC} from "./HTLC.sol";

/// @title PaymentChannel
/// @notice Pairwise payment channel core for the pico 1-hop network.
/// @dev v2 highlights:
///       - Any owner-allowlisted ERC-20, plus native ETH via the `address(0)` sentinel.
///         ETH must be allowlisted explicitly with `setTokenAllowed(address(0), true)`.
///       - For ERC-20 channels, both parties co-fund: `safeTransferFrom` runs against
///         `userA` and `userB`. Both must have approved this contract before
///         `openChannel` is called.
///       - For ETH channels, `msg.sender` co-funds only their own side: `amountB` MUST
///         be zero. `msg.value` MUST equal `amountA`. This matches the LSP topology
///         (counterparty is a hub that adds inbound liquidity later via `topUp`) and
///         avoids ambiguity around who supplies the counterparty's ETH at open time.
///       - 100% slash on penalty (the `closeUnilateral` caller forfeits *all* funds in the
///         channel to the honest counterparty when an `oldState` proof shows they posted a
///         stale state). Penalty short-circuits HTLC resolution entirely — the cheater
///         forfeits in-flight value alongside principal.
///       - On-chain HTLC settlement: states with non-empty `htlcsRoot` are now accepted at
///         unilateral close, dispute, and top-up. The signed `htlcsCount` and
///         `htlcsTotalLocked` fields let the contract enforce
///         `balanceA + balanceB + htlcsTotalLocked == amountA + amountB`. After the
///         dispute window expires with `htlcsCount > 0` the channel enters
///         `Status.ResolvingHtlcs`, during which `claimHtlc` (preimage + Merkle proof)
///         and `refundHtlc` (Merkle proof, post-expiry) operate. `finalize` is gated on
///         all HTLCs having been explicitly resolved (claimed or refunded). Watchtowers
///         typically post both kinds of resolution; clients may self-settle via the SDK.
///       - Fee-on-transfer and rebasing tokens are NOT supported. The owner allowlist
///         is the gate; `safeTransferFrom` does not verify received-amount equals
///         requested-amount, so allowlisting such a token would break balance conservation.
///       - ETH disbursements use `call{value:}` with `require(ok)`. If either channel
///         participant is a contract whose `receive()` reverts (or consumes more than the
///         63/64 gas the EVM forwards), `closeCooperative` and `finalize` will revert and
///         the channel funds are stuck. Counterparties for ETH channels SHOULD be EOAs or
///         contracts with a trivial `receive() external payable {}`. A future revision may
///         move to a pull-pattern (per-address `pendingWithdrawals` + `withdraw()`) so a
///         failing payout leg cannot block the other party's funds.
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
    /// @dev `ResolvingHtlcs` is entered (lazily, at the first `finalize` call after the
    ///      dispute deadline) when the posted state had `htlcsCount > 0`. While in this
    ///      phase, `claimHtlc` and `refundHtlc` are callable and `finalize` is gated on
    ///      `htlcsCount == 0`.
    enum Status {
        None,
        Open,
        ClosingUnilateral,
        ResolvingHtlcs,
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
        bytes32 postedHtlcsRoot;
        uint256 htlcsTotalLocked;
        uint16 htlcsCount;
        uint64 htlcResolutionDeadline;
        uint256 pendingPayoutA;
        uint256 pendingPayoutB;
    }

    /// @notice Resolution state of a single HTLC during `ResolvingHtlcs`.
    enum HtlcResolution {
        Pending,
        Claimed,
        Refunded
    }

    /// @notice Length of the dispute window in seconds. Mirrors
    ///         `DEFAULT_DISPUTE_WINDOW_MS` in `packages/protocol`.
    uint64 public constant DISPUTE_WINDOW = 24 hours;

    /// @notice Maximum HTLC duration on-chain. Mirrors `MAX_HTLC_DURATION_MS` in
    ///         `packages/protocol` (off-chain policy bound). The contract trusts the
    ///         off-chain protocol to cap HTLC `expiry` to `now + this`, exactly as v1
    ///         trusts off-chain to cap the HTLC count.
    uint64 public constant MAX_HTLC_DURATION = 2 hours;

    /// @notice Grace window appended to `MAX_HTLC_DURATION` when computing the per-channel
    ///         HTLC resolution deadline at the start of `ResolvingHtlcs`. Gives watchtowers
    ///         time to post `refundHtlc` calls before `finalize` is callable.
    uint64 public constant HTLC_RESOLUTION_GRACE = 2 hours;

    /// @notice EIP-712 verifier. Set once at `initialize`; can be rotated via UUPS upgrade.
    Adjudicator public adjudicator;

    /// @notice Allowlist of accepted tokens. The `address(0)` entry, when set, allows
    ///         channels denominated in native ETH. Owner-managed via `setTokenAllowed`.
    mapping(address => bool) public allowedTokens;

    /// @notice Open and historical channels by id.
    mapping(bytes32 => Channel) internal _channels;

    /// @notice Monotonically incrementing nonce to keep `channelId` unique even when
    ///         `userA`, `userB`, `token` and `block.timestamp` collide.
    uint256 public openNonce;

    /// @notice Per-channel, per-HTLC resolution status (`Pending`/`Claimed`/`Refunded`).
    mapping(bytes32 => mapping(bytes32 => HtlcResolution)) public htlcResolved;

    /// @notice Per-token lower bound on initial channel funding (`amountA + amountB`),
    ///         denominated in the token's smallest unit. Defaults to 0 (no minimum)
    ///         for tokens the owner has not explicitly configured. Set via
    ///         `setMinChannelAmount`.
    mapping(address => uint256) public minChannelAmount;

    /// @dev Storage gap for upgrade safety. Shrunk from 44 to 42 to accommodate:
    ///      - `htlcResolved` (one slot, new in v2)
    ///      - `minChannelAmount` (one slot, new in v2)
    ///      The seven new fields embedded in `Channel` live in the per-channel mapping
    ///      and don't consume top-level storage.
    uint256[42] private __gap;

    /// @notice Emitted when the owner toggles a token's allowlist entry.
    event TokenAllowed(address indexed token, bool allowed);

    /// @notice Emitted when the owner sets a per-token minimum channel funding.
    event MinChannelAmountSet(address indexed token, uint256 amount);

    /// @notice Emitted when a successful penalty proof slashes the unilateral closer.
    event PenaltyApplied(bytes32 indexed channelId, address indexed cheater, address indexed beneficiary);

    /// @notice Emitted when a unilaterally-closed channel with `htlcsCount > 0` transitions
    ///         from `ClosingUnilateral` to `ResolvingHtlcs` after the dispute window.
    event HtlcResolutionStarted(bytes32 indexed channelId, uint64 htlcResolutionDeadline);

    /// @notice Emitted when an HTLC is claimed on-chain. `preimage` is included so off-chain
    ///         relays can pick up cross-channel preimages from the event stream alone.
    event HtlcClaimed(
        bytes32 indexed channelId, bytes32 indexed htlcId, address indexed receiver, uint256 amount, bytes preimage
    );

    /// @notice Emitted when an HTLC is refunded on-chain (expiry passed without claim).
    event HtlcRefunded(bytes32 indexed channelId, bytes32 indexed htlcId, address indexed sender, uint256 amount);

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

    /// @notice One-shot migration for proxies upgraded from the USDC-only contract that
    ///         predates `minChannelAmount`. Seeds the per-token floor atomically with
    ///         the upgrade tx so there is no window during which a previously-floored
    ///         token can be opened at any amount. MUST be called via
    ///         `upgradeToAndCall(newImpl, abi.encodeCall(reinitializeV2, (usdc, minUsdc)))`.
    /// @dev Guarded by `reinitializer(2)`: callable exactly once on the existing proxy
    ///      and not at all on fresh deployments (which already start with
    ///      `_initialized == 1` and use `setMinChannelAmount` directly). Owner-gated to
    ///      mirror `setMinChannelAmount`.
    function reinitializeV2(address usdc, uint256 minUsdc) external reinitializer(2) onlyOwner {
        require(usdc != address(0), "usdc=0");
        minChannelAmount[usdc] = minUsdc;
        emit MinChannelAmountSet(usdc, minUsdc);
    }

    /// @notice Owner-only: add or remove a token from the channel-token allowlist.
    /// @dev `token == address(0)` enables native-ETH channels. The owner is expected to
    ///      vet ERC-20s for fee-on-transfer / rebasing behaviour before allowlisting.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice Owner-only: set the minimum funding (`amountA + amountB`) that a new
    ///         channel for `token` must satisfy. Pass `0` to remove the floor.
    function setMinChannelAmount(address token, uint256 amount) external onlyOwner {
        minChannelAmount[token] = amount;
        emit MinChannelAmountSet(token, amount);
    }

    /// @notice Read a channel record by id.
    function channels(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    /// @dev Pull `amount` of `token` from `from` into the contract. For native ETH
    ///      (`token == address(0)`) this is a no-op: the funds must already have arrived
    ///      via `msg.value`, which the caller validates against the expected total.
    function _pullFunds(address token, address from, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) return;
        IERC20(token).safeTransferFrom(from, address(this), amount);
    }

    /// @dev Send `amount` of `token` to `to`. For native ETH, uses a low-level `call`
    ///      with no calldata; the caller is responsible for CEI ordering (state writes
    ///      before this disbursement). If `to` is a contract whose `receive()` reverts,
    ///      the call reverts and the enclosing close/finalize tx fails — locking the
    ///      channel until the offending side cooperates with a different `to`. See the
    ///      contract-level NatSpec for the v1 mitigation (vet contract counterparties)
    ///      and the planned pull-pattern follow-up.
    function _payOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "ETH send fail");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @inheritdoc IPaymentChannel
    /// @dev `token` must be on the allowlist. For ERC-20s, both `msg.sender` and `userB`
    ///      must have approved this contract for at least `amountA` and `amountB`
    ///      respectively before calling. For native ETH (`token == address(0)`),
    ///      `amountB` MUST be zero and `msg.value` MUST equal `amountA`; counterparty
    ///      inbound liquidity is added later via `topUp`.
    function openChannel(address userB, address token, uint256 amountA, uint256 amountB)
        external
        payable
        nonReentrant
        returns (bytes32 channelId)
    {
        require(allowedTokens[token], "token !allowed");
        require(userB != address(0), "userB=0");
        require(userB != msg.sender, "self-channel");
        require(amountA + amountB >= minChannelAmount[token], "amount<min");

        if (token == address(0)) {
            require(amountB == 0, "ETH amountB!=0");
            require(msg.value == amountA, "ETH value!=amountA");
        } else {
            require(msg.value == 0, "no ETH");
        }

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
            closer: address(0),
            postedHtlcsRoot: bytes32(0),
            htlcsTotalLocked: 0,
            htlcsCount: 0,
            htlcResolutionDeadline: 0,
            pendingPayoutA: 0,
            pendingPayoutB: 0
        });

        _pullFunds(token, msg.sender, amountA);
        _pullFunds(token, userB, amountB);

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

        _payOut(token, userA, payA);
        _payOut(token, userB, payB);

        emit ChannelClosedCooperative(channelId, payA, payB, cc.signedAt);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev `state` MUST abi-encode to `(Adjudicator.ChannelState)`. `sigCounterparty` is
    ///      the *other* party's signature on that state. States with in-flight HTLCs are
    ///      accepted; conservation is checked against `balanceA + balanceB + htlcsTotalLocked`.
    function closeUnilateral(bytes32 channelId, bytes calldata state, bytes calldata sigCounterparty)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");
        require(msg.sender == ch.userA || msg.sender == ch.userB, "!party");

        Adjudicator.ChannelState memory s = abi.decode(state, (Adjudicator.ChannelState));
        require(s.channelId == channelId, "channelId");
        _requireHtlcsRootConsistent(s);
        require(s.balanceA + s.balanceB + s.htlcsTotalLocked == ch.amountA + ch.amountB, "!conserved");

        address counterparty = msg.sender == ch.userA ? ch.userB : ch.userA;
        address recovered = _recoverStateSigner(s, sigCounterparty);
        require(recovered == counterparty, "bad sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;
        ch.postedHtlcsRoot = s.htlcsRoot;
        ch.htlcsCount = s.htlcsCount;
        ch.htlcsTotalLocked = s.htlcsTotalLocked;
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
    ) external payable nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.Open, "!open");
        require(msg.sender == ch.userA || msg.sender == ch.userB, "!party");
        require(amount > 0, "amount=0");
        if (ch.token == address(0)) {
            require(msg.value == amount, "ETH value!=amount");
        } else {
            require(msg.value == 0, "no ETH");
        }

        // prevState validation
        require(prev.state.channelId == channelId, "prev channelId");
        _requireHtlcsRootConsistent(prev.state);
        require(!prev.state.finalized, "prev finalized");
        require(prev.state.version >= ch.postedVersion, "prev<posted");
        require(
            prev.state.balanceA + prev.state.balanceB + prev.state.htlcsTotalLocked == ch.amountA + ch.amountB,
            "prev !conserved"
        );

        if (prev.state.version == 0) {
            // Sentinel branch: bytewise zero sigs + balances == amounts
            require(prev.sigA.length == 0 && prev.sigB.length == 0, "sentinel sigs");
            require(prev.state.balanceA == ch.amountA && prev.state.balanceB == ch.amountB, "sentinel bal");
        } else {
            require(_verifyDualSig(ch.userA, ch.userB, prev.state, prev.sigA, prev.sigB), "prev bad sig");
        }

        // newState validation. top-up only moves principal, so the HTLC set must be
        // unchanged across prev/next.
        require(next.state.channelId == channelId, "next channelId");
        require(next.state.version == prev.state.version + 1, "next version");
        _requireHtlcsRootConsistent(next.state);
        require(next.state.htlcsRoot == prev.state.htlcsRoot, "next htlcs changed");
        require(next.state.htlcsCount == prev.state.htlcsCount, "next htlc count");
        require(next.state.htlcsTotalLocked == prev.state.htlcsTotalLocked, "next htlc total");
        require(!next.state.finalized, "next finalized");

        if (msg.sender == ch.userA) {
            require(next.state.balanceA == prev.state.balanceA + amount, "A delta");
            require(next.state.balanceB == prev.state.balanceB, "B unchanged");
        } else {
            require(next.state.balanceB == prev.state.balanceB + amount, "B delta");
            require(next.state.balanceA == prev.state.balanceA, "A unchanged");
        }
        require(
            next.state.balanceA + next.state.balanceB + next.state.htlcsTotalLocked == ch.amountA + ch.amountB + amount,
            "next !conserved"
        );
        require(_verifyDualSig(ch.userA, ch.userB, next.state, next.sigA, next.sigB), "next bad sig");

        // Pull funds and update state
        _pullFunds(ch.token, msg.sender, amount);
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
        _requireHtlcsRootConsistent(s);
        require(s.balanceA + s.balanceB + s.htlcsTotalLocked == ch.amountA + ch.amountB, "!conserved");

        require(_verifyDualSig(ch.userA, ch.userB, s, sigA, sigB), "bad sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;
        ch.postedHtlcsRoot = s.htlcsRoot;
        ch.htlcsCount = s.htlcsCount;
        ch.htlcsTotalLocked = s.htlcsTotalLocked;
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
        _requireHtlcsRootConsistent(s);
        require(s.balanceA + s.balanceB + s.htlcsTotalLocked == ch.amountA + ch.amountB, "!conserved");

        require(_verifyDualSig(ch.userA, ch.userB, s, sigA, sigB), "bad sig");

        ch.postedVersion = s.version;
        ch.postedBalanceA = s.balanceA;
        ch.postedBalanceB = s.balanceB;
        ch.postedHtlcsRoot = s.htlcsRoot;
        ch.htlcsCount = s.htlcsCount;
        ch.htlcsTotalLocked = s.htlcsTotalLocked;
        ch.penalized = true;

        address beneficiary = ch.closer == ch.userA ? ch.userB : ch.userA;
        emit PenaltyApplied(channelId, ch.closer, beneficiary);
        emit DisputeRaised(channelId, s.version);
    }

    /// @inheritdoc IPaymentChannel
    /// @dev Phase transitions:
    ///       - `penalized` → 100% to the non-closer, regardless of in-flight HTLCs. The
    ///         cheater forfeits everything; HTLC resolution is short-circuited.
    ///       - `htlcsCount == 0` → fast path: pay `postedBalance{A,B}` + `pendingPayout{A,B}`
    ///         and close. This matches v1 behaviour for empty-root channels.
    ///       - Otherwise → first call after `disputeDeadline` transitions
    ///         `ClosingUnilateral → ResolvingHtlcs` and sets `htlcResolutionDeadline`. A
    ///         subsequent call (after every HTLC is explicitly claimed or refunded) pays out.
    function finalize(bytes32 channelId) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ClosingUnilateral || ch.status == Status.ResolvingHtlcs, "!closing");

        if (ch.status == Status.ClosingUnilateral) {
            require(block.timestamp >= ch.disputeDeadline, "!ripe");

            // Penalty short-circuits HTLC resolution: the cheating closer forfeits
            // everything to the non-closer, including any in-flight HTLC value.
            if (!ch.penalized && ch.htlcsCount > 0) {
                ch.status = Status.ResolvingHtlcs;
                ch.htlcResolutionDeadline = uint64(block.timestamp) + MAX_HTLC_DURATION + HTLC_RESOLUTION_GRACE;
                emit HtlcResolutionStarted(channelId, ch.htlcResolutionDeadline);
                return;
            }
        } else {
            // Status.ResolvingHtlcs: every HTLC must be explicitly resolved.
            require(ch.htlcsCount == 0, "htlcs pending");
        }

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
            payA = ch.postedBalanceA + ch.pendingPayoutA;
            payB = ch.postedBalanceB + ch.pendingPayoutB;
        }

        ch.status = Status.Closed;

        _payOut(token, userA, payA);
        _payOut(token, userB, payB);

        emit ChannelFinalized(channelId, payA, payB);
    }

    /// @notice Claim an in-flight HTLC by revealing its preimage and a Merkle proof of
    ///         membership in the posted state's `htlcsRoot`. Callable while `status` is
    ///         `ResolvingHtlcs` and before the HTLC's individual expiry.
    /// @dev Anyone may call. The credited side is determined by `htlc.direction`:
    ///       - `direction == 0` (AtoB) → receiver is `userB`; credits `pendingPayoutB`.
    ///       - `direction == 1` (BtoA) → receiver is `userA`; credits `pendingPayoutA`.
    function claimHtlc(
        bytes32 channelId,
        Adjudicator.Htlc calldata htlc,
        bytes32[] calldata proof,
        uint256 sortedIndex,
        uint256 totalLeaves,
        bytes calldata preimage
    ) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ResolvingHtlcs, "!resolving");
        require(htlcResolved[channelId][htlc.id] == HtlcResolution.Pending, "resolved");
        require(block.timestamp <= htlc.expiry, "expired");
        require(HTLC.verifyPreimage(htlc.paymentHash, preimage), "preimage");
        _verifyHtlcMembership(htlc, ch.postedHtlcsRoot, proof, sortedIndex, totalLeaves);

        htlcResolved[channelId][htlc.id] = HtlcResolution.Claimed;
        ch.htlcsCount -= 1;
        ch.htlcsTotalLocked -= htlc.amount;

        address receiver = htlc.direction == 0 ? ch.userB : ch.userA;
        if (htlc.direction == 0) {
            ch.pendingPayoutB += htlc.amount;
        } else {
            ch.pendingPayoutA += htlc.amount;
        }

        emit HtlcClaimed(channelId, htlc.id, receiver, htlc.amount, preimage);
    }

    /// @notice Refund an in-flight HTLC after its expiry. Returns the locked principal to
    ///         the sender side. Callable while `status` is `ResolvingHtlcs`; anyone may call.
    /// @dev Sender side per `htlc.direction`:
    ///       - `direction == 0` (AtoB) → sender is `userA`; credits `pendingPayoutA`.
    ///       - `direction == 1` (BtoA) → sender is `userB`; credits `pendingPayoutB`.
    function refundHtlc(
        bytes32 channelId,
        Adjudicator.Htlc calldata htlc,
        bytes32[] calldata proof,
        uint256 sortedIndex,
        uint256 totalLeaves
    ) external nonReentrant {
        Channel storage ch = _channels[channelId];
        require(ch.status == Status.ResolvingHtlcs, "!resolving");
        require(htlcResolved[channelId][htlc.id] == HtlcResolution.Pending, "resolved");
        require(block.timestamp > htlc.expiry, "!expired");
        _verifyHtlcMembership(htlc, ch.postedHtlcsRoot, proof, sortedIndex, totalLeaves);

        htlcResolved[channelId][htlc.id] = HtlcResolution.Refunded;
        ch.htlcsCount -= 1;
        ch.htlcsTotalLocked -= htlc.amount;

        address sender = htlc.direction == 0 ? ch.userA : ch.userB;
        if (htlc.direction == 0) {
            ch.pendingPayoutA += htlc.amount;
        } else {
            ch.pendingPayoutB += htlc.amount;
        }

        emit HtlcRefunded(channelId, htlc.id, sender, htlc.amount);
    }

    /// @dev Hash the Adjudicator.Htlc and verify it against the posted Merkle root.
    ///      Extracted from claimHtlc/refundHtlc to keep their stack within solc 0.8.26's
    ///      16-slot limit (without via-ir).
    function _verifyHtlcMembership(
        Adjudicator.Htlc calldata htlc,
        bytes32 root,
        bytes32[] calldata proof,
        uint256 sortedIndex,
        uint256 totalLeaves
    ) internal pure {
        bytes32 leaf = keccak256(abi.encode(htlc.id, htlc.amount, htlc.paymentHash, htlc.expiry, htlc.direction));
        require(HTLC.verifyOrderedProof(leaf, root, proof, sortedIndex, totalLeaves), "bad proof");
    }

    /// @dev Reject states with a malformed `(htlcsRoot, htlcsCount, htlcsTotalLocked)` triple.
    ///      The three fields must be consistent: empty root iff zero count iff zero total.
    ///      Non-empty triples are otherwise free; the on-chain leaf-hash check happens at
    ///      `claimHtlc` / `refundHtlc` time via the Merkle proof, not here.
    function _requireHtlcsRootConsistent(Adjudicator.ChannelState memory s) internal pure {
        bool empty = s.htlcsRoot == bytes32(0);
        require(empty == (s.htlcsCount == 0), "htlcs root/count");
        require(empty == (s.htlcsTotalLocked == 0), "htlcs root/total");
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
