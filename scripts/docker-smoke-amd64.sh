#!/usr/bin/env bash
# Hecate Docker smoke — linux/amd64 variant.
#
# Builds the image explicitly for linux/amd64 (EigenCompute's architecture),
# runs it under emulation if necessary, then drives the full demo + replay
# flow from the host. Slower than the native arm64 path but is the platform
# Eigen will actually run, so this is the right pre-deploy verification.
#
# Usage:
#   bash scripts/docker-smoke-amd64.sh
#   HOST_PORT=28787 bash scripts/docker-smoke-amd64.sh   # if 8787 is taken

set -euo pipefail

IMAGE="hecate:amd64-smoke"
CONTAINER="hecate-amd64-smoke"
HOST_PORT="${HOST_PORT:-8787}"
DATA_DIR="${DATA_DIR:-./data}"
BUNDLE_PATH="${DATA_DIR}/amd64-bundle.json"
ENGINE_PK="${ENGINE_PRIVATE_KEY:-0x0000000000000000000000000000000000000000000000000000000000000001}"

echo
echo "======================================================================"
echo "Hecate Docker smoke — linux/amd64 (EigenCompute target architecture)"
echo "======================================================================"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker buildx version > /dev/null 2>&1; then
  echo "× docker buildx is not available. Install Docker Desktop or enable buildx."
  exit 1
fi

echo
echo "--- step 1: build image for linux/amd64 ---"
docker buildx build --platform linux/amd64 -t "$IMAGE" --load .

echo
echo "--- step 2: run container under linux/amd64 ---"
docker run -d --rm \
  --platform linux/amd64 \
  --name "$CONTAINER" \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  -e RUNTIME_MODE=LOCAL_MOCK \
  -e ENGINE_PRIVATE_KEY="$ENGINE_PK" \
  -e CODE_DIGEST=sha256:dev-local \
  -e DATA_DIR=/app/data \
  -p "$HOST_PORT":8787 \
  "$IMAGE" > /dev/null

echo
echo "--- step 3: wait for /healthz (allow extra time for emulation) ---"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$HOST_PORT/healthz" > /dev/null 2>&1; then
    echo "  up after ${i}s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "  TIMEOUT waiting for /healthz"
    docker logs "$CONTAINER" || true
    exit 1
  fi
  sleep 1
done

echo
echo "--- step 4: attestation check (expect LOCAL_MOCK) ---"
EXPECTED_MODE=LOCAL_MOCK bash scripts/eigen-attest-check.sh "http://127.0.0.1:$HOST_PORT"

echo
echo "--- step 5: run simulator against amd64 container, save bundle ---"
mkdir -p "$DATA_DIR"
npm run simulate -- \
  --base-url "http://127.0.0.1:$HOST_PORT" \
  --code-digest sha256:dev-local \
  --save-bundle "$BUNDLE_PATH"

echo
echo "--- step 6: verify saved bundle ---"
npm run verify -- "$BUNDLE_PATH"

echo
echo "--- step 7: wrong-key tamper, expect rejection ---"
npm run verify -- "$BUNDLE_PATH" --scenario wrong-key --expect-fail

echo
echo "======================================================================"
echo "AMD64 DOCKER SMOKE PASSED"
echo "  image:                $IMAGE"
echo "  architecture:         linux/amd64"
echo "  honest bundle:        VERIFIED"
echo "  tamper scenario:      REJECTED as expected"
echo
echo "Ready for Eigen deploy. See docs/EIGEN_DEPLOYMENT.md for next steps."
echo "======================================================================"
