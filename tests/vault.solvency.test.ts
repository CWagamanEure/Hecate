import { describe, it, expect } from "vitest";
import {
  mockDeposit,
  reserveForIntent,
  requiredSpend,
  getAgentVault
} from "@shared/vault";
import { signEnvelope, hashPayload, privateKeyToAddress } from "@shared/crypto";
import type {
  PrivatePayload,
  PublicEnvelopeUnsigned,
  ReservationBook,
  VaultState
} from "@shared/schemas";

const PK = "0x" + "0".repeat(63) + "1";
const ADDR = privateKeyToAddress(PK);
const NOW = 1700000000000;

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

const buyPayload = (overrides: Partial<PrivatePayload> = {}): PrivatePayload => ({
  side: "BUY",
  asset_in: "USDC",
  asset_out: "ETH",
  max_base_amount: "4",
  limit_price: "3610",
  allow_partial_fill: true,
  min_base_fill_amount: "1",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: null,
  nonce: "1",
  ...overrides
});

function envFor(p: PrivatePayload, intent_id: string, nonce: string) {
  const unsigned: PublicEnvelopeUnsigned = {
    intent_id,
    agent_id: ADDR,
    market: "ETH/USDC",
    expiry_ms: NOW + 60_000,
    payload_commitment: hashPayload(p),
    payload_ciphertext: "0xdeadbeef",
    nonce
  };
  return signEnvelope(unsigned, PK);
}

const emptyBook: ReservationBook = { reservations: [] };

describe("requiredSpend", () => {
  it("SELL reserves max_base_amount of ETH", () => {
    expect(requiredSpend(sellPayload({ max_base_amount: "10" }))).toEqual({
      asset: "ETH",
      amount: "10"
    });
  });

  it("BUY reserves max_base_amount * limit_price of USDC (ceiling)", () => {
    expect(requiredSpend(buyPayload({ max_base_amount: "4", limit_price: "3610" }))).toEqual({
      asset: "USDC",
      amount: "14440"
    });
  });

  it("BUY ceiling rounds up sub-wei products", () => {
    const r = requiredSpend(
      buyPayload({ max_base_amount: "0.5", limit_price: "3610.99" })
    );
    expect(r.amount).toBe("1805.495");
  });
});

describe("reserveForIntent — happy path", () => {
  it("funded SELL reserves ETH and adds nonce", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1");
    const r = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const av = getAgentVault(r.state, ADDR)!;
      expect(av.reserved.ETH).toBe("10");
      expect(av.balances.ETH).toBe("10");
      expect(av.nonces_seen).toEqual(["1"]);
      expect(r.book.reservations).toHaveLength(1);
      expect(r.reservation.asset).toBe("ETH");
      expect(r.reservation.amount).toBe("10");
      expect(r.reservation.status).toBe("RESERVED");
    }
  });

  it("funded BUY reserves USDC", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "USDC", "20000");
    const p = buyPayload();
    const env = envFor(p, "intent_001", "1");
    const r = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const av = getAgentVault(r.state, ADDR)!;
      expect(av.reserved.USDC).toBe("14440");
    }
  });
});

describe("reserveForIntent — failures", () => {
  it("UNKNOWN_AGENT for missing agent", () => {
    const p = sellPayload();
    const env = envFor(p, "intent_001", "1");
    const r = reserveForIntent({ agents: {} }, emptyBook, env, p, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_AGENT");
  });

  it("INSUFFICIENT_FUNDS for under-funded SELL", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "ETH", "5");
    const p = sellPayload({ max_base_amount: "10" });
    const env = envFor(p, "intent_001", "1");
    const r = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("INSUFFICIENT_FUNDS for under-funded BUY", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "USDC", "10000");
    const p = buyPayload({ max_base_amount: "4", limit_price: "3610" });
    const env = envFor(p, "intent_001", "1");
    const r = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("DUPLICATE_NONCE for same nonce twice", () => {
    let s: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "20");
    let book: ReservationBook = emptyBook;
    const p1 = sellPayload({ max_base_amount: "5", nonce: "1" });
    const env1 = envFor(p1, "intent_001", "1");
    const r1 = reserveForIntent(s, book, env1, p1, NOW);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      s = r1.state;
      book = r1.book;
    }
    const p2 = sellPayload({ max_base_amount: "5", nonce: "1" });
    const env2 = envFor(p2, "intent_002", "1");
    const r2 = reserveForIntent(s, book, env2, p2, NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("DUPLICATE_NONCE");
  });

  it("INSUFFICIENT_FUNDS does NOT mark nonce (retry with funds works)", () => {
    let s: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "5");
    const p = sellPayload({ max_base_amount: "10", nonce: "42" });
    const env = envFor(p, "intent_001", "42");
    const r1 = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r1.ok).toBe(false);

    // Top up and retry with the same nonce.
    s = mockDeposit(s, ADDR, "ETH", "10");
    const r2 = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r2.ok).toBe(true);
  });
});

describe("reserveForIntent — multi-intent and exact-balance", () => {
  it("two intents accumulate reserved", () => {
    let s: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "20");
    let book: ReservationBook = emptyBook;
    const p1 = sellPayload({ max_base_amount: "10", nonce: "1" });
    const env1 = envFor(p1, "intent_001", "1");
    const r1 = reserveForIntent(s, book, env1, p1, NOW);
    if (r1.ok) {
      s = r1.state;
      book = r1.book;
    }
    const p2 = sellPayload({ max_base_amount: "10", nonce: "2" });
    const env2 = envFor(p2, "intent_002", "2");
    const r2 = reserveForIntent(s, book, env2, p2, NOW);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      const av = getAgentVault(r2.state, ADDR)!;
      expect(av.reserved.ETH).toBe("20");
      expect(r2.book.reservations).toHaveLength(2);
      // sorted by intent_id
      expect(r2.book.reservations.map((x) => x.intent_id)).toEqual([
        "intent_001",
        "intent_002"
      ]);
    }
  });

  it("second intent rejected when first consumed all funds", () => {
    let s: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    let book: ReservationBook = emptyBook;
    const p1 = sellPayload({ max_base_amount: "10", nonce: "1" });
    const env1 = envFor(p1, "intent_001", "1");
    const r1 = reserveForIntent(s, book, env1, p1, NOW);
    if (r1.ok) {
      s = r1.state;
      book = r1.book;
    }
    const p2 = sellPayload({ max_base_amount: "1", nonce: "2" });
    const env2 = envFor(p2, "intent_002", "2");
    const r2 = reserveForIntent(s, book, env2, p2, NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("exact-balance reservation accepted", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const p = sellPayload({ max_base_amount: "10" });
    const env = envFor(p, "intent_001", "1");
    const r = reserveForIntent(s, emptyBook, env, p, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const av = getAgentVault(r.state, ADDR)!;
      expect(av.reserved.ETH).toBe("10");
      expect(av.balances.ETH).toBe("10"); // available is now 0
    }
  });

  it("nonces_seen stays sorted across multiple reservations", () => {
    let s: VaultState = mockDeposit({ agents: {} }, ADDR, "ETH", "30");
    let book: ReservationBook = emptyBook;
    for (const n of ["3", "1", "2"]) {
      const p = sellPayload({ max_base_amount: "1", nonce: n });
      const env = envFor(p, `intent_${n}`, n);
      const r = reserveForIntent(s, book, env, p, NOW);
      if (r.ok) {
        s = r.state;
        book = r.book;
      }
    }
    expect(getAgentVault(s, ADDR)!.nonces_seen).toEqual(["1", "2", "3"]);
  });
});
