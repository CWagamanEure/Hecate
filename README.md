# Hecate

Confidential intent execution for autonomous agents — a TEE-mediated private
batch-crossing engine for ETH/USDC.

> **Research / MVP.** Not a production system. Receipts produced under
> `RUNTIME_MODE=LOCAL_MOCK` are research artifacts and do not move real funds.
> See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and
> [docs/SOLVENCY_AND_VAULTS.md](docs/SOLVENCY_AND_VAULTS.md) for the full claim
> surface.

## What Hecate is

- An API-first private batch-crossing engine for autonomous-agent intents.
- A specific, narrow exploration: can a TEE-mediated matcher reduce *pre-match
  inspection* of richer-than-swap execution constraints (limit, partial-fill,
  min fill, deadlines, fallbacks, max impact) by operators, solvers, and
  unmatched counterparties?
- Trust-reduced confidential execution. Every claim is bounded and explicit.
- Verifiable: every batch produces signed public batch receipts plus per-agent
  signed fill receipts. Tampering with any field invalidates verification.

## What Hecate is not

- Not a fully trustless private exchange. The TEE is a trust assumption, not a
  cryptographic guarantee.
- Not a production system. v1 runs LOCAL_MOCK only.
- Not a CoW / UniswapX / Angstrom / Renegade replacement. Different point in
  the design space — see [docs/COMPARISONS.md](docs/COMPARISONS.md).
- Does not solve MEV, executed-flow inference, or behavioral fingerprinting.
- Does not hide strategy over time. Settled flow is public.
- Does not prove agent solvency without a vault or settlement mechanism. The
  v1 vault is a mock prefunded ledger.

## Quickstart

```sh
npm install
cp .env.example .env       # then edit ENGINE_PRIVATE_KEY etc.
npm run dev                # terminal 1
npm run simulate -- --reset-demo-state --data-dir ./data   # terminal 2
```

Defaults that work out of the box:

```
ENGINE_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
CODE_DIGEST=sha256:dev-local
DATA_DIR=./data
RUNTIME_MODE=LOCAL_MOCK
HOST=127.0.0.1
PORT=8787
```

## Expected demo output

The simulator runs four agents (A, B, C, D), exercises owner-gated endpoints,
and asserts every locked outcome:

```
Batch close:
  ✓ batch closed: clearing_price=3590, num_matched=3
  intent_Agent_A_... FILLED filled_base=10
  intent_Agent_B_... FILLED filled_base=4
  intent_Agent_C_... PARTIALLY_FILLED filled_base=6
  bundle_id:        0x...

Verification:
  ✓ full-bundle verification: ok

Owner-gated access:
  ✓ Agent A fetched their own fill receipt
  ✓ cross-agent fetch correctly rejected (Agent B → Agent A's receipt) → NOT_RECEIPT_OWNER
  ✓ wrong-action challenge correctly rejected → INVALID_REQUEST_SIGNATURE
  ✓ stale-timestamp challenge correctly rejected → STALE_REQUEST

Final balances:
  Agent A: ETH=0,  USDC=35900
  Agent B: ETH=4,  USDC=5640
  Agent C: ETH=6,  USDC=8460
  Agent D: ETH=0,  USDC=100      (rejected: INSUFFICIENT_FUNDS)

✓ demo complete: every expected outcome matched
```

