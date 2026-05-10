# Hecate Threat Model

This document specifies what Hecate's design protects against, what it does not protect against, and the assumptions on which the protections rest. It is the canonical reference for any privacy or integrity claim made elsewhere in the project. If a claim made in `README.md`, `TECHNICAL_PAPER.md`, marketing material, or code comments is not supported by this document, the claim is wrong.

---

## 1. Scope

Hecate is a TEE-mediated batch-crossing engine for autonomous-agent intents. Its target is to mitigate **pre-match inspection of rich intent contents** by operators, solvers, and unmatched counterparties, while preserving deterministic matching, solvency-preserving acceptance, and verifiable receipts.

Hecate's privacy property is **scoped, narrow, and time-bounded.** It applies only to the constraint contents of an intent, only between the moment of submission and the moment a fill becomes public, and only against parties who do not break the underlying TEE attestation chain.

This document does not cover hardware-level attacks against TEE silicon, attestation chain compromise at the manufacturer level, or operating-system-level attacks against the host running the enclave. Those are upstream concerns assumed (and documented as assumed) by Hecate.

---

## 2. Trust assumptions

The system's claims rest on the following assumptions. Any failure of these assumptions invalidates the corresponding claim.

| Assumption | If it fails |
|---|---|
| The TEE platform (EigenCompute / underlying hardware) maintains code-integrity and confidentiality of in-enclave state. | Pre-match constraint confidentiality is lost. |
| The attestation chain (image digest, app id, attestation id) is authentic and non-forgeable. | Receipts can be impersonated; the engine signature ceases to bind to the attested binary. |
| The agent's local strategy compiler emits only the constraints required for matching. | Strategy contents leak directly to the matcher (and would be reconstructable in the receipt audit). |
| Agents protect their own signing keys. | Counterparty impersonation; griefing via sybil intents; reservation attacks against a victim agent. |
| Canonical JSON serialization is deterministic across implementations. | Verification produces false negatives or accepts tampered receipts. |
| The host runs the published binary (and refuses to run a tampered one). | The engine signing key is bound to a different image; receipts no longer verify against the expected digest. |
| The engine private key is generated and held inside the enclave (in EIGEN_TEE) or in-process (in LOCAL_MOCK, where it is explicitly a dev key). | An attacker with the private key can sign arbitrary receipts. |
| Settlement reflects what the receipt claims. | Settlement and matching diverge; the receipt's `settlement_hash` becomes meaningless. |
| The mock vault ledger (v1) accurately models solvency. In production, the equivalent would be a vault contract or settlement layer. | Insolvent intents may be matched; settlement may fail; counterparties bear the loss. |

---

## 3. What the TEE helps with

### 3.1 Pre-match constraint confidentiality

The decrypted private payload (`side`, `asset_in`, `asset_out`, `max_amount`, `limit_price`, `allow_partial_fill`, `min_fill_amount`, `deadline_batches`, `max_price_impact_bps`, `fallback_after_batches`, `nonce`) reaches only the attested matcher. In the v1 LOCAL_MOCK runtime this property is *modeled* (AES-GCM with a local key); in EIGEN_TEE it is *enforced* by the attestation chain.

**Concrete claim, qualified by runtime:**
- In **EIGEN_TEE**, under the trust assumptions in §2 (TEE platform integrity, attestation chain authenticity, no successful side-channel attack), an operator running the Hecate API cannot read the contents of a private payload while it is in flight or at rest in the engine.
- In **LOCAL_MOCK**, this property is *modeled, not enforced*. An operator with process-level access can trivially read decrypted payloads. LOCAL_MOCK is for development and demos and confers no real confidentiality.
- If the TEE platform is compromised (hardware/side-channel break) or the attestation chain is forged, the EIGEN_TEE confidentiality property is lost.

A solver or filler does not exist in v1; if added later, the design would need to specify exactly what they see, and naive integration would defeat this property.

