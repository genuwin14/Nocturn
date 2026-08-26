//! Wire protocol for the terminal WebSocket.
//!
//! Binary frames carry raw PTY bytes in both directions (no framing overhead,
//! xterm.js writes them straight through). Text frames carry JSON control
//! messages, defined here.

use serde::{Deserialize, Serialize};

use crate::session::Activity;

/// Control messages sent by the client.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Terminal geometry changed. Sent on attach and on every rotate/resize.
    Resize { cols: u16, rows: u16 },
    /// Liveness probe; mobile clients send this after returning to foreground.
    Ping,
}

/// Control messages sent by the server.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Sent once, immediately after the scrollback replay frame.
    Ready {
        session: String,
        cols: u16,
        rows: u16,
        /// Bytes of scrollback replayed just before this message.
        replayed: usize,
        /// False when attaching to a session whose child already exited.
        alive: bool,
        /// Whether the shell is working, idle, or blocked on input. Sent here
        /// so a reattaching client knows without waiting for a transition.
        state: Activity,
    },
    /// The shell moved between working, idle, and waiting. Travels in the same
    /// channel as output, so it can never overtake the bytes that caused it.
    State {
        state: Activity,
        /// Unix seconds at which this state was entered.
        since: u64,
        /// Last non-empty line of output, ANSI stripped and truncated. Lets a
        /// client show *what* is being waited on rather than only that
        /// something is. Empty for `working`.
        tail: String,
    },
    /// The child process exited. The session stays in the table (with its
    /// scrollback intact) until explicitly deleted.
    Exit { code: i32 },
    Pong,
    Error { message: String },
}

impl ServerMsg {
    pub fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"type":"error","message":"failed to serialize server message"}"#.to_string()
        })
    }
}
