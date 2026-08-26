import { useCallback, useEffect, useState } from 'react';
import {
  gitCommit,
  gitDiff,
  gitDiscard,
  gitStage,
  gitStatus,
  gitUnstage,
  type Connection,
  type GitFile,
  type GitStatus,
} from './api';

/**
 * Reviewing what the agent changed.
 *
 * This is the half of the workflow that was missing. Starting a run from a
 * phone was already possible; deciding whether to keep its output was not,
 * because the only tools were a file browser and an editor, and nobody audits
 * a fourteen-file refactor by tapping through a tree.
 *
 * Master–detail rather than side-by-side: a phone is too narrow to show a list
 * and a diff at once, and too narrow for a split diff at all.
 */

interface Props {
  connection: Connection;
  /** Which project's changes to show. Status is per-root. */
  root?: string;
}

/** Whether a file has anything in the index, and so is part of a commit. */
function isStaged(file: GitFile): boolean {
  return file.staged !== '.' && !file.untracked;
}

function countLabel(file: GitFile): string {
  if (file.binary) return 'binary';
  if (file.untracked) return 'new';
  if (file.added === undefined || file.removed === undefined) return '';
  return `+${file.added} −${file.removed}`;
}

/**
 * The porcelain letter, expanded just enough to be readable. Kept close to
 * git's own vocabulary rather than renamed, so what the app says and what the
 * terminal says do not disagree.
 */
function stateLabel(file: GitFile): string {
  if (file.conflicted) return 'conflicted';
  if (file.untracked) return 'untracked';
  const code = file.staged !== '.' ? file.staged : file.unstaged;
  return (
    { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'retyped' }[code] ??
    'changed'
  );
}

/** Classifies one line of a unified diff for colouring. */
function lineKind(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export function Review({ connection, root }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchTruncated, setPatchTruncated] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await gitStatus(connection, root));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connection, root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The daemon serves staged and unstaged diffs separately, so which one to
  // ask for depends on where this file's changes currently live.
  const openFile = async (file: GitFile) => {
    setSelected(file.path);
    setPatch(null);
    setError(null);
    try {
      const result = await gitDiff(connection, file.path, isStaged(file), root);
      setPatch(result.patch);
      setPatchTruncated(result.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Runs an action, then re-reads status so the list reflects what happened. */
  const act = async (run: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await run();
      await refresh();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = (file: GitFile) => {
    // Typed confirmation rather than a toast with an undo. An undo that has to
    // survive the phone going into a tunnel is not an undo, and this is the
    // one action here that destroys work.
    const typed = window.prompt(
      `Throw away all changes to ${file.path}?\n\nThis cannot be undone. Type the file name to confirm.`,
    );
    if (typed !== file.path) return;
    void act(() => gitDiscard(connection, [file.path], root), () => {
      setSelected(null);
      setPatch(null);
    });
  };

  const commit = () => {
    const text = message.trim();
    if (!text) return;
    void act(
      async () => {
        const result = await gitCommit(connection, text, root);
        setNote(`Committed ${result.summary}`);
      },
      () => {
        setMessage('');
        setSelected(null);
        setPatch(null);
      },
    );
  };

  if (!status) {
    return <div className="empty">{error ?? 'Loading changes…'}</div>;
  }

  if (!status.repo) {
    return (
      <div className="empty">
        <p>No repository to review.</p>
        <p className="empty-detail">{status.reason}</p>
      </div>
    );
  }

  const stagedFiles = status.files.filter(isStaged);

  // --- one file's diff ------------------------------------------------------
  if (selected) {
    const file = status.files.find((f) => f.path === selected);
    return (
      <div className="review">
        <header className="review-bar">
          <button type="button" className="link" onClick={() => setSelected(null)}>
            ‹ Changes
          </button>
          <span className="review-path">{selected}</span>
        </header>

        {error && <div className="banner error">{error}</div>}
        {patchTruncated && (
          <div className="banner warn">
            Diff too large to show in full. Staging from here is disabled; use the
            terminal.
          </div>
        )}

        <div className="diff">
          {patch === null && <div className="empty">Loading diff…</div>}
          {patch !== null && patch.trim() === '' && (
            <div className="empty">
              {file?.untracked
                ? 'New file — nothing to compare against yet.'
                : 'No textual changes.'}
            </div>
          )}
          {patch
            ? patch.split('\n').map((line, i) => (
                // Diff lines have no identity of their own, and the list is
                // replaced wholesale on every load, so the index is a correct
                // key here rather than a shortcut.
                <div key={i} className={`diff-line ${lineKind(line)}`}>
                  {line || ' '}
                </div>
              ))
            : null}
        </div>

        {file && (
          <footer className="review-actions">
            {isStaged(file) ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => gitUnstage(connection, [file.path], root))}
              >
                Unstage
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || patchTruncated}
                onClick={() => void act(() => gitStage(connection, [file.path], root))}
              >
                Stage
              </button>
            )}
            {!file.untracked && (
              <button type="button" className="danger" disabled={busy} onClick={() => discard(file)}>
                Discard
              </button>
            )}
          </footer>
        )}
      </div>
    );
  }

  // --- the change list ------------------------------------------------------
  return (
    <div className="review">
      <header className="review-bar">
        <span className="review-branch">{status.branch ?? 'detached'}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="review-track">
            {status.ahead > 0 ? `↑${status.ahead}` : ''}
            {status.behind > 0 ? `↓${status.behind}` : ''}
          </span>
        )}
        <button type="button" className="link" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}
      {note && <div className="banner ok">{note}</div>}

      {status.files.length === 0 ? (
        <div className="empty">Nothing changed. The tree is clean.</div>
      ) : (
        <ul className="change-list">
          {status.files.map((file) => (
            <li key={file.path} className={isStaged(file) ? 'staged' : ''}>
              <button type="button" className="change-row" onClick={() => void openFile(file)}>
                <span className={`change-mark ${isStaged(file) ? 'on' : ''}`}>
                  {isStaged(file) ? '●' : '○'}
                </span>
                <span className="change-path">
                  {file.original_path && (
                    <span className="change-from">{file.original_path} → </span>
                  )}
                  {file.path}
                </span>
                <span className="change-meta">
                  <span className="change-state">{stateLabel(file)}</span>
                  <span className="change-count">{countLabel(file)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="commit-box"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
      >
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            stagedFiles.length > 0
              ? `Commit ${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'}`
              : 'Stage something to commit'
          }
          disabled={stagedFiles.length === 0}
        />
        <button
          type="submit"
          className="primary"
          disabled={busy || !message.trim() || stagedFiles.length === 0}
        >
          Commit
        </button>
      </form>
    </div>
  );
}
