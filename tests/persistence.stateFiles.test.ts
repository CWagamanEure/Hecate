import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic, readJsonFile } from "@shared/persistence";
import { VaultState, ReservationBook } from "@shared/schemas";
import { canonicalJson } from "@shared/crypto";

let tempDirs: string[] = [];

async function newTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hecate-state-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

const emptyVault: VaultState = { agents: {} };
const populatedVault: VaultState = {
  agents: {
    ["0x" + "A".repeat(40)]: {
      agent_id: "0x" + "A".repeat(40),
      balances: { ETH: "10", USDC: "0" },
      reserved: { ETH: "0", USDC: "0" },
      nonces_seen: ["1", "2"]
    }
  }
};

describe("writeJsonAtomic", () => {
  it("writes canonical JSON to disk", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeJsonAtomic(path, populatedVault, VaultState);
    const raw = await readFile(path, "utf-8");
    expect(raw).toBe(canonicalJson(populatedVault));
  });

  it("creates the parent directory if missing", async () => {
    const dir = await newTempDir();
    const path = join(dir, "nested", "deep", "vault.json");
    await writeJsonAtomic(path, emptyVault, VaultState);
    const raw = await readFile(path, "utf-8");
    expect(raw).toBe(canonicalJson(emptyVault));
  });

  it("overwrites existing file safely (read-after-write returns new value)", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeJsonAtomic(path, emptyVault, VaultState);
    await writeJsonAtomic(path, populatedVault, VaultState);
    const back = await readJsonFile(path, VaultState);
    expect(back).toEqual(populatedVault);
  });

  it("does not leave a .tmp file behind on success", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeJsonAtomic(path, populatedVault, VaultState);
    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmps).toEqual([]);
  });

  it("schema validation failure does NOT modify existing target file", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeJsonAtomic(path, populatedVault, VaultState);
    const before = await readFile(path, "utf-8");

    const garbage = { agents: { foo: "bar" } } as unknown as VaultState;
    await expect(writeJsonAtomic(path, garbage, VaultState)).rejects.toThrow();

    const after = await readFile(path, "utf-8");
    expect(after).toBe(before);

    // No tmp file left behind either.
    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmps).toEqual([]);
  });

  it("survives concurrent calls to different files in the same dir", async () => {
    const dir = await newTempDir();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeJsonAtomic(join(dir, `f-${i}.json`), { i }, undefined)
      )
    );
    const entries = await readdir(dir);
    const real = entries.filter((e) => !e.endsWith(".tmp")).sort();
    expect(real).toHaveLength(10);
  });
});

describe("readJsonFile", () => {
  it("round-trips a VaultState", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeJsonAtomic(path, populatedVault, VaultState);
    expect(await readJsonFile(path, VaultState)).toEqual(populatedVault);
  });

  it("returns fallback for missing file when fallback is provided", async () => {
    const dir = await newTempDir();
    const path = join(dir, "missing.json");
    const r = await readJsonFile(path, ReservationBook, {
      fallback: { reservations: [] }
    });
    expect(r).toEqual({ reservations: [] });
  });

  it("throws on missing file when no fallback is provided", async () => {
    const dir = await newTempDir();
    const path = join(dir, "missing.json");
    await expect(readJsonFile(path, VaultState)).rejects.toThrow();
  });

  it("throws on schema-invalid content with helpful message", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    // Write invalid content via writeJsonAtomic without schema (the "trust me" path)
    await writeJsonAtomic(path, { agents: { foo: "bar" } }, undefined);
    await expect(readJsonFile(path, VaultState)).rejects.toThrow(/schema invalid/);
  });

  it("throws on malformed JSON file content", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    // Use writeJsonAtomic to write a string (no schema), then overwrite manually
    // with malformed content via direct fs write.
    await writeJsonAtomic(path, "valid", undefined);
    // Now corrupt it.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not-json", "utf-8");
    await expect(readJsonFile(path, VaultState)).rejects.toThrow(/invalid JSON/);
  });
});
