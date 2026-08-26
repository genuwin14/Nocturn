//! Project roots.
//!
//! A root is the pair of a short name and a directory. The name is what the API
//! and the client pass around; the directory is what path confinement is
//! measured against. Roots are fixed at startup — there is no endpoint that
//! adds one, because an API able to widen the daemon's own reach would make the
//! token a meaningfully worse thing to hold.
//!
//! Two forms of the same directory are kept. `path` is canonical, which is what
//! `resolve` needs: every candidate path is canonicalized before comparison, so
//! the root has to be in the same form for `starts_with` to mean anything.
//! `display` is the same directory in the form a person reads, which on Windows
//! means without the `\\?\` prefix — see `friendly_path`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use axum::http::StatusCode;
use serde::Serialize;

use crate::fsapi::{err, ApiError};

#[derive(Debug)]
pub struct Root {
    pub name: String,
    /// Canonical. What confinement compares against.
    pub path: PathBuf,
    /// The same directory, minus Windows' extended-length prefix. For the
    /// banner, the API, and the working directory shells are spawned in.
    pub display: PathBuf,
}

/// What `GET /api/roots` returns.
#[derive(Serialize)]
pub struct RootInfo {
    pub name: String,
    pub path: String,
    /// True for the one used when a request names no root.
    pub default: bool,
    /// Whether the Review tab has anything to show for it.
    pub repo: bool,
}

#[derive(Debug)]
pub struct Roots {
    roots: Vec<Root>,
}

impl Roots {
    /// Parses `--root` values, each either a path or `name=path`.
    ///
    /// An empty list means the daemon was started with no `--root` at all, in
    /// which case the working directory is the root — the behaviour from before
    /// this took more than one.
    pub fn parse(specs: &[String]) -> Result<Self> {
        let owned;
        let specs = if specs.is_empty() {
            let cwd = std::env::current_dir().context("no --root given and the working directory is unreadable")?;
            owned = vec![cwd.to_string_lossy().into_owned()];
            &owned
        } else {
            specs
        };

        let mut roots: Vec<Root> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for spec in specs {
            let (name, raw) = split_spec(spec);

            let path = PathBuf::from(raw);
            let path = path
                .canonicalize()
                .with_context(|| format!("project root does not exist: {}", path.display()))?;

            if !path.is_dir() {
                bail!("project root is not a directory: {}", path.display());
            }

            let display = crate::friendly_path(&path);

            let name = match name {
                Some(name) => name.to_string(),
                None => derive_name(&display).with_context(|| {
                    format!(
                        "cannot name the root {}; give it one explicitly, as name={}",
                        display.display(),
                        display.display()
                    )
                })?,
            };

            // Two roots answering to one name would make which directory a
            // request reached depend on iteration order, so it is a startup
            // error rather than a silent preference for the first.
            if !seen.insert(name.clone()) {
                bail!(
                    "two roots are both named '{name}'; disambiguate with name=path, \
                     e.g. --root work-{name}={}",
                    display.display()
                );
            }

            roots.push(Root { name, path, display });
        }

        Ok(Self { roots })
    }

    /// The root used when a request names none.
    pub fn default_root(&self) -> &Root {
        // `parse` never produces an empty list: no specs means the working
        // directory, and any spec that fails is an error rather than a skip.
        &self.roots[0]
    }

    pub fn all(&self) -> &[Root] {
        &self.roots
    }

    pub fn find(&self, name: &str) -> Option<&Root> {
        self.roots.iter().find(|r| r.name == name)
    }

    /// Resolves a request's `root` parameter, or fails the request.
    ///
    /// An absent or empty name is the default root, so every existing
    /// single-root client keeps working without sending anything new. An
    /// unknown one is rejected here, before any path handling — the reason the
    /// caller gets is the list of names, which they could read from
    /// `/api/roots` anyway.
    pub fn require(&self, name: Option<&str>) -> Result<&Root, ApiError> {
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        let Some(name) = name else {
            return Ok(self.default_root());
        };

        self.find(name).ok_or_else(|| {
            let known: Vec<&str> = self.roots.iter().map(|r| r.name.as_str()).collect();
            err(
                StatusCode::BAD_REQUEST,
                format!("unknown root '{name}'; this daemon serves {}", known.join(", ")),
            )
        })
    }

    /// The same as `require`, for callers with no HTTP response to fail into —
    /// the WebSocket handler, which is already past the point of sending a
    /// status code.
    pub fn require_named(&self, name: Option<&str>) -> Result<&Root> {
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        let Some(name) = name else {
            return Ok(self.default_root());
        };

        self.find(name)
            .ok_or_else(|| anyhow::anyhow!("unknown root '{name}'"))
    }
}

