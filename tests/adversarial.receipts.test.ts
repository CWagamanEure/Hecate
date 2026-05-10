/**
 * Mutation-table adversarial tests for verifyFullBatch.
 *
 * For each scalar field across BatchReceipt + per-FillReceipt + supporting
 * artifacts, mutate one field and assert verification fails with a meaningful
 * code. Per Ticket 17 fix policy: signature mutations may either return a
 * different signer OR throw — both correctly invalidate.
 */

import { describe, it, expect } from "vitest";
import { verifyFullBatch } from "@shared/verify";
import { buildBatchReceipt, buildFillReceipts, signBatchReceipt } from "@shared/receipts";
import { applySettlement } from "@shared/settlement";
import { mockDeposit, reserveForIntent } from "@shared/vault";
import {
  signEnvelope,
  privateKeyToAddress,
  hashPayload
} from "@shared/crypto";
import type {
  BatchInput,
  FillPlan,
  PrivatePayload,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  ReservationBook,
  RuntimeMetadata,
  VaultState,
  BatchReceipt,
  FillReceipt,
  SettlementObject
} from "@shared/schemas";

const ENGINE_PK = "0x" + "0".repeat(63) + "1";
const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK);
const OTHER_PK = "0x" + "0".repeat(63) + "9";
const PK_A = "0x" + "0".repeat(63) + "2";
const PK_B = "0x" + "0".repeat(63) + "3";
const ADDR_A = privateKeyToAddress(PK_A);
const ADDR_B = privateKeyToAddress(PK_B);

const RUNTIME: RuntimeMetadata = {
  runtime_mode: "LOCAL_MOCK",
  engine_code_digest: "sha256:test",
  eigencompute_app_id: null,
  eigencompute_image_digest: null,
  eigencompute_attestation_id: null
};

let nonce = 1;
function envFor(intent_id: string, agent_id: string, pk: string, p: PrivatePayload) {
  const u: PublicEnvelopeUnsigned = {
    intent_id,
    agent_id,
    market: "ETH/USDC",
    expiry_ms: Date.now() + 60000,
    payload_commitment: hashPayload(p),
    payload_ciphertext: "0xdead",
    nonce: p.nonce
  };
  return signEnvelope(u, pk);
}

