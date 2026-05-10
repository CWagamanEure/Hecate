/**
 * applySettlement — orchestrator for the post-batch state transition.
 *
 *   1. Build SettlementObject (validates structural and conservation invariants).
 *   2. For each batch intent, release its reservation:
 *        SETTLED for FILLED/PARTIALLY_FILLED with filled_base > 0
 *        RELEASED otherwise (UNFILLED / BATCH_FAILED / zero-fill defensive)
 *   3. Apply vault_deltas to balances (throws on negative balance — engine bug).
 *   4. Assert vault and reservation invariants.
 *
 * Pure: input vault and reservation book are not mutated; returned values are
 * new objects.
 *
 * Throws on:
 *   - missing fill for a batch intent
 *   - missing reservation for a batch intent (via releaseReservation)
 *   - any error propagated from buildSettlementObject, applyVaultDeltas, or
 *     assertVaultInvariants
 */

import type {
  BatchInput,
  FillPlan,
  FillEntry,
  SettlementObject,
  VaultState,
  ReservationBook
} from "@shared/schemas";
import {
  releaseReservation,
  applyVaultDeltas,
  assertVaultInvariants
} from "@shared/vault";
import { buildSettlementObject } from "./buildSettlement";
import { cmpDecimal } from "@shared/math/decimal";

export type ApplySettlementInput = {
  batch: BatchInput;
  fillPlan: FillPlan;
  vaultStateBeforeSettlement: VaultState;
  reservationBookBeforeSettlement: ReservationBook;
};

export type ApplySettlementResult = {
  settlement: SettlementObject;
  vault_state_after_settlement: VaultState;
  reservation_book_after_settlement: ReservationBook;
};

export function applySettlement(
  input: ApplySettlementInput
): ApplySettlementResult {
  const settlement = buildSettlementObject(input.batch, input.fillPlan);

  const fillById = new Map<string, FillEntry>();
  for (const f of input.fillPlan.fills) fillById.set(f.intent_id, f);

  let vault = input.vaultStateBeforeSettlement;
  let book = input.reservationBookBeforeSettlement;

  for (const intent of input.batch.intents) {
    const id = intent.envelope.intent_id;
    const fill = fillById.get(id);
    if (!fill) {
      throw new Error(`applySettlement: missing fill for intent ${id}`);
    }
    const filledIsPositive =
      cmpDecimal(fill.filled_base, "0") > 0;
    const finalStatus: "SETTLED" | "RELEASED" =
      (fill.status === "FILLED" || fill.status === "PARTIALLY_FILLED") &&
      filledIsPositive
        ? "SETTLED"
        : "RELEASED";
    const r = releaseReservation(vault, book, id, finalStatus);
    vault = r.state;
    book = r.book;
  }

  vault = applyVaultDeltas(vault, settlement);

  assertVaultInvariants(vault, book);

  return {
    settlement,
    vault_state_after_settlement: vault,
    reservation_book_after_settlement: book
  };
}
