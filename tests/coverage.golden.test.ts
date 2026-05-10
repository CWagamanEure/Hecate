/**
 * Golden snapshot of the canonical 4-agent demo. Asserts SEMANTIC outputs
 * (clearing price, fill amounts, balances, statuses) — not full-receipt JSON,
 * since signatures are deterministic but the receipt body includes timestamps
 * that vary per run.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  PK_B,
  PK_C,
  PK_D,
  ADDR_A,
  ADDR_B,
  ADDR_C,
  ADDR_D,
  sellPayload,
  buyPayload,
  makeEnvelope
} from "./serverFixture";

afterAll(cleanupTempDirs);

describe("golden — canonical 4-agent demo", () => {
  it("matches every locked-in semantic value", async () => {
    const { app, state } = await newApp();

    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_B, asset: "USDC", amount: "20000" }
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_C, asset: "USDC", amount: "30000" }
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_D, asset: "USDC", amount: "100" }
    });

    const ra = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_A",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "10", limit: "3580" })
      })
    });
    const rb = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_B",
        agent_id: ADDR_B,
        pk: PK_B,
        payload: buyPayload({ base: "4", limit: "3610" })
      })
    });
    const rc = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_C",
        agent_id: ADDR_C,
        pk: PK_C,
        payload: buyPayload({ base: "8", limit: "3590", min: "1" })
      })
    });
    const rd = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_D",
        agent_id: ADDR_D,
        pk: PK_D,
        payload: buyPayload({ base: "1", limit: "3600" })
      })
    });

    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect(rc.statusCode).toBe(200);
    expect(rd.statusCode).toBe(400);
    expect(rd.json().error.code).toBe("INSUFFICIENT_FUNDS");

    const close = await app.inject({
      method: "POST",
      url: "/batches/close",
      payload: { batch_id: "batch_golden" }
    });
    const bundle = close.json();

    // Locked semantic outputs.
    expect(bundle.batch_receipt.clearing_price).toBe("3590");
    expect(bundle.batch_receipt.num_intents).toBe(3);
    expect(bundle.batch_receipt.num_matched).toBe(3);
    expect(bundle.batch_receipt.matching_rule).toBe("UNIFORM_CLEARING_PRICE_V1");
    expect(bundle.batch_receipt.market).toBe("ETH/USDC");

    const fillById = new Map<string, any>(
      bundle.fill_receipts.map((fr: any) => [fr.intent_id, fr])
    );

    expect(fillById.get("intent_A")?.status).toBe("FILLED");
    expect(fillById.get("intent_A")?.filled_base).toBe("10");
    expect(fillById.get("intent_A")?.filled_quote).toBe("35900");

    expect(fillById.get("intent_B")?.status).toBe("FILLED");
    expect(fillById.get("intent_B")?.filled_base).toBe("4");
    expect(fillById.get("intent_B")?.filled_quote).toBe("14360");

    expect(fillById.get("intent_C")?.status).toBe("PARTIALLY_FILLED");
    expect(fillById.get("intent_C")?.filled_base).toBe("6");
    expect(fillById.get("intent_C")?.filled_quote).toBe("21540");

    // Final balances.
    expect(state.vault.agents[ADDR_A]!.balances.ETH).toBe("0");
    expect(state.vault.agents[ADDR_A]!.balances.USDC).toBe("35900");
    expect(state.vault.agents[ADDR_B]!.balances.ETH).toBe("4");
    expect(state.vault.agents[ADDR_B]!.balances.USDC).toBe("5640");
    expect(state.vault.agents[ADDR_C]!.balances.ETH).toBe("6");
    expect(state.vault.agents[ADDR_C]!.balances.USDC).toBe("8460");
    expect(state.vault.agents[ADDR_D]!.balances.ETH).toBe("0");
    expect(state.vault.agents[ADDR_D]!.balances.USDC).toBe("100");

    // verifyFullBatch ok on returned bundle.
    const verify = await app.inject({
      method: "POST",
      url: "/receipts/verify",
      payload: {
        batchReceipt: bundle.batch_receipt,
        fillReceipts: bundle.fill_receipts,
        batch: bundle.batch,
        fillPlan: bundle.fill_plan,
        settlement: bundle.settlement,
        vaultStateBeforeSettlement: bundle.vault_state_before_settlement,
        vaultStateAfterSettlement: bundle.vault_state_after_settlement,
        reservationBookBeforeSettlement: bundle.reservation_book_before_settlement,
        reservationBookAfterSettlement: bundle.reservation_book_after_settlement,
        expectedEngineAddress: state.engineAddress
      }
    });
    const verifyJson = verify.json();
    expect(verifyJson.ok).toBe(true);
    expect(verifyJson.bundle_id).toMatch(/^0x[a-f0-9]{64}$/);
  });
});
