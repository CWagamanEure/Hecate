/**
 * Full-flow adversarial tests against the live Fastify app.
 *
 * Includes the explicit URL-binding test (Ticket 17b decision 8): an agent
 * signs a valid GET_FILL_RECEIPT challenge for their own intent, then reuses
 * the same challenge body but changes only the URL intent_id. Must fail
 * INVALID_REQUEST_SIGNATURE because the signed payload includes intent_id.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  PK_B,
  PK_C,
  ADDR_A,
  ADDR_B,
  ADDR_C,
  sellPayload,
  buyPayload,
  makeEnvelope,
  signChallenge
} from "./serverFixture";
import type { ReadyIntent } from "@shared/matching";

afterAll(cleanupTempDirs);

describe("adversarial API — same-agent multi-intent solvency", () => {
  it("two intents from same agent that together exceed balance: first accepted, second INSUFFICIENT_FUNDS", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    const r1 = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_x1",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "7", limit: "3580" })
      })
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_x2",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "7", limit: "3580" })
      })
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("INSUFFICIENT_FUNDS");
  });
});

describe("adversarial API — withdraw cannot reach reserved", () => {
  it("deposit, reserve via intent, then withdraw of reserved asset -> INSUFFICIENT_FUNDS", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_w",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "10", limit: "3580" })
      })
    });
    const w = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "1" }
    });
    expect(w.statusCode).toBe(400);
    expect(w.json().error.code).toBe("INSUFFICIENT_FUNDS");
  });
});

describe("adversarial API — batch close idempotency", () => {
  it("close twice in a row: first closes, second returns closed:false (no ready intents)", async () => {
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
    const r1 = await app.inject({
      method: "POST",
      url: "/batches/close",
      payload: {}
    });
    expect(r1.json().closed).toBe(true);
    const r2 = await app.inject({
      method: "POST",
      url: "/batches/close",
      payload: {}
    });
    expect(r2.json().closed).toBe(false);
  });
});

describe("adversarial API — URL intent_id binding (Ticket 17b decision 8)", () => {
  it("challenge signed for intent_a1 cannot be reused on URL /intents/intent_a2/fill-receipt by same agent", async () => {
    const { app } = await newApp();
    // Same agent submits two intents.
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "20" }
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_B, asset: "USDC", amount: "100000" }
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_a1",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "5", limit: "3580" })
      })
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_a2",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "5", limit: "3580" })
      })
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_b1",
        agent_id: ADDR_B,
        pk: PK_B,
        payload: buyPayload({ base: "10", limit: "3600" })
      })
    });
    await app.inject({ method: "POST", url: "/batches/close", payload: {} });

    // Sign challenge for intent_a1.
    const c = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_A
    });
    // Reuse the same body on the URL for intent_a2 (also owned by A).
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a2/fill-receipt",
      payload: c
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_REQUEST_SIGNATURE");
  });
});

describe("adversarial API — malformed bodies return structured 400", () => {
  it("POST /intents with malformed body -> 400 INVALID_REQUEST, no stack trace", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/intents",
      payload: { junk: "not an envelope" }
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(JSON.stringify(body)).not.toMatch(/at .* \(.+\.ts:\d+/);
  });

  it("POST /vault/mock-deposit with negative amount -> 400", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "-1" }
    });
    expect(r.statusCode).toBe(400);
  });

  it("POST /vault/mock-deposit with bad asset -> 400", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "DAI", amount: "1" }
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("adversarial API — ready-pool restart limitation (v1 documented limit)", () => {
  it("after simulated restart, ready pool is empty but reservations remain in vault.json/reservations.json", async () => {
    const { app, dataDir, state } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_restart",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "5", limit: "3580" })
      })
    });
    expect(r.statusCode).toBe(200);
    expect(state.readyPool.size).toBe(1);
    expect(state.vault.agents[ADDR_A]!.reserved.ETH).toBe("5");

    // Simulate restart: bootstrap fresh state from the same data dir.
    const { bootstrap } = await import("../server/runtime");
    const reBooted = await bootstrap({
      DATA_DIR: dataDir,
      RUNTIME_MODE: "LOCAL_MOCK",
      ENGINE_PRIVATE_KEY: "0x" + "0".repeat(63) + "1",
      CODE_DIGEST: "sha256:test"
    } as unknown as NodeJS.ProcessEnv);

    // Reservation persisted to disk.
    expect(reBooted.vault.agents[ADDR_A]!.reserved.ETH).toBe("5");
    expect(reBooted.reservationBook.reservations).toHaveLength(1);

    // Ready pool is in-memory only — empty after restart.
    expect(reBooted.readyPool.size).toBe(0);

    // This is the v1 documented limitation — do not solve in this ticket.
    // Future hardening: ready.jsonl persistence per Ticket 9 brief.
  });
});
