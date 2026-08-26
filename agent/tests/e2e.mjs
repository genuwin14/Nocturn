// End-to-end check of the one property Nocturn is built on:
// a session keeps running, and keeps buffering output, with no client attached.
//
// Runs against either platform's daemon. Override with environment variables:
//   NOCTURN_TEST_URL    default http://127.0.0.1:7071
//   NOCTURN_TEST_TOKEN  default test-token-abc123
//   NOCTURN_TEST_SHELL  "posix" or "powershell"; defaults to the host platform,
//                       so set it explicitly when testing a Linux daemon from
//                       Windows or vice versa.

const BASE = (process.env.NOCTURN_TEST_URL ?? 'http://127.0.0.1:7071').replace(/\/+$/, '');
const WS = BASE.replace(/^http/, 'ws');
const TOKEN = process.env.NOCTURN_TEST_TOKEN ?? 'test-token-abc123';
const SHELL =
  process.env.NOCTURN_TEST_SHELL ?? (process.platform === 'win32' ? 'powershell' : 'posix');

// Per-shell details. Everything else in this file is platform independent.
const DIALECT = {
  powershell: {
    // PowerShell takes a second or two to reach a prompt.
    warmupMs: 2500,
    ticks: '1..10 | %{ "TICK$_"; Start-Sleep -Milliseconds 700 }',
    // Finishes immediately, so the session falls quiet at a prompt.
    quick: 'echo NOCTURN_DONE',
    // Prints a question and blocks on input, so the session falls quiet
    // somewhere that is not a prompt.
    blocking: 'Read-Host "Enter passphrase"',
    traversal: '../../../../Windows/win.ini',
    absolute: 'C:/Windows/win.ini',
    // PSReadLine asks for the cursor position at startup and blocks until a
    // terminal answers. Bash's line editor does not, so this is only asserted
    // where a shell actually emits it.
    expectsDsr: true,
  },
  posix: {
    warmupMs: 1000,
    ticks: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo TICK$i; sleep 0.7; done',
    quick: 'echo NOCTURN_DONE',
    // printf rather than read -p, which is a bashism.
    blocking: 'printf "Enter passphrase: "; read _x',
    traversal: '../../../../etc/passwd',
    absolute: '/etc/passwd',
    expectsDsr: false,
  },
}[SHELL];

