/**
 * depositPlan — typed loader for deployments/sepolia-deposit-plan.json.
 *
 * The plan specifies, per demo agent (A/B/C/D), how much of each asset
 * (ETH / USDC) to deposit into HecateVault. Amounts are stored in BOTH
 * human-readable form (decimal string) and integer on-chain form (wei
 * for ETH, micro-USDC for USDC) so the committed plan is unambiguous
 * regardless of who's reading it.
 *
 * scripts/agents-deposit.ts consumes this plan to build + sign + send
 * deposit transactions for each agent.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const EthDeposit = z
  .object({
    asset: z.literal("ETH"),
    amount_human: z.string(),
    amount_wei: z.string().regex(/^[0-9]+$/, "amount_wei must be a positive integer string"),
  })
  .strict();

const UsdcDeposit = z
  .object({
    asset: z.literal("USDC"),
    amount_human: z.string(),
    amount_micro: z.string().regex(/^[0-9]+$/, "amount_micro must be a positive integer string"),
  })
  .strict();

const AgentPlan = z
  .object({
    deposits: z.array(z.union([EthDeposit, UsdcDeposit])),
  })
  .strict();

export const SepoliaDepositPlan = z
  .object({
    chain_id: z.literal(11155111),
    note: z.string(),
    agents: z
      .object({
        A: AgentPlan,
        B: AgentPlan,
        C: AgentPlan,
        D: AgentPlan,
      })
      .strict(),
  })
  .strict();
export type SepoliaDepositPlan = z.infer<typeof SepoliaDepositPlan>;
export type AgentPlan = z.infer<typeof AgentPlan>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PATH = resolve(REPO_ROOT, "deployments", "sepolia-deposit-plan.json");

export async function loadDepositPlan(
  path: string = DEFAULT_PATH
): Promise<SepoliaDepositPlan> {
  const raw = await readFile(path, "utf-8");
  return SepoliaDepositPlan.parse(JSON.parse(raw));
}
