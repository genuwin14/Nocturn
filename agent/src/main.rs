//! nocturn-agent — the always-on half of Nocturn.
//!
//! Runs on the machine that holds your code (a VM, a home server, a spare box)
//! and exposes its shells and project files over an authenticated WebSocket.
//! Clients attach and detach freely; the shells keep running regardless, which
//! is the whole point: your laptop being asleep stops mattering.

mod auth;
mod fsapi;
mod gitapi;
mod protocol;
mod session;
mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    extract::{Path as AxumPath, State},
    routing::{delete, get, post, put},
    Json, Router,
};
use clap::Parser;
use serde::Serialize;
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};

use session::{SessionInfo, SessionManager};

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<SessionManager>,
    pub token: Arc<String>,
    pub root: Arc<PathBuf>,
}

#[derive(Parser, Debug)]
#[command(
    name = "nocturn-agent",
    version,
    about = "Persistent remote terminal and file daemon for Nocturn"
)]
struct Args {
    /// Address to listen on. Keep the default loopback bind and reach it over
    /// Tailscale or a Cloudflare tunnel rather than exposing a port.
    #[arg(long, default_value = "127.0.0.1:7071", env = "NOCTURN_BIND")]
    bind: SocketAddr,

    /// Project root. Shells start here and the file API cannot escape it.
    #[arg(long, env = "NOCTURN_ROOT")]
    root: Option<PathBuf>,

    /// Access token. Generated and persisted on first run if omitted.
    #[arg(long, env = "NOCTURN_TOKEN", hide_env_values = true)]
    token: Option<String>,

    /// Shell to spawn for new sessions. Defaults to $SHELL, or PowerShell on
    /// Windows.
    #[arg(long, env = "NOCTURN_SHELL")]
    shell: Option<String>,

    /// Serve a built web client from this directory at `/`.
    #[arg(long, env = "NOCTURN_WEB")]
    web: Option<PathBuf>,

    /// Pass ANTHROPIC_API_KEY through to spawned shells. Off by default:
    /// when that variable is set, Claude Code bills at pay-as-you-go API rates
    /// and ignores a Pro or Max subscription entirely.
    #[arg(long)]
    allow_api_key: bool,

    /// The address clients actually reach this daemon at, for the pairing QR
    /// code — e.g. https://vm.tailnet.ts.net. The daemon binds to loopback and
    /// is reached through a tunnel, so it cannot work this out for itself.
    #[arg(long, env = "NOCTURN_PUBLIC_URL")]
    public_url: Option<String>,

    /// Print the pairing QR code and exit, without starting a server. For
    /// adding a device to a daemon that is already running, which is the
    /// common case once it is deployed.
    #[arg(long)]
    pair: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nocturn_agent=info,tower_http=warn".into()),
        )
        .init();

    let args = Args::parse();

    let root = args
        .root
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root = root
        .canonicalize()
        .with_context(|| format!("project root does not exist: {}", root.display()))?;

    let token = match args.token {
        Some(token) => token,
        None => load_or_create_token()?,
    };

    // --pair answers "let me add my phone" without restarting, which would cost
    // every running shell. It reads the same persisted token and exits.
    if args.pair {
        print_pairing(&args.bind, args.public_url.as_deref(), &token);
        return Ok(());
    }

    let shell = resolve_shell(args.shell);

    // Shells start in the drive-letter form, not the canonical one. See
    // `friendly_path`: the two are the same directory, and the difference is
    // only ever visible to a person.
    let shell_root = friendly_path(&root);

    let sessions = Arc::new(SessionManager::new(
        shell.clone(),
        shell_root.clone(),
        !args.allow_api_key,
    ));

    let state = AppState {
        sessions,
        token: Arc::new(token.clone()),
        root: Arc::new(root.clone()),
    };

    let protected = Router::new()
        .route("/ws/terminal", get(ws::terminal_handler))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}", delete(delete_session))
        .route("/api/fs/list", get(fsapi::list))
        .route("/api/fs/read", get(fsapi::read))
        .route("/api/fs/write", put(fsapi::write))
        .route("/api/git/status", get(gitapi::status))
        .route("/api/git/diff", get(gitapi::diff))
        .route("/api/git/stage", post(gitapi::stage))
        .route("/api/git/unstage", post(gitapi::unstage))
        .route("/api/git/discard", post(gitapi::discard))
        .route("/api/git/commit", post(gitapi::commit))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    // Unauthenticated so uptime checks and the client's reachability probe do
    // not need a credential. It reveals nothing beyond "a daemon is here".
    let public = Router::new().route("/health", get(health));

    let mut app = Router::new().merge(public).merge(protected);

    if let Some(web) = args.web.as_ref() {
        // SPA fallback: unknown paths serve index.html so client-side routing
        // survives a hard refresh.
        app = app.fallback_service(
            ServeDir::new(web).not_found_service(ServeDir::new(web).append_index_html_on_directories(true)),
        );
    }

    let app = app
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::very_permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("failed to bind {}", args.bind))?;

    print_banner(&args.bind, &shell_root, &shell, &token, args.allow_api_key);
    print_pairing(&args.bind, args.public_url.as_deref(), &token);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .context("server error")?;

    Ok(())
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn list_sessions(State(state): State<AppState>) -> Json<Vec<SessionInfo>> {
    Json(state.sessions.list().await)
}

