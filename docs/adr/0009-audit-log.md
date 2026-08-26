# 0009. Append-only audit log

Status: Proposed

## Context

Nothing is recorded. Sessions come and go, commands run, files are written,
and afterwards there is no way to establish what happened — only the scrollback
of sessions that still exist, capped at 256 KiB and gone on restart.

For one person on their own box that is survivable. It stops being survivable
the moment the thing being operated is not solely yours, and the top-level
README already identifies why: deploying from a phone is the headline feature
and the biggest liability in the same gesture, and an audit trail is named
there as the thing that makes this sellable to anyone managing infrastructure
on behalf of other people.

That is the right read. "Who ran this and when" is not a feature you add
because a customer asked; it is a precondition for a category of customer
existing at all. It is also the cheapest thing on this list to build and the
most expensive to retrofit credibly, because a log that starts on the day you
needed it answers nothing about the week before.

## Decision

Append-only JSONL at `~/.config/nocturn/audit.jsonl`, one event per line.

```jsonc
{"ts":1740000000,"token":"k1","device":"pixel-9","ip":"100.x.x.x",
 "event":"session.create","session":"main","root":"nocturn"}
{"ts":1740000004,"token":"k1","device":"pixel-9","event":"fs.write",
 "path":"src/main.rs","bytes":4211}
{"ts":1740000010,"token":"k1","device":"pixel-9","event":"git.commit",
 "sha":"a1b2c3d","message":"Fix the thing"}
```

Recorded: session create/attach/detach/delete, file writes, git mutations,
token mint and revoke, and auth failures.

**Not recorded: keystrokes or terminal output.** This is the decision that
needs stating explicitly, because "audit the terminal" sounds obviously
correct and is not. A PTY stream carries whatever was typed into it —
passwords typed at a `sudo` prompt, API keys pasted into a config, the
contents of any file that was `cat`ed. Persisting that to disk creates a
higher-value target than the token itself, and it does so silently. What gets
logged is that a session existed and what it did through the API, not what
went across the wire.

Rotation at 16 MiB, keeping four generations. Written with `O_APPEND`, one
`write` per line, so concurrent writers interleave cleanly and a torn line is
recoverable by skipping it.

Read back through `GET /api/audit?since=&event=&limit=`, so the client can
show recent activity — and so a second device can answer "what did the phone
do while I was out."

## Consequences

Answers "what happened" for the first time, and does it in a format that
`jq`, `grep`, and any log shipper already understand.

Attribution is only as good as [0008](0008-per-device-tokens.md) makes it.
Before per-device tokens every entry attributes to "the token", which is still
better than nothing but not much. These two records are worth building close
together.

Append-only is a property of how it is written, not a guarantee — anyone with
shell access on the host can rewrite the file, and a Nocturn token *is* shell
access. Real tamper-evidence needs the log shipped somewhere the host cannot
reach, which is a deployment concern rather than a daemon feature. Documenting
the limit honestly is better than implying a property that does not hold.

Disk cost is bounded by rotation. An audit log is one more thing that must not
break the request path when the disk is full: a failed write is logged to
stderr and the request continues, because refusing to serve because logging
failed is a worse outcome than a gap in the log.
