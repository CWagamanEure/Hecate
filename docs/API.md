# Hecate API

HTTP surface as shipped in v1. Backed by Fastify; bodies are JSON;
request/response shapes are Zod-validated at boundaries.

Base URL defaults to `http://127.0.0.1:8787` (overridable via `HOST` / `PORT`).

All error responses use a single envelope:

```json
{
  "ok": false,
  "error": { "code": "<CODE>", "detail": "<human-readable>" }
}
```

No stack traces are returned; `code` is from a closed catalogue
([RejectReason](../shared/schemas/enums.ts) plus a small set of API-specific
codes documented per endpoint).

---

## Endpoint catalog

### `GET /healthz`

**Purpose:** liveness probe.
**Auth:** public.
**Response 200:**
```json
{ "ok": true, "runtime_mode": "LOCAL_MOCK" }
```

---

### `GET /attestation`

**Purpose:** runtime metadata + engine signer address. The first thing a
client should fetch.
**Auth:** public.
**Response 200:**
```json
{
  "runtime": {
    "runtime_mode": "LOCAL_MOCK",
    "engine_code_digest": "sha256:dev-local",
    "eigencompute_app_id": null,
    "eigencompute_image_digest": null,
    "eigencompute_attestation_id": null
  },
  "engine_address": "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  "matching_rule": "UNIFORM_CLEARING_PRICE_V1",
  "markets": ["ETH/USDC"],
  "warning": "LOCAL_MOCK runtime — payload encryption is architectural, not security."
}
```
Under `EIGEN_TEE` the eigen fields are non-null and `warning` is `null`.

---

### `GET /markets`

**Purpose:** supported markets.
**Auth:** public.
**Response 200:**
```json
[{ "symbol": "ETH/USDC", "status": "OPEN" }]
```

---

### `GET /vault/:agent_id`

**Purpose:** read an agent's vault entry.
**Auth:** **dev-only in v1 LOCAL_MOCK.** Documented limitation; production
deployment must require authenticated/owner-gated access. The `/attestation`
warning surfaces this.
**Response 200:** `{ ok: true, vault: AgentVault }`. Returns a zero vault
if the agent has no entry (no 404).

---

### `POST /vault/mock-deposit`

**Auth:** dev-only in v1.
**Body:**
```json
{ "agent_id": "0x...", "asset": "ETH" | "USDC", "amount": "10" }
```
**Response 200:** `{ ok: true, vault: AgentVault }`.
**Errors:** `400 INVALID_REQUEST` (Zod), `400 INVALID_AMOUNT` (amount = 0).

---

### `POST /vault/mock-withdraw`

**Auth:** dev-only in v1.
**Body:** same shape as mock-deposit.
**Response 200:** `{ ok: true, vault: AgentVault }`.
**Errors:** `400 INVALID_REQUEST`, `400 INVALID_AMOUNT`,
`400 UNKNOWN_AGENT`, `400 INSUFFICIENT_FUNDS` (cannot reach reserved funds).

---

### `POST /intents`

**Purpose:** submit a signed envelope for acceptance.
**Auth:** envelope's own secp256k1 signature (recovered to `agent_id`).
**Body:** [`PublicEnvelope`](../shared/schemas/intent.ts) JSON.
**Response 200:**
```json
{ "ok": true, "intent_id": "intent_001", "status": "OPEN" }
```
**Errors (400):** `INVALID_REQUEST`, `INVALID_SIGNATURE`, `EXPIRED`,
`MALFORMED_PAYLOAD`, `INVALID_PAYLOAD_COMMITMENT`, `UNKNOWN_AGENT`,
`DUPLICATE_NONCE`, `INSUFFICIENT_FUNDS`.

The server normalizes `agent_id` to EIP-55 before persisting. Acceptance runs
the full pipeline: signature + expiry → decrypt → commitment → reservation.
On accept, the intent enters the in-memory ready pool with its decrypted
payload cached.

---

### `POST /intents/:id/status`  *(owner-gated)*

