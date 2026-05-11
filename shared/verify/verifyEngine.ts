/**
 * Verification engine.
 *
 * Pure functions. No state mutation, no I/O. Returns VerifyResult with all
 * failures aggregated (no short-circuiting except where one check structurally
 * blocks another, e.g., signature recovery throwing).
 *
 * Design principle: receipts are claims. The verifier rebuilds the expected
 * claim from canonical supporting artifacts and compares. It does not trust
 * receipt fields at face value.
 *
 * Out of scope for v1:
 *   - Real Eigen attestation chain verification. Only metadata coherence
 *     (LOCAL_MOCK requires null Eigen fields; EIGEN_TEE requires non-null).
 */

import type {
  BatchInput,
  FillPlan,
  SettlementObject,
  VaultState,
  ReservationBook,
  BatchReceipt,
  BatchReceiptBody,
  FillReceipt,
  FillReceiptBody,
  RuntimeMetadata,
  HexAddress,
  VerifyResult,
  VerifyFailure
} from "@shared/schemas";
import {
  recoverBatchReceiptSigner,
  buildBatchReceiptBody
} from "@shared/receipts";
import {
  recoverFillReceiptSigner,
  buildFillReceiptBodies
} from "@shared/receipts";
import { buildSettlementObject } from "@shared/settlement";
import {
  hashSettlement,
  normalizeAddress,
  recoverHashSigner
} from "@shared/crypto";
import { buildVaultPreimage } from "@shared/vault/settlementSigner";
import { cmpDecimal } from "@shared/math/decimal";

// ---- input types -----------------------------------------------------------

export type VerifyBatchReceiptInput = {
  receipt: BatchReceipt;
  batch: BatchInput;
  fillPlan: FillPlan;
  settlement: SettlementObject;
  vaultStateBeforeSettlement: VaultState;
  vaultStateAfterSettlement: VaultState;
  reservationBookBeforeSettlement: ReservationBook;
  reservationBookAfterSettlement: ReservationBook;
  expectedEngineAddress: HexAddress;
};

export type VerifyFillReceiptInput = {
  receipt: FillReceipt;
  batch: BatchInput;
  fillPlan: FillPlan;
  reservationBookBeforeSettlement: ReservationBook;
  expectedEngineAddress: HexAddress;
};

export type VerifyFullBatchInput = {
  batchReceipt: BatchReceipt;
  fillReceipts: readonly FillReceipt[];
  batch: BatchInput;
  fillPlan: FillPlan;
  settlement: SettlementObject;
  vaultStateBeforeSettlement: VaultState;
  vaultStateAfterSettlement: VaultState;
  reservationBookBeforeSettlement: ReservationBook;
  reservationBookAfterSettlement: ReservationBook;
  expectedEngineAddress: HexAddress;
};

// ---- helpers ---------------------------------------------------------------

function checkRuntimeCoherence(rt: RuntimeMetadata): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  if (rt.runtime_mode === "LOCAL_MOCK") {
    if (rt.eigencompute_app_id !== null) {
      failures.push({
        code: "RUNTIME_COHERENCE_INVALID",
        path: "/runtime/eigencompute_app_id",
        detail: "LOCAL_MOCK requires null eigencompute_app_id"
      });
    }
    if (rt.eigencompute_image_digest !== null) {
      failures.push({
        code: "RUNTIME_COHERENCE_INVALID",
        path: "/runtime/eigencompute_image_digest",
        detail: "LOCAL_MOCK requires null eigencompute_image_digest"
      });
    }
    if (rt.eigencompute_attestation_id !== null) {
      failures.push({
        code: "RUNTIME_COHERENCE_INVALID",
        path: "/runtime/eigencompute_attestation_id",
        detail: "LOCAL_MOCK requires null eigencompute_attestation_id"
      });
    }
  } else if (rt.runtime_mode === "EIGEN_TEE") {
    if (rt.eigencompute_app_id === null) {
      failures.push({
        code: "RUNTIME_COHERENCE_INVALID",
        path: "/runtime/eigencompute_app_id",
        detail: "EIGEN_TEE requires non-null eigencompute_app_id"
      });
    }
    if (rt.eigencompute_image_digest === null) {
      failures.push({
        code: "RUNTIME_COHERENCE_INVALID",
        path: "/runtime/eigencompute_image_digest",
        detail: "EIGEN_TEE requires non-null eigencompute_image_digest"
      });
    }
    if (rt.eigencompute_attestation_id === null) {
      failures.push({
        code: "RUNTIME_COHERENCE_INVALID",
        path: "/runtime/eigencompute_attestation_id",
        detail: "EIGEN_TEE requires non-null eigencompute_attestation_id"
      });
    }
  }
  return failures;
}

