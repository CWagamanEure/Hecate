import { describe, it, expect } from "vitest";
import { loadOnchainVaultState } from "../server/vault/onchainLoader";
import type { PublicClient } from "viem";

function mockClient(responses: Record<string, Record<string, bigint>>): PublicClient {
  // responses[functionName][address] = bigint balance.
  // Cast through unknown because we only stub the readContract method.
  return {
    readContract: async (args: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      const addr = (args.args[0] as string).toLowerCase();
      const map = responses[args.functionName];
      if (!map) throw new Error(`unexpected function: ${args.functionName}`);
      const lookup = Object.entries(map).find(
        ([k]) => k.toLowerCase() === addr
      );
      if (!lookup) throw new Error(`unexpected address: ${addr}`);
      return lookup[1];
    },
  } as unknown as PublicClient;
}

const A = "0xc89ce60bd952834FA4F4EAc4D5117883412ECAf9";
const B = "0x40D2eAe10A6283abc4303260e0D166C2fd9Cbf1D";

describe("onchainLoader.loadOnchainVaultState", () => {
  it("converts wei -> ETH decimal and micro -> USDC decimal", async () => {
    const client = mockClient({
      ethBalances: {
        [A]: 1_000_000_000_000_000_000n, // 1 ETH
        [B]: 0n,
      },
      usdcBalances: {
        [A]: 0n,
        [B]: 5_000_000_000n, // 5000 mUSDC
      },
    });
    const state = await loadOnchainVaultState({
      rpcUrl: "http://unused",
      vaultAddress: "0x0000000000000000000000000000000000000123",
      agents: [A, B],
      client,
    });
    expect(state.agents[A]!.balances.ETH).toBe("1");
    expect(state.agents[A]!.balances.USDC).toBe("0");
    expect(state.agents[B]!.balances.ETH).toBe("0");
    expect(state.agents[B]!.balances.USDC).toBe("5000");
  });

  it("normalizes agent addresses (EIP-55 keys in output)", async () => {
    const client = mockClient({
      ethBalances: { [A]: 100_000_000_000_000n }, // 0.0001 ETH
      usdcBalances: { [A]: 0n },
    });
    const lowerCased = A.toLowerCase();
    const state = await loadOnchainVaultState({
      rpcUrl: "http://unused",
      vaultAddress: "0x0000000000000000000000000000000000000123",
      agents: [lowerCased as `0x${string}`],
      client,
    });
    // EIP-55 normalized form must be present as the key.
    expect(Object.keys(state.agents)).toContain(A);
    expect(state.agents[A]!.balances.ETH).toBe("0.0001");
  });

  it("emits zeroed reserved + empty nonces_seen", async () => {
    const client = mockClient({
      ethBalances: { [A]: 0n },
      usdcBalances: { [A]: 0n },
    });
    const state = await loadOnchainVaultState({
      rpcUrl: "http://unused",
      vaultAddress: "0x0000000000000000000000000000000000000123",
      agents: [A],
      client,
    });
    expect(state.agents[A]!.reserved).toEqual({ ETH: "0", USDC: "0" });
    expect(state.agents[A]!.nonces_seen).toEqual([]);
  });

  it("converts large micro-USDC values without precision loss", async () => {
    // Test value: 5_000_000_000 micro = 5000 USDC. Multiplying by 10^12
    // is well within bigint safety; just confirm the round-trip.
    const client = mockClient({
      ethBalances: { [A]: 0n },
      usdcBalances: { [A]: 12_345_678_901_234n }, // 12,345,678.901234 USDC
    });
    const state = await loadOnchainVaultState({
      rpcUrl: "http://unused",
      vaultAddress: "0x0000000000000000000000000000000000000123",
      agents: [A],
      client,
    });
    expect(state.agents[A]!.balances.USDC).toBe("12345678.901234");
  });
});
