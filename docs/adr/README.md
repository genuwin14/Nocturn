# Architecture decision records

One file per decision. Numbered, immutable once accepted: a decision that
turns out wrong gets a new ADR that supersedes the old one rather than an
edit that erases the reasoning.

Decisions already baked into the code — session ownership, no broker, no SSH,
the token-as-subprotocol trick, the deliberately unconfined terminal — are
documented in the top-level [README](../../README.md) and the component
READMEs. They are not duplicated here; a second copy would drift.

These records cover what is **not yet built**.

## Format

    # NNNN. Title
    Status: Proposed | Accepted | Superseded by NNNN
    ## Context      — the forces, and what is true today
    ## Decision     — what we will do
    ## Consequences — what this costs, and what it rules out

## The set

| # | Decision | Status | Priority |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | — |
| [0002](0002-session-activity-signal.md) | Session activity signal | Accepted | 1 |
| [0003](0003-push-notifications.md) | Push notifications for session events | Proposed | 2 |
| [0004](0004-git-review-endpoints.md) | Git review endpoints and diff view | Accepted | 3 |
| [0005](0005-qr-pairing.md) | QR code pairing | Accepted | 4 |
| [0006](0006-mobile-clipboard-paste.md) | Mobile clipboard paste | Accepted | 5 |
| [0007](0007-multi-root-projects.md) | Multiple project roots | Accepted | 6 |
| [0008](0008-per-device-tokens.md) | Per-device tokens | Accepted | 7 |
| [0009](0009-audit-log.md) | Append-only audit log | Proposed | 8 |
| [0010](0010-scrollback-persistence.md) | Scrollback persistence | Proposed | 9 |
| [0011](0011-auth-rate-limiting.md) | Auth failure rate limiting | Proposed | 10 |
| [0012](0012-sessions-survive-restart.md) | Sessions surviving daemon restart | Proposed | 11 |
| [0013](0013-file-search.md) | File search | Proposed | 12 |

## Why this order

The premise is that a laptop being asleep stops mattering. The shells already
survive detaching — that half is done and tested. What is missing is the
return path: the daemon never tells you anything happened, so checking on a
run means opening the app and reading the screen. 0002 and 0003 close that
loop, and nothing else on the list changes the product as much.

0004 is the differentiator. Remote access to an agent is not scarce; every
competitor has it. Reviewing what the agent *did*, from a phone, is scarce.
Starting a run you cannot review is only half a workflow.

0005 and 0006 are small and fix the two worst moments in the app: pasting a
64-character token, and being unable to paste anything else afterwards.

The rest is durability and hardening — each worth doing, none of it changing
what the product is.
