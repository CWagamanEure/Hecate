/**
 * Uniform clearing price matching engine for ETH/USDC.
 *
 * - v1 is deterministic uniform clearing.
 * - It is not a full exchange-grade matcher.
 * - It uses price-time allocation (BatchInput order = received_ms then intent_id).
 * - It does not optimize surplus.
 * - It may return BATCH_FAILED on pathological min-fill configurations even
 *   if a more complex algorithm could find a feasible matching.
 *
 * Tie-break ladder (final, no further tiebreakers):
 *   1. higher executable volume wins
 *   2. closer to midpoint(highest active buy limit, lowest active sell limit)
 *      — distance computed via cross-multiplication, no division
 *   3. lower price wins
 *
 * Throws on duplicate intent_id (programmer error).
 */

import type {
  BatchInput,
  FillPlan,
  FillEntry,
  FillStatus,
  UnfilledReason,
  PrivatePayload,
  PublicEnvelope,
  DecimalString,
  MarketSnapshot
} from "@shared/schemas";
import {
  cmpDecimal,
  addDecimal,
  subDecimal,
  mulDecimal,
  isZero,
  normalizeDecimal
} from "@shared/math/decimal";

type IntentRecord = { envelope: PublicEnvelope; payload: PrivatePayload };

function sumDecimals(arr: readonly DecimalString[]): DecimalString {
  let acc: DecimalString = "0";
  for (const v of arr) acc = addDecimal(acc, v);
  return acc;
}

function minDec(a: DecimalString, b: DecimalString): DecimalString {
  return cmpDecimal(a, b) <= 0 ? a : b;
}

function maxOfLimits(items: readonly IntentRecord[]): DecimalString {
  // assumes items.length > 0
  let m = items[0]!.payload.limit_price;
  for (let i = 1; i < items.length; i++) {
    if (cmpDecimal(items[i]!.payload.limit_price, m) > 0) {
      m = items[i]!.payload.limit_price;
    }
  }
  return m;
}

function minOfLimits(items: readonly IntentRecord[]): DecimalString {
  let m = items[0]!.payload.limit_price;
  for (let i = 1; i < items.length; i++) {
    if (cmpDecimal(items[i]!.payload.limit_price, m) < 0) {
      m = items[i]!.payload.limit_price;
    }
  }
  return m;
}

function limitCrosses(intent: IntentRecord, p: DecimalString): boolean {
  if (intent.payload.side === "BUY") {
    return cmpDecimal(intent.payload.limit_price, p) >= 0;
  }
  return cmpDecimal(intent.payload.limit_price, p) <= 0;
}

/**
 * Price-impact predicate.
 *
 *   abs(p - reference_price) * 10000 <= reference_price * max_price_impact_bps
 *
 * Conservative comparison via:
 *   lhs = mulDecimal(diff, "10000", "ceil")
 *   rhs = mulDecimal(reference_price, str(bps), "floor")
 *   accept iff lhs <= rhs
 *
 * Returns true if snapshot is null (constraint disabled).
 */
function priceImpactOK(
  intent: IntentRecord,
  p: DecimalString,
  snapshot: MarketSnapshot | null
): boolean {
  if (snapshot === null) return true;
  const ref = snapshot.reference_price;
  const diff =
    cmpDecimal(p, ref) >= 0 ? subDecimal(p, ref) : subDecimal(ref, p);
  const lhs = mulDecimal(diff, "10000", "ceil");
  const bpsStr = String(intent.payload.max_price_impact_bps) as DecimalString;
  const rhs = mulDecimal(ref, bpsStr, "floor");
  return cmpDecimal(lhs, rhs) <= 0;
}

function isActive(
  intent: IntentRecord,
  p: DecimalString,
  snapshot: MarketSnapshot | null
): boolean {
  return limitCrosses(intent, p) && priceImpactOK(intent, p, snapshot);
}

/** Allocate budget across intents in price-time order. Skip intents whose
 *  fillable size is zero or below their min_base_fill_amount. */
function priceTimeAlloc(
  intents: readonly IntentRecord[],
  budget: DecimalString
): Record<string, DecimalString> {
  const out: Record<string, DecimalString> = {};
  let remaining = budget;
  for (const i of intents) {
    const size = minDec(i.payload.max_base_amount, remaining);
    if (isZero(size)) continue;
    if (cmpDecimal(size, i.payload.min_base_fill_amount) < 0) continue;
    out[i.envelope.intent_id] = size;
    remaining = subDecimal(remaining, size);
  }
  return out;
}

type AllocResult =
  | { ok: true; buyFills: Record<string, DecimalString>; sellFills: Record<string, DecimalString> }
  | { ok: false };

