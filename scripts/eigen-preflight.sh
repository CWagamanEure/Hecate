#!/usr/bin/env bash
# Pre-deploy local preflight for Hecate on EigenCompute.
#
# Verifies every local prerequisite for an Eigen deployment:
#   1. Docker is available with buildx
#   2. jq is installed (used by attestation check)
#   3. linux/amd64 image builds cleanly
#   4. Container runs and serves /healthz, /attestation correctly
#   5. End-to-end demo against the amd64 container succeeds
#   6. wrong-key tamper rejects
#
# Then prints the exact `ecloud` deploy command template with placeholders
# for the values that come back from Eigen.
#
# Usage:
#   bash scripts/eigen-preflight.sh

set -euo pipefail

echo
echo "======================================================================"
echo "Hecate Eigen preflight"
echo "======================================================================"

echo
echo "--- check 1: docker + buildx ---"
if ! command -v docker > /dev/null 2>&1; then
  echo "× docker not on PATH"
  exit 1
fi
docker --version
if ! docker buildx version > /dev/null 2>&1; then
  echo "× docker buildx not available"
  exit 1
fi
docker buildx version | head -1

echo
echo "--- check 2: jq ---"
if ! command -v jq > /dev/null 2>&1; then
  echo "× jq not on PATH (used by eigen-attest-check.sh). Install with: brew install jq"
  exit 1
fi
jq --version

echo
echo "--- check 3-6: full amd64 smoke ---"
bash scripts/docker-smoke-amd64.sh

echo
echo "======================================================================"
echo "PREFLIGHT PASSED — ready to deploy to EigenCompute"
echo "======================================================================"
echo
echo "Next steps (you run these on your machine; this script cannot):"
echo
echo "  # 1. Authenticate with Eigen."
echo "  ecloud auth login"
echo
echo "  # 2. Target Sepolia (the chain Hecate's app/wallet metadata lives on)."
echo "  ecloud env set sepolia"
echo
echo "  # 3. Tag and push the image you just verified."
echo "  docker tag hecate:amd64-smoke <eigen-registry>/<account>/hecate:v1"
echo "  docker push <eigen-registry>/<account>/hecate:v1"
echo
echo "  # 4. Deploy. The exact ecloud-deploy flag set may have drifted from"
echo "  #    this template — verify against 'ecloud deploy --help' on your CLI."
echo "  ecloud deploy <eigen-registry>/<account>/hecate:v1 \\"
echo "    -e RUNTIME_MODE=EIGEN_TEE \\"
echo "    -e ENGINE_PRIVATE_KEY=<dev-key> \\"
echo "    -e CODE_DIGEST=<deployed-image-digest> \\"
echo "    -e EIGENCOMPUTE_APP_ID=<from ecloud output> \\"
echo "    -e EIGENCOMPUTE_IMAGE_DIGEST=<from ecloud output> \\"
echo "    -e EIGENCOMPUTE_ATTESTATION_ID=<from ecloud output>"
echo
echo "  # 5. Verify the deployed instance attests correctly."
echo "  bash scripts/eigen-attest-check.sh https://<deployed-url>"
echo
echo "  # 6. Run the demo against the deployed instance."
echo "  npm run simulate -- \\"
echo "    --base-url https://<deployed-url> \\"
echo "    --code-digest <deployed-image-digest> \\"
echo "    --save-bundle ./data/eigen-bundle.json"
echo
echo "  # 7. Verify the bundle offline (no contact with Eigen)."
echo "  npm run verify -- ./data/eigen-bundle.json"
echo
echo "  # 8. Run a tamper scenario to demonstrate the integrity story."
echo "  npm run verify -- ./data/eigen-bundle.json --scenario wrong-key --expect-fail"
echo
echo "Detailed runbook: docs/EIGEN_DEPLOYMENT.md"
echo "======================================================================"
