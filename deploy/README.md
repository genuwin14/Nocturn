# Deploying the agent

The daemon belongs on a host that is always on and holds your code. On the
athena cluster that means a small VM — 1 vCPU and 512 MB is enough for the
daemon itself; size it for whatever your builds need, not for Nocturn.

## The short version

```bash
# on your workstation (needs Docker)
./deploy/build-linux.sh
scp agent/nocturn-agent-linux deploy/install.sh deploy/nocturn-agent.service VM:/tmp/

# on the VM
cd /tmp && sudo ./install.sh --binary nocturn-agent-linux
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 7071
```

That is the whole deployment. No inbound port, no public IP, no reverse proxy,
no TLS certificate to manage.

If Docker is not available, install rustup on the VM and use
`sudo ./install.sh --from-source` instead. The cross-build exists so the VM
needs nothing but the binary; it is a convenience, not a requirement.

## Why Tailscale rather than a port-forward

The VM sits behind NAT with no public IP. The two ways out are a port-forward
on your router or an outbound tunnel, and the port-forward is the one that ends
badly: it puts a service on the public internet whose entire job is running
arbitrary commands, and it is the shape of exposure that gets self-hosted boxes
found by scanners within hours.

`tailscale serve` dials *out* and gives you a private HTTPS endpoint on your
tailnet — a real certificate, reachable from your phone anywhere, invisible to
everyone else. The daemon stays bound to `127.0.0.1`, so even if the tunnel
misbehaves there is nothing listening on a routable address.

A Cloudflare Tunnel gets you the same property if you would rather stay on
Cloudflare. Either is fine; the requirement is only that the connection is
outbound.

## What the installer does

- Creates an unprivileged `nocturn` system user. A Nocturn token is equivalent
  to shell access as whoever the daemon runs as, so it must not be root.
- Installs the binary to `/usr/local/bin/nocturn-agent`.
- Generates a 256-bit token into `/etc/nocturn/agent.env`, `chmod 640`, owned
  `root:nocturn`. Keeping it out of the unit file means it never appears in
  `systemctl cat` output.
- Creates `/srv/projects` as the project root.
- Installs and starts the systemd unit, then verifies it came up — and dumps the
  journal if it did not, rather than reporting a success that did not happen.

Re-running it upgrades the binary and leaves your token and projects alone.

## On systemd hardening

The unit deliberately does *not* set `ProtectHome`, `ReadOnlyPaths`,
`SystemCallFilter`, or `NoNewPrivileges=true`. Those directives sandbox a daemon
by restricting what it can do — and this daemon's entire purpose is to run
arbitrary commands you asked it to run. Locking it down would break the shells
while providing no real protection, because anyone holding the token can already
run anything the service user can.

The isolation boundary for Nocturn is the VM and the unprivileged account, not
systemd. If you want a stronger boundary, give the daemon its own VM or
container rather than trying to sandbox it in place.

`KillMode=control-group` *is* set, so `systemctl restart` cleans up the shells
it spawned instead of orphaning them.

## Getting your code onto the VM

The daemon serves whatever is under `--root`. Two sane options:

- **Clone there.** Treat the VM as a real dev box: `git clone` into
  `/srv/projects`, work there, push from there. This is the model Nocturn is
  built for, and it is what makes "my laptop is asleep" stop mattering.
- **Sync from your laptop.** `rsync`/Syncthing if you want the VM to mirror
  local work. Workable, but you now have two working copies and a merge problem
  the first time you edit from your phone.

Clone there. The second option quietly reintroduces the dependency on your
laptop being awake.

## Authenticating Claude Code on the VM

Claude Code needs to be installed and logged in *on the VM*, once:

```bash
sudo -u nocturn -i
curl -fsSL https://claude.ai/install.sh | bash
claude          # follow the browser auth flow
```

Do this over a normal SSH session the first time — the OAuth flow is easier in
a real terminal than in a phone client. After that, sessions started through
Nocturn inherit the credentials.

Note that the daemon strips `ANTHROPIC_API_KEY` from spawned shells by default.
That variable makes Claude Code bill at pay-as-you-go API rates and ignore a Pro
or Max subscription entirely. Pass `--allow-api-key` only if that is what you
want.

## Operating it

```bash
systemctl status nocturn-agent
journalctl -u nocturn-agent -f
sudo systemctl restart nocturn-agent     # kills running sessions
```

**Sessions do not survive a daemon restart.** They survive client disconnects,
which is the case that matters day to day, but the PTYs are children of the
daemon process. If you need shells that outlive upgrades, run the daemon with
`--shell "tmux new -A -s claude"` so each session attaches to a tmux session
that persists independently.

### Rotating the token

```bash
sudo sed -i "s/^NOCTURN_TOKEN=.*/NOCTURN_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')/" /etc/nocturn/agent.env
sudo systemctl restart nocturn-agent
sudo grep NOCTURN_TOKEN /etc/nocturn/agent.env
```

Do this the moment a phone goes missing. It is the entire reason the phone holds
a token instead of an SSH key.
