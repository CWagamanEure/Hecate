# Receipts

Receipts are Hecate's primary integrity artifact. Every claim downstream — that
matching followed the rules, that solvency was preserved, that the engine was
the attested binary — is anchored in a signed receipt that any third party can
re-derive from canonical inputs.

Two receipt types in v1:

1. **`BatchReceipt`** — public. One per closed batch. Commits to all batch
   intents, payload commitments, vault state transitions, reservation book
   transitions, and the settlement object. Engine-signed.
2. **`FillReceipt`** — private per-agent. One per intent in a batch. Commits to
   the intent's outcome, the residual reservation released back to the agent,
   the runtime metadata, and the same engine signing key.

---

## 1. `BatchReceipt`

Schema: [shared/schemas/receipt.ts](../shared/schemas/receipt.ts). Top-level shape:

```ts
{
  batch_id:                          "batch_001",
  market:                            "ETH/USDC",
  matching_rule:                     "UNIFORM_CLEARING_PRICE_V1",
  intent_envelope_root:              "0x...32bytes",
  private_payload_commitment_root:   "0x...32bytes",
  vault_state_before_hash:           "0x...32bytes",
  vault_state_after_hash:            "0x...32bytes",
  reservation_book_before_hash:      "0x...32bytes",
  reservation_book_after_hash:       "0x...32bytes",
  settlement_hash:                   "0x...32bytes",
  num_intents:                       3,
  num_matched:                       3,
  clearing_price:                    "3590",
  timestamp_ms:                      1700000000000,
  runtime: {
    runtime_mode:                    "LOCAL_MOCK" | "EIGEN_TEE",
    engine_code_digest:              "sha256:...",
    eigencompute_app_id:             null | string,
    eigencompute_image_digest:       null | string,
    eigencompute_attestation_id:     null | string
  },
  engine_signature:                  "0x...65bytes"
}
```

### What each field commits to

| Field | Commits to | How a verifier re-derives |
|---|---|---|
| `intent_envelope_root` | The full set of public envelopes in canonical batch order. | `orderedAggregateHash(envelopes_in_batch_order)` |
| `private_payload_commitment_root` | Each intent's payload commitment, in batch order. | `orderedAggregateHash(batch.intents.map(i => hashPayload(i.payload)))` |
| `vault_state_before_hash` | Vault state at batch close, with this batch's reservations already applied. | `hashVaultState(input.vaultStateBeforeSettlement)` |
| `vault_state_after_hash` | Vault state after settlement deltas applied + reservations released. | `hashVaultState(input.vaultStateAfterSettlement)` |
| `reservation_book_before_hash` | Reservations in `RESERVED` status going into settlement. | `hashReservationBook(book_before)` |
| `reservation_book_after_hash` | Reservations after settlement (`SETTLED` for filled, `RELEASED` for unfilled). | `hashReservationBook(book_after)` |
| `settlement_hash` | The canonical `SettlementObject` (fills + per-asset vault deltas). | `hashSettlement(settlement)` |
| `num_intents` | `batch.intents.length`. | Direct count. |
| `num_matched` | Count of intents with `(FILLED OR PARTIALLY_FILLED) AND filled_base > 0`. | Recomputed from `fillPlan.fills`. |
| `clearing_price` | The selected clearing price (or `"0"` for no-cross / BATCH_FAILED). | From `fillPlan.clearing_price`. |
| `runtime` | Execution context (mode + code digest + Eigen metadata). | Pass-through; coherence checked by verifier. |

### Roots use BatchInput order, not sorted order

`orderedAggregateHash` is called without a `sortBy`, preserving the canonical
price-time order from `buildBatchFromReadyIntents` (sorted by
`(received_ms, intent_id)`). Switching to a sort-by would be a breaking
protocol change.

### Engine signature scope

`engine_signature` is `signHash(hashBatchReceiptBody(body), engineKey)` —
i.e. signs the hash of the body's canonical JSON without `engine_signature`
itself. Mutating any other field changes the body hash; recovery either yields
a different address or throws (curve-point off-curve from the byte flip). Both
outcomes invalidate the receipt.

### v1 settlement-lifecycle convention

`vault_state_before_hash` is taken **after** all reservations for this batch
have been applied (because reservations happen at intent submission, not at
batch close — Ticket 7 decision). The receipt covers the *settlement*
lifecycle, not the full submission lifecycle. To audit reservation activity
between two batches, compare receipt N's `vault_state_after_hash` to receipt
N+1's `vault_state_before_hash`.

---

## 2. `FillReceipt`

Schema: same file. Shape:

