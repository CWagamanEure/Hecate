/**
 * acceptIntent — per-submission intent acceptance pipeline (Model A).
 *
 * Called by the API on every POST /intents. Runs the full gauntlet:
 *   1. envelope signature + expiry verification
 *   2. mock decryption
 *   3. payload commitment verification
 *   4. solvency reservation (advances vault + reservation book)
 *   5. nonce marking (only on successful reservation)
 *
 * Returns either a ReadyIntent (for the in-memory ready pool) or a
 * RejectedIntent (for rejections.jsonl).
 *
 * v1 limitation: the ready pool is in-memory. If the server crashes after
 * acceptIntent succeeds (vault.json / reservations.json / intents.jsonl all
 * written) but before the next batch close, the decrypted payload is lost.
 * The reservation remains in vault.json, but the matcher cannot replay the
 * intent. Future hardening: persist accepted intents to a ready.jsonl that is
 * replayed on startup. See ROADMAP.
 */

import type {
  PublicEnvelope,
  PrivatePayload,
  HexBytes,
  VaultState,
  ReservationBook,
  RejectReason
} from "@shared/schemas";
import {
  verifyEnvelopeBasic,
  verifyPayloadCommitment
} from "@shared/crypto";
import { reserveForIntent } from "@shared/vault";

export type PendingIntent = {
  envelope: PublicEnvelope;
  received_ms: number;
};

export type RejectedIntent = {
  envelope: PublicEnvelope;
  received_ms: number;
  reject_reason: RejectReason;
  detail: string;
};

export type ReadyIntent = {
  envelope: PublicEnvelope;
  payload: PrivatePayload;
  received_ms: number;
  reservation_id: string; // = envelope.intent_id in v1 (one reservation per intent)
};

export type AcceptIntentInput = {
  pendingIntent: PendingIntent;
  vaultState: VaultState;
  reservationBook: ReservationBook;
  decrypt: (ct: HexBytes) => PrivatePayload;
  now_ms: number;
};

export type AcceptIntentResult =
  | {
      ok: true;
      ready_intent: ReadyIntent;
      vault_state_after: VaultState;
      reservation_book_after: ReservationBook;
    }
  | {
      ok: false;
      rejected: RejectedIntent;
      vault_state_after: VaultState; // unchanged from input (reference-equal)
      reservation_book_after: ReservationBook; // unchanged from input
    };

export function acceptIntent(input: AcceptIntentInput): AcceptIntentResult {
  const { pendingIntent: p, vaultState, reservationBook, decrypt, now_ms } = input;
  const env = p.envelope;

  const reject = (
    code: RejectReason,
    detail: string
  ): AcceptIntentResult => ({
    ok: false,
    rejected: {
      envelope: env,
      received_ms: p.received_ms,
      reject_reason: code,
      detail
    },
    vault_state_after: vaultState,
    reservation_book_after: reservationBook
  });

  // 1. signature + expiry. No seenNonces — reserveForIntent gates nonces with
  //    the proper per-agent set.
  const basic = verifyEnvelopeBasic(env, { now_ms });
  if (!basic.ok) {
    const first = basic.failures[0]!;
    // Concatenate all failures in detail; reject_reason is the first failure code.
    const detail = basic.failures
      .map((x) => `${x.code}:${x.detail ?? ""}`)
      .join("; ");
    return reject(first.code as RejectReason, detail);
  }

  // 2. decrypt
  let payload: PrivatePayload;
  try {
    payload = decrypt(env.payload_ciphertext);
  } catch (e) {
    return reject("MALFORMED_PAYLOAD", (e as Error).message);
  }

  // 3. payload commitment
  const commit = verifyPayloadCommitment(env, payload);
  if (!commit.ok) {
    return reject(
      "INVALID_PAYLOAD_COMMITMENT",
      commit.failures[0]!.detail ?? ""
    );
  }

  // 4. reserve (vault gate). Advances vault and reservation book on success.
  const r = reserveForIntent(
    vaultState,
    reservationBook,
    env,
    payload,
    now_ms
  );
  if (!r.ok) {
    return reject(r.code, r.detail);
  }

  return {
    ok: true,
    ready_intent: {
      envelope: env,
      payload,
      received_ms: p.received_ms,
      reservation_id: env.intent_id
    },
    vault_state_after: r.state,
    reservation_book_after: r.book
  };
}
