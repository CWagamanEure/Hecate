import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentFixture } from "@agents/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEPOLIA_DIR = resolve(HERE, "..", "agents", "examples", "sepolia");

const FILES = ["agentA.json", "agentB.json", "agentC.json", "agentD.json"] as const;

async function loadAll(): Promise<AgentFixture[]> {
  const out: AgentFixture[] = [];
  for (const f of FILES) {
    const raw = await readFile(join(SEPOLIA_DIR, f), "utf-8");
    out.push(AgentFixture.parse(JSON.parse(raw)));
  }
  return out;
}

describe("Sepolia-scaled fixtures", () => {
  it("all four fixtures parse against AgentFixture", async () => {
    const fixtures = await loadAll();
    expect(fixtures).toHaveLength(4);
    for (const fx of fixtures) {
      expect(fx.name).toMatch(/Sepolia/);
    }
  });

  it("deposit amounts match the V6a deposit plan (per-agent on-chain balance)", async () => {
    const [a, b, c, d] = await loadAll();
    expect(a!.deposits[0]).toEqual({ asset: "ETH", amount: "0.0001" });
    expect(b!.deposits[0]).toEqual({ asset: "USDC", amount: "5000" });
    expect(c!.deposits[0]).toEqual({ asset: "USDC", amount: "5000" });
    expect(d!.deposits[0]).toEqual({ asset: "USDC", amount: "200" });
  });

  it("intent amounts fit the deposits (no over-reservation at acceptance)", async () => {
    const [a, b, c, d] = await loadAll();
    // A: SELL 0.0001 ETH out of 0.0001 deposited. Fits.
    expect(a!.intent.max_base_amount).toBe("0.0001");
    // B: BUY 0.00004 ETH at 3610 -> max spend 0.1444 USDC <= 5000. Fits.
    expect(b!.intent.max_base_amount).toBe("0.00004");
    expect(b!.intent.limit_price).toBe("3610");
    // C: BUY 0.00008 ETH at 3590 -> max spend 0.2872 USDC <= 5000. Fits.
    expect(c!.intent.max_base_amount).toBe("0.00008");
    expect(c!.intent.limit_price).toBe("3590");
    // D: BUY 1 ETH at 3600 -> max spend 3600 USDC > 200. Intentionally
    //    INSUFFICIENT_FUNDS so the demo's reject branch still triggers.
    expect(d!.intent.max_base_amount).toBe("1");
    expect(d!.intent.limit_price).toBe("3600");
    expect(d!.expected_outcome.reject_reason).toBe("INSUFFICIENT_FUNDS");
  });

  it("expected outcomes describe the 1e-5 scaled matching at clearing 3590", async () => {
    const [a, b, c, d] = await loadAll();
    // A fully filled. 0.0001 ETH × 3590 = 0.359 USDC.
    expect(a!.expected_outcome.final_status).toBe("FILLED");
    expect(a!.expected_outcome.final_filled_base).toBe("0.0001");
    expect(a!.expected_outcome.final_balance_eth).toBe("0");
    expect(a!.expected_outcome.final_balance_usdc).toBe("0.359");
    // B fully filled. 0.00004 ETH × 3590 = 0.1436 USDC spent of 5000.
    expect(b!.expected_outcome.final_status).toBe("FILLED");
    expect(b!.expected_outcome.final_filled_base).toBe("0.00004");
    expect(b!.expected_outcome.final_balance_eth).toBe("0.00004");
    expect(b!.expected_outcome.final_balance_usdc).toBe("4999.8564");
    // C partially filled. Supply (0.0001) - B (0.00004) = 0.00006 for C.
    // 0.00006 × 3590 = 0.2154 USDC spent of 5000.
    expect(c!.expected_outcome.final_status).toBe("PARTIALLY_FILLED");
    expect(c!.expected_outcome.final_filled_base).toBe("0.00006");
    expect(c!.expected_outcome.final_balance_eth).toBe("0.00006");
    expect(c!.expected_outcome.final_balance_usdc).toBe("4999.7846");
    // D rejected; balance unchanged.
    expect(d!.expected_outcome.accepted).toBe(false);
    expect(d!.expected_outcome.final_balance_usdc).toBe("200");
  });

  it("conservation: sum of filled ETH credits == A's sold ETH", () => {
    // 0.00004 (B) + 0.00006 (C) = 0.0001 = A's sold.
    const bFill = "0.00004";
    const cFill = "0.00006";
    // Avoid float math; use string-as-bigint-at-1e8 since these are at most
    // 5 fractional digits.
    const toScaled = (s: string) => {
      const [intPart, fracPart = ""] = s.split(".");
      const padded = (fracPart + "00000000").slice(0, 8);
      return BigInt(intPart!) * 100_000_000n + BigInt(padded || "0");
    };
    expect(toScaled(bFill) + toScaled(cFill)).toBe(toScaled("0.0001"));
  });

  it("USDC quote conservation: A's credit == B + C debits", () => {
    // 0.1436 + 0.2154 = 0.359. Same scaled-bigint approach.
    const toScaled = (s: string) => {
      const [intPart, fracPart = ""] = s.split(".");
      const padded = (fracPart + "00000000").slice(0, 8);
      return BigInt(intPart!) * 100_000_000n + BigInt(padded || "0");
    };
    expect(toScaled("0.1436") + toScaled("0.2154")).toBe(toScaled("0.359"));
  });
});
