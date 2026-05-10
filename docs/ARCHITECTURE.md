# Hecate Architecture

System overview for the v1 implementation. Pairs with [TECHNICAL_PAPER.md](TECHNICAL_PAPER.md)
(design intent) and [API.md](API.md) (the surface).

---

## 1. Components

```
┌────────────────────────┐         ┌──────────────────────────┐
│ Agent simulator (CLI)  │ ─HTTP─► │ Intent API (Fastify)     │
│ agents/simulator.ts    │         │ server/                  │
└────────────────────────┘         └──────────────┬───────────┘
                                                  │
                ┌─────────────────────────────────┼──────────────────────────────────┐
                │                                 │                                  │
                ▼                                 ▼                                  ▼
   ┌────────────────────┐          ┌──────────────────────────┐         ┌────────────────────────┐
   │ Solvency layer     │          │ Matching engine          │         │ Receipt + verify       │
   │ shared/vault/      │          │ shared/matching/         │         │ shared/receipts/       │
   │ - mockVault        │          │ - acceptIntent           │         │ - buildBatchReceipt    │
   │ - reservations     │          │ - buildBatchFromReady…   │         │ - buildFillReceipts    │
   │ - invariants       │          │ - clearUniform           │         │ shared/verify/         │
   └────────────────────┘          └──────────────────────────┘         │ - verifyFullBatch      │
                                                  │                     └────────────────────────┘
                                                  ▼
                                    ┌──────────────────────────┐
                                    │ Settlement               │
                                    │ shared/settlement/       │
                                    │ - buildSettlementObject  │
                                    │ - applySettlement        │
                                    └──────────────────────────┘
```

Pure modules in `shared/*` do not perform I/O. The Fastify server orchestrates
them and owns persistence. The agent simulator is the only client that
exercises the demo path end-to-end.

---

## 2. Layering

```
shared/schemas        — Zod schemas (the canonical contract)
   ↑
shared/math           — BigInt-scaled-by-10^18 decimal arithmetic
   ↑
shared/crypto         — canonicalJson, hashing, signing, mock encryption,
                        payload commitment
   ↑
shared/persistence    — JSONL append + atomic JSON snapshot helpers
   ↑
shared/vault          — mockVault, reservations, invariants
shared/matching       — acceptIntent, buildBatchFromReadyIntents, clearUniform
shared/settlement     — buildSettlementObject, applySettlement
shared/receipts       — buildBatchReceipt, buildFillReceipts
shared/verify         — verifyBatchReceipt, verifyFillReceipt, verifyFullBatch
   ↑
server/               — Fastify routes; owns persistence + ready pool + mutex
   ↑
agents/               — CLI demo simulator
```

No upward dependencies. `shared/*` modules are pure (no I/O, no globals).

---

## 3. Data flow — `POST /intents` (Model A: reserve at submission)

```
1. server/routes/intents.ts parses PublicEnvelope (Zod) and normalizes agent_id
   to EIP-55.
2. Under the global mutex:
3.   acceptIntent({ pendingIntent, vaultState, reservationBook, decrypt, now_ms })
3a.    verifyEnvelopeBasic       — secp256k1 signature over canonical envelope hash
3b.    decrypt                   — mockDecryptPayload(ct, mockEnclaveKey)
3c.    verifyPayloadCommitment    — hashPayload(payload) === envelope.payload_commitment
3d.    reserveForIntent          — vault gate (UNKNOWN_AGENT / DUPLICATE_NONCE / INSUFFICIENT_FUNDS)
4.   On success:
4a.    appendJsonl   intents.jsonl
4b.    writeJsonAtomic  vault.json
4c.    writeJsonAtomic  reservations.json
4d.    state.readyPool.set(intent_id, ready_intent)
5.   On rejection:
5a.    appendJsonl   rejections.jsonl  (no vault/reservation mutation)
6. Return { ok, intent_id, status: "OPEN" } or 400 with reject_reason.
```

The "reserve at submission" decision (Ticket 7) means by the time the intent
enters the in-memory ready pool, it is already economically valid and
non-double-spendable. Subsequent batch close becomes pure packaging.

---

## 4. Data flow — `POST /batches/close`

```
1. server/routes/batches.ts parses CloseBatchRequest.
2. Under the global mutex:
3.   readyIntents = Array.from(state.readyPool.values())
4.   buildBatchFromReadyIntents({ batch_id, readyIntents, now_ms, market_snapshot })
        — pure packager: sorts (received_ms ASC, intent_id ASC), produces BatchInput
5.   if batch_input === null: return { closed: false }
6.   snapshot vaultBefore, bookBefore  (state immediately before settlement)
7.   fillPlan = clearUniform(batch_input)
8.   apply = applySettlement({ batch_input, fillPlan, vaultBefore, bookBefore })
9.   batch_receipt = buildBatchReceipt(...)        — engine-signed
10.  fill_receipts = buildFillReceipts(...)         — per-agent engine-signed
11.  Persistence (logs first, then atomic snapshots):
11a.   appendJsonl       batches.jsonl
11b.   appendJsonl × N   receipts.jsonl
11c.   writeJsonAtomic   vault.json   (post-settlement)
11d.   writeJsonAtomic   reservations.json (post-settlement; SETTLED/RELEASED)
12.  Update in-memory state; clear processed intent_ids from ready pool.
13.  Return the full bundle (LOCAL_MOCK demo convenience; production would
     limit to public batch receipt + agent-fetched fills).
```

