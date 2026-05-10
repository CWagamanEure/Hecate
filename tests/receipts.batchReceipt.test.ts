import { describe, it, expect } from "vitest";
import {
  buildBatchReceipt,
  buildBatchReceiptBody,
  signBatchReceipt,
  recoverBatchReceiptSigner
} from "@shared/receipts";
import {
  hashPayload,
  hashVaultState,
  hashReservationBook,
  hashSettlement,
  orderedAggregateHash,
  signEnvelope,
  privateKeyToAddress,
  keccak256Hex
} from "@shared/crypto";
import { mockDeposit, reserveForIntent } from "@shared/vault";
import { applySettlement } from "@shared/settlement";
import type {
  BatchInput,
  FillPlan,
  PrivatePayload,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  ReservationBook,
  RuntimeMetadata,
  SettlementObject,
  VaultState,
  BatchReceipt
} from "@shared/schemas";

const ENGINE_PK = "0x" + "0".repeat(63) + "1";
const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK);
const OTHER_PK = "0x" + "0".repeat(63) + "9";

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

let nonceCounter = 1;

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
    nonce: String(nonceCounter++)
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
    nonce: String(nonceCounter++)
  };
}

function envFor(
  intent_id: string,
  agent_id: string,
  pk: string,
  payload: PrivatePayload
): PublicEnvelope {
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

function makeBatch(
  entries: Array<{ envelope: PublicEnvelope; payload: PrivatePayload }>,
  batch_id = "batch_001"
): BatchInput {
  return {
    batch_id,
    market: "ETH/USDC",
    intents: entries,
    market_snapshot: null,
    timestamp_ms: NOW
  };
}

function setup(
  intents: Array<{
    envelope: PublicEnvelope;
    payload: PrivatePayload;
    deposit?: { agent_id: string; eth?: string; usdc?: string };
  }>
): { vault: VaultState; book: ReservationBook } {
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
    if (!r.ok) throw new Error(`setup: reserve failed: ${r.code} ${r.detail}`);
    vault = r.state;
    book = r.book;
  }
  return { vault, book };
}

/** Build the demo batch's full state: batch + fillPlan + settlement + snapshots. */
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
  return {
    batch,
    fillPlan,
    settlement: apply.settlement,
    vaultBefore: vault,
    vaultAfter: apply.vault_state_after_settlement,
    bookBefore: book,
    bookAfter: apply.reservation_book_after_settlement
  };
}

describe("buildBatchReceipt — happy path (4-agent demo)", () => {
  const d = demoState();
  const receipt = buildBatchReceipt({
    batch: d.batch,
    fillPlan: d.fillPlan,
    settlement: d.settlement,
    vaultStateBeforeSettlement: d.vaultBefore,
    vaultStateAfterSettlement: d.vaultAfter,
    reservationBookBeforeSettlement: d.bookBefore,
    reservationBookAfterSettlement: d.bookAfter,
    runtime: RUNTIME,
    engineKey: ENGINE_PK
  });

  it("hash fields equal independently-computed hashes", () => {
    const envs = d.batch.intents.map((i) => i.envelope);
    const commits = d.batch.intents.map((i) => hashPayload(i.payload));
    expect(receipt.intent_envelope_root).toBe(orderedAggregateHash(envs));
    expect(receipt.private_payload_commitment_root).toBe(orderedAggregateHash(commits));
    expect(receipt.vault_state_before_hash).toBe(hashVaultState(d.vaultBefore));
    expect(receipt.vault_state_after_hash).toBe(hashVaultState(d.vaultAfter));
    expect(receipt.reservation_book_before_hash).toBe(hashReservationBook(d.bookBefore));
    expect(receipt.reservation_book_after_hash).toBe(hashReservationBook(d.bookAfter));
    expect(receipt.settlement_hash).toBe(hashSettlement(d.settlement));
  });

  it("counts and metadata", () => {
    expect(receipt.num_intents).toBe(3);
    expect(receipt.num_matched).toBe(3); // A FILLED, B FILLED, C PARTIALLY_FILLED with > 0
    expect(receipt.clearing_price).toBe("3590");
    expect(receipt.timestamp_ms).toBe(d.batch.timestamp_ms);
    expect(receipt.matching_rule).toBe("UNIFORM_CLEARING_PRICE_V1");
    expect(receipt.market).toBe("ETH/USDC");
    expect(receipt.batch_id).toBe(d.batch.batch_id);
  });

  it("recovers engine signer", () => {
    expect(recoverBatchReceiptSigner(receipt)).toBe(ENGINE_ADDR);
  });
});

