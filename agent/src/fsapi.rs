//! Project file browsing and editing.
//!
//! Every path in this module is resolved against one of the daemon's configured
//! roots and canonicalized before use, so `..` segments and symlinks that point
//! outside that tree are rejected rather than followed. The terminal has no such
//! confinement by design — this API is for the file browser, which is the
//! surface a stolen phone would reach first.
//!
//! Requests name a root with `root=`; leaving it off means the first one, which
//! is what every single-root client already sends. Confinement is unchanged in
//! kind by there being several: each request resolves against exactly one root,
//! and cannot reach another by traversal even where they are nested.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::{extract::{Query, State}, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::AppState;

/// Largest file the editor will load. Big enough for source files, small enough
/// that a stray `cat` of a database dump cannot exhaust the daemon's memory.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// Bytes inspected when deciding whether a file is text.
const SNIFF_BYTES: usize = 8192;

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
    /// Which root the path is relative to. Absent means the default one.
    #[serde(default)]
    root: Option<String>,
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    /// Always relative to the root, using forward slashes on every platform so
    /// clients can treat paths uniformly.
    path: String,
    kind: EntryKind,
    size: u64,
    modified: u64,
}

#[derive(Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct Listing {
    /// Echoed so a client that omitted it still learns which root it reached,
    /// and so a late response cannot be mistaken for one about another root.
    root: String,
    path: String,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
pub struct FileContent {
    root: String,
    path: String,
    content: String,
    size: u64,
    /// True when the file was longer than `MAX_READ_BYTES` and only its head is
    /// returned. Clients must refuse to save a truncated buffer back.
    truncated: bool,
}

#[derive(Deserialize)]
pub struct WriteRequest {
    #[serde(default)]
    root: Option<String>,
    path: String,
    content: String,
}

#[derive(Serialize)]
pub struct WriteResponse {
    root: String,
    path: String,
    bytes: usize,
}

pub type ApiError = (StatusCode, Json<ErrorBody>);

#[derive(Serialize, Debug)]
pub struct ErrorBody {
    error: String,
}

/// Shared with `gitapi`, so both surfaces answer failures in the same shape.
pub(crate) fn err(status: StatusCode, message: impl Into<String>) -> ApiError {
    (
        status,
        Json(ErrorBody {
            error: message.into(),
        }),
    )
}

/// Resolves a client-supplied path against the root, refusing anything that
/// escapes it.
///
/// `must_exist` is false for writes, where the file itself may be new; in that
/// case the parent directory is canonicalized instead and must already be
/// inside the root.
fn resolve(root: &Path, requested: &str, must_exist: bool) -> Result<PathBuf, ApiError> {
    let candidate = Path::new(requested);

    // Reject anything absolute before touching it. This has to run first and
    // has to test components rather than `is_absolute`, for two reasons:
    //
    // - Stripping leading separators first would make the check unreachable on
    //   Unix, silently reinterpreting `/etc/passwd` as `<root>/etc/passwd`. Safe,
    //   but it answers a different question than the caller asked, and it made
    //   the same input behave differently on Linux and Windows.
    // - `Path::is_absolute` is false for `/foo` on Windows, since that form has
    //   no drive prefix. `RootDir` catches it on both platforms.
    //
    // `Path::join` would discard the root entirely for any of these.
    if candidate
        .components()
        .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "paths must be relative to the project root",
        ));
    }

    let joined = root.join(candidate);

    let canonical = if must_exist {
        joined
            .canonicalize()
            .map_err(|_| err(StatusCode::NOT_FOUND, "no such path"))?
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid path"))?;
        let parent = parent
            .canonicalize()
            .map_err(|_| err(StatusCode::NOT_FOUND, "parent directory does not exist"))?;
        let name = joined
            .file_name()
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid path"))?;
        parent.join(name)
    };

    // The comparison happens after canonicalization, so a symlink pointing out
    // of the tree fails here even though its own path looked contained.
    if !canonical.starts_with(root) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "path escapes the project root",
        ));
    }

    Ok(canonical)
}

