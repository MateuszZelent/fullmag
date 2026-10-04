//! Durable completion authorization for a committed development handoff.
//!
//! The pending record is the admission gate. The permanent history record is
//! evidence of authorization only; neither record claims that a replacement
//! API is running or that admission has reopened.

use std::fs;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::{DevelopmentHandoffCommit, SessionStore};
use crate::durability::{atomic_write, confirm_publication, sync_directory};
use crate::repository_path::{
    checked_path, create_parent, read_bounded_regular_file, validate_store_id,
};

const COMPLETION_SCHEMA: &str = "fullmag.development-handoff-completion.v1";
const COMPLETION_PATH: &str = "development/HANDOFF-COMPLETION.json";
const AUTHORIZATION_DIRECTORY: &str = "development/completion-authorizations";
const HANDOFF_COMMIT_PATH: &str = "development/HANDOFF-COMMIT.json";
const ADMISSION_FENCE_PATH: &str = "development/ADMISSION-FENCE.json";
const MAX_COMPLETION_BYTES: usize = 64 * 1024;
const RUNTIME_SERVICE_METADATA: [&str; 4] = [
    "runtime-services/APPLICATION.json",
    "runtime-services/OWNER.lock",
    "runtime-services/OWNER.json",
    "runtime-services/LAUNCH.json",
];

/// Identity of the already-started replacement whose completion is being
/// authorized by the caller. The store validates its durable identity fields,
/// but does not infer HTTP, process-exit, or scene-load evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentReplacementIdentity {
    pub api_instance_id: String,
    #[serde(deserialize_with = "deserialize_present_session_id")]
    pub session_id: Option<String>,
    pub session_epoch: u64,
    pub scene_document_sha256: String,
    pub target_build_id: String,
    pub accepted_store_binding: String,
}

impl DevelopmentReplacementIdentity {
    fn validate(&self, commit: &DevelopmentHandoffCommit, actual_binding: &str) -> Result<()> {
        validate_canonical_uuid(&self.api_instance_id, "replacement API instance ID")?;
        if self.api_instance_id == commit.api_instance_id {
            bail!("development replacement API instance must differ from the committed API");
        }
        if let Some(session_id) = &self.session_id {
            validate_store_id(session_id).context("replacement session ID")?;
        }
        let expected_epoch = if self.session_id.is_some() { 1 } else { 0 };
        if self.session_epoch != expected_epoch {
            bail!("development replacement session state and epoch differ");
        }
        validate_lower_hex(
            &self.scene_document_sha256,
            64,
            "replacement scene document digest",
        )?;
        if self.target_build_id != commit.target_build_id {
            bail!("development replacement target build differs from the committed handoff");
        }
        if self.accepted_store_binding != commit.accepted_store_binding
            || self.accepted_store_binding != actual_binding
        {
            bail!("development replacement accepted-store binding mismatch");
        }
        Ok(())
    }
}

/// Durable authorization to finish retirement of one committed handoff.
/// Presence of this history record is not a receipt for open admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentHandoffCompletionAuthorization {
    pub schema: String,
    pub commit: DevelopmentHandoffCommit,
    pub replacement: DevelopmentReplacementIdentity,
    pub created_at: DateTime<Utc>,
}

impl DevelopmentHandoffCompletionAuthorization {
    fn validate(&self, actual_binding: &str) -> Result<()> {
        if self.schema != COMPLETION_SCHEMA {
            bail!("unsupported development handoff completion schema");
        }
        self.commit.validate()?;
        if self.commit.accepted_store_binding != actual_binding {
            bail!("development handoff completion store binding mismatch");
        }
        self.replacement.validate(&self.commit, actual_binding)
    }
}

impl SessionStore {
    /// Read the bounded pending completion authorization, if one is present.
    pub fn read_development_handoff_completion(
        &self,
    ) -> Result<Option<DevelopmentHandoffCompletionAuthorization>> {
        let Some(record) = read_record::<DevelopmentHandoffCompletionAuthorization>(
            &self.root,
            COMPLETION_PATH,
            "development handoff completion",
        )?
        else {
            return Ok(None);
        };
        record.validate(&actual_store_binding(&self.root)?)?;
        Ok(Some(record))
    }

