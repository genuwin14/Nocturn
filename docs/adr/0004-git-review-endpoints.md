# 0004. Git review endpoints and diff view

Status: Accepted

## Context

The file API can list, read, and write. Reviewing what an agent changed is a
different question from reading a file, and the current client answers it
badly: you would have to already know which files changed, open each one, and
compare against a version you cannot see.

This matters more than it sounds. The realistic session is "Claude, refactor
the session layer" followed by fourteen modified files. On a laptop you read
that as a diff in seconds. On a phone, with the tools currently shipped, you
cannot meaningfully read it at all — so the honest options are to trust the
run blindly or to defer review until you are back at a desk. Both defeat the
purpose of having started it from your phone.

The web README already names this as the obvious next feature and argues it is
worth more on a phone than the editor is. That is right, and it is worth
stating why: the editor competes with VS Code, which will always win. A diff
review flow competes with nothing, because nobody else is trying to make
agent output reviewable from a phone.

There is a scope question. Nocturn is not trying to be a git client — nobody
wants to resolve a rebase conflict on a phone. The valuable slice is narrow:
see what changed, and decide whether to keep it.

## Decision

Add read-mostly git endpoints scoped to the project root, and a diff view in
the client.

```
GET  /api/git/status            -> branch, ahead/behind, staged/unstaged/untracked
GET  /api/git/diff?path=&staged= -> unified diff, optionally for one path
POST /api/git/stage             -> {"paths":[...]} or {"hunk": ...}
POST /api/git/unstage           -> {"paths":[...]}
POST /api/git/commit            -> {"message":"..."}, returns the new sha
POST /api/git/discard           -> {"paths":[...]}  — requires confirmation
```

Shelling out to `git` rather than linking a library. The binary is present on
any host doing development, its output is stable, and vendoring libgit2 to
avoid a subprocess we already spawn shells for is not a trade worth making.

Every path goes through the same `resolve` used by the file API, so the
confinement guarantee and its tests extend to git operations unchanged.

The client gets a third tab: **Review**. Changed files as a list with
add/remove counts, tapping one opens a syntax-highlighted split or unified
diff (unified by default — a phone is too narrow for side-by-side), per-hunk
stage and discard, and a commit box.

Push is deliberately excluded from this record. It needs credentials the
daemon does not currently hold and touches a remote, which makes it a
different risk conversation. Committing locally and pushing from the terminal
tab is a fine seam for now.

## Consequences

This is the differentiator. Remote agent access is commodity; making the agent's
work reviewable from a phone is not, and it is the feature that turns Nocturn
from "a terminal I can reach" into a workflow.

`discard` destroys uncommitted work and is the one endpoint here that can lose
something irreplaceable. It requires an explicit confirmation gesture in the
UI — not a toast with an undo, which is exactly the pattern that fails when
the phone goes into a tunnel mid-animation.

Repositories with very large diffs need a cap, the way `/api/fs/read` caps at
2 MiB. A 50 MB generated-file diff should report its size and refuse to
render rather than locking up a phone browser.

The root may not be a git repository at all, and may contain several. Status
should report that plainly and the tab should hide itself rather than showing
errors — which becomes more visible once [0007](0007-multi-root-projects.md)
allows several roots.
