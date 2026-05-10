import { describe, it, expect, afterAll } from "vitest";
import { newApp, cleanupTempDirs, ADDR_A } from "./serverFixture";

afterAll(cleanupTempDirs);

describe("server basics", () => {
  it("GET /healthz returns runtime_mode", async () => {
    const { app } = await newApp();
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, runtime_mode: "LOCAL_MOCK" });
  });

  it("GET /attestation returns runtime + engine_address + warning", async () => {
    const { app, state } = await newApp();
    const r = await app.inject({ method: "GET", url: "/attestation" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.runtime.runtime_mode).toBe("LOCAL_MOCK");
    expect(body.engine_address).toBe(state.engineAddress);
    expect(body.matching_rule).toBe("UNIFORM_CLEARING_PRICE_V1");
    expect(body.markets).toEqual(["ETH/USDC"]);
    expect(body.warning).toContain("LOCAL_MOCK");
    // v1 signer honesty: hard-coded LOCAL_DEV_KEY, no real app-wallet signing.
    expect(body.signer.mode).toBe("LOCAL_DEV_KEY");
    expect(body.signer.note).toContain("ENGINE_PRIVATE_KEY");
  });

  it("GET /markets returns ETH/USDC", async () => {
    const { app } = await newApp();
    const r = await app.inject({ method: "GET", url: "/markets" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([{ symbol: "ETH/USDC", status: "OPEN" }]);
  });
});

describe("vault routes", () => {
  it("GET /vault/<unknown> returns zero vault", async () => {
    const { app } = await newApp();
    const r = await app.inject({ method: "GET", url: `/vault/${ADDR_A}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.vault.balances.ETH).toBe("0");
    expect(body.vault.balances.USDC).toBe("0");
  });

  it("POST /vault/mock-deposit valid -> 200, vault updated", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().vault.balances.ETH).toBe("10");
  });

  it("POST /vault/mock-deposit amount=0 -> 400", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "0" }
    });
    expect(r.statusCode).toBe(400);
  });

  it("POST /vault/mock-withdraw of more than available -> INSUFFICIENT_FUNDS", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" }
    });
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("POST /vault/mock-withdraw for unknown agent -> UNKNOWN_AGENT", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "1" }
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("UNKNOWN_AGENT");
  });
});
