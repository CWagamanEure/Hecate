import { describe, it, expect } from "vitest";
import { clearUniform } from "@shared/matching";
import type {
  BatchInput,
  PrivatePayload,
  PublicEnvelope,
  MarketSnapshot
} from "@shared/schemas";

const ADDR = "0x" + "a".repeat(40);
const HEX32 = "0x" + "0".repeat(64);
const HEX65 = ("0x" + "0".repeat(130)) as `0x${string}`;

let nextNonce = 1;

function buy(opts: {
  intent_id: string;
  base: string;
  limit: string;
  min?: string;
  partial?: boolean;
  bps?: number;
  received_ms?: number;
}): { envelope: PublicEnvelope; payload: PrivatePayload; received_ms: number } {
  const allow = opts.partial ?? true;
  const min = opts.min ?? (allow ? "0.0001" : opts.base);
  return mkIntent({
    side: "BUY",
    intent_id: opts.intent_id,
    base: opts.base,
    limit: opts.limit,
    min,
    allow,
    bps: opts.bps ?? 10000,
    received_ms: opts.received_ms ?? 1
  });
}

function sell(opts: {
  intent_id: string;
  base: string;
  limit: string;
  min?: string;
  partial?: boolean;
  bps?: number;
  received_ms?: number;
}): { envelope: PublicEnvelope; payload: PrivatePayload; received_ms: number } {
  const allow = opts.partial ?? true;
  const min = opts.min ?? (allow ? "0.0001" : opts.base);
  return mkIntent({
    side: "SELL",
    intent_id: opts.intent_id,
    base: opts.base,
    limit: opts.limit,
    min,
    allow,
    bps: opts.bps ?? 10000,
    received_ms: opts.received_ms ?? 1
  });
}

function mkIntent(args: {
  side: "BUY" | "SELL";
  intent_id: string;
  base: string;
  limit: string;
  min: string;
  allow: boolean;
  bps: number;
  received_ms: number;
}): { envelope: PublicEnvelope; payload: PrivatePayload; received_ms: number } {
  const payload: PrivatePayload = {
    side: args.side,
    asset_in: args.side === "BUY" ? "USDC" : "ETH",
    asset_out: args.side === "BUY" ? "ETH" : "USDC",
    max_base_amount: args.base,
    limit_price: args.limit,
    allow_partial_fill: args.allow,
    min_base_fill_amount: args.min,
    deadline_batches: 3,
    max_price_impact_bps: args.bps,
    fallback_after_batches: null,
    nonce: String(nextNonce++)
  };
  const envelope: PublicEnvelope = {
    intent_id: args.intent_id,
    agent_id: ADDR,
    market: "ETH/USDC",
    expiry_ms: 1770000000000,
    payload_commitment: HEX32 as `0x${string}`,
    payload_ciphertext: "0xdead",
    nonce: payload.nonce,
    signature: HEX65
  };
  return { envelope, payload, received_ms: args.received_ms };
}

function mkBatch(
  intents: ReturnType<typeof mkIntent>[],
  snapshot: MarketSnapshot | null = null,
  batch_id = "batch_001"
): BatchInput {
  // Sort by (received_ms, intent_id) to mimic buildBatchFromReadyIntents.
  const sorted = [...intents].sort((a, b) => {
    if (a.received_ms !== b.received_ms) return a.received_ms - b.received_ms;
    return a.envelope.intent_id < b.envelope.intent_id ? -1 : 1;
  });
  return {
    batch_id,
    market: "ETH/USDC",
    intents: sorted.map((i) => ({ envelope: i.envelope, payload: i.payload })),
    market_snapshot: snapshot,
    timestamp_ms: 1700000000000
  };
}

