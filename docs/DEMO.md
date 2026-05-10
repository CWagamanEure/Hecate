# Hecate Demo

End-to-end walkthrough using the bundled simulator. Pairs with [API.md](API.md)
(endpoint catalog) and [RECEIPTS.md](RECEIPTS.md) (what the bundle contains).

---

## Prerequisites

- Node 20 or later.
- `npm install` completed in the repo root.

## One-time setup

Either copy `.env.example` to `.env` and edit, or export the variables in your
shell. The minimum:

```sh
export ENGINE_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
export CODE_DIGEST=sha256:dev-local
export DATA_DIR=./data
export RUNTIME_MODE=LOCAL_MOCK
```

The default `ENGINE_PRIVATE_KEY` (`0x...01`) is a dev key. It carries no
production weight; receipts under `LOCAL_MOCK` are research artifacts.

---

## Run the demo

In two terminals:

**Terminal 1** — start the server:

```sh
npm run dev
```

The server logs:

```
hecate listening on 127.0.0.1:8787 (runtime=LOCAL_MOCK)
⚠ LOCAL_MOCK — payload encryption is architectural, not security.
```

**Terminal 2** — run the simulator:

```sh
npm run simulate -- --reset-demo-state --data-dir ./data
```

`--reset-demo-state --data-dir ./data` deletes the demo files in `./data` so
balances start clean. Without it, prior runs leave state and the simulator
warns about stale balances.

---

## Expected output (condensed)

```
============================================================
Hecate demo
LOCAL_MOCK demo only. No real funds. Mock encryption is architectural, not confidentiality.
============================================================
  reset demo state in ./data

Attestation:
  runtime_mode:       LOCAL_MOCK
  engine_address:     0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
  engine_code_digest: sha256:dev-local
  signer.mode:        LOCAL_DEV_KEY
  matching_rule:      UNIFORM_CLEARING_PRICE_V1
  market:             ETH/USDC
  warning:            LOCAL_MOCK runtime — payload encryption is architectural, not security.

Deposits:
  ✓ deposited 10 ETH for Agent A (0x2B5AD5...)
  ✓ deposited 20000 USDC for Agent B (0x6813Eb...)
  ✓ deposited 30000 USDC for Agent C (0x1efF47...)
  ✓ deposited 100 USDC for Agent D (0xe1AB81...)

Intent submissions:
  ✓ Agent A accepted (intent_id=intent_Agent_A_...)
  ✓ Agent B accepted (intent_id=intent_Agent_B_...)
  ✓ Agent C accepted (intent_id=intent_Agent_C_...)
  × Agent D rejected: INSUFFICIENT_FUNDS intent ... requires 3600 USDC, available 100

Batch close:
  ✓ batch closed: clearing_price=3590, num_matched=3
  intent_Agent_A_... FILLED filled_base=10 reserved_released={"ETH":"0","USDC":"0"}
  intent_Agent_B_... FILLED filled_base=4 reserved_released={"ETH":"0","USDC":"80"}
  intent_Agent_C_... PARTIALLY_FILLED filled_base=6 reserved_released={"ETH":"0","USDC":"7180"}
  bundle_id:        0x...

Verification:
  ✓ full-bundle verification: ok

Owner-gated access:
  ✓ Agent A fetched their own fill receipt
  ✓ Agent A status (FILLED) matches fill receipt
  ✓ Agent B fetched their own fill receipt
  ✓ Agent B status (FILLED) matches fill receipt
  ✓ Agent C fetched their own fill receipt
  ✓ Agent C status (PARTIALLY_FILLED) matches fill receipt
  ✓ cross-agent fetch correctly rejected (Agent B → Agent A's receipt) → NOT_RECEIPT_OWNER
  ✓ wrong-action challenge correctly rejected (GET_INTENT_STATUS sig replayed at /fill-receipt) → INVALID_REQUEST_SIGNATURE
  ✓ stale-timestamp challenge correctly rejected (90s-old signed challenge) → STALE_REQUEST

Final balances:
  Agent A: ETH=0,  USDC=35900
  Agent B: ETH=4,  USDC=5640
  Agent C: ETH=6,  USDC=8460
  Agent D: ETH=0,  USDC=100

✓ demo complete: every expected outcome matched
```

