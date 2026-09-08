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

# The git checks skip themselves without this, saying so rather than failing.
git -C /tmp/nocturn-test init -b main
git -C /tmp/nocturn-test add -A
git -C /tmp/nocturn-test commit -m "Initial"

cargo run -- --root /tmp/nocturn-test --token test-token-abc123 --bind 127.0.0.1:7071

# terminal 2
node tests/e2e.mjs
```

## The other suites

`revoke.mjs` runs against the same daemon and needs nothing extra: it mints its
own token, opens a socket with it, and revokes it mid-session.

`roots.mjs` needs a daemon started with a specific arrangement, because what it
tests is confinement *between* roots — including the nested case, where "inside
a root" and "inside the root you asked for" stop being the same question.

```bash
mkdir -p /tmp/nocturn-roots/alpha/inner /tmp/nocturn-roots/beta
echo alpha > /tmp/nocturn-roots/alpha/alpha-only.txt
echo inner > /tmp/nocturn-roots/alpha/inner/inner-only.txt
echo beta  > /tmp/nocturn-roots/beta/beta-only.txt
git -C /tmp/nocturn-roots/beta init -b main
git -C /tmp/nocturn-roots/beta add -A
git -C /tmp/nocturn-roots/beta commit -m "Initial"

cargo run -- --token test-token-abc123 --bind 127.0.0.1:7071 \
  --root /tmp/nocturn-roots/alpha \
  --root /tmp/nocturn-roots/beta \
  --root /tmp/nocturn-roots/alpha/inner

node tests/roots.mjs
```

It writes into `beta`, so give it a throwaway directory rather than a real
project.

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
- A session reports what it is *doing*, not only that it is alive: a finished
  command settles to `idle` at a prompt, and a shell blocked on a question
  settles to `waiting` carrying the question. The second is the one worth
  having — an agent stopped on a permission prompt is otherwise
  indistinguishable from one still thinking.
- A resize to the geometry already in effect produces **no output at all**,
  while a real one still reaches the PTY. Clients re-send their geometry
  freely — on attach, and on any layout change that leaves the character grid
  alone — and ConPTY answers *any* resize by repainting its whole viewport.
  Those repaint bytes are output like any other: they enter the scrollback
  every later reattach replays, and they reach every client already attached.
  On a narrow terminal the repaint lands beside what is on screen and the
  prompt appears twice on one line.
- File list, read, and write round-trip.
- Traversal is refused, and absolute paths are refused with 400 on every
  platform without leaking host file contents.
- Git status, staging, and unstaging round-trip; `discard` refuses untracked
  files rather than deleting something nothing can restore; and traversal is
  refused through the git routes too, which reach the filesystem by a different
  path than the file API and so have to be proved separately.
- Session delete kills the shell and removes it from the listing.

The git checks never commit. Pointing the suite at a repository you care about
will leave it as it found it — the staged file is unstaged again on the way out.

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
