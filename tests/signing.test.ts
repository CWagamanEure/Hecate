import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import {
  privateKeyToAddress,
  normalizeAddress,
  canonicalizeEnvelopeForSigning,
  envelopeSigningHash,
  signEnvelope,
  recoverEnvelopeSigner,
  verifyEnvelopeSignature,
  verifyEnvelopeBasic
} from "@shared/crypto";
import type { PublicEnvelope, PublicEnvelopeUnsigned } from "@shared/schemas";

// Private key 0x01 — well-known secret. Public key is the secp256k1 generator G.
const PK1 = "0x" + "0".repeat(63) + "1";
const ADDR1 = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // EIP-55 form
const PK2 = "0x" + "0".repeat(63) + "2";

const baseUnsigned = (overrides: Partial<PublicEnvelopeUnsigned> = {}): PublicEnvelopeUnsigned => ({
  intent_id: "intent_001",
  agent_id: ADDR1,
  market: "ETH/USDC",
  expiry_ms: 1770000000000,
  payload_commitment: "0x" + "b".repeat(64),
  payload_ciphertext: "0xdeadbeef",
  nonce: "1",
  ...overrides
});

describe("privateKeyToAddress", () => {
  it("derives the known address for private key 0x01", () => {
    expect(privateKeyToAddress(PK1)).toBe(ADDR1);
  });

  it("returns EIP-55 checksum form (mixed case)", () => {
    const addr = privateKeyToAddress(PK1);
    expect(addr).toMatch(/0x[0-9a-fA-F]{40}/);
    // ADDR1 has both upper and lower case characters
    expect(addr).not.toBe(addr.toLowerCase());
    expect(addr).not.toBe(addr.toUpperCase());
  });

  it("accepts Uint8Array input", () => {
    const bytes = hexToBytes(PK1.slice(2));
    expect(privateKeyToAddress(bytes)).toBe(ADDR1);
  });

  it("derives different addresses for different keys", () => {
    expect(privateKeyToAddress(PK1)).not.toBe(privateKeyToAddress(PK2));
  });
});

describe("normalizeAddress", () => {
  it("normalizes lowercase to EIP-55", () => {
    expect(normalizeAddress(ADDR1.toLowerCase())).toBe(ADDR1);
  });
  it("normalizes uppercase to EIP-55", () => {
    expect(normalizeAddress("0x" + ADDR1.slice(2).toUpperCase())).toBe(ADDR1);
  });
  it("returns identity for already-EIP-55", () => {
    expect(normalizeAddress(ADDR1)).toBe(ADDR1);
  });
  it("throws on malformed input", () => {
    expect(() => normalizeAddress("0xnothex")).toThrow();
  });
});

describe("canonicalizeEnvelopeForSigning", () => {
  it("normalizes agent_id to EIP-55", () => {
    const env = baseUnsigned({ agent_id: ADDR1.toLowerCase() });
    const canon = canonicalizeEnvelopeForSigning(env);
    expect(canon.agent_id).toBe(ADDR1);
  });

  it("strips signature when present", () => {
    const signed: PublicEnvelope = {
      ...baseUnsigned(),
      signature: ("0x" + "0".repeat(130)) as `0x${string}`
    };
    const canon = canonicalizeEnvelopeForSigning(signed);
    expect("signature" in canon).toBe(false);
  });

  it("preserves all other fields unchanged", () => {
    const env = baseUnsigned({ agent_id: ADDR1.toLowerCase() });
    const canon = canonicalizeEnvelopeForSigning(env);
    expect(canon.intent_id).toBe(env.intent_id);
    expect(canon.market).toBe(env.market);
    expect(canon.expiry_ms).toBe(env.expiry_ms);
    expect(canon.payload_commitment).toBe(env.payload_commitment);
    expect(canon.payload_ciphertext).toBe(env.payload_ciphertext);
    expect(canon.nonce).toBe(env.nonce);
  });
});

