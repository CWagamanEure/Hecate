/**
 * Tamper scenarios for the verifier replay CLI.
 *
 * Each tamper takes a parsed VerifyFullBatchRequest bundle and returns:
 *   - a mutated copy of the bundle (the original is never modified)
 *   - a one-line description of the mutation
 *   - a one-paragraph "what this demonstrates" footer
 *   - the failure code(s) the verifier is expected to emit
 *
 * Tampers are pure. The CLI imports them, applies one, calls verifyFullBatch,
 * and pretty-prints the result. Tests assert the expected failure codes appear.
 */

import type {
  VerifyFullBatchRequest,
  BatchReceipt,
  FillReceipt
} from "@shared/schemas";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { signBatchReceipt } from "@shared/receipts";

export type TamperResult = {
  bundle: VerifyFullBatchRequest;
  description: string;
  demonstrates: string;
  expectedCodes: string[];
};

export type Tamper = (b: VerifyFullBatchRequest) => TamperResult;

/** Deep-clone via structuredClone (Node 17+). */
function clone<T>(v: T): T {
  return structuredClone(v);
}

function flipFirstHexChar(hex: string): string {
  // hex starts with "0x"; flip the first hex character of the body.
  const c = hex[2];
  const flipped = c === "0" ? "1" : "0";
  return hex.slice(0, 2) + flipped + hex.slice(3);
}

function flipByteAt(hex: string, byteIndex: number): string {
  // hex like "0x..." — byteIndex is the 0-based byte offset in the body.
  const bytes = hexToBytes(hex.slice(2));
  bytes[byteIndex] = bytes[byteIndex]! ^ 0x01;
  return "0x" + bytesToHex(bytes);
}

const HEX_BAD = ("0x" + "f".repeat(64)) as `0x${string}`;

// ---- scenario implementations ----------------------------------------------

