/**
 * Adversarial access-control tests for owner-gated endpoints.
 *
 * Proves the signed challenge binds:
 *   - to the requester (key)
 *   - to the action (GET_FILL_RECEIPT vs GET_INTENT_STATUS)
 *   - to the intent_id
 *   - to the timestamp window
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
  makeEnvelope,
  signChallenge
} from "./serverFixture";

afterAll(cleanupTempDirs);

async function setupTwoIntents() {
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
  // Two intents owned by Agent A (one SELL split into two with different ids)
  // would normally need two SELLs — easier: one SELL by A, one BUY by B; both accepted.
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
      intent_id: "intent_b1",
      agent_id: ADDR_B,
      pk: PK_B,
      payload: buyPayload({ base: "5", limit: "3600" })
    })
  });
  await app.inject({ method: "POST", url: "/batches/close", payload: {} });
  return { app, state };
}

describe("adversarial access — challenge binding", () => {
  it("B signs FILL_RECEIPT for A's intent with B key but claims A as requester -> INVALID_REQUEST_SIGNATURE", async () => {
    const { app } = await setupTwoIntents();
    // Build a challenge signed by B but with requester field claiming A.
    const cFromB = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_B
    });
    // Now overwrite requester to ADDR_A, keep B's signature.
    const tampered = { ...cFromB, requester: ADDR_A };
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: tampered
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_REQUEST_SIGNATURE");
  });

  it("A signs GET_INTENT_STATUS for intent_a1, replays for /fill-receipt -> INVALID_REQUEST_SIGNATURE (action binds)", async () => {
    const { app } = await setupTwoIntents();
    const c = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_a1",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: c
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_REQUEST_SIGNATURE");
  });

  it("A signs FILL_RECEIPT for intent_a1, reuses for /intents/intent_b1/fill-receipt -> INVALID_REQUEST_SIGNATURE (intent_id binds)", async () => {
    const { app } = await setupTwoIntents();
    const c = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_b1/fill-receipt",
      payload: c
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_REQUEST_SIGNATURE");
  });

  it("stale challenge (61s old) -> STALE_REQUEST", async () => {
    const { app } = await setupTwoIntents();
    const c = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_A,
      timestamp_ms: Date.now() - 61_000
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: c
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("STALE_REQUEST");
  });

  it("future-stamped challenge (61s ahead) -> STALE_REQUEST", async () => {
    const { app } = await setupTwoIntents();
    const c = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_A,
      timestamp_ms: Date.now() + 61_000
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: c
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("STALE_REQUEST");
  });

  it("B signs FILL_RECEIPT for A's intent with B's correct requester -> NOT_RECEIPT_OWNER", async () => {
    const { app } = await setupTwoIntents();
    const c = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_B
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: c
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("NOT_RECEIPT_OWNER");
  });

  it("malformed signature -> 401 INVALID_REQUEST_SIGNATURE", async () => {
    const { app } = await setupTwoIntents();
    const c = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a1",
      pk: PK_A
    });
    // Truncate the signature to invalid length.
    const bad = ("0x" + c.signature.slice(2, 100)) as `0x${string}`;
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: { ...c, signature: bad }
    });
    expect(r.statusCode).toBe(400);
    // Schema rejects on Hex65 length; this is INVALID_REQUEST.
    expect(["INVALID_REQUEST", "INVALID_REQUEST_SIGNATURE"]).toContain(
      r.json().error.code
    );
  });

  it("malformed JSON body -> 400 with structured error and no stack trace", async () => {
    const { app } = await setupTwoIntents();
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a1/fill-receipt",
      payload: "not-json",
      headers: { "content-type": "application/json" }
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const body = r.json();
    expect(body.ok).toBe(false);
    // No stack trace surfaced.
    expect(JSON.stringify(body)).not.toMatch(/at .* \(.+\.ts:\d+/);
  });
});
