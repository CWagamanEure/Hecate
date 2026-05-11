// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Sepolia-only test ERC-20 with 6 decimals and a public mint.
 * @dev    Anyone can mint to anyone, so we can fund demo agent wallets
 *         freely. Not a production token. The name "MockUSDC" is the
 *         honest label.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC (Hecate demo)", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Public mint. Anyone can mint. Demo use only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
