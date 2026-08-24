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
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::{broadcast, RwLock};

/// How much output we retain per session for replay on reattach. Enough for a
/// few screens of build output without letting an idle session that is printing
/// logs grow without bound.
const SCROLLBACK_BYTES: usize = 256 * 1024;

/// Output chunks buffered per attached client before it is considered lagging.
const BROADCAST_CAP: usize = 2048;

/// One item in a session output stream. `Exit` travels in the same channel as
/// the data so it can never overtake output the child produced first.
#[derive(Clone, Debug)]
pub enum Chunk {
    Data(Bytes),
    Exit(i32),
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

pub struct Session {
    pub id: String,
    pub created_at: u64,
    pub command: String,
    pub cwd: String,
    fanout: Mutex<Fanout>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    size: Mutex<(u16, u16)>,
    exit_code: Mutex<Option<i32>>,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub created_at: u64,
    pub command: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub scrollback_bytes: usize,
}

impl Session {
    fn spawn(
        id: String,
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
            created_at: unix_now(),
            command: command.join(" "),
            cwd: cwd.to_string_lossy().into_owned(),
            fanout: Mutex::new(Fanout {
                tx,
                scrollback: Scrollback::new(SCROLLBACK_BYTES),
            }),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            size: Mutex::new((cols, rows)),
            exit_code: Mutex::new(None),
        });

        session.clone().start_reader(reader);
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

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
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
        if let Ok(mut size) = self.size.lock() {
            *size = (cols, rows);
        }
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
            created_at: self.created_at,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            cols,
            rows,
            alive: self.is_alive(),
            exit_code: self.exit_code(),
            scrollback_bytes,
        }
    }
}

pub struct SessionManager {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    shell: Vec<String>,
    root: PathBuf,
    scrub_api_key: bool,
}

impl SessionManager {
    pub fn new(shell: Vec<String>, root: PathBuf, scrub_api_key: bool) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            shell,
            root,
            scrub_api_key,
        }
    }

    /// Attaches to an existing session or spawns a new one. A session whose
    /// child has exited is returned as-is rather than respawned, so the client
    /// can still read the output that led to the exit; delete it to start over.
    pub async fn get_or_create(&self, id: &str, cols: u16, rows: u16) -> Result<Arc<Session>> {
        if let Some(existing) = self.sessions.read().await.get(id) {
            return Ok(existing.clone());
        }

        let mut sessions = self.sessions.write().await;
        // Another attach may have created it while we waited for the write lock.
        if let Some(existing) = sessions.get(id) {
            return Ok(existing.clone());
        }

        let session = Session::spawn(
            id.to_string(),
            self.shell.clone(),
            self.root.clone(),
            cols,
            rows,
            self.scrub_api_key,
        )?;
        tracing::info!(session = %id, command = %session.command, "session started");
        sessions.insert(id.to_string(), session.clone());
        Ok(session)
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        let mut out: Vec<SessionInfo> = sessions.values().map(|s| s.info()).collect();
        out.sort_by_key(|s| s.created_at);
        out
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.read().await.get(id).cloned()
    }

    /// Kills the child if it is still running and drops the session, discarding
    /// its scrollback. Reconnecting with the same id then starts a fresh shell.
    pub async fn delete(&self, id: &str) -> bool {
        let removed = self.sessions.write().await.remove(id);
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
