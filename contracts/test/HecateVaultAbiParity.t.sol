// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/**
 * @title HecateVaultAbiParity
 * @notice Pins solc's abi.encode(batchId, agents, ethDeltas, usdcDeltas)
 *         keccak256 for a fixed vector against a constant value. The
 *         mirror vitest (tests/vaultAbi.parity.test.ts) pins the same
 *         constant against viem's encodeAbiParameters. If solc or viem
 *         ever disagree on encoding, both tests must change in lockstep.
 *
 * Vector chosen to exercise:
 *   - non-zero batchId (keccak256("hecate-vault-parity-v1"))
 *   - two-element address[] with distinct addresses
 *   - signed int256 deltas (one negative, one positive)
 *   - conservation Σ = 0
 */
contract HecateVaultAbiParityTest is Test {
    bytes32 constant FIXED_BATCH_ID =
        keccak256(bytes("hecate-vault-parity-v1"));

    bytes32 constant EXPECTED_HASH =
        0xb44a8893dcb666c4736cb267945b8045697a9514d7ae36d1be298ab692cc9816;

    function test_solcAbiEncodeMatchesPinnedHash() public pure {
        address[] memory agents     = new address[](2);
        int256[]  memory ethDeltas  = new int256[](2);
        int256[]  memory usdcDeltas = new int256[](2);
        agents[0] = 0x1111111111111111111111111111111111111111;
        agents[1] = 0x2222222222222222222222222222222222222222;
        ethDeltas[0]  = -1_000_000_000_000_000_000;
        ethDeltas[1]  =  1_000_000_000_000_000_000;
        usdcDeltas[0] =  3_500_000_000;
        usdcDeltas[1] = -3_500_000_000;

        bytes32 hash = keccak256(abi.encode(
            FIXED_BATCH_ID, agents, ethDeltas, usdcDeltas
        ));
        assertEq(hash, EXPECTED_HASH, "solc abi.encode hash drift");
    }
}
