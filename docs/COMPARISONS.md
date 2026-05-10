# Hecate vs Existing Market Structures

This document situates Hecate against five reference systems: CoW Protocol, UniswapX, Sorella/Angstrom, Shutter, and Renegade. The intent is **honest positioning**, not competitive marketing. Hecate is not better than these systems on their own terms; it occupies a different point in the design space.

If you are choosing between Hecate and any of these systems for a real workload, the comparison below should help you pick the right tool. In most cases, that tool is not Hecate.

---

## 1. Reference axes

We compare each system across:

- **Primary use case** — what the system is built for.
- **Pre-match leakage** — what a third party (operator, solver, filler, observer) can learn about an order *before* it is matched.
- **Confidentiality mechanism** — the technical primitive providing whatever confidentiality the system claims.
- **Expressiveness for rich constraints** — how easily the system handles `min_fill_amount`, `fallback_after_batches`, `max_price_impact_bps`, and similar policy-bearing fields.
- **Trust assumption** — what you must trust for the confidentiality property to hold.
- **Where Hecate diverges** — the specific design choice that makes Hecate not a clone.

---

## 2. CoW Protocol

| Axis | CoW Protocol |
|---|---|
| Primary use case | Best-execution swap auctions with solver competition and coincidence-of-wants. |
| Pre-match leakage | Solvers see the full order set in order to bid on batches. Constraints and sizes are visible to every solver in the auction. |
| Confidentiality mechanism | None during matching. Some mitigations exist around order propagation timing but the order content is fundamentally available to solvers. |
| Expressiveness | Strong for swap-shaped orders. Less natural for programmable per-intent constraints (`min_fill_amount`, fallback rules) — those would need to be encoded as additional order types. |
| Trust assumption | Trust the solver auction process and the protocol's batch-construction logic. |

