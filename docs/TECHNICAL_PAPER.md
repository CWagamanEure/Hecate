# Hecate: Confidential Intent Execution for Autonomous Agents

*A TEE-based private batch-crossing design for reducing pre-match leakage in onchain settlement markets.*

---

## 1. Abstract

Autonomous on-chain agents increasingly need to delegate execution under richer constraints than a simple swap order: limit price, partial-fill rules, minimum-fill amounts, batch deadlines, fallback behaviors, route or counterparty exclusions, and inventory-driven sizing. Existing intent and solver systems (CoW, UniswapX, Sorella/Angstrom) are strong on execution quality but, by construction, expose enough information about each intent for solvers, fillers, or operators to inspect rich constraints before a match is decided. Threshold-encryption schemes (Shutter) hide ordering but execute logic in public state. Cryptographic dark pools (Renegade) achieve strong confidentiality but pay for it in expressiveness and complexity.

Hecate explores a different point in the design space: a Trusted Execution Environment (TEE) ingests encrypted private payloads alongside public envelopes, runs deterministic uniform-clearing-price matching, and emits signed public batch receipts together with signed private per-agent fill receipts. The narrow technical claim is that this architecture mitigates one specific class of leakage — pre-match inspection of rich intent contents by operators, solvers, and unmatched counterparties — while preserving deterministic matching, solvency-preserving settlement, and third-party verifiability of receipts.

We are explicit about the limits. Hecate does not provide ZK-grade privacy, does not hide strategy over time, does not eliminate executed-flow inference, and does not solve MEV. We describe the system as **trust-reduced confidential execution**, not a private exchange.

This document specifies the v1 design, threat model, solvency assumptions, matching mechanism, receipt format, and verification surface, and explicitly enumerates the system's limitations.

---

## 2. Motivation

The past few years have produced multiple generations of intent-based execution architectures for on-chain trading: CoW Protocol's batch auctions with solver competition, UniswapX's filler-bid Dutch auctions, app-specific sequencing on AMMs (Sorella/Angstrom), threshold-encryption schemes for transaction ordering (Shutter), and cryptographic dark pools (Renegade). Each is well-suited to a particular execution-quality goal — best price across solvers, MEV redistribution, or strong cryptographic privacy for swap-shaped orders.

Autonomous agents stress this design space differently. An agent that compiles a strategy into execution constraints does not necessarily want to advertise those constraints to a solver pool, even if a solver could deliver a better fill. Constraints such as `min_fill_amount`, `fallback_after_batches`, or `max_price_impact_bps` describe the agent's risk posture and partial-fill tolerance — information that, leaked to a competitive solver pool, can be used adversarially in subsequent rounds.

The motivating question for Hecate is: *if the matching logic itself runs inside an attested execution environment, can we evaluate richer execution constraints without exposing those constraints to any party other than the attested binary?* We do not claim this is the only or best approach to agent execution privacy. We claim it is a useful, expressive, low-latency point in the space, with honest tradeoffs and verifiable receipts.

---

## 3. Why autonomous agents create API-native execution leakage

Human traders can keep most of their decision process out of any system: only the order shape reaches an execution venue. Autonomous agents do not have that luxury. To delegate execution, an agent must transmit enough constraint to make matching decidable: minimum fill, deadline, fallback. As soon as a third party — a solver, a filler, or an operator — sees those constraints, they have a fingerprint of the agent's execution policy. Repeated observation lets a counterparty learn the agent's model.

An execution venue that processes constraints in public infrastructure is therefore an *API-native leakage surface*: the very act of expressing a sophisticated intent leaks the policy behind it. This is what Hecate's TEE-mediated matcher is intended to mitigate, scoped narrowly to *pre-match* inspection.

Two observations bound the claim:

1. The TEE only protects what it processes. Once a match settles on-chain, that match is public, and an attentive counterparty can infer policy from the realized fills. We do not pretend otherwise.
2. The TEE protects the matcher, not the agent. The agent must locally compile its strategy into the constraints it transmits. If the agent transmits more than the matcher needs (e.g. internal signals or risk-model outputs), the TEE cannot help. The system imposes a discipline on the agent's payload schema for that reason.

---

## 4. Existing market structures