function allocateWithTightening(
  activeBuys: readonly IntentRecord[],
  activeSells: readonly IntentRecord[],
  initialMatched: DecimalString
): AllocResult {
  let matched = initialMatched;
  const cap = activeBuys.length + activeSells.length + 1;
  let prevSellTotal: DecimalString | null = null;

  for (let iter = 0; iter < cap; iter++) {
    const buyFills = priceTimeAlloc(activeBuys, matched);
    const actualBuy = sumDecimals(Object.values(buyFills));
    const sellFills = priceTimeAlloc(activeSells, actualBuy);
    const actualSell = sumDecimals(Object.values(sellFills));

    if (cmpDecimal(actualBuy, actualSell) === 0) {
      return { ok: true, buyFills, sellFills };
    }

    if (prevSellTotal !== null && cmpDecimal(actualSell, prevSellTotal) === 0) {
      return { ok: false };
    }
    matched = actualSell;
    prevSellTotal = actualSell;
  }
  return { ok: false };
}

function allUnfilledWithReason(
  batch: BatchInput,
  reasonFor: (i: IntentRecord) => UnfilledReason
): FillPlan {
  return {
    clearing_price: "0",
    fills: batch.intents.map((i) => ({
      intent_id: i.envelope.intent_id,
      filled_base: "0",
      filled_quote: "0",
      status: "UNFILLED" as FillStatus,
      unfilled_reason: reasonFor(i)
    }))
  };
}

/** Per-intent reason for the no-cross case (no candidate produced executable > 0,
 *  or trivial no-cross with empty buys/sells).
 *
 *  Rules:
 *   1. If no opposite-side flow exists at all → INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT.
 *   2. Else if snapshot is null → INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT.
 *   3. Else if any candidate that crosses the intent's limit failed impact for
 *      this intent → MAX_PRICE_IMPACT_VIOLATED.
 *   4. Else → INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT.
 */
function noMatchReason(
  intent: IntentRecord,
  batch: BatchInput,
  candidates: readonly DecimalString[]
): UnfilledReason {
  const opposite = intent.payload.side === "BUY" ? "SELL" : "BUY";
  const hasOpposite = batch.intents.some((i) => i.payload.side === opposite);
  if (!hasOpposite) return "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT";
  if (batch.market_snapshot === null) {
    return "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT";
  }
  for (const c of candidates) {
    if (!limitCrosses(intent, c)) continue;
    if (!priceImpactOK(intent, c, batch.market_snapshot)) {
      return "MAX_PRICE_IMPACT_VIOLATED";
    }
  }
  return "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT";
}

/** Per-intent reason for the cross case at chosen clearing price `p`.
 *  Only used for intents with filled_base = 0. */
function crossUnfilledReason(
  intent: IntentRecord,
  p: DecimalString,
  snapshot: MarketSnapshot | null,
  wasActive: boolean
): UnfilledReason {
  if (wasActive) return "MIN_FILL_NOT_MET";
  if (!limitCrosses(intent, p)) return "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT";
  // limit crosses but intent was inactive → impact failed at p
  if (snapshot !== null && !priceImpactOK(intent, p, snapshot)) {
    return "MAX_PRICE_IMPACT_VIOLATED";
  }
  return "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT";
}

