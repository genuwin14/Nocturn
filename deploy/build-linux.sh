#!/usr/bin/env bash
# Cross-builds a statically linked Linux binary from any host with Docker.
#
# musl rather than glibc, so the result runs on any x86_64 Linux — Debian,
# Alpine, whatever the VM happens to be — with no runtime dependencies to
# install and no glibc version to match. Copy the output and run it.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="agent/nocturn-agent-linux"
IMAGE="rust:alpine"

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not running." >&2
  echo "Start Docker Desktop (or dockerd) and try again, or build on the target" >&2
  echo "host instead: install rustup there and run 'cargo build --release'." >&2
  exit 1
fi

echo "Building nocturn-agent for x86_64-unknown-linux-musl..."

# The target dir lives inside the container: a Windows-host bind mount would
# otherwise mix MSVC and musl artifacts in the same target/ and force a full
# rebuild every time you switch between them.
docker run --rm \
  -v "$(pwd)/agent:/src" \
  -w /src \
  "$IMAGE" \
  sh -euc '
    apk add --no-cache musl-dev >/dev/null
    rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 || true
    cargo build --release --target x86_64-unknown-linux-musl --target-dir /tmp/target
    cp /tmp/target/x86_64-unknown-linux-musl/release/nocturn-agent /src/nocturn-agent-linux
    strip /src/nocturn-agent-linux || true
  '

echo
echo "Built $OUT"
ls -lh "$OUT"
echo
echo "Next:"
echo "  scp $OUT deploy/install.sh deploy/nocturn-agent.service YOUR_VM:/tmp/"
echo "  ssh YOUR_VM 'cd /tmp && sudo ./install.sh --binary nocturn-agent-linux'"
