# 0013. File search

Status: Proposed

## Context

The Files tab navigates one directory at a time. Reaching a deeply nested file
is five taps, each a round trip to `/api/fs/list`, and each requiring you to
remember the layout. On a desktop this is mildly annoying. On a phone, where
tap targets are small and the connection may be an LTE handoff away from
stalling, it is the reason people give up and use the terminal instead.

There is also no content search. "Which file mentions this function" is
answerable in the terminal with grep and not answerable in the UI at all, so
the file browser is currently worse than the terminal at the task it exists to
make easier.

This is lower priority than the rest of the list, and it is worth being clear
about why: it makes an existing feature pleasant rather than enabling anything
new, and [0004](0004-git-review-endpoints.md) removes much of the need for it.
Most of the time you are not looking for an arbitrary file, you are looking at
the files the agent just changed, and a review tab hands you those directly.

## Decision

Two endpoints, and a single search field in the Files tab.

```
GET /api/fs/find?q=&root=&limit=   -> fuzzy path match
GET /api/fs/grep?q=&root=&limit=   -> content match with line numbers
```

Path search walks the tree and scores with a subsequence match, so a short
abbreviation finds a long path. Content search shells out to ripgrep when it
is available and falls back to a bounded internal walk when it is not.
Ripgrep respects `.gitignore` and is fast enough that reimplementing it would
be a waste.

Both skip `.git`, `node_modules`, and `target` by default, cap their results,
and report when they truncated rather than silently returning a prefix.

The path index is built lazily on first search and cached with a short TTL.
Rebuilding it on every keystroke would be pointless; holding it forever means
serving stale results after a branch switch.

In the client, one field that searches paths as you type and offers content
search on submit. A phone has room for one search affordance, not two.

## Consequences

Makes the file browser usable for finding things rather than only for opening
things you already located.

Walking a large tree costs real time on the first search. The cap, the TTL,
and the default exclusions are what keep that bounded. A monorepo will still
be the slow case and should be measured rather than assumed.

Ripgrep is optional, so behaviour differs by host: faster and gitignore-aware
where present. The fallback needs to be genuinely correct rather than a stub,
since it is what runs on a minimal VM.

Both endpoints go through the same root confinement as the rest of the file
API, and inherit multiple roots from [0007](0007-multi-root-projects.md) via
the `root` parameter.
