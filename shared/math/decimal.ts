/**
 * Decimal arithmetic for ETH/USDC values.
 *
 * Internal representation: BigInt scaled by 10^18 (matching ETH wei precision).
 * USDC values fit comfortably at 18-decimal precision; we don't enforce per-asset
 * caps here — the schema layer (DecimalString) caps fractional digits at 18.
 *
 * No JS floats. Anywhere. Ever.
 *
 * `decCmp` (the schema-level comparator from Ticket 3) is satisfied by re-export
 * of `cmpDecimal` from `shared/schemas/decimal`.
 */

import type { DecimalString, SignedDecimalString } from "@shared/schemas";

const SCALE = 18n;
const SCALE_FACTOR = 10n ** SCALE;
const ZERO_FRAC = "000000000000000000"; // 18 zeros

const UNSIGNED_RE = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
const SIGNED_RE = /^-?(0|[1-9]\d*)(\.\d{1,18})?$/;

/** Parse an unsigned or signed decimal string into a scaled BigInt.
 *  Throws if input doesn't match the expected shape. */
export function toScaled(d: DecimalString | SignedDecimalString | string): bigint {
  if (!SIGNED_RE.test(d)) {
    throw new Error(`toScaled: malformed decimal "${d}"`);
  }
  const negative = d.startsWith("-");
  const abs = negative ? d.slice(1) : d;
  const [intPart, fracPart = ""] = abs.split(".");
  const padded = (fracPart + ZERO_FRAC).slice(0, 18);
  const scaled = BigInt(intPart!) * SCALE_FACTOR + BigInt(padded || "0");
  return negative ? -scaled : scaled;
}

/** Convert a scaled BigInt back to a canonical (no trailing zeros) DecimalString.
 *  Throws if value is negative — use fromScaledSigned for that. */
export function fromScaled(n: bigint): DecimalString {
  if (n < 0n) throw new Error("fromScaled: value is negative; use fromScaledSigned");
  const intPart = n / SCALE_FACTOR;
  const fracPart = n % SCALE_FACTOR;
  if (fracPart === 0n) return intPart.toString() as DecimalString;
  let fracStr = fracPart.toString().padStart(18, "0");
  fracStr = fracStr.replace(/0+$/, "");
  return (intPart.toString() + "." + fracStr) as DecimalString;
}

/** Convert a scaled BigInt to a SignedDecimalString. Zero is "0", not "-0". */
export function fromScaledSigned(n: bigint): SignedDecimalString {
  if (n === 0n) return "0" as SignedDecimalString;
  if (n > 0n) return fromScaled(n) as unknown as SignedDecimalString;
  return ("-" + fromScaled(-n)) as SignedDecimalString;
}

export function addDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function subDecimal(a: DecimalString, b: DecimalString): DecimalString {
  const diff = toScaled(a) - toScaled(b);
  if (diff < 0n) {
    throw new Error(`subDecimal: underflow ${a} - ${b}`);
  }
  return fromScaled(diff);
}

/** Multiply two non-negative decimals. Result is rounded to 18 fractional
 *  digits according to `mode`. Use "ceil" for over-reservations, "floor" for
 *  conservative rounding. No default — callers must choose. */
export function mulDecimal(
  a: DecimalString,
  b: DecimalString,
  mode: "floor" | "ceil"
): DecimalString {
  const sa = toScaled(a);
  const sb = toScaled(b);
  const product = sa * sb; // scale 36
  const quotient = product / SCALE_FACTOR;
  const remainder = product % SCALE_FACTOR;
  if (remainder === 0n) return fromScaled(quotient);
  if (mode === "ceil") return fromScaled(quotient + 1n);
  return fromScaled(quotient);
}

export function cmpDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const sa = toScaled(a);
  const sb = toScaled(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function isZero(a: DecimalString): boolean {
  return toScaled(a) === 0n;
}

/** Round-trip through scaled BigInt to obtain a canonical form ("10.0" -> "10",
 *  "10.50" -> "10.5", "0" -> "0"). Use before storing values into vault state
 *  so canonical-JSON hashing is stable across equivalent inputs. */
export function normalizeDecimal(a: DecimalString): DecimalString {
  return fromScaled(toScaled(a));
}

/** balance + delta where delta is signed. Throws if the resulting balance < 0. */
export function applySignedDelta(
  balance: DecimalString,
  delta: SignedDecimalString
): DecimalString {
  const result = toScaled(balance) + toScaled(delta);
  if (result < 0n) {
    throw new Error(
      `applySignedDelta: result negative (balance=${balance}, delta=${delta})`
    );
  }
  return fromScaled(result);
}
