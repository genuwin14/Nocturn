# 0002. Session activity signal

Status: Proposed

## Context

A session keeps running with no client attached, and every byte it produced
while you were gone is replayed when you come back. That is the guarantee the
product is built on, and it works.

What the daemon never does is *say* anything happened. The protocol in
[protocol.rs](../../agent/src/protocol.rs) carries `ready`, `exit`, `pong` and
`error` — all of them either responses to a client action or terminal states.
There is no message meaning "the thing you started has finished."

So the actual workflow for a long Claude run is: open the app, read the
screen, guess whether it is still working, close the app, repeat. That is
polling, done by hand, and it is a strange thing to ask of someone whose
laptop is closed specifically so they do not have to think about it.

The client cannot infer this on its own. It receives raw PTY bytes; deciding
"this is a shell prompt, not output" from a byte stream in the browser means
shipping shell-specific heuristics to every client and getting them wrong on
someone's custom prompt. The daemon already owns the byte stream, knows the
configured shell, and is the only place the logic should exist once.

Note also that `SessionInfo` reports `alive` and `exit_code`, so a client can
tell a *dead* session from a live one — but every live session looks
identical whether it is compiling for ten minutes or sitting at a prompt.

## Decision

Track per-session activity state in `Session` and broadcast transitions as
control messages on the existing socket.

Three states, derived from the output stream:

- `working` — bytes produced within the idle threshold.
- `idle` — no bytes for `IDLE_AFTER` (default 3s) **and** the tail of the
  scrollback matches a prompt heuristic.
- `waiting` — no bytes for the threshold, but the tail does not look like a
  prompt. This is the interesting case: something is blocked on input, such as
  a Claude permission request or a `[y/N]`.

Two new server messages:

```jsonc
{"type":"state","state":"idle","since":1740000000,"tail":"user@host:~/app$ "}
{"type":"state","state":"waiting","since":1740000000,"tail":"Allow edit? [y/n] "}
```

`state` is also added to `SessionInfo` so `/api/sessions` reports it without
attaching, and included in the `ready` payload so a reattaching client knows
immediately whether it is mid-run.

The prompt heuristic is deliberately crude: the last non-empty line ends with
one of `$ `, `# `, `> `, `% ` after trailing ANSI sequences are stripped.
Cheap, wrong sometimes, and — critically — only ever affects *labelling*.
A misread prompt shows the wrong badge; it never drops output or kills a
shell. Anything more ambitious (OSC 133 shell integration, which marks prompt
boundaries properly) is a later refinement, and the message shape above does
not need to change to adopt it.

Transitions are debounced. A build that pauses for four seconds mid-run should
not emit `idle` then `working` a moment later, so a state must hold for
`IDLE_AFTER` before it is broadcast.

## Consequences

This is the foundation for [0003](0003-push-notifications.md); a notification
needs something to notify *about*, and this is it. It also feeds the session
badge in the UI, so the header dot can finally distinguish "socket connected"
from "the shell is busy" — today it only reports the former.

`waiting` is the state that turns out to matter most in practice. A Claude run
blocked on a permission prompt is indistinguishable from one still thinking,
and that is exactly the moment a person needs to be told, because nothing
progresses until they answer.

The heuristic will misfire on unusual prompts. That is acceptable for a badge
and a notification; it would not be acceptable if anything destructive were
gated on it, so nothing should be.

Cost is a timer per session and a comparison against the scrollback tail on
each output chunk. Both are trivial next to the PTY read that already happens.
