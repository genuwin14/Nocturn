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

# Git Bash and Cygwin rewrite arguments that look like Unix paths into Windows
# paths before the program sees them, which turns "-w /src" into something like
# "C:/Program Files/Git/src" and makes Docker reject it. Disable that rewriting,
# and hand Docker a native Windows path for the bind mount, which is the only
# form Docker Desktop reliably accepts.
case "${OSTYPE:-}" in
  msys* | cygwin*)
    export MSYS_NO_PATHCONV=1
    export MSYS2_ARG_CONV_EXCL='*'
    HOST_AGENT_DIR="$(pwd -W)/agent"
    ;;
  *)
    HOST_AGENT_DIR="$(pwd)/agent"
    ;;
esac

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not running." >&2
  echo "Start Docker Desktop (or dockerd) and try again, or build on the target" >&2
  echo "host instead: install rustup there and run 'cargo build --release'." >&2
  exit 1
fi

echo "Building nocturn-agent for x86_64-unknown-linux-musl..."

# The target dir lives in a named volume rather than a host bind mount: sharing
# agent/target with the host would mix MSVC and musl artifacts and force a full
# rebuild on every switch between them. Keeping it in a volume also means the
# second build takes seconds instead of minutes. Remove with:
#   docker volume rm nocturn-build-cache nocturn-cargo-registry
docker volume create nocturn-build-cache >/dev/null
docker volume create nocturn-cargo-registry >/dev/null

docker run --rm \
  -v "$HOST_AGENT_DIR:/src" \
  -v nocturn-build-cache:/tmp/target \
  -v nocturn-cargo-registry:/usr/local/cargo/registry \
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
