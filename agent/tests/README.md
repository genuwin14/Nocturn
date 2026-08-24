# End-to-end tests

`cargo test` covers path confinement and token comparison in isolation. This
suite exercises the running daemon over the wire, including the property the
product depends on: **a session keeps running, and keeps buffering output, with
no client attached**.

Requires Node 22+ (for the built-in `WebSocket` global). No npm install.

```bash
# terminal 1 — a throwaway root, a known token
mkdir -p /tmp/nocturn-test && echo "hello from nocturn" > /tmp/nocturn-test/readme.txt
mkdir -p /tmp/nocturn-test/src
cargo run -- --root /tmp/nocturn-test --token test-token-abc123 --bind 127.0.0.1:7071

# terminal 2
node tests/e2e.mjs
```

The suite asserts:

- `/health` answers without a token; `/api/*` returns 401 with none and 403 with
  a wrong one.
- A shell reaches its prompt (the harness answers the startup `ESC [ 6 n` query
  the way xterm.js does).
- Ticks emitted while **zero clients are attached** are present in the scrollback
  replay on reattach — the core persistence guarantee.
- File list, read, and write round-trip.
- Path traversal and absolute paths are refused.
- Session delete kills the shell and removes it from the listing.

The paths and PowerShell snippet in `e2e.mjs` assume a Windows host; on Linux,
swap the tick loop for `for i in $(seq 1 10); do echo TICK$i; sleep 0.7; done`
and point `--root` at a POSIX path.