```ts
{
  intent_id:               "intent_001",
  batch_id:                "batch_001",
  agent_id:                "0x...",
  status:                  "FILLED" | "PARTIALLY_FILLED" | "UNFILLED" | "EXPIRED" | "INVALID" | "INSUFFICIENT_FUNDS",
  filled_base:             "10",
  filled_quote:            "35900",
  clearing_price:          "3590",
  constraints_satisfied:   true,
  unfilled_reason:         null | "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT" | "MIN_FILL_NOT_MET" | "MAX_PRICE_IMPACT_VIOLATED" | "EXPIRED_BEFORE_FILL" | "BATCH_FAILED",
  payload_commitment:      "0x...32bytes",
  reserved_released: { ETH: "0", USDC: "80" },
  runtime:                 { ... same shape as BatchReceipt.runtime ... },
  engine_signature:        "0x...65bytes"
}
```

### `constraints_satisfied`

Locked semantics ([`fillReceipt.ts`](../shared/receipts/fillReceipt.ts)):

| `status` | `constraints_satisfied` is `true` iff |
|---|---|
| `FILLED` | `filled_base == max_base_amount` AND clearing price respects `limit_price` AND impact respected |
| `PARTIALLY_FILLED` | `min_base_fill_amount ≤ filled_base < max_base_amount` AND clearing respects limit + impact |
| `UNFILLED` | `unfilled_reason` is non-null and not `BATCH_FAILED` |
| `BATCH_FAILED` | always `false` |
| `EXPIRED` / `INVALID` / `INSUFFICIENT_FUNDS` | always `false` (these reach the matcher only via upstream bug) |

`UNFILLED` with a known reason has `constraints_satisfied = true` because the
engine correctly *refused* to fill on terms the agent didn't authorize. The
constraint was respected, in the sense that no fill happened at violating
terms.

### `reserved_released`

Per-asset map of how much of the original reservation was returned to the
agent's available balance.

| Side | Reservation | Spent | `reserved_released.ETH` | `reserved_released.USDC` |
|---|---|---|---|---|
| **SELL** | `max_base_amount` ETH | `filled_base` ETH | `reservation - filled_base` | `"0"` |
| **BUY** | `ceil(max * limit)` USDC | `filled_quote` USDC | `"0"` | `reservation - filled_quote` |
| **UNFILLED** (either side) | full | 0 | full reservation amount | full reservation amount |

`subDecimal` underflow in this calculation throws — that would mean the
matcher emitted a fill exceeding the reservation, which is an engine bug.
Defensive only; should never happen.

### `runtime` is shallow-copied per receipt

`{ ...runtime }` per receipt so a caller mutating their `RuntimeMetadata`
object after `buildFillReceipts` cannot retroactively affect already-built
receipts.

### Owner-gated access

Fill receipts are not public. Agents fetch their own via
`POST /intents/:id/fill-receipt` with a signed challenge — see
[API.md](API.md). A public batch receipt does not contain any per-agent
fill data, only the aggregate roots and hashes.

---

## 3. Verification

Three entry points, all pure ([shared/verify/verifyEngine.ts](../shared/verify/verifyEngine.ts)):

```ts
verifyBatchReceipt(input):  VerifyResult
verifyFillReceipt(input):   VerifyResult
verifyFullBatch(input):     VerifyResult
```

`VerifyResult = { ok: true } | { ok: false, failures: VerifyFailure[] }`.

### Verifier flow (`verifyFullBatch`)

1. Verify the `BatchReceipt` (signature → runtime coherence → recompute body
   via `buildBatchReceiptBody({...input, runtime: receipt.runtime})` →
   field-by-field comparison).
2. Index `fillReceipts` by `intent_id`; flag duplicates and missing entries.
3. For each `FillReceipt`: `batch_id` matches, runtime equals batch's runtime,
   then `verifyFillReceipt` (signature → coherence → lookup intent + fill →
   recompute body via `buildFillReceiptBodies` → field comparison).
4. Cross-check `batchReceipt.num_matched` against the count derived from fill
   receipts.
5. Recompute `buildSettlementObject(batch, fillPlan)` and compare hashes.

Failures are aggregated. Path prefixes: `/batchReceipt/...` for batch-level,
`/fillReceipts/<intent_id>/...` for fill-level.

### Failure code catalogue

