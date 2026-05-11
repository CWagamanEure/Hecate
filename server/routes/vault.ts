/**
 * Vault routes.
 *
 * GET /vault/:agent_id is dev-only in v1 LOCAL_MOCK. Production deployment
 * must require authenticated/owner-gated access; the labels in /attestation
 * already warn that LOCAL_MOCK has no real confidentiality.
 */

import type { FastifyInstance } from "fastify";
import {
  mockDeposit,
  mockWithdraw,
  getAgentVault
} from "@shared/vault";
import { normalizeAddress } from "@shared/crypto";
import {
  writeJsonAtomic,
  resolveDataPath,
  FILES
} from "@shared/persistence";
import {
  MockDepositRequest,
  MockWithdrawRequest,
  VaultState
} from "@shared/schemas";
import type { ServerState, Mutex } from "../state";

export async function vaultRoutes(
  app: FastifyInstance,
  opts: { state: ServerState; mutex: Mutex }
): Promise<void> {
  const { state, mutex } = opts;

  app.get<{ Params: { agent_id: string } }>(
    "/vault/:agent_id",
    async (req) => {
      const norm = normalizeAddress(req.params.agent_id);
      const av = getAgentVault(state.vault, norm);
      if (av) return { ok: true, vault: av };
      return {
        ok: true,
        vault: {
          agent_id: norm,
          balances: { ETH: "0", USDC: "0" },
          reserved: { ETH: "0", USDC: "0" },
          nonces_seen: []
        }
      };
    }
  );

  app.post("/vault/mock-deposit", async (req, reply) => {
    if (state.vaultBackend === "onchain") {
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "MOCK_DEPOSIT_DISABLED",
          detail:
            "VAULT_BACKEND=onchain: use scripts/agents-deposit.ts (or call HecateVault.depositETH / depositUSDC directly) instead of mock-deposit."
        }
      };
    }
    const parse = MockDepositRequest.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: "INVALID_REQUEST", detail: parse.error.message }
      };
    }
    const { agent_id, asset, amount } = parse.data;
    return mutex.run(async () => {
      try {
        state.vault = mockDeposit(state.vault, agent_id, asset, amount);
      } catch (e) {
        reply.code(400);
        return {
          ok: false,
          error: { code: "INVALID_AMOUNT", detail: (e as Error).message }
        };
      }
      await writeJsonAtomic(
        resolveDataPath(state.dataDir, FILES.vault),
        state.vault,
        VaultState
      );
      const norm = normalizeAddress(agent_id);
      return { ok: true, vault: state.vault.agents[norm] };
    });
  });

  app.post("/vault/mock-withdraw", async (req, reply) => {
    if (state.vaultBackend === "onchain") {
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "MOCK_WITHDRAW_DISABLED",
          detail:
            "VAULT_BACKEND=onchain: call HecateVault.withdrawETH / withdrawUSDC on-chain directly instead."
        }
      };
    }
    const parse = MockWithdrawRequest.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: "INVALID_REQUEST", detail: parse.error.message }
      };
    }
    const { agent_id, asset, amount } = parse.data;
    return mutex.run(async () => {
      let result: ReturnType<typeof mockWithdraw>;
      try {
        result = mockWithdraw(state.vault, agent_id, asset, amount);
      } catch (e) {
        reply.code(400);
        return {
          ok: false,
          error: { code: "INVALID_AMOUNT", detail: (e as Error).message }
        };
      }
      if (!result.ok) {
        reply.code(400);
        return {
          ok: false,
          error: { code: result.code, detail: result.detail }
        };
      }
      state.vault = result.state;
      await writeJsonAtomic(
        resolveDataPath(state.dataDir, FILES.vault),
        state.vault,
        VaultState
      );
      const norm = normalizeAddress(agent_id);
      return { ok: true, vault: state.vault.agents[norm] };
    });
  });
}
