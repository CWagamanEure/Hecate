import { z } from "zod";
import { HexAddress } from "./hex";
import { DecimalString } from "./decimal";

export const AssetBalances = z
  .object({
    ETH: DecimalString,
    USDC: DecimalString
  })
  .strict();
export type AssetBalances = z.infer<typeof AssetBalances>;

export const AgentVault = z
  .object({
    agent_id: HexAddress,
    balances: AssetBalances,
    reserved: AssetBalances,
    // Stored sorted lexicographically; vault module (Ticket 7) maintains the order.
    nonces_seen: z.array(z.string())
  })
  .strict();
export type AgentVault = z.infer<typeof AgentVault>;

export const VaultState = z
  .object({
    agents: z.record(HexAddress, AgentVault)
    // Canonical hashing (Ticket 4) sorts agent keys and per-agent nonces_seen
    // before serialization.
  })
  .strict();
export type VaultState = z.infer<typeof VaultState>;
