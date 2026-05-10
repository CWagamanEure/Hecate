import { describe, it, expect } from "vitest";
import { verifyFillReceipt } from "@shared/verify";
import { buildFillReceipts } from "@shared/receipts";
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
  FillReceipt
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
  applySettlement({ batch, fillPlan, vaultStateBeforeSettlement: vault, reservationBookBeforeSettlement: book });
  const fillReceipts = buildFillReceipts({
    batch,
    fillPlan,
    reservationBook: book,
    runtime: RUNTIME,
    engineKey: ENGINE_PK
  });
  return { batch, fillPlan, vault, book, fillReceipts };
}

describe("verifyFillReceipt — happy paths", () => {
  it("each demo fill receipt verifies ok", () => {
    const d = demoState();
    for (const fr of d.fillReceipts) {
      const r = verifyFillReceipt({
        receipt: fr,
        batch: d.batch,
        fillPlan: d.fillPlan,
        reservationBookBeforeSettlement: d.book,
        expectedEngineAddress: ENGINE_ADDR
      });
      expect(r).toEqual({ ok: true });
    }
  });
});

describe("verifyFillReceipt — signer", () => {
  it("wrong expectedEngineAddress -> ENGINE_SIGNER_MISMATCH", () => {
    const d = demoState();
    const r = verifyFillReceipt({
      receipt: d.fillReceipts[0]!,
      batch: d.batch,
      fillPlan: d.fillPlan,
      reservationBookBeforeSettlement: d.book,
      expectedEngineAddress: OTHER_ADDR
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("ENGINE_SIGNER_MISMATCH");
    }
  });

  it("flipping signature -> ENGINE_SIGNER_MISMATCH or FILL_SIGNATURE_INVALID", () => {
    const d = demoState();
    const fr = d.fillReceipts[0]!;
    const sig = fr.engine_signature;
    const flipped = (sig.slice(0, 4) +
      (sig[4] === "0" ? "1" : "0") +
      sig.slice(5)) as `0x${string}`;
    const r = verifyFillReceipt({
      receipt: { ...fr, engine_signature: flipped },
      batch: d.batch,
      fillPlan: d.fillPlan,
      reservationBookBeforeSettlement: d.book,
      expectedEngineAddress: ENGINE_ADDR
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      expect(
        codes.includes("ENGINE_SIGNER_MISMATCH") ||
          codes.includes("FILL_SIGNATURE_INVALID")
      ).toBe(true);
    }
  });
});

describe("verifyFillReceipt — field tampering", () => {
  it.each([
    ["filled_base", { filled_base: "9" as const }],
    ["filled_quote", { filled_quote: "0" as const }],
    ["constraints_satisfied", { constraints_satisfied: false }],
    ["payload_commitment", { payload_commitment: ("0x" + "f".repeat(64)) as `0x${string}` }]
  ])("mutating %s -> ENGINE_SIGNER_MISMATCH AND FILL_RECEIPT_FIELD_MISMATCH", (field, override) => {
    const d = demoState();
    const fr = d.fillReceipts[0]!;
    const tampered: FillReceipt = { ...fr, ...(override as Partial<FillReceipt>) };
    const r = verifyFillReceipt({
      receipt: tampered,
      batch: d.batch,
      fillPlan: d.fillPlan,
      reservationBookBeforeSettlement: d.book,
      expectedEngineAddress: ENGINE_ADDR
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      const paths = r.failures.map((f) => f.path);
      expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
      expect(codes).toContain("FILL_RECEIPT_FIELD_MISMATCH");
      expect(paths).toContain(`/${field}`);
    }
  });

  it("mutating reserved_released.ETH -> FILL_RECEIPT_FIELD_MISMATCH /reserved_released/ETH", () => {
    const d = demoState();
    const fr = d.fillReceipts[0]!;
    const tampered: FillReceipt = {
      ...fr,
      reserved_released: { ETH: "999", USDC: fr.reserved_released.USDC }
    };
    const r = verifyFillReceipt({
      receipt: tampered,
      batch: d.batch,
      fillPlan: d.fillPlan,
      reservationBookBeforeSettlement: d.book,
      expectedEngineAddress: ENGINE_ADDR
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fieldFailures = r.failures.filter((f) => f.code === "FILL_RECEIPT_FIELD_MISMATCH");
      expect(fieldFailures.some((f) => f.path === "/reserved_released/ETH")).toBe(
        true
      );
    }
  });
});

describe("verifyFillReceipt — runtime coherence", () => {
  it("EIGEN_TEE with null eigen fields -> RUNTIME_COHERENCE_INVALID", () => {
    const d = demoState();
    const fr = d.fillReceipts[0]!;
    const tampered: FillReceipt = {
      ...fr,
      runtime: {
        ...fr.runtime,
        runtime_mode: "EIGEN_TEE"
      }
    };
    const r = verifyFillReceipt({
      receipt: tampered,
      batch: d.batch,
      fillPlan: d.fillPlan,
      reservationBookBeforeSettlement: d.book,
      expectedEngineAddress: ENGINE_ADDR
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const coherence = r.failures.filter(
        (f) => f.code === "RUNTIME_COHERENCE_INVALID"
      );
      expect(coherence.length).toBe(3);
    }
  });
});