| System | Focus | Confidentiality property | Why it does not address Hecate's target leakage |
|---|---|---|---|
| **CoW Protocol** | Batch auctions, coincidence of wants, solver competition for swap UX | None during matching — solvers see the order set | Solvers must see constraints to bid; rich agent constraints would leak to the solver pool |
| **UniswapX** | Dutch-auction signed orders filled by competing fillers | None during matching — fillers see orders | Fillers must price orders to fill them; constraints leak to fillers |
| **Sorella / Angstrom** | App-specific sequencing on AMMs to redistribute MEV | Some sequencing-time guarantees, but execution against AMM curves is public | Hecate is not AMM-adjacent; matching is P2P intent crossing, not curve interaction |
| **Shutter / threshold encryption** | Encrypts transaction contents until the decryption point (usually after ordering/inclusion commitments) | Protects ordering-time visibility; after decryption, execution semantics are public | Constraints become public the moment the encrypted block is opened, so per-intent matching logic still runs in public state |
| **Renegade / MPC + ZK dark pool** | Cryptographic privacy for swap-shaped orders | Strong cryptographic confidentiality | Heavier and less expressive for programmable constraints; harder to extend with `fallback_after_batches`, etc. |

Hecate sits between Shutter (encrypts ordering only) and Renegade (cryptographic dark pool): a TEE-mediated expressive intent matcher with weaker trust assumptions than ZK and stronger expressiveness than threshold encryption. The tradeoff is explicit — we exchange cryptographic strength for expressiveness, latency, and engineering practicality.

---

## 5. Why not just CoW / UniswapX / Sorella / Shutter / Renegade

Hecate is not an attempt to outperform these systems on their own terms. We are not claiming a better swap experience than CoW, broader filler competition than UniswapX, AMM sequencing parity with Angstrom, ordering protection equivalent to Shutter, or cryptographic privacy comparable to Renegade.

The differentiator is narrow: **rich, programmable execution constraints expressed by autonomous agents, evaluated by an attested matcher, without exposing those constraints to any party other than the attested binary**. If your use case is a one-shot swap, you should use CoW or UniswapX. If your use case requires cryptographic privacy guarantees, you should use Renegade. If your use case is autonomous-agent-native execution where pre-match constraint leakage is the bottleneck, Hecate's design point is the one we are exploring.

See `COMPARISONS.md` for a detailed feature/threat comparison.

---

## 6. Threat model

A full threat model is in `THREAT_MODEL.md`. The summary:

**TEE helps with** (qualified by runtime mode and TEE assumptions; see `THREAT_MODEL.md` §3.1)
- In `EIGEN_TEE`, under the TEE trust assumptions, the operator/host cannot read decrypted private payloads. In `LOCAL_MOCK` this property is modeled, not enforced.
- No solver/filler exists in v1, so no third-party pre-match inspection.
- Engine signing key is bound to the attested image digest — a tampered binary cannot produce valid receipts.
- Receipt verification requires runtime metadata coherence, so receipts cannot lie about origin.
- Public batch receipts allow third-party audit of clearing-rule compliance without exposing payloads.

**TEE does not solve**
- Executed flow becomes public on settlement; over time it fingerprints strategy.
- A matched counterparty learns from their own fill (clearing price, their own fill amount, and aggregate/public receipt fields). They do not learn the unmatched side's full constraint set, but pairwise inference over repeated matches is unavoidable.
- The host can censor or delay submissions before they reach the enclave.
- Liveness depends on whoever runs the enclave.
- Hardware/side-channel attacks against the TEE itself.
- Bad reference prices, thin liquidity, or settlement-side MEV outside the matcher.
- Custody risk on any real vault.
- Public on-chain inventory leakage if a HecateVault is deployed.
- Strategy correctness — the TEE never sees the upstream strategy and cannot audit it.

The agent must still trust its own local strategy compiler. Hecate intentionally moves only execution constraints into the enclave, never principal policy.

---

## 7. Design goals

