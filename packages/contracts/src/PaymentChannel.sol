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
///         stale state).
///       - Dispute, unilateral-close, and penalty paths assume `htlcsRoot == bytes32(0)`.
///         Posting a state with in-flight HTLCs reverts. Cooperative close signs a dedicated
///         `CooperativeClose` artifact without an HTLC root, so clients/hubs must only request
///         it after all in-flight HTLCs settle or fail. This is consistent with the 1-hop
///         dogfood scope: HTLCs only live inside a single payment, and any close happens
///         between payments. On-chain HTLC claim/refund is NOT implemented in v1; the frozen
///         spec and threat model have been updated to match.
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

    /// @notice Per-token lower bound on initial channel funding (`amountA + amountB`),
    ///         denominated in the token's smallest unit. Defaults to 0 (no minimum)
    ///         for tokens the owner has not explicitly configured. Set via
    ///         `setMinChannelAmount`.
    mapping(address => uint256) public minChannelAmount;

    /// @dev Storage gap for upgrade safety. Shrunk by one slot to make room for
    ///      `minChannelAmount` (a new mapping appended above).
    uint256[43] private __gap;

    /// @notice Emitted when the owner toggles a token's allowlist entry.
    event TokenAllowed(address indexed token, bool allowed);

    /// @notice Emitted when the owner sets a per-token minimum channel funding.
    event MinChannelAmountSet(address indexed token, uint256 amount);

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
            closer: address(0)
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
        require(next.state.balanceA + next.state.balanceB == ch.amountA + ch.amountB + amount, "next !conserved");
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

        _payOut(token, userA, payA);
        _payOut(token, userB, payB);

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
