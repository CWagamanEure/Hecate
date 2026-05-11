import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDemoWallets,
  demoWalletsExist,
  DemoWalletFile,
} from "@agents/demoWallets";

async function withTempFile(
  content: string,
  fn: (path: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hecate-wallets-"));
  const path = join(dir, "wallets.json");
  await writeFile(path, content, "utf-8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALID_WALLETS = {
  version: 1,
  created_at: "2026-05-11T00:00:00.000Z",
  note: "test fixture",
  A: {
    pk: "0x0000000000000000000000000000000000000000000000000000000000000001",
    addr: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  },
  B: {
    pk: "0x0000000000000000000000000000000000000000000000000000000000000002",
    addr: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF",
  },
  C: {
    pk: "0x0000000000000000000000000000000000000000000000000000000000000003",
    addr: "0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69",
  },
  D: {
    pk: "0x0000000000000000000000000000000000000000000000000000000000000004",
    addr: "0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718",
  },
};

describe("demoWallets — loader", () => {
  it("loads a valid wallet file", async () => {
    await withTempFile(JSON.stringify(VALID_WALLETS), async (path) => {
      const w = await loadDemoWallets(path);
      expect(w.A.addr).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
      expect(w.version).toBe(1);
    });
  });

  it("throws a self-explanatory error when the file is missing", async () => {
    await expect(loadDemoWallets("/tmp/does-not-exist-12345.json")).rejects.toThrow(
      /not found.*wallets:gen/
    );
  });

  it("throws on invalid JSON", async () => {
    await withTempFile("not-json", async (path) => {
      await expect(loadDemoWallets(path)).rejects.toThrow(/not valid JSON/);
    });
  });

  it("throws on schema mismatch (missing agent)", async () => {
    const bad = { ...VALID_WALLETS };
    delete (bad as Record<string, unknown>).D;
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDemoWallets(path)).rejects.toThrow(/schema validation/);
    });
  });

  it("throws on schema mismatch (invalid address)", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_WALLETS));
    bad.A.addr = "0xZZ";
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDemoWallets(path)).rejects.toThrow(/schema validation/);
    });
  });

  it("rejects unknown top-level fields (strict)", async () => {
    const bad = { ...VALID_WALLETS, extra: "nope" };
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDemoWallets(path)).rejects.toThrow(/schema validation/);
    });
  });

  it("demoWalletsExist returns true / false correctly", async () => {
    await withTempFile(JSON.stringify(VALID_WALLETS), async (path) => {
      expect(await demoWalletsExist(path)).toBe(true);
    });
    expect(await demoWalletsExist("/tmp/does-not-exist-67890.json")).toBe(false);
  });

  it("schema accepts only version=1", () => {
    const bad = { ...VALID_WALLETS, version: 2 };
    expect(DemoWalletFile.safeParse(bad).success).toBe(false);
  });
});
