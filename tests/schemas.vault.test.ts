import { describe, it, expect } from "vitest";
import { AgentVault, VaultState, AssetBalances } from "@shared/schemas";

const addrA = "0x" + "a".repeat(40);
const addrB = "0x" + "b".repeat(40);

const validVault = {
  agent_id: addrA,
  balances: { ETH: "10.0", USDC: "0.0" },
  reserved: { ETH: "0.0", USDC: "0.0" },
  nonces_seen: ["1", "2"]
};

describe("AssetBalances", () => {
  it("parses both keys", () => {
    expect(AssetBalances.parse({ ETH: "1.0", USDC: "2.0" })).toBeDefined();
  });
  it("rejects missing key", () => {
    expect(() => AssetBalances.parse({ ETH: "1.0" })).toThrow();
  });
  it("rejects extra key (strict)", () => {
    expect(() =>
      AssetBalances.parse({ ETH: "1.0", USDC: "2.0", DAI: "0.0" })
    ).toThrow();
  });
  it("rejects malformed decimal", () => {
    expect(() => AssetBalances.parse({ ETH: "-1.0", USDC: "0.0" })).toThrow();
  });
});

describe("AgentVault", () => {
  it("parses a valid vault", () => {
    expect(AgentVault.parse(validVault)).toBeDefined();
  });
  it("rejects missing agent_id", () => {
    const { agent_id: _id, ...rest } = validVault;
    expect(() => AgentVault.parse(rest)).toThrow();
  });
  it("rejects malformed agent_id", () => {
    expect(() =>
      AgentVault.parse({ ...validVault, agent_id: "0xshort" })
    ).toThrow();
  });
});

describe("VaultState", () => {
  it("parses a state with multiple agents", () => {
    const state = {
      agents: {
        [addrA]: validVault,
        [addrB]: { ...validVault, agent_id: addrB }
      }
    };
    expect(VaultState.parse(state)).toBeDefined();
  });
  it("parses an empty state", () => {
    expect(VaultState.parse({ agents: {} })).toBeDefined();
  });
  it("rejects extra top-level fields (strict)", () => {
    expect(() =>
      VaultState.parse({ agents: {}, extra: 1 } as unknown)
    ).toThrow();
  });
});
