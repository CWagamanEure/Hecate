/**
 * settlementSigner — V2 stage 1.
 *
 * Produces the engine signature consumed by HecateVault.sol#settleBatch.
 *
 * Preimage format (must match contracts/HecateVault.sol line 160):
 *   keccak256(abi.encode(
 *     bytes32 batchId,
 *     address[] agents,
 *     int256[] ethDeltas,
 *     int256[] usdcDeltas
 *   ))
 *
 * The cross-tool ABI parity test
 * (contracts/test/HecateVaultAbiParity.t.sol + tests/vaultAbi.parity.test.ts)
 * pins viem's encodeAbiParameters output against solc's abi.encode for a
 * fixed vector. As long as this module uses the same primitives, viem and
 * solc cannot drift silently.
 *
 * Conversions from engine state -> on-chain preimage:
 *   - batchId: the engine's `batch_id` is a string (e.g. "batch_1770000000000").
 *     The on-chain contract takes bytes32. We hash the UTF-8 bytes with
 *     keccak256 to derive a deterministic bytes32. Different batch_id strings
 *     produce different hashes (32-byte collision space).
 *   - agents: deduplicated, lexicographically sorted unique agents from
 *     vault_deltas. Each address is taken in its existing EIP-55 form (the
 *     ABI encoder lowercases internally).
 *   - ethDeltas[i]: sum of agent[i]'s ETH vault_deltas, scaled to wei
 *     (18-decimal big int). The engine math layer already uses 18-decimal
 *     scaling internally, so this is a pass-through.
 *   - usdcDeltas[i]: sum of agent[i]'s USDC vault_deltas, scaled to
 *     6-decimal (micro-USDC). The engine math layer uses 18 decimals; we
 *     divide by 10^12 and *throw* if the residue is non-zero. That means
 *     V2-stage-1 requires the engine to produce USDC deltas with <= 6
 *     fractional digits of precision. For the v1 demo flows
 *     (price * eth_amount with clean values), this always holds. A future
 *     stage that allows finer USDC precision would need round-to-even or
 *     6-decimal-native USDC at the matching layer.
 *
 * v1 conservation guarantee (sum ETH = 0, sum USDC = 0) is preserved by
 * the conversion because every ETH/USDC delta is sign-symmetric across
 * counterparties: if (alice +X, bob -X) in 18-decimal, the same is true
 * after dividing both by 10^12.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Hex32, Hex65, HexAddress, VaultDelta } from "@shared/schemas";
import { toScaled } from "@shared/math/decimal";
import { signHash } from "@shared/crypto/signing";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** USDC scale on-chain: 10^6 (6-decimal token). Engine uses 10^18 internally. */
const USDC_18_TO_6 = 10n ** 12n;

export type VaultPreimage = {
  /** keccak256 of the abi.encode-d preimage. The engine signs THIS. */
  hash: Hex32;
  /** keccak256(utf8 bytes of the engine's string batch_id) -> bytes32 */
  batchIdBytes32: Hex32;
  /** Lexicographically sorted unique agents (each in its existing case). */
  agents: HexAddress[];
  /** Wei (10^18-scaled) per-agent ETH delta. Σ = 0. */
  ethDeltas: bigint[];
  /** Micro-USDC (10^6-scaled) per-agent USDC delta. Σ = 0. */
  usdcDeltas: bigint[];
};

/** Convert the engine's string batch_id to the on-chain bytes32. */
export function batchIdToBytes32(batchId: string): Hex32 {
  const utf8 = new TextEncoder().encode(batchId);
  return ("0x" + bytesToHex(keccak_256(utf8))) as Hex32;
}

/**
 * Convert vault_deltas to the parallel-array form HecateVault.settleBatch
 * expects, derive the preimage, and return both.
 *
 * Throws if a USDC delta has sub-6-decimal precision (10^18-scaled value
 * not divisible by 10^12) — the engine must not sign a settlement that
 * cannot be losslessly applied on chain.
 */
export function buildVaultPreimage(
  batchId: string,
  vaultDeltas: readonly VaultDelta[]
): VaultPreimage {
  // Aggregate ETH and USDC per agent. Maps preserve insertion order; we
  // sort agents below so output is deterministic regardless of input order.
  const ethByAgent = new Map<HexAddress, bigint>();
  const usdcByAgent = new Map<HexAddress, bigint>();
  const agentSet = new Set<HexAddress>();

  for (const d of vaultDeltas) {
    const scaled18 = toScaled(d.delta);
    agentSet.add(d.agent_id);
    if (d.asset === "ETH") {
      ethByAgent.set(d.agent_id, (ethByAgent.get(d.agent_id) ?? 0n) + scaled18);
    } else if (d.asset === "USDC") {
      if (scaled18 % USDC_18_TO_6 !== 0n) {
        throw new Error(
          `buildVaultPreimage: USDC delta for ${d.agent_id} has sub-6-decimal precision ` +
            `(${d.delta}); cannot be losslessly settled on-chain at 6 decimals`
        );
      }
      const scaled6 = scaled18 / USDC_18_TO_6;
      usdcByAgent.set(d.agent_id, (usdcByAgent.get(d.agent_id) ?? 0n) + scaled6);
    } else {
      throw new Error(`buildVaultPreimage: unknown asset ${d.asset}`);
    }
  }

  // Deterministic agent ordering: lexicographic by lowercased address.
  // We KEEP the original (EIP-55) casing in the output to match what the
  // engine state stores. The on-chain hash is over the bytes20 form (case
  // irrelevant), so we lowercase only at the encode step. viem rejects
  // mixed-case addresses without a valid EIP-55 checksum, so an all-
  // lowercase form is the safest universal input.
  const agents: HexAddress[] = Array.from(agentSet).sort((a, b) =>
    a.toLowerCase() < b.toLowerCase()
      ? -1
      : a.toLowerCase() > b.toLowerCase()
      ? 1
      : 0
  );
  const ethDeltas: bigint[] = agents.map((a) => ethByAgent.get(a) ?? 0n);
  const usdcDeltas: bigint[] = agents.map((a) => usdcByAgent.get(a) ?? 0n);

  const batchIdBytes32 = batchIdToBytes32(batchId);

  const preimage = encodeAbiParameters(
    parseAbiParameters("bytes32, address[], int256[], int256[]"),
    [
      batchIdBytes32 as `0x${string}`,
      agents.map((a) => a.toLowerCase()) as unknown as readonly `0x${string}`[],
      ethDeltas as readonly bigint[],
      usdcDeltas as readonly bigint[],
    ]
  );
  const hash = ("0x" + bytesToHex(keccak_256(hexToBytes(preimage.slice(2))))) as Hex32;

  return { hash, batchIdBytes32, agents, ethDeltas, usdcDeltas };
}

/**
 * Sign a vault settlement preimage with the engine secp256k1 key. Returns
 * the 65-byte r||s||v signature with v ∈ {27, 28} (Ethereum convention).
 * The signature recovers to the ENGINE address on chain via ecrecover.
 */
export function signVaultSettlement(
  batchId: string,
  vaultDeltas: readonly VaultDelta[],
  engineKey: Uint8Array
): { signature: Hex65; preimage: VaultPreimage } {
  const preimage = buildVaultPreimage(batchId, vaultDeltas);
  const signature = signHash(preimage.hash, engineKey);
  return { signature, preimage };
}
