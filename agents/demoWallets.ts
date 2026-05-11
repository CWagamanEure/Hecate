/**
 * demoWallets — loader + schema for `.demo-wallets.json`.
 *
 * V3 of the on-chain vault project produces `.demo-wallets.json` at the
 * repo root via `scripts/gen-demo-wallets.ts`. This module is the typed
 * loader. Use `loadDemoWallets()` to read the file; the function returns
 * the parsed object or throws a clear error if the file is missing or
 * malformed.
 *
 * Why this is its own module:
 *   - V3 only generates and persists wallets.
 *   - V4 will wire them into the simulator (`agents/runDemo.ts` and the
 *     example agent fixtures).
 *   - V5 will deploy the on-chain vault and fund the agents on Sepolia.
 *   - Beyond V5, the wallets carry real (testnet) value, so we want a
 *     single chokepoint that validates the file shape on every load.
 *
 * The wallets are gitignored. Each machine running the demo generates
 * its own fresh set.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Hex32, HexAddress } from "@shared/schemas/hex";
import { privateKeyToAddress } from "@shared/crypto";

const Wallet = z
  .object({
    pk: Hex32,
    addr: HexAddress,
  })
  .strict();
export type Wallet = z.infer<typeof Wallet>;

export const DemoWalletFile = z
  .object({
    version: z.literal(1),
    created_at: z.string(),
    note: z.string(),
    A: Wallet,
    B: Wallet,
    C: Wallet,
    D: Wallet,
  })
  .strict();
export type DemoWalletFile = z.infer<typeof DemoWalletFile>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = resolve(REPO_ROOT, ".demo-wallets.json");

/** Returns true iff a usable wallet file exists at `path` (or the default). */
export async function demoWalletsExist(path: string = DEFAULT_PATH): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load and validate `.demo-wallets.json`. Throws a clear error if the file
 * is missing or the schema doesn't match. The error message points the
 * caller at `npm run wallets:gen` so the failure is self-explanatory in
 * a demo context.
 */
export async function loadDemoWallets(
  path: string = DEFAULT_PATH
): Promise<DemoWalletFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    throw new Error(
      `loadDemoWallets: ${path} not found. Run \`npm run wallets:gen\` to ` +
        `create it. The wallets are gitignored, so each machine produces its own.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `loadDemoWallets: ${path} is not valid JSON (${(e as Error).message}). ` +
        `Delete it and run \`npm run wallets:gen\` to regenerate.`
    );
  }
  const result = DemoWalletFile.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `loadDemoWallets: ${path} failed schema validation: ${result.error.message}. ` +
        `Delete it and run \`npm run wallets:gen\` to regenerate.`
    );
  }
  // pk -> addr pairing integrity. The schema validates SHAPE only; this
  // extra step catches tampered files where pk and addr don't actually
  // belong to the same keypair (which would silently misroute funding to
  // an address the engine can't sign for). Comparison is case-insensitive
  // because the file may store either lowercase or EIP-55 form.
  for (const slot of ["A", "B", "C", "D"] as const) {
    const declared = result.data[slot].addr.toLowerCase();
    const derived = privateKeyToAddress(result.data[slot].pk).toLowerCase();
    if (declared !== derived) {
      throw new Error(
        `loadDemoWallets: ${path} agent ${slot} pk/addr mismatch ` +
          `(addr=${result.data[slot].addr}, but pk derives to ${privateKeyToAddress(result.data[slot].pk)}). ` +
          `Delete the file and run \`npm run wallets:gen\` to regenerate.`
      );
    }
  }
  return result.data;
}
