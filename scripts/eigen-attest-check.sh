#!/usr/bin/env bash
# Hecate attestation check — assert the live /attestation endpoint matches
# the expected runtime mode and required fields.
#
# Usage:
#   bash scripts/eigen-attest-check.sh BASE_URL
#
# Environment:
#   EXPECTED_MODE   "EIGEN_TEE" (default) or "LOCAL_MOCK"
#
# Exit 0 on pass, 1 on any mismatch or unreachable URL.
#
# Used:
#   - docker-smoke-amd64.sh (EXPECTED_MODE=LOCAL_MOCK against the local container)
#   - eigen-preflight.sh (final check before deploy)
#   - manually, after Eigen deploy: EXPECTED_MODE=EIGEN_TEE bash ... https://<deployed-url>

set -euo pipefail

BASE_URL="${1:?usage: $0 BASE_URL  (set EXPECTED_MODE=LOCAL_MOCK|EIGEN_TEE; default EIGEN_TEE)}"
EXPECTED_MODE="${EXPECTED_MODE:-EIGEN_TEE}"

if ! command -v jq > /dev/null 2>&1; then
  echo "× jq not installed; install with: brew install jq" >&2
  exit 1
fi

if [ "$EXPECTED_MODE" != "LOCAL_MOCK" ] && [ "$EXPECTED_MODE" != "EIGEN_TEE" ]; then
  echo "× EXPECTED_MODE must be LOCAL_MOCK or EIGEN_TEE (got: $EXPECTED_MODE)" >&2
  exit 1
fi

response=$(curl -sf "$BASE_URL/attestation") || {
  echo "× could not reach $BASE_URL/attestation" >&2
  exit 1
}

mode=$(echo "$response" | jq -r '.runtime.runtime_mode')
engine=$(echo "$response" | jq -r '.engine_address')
digest=$(echo "$response" | jq -r '.runtime.engine_code_digest')
signer_mode=$(echo "$response" | jq -r '.signer.mode')
matching_rule=$(echo "$response" | jq -r '.matching_rule')

failures=0

if [ "$mode" != "$EXPECTED_MODE" ]; then
  echo "× runtime_mode mismatch: expected $EXPECTED_MODE, got $mode" >&2
  failures=$((failures + 1))
fi

if [ "$matching_rule" != "UNIFORM_CLEARING_PRICE_V1" ]; then
  echo "× matching_rule mismatch: expected UNIFORM_CLEARING_PRICE_V1, got $matching_rule" >&2
  failures=$((failures + 1))
fi

# Strict null/non-null coherence for Eigen metadata.
app_id=$(echo "$response" | jq -r '.runtime.eigencompute_app_id // ""')
img_digest=$(echo "$response" | jq -r '.runtime.eigencompute_image_digest // ""')
att_id=$(echo "$response" | jq -r '.runtime.eigencompute_attestation_id // ""')

# Check each eigen field individually (instead of a key:value packed loop)
# so values containing colons — e.g., a `sha256:abc...` digest — don't
# truncate the iteration variable.
if [ "$EXPECTED_MODE" = "EIGEN_TEE" ]; then
  if [ -z "$app_id" ]; then
    echo "× eigencompute_app_id is null/empty in EIGEN_TEE mode" >&2
    failures=$((failures + 1))
  fi
  if [ -z "$img_digest" ]; then
    echo "× eigencompute_image_digest is null/empty in EIGEN_TEE mode" >&2
    failures=$((failures + 1))
  fi
  if [ -z "$att_id" ]; then
    echo "× eigencompute_attestation_id is null/empty in EIGEN_TEE mode" >&2
    failures=$((failures + 1))
  fi
else
  # LOCAL_MOCK requires all three eigen fields to be null.
  if [ -n "$app_id" ]; then
    echo "× eigencompute_app_id is set ($app_id) in LOCAL_MOCK mode" >&2
    failures=$((failures + 1))
  fi
  if [ -n "$img_digest" ]; then
    echo "× eigencompute_image_digest is set ($img_digest) in LOCAL_MOCK mode" >&2
    failures=$((failures + 1))
  fi
  if [ -n "$att_id" ]; then
    echo "× eigencompute_attestation_id is set ($att_id) in LOCAL_MOCK mode" >&2
    failures=$((failures + 1))
  fi
fi

if [ "$signer_mode" != "LOCAL_DEV_KEY" ]; then
  # v1 always reports LOCAL_DEV_KEY. If/when app-wallet signing lands, update this.
  echo "× signer.mode unexpected: expected LOCAL_DEV_KEY (v1), got $signer_mode" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "× attestation check FAILED ($failures issue(s)) for $BASE_URL" >&2
  exit 1
fi

echo "✓ attestation check PASSED for $BASE_URL"
echo "    runtime_mode:       $mode"
echo "    engine_address:     $engine"
echo "    engine_code_digest: $digest"
echo "    signer.mode:        $signer_mode"
echo "    matching_rule:      $matching_rule"
if [ "$EXPECTED_MODE" = "EIGEN_TEE" ]; then
  echo "    eigen_app_id:       $app_id"
  echo "    eigen_image_digest: $img_digest"
  echo "    eigen_attestation:  $att_id"
fi