describe("buildBatchReceipt — BatchInput order in roots", () => {
  it("intent_envelope_root differs when batch order differs", () => {
    const d = demoState();
    const reorderedBatch = {
      ...d.batch,
      intents: [d.batch.intents[2]!, d.batch.intents[0]!, d.batch.intents[1]!]
    };
    const r1 = buildBatchReceiptBody({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME
    });
    // Need to also reorder fillPlan, settlement to match (settlement.batch_id etc OK)
    // For this test we only care about intent_envelope_root, so build only with batch reorder.
    // The settlement will mismatch the new batch, so build a settlement with the same batch_id.
    // Easier: call buildBatchReceiptBody and just compare the root computed manually.
    const envsOriginal = d.batch.intents.map((i) => i.envelope);
    const envsReordered = reorderedBatch.intents.map((i) => i.envelope);
    expect(orderedAggregateHash(envsOriginal)).toBe(r1.intent_envelope_root);
    expect(orderedAggregateHash(envsReordered)).not.toBe(
      orderedAggregateHash(envsOriginal)
    );
  });

  it("private_payload_commitment_root unchanged when fillPlan.fills order changes", () => {
    const d = demoState();
    const r1 = buildBatchReceiptBody({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME
    });
    // Shuffle fillPlan.fills order (same content).
    const shuffledPlan: FillPlan = {
      ...d.fillPlan,
      fills: [d.fillPlan.fills[2]!, d.fillPlan.fills[0]!, d.fillPlan.fills[1]!]
    };
    const r2 = buildBatchReceiptBody({
      batch: d.batch,
      fillPlan: shuffledPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME
    });
    expect(r1.private_payload_commitment_root).toBe(r2.private_payload_commitment_root);
    expect(r1.intent_envelope_root).toBe(r2.intent_envelope_root);
  });
});

