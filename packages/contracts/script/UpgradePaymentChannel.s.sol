// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title UpgradePaymentChannel
/// @notice Deploys a new `PaymentChannel` implementation and upgrades the existing
///         ERC1967 proxy in place. The upgrade is performed via `upgradeToAndCall`
///         with a `reinitializeV2(usdc, minUsdc)` payload so the per-token USDC floor
///         is seeded atomically — without this, the live proxy would have
///         `minChannelAmount[USDC] == 0` between the upgrade tx and a follow-up owner
///         tx, briefly permitting USDC channels at any amount.
/// @dev Required env: PAYMENT_CHANNEL_PROXY, USDC_ADDRESS, DEPLOYER_PRIVATE_KEY (must
///      be the current proxy owner). Optional env: MIN_CHANNEL_AMOUNT_USDC (default
///      `10_000_000` = 10 USDC, mirroring the old contract constant).
contract UpgradePaymentChannel is Script {
    function run() external returns (address newImpl) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address proxy = vm.envAddress("PAYMENT_CHANNEL_PROXY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 minUsdc = vm.envOr("MIN_CHANNEL_AMOUNT_USDC", uint256(10_000_000));
        require(proxy.code.length > 0, "proxy: no code");

        vm.startBroadcast(deployerKey);

        PaymentChannel impl = new PaymentChannel();
        newImpl = address(impl);
        PaymentChannel(proxy).upgradeToAndCall(newImpl, abi.encodeCall(PaymentChannel.reinitializeV2, (usdc, minUsdc)));

        vm.stopBroadcast();

        console2.log("PaymentChannel new impl:", newImpl);
        console2.log("Upgraded proxy         :", proxy);
        console2.log("Seeded USDC floor      :", minUsdc);
    }
}
