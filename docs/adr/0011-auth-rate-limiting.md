# 0011. Auth failure rate limiting

Status: Proposed

## Context

Token comparison in [auth.rs](../../agent/src/auth.rs) is constant-time, which
is correct and closes the timing side channel. What it does not do is limit how
many guesses an attacker gets. A wrong token returns 403 immediately, and
nothing stops the next attempt.

The generated token is 256 bits of hex, so brute force is not a real threat.
The threats that are real:

- A **short user-supplied token**. The `--token` flag and `NOCTURN_TOKEN`
  accept anything, and the deploy docs show setting them by hand. Somebody
  will use a weak one, and at unlimited request rate that falls in seconds.
- **Unbounded log growth**. Every failure logs a warning. An attacker who
  cannot get in can still fill the disk, which takes down the daemon and
  anything else on the host.
- **CPU burn**. Each attempt costs a comparison and a log write.

The deployment story mitigates this considerably: bound to loopback, reached
over a tailnet, no inbound port. But that is a deployment property rather than
a daemon property, and "it is fine because nobody can reach it" stops being
true the first time somebody runs it on a LAN address or puts a tunnel in
front of it.

## Decision

Track failures per source address and back off.

- A sliding window of failures per IP, held in memory.
- After 5 failures within 60 seconds, return 429 with `Retry-After` for that
  address, doubling to a 15-minute ceiling.
- Successful auth clears the counter for that address.
- Once an address is in backoff, failures are logged with a count rather than
  one line per attempt, which is what bounds log growth.
- Loopback is exempt, since a local process able to hammer the port can
  already read the token file.

Also: warn loudly at startup when the configured token is shorter than 32
characters, naming it as the reason rate limiting exists. A warning at the
moment of the mistake is worth more than a limiter quietly compensating for it.

The state is a small map with periodic eviction. Nothing persistent. A restart
clearing the counters is acceptable, and a daemon restart is not something an
attacker can trigger.

## Consequences

Makes a weak token survivable rather than fatal, and bounds the log and CPU
cost of a failing attacker.

Rate limiting by IP is the coarse tool it always is. Behind a tunnel or proxy
every request may share a source address, so one attacker could lock out a
legitimate user from the same apparent origin. Honouring `X-Forwarded-For`
would help and is only safe when the proxy is trusted, so it belongs behind an
opt-in flag: a spoofable header used for rate limiting is worse than no header
at all.

This does not make the daemon safe to expose publicly and should not be
described as though it does. The posture stays: bind to loopback, reach it
over an outbound tunnel. This is defence in depth for when that goes wrong,
not permission to skip it.
