/**
 * Targeted tests for previously-uncovered branches identified by `vitest --coverage`.
 *
 * Focus areas:
 *   - server/routes/verify.ts schema-rejection branch
 *   - server/routes/intents.ts REJECTED-status path (both ok and 403 sub-branches)
 *   - server/routes/vault.ts mock-withdraw zero-amount throw catch
 *   - shared/vault/reservations.ts releaseReservation defensive throws
 *   - shared/crypto/signing.ts v=0/1 acceptance
 *   - shared/verify/verifyEngine.ts BUILD_FILL_RECEIPT_THREW path
 */

import { describe, it, expect, afterAll } from "vitest";
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
  signChallenge
} from "./serverFixture";
import { releaseReservation, mockDeposit, reserveForIntent } from "@shared/vault";
import {
  signEnvelope,
  hashPayload,
  privateKeyToAddress,
  signHash,
  recoverHashSigner,
  hashFillReceiptBody
} from "@shared/crypto";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { verifyFillReceipt } from "@shared/verify";
import type {
  PrivatePayload,
  PublicEnvelopeUnsigned,
  ReservationBook,
  VaultState,
  FillReceipt,
  FillPlan,
  BatchInput
} from "@shared/schemas";

afterAll(cleanupTempDirs);

describe("coverage — POST /receipts/verify schema rejection branch", () => {
  it("malformed verify body -> 400 INVALID_REQUEST", async () => {
    const { app } = await newApp();
    const r = await app.inject({
      method: "POST",
      url: "/receipts/verify",
      payload: { not: "a verify request" }
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INVALID_REQUEST");
  });
});

describe("coverage — /intents/:id/status REJECTED path", () => {
  async function setupRejectedIntent() {
    const { app } = await newApp();
    // No deposit -> insufficient funds rejection.
    const env = makeEnvelope({
      intent_id: "intent_rej",
      agent_id: ADDR_A,
      pk: PK_A,
      payload: sellPayload({ base: "10", limit: "3580" })
    });
    const r = await app.inject({ method: "POST", url: "/intents", payload: env });
    expect(r.statusCode).toBe(400);
    return { app };
  }

  it("owner sees REJECTED status with reject_reason and detail", async () => {
    const { app } = await setupRejectedIntent();
    const c = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_rej",
      pk: PK_A
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_rej/status",
      payload: c
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.status).toBe("REJECTED");
    expect(body.reject_reason).toBeDefined();
    expect(body.detail).toBeDefined();
  });

  it("non-owner cannot read REJECTED intent status -> 403 NOT_INTENT_OWNER", async () => {
    const { app } = await setupRejectedIntent();
    const c = signChallenge({
      action: "GET_INTENT_STATUS",
      intent_id: "intent_rej",
      pk: PK_B
    });
    const r = await app.inject({
      method: "POST",
      url: "/intents/intent_rej/status",
      payload: c
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("NOT_INTENT_OWNER");
  });
});

describe("coverage — vault routes", () => {
  it("mock-withdraw with amount=0 -> 400 INVALID_AMOUNT", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" }
    });
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "0" }
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INVALID_AMOUNT");
  });

  it("successful mock-withdraw -> 200, vault updated", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "5" }
    });
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "2" }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().vault.balances.ETH).toBe("3");
  });

  it("mock-withdraw exact-available boundary succeeds and leaves zero balance", async () => {
    const { app } = await newApp();
    await app.inject({
      method: "POST",
      url: "/vault/mock-deposit",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    const r = await app.inject({
      method: "POST",
      url: "/vault/mock-withdraw",
      payload: { agent_id: ADDR_A, asset: "ETH", amount: "10" }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().vault.balances.ETH).toBe("0");
  });
});

describe("coverage — releaseReservation defensive paths", () => {
  it("release on unknown intent_id throws", () => {
    const v: VaultState = { agents: {} };
    const b: ReservationBook = { reservations: [] };
    expect(() => releaseReservation(v, b, "nope", "RELEASED")).toThrow();
  });

  it("release on already-released reservation throws", () => {
    const addr = privateKeyToAddress("0x" + "0".repeat(63) + "1");
    let v: VaultState = mockDeposit({ agents: {} }, addr, "ETH", "10");
    let b: ReservationBook = { reservations: [] };

    const p: PrivatePayload = {
      side: "SELL",
      asset_in: "ETH",
      asset_out: "USDC",
      max_base_amount: "5",
      limit_price: "3580",
      allow_partial_fill: true,
      min_base_fill_amount: "1",
      deadline_batches: 3,
      max_price_impact_bps: 10000,
      fallback_after_batches: null,
      nonce: "1"
    };
    const u: PublicEnvelopeUnsigned = {
      intent_id: "intent_x",
      agent_id: addr,
      market: "ETH/USDC",
      expiry_ms: Date.now() + 60_000,
      payload_commitment: hashPayload(p),
      payload_ciphertext: "0xdead",
      nonce: p.nonce
    };
    const env = signEnvelope(u, "0x" + "0".repeat(63) + "1");
    const r = reserveForIntent(v, b, env, p, Date.now());
    if (r.ok) {
      v = r.state;
      b = r.book;
    }
    const r1 = releaseReservation(v, b, "intent_x", "RELEASED");
    expect(() => releaseReservation(r1.state, r1.book, "intent_x", "RELEASED")).toThrow();
  });
});

describe("coverage — signing v-byte tolerance both branches", () => {
  it("v=0 signature recovers correctly", () => {
    const pk = "0x" + "0".repeat(63) + "1";
    const hash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const sig = signHash(hash, pk);
    const sigBytes = hexToBytes(sig.slice(2));
    const v = sigBytes[64]!;
    sigBytes[64] = v - 27; // -> 0 or 1
    const tweaked = ("0x" + bytesToHex(sigBytes)) as `0x${string}`;
    expect(recoverHashSigner(hash, tweaked)).toBe(privateKeyToAddress(pk));
  });

  it("v=99 signature throws", () => {
    const pk = "0x" + "0".repeat(63) + "1";
    const hash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const sig = signHash(hash, pk);
    const sigBytes = hexToBytes(sig.slice(2));
    sigBytes[64] = 99;
    const bad = ("0x" + bytesToHex(sigBytes)) as `0x${string}`;
    expect(() => recoverHashSigner(hash, bad)).toThrow();
  });
});

describe("coverage — verifier BUILD_FILL_RECEIPT_THREW path", () => {
  it("missing reservation triggers BUILD_FILL_RECEIPT_THREW inside verifyFillReceipt", () => {
    // Construct a FillReceipt for an intent that exists in batch + fillPlan but
    // is missing from reservationBookBeforeSettlement. buildFillReceiptBodies
    // throws "no reservation for intent" -> verifier wraps as BUILD_FILL_RECEIPT_THREW.
    const ENGINE_PK = "0x" + "0".repeat(63) + "1";
    const ENGINE_ADDR = privateKeyToAddress(ENGINE_PK);
    const PK = "0x" + "0".repeat(63) + "2";
    const ADDR = privateKeyToAddress(PK);
    const p: PrivatePayload = {
      side: "SELL",
      asset_in: "ETH",
      asset_out: "USDC",
      max_base_amount: "5",
      limit_price: "3580",
      allow_partial_fill: true,
      min_base_fill_amount: "1",
      deadline_batches: 3,
      max_price_impact_bps: 10000,
      fallback_after_batches: null,
      nonce: "1"
    };
    const u: PublicEnvelopeUnsigned = {
      intent_id: "intent_x",
      agent_id: ADDR,
      market: "ETH/USDC",
      expiry_ms: Date.now() + 60_000,
      payload_commitment: hashPayload(p),
      payload_ciphertext: "0xdead",
      nonce: p.nonce
    };
    const env = signEnvelope(u, PK);
    const batch: BatchInput = {
      batch_id: "batch_x",
      market: "ETH/USDC",
      intents: [{ envelope: env, payload: p }],
      market_snapshot: null,
      timestamp_ms: 1
    };
    const fp: FillPlan = {
      clearing_price: "0",
      fills: [
        {
          intent_id: "intent_x",
          filled_base: "0",
          filled_quote: "0",
          status: "UNFILLED",
          unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
        }
      ]
    };
    // Construct a fake FillReceipt (correctly signed by engine) so the signature
    // check passes; the recompute-builder will then throw because there's no
    // reservation in book.
    const body = {
      intent_id: "intent_x",
      batch_id: "batch_x",
      agent_id: ADDR,
      status: "UNFILLED" as const,
      filled_base: "0",
      filled_quote: "0",
      clearing_price: "0",
      constraints_satisfied: true,
      unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" as const,
      payload_commitment: hashPayload(p),
      reserved_released: { ETH: "0", USDC: "0" },
      runtime: {
        runtime_mode: "LOCAL_MOCK" as const,
        engine_code_digest: "sha256:test",
        eigencompute_app_id: null,
        eigencompute_image_digest: null,
        eigencompute_attestation_id: null
      }
    };
    const fr: FillReceipt = {
      ...body,
      engine_signature: signHash(hashFillReceiptBody(body), ENGINE_PK)
    };
    const r = verifyFillReceipt({
      receipt: fr,
      batch,
      fillPlan: fp,
      reservationBookBeforeSettlement: { reservations: [] }, // empty -> throws
      expectedEngineAddress: ENGINE_ADDR
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures.map((f) => f.code)).toContain("BUILD_FILL_RECEIPT_THREW");
    }
  });
});
