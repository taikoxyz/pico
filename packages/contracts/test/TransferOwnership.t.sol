// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title TransferOwnershipTest
/// @notice Verifies the multisig+timelock ownership handoff. Mirrors the operator runbook
///         flow at `docs/runbooks/ownership-transfer.md`. Asserts that after `transferOwnership`:
///         - the deployer EOA can no longer upgrade or set the token allowlist;
///         - direct calls from the Safe also revert (the Safe must go through the timelock);
///         - scheduled timelock operations cannot execute before `MIN_DELAY` elapses;
///         - after the delay, the Safe can execute upgrades and `setTokenAllowed` via the timelock.
/// @dev Uses OZ contracts-upgradeable v4.9.6 (Ownable string reverts) + OZ contracts v5.6.1
///      (TimelockController custom errors). When the upgradeable submodule moves to v5,
///      switch the `Ownable: caller is not the owner` revert to `OwnableUnauthorizedAccount`.
///      Search this file for `AUDIT:` markers when bumping OZ.
contract TransferOwnershipTest is Test {
    uint256 internal constant MIN_DELAY = 1 days;

    address internal deployer;
    address internal safe;
    address internal rando;

    Adjudicator internal adj;
    PaymentChannel internal pc;
    TimelockController internal timelock;

    address internal newAdjImpl;
    address internal newPcImpl;

    function setUp() public {
        deployer = address(this);
        safe = makeAddr("safe");
        rando = makeAddr("rando");

        Adjudicator adjImpl = new Adjudicator();
        bytes memory adjInitData = abi.encodeCall(Adjudicator.initialize, (deployer));
        adj = Adjudicator(address(new ERC1967Proxy(address(adjImpl), adjInitData)));

        PaymentChannel pcImpl = new PaymentChannel();
        bytes memory pcInitData = abi.encodeCall(PaymentChannel.initialize, (deployer, address(adj)));
        pc = PaymentChannel(address(new ERC1967Proxy(address(pcImpl), pcInitData)));

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;
        timelock = new TimelockController(MIN_DELAY, proposers, executors, address(0));

        adj.transferOwnership(address(timelock));
        pc.transferOwnership(address(timelock));

        newAdjImpl = address(new Adjudicator());
        newPcImpl = address(new PaymentChannel());
    }

    function test_ownerTransferred_to_timelock() public view {
        assertEq(adj.owner(), address(timelock));
        assertEq(pc.owner(), address(timelock));
    }

    function test_deployer_cannotUpgradeAdjudicator() public {
        vm.prank(deployer);
        // AUDIT: OZ contracts-upgradeable v4.9.6 string revert. Switch to OwnableUnauthorizedAccount on v5.
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        UUPSUpgradeable(address(adj)).upgradeTo(newAdjImpl);
    }

    function test_deployer_cannotUpgradePaymentChannel() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        UUPSUpgradeable(address(pc)).upgradeTo(newPcImpl);
    }

    function test_deployer_cannotSetTokenAllowed() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        pc.setTokenAllowed(address(0xCAFE), true);
    }

    function test_safe_cannotDirectlyUpgrade() public {
        vm.prank(safe);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        UUPSUpgradeable(address(adj)).upgradeTo(newAdjImpl);
    }

    function test_safe_cannotDirectlySetTokenAllowed() public {
        vm.prank(safe);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        pc.setTokenAllowed(address(0xCAFE), true);
    }

    function test_timelock_canUpgradeAdjudicatorAfterDelay() public {
        bytes memory upgradeCall = abi.encodeCall(UUPSUpgradeable.upgradeTo, (newAdjImpl));
        bytes32 salt = bytes32(uint256(1));

        vm.prank(safe);
        timelock.schedule(address(adj), 0, upgradeCall, bytes32(0), salt, MIN_DELAY);

        bytes32 opId = timelock.hashOperation(address(adj), 0, upgradeCall, bytes32(0), salt);
        bytes32 expectedReadyBitmap = bytes32(uint256(1) << uint8(TimelockController.OperationState.Ready));

        // AUDIT: OZ TimelockController v5.6.1 custom error.
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector, opId, expectedReadyBitmap
            )
        );
        timelock.execute(address(adj), 0, upgradeCall, bytes32(0), salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        timelock.execute(address(adj), 0, upgradeCall, bytes32(0), salt);

        bytes32 implSlot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        assertEq(address(uint160(uint256(vm.load(address(adj), implSlot)))), newAdjImpl);
    }

    function test_timelock_canUpgradePaymentChannelAfterDelay() public {
        bytes memory upgradeCall = abi.encodeCall(UUPSUpgradeable.upgradeTo, (newPcImpl));
        bytes32 salt = bytes32(uint256(2));

        vm.prank(safe);
        timelock.schedule(address(pc), 0, upgradeCall, bytes32(0), salt, MIN_DELAY);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        timelock.execute(address(pc), 0, upgradeCall, bytes32(0), salt);

        bytes32 implSlot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        assertEq(address(uint160(uint256(vm.load(address(pc), implSlot)))), newPcImpl);
    }

    function test_timelock_canSetTokenAllowedAfterDelay() public {
        address fakeToken = address(0xCAFE);
        bytes memory call = abi.encodeCall(PaymentChannel.setTokenAllowed, (fakeToken, true));
        bytes32 salt = bytes32(uint256(3));

        vm.prank(safe);
        timelock.schedule(address(pc), 0, call, bytes32(0), salt, MIN_DELAY);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        timelock.execute(address(pc), 0, call, bytes32(0), salt);

        assertTrue(pc.allowedTokens(fakeToken));
    }

    function test_nonProposer_cannotSchedule() public {
        bytes memory call = abi.encodeCall(PaymentChannel.setTokenAllowed, (address(0xCAFE), true));
        bytes32 proposerRole = timelock.PROPOSER_ROLE();

        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, rando, proposerRole)
        );
        timelock.schedule(address(pc), 0, call, bytes32(0), bytes32(uint256(4)), MIN_DELAY);
    }

    function test_nonExecutor_cannotExecuteAfterDelay() public {
        bytes memory call = abi.encodeCall(PaymentChannel.setTokenAllowed, (address(0xCAFE), true));
        bytes32 salt = bytes32(uint256(5));
        bytes32 executorRole = timelock.EXECUTOR_ROLE();

        vm.prank(safe);
        timelock.schedule(address(pc), 0, call, bytes32(0), salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);

        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, rando, executorRole)
        );
        timelock.execute(address(pc), 0, call, bytes32(0), salt);
    }
}
