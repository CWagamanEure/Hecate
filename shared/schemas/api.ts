import { z } from "zod";
import { HexAddress, Hex65 } from "./hex";
import { Asset } from "./enums";
import { DecimalString } from "./decimal";
import { BatchInput, MarketSnapshot } from "./batch";
import { FillPlan } from "./fillPlan";
import { SettlementObject } from "./settlement";
import { VaultState } from "./vault";
import { ReservationBook } from "./reservation";
import { BatchReceipt, FillReceipt } from "./receipt";

export const MockDepositRequest = z
  .object({
    agent_id: HexAddress,
    asset: Asset,
    amount: DecimalString
  })
  .strict();
export type MockDepositRequest = z.infer<typeof MockDepositRequest>;

export const MockWithdrawRequest = z
  .object({
    agent_id: HexAddress,
    asset: Asset,
    amount: DecimalString
  })
  .strict();
export type MockWithdrawRequest = z.infer<typeof MockWithdrawRequest>;

/** Owner-gated access challenge. Used by POST /intents/:id/fill-receipt and
 *  POST /intents/:id/status. Challenge action is fixed per endpoint. */
export const SignedChallengeRequest = z
  .object({
    requester: HexAddress,
    timestamp_ms: z.number().int().positive(),
    signature: Hex65
  })
  .strict();
export type SignedChallengeRequest = z.infer<typeof SignedChallengeRequest>;

export const CloseBatchRequest = z
  .object({
    batch_id: z.string().regex(/^batch_[A-Za-z0-9_-]{1,64}$/).optional(),
    market_snapshot: MarketSnapshot.nullable().optional()
  })
  .strict();
export type CloseBatchRequest = z.infer<typeof CloseBatchRequest>;

export const VerifyFullBatchRequest = z
  .object({
    batchReceipt: BatchReceipt,
    fillReceipts: z.array(FillReceipt),
    batch: BatchInput,
    fillPlan: FillPlan,
    settlement: SettlementObject,
    vaultStateBeforeSettlement: VaultState,
    vaultStateAfterSettlement: VaultState,
    reservationBookBeforeSettlement: ReservationBook,
    reservationBookAfterSettlement: ReservationBook,
    expectedEngineAddress: HexAddress
  })
  .strict();
export type VerifyFullBatchRequest = z.infer<typeof VerifyFullBatchRequest>;
