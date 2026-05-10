import { describe, it, expect } from "vitest";
import { createCipheriv } from "node:crypto";
import {
  deriveMockEnclaveKey,
  mockEncryptPayload,
  mockDecryptPayload
} from "@shared/crypto";
import type { PrivatePayload, HexBytes } from "@shared/schemas";

const buyPayload: PrivatePayload = {
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

const sellPayload: PrivatePayload = {
  side: "SELL",
  asset_in: "ETH",
  asset_out: "USDC",
  max_base_amount: "10.0",
  limit_price: "3580.00",
  allow_partial_fill: true,
  min_base_fill_amount: "3.0",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: null,
  nonce: "2"
};

const key1 = new Uint8Array(32).fill(1);
const key2 = new Uint8Array(32).fill(2);
const fixedIv = new Uint8Array(12).fill(7);

describe("deriveMockEnclaveKey", () => {
  it("returns 32 bytes", () => {
    expect(deriveMockEnclaveKey("sha256:abc")).toHaveLength(32);
  });
  it("is deterministic", () => {
    const a = deriveMockEnclaveKey("sha256:abc");
    const b = deriveMockEnclaveKey("sha256:abc");
    expect(Buffer.from(a).toString("hex")).toBe(
      Buffer.from(b).toString("hex")
    );
  });
  it("differs across inputs", () => {
    const a = deriveMockEnclaveKey("sha256:abc");
    const b = deriveMockEnclaveKey("sha256:def");
    expect(Buffer.from(a).toString("hex")).not.toBe(
      Buffer.from(b).toString("hex")
    );
  });
});

describe("mockEncryptPayload / mockDecryptPayload — round-trip", () => {
  it("BUY payload round-trips", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    expect(mockDecryptPayload(ct, key1)).toEqual(buyPayload);
  });

  it("SELL payload round-trips", () => {
    const ct = mockEncryptPayload(sellPayload, key1);
    expect(mockDecryptPayload(ct, key1)).toEqual(sellPayload);
  });

  it("ciphertext is 0x-prefixed lowercase hex", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    expect(ct.startsWith("0x")).toBe(true);
    expect(ct).toBe(ct.toLowerCase());
    expect(ct.slice(2)).toMatch(/^[0-9a-f]+$/);
  });
});

describe("IV behavior", () => {
  it("random IV: two encryptions of same payload differ", () => {
    const a = mockEncryptPayload(buyPayload, key1);
    const b = mockEncryptPayload(buyPayload, key1);
    expect(a).not.toBe(b);
  });

  it("explicit IV: two encryptions are byte-identical", () => {
    const a = mockEncryptPayload(buyPayload, key1, { iv: fixedIv });
    const b = mockEncryptPayload(buyPayload, key1, { iv: fixedIv });
    expect(a).toBe(b);
  });

  it("explicit IV with wrong length throws", () => {
    expect(() =>
      mockEncryptPayload(buyPayload, key1, { iv: new Uint8Array(11) })
    ).toThrow(/iv must be 12 bytes/);
  });
});

describe("key length validation", () => {
  it("encrypt rejects short key", () => {
    expect(() =>
      mockEncryptPayload(buyPayload, new Uint8Array(16))
    ).toThrow(/key must be 32 bytes/);
  });
  it("decrypt rejects short key", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    expect(() => mockDecryptPayload(ct, new Uint8Array(16))).toThrow(
      /key must be 32 bytes/
    );
  });
});

describe("tamper-detect", () => {
  function flipByte(hex: HexBytes, byteOffset: number): HexBytes {
    const buf = Buffer.from(hex.slice(2), "hex");
    buf[byteOffset] = buf[byteOffset]! ^ 0x01;
    return ("0x" + buf.toString("hex")) as HexBytes;
  }

  it("flipping a byte in the IV section throws", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    expect(() => mockDecryptPayload(flipByte(ct, 0), key1)).toThrow(
      /decrypt failed/
    );
  });

  it("flipping a byte in the ciphertext section throws", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    // IV is 12 bytes; flip byte 12 (first byte of CT).
    expect(() => mockDecryptPayload(flipByte(ct, 12), key1)).toThrow(
      /decrypt failed/
    );
  });

  it("flipping a byte in the auth tag throws", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    const buf = Buffer.from(ct.slice(2), "hex");
    expect(() =>
      mockDecryptPayload(flipByte(ct, buf.length - 1), key1)
    ).toThrow(/decrypt failed/);
  });
});

describe("wrong key", () => {
  it("decrypt with a different key throws", () => {
    const ct = mockEncryptPayload(buyPayload, key1);
    expect(() => mockDecryptPayload(ct, key2)).toThrow(/decrypt failed/);
  });
});

describe("malformed ciphertext", () => {
  it("ciphertext shorter than IV+TAG throws", () => {
    const tooShort = ("0x" + "00".repeat(20)) as HexBytes; // < 12 + 16
    expect(() => mockDecryptPayload(tooShort, key1)).toThrow(/decrypt failed/);
  });
});

describe("schema re-validation after decrypt", () => {
  it("decrypts to non-PrivatePayload JSON → throws via Zod parse", () => {
    // Manually craft a ciphertext that decrypts to {"foo":"bar"} (not a valid
    // PrivatePayload). Bypasses our encrypt function (which always sends valid
    // payloads) to exercise the schema-rejection branch.
    const iv = new Uint8Array(12).fill(0);
    const cipher = createCipheriv("aes-256-gcm", key1, iv);
    const pt = Buffer.from(JSON.stringify({ foo: "bar" }));
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([iv, ct, tag]);
    const ciphertextHex = ("0x" + out.toString("hex")) as HexBytes;
    expect(() => mockDecryptPayload(ciphertextHex, key1)).toThrow();
  });

  it("decrypts to non-JSON bytes → throws with generic message", () => {
    const iv = new Uint8Array(12).fill(0);
    const cipher = createCipheriv("aes-256-gcm", key1, iv);
    const pt = Buffer.from([0xff, 0xfe, 0xfd]); // not valid UTF-8 JSON
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([iv, ct, tag]);
    const ciphertextHex = ("0x" + out.toString("hex")) as HexBytes;
    expect(() => mockDecryptPayload(ciphertextHex, key1)).toThrow(
      /decrypt failed/
    );
  });
});
