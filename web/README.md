# Nocturn web client

React + xterm.js. This is the client for all three targets: the browser now, and
the same bundle inside a Tauri webview for desktop and mobile later. Building it
once is why the renderer is a webview rather than a native terminal per platform.

## Build and serve

```bash
npm install
npm run build          # -> dist/

# serve it from the daemon
nocturn-agent --root /srv/projects --web /path/to/web/dist
```

Then open the daemon's address and paste the token. Served this way the client
defaults its origin to wherever the page came from, so only the token is needed.

For development against a running daemon:

```bash
npm run dev            # http://localhost:5173
```

The daemon sends permissive CORS headers, so the dev server can talk to it
cross-origin. Enter the daemon's full address in the setup screen.

## Layout

| File | |
|---|---|
| `api.ts` | REST + WebSocket access, connection persistence |
| `Terminal.tsx` | xterm.js, socket lifecycle, reconnect, geometry |
| `KeyBar.tsx` | on-screen keys phones do not have |
| `Files.tsx` | file browser and CodeMirror editor |
| `Sessions.tsx` | session list, switching, deletion |
| `Setup.tsx` | first-run connection form |

## Decisions worth knowing

**The key bar is the mobile terminal.** No soft keyboard has Esc, Tab, Ctrl or
arrows, and without them you cannot exit vim, complete a path, interrupt a
build, or reach shell history. Ctrl is offered two ways on purpose: arming the
modifier works with a hardware keyboard, where key events are reliable, while
soft keyboards often report composition events instead of real keydowns — so the
explicit `^C`/`^D`/`^Z` combinations are the path that always works on a phone.

**Key presses use `pointerdown`, not `click`.** A click moves focus off the
terminal and dismisses the on-screen keyboard between every keystroke.

**Pasting asks first when the shell cannot be trusted with newlines.** Paste
goes through xterm's own `paste()`, which wraps the text in bracketed-paste
markers — but only when the shell has enabled that mode, and PSReadLine over
ConPTY never does. Measured on the wire, a two-line paste to a PowerShell
session arrives as `echo A\recho B` and both commands run immediately.

So a multi-line paste into a shell that has not enabled the mode is confirmed
before it is sent, naming how many lines will execute. Bash and zsh do enable
it, so there the paste lands on the command line and no prompt appears. The
check is on the mode rather than on the platform, so a session running bash on
the same Windows host behaves correctly without a special case.

**Reconnect clears the terminal first.** The daemon replays its scrollback on
every attach, so repainting from a clean screen shows the true remote state.
Appending instead would stack a second copy of everything below the first.

**Tabs toggle `visibility`, not `display`.** A `display: none` terminal has no
box, so xterm's fit computes zero and every tab switch would need a resize round
trip. Keeping the box means switching tabs is free.

**The viewport height comes from `visualViewport`.** The on-screen keyboard
shrinks the visual viewport without changing the layout viewport, so `100dvh`
alone leaves the key bar stranded behind the keyboard.

**CodeMirror is lazy-loaded.** It is about two thirds of the bundle and only the
Files tab needs it. Splitting it keeps the initial load at ~149 KB gzipped
instead of ~363 KB — which matters when the app is opened over a phone
connection.

## Browser tests

Drives the built client in headless Chrome at iPhone dimensions and screenshots
each step. Uses the system Chrome via `puppeteer-core`, so there is no browser
download.

```bash
# with a daemon running on 127.0.0.1:7071 with --token test-token-abc123
# and --web pointed at this dist/
npm run test:browser
```

It asserts the app mounts, the token is accepted, the socket reaches
`connected`, the shell renders output, a typed command executes, the key bar
renders, Ctrl arms, the file browser lists the root, the editor opens a file, and
the console stays clean. Screenshots land in `tests/shots/`.

Update `CHROME` at the top of `tests/browser.mjs` if Chrome is not at the default
Windows path.

## Not done yet

- Adding a session from the sheet only switches to the name; it is created
  lazily on attach, which works but gives no feedback if the shell fails to
  spawn.
- No diff view. Reviewing what Claude changed before committing is the obvious
  next feature, and more valuable on a phone than the editor is.
- No hunk-level staging. Files stage and unstage whole; splitting a file into
  hunks is the next thing the Review tab wants.