async fn delete_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> axum::http::StatusCode {
    if state.sessions.delete(&id).await {
        axum::http::StatusCode::NO_CONTENT
    } else {
        axum::http::StatusCode::NOT_FOUND
    }
}

/// Strips Windows' extended-length `\\?\` prefix for display and for the
/// shell's working directory.
///
/// `canonicalize` returns verbatim paths on Windows. That form is what path
/// confinement needs — it is what `canonicalize` produces for every candidate
/// path, so the root must be in the same form for `starts_with` to mean
/// anything — but it leaks anywhere a person can see it. PowerShell cannot map
/// `\\?\C:\Nocturn` back to a drive, so it renders its prompt provider-
/// qualified: `PS Microsoft.PowerShell.Core\FileSystem::\\?\C:\Nocturn>`.
///
/// So the canonical root stays canonical for `AppState`, and this form is used
/// for the banner and for spawning shells. Same directory either way.
fn friendly_path(path: &PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path.clone();
    }

    let text = path.to_string_lossy();

    // A verbatim UNC path becomes an ordinary one: \\?\UNC\host\share.
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }

    if let Some(rest) = text.strip_prefix(r"\\?\") {
        // Only when a drive letter follows. Verbatim device paths without one
        // have no shorter equivalent, and stripping the prefix would name
        // something else entirely.
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            return PathBuf::from(rest);
        }
    }

    path.clone()
}

/// Picks the shell to spawn, honouring an explicit override first.
fn resolve_shell(explicit: Option<String>) -> Vec<String> {
    if let Some(shell) = explicit {
        // Split on whitespace so `--shell "tmux new -A -s claude"` works. Any
        // shell path containing spaces should be passed via NOCTURN_SHELL as a
        // single token instead.
        let parts: Vec<String> = shell.split_whitespace().map(str::to_string).collect();
        if !parts.is_empty() {
            return parts;
        }
    }

    if cfg!(windows) {
        vec!["powershell.exe".to_string(), "-NoLogo".to_string()]
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        // A login shell picks up the PATH edits that installers like Claude
        // Code's write to .bashrc/.zshrc, which a bare non-interactive spawn
        // would miss.
        vec![shell, "-l".to_string()]
    }
}

/// Returns the persisted token, generating and saving one on first run.
fn load_or_create_token() -> Result<String> {
    let path = token_path()?;

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }

    let token = generate_token();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::write(&path, &token)
        .with_context(|| format!("failed to write {}", path.display()))?;
    restrict_permissions(&path);

    tracing::info!(path = %path.display(), "generated new access token");
    Ok(token)
}

fn token_path() -> Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .context("APPDATA is not set")?
    } else {
        match std::env::var_os("XDG_CONFIG_HOME") {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?)
                .join(".config"),
        }
    };
    Ok(base.join("nocturn").join("agent.token"))
}

