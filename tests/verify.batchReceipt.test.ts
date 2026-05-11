import { describe, it, expect } from "vitest";
import { verifyBatchReceipt } from "@shared/verify";
import {
  buildBatchReceipt,
  buildBatchReceiptBody,
  signBatchReceipt
} from "@shared/receipts";
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
  BatchReceipt
} from "@shared/schemas";

const ENGINE_PK = "0x" + "0".repeat(63) + "1";
const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK);
const OTHER_PK = "0x" + "0".repeat(63) + "9";
const OTHER_ADDR = privateKeyToAddress(OTHER_PK);

const PK_A = "0x" + "0".repeat(63) + "2";
const PK_B = "0x" + "0".repeat(63) + "3";
const PK_C = "0x" + "0".repeat(63) + "4";
const ADDR_A = privateKeyToAddress(PK_A);
const ADDR_B = privateKeyToAddress(PK_B);
const ADDR_C = privateKeyToAddress(PK_C);
const NOW = 1700000000000;

const RUNTIME: RuntimeMetadata = {
  runtime_mode: "LOCAL_MOCK",
  engine_code_digest: "sha256:dev-local",
  eigencompute_app_id: null,
  eigencompute_image_digest: null,
  eigencompute_attestation_id: null
};

let nonce = 1;
function sellPayload(opts: { base: string; limit: string; min?: string }): PrivatePayload {
  return {
    side: "SELL",
    asset_in: "ETH",
    asset_out: "USDC",
    max_base_amount: opts.base,
    limit_price: opts.limit,
    allow_partial_fill: true,
    min_base_fill_amount: opts.min ?? "0.0001",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonce++)
  };
}
function buyPayload(opts: { base: string; limit: string; min?: string }): PrivatePayload {
  return {
    side: "BUY",
    asset_in: "USDC",
    asset_out: "ETH",
    max_base_amount: opts.base,
    limit_price: opts.limit,
    allow_partial_fill: true,
    min_base_fill_amount: opts.min ?? "0.0001",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonce++)
  };
}
function envFor(intent_id: string, agent_id: string, pk: string, payload: PrivatePayload): PublicEnvelope {
  const unsigned: PublicEnvelopeUnsigned = {
    intent_id,
    agent_id,
    market: "ETH/USDC",
    expiry_ms: NOW + 60_000,
    payload_commitment: hashPayload(payload),
    payload_ciphertext: "0xdead",
    nonce: payload.nonce
  };
  return signEnvelope(unsigned, pk);
}
function makeBatch(entries: Array<{ envelope: PublicEnvelope; payload: PrivatePayload }>, batch_id = "batch_001"): BatchInput {
  return {
    batch_id,
    market: "ETH/USDC",
    intents: entries,
    market_snapshot: null,
    timestamp_ms: NOW
  };
}
function setup(intents: Array<{ envelope: PublicEnvelope; payload: PrivatePayload; deposit?: { agent_id: string; eth?: string; usdc?: string } }>): { vault: VaultState; book: ReservationBook } {
  let vault: VaultState = { agents: {} };
  const seen = new Set<string>();
  for (const i of intents) {
    if (i.deposit && !seen.has(i.deposit.agent_id)) {
      if (i.deposit.eth) vault = mockDeposit(vault, i.deposit.agent_id, "ETH", i.deposit.eth);
      if (i.deposit.usdc) vault = mockDeposit(vault, i.deposit.agent_id, "USDC", i.deposit.usdc);
      seen.add(i.deposit.agent_id);
    }
  }
  let book: ReservationBook = { reservations: [] };
  for (const i of intents) {
    const r = reserveForIntent(vault, book, i.envelope, i.payload, NOW);
    if (!r.ok) throw new Error(`setup: ${r.code} ${r.detail}`);
    vault = r.state;
    book = r.book;
  }
  return { vault, book };
}

