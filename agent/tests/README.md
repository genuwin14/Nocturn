# End-to-end tests

`cargo test` covers path confinement and token comparison in isolation. This
suite exercises the running daemon over the wire, including the property the
product depends on: **a session keeps running, and keeps buffering output, with
no client attached**.

Requires Node 22+ (for the built-in `WebSocket` global). No npm install.

```bash
# terminal 1 — a throwaway root, a known token
mkdir -p /tmp/nocturn-test/src
echo "hello from nocturn" > /tmp/nocturn-test/readme.txt
cargo run -- --root /tmp/nocturn-test --token test-token-abc123 --bind 127.0.0.1:7071

# terminal 2
node tests/e2e.mjs
```

## Configuration

| Variable | Default |
|---|---|
| `NOCTURN_TEST_URL` | `http://127.0.0.1:7071` |
| `NOCTURN_TEST_TOKEN` | `test-token-abc123` |
| `NOCTURN_TEST_SHELL` | `powershell` on Windows, `posix` elsewhere |

Set `NOCTURN_TEST_SHELL` explicitly when the daemon is not on the same platform
as the test runner — for example driving a Linux daemon in a container from a
Windows host:

```bash
NOCTURN_TEST_SHELL=posix node tests/e2e.mjs
```

The shell dialect controls the tick loop, the warm-up delay, and which paths are
used for the confinement checks. Everything else is platform independent.

## What it asserts

- `/health` answers without a token; `/api/*` returns 401 with none and 403 with
  a wrong one.
- A shell reaches its prompt. On PowerShell the harness answers the startup
  `ESC [ 6 n` cursor-position query the way xterm.js does, because PSReadLine
  blocks until something replies. Bash's line editor does not emit one, so that
  check is skipped there rather than failing.
- Ticks emitted while **zero clients are attached** are present in the scrollback
  replay on reattach — the core persistence guarantee. If this regresses, the
  product no longer does the one thing it exists for.
- File list, read, and write round-trip.
- Traversal is refused, and absolute paths are refused with 400 on every
  platform without leaking host file contents.
- Session delete kills the shell and removes it from the listing.

## Verifying the Linux build from a Windows workstation

The daemon behaves differently on each platform's PTY layer — ConPTY on Windows,
a real pty pair on Unix — so passing on one proves little about the other. To
exercise the build that will actually be deployed:

```bash
./deploy/build-linux.sh

docker run -d --name nocturn-test -p 7071:7071 \
  -v "$(pwd -W)/agent/nocturn-agent-linux:/usr/local/bin/nocturn-agent:ro" \
  debian:stable-slim bash -c '
    mkdir -p /srv/projects/src
    echo "hello from nocturn" > /srv/projects/readme.txt
    exec /usr/local/bin/nocturn-agent --root /srv/projects \
      --token test-token-abc123 --bind 0.0.0.0:7071
  '

NOCTURN_TEST_SHELL=posix node agent/tests/e2e.mjs
docker rm -f nocturn-test
```

Use `$(pwd)` instead of `$(pwd -W)` outside Git Bash. The binary is static, so
the base image only needs to provide a shell.
