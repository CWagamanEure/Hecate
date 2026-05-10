/**
 * buildBatchFromReadyIntents — pure deterministic packager.
 *
 * Takes already-accepted ReadyIntents (which passed the full acceptIntent
 * pipeline at submission time) and packages them into a BatchInput for the
 * matcher. No decryption, no verification, no reservation — those happened
 * upstream.
 *
 * Sort order: (received_ms ASC, intent_id lexicographic).
 *
 * Empty input -> batch_input = null (caller's signal that there is nothing to
 * close).
 */

import type { BatchInput, MarketSnapshot } from "@shared/schemas";
import type { ReadyIntent } from "./intentAcceptance";

export type BuildBatchFromReadyInput = {
  batch_id: string;
  readyIntents: readonly ReadyIntent[];
  now_ms: number;
  market_snapshot: MarketSnapshot | null;
};

export type BuildBatchFromReadyResult = {
  batch_input: BatchInput | null;
  accepted_intent_ids: string[];
};

function compareReadyIntents(a: ReadyIntent, b: ReadyIntent): number {
  if (a.received_ms !== b.received_ms) return a.received_ms - b.received_ms;
  if (a.envelope.intent_id < b.envelope.intent_id) return -1;
  if (a.envelope.intent_id > b.envelope.intent_id) return 1;
  return 0;
}

export function buildBatchFromReadyIntents(
  input: BuildBatchFromReadyInput
): BuildBatchFromReadyResult {
  if (input.readyIntents.length === 0) {
    return { batch_input: null, accepted_intent_ids: [] };
  }
  const sorted = [...input.readyIntents].sort(compareReadyIntents);
  const batch_input: BatchInput = {
    batch_id: input.batch_id,
    market: "ETH/USDC",
    intents: sorted.map((r) => ({ envelope: r.envelope, payload: r.payload })),
    market_snapshot: input.market_snapshot,
    timestamp_ms: input.now_ms
  };
  return {
    batch_input,
    accepted_intent_ids: sorted.map((r) => r.envelope.intent_id)
  };
}
