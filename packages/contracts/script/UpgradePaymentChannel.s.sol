// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title UpgradePaymentChannel
/// @notice Deploys a new `PaymentChannel` implementation and upgrades the existing
///         ERC1967 proxy in place. Used to ship the dispute() signature-verification
///         fix without rotating the proxy address.
/// @dev Required env: PAYMENT_CHANNEL_PROXY (existing proxy), DEPLOYER_PRIVATE_KEY
///      (must be the current proxy owner). Logs the new impl address.
contract UpgradePaymentChannel is Script {
    function run() external returns (address newImpl) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address proxy = vm.envAddress("PAYMENT_CHANNEL_PROXY");
        require(proxy.code.length > 0, "proxy: no code");

        vm.startBroadcast(deployerKey);

        PaymentChannel impl = new PaymentChannel();
        newImpl = address(impl);
        PaymentChannel(proxy).upgradeToAndCall(newImpl, "");

        vm.stopBroadcast();

        console2.log("PaymentChannel new impl:", newImpl);
        console2.log("Upgraded proxy         :", proxy);
    }
}
