// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface ITimelockController {
    function getMinDelay() external view returns (uint256);
    function PROPOSER_ROLE() external view returns (bytes32);
    function EXECUTOR_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// @title TransferOwnership
/// @notice Transfers ownership of the Adjudicator and PaymentChannel UUPS proxies from
///         the current deployer EOA to a TimelockController contract. Both calls run in
///         a single broadcast and the script reverts post-conditions if either transfer
///         fails. After a successful run the deployer key has no remaining authority on
///         either proxy and should be archived/destroyed per the runbook.
/// @dev `transferOwnership` is single-step in OZ v4.9.6 OwnableUpgradeable. Verify
///      `NEW_OWNER` carefully — the runbook's testnet dry-run is mandatory.
contract TransferOwnership is Script {
    uint256 internal constant MIN_MAINNET_DELAY = 48 hours;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address adj = vm.envAddress("ADJUDICATOR_PROXY");
        address pc = vm.envAddress("PAYMENT_CHANNEL_PROXY");
        address newOwner = vm.envAddress("NEW_OWNER");
        address safe = vm.envOr("SAFE_ADDRESS", address(0));

        require(adj != address(0), "ADJUDICATOR_PROXY=0");
        require(pc != address(0), "PAYMENT_CHANNEL_PROXY=0");
        require(newOwner != address(0), "NEW_OWNER=0");
        require(newOwner.code.length > 0, "NEW_OWNER not a contract");
        _assertTimelock(newOwner, safe);

        address adjOwnerBefore = OwnableUpgradeable(adj).owner();
        address pcOwnerBefore = OwnableUpgradeable(pc).owner();

        console2.log("Adjudicator    owner BEFORE :", adjOwnerBefore);
        console2.log("PaymentChannel owner BEFORE :", pcOwnerBefore);
        console2.log("New owner (Timelock)        :", newOwner);

        vm.startBroadcast(deployerKey);
        OwnableUpgradeable(adj).transferOwnership(newOwner);
        OwnableUpgradeable(pc).transferOwnership(newOwner);
        vm.stopBroadcast();

        require(OwnableUpgradeable(adj).owner() == newOwner, "Adjudicator owner not transferred");
        require(OwnableUpgradeable(pc).owner() == newOwner, "PaymentChannel owner not transferred");

        console2.log("Adjudicator    owner AFTER  :", OwnableUpgradeable(adj).owner());
        console2.log("PaymentChannel owner AFTER  :", OwnableUpgradeable(pc).owner());
    }

    function _assertTimelock(address newOwner, address safe) internal view {
        ITimelockController timelock = ITimelockController(newOwner);

        try timelock.getMinDelay() returns (uint256 minDelay) {
            require(minDelay >= MIN_MAINNET_DELAY, "Timelock delay below 48h");
            console2.log("Timelock minDelay          :", minDelay);
        } catch {
            revert("NEW_OWNER is not a TimelockController");
        }

        if (safe != address(0)) {
            require(safe.code.length > 0, "SAFE_ADDRESS not a contract");
            require(timelock.hasRole(timelock.PROPOSER_ROLE(), safe), "Safe lacks proposer role");
            require(timelock.hasRole(timelock.EXECUTOR_ROLE(), safe), "Safe lacks executor role");
            console2.log("Safe proposer/executor     :", safe);
        }
    }
}