1. **Pre-match constraint confidentiality.** Private payloads (limit price, partial-fill rules, min fill, deadlines, fallbacks) reach only the attested matcher, not operators, solvers, or unmatched counterparties.
2. **Deterministic matching.** Given the same batch input, any verifier reproduces the same clearing price and fills.
3. **Verifiable receipts.** Public batch receipts and private fill receipts are signed by an attested engine key and verifiable by any third party.
4. **Solvency-preserving acceptance.** The matcher refuses intents that cannot settle under its solvency model (mock vault in v1).
5. **Honest runtime declaration.** Receipts state the runtime mode (`LOCAL_MOCK` vs `EIGEN_TEE`) and runtime metadata, with no silent fallback.
6. **Tamper failure.** Mutating any field in a receipt — clearing price, payload commitment, settlement hash, vault deltas, runtime metadata — invalidates verification.
7. **Honest documentation.** Claims and limitations are explicit; banned phrases (e.g. "trustless private exchange," "solves MEV," "hides strategy") are not used.

---

## 8. Non-goals

- Full continuous limit-order book.
- Multi-asset routing or cross-asset matching.
- Solver/filler marketplace.
- Real custody or production vault contract in v1.
- Real Eigen TEE deployment in v1 (adapter shell only).
- Production MEV-resistance claims.
- Strategy privacy beyond pre-match leakage.
- Anonymous submission / submitter-identity privacy.
- Behavioral-fingerprint resistance.
- Liquidity provision or market making.
- Trading frontend or consumer UI.

---

## 9. System design

The v1 system is a TypeScript service plus a CLI agent simulator.

### 9.1 Components

1. **Agent simulator / CLI.** Composes signed envelopes and encrypted payloads, posts them to the API, triggers batch closes, fetches and verifies receipts.
2. **Intent API.** Accepts public envelopes plus encrypted payloads, validates agent signatures, performs solvency reservation, persists to JSONL, returns intent status.
3. **Solvency / funding layer.** Mock prefunded vault ledger with reservations and double-spend protection. Hashed before and after each batch.
4. **Matching engine.** Local mock implementation in v1, with an `EIGEN_TEE` adapter shell for future deployment. Decrypts payloads, builds a batch, runs deterministic uniform clearing, produces fills.
5. **Receipt layer.** Public batch receipt and private per-agent fill receipts, both engine-signed over canonical JSON.
6. **Settlement layer.** Mock settlement object hashed into the batch receipt; vault ledger updated atomically. Optional onchain verifier contract is a stretch goal (`HecateSettlementVerifier.sol`).
7. **Verification API.** Pure-function verifier that recomputes commitments, re-checks signatures, asserts conservation invariants, and returns a structured `VerifyResult`.

### 9.2 Runtime modes

`LOCAL_MOCK` — local matching, local dev signer, AES-GCM mock-encrypted payloads, mock vault ledger, no Eigen attestation. Fully offline; intended for development and demos.

`EIGEN_TEE` — intended future mode in which the matching engine and signer run inside an EigenCompute TEE. Receipts include `eigencompute_app_id`, `eigencompute_image_digest`, and `eigencompute_attestation_id`. There is **no silent fallback** from `EIGEN_TEE` to `LOCAL_MOCK`: if `RUNTIME_MODE=EIGEN_TEE` and required configuration is missing, the engine refuses to start.

In v1 we ship `LOCAL_MOCK` fully and ship an `EIGEN_TEE` adapter shell with metadata fields. We do not pretend Eigen is active.

---

## 10. Intent envelope and private payload

Every intent has two parts: a public envelope visible to any operator, and a private payload visible only to the attested matcher.

### 10.1 Public envelope

```json
{
  "intent_id": "intent_001",
  "agent_id": "0xAgentAddress",
  "market": "ETH/USDC",
  "expiry_ms": 1770000000000,
  "payload_commitment": "0xhash_of_private_payload",
  "payload_ciphertext": "0xencrypted_payload_or_mock_ciphertext",
  "nonce": "123",
  "signature": "0xagent_signature"
}
```

The envelope reveals which agent is submitting which market and when, but does not reveal side, size, price, or partial-fill behavior. The `payload_commitment` binds the envelope to the encrypted payload; the matcher rejects any decrypted payload whose commitment does not match.

### 10.2 Private payload

```json
{
  "side": "BUY | SELL",
  "asset_in": "ETH | USDC",
  "asset_out": "ETH | USDC",
  "max_amount": "string decimal",
  "limit_price": "string decimal",
  "allow_partial_fill": true,
  "min_fill_amount": "string decimal",
  "deadline_batches": 3,
  "max_price_impact_bps": 20,
  "fallback_after_batches": null,
  "nonce": "123"
}
```

