//! Git review endpoints.
//!
//! Enough git to answer "what did the agent just change, and do I want to keep
//! it" from a phone. Deliberately not a git client: there is no push, no
//! branching, no merge conflict resolution, because none of those are things
//! anyone wants to attempt on a touchscreen.
//!
//! Every path is validated the same way the file API validates its own, and
//! the repository top level must sit inside the root the request named. A root
//! that is a *subdirectory* of a larger repository is refused rather than
//! served, since git reports and operates on paths relative to the repository
//! top level, which in that arrangement would reach outside the root the token
//! is supposed to be confined to.
//!
//! Status is per-root, so every endpoint here takes the same optional `root`
//! the file API does. A daemon serving three projects has three answers to
//! "what changed", and the request has to say which one it is asking about.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::fsapi::{err, ApiError};
use crate::AppState;

/// Largest diff returned in one response. A generated-file diff can run to tens
/// of megabytes, which is not something a phone browser should be handed.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct RepoStatus {
    /// Which root this describes, echoed so a client switching roots can drop
    /// an answer that arrived for the previous one.
    root: String,
    /// False when the root is not a usable repository. Everything else is then
    /// empty and `reason` says why, so the client can hide the tab rather than
    /// render an error.
    repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    ahead: i64,
    behind: i64,
    files: Vec<FileStatus>,
}

#[derive(Serialize)]
pub struct FileStatus {
    path: String,
    /// Set for renames and copies, where git reports both ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    /// Index status as a porcelain code — M, A, D, R, C, T, or "." for
    /// unchanged. Passed through rather than translated, because the letters
    /// are what every other git tool shows and inventing new names would only
    /// make the two disagree.
    staged: String,
    /// Working tree status, same alphabet.
    unstaged: String,
    untracked: bool,
    conflicted: bool,
    /// Lines added and removed against HEAD, staged and unstaged combined —
    /// which is what "what changed since the last commit" means to someone
    /// reviewing. Absent for untracked files, which have nothing to diff
    /// against, and for binary files, which have no line counts at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    removed: Option<u64>,
    binary: bool,
}

#[derive(Serialize)]
pub struct Diff {
    /// Empty when nothing differs, which is not an error.
    patch: String,
    /// True when the patch was longer than `MAX_DIFF_BYTES` and was cut at a
    /// line boundary. Clients must not offer to apply or stage from a
    /// truncated patch.
    truncated: bool,
    staged: bool,
}

/// Every endpoint here takes the root it acts on; absent means the default.
#[derive(Deserialize)]
pub struct RootQuery {
    #[serde(default)]
    root: Option<String>,
}

#[derive(Deserialize)]
pub struct DiffQuery {
    #[serde(default)]
    root: Option<String>,
    /// Restricts the diff to one path. Empty means the whole worktree.
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
}

#[derive(Deserialize)]
pub struct PathsRequest {
    #[serde(default)]
    root: Option<String>,
    paths: Vec<String>,
}

#[derive(Deserialize)]
pub struct CommitRequest {
    #[serde(default)]
    root: Option<String>,
    message: String,
}

#[derive(Serialize)]
pub struct CommitResponse {
    sha: String,
    summary: String,
}

#[derive(Serialize)]
pub struct PathsResponse {
    paths: Vec<String>,
}

/// Validates a client-supplied git path lexically.
///
/// Deliberately does not touch the filesystem, unlike the file API's resolver:
/// a staged deletion names a path that no longer exists, and refusing to stage
/// deletions would be an odd hole in a review tool. Rejecting absolute paths
/// and any `..` that climbs above the root is enough, because git itself only
/// ever operates relative to the repository top level, which is checked
/// separately to be inside the root.
fn git_path(requested: &str) -> Result<String, ApiError> {
    let candidate = Path::new(requested);

    if candidate
        .components()
        .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "paths must be relative to the project root",
        ));
    }

    let mut depth = 0i32;
    let mut parts: Vec<String> = Vec::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                depth += 1;
                parts.push(part.to_string_lossy().into_owned());
            }
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(err(
                        StatusCode::FORBIDDEN,
                        "path escapes the project root",
                    ));
                }
                parts.pop();
            }
            // A bare `.` contributes nothing; prefix and root are refused above.
            _ => {}
        }
    }

    if parts.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "empty path"));
    }

    Ok(parts.join("/"))
}

