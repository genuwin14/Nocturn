import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { TerminalView, type Status, type TerminalHandle } from './Terminal';
import { KeyBar } from './KeyBar';
import { Setup } from './Setup';
import { Sessions } from './Sessions';
import {
  clearConnection,
  listRoots,
  loadConnection,
  saveConnection,
  type Activity,
  type Connection,
  type Root,
} from './api';
import './styles.css';

// CodeMirror is roughly two thirds of the bundle and only the Files tab needs
// it. Splitting it out keeps the terminal — the thing you open the app for —
// fast to load over a phone connection.
const Files = lazy(() => import('./Files').then((m) => ({ default: m.Files })));

// Review carries no heavy dependency — a diff is rendered as lines, not with
// an editor — but it is split anyway so it costs nothing until the tab is
// opened, and the terminal stays the only thing in the first load.
const Review = lazy(() => import('./Review').then((m) => ({ default: m.Review })));

// Opened rarely — adding or removing a device is not a daily act — so it costs
// nothing until the sheet is asked for.
const Devices = lazy(() => import('./Devices').then((m) => ({ default: m.Devices })));

type Tab = 'terminal' | 'review' | 'files';

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
  const [roots, setRoots] = useState<Root[]>([]);
  // Undefined until the list arrives, and left that way against a daemon with
  // no roots endpoint. Every call treats an absent root as "the default one",
  // so the app works either way rather than waiting on this.
  const [root, setRoot] = useState<string>();
  // Whether the root question has been *answered*, which is not the same as
  // `root` being set: undefined is a real answer, and the only one a daemon
  // with no /api/roots can give. The terminal waits for it rather than
  // attaching and correcting itself, because correcting itself means spawning
  // a shell in the default root, abandoning it, and reattaching — and the
  // reattach replays the scrollback, including the cursor-position query the
  // shell asked at startup. Answering that a second time puts an escape
  // sequence into the shell's stdin, where the line editor swallows it along
  // with the next key you press.
  const [rootResolved, setRootResolved] = useState(false);
  const [session, setSession] = useState('main');
  const [showSessions, setShowSessions] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [statusDetail, setStatusDetail] = useState<string>();
  const [activity, setActivity] = useState<Activity>('working');
  const [activityTail, setActivityTail] = useState('');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  const terminalRef = useRef<TerminalHandle>(null);

  const onStatusChange = useCallback((next: Status, detail?: string) => {
    setStatus(next);
    setStatusDetail(detail);
  }, []);

  const onActivityChange = useCallback((next: Activity, tail: string) => {
    setActivity(next);
    setActivityTail(tail);
  }, []);

  const onSelectionChange = useCallback((next: boolean) => {
    setHasSelection(next);
  }, []);

  const connect = (next: Connection) => {
    saveConnection(next);
    setConnection(next);
  };

  const disconnect = () => {
    clearConnection();
    setConnection(null);
  };

  // Which projects this daemon serves. Read once — roots are fixed at startup,
  // so there is nothing to poll for.
  useEffect(() => {
    if (!connection) return;
    let live = true;
    listRoots(connection)
      .then((list) => {
        if (!live || list.length === 0) return;
        setRoots(list);
        setRoot((current) => current ?? (list.find((r) => r.default) ?? list[0]).name);
      })
      .catch(() => {
        // An older daemon has no /api/roots. Leaving the root unset makes every
        // request fall through to its single configured one, which is exactly
        // the behaviour that daemon has.
      })
      // Answered either way — with a name, or with "this daemon does not have
      // them". Both are answers, and an answer is all the terminal waits for.
      .finally(() => {
        if (live) setRootResolved(true);
      });
    return () => {
      live = false;
    };
  }, [connection]);

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
          {/*
            The project, but only when there is more than one — the name is
            redundant on a single-root daemon and the header has no width to
            spare. Session names are scoped to their root, so without this
            "main" would not say which shell you are looking at.
          */}
          {roots.length > 1 && root && <span className="root-name">{root}/</span>}
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
          {rootResolved && (
            <TerminalView
              ref={terminalRef}
              connection={connection}
              session={session}
              root={root}
              onStatusChange={onStatusChange}
              onActivityChange={onActivityChange}
              onSelectionChange={onSelectionChange}
              ctrlArmed={ctrlArmed}
              onCtrlConsumed={() => setCtrlArmed(false)}
            />
          )}
        </div>
        {/*
          Review and Files mount on demand and unmount when hidden, unlike the
          terminal. They hold no connection worth preserving, and remounting
          Review is how it re-reads status after you have been away in the
          terminal making changes.
        */}
        {/*
          Keyed by root, so switching project rebuilds them rather than leaving
          a path or a selected file from somewhere else on screen. Their state
          is entirely about one project's tree, and none of it survives the move.
        */}
        <div className={`tab-panel ${tab === 'review' ? 'active' : ''}`}>
          {tab === 'review' && (
            <Suspense fallback={<div className="empty">Loading changes…</div>}>
              <Review key={root} connection={connection} root={root} />
            </Suspense>
          )}
        </div>
        <div className={`tab-panel ${tab === 'files' ? 'active' : ''}`}>
          {tab === 'files' && (
            <Suspense fallback={<div className="empty">Loading editor…</div>}>
              <Files key={root} connection={connection} root={root} />
            </Suspense>
          )}
        </div>
      </main>

      {tab === 'terminal' && (
        <KeyBar
          onSend={sendKeys}
          onPaste={(text) => {
            const terminal = terminalRef.current;
            if (!terminal) return;

            // Bracketed paste is what normally stops a multi-line paste from
            // running line by line, but it only works when the shell enables
            // it — and PSReadLine over ConPTY never does. Rather than let a
            // stray tap fire off several commands on a host somewhere, say so
            // first. This is the failure the README worries about, and it is
            // silent without the check.
            if (terminal.pasteWillExecute(text)) {
              const lines = text.trimEnd().split(/\r\n|\r|\n/).length;
              const proceed = window.confirm(
                `This shell runs pasted lines immediately, so all ${lines} of these will execute now.\n\n` +
                  `First line: ${text.split(/\r\n|\r|\n/)[0].slice(0, 60)}\n\n` +
                  `Paste anyway?`,
              );
              if (!proceed) return;
            }

            terminal.paste(text);
          }}
          getSelection={() => terminalRef.current?.getSelection() ?? ''}
          hasSelection={hasSelection}
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
          className={tab === 'review' ? 'active' : ''}
          onClick={() => setTab('review')}
        >
          Review
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
          roots={roots}
          root={root}
          current={session}
          // Switching project leaves the sheet open: the list below it is now
          // that project's, which is usually the next thing you want to look at.
          onSelectRoot={(name, landing) => {
            setRoot(name);
            setSession(landing);
          }}
          onSelect={(id, from) => {
            if (from) setRoot(from);
            setSession(id);
            setShowSessions(false);
            setTab('terminal');
          }}
          onClose={() => setShowSessions(false)}
          onDisconnect={disconnect}
          onManageDevices={() => {
            setShowSessions(false);
            setShowDevices(true);
          }}
        />
      )}

      {showDevices && (
        <Suspense fallback={null}>
          <Devices
            connection={connection}
            onClose={() => setShowDevices(false)}
            // Revoking the token this browser is using leaves it holding a
            // credential the daemon no longer accepts. Dropping it returns to
            // the setup screen, rather than letting every request 403 with no
            // explanation.
            onSelfRevoked={() => {
              setShowDevices(false);
              disconnect();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
