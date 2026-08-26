# 0010. Scrollback persistence

Status: Proposed

## Context

Scrollback is a 256 KiB in-memory ring per session, defined in
[session.rs](../../agent/src/session.rs). Two consequences follow.

It is small. A verbose build or a long Claude run produces that much output in
minutes, and once it wraps, the beginning is gone. The moment you most want to
scroll back — something failed an hour ago and you want to see what — is
exactly the moment the buffer has already discarded it.

It is also entirely in memory, so it dies with the daemon. Sessions do not
survive a restart today either, which makes this look moot, but the two are
separable: with [0012](0012-sessions-survive-restart.md) the shells outlive
the daemon while their history still would not, which is a strange thing to
explain to someone reattaching.

There is a third, quieter cost. Because there is no durable history, there is
nothing to search. "Which session printed that error" cannot be answered.

The ring itself is well built — a single mutex covers append-and-broadcast, so
an attaching client cannot race the reader thread and sees every byte exactly
once. That property is worth preserving exactly as it is; the storage under it
is what changes.

## Decision

Spill scrollback to a per-session file, keeping the ring as a hot cache.

- Output appends to `~/.local/share/nocturn/sessions/<id>.log` as well as the
  ring. The ring stays the replay path for a normal reattach, so the common
  case does no disk I/O.
- `GET /api/sessions/{id}/history?offset=&limit=` serves older output for
  clients that scroll past the ring.
- Files are capped at 64 MiB with head-truncation, and deleted when a session
  is deleted.
- `GET /api/sessions/{id}/search?q=` greps the file and returns byte offsets
  with surrounding context.

The write is buffered and flushed on an interval rather than per chunk. A
chatty process should not turn one `read` into one `write`, and losing the
last few hundred milliseconds of scrollback on a crash costs nothing that
matters.

Writes happen outside the fanout lock. The critical section stays exactly as
it is — append to ring, broadcast — because that is what makes the no-gap,
no-duplicate guarantee hold, and a disk write is precisely the kind of thing
that must not be inside it.

## Consequences

Scrollback stops being ephemeral, and history becomes searchable, which is
worth more than the extra depth on its own.

The same warning as [0009](0009-audit-log.md) applies with more force: a
session log is a verbatim record of everything the terminal displayed,
including anything typed at a password prompt and any secret printed by a
command. This is a genuinely sensitive file. It gets the same permissions as
the token file, and the cap and deletion-on-session-delete are how it is kept
from accumulating indefinitely. It should be documented plainly, and worth
offering a flag to disable persistence for anyone who would rather not have
it on disk at all.

Disk usage becomes proportional to session count and chattiness, bounded by
the cap. Ten long-lived noisy sessions is 640 MiB worst case, which is fine on
a VM and worth stating.

Search is a linear scan. At 64 MiB that is fast enough not to need an index,
and adding one would be premature.
