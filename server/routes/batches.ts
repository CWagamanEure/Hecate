/**
 * Batch close + public batch receipt fetch.
 *
 *   POST /batches/close      - run close pipeline, persist, return full bundle
 *   GET  /batches/:id/receipt - public batch receipt (no per-agent fill data)
 */

import type { FastifyInstance } from "fastify";
import {
  CloseBatchRequest,
  PersistedBatchRecord,
  FillReceipt,
  VaultState,
  ReservationBook
} from "@shared/schemas";
import {
  buildBatchFromReadyIntents,
  clearUniform
} from "@shared/matching";
import { applySettlement } from "@shared/settlement";
import { buildBatchReceipt, buildFillReceipts } from "@shared/receipts";
import {
  appendJsonl,
  readJsonl,
  writeJsonAtomic,
  resolveDataPath,
  FILES
} from "@shared/persistence";
import type { ServerState, Mutex } from "../state";

export async function batchesRoutes(
  app: FastifyInstance,
  opts: { state: ServerState; mutex: Mutex }
): Promise<void> {
  const { state, mutex } = opts;

  app.post("/batches/close", async (req, reply) => {
    const parse = CloseBatchRequest.safeParse(req.body ?? {});
    if (!parse.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: "INVALID_REQUEST", detail: parse.error.message }
      };
    }
    const body = parse.data;
    const now_ms = Date.now();
    const batch_id = body.batch_id ?? `batch_${now_ms}`;
    const market_snapshot = body.market_snapshot ?? null;

    return mutex.run(async () => {
      const readyIntents = Array.from(state.readyPool.values());
      const built = buildBatchFromReadyIntents({
        batch_id,
        readyIntents,
        now_ms,
        market_snapshot
      });
      if (built.batch_input === null) {
        return { ok: true, closed: false };
      }

      const vaultBefore = state.vault;
      const bookBefore = state.reservationBook;

      const fillPlan = clearUniform(built.batch_input);
      const apply = applySettlement({
        batch: built.batch_input,
        fillPlan,
        vaultStateBeforeSettlement: vaultBefore,
        reservationBookBeforeSettlement: bookBefore
      });

      const batch_receipt = buildBatchReceipt({
        batch: built.batch_input,
        fillPlan,
        settlement: apply.settlement,
        vaultStateBeforeSettlement: vaultBefore,
        vaultStateAfterSettlement: apply.vault_state_after_settlement,
        reservationBookBeforeSettlement: bookBefore,
        reservationBookAfterSettlement: apply.reservation_book_after_settlement,
        runtime: state.runtime,
        engineKey: state.engineKey
      });

      const fill_receipts = buildFillReceipts({
        batch: built.batch_input,
        fillPlan,
        reservationBook: bookBefore,
        runtime: state.runtime,
        engineKey: state.engineKey
      });

      // Persistence: logs first, then atomic snapshots.
      await appendJsonl(
        resolveDataPath(state.dataDir, FILES.batches),
        {
          batch_receipt,
          settlement: apply.settlement,
          fill_receipt_intent_ids: built.accepted_intent_ids
        },
        PersistedBatchRecord
      );
      for (const fr of fill_receipts) {
        await appendJsonl(
          resolveDataPath(state.dataDir, FILES.receipts),
          fr,
          FillReceipt
        );
      }
      await writeJsonAtomic(
        resolveDataPath(state.dataDir, FILES.vault),
        apply.vault_state_after_settlement,
        VaultState
      );
      await writeJsonAtomic(
        resolveDataPath(state.dataDir, FILES.reservations),
        apply.reservation_book_after_settlement,
        ReservationBook
      );

      // Update in-memory state and clear processed intents.
      state.vault = apply.vault_state_after_settlement;
      state.reservationBook = apply.reservation_book_after_settlement;
      for (const id of built.accepted_intent_ids) {
        state.readyPool.delete(id);
      }

      // v1 LOCAL_MOCK: return the full artifact bundle for client-side
      // verification convenience. Production EIGEN_TEE should NOT include
      // private fill_receipts here; agents fetch them via the owner-gated
      // endpoint. Documented in Ticket 15.
      return {
        ok: true,
        closed: true,
        batch_receipt,
        fill_receipts,
        settlement: apply.settlement,
        batch: built.batch_input,
        fill_plan: fillPlan,
        vault_state_before_settlement: vaultBefore,
        vault_state_after_settlement: apply.vault_state_after_settlement,
        reservation_book_before_settlement: bookBefore,
        reservation_book_after_settlement: apply.reservation_book_after_settlement
      };
    });
  });

  app.get<{ Params: { id: string } }>(
    "/batches/:id/receipt",
    async (req, reply) => {
      const id = req.params.id;
      const records = await readJsonl(
        resolveDataPath(state.dataDir, FILES.batches),
        PersistedBatchRecord,
        { allowMissing: true }
      );
      const rec = records.find((r) => r.batch_receipt.batch_id === id);
      if (!rec) {
        reply.code(404);
        return {
          ok: false,
          error: {
            code: "BATCH_NOT_FOUND",
            detail: `no batch ${id}`
          }
        };
      }
      return { ok: true, batch_receipt: rec.batch_receipt };
    }
  );
}
