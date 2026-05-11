/**
 * onchain-settle.ts — V6c of the on-chain vault project.
 *
 * Takes a Hecate batch bundle (a `VerifyFullBatchRequest` JSON, the
 * shape produced by `npm run simulate -- --save-bundle ...` since V2
 * stage 1) and submits its on-chain vault settlement to the deployed
 * HecateVault on Sepolia.
 *
 * The engine already signed the on-chain settlement preimage when the
 * bundle was produced (engine_signature_onchain field). This script
 * just rebuilds the parallel-array form of (agents, ethDeltas,
 * usdcDeltas) from settlement.vault_deltas, sanity-checks signature
 * recovery off-chain, then calls vault.settleBatch on chain.
 *
 * Modes:
 *   default       broadcasts a real tx; waits for receipt; prints tx
 *                 hash, gas used, and the Sepolia Etherscan link.
 *   --dry-run     simulates via eth_estimateGas. No tx, no gas.
 *
 * Env vars (loaded via shared loadDotenv):
 *   ALCHEMY_API_KEY      bare Alchemy key (or SEPOLIA_RPC_URL for full URL)
 *   DEPLOYER_PRIVATE_KEY any Sepolia-funded wallet to pay gas. Vault
 *                        does NOT restrict who can call settleBatch --
 *                        only the engine signature is checked -- so the
 *                        deployer key is a convenient choice.
 *
 * Anyone with a valid bundle + funded wallet can submit, which is the
 * point: the engine produces a tradeable signature, and any relayer
 * can land it on chain.
 *
 * Usage:
 *   npm run vault:settle -- path/to/bundle.json
 *   npm run vault:settle -- path/to/bundle.json --dry-run
 */

import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadDotenv } from "@shared/persistence";
import { buildVaultPreimage } from "@shared/vault/settlementSigner";
import { recoverHashSigner } from "@shared/crypto";
import { loadSepoliaDeployment } from "@shared/deployments/sepolia";

loadDotenv(".env");

const VAULT_ABI = parseAbi([
  "function settleBatch(bytes32 batchId, address[] agents, int256[] ethDeltas, int256[] usdcDeltas, bytes engineSig)",
  "function consumedBatchIds(bytes32) view returns (bool)",
  "event Settled(bytes32 indexed batchId, uint256 numAgents)",
]);

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

function resolveRpcUrl(): string {
  const explicit = process.env.SEPOLIA_RPC_URL;
  if (explicit) return explicit;
  const key = process.env.ALCHEMY_API_KEY;
  if (key) return `https://eth-sepolia.g.alchemy.com/v2/${key}`;
  throw new Error("Need SEPOLIA_RPC_URL or ALCHEMY_API_KEY in env");
}

function normalizeDeployerKey(): Hex {
  let pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY missing from env");
  if (!pk.startsWith("0x") && /^[0-9a-fA-F]{64}$/.test(pk)) pk = "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("DEPLOYER_PRIVATE_KEY must be 64 hex (with or without 0x)");
  }
  return pk as Hex;
}

export type SettleBundle = {
  batchReceipt: {
    batch_id: string;
    engine_signature_onchain?: string;
  };
  settlement: {
    batch_id: string;
    vault_deltas: ReadonlyArray<{
      agent_id: string;
      asset: "ETH" | "USDC";
      delta: string;
    }>;
  };
  expectedEngineAddress: string;
};

/**
 * Pure validation: confirms the bundle has everything onchain-settle needs.
 * Exported for unit testing without requiring an actual file or RPC.
 * Throws with a clear message; caller surfaces the error.
 */
export function validateSettleBundle(
  b: SettleBundle,
  context: string = "bundle"
): void {
  if (!b.batchReceipt?.engine_signature_onchain) {
    throw new Error(
      `${context}: batchReceipt.engine_signature_onchain is required ` +
        `for on-chain settlement; the bundle must come from a V2 stage 1+ engine.`
    );
  }
  if (!b.settlement?.vault_deltas || b.settlement.vault_deltas.length === 0) {
    throw new Error(
      `${context}: settlement.vault_deltas is empty; nothing to settle on chain.`
    );
  }
  if (b.settlement.batch_id !== b.batchReceipt.batch_id) {
    throw new Error(
      `${context}: settlement.batch_id mismatch with batchReceipt.batch_id`
    );
  }
}

