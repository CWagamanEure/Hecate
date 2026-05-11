/**
 * Batch receipt builder.
 *
 * Pure transform from (BatchInput + FillPlan + SettlementObject + vault and
 * reservation snapshots before/after settlement + RuntimeMetadata + engine key)
 * into a signed BatchReceipt.
 *
 * Pure: no vault mutation, no fill receipts, no persistence.
 *
 * Validation runs structural checks first, then a defensive payload commitment
 * cross-check, then settlement consistency, then hashing. The commitment
 * cross-check is duplicated with acceptIntent and the fill receipt builder
 * intentionally — the batch receipt is a security boundary and its
 * private_payload_commitment_root must not be derived from payloads that
 * disagree with the public envelopes.
 */

import type {
  BatchInput,
  FillPlan,
  FillEntry,
  SettlementObject,
  VaultState,
  ReservationBook,
  RuntimeMetadata,
  BatchReceipt,
  BatchReceiptBody,
  HexAddress,
  Hex32
} from "@shared/schemas";
import {
  hashPayload,
  hashVaultState,
  hashReservationBook,
  hashSettlement,
  hashBatchReceiptBody,
  orderedAggregateHash,
  signHash,
  recoverHashSigner
} from "@shared/crypto";
import { signVaultSettlement } from "@shared/vault/settlementSigner";
import { cmpDecimal } from "@shared/math/decimal";

export type BuildBatchReceiptInput = {
  batch: BatchInput;
  fillPlan: FillPlan;
  settlement: SettlementObject;
  vaultStateBeforeSettlement: VaultState;
  vaultStateAfterSettlement: VaultState;
  reservationBookBeforeSettlement: ReservationBook;
  reservationBookAfterSettlement: ReservationBook;
  runtime: RuntimeMetadata;
  engineKey: Hex32 | Uint8Array;
};

