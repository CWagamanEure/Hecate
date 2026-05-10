/**
 * MOCK encryption for LOCAL_MOCK mode.
 *
 * ⚠ This module is NOT a confidentiality guarantee. ⚠
 *
 * LOCAL_MOCK encryption demonstrates the public-envelope/private-payload
 * separation only. The key is local to the process and an operator with
 * process-level access can read it. `deriveMockEnclaveKey` is NOT a production
 * KDF; it is a fixed transformation of CODE_DIGEST that exists solely to give
 * LOCAL_MOCK a deterministic test/dev key.
 *
 * In EIGEN_TEE, payloads should be encrypted to an attested enclave key derived
 * inside the enclave at startup, or submitted over an attested secure channel.
 * This module is the local-mode shim and must never be relied on for production
 * confidentiality.
 *
 * Algorithm: AES-256-GCM.
 *   - Key:        32 bytes
 *   - IV:         12 bytes (random per encryption by default; injectable for tests)
 *   - AEAD tag:   16 bytes
 *   - Ciphertext layout (hex-encoded as `payload_ciphertext`): IV || CT || TAG
 *   - No AAD in v1.
 *
 * TODO(post-v1): future versions may bind selected public-envelope fields as
 * AAD if the encryption layer needs stronger ciphertext/envelope coupling. The
 * v1 design relies on the post-decryption payload_commitment check for that
 * binding.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalJson } from "./canonicalJson";
import { PrivatePayload } from "@shared/schemas";
import type { HexBytes } from "@shared/schemas";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Derive the LOCAL_MOCK enclave key from CODE_DIGEST.
 *
 * Pure function — no env reads. Caller (server bootstrap) reads
 * `process.env.CODE_DIGEST` and passes it in. Callers in tests pass any string.
 *
 * Not a production KDF. See module-level warning.
 */
export function deriveMockEnclaveKey(codeDigest: string): Uint8Array {
  const salt = "hecate-local-mock-encryption-v1";
  return sha256(enc.encode(`${codeDigest}:${salt}`));
}

export function mockEncryptPayload(
  payload: PrivatePayload,
  key: Uint8Array,
  opts: { iv?: Uint8Array } = {}
): HexBytes {
  if (key.length !== KEY_LEN) throw new Error("key must be 32 bytes");
  const iv = opts.iv ?? randomBytes(IV_LEN);
  if (iv.length !== IV_LEN) throw new Error("iv must be 12 bytes");

  // Always encrypt the canonical JSON of the payload. Equivalent-but-non-canonical
  // inputs (e.g. different key order) would produce identical canonical JSON and
  // therefore identical commitments, but DIFFERENT ciphertexts (different IVs).
  const json = canonicalJson(payload);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(enc.encode(json)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, ct, tag]);
  // Buffer.toString("hex") is always lowercase.
  return ("0x" + out.toString("hex")) as HexBytes;
}

export function mockDecryptPayload(
  ciphertext: HexBytes,
  key: Uint8Array
): PrivatePayload {
  if (key.length !== KEY_LEN) throw new Error("key must be 32 bytes");
  const bytes = Buffer.from(ciphertext.slice(2), "hex");
  if (bytes.length < IV_LEN + TAG_LEN) {
    throw new Error(
      "decrypt failed (auth tag mismatch, bad key, malformed ciphertext, or corrupted payload)"
    );
  }
  const iv = bytes.subarray(0, IV_LEN);
  const tag = bytes.subarray(bytes.length - TAG_LEN);
  const ct = bytes.subarray(IV_LEN, bytes.length - TAG_LEN);

  let pt: Buffer;
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // Do not leak Node's underlying error text (minor side-channel hardening).
    throw new Error(
      "decrypt failed (auth tag mismatch, bad key, malformed ciphertext, or corrupted payload)"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(pt));
  } catch {
    throw new Error(
      "decrypt failed (auth tag mismatch, bad key, malformed ciphertext, or corrupted payload)"
    );
  }
  // Re-validate with Zod. A tampered or malformed payload throws at this step.
  return PrivatePayload.parse(parsed);
}
