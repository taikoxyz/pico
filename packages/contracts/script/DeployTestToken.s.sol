// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TestToken} from "../src/TestToken.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title DeployTestToken
/// @notice Deploys a smoke-test ERC-20, allowlists it on the live PaymentChannel
///         proxy, sets a minimum channel amount, and mints supply to both the
///         deployer (owner EOA) and the hub operator. Removable later — see
///         `docs/test-erc20.md`.
contract DeployTestToken is Script {
    function run() external returns (address testToken) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address paymentChannel = vm.envAddress("PAYMENT_CHANNEL_ADDRESS");
        address hubOperator = vm.envAddress("HUB_OPERATOR_ADDRESS");
        address deployer = vm.addr(deployerKey);
        uint256 mintAmount = vm.envOr("MINT_AMOUNT", uint256(1_000_000 ether));
        uint256 minChannel = vm.envOr("MIN_CHANNEL_AMOUNT_TEST", uint256(1 ether));

        vm.startBroadcast(deployerKey);

        TestToken token = new TestToken();
        testToken = address(token);

        PaymentChannel pc = PaymentChannel(paymentChannel);
        pc.setTokenAllowed(testToken, true);
        pc.setMinChannelAmount(testToken, minChannel);

        token.mint(deployer, mintAmount);
        token.mint(hubOperator, mintAmount);

        vm.stopBroadcast();

        console2.log("TestToken (PTST)    :", testToken);
        console2.log("Allowlisted on PC   :", paymentChannel);
        console2.log("Min channel amount  :", minChannel);
        console2.log("Minted to owner     :", deployer, mintAmount);
        console2.log("Minted to hub op    :", hubOperator, mintAmount);
    }
}
