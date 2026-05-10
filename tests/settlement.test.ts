import { describe, it, expect } from "vitest";
import {
  buildSettlementObject,
  applySettlement
} from "@shared/settlement";
import { hashSettlement, hashPayload, normalizeAddress } from "@shared/crypto";
import { mockDeposit, reserveForIntent } from "@shared/vault";
import { signEnvelope, privateKeyToAddress } from "@shared/crypto";
import type {
  BatchInput,
  FillPlan,
  PrivatePayload,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  ReservationBook,
  VaultState
} from "@shared/schemas";

const PK_A = "0x" + "0".repeat(63) + "1";
const PK_B = "0x" + "0".repeat(63) + "2";
const PK_C = "0x" + "0".repeat(63) + "3";
const ADDR_A = privateKeyToAddress(PK_A);
const ADDR_B = privateKeyToAddress(PK_B);
const ADDR_C = privateKeyToAddress(PK_C);
const NOW = 1700000000000;

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

/** Build (vault, book) by depositing balances and reserving each intent. */
function setup(
  intents: Array<{
    envelope: PublicEnvelope;
    payload: PrivatePayload;
    deposit?: { agent_id: string; eth?: string; usdc?: string };
  }>
): { vault: VaultState; book: ReservationBook } {
  let vault: VaultState = { agents: {} };
  // Deposits keyed by agent
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

describe("buildSettlementObject — symmetric scenarios", () => {
  it("one SELL + one BUY both FILLED at clearing 3590", () => {
    const ps = sellPayload({ base: "5", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const es = envFor("intent_s", ADDR_A, PK_A, ps);
    const eb = envFor("intent_b", ADDR_B, PK_B, pb);
    const batch = makeBatch([
      { envelope: es, payload: ps },
      { envelope: eb, payload: pb }
    ]);
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    const s = buildSettlementObject(batch, fp);
    expect(s.fills).toHaveLength(2);
    // settlement.fills order matches batch.intents order
    expect(s.fills.map((f) => f.intent_id)).toEqual(["intent_s", "intent_b"]);
    // SELL agent: -5 ETH, +17950 USDC
    expect(s.fills[0]!.base_delta).toBe("-5");
    expect(s.fills[0]!.quote_delta).toBe("17950");
    // BUY agent: +5 ETH, -17950 USDC
    expect(s.fills[1]!.base_delta).toBe("5");
    expect(s.fills[1]!.quote_delta).toBe("-17950");
    // 4 vault deltas, sorted by (agent_id, asset)
    expect(s.vault_deltas).toHaveLength(4);
    const sorted = [...s.vault_deltas].sort((a, b) => {
      if (a.agent_id !== b.agent_id) return a.agent_id < b.agent_id ? -1 : 1;
      return a.asset < b.asset ? -1 : 1;
    });
    expect(s.vault_deltas).toEqual(sorted);
  });
});

describe("buildSettlementObject — 4-agent demo", () => {
  it("A sells 10, B buys 4, C buys 6 partial at 3590", () => {
    const pa = sellPayload({ base: "10", limit: "3580" });
    const pb = buyPayload({ base: "4", limit: "3610" });
    const pc = buyPayload({ base: "8", limit: "3590", min: "1" });
    const ea = envFor("intent_A", ADDR_A, PK_A, pa);
    const eb = envFor("intent_B", ADDR_B, PK_B, pb);
    const ec = envFor("intent_C", ADDR_C, PK_C, pc);
    const batch = makeBatch([
      { envelope: ea, payload: pa },
      { envelope: eb, payload: pb },
      { envelope: ec, payload: pc }
    ]);
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_A", filled_base: "10", filled_quote: "35900", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_B", filled_base: "4", filled_quote: "14360", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_C", filled_base: "6", filled_quote: "21540", status: "PARTIALLY_FILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
      ]
    };
    const s = buildSettlementObject(batch, fp);
    expect(s.fills).toHaveLength(3);
    // 3 agents, 2 deltas each = 6 vault_deltas (ETH and USDC for each)
    expect(s.vault_deltas).toHaveLength(6);
    // Conservation
    const ethSum = s.vault_deltas
      .filter((d) => d.asset === "ETH")
      .reduce((acc, d) => acc + Number(d.delta), 0);
    const usdcSum = s.vault_deltas
      .filter((d) => d.asset === "USDC")
      .reduce((acc, d) => acc + Number(d.delta), 0);
    expect(ethSum).toBe(0);
    expect(usdcSum).toBe(0);
  });
});

describe("buildSettlementObject — aggregation by agent+asset", () => {
  it("same agent two SELLs aggregates into one ETH delta + one USDC delta", () => {
    const p1 = sellPayload({ base: "3", limit: "3580" });
    const p2 = sellPayload({ base: "4", limit: "3580" });
    const pBuy = buyPayload({ base: "7", limit: "3600" });
    const e1 = envFor("intent_a1", ADDR_A, PK_A, p1);
    const e2 = envFor("intent_a2", ADDR_A, PK_A, p2);
    const eBuy = envFor("intent_b", ADDR_B, PK_B, pBuy);
    const batch = makeBatch([
      { envelope: e1, payload: p1 },
      { envelope: e2, payload: p2 },
      { envelope: eBuy, payload: pBuy }
    ]);
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_a1", filled_base: "3", filled_quote: "10770", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_a2", filled_base: "4", filled_quote: "14360", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "7", filled_quote: "25130", status: "FILLED", unfilled_reason: null }
      ]
    };
    const s = buildSettlementObject(batch, fp);
    const aDeltas = s.vault_deltas.filter((d) => d.agent_id === ADDR_A);
    expect(aDeltas).toHaveLength(2);
    const aEth = aDeltas.find((d) => d.asset === "ETH")!;
    const aUsdc = aDeltas.find((d) => d.asset === "USDC")!;
    expect(aEth.delta).toBe("-7");      // -3 + -4
    expect(aUsdc.delta).toBe("25130");  // 10770 + 14360
  });
});

