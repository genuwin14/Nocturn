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
import { openTerminal, type Activity, type Connection } from './api';
import { controlCharacter } from './KeyBar';

export type Status = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface TerminalHandle {
  /** Injects input as if typed. Used by the on-screen key bar. */
  send: (data: string) => void;
  /**
   * Inserts text as a paste rather than as keystrokes.
   *
   * This is not the same as `send`. xterm wraps the text in bracketed-paste
   * markers when the shell has asked for them, which is what lets a shell tell
   * pasted text from typed text and refuse to execute it on the newlines
   * inside. Without that, pasting anything multi-line runs every line.
   */
  paste: (text: string) => void;
  /**
   * Whether pasting this text would execute it rather than place it on the
   * command line.
   *
   * True when the text spans lines *and* the shell has not enabled bracketed
   * paste. Both halves matter: xterm only emits the markers when the shell
   * asked for them, and when it has not, it sends the newlines as carriage
   * returns — so every line runs the moment it arrives.
   *
   * PSReadLine over ConPTY is the case that makes this necessary. It never
   * sets the mode, so on Windows a multi-line paste always executes.
   */
  pasteWillExecute: (text: string) => boolean;
  /** The current selection, or an empty string. */
  getSelection: () => string;
  focus: () => void;
}

interface Props {
  connection: Connection;
  session: string;
  /**
   * Which project the session belongs to. Session names are scoped to their
   * root, so this is what makes `main` a different shell in each one.
   */
  root?: string;
  onStatusChange?: (status: Status, detail?: string) => void;
  /**
   * Reports what the shell is doing, with the last line of output when it is
   * idle or waiting. Called on attach and on every transition.
   */
  onActivityChange?: (activity: Activity, tail: string) => void;
  /** Whether anything is selected, so a copy affordance can appear only when
   * there is something to copy. */
  onSelectionChange?: (hasSelection: boolean) => void;
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
    {
      connection,
      session,
      root,
      onStatusChange,
      onActivityChange,
      onSelectionChange,
      ctrlArmed,
      onCtrlConsumed,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    // The live socket, for the two callers outside the connection effect:
    // `send` and the geometry observer. The effect owns its own reference and
    // only writes here when this still points at the socket it created, so a
    // socket closing late cannot clear the handle of the one that replaced it.
    const socketRef = useRef<WebSocket | null>(null);
    // Geometry last sent to the daemon, so an observation that leaves the
    // character grid unchanged is not reported as a resize.
    const sentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

    // Status is reported upward rather than rendered here; the header owns the
    // indicator so it stays visible on the Files tab too.
    const [, setStatus] = useState<Status>('connecting');

    // The custom key handler is installed once at mount but has to see the
    // current modifier state, so the latest values live in refs.
    const ctrlArmedRef = useRef(false);
    const onCtrlConsumedRef = useRef(onCtrlConsumed);
    ctrlArmedRef.current = ctrlArmed ?? false;
    onCtrlConsumedRef.current = onCtrlConsumed;

    // Held in a ref rather than closed over, so that a caller passing an
    // unstable callback cannot re-run the connection effect. Tearing down a
    // working socket because a parent re-rendered would drop the terminal and
    // replay the entire scrollback.
    //
    // Synced in an effect rather than during render like the two refs above:
    // writing a ref while rendering is what those trip the linter over, and
    // there is no reason to repeat it in new code.
    const onActivityChangeRef = useRef(onActivityChange);
    useEffect(() => {
      onActivityChangeRef.current = onActivityChange;
    }, [onActivityChange]);

    const onSelectionChangeRef = useRef(onSelectionChange);
    useEffect(() => {
      onSelectionChangeRef.current = onSelectionChange;
    }, [onSelectionChange]);

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
      // Goes through xterm rather than straight to the socket, so the text
      // picks up bracketed-paste markers when the shell has enabled them. The
      // resulting bytes reach the socket through the same onData handler as
      // typing does.
      paste: (text: string) => {
        termRef.current?.paste(text);
        termRef.current?.focus();
      },
      pasteWillExecute: (text: string) => {
        if (!/[\r\n]/.test(text.trimEnd())) return false;
        return !termRef.current?.modes.bracketedPasteMode;
      },
      getSelection: () => termRef.current?.getSelection() ?? '',
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
      // Every one of these is scoped to this effect run rather than held in a
      // ref, because the run's teardown and its successor's setup are not the
      // only things that touch them: a socket's `close` event arrives *after*
      // the successor has started. A shared "closed" flag is already back to
      // false by then, so the abandoned socket reads itself as live and
      // schedules a reconnect — leaving two sockets attached to one session,
      // both writing into the same terminal, and every byte drawn twice.
      let cancelled = false;
      let attempt = 0;
      let timer: number | null = null;
      let current: WebSocket | null = null;

      const connect = () => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit || cancelled) return;

