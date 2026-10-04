//! Durable one-shot acceptance of a staged development handoff.
//!
//! The commit record is an irreversible store boundary. It is published only
//! while the exact global-idle fence is held, and no path in this module
//! removes it or releases its fence.

use std::fs;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{DevelopmentAdmissionFence, SessionStore};
use crate::durability::{atomic_write, confirm_publication};
use crate::repository_path::{checked_path, create_parent, read_bounded_regular_file};

const HANDOFF_COMMIT_SCHEMA: &str = "fullmag.development-handoff-commit.v1";
const HANDOFF_COMMIT_PATH: &str = "development/HANDOFF-COMMIT.json";
const MAX_HANDOFF_COMMIT_BYTES: usize = 16 * 1024;

/// Durable acceptance record for one development handoff.
///
/// This marker is one-shot and remains alongside its admission fence. Its
/// presence is not a receipt for API shutdown or workspace replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentHandoffCommit {
    pub schema: String,
    pub api_instance_id: String,
    pub acquisition_nonce: String,
    pub handoff_id: String,
    pub snapshot_sha256: String,
    pub target_build_id: String,
    pub accepted_store_binding: String,
    pub fence: DevelopmentAdmissionFence,
    pub created_at: DateTime<Utc>,
}

impl DevelopmentHandoffCommit {
    pub fn validate(&self) -> Result<()> {
        if self.schema != HANDOFF_COMMIT_SCHEMA {
            bail!("unsupported development handoff commit schema");
        }
        validate_canonical_uuid(&self.api_instance_id, "API instance ID")?;
        validate_canonical_uuid(&self.acquisition_nonce, "acquisition nonce")?;
        validate_canonical_uuid(&self.handoff_id, "handoff ID")?;
        validate_lower_hex(&self.snapshot_sha256, 64, "snapshot SHA-256")?;
        validate_lower_hex(&self.target_build_id, 64, "target build ID")?;
        validate_lower_hex(&self.accepted_store_binding, 64, "accepted-store binding")?;
        self.fence.validate()?;
        validate_lower_hex(&self.fence.owner_token, 32, "admission fence owner token")?;
        validate_canonical_uuid(&self.fence.nonce, "admission fence nonce")?;
        if self.acquisition_nonce != self.fence.nonce {
            bail!("development handoff acquisition nonce differs from its fence");
        }
        Ok(())
    }
}

impl SessionStore {
    /// Read and validate the bounded immutable handoff commit, if present.
    pub fn read_development_handoff_commit(&self) -> Result<Option<DevelopmentHandoffCommit>> {
        let path = checked_path(&self.root, HANDOFF_COMMIT_PATH)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let bytes =
            read_bounded_regular_file(&self.root, HANDOFF_COMMIT_PATH, MAX_HANDOFF_COMMIT_BYTES)?;
        let record: DevelopmentHandoffCommit =
            serde_json::from_slice(&bytes).context("parsing development handoff commit")?;
        record.validate()?;
        if record.accepted_store_binding != accepted_store_binding_for_root(&self.root)? {
            bail!("development handoff commit accepted-store binding mismatch");
        }
        Ok(Some(record))
    }

    /// Publish the one-shot durable acceptance marker while the exact global
    /// admission fence is held. Any uncertain publication leaves the marker
    /// and fence in place for explicit reconciliation.
    pub fn accept_development_handoff(
        &self,
        expected_fence: &DevelopmentAdmissionFence,
        api_instance_id: &str,
        handoff_id: &str,
        snapshot_sha256: &str,
        target_build_id: &str,
        accepted_store_binding: &str,
    ) -> Result<DevelopmentHandoffCommit> {
        let _writer = self.write_transaction()?;
        expected_fence.validate()?;
        validate_canonical_uuid(api_instance_id, "API instance ID")?;
        validate_canonical_uuid(&expected_fence.nonce, "acquisition nonce")?;
        validate_lower_hex(
            &expected_fence.owner_token,
            32,
            "admission fence owner token",
        )?;
        validate_canonical_uuid(handoff_id, "handoff ID")?;
        validate_lower_hex(snapshot_sha256, 64, "snapshot SHA-256")?;
        validate_lower_hex(target_build_id, 64, "target build ID")?;
        validate_lower_hex(accepted_store_binding, 64, "accepted-store binding")?;
        let actual_store_binding = accepted_store_binding_for_root(&self.root)?;
        if accepted_store_binding != actual_store_binding.as_str() {
            bail!("development handoff accepted-store binding mismatch");
        }

        let current_fence = self
            .read_development_idle_fence()?
            .context("development admission fence is absent")?;
        if &current_fence != expected_fence {
            bail!("development handoff commit fence does not match the held fence");
        }
        ensure_handoff_commit_absent_unlocked(self)?;
        self.ensure_development_global_idle_unlocked()?;

        let record = DevelopmentHandoffCommit {
            schema: HANDOFF_COMMIT_SCHEMA.into(),
            api_instance_id: api_instance_id.into(),
            acquisition_nonce: expected_fence.nonce.clone(),
            handoff_id: handoff_id.into(),
            snapshot_sha256: snapshot_sha256.into(),
            target_build_id: target_build_id.into(),
            accepted_store_binding: accepted_store_binding.into(),
            fence: expected_fence.clone(),
            created_at: Utc::now(),
        };
        record.validate()?;

        let path = create_parent(&self.root, HANDOFF_COMMIT_PATH)?;
        let bytes = serde_json::to_vec_pretty(&record)?;
        atomic_write(&path, &bytes).context("publishing development handoff commit")?;
        confirm_publication(&path).context("confirming development handoff commit durability")?;
        let published = self
            .read_development_handoff_commit()?
            .context("development handoff commit disappeared after publication")?;
        if published != record {
            bail!("development handoff commit read-back differs from the published record");
        }
        Ok(published)
    }
}

/// Refuse any pre-existing entry, without interpreting its contents. This is
/// also used by ordinary fence release so malformed or uncertain commit files
/// keep admission closed.
pub(super) fn ensure_handoff_commit_absent_unlocked(store: &SessionStore) -> Result<()> {
    let path = checked_path(&store.root, HANDOFF_COMMIT_PATH)?;
    match fs::symlink_metadata(path) {
        Ok(_) => bail!("development handoff commit already exists"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_canonical_uuid(value: &str, field: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).context(format!("invalid development {field}"))?;
    if parsed.is_nil() || parsed.to_string() != value {
        bail!("development {field} must be a canonical nonnil UUID");
    }
    Ok(())
}

fn validate_lower_hex(value: &str, length: usize, field: &str) -> Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("development {field} must be {length} lowercase hexadecimal characters");
    }
    Ok(())
}

pub(super) fn accepted_store_binding_for_root(root: &std::path::Path) -> Result<String> {
    // Preserve the existing runtime resolver's canonical-directory spelling:
    // writable_product_state_path appends the (empty) missing suffix even for
    // an existing root. Its trailing separator is part of the local binding.
    let root = fs::canonicalize(root)
        .context("canonicalizing accepted-store root")?
        .join("");
    if !fs::metadata(&root)?.is_dir() {
        bail!("accepted-store root is not a directory");
    }
    let mut hash = Sha256::new();
    hash.update(b"fullmag.accepted-store-binding.v1\0");
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for code in root.as_os_str().encode_wide() {
            hash.update(code.to_le_bytes());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hash.update(root.as_os_str().as_bytes());
    }
    #[cfg(not(any(windows, unix)))]
    {
        bail!("accepted-store binding is unsupported on this platform");
    }
    Ok(format!("{:x}", hash.finalize()))
}
