import type {
  VaultState,
  AgentVault,
  AssetBalances,
  ReservationBook,
  Reservation,
  PrivatePayload,
  PublicEnvelope,
  SettlementObject,
  Asset,
  DecimalString
} from "@shared/schemas";
import {
  addDecimal,
  subDecimal,
  mulDecimal,
  cmpDecimal,
  normalizeDecimal,
  applySignedDelta
} from "@shared/math/decimal";
import { normalizeAddress } from "@shared/crypto";

/**
 * Compute the maximum required spend for a payload.
 *
 *   SELL: reserve max_base_amount of ETH (asset_in).
 *   BUY:  reserve mulDecimal(max_base_amount, limit_price, "ceil") of USDC (asset_in).
 *
 * Ceiling rounding ensures over-reservation, not under, when the product
 * doesn't fit cleanly in 18 decimals.
 */
export function requiredSpend(payload: PrivatePayload): {
  asset: Asset;
  amount: DecimalString;
} {
  if (payload.side === "SELL") {
    return { asset: "ETH", amount: normalizeDecimal(payload.max_base_amount) };
  }
  return {
    asset: "USDC",
    amount: mulDecimal(payload.max_base_amount, payload.limit_price, "ceil")
  };
}

function insertSortedNonce(arr: readonly string[], add: string): string[] {
  return [...arr, add].sort();
}

function insertSortedReservation(
  arr: readonly Reservation[],
  r: Reservation
): Reservation[] {
  return [...arr, r].sort((a, b) =>
    a.intent_id < b.intent_id ? -1 : a.intent_id > b.intent_id ? 1 : 0
  );
}

/**
 * Reserve funds for an intent. Pure: returns new state and book on success.
 *
 * Failures: UNKNOWN_AGENT, DUPLICATE_NONCE, INSUFFICIENT_FUNDS. Nonce is added
 * to nonces_seen ONLY on successful reservation — rejected intents do not
 * burn nonces.
 */
export function reserveForIntent(
  state: VaultState,
  book: ReservationBook,
  env: PublicEnvelope,
  payload: PrivatePayload,
  now_ms: number
):
  | {
      ok: true;
      state: VaultState;
      book: ReservationBook;
      reservation: Reservation;
    }
  | {
      ok: false;
      code: "UNKNOWN_AGENT" | "DUPLICATE_NONCE" | "INSUFFICIENT_FUNDS";
      detail: string;
    } {
  const norm = normalizeAddress(env.agent_id);
  const av = state.agents[norm];
  if (!av) return { ok: false, code: "UNKNOWN_AGENT", detail: norm };

  if (av.nonces_seen.includes(env.nonce)) {
    return {
      ok: false,
      code: "DUPLICATE_NONCE",
      detail: `nonce ${env.nonce} already seen for ${norm}`
    };
  }

  const { asset, amount: required } = requiredSpend(payload);
  const balance = av.balances[asset];
  const reserved = av.reserved[asset];
  const available = subDecimal(balance, reserved);

  if (cmpDecimal(required, available) > 0) {
    return {
      ok: false,
      code: "INSUFFICIENT_FUNDS",
      detail: `intent ${env.intent_id} requires ${required} ${asset}, available ${available}`
    };
  }

  const newReserved: AssetBalances = {
    ...av.reserved,
    [asset]: normalizeDecimal(addDecimal(reserved, required))
  };
  const newAv: AgentVault = {
    ...av,
    reserved: newReserved,
    nonces_seen: insertSortedNonce(av.nonces_seen, env.nonce)
  };
  const newState: VaultState = {
    ...state,
    agents: { ...state.agents, [norm]: newAv }
  };

  const reservation: Reservation = {
    intent_id: env.intent_id,
    agent_id: norm,
    asset,
    amount: required,
    status: "RESERVED",
    created_ms: now_ms
  };
  const newBook: ReservationBook = {
    reservations: insertSortedReservation(book.reservations, reservation)
  };

  return { ok: true, state: newState, book: newBook, reservation };
}

/**
 * Release a reservation: decrement reserved[asset] by the FULL reservation
 * amount and update the reservation's status.
 *
 * `finalStatus = "RELEASED"` for unfilled / expired / cancelled intents.
 * `finalStatus = "SETTLED"` for filled / partially-filled intents — the actual
 * spend is recorded separately via applyVaultDeltas(settlement). The amount
 * by which `reserved` decreases is the same in both cases (the full reservation).
 *
 * The fill receipt's `reserved_released = reservation.amount - actual_spent`
 * (where `actual_spent` is the magnitude of the negative delta on the reserved
 * asset) is computed by the receipt builder in Ticket 11; this function does
 * not produce that value.
 *
 * IMPORTANT: this primitive must be called BEFORE applyVaultDeltas for a given
 * intent. Otherwise applying a negative delta to a balance that still has the
 * reservation locked can transiently violate the reserved <= balances invariant.
 * Ticket 12 will provide a higher-level atomic settlement helper that orders
 * release-then-delta-then-assertInvariants correctly.
 */
export function releaseReservation(
  state: VaultState,
  book: ReservationBook,
  intent_id: string,
  finalStatus: "RELEASED" | "SETTLED"
): { state: VaultState; book: ReservationBook } {
  const idx = book.reservations.findIndex((r) => r.intent_id === intent_id);
  if (idx < 0) {
    throw new Error(`releaseReservation: no reservation for intent ${intent_id}`);
  }
  const r = book.reservations[idx]!;
  if (r.status !== "RESERVED") {
    throw new Error(
      `releaseReservation: reservation ${intent_id} is not RESERVED (status=${r.status})`
    );
  }

  const av = state.agents[r.agent_id];
  if (!av) {
    throw new Error(`releaseReservation: missing agent vault ${r.agent_id}`);
  }

  const newAv: AgentVault = {
    ...av,
    reserved: {
      ...av.reserved,
      [r.asset]: normalizeDecimal(subDecimal(av.reserved[r.asset], r.amount))
    }
  };
  const newState: VaultState = {
    ...state,
    agents: { ...state.agents, [r.agent_id]: newAv }
  };

  const updated: Reservation = { ...r, status: finalStatus };
  const newReservations = [...book.reservations];
  newReservations[idx] = updated;
  // Already sorted because we replaced in place by index.
  return { state: newState, book: { reservations: newReservations } };
}

/**
 * Apply settlement vault_deltas to balances. Each delta is signed.
 *
 * Throws on invariant violation (any resulting balance < 0). Settlement deltas
 * are internal engine output; a violation here indicates a bug or tamper, not
 * normal user behavior.
 */
export function applyVaultDeltas(
  state: VaultState,
  settlement: SettlementObject
): VaultState {
  let next = state;
  for (const d of settlement.vault_deltas) {
    const norm = normalizeAddress(d.agent_id);
    const av = next.agents[norm];
    if (!av) {
      throw new Error(`applyVaultDeltas: missing agent vault ${norm}`);
    }
    const newAv: AgentVault = {
      ...av,
      balances: {
        ...av.balances,
        [d.asset]: normalizeDecimal(applySignedDelta(av.balances[d.asset], d.delta))
      }
    };
    next = { ...next, agents: { ...next.agents, [norm]: newAv } };
  }
  return next;
}
