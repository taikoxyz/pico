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
///
///      Token allowlist & minimums are seeded from env vars at deploy time:
///        - `USDC_ADDRESS` (required): primary stablecoin.
///        - `MIN_CHANNEL_AMOUNT_USDC` (optional, default `10_000_000` = 10 USDC).
///        - `ENABLE_ETH` (optional, default `false`): allowlist native ETH (`0x0`).
///        - `MIN_CHANNEL_AMOUNT_ETH` (optional, default `0.01 ether`): only honored
///          when `ENABLE_ETH=true`.
///      Additional ERC-20s can be added post-deploy by the owner via `setTokenAllowed`.
contract Deploy is Script {
    function run() external returns (address adjudicatorProxy, address paymentChannelProxy) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address usdc = vm.envAddress("USDC_ADDRESS");
        address newOwner = vm.envAddress("OWNER_ADDRESS");
        require(newOwner != address(0), "OWNER_ADDRESS must be set");
        require(
            newOwner.code.length > 0 || vm.envOr("ALLOW_EOA_OWNER", false),
            "OWNER_ADDRESS has no code; set ALLOW_EOA_OWNER=true only for an emergency EOA owner"
        );

        vm.startBroadcast(deployerKey);

        Adjudicator adjImpl = new Adjudicator();
        adjudicatorProxy =
            address(new ERC1967Proxy(address(adjImpl), abi.encodeCall(Adjudicator.initialize, (deployer))));

        PaymentChannel pcImpl = new PaymentChannel();
        paymentChannelProxy = address(
            new ERC1967Proxy(address(pcImpl), abi.encodeCall(PaymentChannel.initialize, (deployer, adjudicatorProxy)))
        );

        _seedTokens(paymentChannelProxy, usdc);

        Adjudicator(adjudicatorProxy).transferOwnership(newOwner);
        PaymentChannel(paymentChannelProxy).transferOwnership(newOwner);

        vm.stopBroadcast();

        console2.log("Adjudicator impl :", address(adjImpl));
        console2.log("Adjudicator proxy:", adjudicatorProxy);
        console2.log("PaymentChannel impl :", address(pcImpl));
        console2.log("PaymentChannel proxy:", paymentChannelProxy);
        console2.log("Owner of both proxies:", newOwner);
        if (newOwner.code.length == 0) {
            console2.log("WARNING: owner has no code; ALLOW_EOA_OWNER=true was used");
        }
    }

    function _seedTokens(address pcProxy, address usdc) internal {
        PaymentChannel pc = PaymentChannel(pcProxy);
        uint256 minUsdc = vm.envOr("MIN_CHANNEL_AMOUNT_USDC", uint256(10_000_000));
        pc.setTokenAllowed(usdc, true);
        pc.setMinChannelAmount(usdc, minUsdc);
        console2.log("USDC token allowed  :", usdc);
        console2.log("USDC min channel    :", minUsdc);
        if (vm.envOr("ENABLE_ETH", false)) {
            uint256 minEth = vm.envOr("MIN_CHANNEL_AMOUNT_ETH", uint256(0.01 ether));
            pc.setTokenAllowed(address(0), true);
            pc.setMinChannelAmount(address(0), minEth);
            console2.log("ETH allowlisted (0x0); min channel:", minEth);
        }
    }
}
