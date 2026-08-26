# 0003. Push notifications for session events

Status: Proposed

## Context

[0002](0002-session-activity-signal.md) makes the daemon able to say "this
session went idle" or "this session is blocked on input." That is only useful
if the message can reach someone who is not looking at the app.

The whole premise is that you detach and go do something else. A signal that
only arrives over an open WebSocket requires the app to be in the foreground,
which is the state we are explicitly trying not to require. On iOS a
backgrounded webview loses its socket within seconds; on Android it is a
little more forgiving and still unreliable.

The client is already a PWA — there is a `manifest.webmanifest` and a favicon,
and it is served over HTTPS in the deployed configuration via `tailscale
serve`. iOS has supported the Web Push API for installed PWAs since 16.4.
So the delivery mechanism exists and needs no app store, no native shell, and
no third-party push service.

## Decision

Add Web Push, with the daemon acting as its own application server.

- `POST /api/push/subscribe` stores a browser `PushSubscription` alongside a
  device label. `DELETE /api/push/subscribe` removes it.
- `GET /api/push/key` returns the VAPID public key.
- VAPID keypair is generated on first use and persisted next to the token, at
  the same permissions.
- A service worker in the web client receives pushes and calls
  `showNotification`. Tapping one focuses the app and switches to the session
  that fired it.

What fires a notification, all defaulting on and individually toggleable:

| Event | Message |
|---|---|
| `waiting` | "`main` needs an answer — Allow edit? [y/n]" |
| `idle` after a run longer than 30s | "`main` finished after 4m12s" |
| `exit` with a non-zero code | "`main` exited with code 1" |

Short runs do not notify. Being buzzed because `ls` completed would train
people to ignore the notifications entirely, which costs more than sending
nothing.

Notifications are suppressed while a client is attached *and* the page is
visible — if you are watching the terminal you do not need to be told what it
just printed.

## Consequences

This is the feature that closes the loop the product opens. Everything else
here improves a tool you have to check on; this one makes it tell you.

It requires HTTPS with a real certificate. `tailscale serve` provides one, and
a Cloudflare Tunnel does too, so the documented deployment paths are fine —
but a bare `--bind` on plain HTTP cannot use this, including the loopback
development setup. Localhost is treated as a secure context by browsers, so
development works; a plain-HTTP LAN address does not, and the UI should say so
rather than failing silently.

Storing push subscriptions means the daemon now holds a small amount of
per-device state that must survive restarts. That pairs naturally with
[0008](0008-per-device-tokens.md), which introduces the device registry those
subscriptions should hang off. Building 0003 first is fine; the subscription
record just grows a `token_id` field later.

The dependency on a browser push service (Apple's, Google's) is worth naming:
notification *delivery* stops being self-contained, even though the payload
originates on your own host. Payloads are encrypted end to end, so the push
service learns that a message was sent, not what it said. For anyone who finds
that unacceptable, the in-app signal from 0002 still works with no push
involved.
