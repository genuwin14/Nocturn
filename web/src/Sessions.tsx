import { useCallback, useEffect, useState } from 'react';
import { deleteSession, listSessions, type Connection, type SessionInfo } from './api';

interface Props {
  connection: Connection;
  current: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onDisconnect: () => void;
}

// Only two of the three are worth spending a row's width on. "Working" is the
// unremarkable state, and a session that needs an answer should stand out from
// the ones that do not.
const ACTIVITY_NOTE: Record<string, string> = {
  waiting: 'needs an answer',
  idle: 'idle',
};

function age(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function Sessions({ connection, current, onSelect, onClose, onDisconnect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await listSessions(connection));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const id = newName.trim();
    if (!id) return;
    // Sessions are created lazily by attaching, so there is nothing to POST.
    onSelect(id);
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Kill session "${id}" and discard its scrollback?`)) return;
    await deleteSession(connection, id);
    await refresh();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>Sessions</h2>
          <button type="button" className="link" onClick={onClose}>
            Done
          </button>
        </header>

        {error && <div className="banner error">{error}</div>}

        <ul className="session-list">
          {sessions.map((item) => (
            <li key={item.id} className={item.id === current ? 'current' : ''}>
              <button type="button" className="session-row" onClick={() => onSelect(item.id)}>
                <span className={`status-dot ${item.alive ? item.state : 'error'}`} />
                <span className="session-row-name">{item.id}</span>
                <span className={`session-row-meta ${item.alive ? item.state : ''}`}>
                  {item.alive
                    ? [age(item.created_at), ACTIVITY_NOTE[item.state]]
                        .filter(Boolean)
                        .join(' · ')
                    : `exited ${item.exit_code}`}
                </span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Kill ${item.id}`}
                onClick={() => remove(item.id)}
              >
                ✕
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="empty">No sessions yet.</li>}
        </ul>

        <form className="new-session" onSubmit={create}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New session name"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="primary" disabled={!newName.trim()}>
            Open
          </button>
        </form>

        <footer className="sheet-footer">
          <button type="button" className="danger-link" onClick={onDisconnect}>
            Forget this daemon
          </button>
        </footer>
      </div>
    </div>
  );
}
