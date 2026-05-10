import { describe, it, expect } from "vitest";
import { verifyFullBatch } from "@shared/verify";
import { buildBatchReceipt, buildFillReceipts } from "@shared/receipts";
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
  FillReceipt,
  BatchReceipt,
  SettlementObject
} from "@shared/schemas";

const ENGINE_PK = "0x" + "0".repeat(63) + "1";
const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK);

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

function fullDemo() {
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
  const batchReceipt = buildBatchReceipt({
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
  const fillReceipts = buildFillReceipts({
    batch,
    fillPlan,
    reservationBook: book,
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
    batchReceipt,
    fillReceipts
  };
}

function fullInput(d = fullDemo()) {
  return {
    batchReceipt: d.batchReceipt,
    fillReceipts: d.fillReceipts,
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

describe("verifyFullBatch — happy path", () => {
  it("4-agent demo verifies ok", () => {
    expect(verifyFullBatch(fullInput())).toEqual({ ok: true });
  });
});

describe("verifyFullBatch — fill receipt presence", () => {
  it("missing fill receipt -> MISSING_FILL_RECEIPT", () => {
    const inp = fullInput();
    const r = verifyFullBatch({
      ...inp,
      fillReceipts: inp.fillReceipts.slice(0, 2) // drop one
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("MISSING_FILL_RECEIPT");
    }
  });

  it("duplicate fill receipt -> DUPLICATE_FILL_RECEIPT", () => {
    const inp = fullInput();
    const r = verifyFullBatch({
      ...inp,
      fillReceipts: [...inp.fillReceipts, inp.fillReceipts[0]!]
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("DUPLICATE_FILL_RECEIPT");
    }
  });

  it("extra fill receipt for non-batch intent -> EXTRA_FILL_RECEIPT", () => {
    const inp = fullInput();
    const ghost: FillReceipt = {
      ...inp.fillReceipts[0]!,
      intent_id: "intent_ghost"
    };
    const r = verifyFullBatch({
      ...inp,
      fillReceipts: [...inp.fillReceipts, ghost]
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("EXTRA_FILL_RECEIPT");
    }
  });
});

describe("verifyFullBatch — fill receipt cross-checks", () => {
  it("fill receipt batch_id mismatch -> FILL_RECEIPT_BATCH_ID_MISMATCH", () => {
    const inp = fullInput();
    const fr = inp.fillReceipts[0]!;
    const tampered: FillReceipt = { ...fr, batch_id: "batch_other" };
    const r = verifyFullBatch({
      ...inp,
      fillReceipts: [tampered, inp.fillReceipts[1]!, inp.fillReceipts[2]!]
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("FILL_RECEIPT_BATCH_ID_MISMATCH");
    }
  });

  it("fill receipt runtime mismatch -> FILL_RECEIPT_RUNTIME_MISMATCH", () => {
    const inp = fullInput();
    const fr = inp.fillReceipts[0]!;
    const tampered: FillReceipt = {
      ...fr,
      runtime: { ...fr.runtime, engine_code_digest: "sha256:other" }
    };
    const r = verifyFullBatch({
      ...inp,
      fillReceipts: [tampered, inp.fillReceipts[1]!, inp.fillReceipts[2]!]
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("FILL_RECEIPT_RUNTIME_MISMATCH");
    }
  });
});

describe("verifyFullBatch — settlement recompute", () => {
  it("input.settlement does not match buildSettlementObject -> SETTLEMENT_RECOMPUTE_MISMATCH", () => {
    const inp = fullInput();
    const tamperedSettlement: SettlementObject = {
      ...inp.settlement,
      vault_deltas: [] // empty vault_deltas; recompute would produce 6
    };
    const r = verifyFullBatch({ ...inp, settlement: tamperedSettlement });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      expect(codes).toContain("SETTLEMENT_RECOMPUTE_MISMATCH");
      // Also: batch receipt's settlement_hash now mismatches recompute (uses
      // tampered settlement) -> field mismatch under /batchReceipt.
      expect(codes).toContain("BATCH_RECEIPT_FIELD_MISMATCH");
    }
  });
});

describe("verifyFullBatch — num_matched cross-check", () => {
  it("batchReceipt.num_matched tampered -> NUM_MATCHED_INCONSISTENT_WITH_FILL_RECEIPTS", () => {
    const inp = fullInput();
    const tampered: BatchReceipt = { ...inp.batchReceipt, num_matched: 99 };
    const r = verifyFullBatch({ ...inp, batchReceipt: tampered });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      expect(codes).toContain("NUM_MATCHED_INCONSISTENT_WITH_FILL_RECEIPTS");
      // Also produces ENGINE_SIGNER_MISMATCH (under /batchReceipt) and
      // BATCH_RECEIPT_FIELD_MISMATCH /num_matched.
      expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
      expect(codes).toContain("BATCH_RECEIPT_FIELD_MISMATCH");
    }
  });
});

describe("verifyFullBatch — failure aggregation", () => {
  it("multiple simultaneous failures aggregated", () => {
    const inp = fullInput();
    // Drop a fill receipt + tamper settlement + tamper batch num_matched.
    const tamperedSettlement: SettlementObject = {
      ...inp.settlement,
      vault_deltas: []
    };
    const tamperedBatchReceipt: BatchReceipt = {
      ...inp.batchReceipt,
      num_matched: 99
    };
    const r = verifyFullBatch({
      ...inp,
      settlement: tamperedSettlement,
      batchReceipt: tamperedBatchReceipt,
      fillReceipts: inp.fillReceipts.slice(0, 2)
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = new Set(r.failures.map((f) => f.code));
      expect(codes.has("MISSING_FILL_RECEIPT")).toBe(true);
      expect(codes.has("SETTLEMENT_RECOMPUTE_MISMATCH")).toBe(true);
      expect(codes.has("NUM_MATCHED_INCONSISTENT_WITH_FILL_RECEIPTS")).toBe(true);
      expect(r.failures.length).toBeGreaterThan(3);
    }
  });
});

describe("verifyFullBatch — path prefixing", () => {
  it("nested failures use /batchReceipt and /fillReceipts/<id> prefixes", () => {
    const inp = fullInput();
    // Mutate one fill receipt's filled_base to trigger nested mismatch.
    const fr = inp.fillReceipts[0]!;
    const tamperedFill: FillReceipt = { ...fr, filled_base: "9" };
    const r = verifyFullBatch({
      ...inp,
      fillReceipts: [tamperedFill, inp.fillReceipts[1]!, inp.fillReceipts[2]!]
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.failures.map((f) => f.path);
      expect(
        paths.some(
          (p) => p === `/fillReceipts/${fr.intent_id}/filled_base`
        )
      ).toBe(true);
    }
  });
});
