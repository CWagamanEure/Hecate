#!/usr/bin/env bash
# Hecate end-to-end replay demo.
#
# Runs the canonical 4-agent demo, saves the resulting bundle, then verifies
# the honest bundle and every tamper scenario in turn.
#
# Prerequisites: the Hecate server must be running in another terminal, e.g.:
#   ENGINE_PRIVATE_KEY=0x000...01 npm run dev

set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
BUNDLE_PATH="${DATA_DIR}/last-bundle.json"

SCENARIOS=(
  clearing-price
  vault-after-hash
  reservation-after-hash
  settlement-hash
  intent-envelope-root
  fill-base
  reserved-released
  signature-bytes
  wrong-key
  swap-fill-receipt-body
  tamper-vault-supporting
  tamper-settlement-deltas
  missing-fill-receipt
  runtime-eigen-incoherent
)

echo
echo "======================================================================"
echo "Hecate end-to-end replay demo"
echo "======================================================================"
echo

# 1. Run the canonical 4-agent demo, save the bundle.
echo "--- step 1: run demo and save bundle ---"
npm run simulate -- --reset-demo-state --data-dir "$DATA_DIR" --save-bundle "$BUNDLE_PATH"

echo
echo "--- step 2: verify the honest bundle ---"
npm run verify -- "$BUNDLE_PATH"

# 3. Run every tamper scenario and confirm each is rejected.
for s in "${SCENARIOS[@]}"; do
  echo
  echo "--- scenario: $s ---"
  npm run verify -- "$BUNDLE_PATH" --scenario "$s" --expect-fail
done

echo
echo "======================================================================"
echo "ALL DEMO SCENARIOS PASSED"
echo "  honest bundle:        VERIFIED"
echo "  tamper scenarios:     ${#SCENARIOS[@]} attacks, all correctly rejected"
echo "======================================================================"