function fullDemo() {
  const pa: PrivatePayload = {
    side: "SELL",
    asset_in: "ETH",
    asset_out: "USDC",
    max_base_amount: "5",
    limit_price: "3580",
    allow_partial_fill: true,
    min_base_fill_amount: "1",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonce++)
  };
  const pb: PrivatePayload = {
    side: "BUY",
    asset_in: "USDC",
    asset_out: "ETH",
    max_base_amount: "5",
    limit_price: "3600",
    allow_partial_fill: true,
    min_base_fill_amount: "1",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonce++)
  };
  const ea = envFor("intent_a", ADDR_A, PK_A, pa);
  const eb = envFor("intent_b", ADDR_B, PK_B, pb);
  let vault: VaultState = { agents: {} };
  vault = mockDeposit(vault, ADDR_A, "ETH", "5");
  vault = mockDeposit(vault, ADDR_B, "USDC", "20000");
  let book: ReservationBook = { reservations: [] };
  const ra = reserveForIntent(vault, book, ea, pa, Date.now());
  if (ra.ok) { vault = ra.state; book = ra.book; }
  const rb = reserveForIntent(vault, book, eb, pb, Date.now());
  if (rb.ok) { vault = rb.state; book = rb.book; }
  const batch: BatchInput = {
    batch_id: "batch_demo",
    market: "ETH/USDC",
    intents: [
      { envelope: ea, payload: pa },
      { envelope: eb, payload: pb }
    ],
    market_snapshot: null,
    timestamp_ms: Date.now()
  };
  const fp: FillPlan = {
    clearing_price: "3590",
    fills: [
      { intent_id: "intent_a", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
      { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
    ]
  };
  const apply = applySettlement({
    batch,
    fillPlan: fp,
    vaultStateBeforeSettlement: vault,
    reservationBookBeforeSettlement: book
  });
  const batchReceipt = buildBatchReceipt({
    batch,
    fillPlan: fp,
    settlement: apply.settlement,
    vaultStateBeforeSettlement: vault,
    vaultStateAfterSettlement: apply.vault_state_after_settlement,
    reservationBookBeforeSettlement: book,
    reservationBookAfterSettlement: apply.reservation_book_after_settlement,
    runtime: RUNTIME,
    engineKey: ENGINE_PK
  });
  const fillReceipts = buildFillReceipts({
    batch,
    fillPlan: fp,
    reservationBook: book,
    runtime: RUNTIME,
    engineKey: ENGINE_PK
  });
  return {
    input: {
      batchReceipt,
      fillReceipts,
      batch,
      fillPlan: fp,
      settlement: apply.settlement,
      vaultStateBeforeSettlement: vault,
      vaultStateAfterSettlement: apply.vault_state_after_settlement,
      reservationBookBeforeSettlement: book,
      reservationBookAfterSettlement: apply.reservation_book_after_settlement,
      expectedEngineAddress: ENGINE_ADDR
    }
  };
}

describe("adversarial mutation table — batch receipt scalar fields", () => {
  it.each([
    ["batch_id", "batch_other"],
    ["clearing_price", "9999"],
    ["intent_envelope_root", ("0x" + "f".repeat(64))],
    ["private_payload_commitment_root", ("0x" + "e".repeat(64))],
    ["vault_state_before_hash", ("0x" + "d".repeat(64))],
    ["vault_state_after_hash", ("0x" + "c".repeat(64))],
    ["reservation_book_before_hash", ("0x" + "b".repeat(64))],
    ["reservation_book_after_hash", ("0x" + "a".repeat(64))],
    ["settlement_hash", ("0x" + "9".repeat(64))],
    ["num_intents", 99],
    ["num_matched", 99],
    ["timestamp_ms", 1]
  ])("mutating batchReceipt.%s -> verifyFullBatch fails", (field, value) => {
    const d = fullDemo();
    const tampered: BatchReceipt = { ...d.input.batchReceipt, [field]: value as never };
    const r = verifyFullBatch({ ...d.input, batchReceipt: tampered });
    expect(r.ok).toBe(false);
  });
});

describe("adversarial mutation table — fill receipt fields", () => {
  it.each([
    ["filled_base", "999"],
    ["filled_quote", "0"],
    ["constraints_satisfied", false],
    ["payload_commitment", "0x" + "f".repeat(64)],
    ["agent_id", ADDR_B] // wrong agent
  ])("mutating fillReceipts[0].%s -> verifyFullBatch fails", (field, value) => {
    const d = fullDemo();
    const tampered: FillReceipt = { ...d.input.fillReceipts[0]!, [field]: value as never };
    const r = verifyFullBatch({
      ...d.input,
      fillReceipts: [tampered, d.input.fillReceipts[1]!]
    });
    expect(r.ok).toBe(false);
  });

  it("mutating fillReceipts[0].reserved_released -> verifyFullBatch fails", () => {
    const d = fullDemo();
    const fr = d.input.fillReceipts[0]!;
    const tampered: FillReceipt = {
      ...fr,
      reserved_released: { ETH: "999", USDC: "0" }
    };
    const r = verifyFullBatch({
      ...d.input,
      fillReceipts: [tampered, d.input.fillReceipts[1]!]
    });
    expect(r.ok).toBe(false);
  });
});

describe("adversarial mutation table — supporting artifacts", () => {
  it("tampering vault_state_after_settlement -> SETTLEMENT_RECOMPUTE_MISMATCH or BATCH_RECEIPT_FIELD_MISMATCH", () => {
    const d = fullDemo();
    const tampered: VaultState = {
      agents: {
        ...d.input.vaultStateAfterSettlement.agents,
        [ADDR_A]: {
          ...d.input.vaultStateAfterSettlement.agents[ADDR_A]!,
          balances: { ETH: "999", USDC: "0" }
        }
      }
    };
    const r = verifyFullBatch({ ...d.input, vaultStateAfterSettlement: tampered });
    expect(r.ok).toBe(false);
  });

  it("tampering settlement.vault_deltas -> SETTLEMENT_RECOMPUTE_MISMATCH", () => {
    const d = fullDemo();
    const tampered: SettlementObject = {
      ...d.input.settlement,
      vault_deltas: []
    };
    const r = verifyFullBatch({ ...d.input, settlement: tampered });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("SETTLEMENT_RECOMPUTE_MISMATCH");
    }
  });
});

describe("adversarial — wrong-key signing for full batch", () => {
  it("attacker mutates batchReceipt + supporting artifact to match, signs with wrong key -> ENGINE_SIGNER_MISMATCH", () => {
    const d = fullDemo();
    // Take the existing body and re-sign with OTHER_PK.
    const { engine_signature: _s, ...body } = d.input.batchReceipt;
    const otherSigned = signBatchReceipt(body, OTHER_PK);
    const r = verifyFullBatch({ ...d.input, batchReceipt: otherSigned });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Field comparison passes (we re-built with same supporting artifacts).
      // The signer recovered from OTHER_PK doesn't match ENGINE_ADDR.
      const codes = r.failures.map((f) => f.code);
      expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
      // Should NOT contain BATCH_RECEIPT_FIELD_MISMATCH because supporting
      // artifacts (vault, settlement, etc.) are unchanged; the body fields
      // recompute identically.
      const fieldFailures = r.failures.filter(
        (f) => f.code === "BATCH_RECEIPT_FIELD_MISMATCH"
      );
      expect(fieldFailures).toEqual([]);
    }
  });
});
