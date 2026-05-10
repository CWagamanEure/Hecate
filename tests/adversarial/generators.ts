/**
 * Generators for adversarial tests. Produces realistic-shaped envelopes,
 * payloads, and batches with bounded random fields. All deterministic given
 * a seeded Rng.
 */

import {
  signEnvelope,
  hashPayload,
  mockEncryptPayload,
  deriveMockEnclaveKey,
  privateKeyToAddress
} from "@shared/crypto";
import type {
  PrivatePayload,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  BatchInput,
  MarketSnapshot,
  HexAddress,
  Hex32,
  HexBytes,
  Side
} from "@shared/schemas";
import type { Rng } from "./seededRng";

const TEST_KEYS: Hex32[] = [];
for (let i = 1; i <= 16; i++) {
  TEST_KEYS.push(("0x" + i.toString(16).padStart(64, "0")) as Hex32);
}
const TEST_ADDRS: HexAddress[] = TEST_KEYS.map((k) => privateKeyToAddress(k));
export const ENCLAVE_KEY = deriveMockEnclaveKey("sha256:adversarial-test");

export function getKey(i: number): Hex32 {
  return TEST_KEYS[i % TEST_KEYS.length]!;
}
export function getAddr(i: number): HexAddress {
  return TEST_ADDRS[i % TEST_ADDRS.length]!;
}

/** Format a number as a string with N decimals (no JS-float weirdness for our small ranges). */
function fmt(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

export function randomDecimalBetween(
  rng: Rng,
  min: number,
  max: number,
  decimals = 2
): string {
  const range = max - min;
  const v = min + rng.next() * range;
  return fmt(v, decimals);
}

export type GeneratedIntent = {
  payload: PrivatePayload;
  envelope: PublicEnvelope;
  agent_id: HexAddress;
  pk: Hex32;
};

export function randomIntent(
  rng: Rng,
  opts: { side?: Side; agentIndex?: number; intent_id?: string } = {}
): GeneratedIntent {
  const side: Side = opts.side ?? rng.pick(["BUY", "SELL"] as const);
  const max_base_amount = randomDecimalBetween(rng, 1, 10, 2);
  const limit_price =
    side === "BUY"
      ? randomDecimalBetween(rng, 3580, 3650, 2)
      : randomDecimalBetween(rng, 3550, 3620, 2);
  const allow_partial_fill = rng.next() > 0.3;
  const min_base_fill_amount = allow_partial_fill
    ? randomDecimalBetween(
        rng,
        0.01,
        Math.max(0.01, parseFloat(max_base_amount) * 0.5),
        2
      )
    : max_base_amount;

  const agentIndex = opts.agentIndex ?? rng.nextInt(8);
  const pk = getKey(agentIndex);
  const agent_id = getAddr(agentIndex);

  const payload: PrivatePayload = {
    side,
    asset_in: side === "BUY" ? "USDC" : "ETH",
    asset_out: side === "BUY" ? "ETH" : "USDC",
    max_base_amount,
    limit_price,
    allow_partial_fill,
    min_base_fill_amount,
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: `n-${rng.nextInt(2_000_000_000)}-${agentIndex}`
  };

  const ciphertext: HexBytes = mockEncryptPayload(payload, ENCLAVE_KEY);
  const intent_id = opts.intent_id ?? `intent_adv_${rng.nextInt(2_000_000_000)}`;
  const unsigned: PublicEnvelopeUnsigned = {
    intent_id,
    agent_id,
    market: "ETH/USDC",
    expiry_ms: Date.now() + 60_000,
    payload_commitment: hashPayload(payload),
    payload_ciphertext: ciphertext,
    nonce: payload.nonce
  };
  const envelope = signEnvelope(unsigned, pk);
  return { payload, envelope, agent_id, pk };
}

export type GeneratedBatch = {
  batch: BatchInput;
  intents: GeneratedIntent[];
};

export function randomBatch(
  rng: Rng,
  opts: { count?: number; snapshot?: MarketSnapshot | null } = {}
): GeneratedBatch {
  const count = opts.count ?? rng.nextInt(7) + 1; // 1..7
  const intents: GeneratedIntent[] = [];
  for (let i = 0; i < count; i++) {
    // Distinct intent_ids per batch.
    intents.push(
      randomIntent(rng, { intent_id: `intent_b${rng.nextInt(2_000_000_000)}_${i}` })
    );
  }
  const batch: BatchInput = {
    batch_id: `batch_adv_${rng.nextInt(2_000_000_000)}`,
    market: "ETH/USDC",
    intents: intents.map((g) => ({ envelope: g.envelope, payload: g.payload })),
    market_snapshot: opts.snapshot ?? null,
    timestamp_ms: Date.now()
  };
  return { batch, intents };
}
