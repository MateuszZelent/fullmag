//! Immutable export source fingerprints and lazy structural document reads.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{bail, Context, Result};

pub(crate) const MAX_CONTROL_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct ArchiveFileSnapshot {
    pub byte_count: u64,
    pub content_sha256: String,
}

impl ArchiveFileSnapshot {
    pub fn from_bytes(data: &[u8]) -> Self {
        Self {
            byte_count: data.len() as u64,
            content_sha256: crate::cas::hex_sha256(data),
        }
    }

    pub fn capture(path: &Path) -> Result<Self> {
        let (content_sha256, byte_count) = crate::cas::file_content_identity(path)?;
        Ok(Self {
            byte_count,
            content_sha256,
        })
    }

    pub fn read_control(&self, root: &Path, relative: &str) -> Result<Vec<u8>> {
        if self.byte_count > MAX_CONTROL_DOCUMENT_BYTES {
            bail!("structural export document `{relative}` exceeds metadata budget");
        }
        let path = crate::repository_path::checked_path(root, relative)?;
        let mut data = Vec::new();
        File::open(&path)?
            .take(MAX_CONTROL_DOCUMENT_BYTES + 1)
            .read_to_end(&mut data)?;
        if data.len() as u64 != self.byte_count
            || crate::cas::hex_sha256(&data) != self.content_sha256
        {
            bail!("export document `{relative}` changed since inventory");
        }
        Ok(data)
    }
}

pub(crate) enum ArchiveDocuments<'a> {
    Memory(&'a HashMap<String, Vec<u8>>),
    Files {
        snapshots: &'a HashMap<String, ArchiveFileSnapshot>,
        root: &'a Path,
    },
}

impl<'a> ArchiveDocuments<'a> {
    pub fn keys(&self) -> Box<dyn Iterator<Item = &String> + '_> {
        match self {
            Self::Memory(documents) => Box::new(documents.keys()),
            Self::Files { snapshots, .. } => Box::new(snapshots.keys()),
        }
    }

    pub fn contains_key(&self, path: &str) -> bool {
        match self {
            Self::Memory(documents) => documents.contains_key(path),
            Self::Files { snapshots, .. } => snapshots.contains_key(path),
        }
    }

    /// The caller's explicit typed role determines whether bytes are parsed.
    /// Filename extensions do not activate a structural JSON interpretation.
    pub fn read(&self, path: &str) -> Result<Option<Cow<'a, [u8]>>> {
        match self {
            Self::Memory(documents) => Ok(documents
                .get(path)
                .map(|data| Cow::Borrowed(data.as_slice()))),
            Self::Files { snapshots, root } => snapshots
                .get(path)
                .map(|snapshot| {
                    snapshot
                        .read_control(root, path)
                        .map(Cow::Owned)
                        .with_context(|| format!("reading planned export document `{path}`"))
                })
                .transpose(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_read_rejects_changed_missing_and_oversized_control_sources() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.json");
        std::fs::write(&path, b"{\"version\":1}").unwrap();
        let snapshot = ArchiveFileSnapshot::capture(&path).unwrap();
        assert_eq!(
            snapshot
                .read_control(directory.path(), "control.json")
                .unwrap(),
            b"{\"version\":1}"
        );
        std::fs::write(&path, b"{\"version\":2}").unwrap();
        assert!(snapshot
            .read_control(directory.path(), "control.json")
            .is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(snapshot
            .read_control(directory.path(), "control.json")
            .is_err());
        let oversized = ArchiveFileSnapshot {
            byte_count: MAX_CONTROL_DOCUMENT_BYTES + 1,
            content_sha256: snapshot.content_sha256,
        };
        assert!(oversized
            .read_control(directory.path(), "control.json")
            .is_err());
    }
}
