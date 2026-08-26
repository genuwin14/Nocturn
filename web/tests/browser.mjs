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

  await page.waitForFunction(
    () => document.querySelector('.status-dot')?.classList.contains('connected'),
    { timeout: 10000 },
  );
  check('websocket reports connected', true);

  // Give PowerShell time to reach a prompt. xterm answers the cursor-position
  // query itself, which is what unblocks the shell.
  await sleep(4000);

  const promptText = await page.$eval('.xterm-screen', (el) => el.textContent ?? '');
  check('terminal rendered shell output', promptText.trim().length > 0,
    `${promptText.trim().length} chars on screen`);

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

  check('no uncaught errors in the console', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
