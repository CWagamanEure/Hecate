import { describe, it, expect, afterAll } from "vitest";
import { validateSettleBundle, type SettleBundle } from "../scripts/onchain-settle";
import { buildVaultPreimage } from "@shared/vault/settlementSigner";
import { recoverHashSigner, privateKeyToAddress } from "@shared/crypto";
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

afterAll(cleanupTempDirs);

function validBundle(): SettleBundle {
  return {
    batchReceipt: {
      batch_id: "batch_test_001",
      engine_signature_onchain:
        "0x" + "ab".repeat(64) + "1c", // 130 hex chars; shape-valid for the check.
    },
    settlement: {
      batch_id: "batch_test_001",
      vault_deltas: [
        { agent_id: "0x1111111111111111111111111111111111111111", asset: "ETH", delta: "-1" },
        { agent_id: "0x2222222222222222222222222222222222222222", asset: "ETH", delta: "1" },
      ],
    },
    expectedEngineAddress: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  };
}

describe("validateSettleBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(() => validateSettleBundle(validBundle())).not.toThrow();
  });

  it("rejects a bundle missing engine_signature_onchain", () => {
    const b = validBundle();
    delete (b.batchReceipt as Record<string, unknown>).engine_signature_onchain;
    expect(() => validateSettleBundle(b, "test")).toThrow(
      /engine_signature_onchain is required/
    );
  });

  it("rejects a bundle with empty vault_deltas", () => {
    const b = validBundle();
    (b.settlement as unknown as { vault_deltas: unknown[] }).vault_deltas = [];
    expect(() => validateSettleBundle(b, "test")).toThrow(/vault_deltas is empty/);
  });

  it("rejects a bundle where settlement.batch_id != batchReceipt.batch_id", () => {
    const b = validBundle();
    (b.settlement as { batch_id: string }).batch_id = "different-batch";
    expect(() => validateSettleBundle(b, "test")).toThrow(/batch_id mismatch/);
  });

  it("error messages include the supplied context name", () => {
    const b = validBundle();
    delete (b.batchReceipt as Record<string, unknown>).engine_signature_onchain;
    expect(() => validateSettleBundle(b, "my-bundle.json")).toThrow(
      /my-bundle\.json/
    );
  });
});

describe("onchain-settle integration: bundle from real server -> rebuilt preimage", () => {
  it("a server-produced bundle's vault_deltas reconstruct the same hash + recover to engine", async () => {
    // This is the contract between V2 stage 1 (engine signs) and V6c
    // (script rebuilds). If they ever diverge, the on-chain settleBatch
    // would revert "bad signer" and the demo would silently fail.
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" },
    });
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_B, asset: "USDC", amount: "20000" },
    });
    const ea = makeEnvelope({
      intent_id: "intent_A",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: sellPayload({ base: "1", limit: "3580" }),
    });
    const eb = makeEnvelope({
      intent_id: "intent_B",
      agent_id: ADDR_B,
      pk: PK_B,
      payload: buyPayload({ base: "1", limit: "3610" }),
    });
    await app.inject({ method: "POST", url: "/intents", payload: ea });
    await app.inject({ method: "POST", url: "/intents", payload: eb });
    const close = await app.inject({ method: "POST", url: "/batches/close" });
    const bundle = close.json();
    expect(bundle.ok).toBe(true);
    expect(bundle.batch_receipt.engine_signature_onchain).toBeDefined();

    // Rebuild via the SAME function the engine used (V2 stage 1) and the
    // V6c script uses. Validates the engine signed and the script can
    // re-derive the same preimage.
    const rebuilt = buildVaultPreimage(
      bundle.batch_receipt.batch_id,
      bundle.settlement.vault_deltas
    );
    const recovered = recoverHashSigner(
      rebuilt.hash,
      bundle.batch_receipt.engine_signature_onchain
    );
    const engineAddr = privateKeyToAddress(ENGINE_PK as `0x${string}`);
    expect(recovered.toLowerCase()).toBe(engineAddr.toLowerCase());

    // The settle script would also synthesize the SettleBundle shape and
    // pass validation cleanly.
    const settleBundle: SettleBundle = {
      batchReceipt: {
        batch_id: bundle.batch_receipt.batch_id,
        engine_signature_onchain: bundle.batch_receipt.engine_signature_onchain,
      },
      settlement: {
        batch_id: bundle.settlement.batch_id,
        vault_deltas: bundle.settlement.vault_deltas,
      },
      expectedEngineAddress: engineAddr,
    };
    expect(() => validateSettleBundle(settleBundle, "test")).not.toThrow();
  });
});
