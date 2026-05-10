import { describe, it, expect } from "vitest";
import { clearUniform } from "@shared/matching";
import { cmpDecimal, addDecimal, isZero, mulDecimal } from "@shared/math/decimal";
import type {
  BatchInput,
  FillPlan,
  PrivatePayload,
  MarketSnapshot,
  Side
} from "@shared/schemas";
import { makeRng } from "./adversarial/seededRng";
import { randomBatch, randomIntent } from "./adversarial/generators";

/**
 * Walks every matching invariant from Ticket 17b list A. Returns a list of
 * violations; empty array means all invariants hold.
 */
function checkMatchingInvariants(batch: BatchInput, plan: FillPlan): string[] {
  const violations: string[] = [];

  // (1) Every batch intent appears exactly once in plan.fills.
  const fillIds = plan.fills.map((f) => f.intent_id);
  const fillIdSet = new Set(fillIds);
  if (fillIds.length !== fillIdSet.size) {
    violations.push("duplicate intent_id in fills");
  }
  for (const i of batch.intents) {
    if (!fillIdSet.has(i.envelope.intent_id)) {
      violations.push(`missing fill for ${i.envelope.intent_id}`);
    }
  }
  if (plan.fills.length !== batch.intents.length) {
    violations.push(
      `fills length ${plan.fills.length} != intents length ${batch.intents.length}`
    );
  }

  // intent_id -> payload
  const payloadById = new Map<string, PrivatePayload>();
  for (const i of batch.intents) {
    payloadById.set(i.envelope.intent_id, i.payload);
  }

  let buyFilled = "0";
  let sellFilled = "0";

  for (const fill of plan.fills) {
    const p = payloadById.get(fill.intent_id);
    if (!p) continue;

    // (3) filled_base never negative.
    if (fill.filled_base.startsWith("-")) {
      violations.push(`${fill.intent_id} filled_base negative`);
    }
    // (4) filled_quote never negative.
    if (fill.filled_quote.startsWith("-")) {
      violations.push(`${fill.intent_id} filled_quote negative`);
    }

    const filledIsZero = isZero(fill.filled_base);
    const filledIsMax = cmpDecimal(fill.filled_base, p.max_base_amount) === 0;
    const filledIsPartial =
      !filledIsZero && cmpDecimal(fill.filled_base, p.max_base_amount) < 0;

    // (5) FILLED iff filled_base == max_base_amount
    if (fill.status === "FILLED" && !filledIsMax) {
      violations.push(`${fill.intent_id} FILLED but filled_base != max`);
    }
    if (filledIsMax && fill.status !== "FILLED") {
      violations.push(`${fill.intent_id} filled_base == max but status ${fill.status}`);
    }
    // (6) PARTIALLY_FILLED iff 0 < filled_base < max
    if (fill.status === "PARTIALLY_FILLED" && !filledIsPartial) {
      violations.push(
        `${fill.intent_id} PARTIALLY_FILLED but filled_base ${fill.filled_base} not in (0, max)`
      );
    }
    // (7) UNFILLED iff filled_base == 0
    if (fill.status === "UNFILLED" && !filledIsZero) {
      violations.push(`${fill.intent_id} UNFILLED but filled_base ${fill.filled_base} != 0`);
    }
    if (filledIsZero && fill.status !== "UNFILLED") {
      violations.push(`${fill.intent_id} filled_base == 0 but status ${fill.status}`);
    }

    // (8) FILLED -> unfilled_reason null
    if (fill.status === "FILLED" && fill.unfilled_reason !== null) {
      violations.push(`${fill.intent_id} FILLED but unfilled_reason = ${fill.unfilled_reason}`);
    }
    // (9) UNFILLED -> unfilled_reason non-null
    if (fill.status === "UNFILLED" && fill.unfilled_reason === null) {
      violations.push(`${fill.intent_id} UNFILLED but unfilled_reason null`);
    }

    // (11) BUY fills only when limit_price >= clearing_price
    // (12) SELL fills only when limit_price <= clearing_price
    if (!filledIsZero) {
      if (p.side === "BUY" && cmpDecimal(p.limit_price, plan.clearing_price) < 0) {
        violations.push(
          `BUY ${fill.intent_id} filled at ${plan.clearing_price} > limit ${p.limit_price}`
        );
      }
      if (p.side === "SELL" && cmpDecimal(p.limit_price, plan.clearing_price) > 0) {
        violations.push(
          `SELL ${fill.intent_id} filled at ${plan.clearing_price} < limit ${p.limit_price}`
        );
      }

      // (13) Impact respected when snapshot exists.
      if (batch.market_snapshot) {
        const snap = batch.market_snapshot;
        const ref = snap.reference_price;
        const diff =
          cmpDecimal(plan.clearing_price, ref) >= 0
            ? subString(plan.clearing_price, ref)
            : subString(ref, plan.clearing_price);
        const lhs = mulDecimal(diff, "10000", "ceil");
        const rhs = mulDecimal(ref, String(p.max_price_impact_bps), "floor");
        if (cmpDecimal(lhs, rhs) > 0) {
          violations.push(`${fill.intent_id} filled past max_price_impact_bps`);
        }
      }

      // (14) all-or-nothing fills max or 0.
      if (!p.allow_partial_fill && !filledIsMax) {
        violations.push(
          `${fill.intent_id} all-or-nothing but filled_base ${fill.filled_base} != max ${p.max_base_amount}`
        );
      }

      // (15) Partial fills >= min_base_fill_amount.
      if (cmpDecimal(fill.filled_base, p.min_base_fill_amount) < 0) {
        violations.push(
          `${fill.intent_id} filled ${fill.filled_base} < min ${p.min_base_fill_amount}`
        );
      }

      if (p.side === "BUY") buyFilled = addDecimal(buyFilled, fill.filled_base);
      else sellFilled = addDecimal(sellFilled, fill.filled_base);
    }
  }

  // (10) Conservation: sum BUY filled_base == sum SELL filled_base.
  if (cmpDecimal(buyFilled, sellFilled) !== 0) {
    violations.push(`conservation violated: BUY total ${buyFilled} != SELL total ${sellFilled}`);
  }

  return violations;
}

