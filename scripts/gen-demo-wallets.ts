/**
 * gen-demo-wallets.ts — V3 of the on-chain vault project.
 *
 * Generates 4 fresh secp256k1 keypairs (A, B, C, D) for Sepolia demo
 * agents and writes them to `.demo-wallets.json` at the repo root. The
 * file is gitignored so private keys never reach git.
 *
 * Idempotent: if `.demo-wallets.json` already exists, the script reads
 * it and prints the existing addresses without overwriting. To regenerate,
 * delete the file first.
 *
 * Output: prints the 4 addresses and the funding amounts the user needs
 * to send to each before V5 (Sepolia vault deploy + agent transactions).
 *
 * Run via: `npm run wallets:gen`
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { privateKeyToAddress } from "@shared/crypto";
import { DemoWalletFile } from "@agents/demoWallets";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLETS_PATH = resolve(REPO_ROOT, ".demo-wallets.json");

// Per-agent funding plan. These match what V5 will need:
//   - 0.005 ETH gas headroom for ~4-8 txs per agent (deposit, withdraw, etc).
//   - 5000 mUSDC seed for the demo flow (one buy intent + slack).
//   - Some agents are sellers (ETH-side), some buyers (USDC-side); we
//     overfund both columns so any agent can play either role.
const FUNDING_PLAN = [
  { role: "A (seller)", eth: "0.005", usdc_micro: "0" },
  { role: "B (buyer)",  eth: "0.005", usdc_micro: "5000" },
  { role: "C (buyer)",  eth: "0.005", usdc_micro: "5000" },
  { role: "D (buyer)",  eth: "0.005", usdc_micro: "200"  }, // intentionally underfunded for INSUFFICIENT_FUNDS demo branch
] as const;

function generateOne(): { pk: `0x${string}`; addr: `0x${string}` } {
  // node:crypto.randomBytes uses the OS CSPRNG (/dev/urandom on Linux/Mac).
  // We sample until we land inside the secp256k1 curve order, which is
  // overwhelmingly likely on the first attempt (~ 1 - 2^-128 per draw).
  for (let i = 0; i < 16; i++) {
    const candidate = randomBytes(32);
    if (secp.utils.isValidPrivateKey(candidate)) {
      const pk = ("0x" + bytesToHex(candidate)) as `0x${string}`;
      const addr = privateKeyToAddress(pk) as `0x${string}`;
      return { pk, addr };
    }
  }
  throw new Error("gen-demo-wallets: failed to draw a valid scalar in 16 tries");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (await fileExists(WALLETS_PATH)) {
    const raw = await readFile(WALLETS_PATH, "utf-8");
    const parsed = DemoWalletFile.parse(JSON.parse(raw));
    console.log("[wallets] .demo-wallets.json already exists; not overwriting.");
    console.log("[wallets] to regenerate, delete the file first.\n");
    printAddresses(parsed);
    return;
  }

  const A = generateOne();
  const B = generateOne();
  const C = generateOne();
  const D = generateOne();
  const created_at = new Date().toISOString();
  const file = DemoWalletFile.parse({
    version: 1,
    created_at,
    note:
      "Hecate demo agent wallets. Sepolia-only. Generated fresh per machine. " +
      "DO NOT use these keys for mainnet or for anything outside this demo. " +
      "Regenerate by deleting this file and running `npm run wallets:gen`.",
    A,
    B,
    C,
    D,
  });

  // mode 0o600 (owner-only rw). The file contains 4 secp256k1 private
  // keys; once V5 funds them on Sepolia, the keys carry real (testnet)
  // value. Default writeFile perms (0o644) would let any local user on
  // a shared host read the file. POSIX-only; ignored on Windows.
  await writeFile(WALLETS_PATH, JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600
  });
  console.log(`[wallets] wrote ${WALLETS_PATH} (mode 0o600)`);
  printAddresses(file);
}

function printAddresses(file: DemoWalletFile): void {
  console.log("Sepolia agent addresses:");
  for (const [name, plan] of [
    ["A", FUNDING_PLAN[0]] as const,
    ["B", FUNDING_PLAN[1]] as const,
    ["C", FUNDING_PLAN[2]] as const,
    ["D", FUNDING_PLAN[3]] as const,
  ]) {
    console.log(
      `  ${name}  ${file[name].addr}   ${plan.role.padEnd(12)} → fund ${plan.eth} ETH + ${plan.usdc_micro} mUSDC`
    );
  }
  console.log(
    "\nNext: send Sepolia ETH to each address from a faucet, then run\n" +
    "      V5 (Sepolia vault + MockUSDC deploy + mUSDC mints) to fund USDC."
  );
}

main().catch((e) => {
  console.error("[wallets] error:", e);
  process.exit(1);
});
