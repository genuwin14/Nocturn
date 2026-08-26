# 0012. Sessions surviving daemon restart

Status: Proposed

## Context

Sessions survive client disconnects. That is the guarantee the product is
built on, and it holds. They do not survive the daemon restarting, because the
PTYs are children of the daemon process, so upgrading the binary or restarting
the unit kills every running shell.

The deploy README is honest about this and suggests running the shell as
`tmux new -A -s claude`, which works: each session attaches to a tmux session
that persists independently, so the daemon becomes a viewer of something that
outlives it.

The problem is that this is opt-in, undocumented at the point of use, and
discovered after the loss. The failure mode is specific and bad: you upgrade
the daemon while a long agent run is going, and it dies. The person doing that
upgrade is the same person who most wanted the run to finish, and nothing
warned them.

One wrinkle worth naming. The daemon's own scrollback and tmux's scrollback
are different buffers. Reattaching through a restarted daemon replays what
tmux redraws, not what the previous daemon held, so history looks different
across a restart even when the shell survives.

## Decision

Detect tmux on Unix hosts and use it by default, with an explicit opt-out.

- On startup, if tmux is on PATH and no `--shell` was given, sessions spawn as
  `tmux new-session -A -s nocturn-<id>` running the configured shell.
- `--no-multiplexer` opts out and spawns the shell directly.
- `SessionInfo` reports whether a session is multiplexed, and the client shows
  it, so the durability guarantee is visible rather than assumed.
- On restart, the daemon lists tmux sessions matching its prefix and adopts
  them instead of creating new ones.
- Windows is unchanged. There is no equivalent worth emulating, so the
  behaviour is the current one and the client reports sessions as
  non-durable.

The prefix matters: adopting only `nocturn-` sessions means the daemon never
attaches to a tmux session a person started for their own reasons.

## Consequences

The most destructive routine operation, restarting the daemon, stops
destroying work on the platform that matters, since deployment targets are
Linux VMs.

It introduces a dependency the daemon does not otherwise have, which is why it
is detected rather than required. A host without tmux behaves exactly as it
does today.

Nested multiplexers are the obvious sharp edge. Someone whose shell profile
starts tmux, running inside a tmux that Nocturn started, gets confusing key
handling. Setting the session name explicitly and documenting the interaction
is most of the fix; the opt-out flag is the rest.

Adoption on restart needs care about geometry. A tmux session adopted by a new
daemon has whatever size it had, and the attaching client's dimensions should
win, the same way they do for a normal attach today.

Scrollback across a restart comes from tmux rather than the daemon's ring, so
it will not match byte for byte. [0010](0010-scrollback-persistence.md) makes
this coherent by giving the daemon durable history of its own. Before that,
the discontinuity should be stated in the UI rather than silently tolerated.
