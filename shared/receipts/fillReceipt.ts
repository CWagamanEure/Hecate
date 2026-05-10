/**
 * Fill receipt builder.
 *
 * Converts (BatchInput + FillPlan + ReservationBook + RuntimeMetadata + engine key)
 * into signed per-agent FillReceipts.
 *
 * Pure function. Does NOT mutate vault state, does NOT release reservations,
 * does NOT persist anything. Settlement (Ticket 12) handles release + delta
 * application separately.
 *
 * Throws on:
 *   - missing FillEntry for a batch intent
 *   - missing Reservation for a batch intent
 *   - payload commitment mismatch (envelope vs hashPayload(payload))
 *   - subDecimal underflow when computing reserved_released (would mean the
 *     matcher emitted a fill exceeding the reservation — engine bug)
 */

import type {
  BatchInput,
  FillPlan,
  FillEntry,
  ReservationBook,
  Reservation,
  RuntimeMetadata,
  FillReceipt,
  FillReceiptBody,
  PrivatePayload,
  AssetBalances,
  HexAddress,
  Hex32,
  MarketSnapshot
} from "@shared/schemas";
import {
  hashPayload,
  hashFillReceiptBody,
  signHash,
  recoverHashSigner
} from "@shared/crypto";
import {
  cmpDecimal,
  subDecimal,
  mulDecimal,
  isZero,
  normalizeDecimal
} from "@shared/math/decimal";

export type BuildFillReceiptsInput = {
  batch: BatchInput;
  fillPlan: FillPlan;
  reservationBook: ReservationBook;
  runtime: RuntimeMetadata;
  engineKey: Hex32 | Uint8Array;
};

export type BuildFillReceiptBodiesInput = Omit<BuildFillReceiptsInput, "engineKey">;

/**
 * Sign a fill receipt body (no signature field). Returns the signed FillReceipt.
 */
export function signFillReceipt(
  body: FillReceiptBody,
  engineKey: Hex32 | Uint8Array
): FillReceipt {
  const hash = hashFillReceiptBody(body);
  const engine_signature = signHash(hash, engineKey);
  return { ...body, engine_signature };
}

/**
 * Recover the engine signer from a signed fill receipt. Useful for tests and
 * for verification (Ticket 14).
 */
export function recoverFillReceiptSigner(receipt: FillReceipt): HexAddress {
  const { engine_signature } = receipt;
  // hashFillReceiptBody strips engine_signature defensively, so we can pass the
  // signed receipt directly.
  const hash = hashFillReceiptBody(receipt);
  return recoverHashSigner(hash, engine_signature);
}

/**
 * Build unsigned fill receipt bodies. Used both by the signed builder and by
 * the verifier (Ticket 14) to recompute expected bodies for field comparison.
 */
export function buildFillReceiptBodies(
  input: BuildFillReceiptBodiesInput
): FillReceiptBody[] {
  const { batch, fillPlan, reservationBook, runtime } = input;

  const fillById = new Map<string, FillEntry>();
  for (const f of fillPlan.fills) fillById.set(f.intent_id, f);

  return batch.intents.map((intent) => {
    const env = intent.envelope;
    const payload = intent.payload;

    const fill = fillById.get(env.intent_id);
    if (!fill) {
      throw new Error(
        `buildFillReceipts: missing fill for intent ${env.intent_id}`
      );
    }

    const reservation = findReservation(reservationBook, env.intent_id);

    // Assert the envelope's commitment matches hashPayload(payload). A mismatch
    // here means upstream (acceptIntent) was bypassed or buggy.
    const computed_commitment = hashPayload(payload);
    if (computed_commitment !== env.payload_commitment) {
      throw new Error(
        `buildFillReceipts: payload commitment mismatch for ${env.intent_id} (envelope=${env.payload_commitment}, computed=${computed_commitment})`
      );
    }

    return {
      intent_id: env.intent_id,
      batch_id: batch.batch_id,
      agent_id: env.agent_id,
      status: fill.status,
      filled_base: fill.filled_base,
      filled_quote: fill.filled_quote,
      clearing_price: fillPlan.clearing_price,
      constraints_satisfied: computeConstraintsSatisfied(
        payload,
        fill,
        fillPlan.clearing_price,
        batch.market_snapshot
      ),
      unfilled_reason: fill.unfilled_reason,
      payload_commitment: computed_commitment,
      reserved_released: computeReservedReleased(reservation, fill),
      // Shallow-copy so caller mutation of `runtime` after build doesn't
      // affect already-built receipts.
      runtime: { ...runtime }
    };
  });
}

