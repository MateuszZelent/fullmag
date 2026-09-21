//! Content-Addressed Store (CAS) for the internal `SessionStore`.
//!
//! Objects are stored under `objects/sha256/<hex>`, where `<hex>` is the
//! SHA-256 digest of the raw bytes.  Callers write blobs, get back a hash,
//! and reference that hash from manifests and checkpoints.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use crate::repository_path::{checked_path, create_parent, reject_link};
use crate::writer::Writer;
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Content-addressed object store backed by a directory tree.
pub struct CasStore {
    root: PathBuf,
    writer: Arc<Writer>,
}

impl CasStore {
    /// Open (or create) a CAS rooted at the given directory.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        crate::writer::require_local_filesystem(&root)?;
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let owner = root
            .parent()
            .filter(|_| root.file_name().is_some_and(|n| n == "objects"))
            .unwrap_or(&root)
            .to_path_buf();
        Self::with_writer(root, Writer::new(owner))
    }

    pub(crate) fn with_writer(root: PathBuf, writer: Arc<Writer>) -> Result<Self> {
        reject_link(&root)?;
        fs::create_dir_all(&root)?;
        if !checked_path(&root, "sha256")?.is_dir() || !checked_path(&root, "pins")?.is_dir() {
            let _lease = writer.acquire()?;
            for name in ["sha256", "pins"] {
                fs::create_dir_all(checked_path(&root, name)?)?;
            }
            crate::durability::sync_directory(&root)?;
        }
        Ok(Self { root, writer })
    }

    pub(crate) fn existing(root: PathBuf, writer: Arc<Writer>) -> Result<Self> {
        reject_link(&root)?;
        if !checked_path(&root, "sha256")?.is_dir() {
            anyhow::bail!("CAS is not initialized");
        }
        Ok(Self { root, writer })
    }

    /// Store raw bytes, returning their SHA-256 hex digest.
    pub fn put(&self, data: &[u8]) -> Result<String> {
        let _lease = self.writer.acquire()?;
        let hash = hex_sha256(data);
        let dest = self.object_path(&hash)?;
        if self.get(&hash)?.is_some() {
            self.pin(&hash)?;
            return Ok(hash);
        }
        // Durable pin precedes publication: a later, separate checkpoint write
        // must not lose this blob to a concurrent GC between the two calls.
        self.pin(&hash)?;
        crate::durability::atomic_write(&dest, data)?;
        Ok(hash)
    }

    fn pin(&self, hash: &str) -> Result<()> {
        let path = create_parent(&self.root, &format!("pins/{hash}.json"))?;
        crate::durability::atomic_write(
            &path,
            &serde_json::to_vec(&serde_json::json!({
                "schema": "fullmag.cas-pin.v1", "object_ref": hash
            }))?,
        )
    }

    pub(crate) fn pinned_refs(&self) -> Result<std::collections::HashSet<String>> {
        let mut refs = std::collections::HashSet::new();
        let directory = checked_path(&self.root, "pins")?;
        if !directory.exists() {
            return Ok(refs);
        }
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 CAS pin"))?;
            let path = checked_path(&self.root, &format!("pins/{name}"))?;
            let value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
            let hash = value
                .get("object_ref")
                .and_then(|v| v.as_str())
                .context("invalid CAS pin")?;
            validate_hash(hash)?;
            if value.get("schema").and_then(|v| v.as_str()) != Some("fullmag.cas-pin.v1")
                || name != format!("{hash}.json")
            {
                anyhow::bail!("unknown or inconsistent CAS pin schema");
            }
            refs.insert(hash.to_owned());
        }
        Ok(refs)
    }

    /// Release only a pin already made durable through a verified root graph.
    pub(crate) fn release_referenced_pins(
        &self,
        refs: &std::collections::HashSet<String>,
    ) -> Result<()> {
        let _lease = self.writer.acquire()?;
        for hash in refs {
            validate_hash(hash)?;
            let path = checked_path(&self.root, &format!("pins/{hash}.json"))?;
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        crate::durability::sync_directory(&self.root.join("pins"))
    }

    /// Store a JSON-serializable value, returning its SHA-256 hex digest.
    pub fn put_json<T: serde::Serialize>(&self, value: &T) -> Result<String> {
        let bytes = serde_json::to_vec_pretty(value)?;
        self.put(&bytes)
    }

    /// Retrieve raw bytes by hash.  Returns `None` if not present.
    pub fn get(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        let path = self.object_path(hash)?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path).with_context(|| format!("reading CAS object {hash}"))?;
        // Verify integrity.
        let actual = hex_sha256(&data);
        if actual != hash {
            anyhow::bail!("CAS integrity error: expected {hash}, got {actual}");
        }
        Ok(Some(data))
    }

    /// Check whether an object exists without reading it.
    pub fn contains(&self, hash: &str) -> bool {
        self.object_path(hash)
            .map(|path| path.is_file())
            .unwrap_or(false)
    }

    /// List all object hashes currently stored.
    pub fn list(&self) -> Result<Vec<String>> {
        let dir = checked_path(&self.root, "sha256")?;
        let mut hashes = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if let Some(name) = entry.file_name().to_str() {
                    validate_hash(name)?;
                    let path = self.object_path(name)?;
                    if !path.is_file() {
                        anyhow::bail!("non-file CAS object {name}");
                    }
                    hashes.push(name.to_string());
                } else {
                    anyhow::bail!("non-UTF8 CAS object name");
                }
            }
        }
        Ok(hashes)
    }

    /// Preview only. A caller-supplied set cannot authorize physical deletion.
    pub fn gc(&self, live_refs: &std::collections::HashSet<String>) -> Result<usize> {
        let pins = self.pinned_refs()?;
        Ok(self
            .list()?
            .iter()
            .filter(|hash| !live_refs.contains(*hash) && !pins.contains(*hash))
            .count())
    }

    pub(crate) fn remove_verified(&self, hash: &str) -> Result<()> {
        let _lease = self.writer.acquire()?;
        if self.pinned_refs()?.contains(hash) {
            anyhow::bail!("refusing removal of pinned CAS object");
        }
        fs::remove_file(self.object_path(hash)?)?;
        crate::durability::sync_directory(&self.root.join("sha256"))
    }

    fn object_path(&self, hash: &str) -> Result<PathBuf> {
        validate_hash(hash)?;
        checked_path(&self.root, &format!("sha256/{hash}"))
    }
}

