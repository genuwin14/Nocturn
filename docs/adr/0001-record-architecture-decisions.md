# 0001. Record architecture decisions

Status: Accepted

## Context

The codebase carries a lot of non-obvious reasoning, and most of it currently
lives in prose comments and README sections. That has worked while the design
was being settled by one person in one pass. It stops working once features
land incrementally: the comment explains what the code does, but not which
alternatives were rejected or what would have to change for the decision to be
revisited.

Two specific failures are already visible. The terminal is deliberately not
confined, which reads as an oversight unless you find the paragraph explaining
why sandboxing a shell whose job is running arbitrary commands is theatre. And
the broker was deferred rather than rejected — a distinction that matters
enormously to anyone picking the work up, and which nothing in the code
records.

## Decision

Keep numbered ADRs under `docs/adr/`, one decision per file, in the format
described in the [index](README.md).

Records are immutable once accepted. A decision that turns out to be wrong
gets a new record that supersedes it, rather than an edit that quietly erases
why the original looked right at the time.

Decisions already implemented stay documented where they are, in the READMEs
next to the code they explain. Copying them here would create two sources of
truth that drift apart. ADRs cover work that is proposed but not yet built —
so a record is the thing you read before starting a feature, and the READMEs
are what you read to understand what already exists.

## Consequences

Proposing a feature now costs a short document before any code. That is the
point: the argument gets made once, in writing, where it can be disagreed with
cheaply.

The split between "implemented decisions live in READMEs, proposed ones live in
ADRs" needs maintaining. When an ADR is implemented, its substance moves into
the relevant README and the record stays as history — it does not get deleted.

Numbering is chronological, not priority-ordered. Priority lives in the index
table and is expected to change; the numbers are not.
