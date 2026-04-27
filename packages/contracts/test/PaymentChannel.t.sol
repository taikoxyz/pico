// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Adjudicator} from "../src/Adjudicator.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

/// @title PaymentChannel placeholder test
/// @notice Bootstrap-level smoke test: contracts deploy and revert on stub methods.
contract PaymentChannelTest is Test {
    PaymentChannel internal channel;
    Adjudicator internal adjudicator;

    function setUp() public {
        adjudicator = new Adjudicator(block.chainid, address(0));
        channel = new PaymentChannel(address(adjudicator));
    }

    function test_deploys() public view {
        assertEq(channel.adjudicator(), address(adjudicator));
    }

    function test_openChannel_revertsNotImplemented() public {
        vm.expectRevert(bytes("not implemented"));
        channel.openChannel(address(0xBEEF), address(0), 1 ether, 0);
    }
}
