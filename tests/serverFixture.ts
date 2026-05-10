/**
 * Shared test fixture for server tests. Each call to newApp() creates an
 * isolated server with a per-test temp DATA_DIR.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../server/runtime";
import { buildApp } from "../server/buildApp";
import {
  signEnvelope,
  hashPayload,
  privateKeyToAddress,
  mockEncryptPayload,
  deriveMockEnclaveKey,
  canonicalJson,
  keccak256Hex,
  signHash
} from "@shared/crypto";
import type {
  PrivatePayload,
  PublicEnvelopeUnsigned,
  PublicEnvelope,
  HexBytes,
  Hex65,
  HexAddress
} from "@shared/schemas";

export const ENGINE_PK = "0x" + "0".repeat(63) + "1";
export const TEST_CODE_DIGEST = "sha256:test";

const tempDirs: string[] = [];

export async function newApp(): Promise<{
  app: ReturnType<typeof buildApp>;
  dataDir: string;
  state: Awaited<ReturnType<typeof bootstrap>>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "hecate-server-"));
  tempDirs.push(dataDir);
  const env = {
    DATA_DIR: dataDir,
    RUNTIME_MODE: "LOCAL_MOCK",
    ENGINE_PRIVATE_KEY: ENGINE_PK,
    CODE_DIGEST: TEST_CODE_DIGEST
  };
  const state = await bootstrap(env as unknown as NodeJS.ProcessEnv);
  const app = buildApp({ state });
  await app.ready();
  return { app, dataDir, state };
}

export async function cleanupTempDirs(): Promise<void> {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
}

// ---- payload / envelope helpers --------------------------------------------

let nonce = 1;

export function sellPayload(opts: {
  base: string;
  limit: string;
  min?: string;
}): PrivatePayload {
  return {
    side: "SELL",
    asset_in: "ETH",
    asset_out: "USDC",
    max_base_amount: opts.base,
    limit_price: opts.limit,
    allow_partial_fill: true,
    min_base_fill_amount: opts.min ?? "0.0001",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonce++)
  };
}

export function buyPayload(opts: {
  base: string;
  limit: string;
  min?: string;
}): PrivatePayload {
  return {
    side: "BUY",
    asset_in: "USDC",
    asset_out: "ETH",
    max_base_amount: opts.base,
    limit_price: opts.limit,
    allow_partial_fill: true,
    min_base_fill_amount: opts.min ?? "0.0001",
    deadline_batches: 3,
    max_price_impact_bps: 10000,
    fallback_after_batches: null,
    nonce: String(nonce++)
  };
}

export function makeEnvelope(opts: {
  intent_id: string;
  agent_id: string;
  pk: string;
  payload: PrivatePayload;
}): PublicEnvelope {
  const ciphertext = mockEncryptPayload(
    opts.payload,
    deriveMockEnclaveKey(TEST_CODE_DIGEST)
  ) as HexBytes;
  const unsigned: PublicEnvelopeUnsigned = {
    intent_id: opts.intent_id,
    agent_id: opts.agent_id,
    market: "ETH/USDC",
    expiry_ms: Date.now() + 60_000,
    payload_commitment: hashPayload(opts.payload),
    payload_ciphertext: ciphertext,
    nonce: opts.payload.nonce
  };
  return signEnvelope(unsigned, opts.pk);
}

// ---- agent keys ------------------------------------------------------------

export const PK_A = "0x" + "0".repeat(63) + "2";
export const PK_B = "0x" + "0".repeat(63) + "3";
export const PK_C = "0x" + "0".repeat(63) + "4";
export const PK_D = "0x" + "0".repeat(63) + "5";
export const ADDR_A = privateKeyToAddress(PK_A);
export const ADDR_B = privateKeyToAddress(PK_B);
export const ADDR_C = privateKeyToAddress(PK_C);
export const ADDR_D = privateKeyToAddress(PK_D);

// ---- signed-challenge helpers ----------------------------------------------

export function signChallenge(args: {
  action: "GET_FILL_RECEIPT" | "GET_INTENT_STATUS";
  intent_id: string;
  pk: string;
  timestamp_ms?: number;
}): {
  requester: HexAddress;
  timestamp_ms: number;
  signature: Hex65;
} {
  const ts = args.timestamp_ms ?? Date.now();
  const json = canonicalJson({
    action: args.action,
    intent_id: args.intent_id,
    timestamp_ms: ts
  });
  const hash = keccak256Hex(json);
  const sig = signHash(hash, args.pk);
  return {
    requester: privateKeyToAddress(args.pk),
    timestamp_ms: ts,
    signature: sig
  };
}
