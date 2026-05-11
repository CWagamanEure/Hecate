/**
 * On-chain verification of a Hecate batch receipt.
 *
 * Reads a saved bundle (output of `npm run simulate -- --save-bundle ...`),
 * recomputes the batch-receipt body hash via the same canonical-JSON path
 * the engine uses, then calls `verifyAndEmit` on the deployed
 * HecateSettlementVerifier contract.
 *
 * Modes:
 *   default       broadcasts a real tx; waits for receipt; prints tx hash,
 *                 gas used, and (on Sepolia) an Etherscan link.
 *   --dry-run     uses eth_call to simulate against verifyEngineSignature.
 *                 No tx submitted, no gas spent.
 *
 * Env vars:
 *   SEPOLIA_RPC_URL        RPC endpoint (Sepolia or anvil-on-localhost)
 *   VERIFIER_ADDRESS       deployed contract address
 *   DEPLOYER_PRIVATE_KEY   wallet that signs the tx (required unless --dry-run)
 *
 * Chain-id safety: refuses to run against any chain other than Sepolia
 * (11155111) or local Anvil/Hardhat (31337). Belt-and-suspenders so a
 * misconfigured RPC URL can't accidentally broadcast on a different chain.
 *
 * Usage:
 *   npm run onchain:verify -- ./data/last-bundle.json
 *   npm run onchain:verify -- ./data/last-bundle.json --dry-run
 */

import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  getAddress,
  type Hex,
  type Address
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { hashBatchReceiptBody } from "@shared/crypto";
import { loadDotenv } from "@shared/persistence";

// Load .env from project root if present. Shell vars win over file values.
loadDotenv(".env");

// Minimal ABI — only the three pieces we need.
const VERIFIER_ABI = [
  {
    type: "function",
    name: "verifyAndEmit",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "sig", type: "bytes" },
      { name: "expectedEngine", type: "address" }
    ],
    outputs: [{ name: "ok", type: "bool" }],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "verifyEngineSignature",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "sig", type: "bytes" },
      { name: "expectedEngine", type: "address" }
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "pure"
  },
  {
    type: "event",
    name: "ReceiptVerified",
    inputs: [
      { name: "hash", type: "bytes32", indexed: true },
      { name: "signer", type: "address", indexed: true }
    ]
  }
] as const;

