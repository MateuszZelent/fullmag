//! Typed reachability traversal for session storage and portable archives.
//!
//! A checkpoint descriptor is only a root.  The descriptor, its common state,
//! and every tensor chunk are part of the same object graph.  Keeping this
//! traversal here gives garbage collection, export, and restore the same
//! interpretation of that graph.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fullmag_quantities::SolutionSet;

use crate::archive_document::{ArchiveDocuments, ArchiveFileSnapshot};
use crate::typed_documents::{LiveSnapshotArtifactReference, LiveSnapshotArtifactReferences};
use crate::types::{
    ArtifactIndex, BackendStatePayload, CommonSolverState, FieldRole, FmsArtifactCatalog,
    FmsCheckpoint, FmsCoordinatorJournalDirection, FmsExportProfile,
    FmsPreparationProcessExitReceipt, FmsPreparationProcessLaunch, FmsPreparationReceipt,
    FmsPreparationResourceLease, FmsPreparationResourcePool, FmsPreparationRetryDecision,
    FmsResourceLease, FmsRetryDecision, FmsRunCatalog, FmsRunIntent, FmsRunManifest,
    FmsSchedulerPoolCheckpoint, FmsSchedulerResourcePool, FmsSchedulerRunSource,
    FmsSessionManifest, FmsTaskAdmissionRecord, FmsTaskPreparationReceipt,
    FmsWorkerProcessExitReceipt, FmsWorkspaceManifest, TensorDescriptor,
};

/// The same claim-scoped continuity rules apply to stores and portable archives.
pub(crate) fn validate_journal_streams(
    entries: &[crate::types::FmsCoordinatorJournalEntry],
) -> Result<()> {
    let mut streams = HashMap::new();
    for entry in entries {
        entry.validate()?;
        streams
            .entry((
                &entry.run_id,
                &entry.task_id,
                &entry.attempt_id,
                entry.ownership_epoch,
                entry.direction.as_str(),
            ))
            .or_insert_with(Vec::new)
            .push(entry);
    }
    for entries in streams.values_mut() {
        entries.sort_unstable_by_key(|entry| entry.sequence);
        let token = &entries[0].lease_token;
        let mut terminal = false;
        for (index, entry) in entries.iter().enumerate() {
            if entry.sequence != index as u64 + 1 {
                bail!("coordinator journal sequence is not contiguous within task attempt");
            }
            if &entry.lease_token != token {
                bail!("coordinator journal lease token changed within task attempt");
            }
            if terminal {
                bail!("coordinator journal contains entries after terminal event");
            }
            terminal = entry.terminal;
        }
    }
    Ok(())
}

/// The consumer of a reachability report.
///
/// The modes intentionally share the same graph walk.  They only differ in
/// what a missing referenced payload means: GC must fail closed, while an
/// archive inspection may report a downgradeable incomplete payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReachabilityMode {
    Gc,
    Export,
    Restore,
}

/// Result of traversing the persisted session graph.
#[derive(Debug, Clone, Default)]
pub struct ReachabilityReport {
    /// Validated SHA-256 object identifiers required by the graph.
    pub object_refs: HashSet<String>,
    /// Normalized store/archive-relative documents required by the graph.
    pub file_refs: HashSet<String>,
    /// Non-fatal missing payload diagnostics.  `complete == false` means the
    /// graph cannot be advertised as solved or resumable.
    pub warnings: Vec<String>,
    pub complete: bool,
    /// True when incompleteness comes only from the two known project
    /// documents whose object references are intentionally opaque today.
    pub opaque_project_documents_only: bool,
    /// Monotonic safety bit for missing payloads and unknown references.
    /// Once set, the report cannot become visualization-safe again.
    pub has_blocking_incompleteness: bool,
    /// Number of checkpoints and material primary/restart payloads proved by
    /// the walk.  These counters let archive inspection downgrade honestly
    /// instead of treating a descriptor-only checkpoint as resumable.
    pub checkpoint_count: usize,
    pub primary_payload_count: usize,
    pub restart_payload_count: usize,
    /// Per-checkpoint payload proof keyed by its normalized checkpoint path.
    pub checkpoint_status: HashMap<String, CheckpointPayloadStatus>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CheckpointPayloadStatus {
    pub primary: bool,
    pub restart: bool,
}

impl ReachabilityReport {
    fn new() -> Self {
        Self {
            complete: true,
            ..Self::default()
        }
    }

    fn missing(&mut self, message: impl Into<String>) -> Result<()> {
        let message = message.into();
        self.complete = false;
        self.has_blocking_incompleteness = true;
        self.opaque_project_documents_only = false;
        self.warnings.push(message.clone());
        Ok(())
    }

    fn mark_blocking_incomplete(&mut self, message: impl Into<String>) {
        self.complete = false;
        self.has_blocking_incompleteness = true;
        self.opaque_project_documents_only = false;
        self.warnings.push(message.into());
    }

    fn mark_opaque_project_document(&mut self, message: impl Into<String>) {
        self.complete = false;
        if !self.has_blocking_incompleteness {
            self.opaque_project_documents_only = true;
        }
        self.warnings.push(message.into());
    }

    fn conservative(&mut self, message: impl Into<String>) {
        self.mark_blocking_incomplete(message);
    }

    /// Refuse to publish a graph which is missing a required payload.
    pub fn require_complete(&self) -> Result<()> {
        if self.complete {
            return Ok(());
        }
        bail!(
            "incomplete session object graph: {}",
            self.warnings.join("; ")
        )
    }

    /// Allow only the known opaque project documents during a read-only
    /// visualization import. Missing files, checkpoint payloads, and unknown
    /// references remain fail-closed.
    pub fn require_visualization_safe(&self) -> Result<()> {
        if self.complete
            || (self.opaque_project_documents_only && !self.has_blocking_incompleteness)
        {
            return Ok(());
        }
        bail!(
            "incomplete session object graph: {}",
            self.warnings.join("; ")
        )
    }
}

/// Validate and normalize a CAS object identifier.
pub fn validate_object_ref(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        bail!("invalid CAS object reference `{value}`")
    }
    Ok(())
}

/// Validate a repository/archive-relative document reference.
pub fn validate_file_ref(value: &str) -> Result<()> {
    crate::repository_path::validate_relative_path(value)
        .with_context(|| format!("unsafe session document reference `{value}`"))
}

