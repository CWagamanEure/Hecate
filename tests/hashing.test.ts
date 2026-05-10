import { describe, it, expect } from "vitest";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  keccak256Hex,
  sha256Hex,
  hashCanonical,
  hashBatchReceiptBody,
  hashFillReceiptBody,
  envelopeSigningHash,
  orderedAggregateHash,
  canonicalJson
} from "@shared/crypto";
import type {
  BatchReceipt,
  FillReceipt,
  PublicEnvelope
} from "@shared/schemas";

const HEX32_RE = /^0x[0-9a-f]{64}$/;

describe("keccak256Hex — known vector", () => {
  // Ethereum's pre-NIST keccak. Locks in the algorithm choice.
  it("empty input", () => {
    expect(keccak256Hex("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
  });

  // Pin keccak vs NIST sha3_256. Different padding byte; different output.
  it("differs from NIST sha3_256 (Ethereum keccak, not sha3)", () => {
    const sha3Empty = "0x" + bytesToHex(sha3_256(new Uint8Array()));
    expect(sha3Empty).toBe(
      "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a"
    );
    expect(keccak256Hex("")).not.toBe(sha3Empty);
  });
});

describe("sha256Hex — known vector", () => {
  it("empty input", () => {
    expect(sha256Hex("")).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("hashCanonical — shape and determinism", () => {
  it("returns 0x + 64 lowercase hex chars (Hex32)", () => {
    expect(hashCanonical({ a: 1 })).toMatch(HEX32_RE);
  });

  it("is independent of object key order", () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(
      hashCanonical({ b: 2, a: 1 })
    );
  });

  it("differs when array order changes", () => {
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });

  it("differs across structural shapes", () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical([{ a: 1 }]));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical("{a:1}"));
  });

  it("supports sha256 algo", () => {
    const a = hashCanonical({ a: 1 }, "sha256");
    const b = hashCanonical({ a: 1 }, "keccak256");
    expect(a).toMatch(HEX32_RE);
    expect(b).toMatch(HEX32_RE);
    expect(a).not.toBe(b);
  });
});

describe("hashCanonical — known vector", () => {
  // Locked-in: ties hashCanonical to canonicalJson + keccak256Hex.
  // Changing canonicalization or the algorithm choice will break this.
  const obj = { z: 1, a: { y: 2, x: [1, 2] } };
  const expectedJson = '{"a":{"x":[1,2],"y":2},"z":1}';

  it("canonicalJson output is the locked vector", () => {
    expect(canonicalJson(obj)).toBe(expectedJson);
  });

  it("hashCanonical equals keccak256Hex of the canonical JSON", () => {
    expect(hashCanonical(obj)).toBe(keccak256Hex(expectedJson));
  });
});

describe("hashCanonical — stability under permutation (property)", () => {
  it("100 random key shuffles produce identical hashes", () => {
    const target = hashCanonical({ a: 1, b: 2, c: 3, d: 4 });
    const keys = ["a", "b", "c", "d"] as const;
    for (let i = 0; i < 100; i++) {
      const shuffled = [...keys].sort(() => Math.random() - 0.5);
      const obj: Record<string, number> = {};
      for (const k of shuffled) obj[k] = ["a", "b", "c", "d"].indexOf(k) + 1;
      expect(hashCanonical(obj)).toBe(target);
    }
  });
});

describe("envelopeSigningHash strips signature", () => {
  const hex32 = "0x" + "0".repeat(64);
  const hex65 = "0x" + "0".repeat(130);
  const unsigned = {
    intent_id: "intent_001",
    agent_id: "0x" + "a".repeat(40),
    market: "ETH/USDC" as const,
    expiry_ms: 1770000000000,
    payload_commitment: hex32,
    payload_ciphertext: "0xdeadbeef",
    nonce: "1"
  };
  const signed: PublicEnvelope = { ...unsigned, signature: hex65 };

  it("returns the same hash whether signed or unsigned envelope is passed", () => {
    expect(envelopeSigningHash(signed)).toBe(envelopeSigningHash(unsigned));
  });

  it("differs from a hash that includes the signature", () => {
    expect(envelopeSigningHash(signed)).not.toBe(hashCanonical(signed));
  });

  it("changes when any signed-over field changes", () => {
    const before = envelopeSigningHash(unsigned);
    const after = envelopeSigningHash({ ...unsigned, expiry_ms: 1770000000001 });
    expect(after).not.toBe(before);
  });
});

describe("hashBatchReceiptBody / hashFillReceiptBody strip signature", () => {
  const hex32 = "0x" + "0".repeat(64);
  const hex65 = "0x" + "0".repeat(130);
  const addr = "0x" + "a".repeat(40);
  const runtime = {
    runtime_mode: "LOCAL_MOCK" as const,
    engine_code_digest: "sha256:dev-local",
    eigencompute_app_id: null,
    eigencompute_image_digest: null,
    eigencompute_attestation_id: null
  };

  const batchBody = {
    batch_id: "batch_001",
    market: "ETH/USDC" as const,
    matching_rule: "UNIFORM_CLEARING_PRICE_V1" as const,
    intent_envelope_root: hex32,
    private_payload_commitment_root: hex32,
    vault_state_before_hash: hex32,
    vault_state_after_hash: hex32,
    reservation_book_before_hash: hex32,
    reservation_book_after_hash: hex32,
    settlement_hash: hex32,
    num_intents: 1,
    num_matched: 1,
    clearing_price: "3590.00",
    timestamp_ms: 1770000000000,
    runtime
  };
  const batchSigned: BatchReceipt = { ...batchBody, engine_signature: hex65 };

  const fillBody = {
    intent_id: "intent_001",
    batch_id: "batch_001",
    agent_id: addr,
    status: "FILLED" as const,
    filled_base: "10.0",
    filled_quote: "35900.00",
    clearing_price: "3590.00",
    constraints_satisfied: true,
    unfilled_reason: null,
    payload_commitment: hex32,
    reserved_released: { ETH: "0.0", USDC: "0.0" },
    runtime
  };
  const fillSigned: FillReceipt = { ...fillBody, engine_signature: hex65 };

  it("batch: signed and body produce same hash", () => {
    expect(hashBatchReceiptBody(batchSigned)).toBe(
      hashBatchReceiptBody(batchBody)
    );
  });

  it("batch: signed body hash differs from raw hashCanonical (signature included)", () => {
    expect(hashBatchReceiptBody(batchSigned)).not.toBe(
      hashCanonical(batchSigned)
    );
  });

  it("fill: signed and body produce same hash", () => {
    expect(hashFillReceiptBody(fillSigned)).toBe(hashFillReceiptBody(fillBody));
  });

  it("fill: signed body hash differs from raw hashCanonical", () => {
    expect(hashFillReceiptBody(fillSigned)).not.toBe(hashCanonical(fillSigned));
  });
});

describe("orderedAggregateHash", () => {
  it("empty array has a stable hash equal to keccak256Hex('[]')", () => {
    expect(orderedAggregateHash([])).toBe(keccak256Hex("[]"));
  });

  it("with sortBy: order-independent", () => {
    const a = [{ id: "b" }, { id: "a" }, { id: "c" }];
    const b = [{ id: "a" }, { id: "c" }, { id: "b" }];
    expect(orderedAggregateHash(a, { sortBy: (x) => x.id })).toBe(
      orderedAggregateHash(b, { sortBy: (x) => x.id })
    );
  });

  it("without sortBy: caller order matters", () => {
    const a = [{ id: "b" }, { id: "a" }];
    const b = [{ id: "a" }, { id: "b" }];
    expect(orderedAggregateHash(a)).not.toBe(orderedAggregateHash(b));
  });

  it("single item equals hashCanonical of single-element array", () => {
    expect(orderedAggregateHash([{ x: 1 }])).toBe(hashCanonical([{ x: 1 }]));
  });

  it("does not mutate the input array when sorting", () => {
    const items = [{ id: "b" }, { id: "a" }];
    const before = items.map((i) => i.id).join(",");
    orderedAggregateHash(items, { sortBy: (x) => x.id });
    expect(items.map((i) => i.id).join(",")).toBe(before);
  });
});
