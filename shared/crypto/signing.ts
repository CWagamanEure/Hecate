import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";
import { getAddress } from "viem";

// @noble/secp256k1 v2 requires the consumer to wire HMAC-SHA256 for RFC 6979
// deterministic signing. Without this, sync sign() throws
// "hashes.hmacSha256Sync not set".
secp.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array =>
  hmac(sha256, key, secp.etc.concatBytes(...msgs));
import { hashCanonical } from "./hashing";
import type {
  Hex32,
  Hex65,
  HexAddress,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  VerifyResult,
  VerifyFailure
} from "@shared/schemas";

/**
 * v1 signing format
 * -----------------
 * Hash: keccak256(canonicalJson(canonicalizeEnvelopeForSigning(envelope))).
 * Signature: secp256k1 over that hash, encoded as 65 bytes r||s||v with
 * v = 27 + recovery_bit (Ethereum convention). Recovery accepts v ∈ {0, 1, 27, 28}.
 *
 * Canonicalization before hashing: agent_id is normalized to EIP-55 checksum
 * form, and any signature field is stripped. This makes address casing not part
 * of the signed semantic payload — lowercase, uppercase, and mixed-case agent_id
 * inputs all produce the same signing hash.
 *
 * This is v1-local protocol signing, not wallet UX signing. An autonomous-agent
 * runtime signs the canonical-JSON hash directly with a key it holds. There is
 * no EIP-191 prefix and no EIP-712 typed-data domain.
 *
 * TODO(post-v1): migrate to EIP-712 typed-data so wallet UX flows can sign
 * envelopes with a structured-data prompt and on-chain verifier contracts can
 * recompute the same hash via abi.encode + keccak256. The migration changes the
 * signing preimage; receipts produced under v1 keys will not verify under the
 * new scheme. Plan a versioned envelope.
 */

const enc = new TextEncoder();

function bytesToBigint(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = 0; i < b.length; i++) r = (r << 8n) | BigInt(b[i]!);
  return r;
}

function bigintTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function toBytes(input: Hex32 | Uint8Array | string): Uint8Array {
  if (typeof input === "string") {
    return hexToBytes(input.startsWith("0x") ? input.slice(2) : input);
  }
  return input;
}

/** Normalize an address to EIP-55 checksum form. Throws on malformed input. */
export function normalizeAddress(addr: string): HexAddress {
  return getAddress(addr) as HexAddress;
}

/** Derive an EIP-55 checksum address from a secp256k1 private key. */
export function privateKeyToAddress(pk: Hex32 | Uint8Array): HexAddress {
  const bytes = toBytes(pk);
  const pub = secp.getPublicKey(bytes, false); // 65 bytes: 0x04 || x || y
  const xy = pub.subarray(1);
  const hash = keccak_256(xy);
  return normalizeAddress("0x" + bytesToHex(hash.subarray(12)));
}

/**
 * Canonicalize an envelope for signing: normalize agent_id to EIP-55 and strip
 * the signature field (if present). Returned shape is PublicEnvelopeUnsigned.
 */
export function canonicalizeEnvelopeForSigning(
  env: PublicEnvelope | PublicEnvelopeUnsigned
): PublicEnvelopeUnsigned {
  if ("signature" in env) {
    const { signature: _sig, agent_id, ...rest } = env;
    return { ...rest, agent_id: normalizeAddress(agent_id) };
  }
  return { ...env, agent_id: normalizeAddress(env.agent_id) };
}

/** Hash the canonicalized unsigned envelope. Used for both signing and recovery. */
export function envelopeSigningHash(
  env: PublicEnvelope | PublicEnvelopeUnsigned
): Hex32 {
  return hashCanonical(canonicalizeEnvelopeForSigning(env));
}

function encodeSignatureHex(r: bigint, s: bigint, recovery: number): Hex65 {
  const rBytes = bigintTo32Bytes(r);
  const sBytes = bigintTo32Bytes(s);
  const v = new Uint8Array([27 + recovery]);
  return ("0x" + bytesToHex(concatBytes(rBytes, sBytes, v))) as Hex65;
}

function decodeSignatureHex(sig: string): {
  r: bigint;
  s: bigint;
  recovery: number;
} {
  if (!sig.startsWith("0x") || sig.length !== 132) {
    throw new Error("invalid signature length");
  }
  const bytes = hexToBytes(sig.slice(2));
  const r = bytesToBigint(bytes.subarray(0, 32));
  const s = bytesToBigint(bytes.subarray(32, 64));
  const v = bytes[64]!;
  const recovery =
    v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1;
  if (recovery < 0) throw new Error(`invalid v byte: ${v}`);
  return { r, s, recovery };
}

