/**
 * Long-run deterministic soak: 30 mini demo cycles against the Fastify app.
 *
 * Each cycle: fresh app + temp data dir, 3-5 agents, deposits, intent
 * submissions, batch close, verifyFullBatch on the returned bundle, vault
 * invariants, and final-state assertions.
 *
 * Fixed seeds; on failure prints the seed and cycle index for reproduction.
 *
 * If npm test runtime grows uncomfortable, this file can be moved behind a
 * separate `npm run test:soak` script. For now it's part of the main suite
 * (~3-5s on a development laptop).
 */

import { describe, it, expect, afterAll } from "vitest";
import { newApp, cleanupTempDirs } from "./serverFixture";
import {
  signEnvelope,
  hashPayload,
  mockEncryptPayload,
  deriveMockEnclaveKey,
  privateKeyToAddress
} from "@shared/crypto";
import { assertVaultInvariants } from "@shared/vault";
import { makeRng } from "./adversarial/seededRng";
import type {
  PrivatePayload,
  PublicEnvelopeUnsigned,
  HexBytes
} from "@shared/schemas";

afterAll(cleanupTempDirs);

const TEST_CODE_DIGEST = "sha256:test";
const ENCLAVE = deriveMockEnclaveKey(TEST_CODE_DIGEST);

function key(i: number): string {
  return "0x" + (i + 16).toString(16).padStart(64, "0");
}

const CYCLES = 30;

describe("soak — 30 demo cycles", () => {
  it("each cycle: deposits, intents, close batch, verify, invariants", { timeout: 60_000 }, async () => {
    for (let s = 1; s <= CYCLES; s++) {
      const rng = makeRng(s);
      const { app, state } = await newApp();
      const numAgents = rng.nextInt(3) + 3; // 3..5
      const agents: { pk: string; addr: string; side: "BUY" | "SELL" }[] = [];
      for (let a = 0; a < numAgents; a++) {
        const pk = key(s * 100 + a);
        const addr = privateKeyToAddress(pk);
        const side = a % 2 === 0 ? "SELL" : "BUY";
        agents.push({ pk, addr, side });
        if (side === "SELL") {
          await app.inject({
            method: "POST",
            url: "/vault/mock-deposit",
            payload: { agent_id: addr, asset: "ETH", amount: "20" }
          });
        } else {
          await app.inject({
            method: "POST",
            url: "/vault/mock-deposit",
            payload: { agent_id: addr, asset: "USDC", amount: "100000" }
          });
        }
      }

      const submitted: { intent_id: string; agent_idx: number }[] = [];
      for (let a = 0; a < agents.length; a++) {
        const ag = agents[a]!;
        const isBuy = ag.side === "BUY";
        const max = String(rng.nextInt(5) + 1); // 1..5
        const limit = isBuy
          ? String(3590 + rng.nextInt(20))
          : String(3580 + rng.nextInt(20));
        const payload: PrivatePayload = {
          side: ag.side,
          asset_in: isBuy ? "USDC" : "ETH",
          asset_out: isBuy ? "ETH" : "USDC",
          max_base_amount: max,
          limit_price: limit,
          allow_partial_fill: true,
          min_base_fill_amount: "0.5",
          deadline_batches: 3,
          max_price_impact_bps: 10000,
          fallback_after_batches: null,
          nonce: `n-${s}-${a}-${Date.now()}-${rng.nextInt(1e6)}`
        };
        const ciphertext: HexBytes = mockEncryptPayload(payload, ENCLAVE);
        const intent_id = `intent_soak_${s}_${a}`;
        const u: PublicEnvelopeUnsigned = {
          intent_id,
          agent_id: ag.addr,
          market: "ETH/USDC",
          expiry_ms: Date.now() + 60_000,
          payload_commitment: hashPayload(payload),
          payload_ciphertext: ciphertext,
          nonce: payload.nonce
        };
        const env = signEnvelope(u, ag.pk);
        const r = await app.inject({
          method: "POST",
          url: "/intents",
          payload: env
        });
        if (r.statusCode === 200) {
          submitted.push({ intent_id, agent_idx: a });
        }
      }

      const close = await app.inject({
        method: "POST",
        url: "/batches/close",
        payload: {}
      });
      const closeBody = close.json();

      if (closeBody.closed) {
        // Verify the bundle.
        const verify = await app.inject({
          method: "POST",
          url: "/receipts/verify",
          payload: {
            batchReceipt: closeBody.batch_receipt,
            fillReceipts: closeBody.fill_receipts,
            batch: closeBody.batch,
            fillPlan: closeBody.fill_plan,
            settlement: closeBody.settlement,
            vaultStateBeforeSettlement: closeBody.vault_state_before_settlement,
            vaultStateAfterSettlement: closeBody.vault_state_after_settlement,
            reservationBookBeforeSettlement: closeBody.reservation_book_before_settlement,
            reservationBookAfterSettlement: closeBody.reservation_book_after_settlement,
            expectedEngineAddress: state.engineAddress
          }
        });
        if (!verify.json().ok) {
          throw new Error(
            `seed=${s}: verifyFullBatch failed: ${JSON.stringify(verify.json().failures)}`
          );
        }
      }

      // Vault invariants always hold.
      try {
        assertVaultInvariants(state.vault, state.reservationBook);
      } catch (e) {
        throw new Error(`seed=${s}: vault invariants violated: ${(e as Error).message}`);
      }

      // After close, ready pool empty.
      expect(state.readyPool.size).toBe(0);

      // For every settled intent, no reservation remains for that intent_id.
      for (const sub of submitted) {
        const stillReserved = state.reservationBook.reservations.find(
          (r) => r.intent_id === sub.intent_id && r.status === "RESERVED"
        );
        if (stillReserved) {
          throw new Error(
            `seed=${s}: intent ${sub.intent_id} still RESERVED after batch close`
          );
        }
      }
    }
  });
});
