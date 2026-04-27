// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title Deploy
/// @notice Foundry deployment script for tainnel Adjudicator + PaymentChannel.
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        Adjudicator adjudicator = new Adjudicator(block.chainid, address(0));
        PaymentChannel channel = new PaymentChannel(address(adjudicator));

        console2.log("Adjudicator:", address(adjudicator));
        console2.log("PaymentChannel:", address(channel));

        vm.stopBroadcast();
    }
}