const tamperClearingPrice: Tamper = (b) => {
  const orig = b.batchReceipt.clearing_price;
  const out = clone(b);
  out.batchReceipt = { ...out.batchReceipt, clearing_price: "9999" };
  return {
    bundle: out,
    description: `/batchReceipt/clearing_price : "${orig}" -> "9999"`,
    demonstrates:
      "Mutating any signed-over field invalidates the engine signature; structural recompute also catches the value mismatch.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperVaultAfterHash: Tamper = (b) => {
  const orig = b.batchReceipt.vault_state_after_hash;
  const out = clone(b);
  out.batchReceipt = { ...out.batchReceipt, vault_state_after_hash: HEX_BAD };
  return {
    bundle: out,
    description: `/batchReceipt/vault_state_after_hash : ${orig} -> ${HEX_BAD}`,
    demonstrates:
      "The post-settlement vault state is bound to the receipt by hash. Any change is detected.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperReservationAfterHash: Tamper = (b) => {
  const orig = b.batchReceipt.reservation_book_after_hash;
  const out = clone(b);
  out.batchReceipt = {
    ...out.batchReceipt,
    reservation_book_after_hash: HEX_BAD
  };
  return {
    bundle: out,
    description: `/batchReceipt/reservation_book_after_hash : ${orig} -> ${HEX_BAD}`,
    demonstrates:
      "The reservation book transition is committed alongside vault state.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperSettlementHash: Tamper = (b) => {
  const orig = b.batchReceipt.settlement_hash;
  const out = clone(b);
  out.batchReceipt = { ...out.batchReceipt, settlement_hash: HEX_BAD };
  return {
    bundle: out,
    description: `/batchReceipt/settlement_hash : ${orig} -> ${HEX_BAD}`,
    demonstrates: "The settlement object is bound to the receipt by hash.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperIntentEnvelopeRoot: Tamper = (b) => {
  const orig = b.batchReceipt.intent_envelope_root;
  const out = clone(b);
  out.batchReceipt = { ...out.batchReceipt, intent_envelope_root: HEX_BAD };
  return {
    bundle: out,
    description: `/batchReceipt/intent_envelope_root : ${orig} -> ${HEX_BAD}`,
    demonstrates:
      "The set of public envelopes processed in the batch is bound to the receipt.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperFillBase: Tamper = (b) => {
  if (b.fillReceipts.length === 0) {
    throw new Error("fill-base scenario requires at least one fill receipt");
  }
  const out = clone(b);
  const orig = out.fillReceipts[0]!.filled_base;
  out.fillReceipts[0]!.filled_base = orig === "10" ? "9" : "0";
  return {
    bundle: out,
    description: `/fillReceipts[0]/filled_base : "${orig}" -> "${out.fillReceipts[0]!.filled_base}"`,
    demonstrates:
      "Per-agent fill receipts are bound the same way as the public batch receipt.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "FILL_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperReservedReleased: Tamper = (b) => {
  if (b.fillReceipts.length === 0) {
    throw new Error("reserved-released scenario requires at least one fill receipt");
  }
  const out = clone(b);
  const orig = out.fillReceipts[0]!.reserved_released.ETH;
  out.fillReceipts[0]!.reserved_released = {
    ...out.fillReceipts[0]!.reserved_released,
    ETH: "999"
  };
  return {
    bundle: out,
    description: `/fillReceipts[0]/reserved_released/ETH : "${orig}" -> "999"`,
    demonstrates:
      "Vault residual release is part of the integrity story, not free-form metadata.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "FILL_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperSignatureBytes: Tamper = (b) => {
  const out = clone(b);
  const orig = out.batchReceipt.engine_signature;
  out.batchReceipt = {
    ...out.batchReceipt,
    engine_signature: flipFirstHexChar(orig) as `0x${string}`
  };
  return {
    bundle: out,
    description: `/batchReceipt/engine_signature : <flipped first hex char>`,
    demonstrates:
      "Either recovery returns a different signer (mismatch) or the byte flip makes the curve point invalid (signature invalid). Both are correctly rejected.",
    // One of these will fire depending on whether the flipped point lies on the curve.
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "BATCH_SIGNATURE_INVALID"]
  };
};

const tamperWrongKey: Tamper = (b) => {
  const otherPk = "0x" + "0".repeat(63) + "9";
  const out = clone(b);
  // Take the existing body and re-sign with a different key.
  const { engine_signature: _drop, ...body } = out.batchReceipt;
  const reSigned = signBatchReceipt(body, otherPk);
  out.batchReceipt = reSigned;
  return {
    bundle: out,
    description: `/batchReceipt re-signed with a different secp256k1 key`,
    demonstrates:
      "Authority binding: even when structural fields all match (same body, consistent signature), the recovered signer does not match expectedEngineAddress.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH"]
  };
};

const tamperSwapFillBody: Tamper = (b) => {
  if (b.fillReceipts.length < 2) {
    throw new Error("swap-fill-receipt-body scenario requires at least 2 fill receipts");
  }
  const out = clone(b);
  // Take fillReceipts[0]'s signature; replace its body with fillReceipts[1]'s body fields.
  const fr0 = out.fillReceipts[0]!;
  const fr1 = out.fillReceipts[1]!;
  const { engine_signature, ...fr1Body } = fr1;
  out.fillReceipts[0] = {
    ...fr1Body,
    engine_signature: fr0.engine_signature
  } as FillReceipt;
  return {
    bundle: out,
    description: `/fillReceipts[0] body replaced with /fillReceipts[1] body, keeping original signature`,
    demonstrates:
      "Per-receipt signature scope: a signature for receipt A does not authorize receipt B.",
    expectedCodes: ["ENGINE_SIGNER_MISMATCH", "DUPLICATE_FILL_RECEIPT"]
  };
};

const tamperVaultSupporting: Tamper = (b) => {
  const out = clone(b);
  const agents = Object.keys(out.vaultStateAfterSettlement.agents);
  if (agents.length === 0) {
    throw new Error("tamper-vault-supporting requires at least one agent in vault");
  }
  const addr = agents[0]!;
  const orig = out.vaultStateAfterSettlement.agents[addr]!.balances.ETH;
  out.vaultStateAfterSettlement.agents[addr]!.balances.ETH = "999";
  return {
    bundle: out,
    description: `vaultStateAfterSettlement.agents[${addr}].balances.ETH : "${orig}" -> "999"`,
    demonstrates:
      "The verifier rehashes supporting artifacts; mutating the underlying state (not the receipt's hash field) is detected by the recompute path.",
    expectedCodes: ["BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperSettlementDeltas: Tamper = (b) => {
  const out = clone(b);
  out.settlement = { ...out.settlement, vault_deltas: [] };
  return {
    bundle: out,
    description: `settlement.vault_deltas : <emptied>`,
    demonstrates:
      "Settlement is recomputed from batch + fillPlan and compared by hash; any divergence is caught.",
    expectedCodes: ["SETTLEMENT_RECOMPUTE_MISMATCH", "BATCH_RECEIPT_FIELD_MISMATCH"]
  };
};

const tamperMissingFillReceipt: Tamper = (b) => {
  if (b.fillReceipts.length === 0) {
    throw new Error("missing-fill-receipt requires at least one fill receipt");
  }
  const out = clone(b);
  const dropped = out.fillReceipts[0]!.intent_id;
  out.fillReceipts = out.fillReceipts.slice(1);
  return {
    bundle: out,
    description: `dropped /fillReceipts entry for ${dropped}`,
    demonstrates:
      "Every batch intent must have exactly one fill receipt. A missing receipt is detected.",
    expectedCodes: ["MISSING_FILL_RECEIPT"]
  };
};

const tamperRuntimeIncoherent: Tamper = (b) => {
  const out = clone(b);
  out.batchReceipt = {
    ...out.batchReceipt,
    runtime: {
      ...out.batchReceipt.runtime,
      runtime_mode: "EIGEN_TEE"
    }
  };
  return {
    bundle: out,
    description: `/batchReceipt/runtime/runtime_mode : "LOCAL_MOCK" -> "EIGEN_TEE" (with eigen fields still null)`,
    demonstrates:
      "EIGEN_TEE requires all eigen metadata fields to be non-null. Coherence is checked independently of signature recovery.",
    expectedCodes: ["RUNTIME_COHERENCE_INVALID"]
  };
};

// ---- registry --------------------------------------------------------------

export const TAMPERS: Record<string, Tamper> = {
  "clearing-price": tamperClearingPrice,
  "vault-after-hash": tamperVaultAfterHash,
  "reservation-after-hash": tamperReservationAfterHash,
  "settlement-hash": tamperSettlementHash,
  "intent-envelope-root": tamperIntentEnvelopeRoot,
  "fill-base": tamperFillBase,
  "reserved-released": tamperReservedReleased,
  "signature-bytes": tamperSignatureBytes,
  "wrong-key": tamperWrongKey,
  "swap-fill-receipt-body": tamperSwapFillBody,
  "tamper-vault-supporting": tamperVaultSupporting,
  "tamper-settlement-deltas": tamperSettlementDeltas,
  "missing-fill-receipt": tamperMissingFillReceipt,
  "runtime-eigen-incoherent": tamperRuntimeIncoherent
};

export const SCENARIO_NAMES = Object.keys(TAMPERS) as readonly (keyof typeof TAMPERS)[];
