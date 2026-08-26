//! Bearer token authentication.
//!
//! Three ways to present the token, because the browser WebSocket API cannot
//! set request headers:
//!
//! 1. `Authorization: Bearer <token>` — native clients (Tauri, mobile, curl).
//! 2. `Sec-WebSocket-Protocol: nocturn.v1, bearer.<token>` — browsers. This is
//!    the same trick the Kubernetes API server uses, and keeps the token out of
//!    URLs and therefore out of access logs.
//! 3. `?token=<token>` — last resort for quick testing. Query strings land in
//!    proxy and server logs, so clients should prefer 1 or 2.
//!
//! Whichever transport carried it, the token is resolved against the device
//! store, which owns the constant-time comparison. What arrives downstream is a
//! `Principal` naming which device is calling.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use crate::AppState;

pub const WS_SUBPROTOCOL: &str = "nocturn.v1";
const BEARER_PROTO_PREFIX: &str = "bearer.";

/// Extracts a presented token from a request, checking all three transports.
fn presented_token(req: &Request) -> Option<String> {
    let headers = req.headers();

    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(value) = value.to_str() {
            if let Some(token) = value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
            {
                return Some(token.trim().to_string());
            }
        }
    }

    if let Some(value) = headers.get("sec-websocket-protocol") {
        if let Ok(value) = value.to_str() {
            for proto in value.split(',') {
                if let Some(token) = proto.trim().strip_prefix(BEARER_PROTO_PREFIX) {
                    return Some(token.to_string());
                }
            }
        }
    }

    req.uri().query().and_then(|q| {
        q.split('&').find_map(|pair| {
            pair.strip_prefix("token=")
                .map(|t| percent_decode(t))
        })
    })
}

/// Minimal percent-decoding, enough for tokens in a query string.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}


pub async fn require_token(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let Some(presented) = presented_token(&req) else {
        return Err(StatusCode::UNAUTHORIZED);
    };

    let Some(principal) = state.tokens.verify(&presented).await else {
        tracing::warn!(path = %req.uri().path(), "rejected request with bad token");
        return Err(StatusCode::FORBIDDEN);
    };

    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
        .unwrap_or_default();
    state.tokens.touch(&principal, &ip).await;

    // Carried on the request so handlers can attribute what they do — the
    // WebSocket needs it to know which revocation would end its session.
    req.extensions_mut().insert(principal);

    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding_handles_escapes_and_plus() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("trailing%"), "trailing%");
    }
}
