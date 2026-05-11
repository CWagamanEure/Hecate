import { describe, it, expect } from "vitest";
import { parseVaultBackend } from "../server/runtime";
import { newApp, cleanupTempDirs } from "./serverFixture";
import { afterAll } from "vitest";

afterAll(cleanupTempDirs);

describe("parseVaultBackend", () => {
  it("defaults to 'mock' when env unset", () => {
    expect(parseVaultBackend(undefined)).toBe("mock");
    expect(parseVaultBackend("")).toBe("mock");
  });

  it("accepts 'mock' and 'onchain' verbatim", () => {
    expect(parseVaultBackend("mock")).toBe("mock");
    expect(parseVaultBackend("onchain")).toBe("onchain");
  });

  it("throws on unknown values", () => {
    expect(() => parseVaultBackend("local")).toThrow(/VAULT_BACKEND/);
    expect(() => parseVaultBackend("MOCK")).toThrow(/VAULT_BACKEND/);
  });
});

describe("mock-deposit / mock-withdraw guard in onchain mode", () => {
  it("mock-deposit returns 400 with MOCK_DEPOSIT_DISABLED when vaultBackend=onchain", async () => {
    const { app, state } = await newApp();
    // Flip the backend on the in-memory state. newApp() bootstraps in
    // mock mode (no VAULT_BACKEND env in the fixture); we don't want
    // the test to require a Sepolia RPC, so we mutate state directly.
    state.vaultBackend = "onchain";
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: {
        agent_id: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
        asset: "ETH",
        amount: "1"
      }
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MOCK_DEPOSIT_DISABLED");
    expect(body.error.detail).toMatch(/agents-deposit\.ts|depositETH|depositUSDC/);
  });

  it("mock-withdraw returns 400 with MOCK_WITHDRAW_DISABLED when vaultBackend=onchain", async () => {
    const { app, state } = await newApp();
    state.vaultBackend = "onchain";
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: {
        agent_id: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
        asset: "ETH",
        amount: "1"
      }
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("MOCK_WITHDRAW_DISABLED");
  });

  it("mock-deposit still works in mock mode (no regression)", async () => {
    const { app, state } = await newApp();
    expect(state.vaultBackend).toBe("mock");
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: {
        agent_id: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
        asset: "ETH",
        amount: "1"
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });
});