describe("envelopeSigningHash — agent_id case independence", () => {
  it("lowercase and EIP-55 agent_id produce identical hashes", () => {
    const lower = baseUnsigned({ agent_id: ADDR1.toLowerCase() });
    const eip55 = baseUnsigned({ agent_id: ADDR1 });
    expect(envelopeSigningHash(lower)).toBe(envelopeSigningHash(eip55));
  });

  it("uppercase and EIP-55 agent_id produce identical hashes", () => {
    const upper = baseUnsigned({ agent_id: "0x" + ADDR1.slice(2).toUpperCase() });
    const eip55 = baseUnsigned({ agent_id: ADDR1 });
    expect(envelopeSigningHash(upper)).toBe(envelopeSigningHash(eip55));
  });

  it("changes when any signed-over non-address field changes", () => {
    const a = envelopeSigningHash(baseUnsigned());
    const b = envelopeSigningHash(baseUnsigned({ expiry_ms: 1770000000001 }));
    expect(a).not.toBe(b);
  });

  it("changes when agent_id is a genuinely different address", () => {
    const a = envelopeSigningHash(baseUnsigned({ agent_id: ADDR1 }));
    const b = envelopeSigningHash(baseUnsigned({ agent_id: privateKeyToAddress(PK2) }));
    expect(a).not.toBe(b);
  });

  it("equals signing hash of signed envelope (signature stripped)", () => {
    const unsigned = baseUnsigned();
    const signed = signEnvelope(unsigned, PK1);
    expect(envelopeSigningHash(signed)).toBe(envelopeSigningHash(unsigned));
  });
});

describe("signEnvelope / recoverEnvelopeSigner round-trip", () => {
  it("recovered signer matches privateKeyToAddress", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    expect(recoverEnvelopeSigner(signed)).toBe(privateKeyToAddress(PK1));
  });

  it("is deterministic (RFC 6979)", () => {
    const a = signEnvelope(baseUnsigned(), PK1);
    const b = signEnvelope(baseUnsigned(), PK1);
    expect(a.signature).toBe(b.signature);
  });

  it("produces v ∈ {27, 28} (Ethereum convention)", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    const v = parseInt(signed.signature.slice(-2), 16);
    expect([27, 28]).toContain(v);
  });

  it("accepts Uint8Array private key", () => {
    const pkBytes = hexToBytes(PK1.slice(2));
    const signed = signEnvelope(baseUnsigned(), pkBytes);
    expect(recoverEnvelopeSigner(signed)).toBe(privateKeyToAddress(PK1));
  });
});

describe("verifyEnvelopeSignature", () => {
  it("succeeds for a valid signed envelope", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    expect(verifyEnvelopeSignature(signed)).toEqual({ ok: true });
  });

  it("succeeds when agent_id is lowercase but otherwise correct", () => {
    const signed = signEnvelope(
      baseUnsigned({ agent_id: ADDR1.toLowerCase() }),
      PK1
    );
    expect(verifyEnvelopeSignature(signed)).toEqual({ ok: true });
  });

  it("succeeds when agent_id is uppercase but otherwise correct", () => {
    const signed = signEnvelope(
      baseUnsigned({ agent_id: "0x" + ADDR1.slice(2).toUpperCase() }),
      PK1
    );
    expect(verifyEnvelopeSignature(signed)).toEqual({ ok: true });
  });

  it("fails when agent_id is a genuinely different address", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    const tampered: PublicEnvelope = {
      ...signed,
      agent_id: privateKeyToAddress(PK2)
    };
    const r = verifyEnvelopeSignature(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]!.code).toBe("INVALID_SIGNATURE");
  });

  it.each([
    ["intent_id", { intent_id: "intent_999" }],
    ["expiry_ms", { expiry_ms: 1770000000001 }],
    ["payload_commitment", { payload_commitment: "0x" + "c".repeat(64) }],
    ["payload_ciphertext", { payload_ciphertext: "0xcafebabe" }],
    ["nonce", { nonce: "999" }]
  ])("fails when %s is mutated after signing", (_field, override) => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    const tampered = { ...signed, ...(override as Partial<PublicEnvelope>) };
    const r = verifyEnvelopeSignature(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]!.code).toBe("INVALID_SIGNATURE");
  });

  it("fails when signature bytes are mutated", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    // Flip one hex char in r (third character of the hex string after 0x).
    const flipped =
      signed.signature.slice(0, 4) +
      (signed.signature[4] === "0" ? "1" : "0") +
      signed.signature.slice(5);
    const r = verifyEnvelopeSignature({ ...signed, signature: flipped });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]!.code).toBe("INVALID_SIGNATURE");
  });
});

