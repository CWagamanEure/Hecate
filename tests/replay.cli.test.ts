/**
 * Tests for the replay CLI's tamper scenarios. Builds a real bundle by
 * running the demo flow against a Fastify-injected server, then asserts
 * each tamper produces the expected verifyFullBatch failure codes.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  PK_B,
  ADDR_A,
  ADDR_B,
  sellPayload,
  buyPayload,
  makeEnvelope
} from "./serverFixture";
import { TAMPERS, SCENARIO_NAMES } from "../agents/replayTampers";
import { verifyFullBatch } from "@shared/verify";
import { VerifyFullBatchRequest } from "@shared/schemas";

afterAll(cleanupTempDirs);

let bundle: VerifyFullBatchRequest;

beforeAll(async () => {
  // Build a 2-agent bundle (SELL + BUY both FILLED, plus a third partial-fill
  // intent so swap-fill-receipt-body and friends have at least 2 fill receipts).
  const { app, state } = await newApp();
  await app.inject({
    method: "POST",
    url: "/vault/mock-deposit",
    payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
  });
  await app.inject({
    method: "POST",
    url: "/vault/mock-deposit",
    payload: { agent_id: ADDR_B, asset: "USDC", amount: "30000" }
  });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({
      intent_id: "intent_a",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: sellPayload({ base: "10", limit: "3580" })
    })
  });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({
      intent_id: "intent_b",
      agent_id: ADDR_B,
      pk: PK_B,
      payload: buyPayload({ base: "5", limit: "3600" })
    })
  });
  await app.inject({
    method: "POST",
    url: "/intents",
    payload: makeEnvelope({
      intent_id: "intent_c",
      agent_id: ADDR_B,
      pk: PK_B,
      payload: buyPayload({ base: "5", limit: "3590", min: "1" })
    })
  });
  const close = await app.inject({
    method: "POST",
    url: "/batches/close",
    payload: { batch_id: "batch_replay_test" }
  });
  const cb = close.json();
  const candidate = {
    batchReceipt: cb.batch_receipt,
    fillReceipts: cb.fill_receipts,
    batch: cb.batch,
    fillPlan: cb.fill_plan,
    settlement: cb.settlement,
    vaultStateBeforeSettlement: cb.vault_state_before_settlement,
    vaultStateAfterSettlement: cb.vault_state_after_settlement,
    reservationBookBeforeSettlement: cb.reservation_book_before_settlement,
    reservationBookAfterSettlement: cb.reservation_book_after_settlement,
    expectedEngineAddress: state.engineAddress
  };
  // Round-trip through Zod so `bundle` matches what the CLI consumes.
  bundle = VerifyFullBatchRequest.parse(candidate);
});

describe("replay CLI — baseline", () => {
  it("untampered bundle verifies ok", () => {
    expect(verifyFullBatch(bundle)).toEqual({ ok: true });
  });
});

const EXPECTED_CODES_FOR: Record<string, string[]> = {
  "clearing-price": ["BATCH_RECEIPT_FIELD_MISMATCH"],
  "vault-after-hash": ["BATCH_RECEIPT_FIELD_MISMATCH"],
  "reservation-after-hash": ["BATCH_RECEIPT_FIELD_MISMATCH"],
  "settlement-hash": ["BATCH_RECEIPT_FIELD_MISMATCH"],
  "intent-envelope-root": ["BATCH_RECEIPT_FIELD_MISMATCH"],
  "fill-base": ["FILL_RECEIPT_FIELD_MISMATCH"],
  "reserved-released": ["FILL_RECEIPT_FIELD_MISMATCH"],
  "signature-bytes": [], // accepts either ENGINE_SIGNER_MISMATCH or BATCH_SIGNATURE_INVALID
  "wrong-key": ["ENGINE_SIGNER_MISMATCH"],
  "swap-fill-receipt-body": ["DUPLICATE_FILL_RECEIPT"],
  "tamper-vault-supporting": ["BATCH_RECEIPT_FIELD_MISMATCH"],
  "tamper-settlement-deltas": ["SETTLEMENT_RECOMPUTE_MISMATCH"],
  "missing-fill-receipt": ["MISSING_FILL_RECEIPT"],
  "runtime-eigen-incoherent": ["RUNTIME_COHERENCE_INVALID"]
};

describe("replay CLI — tamper scenarios", () => {
  it.each(SCENARIO_NAMES)("scenario '%s' is rejected with expected codes", (name) => {
    const tamper = TAMPERS[name]!;
    const result = tamper(bundle);
    const r = verifyFullBatch(result.bundle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = new Set(r.failures.map((f) => f.code));
      const expected = EXPECTED_CODES_FOR[name] ?? [];
      for (const code of expected) {
        expect(codes.has(code)).toBe(true);
      }
      // For signature-bytes: must be one of the two valid signature-related codes.
      if (name === "signature-bytes") {
        expect(
          codes.has("ENGINE_SIGNER_MISMATCH") ||
            codes.has("BATCH_SIGNATURE_INVALID")
        ).toBe(true);
      }
    }
  });
});

describe("replay CLI — wrong-key authority binding", () => {
  it("only triggers ENGINE_SIGNER_MISMATCH; structural fields still match", () => {
    const result = TAMPERS["wrong-key"]!(bundle);
    const r = verifyFullBatch(result.bundle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      // ENGINE_SIGNER_MISMATCH must fire.
      expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
      // Critically: NO BATCH_RECEIPT_FIELD_MISMATCH on body fields, because
      // the body itself is identical (just re-signed). This is the demo's
      // payoff: structural recompute matches; only authority fails.
      const fieldFailures = r.failures.filter(
        (f) =>
          f.code === "BATCH_RECEIPT_FIELD_MISMATCH" &&
          !f.path?.startsWith("/runtime")
      );
      expect(fieldFailures).toEqual([]);
    }
  });
});
