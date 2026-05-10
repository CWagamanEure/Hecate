import { describe, it, expect } from "vitest";
import {
  mockDeposit,
  reserveForIntent,
  releaseReservation,
  applyVaultDeltas,
  getAgentVault
} from "@shared/vault";
import {
  signEnvelope,
  hashPayload,
  privateKeyToAddress,
  hashReservationBook
} from "@shared/crypto";
import type {
  PrivatePayload,
  PublicEnvelopeUnsigned,
  ReservationBook,
  VaultState,
  SettlementObject
} from "@shared/schemas";

const PK = "0x" + "0".repeat(63) + "1";
const ADDR = privateKeyToAddress(PK);
const NOW = 1700000000000;

function sell(amount: string, nonce: string): PrivatePayload {
  return {
    side: "SELL",
    asset_in: "ETH",
    asset_out: "USDC",
    max_base_amount: amount,
    limit_price: "3580",
    allow_partial_fill: true,
    min_base_fill_amount: "1",
    deadline_batches: 3,
    max_price_impact_bps: 20,
    fallback_after_batches: null,
    nonce
  };
}

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

function reserveOne(
  state: VaultState,
  book: ReservationBook,
  amount: string,
  intent_id: string,
  nonce: string
): { state: VaultState; book: ReservationBook } {
  const p = sell(amount, nonce);
  const env = envFor(p, intent_id, nonce);
  const r = reserveForIntent(state, book, env, p, NOW);
  if (!r.ok) throw new Error(`reserve failed: ${r.code} ${r.detail}`);
  return { state: r.state, book: r.book };
}

const emptyBook: ReservationBook = { reservations: [] };

describe("releaseReservation", () => {
  it("RELEASED status clears full reservation; reserved goes to 0", () => {
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const { state, book } = reserveOne(s0, emptyBook, "10", "intent_001", "1");
    expect(getAgentVault(state, ADDR)!.reserved.ETH).toBe("10");

    const r = releaseReservation(state, book, "intent_001", "RELEASED");
    expect(getAgentVault(r.state, ADDR)!.reserved.ETH).toBe("0");
    expect(r.book.reservations[0]!.status).toBe("RELEASED");
  });

  it("SETTLED status also clears full reservation; status differs from RELEASED", () => {
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const { state, book } = reserveOne(s0, emptyBook, "10", "intent_001", "1");
    const r = releaseReservation(state, book, "intent_001", "SETTLED");
    expect(getAgentVault(r.state, ADDR)!.reserved.ETH).toBe("0");
    expect(r.book.reservations[0]!.status).toBe("SETTLED");
  });

  it("throws on unknown intent_id", () => {
    expect(() =>
      releaseReservation({ agents: {} }, emptyBook, "nope", "RELEASED")
    ).toThrow();
  });

  it("throws on already-released reservation", () => {
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const { state, book } = reserveOne(s0, emptyBook, "10", "intent_001", "1");
    const r = releaseReservation(state, book, "intent_001", "RELEASED");
    expect(() =>
      releaseReservation(r.state, r.book, "intent_001", "RELEASED")
    ).toThrow();
  });

  it("partial-fill flow: SELL 10 ETH filled 6 -> release SETTLED, deltas -6 ETH +21540 USDC", () => {
    // Reserve 10 ETH.
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const { state: s1, book: b1 } = reserveOne(s0, emptyBook, "10", "intent_001", "1");

    // Release the reservation as SETTLED (partial fill scenario).
    const released = releaseReservation(s1, b1, "intent_001", "SETTLED");
    expect(getAgentVault(released.state, ADDR)!.reserved.ETH).toBe("0");
    expect(getAgentVault(released.state, ADDR)!.balances.ETH).toBe("10"); // unchanged yet

    // Apply deltas: -6 ETH, +21540 USDC (clearing price 3590 × 6 = 21540).
    const settlement: SettlementObject = {
      batch_id: "batch_001",
      market: "ETH/USDC",
      clearing_price: "3590",
      fills: [
        {
          intent_id: "intent_001",
          agent_id: ADDR,
          base_delta: "-6",
          quote_delta: "21540"
        }
      ],
      vault_deltas: [
        { agent_id: ADDR, asset: "ETH", delta: "-6" },
        { agent_id: ADDR, asset: "USDC", delta: "21540" }
      ]
    };
    const final = applyVaultDeltas(released.state, settlement);
    const av = getAgentVault(final, ADDR)!;
    expect(av.balances.ETH).toBe("4");
    expect(av.balances.USDC).toBe("21540");
    expect(av.reserved.ETH).toBe("0");
    // reserved_released computation (engine-side, Ticket 11): 10 - 6 = 4 ETH released.
  });

  it("unfilled flow: full reservation released, no deltas applied", () => {
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const { state, book } = reserveOne(s0, emptyBook, "10", "intent_001", "1");
    const r = releaseReservation(state, book, "intent_001", "RELEASED");
    const av = getAgentVault(r.state, ADDR)!;
    expect(av.balances.ETH).toBe("10");
    expect(av.reserved.ETH).toBe("0");
  });
});

describe("applyVaultDeltas", () => {
  it("throws on negative resulting balance", () => {
    const s = mockDeposit({ agents: {} }, ADDR, "ETH", "5");
    const settlement: SettlementObject = {
      batch_id: "batch_001",
      market: "ETH/USDC",
      clearing_price: "3590",
      fills: [],
      vault_deltas: [{ agent_id: ADDR, asset: "ETH", delta: "-10" }]
    };
    expect(() => applyVaultDeltas(s, settlement)).toThrow();
  });

  it("throws on missing agent vault", () => {
    const settlement: SettlementObject = {
      batch_id: "batch_001",
      market: "ETH/USDC",
      clearing_price: "3590",
      fills: [],
      vault_deltas: [{ agent_id: ADDR, asset: "ETH", delta: "1" }]
    };
    expect(() => applyVaultDeltas({ agents: {} }, settlement)).toThrow();
  });
});

describe("hashReservationBook", () => {
  function makeBookSorted(): ReservationBook {
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "30");
    let s = s0;
    let b: ReservationBook = emptyBook;
    for (const [amt, id, n] of [
      ["1", "intent_001", "1"],
      ["1", "intent_002", "2"],
      ["1", "intent_003", "3"]
    ] as const) {
      const r = reserveOne(s, b, amt, id, n);
      s = r.state;
      b = r.book;
    }
    return b;
  }

  it("hash changes when a reservation status changes RESERVED -> SETTLED", () => {
    const s0 = mockDeposit({ agents: {} }, ADDR, "ETH", "10");
    const { state, book } = reserveOne(s0, emptyBook, "10", "intent_001", "1");
    const before = hashReservationBook(book);
    const after = hashReservationBook(
      releaseReservation(state, book, "intent_001", "SETTLED").book
    );
    expect(before).not.toBe(after);
  });

  it("is deterministic across reservation insertion order (defensive sort)", () => {
    const sorted = makeBookSorted();
    const reversed: ReservationBook = {
      reservations: [...sorted.reservations].reverse()
    };
    expect(hashReservationBook(sorted)).toBe(hashReservationBook(reversed));
  });
});