describe("verifyEnvelopeSignature — v byte tolerance", () => {
  it("accepts v ∈ {0, 1} (some signers emit recovery bit directly)", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    const sigBytes = hexToBytes(signed.signature.slice(2));
    const v_27_28 = sigBytes[64]!;
    const v_0_1 = v_27_28 - 27;
    sigBytes[64] = v_0_1;
    const newSig = ("0x" + bytesToHex(sigBytes)) as `0x${string}`;
    const tweaked: PublicEnvelope = { ...signed, signature: newSig };
    expect(verifyEnvelopeSignature(tweaked)).toEqual({ ok: true });
  });

  it("rejects an invalid v byte", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    const sigBytes = hexToBytes(signed.signature.slice(2));
    sigBytes[64] = 99;
    const bad = ("0x" + bytesToHex(sigBytes)) as `0x${string}`;
    const r = verifyEnvelopeSignature({ ...signed, signature: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]!.code).toBe("INVALID_SIGNATURE");
  });
});

describe("verifyEnvelopeBasic", () => {
  it("succeeds for a valid envelope, valid expiry, no seenNonces", () => {
    const signed = signEnvelope(baseUnsigned(), PK1);
    expect(
      verifyEnvelopeBasic(signed, { now_ms: 1700000000000 })
    ).toEqual({ ok: true });
  });

  it("succeeds when seenNonces does not contain the nonce", () => {
    const signed = signEnvelope(baseUnsigned({ nonce: "42" }), PK1);
    expect(
      verifyEnvelopeBasic(signed, {
        now_ms: 1700000000000,
        seenNonces: new Set(["1", "2"])
      })
    ).toEqual({ ok: true });
  });

  it("returns EXPIRED when now_ms > expiry_ms", () => {
    const signed = signEnvelope(
      baseUnsigned({ expiry_ms: 1700000000000 }),
      PK1
    );
    const r = verifyEnvelopeBasic(signed, { now_ms: 1800000000000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      expect(codes).toContain("EXPIRED");
    }
  });

  it("returns DUPLICATE_NONCE when seenNonces contains the nonce", () => {
    const signed = signEnvelope(baseUnsigned({ nonce: "42" }), PK1);
    const r = verifyEnvelopeBasic(signed, {
      now_ms: 1700000000000,
      seenNonces: new Set(["42"])
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code);
      expect(codes).toContain("DUPLICATE_NONCE");
    }
  });

  it("collects multiple failures (does not short-circuit)", () => {
    // Sign with PK2 but claim PK1's address → INVALID_SIGNATURE.
    // Also expired and nonce already seen.
    const wrongSig = signEnvelope(
      baseUnsigned({
        agent_id: ADDR1,
        expiry_ms: 1700000000000,
        nonce: "42"
      }),
      PK2
    );
    const r = verifyEnvelopeBasic(wrongSig, {
      now_ms: 1800000000000,
      seenNonces: new Set(["42"])
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.failures.map((f) => f.code).sort();
      expect(codes).toEqual(
        ["DUPLICATE_NONCE", "EXPIRED", "INVALID_SIGNATURE"].sort()
      );
    }
  });

  it("each failure has a path pointing to the offending field", () => {
    const wrongSig = signEnvelope(baseUnsigned({ agent_id: ADDR1 }), PK2);
    const r = verifyEnvelopeBasic(wrongSig, {
      now_ms: 1700000000000
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const sigFailure = r.failures.find((f) => f.code === "INVALID_SIGNATURE");
      expect(sigFailure?.path).toBe("/signature");
    }
  });
});
