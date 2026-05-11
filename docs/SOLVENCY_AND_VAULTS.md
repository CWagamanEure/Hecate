# Hecate Solvency and Vault Design

This document is the canonical reference for how Hecate handles agent solvency. It explains why solvency is independent of TEE correctness, surveys the design space (mock vault, real vault, allowance-based, per-intent locking, bonded fillers, hybrid), and records the v1 decision and its rationale.

If anything in `TECHNICAL_PAPER.md`, `README.md`, or code comments contradicts this document, this document wins.

---

## 1. The core observation

**A TEE proves that matching followed the rules. It does not prove that an agent has the funds to settle.**

The matcher receives signed envelopes and decrypted payloads. It can verify signatures, decrypt, evaluate constraints, and produce deterministic fills. It cannot, by itself, look at a real chain or a real custody account and tell you that an agent's wallet contains the assets they intend to spend. That information has to come from a state oracle outside the matching logic.

This is not a TEE limitation; it is structural. Any matching engine — TEE, ZK, MPC, or plain server — needs an authoritative source for funds availability if it intends to bind matching outcomes to settlement. A matcher that produces fills against insolvent agents produces receipts that cannot settle.

For Hecate, "the source for funds availability" is the **mock prefunded vault ledger** in v1, and would be one of several alternatives in production. Each alternative carries tradeoffs. None is free.

---

## 2. Where solvency sits in the architecture

```
agent submits envelope + ciphertext
        │
        ▼
┌─────────────────────┐
│ Intent API          │
│ - sig verification  │
│ - decrypt payload   │
│ - schema validation │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Solvency layer      │ ◄─── this is the topic of this doc
│ (mock vault in v1)  │
│ - max-spend calc    │
│ - reserve funds     │
│ - reject if short   │
└──────────┬──────────┘
           │ (only funded intents)
           ▼
┌─────────────────────┐
│ Batch builder       │
│ → matcher           │
│ → settlement        │
└─────────────────────┘
```

The solvency layer sits **between** authenticity checks and the matcher. Intents that fail solvency never enter a batch. This is why the mock vault state is hashed before and after each batch and committed in the public batch receipt — the receipt's integrity story includes the solvency state transition.

---

## 3. The design space

### 3.1 Mock prefunded vault (v1)

**What it is:** an in-process ledger keyed by agent address holding `balances` and `reserved` for ETH and USDC. Reservations happen at intent submission. Releases happen at settlement, expiry, cancellation, or rejection. The ledger is hashed canonically before and after each batch, and both hashes are committed in the batch receipt.

**Pros:**
- Strongest possible *modeled* solvency guarantee within the engine.
- Zero custody risk (no real funds).
- Lets us prove the entire receipt + verification + tamper pipeline works end-to-end.
- Honest about being a prototype — there is no temptation to over-claim production custody.

**Cons:**
- Holds no real assets, so settlement is purely logical. The engine "spends" balances that don't correspond to anything outside the engine.
- Anyone who trusts a Hecate v1 receipt to mean real funds moved is wrong.

**Verdict:** ✅ v1 choice. The right baseline for an MVP whose thesis is about confidentiality, not custody.

### 3.2 Real prefunded vault (`HecateVault.sol`)

There are two materially different versions of this option, and the docs must not conflate them.

#### 3.2.a Simple `HecateVault.sol` (public balances)

> **Implementation status (2026-05):** the contract itself has now been written ([`contracts/HecateVault.sol`](../contracts/HecateVault.sol), 28 Forge tests). It is **not** integrated with the runtime engine and **not** deployed on any network. Engine integration is the V2 phase of the on-chain vault project; until then, every demo continues to use the mock prefunded vault from §3.1.

**What it would be:** an ordinary on-chain contract holding deposited ETH and USDC, with deposit/withdraw functions for agents and a `settleBatch` function callable only by an attested signer. Per-agent balances and reservations are stored as plain on-chain state.

**Pros:**
- Strongest production settlement guarantee. If an intent is admitted, settlement cannot fail for solvency reasons.
- Clean separation between matching and custody.
- Compatible with Hecate's batch settlement model — the engine produces a settlement object and the contract applies the deltas atomically.
- Implementable with standard tooling.

**Cons:**
- **Smart-contract custody risk.** Any bug in the vault contract risks user funds. This is a serious operational responsibility.
- **Public on-chain inventory leakage.** Per-agent balances and reservations are visible on chain. **A simple HecateVault.sol does not preserve inventory privacy** — it re-exposes the very inventory information Hecate's pre-match privacy was designed to protect, *for the period funds are held*. Anyone watching the chain can read balances and reservation timing.
- **Capital inefficiency.** Funds locked in the vault are unavailable for other uses.
- **Withdrawal liveness depends on the engine.** If the engine stalls, withdrawals may need a fallback path (timeout-based exit, governance unlock, etc.) which itself becomes a trust surface.
- **Onboarding friction.** Agents must deposit before trading.

