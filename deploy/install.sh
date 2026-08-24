#!/usr/bin/env bash
# Installs nocturn-agent as a systemd service on a Linux host.
#
#   sudo ./install.sh --binary nocturn-agent-linux   # from a cross-built binary
#   sudo ./install.sh --from-source                  # build here (needs cargo)
#
# Safe to re-run: it upgrades the binary and leaves the existing token and
# project directory alone.
set -euo pipefail

SERVICE_USER="nocturn"
BIN_DEST="/usr/local/bin/nocturn-agent"
CONF_DIR="/etc/nocturn"
ENV_FILE="$CONF_DIR/agent.env"
PROJECT_ROOT="${NOCTURN_PROJECT_ROOT:-/srv/projects}"
UNIT_DEST="/etc/systemd/system/nocturn-agent.service"
BIND_ADDR="${NOCTURN_BIND:-127.0.0.1:7071}"

BINARY=""
FROM_SOURCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)      BINARY="$2"; shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --bind)        BIND_ADDR="$2"; shift 2 ;;
    --root)        PROJECT_ROOT="$2"; shift 2 ;;
    -h|--help)     sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: this installer targets systemd hosts." >&2
  exit 1
fi

# --- obtain the binary -------------------------------------------------------

if [[ $FROM_SOURCE -eq 1 ]]; then
  command -v cargo >/dev/null 2>&1 || {
    echo "error: --from-source needs cargo. Install rustup, or cross-build with" >&2
    echo "deploy/build-linux.sh and pass --binary instead." >&2
    exit 1
  }
  echo "==> Building from source"
  ( cd "$(dirname "$0")/../agent" && cargo build --release )
  BINARY="$(dirname "$0")/../agent/target/release/nocturn-agent"
fi

if [[ -z "$BINARY" ]]; then
  echo "error: pass --binary <path> or --from-source." >&2
  exit 1
fi

if [[ ! -f "$BINARY" ]]; then
  echo "error: no such binary: $BINARY" >&2
  exit 1
fi

# --- service account ---------------------------------------------------------
# An unprivileged account, because a Nocturn token is equivalent to shell access
# as this user. Running it as root would make a leaked token equivalent to root.

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Creating $SERVICE_USER user"
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" \
          --shell /bin/bash "$SERVICE_USER"
else
  echo "==> User $SERVICE_USER already exists"
fi

# --- install -----------------------------------------------------------------

echo "==> Installing binary to $BIN_DEST"
install -m 0755 "$BINARY" "$BIN_DEST"

mkdir -p "$PROJECT_ROOT"
chown "$SERVICE_USER:$SERVICE_USER" "$PROJECT_ROOT"
echo "==> Project root: $PROJECT_ROOT"

mkdir -p "$CONF_DIR"
chmod 0750 "$CONF_DIR"

if [[ -f "$ENV_FILE" ]]; then
  echo "==> Keeping existing token in $ENV_FILE"
  TOKEN="$(grep -oP '(?<=^NOCTURN_TOKEN=).*' "$ENV_FILE" || true)"
else
  echo "==> Generating access token"
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENV_FILE" <<EOF
NOCTURN_TOKEN=$TOKEN
NOCTURN_BIND=$BIND_ADDR
NOCTURN_ROOT=$PROJECT_ROOT
EOF
fi

chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

echo "==> Installing systemd unit"
install -m 0644 "$(dirname "$0")/nocturn-agent.service" "$UNIT_DEST"
# Keep the unit's WorkingDirectory in step with a custom --root.
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$PROJECT_ROOT|" "$UNIT_DEST"

systemctl daemon-reload
systemctl enable --now nocturn-agent

sleep 1
if ! systemctl is-active --quiet nocturn-agent; then
  echo
  echo "error: the service failed to start. Recent log:" >&2
  journalctl -u nocturn-agent -n 20 --no-pager >&2
  exit 1
fi

TS_HOST="$(tailscale status --json 2>/dev/null | grep -oP '(?<="DNSName":")[^".]+' | head -1 || true)"

cat <<EOF

  nocturn-agent is running.

  bind        $BIND_ADDR
  root        $PROJECT_ROOT
  token       $TOKEN
  logs        journalctl -u nocturn-agent -f

EOF

if [[ -n "$TS_HOST" ]]; then
  cat <<EOF
  Tailscale detected as '$TS_HOST'. Expose it to your tailnet with:

    sudo tailscale serve --bg 7071

  Then reach it from your phone at https://$TS_HOST.<your-tailnet>.ts.net

EOF
else
  cat <<'EOF'
  Tailscale is not installed. The daemon is bound to loopback, so nothing can
  reach it yet. That is intentional -- do not open a firewall port. Instead:

    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up
    sudo tailscale serve --bg 7071

  That gives you a private HTTPS endpoint reachable from any device on your
  tailnet, with no inbound port and no public exposure.

EOF
fi

echo "  Verify:  curl http://$BIND_ADDR/health"
echo
