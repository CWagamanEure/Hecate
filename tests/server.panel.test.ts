/**
 * Tests for the demo verifier panel and the tamper-verify endpoint that backs
 * its "Tamper & verify" button.
 *
 * The panel is a thin client over /attestation, /receipts/verify, and
 * /receipts/tamper-verify. We assert the routes return the expected shape;
 * the HTML itself is checked for a known string.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  PK_B,
  ADDR_A,
  ADDR_B,
  sellPayload,
  buyPayload,
  makeEnvelope
} from "./serverFixture";

afterAll(cleanupTempDirs);

async function buildBundle() {
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
    payload: { batch_id: "batch_panel_001" }
  });
  const c = close.json();
  const bundle = {
    batchReceipt: c.batch_receipt,
    fillReceipts: c.fill_receipts,
    batch: c.batch,
    fillPlan: c.fill_plan,
    settlement: c.settlement,
    vaultStateBeforeSettlement: c.vault_state_before_settlement,
    vaultStateAfterSettlement: c.vault_state_after_settlement,
    reservationBookBeforeSettlement: c.reservation_book_before_settlement,
    reservationBookAfterSettlement: c.reservation_book_after_settlement,
    expectedEngineAddress: state.engineAddress
  };
  return { app, bundle };
}

describe("static panel", () => {
  it("GET / returns HTML containing the panel header", async () => {
    const { app } = await newApp();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain("Hecate");
    expect(r.body).toContain("verifier panel");
    // Wired up to the right endpoints.
    expect(r.body).toContain("/receipts/verify");
    expect(r.body).toContain("/receipts/tamper-verify");
    expect(r.body).toContain("/attestation");
  });
});

describe("/receipts/verify includes bundle_id", () => {
  it("honest verify response carries a 0x-prefixed 32-byte bundle_id", async () => {
    const { app, bundle } = await buildBundle();
    const r = await app.inject({
      method: "POST",
      url: "/receipts/verify",
      payload: bundle
    });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(true);
    expect(j.bundle_id).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("bundle_id is stable across calls with the same bundle", async () => {
    const { app, bundle } = await buildBundle();
    const r1 = await app.inject({ method: "POST", url: "/receipts/verify", payload: bundle });
    const r2 = await app.inject({ method: "POST", url: "/receipts/verify", payload: bundle });
    expect(r1.json().bundle_id).toBe(r2.json().bundle_id);
  });
});

describe("/receipts/tamper-verify", () => {
  it("wrong-key scenario is rejected with ENGINE_SIGNER_MISMATCH", async () => {
    const { app, bundle } = await buildBundle();
    const r = await app.inject({
      method: "POST",
      url: "/receipts/tamper-verify",
      payload: { bundle, scenario: "wrong-key" }
    });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(false);
    expect(j.scenario.name).toBe("wrong-key");
    expect(j.scenario.description).toContain("re-signed");
    expect(j.scenario.demonstrates).toContain("Authority");
    expect(j.bundle_id).toMatch(/^0x[a-f0-9]{64}$/);
    const codes = (j.failures as Array<{ code: string }>).map((f) => f.code);
    expect(codes).toContain("ENGINE_SIGNER_MISMATCH");
  });

  it("missing-fill-receipt scenario fails with MISSING_FILL_RECEIPT", async () => {
    const { app, bundle } = await buildBundle();
    const r = await app.inject({
      method: "POST",
      url: "/receipts/tamper-verify",
      payload: { bundle, scenario: "missing-fill-receipt" }
    });
    const j = r.json();
    expect(j.ok).toBe(false);
    const codes = (j.failures as Array<{ code: string }>).map((f) => f.code);
    expect(codes).toContain("MISSING_FILL_RECEIPT");
  });

  it("unknown scenario returns 400 UNKNOWN_SCENARIO with available list", async () => {
    const { app, bundle } = await buildBundle();
    const r = await app.inject({
      method: "POST",
      url: "/receipts/tamper-verify",
      payload: { bundle, scenario: "does-not-exist" }
    });
    expect(r.statusCode).toBe(400);
    const j = r.json();
    expect(j.error.code).toBe("UNKNOWN_SCENARIO");
    expect(j.error.detail).toContain("wrong-key");
  });

  it("malformed bundle returns 400 INVALID_REQUEST", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/receipts/tamper-verify",
      payload: { bundle: { not: "a bundle" }, scenario: "wrong-key" }
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INVALID_REQUEST");
  });
});
