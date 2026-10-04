//! Content-Addressed Store (CAS) for the internal `SessionStore`.
//!
//! Objects are stored under `objects/sha256/<hex>`, where `<hex>` is the
//! SHA-256 digest of the raw bytes.  Callers write blobs, get back a hash,
//! and reference that hash from manifests and checkpoints.

use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCasRange {
    pub bytes: Vec<u8>,
    pub object_length: u64,
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
        if let Some(existing_length) = self.verified_length(&hash)? {
            if existing_length != u64::try_from(data.len())? {
                anyhow::bail!("CAS object {hash} length differs from the supplied bytes");
            }
            self.pin(&hash)?;
            return Ok(hash);
        }
        // Durable pin precedes publication: a later, separate checkpoint write
        // must not lose this blob to a concurrent GC between the two calls.
        self.pin(&hash)?;
        crate::durability::atomic_write(&dest, data)?;
        Ok(hash)
    }

    /// Store a verified file without materializing its contents in memory.
    ///
    /// The source is fingerprinted before pinning and verified again while it
    /// is copied into the atomic publication staging file.  This closes the
    /// source-identity race without weakening the existing pin-before-
    /// publication rule.
    pub(crate) fn put_file(
        &self,
        source: &Path,
        expected_hash: &str,
        expected_length: u64,
    ) -> Result<String> {
        validate_hash(expected_hash)?;
        reject_link(source)?;
        let _lease = self.writer.acquire()?;

        let (actual_hash, actual_length) = file_content_identity(source)?;
        if actual_hash != expected_hash {
            anyhow::bail!(
                "CAS source digest mismatch: expected {expected_hash}, got {actual_hash}"
            );
        }
        if actual_length != expected_length {
            anyhow::bail!(
                "CAS source length mismatch: expected {expected_length}, got {actual_length}"
            );
        }

        let dest = self.object_path(expected_hash)?;
        if let Some(existing_length) = self.verified_length(expected_hash)? {
            if existing_length != expected_length {
                anyhow::bail!(
                    "CAS object {expected_hash} length mismatch: expected {expected_length}, found {existing_length}"
                );
            }
            self.pin(expected_hash)?;
            return Ok(expected_hash.to_owned());
        }

        // Durable pin precedes publication: a later, separate checkpoint write
        // must not lose this blob to a concurrent GC between the two calls.
        self.pin(expected_hash)?;
        crate::durability::atomic_write_verified_file(
            &dest,
            source,
            expected_hash,
            expected_length,
        )?;
        Ok(expected_hash.to_owned())
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

    /// Verify one complete CAS object with bounded memory and return its
    /// stable byte length. No payload buffer is materialized.
    pub fn verified_length(&self, hash: &str) -> Result<Option<u64>> {
        let path = self.object_path(hash)?;
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(verified_file_length(&path, hash)?))
    }

    /// Read one bounded byte range while streaming and hashing the complete
    /// object. This preserves CAS integrity without allocating the full object.
    pub fn get_verified_range(
        &self,
        hash: &str,
        offset: u64,
        length: u64,
        max_range_bytes: u64,
    ) -> Result<Option<VerifiedCasRange>> {
        if length == 0 || max_range_bytes == 0 || length > max_range_bytes {
            anyhow::bail!(
                "CAS range length {length} is outside the positive {max_range_bytes}-byte budget"
            );
        }
        let range_end = offset
            .checked_add(length)
            .context("CAS range offset and length overflow")?;
        let path = self.object_path(hash)?;
        if !path.exists() {
            return Ok(None);
        }
        let file = fs::File::open(&path).with_context(|| format!("opening CAS object {hash}"))?;
        let metadata = file
            .metadata()
            .with_context(|| format!("reading metadata for CAS object {hash}"))?;
        if !metadata.is_file() {
            anyhow::bail!("CAS object {hash} is not a regular file");
        }
        let object_length = metadata.len();
        if range_end > object_length {
            anyhow::bail!(
                "CAS range {offset}..{range_end} exceeds object {hash} length {object_length}"
            );
        }
        let range_capacity = usize::try_from(length).context("CAS range length exceeds usize")?;
        let mut bytes = Vec::with_capacity(range_capacity);
        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut position = 0_u64;
        loop {
            let count = reader
                .read(&mut buffer)
                .with_context(|| format!("streaming CAS object {hash}"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            let buffer_end = position
                .checked_add(count as u64)
                .context("CAS object length overflow")?;
            let overlap_start = position.max(offset);
            let overlap_end = buffer_end.min(range_end);
            if overlap_start < overlap_end {
                let start = usize::try_from(overlap_start - position)
                    .context("CAS range start exceeds usize")?;
                let end = usize::try_from(overlap_end - position)
                    .context("CAS range end exceeds usize")?;
                bytes.extend_from_slice(&buffer[start..end]);
            }
            position = buffer_end;
        }
        let actual = hex_encode(&hasher.finalize());
        if actual != hash {
            anyhow::bail!("CAS integrity error: expected {hash}, got {actual}");
        }
        if position != object_length || bytes.len() != range_capacity {
            anyhow::bail!(
                "CAS object {hash} changed length while reading or did not cover the requested range"
            );
        }
        Ok(Some(VerifiedCasRange {
            bytes,
            object_length,
        }))
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

pub(crate) fn verified_file_length(path: &Path, hash: &str) -> Result<u64> {
    stream_file_identity(path, Some(hash), None, &mut std::io::sink())
        .map(|(_, length)| length)
}

/// Fingerprint a non-CAS export source with the same bounded streaming reader.
pub(crate) fn file_content_identity(path: &Path) -> Result<(String, u64)> {
    stream_file_identity(path, None, None, &mut std::io::sink())
}

/// Copy the planned immutable object without allocating its full contents.
/// A caller must discard the destination on error, including a final hash error.
pub(crate) fn copy_verified_file(
    path: &Path,
    hash: &str,
    expected_length: u64,
    writer: &mut impl Write,
) -> Result<()> {
    stream_file_identity(path, Some(hash), Some(expected_length), writer)?;
    Ok(())
}

fn stream_file_identity(
    path: &Path,
    expected_hash: Option<&str>,
    expected_length: Option<u64>,
    writer: &mut impl Write,
) -> Result<(String, u64)> {
    reject_link(path)?;
    if let Some(hash) = expected_hash {
        validate_hash(hash)?;
    }
    let hash = expected_hash.unwrap_or("export source");
    let file = fs::File::open(path).with_context(|| format!("opening CAS object {hash}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("reading metadata for CAS object {hash}"))?;
    if !metadata.is_file() {
        anyhow::bail!("CAS object {hash} is not a regular file");
    }
    if expected_length.is_some_and(|expected| metadata.len() != expected) {
        anyhow::bail!("CAS object {hash} length differs from its export plan");
    }
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut object_length = 0_u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .with_context(|| format!("streaming CAS object {hash}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        object_length = object_length
            .checked_add(count as u64)
            .context("CAS object length overflow")?;
        if expected_length.is_some_and(|expected| object_length > expected) {
            anyhow::bail!("CAS object {hash} grew beyond its export plan");
        }
        writer.write_all(&buffer[..count])?;
    }
    let actual = hex_encode(&hasher.finalize());
    if expected_hash.is_some_and(|expected| actual != expected) {
        anyhow::bail!("CAS integrity error: expected {hash}, got {actual}");
    }
    if object_length != metadata.len() {
        anyhow::bail!("CAS object {hash} changed length while reading");
    }
    Ok((actual, object_length))
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
    fn verified_copy_streams_complete_bytes_in_bounded_writes() {
        struct DigestSink {
            digest: Sha256,
            bytes: usize,
            largest_write: usize,
        }
        impl Write for DigestSink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.digest.update(bytes);
                self.bytes += bytes.len();
                self.largest_write = self.largest_write.max(bytes.len());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("object");
        let data = vec![42_u8; 2 * 1024 * 1024 + 13];
        let hash = hex_sha256(&data);
        fs::write(&source, &data).unwrap();
        let mut sink = DigestSink {
            digest: Sha256::new(),
            bytes: 0,
            largest_write: 0,
        };
        copy_verified_file(&source, &hash, data.len() as u64, &mut sink).unwrap();
        assert_eq!(sink.bytes, data.len());
        assert_eq!(hex_encode(&sink.digest.finalize()), hash);
        assert!(sink.largest_write <= 64 * 1024);
    }

    #[test]
    fn verified_copy_rejects_wrong_planned_length_before_output_and_wrong_hash() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("object");
        fs::write(&source, b"original").unwrap();
        let mut output = Vec::new();
        assert!(copy_verified_file(&source, &hex_sha256(b"original"), 7, &mut output).is_err());
        assert!(output.is_empty());
        assert!(copy_verified_file(&source, &"0".repeat(64), 8, &mut output).is_err());
    }

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
    fn put_file_streams_verified_source_and_rejects_changed_identity() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        let source = dir.path().join("staged-object");
        let data = vec![17_u8; 2 * 1024 * 1024 + 19];
        let hash = hex_sha256(&data);
        fs::write(&source, &data).unwrap();

        assert_eq!(cas.put_file(&source, &hash, data.len() as u64).unwrap(), hash);
        assert_eq!(cas.verified_length(&hash).unwrap(), Some(data.len() as u64));

        fs::write(&source, b"changed source").unwrap();
        assert!(cas
            .put_file(&source, &hash, data.len() as u64)
            .is_err());
        assert_eq!(cas.verified_length(&hash).unwrap(), Some(data.len() as u64));
    }

    #[test]
    fn missing_object_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        assert!(cas.get(&"0".repeat(64)).unwrap().is_none());
        assert!(cas.get("../outside").is_err());
    }

    #[test]
    fn verified_range_hashes_full_object_and_returns_only_requested_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let cas = CasStore::open(dir.path().join("objects")).unwrap();
        let data = (0_u8..32).collect::<Vec<_>>();
        let hash = cas.put(&data).unwrap();

        let range = cas
            .get_verified_range(&hash, 7, 5, 5)
            .unwrap()
            .expect("stored object");
        assert_eq!(range.bytes, data[7..12]);
        assert_eq!(range.object_length, data.len() as u64);
        assert!(cas.get_verified_range(&hash, 7, 5, 4).is_err());
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