Full walkthrough: [docs/DEMO.md](docs/DEMO.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start the Fastify server with file watching |
| `npm start` | Start the server (no watch) |
| `npm run simulate` | Run the demo CLI against the running server |
| `npm run verify` | Verifier replay CLI on a saved bundle (see `agents/replay.ts`) |
| `npm test` | Run the full vitest suite (≈ 30 s) |
| `npm run test:soak` | 30-cycle deterministic soak test |
| `npm run test:coverage` | Suite + v8 coverage report |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run docker:build` | Build the Docker image (`hecate:dev`) |
| `npm run docker:run` | Run the container locally on port 8787 |
| `npm run docker:smoke` | Build + run container + simulate + verify + tamper |

## Run in Docker

```sh
npm run docker:build
npm run docker:run                # in one terminal
npm run simulate                  # in another, against the container

# or one-command end-to-end smoke:
npm run docker:smoke
```

The container is research/MVP packaging — single-stage Node 20 slim, `tsx`
in the image, no compiled dist. The default `docker:run` includes a dev
`ENGINE_PRIVATE_KEY` for first-run convenience; production deployments
override it. See [docs/EIGEN_DEPLOYMENT.md](docs/EIGEN_DEPLOYMENT.md) for
the full Eigen-deployment plan.

## Eigen deployment prep

Hecate is Eigen-ready as of Ticket 20. The `Dockerfile`, env-var contract,
strict EIGEN_TEE startup, and signer-honesty story are all in place. Actual
deployment to EigenCompute is Ticket 21. Even on Eigen, v1 holds **no real
funds** and signs receipts with a local engine key (`signer.mode =
"LOCAL_DEV_KEY"` in `/attestation`). Real Eigen app-wallet signing is future
work — see [docs/EIGEN_DEPLOYMENT.md](docs/EIGEN_DEPLOYMENT.md) §8.

## Deployment status (as of 2026-05)

| Artifact | Status |
|---|---|
| Engine (LOCAL_MOCK) | Runs locally via `npm run dev`. |
| Engine (EIGEN_TEE) | Live on EigenCompute mainnet-alpha. App `0x362a966eB23597190483634d6769Fc41b87514B3`, endpoint `35.204.215.188:8787`, image `sha256:5aed3323…` (pre-V2 code; on-chain integration goes live with V6d redeploy). |
| `HecateSettlementVerifier.sol` | Live on Sepolia at `0x0bAcD73a36f774Cb7c2f252a2d3c002A0079D4E2` (verified on Etherscan). |
| `MockUSDC.sol` | Live on Sepolia at `0x1662B5050B70c8fAc9405d11B3e7eCDe9eF6c3cB` (verified). 6-decimal demo ERC-20 with public mint. |
| `HecateVault.sol` | Live on Sepolia at `0x7EF8583489eEb158bf9233bC7a38e0EC410eF1aA` (verified). Engine reads its balances when `VAULT_BACKEND=onchain` (V6b); `settleBatch` submission via `npm run vault:settle` (V6c). |

See [`deployments/sepolia.json`](deployments/sepolia.json) for the full manifest.

## On-chain demo (Sepolia, V6)

End-to-end on-chain flow for the demo:

```sh
# (one-time) generate demo agent wallets
npm run wallets:gen

# (user action) fund each printed agent address with ~0.001 Sepolia ETH from a faucet

# move agent funds into the on-chain vault
npm run vault:deposit -- --dry-run        # confirm tx will succeed
npm run vault:deposit                     # broadcast

# run the engine in on-chain mode (reads vault balances from Sepolia)
VAULT_BACKEND=onchain npm run dev

# run the simulator using the real agent wallets
npm run simulate -- --use-demo-wallets --reset-demo-state --data-dir ./data \
  --save-bundle ./data/last-bundle.json

# settle the bundle on chain
npm run vault:settle -- ./data/last-bundle.json --dry-run  # confirm signature + deltas
npm run vault:settle -- ./data/last-bundle.json            # broadcast
```

Each step is independent and can be re-run. See the script source for `--help` on each.

## Demo agent wallets (V3 / V4)

The simulator can run the canonical 4-agent demo with either hardcoded
dev keys (default, no setup) or with fresh Sepolia agent wallets (opt-in,
required for the on-chain vault demo).

**Fresh wallets per machine:**

```sh
npm run wallets:gen
```

Writes `.demo-wallets.json` at the repo root with 4 secp256k1 keypairs
(A, B, C, D). The file is gitignored and chmodded `0o600`; each clone of
the repo generates its own set. Re-running the command is idempotent —
to regenerate, delete the file first.

The script prints each agent's Sepolia address along with the V5 funding
plan (~0.005 Sepolia ETH per agent; mUSDC is minted by the V5 deploy,
no faucet needed for tokens).

**Use the wallets in the demo:**

```sh
npm run simulate -- --use-demo-wallets --reset-demo-state --data-dir ./data
```

`--use-demo-wallets` replaces the canonical 4-agent fixtures' hardcoded
dev keys with the generated wallets. Failure / adversary fixtures keep
their dev keys. Pass `--reset-demo-state` alongside if the data dir has
prior state under different agent addresses; otherwise the runner prints
a warning.

Without `--use-demo-wallets` the demo continues to run on the dev keys
unchanged, so existing CI / soak / local flows are unaffected.

## Runtime modes

- **`LOCAL_MOCK`** (default). Fully working v1. AES-GCM mock encryption with a
  locally-derived key — architectural, not security. The whole stack runs
  offline; receipts produced under LOCAL_MOCK are research artifacts.
- **`EIGEN_TEE`** (strict stub in v1). The server refuses to start unless
  `EIGENCOMPUTE_APP_ID`, `EIGENCOMPUTE_IMAGE_DIGEST`, and
  `EIGENCOMPUTE_ATTESTATION_ID` are all set. Real Eigen attestation chain
  verification is future work; v1 only checks metadata coherence.

## Privacy and threat-model summary

Hecate's privacy claim is narrow and explicit. The TEE-mediated matcher can
mitigate pre-match inspection of rich agent constraints by operators, solvers,
and unmatched counterparties. It binds receipt signing to an attested code
digest so a tampered binary cannot produce verifying receipts. It does not
provide ZK-grade privacy, does not hide strategy over time, does not address
hardware side-channel attacks, and does not solve MEV.

Full threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Owner-gated endpoints

Per-intent private artifacts (fill receipts, intent status) are accessible only
to the owning agent via a signed challenge:

```
challenge = canonicalJson({
  action: "GET_FILL_RECEIPT" | "GET_INTENT_STATUS",
  intent_id,
  timestamp_ms          // ±60s window
})
signature = signHash(keccak256(challenge), agent_private_key)
```

The action field scopes the signature so a `GET_INTENT_STATUS` signature
cannot be replayed at the `GET_FILL_RECEIPT` endpoint. The intent_id binds
the signature so a challenge for `intent_a` cannot fetch `intent_b` even by
the same agent. See [docs/API.md](docs/API.md) for the full protocol and
[tests/adversarial.access.test.ts](tests/adversarial.access.test.ts) for the
abuse cases.

## Limitations

- **LOCAL_MOCK encryption is architectural, not security.** Anyone with
  process-level access to the server can read decrypted payloads. EIGEN_TEE
  would change this; v1 does not implement it.
- **No real Eigen attestation chain verification.** Only metadata coherence.
- **In-memory ready pool.** If the server restarts after `acceptIntent`
  succeeded but before the next batch close, the decrypted payload is lost.
  Reservations remain in `vault.json` / `reservations.json`. Future hardening
  via a `ready.jsonl` is on the [roadmap](docs/ROADMAP.md).
- **No production custody.** v1 vault is a mock ledger.
- **The clearing price is public.** If a submitted limit price becomes the
  binding clearing price, that limit may be inferable from public batch
  outputs. Hecate mitigates pre-match inspection of private payloads; it does
  not guarantee that all private constraints remain hidden after execution.
- **Submitter identity is not private.** The envelope reveals `agent_id`.
- **Counterparty learns from own fill.** Pairwise inference is unavoidable
  for any matcher that publishes settlement.
- **Single-process single-mutex.** Multi-process / multi-host concurrency
  out of scope.

## Verifier replay demo

The simulator demonstrates the *honest* path. The replay CLI demonstrates that
the integrity claim is falsifiable on demand:

```sh
# 1. Run demo and save the close-batch bundle to disk.
npm run simulate -- --reset-demo-state --data-dir ./data --save-bundle ./data/last-bundle.json

# 2. Replay the honest bundle through verifyFullBatch:
npm run verify -- ./data/last-bundle.json

# 3. Run any of the 14 built-in tamper scenarios:
npm run verify -- ./data/last-bundle.json --scenario clearing-price
npm run verify -- ./data/last-bundle.json --scenario wrong-key
npm run verify -- ./data/last-bundle.json --scenario list

# 4. One-command run of all scenarios:
bash scripts/demo-replay.sh
```

The `wrong-key` scenario is the strongest single-screen demo: rebuild the
batch receipt body unchanged, sign it with a different key — every structural
field still matches, but `ENGINE_SIGNER_MISMATCH` fires on the authority check.
See [docs/DEMO.md](docs/DEMO.md) for the full tamper table.

## Project status

- **691** vitest cases passing across **54** files.
- **30**-cycle deterministic soak test (`npm run test:soak`).
- **9** adversarial test files (~79 cases) covering matching, settlement,
  vault, receipts, access control, persistence corruption, decimal boundaries,
  full-flow API abuse, and a property-based fuzz that mutates random leaves
  of a saved bundle (default 200 iters, env-overridable to higher).
- **14** tamper scenarios in the verifier replay CLI; full demo passes
  honest-then-attack via `scripts/demo-replay.sh`.
- **4**-agent canonical demo verified end-to-end via the live HTTP API; two
  optional flags (`--include-failure-fixture`, `--include-adversary`) layer
  additional batches for richer narrative.
- **44** Forge tests across three contracts:
  - 9 on `HecateSettlementVerifier.sol` (deployed to Sepolia at `0x0bAcD73a36f774Cb7c2f252a2d3c002A0079D4E2`, end-to-end anvil + Sepolia verified),
  - 28 on `HecateVault.sol` (production-style prefunded vault — deployed to Sepolia at `0x7EF8583489eEb158bf9233bC7a38e0EC410eF1aA`, not yet engine-integrated),
  - 6 on `MockUSDC.sol` (6-decimal demo ERC-20 — deployed to Sepolia at `0x1662B5050B70c8fAc9405d11B3e7eCDe9eF6c3cB`),
  - 1 cross-tool ABI parity pin (`HecateVaultAbiParity.t.sol`) keeping solc's
    `abi.encode` aligned with viem's `encodeAbiParameters` for vault settlement.

## Documentation

- [Technical paper](docs/TECHNICAL_PAPER.md) — design, claims, limitations
- [Threat model](docs/THREAT_MODEL.md) — what the TEE helps with and does not
- [Architecture](docs/ARCHITECTURE.md) — system + module + data-flow overview
- [API](docs/API.md) — endpoint catalog + signed-challenge protocol
- [Receipts](docs/RECEIPTS.md) — batch + fill receipt fields and verification
- [Solvency and vaults](docs/SOLVENCY_AND_VAULTS.md) — why solvency is
  separate from TEE correctness; v1 vs production vault tradeoffs
- [Comparisons](docs/COMPARISONS.md) — vs CoW, UniswapX, Angstrom, Shutter,
  Renegade
- [Demo](docs/DEMO.md) — exact commands and expected output
- [Demo-day checklist](docs/DEMO_CHECKLIST.md) — presenter-facing run-day script with recovery branches
- [FAQ](docs/FAQ.md) — reviewer questions with honest answers
- [Eigen deployment](docs/EIGEN_DEPLOYMENT.md) — Docker prep + planned Eigen flow
- [Roadmap](docs/ROADMAP.md) — future work

License: not specified yet.