### 3.2 No solver/filler pre-match inspection (v1)

There is no third-party bidding or pricing layer in v1. Constraints reach the matcher and nothing else. This eliminates the leakage class introduced by solver/filler architectures (CoW, UniswapX) where third parties must see enough of the order to compete.

### 3.3 Code-integrity binding via image digest

The engine's signing key is bound to the attested image digest. A modified binary cannot produce signatures that verify under the published digest. Receipts therefore tie back to a specific code version that reviewers can audit.

### 3.4 Receipt-level auditability without payload disclosure

Public batch receipts commit to roots over envelopes and payload commitments, plus vault state hashes and settlement hashes. A third party can verify that a receipt is internally consistent and signed by the attested engine without ever seeing private payloads.

### 3.5 Runtime-mode coherence

Receipts include `runtime_mode` and Eigen metadata. Verification refuses receipts whose declared mode does not match the supplied metadata (e.g., `runtime_mode = EIGEN_TEE` with null `eigencompute_image_digest`). There is no silent fallback from EIGEN_TEE to LOCAL_MOCK.

### 3.6 Tamper failure

Mutating any field in a batch or fill receipt — clearing price, payload commitment, vault deltas, settlement hash, runtime metadata, engine signature — invalidates verification. This is enforced both by the engine signature and by the verifier's structural checks (re-derived hashes, conservation invariants).

---

## 4. What the TEE does not solve

### 4.1 Executed-flow inference

Once a batch settles, fills are public (or, in v1, fully public via the settlement object and vault deltas). An attentive observer with sufficient history can infer policy from the realized fills. Hecate does not hide what was actually traded; it hides what was *requested* before the trade was decided. This is a meaningful but bounded property.

One specific case worth calling out: the clearing price is published in every batch receipt. When the matcher selects a clearing price equal to a single party's binding limit, that party's limit becomes observable from the public receipt. This is a concrete instance of executed-flow inference, not a separate failure mode. Hecate mitigates pre-match inspection of private payloads; it does not guarantee that all private constraints remain hidden after execution.

### 4.2 Matched counterparty learns from own fill

A counterparty who matched against an agent learns at minimum the clearing price, their own fill amount, and the aggregate/public batch receipt fields (number of intents matched, vault state hashes, settlement hash). They do **not** learn the other side's full constraint set — the other agent's `min_fill_amount`, `max_amount`, `fallback_after_batches`, or `max_price_impact_bps` are not disclosed by the fill receipt or batch receipt.

What is unavoidable: repeated matches against the same agent let the counterparty triangulate behavior over time. This pairwise leakage is structural for any matching system that publishes settlement, and Hecate does not address it.

### 4.3 Behavioral fingerprinting

Patterns in submission timing, batch participation, fill ratios, and unfilled-reason distributions can fingerprint an agent over time. Hecate does not address this. Mitigations such as anonymous submission and rate normalization are listed in `TECHNICAL_PAPER.md` §17 as future work.

### 4.4 Censorship before enclave inclusion

The host can refuse to forward an intent to the enclave, delay its inclusion, or selectively exclude it from a batch. The TEE cannot detect or prove the absence of a submission it never received. Liveness in v1 depends on the operator running the host.

### 4.5 Liveness failure

If the enclave or its host goes offline, intents do not match. Reservations remain locked until a deterministic timeout or operator action releases them. v1 has no formal liveness guarantee.

### 4.6 Hardware/side-channel attacks

Cache-timing attacks, speculative-execution leaks, and other side-channel attacks against the TEE platform are out of scope for Hecate's design. They are inherited from the underlying platform's threat model.

### 4.7 Bad reference prices

`max_price_impact_bps` is enforced against a `MarketSnapshot.reference_price`. If the reference price is wrong, stale, or manipulated, the constraint is enforced incorrectly. v1 does not specify how `MarketSnapshot` is sourced; production deployments would need to address this.

### 4.8 Insufficient liquidity

