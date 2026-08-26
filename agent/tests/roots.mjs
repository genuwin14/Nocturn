// Does naming a root actually confine to it, and does it stay confined when
// the roots are nested?
//
// The security claim of this feature is narrow and worth testing directly: a
// daemon serving three projects must behave exactly like three daemons each
// serving one, and must not let a request that names one project reach another
// by traversal. The nested case is the one most likely to be got wrong, since
// there "inside a root" and "inside the root you asked for" stop agreeing.
//
// Expects a daemon started with two sibling roots and one nested pair:
//
//   nocturn-agent --root <tmp>/alpha --root <tmp>/beta --root <tmp>/alpha/inner
//
//   NOCTURN_TEST_URL    default http://127.0.0.1:7071
//   NOCTURN_TEST_TOKEN  default test-token-abc123

const BASE = (process.env.NOCTURN_TEST_URL ?? 'http://127.0.0.1:7071').replace(/\/+$/, '');
const WS = BASE.replace(/^http/, 'ws');
const TOKEN = process.env.NOCTURN_TEST_TOKEN ?? 'test-token-abc123';

const auth = { Authorization: `Bearer ${TOKEN}` };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (path) => fetch(`${BASE}${path}`, { headers: auth });
const getJson = (path) => get(path).then((r) => r.json());

