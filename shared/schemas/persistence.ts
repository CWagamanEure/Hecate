import { z } from "zod";
import { PublicEnvelope } from "./intent";
import { BatchReceipt } from "./receipt";
import { SettlementObject } from "./settlement";
import { RejectReason } from "./enums";

/**
 * intents.jsonl — one entry per ACCEPTED intent. Status changes are not
 * recorded here; status is derived by joining against batches.jsonl /
 * receipts.jsonl. Rejected intents go to rejections.jsonl.
 */
export const PersistedIntentRecord = z
  .object({
    envelope: PublicEnvelope,
    received_ms: z.number().int().positive()
  })
  .strict();
export type PersistedIntentRecord = z.infer<typeof PersistedIntentRecord>;

/** rejections.jsonl — one entry per REJECTED intent. */
export const PersistedRejection = z
  .object({
    envelope: PublicEnvelope,
    received_ms: z.number().int().positive(),
    reject_reason: RejectReason,
    detail: z.string()
  })
  .strict();
export type PersistedRejection = z.infer<typeof PersistedRejection>;

/**
 * batches.jsonl — one entry per closed batch. The batch receipt and settlement
 * live here; per-agent fill receipts live in receipts.jsonl, joined by intent_id.
 */
export const PersistedBatchRecord = z
  .object({
    batch_receipt: BatchReceipt,
    settlement: SettlementObject,
    fill_receipt_intent_ids: z.array(z.string())
  })
  .strict();
export type PersistedBatchRecord = z.infer<typeof PersistedBatchRecord>;

// receipts.jsonl uses FillReceipt directly — no wrapper needed.
// vault.json uses VaultState directly. reservations.json uses ReservationBook.
