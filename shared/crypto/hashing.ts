import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalJson } from "./canonicalJson";
import type {
  Hex32,
  PrivatePayload,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  SettlementObject,
  VaultState,
  ReservationBook,
  BatchReceipt,
  BatchReceiptBody,
  FillReceipt,
  FillReceiptBody
} from "@shared/schemas";

export type HashAlgo = "keccak256" | "sha256";

const enc = new TextEncoder();

export function keccak256Hex(input: string | Uint8Array): Hex32 {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  return ("0x" + bytesToHex(keccak_256(bytes))) as Hex32;
}

export function sha256Hex(input: string | Uint8Array): Hex32 {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  return ("0x" + bytesToHex(sha256(bytes))) as Hex32;
}

/**
 * Hash a structured value via canonicalJson.
 *
 * Default is keccak256 because the system is Ethereum-native and the optional
 * on-chain verifier (Ticket 19) recomputes hashes with cheap keccak primitives.
 *
 * sha256 is exposed for compatibility with external/container digest conventions
 * (e.g. `sha256:<digest>` strings). Receipt-related hashes must use keccak256.
 * `engine_code_digest` is an opaque string set from the build pipeline; it is
 * not recomputed as a receipt hash in v1.
 */
export function hashCanonical(
  value: unknown,
  algo: HashAlgo = "keccak256"
): Hex32 {
  const json = canonicalJson(value);
  return algo === "keccak256" ? keccak256Hex(json) : sha256Hex(json);
}

// ---- Typed body helpers ------------------------------------------------------
//
// Every typed helper routes through hashCanonical so canonicalization happens
// in exactly one place. Helpers that strip a signature do so explicitly so the
// signing path and the verifier path can never accidentally include the
// signature in the hash.

export function hashPayload(p: PrivatePayload): Hex32 {
  return hashCanonical(p);
}

export function hashEnvelope(
  e: PublicEnvelope | PublicEnvelopeUnsigned
): Hex32 {
  return hashCanonical(e);
}

// envelopeSigningHash moved to ./signing because it must canonicalize agent_id
// to EIP-55 before hashing, and the address utilities live in signing.ts.

export function hashSettlement(s: SettlementObject): Hex32 {
  return hashCanonical(s);
}

export function hashVaultState(v: VaultState): Hex32 {
  return hashCanonical(v);
}

/**
 * Hash a ReservationBook. Defensively sorts reservations by intent_id before
 * hashing so the result is independent of insertion order, even though the book
 * is also maintained sorted by the vault module.
 */
export function hashReservationBook(book: ReservationBook): Hex32 {
  const sorted = [...book.reservations].sort((a, b) =>
    a.intent_id < b.intent_id ? -1 : a.intent_id > b.intent_id ? 1 : 0
  );
  return hashCanonical({ reservations: sorted });
}

export function hashBatchReceiptBody(
  r: BatchReceipt | BatchReceiptBody
): Hex32 {
  if ("engine_signature" in r) {
    // Strip BOTH the canonical receipt signature and the V2 on-chain vault
    // signature. The on-chain signature is over a different preimage
    // (abi-encoded vault settlement, not canonical-JSON receipt), so its
    // presence/absence must not affect the canonical receipt hash.
    const { engine_signature: _sig, engine_signature_onchain: _onchain, ...rest } = r as
      BatchReceipt & { engine_signature_onchain?: string };
    return hashCanonical(rest);
  }
  return hashCanonical(r);
}

export function hashFillReceiptBody(r: FillReceipt | FillReceiptBody): Hex32 {
  if ("engine_signature" in r) {
    const { engine_signature: _sig, ...rest } = r;
    return hashCanonical(rest);
  }
  return hashCanonical(r);
}

// ---- Aggregate hash placeholder ---------------------------------------------
//
// v1 uses this in place of a Merkle root for `intent_envelope_root` and
// `private_payload_commitment_root`. Ticket 13 may upgrade to a true Merkle
// root with the same return type; the change is internal to the receipt
// builder and does not break the receipt schema.

/**
 * Deterministic ordered-aggregate hash. Hashes the canonical JSON of the array.
 *
 * - With `sortBy`: items are sorted by the returned key string before hashing.
 * - Without `sortBy`: items are hashed in the order provided. The caller is
 *   asserting the order is canonical (e.g. already sorted).
 * - Empty arrays are allowed and produce a stable hash (keccak256("[]")).
 *
 * NOT a Merkle root yet. Documented placeholder; see Ticket 13.
 */
export function orderedAggregateHash<T>(
  items: readonly T[],
  opts: { sortBy?: (item: T) => string; algo?: HashAlgo } = {}
): Hex32 {
  const algo = opts.algo ?? "keccak256";
  let arr: readonly T[] = items;
  if (opts.sortBy) {
    const keyOf = opts.sortBy;
    arr = [...items].sort((a, b) => {
      const sa = keyOf(a);
      const sb = keyOf(b);
      if (sa === sb) return 0;
      return sa < sb ? -1 : 1;
    });
  }
  return hashCanonical(arr, algo);
}
