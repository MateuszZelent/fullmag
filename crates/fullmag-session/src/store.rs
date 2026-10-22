//! Internal `SessionStore` — directory-based persistence layer.
//!
//! Layout under `.fullmag/local-live/session-store/`:
//! ```text
//! session-store/
//! ├── CURRENT          // path to the latest session manifest (atomic pointer)
//! ├── WRITER.lock      // stable native lock descriptor
//! ├── WRITER.owner.json // atomic owner metadata
//! ├── manifests/       // session manifest JSON files
//! ├── runs/            // per-run intent/catalog/admissions/leases/manifests
//! ├── scheduler_pools/ // local operational fairness cursors
//! ├── live_command_journals/ // bounded current-workspace command snapshots
//! ├── objects/         // CAS blob store
//! │   └── sha256/
//! ├── temp/            // in-flight writes
//! └── recovery/        // crash recovery snapshots
//! ```

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};

use crate::cas::CasStore;
use crate::durability::{
    atomic_write, atomic_write_verified_file, confirm_publication, sync_directory,
};
use crate::repository_path::{
    checked_path, create_parent, read_bounded_regular_file, reject_link, validate_store_id,
};
use crate::solution_set_catalog::SolutionSetCatalog;
use crate::types::*;
use crate::writer::{WriteTransaction, Writer};

const MAX_TASK_ADMISSION_RECORD_BYTES: usize = 1024 * 1024;
const MAX_PROVIDER_JOB_SUBMISSION_BYTES: usize = 64 * 1024;

fn read_present_directory(root: &Path, relative: &str, label: &str) -> Result<Option<PathBuf>> {
    let path = checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            reject_link(&path)?;
            if !metadata.is_dir() {
                anyhow::bail!("{label} path is not a directory");
            }
            Ok(Some(path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("checking {label} directory")),
    }
}

fn read_optional_bounded_regular_file(
    root: &Path,
    relative: &str,
    maximum: usize,
    label: &str,
) -> Result<Option<Vec<u8>>> {
    let path = checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => anyhow::bail!("{label} must be a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("checking {label}")),
    }
    Ok(Some(
        read_bounded_regular_file(root, relative, maximum)
            .with_context(|| format!("reading {label}"))?,
    ))
}

#[path = "accepted_start_gate.rs"]
mod accepted_start_gate;
pub use accepted_start_gate::{ACCEPTED_RUN_START_POLICY_KEY, AcceptedRunStartRelease};
mod development_commit;
mod development_completion;
mod development_fence;
pub use development_commit::DevelopmentHandoffCommit;
pub use development_completion::{
    DevelopmentHandoffCompletionAuthorization, DevelopmentReplacementIdentity,
};
pub use development_fence::DevelopmentAdmissionFence;

/// Admission was refused because the durable non-terminal run backlog reached
/// its configured bound. The check and accepted-intent publication happen
/// under the same native writer lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunBacklogFull {
    pub active_run_count: usize,
    pub limit: usize,
}

impl std::fmt::Display for RunBacklogFull {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "accepted run backlog is full ({}/{})",
            self.active_run_count, self.limit
        )
    }
}

impl std::error::Error for RunBacklogFull {}

/// A checkpoint cannot be deleted because a durable record still names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointStillReferenced {
    pub run_id: String,
    pub checkpoint_id: String,
    pub referenced_by: String,
}

impl std::fmt::Display for CheckpointStillReferenced {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "checkpoint `{}` of run `{}` is still referenced by {}",
            self.checkpoint_id, self.run_id, self.referenced_by
        )
    }
}

impl std::error::Error for CheckpointStillReferenced {}

/// The internal session store backed by a directory tree and a CAS.
pub struct SessionStore {
    root: PathBuf,
    cas: CasStore,
    solution_sets: SolutionSetCatalog,
    writer: Arc<Writer>,
    explicit_lease: Mutex<Option<WriteTransaction>>,
}

fn atomic_write_confirmed(path: &Path, data: &[u8]) -> Result<()> {
    match atomic_write(path, data) {
        Ok(()) => Ok(()),
        Err(error) => match fs::read(path) {
            Ok(published) if published == data => confirm_publication(path),
            _ => Err(error),
        },
    }
}

fn register_solution_object(
    objects: &mut BTreeMap<String, u64>,
    object_ref: &str,
    byte_length: u64,
) -> Result<()> {
    if let Some(previous_length) = objects.insert(object_ref.to_string(), byte_length) {
        if previous_length != byte_length {
            anyhow::bail!(
                "solution-set CAS object `{object_ref}` has conflicting declared lengths"
            );
        }
    }
    Ok(())
}

impl SessionStore {
    /// Open or initialize a `SessionStore` at the given root directory.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        crate::writer::require_local_filesystem(&root)?;
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        let mut initialized = true;
        for sub in [
            "manifests",
            "runs",
            "scheduler_pools",
            "live_command_journals",
            "recovery",
            "temp",
            "objects/sha256",
            "objects/pins",
        ] {
            initialized &= checked_path(&root, sub)?.is_dir();
        }
        if !initialized {
            let _lease = writer.acquire()?;
            for sub in [
                "manifests",
                "runs",
                "scheduler_pools",
                "live_command_journals",
                "recovery",
                "temp",
                "objects",
            ] {
                fs::create_dir_all(checked_path(&root, sub)?)?;
            }
            let _ = CasStore::with_writer(checked_path(&root, "objects")?, writer.clone())?;
            sync_directory(&root)?;
        }
        let cas = CasStore::existing(checked_path(&root, "objects")?, writer.clone())?;
        let solution_sets = SolutionSetCatalog::with_writer(root.clone(), writer.clone())?;
        let store = Self {
            root,
            cas,
            solution_sets,
            writer,
            explicit_lease: Mutex::new(None),
        };
        store.release_solution_set_pins()?;
        Ok(store)
    }

    /// Open without creating repository directories or files. Mutations still
    /// require the same writer lease; useful for inspection and GC previews.
    pub fn open_existing(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        let cas = CasStore::existing(checked_path(&root, "objects")?, writer.clone())?;
        let solution_sets = SolutionSetCatalog::with_existing_writer(root.clone(), writer.clone());
        Ok(Self {
            root,
            cas,
            solution_sets,
            writer,
            explicit_lease: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn cas(&self) -> &CasStore {
        &self.cas
    }

    pub fn solution_sets(&self) -> &SolutionSetCatalog {
        &self.solution_sets
    }

    pub fn publish_solution_set(&self, solution: &fullmag_quantities::SolutionSet) -> Result<()> {
        solution
            .validate()
            .context("validating solution-set before CAS publication barrier")?;
        let _lease = self.write_transaction()?;
        crate::solution_tensor_source::verify_solution_tensor_run_owner(&self.root, solution)?;
        crate::materialized_dataset::verify_materialized_datasets_for_solution(
            &self.root, &self.cas, solution,
        )?;
        let mut referenced_objects = BTreeMap::new();
        for geometry in crate::solution_field_geometry::verify_field_geometries_for_solution(
            &self.root, &self.cas, solution,
        )? {
            register_solution_object(
                &mut referenced_objects,
                &geometry.object_ref,
                geometry.byte_length,
            )?;
        }
        for member in &solution.members {
            for artifact in &member.artifacts {
                if artifact.schema_id == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA {
                    let descriptor = crate::solution_tensor_source::verify_solution_tensor_payload(
                        &self.cas, artifact,
                    )?;
                    for chunk in &descriptor.chunks {
                        register_solution_object(
                            &mut referenced_objects,
                            &chunk.object_ref,
                            chunk.length as u64,
                        )?;
                    }
                }
                register_solution_object(
                    &mut referenced_objects,
                    &artifact.object_ref,
                    artifact.byte_length,
                )?;
            }
        }
        for coverage in &solution.coverage {
            for segment in &coverage.segments {
                register_solution_object(
                    &mut referenced_objects,
                    &segment.object_ref,
                    segment.byte_length,
                )?;
            }
        }
        for (object_ref, expected_length) in &referenced_objects {
            let actual_length = self
                .cas
                .verified_length(object_ref)?
                .with_context(|| format!("solution-set CAS object `{object_ref}` is missing"))?;
            if actual_length != *expected_length {
                anyhow::bail!(
                    "solution-set CAS object `{object_ref}` length mismatch: expected {expected_length}, found {actual_length}"
                );
            }
        }
        self.solution_sets.publish_locked(solution)?;
        let rooted_refs = referenced_objects.into_keys().collect();
        self.cas.release_referenced_pins(&rooted_refs)
    }

    /// Bind a multi-file operation to one native writer lease.
    pub fn write_transaction(&self) -> Result<WriteTransaction> {
        self.writer.acquire()
    }

    // ── Sessions ───────────────────────────────────────────────────────

    /// Persist a session manifest and update the `CURRENT` pointer.
    pub fn commit_session(&self, manifest: &FmsSessionManifest) -> Result<()> {
        validate_store_id(&manifest.session_id)?;
        validate_session_manifest_schema(manifest)?;
        let _lease = self.write_transaction()?;
        validate_session_references(&self.root, manifest)?;
        let json = serde_json::to_vec_pretty(manifest)?;
        // Immutable generation: a crash cannot update a manifest behind the
        // old CURRENT pointer before the new generation is committed.
        let generation = format!("generation-{}", uuid::Uuid::new_v4());
        let path = create_parent(&self.root, &format!("manifests/{generation}.json"))?;
        atomic_write(&path, &json)?;
        // Atomically update CURRENT to point to this session.
        let current_path = checked_path(&self.root, "CURRENT")?;
        atomic_write(&current_path, generation.as_bytes())?;
        Ok(())
    }

    /// Read the currently active session manifest, if any.
    pub fn current_session(&self) -> Result<Option<FmsSessionManifest>> {
        let current_path = checked_path(&self.root, "CURRENT")?;
        if !current_path.exists() {
            return Ok(None);
        }
        let session_id = fs::read_to_string(&current_path)?.trim().to_string();
        validate_store_id(&session_id)?;
        let manifest_path = checked_path(&self.root, &format!("manifests/{session_id}.json"))?;
        if !manifest_path.exists() {
            anyhow::bail!("CURRENT points to a missing manifest");
        }
        let data = fs::read(&manifest_path)?;
        let manifest: FmsSessionManifest = serde_json::from_slice(&data)
            .with_context(|| format!("parsing session manifest {}", manifest_path.display()))?;
        validate_store_id(&manifest.session_id)?;
        validate_session_manifest_schema(&manifest)?;
        if !session_id.starts_with("generation-") && session_id != manifest.session_id {
            anyhow::bail!("CURRENT manifest identity or schema mismatch");
        }
        Ok(Some(manifest))
    }

    /// Atomically publish the bounded command journal for one local-live
    /// session. The payload schema remains owned by the API layer, while this
    /// store owns path containment, the single-writer lease and durability.
    ///
    /// Each publication first writes an immutable generation and then advances
    /// `CURRENT`. Old generations are best-effort compacted only after the new
    /// pointer is durable, so an interrupted replacement never destroys the
    /// last readable journal.
    pub fn commit_live_command_journal(&self, session_id: &str, data: &[u8]) -> Result<()> {
        validate_store_id(session_id)?;
        let _lease = self.write_transaction()?;
        let journal_root =
            checked_path(&self.root, &format!("live_command_journals/{session_id}"))?;
        reject_link(&journal_root)?;
        fs::create_dir_all(&journal_root)?;
        let generations = journal_root.join("generations");
        reject_link(&generations)?;
        fs::create_dir_all(&generations)?;

        let generation = format!("generation-{}", uuid::Uuid::new_v4());
        let generation_path = generations.join(format!("{generation}.json"));
        atomic_write_confirmed(&generation_path, data)?;
        let current_path = journal_root.join("CURRENT");
        atomic_write_confirmed(&current_path, generation.as_bytes())?;

        // The journal payload is a complete bounded snapshot. Once CURRENT is
        // durable, older generations are no longer needed for recovery.
        let compacted = (|| -> Result<()> {
            for entry in fs::read_dir(&generations)? {
                let entry = entry?;
                reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("live command journal generation is not a file");
                }
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if file_name == format!("{generation}.json") {
                    continue;
                }
                if !file_name.starts_with("generation-") || !file_name.ends_with(".json") {
                    anyhow::bail!("unknown live command journal generation `{file_name}`");
                }
                fs::remove_file(entry.path())?;
            }
            sync_directory(&generations)
        })();
        if let Err(error) = compacted {
            tracing::warn!(
                path = %generations.display(),
                %error,
                "could not compact obsolete live command journal generations"
            );
        }
        Ok(())
    }

    /// Read the latest atomically published local-live command journal.
    pub fn read_live_command_journal(&self, session_id: &str) -> Result<Option<Vec<u8>>> {
        validate_store_id(session_id)?;
        let journal_root =
            checked_path(&self.root, &format!("live_command_journals/{session_id}"))?;
        if !journal_root.exists() {
            return Ok(None);
        }
        reject_link(&journal_root)?;
        let current_path = journal_root.join("CURRENT");
        if !current_path.exists() {
            return Ok(None);
        }
        reject_link(&current_path)?;
        let generation = fs::read_to_string(&current_path)?.trim().to_string();
        validate_store_id(&generation)?;
        if !generation.starts_with("generation-") {
            anyhow::bail!("live command journal CURRENT has an invalid generation");
        }
        let generation_path = journal_root
            .join("generations")
            .join(format!("{generation}.json"));
        reject_link(&generation_path)?;
        if !generation_path.is_file() {
            anyhow::bail!("live command journal CURRENT points to a missing generation");
        }
        Ok(Some(fs::read(generation_path)?))
    }

    // ── Runs ───────────────────────────────────────────────────────────

    /// Publish the immutable parent intent for a batch before child runs are
    /// acknowledged. The request snapshot and source/manifest CAS references
    /// share one writer lease and one atomic record publication boundary.
    pub fn commit_batch_intent(
        &self,
        intent: &FmsBatchIntent,
    ) -> Result<BatchIntentCommitDisposition> {
        intent.validate()?;
        let json = serde_json::to_vec_pretty(intent)?;
        if json.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            anyhow::bail!("batch intent exceeds metadata budget");
        }

        let _lease = self.write_transaction()?;
        for object_ref in [
            intent.definition_object_ref.as_str(),
            intent.study_object_ref.as_str(),
            intent.study_catalog_object_ref.as_str(),
        ] {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("batch intent CAS object `{object_ref}` is missing"))?;
        }
        let manifest_bytes = self
            .cas
            .get(&intent.manifest_object_ref)?
            .context("batch expansion manifest object is missing")?;
        intent.validate_manifest_bytes(&manifest_bytes)?;
        for object_ref in intent.asset_object_refs.values() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("batch asset object `{object_ref}` is missing"))?;
        }

        if let Some(existing) = self.find_batch_intent_unlocked(&intent.idempotency_key)? {
            // OutputStorage is resolved by the server at the first Submit.
            // A retry of the same client request must replay that accepted
            // snapshot even if workspace defaults have since changed.
            if existing.batch_id == intent.batch_id
                && existing.specification.get("request") == intent.specification.get("request")
                && existing.specification.get("manifest_sha256")
                    == intent.specification.get("manifest_sha256")
                && existing.manifest_object_ref == intent.manifest_object_ref
                && existing.definition_object_ref == intent.definition_object_ref
                && existing.study_object_ref == intent.study_object_ref
                && existing.study_catalog_object_ref == intent.study_catalog_object_ref
                && existing.asset_object_refs == intent.asset_object_refs
            {
                return Ok(BatchIntentCommitDisposition::Replayed {
                    batch_id: existing.batch_id,
                });
            }
            anyhow::bail!(
                "batch idempotency key `{}` was already accepted for another payload",
                intent.idempotency_key
            );
        }

        self.ensure_development_admission_open_unlocked()?;
        let relative_path = format!("batches/{}/batch_intent.json", intent.batch_id);
        let path = checked_path(&self.root, &relative_path)?;
        let existing = match fs::symlink_metadata(&path) {
            Ok(_) => {
                reject_link(&path)?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).with_context(|| format!("checking {relative_path}")),
        };
        if existing {
            anyhow::bail!(
                "batch intent path already exists for batch `{}`",
                intent.batch_id
            );
        }
        let path = create_parent(&self.root, &relative_path)?;
        atomic_write(&path, &json)?;
        Ok(BatchIntentCommitDisposition::Accepted)
    }

    /// Read the durable parent intent for one batch, if present.
    pub fn read_batch_intent(&self, batch_id: &str) -> Result<Option<FmsBatchIntent>> {
        validate_store_id(batch_id)?;
        let relative = format!("batches/{batch_id}/batch_intent.json");
        let path = checked_path(&self.root, &relative)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => reject_link(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("checking {relative}")),
        }
        if !path.is_file() {
            anyhow::bail!("batch intent path is not a file");
        }
        reject_link(&path)?;
        let mut data = Vec::new();
        fs::File::open(&path)?
            .take(crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES + 1)
            .read_to_end(&mut data)?;
        if data.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            anyhow::bail!("batch intent exceeds metadata budget");
        }
        let intent: FmsBatchIntent = serde_json::from_slice(&data)?;
        intent.validate()?;
        if intent.batch_id != batch_id {
            anyhow::bail!("batch intent identity does not match its path");
        }
        let manifest_bytes = self
            .cas
            .get(&intent.manifest_object_ref)?
            .context("batch expansion manifest object is missing")?;
        intent.validate_manifest_bytes(&manifest_bytes)?;
        Ok(Some(intent))
    }

    /// Find an accepted batch intent by idempotency key after a process restart.
    pub fn find_batch_intent(&self, idempotency_key: &str) -> Result<Option<FmsBatchIntent>> {
        validate_store_id(idempotency_key)?;
        self.find_batch_intent_unlocked(idempotency_key)
    }

    /// Enumerate durable batch parents and reject linked or malformed entries.
    pub fn list_batch_intents(&self) -> Result<Vec<FmsBatchIntent>> {
        let directory = checked_path(&self.root, "batches")?;
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut intents = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported batch entry `{}`", entry.path().display());
            }
            let batch_id = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 batch identifier"))?;
            validate_store_id(&batch_id)?;
            let intent = self
                .read_batch_intent(&batch_id)?
                .with_context(|| format!("batch directory `{batch_id}` has no intent"))?;
            intents.push(intent);
        }
        intents.sort_by(|left, right| {
            right
                .accepted_at
                .cmp(&left.accepted_at)
                .then_with(|| right.batch_id.cmp(&left.batch_id))
        });
        Ok(intents)
    }

    fn find_batch_intent_unlocked(&self, idempotency_key: &str) -> Result<Option<FmsBatchIntent>> {
        let mut found = None;
        for intent in self.list_batch_intents()? {
            if intent.idempotency_key != idempotency_key {
                continue;
            }
            if found.is_some() {
                anyhow::bail!("batch idempotency key `{idempotency_key}` appears more than once");
            }
            found = Some(intent);
        }
        Ok(found)
    }

    /// Read the durable expansion cursor for one accepted batch.
    pub fn read_batch_expansion_progress(
        &self,
        batch_id: &str,
    ) -> Result<Option<FmsBatchExpansionProgress>> {
        validate_store_id(batch_id)?;
        let relative = format!("batches/{batch_id}/expansion_progress.json");
        let path = checked_path(&self.root, &relative)?;
        if !path.exists() {
            return Ok(None);
        }
        reject_link(&path)?;
        let mut data = Vec::new();
        fs::File::open(&path)?
            .take(crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES + 1)
            .read_to_end(&mut data)?;
        if data.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            anyhow::bail!("batch expansion progress exceeds metadata budget");
        }
        let progress: FmsBatchExpansionProgress = serde_json::from_slice(&data)?;
        let intent = self
            .read_batch_intent(batch_id)?
            .context("batch expansion progress has no parent intent")?;
        let manifest_bytes = self
            .cas
            .get(&intent.manifest_object_ref)?
            .context("batch expansion manifest object is missing")?;
        progress.validate_for_manifest(&intent, &manifest_bytes)?;
        Ok(Some(progress))
    }

    /// Validate a batch command against its current durable revision and
    /// lifecycle without publishing it. Callers composing a retry with this
    /// append can hold one outer write transaction across validation and use.
    pub fn validate_batch_command(
        &self,
        command: &FmsBatchCommandIntent,
    ) -> Result<BatchCommandCommitDisposition> {
        command.validate()?;
        let _lease = self.write_transaction()?;
        let intent = self
            .read_batch_intent(&command.batch_id)?
            .context("batch command parent intent is missing")?;
        let manifest_bytes = self
            .cas
            .get(&intent.manifest_object_ref)?
            .context("batch expansion manifest object is missing")?;
        intent.validate_manifest_bytes(&manifest_bytes)?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)?;
        let total_cases = manifest
            .get("cases")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .context("batch expansion manifest has no cases array")?;
        let total_cases = u64::try_from(total_cases)?;
        let progress = match self.read_batch_expansion_progress(&command.batch_id)? {
            Some(progress) => progress,
            None => FmsBatchExpansionProgress::new(&intent, total_cases, 0, 1)?,
        };
        let (next, disposition) = progress.with_command(command)?;
        if disposition == BatchCommandCommitDisposition::Accepted {
            next.validate_for_manifest(&intent, &manifest_bytes)?;
        }
        Ok(disposition)
    }

    /// Append a durable batch command to the expansion checkpoint. The
    /// checkpoint writer serializes commands against child publication.
    pub fn commit_batch_command(
        &self,
        command: &FmsBatchCommandIntent,
    ) -> Result<BatchCommandCommitDisposition> {
        command.validate()?;
        let _lease = self.write_transaction()?;
        let intent = self
            .read_batch_intent(&command.batch_id)?
            .context("batch command parent intent is missing")?;
        let manifest_bytes = self
            .cas
            .get(&intent.manifest_object_ref)?
            .context("batch expansion manifest object is missing")?;
        intent.validate_manifest_bytes(&manifest_bytes)?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)?;
        let total_cases = manifest
            .get("cases")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .context("batch expansion manifest has no cases array")?;
        let total_cases = u64::try_from(total_cases)?;
        let progress = match self.read_batch_expansion_progress(&command.batch_id)? {
            Some(progress) => progress,
            None => FmsBatchExpansionProgress::new(&intent, total_cases, 0, 1)?,
        };
        let (progress, disposition) = progress.with_command(command)?;
        if disposition == BatchCommandCommitDisposition::Replayed {
            return Ok(disposition);
        }
        progress.validate_for_manifest(&intent, &manifest_bytes)?;
        let json = serde_json::to_vec_pretty(&progress)?;
        if json.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            anyhow::bail!("batch expansion progress exceeds metadata budget");
        }
        let relative = format!("batches/{}/expansion_progress.json", command.batch_id);
        let path = create_parent(&self.root, &relative)?;
        atomic_write(&path, &json)?;
        Ok(disposition)
    }

    /// Advance a batch's durable child-publication cursor under a sequence
    /// fence. Replaying the exact latest checkpoint is idempotent.
    pub fn commit_batch_expansion_progress(
        &self,
        expected_sequence: u64,
        progress: &FmsBatchExpansionProgress,
    ) -> Result<BatchExpansionProgressCommitDisposition> {
        progress.validate()?;
        let json = serde_json::to_vec_pretty(progress)?;
        if json.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            anyhow::bail!("batch expansion progress exceeds metadata budget");
        }
        let _lease = self.write_transaction()?;
        let intent = self
            .read_batch_intent(&progress.batch_id)?
            .context("batch expansion progress parent intent is missing")?;
        let manifest_bytes = self
            .cas
            .get(&intent.manifest_object_ref)?
            .context("batch expansion manifest object is missing")?;
        progress.validate_for_manifest(&intent, &manifest_bytes)?;

        let relative = format!("batches/{}/expansion_progress.json", progress.batch_id);
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            reject_link(&path)?;
            let mut data = Vec::new();
            fs::File::open(&path)?
                .take(crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES + 1)
                .read_to_end(&mut data)?;
            if data.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
                anyhow::bail!("batch expansion progress exceeds metadata budget");
            }
            let current: FmsBatchExpansionProgress = serde_json::from_slice(&data)?;
            current.validate_for_manifest(&intent, &manifest_bytes)?;
            if current == *progress {
                return Ok(BatchExpansionProgressCommitDisposition::Replayed);
            }
            if current.commands != progress.commands {
                anyhow::bail!("batch expansion progress cannot alter command history");
            }
            if current.sequence != expected_sequence {
                anyhow::bail!(
                    "batch expansion progress sequence conflict: expected {expected_sequence}, found {}",
                    current.sequence
                );
            }
            if matches!(
                current.state,
                FmsBatchExpansionState::Complete
                    | FmsBatchExpansionState::Stopped
                    | FmsBatchExpansionState::Paused
                    | FmsBatchExpansionState::Cancelled
            ) || progress.sequence
                != current
                    .sequence
                    .checked_add(1)
                    .context("batch progress sequence overflow")?
                || progress.next_case_index < current.next_case_index
            {
                anyhow::bail!("batch expansion progress cannot move backward or past completion");
            }
        } else if expected_sequence != 0 || progress.sequence != 1 {
            anyhow::bail!("first batch expansion progress must start at sequence 1");
        }
        let path = create_parent(&self.root, &relative)?;
        atomic_write(&path, &json)?;
        Ok(BatchExpansionProgressCommitDisposition::Accepted)
    }

    /// Publish an accepted Submit intent before acknowledging the request.
    ///
    /// The record is a single atomic JSON publication boundary.  Repeating
    /// the same idempotency key and payload returns `Replayed`; reusing the
    /// key for another payload fails closed.  The application/coordinator
    /// remains responsible for creating the run manifest and scheduling work.
    pub fn commit_run_intent(&self, intent: &FmsRunIntent) -> Result<RunIntentCommitDisposition> {
        self.commit_run_intent_with_optional_backlog_limit(intent, None)
    }

    /// Publish an accepted Submit intent while enforcing a durable bound on
    /// non-terminal runs. Idempotent replay is resolved before admission, so a
    /// client can always recover the original acknowledgement while full.
    pub fn commit_run_intent_with_backlog_limit(
        &self,
        intent: &FmsRunIntent,
        limit: std::num::NonZeroUsize,
    ) -> Result<RunIntentCommitDisposition> {
        self.commit_run_intent_with_optional_backlog_limit(intent, Some(limit))
    }

    fn commit_run_intent_with_optional_backlog_limit(
        &self,
        intent: &FmsRunIntent,
        limit: Option<std::num::NonZeroUsize>,
    ) -> Result<RunIntentCommitDisposition> {
        intent.validate()?;
        let json = serde_json::to_vec_pretty(intent)?;
        if json.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            anyhow::bail!("run intent exceeds metadata budget");
        }
        let _lease = self.write_transaction()?;
        if let Some(object_ref) = intent.definition_object_ref.as_deref() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run definition object `{object_ref}` is missing"))?;
        }
        if let Some(object_ref) = intent.study_object_ref.as_deref() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run study object `{object_ref}` is missing"))?;
        }
        if let Some(object_ref) = intent.study_catalog_object_ref.as_deref() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run study catalog object `{object_ref}` is missing"))?;
        }
        for object_ref in intent.asset_object_refs.values() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run asset object `{object_ref}` is missing"))?;
        }
        if let Some(existing) = self.find_run_intent_unlocked(&intent.idempotency_key)? {
            if existing.payload_sha256 == intent.payload_sha256
                && existing.specification == intent.specification
                && existing.definition_object_ref == intent.definition_object_ref
                && existing.study_object_ref == intent.study_object_ref
                && existing.study_catalog_object_ref == intent.study_catalog_object_ref
                && existing.asset_object_refs == intent.asset_object_refs
            {
                return Ok(RunIntentCommitDisposition::Replayed {
                    run_id: existing.run_id,
                });
            }
            anyhow::bail!(
                "idempotency key `{}` was already accepted for another payload",
                intent.idempotency_key
            );
        }

        self.ensure_development_admission_open_unlocked()?;
        let relative_path = format!("runs/{}/run_intent.json", intent.run_id);
        let path = checked_path(&self.root, &relative_path)?;
        if path.exists() {
            anyhow::bail!("run intent path already exists for run `{}`", intent.run_id);
        }
        if let Some(limit) = limit {
            let active_run_count = self.active_run_intent_count_unlocked()?;
            if active_run_count >= limit.get() {
                return Err(RunBacklogFull {
                    active_run_count,
                    limit: limit.get(),
                }
                .into());
            }
        }
        let path = create_parent(&self.root, &relative_path)?;
        atomic_write(&path, &json)?;
        Ok(RunIntentCommitDisposition::Accepted)
    }

    fn active_run_intent_count_unlocked(&self) -> Result<usize> {
        let mut active_run_count = 0usize;
        for intent in self.list_run_intents()? {
            let is_active = match self.read_run_catalog(&intent.run_id)? {
                None => true,
                Some(catalog) => {
                    catalog.tasks.is_empty()
                        || catalog.tasks.iter().any(|task| {
                            !matches!(
                                task.lifecycle,
                                FmsTaskLifecycle::Succeeded
                                    | FmsTaskLifecycle::Failed
                                    | FmsTaskLifecycle::Cancelled
                                    | FmsTaskLifecycle::Interrupted
                            )
                        })
                }
            };
            if is_active {
                active_run_count = active_run_count
                    .checked_add(1)
                    .context("accepted run backlog count overflowed")?;
            }
        }
        Ok(active_run_count)
    }

    /// Read the durable accepted intent for one run, if present.
    pub fn read_run_intent(&self, run_id: &str) -> Result<Option<FmsRunIntent>> {
        validate_store_id(run_id)?;
        let relative = format!("runs/{run_id}/run_intent.json");
        let path = checked_path(&self.root, &relative)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => anyhow::bail!("run intent path is not a file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("checking {relative}")),
        }
        let data = crate::repository_path::read_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        let intent: FmsRunIntent = serde_json::from_slice(&data)?;
        intent.validate()?;
        if intent.run_id != run_id {
            anyhow::bail!("run intent identity does not match its path");
        }
        Ok(Some(intent))
    }

    /// Find an accepted intent by idempotency key after a process restart.
    pub fn find_run_intent(&self, idempotency_key: &str) -> Result<Option<FmsRunIntent>> {
        validate_store_id(idempotency_key)?;
        self.find_run_intent_unlocked(idempotency_key)
    }

    /// Enumerate accepted intents from the durable store without reading a
    /// mutable current-session pointer. Malformed or linked entries fail closed.
    pub fn list_run_intents(&self) -> Result<Vec<FmsRunIntent>> {
        let runs = checked_path(&self.root, "runs")?;
        if !runs.exists() {
            return Ok(Vec::new());
        }
        let mut intents = Vec::new();
        for entry in fs::read_dir(&runs)? {
            let entry = entry?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported runs entry `{}`", entry.path().display());
            }
            let run_id = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 run identifier"))?;
            validate_store_id(&run_id)?;
            let path = checked_path(&self.root, &format!("runs/{run_id}/run_intent.json"))?;
            if !path.exists() {
                continue;
            }
            let data = fs::read(&path)?;
            let intent: FmsRunIntent = serde_json::from_slice(&data)
                .with_context(|| format!("parsing run intent {}", path.display()))?;
            intent.validate()?;
            if intent.run_id != run_id {
                anyhow::bail!("run intent identity does not match its path");
            }
            intents.push(intent);
        }
        intents.sort_by(|left, right| {
            right
                .accepted_at
                .cmp(&left.accepted_at)
                .then_with(|| right.run_id.cmp(&left.run_id))
        });
        Ok(intents)
    }

    pub fn read_scheduler_pool_checkpoint(
        &self,
        pool_id: &str,
    ) -> Result<Option<FmsSchedulerPoolCheckpoint>> {
        validate_store_id(pool_id)?;
        let relative = format!("scheduler_pools/{pool_id}.json");
        let path = checked_path(&self.root, &relative)?;
        if !path.exists() {
            return Ok(None);
        }
        reject_link(&path)?;
        let checkpoint: FmsSchedulerPoolCheckpoint = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("parsing scheduler pool checkpoint `{relative}`"))?;
        checkpoint.validate()?;
        if checkpoint.pool_id != pool_id {
            anyhow::bail!("scheduler pool checkpoint identity does not match its path");
        }
        Ok(Some(checkpoint))
    }

    pub fn commit_scheduler_pool_checkpoint(
        &self,
        expected_sequence: u64,
        checkpoint: &FmsSchedulerPoolCheckpoint,
    ) -> Result<SchedulerPoolCheckpointCommitDisposition> {
        checkpoint.validate()?;
        if checkpoint.sequence
            != expected_sequence
                .checked_add(1)
                .context("scheduler pool checkpoint sequence overflow")?
        {
            anyhow::bail!("scheduler pool checkpoint sequence is not contiguous");
        }
        let _writer_lease = self.write_transaction()?;
        let relative = format!("scheduler_pools/{}.json", checkpoint.pool_id);
        let path = create_parent(&self.root, &relative)?;
        if path.exists() {
            reject_link(&path)?;
            let existing: FmsSchedulerPoolCheckpoint = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("parsing scheduler pool checkpoint `{relative}`"))?;
            existing.validate()?;
            if existing == *checkpoint {
                return Ok(SchedulerPoolCheckpointCommitDisposition::Replayed);
            }
            if existing.pool_id != checkpoint.pool_id
                || existing.sequence != expected_sequence
                || existing.run_source != checkpoint.run_source
                || (matches!(checkpoint.run_source, FmsSchedulerRunSource::Explicit)
                    && existing.run_ids != checkpoint.run_ids)
            {
                anyhow::bail!("scheduler pool checkpoint compare-and-swap conflict");
            }
        } else if expected_sequence != 0 {
            anyhow::bail!("scheduler pool checkpoint is missing before update");
        }
        atomic_write(&path, &serde_json::to_vec_pretty(checkpoint)?)?;
        Ok(SchedulerPoolCheckpointCommitDisposition::Accepted)
    }

    pub fn read_preparation_scheduler_pool_checkpoint(
        &self,
        pool_id: &str,
    ) -> Result<Option<FmsSchedulerPoolCheckpoint>> {
        validate_store_id(pool_id)?;
        let relative = format!("scheduler_pools/{pool_id}.preparation.json");
        let path = checked_path(&self.root, &relative)?;
        if !path.exists() {
            return Ok(None);
        }
        reject_link(&path)?;
        let checkpoint: FmsSchedulerPoolCheckpoint = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| {
                format!("parsing preparation scheduler pool checkpoint `{relative}`")
            })?;
        checkpoint.validate()?;
        if checkpoint.pool_id != pool_id {
            anyhow::bail!("preparation scheduler pool checkpoint identity does not match its path");
        }
        Ok(Some(checkpoint))
    }

    pub fn commit_preparation_scheduler_pool_checkpoint(
        &self,
        expected_sequence: u64,
        checkpoint: &FmsSchedulerPoolCheckpoint,
    ) -> Result<SchedulerPoolCheckpointCommitDisposition> {
        checkpoint.validate()?;
        if checkpoint.run_source != FmsSchedulerRunSource::Store {
            anyhow::bail!("preparation scheduler checkpoint requires store run discovery");
        }
        if checkpoint.sequence
            != expected_sequence
                .checked_add(1)
                .context("preparation scheduler pool checkpoint sequence overflow")?
        {
            anyhow::bail!("preparation scheduler pool checkpoint sequence is not contiguous");
        }
        let _writer_lease = self.write_transaction()?;
        let relative = format!("scheduler_pools/{}.preparation.json", checkpoint.pool_id);
        let path = create_parent(&self.root, &relative)?;
        if path.exists() {
            reject_link(&path)?;
            let existing: FmsSchedulerPoolCheckpoint = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| {
                    format!("parsing preparation scheduler pool checkpoint `{relative}`")
                })?;
            existing.validate()?;
            if existing == *checkpoint {
                return Ok(SchedulerPoolCheckpointCommitDisposition::Replayed);
            }
            if existing.pool_id != checkpoint.pool_id
                || existing.sequence != expected_sequence
                || existing.run_source != checkpoint.run_source
            {
                anyhow::bail!("preparation scheduler pool checkpoint compare-and-swap conflict");
            }
        } else if expected_sequence != 0 {
            anyhow::bail!("preparation scheduler pool checkpoint is missing before update");
        }
        atomic_write(&path, &serde_json::to_vec_pretty(checkpoint)?)?;
        Ok(SchedulerPoolCheckpointCommitDisposition::Accepted)
    }

    pub fn read_scheduler_resource_pool(
        &self,
        pool_id: &str,
    ) -> Result<Option<FmsSchedulerResourcePool>> {
        validate_store_id(pool_id)?;
        let relative = format!("scheduler_pools/{pool_id}.resources.json");
        let path = checked_path(&self.root, &relative)?;
        if !path.exists() {
            return Ok(None);
        }
        reject_link(&path)?;
        let pool: FmsSchedulerResourcePool = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("parsing scheduler resource pool `{relative}`"))?;
        pool.validate()?;
        if pool.pool_id != pool_id {
            anyhow::bail!("scheduler resource pool identity does not match its path");
        }
        Ok(Some(pool))
    }

    pub fn commit_scheduler_resource_pool(
        &self,
        expected_generation: u64,
        pool: &FmsSchedulerResourcePool,
    ) -> Result<SchedulerResourcePoolCommitDisposition> {
        pool.validate()?;
        if pool.generation
            != expected_generation
                .checked_add(1)
                .context("scheduler resource pool generation overflow")?
        {
            anyhow::bail!("scheduler resource pool generation is not contiguous");
        }
        let _writer_lease = self.write_transaction()?;
        let relative = format!("scheduler_pools/{}.resources.json", pool.pool_id);
        let path = create_parent(&self.root, &relative)?;
        if path.exists() {
            reject_link(&path)?;
            let existing: FmsSchedulerResourcePool = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("parsing scheduler resource pool `{relative}`"))?;
            existing.validate()?;
            if existing == *pool {
                return Ok(SchedulerResourcePoolCommitDisposition::Replayed);
            }
            if existing.pool_id != pool.pool_id || existing.generation != expected_generation {
                anyhow::bail!("scheduler resource pool compare-and-swap conflict");
            }
        } else if expected_generation != 0 {
            anyhow::bail!("scheduler resource pool is missing before update");
        }
        atomic_write(&path, &serde_json::to_vec_pretty(pool)?)?;
        Ok(SchedulerResourcePoolCommitDisposition::Accepted)
    }

    pub fn read_preparation_resource_pool(
        &self,
        pool_id: &str,
    ) -> Result<Option<FmsPreparationResourcePool>> {
        validate_store_id(pool_id)?;
        let relative = format!("scheduler_pools/{pool_id}.preparation-resources.json");
        let path = checked_path(&self.root, &relative)?;
        if !path.exists() {
            return Ok(None);
        }
        reject_link(&path)?;
        let pool: FmsPreparationResourcePool = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("parsing preparation resource pool `{relative}`"))?;
        pool.validate()?;
        if pool.pool_id != pool_id {
            anyhow::bail!("preparation resource pool identity does not match its path");
        }
        Ok(Some(pool))
    }

    pub fn commit_preparation_resource_pool(
        &self,
        expected_generation: u64,
        pool: &FmsPreparationResourcePool,
    ) -> Result<PreparationResourcePoolCommitDisposition> {
        pool.validate()?;
        if pool.generation
            != expected_generation
                .checked_add(1)
                .context("preparation resource pool generation overflow")?
        {
            anyhow::bail!("preparation resource pool generation is not contiguous");
        }
        let _writer_lease = self.write_transaction()?;
        let relative = format!(
            "scheduler_pools/{}.preparation-resources.json",
            pool.pool_id
        );
        let path = create_parent(&self.root, &relative)?;
        if path.exists() {
            reject_link(&path)?;
            let existing: FmsPreparationResourcePool = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("parsing preparation resource pool `{relative}`"))?;
            existing.validate()?;
            if existing == *pool {
                return Ok(PreparationResourcePoolCommitDisposition::Replayed);
            }
            if existing.pool_id != pool.pool_id || existing.generation != expected_generation {
                anyhow::bail!("preparation resource pool compare-and-swap conflict");
            }
        } else if expected_generation != 0 {
            anyhow::bail!("preparation resource pool is missing before update");
        }
        atomic_write(&path, &serde_json::to_vec_pretty(pool)?)?;
        Ok(PreparationResourcePoolCommitDisposition::Accepted)
    }

    fn find_run_intent_unlocked(&self, idempotency_key: &str) -> Result<Option<FmsRunIntent>> {
        let mut found = None;
        for intent in self.list_run_intents()? {
            if intent.idempotency_key == idempotency_key {
                if found.is_some() {
                    anyhow::bail!("duplicate durable idempotency key `{idempotency_key}`");
                }
                found = Some(intent);
            }
        }
        Ok(found)
    }

    /// Publish a monotonic task catalog snapshot for one run.
    ///
    /// Equal revisions are idempotent only when the complete payload is equal;
    /// an older or conflicting writer is rejected before it can replace the
    /// accepted catalog.
    pub fn commit_run_catalog(&self, catalog: &FmsRunCatalog) -> Result<()> {
        catalog.validate()?;
        let _lease = self.write_transaction()?;
        self.commit_run_catalog_unlocked(catalog)
    }

    fn commit_run_catalog_unlocked(&self, catalog: &FmsRunCatalog) -> Result<()> {
        self.commit_run_catalog_unlocked_with_genesis(catalog, false)
    }

    fn commit_run_catalog_unlocked_with_genesis(
        &self,
        catalog: &FmsRunCatalog,
        allow_genesis_publication: bool,
    ) -> Result<()> {
        // Terminal projections and shutdown receipts remain writable while a
        // development handoff fences every operation which creates work.
        if catalog.tasks.is_empty()
            || catalog.tasks.iter().any(|task| {
                !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Succeeded
                        | FmsTaskLifecycle::Failed
                        | FmsTaskLifecycle::Cancelled
                        | FmsTaskLifecycle::Interrupted
                )
            })
        {
            self.ensure_development_admission_open_unlocked()?;
        }
        let path = checked_path(
            &self.root,
            &format!("runs/{}/run_catalog.json", catalog.run_id),
        )?;
        if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsRunCatalog = serde_json::from_slice(&data)
                .with_context(|| format!("parsing run catalog {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != catalog.run_id {
                anyhow::bail!("run catalog identity does not match its path");
            }
            Self::validate_coordinator_watermark_progress(&existing, catalog)?;
            if !allow_genesis_publication {
                for task in &catalog.tasks {
                    if task.coordinator_genesis.is_some()
                        && existing
                            .tasks
                            .iter()
                            .find(|prior| prior.task_id == task.task_id)
                            .and_then(|prior| prior.coordinator_genesis.as_ref())
                            != task.coordinator_genesis.as_ref()
                    {
                        anyhow::bail!(
                            "coordinator genesis must be published through the fenced store boundary"
                        );
                    }
                }
            }
            if existing.revision > catalog.revision {
                anyhow::bail!(
                    "stale run catalog revision {}; current revision is {}",
                    catalog.revision,
                    existing.revision
                );
            }
            if existing.revision == catalog.revision {
                if existing == *catalog {
                    return Ok(());
                }
                anyhow::bail!(
                    "run catalog revision {} conflicts with the durable payload",
                    catalog.revision
                );
            }
        } else if !allow_genesis_publication
            && catalog
                .tasks
                .iter()
                .any(|task| task.coordinator_genesis.is_some())
        {
            anyhow::bail!(
                "coordinator genesis must be published through the fenced store boundary"
            );
        }
        let path = create_parent(
            &self.root,
            &format!("runs/{}/run_catalog.json", catalog.run_id),
        )?;
        let json = serde_json::to_vec_pretty(catalog)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    fn validate_coordinator_watermark_progress(
        existing: &FmsRunCatalog,
        next: &FmsRunCatalog,
    ) -> Result<()> {
        for prior in &existing.tasks {
            let Some(current) = next.tasks.iter().find(|task| task.task_id == prior.task_id) else {
                if prior.coordinator_watermark.is_some() || prior.coordinator_genesis.is_some() {
                    anyhow::bail!(
                        "cannot remove task `{}` while its coordinator watermark is retained",
                        prior.task_id
                    );
                }
                continue;
            };
            if prior.ownership_epoch == current.ownership_epoch
                && prior.coordinator_genesis.is_some()
                && current.coordinator_genesis != prior.coordinator_genesis
            {
                anyhow::bail!(
                    "task `{}` coordinator genesis is immutable within an ownership epoch",
                    prior.task_id
                );
            }
            let Some(prior_watermark) = prior.coordinator_watermark else {
                continue;
            };

            if prior.ownership_epoch == current.ownership_epoch {
                let clears_attempt = prior.attempt_id.is_some() && current.attempt_id.is_none();
                if prior.attempt_id != current.attempt_id && !clears_attempt {
                    anyhow::bail!(
                        "cannot replace task `{}` attempt without advancing its ownership epoch",
                        prior.task_id
                    );
                }
                let current_watermark = current.coordinator_watermark.context(format!(
                    "cannot remove task `{}` coordinator watermark within the same ownership epoch",
                    prior.task_id
                ))?;
                if current_watermark.command_sequence < prior_watermark.command_sequence
                    || current_watermark.event_sequence < prior_watermark.event_sequence
                {
                    anyhow::bail!(
                        "task `{}` coordinator watermark cannot move backwards",
                        prior.task_id
                    );
                }
            } else {
                let prior_epoch = prior
                    .ownership_epoch
                    .context("coordinator watermark has no prior ownership epoch")?;
                let current_epoch = current.ownership_epoch.context(format!(
                    "cannot clear task `{}` ownership epoch while its coordinator watermark is retained",
                    prior.task_id
                ))?;
                if current_epoch <= prior_epoch {
                    anyhow::bail!(
                        "task `{}` coordinator watermark can reset only after ownership epoch advances",
                        prior.task_id
                    );
                }
            }
        }
        Ok(())
    }

    /// Read the durable task catalog for one run, if present.
    pub fn read_run_catalog(&self, run_id: &str) -> Result<Option<FmsRunCatalog>> {
        validate_store_id(run_id)?;
        let relative = format!("runs/{run_id}/run_catalog.json");
        let path = checked_path(&self.root, &relative)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => anyhow::bail!("run catalog path is not a file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("checking {relative}")),
        }
        let data = crate::repository_path::read_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        let catalog: FmsRunCatalog = serde_json::from_slice(&data)?;
        catalog.validate()?;
        if catalog.run_id != run_id {
            anyhow::bail!("run catalog identity does not match its path");
        }
        Ok(Some(catalog))
    }

    /// Publish the immutable preparation receipt that belongs to one run.
    ///
    /// A receipt cannot be published before the durable run catalog exists.
    /// Replaying the exact payload is idempotent; replacing an accepted plan
    /// or certificate set is rejected even when the writer uses a later
    /// process generation.
    pub fn commit_preparation_receipt(
        &self,
        receipt: &FmsPreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        receipt.validate()?;
        let _lease = self.write_transaction()?;
        self.read_run_catalog(&receipt.run_id)?
            .context("preparation receipt requires a durable run catalog")?;
        let path = checked_path(
            &self.root,
            &format!("runs/{}/preparation_receipt.json", receipt.run_id),
        )?;
        if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsPreparationReceipt = serde_json::from_slice(&data)
                .with_context(|| format!("parsing preparation receipt {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != receipt.run_id {
                anyhow::bail!("preparation receipt identity does not match its path");
            }
            if existing.same_immutable_payload(receipt) {
                return Ok(PreparationReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "preparation receipt for run `{}` is immutable and cannot be replaced",
                receipt.run_id
            );
        }
        let path = create_parent(
            &self.root,
            &format!("runs/{}/preparation_receipt.json", receipt.run_id),
        )?;
        let json = serde_json::to_vec_pretty(receipt)?;
        atomic_write(&path, &json)?;
        Ok(PreparationReceiptCommitDisposition::Accepted)
    }

    /// Read the immutable preparation receipt for one run, if published.
    pub fn read_preparation_receipt(&self, run_id: &str) -> Result<Option<FmsPreparationReceipt>> {
        validate_store_id(run_id)?;
        let relative = format!("runs/{run_id}/preparation_receipt.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "preparation receipt",
        )? else {
            return Ok(None);
        };
        let receipt: FmsPreparationReceipt = serde_json::from_slice(&data)
            .with_context(|| format!("parsing preparation receipt {}", path.display()))?;
        receipt.validate()?;
        if receipt.run_id != run_id {
            anyhow::bail!("preparation receipt identity does not match its path");
        }
        Ok(Some(receipt))
    }

    /// Publish one immutable accepted-run preparation receipt for a catalog task.
    /// Replays of the same payload are idempotent; a task input or receipt
    /// replacement is rejected. This does not change task readiness.
    pub fn commit_task_preparation_receipt(
        &self,
        receipt: &FmsTaskPreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        receipt.validate()?;
        let _lease = self.write_transaction()?;
        self.commit_task_preparation_receipt_unlocked(receipt)
    }

    /// Publish an accepted-run preparation receipt only while the exact
    /// preparation attempt owns an active durable meshing lease.
    pub fn commit_task_preparation_receipt_with_preparation_lease(
        &self,
        receipt: &FmsTaskPreparationReceipt,
        resource_id: &str,
        preparation_attempt_id: &str,
        lease_token: &str,
    ) -> Result<PreparationReceiptCommitDisposition> {
        receipt.validate()?;
        for value in [resource_id, preparation_attempt_id, lease_token] {
            validate_store_id(value)?;
        }
        let _writer_lease = self.write_transaction()?;
        let lease = self
            .read_preparation_resource_lease(&receipt.run_id, resource_id, lease_token)?
            .context("preparation receipt publication requires a durable resource lease")?;
        if lease.task_id != receipt.task_id
            || lease.preparation_attempt_id != preparation_attempt_id
            || lease.state != FmsResourceLeaseState::Active
        {
            anyhow::bail!(
                "preparation receipt publication is not owned by the active preparation lease"
            );
        }
        if self
            .read_task_preparation_receipt(&receipt.run_id, &receipt.task_id)?
            .is_some()
        {
            return self.commit_task_preparation_receipt_unlocked(receipt);
        }
        self.validate_preparation_resource_lease_owner_unlocked(&lease)?;
        self.commit_task_preparation_receipt_unlocked(receipt)
    }

    fn commit_task_preparation_receipt_unlocked(
        &self,
        receipt: &FmsTaskPreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        let relative = receipt.relative_path()?;
        let catalog = self
            .read_run_catalog(&receipt.run_id)?
            .context("task preparation receipt requires a durable run catalog")?;
        receipt.validate_for_catalog(&catalog)?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == receipt.task_id)
            .context("task preparation receipt task is missing from the run catalog")?;
        let intent = self
            .read_run_intent(&receipt.run_id)?
            .context("task preparation receipt requires an accepted run intent")?;
        receipt.validate_for_run_intent(&intent)?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            let data = crate::repository_path::read_bounded_regular_file(
                &self.root,
                &relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let existing: FmsTaskPreparationReceipt = serde_json::from_slice(&data)
                .with_context(|| format!("parsing task preparation receipt {}", path.display()))?;
            existing.validate_for_catalog(&catalog)?;
            existing.validate_for_run_intent(&intent)?;
            if existing.relative_path()? != relative {
                anyhow::bail!("task preparation receipt identity does not match its path");
            }
            if existing.same_immutable_payload(receipt) {
                return Ok(PreparationReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "task preparation receipt for task `{}` is immutable and cannot be replaced",
                receipt.task_id
            );
        }
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || !matches!(&task.readiness, FmsTaskReadiness::Blocked { .. })
        {
            anyhow::bail!(
                "a new task preparation receipt requires an accepted, blocked task `{}`",
                receipt.task_id
            );
        }
        let path = create_parent(&self.root, &relative)?;
        let json = serde_json::to_vec_pretty(receipt)?;
        atomic_write(&path, &json)?;
        Ok(PreparationReceiptCommitDisposition::Accepted)
    }

    /// Read and validate one immutable accepted-run task receipt.
    pub fn read_task_preparation_receipt(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<FmsTaskPreparationReceipt>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let relative = format!("runs/{run_id}/task_preparation_receipts/{task_id}.json");
        let path = checked_path(&self.root, &relative)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => anyhow::bail!("task preparation receipt path is not a file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("checking {relative}")),
        }
        let data = crate::repository_path::read_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        let receipt: FmsTaskPreparationReceipt = serde_json::from_slice(&data)
            .with_context(|| format!("parsing task preparation receipt {}", path.display()))?;
        if receipt.relative_path()? != relative {
            anyhow::bail!("task preparation receipt identity does not match its path");
        }
        let catalog = self
            .read_run_catalog(run_id)?
            .context("task preparation receipt requires a durable run catalog")?;
        receipt.validate_for_catalog(&catalog)?;
        let intent = self
            .read_run_intent(run_id)?
            .context("task preparation receipt requires an accepted run intent")?;
        receipt.validate_for_run_intent(&intent)?;
        if receipt.task_id != task_id {
            anyhow::bail!("task preparation receipt task_id does not match its path");
        }
        Ok(Some(receipt))
    }

    /// Persist the live accepted projection's stage selection without
    /// replacing the immutable run-level live preparation receipt. The stage
    /// pointer is valid only when its exact immutable task receipt already
    /// exists in the accepted run store.
    pub fn commit_accepted_stage_preparation_receipt(
        &self,
        receipt: &FmsAcceptedStagePreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        receipt.validate()?;
        let _lease = self.write_transaction()?;
        self.commit_accepted_stage_preparation_receipt_unlocked(receipt)
    }

    fn commit_accepted_stage_preparation_receipt_unlocked(
        &self,
        receipt: &FmsAcceptedStagePreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        let task_receipt = self
            .read_task_preparation_receipt(&receipt.run_id, &receipt.task_id)?
            .context("accepted stage receipt requires an immutable task preparation receipt")?;
        if !receipt.matches_task_receipt(&task_receipt) {
            anyhow::bail!(
                "accepted stage receipt does not match the immutable task preparation receipt"
            );
        }
        let relative = receipt.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            let data = crate::repository_path::read_bounded_regular_file(
                &self.root,
                &relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let existing: FmsAcceptedStagePreparationReceipt = serde_json::from_slice(&data)
                .with_context(|| format!("parsing accepted stage receipt {relative}"))?;
            if existing.relative_path()? != relative {
                anyhow::bail!("accepted stage receipt identity does not match its path");
            }
            if !existing.matches_task_receipt(&task_receipt) {
                anyhow::bail!(
                    "accepted stage receipt does not match the immutable task preparation receipt"
                );
            }
            if existing.same_immutable_payload(receipt) {
                return Ok(PreparationReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "accepted stage preparation receipt for `{}` is immutable and cannot be replaced",
                receipt.step_id
            );
        }
        let path = create_parent(&self.root, &relative)?;
        let json = serde_json::to_vec_pretty(receipt)?;
        atomic_write(&path, &json)?;
        Ok(PreparationReceiptCommitDisposition::Accepted)
    }

    /// Read one accepted stage pointer and revalidate it against its exact
    /// immutable task receipt. A pointer without its task receipt is never
    /// treated as proof after restart.
    pub fn read_accepted_stage_preparation_receipt(
        &self,
        run_id: &str,
        step_id: &str,
    ) -> Result<Option<FmsAcceptedStagePreparationReceipt>> {
        validate_store_id(run_id)?;
        let expected_task_id = task_id_for_study_step(run_id, step_id)?;
        let relative =
            format!("runs/{run_id}/accepted_stage_preparation_receipts/{expected_task_id}.json");
        let path = checked_path(&self.root, &relative)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => anyhow::bail!("accepted stage preparation receipt path is not a file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("checking {relative}")),
        }
        let data = crate::repository_path::read_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        let receipt: FmsAcceptedStagePreparationReceipt = serde_json::from_slice(&data)
            .with_context(|| format!("parsing accepted stage receipt {relative}"))?;
        if receipt.relative_path()? != relative || receipt.task_id != expected_task_id {
            anyhow::bail!("accepted stage receipt identity does not match its path");
        }
        let task_receipt = self
            .read_task_preparation_receipt(run_id, &expected_task_id)?
            .context("accepted stage receipt requires an immutable task preparation receipt")?;
        if !receipt.matches_task_receipt(&task_receipt) {
            anyhow::bail!(
                "accepted stage receipt does not match the immutable task preparation receipt"
            );
        }
        Ok(Some(receipt))
    }

    /// Find the durable accepted stage that owns a live preparation id. This
    /// is used after an API restart when the in-memory stage pointer is gone;
    /// every candidate is revalidated against its immutable task receipt.
    pub fn find_accepted_stage_preparation_receipt_by_preparation_id(
        &self,
        run_id: &str,
        preparation_id: &str,
    ) -> Result<Option<FmsAcceptedStagePreparationReceipt>> {
        validate_store_id(run_id)?;
        validate_store_id(preparation_id)?;
        let directory = checked_path(
            &self.root,
            &format!("runs/{run_id}/accepted_stage_preparation_receipts"),
        )?;
        match fs::symlink_metadata(&directory) {
            Ok(_) => reject_link(&directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("checking {directory:?}")),
        }
        if !directory.is_dir() {
            anyhow::bail!("accepted stage preparation receipt path is not a directory");
        }
        let mut found = None;
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            reject_link(&path)?;
            if !entry.file_type()?.is_file() {
                anyhow::bail!("accepted stage preparation receipt entry must be a file");
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let actual_relative =
                format!("runs/{run_id}/accepted_stage_preparation_receipts/{file_name}");
            let data = crate::repository_path::read_bounded_regular_file(
                &self.root,
                &actual_relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let candidate: FmsAcceptedStagePreparationReceipt = serde_json::from_slice(&data)
                .context("parsing accepted stage preparation receipt during lookup")?;
            if candidate.relative_path()? != actual_relative {
                anyhow::bail!(
                    "accepted stage preparation receipt identity does not match its path"
                );
            }
            let receipt = self
                .read_accepted_stage_preparation_receipt(run_id, &candidate.step_id)?
                .context("accepted stage preparation receipt disappeared during lookup")?;
            if receipt.preparation_id != preparation_id {
                continue;
            }
            if found.is_some() {
                anyhow::bail!(
                    "multiple accepted stage preparation receipts match preparation id `{preparation_id}`"
                );
            }
            found = Some(receipt);
        }
        Ok(found)
    }

    /// Persist one fenced retry decision in the coordinator journal.
    ///
    /// The record is immutable and idempotent by `decision_id`.  Applying the
    /// decision to a new task snapshot remains a separate coordinator step;
    /// this boundary guarantees that the observed attempt and ownership epoch
    /// survive a process restart before a retry is admitted.
    pub fn commit_retry_decision(
        &self,
        decision: &FmsRetryDecision,
    ) -> Result<RetryDecisionCommitDisposition> {
        decision.validate()?;
        let _lease = self.write_transaction()?;
        if decision.action == FmsRetryAction::Retry {
            self.ensure_development_admission_open_unlocked()?;
        }
        let mut catalog = self
            .read_run_catalog(&decision.run_id)?
            .context("retry decision requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == decision.task_id)
            .context("retry decision task is missing from the run catalog")?;
        decision.validate_for_task(task)?;
        if decision.action == FmsRetryAction::Retry {
            self.ensure_provider_job_terminal_before_retry_unlocked(&decision.run_id, task)?;
        }

        let path = checked_path(
            &self.root,
            &format!(
                "runs/{}/retry_decisions/{}.json",
                decision.run_id, decision.decision_id
            ),
        )?;
        if path.exists() {
            let data = fs::read(&path)
                .with_context(|| format!("reading retry decision {}", path.display()))?;
            let existing: FmsRetryDecision = serde_json::from_slice(&data)
                .with_context(|| format!("parsing retry decision {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != decision.run_id || existing.decision_id != decision.decision_id {
                anyhow::bail!("retry decision identity does not match its path");
            }
            if existing == *decision {
                return Ok(RetryDecisionCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "retry decision `{}` conflicts with the durable payload",
                decision.decision_id
            );
        }
        let path = create_parent(
            &self.root,
            &format!(
                "runs/{}/retry_decisions/{}.json",
                decision.run_id, decision.decision_id
            ),
        )?;
        atomic_write(&path, &serde_json::to_vec_pretty(decision)?)?;
        Ok(RetryDecisionCommitDisposition::Accepted)
    }

    /// Apply a previously recorded retry decision to the durable task catalog.
    ///
    /// The decision is written before the catalog transition.  If the process
    /// dies between those two atomic publications, replaying this method finds
    /// the immutable decision and completes the transition.  A retry keeps the
    /// previous ownership epoch as a monotonic fence, clears the old attempt
    /// and resource binding, and returns the task to `Queued`; it never marks a
    /// live lease as released implicitly.
    pub fn apply_retry_decision(
        &self,
        decision: &FmsRetryDecision,
    ) -> Result<RetryDecisionApplyDisposition> {
        decision.validate()?;
        let _lease = self.write_transaction()?;
        if decision.action == FmsRetryAction::Retry {
            self.ensure_development_admission_open_unlocked()?;
        }
        let mut catalog = self
            .read_run_catalog(&decision.run_id)?
            .context("retry decision requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == decision.task_id)
            .context("retry decision task is missing from the run catalog")?;

        let decision_path = checked_path(
            &self.root,
            &format!(
                "runs/{}/retry_decisions/{}.json",
                decision.run_id, decision.decision_id
            ),
        )?;
        let decision_was_replayed = if decision_path.exists() {
            let data = fs::read(&decision_path)
                .with_context(|| format!("reading retry decision {}", decision_path.display()))?;
            let existing: FmsRetryDecision = serde_json::from_slice(&data)
                .with_context(|| format!("parsing retry decision {}", decision_path.display()))?;
            existing.validate()?;
            if existing.run_id != decision.run_id || existing.decision_id != decision.decision_id {
                anyhow::bail!("retry decision identity does not match its path");
            }
            if existing != *decision {
                anyhow::bail!(
                    "retry decision `{}` conflicts with the durable payload",
                    decision.decision_id
                );
            }
            true
        } else {
            decision.validate_for_task(&catalog.tasks[task_index])?;
            let path = create_parent(
                &self.root,
                &format!(
                    "runs/{}/retry_decisions/{}.json",
                    decision.run_id, decision.decision_id
                ),
            )?;
            atomic_write(&path, &serde_json::to_vec_pretty(decision)?)?;
            false
        };

        let task = &mut catalog.tasks[task_index];
        let claim_matches = task.attempt_id.as_deref() == Some(decision.attempt_id.as_str())
            && task.ownership_epoch == Some(decision.ownership_epoch);
        if !claim_matches {
            if decision_was_replayed {
                return Ok(RetryDecisionApplyDisposition::Replayed);
            }
            anyhow::bail!("retry decision ownership fence does not match the run catalog");
        }

        let changed = match decision.action {
            FmsRetryAction::Retry => {
                if !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Failed | FmsTaskLifecycle::Interrupted
                ) {
                    anyhow::bail!("retry action requires a failed or interrupted task");
                }
                if let Some(resource_id) = task.resource_id.as_deref() {
                    if self
                        .find_active_resource_lease_unlocked(resource_id)?
                        .is_some()
                    {
                        anyhow::bail!(
                            "retry requires an explicit release for resource `{resource_id}`"
                        );
                    }
                }
                self.ensure_provider_job_terminal_before_retry_unlocked(&decision.run_id, task)?;
                task.lifecycle = FmsTaskLifecycle::Queued;
                task.observation = Some(FmsObservationState::Reconciling);
                task.attempt_id = None;
                task.resolved_input_fingerprint = None;
                task.resource_id = None;
                true
            }
            FmsRetryAction::DoNotRetry => false,
            FmsRetryAction::AwaitReconciliation => {
                let next = Some(FmsObservationState::Reconciling);
                let changed = task.observation != next;
                task.observation = next;
                changed
            }
        };

        if changed {
            catalog.revision = catalog
                .revision
                .checked_add(1)
                .context("run catalog revision exhausted")?;
            catalog.updated_at = chrono::Utc::now();
            catalog.validate()?;
            self.commit_run_catalog_unlocked(&catalog)?;
            Ok(RetryDecisionApplyDisposition::Applied)
        } else if decision_was_replayed {
            Ok(RetryDecisionApplyDisposition::Replayed)
        } else {
            Ok(RetryDecisionApplyDisposition::Applied)
        }
    }

    /// Read one immutable retry decision from the coordinator journal.
    pub fn read_retry_decision(
        &self,
        run_id: &str,
        decision_id: &str,
    ) -> Result<Option<FmsRetryDecision>> {
        validate_store_id(run_id)?;
        validate_store_id(decision_id)?;
        let relative = format!("runs/{run_id}/retry_decisions/{decision_id}.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "retry decision",
        )? else {
            return Ok(None);
        };
        let decision: FmsRetryDecision = serde_json::from_slice(&data)?;
        decision.validate()?;
        if decision.run_id != run_id || decision.decision_id != decision_id {
            anyhow::bail!("retry decision identity does not match its path");
        }
        Ok(Some(decision))
    }

    /// List immutable retry decisions for one run in stable identity order.
    pub fn list_retry_decisions(&self, run_id: &str) -> Result<Vec<FmsRetryDecision>> {
        validate_store_id(run_id)?;
        let Some(directory) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/retry_decisions"),
            "retry decisions",
        )? else {
            return Ok(Vec::new());
        };
        let mut decisions = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if metadata.is_symlink() || !metadata.is_file() {
                anyhow::bail!("unsafe retry decision entry `{}`", entry.path().display());
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let decision_id = file_name
                .strip_suffix(".json")
                .context("retry decision entry must be JSON")?;
            validate_store_id(decision_id)?;
            decisions.push(
                self.read_retry_decision(run_id, decision_id)?
                    .context("listed retry decision disappeared during read")?,
            );
        }
        decisions.sort_by(|left, right| left.decision_id.cmp(&right.decision_id));
        Ok(decisions)
    }

    /// Persist immutable proof that a supervised child process was reaped.
    ///
    /// Publication requires the exact current catalog claim and the last
    /// active lease heartbeat held by the supervisor.  Replaying the same
    /// receipt is idempotent; changing any observed outcome conflicts.
    pub fn commit_worker_process_exit_receipt(
        &self,
        receipt: &FmsWorkerProcessExitReceipt,
    ) -> Result<WorkerProcessExitReceiptCommitDisposition> {
        receipt.validate()?;
        let _writer_lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&receipt.run_id)?
            .context("worker process exit receipt requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == receipt.task_id)
            .context("worker process exit receipt task is missing from the run catalog")?;
        receipt.validate_for_task(task)?;
        let lease = self
            .read_resource_lease(&receipt.run_id, &receipt.resource_id, &receipt.lease_token)?
            .context("worker process exit receipt requires its durable resource lease")?;
        receipt.validate_for_lease(&lease)?;

        let relative = receipt.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            let data = fs::read(&path).with_context(|| {
                format!("reading worker process exit receipt {}", path.display())
            })?;
            let existing: FmsWorkerProcessExitReceipt = serde_json::from_slice(&data)
                .with_context(|| {
                    format!("parsing worker process exit receipt {}", path.display())
                })?;
            existing.validate()?;
            if existing.relative_path()? != relative {
                anyhow::bail!("worker process exit receipt identity does not match its path");
            }
            if existing == *receipt {
                return Ok(WorkerProcessExitReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "worker process exit receipt `{}` conflicts with the durable payload",
                receipt.receipt_id
            );
        }
        let path = create_parent(&self.root, &relative)?;
        atomic_write(&path, &serde_json::to_vec_pretty(receipt)?)?;
        Ok(WorkerProcessExitReceiptCommitDisposition::Accepted)
    }

    /// Read one immutable worker process exit receipt by durable identity.
    pub fn read_worker_process_exit_receipt(
        &self,
        run_id: &str,
        receipt_id: &str,
    ) -> Result<Option<FmsWorkerProcessExitReceipt>> {
        validate_store_id(run_id)?;
        validate_store_id(receipt_id)?;
        let relative = format!("runs/{run_id}/worker_process_exit_receipts/{receipt_id}.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "worker process exit receipt",
        )? else {
            return Ok(None);
        };
        let receipt: FmsWorkerProcessExitReceipt = serde_json::from_slice(&data)
            .with_context(|| format!("parsing worker process exit receipt {}", path.display()))?;
        if receipt.relative_path()? != relative {
            anyhow::bail!("worker process exit receipt identity does not match its path");
        }
        Ok(Some(receipt))
    }

    /// List immutable worker process exit receipts for one run.
    pub fn list_worker_process_exit_receipts(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsWorkerProcessExitReceipt>> {
        validate_store_id(run_id)?;
        let Some(directory) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/worker_process_exit_receipts"),
            "worker process exit receipts",
        )? else {
            return Ok(Vec::new());
        };
        let mut receipts = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if metadata.is_symlink() || !metadata.is_file() {
                anyhow::bail!(
                    "unsafe worker process exit receipt entry `{}`",
                    entry.path().display()
                );
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let receipt_id = file_name
                .strip_suffix(".json")
                .context("worker process exit receipt entry must be JSON")?;
            validate_store_id(receipt_id)?;
            receipts.push(
                self.read_worker_process_exit_receipt(run_id, receipt_id)?
                    .context("listed worker process exit receipt disappeared during read")?,
            );
        }
        receipts.sort_by(|left, right| left.receipt_id.cmp(&right.receipt_id));
        Ok(receipts)
    }

    /// Read the exact active lease retained after a durable process exit.
    pub fn read_active_resource_lease_for_worker_process_exit(
        &self,
        receipt: &FmsWorkerProcessExitReceipt,
    ) -> Result<Option<FmsResourceLease>> {
        receipt.validate()?;
        let _writer_lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&receipt.run_id)?
            .context("worker process exit recovery requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == receipt.task_id)
            .context("worker process exit recovery task is missing from the run catalog")?;
        receipt.validate_for_task(task)?;
        let Some(lease) =
            self.read_resource_lease(&receipt.run_id, &receipt.resource_id, &receipt.lease_token)?
        else {
            return Ok(None);
        };
        if lease.state == FmsResourceLeaseState::Released {
            return Ok(None);
        }
        receipt.validate_for_lease(&lease)?;
        Ok(Some(lease))
    }

    /// Persist a one-shot preparation process launch authorization. Only an
    /// `Accepted` result authorizes the caller to spawn. `Replayed` proves a
    /// prior supervisor crossed the durable launch boundary and therefore must
    /// fail closed until that attempt is reconciled.
    pub fn commit_preparation_process_launch(
        &self,
        launch: &FmsPreparationProcessLaunch,
    ) -> Result<PreparationProcessLaunchCommitDisposition> {
        launch.validate()?;
        let _writer_lease = self.write_transaction()?;
        self.ensure_development_admission_open_unlocked()?;
        let catalog = self
            .read_run_catalog(&launch.run_id)?
            .context("preparation process launch requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == launch.task_id)
            .context("preparation process launch task is missing from the run catalog")?;
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
        {
            anyhow::bail!("preparation process launch task has a solver claim");
        }
        let lease = self
            .read_preparation_resource_lease(
                &launch.run_id,
                &launch.resource_id,
                &launch.lease_token,
            )?
            .context("preparation process launch requires its durable resource lease")?;
        launch.validate_for_lease(&lease)?;

        let relative = launch.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            let existing: FmsPreparationProcessLaunch = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| {
                format!("parsing preparation process launch {}", path.display())
            })?;
            existing.validate()?;
            if existing.relative_path()? != relative {
                anyhow::bail!("preparation process launch identity does not match its path");
            }
            if existing == *launch {
                confirm_publication(&path)?;
                return Ok(PreparationProcessLaunchCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "preparation process launch `{}` conflicts with the durable payload",
                launch.launch_id
            );
        }
        if self
            .list_preparation_process_launches(&launch.run_id)?
            .into_iter()
            .any(|existing| {
                existing.task_id == launch.task_id
                    && existing.preparation_attempt_id == launch.preparation_attempt_id
                    && existing.resource_id == launch.resource_id
                    && existing.lease_token == launch.lease_token
            })
        {
            anyhow::bail!(
                "preparation attempt `{}` already has a durable process launch",
                launch.preparation_attempt_id
            );
        }
        atomic_write(
            &create_parent(&self.root, &relative)?,
            &serde_json::to_vec_pretty(launch)?,
        )?;
        Ok(PreparationProcessLaunchCommitDisposition::Accepted)
    }

    pub fn read_preparation_process_launch(
        &self,
        run_id: &str,
        launch_id: &str,
    ) -> Result<Option<FmsPreparationProcessLaunch>> {
        validate_store_id(run_id)?;
        validate_store_id(launch_id)?;
        let relative = format!("runs/{run_id}/preparation_process_launches/{launch_id}.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "preparation process launch",
        )? else {
            return Ok(None);
        };
        let launch: FmsPreparationProcessLaunch = serde_json::from_slice(&data)
            .with_context(|| format!("parsing preparation process launch {}", path.display()))?;
        if launch.relative_path()? != relative {
            anyhow::bail!("preparation process launch identity does not match its path");
        }
        Ok(Some(launch))
    }

    pub fn list_preparation_process_launches(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsPreparationProcessLaunch>> {
        validate_store_id(run_id)?;
        let Some(directory) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/preparation_process_launches"),
            "preparation process launches",
        )? else {
            return Ok(Vec::new());
        };
        let mut launches = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if metadata.is_symlink() || !metadata.is_file() {
                anyhow::bail!(
                    "unsafe preparation process launch entry `{}`",
                    entry.path().display()
                );
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let launch_id = file_name
                .strip_suffix(".json")
                .context("preparation process launch entry must be JSON")?;
            validate_store_id(launch_id)?;
            launches.push(
                self.read_preparation_process_launch(run_id, launch_id)?
                    .context("listed preparation process launch disappeared during read")?,
            );
        }
        launches.sort_by(|left, right| left.launch_id.cmp(&right.launch_id));
        Ok(launches)
    }

    /// Persist immutable proof that a supervised preparation process was
    /// reaped while the exact preparation lease remained active.
    pub fn commit_preparation_process_exit_receipt(
        &self,
        receipt: &FmsPreparationProcessExitReceipt,
    ) -> Result<PreparationProcessExitReceiptCommitDisposition> {
        receipt.validate()?;
        let _writer_lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&receipt.run_id)?
            .context("preparation process exit receipt requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == receipt.task_id)
            .context("preparation process exit receipt task is missing from the run catalog")?;
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
        {
            anyhow::bail!("preparation process exit receipt task has a solver claim");
        }
        let lease = self
            .read_preparation_resource_lease(
                &receipt.run_id,
                &receipt.resource_id,
                &receipt.lease_token,
            )?
            .context("preparation process exit receipt requires its durable resource lease")?;
        receipt.validate_for_lease(&lease)?;
        let launches = self
            .list_preparation_process_launches(&receipt.run_id)?
            .into_iter()
            .filter(|launch| {
                launch.task_id == receipt.task_id
                    && launch.preparation_attempt_id == receipt.preparation_attempt_id
                    && launch.resource_id == receipt.resource_id
                    && launch.lease_token == receipt.lease_token
                    && launch.lease_heartbeat_sequence <= receipt.lease_heartbeat_sequence
            })
            .collect::<Vec<_>>();
        if launches.len() != 1 {
            anyhow::bail!(
                "preparation process exit receipt requires exactly one matching durable launch"
            );
        }

        let relative = receipt.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            let existing: FmsPreparationProcessExitReceipt =
                serde_json::from_slice(&fs::read(&path)?).with_context(|| {
                    format!(
                        "parsing preparation process exit receipt {}",
                        path.display()
                    )
                })?;
            existing.validate()?;
            if existing.relative_path()? != relative {
                anyhow::bail!("preparation process exit receipt identity does not match its path");
            }
            if existing == *receipt {
                return Ok(PreparationProcessExitReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "preparation process exit receipt `{}` conflicts with the durable payload",
                receipt.receipt_id
            );
        }
        atomic_write(
            &create_parent(&self.root, &relative)?,
            &serde_json::to_vec_pretty(receipt)?,
        )?;
        Ok(PreparationProcessExitReceiptCommitDisposition::Accepted)
    }

    pub fn read_preparation_process_exit_receipt(
        &self,
        run_id: &str,
        receipt_id: &str,
    ) -> Result<Option<FmsPreparationProcessExitReceipt>> {
        validate_store_id(run_id)?;
        validate_store_id(receipt_id)?;
        let relative = format!("runs/{run_id}/preparation_process_exit_receipts/{receipt_id}.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "preparation process exit receipt",
        )? else {
            return Ok(None);
        };
        let receipt: FmsPreparationProcessExitReceipt = serde_json::from_slice(&data)
            .with_context(|| {
            format!(
                "parsing preparation process exit receipt {}",
                path.display()
            )
        })?;
        if receipt.relative_path()? != relative {
            anyhow::bail!("preparation process exit receipt identity does not match its path");
        }
        Ok(Some(receipt))
    }

    pub fn list_preparation_process_exit_receipts(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsPreparationProcessExitReceipt>> {
        validate_store_id(run_id)?;
        let Some(directory) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/preparation_process_exit_receipts"),
            "preparation process exit receipts",
        )? else {
            return Ok(Vec::new());
        };
        let mut receipts = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if metadata.is_symlink() || !metadata.is_file() {
                anyhow::bail!(
                    "unsafe preparation process exit receipt entry `{}`",
                    entry.path().display()
                );
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let receipt_id = file_name
                .strip_suffix(".json")
                .context("preparation process exit receipt entry must be JSON")?;
            validate_store_id(receipt_id)?;
            receipts.push(
                self.read_preparation_process_exit_receipt(run_id, receipt_id)?
                    .context("listed preparation process exit receipt disappeared during read")?,
            );
        }
        receipts.sort_by(|left, right| left.receipt_id.cmp(&right.receipt_id));
        Ok(receipts)
    }

    pub fn read_active_preparation_lease_for_process_exit(
        &self,
        receipt: &FmsPreparationProcessExitReceipt,
    ) -> Result<Option<FmsPreparationResourceLease>> {
        receipt.validate()?;
        let _writer_lease = self.write_transaction()?;
        let Some(lease) = self.read_preparation_resource_lease(
            &receipt.run_id,
            &receipt.resource_id,
            &receipt.lease_token,
        )?
        else {
            return Ok(None);
        };
        if lease.state == FmsResourceLeaseState::Released {
            return Ok(None);
        }
        receipt.validate_for_lease(&lease)?;
        Ok(Some(lease))
    }

    /// Reconcile a durable preparation-process exit exactly once. Successful
    /// preparation advances the accepted task to dependency resolution only
    /// when its immutable preparation receipt exists. Both success and failure
    /// release the resource only after the process-exit receipt is durable.
    pub fn finalize_preparation_process_exit(
        &self,
        receipt: &FmsPreparationProcessExitReceipt,
    ) -> Result<PreparationProcessFinalizationDisposition> {
        receipt.validate()?;
        let _writer_lease = self.write_transaction()?;
        let persisted = self
            .read_preparation_process_exit_receipt(&receipt.run_id, &receipt.receipt_id)?
            .context("preparation process exit must be durable before finalization")?;
        if persisted != *receipt {
            anyhow::bail!("preparation process exit receipt differs from durable proof");
        }
        let mut lease = self
            .read_preparation_resource_lease(
                &receipt.run_id,
                &receipt.resource_id,
                &receipt.lease_token,
            )?
            .context("preparation process finalization requires its durable lease")?;
        let lease_identity_matches = lease.run_id == receipt.run_id
            && lease.task_id == receipt.task_id
            && lease.preparation_attempt_id == receipt.preparation_attempt_id
            && lease.resource_id == receipt.resource_id
            && lease.lease_token == receipt.lease_token
            && lease.heartbeat_sequence == receipt.lease_heartbeat_sequence;
        if !lease_identity_matches {
            anyhow::bail!("preparation process finalization lease fence rejected");
        }

        let mut catalog = self
            .read_run_catalog(&receipt.run_id)?
            .context("preparation process finalization requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == receipt.task_id)
            .context("preparation process finalization task is missing from the run catalog")?;
        let task = &catalog.tasks[task_index];
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
        {
            anyhow::bail!("preparation process finalization task has a solver claim");
        }
        let awaiting_preparation = matches!(
            &task.readiness,
            FmsTaskReadiness::Blocked { reason }
                if reason == FMS_TASK_AWAITING_PREPARATION_REASON
        );
        let awaiting_dependencies = matches!(
            &task.readiness,
            FmsTaskReadiness::Blocked { reason }
                if reason == FMS_TASK_AWAITING_DEPENDENCY_RESOLUTION_REASON
        );

        if lease.state == FmsResourceLeaseState::Released {
            let replayed = if receipt.status_success {
                awaiting_dependencies
                    && self
                        .read_task_preparation_receipt(&receipt.run_id, &receipt.task_id)?
                        .is_some()
            } else {
                awaiting_preparation
            };
            if replayed {
                return Ok(PreparationProcessFinalizationDisposition::Replayed);
            }
            anyhow::bail!("released preparation lease has an incomplete finalization projection");
        }
        receipt.validate_for_lease(&lease)?;

        if receipt.status_success {
            if self
                .read_task_preparation_receipt(&receipt.run_id, &receipt.task_id)?
                .is_none()
            {
                anyhow::bail!(
                    "successful preparation process cannot finalize without a preparation receipt"
                );
            }
            if !awaiting_preparation && !awaiting_dependencies {
                anyhow::bail!("successful preparation process found incompatible task readiness");
            }
            if awaiting_preparation {
                catalog.tasks[task_index].readiness = FmsTaskReadiness::Blocked {
                    reason: FMS_TASK_AWAITING_DEPENDENCY_RESOLUTION_REASON.into(),
                };
                catalog.revision = catalog
                    .revision
                    .checked_add(1)
                    .context("run catalog revision exhausted during preparation finalization")?;
                catalog.updated_at = chrono::Utc::now();
                self.commit_run_catalog_unlocked(&catalog)?;
            }
        } else if !awaiting_preparation {
            anyhow::bail!("failed preparation process found incompatible task readiness");
        }

        lease.state = FmsResourceLeaseState::Released;
        lease.released_at = Some(chrono::Utc::now());
        lease.validate()?;
        atomic_write(
            &checked_path(&self.root, &lease.relative_path()?)?,
            &serde_json::to_vec_pretty(&lease)?,
        )?;
        Ok(if receipt.status_success {
            PreparationProcessFinalizationDisposition::Succeeded
        } else {
            PreparationProcessFinalizationDisposition::Failed
        })
    }

    pub fn commit_preparation_retry_decision(
        &self,
        decision: &FmsPreparationRetryDecision,
    ) -> Result<PreparationRetryDecisionCommitDisposition> {
        decision.validate()?;
        let _writer_lease = self.write_transaction()?;
        let relative = decision.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            reject_link(&path)?;
            let existing: FmsPreparationRetryDecision = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| {
                format!("parsing preparation retry decision {}", path.display())
            })?;
            existing.validate()?;
            if existing.relative_path()? != relative {
                anyhow::bail!("preparation retry decision identity does not match its path");
            }
            if existing.same_immutable_payload(decision) {
                return Ok(PreparationRetryDecisionCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "preparation retry decision `{}` conflicts with the durable payload",
                decision.decision_id
            );
        }

        self.ensure_development_admission_open_unlocked()?;
        let catalog = self
            .read_run_catalog(&decision.run_id)?
            .context("preparation retry decision requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == decision.task_id)
            .context("preparation retry decision task is missing from the run catalog")?;
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || !matches!(
                &task.readiness,
                FmsTaskReadiness::Blocked { reason }
                    if reason == FMS_TASK_AWAITING_PREPARATION_REASON
            )
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
        {
            anyhow::bail!("preparation retry decision requires an unclaimed awaiting task");
        }
        if self
            .read_task_preparation_receipt(&decision.run_id, &decision.task_id)?
            .is_some()
        {
            anyhow::bail!("prepared task cannot receive a preparation retry decision");
        }
        if self
            .find_active_preparation_resource_lease_for_task_unlocked(
                &decision.run_id,
                &decision.task_id,
            )?
            .is_some()
        {
            anyhow::bail!("active preparation attempt cannot receive a retry decision");
        }

        let failed_receipts = self
            .list_preparation_process_exit_receipts(&decision.run_id)?
            .into_iter()
            .filter(|receipt| receipt.task_id == decision.task_id && !receipt.status_success)
            .collect::<Vec<_>>();
        let mut failed_attempts = std::collections::BTreeMap::new();
        for receipt in failed_receipts {
            if failed_attempts
                .insert(receipt.preparation_attempt_id.clone(), receipt)
                .is_some()
            {
                anyhow::bail!(
                    "preparation task has duplicate failed exit receipts for one attempt"
                );
            }
        }
        let target = failed_attempts
            .get(&decision.failed_preparation_attempt_id)
            .context("preparation retry decision does not reference a failed process exit")?;
        let target_lease = self
            .read_preparation_resource_lease(
                &target.run_id,
                &target.resource_id,
                &target.lease_token,
            )?
            .context("preparation retry decision requires the failed attempt lease")?;
        if target_lease.state != FmsResourceLeaseState::Released
            || target_lease.task_id != decision.task_id
            || target_lease.preparation_attempt_id != decision.failed_preparation_attempt_id
        {
            anyhow::bail!("preparation retry decision requires a finalized failed attempt");
        }

        let mut prior = self
            .list_preparation_retry_decisions(&decision.run_id)?
            .into_iter()
            .filter(|existing| existing.task_id == decision.task_id)
            .collect::<Vec<_>>();
        prior.sort_by_key(|existing| existing.retry_sequence);
        if decision.retry_sequence != prior.len() as u32 + 1
            || failed_attempts.len() != decision.retry_sequence as usize
        {
            anyhow::bail!("preparation retry decision sequence does not match failed attempts");
        }
        let mut decided_attempts = std::collections::BTreeSet::new();
        for (index, existing) in prior.iter().enumerate() {
            if existing.retry_sequence != index as u32 + 1
                || existing.max_attempts != decision.max_attempts
                || !failed_attempts.contains_key(&existing.failed_preparation_attempt_id)
                || !decided_attempts.insert(existing.failed_preparation_attempt_id.as_str())
            {
                anyhow::bail!("preparation retry decision history is inconsistent");
            }
        }
        let undecided = failed_attempts
            .keys()
            .filter(|attempt_id| !decided_attempts.contains(attempt_id.as_str()))
            .collect::<Vec<_>>();
        if undecided.len() != 1 || undecided[0].as_str() != decision.failed_preparation_attempt_id {
            anyhow::bail!("preparation retry decision must authorize the only undecided failure");
        }

        atomic_write(
            &create_parent(&self.root, &relative)?,
            &serde_json::to_vec_pretty(decision)?,
        )?;
        Ok(PreparationRetryDecisionCommitDisposition::Accepted)
    }

    pub fn read_preparation_retry_decision(
        &self,
        run_id: &str,
        decision_id: &str,
    ) -> Result<Option<FmsPreparationRetryDecision>> {
        validate_store_id(run_id)?;
        validate_store_id(decision_id)?;
        let relative = format!("runs/{run_id}/preparation_retry_decisions/{decision_id}.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "preparation retry decision",
        )? else {
            return Ok(None);
        };
        let decision: FmsPreparationRetryDecision = serde_json::from_slice(&data)
            .with_context(|| format!("parsing preparation retry decision {}", path.display()))?;
        if decision.relative_path()? != relative {
            anyhow::bail!("preparation retry decision identity does not match its path");
        }
        Ok(Some(decision))
    }

    pub fn list_preparation_retry_decisions(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsPreparationRetryDecision>> {
        validate_store_id(run_id)?;
        let Some(directory) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/preparation_retry_decisions"),
            "preparation retry decisions",
        )? else {
            return Ok(Vec::new());
        };
        let mut decisions = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                anyhow::bail!(
                    "unsafe preparation retry decision entry `{}`",
                    entry.path().display()
                );
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let decision_id = file_name
                .strip_suffix(".json")
                .context("preparation retry decision entry must be JSON")?;
            validate_store_id(decision_id)?;
            decisions.push(
                self.read_preparation_retry_decision(run_id, decision_id)?
                    .context("listed preparation retry decision disappeared during read")?,
            );
        }
        decisions.sort_by(|left, right| left.decision_id.cmp(&right.decision_id));
        Ok(decisions)
    }

    /// Return the retry sequence authorizing the next preparation attempt.
    /// Sequence zero denotes the initial attempt; `None` means the task is
    /// waiting for a new explicit retry decision.
    pub fn preparation_attempt_authorization_sequence(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<u32>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let _writer_lease = self.write_transaction()?;
        self.preparation_attempt_authorization_sequence_unlocked(run_id, task_id)
    }

    fn preparation_attempt_authorization_sequence_unlocked(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<u32>> {
        let catalog = self
            .read_run_catalog(run_id)?
            .context("preparation attempt authorization requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .context("preparation attempt authorization task is missing from the run catalog")?;
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || !matches!(
                &task.readiness,
                FmsTaskReadiness::Blocked { reason }
                    if reason == FMS_TASK_AWAITING_PREPARATION_REASON
            )
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
            || self
                .read_task_preparation_receipt(run_id, task_id)?
                .is_some()
            || self
                .find_active_preparation_resource_lease_for_task_unlocked(run_id, task_id)?
                .is_some()
        {
            return Ok(None);
        }
        let failed_receipts = self
            .list_preparation_process_exit_receipts(run_id)?
            .into_iter()
            .filter(|receipt| receipt.task_id == task_id && !receipt.status_success)
            .collect::<Vec<_>>();
        let failed_attempts = failed_receipts
            .iter()
            .map(|receipt| receipt.preparation_attempt_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        if failed_attempts.len() != failed_receipts.len() {
            anyhow::bail!("preparation task has duplicate failed exit receipts for one attempt");
        }
        let mut decisions = self
            .list_preparation_retry_decisions(run_id)?
            .into_iter()
            .filter(|decision| decision.task_id == task_id)
            .collect::<Vec<_>>();
        decisions.sort_by_key(|decision| decision.retry_sequence);
        if failed_attempts.is_empty() {
            if decisions.is_empty() {
                return Ok(Some(0));
            }
            anyhow::bail!("preparation retry decisions exist without failed attempts");
        }
        if decisions.len() > failed_attempts.len() {
            anyhow::bail!("preparation retry decision count exceeds failed attempts");
        }
        let mut decided_attempts = std::collections::BTreeSet::new();
        let mut max_attempts = None;
        for (index, decision) in decisions.iter().enumerate() {
            decision.validate()?;
            if decision.retry_sequence != index as u32 + 1
                || !failed_attempts.contains(&decision.failed_preparation_attempt_id)
                || !decided_attempts.insert(decision.failed_preparation_attempt_id.as_str())
                || max_attempts.is_some_and(|value| value != decision.max_attempts)
            {
                anyhow::bail!("preparation retry decision history is inconsistent");
            }
            max_attempts = Some(decision.max_attempts);
        }
        if decisions.len() == failed_attempts.len() {
            Ok(Some(decisions.len() as u32))
        } else {
            Ok(None)
        }
    }

    /// Persist the verified initial coordinator checkpoint before a new claim
    /// is allowed to publish worker commands.
    pub fn commit_coordinator_genesis(
        &self,
        run_id: &str,
        task_id: &str,
        genesis: &FmsCoordinatorGenesis,
    ) -> Result<CoordinatorGenesisCommitDisposition> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let _lease = self.write_transaction()?;
        let mut catalog = self
            .read_run_catalog(run_id)?
            .context("coordinator genesis requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == task_id)
            .context("coordinator genesis task is missing from the run catalog")?;
        let task = &catalog.tasks[task_index];
        genesis.validate_for_task(run_id, task)?;
        if task.attempt_id.as_deref() != Some(genesis.attempt_id.as_str()) {
            anyhow::bail!("coordinator genesis requires the current admitted task attempt");
        }
        if !matches!(task.readiness, FmsTaskReadiness::Ready)
            || !matches!(
                task.lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            )
        {
            anyhow::bail!("coordinator genesis requires an admitted active task");
        }
        let resource_id = task
            .resource_id
            .as_deref()
            .context("coordinator genesis task has no assigned resource")?;
        let lease = self
            .read_resource_lease(run_id, resource_id, &genesis.lease_token)?
            .context("coordinator genesis active resource lease is missing")?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.task_id != task_id
            || lease.attempt_id != genesis.attempt_id
            || lease.ownership_epoch != genesis.ownership_epoch
            || lease.heartbeat_sequence != genesis.lease_heartbeat_sequence
        {
            anyhow::bail!("coordinator genesis active resource lease fence rejected");
        }
        if let Some(existing) = &task.coordinator_genesis {
            if existing == genesis {
                return Ok(CoordinatorGenesisCommitDisposition::Replayed);
            }
            anyhow::bail!("coordinator genesis is immutable within one ownership epoch");
        }
        if task.coordinator_watermark.is_some_and(|watermark| {
            watermark.command_sequence != 0 || watermark.event_sequence != 0
        }) {
            anyhow::bail!("coordinator genesis cannot be added after journal progress");
        }
        if self.read_coordinator_journal(run_id)?.iter().any(|entry| {
            entry.task_id == task_id
                && entry.attempt_id == genesis.attempt_id
                && entry.ownership_epoch == genesis.ownership_epoch
        }) {
            anyhow::bail!("coordinator genesis cannot be added after journal publication");
        }
        catalog.tasks[task_index].coordinator_watermark = Some(FmsCoordinatorWatermark::default());
        catalog.tasks[task_index].coordinator_genesis = Some(genesis.clone());
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        self.commit_run_catalog_unlocked_with_genesis(&catalog, true)?;
        Ok(CoordinatorGenesisCommitDisposition::Accepted)
    }

    /// Append one claim-fenced command or event to the durable coordinator
    /// journal.  Each direction has a strictly contiguous sequence; replaying
    /// the same entry is idempotent while a conflicting or skipped sequence is
    /// rejected before publication.
    pub fn commit_coordinator_journal_entry(
        &self,
        entry: &FmsCoordinatorJournalEntry,
    ) -> Result<CoordinatorJournalCommitDisposition> {
        entry.validate()?;
        let _lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&entry.run_id)?
            .context("coordinator journal entry requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == entry.task_id)
            .context("coordinator journal task is missing from the run catalog")?;
        entry.validate_for_task(task)?;

        let path = self.coordinator_journal_path(entry)?;
        if path.exists() {
            let data = fs::read(&path)
                .with_context(|| format!("reading coordinator journal {}", path.display()))?;
            let existing: FmsCoordinatorJournalEntry = serde_json::from_slice(&data)
                .with_context(|| format!("parsing coordinator journal {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != entry.run_id
                || existing.direction != entry.direction
                || existing.entry_id != entry.entry_id
            {
                anyhow::bail!("coordinator journal identity does not match its path");
            }
            if existing == *entry {
                confirm_publication(&path)?;
                return Ok(CoordinatorJournalCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "coordinator journal entry `{}` conflicts with the durable payload",
                entry.entry_id
            );
        }

        let resource_id = task
            .resource_id
            .as_deref()
            .context("coordinator journal task has no assigned resource")?;
        let active_lease = self
            .read_resource_lease(&entry.run_id, resource_id, &entry.lease_token)?
            .context("active resource lease is missing")?;
        self.require_active_resource_lease(
            &entry.run_id,
            &entry.task_id,
            &entry.attempt_id,
            entry.ownership_epoch,
            resource_id,
            &entry.lease_token,
            active_lease.heartbeat_sequence,
        )?;

        let mut command_watermark = 0_u64;
        let mut event_watermark = 0_u64;
        for existing in self.read_coordinator_journal(&entry.run_id)? {
            if existing.task_id != entry.task_id
                || existing.attempt_id != entry.attempt_id
                || existing.ownership_epoch != entry.ownership_epoch
            {
                continue;
            }
            if existing.lease_token != entry.lease_token {
                anyhow::bail!("coordinator journal lease token changed within one task attempt");
            }
            match existing.direction {
                FmsCoordinatorJournalDirection::Command => {
                    command_watermark = command_watermark.max(existing.sequence)
                }
                FmsCoordinatorJournalDirection::Event => {
                    event_watermark = event_watermark.max(existing.sequence)
                }
            }
        }
        let (entry_command_watermark, entry_event_watermark) = entry.checkpoint_watermarks()?;
        let expected = match entry.direction {
            FmsCoordinatorJournalDirection::Command => (
                command_watermark
                    .checked_add(1)
                    .context("coordinator command watermark exhausted")?,
                event_watermark,
            ),
            FmsCoordinatorJournalDirection::Event => (
                command_watermark,
                event_watermark
                    .checked_add(1)
                    .context("coordinator event watermark exhausted")?,
            ),
        };
        if (entry_command_watermark, entry_event_watermark) != expected {
            anyhow::bail!(
                "coordinator journal cross-stream watermark changed (expected command/event {}/{}, received {}/{})",
                expected.0,
                expected.1,
                entry_command_watermark,
                entry_event_watermark
            );
        }

        let stream_root = checked_path(
            &self.root,
            &format!(
                "runs/{}/coordinator_journal/{}",
                entry.run_id,
                entry.direction.as_str()
            ),
        )?;
        let mut last_sequence = 0_u64;
        let mut terminal = false;
        if stream_root.exists() {
            if !stream_root.is_dir() {
                anyhow::bail!("coordinator journal stream is not a directory");
            }
            for journal_entry in fs::read_dir(&stream_root)? {
                let journal_entry = journal_entry?;
                reject_link(&journal_entry.path())?;
                if !journal_entry.file_type()?.is_file() {
                    anyhow::bail!("coordinator journal entry is not a file");
                }
                let file_name = journal_entry.file_name().to_string_lossy().into_owned();
                let Some(existing_id) = file_name.strip_suffix(".json") else {
                    anyhow::bail!("coordinator journal entry must be JSON");
                };
                validate_store_id(existing_id)?;
                let data = fs::read(journal_entry.path())?;
                let existing: FmsCoordinatorJournalEntry = serde_json::from_slice(&data)?;
                existing.validate()?;
                if existing.run_id != entry.run_id
                    || existing.direction != entry.direction
                    || existing.entry_id != existing_id
                {
                    anyhow::bail!("coordinator journal path identity mismatch");
                }
                // Sequence and terminal fences belong to one task attempt,
                // not all tasks and historical attempts in the run directory.
                if existing.task_id != entry.task_id
                    || existing.attempt_id != entry.attempt_id
                    || existing.ownership_epoch != entry.ownership_epoch
                {
                    continue;
                }
                if existing.lease_token != entry.lease_token {
                    anyhow::bail!(
                        "coordinator journal lease token changed within one task attempt"
                    );
                }
                if existing.sequence == entry.sequence {
                    anyhow::bail!(
                        "coordinator journal sequence {} conflicts with an existing entry",
                        entry.sequence
                    );
                }
                last_sequence = last_sequence.max(existing.sequence);
                terminal |= existing.terminal;
            }
        }
        if terminal {
            anyhow::bail!("coordinator journal stream is already terminal");
        }
        let expected = last_sequence
            .checked_add(1)
            .context("coordinator journal sequence exhausted")?;
        if entry.sequence != expected {
            anyhow::bail!(
                "coordinator journal sequence must advance contiguously (expected {}, received {})",
                expected,
                entry.sequence
            );
        }
        let relative = format!(
            "runs/{}/coordinator_journal/{}/{}.json",
            entry.run_id,
            entry.direction.as_str(),
            entry.entry_id
        );
        atomic_write(
            &create_parent(&self.root, &relative)?,
            &serde_json::to_vec_pretty(entry)?,
        )?;
        Ok(CoordinatorJournalCommitDisposition::Accepted)
    }

    /// Read one durable coordinator journal entry by its stream identity.
    pub fn read_coordinator_journal_entry(
        &self,
        run_id: &str,
        direction: FmsCoordinatorJournalDirection,
        entry_id: &str,
    ) -> Result<Option<FmsCoordinatorJournalEntry>> {
        validate_store_id(run_id)?;
        validate_store_id(entry_id)?;
        let relative = format!(
            "runs/{run_id}/coordinator_journal/{}/{entry_id}.json",
            direction.as_str()
        );
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "coordinator journal entry",
        )? else {
            return Ok(None);
        };
        let entry: FmsCoordinatorJournalEntry = serde_json::from_slice(&data)?;
        entry.validate()?;
        if entry.run_id != run_id || entry.direction != direction || entry.entry_id != entry_id {
            anyhow::bail!("coordinator journal identity does not match its path");
        }
        Ok(Some(entry))
    }

    /// Read a consistent, validated journal snapshot for recovery. Ordering is
    /// per direction and claim, not a causal order between commands and events.
    /// Historical attempts are retained; callers must reconcile the live claim
    /// before sending anything to a worker.
    pub fn read_coordinator_journal(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsCoordinatorJournalEntry>> {
        validate_store_id(run_id)?;
        let _lease = self.write_transaction()?;
        self.read_coordinator_journal_unlocked(run_id)
    }

    fn read_coordinator_journal_unlocked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsCoordinatorJournalEntry>> {
        validate_store_id(run_id)?;
        self.read_run_catalog(run_id)?
            .context("coordinator journal snapshot requires a durable run catalog")?;
        let mut entries = Vec::new();
        for direction in [
            FmsCoordinatorJournalDirection::Command,
            FmsCoordinatorJournalDirection::Event,
        ] {
            let Some(root) = read_present_directory(
                &self.root,
                &format!("runs/{run_id}/coordinator_journal/{}", direction.as_str()),
                "coordinator journal",
            )? else {
                continue;
            };
            for file in fs::read_dir(root)? {
                let file = file?;
                reject_link(&file.path())?;
                if !file.file_type()?.is_file() {
                    anyhow::bail!("coordinator journal entry is not a file");
                }
                let name = file.file_name();
                let id = name
                    .to_str()
                    .and_then(|name| name.strip_suffix(".json"))
                    .context("coordinator journal entry must be UTF-8 JSON")?;
                let entry = self
                    .read_coordinator_journal_entry(run_id, direction, id)?
                    .context("coordinator journal entry disappeared during snapshot")?;
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| {
            (
                a.direction.as_str(),
                &a.task_id,
                &a.attempt_id,
                a.ownership_epoch,
                a.sequence,
            )
                .cmp(&(
                    b.direction.as_str(),
                    &b.task_id,
                    &b.attempt_id,
                    b.ownership_epoch,
                    b.sequence,
                ))
        });
        let mut previous: Option<&FmsCoordinatorJournalEntry> = None;
        for entry in &entries {
            let same_stream = previous.filter(|prior| {
                prior.direction == entry.direction
                    && prior.task_id == entry.task_id
                    && prior.attempt_id == entry.attempt_id
                    && prior.ownership_epoch == entry.ownership_epoch
            });
            let expected = if let Some(prior) = same_stream {
                if prior.terminal {
                    anyhow::bail!("coordinator journal contains an entry after terminal");
                }
                if prior.lease_token != entry.lease_token {
                    anyhow::bail!(
                        "coordinator journal lease token changed within one task attempt"
                    );
                }
                prior
                    .sequence
                    .checked_add(1)
                    .context("coordinator journal sequence exhausted")?
            } else {
                1
            };
            if entry.sequence != expected {
                anyhow::bail!("coordinator journal snapshot has a gap or duplicate sequence");
            }
            previous = Some(entry);
        }
        Ok(entries)
    }

    fn coordinator_journal_path(&self, entry: &FmsCoordinatorJournalEntry) -> Result<PathBuf> {
        Ok(checked_path(
            &self.root,
            &format!(
                "runs/{}/coordinator_journal/{}/{}.json",
                entry.run_id,
                entry.direction.as_str(),
                entry.entry_id
            ),
        )?)
    }

    /// Mark non-terminal task observations as reconciling after a coordinator
    /// restart.  Lifecycle and ownership are preserved; this method never
    /// invents a retry or a new attempt.
    pub fn reconcile_run_catalog(&self, run_id: &str) -> Result<Option<FmsRunCatalog>> {
        // Reconciliation is a read-modify-publish transaction. Acquire before
        // reading so a concurrent writer cannot make this snapshot stale.
        let _lease = self.write_transaction()?;
        let Some(mut catalog) = self.read_run_catalog(run_id)? else {
            return Ok(None);
        };
        let mut changed = false;
        for task in &mut catalog.tasks {
            if matches!(
                task.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            ) {
                continue;
            }
            if task.observation != Some(FmsObservationState::Reconciling) {
                task.observation = Some(FmsObservationState::Reconciling);
                changed = true;
            }
        }
        if !changed {
            return Ok(Some(catalog));
        }
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        catalog.validate()?;
        self.commit_run_catalog_unlocked(&catalog)?;
        Ok(Some(catalog))
    }

    /// Publish an immutable artifact catalog snapshot after ownership fencing.
    ///
    /// New entries must match the current task attempt/epoch in the durable
    /// run catalog. Existing immutable entries remain in the append-only
    /// catalog across retries; a newer revision may only append entries.
    pub(crate) fn commit_artifact_catalog(&self, catalog: &FmsArtifactCatalog) -> Result<()> {
        catalog.validate()?;
        let _lease = self.write_transaction()?;
        self.commit_artifact_catalog_unlocked(catalog, false)
    }

    fn commit_artifact_catalog_unlocked(
        &self,
        catalog: &FmsArtifactCatalog,
        allow_active_study_outputs: bool,
    ) -> Result<()> {
        catalog.validate()?;
        let run_catalog = self
            .read_run_catalog(&catalog.run_id)?
            .context("artifact publication requires a durable run catalog")?;
        let owners = run_catalog
            .tasks
            .iter()
            .filter_map(|task| {
                Some((
                    task.task_id.as_str(),
                    (
                        task.attempt_id.as_deref()?,
                        task.ownership_epoch?,
                        task.lifecycle,
                    ),
                ))
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let path = checked_path(
            &self.root,
            &format!("runs/{}/artifact_catalog.json", catalog.run_id),
        )?;
        let existing = if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsArtifactCatalog = serde_json::from_slice(&data)
                .with_context(|| format!("parsing artifact catalog {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != catalog.run_id {
                anyhow::bail!("artifact catalog identity does not match its path");
            }
            Some(existing)
        } else {
            None
        };
        for entry in &catalog.entries {
            let previous = existing.as_ref().and_then(|existing| {
                existing
                    .entries
                    .iter()
                    .find(|previous| previous.artifact_id == entry.artifact_id)
            });
            if let Some(previous) = previous {
                if previous != entry {
                    anyhow::bail!(
                        "artifact `{}` cannot be replaced after publication",
                        entry.artifact_id
                    );
                }
            } else {
                let Some((attempt_id, ownership_epoch, lifecycle)) =
                    owners.get(entry.task_id.as_str())
                else {
                    anyhow::bail!(
                        "artifact `{}` references a task without a current ownership claim",
                        entry.artifact_id
                    );
                };
                if *attempt_id != entry.attempt_id || *ownership_epoch != entry.ownership_epoch {
                    anyhow::bail!(
                        "artifact `{}` ownership fence does not match task `{}`",
                        entry.artifact_id,
                        entry.task_id
                    );
                }
                if entry.study_output.is_some()
                    && *lifecycle != FmsTaskLifecycle::Succeeded
                    && !(allow_active_study_outputs
                        && matches!(
                            lifecycle,
                            FmsTaskLifecycle::Preparing
                                | FmsTaskLifecycle::Running
                                | FmsTaskLifecycle::Stopping
                        ))
                {
                    anyhow::bail!(
                        "study output artifact `{}` requires a succeeded task or an active lease on an active task",
                        entry.artifact_id
                    );
                }
            }
            if matches!(entry.status, FmsArtifactStatus::Published) {
                let Some(object_ref) = entry.object_ref.as_deref() else {
                    anyhow::bail!(
                        "published artifact `{}` requires a CAS object reference",
                        entry.artifact_id
                    );
                };
                let object_path =
                    checked_path(&self.root, &format!("objects/sha256/{object_ref}"))?;
                if !object_path.is_file() {
                    anyhow::bail!(
                        "published artifact `{}` references missing object `{object_ref}`",
                        entry.artifact_id
                    );
                }
                let actual = crate::cas::hex_sha256(&fs::read(object_path)?);
                if actual != object_ref {
                    anyhow::bail!("artifact CAS object digest mismatch for `{object_ref}`");
                }
            }
        }

        if let Some(existing) = existing {
            if existing.revision > catalog.revision {
                anyhow::bail!(
                    "stale artifact catalog revision {}; current revision is {}",
                    catalog.revision,
                    existing.revision
                );
            }
            for previous in &existing.entries {
                let Some(next) = catalog
                    .entries
                    .iter()
                    .find(|entry| entry.artifact_id == previous.artifact_id)
                else {
                    anyhow::bail!(
                        "artifact `{}` cannot be removed from an immutable catalog",
                        previous.artifact_id
                    );
                };
                if next != previous {
                    anyhow::bail!(
                        "artifact `{}` cannot be replaced after publication",
                        previous.artifact_id
                    );
                }
            }
            if existing.revision == catalog.revision {
                if existing == *catalog {
                    return Ok(());
                }
                anyhow::bail!(
                    "artifact catalog revision {} conflicts with the durable payload",
                    catalog.revision
                );
            }
        }
        let path = create_parent(
            &self.root,
            &format!("runs/{}/artifact_catalog.json", catalog.run_id),
        )?;
        let json = serde_json::to_vec_pretty(catalog)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Atomically append artifact entries while the exact publishing lease is
    /// still active. This fences publication against retry and lease release,
    /// including a release racing the final catalog write.
    pub fn append_artifact_catalog_entries_for_lease(
        &self,
        lease: &FmsResourceLease,
        entries: &[FmsArtifactCatalogEntry],
    ) -> Result<FmsArtifactCatalog> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("artifact publication requires an active resource lease");
        }
        if entries.is_empty() {
            anyhow::bail!("artifact catalog append requires at least one entry");
        }
        let _writer_lease = self.write_transaction()?;
        let lease_path = self.resource_lease_path(lease)?;
        let lease_bytes = fs::read(&lease_path)
            .with_context(|| format!("reading resource lease {}", lease_path.display()))?;
        let current_lease: FmsResourceLease = serde_json::from_slice(&lease_bytes)
            .with_context(|| format!("parsing resource lease {}", lease_path.display()))?;
        current_lease.validate()?;
        if current_lease.state != FmsResourceLeaseState::Active
            || !current_lease.identity_matches(lease)
            || current_lease.kind != lease.kind
            || current_lease.budget != lease.budget
            || current_lease.heartbeat_sequence < lease.heartbeat_sequence
        {
            anyhow::bail!("artifact publication lease fence rejected");
        }

        let mut run_catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("artifact publication requires a durable run catalog")?;
        let task_index = run_catalog
            .tasks
            .iter()
            .position(|task| task.task_id == lease.task_id)
            .context("artifact publication task is missing from the run catalog")?;
        let task = &run_catalog.tasks[task_index];
        if task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
            || task.resource_id.as_deref() != Some(lease.resource_id.as_str())
        {
            anyhow::bail!("artifact publication lease does not match the current task owner");
        }
        let task_lifecycle = task.lifecycle;

        let existing = self.read_artifact_catalog(&lease.run_id)?;
        let manifest_already_published = existing.as_ref().is_some_and(|catalog| {
            catalog.entries.iter().any(|entry| {
                entry.task_id == lease.task_id
                    && entry.attempt_id == lease.attempt_id
                    && entry.ownership_epoch == lease.ownership_epoch
                    && entry.artifact_type == "study_output_manifest"
            })
        });
        if manifest_already_published {
            let existing = existing
                .as_ref()
                .context("published output manifest has no artifact catalog")?;
            for entry in entries {
                let is_output_or_manifest = entry.study_output.is_some()
                    || matches!(
                        entry.artifact_type.as_str(),
                        "study_output_manifest"
                            | "accepted_quantity_bundle"
                            | FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE
                            | FMS_OBSERVATION_STATE_ARTIFACT_TYPE
                            | "accepted_primary_carrier"
                            | "output_history_index"
                            | "output_history_page"
                            | "output_history_sample"
                    );
                let exact_existing_entry = existing
                    .entries
                    .iter()
                    .any(|previous| previous.artifact_id == entry.artifact_id && previous == entry);
                if is_output_or_manifest && !exact_existing_entry {
                    anyhow::bail!(
                        "study output manifest is the immutable allow-list for attempt `{}`",
                        lease.attempt_id
                    );
                }
            }
        }
        let mut catalog = existing.clone().unwrap_or_else(|| FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: lease.run_id.clone(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            entries: Vec::new(),
        });
        let mut changed = false;
        for entry in entries {
            if entry.task_id != lease.task_id
                || entry.attempt_id != lease.attempt_id
                || entry.ownership_epoch != lease.ownership_epoch
            {
                anyhow::bail!(
                    "artifact `{}` ownership does not match the publishing lease",
                    entry.artifact_id
                );
            }
            if let Some(previous) = catalog
                .entries
                .iter()
                .find(|previous| previous.artifact_id == entry.artifact_id)
            {
                if previous != entry {
                    anyhow::bail!(
                        "artifact `{}` cannot be replaced after publication",
                        entry.artifact_id
                    );
                }
                continue;
            }
            catalog.entries.push(entry.clone());
            changed = true;
        }
        if changed
            && !matches!(
                task_lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            )
        {
            anyhow::bail!("new study outputs must be published before task completion");
        }
        if changed {
            if existing.is_some() {
                catalog.revision = catalog
                    .revision
                    .checked_add(1)
                    .context("artifact catalog revision exhausted")?;
            }
            catalog.updated_at = chrono::Utc::now();
            self.commit_artifact_catalog_unlocked(&catalog, true)?;
        }

        // The artifact catalog is canonical; task.artifact_ids is a query
        // projection used by run APIs. Repair it on exact replays as well, so
        // a crash between the two durable writes does not strand an output.
        let mut projection_changed = false;
        for artifact_id in catalog
            .entries
            .iter()
            .filter(|entry| entry.task_id == lease.task_id)
            .map(|entry| &entry.artifact_id)
        {
            let task = &mut run_catalog.tasks[task_index];
            if !task.artifact_ids.contains(artifact_id) {
                task.artifact_ids.push(artifact_id.clone());
                projection_changed = true;
            }
        }
        if projection_changed {
            run_catalog.revision = run_catalog
                .revision
                .checked_add(1)
                .context("run catalog revision exhausted while projecting study outputs")?;
            run_catalog.updated_at = chrono::Utc::now();
            self.commit_run_catalog_unlocked(&run_catalog)?;
        }
        Ok(catalog)
    }

    /// Read the durable artifact catalog for one run, if present.
    pub fn read_artifact_catalog(&self, run_id: &str) -> Result<Option<FmsArtifactCatalog>> {
        validate_store_id(run_id)?;
        let relative = format!("runs/{run_id}/artifact_catalog.json");
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "artifact catalog",
        )? else {
            return Ok(None);
        };
        let catalog: FmsArtifactCatalog = serde_json::from_slice(&data)?;
        catalog.validate()?;
        if catalog.run_id != run_id {
            anyhow::bail!("artifact catalog identity does not match its path");
        }
        Ok(Some(catalog))
    }

    /// Persist the external dispatch identity before contacting its provider.
    /// Replaying the same identity returns `Replayed`, including after the
    /// stored status has advanced; it never authorizes a second submission.
    pub fn prepare_provider_job_submission(
        &self,
        submission: &FmsProviderJobSubmission,
    ) -> Result<ProviderJobSubmissionDisposition> {
        submission.validate()?;
        if submission.status != FmsProviderJobStatus::SubmissionUnknown
            || submission.provider_job_id.is_some()
            || submission.revision != 1
            || submission.updated_at != submission.created_at
        {
            anyhow::bail!("provider dispatch intent must start in submission_unknown revision 1");
        }

        let _writer_lease = self.write_transaction()?;
        self.ensure_development_admission_open_unlocked()?;
        let path = self.provider_job_submission_path(
            &submission.run_id,
            &submission.task_id,
            &submission.attempt_id,
        )?;
        reject_link(&path)?;
        if let Some(existing) = self.read_provider_job_submission(
            &submission.run_id,
            &submission.task_id,
            &submission.attempt_id,
        )? {
            if existing.matches_dispatch_identity(submission) {
                return Ok(ProviderJobSubmissionDisposition::Replayed);
            }
            anyhow::bail!("provider dispatch attempt conflicts with its durable identity");
        }

        self.ensure_provider_jobs_terminal_for_task_unlocked(
            &submission.run_id,
            &submission.task_id,
        )?;
        let admission = self
            .read_task_admission(
                &submission.run_id,
                &submission.task_id,
                &submission.attempt_id,
            )?
            .context("provider dispatch requires a durable task admission")?;
        if admission.lease.ownership_epoch != submission.ownership_epoch
            || admission.lease.resource_id != submission.resource_id
            || admission.task.attempt_id.as_deref() != Some(submission.attempt_id.as_str())
            || admission.task.ownership_epoch != Some(submission.ownership_epoch)
            || admission.lease.state != FmsResourceLeaseState::Active
        {
            anyhow::bail!("provider dispatch does not match an active admitted attempt");
        }
        let current_lease = self
            .read_resource_lease(
                &submission.run_id,
                &admission.lease.resource_id,
                &admission.lease.lease_token,
            )?
            .context("provider dispatch resource lease is missing")?;
        if current_lease.state != FmsResourceLeaseState::Active
            || !current_lease.identity_matches(&admission.lease)
            || current_lease.kind != admission.lease.kind
            || current_lease.budget != admission.lease.budget
        {
            anyhow::bail!("provider dispatch requires the exact active admitted resource lease");
        }
        let catalog = self
            .read_run_catalog(&submission.run_id)?
            .context("provider dispatch requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == submission.task_id)
            .context("provider dispatch task is missing from the run catalog")?;
        if task.lifecycle != FmsTaskLifecycle::Preparing
            || task.attempt_id.as_deref() != Some(submission.attempt_id.as_str())
            || task.ownership_epoch != Some(submission.ownership_epoch)
        {
            anyhow::bail!("provider dispatch does not match the current preparing attempt");
        }

        let path = create_parent(
            &self.root,
            &format!(
                "runs/{}/provider_job_submissions/{}/{}.json",
                submission.run_id, submission.task_id, submission.attempt_id
            ),
        )?;
        atomic_write(&path, &serde_json::to_vec_pretty(submission)?)?;
        Ok(ProviderJobSubmissionDisposition::Prepared)
    }

    /// Record a provider acknowledgement or lifecycle observation using
    /// compare-and-swap revisioning. The same provider job ID is immutable.
    pub fn commit_provider_job_observation(
        &self,
        observation: &FmsProviderJobSubmission,
    ) -> Result<ProviderJobSubmissionDisposition> {
        observation.validate()?;
        let _writer_lease = self.write_transaction()?;
        let existing = self
            .read_provider_job_submission(
                &observation.run_id,
                &observation.task_id,
                &observation.attempt_id,
            )?
            .context("provider job observation requires a durable dispatch intent")?;
        if existing == *observation {
            return Ok(ProviderJobSubmissionDisposition::Replayed);
        }
        observation.validate_transition_from(&existing)?;

        let catalog = self
            .read_run_catalog(&observation.run_id)?
            .context("provider job observation requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == observation.task_id)
            .context("provider job observation task is missing from the run catalog")?;
        if task.attempt_id.as_deref() != Some(observation.attempt_id.as_str())
            || task.ownership_epoch != Some(observation.ownership_epoch)
        {
            anyhow::bail!("provider job observation ownership fence is stale");
        }

        let path = self.provider_job_submission_path(
            &observation.run_id,
            &observation.task_id,
            &observation.attempt_id,
        )?;
        atomic_write(&path, &serde_json::to_vec_pretty(observation)?)?;
        Ok(ProviderJobSubmissionDisposition::Updated)
    }

    /// Read one durable provider job binding by its exact attempt identity.
    pub fn read_provider_job_submission(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<Option<FmsProviderJobSubmission>> {
        let path = self.provider_job_submission_path(run_id, task_id, attempt_id)?;
        let relative_path = path
            .strip_prefix(&self.root)
            .context("provider job submission path is outside the session store")?
            .to_string_lossy()
            .replace('\\', "/");
        let data = match crate::repository_path::read_bounded_regular_file(
            &self.root,
            &relative_path,
            MAX_PROVIDER_JOB_SUBMISSION_BYTES,
        ) {
            Ok(data) => data,
            Err(error) => {
                let is_not_found = error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound);
                if is_not_found {
                    let root_metadata = fs::metadata(&self.root)
                        .context("validating session store root after missing provider job")?;
                    if !root_metadata.is_dir() {
                        anyhow::bail!("session store root is not a directory");
                    }
                    return Ok(None);
                }
                return Err(error).with_context(|| {
                    format!("reading provider job submission {}", path.display())
                });
            }
        };
        let submission: FmsProviderJobSubmission = serde_json::from_slice(&data)
            .with_context(|| format!("parsing provider job submission {}", path.display()))?;
        submission
            .validate()
            .with_context(|| format!("validating provider job submission {}", path.display()))?;
        if submission.run_id != run_id
            || submission.task_id != task_id
            || submission.attempt_id != attempt_id
        {
            anyhow::bail!("provider job submission identity does not match its path");
        }
        Ok(Some(submission))
    }

    /// Enumerate provider bindings for coordinator restart/reconnect recovery.
    pub fn list_provider_job_submissions(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsProviderJobSubmission>> {
        validate_store_id(run_id)?;
        let _writer_lease = self.write_transaction()?;
        self.list_provider_job_submissions_unlocked(run_id)
    }

    fn list_provider_job_submissions_unlocked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsProviderJobSubmission>> {
        validate_store_id(run_id)?;
        let root = checked_path(&self.root, &format!("runs/{run_id}/provider_job_submissions"))?;
        reject_link(&root)?;
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut submissions = Vec::new();
        for task_dir in fs::read_dir(&root)? {
            let task_dir = task_dir?;
            reject_link(&task_dir.path())?;
            if !task_dir.file_type()?.is_dir() {
                anyhow::bail!("provider job submission task entry is not a directory");
            }
            let task_id = task_dir
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 provider job task identity"))?;
            validate_store_id(&task_id)?;
            submissions.extend(self.provider_job_submissions_for_task_unlocked(run_id, &task_id)?);
        }
        submissions.sort_by(|left, right| {
            left.task_id
                .cmp(&right.task_id)
                .then_with(|| left.ownership_epoch.cmp(&right.ownership_epoch))
                .then_with(|| left.attempt_id.cmp(&right.attempt_id))
        });
        Ok(submissions)
    }

    /// Admit one queued task using a durable intent before publishing its
    /// preparing catalog projection and resource lease. Replaying the same
    /// lease finishes an interrupted admission; a new token cannot replace it.
    pub fn commit_task_admission(
        &self,
        lease: &FmsResourceLease,
    ) -> Result<TaskAdmissionCommitDisposition> {
        self.commit_task_admission_with_inputs(lease, &None)
    }

    /// Durably admit a fresh claim together with its exact resolved inputs.
    /// Replaying an attempt must supply the same captured input snapshot.
    pub fn commit_task_admission_with_inputs(
        &self,
        lease: &FmsResourceLease,
        resolved_inputs_snapshot: &Option<FmsResolvedInputsSnapshot>,
    ) -> Result<TaskAdmissionCommitDisposition> {
        lease.validate()?;
        if let Some(snapshot) = resolved_inputs_snapshot {
            snapshot.validate()?;
        }
        if lease.state != FmsResourceLeaseState::Active || lease.heartbeat_sequence != 0 {
            anyhow::bail!("task admission requires a fresh active resource lease");
        }
        let _writer_lease = self.write_transaction()?;
        self.ensure_development_admission_open_unlocked()?;
        if self.read_run_intent(&lease.run_id)?.is_some()
            && !self.accepted_run_start_permitted(&lease.run_id)?
        {
            anyhow::bail!("accepted run is waiting for explicit Compute release");
        }
        let record_path =
            self.task_admission_path(&lease.run_id, &lease.task_id, &lease.attempt_id)?;
        if record_path.exists() {
            let record: FmsTaskAdmissionRecord = serde_json::from_slice(&fs::read(&record_path)?)
                .context("parsing durable task admission")?;
            record.validate()?;
            if !record.lease.identity_matches(lease)
                || record.lease.kind != lease.kind
                || record.lease.budget != lease.budget
                || record.lease.state != lease.state
                || record.lease.heartbeat_sequence != lease.heartbeat_sequence
                || record.resolved_inputs_snapshot != *resolved_inputs_snapshot
            {
                anyhow::bail!(
                    "task admission attempt conflicts with its durable lease or resolved inputs"
                );
            }
            return self.apply_task_admission_record_unlocked(&record);
        }
        if self
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            anyhow::bail!("task cancellation intent blocks new solver admission");
        }

        let catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("task admission requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == lease.task_id)
            .context("task admission target is missing from the run catalog")?;
        let queued_task = catalog.tasks[task_index].clone();
        if queued_task.lifecycle != FmsTaskLifecycle::Queued
            || queued_task.readiness != FmsTaskReadiness::Ready
            || queued_task.attempt_id.is_some()
            || queued_task.resource_id.is_some()
        {
            anyhow::bail!("task admission requires a ready, unclaimed queued task");
        }
        self.ensure_provider_jobs_terminal_for_task_unlocked(&lease.run_id, &lease.task_id)?;
        let expected_epoch = queued_task
            .ownership_epoch
            .map_or(Some(1), |epoch| epoch.checked_add(1))
            .context("task ownership epoch exhausted")?;
        if lease.ownership_epoch != expected_epoch {
            anyhow::bail!("task admission lease has a stale or skipped ownership epoch");
        }
        if self
            .find_active_resource_lease_unlocked(&lease.resource_id)?
            .is_some()
        {
            anyhow::bail!("task admission resource already has an active lease");
        }

        let mut task = queued_task.clone();
        task.lifecycle = FmsTaskLifecycle::Preparing;
        task.readiness = FmsTaskReadiness::Ready;
        task.attempt_id = Some(lease.attempt_id.clone());
        task.ownership_epoch = Some(lease.ownership_epoch);
        task.resource_id = Some(lease.resource_id.clone());
        task.resolved_input_fingerprint = None;
        task.coordinator_watermark = None;
        task.coordinator_genesis = None;
        let record = FmsTaskAdmissionRecord {
            schema_version: FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: catalog.revision,
            queued_task,
            task,
            lease: lease.clone(),
            resolved_inputs_snapshot: resolved_inputs_snapshot.clone(),
        };
        record.validate()?;

        if record_path.exists() {
            anyhow::bail!("task admission record path already exists");
        }
        let record_path = create_parent(
            &self.root,
            &format!(
                "runs/{}/task_admissions/{}/{}.json",
                lease.run_id, lease.task_id, lease.attempt_id
            ),
        )?;
        atomic_write(&record_path, &serde_json::to_vec_pretty(&record)?)?;
        self.apply_task_admission_record_unlocked(&record)
    }

    /// Read one durable task admission record by its exact run/task/attempt identity.
    pub fn read_task_admission(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<Option<FmsTaskAdmissionRecord>> {
        let path = self.task_admission_path(run_id, task_id, attempt_id)?;
        let relative_path = path
            .strip_prefix(&self.root)
            .context("task admission path is outside the session store")?
            .to_string_lossy()
            .replace('\\', "/");
        let data = match crate::repository_path::read_bounded_regular_file(
            &self.root,
            &relative_path,
            MAX_TASK_ADMISSION_RECORD_BYTES,
        ) {
            Ok(data) => data,
            Err(error) => {
                let is_not_found = error
                    .downcast_ref::<std::io::Error>()
                    .map(|error| error.kind() == std::io::ErrorKind::NotFound)
                    .unwrap_or(false);
                if is_not_found {
                    let root_metadata = fs::metadata(&self.root)
                        .context("validating session store root after missing task admission")?;
                    if !root_metadata.is_dir() {
                        anyhow::bail!("session store root is not a directory");
                    }
                    return Ok(None);
                }
                return Err(error)
                    .with_context(|| format!("reading task admission record {}", path.display()));
            }
        };
        let record: FmsTaskAdmissionRecord = serde_json::from_slice(&data)
            .with_context(|| format!("parsing task admission {}", path.display()))?;
        record
            .validate()
            .with_context(|| format!("validating task admission {}", path.display()))?;
        if record.lease.run_id != run_id
            || record.lease.task_id != task_id
            || record.task.task_id != task_id
            || record.queued_task.task_id != task_id
            || record.lease.attempt_id != attempt_id
            || record.task.attempt_id.as_deref() != Some(attempt_id)
        {
            anyhow::bail!("task admission identity does not match its path");
        }
        Ok(Some(record))
    }

    /// Enumerate immutable admission records without replaying them. Directory
    /// and leaf reads use the canonical bounded regular-file reader, so links,
    /// FIFOs, nonregular leaves, and oversized records fail closed. This is a
    /// bounded no-follow observation, not an inode-CAS claim against an
    /// untrusted concurrent writer.
    fn list_task_admissions_for_run_locked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsTaskAdmissionRecord>> {
        validate_store_id(run_id)?;
        let Some(root) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/task_admissions"),
            "task admissions",
        )? else {
            return Ok(Vec::new());
        };
        let mut records = Vec::new();
        for task_entry in fs::read_dir(&root)? {
            let task_entry = task_entry?;
            reject_link(&task_entry.path())?;
            if !task_entry.file_type()?.is_dir() {
                anyhow::bail!("task admission task entry is not a directory");
            }
            let task_id = task_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 task admission task id"))?;
            validate_store_id(&task_id)?;
            for entry in fs::read_dir(task_entry.path())? {
                let entry = entry?;
                reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("task admission record is not a regular file");
                }
                let file_name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("non-UTF8 task admission filename"))?;
                let attempt_id = file_name
                    .strip_suffix(".json")
                    .context("task admission record must be JSON")?;
                validate_store_id(attempt_id)?;
                records.push(
                    self.read_task_admission(run_id, &task_id, attempt_id)?
                        .context("listed task admission disappeared during read")?,
                );
            }
        }
        records.sort_by(|left, right| {
            left.task
                .task_id
                .cmp(&right.task.task_id)
                .then_with(|| left.lease.attempt_id.cmp(&right.lease.attempt_id))
        });
        Ok(records)
    }

    /// Enumerate every immutable solver lease for one run, including released
    /// history. A terminal proof must retain older retry attempts rather than
    /// projecting only the current task claim.
    fn list_resource_leases_for_run_locked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsResourceLease>> {
        validate_store_id(run_id)?;
        let Some(root) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/resource_leases"),
            "resource leases",
        )? else {
            return Ok(Vec::new());
        };
        let mut leases = Vec::new();
        for resource_entry in fs::read_dir(&root)? {
            let resource_entry = resource_entry?;
            reject_link(&resource_entry.path())?;
            if !resource_entry.file_type()?.is_dir() {
                anyhow::bail!("resource lease resource entry is not a directory");
            }
            let resource_id = resource_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 resource id"))?;
            validate_store_id(&resource_id)?;
            for entry in fs::read_dir(resource_entry.path())? {
                let entry = entry?;
                reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("resource lease entry is not a regular file");
                }
                let file_name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("non-UTF8 resource lease filename"))?;
                let token = file_name
                    .strip_suffix(".json")
                    .context("resource lease filename must be JSON")?;
                validate_store_id(token)?;
                leases.push(
                    self.read_resource_lease(run_id, &resource_id, token)?
                        .context("listed resource lease disappeared during read")?,
                );
            }
        }
        leases.sort_by(|left, right| {
            left.resource_id
                .cmp(&right.resource_id)
                .then_with(|| left.lease_token.cmp(&right.lease_token))
        });
        Ok(leases)
    }

    /// Enumerate every immutable preparation lease for one run, including
    /// released history. Process absence is never inferred here.
    fn list_preparation_resource_leases_for_run_locked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsPreparationResourceLease>> {
        validate_store_id(run_id)?;
        let Some(root) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/preparation_resource_leases"),
            "preparation resource leases",
        )? else {
            return Ok(Vec::new());
        };
        let mut leases = Vec::new();
        for resource_entry in fs::read_dir(&root)? {
            let resource_entry = resource_entry?;
            reject_link(&resource_entry.path())?;
            if !resource_entry.file_type()?.is_dir() {
                anyhow::bail!("preparation resource lease entry is not a directory");
            }
            let resource_id = resource_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 preparation resource id"))?;
            validate_store_id(&resource_id)?;
            for entry in fs::read_dir(resource_entry.path())? {
                let entry = entry?;
                reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("preparation resource lease is not a regular file");
                }
                let file_name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("non-UTF8 preparation lease filename"))?;
                let token = file_name
                    .strip_suffix(".json")
                    .context("preparation resource lease filename must be JSON")?;
                validate_store_id(token)?;
                let lease = self
                    .read_preparation_resource_lease(run_id, &resource_id, token)?
                    .context("listed preparation resource lease disappeared during read")?;
                lease.validate()?;
                leases.push(lease);
            }
        }
        leases.sort_by(|left, right| {
            left.resource_id
                .cmp(&right.resource_id)
                .then_with(|| left.lease_token.cmp(&right.lease_token))
        });
        Ok(leases)
    }

    /// Enumerate every immutable task preparation receipt for one run. The
    /// directory is the history authority: an entry for a task absent from
    /// the current catalog is an error rather than an omitted observation.
    fn list_task_preparation_receipts_for_run_locked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsTaskPreparationReceipt>> {
        validate_store_id(run_id)?;
        let Some(root) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/task_preparation_receipts"),
            "task preparation receipts",
        )? else {
            return Ok(Vec::new());
        };
        let mut receipts = Vec::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_file() {
                anyhow::bail!("task preparation receipt entry is not a regular file");
            }
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 task preparation receipt filename"))?;
            let task_id = file_name
                .strip_suffix(".json")
                .context("task preparation receipt filename must be JSON")?;
            validate_store_id(task_id)?;
            receipts.push(
                self.read_task_preparation_receipt(run_id, task_id)?
                    .with_context(|| {
                        format!("listed task preparation receipt `{task_id}` disappeared")
                    })?,
            );
        }
        receipts.sort_by(|left, right| left.task_id.cmp(&right.task_id));
        Ok(receipts)
    }

    /// Enumerate every immutable accepted-stage receipt for one run. Each
    /// entry is revalidated against its exact task receipt using bounded
    /// no-follow reads before it can contribute to terminal evidence.
    fn list_accepted_stage_preparation_receipts_for_run_locked(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsAcceptedStagePreparationReceipt>> {
        validate_store_id(run_id)?;
        let Some(root) = read_present_directory(
            &self.root,
            &format!("runs/{run_id}/accepted_stage_preparation_receipts"),
            "accepted stage preparation receipts",
        )? else {
            return Ok(Vec::new());
        };
        let mut receipts = Vec::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_file() {
                anyhow::bail!("accepted stage preparation receipt entry is not a regular file");
            }
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 accepted stage receipt filename"))?;
            let expected_task_id = file_name
                .strip_suffix(".json")
                .context("accepted stage receipt filename must be JSON")?;
            validate_store_id(expected_task_id)?;
            let relative = format!(
                "runs/{run_id}/accepted_stage_preparation_receipts/{file_name}"
            );
            let data = read_bounded_regular_file(
                &self.root,
                &relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let receipt: FmsAcceptedStagePreparationReceipt = serde_json::from_slice(&data)
                .with_context(|| format!("parsing accepted stage receipt {relative}"))?;
            if receipt.relative_path()? != relative || receipt.task_id != expected_task_id {
                anyhow::bail!("accepted stage receipt identity does not match its path");
            }
            let task_receipt = self
                .read_task_preparation_receipt(run_id, expected_task_id)?
                .context("accepted stage receipt requires its immutable task receipt")?;
            if !receipt.matches_task_receipt(&task_receipt) {
                anyhow::bail!(
                    "accepted stage receipt does not match the immutable task preparation receipt"
                );
            }
            receipts.push(receipt);
        }
        receipts.sort_by(|left, right| left.task_id.cmp(&right.task_id));
        Ok(receipts)
    }

    /// Build terminal evidence while the caller holds the SessionStore writer.
    /// This is a typed read-only operation: it never reconciles, releases, or
    /// creates a record. The host callbacks authorize only the two canonical
    /// no-spawn/provenance cases; an unbound released lease still needs a
    /// durable process-exit receipt.
    pub(crate) fn terminal_run_evidence_value_locked<WF, PF>(
        &self,
        run_id: &str,
        worker_proof: WF,
        preparation_proof: PF,
    ) -> Result<serde_json::Value>
    where
        WF: Fn(&FmsResourceLease, Option<&FmsWorkerProcessExitReceipt>) -> Result<Option<&'static str>>,
        PF: Fn(
            &FmsPreparationResourceLease,
            Option<&FmsPreparationProcessExitReceipt>,
        ) -> Result<Option<&'static str>>,
    {
        validate_store_id(run_id)?;
        let catalog = self
            .read_run_catalog(run_id)?
            .context("terminal evidence requires a durable run catalog")?;
        catalog.validate()?;
        if catalog.tasks.is_empty()
            || catalog
                .tasks
                .iter()
                .any(|task| !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Succeeded
                        | FmsTaskLifecycle::Failed
                        | FmsTaskLifecycle::Cancelled
                        | FmsTaskLifecycle::Interrupted
                ))
        {
            anyhow::bail!("terminal evidence requires every catalog task to be terminal");
        }

        let catalog_task_ids = catalog
            .tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<HashSet<_>>();
        let require_catalog_task = |task_id: &str, evidence_kind: &str| -> Result<()> {
            if !catalog_task_ids.contains(task_id) {
                anyhow::bail!(
                    "terminal evidence {evidence_kind} references task `{task_id}` absent from the current run catalog"
                );
            }
            Ok(())
        };
        let require_catalog_task_input =
            |task_id: &str, input_fingerprint: &str, evidence_kind: &str| -> Result<()> {
                let current = catalog
                    .tasks
                    .iter()
                    .find(|task| task.task_id == task_id)
                    .with_context(|| {
                        format!(
                            "terminal evidence {evidence_kind} references task `{task_id}` absent from the current run catalog"
                        )
                    })?;
                if current.input_fingerprint != input_fingerprint {
                    anyhow::bail!(
                        "terminal evidence {evidence_kind} changed immutable input fingerprint for task `{task_id}`"
                    );
                }
                Ok(())
            };

        let admissions = self.list_task_admissions_for_run_locked(run_id)?;
        let leases = self.list_resource_leases_for_run_locked(run_id)?;
        if leases
            .iter()
            .any(|lease| lease.state == FmsResourceLeaseState::Active)
        {
            anyhow::bail!("terminal evidence has an active solver lease");
        }
        for admission in &admissions {
            require_catalog_task(&admission.task.task_id, "admission")?;
            if admission.queued_task.input_fingerprint != admission.task.input_fingerprint {
                anyhow::bail!(
                    "task admission has inconsistent immutable input fingerprint for task `{}`",
                    admission.task.task_id
                );
            }
            require_catalog_task_input(
                &admission.task.task_id,
                &admission.queued_task.input_fingerprint,
                "admission",
            )?;
        }
        for lease in &leases {
            require_catalog_task(&lease.task_id, "solver lease")?;
        }
        let admission_matches_lease = |admission: &FmsTaskAdmissionRecord,
                                       lease: &FmsResourceLease| {
            admission.lease.identity_matches(lease)
                && admission.lease.kind == lease.kind
                && admission.lease.budget == lease.budget
        };
        for lease in &leases {
            lease.validate()?;
            let matching_admissions = admissions
                .iter()
                .filter(|admission| admission_matches_lease(admission, lease))
                .count();
            if matching_admissions != 1 {
                anyhow::bail!(
                    "solver lease `{}` has {matching_admissions} matching immutable task admissions",
                    lease.lease_token
                );
            }
        }
        for admission in &admissions {
            let matching_leases = leases
                .iter()
                .filter(|lease| admission_matches_lease(admission, lease))
                .count();
            if matching_leases != 1 {
                anyhow::bail!(
                    "task admission has {matching_leases} matching durable solver leases"
                );
            }
        }

        let worker_exits = self.list_worker_process_exit_receipts(run_id)?;
        for exit in &worker_exits {
            exit.validate()?;
            require_catalog_task(&exit.task_id, "worker exit")?;
            let matching = leases
                .iter()
                .find(|lease| {
                    lease.run_id == exit.run_id
                        && lease.task_id == exit.task_id
                        && lease.attempt_id == exit.attempt_id
                        && lease.ownership_epoch == exit.ownership_epoch
                        && lease.resource_id == exit.resource_id
                        && lease.lease_token == exit.lease_token
                        && lease.heartbeat_sequence == exit.lease_heartbeat_sequence
                })
                .context("worker exit receipt has no matching solver lease")?;
            if !admissions.iter().any(|admission| {
                admission_matches_lease(admission, matching)
            }) {
                anyhow::bail!("worker exit receipt has no matching task admission");
            }
            let matches = worker_exits
                .iter()
                .filter(|other| {
                    other.run_id == matching.run_id
                        && other.task_id == matching.task_id
                        && other.attempt_id == matching.attempt_id
                        && other.ownership_epoch == matching.ownership_epoch
                        && other.resource_id == matching.resource_id
                        && other.lease_token == matching.lease_token
                        && other.lease_heartbeat_sequence == matching.heartbeat_sequence
                })
                .count();
            if matches > 1 {
                anyhow::bail!("solver lease has duplicate process-exit receipts");
            }
        }
        let mut worker_evidence = Vec::new();
        let mut solver_evidence_keys = HashSet::new();
        for lease in &leases {
            let exits = worker_exits
                .iter()
                .filter(|exit| {
                    exit.run_id == lease.run_id
                        && exit.task_id == lease.task_id
                        && exit.attempt_id == lease.attempt_id
                        && exit.ownership_epoch == lease.ownership_epoch
                        && exit.resource_id == lease.resource_id
                        && exit.lease_token == lease.lease_token
                        && exit.lease_heartbeat_sequence == lease.heartbeat_sequence
                })
                .collect::<Vec<_>>();
            if exits.len() > 1 {
                anyhow::bail!("solver lease has duplicate process-exit receipts");
            }
            let exit = exits.first().copied();
            let host_kind = worker_proof(lease, exit)?;
            if exit.is_none() && host_kind.is_none() {
                anyhow::bail!(
                    "released solver lease has neither process-exit nor canonical no-spawn proof"
                );
            }
            solver_evidence_keys.insert((
                lease.task_id.clone(),
                lease.attempt_id.clone(),
                lease.ownership_epoch,
                lease.resource_id.clone(),
                lease.lease_token.clone(),
                lease.heartbeat_sequence,
            ));
            worker_evidence.push(serde_json::json!({
                "lease": lease,
                "exit": exit,
                "host_proof": host_kind,
            }));
        }

        let preparation_leases = self.list_preparation_resource_leases_for_run_locked(run_id)?;
        if preparation_leases
            .iter()
            .any(|lease| lease.state == FmsResourceLeaseState::Active)
        {
            anyhow::bail!("terminal evidence has an active preparation lease");
        }
        for lease in &preparation_leases {
            require_catalog_task(&lease.task_id, "preparation lease")?;
        }
        let launches = self.list_preparation_process_launches(run_id)?;
        let preparation_exits = self.list_preparation_process_exit_receipts(run_id)?;
        for launch in &launches {
            launch.validate()?;
            require_catalog_task(&launch.task_id, "preparation launch")?;
            let lease = preparation_leases
                .iter()
                .find(|lease| {
                    lease.run_id == launch.run_id
                        && lease.task_id == launch.task_id
                        && lease.preparation_attempt_id == launch.preparation_attempt_id
                        && lease.resource_id == launch.resource_id
                        && lease.lease_token == launch.lease_token
                        && lease.heartbeat_sequence >= launch.lease_heartbeat_sequence
                })
                .context("preparation launch has no matching durable preparation lease")?;
            let matches = preparation_exits
                .iter()
                .filter(|exit| {
                    exit.run_id == lease.run_id
                        && exit.task_id == lease.task_id
                        && exit.preparation_attempt_id == lease.preparation_attempt_id
                        && exit.resource_id == lease.resource_id
                        && exit.lease_token == lease.lease_token
                        && exit.lease_heartbeat_sequence == lease.heartbeat_sequence
                })
                .count();
            if matches != 1 {
                anyhow::bail!(
                    "preparation launch `{}` has no unique durable exit receipt",
                    launch.launch_id
                );
            }
        }
        for exit in &preparation_exits {
            exit.validate()?;
            require_catalog_task(&exit.task_id, "preparation exit")?;
            if !launches.iter().any(|launch| {
                launch.run_id == exit.run_id
                    && launch.task_id == exit.task_id
                    && launch.preparation_attempt_id == exit.preparation_attempt_id
                    && launch.resource_id == exit.resource_id
                    && launch.lease_token == exit.lease_token
                    && launch.lease_heartbeat_sequence <= exit.lease_heartbeat_sequence
            }) {
                anyhow::bail!("preparation exit receipt has no matching launch");
            }
        }
        let mut preparation_evidence = Vec::new();
        let mut preparation_evidence_keys = HashSet::new();
        for lease in &preparation_leases {
            let launches_for_lease = launches
                .iter()
                .filter(|launch| {
                    launch.run_id == lease.run_id
                        && launch.task_id == lease.task_id
                        && launch.preparation_attempt_id == lease.preparation_attempt_id
                        && launch.resource_id == lease.resource_id
                        && launch.lease_token == lease.lease_token
                        && launch.lease_heartbeat_sequence <= lease.heartbeat_sequence
                })
                .collect::<Vec<_>>();
            if launches_for_lease.len() > 1 {
                anyhow::bail!("preparation lease has duplicate launch authorizations");
            }
            let exits_for_lease = preparation_exits
                .iter()
                .filter(|exit| {
                    exit.run_id == lease.run_id
                        && exit.task_id == lease.task_id
                        && exit.preparation_attempt_id == lease.preparation_attempt_id
                        && exit.resource_id == lease.resource_id
                        && exit.lease_token == lease.lease_token
                        && exit.lease_heartbeat_sequence == lease.heartbeat_sequence
                })
                .collect::<Vec<_>>();
            if exits_for_lease.len() > 1 {
                anyhow::bail!("preparation lease has duplicate process-exit receipts");
            }
            if launches_for_lease.len() == 1 && exits_for_lease.len() != 1 {
                anyhow::bail!("preparation launch lacks its process-exit receipt");
            }
            if launches_for_lease.is_empty() && !exits_for_lease.is_empty() {
                anyhow::bail!("preparation exit receipt lacks its launch authorization");
            }
            let exit = exits_for_lease.first().copied();
            let host_kind = preparation_proof(lease, exit)?;
            if exit.is_none() && host_kind.is_none() {
                anyhow::bail!(
                    "released preparation lease has neither process-exit nor canonical no-spawn proof"
                );
            }
            preparation_evidence_keys.insert((
                lease.task_id.clone(),
                lease.preparation_attempt_id.clone(),
                lease.resource_id.clone(),
                lease.lease_token.clone(),
                lease.heartbeat_sequence,
            ));
            preparation_evidence.push(serde_json::json!({
                "lease": lease,
                "launch": launches_for_lease.first().copied(),
                "exit": exit,
                "host_proof": host_kind,
            }));
        }

        // Immutable intent, preparation, artifact, and retry records are part
        // of the digest, while admissions/leases/exits above provide the
        // terminal execution fence for every historical attempt.
        let retry_decisions = self.list_retry_decisions(run_id)?;
        let preparation_retry_decisions = self.list_preparation_retry_decisions(run_id)?;
        let mut retry_attempt_keys = HashSet::new();
        for decision in &retry_decisions {
            decision.validate()?;
            if decision.run_id != run_id {
                anyhow::bail!("retry decision run identity differs from the exact terminal run");
            }
            if !retry_attempt_keys.insert((
                decision.task_id.clone(),
                decision.attempt_id.clone(),
                decision.ownership_epoch,
            )) {
                anyhow::bail!(
                    "retry decision history has multiple decisions for one task attempt"
                );
            }
            require_catalog_task(&decision.task_id, "retry decision")?;
            let matching_admissions = admissions
                .iter()
                .filter(|admission| {
                    admission.lease.run_id == decision.run_id
                        && admission.lease.task_id == decision.task_id
                        && admission.lease.attempt_id == decision.attempt_id
                        && admission.lease.ownership_epoch == decision.ownership_epoch
                })
                .collect::<Vec<_>>();
            if matching_admissions.len() != 1 {
                anyhow::bail!(
                    "retry decision `{}` has {} exact admission records",
                    decision.decision_id,
                    matching_admissions.len()
                );
            }
            let matching_leases = leases
                .iter()
                .filter(|lease| {
                    lease.run_id == decision.run_id
                        && lease.task_id == decision.task_id
                        && lease.attempt_id == decision.attempt_id
                        && lease.ownership_epoch == decision.ownership_epoch
                        && admissions.iter().any(|admission| {
                            admission_matches_lease(admission, lease)
                                && admission.lease.attempt_id == decision.attempt_id
                                && admission.lease.ownership_epoch == decision.ownership_epoch
                        })
                })
                .collect::<Vec<_>>();
            if matching_leases.len() != 1 {
                anyhow::bail!(
                    "retry decision `{}` has {} exact released lease records",
                    decision.decision_id,
                    matching_leases.len()
                );
            }
            let lease = matching_leases[0];
            if lease.state != FmsResourceLeaseState::Released {
                anyhow::bail!(
                    "retry decision `{}` references a nonreleased lease",
                    decision.decision_id
                );
            }
            let evidence_key = (
                lease.task_id.clone(),
                lease.attempt_id.clone(),
                lease.ownership_epoch,
                lease.resource_id.clone(),
                lease.lease_token.clone(),
                lease.heartbeat_sequence,
            );
            if !solver_evidence_keys.contains(&evidence_key) {
                anyhow::bail!(
                    "retry decision `{}` has no exact terminal execution evidence",
                    decision.decision_id
                );
            }
            if decision.action == FmsRetryAction::Retry {
                let matching_exits = worker_exits
                    .iter()
                    .filter(|exit| {
                        exit.run_id == lease.run_id
                            && exit.task_id == lease.task_id
                            && exit.attempt_id == lease.attempt_id
                            && exit.ownership_epoch == lease.ownership_epoch
                            && exit.resource_id == lease.resource_id
                            && exit.lease_token == lease.lease_token
                            && exit.lease_heartbeat_sequence == lease.heartbeat_sequence
                    })
                    .collect::<Vec<_>>();
                if matching_exits.len() != 1 || matching_exits[0].status_success {
                    anyhow::bail!(
                        "retry decision `{}` does not reference one failed worker exit",
                        decision.decision_id
                    );
                }
            }
        }
        let mut preparation_decisions_by_task = BTreeMap::<
            String,
            Vec<&FmsPreparationRetryDecision>,
        >::new();
        for decision in &preparation_retry_decisions {
            decision.validate()?;
            if decision.run_id != run_id {
                anyhow::bail!(
                    "preparation retry decision run identity differs from the exact terminal run"
                );
            }
            require_catalog_task(&decision.task_id, "preparation retry decision")?;
            preparation_decisions_by_task
                .entry(decision.task_id.clone())
                .or_default()
                .push(decision);
        }
        for decisions in preparation_decisions_by_task.values_mut() {
            decisions.sort_by_key(|decision| decision.retry_sequence);
            let mut decided_attempts = HashSet::new();
            let mut max_attempts = None;
            for (index, decision) in decisions.iter().enumerate() {
                if decision.retry_sequence != index as u32 + 1
                    || max_attempts.is_some_and(|value| value != decision.max_attempts)
                    || !decided_attempts.insert(decision.failed_preparation_attempt_id.clone())
                {
                    anyhow::bail!("preparation retry decision history is inconsistent");
                }
                max_attempts = Some(decision.max_attempts);
            }
        }
        for decision in &preparation_retry_decisions {
            let matching_exits = preparation_exits
                .iter()
                .filter(|exit| {
                    exit.run_id == decision.run_id
                        && exit.task_id == decision.task_id
                        && exit.preparation_attempt_id
                            == decision.failed_preparation_attempt_id
                        && !exit.status_success
                })
                .collect::<Vec<_>>();
            if matching_exits.len() != 1 {
                anyhow::bail!(
                    "preparation retry decision `{}` has no unique failed preparation exit",
                    decision.decision_id
                );
            }
            let exit = matching_exits[0];
            let matching_leases = preparation_leases
                .iter()
                .filter(|lease| {
                    lease.run_id == exit.run_id
                        && lease.task_id == exit.task_id
                        && lease.preparation_attempt_id == exit.preparation_attempt_id
                        && lease.resource_id == exit.resource_id
                        && lease.lease_token == exit.lease_token
                        && lease.heartbeat_sequence == exit.lease_heartbeat_sequence
                })
                .collect::<Vec<_>>();
            if matching_leases.len() != 1 {
                anyhow::bail!(
                    "preparation retry decision `{}` has no unique exact preparation lease",
                    decision.decision_id
                );
            }
            let lease = matching_leases[0];
            if lease.state != FmsResourceLeaseState::Released {
                anyhow::bail!(
                    "preparation retry decision `{}` references a nonreleased preparation lease",
                    decision.decision_id
                );
            }
            let matching_launches = launches
                .iter()
                .filter(|launch| {
                    launch.run_id == exit.run_id
                        && launch.task_id == exit.task_id
                        && launch.preparation_attempt_id == exit.preparation_attempt_id
                        && launch.resource_id == exit.resource_id
                        && launch.lease_token == exit.lease_token
                        && launch.lease_heartbeat_sequence <= exit.lease_heartbeat_sequence
                })
                .collect::<Vec<_>>();
            if matching_launches.len() != 1 {
                anyhow::bail!(
                    "preparation retry decision `{}` has no unique exact preparation launch",
                    decision.decision_id
                );
            }
            let evidence_key = (
                lease.task_id.clone(),
                lease.preparation_attempt_id.clone(),
                lease.resource_id.clone(),
                lease.lease_token.clone(),
                lease.heartbeat_sequence,
            );
            if !preparation_evidence_keys.contains(&evidence_key) {
                anyhow::bail!(
                    "preparation retry decision `{}` has no exact terminal execution evidence",
                    decision.decision_id
                );
            }
        }
        let run_intent = self
            .read_run_intent(run_id)?
            .context("terminal evidence requires a durable RunIntent")?;

        let cancellation_intents = self.list_task_cancellation_intents(run_id)?;
        for intent in &cancellation_intents {
            let current = catalog
                .tasks
                .iter()
                .find(|task| task.task_id == intent.task.task_id)
                .with_context(|| {
                    format!(
                        "task cancellation intent references task `{}` absent from the current run catalog",
                        intent.task.task_id
                    )
                })?;
            intent.validate_task_scope(self, current, catalog.revision)?;
        }
        let cancellation_references = cancellation_intents
            .iter()
            .map(|intent| {
                Ok(serde_json::json!({
                    "task_id": intent.task.task_id,
                    "cancellation_id": intent.cancellation_id,
                    "request_sha256": intent.request_sha256,
                    "intent_sha256": canonical_json_sha256(&serde_json::to_value(intent)?),
                }))
            })
            .collect::<Result<Vec<_>>>()?;

        let task_preparation_receipts = self.list_task_preparation_receipts_for_run_locked(run_id)?;
        let task_preparation_references = task_preparation_receipts
            .iter()
            .map(|receipt| {
                require_catalog_task(&receipt.task_id, "task preparation receipt")?;
                Ok(serde_json::json!({
                    "task_id": receipt.task_id,
                    "receipt_sha256": canonical_json_sha256(&serde_json::to_value(receipt)?),
                }))
            })
            .collect::<Result<Vec<_>>>()?;

        let accepted_stage_receipts = self
            .list_accepted_stage_preparation_receipts_for_run_locked(run_id)?;
        let accepted_stage_references = accepted_stage_receipts
            .iter()
            .map(|receipt| {
                require_catalog_task(&receipt.task_id, "accepted stage preparation receipt")?;
                Ok(serde_json::json!({
                    "task_id": receipt.task_id,
                    "step_id": receipt.step_id,
                    "preparation_id": receipt.preparation_id,
                    "receipt_sha256": canonical_json_sha256(&serde_json::to_value(receipt)?),
                }))
            })
            .collect::<Result<Vec<_>>>()?;

        let preparation_receipt = self.read_preparation_receipt(run_id)?;
        let preparation_receipt_reference = preparation_receipt
            .as_ref()
            .map(|receipt| -> Result<serde_json::Value> {
                Ok(serde_json::json!({
                    "preparation_id": receipt.preparation_id,
                    "receipt_sha256": canonical_json_sha256(&serde_json::to_value(receipt)?),
                }))
            })
            .transpose()?;

        let artifact_catalog = self.read_artifact_catalog(run_id)?;
        let artifact_catalog_reference = artifact_catalog
            .as_ref()
            .map(|catalog| -> Result<serde_json::Value> {
                let entries = catalog
                    .entries
                    .iter()
                    .map(|entry| {
                        serde_json::json!({
                            "artifact_id": entry.artifact_id,
                            "task_id": entry.task_id,
                            "attempt_id": entry.attempt_id,
                            "ownership_epoch": entry.ownership_epoch,
                            "logical_path": entry.logical_path,
                            "artifact_type": entry.artifact_type,
                            "content_sha256": entry.content_sha256,
                            "object_ref": entry.object_ref,
                            "status": entry.status,
                            "required": entry.required,
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(serde_json::json!({
                    "revision": catalog.revision,
                    "catalog_sha256": canonical_json_sha256(&serde_json::to_value(catalog)?),
                    "entries": entries,
                }))
            })
            .transpose()?;
        if let Some(catalog) = &artifact_catalog {
            for entry in &catalog.entries {
                require_catalog_task(&entry.task_id, "artifact catalog")?;
                if !admissions.iter().any(|admission| {
                    admission.lease.run_id == run_id
                        && admission.lease.task_id == entry.task_id
                        && admission.lease.attempt_id == entry.attempt_id
                        && admission.lease.ownership_epoch == entry.ownership_epoch
                }) {
                    anyhow::bail!(
                        "artifact `{}` has no matching immutable task admission",
                        entry.artifact_id
                    );
                }
            }
        }
        for task in &catalog.tasks {
            for artifact_id in &task.artifact_ids {
                let present = artifact_catalog.as_ref().is_some_and(|catalog| {
                    catalog
                        .entries
                        .iter()
                        .any(|entry| entry.artifact_id == *artifact_id)
                });
                if !present {
                    anyhow::bail!(
                        "catalog task `{}` references missing artifact `{artifact_id}`",
                        task.task_id
                    );
                }
            }
        }

        let provider_submissions = self.list_provider_job_submissions_unlocked(run_id)?;
        let provider_references = provider_submissions
            .iter()
            .map(|submission| {
                submission.validate()?;
                require_catalog_task(&submission.task_id, "provider submission")?;
                let matching_lease = leases
                    .iter()
                    .find(|lease| {
                        lease.run_id == submission.run_id
                            && lease.task_id == submission.task_id
                            && lease.attempt_id == submission.attempt_id
                            && lease.ownership_epoch == submission.ownership_epoch
                            && lease.resource_id == submission.resource_id
                    })
                    .context("provider submission has no matching durable solver lease")?;
                if !admissions.iter().any(|admission| {
                    admission_matches_lease(admission, matching_lease)
                }) {
                    anyhow::bail!(
                        "provider submission has no matching immutable task admission"
                    );
                }
                if !submission.status.is_terminal() {
                    anyhow::bail!(
                        "terminal evidence has a nonterminal provider submission for task `{}`",
                        submission.task_id
                    );
                }
                Ok(serde_json::json!({
                    "task_id": submission.task_id,
                    "attempt_id": submission.attempt_id,
                    "ownership_epoch": submission.ownership_epoch,
                    "provider_id": submission.provider_id,
                    "target_id": submission.target_id,
                    "scheduler_id": submission.scheduler_id,
                    "resource_id": submission.resource_id,
                    "idempotency_key": submission.idempotency_key,
                    "request_digest": submission.request_digest,
                    "status": submission.status,
                    "provider_job_id": submission.provider_job_id,
                    "revision": submission.revision,
                    "submission_sha256": canonical_json_sha256(
                        &serde_json::to_value(submission)?,
                    ),
                }))
            })
            .collect::<Result<Vec<_>>>()?;

        let coordinator_entries = self.read_coordinator_journal_unlocked(run_id)?;
        let coordinator_references = coordinator_entries
            .iter()
            .map(|entry| {
                require_catalog_task(&entry.task_id, "coordinator journal")?;
                if !admissions.iter().any(|admission| {
                    admission.lease.run_id == entry.run_id
                        && admission.lease.task_id == entry.task_id
                        && admission.lease.attempt_id == entry.attempt_id
                        && admission.lease.ownership_epoch == entry.ownership_epoch
                        && admission.lease.lease_token == entry.lease_token
                }) {
                    anyhow::bail!(
                        "coordinator journal entry `{}` has no matching immutable task admission",
                        entry.entry_id
                    );
                }
                Ok(serde_json::json!({
                    "entry_id": entry.entry_id,
                    "task_id": entry.task_id,
                    "attempt_id": entry.attempt_id,
                    "ownership_epoch": entry.ownership_epoch,
                    "lease_token": entry.lease_token,
                    "direction": entry.direction,
                    "sequence": entry.sequence,
                    "terminal": entry.terminal,
                    "payload_sha256": entry.payload_sha256,
                    "entry_sha256": canonical_json_sha256(&serde_json::to_value(entry)?),
                }))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(serde_json::json!({
            "catalog": catalog,
            "run_intent": run_intent,
            "admissions": admissions,
            "leases": leases,
            "worker_evidence": worker_evidence,
            "preparation_leases": preparation_leases,
            "preparation_launches": launches,
            "preparation_exits": preparation_exits,
            "preparation_evidence": preparation_evidence,
            "retry_decisions": retry_decisions,
            "preparation_retry_decisions": preparation_retry_decisions,
            "preparation_receipt": preparation_receipt_reference,
            "task_preparation_receipts": task_preparation_references,
            "accepted_stage_preparation_receipts": accepted_stage_references,
            "task_cancellation_intents": cancellation_references,
            "artifact_catalog": artifact_catalog_reference,
            "provider_submissions": provider_references,
            "coordinator_journal": coordinator_references,
        }))
    }

    /// Replay only the requested durable task admission record under the store writer lease.
    pub fn reconcile_task_admission(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<Option<TaskAdmissionCommitDisposition>> {
        let _writer_lease = self.write_transaction()?;
        let Some(record) = self.read_task_admission(run_id, task_id, attempt_id)? else {
            return Ok(None);
        };
        self.apply_task_admission_record_unlocked(&record).map(Some)
    }

    /// Replay admission intents before scheduling after a process restart.
    /// Superseded records remain immutable history and never reclaim a lease.
    pub fn reconcile_task_admissions(
        &self,
        run_id: &str,
    ) -> Result<Vec<TaskAdmissionCommitDisposition>> {
        validate_store_id(run_id)?;
        let _writer_lease = self.write_transaction()?;
        let root = checked_path(&self.root, &format!("runs/{run_id}/task_admissions"))?;
        if !root.exists() {
            return Ok(Vec::new());
        }
        reject_link(&root)?;
        let mut records = Vec::new();
        for task_dir in fs::read_dir(&root)? {
            let task_dir = task_dir?;
            reject_link(&task_dir.path())?;
            if !task_dir.file_type()?.is_dir() {
                anyhow::bail!("task admission entry is not a directory");
            }
            let task_id = task_dir
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 task admission identity"))?;
            validate_store_id(&task_id)?;
            for entry in fs::read_dir(task_dir.path())? {
                let entry = entry?;
                let entry_path = entry.path();
                reject_link(&entry_path)?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("task admission record is not a regular file");
                }
                let path_attempt_id = entry_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .context("task admission record has no UTF-8 attempt name")?;
                validate_store_id(path_attempt_id)?;
                if entry_path.extension().and_then(|value| value.to_str()) != Some("json") {
                    anyhow::bail!("task admission record must use the .json extension");
                }
                let record: FmsTaskAdmissionRecord =
                    serde_json::from_slice(&fs::read(&entry_path)?).with_context(|| {
                        format!("parsing task admission {}", entry_path.display())
                    })?;
                record.validate()?;
                if record.lease.run_id != run_id
                    || record.task.task_id != task_id
                    || record.lease.attempt_id != path_attempt_id
                {
                    anyhow::bail!("task admission identity does not match its path");
                }
                records.push(record);
            }
        }
        records.sort_by(|left, right| {
            (
                left.lease.ownership_epoch,
                &left.task.task_id,
                &left.lease.attempt_id,
            )
                .cmp(&(
                    right.lease.ownership_epoch,
                    &right.task.task_id,
                    &right.lease.attempt_id,
                ))
        });
        records
            .iter()
            .map(|record| self.apply_task_admission_record_unlocked(record))
            .collect()
    }

    fn apply_task_admission_record_unlocked(
        &self,
        record: &FmsTaskAdmissionRecord,
    ) -> Result<TaskAdmissionCommitDisposition> {
        record.validate()?;
        let mut catalog = self
            .read_run_catalog(&record.lease.run_id)?
            .context("task admission run catalog is missing")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == record.task.task_id)
            .context("task admission target is missing from the run catalog")?;
        let current = &catalog.tasks[task_index];
        let current_epoch = current.ownership_epoch.unwrap_or(0);
        if current_epoch > record.lease.ownership_epoch {
            return Ok(TaskAdmissionCommitDisposition::Superseded);
        }
        let current_claim_matches = current.attempt_id.as_deref()
            == Some(record.lease.attempt_id.as_str())
            && current.ownership_epoch == Some(record.lease.ownership_epoch)
            && current.resource_id.as_deref() == Some(record.lease.resource_id.as_str());

        if current_claim_matches {
            if matches!(
                current.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            ) {
                return Ok(TaskAdmissionCommitDisposition::Replayed);
            }
            if !matches!(
                current.lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            ) || current.readiness != FmsTaskReadiness::Ready
                || catalog.revision <= record.expected_catalog_revision
            {
                anyhow::bail!("durable task admission projection is inconsistent");
            }
            self.ensure_admission_lease_unlocked(record)?;
            return Ok(TaskAdmissionCommitDisposition::Replayed);
        }

        if current.attempt_id.is_some() {
            anyhow::bail!("task admission conflicts with another current attempt");
        }
        if catalog.revision < record.expected_catalog_revision || current != &record.queued_task {
            anyhow::bail!("task admission source changed before replay");
        }
        if self
            .find_active_resource_lease_unlocked(&record.lease.resource_id)?
            .is_some()
        {
            anyhow::bail!("task admission resource is held by another active lease");
        }

        catalog.tasks[task_index] = record.task.clone();
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted during task admission")?;
        catalog.updated_at = chrono::Utc::now();
        catalog.validate()?;
        self.commit_run_catalog_unlocked(&catalog)?;
        self.ensure_admission_lease_unlocked(record)?;
        Ok(TaskAdmissionCommitDisposition::Admitted)
    }

    fn ensure_admission_lease_unlocked(&self, record: &FmsTaskAdmissionRecord) -> Result<()> {
        let lease_path = self.resource_lease_path(&record.lease)?;
        if lease_path.exists() {
            let existing = self
                .read_resource_lease(
                    &record.lease.run_id,
                    &record.lease.resource_id,
                    &record.lease.lease_token,
                )?
                .context("task admission lease disappeared while being read")?;
            if existing != record.lease || existing.state != FmsResourceLeaseState::Active {
                anyhow::bail!("task admission cannot reactivate a conflicting lease record");
            }
            return Ok(());
        }
        self.commit_resource_lease(&record.lease)?;
        Ok(())
    }

    /// Atomically acquire one durable lease for a physical resource.
    ///
    /// The writer lock serializes coordinators on this store.  An active lease
    /// is never reclaimed from heartbeat age alone; only an explicit release
    /// can make the resource available again.
    pub fn commit_resource_lease(
        &self,
        lease: &FmsResourceLease,
    ) -> Result<ResourceLeaseCommitDisposition> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease acquisition requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        self.ensure_development_admission_open_unlocked()?;
        self.validate_resource_lease_owner_unlocked(lease, false)?;
        if self
            .find_active_preparation_resource_lease_unlocked(&lease.resource_id)?
            .is_some()
        {
            anyhow::bail!(
                "resource `{}` already has an active durable preparation lease",
                lease.resource_id
            );
        }
        if let Some(existing) = self.find_active_resource_lease_unlocked(&lease.resource_id)? {
            if existing.identity_matches(lease)
                && existing.kind == lease.kind
                && existing.budget == lease.budget
            {
                return Ok(ResourceLeaseCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "resource `{}` already has an active durable lease",
                lease.resource_id
            );
        }
        let path = self.resource_lease_path(lease)?;
        if path.exists() {
            anyhow::bail!(
                "resource lease token path already exists for `{}`",
                lease.lease_token
            );
        }
        let json = serde_json::to_vec_pretty(lease)?;
        atomic_write(
            &create_parent(
                &self.root,
                &format!(
                    "runs/{}/resource_leases/{}/{}.json",
                    lease.run_id, lease.resource_id, lease.lease_token
                ),
            )?,
            &json,
        )?;
        Ok(ResourceLeaseCommitDisposition::Acquired)
    }

    /// Atomically acquire one meshing resource while the accepted task remains
    /// blocked before solver admission.
    pub fn commit_preparation_resource_lease(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<PreparationResourceLeaseCommitDisposition> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease acquisition requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        self.commit_preparation_resource_lease_unlocked(lease)
    }

    /// Acquire a preparation lease only from the exact durable pool
    /// generation and offer observed by the admission loop.
    pub fn commit_preparation_resource_lease_from_pool(
        &self,
        pool_id: &str,
        pool_generation: u64,
        lease: &FmsPreparationResourceLease,
    ) -> Result<PreparationResourceLeaseCommitDisposition> {
        validate_store_id(pool_id)?;
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease acquisition requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        let pool = self
            .read_preparation_resource_pool(pool_id)?
            .context("preparation admission requires a durable resource pool")?;
        if pool.generation != pool_generation {
            anyhow::bail!("preparation resource pool generation changed before admission");
        }
        let offer = pool
            .resources
            .iter()
            .find(|offer| offer.resource_id == lease.resource_id)
            .context("preparation resource is absent from the selected pool generation")?;
        if offer.budget != lease.budget {
            anyhow::bail!("preparation lease budget differs from the durable pool offer");
        }
        self.commit_preparation_resource_lease_unlocked(lease)
    }

    /// Try to acquire one exact pool offer without turning ordinary scheduler
    /// races into store corruption errors. `None` means that either the task or
    /// the physical resource is no longer available. Pool generation and
    /// payload mismatches remain hard errors.
    pub fn try_commit_preparation_resource_lease_from_pool(
        &self,
        pool_id: &str,
        pool_generation: u64,
        expected_authorization_sequence: u32,
        lease: &FmsPreparationResourceLease,
    ) -> Result<Option<PreparationResourceLeaseCommitDisposition>> {
        validate_store_id(pool_id)?;
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease acquisition requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        let pool = self
            .read_preparation_resource_pool(pool_id)?
            .context("preparation admission requires a durable resource pool")?;
        if pool.generation != pool_generation {
            anyhow::bail!("preparation resource pool generation changed before admission");
        }
        let offer = pool
            .resources
            .iter()
            .find(|offer| offer.resource_id == lease.resource_id)
            .context("preparation resource is absent from the selected pool generation")?;
        if offer.budget != lease.budget {
            anyhow::bail!("preparation lease budget differs from the durable pool offer");
        }

        let catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("preparation resource lease requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == lease.task_id);
        let task_available = task.is_some_and(|task| {
            task.lifecycle == FmsTaskLifecycle::Accepted
                && matches!(
                    &task.readiness,
                    FmsTaskReadiness::Blocked { reason }
                        if reason == FMS_TASK_AWAITING_PREPARATION_REASON
                )
                && task.attempt_id.is_none()
                && task.ownership_epoch.is_none()
                && task.resource_id.is_none()
        });
        let authorization_sequence = self
            .preparation_attempt_authorization_sequence_unlocked(&lease.run_id, &lease.task_id)?;
        if !task_available
            || self
                .read_task_preparation_receipt(&lease.run_id, &lease.task_id)?
                .is_some()
            || authorization_sequence != Some(expected_authorization_sequence)
        {
            return Ok(None);
        }

        if let Some(existing) = self.find_active_preparation_resource_lease_for_task_unlocked(
            &lease.run_id,
            &lease.task_id,
        )? {
            if existing.identity_matches(lease) && existing.budget == lease.budget {
                return Ok(Some(PreparationResourceLeaseCommitDisposition::Replayed));
            }
            return Ok(None);
        }
        if self
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            return Ok(None);
        }
        if self
            .find_active_resource_lease_unlocked(&lease.resource_id)?
            .is_some()
            || self
                .find_active_preparation_resource_lease_unlocked(&lease.resource_id)?
                .is_some()
        {
            return Ok(None);
        }
        self.commit_preparation_resource_lease_unlocked(lease)
            .map(Some)
    }

    fn commit_preparation_resource_lease_unlocked(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<PreparationResourceLeaseCommitDisposition> {
        self.ensure_development_admission_open_unlocked()?;
        self.validate_preparation_resource_lease_owner_unlocked(lease)?;
        if let Some(existing) = self.find_active_preparation_resource_lease_for_task_unlocked(
            &lease.run_id,
            &lease.task_id,
        )? {
            if existing.identity_matches(lease) && existing.budget == lease.budget {
                return Ok(PreparationResourceLeaseCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "task `{}` already has an active durable preparation lease",
                lease.task_id
            );
        }
        if self
            .preparation_attempt_authorization_sequence_unlocked(&lease.run_id, &lease.task_id)?
            .is_none()
        {
            anyhow::bail!("preparation attempt requires an explicit retry decision");
        }
        if self
            .find_active_resource_lease_unlocked(&lease.resource_id)?
            .is_some()
        {
            anyhow::bail!(
                "resource `{}` already has an active durable solver lease",
                lease.resource_id
            );
        }
        if let Some(existing) =
            self.find_active_preparation_resource_lease_unlocked(&lease.resource_id)?
        {
            if existing.identity_matches(lease) && existing.budget == lease.budget {
                return Ok(PreparationResourceLeaseCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "resource `{}` already has an active durable preparation lease",
                lease.resource_id
            );
        }
        if self
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            anyhow::bail!("task cancellation intent blocks new preparation admission");
        }
        let relative = lease.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            anyhow::bail!(
                "preparation resource lease token path already exists for `{}`",
                lease.lease_token
            );
        }
        atomic_write(
            &create_parent(&self.root, &relative)?,
            &serde_json::to_vec_pretty(lease)?,
        )?;
        Ok(PreparationResourceLeaseCommitDisposition::Acquired)
    }

    pub fn read_preparation_resource_lease(
        &self,
        run_id: &str,
        resource_id: &str,
        lease_token: &str,
    ) -> Result<Option<FmsPreparationResourceLease>> {
        for value in [run_id, resource_id, lease_token] {
            validate_store_id(value)?;
        }
        let relative =
            format!("runs/{run_id}/preparation_resource_leases/{resource_id}/{lease_token}.json");
        let read = || {
            read_optional_bounded_regular_file(
                &self.root,
                &relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
                "preparation resource lease",
            )
        };
        let data = match read() {
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                // Publication can race the metadata/open sequence on a bind
                // mount. Retry the complete bounded read under the existing
                // reentrant writer; never manufacture a missing lease.
                let _transaction = self.write_transaction()?;
                read()?
            }
            result => result?,
        };
        let Some(data) = data else {
            return Ok(None);
        };
        let lease: FmsPreparationResourceLease = serde_json::from_slice(&data)
            .with_context(|| format!("parsing preparation resource lease {relative}"))?;
        if lease.relative_path()? != relative {
            anyhow::bail!("preparation resource lease identity does not match its path");
        }
        Ok(Some(lease))
    }

    pub fn list_active_preparation_resource_leases(
        &self,
    ) -> Result<Vec<FmsPreparationResourceLease>> {
        let runs = checked_path(&self.root, "runs")?;
        match fs::symlink_metadata(&runs) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => anyhow::bail!("runs path is not a directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).context("reading runs directory metadata"),
        }
        reject_link(&runs)?;
        let mut active = Vec::new();
        for run_entry in fs::read_dir(&runs)? {
            let run_entry = run_entry?;
            reject_link(&run_entry.path())?;
            if !run_entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported runs entry `{}`", run_entry.path().display());
            }
            let run_id = run_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 run identifier"))?;
            validate_store_id(&run_id)?;
            let root = run_entry.path().join("preparation_resource_leases");
            let metadata = match fs::symlink_metadata(&root) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(error).context("reading preparation lease directory metadata");
                }
            };
            reject_link(&root)?;
            if !metadata.is_dir() {
                anyhow::bail!("preparation_resource_leases path is not a directory");
            }
            for resource_entry in fs::read_dir(&root)? {
                let resource_entry = resource_entry?;
                reject_link(&resource_entry.path())?;
                if !resource_entry.file_type()?.is_dir() {
                    anyhow::bail!("preparation resource lease resource entry is not a directory");
                }
                let resource_id = resource_entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("non-UTF8 preparation resource identifier"))?;
                validate_store_id(&resource_id)?;
                for lease_entry in fs::read_dir(resource_entry.path())? {
                    let lease_entry = lease_entry?;
                    reject_link(&lease_entry.path())?;
                    if !lease_entry.file_type()?.is_file() {
                        anyhow::bail!("preparation resource lease entry is not a file");
                    }
                    let file_name = lease_entry
                        .file_name()
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("non-UTF8 preparation lease file name"))?;
                    let lease_token = file_name
                        .strip_suffix(".json")
                        .context("preparation resource lease file name must end in .json")?;
                    validate_store_id(lease_token)?;
                    let lease: FmsPreparationResourceLease =
                        serde_json::from_slice(&fs::read(lease_entry.path())?)?;
                    lease.validate()?;
                    if lease.run_id != run_id
                        || lease.resource_id != resource_id
                        || lease.lease_token != lease_token
                    {
                        anyhow::bail!("preparation resource lease path identity mismatch");
                    }
                    if lease.state == FmsResourceLeaseState::Active {
                        active.push(lease);
                    }
                }
            }
        }
        active.sort_by(|left, right| {
            (
                &left.run_id,
                &left.task_id,
                &left.resource_id,
                &left.lease_token,
            )
                .cmp(&(
                    &right.run_id,
                    &right.task_id,
                    &right.resource_id,
                    &right.lease_token,
                ))
        });
        Ok(active)
    }

    pub fn heartbeat_preparation_resource_lease(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease heartbeat requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        self.validate_preparation_resource_lease_catalog_owner_unlocked(lease)?;
        let relative = lease.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        let current: FmsPreparationResourceLease = serde_json::from_slice(&fs::read(&path)?)?;
        current.validate()?;
        if !current.identity_matches(lease) || current.budget != lease.budget {
            anyhow::bail!("preparation resource lease heartbeat ownership fence rejected");
        }
        if current.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease is already released");
        }
        if lease.heartbeat_sequence == current.heartbeat_sequence {
            if lease == &current {
                return Ok(());
            }
            anyhow::bail!("preparation resource lease heartbeat conflicts with durable payload");
        }
        if lease.heartbeat_sequence != current.heartbeat_sequence.saturating_add(1) {
            anyhow::bail!("preparation resource lease heartbeat sequence must advance by one");
        }
        atomic_write(&path, &serde_json::to_vec_pretty(lease)?)?;
        Ok(())
    }

    pub fn release_preparation_resource_lease(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease release requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        self.release_preparation_resource_lease_unlocked(lease)
    }

    /// Caller must hold the store writer transaction.
    pub(crate) fn release_preparation_resource_lease_unlocked(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("preparation resource lease release requires active state");
        }

        let relative = lease.relative_path()?;
        let path = checked_path(&self.root, &relative)?;
        let mut current: FmsPreparationResourceLease = serde_json::from_slice(&fs::read(&path)?)?;
        current.validate()?;
        if !current.identity_matches(lease) || current.budget != lease.budget {
            anyhow::bail!("preparation resource lease release ownership fence rejected");
        }
        if current.state == FmsResourceLeaseState::Released {
            return Ok(());
        }
        if current.heartbeat_sequence != lease.heartbeat_sequence {
            anyhow::bail!("stale preparation resource lease cannot release a newer heartbeat");
        }
        if self
            .list_preparation_process_exit_receipts(&lease.run_id)?
            .iter()
            .any(|receipt| {
                receipt.task_id == lease.task_id
                    && receipt.preparation_attempt_id == lease.preparation_attempt_id
                    && receipt.resource_id == lease.resource_id
                    && receipt.lease_token == lease.lease_token
            })
        {
            anyhow::bail!("preparation lease with a durable process exit must use finalization");
        }
        current.state = FmsResourceLeaseState::Released;
        current.released_at = Some(chrono::Utc::now());
        current.validate()?;
        atomic_write(&path, &serde_json::to_vec_pretty(&current)?)?;
        Ok(())
    }

    /// Scan durable files independently of the catalog projection. Caller must
    /// hold the store writer; contradictory orphan leases still count as active.
    pub(crate) fn has_active_solver_lease_for_task_unlocked(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<bool> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let root = checked_path(&self.root, &format!("runs/{run_id}/resource_leases"))?;
        let metadata = match fs::symlink_metadata(&root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error).context("reading solver lease directory metadata"),
        };
        reject_link(&root)?;
        if !metadata.is_dir() {
            anyhow::bail!("solver resource_leases path is not a directory");
        }
        let mut active = false;
        for resource in fs::read_dir(&root)? {
            let resource = resource?;
            reject_link(&resource.path())?;
            if !resource.file_type()?.is_dir() {
                anyhow::bail!("solver lease resource entry is not a directory");
            }
            let resource_id = resource
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 solver lease resource identifier"))?;
            validate_store_id(&resource_id)?;
            for entry in fs::read_dir(resource.path())? {
                let entry = entry?;
                reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("solver lease entry is not a regular file");
                }
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("non-UTF8 solver lease filename"))?;
                let token = name
                    .strip_suffix(".json")
                    .context("solver lease filename must end in .json")?;
                validate_store_id(token)?;
                let relative = format!("runs/{run_id}/resource_leases/{resource_id}/{name}");
                let bytes = crate::repository_path::read_bounded_regular_file(
                    &self.root,
                    &relative,
                    1024 * 1024,
                )?;
                let lease: FmsResourceLease = serde_json::from_slice(&bytes)?;
                lease.validate()?;
                if lease.run_id != run_id
                    || lease.resource_id != resource_id
                    || lease.lease_token != token
                {
                    anyhow::bail!("solver lease path identity mismatch");
                }
                active |= lease.task_id == task_id && lease.state == FmsResourceLeaseState::Active;
            }
        }
        Ok(active)
    }

    /// Read the active lease for a task whose ownership is already recorded in
    /// the run catalog. The catalog binding and lease are checked while the
    /// store writer is held; absent or unclaimed tasks return `None`.
    pub fn read_active_resource_lease_for_task(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<FmsResourceLease>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let _writer_lease = self.write_transaction()?;
        let Some(catalog) = self.read_run_catalog(run_id)? else {
            return Ok(None);
        };
        let Some(task) = catalog.tasks.iter().find(|task| task.task_id == task_id) else {
            anyhow::bail!("task is missing from the durable run catalog");
        };
        if !matches!(task.readiness, FmsTaskReadiness::Ready)
            || !matches!(
                task.lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            )
        {
            return Ok(None);
        }
        let (Some(attempt_id), Some(ownership_epoch), Some(resource_id)) = (
            task.attempt_id.as_deref(),
            task.ownership_epoch,
            task.resource_id.as_deref(),
        ) else {
            return Ok(None);
        };
        let Some(lease) = self.find_active_resource_lease_unlocked(resource_id)? else {
            return Ok(None);
        };
        if lease.run_id != run_id
            || lease.task_id != task_id
            || lease.attempt_id != attempt_id
            || lease.ownership_epoch != ownership_epoch
        {
            anyhow::bail!("active resource lease does not match the durable task claim");
        }
        Ok(Some(lease))
    }

    /// Read the exact active lease retained by a durable retry decision.
    ///
    /// Unlike the ordinary task lookup, this accepts the terminal
    /// Failed/Interrupted lifecycle between decision publication and retry
    /// application. The immutable decision proves which attempt and epoch were
    /// reconciled; callers must still explicitly release the returned lease.
    pub fn read_active_resource_lease_for_retry_decision(
        &self,
        decision: &FmsRetryDecision,
    ) -> Result<Option<FmsResourceLease>> {
        decision.validate()?;
        let _writer_lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&decision.run_id)?
            .context("retry lease recovery requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == decision.task_id)
            .context("retry lease recovery task is missing from the run catalog")?;
        decision.validate_for_task(task)?;
        let Some(resource_id) = task.resource_id.as_deref() else {
            return Ok(None);
        };
        let Some(lease) = self.find_active_resource_lease_unlocked(resource_id)? else {
            return Ok(None);
        };
        if lease.run_id != decision.run_id
            || lease.task_id != decision.task_id
            || lease.attempt_id != decision.attempt_id
            || lease.ownership_epoch != decision.ownership_epoch
        {
            anyhow::bail!("active retry lease does not match the durable decision fence");
        }
        Ok(Some(lease))
    }

    /// Require the exact active resource lease for a worker publication.
    pub fn require_active_resource_lease(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        ownership_epoch: u64,
        resource_id: &str,
        lease_token: &str,
        heartbeat_sequence: u64,
    ) -> Result<FmsResourceLease> {
        let _writer_lease = self.write_transaction()?;
        let lease = self
            .read_resource_lease(run_id, resource_id, lease_token)?
            .context("active resource lease is missing")?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.task_id != task_id
            || lease.attempt_id != attempt_id
            || lease.ownership_epoch != ownership_epoch
            || lease.heartbeat_sequence != heartbeat_sequence
        {
            anyhow::bail!("active resource lease ownership fence rejected");
        }
        Ok(lease)
    }

    /// Read a lease by its durable identity.
    pub fn read_resource_lease(
        &self,
        run_id: &str,
        resource_id: &str,
        lease_token: &str,
    ) -> Result<Option<FmsResourceLease>> {
        validate_store_id(run_id)?;
        validate_store_id(resource_id)?;
        validate_store_id(lease_token)?;
        let relative = format!(
            "runs/{run_id}/resource_leases/{resource_id}/{lease_token}.json"
        );
        let path = checked_path(&self.root, &relative)?;
        let Some(data) = read_optional_bounded_regular_file(
            &self.root,
            &relative,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            "resource lease",
        )? else {
            return Ok(None);
        };
        let lease: FmsResourceLease = serde_json::from_slice(&data)
            .with_context(|| format!("parsing resource lease {}", path.display()))?;
        lease.validate()?;
        if lease.run_id != run_id
            || lease.resource_id != resource_id
            || lease.lease_token != lease_token
        {
            anyhow::bail!("resource lease identity does not match its path");
        }
        Ok(Some(lease))
    }

    /// Advance the heartbeat of the exact active lease.  Sequence numbers are
    /// monotonic and stale worker heartbeats are rejected.
    pub fn heartbeat_resource_lease(&self, lease: &FmsResourceLease) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease heartbeat requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        // A worker may publish its terminal event immediately after the final
        // HeartbeatAck. Permit that exact still-active lease to record the
        // acknowledged sequence before release; identity and monotonic fences
        // below remain unchanged.
        self.validate_resource_lease_owner_unlocked(lease, true)?;
        let path = self.resource_lease_path(lease)?;
        let data = fs::read(&path)
            .with_context(|| format!("reading resource lease {}", path.display()))?;
        let current: FmsResourceLease = serde_json::from_slice(&data)?;
        current.validate()?;
        if !current.identity_matches(lease)
            || current.kind != lease.kind
            || current.budget != lease.budget
        {
            anyhow::bail!("resource lease heartbeat ownership fence rejected");
        }
        if current.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease is already released");
        }
        if lease.heartbeat_sequence == current.heartbeat_sequence {
            if lease == &current {
                return Ok(());
            }
            anyhow::bail!("resource lease heartbeat sequence conflicts with durable payload");
        }
        if lease.heartbeat_sequence != current.heartbeat_sequence.saturating_add(1) {
            anyhow::bail!(
                "resource lease heartbeat sequence must advance by one (current {}, received {})",
                current.heartbeat_sequence,
                lease.heartbeat_sequence
            );
        }
        let json = serde_json::to_vec_pretty(lease)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Explicitly release an active lease.  A stale claim cannot release a
    /// newer heartbeat or ownership epoch.
    pub fn release_resource_lease(&self, lease: &FmsResourceLease) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease release requires the active lease identity");
        }
        let _writer_lease = self.write_transaction()?;
        self.release_resource_lease_unlocked(lease)
    }

    /// Caller must hold the store writer transaction.
    pub(crate) fn release_resource_lease_unlocked(&self, lease: &FmsResourceLease) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease release requires the active lease identity");
        }
        let path = self.resource_lease_path(lease)?;
        let data = fs::read(&path)
            .with_context(|| format!("reading resource lease {}", path.display()))?;
        let mut current: FmsResourceLease = serde_json::from_slice(&data)?;
        current.validate()?;
        if !current.identity_matches(lease)
            || current.kind != lease.kind
            || current.budget != lease.budget
        {
            anyhow::bail!("resource lease release ownership fence rejected");
        }
        if current.state == FmsResourceLeaseState::Released {
            return Ok(());
        }
        if current.heartbeat_sequence != lease.heartbeat_sequence {
            anyhow::bail!("stale resource lease cannot release a newer heartbeat");
        }
        current.state = FmsResourceLeaseState::Released;
        current.released_at = Some(chrono::Utc::now());
        current.validate()?;
        atomic_write(&path, &serde_json::to_vec_pretty(&current)?)?;
        Ok(())
    }

    fn resource_lease_path(&self, lease: &FmsResourceLease) -> Result<PathBuf> {
        Ok(checked_path(
            &self.root,
            &format!(
                "runs/{}/resource_leases/{}/{}.json",
                lease.run_id, lease.resource_id, lease.lease_token
            ),
        )?)
    }

    fn provider_job_submission_path(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<PathBuf> {
        for value in [run_id, task_id, attempt_id] {
            validate_store_id(value)?;
        }
        Ok(checked_path(
            &self.root,
            &format!(
                "runs/{run_id}/provider_job_submissions/{task_id}/{attempt_id}.json"
            ),
        )?)
    }

    fn provider_job_submissions_for_task_unlocked(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Vec<FmsProviderJobSubmission>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let root = checked_path(
            &self.root,
            &format!("runs/{run_id}/provider_job_submissions/{task_id}"),
        )?;
        reject_link(&root)?;
        if !root.exists() {
            return Ok(Vec::new());
        }
        if !fs::metadata(&root)?.is_dir() {
            anyhow::bail!("provider job task path is not a directory");
        }
        let mut submissions = Vec::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let path = entry.path();
            reject_link(&path)?;
            if !entry.file_type()?.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                anyhow::bail!("provider job submission entry must be a JSON file");
            }
            let attempt_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .context("provider job submission has no UTF-8 attempt identity")?;
            let submission = self
                .read_provider_job_submission(run_id, task_id, attempt_id)?
                .context("provider job submission disappeared during enumeration")?;
            submissions.push(submission);
        }
        submissions.sort_by(|left, right| {
            (left.ownership_epoch, &left.attempt_id)
                .cmp(&(right.ownership_epoch, &right.attempt_id))
        });
        Ok(submissions)
    }

    fn ensure_provider_jobs_terminal_for_task_unlocked(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<()> {
        for submission in self.provider_job_submissions_for_task_unlocked(run_id, task_id)? {
            if !submission.status.is_terminal() {
                anyhow::bail!(
                    "task `{task_id}` has unresolved provider job `{}` in status {:?}",
                    submission.attempt_id,
                    submission.status
                );
            }
        }
        Ok(())
    }

    fn ensure_provider_job_terminal_before_retry_unlocked(
        &self,
        run_id: &str,
        task: &FmsTaskCatalogEntry,
    ) -> Result<()> {
        let (Some(attempt_id), Some(ownership_epoch)) =
            (task.attempt_id.as_deref(), task.ownership_epoch)
        else {
            return Ok(());
        };
        let Some(submission) =
            self.read_provider_job_submission(run_id, &task.task_id, attempt_id)?
        else {
            return Ok(());
        };
        if submission.ownership_epoch != ownership_epoch {
            anyhow::bail!("provider job retry fence does not match the task catalog");
        }
        if !submission.status.is_terminal() {
            anyhow::bail!(
                "retry requires provider job reconciliation for attempt `{attempt_id}`; current status is {:?}",
                submission.status
            );
        }
        Ok(())
    }

    fn task_admission_path(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<PathBuf> {
        for value in [run_id, task_id, attempt_id] {
            validate_store_id(value)?;
        }
        Ok(checked_path(
            &self.root,
            &format!("runs/{run_id}/task_admissions/{task_id}/{attempt_id}.json"),
        )?)
    }

    fn validate_resource_lease_owner_unlocked(
        &self,
        lease: &FmsResourceLease,
        allow_terminal_reconciliation: bool,
    ) -> Result<()> {
        let catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("resource lease requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == lease.task_id)
            .context("resource lease task is missing from the run catalog")?;
        if task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
        {
            anyhow::bail!("resource lease ownership does not match the run catalog");
        }
        if !allow_terminal_reconciliation
            && matches!(
                task.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            )
        {
            anyhow::bail!("terminal task cannot acquire or renew a resource lease");
        }
        Ok(())
    }

    fn validate_preparation_resource_lease_owner_unlocked(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<()> {
        self.validate_preparation_resource_lease_catalog_owner_unlocked(lease)?;
        if self
            .read_task_preparation_receipt(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            anyhow::bail!("prepared task cannot acquire a preparation resource lease");
        }
        Ok(())
    }

    fn validate_preparation_resource_lease_catalog_owner_unlocked(
        &self,
        lease: &FmsPreparationResourceLease,
    ) -> Result<()> {
        let catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("preparation resource lease requires a durable run catalog")?;
        lease.validate_for_catalog(&catalog)?;
        Ok(())
    }

    fn find_active_resource_lease_unlocked(
        &self,
        resource_id: &str,
    ) -> Result<Option<FmsResourceLease>> {
        let runs = checked_path(&self.root, "runs")?;
        if !runs.exists() {
            return Ok(None);
        }
        let mut active = None;
        for run_entry in fs::read_dir(&runs)? {
            let run_entry = run_entry?;
            reject_link(&run_entry.path())?;
            if !run_entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported runs entry `{}`", run_entry.path().display());
            }
            let run_id = run_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 run identifier"))?;
            validate_store_id(&run_id)?;
            let resource_root = run_entry.path().join("resource_leases");
            if !resource_root.exists() {
                continue;
            }
            if !resource_root.is_dir() {
                anyhow::bail!("resource_leases path is not a directory");
            }
            let resource_dir = resource_root.join(resource_id);
            if !resource_dir.exists() {
                continue;
            }
            reject_link(&resource_dir)?;
            if !resource_dir.is_dir() {
                anyhow::bail!("resource lease identity path is not a directory");
            }
            for lease_entry in fs::read_dir(&resource_dir)? {
                let lease_entry = lease_entry?;
                reject_link(&lease_entry.path())?;
                if !lease_entry.file_type()?.is_file() {
                    anyhow::bail!("resource lease entry is not a file");
                }
                let data = fs::read(lease_entry.path())?;
                let lease: FmsResourceLease = serde_json::from_slice(&data)?;
                lease.validate()?;
                if lease.run_id != run_id || lease.resource_id != resource_id {
                    anyhow::bail!("resource lease path identity mismatch");
                }
                if lease.state == FmsResourceLeaseState::Active {
                    if active.is_some() {
                        anyhow::bail!(
                            "multiple active durable leases found for resource `{resource_id}`"
                        );
                    }
                    active = Some(lease);
                }
            }
        }
        Ok(active)
    }

    fn find_active_preparation_resource_lease_unlocked(
        &self,
        resource_id: &str,
    ) -> Result<Option<FmsPreparationResourceLease>> {
        validate_store_id(resource_id)?;
        let runs = checked_path(&self.root, "runs")?;
        if !runs.exists() {
            return Ok(None);
        }
        let mut active = None;
        for run_entry in fs::read_dir(&runs)? {
            let run_entry = run_entry?;
            reject_link(&run_entry.path())?;
            if !run_entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported runs entry `{}`", run_entry.path().display());
            }
            let run_id = run_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 run identifier"))?;
            validate_store_id(&run_id)?;
            let resource_dir = run_entry
                .path()
                .join("preparation_resource_leases")
                .join(resource_id);
            if !resource_dir.exists() {
                continue;
            }
            reject_link(&resource_dir)?;
            if !resource_dir.is_dir() {
                anyhow::bail!("preparation resource lease identity path is not a directory");
            }
            for lease_entry in fs::read_dir(&resource_dir)? {
                let lease_entry = lease_entry?;
                reject_link(&lease_entry.path())?;
                if !lease_entry.file_type()?.is_file() {
                    anyhow::bail!("preparation resource lease entry is not a file");
                }
                let file_name = lease_entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("non-UTF8 preparation lease file name"))?;
                let lease_token = file_name
                    .strip_suffix(".json")
                    .context("preparation resource lease file name must end in .json")?;
                validate_store_id(lease_token)?;
                let lease: FmsPreparationResourceLease =
                    serde_json::from_slice(&fs::read(lease_entry.path())?)?;
                lease.validate()?;
                if lease.run_id != run_id
                    || lease.resource_id != resource_id
                    || lease.lease_token != lease_token
                {
                    anyhow::bail!("preparation resource lease path identity mismatch");
                }
                if lease.state == FmsResourceLeaseState::Active {
                    if active.is_some() {
                        anyhow::bail!(
                            "multiple active durable preparation leases found for resource `{resource_id}`"
                        );
                    }
                    active = Some(lease);
                }
            }
        }
        Ok(active)
    }

    fn find_active_preparation_resource_lease_for_task_unlocked(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<FmsPreparationResourceLease>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let mut matching = self
            .list_active_preparation_resource_leases()?
            .into_iter()
            .filter(|lease| lease.run_id == run_id && lease.task_id == task_id);
        let active = matching.next();
        if matching.next().is_some() {
            anyhow::bail!("multiple active preparation leases found for task `{run_id}/{task_id}`");
        }
        Ok(active)
    }

    /// Create a run directory and persist a run manifest.
    pub fn commit_run(&self, manifest: &FmsRunManifest) -> Result<()> {
        validate_store_id(&manifest.run_id)?;
        let _lease = self.write_transaction()?;
        for reference in [
            &manifest.plan_ref,
            &manifest.live_state_ref,
            &manifest.latest_checkpoint_ref,
            &manifest.artifact_index_ref,
        ]
        .into_iter()
        .flatten()
        {
            if !reference.starts_with(&format!("runs/{}/", manifest.run_id)) {
                anyhow::bail!("run reference must belong to its run");
            }
            if !checked_path(&self.root, reference)?.is_file() {
                anyhow::bail!("run reference is missing: {reference}");
            }
        }
        if let Some(reference) = &manifest.latest_checkpoint_ref {
            let prefix = format!("runs/{}/checkpoints/", manifest.run_id);
            let id = reference
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix("/checkpoint.json"))
                .context("invalid latest checkpoint reference")?;
            self.read_checkpoint(&manifest.run_id, id)?
                .context("latest checkpoint is missing")?;
        }
        let relative = format!("runs/{}/run_manifest.json", manifest.run_id);
        let path = create_parent(&self.root, &relative)?;
        for child in ["checkpoints", "artifacts"] {
            fs::create_dir_all(checked_path(
                &self.root,
                &format!("runs/{}/{child}", manifest.run_id),
            )?)?;
        }
        let json = serde_json::to_vec_pretty(manifest)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Read a run manifest.
    pub fn read_run(&self, run_id: &str) -> Result<Option<FmsRunManifest>> {
        validate_store_id(run_id)?;
        let path = checked_path(&self.root, &format!("runs/{run_id}/run_manifest.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let manifest: FmsRunManifest = serde_json::from_slice(&data)?;
        if manifest.run_id != run_id {
            anyhow::bail!("run manifest identity does not match its path");
        }
        Ok(Some(manifest))
    }

    // ── Checkpoints ────────────────────────────────────────────────────

    /// Persist a checkpoint manifest and its common state.
    pub fn commit_checkpoint(
        &self,
        checkpoint: &FmsCheckpoint,
        common_state: &CommonSolverState,
    ) -> Result<()> {
        validate_store_id(&checkpoint.run_id)?;
        validate_store_id(&checkpoint.checkpoint_id)?;
        let prefix = format!(
            "runs/{}/checkpoints/{}",
            checkpoint.run_id, checkpoint.checkpoint_id
        );
        if checkpoint.common_state_ref != format!("{prefix}/common_state.json") {
            anyhow::bail!("checkpoint common state must be owned by the checkpoint");
        }
        if checkpoint.step != common_state.step
            || checkpoint.time_s != common_state.time_s
            || checkpoint.dt != common_state.dt
        {
            anyhow::bail!("checkpoint/common-state identity mismatch");
        }
        let _lease = self.write_transaction()?;
        let path = create_parent(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if path.exists() {
            anyhow::bail!("checkpoint is immutable; capture a new checkpoint ID");
        }
        // The state and all referenced payloads precede the commit marker.
        let state_json = serde_json::to_vec_pretty(common_state)?;
        atomic_write(
            &checked_path(&self.root, &checkpoint.common_state_ref)?,
            &state_json,
        )?;
        crate::reachability::walk_checkpoint(&self.root, checkpoint)?.require_complete()?;
        let cp_json = serde_json::to_vec_pretty(checkpoint)?;
        atomic_write(&path, &cp_json)?;
        Ok(())
    }

    /// Read the latest checkpoint for a run.
    pub fn latest_checkpoint(&self, run_id: &str) -> Result<Option<FmsCheckpoint>> {
        let checkpoints = self.list_checkpoints(run_id)?;
        Ok(checkpoints.into_iter().last())
    }

    /// Read committed checkpoints ordered by step and capture time.
    pub fn list_checkpoints(&self, run_id: &str) -> Result<Vec<FmsCheckpoint>> {
        validate_store_id(run_id)?;
        let cp_base = checked_path(&self.root, &format!("runs/{run_id}/checkpoints"))?;
        if !cp_base.exists() {
            return Ok(Vec::new());
        }
        let mut candidates = fs::read_dir(&cp_base)?.collect::<std::io::Result<Vec<_>>>()?;
        candidates.sort_by_key(|e| e.file_name());

        let mut checkpoints = Vec::new();
        for candidate in candidates {
            let id = candidate
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("invalid checkpoint directory"))?;
            if let Some(checkpoint) = self.read_checkpoint(run_id, &id)? {
                checkpoints.push(checkpoint);
            }
        }
        checkpoints.sort_by(|a, b| {
            a.step
                .cmp(&b.step)
                .then(a.created_at.cmp(&b.created_at))
                .then(a.checkpoint_id.cmp(&b.checkpoint_id))
        });
        Ok(checkpoints)
    }

    /// Read one checkpoint for a run.
    pub fn read_checkpoint(
        &self,
        run_id: &str,
        checkpoint_id: &str,
    ) -> Result<Option<FmsCheckpoint>> {
        validate_store_id(run_id)?;
        validate_store_id(checkpoint_id)?;
        let prefix = format!("runs/{run_id}/checkpoints/{checkpoint_id}");
        let path = checked_path(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let checkpoint: FmsCheckpoint = serde_json::from_slice(&data)?;
        if checkpoint.run_id != run_id
            || checkpoint.checkpoint_id != checkpoint_id
            || checkpoint.common_state_ref != format!("{prefix}/common_state.json")
        {
            anyhow::bail!("checkpoint path/content identity mismatch");
        }
        let state_bytes = self
            .read_document(&checkpoint.common_state_ref)?
            .context("checkpoint common state is missing")?;
        let state: CommonSolverState = serde_json::from_slice(&state_bytes)?;
        if state.step != checkpoint.step
            || state.time_s != checkpoint.time_s
            || state.dt != checkpoint.dt
        {
            anyhow::bail!("checkpoint/common-state identity mismatch");
        }
        crate::reachability::walk_checkpoint(&self.root, &checkpoint)?.require_complete()?;
        Ok(Some(checkpoint))
    }

    /// Delete one committed checkpoint of a run under the writer lease.
    ///
    /// Returns `Ok(false)` when the checkpoint does not exist (idempotent).
    /// Refuses with [`CheckpointStillReferenced`] while the run manifest names
    /// it as the latest checkpoint. Only the checkpoint-owned directory
    /// (`checkpoint.json`, `common_state.json`, per-checkpoint payload files)
    /// is removed, with the commit marker first so an interrupted deletion
    /// never leaves a readable checkpoint with missing payloads. CAS objects
    /// are never removed here: reclaiming them is the job of `gc_preview` and
    /// `gc_apply`, which re-mark reachability from the remaining roots.
    pub fn delete_checkpoint(&self, run_id: &str, checkpoint_id: &str) -> Result<bool> {
        validate_store_id(run_id)?;
        validate_store_id(checkpoint_id)?;
        let _lease = self.write_transaction()?;
        let prefix = format!("runs/{run_id}/checkpoints/{checkpoint_id}");
        let marker = checked_path(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if !marker.exists() {
            return Ok(false);
        }
        // A checkpoint that fails its own integrity check is not silently dropped.
        self.read_checkpoint(run_id, checkpoint_id)?
            .context("checkpoint disappeared under the writer lease")?;
        if let Some(run) = self.read_run(run_id)? {
            if run.latest_checkpoint_ref.as_deref() == Some(&format!("{prefix}/checkpoint.json")) {
                return Err(CheckpointStillReferenced {
                    run_id: run_id.to_string(),
                    checkpoint_id: checkpoint_id.to_string(),
                    referenced_by: "the run manifest (latest checkpoint)".to_string(),
                }
                .into());
            }
        }
        let dir = checked_path(&self.root, &prefix)?;
        let mut children = Vec::new();
        for child in fs::read_dir(&dir)? {
            let child = child?;
            reject_link(&child.path())?;
            if !child.file_type()?.is_file() {
                anyhow::bail!(
                    "unsupported entry in checkpoint directory: {}",
                    child.path().display()
                );
            }
            children.push(child.path());
        }
        fs::remove_file(&marker)?;
        sync_directory(&dir)?;
        for child in children {
            if child != marker {
                fs::remove_file(&child)?;
            }
        }
        fs::remove_dir(&dir)?;
        sync_directory(dir.parent().expect("checkpoint directory has a parent"))?;
        Ok(true)
    }

    // ── Tensor storage ─────────────────────────────────────────────────

    /// Store a magnetization vector `Vec<[f64; 3]>` and return the CAS hash.
    pub fn store_magnetization(&self, m: &[[f64; 3]]) -> Result<String> {
        let bytes = magnetization_to_bytes(m);
        self.cas.put(&bytes)
    }

    /// Load magnetization from CAS by hash.
    pub fn load_magnetization(&self, hash: &str) -> Result<Option<Vec<[f64; 3]>>> {
        match self.cas.get(hash)? {
            Some(bytes) => {
                if bytes.len() % 24 != 0 {
                    anyhow::bail!("truncated f64 magnetization payload");
                }
                Ok(Some(magnetization_from_bytes(&bytes)))
            }
            None => Ok(None),
        }
    }

    /// Store arbitrary bytes in CAS.
    pub fn store_blob(&self, data: &[u8]) -> Result<String> {
        self.cas.put(data)
    }

    // ── JSON documents ─────────────────────────────────────────────────

    /// Write a project document. Control records use validated dedicated writers.
    pub fn write_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        if !relative_path.starts_with("project/") {
            anyhow::bail!("public document writes must stay within project/");
        }
        self.write_import_document(relative_path, data)
    }

    /// Internal import adapter; only call after validating the complete archive.
    fn prepare_import_document_path(&self, relative_path: &str) -> Result<PathBuf> {
        validate_document_namespace(relative_path)?;
        let components: Vec<_> = relative_path.split('/').collect();
        if components.len() >= 5 && components[0] == "runs" && components[2] == "checkpoints" {
            validate_store_id(components[1])?;
            validate_store_id(components[3])?;
            let marker = format!(
                "runs/{}/checkpoints/{}/checkpoint.json",
                components[1], components[3]
            );
            if checked_path(&self.root, &marker)?.exists() {
                anyhow::bail!("committed checkpoint documents are immutable");
            }
        }
        create_parent(&self.root, relative_path)
    }

    /// Internal import adapter; only call after validating the complete archive.
    pub(crate) fn write_import_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        validate_document_namespace(relative_path)?;
        let _lease = self.write_transaction()?;
        let path = self.prepare_import_document_path(relative_path)?;
        atomic_write(&path, data)
    }

    /// Stream a verified staged document into the store without materializing
    /// its contents. Namespace and checkpoint immutability checks are shared
    /// with the byte-oriented import adapter above.
    pub(crate) fn write_import_document_file(
        &self,
        relative_path: &str,
        source: &Path,
        expected_hash: &str,
        expected_length: u64,
    ) -> Result<()> {
        validate_document_namespace(relative_path)?;
        let _lease = self.write_transaction()?;
        let path = self.prepare_import_document_path(relative_path)?;
        atomic_write_verified_file(&path, source, expected_hash, expected_length)
    }

    /// Import one accepted-run evidence file into the read-only `imports`
    /// namespace. The archive detached path is translated below
    /// `imports/accepted_provenance/`; it can never become a `runs/` control
    /// record or an accepted-store authority file.
    pub(crate) fn write_readonly_import_evidence_file(
        &self,
        archive_relative_path: &str,
        source: &Path,
        expected_hash: &str,
        expected_length: u64,
    ) -> Result<()> {
        let destination_relative = readonly_import_evidence_path(archive_relative_path)?;
        let _lease = self.write_transaction()?;
        let path = create_parent(&self.root, &destination_relative)?;
        atomic_write_verified_file(&path, source, expected_hash, expected_length)
    }

    pub(crate) fn write_checkpoint_payload(
        &self,
        checkpoint: &FmsCheckpoint,
        name: &str,
        data: &[u8],
    ) -> Result<()> {
        validate_store_id(&checkpoint.run_id)?;
        validate_store_id(&checkpoint.checkpoint_id)?;
        if !matches!(
            name,
            "backend_state.json" | "integrator_state.json" | "rng_state.json"
        ) {
            anyhow::bail!("unsupported checkpoint payload document");
        }
        self.write_import_document(
            &format!(
                "runs/{}/checkpoints/{}/{name}",
                checkpoint.run_id, checkpoint.checkpoint_id
            ),
            data,
        )
    }

    /// Read a JSON document relative to the store root.
    pub fn read_document(&self, relative_path: &str) -> Result<Option<Vec<u8>>> {
        let path = checked_path(&self.root, relative_path)?;
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(&path)?))
    }

    /// Snapshot portable project files, preserving scripts, UI, assets and unknown documents.
    pub fn project_documents(&self) -> Result<std::collections::HashMap<String, Vec<u8>>> {
        let _lease = self.write_transaction()?;
        fn visit(
            store: &SessionStore,
            relative: &str,
            output: &mut std::collections::HashMap<String, Vec<u8>>,
        ) -> Result<()> {
            let path = checked_path(store.root(), relative)?;
            if !path.exists() {
                return Ok(());
            }
            if path.is_dir() {
                for entry in fs::read_dir(path)? {
                    let name = entry?
                        .file_name()
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("non-UTF8 project path"))?;
                    visit(store, &format!("{relative}/{name}"), output)?;
                }
            } else if path.is_file() {
                output.insert(relative.to_owned(), fs::read(path)?);
            } else {
                anyhow::bail!("unsupported project document");
            }
            Ok(())
        }
        let mut output = std::collections::HashMap::new();
        visit(self, "project", &mut output)?;
        Ok(output)
    }

    // ── Recovery ───────────────────────────────────────────────────────

    /// Write a crash-recovery snapshot.
    pub fn write_recovery(&self, session: &FmsSessionManifest) -> Result<()> {
        validate_store_id(&session.session_id)?;
        if session.format != "fullmag.session.v1" {
            anyhow::bail!("unsupported recovery schema");
        }
        let _lease = self.write_transaction()?;
        let data = serde_json::to_vec_pretty(session)?;
        let path = create_parent(&self.root, &format!("recovery/{}.json", session.session_id))?;
        atomic_write(&path, &data)
    }

    /// List available recovery snapshots.
    pub fn list_recovery(&self) -> Result<Vec<FmsSessionManifest>> {
        let dir = checked_path(&self.root, "recovery")?;
        let mut result = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    reject_link(&entry.path())?;
                    let data = fs::read(entry.path())?;
                    let manifest: FmsSessionManifest = serde_json::from_slice(&data)?;
                    validate_store_id(&manifest.session_id)?;
                    if manifest.format != "fullmag.session.v1" {
                        anyhow::bail!("unknown recovery schema");
                    }
                    result.push(manifest);
                }
            }
        }
        result.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        Ok(result)
    }

    /// Read only the recovery snapshot owned by the requested session.
    pub fn read_session_recovery(&self, session_id: &str) -> Result<Option<FmsSessionManifest>> {
        validate_store_id(session_id)?;
        let path = checked_path(&self.root, &format!("recovery/{session_id}.json"))?;
        let data = match fs::read(&path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let manifest: FmsSessionManifest = serde_json::from_slice(&data)?;
        if manifest.session_id != session_id || manifest.format != "fullmag.session.v1" {
            anyhow::bail!("recovery snapshot identity or schema mismatch");
        }
        Ok(Some(manifest))
    }

    /// Remove one validated snapshot under the writer lease; return the actual count.
    pub fn clear_session_recovery(&self, session_id: &str) -> Result<usize> {
        let _lease = self.write_transaction()?;
        if self.read_session_recovery(session_id)?.is_none() {
            return Ok(0);
        }
        let path = checked_path(&self.root, &format!("recovery/{session_id}.json"))?;
        fs::remove_file(&path)?;
        sync_directory(path.parent().expect("recovery snapshot has a parent"))?;
        Ok(1)
    }

    /// Clear recovery snapshots.
    pub fn clear_recovery(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let dir = checked_path(&self.root, "recovery")?;
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                reject_link(&entry.path())?;
                fs::remove_file(entry.path())?;
            }
        }
        sync_directory(&dir)
    }

    // ── File lock ──────────────────────────────────────────────────────

    /// Attempt to acquire the workspace lock.
    pub fn try_lock(&self, session_id: &str) -> Result<bool> {
        validate_store_id(session_id)?;
        let mut slot = self
            .explicit_lease
            .lock()
            .map_err(|_| anyhow::anyhow!("lease mutex poisoned"))?;
        if slot.is_some() {
            return Ok(false);
        }
        match self.write_transaction() {
            Ok(lease) => {
                *slot = Some(lease);
                Ok(true)
            }
            Err(error) if error.to_string().contains("writer is busy") => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Release the workspace lock.
    pub fn unlock(&self) -> Result<()> {
        let mut slot = self
            .explicit_lease
            .lock()
            .map_err(|_| anyhow::anyhow!("lease mutex poisoned"))?;
        let lease = slot
            .take()
            .context("this store does not own an explicit writer lease")?;
        drop(lease);
        Ok(())
    }

    // ── GC ─────────────────────────────────────────────────────────────

    /// Collect object hashes referenced by all known checkpoints.
    pub fn collect_live_refs(&self) -> Result<HashSet<String>> {
        let _lease = self.write_transaction()?;
        let report = crate::reachability::walk_store_root(
            &self.root,
            crate::reachability::ReachabilityMode::Gc,
        )?;
        if !report.complete {
            anyhow::bail!("incomplete reference graph; GC blocked");
        }
        let mut refs = report.object_refs;
        refs.extend(self.cas.pinned_refs()?);
        Ok(refs)
    }

    /// Compatibility entry point: preview only, never an implicit apply.
    pub fn gc(&self) -> Result<usize> {
        Ok(self.gc_preview()?.candidates.len())
    }

    /// Produce a reviewable preview without deleting objects.
    pub fn gc_preview(&self) -> Result<GcPlan> {
        let _lease = self.write_transaction()?;
        let live = self.collect_live_refs()?;
        let mut candidates = Vec::new();
        for hash in self.cas.list()? {
            if !live.contains(&hash) {
                self.cas.get(&hash)?.context("CAS candidate disappeared")?;
                candidates.push(hash);
            }
        }
        candidates.sort();
        Ok(GcPlan {
            schema: "fullmag.gc-plan.v1".into(),
            root: self.root.clone(),
            generation: repository_generation(&self.root)?,
            candidates,
        })
    }

    /// Re-mark under the same exclusive lease immediately before any sweep.
    pub fn gc_apply(&self, scope: &Path, plan: &GcPlan) -> Result<usize> {
        let _lease = self.write_transaction()?;
        if fs::canonicalize(scope)? != self.root
            || plan.root != self.root
            || plan.schema != "fullmag.gc-plan.v1"
        {
            anyhow::bail!("GC scope does not match the reviewed plan");
        }
        let fresh = self.gc_preview()?;
        if &fresh != plan {
            anyhow::bail!("GC generation changed; produce and review a new preview");
        }
        for hash in &fresh.candidates {
            self.cas.remove_verified(hash)?;
        }
        Ok(fresh.candidates.len())
    }

    /// Retire pins backed by immutable checkpoint or SolutionSet roots.
    /// Mutable recovery/run records alone cannot retire another in-flight
    /// ingest's hash pin.
    pub fn release_published_pins(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let graph = crate::reachability::walk_store_root(
            &self.root,
            crate::reachability::ReachabilityMode::Gc,
        )?;
        if !graph.complete {
            anyhow::bail!("incomplete reference graph; retain pins");
        }
        let mut permanent = HashSet::new();
        for reference in &graph.file_refs {
            if !reference.ends_with("/checkpoint.json") {
                continue;
            }
            let parts: Vec<_> = reference.split('/').collect();
            if parts.len() != 5 || parts[0] != "runs" || parts[2] != "checkpoints" {
                continue;
            }
            let checkpoint = self
                .read_checkpoint(parts[1], parts[3])?
                .context("checkpoint disappeared under lease")?;
            permanent
                .extend(crate::reachability::walk_checkpoint(&self.root, &checkpoint)?.object_refs);
        }
        permanent.extend(self.solution_sets.durable_objects_locked()?.into_keys());
        self.cas.release_referenced_pins(&permanent)
    }

    fn release_solution_set_pins(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let objects = self.solution_sets.durable_objects_locked()?;
        for (object_ref, expected_length) in &objects {
            let actual_length = self
                .cas
                .verified_length(object_ref)?
                .with_context(|| format!("solution-set CAS object `{object_ref}` is missing"))?;
            if actual_length != *expected_length {
                anyhow::bail!(
                    "solution-set CAS object `{object_ref}` length mismatch: expected {expected_length}, found {actual_length}"
                );
            }
        }
        self.cas
            .release_referenced_pins(&objects.into_keys().collect())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GcPlan {
    pub schema: String,
    pub root: PathBuf,
    pub generation: String,
    pub candidates: Vec<String>,
}

fn repository_generation(root: &Path) -> Result<String> {
    fn visit(root: &Path, path: &Path, entries: &mut Vec<(String, String)>) -> Result<()> {
        reject_link(path)?;
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("non-UTF8 repository path")?
                .replace('\\', "/");
            if matches!(relative.as_str(), "WRITER.lock" | "WRITER.owner.json") {
                continue;
            }
            reject_link(&path)?;
            if child.file_type()?.is_dir() {
                visit(root, &path, entries)?;
            } else if child.file_type()?.is_file() {
                entries.push((relative, crate::cas::hex_sha256(&fs::read(path)?)));
            } else {
                anyhow::bail!("unsupported repository entry");
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    Ok(crate::cas::hex_sha256(&serde_json::to_vec(&entries)?))
}

fn validate_session_references(root: &Path, manifest: &FmsSessionManifest) -> Result<()> {
    if manifest.workspace_ref != "manifest/workspace.json"
        || manifest.export_profile_ref != "manifest/export_profile.json"
    {
        anyhow::bail!("unsupported session workspace or export profile reference");
    }
    let mut seen = HashSet::new();
    for reference in &manifest.run_refs {
        let id = reference
            .strip_prefix("runs/")
            .and_then(|rest| rest.strip_suffix("/run_manifest.json"))
            .context("invalid session run reference")?;
        validate_store_id(id)?;
        if !seen.insert(id) {
            anyhow::bail!("duplicate session run reference");
        }
        let path = checked_path(root, reference)?;
        let run: FmsRunManifest =
            serde_json::from_slice(&fs::read(path).context("session references a missing run")?)?;
        if run.run_id != id {
            anyhow::bail!("session run reference identity mismatch");
        }
    }
    Ok(())
}

fn validate_session_manifest_schema(manifest: &FmsSessionManifest) -> Result<()> {
    match manifest.format.as_str() {
        FMS_SESSION_FORMAT_V1 => {
            if manifest.accepted_provenance_ref.is_some() {
                anyhow::bail!("fullmag.session.v1 cannot carry accepted provenance");
            }
        }
        FMS_SESSION_FORMAT_V2 => {
            manifest
                .accepted_provenance_ref
                .as_ref()
                .context("fullmag.session.v2 requires accepted provenance reference")?
                .validate()?;
        }
        _ => anyhow::bail!("unsupported session schema `{}`", manifest.format),
    }
    Ok(())
}

fn readonly_import_evidence_path(archive_relative_path: &str) -> Result<String> {
    crate::repository_path::validate_relative_path(archive_relative_path)?;
    if archive_relative_path == FMS_ACCEPTED_PROVENANCE_MANIFEST_REF {
        return Ok("imports/accepted_provenance/manifest.json".into());
    }
    if archive_relative_path
        .strip_prefix("accepted_provenance/")
        .is_some_and(|relative| !relative.is_empty())
    {
        return Ok(format!("imports/{archive_relative_path}"));
    }
    anyhow::bail!(
        "read-only import evidence path must be the accepted provenance manifest or detached record"
    )
}

fn validate_document_namespace(relative: &str) -> Result<()> {
    crate::repository_path::validate_relative_path(relative)?;
    if !matches!(
        relative.split('/').next(),
        Some("project" | "manifest" | "runs" | "recovery" | "solutions" | "batches")
    ) {
        anyhow::bail!("document writer cannot modify repository control files or CAS");
    }
    Ok(())
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Serialize magnetization to little-endian f64 bytes.
fn magnetization_to_bytes(m: &[[f64; 3]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(m.len() * 3 * 8);
    for cell in m {
        for component in cell {
            buf.extend_from_slice(&component.to_le_bytes());
        }
    }
    buf
}

/// Deserialize magnetization from little-endian f64 bytes.
fn magnetization_from_bytes(data: &[u8]) -> Vec<[f64; 3]> {
    let n = data.len() / 24; // 3 components * 8 bytes each
    let mut m = Vec::with_capacity(n);
    for i in 0..n {
        let off = i * 24;
        let mx = f64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        let my = f64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap());
        let mz = f64::from_le_bytes(data[off + 16..off + 24].try_into().unwrap());
        m.push([mx, my, mz]);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn live_command_journal_replaces_current_generation_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        let store = SessionStore::open(&root).unwrap();

        store
            .commit_live_command_journal("session-command-journal", br#"{"revision":1}"#)
            .unwrap();
        assert_eq!(
            store
                .read_live_command_journal("session-command-journal")
                .unwrap()
                .unwrap(),
            br#"{"revision":1}"#
        );
        store
            .commit_live_command_journal("session-command-journal", br#"{"revision":2}"#)
            .unwrap();

        let reopened = SessionStore::open(&root).unwrap();
        assert_eq!(
            reopened
                .read_live_command_journal("session-command-journal")
                .unwrap()
                .unwrap(),
            br#"{"revision":2}"#
        );
        let generation_count =
            fs::read_dir(root.join("live_command_journals/session-command-journal/generations"))
                .unwrap()
                .count();
        assert_eq!(generation_count, 1);

        let report = crate::reachability::walk_store_root(
            &root,
            crate::reachability::ReachabilityMode::Export,
        )
        .unwrap();
        assert!(
            report
                .file_refs
                .contains("live_command_journals/session-command-journal/CURRENT")
        );
        assert!(report.file_refs.iter().any(|reference| {
            reference.starts_with(
                "live_command_journals/session-command-journal/generations/generation-",
            )
        }));
    }

    pub(super) fn test_resource_lease(
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        epoch: u64,
        resource_id: &str,
        token: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> FmsResourceLease {
        FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: resource_id.into(),
            kind: if resource_id.starts_with("gpu") {
                FmsResourceKind::Gpu
            } else {
                FmsResourceKind::Cpu
            },
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: if resource_id.starts_with("gpu") { 1 } else { 0 },
                storage_bytes: 1,
            },
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            ownership_epoch: epoch,
            lease_token: token.into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        }
    }

    #[test]
    fn provider_job_intent_is_replayed_and_blocks_retry_until_remote_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-provider-job";
        let task_id = "task-provider-job";
        let now = Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Queued,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let lease = test_resource_lease(
            run_id,
            task_id,
            "attempt-provider-one",
            1,
            "cpu-provider-one",
            "lease-provider-one",
            now,
        );
        assert_eq!(
            store.commit_task_admission(&lease).unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );

        let mut intent = FmsProviderJobSubmission {
            schema_version: FMS_PROVIDER_JOB_SUBMISSION_SCHEMA.into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: lease.attempt_id.clone(),
            ownership_epoch: lease.ownership_epoch,
            provider_id: "provider-one".into(),
            target_id: "pool-one".into(),
            scheduler_id: "slurm".into(),
            resource_id: lease.resource_id.clone(),
            idempotency_key: String::new(),
            request_digest: format!("sha256:{}", "b".repeat(64)),
            status: FmsProviderJobStatus::SubmissionUnknown,
            provider_job_id: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        intent.idempotency_key = intent.expected_idempotency_key();
        assert_eq!(
            store.prepare_provider_job_submission(&intent).unwrap(),
            ProviderJobSubmissionDisposition::Prepared
        );
        assert_eq!(
            store.prepare_provider_job_submission(&intent).unwrap(),
            ProviderJobSubmissionDisposition::Replayed
        );

        let mut running = intent.clone();
        running.status = FmsProviderJobStatus::Running;
        running.provider_job_id = Some("3917;cluster-a".into());
        running.revision = 2;
        running.updated_at = now + chrono::Duration::seconds(1);
        assert_eq!(
            store.commit_provider_job_observation(&running).unwrap(),
            ProviderJobSubmissionDisposition::Updated
        );
        assert_eq!(
            store.list_provider_job_submissions(run_id).unwrap(),
            vec![running.clone()]
        );
        let mut changed_provider_job_id = running.clone();
        changed_provider_job_id.status = FmsProviderJobStatus::Succeeded;
        changed_provider_job_id.provider_job_id = Some("3918;cluster-a".into());
        changed_provider_job_id.revision += 1;
        changed_provider_job_id.updated_at = now + chrono::Duration::seconds(2);
        assert!(store
            .commit_provider_job_observation(&changed_provider_job_id)
            .is_err());

        let mut catalog = store.read_run_catalog(run_id).unwrap().unwrap();
        catalog.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        catalog.tasks[0].observation = Some(FmsObservationState::Reconciling);
        catalog.revision += 1;
        catalog.updated_at = now + chrono::Duration::seconds(2);
        store.commit_run_catalog(&catalog).unwrap();
        let retry = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-provider-retry".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: lease.attempt_id.clone(),
            ownership_epoch: lease.ownership_epoch,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "provider status has not reached a terminal state".into(),
            created_at: now + chrono::Duration::seconds(3),
        };
        assert!(store.commit_retry_decision(&retry).is_err());
        assert!(store
            .read_retry_decision(run_id, "decision-provider-retry")
            .unwrap()
            .is_none());

        let mut failed = running.clone();
        failed.status = FmsProviderJobStatus::Failed;
        failed.revision += 1;
        failed.updated_at = now + chrono::Duration::seconds(4);
        assert_eq!(
            store.commit_provider_job_observation(&failed).unwrap(),
            ProviderJobSubmissionDisposition::Updated
        );
        assert_eq!(
            store.commit_retry_decision(&retry).unwrap(),
            RetryDecisionCommitDisposition::Accepted
        );
        store.release_resource_lease(&lease).unwrap();
        assert_eq!(
            store.apply_retry_decision(&retry).unwrap(),
            RetryDecisionApplyDisposition::Applied
        );
        let next_lease = test_resource_lease(
            run_id,
            task_id,
            "attempt-provider-two",
            2,
            "cpu-provider-one",
            "lease-provider-two",
            now + chrono::Duration::seconds(5),
        );
        assert_eq!(
            store.commit_task_admission(&next_lease).unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );
    }

    #[test]
    fn raw_solver_lease_scan_finds_active_lease_after_catalog_claim_is_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-orphan-active-lease";
        let task_id = "task-orphan-active-lease";
        let now = Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Queued,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let lease = test_resource_lease(
            run_id,
            task_id,
            "attempt-orphan-active-lease",
            1,
            "cpu-orphan-active-lease",
            "lease-orphan-active-lease",
            now,
        );
        assert_eq!(
            store.commit_task_admission(&lease).unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );
        assert_eq!(
            store
                .read_active_resource_lease_for_task(run_id, task_id)
                .unwrap(),
            Some(lease)
        );

        let mut contradictory_catalog = store.read_run_catalog(run_id).unwrap().unwrap();
        contradictory_catalog.revision += 1;
        contradictory_catalog.updated_at = Utc::now();
        let task = contradictory_catalog
            .tasks
            .iter_mut()
            .find(|task| task.task_id == task_id)
            .unwrap();
        task.lifecycle = FmsTaskLifecycle::Accepted;
        task.readiness = FmsTaskReadiness::Blocked {
            reason: FMS_TASK_AWAITING_PREPARATION_REASON.into(),
        };
        task.attempt_id = None;
        task.ownership_epoch = None;
        task.resource_id = None;
        store.commit_run_catalog(&contradictory_catalog).unwrap();

        assert!(
            store
                .read_active_resource_lease_for_task(run_id, task_id)
                .unwrap()
                .is_none()
        );
        let _writer = store.write_transaction().unwrap();
        assert!(
            store
                .has_active_solver_lease_for_task_unlocked(run_id, task_id)
                .unwrap()
        );
    }

    #[test]
    fn reconcile_requires_writer_lease_even_when_catalog_needs_no_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        let store = SessionStore::open(&root).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-reconcile-lock".into(),
                revision: 1,
                updated_at: now,
                tasks: Vec::new(),
            })
            .unwrap();

        let competing_store = SessionStore::open(&root).unwrap();
        let _lease = store.write_transaction().unwrap();

        let error = competing_store
            .reconcile_run_catalog("run-reconcile-lock")
            .unwrap_err();
        assert!(error.to_string().contains("writer is busy"));
    }

    #[test]
    fn durable_run_intent_replays_original_run_and_rejects_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsRunIntent::new(
            "run-1",
            "submit-1",
            serde_json::json!({"run_id": "run-1", "snapshot": "sha-1"}),
        );
        assert_eq!(
            store.commit_run_intent(&first).unwrap(),
            RunIntentCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_run_intent(&first).unwrap(),
            RunIntentCommitDisposition::Replayed {
                run_id: "run-1".into()
            }
        );
        assert_eq!(
            store.find_run_intent("submit-1").unwrap(),
            Some(first.clone())
        );
        assert_eq!(store.list_run_intents().unwrap(), vec![first]);

        let changed = FmsRunIntent::new(
            "run-2",
            "submit-1",
            serde_json::json!({"run_id": "run-2", "snapshot": "sha-2"}),
        );
        assert!(store.commit_run_intent(&changed).is_err());
        assert!(store.read_run_intent("run-2").unwrap().is_none());

        let mismatched =
            FmsRunIntent::new("run-3", "submit-3", serde_json::json!({"run_id": "run-4"}));
        assert!(store.commit_run_intent(&mismatched).is_err());
        assert!(store.read_run_intent("run-3").unwrap().is_none());

        let mut missing_definition = FmsRunIntent::new(
            "run-5",
            "submit-5",
            serde_json::json!({
                "run_id": "run-5",
                "snapshot": {"definition_sha256": "b".repeat(64)}
            }),
        );
        missing_definition.definition_object_ref = Some("b".repeat(64));
        assert!(store.commit_run_intent(&missing_definition).is_err());
        assert!(store.read_run_intent("run-5").unwrap().is_none());

        let mut missing_study = FmsRunIntent::new(
            "run-6",
            "submit-6",
            serde_json::json!({
                "run_id": "run-6",
                "study": {"plan_sha256": "c".repeat(64)}
            }),
        );
        missing_study.study_object_ref = Some("c".repeat(64));
        assert!(store.commit_run_intent(&missing_study).is_err());
        assert!(store.read_run_intent("run-6").unwrap().is_none());

        let mut missing_asset = FmsRunIntent::new(
            "run-7",
            "submit-7",
            serde_json::json!({
                "run_id": "run-7",
                "immutable_assets": [{"asset_id": "asset-1", "content_sha256": "d".repeat(64)}]
            }),
        );
        missing_asset
            .asset_object_refs
            .insert("asset-1".into(), "d".repeat(64));
        assert!(store.commit_run_intent(&missing_asset).is_err());
        assert!(store.read_run_intent("run-7").unwrap().is_none());
    }

    #[test]
    fn durable_batch_intent_replays_original_batch_and_rejects_conflicts() {
        #[cfg(windows)]
        const OUTPUT_PARENT: &str = "C:/fullmag/results";
        #[cfg(not(windows))]
        const OUTPUT_PARENT: &str = "/tmp/fullmag/results";
        #[cfg(windows)]
        const CHANGED_OUTPUT_PARENT: &str = "C:/fullmag/new-results";
        #[cfg(not(windows))]
        const CHANGED_OUTPUT_PARENT: &str = "/tmp/fullmag/new-results";

        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();

        let definition = store.cas().put(b"project definition").unwrap();
        let study = store.cas().put(b"study plan").unwrap();
        let study_catalog = store.cas().put(b"study catalog").unwrap();
        let make_intent = |batch_id: &str, variant: &str| {
            let mut manifest_value = serde_json::json!({
                "schema_version": FMS_BATCH_EXPANSION_MANIFEST_SCHEMA,
                "batch_id": batch_id,
                "cases": [{ "case_id": "case-1" }],
                "variant": variant,
                "manifest_sha256": ""
            });
            let mut unsigned_manifest = manifest_value.clone();
            unsigned_manifest
                .as_object_mut()
                .unwrap()
                .remove("manifest_sha256");
            let manifest_sha256 = canonical_json_sha256(&unsigned_manifest);
            manifest_value["manifest_sha256"] = serde_json::json!(manifest_sha256);
            let manifest_bytes = canonical_json_bytes(&manifest_value);
            let manifest_object_ref = store.cas().put(&manifest_bytes).unwrap();
            let output_settings = serde_json::json!({
                "output_dir": OUTPUT_PARENT,
                "temp_dir": null,
                "data_format": "zarr",
                "cleanup": "on_success",
                "existing_output": "timestamp"
            });
            let workspace_defaults = serde_json::json!({
                "output_parent": OUTPUT_PARENT,
                "temp_parent": null,
                "data_format": "zarr",
                "cleanup": "on_success",
                "existing_output": "timestamp"
            });
            let specification = serde_json::json!({
                "schema_version": FMS_BATCH_SUBMIT_SNAPSHOT_SCHEMA,
                "batch_id": batch_id,
                "manifest_sha256": manifest_sha256,
                "output_storage": {
                    "schema_version": FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA,
                    "source": "workspace_defaults",
                    "settings_sha256": canonical_json_sha256(&output_settings),
                    "workspace_defaults_sha256": canonical_json_sha256(&workspace_defaults),
                    "settings": output_settings
                },
                "request": {
                    "batch_id": batch_id,
                    "template": {
                        "snapshot": { "definition_sha256": definition },
                        "study": { "plan_sha256": study },
                        "study_catalog_sha256": study_catalog,
                        "immutable_assets": []
                    }
                }
            });
            FmsBatchIntent::new(
                batch_id,
                "submit-batch-1",
                specification,
                manifest_object_ref,
                definition.clone(),
                study.clone(),
                study_catalog.clone(),
                BTreeMap::new(),
            )
        };
        let first = make_intent("batch-1", "first");

        assert_eq!(
            store.commit_batch_intent(&first).unwrap(),
            BatchIntentCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_batch_intent(&first).unwrap(),
            BatchIntentCommitDisposition::Replayed {
                batch_id: "batch-1".into()
            }
        );
        let mut replay_after_defaults_change = first.clone();
        let changed_output_settings = serde_json::json!({
            "output_dir": CHANGED_OUTPUT_PARENT,
            "temp_dir": null,
            "data_format": "zarr",
            "cleanup": "always",
            "existing_output": "error"
        });
        replay_after_defaults_change.specification["output_storage"]["settings"] =
            changed_output_settings.clone();
        replay_after_defaults_change.specification["output_storage"]["settings_sha256"] =
            serde_json::json!(canonical_json_sha256(&changed_output_settings));
        let changed_defaults = serde_json::json!({
            "output_parent": CHANGED_OUTPUT_PARENT,
            "temp_parent": null,
            "data_format": "zarr",
            "cleanup": "always",
            "existing_output": "error"
        });
        replay_after_defaults_change.specification["output_storage"]["workspace_defaults_sha256"] =
            serde_json::json!(canonical_json_sha256(&changed_defaults));
        replay_after_defaults_change.payload_sha256 =
            canonical_json_sha256(&replay_after_defaults_change.specification);
        assert_ne!(
            replay_after_defaults_change.payload_sha256,
            first.payload_sha256
        );
        assert_eq!(
            store
                .commit_batch_intent(&replay_after_defaults_change)
                .unwrap(),
            BatchIntentCommitDisposition::Replayed {
                batch_id: "batch-1".into()
            }
        );
        assert_eq!(
            store.read_batch_intent("batch-1").unwrap(),
            Some(first.clone())
        );
        let initial_progress = FmsBatchExpansionProgress::new(&first, 1, 0, 1).unwrap();
        assert_eq!(
            store
                .commit_batch_expansion_progress(0, &initial_progress)
                .unwrap(),
            BatchExpansionProgressCommitDisposition::Accepted
        );
        assert_eq!(
            store
                .commit_batch_expansion_progress(0, &initial_progress)
                .unwrap(),
            BatchExpansionProgressCommitDisposition::Replayed
        );
        let pause = FmsBatchCommandIntent::new(
            "batch-1",
            "pause-1",
            0,
            FmsBatchCommandAction::PauseAdmission,
            "operator pause",
        );
        assert_eq!(
            store.commit_batch_command(&pause).unwrap(),
            BatchCommandCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_batch_command(&pause).unwrap(),
            BatchCommandCommitDisposition::Replayed
        );
        let mut legacy_pause = FmsBatchCommandIntent::new(
            "batch-legacy-command",
            "legacy-pause",
            0,
            FmsBatchCommandAction::PauseAdmission,
            "legacy operator pause",
        );
        legacy_pause.schema_version = FMS_BATCH_COMMAND_LEGACY_SCHEMA.into();
        legacy_pause.validate().unwrap();
        let legacy_round_trip: FmsBatchCommandIntent =
            serde_json::from_slice(&serde_json::to_vec(&legacy_pause).unwrap()).unwrap();
        assert_eq!(legacy_round_trip, legacy_pause);
        let paused_progress = store
            .read_batch_expansion_progress("batch-1")
            .unwrap()
            .unwrap();
        assert_eq!(paused_progress.state, FmsBatchExpansionState::Paused);
        let retry_target = FmsBatchRetryTarget {
            case_id: "case-1".into(),
            run_id: "run-1".into(),
            task_id: "task-1".into(),
            retry_id: "retry-1".into(),
            expected_catalog_revision: 3,
        };
        let retry = FmsBatchCommandIntent::new_retry(
            "batch-1",
            "retry-command-1",
            1,
            retry_target.clone(),
            "operator retry",
        );
        assert_eq!(
            store.validate_batch_command(&retry).unwrap(),
            BatchCommandCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_batch_command(&retry).unwrap(),
            BatchCommandCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_batch_command(&retry).unwrap(),
            BatchCommandCommitDisposition::Replayed
        );
        let progress_with_retry = store
            .read_batch_expansion_progress("batch-1")
            .unwrap()
            .unwrap();
        assert_eq!(progress_with_retry.state, FmsBatchExpansionState::Paused);
        assert_eq!(progress_with_retry.commands.last().unwrap().retry_target, Some(retry_target));
        let resume = FmsBatchCommandIntent::new(
            "batch-1",
            "resume-1",
            2,
            FmsBatchCommandAction::ResumeAdmission,
            "operator resume",
        );
        assert_eq!(
            store.commit_batch_command(&resume).unwrap(),
            BatchCommandCommitDisposition::Accepted
        );
        let resumed_progress = store
            .read_batch_expansion_progress("batch-1")
            .unwrap()
            .unwrap();
        assert_eq!(resumed_progress.state, FmsBatchExpansionState::Pending);
        let mut completed_progress = FmsBatchExpansionProgress::new(&first, 1, 1, 5).unwrap();
        completed_progress.commands = resumed_progress.commands.clone();
        assert_eq!(
            store
                .commit_batch_expansion_progress(4, &completed_progress)
                .unwrap(),
            BatchExpansionProgressCommitDisposition::Accepted
        );
        assert_eq!(
            store.read_batch_expansion_progress("batch-1").unwrap(),
            Some(completed_progress.clone())
        );
        let mut backwards_progress = FmsBatchExpansionProgress::new(&first, 1, 0, 6).unwrap();
        backwards_progress.commands = completed_progress.commands.clone();
        assert!(store
            .commit_batch_expansion_progress(5, &backwards_progress)
            .is_err());
        assert_eq!(store.find_batch_intent("submit-batch-1").unwrap(), Some(first.clone()));
        assert_eq!(store.list_batch_intents().unwrap(), vec![first]);

        let conflict = make_intent("batch-2", "different expansion");
        assert!(store.commit_batch_intent(&conflict).is_err());
        assert!(store.read_batch_intent("batch-2").unwrap().is_none());

        let mut missing = make_intent("batch-3", "missing");
        missing.manifest_object_ref = "f".repeat(64);
        assert!(store.commit_batch_intent(&missing).is_err());
        assert!(store.read_batch_intent("batch-3").unwrap().is_none());

        let mut mismatched_manifest = make_intent("batch-4", "mismatched logical digest");
        mismatched_manifest.specification["manifest_sha256"] = serde_json::json!("0".repeat(64));
        mismatched_manifest.payload_sha256 =
            canonical_json_sha256(&mismatched_manifest.specification);
        assert!(store.commit_batch_intent(&mismatched_manifest).is_err());
        assert!(store.read_batch_intent("batch-4").unwrap().is_none());

        let mut cancel_batch = make_intent("batch-cancel", "cancel admission");
        cancel_batch.idempotency_key = "submit-batch-cancel".into();
        store.commit_batch_intent(&cancel_batch).unwrap();
        let cancel_initial = FmsBatchExpansionProgress::new(&cancel_batch, 1, 0, 1).unwrap();
        store
            .commit_batch_expansion_progress(0, &cancel_initial)
            .unwrap();
        let cancel = FmsBatchCommandIntent::new(
            "batch-cancel",
            "cancel-1",
            0,
            FmsBatchCommandAction::CancelAdmission,
            "operator cancelled admission",
        );
        assert_eq!(
            store.commit_batch_command(&cancel).unwrap(),
            BatchCommandCommitDisposition::Accepted
        );
        assert_eq!(
            store
                .read_batch_expansion_progress("batch-cancel")
                .unwrap()
                .unwrap()
                .state,
            FmsBatchExpansionState::Cancelled
        );
    }

    #[test]
    fn durable_run_intent_read_rejects_oversized_control_documents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        let store = SessionStore::open(&root).unwrap();
        let run_dir = root.join("runs").join("run-budget");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(
            run_dir.join("run_intent.json"),
            vec![b' '; (crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES + 1) as usize],
        )
        .unwrap();

        let error = store.read_run_intent("run-budget").unwrap_err();
        assert!(error.to_string().contains("byte budget"));
    }

    #[test]
    fn durable_run_intent_commit_rejects_oversized_serialized_control_documents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        let store = SessionStore::open(&root).unwrap();
        let run_id = "run-budget-commit";
        let intent = FmsRunIntent::new(
            run_id,
            "submit-budget-commit",
            serde_json::json!({
                "run_id": run_id,
                "payload": "x".repeat(
                    (crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES + 1) as usize
                )
            }),
        );

        let error = store.commit_run_intent(&intent).unwrap_err();
        assert!(error.to_string().contains("metadata budget"));
        assert!(store.read_run_intent(run_id).unwrap().is_none());
        assert!(
            !root
                .join("runs")
                .join(run_id)
                .join("run_intent.json")
                .exists()
        );
    }

    #[test]
    fn scheduler_pool_checkpoint_is_sequence_fenced_and_replayable() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsSchedulerPoolCheckpoint {
            schema_version: FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA.into(),
            pool_id: "pool-a".into(),
            sequence: 1,
            run_source: FmsSchedulerRunSource::Explicit,
            run_ids: vec!["run-a".into(), "run-b".into()],
            next_run_id: Some("run-b".into()),
        };
        assert_eq!(
            store.commit_scheduler_pool_checkpoint(0, &first).unwrap(),
            SchedulerPoolCheckpointCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_scheduler_pool_checkpoint(0, &first).unwrap(),
            SchedulerPoolCheckpointCommitDisposition::Replayed
        );
        assert_eq!(
            store.read_scheduler_pool_checkpoint("pool-a").unwrap(),
            Some(first.clone())
        );
        let report = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Export,
        )
        .unwrap();
        assert!(report.file_refs.contains("scheduler_pools/pool-a.json"));

        let mut second = first.clone();
        second.sequence = 2;
        second.next_run_id = Some("run-a".into());
        assert_eq!(
            store.commit_scheduler_pool_checkpoint(1, &second).unwrap(),
            SchedulerPoolCheckpointCommitDisposition::Accepted
        );
        assert!(store.commit_scheduler_pool_checkpoint(1, &first).is_err());

        let mut changed_membership = second;
        changed_membership.sequence = 3;
        changed_membership.run_ids.pop();
        assert!(
            store
                .commit_scheduler_pool_checkpoint(2, &changed_membership)
                .is_err()
        );
    }

    #[test]
    fn preparation_scheduler_checkpoint_is_isolated_and_allows_store_membership_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsSchedulerPoolCheckpoint {
            schema_version: FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA.into(),
            pool_id: "pool-preparation".into(),
            sequence: 1,
            run_source: FmsSchedulerRunSource::Store,
            run_ids: vec!["run-a".into(), "run-b".into()],
            next_run_id: Some("run-b".into()),
        };
        assert_eq!(
            store
                .commit_preparation_scheduler_pool_checkpoint(0, &first)
                .unwrap(),
            SchedulerPoolCheckpointCommitDisposition::Accepted
        );
        assert_eq!(
            store
                .read_preparation_scheduler_pool_checkpoint("pool-preparation")
                .unwrap(),
            Some(first.clone())
        );
        assert!(
            store
                .read_scheduler_pool_checkpoint("pool-preparation")
                .unwrap()
                .is_none()
        );

        let mut second = first.clone();
        second.sequence = 2;
        second.run_ids = vec!["run-b".into(), "run-c".into()];
        second.next_run_id = Some("run-c".into());
        assert_eq!(
            store
                .commit_preparation_scheduler_pool_checkpoint(1, &second)
                .unwrap(),
            SchedulerPoolCheckpointCommitDisposition::Accepted
        );
        assert!(
            store
                .commit_preparation_scheduler_pool_checkpoint(1, &first)
                .is_err()
        );
        let report = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Export,
        )
        .unwrap();
        assert!(
            report
                .file_refs
                .contains("scheduler_pools/pool-preparation.preparation.json")
        );
    }

    #[test]
    fn preparation_retry_requires_the_exact_failed_attempt_and_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let run_id = "run-preparation-retry";
        let task_id = "task-preparation-retry";
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Accepted,
                    readiness: FmsTaskReadiness::Blocked {
                        reason: FMS_TASK_AWAITING_PREPARATION_REASON.into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let budget = FmsResourceBudget {
            cpu_millis: 100,
            memory_bytes: 1024,
            gpu_memory_bytes: 0,
            storage_bytes: 4096,
        };
        let pool = FmsPreparationResourcePool {
            schema_version: FMS_PREPARATION_RESOURCE_POOL_SCHEMA.into(),
            pool_id: "pool-preparation-retry".into(),
            generation: 1,
            resources: vec![FmsPreparationResourceOffer {
                resource_id: "cpu-preparation-retry".into(),
                budget: budget.clone(),
            }],
        };
        store.commit_preparation_resource_pool(0, &pool).unwrap();

        let now = Utc::now();
        let first_lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-preparation-retry".into(),
            budget: budget.clone(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: "prep-attempt-r0-first".into(),
            lease_token: "prep-lease-first".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        assert_eq!(
            store
                .try_commit_preparation_resource_lease_from_pool(
                    &pool.pool_id,
                    pool.generation,
                    0,
                    &first_lease,
                )
                .unwrap(),
            Some(PreparationResourceLeaseCommitDisposition::Acquired)
        );
        let launch = FmsPreparationProcessLaunch {
            schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "prep-launch-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: first_lease.preparation_attempt_id.clone(),
            resource_id: first_lease.resource_id.clone(),
            lease_token: first_lease.lease_token.clone(),
            lease_heartbeat_sequence: 0,
            supervisor_process_id: 41,
            supervisor_start_token: Some("supervisor-first".into()),
            created_at: now,
        };
        store.commit_preparation_process_launch(&launch).unwrap();
        let failed_exit = FmsPreparationProcessExitReceipt {
            schema_version: FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "prep-exit-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: first_lease.preparation_attempt_id.clone(),
            resource_id: first_lease.resource_id.clone(),
            lease_token: first_lease.lease_token.clone(),
            lease_heartbeat_sequence: 0,
            process_id: 42,
            process_start_token: Some("preparer-first".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            failure_reason: Some("fixture failure".into()),
            observed_at: now,
        };
        store
            .commit_preparation_process_exit_receipt(&failed_exit)
            .unwrap();
        assert_eq!(
            store
                .finalize_preparation_process_exit(&failed_exit)
                .unwrap(),
            PreparationProcessFinalizationDisposition::Failed
        );
        assert_eq!(
            store
                .preparation_attempt_authorization_sequence(run_id, task_id)
                .unwrap(),
            None
        );

        let decision = FmsPreparationRetryDecision {
            schema_version: FMS_PREPARATION_RETRY_DECISION_SCHEMA.into(),
            decision_id: "prep-retry-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            failed_preparation_attempt_id: first_lease.preparation_attempt_id.clone(),
            retry_sequence: 1,
            max_attempts: 2,
            reason: "operator approved one retry".into(),
            created_at: Utc::now(),
        };
        assert_eq!(
            store.commit_preparation_retry_decision(&decision).unwrap(),
            PreparationRetryDecisionCommitDisposition::Accepted
        );
        let mut replay = decision.clone();
        replay.created_at += chrono::Duration::seconds(1);
        assert_eq!(
            store.commit_preparation_retry_decision(&replay).unwrap(),
            PreparationRetryDecisionCommitDisposition::Replayed
        );
        assert_eq!(
            store
                .preparation_attempt_authorization_sequence(run_id, task_id)
                .unwrap(),
            Some(1)
        );

        let second_now = Utc::now();
        let second_lease = FmsPreparationResourceLease {
            preparation_attempt_id: "prep-attempt-r1-second".into(),
            lease_token: "prep-lease-second".into(),
            acquired_at: second_now,
            heartbeat_at: second_now,
            ..first_lease
        };
        assert!(
            store
                .try_commit_preparation_resource_lease_from_pool(
                    &pool.pool_id,
                    pool.generation,
                    0,
                    &second_lease,
                )
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .try_commit_preparation_resource_lease_from_pool(
                    &pool.pool_id,
                    pool.generation,
                    1,
                    &second_lease,
                )
                .unwrap(),
            Some(PreparationResourceLeaseCommitDisposition::Acquired)
        );
        let report = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Export,
        )
        .unwrap();
        assert!(report.file_refs.contains(
            "runs/run-preparation-retry/preparation_retry_decisions/prep-retry-first.json"
        ));
    }

    #[test]
    fn scheduler_resource_pool_is_generation_fenced_and_allows_empty_membership() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let empty = FmsSchedulerResourcePool {
            schema_version: FMS_SCHEDULER_RESOURCE_POOL_SCHEMA.into(),
            pool_id: "pool-dynamic".into(),
            generation: 1,
            resources: Vec::new(),
        };
        assert_eq!(
            store.commit_scheduler_resource_pool(0, &empty).unwrap(),
            SchedulerResourcePoolCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_scheduler_resource_pool(0, &empty).unwrap(),
            SchedulerResourcePoolCommitDisposition::Replayed
        );
        assert_eq!(
            store.read_scheduler_resource_pool("pool-dynamic").unwrap(),
            Some(empty.clone())
        );

        let populated = FmsSchedulerResourcePool {
            generation: 2,
            resources: vec![FmsSchedulerResourceOffer {
                resource_id: "cpu-dynamic-a".into(),
                kind: FmsResourceKind::Cpu,
                budget: FmsResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1024,
                    gpu_memory_bytes: 0,
                    storage_bytes: 4096,
                },
            }],
            ..empty.clone()
        };
        assert_eq!(
            store.commit_scheduler_resource_pool(1, &populated).unwrap(),
            SchedulerResourcePoolCommitDisposition::Accepted
        );
        let report = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Export,
        )
        .unwrap();
        assert!(
            report
                .file_refs
                .contains("scheduler_pools/pool-dynamic.resources.json")
        );
        assert!(store.commit_scheduler_resource_pool(1, &empty).is_err());

        let mut invalid = populated;
        invalid.generation = 3;
        invalid.resources[0].budget.storage_bytes = 0;
        assert!(store.commit_scheduler_resource_pool(2, &invalid).is_err());
    }

    #[test]
    fn interrupted_checkpoint_never_publishes_a_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let cp = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
        let state = CommonSolverState {
            step: 1,
            time_s: 0.0,
            dt: 1e-12,
            energies: SolverEnergies::default(),
            magnetization_ref: None,
        };
        crate::durability::fail_publication_after(1);
        assert!(store.commit_checkpoint(&cp, &state).is_err());
        assert!(store.read_document(&cp.common_state_ref).unwrap().is_some());
        assert!(store.latest_checkpoint("run-1").unwrap().is_none());
        store.commit_checkpoint(&cp, &state).unwrap();
        assert_eq!(store.latest_checkpoint("run-1").unwrap().unwrap().step, 1);
    }

    #[test]
    fn interrupted_session_pointer_preserves_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsSessionManifest::new("one", "first", SaveProfile::Compact);
        store.commit_session(&first).unwrap();
        crate::durability::fail_publication_after(1);
        let second = FmsSessionManifest::new("two", "candidate", SaveProfile::Compact);
        assert!(store.commit_session(&second).is_err());
        assert_eq!(store.current_session().unwrap().unwrap().session_id, "one");
    }

    #[test]
    fn magnetization_round_trip() {
        let m = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let bytes = magnetization_to_bytes(&m);
        let m2 = magnetization_from_bytes(&bytes);
        assert_eq!(m, m2);
    }

    #[test]
    fn session_store_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();

        // No current session initially.
        assert!(store.current_session().unwrap().is_none());

        // Create and commit a session.
        let manifest = FmsSessionManifest::new("test-001", "Test Session", SaveProfile::Compact);
        store.commit_session(&manifest).unwrap();

        let loaded = store.current_session().unwrap().unwrap();
        assert_eq!(loaded.session_id, "test-001");
        assert_eq!(loaded.profile, SaveProfile::Compact);
    }

    #[test]
    fn preparation_receipt_is_bound_to_run_and_immutable() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-preparation";
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: Vec::new(),
            })
            .unwrap();

        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let payload = serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": "prep-1",
            "plan_fingerprint": plan_fingerprint,
            "certificates": []
        });
        let receipt = FmsPreparationReceipt::new(
            "prep-1",
            run_id,
            format!("sha256:{}", "a".repeat(64)),
            payload,
        );
        assert_eq!(
            store.commit_preparation_receipt(&receipt).unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_preparation_receipt(&receipt).unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        let replay_with_new_publication_timestamp = FmsPreparationReceipt::new(
            "prep-1",
            run_id,
            format!("sha256:{}", "a".repeat(64)),
            serde_json::json!({
                "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
                "preparation_id": "prep-1",
                "plan_fingerprint": format!("sha256:{}", "a".repeat(64)),
                "certificates": []
            }),
        );
        assert_eq!(
            store
                .commit_preparation_receipt(&replay_with_new_publication_timestamp)
                .unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            store.read_preparation_receipt(run_id).unwrap().unwrap(),
            receipt
        );

        let replacement = FmsPreparationReceipt::new(
            "prep-1",
            run_id,
            format!("sha256:{}", "a".repeat(64)),
            serde_json::json!({
                "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
                "preparation_id": "prep-1",
                "plan_fingerprint": format!("sha256:{}", "a".repeat(64)),
                "certificates": ["different"]
            }),
        );
        let error = store.commit_preparation_receipt(&replacement).unwrap_err();
        assert!(error.to_string().contains("immutable"));
    }

    #[test]
    fn task_preparation_receipt_is_scoped_immutable_and_replayable() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-task-preparation";
        let step_id = "step:relax";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let next_step_id = "step:field";
        let next_task_id = task_id_for_study_step(run_id, next_step_id).unwrap();
        let intent = FmsRunIntent::new(
            run_id,
            "submit-task-preparation",
            serde_json::json!({"run_id": run_id, "snapshot": "accepted"}),
        );
        let specification_fingerprint =
            format!("sha256:{}", canonical_json_sha256(&intent.specification));
        store.commit_run_intent(&intent).unwrap();
        let input_fingerprint = "b".repeat(64);
        let next_input_fingerprint = "c".repeat(64);
        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let problem_fingerprint = format!("sha256:{}", "c".repeat(64));
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![
                    FmsTaskCatalogEntry {
                        task_id: task_id.clone(),
                        input_fingerprint: input_fingerprint.clone(),
                        lifecycle: FmsTaskLifecycle::Accepted,
                        readiness: FmsTaskReadiness::Blocked {
                            reason: "awaiting dependencies".into(),
                        },
                        observation: None,
                        attempt_id: None,
                        ownership_epoch: None,
                        resolved_input_fingerprint: None,
                        artifact_ids: Vec::new(),
                        resource_id: None,
                        coordinator_watermark: None,
                        coordinator_genesis: None,
                    },
                    FmsTaskCatalogEntry {
                        task_id: next_task_id.clone(),
                        input_fingerprint: next_input_fingerprint.clone(),
                        lifecycle: FmsTaskLifecycle::Accepted,
                        readiness: FmsTaskReadiness::Blocked {
                            reason: "awaiting dependencies".into(),
                        },
                        observation: None,
                        attempt_id: None,
                        ownership_epoch: None,
                        resolved_input_fingerprint: None,
                        artifact_ids: Vec::new(),
                        resource_id: None,
                        coordinator_watermark: None,
                        coordinator_genesis: None,
                    },
                ],
            })
            .unwrap();

        let payload = accepted_task_preparation_payload(
            run_id,
            step_id,
            &format!("prep-{task_id}"),
            &plan_fingerprint,
            &problem_fingerprint,
            &specification_fingerprint,
        );
        let run_anchor = FmsPreparationReceipt::new(
            format!("prep-{task_id}"),
            run_id,
            plan_fingerprint.clone(),
            payload.clone(),
        );
        assert_eq!(
            store.commit_preparation_receipt(&run_anchor).unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        let receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            payload,
        )
        .unwrap();
        assert_eq!(
            store.commit_task_preparation_receipt(&receipt).unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        let replay = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            accepted_task_preparation_payload(
                run_id,
                step_id,
                &format!("prep-{task_id}"),
                &plan_fingerprint,
                &problem_fingerprint,
                &specification_fingerprint,
            ),
        )
        .unwrap();
        assert_eq!(
            store.commit_task_preparation_receipt(&replay).unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            store
                .read_task_preparation_receipt(run_id, &task_id)
                .unwrap()
                .unwrap(),
            receipt
        );

        let stage_receipt =
            FmsAcceptedStagePreparationReceipt::from_task_receipt(&receipt).unwrap();
        assert_eq!(
            store
                .commit_accepted_stage_preparation_receipt(&stage_receipt)
                .unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            store
                .commit_accepted_stage_preparation_receipt(&stage_receipt)
                .unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            store
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .unwrap()
                .unwrap(),
            stage_receipt
        );
        let mut mismatched_stage = stage_receipt.clone();
        mismatched_stage.input_fingerprint = "d".repeat(64);
        assert!(
            store
                .commit_accepted_stage_preparation_receipt(&mismatched_stage)
                .unwrap_err()
                .to_string()
                .contains("immutable task preparation receipt")
        );

        let next_plan_fingerprint = format!("sha256:{}", "d".repeat(64));
        let next_problem_fingerprint = format!("sha256:{}", "e".repeat(64));
        let next_receipt = FmsTaskPreparationReceipt::new(
            run_id,
            next_step_id,
            next_input_fingerprint,
            format!("prep-{next_task_id}"),
            next_plan_fingerprint.clone(),
            accepted_task_preparation_payload(
                run_id,
                next_step_id,
                &format!("prep-{next_task_id}"),
                &next_plan_fingerprint,
                &next_problem_fingerprint,
                &specification_fingerprint,
            ),
        )
        .unwrap();
        store
            .commit_task_preparation_receipt(&next_receipt)
            .unwrap();
        let next_stage_receipt =
            FmsAcceptedStagePreparationReceipt::from_task_receipt(&next_receipt).unwrap();
        assert_eq!(
            store
                .commit_accepted_stage_preparation_receipt(&next_stage_receipt)
                .unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            store
                .read_accepted_stage_preparation_receipt(run_id, next_step_id)
                .unwrap()
                .unwrap(),
            next_stage_receipt
        );
        assert_eq!(
            store
                .find_accepted_stage_preparation_receipt_by_preparation_id(
                    run_id,
                    &next_stage_receipt.preparation_id,
                )
                .unwrap()
                .unwrap(),
            next_stage_receipt
        );
        assert_eq!(
            store.read_preparation_receipt(run_id).unwrap(),
            Some(run_anchor.clone())
        );
        let reopened = SessionStore::open(dir.path().join("session-store")).unwrap();
        assert_eq!(
            reopened.read_preparation_receipt(run_id).unwrap(),
            Some(run_anchor.clone())
        );
        assert_eq!(
            reopened
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .unwrap(),
            Some(stage_receipt.clone())
        );
        assert_eq!(
            reopened
                .read_accepted_stage_preparation_receipt(run_id, next_step_id)
                .unwrap(),
            Some(next_stage_receipt.clone())
        );
        assert_eq!(
            reopened
                .commit_accepted_stage_preparation_receipt(&stage_receipt)
                .unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            reopened
                .commit_accepted_stage_preparation_receipt(&next_stage_receipt)
                .unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            reopened
                .find_accepted_stage_preparation_receipt_by_preparation_id(
                    run_id,
                    &stage_receipt.preparation_id,
                )
                .unwrap(),
            Some(stage_receipt.clone())
        );
        let stage_path = reopened.root().join(stage_receipt.relative_path().unwrap());
        let original_stage_bytes = fs::read(&stage_path).unwrap();
        let mut tampered_stage: serde_json::Value =
            serde_json::from_slice(&original_stage_bytes).unwrap();
        tampered_stage["plan_fingerprint"] =
            serde_json::json!(format!("sha256:{}", "f".repeat(64)));
        fs::write(
            &stage_path,
            serde_json::to_vec_pretty(&tampered_stage).unwrap(),
        )
        .unwrap();
        assert!(
            reopened
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .is_err()
        );
        fs::write(&stage_path, original_stage_bytes).unwrap();
        assert_eq!(
            reopened
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .unwrap(),
            Some(stage_receipt)
        );
        let reachability = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Export,
        )
        .unwrap();
        assert!(reachability.file_refs.contains(&format!(
            "runs/{run_id}/accepted_stage_preparation_receipts/{next_task_id}.json"
        )));

        let mut replacement_payload = accepted_task_preparation_payload(
            run_id,
            step_id,
            &format!("prep-{task_id}"),
            &plan_fingerprint,
            &problem_fingerprint,
            &specification_fingerprint,
        );
        replacement_payload["certificates"] = serde_json::json!(["different"]);
        let replacement = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            replacement_payload,
        )
        .unwrap();
        assert!(
            store
                .commit_task_preparation_receipt(&replacement)
                .unwrap_err()
                .to_string()
                .contains("immutable")
        );

        let replacement_payload = serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": format!("prep-{task_id}"),
            "plan_fingerprint": plan_fingerprint,
            "plan": {
                "schema_version": "preparation_plan.v2",
                "problem_fingerprint": problem_fingerprint,
                "source": {
                    "kind": "accepted_run_step",
                    "run_id": run_id,
                    "specification_fingerprint": specification_fingerprint,
                    "step_id": step_id
                }
            },
            "accepted_run_source": {
                "schema_version": "accepted_run_preparation_source.v1",
                "run_id": run_id,
                "specification_fingerprint": specification_fingerprint,
                "step_id": step_id,
                "problem_fingerprint": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            },
            "certificates": []
        });
        assert!(
            FmsTaskPreparationReceipt::new(
                run_id,
                step_id,
                input_fingerprint,
                format!("prep-{task_id}"),
                receipt.plan_fingerprint.clone(),
                replacement_payload,
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn accepted_stage_receipt_rejects_fifo_and_symlink_task_sources() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-stage-reader";
        let step_id = "step:mesh";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let intent = FmsRunIntent::new(
            run_id,
            "stage-reader",
            serde_json::json!({"run_id": run_id, "snapshot": "accepted"}),
        );
        let specification_fingerprint =
            format!("sha256:{}", canonical_json_sha256(&intent.specification));
        store.commit_run_intent(&intent).unwrap();
        let input_fingerprint = "b".repeat(64);
        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let problem_fingerprint = format!("sha256:{}", "c".repeat(64));
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: input_fingerprint.clone(),
                    lifecycle: FmsTaskLifecycle::Accepted,
                    readiness: FmsTaskReadiness::Blocked {
                        reason: "awaiting dependencies".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint,
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            accepted_task_preparation_payload(
                run_id,
                step_id,
                &format!("prep-{task_id}"),
                &plan_fingerprint,
                &problem_fingerprint,
                &specification_fingerprint,
            ),
        )
        .unwrap();
        store.commit_task_preparation_receipt(&receipt).unwrap();
        let stage_receipt =
            FmsAcceptedStagePreparationReceipt::from_task_receipt(&receipt).unwrap();
        store
            .commit_accepted_stage_preparation_receipt(&stage_receipt)
            .unwrap();

        let stage_path = store.root().join(stage_receipt.relative_path().unwrap());
        let task_path = store.root().join(receipt.relative_path().unwrap());
        let stage_bytes = fs::read(&stage_path).unwrap();
        let task_bytes = fs::read(&task_path).unwrap();
        let make_fifo = |path: &std::path::Path| {
            let name = CString::new(path.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        };

        fs::remove_file(&stage_path).unwrap();
        make_fifo(&stage_path);
        assert!(
            store
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .is_err()
        );
        fs::remove_file(&stage_path).unwrap();
        fs::write(&stage_path, &stage_bytes).unwrap();

        let stage_target = dir.path().join("stage-receipt-target.json");
        fs::write(&stage_target, &stage_bytes).unwrap();
        fs::remove_file(&stage_path).unwrap();
        symlink(&stage_target, &stage_path).unwrap();
        assert!(
            store
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .is_err()
        );
        fs::remove_file(&stage_path).unwrap();
        fs::write(&stage_path, &stage_bytes).unwrap();

        fs::remove_file(&task_path).unwrap();
        make_fifo(&task_path);
        assert!(
            store
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .is_err()
        );
        fs::remove_file(&task_path).unwrap();
        fs::write(&task_path, &task_bytes).unwrap();

        let task_target = dir.path().join("task-receipt-target.json");
        fs::write(&task_target, &task_bytes).unwrap();
        fs::remove_file(&task_path).unwrap();
        symlink(&task_target, &task_path).unwrap();
        assert!(
            store
                .read_accepted_stage_preparation_receipt(run_id, step_id)
                .is_err()
        );
    }

    pub(super) fn accepted_task_preparation_payload(
        run_id: &str,
        step_id: &str,
        preparation_id: &str,
        plan_fingerprint: &str,
        problem_fingerprint: &str,
        specification_fingerprint: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": preparation_id,
            "plan_fingerprint": plan_fingerprint,
            "plan": {
                "schema_version": "preparation_plan.v2",
                "problem_fingerprint": problem_fingerprint,
                "source": {
                    "kind": "accepted_run_step",
                    "run_id": run_id,
                    "specification_fingerprint": specification_fingerprint,
                    "step_id": step_id
                }
            },
            "accepted_run_source": {
                "schema_version": "accepted_run_preparation_source.v1",
                "run_id": run_id,
                "specification_fingerprint": specification_fingerprint,
                "step_id": step_id,
                "problem_fingerprint": problem_fingerprint
            },
            "certificates": []
        })
    }

    #[test]
    fn checkpoint_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();

        let run = FmsRunManifest {
            run_id: "run-001".into(),
            status: RunStatus::Running,
            study_kind: "time_evolution".into(),
            backend: "cpu".into(),
            precision: "f64".into(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            total_steps: 0,
            total_time_s: 0.0,
            plan_ref: None,
            live_state_ref: None,
            latest_checkpoint_ref: None,
            artifact_index_ref: None,
        };
        store.commit_run(&run).unwrap();

        // Store magnetization and create checkpoint.
        let m = vec![[1.0, 0.0, 0.0]; 100];
        let m_hash = store.store_magnetization(&m).unwrap();

        let cp = FmsCheckpoint::new("run-001", 42, 1e-9, 1e-13);
        let state = CommonSolverState {
            step: 42,
            time_s: 1e-9,
            dt: 1e-13,
            energies: SolverEnergies::default(),
            magnetization_ref: Some(m_hash.clone()),
        };
        store.commit_checkpoint(&cp, &state).unwrap();

        let latest = store.latest_checkpoint("run-001").unwrap().unwrap();
        assert_eq!(latest.step, 42);

        // Load magnetization back.
        let loaded_m = store.load_magnetization(&m_hash).unwrap().unwrap();
        assert_eq!(loaded_m.len(), 100);
        assert_eq!(loaded_m[0], [1.0, 0.0, 0.0]);
    }

    #[test]
    fn delete_checkpoint_is_idempotent_refuses_referenced_and_leaves_cas_to_gc() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let mut run = FmsRunManifest {
            run_id: "run-001".into(),
            status: RunStatus::Running,
            study_kind: "time_evolution".into(),
            backend: "cpu".into(),
            precision: "f64".into(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            total_steps: 0,
            total_time_s: 0.0,
            plan_ref: None,
            live_state_ref: None,
            latest_checkpoint_ref: None,
            artifact_index_ref: None,
        };
        store.commit_run(&run).unwrap();
        let m_hash = store
            .store_magnetization(&vec![[1.0, 0.0, 0.0]; 8])
            .unwrap();
        let cp = FmsCheckpoint::new("run-001", 42, 1e-9, 1e-13);
        let state = CommonSolverState {
            step: 42,
            time_s: 1e-9,
            dt: 1e-13,
            energies: SolverEnergies::default(),
            magnetization_ref: Some(m_hash.clone()),
        };
        store.commit_checkpoint(&cp, &state).unwrap();

        // The run manifest names it as the latest checkpoint: refuse, keep it.
        run.latest_checkpoint_ref = Some(format!(
            "runs/run-001/checkpoints/{}/checkpoint.json",
            cp.checkpoint_id
        ));
        store.commit_run(&run).unwrap();
        let refused = store
            .delete_checkpoint("run-001", &cp.checkpoint_id)
            .unwrap_err();
        assert!(
            refused
                .downcast_ref::<CheckpointStillReferenced>()
                .is_some()
        );
        assert_eq!(store.list_checkpoints("run-001").unwrap().len(), 1);

        // Ingest pins retire once the checkpoint root proves the object.
        store.release_published_pins().unwrap();
        run.latest_checkpoint_ref = None;
        store.commit_run(&run).unwrap();
        assert!(!store.delete_checkpoint("run-001", "cp-unknown").unwrap());
        assert!(
            store
                .delete_checkpoint("run-001", &cp.checkpoint_id)
                .unwrap()
        );
        assert!(
            !store
                .delete_checkpoint("run-001", &cp.checkpoint_id)
                .unwrap()
        );
        assert!(store.list_checkpoints("run-001").unwrap().is_empty());
        // The CAS object is not removed directly; GC finds it unreferenced.
        assert!(store.load_magnetization(&m_hash).unwrap().is_some());
        assert!(store.gc_preview().unwrap().candidates.contains(&m_hash));
    }

    #[test]
    fn durable_resource_lease_is_fenced_and_explicitly_released() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-lease".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-lease".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Running,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Live),
                    attempt_id: Some("attempt-lease".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some("gpu-0".into()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "gpu-0".into(),
            kind: FmsResourceKind::Gpu,
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: 1,
                storage_bytes: 1,
            },
            run_id: "run-lease".into(),
            task_id: "task-lease".into(),
            attempt_id: "attempt-lease".into(),
            ownership_epoch: 1,
            lease_token: "lease-one".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        assert_eq!(
            store.commit_resource_lease(&lease).unwrap(),
            ResourceLeaseCommitDisposition::Acquired
        );
        assert_eq!(
            store.commit_resource_lease(&lease).unwrap(),
            ResourceLeaseCommitDisposition::Replayed
        );

        let mut heartbeat = lease.clone();
        heartbeat.heartbeat_sequence = 1;
        heartbeat.heartbeat_at = chrono::Utc::now();
        store.heartbeat_resource_lease(&heartbeat).unwrap();
        assert!(store.heartbeat_resource_lease(&lease).is_err());

        store.release_resource_lease(&heartbeat).unwrap();
        let mut next = lease;
        next.lease_token = "lease-two".into();
        next.acquired_at = chrono::Utc::now();
        next.heartbeat_at = next.acquired_at;
        assert_eq!(
            store.commit_resource_lease(&next).unwrap(),
            ResourceLeaseCommitDisposition::Acquired
        );
    }

    #[test]
    fn durable_retry_decision_is_fenced_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-retry".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-retry".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Reconciling),
                    attempt_id: Some("attempt-retry".into()),
                    ownership_epoch: Some(3),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let decision = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-retry".into(),
            run_id: "run-retry".into(),
            task_id: "task-retry".into(),
            attempt_id: "attempt-retry".into(),
            ownership_epoch: 3,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "worker disconnected after reconciliation".into(),
            created_at: now,
        };
        assert_eq!(
            store.commit_retry_decision(&decision).unwrap(),
            RetryDecisionCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_retry_decision(&decision).unwrap(),
            RetryDecisionCommitDisposition::Replayed
        );
        let loaded = store
            .read_retry_decision("run-retry", "decision-retry")
            .unwrap()
            .unwrap();
        assert_eq!(loaded, decision);
        assert_eq!(
            store.list_retry_decisions("run-retry").unwrap(),
            vec![decision.clone()]
        );
        let mut stale = decision.clone();
        stale.decision_id = "decision-stale".into();
        stale.ownership_epoch = 2;
        assert!(store.commit_retry_decision(&stale).is_err());
    }

    #[test]
    fn artifact_catalog_retains_prior_attempts_and_rejects_late_study_output() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-artifact-retry";
        let step_id = "relax";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Reconciling),
                    attempt_id: Some("attempt-one".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let old_bytes = b"failed-attempt diagnostic";
        let old_object = store.cas().put(old_bytes).unwrap();
        let old_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-old-log".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/worker.log"),
            artifact_type: "log".into(),
            content_sha256: old_object.clone(),
            object_ref: Some(old_object),
            status: FmsArtifactStatus::Published,
            required: false,
            study_output: None,
        };
        store
            .commit_artifact_catalog(&FmsArtifactCatalog {
                schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                entries: vec![old_entry.clone()],
            })
            .unwrap();

        let premature_output = FmsArtifactCatalogEntry {
            artifact_id: "artifact-premature-output".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/state/default.bin"),
            artifact_type: "state".into(),
            content_sha256: old_entry.content_sha256.clone(),
            object_ref: old_entry.object_ref.clone(),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "final_state".into(),
                case_id: "default".into(),
            }),
        };
        assert!(
            store
                .commit_artifact_catalog(&FmsArtifactCatalog {
                    schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
                    run_id: run_id.into(),
                    revision: 2,
                    updated_at: chrono::Utc::now(),
                    entries: vec![old_entry.clone(), premature_output],
                })
                .is_err()
        );

        let retry = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-artifact-retry".into(),
            run_id: run_id.into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "worker disconnected after reconciliation".into(),
            created_at: chrono::Utc::now(),
        };
        assert_eq!(
            store.apply_retry_decision(&retry).unwrap(),
            RetryDecisionApplyDisposition::Applied
        );
        let mut run_catalog = store.read_run_catalog(run_id).unwrap().unwrap();
        run_catalog.tasks[0].attempt_id = Some("attempt-two".into());
        run_catalog.tasks[0].ownership_epoch = Some(2);
        run_catalog.tasks[0].lifecycle = FmsTaskLifecycle::Succeeded;
        run_catalog.revision += 1;
        run_catalog.updated_at = chrono::Utc::now();
        store.commit_run_catalog(&run_catalog).unwrap();

        let output_bytes = b"successful final state";
        let output_object = store.cas().put(output_bytes).unwrap();
        let output_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-final-state-attempt-two".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-two".into(),
            ownership_epoch: 2,
            logical_path: format!("outputs/{task_id}/attempt-two/state/default.bin"),
            artifact_type: "state".into(),
            content_sha256: output_object.clone(),
            object_ref: Some(output_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "final_state".into(),
                case_id: "default".into(),
            }),
        };
        let complete_catalog = FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 2,
            updated_at: chrono::Utc::now(),
            entries: vec![old_entry.clone(), output_entry.clone()],
        };
        store.commit_artifact_catalog(&complete_catalog).unwrap();
        assert_eq!(
            store
                .read_artifact_catalog(run_id)
                .unwrap()
                .unwrap()
                .entries,
            vec![old_entry.clone(), output_entry]
        );

        let stale_bytes = b"late stale output";
        let stale_object = store.cas().put(stale_bytes).unwrap();
        let stale_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-late-output".into(),
            task_id,
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/stale.bin".into(),
            artifact_type: "state".into(),
            content_sha256: stale_object.clone(),
            object_ref: Some(stale_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "stale_state".into(),
                case_id: "late".into(),
            }),
        };
        let mut stale_catalog = complete_catalog;
        stale_catalog.revision += 1;
        stale_catalog.updated_at = chrono::Utc::now();
        stale_catalog.entries.push(stale_entry);
        assert!(store.commit_artifact_catalog(&stale_catalog).is_err());
        let persisted = store.read_artifact_catalog(run_id).unwrap().unwrap();
        assert_eq!(persisted.revision, 2);
        assert_eq!(persisted.entries.len(), 2);
    }

    #[test]
    fn claimed_artifact_append_is_idempotent_and_rejects_released_lease() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-claimed-artifact";
        let step_id = "relax";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let now = chrono::Utc::now();
        let mut run_catalog = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: now,
            tasks: vec![FmsTaskCatalogEntry {
                task_id: task_id.clone(),
                input_fingerprint: "a".repeat(64),
                lifecycle: FmsTaskLifecycle::Running,
                readiness: FmsTaskReadiness::Ready,
                observation: Some(FmsObservationState::Live),
                attempt_id: Some("attempt-one".into()),
                ownership_epoch: Some(1),
                resolved_input_fingerprint: None,
                artifact_ids: Vec::new(),
                resource_id: Some("cpu-artifact".into()),
                coordinator_watermark: None,
                coordinator_genesis: None,
            }],
        };
        store.commit_run_catalog(&run_catalog).unwrap();
        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-artifact".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1_000,
                memory_bytes: 0,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            run_id: run_id.into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            lease_token: "lease-artifact-output".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        store.commit_resource_lease(&lease).unwrap();
        let mut heartbeat_lease = lease.clone();
        heartbeat_lease.heartbeat_sequence = 1;
        heartbeat_lease.heartbeat_at = chrono::Utc::now();
        store.heartbeat_resource_lease(&heartbeat_lease).unwrap();

        let bytes = b"final state from the successful attempt";
        let object_ref = store.cas().put(bytes).unwrap();
        let entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-claimed-output".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/final_state/default.bin"),
            artifact_type: "state".into(),
            content_sha256: object_ref.clone(),
            object_ref: Some(object_ref),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "final_state".into(),
                case_id: "default".into(),
            }),
        };
        let published = store
            .append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
            .unwrap();
        assert_eq!(published.revision, 1);
        assert_eq!(published.entries, vec![entry.clone()]);
        let projected_task = store
            .read_run_catalog(run_id)
            .unwrap()
            .unwrap()
            .tasks
            .remove(0);
        assert_eq!(projected_task.artifact_ids, vec![entry.artifact_id.clone()]);

        let manifest = FmsStudyOutputManifest {
            schema_version: FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
            run_id: run_id.into(),
            task_id: task_id.clone(),
            step_id: step_id.into(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            accepted_state_ref: None,
            observation_source: None,
            outputs: vec![FmsStudyOutputManifestEntry {
                port_id: "final_state".into(),
                case_id: "default".into(),
                data_kind: "state".into(),
                codec_id: "fullmag-test-opaque".into(),
                codec_version: "v1".into(),
                artifact_id: entry.artifact_id.clone(),
                object_ref: entry.object_ref.clone().unwrap(),
                content_sha256: entry.content_sha256.clone(),
            }],
        };
        manifest.validate().unwrap();
        let mut previous_manifest = manifest.clone();
        previous_manifest.schema_version = FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V2.into();
        previous_manifest.validate().unwrap();
        let mut legacy_manifest = manifest.clone();
        legacy_manifest.schema_version = FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V1.into();
        legacy_manifest.validate().unwrap();
        legacy_manifest.accepted_state_ref = Some(fullmag_quantities::AcceptedStateRef {
            id: fullmag_quantities::AcceptedStateId {
                run_id: run_id.into(),
                stage_id: Some(step_id.into()),
                accepted_step: 1,
                clock_digest: format!("sha256:{}", "a".repeat(64)),
                state_digest: format!("sha256:{}", "b".repeat(64)),
                domain_digest: format!("sha256:{}", "c".repeat(64)),
                plan_digest: format!("sha256:{}", "d".repeat(64)),
            },
            generation: fullmag_quantities::AcceptedStateGeneration {
                runtime_epoch: 1,
                accepted_revision: 1,
            },
        });
        assert!(legacy_manifest.validate().is_err());
        let manifest_ref = store
            .cas()
            .put(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        let manifest_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-output-manifest".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/study-output-manifest.v1.json"),
            artifact_type: "study_output_manifest".into(),
            content_sha256: manifest_ref.clone(),
            object_ref: Some(manifest_ref),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: None,
        };
        let published = store
            .append_artifact_catalog_entries_for_lease(
                &lease,
                std::slice::from_ref(&manifest_entry),
            )
            .unwrap();
        assert_eq!(
            published.entries,
            vec![entry.clone(), manifest_entry.clone()]
        );

        let late_bytes = b"late output after manifest publication";
        let late_object = store.cas().put(late_bytes).unwrap();
        let late_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-after-manifest".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/after-manifest.bin".into(),
            artifact_type: "state".into(),
            content_sha256: late_object.clone(),
            object_ref: Some(late_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "late_state".into(),
                case_id: "late".into(),
            }),
        };
        assert!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, &[late_entry])
                .is_err()
        );

        let mut projection_gap = store.read_run_catalog(run_id).unwrap().unwrap();
        projection_gap.tasks[0].artifact_ids.clear();
        projection_gap.revision += 1;
        projection_gap.updated_at = chrono::Utc::now();
        store.commit_run_catalog(&projection_gap).unwrap();
        assert_eq!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
                .unwrap(),
            published
        );
        let mut run_catalog = store.read_run_catalog(run_id).unwrap().unwrap();
        assert_eq!(
            run_catalog.tasks[0].artifact_ids,
            vec![
                entry.artifact_id.clone(),
                manifest_entry.artifact_id.clone()
            ]
        );

        run_catalog.revision += 1;
        run_catalog.updated_at = chrono::Utc::now();
        run_catalog.tasks[0].lifecycle = FmsTaskLifecycle::Succeeded;
        store.commit_run_catalog(&run_catalog).unwrap();
        assert_eq!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
                .unwrap(),
            published
        );

        let late_bytes = b"late output after task completion";
        let late_object = store.cas().put(late_bytes).unwrap();
        let late_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-late-after-completion".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/after-completion.bin".into(),
            artifact_type: "state".into(),
            content_sha256: late_object.clone(),
            object_ref: Some(late_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "late_state".into(),
                case_id: "late".into(),
            }),
        };
        assert!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, &[late_entry])
                .is_err()
        );

        store.release_resource_lease(&heartbeat_lease).unwrap();
        let late_bytes = b"late output after lease release";
        let late_object = store.cas().put(late_bytes).unwrap();
        let late_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-late-after-release".into(),
            task_id,
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/after-release.bin".into(),
            artifact_type: "state".into(),
            content_sha256: late_object.clone(),
            object_ref: Some(late_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "late_state".into(),
                case_id: "late".into(),
            }),
        };
        assert!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, &[late_entry])
                .is_err()
        );
        assert_eq!(
            store.read_artifact_catalog(run_id).unwrap(),
            Some(published)
        );
    }

    #[test]
    fn applying_retry_decision_updates_catalog_and_replays_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-apply-retry".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-apply-retry".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Reconciling),
                    attempt_id: Some("attempt-apply-retry".into()),
                    ownership_epoch: Some(3),
                    resolved_input_fingerprint: Some("b".repeat(64)),
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let decision = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-apply-retry".into(),
            run_id: "run-apply-retry".into(),
            task_id: "task-apply-retry".into(),
            attempt_id: "attempt-apply-retry".into(),
            ownership_epoch: 3,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "worker disconnected after reconciliation".into(),
            created_at: now,
        };

        assert_eq!(
            store.apply_retry_decision(&decision).unwrap(),
            RetryDecisionApplyDisposition::Applied
        );
        let catalog = store.read_run_catalog("run-apply-retry").unwrap().unwrap();
        let task = &catalog.tasks[0];
        assert_eq!(task.lifecycle, FmsTaskLifecycle::Queued);
        assert_eq!(task.attempt_id, None);
        assert_eq!(task.ownership_epoch, Some(3));
        assert_eq!(task.resolved_input_fingerprint, None);
        assert_eq!(task.resource_id, None);
        assert_eq!(
            store.apply_retry_decision(&decision).unwrap(),
            RetryDecisionApplyDisposition::Replayed
        );
    }

    #[test]
    fn coordinator_journal_is_contiguous_idempotent_and_terminal_fenced() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-journal".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-journal".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Running,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Live),
                    attempt_id: Some("attempt-journal".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some("gpu-journal".into()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let journal_lease = test_resource_lease(
            "run-journal",
            "task-journal",
            "attempt-journal",
            1,
            "gpu-journal",
            "lease-journal",
            now,
        );
        store.commit_resource_lease(&journal_lease).unwrap();
        let payload = serde_json::json!({
            "status": "started",
            "checkpoint": {"command_sequence": 0, "event_sequence": 1}
        });
        let entry = FmsCoordinatorJournalEntry {
            schema_version: FMS_COORDINATOR_JOURNAL_SCHEMA.into(),
            entry_id: "event-one".into(),
            run_id: "run-journal".into(),
            task_id: "task-journal".into(),
            attempt_id: "attempt-journal".into(),
            ownership_epoch: 1,
            lease_token: "lease-journal".into(),
            direction: FmsCoordinatorJournalDirection::Event,
            sequence: 1,
            terminal: false,
            payload_sha256: canonical_json_sha256(&payload),
            payload,
            created_at: now,
        };
        let entry_path = store.coordinator_journal_path(&entry).unwrap();
        crate::durability::fail_directory_barrier_for(&entry_path);
        let uncertain = store.commit_coordinator_journal_entry(&entry).unwrap_err();
        assert!(
            uncertain.is::<crate::PublicationUncertain>(),
            "unexpected coordinator journal publication error: {uncertain:#}"
        );
        assert_eq!(
            store
                .read_coordinator_journal_entry(
                    "run-journal",
                    FmsCoordinatorJournalDirection::Event,
                    "event-one"
                )
                .unwrap(),
            Some(entry.clone())
        );
        // A visible matching payload cannot bypass a failed confirmation barrier.
        crate::durability::fail_directory_barrier_for(&entry_path);
        let uncertain = store.commit_coordinator_journal_entry(&entry).unwrap_err();
        assert!(uncertain.is::<crate::PublicationUncertain>());
        assert_eq!(
            store.commit_coordinator_journal_entry(&entry).unwrap(),
            CoordinatorJournalCommitDisposition::Replayed
        );

        let terminal_payload = serde_json::json!({
            "status": "failed",
            "checkpoint": {"command_sequence": 0, "event_sequence": 2}
        });
        let terminal = FmsCoordinatorJournalEntry {
            entry_id: "event-two".into(),
            sequence: 2,
            terminal: true,
            payload_sha256: canonical_json_sha256(&terminal_payload),
            payload: terminal_payload,
            ..entry.clone()
        };
        store.commit_coordinator_journal_entry(&terminal).unwrap();

        let after_terminal_payload = serde_json::json!({
            "status": "late",
            "checkpoint": {"command_sequence": 0, "event_sequence": 3}
        });
        let after_terminal = FmsCoordinatorJournalEntry {
            entry_id: "event-three".into(),
            sequence: 3,
            payload_sha256: canonical_json_sha256(&after_terminal_payload),
            payload: after_terminal_payload,
            terminal: false,
            ..entry
        };
        assert!(
            store
                .commit_coordinator_journal_entry(&after_terminal)
                .is_err()
        );
        assert_eq!(
            store
                .read_coordinator_journal_entry(
                    "run-journal",
                    FmsCoordinatorJournalDirection::Event,
                    "event-two"
                )
                .unwrap()
                .unwrap(),
            terminal
        );

        let mut catalog = store.read_run_catalog("run-journal").unwrap().unwrap();
        let mut other_task = catalog.tasks[0].clone();
        other_task.task_id = "task-other".into();
        other_task.attempt_id = Some("attempt-other".into());
        other_task.resource_id = Some("gpu-other".into());
        catalog.tasks.push(other_task);
        catalog.revision += 1;
        store.commit_run_catalog(&catalog).unwrap();
        let other_lease = test_resource_lease(
            "run-journal",
            "task-other",
            "attempt-other",
            1,
            "gpu-other",
            "lease-other",
            now,
        );
        store.commit_resource_lease(&other_lease).unwrap();
        let other_payload = serde_json::json!({
            "status": "other-started",
            "checkpoint": {"command_sequence": 0, "event_sequence": 1}
        });
        let other = FmsCoordinatorJournalEntry {
            entry_id: "event-other-one".into(),
            task_id: "task-other".into(),
            attempt_id: "attempt-other".into(),
            lease_token: "lease-other".into(),
            sequence: 1,
            payload_sha256: canonical_json_sha256(&other_payload),
            payload: other_payload,
            ..after_terminal.clone()
        };
        store.commit_coordinator_journal_entry(&other).unwrap();

        store.release_resource_lease(&journal_lease).unwrap();
        catalog.tasks[0].attempt_id = Some("attempt-retry".into());
        catalog.tasks[0].ownership_epoch = Some(2);
        catalog.revision += 1;
        store.commit_run_catalog(&catalog).unwrap();
        let retry_lease = test_resource_lease(
            "run-journal",
            "task-journal",
            "attempt-retry",
            2,
            "gpu-journal",
            "lease-retry",
            chrono::Utc::now(),
        );
        store.commit_resource_lease(&retry_lease).unwrap();
        let retry_payload = serde_json::json!({
            "status": "retry-started",
            "checkpoint": {"command_sequence": 0, "event_sequence": 1}
        });
        let retried = FmsCoordinatorJournalEntry {
            entry_id: "event-retry-one".into(),
            attempt_id: "attempt-retry".into(),
            ownership_epoch: 2,
            lease_token: "lease-retry".into(),
            sequence: 1,
            payload_sha256: canonical_json_sha256(&retry_payload),
            payload: retry_payload,
            ..after_terminal.clone()
        };
        store.commit_coordinator_journal_entry(&retried).unwrap();
        assert!(
            store
                .commit_coordinator_journal_entry(&after_terminal)
                .is_err()
        );
        store.release_resource_lease(&retry_lease).unwrap();
        assert_eq!(
            store.commit_coordinator_journal_entry(&retried).unwrap(),
            CoordinatorJournalCommitDisposition::Replayed
        );
        let after_release_payload = serde_json::json!({
            "status": "late-after-release",
            "checkpoint": {"command_sequence": 0, "event_sequence": 2}
        });
        let after_release = FmsCoordinatorJournalEntry {
            entry_id: "event-retry-after-release".into(),
            sequence: 2,
            payload_sha256: canonical_json_sha256(&after_release_payload),
            payload: after_release_payload,
            ..retried.clone()
        };
        assert!(
            store
                .commit_coordinator_journal_entry(&after_release)
                .is_err()
        );
        let changed_lease = FmsCoordinatorJournalEntry {
            entry_id: "event-retry-wrong-lease".into(),
            lease_token: "lease-forged".into(),
            sequence: 2,
            ..after_release.clone()
        };
        assert!(
            store
                .commit_coordinator_journal_entry(&changed_lease)
                .is_err()
        );
        let other_next_payload = serde_json::json!({
            "status": "other-next",
            "checkpoint": {"command_sequence": 0, "event_sequence": 2}
        });
        let other_next = FmsCoordinatorJournalEntry {
            entry_id: "event-other-two".into(),
            sequence: 2,
            payload_sha256: canonical_json_sha256(&other_next_payload),
            payload: other_next_payload,
            ..other
        };
        store.commit_coordinator_journal_entry(&other_next).unwrap();
        let reopened = SessionStore::open(dir.path().join("session-store")).unwrap();
        let snapshot = reopened.read_coordinator_journal("run-journal").unwrap();
        assert_eq!(snapshot.len(), 5);
        assert!(snapshot.contains(&terminal));
        assert!(snapshot.contains(&retried));
        assert!(snapshot.contains(&other_next));
        crate::reachability::walk_store_root(
            &store.root,
            crate::reachability::ReachabilityMode::Gc,
        )
        .unwrap();
        crate::reachability::validate_journal_streams(&snapshot).unwrap();
        let mut bad_stream = snapshot.clone();
        bad_stream.push(other_next.clone());
        assert!(crate::reachability::validate_journal_streams(&bad_stream).is_err());
        let mut changed_token = snapshot.clone();
        changed_token
            .iter_mut()
            .find(|entry| entry.entry_id == other_next.entry_id)
            .unwrap()
            .lease_token = "unexpected-token".into();
        assert!(crate::reachability::validate_journal_streams(&changed_token).is_err());
        let writer = store.write_transaction().unwrap();
        assert!(reopened.read_coordinator_journal("run-journal").is_err());
        drop(writer);
        assert_eq!(
            reopened.read_coordinator_journal("run-journal").unwrap(),
            snapshot
        );

        // A missing prefix must never be interpreted as a recoverable stream.
        fs::remove_file(
            store
                .root
                .join("runs/run-journal/coordinator_journal/event/event-one.json"),
        )
        .unwrap();
        assert!(reopened.read_coordinator_journal("run-journal").is_err());
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use super::tests::{accepted_task_preparation_payload, test_resource_lease};
    use chrono::Utc;

    fn queued_task(task_id: &str) -> FmsTaskCatalogEntry {
        FmsTaskCatalogEntry {
            task_id: task_id.into(),
            input_fingerprint: "a".repeat(64),
            lifecycle: FmsTaskLifecycle::Queued,
            readiness: FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: None,
            ownership_epoch: None,
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    fn lease(task_id: &str, attempt_id: &str, token: &str) -> FmsResourceLease {
        let now = Utc::now();
        FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-0".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: "run-admission".into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            ownership_epoch: 1,
            lease_token: token.into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        }
    }

    fn seed_catalog(store: &SessionStore, tasks: Vec<FmsTaskCatalogEntry>) {
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-admission".into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks,
            })
            .unwrap();
    }

    fn admission_record(
        task_id: &str,
        attempt_id: &str,
        lease_token: &str,
        resource_id: &str,
    ) -> FmsTaskAdmissionRecord {
        let queued_task = queued_task(task_id);
        let mut task = queued_task.clone();
        task.lifecycle = FmsTaskLifecycle::Preparing;
        task.attempt_id = Some(attempt_id.into());
        task.ownership_epoch = Some(1);
        task.resource_id = Some(resource_id.into());
        let mut lease = lease(task_id, attempt_id, lease_token);
        lease.resource_id = resource_id.into();
        FmsTaskAdmissionRecord {
            schema_version: FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: 1,
            queued_task,
            task,
            lease,
            resolved_inputs_snapshot: None,
        }
    }

    fn write_admission_record_at(
        store: &SessionStore,
        path_run_id: &str,
        path_task_id: &str,
        path_attempt_id: &str,
        record: &FmsTaskAdmissionRecord,
    ) {
        let relative =
            format!("runs/{path_run_id}/task_admissions/{path_task_id}/{path_attempt_id}.json");
        let path = crate::repository_path::create_parent(store.root(), &relative).unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(record).unwrap()).unwrap();
    }

    #[test]
    fn cancellation_blocks_new_admission_but_repairs_prior_durable_admission() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-cancel")]);
        let prior = admission_record("task-cancel", "attempt-prior", "lease-prior", "cpu-0");
        write_admission_record_at(
            &store,
            "run-admission",
            "task-cancel",
            "attempt-prior",
            &prior,
        );
        store
            .request_task_cancellation_intent(
                "run-admission",
                "task-cancel",
                "cancel-a",
                1,
                "user requested stop",
            )
            .unwrap();
        let fresh = lease("task-cancel", "attempt-new", "lease-new");
        assert!(store.commit_task_admission(&fresh).is_err());
        assert!(
            store
                .read_task_admission("run-admission", "task-cancel", "attempt-new",)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store.commit_task_admission(&prior.lease).unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );
        assert_eq!(
            store.commit_task_admission(&prior.lease).unwrap(),
            TaskAdmissionCommitDisposition::Replayed
        );
        assert!(
            store
                .read_task_cancellation_intent("run-admission", "task-cancel",)
                .unwrap()
                .is_some()
        );
        let (disposition, _, revision) = store
            .request_task_cancellation_intent(
                "run-admission",
                "task-cancel",
                "cancel-a",
                1,
                "user requested stop",
            )
            .unwrap();
        assert_eq!(
            disposition,
            crate::TaskCancellationIntentCommitDisposition::Replayed
        );
        assert_eq!(
            revision,
            store
                .read_run_catalog("run-admission")
                .unwrap()
                .unwrap()
                .revision
        );
    }

    #[test]
    fn cancellation_blocks_new_preparation_but_preserves_exact_active_replay() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        let mut task = queued_task("task-prep-cancel");
        task.lifecycle = FmsTaskLifecycle::Accepted;
        task.readiness = FmsTaskReadiness::Blocked {
            reason: FMS_TASK_AWAITING_PREPARATION_REASON.into(),
        };
        seed_catalog(&store, vec![task]);
        let now = Utc::now();
        let prior = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-prep".into(),
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: "run-admission".into(),
            task_id: "task-prep-cancel".into(),
            preparation_attempt_id: "prep-prior".into(),
            lease_token: "prep-lease".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        assert_eq!(
            store.commit_preparation_resource_lease(&prior).unwrap(),
            PreparationResourceLeaseCommitDisposition::Acquired
        );
        store
            .request_task_cancellation_intent(
                "run-admission",
                "task-prep-cancel",
                "cancel-prep",
                1,
                "user requested stop",
            )
            .unwrap();
        assert_eq!(
            store.commit_preparation_resource_lease(&prior).unwrap(),
            PreparationResourceLeaseCommitDisposition::Replayed
        );
        let mut fresh = prior.clone();
        fresh.task_id = "task-prep-new".into();
        fresh.preparation_attempt_id = "prep-new".into();
        fresh.lease_token = "prep-new-lease".into();
        fresh.resource_id = "cpu-prep-new".into();
        let mut catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        let mut new_task = catalog.tasks[0].clone();
        new_task.task_id = fresh.task_id.clone();
        catalog.tasks.push(new_task);
        catalog.revision += 1;
        store.commit_run_catalog(&catalog).unwrap();
        store
            .request_task_cancellation_intent(
                "run-admission",
                &fresh.task_id,
                "cancel-new",
                catalog.revision,
                "stop new task",
            )
            .unwrap();
        assert!(store.commit_preparation_resource_lease(&fresh).is_err());
        assert!(
            store
                .read_preparation_resource_lease(
                    "run-admission",
                    &fresh.resource_id,
                    &fresh.lease_token,
                )
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn targeted_task_admission_read_distinguishes_missing_from_corrupt() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();

        assert!(
            store
                .read_task_admission("run-admission", "task-admission-a", "attempt-a")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .reconcile_task_admission("run-admission", "task-admission-a", "attempt-a")
                .unwrap()
                .is_none()
        );

        let path = store
            .task_admission_path("run-admission", "task-admission-a", "attempt-a")
            .unwrap();
        let relative = path
            .strip_prefix(store.root())
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let path = crate::repository_path::create_parent(store.root(), &relative).unwrap();
        fs::write(path, b"not-json").unwrap();
        assert!(
            store
                .read_task_admission("run-admission", "task-admission-a", "attempt-a")
                .is_err()
        );
    }

    #[test]
    fn targeted_task_admission_read_rejects_lease_identity_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        let mut record = admission_record("task-admission-a", "attempt-a", "lease-a", "cpu-0");
        record.lease.task_id = "task-admission-other".into();
        write_admission_record_at(
            &store,
            "run-admission",
            "task-admission-a",
            "attempt-a",
            &record,
        );

        assert!(
            store
                .read_task_admission("run-admission", "task-admission-a", "attempt-a")
                .is_err()
        );
    }

    #[test]
    fn targeted_task_admission_replay_does_not_reconcile_sibling_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(
            &store,
            vec![
                queued_task("task-admission-a"),
                queued_task("task-admission-b"),
            ],
        );
        let record_a = admission_record(
            "task-admission-a",
            "attempt-admission-a",
            "lease-admission-a",
            "cpu-a",
        );
        let record_b = admission_record(
            "task-admission-b",
            "attempt-admission-b",
            "lease-admission-b",
            "cpu-b",
        );
        write_admission_record_at(
            &store,
            "run-admission",
            "task-admission-a",
            "attempt-admission-a",
            &record_a,
        );
        write_admission_record_at(
            &store,
            "run-admission",
            "task-admission-b",
            "attempt-admission-b",
            &record_b,
        );

        assert_eq!(
            store
                .reconcile_task_admission(
                    "run-admission",
                    "task-admission-a",
                    "attempt-admission-a"
                )
                .unwrap(),
            Some(TaskAdmissionCommitDisposition::Admitted)
        );
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        assert_eq!(catalog.tasks[0].lifecycle, FmsTaskLifecycle::Preparing);
        assert_eq!(catalog.tasks[1].lifecycle, FmsTaskLifecycle::Queued);
        assert!(
            store
                .read_task_admission("run-admission", "task-admission-b", "attempt-admission-b")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn worker_process_exit_receipt_is_fenced_idempotent_and_retained_after_release() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-process-exit")]);
        let claim_lease = lease(
            "task-process-exit",
            "attempt-process-exit",
            "lease-process-exit",
        );
        store.commit_task_admission(&claim_lease).unwrap();
        let receipt = FmsWorkerProcessExitReceipt {
            schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "process-exit-receipt".into(),
            run_id: "run-admission".into(),
            task_id: "task-process-exit".into(),
            attempt_id: "attempt-process-exit".into(),
            ownership_epoch: 1,
            resource_id: "cpu-0".into(),
            lease_token: "lease-process-exit".into(),
            lease_heartbeat_sequence: 0,
            process_id: 42,
            process_start_token: Some("test-process-start".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            stop_requested: false,
            failure_reason: Some("accepted worker process failed: fixture".into()),
            observed_at: Utc::now(),
        };

        assert_eq!(
            store.commit_worker_process_exit_receipt(&receipt).unwrap(),
            WorkerProcessExitReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_worker_process_exit_receipt(&receipt).unwrap(),
            WorkerProcessExitReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            store
                .list_worker_process_exit_receipts("run-admission")
                .unwrap(),
            vec![receipt.clone()]
        );
        assert_eq!(
            store
                .read_active_resource_lease_for_worker_process_exit(&receipt)
                .unwrap(),
            Some(claim_lease.clone())
        );
        let mut stale = receipt.clone();
        stale.receipt_id = "stale-process-exit-receipt".into();
        stale.lease_heartbeat_sequence = 1;
        assert!(store.commit_worker_process_exit_receipt(&stale).is_err());

        store.release_resource_lease(&claim_lease).unwrap();
        assert!(
            store
                .read_active_resource_lease_for_worker_process_exit(&receipt)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .read_worker_process_exit_receipt("run-admission", "process-exit-receipt")
                .unwrap(),
            Some(receipt)
        );
        crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Gc,
        )
        .unwrap();
    }

    #[test]
    fn task_admission_replays_and_repairs_a_missing_lease_without_new_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-admission-a")]);
        let claim_lease = lease(
            "task-admission-a",
            "attempt-admission-a",
            "lease-admission-a",
        );

        assert_eq!(
            store.commit_task_admission(&claim_lease).unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );
        let mut replay_lease = claim_lease.clone();
        replay_lease.acquired_at += chrono::Duration::seconds(1);
        replay_lease.heartbeat_at += chrono::Duration::seconds(1);
        assert_eq!(
            store.commit_task_admission(&replay_lease).unwrap(),
            TaskAdmissionCommitDisposition::Replayed
        );
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        assert_eq!(catalog.revision, 2);
        assert_eq!(catalog.tasks[0].lifecycle, FmsTaskLifecycle::Preparing);
        assert_eq!(
            catalog.tasks[0].attempt_id.as_deref(),
            Some("attempt-admission-a")
        );
        assert_eq!(
            store
                .read_active_resource_lease_for_task("run-admission", "task-admission-a")
                .unwrap(),
            Some(claim_lease.clone())
        );

        let lease_path = store.resource_lease_path(&claim_lease).unwrap();
        let canonical_temp_root = fs::canonicalize(temp.path()).unwrap();
        assert!(lease_path.starts_with(&canonical_temp_root));
        fs::remove_file(lease_path).unwrap();
        assert_eq!(
            store.reconcile_task_admissions("run-admission").unwrap(),
            vec![TaskAdmissionCommitDisposition::Replayed]
        );
        assert_eq!(
            store
                .read_active_resource_lease_for_task("run-admission", "task-admission-a")
                .unwrap(),
            Some(claim_lease)
        );
        assert_eq!(
            store
                .read_run_catalog("run-admission")
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }

    #[test]
    fn task_admission_replay_requires_identical_resolved_inputs_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-admission-a")]);
        let claim_lease = lease(
            "task-admission-a",
            "attempt-admission-a",
            "lease-admission-a",
        );
        let captured = Some(
            FmsResolvedInputsSnapshot::new(serde_json::json!({
                "optional-input": {
                    "source": "artifact-a",
                    "content_sha256": "a".repeat(64)
                }
            }))
            .unwrap(),
        );

        assert_eq!(
            store
                .commit_task_admission_with_inputs(&claim_lease, &captured)
                .unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );
        assert_eq!(
            store
                .commit_task_admission_with_inputs(&claim_lease, &captured)
                .unwrap(),
            TaskAdmissionCommitDisposition::Replayed
        );

        let changed = Some(
            FmsResolvedInputsSnapshot::new(serde_json::json!({
                "optional-input": {
                    "source": "artifact-b",
                    "content_sha256": "b".repeat(64)
                }
            }))
            .unwrap(),
        );
        assert!(
            store
                .commit_task_admission_with_inputs(&claim_lease, &changed)
                .is_err()
        );
        assert!(store.commit_task_admission(&claim_lease).is_err());
        assert_eq!(
            store
                .read_task_admission("run-admission", "task-admission-a", "attempt-admission-a")
                .unwrap()
                .unwrap()
                .resolved_inputs_snapshot,
            captured
        );
    }

    #[test]
    fn task_admission_recovery_finishes_a_persisted_intent_before_projection() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-admission-a")]);
        let mut catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        let queued = catalog.tasks.remove(0);
        let claim_lease = lease(
            "task-admission-a",
            "attempt-admission-a",
            "lease-admission-a",
        );
        let mut admitted = queued.clone();
        admitted.lifecycle = FmsTaskLifecycle::Preparing;
        admitted.readiness = FmsTaskReadiness::Ready;
        admitted.attempt_id = Some(claim_lease.attempt_id.clone());
        admitted.ownership_epoch = Some(claim_lease.ownership_epoch);
        admitted.resource_id = Some(claim_lease.resource_id.clone());
        let record = FmsTaskAdmissionRecord {
            schema_version: FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: 1,
            queued_task: queued,
            task: admitted,
            lease: claim_lease.clone(),
            resolved_inputs_snapshot: None,
        };
        record.validate().unwrap();
        let path = create_parent(
            &store.root,
            "runs/run-admission/task_admissions/task-admission-a/attempt-admission-a.json",
        )
        .unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(&record).unwrap()).unwrap();

        assert_eq!(
            store.reconcile_task_admissions("run-admission").unwrap(),
            vec![TaskAdmissionCommitDisposition::Admitted]
        );
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        assert_eq!(catalog.revision, 2);
        assert_eq!(
            catalog.tasks[0].attempt_id.as_deref(),
            Some("attempt-admission-a")
        );
        assert_eq!(
            store
                .read_active_resource_lease_for_task("run-admission", "task-admission-a")
                .unwrap(),
            Some(claim_lease)
        );
        crate::reachability::walk_store_root(
            &store.root,
            crate::reachability::ReachabilityMode::Gc,
        )
        .unwrap();
    }

    #[test]
    fn task_admission_rejects_a_busy_resource_before_claiming_another_task() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(
            &store,
            vec![
                queued_task("task-admission-a"),
                queued_task("task-admission-b"),
            ],
        );
        store
            .commit_task_admission(&lease(
                "task-admission-a",
                "attempt-admission-a",
                "lease-admission-a",
            ))
            .unwrap();

        let error = store
            .commit_task_admission(&lease(
                "task-admission-b",
                "attempt-admission-b",
                "lease-admission-b",
            ))
            .unwrap_err();
        assert!(error.to_string().contains("active lease"));
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        let second = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == "task-admission-b")
            .unwrap();
        assert_eq!(second.lifecycle, FmsTaskLifecycle::Queued);
        assert!(second.attempt_id.is_none());
        assert!(
            !store
                .task_admission_path("run-admission", "task-admission-b", "attempt-admission-b")
                .unwrap()
                .exists()
        );
    }

    #[test]
    fn import_document_file_streams_and_keeps_checkpoint_immutable() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        let source = temp.path().join("staged-document");
        let data = b"checkpoint document";
        fs::write(&source, data).unwrap();
        let hash = crate::cas::hex_sha256(data);
        let relative = "runs/run-1/checkpoints/cp-1/checkpoint.json";

        store
            .write_import_document_file(relative, &source, &hash, data.len() as u64)
            .unwrap();
        assert_eq!(store.read_document(relative).unwrap(), Some(data.to_vec()));
        assert!(
            store
                .write_import_document_file(relative, &source, &hash, data.len() as u64)
                .is_err()
        );
    }

    #[test]
    fn session_schema_guard_distinguishes_v1_and_readonly_v2_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();

        let v1 = FmsSessionManifest::new("session-v1", "Legacy", SaveProfile::Compact);
        store.commit_session(&v1).unwrap();
        assert_eq!(
            store.current_session().unwrap().unwrap().format,
            FMS_SESSION_FORMAT_V1
        );

        let mut v1_with_ref = v1.clone();
        v1_with_ref.accepted_provenance_ref = Some(FmsAcceptedProvenanceReference {
            manifest_ref: FMS_ACCEPTED_PROVENANCE_MANIFEST_REF.into(),
            accepted_run_id: "run-accepted".into(),
            closure_sha256: format!("sha256:{}", "a".repeat(64)),
        });
        assert!(store.commit_session(&v1_with_ref).is_err());

        let mut v2 = FmsSessionManifest::new("session-v2", "Evidence", SaveProfile::Compact);
        v2.format = FMS_SESSION_FORMAT_V2.into();
        v2.accepted_provenance_ref = Some(FmsAcceptedProvenanceReference {
            manifest_ref: FMS_ACCEPTED_PROVENANCE_MANIFEST_REF.into(),
            accepted_run_id: "run-accepted".into(),
            closure_sha256: format!("sha256:{}", "b".repeat(64)),
        });
        store.commit_session(&v2).unwrap();
        assert_eq!(
            store.current_session().unwrap().unwrap().format,
            FMS_SESSION_FORMAT_V2
        );

        let mut v2_without_ref = v2;
        v2_without_ref.accepted_provenance_ref = None;
        assert!(store.commit_session(&v2_without_ref).is_err());
    }

    #[test]
    fn terminal_evidence_rejects_released_solver_lease_without_exit_or_no_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-terminal-proof";
        let task_id = "task-terminal-proof";
        let now = Utc::now();
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-proof",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Queued,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let lease = test_resource_lease(
            run_id,
            task_id,
            "attempt-terminal-proof",
            1,
            "cpu-terminal-proof",
            "lease-terminal-proof",
            now,
        );
        store.commit_task_admission(&lease).unwrap();
        store.release_resource_lease(&lease).unwrap();
        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = now + chrono::Duration::seconds(1);
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        store.commit_run_catalog(&terminal).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("neither process-exit nor canonical no-spawn proof"));
    }

    #[test]
    fn terminal_evidence_rejects_admission_history_missing_from_current_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-history";
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-history",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        seed_catalog(&store, vec![queued_task(task_id)]);
        let claim = lease(
            task_id,
            "attempt-terminal-history",
            "lease-terminal-history",
        );
        store.commit_task_admission(&claim).unwrap();
        store.release_resource_lease(&claim).unwrap();

        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        let mut replacement = queued_task("task-terminal-history-replacement");
        replacement.lifecycle = FmsTaskLifecycle::Failed;
        terminal.tasks = vec![replacement];
        store.commit_run_catalog(&terminal).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("absent from the current run catalog"));
    }

    #[test]
    fn terminal_evidence_rejects_immutable_lease_field_drift() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-identity";
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-identity",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        seed_catalog(&store, vec![queued_task(task_id)]);
        let claim = lease(
            task_id,
            "attempt-terminal-identity",
            "lease-terminal-identity",
        );
        store.commit_task_admission(&claim).unwrap();
        store.release_resource_lease(&claim).unwrap();
        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        store.commit_run_catalog(&terminal).unwrap();

        let path = store.resource_lease_path(&claim).unwrap();
        let mut altered: FmsResourceLease = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        altered.budget.cpu_millis = altered.budget.cpu_millis.saturating_add(1);
        fs::write(&path, serde_json::to_vec_pretty(&altered).unwrap()).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("has 0 matching immutable task admissions"));
    }

    #[test]
    fn terminal_evidence_rejects_active_preparation_lease() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-preparation";
        let mut task = queued_task(task_id);
        task.lifecycle = FmsTaskLifecycle::Accepted;
        task.readiness = FmsTaskReadiness::Blocked {
            reason: FMS_TASK_AWAITING_PREPARATION_REASON.into(),
        };
        seed_catalog(&store, vec![task]);
        let now = Utc::now();
        let prep_lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-terminal-preparation".into(),
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: "prep-terminal-preparation".into(),
            lease_token: "prep-lease-terminal-preparation".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        assert_eq!(
            store
                .commit_preparation_resource_lease(&prep_lease)
                .unwrap(),
            PreparationResourceLeaseCommitDisposition::Acquired
        );
        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Cancelled;
        store.commit_run_catalog(&terminal).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("active preparation lease"));
    }

    #[test]
    fn terminal_evidence_rejects_orphan_task_preparation_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-terminal-orphan-prep";
        let current_task_id = "task-terminal-current";
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-orphan-prep",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: current_task_id.into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let step_id = "step:orphan";
        let orphan_task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let specification_fingerprint = format!("sha256:{}", "b".repeat(64));
        let problem_fingerprint = format!("sha256:{}", "c".repeat(64));
        let receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            "a".repeat(64),
            format!("prep-{orphan_task_id}"),
            plan_fingerprint.clone(),
            accepted_task_preparation_payload(
                run_id,
                step_id,
                &format!("prep-{orphan_task_id}"),
                &plan_fingerprint,
                &problem_fingerprint,
                &specification_fingerprint,
            ),
        )
        .unwrap();
        let relative = receipt.relative_path().unwrap();
        let path = create_parent(store.root(), &relative).unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("task preparation receipt task is missing"));
    }

    #[test]
    fn terminal_evidence_rejects_cancellation_scope_drift() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-cancellation-scope";
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-cancellation-scope",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        seed_catalog(&store, vec![queued_task(task_id)]);
        store
            .request_task_cancellation_intent(
                run_id,
                task_id,
                "cancel-terminal-cancellation-scope",
                1,
                "operator requested cancellation",
            )
            .unwrap();
        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        terminal.tasks[0].input_fingerprint = "b".repeat(64);
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        store.commit_run_catalog(&terminal).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error.to_string().contains("changed input"));
    }

    #[test]
    fn terminal_evidence_rejects_stage_receipt_without_task_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-terminal-stage";
        let step_id = "step:stage";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-stage",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let task_receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            "a".repeat(64),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            accepted_task_preparation_payload(
                run_id,
                step_id,
                &format!("prep-{task_id}"),
                &plan_fingerprint,
                &format!("sha256:{}", "c".repeat(64)),
                &format!("sha256:{}", "b".repeat(64)),
            ),
        )
        .unwrap();
        let stage = FmsAcceptedStagePreparationReceipt::from_task_receipt(&task_receipt).unwrap();
        let relative = stage.relative_path().unwrap();
        let path = create_parent(store.root(), &relative).unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(&stage).unwrap()).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("accepted stage receipt requires its immutable task receipt"));
    }

    #[test]
    fn terminal_evidence_rejects_normal_admission_input_fingerprint_drift() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-input-drift";
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-input-drift",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();
        seed_catalog(&store, vec![queued_task(task_id)]);
        let claim = lease(
            task_id,
            "attempt-terminal-input-drift",
            "lease-terminal-input-drift",
        );
        store.commit_task_admission(&claim).unwrap();
        store.release_resource_lease(&claim).unwrap();

        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        terminal.tasks[0].input_fingerprint = "b".repeat(64);
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        store.commit_run_catalog(&terminal).unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("changed immutable input fingerprint"));
    }

    #[test]
    fn terminal_evidence_rejects_orphan_solver_retry_decision() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-orphan-retry";
        let mut task = queued_task(task_id);
        task.lifecycle = FmsTaskLifecycle::Failed;
        task.attempt_id = Some("attempt-terminal-orphan-retry".into());
        task.ownership_epoch = Some(1);
        task.resource_id = Some("cpu-terminal-orphan-retry".into());
        seed_catalog(&store, vec![task]);
        let decision = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-terminal-orphan-retry".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: "attempt-terminal-orphan-retry".into(),
            ownership_epoch: 1,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "fixture orphan decision".into(),
            created_at: Utc::now(),
        };
        store.commit_retry_decision(&decision).unwrap();
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-orphan-retry",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("has 0 exact admission records"));
    }

    #[test]
    fn terminal_evidence_rejects_orphan_preparation_retry_decision() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-orphan-prep-retry";
        let mut task = queued_task(task_id);
        task.lifecycle = FmsTaskLifecycle::Failed;
        seed_catalog(&store, vec![task]);
        let decision = FmsPreparationRetryDecision {
            schema_version: FMS_PREPARATION_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-terminal-orphan-prep-retry".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            failed_preparation_attempt_id: "prep-terminal-orphan-retry".into(),
            retry_sequence: 1,
            max_attempts: 2,
            reason: "fixture orphan preparation decision".into(),
            created_at: Utc::now(),
        };
        let relative = decision.relative_path().unwrap();
        let path = create_parent(store.root(), &relative).unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(&decision).unwrap()).unwrap();
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-orphan-prep-retry",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();

        let _writer = store.write_transaction().unwrap();
        let error = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, _exit| Ok(None),
                |_lease, _exit| Ok(None),
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("has no unique failed preparation exit"));
    }

    #[test]
    fn terminal_evidence_accepts_historical_solver_retry_with_exact_exit_history() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-historical-retry";
        seed_catalog(&store, vec![queued_task(task_id)]);
        let now = Utc::now();
        let first = test_resource_lease(
            run_id,
            task_id,
            "attempt-terminal-historical-first",
            1,
            "cpu-terminal-historical-retry",
            "lease-terminal-historical-first",
            now,
        );
        store.commit_task_admission(&first).unwrap();
        let first_exit = FmsWorkerProcessExitReceipt {
            schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "exit-terminal-historical-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: first.attempt_id.clone(),
            ownership_epoch: first.ownership_epoch,
            resource_id: first.resource_id.clone(),
            lease_token: first.lease_token.clone(),
            lease_heartbeat_sequence: first.heartbeat_sequence,
            process_id: 401,
            process_start_token: Some("historical-first".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            stop_requested: false,
            failure_reason: Some("fixture first attempt failure".into()),
            observed_at: now,
        };
        store
            .commit_worker_process_exit_receipt(&first_exit)
            .unwrap();
        store.release_resource_lease(&first).unwrap();
        let mut failed_first = store.read_run_catalog(run_id).unwrap().unwrap();
        failed_first.revision += 1;
        failed_first.updated_at = Utc::now();
        failed_first.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        failed_first.tasks[0].observation = Some(FmsObservationState::Reconciling);
        store.commit_run_catalog(&failed_first).unwrap();

        let retry = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-terminal-historical-retry".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: first.attempt_id.clone(),
            ownership_epoch: first.ownership_epoch,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "fixture retry after first failure".into(),
            created_at: Utc::now(),
        };
        store.commit_retry_decision(&retry).unwrap();
        store.apply_retry_decision(&retry).unwrap();

        let second = test_resource_lease(
            run_id,
            task_id,
            "attempt-terminal-historical-second",
            2,
            "cpu-terminal-historical-retry",
            "lease-terminal-historical-second",
            Utc::now(),
        );
        store.commit_task_admission(&second).unwrap();
        let second_exit = FmsWorkerProcessExitReceipt {
            schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "exit-terminal-historical-second".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: second.attempt_id.clone(),
            ownership_epoch: second.ownership_epoch,
            resource_id: second.resource_id.clone(),
            lease_token: second.lease_token.clone(),
            lease_heartbeat_sequence: second.heartbeat_sequence,
            process_id: 402,
            process_start_token: Some("historical-second".into()),
            status_success: false,
            exit_code: Some(2),
            timed_out: false,
            stop_requested: false,
            failure_reason: Some("fixture terminal second failure".into()),
            observed_at: Utc::now(),
        };
        store
            .commit_worker_process_exit_receipt(&second_exit)
            .unwrap();
        store.release_resource_lease(&second).unwrap();
        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        store.commit_run_catalog(&terminal).unwrap();
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-historical-retry",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();

        let _writer = store.write_transaction().unwrap();
        let evidence = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, exit| Ok(exit.map(|_| "worker")),
                |_lease, exit| Ok(exit.map(|_| "preparation")),
            )
            .unwrap();
        assert_eq!(
            evidence["retry_decisions"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            evidence["worker_evidence"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn terminal_evidence_accepts_historical_preparation_retry_with_exact_exit_history() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let run_id = "run-admission";
        let task_id = "task-terminal-historical-prep-retry";
        let mut task = queued_task(task_id);
        task.lifecycle = FmsTaskLifecycle::Accepted;
        task.readiness = FmsTaskReadiness::Blocked {
            reason: FMS_TASK_AWAITING_PREPARATION_REASON.into(),
        };
        seed_catalog(&store, vec![task]);
        let now = Utc::now();
        let lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-terminal-historical-prep".into(),
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 4096,
            },
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: "prep-terminal-historical-first".into(),
            lease_token: "prep-lease-terminal-historical-first".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        store.commit_preparation_resource_lease(&lease).unwrap();
        let launch = FmsPreparationProcessLaunch {
            schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "prep-launch-terminal-historical-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: lease.preparation_attempt_id.clone(),
            resource_id: lease.resource_id.clone(),
            lease_token: lease.lease_token.clone(),
            lease_heartbeat_sequence: lease.heartbeat_sequence,
            supervisor_process_id: 501,
            supervisor_start_token: Some("historical-prep".into()),
            created_at: now,
        };
        store.commit_preparation_process_launch(&launch).unwrap();
        let exit = FmsPreparationProcessExitReceipt {
            schema_version: FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "prep-exit-terminal-historical-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            preparation_attempt_id: lease.preparation_attempt_id.clone(),
            resource_id: lease.resource_id.clone(),
            lease_token: lease.lease_token.clone(),
            lease_heartbeat_sequence: lease.heartbeat_sequence,
            process_id: 502,
            process_start_token: Some("historical-prep-child".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            failure_reason: Some("fixture preparation failure".into()),
            observed_at: now,
        };
        store.commit_preparation_process_exit_receipt(&exit).unwrap();
        assert_eq!(
            store.finalize_preparation_process_exit(&exit).unwrap(),
            PreparationProcessFinalizationDisposition::Failed
        );
        let decision = FmsPreparationRetryDecision {
            schema_version: FMS_PREPARATION_RETRY_DECISION_SCHEMA.into(),
            decision_id: "prep-retry-terminal-historical-first".into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            failed_preparation_attempt_id: lease.preparation_attempt_id.clone(),
            retry_sequence: 1,
            max_attempts: 2,
            reason: "fixture preparation retry".into(),
            created_at: Utc::now(),
        };
        store.commit_preparation_retry_decision(&decision).unwrap();
        let mut terminal = store.read_run_catalog(run_id).unwrap().unwrap();
        terminal.revision += 1;
        terminal.updated_at = Utc::now();
        terminal.tasks[0].lifecycle = FmsTaskLifecycle::Failed;
        terminal.tasks[0].readiness = FmsTaskReadiness::Ready;
        store.commit_run_catalog(&terminal).unwrap();
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id,
                "submit-terminal-historical-prep-retry",
                serde_json::json!({"run_id": run_id}),
            ))
            .unwrap();

        let _writer = store.write_transaction().unwrap();
        let evidence = store
            .terminal_run_evidence_value_locked(
                run_id,
                |_lease, exit| Ok(exit.map(|_| "worker")),
                |_lease, exit| Ok(exit.map(|_| "preparation")),
            )
            .unwrap();
        assert_eq!(
            evidence["preparation_retry_decisions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            evidence["preparation_evidence"].as_array().unwrap().len(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn exact_run_lease_reader_rejects_dangling_directory_link_as_missing_state() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let parent = store.root().join("runs/run-link");
        std::fs::create_dir_all(&parent).unwrap();
        symlink("missing-resource-leases", parent.join("resource_leases")).unwrap();
        let _writer = store.write_transaction().unwrap();
        assert!(store
            .list_resource_leases_for_run_locked("run-link")
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exact_run_lease_reader_rejects_dangling_leaf_link() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("session-store")).unwrap();
        let parent = store.root().join("runs/run-leaf-link/resource_leases/cpu");
        std::fs::create_dir_all(&parent).unwrap();
        symlink("missing-lease.json", parent.join("lease.json")).unwrap();
        let _writer = store.write_transaction().unwrap();
        assert!(store
            .list_resource_leases_for_run_locked("run-leaf-link")
            .is_err());
    }

}
