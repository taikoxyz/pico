// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Open-mint ERC-20 used for live smoke testing of pico v2 on Taiko
///         mainnet. NOT a production token. The PaymentChannel allowlist entry
///         for this contract is intended to be removed after smoke testing
///         concludes — see `docs/test-erc20.md` for the removal procedure.
contract TestToken is ERC20 {
    constructor() ERC20("PicoTest", "PTST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