function runtimeEqual(a: RuntimeMetadata, b: RuntimeMetadata): boolean {
  return (
    a.runtime_mode === b.runtime_mode &&
    a.engine_code_digest === b.engine_code_digest &&
    a.eigencompute_app_id === b.eigencompute_app_id &&
    a.eigencompute_image_digest === b.eigencompute_image_digest &&
    a.eigencompute_attestation_id === b.eigencompute_attestation_id
  );
}

const BATCH_BODY_FIELDS = [
  "batch_id",
  "market",
  "matching_rule",
  "intent_envelope_root",
  "private_payload_commitment_root",
  "vault_state_before_hash",
  "vault_state_after_hash",
  "reservation_book_before_hash",
  "reservation_book_after_hash",
  "settlement_hash",
  "num_intents",
  "num_matched",
  "clearing_price",
  "timestamp_ms"
] as const;

const RUNTIME_FIELDS = [
  "runtime_mode",
  "engine_code_digest",
  "eigencompute_app_id",
  "eigencompute_image_digest",
  "eigencompute_attestation_id"
] as const;

function compareBatchReceiptBody(
  expected: BatchReceiptBody,
  actual: BatchReceipt
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const f of BATCH_BODY_FIELDS) {
    if (expected[f] !== actual[f]) {
      failures.push({
        code: "BATCH_RECEIPT_FIELD_MISMATCH",
        path: `/${f}`,
        detail: `expected ${JSON.stringify(expected[f])}, got ${JSON.stringify(actual[f])}`
      });
    }
  }
  for (const rf of RUNTIME_FIELDS) {
    if (expected.runtime[rf] !== actual.runtime[rf]) {
      failures.push({
        code: "BATCH_RECEIPT_FIELD_MISMATCH",
        path: `/runtime/${rf}`,
        detail: `expected ${JSON.stringify(expected.runtime[rf])}, got ${JSON.stringify(actual.runtime[rf])}`
      });
    }
  }
  return failures;
}

const FILL_BODY_FIELDS = [
  "intent_id",
  "batch_id",
  "agent_id",
  "status",
  "filled_base",
  "filled_quote",
  "clearing_price",
  "constraints_satisfied",
  "unfilled_reason",
  "payload_commitment"
] as const;

function compareFillReceiptBody(
  expected: FillReceiptBody,
  actual: FillReceipt
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const f of FILL_BODY_FIELDS) {
    if (expected[f] !== actual[f]) {
      failures.push({
        code: "FILL_RECEIPT_FIELD_MISMATCH",
        path: `/${f}`,
        detail: `expected ${JSON.stringify(expected[f])}, got ${JSON.stringify(actual[f])}`
      });
    }
  }
  if (expected.reserved_released.ETH !== actual.reserved_released.ETH) {
    failures.push({
      code: "FILL_RECEIPT_FIELD_MISMATCH",
      path: "/reserved_released/ETH",
      detail: `expected ${expected.reserved_released.ETH}, got ${actual.reserved_released.ETH}`
    });
  }
  if (expected.reserved_released.USDC !== actual.reserved_released.USDC) {
    failures.push({
      code: "FILL_RECEIPT_FIELD_MISMATCH",
      path: "/reserved_released/USDC",
      detail: `expected ${expected.reserved_released.USDC}, got ${actual.reserved_released.USDC}`
    });
  }
  for (const rf of RUNTIME_FIELDS) {
    if (expected.runtime[rf] !== actual.runtime[rf]) {
      failures.push({
        code: "FILL_RECEIPT_FIELD_MISMATCH",
        path: `/runtime/${rf}`,
        detail: `expected ${JSON.stringify(expected.runtime[rf])}, got ${JSON.stringify(actual.runtime[rf])}`
      });
    }
  }
  return failures;
}

function pushPrefixed(
  failures: VerifyFailure[],
  prefix: string,
  toAdd: VerifyFailure[]
): void {
  for (const f of toAdd) {
    failures.push({
      ...f,
      path: f.path === null ? prefix : `${prefix}${f.path}`
    });
  }
}

// ---- top-level verifiers ---------------------------------------------------

