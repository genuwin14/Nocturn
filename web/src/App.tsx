import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { TerminalView, type Status, type TerminalHandle } from './Terminal';
import { KeyBar } from './KeyBar';
import { Setup } from './Setup';
import { Sessions } from './Sessions';
import {
  clearConnection,
  loadConnection,
  saveConnection,
  type Activity,
  type Connection,
} from './api';
import './styles.css';

// CodeMirror is roughly two thirds of the bundle and only the Files tab needs
// it. Splitting it out keeps the terminal — the thing you open the app for —
// fast to load over a phone connection.
const Files = lazy(() => import('./Files').then((m) => ({ default: m.Files })));

type Tab = 'terminal' | 'files';

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  error: 'Disconnected',
};

const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working',
  idle: 'Idle',
  waiting: 'Needs an answer',
};

export default function App() {
  const [connection, setConnection] = useState<Connection | null>(loadConnection);
  const [tab, setTab] = useState<Tab>('terminal');
  const [session, setSession] = useState('main');
  const [showSessions, setShowSessions] = useState(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [statusDetail, setStatusDetail] = useState<string>();
  const [activity, setActivity] = useState<Activity>('working');
  const [activityTail, setActivityTail] = useState('');
  const [ctrlArmed, setCtrlArmed] = useState(false);

  const terminalRef = useRef<TerminalHandle>(null);

  const onStatusChange = useCallback((next: Status, detail?: string) => {
    setStatus(next);
    setStatusDetail(detail);
  }, []);

  const onActivityChange = useCallback((next: Activity, tail: string) => {
    setActivity(next);
    setActivityTail(tail);
  }, []);

  const connect = (next: Connection) => {
    saveConnection(next);
    setConnection(next);
  };

  const disconnect = () => {
    clearConnection();
    setConnection(null);
  };

  // The on-screen keyboard shrinks the visual viewport without changing the
  // layout viewport, which would otherwise leave the key bar hidden behind it.
  // Publishing the real height as a custom property lets CSS lay out against
  // what is actually visible.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () => {
      document.documentElement.style.setProperty('--viewport-height', `${viewport.height}px`);
    };
    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
    };
  }, []);

  if (!connection) {
    return <Setup onConnect={connect} />;
  }

  const sendKeys = (data: string) => {
    terminalRef.current?.send(data);
    if (ctrlArmed) setCtrlArmed(false);
  };

  // The header reports the most useful unresolved thing, which is not always
  // the same thing. A broken connection is the problem worth showing; once the
  // socket is up, "Connected" says nothing you cannot see, and what the shell
  // is doing is the reason you opened the app.
  const connected = status === 'connected';
  const indicator = connected ? activity : status;
  const label = connected ? ACTIVITY_LABEL[activity] : STATUS_LABEL[status];
  const detail = connected
    ? activity === 'waiting' && activityTail
      ? activityTail
      : ''
    : (statusDetail ?? '');

  return (
    <div className="app">
      <header className="app-header">
        <button
          type="button"
          className="session-button"
          onClick={() => setShowSessions(true)}
        >
          <span className={`status-dot ${indicator}`} />
          <span className="session-name">{session}</span>
          <span className="chevron">▾</span>
        </button>

        {/*
          A live region, so a transition to "needs an answer" is announced
          rather than only shown — the whole point of the state is that it
          arrives while you are not watching.
        */}
        <span
          className={`status-text ${connected ? activity : ''}`}
          role="status"
          aria-live="polite"
        >
          {label}
          {detail ? ` · ${detail}` : ''}
        </span>
      </header>

      <main className="app-body">
        {/*
          The terminal is kept mounted while the Files tab is showing rather
          than unmounted and rebuilt. Unmounting would drop the socket, and
          reattaching re-replays the whole scrollback on every tab switch.
        */}
        <div className={`tab-panel ${tab === 'terminal' ? 'active' : ''}`}>
          <TerminalView
            ref={terminalRef}
            connection={connection}
            session={session}
            onStatusChange={onStatusChange}
            onActivityChange={onActivityChange}
            ctrlArmed={ctrlArmed}
            onCtrlConsumed={() => setCtrlArmed(false)}
          />
        </div>
        <div className={`tab-panel ${tab === 'files' ? 'active' : ''}`}>
          {tab === 'files' && (
            <Suspense fallback={<div className="empty">Loading editor…</div>}>
              <Files connection={connection} />
            </Suspense>
          )}
        </div>
      </main>

      {tab === 'terminal' && (
        <KeyBar
          onSend={sendKeys}
          ctrlArmed={ctrlArmed}
          onToggleCtrl={() => setCtrlArmed((armed) => !armed)}
        />
      )}

      <nav className="tab-bar">
        <button
          type="button"
          className={tab === 'terminal' ? 'active' : ''}
          onClick={() => setTab('terminal')}
        >
          Terminal
        </button>
        <button
          type="button"
          className={tab === 'files' ? 'active' : ''}
          onClick={() => setTab('files')}
        >
          Files
        </button>
      </nav>

      {showSessions && (
        <Sessions
          connection={connection}
          current={session}
          onSelect={(id) => {
            setSession(id);
            setShowSessions(false);
            setTab('terminal');
          }}
          onClose={() => setShowSessions(false)}
          onDisconnect={disconnect}
        />
      )}
    </div>
  );
}