If submitted intents do not cross within their limit prices, the batch produces no fills. Hecate provides no liquidity backstop. Unfilled intents carry an explicit `unfilled_reason`.

### 4.9 Custody risk

The v1 mock vault holds no real funds. Any production version using a real `HecateVault.sol` would introduce smart-contract custody risk; this is discussed in `SOLVENCY_AND_VAULTS.md` and is a deliberate v1 non-goal.

### 4.10 Public on-chain inventory leakage

A real prefunded vault would publish per-agent balances on chain (unless additionally encrypted). This re-exposes the very inventory information Hecate's pre-match privacy was designed to protect, *for the holding period before settlement*. v1 sidesteps this by mocking the vault; production would have to address it.

### 4.11 Regulatory and dark-pool concerns

Hecate is research/MVP infrastructure. It makes no claims about regulatory compliance, securities-law treatment, market-abuse resistance, or KYC/AML obligations. Operators of any deployed instance would need to evaluate these independently.

### 4.12 Strategy/policy audit

The agent compiles its strategy locally into the constraints submitted to the matcher. The TEE does not see the principal strategy and cannot audit it. If the agent submits constraints that encode a flawed or malicious policy, the matcher executes them faithfully.

### 4.13 Submitter-identity privacy

The public envelope reveals `agent_id`. Hecate does not provide submitter anonymity in v1. Combined with on-chain settlement, this means the identity-to-flow linkage is fully observable.

### 4.14 Atomicity across batches

Multi-batch atomic settlement, multi-agent netting graphs, and similar features are out of scope for v1.

---

## 5. Adversary catalog

We enumerate concrete adversary classes and what Hecate does and does not provide against each.

### 5.1 Curious operator (host)

*Capabilities:* runs the API and the enclave host; sees envelopes, ciphertexts, network metadata; can read process memory outside the enclave.

*Hecate provides:* no visibility into decrypted payloads (in EIGEN_TEE) or modeled non-visibility (in LOCAL_MOCK). The operator sees `agent_id`, `market`, `expiry_ms`, `payload_commitment`, ciphertext, `nonce`, and timing.

*Hecate does not provide:* protection against censorship, delay, or selective inclusion by the operator. Submitter-identity privacy. Inference resistance from observable settlement outcomes.

### 5.2 Malicious operator

*Capabilities:* the curious operator's capabilities, plus willingness to tamper with the engine binary or host.

*Hecate provides:* attestation-bound signing means a tampered binary cannot produce verifying receipts. Reviewers can detect that receipts no longer carry the expected image digest.

*Hecate does not provide:* protection against the operator simply not running the enclave (denial of service), or against the operator presenting a different attestation that some clients accept (governance failure).

### 5.3 Counterparty (matched agent)

*Capabilities:* submits their own intents; receives fills; observes their own fill receipts and the public batch receipts.

*Hecate provides:* the counterparty does not learn the constraints of agents they did not match with; partial fills do not disclose the unmatched side's full constraint set.

*Hecate does not provide:* the counterparty *does* learn at minimum the clearing price, their own fill amount, and the fact that the other side was willing to cross at that price. Repeated matches reveal more.

### 5.4 Solver / filler

*Not present in v1.* If introduced in a future version, the design must specify exactly what they see. Naive integration (handing constraints to fillers to bid on) would defeat the privacy property.

### 5.5 External observer

*Capabilities:* observes the public API surface, public batch receipts, and (in production) on-chain settlement.

*Hecate provides:* envelopes and receipts do not reveal payload contents. The observer can verify receipt integrity but cannot reconstruct the constraints behind them.

*Hecate does not provide:* protection against statistical inference from settlement outcomes over time.

### 5.6 Compromised TEE

*Capabilities:* hardware-level break of the TEE platform; ability to read enclave memory.

*Hecate provides:* none. This is upstream of Hecate's threat model.

### 5.7 Compromised agent key

