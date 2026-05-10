import { describe, it, expect } from "vitest";
import {
  mockDeposit,
  mockWithdraw,
  reserveForIntent,
  releaseReservation,
  applyVaultDeltas,
  assertVaultInvariants
} from "@shared/vault";
import { hashVaultState, hashReservationBook } from "@shared/crypto";
import type {
  VaultState,
  ReservationBook,
  SettlementObject
} from "@shared/schemas";
import { makeRng } from "./adversarial/seededRng";
import { randomIntent, getAddr } from "./adversarial/generators";

const ITERATIONS = 50;
const OPS_PER_RUN = 30;

describe("adversarial vault — random op sequences keep invariants", () => {
  it("50 random op sequences (30 ops each) never violate invariants", () => {
    for (let s = 1; s <= ITERATIONS; s++) {
      const rng = makeRng(s);
      let vault: VaultState = { agents: {} };
      let book: ReservationBook = { reservations: [] };

      // Seed deposits for first 4 agents.
      for (let a = 0; a < 4; a++) {
        const addr = getAddr(a);
        vault = mockDeposit(vault, addr, "ETH", "100");
        vault = mockDeposit(vault, addr, "USDC", "1000000");
      }

      try {
        assertVaultInvariants(vault, book);
      } catch (e) {
        throw new Error(`seed=${s}: initial state invalid: ${(e as Error).message}`);
      }

      const reservedIntents: { intent_id: string; agent_id: string; asset: "ETH" | "USDC"; amount: string }[] = [];

      for (let op = 0; op < OPS_PER_RUN; op++) {
        const choice = rng.nextInt(4);
        try {
          if (choice === 0) {
            // Reserve for a new intent.
            const agentIdx = rng.nextInt(4);
            const intent = randomIntent(rng, { agentIndex: agentIdx, intent_id: `intent_${s}_${op}` });
            const r = reserveForIntent(vault, book, intent.envelope, intent.payload, Date.now());
            if (r.ok) {
              vault = r.state;
              book = r.book;
              reservedIntents.push({
                intent_id: intent.envelope.intent_id,
                agent_id: r.reservation.agent_id,
                asset: r.reservation.asset,
                amount: r.reservation.amount
              });
            }
          } else if (choice === 1 && reservedIntents.length > 0) {
            // Release a random reservation.
            const idx = rng.nextInt(reservedIntents.length);
            const r = reservedIntents[idx]!;
            const status = rng.next() > 0.5 ? "RELEASED" : "SETTLED";
            const result = releaseReservation(vault, book, r.intent_id, status as "RELEASED" | "SETTLED");
            vault = result.state;
            book = result.book;
            reservedIntents.splice(idx, 1);
          } else if (choice === 2) {
            // Withdraw available.
            const agentIdx = rng.nextInt(4);
            const addr = getAddr(agentIdx);
            const asset: "ETH" | "USDC" = rng.next() > 0.5 ? "ETH" : "USDC";
            const w = mockWithdraw(vault, addr, asset, "0.5");
            if (w.ok) vault = w.state;
            // INSUFFICIENT_FUNDS or UNKNOWN_AGENT are normal — ignore.
          } else if (choice === 3) {
            // Deposit more.
            const agentIdx = rng.nextInt(4);
            const addr = getAddr(agentIdx);
            const asset: "ETH" | "USDC" = rng.next() > 0.5 ? "ETH" : "USDC";
            vault = mockDeposit(vault, addr, asset, "1");
          }
          assertVaultInvariants(vault, book);
        } catch (e) {
          throw new Error(`seed=${s} op=${op} choice=${choice}: ${(e as Error).message}`);
        }
      }
    }
    expect(true).toBe(true);
  });
});

describe("adversarial vault — withdraw cannot reach reserved", () => {
  it("100 random scenarios: mockWithdraw never reduces balance below reserved", () => {
    for (let s = 1; s <= 100; s++) {
      const rng = makeRng(s);
      const addr = getAddr(0);
      let vault: VaultState = { agents: {} };
      vault = mockDeposit(vault, addr, "ETH", "10");
      let book: ReservationBook = { reservations: [] };
      // Reserve some ETH.
      const intent = randomIntent(rng, { side: "SELL", agentIndex: 0, intent_id: `i_${s}` });
      const fixedPayload = { ...intent.payload, max_base_amount: "5", min_base_fill_amount: "1", allow_partial_fill: true };
      const r = reserveForIntent(vault, book, intent.envelope, fixedPayload, Date.now());
      if (!r.ok) continue;
      vault = r.state;
      book = r.book;
      // Try to withdraw various amounts.
      const amts = ["1", "5", "5.000000000000000001", "10", "100"];
      for (const amt of amts) {
        const w = mockWithdraw(vault, addr, "ETH", amt);
        if (w.ok) {
          // post-withdraw, reserved <= balances must hold.
          const av = w.state.agents[addr]!;
          if (parseFloat(av.balances.ETH) < parseFloat(av.reserved.ETH)) {
            throw new Error(`seed=${s} amt=${amt}: withdraw reached reserved`);
          }
        }
      }
    }
    expect(true).toBe(true);
  });
});

describe("adversarial vault — hash sensitivity", () => {
  it("hashReservationBook flips when status flips", () => {
    for (let s = 1; s <= 30; s++) {
      const rng = makeRng(s);
      const addr = getAddr(0);
      let vault: VaultState = { agents: {} };
      vault = mockDeposit(vault, addr, "ETH", "100");
      let book: ReservationBook = { reservations: [] };
      const intent = randomIntent(rng, { side: "SELL", agentIndex: 0, intent_id: `i_${s}` });
      const fixedPayload = { ...intent.payload, max_base_amount: "5", min_base_fill_amount: "1", allow_partial_fill: true };
      const r = reserveForIntent(vault, book, intent.envelope, fixedPayload, Date.now());
      if (!r.ok) continue;
      const h0 = hashReservationBook(r.book);
      const released = releaseReservation(r.state, r.book, intent.envelope.intent_id, "SETTLED");
      const h1 = hashReservationBook(released.book);
      if (h0 === h1) {
        throw new Error(`seed=${s}: hashReservationBook unchanged after RESERVED -> SETTLED`);
      }
    }
    expect(true).toBe(true);
  });

  it("hashVaultState flips when balance changes by 1 wei", () => {
    for (let s = 1; s <= 30; s++) {
      const addr = getAddr(s % 4);
      let vault: VaultState = { agents: {} };
      vault = mockDeposit(vault, addr, "ETH", "10");
      const h0 = hashVaultState(vault);
      vault = mockDeposit(vault, addr, "ETH", "0.000000000000000001");
      const h1 = hashVaultState(vault);
      if (h0 === h1) {
        throw new Error(`seed=${s}: hashVaultState unchanged after 1-wei deposit`);
      }
    }
    expect(true).toBe(true);
  });
});
