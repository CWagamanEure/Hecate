import { describe, it, expect, afterAll } from "vitest";
import { recoverAddress } from "viem";
import {
  newApp,
  cleanupTempDirs,
  PK_A,
  PK_B,
  ADDR_A,
  ADDR_B,
  sellPayload,
  buyPayload,
  makeEnvelope,
  ENGINE_PK,
} from "./serverFixture";
import { privateKeyToAddress } from "@shared/crypto";
import { buildVaultPreimage } from "@shared/vault/settlementSigner";

afterAll(cleanupTempDirs);

const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK as `0x${string}`);

describe("server: V2 on-chain vault signature on bundle", () => {
  it("emits engine_signature_onchain on a non-empty batch and it recovers to the engine", async () => {
    const { app } = await newApp();

    // Two-agent ETH-for-USDC match.
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" },
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_B, asset: "USDC", amount: "20000" },
    });

    const pa = sellPayload({ base: "4", limit: "3580" });
    const pb = buyPayload({ base: "4", limit: "3610" });
    const ea = makeEnvelope({ intent_id: "intent_A", agent_id: ADDR_A, pk: PK_A, payload: pa });
    const eb = makeEnvelope({ intent_id: "intent_B", agent_id: ADDR_B, pk: PK_B, payload: pb });

    await app.inject({ method: "POST", url: "/intents", payload: ea });
    await app.inject({ method: "POST", url: "/intents", payload: eb });

    const close = await app.inject({ method: "POST", url: "/batches/close" });
    const bundle = close.json();
    expect(bundle.ok).toBe(true);
    expect(bundle.closed).toBe(true);

    // The new field is present.
    expect(bundle.batch_receipt.engine_signature_onchain).toMatch(
      /^0x[0-9a-fA-F]{130}$/
    );

    // And it recovers to the engine address by rebuilding the on-chain
    // preimage from settlement.vault_deltas.
    const preimage = buildVaultPreimage(
      bundle.batch_receipt.batch_id,
      bundle.settlement.vault_deltas
    );
    const recovered = await recoverAddress({
      hash: preimage.hash as `0x${string}`,
      signature: bundle.batch_receipt.engine_signature_onchain,
    });
    expect(recovered.toLowerCase()).toBe(ENGINE_ADDR.toLowerCase());

    // Conservation invariants must hold on the on-chain integer form.
    const ethSum = preimage.ethDeltas.reduce((a, b) => a + b, 0n);
    const usdcSum = preimage.usdcDeltas.reduce((a, b) => a + b, 0n);
    expect(ethSum).toBe(0n);
    expect(usdcSum).toBe(0n);
  });

  it("omits engine_signature_onchain when there are no vault_deltas to settle", async () => {
    const { app } = await newApp();
    // No deposits, no intents -> close returns closed=false.
    const close = await app.inject({ method: "POST", url: "/batches/close" });
    const bundle = close.json();
    expect(bundle.ok).toBe(true);
    expect(bundle.closed).toBe(false);
    // No batch_receipt at all when nothing closed; sanity-check that's still
    // the v1 behavior (no crash, no field).
    expect(bundle.batch_receipt).toBeUndefined();
  });
});
