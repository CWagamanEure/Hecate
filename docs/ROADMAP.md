# Hecate Roadmap

Future work. None of this is implemented in v1. Each item below has a concrete
hook in the v1 codebase or docs.

The discipline of v1 was to ship a small, honest system whose claims survive
scrutiny. Anything that risks weakening the privacy/integrity story without a
matching guarantee belongs here, not in v1.

---

## 1. Persistence and crash recovery

### `ready.jsonl` for in-memory ready pool

**Anchor:** `tests/adversarial.api.test.ts` "ready-pool restart limitation
test" + `shared/matching/intentAcceptance.ts` top-of-file warning.

**Problem:** if the server crashes after `acceptIntent` succeeds but before the
next `POST /batches/close`, the decrypted payload is lost from memory.
Reservations remain in `vault.json` and `reservations.json`. The agent's
intent is in `intents.jsonl` (envelope only — payload is encrypted).

**Future fix:** persist `ReadyIntent` objects (envelope + decrypted payload +
reservation_id) to `ready.jsonl` on accept, replay on startup. Adds a Zod
schema for `ReadyIntent` and an unlink step on batch close. Would close one
of the three v1-acknowledged limitations in [README.md](../README.md).

### Logs-vs-snapshots crash gap

**Anchor:** [ARCHITECTURE.md](ARCHITECTURE.md) §6.

**Problem:** persistence ordering writes append-only logs first, then atomic
JSON snapshots. A crash between the two leaves logs slightly ahead of
state. Detectable on read but not recovered.

**Future fix:** transactional storage (DB) or WAL-style commit markers in the
log files.

### Multi-process / multi-host concurrency

**Anchor:** `server/state.ts` Mutex doc comment.

**Problem:** v1 is single-process under one mutex. Concurrent writes from
multiple processes to `vault.json` would corrupt state.

**Future fix:** file locking (cross-platform `proper-lockfile`-style) or move
to a database.

### Log rotation

**Problem:** v1 does not rotate any of `*.jsonl`. Files grow unboundedly.

**Future fix:** size or time-based rotation with archived segments. Not
currently a constraint for the demo.

---

## 2. Eigen TEE deployment

**Anchor:** `server/runtime.ts` EIGEN_TEE strict-stub branch.

### Real attestation chain verification

**Problem:** v1 only checks runtime metadata coherence (LOCAL_MOCK has null
Eigen fields, EIGEN_TEE has all three non-null). It does not verify the
attestation chain itself.

**Future fix:** integrate EigenCompute SDK; verify the image digest and
attestation id against the published chain; bind the engine signing key to
the attestation. Would replace the LOCAL_MOCK mock-enclave-key derivation
with a key generated inside the enclave.

### Attestation-bound payload encryption

**Problem:** LOCAL_MOCK uses AES-GCM with a `CODE_DIGEST`-derived key —
process-readable, architectural only.

**Future fix:** payload encryption to an attested enclave key. Either the
enclave publishes a public key during attestation and clients encrypt to it,
or payloads are submitted over an attested secure channel.

---

## 3. Production solvency

**Anchor:** [SOLVENCY_AND_VAULTS.md](SOLVENCY_AND_VAULTS.md) §3.

### `HecateVault.sol` — simple variant (3.2.a)

On-chain prefunded vault contract holding deposited ETH and USDC.
`settleBatch` callable only by an attested signer. Strongest production
settlement guarantee, but per-agent balances and reservations are visible on
chain. **Re-exposes the inventory information Hecate's pre-match privacy was
designed to protect, for the holding period.**

### `HecateVault.sol` — confidential variant (3.2.b)

Same custody contract with confidential state via ZK accounting, MPC, an
attested vault enclave, or per-agent encrypted balances with ZK proofs of
valid deltas. Substantially more machinery; a project on its own.

### Permit2 / allowance design

Non-custodial. Funds stay in agent wallets until settlement. Settlement can
fail if allowance moved between submit and settle; needs bonded fillers or
reputation/slashing to compensate.

### Hybrid

`HecateVault` for agents who want guaranteed crossing under TEE matching;
Permit2 fallback with bonded fillers for non-custodial flow. Long-term right
answer; substantial mechanism design.

---

## 4. Onchain verifier contract

**Anchor:** `TECHNICAL_PAPER.md` §17.

### `HecateSettlementVerifier.sol` — v1 stub (landed)

A minimal Solidity adapter that proves the engine signed a given batch-
receipt body hash. Off-chain callers compute the canonical-JSON hash and
pass the resulting `bytes32` + 65-byte signature; the contract recovers via
`ecrecover` and compares to the expected engine address. Forge test suite
(9 cases) covers honest verification + tampers + bad inputs. Lives at
[`contracts/HecateSettlementVerifier.sol`](../contracts/HecateSettlementVerifier.sol).