export function clearUniform(batch: BatchInput): FillPlan {
  // Validate uniqueness of intent_ids (programmer error if duplicate).
  const seen = new Set<string>();
  for (const i of batch.intents) {
    if (seen.has(i.envelope.intent_id)) {
      throw new Error(
        `clearUniform: duplicate intent_id ${i.envelope.intent_id}`
      );
    }
    seen.add(i.envelope.intent_id);
  }

  if (batch.intents.length === 0) {
    return { clearing_price: "0", fills: [] };
  }

  const buys = batch.intents.filter((i) => i.payload.side === "BUY");
  const sells = batch.intents.filter((i) => i.payload.side === "SELL");

  // Trivial no-cross.
  if (buys.length === 0 || sells.length === 0) {
    return allUnfilledWithReason(batch, (i) => noMatchReason(i, batch, []));
  }

  // Build candidates from union of submitted limit prices, sorted ascending.
  const limitsSet = new Set<string>();
  for (const i of batch.intents) limitsSet.add(i.payload.limit_price);
  const candidates: DecimalString[] = [...limitsSet].sort((a, b) =>
    cmpDecimal(a as DecimalString, b as DecimalString)
  ) as DecimalString[];

  type Best = {
    p: DecimalString;
    exec: DecimalString;
    activeBuys: IntentRecord[];
    activeSells: IntentRecord[];
    midSum: DecimalString;        // highBuy + lowSell at p (for tie-break)
  };
  let best: Best | null = null;

  for (const p of candidates) {
    const activeBuys = buys.filter((b) => isActive(b, p, batch.market_snapshot));
    const activeSells = sells.filter((s) => isActive(s, p, batch.market_snapshot));
    if (activeBuys.length === 0 || activeSells.length === 0) continue;
    const buyVol = sumDecimals(activeBuys.map((b) => b.payload.max_base_amount));
    const sellVol = sumDecimals(activeSells.map((s) => s.payload.max_base_amount));
    const exec = minDec(buyVol, sellVol);
    if (isZero(exec)) continue;
    const highBuy = maxOfLimits(activeBuys);
    const lowSell = minOfLimits(activeSells);
    const midSum = addDecimal(highBuy, lowSell);

    if (best === null || isBetterCandidate({ p, exec, midSum }, best)) {
      best = { p, exec, activeBuys, activeSells, midSum };
    }
  }

  // No-cross at any candidate.
  if (best === null) {
    return allUnfilledWithReason(batch, (i) =>
      noMatchReason(i, batch, candidates)
    );
  }

  // Allocate at chosen clearing price.
  const alloc = allocateWithTightening(best.activeBuys, best.activeSells, best.exec);
  if (!alloc.ok) {
    return {
      clearing_price: "0",
      fills: batch.intents.map((i) => ({
        intent_id: i.envelope.intent_id,
        filled_base: "0",
        filled_quote: "0",
        status: "UNFILLED" as FillStatus,
        unfilled_reason: "BATCH_FAILED" as UnfilledReason
      }))
    };
  }

  // Conservation invariant.
  const totalBuyFilled = sumDecimals(Object.values(alloc.buyFills));
  const totalSellFilled = sumDecimals(Object.values(alloc.sellFills));
  if (cmpDecimal(totalBuyFilled, totalSellFilled) !== 0) {
    return {
      clearing_price: "0",
      fills: batch.intents.map((i) => ({
        intent_id: i.envelope.intent_id,
        filled_base: "0",
        filled_quote: "0",
        status: "UNFILLED" as FillStatus,
        unfilled_reason: "BATCH_FAILED" as UnfilledReason
      }))
    };
  }

  // If allocation collapsed to zero fills, treat as no-cross-with-min-fill.
  if (isZero(totalBuyFilled)) {
    const activeBuyIds = new Set(best.activeBuys.map((b) => b.envelope.intent_id));
    const activeSellIds = new Set(best.activeSells.map((s) => s.envelope.intent_id));
    const activeIds = new Set([...activeBuyIds, ...activeSellIds]);
    return {
      clearing_price: "0",
      fills: batch.intents.map((i) => ({
        intent_id: i.envelope.intent_id,
        filled_base: "0",
        filled_quote: "0",
        status: "UNFILLED" as FillStatus,
        unfilled_reason: activeIds.has(i.envelope.intent_id)
          ? ("MIN_FILL_NOT_MET" as UnfilledReason)
          : noMatchReason(i, batch, candidates)
      }))
    };
  }

  // Build the per-intent fill plan.
  const allFills: Record<string, DecimalString> = {};
  for (const [k, v] of Object.entries(alloc.buyFills)) allFills[k] = v;
  for (const [k, v] of Object.entries(alloc.sellFills)) allFills[k] = v;

  const activeBuyIds = new Set(best.activeBuys.map((b) => b.envelope.intent_id));
  const activeSellIds = new Set(best.activeSells.map((s) => s.envelope.intent_id));

  const fills: FillEntry[] = batch.intents.map((i) => {
    const id = i.envelope.intent_id;
    const filledBase = allFills[id] ?? ("0" as DecimalString);
    const max = i.payload.max_base_amount;

    let status: FillStatus;
    let reason: UnfilledReason | null;
    if (cmpDecimal(filledBase, max) === 0) {
      status = "FILLED";
      reason = null;
    } else if (cmpDecimal(filledBase, "0") > 0) {
      status = "PARTIALLY_FILLED";
      reason = "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT";
    } else {
      status = "UNFILLED";
      const wasActive = activeBuyIds.has(id) || activeSellIds.has(id);
      reason = crossUnfilledReason(i, best!.p, batch.market_snapshot, wasActive);
    }

    const filledQuote = isZero(filledBase)
      ? ("0" as DecimalString)
      : mulDecimal(filledBase, best!.p, "floor");

    return {
      intent_id: id,
      filled_base: normalizeDecimal(filledBase),
      filled_quote: normalizeDecimal(filledQuote),
      status,
      unfilled_reason: reason
    };
  });

  return { clearing_price: normalizeDecimal(best.p), fills };
}

/**
 * Tie-break: higher exec wins; tie → smaller midpoint distance wins
 * (distance = abs(2p - midSum)); tie → lower p wins.
 */
function isBetterCandidate(
  c: { p: DecimalString; exec: DecimalString; midSum: DecimalString },
  best: { p: DecimalString; exec: DecimalString; midSum: DecimalString }
): boolean {
  const execCmp = cmpDecimal(c.exec, best.exec);
  if (execCmp > 0) return true;
  if (execCmp < 0) return false;
  // distance = abs(2p - midSum)
  const dC = absDist(c.p, c.midSum);
  const dB = absDist(best.p, best.midSum);
  const distCmp = cmpDecimal(dC, dB);
  if (distCmp < 0) return true;
  if (distCmp > 0) return false;
  // lower p wins
  return cmpDecimal(c.p, best.p) < 0;
}

function absDist(p: DecimalString, midSum: DecimalString): DecimalString {
  const twoP = addDecimal(p, p);
  return cmpDecimal(twoP, midSum) >= 0
    ? subDecimal(twoP, midSum)
    : subDecimal(midSum, twoP);
}
