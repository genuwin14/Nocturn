// Drives the built client in headless Chrome at phone dimensions, to confirm
// it mounts, authenticates, attaches a terminal, and renders shell output.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:7071/';
const TOKEN = 'test-token-abc123';
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

  check('no uncaught errors in the console', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
