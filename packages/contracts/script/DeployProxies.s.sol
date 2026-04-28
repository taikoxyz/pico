// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title DeployProxies
/// @notice Remediation script for the partial mainnet deploy where impls succeeded but
///         the ERC1967 proxies OOG'd. Reads the existing impl addresses from env and
///         only deploys the two proxies + the `setTokenAllowed` call.
/// @dev Required env: ADJUDICATOR_IMPL, PAYMENT_CHANNEL_IMPL, USDC_ADDRESS, DEPLOYER_PRIVATE_KEY.
contract DeployProxies is Script {
    function run() external returns (address adjudicatorProxy, address paymentChannelProxy) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address adjImpl = vm.envAddress("ADJUDICATOR_IMPL");
        address pcImpl = vm.envAddress("PAYMENT_CHANNEL_IMPL");
        address usdc = vm.envAddress("USDC_ADDRESS");

        require(adjImpl.code.length > 0, "adj impl: no code");
        require(pcImpl.code.length > 0, "pc impl: no code");

        vm.startBroadcast(deployerKey);

        bytes memory adjInitData = abi.encodeCall(Adjudicator.initialize, (deployer));
        adjudicatorProxy = address(new ERC1967Proxy(adjImpl, adjInitData));

        bytes memory pcInitData = abi.encodeCall(PaymentChannel.initialize, (deployer, adjudicatorProxy));
        paymentChannelProxy = address(new ERC1967Proxy(pcImpl, pcInitData));

        PaymentChannel(paymentChannelProxy).setTokenAllowed(usdc, true);

        vm.stopBroadcast();

        console2.log("Adjudicator proxy   :", adjudicatorProxy);
        console2.log("PaymentChannel proxy:", paymentChannelProxy);
        console2.log("USDC token allowed  :", usdc);
    }
}
