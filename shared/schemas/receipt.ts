import { z } from "zod";
import { Hex32, Hex65, HexAddress } from "./hex";
import { Market, MatchingRule, FillStatus, UnfilledReason } from "./enums";
import { DecimalString } from "./decimal";
import { AssetBalances } from "./vault";
import { RuntimeMetadata } from "./runtime";

const BatchReceiptBody = z
  .object({
    batch_id: z.string(),
    market: Market,
    matching_rule: MatchingRule,
    intent_envelope_root: Hex32,
    private_payload_commitment_root: Hex32,
    vault_state_before_hash: Hex32,
    vault_state_after_hash: Hex32,
    reservation_book_before_hash: Hex32,
    reservation_book_after_hash: Hex32,
    settlement_hash: Hex32,
    num_intents: z.number().int().nonnegative(),
    num_matched: z.number().int().nonnegative(),
    clearing_price: DecimalString,
    timestamp_ms: z.number().int().positive(),
    runtime: RuntimeMetadata
  })
  .strict();
export type BatchReceiptBody = z.infer<typeof BatchReceiptBody>;

export const BatchReceipt = BatchReceiptBody.extend({
  engine_signature: Hex65,
  /**
   * V2 stage 1: engine signature over the on-chain vault-settlement preimage
   * keccak256(abi.encode(batchIdBytes32, agents[], ethDeltas[], usdcDeltas[])).
   * Optional so existing v1 bundles (which predate vault integration) still
   * parse cleanly. When present, anyone can call HecateVault.settleBatch(...)
   * with the corresponding deltas to apply the settlement on-chain.
   * See shared/vault/settlementSigner.ts and contracts/HecateVault.sol.
   */
  engine_signature_onchain: Hex65.optional()
}).strict();
export type BatchReceipt = z.infer<typeof BatchReceipt>;

const FillReceiptBody = z
  .object({
    intent_id: z.string(),
    batch_id: z.string(),
    agent_id: HexAddress,
    status: FillStatus,
    filled_base: DecimalString,
    filled_quote: DecimalString,
    clearing_price: DecimalString,
    constraints_satisfied: z.boolean(),
    unfilled_reason: UnfilledReason.nullable(),
    payload_commitment: Hex32,
    reserved_released: AssetBalances,
    runtime: RuntimeMetadata
  })
  .strict();
export type FillReceiptBody = z.infer<typeof FillReceiptBody>;

export const FillReceipt = FillReceiptBody.extend({
  engine_signature: Hex65
}).strict();
export type FillReceipt = z.infer<typeof FillReceipt>;

// Re-export the unsigned bodies for the receipt-construction code (Ticket 13/11),
// which signs over the canonical-JSON of the body.
export { BatchReceiptBody, FillReceiptBody };
