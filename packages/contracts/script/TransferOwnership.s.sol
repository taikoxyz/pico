// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title TransferOwnership
/// @notice Transfers ownership of the Adjudicator and PaymentChannel UUPS proxies from
///         the current deployer EOA to a TimelockController contract. Both calls run in
///         a single broadcast and the script reverts post-conditions if either transfer
///         fails. After a successful run the deployer key has no remaining authority on
///         either proxy and should be archived/destroyed per the runbook.
/// @dev `transferOwnership` is single-step in OZ v4.9.6 OwnableUpgradeable. Verify
///      `NEW_OWNER` carefully — the runbook's testnet dry-run is mandatory.
contract TransferOwnership is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address adj = vm.envAddress("ADJUDICATOR_PROXY");
        address pc = vm.envAddress("PAYMENT_CHANNEL_PROXY");
        address newOwner = vm.envAddress("NEW_OWNER");

        require(adj != address(0), "ADJUDICATOR_PROXY=0");
        require(pc != address(0), "PAYMENT_CHANNEL_PROXY=0");
        require(newOwner != address(0), "NEW_OWNER=0");
        require(newOwner.code.length > 0, "NEW_OWNER not a contract");

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
}
