# Hecate on EigenCompute — deployment prep

> **Status:** Eigen-ready as of Ticket 20. **Not deployed yet.** Actual
> deployment is Ticket 21. v1 research/MVP semantics apply throughout — see
> [TECHNICAL_PAPER.md](TECHNICAL_PAPER.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

---

## 1. Purpose

Ticket 20 makes the v1 server **packageable** as a container that EigenCompute
could host. It does NOT yet:

- run inside a real Eigen TEE
- verify a real Eigen attestation chain
- use Eigen app-wallet signing

Even after deployment to Eigen (Ticket 21), v1 holds **no real funds**, signs
receipts with a **local engine private key** (`LOCAL_DEV_KEY`), and remains a
research artifact. The Eigen step adds code-integrity binding via image
attestation; it does not change the v1 trust assumptions for matching,
solvency, or funds.

---

## 2. Prerequisites

Before deploying:

- Docker (Docker Desktop on macOS/Windows, Docker Engine on Linux)
- The `ecloud` CLI installed and configured (Eigen's deployment tool)
- EigenCloud auth credentials
- An EVM account with gas on the chosen network for Eigen's app/wallet
  registration steps (no funds for receipts; v1 holds none)
- An EigenCompute subscription / account

Versions verified locally:

- Node 20.x (matches `engines.node >=20`)
- Docker 24.x or later
- macOS (Apple Silicon) builders should pass `--platform linux/amd64` to
  produce images Eigen's amd64 nodes can run.

---

## 3. Local Docker smoke

Two smoke variants. Use the amd64 one before deploying to Eigen — that is
the architecture Eigen will run.

```sh
# Native architecture (fast; use during development).
npm run docker:smoke

# linux/amd64 under emulation (slower; use as pre-deploy verification).
npm run docker:smoke-amd64
```

Both run the same flow: build → run → poll `/healthz` → attestation check →
simulator end-to-end → verify the saved bundle → run a `wrong-key` tamper
that must reject. The amd64 variant also explicitly calls
`scripts/eigen-attest-check.sh` against the local container with
`EXPECTED_MODE=LOCAL_MOCK`, exercising the same attestation-validation
logic you will run against the deployed Eigen instance.

The simulator and the replay CLI run **on the host**, not inside the
container. Agents are external clients; the container is only the engine.

### Pre-deploy preflight

A single command runs every local check before deploy:

```sh
npm run eigen:preflight
```

Verifies Docker + buildx + jq are available, runs the full amd64 smoke,
then prints the `ecloud deploy` command template you'll fill in.

---

## 4. EigenCompute deployment plan

### What this section covers

A split between (a) the commands I have **verified locally on this
machine** and (b) the commands **you run yourself** because they require
Eigen credentials that this repo does not have access to.

The ecloud CLI flag set may have drifted; treat the template as exactly
that and verify against `ecloud deploy --help` on your installed CLI.

### Verified locally

```sh
# Cross-build for linux/amd64. Verified on Apple Silicon under emulation;
# the produced image runs cleanly and serves the full demo end-to-end.
docker buildx build --platform linux/amd64 -t hecate:amd64 --load .

# End-to-end amd64 smoke. Verified: full simulator + replay + wrong-key
# tamper all pass against the amd64 image.
npm run docker:smoke-amd64
```

### Run yourself

```sh
# 1. Authenticate.
ecloud auth login

# 2. Target Sepolia. Hecate's Eigen app/wallet metadata lives on Sepolia for v1.
ecloud env set sepolia

# 3. Tag and push the image you verified in the preflight.
docker tag hecate:amd64-smoke <eigen-registry>/<account>/hecate:v1
docker push                   <eigen-registry>/<account>/hecate:v1

# 4. Deploy. Verify flag syntax against your `ecloud deploy --help`.
ecloud deploy <eigen-registry>/<account>/hecate:v1 \
  -e RUNTIME_MODE=EIGEN_TEE \
  -e ENGINE_PRIVATE_KEY=<dev-key>                  # see §8
  -e CODE_DIGEST=<the-deployed-image-digest> \
  -e EIGENCOMPUTE_APP_ID=<from ecloud after deploy> \
  -e EIGENCOMPUTE_IMAGE_DIGEST=<from ecloud after deploy> \
  -e EIGENCOMPUTE_ATTESTATION_ID=<from ecloud after deploy>

# 5. Verify the deployed instance's attestation reports correctly.
EXPECTED_MODE=EIGEN_TEE npm run eigen:attest-check -- https://<deployed-url>

# 6. Run the demo against the deployed instance.
npm run simulate -- \
  --base-url https://<deployed-url> \
  --code-digest <deployed-image-digest> \
  --save-bundle ./data/eigen-bundle.json

# 7. Offline bundle verification (no contact with Eigen).
npm run verify -- ./data/eigen-bundle.json

# 8. Demonstrate the integrity story with a tamper scenario.
npm run verify -- ./data/eigen-bundle.json --scenario wrong-key --expect-fail
```

After deployment, record:

- App ID: _________
- Public URL: _________
- Image digest as deployed: _________ (should match `CODE_DIGEST`)
- Attestation ID: _________
- Engine address: _________ (recovered from `/attestation`; should match
  `privateKeyToAddress(ENGINE_PRIVATE_KEY)`)

Then verify in one command:

```sh
EXPECTED_MODE=EIGEN_TEE npm run eigen:attest-check -- https://<deployed-url>
```

Expected output:

```
✓ attestation check PASSED for https://<deployed-url>
    runtime_mode:       EIGEN_TEE
    engine_address:     0x...
    engine_code_digest: <deployed-image-digest>
    signer.mode:        LOCAL_DEV_KEY
    matching_rule:      UNIFORM_CLEARING_PRICE_V1
    eigen_app_id:       <recorded above>
    eigen_image_digest: <recorded above>
    eigen_attestation:  <recorded above>
```

The script exits non-zero on any mismatch. `signer.mode` always reports
`LOCAL_DEV_KEY` in v1 — see §8 (real Eigen app-wallet signing is future work).

---

## 5. Required env vars on Eigen

| Variable | Value | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Container must listen on all interfaces. |
| `PORT` | `8787` | Or whichever Eigen routes to the container. |
| `RUNTIME_MODE` | `EIGEN_TEE` | Strict; missing eigen vars below = startup failure. |
| `DATA_DIR` | `/app/data` | Or an Eigen-provided durable mount, if available. |
| `CODE_DIGEST` | the deployed image digest | Stamped into every receipt. |
| `EIGENCOMPUTE_APP_ID` | from `ecloud` after deploy | Required when `RUNTIME_MODE=EIGEN_TEE`. |
| `EIGENCOMPUTE_IMAGE_DIGEST` | from `ecloud` after deploy | Required. |
| `EIGENCOMPUTE_ATTESTATION_ID` | from `ecloud` after deploy | Required. |
| `ENGINE_PRIVATE_KEY` | dev key in v1 | See §8. |

If `RUNTIME_MODE=EIGEN_TEE` and any of the three `EIGENCOMPUTE_*` are
missing, the server refuses to start. There is **no silent fallback** to
LOCAL_MOCK.

---

## 6. Trust story

What an Eigen TEE deployment of v1 adds, **without overclaiming:**

- Code-integrity binding via Eigen's image attestation.
- Hardware-isolated execution per the underlying TEE platform's model.
- A verifiable attestation chain (image digest, app id, attestation id) that
  receipts carry as `runtime` metadata, so verifiers can check it.
- The `/attestation` endpoint reports the live runtime metadata so clients
  can match it against the published deployment.

What is **still NOT solved** in v1, even on Eigen:

- No real funds; mock vault only.
- No real custody.
- No liveness guarantee — Eigen's host scheduling determines availability.
- Strategy privacy over time: executed-flow inference is unaddressed.
- Public clearing price reveals binding limits when clearing equals one
  party's limit.
- Ready-pool restart limitation: the in-memory pool resets on container
  restart. Reservations persist; in-flight decrypted payloads are lost.
- App-wallet signer is not integrated — see §8.
- Real Eigen attestation chain verification client-side is not implemented;
  receipts carry the metadata but no Hecate code in v1 walks the chain.

---

## 7. Verifying a deployed bundle

The replay CLI runs entirely on the recipient's machine. The Eigen instance
is not consulted during verification — that's the point.

```sh
# 1. Run the simulator against the deployed instance, save the bundle.
npm run simulate -- \
  --base-url https://<eigen-instance> \
  --code-digest <deployed-image-digest> \
  --save-bundle ./data/eigen-bundle.json

# 2. Verify locally (offline; no network calls).
npm run verify -- ./data/eigen-bundle.json

# 3. Run any tamper scenario locally to prove the integrity story.
npm run verify -- ./data/eigen-bundle.json --scenario wrong-key --expect-fail

# 4. Or run all 14 scenarios at once (requires the local server too).
bash scripts/demo-replay.sh
```

The honest-bundle verify proves: the Eigen-deployed engine signed receipts
with the engine address you'd expect, runtime metadata is coherent, and the
matching/settlement story holds. The tamper scenarios prove the verifier
catches every form of post-hoc modification.

---

## 8. App-wallet signing — current state and future work

**v1 does NOT use Eigen's app-wallet signer.** Even under `RUNTIME_MODE=EIGEN_TEE`,
receipts are signed by the `ENGINE_PRIVATE_KEY` env var, which is a local
dev key with no production weight. The `/attestation` endpoint reports this
honestly:

```json
{
  "signer": {
    "mode": "LOCAL_DEV_KEY",
    "note": "v1 uses a local engine key (ENGINE_PRIVATE_KEY) for receipt signing in both LOCAL_MOCK and EIGEN_TEE modes. Real Eigen app-wallet signing is future work."
  }
}
```

Do not represent v1 receipts as app-wallet-signed. They are not.

Future work (a separate ticket; not part of Ticket 20 or 21):

- Replace `ENGINE_PRIVATE_KEY` with a key derived inside the enclave or
  bound to an Eigen-managed app wallet.
- Update `/attestation` to report `signer.mode = "EIGEN_APP_WALLET"`.
- Either bump receipt schema version, or add a `signer.mode` field to
  `RuntimeMetadata`, so verifiers can distinguish v1 receipts from
  app-wallet-signed receipts.
- Verifier should walk the Eigen attestation chain to confirm the wallet
  identity matches the published deployment.

---

## 9. Persistent storage warning

- The in-memory ready pool resets on container restart. Reservations persist
  in `vault.json` / `reservations.json`. Decrypted payloads in flight are
  lost. See [tests/adversarial.api.test.ts](../tests/adversarial.api.test.ts)
  ("ready-pool restart limitation test") for the test that anchors this.
- `DATA_DIR` durability inside the container depends on Eigen's storage
  model. If Eigen does not provide a durable volume, treat the deployment
  as ephemeral — restarts lose all state, not just the ready pool.
- Production needs `ready.jsonl` replay (see [ROADMAP.md](ROADMAP.md) §1)
  or transactional storage.
- Multi-process / multi-host concurrency is out of scope. Hecate v1 is
  single-process under one mutex.

---

## 10. Termination warning

- A future version of Hecate that uses an Eigen app wallet may, depending
  on Eigen's wallet semantics, lose access to that wallet's keys when the
  app is terminated.
- v1 holds **no real funds** and uses no app wallet, so this is informational.
- Do **not** promote v1 to handling funds without addressing wallet
  lifecycle and key custody as a separate, audited piece of work.

---

## 11. Differences from local LOCAL_MOCK behavior

| Aspect | LOCAL_MOCK locally | EIGEN_TEE on Eigen (v1) |
|---|---|---|
| Runtime mode | `LOCAL_MOCK` | `EIGEN_TEE` |
| Eigen metadata fields in receipts | all `null` | populated from env |
| Receipt signer (v1) | `LOCAL_DEV_KEY` (`ENGINE_PRIVATE_KEY`) | `LOCAL_DEV_KEY` (`ENGINE_PRIVATE_KEY`) — unchanged |
| Payload encryption | AES-GCM with `CODE_DIGEST`-derived key | same (no enclave key derivation in v1) |
| Attestation chain verification client-side | n/a | not implemented in v1 |
| Vault custody | mock ledger | mock ledger |

The honest summary: in v1, the Eigen step changes the runtime metadata
fields receipts carry. Everything else is the same.