/** Pure transform: validates and computes hashes; returns the unsigned body. */
export function buildBatchReceiptBody(
  input: Omit<BuildBatchReceiptInput, "engineKey">
): BatchReceiptBody {
  const { batch, fillPlan, settlement } = input;

  // 1. Duplicate batch intent_id.
  const batchIds = new Set<string>();
  for (const intent of batch.intents) {
    const id = intent.envelope.intent_id;
    if (batchIds.has(id)) {
      throw new Error(
        `buildBatchReceiptBody: duplicate intent_id in batch: ${id}`
      );
    }
    batchIds.add(id);
  }

  // 2. Duplicate fill intent_id.
  const fillById = new Map<string, FillEntry>();
  for (const f of fillPlan.fills) {
    if (fillById.has(f.intent_id)) {
      throw new Error(
        `buildBatchReceiptBody: duplicate fill intent_id: ${f.intent_id}`
      );
    }
    fillById.set(f.intent_id, f);
  }

  // 3. Every batch intent has a fill.
  for (const intent of batch.intents) {
    const id = intent.envelope.intent_id;
    if (!fillById.has(id)) {
      throw new Error(`buildBatchReceiptBody: missing fill for intent ${id}`);
    }
  }

  // 4. Every fill id is in the batch.
  for (const id of fillById.keys()) {
    if (!batchIds.has(id)) {
      throw new Error(
        `buildBatchReceiptBody: fill ${id} not present in batch`
      );
    }
  }

  // 5. Defensive: payload commitment matches envelope.
  for (const intent of batch.intents) {
    const computed = hashPayload(intent.payload);
    if (computed !== intent.envelope.payload_commitment) {
      throw new Error(
        `buildBatchReceiptBody: payload commitment mismatch for intent ${intent.envelope.intent_id}`
      );
    }
  }

  // 6. settlement.batch_id matches.
  if (settlement.batch_id !== batch.batch_id) {
    throw new Error(
      `buildBatchReceiptBody: settlement.batch_id ${settlement.batch_id} != batch.batch_id ${batch.batch_id}`
    );
  }

  // 7. settlement.market matches.
  if (settlement.market !== batch.market) {
    throw new Error(
      `buildBatchReceiptBody: settlement.market mismatch (settlement=${settlement.market}, batch=${batch.market})`
    );
  }

  // 8. settlement.clearing_price matches fillPlan.
  if (settlement.clearing_price !== fillPlan.clearing_price) {
    throw new Error(
      `buildBatchReceiptBody: settlement.clearing_price ${settlement.clearing_price} != fillPlan.clearing_price ${fillPlan.clearing_price}`
    );
  }

  // 9. Compute hashes. Roots use BatchInput order (no sortBy). This preserves
  //    canonical price-time order; switching to sortBy would be a breaking
  //    protocol change.
  const envelopes = batch.intents.map((i) => i.envelope);
  const commitments = batch.intents.map((i) => hashPayload(i.payload));

  const intent_envelope_root = orderedAggregateHash(envelopes);
  const private_payload_commitment_root = orderedAggregateHash(commitments);
  const vault_state_before_hash = hashVaultState(input.vaultStateBeforeSettlement);
  const vault_state_after_hash = hashVaultState(input.vaultStateAfterSettlement);
  const reservation_book_before_hash = hashReservationBook(input.reservationBookBeforeSettlement);
  const reservation_book_after_hash = hashReservationBook(input.reservationBookAfterSettlement);
  const settlement_hash = hashSettlement(settlement);

  const num_intents = batch.intents.length;
  const num_matched = fillPlan.fills.filter(
    (f) =>
      (f.status === "FILLED" || f.status === "PARTIALLY_FILLED") &&
      cmpDecimal(f.filled_base, "0") > 0
  ).length;

  return {
    batch_id: batch.batch_id,
    market: batch.market,
    matching_rule: "UNIFORM_CLEARING_PRICE_V1",
    intent_envelope_root,
    private_payload_commitment_root,
    vault_state_before_hash,
    vault_state_after_hash,
    reservation_book_before_hash,
    reservation_book_after_hash,
    settlement_hash,
    num_intents,
    num_matched,
    clearing_price: fillPlan.clearing_price,
    timestamp_ms: batch.timestamp_ms,
    runtime: { ...input.runtime }
  };
}

/** Sign a batch receipt body. Returns the signed BatchReceipt. */
export function signBatchReceipt(
  body: BatchReceiptBody,
  engineKey: Hex32 | Uint8Array
): BatchReceipt {
  const hash = hashBatchReceiptBody(body);
  const engine_signature = signHash(hash, engineKey);
  return { ...body, engine_signature };
}

/** Recover the engine signer. hashBatchReceiptBody strips engine_signature
 *  defensively so signed receipts work as input. */
export function recoverBatchReceiptSigner(receipt: BatchReceipt): HexAddress {
  const hash = hashBatchReceiptBody(receipt);
  return recoverHashSigner(hash, receipt.engine_signature);
}

/** Convenience: build body + sign in one call.
 *
 * If the settlement has any vault_deltas, also attaches the V2 on-chain
 * settlement signature (engine_signature_onchain). This lives here, not
 * at the route boundary, so every consumer of buildBatchReceipt produces
 * the same receipt shape. Without it, the verifier's
 * ONCHAIN_SIGNATURE_REQUIRED check would reject test fixtures built via
 * buildBatchReceipt for batches with non-empty vault_deltas.
 */
export function buildBatchReceipt(input: BuildBatchReceiptInput): BatchReceipt {
  const body = buildBatchReceiptBody(input);
  const canonical = signBatchReceipt(body, input.engineKey);
  if (input.settlement.vault_deltas.length === 0) return canonical;
  const { signature: engine_signature_onchain } = signVaultSettlement(
    input.batch.batch_id,
    input.settlement.vault_deltas,
    input.engineKey
  );
  return { ...canonical, engine_signature_onchain };
}