A Forge deploy script (`contracts/script/Deploy.s.sol`) lets you deploy to
Sepolia or local anvil. A TS broadcast script
(`scripts/onchain-verify.ts`, `npm run onchain:verify`) calls
`verifyAndEmit` against the deployed contract from a real saved bundle,
emitting an on-chain `ReceiptVerified(bytes32, address)` event. Tested
end-to-end against local anvil; production Sepolia deploy is one
`forge script ... --broadcast --verify` command — see
[contracts/README.md §Deploying](../contracts/README.md#deploying).

### Full on-chain re-verification (future)

Reproduce `verifyFullBatch` on chain — canonical-JSON hash recomputation
from typed fields, settlement recomputation, conservation invariants via
arithmetic. Lets a third party assert "this batch was correctly settled by
the attested engine" without trusting any off-chain step. Practical only
after the EIP-712 migration in §5 (canonical JSON in Solidity is impractical).

---

## 5. Signing scheme

### EIP-712 typed-data migration

**Anchor:** `shared/crypto/signing.ts` v1 signing-format docstring (TODO note).

**Current:** raw `keccak256(canonicalJson(envelope))` over a canonicalized
envelope. Works for autonomous-agent runtimes but not wallet UX flows.

**Future:** EIP-712 typed data so wallet UX can sign envelopes with a
structured-data prompt. Receipts would need a versioned envelope format;
v1 receipts would not verify under the new scheme.

---

## 6. Multi-asset markets

**Anchor:** `TECHNICAL_PAPER.md` §17.

v1 is ETH/USDC only — schema enforces it. Adding a second market introduces:

- Routing across markets.
- Cross-asset netting.
- A reference-price source per market for `max_price_impact_bps`.
- Aggregation across markets in the same batch.

Each one a substantial design step. Out of scope for v1.

---

## 7. Privacy strengthening

### Anonymous submission

**Anchor:** `TECHNICAL_PAPER.md` §17.

The envelope reveals `agent_id`. Anonymous submission would require blind
submission with reveal-on-fill mechanics; non-trivial and changes the
verifier surface.

### Behavioral-fingerprint resistance

**Anchor:** `THREAT_MODEL.md` §4.3.

Patterns in submission timing, batch participation, fill ratios, and
unfilled-reason distributions can fingerprint agents. v1 does not address.
Mitigations: rate normalization, dummy intents, anonymous submission.

### TEE + threshold encryption hybrid

Two-layer confidentiality. The enclave is one of several decryption
participants. Raises the bar for confidentiality breach beyond TEE
compromise.

### Private solver quotes

If a future version reintroduces solvers/fillers, they should quote into the
enclave without seeing constraints in plaintext. Naive solver integration
would defeat the v1 privacy property.

### Dual-flow batch auctions

Public and private intent flows in one batch with a documented mixing rule.

---

## 8. Principal-policy audit

**Anchor:** `TECHNICAL_PAPER.md` §17, `THREAT_MODEL.md` §4.12.

**Problem:** the agent's local strategy compiler is outside Hecate's trust
boundary. The matcher executes whatever constraints arrive in the private
payload. For agent-managed funds, principals want assurance that the agent
stayed within authorized policy.

**Future fix:**

- A principal-approved policy hash committed on-chain or in a registry.
- A *compiler receipt* signed by the agent runtime asserting the compiled
  intent was derived from an approved policy.
- A *compiled-intent hash* in the public envelope that links each intent
  back to its principal-approved policy.

This addresses "did the agent stay within authorized policy?" — a different
question from "did the matcher follow the rules?" — and is important for
delegated-fund use cases.

---

## 9. Protocol fees

**Anchor:** `TECHNICAL_PAPER.md` §13.3 conservation note.

v1 has no protocol fees, so conservation is `Σ base_delta = 0` and
`Σ quote_delta = 0` exactly. If fees are added, conservation must include
fee-recipient deltas:

`Σ base_delta = 0` across `{agents ∪ fee_recipients}`.

The `SettlementObject` schema would need a `fee_deltas` field. The verifier's
conservation check (currently in `buildSettlementObject`) would need to
include them.

---

## 10. Matcher refinements

### O(N²) → faster candidate evaluation

`clearUniform` evaluates every candidate price (one per submitted limit) at
O(N) cost — overall O(N²) per batch. Fine for v1 demo; would need
optimization at production scale.

### Min-fill iteration cap

`shared/matching/uniformClearing.ts` documents that the iterative tightening
loop may return `BATCH_FAILED` on pathological min-fill configurations
even if a feasible matching exists. v1 acceptable; a more sophisticated
algorithm (or a different matching mechanism altogether) could close this.

### Candidate price synthesis

v1 candidate prices are exactly the union of submitted limit prices. A
midpoint synthesis or other continuous-price exploration could improve
clearing fairness, at the cost of more complex tie-break specification.

---

## 11. Documentation and tooling

### Operator runbook

How to deploy and operate a Hecate instance: env, persistence backups,
monitoring, log rotation, key rotation, incident response. v1 ships a demo,
not an operator manual.

### Agent SDK

A small client library that handles canonicalization, signing, encryption,
challenge construction. The simulator's `runDemo.ts` is a working
reference; a packaged SDK would make it easier to integrate.