The simulator exits 0 only when every locked outcome (clearing price, fills,
final balances, owner-gated access checks, cross-agent rejection) matches.

---

## Tamper demo (verifier replay)

The simulator demonstrates the honest path. The replay CLI makes the integrity
claim falsifiable: take a saved bundle, mutate one field, watch the verifier
catch it.

### Save a bundle

Add `--save-bundle <path>` to a normal demo run:

```sh
npm run simulate -- --reset-demo-state --data-dir ./data \
  --save-bundle ./data/last-bundle.json
```

The bundle is the JSON shape `VerifyFullBatchRequest` expects, including the
batch receipt, all fill receipts, the settlement, vault snapshots before and
after, reservation book snapshots, and the engine address.

### Replay honest

```sh
npm run verify -- ./data/last-bundle.json
```

Output ends with `Result: VERIFIED ✓`.

### Replay with a tamper scenario

```sh
npm run verify -- ./data/last-bundle.json --scenario wrong-key
```

```
============================================================
Hecate verifier replay
============================================================
  bundle:    ./data/last-bundle.json
  batch_id:  batch_demo_001
  mode:      TAMPER  scenario=wrong-key
  mutation:  /batchReceipt re-signed with a different secp256k1 key

Result: REJECTED ✗

1 failure:
  [ENGINE_SIGNER_MISMATCH]  /batchReceipt/engine_signature
    recovered 0xC42E... != expected 0x7E5F4552...

What this demonstrates:
  Authority binding: even when structural fields all match (same body,
  consistent signature), the recovered signer does not match
  expectedEngineAddress.
```

### List all scenarios

```sh
npm run verify -- --scenario list
```

| Scenario | What it changes | Property demonstrated |
|---|---|---|
| `clearing-price` | `batchReceipt.clearing_price` | Field-level tamper detection |
| `vault-after-hash` | `vault_state_after_hash` | Vault state hash binds post-settlement world |
| `reservation-after-hash` | `reservation_book_after_hash` | Reservation transition is committed |
| `settlement-hash` | `settlement_hash` | Settlement bound by hash |
| `intent-envelope-root` | `intent_envelope_root` | Set of accepted envelopes is bound |
| `fill-base` | `fillReceipts[0].filled_base` | Fill receipts equally bound |
| `reserved-released` | `fillReceipts[0].reserved_released.ETH` | Vault residual release is bound |
| `signature-bytes` | flip a hex char in `engine_signature` | Either signer mismatch or signature invalid |
| `wrong-key` | re-sign body with different key | **Authority binding** — strongest demo |
| `swap-fill-receipt-body` | swap a fill receipt's body fields | Per-receipt signature scope |
| `tamper-vault-supporting` | mutate `vaultStateAfterSettlement` directly | Verifier rehashes; doesn't trust hashes blindly |
| `tamper-settlement-deltas` | empty `settlement.vault_deltas` | Settlement recomputed from batch + fillPlan |
| `missing-fill-receipt` | drop one fill receipt | Verifier requires one fill per intent |
| `runtime-eigen-incoherent` | LOCAL_MOCK → EIGEN_TEE with null Eigen fields | Coherence is checked independently |

### One-command full demo

```sh
bash scripts/demo-replay.sh
```

Runs the simulator (saving the bundle), then verifies the honest bundle, then
runs every tamper scenario with `--expect-fail`. Ends with
`ALL DEMO SCENARIOS PASSED` if every attack was correctly rejected.

### Failure-mode demo (optional)

