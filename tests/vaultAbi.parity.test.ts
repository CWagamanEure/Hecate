import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  recoverAddress,
  toHex,
} from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { privateKeyToAddress } from "@shared/crypto";

// ---------------------------------------------------------------------------
// Cross-tool ABI parity for HecateVault.settleBatch.
//
// HecateVault recovers the engine signature against:
//   keccak256(abi.encode(batchId, agents, ethDeltas, usdcDeltas))
//
// V2 will build that same preimage in JS via viem's encodeAbiParameters.
// This test pins a fixed (batchId, agents, ethDeltas, usdcDeltas) vector
// to an expected hash. The mirror Solidity test
// (contracts/test/HecateVaultAbiParity.t.sol) asserts the same constant
// from solc's abi.encode. If either side drifts, both tests must agree on
// the new value, which prevents a silent encoding divergence reaching the
// chain.
// ---------------------------------------------------------------------------

const FIXED_BATCH_ID = keccak256(toHex("hecate-vault-parity-v1"));
const FIXED_AGENTS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
] as const;
const FIXED_ETH_DELTAS  = [-1_000_000_000_000_000_000n,  1_000_000_000_000_000_000n] as const;
const FIXED_USDC_DELTAS = [ 3_500_000_000n,             -3_500_000_000n] as const;

// Pinned by viem's encodeAbiParameters + keccak256. The Forge test pins the
// same value from solc's abi.encode. If solc or viem ever disagree this
// test will fail and force a deliberate update.
const EXPECTED_HASH =
  "0xb44a8893dcb666c4736cb267945b8045697a9514d7ae36d1be298ab692cc9816";

function buildHash(): `0x${string}` {
  const preimage = encodeAbiParameters(
    parseAbiParameters("bytes32, address[], int256[], int256[]"),
    [
      FIXED_BATCH_ID,
      FIXED_AGENTS as unknown as readonly `0x${string}`[],
      FIXED_ETH_DELTAS as readonly bigint[],
      FIXED_USDC_DELTAS as readonly bigint[],
    ],
  );
  return keccak256(preimage);
}

describe("HecateVault.settleBatch ABI parity (viem ↔ solc)", () => {
  it("viem reproduces the pinned solc abi.encode hash", () => {
    expect(buildHash()).toBe(EXPECTED_HASH);
  });

  it("engine signature recovers to LOCAL_DEV_KEY address (raw secp256k1, no EIP-191)", async () => {
    // Engine signs the raw hash (not the EIP-191 personal-sign digest) so
    // Solidity's ecrecover works directly on it.
    const LOCAL_DEV_KEY = "0x" + "0".repeat(63) + "1";
    const ENGINE_ADDR  = privateKeyToAddress(LOCAL_DEV_KEY as `0x${string}`);

    const hash = buildHash();
    const pkBytes = Buffer.from(LOCAL_DEV_KEY.slice(2), "hex");
    const hashBytes = Buffer.from(hash.slice(2), "hex");
    const sig = secp256k1.sign(hashBytes, pkBytes, { lowS: true });

    // viem expects 0x-prefixed signature: r || s || v (v = 27|28).
    const r = sig.r.toString(16).padStart(64, "0");
    const s = sig.s.toString(16).padStart(64, "0");
    const v = (27 + (sig.recovery ?? 0)).toString(16).padStart(2, "0");
    const sigHex = ("0x" + r + s + v) as `0x${string}`;

    const recovered = await recoverAddress({ hash, signature: sigHex });
    expect(recovered.toLowerCase()).toBe(ENGINE_ADDR.toLowerCase());
  });
});