pub(crate) fn validate_hash(hash: &str) -> Result<()> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    {
        anyhow::bail!("invalid CAS SHA-256 `{hash}`");
    }
    Ok(())
}

/// Compute the SHA-256 hex digest of the given bytes.
pub fn hex_sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_and_get_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        let data = b"hello, fullmag sessions";
        let hash = cas.put(data).unwrap();
        assert_eq!(hash.len(), 64); // SHA-256 hex = 64 chars
        let got = cas.get(&hash).unwrap().unwrap();
        assert_eq!(&got, data);
    }

    #[test]
    fn dedup_identical_content() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        let h1 = cas.put(b"same").unwrap();
        let h2 = cas.put(b"same").unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn missing_object_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        assert!(cas.get(&"0".repeat(64)).unwrap().is_none());
        assert!(cas.get("../outside").is_err());
    }

    #[test]
    fn legacy_gc_never_removes_even_unreferenced_objects() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        let h1 = cas.put(b"keep").unwrap();
        let h2 = cas.put(b"remove").unwrap();
        let mut live = std::collections::HashSet::new();
        live.insert(h1.clone());
        let removed = cas.gc(&live).unwrap();
        assert_eq!(removed, 0); // unpublished blobs remain pinned
        assert!(cas.contains(&h1));
        assert!(cas.contains(&h2));
    }
}
