import { describe, it, expect } from "vitest";
import { assertVaultInvariants, mockDeposit } from "@shared/vault";
import { hashVaultState, normalizeAddress } from "@shared/crypto";
import type {
  VaultState,
  ReservationBook,
  AgentVault
} from "@shared/schemas";

const addrLowerA = "0x" + "a".repeat(40);
const ADDR = normalizeAddress(addrLowerA);
const addrLowerB = "0x" + "b".repeat(40);
const ADDR_B = normalizeAddress(addrLowerB);

const emptyBook: ReservationBook = { reservations: [] };

function vaultOf(av: AgentVault): VaultState {
  return { agents: { [av.agent_id]: av } };
}

describe("assertVaultInvariants", () => {
  it("passes for an empty state", () => {
    expect(() =>
      assertVaultInvariants({ agents: {} }, emptyBook)
    ).not.toThrow();
  });

  it("passes for a deposited state", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    expect(() => assertVaultInvariants(s, emptyBook)).not.toThrow();
  });

  it("throws when reserved > balances", () => {
    const av: AgentVault = {
      agent_id: ADDR,
      balances: { ETH: "5", USDC: "0" },
      reserved: { ETH: "10", USDC: "0" },
      nonces_seen: []
    };
    expect(() => assertVaultInvariants(vaultOf(av), emptyBook)).toThrow(
      /reserved/
    );
  });

  it("throws when nonces_seen is not sorted", () => {
    const av: AgentVault = {
      agent_id: ADDR,
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "0", USDC: "0" },
      nonces_seen: ["2", "1"]
    };
    expect(() => assertVaultInvariants(vaultOf(av), emptyBook)).toThrow(
      /sorted/
    );
  });

  it("throws when nonces_seen contains duplicates", () => {
    const av: AgentVault = {
      agent_id: ADDR,
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "0", USDC: "0" },
      nonces_seen: ["1", "1", "2"]
    };
    expect(() => assertVaultInvariants(vaultOf(av), emptyBook)).toThrow();
  });

  it("throws when ReservationBook has duplicate intent_ids", () => {
    const book: ReservationBook = {
      reservations: [
        {
          intent_id: "intent_001",
          agent_id: ADDR,
          asset: "ETH",
          amount: "1",
          status: "RESERVED",
          created_ms: 1
        },
        {
          intent_id: "intent_001",
          agent_id: ADDR,
          asset: "ETH",
          amount: "1",
          status: "RESERVED",
          created_ms: 2
        }
      ]
    };
    const av: AgentVault = {
      agent_id: ADDR,
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "2", USDC: "0" },
      nonces_seen: []
    };
    expect(() => assertVaultInvariants(vaultOf(av), book)).toThrow(/duplicate/);
  });

  it("throws when sum of active reservations doesn't match reserved", () => {
    const av: AgentVault = {
      agent_id: ADDR,
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "5", USDC: "0" }, // claims 5 reserved but no reservations exist
      nonces_seen: []
    };
    expect(() => assertVaultInvariants(vaultOf(av), emptyBook)).toThrow(
      /sum of active reservations/
    );
  });

  it("ignores RELEASED/SETTLED reservations in the sum", () => {
    const book: ReservationBook = {
      reservations: [
        {
          intent_id: "intent_001",
          agent_id: ADDR,
          asset: "ETH",
          amount: "10",
          status: "SETTLED",
          created_ms: 1
        }
      ]
    };
    const av: AgentVault = {
      agent_id: ADDR,
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "0", USDC: "0" },
      nonces_seen: []
    };
    expect(() => assertVaultInvariants(vaultOf(av), book)).not.toThrow();
  });

  it("throws on reservation for unknown agent", () => {
    const book: ReservationBook = {
      reservations: [
        {
          intent_id: "intent_001",
          agent_id: ADDR_B,
          asset: "ETH",
          amount: "1",
          status: "RESERVED",
          created_ms: 1
        }
      ]
    };
    expect(() => assertVaultInvariants({ agents: {} }, book)).toThrow(
      /unknown agent/
    );
  });

  it("throws when map key does not match agent_id field", () => {
    const av: AgentVault = {
      agent_id: ADDR_B, // mismatch
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "0", USDC: "0" },
      nonces_seen: []
    };
    const state: VaultState = { agents: { [ADDR]: av } };
    expect(() => assertVaultInvariants(state, emptyBook)).toThrow(/map key/);
  });

  it("throws when agent_id is not EIP-55 normalized", () => {
    const lowerKey = addrLowerA;
    const av: AgentVault = {
      agent_id: lowerKey,
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "0", USDC: "0" },
      nonces_seen: []
    };
    const state: VaultState = { agents: { [lowerKey]: av } };
    expect(() => assertVaultInvariants(state, emptyBook)).toThrow(
      /EIP-55/
    );
  });
});

describe("hashVaultState determinism", () => {
  it("is independent of agent map insertion order", () => {
    const a = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const ab = mockDeposit(a, ADDR_B, "USDC", "1000");
    const b = mockDeposit({ agents: {} }, ADDR_B, "USDC", "1000");
    const ba = mockDeposit(b, ADDR, "ETH", "10");
    expect(hashVaultState(ab)).toBe(hashVaultState(ba));
  });

  it("differs when balance changes by 1 wei", () => {
    const a = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const b = mockDeposit({ agents: {} }, ADDR, "ETH", "10.000000000000000001");
    expect(hashVaultState(a)).not.toBe(hashVaultState(b));
  });
});
