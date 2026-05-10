import { describe, it, expect } from "vitest";
import { acceptIntent } from "@shared/matching";
import type {
  ReadyIntent,
  PendingIntent
} from "@shared/matching";
import {
  signEnvelope,
  hashPayload,
  privateKeyToAddress
} from "@shared/crypto";
import { mockDeposit } from "@shared/vault";
import type {
  PrivatePayload,
  PublicEnvelopeUnsigned,
  ReservationBook,
  VaultState,
  HexBytes
} from "@shared/schemas";

const PK = "0x" + "0".repeat(63) + "1";
const PK2 = "0x" + "0".repeat(63) + "2";
const ADDR = privateKeyToAddress(PK);
const ADDR2 = privateKeyToAddress(PK2);
const NOW = 1700000000000;
const FUTURE = NOW + 60_000;

const sellPayload = (overrides: Partial<PrivatePayload> = {}): PrivatePayload => ({
  side: "SELL",
  asset_in: "ETH",
  asset_out: "USDC",
  max_base_amount: "10",
  limit_price: "3580",
  allow_partial_fill: true,
  min_base_fill_amount: "3",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: null,
  nonce: "1",
  ...overrides
});

function envFor(
  p: PrivatePayload,
  intent_id: string,
  nonce: string,
  opts: { agent?: string; pk?: string; expiry_ms?: number; commitmentOverride?: string } = {}
) {
  const unsigned: PublicEnvelopeUnsigned = {
    intent_id,
    agent_id: opts.agent ?? ADDR,
    market: "ETH/USDC",
    expiry_ms: opts.expiry_ms ?? FUTURE,
    payload_commitment: (opts.commitmentOverride as `0x${string}`) ?? hashPayload(p),
    payload_ciphertext: "0xdeadbeef" as HexBytes,
    nonce
  };
  return signEnvelope(unsigned, opts.pk ?? PK);
}

const stubDecrypt = (p: PrivatePayload) => (_ct: HexBytes) => p;
const throwingDecrypt = (msg: string) => (_ct: HexBytes): PrivatePayload => {
  throw new Error(msg);
};

const emptyBook: ReservationBook = { reservations: [] };

describe("acceptIntent — happy paths", () => {
  it("valid funded SELL accepted; ready_intent populated; vault reserved", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready_intent.envelope).toBe(env);
      expect(r.ready_intent.payload).toEqual(p);
      expect(r.ready_intent.received_ms).toBe(NOW);
      expect(r.vault_state_after.agents[ADDR]!.reserved.ETH).toBe("10");
      expect(r.vault_state_after.agents[ADDR]!.nonces_seen).toEqual(["1"]);
      expect(r.reservation_book_after.reservations).toHaveLength(1);
    }
  });

  it("ready_intent.reservation_id === envelope.intent_id", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_special", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ready_intent.reservation_id).toBe("intent_special");
  });
});

