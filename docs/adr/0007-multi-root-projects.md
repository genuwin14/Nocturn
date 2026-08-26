# 0007. Multiple project roots

Status: Proposed

## Context

`--root` is a single path, fixed at startup. Changing it means stopping the
daemon and starting it again, which kills every running session — the exact
thing the product exists to avoid.

The consequence shows up immediately in real use. A daemon rooted at one
repository cannot browse another, so the choices are to run several daemons on
different ports, or to root at something broad like `C:\` or `/home` and
accept that the file API now serves the entire user profile to anyone holding
the token.

That second option is the one people will pick, because it is one flag rather
than three processes, and it is the wrong one. Root is the blast radius of the
token: a root of `/home` puts SSH keys, browser profiles, and saved
credentials behind a single revocable string. The narrow root is the safe
choice and the current design makes it the inconvenient one.

Worth being precise about what this does and does not affect. The *terminal*
is not confined — `cd` anywhere works today and should keep working, since
confining a shell whose purpose is running arbitrary commands would be
theatre. This record is about the file API and the shell's starting directory,
which is where root actually binds.

## Decision

Accept `--root` more than once, and let sessions choose among the roots.

```
nocturn-agent --root ~/code/nocturn --root ~/code/api --root ~/notes
```

The first is the default. Each gets a short name from its directory, with a
`name=path` form for disambiguating two directories with the same basename.

- `GET /api/roots` lists them: name, path, whether it is a git repository.
- File API calls take an optional `root=` parameter, defaulting to the first.
- Session creation takes a root, which sets the shell's starting directory;
  `SessionInfo` reports which root a session belongs to.
- The client gets a root picker in the header, and the Files tab scopes to the
  selected one.

Resolution and confinement are unchanged in kind: the same canonicalize-then-
verify logic runs, against whichever root was named. A request naming an
unknown root is rejected before any path handling happens.

Roots stay fixed at startup. Adding them at runtime means an API that can
expand the daemon's own reach, which is a meaningfully worse thing to hold a
token for.

## Consequences

Makes the narrow root the convenient choice, which is the entire point. Three
named roots and no reason to reach for `/home`.

One daemon, one port, one token, several projects — and sessions in different
projects survive independently, which several daemons on several ports never
gave you anyway.

`resolve` becomes root-parameterised, so the existing confinement tests should
be extended to cover cross-root escapes: a path under root A must not resolve
into root B by traversal, and the roots may legitimately be nested, which is
the case most likely to be got wrong.

The single-root form keeps working exactly as it does now, so nothing about
existing deployments changes.

This is a prerequisite for [0004](0004-git-review-endpoints.md) being pleasant
with more than one repository, since git status is per-root.
