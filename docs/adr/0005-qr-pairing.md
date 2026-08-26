# 0005. QR code pairing

Status: Proposed

## Context

First run asks for a daemon address and a 64-character hex token. On a phone
that means either typing 64 hex characters by hand, or getting the token onto
the phone some other way — which in practice means pasting it into a chat app
and sending it to yourself. That is both miserable and the single worst thing
you can do with a credential equivalent to shell access.

The observed failure is already documented in this repository's own history:
the setup instructions shipped a placeholder path, and the first thing that
happened on a real machine was an error. First-run friction is where tools
lose people, and this one currently has the highest-friction first run
imaginable while also encouraging the least safe possible handling of the
secret.

The daemon already prints its address and token to the terminal on startup.
Everything needed is in one place at one moment; it is simply rendered in the
least convenient possible form for the device that needs it.

## Decision

Print a QR code alongside the startup banner, encoding a pairing URL:

```
https://vm.tailnet.ts.net/#pair=<token>
```

Scanning with the phone camera opens the client with the origin and token
already filled in. The fragment is used deliberately: fragments are not sent
to servers and do not appear in access logs or `Referer` headers, which is the
same reasoning that keeps the token out of the query string in the WebSocket
handshake.

The client reads the fragment on load, saves the connection, and immediately
clears the fragment with `history.replaceState` so the token does not sit in
the address bar or get captured by a screenshot of the browser chrome.

Rendered as Unicode half-blocks so it works in any terminal without images.
Suppressed when stdout is not a TTY, so it never lands in `journalctl`. Also
exposed as `nocturn-agent --pair`, which prints the code for an
already-running daemon without restarting it — the common case once the thing
is deployed and you are adding a second device.

## Consequences

Turns the worst moment in the product into a two-second one, for roughly an
afternoon of work and one small dependency.

A QR code on screen is a credential on screen. It is no more exposed than the
token already printed directly above it, but it is *scannable from across a
room*, which the hex string effectively is not. `--pair` printing on demand is
better than leaving one in scrollback for the rest of the session.

The fragment approach depends on the client being served by the daemon, which
is the normal deployment. A separately hosted client still needs the address
entered by hand; the setup form stays for that case.

This pairs naturally with [0008](0008-per-device-tokens.md): once tokens are
per-device, pairing should mint a fresh one for the device being paired rather
than handing over the shared secret, and the QR flow becomes the natural place
to name the device.
