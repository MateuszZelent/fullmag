//! Content-Addressed Store (CAS) for the internal `SessionStore`.
//!
//! Objects are stored under `objects/sha256/<hex>`, where `<hex>` is the
//! SHA-256 digest of the raw bytes.  Callers write blobs, get back a hash,
//! and reference that hash from manifests and checkpoints.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Content-addressed object store backed by a directory tree.
pub struct CasStore {
    root: PathBuf,
}

impl CasStore {
    /// Open (or create) a CAS rooted at the given directory.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("sha256"))
            .with_context(|| format!("creating CAS directory at {}", root.display()))?;
        Ok(Self { root })
    }

    /// Store raw bytes, returning their SHA-256 hex digest.
    pub fn put(&self, data: &[u8]) -> Result<String> {
        let hash = hex_sha256(data);
        let dest = self.object_path(&hash);
        if dest.exists() {
            return Ok(hash); // dedup: identical content already present
        }
        // Write to temp then rename for atomicity.
        let temp_dir = self.root.join("temp");
        fs::create_dir_all(&temp_dir)?;
        let temp_path = temp_dir.join(format!("{}.part", &hash));
        {
            let mut f = fs::File::create(&temp_path)
                .with_context(|| format!("creating temp object {}", temp_path.display()))?;
            f.write_all(data)?;
            f.flush()?;
        }
        fs::rename(&temp_path, &dest)
            .with_context(|| format!("promoting object {} to CAS", hash))?;
        Ok(hash)
    }

    /// Store a JSON-serializable value, returning its SHA-256 hex digest.
    pub fn put_json<T: serde::Serialize>(&self, value: &T) -> Result<String> {
        let bytes = serde_json::to_vec_pretty(value)?;
        self.put(&bytes)
    }

    /// Retrieve raw bytes by hash.  Returns `None` if not present.
    pub fn get(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        let path = self.object_path(hash);
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
        self.object_path(hash).exists()
    }

    /// List all object hashes currently stored.
    pub fn list(&self) -> Result<Vec<String>> {
        let dir = self.root.join("sha256");
        let mut hashes = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if let Some(name) = entry.file_name().to_str() {
                    hashes.push(name.to_string());
                }
            }
        }
        Ok(hashes)
    }

    /// Garbage-collect: remove objects not referenced in the given set.
    pub fn gc(&self, live_refs: &std::collections::HashSet<String>) -> Result<usize> {
        let dir = self.root.join("sha256");
        let mut removed = 0usize;
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if let Some(name) = entry.file_name().to_str() {
                    if !live_refs.contains(name) {
                        fs::remove_file(entry.path())?;
                        removed += 1;
                    }
                }
            }
        }
        Ok(removed)
    }

    fn object_path(&self, hash: &str) -> PathBuf {
        self.root.join("sha256").join(hash)
    }
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
        assert!(cas.get("deadbeef").unwrap().is_none());
    }

    #[test]
    fn gc_removes_unreferenced() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        let h1 = cas.put(b"keep").unwrap();
        let h2 = cas.put(b"remove").unwrap();
        let mut live = std::collections::HashSet::new();
        live.insert(h1.clone());
        let removed = cas.gc(&live).unwrap();
        assert_eq!(removed, 1);
        assert!(cas.contains(&h1));
        assert!(!cas.contains(&h2));
    }
}
