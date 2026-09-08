//! Persistent PTY sessions.
//!
//! The central design rule: a `Session` owns its PTY and the thread reading
//! from it. WebSocket connections attach to and detach from a session, but
//! never own it. Closing the app, losing wifi, or the phone killing the
//! process in the background therefore has no effect on the running shell.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::{broadcast, RwLock};

use crate::roots::Roots;

/// How much output we retain per session for replay on reattach. Enough for a
/// few screens of build output without letting an idle session that is printing
/// logs grow without bound.
const SCROLLBACK_BYTES: usize = 256 * 1024;

/// Output chunks buffered per attached client before it is considered lagging.
const BROADCAST_CAP: usize = 2048;

/// Silence after which a session stops counting as working. Long enough that a
/// compiler pausing to think does not flip the state, short enough that being
/// told a run finished still feels immediate.
const IDLE_AFTER: Duration = Duration::from_secs(3);

/// How often the activity monitor re-checks a session. Only a clock comparison
/// unless the state actually changes, so this can be frequent and cheap.
const ACTIVITY_POLL: Duration = Duration::from_millis(250);

/// How much of the scrollback tail the prompt heuristic inspects. A prompt is
/// the last line; this is generous room for the escape sequences colouring it.
const TAIL_BYTES: usize = 512;

/// Cap on the tail reported to clients, in characters.
const TAIL_CHARS: usize = 200;

/// What a session is doing, inferred from its output stream.
///
/// Deliberately advisory. Every value here is a *guess* made by a heuristic
/// that can be wrong on an unusual prompt, so it drives labels and
/// notifications and nothing else. Nothing destructive is ever gated on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    /// Producing output, or has done so within `IDLE_AFTER`.
    Working,
    /// Quiet, and the last line looks like a shell prompt.
    Idle,
    /// Quiet, and the last line does not look like a prompt — so something is
    /// probably blocked waiting for an answer. This is the state worth
    /// interrupting someone for: an agent stopped on a permission prompt looks
    /// exactly like one still thinking, and nothing moves until a person acts.
    Waiting,
}

/// One item in a session output stream. `Exit` and `State` travel in the same
/// channel as the data so they can never overtake output the child produced
/// first — a "finished" that arrives before the last line of a build would be
/// worse than no signal at all.
#[derive(Clone, Debug)]
pub enum Chunk {
    Data(Bytes),
    Exit(i32),
    State {
        state: Activity,
        since: u64,
        tail: String,
    },
}

/// Byte ring buffer holding the tail of a session's output.
struct Scrollback {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Scrollback {
    fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
        }
    }

    fn push(&mut self, data: &[u8]) {
        // A single write larger than the buffer can only ever leave its tail.
        let data = if data.len() > self.cap {
            &data[data.len() - self.cap..]
        } else {
            data
        };
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        self.buf.drain(..overflow);
        self.buf.extend(data);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    /// The last `n` bytes, for the prompt heuristic. May split a UTF-8
    /// sequence at the front; the caller decodes lossily, which costs at most
    /// a replacement character well before the last line.
    fn tail(&self, n: usize) -> Vec<u8> {
        let start = self.buf.len().saturating_sub(n);
        self.buf.iter().skip(start).copied().collect()
    }
}

/// Output fan-out state. Kept behind a single mutex so a client attaching
/// cannot race the reader thread: the reader appends to the scrollback and
/// broadcasts inside one critical section, while an attaching client subscribes
/// and snapshots inside another. Whichever runs first, the client sees every
/// byte exactly once, with no gap and no duplicate.
struct Fanout {
    tx: broadcast::Sender<Chunk>,
    scrollback: Scrollback,
}

/// Activity tracking, kept in its own mutex rather than folded into `Fanout`.
///
/// Two paths touch it — the reader thread on every chunk, and the monitor
/// thread on a timer — and both need to broadcast when the state changes.
/// Keeping it separate means neither ever holds this lock and the fanout lock
/// at once, so no lock ordering has to be reasoned about.
struct ActivityState {
    state: Activity,
    since: u64,
    last_output: Instant,
}