/// Renders a resolved path back as a root-relative, forward-slashed string.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Listing>, ApiError> {
    let root = state.roots.require(query.root.as_deref())?;
    let dir = resolve(&root.path, &query.path, true)?;
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("cannot list: {e}")))?;

    let mut entries = Vec::new();
    while let Ok(Some(item)) = read_dir.next_entry().await {
        let Ok(meta) = item.metadata().await else {
            continue;
        };
        let kind = if meta.is_dir() {
            EntryKind::Dir
        } else if meta.is_symlink() {
            EntryKind::Symlink
        } else {
            EntryKind::File
        };
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: relative(&root.path, &item.path()),
            kind,
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
    }

    // Directories first, then alphabetical — the order a file tree is read in.
    entries.sort_by(|a, b| match (&a.kind, &b.kind) {
        (EntryKind::Dir, EntryKind::Dir) => a.name.cmp(&b.name),
        (EntryKind::Dir, _) => std::cmp::Ordering::Less,
        (_, EntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(Json(Listing {
        root: root.name.clone(),
        path: relative(&root.path, &dir),
        entries,
    }))
}

pub async fn read(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<FileContent>, ApiError> {
    let root = state.roots.require(query.root.as_deref())?;
    let path = resolve(&root.path, &query.path, true)?;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, format!("cannot stat: {e}")))?;

    if meta.is_dir() {
        return Err(err(StatusCode::BAD_REQUEST, "path is a directory"));
    }

    let size = meta.len();
    let truncated = size > MAX_READ_BYTES;
    let bytes = if truncated {
        use tokio::io::AsyncReadExt;
        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, format!("cannot open: {e}")))?;
        let mut buf = vec![0u8; MAX_READ_BYTES as usize];
        let read = file
            .read(&mut buf)
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, format!("cannot read: {e}")))?;
        buf.truncate(read);
        buf
    } else {
        tokio::fs::read(&path)
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, format!("cannot read: {e}")))?
    };

    if bytes.iter().take(SNIFF_BYTES).any(|&b| b == 0) {
        return Err(err(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "file appears to be binary",
        ));
    }

    let content = String::from_utf8(bytes).map_err(|_| {
        err(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "file is not valid UTF-8",
        )
    })?;

    Ok(Json(FileContent {
        root: root.name.clone(),
        path: relative(&root.path, &path),
        content,
        size,
        truncated,
    }))
}

pub async fn write(
    State(state): State<AppState>,
    Json(request): Json<WriteRequest>,
) -> Result<Json<WriteResponse>, ApiError> {
    let root = state.roots.require(request.root.as_deref())?;
    let path = resolve(&root.path, &request.path, false)?;
    let bytes = request.content.len();

    tokio::fs::write(&path, request.content.as_bytes())
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("cannot write: {e}")))?;

    tracing::info!(root = %root.name, path = %relative(&root.path, &path), bytes, "file written");

    Ok(Json(WriteResponse {
        root: root.name.clone(),
        path: relative(&root.path, &path),
        bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir()
            .canonicalize()
            .expect("temp dir must canonicalize")
    }

    #[test]
    fn traversal_out_of_root_is_rejected() {
        let root = root();
        assert!(resolve(&root, "../etc/passwd", false).is_err());
        assert!(resolve(&root, "a/../../../etc/passwd", false).is_err());
    }

    /// Absolute paths must be refused identically on every platform, and with
    /// 400 rather than 404 — the request is malformed, not merely missing.
    #[test]
    fn absolute_paths_are_rejected() {
        let root = root();
        for input in [
            "/etc/passwd",
            "C:\\Windows\\System32",
            "C:/Windows/System32",
            "\\\\server\\share",
            "\\Windows",
        ] {
            let (status, _) = resolve(&root, input, false).expect_err(input);
            assert_eq!(status, StatusCode::BAD_REQUEST, "wrong status for {input}");
        }
    }

    #[test]
    fn plain_relative_paths_resolve_inside_root() {
        let root = root();
        let resolved = resolve(&root, "notes.txt", false).expect("should resolve");
        assert!(resolved.starts_with(&root));
        assert!(resolved.ends_with("notes.txt"));
    }

    /// Two roots side by side. Naming one must not let a path climb into the
    /// other, which `..` would do freely if confinement were only "inside some
    /// root" rather than "inside the root this request named".
    #[test]
    fn one_root_cannot_be_reached_by_traversing_out_of_another() {
        let base = root().join("nocturn-siblings-test");
        let api = base.join("api");
        let web = base.join("web");
        std::fs::create_dir_all(&api).unwrap();
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("secret.txt"), "s").unwrap();

        let api = api.canonicalize().unwrap();
        assert!(resolve(&api, "../web/secret.txt", true).is_err());
        assert!(resolve(&api, "../web", true).is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    /// Nested roots are legitimate — serving a monorepo and one package inside
    /// it is a reasonable thing to want. The narrow root must stay narrow even
    /// though the wide one contains it, and the wide one must still reach the
    /// files the narrow one holds, because it genuinely owns them.
    #[test]
    fn nested_roots_each_keep_their_own_boundary() {
        let base = root().join("nocturn-nested-test");
        let outer = base.join("mono");
        let inner = outer.join("packages/ui");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(outer.join("root-only.txt"), "r").unwrap();
        std::fs::write(inner.join("card.tsx"), "c").unwrap();

        let outer = outer.canonicalize().unwrap();
        let inner = inner.canonicalize().unwrap();

        // The inner root cannot climb into the part of the monorepo above it.
        assert!(resolve(&inner, "../../root-only.txt", true).is_err());
        // But the outer one reaches through the inner, which is inside it.
        let reached = resolve(&outer, "packages/ui/card.tsx", true).expect("outer owns it");
        assert!(reached.starts_with(&outer));
        // And the inner root serves its own file under a shorter path.
        assert!(resolve(&inner, "card.tsx", true).is_ok());

        std::fs::remove_dir_all(&base).ok();
    }
}