const LOCAL_CHAIN = defineChain({
  id: 31337,
  name: "Anvil/Local",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } }
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} not set; see .env.example for the variables this script needs.`);
  }
  return v;
}

/**
 * Resolve the Sepolia RPC URL. Two accepted forms:
 *   1. SEPOLIA_RPC_URL  — explicit full URL (any provider).
 *   2. ALCHEMY_API_KEY  — bare Alchemy key; we construct the Sepolia URL.
 * SEPOLIA_RPC_URL wins if both are set.
 */
function resolveRpcUrl(): string {
  const explicit = process.env.SEPOLIA_RPC_URL;
  if (explicit) return explicit;
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (alchemyKey) return `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`;
  throw new Error(
    "Need SEPOLIA_RPC_URL or ALCHEMY_API_KEY in env (or .env); see .env.example."
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const bundlePath = argv.find((a) => !a.startsWith("--"));
  if (!bundlePath) {
    console.error("usage: tsx scripts/onchain-verify.ts <bundle.json> [--dry-run]");
    process.exit(2);
  }

  // Read and validate the bundle first — gives a clearer error than env-var
  // failure for the common case of a typo'd path or stale bundle.
  const raw = await readFile(bundlePath, "utf-8");
  let bundle: any;
  try {
    bundle = JSON.parse(raw);
  } catch (e) {
    throw new Error(`bundle ${bundlePath} is not valid JSON: ${(e as Error).message}`);
  }
  if (!bundle.batchReceipt?.engine_signature) {
    throw new Error(`bundle ${bundlePath} missing batchReceipt.engine_signature`);
  }
  if (!bundle.expectedEngineAddress) {
    throw new Error(`bundle ${bundlePath} missing expectedEngineAddress`);
  }

  const rpcUrl = resolveRpcUrl();
  const verifierAddr = requireEnv("VERIFIER_ADDRESS") as Address;
  const deployerPk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!dryRun && !deployerPk) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY required unless --dry-run is set (no tx will be broadcast)."
    );
  }

  const sig = bundle.batchReceipt.engine_signature as Hex;
  // hashBatchReceiptBody strips engine_signature defensively, so we pass the
  // signed body directly.
  const hash = hashBatchReceiptBody(bundle.batchReceipt) as Hex;
  const expectedEngine = bundle.expectedEngineAddress as Address;

  console.log("Bundle:");
  console.log(`  batch_id:        ${bundle.batchReceipt.batch_id}`);
  console.log(`  body hash:       ${hash}`);
  console.log(`  signature:       ${sig.slice(0, 18)}...${sig.slice(-16)}`);
  console.log(`  expected engine: ${expectedEngine}`);
  console.log(`  contract:        ${verifierAddr}`);
  console.log(`  rpc:             ${rpcUrl}`);

  // Build a public client to inspect chain id and (in dry-run) eth_call.
  const probeClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probeClient.getChainId();
  let chain;
  if (chainId === 11155111) chain = sepolia;
  else if (chainId === 31337) chain = LOCAL_CHAIN;
  else {
    throw new Error(
      `refusing to broadcast on chain ${chainId} — only Sepolia (11155111) or local Anvil (31337) supported.`
    );
  }
  console.log(`  chain:           ${chain.name} (id=${chainId})`);

  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  // Dry call against the pure verifier function — proves the recovery works
  // before we spend any gas.
  const ok = await pub.readContract({
    address: verifierAddr,
    abi: VERIFIER_ABI,
    functionName: "verifyEngineSignature",
    args: [hash, sig, expectedEngine]
  });

  console.log(`\nDry-run (eth_call → verifyEngineSignature): ${ok ? "✓ verifies" : "✗ would reject"}`);
  if (!ok) {
    console.error("contract reports the signature does NOT verify; refusing to broadcast.");
    process.exit(1);
  }
  if (dryRun) {
    console.log("\n--dry-run set; no transaction broadcast.");
    return;
  }

  // Broadcast verifyAndEmit.
  const account = privateKeyToAccount(deployerPk!);
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
  console.log(`\nBroadcasting verifyAndEmit from ${account.address} ...`);

  const txHash = await wallet.writeContract({
    address: verifierAddr,
    abi: VERIFIER_ABI,
    functionName: "verifyAndEmit",
    args: [hash, sig, expectedEngine]
  });
  console.log(`  tx hash: ${txHash}`);
  if (chainId === 11155111) {
    console.log(`  pending: https://sepolia.etherscan.io/tx/${txHash}`);
  }

  const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
  console.log(`\n✓ confirmed in block ${rcpt.blockNumber} (gas used: ${rcpt.gasUsed})`);
  if (chainId === 11155111) {
    console.log(`  https://sepolia.etherscan.io/tx/${txHash}`);
  }
  console.log(`  events emitted: ${rcpt.logs.length}`);

  // Decode the ReceiptVerified event from a log emitted by the verifier
  // contract. The event has two indexed topics (hash, signer); topics[0] is
  // the event signature hash (which we don't need to recompute because the
  // address+arity filter already pins this to OUR event).
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() === verifierAddr.toLowerCase() && log.topics.length === 3) {
      const eventHash = log.topics[1]!;
      // topics[2] is the 32-byte left-padded address; recover the 20-byte
      // address and normalize to EIP-55 checksum form for display.
      const eventSigner = getAddress("0x" + log.topics[2]!.slice(-40));
      console.log(`  event ReceiptVerified:`);
      console.log(`    hash:   ${eventHash}`);
      console.log(`    signer: ${eventSigner}`);
    }
  }
}

main().catch((e) => {
  console.error(`\n× ${(e as Error).message}`);
  process.exit(1);
});
