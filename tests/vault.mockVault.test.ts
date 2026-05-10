import { describe, it, expect } from "vitest";
import {
  getAgentVault,
  availableBalance,
  mockDeposit,
  mockWithdraw
} from "@shared/vault";
import type { VaultState } from "@shared/schemas";

const addrA = "0x" + "a".repeat(40); // lowercase; gets normalized to EIP-55
const empty: VaultState = { agents: {} };

describe("mockDeposit", () => {
  it("auto-creates an AgentVault on first deposit", () => {
    const next = mockDeposit(empty, addrA, "ETH", "10");
    const av = getAgentVault(next, addrA);
    expect(av).toBeDefined();
    expect(av!.balances.ETH).toBe("10");
    expect(av!.balances.USDC).toBe("0");
    expect(av!.reserved.ETH).toBe("0");
    expect(av!.reserved.USDC).toBe("0");
    expect(av!.nonces_seen).toEqual([]);
  });

  it("normalizes the agent address (lowercase input -> EIP-55 stored)", () => {
    const next = mockDeposit(empty, addrA, "ETH", "10");
    const keys = Object.keys(next.agents);
    expect(keys[0]).not.toBe(addrA); // lowercase input was converted
    expect(keys[0]!.toLowerCase()).toBe(addrA);
  });

  it("subsequent deposit increments balance", () => {
    const a = mockDeposit(empty, addrA, "ETH", "10");
    const b = mockDeposit(a, addrA, "ETH", "5");
    expect(getAgentVault(b, addrA)!.balances.ETH).toBe("15");
  });

  it("rejects amount = 0", () => {
    expect(() => mockDeposit(empty, addrA, "ETH", "0")).toThrow();
  });
});

describe("availableBalance", () => {
  it("balance - reserved", () => {
    const next = mockDeposit(empty, addrA, "ETH", "10");
    expect(availableBalance(getAgentVault(next, addrA)!, "ETH")).toBe("10");
  });
});

describe("mockWithdraw", () => {
  it("returns UNKNOWN_AGENT on missing agent", () => {
    const r = mockWithdraw(empty, addrA, "ETH", "1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_AGENT");
  });

  it("withdraws available", () => {
    const a = mockDeposit(empty, addrA, "ETH", "10");
    const r = mockWithdraw(a, addrA, "ETH", "3");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(getAgentVault(r.state, addrA)!.balances.ETH).toBe("7");
    }
  });

  it("withdraws exact available", () => {
    const a = mockDeposit(empty, addrA, "ETH", "10");
    const r = mockWithdraw(a, addrA, "ETH", "10");
    expect(r.ok).toBe(true);
    if (r.ok) expect(getAgentVault(r.state, addrA)!.balances.ETH).toBe("0");
  });

  it("returns INSUFFICIENT_FUNDS when above available", () => {
    const a = mockDeposit(empty, addrA, "ETH", "10");
    const r = mockWithdraw(a, addrA, "ETH", "11");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("rejects amount = 0", () => {
    const a = mockDeposit(empty, addrA, "ETH", "10");
    expect(() => mockWithdraw(a, addrA, "ETH", "0")).toThrow();
  });
});
