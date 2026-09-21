//! Typed reachability traversal for session storage and portable archives.
//!
//! A checkpoint descriptor is only a root.  The descriptor, its common state,
//! and every tensor chunk are part of the same object graph.  Keeping this
//! traversal here gives garbage collection, export, and restore the same
//! interpretation of that graph.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::types::{
    ArtifactIndex, BackendStatePayload, CommonSolverState, FieldRole, FmsCheckpoint,
    FmsExportProfile, FmsRunManifest, FmsSessionManifest, FmsWorkspaceManifest, TensorDescriptor,
};

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
        self.warnings.push(message.clone());
        Ok(())
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
        documents,
        mode,
        report: ReachabilityReport::new(),
        seen_checkpoints: HashSet::new(),
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
        self.walk_runs_dir()?;
        self.walk_objects_dir()?;

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
                "manifests" | "runs" | "recovery" | "objects" => {
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
                        self.report.complete = false;
                        self.report.warnings.push(format!(
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
            self.read_file(&entry.path(), &relative)?;
            if !KNOWN_LEAFS.contains(&name.as_str()) {
                self.report.complete = false;
                self.report.warnings.push(format!(
                    "unknown project document `{relative}` requires conservative GC"
                ));
            } else if matches!(
                name.as_str(),
                "asset_index.json" | "current_live_snapshot.json"
            ) {
                self.report.complete = false;
                self.report.warnings.push(format!(
                    "project document `{relative}` has untyped object references; conservative GC required"
                ));
            }
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
            let run_ref = format!("runs/{run_id}/run_manifest.json");
            let run_path = run_entry.path().join("run_manifest.json");
            if run_path.exists() {
                self.walk_run_file(&run_ref, &run_id)?;
            }
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
                validate_restart_payload(data, kind, source)?;
            }
            ReferenceKind::IntegratorPayload | ReferenceKind::RngPayload => {
                validate_restart_payload(data, kind, source)?;
            }
            ReferenceKind::Unknown => {
                // Opaque plan/live documents may carry CAS references that
                // this walker cannot interpret.  Retaining the file itself is
                // insufficient for a safe mark set, so GC/export stays
                // incomplete until the document schema gets a typed walker.
                self.report.complete = false;
                self.report.warnings.push(format!(
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
    documents: &'a HashMap<String, Vec<u8>>,
    mode: ReachabilityMode,
    report: ReachabilityReport,
    seen_checkpoints: HashSet<String>,
}

impl<'a> ArchiveWalker<'a> {
    fn walk_archive(&mut self) -> Result<ReachabilityReport> {
        self.validate_archive_namespace()?;
        if let Some(data) = self.documents.get("manifest/session.json") {
            let session: FmsSessionManifest = parse_json(data, "manifest/session.json")?;
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

        if matches!(self.mode, ReachabilityMode::Gc) && !self.report.complete {
            self.report.require_complete()?;
        }
        Ok(std::mem::take(&mut self.report))
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
                        self.report.complete = false;
                        self.report.warnings.push(format!(
                            "unknown archive project document `{name}` requires conservative retention"
                        ));
                    } else if matches!(remainder, "asset_index.json" | "current_live_snapshot.json")
                    {
                        self.report.complete = false;
                        self.report.warnings.push(format!(
                            "archive project document `{name}` has untyped object references; conservative retention required"
                        ));
                    }
                }
                "runs" => {}
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

    fn walk_run(&mut self, run_ref: &str, expected_run_id: &str) -> Result<()> {
        let Some(data) = self.documents.get(run_ref) else {
            return self.report.missing(format!(
                "archive references missing run manifest `{run_ref}`"
            ));
        };
        let run: FmsRunManifest = parse_json(data, run_ref)?;
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

    fn walk_checkpoint(
        &mut self,
        relative: &str,
        expected_run_id: &str,
        expected_checkpoint_id: &str,
    ) -> Result<()> {
        if !self.seen_checkpoints.insert(relative.to_string()) {
            return Ok(());
        }
        let Some(data) = self.documents.get(relative) else {
            return self.report.missing(format!(
                "archive references missing checkpoint `{relative}`"
            ));
        };
        let checkpoint: FmsCheckpoint = parse_json(data, relative)?;
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
                let archive_path = format!("objects/sha256/{reference}");
                let data = self
                    .documents
                    .get(&archive_path)
                    .cloned()
                    .context("validated archive object disappeared")?;
                self.follow_archive_payload(&data, source, kind)?;
            }
            return Ok(());
        }
        validate_file_ref(reference)
            .with_context(|| format!("invalid reference `{reference}` in `{source}`"))?;
        let Some(data) = self.documents.get(reference).cloned() else {
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
                let state: CommonSolverState = parse_json(data, source)?;
                if let Some(object_ref) = state.magnetization_ref {
                    self.add_archive_payload(&object_ref, source, None)?;
                }
            }
            ReferenceKind::ArtifactIndex => {
                let index: ArtifactIndex = parse_json(data, source)?;
                for entry in index.entries {
                    if let Some(object_ref) = entry.object_ref {
                        self.add_archive_payload(&object_ref, source, None)?;
                    }
                }
            }
            ReferenceKind::BackendState => {
                validate_restart_payload(data, kind, source)?;
            }
            ReferenceKind::IntegratorPayload | ReferenceKind::RngPayload => {
                validate_restart_payload(data, kind, source)?;
            }
            ReferenceKind::Unknown => {
                self.report.complete = false;
                self.report.warnings.push(format!(
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
        let Some(data) = self.documents.get(&checkpoint.common_state_ref) else {
            return Ok(());
        };
        let state: CommonSolverState = parse_json(data, &checkpoint.common_state_ref)?;
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
        let Some(data) = self.documents.get(&archive_path) else {
            self.report.missing(format!(
                "`{source}` references missing object `{object_ref}`"
            ))?;
            return Ok(false);
        };
        if crate::cas::hex_sha256(data) != object_ref {
            bail!("CAS SHA-256 mismatch for `{archive_path}`")
        }
        let descriptor: TensorDescriptor = parse_json(data, &archive_path)?;
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
        let archive_path = format!("objects/sha256/{object_ref}");
        let Some(data) = self.documents.get(&archive_path) else {
            self.report.missing(format!(
                "`{source}` references missing object `{object_ref}`"
            ))?;
            return Ok(false);
        };
        if crate::cas::hex_sha256(data) != object_ref {
            bail!("CAS SHA-256 mismatch for `{archive_path}`")
        }
        if expected_length.is_some_and(|length| data.len() != length) {
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

fn validate_restart_payload(data: &[u8], kind: ReferenceKind, source: &str) -> Result<()> {
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
        }
        ReferenceKind::IntegratorPayload => {
            let value: serde_json::Value = parse_json(data, source)?;
            if value.as_object().map_or(true, |map| map.is_empty()) {
                bail!("restart payload `{source}` has no material state")
            }
        }
        ReferenceKind::RngPayload => {
            let state: crate::types::RngState = parse_json(data, source)?;
            if state.stream_family.trim().is_empty() {
                bail!("RNG restart payload `{source}` has no usable stream identity")
            }
        }
        _ => {}
    }
    Ok(())
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
    Ok(())
}

fn parse_json<T: serde::de::DeserializeOwned>(data: &[u8], source: &str) -> Result<T> {
    serde_json::from_slice(data).with_context(|| format!("parsing JSON root `{source}`"))
}

fn is_object_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
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
