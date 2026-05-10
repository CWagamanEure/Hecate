// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HecateSettlementVerifier} from "../HecateSettlementVerifier.sol";

/**
 * @title Deploy
 * @notice Deploys HecateSettlementVerifier. Used for Sepolia (production demo)
 *         and anvil (local end-to-end test).
 *
 * Usage (local anvil):
 *   anvil &
 *   cd contracts
 *   forge script script/Deploy.s.sol --rpc-url http://localhost:8545 \
 *     --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *
 * Usage (Sepolia):
 *   cd contracts
 *   forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL \
 *     --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY \
 *     --private-key $DEPLOYER_PRIVATE_KEY
 *
 * The deployed address is printed to stdout. Record it; the on-chain
 * verifier script reads it from $VERIFIER_ADDRESS.
 */
contract DeployScript is Script {
    function run() external returns (HecateSettlementVerifier verifier) {
        vm.startBroadcast();
        verifier = new HecateSettlementVerifier();
        vm.stopBroadcast();
        console.log("HecateSettlementVerifier deployed at:", address(verifier));
    }
}
