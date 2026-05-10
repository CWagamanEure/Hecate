import { hashPayload } from "./hashing";
import type {
  PublicEnvelope,
  PrivatePayload,
  VerifyResult
} from "@shared/schemas";

/**
 * Verify that a decrypted payload matches the envelope's payload_commitment.
 * Returns VerifyResult so callers can collect this failure alongside others
 * (signature, expiry, nonce, solvency).
 *
 * The `payload.nonce` field acts as a commitment salt — see Ticket 6 design
 * note. Identical execution constraints with different `payload.nonce` produce
 * different commitments, defeating rainbow-table correlation of public
 * commitments to known strategies.
 */
export function verifyPayloadCommitment(
  env: PublicEnvelope,
  decrypted: PrivatePayload
): VerifyResult {
  const computed = hashPayload(decrypted);
  if (env.payload_commitment === computed) return { ok: true };
  return {
    ok: false,
    failures: [
      {
        code: "INVALID_PAYLOAD_COMMITMENT",
        path: "/payload_commitment",
        detail: `commitment mismatch: env=${env.payload_commitment} computed=${computed}`
      }
    ]
  };
}