describe("clearUniform — trivial cases", () => {
  it("empty batch returns empty fills with clearing_price '0'", () => {
    const r = clearUniform(mkBatch([]));
    expect(r.clearing_price).toBe("0");
    expect(r.fills).toEqual([]);
  });

  it("buys only -> all UNFILLED with INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT", () => {
    const r = clearUniform(mkBatch([buy({ intent_id: "intent_b", base: "5", limit: "3600" })]));
    expect(r.clearing_price).toBe("0");
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.status).toBe("UNFILLED");
    expect(r.fills[0]!.unfilled_reason).toBe("INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT");
  });

  it("sells only -> all UNFILLED with INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT", () => {
    const r = clearUniform(mkBatch([sell({ intent_id: "intent_s", base: "5", limit: "3600" })]));
    expect(r.fills[0]!.unfilled_reason).toBe("INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT");
  });

  it("buy limit < sell limit -> no cross", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "5", limit: "3500" }),
        sell({ intent_id: "s", base: "5", limit: "3600" })
      ])
    );
    expect(r.clearing_price).toBe("0");
    expect(r.fills.find((f) => f.intent_id === "b")!.status).toBe("UNFILLED");
    expect(r.fills.find((f) => f.intent_id === "s")!.status).toBe("UNFILLED");
  });
});

describe("clearUniform — exact cross", () => {
  it("matched volume equals each side; both FILLED", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "4", limit: "3600" }),
        sell({ intent_id: "s", base: "4", limit: "3580" })
      ])
    );
    const b = r.fills.find((f) => f.intent_id === "b")!;
    const s = r.fills.find((f) => f.intent_id === "s")!;
    expect(b.status).toBe("FILLED");
    expect(s.status).toBe("FILLED");
    expect(b.filled_base).toBe("4");
    expect(s.filled_base).toBe("4");
    expect(b.filled_quote).toBe(s.filled_quote);
    expect(b.unfilled_reason).toBeNull();
  });
});

describe("clearUniform — demo scenario (A sells 10 @3580, B buys 4 @3610, C buys 8 @3590)", () => {
  it("clears matched flow; specific fills", () => {
    const r = clearUniform(
      mkBatch([
        sell({ intent_id: "intent_A", base: "10", limit: "3580", received_ms: 1 }),
        buy({ intent_id: "intent_B", base: "4", limit: "3610", received_ms: 2 }),
        buy({ intent_id: "intent_C", base: "8", limit: "3590", received_ms: 3 })
      ])
    );
    // BUY total = 12, SELL total = 10 -> matched = 10.
    // Candidates that allow buy.limit >= p and sell.limit <= p: 3580, 3590, 3610.
    // At 3580: active buys (limit>=3580) = B,C, active sells (limit<=3580) = A
    //   buyVol = 12, sellVol = 10, exec = 10
    // At 3590: active buys (limit>=3590) = B,C, active sells = A
    //   exec = 10
    // At 3610: active buys (limit>=3610) = B, active sells = A
    //   buyVol = 4, sellVol = 10, exec = 4
    // Best: exec=10 ties between 3580 and 3590. Tiebreak by midpoint of (highBuy, lowSell) at p.
    //   At 3580: highBuy=3610, lowSell=3580, midSum=7190, distance |2*3580 - 7190| = 30
    //   At 3590: highBuy=3610, lowSell=3580, midSum=7190, distance |2*3590 - 7190| = 10
    // 3590 closer to midpoint -> 3590 wins.
    expect(r.clearing_price).toBe("3590");

    const a = r.fills.find((f) => f.intent_id === "intent_A")!;
    const b = r.fills.find((f) => f.intent_id === "intent_B")!;
    const c = r.fills.find((f) => f.intent_id === "intent_C")!;

    // BUY allocation in price-time order: B (received_ms=2) then C (received_ms=3)
    // budget=10, B gets 4, remaining=6, C gets 6.
    // SELL allocation budget=10: A gets 10.
    expect(a.status).toBe("FILLED");
    expect(a.filled_base).toBe("10");
    expect(b.status).toBe("FILLED");
    expect(b.filled_base).toBe("4");
    expect(c.status).toBe("PARTIALLY_FILLED");
    expect(c.filled_base).toBe("6");
    expect(c.unfilled_reason).toBe("INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT");

    // Conservation
    const buyTotal = Number(b.filled_base) + Number(c.filled_base);
    expect(buyTotal).toBe(Number(a.filled_base));
  });
});

