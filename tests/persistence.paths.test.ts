import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDataPath,
  ensureParentDir,
  ensureDir,
  FILES
} from "@shared/persistence";

let tempDirs: string[] = [];

async function newTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hecate-paths-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("resolveDataPath", () => {
  it("joins data dir and filename", () => {
    expect(resolveDataPath("/tmp/data", "vault.json")).toBe(
      "/tmp/data/vault.json"
    );
  });
});

describe("FILES constants", () => {
  it("exposes the expected filenames", () => {
    expect(FILES.intents).toBe("intents.jsonl");
    expect(FILES.rejections).toBe("rejections.jsonl");
    expect(FILES.batches).toBe("batches.jsonl");
    expect(FILES.receipts).toBe("receipts.jsonl");
    expect(FILES.vault).toBe("vault.json");
    expect(FILES.reservations).toBe("reservations.json");
  });
});

describe("ensureParentDir", () => {
  it("creates the parent directory of a file path", async () => {
    const root = await newTempDir();
    const filePath = join(root, "nested", "deep", "vault.json");
    await ensureParentDir(filePath);
    const s = await stat(join(root, "nested", "deep"));
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    const root = await newTempDir();
    const filePath = join(root, "x", "y.json");
    await ensureParentDir(filePath);
    await ensureParentDir(filePath); // no throw
    const s = await stat(join(root, "x"));
    expect(s.isDirectory()).toBe(true);
  });
});

describe("ensureDir", () => {
  it("creates the directory itself", async () => {
    const root = await newTempDir();
    const dirPath = join(root, "logs", "2026");
    await ensureDir(dirPath);
    const s = await stat(dirPath);
    expect(s.isDirectory()).toBe(true);
  });
});