fn register_materialized_dataset_revision(
    revisions: &mut BTreeSet<(String, u64)>,
    manifest: &crate::materialized_dataset::MaterializedDatasetManifest,
) -> Result<()> {
    let key = (manifest.dataset.dataset_id.clone(), manifest.dataset.revision);
    if !revisions.insert(key) {
        bail!("materialized dataset revision is duplicated in the containing SolutionSet");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunPathKind {
    KnownRecord,
    OpaqueArtifact,
    Unknown,
}

const KNOWN_RUN_RECORDS: &[&str] = &[
    "run_manifest.json",
    "run_intent.json",
    "run_catalog.json",
    "artifact_catalog.json",
    "preparation_receipt.json",
];

const KNOWN_CHECKPOINT_RECORDS: &[&str] = &[
    "checkpoint.json",
    "common_state.json",
    "backend_state.json",
    "integrator_state.json",
    "rng_state.json",
];

fn is_json_record_name(value: &str) -> bool {
    value
        .strip_suffix(".json")
        .filter(|stem| !stem.is_empty())
        .is_some_and(|stem| validate_component(stem).is_ok())
}

/// Classify a file below `runs/` before any typed parser sees it.  This is
/// intentionally shared by the directory and archive walkers: adding a new
/// producer record requires an explicit namespace entry here before GC/export
/// may claim a complete graph.
fn classify_run_path(relative: &str) -> Result<RunPathKind> {
    let Some(rest) = relative.strip_prefix("runs/") else {
        bail!("run namespace path does not start with `runs/`: `{relative}`")
    };
    let Some((run_id, tail)) = rest.split_once('/') else {
        validate_component(rest)
            .with_context(|| format!("invalid run namespace identity in `{relative}`"))?;
        bail!("reserved run namespace container must be a directory: `{relative}`")
    };
    validate_component(run_id)
        .with_context(|| format!("invalid run namespace identity in `{relative}`"))?;

    let parts = tail.split('/').collect::<Vec<_>>();
    if is_reserved_run_container(&parts) {
        bail!("reserved run namespace container must be a directory: `{relative}`")
    }
    if tail == "artifacts" || tail.starts_with("artifacts/") {
        return Ok(RunPathKind::OpaqueArtifact);
    }

    let kind = if parts.len() == 1 && KNOWN_RUN_RECORDS.contains(&parts[0]) {
        RunPathKind::KnownRecord
    } else if parts.len() == 3
        && parts[0] == "checkpoints"
        && !parts[1].is_empty()
        && validate_component(parts[1]).is_ok()
        && KNOWN_CHECKPOINT_RECORDS.contains(&parts[2])
    {
        RunPathKind::KnownRecord
    } else if parts.len() == 2
        && matches!(
            parts[0],
            "task_preparation_receipts"
                | "worker_inbox"
                | "retry_decisions"
                | "preparation_retry_decisions"
                | "worker_process_exit_receipts"
                | "preparation_process_exit_receipts"
                | "preparation_process_launches"
        )
        && is_json_record_name(parts[1])
    {
        RunPathKind::KnownRecord
    } else if parts.len() == 3
        && matches!(parts[0], "resource_leases" | "preparation_resource_leases")
        && !parts[1].is_empty()
        && validate_component(parts[1]).is_ok()
        && is_json_record_name(parts[2])
    {
        RunPathKind::KnownRecord
    } else if parts.len() == 3
        && parts[0] == "task_admissions"
        && !parts[1].is_empty()
        && validate_component(parts[1]).is_ok()
        && is_json_record_name(parts[2])
    {
        RunPathKind::KnownRecord
    } else if parts.len() == 3
        && parts[0] == "coordinator_journal"
        && matches!(parts[1], "command" | "event")
        && is_json_record_name(parts[2])
    {
        RunPathKind::KnownRecord
    } else {
        RunPathKind::Unknown
    };
    Ok(kind)
}

fn is_reserved_run_container(parts: &[&str]) -> bool {
    match parts {
        [name]
            if matches!(
                *name,
                "artifacts"
                    | "checkpoints"
                    | "worker_inbox"
                    | "task_preparation_receipts"
                    | "retry_decisions"
                    | "preparation_retry_decisions"
                    | "worker_process_exit_receipts"
                    | "preparation_process_exit_receipts"
                    | "preparation_process_launches"
                    | "resource_leases"
                    | "preparation_resource_leases"
                    | "task_admissions"
                    | "coordinator_journal"
            ) => true,
        [container, _]
            if matches!(
                *container,
                "checkpoints"
                    | "resource_leases"
                    | "preparation_resource_leases"
                    | "task_admissions"
                    | "coordinator_journal"
            ) => true,
        _ => false,
    }
}

/// Walk a directory-backed session store.
///
/// The walker is deliberately conservative.  A malformed recognized root is
/// an error; a missing payload is represented as an incomplete report for
/// archive inspection and export, but GC receives an error and therefore
/// cannot sweep on an uncertain mark set.
pub fn walk_store_root(root: &Path, mode: ReachabilityMode) -> Result<ReachabilityReport> {
    let root = fs::canonicalize(root)
        .with_context(|| format!("canonicalizing session store {}", root.display()))?;
    let mut walker = StoreWalker {
        root,
        mode,
        report: ReachabilityReport::new(),
        seen_files: HashSet::new(),
        seen_checkpoints: HashSet::new(),
        tensor_descriptor_cache: None,
        namespace_files: HashSet::new(),
        unclassified_paths: HashSet::new(),
    };
    walker.walk_store()
}

/// Walk the documents already read from a portable `.fms` archive.
///
/// This function is also used by `preflight_fms`, before any destination store
/// is opened or mutated.  It accepts the archive's exact bytes so export and
/// restore do not develop a second, descriptor-only interpretation.
pub fn walk_archive_documents(
    documents: &HashMap<String, Vec<u8>>,
    mode: ReachabilityMode,
) -> Result<ReachabilityReport> {
    let mut walker = ArchiveWalker {
        documents: ArchiveDocuments::Memory(documents),
        cas_root: None,
        mode,
        report: ReachabilityReport::new(),
        seen_checkpoints: HashSet::new(),
        tensor_descriptor_cache: None,
        namespace_files: HashSet::new(),
        unclassified_paths: HashSet::new(),
    };
    walker.walk_archive()
}

/// Traverse a metadata-only export inventory with lazy typed document reads.
pub(crate) fn walk_export_file_documents(
    documents: &HashMap<String, ArchiveFileSnapshot>,
    root: &Path,
) -> Result<ReachabilityReport> {
    if documents.keys().any(|name| name.starts_with("objects/")) {
        bail!("file-backed export documents cannot shadow CAS objects");
    }
    let root = fs::canonicalize(root)?;
    let mut walker = ArchiveWalker {
        documents: ArchiveDocuments::Files { snapshots: documents, root: &root },
        cas_root: Some(&root),
        mode: ReachabilityMode::Export,
        report: ReachabilityReport::new(),
        seen_checkpoints: HashSet::new(),
        tensor_descriptor_cache: None,
        namespace_files: HashSet::new(),
        unclassified_paths: HashSet::new(),
    };
    walker.walk_archive()
}

/// Export planning reads project documents separately from the run-file
/// inventory. Overlay the already-read project documents so live snapshot
/// artifact refs receive the same graph validation without materializing run
/// payloads in memory.
pub(crate) fn walk_export_file_documents_with_project(
    documents: &HashMap<String, ArchiveFileSnapshot>,
    root: &Path,
    inline_project_documents: &HashMap<String, Vec<u8>>,
) -> Result<ReachabilityReport> {
    for name in inline_project_documents.keys() {
        validate_file_ref(name).with_context(|| format!("invalid inline project document `{name}`"))?;
        if !name.starts_with("project/") || name.starts_with("objects/") {
            bail!("inline export overlay accepts only project documents: `{name}`");
        }
        if documents.contains_key(name) {
            bail!("inline project document shadows file inventory entry `{name}`");
        }
    }
    let root = fs::canonicalize(root)?;
    let mut walker = ArchiveWalker {
        documents: ArchiveDocuments::FilesWithInline {
            snapshots: documents,
            root: &root,
            inline: inline_project_documents,
        },
        cas_root: Some(&root),
        mode: ReachabilityMode::Export,
        report: ReachabilityReport::new(),
        seen_checkpoints: HashSet::new(),
        tensor_descriptor_cache: None,
        namespace_files: HashSet::new(),
        unclassified_paths: HashSet::new(),
    };
    walker.walk_archive()
}
/// Traverse a decoded import inventory using the same typed restore graph.
pub(crate) fn walk_import_file_documents(
    documents: &HashMap<String, ArchiveFileSnapshot>, root: &Path,
) -> Result<ReachabilityReport> {
    let root = fs::canonicalize(root)?;
    let mut walker = ArchiveWalker {
        documents: ArchiveDocuments::Files { snapshots: documents, root: &root },
        cas_root: Some(&root), mode: ReachabilityMode::Restore,
        report: ReachabilityReport::new(),
        seen_checkpoints: HashSet::new(),
        tensor_descriptor_cache: None,
        namespace_files: HashSet::new(),
        unclassified_paths: HashSet::new(),
    };
    walker.walk_archive()
}

/// Validate one checkpoint graph before its checkpoint commit marker is
/// published.  The checkpoint JSON itself may not exist yet; all referenced
/// common state and CAS payloads must already be present and intact.
pub fn walk_checkpoint(root: &Path, checkpoint: &FmsCheckpoint) -> Result<ReachabilityReport> {
    let root = fs::canonicalize(root)
        .with_context(|| format!("canonicalizing session store {}", root.display()))?;
    validate_component(&checkpoint.run_id)?;
    validate_component(&checkpoint.checkpoint_id)?;
    let relative = format!(
        "runs/{}/checkpoints/{}/checkpoint.json",
        checkpoint.run_id, checkpoint.checkpoint_id
    );
    let mut walker = StoreWalker {
        root,
        mode: ReachabilityMode::Restore,
        report: ReachabilityReport::new(),
        seen_files: HashSet::new(),
        seen_checkpoints: HashSet::new(),
        tensor_descriptor_cache: None,
        namespace_files: HashSet::new(),
        unclassified_paths: HashSet::new(),
    };
    walker.walk_checkpoint_value(checkpoint, &relative)?;
    walker.report.require_complete()?;
    Ok(walker.report)
}

struct StoreWalker {
    root: PathBuf,
    mode: ReachabilityMode,
    report: ReachabilityReport,
    seen_files: HashSet<String>,
    seen_checkpoints: HashSet<String>,
    tensor_descriptor_cache: Option<(String, TensorDescriptor)>,
    namespace_files: HashSet<String>,
    unclassified_paths: HashSet<String>,
}

impl StoreWalker {
    fn missing(&mut self, message: impl Into<String>) -> Result<()> {
        self.report.missing(message)
    }

    fn walk_store(&mut self) -> Result<ReachabilityReport> {
        self.validate_top_level()?;
        self.walk_current_pointer()?;
        self.walk_sessions_dir()?;
        self.walk_recovery_dir()?;
        self.walk_scheduler_pools_dir()?;
        self.walk_live_command_journals_dir()?;
        self.walk_runs_dir()?;
        self.walk_solutions_dir()?;
        self.walk_objects_dir()?;
        self.finalize_run_namespace_coverage();

        if matches!(self.mode, ReachabilityMode::Gc) && !self.report.complete {
            self.report.require_complete()?;
        }
        Ok(std::mem::take(&mut self.report))
    }

    fn validate_top_level(&mut self) -> Result<()> {
        if !self.root.is_dir() {
            bail!(
                "session store root is not a directory: {}",
                self.root.display()
            )
        }
        for entry in read_directory(&self.root)? {
            if entry.file_type()?.is_symlink() {
                bail!("symlink at session store root: {}", entry.path().display())
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            match name.as_str() {
                "CURRENT" | "LOCK" | "WRITER.lock" | "WRITER.owner.json" => {
                    if !entry.file_type()?.is_file() {
                        bail!("session control entry `{name}` is not a file")
                    }
                }
                "manifests"
                | "runs"
                | "scheduler_pools"
                | "live_command_journals"
                | "recovery"
                | "solutions"
                | "objects" => {
                    if !entry.file_type()?.is_dir() {
                        bail!("session root `{name}` is not a directory")
                    }
                }
                "manifest" => {
                    if !entry.file_type()?.is_dir() {
                        bail!("session manifest root is not a directory")
                    }
                    self.walk_manifest_namespace(&entry.path())?;
                }
                // Native service ownership and logs contain no scientific CAS refs.
                // They are neither archive roots nor GC sweep candidates.
                "runtime-services" => {
                    reject_link_chain(&self.root, "runtime-services")?;
                    if !entry.file_type()?.is_dir() {
                        bail!("runtime service operational root is not a directory");
                    }
                }
                // These are writer-owned transient namespaces.  They are not
                // roots and are never swept by this graph walk.
                "temp" | "staging" => {
                    if !entry.file_type()?.is_dir() {
                        bail!("session transient root `{name}` is not a directory")
                    }
                }
                // Project/import documents are retained as files.  Their
                // future typed refs must be added to this walker before they
                // can be used as CAS roots; GC therefore marks the graph
                // incomplete when they exist.
                "project" | "imports" => {
                    if !entry.file_type()?.is_dir() {
                        bail!("session document root `{name}` is not a directory")
                    }
                    if name == "project" {
                        self.walk_project_namespace(&entry.path())?;
                    } else {
                        self.walk_arbitrary_files(&entry.path(), &name)?;
                        self.report.mark_blocking_incomplete(format!(
                            "untyped session document root `{name}` requires conservative GC"
                        ));
                    }
                }
                _ => bail!("unknown session store root `{name}`"),
            }
        }
        Ok(())
    }

    fn walk_manifest_namespace(&mut self, directory: &Path) -> Result<()> {
        for entry in read_directory(directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!(
                    "unsupported session manifest entry `{}`",
                    entry.path().display()
                )
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("manifest/{name}");
            let data = self.read_file(&entry.path(), &relative)?;
            match name.as_str() {
                "session.json" => {
                    let session: FmsSessionManifest = parse_json(&data, &relative)?;
                    validate_session(&session, &relative)?;
                    self.walk_session_roots(&session)?;
                }
                "workspace.json" => {
                    let _: FmsWorkspaceManifest = parse_json(&data, &relative)?;
                }
                "export_profile.json" => {
                    let _: FmsExportProfile = parse_json(&data, &relative)?;
                }
                _ => bail!("unknown session manifest document `{relative}`"),
            }
        }
        Ok(())
    }

    fn walk_project_namespace(&mut self, directory: &Path) -> Result<()> {
        const KNOWN_LEAFS: &[&str] = &[
            "main.py",
            "problem_ir.json",
            "scene_document.json",
            "script_builder.json",
            "model_builder_graph.json",
            "ui_state.json",
            "current_live_snapshot.json",
            "asset_index.json",
        ];
        for entry in read_directory(directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!("unsupported project entry `{}`", entry.path().display())
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("project/{name}");
            let data = self.read_file(&entry.path(), &relative)?;
            if name == "current_live_snapshot.json" {
                let inspection = crate::typed_documents::inspect_live_snapshot(&data);
                match inspection.object_refs {
                    Ok(object_refs) => {
                        for object_ref in object_refs {
                            self.follow_store_object_ref(&object_ref, &relative, "live snapshot")?;
                        }
                    }
                    Err(reason) => self.report.mark_opaque_project_document(format!(
                        "project document `{relative}` has untyped object references ({reason}); conservative GC required"
                    )),
                }
                match inspection.artifact_refs {
                    Ok(artifact_refs) => {
                        self.follow_store_live_snapshot_artifacts(&artifact_refs, &relative)?;
                    }
                    Err(reason) => self.report.mark_blocking_incomplete(format!(
                        "project document `{relative}` has invalid live artifact references ({reason}); conservative GC required"
                    )),
                }
            } else if !KNOWN_LEAFS.contains(&name.as_str()) {
                self.report.mark_blocking_incomplete(format!(
                    "unknown project document `{relative}` requires conservative GC"
                ));
            } else if name == "asset_index.json" {
                self.report.mark_opaque_project_document(format!(
                    "project document `{relative}` has untyped object references; conservative GC required"
                ));
            }
        }
        Ok(())
    }

    fn follow_store_live_snapshot_artifacts(
        &mut self,
        references: &LiveSnapshotArtifactReferences,
        source: &str,
    ) -> Result<()> {
        for artifact in &references.artifacts {
            let relative = live_snapshot_artifact_path(&references.run_id, &artifact.path)
                .with_context(|| format!("invalid live artifact reference in `{source}`"))?;
            self.follow_store_live_artifact(&relative, &artifact.kind, source)?;
        }
        Ok(())
    }

    fn follow_store_live_artifact(
        &mut self,
        relative: &str,
        kind: &str,
        source: &str,
    ) -> Result<()> {
        reject_link_chain(&self.root, relative)?;
        let path = self.root.join(relative);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return self.missing(format!(
                    "live snapshot `{source}` references missing run artifact `{relative}`"
                ));
            }
            Err(error) => return Err(error).with_context(|| format!("checking live artifact `{relative}`")),
        };
        if metadata.is_file() {
            self.report.file_refs.insert(relative.to_string());
            return Ok(());
        }
        // Persisted `ArtifactEntry.kind == "zarr"` is emitted for Zarr
        // directory roots (and may also identify a single Zarr file). No path
        // suffix heuristic is used to decide whether a subtree is legal.
        if !metadata.is_dir() || kind != "zarr" {
            bail!("live snapshot artifact `{relative}` is not a file or supported Zarr directory");
        }

        let mut pending = vec![(path, relative.to_string())];
        let mut file_count = 0usize;
        while let Some((directory, directory_relative)) = pending.pop() {
            reject_link_chain(&self.root, &directory_relative)?;
            for entry in read_directory(&directory)? {
                let name = entry.file_name();
                let name = name
                    .to_str()
                    .context("live Zarr artifact contains a non-portable path component")?;
                let child_relative = format!("{directory_relative}/{name}");
                validate_file_ref(&child_relative)?;
                reject_link_chain(&self.root, &child_relative)?;
                let child_metadata = fs::symlink_metadata(entry.path())?;
                if child_metadata.is_dir() {
                    pending.push((entry.path(), child_relative));
                } else if child_metadata.is_file() {
                    file_count = file_count.saturating_add(1);
                    self.report.file_refs.insert(child_relative);
                } else {
                    bail!("unsupported live Zarr artifact entry `{child_relative}`");
                }
            }
        }
        if file_count == 0 {
            self.missing(format!(
                "live snapshot `{source}` references an empty Zarr artifact subtree `{relative}`"
            ))?;
        }
        Ok(())
    }
    fn walk_objects_dir(&mut self) -> Result<()> {
        let objects = self.root.join("objects");
        if !objects.exists() {
            return Ok(());
        }
        if !objects.is_dir() {
            bail!(
                "session objects path is not a directory: {}",
                objects.display()
            )
        }
        for entry in read_directory(&objects)? {
            if entry.file_type()?.is_symlink() {
                bail!("symlink under session objects: {}", entry.path().display())
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            match name.as_str() {
                // Pins are owned by the GC/transaction coordinator.  The
                // walker intentionally does not clear or reinterpret them.
                "pins" => {
                    if !entry.file_type()?.is_dir() {
                        bail!("session object pins path is not a directory")
                    }
                }
                "sha256" => {
                    if !entry.file_type()?.is_dir() {
                        bail!("session CAS path is not a directory")
                    }
                    for object in read_directory(&entry.path())? {
                        if object.file_type()?.is_symlink() || !object.file_type()?.is_file() {
                            bail!(
                                "unsupported session CAS entry `{}`",
                                object.path().display()
                            )
                        }
                        let object_id = object.file_name().to_string_lossy().into_owned();
                        validate_object_ref(&object_id)
                            .with_context(|| format!("invalid CAS entry `{object_id}`"))?;
                    }
                }
                _ => bail!("unknown session objects entry `{name}`"),
            }
        }
        Ok(())
    }

    fn walk_solutions_dir(&mut self) -> Result<()> {
        let directory = self.root.join("solutions");
        if !directory.exists() {
            return Ok(());
        }
        for entry in read_directory(&directory)? {
            let directory_name = entry.file_name().to_string_lossy().into_owned();
            validate_object_ref(&directory_name)
                .with_context(|| format!("invalid solution-set directory `{directory_name}`"))?;
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_dir() {
                bail!("solution-set entry `{directory_name}` is not a directory")
            }
            reject_link_chain(&self.root, &format!("solutions/{directory_name}"))?;
            self.walk_solution_directory(&entry.path(), &directory_name)?;
        }
        Ok(())
    }

    fn walk_solution_directory(&mut self, directory: &Path, directory_name: &str) -> Result<()> {
        let mut current: Option<SolutionSet> = None;
        let mut revisions = BTreeMap::new();
        for entry in read_directory(directory)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            match name.as_str() {
                "manifest.json" => {
                    if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                        bail!("solution-set current manifest is not a file")
                    }
                    let relative = format!("solutions/{directory_name}/manifest.json");
                    let data = self.read_file(&entry.path(), &relative)?;
                    let solution: SolutionSet = parse_json(&data, &relative)?;
                    self.validate_solution_identity(&solution, directory_name, None, &relative)?;
                    self.walk_solution_objects(&solution, &relative)?;
                    current = Some(solution);
                }
                "revisions" => {
                    if entry.file_type()?.is_symlink() || !entry.file_type()?.is_dir() {
                        bail!("solution-set revisions entry is not a directory")
                    }
                    reject_link_chain(
                        &self.root,
                        &format!("solutions/{directory_name}/revisions"),
                    )?;
                    for revision_entry in read_directory(&entry.path())? {
                        let file_name = revision_entry.file_name().to_string_lossy().into_owned();
                        if revision_entry.file_type()?.is_symlink()
                            || !revision_entry.file_type()?.is_file()
                        {
                            bail!("solution-set revision `{file_name}` is not a file")
                        }
                        let revision_text = file_name
                            .strip_suffix(".json")
                            .filter(|value| {
                                value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit())
                            })
                            .with_context(|| {
                                format!("invalid solution-set revision filename `{file_name}`")
                            })?;
                        let revision = revision_text.parse::<u64>()?;
                        if revision == 0 {
                            bail!("solution-set revision must be positive")
                        }
                        let relative = format!("solutions/{directory_name}/revisions/{file_name}");
                        let data = self.read_file(&revision_entry.path(), &relative)?;
                        let solution: SolutionSet = parse_json(&data, &relative)?;
                        self.validate_solution_identity(
                            &solution,
                            directory_name,
                            Some(revision),
                            &relative,
                        )?;
                        self.walk_solution_objects(&solution, &relative)?;
                        if revisions.insert(revision, solution).is_some() {
                            bail!("duplicate solution-set revision `{revision}`")
                        }
                    }
                }
                _ => bail!("unknown solution-set entry `{name}`"),
            }
        }

        let mut previous: Option<&SolutionSet> = None;
        for (index, (revision, solution)) in revisions.iter().enumerate() {
            let expected = u64::try_from(index + 1).context("solution-set revision overflow")?;
            if *revision != expected {
                bail!("solution-set revision history has a gap")
            }
            if let Some(previous) = previous {
                crate::solution_set_catalog::validate_successor(previous, solution)?;
            }
            previous = Some(solution);
        }
        if let Some(current) = current {
            let persisted = revisions
                .get(&current.revision)
                .context("solution-set current revision is missing from immutable history")?;
            if persisted != &current {
                bail!("solution-set current manifest conflicts with immutable history")
            }
        }
        Ok(())
    }

    fn validate_solution_identity(
        &self,
        solution: &SolutionSet,
        directory_name: &str,
        expected_revision: Option<u64>,
        source: &str,
    ) -> Result<()> {
        solution
            .validate()
            .with_context(|| format!("validating solution set `{source}`"))?;
        if crate::cas::hex_sha256(solution.solution_set_id.as_bytes()) != directory_name {
            bail!("solution-set directory does not match logical identity")
        }
        if expected_revision.is_some_and(|revision| solution.revision != revision) {
            bail!("solution-set revision path identity mismatch")
        }
        Ok(())
    }

    fn walk_solution_objects(&mut self, solution: &SolutionSet, source: &str) -> Result<()> {
        let mut dataset_revisions = BTreeSet::new();
        let mut geometry_sources = BTreeSet::new();
        let has_typed_tensor_root = solution
            .members
            .iter()
            .flat_map(|member| &member.artifacts)
            .any(|artifact| {
                artifact.schema_id == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA
                    || artifact.schema_id
                        == crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
                    || artifact.schema_id
                        == crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA
            });
        if has_typed_tensor_root {
            crate::solution_tensor_source::verify_solution_tensor_run_owner(&self.root, solution)?;
        }
        for member in &solution.members {
            for artifact in &member.artifacts {
                self.follow_solution_object_ref(
                    &artifact.object_ref,
                    artifact.byte_length,
                    source,
                )?;
                match artifact.schema_id.as_str() {
                    crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA => {
                        let _ = self.follow_solution_tensor_artifact(artifact, source)?;
                    }
                    crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA => {
                        self.follow_materialized_dataset_artifact(
                            artifact,
                            solution,
                            &member.member_id,
                            &mut dataset_revisions,
                            source,
                        )?;
                    }
                    crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA => {
                        self.follow_field_geometry_artifact(
                            artifact, solution, &member.member_id, &mut geometry_sources, source,
                        )?;
                    }
                    _ => {}
                }
            }
        }
        for coverage in &solution.coverage {
            for segment in &coverage.segments {
                self.follow_solution_object_ref(&segment.object_ref, segment.byte_length, source)?;
            }
        }
        Ok(())
    }

    fn follow_solution_tensor_artifact(
        &mut self,
        artifact: &fullmag_quantities::SolutionArtifactRef,
        source: &str,
    ) -> Result<Option<TensorDescriptor>> {
        crate::solution_tensor_source::validate_metadata_length(artifact)?;
        if let Some((object_ref, descriptor)) = self.tensor_descriptor_cache.as_ref() {
            if object_ref == &artifact.object_ref {
                return Ok(Some(descriptor.clone()));
            }
        }
        let object_path = self.root.join("objects/sha256").join(&artifact.object_ref);
        if !object_path.exists() {
            return Ok(None);
        }

        use std::io::Read;
        reject_link_chain(&self.root, &format!("objects/sha256/{}", artifact.object_ref))?;
        let mut data = Vec::new();
        fs::File::open(&object_path)?
            .take(crate::solution_tensor_source::MAX_SOLUTION_TENSOR_METADATA_BYTES + 1)
            .read_to_end(&mut data)?;
        if data.len() as u64 > crate::solution_tensor_source::MAX_SOLUTION_TENSOR_METADATA_BYTES {
            bail!(
                "solution tensor descriptor `{}` exceeds metadata budget",
                artifact.object_ref
            )
        }
        let descriptor = crate::solution_tensor_source::parse_solution_tensor_artifact(
            &data, artifact,
        )?;
        for chunk in &descriptor.chunks {
            self.follow_solution_object_ref(&chunk.object_ref, chunk.length as u64, source)?;
        }
        self.tensor_descriptor_cache = Some((artifact.object_ref.clone(), descriptor.clone()));
        Ok(Some(descriptor))
    }

    fn follow_materialized_dataset_artifact(
        &mut self,
        artifact: &fullmag_quantities::SolutionArtifactRef,
        solution: &SolutionSet,
        current_member_id: &str,
        dataset_revisions: &mut BTreeSet<(String, u64)>,
        source: &str,
    ) -> Result<()> {
        let object_path = self.root.join("objects/sha256").join(&artifact.object_ref);
        if !object_path.exists() {
            return Ok(());
        }
        if artifact.byte_length
            > crate::materialized_dataset::MAX_MATERIALIZED_DATASET_METADATA_BYTES
        {
            bail!(
                "materialized dataset manifest `{}` exceeds metadata budget",
                artifact.object_ref
            )
        }
        use std::io::Read;
        reject_link_chain(&self.root, &format!("objects/sha256/{}", artifact.object_ref))?;
        let mut data = Vec::new();
        fs::File::open(&object_path)?
            .take(crate::materialized_dataset::MAX_MATERIALIZED_DATASET_METADATA_BYTES + 1)
            .read_to_end(&mut data)?;
        if data.len() as u64 > crate::materialized_dataset::MAX_MATERIALIZED_DATASET_METADATA_BYTES
        {
            bail!(
                "materialized dataset manifest `{}` exceeds metadata budget",
                artifact.object_ref
            )
        }
        let manifest = crate::materialized_dataset::parse_materialized_dataset_artifact(
            &data, artifact,
        )?;
        register_materialized_dataset_revision(dataset_revisions, &manifest)?;
        if artifact.accepted_state != manifest.field.accepted_state {
            bail!("materialized dataset artifact accepted state differs from its field");
        }
        let owner = &manifest.field.source;
        if owner.run_id != solution.run_id
            || owner.solution_set_id != solution.solution_set_id
            || owner.solution_revision > solution.revision
            || owner.run_spec_digest != solution.provenance.run_spec_digest
        {
            bail!("materialized dataset owner is outside the containing SolutionSet");
        }
        if owner.member_id != current_member_id {
            bail!("materialized dataset owner member differs from its containing member");
        }
        self.validate_current_materialized_tensor_record(
            solution,
            current_member_id,
            &manifest.field.tensor_artifact,
        )?;
        if owner.solution_revision == solution.revision {
            crate::materialized_dataset::validate_materialized_dataset_owner(&manifest, solution)?;
        } else {
            let historical = self.read_solution_revision(owner.solution_set_id.as_str(), owner.solution_revision)?;
            crate::materialized_dataset::validate_materialized_dataset_owner(&manifest, &historical)?;
        }
        self.follow_solution_object_ref(
            &manifest.field.tensor_artifact.object_ref,
            manifest.field.tensor_artifact.byte_length,
            source,
        )?;
        let Some(descriptor) =
            self.follow_solution_tensor_artifact(&manifest.field.tensor_artifact, source)?
        else {
            return Ok(());
        };
        crate::materialized_dataset::validate_materialized_dataset_tensor(&manifest, &descriptor)
    }

    fn follow_field_geometry_artifact(
        &mut self,
        artifact: &fullmag_quantities::SolutionArtifactRef,
        solution: &SolutionSet,
        member_id: &str,
        geometry_sources: &mut BTreeSet<(String, String)>,
        source: &str,
    ) -> Result<()> {
        use crate::solution_field_geometry as geometry;
        use std::io::Read;
        if artifact.byte_length == 0 || artifact.byte_length > geometry::MAX_FIELD_GEOMETRY_MANIFEST_BYTES {
            bail!("saved field geometry binding exceeds its metadata budget");
        }
        let relative = format!("objects/sha256/{}", artifact.object_ref);
        let path = self.root.join(&relative);
        if !path.exists() { return Ok(()); }
        reject_link_chain(&self.root, &relative)?;
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(geometry::MAX_FIELD_GEOMETRY_MANIFEST_BYTES + 1).read_to_end(&mut bytes)?;
        let manifest = geometry::parse_solution_field_geometry_manifest(&bytes, artifact)?;
        drop(bytes);
        if !geometry_sources.insert((manifest.source.member_id.clone(), manifest.source.artifact_id.clone())) {
            bail!("saved field geometry is duplicated for the same tensor");
        }
        geometry::validate_field_geometry_owner(&manifest, solution, member_id, false)?;
        if manifest.source.solution_revision != solution.revision {
            let historical = self.read_solution_revision(&manifest.source.solution_set_id, manifest.source.solution_revision)?;
            geometry::validate_field_geometry_owner(&manifest, &historical, member_id, true)?;
        }
        self.follow_solution_object_ref(&manifest.geometry.object_ref, manifest.geometry.byte_length, source)?;
        let relative = format!("objects/sha256/{}", manifest.geometry.object_ref);
        let path = self.root.join(&relative);
        if !path.exists() { return Ok(()); }
        reject_link_chain(&self.root, &relative)?;
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(geometry::MAX_FEM_P1_GEOMETRY_BYTES + 1).read_to_end(&mut bytes)?;
        let saved = geometry::parse_saved_fem_p1_geometry(&bytes, &manifest.geometry)?;
        drop(bytes);
        self.follow_solution_object_ref(&manifest.tensor_artifact.object_ref, manifest.tensor_artifact.byte_length, source)?;
        if let Some(tensor) = self.follow_solution_tensor_artifact(&manifest.tensor_artifact, source)? {
            geometry::validate_saved_geometry_tensor(&saved, &tensor)?;
        }
        Ok(())
    }

    fn validate_current_materialized_tensor_record(
        &self,
        solution: &SolutionSet,
        member_id: &str,
        tensor_artifact: &fullmag_quantities::SolutionArtifactRef,
    ) -> Result<()> {
        let member = solution
            .members
            .iter()
            .find(|member| member.member_id == member_id)
            .context("materialized dataset current owner member is missing")?;
        let current = member
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == tensor_artifact.artifact_id)
            .context("materialized dataset current owner tensor artifact is missing")?;
        if current != tensor_artifact {
            bail!("materialized dataset tensor artifact changed in the containing SolutionSet");
        }
        Ok(())
    }

    fn read_solution_revision(
        &mut self,
        solution_set_id: &str,
        revision: u64,
    ) -> Result<SolutionSet> {
        let directory = crate::cas::hex_sha256(solution_set_id.as_bytes());
        let relative = format!(
            "solutions/{directory}/revisions/{revision:020}.json"
        );
        let path = self.root.join(&relative);
        let data = self.read_file(&path, &relative)?;
        let historical: SolutionSet = parse_json(&data, &relative)?;
        self.validate_solution_identity(&historical, &directory, Some(revision), &relative)?;
        Ok(historical)
    }

    fn follow_solution_object_ref(
        &mut self,
        object_ref: &str,
        expected_length: u64,
        source: &str,
    ) -> Result<()> {
        validate_object_ref(object_ref)
            .with_context(|| format!("invalid solution object reference in `{source}`"))?;
        self.add_object(object_ref);
        let object_path = self.root.join("objects/sha256").join(object_ref);
        reject_link_chain(&self.root, &format!("objects/sha256/{object_ref}"))?;
        if !object_path.exists() {
            return self.missing(format!(
                "solution set `{source}` references missing object `{object_ref}`"
            ));
        }
        let actual_length = crate::cas::verified_file_length(&object_path, object_ref)?;
        if actual_length != expected_length {
            bail!(
                "solution set `{source}` object `{object_ref}` length mismatch: expected {expected_length}, found {actual_length}"
            )
        }
        Ok(())
    }

    fn walk_current_pointer(&mut self) -> Result<()> {
        let path = self.root.join("CURRENT");
        if !path.exists() {
            return Ok(());
        }
        let relative = "CURRENT".to_string();
        let data = self.read_file(&path, &relative)?;
        let id = std::str::from_utf8(&data)
            .context("CURRENT is not UTF-8")?
            .trim()
            .to_string();
        validate_component(&id).context("invalid CURRENT session id")?;
        let manifest_ref = format!("manifests/{id}.json");
        let manifest_path = self.root.join(&manifest_ref);
        if !manifest_path.exists() {
            bail!("CURRENT points to missing session manifest `{manifest_ref}`")
        }
        self.walk_session_file(&manifest_ref)
    }

    fn walk_sessions_dir(&mut self) -> Result<()> {
        let directory = self.root.join("manifests");
        if !directory.exists() {
            return Ok(());
        }
        for entry in read_directory(&directory)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." || entry.file_type()?.is_symlink() {
                bail!("unsafe session manifest entry `{name}`")
            }
            if !name.ends_with(".json") {
                bail!("unknown session manifest entry `{name}`")
            }
            let relative = format!("manifests/{name}");
            self.walk_session_file(&relative)?;
        }
        Ok(())
    }

    fn walk_recovery_dir(&mut self) -> Result<()> {
        let directory = self.root.join("recovery");
        if !directory.exists() {
            return Ok(());
        }
        for entry in read_directory(&directory)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_symlink() || !name.ends_with(".json") {
                bail!("unknown recovery entry `{name}`")
            }
            let relative = format!("recovery/{name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let session: FmsSessionManifest = parse_json(&data, &relative)?;
            validate_session(&session, &relative)?;
            self.walk_session_roots(&session)?;
        }
        Ok(())
    }

    fn walk_runs_dir(&mut self) -> Result<()> {
        let directory = self.root.join("runs");
        if !directory.exists() {
            return Ok(());
        }
        for run_entry in read_directory(&directory)? {
            if run_entry.file_type()?.is_symlink() || !run_entry.file_type()?.is_dir() {
                bail!("unsafe run root `{}`", run_entry.path().display())
            }
            let run_id = run_entry.file_name().to_string_lossy().into_owned();
            validate_component(&run_id)
                .with_context(|| format!("invalid run directory `{run_id}`"))?;
            self.walk_run_namespace_coverage(&run_entry.path(), &format!("runs/{run_id}"))?;
            let run_ref = format!("runs/{run_id}/run_manifest.json");
            let run_path = run_entry.path().join("run_manifest.json");
            if run_path.exists() {
                self.walk_run_file(&run_ref, &run_id)?;
            }
            let intent_path = run_entry.path().join("run_intent.json");
            if intent_path.exists() {
                self.walk_run_intent_file(&intent_path, &run_id)?;
            }
            let catalog_path = run_entry.path().join("run_catalog.json");
            if catalog_path.exists() {
                self.walk_run_catalog_file(&catalog_path, &run_id)?;
            }
            let artifact_catalog_path = run_entry.path().join("artifact_catalog.json");
            if artifact_catalog_path.exists() {
                self.walk_artifact_catalog_file(&artifact_catalog_path, &run_id)?;
            }
            let preparation_receipt_path = run_entry.path().join("preparation_receipt.json");
            if preparation_receipt_path.exists() {
                self.walk_preparation_receipt_file(&preparation_receipt_path, &run_id)?;
            }
            self.walk_task_preparation_receipts(&run_entry.path(), &run_id)?;
            self.walk_run_task_admissions(&run_entry.path(), &run_id)?;
            self.walk_run_retry_decisions(&run_entry.path(), &run_id)?;
            self.walk_run_preparation_retry_decisions(&run_entry.path(), &run_id)?;
            self.walk_run_worker_process_exit_receipts(&run_entry.path(), &run_id)?;
            self.walk_run_preparation_process_launches(&run_entry.path(), &run_id)?;
            self.walk_run_preparation_process_exit_receipts(&run_entry.path(), &run_id)?;
            let checkpoint_dir = run_entry.path().join("checkpoints");
            if checkpoint_dir.exists() {
                if !checkpoint_dir.is_dir() {
                    bail!(
                        "run checkpoints path is not a directory: {}",
                        checkpoint_dir.display()
                    )
                }
                for checkpoint_entry in read_directory(&checkpoint_dir)? {
                    if checkpoint_entry.file_type()?.is_symlink()
                        || !checkpoint_entry.file_type()?.is_dir()
                    {
                        bail!(
                            "unsafe checkpoint root `{}`",
                            checkpoint_entry.path().display()
                        )
                    }
                    let checkpoint_id = checkpoint_entry.file_name().to_string_lossy().into_owned();
                    validate_component(&checkpoint_id).with_context(|| {
                        format!("invalid checkpoint directory `{checkpoint_id}`")
                    })?;
                    let checkpoint_ref =
                        format!("runs/{run_id}/checkpoints/{checkpoint_id}/checkpoint.json");
                    let checkpoint_path = checkpoint_entry.path().join("checkpoint.json");
                    if checkpoint_path.exists() {
                        self.walk_checkpoint_file(&checkpoint_ref, &run_id, &checkpoint_id)?;
                    }
                }
            }
            self.walk_run_artifacts(&run_entry.path(), &run_id)?;
            self.walk_run_resource_leases(&run_entry.path(), &run_id)?;
            self.walk_run_preparation_resource_leases(&run_entry.path(), &run_id)?;
            self.walk_run_coordinator_journal(&run_entry.path(), &run_id)?;
            let inbox_root = crate::repository_path::checked_path(
                &self.root,
                &format!("runs/{run_id}/worker_inbox"),
            )?;
            if inbox_root.exists() {
                for entry in read_directory(&inbox_root)? {
                    if !entry.file_type()?.is_file() {
                        bail!("unsafe worker inbox entry");
                    }
                    let relative = format!(
                        "runs/{run_id}/worker_inbox/{}",
                        entry.file_name().to_string_lossy()
                    );
                    let data = self.read_file(&entry.path(), &relative)?;
                    let record: crate::FmsWorkerInboxRecord = parse_json(&data, &relative)?;
                    if record.relative_path()? != relative {
                        bail!("worker inbox path identity mismatch");
                    }
                }
            }
        }
        Ok(())
    }

    fn walk_run_namespace_coverage(&mut self, directory: &Path, prefix: &str) -> Result<()> {
        // Artifact nesting is untrusted input; directory depth must not grow
        // the call stack while computing namespace coverage.
        let mut pending = vec![(directory.to_path_buf(), prefix.to_string())];
        while let Some((directory, prefix)) = pending.pop() {
            reject_link_chain(&self.root, &prefix)?;
            for entry in read_directory(&directory)? {
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    bail!("symlink under session run namespace: {}", entry.path().display());
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let relative = format!("{prefix}/{name}");
                if file_type.is_dir() {
                    pending.push((entry.path(), relative));
                    continue;
                }
                if !file_type.is_file() {
                    bail!("unsupported session run entry `{relative}`");
                }
                validate_file_ref(&relative)?;
                reject_link_chain(&self.root, &relative)?;
                match classify_run_path(&relative)? {
                    RunPathKind::OpaqueArtifact => {
                        self.report.file_refs.insert(relative);
                    }
                    RunPathKind::KnownRecord => {
                        self.namespace_files.insert(relative);
                    }
                    RunPathKind::Unknown => {
                        self.namespace_files.insert(relative.clone());
                        self.unclassified_paths.insert(relative);
                    }
                }
            }
        }
        Ok(())
    }

    fn finalize_run_namespace_coverage(&mut self) {
        let mut paths = self.namespace_files.iter().collect::<Vec<_>>();
        paths.sort();
        for relative in paths {
            if !self.seen_files.contains(relative) {
                let kind = if self.unclassified_paths.contains(relative) {
                    "unknown session run document"
                } else {
                    "unconsumed session run document"
                };
                self.report.conservative(format!(
                    "{kind} `{relative}` requires conservative GC"
                ));
            }
        }
    }

    fn walk_run_resource_leases(&mut self, run_dir: &Path, run_id: &str) -> Result<()> {
        let directory = run_dir.join("resource_leases");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run resource_leases path is not a directory: {}",
                directory.display()
            )
        }
        for resource_entry in read_directory(&directory)? {
            if resource_entry.file_type()?.is_symlink() || !resource_entry.file_type()?.is_dir() {
                bail!(
                    "unsafe resource lease root `{}`",
                    resource_entry.path().display()
                )
            }
            let resource_id = resource_entry.file_name().to_string_lossy().into_owned();
            validate_component(&resource_id)
                .with_context(|| format!("invalid resource lease resource `{resource_id}`"))?;
            for lease_entry in read_directory(&resource_entry.path())? {
                if lease_entry.file_type()?.is_symlink() || !lease_entry.file_type()?.is_file() {
                    bail!(
                        "unsafe resource lease entry `{}`",
                        lease_entry.path().display()
                    )
                }
                let file_name = lease_entry.file_name().to_string_lossy().into_owned();
                let Some(lease_token) = file_name.strip_suffix(".json") else {
                    bail!("resource lease entry must be JSON: `{file_name}`")
                };
                validate_component(lease_token)?;
                let relative = format!("runs/{run_id}/resource_leases/{resource_id}/{file_name}");
                let data = self.read_file(&lease_entry.path(), &relative)?;
                let lease: FmsResourceLease = parse_json(&data, &relative)?;
                lease.validate()?;
                if lease.run_id != run_id
                    || lease.resource_id != resource_id
                    || lease.lease_token != lease_token
                {
                    bail!("resource lease `{relative}` contains mismatched path identity")
                }
            }
        }
        Ok(())
    }

    fn walk_run_retry_decisions(&mut self, run_dir: &Path, run_id: &str) -> Result<()> {
        let directory = run_dir.join("retry_decisions");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run retry_decisions path is not a directory: {}",
                directory.display()
            )
        }
        for entry in read_directory(&directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!("unsafe retry decision entry `{}`", entry.path().display())
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(decision_id) = file_name.strip_suffix(".json") else {
                bail!("retry decision entry must be JSON: `{file_name}`")
            };
            validate_component(decision_id)?;
            let relative = format!("runs/{run_id}/retry_decisions/{file_name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let decision: FmsRetryDecision = parse_json(&data, &relative)?;
            decision.validate()?;
            if decision.run_id != run_id || decision.decision_id != decision_id {
                bail!("retry decision `{relative}` contains mismatched path identity")
            }
        }
        Ok(())
    }

    fn walk_run_preparation_retry_decisions(&mut self, run_dir: &Path, run_id: &str) -> Result<()> {
        let directory = run_dir.join("preparation_retry_decisions");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run preparation_retry_decisions path is not a directory: {}",
                directory.display()
            )
        }
        for entry in read_directory(&directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!(
                    "unsafe preparation retry decision entry `{}`",
                    entry.path().display()
                )
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(decision_id) = file_name.strip_suffix(".json") else {
                bail!("preparation retry decision entry must be JSON: `{file_name}`")
            };
            validate_component(decision_id)?;
            let relative = format!("runs/{run_id}/preparation_retry_decisions/{file_name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let decision: FmsPreparationRetryDecision = parse_json(&data, &relative)?;
            if decision.relative_path()? != relative {
                bail!("preparation retry decision `{relative}` contains mismatched path identity")
            }
        }
        Ok(())
    }

    fn walk_run_preparation_resource_leases(&mut self, run_dir: &Path, run_id: &str) -> Result<()> {
        let directory = run_dir.join("preparation_resource_leases");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run preparation_resource_leases path is not a directory: {}",
                directory.display()
            )
        }
        for resource_entry in read_directory(&directory)? {
            if resource_entry.file_type()?.is_symlink() || !resource_entry.file_type()?.is_dir() {
                bail!(
                    "unsafe preparation resource lease root `{}`",
                    resource_entry.path().display()
                )
            }
            let resource_id = resource_entry.file_name().to_string_lossy().into_owned();
            validate_component(&resource_id).with_context(|| {
                format!("invalid preparation resource lease resource `{resource_id}`")
            })?;
            for lease_entry in read_directory(&resource_entry.path())? {
                if lease_entry.file_type()?.is_symlink() || !lease_entry.file_type()?.is_file() {
                    bail!(
                        "unsafe preparation resource lease entry `{}`",
                        lease_entry.path().display()
                    )
                }
                let file_name = lease_entry.file_name().to_string_lossy().into_owned();
                let Some(lease_token) = file_name.strip_suffix(".json") else {
                    bail!("preparation resource lease entry must be JSON: `{file_name}`")
                };
                validate_component(lease_token)?;
                let relative =
                    format!("runs/{run_id}/preparation_resource_leases/{resource_id}/{file_name}");
                let data = self.read_file(&lease_entry.path(), &relative)?;
                let lease: FmsPreparationResourceLease = parse_json(&data, &relative)?;
                lease.validate()?;
                if lease.run_id != run_id
                    || lease.resource_id != resource_id
                    || lease.lease_token != lease_token
                    || lease.relative_path()? != relative
                {
                    bail!(
                        "preparation resource lease `{relative}` contains mismatched path identity"
                    )
                }
            }
        }
        Ok(())
    }

    fn walk_scheduler_pools_dir(&mut self) -> Result<()> {
        let directory = self.root.join("scheduler_pools");
        if !directory.exists() {
            return Ok(());
        }
        for entry in read_directory(&directory)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!("unknown scheduler pool checkpoint entry `{name}`");
            }
            let relative = format!("scheduler_pools/{name}");
            let data = self.read_file(&entry.path(), &relative)?;
            if let Some(pool_id) = name.strip_suffix(".preparation-resources.json") {
                validate_component(pool_id)?;
                let pool: FmsPreparationResourcePool = parse_json(&data, &relative)?;
                pool.validate()?;
                if pool.pool_id != pool_id {
                    bail!("preparation resource pool `{relative}` has mismatched path identity");
                }
            } else if let Some(pool_id) = name.strip_suffix(".preparation.json") {
                validate_component(pool_id)?;
                let checkpoint: FmsSchedulerPoolCheckpoint = parse_json(&data, &relative)?;
                checkpoint.validate()?;
                if checkpoint.pool_id != pool_id
                    || checkpoint.run_source != FmsSchedulerRunSource::Store
                {
                    bail!(
                        "preparation scheduler pool checkpoint `{relative}` has mismatched path identity"
                    );
                }
            } else if let Some(pool_id) = name.strip_suffix(".resources.json") {
                validate_component(pool_id)?;
                let pool: FmsSchedulerResourcePool = parse_json(&data, &relative)?;
                pool.validate()?;
                if pool.pool_id != pool_id {
                    bail!("scheduler resource pool `{relative}` has mismatched path identity");
                }
            } else if let Some(pool_id) = name.strip_suffix(".json") {
                validate_component(pool_id)?;
                let checkpoint: FmsSchedulerPoolCheckpoint = parse_json(&data, &relative)?;
                checkpoint.validate()?;
                if checkpoint.pool_id != pool_id {
                    bail!("scheduler pool checkpoint `{relative}` has mismatched path identity");
                }
            } else {
                bail!("unknown scheduler pool checkpoint entry `{name}`");
            }
        }
        Ok(())
    }

    fn walk_live_command_journals_dir(&mut self) -> Result<()> {
        let directory = self.root.join("live_command_journals");
        if !directory.exists() {
            return Ok(());
        }
        reject_link_chain(&self.root, "live_command_journals")?;
        for session_entry in read_directory(&directory)? {
            let session_id = session_entry.file_name().to_string_lossy().into_owned();
            validate_component(&session_id)?;
            reject_link_chain(&self.root, &format!("live_command_journals/{session_id}"))?;
            if session_entry.file_type()?.is_symlink() || !session_entry.file_type()?.is_dir() {
                bail!("live command journal session entry must be a directory: `{session_id}`");
            }

            let session_directory = session_entry.path();
            let generations_directory = session_directory.join("generations");
            let current_path = session_directory.join("CURRENT");
            let mut published_generation = None;
            for entry in read_directory(&session_directory)? {
                let name = entry.file_name().to_string_lossy().into_owned();
                match name.as_str() {
                    "CURRENT" => {
                        if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                            bail!("live command journal CURRENT must be a regular file");
                        }
                        let relative = format!("live_command_journals/{session_id}/CURRENT");
                        let generation =
                            String::from_utf8(self.read_file(&current_path, &relative)?)
                                .context("live command journal CURRENT must contain UTF-8")?
                                .trim()
                                .to_string();
                        validate_component(&generation)?;
                        if !generation.starts_with("generation-") {
                            bail!("live command journal CURRENT has an invalid generation");
                        }
                        published_generation = Some(generation);
                    }
                    "generations" => {
                        reject_link_chain(
                            &self.root,
                            &format!("live_command_journals/{session_id}/generations"),
                        )?;
                        if entry.file_type()?.is_symlink() || !entry.file_type()?.is_dir() {
                            bail!("live command journal generations must be a directory");
                        }
                    }
                    _ => bail!("unknown live command journal session entry `{name}`"),
                }
            }

            if generations_directory.exists() {
                for generation_entry in read_directory(&generations_directory)? {
                    let file_name = generation_entry.file_name().to_string_lossy().into_owned();
                    if generation_entry.file_type()?.is_symlink()
                        || !generation_entry.file_type()?.is_file()
                    {
                        bail!("live command journal generation must be a regular file");
                    }
                    let Some(generation) = file_name.strip_suffix(".json") else {
                        bail!("live command journal generation must use the .json extension");
                    };
                    validate_component(generation)?;
                    if !generation.starts_with("generation-") {
                        bail!("live command journal has an invalid generation `{file_name}`");
                    }
                    let relative =
                        format!("live_command_journals/{session_id}/generations/{file_name}");
                    self.read_file(&generation_entry.path(), &relative)?;
                }
            }

            if let Some(generation) = published_generation {
                let published_path = generations_directory.join(format!("{generation}.json"));
                if !published_path.is_file() {
                    bail!("live command journal CURRENT points to a missing generation");
                }
            }
        }
        Ok(())
    }

    fn walk_run_worker_process_exit_receipts(
        &mut self,
        run_dir: &Path,
        run_id: &str,
    ) -> Result<()> {
        let directory = run_dir.join("worker_process_exit_receipts");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run worker_process_exit_receipts path is not a directory: {}",
                directory.display()
            )
        }
        for entry in read_directory(&directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!(
                    "unsafe worker process exit receipt entry `{}`",
                    entry.path().display()
                )
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(receipt_id) = file_name.strip_suffix(".json") else {
                bail!("worker process exit receipt entry must be JSON: `{file_name}`")
            };
            validate_component(receipt_id)?;
            let relative = format!("runs/{run_id}/worker_process_exit_receipts/{file_name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let receipt: FmsWorkerProcessExitReceipt = parse_json(&data, &relative)?;
            if receipt.relative_path()? != relative {
                bail!("worker process exit receipt `{relative}` contains mismatched path identity")
            }
        }
        Ok(())
    }

    fn walk_run_preparation_process_exit_receipts(
        &mut self,
        run_dir: &Path,
        run_id: &str,
    ) -> Result<()> {
        let directory = run_dir.join("preparation_process_exit_receipts");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run preparation_process_exit_receipts path is not a directory: {}",
                directory.display()
            )
        }
        for entry in read_directory(&directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!(
                    "unsafe preparation process exit receipt entry `{}`",
                    entry.path().display()
                )
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(receipt_id) = file_name.strip_suffix(".json") else {
                bail!("preparation process exit receipt entry must be JSON: `{file_name}`")
            };
            validate_component(receipt_id)?;
            let relative = format!("runs/{run_id}/preparation_process_exit_receipts/{file_name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let receipt: FmsPreparationProcessExitReceipt = parse_json(&data, &relative)?;
            if receipt.relative_path()? != relative {
                bail!(
                    "preparation process exit receipt `{relative}` contains mismatched path identity"
                )
            }
        }
        Ok(())
    }

    fn walk_run_preparation_process_launches(
        &mut self,
        run_dir: &Path,
        run_id: &str,
    ) -> Result<()> {
        let directory = run_dir.join("preparation_process_launches");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run preparation_process_launches path is not a directory: {}",
                directory.display()
            )
        }
        for entry in read_directory(&directory)? {
            if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                bail!(
                    "unsafe preparation process launch entry `{}`",
                    entry.path().display()
                )
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(launch_id) = file_name.strip_suffix(".json") else {
                bail!("preparation process launch entry must be JSON: `{file_name}`")
            };
            validate_component(launch_id)?;
            let relative = format!("runs/{run_id}/preparation_process_launches/{file_name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let launch: FmsPreparationProcessLaunch = parse_json(&data, &relative)?;
            if launch.relative_path()? != relative {
                bail!("preparation process launch `{relative}` contains mismatched path identity")
            }
        }
        Ok(())
    }

    fn walk_run_coordinator_journal(&mut self, run_dir: &Path, run_id: &str) -> Result<()> {
        let root = run_dir.join("coordinator_journal");
        if !root.exists() {
            return Ok(());
        }
        if !root.is_dir() {
            bail!(
                "run coordinator_journal path is not a directory: {}",
                root.display()
            )
        }
        for direction in [
            FmsCoordinatorJournalDirection::Command,
            FmsCoordinatorJournalDirection::Event,
        ] {
            let directory = root.join(direction.as_str());
            if !directory.exists() {
                continue;
            }
            if !directory.is_dir() {
                bail!("coordinator journal stream is not a directory")
            }
            let mut sequences = Vec::new();
            for entry in read_directory(&directory)? {
                if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
                    bail!(
                        "unsafe coordinator journal entry `{}`",
                        entry.path().display()
                    )
                }
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let Some(entry_id) = file_name.strip_suffix(".json") else {
                    bail!("coordinator journal entry must be JSON: `{file_name}`")
                };
                validate_component(entry_id)?;
                let relative = format!(
                    "runs/{run_id}/coordinator_journal/{}/{file_name}",
                    direction.as_str()
                );
                let data = self.read_file(&entry.path(), &relative)?;
                let journal: crate::types::FmsCoordinatorJournalEntry =
                    parse_json(&data, &relative)?;
                journal.validate()?;
                if journal.run_id != run_id
                    || journal.direction != direction
                    || journal.entry_id != entry_id
                {
                    bail!("coordinator journal `{relative}` contains mismatched path identity")
                }
                sequences.push(journal);
            }
            validate_journal_streams(&sequences)?;
        }
        Ok(())
    }

    fn walk_run_artifacts(&mut self, run_dir: &Path, run_id: &str) -> Result<()> {
        let directory = run_dir.join("artifacts");
        if !directory.exists() {
            return Ok(());
        }
        if !directory.is_dir() {
            bail!(
                "run artifacts path is not a directory: {}",
                directory.display()
            )
        }
        self.walk_arbitrary_files(&directory, &format!("runs/{run_id}/artifacts"))
    }

    fn walk_arbitrary_files(&mut self, directory: &Path, prefix: &str) -> Result<()> {
        for entry in read_directory(directory)? {
            if entry.file_type()?.is_symlink() {
                bail!(
                    "symlink under session artifacts: {}",
                    entry.path().display()
                )
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("{prefix}/{name}");
            if entry.file_type()?.is_dir() {
                self.walk_arbitrary_files(&entry.path(), &relative)?;
            } else if entry.file_type()?.is_file() {
                self.read_file(&entry.path(), &relative)?;
            } else {
                bail!("unsupported session artifact entry `{relative}`")
            }
        }
        Ok(())
    }

    fn walk_session_file(&mut self, relative: &str) -> Result<()> {
        let path = self.root.join(relative);
        let data = self.read_file(&path, relative)?;
        let session: FmsSessionManifest = parse_json(&data, relative)?;
        validate_session(&session, relative)?;
        self.walk_session_roots(&session)
    }

    fn walk_session_roots(&mut self, session: &FmsSessionManifest) -> Result<()> {
        for run_ref in &session.run_refs {
            validate_file_ref(run_ref)
                .with_context(|| format!("invalid session run ref `{run_ref}`"))?;
            let Some(run_id) = run_ref
                .strip_prefix("runs/")
                .and_then(|value| value.strip_suffix("/run_manifest.json"))
            else {
                bail!("session run ref is not a run manifest: `{run_ref}`")
            };
            validate_component(run_id)?;
            let run_path = self.root.join(run_ref);
            if !run_path.exists() {
                self.missing(format!(
                    "session references missing run manifest `{run_ref}`"
                ))?;
                continue;
            }
            self.walk_run_file(run_ref, run_id)?;
        }
        Ok(())
    }

    fn walk_run_file(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        if !self.seen_files.insert(relative.to_string()) {
            return Ok(());
        }
        let path = self.root.join(relative);
        let data = self.read_file(&path, relative)?;
        let run: FmsRunManifest = parse_json(&data, relative)?;
        if run.run_id != expected_run_id {
            bail!(
                "run manifest `{relative}` contains mismatched run_id `{}`",
                run.run_id
            )
        }
        validate_component(&run.run_id)?;
        self.follow_run_reference(run.plan_ref.as_deref(), relative)?;
        self.follow_run_reference(run.live_state_ref.as_deref(), relative)?;
        if let Some(reference) = run.latest_checkpoint_ref.as_deref() {
            self.follow_checkpoint_reference(reference, relative)?;
        }
        if let Some(reference) = run.artifact_index_ref.as_deref() {
            self.follow_reference(reference, relative, ReferenceKind::ArtifactIndex)?;
        }
        Ok(())
    }

    fn walk_run_intent_file(&mut self, path: &Path, expected_run_id: &str) -> Result<()> {
        let relative = format!("runs/{expected_run_id}/run_intent.json");
        let data = self.read_file(path, &relative)?;
        let intent: FmsRunIntent = parse_json(&data, &relative)?;
        intent.validate()?;
        if intent.run_id != expected_run_id {
            bail!(
                "run intent `{relative}` contains mismatched run_id `{}`",
                intent.run_id
            )
        }
        if let Some(object_ref) = intent.definition_object_ref.as_deref() {
            self.follow_store_object_ref(object_ref, &relative, "run definition")?;
        }
        if let Some(object_ref) = intent.study_object_ref.as_deref() {
            self.follow_store_object_ref(object_ref, &relative, "run study")?;
        }
        if let Some(object_ref) = intent.study_catalog_object_ref.as_deref() {
            self.follow_store_object_ref(object_ref, &relative, "run study catalog")?;
        }
        for object_ref in intent.asset_object_refs.values() {
            self.follow_store_object_ref(object_ref, &relative, "run asset")?;
        }
        Ok(())
    }

    fn walk_run_catalog_file(&mut self, path: &Path, expected_run_id: &str) -> Result<()> {
        let relative = format!("runs/{expected_run_id}/run_catalog.json");
        let data = self.read_file(path, &relative)?;
        let catalog: FmsRunCatalog = parse_json(&data, &relative)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!(
                "run catalog `{relative}` contains mismatched run_id `{}`",
                catalog.run_id
            )
        }
        Ok(())
    }

    fn walk_artifact_catalog_file(&mut self, path: &Path, expected_run_id: &str) -> Result<()> {
        let relative = format!("runs/{expected_run_id}/artifact_catalog.json");
        let data = self.read_file(path, &relative)?;
        let catalog: FmsArtifactCatalog = parse_json(&data, &relative)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!(
                "artifact catalog `{relative}` contains mismatched run_id `{}`",
                catalog.run_id
            )
        }
        for entry in &catalog.entries {
            if let Some(object_ref) = entry.object_ref.as_deref() {
                self.follow_store_object_ref(object_ref, &relative, "artifact catalog")?;
            }
        }
        Ok(())
    }

    fn walk_preparation_receipt_file(&mut self, path: &Path, expected_run_id: &str) -> Result<()> {
        let relative = format!("runs/{expected_run_id}/preparation_receipt.json");
        let data = self.read_file(path, &relative)?;
        let receipt: FmsPreparationReceipt = parse_json(&data, &relative)?;
        receipt.validate()?;
        if receipt.run_id != expected_run_id {
            bail!(
                "preparation receipt `{relative}` contains mismatched run_id `{}`",
                receipt.run_id
            )
        }
        Ok(())
    }

    fn walk_task_preparation_receipts(
        &mut self,
        run_path: &Path,
        expected_run_id: &str,
    ) -> Result<()> {
        let directory = run_path.join("task_preparation_receipts");
        crate::repository_path::reject_link(&directory)?;
        if !directory.exists() {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!(
                "unsafe task preparation receipt directory `{}`",
                directory.display()
            );
        }
        let entries = read_directory(&directory)?;
        if entries.is_empty() {
            return Ok(());
        }
        let catalog_relative = format!("runs/{expected_run_id}/run_catalog.json");
        let catalog_path = run_path.join("run_catalog.json");
        let catalog_data = self.read_file(&catalog_path, &catalog_relative)?;
        let catalog: FmsRunCatalog = parse_json(&catalog_data, &catalog_relative)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!("task preparation receipt catalog identity does not match run path");
        }
        let intent_relative = format!("runs/{expected_run_id}/run_intent.json");
        let intent_path = run_path.join("run_intent.json");
        let intent_data = self.read_file(&intent_path, &intent_relative)?;
        let intent: FmsRunIntent = parse_json(&intent_data, &intent_relative)?;
        intent.validate()?;
        for entry in entries {
            crate::repository_path::reject_link(&entry.path())?;
            if !entry.file_type()?.is_file() {
                bail!("task preparation receipt entry must be a file");
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("runs/{expected_run_id}/task_preparation_receipts/{file_name}");
            let data = self.read_file(&entry.path(), &relative)?;
            let receipt: FmsTaskPreparationReceipt = parse_json(&data, &relative)?;
            if receipt.relative_path()? != relative {
                bail!("task preparation receipt path identity mismatch");
            }
            receipt.validate_for_catalog(&catalog)?;
            receipt.validate_for_run_intent(&intent)?;
        }
        Ok(())
    }

    fn walk_run_task_admissions(&mut self, run_path: &Path, expected_run_id: &str) -> Result<()> {
        let root = run_path.join("task_admissions");
        crate::repository_path::reject_link(&root)?;
        if !root.exists() {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(&root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("unsafe task admission directory `{}`", root.display());
        }
        let task_dirs = read_directory(&root)?;
        if task_dirs.is_empty() {
            return Ok(());
        }
        let catalog_relative = format!("runs/{expected_run_id}/run_catalog.json");
        let catalog_path = run_path.join("run_catalog.json");
        let catalog_data = self.read_file(&catalog_path, &catalog_relative)?;
        let catalog: FmsRunCatalog = parse_json(&catalog_data, &catalog_relative)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!("task admission catalog identity does not match run path");
        }
        for task_dir in task_dirs {
            crate::repository_path::reject_link(&task_dir.path())?;
            if !task_dir.file_type()?.is_dir() {
                bail!("task admission task entry must be a directory");
            }
            let task_id = task_dir.file_name().to_string_lossy().into_owned();
            validate_component(&task_id)?;
            for entry in read_directory(&task_dir.path())? {
                crate::repository_path::reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    bail!("task admission record must be a regular file");
                }
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let Some(attempt_id) = file_name.strip_suffix(".json") else {
                    bail!("task admission record must be JSON: `{file_name}`");
                };
                validate_component(attempt_id)?;
                let relative =
                    format!("runs/{expected_run_id}/task_admissions/{task_id}/{file_name}");
                let data = self.read_file(&entry.path(), &relative)?;
                let record: FmsTaskAdmissionRecord = parse_json(&data, &relative)?;
                record.validate()?;
                if record.lease.run_id != expected_run_id
                    || record.task.task_id != task_id
                    || record.lease.attempt_id != attempt_id
                {
                    bail!("task admission identity does not match its path");
                }
                let current = catalog
                    .tasks
                    .iter()
                    .find(|task| task.task_id == task_id)
                    .context("task admission target is missing from the run catalog")?;
                if current.input_fingerprint != record.task.input_fingerprint {
                    bail!("task admission input fingerprint differs from the run catalog");
                }
            }
        }
        Ok(())
    }

    fn follow_run_reference(&mut self, reference: Option<&str>, source: &str) -> Result<()> {
        let Some(reference) = reference else {
            return Ok(());
        };
        self.follow_reference(reference, source, ReferenceKind::Unknown)
    }

    fn follow_checkpoint_reference(&mut self, reference: &str, source: &str) -> Result<()> {
        validate_file_ref(reference)
            .with_context(|| format!("invalid checkpoint reference `{reference}` in `{source}`"))?;
        let Some(rest) = reference.strip_prefix("runs/") else {
            return self.follow_reference(reference, source, ReferenceKind::Unknown);
        };
        let Some((run_id, checkpoint_id)) = rest
            .strip_suffix("/checkpoint.json")
            .and_then(|value| value.split_once("/checkpoints/"))
        else {
            return self.follow_reference(reference, source, ReferenceKind::Unknown);
        };
        self.walk_checkpoint_file(reference, run_id, checkpoint_id)
    }

    fn walk_checkpoint_file(
        &mut self,
        relative: &str,
        expected_run_id: &str,
        expected_checkpoint_id: &str,
    ) -> Result<()> {
        if !self.seen_checkpoints.insert(relative.to_string()) {
            return Ok(());
        }
        let path = self.root.join(relative);
        let data = self.read_file(&path, relative)?;
        let checkpoint: FmsCheckpoint = parse_json(&data, relative)?;
        validate_checkpoint(
            &checkpoint,
            expected_run_id,
            expected_checkpoint_id,
            relative,
        )?;
        self.walk_checkpoint_value(&checkpoint, relative)
    }

    fn walk_checkpoint_value(&mut self, checkpoint: &FmsCheckpoint, relative: &str) -> Result<()> {
        self.report.checkpoint_count = self.report.checkpoint_count.saturating_add(1);
        let warning_count_before_checkpoint = self.report.warnings.len();
        self.follow_reference(
            &checkpoint.common_state_ref,
            relative,
            ReferenceKind::CommonState,
        )?;
        self.validate_checkpoint_common_state(checkpoint, relative)?;
        let warning_count_after_common_state = self.report.warnings.len();
        let warning_count_before_restart = self.report.warnings.len();
        for (reference, kind) in [
            (
                checkpoint.integrator_ref.as_deref(),
                ReferenceKind::IntegratorPayload,
            ),
            (checkpoint.rng_ref.as_deref(), ReferenceKind::RngPayload),
            (
                checkpoint.backend_state_ref.as_deref(),
                ReferenceKind::BackendState,
            ),
        ] {
            if let Some(reference) = reference {
                validate_checkpoint_payload_ref(&checkpoint, reference, relative)?;
                self.follow_reference(reference, relative, kind)?;
            }
        }
        let restart_complete = if warning_count_after_common_state
            == warning_count_before_checkpoint
            && self.report.warnings.len() == warning_count_before_restart
            && (checkpoint.integrator_ref.is_some()
                || checkpoint.rng_ref.is_some()
                || checkpoint.backend_state_ref.is_some())
        {
            self.report.restart_payload_count = self.report.restart_payload_count.saturating_add(1);
            true
        } else {
            false
        };
        let mut primary_complete = false;
        for field in &checkpoint.field_refs {
            validate_object_ref(&field.tensor_descriptor_ref)
                .with_context(|| format!("invalid tensor descriptor ref in `{relative}`"))?;
            self.add_object(&field.tensor_descriptor_ref);
            let descriptor_ref = &field.tensor_descriptor_ref;
            reject_link_chain(&self.root, &format!("objects/sha256/{descriptor_ref}"))?;
            let descriptor_path = self.root.join("objects/sha256").join(descriptor_ref);
            if !descriptor_path.exists() {
                self.missing(format!(
                    "checkpoint `{relative}` references missing tensor descriptor `{descriptor_ref}`"
                ))?;
                continue;
            }
            // Store and archive callers validate the descriptor bytes through
            // their respective readers; this hook only records its transitives.
            let warning_count_before_field = self.report.warnings.len();
            let payload_complete = self.follow_descriptor_reference(descriptor_ref, relative)?;
            if field.role == FieldRole::Primary && payload_complete {
                primary_complete |= warning_count_before_field == self.report.warnings.len();
                self.report.primary_payload_count =
                    self.report.primary_payload_count.saturating_add(1);
            }
        }
        self.report.checkpoint_status.insert(
            relative.to_string(),
            CheckpointPayloadStatus {
                primary: primary_complete
                    && warning_count_after_common_state == warning_count_before_checkpoint,
                restart: restart_complete,
            },
        );
        Ok(())
    }

    fn follow_descriptor_reference(&mut self, descriptor_ref: &str, source: &str) -> Result<bool> {
        let path = self
            .root
            .join("objects")
            .join("sha256")
            .join(descriptor_ref);
        reject_link_chain(&self.root, &format!("objects/sha256/{descriptor_ref}"))?;
        let data = fs::read(&path)
            .with_context(|| format!("reading tensor descriptor `{descriptor_ref}`"))?;
        if crate::cas::hex_sha256(&data) != descriptor_ref {
            bail!("CAS SHA-256 mismatch for tensor descriptor `{descriptor_ref}`")
        }
        let descriptor: TensorDescriptor =
            parse_json(&data, &format!("objects/sha256/{descriptor_ref}"))?;
        validate_descriptor(&descriptor, descriptor_ref, source)?;
        for chunk in descriptor.chunks {
            if !self.add_chunk(&chunk.object_ref, chunk.length, source)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn add_chunk(
        &mut self,
        object_ref: &str,
        expected_length: usize,
        source: &str,
    ) -> Result<bool> {
        validate_object_ref(object_ref)
            .with_context(|| format!("invalid tensor chunk ref in `{source}`"))?;
        self.add_object(object_ref);
        let path = self.root.join("objects/sha256").join(object_ref);
        reject_link_chain(&self.root, &format!("objects/sha256/{object_ref}"))?;
        if !path.exists() {
            self.missing(format!(
                "checkpoint `{source}` references missing tensor chunk `{object_ref}`"
            ))?;
            return Ok(false);
        } else {
            let data =
                fs::read(&path).with_context(|| format!("reading tensor chunk `{object_ref}`"))?;
            if crate::cas::hex_sha256(&data) != object_ref {
                bail!("CAS SHA-256 mismatch for tensor chunk `{object_ref}`")
            }
            if data.len() != expected_length {
                bail!("tensor chunk `{object_ref}` length does not match its descriptor range")
            }
        }
        Ok(true)
    }

    fn follow_reference(
        &mut self,
        reference: &str,
        source: &str,
        kind: ReferenceKind,
    ) -> Result<()> {
        if is_object_ref(reference) {
            self.add_object(reference);
            let object_path = self.root.join("objects/sha256").join(reference);
            reject_link_chain(&self.root, &format!("objects/sha256/{reference}"))?;
            if !object_path.exists() {
                self.missing(format!(
                    "`{source}` references missing object `{reference}`"
                ))?;
            } else {
                let data = fs::read(&object_path)?;
                if crate::cas::hex_sha256(&data) != reference {
                    bail!("CAS SHA-256 mismatch for object `{reference}`")
                }
                self.follow_store_payload(&data, source, kind)?;
            }
            return Ok(());
        }
        validate_file_ref(reference)
            .with_context(|| format!("invalid reference `{reference}` in `{source}`"))?;
        self.report.file_refs.insert(reference.to_string());
        let path = self.root.join(reference);
        if !path.exists() {
            self.missing(format!("`{source}` references missing file `{reference}`"))?;
            return Ok(());
        }
        let data = self.read_file(&path, reference)?;
        self.follow_store_payload(&data, reference, kind)
    }

    fn follow_store_payload(
        &mut self,
        data: &[u8],
        source: &str,
        kind: ReferenceKind,
    ) -> Result<()> {
        match kind {
            ReferenceKind::CommonState => {
                let state: CommonSolverState = parse_json(data, source)?;
                if let Some(object_ref) = state.magnetization_ref {
                    self.follow_store_object_ref(&object_ref, source, "common state")?;
                }
            }
            ReferenceKind::ArtifactIndex => {
                let index: ArtifactIndex = parse_json(data, source)?;
                for entry in index.entries {
                    if let Some(object_ref) = entry.object_ref {
                        self.follow_store_object_ref(&object_ref, source, "artifact index")?;
                    }
                }
            }
            ReferenceKind::BackendState => {
                if validate_restart_payload(data, kind, source)? {
                    self.report.conservative(format!(
                        "opaque backend restart state `{source}` in backend_state payload requires conservative retention"
                    ));
                }
            }
            ReferenceKind::IntegratorPayload | ReferenceKind::RngPayload => {
                if validate_restart_payload(data, kind, source)? {
                    self.report.conservative(format!(
                        "opaque integrator restart payload `{source}` requires conservative retention"
                    ));
                }
            }
            ReferenceKind::Unknown => {
                // Opaque plan/live documents may carry CAS references that
                // this walker cannot interpret.  Retaining the file itself is
                // insufficient for a safe mark set, so GC/export stays
                // incomplete until the document schema gets a typed walker.
                self.report.mark_blocking_incomplete(format!(
                    "untyped session reference `{source}` requires conservative retention"
                ));
            }
        }
        Ok(())
    }

    fn validate_checkpoint_common_state(
        &mut self,
        checkpoint: &FmsCheckpoint,
        source: &str,
    ) -> Result<()> {
        let path = self.root.join(&checkpoint.common_state_ref);
        if !path.exists() {
            return Ok(());
        }
        let data = self.read_file(&path, &checkpoint.common_state_ref)?;
        let state: CommonSolverState = parse_json(&data, &checkpoint.common_state_ref)?;
        validate_common_state_identity(checkpoint, &state, source)
    }

    fn follow_store_object_ref(
        &mut self,
        object_ref: &str,
        source: &str,
        kind: &str,
    ) -> Result<()> {
        validate_object_ref(object_ref)
            .with_context(|| format!("invalid {kind} object reference in `{source}`"))?;
        self.add_object(object_ref);
        let object_path = self.root.join("objects/sha256").join(object_ref);
        reject_link_chain(&self.root, &format!("objects/sha256/{object_ref}"))?;
        if !object_path.exists() {
            self.missing(format!(
                "{kind} `{source}` references missing object `{object_ref}`"
            ))?;
        } else {
            let data = fs::read(&object_path)?;
            if crate::cas::hex_sha256(&data) != object_ref {
                bail!("CAS SHA-256 mismatch for {kind} object `{object_ref}`")
            }
        }
        Ok(())
    }

    fn add_object(&mut self, object_ref: &str) {
        self.report.object_refs.insert(object_ref.to_string());
    }

    fn read_file(&mut self, path: &Path, relative: &str) -> Result<Vec<u8>> {
        validate_file_ref(relative)?;
        reject_link_chain(&self.root, relative)?;
        self.report.file_refs.insert(relative.to_string());
        if !self.seen_files.insert(relative.to_string()) {
            return fs::read(path).with_context(|| format!("reading session file `{relative}`"));
        }
        fs::read(path).with_context(|| format!("reading session file `{relative}`"))
    }
}

#[derive(Debug, Clone, Copy)]
enum ReferenceKind {
    Unknown,
    CommonState,
    ArtifactIndex,
    BackendState,
    IntegratorPayload,
    RngPayload,
}

struct ArchiveWalker<'a> {
    documents: ArchiveDocuments<'a>,
    cas_root: Option<&'a Path>,
    mode: ReachabilityMode,
    report: ReachabilityReport,
    seen_checkpoints: HashSet<String>,
    tensor_descriptor_cache: Option<(String, TensorDescriptor)>,
    namespace_files: HashSet<String>,
    unclassified_paths: HashSet<String>,
}