describe("buildSettlementObject — vault_deltas sort order", () => {
  it("sorts by (agent_id, asset) regardless of fill order", () => {
    // Use addresses where ADDR_A < ADDR_B in EIP-55 byte order
    const ps = sellPayload({ base: "5", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const es = envFor("intent_s", ADDR_B, PK_B, ps);    // SELL by AGENT_B
    const eb = envFor("intent_b", ADDR_A, PK_A, pb);     // BUY by AGENT_A
    const batch = makeBatch([
      { envelope: es, payload: ps },
      { envelope: eb, payload: pb }
    ]);
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    const s = buildSettlementObject(batch, fp);
    const seen = s.vault_deltas.map((d) => `${d.agent_id}|${d.asset}`);
    const sortedExpected = [...seen].sort();
    expect(seen).toEqual(sortedExpected);
  });
});

describe("buildSettlementObject — UNFILLED behavior", () => {
  it("UNFILLED intents do not produce fills or deltas", () => {
    const ps = sellPayload({ base: "5", limit: "3580" });
    const es = envFor("intent_s", ADDR_A, PK_A, ps);
    const batch = makeBatch([{ envelope: es, payload: ps }]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
      ]
    };
    const s = buildSettlementObject(batch, fp);
    expect(s.fills).toEqual([]);
    expect(s.vault_deltas).toEqual([]);
  });

  it("BATCH_FAILED produces empty settlement; conservation passes trivially", () => {
    const pa = sellPayload({ base: "10", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const ea = envFor("intent_a", ADDR_A, PK_A, pa);
    const eb = envFor("intent_b", ADDR_B, PK_B, pb);
    const batch = makeBatch([
      { envelope: ea, payload: pa },
      { envelope: eb, payload: pb }
    ]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_a", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "BATCH_FAILED" },
        { intent_id: "intent_b", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "BATCH_FAILED" }
      ]
    };
    const s = buildSettlementObject(batch, fp);
    expect(s.fills).toEqual([]);
    expect(s.vault_deltas).toEqual([]);
  });
});

describe("buildSettlementObject — empty batch", () => {
  it("empty batch returns settlement with empty fills and vault_deltas", () => {
    const batch = makeBatch([]);
    const fp: FillPlan = { clearing_price: "0", fills: [] };
    const s = buildSettlementObject(batch, fp);
    expect(s.fills).toEqual([]);
    expect(s.vault_deltas).toEqual([]);
  });
});

describe("buildSettlementObject — failure cases throw", () => {
  it("conservation violation throws (hand-crafted bad FillPlan)", () => {
    const ps = sellPayload({ base: "5", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const es = envFor("intent_s", ADDR_A, PK_A, ps);
    const eb = envFor("intent_b", ADDR_B, PK_B, pb);
    const batch = makeBatch([
      { envelope: es, payload: ps },
      { envelope: eb, payload: pb }
    ]);
    // Quote deltas don't balance: SELL gets +18000, BUY pays only -17950.
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "18000", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    expect(() => buildSettlementObject(batch, fp)).toThrow(/conservation/);
  });

  it("missing fill for batch intent throws", () => {
    const p = sellPayload({ base: "5", limit: "3580" });
    const e = envFor("intent_s", ADDR_A, PK_A, p);
    const batch = makeBatch([{ envelope: e, payload: p }]);
    const fp: FillPlan = { clearing_price: "0", fills: [] };
    expect(() => buildSettlementObject(batch, fp)).toThrow(/missing fill/);
  });

  it("duplicate fill intent_id throws", () => {
    const p = sellPayload({ base: "5", limit: "3580" });
    const e = envFor("intent_s", ADDR_A, PK_A, p);
    const batch = makeBatch([{ envelope: e, payload: p }]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" },
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
      ]
    };
    expect(() => buildSettlementObject(batch, fp)).toThrow(/duplicate fill/);
  });

  it("fill referencing intent_id not in batch throws", () => {
    const p = sellPayload({ base: "5", limit: "3580" });
    const e = envFor("intent_s", ADDR_A, PK_A, p);
    const batch = makeBatch([{ envelope: e, payload: p }]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" },
        { intent_id: "intent_other", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
      ]
    };
    expect(() => buildSettlementObject(batch, fp)).toThrow(/not present in batch/);
  });
});

describe("applySettlement — state transitions", () => {
  it("SELL+BUY at clearing 3590: balances and reservations updated correctly", () => {
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
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    const r = applySettlement({
      batch,
      fillPlan: fp,
      vaultStateBeforeSettlement: vault,
      reservationBookBeforeSettlement: book
    });
    // Balances
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.balances.ETH).toBe("0");
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.balances.USDC).toBe("17950");
    expect(r.vault_state_after_settlement.agents[ADDR_B]!.balances.ETH).toBe("5");
    expect(r.vault_state_after_settlement.agents[ADDR_B]!.balances.USDC).toBe("2050"); // 20000-(ceil(5*3600)=18000)+ ... wait

    // BUY reserved ceil(5 * 3600) = 18000 USDC. Deposit was 20000.
    // Pre-settlement: balances.USDC=20000, reserved.USDC=18000.
    // Apply: balances.USDC -= 17950 (actual spend) = 2050. reserved.USDC released to 0.
    expect(r.vault_state_after_settlement.agents[ADDR_B]!.reserved.USDC).toBe("0");
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.reserved.ETH).toBe("0");
    // Reservation statuses
    const sellRes = r.reservation_book_after_settlement.reservations.find(x => x.intent_id === "intent_s")!;
    const buyRes = r.reservation_book_after_settlement.reservations.find(x => x.intent_id === "intent_b")!;
    expect(sellRes.status).toBe("SETTLED");
    expect(buyRes.status).toBe("SETTLED");
  });

  it("UNFILLED releases reservation as RELEASED with no balance change", () => {
    const p = sellPayload({ base: "5", limit: "3580" });
    const e = envFor("intent_s", ADDR_A, PK_A, p);
    const intents = [
      { envelope: e, payload: p, deposit: { agent_id: ADDR_A, eth: "5" } }
    ];
    const { vault, book } = setup(intents);
    const batch = makeBatch([{ envelope: e, payload: p }]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
      ]
    };
    const r = applySettlement({
      batch,
      fillPlan: fp,
      vaultStateBeforeSettlement: vault,
      reservationBookBeforeSettlement: book
    });
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.balances.ETH).toBe("5");
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.reserved.ETH).toBe("0");
    expect(r.reservation_book_after_settlement.reservations[0]!.status).toBe("RELEASED");
  });

  it("BATCH_FAILED releases all reservations as RELEASED, no balance changes", () => {
    const pa = sellPayload({ base: "10", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const ea = envFor("intent_a", ADDR_A, PK_A, pa);
    const eb = envFor("intent_b", ADDR_B, PK_B, pb);
    const intents = [
      { envelope: ea, payload: pa, deposit: { agent_id: ADDR_A, eth: "10" } },
      { envelope: eb, payload: pb, deposit: { agent_id: ADDR_B, usdc: "20000" } }
    ];
    const { vault, book } = setup(intents);
    const batch = makeBatch([
      { envelope: ea, payload: pa },
      { envelope: eb, payload: pb }
    ]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_a", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "BATCH_FAILED" },
        { intent_id: "intent_b", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "BATCH_FAILED" }
      ]
    };
    const r = applySettlement({
      batch,
      fillPlan: fp,
      vaultStateBeforeSettlement: vault,
      reservationBookBeforeSettlement: book
    });
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.balances.ETH).toBe("10");
    expect(r.vault_state_after_settlement.agents[ADDR_A]!.reserved.ETH).toBe("0");
    expect(r.vault_state_after_settlement.agents[ADDR_B]!.balances.USDC).toBe("20000");
    expect(r.vault_state_after_settlement.agents[ADDR_B]!.reserved.USDC).toBe("0");
    expect(r.reservation_book_after_settlement.reservations.every((x) => x.status === "RELEASED")).toBe(true);
  });

  it("missing reservation throws (via releaseReservation)", () => {
    const p = sellPayload({ base: "5", limit: "3580" });
    const e = envFor("intent_s", ADDR_A, PK_A, p);
    // Vault has the agent but no reservation in the book.
    const vault = mockDeposit({ agents: {} }, ADDR_A, "ETH", "5");
    const batch = makeBatch([{ envelope: e, payload: p }]);
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        { intent_id: "intent_s", filled_base: "0", filled_quote: "0", status: "UNFILLED", unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" }
      ]
    };
    expect(() =>
      applySettlement({
        batch,
        fillPlan: fp,
        vaultStateBeforeSettlement: vault,
        reservationBookBeforeSettlement: { reservations: [] }
      })
    ).toThrow(/no reservation/);
  });
});

