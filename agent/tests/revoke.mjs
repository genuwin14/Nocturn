// Does revoking a token end the terminal it currently has open?
//
// This is the property that makes the revocation story real. A token that stops
// working for *new* requests while an existing socket keeps running leaves the
// thief with a live shell for as long as they hold the connection, which is
// indefinitely — and the window it leaves open is exactly the one that matters
// when a phone goes missing.
//
//   NOCTURN_TEST_URL    default http://127.0.0.1:7071
//   NOCTURN_TEST_TOKEN  an admin token, to mint and revoke with

const BASE = (process.env.NOCTURN_TEST_URL ?? 'http://127.0.0.1:7071').replace(/\/+$/, '');
const WS = BASE.replace(/^http/, 'ws');
const ADMIN = process.env.NOCTURN_TEST_TOKEN;

if (!ADMIN) {
  console.error('set NOCTURN_TEST_TOKEN to a token that can manage devices');
  process.exit(2);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = { Authorization: `Bearer ${ADMIN}` };

async function main() {
  const minted = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'doomed-phone' }),
  }).then((r) => r.json());

  check('minting returns the secret exactly once',
    typeof minted.secret === 'string' && minted.secret.length === 64,
    `id=${minted.id}`);
  check('minting returns a ready-to-scan pairing url',
    typeof minted.pair_url === 'string' && minted.pair_url.includes(`#pair=${minted.secret}`));

  // Attach with the doomed token and hold the socket open.
  const socket = new WebSocket(`${WS}/ws/terminal?session=revoke-test&cols=80&rows=24`, [
    'nocturn.v1',
    `bearer.${minted.secret}`,
  ]);
  socket.binaryType = 'arraybuffer';

  let ready = false;
  let closedAt = null;
  socket.onmessage = (event) => {
    if (typeof event.data === 'string' && JSON.parse(event.data).type === 'ready') ready = true;
  };
  socket.onclose = () => {
    closedAt = Date.now();
  };

  const opened = await new Promise((resolve) => {
    socket.onopen = () => resolve(true);
    socket.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 5000);
  });
  check('the new token can open a terminal', opened && socket.readyState === WebSocket.OPEN);

  await sleep(1500);
  check('the socket reached ready', ready);

  const revokedAt = Date.now();
  const revoked = await fetch(`${BASE}/api/tokens/${minted.id}`, {
    method: 'DELETE',
    headers: admin,
  });
  check('revoking succeeds', revoked.status === 204, `got ${revoked.status}`);

  // The whole point: this must not require the client to reconnect.
  for (let i = 0; i < 50 && closedAt === null; i += 1) await sleep(100);

  check('revoking closes the socket it was authenticated with',
    closedAt !== null,
    closedAt ? `after ${closedAt - revokedAt}ms` : 'still open after 5s');

  const reattach = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: `Bearer ${minted.secret}` },
  });
  check('and the revoked token cannot come back', reattach.status === 403,
    `got ${reattach.status}`);

  // The session itself is not the token's to destroy — it belongs to the
  // daemon, and another device must still find it running.
  const sessions = await fetch(`${BASE}/api/sessions`, { headers: admin }).then((r) => r.json());
  check('the session survives the revocation',
    sessions.some((s) => s.id === 'revoke-test' && s.alive),
    sessions.map((s) => s.id).join(', '));

  await fetch(`${BASE}/api/sessions/revoke-test`, { method: 'DELETE', headers: admin });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
