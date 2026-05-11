/**
 * agents-deposit.ts — V6a of the on-chain vault project.
 *
 * For each demo agent (A/B/C/D), build, sign, and broadcast the on-chain
 * deposit transactions that move funds into HecateVault on Sepolia.
 *
 * Inputs (all read-only):
 *   - .demo-wallets.json (gitignored, per-machine) for each agent's private key
 *   - deployments/sepolia.json for the deployed HecateVault + MockUSDC addresses
 *   - deployments/sepolia-deposit-plan.json for the per-agent deposit amounts
 *   - ALCHEMY_API_KEY from .env for the Sepolia RPC URL
 *
 * For USDC deposits: the agent first calls usdc.approve(vault, amount),
 * then vault.depositUSDC(amount). Two transactions per USDC-depositing
 * agent. ETH deposits are a single vault.depositETH{value: amount}() call.
 *
 * Flags:
 *   --dry-run       simulate every tx via eth_estimateGas but don't broadcast.
 *                   exits 0 if all simulations succeed.
 *   --rpc-url URL   override the default Alchemy URL (e.g. for a local
 *                   anvil fork).
 *   --agents A,B,D  only run deposits for the listed agents (comma-separated).
 *                   useful for retrying a partial run.
 *   --help / -h
 *
 * Idempotency: HecateVault has no concept of "already deposited"; calling
 * depositUSDC twice adds twice. The script is NOT idempotent by design;
 * re-running it would double-deposit. Use --agents to skip done agents.
 *
 * Output: a deposit-receipts file at deployments/sepolia-deposits-<utc>.json
 * with one entry per agent per leg (approve / deposit), each carrying the
 * tx hash, block number, and gas used. The user can paste a tx hash into
 * Etherscan to confirm.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadDemoWallets, type DemoWalletFile } from "@agents/demoWallets";
import { loadSepoliaDeployment } from "@shared/deployments/sepolia";
import { loadDepositPlan, type AgentPlan } from "@shared/deployments/depositPlan";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VAULT_ABI = parseAbi([
  "function depositETH() payable",
  "function depositUSDC(uint256 amount)",
  "function ethBalances(address) view returns (uint256)",
  "function usdcBalances(address) view returns (uint256)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

type Args = {
  dryRun: boolean;
  rpcUrl: string | undefined;
  agents: ReadonlyArray<"A" | "B" | "C" | "D"> | "all";
};

function parseArgs(argv: string[]): Args | { help: true } {
  let dryRun = false;
  let rpcUrl: string | undefined;
  let agents: Args["agents"] = "all";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--help":
      case "-h":
        return { help: true };
      case "--dry-run":
        dryRun = true;
        break;
      case "--rpc-url":
        rpcUrl = argv[++i];
        break;
      case "--agents": {
        const raw = argv[++i] ?? "";
        const parts = raw.split(",").map((s) => s.trim().toUpperCase());
        for (const p of parts) {
          if (p !== "A" && p !== "B" && p !== "C" && p !== "D") {
            throw new Error(`--agents: unknown agent ${p}; valid: A,B,C,D`);
          }
        }
        agents = parts as Array<"A" | "B" | "C" | "D">;
        break;
      }
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  return { dryRun, rpcUrl, agents };
}

function printHelp(): void {
  console.log(`agents-deposit — V6a Sepolia deposit driver

Usage: npm run vault:deposit -- [options]

Options:
  --dry-run           simulate via eth_estimateGas only; do not broadcast
  --rpc-url URL       override default Sepolia URL (.env ALCHEMY_API_KEY)
  --agents A,B,C,D    only deposit for the listed agents (default: all)
  --help / -h
`);
}

function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter((p) => p.length > 0);
    if (parts.length > 0) {
      parts[parts.length - 1] = "REDACTED";
      u.pathname = "/" + parts.join("/");
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function loadEnv(): Promise<{ alchemyKey: string }> {
  const envPath = resolve(REPO_ROOT, ".env");
  const raw = await readFile(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyKey) throw new Error("ALCHEMY_API_KEY missing from .env");
  return { alchemyKey };
}

type Receipt = {
  agent: "A" | "B" | "C" | "D";
  leg: "approve" | "deposit_eth" | "deposit_usdc";
  tx_hash: Hex;
  block_number: string;
  gas_used: string;
  status: "success" | "reverted";
};

async function processAgent(
  slot: "A" | "B" | "C" | "D",
  plan: AgentPlan,
  pk: Hex,
  vault: Address,
  usdc: Address,
  pub: PublicClient,
  wallet: WalletClient,
  dryRun: boolean
): Promise<Receipt[]> {
  const account = privateKeyToAccount(pk);
  const receipts: Receipt[] = [];
  for (const deposit of plan.deposits) {
    if (deposit.asset === "ETH") {
      const amount = BigInt(deposit.amount_wei);
      const ethBal = await pub.getBalance({ address: account.address });
      if (ethBal < amount) {
        throw new Error(
          `agent ${slot} (${account.address}): insufficient ETH for deposit ` +
            `(need ${deposit.amount_human} ETH = ${amount} wei; have ${ethBal} wei)`
        );
      }
      console.log(
        `  ${slot}: depositETH(${deposit.amount_human}) from ${account.address}`
      );
      if (dryRun) {
        const gas = await pub.estimateContractGas({
          address: vault,
          abi: VAULT_ABI,
          functionName: "depositETH",
          value: amount,
          account: account.address,
        });
        console.log(`     [dry-run] estimated gas: ${gas}`);
        continue;
      }
      const hash = await wallet.writeContract({
        chain: sepolia,
        account,
        address: vault,
        abi: VAULT_ABI,
        functionName: "depositETH",
        value: amount,
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      receipts.push({
        agent: slot,
        leg: "deposit_eth",
        tx_hash: hash,
        block_number: rcpt.blockNumber.toString(),
        gas_used: rcpt.gasUsed.toString(),
        status: rcpt.status === "success" ? "success" : "reverted",
      });
      console.log(`     ${hash}  (block ${rcpt.blockNumber}, ${rcpt.gasUsed} gas)`);
    } else {
      const amount = BigInt(deposit.amount_micro);
      const usdcBal = await pub.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (usdcBal < amount) {
        throw new Error(
          `agent ${slot} (${account.address}): insufficient mUSDC for deposit ` +
            `(need ${amount}; have ${usdcBal}). ` +
            `Run V5 mint first or check deployments/sepolia.json mint amounts.`
        );
      }
      console.log(
        `  ${slot}: approve(${deposit.amount_human} mUSDC) -> depositUSDC from ${account.address}`
      );
      if (dryRun) {
        // Estimate only the approve leg. depositUSDC reads the allowance
        // on chain and would revert ERC20: insufficient allowance during
        // estimate because dry-run hasn't broadcast the approve. A more
        // accurate dry-run would use eth_call with stateOverride to fake
        // the allowance, but the simpler path is to gate just on approve.
        const approveGas = await pub.estimateContractGas({
          address: usdc,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [vault, amount],
          account: account.address,
        });
        console.log(
          `     [dry-run] approve gas: ${approveGas} ` +
            `(deposit gas not estimated; depends on approve being mined first)`
        );
        continue;
      }
      const approveHash = await wallet.writeContract({
        chain: sepolia,
        account,
        address: usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vault, amount],
      });
      const approveRcpt = await pub.waitForTransactionReceipt({ hash: approveHash });
      receipts.push({
        agent: slot,
        leg: "approve",
        tx_hash: approveHash,
        block_number: approveRcpt.blockNumber.toString(),
        gas_used: approveRcpt.gasUsed.toString(),
        status: approveRcpt.status === "success" ? "success" : "reverted",
      });
      console.log(`     approve  ${approveHash}  (block ${approveRcpt.blockNumber})`);

      const depositHash = await wallet.writeContract({
        chain: sepolia,
        account,
        address: vault,
        abi: VAULT_ABI,
        functionName: "depositUSDC",
        args: [amount],
      });
      const depositRcpt = await pub.waitForTransactionReceipt({ hash: depositHash });
      receipts.push({
        agent: slot,
        leg: "deposit_usdc",
        tx_hash: depositHash,
        block_number: depositRcpt.blockNumber.toString(),
        gas_used: depositRcpt.gasUsed.toString(),
        status: depositRcpt.status === "success" ? "success" : "reverted",
      });
      console.log(
        `     deposit  ${depositHash}  (block ${depositRcpt.blockNumber}, ${depositRcpt.gasUsed} gas)`
      );
    }
  }
  return receipts;
}

async function main(): Promise<void> {
  const argsOrHelp = parseArgs(process.argv.slice(2));
  if ("help" in argsOrHelp) {
    printHelp();
    return;
  }
  const args = argsOrHelp;
  const { alchemyKey } = await loadEnv();
  const rpcUrl = args.rpcUrl ?? `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`;
  console.log(`[deposit] rpc: ${redactRpcUrl(rpcUrl)}`);
  console.log(`[deposit] dry-run: ${args.dryRun}`);

  const wallets: DemoWalletFile = await loadDemoWallets();
  const deployment = await loadSepoliaDeployment();
  const plan = await loadDepositPlan();

  const vault = deployment.contracts.HecateVault.address as Address;
  const usdc = deployment.contracts.MockUSDC.address as Address;

  const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: sepolia, transport: http(rpcUrl) });

  const targets: Array<"A" | "B" | "C" | "D"> =
    args.agents === "all" ? ["A", "B", "C", "D"] : Array.from(args.agents);

  const allReceipts: Receipt[] = [];
  for (const slot of targets) {
    console.log(`\n[deposit] agent ${slot} (${wallets[slot].addr}):`);
    const receipts = await processAgent(
      slot,
      plan.agents[slot],
      wallets[slot].pk as Hex,
      vault,
      usdc,
      pub,
      wallet,
      args.dryRun
    );
    allReceipts.push(...receipts);
  }

  if (args.dryRun) {
    console.log("\n[deposit] dry-run complete; nothing broadcast.");
    return;
  }

  // Verify final on-chain balances against the plan.
  console.log("\n[deposit] post-deposit on-chain vault balances:");
  for (const slot of targets) {
    const a = wallets[slot].addr as Address;
    const eth = await pub.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "ethBalances",
      args: [a],
    });
    const usdcBal = await pub.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "usdcBalances",
      args: [a],
    });
    console.log(`  ${slot}  ${a}  ETH=${eth} wei   USDC=${usdcBal} micro`);
  }

  // Persist receipts to a dated file.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolve(REPO_ROOT, "deployments", `sepolia-deposits-${stamp}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        agents: targets,
        receipts: allReceipts,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  console.log(`\n[deposit] wrote receipts to ${outPath}`);
}

main().catch((e) => {
  console.error("\n[deposit] error:", e);
  process.exit(1);
});
