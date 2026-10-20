//! Durable pre-claim cancellation intents for accepted and queued tasks.
//!
//! An intent is an immutable request record. It does not create an attempt,
//! assign an owner, or project a task lifecycle transition.

use std::fs;
use std::io;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::durability::{atomic_write, confirm_publication};
use crate::repository_path::{
    checked_path, create_parent, read_bounded_regular_file, reject_link, validate_store_id,
};
use crate::store::SessionStore;
use crate::types::{canonical_json_sha256, FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle};

pub const FMS_TASK_CANCELLATION_INTENT_SCHEMA: &str = "task_cancellation_intent.v1";
const MAX_TASK_CANCELLATION_INTENT_BYTES: usize = 256 * 1024;
const MAX_TASK_CANCELLATION_REASON_BYTES: usize = 4096;

/// One immutable request to cancel a task before it receives a new claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsTaskCancellationIntent {
    pub schema_version: String,
    pub cancellation_id: String,
    pub run_id: String,
    pub expected_catalog_revision: u64,
    pub task: FmsTaskCatalogEntry,
    pub reason: String,
    pub created_at: DateTime<Utc>,
    pub request_sha256: String,
}

impl FmsTaskCancellationIntent {
    fn new(
        cancellation_id: &str,
        run_id: &str,
        expected_catalog_revision: u64,
        task: FmsTaskCatalogEntry,
        reason: &str,
    ) -> Result<Self> {
        let mut intent = Self {
            schema_version: FMS_TASK_CANCELLATION_INTENT_SCHEMA.into(),
            cancellation_id: cancellation_id.into(),
            run_id: run_id.into(),
            expected_catalog_revision,
            task,
            reason: reason.into(),
            created_at: Utc::now(),
            request_sha256: String::new(),
        };
        intent.request_sha256 = intent.semantic_sha256();
        intent.validate()?;
        Ok(intent)
    }

    /// Validate the schema, request digest, task snapshot, and metadata bound.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_TASK_CANCELLATION_INTENT_SCHEMA {
            bail!(
                "unsupported task cancellation intent schema `{}`",
                self.schema_version
            );
        }
        validate_store_id(&self.cancellation_id)?;
        validate_store_id(&self.run_id)?;
        if self.expected_catalog_revision == 0 {
            bail!("task cancellation intent expected catalog revision must be positive");
        }
        if self.reason.trim().is_empty() || self.reason.len() > MAX_TASK_CANCELLATION_REASON_BYTES {
            bail!(
                "task cancellation intent reason must be nonempty and at most {} bytes",
                MAX_TASK_CANCELLATION_REASON_BYTES
            );
        }
        validate_unclaimed_task(&self.task, &self.run_id)?;
        if self.request_sha256.len() != 64
            || !self
                .request_sha256
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            bail!("task cancellation intent request_sha256 must be lowercase SHA-256");
        }
        if self.request_sha256 != self.semantic_sha256() {
            bail!("task cancellation intent request_sha256 does not match its contents");
        }
        let encoded = serde_json::to_vec(self)
            .context("serializing task cancellation intent for its metadata bound")?;
        if encoded.len() > MAX_TASK_CANCELLATION_INTENT_BYTES {
            bail!(
                "task cancellation intent metadata exceeds the {}-byte limit",
                MAX_TASK_CANCELLATION_INTENT_BYTES
            );
        }
        Ok(())
    }

    /// Validate a read-model snapshot without publishing or repairing anything.
    pub fn validate_task_scope(
        &self,
        store: &SessionStore,
        task: &FmsTaskCatalogEntry,
        catalog_revision: u64,
    ) -> Result<()> {
        self.validate()?;
        if catalog_revision < self.expected_catalog_revision {
            bail!("cancellation intent expected revision is ahead of its run catalog");
        }
        if catalog_revision == self.expected_catalog_revision {
            if task != &self.task {
                bail!("cancellation intent pre-bump task snapshot differs from run catalog");
            }
            return Ok(());
        }
        validate_replay_scope(
            store,
            &self.task,
            task,
            &self.run_id,
            self.expected_catalog_revision,
            &self.task.task_id,
        )
    }

    fn semantic_sha256(&self) -> String {
        canonical_json_sha256(&json!({
            "schema_version": &self.schema_version,
            "cancellation_id": &self.cancellation_id,
            "run_id": &self.run_id,
            "expected_catalog_revision": self.expected_catalog_revision,
            "task": &self.task,
            "reason": &self.reason,
        }))
    }
}

