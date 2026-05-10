import { z } from "zod";

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_65 = /^0x[0-9a-fA-F]{130}$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;

// Mixed-case is accepted at parse time. EIP-55 checksum canonicalization is the
// signing/verification layer's responsibility (Ticket 5).
export const HexAddress = z
  .string()
  .regex(HEX_ADDR, "must be a 0x-prefixed 20-byte hex address");

export const Hex32 = z
  .string()
  .regex(HEX_32, "must be 0x + 32 bytes (64 hex chars)");

// secp256k1 signature (r||s||v): 65 bytes = 130 hex chars.
export const Hex65 = z
  .string()
  .regex(HEX_65, "must be 0x + 65 bytes (130 hex chars)");

export const HexBytes = z
  .string()
  .regex(HEX_BYTES, "must be 0x + even-length hex");

export type HexAddress = z.infer<typeof HexAddress>;
export type Hex32 = z.infer<typeof Hex32>;
export type Hex65 = z.infer<typeof Hex65>;
export type HexBytes = z.infer<typeof HexBytes>;