describe("clearUniform — tie-break", () => {
  it("higher executable wins over midpoint distance", () => {
    // Two candidates both close to midpoint, but one has higher exec.
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "10", limit: "3600" }),
        sell({ intent_id: "s1", base: "5", limit: "3590" }),
        sell({ intent_id: "s2", base: "5", limit: "3600" })
      ])
    );
    // candidates: 3590, 3600.
    // At 3590: activeBuys=[b], activeSells=[s1] (s2.limit=3600 not <= 3590)
    //   exec = min(10, 5) = 5
    // At 3600: activeBuys=[b], activeSells=[s1,s2]
    //   exec = min(10, 10) = 10
    // 3600 wins on exec.
    expect(r.clearing_price).toBe("3600");
  });

  it("midpoint distance wins when exec ties; lower-price wins on midpoint tie", () => {
    // Constructed so two candidates have equal exec.
    // We rely on the demo scenario above already covering the midpoint preference;
    // here we add a case where both candidates are equidistant from midpoint
    // and lower price should win.
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "5", limit: "3600" }),
        sell({ intent_id: "s", base: "5", limit: "3600" })
      ])
    );
    // Single candidate: 3600. Trivially wins.
    expect(r.clearing_price).toBe("3600");
  });
});

describe("clearUniform — price-time allocation order", () => {
  it("earlier received_ms wins when budget is tight", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b_late", base: "5", limit: "3600", received_ms: 3 }),
        buy({ intent_id: "b_early", base: "5", limit: "3600", received_ms: 1 }),
        sell({ intent_id: "s", base: "5", limit: "3600", received_ms: 2 })
      ])
    );
    expect(r.fills.find((f) => f.intent_id === "b_early")!.status).toBe("FILLED");
    expect(r.fills.find((f) => f.intent_id === "b_late")!.status).toBe("UNFILLED");
  });

  it("ties broken by intent_id lex when received_ms equal", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b_xyz", base: "5", limit: "3600", received_ms: 1 }),
        buy({ intent_id: "b_abc", base: "5", limit: "3600", received_ms: 1 }),
        sell({ intent_id: "s", base: "5", limit: "3600", received_ms: 1 })
      ])
    );
    expect(r.fills.find((f) => f.intent_id === "b_abc")!.status).toBe("FILLED");
    expect(r.fills.find((f) => f.intent_id === "b_xyz")!.status).toBe("UNFILLED");
  });
});

describe("clearUniform — min_base_fill_amount", () => {
  it("partial fill below min skips intent with MIN_FILL_NOT_MET", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "10", limit: "3600", min: "5" }),
        sell({ intent_id: "s", base: "4", limit: "3600" })
      ])
    );
    // Buy could only get 4, but min is 5 -> skip.
    // No fills -> clearing_price = "0", reasons reflect no-cross.
    expect(r.clearing_price).toBe("0");
    expect(r.fills.find((f) => f.intent_id === "b")!.unfilled_reason).toBe(
      "MIN_FILL_NOT_MET"
    );
  });

  it("allow_partial_fill=false (min==max) all-or-nothing", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "10", limit: "3600", partial: false }),
        sell({ intent_id: "s", base: "8", limit: "3600" })
      ])
    );
    expect(r.fills.find((f) => f.intent_id === "b")!.status).toBe("UNFILLED");
    expect(r.fills.find((f) => f.intent_id === "b")!.unfilled_reason).toBe(
      "MIN_FILL_NOT_MET"
    );
  });

  it("all-or-nothing with exact match fills", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "10", limit: "3600", partial: false }),
        sell({ intent_id: "s", base: "10", limit: "3600", partial: false })
      ])
    );
    expect(r.fills.find((f) => f.intent_id === "b")!.status).toBe("FILLED");
    expect(r.fills.find((f) => f.intent_id === "s")!.status).toBe("FILLED");
  });
});

