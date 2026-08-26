//! Named, individually revocable access tokens.
//!
//! There used to be one token. Every device shared it, and rotating it meant
//! editing a file and restarting — which logged out every other device and
//! killed every running shell. The predictable result is that nobody rotates,
//! and the revocation story the product advertises is only theoretical.
//!
//! Each device gets its own named token instead. Losing a phone costs one
//! revoke that takes effect immediately, on a daemon that keeps running.
//!
//! ## On hashing
//!
//! Tokens are stored as salted SHA-256, not as a password KDF like argon2.
//! That is deliberate rather than a shortcut: a KDF's cost exists to make
//! guessing a *low-entropy* human-chosen secret expensive. These are 256 bits
//! from the system RNG, so guessing is not the threat and a slow hash would
//! buy nothing while making every request pay for it. What hashing does buy is
//! that a readable config file no longer hands over every device's credential.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{broadcast, RwLock};

/// How often a token's last-seen time is written back. Without this the store
/// would be rewritten on every authenticated request, which is a disk write on
/// a read path.
const TOUCH_INTERVAL: Duration = Duration::from_secs(60);

/// Capacity of the revocation channel. Revocations are rare; this only needs to
/// be large enough that a burst cannot lag a socket into missing one.
const REVOKE_CAP: usize = 16;

/// Who is making a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    /// The bootstrap credential from `--token` or `NOCTURN_TOKEN`. Always
    /// accepted, never stored, and not revocable through the API — it is how
    /// you get back in when you have revoked everything else.
    Bootstrap,
    /// A stored, named, revocable token.
    Device { id: String, name: String },
}

