# Nocturn

Command Claude Code — and your project files — from your phone, while your
laptop is asleep.

## The premise, corrected

The obvious version of this idea is "an app that controls my sleeping laptop."
That cannot work: Claude Code has to run *somewhere*, and a phone cannot summon
a machine that is powered off. Nocturn is the version that does work — **a
persistent remote workspace with thin clients**:

- An **agent daemon** runs on an always-on host that holds your code (a VM, a
  home server, a spare box). It owns the shells and the project tree.
- **Clients** (mobile, desktop, web) attach to it, and detach freely. The
  shells keep running either way.

Your laptop being asleep stops mattering, because your laptop was never the
thing running Claude.

## Why not SSH in the app

Putting an SSH client in a mobile app means private keys on a phone, sockets
that die when iOS backgrounds the app, PTY resize handling, and a session that
vanishes on every wifi-to-LTE handoff. That is a lot of pain for a connection
layer nobody ever sees.

Nocturn uses a WebSocket instead, and the phone never holds a shell credential —
only a revocable token. A stolen phone gets a token you can rotate, not a key
that unlocks your infrastructure.

## Status

| Component | State |
|---|---|
| `agent/` — Rust daemon: persistent PTY sessions, file API, token auth | **working, tested** |
| `web/` — React + xterm.js client, mobile-first | **working, tested** |
| `deploy/` — systemd unit, installer, Tailscale runbook | **written, not yet run on a real VM** |
| `desktop/` — Tauri v2 shell | not started |
| `mobile/` — Tauri v2 mobile or React Native | not started |
| Landing page | not started |
| Broker (multi-user relay) | deliberately deferred — see below |

## Architecture

```
  phone / desktop / browser
            |
            |  WebSocket: binary frames = raw PTY bytes
            |             text frames   = JSON control messages
            v
      nocturn-agent          <-- always-on host (VM on your own hardware)
       |          |
    PTY sessions  file API (root-confined)
       |
    bash / claude / anything
```

**The one rule that matters:** a `Session` owns its PTY *and* the thread reading
from it. A WebSocket connection is a *view* onto a session, never its owner. So
closing the app, losing signal, or the phone killing the process in the
background has no effect on the running shell — and every byte it printed while
you were gone is waiting in the scrollback when you reattach.

### No broker, for now

The multi-user design routes clients through a broker that the daemon dials
*out* to, so the host needs no inbound port and no public IP. That is the right
shape for a product with users, and it is the design to grow into.

For a single operator it is unnecessary complexity. Run the daemon bound to
loopback and reach it over **Tailscale** (free, 100 devices) or a **Cloudflare
Tunnel** (free tier). Same NAT traversal, same zero exposed ports, none of the
infrastructure. Cost: nothing.

## Running it

```bash
# build the client
cd web && npm install && npm run build && cd ..

# build and start the daemon, serving that client
cd agent
cargo build --release
./target/release/nocturn-agent \
  --root /srv/projects/my-app \
  --bind 127.0.0.1:7071 \
  --web ../web/dist
```

Open the address, paste the token, and you have a terminal. To put it on a real
always-on host, see [deploy/README.md](deploy/README.md) — the short version is
an installer plus `tailscale serve`, with no inbound port anywhere.

On first run it generates a token and persists it to
`~/.config/nocturn/agent.token` (`%APPDATA%\nocturn\agent.token` on Windows),
then prints it. Pass `--token` or set `NOCTURN_TOKEN` to supply your own.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--bind` | `127.0.0.1:7071` | Listen address. Keep it on loopback; expose via Tailscale, not a port-forward. |
| `--root` | cwd | Project root. Shells start here; the file API cannot escape it. |
| `--token` | generated | Access token. Also `NOCTURN_TOKEN`. |
| `--shell` | `$SHELL -l`, or PowerShell | Shell to spawn. Accepts arguments: `--shell "tmux new -A -s claude"`. |
| `--web` | — | Serve a built web client from this directory. |
| `--allow-api-key` | off | See the billing note below. |

### The `ANTHROPIC_API_KEY` trap

When that variable is present in the environment, Claude Code bills at
pay-as-you-go API rates and **silently ignores a Pro or Max subscription**. The
daemon owns the environment of every shell it spawns, so it strips
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` by default. Pass
`--allow-api-key` only if you genuinely mean to bill against the API.