```sh
npm run simulate -- --reset-demo-state --data-dir ./data --include-failure-fixture
```

Runs the canonical 4-agent demo first, then a second batch with three new
fixtures (E, F, G) crafted to exercise the matcher's per-intent
unfilled-reason discrimination:

| Agent | Side | Limit | Min fill | Outcome |
|---|---|---|---|---|
| E | BUY 1 ETH | 3500 | 1 | `UNFILLED` — `INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT` (limit doesn't cross any sell) |
| F | SELL 5 ETH | 3550 | 5 (AON) | `UNFILLED` — `MIN_FILL_NOT_MET` (active at p=3550 but allocation falls below min) |
| G | BUY 4 ETH | 3600 | 4 (AON) | `UNFILLED` — `MIN_FILL_NOT_MET` (active at p=3550 but matched sell flow is 0) |

The batch closes successfully (`num_matched=0`), every reservation is
released, every fixture's balance equals exactly what it deposited, and the
failure-batch bundle still verifies — the engine signed the correct refusal.
The point is to demonstrate the engine's per-intent failure-reason
discrimination, not engine misbehavior.

### Web verifier panel

While the server is running (`npm run dev`), open
[http://127.0.0.1:8787/](http://127.0.0.1:8787/) in a browser. The panel:

- Auto-loads `/attestation` and renders `runtime_mode`, `engine_address`,
  `engine_code_digest`, `signer.mode`, plus the LOCAL_MOCK warning. EIGEN_TEE
  deployments also show the three eigen metadata fields.
- Accepts a saved bundle by drag-drop, file picker, or paste. Shows
  `batch_id`, `num_intents`, `num_matched`, and `clearing_price` summary, plus
  the `expectedEngineAddress`.
- **Verify honest** posts the bundle to `/receipts/verify` and renders a green
  banner with the `bundle_id` if every check passes.
- **Tamper & verify** picks one of the 14 scenarios, posts to
  `/receipts/tamper-verify`, and renders a red banner with each failure
  (`code`, `path`, `detail`) plus the scenario's "what this demonstrates" text.

The panel is a single static HTML file served by the engine. It makes no
external requests; everything runs on the host the engine runs on. Same
attestation, same verifier, same tamper scenarios as the CLI — just visual.

### Run the demo against a Docker container

```sh
npm run docker:smoke
```

Builds the image, runs the container with LOCAL_MOCK env, hits it from the
host with the simulator + replay CLI, and confirms an honest bundle verifies
+ a `wrong-key` tamper rejects. Same demo as above, just with the engine
running inside a container — confirms the Eigen-ready packaging works.

See [EIGEN_DEPLOYMENT.md](EIGEN_DEPLOYMENT.md) for the planned EigenCompute
deployment flow.

### Exit codes

| Outcome | Exit |
|---|---|
| Honest bundle verified | 0 |
| Rejected without `--expect-fail` | 1 |
| Rejected with `--expect-fail` (CI/demo) | 0 |
| Argument error / `--help` | 2 |
| Bundle file unreadable or schema-invalid | 1 |

---

## What this demonstrates

| Step | Hecate property |
|---|---|
| Deposits via `/vault/mock-deposit` | Mock vault ledger (no real custody). |
| Intent submission (`/intents`) | Acceptance pipeline: signature, decrypt, commitment, reservation. |
| Agent D rejection | `INSUFFICIENT_FUNDS` does not mark nonce; honest rejection logging. |
| Batch close clearing at 3590 | Deterministic uniform-clearing matcher with documented tie-break ladder. |
| `bundle_id` after close | `keccak256(canonicalJson(verifyPayload))` — say it aloud, audience verifies the same artifact. |
| `verifyFullBatch` ok | Receipt integrity story end-to-end: hashes, signatures, conservation. |
| Owner-gated `GET_FILL_RECEIPT` | Signed-challenge protocol; key+action+intent_id binding. |
| Owner-gated `GET_INTENT_STATUS` | Same protocol, separate action; status matches fill receipt. |
| Cross-agent fetch rejected (NOT_RECEIPT_OWNER) | Recovered signer ≠ receipt owner. |
| Wrong-action challenge rejected (INVALID_REQUEST_SIGNATURE) | Action is part of the canonical preimage; a `GET_INTENT_STATUS` signature does not authorize a `GET_FILL_RECEIPT`. |
| Stale-timestamp challenge rejected (STALE_REQUEST) | ±60s freshness window; old challenges cannot be replayed. |
| Final balances | Settlement applied correctly; reservations released. |

---

## Inspecting state

After a run, the data directory contains:

```
data/
├── intents.jsonl         # one PersistedIntentRecord per accepted intent
├── rejections.jsonl      # one PersistedRejection per rejected intent
├── batches.jsonl         # one PersistedBatchRecord per closed batch
├── receipts.jsonl        # one FillReceipt per filled/unfilled intent in the batch
├── vault.json            # current VaultState (agent balances + reserved)
└── reservations.json     # current ReservationBook (RESERVED / SETTLED / RELEASED)
```

All files are JSON; the `.jsonl` files are one canonical-JSON object per line.
The `vault.json` and `reservations.json` snapshots are atomically replaced on
every state change.

Useful greps:

```sh
# List every accepted intent_id
jq -r '.envelope.intent_id' data/intents.jsonl

# List every fill receipt intent_id and its status
jq -r '"\(.intent_id)\t\(.status)\t\(.filled_base) ETH"' data/receipts.jsonl

# Pretty-print the most recent batch receipt
tail -n1 data/batches.jsonl | jq '.batch_receipt'
```

---

## Resetting

Either of:

```sh
# via the simulator (will only delete the known demo files)
npm run simulate -- --reset-demo-state --data-dir ./data

# or manually before npm start
rm -f data/*.jsonl data/*.json
```

`--reset-demo-state` only deletes `intents.jsonl`, `rejections.jsonl`,
`batches.jsonl`, `receipts.jsonl`, `vault.json`, and `reservations.json` — it
will not touch other files in the directory.

---

## Common errors

| Symptom | Likely cause |
|---|---|
| `could not reach Hecate server at http://127.0.0.1:8787 ...` | `npm run dev` not running (or wrong `--base-url`). |
| `MALFORMED_PAYLOAD` rejection on every submission | Server's `CODE_DIGEST` does not match simulator's `--code-digest`. The mock enclave key is derived from `CODE_DIGEST`; mismatched digests produce ciphertexts the server cannot decrypt. |
| `startup failed: Error: ENGINE_PRIVATE_KEY not set` | Server env var missing. Set in `.env` or shell. |
| `EIGEN_TEE requires EIGENCOMPUTE_*` | `RUNTIME_MODE=EIGEN_TEE` without all three eigen vars set. The server refuses to silently fall back to `LOCAL_MOCK`. |
| Existing balances detected | A prior demo run left state; pass `--reset-demo-state --data-dir ./data` or use a fresh `DATA_DIR`. |

---

## v1 caveats

- **`LOCAL_MOCK` only.** Receipts produced are research artifacts. The mock
  encryption key is derived from `CODE_DIGEST` and is process-readable —
  architectural, not security.
- **In-memory ready pool.** A server restart between intent acceptance and
  batch close loses the decrypted payloads; reservations remain in the
  vault snapshot. This is documented in
  [tests/adversarial.api.test.ts](../tests/adversarial.api.test.ts) (the
  ready-pool restart test) and on the [roadmap](ROADMAP.md).
- **Single market (ETH/USDC).** Multi-asset is future work.
- **Public clearing price.** Once a batch closes, the clearing price is in
  the public batch receipt. If it equals one party's binding limit, that
  limit is observable. See [TECHNICAL_PAPER.md](TECHNICAL_PAPER.md) §15.
