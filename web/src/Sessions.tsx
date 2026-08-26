import { useCallback, useEffect, useState } from 'react';
import {
  deleteSession,
  listSessions,
  type Connection,
  type Root,
  type SessionInfo,
} from './api';

interface Props {
  connection: Connection;
  roots: Root[];
  /** The project currently selected, app-wide. */
  root?: string;
  current: string;
  /**
   * Switching project. The second argument is the session to land on, chosen
   * here because this is where the list lives: the newest live shell in that
   * root, or `main` if it has none yet.
   */
  onSelectRoot: (name: string, session: string) => void;
  onSelect: (id: string, root?: string) => void;
  onClose: () => void;
  onDisconnect: () => void;
  onManageDevices: () => void;
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

export function Sessions({
  connection,
  roots,
  root,
  current,
  onSelectRoot,
  onSelect,
  onClose,
  onDisconnect,
  onManageDevices,
}: Props) {
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
    // The list goes stale while it is open, and visibly so: activity changes, a
    // shell exits, and switching project starts one that was not there a moment
    // ago — which otherwise reads as "No sessions yet" over a shell that is
    // already running. Cheap to re-read, and the sheet is open for seconds.
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const id = newName.trim();
    if (!id) return;
    // Sessions are created lazily by attaching, so there is nothing to POST.
    onSelect(id, root);
  };

  const remove = async (session: SessionInfo) => {
    if (!window.confirm(`Kill session "${session.id}" and discard its scrollback?`)) return;
    await deleteSession(connection, session.id, session.root);
    await refresh();
  };

  // Sessions are listed for every root, but shown for one. Seeing "main" three
  // times with nothing to tell the three apart would be worse than filtering,
  // and the root selector directly above says which one is showing.
  const shown = root ? sessions.filter((s) => s.root === root) : sessions;
  const active = roots.find((r) => r.name === root);

  // Switching project should land on something already running there rather
  // than spawning a shell nobody asked for. `main` only when there is nothing.
  const landingSession = (name: string): string => {
    const live = sessions
      .filter((s) => s.root === name && s.alive)
      .sort((a, b) => b.created_at - a.created_at);
    return live[0]?.id ?? 'main';
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

        {/*
          Only when there is a choice to make. One root is the common case and
          a picker with a single option is noise.
        */}
        {roots.length > 1 && (
          <>
            <nav className="root-picker" aria-label="Project">
              {roots.map((item) => {
                // A count on the chip, so switching to a project is an informed
                // move rather than a guess at whether anything is running there.
                const running = sessions.filter(
                  (s) => s.root === item.name && s.alive,
                ).length;
                return (
                  <button
                    key={item.name}
                    type="button"
                    className={`root-chip ${item.name === root ? 'current' : ''}`}
                    aria-pressed={item.name === root}
                    onClick={() => onSelectRoot(item.name, landingSession(item.name))}
                  >
                    {item.name}
                    {running > 0 && <span className="root-chip-count">{running}</span>}
                  </button>
                );
              })}
            </nav>
            {active && (
              <p className="root-path" title={active.path}>
                {active.path}
                {!active.repo && <span className="root-note"> · not a repository</span>}
              </p>
            )}
          </>
        )}

        <ul className="session-list">
          {shown.map((item) => (
            <li
              key={`${item.root}/${item.id}`}
              className={item.id === current && item.root === root ? 'current' : ''}
            >
              <button
                type="button"
                className="session-row"
                onClick={() => onSelect(item.id, item.root)}
              >
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
                onClick={() => remove(item)}
              >
                ✕
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="empty">No sessions yet.</li>}
        </ul>

        <form className="new-session" onSubmit={create}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={root ? `New session in ${root}` : 'New session name'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="primary" disabled={!newName.trim()}>
            Open
          </button>
        </form>

        <footer className="sheet-footer">
          <button type="button" className="link" onClick={onManageDevices}>
            Devices
          </button>
          <button type="button" className="danger-link" onClick={onDisconnect}>
            Forget this daemon
          </button>
        </footer>
      </div>
    </div>
  );
}