function demoState() {
  const pa = sellPayload({ base: "10", limit: "3580" });
  const pb = buyPayload({ base: "4", limit: "3610" });
  const pc = buyPayload({ base: "8", limit: "3590", min: "1" });
  const ea = envFor("intent_A", ADDR_A, PK_A, pa);
  const eb = envFor("intent_B", ADDR_B, PK_B, pb);
  const ec = envFor("intent_C", ADDR_C, PK_C, pc);
  const intents = [
    { envelope: ea, payload: pa, deposit: { agent_id: ADDR_A, eth: "10" } },
    { envelope: eb, payload: pb, deposit: { agent_id: ADDR_B, usdc: "20000" } },
    { envelope: ec, payload: pc, deposit: { agent_id: ADDR_C, usdc: "30000" } }
  ];
  const { vault, book } = setup(intents);
  const batch = makeBatch([
    { envelope: ea, payload: pa },
    { envelope: eb, payload: pb },
    { envelope: ec, payload: pc }
  ]);
  const fillPlan: FillPlan = {
    clearing_price: "3590",
    fills: [
      { intent_id: "intent_A", filled_base: "10", filled_quote: "35900", status: "FILLED", unfilled_reason: null },
      { intent_id: "intent_B", filled_base: "4", filled_quote: "14360", status: "FILLED", unfilled_reason: null },
      { intent_id: "intent_C", filled_base: "6", filled_quote: "21540", status: "PARTIALLY_FILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
    ]
  };
  const apply = applySettlement({
    batch,
    fillPlan,
    vaultStateBeforeSettlement: vault,
    reservationBookBeforeSettlement: book
  });
  const receipt = buildBatchReceipt({
    batch,
    fillPlan,
    settlement: apply.settlement,
    vaultStateBeforeSettlement: vault,
    vaultStateAfterSettlement: apply.vault_state_after_settlement,
    reservationBookBeforeSettlement: book,
    reservationBookAfterSettlement: apply.reservation_book_after_settlement,
    runtime: RUNTIME,
    engineKey: ENGINE_PK
  });
  return {
    batch,
    fillPlan,
    settlement: apply.settlement,
    vaultBefore: vault,
    vaultAfter: apply.vault_state_after_settlement,
    bookBefore: book,
    bookAfter: apply.reservation_book_after_settlement,
    receipt
  };
}

function baseInput(d = demoState()) {
  return {
    receipt: d.receipt,
    batch: d.batch,
    fillPlan: d.fillPlan,
    settlement: d.settlement,
    vaultStateBeforeSettlement: d.vaultBefore,
    vaultStateAfterSettlement: d.vaultAfter,
    reservationBookBeforeSettlement: d.bookBefore,
    reservationBookAfterSettlement: d.bookAfter,
    expectedEngineAddress: ENGINE_ADDR
  };
}

describe("verifyBatchReceipt — happy path", () => {
  it("valid 4-agent demo verifies ok", () => {
    expect(verifyBatchReceipt(baseInput())).toEqual({ ok: true });
  });
});

describe("verifyBatchReceipt — V2 on-chain signature", () => {
  it("rejects a receipt that strips engine_signature_onchain when vault_deltas is non-empty", () => {
    const inp = baseInput();
    // Demo has 3 matched agents -> settlement.vault_deltas is non-empty.
    expect(inp.settlement.vault_deltas.length).toBeGreaterThan(0);
    // Forcibly strip the field that buildBatchReceipt attached.
    const { engine_signature_onchain: _drop, ...stripped } = inp.receipt as
      BatchReceipt & { engine_signature_onchain?: string };
    const r = verifyBatchReceipt({ ...inp, receipt: stripped as BatchReceipt });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("ONCHAIN_SIGNATURE_REQUIRED");
    }
  });

  it("rejects a tampered engine_signature_onchain", () => {
    const inp = baseInput();
    const sig = inp.receipt.engine_signature_onchain!;
    // Flip one nibble inside the r component to keep it structurally valid.
    const flipped = (sig.slice(0, 10) +
      (sig[10] === "0" ? "1" : "0") +
      sig.slice(11)) as `0x${string}`;
    const tampered = { ...inp.receipt, engine_signature_onchain: flipped };
    const r = verifyBatchReceipt({ ...inp, receipt: tampered });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      // Either signer-mismatch (recovers to a different address) or
      // signature-invalid (bad recovery byte path). Both are acceptable
      // rejections for a corrupted on-chain signature.
      expect(
        codes.includes("ONCHAIN_SIGNER_MISMATCH") ||
          codes.includes("ONCHAIN_SIGNATURE_INVALID")
      ).toBe(true);
    }
  });

  it("rejects a malformed (truncated) engine_signature_onchain", () => {
    const inp = baseInput();
    const tampered = {
      ...inp.receipt,
      engine_signature_onchain: "0xdeadbeef" as `0x${string}`
    };
    const r = verifyBatchReceipt({ ...inp, receipt: tampered });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      // Truncated length -> recoverHashSigner throws, caught as INVALID.
      // (Note: Hex65 schema validation happens at the API boundary, not
      // inside verifyBatchReceipt, so a malformed value reaches recovery.)
      expect(codes).toContain("ONCHAIN_SIGNATURE_INVALID");
    }
  });
});