/// Result of publishing or replaying one task cancellation intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCancellationIntentCommitDisposition {
    Recorded,
    Replayed,
}

/// A request cannot be applied to the current immutable intent or task scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskCancellationIntentConflict {
    IntentConflict,
    CatalogRevision { expected: u64, actual: u64 },
    TaskUnavailable { task_id: String },
    TaskReplaced { task_id: String },
}

impl std::fmt::Display for TaskCancellationIntentConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IntentConflict => write!(
                formatter,
                "a different task cancellation request is already recorded"
            ),
            Self::CatalogRevision { expected, actual } => write!(
                formatter,
                "task cancellation catalog revision conflict: expected {expected}, found {actual}"
            ),
            Self::TaskUnavailable { task_id } => write!(
                formatter,
                "task `{task_id}` is absent or does not have an unclaimed accepted/queued state"
            ),
            Self::TaskReplaced { task_id } => write!(
                formatter,
                "task `{task_id}` changed input or ownership scope after its cancellation intent"
            ),
        }
    }
}

impl std::error::Error for TaskCancellationIntentConflict {}

impl SessionStore {
    /// Read the immutable cancellation intent for a task, if one is published.
    pub fn read_task_cancellation_intent(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<FmsTaskCancellationIntent>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        validate_store_root(self.root())?;
        let relative = task_cancellation_intent_relative_path(run_id, task_id);
        let bytes = match read_bounded_regular_file(
            self.root(),
            &relative,
            MAX_TASK_CANCELLATION_INTENT_BYTES,
        ) {
            Ok(bytes) => bytes,
            Err(error) if is_not_found(&error) => {
                validate_store_root(self.root())?;
                return Ok(None);
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reading task cancellation intent for `{task_id}`"));
            }
        };
        let intent: FmsTaskCancellationIntent =
            serde_json::from_slice(&bytes).context("parsing durable task cancellation intent")?;
        intent.validate()?;
        if intent.run_id != run_id || intent.task.task_id != task_id {
            bail!("task cancellation intent identity does not match its path");
        }
        Ok(Some(intent))
    }