*Capabilities:* an attacker with an agent's private key.

*Hecate provides:* nonce tracking prevents replay of a single signed envelope; reservations limit the damage of a single grief attack on the agent's vault. Signature verification is structurally enforced.

*Hecate does not provide:* recovery; the attacker can submit arbitrary intents on behalf of the compromised agent until the key is rotated. v1 has no key-rotation flow.

### 5.8 Network adversary (in-flight)

*Capabilities:* observes or modifies API traffic.

*Hecate provides:* envelope signatures detect modification of envelope contents; ciphertext authenticity (AES-GCM tag in v1) detects modification of payloads.

*Hecate does not provide:* transport-level confidentiality on its own; deployments are expected to terminate TLS in front of the API. The TEE confidentiality property does not depend on TLS, but production deployments should still use it.

---

## 6. Confidentiality boundary in detail

The confidentiality boundary in v1 wraps:

- the in-process matcher
- the in-process engine signer
- the in-process payload decryptor
- the in-process vault ledger

Inside the boundary: decrypted private payloads, derived intermediate state during matching, the engine private key, and the live vault state.

Outside the boundary: public envelopes, ciphertext payloads, batch receipts, fill receipts, vault state hashes (but not raw vault state in production), settlement objects.

In `LOCAL_MOCK`, the boundary is **modeled, not enforced**: an attacker with process-level access trivially defeats it. This is the entire point of the LOCAL_MOCK label and is repeatedly called out in documentation.

In `EIGEN_TEE`, the boundary is **enforced** by the TEE platform under the assumptions in §2.

---

## 7. Integrity boundary

Integrity is enforced at the receipt layer:

- agent signatures over envelopes — verified by recovering `agent_id`
- engine signatures over batch receipts and fill receipts — verified against the attested engine public key
- canonical-JSON commitments over envelopes, payload commitments, vault state, and settlement — re-derived by the verifier
- conservation invariants on settlement (Σ base_delta = 0, Σ quote_delta = 0) — checked structurally. v1 assumes no protocol fees; if fees are introduced, the invariants must include fee-recipient deltas.

A tamper test suite in `tests/tamper.test.ts` mutates each receipt field individually and asserts that verification fails with the expected reason. This is a primary acceptance criterion for v1.

---

## 8. Out-of-band assumptions for v1 specifically

- The dev signing key for `LOCAL_MOCK` is published in `.env.example` or generated locally. It carries no production weight. Receipts produced under `LOCAL_MOCK` are not authoritative for any real settlement.
- The mock encryption key is derived from `CODE_DIGEST` and a hardcoded salt. It exists to demonstrate the envelope/payload separation, not to provide cryptographic confidentiality.
- The `MarketSnapshot.reference_price` is supplied externally; v1 does not specify a source. Without a snapshot, `max_price_impact_bps` is not enforced and the limitation is recorded.
- The mock vault holds no real funds. `INSUFFICIENT_FUNDS` is a logical condition, not a custodial one.

These v1-specific caveats must be repeated in `README.md` and the demo script's terminal output.

---

## 9. Banned phrasing

The following phrases must not appear in code, comments, README, technical paper, demos, or marketing material:

- "trustless private exchange"
- "fully private"
- "hides strategy"
- "solves MEV"
- "private dark pool" (as an absolute claim)
- "production-ready" (for v1)
- "cryptographically guaranteed privacy" (for v1; AES-GCM with a local key is not this)
- "better than CoW" (the comparison is misleading; we occupy a different point in the design space)

The acceptable phrasing for the system is **"trust-reduced confidential execution"** that **"mitigates pre-match inspection of rich intent contents."**

---

## 10. Change control

Any change to this document that broadens a claim — adds a new "TEE helps with" entry, removes an item from "TEE does not solve," or weakens an assumption — requires explicit reapproval from the project owner. Narrowing claims (adding limitations, tightening assumptions) is encouraged and does not require reapproval.
