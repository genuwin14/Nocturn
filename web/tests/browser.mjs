// Drives the built client in headless Chrome at phone dimensions, to confirm
// it mounts, authenticates, attaches a terminal, and renders shell output.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Overridable the same way the wire suite is, so the tests can run against a
// throwaway daemon on another port rather than requiring the one you are
// actually using to be stopped first.
//   NOCTURN_TEST_URL    default http://127.0.0.1:7071
//   NOCTURN_TEST_TOKEN  default test-token-abc123
const URL = (process.env.NOCTURN_TEST_URL ?? 'http://127.0.0.1:7071').replace(/\/*$/, '/');
const TOKEN = process.env.NOCTURN_TEST_TOKEN ?? 'test-token-abc123';
const OUT = process.argv[2] ?? '.';

// Screenshots land here, and git does not track empty directories — so on a
// fresh clone this path does not exist and every screenshot call would throw.
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  // iPhone 14 Pro logical viewport.
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`uncaught: ${e.message}`));

  // Start from a fresh shell. Sessions survive client disconnects — that is
  // the product's central guarantee — so without this, every run inherits the
  // previous run's scrollback and whatever it left on the command line, and
  // assertions about what is on screen quietly stop meaning anything.
  await fetch(`${URL}api/sessions/main`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).catch(() => {});

  await page.goto(URL, { waitUntil: 'networkidle0' });

  // --- setup screen ---
  const heading = await page.$eval('h1', (el) => el.textContent).catch(() => null);
  check('app mounts and shows the setup screen', heading === 'Nocturn', `h1 = ${heading}`);

  await page.screenshot({ path: `${OUT}/01-setup.png` });

  await page.type('#token', TOKEN);
  await page.click('button[type="submit"]');

  // --- terminal ---
  await page.waitForSelector('.terminal-host', { timeout: 10000 });
  check('connecting advances to the terminal view', true);

  // Once the socket is up the indicator stops reporting the connection and
  // starts reporting what the shell is doing, so reaching any activity class
  // is what "connected" now looks like.
  const ACTIVITY = ['working', 'idle', 'waiting'];
  await page.waitForFunction(
    (states) => {
      const dot = document.querySelector('.status-dot');
      return !!dot && states.some((s) => dot.classList.contains(s));
    },
    { timeout: 10000 },
    ACTIVITY,
  );
  check('websocket reports connected', true);

  // Give PowerShell time to reach a prompt. xterm answers the cursor-position
  // query itself, which is what unblocks the shell.
  await sleep(4000);

  const promptText = await page.$eval('.xterm-screen', (el) => el.textContent ?? '');
  check('terminal rendered shell output', promptText.trim().length > 0,
    `${promptText.trim().length} chars on screen`);

  // --- activity badge ---
  // The daemon's IDLE_AFTER is 3s and the shell has been quiet for at least
  // the 4s above, so it should have settled at its prompt by now.
  //
  // Only the idle case is driven here. Triggering `waiting` needs a
  // shell-specific blocking command, and the wire suite already drives a real
  // blocked prompt on both dialects; the three states render through the same
  // className path, so this covers the rendering.
  const badge = await page.evaluate(() => ({
    dot: document.querySelector('.status-dot')?.className ?? '',
    text: document.querySelector('.status-text')?.textContent ?? '',
    live: document.querySelector('.status-text')?.getAttribute('aria-live') ?? '',
  }));
  check('a settled shell reports idle rather than "Connected"',
    badge.dot.includes('idle') && badge.text.includes('Idle'),
    `dot="${badge.dot.trim()}" text="${badge.text}"`);
  check('the activity indicator is a live region',
    badge.live === 'polite', `aria-live=${badge.live}`);

  await page.screenshot({ path: `${OUT}/02-terminal.png` });

  // --- key bar ---
  const keys = await page.$$eval('.keybar .key', (els) => els.map((e) => e.textContent));
  check('key bar renders Esc/Tab/Ctrl and arrows',
    ['Esc', 'Tab', 'Ctrl', '←', '→'].every((k) => keys.includes(k)),
    `${keys.length} keys`);

  // --- typing ---
  await page.click('.terminal-host');
  await page.keyboard.type('echo NOCTURN_BROWSER_OK');
  await page.keyboard.press('Enter');
  await sleep(2500);

  const afterTyping = await page.$eval('.xterm-screen', (el) => el.textContent ?? '');
  check('typed command echoed and executed',
    (afterTyping.match(/NOCTURN_BROWSER_OK/g) ?? []).length >= 2,
    'expect both the echoed command and its output');

  await page.screenshot({ path: `${OUT}/03-after-command.png` });

  // --- ctrl arming ---
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.keybar .key')].find((b) => b.textContent === 'Ctrl');
    btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  const armed = await page.$eval('.key-mod', (el) => el.classList.contains('armed'));
  check('Ctrl key arms', armed);

  // Disarm, so the paste below is not swallowed as a control character.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.keybar .key')].find((b) => b.textContent === 'Ctrl');
    btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });

  // --- paste ---
  // Chrome refuses navigator.clipboard.readText() without permission, exactly
  // as Safari does, so granting it here exercises the real path rather than
  // the fallback.
  // overridePermissions takes a bare origin; a trailing path silently matches
  // nothing and the grant appears to have worked while every read is refused.
  await browser
    .defaultBrowserContext()
    .overridePermissions(new globalThis.URL(URL).origin, [
      'clipboard-read',
      'clipboard-write',
      'clipboard-sanitized-write',
    ]);

  const pasteKey = await page.$$eval('.keybar .key', (els) =>
    els.some((e) => e.textContent === 'Paste'),
  );
  check('key bar offers a paste key', pasteKey);

  await page.evaluate(() => navigator.clipboard.writeText('NOCTURN_PASTED'));
  await page.click('.terminal-host');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.keybar .key')].find((b) => b.textContent === 'Paste');
    btn?.click();
  });
  await sleep(1200);

  const afterPaste = await page.$eval('.xterm-screen', (el) => el.textContent ?? '');
  check('paste puts the clipboard on the command line',
    afterPaste.includes('NOCTURN_PASTED'),
    afterPaste.includes('NOCTURN_PASTED') ? '' : afterPaste.slice(-60));

  // A multi-line paste into a shell that does not support bracketed paste runs
  // every line the moment it arrives. PSReadLine over ConPTY is exactly that
  // shell, so on Windows this is the normal case rather than an edge one, and
  // the client has to ask before doing it.
  let asked = null;
  page.once('dialog', async (dialog) => {
    asked = dialog.message();
    // Dismiss: refusing must mean nothing reaches the shell at all.
    await dialog.dismiss();
  });

  await page.evaluate(() => navigator.clipboard.writeText('echo LINE_A\necho LINE_B'));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.keybar .key')].find((b) => b.textContent === 'Paste');
    btn?.click();
  });
  await sleep(1500);

  check('a multi-line paste warns before it executes anything',
    asked !== null && /execute/i.test(asked ?? ''),
    asked ? JSON.stringify(asked.split('\n')[0]) : 'no dialog shown');

  const afterMultiline = await page.$eval('.xterm-screen', (el) => el.textContent ?? '');
  check('declining the warning runs nothing',
    !afterMultiline.includes('LINE_A') && !afterMultiline.includes('LINE_B'),
    `LINE_A x${(afterMultiline.match(/LINE_A/g) ?? []).length}`);

  // --- files tab ---
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.tab-bar button')].find((b) => b.textContent === 'Files');
    tab?.click();
  });
  await page.waitForSelector('.file-row', { timeout: 10000 });
  const files = await page.$$eval('.file-name', (els) => els.map((e) => e.textContent));
  check('file browser lists the project root', files.includes('readme.txt'), files.join(', '));

  await page.screenshot({ path: `${OUT}/04-files.png` });

  // --- editor ---
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.file-row')]
      .find((r) => r.textContent?.includes('readme.txt'));
    row?.click();
  });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  const editorText = await page.$eval('.cm-content', (el) => el.textContent ?? '');
  check('editor opens the file with its content',
    editorText.includes('hello from nocturn'), JSON.stringify(editorText.slice(0, 40)));

  await page.screenshot({ path: `${OUT}/05-editor.png` });

  // --- review tab ---
  // Give it something to find. The daemon's own file API is the shortest way
  // to make a change without driving the terminal and waiting on a shell.
  await fetch(`${URL}api/fs/write`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'readme.txt', content: 'hello from nocturn\nreviewed\n' }),
  });

  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.tab-bar button')].find((b) => b.textContent === 'Review');
    tab?.click();
  });

  // Wait for the component itself, not for `.empty` — the Suspense fallback
  // while the chunk loads is also an `.empty`, so matching that would race the
  // real content and read an empty list every time.
  await page.waitForSelector('.review, .tab-panel.active .empty', { timeout: 10000 });
  await page.waitForFunction(
    () => {
      const review = document.querySelector('.review');
      if (!review) return false;
      return (
        review.querySelector('.change-row') !== null ||
        (review.textContent ?? '').includes('Nothing changed') ||
        (review.textContent ?? '').includes('No repository')
      );
    },
    { timeout: 10000 },
  );
  const repoState = await page.evaluate(
    () => document.querySelector('.review')?.textContent ?? '',
  );

  if (!repoState.includes('No repository')) {
    const changed = await page.$$eval('.change-path', (els) => els.map((e) => e.textContent));
    check('review lists the changed file', changed.some((p) => p?.includes('readme.txt')),
      changed.join(', '));

    const counts = await page.$$eval('.change-count', (els) => els.map((e) => e.textContent));
    check('review shows a change size for triage',
      counts.some((c) => /[+−]\d/.test(c ?? '') || c === 'new'), counts.join(', '));

    await page.screenshot({ path: `${OUT}/06-review-list.png` });

    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.change-row')]
        .find((r) => r.textContent?.includes('readme.txt'));
      row?.click();
    });
    await page.waitForSelector('.diff-line', { timeout: 10000 });

    const diff = await page.evaluate(() => ({
      added: [...document.querySelectorAll('.diff-line.add')].map((e) => e.textContent),
      hunks: document.querySelectorAll('.diff-line.hunk').length,
    }));
    check('the diff renders added lines and a hunk header',
      diff.added.some((l) => l?.includes('reviewed')) && diff.hunks > 0,
      `${diff.added.length} additions, ${diff.hunks} hunks`);

    await page.screenshot({ path: `${OUT}/07-review-diff.png` });

    // Staging is the one round trip worth driving: it proves the client and
    // daemon agree on the shape, and that the list re-reads afterwards.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.review-actions button')]
        .find((b) => b.textContent === 'Stage');
      btn?.click();
    });
    await page.waitForFunction(
      () => !![...document.querySelectorAll('.review-actions button')]
        .find((b) => b.textContent === 'Unstage'),
      { timeout: 10000 },
    );
    check('staging a file flips it to unstageable', true);

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.review-actions button')]
        .find((b) => b.textContent === 'Unstage');
      btn?.click();
    });
    await page.waitForFunction(
      () => !![...document.querySelectorAll('.review-actions button')]
        .find((b) => b.textContent === 'Stage'),
      { timeout: 10000 },
    );
    check('unstaging puts it back', true);
  } else {
    console.log('SKIP  review checks — the daemon root is not a git repository');
  }

  // Put readme.txt back. These checks are the only ones here that mutate the
  // root, and leaving it dirty makes the wire suite's "fs read returns file
  // content" fail depending on which ran last — a test that breaks another
  // test by running is worse than no test.
  await fetch(`${URL}api/fs/write`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'readme.txt', content: 'hello from nocturn\n' }),
  });

  // --- devices ---
  await page.evaluate(() => {
    document.querySelector('.session-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForSelector('.sheet', { timeout: 10000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.sheet-footer button')]
      .find((b) => b.textContent === 'Devices');
    btn?.click();
  });
  await page.waitForSelector('.device-list, .minted', { timeout: 10000 });

  const deviceNames = await page.$$eval('.device-name', (els) =>
    els.map((e) => e.textContent ?? ''),
  );
  check('the device list loads', Array.isArray(deviceNames), deviceNames.join(', '));

  // Minting has to hand back a scannable code and say the secret is shown once
  // — the daemon keeps only a hash, so a client that hides it strands the user.
  await page.type('.new-session input', 'browser-test-device');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.new-session button')]
      .find((b) => b.textContent === 'Add');
    btn?.click();
  });
  await page.waitForSelector('.minted-qr', { timeout: 10000 });

  const mintedQr = await page.$eval('.minted-qr', (el) => el.getAttribute('src') ?? '');
  check('adding a device shows a scannable code',
    mintedQr.startsWith('data:image/svg+xml') && mintedQr.includes('svg'),
    `${mintedQr.length} bytes`);

  const mintedText = await page.$eval('.minted', (el) => el.textContent ?? '');
  check('and warns the secret is shown only once',
    /only time/i.test(mintedText), JSON.stringify(mintedText.slice(0, 60)));

  await page.screenshot({ path: `${OUT}/08-devices.png` });

  // Back to the list, and clean up what this test created.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.minted-actions button')]
      .find((b) => b.textContent === 'Done');
    btn?.click();
  });
  await page.waitForSelector('.device-list', { timeout: 10000 });

  const listed = await page.$$eval('.device-name', (els) => els.map((e) => e.textContent ?? ''));
  check('the new device appears in the list',
    listed.some((n) => n.includes('browser-test-device')), listed.join(', '));

  // Revoke it through the UI, confirming the dialog this time.
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.device-list li')]
      .find((li) => li.textContent?.includes('browser-test-device'));
    row?.querySelector('.icon-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.device-name')]
      .some((e) => e.textContent?.includes('browser-test-device')),
    { timeout: 10000 },
  );
  check('revoking removes it from the list', true);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.sheet-header button')]
      .find((b) => b.textContent === 'Done');
    btn?.click();
  });

  // --- pairing by scanned link ---
  // What a phone does after scanning the daemon's QR code: arrive with the
  // token in the fragment, and land in the terminal without a setup screen.
  const paired = await browser.newPage();
  try {
    await paired.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true });
    const pairErrors = [];
    paired.on('pageerror', (e) => pairErrors.push(e.message));

    await paired.goto(`${URL}#pair=${TOKEN}`, { waitUntil: 'networkidle0' });
    await paired.waitForSelector('.terminal-host', { timeout: 10000 });
    check('a scanned pairing link connects without the setup screen', true);

    // The token must not be left sitting in visible browser chrome, where it
    // survives into screenshots and browser history.
    const url = paired.url();
    check('the pairing fragment is cleared from the address bar',
      !url.includes('pair=') && !url.includes(TOKEN), url);

    const stored = await paired.evaluate(() => localStorage.getItem('nocturn.connection'));
    check('the scanned connection is remembered',
      !!stored && JSON.parse(stored).token === TOKEN,
      stored ? 'stored' : 'nothing stored');

    check('no uncaught errors on the paired page', pairErrors.length === 0,
      pairErrors.slice(0, 2).join(' | '));
  } finally {
    await paired.close();
  }

  check('no uncaught errors in the console', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
