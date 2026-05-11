/**
 * sepolia — typed loader for the committed Sepolia deployment manifest.
 *
 * deployments/sepolia.json contains addresses + tx hashes for the V5
 * HecateVault + MockUSDC deploy. The file is public information (no
 * private keys, no API keys) and is committed so reviewers and tooling
 * can resolve the on-chain artifacts without running a local script.
 *
 * V6 will use this loader to: build viem clients pointed at the vault
 * address, watch settleBatch events, and verify cross-tool ABI parity
 * against the on-chain contract.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HexAddress } from "@shared/schemas/hex";

const ContractEntry = z
  .object({
    address: HexAddress,
    etherscan: z.string().url(),
    deployed_at_block: z.string().nullable(),
    verified: z.boolean(),
    purpose: z.string(),
  })
  .passthrough();

const DemoAgentEntry = z
  .object({
    address: HexAddress,
    role: z.string(),
    minted_musdc: z.string(),
  })
  .passthrough();

export const SepoliaDeployment = z
  .object({
    chain_id: z.literal(11155111),
    chain_name: z.literal("sepolia"),
    deployed_at: z.string(),
    deployer: HexAddress,
    engine_address: HexAddress,
    note: z.string(),
    contracts: z
      .object({
        HecateSettlementVerifier: ContractEntry,
        MockUSDC: ContractEntry,
        HecateVault: ContractEntry,
      })
      .strict(),
    demo_agents: z
      .object({
        note: z.string(),
        A: DemoAgentEntry,
        B: DemoAgentEntry,
        C: DemoAgentEntry,
        D: DemoAgentEntry,
      })
      .strict(),
  })
  .strict();
export type SepoliaDeployment = z.infer<typeof SepoliaDeployment>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PATH = resolve(REPO_ROOT, "deployments", "sepolia.json");

export async function loadSepoliaDeployment(
  path: string = DEFAULT_PATH
): Promise<SepoliaDeployment> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  return SepoliaDeployment.parse(parsed);
}