fn generate_token() -> String {
    use rand::RngExt;
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Tightens the token file to owner-only. Best effort: a failure here is worth
/// warning about but not worth refusing to start over.
fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(error = %e, "could not restrict token file permissions");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn print_banner(bind: &SocketAddr, root: &std::path::Path, shell: &[String], token: &str, allow_api_key: bool) {
    println!();
    println!("  nocturn-agent {}", env!("CARGO_PKG_VERSION"));
    println!("  listening   http://{bind}");
    println!("  root        {}", root.display());
    println!("  shell       {}", shell.join(" "));
    println!("  token       {token}");
    if allow_api_key {
        println!("  warning     ANTHROPIC_API_KEY passes through; Claude Code will bill at API rates");
    }
    println!();
    println!("  attach:     ws://{bind}/ws/terminal?session=main");
    println!("  health:     curl http://{bind}/health");
    println!();
}

/// Builds the URL a phone scans to pair.
///
/// The token rides in the fragment, not the query string. Fragments are never
/// sent to the server, so it cannot appear in an access log, a proxy log, or a
/// `Referer` header — the same reasoning that keeps the token out of the
/// WebSocket URL. The client clears it from the address bar on load.
fn pairing_url(bind: &SocketAddr, public_url: Option<&str>, token: &str) -> String {
    let base = match public_url {
        Some(url) => url.trim_end_matches('/').to_string(),
        None => format!("http://{bind}"),
    };
    format!("{base}/#pair={token}")
}

/// Renders the pairing URL as a QR code in the terminal.
///
/// Half-block characters rather than an image, so it works over SSH, in a
/// container, and in any terminal that can print Unicode — which is the whole
/// point, since the daemon usually lives on a headless box.
fn print_pairing(bind: &SocketAddr, public_url: Option<&str>, token: &str) {
    use qrcode::render::unicode;
    use qrcode::QrCode;

    let url = pairing_url(bind, public_url, token);

    let Ok(code) = QrCode::new(url.as_bytes()) else {
        // Only fails if the payload exceeds what a QR code can hold, which a
        // URL of this shape cannot. Nothing worth failing startup over.
        return;
    };

    // Colours are swapped on purpose. A scanner wants dark modules on a light
    // ground; a filled block in a terminal paints in the *foreground* colour,
    // which on the dark themes developers overwhelmingly run is the light one.
    // So dark modules are drawn as spaces, showing the dark background through,
    // and light modules as filled blocks. On a light-themed terminal this comes
    // out inverted — many scanners cope, and the URL is printed underneath
    // either way.
    let rendered = code
        .render::<unicode::Dense1x2>()
        .quiet_zone(true)
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .build();

    println!("  scan to pair:");
    println!();
    for line in rendered.lines() {
        println!("  {line}");
    }
    println!();
    println!("  {url}");

    if public_url.is_none() && bind.ip().is_loopback() {
        println!();
        println!("  This points at loopback, so it only works on this machine.");
        println!("  Expose the daemon (tailscale serve --bg {}) and pass", bind.port());
        println!("  --public-url https://your-host to get a code a phone can use.");
    }
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_path_strips_the_verbatim_prefix() {
        // The case that produced a provider-qualified PowerShell prompt.
        let verbatim = PathBuf::from(r"\\?\C:\Nocturn");
        let expected = if cfg!(windows) { r"C:\Nocturn" } else { r"\\?\C:\Nocturn" };
        assert_eq!(friendly_path(&verbatim), PathBuf::from(expected));
    }

    #[test]
    fn pairing_url_uses_the_public_address_when_there_is_one() {
        let bind: SocketAddr = "127.0.0.1:7071".parse().unwrap();
        assert_eq!(
            pairing_url(&bind, Some("https://vm.tailnet.ts.net"), "abc"),
            "https://vm.tailnet.ts.net/#pair=abc"
        );
        // A trailing slash on the flag must not produce a double one.
        assert_eq!(
            pairing_url(&bind, Some("https://vm.tailnet.ts.net/"), "abc"),
            "https://vm.tailnet.ts.net/#pair=abc"
        );
    }

    #[test]
    fn pairing_url_falls_back_to_the_bind_address() {
        let bind: SocketAddr = "127.0.0.1:7071".parse().unwrap();
        assert_eq!(
            pairing_url(&bind, None, "abc"),
            "http://127.0.0.1:7071/#pair=abc"
        );
    }

    #[test]
    fn pairing_url_puts_the_token_in_the_fragment() {
        // The property that keeps it out of access and proxy logs: everything
        // before the '#' is what a server ever sees.
        let bind: SocketAddr = "127.0.0.1:7071".parse().unwrap();
        let url = pairing_url(&bind, Some("https://host"), "secret-token");
        let (sent, fragment) = url.split_once('#').unwrap();
        assert!(!sent.contains("secret-token"));
        assert_eq!(fragment, "pair=secret-token");
    }

    #[test]
    fn a_realistic_pairing_url_fits_in_a_qr_code() {
        // A generated token is 64 hex characters, and a tailnet hostname is
        // long. Encoding has to succeed for the real payload, not just a short
        // one, or the code silently never prints.
        let bind: SocketAddr = "127.0.0.1:7071".parse().unwrap();
        let token = "a".repeat(64);
        let url = pairing_url(&bind, Some("https://nocturn-vm.tail1234abcd.ts.net"), &token);
        assert!(qrcode::QrCode::new(url.as_bytes()).is_ok(), "{url}");
    }

    #[test]
    fn friendly_path_leaves_ordinary_paths_alone() {
        let plain = PathBuf::from(r"C:\Nocturn");
        assert_eq!(friendly_path(&plain), plain);

        let unix = PathBuf::from("/srv/projects");
        assert_eq!(friendly_path(&unix), unix);
    }

    #[cfg(windows)]
    #[test]
    fn friendly_path_shortens_a_verbatim_unc_path() {
        assert_eq!(
            friendly_path(&PathBuf::from(r"\\?\UNC\host\share\proj")),
            PathBuf::from(r"\\host\share\proj")
        );
    }

    #[cfg(windows)]
    #[test]
    fn friendly_path_keeps_device_paths_that_have_no_drive() {
        // No drive letter, so there is no shorter form; stripping the prefix
        // here would name a different thing.
        let device = PathBuf::from(r"\\?\Volume{9f3b2c1a-0000-0000-0000-100000000000}\data");
        assert_eq!(friendly_path(&device), device);
    }
}
