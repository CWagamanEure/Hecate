import { z } from "zod";

export const Asset = z.enum(["ETH", "USDC"]);
export type Asset = z.infer<typeof Asset>;

export const Side = z.enum(["BUY", "SELL"]);
export type Side = z.infer<typeof Side>;

// v1 hardcodes a single market.
export const Market = z.literal("ETH/USDC");
export type Market = z.infer<typeof Market>;

export const RuntimeMode = z.enum(["LOCAL_MOCK", "EIGEN_TEE"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export const MatchingRule = z.literal("UNIFORM_CLEARING_PRICE_V1");
export type MatchingRule = z.infer<typeof MatchingRule>;

// Lifecycle status of an intent within the engine.
export const IntentStatus = z.enum([
  "OPEN",
  "BATCHED",
  "FILLED",
  "PARTIALLY_FILLED",
  "UNFILLED",
  "EXPIRED",
  "REJECTED"
]);
export type IntentStatus = z.infer<typeof IntentStatus>;

// Per-fill-receipt status.
export const FillStatus = z.enum([
  "FILLED",
  "PARTIALLY_FILLED",
  "UNFILLED",
  "EXPIRED",
  "INVALID",
  "INSUFFICIENT_FUNDS"
]);
export type FillStatus = z.infer<typeof FillStatus>;

// Reasons an intent is rejected at submission (never enters a batch).
export const RejectReason = z.enum([
  "INVALID_SIGNATURE",
  "INVALID_PAYLOAD_COMMITMENT",
  "DUPLICATE_NONCE",
  "EXPIRED",
  "UNKNOWN_AGENT",
  "MALFORMED_PAYLOAD",
  "ASSET_DIRECTION_MISMATCH",
  "UNSUPPORTED_MARKET",
  "INSUFFICIENT_FUNDS"
]);
export type RejectReason = z.infer<typeof RejectReason>;

// Reasons an intent fails to fill or partially fills inside a batch.
export const UnfilledReason = z.enum([
  "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT",
  "MIN_FILL_NOT_MET",
  "MAX_PRICE_IMPACT_VIOLATED",
  "EXPIRED_BEFORE_FILL",
  "BATCH_FAILED"
]);
export type UnfilledReason = z.infer<typeof UnfilledReason>;
