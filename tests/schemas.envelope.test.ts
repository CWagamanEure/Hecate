import { describe, it, expect } from "vitest";
import { PublicEnvelope, PublicEnvelopeUnsigned } from "@shared/schemas";

const valid = {
  intent_id: "intent_001",
  agent_id: "0x" + "a".repeat(40),
  market: "ETH/USDC" as const,
  expiry_ms: 1770000000000,
  payload_commitment: "0x" + "b".repeat(64),
  payload_ciphertext: "0xdeadbeef",
  nonce: "1",
  signature: "0x" + "c".repeat(130)
};

describe("PublicEnvelope", () => {
  it("parses a valid envelope", () => {
    expect(PublicEnvelope.parse(valid)).toBeDefined();
  });

  it("rejects bad intent_id pattern", () => {
    expect(() =>
      PublicEnvelope.parse({ ...valid, intent_id: "not-prefixed" })
    ).toThrow();
    expect(() => PublicEnvelope.parse({ ...valid, intent_id: "" })).toThrow();
  });

  it("rejects bad market literal", () => {
    expect(() =>
      PublicEnvelope.parse({ ...valid, market: "ETH/DAI" as unknown as "ETH/USDC" })
    ).toThrow();
  });

  it("rejects malformed agent_id", () => {
    expect(() =>
      PublicEnvelope.parse({ ...valid, agent_id: "not-an-address" })
    ).toThrow();
  });

  it("rejects expiry_ms <= 0", () => {
    expect(() => PublicEnvelope.parse({ ...valid, expiry_ms: 0 })).toThrow();
    expect(() => PublicEnvelope.parse({ ...valid, expiry_ms: -1 })).toThrow();
  });

  it("rejects bad signature length", () => {
    expect(() =>
      PublicEnvelope.parse({ ...valid, signature: "0x" + "c".repeat(128) })
    ).toThrow();
  });

  it("rejects malformed payload_ciphertext (odd hex)", () => {
    expect(() =>
      PublicEnvelope.parse({ ...valid, payload_ciphertext: "0xabc" })
    ).toThrow();
  });

  it("PublicEnvelopeUnsigned omits signature", () => {
    const { signature: _sig, ...unsigned } = valid;
    expect(PublicEnvelopeUnsigned.parse(unsigned)).toBeDefined();
    expect(() =>
      PublicEnvelopeUnsigned.parse(valid as unknown as typeof unsigned)
    ).toThrow();
  });
});
