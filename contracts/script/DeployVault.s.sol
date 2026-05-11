// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC}     from "../MockUSDC.sol";
import {HecateVault}  from "../HecateVault.sol";

/**
 * @title DeployVault
 * @notice Deploys MockUSDC + HecateVault and prints both addresses.
 *
 * Usage (anvil):
 *   anvil &
 *   cd contracts
 *   forge script script/DeployVault.s.sol \
 *     --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *
 * Usage (Sepolia):
 *   cd contracts
 *   forge script script/DeployVault.s.sol \
 *     --rpc-url sepolia-alchemy --broadcast --verify \
 *     --etherscan-api-key $ETHERSCAN_API_KEY \
 *     --private-key $DEPLOYER_PRIVATE_KEY
 */
contract DeployVaultScript is Script {
    /// @dev Engine address — derived from LOCAL_DEV_KEY = 0x0...01. This is
    ///      the same engine_address that /attestation reports and that the
    ///      HecateSettlementVerifier contract checks.
    address constant ENGINE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;

    function run() external returns (MockUSDC usdc, HecateVault vault) {
        vm.startBroadcast();
        usdc  = new MockUSDC();
        vault = new HecateVault(ENGINE, address(usdc));
        vm.stopBroadcast();

        console.log("MockUSDC     deployed at:", address(usdc));
        console.log("HecateVault  deployed at:", address(vault));
        console.log("Engine (immutable):       ", vault.ENGINE());
    }
}