export function verifyBatchReceipt(input: VerifyBatchReceiptInput): VerifyResult {
  const failures: VerifyFailure[] = [];
  const expectedAddr = normalizeAddress(input.expectedEngineAddress);

  // 1. Signature.
  try {
    const recovered = recoverBatchReceiptSigner(input.receipt);
    if (recovered !== expectedAddr) {
      failures.push({
        code: "ENGINE_SIGNER_MISMATCH",
        path: "/engine_signature",
        detail: `recovered ${recovered} != expected ${expectedAddr}`
      });
    }
  } catch (e) {
    failures.push({
      code: "BATCH_SIGNATURE_INVALID",
      path: "/engine_signature",
      detail: (e as Error).message
    });
  }

  // 2. Runtime coherence.
  failures.push(...checkRuntimeCoherence(input.receipt.runtime));

  // 3. Recompute expected body. Use receipt's runtime so field comparison is
  //    body-only (runtime tampering caught by signature step).
  let expectedBody: BatchReceiptBody | null = null;
  try {
    expectedBody = buildBatchReceiptBody({
      batch: input.batch,
      fillPlan: input.fillPlan,
      settlement: input.settlement,
      vaultStateBeforeSettlement: input.vaultStateBeforeSettlement,
      vaultStateAfterSettlement: input.vaultStateAfterSettlement,
      reservationBookBeforeSettlement: input.reservationBookBeforeSettlement,
      reservationBookAfterSettlement: input.reservationBookAfterSettlement,
      runtime: input.receipt.runtime
    });
  } catch (e) {
    failures.push({
      code: "BUILD_BATCH_RECEIPT_THREW",
      path: null,
      detail: (e as Error).message
    });
  }

  if (expectedBody !== null) {
    failures.push(...compareBatchReceiptBody(expectedBody, input.receipt));
  }

  // 4. V2 on-chain vault signature (optional). If present, must recover to
  //    the same engine address. The preimage is independent of the canonical
  //    receipt body — it's keccak256(abi.encode(...)) over the settlement's
  //    vault_deltas. Mutating either the field itself or any input that
  //    changes the preimage (settlement.vault_deltas, batch_id) breaks
  //    recovery here.
  if (input.receipt.engine_signature_onchain) {
    try {
      const { hash } = buildVaultPreimage(
        input.receipt.batch_id,
        input.settlement.vault_deltas
      );
      const recoveredOnchain = recoverHashSigner(
        hash,
        input.receipt.engine_signature_onchain
      );
      if (recoveredOnchain !== expectedAddr) {
        failures.push({
          code: "ONCHAIN_SIGNER_MISMATCH",
          path: "/engine_signature_onchain",
          detail: `recovered ${recoveredOnchain} != expected ${expectedAddr}`
        });
      }
    } catch (e) {
      failures.push({
        code: "ONCHAIN_SIGNATURE_INVALID",
        path: "/engine_signature_onchain",
        detail: (e as Error).message
      });
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}

export function verifyFillReceipt(input: VerifyFillReceiptInput): VerifyResult {
  const failures: VerifyFailure[] = [];
  const expectedAddr = normalizeAddress(input.expectedEngineAddress);

  // 1. Signature.
  try {
    const recovered = recoverFillReceiptSigner(input.receipt);
    if (recovered !== expectedAddr) {
      failures.push({
        code: "ENGINE_SIGNER_MISMATCH",
        path: "/engine_signature",
        detail: `recovered ${recovered} != expected ${expectedAddr}`
      });
    }
  } catch (e) {
    failures.push({
      code: "FILL_SIGNATURE_INVALID",
      path: "/engine_signature",
      detail: (e as Error).message
    });
  }

  // 2. Runtime coherence.
  failures.push(...checkRuntimeCoherence(input.receipt.runtime));

  // 3. Look up batch intent + fill entry.
  const intent = input.batch.intents.find(
    (i) => i.envelope.intent_id === input.receipt.intent_id
  );
  if (!intent) {
    failures.push({
      code: "FILL_RECEIPT_NO_BATCH_INTENT",
      path: "/intent_id",
      detail: `no batch intent matches ${input.receipt.intent_id}`
    });
  }
  const fill = input.fillPlan.fills.find(
    (f) => f.intent_id === input.receipt.intent_id
  );
  if (!fill) {
    failures.push({
      code: "FILL_RECEIPT_NO_FILL_ENTRY",
      path: "/intent_id",
      detail: `no fill plan entry for ${input.receipt.intent_id}`
    });
  }

  // 4. Recompute expected body if both lookups succeeded.
  if (intent && fill) {
    let expectedBodies: FillReceiptBody[] | null = null;
    try {
      expectedBodies = buildFillReceiptBodies({
        batch: input.batch,
        fillPlan: input.fillPlan,
        reservationBook: input.reservationBookBeforeSettlement,
        runtime: input.receipt.runtime
      });
    } catch (e) {
      failures.push({
        code: "BUILD_FILL_RECEIPT_THREW",
        path: null,
        detail: (e as Error).message
      });
    }
    if (expectedBodies !== null) {
      const expectedBody = expectedBodies.find(
        (b) => b.intent_id === input.receipt.intent_id
      );
      if (expectedBody) {
        failures.push(...compareFillReceiptBody(expectedBody, input.receipt));
      }
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}

export function verifyFullBatch(input: VerifyFullBatchInput): VerifyResult {
  const failures: VerifyFailure[] = [];

  // 1. Verify batch receipt with /batchReceipt prefix.
  const batchResult = verifyBatchReceipt({
    receipt: input.batchReceipt,
    batch: input.batch,
    fillPlan: input.fillPlan,
    settlement: input.settlement,
    vaultStateBeforeSettlement: input.vaultStateBeforeSettlement,
    vaultStateAfterSettlement: input.vaultStateAfterSettlement,
    reservationBookBeforeSettlement: input.reservationBookBeforeSettlement,
    reservationBookAfterSettlement: input.reservationBookAfterSettlement,
    expectedEngineAddress: input.expectedEngineAddress
  });
  if (!batchResult.ok) {
    pushPrefixed(failures, "/batchReceipt", batchResult.failures);
  }

  // 2. Index fill receipts by intent_id; detect duplicates.
  const fillById = new Map<string, FillReceipt>();
  for (const fr of input.fillReceipts) {
    if (fillById.has(fr.intent_id)) {
      failures.push({
        code: "DUPLICATE_FILL_RECEIPT",
        path: `/fillReceipts/${fr.intent_id}`,
        detail: `duplicate fill receipt for intent_id ${fr.intent_id}`
      });
    } else {
      fillById.set(fr.intent_id, fr);
    }
  }

  // 3. One-to-one with batch.intents.
  const batchIds = new Set(input.batch.intents.map((i) => i.envelope.intent_id));
  for (const id of batchIds) {
    if (!fillById.has(id)) {
      failures.push({
        code: "MISSING_FILL_RECEIPT",
        path: `/fillReceipts/${id}`,
        detail: `no fill receipt for batch intent ${id}`
      });
    }
  }
  for (const id of fillById.keys()) {
    if (!batchIds.has(id)) {
      failures.push({
        code: "EXTRA_FILL_RECEIPT",
        path: `/fillReceipts/${id}`,
        detail: `fill receipt for ${id} not in batch`
      });
    }
  }

  // 4. Per-fill verification + cross-checks against the batch receipt.
  for (const fr of input.fillReceipts) {
    if (fr.batch_id !== input.batchReceipt.batch_id) {
      failures.push({
        code: "FILL_RECEIPT_BATCH_ID_MISMATCH",
        path: `/fillReceipts/${fr.intent_id}/batch_id`,
        detail: `fill batch_id ${fr.batch_id} != batch receipt ${input.batchReceipt.batch_id}`
      });
    }
    if (!runtimeEqual(fr.runtime, input.batchReceipt.runtime)) {
      failures.push({
        code: "FILL_RECEIPT_RUNTIME_MISMATCH",
        path: `/fillReceipts/${fr.intent_id}/runtime`,
        detail: "fill receipt runtime does not match batch receipt runtime"
      });
    }
    const r = verifyFillReceipt({
      receipt: fr,
      batch: input.batch,
      fillPlan: input.fillPlan,
      reservationBookBeforeSettlement: input.reservationBookBeforeSettlement,
      expectedEngineAddress: input.expectedEngineAddress
    });
    if (!r.ok) {
      pushPrefixed(failures, `/fillReceipts/${fr.intent_id}`, r.failures);
    }
  }

  // 5. num_matched cross-check.
  const expectedNumMatched = input.fillReceipts.filter(
    (fr) =>
      (fr.status === "FILLED" || fr.status === "PARTIALLY_FILLED") &&
      cmpDecimal(fr.filled_base, "0") > 0
  ).length;
  if (expectedNumMatched !== input.batchReceipt.num_matched) {
    failures.push({
      code: "NUM_MATCHED_INCONSISTENT_WITH_FILL_RECEIPTS",
      path: "/batchReceipt/num_matched",
      detail: `batch receipt num_matched=${input.batchReceipt.num_matched}, fill receipts imply ${expectedNumMatched}`
    });
  }

  // 6. Settlement recomputation.
  try {
    const recomputed = buildSettlementObject(input.batch, input.fillPlan);
    if (hashSettlement(recomputed) !== hashSettlement(input.settlement)) {
      failures.push({
        code: "SETTLEMENT_RECOMPUTE_MISMATCH",
        path: "/settlement",
        detail: "input settlement does not match buildSettlementObject(batch, fillPlan)"
      });
    }
  } catch (e) {
    failures.push({
      code: "SETTLEMENT_RECOMPUTE_FAILED",
      path: "/settlement",
      detail: (e as Error).message
    });
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}