---

## 5. Module dependency graph (concrete)

```
schemas/{decimal,hex,enums,intent,payload,vault,reservation,batch,
         fillPlan,settlement,runtime,receipt,verify,api,persistence}

math/decimal
   └── used by: schemas/decimal (decCmp re-export), vault, matching,
       settlement, receipts, verify

crypto/canonicalJson
crypto/hashing       (depends on canonicalJson)
crypto/signing       (depends on hashing; v1 wires @noble/secp256k1's HMAC-SHA256)
crypto/mockEncryption (uses node:crypto AES-GCM; uses canonicalJson)
crypto/payloadCommitment (uses hashing)

persistence/{paths, jsonl, stateFiles}

vault/{mockVault, reservations, invariants}
   └── uses crypto (normalizeAddress), math/decimal, schemas/*

matching/intentAcceptance     uses crypto, vault
matching/batchBuilder         uses schemas only
matching/uniformClearing      uses math, schemas

settlement/buildSettlement    uses crypto, math, schemas
settlement/applySettlement    uses settlement/buildSettlement, vault

receipts/fillReceipt          uses crypto, math, schemas
receipts/batchReceipt         uses crypto, math, schemas

verify/verifyEngine           uses receipts, settlement, crypto, math, schemas

server/runtime                uses crypto, persistence, schemas
server/state                  schemas types only
server/auth                   uses crypto, schemas
server/buildApp               uses fastify, all server routes
server/routes/*               uses everything as needed
server/index                  uses runtime + buildApp

agents/runDemo                uses crypto + persistence (FILES) + types only
agents/simulator              uses runDemo
```

---

## 6. Persistence model

| File | Format | Purpose | Mutation |
|---|---|---|---|
| `data/intents.jsonl` | JSONL | Accepted intents (envelope + received_ms) | append-only |
| `data/rejections.jsonl` | JSONL | Rejected intents (envelope + reason + detail) | append-only |
| `data/batches.jsonl` | JSONL | One entry per closed batch (BatchReceipt + Settlement + fill_receipt_intent_ids) | append-only |
| `data/receipts.jsonl` | JSONL | Per-agent FillReceipt | append-only |
| `data/vault.json` | JSON snapshot | Current VaultState | atomic rename |
| `data/reservations.json` | JSON snapshot | Current ReservationBook | atomic rename |

**Persistence ordering rule:** logs first, then atomic snapshot replacements.
If the process crashes between log append and snapshot write, log entries are
slightly ahead of state. Documented v1 limitation; logs are append-only so
partial entries are detectable on read.

**Schema validation everywhere:** every read goes through Zod
(`readJsonl(path, schema, opts)` and `readJsonFile(path, schema, opts)`).
Malformed lines fail loudly with `path:line` in the error.

---

## 7. Concurrency model

**Single global FIFO mutex** (`server/state.ts`) wraps every state-mutating
handler. Two concurrent `POST /intents` calls from the same agent with the
same nonce: one wins, the other gets `DUPLICATE_NONCE`. Confirmed under
load by `tests/adversarial.api.test.ts`.

Out of scope for v1: multi-process write contention, cross-host coordination,
distributed locking. The data files are not safe to share across processes.

---

## 8. Pure-function discipline

Modules under `shared/` are deliberately pure:

- No file I/O.
- No `Date.now()` in pure logic (passed in as `now_ms`).
- No global mutable state.
- All inputs are read-only; outputs are fresh objects.

The server boundary (`server/routes/*`) is where I/O happens. This makes the
core logic trivially testable and lets the verifier recompute receipts from
the same canonical inputs.

---

## 9. Key design decisions (cross-reference)

| Decision | Where |
|---|---|
| EIP-55 normalization before signing hash | Ticket 5 / `signing.ts canonicalizeEnvelopeForSigning` |
| Reserve at intent submission, not batch close | Ticket 7 / `acceptIntent` |
| `BatchInput` is pure matcher input (no `vault_before`) | Ticket 9 / `schemas/batch.ts` |
| Receipt commits to `reservation_book_before/after_hash` | Ticket 7b Option C / `schemas/receipt.ts` |
| Owner-gated per-intent endpoints via signed challenge | Ticket 15 / `server/auth.ts` |
| Generic `signHash` / `recoverHashSigner` primitives | Ticket 11 / `signing.ts` |
| `buildFillReceiptBodies` extracted for verifier reuse | Ticket 14 / `fillReceipt.ts` |
| Default-seed deterministic property tests | Ticket 17b / `tests/adversarial/seededRng.ts` |

---

## 10. v1 limitations anchored in code

- **In-memory ready pool.** Server crash between accept and batch close loses
  decrypted payloads. Reservations persist. See
  `tests/adversarial.api.test.ts` (`ready-pool restart limitation`) for the
  test that anchors this.
- **LOCAL_MOCK encryption.** AES-GCM with a CODE_DIGEST-derived key. Process-
  readable. See `shared/crypto/mockEncryption.ts` top-of-file warning.
- **No live Eigen attestation.** `EIGEN_TEE` strict-stubs at startup. Real
  attestation chain verification on the [roadmap](ROADMAP.md).
- **Matcher iteration cap.** `clearUniform`'s allocation loop can return
  `BATCH_FAILED` on pathological min-fill configurations even when a feasible
  matching exists. Documented in `shared/matching/uniformClearing.ts`.
- **Single market.** ETH/USDC only.