#### 3.2.b Confidential vault state

**What it would be:** the same custody contract, but with vault state held confidentially via additional machinery — for example commit-and-prove ZK accounting, MPC-backed state, an attested vault enclave, or per-agent encrypted balances with ZK proofs of valid deltas.

**Pros:**
- Restores inventory privacy that 3.2.a sacrifices.
- Maintains Hecate's pre-match privacy property end-to-end (submission → matching → settlement).

**Cons:**
- **Substantial extra machinery.** This is a significantly larger project than the simple vault — not a config flag, not an incremental feature.
- Proof system, key management, and operator semantics all become harder.
- Likely requires its own threat model and review.

**Do not imply that a real vault preserves inventory privacy "by default."** It does not. Preserving inventory privacy on chain requires the additional confidential-accounting machinery in 3.2.b, which is out of scope for v1 and for the foreseeable v2.

**Verdict:** ❌ not in v1 (no confidential-accounting layer is implemented). If we eventually do this, the choice between 3.2.a and 3.2.b is a primary design decision and must be explicit in any subsequent paper or release notes.

### 3.3 Allowance / Permit2

**What it would be:** agents pre-approve the engine (or an executor contract) to pull funds via Permit2. The engine signs a settlement that authorizes pulling specific amounts from each agent's wallet.

**Pros:**
- Non-custodial. Funds stay in agent wallets until settlement.
- High capital efficiency.
- Lower onboarding friction.
- Familiar UX from CoW and UniswapX.

**Cons:**
- **Allowance can move between intent submission and settlement.** An agent can withdraw, transfer, or revoke between admission and the settlement transaction. Settlement may then fail.
- Compensation requires a fallback layer: bonds slashed against griefers, or solver/filler-style underwriting where a third party covers the failed settlement.
- Closer in shape to CoW/UniswapX → Hecate becomes less differentiated.
- Failed settlements add MEV/front-running surface.

**Verdict:** ❌ not in v1. Possibly v2 fallback path. The settlement-failure mode is the central concern; any production deployment using this would need an explicit slashing/bonding design.

### 3.4 Per-intent on-chain locking

**What it would be:** each intent is accompanied by an on-chain lock placed on the specific funds it commits. Settlement releases the lock and applies deltas; expiry releases the lock back to the agent.

**Pros:**
- Strong settlement guarantee per intent.
- No persistent vault contract.
- Localized custody risk (per intent).

**Cons:**
- **Public locks leak side, size, and asset.** A buy intent for 10 ETH locks 36000 USDC visibly. This *defeats the central privacy goal of Hecate*.
- High gas overhead per intent.
- Poor batching ergonomics.

**Verdict:** ❌ never appropriate for Hecate. The leakage profile is structurally incompatible with the privacy thesis.

### 3.5 Bonded intents (additive layer)

**What it would be:** agents post a bond when submitting; the bond is slashed if the agent fails to settle (in an allowance/Permit2 model) or behaves adversarially.

**Pros:**
- Reduces griefing.
- Compatible with allowance-based designs.
- Reputation/credit-line variants are possible.

**Cons:**
- Does not, by itself, guarantee settlement — bonds compensate, they don't conjure missing funds.
- Bond sizing is a hard mechanism design problem.
- Leaks something (the bond is visible).

**Verdict:** Useful as an additive layer in a hybrid design, never a primary mechanism on its own.

### 3.6 Solver / filler model

**What it would be:** agents sign intents; competing fillers underwrite settlement and pull funds via allowance.

**Pros:**
- No user escrow.
- Familiar pattern (CoW, UniswapX).

**Cons:**
- **Fillers must see enough of the intent to price filling**, which re-opens the pre-match leakage surface Hecate is designed to close.
- Pushes execution risk to fillers.
- Hecate becomes a CoW/UniswapX clone in shape.

**Verdict:** ❌ contradicts the privacy thesis. If introduced, fillers would need to operate inside the enclave themselves (or via attested quoting), which is a substantial future project (see `TECHNICAL_PAPER.md` §17, "private solver quotes").

### 3.7 Hybrid (vault + bonded fillers)

**What it would be:** a real `HecateVault` for agents that want guaranteed crossing under TEE matching; a Permit2/allowance fallback path with bonded fillers for non-custodial flows. Agents choose per-intent.

**Pros:**
- Best of both worlds *in principle*.
- Capital-efficient agents can use the non-custodial path; agents needing strong settlement guarantees can use the vault.

