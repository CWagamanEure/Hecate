import type { FastifyInstance } from "fastify";
import type { ServerState } from "../state";

export async function publicRoutes(
  app: FastifyInstance,
  opts: { state: ServerState }
): Promise<void> {
  const { state } = opts;

  app.get("/healthz", async () => ({
    ok: true,
    runtime_mode: state.runtime.runtime_mode
  }));

  app.get("/attestation", async () => ({
    runtime: state.runtime,
    engine_address: state.engineAddress,
    matching_rule: "UNIFORM_CLEARING_PRICE_V1" as const,
    markets: ["ETH/USDC"] as const,
    warning:
      state.runtime.runtime_mode === "LOCAL_MOCK"
        ? "LOCAL_MOCK runtime — payload encryption is architectural, not security."
        : null,
    // v1 always uses a local engine private key for receipt signing, even
    // under EIGEN_TEE. Real Eigen app-wallet signing is future work.
    // Hard-coded value — no env var, no overclaiming.
    signer: {
      mode: "LOCAL_DEV_KEY" as const,
      note: "v1 uses a local engine key (ENGINE_PRIVATE_KEY) for receipt signing in both LOCAL_MOCK and EIGEN_TEE modes. Real Eigen app-wallet signing is future work."
    }
  }));

  app.get("/markets", async () => [
    { symbol: "ETH/USDC", status: "OPEN" }
  ]);
}