pub struct Session {
    pub id: String,
    /// Name of the root this session was started in. Fixed for its lifetime —
    /// the shell can `cd` anywhere, but which project it belongs to is decided
    /// once, when it is spawned.
    pub root: String,
    pub created_at: u64,
    pub command: String,
    pub cwd: String,
    fanout: Mutex<Fanout>,
    activity: Mutex<ActivityState>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    size: Mutex<(u16, u16)>,
    exit_code: Mutex<Option<i32>>,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub root: String,
    pub created_at: u64,
    pub command: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub scrollback_bytes: usize,
    /// Lets the session list distinguish a shell that is working from one
    /// sitting at a prompt without attaching a socket to each.
    pub state: Activity,
}

impl Session {
    fn spawn(
        id: String,
        root: String,
        command: Vec<String>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        scrub_api_key: bool,
    ) -> Result<Arc<Self>> {
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| anyhow!("failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(&command[0]);
        for arg in &command[1..] {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("NOCTURN_SESSION", &id);
        cmd.env("NOCTURN_ROOT_NAME", &root);

        // Claude Code bills at pay-as-you-go API rates whenever this variable is
        // present, silently ignoring a Pro or Max subscription. The daemon owns
        // the child's environment, so the safe default is to drop it.
        if scrub_api_key {
            cmd.env_remove("ANTHROPIC_API_KEY");
            cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to spawn {:?}", command))?;
        // The slave handle must be dropped or the master never sees EOF when the
        // child exits, and the reader thread would hang forever.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("failed to clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow!("failed to take pty writer: {e}"))?;

        let (tx, _) = broadcast::channel(BROADCAST_CAP);

        let session = Arc::new(Session {
            id: id.clone(),
            root,
            created_at: unix_now(),
            command: command.join(" "),
            cwd: cwd.to_string_lossy().into_owned(),
            fanout: Mutex::new(Fanout {
                tx,
                scrollback: Scrollback::new(SCROLLBACK_BYTES),
            }),
            // A shell starts by printing its prompt, so working is the honest
            // opening state; the monitor settles it a few seconds later.
            activity: Mutex::new(ActivityState {
                state: Activity::Working,
                since: unix_now(),
                last_output: Instant::now(),
            }),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            size: Mutex::new((cols, rows)),
            exit_code: Mutex::new(None),
        });

        session.clone().start_reader(reader);
        session.clone().start_activity_monitor();
        Ok(session)
    }

    /// Pumps PTY output into the scrollback and out to every attached client,
    /// then reaps the child. Owned by the session, so it keeps running with
    /// zero clients attached.
    fn start_reader(self: Arc<Self>, mut reader: Box<dyn Read + Send>) {
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        if let Ok(mut fanout) = self.fanout.lock() {
                            fanout.scrollback.push(chunk);
                            // An error here only means nobody is attached.
                            let _ = fanout.tx.send(Chunk::Data(Bytes::copy_from_slice(chunk)));
                        }
                        // After the data is broadcast, so a state message can
                        // never precede the output that triggered it.
                        self.mark_output();
                    }
                    Err(e) => {
                        // On Unix the master read fails with EIO once the last
                        // slave fd closes. That is a normal end of session.
                        tracing::debug!(session = %self.id, error = %e, "pty read ended");
                        break;
                    }
                }
            }

            let code = self
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .map(|s| s.exit_code() as i32)
                .unwrap_or(-1);

            if let Ok(mut slot) = self.exit_code.lock() {
                *slot = Some(code);
            }
            if let Ok(fanout) = self.fanout.lock() {
                let _ = fanout.tx.send(Chunk::Exit(code));
            }
            tracing::info!(session = %self.id, code, "session exited");
        });
    }

    /// Records that the child produced output, returning the session to
    /// `Working` and broadcasting if that is a change.
    ///
    /// The transition is decided under the activity lock and broadcast after
    /// it is released, so this never holds two locks at once.
    fn mark_output(&self) {
        let changed = match self.activity.lock() {
            Ok(mut activity) => {
                activity.last_output = Instant::now();
                if activity.state == Activity::Working {
                    None
                } else {
                    activity.state = Activity::Working;
                    activity.since = unix_now();
                    Some(activity.since)
                }
            }
            Err(_) => None,
        };

        if let Some(since) = changed {
            // No tail for `working`: the client is already receiving the
            // output live, so repeating a line of it in a control message
            // would be noise.
            self.broadcast_state(Activity::Working, since, String::new());
        }
    }

    /// Watches for the child falling quiet. The reader thread only wakes when
    /// there is output, so nothing else can notice that output *stopped* —
    /// which is exactly the event worth reporting.
    fn start_activity_monitor(self: Arc<Self>) {
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(ACTIVITY_POLL);

                // The exit chunk already tells clients what happened, and a
                // dead session has no activity to report.
                if !self.is_alive() {
                    break;
                }

                let due = match self.activity.lock() {
                    Ok(activity) => {
                        activity.state == Activity::Working
                            && activity.last_output.elapsed() >= IDLE_AFTER
                    }
                    Err(_) => false,
                };
                if !due {
                    continue;
                }

                // Classified outside the activity lock, since it takes the
                // fanout lock to read the scrollback tail.
                let tail = self.tail_line();
                let next = if looks_like_prompt(&tail) {
                    Activity::Idle
                } else {
                    Activity::Waiting
                };

                // Re-check under the lock: output may have arrived while the
                // tail was being read, which makes this transition stale.
                let committed = match self.activity.lock() {
                    Ok(mut activity) => {
                        if activity.state == Activity::Working
                            && activity.last_output.elapsed() >= IDLE_AFTER
                        {
                            activity.state = next;
                            activity.since = unix_now();
                            Some(activity.since)
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                };

                if let Some(since) = committed {
                    tracing::debug!(session = %self.id, state = ?next, "activity changed");
                    self.broadcast_state(next, since, tail);
                }
            }
        });
    }

    fn broadcast_state(&self, state: Activity, since: u64, tail: String) {
        if let Ok(fanout) = self.fanout.lock() {
            // An error here only means nobody is attached. The state is still
            // recorded, so `/api/sessions` and the next `ready` report it.
            let _ = fanout.tx.send(Chunk::State { state, since, tail });
        }
    }

    /// The last non-empty line of output, ANSI stripped and truncated.
    fn tail_line(&self) -> String {
        let raw = match self.fanout.lock() {
            Ok(fanout) => fanout.scrollback.tail(TAIL_BYTES),
            Err(_) => return String::new(),
        };
        last_line(&String::from_utf8_lossy(&raw), TAIL_CHARS)
    }

    pub fn activity(&self) -> Activity {
        self.activity
            .lock()
            .map(|a| a.state)
            .unwrap_or(Activity::Working)
    }

    /// Subscribes to live output and takes a scrollback snapshot atomically.
    pub fn attach(&self) -> (broadcast::Receiver<Chunk>, Vec<u8>) {
        let fanout = self.fanout.lock().expect("fanout mutex poisoned");
        let rx = fanout.tx.subscribe();
        let replay = fanout.scrollback.snapshot();
        (rx, replay)
    }

    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock().map_err(|_| anyhow!("writer poisoned"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    /// Resizes the PTY, ignoring a resize to the size it already has.
    ///
    /// The no-op case is not hypothetical and not free. Every client sends its
    /// geometry on attach, so a second device attaching, or the same one
    /// reconnecting after a dropped socket, arrives with the size already in
    /// effect. On Windows that still reaches `ResizePseudoConsole`, and ConPTY
    /// answers *any* resize by repainting its entire viewport — cursor home,
    /// every row rewritten, the cursor put back. Those bytes are output like
    /// any other: they land in the scrollback that every future reattach
    /// replays, and they go out to every client already attached, redrawing a
    /// screen nobody touched. Dropping the no-op keeps the stream honest.
    ///
    /// The size lock is held across the PTY call so two clients resizing at
    /// once cannot both decide they are the change. Nothing else takes the
    /// master lock, so this is the only place the two are held together and
    /// there is no ordering to get wrong.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let mut size = self.size.lock().map_err(|_| anyhow!("size poisoned"))?;
        if *size == (cols, rows) {
            return Ok(());
        }
        {
            let master = self.master.lock().map_err(|_| anyhow!("master poisoned"))?;
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| anyhow!("resize failed: {e}"))?;
        }
        *size = (cols, rows);
        Ok(())
    }

    pub fn size(&self) -> (u16, u16) {
        self.size.lock().map(|s| *s).unwrap_or((80, 24))
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code.lock().ok().and_then(|c| *c)
    }

    pub fn is_alive(&self) -> bool {
        self.exit_code().is_none()
    }

    pub fn kill(&self) -> Result<()> {
        let mut child = self.child.lock().map_err(|_| anyhow!("child poisoned"))?;
        child.kill()?;
        Ok(())
    }

    pub fn info(&self) -> SessionInfo {
        let (cols, rows) = self.size();
        let scrollback_bytes = self.fanout.lock().map(|f| f.scrollback.buf.len()).unwrap_or(0);
        SessionInfo {
            id: self.id.clone(),
            root: self.root.clone(),
            created_at: self.created_at,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            cols,
            rows,
            alive: self.is_alive(),
            exit_code: self.exit_code(),
            scrollback_bytes,
            state: self.activity(),
        }
    }
}

