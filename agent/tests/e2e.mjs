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
