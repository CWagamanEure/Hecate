import { z } from "zod";
import { Market } from "./enums";
import { PublicEnvelope } from "./intent";
import { PrivatePayload } from "./payload";
import { DecimalString } from "./decimal";

export const MarketSnapshot = z
  .object({
    market: Market,
    reference_price: DecimalString,
    timestamp_ms: z.number().int().positive()
  })
  .strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

// BatchInput is pure matcher input. Vault and reservation snapshots belong to
// the settlement/receipt orchestration layer and are not carried here.
export const BatchInput = z
  .object({
    batch_id: z.string().regex(/^batch_[A-Za-z0-9_-]{1,64}$/),
    market: Market,
    intents: z.array(
      z
        .object({
          envelope: PublicEnvelope,
          payload: PrivatePayload
        })
        .strict()
    ),
    market_snapshot: MarketSnapshot.nullable(),
    timestamp_ms: z.number().int().positive()
  })
  .strict();
export type BatchInput = z.infer<typeof BatchInput>;
