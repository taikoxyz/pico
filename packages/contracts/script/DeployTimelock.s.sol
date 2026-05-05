// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title DeployTimelock
/// @notice Deploys an OpenZeppelin TimelockController to be set as the owner of the
///         Adjudicator and PaymentChannel UUPS proxies. Proposer + executor are both
///         the operator's Safe multisig; admin is renounced (address(0)) so role
///         changes can only happen via a queued timelock operation.
/// @dev Run with `--broadcast --verify` and the env block documented in
///      `docs/runbooks/ownership-transfer.md`. Pair with `TransferOwnership.s.sol`.
contract DeployTimelock is Script {
    uint256 internal constant MIN_MAINNET_DELAY = 48 hours;

    function run() external returns (address timelock) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address safe = vm.envAddress("SAFE_ADDRESS");
        uint256 minDelay = vm.envUint("MIN_DELAY");

        require(safe != address(0), "SAFE_ADDRESS=0");
        require(safe.code.length > 0, "SAFE_ADDRESS not a contract");
        require(minDelay >= MIN_MAINNET_DELAY, "MIN_DELAY below 48h");

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;

        vm.startBroadcast(deployerKey);
        TimelockController tl = new TimelockController(minDelay, proposers, executors, address(0));
        vm.stopBroadcast();

        timelock = address(tl);
        console2.log("TimelockController :", timelock);
        console2.log("  minDelay (sec)   :", minDelay);
        console2.log("  proposer (Safe)  :", safe);
        console2.log("  executor (Safe)  :", safe);
        console2.log("  admin            : address(0) (renounced)");
    }
}
