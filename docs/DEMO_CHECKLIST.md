# Demo-day checklist

Presenter-facing run-day script. Copy-paste from here on stage.

---

## T−1 day

Everything that requires credentials or external services. Get these
done in advance so demo day has nothing risky in it.

### Sepolia setup

```sh
# 1. Get a Sepolia RPC URL. Free from Alchemy or Infura; or use a public node.
#    https://www.alchemy.com/  or  https://www.infura.io/
export SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/<your-key>

# 2. Fund a deployer wallet. Faucets dispense ~0.1 Sepolia ETH; you need ~0.005.
#    https://www.alchemy.com/faucets/ethereum-sepolia
export DEPLOYER_PRIVATE_KEY=0x...

# 3. Optional but recommended: Etherscan API key for source verification.
#    https://etherscan.io/myapikey
export ETHERSCAN_API_KEY=...

# 4. Deploy the verifier contract.
cd contracts
forge install foundry-rs/forge-std    # first time only
forge test -vv                         # confirm 9/9 pass

forge script script/Deploy.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --private-key $DEPLOYER_PRIVATE_KEY

# 5. Record the deployed address. The script prints it at the end.
export VERIFIER_ADDRESS=0x...
cd ..
```

### Eigen setup (optional — only if running engine on Eigen)

```sh
# 1. Verify the amd64 build works locally.
npm run eigen:preflight

# 2. Deploy to Eigen (commands per your installed ecloud version; verify with
#    `ecloud deploy --help`).
ecloud auth login
ecloud env set sepolia
docker tag hecate:amd64-smoke <eigen-registry>/<account>/hecate:v1
docker push                   <eigen-registry>/<account>/hecate:v1
ecloud deploy <eigen-registry>/<account>/hecate:v1 \
  -e RUNTIME_MODE=EIGEN_TEE \
  -e ENGINE_PRIVATE_KEY=<dev-key> \
  -e CODE_DIGEST=<deployed-image-digest> \
  -e EIGENCOMPUTE_APP_ID=<from ecloud> \
  -e EIGENCOMPUTE_IMAGE_DIGEST=<from ecloud> \
  -e EIGENCOMPUTE_ATTESTATION_ID=<from ecloud>

# 3. Verify attestation.
EXPECTED_MODE=EIGEN_TEE npm run eigen:attest-check -- https://<deployed-url>

# 4. Record:
#    - Eigen URL: _______________
#    - Image digest: _______________
#    - App ID: _______________
#    - Attestation ID: _______________
```

### Baseline confirm

```sh
# Run every test surface. All should pass.
npm install
npm run typecheck
npm test                          # expect: 654 / 654
cd contracts && forge test        # expect: 9 / 9
cd ..
bash scripts/demo-replay.sh       # expect: ALL DEMO SCENARIOS PASSED
```

---

## T−1 hour

Fresh start on the demo machine. Nothing in the background.

```sh
# 1. Fresh repo state.
cd /path/to/Hecate
git status                        # confirm clean
git log --oneline -5              # confirm expected HEAD

# 2. Re-verify everything still passes.
npm install
npm run typecheck
npm test

# 3. If the engine will run on Eigen during the demo, attest-check it.
EXPECTED_MODE=EIGEN_TEE npm run eigen:attest-check -- https://<deployed-url>

# 4. Dry-run the on-chain verify path (no broadcast yet).
#    Need a saved bundle first — produce one quickly:
npm run dev > /tmp/hecate.log 2>&1 &
sleep 3
npm run simulate -- --reset-demo-state --data-dir ./data --save-bundle ./data/last-bundle.json
SEPOLIA_RPC_URL=$SEPOLIA_RPC_URL VERIFIER_ADDRESS=$VERIFIER_ADDRESS \
  npm run onchain:verify -- ./data/last-bundle.json --dry-run
pkill -f "tsx server/index.ts"
```

---

## T−15 minutes

Final stage setup.

```sh
# 1. Mute notifications. Quit messaging apps. Full-screen the terminal.

# 2. Start a fresh local engine. Leave this terminal visible to the audience.
cd /path/to/Hecate
rm -f data/*.jsonl data/vault.json data/reservations.json data/last-bundle.json data/last-bundle.json.id.txt
npm run dev
# (this terminal stays running for the duration)

# 3. In a second terminal: confirm /healthz and /attestation.
curl -s http://127.0.0.1:8787/healthz | jq .
curl -s http://127.0.0.1:8787/attestation | jq .

# 4. In a browser: open three tabs.
#    Tab 1: http://127.0.0.1:8787/        — web verifier panel
#    Tab 2: https://sepolia.etherscan.io/address/$VERIFIER_ADDRESS
#    Tab 3: (slides, if any)

# 5. Set environment variables for the on-chain step.
export SEPOLIA_RPC_URL=...
export VERIFIER_ADDRESS=...
export DEPLOYER_PRIVATE_KEY=...
```

---

## T−0: the demo

Each step has the command, what you say, and what success looks like.

### Step 1 — Attestation (30 seconds)

```sh
curl -s http://127.0.0.1:8787/attestation | jq .
```

**Say:** "This is Hecate's identity. `runtime_mode`, `engine_address`,
`engine_code_digest`, and crucially `signer.mode: LOCAL_DEV_KEY` — we're
honest that v1 uses a local dev key for receipt signing in both modes."

**Looks like:** JSON with `runtime_mode`, `engine_address`, the LOCAL_MOCK
warning, and `signer.mode = LOCAL_DEV_KEY`.

### Step 2 — Canonical 4-agent demo (90 seconds)

```sh
npm run simulate -- --reset-demo-state --data-dir ./data --save-bundle ./data/last-bundle.json
```

