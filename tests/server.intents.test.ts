import { describe, it, expect, afterAll } from "vitest";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  ADDR_A,
  PK_B,
  ADDR_B,
  sellPayload,
  makeEnvelope
} from "./serverFixture";

afterAll(cleanupTempDirs);

describe("POST /intents", () => {
  it("valid funded intent -> OPEN, ready pool grows", async () => {
    const { app, state } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    const p = sellPayload({ base: "10", limit: "3580" });
    const env = makeEnvelope({
      intent_id: "intent_001",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: p
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents",
      payload: env
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      ok: true,
      intent_id: "intent_001",
      status: "OPEN"
    });
    expect(state.readyPool.size).toBe(1);
    expect(state.vault.agents[ADDR_A]!.reserved.ETH).toBe("10");
  });

  it("bad signature (signed by wrong key) -> 400 INVALID_SIGNATURE", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    const p = sellPayload({ base: "10", limit: "3580" });
    // Sign with PK_B but claim ADDR_A
    const env = makeEnvelope({
      intent_id: "intent_001",
      agent_id: ADDR_A,
      pk: PK_B,
      payload: p
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents",
      payload: env
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INVALID_SIGNATURE");
  });

  it("insufficient funds -> 400 INSUFFICIENT_FUNDS", async () => {
    const { app } = await newApp();
    // No deposit.
    const p = sellPayload({ base: "10", limit: "3580" });
    const env = makeEnvelope({
      intent_id: "intent_001",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: p
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents",
      payload: env
    });
    expect(r.statusCode).toBe(400);
    // Could be UNKNOWN_AGENT (no vault entry) or INSUFFICIENT_FUNDS (vault entry but empty)
    expect(["UNKNOWN_AGENT", "INSUFFICIENT_FUNDS"]).toContain(
      r.json().error.code
    );
  });

  it("duplicate nonce -> 400 DUPLICATE_NONCE", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "20" }
    });
    const p1 = sellPayload({ base: "5", limit: "3580" });
    const env1 = makeEnvelope({
      intent_id: "intent_001",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: p1
    });
    await app.inject({ method: "POST", url: "/intents", payload: env1 });
    // Same nonce, different intent_id.
    const p2 = sellPayload({ base: "5", limit: "3580" });
    p2.nonce = p1.nonce;
    const env2 = makeEnvelope({
      intent_id: "intent_002",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: p2
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents",
      payload: env2
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("DUPLICATE_NONCE");
  });
});
