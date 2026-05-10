/**
 * Intent submission and owner-gated per-intent endpoints.
 *
 *   POST /intents                       - submit + acceptIntent + persist
 *   POST /intents/:id/status            - owner-gated status lookup
 *   POST /intents/:id/fill-receipt      - owner-gated fill receipt fetch
 */

import type { FastifyInstance } from "fastify";
import {
  PublicEnvelope,
  PersistedIntentRecord,
  PersistedRejection,
  SignedChallengeRequest,
  FillReceipt,
  type IntentStatus
} from "@shared/schemas";
import { acceptIntent } from "@shared/matching";
import {
  mockDecryptPayload,
  normalizeAddress
} from "@shared/crypto";
import {
  appendJsonl,
  readJsonl,
  writeJsonAtomic,
  resolveDataPath,
  FILES
} from "@shared/persistence";
import { VaultState, ReservationBook } from "@shared/schemas";
import type { ServerState, Mutex } from "../state";
import { verifySignedChallenge } from "../auth";

export async function intentsRoutes(
  app: FastifyInstance,
  opts: { state: ServerState; mutex: Mutex }
): Promise<void> {
  const { state, mutex } = opts;

  app.post("/intents", async (req, reply) => {
    const parse = PublicEnvelope.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          detail: parse.error.message
        }
      };
    }
    // Normalize agent_id to EIP-55 before persisting (per Ticket 9 user-note 2).
    const envelope = {
      ...parse.data,
      agent_id: normalizeAddress(parse.data.agent_id)
    };
    const received_ms = Date.now();

    return mutex.run(async () => {
      const result = acceptIntent({
        pendingIntent: { envelope, received_ms },
        vaultState: state.vault,
        reservationBook: state.reservationBook,
        decrypt: (ct) => mockDecryptPayload(ct, state.mockEnclaveKey),
        now_ms: received_ms
      });

      if (result.ok) {
        await appendJsonl(
          resolveDataPath(state.dataDir, FILES.intents),
          { envelope, received_ms },
          PersistedIntentRecord
        );
        await writeJsonAtomic(
          resolveDataPath(state.dataDir, FILES.vault),
          result.vault_state_after,
          VaultState
        );
        await writeJsonAtomic(
          resolveDataPath(state.dataDir, FILES.reservations),
          result.reservation_book_after,
          ReservationBook
        );
        state.vault = result.vault_state_after;
        state.reservationBook = result.reservation_book_after;
        state.readyPool.set(envelope.intent_id, result.ready_intent);
        return {
          ok: true,
          intent_id: envelope.intent_id,
          status: "OPEN" as IntentStatus
        };
      } else {
        await appendJsonl(
          resolveDataPath(state.dataDir, FILES.rejections),
          {
            envelope,
            received_ms,
            reject_reason: result.rejected.reject_reason,
            detail: result.rejected.detail
          },
          PersistedRejection
        );
        reply.code(400);
        return {
          ok: false,
          error: {
            code: result.rejected.reject_reason,
            detail: result.rejected.detail
          }
        };
      }
    });
  });

  // Owner-gated status lookup.
  app.post<{ Params: { id: string } }>(
    "/intents/:id/status",
    async (req, reply) => {
      const intent_id = req.params.id;
      const parse = SignedChallengeRequest.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            detail: parse.error.message
          }
        };
      }
      const challenge = parse.data;
      const auth = verifySignedChallenge(
        "GET_INTENT_STATUS",
        intent_id,
        challenge,
        Date.now()
      );
      if (!auth.ok) {
        reply.code(auth.status);
        return {
          ok: false,
          error: { code: auth.code, detail: auth.detail }
        };
      }
      const requester = auth.requester;

      // 1. Check ready pool.
      const ready = state.readyPool.get(intent_id);
      if (ready) {
        if (normalizeAddress(ready.envelope.agent_id) !== requester) {
          reply.code(403);
          return {
            ok: false,
            error: {
              code: "NOT_INTENT_OWNER",
              detail: "requester is not the intent owner"
            }
          };
        }
        return {
          ok: true,
          status: "OPEN" as IntentStatus
        };
      }

      // 2. Check fill receipts.
      const receiptsPath = resolveDataPath(state.dataDir, FILES.receipts);
      const receipts = await readJsonl(receiptsPath, FillReceipt, {
        allowMissing: true
      });
      const fr = receipts.find((r) => r.intent_id === intent_id);
      if (fr) {
        if (normalizeAddress(fr.agent_id) !== requester) {
          reply.code(403);
          return {
            ok: false,
            error: {
              code: "NOT_INTENT_OWNER",
              detail: "requester is not the intent owner"
            }
          };
        }
        return {
          ok: true,
          status: fr.status as IntentStatus,
          batch_id: fr.batch_id
        };
      }

      // 3. Check rejections.
      const rejectionsPath = resolveDataPath(state.dataDir, FILES.rejections);
      const rejections = await readJsonl(rejectionsPath, PersistedRejection, {
        allowMissing: true
      });
      const rej = rejections.find((r) => r.envelope.intent_id === intent_id);
      if (rej) {
        if (normalizeAddress(rej.envelope.agent_id) !== requester) {
          reply.code(403);
          return {
            ok: false,
            error: {
              code: "NOT_INTENT_OWNER",
              detail: "requester is not the intent owner"
            }
          };
        }
        return {
          ok: true,
          status: "REJECTED" as IntentStatus,
          reject_reason: rej.reject_reason,
          detail: rej.detail
        };
      }

      reply.code(404);
      return {
        ok: false,
        error: {
          code: "INTENT_NOT_FOUND",
          detail: `no intent ${intent_id}`
        }
      };
    }
  );

  // Owner-gated fill receipt access.
  app.post<{ Params: { id: string } }>(
    "/intents/:id/fill-receipt",
    async (req, reply) => {
      const intent_id = req.params.id;
      const parse = SignedChallengeRequest.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            detail: parse.error.message
          }
        };
      }
      const challenge = parse.data;
      const auth = verifySignedChallenge(
        "GET_FILL_RECEIPT",
        intent_id,
        challenge,
        Date.now()
      );
      if (!auth.ok) {
        reply.code(auth.status);
        return {
          ok: false,
          error: { code: auth.code, detail: auth.detail }
        };
      }
      const requester = auth.requester;

      const receiptsPath = resolveDataPath(state.dataDir, FILES.receipts);
      const receipts = await readJsonl(receiptsPath, FillReceipt, {
        allowMissing: true
      });
      const fr = receipts.find((r) => r.intent_id === intent_id);
      if (!fr) {
        reply.code(404);
        return {
          ok: false,
          error: {
            code: "FILL_RECEIPT_NOT_FOUND",
            detail: `no fill receipt for intent ${intent_id}`
          }
        };
      }
      if (normalizeAddress(fr.agent_id) !== requester) {
        reply.code(403);
        return {
          ok: false,
          error: {
            code: "NOT_RECEIPT_OWNER",
            detail: "requester is not the receipt owner"
          }
        };
      }
      return { ok: true, fill_receipt: fr };
    }
  );
}