/// Runs git in the repository and returns its stdout.
async fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, ApiError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        // A git subcommand that decides to prompt — for credentials, or an
        // editor — would otherwise hang the request forever.
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                err(
                    StatusCode::NOT_IMPLEMENTED,
                    "git is not installed on this host",
                )
            } else {
                err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to run git: {e}"),
                )
            }
        })?;

    if !output.status.success() {
        // git's own message is more useful than anything this layer could
        // invent — "nothing to commit", "please tell me who you are", and so
        // on are exactly what the person needs to read.
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(err(
            StatusCode::BAD_REQUEST,
            if message.is_empty() {
                "git command failed".to_string()
            } else {
                message
            },
        ));
    }

    Ok(output.stdout)
}

/// Locates the repository top level, or explains why there is not a usable one.
///
/// The `Err` here is a reason string rather than an API error: "not a
/// repository" is a normal answer for `/status` to report, not a failure.
async fn locate_repo(root: &Path) -> Result<PathBuf, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git is not installed on this host".to_string()
            } else {
                format!("failed to run git: {e}")
            }
        })?;

    if !output.status.success() {
        return Err("the project root is not a git repository".to_string());
    }

    let top = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let top = PathBuf::from(&top)
        .canonicalize()
        .map_err(|_| "the repository top level could not be resolved".to_string())?;

    // The confinement check. Serving a repository rooted above us would mean
    // reporting, diffing, and restoring files outside the root — which is
    // precisely the boundary the file API spends its effort maintaining.
    if !top.starts_with(root) {
        return Err(
            "the project root is inside a repository whose top level is outside it".to_string(),
        );
    }

    Ok(top)
}

/// Resolves the repository or fails the request. For the endpoints that act,
/// where there being no repository is a real error rather than a status.
async fn require_repo(root: &Path) -> Result<PathBuf, ApiError> {
    locate_repo(root)
        .await
        .map_err(|reason| err(StatusCode::BAD_REQUEST, reason))
}

/// Whether a root has a usable repository, for the root listing. Answers the
/// same question `status` does, without the cost of a full status read — the
/// listing only needs to know whether the Review tab is worth offering.
pub(crate) async fn is_repo(root: &Path) -> bool {
    locate_repo(root).await.is_ok()
}

pub async fn status(
    State(state): State<AppState>,
    Query(query): Query<RootQuery>,
) -> Result<Json<RepoStatus>, ApiError> {
    let root = state.roots.require(query.root.as_deref())?;
    let top = match locate_repo(&root.path).await {
        Ok(top) => top,
        Err(reason) => {
            return Ok(Json(RepoStatus {
                root: root.name.clone(),
                repo: false,
                reason: Some(reason),
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                files: Vec::new(),
            }))
        }
    };

    // Porcelain v2 rather than v1: it reports branch and upstream as structured
    // headers instead of a line needing its own parser, and `-z` keeps paths
    // with spaces or quotes intact instead of shell-quoting them.
    let raw = git(
        &top,
        &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
    )
    .await?;

    let mut status = parse_status(&raw);
    status.root = root.name.clone();

    // Change sizes, so the list can be triaged without opening every file —
    // on a phone, knowing which of fourteen changes is the big one is most of
    // the value. Against HEAD, so staged and unstaged are counted together.
    //
    // Best effort: a repository with no commits has no HEAD to diff against,
    // and a status without counts is far better than no status at all.
    if let Ok(raw) = git(&top, &["diff", "HEAD", "--numstat", "-z"]).await {
        apply_numstat(&mut status, &raw);
    }

    Ok(Json(status))
}