/// Splits `name=path` into its halves, or reports the whole thing as a path.
///
/// Only splits when the left side is a valid name, which is what keeps a
/// directory with an `=` in it from being read as a name. No legal name
/// contains a separator or a drive colon, so `C:\my=dir` stays one path.
fn split_spec(spec: &str) -> (Option<&str>, &str) {
    match spec.split_once('=') {
        Some((name, path)) if is_valid_name(name) && !path.is_empty() => (Some(name), path),
        _ => (None, spec),
    }
}

/// Names travel in query strings and become part of a session's identity, so
/// they are kept to something that needs no escaping anywhere.
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Names a root after its directory.
///
/// Fails rather than inventing something for a directory whose basename is not
/// a usable name — a drive root, or one with spaces or accents in it. The
/// `name=path` form exists for exactly that, and an error naming it is more
/// use than a mangled default nobody would guess.
fn derive_name(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    if !is_valid_name(&name) {
        bail!("'{name}' is not usable as a root name");
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_path_is_named_after_its_directory() {
        assert_eq!(split_spec("/srv/code/api"), (None, "/srv/code/api"));
        assert_eq!(
            derive_name(Path::new("/srv/code/api")).unwrap(),
            "api"
        );
    }

    #[test]
    fn an_explicit_name_wins() {
        assert_eq!(
            split_spec("work=/srv/code/api"),
            (Some("work"), "/srv/code/api")
        );
    }

    #[test]
    fn a_path_containing_an_equals_sign_is_not_a_name() {
        // The left side is a path, not a name, so there is nothing to split.
        assert_eq!(split_spec(r"C:\my=dir"), (None, r"C:\my=dir"));
        assert_eq!(split_spec("/srv/a=b/c"), (None, "/srv/a=b/c"));
    }

    #[test]
    fn an_empty_path_after_the_name_is_not_a_split() {
        assert_eq!(split_spec("work="), (None, "work="));
    }

    #[test]
    fn names_stay_url_safe() {
        assert!(is_valid_name("api"));
        assert!(is_valid_name("my-app_2.0"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("my app"));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name(r"C:\code"));
        assert!(!is_valid_name(&"x".repeat(65)));
    }

    #[test]
    fn a_directory_with_no_usable_basename_is_refused() {
        // A drive or filesystem root has no basename to name it after.
        assert!(derive_name(Path::new("/")).is_err());
        assert!(derive_name(Path::new("my project")).is_err());
    }

    fn roots_of(pairs: &[(&str, &str)]) -> Roots {
        Roots {
            roots: pairs
                .iter()
                .map(|(name, path)| Root {
                    name: (*name).to_string(),
                    path: PathBuf::from(path),
                    display: PathBuf::from(path),
                })
                .collect(),
        }
    }

    #[test]
    fn an_absent_root_parameter_means_the_first_one() {
        let roots = roots_of(&[("api", "/srv/api"), ("web", "/srv/web")]);
        assert_eq!(roots.require(None).unwrap().name, "api");
        // A client sending `?root=` — an empty value — means the same thing.
        assert_eq!(roots.require(Some("")).unwrap().name, "api");
        assert_eq!(roots.require(Some("web")).unwrap().name, "web");
    }

    #[test]
    fn an_unknown_root_is_rejected_before_any_path_handling() {
        let roots = roots_of(&[("api", "/srv/api")]);
        let (status, body) = roots.require(Some("nope")).expect_err("should reject");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // The message names what does exist; the caller is authenticated and
        // could list them anyway.
        assert!(format!("{body:?}").contains("api"), "{body:?}");
    }

    #[test]
    fn parse_refuses_two_roots_with_the_same_name() {
        let temp = std::env::temp_dir();
        let a = temp.join("nocturn-dup-test/one/shared");
        let b = temp.join("nocturn-dup-test/two/shared");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let specs = vec![
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ];
        let error = Roots::parse(&specs).expect_err("duplicate names must not start");
        assert!(format!("{error}").contains("shared"), "{error}");

        // Naming one of them explicitly is the way out, and the error says so.
        let specs = vec![
            format!("first={}", a.display()),
            b.to_string_lossy().into_owned(),
        ];
        let roots = Roots::parse(&specs).expect("explicit names disambiguate");
        assert_eq!(roots.all().len(), 2);
        assert_eq!(roots.default_root().name, "first");

        std::fs::remove_dir_all(temp.join("nocturn-dup-test")).ok();
    }

    #[test]
    fn parse_reports_a_missing_directory_by_name() {
        let missing = std::env::temp_dir().join("nocturn-does-not-exist-9f3b");
        let specs = vec![missing.to_string_lossy().into_owned()];
        let error = Roots::parse(&specs).expect_err("a missing root must not start");
        assert!(format!("{error}").contains("does not exist"), "{error}");
    }
}
