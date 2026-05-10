import { describe, it, expect } from "vitest";
import {
  buildFillReceipts,
  signFillReceipt,
  recoverFillReceiptSigner
} from "@shared/receipts";
import {
  hashPayload,
  privateKeyToAddress,
  signHash,
  recoverHashSigner,
  hashFillReceiptBody
} from "@shared/crypto";
import type {
  BatchInput,
  FillPlan,
  PrivatePayload,
  PublicEnvelope,
  ReservationBook,
  RuntimeMetadata,
  FillReceipt,
  FillReceiptBody
} from "@shared/schemas";

const ENGINE_PK = "0x" + "0".repeat(63) + "1";
const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK);
const OTHER_PK = "0x" + "0".repeat(63) + "2";

const AGENT_A = "0x" + "A".repeat(40);
const AGENT_B = "0x" + "B".repeat(40);

const RUNTIME: RuntimeMetadata = {
  runtime_mode: "LOCAL_MOCK",
  engine_code_digest: "sha256:dev-local",
  eigencompute_app_id: null,
  eigencompute_image_digest: null,
  eigencompute_attestation_id: null
};

let nonceCounter = 1;

function sellPayload(overrides: Partial<PrivatePayload> = {}): PrivatePayload {
  return {
    side: "SELL",
    asset_in: "ETH",
    asset_out: "USDC",
    max_base_amount: "10",
    limit_price: "3580",
    allow_partial_fill: true,
    min_base_fill_amount: "3",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonceCounter++),
    ...overrides
  };
}

function buyPayload(overrides: Partial<PrivatePayload> = {}): PrivatePayload {
  return {
    side: "BUY",
    asset_in: "USDC",
    asset_out: "ETH",
    max_base_amount: "4",
    limit_price: "3610",
    allow_partial_fill: true,
    min_base_fill_amount: "1",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonceCounter++),
    ...overrides
  };
}

function makeEnvelope(
  intent_id: string,
  agent_id: string,
  payload: PrivatePayload
): PublicEnvelope {
  return {
    intent_id,
    agent_id,
    market: "ETH/USDC",
    expiry_ms: 1770000000000,
    payload_commitment: hashPayload(payload),
    payload_ciphertext: "0xdead",
    nonce: payload.nonce,
    signature: ("0x" + "0".repeat(130)) as `0x${string}`
  };
}

function makeReservationBook(
  entries: Array<{ intent_id: string; agent_id: string; asset: "ETH" | "USDC"; amount: string }>
): ReservationBook {
  return {
    reservations: entries.map((e) => ({
      intent_id: e.intent_id,
      agent_id: e.agent_id,
      asset: e.asset,
      amount: e.amount,
      status: "RESERVED" as const,
      created_ms: 1700000000000
    }))
  };
}

function makeBatch(
  intents: Array<{ envelope: PublicEnvelope; payload: PrivatePayload }>,
  batch_id = "batch_001"
): BatchInput {
  return {
    batch_id,
    market: "ETH/USDC",
    intents,
    market_snapshot: null,
    timestamp_ms: 1700000000000
  };
}