// Local helper: subtract two non-negative decimal strings (assumes a >= b).
function subString(a: string, b: string): string {
  const aB = parseFloat(a);
  const bB = parseFloat(b);
  // Use the math module's subDecimal indirectly through addDecimal of negative — but
  // we'd need to convert. Just use schema helper through cmpDecimal/mulDecimal-aware path.
  // For our bounded decimals, parseFloat is safe enough for the impact-check.
  return Math.max(0, aB - bB).toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
}

const SEED = 1;
const ITERATIONS = 100;

describe("adversarial matching — invariant check across seeded random batches", () => {
  it.each([
    [`seed=${SEED} no snapshot`, null],
    [
      `seed=${SEED} with snapshot`,
      {
        market: "ETH/USDC" as const,
        reference_price: "3590",
        timestamp_ms: 1700000000000
      }
    ]
  ])("%s — %d iterations", (label, snapshot) => {
    const rng = makeRng(SEED);
    let lastSeed = SEED;
    for (let i = 0; i < ITERATIONS; i++) {
      lastSeed = SEED + i;
      const local = makeRng(lastSeed);
      const { batch } = randomBatch(local, {
        count: local.nextInt(7) + 1,
        snapshot: snapshot as MarketSnapshot | null
      });
      let plan: FillPlan;
      try {
        plan = clearUniform(batch);
      } catch (e) {
        throw new Error(
          `seed=${lastSeed} iteration=${i} (${label}): clearUniform threw: ${(e as Error).message}`
        );
      }
      const violations = checkMatchingInvariants(batch, plan);
      if (violations.length > 0) {
        throw new Error(
          `seed=${lastSeed} iteration=${i} (${label}): ${violations.join("; ")}\nbatch=${JSON.stringify(
            batch.intents.map((x) => ({
              intent_id: x.envelope.intent_id,
              side: x.payload.side,
              max: x.payload.max_base_amount,
              limit: x.payload.limit_price,
              min: x.payload.min_base_fill_amount,
              partial: x.payload.allow_partial_fill,
              bps: x.payload.max_price_impact_bps
            }))
          )}\nplan=${JSON.stringify(plan)}`
        );
      }
    }
    expect(true).toBe(true);
  });
});

describe("adversarial matching — determinism", () => {
  it("100 random batches: clearUniform is byte-deterministic across repeated calls", () => {
    for (let s = 1; s <= 100; s++) {
      const rng1 = makeRng(s);
      const rng2 = makeRng(s);
      const { batch: b1 } = randomBatch(rng1, { count: 4 });
      const { batch: b2 } = randomBatch(rng2, { count: 4 });
      const p1 = clearUniform(b1);
      const p2 = clearUniform(b2);
      if (JSON.stringify(p1) !== JSON.stringify(p2)) {
        throw new Error(`seed=${s}: non-deterministic`);
      }
    }
    expect(true).toBe(true);
  });

  it("input batch is not mutated", () => {
    for (let s = 1; s <= 50; s++) {
      const rng = makeRng(s);
      const { batch } = randomBatch(rng, { count: 4 });
      const before = JSON.stringify(batch);
      clearUniform(batch);
      if (JSON.stringify(batch) !== before) {
        throw new Error(`seed=${s}: input batch mutated`);
      }
    }
    expect(true).toBe(true);
  });
});

