/**
 * Minimal dotenv loader.
 *
 * Reads KEY=VALUE pairs from a .env file and injects them into
 * `process.env` for keys that aren't already set. Existing shell vars win
 * over file values (standard dotenv precedence).
 *
 * Why inline instead of the `dotenv` package: zero new deps, total control
 * over edge-case behavior (missing file = no-op, no thrown error;
 * surrounding quotes stripped; comments and blank lines ignored).
 *
 * Used by `server/index.ts` (so `npm run dev` picks up .env) and
 * `scripts/onchain-verify.ts` (so SEPOLIA_RPC_URL / VERIFIER_ADDRESS /
 * DEPLOYER_PRIVATE_KEY can live in .env). Forge already auto-loads .env
 * for `forge script` invocations.
 *
 * Vitest tests bypass this path — `tests/serverFixture.ts` synthesizes
 * env at bootstrap time, so tests are unaffected by whatever's in .env.
 */

import { existsSync, readFileSync } from "node:fs";

export function loadDotenv(path = ".env"): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes (single or double).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Shell wins over file (standard dotenv precedence).
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