export function buildFillReceipts(
  input: BuildFillReceiptsInput
): FillReceipt[] {
  const bodies = buildFillReceiptBodies(input);
  return bodies.map((b) => signFillReceipt(b, input.engineKey));
}

// ---- helpers ---------------------------------------------------------------

function findReservation(
  book: ReservationBook,
  intent_id: string
): Reservation {
  const r = book.reservations.find((x) => x.intent_id === intent_id);
  if (!r) {
    throw new Error(
      `buildFillReceipts: no reservation for intent ${intent_id}`
    );
  }
  return r;
}

function computeReservedReleased(
  reservation: Reservation,
  fill: FillEntry
): AssetBalances {
  if (reservation.asset === "ETH") {
    // SELL path. Spent = filled_base ETH.
    if (isZero(fill.filled_base)) {
      return { ETH: normalizeDecimal(reservation.amount), USDC: "0" };
    }
    const released = subDecimal(reservation.amount, fill.filled_base);
    return { ETH: normalizeDecimal(released), USDC: "0" };
  }
  // BUY path. reservation.asset === "USDC". Spent = filled_quote USDC.
  if (isZero(fill.filled_quote)) {
    return { ETH: "0", USDC: normalizeDecimal(reservation.amount) };
  }
  const released = subDecimal(reservation.amount, fill.filled_quote);
  return { ETH: "0", USDC: normalizeDecimal(released) };
}

function limitRespected(
  payload: PrivatePayload,
  clearing: import("@shared/schemas").DecimalString
): boolean {
  return payload.side === "BUY"
    ? cmpDecimal(clearing, payload.limit_price) <= 0
    : cmpDecimal(clearing, payload.limit_price) >= 0;
}

function impactRespected(
  payload: PrivatePayload,
  clearing: import("@shared/schemas").DecimalString,
  snapshot: MarketSnapshot | null
): boolean {
  if (snapshot === null) return true;
  const ref = snapshot.reference_price;
  const diff =
    cmpDecimal(clearing, ref) >= 0
      ? subDecimal(clearing, ref)
      : subDecimal(ref, clearing);
  const lhs = mulDecimal(diff, "10000", "ceil");
  const bpsStr = String(payload.max_price_impact_bps) as import("@shared/schemas").DecimalString;
  const rhs = mulDecimal(ref, bpsStr, "floor");
  return cmpDecimal(lhs, rhs) <= 0;
}

function computeConstraintsSatisfied(
  payload: PrivatePayload,
  fill: FillEntry,
  clearing_price: import("@shared/schemas").DecimalString,
  snapshot: MarketSnapshot | null
): boolean {
  // BATCH_FAILED is unconditionally false.
  if (fill.unfilled_reason === "BATCH_FAILED") return false;

  switch (fill.status) {
    case "FILLED":
      return (
        cmpDecimal(fill.filled_base, payload.max_base_amount) === 0 &&
        limitRespected(payload, clearing_price) &&
        impactRespected(payload, clearing_price, snapshot)
      );
    case "PARTIALLY_FILLED":
      return (
        cmpDecimal(fill.filled_base, "0") > 0 &&
        cmpDecimal(fill.filled_base, payload.min_base_fill_amount) >= 0 &&
        cmpDecimal(fill.filled_base, payload.max_base_amount) < 0 &&
        limitRespected(payload, clearing_price) &&
        impactRespected(payload, clearing_price, snapshot)
      );
    case "UNFILLED":
      // The engine correctly refused. Constraints respected iff a known reason
      // was attached. (BATCH_FAILED was already returned false above.)
      return fill.unfilled_reason !== null;
    case "EXPIRED":
    case "INVALID":
    case "INSUFFICIENT_FUNDS":
      // Lifecycle codes that should not reach the matcher in v1.
      return false;
  }
}
