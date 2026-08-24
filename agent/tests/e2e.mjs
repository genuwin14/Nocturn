// End-to-end check of the one property Nocturn is built on:
// a session keeps running, and keeps buffering output, with no client attached.

const BASE = 'http://127.0.0.1:7071';
const WS = 'ws://127.0.0.1:7071';
const TOKEN = 'test-token-abc123';

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
  // PowerShell takes a second or two to reach its prompt, so warm up first.
  const first = await attach('persist', 4500, async (ws) => {
    await sleep(2500);
    send(ws, '1..10 | %{ "TICK$_"; Start-Sleep -Milliseconds 700 }\r');
  });
  check('shell answered the startup DSR query', first.dsrAnswered > 0,
    `${first.dsrAnswered} answered`);
  const sawEarly = /TICK1/.test(first.text);
  check('first client sees live output', sawEarly, `${first.text.length} bytes`);
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
  const escape = await fetch(`${BASE}/api/fs/read?path=../../../../Windows/win.ini`, { headers: auth });
  check('traversal outside root is refused', escape.status === 403 || escape.status === 404,
    `got ${escape.status}`);

  const absolute = await fetch(`${BASE}/api/fs/read?path=C:/Windows/win.ini`, { headers: auth });
  check('absolute path is refused', absolute.status === 400, `got ${absolute.status}`);

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
