import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { injectDemoWalletsIntoFixtures } from "@agents/runDemo";
import { AgentFixture } from "@agents/types";
import type { DemoWalletFile } from "@agents/demoWallets";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "agents", "examples");

async function loadCanonicalFixtures(): Promise<AgentFixture[]> {
  const files = ["agentA.json", "agentB.json", "agentC.json", "agentD.json"];
  const out: AgentFixture[] = [];
  for (const f of files) {
    const raw = await readFile(join(FIXTURE_DIR, f), "utf-8");
    out.push(AgentFixture.parse(JSON.parse(raw)));
  }
  return out;
}

const TEST_WALLETS: DemoWalletFile = {
  version: 1,
  created_at: "2026-05-11T00:00:00.000Z",
  note: "test fixture",
  A: {
    pk: "0x000000000000000000000000000000000000000000000000000000000000000a",
    addr: "0x9bC1715CB1CD0A03f8aF9684Fa68aE8a5BfF8b65"
  },
  B: {
    pk: "0x000000000000000000000000000000000000000000000000000000000000000b",
    addr: "0x6f02c0a07415c1F3F212e1afdc8c0Cf6b8db78D0"
  },
  C: {
    pk: "0x000000000000000000000000000000000000000000000000000000000000000c",
    addr: "0xc8c4dC1E97e2a72e9E5E16F70eD9f8aD1B16D9fa"
  },
  D: {
    pk: "0x000000000000000000000000000000000000000000000000000000000000000d",
    addr: "0xfd1ECAc24cc8d0Db35a1B5d5e2c8B4d2c8F1ec3e"
  }
};

describe("injectDemoWalletsIntoFixtures", () => {
  it("replaces each canonical fixture's private_key with the matching wallet pk", async () => {
    const canonical = await loadCanonicalFixtures();
    // Sanity: canonical fixtures use the hardcoded dev keys.
    expect(canonical[0]!.private_key).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002"
    );
    const injected = injectDemoWalletsIntoFixtures(canonical, TEST_WALLETS);
    expect(injected[0]!.private_key).toBe(TEST_WALLETS.A.pk);
    expect(injected[1]!.private_key).toBe(TEST_WALLETS.B.pk);
    expect(injected[2]!.private_key).toBe(TEST_WALLETS.C.pk);
    expect(injected[3]!.private_key).toBe(TEST_WALLETS.D.pk);
  });

  it("does not mutate the input fixtures (returns new objects)", async () => {
    const canonical = await loadCanonicalFixtures();
    const originalPk = canonical[0]!.private_key;
    const injected = injectDemoWalletsIntoFixtures(canonical, TEST_WALLETS);
    expect(canonical[0]!.private_key).toBe(originalPk);
    expect(injected[0]).not.toBe(canonical[0]);
  });

  it("preserves all non-key fields verbatim", async () => {
    const canonical = await loadCanonicalFixtures();
    const injected = injectDemoWalletsIntoFixtures(canonical, TEST_WALLETS);
    for (let i = 0; i < canonical.length; i++) {
      const before = canonical[i]!;
      const after = injected[i]!;
      expect(after.name).toBe(before.name);
      expect(after.deposits).toEqual(before.deposits);
      expect(after.intent).toEqual(before.intent);
      expect(after.expected_outcome).toEqual(before.expected_outcome);
    }
  });

  it("throws when given the wrong number of fixtures", () => {
    expect(() =>
      injectDemoWalletsIntoFixtures([] as AgentFixture[], TEST_WALLETS)
    ).toThrow(/expected 4 fixtures/);
  });
});
