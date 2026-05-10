/**
 * Owner-gated access via signed challenge. Used by endpoints that expose
 * private per-intent artifacts (fill receipt, intent status).
 *
 * Challenge canonical form:
 *   {
 *     "action": "<ChallengeAction>",
 *     "intent_id": "<id>",
 *     "timestamp_ms": <number>
 *   }
 *
 * Caller signs keccak256(canonicalJson(challenge)) with their secp256k1 key.
 */

import {
  canonicalJson,
  keccak256Hex,
  recoverHashSigner,
  normalizeAddress
} from "@shared/crypto";
import type {
  HexAddress,
  Hex65,
  SignedChallengeRequest
} from "@shared/schemas";

export type ChallengeAction = "GET_FILL_RECEIPT" | "GET_INTENT_STATUS";

export type ChallengeResult =
  | { ok: true; requester: HexAddress }
  | { ok: false; status: number; code: string; detail: string };

const WINDOW_MS = 60_000;

export function verifySignedChallenge(
  action: ChallengeAction,
  intent_id: string,
  challenge: SignedChallengeRequest,
  now_ms: number
): ChallengeResult {
  if (Math.abs(now_ms - challenge.timestamp_ms) > WINDOW_MS) {
    return {
      ok: false,
      status: 401,
      code: "STALE_REQUEST",
      detail: `timestamp ${challenge.timestamp_ms} not within ±${WINDOW_MS}ms of server now ${now_ms}`
    };
  }
  const challengeJson = canonicalJson({
    action,
    intent_id,
    timestamp_ms: challenge.timestamp_ms
  });
  const hash = keccak256Hex(challengeJson);
  let recovered: HexAddress;
  try {
    recovered = recoverHashSigner(hash, challenge.signature);
  } catch (e) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_REQUEST_SIGNATURE",
      detail: (e as Error).message
    };
  }
  const claimed = normalizeAddress(challenge.requester);
  if (recovered !== claimed) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_REQUEST_SIGNATURE",
      detail: `recovered ${recovered} != requester ${claimed}`
    };
  }
  return { ok: true, requester: claimed };
}
