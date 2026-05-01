// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title ChannelHandler
/// @notice A bounded action surface for the invariant fuzzer. Each public function picks a
///         valid set of inputs from the pool of open channels and exercises one transition.
contract ChannelHandler is Test {
    PaymentChannel public channel;
    Adjudicator public adjudicator;
    MockERC20 public token;

    uint256 public alicePk = 0xA11CE;
    uint256 public bobPk = 0xB0B;
    address public alice;
    address public bob;

    bytes32[] public openIds;
    bytes32[] public allIds;
    bytes32 public domainSeparator;

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;

    constructor(PaymentChannel _channel, Adjudicator _adjudicator, MockERC20 _token, bytes32 _domainSeparator) {
        channel = _channel;
        adjudicator = _adjudicator;
        token = _token;
        domainSeparator = _domainSeparator;
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
    }

    /* -------------------------------------------------------------------- */
    /*  open                                                                  */
    /* -------------------------------------------------------------------- */

    function open(uint256 amountA, uint256 amountB) external {
        amountA = bound(amountA, 0, 1_000_000_000);
        amountB = bound(amountB, 0, 1_000_000_000);
        if (amountA + amountB < channel.MIN_CHANNEL_AMOUNT()) return;
        if (amountA + amountB > 10_000_000_000_000) return;

        token.mint(alice, amountA);
        token.mint(bob, amountB);
        vm.prank(alice);
        token.approve(address(channel), amountA);
        vm.prank(bob);
        token.approve(address(channel), amountB);

        vm.prank(alice);
        bytes32 id = channel.openChannel(bob, address(token), amountA, amountB);
        openIds.push(id);
        allIds.push(id);
        totalDeposited += amountA + amountB;
    }

    /* -------------------------------------------------------------------- */
    /*  closeCooperative                                                      */
    /* -------------------------------------------------------------------- */

    function closeCooperative(uint256 idxSeed, uint256 splitSeed) external {
        if (openIds.length == 0) return;
        uint256 idx = idxSeed % openIds.length;
        bytes32 id = openIds[idx];
        PaymentChannel.Channel memory ch = channel.channels(id);
        if (ch.status != PaymentChannel.Status.Open) {
            _removeOpenAt(idx);
            return;
        }
        uint256 total = ch.amountA + ch.amountB;
        uint256 finalA = total == 0 ? 0 : (splitSeed % (total + 1));
        uint256 finalB = total - finalA;

        Adjudicator.CooperativeClose memory cc = Adjudicator.CooperativeClose({
            channelId: id,
            finalBalanceA: finalA,
            finalBalanceB: finalB,
            signedAt: uint64(block.timestamp)
        });
        bytes memory sigA = _signCoopClose(alicePk, cc);
        bytes memory sigB = _signCoopClose(bobPk, cc);
        channel.closeCooperative(id, abi.encode(cc), sigA, sigB);

        totalWithdrawn += total;
        _removeOpenAt(idx);
    }

    /* -------------------------------------------------------------------- */
    /*  closeUnilateral                                                       */
    /* -------------------------------------------------------------------- */

    function closeUnilateral(uint256 idxSeed, uint256 versionSeed, uint256 splitSeed) external {
        if (openIds.length == 0) return;
        uint256 idx = idxSeed % openIds.length;
        bytes32 id = openIds[idx];
        PaymentChannel.Channel memory ch = channel.channels(id);
        if (ch.status != PaymentChannel.Status.Open) {
            _removeOpenAt(idx);
            return;
        }
        uint64 version = uint64(bound(versionSeed, 1, type(uint32).max));
        uint256 total = ch.amountA + ch.amountB;
        uint256 finalA = total == 0 ? 0 : (splitSeed % (total + 1));
        uint256 finalB = total - finalA;

        Adjudicator.ChannelState memory s = Adjudicator.ChannelState({
            channelId: id,
            version: version,
            balanceA: finalA,
            balanceB: finalB,
            htlcsRoot: bytes32(0),
            finalized: false
        });
        bytes memory sigB = _sign(bobPk, s);
        vm.prank(alice);
        channel.closeUnilateral(id, abi.encode(s), sigB);
    }

    /* -------------------------------------------------------------------- */
    /*  dispute                                                               */
    /* -------------------------------------------------------------------- */

    function dispute(uint256 idxSeed, uint256 versionDelta, uint256 splitSeed) external {
        if (openIds.length == 0) return;
        uint256 idx = idxSeed % openIds.length;
        bytes32 id = openIds[idx];
        PaymentChannel.Channel memory ch = channel.channels(id);
        if (ch.status != PaymentChannel.Status.ClosingUnilateral) return;
        if (block.timestamp >= ch.disputeDeadline) return;
        uint64 vNew = ch.postedVersion + uint64(bound(versionDelta, 1, 1000));

        uint256 total = ch.amountA + ch.amountB;
        uint256 finalA = total == 0 ? 0 : (splitSeed % (total + 1));
        uint256 finalB = total - finalA;

        Adjudicator.ChannelState memory s = Adjudicator.ChannelState({
            channelId: id,
            version: vNew,
            balanceA: finalA,
            balanceB: finalB,
            htlcsRoot: bytes32(0),
            finalized: false
        });
        // Both parties must sign the disputed state.
        bytes memory sigA = _sign(alicePk, s);
        bytes memory sigB = _sign(bobPk, s);
        channel.dispute(id, abi.encode(s), sigA, sigB);
    }

    /* -------------------------------------------------------------------- */
    /*  finalize                                                              */
    /* -------------------------------------------------------------------- */

    function finalize(uint256 idxSeed) external {
        if (openIds.length == 0) return;
        uint256 idx = idxSeed % openIds.length;
        bytes32 id = openIds[idx];
        PaymentChannel.Channel memory ch = channel.channels(id);
        if (ch.status != PaymentChannel.Status.ClosingUnilateral) return;
        if (block.timestamp < ch.disputeDeadline) {
            vm.warp(ch.disputeDeadline);
        }
        uint256 total = ch.amountA + ch.amountB;
        channel.finalize(id);
        totalWithdrawn += total;
        _removeOpenAt(idx);
    }

    /* -------------------------------------------------------------------- */
    /*  Helpers                                                               */
    /* -------------------------------------------------------------------- */

    function openIdsLength() external view returns (uint256) {
        return openIds.length;
    }

    function _removeOpenAt(uint256 idx) internal {
        uint256 last = openIds.length - 1;
        if (idx != last) openIds[idx] = openIds[last];
        openIds.pop();
    }

    function _sign(uint256 pk, Adjudicator.ChannelState memory s) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)"
                ),
                s.channelId,
                s.version,
                s.balanceA,
                s.balanceB,
                s.htlcsRoot,
                s.finalized
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 sSig) = vm.sign(pk, digest);
        return abi.encodePacked(r, sSig, v);
    }

    function _signCoopClose(uint256 pk, Adjudicator.CooperativeClose memory cc) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "CooperativeClose(bytes32 channelId,uint256 finalBalanceA,uint256 finalBalanceB,uint64 signedAt)"
                ),
                cc.channelId,
                cc.finalBalanceA,
                cc.finalBalanceB,
                cc.signedAt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 sSig) = vm.sign(pk, digest);
        return abi.encodePacked(r, sSig, v);
    }
}

