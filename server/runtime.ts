import { hexToBytes } from "@noble/hashes/utils";
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
  type RuntimeMetadata
} from "@shared/schemas";
import type { ServerState } from "./state";

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

  const vault = await readJsonFile(
    resolveDataPath(dataDir, FILES.vault),
    VaultState,
    { fallback: { agents: {} } }
  );
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
    readyPool: new Map()
  };
}