/// Merges `git diff --numstat -z` counts into an already-parsed status.
///
/// Records are `<added>\t<removed>\t<path>` terminated by NUL. A rename leaves
/// the path field empty and follows with two more NUL fields, the source and
/// destination — the destination is the one the status list is keyed by.
/// Binary files report `-` for both counts rather than a number.
fn apply_numstat(status: &mut RepoStatus, data: &[u8]) {
    let text = String::from_utf8_lossy(data);
    let fields: Vec<&str> = text.split('\0').collect();

    let mut i = 0;
    while i < fields.len() {
        let record = fields[i];
        i += 1;

        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };

        let path = if path.is_empty() {
            // A rename: skip the source, take the destination.
            let destination = fields.get(i + 1).copied().unwrap_or("");
            i += 2;
            destination
        } else {
            path
        };

        let Some(file) = status.files.iter_mut().find(|f| f.path == path) else {
            continue;
        };

        if added == "-" || removed == "-" {
            file.binary = true;
        } else {
            file.added = added.parse().ok();
            file.removed = removed.parse().ok();
        }
    }
}

/// Parses `git status --porcelain=v2 -z` output.
///
/// Records are NUL-terminated. Within a record, fields are space-separated and
/// the path is always last, so it is taken as the remainder rather than split
/// on — paths containing spaces are ordinary, not an edge case. A rename record
/// is followed by a *second* NUL field holding the original path, which is why
/// this indexes rather than iterating.
fn parse_status(data: &[u8]) -> RepoStatus {
    let text = String::from_utf8_lossy(data);
    let fields: Vec<&str> = text.split('\0').filter(|f| !f.is_empty()).collect();

    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut files = Vec::new();

    let mut i = 0;
    while i < fields.len() {
        let field = fields[i];
        i += 1;

        if let Some(header) = field.strip_prefix("# ") {
            if let Some(value) = header.strip_prefix("branch.head ") {
                // Detached heads report "(detached)"; surfaced as-is, since
                // that is what the person needs to know.
                branch = Some(value.to_string());
            } else if let Some(value) = header.strip_prefix("branch.upstream ") {
                upstream = Some(value.to_string());
            } else if let Some(value) = header.strip_prefix("branch.ab ") {
                for part in value.split_whitespace() {
                    if let Some(n) = part.strip_prefix('+') {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        // Ordinary change: <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        if let Some(rest) = field.strip_prefix("1 ") {
            if let Some((xy, path)) = split_record(rest, 8) {
                files.push(file_status(xy, path, None, false));
            }
            continue;
        }

        // Rename or copy, with one extra field before the path, and the
        // original path in the following NUL record.
        if let Some(rest) = field.strip_prefix("2 ") {
            if let Some((xy, path)) = split_record(rest, 9) {
                let original = fields.get(i).map(|s| s.to_string());
                i += 1;
                files.push(file_status(xy, path, original, false));
            }
            continue;
        }

        // Unmerged, with three stages of hashes rather than two.
        if let Some(rest) = field.strip_prefix("u ") {
            if let Some((xy, path)) = split_record(rest, 10) {
                files.push(file_status(xy, path, None, true));
            }
            continue;
        }

        if let Some(path) = field.strip_prefix("? ") {
            files.push(FileStatus {
                path: path.to_string(),
                original_path: None,
                staged: ".".to_string(),
                unstaged: ".".to_string(),
                untracked: true,
                conflicted: false,
                added: None,
                removed: None,
                binary: false,
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));

    RepoStatus {
        // Filled in by the caller, which is the only side that knows which
        // root it asked about. The parser sees porcelain output and nothing
        // else, and `discard` uses it purely for its file list.
        root: String::new(),
        repo: true,
        reason: None,
        branch,
        upstream,
        ahead,
        behind,
        files,
    }
}

/// Splits a porcelain v2 record into its XY code and its trailing path.
///
/// `fields` is the total field count for the record type; everything after the
/// first `fields - 1` is the path, spaces included.
fn split_record(rest: &str, fields: usize) -> Option<(&str, &str)> {
    let mut parts = rest.splitn(fields, ' ');
    let xy = parts.next()?;
    let path = parts.nth(fields - 2)?;
    if path.is_empty() {
        return None;
    }
    Some((xy, path))
}

fn file_status(
    xy: &str,
    path: &str,
    original_path: Option<String>,
    conflicted: bool,
) -> FileStatus {
    let mut chars = xy.chars();
    let staged = chars.next().unwrap_or('.');
    let unstaged = chars.next().unwrap_or('.');
    FileStatus {
        path: path.to_string(),
        original_path,
        staged: staged.to_string(),
        unstaged: unstaged.to_string(),
        untracked: false,
        conflicted,
        added: None,
        removed: None,
        binary: false,
    }
}

pub async fn diff(
    State(state): State<AppState>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<Diff>, ApiError> {
    let root = state.roots.require(query.root.as_deref())?;
    let top = require_repo(&root.path).await?;

    let path = if query.path.is_empty() {
        None
    } else {
        Some(git_path(&query.path)?)
    };

    // `--no-ext-diff` because a repository can configure an external diff
    // driver, and running whatever a .gitattributes names is not something an
    // endpoint should do on its own.
    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if query.staged {
        args.push("--cached");
    }
    if let Some(path) = path.as_deref() {
        args.push("--");
        args.push(path);
    }

    let raw = git(&top, &args).await?;
    let (patch, truncated) = truncate_patch(&raw);

    Ok(Json(Diff {
        patch,
        truncated,
        staged: query.staged,
    }))
}

/// Cuts an oversized patch at the last complete line within the cap, so a
/// client never has to render half a hunk header.
fn truncate_patch(raw: &[u8]) -> (String, bool) {
    if raw.len() <= MAX_DIFF_BYTES {
        return (String::from_utf8_lossy(raw).into_owned(), false);
    }

    let head = &raw[..MAX_DIFF_BYTES];
    let cut = head
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(head.len());

    (String::from_utf8_lossy(&head[..cut]).into_owned(), true)
}

/// Validates the requested paths and hands them to a git subcommand.
async fn run_on_paths(
    state: &AppState,
    root: Option<&str>,
    requested: &[String],
    leading: &[&str],
) -> Result<Json<PathsResponse>, ApiError> {
    let root = state.roots.require(root)?;
    let top = require_repo(&root.path).await?;

    if requested.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "no paths given"));
    }

    let paths = requested
        .iter()
        .map(|p| git_path(p))
        .collect::<Result<Vec<_>, _>>()?;

    let mut args: Vec<&str> = leading.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));

    git(&top, &args).await?;
    Ok(Json(PathsResponse { paths }))
}

pub async fn stage(
    State(state): State<AppState>,
    Json(request): Json<PathsRequest>,
) -> Result<Json<PathsResponse>, ApiError> {
    run_on_paths(&state, request.root.as_deref(), &request.paths, &["add"]).await
}

pub async fn unstage(
    State(state): State<AppState>,
    Json(request): Json<PathsRequest>,
) -> Result<Json<PathsResponse>, ApiError> {
    // `reset` rather than `restore --staged`: it behaves the same here and also
    // works in a repository with no commits yet, where there is no HEAD to
    // restore from.
    run_on_paths(
        &state,
        request.root.as_deref(),
        &request.paths,
        &["reset", "--quiet"],
    )
    .await
}

/// Throws away uncommitted changes to tracked files.
///
/// Refuses untracked paths outright. Restoring a tracked file loses work that
/// git can still find — it was committed once, so it is in the object store or
/// the reflog. Deleting an untracked file loses it completely, with nothing to
/// recover from, and a destructive action with no floor under it does not
/// belong behind a tap on a phone.
pub async fn discard(
    State(state): State<AppState>,
    Json(request): Json<PathsRequest>,
) -> Result<Json<PathsResponse>, ApiError> {
    let root = state.roots.require(request.root.as_deref())?;
    let top = require_repo(&root.path).await?;

    if request.paths.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "no paths given"));
    }

    let paths = request
        .paths
        .iter()
        .map(|p| git_path(p))
        .collect::<Result<Vec<_>, _>>()?;

    let raw = git(
        &top,
        &["status", "--porcelain=v2", "--untracked-files=all", "-z"],
    )
    .await?;
    let status = parse_status(&raw);

    let refused: Vec<&String> = paths
        .iter()
        .filter(|p| {
            status
                .files
                .iter()
                .any(|f| f.untracked && &&f.path == p)
        })
        .collect();

    if !refused.is_empty() {
        let names: Vec<&str> = refused.iter().map(|p| p.as_str()).collect();
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!(
                "refusing to delete untracked files, which cannot be recovered: {}",
                names.join(", ")
            ),
        ));
    }

    let mut args = vec!["checkout", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(&top, &args).await?;

    Ok(Json(PathsResponse { paths }))
}

