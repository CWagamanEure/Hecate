import { describe, it, expect } from "vitest";
import { hashPayload, verifyPayloadCommitment } from "@shared/crypto";
import type { PrivatePayload, PublicEnvelope } from "@shared/schemas";

const payload: PrivatePayload = {
  side: "BUY",
  asset_in: "USDC",
  asset_out: "ETH",
  max_base_amount: "4.0",
  limit_price: "3610.00",
  allow_partial_fill: true,
  min_base_fill_amount: "1.0",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: null,
  nonce: "1"
};

const baseEnvelope = (commitment: string): PublicEnvelope => ({
  intent_id: "intent_001",
  agent_id: "0x" + "a".repeat(40),
  market: "ETH/USDC",
  expiry_ms: 1770000000000,
  payload_commitment: commitment as `0x${string}`,
  payload_ciphertext: "0xdeadbeef",
  nonce: "1",
  signature: ("0x" + "0".repeat(130)) as `0x${string}`
});

describe("verifyPayloadCommitment", () => {
  it("succeeds when commitment matches hashPayload(payload)", () => {
    const commitment = hashPayload(payload);
    const env = baseEnvelope(commitment);
    expect(verifyPayloadCommitment(env, payload)).toEqual({ ok: true });
  });

  it("fails when envelope's commitment does not match the payload", () => {
    const wrongCommitment = "0x" + "f".repeat(64);
    const env = baseEnvelope(wrongCommitment);
    const r = verifyPayloadCommitment(env, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.code).toBe("INVALID_PAYLOAD_COMMITMENT");
      expect(r.failures[0]!.path).toBe("/payload_commitment");
      expect(r.failures[0]!.detail).toContain(wrongCommitment);
    }
  });

  it("fails when payload is mutated relative to a fixed commitment", () => {
    const commitment = hashPayload(payload);
    const env = baseEnvelope(commitment);
    const mutated: PrivatePayload = { ...payload, max_base_amount: "5.0" };
    const r = verifyPayloadCommitment(env, mutated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]!.code).toBe("INVALID_PAYLOAD_COMMITMENT");
  });

  it("payload.nonce difference produces different commitments (salt role)", () => {
    const a = hashPayload(payload);
    const b = hashPayload({ ...payload, nonce: "2" });
    expect(a).not.toBe(b);
  });
});