Discipline on payload contents matters. The agent **must** locally compile its strategy into these execution constraints; the TEE never sees the principal strategy. A payload that contains internal signals, portfolio state, or risk-model outputs defeats the architecture.

### 10.3 Authenticity checks

Before an intent enters a batch, the matcher verifies:

- envelope signature is from `agent_id`
- nonce has not been used by `agent_id`
- expiry has not passed
- market is supported (ETH/USDC in v1)
- decrypted private payload's commitment matches `payload_commitment`
- private payload schema is valid (Zod)
- `asset_in != asset_out` and is consistent with `side`
- the agent has reserved sufficient funds (see §11)

Any failure rejects the intent with an explicit reason recorded in the per-intent fill receipt.

### 10.4 Signing scheme

v1 plans EIP-712 typed-data signing if it does not block the MVP; the acceptable fallback is raw keccak over canonical JSON, documented as the v1 signing format with an EIP-712 migration TODO. Either way, signatures are over a deterministic canonicalization of the envelope minus the signature field itself.

---

## 11. Solvency and funding design

A full discussion is in `SOLVENCY_AND_VAULTS.md`. The summary:

The TEE proves *matching followed the rules*. It cannot prove *the agent has the funds*. Solvency must come from a state oracle outside the matching logic.

For v1 we use a **mock prefunded vault ledger**: in-process state with per-agent balances and reservations for ETH and USDC. Reservations occur at intent submission (not at batch build) so an agent cannot grief by submitting many conflicting intents. The vault is hashed canonically before and after each batch, and both `vault_state_before_hash` and `vault_state_after_hash` are committed in the batch receipt — verification therefore covers the solvency state transition even though no real custody exists.

We deliberately do **not** ship `HecateVault.sol` in v1. The production design space includes a real prefunded vault, a Permit2/allowance-based non-custodial design, per-intent on-chain locking, bonded fillers, or a hybrid. Each has tradeoffs documented in `SOLVENCY_AND_VAULTS.md`. None are "free."

---

## 12. Matching mechanism

v1 matching is deterministic single-pair uniform clearing for ETH/USDC.

### 12.1 Inputs

A `BatchInput` is `{ batch_id, market, intents: Array<{envelope, payload}>, vault_before, timestamp_ms }`, plus an optional `MarketSnapshot { reference_price, timestamp_ms }`.

### 12.2 Algorithm

1. Partition intents into BUYs (asset_out = ETH) and SELLs (asset_in = ETH); convert sizes to base (ETH).
2. Candidate clearing prices = sorted unique limit prices ∪ pairwise midpoints of best crossed buy/sell.
3. For each candidate price `p`:
   - Feasible BUY volume = Σ over buys with `limit_price ≥ p` of `min(remaining_capacity, max_amount)`.
   - Feasible SELL volume = Σ over sells with `limit_price ≤ p` of `min(remaining_capacity, max_amount)`.
   - Matched volume = `min(feasible_buy, feasible_sell)`.