    /// List immutable cancellation intents for one run in task-ID order.
    /// The run catalog remains the caller's enumeration authority; this method
    /// scans only the explicitly named run's flat intent directory.
    pub fn list_task_cancellation_intents(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsTaskCancellationIntent>> {
        validate_store_id(run_id)?;
        validate_store_root(self.root())?;

        if checked_optional_directory(self.root(), "runs")?.is_none() {
            return Ok(Vec::new());
        }
        let run_relative = format!("runs/{run_id}");
        if checked_optional_directory(self.root(), &run_relative)?.is_none() {
            return Ok(Vec::new());
        }
        let relative = format!("runs/{run_id}/task_cancellation_intents");
        let Some(directory) = checked_optional_directory(self.root(), &relative)? else {
            return Ok(Vec::new());
        };

        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                validate_store_root(self.root())?;
                return Ok(Vec::new());
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "listing task cancellation intents in {}",
                        directory.display()
                    )
                });
            }
        };

        // This scan intentionally runs without the session writer: callers
        // such as runtime reconciliation may already hold it, and the writer
        // lease is not reentrant. Instead the scan tolerates exactly the
        // transient states that `atomic_write` legitimately produces in this
        // directory while a concurrent writer publishes an intent: a
        // `.<uuid-v4>.part` staging file, and that staging file vanishing
        // (renamed or removed) between readdir and metadata. Every other
        // unknown entry is still rejected.
        let mut task_ids = Vec::new();
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let filename = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 task cancellation intent filename"))?;
            let staging = is_atomic_write_staging_filename(&filename);
            reject_link(&path)?;
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if staging && error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "reading task cancellation intent entry metadata {}",
                            path.display()
                        )
                    });
                }
            };
            if !metadata.is_file() {
                bail!(
                    "task cancellation intent entry is not a regular file: {}",
                    path.display()
                );
            }
            if staging {
                // Unpublished staging bytes are never an intent; the final
                // `<task_id>.json` name is the only publication.
                continue;
            }
            let task_id = filename.strip_suffix(".json").with_context(|| {
                format!("invalid task cancellation intent filename `{filename}`")
            })?;
            validate_store_id(task_id).with_context(|| {
                format!("invalid task cancellation intent filename `{filename}`")
            })?;
            task_ids.push(task_id.to_owned());
        }

        task_ids.sort();
        if task_ids.windows(2).any(|pair| pair[0] == pair[1]) {
            bail!("task cancellation intent directory contains duplicate task IDs");
        }

        let mut intents = Vec::with_capacity(task_ids.len());
        for task_id in task_ids {
            let intent = self
                .read_task_cancellation_intent(run_id, &task_id)?
                .with_context(|| {
                    format!("listed task cancellation intent `{task_id}` disappeared")
                })?;
            intents.push(intent);
        }
        Ok(intents)
    }

    /// Record or replay a pre-claim cancellation request under the session
    /// writer. The immutable intent is published before its catalog revision
    /// bump so a retry can repair an interrupted projection without replacing
    /// a newer task snapshot.
    pub fn request_task_cancellation_intent(
        &self,
        run_id: &str,
        task_id: &str,
        cancellation_id: &str,
        expected_catalog_revision: u64,
        reason: &str,
    ) -> Result<(
        TaskCancellationIntentCommitDisposition,
        FmsTaskCancellationIntent,
        u64,
    )> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        validate_store_id(cancellation_id)?;
        if expected_catalog_revision == 0 {
            bail!("task cancellation intent expected catalog revision must be positive");
        }
        if reason.trim().is_empty() || reason.len() > MAX_TASK_CANCELLATION_REASON_BYTES {
            bail!(
                "task cancellation intent reason must be nonempty and at most {} bytes",
                MAX_TASK_CANCELLATION_REASON_BYTES
            );
        }

        let _lease = self.write_transaction()?;
        let relative = task_cancellation_intent_relative_path(run_id, task_id);
        let intent_path = checked_path(self.root(), &relative)?;

        if let Some(existing) = self.read_task_cancellation_intent(run_id, task_id)? {
            // This also resolves an earlier post-rename uncertainty before the
            // caller treats the immutable record as a completed publication.
            confirm_publication(&intent_path)?;
            if existing.cancellation_id != cancellation_id
                || existing.run_id != run_id
                || existing.task.task_id != task_id
                || existing.expected_catalog_revision != expected_catalog_revision
                || existing.reason != reason
            {
                return Err(TaskCancellationIntentConflict::IntentConflict.into());
            }

            let mut catalog = self
                .read_run_catalog(run_id)?
                .context("task cancellation intent requires a durable run catalog")?;
            if catalog.revision < expected_catalog_revision {
                return Err(TaskCancellationIntentConflict::CatalogRevision {
                    expected: expected_catalog_revision,
                    actual: catalog.revision,
                }
                .into());
            }
            let current_task = catalog
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .ok_or_else(|| TaskCancellationIntentConflict::TaskReplaced {
                    task_id: task_id.into(),
                })?;

            if catalog.revision == expected_catalog_revision {
                if current_task != &existing.task {
                    return Err(TaskCancellationIntentConflict::TaskReplaced {
                        task_id: task_id.into(),
                    }
                    .into());
                }
                catalog.revision = catalog
                    .revision
                    .checked_add(1)
                    .context("run catalog revision exhausted")?;
                catalog.updated_at = Utc::now();
                let current_revision = catalog.revision;
                self.commit_run_catalog(&catalog)?;
                confirm_run_catalog_publication(self, run_id)?;
                return Ok((
                    TaskCancellationIntentCommitDisposition::Replayed,
                    existing,
                    current_revision,
                ));
            }

            validate_replay_scope(
                self,
                &existing.task,
                current_task,
                run_id,
                expected_catalog_revision,
                task_id,
            )?;
            let current_revision = catalog.revision;
            confirm_run_catalog_publication(self, run_id)?;
            return Ok((
                TaskCancellationIntentCommitDisposition::Replayed,
                existing,
                current_revision,
            ));
        }

        let mut catalog = self
            .read_run_catalog(run_id)?
            .context("task cancellation intent requires a durable run catalog")?;
        if catalog.revision != expected_catalog_revision {
            return Err(TaskCancellationIntentConflict::CatalogRevision {
                expected: expected_catalog_revision,
                actual: catalog.revision,
            }
            .into());
        }
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .cloned()
            .ok_or_else(|| TaskCancellationIntentConflict::TaskUnavailable {
                task_id: task_id.into(),
            })?;
        validate_unclaimed_task(&task, run_id).map_err(|_| {
            TaskCancellationIntentConflict::TaskUnavailable {
                task_id: task_id.into(),
            }
        })?;

        let intent = FmsTaskCancellationIntent::new(
            cancellation_id,
            run_id,
            expected_catalog_revision,
            task,
            reason,
        )?;
        intent.validate()?;
        let data = serde_json::to_vec(&intent)?;
        if data.len() > MAX_TASK_CANCELLATION_INTENT_BYTES {
            bail!("task cancellation intent metadata exceeds its byte budget");
        }
        let path = create_parent(self.root(), &relative)?;
        atomic_write(&path, &data)?;

        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = Utc::now();
        let current_revision = catalog.revision;
        self.commit_run_catalog(&catalog)?;
        Ok((
            TaskCancellationIntentCommitDisposition::Recorded,
            intent,
            current_revision,
        ))
    }
}

