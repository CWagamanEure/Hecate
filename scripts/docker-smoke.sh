#!/usr/bin/env bash
# Hecate Docker smoke test.
#
# Builds the image, runs the container with LOCAL_MOCK env, runs the simulator
# from the host against the containerized server, saves the resulting bundle,
# verifies it locally, and runs one tamper scenario to prove the integrity
# story works end-to-end through Docker.
#
# Usage:
#   bash scripts/docker-smoke.sh
#   HOST_PORT=8788 bash scripts/docker-smoke.sh   # if 8787 is taken

set -euo pipefail

IMAGE="hecate:smoke"
CONTAINER="hecate-smoke"
HOST_PORT="${HOST_PORT:-8787}"
DATA_DIR="${DATA_DIR:-./data}"
BUNDLE_PATH="${DATA_DIR}/docker-bundle.json"
ENGINE_PK="${ENGINE_PRIVATE_KEY:-0x0000000000000000000000000000000000000000000000000000000000000001}"

echo
echo "======================================================================"
echo "Hecate Docker smoke"
echo "======================================================================"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo
echo "--- step 1: build image ---"
docker build -t "$IMAGE" .

echo
echo "--- step 2: run container ---"
docker run -d --rm \
  --name "$CONTAINER" \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  -e RUNTIME_MODE=LOCAL_MOCK \
  -e ENGINE_PRIVATE_KEY="$ENGINE_PK" \
  -e CODE_DIGEST=sha256:dev-local \
  -e DATA_DIR=/app/data \
  -p "$HOST_PORT":8787 \
  "$IMAGE"

echo
echo "--- step 3: wait for /healthz ---"
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$HOST_PORT/healthz" > /dev/null 2>&1; then
    echo "  up"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  TIMEOUT waiting for /healthz"
    docker logs "$CONTAINER" || true
    exit 1
  fi
  sleep 1
done

echo
echo "--- step 4: GET /attestation ---"
curl -s "http://127.0.0.1:$HOST_PORT/attestation"
echo

echo
echo "--- step 5: run simulator against container, save bundle ---"
mkdir -p "$DATA_DIR"
npm run simulate -- \
  --base-url "http://127.0.0.1:$HOST_PORT" \
  --code-digest sha256:dev-local \
  --save-bundle "$BUNDLE_PATH"

echo
echo "--- step 6: verify the saved bundle locally ---"
npm run verify -- "$BUNDLE_PATH"

echo
echo "--- step 7: run wrong-key tamper, expect rejection ---"
npm run verify -- "$BUNDLE_PATH" --scenario wrong-key --expect-fail

echo
echo "======================================================================"
echo "DOCKER SMOKE PASSED"
echo "  built image:        $IMAGE"
echo "  honest bundle:      VERIFIED"
echo "  tamper scenario:    REJECTED as expected"
echo "======================================================================"
