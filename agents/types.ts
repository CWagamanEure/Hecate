/**
 * CLI-internal fixture schemas for the demo simulator.
 *
 * Not a protocol boundary — these are local files that drive the simulator
 * and let it self-validate against locked-in expected outcomes.
 */

import { z } from "zod";
import { Hex32, DecimalString, Asset, Side } from "@shared/schemas";

export const AgentDeposit = z
  .object({
    asset: Asset,
    amount: DecimalString
  })
  .strict();

export const AgentIntentSpec = z
  .object({
    side: Side,
    asset_in: Asset,
    asset_out: Asset,
    max_base_amount: DecimalString,
    limit_price: DecimalString,
    allow_partial_fill: z.boolean(),
    min_base_fill_amount: DecimalString,
    deadline_batches: z.number().int().nonnegative(),
    max_price_impact_bps: z.number().int().nonnegative(),
    fallback_after_batches: z.number().int().nonnegative().nullable()
  })
  .strict();

export const AgentExpectedOutcome = z
  .object({
    accepted: z.boolean(),
    reject_reason: z.string().nullable(),
    final_status: z.string().nullable(),
    final_filled_base: DecimalString.nullable(),
    final_balance_eth: DecimalString.nullable(),
    final_balance_usdc: DecimalString.nullable(),
    // Optional. When the intent ends UNFILLED, the simulator asserts the fill
    // receipt's unfilled_reason matches this value. Null / omitted when the
    // intent is filled, partially filled, or rejected (so the canonical
    // 4-agent fixtures don't need this field).
    expected_unfilled_reason: z.string().nullable().optional()
  })
  .strict();

export const AgentFixture = z
  .object({
    name: z.string(),
    private_key: Hex32,
    deposits: z.array(AgentDeposit),
    intent: AgentIntentSpec,
    expected_outcome: AgentExpectedOutcome
  })
  .strict();

export type AgentFixture = z.infer<typeof AgentFixture>;
export type AgentExpectedOutcome = z.infer<typeof AgentExpectedOutcome>;
