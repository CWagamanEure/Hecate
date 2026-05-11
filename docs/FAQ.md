# Hecate FAQ

Anticipated reviewer questions with honest answers. Every claim here is
grounded in one of the canonical docs — follow the cross-references for
the full treatment.

---

## System scope

**What does Hecate do?**

It is an API-first private batch-crossing engine for autonomous-agent
intents on a single market (ETH/USDC). Agents submit signed envelopes plus
encrypted private payloads. A TEE-mediated matcher decrypts payloads
inside the trust boundary, runs deterministic uniform-clearing matching,
and emits engine-signed public batch receipts plus per-agent fill receipts.
A third party can verify every receipt offline. See
[ARCHITECTURE.md](ARCHITECTURE.md).

**What does it not do?**

It is not a fully trust-free private exchange. It does not hide strategy
over time. It does not address executed-flow inference. It does not solve
MEV. It does not provide submitter-identity privacy or
behavioral-fingerprint resistance. It is not a production custody system
(v1 vault is a mock prefunded ledger). See
[THREAT_MODEL.md §4](THREAT_MODEL.md#4-what-the-tee-does-not-solve).

---

## Privacy guarantee

**What is the actual privacy property?**

The decrypted private payload (`side`, `limit_price`, `min_fill_amount`,
`max_price_impact_bps`, etc.) reaches only the attested matcher. Operators,
solvers, and unmatched counterparties cannot inspect those constraints
before the match is decided. This is the entire claim. See
[THREAT_MODEL.md §3.1](THREAT_MODEL.md#31-pre-match-constraint-confidentiality).

**Is the privacy "real" in LOCAL_MOCK?**

No. LOCAL_MOCK uses AES-GCM with a key derived from `CODE_DIGEST`. Anyone
with process-level access can read the key and decrypt any payload. The
mock encryption is **architectural** — it exercises the envelope/payload
separation. It is not security. Every doc, the startup banner, and the
`/attestation` warning field repeat this. See
[shared/crypto/mockEncryption.ts](../shared/crypto/mockEncryption.ts)
top-of-file warning.

**Is the privacy "real" in EIGEN_TEE?**

Under the trust assumptions in
[THREAT_MODEL.md §2](THREAT_MODEL.md#2-trust-assumptions): yes, the
operator cannot read decrypted payloads. Under TEE platform compromise
(hardware/side-channel break) or attestation-chain forgery: the property
is lost. This is upstream of Hecate's design and explicitly out of scope.

**What does an attentive observer learn from the public batch receipt?**

`batch_id`, `market`, `clearing_price`, `num_intents`, `num_matched`,
plus hashes of vault state and settlement. They do **not** learn any
private payload contents. They can verify the receipt is internally
consistent and signed by the attested engine. See
[RECEIPTS.md](RECEIPTS.md).

---

## Comparisons

**Why not CoW / UniswapX?**

CoW and UniswapX are excellent at their target: best-price swaps via
solver competition or filler bidding. By construction, solvers and
fillers see the order contents to compete on price. For richer
constraints (`min_fill_amount`, `fallback_after_batches`,
`max_price_impact_bps`) that describe an agent's risk posture, that
visibility is itself the leakage Hecate targets. Different point in the
design space, not a better swap UX. See
[COMPARISONS.md](COMPARISONS.md).

**Why not Renegade?**

Renegade achieves strong cryptographic confidentiality via MPC + ZK,
which is the right answer for shape-restricted private swap orders. The
tradeoff is expressiveness: programmable constraints with conditional
behavior are harder to encode and run. Hecate trades cryptographic
strength for expressiveness and latency. See
[COMPARISONS.md](COMPARISONS.md).

**Why not Shutter / threshold encryption?**

Shutter protects ordering-time visibility — encrypted content opens after
the ordering commitment. After decryption, execution semantics run in
public state. That's the right design for tx-ordering protection but
doesn't address per-intent matching logic running over rich constraints.

---

## Eigen specifics

**What does the TEE actually attest to in v1?**

Three fields, all stamped into every receipt via `runtime`:
`eigencompute_app_id`, `eigencompute_image_digest`,
`eigencompute_attestation_id`. The verifier checks coherence (EIGEN_TEE
requires all three non-null; LOCAL_MOCK requires all three null). Real
on-chain attestation-chain walking is roadmap material; v1 only checks
metadata coherence. See
[EIGEN_DEPLOYMENT.md §6](EIGEN_DEPLOYMENT.md#6-trust-story).

**Why does `signer.mode` say `LOCAL_DEV_KEY` even when running on Eigen?**

Because v1 deliberately does not use Eigen's app-wallet signing yet.
Receipts are signed by the `ENGINE_PRIVATE_KEY` env var in both modes.
`/attestation` reports this honestly so no one mistakes a v1 receipt for
an app-wallet-signed receipt. App-wallet migration is a separate ticket;
see [EIGEN_DEPLOYMENT.md §8](EIGEN_DEPLOYMENT.md#8-app-wallet-signing--current-state-and-future-work).

**Can I run the demo without Eigen?**

Yes. `npm run dev` starts the engine in `LOCAL_MOCK` — fully working,
fully offline. The integrity story is identical; only the trust story
differs (LOCAL_MOCK declares its own non-security upfront).

---

## On-chain verifier

**What does `HecateSettlementVerifier.sol` prove?**

That a 32-byte body hash was signed by a specific engine address. The
contract is a minimal `ecrecover` adapter — caller computes the
canonical-JSON body hash off chain (since canonical JSON in Solidity is
impractical) and passes both the hash and the 65-byte signature. The
contract returns `true` iff recovery matches the expected engine
address. See [contracts/README.md](../contracts/README.md).

**Does it re-verify settlement, conservation, or matching on chain?**

No. v1 proves only engine-signature authenticity. Full on-chain
re-verification is roadmap material and is gated on the EIP-712
migration (so the body hash can be recomputed from typed-data fields
inside Solidity). See [ROADMAP.md §4](ROADMAP.md#4-onchain-verifier-contract).

**What does the Sepolia tx actually demonstrate?**

That the engine signature inside a real Hecate bundle recovers to the
published engine address on a live chain. The `ReceiptVerified` event
emits the bundle's body hash and engine address as indexed topics —
both are public information already. The point is portability: any
third party with ecrecover access can validate Hecate receipts, not
just one specific JS verifier.

---

## Solvency

**How is solvency enforced?**

At intent submission, the matcher reserves the max-required-spend in the
mock vault. A second intent that would over-spend is rejected with
`INSUFFICIENT_FUNDS`. On settlement, used funds become signed deltas,
unused reservations are released. See
[SOLVENCY_AND_VAULTS.md](SOLVENCY_AND_VAULTS.md) and
[shared/vault/reservations.ts](../shared/vault/reservations.ts).

**What if an agent goes insolvent mid-batch?**

It cannot. Acceptance reserves at submission, so an intent that joins
the ready pool already has its max-required-spend locked. The matcher
operates on the ready pool, not on live balances. Concurrent submissions
with conflicting spends serialize through a single mutex (v1 is
single-process; multi-process is out of scope).

**Is the v1 vault real?**

The runtime engine still settles through an in-process ledger — every
demo today uses the mock vault. A real custody contract,
[`contracts/HecateVault.sol`](../contracts/HecateVault.sol), is now
committed to the repo with full Forge coverage (deposit / withdraw /
signed `settleBatch` with conservation, replay, signature, and
insolvency guards), and has been **deployed and verified on Sepolia**
at [`0x7EF8583489eEb158bf9233bC7a38e0EC410eF1aA`](https://sepolia.etherscan.io/address/0x7EF8583489eEb158bf9233bC7a38e0EC410eF1aA)
alongside a 6-decimal demo MockUSDC at [`0x1662B5050B70c8fAc9405d11B3e7eCDe9eF6c3cB`](https://sepolia.etherscan.io/address/0x1662B5050B70c8fAc9405d11B3e7eCDe9eF6c3cB).
However, the engine does **not** yet call `settleBatch` on chain — the
on-chain signature (`engine_signature_onchain`) rides on every bundle
since V2 stage 1, but actually submitting it to the deployed vault is
V6 of the on-chain vault project. See
[SOLVENCY_AND_VAULTS.md](SOLVENCY_AND_VAULTS.md) for the design,
[deployments/sepolia.json](../deployments/sepolia.json) for the full
deployment manifest, and [ROADMAP.md §3](ROADMAP.md#3-production-solvency)
for the rollout plan.

---

## Matching mechanism

**Why uniform clearing instead of price-time priority?**

Uniform clearing is order-independent: every match within a batch
executes at the same clearing price. That makes the receipt easy to
state, easy to verify, and removes a class of solver-ordering games. The
tie-break ladder is documented in
[shared/matching/uniformClearing.ts](../shared/matching/uniformClearing.ts).

**What's the tie-break ladder?**

(1) Higher executable volume wins. (2) Distance from the midpoint of
highest-active-buy and lowest-active-sell — closer wins. (3) Lower price
wins. Deterministic across implementations.

**Can the matcher ever return `BATCH_FAILED`?**

The path exists but is defensive. In practice the iterative-tightening
loop terminates with `MIN_FILL_NOT_MET` instead. The
`--include-failure-fixture` demo exercises this — three intents whose
min-fill conflicts collapse to all-zero allocation. The matcher signs
the (correctly empty) batch and emits per-intent `UNFILLED` reasons.
See the failure-mode demo in
[DEMO.md](DEMO.md#failure-mode-demo-optional).

---

## Failure modes

**What if the host censors my intent?**

The host can refuse to forward an intent to the enclave, delay it, or
exclude it from a batch. Hecate does not prevent this. The TEE cannot
prove the absence of a submission it never received. Liveness is the
operator's responsibility in v1. See
[THREAT_MODEL.md §4.4](THREAT_MODEL.md#44-censorship-before-enclave-inclusion).

**What if Eigen / the host goes down?**

In-flight intents in the ready pool are lost (in-memory state). Persisted
reservations remain in `vault.json` and `reservations.json`, but the
matcher cannot replay them. A future `ready.jsonl` (see
[ROADMAP.md §1](ROADMAP.md#1-persistence-and-crash-recovery)) would close
this gap.

**What about side-channel attacks against the TEE silicon?**

Out of scope. Hardware/side-channel attacks are inherited from the
underlying platform's threat model. See
[THREAT_MODEL.md §4.6](THREAT_MODEL.md#46-hardwareside-channel-attacks).

---

## Project status

**Is this production-ready?**

No. v1 is research / MVP. The README, the docstrings, and every receipt's
`runtime` field all label LOCAL_MOCK as non-security and `LOCAL_DEV_KEY`
as a dev signer.

**What's tested?**

691 vitest cases across 54 files, including 9 adversarial test files
(one of which is a property-based fuzz that mutates random leaves of a
saved bundle — every mutation tested rejects). 14 explicit tamper
scenarios in the CLI replay. 44 Forge tests across three contracts
(`HecateSettlementVerifier.sol`, `HecateVault.sol`, `MockUSDC.sol`)
plus a cross-tool ABI parity pin. 30-cycle deterministic soak.
End-to-end demo verified live.

**Is the Sepolia contract deployed?**

The deploy *script* is committed (`contracts/script/Deploy.s.sol`) and
end-to-end tested against local anvil. The actual Sepolia broadcast is a
manual step — see [contracts/README.md §Deploying](../contracts/README.md#deploying).

---

## How to audit yourself

- **Start here:** [TECHNICAL_PAPER.md](TECHNICAL_PAPER.md) for design,
  [THREAT_MODEL.md](THREAT_MODEL.md) for what the system promises and
  doesn't.
- **Look at the matching logic:**
  [shared/matching/uniformClearing.ts](../shared/matching/uniformClearing.ts).
  ~400 lines, single function with documented tie-break.
- **Look at the verifier:**
  [shared/verify/verifyEngine.ts](../shared/verify/verifyEngine.ts).
  Pure functions, no state, structurally recomputes every signed-over
  field.
- **Look at the tamper scenarios:**
  [shared/verify/tampers.ts](../shared/verify/tampers.ts). Each has a
  "what this demonstrates" string.
- **Run the demo yourself:** `npm install && npm run dev` (terminal 1),
  `npm run simulate -- --reset-demo-state --data-dir ./data` (terminal 2).
- **Verify the on-chain story:** `cd contracts && forge install foundry-rs/forge-std && forge test -vv`.