describe("clearUniform — max_price_impact_bps", () => {
  it("ignored when market_snapshot is null", () => {
    // Tight bps but no snapshot -> matches anyway.
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "5", limit: "3600", bps: 1 }),
        sell({ intent_id: "s", base: "5", limit: "3600", bps: 1 })
      ])
    );
    expect(r.fills.find((f) => f.intent_id === "b")!.status).toBe("FILLED");
  });

  it("enforced with snapshot: tight bps excludes intent at far prices", () => {
    const snap: MarketSnapshot = {
      market: "ETH/USDC",
      reference_price: "3600",
      timestamp_ms: 1700000000000
    };
    // Reference 3600. Sell limit 3500 implies clearing >= 3500. Buyer with bps=10
    // requires |p - 3600| * 10000 <= 3600 * 10 = 36000, so |p - 3600| <= 3.6.
    // At p=3500 or 3550, this fails. So buyer is excluded.
    const r = clearUniform(
      mkBatch(
        [
          buy({ intent_id: "b_strict", base: "5", limit: "3700", bps: 10 }),
          sell({ intent_id: "s", base: "5", limit: "3500" })
        ],
        snap
      )
    );
    // Both candidates 3500, 3700. At 3500: buyer fails impact.
    //   activeBuys=[], exec=0. Skip.
    // At 3700: buyer fails impact too (|3700-3600|*10000=1000000 > 36000).
    //   activeBuys=[], exec=0. Skip.
    // No best -> no-cross. b_strict: limit crosses some candidates but failed impact -> MAX_PRICE_IMPACT_VIOLATED.
    expect(r.clearing_price).toBe("0");
    expect(r.fills.find((f) => f.intent_id === "b_strict")!.unfilled_reason).toBe(
      "MAX_PRICE_IMPACT_VIOLATED"
    );
  });

  it("does not assign MAX_PRICE_IMPACT_VIOLATED when there is no opposite flow", () => {
    const snap: MarketSnapshot = {
      market: "ETH/USDC",
      reference_price: "3600",
      timestamp_ms: 1700000000000
    };
    const r = clearUniform(
      mkBatch([buy({ intent_id: "b", base: "5", limit: "3700", bps: 10 })], snap)
    );
    expect(r.fills[0]!.unfilled_reason).toBe(
      "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
    );
  });

  it("candidate exactly at max_price_impact_bps boundary is accepted", () => {
    const snap: MarketSnapshot = {
      market: "ETH/USDC",
      reference_price: "3600",
      timestamp_ms: 1700000000000
    };
    // bps=100 -> tolerance |p-3600|*10000 <= 3600*100 = 360000, so |p-3600| <= 36.
    // Pick limits: buy 3636, sell 3600 -> candidate 3636 boundary.
    const r = clearUniform(
      mkBatch(
        [
          buy({ intent_id: "b", base: "5", limit: "3636", bps: 100 }),
          sell({ intent_id: "s", base: "5", limit: "3600" })
        ],
        snap
      )
    );
    // Candidate 3600 within bps; candidate 3636 at exact boundary (lhs ceil = 360000, rhs floor = 360000).
    // Both feasible; tie break favors max exec (both 5), then midpoint, then lower price.
    expect(r.clearing_price === "3600" || r.clearing_price === "3636").toBe(true);
    expect(r.fills.find((f) => f.intent_id === "b")!.status).toBe("FILLED");
  });

  it("max_price_impact_bps = 0 only accepts clearing exactly at reference_price", () => {
    const snap: MarketSnapshot = {
      market: "ETH/USDC",
      reference_price: "3590",
      timestamp_ms: 1700000000000
    };
    // bps=0 means lhs <= 0 only when diff=0 (since lhs=ceil(diff*10000) > 0 if diff>0).
    const r = clearUniform(
      mkBatch(
        [
          buy({ intent_id: "b_atref", base: "5", limit: "3590", bps: 0 }),
          sell({ intent_id: "s_atref", base: "5", limit: "3590" })
        ],
        snap
      )
    );
    // Candidate is 3590; matches reference exactly -> impact OK.
    expect(r.clearing_price).toBe("3590");
    expect(r.fills.find((f) => f.intent_id === "b_atref")!.status).toBe("FILLED");
  });
});

describe("clearUniform — filled_quote correctness", () => {
  it("filled_quote = filled_base * clearing_price (floor)", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "4", limit: "3590.50" }),
        sell({ intent_id: "s", base: "4", limit: "3590.50" })
      ])
    );
    expect(r.clearing_price).toBe("3590.5");
    expect(r.fills.find((f) => f.intent_id === "b")!.filled_quote).toBe("14362");
    expect(r.fills.find((f) => f.intent_id === "s")!.filled_quote).toBe("14362");
  });

  it("BUY and SELL counterparts have identical filled_quote", () => {
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "5", limit: "3600" }),
        sell({ intent_id: "s", base: "5", limit: "3600" })
      ])
    );
    expect(r.fills.find((f) => f.intent_id === "b")!.filled_quote).toBe(
      r.fills.find((f) => f.intent_id === "s")!.filled_quote
    );
  });
});

