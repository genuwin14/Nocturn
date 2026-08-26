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
| `deploy/` — systemd unit, installer, Tailscale runbook | **verified in a container; not yet run on a real VM** |
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

### On Windows

Two scripts wrap the same commands:

```powershell
.\build.ps1          # both halves; -Agent or -Web for one
.\dev.ps1            # serve this repository on 127.0.0.1:7071
.\dev.ps1 -Root C:\code\my-app -Open
.\dev.ps1 -Root C:\code\api, C:\code\web    # several projects at once
```

They exist for one recurring annoyance: Windows keeps an open handle on a
running executable, so `cargo build` fails with `Access is denied (os error 5)`
whenever the daemon is up, and the error does not say that is why. `build.ps1`
checks first and explains. It will not stop the daemon for you without
`-Force`, because a restart kills every running shell.

`dev.ps1` runs in the foreground, so that terminal *is* the daemon — the log
prints there and Ctrl+C stops it. It also names whatever is holding the port,
which the daemon's own "only one usage of each socket address" does not.

Rebuild the client with `.\build.ps1 -Web` and hard-refresh the browser; no
daemon restart is needed, since `dist/` is served from disk.

On first run it generates a token and persists it to
`~/.config/nocturn/agent.token` (`%APPDATA%\nocturn\agent.token` on Windows),
then prints it. Pass `--token` or set `NOCTURN_TOKEN` to supply your own.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--bind` | `127.0.0.1:7071` | Listen address. Keep it on loopback; expose via Tailscale, not a port-forward. |
| `--root` | cwd | Project root. Shells start here; the file API cannot escape it. Repeatable — see below. |
| `--token` | generated | Access token. Also `NOCTURN_TOKEN`. |
| `--shell` | `$SHELL -l`, or PowerShell | Shell to spawn. Accepts arguments: `--shell "tmux new -A -s claude"`. |
| `--web` | — | Serve a built web client from this directory. |
| `--public-url` | — | The address clients actually reach, for the pairing code. |
| `--pair` | — | Print the pairing code and exit, without starting a server. |
| `--allow-api-key` | off | See the billing note below. |

### Several projects, one daemon

`--root` takes more than one:

```bash
nocturn-agent --root ~/code/nocturn --root ~/code/api --root ~/notes
```

The first is the default — what a request that names no root reaches. Each is
named after its directory, and `name=path` disambiguates two projects whose
folders share a basename:

```bash
nocturn-agent --root client=~/work/acme/api --root internal=~/side/api
```

This exists to make the narrow root the convenient one. A single fixed root
means reaching a second project costs either a second daemon on a second port
or a root like `$HOME`, and everybody picks the second. Root is the blast radius
of the token: rooted at a home directory, one revocable string covers SSH keys,
browser profiles, and saved credentials. Three named roots and there is no
reason to reach for it.

Roots are fixed at startup, deliberately. An endpoint that could add one would
be an endpoint that widens the daemon's own reach, which is a meaningfully
worse thing to hold a token for.

Session names are scoped to their root, so `main` is a different shell in each
project rather than one shared between them. What is *not* affected is the
terminal: `cd` anywhere still works, because confining a shell whose purpose is
running arbitrary commands would be theatre. Root binds the file API and the
directory shells start in.

### Pairing a phone

On startup the daemon prints a QR code next to the token. Scan it and the
client opens already connected — no typing a 64-character hex string on a
phone, and no sending it to yourself through a chat app, which is the thing
people actually do and the worst possible handling of a credential equivalent
to shell access.

The token rides in the URL fragment (`https://host/#pair=…`). Fragments are
never sent to a server, so it cannot appear in an access log, a proxy log, or a
`Referer` header — the same reasoning that keeps it out of the WebSocket URL.
The client clears it from the address bar as soon as it loads.

The daemon binds to loopback and is reached through a tunnel, so it cannot work
out its own public address. Pass `--public-url https://vm.tailnet.ts.net` to
get a code a phone can use; without it the code points at the bind address and
says so.

To add a second device later, `nocturn-agent --pair` prints the code and exits.
It does not restart anything, which matters because a restart kills every
running shell.

