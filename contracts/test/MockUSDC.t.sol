// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test}     from "forge-std/Test.sol";
import {MockUSDC} from "../MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_decimals() public view {
        assertEq(usdc.decimals(), 6);
    }

    function test_nameAndSymbol() public view {
        assertEq(usdc.name(),   "Mock USDC (Hecate demo)");
        assertEq(usdc.symbol(), "mUSDC");
    }

    function test_mintIncreasesBalance() public {
        usdc.mint(alice, 1_000e6);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(usdc.totalSupply(),    1_000e6);
    }

    function test_mintIsPublic() public {
        // Any caller can mint to any address — by design for demo fund-up.
        vm.prank(bob);
        usdc.mint(alice, 5_000e6);
        assertEq(usdc.balanceOf(alice), 5_000e6);
    }

    function test_transfer() public {
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.transfer(bob, 400e6);
        assertEq(usdc.balanceOf(alice), 600e6);
        assertEq(usdc.balanceOf(bob),   400e6);
    }

    function test_approveAndTransferFrom() public {
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(bob, 500e6);
        assertEq(usdc.allowance(alice, bob), 500e6);

        vm.prank(bob);
        usdc.transferFrom(alice, bob, 500e6);
        assertEq(usdc.balanceOf(alice), 500e6);
        assertEq(usdc.balanceOf(bob),   500e6);
        assertEq(usdc.allowance(alice, bob), 0);
    }
}