describe("applySettlement — purity", () => {
  it("does not mutate input vault, reservation book, batch, or fillPlan", () => {
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
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    const beforeVault = JSON.stringify(vault);
    const beforeBook = JSON.stringify(book);
    const beforeBatch = JSON.stringify(batch);
    const beforeFp = JSON.stringify(fp);
    applySettlement({
      batch,
      fillPlan: fp,
      vaultStateBeforeSettlement: vault,
      reservationBookBeforeSettlement: book
    });
    expect(JSON.stringify(vault)).toBe(beforeVault);
    expect(JSON.stringify(book)).toBe(beforeBook);
    expect(JSON.stringify(batch)).toBe(beforeBatch);
    expect(JSON.stringify(fp)).toBe(beforeFp);
  });
});

describe("hashSettlement sensitivity", () => {
  it("changes when any vault_delta delta changes", () => {
    const ps = sellPayload({ base: "5", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    const es = envFor("intent_s", ADDR_A, PK_A, ps);
    const eb = envFor("intent_b", ADDR_B, PK_B, pb);
    const batch = makeBatch([
      { envelope: es, payload: ps },
      { envelope: eb, payload: pb }
    ]);
    const fp: FillPlan = {
      clearing_price: "3590",
      fills: [
        { intent_id: "intent_s", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null },
        { intent_id: "intent_b", filled_base: "5", filled_quote: "17950", status: "FILLED", unfilled_reason: null }
      ]
    };
    const s1 = buildSettlementObject(batch, fp);
    const s2 = {
      ...s1,
      vault_deltas: s1.vault_deltas.map((d, i) =>
        i === 0 ? { ...d, delta: ("0" as const) } : d
      )
    };
    expect(hashSettlement(s1)).not.toBe(hashSettlement(s2));
  });
});
