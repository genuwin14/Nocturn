# 0008. Per-device tokens

Status: Proposed

## Context

There is one token. Every device uses it, comparison is constant-time, and
rotation means editing the env file and restarting.

The security argument the product makes is that a phone holds a revocable
token rather than an SSH key, so a lost phone is a rotation rather than a
compromise. That argument is sound and it is the strongest part of the design.
But with a single shared secret, rotation is all-or-nothing: losing a phone
logs out the tablet, the laptop, the desktop, and anything automated, and
every one of them has to be re-paired by hand.

The predictable result is that people do not rotate. A response that costs an
evening of re-pairing every device gets deferred, and deferring it is exactly
the failure the design was supposed to prevent. The revocation story is only
as good as the odds someone actually goes through with it.

There is also no way to answer "what is currently able to reach this daemon."
A single shared secret cannot distinguish devices, so it cannot report them.

Restarting is its own problem: it kills every session, so today rotating a
token also destroys running work.

## Decision

Replace the single token with a set of named tokens.

Stored as a small JSON file next to the current token file, at the same
permissions:

```jsonc
{"tokens": [
  {"id": "k1", "name": "pixel-9", "hash": "…", "created": 1740000000,
   "last_seen": 1740003600, "last_ip": "100.x.x.x"}
]}
```

Tokens are stored as salted hashes, not plaintext. The daemon compares against
each candidate in constant time — the set is small enough that the cost is
irrelevant, and it means a readable config file no longer hands over every
credential.

- `GET /api/tokens` lists them, without the hashes.
- `POST /api/tokens` mints one with a name, returning the secret exactly once.
- `DELETE /api/tokens/{id}` revokes immediately, closing any socket
  authenticated with it.

Revocation takes effect without a restart, so it no longer costs you your
running sessions. That is what makes rotation cheap enough to actually do.

The existing `NOCTURN_TOKEN` env var keeps working as a bootstrap credential —
the installer sets it, and it is how you mint the first real token. Existing
deployments continue unchanged.

The client gets a Devices screen: name, last seen, last address, and a revoke
button.

## Consequences

Makes the revocation story real rather than theoretical. Losing a phone
becomes one tap that affects one device, which is a response people will
actually carry out.

Pairs directly with [0005](0005-qr-pairing.md): pairing should mint a fresh
named token for the device being paired rather than copying the shared one,
which is both better hygiene and a natural moment to name the device.

Also gives [0003](0003-push-notifications.md) the device registry its
subscriptions should hang off, and gives [0009](0009-audit-log.md) something
meaningful to attribute entries to — "pixel-9 ran this" rather than "someone
with the token ran this."

`last_seen` and `last_ip` mean the daemon now writes on a read path. It should
be throttled to something like once a minute per token rather than on every
request.

The daemon now holds mutable state that must survive restarts and must not be
corrupted by a crash mid-write. Write-to-temp-and-rename is sufficient; this
is not a database and should not become one.
