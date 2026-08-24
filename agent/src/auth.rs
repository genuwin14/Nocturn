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

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use subtle::ConstantTimeEq;

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

/// Compares in constant time so that a caller cannot recover the token one
/// byte at a time by measuring how long a rejection takes.
fn token_matches(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    // `ct_eq` requires equal lengths; comparing lengths first leaks only the
    // length, which is fixed and public.
    expected.len() == presented.len() && expected.ct_eq(presented).into()
}

pub async fn require_token(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    match presented_token(&req) {
        Some(token) if token_matches(&state.token, &token) => Ok(next.run(req).await),
        Some(_) => {
            tracing::warn!(path = %req.uri().path(), "rejected request with bad token");
            Err(StatusCode::FORBIDDEN)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_compare_matches_only_exact_tokens() {
        assert!(token_matches("hunter2", "hunter2"));
        assert!(!token_matches("hunter2", "hunter3"));
        assert!(!token_matches("hunter2", "hunter22"));
        assert!(!token_matches("hunter2", ""));
    }

    #[test]
    fn percent_decoding_handles_escapes_and_plus() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("trailing%"), "trailing%");
    }
}