pub async fn commit(
    State(state): State<AppState>,
    Json(request): Json<CommitRequest>,
) -> Result<Json<CommitResponse>, ApiError> {
    let root = state.roots.require(request.root.as_deref())?;
    let top = require_repo(&root.path).await?;

    let message = request.message.trim();
    if message.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "commit message is empty"));
    }

    // Only what is staged is committed. No implicit `-a`: a review tool whose
    // commit button silently included changes the person had not staged would
    // be actively misleading.
    git(&top, &["commit", "--message", message]).await?;

    let sha = String::from_utf8_lossy(&git(&top, &["rev-parse", "HEAD"]).await?)
        .trim()
        .to_string();
    let summary = String::from_utf8_lossy(
        &git(&top, &["log", "-1", "--pretty=format:%h %s"]).await?,
    )
    .trim()
    .to_string();

    tracing::info!(root = %root.name, sha = %sha, "commit created");
    Ok(Json(CommitResponse { sha, summary }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_paths_normalise_and_stay_inside_the_root() {
        assert_eq!(git_path("src/main.rs").unwrap(), "src/main.rs");
        // Backslashes are a path separator on Windows, so this normalises
        // there and is a (legal, if odd) filename elsewhere.
        assert_eq!(git_path("./src/../src/main.rs").unwrap(), "src/main.rs");
    }

    #[test]
    fn git_paths_reject_escapes() {
        assert!(git_path("../../etc/passwd").is_err());
        assert!(git_path("/etc/passwd").is_err());
        assert!(git_path("src/../../..").is_err());
        assert!(git_path("").is_err());
    }

    #[test]
    fn status_parses_branch_headers() {
        let raw = "# branch.oid abc123\0# branch.head main\0\
                   # branch.upstream origin/main\0# branch.ab +2 -1\0";
        let parsed = parse_status(raw.as_bytes());
        assert!(parsed.repo);
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 1);
    }

    #[test]
    fn status_parses_changes_and_untracked() {
        let raw = "1 M. N... 100644 100644 100644 aaa bbb src/main.rs\0\
                   1 .M N... 100644 100644 100644 ccc ddd src/ws.rs\0\
                   ? notes.txt\0";
        let parsed = parse_status(raw.as_bytes());
        assert_eq!(parsed.files.len(), 3);

        let staged = parsed.files.iter().find(|f| f.path == "src/main.rs").unwrap();
        assert_eq!(staged.staged, "M");
        assert_eq!(staged.unstaged, ".");
        assert!(!staged.untracked);

        let unstaged = parsed.files.iter().find(|f| f.path == "src/ws.rs").unwrap();
        assert_eq!(unstaged.staged, ".");
        assert_eq!(unstaged.unstaged, "M");

        let untracked = parsed.files.iter().find(|f| f.path == "notes.txt").unwrap();
        assert!(untracked.untracked);
    }

    #[test]
    fn status_keeps_paths_containing_spaces_whole() {
        let raw = "1 M. N... 100644 100644 100644 aaa bbb my notes/a file.md\0";
        let parsed = parse_status(raw.as_bytes());
        assert_eq!(parsed.files[0].path, "my notes/a file.md");
    }

    #[test]
    fn status_reads_the_original_path_of_a_rename() {
        // A rename record carries one extra field, and the original path
        // arrives as the next NUL-separated record rather than inline.
        let raw = "2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0\
                   ? after.txt\0";
        let parsed = parse_status(raw.as_bytes());

        let renamed = parsed.files.iter().find(|f| f.path == "new.rs").unwrap();
        assert_eq!(renamed.staged, "R");
        assert_eq!(renamed.original_path.as_deref(), Some("old.rs"));

        // The record after a rename must still be parsed, not swallowed with
        // the original path.
        assert!(parsed.files.iter().any(|f| f.path == "after.txt"));
    }

    #[test]
    fn status_marks_unmerged_files_as_conflicted() {
        let raw = "u UU N... 100644 100644 100644 100644 aaa bbb ccc both.rs\0";
        let parsed = parse_status(raw.as_bytes());
        assert!(parsed.files[0].conflicted);
        assert_eq!(parsed.files[0].path, "both.rs");
    }

    #[test]
    fn numstat_counts_are_merged_onto_matching_files() {
        let mut status = parse_status(
            "1 .M N... 100644 100644 100644 aaa bbb src/main.rs\0\
             1 .M N... 100644 100644 100644 ccc ddd logo.png\0"
                .as_bytes(),
        );
        apply_numstat(
            &mut status,
            "12\t3\tsrc/main.rs\0-\t-\tlogo.png\0".as_bytes(),
        );

        let main = status.files.iter().find(|f| f.path == "src/main.rs").unwrap();
        assert_eq!(main.added, Some(12));
        assert_eq!(main.removed, Some(3));
        assert!(!main.binary);

        // Binary files report "-" for both counts, which is not zero and must
        // not be shown as though it were.
        let logo = status.files.iter().find(|f| f.path == "logo.png").unwrap();
        assert!(logo.binary);
        assert_eq!(logo.added, None);
    }

    #[test]
    fn numstat_reads_a_rename_from_its_trailing_fields() {
        // A rename leaves the path empty and follows with source then
        // destination; the destination is what the status list is keyed by.
        let mut status = parse_status(
            "2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0\
             1 .M N... 100644 100644 100644 ccc ddd after.rs\0"
                .as_bytes(),
        );
        let numstat = ["4\t2\t", "old.rs", "new.rs", "7\t1\tafter.rs", ""].join("\0");
        apply_numstat(&mut status, numstat.as_bytes());

        let renamed = status.files.iter().find(|f| f.path == "new.rs").unwrap();
        assert_eq!(renamed.added, Some(4));
        assert_eq!(renamed.removed, Some(2));

        // The record after a rename must still be consumed correctly.
        let after = status.files.iter().find(|f| f.path == "after.rs").unwrap();
        assert_eq!(after.added, Some(7));
    }

    #[test]
    fn oversized_patches_are_cut_at_a_line_boundary() {
        let line = "+a line of patch text\n";
        let big = line.repeat(MAX_DIFF_BYTES / line.len() + 100);
        let (patch, truncated) = truncate_patch(big.as_bytes());

        assert!(truncated);
        assert!(patch.len() <= MAX_DIFF_BYTES);
        assert!(patch.ends_with('\n'), "must not cut mid-line");
    }

    #[test]
    fn small_patches_pass_through_untouched() {
        let (patch, truncated) = truncate_patch(b"@@ -1 +1 @@\n-a\n+b\n");
        assert!(!truncated);
        assert_eq!(patch, "@@ -1 +1 @@\n-a\n+b\n");
    }
}
