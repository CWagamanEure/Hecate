import { describe, it, expect } from "vitest";
import {
  toScaled,
  fromScaled,
  fromScaledSigned,
  addDecimal,
  subDecimal,
  mulDecimal,
  cmpDecimal,
  isZero,
  normalizeDecimal,
  applySignedDelta
} from "@shared/math/decimal";
import { decCmp } from "@shared/schemas";

describe("toScaled / fromScaled", () => {
  it("round-trips integers", () => {
    expect(fromScaled(toScaled("0"))).toBe("0");
    expect(fromScaled(toScaled("10"))).toBe("10");
    expect(fromScaled(toScaled("3590"))).toBe("3590");
  });

  it("round-trips fractionals with trimming", () => {
    expect(fromScaled(toScaled("10.0"))).toBe("10");
    expect(fromScaled(toScaled("10.50"))).toBe("10.5");
    expect(fromScaled(toScaled("3590.123456789012345678"))).toBe(
      "3590.123456789012345678"
    );
  });

  it("toScaled throws on malformed input", () => {
    expect(() => toScaled("01.5")).toThrow();
    expect(() => toScaled("1e10")).toThrow();
    expect(() => toScaled("1.")).toThrow();
    expect(() => toScaled("")).toThrow();
  });

  it("fromScaled throws on negative", () => {
    expect(() => fromScaled(-1n)).toThrow();
  });
});

describe("fromScaledSigned", () => {
  it("zero is '0'", () => {
    expect(fromScaledSigned(0n)).toBe("0");
  });
  it("positive matches fromScaled", () => {
    expect(fromScaledSigned(toScaled("10.5"))).toBe("10.5");
  });
  it("negative produces leading '-'", () => {
    expect(fromScaledSigned(-toScaled("10.5"))).toBe("-10.5");
    expect(fromScaledSigned(-1n)).toBe("-0.000000000000000001");
  });
});

describe("addDecimal", () => {
  it("avoids the JS-double 0.1+0.2 trap", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
  });
  it("preserves wei precision", () => {
    expect(addDecimal("18", "0.000000000000000001")).toBe("18.000000000000000001");
  });
  it("zero identity", () => {
    expect(addDecimal("0", "0")).toBe("0");
    expect(addDecimal("3590", "0")).toBe("3590");
  });
});

describe("subDecimal", () => {
  it("equal -> 0", () => {
    expect(subDecimal("10", "10")).toBe("0");
  });
  it("throws on underflow", () => {
    expect(() => subDecimal("10", "11")).toThrow();
    expect(() => subDecimal("0", "0.000000000000000001")).toThrow();
  });
  it("preserves precision", () => {
    expect(subDecimal("3590.123456789012345678", "0.000000000000000001")).toBe(
      "3590.123456789012345677"
    );
  });
});

describe("mulDecimal", () => {
  it("integer × integer", () => {
    expect(mulDecimal("10", "3590", "floor")).toBe("35900");
    expect(mulDecimal("10", "3590", "ceil")).toBe("35900");
  });
  it("integer × fractional with trailing zeros normalized away", () => {
    expect(mulDecimal("10", "3590.00", "ceil")).toBe("35900");
  });
  it("0.5 × 3610.99 is exact (no rounding mode matters)", () => {
    expect(mulDecimal("0.5", "3610.99", "floor")).toBe("1805.495");
    expect(mulDecimal("0.5", "3610.99", "ceil")).toBe("1805.495");
  });
  it("BUY-style ceil over-estimates by 1 wei when truncation would happen", () => {
    // 1 wei × 1 wei = 1e-36, which truncates to 0 at 18 decimals (floor) or
    // rounds up to 1 wei (ceil).
    const wei = "0.000000000000000001";
    expect(mulDecimal(wei, wei, "floor")).toBe("0");
    expect(mulDecimal(wei, wei, "ceil")).toBe("0.000000000000000001");
  });
  it("zero short-circuit", () => {
    expect(mulDecimal("0", "3590", "ceil")).toBe("0");
    expect(mulDecimal("3590", "0", "floor")).toBe("0");
  });
});

describe("cmpDecimal and decCmp re-export", () => {
  it("compares correctly", () => {
    expect(cmpDecimal("0", "0")).toBe(0);
    expect(cmpDecimal("0", "0.0")).toBe(0);
    expect(cmpDecimal("3590", "3590.0")).toBe(0);
    expect(cmpDecimal("9", "10")).toBe(-1);
    expect(cmpDecimal("3590.51", "3590.5")).toBe(1);
  });

  it("decCmp re-export agrees with cmpDecimal across a fixed sample", () => {
    const cases: Array<[string, string]> = [
      ["0", "0"],
      ["0.000000000000000001", "0"],
      ["1", "1.0"],
      ["3590", "3590.0"],
      ["3590.49", "3590.5"],
      ["3590.5", "3590.51"],
      ["10.000000000000000001", "10"],
      ["999999999999999999999999999999999999", "999999999999999999999999999999999998"],
      ["1.5", "1.05"],
      ["100", "99.99"]
    ];
    for (const [a, b] of cases) {
      expect(decCmp(a, b)).toBe(cmpDecimal(a, b));
    }
  });
});

describe("normalizeDecimal", () => {
  it.each([
    ["10.0", "10"],
    ["10.50", "10.5"],
    ["0", "0"],
    ["0.0", "0"],
    ["0.00000000", "0"],
    ["3590.123456789012345600", "3590.1234567890123456"]
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected);
  });
});

describe("isZero", () => {
  it.each([["0", true], ["0.0", true], ["0.000000000000000000", true], ["0.000000000000000001", false], ["1", false]])(
    "%s -> %s",
    (input, expected) => {
      expect(isZero(input)).toBe(expected);
    }
  );
});

describe("applySignedDelta", () => {
  it("positive delta increases balance", () => {
    expect(applySignedDelta("10", "5")).toBe("15");
  });
  it("negative delta decreases balance", () => {
    expect(applySignedDelta("10", "-3")).toBe("7");
  });
  it("zero delta is identity", () => {
    expect(applySignedDelta("10", "0")).toBe("10");
  });
  it("throws when result would be negative", () => {
    expect(() => applySignedDelta("10", "-11")).toThrow();
  });
});

describe("property: addDecimal(a, subDecimal(b, a)) === b when b >= a", () => {
  it("100 random pairs", () => {
    for (let i = 0; i < 100; i++) {
      const a = (Math.random() * 1000).toFixed(6);
      const b = (parseFloat(a) + Math.random() * 1000).toFixed(6);
      expect(addDecimal(a, subDecimal(b, a))).toBe(normalizeDecimal(b));
    }
  });
});
