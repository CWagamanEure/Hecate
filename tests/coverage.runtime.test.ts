/**
 * Targeted bootstrap branch coverage: parseEngineKey throws, EIGEN_TEE strict
 * fail, and EIGEN_TEE happy-path runtime construction.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../server/runtime";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hecate-cov-rt-"));
}

describe("bootstrap — engine key parsing", () => {
  it("missing ENGINE_PRIVATE_KEY -> throws", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      RUNTIME_MODE: "LOCAL_MOCK",
      CODE_DIGEST: "sha256:test"
    };
    await expect(
      bootstrap(env as unknown as NodeJS.ProcessEnv)
    ).rejects.toThrow(/ENGINE_PRIVATE_KEY not set/);
  });

  it("wrong-length ENGINE_PRIVATE_KEY -> throws", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      RUNTIME_MODE: "LOCAL_MOCK",
      ENGINE_PRIVATE_KEY: "0x1234",
      CODE_DIGEST: "sha256:test"
    };
    await expect(
      bootstrap(env as unknown as NodeJS.ProcessEnv)
    ).rejects.toThrow(/32 bytes/);
  });

  it("ENGINE_PRIVATE_KEY without 0x prefix is accepted", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      RUNTIME_MODE: "LOCAL_MOCK",
      ENGINE_PRIVATE_KEY: "0".repeat(63) + "1",
      CODE_DIGEST: "sha256:test"
    };
    const state = await bootstrap(env as unknown as NodeJS.ProcessEnv);
    expect(state.runtime.runtime_mode).toBe("LOCAL_MOCK");
  });
});

describe("bootstrap — EIGEN_TEE branches", () => {
  it("EIGEN_TEE missing all eigen vars -> throws", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      RUNTIME_MODE: "EIGEN_TEE",
      ENGINE_PRIVATE_KEY: "0x" + "0".repeat(63) + "1",
      CODE_DIGEST: "sha256:test"
    };
    await expect(
      bootstrap(env as unknown as NodeJS.ProcessEnv)
    ).rejects.toThrow(/EIGEN_TEE requires/);
  });

  it("EIGEN_TEE missing one eigen var -> throws", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      RUNTIME_MODE: "EIGEN_TEE",
      ENGINE_PRIVATE_KEY: "0x" + "0".repeat(63) + "1",
      CODE_DIGEST: "sha256:test",
      EIGENCOMPUTE_APP_ID: "app",
      EIGENCOMPUTE_IMAGE_DIGEST: "img"
      // missing attestation
    };
    await expect(
      bootstrap(env as unknown as NodeJS.ProcessEnv)
    ).rejects.toThrow(/EIGEN_TEE requires/);
  });

  it("EIGEN_TEE with all eigen vars set -> bootstrap succeeds; runtime populated", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      RUNTIME_MODE: "EIGEN_TEE",
      ENGINE_PRIVATE_KEY: "0x" + "0".repeat(63) + "1",
      CODE_DIGEST: "sha256:test",
      EIGENCOMPUTE_APP_ID: "app-1",
      EIGENCOMPUTE_IMAGE_DIGEST: "sha256:img",
      EIGENCOMPUTE_ATTESTATION_ID: "att-1"
    };
    const state = await bootstrap(env as unknown as NodeJS.ProcessEnv);
    expect(state.runtime.runtime_mode).toBe("EIGEN_TEE");
    expect(state.runtime.eigencompute_app_id).toBe("app-1");
    expect(state.runtime.eigencompute_image_digest).toBe("sha256:img");
    expect(state.runtime.eigencompute_attestation_id).toBe("att-1");
  });

  it("default RUNTIME_MODE is LOCAL_MOCK with null eigen fields", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      ENGINE_PRIVATE_KEY: "0x" + "0".repeat(63) + "1",
      CODE_DIGEST: "sha256:test"
    };
    const state = await bootstrap(env as unknown as NodeJS.ProcessEnv);
    expect(state.runtime.runtime_mode).toBe("LOCAL_MOCK");
    expect(state.runtime.eigencompute_app_id).toBeNull();
    expect(state.runtime.eigencompute_image_digest).toBeNull();
    expect(state.runtime.eigencompute_attestation_id).toBeNull();
  });
});

describe("bootstrap — defaults", () => {
  it("CODE_DIGEST defaults to sha256:dev-local", async () => {
    const env = {
      DATA_DIR: await tempDir(),
      ENGINE_PRIVATE_KEY: "0x" + "0".repeat(63) + "1"
    };
    const state = await bootstrap(env as unknown as NodeJS.ProcessEnv);
    expect(state.runtime.engine_code_digest).toBe("sha256:dev-local");
  });
});