4. Choose the best `p` by tie-break ladder:
   1. maximum matched volume
   2. maximum total surplus (sum of price advantage over each side's limit, taken when easy to compute)
   3. closest to the midpoint of the best crossed buy/sell
   4. earliest intent timestamp
   5. lexicographic `intent_id`
5. Allocate fills pro-rata within each side at the chosen `p`. If an intent's pro-rata allocation falls below its `min_fill_amount`, drop that intent and re-allocate. Iteration cap = number of eligible intents + 1; if reached, the batch fails deterministically.
6. If a `MarketSnapshot` is present, enforce `abs(clearing_price - reference_price) / reference_price ≤ max_price_impact_bps` for each filled intent; intents whose constraint would be violated are dropped with reason `MAX_PRICE_IMPACT_VIOLATED`. Without a `MarketSnapshot`, `max_price_impact_bps` is not enforced and the limitation is documented in the receipt.
7. Intents that did not fill, partially filled, or were dropped carry an explicit `unfilled_reason`.

### 12.3 Determinism

Inputs are sorted by `intent_id` before any iteration order matters; arithmetic is done in fixed-point string-decimals. Any verifier given the same `BatchInput` reproduces the same `FillPlan` byte-for-byte.

---

## 13. Receipts and verification

### 13.1 Public batch receipt

```json
{
  "batch_id": "batch_001",
  "market": "ETH/USDC",
  "runtime_mode": "LOCAL_MOCK | EIGEN_TEE",
  "matching_rule": "UNIFORM_CLEARING_PRICE_V1",
  "engine_code_digest": "sha256:...",
  "eigencompute_app_id": "string | null",
  "eigencompute_image_digest": "string | null",
  "eigencompute_attestation_id": "string | null",
  "intent_envelope_root": "0x...",
  "private_payload_commitment_root": "0x...",
  "vault_state_before_hash": "0x...",
  "vault_state_after_hash": "0x...",
  "settlement_hash": "0x...",
  "num_intents": 12,
  "num_matched": 8,
  "clearing_price": "3590.00",
  "timestamp_ms": 1770000000000,
  "engine_signature": "0x..."
}
```

Both roots are Merkle roots over canonical leaves sorted by `intent_id` (with documented fallback to deterministic ordered aggregate hash if Merkle proves disproportionately expensive in v1).

### 13.2 Private per-agent fill receipt

```json
{
  "intent_id": "intent_001",
  "batch_id": "batch_001",
  "status": "FILLED | PARTIALLY_FILLED | UNFILLED | EXPIRED | INVALID | INSUFFICIENT_FUNDS",
  "filled_base": "6.0",
  "filled_quote": "21540.00",
  "clearing_price": "3590.00",
  "constraints_satisfied": true,
  "unfilled_reason": "insufficient_opposite_flow_within_limit",
  "payload_commitment": "0x...",
  "reserved_released": { "ETH": "0.0", "USDC": "80.0" },
  "engine_signature": "0x..."
}
```

The fill receipt includes the agent's `payload_commitment` so the agent can prove their constraints were the ones evaluated. Access to `GET /intents/:id/fill-receipt` requires a signed challenge from `agent_id`.

### 13.3 Verification surface

The verifier checks:

- agent signatures over envelopes
- nonce uniqueness within the batch
- payload commitments match decrypted payloads (LOCAL_MOCK only — requires payload disclosure)
- both vault state hashes
- settlement hash
- engine signature on the batch receipt
- engine signature on each fill receipt
- runtime-mode coherence (`EIGEN_TEE` ⇒ all eigen fields present and non-null)
- settlement conservation invariants (Σ base_delta = 0, Σ quote_delta = 0)

v1 assumes **no protocol fees**. The conservation invariants above are exact equalities only because no fee recipient is debited or credited. If protocol fees, relayer fees, or any third-party recipient deltas are added in a future version, the invariants must be extended to include those recipients (e.g. Σ base_delta = 0 across {agents ∪ fee_recipients}). The receipt schema would need a `fee_deltas` field and the verifier would need to include it in the conservation check.

Mutating any field invalidates verification. Tamper tests cover every receipt field.

---

## 14. Settlement

v1 settlement is a canonical settlement object that lists fills and per-asset vault deltas. The settlement is hashed and that hash is committed in the batch receipt. Vault state is updated atomically; unused reservations are released.

```json
{
  "batch_id": "batch_001",
  "market": "ETH/USDC",
  "clearing_price": "3590.00",
  "fills": [{ "intent_id": "...", "agent_id": "...", "base_delta": "...", "quote_delta": "..." }],
  "vault_deltas": [{ "agent_id": "...", "asset": "ETH | USDC", "delta": "..." }]
}
```

The optional `HecateSettlementVerifier.sol` is a stretch goal that reproduces the verification logic on-chain. Production custody (`HecateVault.sol`) is intentionally out of scope for v1; see `SOLVENCY_AND_VAULTS.md` for the design note.

---

## 15. Limitations

The system as described:

- Is not a fully trustless private exchange. It is trust-reduced confidential execution. Hardware/side-channel attacks against the TEE, or compromise of the attestation chain, defeat the privacy property.
- Does not hide strategy over time. Settled flow is public, and counterparties learn from their own fills.
- Does not solve MEV or executed-flow inference.
- Does not prove agent solvency without a vault or settlement mechanism. The mock vault is an in-process ledger, not a custody guarantee.
- Does not provide submitter-identity privacy. The envelope reveals `agent_id`.
- Does not provide liveness guarantees. The host can censor or delay submissions before they reach the enclave.
- Does not audit the agent's principal policy. The agent's local strategy compiler is outside the trust boundary.
- Does not provide multi-batch atomic settlement, anonymous submission, or behavioral-fingerprint resistance.
- Public clearing price reveals binding limits. The clearing price is published in every batch receipt. When the matcher selects a clearing price equal to one party's submitted limit, that party's limit becomes observable from the public receipt. Hecate mitigates pre-match inspection of private payloads; it does not guarantee that all private constraints remain hidden after execution.

These limitations are not bugs; they are the boundary of the claim. Documentation, code comments, and receipt fields all conform to this scope.

---

## 16. MVP implementation

The v1 implementation is a TypeScript Node service plus a CLI agent simulator. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for module dependency graph and data flow diagrams.

**Pure modules** under `shared/`:

- `shared/schemas/` — Zod schemas for all cross-boundary objects.
- `shared/math/` — BigInt-scaled-by-10^18 decimal arithmetic.
- `shared/crypto/` — canonical JSON, hashing, signing (`signHash` / `recoverHashSigner` plus envelope helpers), payload commitments, mock encryption (AES-256-GCM via `node:crypto`).
- `shared/persistence/` — JSONL append + atomic JSON snapshot helpers.
- `shared/vault/` — mock prefunded vault ledger, reservations, invariants.
- `shared/matching/` — `acceptIntent` (per-submission pipeline), `buildBatchFromReadyIntents` (pure packager), `clearUniform` (uniform-clearing matcher).
- `shared/settlement/` — `buildSettlementObject` and `applySettlement` orchestrator.
- `shared/receipts/` — batch and fill receipt construction and signing.
- `shared/verify/` — pure-function verifier with structured `VerifyResult` failures.

**Server** under `server/`:

- `server/runtime.ts` — bootstrap, EIGEN_TEE strict-stub.
- `server/state.ts` — in-memory `ServerState` + global FIFO `Mutex`.
- `server/auth.ts` — signed-challenge verification for owner-gated endpoints.
- `server/routes/` — Fastify route plugins (public, vault, intents, batches, verify).

**Client + tests:**

- `agents/` — CLI agent simulator (`runDemo.ts`) and example agent fixtures (A, B, C, D-INSUFFICIENT_FUNDS).
- `tests/` — vitest suites for schemas, crypto, vault, matching, settlement, receipts, verify, persistence, server endpoints, plus adversarial / coverage-targeted / soak files.
- `contracts/` — `HecateSettlementVerifier.sol.optional.md` (stretch goal note) and `HecateVault.sol.optional.md` (design note only).

### v1 lifecycle (Model A — reserve at submission)

`POST /intents`:

1. The Fastify route parses `PublicEnvelope` (Zod) and normalizes `agent_id` to EIP-55.
2. Under the global mutex, `acceptIntent` runs the full gauntlet:
   - signature + expiry verification (`verifyEnvelopeBasic`),
   - mock decrypt (`mockDecryptPayload`),
   - payload-commitment check (`verifyPayloadCommitment`),
   - solvency reservation (`reserveForIntent`).
3. On success, the server appends to `intents.jsonl`, atomically writes `vault.json` and `reservations.json`, and inserts a `ReadyIntent` (envelope + decrypted payload + reservation_id) into the in-memory ready pool.
4. On failure, the server appends to `rejections.jsonl` and returns a structured 400.

`POST /batches/close`:

1. The route reads the ready pool and calls `buildBatchFromReadyIntents`, which is pure packaging — no decrypt, no reservation, no signature verification (those happened at submission). It sorts intents by `(received_ms, intent_id)` and emits a `BatchInput`.
2. `clearUniform` runs the deterministic matcher on the `BatchInput`.
3. `applySettlement` releases each intent's reservation (SETTLED for filled/partial, RELEASED otherwise) and applies vault deltas atomically.
4. `buildBatchReceipt` and `buildFillReceipts` produce engine-signed receipts.
5. Persistence ordering: `batches.jsonl` append, `receipts.jsonl` appends, then atomic snapshot replacements of `vault.json` and `reservations.json`. Ready pool entries for processed intents are cleared.

The split between `acceptIntent` and `buildBatchFromReadyIntents` is the v1 reservation-timing decision: every intent in a batch has already been authenticated, decrypted, commitment-checked, funded, reserved, and nonce-marked before the batch close runs. Batch close is therefore deterministic packaging plus matching plus settlement — no I/O surprises in the hot path.

### Expected demo

Agents A (sells 10 ETH), B (buys 4 ETH), C (buys 8 ETH) clear at 3590 USDC/ETH; agent D (under-funded) is rejected with `INSUFFICIENT_FUNDS`; the returned bundle passes `verifyFullBatch`; tampering with any receipt or supporting artifact fails verification. Owner-gated `GET_FILL_RECEIPT` and `GET_INTENT_STATUS` succeed for the owning agent only; cross-agent fetches fail with `NOT_RECEIPT_OWNER`. See [`DEMO.md`](DEMO.md) for the exact commands and output.

### 16.1 Why API-first, no UI

The MVP intentionally exposes only an HTTP API and a CLI agent simulator. Hecate's target user is an autonomous agent, not a human trader. A consumer trading UI would mis-frame the system as a retail dark pool, invite expectations the threat model does not support (anonymous submission, behavioral-fingerprint resistance, custody guarantees), and shift attention away from the actual product surface — receipt structure, verification, and the clarity of the privacy claim. The CLI simulator is sufficient to demonstrate the end-to-end flow, and any future UI would be a thin client over the same API rather than a separate product.

### 16.2 v1 mock encryption is architectural, not security

The LOCAL_MOCK runtime uses AES-GCM with a locally derived key to demonstrate the envelope/payload separation and exercise the decrypt path. **It does not provide production confidentiality.** An operator with process-level access can read the key and decrypt any payload. This caveat must be repeated in `README.md` and in the demo script's terminal output (e.g., a startup banner stating `RUNTIME=LOCAL_MOCK — payload encryption is architectural, not security`). In `EIGEN_TEE`, the equivalent property is enforced by the attestation chain under the trust assumptions in `THREAT_MODEL.md` §2.

---

## 17. Future work

- **Eigen TEE deployment.** Replace the LOCAL_MOCK signer with an attested key derived inside an EigenCompute enclave; populate eigen metadata from real attestation; verify chain-of-trust client-side.
- **Dual-flow batch auctions.** Simultaneous public and private intent flows with a documented mixing rule.
- **Private solver quotes.** Allow third-party fillers to quote into the enclave without revealing constraints to the filler pool.
- **Multi-agent netting.** Multi-batch atomic settlement across correlated agents.
- **Anonymous submission.** Submitter-identity privacy via blind submission and reveal-on-fill mechanics.
- **TEE + threshold encryption hybrid.** Two-layer confidentiality where the enclave is one of several decryption participants.
- **Production solvency.** Either `HecateVault.sol` for prefunded settlement (in either the simple-public or confidential-state variant of `SOLVENCY_AND_VAULTS.md` §3.2), or a Permit2/allowance design with bonded fillers, or a hybrid.
- **Principal policy audit.** Today the agent's local strategy compiler is outside the trust boundary — Hecate executes whatever constraints arrive in the private payload. For agent-managed funds this is unsatisfying. Future work: (a) a *principal-approved policy hash* committed on chain or in a registry, (b) a *compiler receipt* signed by the agent runtime asserting that the compiled intent was derived from an approved policy, (c) a *compiled-intent hash* in the public envelope that links each intent to its principal-approved policy. This addresses "did the agent stay within authorized policy?" — a different question from "did the matcher follow the rules?" — and is important for delegated-fund use cases.
- **Multi-asset markets.** Beyond ETH/USDC; multi-asset routing and netting introduce significant complexity that v1 deliberately defers.
- **Onchain verifier contract.** `HecateSettlementVerifier.sol` for on-chain verification of receipts.
- **Protocol fees.** v1 has none. If introduced, the conservation invariants must be extended to include fee-recipient deltas (see §13.3) and the receipt schema must add a `fee_deltas` field.

These are intentionally out of scope for v1. The discipline of v1 is to ship a small, honest system whose claims survive scrutiny.
