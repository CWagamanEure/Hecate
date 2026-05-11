import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDepositPlan,
  SepoliaDepositPlan,
} from "@shared/deployments/depositPlan";

async function withTempFile(
  content: string,
  fn: (path: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hecate-plan-"));
  const path = join(dir, "plan.json");
  await writeFile(path, content, "utf-8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALID_PLAN = {
  chain_id: 11155111,
  note: "test plan",
  agents: {
    A: {
      deposits: [
        { asset: "ETH", amount_human: "0.0001", amount_wei: "100000000000000" },
      ],
    },
    B: {
      deposits: [
        { asset: "USDC", amount_human: "5000", amount_micro: "5000000000" },
      ],
    },
    C: {
      deposits: [
        { asset: "USDC", amount_human: "5000", amount_micro: "5000000000" },
      ],
    },
    D: {
      deposits: [
        { asset: "USDC", amount_human: "200", amount_micro: "200000000" },
      ],
    },
  },
};

describe("SepoliaDepositPlan", () => {
  it("loads the committed default plan and matches the Sepolia chain id", async () => {
    const plan = await loadDepositPlan();
    expect(plan.chain_id).toBe(11155111);
    // Sanity-check the committed amounts so V5 mint + V6a deposit stay in sync.
    expect(plan.agents.A.deposits[0]!.asset).toBe("ETH");
    expect(plan.agents.B.deposits[0]!.asset).toBe("USDC");
    const dDep = plan.agents.D.deposits[0]!;
    if (dDep.asset !== "USDC") throw new Error("D should be USDC");
    expect(dDep.amount_micro).toBe("200000000");
  });

  it("accepts a well-formed plan", async () => {
    await withTempFile(JSON.stringify(VALID_PLAN), async (path) => {
      const p = await loadDepositPlan(path);
      expect(p.agents.A.deposits).toHaveLength(1);
    });
  });

  it("rejects amount_wei that isn't a positive integer string", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_PLAN));
    bad.agents.A.deposits[0].amount_wei = "0.1"; // decimals not allowed in integer form
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDepositPlan(path)).rejects.toThrow();
    });
  });

  it("rejects amount_micro that isn't a positive integer string", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_PLAN));
    bad.agents.B.deposits[0].amount_micro = "-1";
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDepositPlan(path)).rejects.toThrow();
    });
  });

  it("rejects an ETH deposit that carries amount_micro instead of amount_wei", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_PLAN));
    bad.agents.A.deposits[0] = {
      asset: "ETH",
      amount_human: "0.0001",
      amount_micro: "100000000000000",
    };
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDepositPlan(path)).rejects.toThrow();
    });
  });

  it("rejects a USDC deposit that carries amount_wei instead of amount_micro", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_PLAN));
    bad.agents.B.deposits[0] = {
      asset: "USDC",
      amount_human: "5000",
      amount_wei: "5000000000",
    };
    await withTempFile(JSON.stringify(bad), async (path) => {
      await expect(loadDepositPlan(path)).rejects.toThrow();
    });
  });

  it("rejects unknown chain_id", () => {
    const bad = { ...VALID_PLAN, chain_id: 1 };
    expect(SepoliaDepositPlan.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const bad = { ...VALID_PLAN, extra: "nope" };
    expect(SepoliaDepositPlan.safeParse(bad).success).toBe(false);
  });

  it("default plan and committed Sepolia funding plan agree on D's underfunding", async () => {
    // V5 minted exactly 200000000 micro-mUSDC to D. The deposit plan must
    // not try to deposit more than that, or the script would fail with
    // "insufficient mUSDC". This is the contract between V5 and V6a.
    const plan = await loadDepositPlan();
    const dDeposit = plan.agents.D.deposits[0]!;
    if (dDeposit.asset === "USDC") {
      expect(BigInt(dDeposit.amount_micro)).toBeLessThanOrEqual(200_000_000n);
    } else {
      throw new Error("D's deposit should be USDC");
    }
  });
});
