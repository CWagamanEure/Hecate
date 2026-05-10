import { z } from "zod";
import { Asset, Side } from "./enums";
import { DecimalString, decCmp } from "./decimal";

// All sizing is in the base asset (ETH) regardless of side. limit_price is quote
// per base (USDC per ETH). For BUY, asset_in=USDC and the agent's reservation is
// max_base_amount * limit_price in USDC. For SELL, asset_in=ETH and the
// reservation is max_base_amount in ETH.
export const PrivatePayload = z
  .object({
    side: Side,
    asset_in: Asset,
    asset_out: Asset,
    max_base_amount: DecimalString,
    limit_price: DecimalString,
    allow_partial_fill: z.boolean(),
    // In base asset (ETH). When allow_partial_fill is false, this MUST equal
    // max_base_amount (all-or-nothing).
    min_base_fill_amount: DecimalString,
    deadline_batches: z.number().int().nonnegative(),
    max_price_impact_bps: z.number().int().nonnegative(),
    fallback_after_batches: z.number().int().nonnegative().nullable(),
    nonce: z.string().min(1)
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.asset_in === p.asset_out) {
      ctx.addIssue({
        code: "custom",
        message: "asset_in must differ from asset_out",
        path: ["asset_in"]
      });
    }
    // BUY: pay USDC, receive ETH. SELL: pay ETH, receive USDC.
    if (p.side === "BUY" && (p.asset_in !== "USDC" || p.asset_out !== "ETH")) {
      ctx.addIssue({
        code: "custom",
        message: "BUY must have asset_in=USDC, asset_out=ETH",
        path: ["side"]
      });
    }
    if (p.side === "SELL" && (p.asset_in !== "ETH" || p.asset_out !== "USDC")) {
      ctx.addIssue({
        code: "custom",
        message: "SELL must have asset_in=ETH, asset_out=USDC",
        path: ["side"]
      });
    }
    if (decCmp(p.max_base_amount, "0") === 0) {
      ctx.addIssue({
        code: "custom",
        message: "max_base_amount must be > 0",
        path: ["max_base_amount"]
      });
    }
    if (decCmp(p.limit_price, "0") === 0) {
      ctx.addIssue({
        code: "custom",
        message: "limit_price must be > 0",
        path: ["limit_price"]
      });
    }
    if (decCmp(p.min_base_fill_amount, p.max_base_amount) > 0) {
      ctx.addIssue({
        code: "custom",
        message: "min_base_fill_amount must be ≤ max_base_amount",
        path: ["min_base_fill_amount"]
      });
    }
    if (
      !p.allow_partial_fill &&
      decCmp(p.min_base_fill_amount, p.max_base_amount) !== 0
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "when allow_partial_fill=false, min_base_fill_amount must equal max_base_amount",
        path: ["min_base_fill_amount"]
      });
    }
  });

export type PrivatePayload = z.infer<typeof PrivatePayload>;
