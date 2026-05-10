import { z } from "zod";
import { DecimalString } from "./decimal";
import { FillStatus, UnfilledReason } from "./enums";

export const FillEntry = z
  .object({
    intent_id: z.string(),
    filled_base: DecimalString,
    filled_quote: DecimalString,
    status: FillStatus,
    unfilled_reason: UnfilledReason.nullable()
  })
  .strict();
export type FillEntry = z.infer<typeof FillEntry>;

export const FillPlan = z
  .object({
    clearing_price: DecimalString,
    fills: z.array(FillEntry)
  })
  .strict();
export type FillPlan = z.infer<typeof FillPlan>;