describe("buildFillReceipts — happy paths", () => {
  it("FILLED SELL emits receipt with zero reserved_released and constraints_satisfied=true", () => {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "10",
          filled_quote: "35900",
          status: "FILLED",
          unfilled_reason: null
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts).toHaveLength(1);
    const r = receipts[0]!;
    expect(r.status).toBe("FILLED");
    expect(r.filled_base).toBe("10");
    expect(r.filled_quote).toBe("35900");
    expect(r.reserved_released).toEqual({ ETH: "0", USDC: "0" });
    expect(r.constraints_satisfied).toBe(true);
    expect(r.unfilled_reason).toBeNull();
    expect(r.payload_commitment).toBe(hashPayload(p));
    expect(r.agent_id).toBe(AGENT_A);
    expect(r.batch_id).toBe("batch_001");
    expect(r.runtime).toEqual(RUNTIME);
    expect(recoverFillReceiptSigner(r)).toBe(ENGINE_ADDR);
  });

  it("FILLED BUY releases USDC dust when clearing < limit", () => {
    // BUY 4 ETH @ 3610 -> reservation = ceil(4*3610) = 14440.
    // Filled at clearing 3590 -> spent = floor(4*3590) = 14360.
    // Released USDC = 14440 - 14360 = 80.
    const p = buyPayload({ max_base_amount: "4", limit_price: "3610" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "4",
          filled_quote: "14360",
          status: "FILLED",
          unfilled_reason: null
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "USDC", amount: "14440" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    const r = receipts[0]!;
    expect(r.status).toBe("FILLED");
    expect(r.reserved_released).toEqual({ ETH: "0", USDC: "80" });
    expect(r.constraints_satisfied).toBe(true);
  });

  it("PARTIALLY_FILLED SELL releases unspent ETH", () => {
    const p = sellPayload({ max_base_amount: "10", min_base_fill_amount: "3" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "6",
          filled_quote: "21540",
          status: "PARTIALLY_FILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    const r = receipts[0]!;
    expect(r.status).toBe("PARTIALLY_FILLED");
    expect(r.reserved_released).toEqual({ ETH: "4", USDC: "0" });
    expect(r.constraints_satisfied).toBe(true);
    expect(r.unfilled_reason).toBe("INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT");
  });

  it("PARTIALLY_FILLED BUY releases unspent USDC", () => {
    // BUY 8 ETH @ 3590 -> reservation = ceil(8*3590) = 28720.
    // Filled 6 ETH @ 3590 -> spent = 21540. Released = 28720 - 21540 = 7180.
    const p = buyPayload({ max_base_amount: "8", limit_price: "3590", min_base_fill_amount: "1" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "6",
          filled_quote: "21540",
          status: "PARTIALLY_FILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "USDC", amount: "28720" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    const r = receipts[0]!;
    expect(r.reserved_released).toEqual({ ETH: "0", USDC: "7180" });
    expect(r.constraints_satisfied).toBe(true);
  });

  it("UNFILLED SELL releases full ETH reservation", () => {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    const r = receipts[0]!;
    expect(r.status).toBe("UNFILLED");
    expect(r.reserved_released).toEqual({ ETH: "10", USDC: "0" });
    expect(r.constraints_satisfied).toBe(true);
  });

  it("UNFILLED BUY releases full USDC reservation", () => {
    const p = buyPayload({ max_base_amount: "4", limit_price: "3610" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "USDC", amount: "14440" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    const r = receipts[0]!;
    expect(r.reserved_released).toEqual({ ETH: "0", USDC: "14440" });
    expect(r.constraints_satisfied).toBe(true);
  });

  it.each([
    "MIN_FILL_NOT_MET",
    "MAX_PRICE_IMPACT_VIOLATED",
    "EXPIRED_BEFORE_FILL"
  ] as const)("UNFILLED with reason %s -> constraints_satisfied=true", (reason) => {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: reason
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts[0]!.constraints_satisfied).toBe(true);
  });
});

describe("buildFillReceipts — defensive constraints_satisfied=false", () => {
  it("UNFILLED with BATCH_FAILED -> false", () => {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "BATCH_FAILED"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts[0]!.constraints_satisfied).toBe(false);
  });

  it("UNFILLED with null unfilled_reason -> false", () => {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: null
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts[0]!.constraints_satisfied).toBe(false);
  });

  it("FILLED with filled_base != max_base_amount -> false (defensive)", () => {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "9",
          filled_quote: "32310",
          status: "FILLED",
          unfilled_reason: null
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts[0]!.constraints_satisfied).toBe(false);
  });

  it("PARTIALLY_FILLED with filled_base < min_base_fill_amount -> false", () => {
    const p = sellPayload({ max_base_amount: "10", min_base_fill_amount: "5" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "2",
          filled_quote: "7180",
          status: "PARTIALLY_FILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts[0]!.constraints_satisfied).toBe(false);
  });
});

describe("buildFillReceipts — failure cases throw", () => {
  it("missing reservation throws", () => {
    const p = sellPayload();
    const env = makeEnvelope("intent_missing", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_missing",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    expect(() =>
      buildFillReceipts({
        batch,
        fillPlan,
        reservationBook: { reservations: [] },
        runtime: RUNTIME,
        engineKey: ENGINE_PK
      })
    ).toThrow(/no reservation/);
  });

  it("missing fill throws", () => {
    const p = sellPayload();
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = { clearing_price: "0", fills: [] };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    expect(() =>
      buildFillReceipts({
        batch,
        fillPlan,
        reservationBook: book,
        runtime: RUNTIME,
        engineKey: ENGINE_PK
      })
    ).toThrow(/missing fill/);
  });

  it("payload commitment mismatch throws", () => {
    const p = sellPayload();
    const env = {
      ...makeEnvelope("intent_001", AGENT_A, p),
      payload_commitment: ("0x" + "f".repeat(64)) as `0x${string}`
    };
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    expect(() =>
      buildFillReceipts({
        batch,
        fillPlan,
        reservationBook: book,
        runtime: RUNTIME,
        engineKey: ENGINE_PK
      })
    ).toThrow(/payload commitment mismatch/);
  });
});

describe("buildFillReceipts — output ordering and metadata", () => {
  it("emits receipts in batch.intents order", () => {
    const pa = sellPayload({ max_base_amount: "10", nonce: "n_a" });
    const pb = buyPayload({ max_base_amount: "5", limit_price: "3600", nonce: "n_b" });
    const ea = makeEnvelope("intent_a", AGENT_A, pa);
    const eb = makeEnvelope("intent_b", AGENT_B, pb);
    const batch = makeBatch([
      { envelope: ea, payload: pa },
      { envelope: eb, payload: pb }
    ]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        // intentionally out of order
        {
          intent_id: "intent_b",
          filled_base: "5",
          filled_quote: "17950",
          status: "FILLED",
          unfilled_reason: null
        },
        {
          intent_id: "intent_a",
          filled_base: "5",
          filled_quote: "17950",
          status: "PARTIALLY_FILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_a", agent_id: AGENT_A, asset: "ETH", amount: "10" },
      { intent_id: "intent_b", agent_id: AGENT_B, asset: "USDC", amount: "18000" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts.map((r) => r.intent_id)).toEqual(["intent_a", "intent_b"]);
    expect(receipts[0]!.agent_id).toBe(AGENT_A);
    expect(receipts[1]!.agent_id).toBe(AGENT_B);
  });

  it("status / unfilled_reason copied from FillPlan", () => {
    const p = sellPayload({ max_base_amount: "10", min_base_fill_amount: "5" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "MIN_FILL_NOT_MET"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipts[0]!.status).toBe("UNFILLED");
    expect(receipts[0]!.unfilled_reason).toBe("MIN_FILL_NOT_MET");
  });
});

describe("buildFillReceipts — runtime shallow copy", () => {
  it("mutating caller's runtime after build does not affect receipts", () => {
    const runtime: RuntimeMetadata = { ...RUNTIME };
    const p = sellPayload();
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const receipts = buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime,
      engineKey: ENGINE_PK
    });
    runtime.runtime_mode = "EIGEN_TEE";
    expect(receipts[0]!.runtime.runtime_mode).toBe("LOCAL_MOCK");
  });
});

describe("buildFillReceipts — purity", () => {
  it("does not mutate inputs", () => {
    const p = sellPayload();
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "10",
          filled_quote: "35900",
          status: "FILLED",
          unfilled_reason: null
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    const beforeBatch = JSON.stringify(batch);
    const beforeFill = JSON.stringify(fillPlan);
    const beforeBook = JSON.stringify(book);
    buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(JSON.stringify(batch)).toBe(beforeBatch);
    expect(JSON.stringify(fillPlan)).toBe(beforeFill);
    expect(JSON.stringify(book)).toBe(beforeBook);
  });
});

describe("signFillReceipt / recoverFillReceiptSigner", () => {
  function buildOne(): FillReceipt {
    const p = sellPayload({ max_base_amount: "10" });
    const env = makeEnvelope("intent_001", AGENT_A, p);
    const batch = makeBatch([{ envelope: env, payload: p }]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          filled_base: "10",
          filled_quote: "35900",
          status: "FILLED",
          unfilled_reason: null
        }
      ]
    };
    const book = makeReservationBook([
      { intent_id: "intent_001", agent_id: AGENT_A, asset: "ETH", amount: "10" }
    ]);
    return buildFillReceipts({
      batch,
      fillPlan,
      reservationBook: book,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    })[0]!;
  }

  it("recovered signer matches engine address", () => {
    const r = buildOne();
    expect(recoverFillReceiptSigner(r)).toBe(ENGINE_ADDR);
  });

  it("signFillReceipt round-trip via signHash/recoverHashSigner", () => {
    const body: FillReceiptBody = {
      intent_id: "x",
      batch_id: "batch_001",
      agent_id: AGENT_A,
      status: "UNFILLED",
      filled_base: "0",
      filled_quote: "0",
      clearing_price: "0",
      constraints_satisfied: true,
      unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT",
      payload_commitment: "0x" + "1".repeat(64),
      reserved_released: { ETH: "0", USDC: "0" },
      runtime: RUNTIME
    };
    const signed = signFillReceipt(body, ENGINE_PK);
    expect(recoverFillReceiptSigner(signed)).toBe(ENGINE_ADDR);
    // Cross-check via raw helpers
    const hash = hashFillReceiptBody(body);
    expect(recoverHashSigner(hash, signed.engine_signature)).toBe(ENGINE_ADDR);
    expect(signHash(hash, ENGINE_PK)).toBe(signed.engine_signature);
  });

  it.each([
    ["filled_base", { filled_base: "9" as const }],
    ["filled_quote", { filled_quote: "0" as const }],
    ["clearing_price", { clearing_price: "3591" as const }],
    ["payload_commitment", { payload_commitment: ("0x" + "f".repeat(64)) as `0x${string}` }],
    ["constraints_satisfied", { constraints_satisfied: false }],
    ["agent_id", { agent_id: AGENT_B }],
    ["status", { status: "UNFILLED" as const }]
  ])("mutating %s invalidates signature (recovered signer differs)", (_field, override) => {
    const r = buildOne();
    const tampered: FillReceipt = { ...r, ...(override as Partial<FillReceipt>) };
    expect(recoverFillReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("mutating reserved_released invalidates signature", () => {
    const r = buildOne();
    const tampered: FillReceipt = {
      ...r,
      reserved_released: { ETH: "1", USDC: "0" }
    };
    expect(recoverFillReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("mutating runtime.runtime_mode invalidates signature", () => {
    const r = buildOne();
    const tampered: FillReceipt = {
      ...r,
      runtime: { ...r.runtime, runtime_mode: "EIGEN_TEE" }
    };
    expect(recoverFillReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("mutating signature: recovered signer differs from engine address", () => {
    const r = buildOne();
    // Flip a hex char in r-component of the signature.
    const sig = r.engine_signature;
    const flipped = (sig.slice(0, 4) +
      (sig[4] === "0" ? "1" : "0") +
      sig.slice(5)) as `0x${string}`;
    const tampered: FillReceipt = { ...r, engine_signature: flipped };
    expect(recoverFillReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("signed by a different engine key recovers a different address", () => {
    const r = buildOne();
    const otherSigned = signFillReceipt(
      // strip signature, re-sign with OTHER_PK
      (() => {
        const { engine_signature: _s, ...body } = r;
        return body;
      })(),
      OTHER_PK
    );
    expect(recoverFillReceiptSigner(otherSigned)).toBe(
      privateKeyToAddress(OTHER_PK)
    );
    expect(recoverFillReceiptSigner(otherSigned)).not.toBe(ENGINE_ADDR);
  });
});