/// @title PaymentChannelInvariantTest
/// @notice Property: total token balance held by the contract equals
///         `totalDeposited - totalWithdrawn` across any sequence of valid actions.
contract PaymentChannelInvariantTest is StdInvariant, Test {
    address internal owner = makeAddr("owner");

    Adjudicator internal adjudicator;
    PaymentChannel internal channel;
    MockERC20 internal token;
    ChannelHandler internal handler;

    function setUp() public {
        Adjudicator adjImpl = new Adjudicator();
        bytes memory adjInit = abi.encodeCall(Adjudicator.initialize, (owner));
        adjudicator = Adjudicator(address(new ERC1967Proxy(address(adjImpl), adjInit)));

        PaymentChannel pcImpl = new PaymentChannel();
        bytes memory pcInit = abi.encodeCall(PaymentChannel.initialize, (owner, address(adjudicator)));
        channel = PaymentChannel(address(new ERC1967Proxy(address(pcImpl), pcInit)));

        token = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        channel.setTokenAllowed(address(token), true);

        bytes32 ds;
        {
            (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
                adjudicator.eip712Domain();
            ds = keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    chainId,
                    verifyingContract
                )
            );
        }

        handler = new ChannelHandler(channel, adjudicator, token, ds);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ChannelHandler.open.selector;
        selectors[1] = ChannelHandler.closeCooperative.selector;
        selectors[2] = ChannelHandler.closeUnilateral.selector;
        selectors[3] = ChannelHandler.dispute.selector;
        selectors[4] = ChannelHandler.finalize.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Conservation of value: the contract's token balance equals net deposits.
    function invariant_totalBalanceEqualsNetDeposits() public view {
        uint256 contractBal = token.balanceOf(address(channel));
        uint256 expected = handler.totalDeposited() - handler.totalWithdrawn();
        assertEq(contractBal, expected, "channel balance == deposited - withdrawn");
    }

    /// @notice Diagnostic: emit handler counters at the end of each fuzz run to make it
    ///         obvious in CI logs whether the fuzzer is actually opening channels (vs.
    ///         every action returning early, which would make the conservation invariant
    ///         vacuous).
    function invariant_diag_logProgress() public view {
        // logging only — use `forge test --match-test invariant_diag -vv` to inspect
        console.log("totalDeposited:", handler.totalDeposited());
        console.log("totalWithdrawn:", handler.totalWithdrawn());
        console.log("openIds.length:", handler.openIdsLength());
    }

    /// @notice Per-channel invariant: an Open channel's stored amounts equal its on-contract holdings
    ///         contribution; we check the global sum here.
    function invariant_sumOfOpenChannelAmounts_LE_balance() public view {
        uint256 sum = 0;
        uint256 n = handler.openIdsLength();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.openIds(i);
            PaymentChannel.Channel memory ch = channel.channels(id);
            if (ch.status == PaymentChannel.Status.Open || ch.status == PaymentChannel.Status.ClosingUnilateral) {
                sum += ch.amountA + ch.amountB;
            }
        }
        assertLe(sum, token.balanceOf(address(channel)));
    }
}