## HTTP API

All routes except `/health` require the token, presented one of three ways:

1. `Authorization: Bearer <token>` — native clients.
2. `Sec-WebSocket-Protocol: nocturn.v1, bearer.<token>` — browsers, which cannot
   set headers on a WebSocket. Keeps the token out of URLs and access logs.
3. `?token=<token>` — testing only; query strings land in proxy logs.

| Method | Path | |
|---|---|---|
| `GET` | `/health` | Unauthenticated liveness check. |
| `GET` | `/ws/terminal?session=&cols=&rows=` | Attach to a session, creating it if new. |
| `GET` | `/api/sessions` | List sessions with state and scrollback size. |
| `DELETE` | `/api/sessions/{id}` | Kill the shell and discard the session. |
| `GET` | `/api/fs/list?path=` | Directory listing, root-relative. |
| `GET` | `/api/fs/read?path=` | File contents (2 MiB cap, UTF-8 text only). |
| `PUT` | `/api/fs/write` | `{"path":"…","content":"…"}` |

### WebSocket protocol

Binary frames carry raw PTY bytes in both directions — no framing overhead, and
xterm.js writes them straight through. Text frames carry JSON:

```jsonc
// client -> server
{"type":"resize","cols":120,"rows":40}
{"type":"ping"}

// server -> client
{"type":"ready","session":"main","cols":120,"rows":40,"replayed":8412,"alive":true}
{"type":"exit","code":0}
{"type":"pong"}
{"type":"error","message":"output dropped: 3 chunks skipped"}
```

On attach the server sends the scrollback as one binary frame, *then* `ready`.
Subscription and snapshot happen under a single lock, so a client sees every
byte exactly once — no gap at the seam, no duplicate.

**Clients must answer Device Status Report queries.** A shell's line editor
emits `ESC [ 6 n` at startup and blocks until a terminal replies with the cursor
position. xterm.js does this natively; a hand-rolled client must reply
`ESC [ <row> ; <col> R` or the shell never reaches its prompt.

## Security posture

- The phone holds a revocable token, never an SSH key or shell credential.
- Tokens compare in constant time.
- The file API canonicalizes every path and rejects anything that resolves
  outside the root — including symlinks that point out of the tree.
- The terminal is deliberately *not* confined. It is a shell; treat token
  disclosure as equivalent to shell access on that host and rotate accordingly.
- Keep `sshd` at `PasswordAuthentication no` regardless. Nocturn does not need
  SSH, and password auth is what gets self-hosted boxes owned.

## Deploying from a phone

The headline feature and the biggest liability in the same gesture — a
fat-fingered tap on a train is how outages happen. Planned mitigations, to build
in from the start rather than bolt on:

- Trigger a CI pipeline rather than running deploy commands directly.
- Require typed confirmation for anything touching production.
- Append-only audit log: user, timestamp, session, command.

That audit trail is also the thing that makes this sellable to anyone managing
infrastructure on behalf of other people.

## Prior art worth checking before building more

- **ServerCC** — third-party app already close to this idea: SSH key management,
  Claude Code session start/resume, persistent sessions, file browsing. Worth a
  day of use to find what is genuinely missing.
- **Claude Code Remote Control** — bridges a *local* session to mobile, so it
  dies with your laptop. Does not solve laptop-off.
- **Claude Code on the web** — runs on Anthropic infrastructure. Solves
  laptop-off, but gives you a fresh environment, not your box with your data.

## Tests

```bash
cd agent && cargo test              # path confinement, token comparison
node agent/tests/e2e.mjs            # daemon over the wire, 19 checks
cd web && npm run test:browser      # the client in headless Chrome, 10 checks
```

Both wire-level suites need a daemon running with a known token; see
[agent/tests/README.md](agent/tests/README.md).

The check that matters most is session persistence: start a counter, detach,
wait, reattach, and confirm the ticks emitted while nothing was listening are
present in the replay. If that ever regresses, the product no longer does the
one thing it exists to do.