/**
 * Sign an arbitrary 32-byte hash with secp256k1. Output v ∈ {27, 28} (Ethereum
 * convention). Used directly by receipt signers (engine signs receipt-body
 * hashes). Envelope signing is a thin wrapper.
 */
export function signHash(
  hashHex: Hex32,
  pk: Hex32 | Uint8Array
): Hex65 {
  const hashBytes = hexToBytes(hashHex.slice(2));
  const pkBytes = toBytes(pk);
  const sig = secp.sign(hashBytes, pkBytes);
  return encodeSignatureHex(sig.r, sig.s, sig.recovery);
}

/**
 * Recover the signer address from a 32-byte hash and a 65-byte signature.
 * Returns EIP-55 checksum address. Accepts v ∈ {0, 1, 27, 28}.
 * Throws on malformed signatures (length / hex / v invariants).
 */
export function recoverHashSigner(hashHex: Hex32, sig: Hex65): HexAddress {
  const hashBytes = hexToBytes(hashHex.slice(2));
  const { r, s, recovery } = decodeSignatureHex(sig);
  const sigObj = new secp.Signature(r, s, recovery);
  const pub = sigObj.recoverPublicKey(hashBytes);
  const pubBytes = pub.toRawBytes(false);
  const xy = pubBytes.subarray(1);
  const h = keccak_256(xy);
  return normalizeAddress("0x" + bytesToHex(h.subarray(12)));
}

/** Sign an unsigned envelope. Returns the full signed envelope (agent_id is
 *  passed through as-is in the output; the signature was computed over the
 *  canonicalized form so case-only variations of agent_id verify identically). */
export function signEnvelope(
  unsigned: PublicEnvelopeUnsigned,
  pk: Hex32 | Uint8Array
): PublicEnvelope {
  const signature = signHash(envelopeSigningHash(unsigned), pk);
  return { ...unsigned, signature };
}

/** Recover the signer of an envelope. Returns EIP-55 checksum address.
 *  Throws on malformed signatures (defense-in-depth; schema rejects upstream). */
export function recoverEnvelopeSigner(env: PublicEnvelope): HexAddress {
  return recoverHashSigner(envelopeSigningHash(env), env.signature);
}

/** Verify only the envelope signature: recover and compare to agent_id (both
 *  normalized to EIP-55). Returns VerifyResult. */
export function verifyEnvelopeSignature(env: PublicEnvelope): VerifyResult {
  try {
    const recovered = recoverEnvelopeSigner(env);
    const declared = normalizeAddress(env.agent_id);
    if (recovered === declared) return { ok: true };
    return {
      ok: false,
      failures: [
        {
          code: "INVALID_SIGNATURE",
          path: "/signature",
          detail: `recovered ${recovered} != declared ${declared}`
        }
      ]
    };
  } catch (e) {
    return {
      ok: false,
      failures: [
        {
          code: "INVALID_SIGNATURE",
          path: "/signature",
          detail: (e as Error).message
        }
      ]
    };
  }
}

/** Verify signature, expiry, and (optionally) nonce uniqueness. Collects all
 *  failures rather than short-circuiting. Does NOT verify payload commitment,
 *  solvency, market support beyond schema, or anything that requires external
 *  state beyond `now_ms` and `seenNonces`. Those checks live in later tickets. */
export function verifyEnvelopeBasic(
  env: PublicEnvelope,
  opts: { now_ms: number; seenNonces?: ReadonlySet<string> }
): VerifyResult {
  const failures: VerifyFailure[] = [];

  try {
    const recovered = recoverEnvelopeSigner(env);
    const declared = normalizeAddress(env.agent_id);
    if (recovered !== declared) {
      failures.push({
        code: "INVALID_SIGNATURE",
        path: "/signature",
        detail: `recovered ${recovered} != declared ${declared}`
      });
    }
  } catch (e) {
    failures.push({
      code: "INVALID_SIGNATURE",
      path: "/signature",
      detail: (e as Error).message
    });
  }

  if (opts.now_ms > env.expiry_ms) {
    failures.push({
      code: "EXPIRED",
      path: "/expiry_ms",
      detail: `now_ms=${opts.now_ms} > expiry_ms=${env.expiry_ms}`
    });
  }

  if (opts.seenNonces?.has(env.nonce)) {
    failures.push({
      code: "DUPLICATE_NONCE",
      path: "/nonce",
      detail: `nonce ${env.nonce} already seen`
    });
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}