**Say:** "Four agents submit intents. Three accepted, one rejected with
`INSUFFICIENT_FUNDS` (D under-funded by design). The batch closes,
clearing price 3590, three matched. Then three cross-agent attacks all
correctly rejected: `NOT_RECEIPT_OWNER`, `INVALID_REQUEST_SIGNATURE`,
`STALE_REQUEST`. Final balances match the locked outcomes exactly."

**Looks like:** ends with `✓ demo complete: every expected outcome matched`.

Note the `bundle_id` line — read it aloud if you want.

### Step 3 — Verify in the browser (45 seconds)

In **Tab 1** (the panel at `http://127.0.0.1:8787/`):

1. Drag `./data/last-bundle.json` into the drop area.
2. Click **Verify honest**. Green banner appears.

**Say:** "Same verifier, different surface. The web panel calls the same
`verifyFullBatch` the CLI uses; the green panel means every signature,
every hash, every settlement invariant lined up."

### Step 4 — Tamper in the browser (45 seconds)

In the panel:

1. Pick **wrong-key** from the scenario dropdown.
2. Click **Tamper & verify**. Red banner with `ENGINE_SIGNER_MISMATCH`.

**Say:** "We rebuilt the receipt body unchanged and signed it with a
different key. Every structural field still matches, but recovery
returns a different signer, so authority binding fires. This is one of
14 tamper scenarios — all of them reject."

### Step 5 — On-chain verify on Sepolia (60 seconds)

```sh
npm run onchain:verify -- ./data/last-bundle.json
```

**Say:** "Same bundle, same engine signature, now verified on Ethereum
Sepolia. The script computes the canonical-JSON body hash off-chain,
the contract on-chain runs `ecrecover`, and emits a `ReceiptVerified`
event with the bundle hash and the engine address."

**Looks like:** prints `tx hash:`, then `confirmed in block …`, then the
event details with `signer:` matching the engine address.

Switch to **Tab 2** (Etherscan). Refresh. Click the new tx. Show the
event log. Audience sees a real on-chain transaction with the bundle hash.

### Step 6 — Full tamper sweep (45 seconds, optional)

```sh
bash scripts/demo-replay.sh
```

**Say:** "Fourteen scripted tamper scenarios. Every one rejects. The
property-based fuzz in the test suite extends this to 200+ random
mutations of a saved bundle — also all reject."

**Looks like:** ends with `ALL DEMO SCENARIOS PASSED`.

### Step 7 — Limitations (30 seconds, do not skip)

**Say** (no command, read this aloud or show on a slide):

> Hecate does not provide ZK-grade privacy. It does not hide strategy
> over time. It does not solve MEV. It does not provide submitter
> anonymity. The LOCAL_MOCK runtime is non-security; in EIGEN_TEE the
> privacy property rests on the TEE platform's integrity. The v1 vault
> is a mock prefunded ledger; production custody is future work. The
> narrow claim is: trust-reduced confidential execution that mitigates
> pre-match inspection of rich intent contents. That claim, we test;
> everything else is honestly out of scope.

This is the part that separates "honest research" from "marketing."
Reviewers care about it.

---

## Recovery branches

**Server won't start:**
- Check `ENGINE_PRIVATE_KEY` env var is set (64 hex chars + 0x prefix).
- Check `DATA_DIR` exists and is writable.
- Tail `/tmp/hecate.log` for the actual error.

**Every intent rejects with `MALFORMED_PAYLOAD`:**
- `CODE_DIGEST` mismatch between server and simulator. Re-run with
  `--code-digest <server's digest>`. Server's digest is in
  `/attestation`'s `engine_code_digest` field.

**Stale balances detected by the simulator:**
- Restart `npm run dev`. The simulator's `--reset-demo-state` only
  deletes disk files; the server's in-memory state persists otherwise.

**`bash scripts/demo-replay.sh` runs but a scenario reports unexpected:**
- Look at the bundle the simulator saved (`./data/last-bundle.json`).
  If it's old, re-run `npm run simulate -- --save-bundle ./data/last-bundle.json`
  to refresh.

**`npm run onchain:verify` fails:**
- Try `--dry-run` first. If dry-run reports `✗ would reject`, the
  bundle's engine address doesn't match the contract's expected. Verify
  `VERIFIER_ADDRESS` points at the contract you deployed.
- If dry-run passes but broadcast fails: wallet probably out of Sepolia
  ETH. Visit the faucet again.
- If Sepolia RPC is unresponsive: switch to a backup RPC URL (have one
  ready).

**Etherscan tx page is slow to load:**
- Have a screenshot of a previous successful run as a fallback. Show
  that and explain the audience can verify themselves later.

**Live engine fails mid-demo:**
- If `npm run dev` crashes: restart it, re-run `--reset-demo-state`.
- If anvil-style local-node was running and died: not relevant in this
  demo (Sepolia is live). If using a local anvil for development demo:
  restart `anvil`, re-deploy the contract, re-export `VERIFIER_ADDRESS`.

**Worst-case: live demo can't recover in time:**
- Skip Step 5 (on-chain verify on Sepolia). The Steps 1–4 + 6 already
  demonstrate the full integrity story. The Sepolia piece is the visual
  cherry; the underlying claim doesn't depend on it.

---

## After the demo

```sh
# Stop the local engine.
pkill -f "tsx server/index.ts"

# Clean state for next time.
rm -rf data/*.jsonl data/vault.json data/reservations.json data/last-bundle.json data/last-bundle.json.id.txt
```

If anyone asks for the bundle: `./data/last-bundle.json` is yours to
share. The `.id.txt` sibling holds the bundle_id for cross-checking.