describe("acceptIntent — rejections", () => {
  function expectReject(
    r: ReturnType<typeof acceptIntent>,
    code: string
  ) {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.reject_reason).toBe(code);
  }

  it("INVALID_SIGNATURE when signed by a different key", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    // Sign with PK2 but claim ADDR.
    const env = envFor(p, "intent_001", "1", { pk: PK2 });
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expectReject(r, "INVALID_SIGNATURE");
    if (!r.ok) {
      expect(r.vault_state_after).toBe(vault); // unchanged ref
      expect(r.reservation_book_after).toBe(emptyBook);
    }
  });

  it("EXPIRED when now_ms > expiry_ms", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1", { expiry_ms: NOW - 1000 });
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expectReject(r, "EXPIRED");
  });

  it("MALFORMED_PAYLOAD when decrypt throws", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: throwingDecrypt("bad ciphertext"),
      now_ms: NOW
    });
    expectReject(r, "MALFORMED_PAYLOAD");
    if (!r.ok) expect(r.rejected.detail).toContain("bad ciphertext");
  });

  it("INVALID_PAYLOAD_COMMITMENT when decrypted payload doesn't match envelope's commitment", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p1 = sellPayload({ max_base_amount: "10" });
    const p2 = sellPayload({ max_base_amount: "5" }); // different commitment
    // Envelope commits to p1, but decryptor returns p2.
    const env = envFor(p1, "intent_001", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p2),
      now_ms: NOW
    });
    expectReject(r, "INVALID_PAYLOAD_COMMITMENT");
  });

  it("UNKNOWN_AGENT when no vault entry exists", () => {
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: { agents: {} },
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expectReject(r, "UNKNOWN_AGENT");
  });

  it("DUPLICATE_NONCE when nonce already in nonces_seen", () => {
    let vault: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "20");
    let book: ReservationBook = emptyBook;
    const p1 = sellPayload({ max_base_amount: "5", nonce: "1" });
    const env1 = envFor(p1, "intent_001", "1");
    const r1 = acceptIntent({
      pendingIntent: { envelope: env1, received_ms: NOW },
      vaultState: vault,
      reservationBook: book,
      decrypt: stubDecrypt(p1),
      now_ms: NOW
    });
    if (r1.ok) {
      vault = r1.vault_state_after;
      book = r1.reservation_book_after;
    }
    const p2 = sellPayload({ max_base_amount: "5", nonce: "1" });
    const env2 = envFor(p2, "intent_002", "1");
    const r2 = acceptIntent({
      pendingIntent: { envelope: env2, received_ms: NOW + 1 },
      vaultState: vault,
      reservationBook: book,
      decrypt: stubDecrypt(p2),
      now_ms: NOW + 1
    });
    expectReject(r2, "DUPLICATE_NONCE");
  });

  it("INSUFFICIENT_FUNDS when reservation would exceed available", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "5");
    const p = sellPayload({ max_base_amount: "10" });
    const env = envFor(p, "intent_001", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expectReject(r, "INSUFFICIENT_FUNDS");
  });
});

describe("acceptIntent — nonce marking semantics", () => {
  it("INSUFFICIENT_FUNDS does NOT mark nonce; retry after top-up succeeds", () => {
    let vault: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "5");
    const p = sellPayload({ max_base_amount: "10", nonce: "42" });
    const env = envFor(p, "intent_001", "42");
    const r1 = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r1.ok).toBe(false);

    // Top up; same envelope retries successfully.
    vault = mockDeposit(vault, ADDR, "ETH", "10");
    const r2 = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.vault_state_after.agents[ADDR]!.nonces_seen).toEqual(["42"]);
    }
  });

  it("accepted intent marks nonce; subsequent same-nonce submission fails DUPLICATE_NONCE", () => {
    let vault: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "20");
    let book: ReservationBook = emptyBook;
    const p = sellPayload({ max_base_amount: "5", nonce: "7" });
    const env = envFor(p, "intent_001", "7");
    const r1 = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: book,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      vault = r1.vault_state_after;
      book = r1.reservation_book_after;
    }
    const env2 = envFor(p, "intent_002", "7");
    const r2 = acceptIntent({
      pendingIntent: { envelope: env2, received_ms: NOW + 1 },
      vaultState: vault,
      reservationBook: book,
      decrypt: stubDecrypt(p),
      now_ms: NOW + 1
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.rejected.reject_reason).toBe("DUPLICATE_NONCE");
  });
});

describe("acceptIntent — purity", () => {
  it("does not mutate input vault or reservation book on success", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const beforeVault = JSON.stringify(vault);
    const beforeBook = JSON.stringify(emptyBook);
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1");
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(vault)).toBe(beforeVault);
    expect(JSON.stringify(emptyBook)).toBe(beforeBook);
    if (r.ok) {
      expect(r.vault_state_after).not.toBe(vault); // new object
    }
  });

  it("on rejection returns input refs unchanged", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1", { pk: PK2 }); // bad sig
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.vault_state_after).toBe(vault);
      expect(r.reservation_book_after).toBe(emptyBook);
    }
  });
});

describe("acceptIntent — compound failure detail", () => {
  it("INVALID_SIGNATURE wins over EXPIRED but detail includes both", () => {
    const vault = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1", { pk: PK2, expiry_ms: NOW - 1000 });
    const r = acceptIntent({
      pendingIntent: { envelope: env, received_ms: NOW },
      vaultState: vault,
      reservationBook: emptyBook,
      decrypt: stubDecrypt(p),
      now_ms: NOW
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejected.reject_reason).toBe("INVALID_SIGNATURE");
      expect(r.rejected.detail).toContain("INVALID_SIGNATURE");
      expect(r.rejected.detail).toContain("EXPIRED");
    }
  });
});