**Purpose:** read the lifecycle status of an intent the caller owns.
**Auth:** signed challenge (see [§Signed challenge protocol](#signed-challenge-protocol)) with `action: "GET_INTENT_STATUS"`.
**Body:** `SignedChallengeRequest`:
```json
{
  "requester": "0x...",
  "timestamp_ms": 1700000000000,
  "signature": "0x...<130 hex chars>"
}
```
**Response 200:** one of
```json
{ "ok": true, "status": "OPEN" }
{ "ok": true, "status": "FILLED", "batch_id": "batch_..." }
{ "ok": true, "status": "PARTIALLY_FILLED", "batch_id": "..." }
{ "ok": true, "status": "UNFILLED", "batch_id": "..." }
{ "ok": true, "status": "REJECTED", "reject_reason": "...", "detail": "..." }
```
**Errors:** `400 INVALID_REQUEST`, `401 STALE_REQUEST`,
`401 INVALID_REQUEST_SIGNATURE`, `403 NOT_INTENT_OWNER`, `404 INTENT_NOT_FOUND`.

---

### `POST /intents/:id/fill-receipt`  *(owner-gated)*

**Purpose:** fetch the agent's signed `FillReceipt`.
**Auth:** signed challenge with `action: "GET_FILL_RECEIPT"`.
**Body:** same `SignedChallengeRequest` shape.
**Response 200:**
```json
{ "ok": true, "fill_receipt": { ... } }
```
See [docs/RECEIPTS.md](RECEIPTS.md) for `FillReceipt` field semantics.
**Errors:** `400 INVALID_REQUEST`, `401 STALE_REQUEST`,
`401 INVALID_REQUEST_SIGNATURE`, `403 NOT_RECEIPT_OWNER`,
`404 FILL_RECEIPT_NOT_FOUND`.

---

### `POST /batches/close`

**Purpose:** close the current ready pool: package, match, settle, sign.
**Auth:** none in v1 (LOCAL_MOCK demo). Production deployment would gate.
**Body (optional):**
```json
{ "batch_id": "batch_001", "market_snapshot": null | { ... } }
```
If `batch_id` is omitted, the server generates `batch_${Date.now()}`.
**Response 200 — closed:**
```json
{
  "ok": true,
  "closed": true,
  "batch_receipt": { ... },
  "fill_receipts": [ ... ],
  "settlement": { ... },
  "batch": { ... },
  "fill_plan": { ... },
  "vault_state_before_settlement": { ... },
  "vault_state_after_settlement": { ... },
  "reservation_book_before_settlement": { ... },
  "reservation_book_after_settlement": { ... }
}
```
**Response 200 — nothing to close:**
```json
{ "ok": true, "closed": false }
```

The full bundle is returned for v1 LOCAL_MOCK demo convenience so the
simulator can post it to `/receipts/verify` without hand-collecting artifacts.
A production EIGEN_TEE deployment would not include `fill_receipts` here;
agents would fetch their own via the owner-gated endpoint.

---

### `GET /batches/:id/receipt`

**Purpose:** public batch receipt lookup by `batch_id`.
**Auth:** public.
**Response 200:** `{ ok: true, batch_receipt: BatchReceipt }`.
**Error:** `404 BATCH_NOT_FOUND`.

The batch receipt itself does not contain decrypted payloads or per-agent
fill data. Per-agent fill receipts are owner-gated and fetched separately.

---

### `POST /receipts/verify`

**Purpose:** stateless verification of a full artifact bundle.
**Auth:** none.
**Body:** [`VerifyFullBatchRequest`](../shared/schemas/api.ts) — every field
required, including the supporting artifacts (vault snapshots, reservation
snapshots, settlement, batch, fillPlan) and `expectedEngineAddress`.
**Response 200:** [`VerifyResult`](../shared/schemas/verify.ts):
```json
{ "ok": true }
{ "ok": false, "failures": [{ "code": "...", "path": "...", "detail": "..." }] }
```
The verifier recomputes every receipt body field from the supplied artifacts
and reports any mismatch. See [docs/RECEIPTS.md](RECEIPTS.md) §Verification
for the failure code catalogue.

---

## Signed challenge protocol

Owner-gated endpoints accept a body shaped like `SignedChallengeRequest`:

```ts
{
  requester:    "0x..." (HexAddress),    // claimed signer
  timestamp_ms: <number>,                 // ms epoch, ±60s of server time
  signature:    "0x..." (Hex65)           // 65 bytes r||s||v, v ∈ {27, 28}
}
```

The signature is over `keccak256(canonicalJson(challenge))` where:

```ts
challenge = {
  action:       "GET_FILL_RECEIPT" | "GET_INTENT_STATUS",
  intent_id:    "<the URL :id>",
  timestamp_ms: <same as outer body>
}
```

**Three independent bindings:**

1. **Key ↔ requester.** The signer recovered from `signature` must equal
   `normalizeAddress(requester)`. A different signer → `INVALID_REQUEST_SIGNATURE`.
2. **Action ↔ endpoint.** A signature for `GET_INTENT_STATUS` cannot be
   replayed at the `/fill-receipt` endpoint because the action field is in
   the canonicalized hash.
3. **intent_id ↔ URL.** A signature for `intent_a` cannot fetch `intent_b`
   even if both are owned by the same agent. The URL `:id` is fed into the
   challenge that the verifier reconstructs, so a mismatch flips the hash.

**Time window.** `Math.abs(now_ms - timestamp_ms) <= 60_000`. Outside that:
`401 STALE_REQUEST`. Use `Date.now()` on the client.

**Owner check.** If the signature is valid but the recovered/declared
`requester` is not the receipt's owner → `403 NOT_RECEIPT_OWNER` (or
`NOT_INTENT_OWNER` for status).

### Client-side example

```ts
import {
  canonicalJson, keccak256Hex, signHash,
  privateKeyToAddress
} from "@shared/crypto";

function buildChallenge(action: "GET_FILL_RECEIPT" | "GET_INTENT_STATUS",
                       intent_id: string, pk: string) {
  const ts = Date.now();
  const hash = keccak256Hex(canonicalJson({ action, intent_id, timestamp_ms: ts }));
  return {
    requester: privateKeyToAddress(pk),
    timestamp_ms: ts,
    signature: signHash(hash, pk)
  };
}

const body = buildChallenge("GET_FILL_RECEIPT", "intent_001", agentPrivateKey);
const r = await fetch(`${baseUrl}/intents/intent_001/fill-receipt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
```

The simulator's [`signChallenge`](../agents/runDemo.ts) helper is a working
reference.

---

## Status codes

| Code | Used for |
|---|---|
| 200 | Success (including `verifyFullBatch` with `ok: false` — the verification ran, the body is the result) |
| 400 | Client error: schema parse, RejectReason, INSUFFICIENT_FUNDS on withdraw, INVALID_AMOUNT |
| 401 | Signed challenge invalid: INVALID_REQUEST_SIGNATURE, STALE_REQUEST |
| 403 | Authorization: NOT_RECEIPT_OWNER, NOT_INTENT_OWNER |
| 404 | Not found: INTENT_NOT_FOUND, FILL_RECEIPT_NOT_FOUND, BATCH_NOT_FOUND |
| 500 | Internal — wrapped to a structured error envelope; never leaks stack traces |

---

## Body limits

The Fastify instance is configured with a **10 MB body limit** to accommodate
the full artifact bundle on `/receipts/verify`.