    /// Read immutable authorization history for one canonical handoff UUID.
    pub fn read_development_handoff_completion_authorization(
        &self,
        handoff_id: &str,
    ) -> Result<Option<DevelopmentHandoffCompletionAuthorization>> {
        validate_canonical_uuid(handoff_id, "handoff ID")?;
        let relative = authorization_path(handoff_id);
        let Some(record) = read_record::<DevelopmentHandoffCompletionAuthorization>(
            &self.root,
            &relative,
            "development handoff completion authorization",
        )?
        else {
            return Ok(None);
        };
        record.validate(&actual_store_binding(&self.root)?)?;
        if record.commit.handoff_id != handoff_id {
            bail!("development handoff completion history path identity mismatch");
        }
        Ok(Some(record))
    }

    /// Publish the pending gate and immutable completion authorization after
    /// validating the exact committed fence and global idle state.
    pub fn prepare_development_handoff_completion(
        &self,
        expected_commit: &DevelopmentHandoffCommit,
        replacement: &DevelopmentReplacementIdentity,
    ) -> Result<DevelopmentHandoffCompletionAuthorization> {
        let (_launch_guard, _startup_guard) = acquire_completion_guards(&self.root)?;
        let _writer = self.write_transaction()?;
        let actual_binding = actual_store_binding(&self.root)?;
        expected_commit.validate()?;
        if expected_commit.accepted_store_binding != actual_binding {
            bail!("development handoff completion store binding mismatch");
        }
        let current_commit = self
            .read_development_handoff_commit()?
            .context("development handoff commit is absent")?;
        if &current_commit != expected_commit {
            bail!("development handoff completion commit identity mismatch");
        }
        let current_fence = self
            .read_development_idle_fence()?
            .context("development handoff completion fence is absent")?;
        if current_fence != expected_commit.fence {
            bail!("development handoff completion fence identity mismatch");
        }
        replacement.validate(expected_commit, &actual_binding)?;
        self.ensure_development_global_idle_unlocked()?;
        ensure_no_runtime_service_metadata(&self.root)?;

        let requested = DevelopmentHandoffCompletionAuthorization {
            schema: COMPLETION_SCHEMA.into(),
            commit: expected_commit.clone(),
            replacement: replacement.clone(),
            created_at: Utc::now(),
        };
        requested.validate(&actual_binding)?;

        let existing_pending = self.read_development_handoff_completion()?;
        let existing_history =
            self.read_development_handoff_completion_authorization(&expected_commit.handoff_id)?;
        let authorization = match (existing_pending, existing_history) {
            (Some(pending), Some(history))
                if pending == history
                    && same_authorization_identity(&pending, expected_commit, replacement) =>
            {
                pending
            }
            (Some(pending), None)
                if same_authorization_identity(&pending, expected_commit, replacement) =>
            {
                pending
            }
            (None, None) => requested,
            (Some(_), Some(_)) => {
                bail!("development handoff completion pending/history identity mismatch")
            }
            (Some(_), None) => {
                bail!("development handoff completion pending identity mismatch")
            }
            (None, Some(_)) => {
                bail!("development handoff completion history exists without its pending gate")
            }
        };

        let pending_path = checked_path(&self.root, COMPLETION_PATH)?;
        if path_is_present(&pending_path)? {
            confirm_publication(&pending_path)
                .context("confirming development handoff completion pending gate")?;
        } else {
            let bytes = serde_json::to_vec_pretty(&authorization)?;
            let path = create_parent(&self.root, COMPLETION_PATH)?;
            atomic_write(&path, &bytes)
                .context("publishing development handoff completion pending gate")?;
            confirm_publication(&path)
                .context("confirming development handoff completion pending gate")?;
        }
        if self.read_development_handoff_completion()?.as_ref() != Some(&authorization) {
            bail!("development handoff completion pending read-back mismatch");
        }

        let history_relative = authorization_path(&expected_commit.handoff_id);
        let history_path = checked_path(&self.root, &history_relative)?;
        if path_is_present(&history_path)? {
            let history = self
                .read_development_handoff_completion_authorization(&expected_commit.handoff_id)?
                .context("development handoff completion history disappeared")?;
            if history != authorization {
                bail!("development handoff completion history identity mismatch");
            }
            confirm_publication(&history_path)
                .context("confirming development handoff completion history")?;
        } else {
            let bytes = serde_json::to_vec_pretty(&authorization)?;
            let path = create_parent(&self.root, &history_relative)?;
            atomic_write(&path, &bytes)
                .context("publishing development handoff completion history")?;
            confirm_publication(&path)
                .context("confirming development handoff completion history")?;
        }
        if self
            .read_development_handoff_completion_authorization(&expected_commit.handoff_id)?
            .as_ref()
            != Some(&authorization)
        {
            bail!("development handoff completion history read-back mismatch");
        }
        Ok(authorization)
    }

