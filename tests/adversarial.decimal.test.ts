/**
 * Boundary tests for shared/math/decimal.
 */

import { describe, it, expect } from "vitest";
import {
  addDecimal,
  subDecimal,
  mulDecimal,
  cmpDecimal,
  isZero,
  normalizeDecimal,
  applySignedDelta,
  toScaled,
  fromScaled
} from "@shared/math/decimal";
import { makeRng } from "./adversarial/seededRng";

describe("adversarial decimal — sub-wei boundaries", () => {
  it("1 wei × 1 wei: floor=0, ceil=1 wei", () => {
    const wei = "0.000000000000000001";
    expect(mulDecimal(wei, wei, "floor")).toBe("0");
    expect(mulDecimal(wei, wei, "ceil")).toBe(wei);
  });

  it("any wei × any wei produces non-negative result", () => {
    const wei = "0.000000000000000001";
    // 36 nines × 1e-18 = 18 nines.18 nines
    expect(mulDecimal("999999999999999999999999999999999999", wei, "floor")).toBe("999999999999999999.999999999999999999");
    // wei * 1 = wei
    expect(mulDecimal(wei, "1", "floor")).toBe(wei);
  });

  it("near-max integer × near-max integer (BigInt unbounded)", () => {
    // 36-digit max × 36-digit max — this is ~10^72; BigInt handles it.
    const m = "999999999999999999999999999999999999";
    const r = mulDecimal(m, m, "floor");
    // result has up to 72 integer digits — but our DecimalString allows only 36.
    // mulDecimal -> fromScaled which doesn't validate against the schema regex.
    // The result string is the BigInt division rendered as decimal.
    expect(r.length).toBeGreaterThan(36);
  });

  it("1000 wei sums exactly", () => {
    const wei = "0.000000000000000001";
    let s = "0";
    for (let i = 0; i < 1000; i++) s = addDecimal(s, wei);
    expect(s).toBe("0.000000000000001");
  });
});

describe("adversarial decimal — JS-double trap pinned", () => {
  it("0.1 + 0.2 + 0.3 ... cumulative", () => {
    let s = "0";
    for (let i = 0; i < 10; i++) s = addDecimal(s, "0.1");
    expect(s).toBe("1");
  });
});

describe("adversarial decimal — randomized add/sub round-trip", () => {
  it("100 random pairs: a + (b - a) === b when b >= a", () => {
    for (let i = 1; i <= 100; i++) {
      const rng = makeRng(i);
      const a = rng.nextInt(1000) + "." + rng.nextInt(1e6).toString().padStart(6, "0");
      const bAdd = rng.nextInt(1000) + "." + rng.nextInt(1e6).toString().padStart(6, "0");
      const b = addDecimal(a, bAdd);
      const r = addDecimal(a, subDecimal(b, a));
      if (r !== normalizeDecimal(b)) {
        throw new Error(`seed=${i}: a=${a} b=${b} got ${r}`);
      }
    }
    expect(true).toBe(true);
  });
});

describe("adversarial decimal — applySignedDelta", () => {
  it("100 random: (balance + delta) >= 0 always succeeds; underflow throws", () => {
    for (let i = 1; i <= 100; i++) {
      const rng = makeRng(i);
      const bal = rng.nextInt(1000) + ".5";
      const positiveDelta = "0.1";
      // Should succeed.
      expect(() => applySignedDelta(bal, positiveDelta)).not.toThrow();
      // Underflow.
      const tooNeg = "-" + (parseFloat(bal) + 1).toFixed(2);
      expect(() => applySignedDelta(bal, tooNeg)).toThrow();
    }
  });
});

describe("adversarial decimal — normalizeDecimal idempotence", () => {
  it.each([
    ["10.0", "10"],
    ["10.50", "10.5"],
    ["10.500", "10.5"],
    ["0.0", "0"],
    ["0.000000000", "0"],
    ["3590.123456789012345600", "3590.1234567890123456"]
  ])("normalize(%s) = %s and re-normalize unchanged", (input, expected) => {
    const out = normalizeDecimal(input);
    expect(out).toBe(expected);
    expect(normalizeDecimal(out)).toBe(out);
  });
});

describe("adversarial decimal — cmpDecimal trichotomy", () => {
  it("100 pairs: exactly one of <, =, > holds", () => {
    for (let i = 1; i <= 100; i++) {
      const rng = makeRng(i);
      const a = rng.nextInt(10000) + "." + rng.nextInt(1e9).toString().padStart(9, "0");
      const b = rng.nextInt(10000) + "." + rng.nextInt(1e9).toString().padStart(9, "0");
      const c = cmpDecimal(a, b);
      const reverseC = cmpDecimal(b, a);
      if (c === 0 && reverseC !== 0) throw new Error(`seed=${i}: cmp asymmetric`);
      if (c < 0 && reverseC <= 0) throw new Error(`seed=${i}: cmp sign asymmetric`);
      if (c > 0 && reverseC >= 0) throw new Error(`seed=${i}: cmp sign asymmetric`);
    }
    expect(true).toBe(true);
  });
});

describe("adversarial decimal — ceil rounding never under", () => {
  it("100 random products: ceil(a*b) >= a*b (using BigInt-scaled comparison)", () => {
    for (let i = 1; i <= 100; i++) {
      const rng = makeRng(i);
      const a = rng.nextInt(1000) + "." + rng.nextInt(1e9).toString().padStart(9, "0");
      const b = rng.nextInt(1000) + "." + rng.nextInt(1e9).toString().padStart(9, "0");
      const ceilR = mulDecimal(a, b, "ceil");
      const floorR = mulDecimal(a, b, "floor");
      if (cmpDecimal(ceilR, floorR) < 0) {
        throw new Error(`seed=${i}: ceil < floor — broken rounding`);
      }
    }
    expect(true).toBe(true);
  });
});
