import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, type Connection } from './api';
import { controlCharacter } from './KeyBar';

export type Status = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface TerminalHandle {
  /** Injects input as if typed. Used by the on-screen key bar. */
  send: (data: string) => void;
  focus: () => void;
}

interface Props {
  connection: Connection;
  session: string;
  onStatusChange?: (status: Status, detail?: string) => void;
  /** When true, the next printable keypress is sent as a control character. */
  ctrlArmed?: boolean;
  onCtrlConsumed?: () => void;
}

/** Reconnect backoff. Mobile networks drop constantly; give up slowly. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

const THEME = {
  background: '#0b0d10',
  foreground: '#d4d7dd',
  cursor: '#7aa2f7',
  selectionBackground: '#283457',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#c0caf5',
};

export const TerminalView = forwardRef<TerminalHandle, Props>(
  function TerminalView(
    { connection, session, onStatusChange, ctrlArmed, onCtrlConsumed },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const attemptRef = useRef(0);
    const timerRef = useRef<number | null>(null);
    // Set when the component unmounts or the session changes, so an in-flight
    // close handler does not resurrect a socket we deliberately abandoned.
    const closedRef = useRef(false);

    // Status is reported upward rather than rendered here; the header owns the
    // indicator so it stays visible on the Files tab too.
    const [, setStatus] = useState<Status>('connecting');

    // The custom key handler is installed once at mount but has to see the
    // current modifier state, so the latest values live in refs.
    const ctrlArmedRef = useRef(false);
    const onCtrlConsumedRef = useRef(onCtrlConsumed);
    ctrlArmedRef.current = ctrlArmed ?? false;
    onCtrlConsumedRef.current = onCtrlConsumed;

    /**
     * Writes to the live socket, if there is one. Stable across renders.
     *
     * The buffer is pinned to ArrayBuffer rather than ArrayBufferLike because
     * `WebSocket.send` will not accept a view that might be backed by a
     * SharedArrayBuffer.
     */
    const send = useCallback((data: string | Uint8Array<ArrayBuffer>) => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    }, []);

    const report = useCallback(
      (next: Status, detail?: string) => {
        setStatus(next);
        onStatusChange?.(next, detail);
      },
      [onStatusChange],
    );

    useImperativeHandle(ref, () => ({
      send: (data: string) => {
        send(data);
        termRef.current?.focus();
      },
      focus: () => termRef.current?.focus(),
    }));

    // --- terminal lifecycle -------------------------------------------------

    useEffect(() => {
      if (!hostRef.current) return;

      const term = new XTerm({
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        theme: THEME,
        // The daemon holds the authoritative scrollback; this is just what the
        // renderer keeps for local scrolling.
        scrollback: 5000,
        // Lets a swipe scroll the page rather than the terminal when the
        // terminal is not the thing being scrolled.
        macOptionIsMeta: true,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      fit.fit();

      // Applies an armed Ctrl to the next printable key. This path depends on
      // real keydown events, so it serves hardware keyboards; soft keyboards
      // are covered by the explicit combinations in the key bar instead.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !ctrlArmedRef.current) return true;
        if (event.ctrlKey || event.altKey || event.metaKey) return true;
        const control = controlCharacter(event.key);
        if (!control) return true;
        send(control);
        onCtrlConsumedRef.current?.();
        return false;
      });

      termRef.current = term;
      fitRef.current = fit;

      return () => {
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    // --- connection ---------------------------------------------------------

    useEffect(() => {
      closedRef.current = false;
      attemptRef.current = 0;

      const connect = () => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit || closedRef.current) return;

        // The server replays its scrollback on every attach. Clearing first
        // means a reconnect repaints the true remote state instead of appending
        // a second copy of everything below what is already on screen.
        term.reset();

        fit.fit();
        const socket = openTerminal(connection, session, term.cols, term.rows);
        socketRef.current = socket;

        socket.onopen = () => {
          attemptRef.current = 0;
          report('connected');
          term.focus();
        };

        socket.onmessage = (event) => {
          if (typeof event.data === 'string') {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'exit') {
                term.write(
                  `\r\n\x1b[38;5;244m[session exited with code ${message.code}]\x1b[0m\r\n`,
                );
              } else if (message.type === 'error') {
                term.write(`\r\n\x1b[38;5;203m[${message.message}]\x1b[0m\r\n`);
              }
            } catch {
              /* not a control message we understand; ignore */
            }
            return;
          }
          // Raw PTY bytes. Writing the Uint8Array rather than a decoded string
          // lets xterm reassemble multi-byte UTF-8 that straddles two frames.
          term.write(new Uint8Array(event.data as ArrayBuffer));
        };

        socket.onerror = () => {
          // onclose always follows, and carries the information worth acting on.
        };

        socket.onclose = (event) => {
          socketRef.current = null;
          if (closedRef.current) return;

          // 1008 is the daemon rejecting the handshake, which in practice means
          // a bad token. Retrying cannot fix that, so stop and say so.
          if (event.code === 1008) {
            report('error', 'Token rejected by the daemon.');
            return;
          }

          const attempt = attemptRef.current;
          const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
          attemptRef.current = attempt + 1;
          report('reconnecting', `retrying in ${Math.round(delay / 1000)}s`);
          timerRef.current = window.setTimeout(connect, delay);
        };
      };

      report('connecting');
      connect();

      return () => {
        closedRef.current = true;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        socketRef.current?.close();
        socketRef.current = null;
      };
    }, [connection, session, report]);

    // --- input --------------------------------------------------------------

    useEffect(() => {
      const term = termRef.current;
      if (!term) return;

      // onData carries typed keys and, importantly, xterm's automatic replies to
      // terminal queries such as the cursor position report a shell's line
      // editor blocks on at startup.
      const onData = term.onData(send);
      const onBinary = term.onBinary((data) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
        send(bytes);
      });

      return () => {
        onData.dispose();
        onBinary.dispose();
      };
    }, [send]);

    // --- geometry -----------------------------------------------------------

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const applyFit = () => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit) return;
        try {
          fit.fit();
        } catch {
          // fit() throws if the element is not laid out yet, e.g. while the
          // Files tab is showing. The next observation will catch it.
          return;
        }
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };

      const observer = new ResizeObserver(applyFit);
      observer.observe(host);

      // The on-screen keyboard resizes the visual viewport without resizing the
      // layout viewport, so ResizeObserver alone misses it on mobile.
      window.visualViewport?.addEventListener('resize', applyFit);
      window.addEventListener('orientationchange', applyFit);

      return () => {
        observer.disconnect();
        window.visualViewport?.removeEventListener('resize', applyFit);
        window.removeEventListener('orientationchange', applyFit);
      };
    }, []);

    return <div className="terminal-host" ref={hostRef} />;
  },
);
