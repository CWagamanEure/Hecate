import type {
  VaultState,
  AgentVault,
  AssetBalances,
  HexAddress,
  Asset,
  DecimalString
} from "@shared/schemas";
import {
  addDecimal,
  subDecimal,
  cmpDecimal,
  isZero,
  normalizeDecimal
} from "@shared/math/decimal";
import { normalizeAddress } from "@shared/crypto";

const ZERO_BALANCES: AssetBalances = { ETH: "0", USDC: "0" };

export function getAgentVault(
  state: VaultState,
  agent_id: HexAddress
): AgentVault | undefined {
  const norm = normalizeAddress(agent_id);
  return state.agents[norm];
}

/** balances[asset] - reserved[asset]. Throws if subtraction would be negative,
 *  which is an invariant violation rather than a normal flow. */
export function availableBalance(av: AgentVault, asset: Asset): DecimalString {
  return subDecimal(av.balances[asset], av.reserved[asset]);
}

/** Auto-creates the AgentVault entry on first deposit. Throws on amount = 0. */
export function mockDeposit(
  state: VaultState,
  agent_id: HexAddress,
  asset: Asset,
  amount: DecimalString
): VaultState {
  if (isZero(amount)) throw new Error("mockDeposit: amount must be > 0");
  const norm = normalizeAddress(agent_id);
  const existing = state.agents[norm];
  const newAv: AgentVault = existing
    ? {
        ...existing,
        balances: {
          ...existing.balances,
          [asset]: normalizeDecimal(addDecimal(existing.balances[asset], amount))
        }
      }
    : {
        agent_id: norm,
        balances: {
          ...ZERO_BALANCES,
          [asset]: normalizeDecimal(amount)
        },
        reserved: { ...ZERO_BALANCES },
        nonces_seen: []
      };
  return { ...state, agents: { ...state.agents, [norm]: newAv } };
}

/** Withdraws available funds. Cannot touch reserved. Returns Result-style. */
export function mockWithdraw(
  state: VaultState,
  agent_id: HexAddress,
  asset: Asset,
  amount: DecimalString
):
  | { ok: true; state: VaultState }
  | { ok: false; code: "UNKNOWN_AGENT" | "INSUFFICIENT_FUNDS"; detail: string } {
  if (isZero(amount)) throw new Error("mockWithdraw: amount must be > 0");
  const norm = normalizeAddress(agent_id);
  const existing = state.agents[norm];
  if (!existing) {
    return { ok: false, code: "UNKNOWN_AGENT", detail: norm };
  }
  const available = availableBalance(existing, asset);
  if (cmpDecimal(amount, available) > 0) {
    return {
      ok: false,
      code: "INSUFFICIENT_FUNDS",
      detail: `withdraw ${amount} ${asset}, available ${available}`
    };
  }
  const newAv: AgentVault = {
    ...existing,
    balances: {
      ...existing.balances,
      [asset]: normalizeDecimal(subDecimal(existing.balances[asset], amount))
    }
  };
  return {
    ok: true,
    state: { ...state, agents: { ...state.agents, [norm]: newAv } }
  };
}