fn validate_unclaimed_task(task: &FmsTaskCatalogEntry, run_id: &str) -> Result<()> {
    task.validate(run_id)?;
    if !matches!(
        task.lifecycle,
        FmsTaskLifecycle::Accepted | FmsTaskLifecycle::Queued
    ) || task.attempt_id.is_some()
        || task.resource_id.is_some()
        || task.resolved_input_fingerprint.is_some()
        || task.coordinator_watermark.is_some()
        || task.coordinator_genesis.is_some()
    {
        bail!("task is not an unclaimed accepted or queued task");
    }
    Ok(())
}

fn validate_replay_scope(
    store: &SessionStore,
    snapshot: &FmsTaskCatalogEntry,
    current: &FmsTaskCatalogEntry,
    run_id: &str,
    expected_catalog_revision: u64,
    task_id: &str,
) -> Result<()> {
    if current.task_id != snapshot.task_id
        || current.input_fingerprint != snapshot.input_fingerprint
    {
        return Err(TaskCancellationIntentConflict::TaskReplaced {
            task_id: task_id.into(),
        }
        .into());
    }

    if current.ownership_epoch == snapshot.ownership_epoch
        && current.attempt_id.is_none()
        && current.resource_id.is_none()
        && current.coordinator_watermark.is_none()
        && current.coordinator_genesis.is_none()
    {
        return Ok(());
    }

    let Some(attempt_id) = current.attempt_id.as_deref() else {
        return Err(TaskCancellationIntentConflict::TaskReplaced {
            task_id: task_id.into(),
        }
        .into());
    };
    let Some(admission) = store.read_task_admission(run_id, task_id, attempt_id)? else {
        return Err(TaskCancellationIntentConflict::TaskReplaced {
            task_id: task_id.into(),
        }
        .into());
    };
    if admission.queued_task != *snapshot
        || admission.expected_catalog_revision > expected_catalog_revision
        || current.attempt_id.as_deref() != Some(admission.lease.attempt_id.as_str())
        || current.ownership_epoch != Some(admission.lease.ownership_epoch)
        || current.resource_id.as_deref() != Some(admission.lease.resource_id.as_str())
        || admission.lease.run_id != run_id
        || admission.lease.task_id != task_id
    {
        return Err(TaskCancellationIntentConflict::TaskReplaced {
            task_id: task_id.into(),
        }
        .into());
    }
    Ok(())
}

