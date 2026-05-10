import { z } from "zod";

// Up to 36 integer digits, optional fractional part with up to 18 decimals.
// No leading +/-, no scientific notation, no leading zeros except "0" itself,
// no trailing decimal point.
const DECIMAL_REGEX = /^(0|[1-9]\d{0,35})(\.\d{1,18})?$/;
const SIGNED_DECIMAL_REGEX = /^-?(0|[1-9]\d{0,35})(\.\d{1,18})?$/;

export const DecimalString = z
  .string()
  .regex(
    DECIMAL_REGEX,
    "must be a non-negative decimal string with ≤18 fractional digits and ≤36 integer digits"
  );

export type DecimalString = z.infer<typeof DecimalString>;

export const SignedDecimalString = z
  .string()
  .regex(
    SIGNED_DECIMAL_REGEX,
    "must be a signed decimal string with ≤18 fractional digits and ≤36 integer digits"
  );

export type SignedDecimalString = z.infer<typeof SignedDecimalString>;

// Re-export the proper comparator from shared/math/decimal under the schema-level
// name `decCmp` so refinements in payload.ts continue to import from "./decimal".
// This finishes the TODO from Ticket 3.
export { cmpDecimal as decCmp } from "@shared/math/decimal";
