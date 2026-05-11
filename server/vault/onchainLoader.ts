/**
 * onchainLoader — V6b of the on-chain vault project.
 *
 * Reads HecateVault.ethBalances and HecateVault.usdcBalances for a set
 * of agent addresses and returns a VaultState that mirrors what the
 * engine would have produced if those agents had deposited via the mock
 * vault.
 *
 * Unit conversion (the only subtle part):
 *   - On chain, ETH balances are wei (18-decimal scale). The engine
 *     stores decimal strings whose toScaled form is also 18-decimal-scaled,
 *     so we can pass wei straight through fromScaled().
 *   - On chain, USDC balances are micro-USDC (6-decimal scale). The
 *     engine stores 18-decimal scaled decimals, so we multiply by 10^12
 *     before passing through fromScaled().
 *
 * V6c will handle the write side: submitting settleBatch on chain after
 * the engine produces a settlement. Until then, in-memory state.vault
 * drifts from on-chain after each batch close; the engine is the source
 * of truth for "what the deltas would be if applied".
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import type { VaultState, AgentVault, HexAddress } from "@shared/schemas";
import { fromScaled } from "@shared/math/decimal";
import { normalizeAddress } from "@shared/crypto";

const VAULT_ABI = parseAbi([
  "function ethBalances(address) view returns (uint256)",
  "function usdcBalances(address) view returns (uint256)",
]);

const ZERO_BALANCES = { ETH: "0", USDC: "0" } as const;

function microToUsdcDecimal(micro: bigint): string {
  // fromScaled treats input as 18-decimal-scaled bigint. micro is
  // 6-decimal-scaled; lift to 18 by multiplying by 10^12.
  return fromScaled(micro * 1_000_000_000_000n);
}

function weiToEthDecimal(wei: bigint): string {
  return fromScaled(wei);
}

export type OnchainLoaderConfig = {
  rpcUrl: string;
  vaultAddress: Address;
  /** Addresses to fetch balances for. Caller is responsible for the list. */
  agents: ReadonlyArray<HexAddress>;
  /** Optional client override (lets tests inject an anvil client). */
  client?: PublicClient;
};

/**
 * Fetch on-chain vault balances for the given agents and return a
 * VaultState in the same shape the engine expects in memory. Agent
 * entries that have zero balances on chain are still emitted with
 * ZERO_BALANCES so the agent is registered (consistent with what the
 * mock vault would do on first deposit).
 *
 * Reserved + nonces_seen are engine-side concepts and are initialized
 * to empty. The engine will populate reservations as intents arrive.
 */
export async function loadOnchainVaultState(
  cfg: OnchainLoaderConfig
): Promise<VaultState> {
  const client =
    cfg.client ??
    createPublicClient({ chain: sepolia, transport: http(cfg.rpcUrl) });

  const agentsOut: Record<string, AgentVault> = {};
  for (const raw of cfg.agents) {
    const norm = normalizeAddress(raw) as HexAddress;
    const [ethWei, usdcMicro] = await Promise.all([
      client.readContract({
        address: cfg.vaultAddress,
        abi: VAULT_ABI,
        functionName: "ethBalances",
        args: [norm as Address],
      }),
      client.readContract({
        address: cfg.vaultAddress,
        abi: VAULT_ABI,
        functionName: "usdcBalances",
        args: [norm as Address],
      }),
    ]);
    agentsOut[norm] = {
      agent_id: norm,
      balances: {
        ETH: weiToEthDecimal(ethWei),
        USDC: microToUsdcDecimal(usdcMicro),
      },
      reserved: { ...ZERO_BALANCES },
      nonces_seen: [],
    };
  }
  return { agents: agentsOut };
}
