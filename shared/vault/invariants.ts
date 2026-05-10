import type { VaultState, ReservationBook, Asset } from "@shared/schemas";
import { addDecimal, cmpDecimal } from "@shared/math/decimal";
import { normalizeAddress } from "@shared/crypto";

const ASSETS: readonly Asset[] = ["ETH", "USDC"] as const;

/**
 * Check vault and reservation-book invariants. Throws on the first violation
 * with a descriptive message.
 *
 * Invariants:
 *   1. Every map key in state.agents matches its AgentVault.agent_id.
 *   2. Every agent_id is in EIP-55 checksum form.
 *   3. For every (agent, asset): reserved[asset] <= balances[asset].
 *   4. nonces_seen is sorted lexicographically and contains no duplicates.
 *   5. ReservationBook intent_ids are unique.
 *   6. Sum of active (RESERVED) reservations per (agent, asset) equals
 *      AgentVault.reserved[asset].
 *   7. Every reservation references an existing agent vault.
 */
export function assertVaultInvariants(
  state: VaultState,
  book: ReservationBook
): void {
  // 1, 2, 3, 4
  for (const [key, av] of Object.entries(state.agents)) {
    if (av.agent_id !== key) {
      throw new Error(
        `vault invariant: map key ${key} != agent_id ${av.agent_id}`
      );
    }
    if (normalizeAddress(av.agent_id) !== av.agent_id) {
      throw new Error(
        `vault invariant: agent_id ${av.agent_id} is not EIP-55 normalized`
      );
    }
    for (const asset of ASSETS) {
      if (cmpDecimal(av.reserved[asset], av.balances[asset]) > 0) {
        throw new Error(
          `vault invariant: ${av.agent_id} ${asset} reserved (${av.reserved[asset]}) > balance (${av.balances[asset]})`
        );
      }
    }
    for (let i = 1; i < av.nonces_seen.length; i++) {
      const prev = av.nonces_seen[i - 1]!;
      const cur = av.nonces_seen[i]!;
      if (prev >= cur) {
        throw new Error(
          `vault invariant: nonces_seen not strictly sorted for ${av.agent_id} (${prev} >= ${cur})`
        );
      }
    }
  }

  // 5
  const seenIntent = new Set<string>();
  for (const r of book.reservations) {
    if (seenIntent.has(r.intent_id)) {
      throw new Error(
        `reservation invariant: duplicate intent_id ${r.intent_id}`
      );
    }
    seenIntent.add(r.intent_id);
  }

  // 6, 7
  type Acc = Record<string, Record<Asset, string>>;
  const acc: Acc = {};
  for (const r of book.reservations) {
    if (r.status !== "RESERVED") continue;
    if (!acc[r.agent_id]) acc[r.agent_id] = { ETH: "0", USDC: "0" };
    acc[r.agent_id]![r.asset] = addDecimal(
      acc[r.agent_id]![r.asset],
      r.amount
    );
  }

  for (const agentId of Object.keys(acc)) {
    if (!state.agents[agentId]) {
      throw new Error(
        `reservation invariant: reservation exists for unknown agent ${agentId}`
      );
    }
  }

  for (const [agentId, av] of Object.entries(state.agents)) {
    const expected = acc[agentId] ?? { ETH: "0", USDC: "0" };
    for (const asset of ASSETS) {
      if (cmpDecimal(expected[asset], av.reserved[asset]) !== 0) {
        throw new Error(
          `reservation invariant: ${agentId} ${asset} reserved=${av.reserved[asset]} but sum of active reservations=${expected[asset]}`
        );
      }
    }
  }
}
