// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm}   from "forge-std/Test.sol";
import {MockUSDC}    from "../MockUSDC.sol";
import {HecateVault} from "../HecateVault.sol";

/**
 * @title HecateVault.t.sol
 * @notice Forge tests covering custody + signed settlement + 20+ failure
 *         cases. All signatures are produced via vm.sign with a fixed
 *         engine private key so tests are reproducible.
 *
 * Engine private key constant: 0x...01 (matches Hecate's published dev
 * key). Derived address: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.
 */
contract HecateVaultTest is Test {
    MockUSDC    usdc;
    HecateVault vault;

    uint256 constant ENGINE_PK = uint256(0x0000000000000000000000000000000000000000000000000000000000000001);
    address constant ENGINE_ADDR = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        usdc  = new MockUSDC();
        vault = new HecateVault(ENGINE_ADDR, address(usdc));

        // Pre-fund test agents.
        vm.deal(alice, 100 ether);
        vm.deal(bob,   100 ether);
        vm.deal(carol, 100 ether);
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob,   1_000_000e6);
        usdc.mint(carol, 1_000_000e6);
    }

    // ---- helper: sign a settlement ----------------------------------------

    function _signSettlement(
        bytes32 batchId,
        address[] memory agents,
        int256[]  memory ethDeltas,
        int256[]  memory usdcDeltas
    ) internal pure returns (bytes memory) {
        bytes32 hash = keccak256(abi.encode(batchId, agents, ethDeltas, usdcDeltas));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENGINE_PK, hash);
        return abi.encodePacked(r, s, v);
    }

    // ---- deposits ---------------------------------------------------------

    function test_depositETH() public {
        vm.prank(alice);
        vault.depositETH{value: 10 ether}();
        assertEq(vault.ethBalances(alice), 10 ether);
        assertEq(address(vault).balance, 10 ether);
    }

    function test_depositETHZeroFails() public {
        vm.prank(alice);
        vm.expectRevert("amount = 0");
        vault.depositETH{value: 0}();
    }

    function test_depositUSDC() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 20_000e6);
        vault.depositUSDC(20_000e6);
        vm.stopPrank();
        assertEq(vault.usdcBalances(alice), 20_000e6);
        assertEq(usdc.balanceOf(address(vault)), 20_000e6);
    }

    function test_depositUSDCZeroFails() public {
        vm.prank(alice);
        vm.expectRevert("amount = 0");
        vault.depositUSDC(0);
    }

    function test_depositUSDCFailsWithoutApproval() public {
        // ERC-20 reverts on insufficient allowance.
        vm.prank(alice);
        vm.expectRevert();
        vault.depositUSDC(20_000e6);
    }

    // ---- withdrawals ------------------------------------------------------

    function test_withdrawETH() public {
        vm.prank(alice);
        vault.depositETH{value: 10 ether}();

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdrawETH(3 ether);
        assertEq(vault.ethBalances(alice), 7 ether);
        assertEq(alice.balance, before + 3 ether);
    }

    function test_withdrawETHInsufficientReverts() public {
        vm.prank(alice);
        vault.depositETH{value: 1 ether}();
        vm.prank(alice);
        vm.expectRevert("insufficient ETH");
        vault.withdrawETH(2 ether);
    }

    function test_withdrawUSDC() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 10_000e6);
        vault.depositUSDC(10_000e6);

        vault.withdrawUSDC(4_000e6);
        vm.stopPrank();
        assertEq(vault.usdcBalances(alice), 6_000e6);
        assertEq(usdc.balanceOf(alice), 1_000_000e6 - 10_000e6 + 4_000e6);
    }

    function test_withdrawZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert("amount = 0");
        vault.withdrawETH(0);

        vm.prank(alice);
        vm.expectRevert("amount = 0");
        vault.withdrawUSDC(0);
    }

    function test_bareETHTransferRejected() public {
        // Sending ETH directly without depositETH() must fail (no receive()/fallback).
        vm.prank(alice);
        (bool ok, ) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "bare ETH transfer should have reverted");
        assertEq(address(vault).balance, 0);
    }

    // ---- settleBatch happy path -------------------------------------------

    function test_settleBatchHonest() public {
        // alice deposits 10 ETH, bob deposits 20_000 USDC.
        vm.prank(alice);
        vault.depositETH{value: 10 ether}();
        vm.startPrank(bob);
        usdc.approve(address(vault), 20_000e6);
        vault.depositUSDC(20_000e6);
        vm.stopPrank();

        // Match: alice sells 4 ETH for 14360 USDC (clearing 3590).
        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice;  ethDeltas[0] = -4 ether;       usdcDeltas[0] =  int256(14_360e6);
        agents[1] = bob;    ethDeltas[1] =  4 ether;       usdcDeltas[1] = -int256(14_360e6);

        bytes32 batchId = keccak256("batch-1");
        bytes memory sig = _signSettlement(batchId, agents, ethDeltas, usdcDeltas);

        vm.expectEmit(true, false, false, true);
        emit HecateVault.Settled(batchId, 2);
        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);

        assertEq(vault.ethBalances(alice),   6 ether);
        assertEq(vault.usdcBalances(alice), 14_360e6);
        assertEq(vault.ethBalances(bob),     4 ether);
        assertEq(vault.usdcBalances(bob),    5_640e6);
        assertTrue(vault.consumedBatchIds(batchId));
    }

    function test_settleBatchRejectsReplay() public {
        vm.prank(alice);
        vault.depositETH{value: 10 ether}();
        vm.startPrank(bob);
        usdc.approve(address(vault), 20_000e6);
        vault.depositUSDC(20_000e6);
        vm.stopPrank();

        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice;  ethDeltas[0] = -1 ether;       usdcDeltas[0] =  int256(3_590e6);
        agents[1] = bob;    ethDeltas[1] =  1 ether;       usdcDeltas[1] = -int256(3_590e6);

        bytes32 batchId = keccak256("batch-replay");
        bytes memory sig = _signSettlement(batchId, agents, ethDeltas, usdcDeltas);

        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);

        vm.expectRevert("batch already settled");
        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);
    }

    function test_settleBatchRejectsBadSignature() public {
        vm.prank(alice);
        vault.depositETH{value: 1 ether}();
        vm.startPrank(bob);
        usdc.approve(address(vault), 3_590e6);
        vault.depositUSDC(3_590e6);
        vm.stopPrank();

        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice; ethDeltas[0] = -1 ether; usdcDeltas[0] = int256(3_590e6);
        agents[1] = bob;   ethDeltas[1] =  1 ether; usdcDeltas[1] = -int256(3_590e6);

        // Sign with a DIFFERENT key.
        bytes32 hash = keccak256(abi.encode(bytes32("x"), agents, ethDeltas, usdcDeltas));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x9999, hash);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.expectRevert("bad signer");
        vault.settleBatch(bytes32("x"), agents, ethDeltas, usdcDeltas, badSig);
    }

    function test_settleBatchRejectsConservationViolationETH() public {
        vm.prank(alice);
        vault.depositETH{value: 10 ether}();

        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice;  ethDeltas[0] = -3 ether; usdcDeltas[0] = 0;
        agents[1] = bob;    ethDeltas[1] =  2 ether; usdcDeltas[1] = 0;   // sum = -1 ether

        bytes32 batchId = keccak256("non-conserving-eth");
        bytes memory sig = _signSettlement(batchId, agents, ethDeltas, usdcDeltas);

        vm.expectRevert("eth conservation violated");
        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);
    }

    function test_settleBatchRejectsConservationViolationUSDC() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 20_000e6);
        vault.depositUSDC(20_000e6);
        vm.stopPrank();

        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice; ethDeltas[0] = 0; usdcDeltas[0] = -int256(5_000e6);
        agents[1] = bob;   ethDeltas[1] = 0; usdcDeltas[1] =  int256(4_999e6);  // sum = -1 USDC

        bytes32 batchId = keccak256("non-conserving-usdc");
        bytes memory sig = _signSettlement(batchId, agents, ethDeltas, usdcDeltas);

        vm.expectRevert("usdc conservation violated");
        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);
    }

    function test_settleBatchRejectsInsolventDelta() public {
        // alice has 1 ETH, batch tries to debit 5 ETH from her.
        vm.prank(alice);
        vault.depositETH{value: 1 ether}();

        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice; ethDeltas[0] = -5 ether; usdcDeltas[0] = 0;
        agents[1] = bob;   ethDeltas[1] =  5 ether; usdcDeltas[1] = 0;

        bytes32 batchId = keccak256("insolvent");
        bytes memory sig = _signSettlement(batchId, agents, ethDeltas, usdcDeltas);

        vm.expectRevert("insolvent eth delta");
        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);
    }

    function test_settleBatchRejectsEmpty() public {
        address[] memory agents     = new address[](0);
        int256[]  memory ethDeltas  = new int256[](0);
        int256[]  memory usdcDeltas = new int256[](0);
        bytes memory sig = _signSettlement(bytes32("empty"), agents, ethDeltas, usdcDeltas);

        vm.expectRevert("empty batch");
        vault.settleBatch(bytes32("empty"), agents, ethDeltas, usdcDeltas, sig);
    }

    function test_settleBatchRejectsLengthMismatchETH() public {
        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](1);   // mismatch
        int256[]  memory usdcDeltas = new int256[](2);

        bytes memory anySig = new bytes(65);
        vm.expectRevert("len mismatch eth");
        vault.settleBatch(bytes32("mismatch-eth"), agents, ethDeltas, usdcDeltas, anySig);
    }

    function test_settleBatchRejectsLengthMismatchUSDC() public {
        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](1);   // mismatch

        bytes memory anySig = new bytes(65);
        vm.expectRevert("len mismatch usdc");
        vault.settleBatch(bytes32("mismatch-usdc"), agents, ethDeltas, usdcDeltas, anySig);
    }

    function test_settleBatchBadLengthSigReverts() public {
        address[] memory agents     = new address[](1);
        int256[]  memory ethDeltas  = new int256[](1);
        int256[]  memory usdcDeltas = new int256[](1);
        agents[0] = alice; ethDeltas[0] = 0; usdcDeltas[0] = 0;

        bytes memory shortSig = hex"01";
        // _recover returns address(0) for bad length → signer != ENGINE → "bad signer".
        vm.expectRevert("bad signer");
        vault.settleBatch(bytes32("bad-sig-len"), agents, ethDeltas, usdcDeltas, shortSig);
    }

    function test_settleBatchHighSReverts() public {
        // Construct a high-s signature (manually) and confirm the contract rejects.
        vm.prank(alice);
        vault.depositETH{value: 1 ether}();
        vm.prank(bob);
        vault.depositETH{value: 1 ether}();

        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = alice; ethDeltas[0] = -1 ether; usdcDeltas[0] = 0;
        agents[1] = bob;   ethDeltas[1] =  1 ether; usdcDeltas[1] = 0;

        bytes32 batchId = keccak256("high-s");
        bytes32 hash = keccak256(abi.encode(batchId, agents, ethDeltas, usdcDeltas));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENGINE_PK, hash);

        // Flip s into the high-s range and adjust v.
        bytes32 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(uint256(N) - uint256(s));
        uint8   highV = v == 27 ? 28 : 27;
        bytes memory malleated = abi.encodePacked(r, highS, highV);

        vm.expectRevert("bad signer");   // _recover returns address(0) for high-s
        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, malleated);
    }

    function test_settleBatchDuplicateAgentAppliesAdditively() public {
        // Same agent appears twice; deltas are applied additively. Contract
        // doesn't enforce uniqueness — that's an engine-side invariant.
        vm.prank(alice);
        vault.depositETH{value: 10 ether}();
        vm.prank(bob);
        vault.depositETH{value: 10 ether}();

        address[] memory agents     = new address[](3);
        int256[]  memory ethDeltas  = new int256[](3);
        int256[]  memory usdcDeltas = new int256[](3);
        agents[0] = alice; ethDeltas[0] = -1 ether; usdcDeltas[0] = 0;
        agents[1] = alice; ethDeltas[1] = -2 ether; usdcDeltas[1] = 0;  // same agent
        agents[2] = bob;   ethDeltas[2] =  3 ether; usdcDeltas[2] = 0;

        bytes32 batchId = keccak256("dup-agent");
        bytes memory sig = _signSettlement(batchId, agents, ethDeltas, usdcDeltas);

        vault.settleBatch(batchId, agents, ethDeltas, usdcDeltas, sig);

        assertEq(vault.ethBalances(alice), 7 ether);   // 10 - 1 - 2
        assertEq(vault.ethBalances(bob),   13 ether);  // 10 + 3
    }

    // ---- constructor guards -----------------------------------------------

    function test_constructorRejectsZeroEngine() public {
        vm.expectRevert("engine = 0");
        new HecateVault(address(0), address(usdc));
    }

    function test_constructorRejectsZeroUsdc() public {
        vm.expectRevert("usdc = 0");
        new HecateVault(ENGINE_ADDR, address(0));
    }
}
