// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title Deploy
/// @notice Foundry deployment script for pico `Adjudicator` + `PaymentChannel`.
/// @dev Both contracts are deployed behind ERC-1967 proxies (UUPS pattern). Logs the
///      *proxy* addresses — those are the user-facing contract entry points.
///      No actual broadcasting happens unless `--broadcast` is passed at the CLI.
contract Deploy is Script {
    function run() external returns (address adjudicatorProxy, address paymentChannelProxy) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address usdc = vm.envAddress("USDC_ADDRESS");
        address newOwner = vm.envAddress("OWNER_ADDRESS");

        vm.startBroadcast(deployerKey);

        Adjudicator adjImpl = new Adjudicator();
        bytes memory adjInitData = abi.encodeCall(Adjudicator.initialize, (deployer));
        adjudicatorProxy = address(new ERC1967Proxy(address(adjImpl), adjInitData));

        PaymentChannel pcImpl = new PaymentChannel();
        bytes memory pcInitData = abi.encodeCall(PaymentChannel.initialize, (deployer, adjudicatorProxy));
        paymentChannelProxy = address(new ERC1967Proxy(address(pcImpl), pcInitData));

        PaymentChannel(paymentChannelProxy).setTokenAllowed(usdc, true);

        Adjudicator(adjudicatorProxy).transferOwnership(newOwner);
        PaymentChannel(paymentChannelProxy).transferOwnership(newOwner);

        vm.stopBroadcast();

        console2.log("Adjudicator impl :", address(adjImpl));
        console2.log("Adjudicator proxy:", adjudicatorProxy);
        console2.log("PaymentChannel impl :", address(pcImpl));
        console2.log("PaymentChannel proxy:", paymentChannelProxy);
        console2.log("USDC token allowed  :", usdc);
        console2.log("Owner of both proxies:", newOwner);
    }
}