    /// Retire the exact commit and fence under the pending gate. Removing the
    /// pending file is the final admission-reopen linearization point.
    pub fn finish_development_handoff_completion(
        &self,
        expected: &DevelopmentHandoffCompletionAuthorization,
    ) -> Result<DevelopmentHandoffCompletionAuthorization> {
        let (_launch_guard, _startup_guard) = acquire_completion_guards(&self.root)?;
        let _writer = self.write_transaction()?;
        let actual_binding = actual_store_binding(&self.root)?;
        expected.validate(&actual_binding)?;
        self.ensure_development_global_idle_unlocked()?;
        ensure_no_runtime_service_metadata(&self.root)?;

        let history = self
            .read_development_handoff_completion_authorization(&expected.commit.handoff_id)?
            .context("development handoff completion history is absent")?;
        if &history != expected {
            bail!("development handoff completion history identity mismatch");
        }
        let pending = self.read_development_handoff_completion()?;
        let current_commit = self.read_development_handoff_commit()?;
        let current_fence = self.read_development_idle_fence()?;

        if pending.is_none() {
            if current_commit.is_none() && current_fence.is_none() {
                let history_path =
                    checked_path(&self.root, &authorization_path(&expected.commit.handoff_id))?;
                confirm_publication(&history_path)
                    .context("confirming development handoff completion history")?;
                let pending_path = checked_path(&self.root, COMPLETION_PATH)?;
                sync_directory(
                    pending_path
                        .parent()
                        .context("development completion parent is absent")?,
                )
                .context("confirming development completion admission state")?;
                return Ok(expected.clone());
            }
            bail!("development handoff completion pending gate is absent before retirement");
        }
        if pending.as_ref() != Some(expected) {
            bail!("development handoff completion pending identity mismatch");
        }
        if current_commit
            .as_ref()
            .is_some_and(|value| value != &expected.commit)
        {
            bail!("development handoff completion found a different active commit");
        }
        if current_fence
            .as_ref()
            .is_some_and(|value| value != &expected.commit.fence)
        {
            bail!("development handoff completion found a different active fence");
        }

        let pending_path = checked_path(&self.root, COMPLETION_PATH)?;
        let history_path =
            checked_path(&self.root, &authorization_path(&expected.commit.handoff_id))?;
        confirm_publication(&pending_path)
            .context("confirming development handoff completion pending gate")?;
        confirm_publication(&history_path)
            .context("confirming development handoff completion history")?;
        if self.read_development_handoff_completion()?.as_ref() != Some(expected)
            || self
                .read_development_handoff_completion_authorization(&expected.commit.handoff_id)?
                .as_ref()
                != Some(expected)
        {
            bail!("development handoff completion records changed before retirement");
        }

        // Recheck exact ownership immediately before each deletion. The
        // WRITER lease excludes every cooperating store writer throughout.
        if current_commit.is_some() {
            if self.read_development_handoff_commit()?.as_ref() != Some(&expected.commit) {
                bail!("development handoff commit changed before completion retirement");
            }
            remove_and_sync(&self.root, HANDOFF_COMMIT_PATH)?;
        }
        if current_fence.is_some() {
            if self.read_development_idle_fence()?.as_ref() != Some(&expected.commit.fence) {
                bail!("development admission fence changed before completion retirement");
            }
            remove_and_sync(&self.root, ADMISSION_FENCE_PATH)?;
        }

        if self.read_development_handoff_completion()?.as_ref() != Some(expected)
            || self.read_development_handoff_commit()?.is_some()
            || self.read_development_idle_fence()?.is_some()
        {
            bail!("development handoff completion state changed before gate removal");
        }
        ensure_no_runtime_service_metadata(&self.root)?;
        let pending_path = checked_path(&self.root, COMPLETION_PATH)?;
        fs::remove_file(&pending_path).context(
            "development handoff completion admission reopening outcome unknown after pending removal",
        )?;
        sync_directory(
            pending_path
                .parent()
                .context("development completion parent is absent")?,
        )
        .context(
            "development handoff completion admission reopening outcome unknown after pending removal",
        )?;
        Ok(expected.clone())
    }
}