if (!DIALECT) {
  console.error(`unknown NOCTURN_TEST_SHELL: ${SHELL} (expected "posix" or "powershell")`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Attaches, collects everything received, and closes after `holdMs`.
//
// Answers Device Status Report queries (ESC [ 6 n). A shell's line editor sends
// one at startup and blocks until a terminal replies with the cursor position;
// xterm.js does this natively, so real clients never notice, but a raw socket
// harness has to do it by hand or the shell never reaches its prompt.
function attach(session, holdMs, onOpen) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/ws/terminal?session=${session}&cols=100&rows=30`, [
      'nocturn.v1',
      `bearer.${TOKEN}`,
    ]);
    ws.binaryType = 'arraybuffer';
    const out = { text: '', control: [], ready: null, dsrAnswered: 0 };
    const decoder = new TextDecoder();

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        out.control.push(msg);
        if (msg.type === 'ready') out.ready = msg;
        return;
      }
      const chunk = decoder.decode(new Uint8Array(ev.data), { stream: true });
      out.text += chunk;
      if (chunk.includes('\x1b[6n')) {
        out.dsrAnswered += 1;
        ws.send(new TextEncoder().encode('\x1b[1;1R'));
      }
    };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = async () => {
      if (onOpen) await onOpen(ws);
      setTimeout(() => ws.close(), holdMs);
    };
    ws.onclose = () => resolve(out);
  });
}

const send = (ws, s) => ws.send(new TextEncoder().encode(s));

async function main() {
  console.log(`target ${BASE}  shell ${SHELL}\n`);

  // --- health, unauthenticated ---
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check('health responds without a token', health.status === 'ok', `v${health.version}`);

  // --- auth ---
  const noToken = await fetch(`${BASE}/api/sessions`);
  check('missing token is rejected', noToken.status === 401, `got ${noToken.status}`);

  const badToken = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: 'Bearer wrong-token-abc123' },
  });
  check('wrong token is rejected', badToken.status === 403, `got ${badToken.status}`);

  const goodToken = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  check('valid bearer token is accepted', goodToken.status === 200, `got ${goodToken.status}`);

  // --- the persistence test ---
  // Start a counter that ticks for ~7s, then detach while it is still running.
  const first = await attach('persist', DIALECT.warmupMs + 2000, async (ws) => {
    await sleep(DIALECT.warmupMs);
    send(ws, `${DIALECT.ticks}\r`);
  });
  if (DIALECT.expectsDsr) {
    check('shell answered the startup DSR query', first.dsrAnswered > 0,
      `${first.dsrAnswered} answered`);
  } else {
    console.log(`SKIP  startup DSR query — ${SHELL} shells do not emit one`);
  }
  check('first client sees live output', /TICK1/.test(first.text), `${first.text.length} bytes`);
  check('ready frame sent on attach', first.ready !== null,
    first.ready ? `session=${first.ready.session} alive=${first.ready.alive}` : '');

  // Fully detached for 3.5s. The counter should keep running the whole time.
  await sleep(3500);

  const stillListed = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  const persisted = stillListed.find((s) => s.id === 'persist');
  check('session survives with no client attached', !!persisted && persisted.alive,
    persisted ? `${persisted.scrollback_bytes} bytes buffered` : 'not found');

  // Reattach and confirm the replay contains ticks emitted while we were away.
  const second = await attach('persist', 1500);
  const replayed = second.ready?.replayed ?? 0;
  const missedTicks = [3, 4, 5].filter((n) => second.text.includes(`TICK${n}`));
  check('scrollback replays output produced while detached',
    missedTicks.length === 3, `found TICK${missedTicks.join(', TICK')} in ${replayed}-byte replay`);
  check('reattached client also sees TICK1 from before the disconnect',
    second.text.includes('TICK1'));

  // --- activity signal ---
  // The daemon infers what a session is doing from its output stream, so a
  // client can tell a shell that is working from one sitting at a prompt —
  // and, critically, from one blocked on a question. An agent stopped on a
  // permission request looks exactly like an agent still thinking, and
  // nothing progresses until a person answers it.
  //
  // IDLE_AFTER in the daemon is 3s; allow for that plus the poll interval.
  const SETTLE_MS = 4500;

  const idleRun = await attach('activity-idle', DIALECT.warmupMs + SETTLE_MS, async (ws) => {
    await sleep(DIALECT.warmupMs);
    send(ws, `${DIALECT.quick}\r`);
  });
  const idleStates = idleRun.control.filter((m) => m.type === 'state');

  check('ready reports an activity state',
    ['working', 'idle', 'waiting'].includes(idleRun.ready?.state),
    `state=${idleRun.ready?.state}`);

  const settledIdle = idleStates.filter((s) => s.state === 'idle').pop();
  check('a finished command settles to idle', !!settledIdle,
    `saw ${idleStates.map((s) => s.state).join(' -> ') || 'no transitions'}`);
  check('idle reports the prompt line as its tail',
    !!settledIdle && /[$#>%]$/.test(settledIdle.tail.trim()),
    settledIdle ? JSON.stringify(settledIdle.tail) : '');

  const listedIdle = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  check('session list reports state without attaching',
    listedIdle.find((s) => s.id === 'activity-idle')?.state === 'idle',
    `state=${listedIdle.find((s) => s.id === 'activity-idle')?.state}`);

  // Now the case the whole signal exists for.
  const waitRun = await attach('activity-wait', DIALECT.warmupMs + SETTLE_MS, async (ws) => {
    await sleep(DIALECT.warmupMs);
    send(ws, `${DIALECT.blocking}\r`);
  });
  const settledWaiting = waitRun.control
    .filter((m) => m.type === 'state')
    .filter((s) => s.state === 'waiting')
    .pop();

  check('a shell blocked on input settles to waiting, not idle', !!settledWaiting,
    `saw ${waitRun.control.filter((m) => m.type === 'state').map((s) => s.state).join(' -> ')
      || 'no transitions'}`);
  check('waiting reports the question it is blocked on',
    !!settledWaiting && /passphrase/i.test(settledWaiting.tail),
    settledWaiting ? JSON.stringify(settledWaiting.tail) : '');

  // A reattaching client must learn it is mid-question without waiting for a
  // transition that already happened.
  const rejoined = await attach('activity-wait', 500);
  check('reattaching mid-question reports waiting in ready',
    rejoined.ready?.state === 'waiting', `state=${rejoined.ready?.state}`);

  for (const id of ['activity-idle', 'activity-wait']) {
    await fetch(`${BASE}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  // --- file API ---
  const auth = { Authorization: `Bearer ${TOKEN}` };

  const listing = await fetch(`${BASE}/api/fs/list?path=`, { headers: auth }).then((r) => r.json());
  const names = listing.entries.map((e) => e.name);
  check('fs list returns project files', names.includes('readme.txt') && names.includes('src'),
    names.join(', '));
  check('fs list puts directories first', listing.entries[0].kind === 'dir');

  const file = await fetch(`${BASE}/api/fs/read?path=readme.txt`, { headers: auth }).then((r) => r.json());
  check('fs read returns file content', file.content.trim() === 'hello from nocturn');

  const written = await fetch(`${BASE}/api/fs/write`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'src/new-file.txt', content: 'written by nocturn' }),
  });
  check('fs write creates a file', written.status === 200, `got ${written.status}`);

  const readBack = await fetch(`${BASE}/api/fs/read?path=src/new-file.txt`, { headers: auth })
    .then((r) => r.json());
  check('written file reads back correctly', readBack.content === 'written by nocturn');

  // --- path confinement ---
  const escape = await fetch(
    `${BASE}/api/fs/read?path=${encodeURIComponent(DIALECT.traversal)}`, { headers: auth });
  check('traversal outside root is refused', escape.status === 403 || escape.status === 404,
    `got ${escape.status}`);

  // Rejected the same way on every platform, and as 400 rather than 404: the
  // request is malformed, not merely pointing at something absent.
  const absolute = await fetch(
    `${BASE}/api/fs/read?path=${encodeURIComponent(DIALECT.absolute)}`, { headers: auth });
  const absoluteBody = await absolute.text();
  check('absolute path is refused with 400', absolute.status === 400, `got ${absolute.status}`);
  check('absolute path did not leak host file contents',
    !absoluteBody.includes('root:x:0:0') && !absoluteBody.includes('[fonts]'));

  // --- git review ---
  // Deliberately non-destructive: these stage and unstage the file the file
  // API block just created, and never commit. A suite that wrote a commit into
  // whatever repository it was pointed at would be a bad houseguest.
  const postJson = (path, body) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const gitStatus = () => fetch(`${BASE}/api/git/status`, { headers: auth }).then((r) => r.json());

  const repo = await gitStatus();

  if (!repo.repo) {
    // Not a failure. The root may legitimately not be a repository, and saying
    // which is the whole contract of this endpoint.
    check('a root without a usable repository explains why',
      typeof repo.reason === 'string' && repo.reason.length > 0, repo.reason);
    console.log(`SKIP  git review checks — ${repo.reason}`);
    console.log('      run "git init" in the test root to exercise them');
  } else {
    check('git status reports the branch',
      typeof repo.branch === 'string' && repo.branch.length > 0, `branch=${repo.branch}`);

    const fresh = repo.files.find((f) => f.path === 'src/new-file.txt');
    check('git status lists a newly written file as untracked',
      !!fresh && fresh.untracked, fresh ? JSON.stringify(fresh) : 'not listed');

    // The safety property this endpoint is built around. An untracked file has
    // never been committed, so there is nothing to restore it from — deleting
    // it is unrecoverable, and a tap on a phone must not be able to do that.
    const refused = await postJson('/api/git/discard', { paths: ['src/new-file.txt'] });
    const refusedBody = await refused.json();
    check('discard refuses untracked files, which cannot be recovered',
      refused.status === 400 && /untracked/i.test(refusedBody.error ?? ''),
      `got ${refused.status}: ${refusedBody.error ?? ''}`);

    const survived = await fetch(`${BASE}/api/fs/read?path=src/new-file.txt`, { headers: auth });
    check('the refused file is still on disk', survived.status === 200, `got ${survived.status}`);

    await postJson('/api/git/stage', { paths: ['src/new-file.txt'] });
    const afterStage = await gitStatus();
    check('stage moves a file into the index',
      afterStage.files.find((f) => f.path === 'src/new-file.txt')?.staged === 'A',
      JSON.stringify(afterStage.files.find((f) => f.path === 'src/new-file.txt')));

    const stagedDiff = await fetch(`${BASE}/api/git/diff?staged=true`, { headers: auth })
      .then((r) => r.json());
    check('the staged diff carries the file and its content',
      stagedDiff.patch.includes('src/new-file.txt') && stagedDiff.patch.includes('written by nocturn'),
      `${stagedDiff.patch.length} bytes, truncated=${stagedDiff.truncated}`);

    await postJson('/api/git/unstage', { paths: ['src/new-file.txt'] });
    const afterUnstage = await gitStatus();
    check('unstage returns it to untracked',
      afterUnstage.files.find((f) => f.path === 'src/new-file.txt')?.untracked === true);

    // Confinement extends to git, which reaches the filesystem by a different
    // route than the file API and so has to be proved separately.
    const stageEscape = await postJson('/api/git/stage', { paths: [DIALECT.traversal] });
    check('git stage refuses a traversal path', stageEscape.status === 403,
      `got ${stageEscape.status}`);

    const diffEscape = await fetch(
      `${BASE}/api/git/diff?path=${encodeURIComponent(DIALECT.traversal)}`, { headers: auth });
    check('git diff refuses a traversal path', diffEscape.status === 403,
      `got ${diffEscape.status}`);

    const commitEmpty = await postJson('/api/git/commit', { message: '   ' });
    check('commit refuses an empty message', commitEmpty.status === 400,
      `got ${commitEmpty.status}`);
  }

  // --- delete ---
  const deleted = await fetch(`${BASE}/api/sessions/persist`, { method: 'DELETE', headers: auth });
  check('session delete succeeds', deleted.status === 204, `got ${deleted.status}`);

  const after = await fetch(`${BASE}/api/sessions`, { headers: auth }).then((r) => r.json());
  check('deleted session is gone', !after.find((s) => s.id === 'persist'));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