**Cons:**
- **Significant surface area.** Two settlement paths means two failure modes, two integrity stories, two sets of receipts.
- Mechanism design becomes complex (bond sizing, slashing conditions, fallback fillers).
- Hard to specify and harder to verify.

**Verdict:** Likely the correct long-term answer for a production deployment. Far too much surface for v1.

---

## 4. Summary table

| Option | Settlement guarantee | Custody risk | Privacy cost | Capital efficiency | v1 fit |
|---|---|---|---|---|---|
| Mock prefunded vault | Strong (in-engine) | None | None | N/A | ✅ |
| Real prefunded vault (simple, 3.2.a) | Strongest | Contract risk | High (public on-chain inventory) | Low | ⚙ contract written (`contracts/HecateVault.sol`), **not** engine-integrated, **not** deployed |
| Real prefunded vault (confidential, 3.2.b) | Strongest | Contract + crypto risk | Restored, but only with substantial extra machinery (ZK / MPC / confidential accounting) | Low | ❌ out of scope for v1 and foreseeable v2 |
| Allowance / Permit2 | Weak (allowance can move) | Low | Low | High | ❌ possible v2 |
| Per-intent on-chain locking | Strong | Low | **Very high (locks leak side/size)** | Medium | ❌ defeats thesis |
| Bonded intents | Additive only | Low | Low | High | Useful only as overlay |
| Solver/filler | Filler-dependent | None for user | Re-opens pre-match leakage | High | ❌ contradicts thesis |
| Hybrid (vault + bonded fillers) | Mixed | Mixed | Mixed | Medium | Long-term right answer; not v1 |

---

## 5. v1 decision

**Mock prefunded vault ledger only.** No production custody. No on-chain vault contract. No allowance integration.

The mock vault:

- is keyed by `agent_id` and tracks `balances` and `reserved` per asset (ETH, USDC)
- exposes `mock-deposit` and `mock-withdraw` API endpoints (subject to release-of-reservations rules)
- reserves the maximum required spend at intent submission
  - SELL: `max_amount` of `asset_in`
  - BUY: `max_amount * limit_price` of `asset_in` (the quote asset spent)
- enforces `available = balances - reserved >= required` before accepting an intent
- releases unused reservations on settlement, expiry, cancellation, or rejection
- prevents double-reservation via per-agent nonce tracking
- is hashed canonically before and after each batch
- contributes both `vault_state_before_hash` and `vault_state_after_hash` to the public batch receipt

The receipt's integrity story therefore includes the vault state transition, even though no real custody exists. A verifier with the published vault state can re-derive both hashes and the per-agent fill receipts' `reserved_released` fields.

---

## 6. What v1 explicitly does not provide

- Real custody. The mock vault holds no assets.
- Authoritative settlement. A v1 receipt is a research artifact; it does not settle anything on chain.
- Confidential vault state. Vault contents are visible to the operator (and to anyone with the published JSON in the demo).
- Withdrawal liveness guarantees. `mock-withdraw` is best-effort and can refuse if reservations are outstanding.
- Cross-agent netting beyond what naturally falls out of a single batch's settlement.
- Multi-asset solvency beyond ETH/USDC.

These are not bugs; they are the v1 boundary.

---

## 7. Required language

When discussing solvency in code comments, README, technical paper, demos, or marketing:

- The vault is a **mock prefunded vault ledger**, not a custody system.
- Reservations are **modeled**, not custodial.
- v1 receipts are **research artifacts**, not authoritative settlement records.
- Production deployments would need either `HecateVault.sol`, an allowance/Permit2 design with bonded fillers, or a hybrid — and each of those introduces tradeoffs documented above.

Avoid:
- "Vault" without the "mock" qualifier in v1 contexts.
- "Settlement" without clarifying it is mock settlement in v1.
- Any claim that the v1 system handles real funds.

---

## 8. Future work pointers

If the project graduates beyond v1, the solvency story to specify next is:

1. **A vault contract spec.** `HecateVault.sol` with deposit/withdraw, attestation-bound `settleBatch`, and a fallback exit mechanism for liveness failures.
2. **Confidential vault state.** Either commit-and-prove patterns (ZK) or per-agent encrypted state to address the inventory-leakage problem.
3. **A bonded-filler fallback.** For agents who want non-custodial flow, a bond + slashing design with explicit failure semantics.
4. **A formal hybrid mechanism.** Per-intent choice between vault-backed and allowance-backed paths, with receipts that are unambiguous about which path each fill took.

These are listed in `TECHNICAL_PAPER.md` §17 as future work and are deliberately deferred.