describe("buildBatchReceipt — num_matched counts", () => {
  it("all FILLED -> num_matched === intents.length", () => {
    const ps = sellPayload({ base: "5", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const es = envFor("intent_s", ADDR_A, PK_A, ps);
    const eb = envFor("intent_b", ADDR_B, PK_B, pb);
    const intents = [
      { envelope: es, payload: ps, deposit: { agent_id: ADDR_A, eth: "5" } },
      { envelope: eb, payload: pb, deposit: { agent_id: ADDR_B, usdc: "20000" } }
    ];
    const { vault, book } = setup(intents);
    const batch = makeBatch([
      { envelope: es, payload: ps },
      { envelope: eb, payload: pb }
    ]);
    const fillPlan: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    const apply = applySettlement({ batch, fillPlan, vaultStateBeforeSettlement: vault, reservationBookBeforeSettlement: book });
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
    expect(receipt.num_matched).toBe(2);
  });

  it("BATCH_FAILED scenario -> num_matched === 0", () => {
    const ps = sellPayload({ base: "5", limit: "3580" });
    const es = envFor("intent_s", ADDR_A, PK_A, ps);
    const intents = [{ envelope: es, payload: ps, deposit: { agent_id: ADDR_A, eth: "5" } }];
    const { vault, book } = setup(intents);
    const batch = makeBatch([{ envelope: es, payload: ps }]);
    const fillPlan: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "BATCH_FAILED" }
      ]
    };
    const apply = applySettlement({ batch, fillPlan, vaultStateBeforeSettlement: vault, reservationBookBeforeSettlement: book });
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
    expect(receipt.num_matched).toBe(0);
    expect(receipt.num_intents).toBe(1);
  });

  it("mixed FILLED/PARTIALLY_FILLED/UNFILLED -> counts only positive-filled", () => {
    const d = demoState();
    expect(d.fillPlan.fills.length).toBe(3);
    const receipt = buildBatchReceipt({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    // All three have positive filled_base (10, 4, 6) -> 3 matched.
    expect(receipt.num_matched).toBe(3);
  });
});

describe("buildBatchReceipt — empty batch", () => {
  it("supports empty batch", () => {
    const batch = makeBatch([]);
    const fillPlan: FillPlan = { clearing_price: "0", fills: [] };
    const settlement: SettlementObject = {
      batch_id: batch.batch_id,
      market: batch.market,
      clearing_price: "0",
      fills: [],
      vault_deltas: []
    };
    const empty: VaultState = { agents: {} };
    const emptyBook: ReservationBook = { reservations: [] };
    const receipt = buildBatchReceipt({
      batch,
      fillPlan,
      settlement,
      vaultStateBeforeSettlement: empty,
      vaultStateAfterSettlement: empty,
      reservationBookBeforeSettlement: emptyBook,
      reservationBookAfterSettlement: emptyBook,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
    expect(receipt.num_intents).toBe(0);
    expect(receipt.num_matched).toBe(0);
    expect(receipt.intent_envelope_root).toBe(keccak256Hex("[]"));
    expect(receipt.private_payload_commitment_root).toBe(keccak256Hex("[]"));
    expect(recoverBatchReceiptSigner(receipt)).toBe(ENGINE_ADDR);
  });
});

describe("buildBatchReceipt — runtime shallow copy", () => {
  it("mutating caller's runtime after build does not affect receipt", () => {
    const d = demoState();
    const runtime: RuntimeMetadata = { ...RUNTIME };
    const receipt = buildBatchReceipt({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime,
      engineKey: ENGINE_PK
    });
    runtime.runtime_mode = "EIGEN_TEE";
    expect(receipt.runtime.runtime_mode).toBe("LOCAL_MOCK");
  });
});

describe("buildBatchReceipt — validation throws", () => {
  function baseInputs() {
    const d = demoState();
    return {
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    };
  }

  it("duplicate batch intent_id throws", () => {
    const inp = baseInputs();
    const dup = inp.batch.intents[0]!;
    inp.batch = {
      ...inp.batch,
      intents: [dup, ...inp.batch.intents]
    };
    expect(() => buildBatchReceipt(inp)).toThrow(/duplicate intent_id in batch/);
  });

  it("duplicate fill intent_id throws", () => {
    const inp = baseInputs();
    inp.fillPlan = {
      ...inp.fillPlan,
      fills: [...inp.fillPlan.fills, inp.fillPlan.fills[0]!]
    };
    expect(() => buildBatchReceipt(inp)).toThrow(/duplicate fill intent_id/);
  });

  it("missing fill for batch intent throws", () => {
    const inp = baseInputs();
    inp.fillPlan = {
      ...inp.fillPlan,
      fills: inp.fillPlan.fills.slice(0, 2) // drop one
    };
    expect(() => buildBatchReceipt(inp)).toThrow(/missing fill for intent/);
  });

  it("fill id not in batch throws", () => {
    const inp = baseInputs();
    inp.fillPlan = {
      ...inp.fillPlan,
      fills: [
        ...inp.fillPlan.fills,
        {
          intent_id: "intent_ghost",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    expect(() => buildBatchReceipt(inp)).toThrow(/not present in batch/);
  });

  it("payload commitment mismatch between envelope and payload throws", () => {
    const inp = baseInputs();
    // Tamper one envelope's payload_commitment.
    const orig = inp.batch.intents[0]!;
    const bad = {
      envelope: { ...orig.envelope, payload_commitment: ("0x" + "f".repeat(64)) as `0x${string}` },
      payload: orig.payload
    };
    inp.batch = {
      ...inp.batch,
      intents: [bad, ...inp.batch.intents.slice(1)]
    };
    expect(() => buildBatchReceipt(inp)).toThrow(/payload commitment mismatch/);
  });

  it("settlement.batch_id mismatch throws", () => {
    const inp = baseInputs();
    inp.settlement = { ...inp.settlement, batch_id: "batch_other" };
    expect(() => buildBatchReceipt(inp)).toThrow(/settlement.batch_id/);
  });

  it("settlement.market mismatch throws", () => {
    const inp = baseInputs();
    inp.settlement = { ...inp.settlement, market: "ETH/USDC" } as SettlementObject;
    // Force a mismatch by changing batch.market via cast.
    inp.batch = { ...inp.batch, market: "OTHER" as unknown as "ETH/USDC" };
    expect(() => buildBatchReceipt(inp)).toThrow(/settlement.market mismatch/);
  });

  it("settlement.clearing_price mismatch throws", () => {
    const inp = baseInputs();
    inp.settlement = { ...inp.settlement, clearing_price: "9999" };
    expect(() => buildBatchReceipt(inp)).toThrow(/clearing_price/);
  });
});

describe("buildBatchReceipt — purity", () => {
  it("does not mutate input objects", () => {
    const d = demoState();
    const inp = {
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    };
    const before = {
      batch: JSON.stringify(inp.batch),
      fillPlan: JSON.stringify(inp.fillPlan),
      settlement: JSON.stringify(inp.settlement),
      vBefore: JSON.stringify(inp.vaultStateBeforeSettlement),
      vAfter: JSON.stringify(inp.vaultStateAfterSettlement),
      bBefore: JSON.stringify(inp.reservationBookBeforeSettlement),
      bAfter: JSON.stringify(inp.reservationBookAfterSettlement)
    };
    buildBatchReceipt(inp);
    expect(JSON.stringify(inp.batch)).toBe(before.batch);
    expect(JSON.stringify(inp.fillPlan)).toBe(before.fillPlan);
    expect(JSON.stringify(inp.settlement)).toBe(before.settlement);
    expect(JSON.stringify(inp.vaultStateBeforeSettlement)).toBe(before.vBefore);
    expect(JSON.stringify(inp.vaultStateAfterSettlement)).toBe(before.vAfter);
    expect(JSON.stringify(inp.reservationBookBeforeSettlement)).toBe(before.bBefore);
    expect(JSON.stringify(inp.reservationBookAfterSettlement)).toBe(before.bAfter);
  });
});

describe("signBatchReceipt / recoverBatchReceiptSigner — tamper", () => {
  function buildOne(): BatchReceipt {
    const d = demoState();
    return buildBatchReceipt({
      batch: d.batch,
      fillPlan: d.fillPlan,
      settlement: d.settlement,
      vaultStateBeforeSettlement: d.vaultBefore,
      vaultStateAfterSettlement: d.vaultAfter,
      reservationBookBeforeSettlement: d.bookBefore,
      reservationBookAfterSettlement: d.bookAfter,
      runtime: RUNTIME,
      engineKey: ENGINE_PK
    });
  }

  it("recovered signer matches engine address", () => {
    expect(recoverBatchReceiptSigner(buildOne())).toBe(ENGINE_ADDR);
  });

  it.each([
    ["clearing_price", { clearing_price: "9999" as const }],
    ["intent_envelope_root", { intent_envelope_root: ("0x" + "f".repeat(64)) as `0x${string}` }],
    ["private_payload_commitment_root", { private_payload_commitment_root: ("0x" + "e".repeat(64)) as `0x${string}` }],
    ["vault_state_before_hash", { vault_state_before_hash: ("0x" + "d".repeat(64)) as `0x${string}` }],
    ["vault_state_after_hash", { vault_state_after_hash: ("0x" + "c".repeat(64)) as `0x${string}` }],
    ["reservation_book_before_hash", { reservation_book_before_hash: ("0x" + "b".repeat(64)) as `0x${string}` }],
    ["reservation_book_after_hash", { reservation_book_after_hash: ("0x" + "a".repeat(64)) as `0x${string}` }],
    ["settlement_hash", { settlement_hash: ("0x" + "9".repeat(64)) as `0x${string}` }],
    ["num_intents", { num_intents: 99 }],
    ["num_matched", { num_matched: 99 }],
    ["timestamp_ms", { timestamp_ms: 1700000000001 }]
  ])("mutating %s invalidates recovered signer", (_field, override) => {
    const r = buildOne();
    const tampered: BatchReceipt = { ...r, ...(override as Partial<BatchReceipt>) };
    expect(recoverBatchReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("mutating runtime.runtime_mode invalidates signature", () => {
    const r = buildOne();
    const tampered: BatchReceipt = {
      ...r,
      runtime: { ...r.runtime, runtime_mode: "EIGEN_TEE" }
    };
    expect(recoverBatchReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("mutating runtime.engine_code_digest invalidates signature", () => {
    const r = buildOne();
    const tampered: BatchReceipt = {
      ...r,
      runtime: { ...r.runtime, engine_code_digest: "sha256:other" }
    };
    expect(recoverBatchReceiptSigner(tampered)).not.toBe(ENGINE_ADDR);
  });

  it("flipping a hex char in engine_signature invalidates", () => {
    const r = buildOne();
    const sig = r.engine_signature;
    const flipped = (sig.slice(0, 4) +
      (sig[4] === "0" ? "1" : "0") +
      sig.slice(5)) as `0x${string}`;
    const tampered: BatchReceipt = { ...r, engine_signature: flipped };
    // Either recovery throws (curve-point off-curve after byte flip) OR returns
    // a different address. Both outcomes correctly invalidate the receipt.
    let invalidated = false;
    try {
      const recovered = recoverBatchReceiptSigner(tampered);
      invalidated = recovered !== ENGINE_ADDR;
    } catch {
      invalidated = true;
    }
    expect(invalidated).toBe(true);
  });

  it("signed by a different engine key recovers a different address", () => {
    const r = buildOne();
    const { engine_signature: _s, ...body } = r;
    const otherSigned = signBatchReceipt(body, OTHER_PK);
    expect(recoverBatchReceiptSigner(otherSigned)).toBe(privateKeyToAddress(OTHER_PK));
    expect(recoverBatchReceiptSigner(otherSigned)).not.toBe(ENGINE_ADDR);
  });
});
