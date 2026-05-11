import { describe, it, expect } from "vitest";
import { keccak256, toHex, recoverAddress } from "viem";
import {
  buildVaultPreimage,
  batchIdToBytes32,
  signVaultSettlement,
} from "@shared/vault/settlementSigner";
import { hexToBytes } from "@noble/hashes/utils";
import { privateKeyToAddress } from "@shared/crypto";
import type { VaultDelta } from "@shared/schemas";

const LOCAL_DEV_KEY = ("0x" + "0".repeat(63) + "1") as `0x${string}`;
const ENGINE_ADDR = privateKeyToAddress(LOCAL_DEV_KEY);

describe("settlementSigner: batchIdToBytes32", () => {
  it("matches keccak256(utf8(batch_id))", () => {
    const id = "batch_1770000000000";
    expect(batchIdToBytes32(id)).toBe(keccak256(toHex(id)));
  });

  it("distinct strings produce distinct bytes32", () => {
    expect(batchIdToBytes32("batch_1")).not.toBe(batchIdToBytes32("batch_2"));
  });
});

describe("settlementSigner: buildVaultPreimage", () => {
  it("reproduces the cross-tool parity hash for the pinned fixture", () => {
    // The parity fixture uses two agents trading 1 ETH for 3500 USDC.
    // After 18-decimal -> 6-decimal scaling, the on-chain USDC deltas are
    // ±3_500_000_000 micro-USDC. ETH stays at ±1e18 wei.
    const deltas: VaultDelta[] = [
      { agent_id: "0x1111111111111111111111111111111111111111", asset: "ETH", delta: "-1" },
      { agent_id: "0x2222222222222222222222222222222222222222", asset: "ETH", delta: "1" },
      { agent_id: "0x1111111111111111111111111111111111111111", asset: "USDC", delta: "3500" },
      { agent_id: "0x2222222222222222222222222222222222222222", asset: "USDC", delta: "-3500" },
    ];
    const p = buildVaultPreimage("hecate-vault-parity-v1", deltas);
    // Same constant pinned in HecateVaultAbiParity.t.sol and vaultAbi.parity.test.ts.
    expect(p.hash).toBe(
      "0xb44a8893dcb666c4736cb267945b8045697a9514d7ae36d1be298ab692cc9816"
    );
    expect(p.agents).toEqual([
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ]);
    expect(p.ethDeltas).toEqual([-1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n]);
    expect(p.usdcDeltas).toEqual([3_500_000_000n, -3_500_000_000n]);
  });

  it("sorts agents lexicographically by lowercased address", () => {
    const deltas: VaultDelta[] = [
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "ETH", delta: "-1" },
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "ETH", delta: "1" },
    ];
    const p = buildVaultPreimage("any", deltas);
    expect(p.agents[0]?.toLowerCase()).toBe("0xaaaa000000000000000000000000000000000000");
    expect(p.agents[1]?.toLowerCase()).toBe("0xbbbb000000000000000000000000000000000000");
  });

  it("aggregates multiple deltas for the same agent+asset", () => {
    const deltas: VaultDelta[] = [
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "ETH", delta: "-0.5" },
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "ETH", delta: "-0.5" },
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "ETH", delta: "1" },
    ];
    const p = buildVaultPreimage("agg", deltas);
    expect(p.ethDeltas[0]).toBe(-1_000_000_000_000_000_000n);
  });

  it("emits zero ETH delta for agents that only have a USDC entry", () => {
    const deltas: VaultDelta[] = [
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "USDC", delta: "-1" },
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "USDC", delta: "1" },
    ];
    const p = buildVaultPreimage("usdc-only", deltas);
    expect(p.ethDeltas).toEqual([0n, 0n]);
    expect(p.usdcDeltas).toEqual([-1_000_000n, 1_000_000n]);
  });

  it("throws on sub-6-decimal USDC precision", () => {
    const deltas: VaultDelta[] = [
      // 0.0000001 USDC = 7 decimals; cannot be losslessly represented at 6.
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "USDC", delta: "0.0000001" },
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "USDC", delta: "-0.0000001" },
    ];
    expect(() => buildVaultPreimage("subprecision", deltas)).toThrow(
      /sub-6-decimal precision/
    );
  });

  it("preserves conservation after 18-to-6 USDC scaling", () => {
    const deltas: VaultDelta[] = [
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "USDC", delta: "-12345.678901" },
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "USDC", delta: "12345.678901" },
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "ETH", delta: "1.5" },
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "ETH", delta: "-1.5" },
    ];
    const p = buildVaultPreimage("conservation", deltas);
    const ethSum = p.ethDeltas.reduce((a, b) => a + b, 0n);
    const usdcSum = p.usdcDeltas.reduce((a, b) => a + b, 0n);
    expect(ethSum).toBe(0n);
    expect(usdcSum).toBe(0n);
  });

  it("rejects unknown asset", () => {
    const deltas: any[] = [
      { agent_id: "0xAAAA000000000000000000000000000000000000", asset: "DAI", delta: "1" },
    ];
    expect(() => buildVaultPreimage("bad-asset", deltas)).toThrow(/unknown asset/);
  });

  it("deduplicates agents case-insensitively (defensive)", () => {
    // Upstream buildSettlementObject already normalizes via normalizeAddress,
    // so this codepath should never trigger via the engine. But the function
    // is exported; a future direct caller passing mixed-case duplicates
    // must not produce two distinct rows for the same on-chain address.
    const lower = "0xaaaa000000000000000000000000000000000000";
    const upper = "0xAAAA000000000000000000000000000000000000";
    const deltas: VaultDelta[] = [
      // Same agent in two casings; should aggregate, not split.
      { agent_id: lower, asset: "ETH", delta: "-0.5" },
      { agent_id: upper, asset: "ETH", delta: "-0.5" },
      { agent_id: "0xBBBB000000000000000000000000000000000000", asset: "ETH", delta: "1" },
    ];
    const p = buildVaultPreimage("case-dedup", deltas);
    expect(p.agents).toHaveLength(2);
    expect(p.ethDeltas).toEqual([-1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n]);
  });
});

describe("settlementSigner: signVaultSettlement", () => {
  it("produces a signature recoverable to the engine address", async () => {
    const deltas: VaultDelta[] = [
      { agent_id: "0x1111111111111111111111111111111111111111", asset: "ETH", delta: "-1" },
      { agent_id: "0x2222222222222222222222222222222222222222", asset: "ETH", delta: "1" },
      { agent_id: "0x1111111111111111111111111111111111111111", asset: "USDC", delta: "3500" },
      { agent_id: "0x2222222222222222222222222222222222222222", asset: "USDC", delta: "-3500" },
    ];
    const pkBytes = hexToBytes(LOCAL_DEV_KEY.slice(2));
    const { signature, preimage } = signVaultSettlement("hecate-vault-parity-v1", deltas, pkBytes);

    const recovered = await recoverAddress({
      hash: preimage.hash as `0x${string}`,
      signature: signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(ENGINE_ADDR.toLowerCase());

    // And the parity-pinned hash is what we signed.
    expect(preimage.hash).toBe(
      "0xb44a8893dcb666c4736cb267945b8045697a9514d7ae36d1be298ab692cc9816"
    );
  });
});
