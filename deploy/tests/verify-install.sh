#!/usr/bin/env bash
# Runs install.sh inside a throwaway Debian container and asserts what it
# actually produced: the service account, file modes, token, and unit file.
#
#   ./deploy/tests/verify-install.sh
#
# systemd itself is stubbed. Running real systemd in a container needs
# --privileged and cgroup mounts and is flaky across Docker backends, so this
# verifies everything the installer does *around* systemd — which is where the
# mistakes that matter live — and records the enable/start calls it made.
set -euo pipefail

cd "$(dirname "$0")/../.."

case "${OSTYPE:-}" in
  msys* | cygwin*)
    export MSYS_NO_PATHCONV=1
    export MSYS2_ARG_CONV_EXCL='*'
    HOST_ROOT="$(pwd -W)"
    ;;
  *) HOST_ROOT="$(pwd)" ;;
esac

BINARY="agent/nocturn-agent-linux"
if [[ ! -f "$BINARY" ]]; then
  echo "error: $BINARY not found. Run deploy/build-linux.sh first." >&2
  exit 1
fi

docker run --rm -v "$HOST_ROOT:/work:ro" debian:stable-slim bash -euo pipefail -c '
  pass=0; fail=0
  check() { # check <name> <condition-result>
    if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1));
    else echo "FAIL  $1${3:+  — $3}"; fail=$((fail+1)); fi
  }

  # A stub that records what the installer asked systemd to do, so the calls can
  # be asserted even though nothing is really started.
  mkdir -p /stub /var/log
  cat > /stub/systemctl <<STUB
#!/bin/sh
echo "systemctl \$*" >> /var/log/systemctl-calls
# The installer checks is-active before declaring success; report running.
case "\$1" in is-active) exit 0 ;; esac
exit 0
STUB
  chmod +x /stub/systemctl
  export PATH=/stub:$PATH
  : > /var/log/systemctl-calls

  # tailscale is deliberately absent, exercising the not-installed guidance path.
  cp -r /work/deploy /tmp/deploy
  cp /work/agent/nocturn-agent-linux /tmp/
  chmod +x /tmp/deploy/install.sh

  echo "=== running install.sh ==="
  /tmp/deploy/install.sh --binary /tmp/nocturn-agent-linux > /tmp/install.log 2>&1 \
    || { echo "installer exited non-zero:"; cat /tmp/install.log; exit 1; }
  echo

  # --- service account ---
  id nocturn >/dev/null 2>&1; check "service user nocturn exists" $?
  [ "$(id -u nocturn)" -lt 1000 ]; check "nocturn is a system account" $?
  [ "$(id -u nocturn)" -ne 0 ]; check "nocturn is not root" $?

  # --- binary ---
  [ -x /usr/local/bin/nocturn-agent ]; check "binary installed and executable" $?
  /usr/local/bin/nocturn-agent --version >/dev/null 2>&1
  check "installed binary actually runs on this OS" $? "static musl build"

  # --- token file: the credential, so its mode matters most ---
  [ -f /etc/nocturn/agent.env ]; check "env file created" $?
  [ "$(stat -c %a /etc/nocturn/agent.env)" = "640" ]; check "env file is mode 640" $? \
    "got $(stat -c %a /etc/nocturn/agent.env 2>/dev/null)"
  [ "$(stat -c %U:%G /etc/nocturn/agent.env)" = "root:nocturn" ]; check "env file is root:nocturn" $? \
    "got $(stat -c %U:%G /etc/nocturn/agent.env 2>/dev/null)"
  [ "$(stat -c %a /etc/nocturn)" = "750" ]; check "config dir is mode 750" $?

  TOKEN=$(grep -oP "(?<=^NOCTURN_TOKEN=).*" /etc/nocturn/agent.env)
  echo "$TOKEN" | grep -qE "^[0-9a-f]{64}$"; check "token is 64 hex chars (256-bit)" $?

  # --- project root ---
  [ -d /srv/projects ]; check "project root created" $?
  [ "$(stat -c %U /srv/projects)" = "nocturn" ]; check "project root owned by nocturn" $?

  # --- unit ---
  [ -f /etc/systemd/system/nocturn-agent.service ]; check "unit installed" $?
  grep -q "^WorkingDirectory=/srv/projects" /etc/systemd/system/nocturn-agent.service
  check "unit WorkingDirectory matches project root" $?
  grep -q "^EnvironmentFile=/etc/nocturn/agent.env" /etc/systemd/system/nocturn-agent.service
  check "unit reads the token from the env file, not inline" $?
  grep -q "^User=nocturn" /etc/systemd/system/nocturn-agent.service
  check "unit runs as the unprivileged user" $?
  grep -q "^KillMode=control-group" /etc/systemd/system/nocturn-agent.service
  check "unit cleans up spawned shells on restart" $?

  grep -q "daemon-reload" /var/log/systemctl-calls; check "installer reloaded systemd" $?
  grep -q "enable --now nocturn-agent" /var/log/systemctl-calls; check "installer enabled the service" $?

  # --- the token must never appear in the unit file itself ---
  ! grep -q "$TOKEN" /etc/systemd/system/nocturn-agent.service
  check "token absent from the unit file" $?

  # --- guidance when tailscale is missing ---
  grep -q "tailscale.com/install.sh" /tmp/install.log
  check "prints Tailscale setup steps when it is not installed" $?
  grep -q "do not open a firewall port" /tmp/install.log
  check "warns against opening a firewall port" $?

  # --- idempotence: re-running must not rotate the token ---
  echo
  echo "=== re-running install.sh ==="
  /tmp/deploy/install.sh --binary /tmp/nocturn-agent-linux > /tmp/install2.log 2>&1 \
    || { echo "second run exited non-zero:"; cat /tmp/install2.log; exit 1; }
  TOKEN2=$(grep -oP "(?<=^NOCTURN_TOKEN=).*" /etc/nocturn/agent.env)
  [ "$TOKEN" = "$TOKEN2" ]; check "re-running preserves the existing token" $?
  grep -q "Keeping existing token" /tmp/install2.log; check "re-run reports it kept the token" $?
  echo

  echo "$pass passed, $fail failed"
  [ "$fail" -eq 0 ]
'
