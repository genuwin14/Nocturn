import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import {
  listFiles,
  readFile,
  writeFile,
  type Connection,
  type Entry,
  type FileContent,
} from './api';

interface Props {
  connection: Connection;
}

function languageFor(path: string): Extension[] {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return [javascript({ typescript: extension.startsWith('ts'), jsx: extension.endsWith('x') })];
  }
  if (extension === 'rs') return [rust()];
  if (extension === 'py') return [python()];
  if (['json', 'jsonc'].includes(extension)) return [json()];
  return [];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Splits a root-relative path into cumulative breadcrumb segments. */
function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: 'root', path: '' }];
  let accumulated = '';
  for (const part of path.split('/').filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    crumbs.push({ name: part, path: accumulated });
  }
  return crumbs;
}

export function Files({ connection }: Props) {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState<FileContent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const listing = await listFiles(connection, path);
        setEntries(listing.entries);
        setDir(listing.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [connection],
  );

  useEffect(() => {
    void loadDirectory('');
  }, [loadDirectory]);

  const openFile = async (entry: Entry) => {
    if (entry.kind === 'dir') {
      void loadDirectory(entry.path);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const file = await readFile(connection, entry.path);
      setOpen(file);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Mount an editor whenever a file is opened, and tear it down on close. The
  // instance is keyed to the path so switching files rebuilds it with the right
  // language support rather than reconfiguring in place.
  useEffect(() => {
    if (!open || !editorHostRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: open.content,
        extensions: [
          basicSetup,
          oneDark,
          ...languageFor(open.path),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDirty(true);
          }),
        ],
      }),
      parent: editorHostRef.current,
    });
    editorRef.current = view;

    return () => {
      view.destroy();
      editorRef.current = null;
    };
  }, [open]);

  const save = async () => {
    const view = editorRef.current;
    if (!open || !view) return;

    // A truncated buffer holds only the head of the file. Writing it back would
    // silently discard everything past the read limit.
    if (open.truncated) {
      setError('This file was truncated on load and cannot be saved safely.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const content = view.state.doc.toString();
      const result = await writeFile(connection, open.path, content);
      setDirty(false);
      setNotice(`Saved ${formatSize(result.bytes)} to ${result.path}`);
      window.setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setOpen(null);
    setDirty(false);
  };

  if (open) {
    return (
      <div className="pane">
        <header className="pane-header">
          <button type="button" className="link" onClick={close}>
            ← Files
          </button>
          <span className="pane-title" title={open.path}>
            {open.path.split('/').pop()}
            {dirty && <span className="dot" aria-label="unsaved changes" />}
          </span>
          <button type="button" className="primary" onClick={save} disabled={busy || !dirty}>
            Save
          </button>
        </header>

        {open.truncated && (
          <div className="banner warn">
            Showing the first {formatSize(2 * 1024 * 1024)} of {formatSize(open.size)}. Saving
            is disabled for truncated files.
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        {notice && <div className="banner ok">{notice}</div>}

        <div className="editor-host" ref={editorHostRef} />
      </div>
    );
  }

  return (
    <div className="pane">
      <header className="pane-header">
        <nav className="crumbs">
          {breadcrumbs(dir).map((crumb, index, all) => (
            <span key={crumb.path}>
              <button type="button" className="link" onClick={() => loadDirectory(crumb.path)}>
                {crumb.name}
              </button>
              {index < all.length - 1 && <span className="crumb-sep">/</span>}
            </span>
          ))}
        </nav>
        <button type="button" className="link" onClick={() => loadDirectory(dir)} disabled={busy}>
          Refresh
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}

      <ul className="file-list">
        {dir !== '' && (
          <li>
            <button
              type="button"
              className="file-row"
              onClick={() => loadDirectory(dir.split('/').slice(0, -1).join('/'))}
            >
              <span className="file-icon">↰</span>
              <span className="file-name">..</span>
            </button>
          </li>
        )}
        {entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="file-row" onClick={() => openFile(entry)}>
              <span className="file-icon">
                {entry.kind === 'dir' ? '▸' : entry.kind === 'symlink' ? '⇢' : '·'}
              </span>
              <span className="file-name">{entry.name}</span>
              {entry.kind === 'file' && (
                <span className="file-size">{formatSize(entry.size)}</span>
              )}
            </button>
          </li>
        ))}
        {!busy && entries.length === 0 && <li className="empty">This directory is empty.</li>}
      </ul>
    </div>
  );
}
