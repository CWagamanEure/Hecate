import { describe, it, expect } from "vitest";
import { buildBatchFromReadyIntents } from "@shared/matching";
import type { ReadyIntent } from "@shared/matching";
import type { PrivatePayload, MarketSnapshot } from "@shared/schemas";

const samplePayload: PrivatePayload = {
  side: "SELL",
  asset_in: "ETH",
  asset_out: "USDC",
  max_base_amount: "10",
  limit_price: "3580",
  allow_partial_fill: true,
  min_base_fill_amount: "3",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: null,
  nonce: "1"
};

function readyIntent(
  intent_id: string,
  received_ms: number,
  agent_id = "0x" + "a".repeat(40)
): ReadyIntent {
  return {
    envelope: {
      intent_id,
      agent_id,
      market: "ETH/USDC",
      expiry_ms: 1770000000000,
      payload_commitment: "0x" + "b".repeat(64),
      payload_ciphertext: "0xdeadbeef",
      nonce: intent_id, // unique per test
      signature: ("0x" + "0".repeat(130)) as `0x${string}`
    },
    payload: samplePayload,
    received_ms,
    reservation_id: intent_id
  };
}

describe("buildBatchFromReadyIntents — empty input", () => {
  it("returns batch_input=null and empty accepted_intent_ids", () => {
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [],
      now_ms: 1700000000000,
      market_snapshot: null
    });
    expect(r.batch_input).toBeNull();
    expect(r.accepted_intent_ids).toEqual([]);
  });
});

describe("buildBatchFromReadyIntents — ordering", () => {
  it("sorts by received_ms ascending", () => {
    const a = readyIntent("intent_a", 3000);
    const b = readyIntent("intent_b", 1000);
    const c = readyIntent("intent_c", 2000);
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [a, b, c],
      now_ms: 1700000000000,
      market_snapshot: null
    });
    expect(r.accepted_intent_ids).toEqual(["intent_b", "intent_c", "intent_a"]);
    expect(r.batch_input!.intents.map((x) => x.envelope.intent_id)).toEqual([
      "intent_b",
      "intent_c",
      "intent_a"
    ]);
  });

  it("breaks ties by intent_id lex order", () => {
    const a = readyIntent("intent_c", 1000);
    const b = readyIntent("intent_a", 1000);
    const c = readyIntent("intent_b", 1000);
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [a, b, c],
      now_ms: 1700000000000,
      market_snapshot: null
    });
    expect(r.accepted_intent_ids).toEqual(["intent_a", "intent_b", "intent_c"]);
  });

  it("output order is deterministic regardless of input order", () => {
    const items = [
      readyIntent("intent_a", 1000),
      readyIntent("intent_b", 2000),
      readyIntent("intent_c", 1000)
    ];
    const r1 = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: items,
      now_ms: 1700000000000,
      market_snapshot: null
    });
    const r2 = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [...items].reverse(),
      now_ms: 1700000000000,
      market_snapshot: null
    });
    expect(r1.accepted_intent_ids).toEqual(r2.accepted_intent_ids);
  });
});

describe("buildBatchFromReadyIntents — BatchInput shape", () => {
  it("intents field contains only { envelope, payload }", () => {
    const a = readyIntent("intent_a", 1000);
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [a],
      now_ms: 1700000000000,
      market_snapshot: null
    });
    const intent = r.batch_input!.intents[0]!;
    expect(Object.keys(intent).sort()).toEqual(["envelope", "payload"]);
    expect(intent.envelope).toBe(a.envelope);
    expect(intent.payload).toBe(a.payload);
  });

  it("batch_id and timestamp_ms set from input", () => {
    const a = readyIntent("intent_a", 1000);
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_007",
      readyIntents: [a],
      now_ms: 1234567890000,
      market_snapshot: null
    });
    expect(r.batch_input!.batch_id).toBe("batch_007");
    expect(r.batch_input!.timestamp_ms).toBe(1234567890000);
  });

  it("market_snapshot null passed through", () => {
    const a = readyIntent("intent_a", 1000);
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [a],
      now_ms: 1700000000000,
      market_snapshot: null
    });
    expect(r.batch_input!.market_snapshot).toBeNull();
  });

  it("market_snapshot value passed through", () => {
    const snap: MarketSnapshot = {
      market: "ETH/USDC",
      reference_price: "3590.00",
      timestamp_ms: 1700000000000
    };
    const a = readyIntent("intent_a", 1000);
    const r = buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: [a],
      now_ms: 1700000000000,
      market_snapshot: snap
    });
    expect(r.batch_input!.market_snapshot).toEqual(snap);
  });
});

describe("buildBatchFromReadyIntents — purity", () => {
  it("does not mutate input array", () => {
    const items = [readyIntent("intent_b", 2000), readyIntent("intent_a", 1000)];
    const before = items.map((i) => i.envelope.intent_id).join(",");
    buildBatchFromReadyIntents({
      batch_id: "batch_001",
      readyIntents: items,
      now_ms: 1700000000000,
      market_snapshot: null
    });
    const after = items.map((i) => i.envelope.intent_id).join(",");
    expect(after).toBe(before);
  });
});