async function loadBundle(path: string): Promise<SettleBundle> {
  const raw = await readFile(path, "utf-8");
  const b = JSON.parse(raw) as SettleBundle;
  validateSettleBundle(b, path);
  return b;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const bundlePath = argv.find((a) => !a.startsWith("--"));
  if (!bundlePath) {
    console.error(
      "usage: npm run vault:settle -- <bundle.json> [--dry-run]"
    );
    process.exit(2);
  }

  const bundle = await loadBundle(bundlePath);
  const deployment = await loadSepoliaDeployment();
  const vaultAddress = deployment.contracts.HecateVault.address as Address;

  // Rebuild the preimage from the bundle's vault_deltas. This is the
  // canonical conversion the engine used at signing time (V2 stage 1).
  const preimage = buildVaultPreimage(
    bundle.batchReceipt.batch_id,
    bundle.settlement.vault_deltas
  );
  const sig = bundle.batchReceipt.engine_signature_onchain! as Hex;

  // Sanity-check off-chain that the signature recovers to the engine
  // address. The on-chain call would revert "bad signer" if it doesn't,
  // but failing fast here saves a tx + gas.
  const recovered = recoverHashSigner(preimage.hash, sig);
  if (recovered.toLowerCase() !== bundle.expectedEngineAddress.toLowerCase()) {
    throw new Error(
      `signature recovery mismatch: recovered ${recovered}, expected ${bundle.expectedEngineAddress}`
    );
  }

  // Confirm the batch hasn't already been settled.
  const rpcUrl = resolveRpcUrl();
  console.log(`[settle] rpc: ${redactRpcUrl(rpcUrl)}`);
  console.log(`[settle] vault: ${vaultAddress}`);
  console.log(`[settle] batch_id: ${bundle.batchReceipt.batch_id}`);
  console.log(`[settle] batchIdBytes32: ${preimage.batchIdBytes32}`);
  console.log(`[settle] agents: ${preimage.agents.length}`);

  const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId !== 11155111) {
    throw new Error(
      `expected Sepolia (11155111), got chain ${chainId}; refusing to broadcast`
    );
  }

  const consumed = await pub.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "consumedBatchIds",
    args: [preimage.batchIdBytes32 as Hex],
  });
  if (consumed) {
    throw new Error(
      `batch ${preimage.batchIdBytes32} already settled on chain; vault would revert "batch already settled".`
    );
  }

  if (dryRun) {
    const pk = normalizeDeployerKey();
    const account = privateKeyToAccount(pk);
    const gas = await pub.estimateContractGas({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "settleBatch",
      args: [
        preimage.batchIdBytes32 as Hex,
        preimage.agents as readonly Address[],
        preimage.ethDeltas as readonly bigint[],
        preimage.usdcDeltas as readonly bigint[],
        sig,
      ],
      account: account.address,
    });
    console.log(`[settle] dry-run gas estimate: ${gas}`);
    console.log("[settle] dry-run complete; nothing broadcast.");
    return;
  }

  const pk = normalizeDeployerKey();
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  console.log(`[settle] submitter: ${account.address}`);
  const hash = await wallet.writeContract({
    chain: sepolia,
    account,
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "settleBatch",
    args: [
      preimage.batchIdBytes32 as Hex,
      preimage.agents as readonly Address[],
      preimage.ethDeltas as readonly bigint[],
      preimage.usdcDeltas as readonly bigint[],
      sig,
    ],
  });
  console.log(`[settle] tx submitted: ${hash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(
    `[settle] mined in block ${rcpt.blockNumber}, gas ${rcpt.gasUsed}, status ${rcpt.status}`
  );
  console.log(`[settle] etherscan: https://sepolia.etherscan.io/tx/${hash}`);
  if (rcpt.status !== "success") {
    process.exit(1);
  }
}

// Only run main() when executed directly (e.g., via `tsx scripts/onchain-settle.ts`
// or `npm run vault:settle`). Skip when imported by a test or another module.
import { fileURLToPath } from "node:url";
const ENTRY = fileURLToPath(import.meta.url);
if (process.argv[1] === ENTRY) {
  main().catch((e) => {
    console.error("[settle] error:", (e as Error).message);
    process.exit(1);
  });
}
