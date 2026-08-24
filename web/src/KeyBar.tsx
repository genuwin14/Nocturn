import { useState } from 'react';

/**
 * On-screen keys that phone keyboards do not have.
 *
 * This is the component that decides whether a mobile terminal is usable at
 * all. No soft keyboard offers Esc, Tab, Ctrl or arrows, and without them you
 * cannot exit vim, complete a path, interrupt a build, or reach shell history.
 *
 * Ctrl is offered two ways deliberately. Arming the modifier works with a
 * hardware keyboard, where key events are reliable. Soft keyboards frequently
 * report composition events instead of real keydowns, so the explicit
 * combinations are the path that always works on a phone.
 */

interface Props {
  onSend: (data: string) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
}

interface Key {
  label: string;
  data?: string;
  /** Wider cell for labels that would otherwise be cramped. */
  wide?: boolean;
}

const NAV_KEYS: Key[] = [
  { label: 'Esc', data: '\x1b', wide: true },
  { label: 'Tab', data: '\t', wide: true },
  { label: '←', data: '\x1b[D' },
  { label: '↓', data: '\x1b[B' },
  { label: '↑', data: '\x1b[A' },
  { label: '→', data: '\x1b[C' },
  { label: 'Home', data: '\x1b[H', wide: true },
  { label: 'End', data: '\x1b[F', wide: true },
  { label: 'PgUp', data: '\x1b[5~', wide: true },
  { label: 'PgDn', data: '\x1b[6~', wide: true },
];

const SYMBOL_KEYS: Key[] = [
  { label: '^C', data: '\x03' },
  { label: '^D', data: '\x04' },
  { label: '^Z', data: '\x1a' },
  { label: '^L', data: '\x0c' },
  { label: '^R', data: '\x12' },
  { label: '^A', data: '\x01' },
  { label: '^E', data: '\x05' },
  { label: '^K', data: '\x0b' },
  { label: '^U', data: '\x15' },
  { label: '^W', data: '\x17' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
  { label: '_', data: '_' },
  { label: '$', data: '$' },
  { label: '*', data: '*' },
  { label: '&', data: '&' },
  { label: '>', data: '>' },
  { label: '<', data: '<' },
  { label: '"', data: '"' },
  { label: "'", data: "'" },
  { label: '`', data: '`' },
  { label: '{', data: '{' },
  { label: '}', data: '}' },
  { label: '[', data: '[' },
  { label: ']', data: ']' },
];

export function KeyBar({ onSend, ctrlArmed, onToggleCtrl }: Props) {
  const [row, setRow] = useState<'nav' | 'symbols'>('nav');
  const keys = row === 'nav' ? NAV_KEYS : SYMBOL_KEYS;

  return (
    <div className="keybar">
      <div className="keybar-fixed">
        <button
          type="button"
          className={`key key-mod ${ctrlArmed ? 'armed' : ''}`}
          // Pointer-down rather than click: a click would move focus away from
          // the terminal and dismiss the on-screen keyboard between keystrokes.
          onPointerDown={(e) => {
            e.preventDefault();
            onToggleCtrl();
          }}
        >
          Ctrl
        </button>
        <button
          type="button"
          className="key key-mod"
          onPointerDown={(e) => {
            e.preventDefault();
            setRow(row === 'nav' ? 'symbols' : 'nav');
          }}
        >
          {row === 'nav' ? '#+=' : 'abc'}
        </button>
      </div>

      <div className="keybar-scroll">
        {keys.map((key) => (
          <button
            key={key.label}
            type="button"
            className={`key ${key.wide ? 'key-wide' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              if (key.data) onSend(key.data);
            }}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Maps a printable key to its control character, or null if there is no such
 * mapping. Ctrl-A through Ctrl-Z are the low 26 codes; the handful of
 * punctuation mappings after them are the rest of the C0 range.
 */
export function controlCharacter(key: string): string | null {
  if (key.length !== 1) return null;
  const lower = key.toLowerCase();
  if (lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  const punctuation: Record<string, string> = {
    '@': '\x00',
    ' ': '\x00',
    '[': '\x1b',
    '\\': '\x1c',
    ']': '\x1d',
    '^': '\x1e',
    '_': '\x1f',
    '?': '\x7f',
  };
  return punctuation[key] ?? null;
}