impl<'a> ArchiveWalker<'a> {
    fn object_length(&self, object_ref: &str) -> Result<Option<u64>> {
        validate_object_ref(object_ref)?;
        let relative = format!("objects/sha256/{object_ref}");
        if let Some(root) = self.cas_root {
            reject_link_chain(root, &relative)?;
            let path = root.join(&relative);
            match fs::symlink_metadata(&path) {
                Ok(_) => {
                    return crate::cas::verified_file_length(&path, object_ref)
                        .with_context(|| format!("CAS SHA-256 verification failed for `{relative}`"))
                        .map(Some);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            }
        }
        let Some(data) = self.documents.read(&relative)? else {
            return Ok(None);
        };
        if crate::cas::hex_sha256(&data) != object_ref {
            bail!("CAS SHA-256 mismatch for `{relative}`");
        }
        Ok(Some(u64::try_from(data.len())?))
    }

    fn object_document(&self, object_ref: &str) -> Result<Vec<u8>> {
        let relative = format!("objects/sha256/{object_ref}");
        if let Some(root) = self.cas_root {
            use std::io::Read;
            const MAX_EXPORT_OBJECT_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
            reject_link_chain(root, &relative)?;
            let mut data = Vec::new();
            fs::File::open(root.join(&relative))?
                .take(MAX_EXPORT_OBJECT_DOCUMENT_BYTES + 1)
                .read_to_end(&mut data)?;
            if data.len() as u64 > MAX_EXPORT_OBJECT_DOCUMENT_BYTES {
                bail!("structural CAS document `{object_ref}` exceeds export metadata budget");
            }
            if crate::cas::hex_sha256(&data) != object_ref {
                bail!("CAS SHA-256 mismatch for `{relative}`");
            }
            return Ok(data);
        }
        self.documents.read(&relative)?.map(|data| data.into_owned()).context("validated archive object disappeared")
    }

    fn walk_archive(&mut self) -> Result<ReachabilityReport> {
        self.validate_archive_namespace()?;
        self.walk_archive_live_snapshot()?;
        self.walk_archive_solutions()?;
        if let Some(data) = self.documents.read("manifest/session.json")? {
            let session: FmsSessionManifest = parse_json(&data, "manifest/session.json")?;
            validate_session(&session, "manifest/session.json")?;
            for run_ref in &session.run_refs {
                validate_file_ref(run_ref)?;
                if let Some(run_id) = run_ref
                    .strip_prefix("runs/")
                    .and_then(|value| value.strip_suffix("/run_manifest.json"))
                {
                    self.walk_run(run_ref, run_id)?;
                } else {
                    bail!("session run ref is not a run manifest: `{run_ref}`")
                }
            }
        }

        // A portable archive may contain a run that was not selected by the
        // session manifest.  It is still a root during preflight; dropping it
        // would make import/export silently lose data.
        let names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in names {
            if name.starts_with("runs/") && name.ends_with("/run_manifest.json") {
                let Some(run_id) = name
                    .strip_prefix("runs/")
                    .and_then(|value| value.strip_suffix("/run_manifest.json"))
                else {
                    continue;
                };
                validate_component(run_id)?;
                self.walk_run(&name, run_id)?;
            }
        }

        // Accepted runs may have a durable intent/catalog before a solver run
        // manifest exists. Validate task receipts in that state as well so an
        // unrooted archive document is never imported as an opaque control file.
        let receipt_prefix = "runs/";
        let receipt_marker = "/task_preparation_receipts/";
        let receipt_runs = self
            .documents
            .keys()
            .filter_map(|name| {
                let rest = name.strip_prefix(receipt_prefix)?;
                let (run_id, _) = rest.split_once(receipt_marker)?;
                Some(run_id.to_string())
            })
            .collect::<HashSet<_>>();
        for run_id in receipt_runs {
            validate_component(&run_id)?;
            let run_manifest_ref = format!("runs/{run_id}/run_manifest.json");
            if !self.documents.contains_key(&run_manifest_ref) {
                self.walk_task_preparation_receipts(&run_id)?;
            }
        }

        // Preparation may acquire capacity before a solver run manifest
        // exists. Treat those leases as roots so accepted-run archives cannot
        // smuggle an unvalidated control document through import preflight.
        let preparation_lease_marker = "/preparation_resource_leases/";
        let preparation_lease_runs = self
            .documents
            .keys()
            .filter_map(|name| {
                let rest = name.strip_prefix("runs/")?;
                let (run_id, _) = rest.split_once(preparation_lease_marker)?;
                Some(run_id.to_string())
            })
            .collect::<HashSet<_>>();
        for run_id in preparation_lease_runs {
            validate_component(&run_id)?;
            let run_manifest_ref = format!("runs/{run_id}/run_manifest.json");
            if self.documents.contains_key(&run_manifest_ref) {
                continue;
            }
            let lease_prefix = format!("runs/{run_id}/preparation_resource_leases/");
            let lease_names = self.documents.keys().cloned().collect::<Vec<_>>();
            for name in lease_names {
                if name.starts_with(&lease_prefix) && name.ends_with(".json") {
                    self.walk_preparation_resource_lease(&name, &run_id)?;
                }
            }
        }

        let preparation_launch_marker = "/preparation_process_launches/";
        let preparation_launch_runs = self
            .documents
            .keys()
            .filter_map(|name| {
                let rest = name.strip_prefix("runs/")?;
                let (run_id, _) = rest.split_once(preparation_launch_marker)?;
                Some(run_id.to_string())
            })
            .collect::<HashSet<_>>();
        for run_id in preparation_launch_runs {
            validate_component(&run_id)?;
            let run_manifest_ref = format!("runs/{run_id}/run_manifest.json");
            if self.documents.contains_key(&run_manifest_ref) {
                continue;
            }
            let prefix = format!("runs/{run_id}/preparation_process_launches/");
            let names = self.documents.keys().cloned().collect::<Vec<_>>();
            for name in names {
                if name.starts_with(&prefix) && name.ends_with(".json") {
                    self.walk_preparation_process_launch(&name, &run_id)?;
                }
            }
        }

        let preparation_exit_marker = "/preparation_process_exit_receipts/";
        let preparation_exit_runs = self
            .documents
            .keys()
            .filter_map(|name| {
                let rest = name.strip_prefix("runs/")?;
                let (run_id, _) = rest.split_once(preparation_exit_marker)?;
                Some(run_id.to_string())
            })
            .collect::<HashSet<_>>();
        for run_id in preparation_exit_runs {
            validate_component(&run_id)?;
            let run_manifest_ref = format!("runs/{run_id}/run_manifest.json");
            if self.documents.contains_key(&run_manifest_ref) {
                continue;
            }
            let prefix = format!("runs/{run_id}/preparation_process_exit_receipts/");
            let names = self.documents.keys().cloned().collect::<Vec<_>>();
            for name in names {
                if name.starts_with(&prefix) && name.ends_with(".json") {
                    self.walk_preparation_process_exit_receipt(&name, &run_id)?;
                }
            }
        }

        let preparation_retry_marker = "/preparation_retry_decisions/";
        let preparation_retry_runs = self
            .documents
            .keys()
            .filter_map(|name| {
                let rest = name.strip_prefix("runs/")?;
                let (run_id, _) = rest.split_once(preparation_retry_marker)?;
                Some(run_id.to_string())
            })
            .collect::<HashSet<_>>();
        for run_id in preparation_retry_runs {
            validate_component(&run_id)?;
            let run_manifest_ref = format!("runs/{run_id}/run_manifest.json");
            if self.documents.contains_key(&run_manifest_ref) {
                continue;
            }
            let prefix = format!("runs/{run_id}/preparation_retry_decisions/");
            let names = self.documents.keys().cloned().collect::<Vec<_>>();
            for name in names {
                if name.starts_with(&prefix) && name.ends_with(".json") {
                    self.walk_preparation_retry_decision(&name, &run_id)?;
                }
            }
        }

        // Export planning may intentionally pass only the selected run
        // entries (without the top-level session manifest).  Checkpoints are
        // still roots in that view and must receive the same traversal.
        let names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in names {
            if !name.starts_with("runs/") || !name.ends_with("/checkpoint.json") {
                continue;
            }
            let Some(rest) = name.strip_prefix("runs/") else {
                continue;
            };
            let Some((run_id, checkpoint_id)) =
                rest.split_once("/checkpoints/").and_then(|(run_id, tail)| {
                    tail.strip_suffix("/checkpoint.json").map(|id| (run_id, id))
                })
            else {
                bail!("invalid checkpoint path `{name}`")
            };
            if run_id.is_empty()
                || checkpoint_id.is_empty()
                || run_id.contains('/')
                || checkpoint_id.contains('/')
            {
                bail!("invalid checkpoint path `{name}`")
            }
            validate_component(run_id)?;
            validate_component(checkpoint_id)?;
            self.walk_checkpoint(&name, run_id, checkpoint_id)?;
        }

        self.finalize_namespace_coverage();

        if matches!(self.mode, ReachabilityMode::Gc) && !self.report.complete {
            self.report.require_complete()?;
        }
        Ok(std::mem::take(&mut self.report))
    }

    fn finalize_namespace_coverage(&mut self) {
        let mut paths = self.namespace_files.iter().collect::<Vec<_>>();
        paths.sort();
        for relative in paths {
            if self.report.file_refs.contains(relative) {
                continue;
            }
            let kind = if self.unclassified_paths.contains(relative) {
                "unknown archive run document"
            } else {
                "unconsumed archive run document"
            };
            self.report.conservative(format!(
                "{kind} `{relative}` requires conservative retention"
            ));
        }
    }

    fn walk_archive_live_snapshot(&mut self) -> Result<()> {
        const NAME: &str = "project/current_live_snapshot.json";
        let Some(data) = self.documents.read(NAME)? else {
            return Ok(());
        };
        self.report.file_refs.insert(NAME.to_string());
        let inspection = crate::typed_documents::inspect_live_snapshot(&data);
        match inspection.object_refs {
            Ok(object_refs) => {
                for object_ref in object_refs {
                    self.add_archive_payload(&object_ref, NAME, None)?;
                }
            }
            Err(reason) => self.report.mark_opaque_project_document(format!(
                "archive project document `{NAME}` has untyped object references ({reason}); conservative retention required"
            )),
        }
        match inspection.artifact_refs {
            Ok(artifact_refs) => {
                self.follow_archive_live_snapshot_artifacts(&artifact_refs, NAME)?;
            }
            Err(reason) => self.report.mark_blocking_incomplete(format!(
                "archive project document `{NAME}` has invalid live artifact references ({reason}); conservative retention required"
            )),
        }
        Ok(())
    }

    fn follow_archive_live_snapshot_artifacts(
        &mut self,
        references: &LiveSnapshotArtifactReferences,
        source: &str,
    ) -> Result<()> {
        for artifact in &references.artifacts {
            let relative = live_snapshot_artifact_path(&references.run_id, &artifact.path)
                .with_context(|| format!("invalid live artifact reference in `{source}`"))?;
            let exact_member = self.documents.contains_key(&relative);
            let prefix = format!("{relative}/");
            let descendants = self
                .documents
                .keys()
                .filter(|name| name.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            if exact_member && !descendants.is_empty() {
                bail!("archive live artifact `{relative}` is both a file and a subtree");
            }
            if exact_member {
                if !self.archive_live_artifact_member_present(&relative)? {
                    self.report.missing(format!(
                        "live snapshot `{source}` references missing archived artifact `{relative}`"
                    ))?;
                }
            } else if artifact.kind == "zarr" && !descendants.is_empty() {
                for member in descendants {
                    if !self.archive_live_artifact_member_present(&member)? {
                        self.report.missing(format!(
                            "live snapshot `{source}` references missing archived Zarr member `{member}`"
                        ))?;
                    }
                }
            } else {
                self.report.missing(format!(
                    "live snapshot `{source}` references missing archived artifact `{relative}`"
                ))?;
            }
        }
        Ok(())
    }

    fn archive_live_artifact_member_present(&self, relative: &str) -> Result<bool> {
        if !self.documents.contains_key(relative) {
            return Ok(false);
        }
        let Some(root) = self.cas_root else {
            return Ok(true);
        };
        reject_link_chain(root, relative)?;
        match fs::symlink_metadata(root.join(relative)) {
            Ok(metadata) if metadata.is_file() => Ok(true),
            Ok(_) => bail!("archived live artifact member `{relative}` is not a regular file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("checking archived artifact `{relative}`")),
        }
    }

    fn validate_archive_namespace(&mut self) -> Result<()> {
        const KNOWN_PROJECT_LEAFS: &[&str] = &[
            "main.py",
            "problem_ir.json",
            "scene_document.json",
            "script_builder.json",
            "model_builder_graph.json",
            "ui_state.json",
            "current_live_snapshot.json",
            "asset_index.json",
        ];
        for name in self.documents.keys() {
            validate_file_ref(name)?;
            let Some((namespace, remainder)) = name.split_once('/') else {
                bail!("archive document is outside a known namespace `{name}`")
            };
            match namespace {
                "manifest" => {
                    if !matches!(
                        name.as_str(),
                        "manifest/session.json"
                            | "manifest/workspace.json"
                            | "manifest/export_profile.json"
                    ) {
                        bail!("unknown archive manifest document `{name}`")
                    }
                }
                "project" => {
                    if !KNOWN_PROJECT_LEAFS.contains(&remainder) {
                        self.report.mark_blocking_incomplete(format!(
                            "unknown archive project document `{name}` requires conservative retention"
                        ));
                    } else if remainder == "asset_index.json" {
                        self.report.mark_opaque_project_document(format!(
                            "archive project document `{name}` has untyped object references; conservative retention required"
                        ));
                    }
                }
                "runs" => match classify_run_path(name)? {
                    RunPathKind::KnownRecord => {
                        self.namespace_files.insert(name.clone());
                    }
                    RunPathKind::OpaqueArtifact => {
                        // Artifacts are intentionally opaque binary leaves, but
                        // they still belong to the imported/exported graph.
                        self.report.file_refs.insert(name.clone());
                    }
                    RunPathKind::Unknown => {
                        self.namespace_files.insert(name.clone());
                        self.unclassified_paths.insert(name.clone());
                    }
                },
                "solutions" => validate_solution_archive_path(name)?,
                "objects" => {
                    let Some(object_ref) = name.strip_prefix("objects/sha256/") else {
                        bail!("unknown archive objects document `{name}`")
                    };
                    validate_object_ref(object_ref)?;
                }
                _ => bail!("unknown archive document namespace `{namespace}`"),
            }
        }
        Ok(())
    }

    fn walk_archive_solutions(&mut self) -> Result<()> {
        let directories = self
            .documents
            .keys()
            .filter_map(|name| {
                let remainder = name.strip_prefix("solutions/")?;
                let (directory, _) = remainder.split_once('/')?;
                Some(directory.to_string())
            })
            .collect::<HashSet<_>>();
        for directory in directories {
            validate_object_ref(&directory)?;
            let current_path = format!("solutions/{directory}/manifest.json");
            let current = self
                .documents
                .read(&current_path)?
                .map(|data| -> Result<SolutionSet> {
                    let solution = parse_json(&data, &current_path)?;
                    self.validate_archive_solution_identity(
                        &solution,
                        &directory,
                        None,
                        &current_path,
                    )?;
                    self.walk_archive_solution_objects(&solution, &current_path)?;
                    self.report.file_refs.insert(current_path.clone());
                    Ok(solution)
                })
                .transpose()?;

            let revision_prefix = format!("solutions/{directory}/revisions/");
            // Keep only revision paths, then validate one adjacent pair at a time.
            let mut revisions = BTreeMap::new();
            for name in self.documents.keys() {
                let Some(file_name) = name.strip_prefix(&revision_prefix) else {
                    continue;
                };
                let revision = parse_solution_revision_filename(file_name)?;
                if revisions.insert(revision, name.clone()).is_some() {
                    bail!("duplicate solution-set revision `{revision}`")
                }
            }

            let mut previous: Option<SolutionSet> = None;
            let mut current_matched = current.is_none();
            for (index, (revision, name)) in revisions.iter().enumerate() {
                let expected =
                    u64::try_from(index + 1).context("solution-set revision overflow")?;
                if *revision != expected {
                    bail!("solution-set revision history has a gap")
                }
                let solution: SolutionSet = {
                    let data = self.documents.read(name)?
                        .context("solution-set revision disappeared during archive walk")?;
                    parse_json(&data, name)?
                };
                self.validate_archive_solution_identity(
                    &solution, &directory, Some(*revision), name,
                )?;
                self.walk_archive_solution_objects(&solution, name)?;
                self.report.file_refs.insert(name.clone());
                if let Some(previous) = &previous {
                    crate::solution_set_catalog::validate_successor(previous, &solution)?;
                }
                if let Some(current) = &current {
                    if current.revision == *revision {
                        if current != &solution {
                            bail!("solution-set current manifest conflicts with immutable history")
                        }
                        current_matched = true;
                    }
                }
                previous = Some(solution);
            }
            if !current_matched {
                bail!("solution-set current revision is missing from immutable history")
            }
        }
        Ok(())
    }

    fn validate_archive_solution_identity(
        &self,
        solution: &SolutionSet,
        directory: &str,
        expected_revision: Option<u64>,
        source: &str,
    ) -> Result<()> {
        solution
            .validate()
            .with_context(|| format!("validating solution set `{source}`"))?;
        if crate::cas::hex_sha256(solution.solution_set_id.as_bytes()) != directory {
            bail!("solution-set directory does not match logical identity")
        }
        if expected_revision.is_some_and(|revision| solution.revision != revision) {
            bail!("solution-set revision path identity mismatch")
        }
        Ok(())
    }

    fn walk_archive_solution_objects(
        &mut self,
        solution: &SolutionSet,
        source: &str,
    ) -> Result<()> {
        let mut dataset_revisions = BTreeSet::new();
        let mut geometry_sources = BTreeSet::new();
        let has_typed_tensor_root = solution
            .members
            .iter()
            .flat_map(|member| &member.artifacts)
            .any(|artifact| {
                artifact.schema_id == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA
                    || artifact.schema_id
                        == crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
                    || artifact.schema_id
                        == crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA
            });
        if has_typed_tensor_root {
            self.follow_solution_run_owner(solution)?;
        }
        for member in &solution.members {
            for artifact in &member.artifacts {
                match artifact.schema_id.as_str() {
                    crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA => {
                        let _ = self.add_archive_solution_tensor_artifact(artifact, source)?;
                    }
                    crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA => {
                        self.add_archive_materialized_dataset_artifact(
                            artifact,
                            solution,
                            &member.member_id,
                            &mut dataset_revisions,
                            source,
                        )?;
                    }
                    crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA => {
                        self.add_archive_field_geometry_artifact(
                            artifact, solution, &member.member_id, &mut geometry_sources, source,
                        )?;
                    }
                    _ => {
                        self.add_archive_solution_object(
                            &artifact.object_ref,
                            artifact.byte_length,
                            source,
                        )?;
                    }
                }
            }
        }
        for coverage in &solution.coverage {
            for segment in &coverage.segments {
                self.add_archive_solution_object(&segment.object_ref, segment.byte_length, source)?;
            }
        }
        Ok(())
    }

    fn follow_solution_run_owner(&mut self, solution: &SolutionSet) -> Result<()> {
        crate::repository_path::validate_store_id(&solution.run_id)?;
        let relative = format!("runs/{}/run_intent.json", solution.run_id);
        let bytes = self.documents.read(&relative)?
            .context("typed solution tensor requires its archived run intent owner")?;
        if bytes.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
            bail!("solution tensor run intent exceeds metadata budget");
        }
        let intent: FmsRunIntent = parse_json(&bytes, &relative)?;
        intent.validate()?;
        if intent.run_id != solution.run_id
            || format!("sha256:{}", intent.payload_sha256) != solution.provenance.run_spec_digest
        {
            bail!("archived solution tensor RunSpec owner mismatch");
        }
        drop(bytes);
        self.walk_run_intent(&relative, &solution.run_id)
    }

    fn add_archive_solution_tensor_artifact(
        &mut self,
        artifact: &fullmag_quantities::SolutionArtifactRef,
        source: &str,
    ) -> Result<Option<TensorDescriptor>> {
        crate::solution_tensor_source::validate_metadata_length(artifact)?;
        if let Some((object_ref, descriptor)) = self.tensor_descriptor_cache.as_ref() {
            if object_ref == &artifact.object_ref {
                let descriptor = descriptor.clone();
                self.add_archive_solution_object(
                    &artifact.object_ref,
                    artifact.byte_length,
                    source,
                )?;
                return Ok(Some(descriptor));
            }
        }
        self.report.object_refs.insert(artifact.object_ref.clone());
        let Some(bytes) = self.bounded_archive_object(
            &artifact.object_ref,
            crate::solution_tensor_source::MAX_SOLUTION_TENSOR_METADATA_BYTES,
        )? else {
            self.report.missing(format!(
                "solution set `{source}` references missing object `{}`", artifact.object_ref
            ))?;
            return Ok(None);
        };
        let descriptor = crate::solution_tensor_source::parse_solution_tensor_artifact(
            &bytes, artifact,
        )?;
        for chunk in &descriptor.chunks {
            self.add_archive_solution_object(&chunk.object_ref, chunk.length as u64, source)?;
        }
        self.tensor_descriptor_cache = Some((artifact.object_ref.clone(), descriptor.clone()));
        Ok(Some(descriptor))
    }

    fn add_archive_materialized_dataset_artifact(
        &mut self,
        artifact: &fullmag_quantities::SolutionArtifactRef,
        solution: &SolutionSet,
        current_member_id: &str,
        dataset_revisions: &mut BTreeSet<(String, u64)>,
        source: &str,
    ) -> Result<()> {
        self.add_archive_solution_object(&artifact.object_ref, artifact.byte_length, source)?;
        let Some(bytes) = self.bounded_archive_object(
            &artifact.object_ref,
            crate::materialized_dataset::MAX_MATERIALIZED_DATASET_METADATA_BYTES,
        )? else {
            return Ok(());
        };
        let manifest = crate::materialized_dataset::parse_materialized_dataset_artifact(
            &bytes, artifact,
        )?;
        register_materialized_dataset_revision(dataset_revisions, &manifest)?;
        if artifact.accepted_state != manifest.field.accepted_state {
            bail!("materialized dataset artifact accepted state differs from its field");
        }
        let owner = &manifest.field.source;
        if owner.run_id != solution.run_id
            || owner.solution_set_id != solution.solution_set_id
            || owner.solution_revision > solution.revision
            || owner.run_spec_digest != solution.provenance.run_spec_digest
        {
            bail!("materialized dataset owner is outside the containing SolutionSet");
        }
        if owner.member_id != current_member_id {
            bail!("materialized dataset owner member differs from its containing member");
        }
        self.validate_archive_current_materialized_tensor_record(
            solution,
            current_member_id,
            &manifest.field.tensor_artifact,
        )?;
        if owner.solution_revision == solution.revision {
            crate::materialized_dataset::validate_materialized_dataset_owner(&manifest, solution)?;
        } else {
            let historical = self.read_archive_solution_revision(
                &owner.solution_set_id,
                owner.solution_revision,
            )?;
            crate::materialized_dataset::validate_materialized_dataset_owner(&manifest, &historical)?;
        }
        let Some(descriptor) =
            self.add_archive_solution_tensor_artifact(&manifest.field.tensor_artifact, source)?
        else {
            return Ok(());
        };
        crate::materialized_dataset::validate_materialized_dataset_tensor(&manifest, &descriptor)
    }

    fn add_archive_field_geometry_artifact(
        &mut self,
        artifact: &fullmag_quantities::SolutionArtifactRef,
        solution: &SolutionSet,
        member_id: &str,
        geometry_sources: &mut BTreeSet<(String, String)>,
        source: &str,
    ) -> Result<()> {
        use crate::solution_field_geometry as geometry;
        if artifact.byte_length == 0 || artifact.byte_length > geometry::MAX_FIELD_GEOMETRY_MANIFEST_BYTES {
            bail!("saved field geometry binding exceeds its metadata budget");
        }
        self.add_archive_solution_object(&artifact.object_ref, artifact.byte_length, source)?;
        let Some(bytes) = self.bounded_archive_object(&artifact.object_ref, geometry::MAX_FIELD_GEOMETRY_MANIFEST_BYTES)? else {
            return Ok(());
        };
        let manifest = geometry::parse_solution_field_geometry_manifest(&bytes, artifact)?;
        drop(bytes);
        if !geometry_sources.insert((manifest.source.member_id.clone(), manifest.source.artifact_id.clone())) {
            bail!("saved field geometry is duplicated for the same tensor");
        }
        geometry::validate_field_geometry_owner(&manifest, solution, member_id, false)?;
        if manifest.source.solution_revision != solution.revision {
            let historical = self.read_archive_solution_revision(&manifest.source.solution_set_id, manifest.source.solution_revision)?;
            geometry::validate_field_geometry_owner(&manifest, &historical, member_id, true)?;
        }
        self.add_archive_solution_object(&manifest.geometry.object_ref, manifest.geometry.byte_length, source)?;
        let Some(bytes) = self.bounded_archive_object(&manifest.geometry.object_ref, geometry::MAX_FEM_P1_GEOMETRY_BYTES)? else {
            return Ok(());
        };
        let saved = geometry::parse_saved_fem_p1_geometry(&bytes, &manifest.geometry)?;
        drop(bytes);
        if let Some(tensor) = self.add_archive_solution_tensor_artifact(&manifest.tensor_artifact, source)? {
            geometry::validate_saved_geometry_tensor(&saved, &tensor)?;
        }
        Ok(())
    }

    fn validate_archive_current_materialized_tensor_record(
        &self,
        solution: &SolutionSet,
        member_id: &str,
        tensor_artifact: &fullmag_quantities::SolutionArtifactRef,
    ) -> Result<()> {
        let member = solution
            .members
            .iter()
            .find(|member| member.member_id == member_id)
            .context("materialized dataset current owner member is missing")?;
        let current = member
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == tensor_artifact.artifact_id)
            .context("materialized dataset current owner tensor artifact is missing")?;
        if current != tensor_artifact {
            bail!("materialized dataset tensor artifact changed in the containing SolutionSet");
        }
        Ok(())
    }

    fn read_archive_solution_revision(
        &mut self,
        solution_set_id: &str,
        revision: u64,
    ) -> Result<SolutionSet> {
        let directory = crate::cas::hex_sha256(solution_set_id.as_bytes());
        let relative = format!(
            "solutions/{directory}/revisions/{revision:020}.json"
        );
        let data = self
            .documents
            .read(&relative)?
            .context("historical materialized dataset owner revision is missing")?;
        self.report.file_refs.insert(relative.clone());
        let historical: SolutionSet = parse_json(&data, &relative)?;
        self.validate_archive_solution_identity(
            &historical,
            &directory,
            Some(revision),
            &relative,
        )?;
        Ok(historical)
    }

    fn bounded_archive_object(
        &self,
        object_ref: &str,
        max_bytes: u64,
    ) -> Result<Option<Vec<u8>>> {
        validate_object_ref(object_ref)?;
        let relative = format!("objects/sha256/{object_ref}");
        let file_root = self.cas_root.or_else(|| match &self.documents {
            ArchiveDocuments::Files { root, .. }
            | ArchiveDocuments::FilesWithInline { root, .. } => Some(*root),
            ArchiveDocuments::Memory(_) => None,
        });
        if let Some(root) = file_root {
            use std::io::Read;
            let path = crate::repository_path::checked_path(root, &relative)?;
            if !path.exists() {
                return Ok(None);
            }
            reject_link_chain(root, &relative)?;
            let mut data = Vec::new();
            fs::File::open(path)?.take(max_bytes + 1).read_to_end(&mut data)?;
            if data.len() as u64 > max_bytes {
                bail!("CAS object `{object_ref}` exceeds bounded metadata budget");
            }
            if crate::cas::hex_sha256(&data) != object_ref {
                bail!("CAS SHA-256 mismatch for `{relative}`");
            }
            return Ok(Some(data));
        }
        let Some(data) = self.documents.read(&relative)? else {
            return Ok(None);
        };
        if data.len() as u64 > max_bytes {
            bail!("CAS object `{object_ref}` exceeds bounded metadata budget");
        }
        if crate::cas::hex_sha256(&data) != object_ref {
            bail!("CAS SHA-256 mismatch for `{relative}`");
        }
        Ok(Some(data.into_owned()))
    }

    fn add_archive_solution_object(
        &mut self,
        object_ref: &str,
        expected_length: u64,
        source: &str,
    ) -> Result<()> {
        validate_object_ref(object_ref)
            .with_context(|| format!("invalid solution object reference in `{source}`"))?;
        self.report.object_refs.insert(object_ref.to_string());
        let Some(length) = self.object_length(object_ref)? else {
            return self.report.missing(format!(
                "solution set `{source}` references missing object `{object_ref}`"
            ));
        };
        if length != expected_length {
            bail!(
                "solution set `{source}` object `{object_ref}` length does not match its manifest"
            )
        }
        Ok(())
    }

    fn walk_run(&mut self, run_ref: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(run_ref)? else {
            return self.report.missing(format!(
                "archive references missing run manifest `{run_ref}`"
            ));
        };
        self.report.file_refs.insert(run_ref.to_string());
        let run: FmsRunManifest = parse_json(&data, run_ref)?;
        if run.run_id != expected_run_id {
            bail!(
                "run manifest `{run_ref}` contains mismatched run_id `{}`",
                run.run_id
            )
        }
        for reference in [run.plan_ref.as_deref(), run.live_state_ref.as_deref()] {
            if let Some(reference) = reference {
                self.follow_reference(reference, run_ref, ReferenceKind::Unknown)?;
            }
        }
        if let Some(reference) = run.latest_checkpoint_ref.as_deref() {
            self.follow_checkpoint_reference(reference, run_ref)?;
        }
        if let Some(reference) = run.artifact_index_ref.as_deref() {
            self.follow_reference(reference, run_ref, ReferenceKind::ArtifactIndex)?;
        }
        let intent_ref = format!("runs/{expected_run_id}/run_intent.json");
        if self.documents.contains_key(&intent_ref) {
            self.walk_run_intent(&intent_ref, expected_run_id)?;
        }
        let catalog_ref = format!("runs/{expected_run_id}/run_catalog.json");
        if self.documents.contains_key(&catalog_ref) {
            self.walk_run_catalog(&catalog_ref, expected_run_id)?;
        }
        let artifact_catalog_ref = format!("runs/{expected_run_id}/artifact_catalog.json");
        if self.documents.contains_key(&artifact_catalog_ref) {
            self.walk_artifact_catalog(&artifact_catalog_ref, expected_run_id)?;
        }
        let preparation_receipt_ref = format!("runs/{expected_run_id}/preparation_receipt.json");
        if self.documents.contains_key(&preparation_receipt_ref) {
            self.walk_preparation_receipt(&preparation_receipt_ref, expected_run_id)?;
        }
        self.walk_task_preparation_receipts(expected_run_id)?;
        self.walk_task_admissions(expected_run_id)?;
        let lease_prefix = format!("runs/{expected_run_id}/resource_leases/");
        let lease_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in lease_names {
            if name.starts_with(&lease_prefix) && name.ends_with(".json") {
                self.walk_resource_lease(&name, expected_run_id)?;
            }
        }
        let preparation_lease_prefix =
            format!("runs/{expected_run_id}/preparation_resource_leases/");
        let preparation_lease_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in preparation_lease_names {
            if name.starts_with(&preparation_lease_prefix) && name.ends_with(".json") {
                self.walk_preparation_resource_lease(&name, expected_run_id)?;
            }
        }
        let retry_prefix = format!("runs/{expected_run_id}/retry_decisions/");
        let retry_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in retry_names {
            if name.starts_with(&retry_prefix) && name.ends_with(".json") {
                self.walk_retry_decision(&name, expected_run_id)?;
            }
        }
        let preparation_retry_prefix =
            format!("runs/{expected_run_id}/preparation_retry_decisions/");
        let preparation_retry_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in preparation_retry_names {
            if name.starts_with(&preparation_retry_prefix) && name.ends_with(".json") {
                self.walk_preparation_retry_decision(&name, expected_run_id)?;
            }
        }
        let process_exit_prefix = format!("runs/{expected_run_id}/worker_process_exit_receipts/");
        let process_exit_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in process_exit_names {
            if name.starts_with(&process_exit_prefix) && name.ends_with(".json") {
                self.walk_worker_process_exit_receipt(&name, expected_run_id)?;
            }
        }
        let preparation_exit_prefix =
            format!("runs/{expected_run_id}/preparation_process_exit_receipts/");
        let preparation_exit_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in preparation_exit_names {
            if name.starts_with(&preparation_exit_prefix) && name.ends_with(".json") {
                self.walk_preparation_process_exit_receipt(&name, expected_run_id)?;
            }
        }
        let preparation_launch_prefix =
            format!("runs/{expected_run_id}/preparation_process_launches/");
        let preparation_launch_names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in preparation_launch_names {
            if name.starts_with(&preparation_launch_prefix) && name.ends_with(".json") {
                self.walk_preparation_process_launch(&name, expected_run_id)?;
            }
        }
        let journal_prefix = format!("runs/{expected_run_id}/coordinator_journal/");
        let journal_names = self.documents.keys().cloned().collect::<Vec<_>>();
        let mut journal_entries = Vec::new();
        for name in journal_names {
            if name.starts_with(&journal_prefix) && name.ends_with(".json") {
                journal_entries.push(self.walk_coordinator_journal(&name, expected_run_id)?);
            }
        }
        validate_journal_streams(&journal_entries)?;
        let inbox_prefix = format!("runs/{expected_run_id}/worker_inbox/");
        for name in self.documents.keys().filter(|name| name.starts_with(&inbox_prefix)) {
            let data = self.documents.read(name)?.context("worker inbox disappeared during archive walk")?;
            let record: crate::FmsWorkerInboxRecord = parse_json(&data, name)?;
            if record.relative_path()? != *name {
                bail!("worker inbox path identity mismatch");
            }
            self.report.file_refs.insert(name.clone());
        }
        let prefix = format!("runs/{expected_run_id}/checkpoints/");
        let names = self.documents.keys().cloned().collect::<Vec<_>>();
        for name in names {
            if name.starts_with(&prefix) && name.ends_with("/checkpoint.json") {
                let rest = &name[prefix.len()..name.len() - "/checkpoint.json".len()];
                if rest.is_empty() || rest.contains('/') {
                    bail!("invalid checkpoint path `{name}`")
                }
                self.walk_checkpoint(&name, expected_run_id, rest)?;
            }
        }
        Ok(())
    }

    fn walk_run_intent(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing run intent `{relative}`"
            ));
        };
        let intent: FmsRunIntent = parse_json(&data, relative)?;
        intent.validate()?;
        if intent.run_id != expected_run_id {
            bail!(
                "run intent `{relative}` contains mismatched run_id `{}`",
                intent.run_id
            )
        }
        if let Some(object_ref) = intent.definition_object_ref.as_deref() {
            self.add_archive_payload(object_ref, relative, None)?;
        }
        if let Some(object_ref) = intent.study_object_ref.as_deref() {
            self.add_archive_payload(object_ref, relative, None)?;
        }
        if let Some(object_ref) = intent.study_catalog_object_ref.as_deref() {
            self.add_archive_payload(object_ref, relative, None)?;
        }
        for object_ref in intent.asset_object_refs.values() {
            self.add_archive_payload(object_ref, relative, None)?;
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_run_catalog(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing run catalog `{relative}`"
            ));
        };
        let catalog: FmsRunCatalog = parse_json(&data, relative)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!(
                "run catalog `{relative}` contains mismatched run_id `{}`",
                catalog.run_id
            )
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_artifact_catalog(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing artifact catalog `{relative}`"
            ));
        };
        let catalog: FmsArtifactCatalog = parse_json(&data, relative)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!(
                "artifact catalog `{relative}` contains mismatched run_id `{}`",
                catalog.run_id
            )
        }
        for entry in &catalog.entries {
            if let Some(object_ref) = entry.object_ref.as_deref() {
                self.add_archive_payload(object_ref, relative, None)?;
            }
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_preparation_receipt(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing preparation receipt `{relative}`"
            ));
        };
        let receipt: FmsPreparationReceipt = parse_json(&data, relative)?;
        receipt.validate()?;
        if receipt.run_id != expected_run_id {
            bail!(
                "preparation receipt `{relative}` contains mismatched run_id `{}`",
                receipt.run_id
            )
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_task_preparation_receipts(&mut self, expected_run_id: &str) -> Result<()> {
        let prefix = format!("runs/{expected_run_id}/task_preparation_receipts/");
        let mut names = self
            .documents
            .keys()
            .filter(|name| name.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        if names.is_empty() {
            return Ok(());
        }
        names.sort();
        let catalog_ref = format!("runs/{expected_run_id}/run_catalog.json");
        let catalog_data = self.documents.read(&catalog_ref)?.with_context(|| {
            format!("archive task preparation receipts require run catalog `{catalog_ref}`")
        })?;
        let catalog: FmsRunCatalog = parse_json(&catalog_data, &catalog_ref)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!("archive task preparation receipt catalog identity does not match run path");
        }
        let intent_ref = format!("runs/{expected_run_id}/run_intent.json");
        let intent_data = self.documents.read(&intent_ref)?.with_context(|| {
            format!("archive task preparation receipts require run intent `{intent_ref}`")
        })?;
        let intent: FmsRunIntent = parse_json(&intent_data, &intent_ref)?;
        intent.validate()?;
        for relative in names {
            let rest = relative
                .strip_prefix(&prefix)
                .context("invalid task preparation receipt archive path")?;
            if rest.is_empty() || rest.contains('/') || !rest.ends_with(".json") {
                bail!("invalid task preparation receipt archive path `{relative}`");
            }
            let data = self
                .documents
                .read(&relative)?
                .context("archive task preparation receipt disappeared")?;
            let receipt: FmsTaskPreparationReceipt = parse_json(&data, &relative)?;
            if receipt.relative_path()? != relative {
                bail!("task preparation receipt path identity mismatch");
            }
            receipt.validate_for_catalog(&catalog)?;
            receipt.validate_for_run_intent(&intent)?;
            self.report.file_refs.insert(relative);
        }
        Ok(())
    }

    fn walk_task_admissions(&mut self, expected_run_id: &str) -> Result<()> {
        let prefix = format!("runs/{expected_run_id}/task_admissions/");
        let mut names = self
            .documents
            .keys()
            .filter(|name| name.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        if names.is_empty() {
            return Ok(());
        }
        names.sort();
        let catalog_ref = format!("runs/{expected_run_id}/run_catalog.json");
        let catalog_data = self.documents.read(&catalog_ref)?.with_context(|| {
            format!("archive task admissions require run catalog `{catalog_ref}`")
        })?;
        let catalog: FmsRunCatalog = parse_json(&catalog_data, &catalog_ref)?;
        catalog.validate()?;
        if catalog.run_id != expected_run_id {
            bail!("archive task admission catalog identity does not match run path");
        }
        for relative in names {
            let rest = relative
                .strip_prefix(&prefix)
                .context("invalid task admission archive path")?;
            let Some((task_id, file_name)) = rest.split_once('/') else {
                bail!("invalid task admission archive path `{relative}`");
            };
            let Some(attempt_id) = file_name.strip_suffix(".json") else {
                bail!("task admission archive path must end in .json: `{relative}`");
            };
            if task_id.is_empty()
                || task_id.contains('/')
                || attempt_id.is_empty()
                || attempt_id.contains('/')
            {
                bail!("invalid task admission archive path `{relative}`");
            }
            validate_component(task_id)?;
            validate_component(attempt_id)?;
            let data = self
                .documents
                .read(&relative)?
                .context("archive task admission disappeared")?;
            let record: FmsTaskAdmissionRecord = parse_json(&data, &relative)?;
            record.validate()?;
            if record.lease.run_id != expected_run_id
                || record.task.task_id != task_id
                || record.lease.attempt_id != attempt_id
            {
                bail!("task admission identity does not match archive path");
            }
            let current = catalog
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .context("archive task admission target is missing from the run catalog")?;
            if current.input_fingerprint != record.task.input_fingerprint {
                bail!("archive task admission input differs from the run catalog");
            }
            self.report.file_refs.insert(relative);
        }
        Ok(())
    }

    fn walk_resource_lease(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing resource lease `{relative}`"
            ));
        };
        let rest = relative
            .strip_prefix(&format!("runs/{expected_run_id}/resource_leases/"))
            .ok_or_else(|| anyhow::anyhow!("invalid resource lease path `{relative}`"))?;
        let Some((resource_id, token_file)) = rest.split_once('/') else {
            bail!("invalid resource lease path `{relative}`")
        };
        let Some(lease_token) = token_file.strip_suffix(".json") else {
            bail!("invalid resource lease path `{relative}`")
        };
        if resource_id.is_empty()
            || resource_id.contains('/')
            || lease_token.is_empty()
            || lease_token.contains('/')
        {
            bail!("invalid resource lease path `{relative}`")
        }
        validate_component(resource_id)?;
        validate_component(lease_token)?;
        let lease: FmsResourceLease = parse_json(&data, relative)?;
        lease.validate()?;
        if lease.run_id != expected_run_id
            || lease.resource_id != resource_id
            || lease.lease_token != lease_token
        {
            bail!("resource lease `{relative}` contains mismatched path identity")
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_retry_decision(&mut self, relative: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing retry decision `{relative}`"
            ));
        };
        let prefix = format!("runs/{expected_run_id}/retry_decisions/");
        let Some(file_name) = relative.strip_prefix(&prefix) else {
            bail!("invalid retry decision path `{relative}`")
        };
        let Some(decision_id) = file_name.strip_suffix(".json") else {
            bail!("retry decision path must end in .json: `{relative}`")
        };
        if decision_id.is_empty() || decision_id.contains('/') {
            bail!("invalid retry decision path `{relative}`")
        }
        validate_component(decision_id)?;
        let decision: FmsRetryDecision = parse_json(&data, relative)?;
        decision.validate()?;
        if decision.run_id != expected_run_id || decision.decision_id != decision_id {
            bail!("retry decision `{relative}` contains mismatched path identity")
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_preparation_retry_decision(
        &mut self,
        relative: &str,
        expected_run_id: &str,
    ) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing preparation retry decision `{relative}`"
            ));
        };
        let prefix = format!("runs/{expected_run_id}/preparation_retry_decisions/");
        let Some(file_name) = relative.strip_prefix(&prefix) else {
            bail!("invalid preparation retry decision path `{relative}`")
        };
        let Some(decision_id) = file_name.strip_suffix(".json") else {
            bail!("preparation retry decision path must end in .json: `{relative}`")
        };
        if decision_id.is_empty() || decision_id.contains('/') {
            bail!("invalid preparation retry decision path `{relative}`")
        }
        validate_component(decision_id)?;
        let decision: FmsPreparationRetryDecision = parse_json(&data, relative)?;
        if decision.run_id != expected_run_id
            || decision.decision_id != decision_id
            || decision.relative_path()? != relative
        {
            bail!("preparation retry decision `{relative}` contains mismatched path identity")
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_preparation_resource_lease(
        &mut self,
        relative: &str,
        expected_run_id: &str,
    ) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing preparation resource lease `{relative}`"
            ));
        };
        let rest = relative
            .strip_prefix(&format!(
                "runs/{expected_run_id}/preparation_resource_leases/"
            ))
            .ok_or_else(|| {
                anyhow::anyhow!("invalid preparation resource lease path `{relative}`")
            })?;
        let Some((resource_id, token_file)) = rest.split_once('/') else {
            bail!("invalid preparation resource lease path `{relative}`")
        };
        let Some(lease_token) = token_file.strip_suffix(".json") else {
            bail!("invalid preparation resource lease path `{relative}`")
        };
        if resource_id.is_empty()
            || resource_id.contains('/')
            || lease_token.is_empty()
            || lease_token.contains('/')
        {
            bail!("invalid preparation resource lease path `{relative}`")
        }
        validate_component(resource_id)?;
        validate_component(lease_token)?;
        let lease: FmsPreparationResourceLease = parse_json(&data, relative)?;
        lease.validate()?;
        if lease.run_id != expected_run_id
            || lease.resource_id != resource_id
            || lease.lease_token != lease_token
            || lease.relative_path()? != relative
        {
            bail!("preparation resource lease `{relative}` contains mismatched path identity")
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_worker_process_exit_receipt(
        &mut self,
        relative: &str,
        expected_run_id: &str,
    ) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing worker process exit receipt `{relative}`"
            ));
        };
        let prefix = format!("runs/{expected_run_id}/worker_process_exit_receipts/");
        let Some(file_name) = relative.strip_prefix(&prefix) else {
            bail!("invalid worker process exit receipt path `{relative}`")
        };
        let Some(receipt_id) = file_name.strip_suffix(".json") else {
            bail!("worker process exit receipt path must end in .json: `{relative}`")
        };
        if receipt_id.is_empty() || receipt_id.contains('/') {
            bail!("invalid worker process exit receipt path `{relative}`")
        }
        validate_component(receipt_id)?;
        let receipt: FmsWorkerProcessExitReceipt = parse_json(&data, relative)?;
        if receipt.run_id != expected_run_id || receipt.receipt_id != receipt_id {
            bail!("worker process exit receipt `{relative}` contains mismatched path identity")
        }
        receipt.validate()?;
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_preparation_process_exit_receipt(
        &mut self,
        relative: &str,
        expected_run_id: &str,
    ) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing preparation process exit receipt `{relative}`"
            ));
        };
        let prefix = format!("runs/{expected_run_id}/preparation_process_exit_receipts/");
        let Some(file_name) = relative.strip_prefix(&prefix) else {
            bail!("invalid preparation process exit receipt path `{relative}`")
        };
        let Some(receipt_id) = file_name.strip_suffix(".json") else {
            bail!("preparation process exit receipt path must end in .json: `{relative}`")
        };
        if receipt_id.is_empty() || receipt_id.contains('/') {
            bail!("invalid preparation process exit receipt path `{relative}`")
        }
        validate_component(receipt_id)?;
        let receipt: FmsPreparationProcessExitReceipt = parse_json(&data, relative)?;
        if receipt.run_id != expected_run_id || receipt.receipt_id != receipt_id {
            bail!("preparation process exit receipt `{relative}` contains mismatched path identity")
        }
        receipt.validate()?;
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_preparation_process_launch(
        &mut self,
        relative: &str,
        expected_run_id: &str,
    ) -> Result<()> {
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing preparation process launch `{relative}`"
            ));
        };
        let prefix = format!("runs/{expected_run_id}/preparation_process_launches/");
        let Some(file_name) = relative.strip_prefix(&prefix) else {
            bail!("invalid preparation process launch path `{relative}`")
        };
        let Some(launch_id) = file_name.strip_suffix(".json") else {
            bail!("preparation process launch path must end in .json: `{relative}`")
        };
        if launch_id.is_empty() || launch_id.contains('/') {
            bail!("invalid preparation process launch path `{relative}`")
        }
        validate_component(launch_id)?;
        let launch: FmsPreparationProcessLaunch = parse_json(&data, relative)?;
        if launch.run_id != expected_run_id || launch.launch_id != launch_id {
            bail!("preparation process launch `{relative}` contains mismatched path identity")
        }
        launch.validate()?;
        self.report.file_refs.insert(relative.to_string());
        Ok(())
    }

    fn walk_coordinator_journal(
        &mut self,
        relative: &str,
        expected_run_id: &str,
    ) -> Result<crate::types::FmsCoordinatorJournalEntry> {
        let Some(data) = self.documents.read(relative)? else {
            bail!("archive references missing coordinator journal entry `{relative}`");
        };
        let prefix = format!("runs/{expected_run_id}/coordinator_journal/");
        let Some(rest) = relative.strip_prefix(&prefix) else {
            bail!("invalid coordinator journal path `{relative}`")
        };
        let Some((direction, file_name)) = rest.split_once('/') else {
            bail!("invalid coordinator journal path `{relative}`")
        };
        let direction = match direction {
            "command" => FmsCoordinatorJournalDirection::Command,
            "event" => FmsCoordinatorJournalDirection::Event,
            _ => bail!("unknown coordinator journal direction `{direction}`"),
        };
        let Some(entry_id) = file_name.strip_suffix(".json") else {
            bail!("coordinator journal path must end in .json: `{relative}`")
        };
        validate_component(entry_id)?;
        let journal: crate::types::FmsCoordinatorJournalEntry = parse_json(&data, relative)?;
        journal.validate()?;
        if journal.run_id != expected_run_id
            || journal.direction != direction
            || journal.entry_id != entry_id
        {
            bail!("coordinator journal `{relative}` contains mismatched path identity")
        }
        self.report.file_refs.insert(relative.to_string());
        Ok(journal)
    }

    fn walk_checkpoint(
        &mut self,
        relative: &str,
        expected_run_id: &str,
        expected_checkpoint_id: &str,
    ) -> Result<()> {
        if !self.seen_checkpoints.insert(relative.to_string()) {
            return Ok(());
        }
        let Some(data) = self.documents.read(relative)? else {
            return self.report.missing(format!(
                "archive references missing checkpoint `{relative}`"
            ));
        };
        self.report.file_refs.insert(relative.to_string());
        let checkpoint: FmsCheckpoint = parse_json(&data, relative)?;
        validate_checkpoint(
            &checkpoint,
            expected_run_id,
            expected_checkpoint_id,
            relative,
        )?;
        self.report.checkpoint_count = self.report.checkpoint_count.saturating_add(1);
        let warning_count_before_checkpoint = self.report.warnings.len();
        self.follow_reference(
            &checkpoint.common_state_ref,
            relative,
            ReferenceKind::CommonState,
        )?;
        self.validate_checkpoint_common_state(&checkpoint, relative)?;
        let warning_count_after_common_state = self.report.warnings.len();
        let warning_count_before_restart = self.report.warnings.len();
        for (reference, kind) in [
            (
                checkpoint.integrator_ref.as_deref(),
                ReferenceKind::IntegratorPayload,
            ),
            (checkpoint.rng_ref.as_deref(), ReferenceKind::RngPayload),
            (
                checkpoint.backend_state_ref.as_deref(),
                ReferenceKind::BackendState,
            ),
        ] {
            if let Some(reference) = reference {
                validate_checkpoint_payload_ref(&checkpoint, reference, relative)?;
                self.follow_reference(reference, relative, kind)?;
            }
        }
        let restart_complete = if warning_count_after_common_state
            == warning_count_before_checkpoint
            && self.report.warnings.len() == warning_count_before_restart
            && (checkpoint.integrator_ref.is_some()
                || checkpoint.rng_ref.is_some()
                || checkpoint.backend_state_ref.is_some())
        {
            self.report.restart_payload_count = self.report.restart_payload_count.saturating_add(1);
            true
        } else {
            false
        };
        let mut primary_complete = false;
        for field in checkpoint.field_refs {
            validate_object_ref(&field.tensor_descriptor_ref)
                .with_context(|| format!("invalid tensor descriptor ref in `{relative}`"))?;
            let warning_count_before_field = self.report.warnings.len();
            let payload_complete =
                self.add_archive_descriptor(&field.tensor_descriptor_ref, relative)?;
            if field.role == FieldRole::Primary && payload_complete {
                primary_complete |= warning_count_before_field == self.report.warnings.len();
                self.report.primary_payload_count =
                    self.report.primary_payload_count.saturating_add(1);
            }
        }
        self.report.checkpoint_status.insert(
            relative.to_string(),
            CheckpointPayloadStatus {
                primary: primary_complete
                    && warning_count_after_common_state == warning_count_before_checkpoint,
                restart: restart_complete,
            },
        );
        Ok(())
    }

    fn follow_reference(
        &mut self,
        reference: &str,
        source: &str,
        kind: ReferenceKind,
    ) -> Result<()> {
        if is_object_ref(reference) {
            if self.add_archive_payload(reference, source, None)? {
                if matches!(kind, ReferenceKind::Unknown) {
                    return self.follow_archive_payload(&[], source, kind);
                }
                let data = self.object_document(reference)?;
                self.follow_archive_payload(&data, source, kind)?;
            }
            return Ok(());
        }
        validate_file_ref(reference)
            .with_context(|| format!("invalid reference `{reference}` in `{source}`"))?;
        if matches!(kind, ReferenceKind::Unknown) && self.documents.contains_key(reference) {
            self.report.file_refs.insert(reference.to_string());
            return self.follow_archive_payload(&[], reference, kind);
        }
        let Some(data) = self.documents.read(reference)? else {
            return self.report.missing(format!(
                "`{source}` references missing archive file `{reference}`"
            ));
        };
        self.report.file_refs.insert(reference.to_string());
        self.follow_archive_payload(&data, reference, kind)
    }

    fn follow_archive_payload(
        &mut self,
        data: &[u8],
        source: &str,
        kind: ReferenceKind,
    ) -> Result<()> {
        match kind {
            ReferenceKind::CommonState => {
                let state: CommonSolverState = parse_json(&data, source)?;
                if let Some(object_ref) = state.magnetization_ref {
                    self.add_archive_payload(&object_ref, source, None)?;
                }
            }
            ReferenceKind::ArtifactIndex => {
                let index: ArtifactIndex = parse_json(&data, source)?;
                for entry in index.entries {
                    if let Some(object_ref) = entry.object_ref {
                        self.add_archive_payload(&object_ref, source, None)?;
                    }
                }
            }
            ReferenceKind::BackendState => {
                if validate_restart_payload(data, kind, source)? {
                    self.report.conservative(format!(
                        "opaque backend restart state `{source}` in backend_state payload requires conservative retention"
                    ));
                }
            }
            ReferenceKind::IntegratorPayload | ReferenceKind::RngPayload => {
                if validate_restart_payload(data, kind, source)? {
                    self.report.conservative(format!(
                        "opaque integrator restart payload `{source}` requires conservative retention"
                    ));
                }
            }
            ReferenceKind::Unknown => {
                self.report.mark_blocking_incomplete(format!(
                    "untyped archive reference `{source}` requires conservative retention"
                ));
            }
        }
        Ok(())
    }

    fn validate_checkpoint_common_state(
        &self,
        checkpoint: &FmsCheckpoint,
        source: &str,
    ) -> Result<()> {
        let Some(data) = self.documents.read(&checkpoint.common_state_ref)? else {
            return Ok(());
        };
        let state: CommonSolverState = parse_json(&data, &checkpoint.common_state_ref)?;
        validate_common_state_identity(checkpoint, &state, source)
    }

    fn follow_checkpoint_reference(&mut self, reference: &str, source: &str) -> Result<()> {
        validate_file_ref(reference)
            .with_context(|| format!("invalid checkpoint reference `{reference}` in `{source}`"))?;
        let Some(rest) = reference.strip_prefix("runs/") else {
            return self.follow_reference(reference, source, ReferenceKind::Unknown);
        };
        let Some((run_id, checkpoint_id)) = rest
            .strip_suffix("/checkpoint.json")
            .and_then(|value| value.split_once("/checkpoints/"))
        else {
            return self.follow_reference(reference, source, ReferenceKind::Unknown);
        };
        self.walk_checkpoint(reference, run_id, checkpoint_id)
    }

    fn add_archive_descriptor(&mut self, object_ref: &str, source: &str) -> Result<bool> {
        validate_object_ref(object_ref)
            .with_context(|| format!("invalid object ref in `{source}`"))?;
        self.report.object_refs.insert(object_ref.to_string());
        let archive_path = format!("objects/sha256/{object_ref}");
        let Some(_) = self.object_length(object_ref)? else {
            self.report.missing(format!(
                "`{source}` references missing object `{object_ref}`"
            ))?;
            return Ok(false);
        };
        let data = self.object_document(object_ref)?;
        let descriptor: TensorDescriptor = parse_json(&data, &archive_path)?;
        validate_descriptor(&descriptor, object_ref, source)?;
        for chunk in descriptor.chunks {
            if !self.add_archive_payload(&chunk.object_ref, source, Some(chunk.length))? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn add_archive_payload(
        &mut self,
        object_ref: &str,
        source: &str,
        expected_length: Option<usize>,
    ) -> Result<bool> {
        validate_object_ref(object_ref)
            .with_context(|| format!("invalid object ref in `{source}`"))?;
        self.report.object_refs.insert(object_ref.to_string());
        let Some(length) = self.object_length(object_ref)? else {
            self.report.missing(format!(
                "`{source}` references missing object `{object_ref}`"
            ))?;
            return Ok(false);
        };
        if expected_length.is_some_and(|expected| u64::try_from(expected).ok() != Some(length)) {
            bail!("tensor chunk `{object_ref}` length does not match its descriptor range")
        }
        Ok(true)
    }
}

fn validate_session(session: &FmsSessionManifest, source: &str) -> Result<()> {
    if session.format != "fullmag.session.v1" {
        bail!("unknown session schema `{}` in `{source}`", session.format)
    }
    validate_component(&session.session_id)
        .with_context(|| format!("invalid session_id in `{source}`"))?;
    if session.workspace_ref != "manifest/workspace.json"
        || session.export_profile_ref != "manifest/export_profile.json"
    {
        bail!("unsupported workspace or export profile reference in `{source}`")
    }
    Ok(())
}

fn validate_checkpoint(
    checkpoint: &FmsCheckpoint,
    expected_run_id: &str,
    expected_checkpoint_id: &str,
    source: &str,
) -> Result<()> {
    if checkpoint.run_id != expected_run_id {
        bail!(
            "checkpoint `{source}` contains mismatched run_id `{}`",
            checkpoint.run_id
        )
    }
    if checkpoint.checkpoint_id != expected_checkpoint_id {
        bail!(
            "checkpoint `{source}` contains mismatched checkpoint_id `{}`",
            checkpoint.checkpoint_id
        )
    }
    validate_component(&checkpoint.run_id)?;
    validate_component(&checkpoint.checkpoint_id)?;
    let expected_common_state = format!(
        "runs/{}/checkpoints/{}/common_state.json",
        checkpoint.run_id, checkpoint.checkpoint_id
    );
    if checkpoint.common_state_ref != expected_common_state {
        bail!("checkpoint `{source}` has an unowned common state reference")
    }
    Ok(())
}

fn validate_common_state_identity(
    checkpoint: &FmsCheckpoint,
    state: &CommonSolverState,
    source: &str,
) -> Result<()> {
    if checkpoint.step != state.step
        || checkpoint.time_s != state.time_s
        || checkpoint.dt != state.dt
    {
        bail!("checkpoint `{source}` and common state have mismatched identity")
    }
    Ok(())
}

fn validate_checkpoint_payload_ref(
    checkpoint: &FmsCheckpoint,
    reference: &str,
    source: &str,
) -> Result<()> {
    if is_object_ref(reference) {
        return Ok(());
    }
    validate_file_ref(reference)
        .with_context(|| format!("invalid checkpoint payload reference `{reference}`"))?;
    let prefix = format!(
        "runs/{}/checkpoints/{}/",
        checkpoint.run_id, checkpoint.checkpoint_id
    );
    if !reference.starts_with(&prefix) || reference[prefix.len()..].is_empty() {
        bail!("checkpoint `{source}` has an unowned restart payload reference `{reference}`")
    }
    Ok(())
}

fn validate_restart_payload(data: &[u8], kind: ReferenceKind, source: &str) -> Result<bool> {
    match kind {
        ReferenceKind::BackendState => {
            let payload: BackendStatePayload = parse_json(data, source)?;
            if payload.format != "fullmag.backend_state.v1"
                || payload.backend_family.trim().is_empty()
            {
                bail!("backend restart payload `{source}` has no usable identity")
            }
            let extra_is_empty = payload.extra.as_object().is_some_and(|map| map.is_empty());
            if payload.integrator_state.is_none()
                && payload.rng_state.is_none()
                && (payload.extra.is_null() || extra_is_empty)
            {
                bail!("backend restart payload `{source}` has no material state")
            }
            let carries_state = payload
                .integrator_state
                .as_ref()
                .is_some_and(is_nonempty_json)
                || is_nonempty_json(&payload.extra);
            // A known, inline checkpoint schema is a typed payload with no
            // hidden references; everything else stays opaque (fail closed).
            Ok(carries_state
                && !matches!(
                    crate::typed_documents::inspect_backend_state(&payload),
                    crate::typed_documents::TypedInspection::Typed { .. }
                ))
        }
        ReferenceKind::IntegratorPayload => {
            let value: serde_json::Value = parse_json(data, source)?;
            if value.as_object().map_or(true, |map| map.is_empty()) {
                bail!("restart payload `{source}` has no material state")
            }
            Ok(true)
        }
        ReferenceKind::RngPayload => {
            let state: crate::types::RngState = parse_json(data, source)?;
            if state.stream_family.trim().is_empty() {
                bail!("RNG restart payload `{source}` has no usable stream identity")
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

fn is_nonempty_json(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Array(values) => !values.is_empty(),
        serde_json::Value::Object(values) => !values.is_empty(),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
    }
}

fn validate_descriptor(
    descriptor: &TensorDescriptor,
    object_ref: &str,
    source: &str,
) -> Result<()> {
    if descriptor.format != "fullmag.tensor.v1" {
        bail!("unknown tensor descriptor schema in `{source}`")
    }
    let total_elements = descriptor
        .shape
        .iter()
        .try_fold(1usize, |total, dimension| total.checked_mul(*dimension))
        .context("tensor descriptor element count overflow")?;
    let total_bytes = total_elements
        .checked_mul(descriptor.dtype.byte_size())
        .context("tensor descriptor byte size overflow")?;
    if total_bytes == 0 {
        bail!("tensor descriptor `{object_ref}` has no material byte payload")
    }
    if total_bytes > 0 && descriptor.chunks.is_empty() {
        bail!("tensor descriptor `{object_ref}` has no material payload chunks")
    }
    let mut ranges = descriptor.chunks.iter().collect::<Vec<_>>();
    ranges.sort_by_key(|chunk| chunk.offset);
    let mut cursor = 0usize;
    for chunk in ranges {
        validate_object_ref(&chunk.object_ref)
            .with_context(|| format!("invalid tensor chunk in descriptor `{object_ref}`"))?;
        let end = chunk
            .offset
            .checked_add(chunk.length)
            .context("tensor chunk range overflow")?;
        if chunk.offset != cursor {
            bail!(
                "tensor descriptor `{object_ref}` has a gap or overlap before offset {}",
                chunk.offset
            )
        }
        if end > total_bytes {
            bail!("tensor chunk range exceeds descriptor `{object_ref}`")
        }
        if let Some(hash) = &chunk.sha256 {
            validate_object_ref(hash)?;
            if hash != &chunk.object_ref {
                bail!("tensor chunk digest does not match object ref in `{object_ref}`")
            }
        }
        cursor = end;
    }
    if cursor != total_bytes {
        bail!("tensor descriptor `{object_ref}` does not cover its complete byte payload")
    }
    if let Some(binding) = &descriptor.field_binding {
        binding.validate_for_tensor(descriptor)?;
    }
    Ok(())
}

fn parse_json<T: serde::de::DeserializeOwned>(data: &[u8], source: &str) -> Result<T> {
    serde_json::from_slice(data).with_context(|| format!("parsing JSON root `{source}`"))
}

fn validate_solution_archive_path(name: &str) -> Result<()> {
    let components = name.split('/').collect::<Vec<_>>();
    if components.len() < 3 || components[0] != "solutions" {
        bail!("invalid solution-set archive path `{name}`")
    }
    validate_object_ref(components[1])?;
    match components.as_slice() {
        ["solutions", _, "manifest.json"] => Ok(()),
        ["solutions", _, "revisions", file_name] => {
            parse_solution_revision_filename(file_name).map(|_| ())
        }
        _ => bail!("invalid solution-set archive path `{name}`"),
    }
}

fn parse_solution_revision_filename(file_name: &str) -> Result<u64> {
    let revision_text = file_name
        .strip_suffix(".json")
        .filter(|value| value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .with_context(|| format!("invalid solution-set revision filename `{file_name}`"))?;
    let revision = revision_text.parse::<u64>()?;
    if revision == 0 {
        bail!("solution-set revision must be positive")
    }
    Ok(revision)
}

fn is_object_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn live_snapshot_artifact_path(run_id: &str, artifact_path: &str) -> Result<String> {
    validate_component(run_id).context("invalid live snapshot session.run_id")?;
    validate_file_ref(artifact_path).context("unsafe live snapshot artifact path")?;
    let relative = format!("runs/{run_id}/artifacts/{artifact_path}");
    validate_file_ref(&relative).context("unsafe session run artifact path")?;
    Ok(relative)
}
fn validate_component(component: &str) -> Result<()> {
    crate::repository_path::validate_store_id(component)
}

fn read_directory(path: &Path) -> Result<Vec<fs::DirEntry>> {
    fs::read_dir(path)
        .with_context(|| format!("reading session directory {}", path.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("enumerating session directory {}", path.display()))
}

fn reject_link_chain(root: &Path, relative: &str) -> Result<()> {
    crate::repository_path::checked_path(root, relative)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materialized_dataset::{
        MaterializedDatasetManifest, MATERIALIZED_DATASET_SCHEMA,
    };
    use crate::solution_tensor_field::{TensorFieldBinding, TENSOR_FIELD_BINDING_SCHEMA};
    use crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA;
    use crate::{FmsRunIntent, TensorChunk, TensorDtype, TensorDescriptor};
    use fullmag_quantities::{
        ActiveSupportDescriptor, DatasetFieldDescriptor, DatasetSlicePlane, DatasetSource,
        FieldAxisDescriptor, FieldFrameDescriptor, FieldFrameKind, FieldNormalization,
        FieldResolution, FieldSampleLocation, FieldValueRepresentation, FunctionSpaceDescriptor,
        FunctionSpaceOrdering, MaterializedDatasetRef, QuantityId, ScientificAssessment,
        ScientificAssessmentStatus, SolutionArtifactKind, SolutionArtifactRef,
        SolutionExecutionStatus, SolutionMember, SolutionSet, SolutionSetManifestState,
        SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;

    #[test]
    fn conservative_after_opaque_project_document_blocks_visualization() {
        let mut report = ReachabilityReport::new();
        report.mark_opaque_project_document("opaque project document");
        report.conservative("unknown run document");

        assert!(report.has_blocking_incompleteness);
        assert!(!report.opaque_project_documents_only);
        assert!(report.require_visualization_safe().is_err());
    }

    #[test]
    fn opaque_project_document_after_conservative_blocks_visualization() {
        let mut report = ReachabilityReport::new();
        report.conservative("unknown run document");
        report.mark_opaque_project_document("opaque project document");

        assert!(report.has_blocking_incompleteness);
        assert!(!report.opaque_project_documents_only);
        assert!(report.require_visualization_safe().is_err());
    }

    fn live_snapshot_bytes(
        run_id: &str,
        artifacts: &[(&str, &str)],
        opaque_inline_field: bool,
    ) -> Vec<u8> {
        let artifacts = artifacts
            .iter()
            .map(|(path, kind)| json!({"path": path, "kind": kind}))
            .collect::<Vec<_>>();
        let mut snapshot = json!({
            "session_protocol_version": "v2",
            "capability_profile_version": "v1",
            "session": {"session_id": "session-1", "run_id": run_id},
            "runtime_status": {},
            "artifacts": artifacts,
            "display_selection": {},
            "preview_config": {},
            "mesh_revision": 1,
            "mesh_build_revision": 1,
        });
        if opaque_inline_field {
            snapshot["metadata"] = json!({"legacy_payload_ref": "not-a-cas-object"});
        }
        serde_json::to_vec(&snapshot).unwrap()
    }

    #[test]
    fn live_snapshot_artifacts_retain_spectrum_and_zarr_in_store_archive_and_export_inventory() {
        let directory = tempfile::tempdir().unwrap();
        let run_id = "run-live";
        let spectrum_relative = "eigen/spectrum.v2.json";
        let zarr_relative = "fields/m.zarr";
        let zarr_file_relative = "single.zarr";
        let snapshot = live_snapshot_bytes(
            run_id,
            &[(spectrum_relative, "json"), (zarr_relative, "zarr"), (zarr_file_relative, "zarr")],
            false,
        );

        let store_root = directory.path().join("store");
        let store_snapshot = store_root.join("project/current_live_snapshot.json");
        fs::create_dir_all(store_snapshot.parent().unwrap()).unwrap();
        fs::write(&store_snapshot, &snapshot).unwrap();
        let store_artifacts = store_root.join("runs/run-live/artifacts");
        fs::create_dir_all(store_artifacts.join("eigen")).unwrap();
        fs::write(store_artifacts.join(spectrum_relative), b"spectrum").unwrap();
        fs::write(store_artifacts.join(zarr_file_relative), b"single-zarr-file").unwrap();
        let zarr_root = store_artifacts.join(zarr_relative);
        fs::create_dir_all(&zarr_root).unwrap();
        fs::write(zarr_root.join(".zgroup"), b"{}").unwrap();

        let store_report = walk_store_root(&store_root, ReachabilityMode::Restore).unwrap();
        assert!(store_report.complete, "{:?}", store_report.warnings);
        assert!(store_report.file_refs.contains("runs/run-live/artifacts/eigen/spectrum.v2.json"));
        assert!(store_report.file_refs.contains("runs/run-live/artifacts/fields/m.zarr/.zgroup"));
        assert!(store_report.file_refs.contains("runs/run-live/artifacts/single.zarr"));

        let spectrum_path = "runs/run-live/artifacts/eigen/spectrum.v2.json";
        let zarr_member_path = "runs/run-live/artifacts/fields/m.zarr/.zgroup";
        let zarr_file_path = "runs/run-live/artifacts/single.zarr";
        let archive = HashMap::from([
            ("project/current_live_snapshot.json".to_string(), snapshot.clone()),
            (spectrum_path.to_string(), b"spectrum".to_vec()),
            (zarr_member_path.to_string(), b"{}".to_vec()),
            (zarr_file_path.to_string(), b"single-zarr-file".to_vec()),
        ]);
        let archive_report = walk_archive_documents(&archive, ReachabilityMode::Export).unwrap();
        assert!(archive_report.complete, "{:?}", archive_report.warnings);
        assert!(archive_report.file_refs.contains(spectrum_path));
        assert!(archive_report.file_refs.contains(zarr_member_path));
        assert!(archive_report.file_refs.contains(zarr_file_path));

        let inventory_root = directory.path().join("inventory");
        let inventory_spectrum = inventory_root.join(spectrum_path);
        let inventory_zarr_member = inventory_root.join(zarr_member_path);
        let inventory_zarr_file = inventory_root.join(zarr_file_path);
        fs::create_dir_all(inventory_spectrum.parent().unwrap()).unwrap();
        fs::create_dir_all(inventory_zarr_member.parent().unwrap()).unwrap();
        fs::create_dir_all(inventory_zarr_file.parent().unwrap()).unwrap();
        fs::write(&inventory_spectrum, b"spectrum").unwrap();
        fs::write(&inventory_zarr_member, b"{}").unwrap();
        fs::write(&inventory_zarr_file, b"single-zarr-file").unwrap();
        let snapshots = HashMap::from([
            (
                spectrum_path.to_string(),
                ArchiveFileSnapshot::capture(&inventory_spectrum).unwrap(),
            ),
            (
                zarr_member_path.to_string(),
                ArchiveFileSnapshot::capture(&inventory_zarr_member).unwrap(),
            ),
            (
                zarr_file_path.to_string(),
                ArchiveFileSnapshot::capture(&inventory_zarr_file).unwrap(),
            ),
        ]);
        let inline_project = HashMap::from([(
            "project/current_live_snapshot.json".to_string(),
            snapshot,
        )]);
        let export_report = walk_export_file_documents_with_project(
            &snapshots,
            &inventory_root,
            &inline_project,
        )
        .unwrap();
        assert!(export_report.complete, "{:?}", export_report.warnings);
        assert!(export_report.file_refs.contains(spectrum_path));
        assert!(export_report.file_refs.contains(zarr_member_path));
        assert!(export_report.file_refs.contains(zarr_file_path));
    }

    #[test]
    fn missing_live_artifacts_block_store_gc_and_archive_even_when_snapshot_is_opaque() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot = live_snapshot_bytes(
            "run-missing",
            &[("eigen/spectrum.v2.json", "json"), ("fields/m.zarr", "zarr")],
            true,
        );
        let store_root = directory.path().join("store");
        let snapshot_path = store_root.join("project/current_live_snapshot.json");
        fs::create_dir_all(snapshot_path.parent().unwrap()).unwrap();
        fs::write(&snapshot_path, &snapshot).unwrap();

        let store_report = walk_store_root(&store_root, ReachabilityMode::Restore).unwrap();
        assert!(!store_report.complete);
        assert!(store_report.has_blocking_incompleteness);
        assert!(!store_report.opaque_project_documents_only);
        assert!(store_report.require_visualization_safe().is_err());
        assert!(walk_store_root(&store_root, ReachabilityMode::Gc).is_err());

        let archive = HashMap::from([(
            "project/current_live_snapshot.json".to_string(),
            snapshot.clone(),
        )]);
        let archive_report = walk_archive_documents(&archive, ReachabilityMode::Export).unwrap();
        assert!(!archive_report.complete);
        assert!(archive_report.has_blocking_incompleteness);
        assert!(!archive_report.opaque_project_documents_only);
        assert!(archive_report.require_visualization_safe().is_err());

        let inventory_root = directory.path().join("empty-inventory");
        fs::create_dir_all(&inventory_root).unwrap();
        let inline_project = HashMap::from([(
            "project/current_live_snapshot.json".to_string(),
            snapshot,
        )]);
        let export_report =
            walk_export_file_documents_with_project(&HashMap::new(), &inventory_root, &inline_project)
                .unwrap();
        assert!(!export_report.complete);
        assert!(export_report.has_blocking_incompleteness);
        assert!(!export_report.opaque_project_documents_only);
        assert!(export_report.require_visualization_safe().is_err());
    }

    #[test]
    fn unsafe_live_artifact_paths_and_run_ids_fail_closed_in_store_and_archive() {
        let directory = tempfile::tempdir().unwrap();
        for path in [
            "../outside.json",
            "C:/outside.json",
            "fields\\m.zarr",
            "/absolute.json",
            "fields//spectrum.json",
        ] {
            let snapshot = live_snapshot_bytes("run-safe", &[(path, "json")], false);
            let store_root = directory.path().join(format!("store-{}", path.len()));
            let snapshot_path = store_root.join("project/current_live_snapshot.json");
            fs::create_dir_all(snapshot_path.parent().unwrap()).unwrap();
            fs::write(&snapshot_path, &snapshot).unwrap();
            assert!(
                walk_store_root(&store_root, ReachabilityMode::Restore).is_err(),
                "store accepted artifact path {path:?}"
            );
            let archive = HashMap::from([(
                "project/current_live_snapshot.json".to_string(),
                snapshot,
            )]);
            assert!(
                walk_archive_documents(&archive, ReachabilityMode::Export).is_err(),
                "archive accepted artifact path {path:?}"
            );
        }
        for run_id in ["../outside", "C:drive", "nested/run", "bad\\run"] {
            let snapshot = live_snapshot_bytes(run_id, &[("spectrum.json", "json")], false);
            let store_root = directory.path().join(format!("run-{}", run_id.len()));
            let snapshot_path = store_root.join("project/current_live_snapshot.json");
            fs::create_dir_all(snapshot_path.parent().unwrap()).unwrap();
            fs::write(&snapshot_path, &snapshot).unwrap();
            assert!(
                walk_store_root(&store_root, ReachabilityMode::Restore).is_err(),
                "store accepted run id {run_id:?}"
            );
            let archive = HashMap::from([(
                "project/current_live_snapshot.json".to_string(),
                snapshot,
            )]);
            assert!(
                walk_archive_documents(&archive, ReachabilityMode::Export).is_err(),
                "archive accepted run id {run_id:?}"
            );
        }
    }

    #[test]
    fn store_and_file_export_reject_live_artifact_symlinks_or_reparse_points() {
        let directory = tempfile::tempdir().unwrap();
        let external = directory.path().join("outside.bin");
        fs::write(&external, b"outside").unwrap();
        let external_directory = directory.path().join("outside-directory");
        fs::create_dir_all(&external_directory).unwrap();
        fs::write(external_directory.join("payload.bin"), b"outside directory").unwrap();

        let store_root = directory.path().join("store-link");
        let snapshot_path = store_root.join("project/current_live_snapshot.json");
        fs::create_dir_all(snapshot_path.parent().unwrap()).unwrap();
        fs::write(
            &snapshot_path,
            live_snapshot_bytes("run-link", &[("fields/m.zarr", "zarr")], false),
        )
        .unwrap();
        let zarr_root = store_root.join("runs/run-link/artifacts/fields/m.zarr");
        fs::create_dir_all(&zarr_root).unwrap();
        let zarr_link = zarr_root.join("linked-directory");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external_directory, &zarr_link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&external_directory, &zarr_link).unwrap();
        assert!(walk_store_root(&store_root, ReachabilityMode::Restore).is_err());

        let inventory_root = directory.path().join("inventory-link");
        let relative = "runs/run-link/artifacts/spectrum.json";
        let inventory_path = inventory_root.join(relative);
        fs::create_dir_all(inventory_path.parent().unwrap()).unwrap();
        let inventory_link = inventory_path;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, &inventory_link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&external, &inventory_link).unwrap();
        let snapshots = HashMap::from([(
            relative.to_string(),
            ArchiveFileSnapshot::from_bytes(b"outside"),
        )]);
        let inline_project = HashMap::from([(
            "project/current_live_snapshot.json".to_string(),
            live_snapshot_bytes("run-link", &[("spectrum.json", "json")], false),
        )]);
        assert!(walk_export_file_documents_with_project(
            &snapshots,
            &inventory_root,
            &inline_project,
        )
        .is_err());
    }

    #[test]
    fn file_export_project_overlay_rejects_nonproject_and_shadow_keys() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot_path = "project/current_live_snapshot.json";
        let snapshots = HashMap::from([(
            snapshot_path.to_string(),
            ArchiveFileSnapshot::from_bytes(b"inventory"),
        )]);
        let shadow = HashMap::from([(snapshot_path.to_string(), b"inline".to_vec())]);
        assert!(walk_export_file_documents_with_project(&snapshots, directory.path(), &shadow).is_err());

        let nonproject = HashMap::from([(
            "objects/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            b"inline".to_vec(),
        )]);
        assert!(walk_export_file_documents_with_project(&HashMap::new(), directory.path(), &nonproject).is_err());
    }

    #[test]
    fn archive_rejects_live_artifact_file_and_subtree_collision() {
        let snapshot = live_snapshot_bytes("run-conflict", &[("fields/m.zarr", "zarr")], false);
        let archive = HashMap::from([
            (
                "project/current_live_snapshot.json".to_string(),
                snapshot,
            ),
            (
                "runs/run-conflict/artifacts/fields/m.zarr".to_string(),
                b"file payload".to_vec(),
            ),
            (
                "runs/run-conflict/artifacts/fields/m.zarr/.zgroup".to_string(),
                b"{}".to_vec(),
            ),
        ]);
        assert!(walk_archive_documents(&archive, ReachabilityMode::Export).is_err());
    }
    fn digest(letter: char) -> String {
        format!("sha256:{}", letter.to_string().repeat(64))
    }

    fn field_descriptor() -> DatasetFieldDescriptor {
        let descriptor = DatasetFieldDescriptor {
            quantity_id: QuantityId::M,
            unit: "1".to_string(),
            tensor_rank: 1,
            frame: FieldFrameDescriptor {
                kind: FieldFrameKind::Laboratory,
                frame_id: "frame:lab".to_string(),
            },
            sample_location: FieldSampleLocation::Node,
            active_support: ActiveSupportDescriptor {
                support_fingerprint: digest('c'),
                selection: None,
            },
            function_space: Some(FunctionSpaceDescriptor {
                space_id: "space:fem-h1-p1".to_string(),
                family: "H1".to_string(),
                order: 1,
                vector_dimension: 3,
                ordering: FunctionSpaceOrdering::ByNode,
                basis_id: "basis:fem-h1-p1".to_string(),
                constraints_fingerprint: None,
                partition_fingerprint: None,
                orientation_mapping_ref: None,
            }),
            topology_id: "topology".to_string(),
            carrier_id: "carrier".to_string(),
            layout_digest: digest('d'),
            axes: vec![
                FieldAxisDescriptor {
                    axis_id: "node".to_string(),
                    unit: "1".to_string(),
                    length: 2,
                },
                FieldAxisDescriptor {
                    axis_id: "component".to_string(),
                    unit: "1".to_string(),
                    length: 3,
                },
            ],
            component_axis: Some("component".to_string()),
            complex_encoding: fullmag_quantities::ComplexEncoding::Real,
            harmonic_convention: None,
            normalization: FieldNormalization::None,
            value_representation: FieldValueRepresentation::PhysicalField,
            modal_semantics: None,
            resolution: FieldResolution::Quantitative,
        };
        descriptor.validate().expect("reachability field fixture is valid");
        descriptor
    }

    struct TensorFixture {
        artifact: SolutionArtifactRef,
        descriptor: TensorDescriptor,
        objects: HashMap<String, Vec<u8>>,
    }

    fn tensor_fixture(label: &str, value: u8) -> TensorFixture {
        let chunk_bytes = vec![value; 48];
        let chunk_ref = crate::hex_sha256(&chunk_bytes);
        let descriptor = TensorDescriptor {
            format: SOLUTION_TENSOR_SCHEMA.to_string(),
            name: format!("magnetization-{label}"),
            dtype: TensorDtype::F64,
            shape: vec![2, 3],
            logical_axes: vec!["node".to_string(), "component".to_string()],
            endian: "little".to_string(),
            field_binding: Some(TensorFieldBinding {
                format: TENSOR_FIELD_BINDING_SCHEMA.to_string(),
                dataset: MaterializedDatasetRef {
                    dataset_id: "dataset:reachability".to_string(),
                    revision: 1,
                },
                sample_id: "sample".to_string(),
                item_id: "item".to_string(),
                field_id: "field:m".to_string(),
                group_id: "group:reachability".to_string(),
                producer_id: "producer:reachability".to_string(),
                producer_version: "1".to_string(),
                plane: DatasetSlicePlane::Values,
                descriptor: field_descriptor(),
            }),
            chunks: vec![TensorChunk {
                object_ref: chunk_ref.clone(),
                offset: 0,
                length: chunk_bytes.len(),
                sha256: Some(chunk_ref.clone()),
            }],
        };
        let descriptor_bytes = serde_json::to_vec(&descriptor).expect("serialize tensor fixture");
        let descriptor_ref = crate::hex_sha256(&descriptor_bytes);
        let artifact = SolutionArtifactRef {
            artifact_id: format!("tensor-{label}"),
            kind: SolutionArtifactKind::State,
            schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            object_ref: descriptor_ref.clone(),
            byte_length: descriptor_bytes.len() as u64,
            accepted_state: None,
        };
        let objects = HashMap::from([
            (chunk_ref, chunk_bytes),
            (descriptor_ref, descriptor_bytes),
        ]);
        TensorFixture {
            artifact,
            descriptor,
            objects,
        }
    }

    fn reachability_solution(
        revision: u64,
        artifacts: Vec<SolutionArtifactRef>,
        run_spec_digest: String,
    ) -> SolutionSet {
        let assessment = ScientificAssessment {
            status: ScientificAssessmentStatus::Unassessed,
            reason: Some("reachability fixture".to_string()),
            evidence_artifact_ids: Vec::new(),
        };
        SolutionSet {
            schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "reachability-solution".to_string(),
            revision,
            run_id: "reachability-run".to_string(),
            manifest_state: SolutionSetManifestState::Closed,
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: assessment.clone(),
            provenance: SolutionSetProvenance {
                run_spec_digest,
                model_digest: digest('b'),
                physics_digest: digest('c'),
                discretization_digest: digest('d'),
                resolved_plan_digest: digest('e'),
                acquisition_digest: digest('f'),
                seed_digest: None,
            },
            members: vec![SolutionMember {
                member_id: "member".to_string(),
                task_id: "task".to_string(),
                attempt_id: "attempt".to_string(),
                ownership_epoch: 1,
                case_id: Some("case".to_string()),
                stage_id: "stage".to_string(),
                execution_status: SolutionExecutionStatus::Succeeded,
                scientific_assessment: assessment,
                artifacts,
            }],
            coverage: Vec::new(),
        }
    }

    fn materialized_artifact(
        manifest: &MaterializedDatasetManifest,
    ) -> (SolutionArtifactRef, Vec<u8>) {
        let bytes = serde_json::to_vec(manifest).expect("serialize dataset fixture");
        let object_ref = crate::hex_sha256(&bytes);
        let artifact = SolutionArtifactRef {
            artifact_id: format!("materialized-dataset-{object_ref}"),
            kind: SolutionArtifactKind::Other,
            schema_id: MATERIALIZED_DATASET_SCHEMA.to_string(),
            object_ref,
            byte_length: bytes.len() as u64,
            accepted_state: None,
        };
        (artifact, bytes)
    }

    fn write_store_fixture(
        root: &Path,
        solution: &SolutionSet,
        intent: &FmsRunIntent,
        objects: &HashMap<String, Vec<u8>>,
    ) {
        let objects_root = root.join("objects/sha256");
        let run_root = root.join("runs").join(&solution.run_id);
        let solution_root = root
            .join("solutions")
            .join(crate::hex_sha256(solution.solution_set_id.as_bytes()));
        fs::create_dir_all(&objects_root).expect("create fixture CAS");
        fs::create_dir_all(&run_root).expect("create fixture run");
        fs::create_dir_all(solution_root.join("revisions")).expect("create fixture revisions");
        for (object_ref, bytes) in objects {
            fs::write(objects_root.join(object_ref), bytes).expect("write fixture CAS object");
        }
        fs::write(
            run_root.join("run_intent.json"),
            serde_json::to_vec(intent).expect("serialize fixture intent"),
        )
        .expect("write fixture intent");
        let solution_bytes = serde_json::to_vec(solution).expect("serialize fixture solution");
        fs::write(solution_root.join("manifest.json"), &solution_bytes)
            .expect("write fixture current solution");
        fs::write(
            solution_root
                .join("revisions")
                .join(format!("{:020}.json", solution.revision)),
            solution_bytes,
        )
        .expect("write fixture solution revision");
    }

    fn archive_fixture(
        solution: &SolutionSet,
        intent: &FmsRunIntent,
        objects: &HashMap<String, Vec<u8>>,
    ) -> HashMap<String, Vec<u8>> {
        let directory = crate::hex_sha256(solution.solution_set_id.as_bytes());
        let solution_bytes = serde_json::to_vec(solution).expect("serialize archive solution");
        let mut documents = HashMap::from([
            (
                format!("solutions/{directory}/manifest.json"),
                solution_bytes.clone(),
            ),
            (
                format!(
                    "solutions/{directory}/revisions/{:020}.json",
                    solution.revision
                ),
                solution_bytes,
            ),
            (
                format!("runs/{}/run_intent.json", solution.run_id),
                serde_json::to_vec(intent).expect("serialize archive intent"),
            ),
        ]);
        documents.extend(
            objects
                .iter()
                .map(|(object_ref, bytes)| (format!("objects/sha256/{object_ref}"), bytes.clone())),
        );
        documents
    }

    fn fixture_objects(fixtures: &[&TensorFixture]) -> HashMap<String, Vec<u8>> {
        let mut objects = HashMap::new();
        for fixture in fixtures {
            objects.extend(fixture.objects.clone());
        }
        objects
    }

    #[test]
    fn store_and_archive_walkers_reject_duplicate_dataset_revision_with_distinct_roots() {
        let intent = FmsRunIntent::new(
            "reachability-run",
            "reachability-intent",
            json!({"run_id": "reachability-run", "kind": "reachability-fixture"}),
        );
        let first = tensor_fixture("a", 1);
        let second = tensor_fixture("b", 2);
        let mut solution = reachability_solution(
            1,
            vec![first.artifact.clone(), second.artifact.clone()],
            format!("sha256:{}", intent.payload_sha256),
        );
        let first_manifest = MaterializedDatasetManifest::from_recorded_tensor(
            &solution,
            "member",
            &first.artifact,
            &first.descriptor,
        )
        .expect("build first dataset fixture");
        let second_manifest = MaterializedDatasetManifest::from_recorded_tensor(
            &solution,
            "member",
            &second.artifact,
            &second.descriptor,
        )
        .expect("build second dataset fixture");
        let (first_artifact, first_bytes) = materialized_artifact(&first_manifest);
        let (second_artifact, second_bytes) = materialized_artifact(&second_manifest);
        solution.members[0].artifacts.extend([
            first_artifact.clone(),
            second_artifact.clone(),
        ]);
        solution.validate().expect("duplicate fixture solution is structural");

        let mut objects = fixture_objects(&[&first, &second]);
        objects.insert(first_artifact.object_ref.clone(), first_bytes);
        objects.insert(second_artifact.object_ref.clone(), second_bytes);
        let directory = tempfile::tempdir().expect("temporary duplicate fixture");
        let store_root = directory.path().join("store");
        write_store_fixture(&store_root, &solution, &intent, &objects);
        let store_error = walk_store_root(&store_root, ReachabilityMode::Restore)
            .expect_err("store walker accepted duplicate dataset identity");
        assert!(store_error.to_string().contains("duplicated"));

        let archive_error = walk_archive_documents(
            &archive_fixture(&solution, &intent, &objects),
            ReachabilityMode::Restore,
        )
        .expect_err("archive walker accepted duplicate dataset identity");
        assert!(archive_error.to_string().contains("duplicated"));
    }

    #[test]
    fn store_and_archive_walkers_reject_missing_historical_dataset_owner() {
        let intent = FmsRunIntent::new(
            "reachability-run",
            "reachability-intent-history",
            json!({"run_id": "reachability-run", "kind": "reachability-history-fixture"}),
        );
        let tensor = tensor_fixture("history", 3);
        let mut solution = reachability_solution(
            2,
            vec![tensor.artifact.clone()],
            format!("sha256:{}", intent.payload_sha256),
        );
        let mut manifest = MaterializedDatasetManifest::from_recorded_tensor(
            &solution,
            "member",
            &tensor.artifact,
            &tensor.descriptor,
        )
        .expect("build historical dataset fixture");
        let historical_source = DatasetSource::PinnedSolution {
            solution_id: solution.solution_set_id.clone(),
            solution_revision: 1,
        };
        manifest.field.source.solution_revision = 1;
        manifest.dataset.source = historical_source.clone();
        manifest.definition.source = historical_source;
        manifest.validate().expect("historical dataset fixture is structural");
        let (manifest_artifact, manifest_bytes) = materialized_artifact(&manifest);
        solution.members[0].artifacts.push(manifest_artifact.clone());
        solution.validate().expect("historical fixture solution is structural");

        let mut objects = fixture_objects(&[&tensor]);
        objects.insert(manifest_artifact.object_ref.clone(), manifest_bytes);
        let directory = tempfile::tempdir().expect("temporary historical fixture");
        let store_root = directory.path().join("store");
        write_store_fixture(&store_root, &solution, &intent, &objects);
        let store_error = walk_store_root(&store_root, ReachabilityMode::Restore)
            .expect_err("store walker accepted missing historical owner");
        assert!(store_error.to_string().contains("revisions/00000000000000000001"));

        let archive_error = walk_archive_documents(
            &archive_fixture(&solution, &intent, &objects),
            ReachabilityMode::Restore,
        )
        .expect_err("archive walker accepted missing historical owner");
        assert!(archive_error.to_string().contains("historical"));
    }
}