        // The server replays its scrollback on every attach. Clearing first
        // means a reconnect repaints the true remote state instead of appending
        // a second copy of everything below what is already on screen.
        term.reset();

        fit.fit();
        const socket = openTerminal(connection, session, term.cols, term.rows, root);
        current = socket;
        socketRef.current = socket;
        // The attach URL carries the geometry, so the daemon already has it and
        // the observer has nothing to report until it actually changes.
        sentSizeRef.current = { cols: term.cols, rows: term.rows };

        socket.onopen = () => {
          attempt = 0;
          report('connected');
          term.focus();
          // The URL carried the geometry as it was when the socket was created.
          // If the layout moved during the handshake — a soft keyboard opening
          // is enough — nothing else will tell the daemon, because the
          // observation that would have done it fired while the socket was
          // still connecting and had nowhere to send.
          const sent = sentSizeRef.current;
          if (!sent || sent.cols !== term.cols || sent.rows !== term.rows) {
            sentSizeRef.current = { cols: term.cols, rows: term.rows };
            socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
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
              } else if (message.type === 'ready') {
                // Carries the current state, so reattaching mid-run shows the
                // truth immediately rather than looking idle until the next
                // transition — which for a long build could be minutes away.
                onActivityChangeRef.current?.(message.state, '');
              } else if (message.type === 'state') {
                onActivityChangeRef.current?.(message.state, message.tail ?? '');
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
          // Only if the shared handle still points at *this* socket. A socket
          // abandoned by an earlier run closes long after its replacement is
          // live, and clearing the handle then would silently mute typing.
          if (socketRef.current === socket) socketRef.current = null;
          if (cancelled) return;

          // 1008 is the daemon rejecting the handshake, which in practice means
          // a bad token. Retrying cannot fix that, so stop and say so.
          if (event.code === 1008) {
            report('error', 'Token rejected by the daemon.');
            return;
          }

          const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
          attempt += 1;
          report('reconnecting', `retrying in ${Math.round(delay / 1000)}s`);
          timer = window.setTimeout(connect, delay);
        };
      };

      report('connecting');
      connect();

      return () => {
        cancelled = true;
        if (timer !== null) window.clearTimeout(timer);
        // Detached before closing, so the late `close` event cannot reconnect
        // or touch the terminal that the next run is already writing into.
        if (current) {
          current.onopen = null;
          current.onmessage = null;
          current.onerror = null;
          current.onclose = null;
          if (socketRef.current === current) socketRef.current = null;
          current.close();
        }
      };
    }, [connection, session, root, report]);

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

      const onSelection = term.onSelectionChange(() => {
        onSelectionChangeRef.current?.(term.hasSelection());
      });

      return () => {
        onData.dispose();
        onBinary.dispose();
        onSelection.dispose();
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
        if (socket?.readyState !== WebSocket.OPEN) return;

        // Most observations change the pixel box without changing the character
        // grid — a header growing a line, a scrollbar appearing. Reporting those
        // is not free: ConPTY repaints its whole viewport on any resize, even to
        // the size it already has, and those bytes reach every attached client.
        const sent = sentSizeRef.current;
        if (sent && sent.cols === term.cols && sent.rows === term.rows) return;
        sentSizeRef.current = { cols: term.cols, rows: term.rows };
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
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
