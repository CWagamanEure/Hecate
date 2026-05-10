/**
 * Property-based tamper fuzz.
 *
 * Builds a canonical 4-agent bundle, then for N iterations:
 *   1. deep-clone the honest bundle
 *   2. pick a random leaf path (Mulberry32 seeded RNG)
 *   3. apply a typed mutator to that leaf
 *   4. categorize the outcome
 *
 * Asserted property: NO single-point mutation produces a bundle that
 * verifyFullBatch accepts. Schema-rejected and verifier-rejected are both
 * acceptable; verifier-accepted is the failure condition.
 *
 * Env overrides:
 *   FUZZ_ITERATIONS   number of iterations (default 200)
 *   FUZZ_SEED         32-bit unsigned int seed (default 0xC0FFEE)
 *
 * This complements the 14 hand-picked tamper scenarios in
 * shared/verify/tampers.ts: those exercise specific properties; the fuzz
 * tests the umbrella property "every signed-over field is bound."
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  PK_B,
  PK_C,
  PK_D,
  ADDR_A,
  ADDR_B,
  ADDR_C,
  ADDR_D,
  sellPayload,
  buyPayload,
  makeEnvelope
} from "./serverFixture";
import { VerifyFullBatchRequest } from "@shared/schemas";
import { verifyFullBatch } from "@shared/verify";
import { canonicalJson } from "@shared/crypto";

afterAll(cleanupTempDirs);

const ITERS = Number(process.env.FUZZ_ITERATIONS ?? "200");
const SEED = Number(process.env.FUZZ_SEED ?? String(0xC0FFEE));

// ---- seeded RNG ------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- tree walking ----------------------------------------------------------

function collectLeafPaths(obj: unknown, prefix: string[] = []): string[][] {
  if (obj === null || typeof obj !== "object") return [prefix];
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [prefix];
    return obj.flatMap((v, i) => collectLeafPaths(v, [...prefix, String(i)]));
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([k, v]) => collectLeafPaths(v, [...prefix, k]));
}

function getAt(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur)
      ? (cur as unknown[])[Number(seg)]
      : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setAt(obj: unknown, path: string[], value: unknown): void {
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    cur = Array.isArray(cur)
      ? (cur as unknown[])[Number(seg)]
      : (cur as Record<string, unknown>)[seg];
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cur)) {
    (cur as unknown[])[Number(last)] = value;
  } else if (cur !== null && typeof cur === "object") {
    (cur as Record<string, unknown>)[last] = value;
  }
}

// ---- typed mutators --------------------------------------------------------

function mutate(rng: () => number, value: unknown): unknown | undefined {
  if (typeof value === "string") {
    // Hex (address, hash, signature, ciphertext): flip one body char.
    if (/^0x[0-9a-fA-F]+$/.test(value) && value.length >= 4) {
      const idx = 2 + Math.floor(rng() * (value.length - 2));
      const c = value[idx]!;
      const replacement = c === "0" ? "1" : "0";
      return value.slice(0, idx) + replacement + value.slice(idx + 1);
    }
    // Pure decimal string: increment last digit mod 10.
    if (/^\d+(\.\d+)?$/.test(value)) {
      const last = value[value.length - 1]!;
      if (/\d/.test(last)) {
        return value.slice(0, -1) + String((parseInt(last, 10) + 1) % 10);
      }
    }
    // Any other string (enums, intent_ids, nonces, etc.): append a char.
    return value + "X";
  }
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value === null) return "INJECTED";
  // Object/array leaves shouldn't reach here (collectLeafPaths descends).
  return undefined;
}

// ---- canonical bundle builder ----------------------------------------------

async function buildCanonicalBundle(): Promise<unknown> {
  const { app, state } = await newApp();
  await app.inject({
    method: "POST",
    url: "/vault/mock-deposit",
    payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
  });
  await app.inject({
    method: "POST",
    url: "/vault/mock-deposit",
    payload: { agent_id: ADDR_B, asset: "USDC", amount: "20000" }
  });
  await app.inject({
    method: "POST",
    url: "/vault/mock-deposit",
    payload: { agent_id: ADDR_C, asset: "USDC", amount: "30000" }
  });
  await app.inject({
    method: "POST",
    url: "/vault/mock-deposit",
    payload: { agent_id: ADDR_D, asset: "USDC", amount: "100" }
  });
  const pa = sellPayload({ base: "10", limit: "3580" });
  const pb = buyPayload({ base: "4", limit: "3610" });
  const pc = buyPayload({ base: "8", limit: "3590", min: "1" });
  const pd = buyPayload({ base: "1", limit: "3600" });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({ intent_id: "intent_fuzz_A", agent_id: ADDR_A, pk: PK_A, payload: pa })
  });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({ intent_id: "intent_fuzz_B", agent_id: ADDR_B, pk: PK_B, payload: pb })
  });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({ intent_id: "intent_fuzz_C", agent_id: ADDR_C, pk: PK_C, payload: pc })
  });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({ intent_id: "intent_fuzz_D", agent_id: ADDR_D, pk: PK_D, payload: pd })
  });
  const close = await app.inject({
    method: "POST",
    url: "/batches/close",
    payload: { batch_id: "batch_fuzz_canonical" }
  });
  const c = close.json();
  return {
    batchReceipt: c.batch_receipt,
    fillReceipts: c.fill_receipts,
    batch: c.batch,
    fillPlan: c.fill_plan,
    settlement: c.settlement,
    vaultStateBeforeSettlement: c.vault_state_before_settlement,
    vaultStateAfterSettlement: c.vault_state_after_settlement,
    reservationBookBeforeSettlement: c.reservation_book_before_settlement,
    reservationBookAfterSettlement: c.reservation_book_after_settlement,
    expectedEngineAddress: state.engineAddress
  };
}

// ---- the test --------------------------------------------------------------

describe("property-based tamper fuzz", () => {
  it(
    `${ITERS} random single-point mutations all reject (seed=0x${SEED.toString(16)})`,
    async () => {
      const honest = await buildCanonicalBundle();

      // Sanity: honest bundle must verify before we trust the rejection signal.
      const honestParsed = VerifyFullBatchRequest.safeParse(honest);
      expect(honestParsed.success).toBe(true);
      if (!honestParsed.success) throw new Error("unreachable");
      const honestResult = verifyFullBatch(honestParsed.data);
      expect(honestResult.ok).toBe(true);

      const honestJson = canonicalJson(honest);
      const leafPaths = collectLeafPaths(honest);
      expect(leafPaths.length).toBeGreaterThan(50); // ~hundreds for a 4-agent bundle

      const rng = mulberry32(SEED);
      const cats = {
        schema_rejected: 0,
        verifier_rejected: 0,
        noop: 0,
        verifier_accepted: 0
      };
      const accepted_paths: string[] = [];

      for (let iter = 0; iter < ITERS; iter++) {
        const mutated = structuredClone(honest);
        const path = leafPaths[Math.floor(rng() * leafPaths.length)]!;
        const oldValue = getAt(mutated, path);
        const newValue = mutate(rng, oldValue);
        if (newValue === undefined) {
          cats.noop++;
          continue;
        }
        setAt(mutated, path, newValue);

        const parsed = VerifyFullBatchRequest.safeParse(mutated);
        if (!parsed.success) {
          cats.schema_rejected++;
          continue;
        }

        if (canonicalJson(parsed.data) === honestJson) {
          cats.noop++;
          continue;
        }

        const result = verifyFullBatch(parsed.data);
        if (result.ok) {
          cats.verifier_accepted++;
          if (accepted_paths.length < 10) {
            accepted_paths.push(path.join("/") + " : " + JSON.stringify(oldValue) + " -> " + JSON.stringify(newValue));
          }
        } else {
          cats.verifier_rejected++;
        }
      }

      // Summary line — readable in vitest output, citable in the demo.
      // eslint-disable-next-line no-console
      console.log(
        `fuzz: ${ITERS} mutations · ${cats.verifier_rejected} verifier-rejected · ${cats.schema_rejected} schema-rejected · ${cats.noop} noops · ${cats.verifier_accepted} accepted`
      );
      if (cats.verifier_accepted > 0) {
        // eslint-disable-next-line no-console
        console.log("ACCEPTED MUTATIONS (first 10):", accepted_paths);
      }
      expect(cats.verifier_accepted).toBe(0);
    },
    60_000
  );
});