A code on screen is a credential on screen — no more exposed than the token
printed above it, but scannable from across a room, which a hex string is not.
Printing on demand beats leaving one in scrollback for the rest of the day.

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
| `GET` | `/ws/terminal?session=&root=&cols=&rows=` | Attach to a session, creating it if new. |
| `GET` | `/api/sessions` | List sessions with their root, state, and scrollback size. |
| `DELETE` | `/api/sessions/{id}?root=` | Kill the shell and discard the session. |
| `GET` | `/api/roots` | The projects served, with paths and which are repositories. |
| `GET` | `/api/fs/list?root=&path=` | Directory listing, root-relative. |
| `GET` | `/api/fs/read?root=&path=` | File contents (2 MiB cap, UTF-8 text only). |
| `PUT` | `/api/fs/write` | `{"root":"…","path":"…","content":"…"}` |
| `GET` | `/api/tokens` | Devices, with last seen and last address. Never returns secrets. |
| `POST` | `/api/tokens` | `{"name":"pixel-9"}` — mints one, returning the secret once. |
| `DELETE` | `/api/tokens/{id}` | Revoke, immediately and including live sockets. |
| `GET` | `/api/git/status?root=` | Branch, ahead/behind, and per-file staged/unstaged state. |
| `GET` | `/api/git/diff?root=&path=&staged=` | Unified diff, whole tree or one path (2 MiB cap). |
| `POST` | `/api/git/stage` | `{"root":"…","paths":[…]}` |
| `POST` | `/api/git/unstage` | `{"root":"…","paths":[…]}` |
| `POST` | `/api/git/discard` | `{"root":"…","paths":[…]}` — tracked files only; see below. |
| `POST` | `/api/git/commit` | `{"root":"…","message":"…"}`, commits what is staged. |

`root` is optional everywhere it appears and means the first `--root` when
absent, so a client that has never heard of roots keeps working unchanged.
Naming one that does not exist is refused before any path handling, with the
list of names that do.

### Reviewing, not operating

The git routes exist to answer "what did the agent just change, and do I want
to keep it." There is no push, no branching, and no conflict resolution,
because none of those are things anyone wants to attempt on a touchscreen.

Two refusals worth knowing about, both deliberate:

- **`discard` will not delete untracked files.** Restoring a tracked file loses
  work git can still find; deleting an untracked one loses it completely, with
  no reflog and no object to recover from. A destructive action with no floor
  under it does not belong behind a tap on a phone.
- **A root *inside* a larger repository is refused**, and `/api/git/status`
  reports why rather than erroring. Git reports and acts on paths relative to
  the repository top level, so serving that arrangement would reach outside the
  root — the exact boundary the file API spends its effort maintaining.

### WebSocket protocol

Binary frames carry raw PTY bytes in both directions — no framing overhead, and
xterm.js writes them straight through. Text frames carry JSON:

```jsonc
// client -> server
{"type":"resize","cols":120,"rows":40}
{"type":"ping"}

// server -> client
{"type":"ready","session":"main","root":"nocturn","cols":120,"rows":40,"replayed":8412,"alive":true}
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

## Tokens, one per device

Every device gets its own named token. That is what makes the revocation story
real rather than theoretical: with a single shared secret, rotating after losing
a phone logs out the tablet, the laptop, and anything automated, and every one
of them has to be re-paired by hand. A response that costs an evening gets
deferred — which is exactly the failure the design was supposed to prevent.

```bash
nocturn-agent --pair --pair-name pixel-9   # mint one and print its code
```

Revoking takes effect immediately and does not need a restart, so it no longer
costs you your running shells. It also closes any socket already authenticated
with that token, rather than waiting for the thief to reconnect and be refused.

Tokens are stored as salted SHA-256 in `tokens.json`, beside the old token file.
Not a password KDF: a KDF's cost exists to make guessing a low-entropy
human-chosen secret expensive, and these are 256 bits from the system RNG. What
hashing buys is that a readable config file no longer hands over every device's
credential.

`--token` and `NOCTURN_TOKEN` still work, and now mean something specific: a
**bootstrap** credential that is always accepted, never written to disk, and
cannot be revoked through the API. It is how you get back in after revoking
everything else, and it is what the installer sets.

Upgrading is safe. An existing `agent.token` is adopted into the store on first
start under the name "first device", so the token you already have keeps
working — hashed from then on.

## Security posture

- The phone holds a revocable token, never an SSH key or shell credential.
- Tokens compare in constant time, and every stored token is checked even after
  a match, so the time taken does not reveal which device is calling.
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
cd agent && cargo test                  # confinement, tokens, prompts, diffs — 38
node agent/tests/e2e.mjs                # daemon over the wire — 37
node agent/tests/revoke.mjs             # revocation ends a live session — 8
cd web && npm run test:browser          # the client in headless Chrome — 25
./deploy/tests/verify-install.sh        # installer in a container — 24
```

The wire-level suites need a daemon running with a known token; see
[agent/tests/README.md](agent/tests/README.md), which also covers running the
Linux build in a container so the PTY path that will actually be deployed gets
exercised, not just the Windows one.

The check that matters most is session persistence: start a counter, detach,
wait, reattach, and confirm the ticks emitted while nothing was listening are
present in the replay. If that ever regresses, the product no longer does the
one thing it exists to do.