**Where Hecate diverges:** Hecate has no solver pool. The matcher is the attested binary; constraints reach it and nothing else. The cost is a loss of solver competition (CoW's primary value driver). The benefit is that an autonomous agent's `min_fill_amount` or `fallback_after_batches` is not advertised to a competitive market for inspection.

**When CoW is the right tool:** ordinary swap UX, coincidence-of-wants benefits matter more than constraint privacy, and you want to leverage a mature solver ecosystem. **Use CoW**, not Hecate.

---

## 3. UniswapX

| Axis | UniswapX |
|---|---|
| Primary use case | Off-chain signed Dutch-auction orders, filled by competing fillers. |
| Pre-match leakage | Fillers see the full order to price and fill it. The order's price decay path and constraints are necessarily visible to the filler pool. |
| Confidentiality mechanism | None during matching. |
| Expressiveness | Strong for time-decaying swap orders. Programmable constraints beyond price decay are not the system's focus. |
| Trust assumption | Trust the filler pool to compete; trust the protocol's signed-order verification. |

**Where Hecate diverges:** Hecate replaces "competing fillers see all" with "attested enclave deterministically clears." Fewer fillers (zero, in v1), less price competition, less pre-match leakage of constraints. Hecate is also not Dutch-auction-shaped — it does uniform-clearing batch matching, not time-decayed pricing.

**When UniswapX is the right tool:** swap orders that benefit from filler competition, especially against AMM liquidity. **Use UniswapX**, not Hecate.

---

## 4. Sorella / Angstrom

| Axis | Angstrom |
|---|---|
| Primary use case | Application-specific sequencing on AMMs to redistribute MEV to LPs. |
| Pre-match leakage | Some sequencing-time guarantees against MEV; execution against AMM curves is fundamentally public. |
| Confidentiality mechanism | Sequencing-level mechanisms (batched ordering, MEV-redistribution rules); not constraint-level confidentiality. |
| Expressiveness | Targets AMM swaps; not designed for P2P constraint-rich intents. |
| Trust assumption | Trust the application-specific sequencer. |

**Where Hecate diverges:** Hecate is not AMM-adjacent. There is no liquidity curve in v1; price comes from limit-order intersection between agent intents. Hecate also does not target MEV redistribution — its target is constraint confidentiality.

**When Angstrom is the right tool:** MEV-aware AMM swap execution where LPs should receive more of the value extracted by sequencing. **Use Angstrom**, not Hecate.

---

## 5. Shutter / threshold encryption

| Axis | Shutter |
|---|---|
| Primary use case | Encrypts transaction contents until a designated decryption point, mitigating front-running and ordering-time MEV. |
| Pre-match leakage | Transaction contents are hidden until the decryption point (usually after ordering/inclusion commitments). After decryption, execution semantics are public. |
| Confidentiality mechanism | Threshold encryption with a keyper committee. |
| Expressiveness | The transaction is a normal transaction; constraints execute in public state once revealed. Programmable per-intent matching logic must run in public smart contracts after decryption. |
| Trust assumption | Trust an honest majority of keypers. |

**Where Hecate diverges:** Shutter hides transaction contents until the decryption point, usually after ordering/inclusion commitments. After decryption, execution semantics — including any per-intent matching logic encoded in a smart contract — are public. Shutter therefore protects *ordering-time visibility*, while Hecate evaluates private matching constraints *inside the matcher itself*, so values like `min_fill_amount` and `fallback_after_batches` never appear in public state. The cost is the TEE trust assumption versus Shutter's threshold-honest-majority assumption.

**When Shutter is the right tool:** ordering-time MEV protection for normal transactions, and you accept that execution semantics are public. **Use Shutter**, not Hecate.

A future hybrid using TEE plus threshold encryption is listed as future work — it would let the enclave be one of several decryption participants, raising the bar for confidentiality breach.

---

## 6. Renegade / MPC + ZK dark pool

| Axis | Renegade |
|---|---|
| Primary use case | Cryptographically private swap-shaped order matching. |
| Pre-match leakage | Cryptographically minimized — orders are committed and matched without revealing contents to counterparties or operators. |
| Confidentiality mechanism | MPC for matching, ZK for proofs of state transitions. |
| Expressiveness | Strong for swap-shaped orders. Programmable constraints beyond swap-shape are heavier to encode in MPC/ZK and not the focus of v1 designs. |
| Trust assumption | Cryptographic — much weaker trust than TEE. |

**Where Hecate diverges:** Renegade's cryptographic privacy is strictly stronger than Hecate's TEE-based confidentiality. The tradeoff is expressiveness, latency, and engineering complexity. Hecate accepts a stronger trust assumption (the TEE) in exchange for being able to evaluate richer constraints (`fallback_after_batches`, `max_price_impact_bps`) at low latency without specialized cryptographic circuits.

**When Renegade is the right tool:** when you need cryptographic privacy guarantees for swap-shaped orders and you accept the operational complexity. **Use Renegade**, not Hecate.

---

## 7. Side-by-side summary

| | CoW | UniswapX | Angstrom | Shutter | Renegade | **Hecate** |
|---|---|---|---|---|---|---|
| Pre-match constraint privacy | None | None | Partial (sequencing) | Until decryption | Cryptographic | **TEE-mediated** |
| Solver/filler exposure | Full | Full | N/A | N/A (no solvers) | None | **None (v1)** |
| Constraint expressiveness | Medium | Medium | Low (AMM-shaped) | High (post-decryption, but public) | Medium (MPC cost) | **High** |
| Trust assumption | Solver pool + protocol | Filler pool + protocol | Sequencer | Honest-majority keypers | Cryptographic | **TEE platform + attestation** |
| Strategy privacy over time | None | None | None | None | Stronger | **None** |
| MEV resistance | Partial | Partial (Dutch auction) | Strong (redistribution) | Ordering-only | Strong | **Out of scope** |
| Liveness model | Solver-dependent | Filler-dependent | Sequencer-dependent | Keyper-dependent | Operator + circuits | **Operator + enclave** |
| Maturity | Production | Production | Production | Production | Mainnet (limited) | **Research/MVP** |

---

## 8. Where Hecate is uniquely positioned

Hecate is the most useful when **all** of the following are true:

- The submitter is an autonomous agent, not a human user.
- The agent's policy is encoded in execution constraints (limit, partial-fill, min fill, deadlines, fallbacks, max impact) richer than a plain swap.
- Pre-match inspection of those constraints by operators, solvers, or unmatched counterparties is the binding privacy concern — not on-chain execution-time inspection or long-term flow inference.
- The TEE trust assumption is acceptable.
- Rich expressiveness and low latency matter more than cryptographic privacy guarantees.

If any of the above is false, one of the other systems above is probably a better fit.

---

## 9. What Hecate explicitly does not claim

- That it is "better than CoW" or any other system. Better at *one specific class of leakage*, worse on most other axes.
- That it provides cryptographic privacy. The TEE is a trust assumption, not a cryptographic guarantee.
- That it solves MEV, executed-flow inference, behavioral fingerprinting, or strategy privacy over time. See `THREAT_MODEL.md` §4.
- That the v1 LOCAL_MOCK runtime provides any real confidentiality. It models the architecture; it does not enforce it.
- That a TEE-based approach is the right answer for production. It is a useful design point worth exploring; production systems often need stronger guarantees and would benefit from the future hybrid (TEE + threshold encryption) sketched in `TECHNICAL_PAPER.md` §17.
- That binding limit prices remain hidden after execution. The clearing price is published in every batch receipt. When it equals one party's binding limit, that limit may be inferable from public batch outputs. Hecate mitigates pre-match inspection of private payloads; it does not guarantee that all private constraints remain hidden after execution.

---

## 10. Anti-FAQ

**Q: Why not just use CoW with private orderflow auctions?**
A: CoW's value is solver competition over a shared order set. Private orderflow auctions help with batch attribution and revenue, but constraints still reach solvers. Hecate's claim is specifically about preventing constraints from reaching *anyone* other than the attested matcher.

**Q: Why TEE and not ZK?**
A: ZK is stronger but is currently expensive for programmable matching with rich constraints. Hecate trades cryptographic strength for expressiveness and latency, and is honest about that trade. A future ZK or hybrid version is interesting; v1 is intentionally TEE-only.

**Q: If executed flow leaks, what's the point?**
A: Pre-match leakage is a different and additive surface. An adversary that sees only settled flow has strictly less information than one that sees both settled flow and pre-match constraints. Constraints reveal the agent's *intended* behavior (including unfilled fallbacks and minimum-acceptable fills) which executed flow does not.

**Q: Doesn't reservation-at-submit reveal that an agent has *some* intent in flight?**
A: In v1 with a mock vault, the vault is internal to the engine — no on-chain footprint. In a production version using a simple `HecateVault.sol` (`SOLVENCY_AND_VAULTS.md` §3.2.a), on-chain reservations would reveal that funds were committed and — because reserving ETH means SELL and reserving USDC means BUY in the ETH/USDC market — would also reveal the side and an upper bound on the size. The richer constraints (`min_fill_amount`, `fallback_after_batches`, `max_price_impact_bps`) remain hidden, but side and size are leaked. Restoring inventory privacy in a production vault requires the confidential-state variant in §3.2.b, which is a substantially larger project. This is one of the central tradeoffs documented in `SOLVENCY_AND_VAULTS.md`.

**Q: Why ETH/USDC only?**
A: v1 focus. Single-pair uniform clearing is straightforward to specify, implement, and verify. Multi-asset matching introduces routing, netting, and pricing complexity that would dilute the privacy thesis demonstration.

**Q: Doesn't the public clearing price reveal something?**
A: Yes. If the clearing price equals one party's binding limit, that limit may be inferable from the public batch output. Hecate mitigates pre-match inspection of private payloads; it does not guarantee that all private constraints remain hidden after execution. This is a specific instance of the executed-flow inference limitation in `THREAT_MODEL.md` §4.1, not a separate failure mode.
