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

describe("end-to-end 4-agent demo via API", () => {
  it("submits intents, closes batch, verifies bundle", async () => {
    const { app, state } = await newApp();

    // Deposits.
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
    // Agent D has too little USDC.
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_D, asset: "USDC", amount: "100" }
    });

    // Build payloads/envelopes.
    const pa = sellPayload({ base: "10", limit: "3580" });
    const pb = buyPayload({ base: "4", limit: "3610" });
    const pc = buyPayload({ base: "8", limit: "3590", min: "1" });
    const pd = buyPayload({ base: "1", limit: "3600" }); // needs ~3600 USDC, has 100
    const ea = makeEnvelope({ intent_id: "intent_A", agent_id: ADDR_A, pk: PK_A, payload: pa });
    const eb = makeEnvelope({ intent_id: "intent_B", agent_id: ADDR_B, pk: PK_B, payload: pb });
    const ec = makeEnvelope({ intent_id: "intent_C", agent_id: ADDR_C, pk: PK_C, payload: pc });
    const ed = makeEnvelope({ intent_id: "intent_D", agent_id: ADDR_D, pk: PK_D, payload: pd });

    const ra = await app.inject({ method: "POST", url: "/intents", payload: ea });
    const rb = await app.inject({ method: "POST", url: "/intents", payload: eb });
    const rc = await app.inject({ method: "POST", url: "/intents", payload: ec });
    const rd = await app.inject({ method: "POST", url: "/intents", payload: ed });

    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect(rc.statusCode).toBe(200);
    expect(rd.statusCode).toBe(400);
    expect(rd.json().error.code).toBe("INSUFFICIENT_FUNDS");

    expect(state.readyPool.size).toBe(3);

    // Close batch.
    const close = await app.inject({
      method: "POST",
      url: "/batches/close",
      payload: { batch_id: "batch_demo_001" }
    });
    expect(close.statusCode).toBe(200);
    const bundle = close.json();
    expect(bundle.closed).toBe(true);
    expect(bundle.batch_receipt.clearing_price).toBe("3590");
    expect(bundle.batch_receipt.num_intents).toBe(3);
    expect(bundle.batch_receipt.num_matched).toBe(3);

    // Ready pool cleared.
    expect(state.readyPool.size).toBe(0);

    // Final balances.
    expect(state.vault.agents[ADDR_A]!.balances.ETH).toBe("0");
    expect(state.vault.agents[ADDR_A]!.balances.USDC).toBe("35900");
    expect(state.vault.agents[ADDR_B]!.balances.ETH).toBe("4");
    expect(state.vault.agents[ADDR_B]!.balances.USDC).toBe("5640"); // 20000 - 14360
    expect(state.vault.agents[ADDR_C]!.balances.ETH).toBe("6");
    expect(state.vault.agents[ADDR_C]!.balances.USDC).toBe("8460"); // 30000 - 21540

    // Verify the returned bundle.
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
    expect(verify.statusCode).toBe(200);
    const verifyJson = verify.json();
    expect(verifyJson.ok).toBe(true);
    expect(verifyJson.bundle_id).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("tampered vault_state_after sent to /receipts/verify -> not ok", async () => {
    const { app, state } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" }
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_B, asset: "USDC", amount: "20000" }
    });
    const pa = sellPayload({ base: "5", limit: "3580" });
    const pb = buyPayload({ base: "5", limit: "3600" });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({ intent_id: "intent_a", agent_id: ADDR_A, pk: PK_A, payload: pa })
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({ intent_id: "intent_b", agent_id: ADDR_B, pk: PK_B, payload: pb })
    });
    const close = await app.inject({
      method: "POST",
      url: "/batches/close",
      payload: {}
    });
    const bundle = close.json();

    // Tamper the vault_state_after_settlement.
    const tampered = {
      ...bundle.vault_state_after_settlement,
      agents: {
        ...bundle.vault_state_after_settlement.agents,
        [ADDR_A]: {
          ...bundle.vault_state_after_settlement.agents[ADDR_A],
          balances: { ETH: "0", USDC: "999999" }
        }
      }
    };

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
        vaultStateAfterSettlement: tampered,
        reservationBookBeforeSettlement: bundle.reservation_book_before_settlement,
        reservationBookAfterSettlement: bundle.reservation_book_after_settlement,
        expectedEngineAddress: state.engineAddress
      }
    });
    expect(verify.statusCode).toBe(200);
    const result = verify.json();
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("GET /batches/:id/receipt returns the public batch receipt", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" }
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_B, asset: "USDC", amount: "20000" }
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_a",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "5", limit: "3580" })
      })
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_b",
        agent_id: ADDR_B,
        pk: PK_B,
        payload: buyPayload({ base: "5", limit: "3600" })
      })
    });
    const close = await app.inject({
      method: "POST",
      url: "/batches/close",
      payload: { batch_id: "batch_lookup_001" }
    });
    expect(close.json().closed).toBe(true);

    const r = await app.inject({
      method: "GET",
      url: "/batches/batch_lookup_001/receipt"
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().batch_receipt.batch_id).toBe("batch_lookup_001");
  });

  it("GET /batches/<unknown>/receipt -> 404", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "GET",
      url: "/batches/batch_nope/receipt"
    });
    expect(r.statusCode).toBe(404);
  });
});