describe("adversarial matching — exhaustive small cases", () => {
  function makeIntent(args: {
    intent_id: string;
    side: Side;
    base: string;
    limit: string;
    min: string;
    partial: boolean;
  }) {
    const rng = makeRng(args.intent_id.length * 31 + args.base.length);
    return randomIntent(rng, { side: args.side, intent_id: args.intent_id });
  }

  // 1 buyer, 1 seller — exact cross.
  it("1B1S exact cross at limit equality", () => {
    const rng = makeRng(7);
    const buy = randomIntent(rng, { side: "BUY", intent_id: "b" });
    const sell = randomIntent(rng, { side: "SELL", intent_id: "s" });
    // Force matching by aligning prices via adjusted payloads.
    const fixedBuy = { ...buy.payload, max_base_amount: "5", limit_price: "3600", min_base_fill_amount: "1", allow_partial_fill: true };
    const fixedSell = { ...sell.payload, max_base_amount: "5", limit_price: "3600", min_base_fill_amount: "1", allow_partial_fill: true };
    const batch: BatchInput = {
      batch_id: "batch_x",
      market: "ETH/USDC",
      intents: [
        { envelope: buy.envelope, payload: fixedBuy },
        { envelope: sell.envelope, payload: fixedSell }
      ],
      market_snapshot: null,
      timestamp_ms: 1
    };
    const plan = clearUniform(batch);
    expect(plan.clearing_price).toBe("3600");
    expect(checkMatchingInvariants(batch, plan)).toEqual([]);
  });

  it("buyer limit just below seller limit -> no cross", () => {
    const rng = makeRng(11);
    const buy = randomIntent(rng, { side: "BUY", intent_id: "b" });
    const sell = randomIntent(rng, { side: "SELL", intent_id: "s" });
    const fixedBuy = { ...buy.payload, max_base_amount: "5", limit_price: "3580", min_base_fill_amount: "1", allow_partial_fill: true };
    const fixedSell = { ...sell.payload, max_base_amount: "5", limit_price: "3590", min_base_fill_amount: "1", allow_partial_fill: true };
    const batch: BatchInput = {
      batch_id: "batch_x",
      market: "ETH/USDC",
      intents: [
        { envelope: buy.envelope, payload: fixedBuy },
        { envelope: sell.envelope, payload: fixedSell }
      ],
      market_snapshot: null,
      timestamp_ms: 1
    };
    const plan = clearUniform(batch);
    expect(plan.clearing_price).toBe("0");
    expect(checkMatchingInvariants(batch, plan)).toEqual([]);
  });

  it("all-or-nothing buyer larger than total sell volume -> UNFILLED MIN_FILL_NOT_MET", () => {
    const rng = makeRng(13);
    const buy = randomIntent(rng, { side: "BUY", intent_id: "b" });
    const sell = randomIntent(rng, { side: "SELL", intent_id: "s" });
    const fixedBuy = { ...buy.payload, max_base_amount: "10", limit_price: "3600", min_base_fill_amount: "10", allow_partial_fill: false };
    const fixedSell = { ...sell.payload, max_base_amount: "5", limit_price: "3580", min_base_fill_amount: "1", allow_partial_fill: true };
    const batch: BatchInput = {
      batch_id: "batch_x",
      market: "ETH/USDC",
      intents: [
        { envelope: buy.envelope, payload: fixedBuy },
        { envelope: sell.envelope, payload: fixedSell }
      ],
      market_snapshot: null,
      timestamp_ms: 1
    };
    const plan = clearUniform(batch);
    const buyFill = plan.fills.find((f) => f.intent_id === "b")!;
    expect(buyFill.status).toBe("UNFILLED");
    expect(buyFill.unfilled_reason).toBe("MIN_FILL_NOT_MET");
    expect(checkMatchingInvariants(batch, plan)).toEqual([]);
  });

  it("max_price_impact_bps=0 with snapshot -> only matches when clearing == reference", () => {
    const rng = makeRng(17);
    const buy = randomIntent(rng, { side: "BUY", intent_id: "b" });
    const sell = randomIntent(rng, { side: "SELL", intent_id: "s" });
    const fixedBuy = { ...buy.payload, max_base_amount: "5", limit_price: "3600", min_base_fill_amount: "1", allow_partial_fill: true, max_price_impact_bps: 0 };
    const fixedSell = { ...sell.payload, max_base_amount: "5", limit_price: "3600", min_base_fill_amount: "1", allow_partial_fill: true, max_price_impact_bps: 0 };
    const batch: BatchInput = {
      batch_id: "batch_x",
      market: "ETH/USDC",
      intents: [
        { envelope: buy.envelope, payload: fixedBuy },
        { envelope: sell.envelope, payload: fixedSell }
      ],
      market_snapshot: { market: "ETH/USDC", reference_price: "3600", timestamp_ms: 1 },
      timestamp_ms: 1
    };
    const plan = clearUniform(batch);
    expect(plan.clearing_price).toBe("3600");
    expect(checkMatchingInvariants(batch, plan)).toEqual([]);
  });
});