/// Removes ANSI escape sequences, so the prompt heuristic sees the text a
/// person would see rather than the colour codes around it.
///
/// Handles the three forms that actually appear in a prompt: CSI (`ESC [` …
/// final byte in `@`–`~`), OSC (`ESC ]` … `BEL` or `ESC \`, which is how
/// shells set the window title), and two-character escapes. Anything else is
/// passed through — this only has to be good enough to find a trailing `$`.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();

    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameter and intermediate bytes, then one final byte.
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                // Runs to BEL or a string terminator (ESC \).
                let mut prev_esc = false;
                for c in chars.by_ref() {
                    if c == '\x07' || (prev_esc && c == '\\') {
                        break;
                    }
                    prev_esc = c == '\x1b';
                }
            }
            // A two-character escape; the second character is consumed above.
            Some(_) | None => {}
        }
    }

    out
}

/// The last non-empty line of `text`, ANSI stripped and truncated to `max`
/// characters. Carriage returns are treated as line breaks so a progress bar
/// redrawing in place reports its current text rather than every frame.
fn last_line(text: &str, max: usize) -> String {
    let plain = strip_ansi(text);
    let line = plain
        .split(['\n', '\r'])
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();

    if line.chars().count() > max {
        line.chars().take(max).collect()
    } else {
        line.to_string()
    }
}

