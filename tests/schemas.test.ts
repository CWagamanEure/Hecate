import { describe, it, expect } from "vitest";
import {
  DecimalString,
  SignedDecimalString,
  decCmp,
  HexAddress,
  Hex32,
  Hex65,
  HexBytes,
  VerifyResult
} from "@shared/schemas";

describe("DecimalString", () => {
  it.each([
    "0",
    "0.0",
    "10",
    "10.0",
    "3590.00",
    "3590.123456789012345678",
    "999999999999999999999999999999999999",
    "1.000000000000000001"
  ])("accepts %s", (s) => {
    expect(DecimalString.parse(s)).toBe(s);
  });

  it.each([
    "",
    "-1",
    "+1",
    "1e10",
    "1E10",
    "01.5",
    "00",
    "1.",
    ".5",
    "1.1234567890123456789", // 19 fractional digits
    "1.0.0",
    "abc",
    " 1",
    "1 "
  ])("rejects %s", (s) => {
    expect(() => DecimalString.parse(s)).toThrow();
  });
});

describe("SignedDecimalString", () => {
  it.each(["0", "1", "-1", "-10.5", "-0.000000000000000001", "10.5"])(
    "accepts %s",
    (s) => {
      expect(SignedDecimalString.parse(s)).toBe(s);
    }
  );

  it.each(["+1", "--1", "1-", "", "1e1"])("rejects %s", (s) => {
    expect(() => SignedDecimalString.parse(s)).toThrow();
  });
});

describe("decCmp", () => {
  it("compares equal", () => {
    expect(decCmp("0", "0")).toBe(0);
    expect(decCmp("0", "0.0")).toBe(0);
    expect(decCmp("3590", "3590.0")).toBe(0);
    expect(decCmp("3590.5", "3590.500000000000000000")).toBe(0);
  });
  it("compares less", () => {
    expect(decCmp("1", "2")).toBe(-1);
    expect(decCmp("9", "10")).toBe(-1);
    expect(decCmp("3590.49", "3590.5")).toBe(-1);
    expect(decCmp("0", "0.000000000000000001")).toBe(-1);
  });
  it("compares greater", () => {
    expect(decCmp("2", "1")).toBe(1);
    expect(decCmp("10", "9")).toBe(1);
    expect(decCmp("3590.51", "3590.5")).toBe(1);
  });
});

describe("HexAddress", () => {
  it("accepts lowercase, uppercase, mixed case", () => {
    expect(HexAddress.parse("0x" + "a".repeat(40))).toBeDefined();
    expect(HexAddress.parse("0x" + "A".repeat(40))).toBeDefined();
    expect(HexAddress.parse("0xAaBbCcDdEeFf" + "0".repeat(28))).toBeDefined();
  });
  it("rejects wrong length", () => {
    expect(() => HexAddress.parse("0x" + "a".repeat(39))).toThrow();
    expect(() => HexAddress.parse("0x" + "a".repeat(41))).toThrow();
  });
  it("rejects missing 0x", () => {
    expect(() => HexAddress.parse("a".repeat(40))).toThrow();
  });
  it("rejects non-hex chars", () => {
    expect(() => HexAddress.parse("0x" + "z".repeat(40))).toThrow();
  });
});

describe("Hex32 / Hex65 / HexBytes", () => {
  it("Hex32 requires 64 hex chars", () => {
    expect(Hex32.parse("0x" + "0".repeat(64))).toBeDefined();
    expect(() => Hex32.parse("0x" + "0".repeat(63))).toThrow();
    expect(() => Hex32.parse("0x" + "0".repeat(65))).toThrow();
  });
  it("Hex65 requires 130 hex chars", () => {
    expect(Hex65.parse("0x" + "0".repeat(130))).toBeDefined();
    expect(() => Hex65.parse("0x" + "0".repeat(129))).toThrow();
    expect(() => Hex65.parse("0x" + "0".repeat(131))).toThrow();
  });
  it("HexBytes requires even-length hex", () => {
    expect(HexBytes.parse("0x")).toBeDefined();
    expect(HexBytes.parse("0xdeadbeef")).toBeDefined();
    expect(() => HexBytes.parse("0xabc")).toThrow();
    expect(() => HexBytes.parse("0xZZ")).toThrow();
  });
});

describe("VerifyResult", () => {
  it("accepts ok=true", () => {
    expect(VerifyResult.parse({ ok: true })).toEqual({ ok: true });
  });
  it("accepts ok=false with failures", () => {
    const r = {
      ok: false as const,
      failures: [{ code: "X", path: null, detail: null }]
    };
    expect(VerifyResult.parse(r)).toEqual(r);
  });
  it("rejects ok=false with empty failures", () => {
    expect(() => VerifyResult.parse({ ok: false, failures: [] })).toThrow();
  });
});