fn task_cancellation_intent_relative_path(run_id: &str, task_id: &str) -> String {
    format!("runs/{run_id}/task_cancellation_intents/{task_id}.json")
}

/// Match only the unique sibling staging name created by
/// `durability::atomic_write` (`.<hyphenated uuid v4>.part`). Any other
/// non-`.json` name remains an unknown entry and is rejected by the scanner.
fn is_atomic_write_staging_filename(filename: &str) -> bool {
    let Some(stem) = filename
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".part"))
    else {
        return false;
    };
    stem.len() == 36
        && uuid::Uuid::parse_str(stem)
            .map(|uuid| uuid.get_version_num() == 4 && uuid.hyphenated().to_string() == stem)
            .unwrap_or(false)
}

fn checked_optional_directory(
    root: &std::path::Path,
    relative: &str,
) -> Result<Option<std::path::PathBuf>> {
    let path = match checked_path(root, relative) {
        Ok(path) => path,
        Err(error) if is_not_found(&error) => {
            validate_store_root(root)?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    reject_link(&path)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(Some(path)),
        Ok(_) => bail!(
            "task cancellation intent path is not a directory: {}",
            path.display()
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            validate_store_root(root)?;
            Ok(None)
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "checking task cancellation intent directory {}",
                path.display()
            )
        }),
    }
}

fn confirm_run_catalog_publication(store: &SessionStore, run_id: &str) -> Result<()> {
    store
        .read_run_catalog(run_id)?
        .context("confirming task cancellation run catalog publication")?;
    let path = checked_path(store.root(), &format!("runs/{run_id}/run_catalog.json"))?;
    confirm_publication(&path)
}