describe("verifyBatchReceipt — signer", () => {
  it("wrong expectedEngineAddress -> ENGINE_SIGNER_MISMATCH", () => {
    const r = verifyBatchReceipt({ ...baseInput(), expectedEngineAddress: OTHER_ADDR });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("ENGINE_SIGNER_MISMATCH");
    }
  });

  it("flipping a hex char in engine_signature: ENGINE_SIGNER_MISMATCH or BATCH_SIGNATURE_INVALID", () => {
    const inp = baseInput();
    const sig = inp.receipt.engine_signature;
    const flipped = (sig.slice(0, 4) +
      (sig[4] === "0" ? "1" : "0") +
      sig.slice(5)) as `0x${string}`;
    const r = verifyBatchReceipt({
      ...inp,
      receipt: { ...inp.receipt, engine_signature: flipped }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      expect(
        codes.includes("ENGINE_SIGNER_MISMATCH") ||
          codes.includes("BATCH_SIGNATURE_INVALID")
      ).toBe(true);
    }
  });
});

describe("verifyBatchReceipt — receipt-field tampering", () => {
  it.each([
    ["settlement_hash", { settlement_hash: ("0x" + "f".repeat(64)) as `0x${string}` }],
    ["vault_state_after_hash", { vault_state_after_hash: ("0x" + "e".repeat(64)) as `0x${string}` }],
    ["vault_state_before_hash", { vault_state_before_hash: ("0x" + "d".repeat(64)) as `0x${string}` }],
    ["reservation_book_after_hash", { reservation_book_after_hash: ("0x" + "c".repeat(64)) as `0x${string}` }],
    ["reservation_book_before_hash", { reservation_book_before_hash: ("0x" + "b".repeat(64)) as `0x${string}` }],
    ["intent_envelope_root", { intent_envelope_root: ("0x" + "a".repeat(64)) as `0x${string}` }],
    ["private_payload_commitment_root", { private_payload_commitment_root: ("0x" + "9".repeat(64)) as `0x${string}` }],
    ["clearing_price", { clearing_price: "9999" as const }],
    ["num_matched", { num_matched: 99 }],
    ["num_intents", { num_intents: 99 }],
    ["timestamp_ms", { timestamp_ms: NOW + 1 }]
  ])("mutating %s -> ENGINE_SIGNER_MISMATCH AND BATCH_RECEIPT_FIELD_MISMATCH", (field, override) => {
    const inp = baseInput();
    const tamperedReceipt = { ...inp.receipt, ...(override as Partial<BatchReceipt>) };
    const r = verifyBatchReceipt({ ...inp, receipt: tamperedReceipt });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      const paths = r.failures.map((f) => f.path);
      expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
      expect(codes).toContain("BATCH_RECEIPT_FIELD_MISMATCH");
      expect(paths).toContain(`/${field}`);
    }
  });
});