/// Whether a line looks like a shell prompt waiting for a command.
///
/// Crude on purpose: the last visible character is one of the four characters
/// that conventionally end a prompt. It is wrong on a prompt ending in an
/// emoji, and wrong on output that happens to end in `>`. Both are acceptable,
/// because the only cost is a mislabelled badge — nothing is gated on this.
fn looks_like_prompt(line: &str) -> bool {
    matches!(
        line.trim_end().chars().last(),
        Some('$') | Some('#') | Some('>') | Some('%')
    )
}

pub struct SessionManager {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    shell: Vec<String>,
    roots: Arc<Roots>,
    scrub_api_key: bool,
}

/// Sessions are keyed by root and id together, so `main` means one shell per
/// project rather than one shell shared between them — which is the name every
/// client reaches for first, and would otherwise put you in whichever project
/// happened to open it.
///
/// Unambiguous because a root name can contain no `/`: `Roots` rejects one at
/// startup. So the first segment is always the root and the rest is the id,
/// however many slashes the id itself has.
fn key(root: &str, id: &str) -> String {
    format!("{root}/{id}")
}

impl SessionManager {
    pub fn new(shell: Vec<String>, roots: Arc<Roots>, scrub_api_key: bool) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            shell,
            roots,
            scrub_api_key,
        }
    }

    /// Attaches to an existing session or spawns a new one. A session whose
    /// child has exited is returned as-is rather than respawned, so the client
    /// can still read the output that led to the exit; delete it to start over.
    ///
    /// `root` names which project the session belongs to, and only matters when
    /// one is being created — an existing session keeps the root it was spawned
    /// in. Absent means the default root, which is what a client that has never
    /// heard of roots sends.
    pub async fn get_or_create(
        &self,
        id: &str,
        root: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Session>> {
        // Resolved first: naming a root that does not exist is a bad request,
        // not a reason to spawn a shell somewhere else.
        let root = self.roots.require_named(root)?;
        let key = key(&root.name, id);

        if let Some(existing) = self.sessions.read().await.get(&key) {
            return Ok(existing.clone());
        }

        let mut sessions = self.sessions.write().await;
        // Another attach may have created it while we waited for the write lock.
        if let Some(existing) = sessions.get(&key) {
            return Ok(existing.clone());
        }

        let session = Session::spawn(
            id.to_string(),
            root.name.clone(),
            self.shell.clone(),
            root.display.clone(),
            cols,
            rows,
            self.scrub_api_key,
        )?;
        tracing::info!(
            session = %id,
            root = %root.name,
            command = %session.command,
            "session started"
        );
        sessions.insert(key, session.clone());
        Ok(session)
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        let mut out: Vec<SessionInfo> = sessions.values().map(|s| s.info()).collect();
        out.sort_by_key(|s| s.created_at);
        out
    }

    pub async fn get(&self, id: &str, root: Option<&str>) -> Option<Arc<Session>> {
        let root = self.roots.require_named(root).ok()?;
        self.sessions.read().await.get(&key(&root.name, id)).cloned()
    }

    /// Kills the child if it is still running and drops the session, discarding
    /// its scrollback. Reconnecting with the same id then starts a fresh shell.
    pub async fn delete(&self, id: &str, root: Option<&str>) -> bool {
        let Ok(root) = self.roots.require_named(root) else {
            return false;
        };
        let removed = self.sessions.write().await.remove(&key(&root.name, id));
        match removed {
            Some(session) => {
                if session.is_alive() {
                    if let Err(e) = session.kill() {
                        tracing::warn!(session = %id, error = %e, "kill failed");
                    }
                }
                true
            }
            None => false,
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_colour_and_title_sequences() {
        assert_eq!(strip_ansi("\x1b[32muser@host\x1b[0m:~$ "), "user@host:~$ ");
        // OSC 0 sets the window title and ends with BEL.
        assert_eq!(strip_ansi("\x1b]0;a title\x07done"), "done");
        // The same, terminated by ESC \ instead.
        assert_eq!(strip_ansi("\x1b]0;a title\x1b\\done"), "done");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn last_line_ignores_trailing_blank_lines_and_redraws() {
        assert_eq!(last_line("one\ntwo\n\n", 200), "two");
        // A progress bar redraws with carriage returns; only the current text
        // matters, not the frames before it.
        assert_eq!(last_line("building\r50%\r100%", 200), "100%");
        assert_eq!(last_line("", 200), "");
    }

    #[test]
    fn last_line_truncates_to_the_cap() {
        let long = "x".repeat(500);
        assert_eq!(last_line(&long, 10).chars().count(), 10);
    }

    #[test]
    fn prompts_are_recognised_across_shells() {
        assert!(looks_like_prompt("user@host:~/app$"));
        assert!(looks_like_prompt("user@host:~/app$ "));
        assert!(looks_like_prompt("root@host:/#"));
        assert!(looks_like_prompt("PS C:\\Nocturn>"));
        assert!(looks_like_prompt("nocturn %"));
    }

    #[test]
    fn a_question_is_not_a_prompt() {
        // The case the `waiting` state exists for: an agent blocked on a
        // permission request must not be reported as idle at a prompt.
        assert!(!looks_like_prompt("Allow edit to src/main.rs? [y/n]"));
        assert!(!looks_like_prompt("Overwrite? (y/N)"));
        assert!(!looks_like_prompt("Password:"));
        assert!(!looks_like_prompt(""));
    }

    #[test]
    fn a_coloured_prompt_is_still_a_prompt() {
        // End to end through both helpers, since this is how a real prompt
        // arrives: colour codes around it and a reset sequence after the $.
        let raw = "\x1b[1;32muser@host\x1b[0m:\x1b[1;34m~/app\x1b[0m$ ";
        assert!(looks_like_prompt(&last_line(raw, TAIL_CHARS)));
    }

    #[test]
    fn scrollback_tail_returns_the_end() {
        let mut sb = Scrollback::new(64);
        sb.push(b"hello world");
        assert_eq!(sb.tail(5), b"world");
        // Asking for more than is held returns everything, not a panic.
        assert_eq!(sb.tail(1000), b"hello world");
    }
}
