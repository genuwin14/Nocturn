# 0006. Mobile clipboard paste

Status: Proposed

## Context

There is no paste button. The web README records this as blocked on iOS Safari
refusing clipboard reads without a user gesture bound to a real element.

That framing is worth revisiting, because the constraint it describes is
satisfiable rather than prohibitive: a real `<button>` with a `pointerdown` or
`click` handler calling `navigator.clipboard.readText()` *is* a user gesture
bound to a real element. Safari prompts the first time and remembers the
choice. What does not work is reading the clipboard on load, on focus, or from
a synthetic event — none of which is what a paste button does.

Pasting is the most common input on a phone. The realistic uses are an error
message from somewhere else, a URL, a file path, an API key, a chunk of code
to feed the agent. Every one of them is currently blocked, and the alternative
is retyping the content on a soft keyboard — which for a stack trace is not an
alternative at all.

The key bar in [KeyBar.tsx](../../web/src/KeyBar.tsx) already established the
pattern this needs: it uses `pointerdown` rather than `click` precisely
because a click moves focus off the terminal and dismisses the keyboard
between every keystroke.

## Decision

Add a paste key to the key bar, and bracketed paste support.

The key calls `navigator.clipboard.readText()` and sends the result to the
PTY. Because the terminal is xterm.js and the shell may be anything, the text
is wrapped in bracketed paste markers (`ESC [ 200 ~` … `ESC [ 201 ~`) when the
terminal reports the mode as enabled. Without those markers, pasting anything
containing a newline into a shell executes each line as it arrives, which
turns a mis-paste into a series of commands rather than a line you can edit.

Paste uses `click`, not the `pointerdown` the other keys use. Safari's gesture
requirement for clipboard access is satisfied by a click; the focus cost that
made `pointerdown` right for character keys does not apply to a one-shot
action.

Two fallbacks, because clipboard permission can be denied outright:

- If `readText` rejects, show a one-line text field that the OS paste menu
  works in normally, and send its contents on submit.
- Long-pressing the paste key opens that field directly, for anyone who
  prefers seeing what they are about to paste.

Copy is the other half and is easier: xterm.js already exposes the selection,
so a copy key writes `terminal.getSelection()` via `navigator.clipboard.
writeText()`.

## Consequences

Removes the app's worst input limitation for a small amount of code.

Bracketed paste is the part that must not be skipped. Pasting a multi-line
snippet without it runs every line, and doing that from a phone into a shell
sitting on a production host is precisely the fat-fingered-tap-on-a-train
failure the top-level README worries about.

Clipboard permission is per-origin and remembered, so the prompt appears once.
Denied permanently, the fallback field still works, so the feature degrades
rather than disappearing.

Reading the clipboard is a real privilege — it may hold something from another
app entirely. It is only ever read in response to a deliberate press, never
speculatively, and the contents are sent to the PTY and not retained.