fn validate_store_root(root: &std::path::Path) -> Result<()> {
    reject_link(root)?;
    let metadata = fs::metadata(root).context("validating session store root")?;
    if !metadata.is_dir() {
        bail!("session store root is not a directory");
    }
    Ok(())
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .root_cause()
        .downcast_ref::<io::Error>()
        .is_some_and(|cause| cause.kind() == io::ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::durability::atomic_write;
    use crate::repository_path::create_parent;
    use crate::types::{FmsTaskReadiness, FMS_RUN_CATALOG_SCHEMA};

    fn unclaimed_task(task_id: &str) -> FmsTaskCatalogEntry {
        FmsTaskCatalogEntry {
            task_id: task_id.into(),
            input_fingerprint: "a".repeat(64),
            lifecycle: FmsTaskLifecycle::Queued,
            readiness: FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: None,
            ownership_epoch: Some(3),
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    fn store_with_catalog(revision: u64) -> (tempfile::TempDir, SessionStore, FmsTaskCatalogEntry) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let task = unclaimed_task("task-cancel-a");
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-cancel".into(),
                revision,
                updated_at: Utc::now(),
                tasks: vec![task.clone()],
            })
            .unwrap();
        (directory, store, task)
    }

    #[test]
    fn records_and_replays_the_same_request_without_replacing_its_timestamp() {
        let (_directory, store, task) = store_with_catalog(1);
        let (first_disposition, first, first_revision) = store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-a",
                1,
                "operator requested cancellation",
            )
            .unwrap();
        assert_eq!(
            first_disposition,
            TaskCancellationIntentCommitDisposition::Recorded
        );
        assert_eq!(first_revision, 2);
        assert_eq!(
            store.read_run_catalog("run-cancel").unwrap().unwrap().tasks,
            vec![task]
        );

        let (replay_disposition, replay, replay_revision) = store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-a",
                1,
                "operator requested cancellation",
            )
            .unwrap();
        assert_eq!(
            replay_disposition,
            TaskCancellationIntentCommitDisposition::Replayed
        );
        assert_eq!(replay, first);
        assert_eq!(replay_revision, 2);
    }

    #[test]
    fn rejects_a_new_request_with_a_stale_catalog_revision() {
        let (_directory, store, _) = store_with_catalog(2);
        let error = store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-a",
                1,
                "operator requested cancellation",
            )
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<TaskCancellationIntentConflict>(),
            Some(TaskCancellationIntentConflict::CatalogRevision {
                expected: 1,
                actual: 2
            })
        ));
    }

    #[test]
    fn rejects_different_request_contents_for_the_same_task() {
        let (_directory, store, _) = store_with_catalog(1);
        store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-a",
                1,
                "first reason",
            )
            .unwrap();
        let error = store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-b",
                1,
                "different reason",
            )
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<TaskCancellationIntentConflict>(),
            Some(TaskCancellationIntentConflict::IntentConflict)
        ));
    }

    #[test]
    fn replay_repairs_a_catalog_revision_bump_after_intent_publication() {
        let (_directory, store, task) = store_with_catalog(1);
        let intent = FmsTaskCancellationIntent::new(
            "cancel-a",
            "run-cancel",
            1,
            task.clone(),
            "operator requested cancellation",
        )
        .unwrap();
        let path = create_parent(
            store.root(),
            &task_cancellation_intent_relative_path("run-cancel", "task-cancel-a"),
        )
        .unwrap();
        atomic_write(&path, &serde_json::to_vec(&intent).unwrap()).unwrap();

        let (disposition, replay, revision) = store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-a",
                1,
                "operator requested cancellation",
            )
            .unwrap();
        assert_eq!(
            disposition,
            TaskCancellationIntentCommitDisposition::Replayed
        );
        assert_eq!(replay, intent);
        assert_eq!(revision, 2);
        assert_eq!(
            store
                .read_run_catalog("run-cancel")
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }

    #[test]
    fn listing_returns_empty_for_a_missing_directory_and_sorts_by_task_id() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        assert!(store
            .list_task_cancellation_intents("run-missing")
            .unwrap()
            .is_empty());

        let task_z = unclaimed_task("task-cancel-z");
        let task_a = unclaimed_task("task-cancel-a");
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-cancel".into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![task_z, task_a],
            })
            .unwrap();
        store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-z",
                "cancel-z",
                1,
                "operator requested cancellation",
            )
            .unwrap();
        store
            .request_task_cancellation_intent(
                "run-cancel",
                "task-cancel-a",
                "cancel-a",
                2,
                "operator requested cancellation",
            )
            .unwrap();

        let intents = store.list_task_cancellation_intents("run-cancel").unwrap();
        assert_eq!(
            intents
                .iter()
                .map(|intent| intent.task.task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["task-cancel-a", "task-cancel-z"]
        );
    }

    #[test]
    fn listing_rejects_extra_filenames_and_corrupt_records() {
        let (_directory, store, _) = store_with_catalog(1);
        let extra = create_parent(
            store.root(),
            "runs/run-cancel/task_cancellation_intents/extra.txt",
        )
        .unwrap();
        atomic_write(&extra, b"{}").unwrap();
        assert!(store.list_task_cancellation_intents("run-cancel").is_err());

        let (_corrupt_directory, corrupt_store, _) = store_with_catalog(1);
        let corrupt = create_parent(
            corrupt_store.root(),
            "runs/run-cancel/task_cancellation_intents/task-cancel-a.json",
        )
        .unwrap();
        atomic_write(&corrupt, b"{").unwrap();
        assert!(corrupt_store
            .list_task_cancellation_intents("run-cancel")
            .is_err());
    }
}
