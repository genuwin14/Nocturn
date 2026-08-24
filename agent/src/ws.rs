//! Terminal WebSocket endpoint.
//!
//! Attach with `GET /ws/terminal?session=main&cols=120&rows=40`. The connection
//! is a view onto a session, never its owner: dropping it leaves the shell
//! running, and reattaching replays the scrollback so the client picks up
//! exactly where it left off.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use bytes::Bytes;
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};

use crate::auth::WS_SUBPROTOCOL;
use crate::protocol::{ClientMsg, ServerMsg};
use crate::session::{Chunk, Session};
use crate::AppState;

/// Interval between server-initiated pings. Mobile networks and reverse proxies
/// drop idle connections aggressively; this keeps the socket warm.
const KEEPALIVE: Duration = Duration::from_secs(30);

/// Outbound control messages queued by the reader task for the writer task,
/// which is the only task holding the sink half of the socket.
const OUTBOUND_CAP: usize = 32;

#[derive(Deserialize)]
pub struct AttachParams {
    #[serde(default = "default_session")]
    session: String,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}

fn default_session() -> String {
    "main".to_string()
}
fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

pub async fn terminal_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AttachParams>,
    State(state): State<AppState>,
) -> Response {
    // Browsers send the token as a subprotocol, and the handshake fails unless
    // the server selects one of the offered protocols. Echoing our own marker
    // protocol satisfies that without echoing the token back.
    ws.protocols([WS_SUBPROTOCOL])
        .on_upgrade(move |socket| async move {
            if let Err(e) = run(socket, params, state).await {
                tracing::warn!(error = %e, "terminal socket ended with error");
            }
        })
}

async fn run(socket: WebSocket, params: AttachParams, state: AppState) -> anyhow::Result<()> {
    let session = state
        .sessions
        .get_or_create(&params.session, params.cols, params.rows)
        .await?;

    // The attaching client's geometry wins, so a phone rotating to landscape
    // reflows the shell that a desktop client sized moments earlier.
    if session.is_alive() {
        let _ = session.resize(params.cols, params.rows);
    }

    let (mut ws_tx, ws_rx) = socket.split();
    let (rx, replay) = session.attach();
    let replayed = replay.len();

    if replayed > 0 {
        ws_tx.send(Message::Binary(Bytes::from(replay))).await?;
    }

    let (cols, rows) = session.size();
    let ready = ServerMsg::Ready {
        session: session.id.clone(),
        cols,
        rows,
        replayed,
        alive: session.is_alive(),
    };
    ws_tx.send(Message::Text(ready.json().into())).await?;

    // A session that already exited still replays its scrollback above, so the
    // client can read whatever killed it, then learns the exit code.
    if let Some(code) = session.exit_code() {
        ws_tx
            .send(Message::Text(ServerMsg::Exit { code }.json().into()))
            .await?;
    }

    tracing::info!(
        session = %session.id,
        replayed,
        "client attached"
    );

    let (out_tx, out_rx) = mpsc::channel::<Message>(OUTBOUND_CAP);

    let mut writer = tokio::spawn(pump_output(ws_tx, rx, out_rx));
    let mut reader = tokio::spawn(pump_input(session.clone(), ws_rx, out_tx));

    // Whichever half finishes first, tear down the other. The session itself is
    // untouched by this: it keeps running with no clients attached.
    tokio::select! {
        _ = &mut writer => reader.abort(),
        _ = &mut reader => writer.abort(),
    }

    tracing::info!(session = %session.id, "client detached");
    Ok(())
}

/// Owns the sink half of the socket. Merges three sources: live PTY output,
/// control messages from the reader task, and its own keepalive timer.
async fn pump_output(
    mut ws_tx: futures_util::stream::SplitSink<WebSocket, Message>,
    mut rx: broadcast::Receiver<Chunk>,
    mut out_rx: mpsc::Receiver<Message>,
) {
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.tick().await; // the first tick resolves immediately

    loop {
        let message = tokio::select! {
            chunk = rx.recv() => match chunk {
                Ok(Chunk::Data(data)) => Message::Binary(data),
                Ok(Chunk::Exit(code)) => Message::Text(ServerMsg::Exit { code }.json().into()),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // The client could not keep up with a burst of output. It
                    // has a hole in its stream; say so rather than pretending
                    // the terminal state is intact.
                    tracing::warn!(skipped, "client lagged, output dropped");
                    Message::Text(
                        ServerMsg::Error {
                            message: format!("output dropped: {skipped} chunks skipped"),
                        }
                        .json()
                        .into(),
                    )
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            queued = out_rx.recv() => match queued {
                Some(message) => message,
                None => break,
            },
            _ = keepalive.tick() => Message::Ping(Bytes::new()),
        };

        if ws_tx.send(message).await.is_err() {
            break;
        }
    }

    let _ = ws_tx.close().await;
}

/// Owns the stream half of the socket. Binary frames are raw keystrokes and go
/// straight to the PTY; text frames are JSON control messages.
async fn pump_input(
    session: Arc<Session>,
    mut ws_rx: futures_util::stream::SplitStream<WebSocket>,
    out_tx: mpsc::Sender<Message>,
) {
    while let Some(Ok(message)) = ws_rx.next().await {
        match message {
            Message::Binary(data) => {
                if let Err(e) = session.write_input(&data) {
                    tracing::warn!(session = %session.id, error = %e, "pty write failed");
                    break;
                }
            }
            // Some clients find it easier to send plain text for typed input.
            // Anything that does not parse as a control message is treated as
            // keystrokes, which keeps `wscat`-style manual testing usable.
            Message::Text(text) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Resize { cols, rows }) => {
                    if let Err(e) = session.resize(cols, rows) {
                        tracing::warn!(session = %session.id, error = %e, "resize failed");
                    }
                }
                Ok(ClientMsg::Ping) => {
                    if out_tx
                        .send(Message::Text(ServerMsg::Pong.json().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    if let Err(e) = session.write_input(text.as_bytes()) {
                        tracing::warn!(session = %session.id, error = %e, "pty write failed");
                        break;
                    }
                }
            },
            Message::Close(_) => break,
            // Pongs answer our keepalive; axum replies to client pings itself.
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}
