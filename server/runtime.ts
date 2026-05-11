import { hexToBytes } from "@noble/hashes/utils";
import type { Address } from "viem";
import {
  privateKeyToAddress,
  deriveMockEnclaveKey
} from "@shared/crypto";
import {
  readJsonFile,
  resolveDataPath,
  ensureDir,
  FILES
} from "@shared/persistence";
import {
  VaultState,
  ReservationBook,
  type RuntimeMetadata,
  type HexAddress
} from "@shared/schemas";
import { loadSepoliaDeployment } from "@shared/deployments/sepolia";
import { loadDemoWallets } from "@agents/demoWallets";
import { loadOnchainVaultState } from "./vault/onchainLoader";
import type { ServerState, VaultBackend } from "./state";

function parseEngineKey(raw: string | undefined): Uint8Array {
  if (!raw) throw new Error("ENGINE_PRIVATE_KEY not set");
  const stripped = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (stripped.length !== 64) {
    throw new Error("ENGINE_PRIVATE_KEY must be 32 bytes (64 hex chars)");
  }
  return hexToBytes(stripped);
}

export async function bootstrap(
  env: NodeJS.ProcessEnv = process.env
): Promise<ServerState> {
  const dataDir = env.DATA_DIR ?? "./data";
  const runtimeMode = (env.RUNTIME_MODE ?? "LOCAL_MOCK") as
    | "LOCAL_MOCK"
    | "EIGEN_TEE";
  const codeDigest = env.CODE_DIGEST ?? "sha256:dev-local";
  const engineKey = parseEngineKey(env.ENGINE_PRIVATE_KEY);
  const engineAddress = privateKeyToAddress(engineKey);

  let runtime: RuntimeMetadata;
  if (runtimeMode === "EIGEN_TEE") {
    const appId = env.EIGENCOMPUTE_APP_ID;
    const imgDigest = env.EIGENCOMPUTE_IMAGE_DIGEST;
    const attId = env.EIGENCOMPUTE_ATTESTATION_ID;
    if (!appId || !imgDigest || !attId) {
      throw new Error(
        "EIGEN_TEE requires EIGENCOMPUTE_APP_ID, EIGENCOMPUTE_IMAGE_DIGEST, and EIGENCOMPUTE_ATTESTATION_ID; refusing to start"
      );
    }
    runtime = {
      runtime_mode: "EIGEN_TEE",
      engine_code_digest: codeDigest,
      eigencompute_app_id: appId,
      eigencompute_image_digest: imgDigest,
      eigencompute_attestation_id: attId
    };
  } else {
    runtime = {
      runtime_mode: "LOCAL_MOCK",
      engine_code_digest: codeDigest,
      eigencompute_app_id: null,
      eigencompute_image_digest: null,
      eigencompute_attestation_id: null
    };
  }

  const mockEnclaveKey = deriveMockEnclaveKey(codeDigest);

  await ensureDir(dataDir);

  const vaultBackend = parseVaultBackend(env.VAULT_BACKEND);

  let vault: VaultState;
  if (vaultBackend === "onchain") {
    const rpcUrl = resolveSepoliaRpc(env);
    const deployment = await loadSepoliaDeployment();
    const wallets = await loadDemoWallets();
    const agents: HexAddress[] = [
      wallets.A.addr as HexAddress,
      wallets.B.addr as HexAddress,
      wallets.C.addr as HexAddress,
      wallets.D.addr as HexAddress
    ];
    vault = await loadOnchainVaultState({
      rpcUrl,
      vaultAddress: deployment.contracts.HecateVault.address as Address,
      agents
    });
  } else {
    vault = await readJsonFile(
      resolveDataPath(dataDir, FILES.vault),
      VaultState,
      { fallback: { agents: {} } }
    );
  }
  const reservationBook = await readJsonFile(
    resolveDataPath(dataDir, FILES.reservations),
    ReservationBook,
    { fallback: { reservations: [] } }
  );

  return {
    dataDir,
    runtime,
    engineKey,
    engineAddress,
    mockEnclaveKey,
    vault,
    reservationBook,
    readyPool: new Map(),
    vaultBackend
  };
}

export function parseVaultBackend(raw: string | undefined): VaultBackend {
  if (raw === undefined || raw === "" || raw === "mock") return "mock";
  if (raw === "onchain") return "onchain";
  throw new Error(
    `VAULT_BACKEND must be "mock" or "onchain", got "${raw}"`
  );
}

function resolveSepoliaRpc(env: NodeJS.ProcessEnv): string {
  // SEPOLIA_RPC_URL takes priority (full URL); else compose from
  // ALCHEMY_API_KEY. Matches the foundry.toml convention.
  const direct = env.SEPOLIA_RPC_URL;
  if (direct) return direct;
  const key = env.ALCHEMY_API_KEY;
  if (!key) {
    throw new Error(
      "VAULT_BACKEND=onchain requires SEPOLIA_RPC_URL or ALCHEMY_API_KEY in env"
    );
  }
  return `https://eth-sepolia.g.alchemy.com/v2/${key}`;
}