impl Principal {
    pub fn id(&self) -> &str {
        match self {
            Principal::Bootstrap => "bootstrap",
            Principal::Device { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Principal::Bootstrap => "bootstrap",
            Principal::Device { name, .. } => name,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TokenRecord {
    id: String,
    name: String,
    /// Hex SHA-256 of `salt_bytes || token_bytes`.
    hash: String,
    /// Hex, 16 bytes. Per token, so two devices with the same secret — which
    /// cannot happen, but the property should not depend on that — would not
    /// share a hash.
    salt: String,
    created: u64,
    #[serde(default)]
    last_seen: u64,
    #[serde(default)]
    last_ip: String,
}

/// What `/api/tokens` returns. Never carries the hash or the salt.
#[derive(Clone, Debug, Serialize)]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub last_seen: u64,
    pub last_ip: String,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    tokens: Vec<TokenRecord>,
}

pub struct TokenStore {
    path: PathBuf,
    records: RwLock<Vec<TokenRecord>>,
    /// Last time each token's `last_seen` was persisted, so the throttle does
    /// not need to touch the file to know.
    touched: RwLock<HashMap<String, Instant>>,
    revoked: broadcast::Sender<String>,
    bootstrap: Option<String>,
}

impl TokenStore {
    /// Opens the store, creating it if absent.
    ///
    /// `legacy` is the single-token file from before this existed. If the store
    /// is new and that file holds a token, it is adopted under a name rather
    /// than discarded — an upgrade must not lock somebody out of their own
    /// daemon.
    pub fn open(path: PathBuf, bootstrap: Option<String>, legacy: Option<String>) -> Result<Self> {
        let mut records = match std::fs::read(&path) {
            Ok(bytes) => {
                let parsed: StoreFile = serde_json::from_slice(&bytes)
                    .with_context(|| format!("{} is not valid JSON", path.display()))?;
                parsed.tokens
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e).with_context(|| format!("failed to read {}", path.display())),
        };

        let mut created_from_legacy = false;
        if records.is_empty() {
            if let Some(secret) = legacy.filter(|s| !s.trim().is_empty()) {
                records.push(TokenRecord::new("first device", secret.trim())?);
                created_from_legacy = true;
            }
        }

        let (revoked, _) = broadcast::channel(REVOKE_CAP);
        let store = Self {
            path,
            records: RwLock::new(records),
            touched: RwLock::new(HashMap::new()),
            revoked,
            bootstrap,
        };

        if created_from_legacy {
            store.persist_blocking()?;
            tracing::info!("adopted the existing token into the device store");
        }

        Ok(store)
    }

    /// Identifies the presented token, or returns None.
    ///
    /// Every record is checked even after a match is found. Returning early
    /// would make the time taken depend on which token was presented, and on
    /// how many devices exist — small leaks, but the comparison is already
    /// constant-time and giving that up at the loop level would be silly.
    pub async fn verify(&self, presented: &str) -> Option<Principal> {
        if let Some(bootstrap) = self.bootstrap.as_deref() {
            if constant_time_eq(bootstrap, presented) {
                return Some(Principal::Bootstrap);
            }
        }

        let records = self.records.read().await;
        let mut found: Option<Principal> = None;
        for record in records.iter() {
            if record.matches(presented) {
                found = Some(Principal::Device {
                    id: record.id.clone(),
                    name: record.name.clone(),
                });
            }
        }
        found
    }

    /// Records that a token was used. Throttled, because this is a write on a
    /// read path and nobody needs second-level resolution on "last seen".
    pub async fn touch(&self, principal: &Principal, ip: &str) {
        let Principal::Device { id, .. } = principal else {
            return;
        };

        {
            let touched = self.touched.read().await;
            if let Some(at) = touched.get(id) {
                if at.elapsed() < TOUCH_INTERVAL {
                    return;
                }
            }
        }

        {
            let mut records = self.records.write().await;
            let Some(record) = records.iter_mut().find(|r| &r.id == id) else {
                return;
            };
            record.last_seen = unix_now();
            record.last_ip = ip.to_string();
        }
        self.touched.write().await.insert(id.clone(), Instant::now());

        if let Err(e) = self.persist().await {
            // A failed write costs an out-of-date timestamp. Refusing the
            // request over it would be a far worse trade.
            tracing::warn!(error = %e, "failed to persist token store");
        }
    }

    /// Creates a token, returning the secret exactly once. It is not stored in
    /// a form anything can recover it from, so a caller that loses it has to
    /// mint another.
    pub async fn mint(&self, name: &str) -> Result<(TokenInfo, String)> {
        let secret = generate_secret();
        let record = TokenRecord::new(name, &secret)?;
        let info = record.info();

        self.records.write().await.push(record);
        self.persist().await?;

        tracing::info!(id = %info.id, name = %info.name, "minted token");
        Ok((info, secret))
    }

    /// Removes a token. Returns false if there was no such id.
    pub async fn revoke(&self, id: &str) -> Result<bool> {
        let removed = {
            let mut records = self.records.write().await;
            let before = records.len();
            records.retain(|r| r.id != id);
            records.len() != before
        };

        if !removed {
            return Ok(false);
        }

        self.persist().await?;
        self.touched.write().await.remove(id);

        // Live sockets are told, so revoking a lost phone ends the terminal it
        // has open rather than waiting for it to reconnect. An error here just
        // means nothing is attached.
        let _ = self.revoked.send(id.to_string());

        tracing::info!(id = %id, "revoked token");
        Ok(true)
    }

    pub async fn list(&self) -> Vec<TokenInfo> {
        let mut out: Vec<TokenInfo> = self.records.read().await.iter().map(|r| r.info()).collect();
        out.sort_by_key(|t| t.created);
        out
    }

    pub async fn is_empty(&self) -> bool {
        self.records.read().await.is_empty()
    }

    pub fn subscribe_revocations(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    async fn persist(&self) -> Result<()> {
        let file = StoreFile {
            version: 1,
            tokens: self.records.read().await.clone(),
        };
        write_atomically(&self.path, &file)
    }

    fn persist_blocking(&self) -> Result<()> {
        let file = StoreFile {
            version: 1,
            tokens: self
                .records
                .try_read()
                .map_err(|_| anyhow::anyhow!("token store is locked"))?
                .clone(),
        };
        write_atomically(&self.path, &file)
    }
}

/// Writes to a sibling temporary file and renames over the target.
///
/// A crash partway through a plain write leaves a truncated file, and a
/// truncated token store is every device locked out at once.
fn write_atomically(path: &Path, file: &StoreFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let json = serde_json::to_vec_pretty(file)?;
    let temp = path.with_extension("json.tmp");

    std::fs::write(&temp, &json)
        .with_context(|| format!("failed to write {}", temp.display()))?;
    crate::restrict_permissions(&temp);
    std::fs::rename(&temp, path)
        .with_context(|| format!("failed to replace {}", path.display()))?;

    Ok(())
}

impl TokenRecord {
    fn new(name: &str, secret: &str) -> Result<Self> {
        let salt = random_hex(16)?;
        Ok(Self {
            id: random_hex(6)?,
            name: name.trim().to_string(),
            hash: hash_secret(&salt, secret),
            salt,
            created: unix_now(),
            last_seen: 0,
            last_ip: String::new(),
        })
    }

    fn matches(&self, presented: &str) -> bool {
        constant_time_eq(&self.hash, &hash_secret(&self.salt, presented))
    }

    fn info(&self) -> TokenInfo {
        TokenInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            created: self.created,
            last_seen: self.last_seen,
            last_ip: self.last_ip.clone(),
        }
    }
}

fn hash_secret(salt_hex: &str, secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt_hex.as_bytes());
    hasher.update(secret.as_bytes());
    hex(&hasher.finalize())
}

/// Compares two hex strings without letting the time taken depend on where
/// they first differ.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.ct_eq(b).into()
}

/// `rand::rng()` is a CSPRNG seeded from the operating system, which is what
/// both salts and secrets need. Same source the daemon's original single token
/// came from.
fn random_hex(bytes: usize) -> Result<String> {
    use rand::RngExt;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill(buf.as_mut_slice());
    Ok(hex(&buf))
}

/// 256 bits, matching what the daemon already generated for its single token.
fn generate_secret() -> String {
    random_hex(32).unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

    fn temp_store_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("nocturn-tokens-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[tokio::test]
    async fn a_minted_token_verifies_and_a_wrong_one_does_not() {
        let store = TokenStore::open(temp_store_path("mint"), None, None).unwrap();
        let (info, secret) = store.mint("pixel-9").await.unwrap();

        let principal = store.verify(&secret).await.expect("should verify");
        assert_eq!(principal.id(), info.id);
        assert_eq!(principal.name(), "pixel-9");

        assert!(store.verify("not-the-token").await.is_none());
        assert!(store.verify("").await.is_none());
    }

    #[tokio::test]
    async fn the_secret_is_not_recoverable_from_the_file() {
        let path = temp_store_path("secrecy");
        let store = TokenStore::open(path.clone(), None, None).unwrap();
        let (_, secret) = store.mint("laptop").await.unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains(&secret),
            "the plaintext token must not reach disk"
        );
        assert!(written.contains("laptop"));
    }

    #[tokio::test]
    async fn revoking_removes_only_that_token() {
        let store = TokenStore::open(temp_store_path("revoke"), None, None).unwrap();
        let (phone, phone_secret) = store.mint("phone").await.unwrap();
        let (_, laptop_secret) = store.mint("laptop").await.unwrap();

        assert!(store.revoke(&phone.id).await.unwrap());
        assert!(store.verify(&phone_secret).await.is_none());

        // The point of the whole feature: losing one device does not log the
        // others out.
        assert!(store.verify(&laptop_secret).await.is_some());

        // Revoking something already gone is not an error, just false.
        assert!(!store.revoke(&phone.id).await.unwrap());
    }

    #[tokio::test]
    async fn revocation_is_announced_to_live_sockets() {
        let store = TokenStore::open(temp_store_path("announce"), None, None).unwrap();
        let (info, _) = store.mint("phone").await.unwrap();
        let mut rx = store.subscribe_revocations();

        store.revoke(&info.id).await.unwrap();

        assert_eq!(rx.recv().await.unwrap(), info.id);
    }

    #[tokio::test]
    async fn the_bootstrap_token_works_and_is_not_stored() {
        let path = temp_store_path("bootstrap");
        let store =
            TokenStore::open(path.clone(), Some("env-supplied-token".into()), None).unwrap();

        assert_eq!(
            store.verify("env-supplied-token").await,
            Some(Principal::Bootstrap)
        );
        // It is a way back in, so it must not appear in a list of revocable
        // devices, and must not be on disk.
        assert!(store.list().await.is_empty());
        assert!(!path.exists() || !std::fs::read_to_string(&path).unwrap().contains("env-supplied"));
    }

    #[tokio::test]
    async fn an_existing_single_token_is_adopted_rather_than_lost() {
        let path = temp_store_path("legacy");
        let store =
            TokenStore::open(path.clone(), None, Some("previously-persisted".into())).unwrap();

        // Upgrading must not lock anyone out of their own daemon.
        assert!(store.verify("previously-persisted").await.is_some());
        assert_eq!(store.list().await.len(), 1);

        // And it is stored hashed like any other.
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains("previously-persisted"));
    }

    #[tokio::test]
    async fn the_store_survives_a_reopen() {
        let path = temp_store_path("reopen");
        let secret = {
            let store = TokenStore::open(path.clone(), None, None).unwrap();
            store.mint("phone").await.unwrap().1
        };

        let reopened = TokenStore::open(path, None, None).unwrap();
        assert!(reopened.verify(&secret).await.is_some());
        assert_eq!(reopened.list().await.len(), 1);
    }

    #[test]
    fn hashing_is_salted() {
        // Same secret, different salt, different hash — so a stolen file gives
        // no way to tell two devices apart by comparing hashes.
        assert_ne!(hash_secret("aaaa", "same"), hash_secret("bbbb", "same"));
        assert_eq!(hash_secret("aaaa", "same"), hash_secret("aaaa", "same"));
    }
}