| Code | Meaning |
|---|---|
| `BATCH_SIGNATURE_INVALID` | `recoverBatchReceiptSigner` threw (malformed signature). |
| `FILL_SIGNATURE_INVALID` | Same, for fill receipt. |
| `ENGINE_SIGNER_MISMATCH` | Signature recovered cleanly but to a different address than `expectedEngineAddress`. (Mutually exclusive with `*_SIGNATURE_INVALID` per recovery attempt.) |
| `BATCH_RECEIPT_FIELD_MISMATCH` | Re-derived body field differs from receipt; `path` identifies the field. |
| `FILL_RECEIPT_FIELD_MISMATCH` | Same, for fill receipt. |
| `RUNTIME_COHERENCE_INVALID` | LOCAL_MOCK with non-null Eigen field, OR EIGEN_TEE with null Eigen field. |
| `BUILD_BATCH_RECEIPT_THREW` | `buildBatchReceiptBody` threw on the supplied artifacts. |
| `BUILD_FILL_RECEIPT_THREW` | `buildFillReceiptBodies` threw. |
| `FILL_RECEIPT_NO_BATCH_INTENT` | Receipt's `intent_id` not in batch. |
| `FILL_RECEIPT_NO_FILL_ENTRY` | Receipt's `intent_id` not in fillPlan. |
| `MISSING_FILL_RECEIPT` | A batch intent has no fill receipt. |
| `EXTRA_FILL_RECEIPT` | A fill receipt's `intent_id` is not in the batch. |
| `DUPLICATE_FILL_RECEIPT` | Two fill receipts share an `intent_id`. |
| `FILL_RECEIPT_BATCH_ID_MISMATCH` | Fill receipt's `batch_id` ≠ batch receipt's `batch_id`. |
| `FILL_RECEIPT_RUNTIME_MISMATCH` | Fill receipt's `runtime` differs from batch receipt's `runtime`. |
| `NUM_MATCHED_INCONSISTENT_WITH_FILL_RECEIPTS` | `batchReceipt.num_matched` ≠ derived count. |
| `SETTLEMENT_RECOMPUTE_MISMATCH` | `hashSettlement(buildSettlementObject(batch, fillPlan)) ≠ hashSettlement(input.settlement)`. |
| `SETTLEMENT_RECOMPUTE_FAILED` | `buildSettlementObject` threw. |

### Verifier recomputes, never trusts

The verifier feeds `receipt.runtime` back into `buildBatchReceiptBody` so the
recomputed body's `runtime` field matches by construction. Runtime tampering
is caught by the signature step (mutating runtime changes the body hash;
recovery returns a different address or throws). Runtime *coherence* is
checked separately, regardless of whether the signature happens to verify.

### Authority binding (Ticket 14 / 17b)

Even if an attacker rebuilds the batch receipt body using a tampered
supporting artifact (so field comparison passes) and re-signs with a
different key, `ENGINE_SIGNER_MISMATCH` fires because the recovered signer
no longer matches the engine address.
[`tests/adversarial.receipts.test.ts`](../tests/adversarial.receipts.test.ts)
demonstrates the full-batch variant.

---

## 4. Tamper-detection guarantees

Mutations to any of the following invalidate `verifyFullBatch`:

- Any scalar field on `BatchReceipt` body (`clearing_price`, root hashes,
  vault hashes, reservation book hashes, settlement hash, num counts,
  timestamp, matching rule, market, batch id).
- Any scalar field on any `FillReceipt` (status, fill amounts,
  `constraints_satisfied`, `payload_commitment`, `reserved_released.{ETH,USDC}`,
  agent_id).
- Any field on `RuntimeMetadata` (mode, digest, eigen fields).
- `engine_signature` on either receipt.
- Any supporting artifact (`vault_state_*`, `reservation_book_*`,
  `settlement.fills`, `settlement.vault_deltas`, `batch.intents`).

The mutation table in [`tests/adversarial.receipts.test.ts`](../tests/adversarial.receipts.test.ts)
encodes one assertion per mutation kind.

---

## 5. Hashing functions involved

All hashing routes through canonical-JSON serialization
([`shared/crypto/canonicalJson.ts`](../shared/crypto/canonicalJson.ts)) and
keccak256 ([`shared/crypto/hashing.ts`](../shared/crypto/hashing.ts)).
Helpers used by receipts:

- `hashPayload(payload)`
- `hashEnvelope(envelope)` — used by leaf builders if needed
- `envelopeSigningHash(envelope)` — agent signing path
- `hashVaultState(state)`
- `hashReservationBook(book)` — defensive sort by `intent_id` before hashing
- `hashSettlement(settlement)`
- `hashBatchReceiptBody(receipt)` — strips `engine_signature` defensively
- `hashFillReceiptBody(receipt)` — same
- `orderedAggregateHash(items, opts?)` — `opts.sortBy` optional; receipts use
  no sortBy (preserves BatchInput order)

Generic signing primitives:

- `signHash(hashHex, pk)` — secp256k1 over a 32-byte hash
- `recoverHashSigner(hashHex, sig)` — recovers EIP-55 checksum address
