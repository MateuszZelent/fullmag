//! Retained-current field metadata. No filesystem, execution admission or scientific qualification.
mod manifest;
mod manifest_v2;
mod evidence_v2;
mod package;
mod package_v2;
mod versioned;
mod parent_evidence;

pub use manifest::*;
pub use manifest_v2::*;
pub use package_v2::*;
pub use versioned::*;
pub use package::{
    decode_retained_current_field_bundle, encode_retained_current_field_bundle,
    RetainedCurrentFieldBundle, retained_current_field_manifest_length,
};
pub use parent_evidence::*;

use crate::{artifact_json::UnambiguousJson, ArtifactError};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_RECORD_BYTES_TOTAL: u64 = 64 * 1024 * 1024;
pub const MAX_RECORDS: usize = 16_384;
pub const MAX_CLOSURE_OBJECTS: usize = 100_000;
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

pub(super) fn require(ok: bool, message: &str) -> Result<(), ArtifactError> {
    if ok {
        Ok(())
    } else {
        Err(ArtifactError {
            message: format!("retained current: {message}"),
        })
    }
}
pub(super) fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
pub(super) fn bare_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(bare_digest)
}
pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ArtifactError> {
    require(
        !bytes.is_empty() && bytes.len() as u64 <= MAX_METADATA_BYTES,
        "metadata byte budget",
    )?;
    let json = serde_json::from_slice::<UnambiguousJson>(bytes).map_err(|e| ArtifactError {
        message: format!("retained current JSON: {e}"),
    })?;
    serde_json::from_value(json.0).map_err(|e| ArtifactError {
        message: format!("retained current shape: {e}"),
    })
}

/// Check a programmatically constructed DTO before cloning it into a JSON signature tree.
pub(super) fn metadata_bound(value: &impl Serialize) -> Result<(), ArtifactError> {
    struct Budget(u64);
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let length = self
                .0
                .checked_add(bytes.len() as u64)
                .filter(|n| *n <= MAX_METADATA_BYTES)
                .ok_or_else(|| std::io::Error::other("retained metadata budget"))?;
            self.0 = length;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Budget(0), value).map_err(|error| ArtifactError {
        message: format!("retained metadata budget: {error}"),
    })
}

/// A bounded pinned object, not a verified object or an authorization token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CasObjectRef {
    pub object_ref: String,
    pub byte_count: u64,
}
impl CasObjectRef {
    pub fn validate(&self, maximum: u64) -> Result<(), ArtifactError> {
        require(
            bare_digest(&self.object_ref) && self.byte_count > 0 && self.byte_count <= maximum,
            "invalid CAS reference or byte budget",
        )
    }
}

/// Explicit graph roles; callers must validate the typed publication before retaining these edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedCurrentDependencyRole {
    ParentPackage,
    ParentOutputManifest,
    ParentEvidenceCapsule,
    AcceptedProvenanceManifest,
    AcceptedProvenanceRecord,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedCurrentDependency {
    pub role: RetainedCurrentDependencyRole,
    pub object: CasObjectRef,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_v2;