/// Refuse acquisition/release of an ordinary fence while any pending
/// completion entry exists, including a malformed or non-file entry.
pub(super) fn ensure_completion_pending_absent_unlocked(store: &SessionStore) -> Result<()> {
    let path = checked_path(&store.root, COMPLETION_PATH)?;
    if path_is_present(&path)? {
        bail!("development handoff completion is pending");
    }
    Ok(())
}

fn same_authorization_identity(
    authorization: &DevelopmentHandoffCompletionAuthorization,
    commit: &DevelopmentHandoffCommit,
    replacement: &DevelopmentReplacementIdentity,
) -> bool {
    authorization.schema == COMPLETION_SCHEMA
        && &authorization.commit == commit
        && &authorization.replacement == replacement
}

fn authorization_path(handoff_id: &str) -> String {
    format!("{AUTHORIZATION_DIRECTORY}/{handoff_id}.json")
}

fn read_record<T: DeserializeOwned>(
    root: &std::path::Path,
    relative: &str,
    label: &str,
) -> Result<Option<T>> {
    let path = checked_path(root, relative)?;
    if !path_is_present(&path)? {
        return Ok(None);
    }
    let bytes = read_bounded_regular_file(root, relative, MAX_COMPLETION_BYTES)?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {label}"))
        .map(Some)
}

fn path_is_present(path: &std::path::Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn ensure_no_runtime_service_metadata(root: &std::path::Path) -> Result<()> {
    for relative in RUNTIME_SERVICE_METADATA {
        let path = checked_path(root, relative)?;
        if path_is_present(&path)? {
            bail!("runtime service metadata remains during development handoff completion");
        }
    }
    Ok(())
}

fn remove_and_sync(root: &std::path::Path, relative: &str) -> Result<()> {
    let path = checked_path(root, relative)?;
    fs::remove_file(&path).with_context(|| format!("removing {relative}"))?;
    sync_directory(
        path.parent()
            .context("development metadata has no parent")?,
    )
}

fn actual_store_binding(root: &std::path::Path) -> Result<String> {
    super::development_commit::accepted_store_binding_for_root(root)
}

fn acquire_completion_guards(
    root: &std::path::Path,
) -> Result<(
    crate::runtime_service::RuntimeServiceLaunchGuard,
    crate::runtime_service_startup::RuntimeServiceStartupGuard,
)> {
    let Some(launch) = crate::runtime_service::RuntimeServiceLaunchGuard::try_acquire(root)? else {
        bail!("runtime service launch is active during development handoff completion");
    };
    let Some(startup) =
        crate::runtime_service_startup::RuntimeServiceStartupGuard::try_acquire(root)?
    else {
        bail!("runtime service startup is active during development handoff completion");
    };
    Ok((launch, startup))
}

fn validate_canonical_uuid(value: &str, field: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).context(format!("invalid {field}"))?;
    if parsed.is_nil() || parsed.to_string() != value {
        bail!("{field} must be a canonical nonnil UUID");
    }
    Ok(())
}

fn validate_lower_hex(value: &str, length: usize, field: &str) -> Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be {length} lowercase hexadecimal characters");
    }
    Ok(())
}

fn deserialize_present_session_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}