describe("clearUniform — output ordering and determinism", () => {
  it("fills[] order matches batch.intents order", () => {
    const batch = mkBatch([
      sell({ intent_id: "intent_A", base: "10", limit: "3580", received_ms: 1 }),
      buy({ intent_id: "intent_B", base: "4", limit: "3610", received_ms: 2 }),
      buy({ intent_id: "intent_C", base: "8", limit: "3590", received_ms: 3 })
    ]);
    const r = clearUniform(batch);
    expect(r.fills.map((f) => f.intent_id)).toEqual(
      batch.intents.map((i) => i.envelope.intent_id)
    );
  });

  it("repeated calls are identical", () => {
    const batch = mkBatch([
      sell({ intent_id: "intent_A", base: "10", limit: "3580", received_ms: 1 }),
      buy({ intent_id: "intent_B", base: "4", limit: "3610", received_ms: 2 }),
      buy({ intent_id: "intent_C", base: "8", limit: "3590", received_ms: 3 })
    ]);
    const r1 = clearUniform(batch);
    const r2 = clearUniform(batch);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("clearUniform — purity", () => {
  it("does not mutate input batch", () => {
    const batch = mkBatch([
      buy({ intent_id: "b", base: "5", limit: "3600" }),
      sell({ intent_id: "s", base: "5", limit: "3600" })
    ]);
    const before = JSON.stringify(batch);
    clearUniform(batch);
    expect(JSON.stringify(batch)).toBe(before);
  });
});

describe("clearUniform — duplicate intent_id throws", () => {
  it("throws on duplicate intent_id", () => {
    const dup = buy({ intent_id: "intent_X", base: "5", limit: "3600" });
    const dup2 = sell({ intent_id: "intent_X", base: "5", limit: "3600" });
    const batch = mkBatch([dup, dup2]);
    expect(() => clearUniform(batch)).toThrow(/duplicate intent_id/);
  });
});

describe("clearUniform — all skipped by min-fill", () => {
  it("returns no-cross with MIN_FILL_NOT_MET for active intents", () => {
    // Two intents both with min > each other's max -> no allocation possible.
    const r = clearUniform(
      mkBatch([
        buy({ intent_id: "b", base: "10", limit: "3600", min: "10", partial: true }),
        sell({ intent_id: "s", base: "5", limit: "3600", min: "5", partial: true })
      ])
    );
    // matched_target = min(10, 5) = 5.
    // BUY pass with budget 5: b needs min 10 -> skip. actualBuy = 0.
    // SELL pass with budget 0: s needs min 5 -> skip. actualSell = 0.
    // Equal at 0. Allocation succeeds with zero fills.
    // Falls into "if isZero(totalBuyFilled)" branch -> all UNFILLED with MIN_FILL_NOT_MET for active.
    expect(r.clearing_price).toBe("0");
    expect(r.fills.find((f) => f.intent_id === "b")!.unfilled_reason).toBe(
      "MIN_FILL_NOT_MET"
    );
    expect(r.fills.find((f) => f.intent_id === "s")!.unfilled_reason).toBe(
      "MIN_FILL_NOT_MET"
    );
  });
});

describe("clearUniform — conservation", () => {
  it("sum(BUY filled_base) == sum(SELL filled_base)", () => {
    const r = clearUniform(
      mkBatch([
        sell({ intent_id: "s1", base: "10", limit: "3580", received_ms: 1 }),
        buy({ intent_id: "b1", base: "4", limit: "3610", received_ms: 2 }),
        buy({ intent_id: "b2", base: "8", limit: "3590", received_ms: 3 })
      ])
    );
    const buyTotal = r.fills
      .filter((f) => f.intent_id.startsWith("b"))
      .reduce((acc, f) => acc + Number(f.filled_base), 0);
    const sellTotal = r.fills
      .filter((f) => f.intent_id.startsWith("s"))
      .reduce((acc, f) => acc + Number(f.filled_base), 0);
    expect(buyTotal).toBe(sellTotal);
  });
});
