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

async function setupClosedBatch() {
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
  await app.inject({ method: "POST", url: "/batches/close", payload: {} });
  return { app, state };
}

describe("POST /intents/:id/fill-receipt — owner-gated", () => {
  it("valid signed challenge by receipt owner -> 200, returns receipt", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/fill-receipt",
      payload: challenge
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().fill_receipt.intent_id).toBe("intent_a");
    expect(r.json().fill_receipt.agent_id).toBe(ADDR_A);
  });

  it("signed by non-owner -> 403 NOT_RECEIPT_OWNER", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a", // owned by A
      pk: PK_B
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/fill-receipt",
      payload: challenge
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("NOT_RECEIPT_OWNER");
  });

  it("stale timestamp (> 60s old) -> 401 STALE_REQUEST", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a",
      pk: PK_A,
      timestamp_ms: Date.now() - 120_000
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/fill-receipt",
      payload: challenge
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("STALE_REQUEST");
  });

  it("bad signature -> 401 INVALID_REQUEST_SIGNATURE", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_a",
      pk: PK_A
    });
    // Flip a hex char.
    const sig = challenge.signature;
    const tamperedSig = (sig.slice(0, 4) +
      (sig[4] === "0" ? "1" : "0") +
      sig.slice(5)) as `0x${string}`;
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/fill-receipt",
      payload: { ...challenge, signature: tamperedSig }
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_REQUEST_SIGNATURE");
  });

  it("missing fill receipt -> 404", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_FILL_RECEIPT",
      intent_id: "intent_nope",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_nope/fill-receipt",
      payload: challenge
    });
    expect(r.statusCode).toBe(404);
  });

  it("challenge with action GET_INTENT_STATUS rejected for fill-receipt endpoint", async () => {
    // The action field is inside the signed payload; using the wrong action
    // results in a different signed hash, so the recovered signer won't match
    // the requester.
    const { app } = await setupClosedBatch();
    const wrongAction = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_a",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/fill-receipt",
      payload: wrongAction
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_REQUEST_SIGNATURE");
  });
});

describe("POST /intents/:id/status — owner-gated", () => {
  it("valid challenge by owner returns status", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_a",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/status",
      payload: challenge
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("FILLED");
  });

  it("signed by non-owner -> 403 NOT_INTENT_OWNER", async () => {
    const { app } = await setupClosedBatch();
    const challenge = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_a",
      pk: PK_B
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_a/status",
      payload: challenge
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("NOT_INTENT_OWNER");
  });

  it("status of a not-yet-closed intent in ready pool returns OPEN", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" }
    });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: makeEnvelope({
        intent_id: "intent_open",
        agent_id: ADDR_A,
        pk: PK_A,
        payload: sellPayload({ base: "5", limit: "3580" })
      })
    });
    const challenge = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_open",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_open/status",
      payload: challenge
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("OPEN");
  });

  it("status of unknown intent -> 404", async () => {
    const { app } = await newApp();
    const challenge = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_nope",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_nope/status",
      payload: challenge
    });
    expect(r.statusCode).toBe(404);
  });
});