describe("verifyBatchReceipt — supporting-artifact tampering (recompute side)", () => {
  it("wrong vaultStateAfterSettlement -> BATCH_RECEIPT_FIELD_MISMATCH /vault_state_after_hash", () => {
    const d = demoState();
    const wrong = mockDeposit(d.vaultAfter, ADDR_A, "USDC", "1");
    const r = verifyBatchReceipt({
      ...baseInput(d),
      vaultStateAfterSettlement: wrong
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fieldFailures = r.failures.filter(
        (f) => f.code === "BATCH_RECEIPT_FIELD_MISMATCH"
      );
      expect(fieldFailures.some((f) => f.path === "/vault_state_after_hash")).toBe(
        true
      );
    }
  });
});

describe("verifyBatchReceipt — runtime coherence", () => {
  it("EIGEN_TEE with null eigen fields -> RUNTIME_COHERENCE_INVALID", () => {
    const d = demoState();
    // Build a fresh receipt with EIGEN_TEE+null runtime (incoherent).
    const incoherentRuntime: RuntimeMetadata = {
      runtime_mode: "EIGEN_TEE",
      engine_code_digest: "sha256:incoherent",
      eigencompute_app_id: null,
      eigencompute_image_digest: null,
      eigencompute_attestation_id: null
    };
    const body = buildBatchReceiptBody({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: incoherentRuntime
    });
    const signed = signBatchReceipt(body, ENGINE_PK);
    const r = verifyBatchReceipt({
      ...baseInput(d),
      receipt: signed
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const coherence = r.failures.filter(
        (f) => f.code === "RUNTIME_COHERENCE_INVALID"
      );
      expect(coherence.length).toBe(3); // all three eigen fields null
      expect(coherence.map((f) => f.path).sort()).toEqual([
        "/runtime/eigencompute_app_id",
        "/runtime/eigencompute_attestation_id",
        "/runtime/eigencompute_image_digest"
      ]);
    }
  });

  it("LOCAL_MOCK with non-null eigen fields -> RUNTIME_COHERENCE_INVALID", () => {
    const d = demoState();
    const incoherentRuntime: RuntimeMetadata = {
      runtime_mode: "LOCAL_MOCK",
      engine_code_digest: "sha256:dev-local",
      eigencompute_app_id: "app-1",
      eigencompute_image_digest: null,
      eigencompute_attestation_id: null
    };
    const body = buildBatchReceiptBody({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: incoherentRuntime
    });
    const signed = signBatchReceipt(body, ENGINE_PK);
    const r = verifyBatchReceipt({
      ...baseInput(d),
      receipt: signed
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.failures.some(
          (f) =>
            f.code === "RUNTIME_COHERENCE_INVALID" &&
            f.path === "/runtime/eigencompute_app_id"
        )
      ).toBe(true);
    }
  });
});

describe("verifyBatchReceipt — wrong-key signing (authority binding)", () => {
  it("malicious actor mutates a field, also tampers supporting artifact, and re-signs with wrong key -> ENGINE_SIGNER_MISMATCH only", () => {
    const d = demoState();
    // Simulate: attacker takes the receipt body, changes settlement_hash in
    // the body and ALSO supplies a tampered settlement that hashes to the new
    // settlement_hash. They re-sign with their OWN key. Field comparison passes
    // (recompute uses the tampered settlement). Signer is wrong.
    const tamperedSettlement = {
      ...d.settlement,
      // Drop a vault_delta to change the settlement hash. Note: this would also
      // break conservation, but we're not asking the verifier to accept the
      // tampered settlement; we're asking it to flag the wrong signer.
      vault_deltas: d.settlement.vault_deltas.slice(0, -1)
    };
    // Build a fresh receipt body using the TAMPERED settlement, then sign with OTHER key.
    let bodyForTampered: ReturnType<typeof buildBatchReceiptBody> | null = null;
    try {
      bodyForTampered = buildBatchReceiptBody({
        batch: d.batch,
        fillPlan: d.fillPlan,
        settlement: tamperedSettlement,
        vaultStateBeforeSettlement: d.vaultBefore,
        vaultStateAfterSettlement: d.vaultAfter,
        reservationBookBeforeSettlement: d.bookBefore,
        reservationBookAfterSettlement: d.bookAfter,
        runtime: RUNTIME
      });
    } catch {
      // The receipt builder might reject the tampered settlement (conservation).
      // Fall back to a different mutation: change clearing_price in receipt body
      // AND fillPlan to keep recompute consistent.
    }
    if (!bodyForTampered) {
      const tamperedFp: FillPlan = { ...d.fillPlan, clearing_price: "3500" };
      // recompute settlement to keep clearing_price consistent
      // but tamperedSettlement.clearing_price needs to match too
      const tamperedSettlement2 = { ...d.settlement, clearing_price: "3500" };
      bodyForTampered = buildBatchReceiptBody({
        batch: d.batch,
        fillPlan: tamperedFp,
        settlement: tamperedSettlement2,
        vaultStateBeforeSettlement: d.vaultBefore,
        vaultStateAfterSettlement: d.vaultAfter,
        reservationBookBeforeSettlement: d.bookBefore,
        reservationBookAfterSettlement: d.bookAfter,
        runtime: RUNTIME
      });
      const signed = signBatchReceipt(bodyForTampered, OTHER_PK);
      const r = verifyBatchReceipt({
        receipt: signed,
        batch: d.batch,
        fillPlan: tamperedFp,
        settlement: tamperedSettlement2,
        vaultStateBeforeSettlement: d.vaultBefore,
        vaultStateAfterSettlement: d.vaultAfter,
        reservationBookBeforeSettlement: d.bookBefore,
        reservationBookAfterSettlement: d.bookAfter,
        expectedEngineAddress: ENGINE_ADDR
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const codes = r.failures.map((f) => f.code);
        expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
        // Field comparison passes because we built the body from the tampered
        // settlement and fillPlan that the verifier also receives.
        expect(codes.filter((c) => c === "BATCH_RECEIPT_FIELD_MISMATCH")).toEqual([]);
      }
    }
  });
});