// Attaches, waits for `ready`, and closes. Returns the ready message, which is
// where the server reports which root the session actually belongs to.
function ready(session, root) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ session, cols: '80', rows: '24' });
    if (root !== undefined) q.set('root', root);

    const ws = new WebSocket(`${WS}/ws/terminal?${q}`, ['nocturn.v1', `bearer.${TOKEN}`]);
    ws.binaryType = 'arraybuffer';

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no ready for ${session}@${root}`));
    }, 8000);

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'ready') return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`socket error for ${session}@${root}`));
    };
    ws.onclose = () => clearTimeout(timer);
  });
}

async function main() {
  // A previous run left written.txt staged in beta, which would make the
  // untracked assertion below fail on every run after the first. Put it back
  // to untracked rather than asserting on whichever state happens to be there
  // — a test that only passes the first time is not testing anything.
  await fetch(`${BASE}/api/git/unstage`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: 'beta', paths: ['written.txt'] }),
  }).catch(() => {});

  // --- the listing -----------------------------------------------------------

  const roots = await getJson('/api/roots');
  check('the daemon lists every root it was given',
    Array.isArray(roots) && roots.length === 3,
    roots.map?.((r) => r.name).join(', '));

  const names = roots.map((r) => r.name);
  check('roots are named after their directories',
    names.includes('alpha') && names.includes('beta') && names.includes('inner'));

  check('exactly one root is the default, and it is the first',
    roots.filter((r) => r.default).length === 1 && roots[0].default && roots[0].name === 'alpha');

  check('the listing says which roots are repositories',
    roots.every((r) => typeof r.repo === 'boolean') &&
      roots.find((r) => r.name === 'beta').repo === true &&
      roots.find((r) => r.name === 'alpha').repo === false,
    'beta is a git repo, alpha is not');

  check('the listing reports readable paths, not verbatim ones',
    roots.every((r) => typeof r.path === 'string' && !r.path.startsWith('\\\\?\\')),
    roots[0].path);

  // --- the file API ----------------------------------------------------------

  const inAlpha = await getJson('/api/fs/list?root=alpha&path=');
  check('a named root lists its own contents',
    inAlpha.entries?.some((e) => e.name === 'alpha-only.txt'),
    inAlpha.entries?.map((e) => e.name).join(', '));
  check('the listing echoes the root it answered for', inAlpha.root === 'alpha');

  const inBeta = await getJson('/api/fs/list?root=beta&path=');
  check('another root lists a different tree',
    inBeta.entries?.some((e) => e.name === 'beta-only.txt') &&
      !inBeta.entries?.some((e) => e.name === 'alpha-only.txt'));

  const omitted = await getJson('/api/fs/list?path=');
  check('omitting the root means the default one, as it always did',
    omitted.root === 'alpha' && omitted.entries?.some((e) => e.name === 'alpha-only.txt'));

  const unknown = await get('/api/fs/list?root=nope&path=');
  const unknownBody = await unknown.json();
  check('an unknown root is rejected before any path handling',
    unknown.status === 400 && /unknown root/.test(unknownBody.error ?? ''),
    unknownBody.error);
  check('the rejection says which roots do exist',
    /alpha/.test(unknownBody.error ?? '') && /beta/.test(unknownBody.error ?? ''));

  // --- confinement, sideways -------------------------------------------------

  const sideways = await get('/api/fs/read?root=alpha&path=../beta/beta-only.txt');
  check('one root cannot be reached by traversing out of another',
    sideways.status === 403 || sideways.status === 404,
    `status ${sideways.status}`);

  // The same file, named from the root that genuinely owns it, must still work
  // — otherwise the check above proves nothing about confinement, only that
  // the read failed.
  const owned = await getJson('/api/fs/read?root=beta&path=beta-only.txt');
  check('the file the traversal wanted is readable from its own root',
    owned.content === 'beta\n' || owned.content === 'beta\r\n',
    JSON.stringify(owned.content));

  // --- confinement, nested ---------------------------------------------------

  const climb = await get('/api/fs/read?root=inner&path=../alpha-only.txt');
  check('a nested root cannot climb into the root that contains it',
    climb.status === 403 || climb.status === 404,
    `status ${climb.status}`);

  const through = await getJson('/api/fs/read?root=alpha&path=inner/inner-only.txt');
  check('the containing root still reaches through the nested one, which it owns',
    typeof through.content === 'string' && through.content.startsWith('inner'));

  const short = await getJson('/api/fs/read?root=inner&path=inner-only.txt');
  check('the nested root serves the same file under its own shorter path',
    short.content === through.content && short.root === 'inner');

  // --- writes ----------------------------------------------------------------

  const written = await fetch(`${BASE}/api/fs/write`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: 'beta', path: 'written.txt', content: 'hello' }),
  }).then((r) => r.json());
  check('writes land in the root they name',
    written.root === 'beta' && written.path === 'written.txt');

  const readBack = await getJson('/api/fs/read?root=beta&path=written.txt');
  const notInAlpha = await get('/api/fs/read?root=alpha&path=written.txt');
  check('and only in that root',
    readBack.content === 'hello' && notInAlpha.status === 404,
    `alpha said ${notInAlpha.status}`);

  const escapingWrite = await fetch(`${BASE}/api/fs/write`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: 'inner', path: '../escaped.txt', content: 'x' }),
  });
  check('a write cannot escape the root it names',
    escapingWrite.status === 403 || escapingWrite.status === 404,
    `status ${escapingWrite.status}`);

  // --- git -------------------------------------------------------------------

  const betaStatus = await getJson('/api/git/status?root=beta');
  check('git status answers for the root it was asked about',
    betaStatus.repo === true && betaStatus.root === 'beta');
  check('and sees the file just written into it',
    betaStatus.files?.some((f) => f.path === 'written.txt' && f.untracked));

  const alphaStatus = await getJson('/api/git/status?root=alpha');
  check('a root that is not a repository says so rather than erroring',
    alphaStatus.repo === false && alphaStatus.root === 'alpha' && !!alphaStatus.reason,
    alphaStatus.reason);

  const stage = await fetch(`${BASE}/api/git/stage`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: 'beta', paths: ['written.txt'] }),
  });
  const afterStage = await getJson('/api/git/status?root=beta');
  check('staging acts on the named root',
    stage.status === 200 &&
      afterStage.files?.some((f) => f.path === 'written.txt' && f.staged === 'A'));

  const wrongRoot = await fetch(`${BASE}/api/git/stage`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: 'alpha', paths: ['written.txt'] }),
  });
  check('and refuses in a root with no repository, rather than falling back',
    wrongRoot.status === 400,
    `status ${wrongRoot.status}`);

  // --- sessions --------------------------------------------------------------

  // The name every client reaches for first. If session ids were global, this
  // second attach would hand back the shell running in alpha.
  const alphaMain = await ready('main', 'alpha');
  check('a session reports the root it belongs to', alphaMain.root === 'alpha');

  const betaMain = await ready('main', 'beta');
  check('the same session name in another root is a different shell',
    betaMain.root === 'beta');

  await sleep(1500);
  const sessions = await getJson('/api/sessions');
  const mains = sessions.filter((s) => s.id === 'main');
  check('both exist at once',
    mains.length === 2 && new Set(mains.map((s) => s.root)).size === 2,
    mains.map((s) => `${s.root}/${s.id}`).join(', '));

  check('each shell started in its own directory',
    mains.every((s) => s.cwd.replace(/\\/g, '/').endsWith(`/${s.root}`)),
    mains.map((s) => s.cwd).join(', '));

  // Reattaching without naming a root must not silently move the session.
  const reattached = await ready('main', 'beta');
  check('reattaching keeps the root the session was spawned in',
    reattached.root === 'beta');

  // --- deletion --------------------------------------------------------------

  const deleted = await fetch(`${BASE}/api/sessions/main?root=beta`, {
    method: 'DELETE',
    headers: auth,
  });
  const left = await getJson('/api/sessions');
  check('deleting names a root too, and leaves the other one running',
    deleted.status === 204 &&
      left.filter((s) => s.id === 'main').length === 1 &&
      left.find((s) => s.id === 'main').root === 'alpha',
    left.map((s) => `${s.root}/${s.id}`).join(', '));

  const failed = results.filter((r) => !r.pass);
  console.log();
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
