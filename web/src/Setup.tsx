import { useState } from 'react';
import { checkHealth, listSessions, type Connection } from './api';

interface Props {
  onConnect: (connection: Connection) => void;
}

export function Setup({ onConnect }: Props) {
  // Served by the daemon itself in the normal case, so the origin is already
  // known and only a token is missing.
  const [origin, setOrigin] = useState(window.location.origin);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const normalised = origin.trim().replace(/\/+$/, '');
    const connection = { origin: normalised, token: token.trim() };

    try {
      // Two probes, because the failures are different problems with different
      // fixes: an unreachable host is a tunnel or address issue, a rejected
      // token is a credential issue. Saying which one saves a lot of guessing.
      if (!(await checkHealth(normalised))) {
        setError(
          'No daemon answered at that address. Check that it is running and that your tunnel is up.',
        );
        return;
      }
      await listSessions(connection);
      onConnect(connection);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <form className="setup-card" onSubmit={submit}>
        <h1>Nocturn</h1>
        <p className="setup-lede">Connect to your agent daemon.</p>

        <label htmlFor="origin">Daemon address</label>
        <input
          id="origin"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder="https://vm.tailnet.ts.net"
          required
        />

        <label htmlFor="token">Access token</label>
        <input
          id="token"
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="64 hex characters"
          required
        />
        <p className="hint">
          Printed on first run, and stored on the host at
          <code>/etc/nocturn/agent.env</code>.
        </p>

        {error && <div className="banner error">{error}</div>}

        <button type="submit" className="primary block" disabled={busy}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
