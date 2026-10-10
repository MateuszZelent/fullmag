//! Portable `.fms` archive format — ZIP64-based session package.
//!
//! A `.fms` file is a standard ZIP64 archive with a deterministic layout:
//! ```text
//! example.fms
//! ├─ manifest/
//! │  ├─ session.json
//! │  ├─ workspace.json
//! │  └─ export_profile.json
//! ├─ project/
//! │  ├─ main.py           (user script)
//! │  ├─ problem_ir.json
//! │  ├─ scene_document.json
//! │  ├─ script_builder.json
//! │  ├─ model_builder_graph.json
//! │  └─ ui_state.json
//! ├─ runs/
//! │  └─ <run_id>/
//! │     ├─ run_manifest.json
//! │     ├─ run_intent.json
//! │     ├─ run_catalog.json
//! │     ├─ artifact_catalog.json
//! │     ├─ preparation_receipt.json
//! │     ├─ task_preparation_receipts/
//! │     │  └─ <task_id>.json
//! │     ├─ task_admissions/
//! │     │  └─ <task_id>/<attempt_id>.json
//! │     ├─ resource_leases/
//! │     ├─ preparation_resource_leases/
//! │     ├─ retry_decisions/
//! │     ├─ preparation_retry_decisions/
//! │     ├─ worker_process_exit_receipts/
//! │     ├─ preparation_process_launches/
//! │     ├─ preparation_process_exit_receipts/
//! │     ├─ coordinator_journal/
//! │     ├─ checkpoints/
//! │     └─ artifacts/
//! ├─ solutions/
//! │  └─ <sha256(logical-id)>/
//! │     ├─ manifest.json
//! │     └─ revisions/<20-digit-revision>.json
//! └─ objects/
//!    └─ sha256/
//! ```

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::archive_source::ArchiveSource;
use crate::archive_document::{ArchiveDocuments, ArchiveFileSnapshot, MAX_CONTROL_DOCUMENT_BYTES};
use crate::reachability::{self, ReachabilityMode, ReachabilityReport};
use crate::store::SessionStore;
use crate::types::*;

/// Options controlling how the `.fms` file is written.
pub struct PackOptions {
    pub compression: CompressionProfile,
}

/// The validated, in-memory contents of an `.fms` archive.
///
/// Callers may safely inspect or persist `documents` only after preflight has
/// checked archive paths, duplicate names, size limits, and content digests.
#[derive(Debug, Clone)]
pub struct FmsPreflight {
    pub session: FmsSessionManifest,
    pub workspace: FmsWorkspaceManifest,
    pub export_profile: FmsExportProfile,
    pub inspection: SessionInspection,
    /// The same typed object graph used by export and GC.  A report with
    /// `complete == false` is inspectable but cannot be published as a
    /// solved/resumable session.
    pub reachability: ReachabilityReport,
    pub documents: HashMap<String, Vec<u8>>,
}

const MAX_ZIP_ENTRIES: usize = 100_000;
const MAX_ZIP_DIRECTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_ZIP_BYTES: u64 = 64 * 1024 * 1024 * 1024;

struct ZipDirectoryEntry {
    name: String,
    compressed_size: u64,
    uncompressed_size: u64,
}

struct ZipDirectoryScan {
    entries: Vec<ZipDirectoryEntry>,
    total_compressed: u64,
}

struct PackEntry {
    archive_path: String,
    snapshot: ArchiveFileSnapshot,
}

impl PackEntry {
    fn from_bytes(archive_path: String, data: Vec<u8>) -> Self {
        Self { archive_path, snapshot: ArchiveFileSnapshot::from_bytes(&data) }
    }

    fn from_file(
        archive_path: String, store_root: &Path, canonical_root: &Path, source: &Path,
    ) -> Result<Self> {
        validate_store_source(store_root, canonical_root, source, false)?;
        Ok(Self { archive_path, snapshot: ArchiveFileSnapshot::capture(source)? })
    }
}

trait PackEntryInventory {
    fn push_entry(&mut self, entry: PackEntry) -> Result<()>;
}

impl PackEntryInventory for Vec<PackEntry> {
    fn push_entry(&mut self, entry: PackEntry) -> Result<()> {
        ArchiveLimitAccounting::validate_declared_entry_count(self.len() as u64 + 1)?;
        self.push(entry);
        Ok(())
    }
}

struct CasPackEntry {
    archive_path: String,
    source: PathBuf,
    object_ref: String,
    byte_count: u64,
}

#[derive(Default)]
struct ArchiveLimitAccounting {
    entries: u64,
    uncompressed_bytes: u64,
}

impl ArchiveLimitAccounting {
    fn validate_declared_entry_count(entry_count: u64) -> Result<()> {
        if entry_count > MAX_ZIP_ENTRIES as u64 {
            anyhow::bail!("too many ZIP entries: {entry_count} exceeds {MAX_ZIP_ENTRIES}");
        }
        Ok(())
    }

    fn account_entry(&mut self, uncompressed_size: u64) -> Result<()> {
        self.entries = self
            .entries
            .checked_add(1)
            .context("ZIP entry count overflow")?;
        Self::validate_declared_entry_count(self.entries)?;
        self.uncompressed_bytes = self
            .uncompressed_bytes
            .checked_add(uncompressed_size)
            .context("uncompressed ZIP size overflow")?;
        if self.uncompressed_bytes > MAX_UNCOMPRESSED_ZIP_BYTES {
            anyhow::bail!(
                "uncompressed ZIP size exceeds {} bytes",
                MAX_UNCOMPRESSED_ZIP_BYTES
            );
        }
        Ok(())
    }
}

impl Default for PackOptions {
    fn default() -> Self {
        Self {
            compression: CompressionProfile::Balanced,
        }
    }
}

fn zip_compression(profile: CompressionProfile) -> CompressionMethod {
    match profile {
        CompressionProfile::Speed => CompressionMethod::Stored,
        CompressionProfile::Balanced | CompressionProfile::Smallest => CompressionMethod::Deflated,
    }
}

fn zip_options(profile: CompressionProfile) -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(zip_compression(profile))
        .large_file(true)
}

// ── Pack (export) ──────────────────────────────────────────────────────

/// Pack a `SessionStore` snapshot into a `.fms` ZIP archive.
///
/// The `documents` map provides named JSON documents (e.g. scene, UI state)
/// that get written under `project/`.
pub fn pack_fms<W: Write + Seek>(
    writer: W,
    store: &SessionStore,
    session: &FmsSessionManifest,
    workspace: &FmsWorkspaceManifest,
    export_profile: &FmsExportProfile,
    documents: &HashMap<String, Vec<u8>>,
    opts: &PackOptions,
) -> Result<()> {
    let _lease = store.write_transaction()?;
    validate_pack_input(workspace, documents)?;
    let canonical_root = canonical_store_root(store.root())?;
    let mut run_entries = plan_run_entries(store.root(), &canonical_root, session, export_profile)?;
    let solution_entries = plan_solution_entries(store.root(), &canonical_root, export_profile)?;
    plan_solution_tensor_owner_entries(
        store.root(),
        &canonical_root,
        &solution_entries,
        &mut run_entries,
    )?;
    let cas_entries = plan_cas_entries(
        store.root(),
        &canonical_root,
        &run_entries,
        &solution_entries,
        documents,
    )?;
    validate_export_plan(
        session,
        workspace,
        export_profile,
        documents,
        &run_entries,
        &solution_entries,
        &cas_entries,
    )?;

    let mut zip = zip::ZipWriter::new(writer);
    let fopts = zip_options(opts.compression);

    // ── manifest/ ──────────────────────────────────────────────────────
    write_json(&mut zip, "manifest/session.json", session, fopts)?;
    write_json(&mut zip, "manifest/workspace.json", workspace, fopts)?;
    write_json(
        &mut zip,
        "manifest/export_profile.json",
        export_profile,
        fopts,
    )?;

    // ── project/ ───────────────────────────────────────────────────────
    for (name, data) in documents {
        let archive_path = project_archive_path(name)?;
        zip.start_file(&archive_path, fopts)?;
        zip.write_all(data)?;
    }

    // ── runs/ ──────────────────────────────────────────────────────────
    for entry in run_entries {
        zip.start_file(&entry.archive_path, fopts)?;
        let source = store.root().join(&entry.archive_path);
        validate_store_source(store.root(), &canonical_root, &source, false)?;
        crate::cas::copy_verified_file(
            &source, &entry.snapshot.content_sha256, entry.snapshot.byte_count, &mut zip,
        )?;
    }

    // ── solutions/ ─────────────────────────────────────────────────────
    for entry in solution_entries {
        zip.start_file(&entry.archive_path, fopts)?;
        let source = store.root().join(&entry.archive_path);
        validate_store_source(store.root(), &canonical_root, &source, false)?;
        crate::cas::copy_verified_file(
            &source, &entry.snapshot.content_sha256, entry.snapshot.byte_count, &mut zip,
        )?;
    }

    // ── objects/ ───────────────────────────────────────────────────────
    // Only include CAS objects that are referenced by packed checkpoints.
    for entry in cas_entries {
        // Use Stored for binary blobs — they're already compressed or incompressible.
        let blob_opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        zip.start_file(&entry.archive_path, blob_opts)?;
        validate_store_source(store.root(), &canonical_root, &entry.source, false)?;
        crate::cas::copy_verified_file(
            &entry.source,
            &entry.object_ref,
            entry.byte_count,
            &mut zip,
        )?;
    }

    zip.finish()?;
    Ok(())
}

/// Pack directly to a file through a unique sibling staging file.
///
/// Validation and graph traversal happen before the destination is replaced;
/// a failed export therefore cannot truncate a previously published archive.
/// The staged file is synced before the final same-directory rename.
pub fn pack_fms_file(
    path: &Path,
    store: &SessionStore,
    session: &FmsSessionManifest,
    workspace: &FmsWorkspaceManifest,
    export_profile: &FmsExportProfile,
    documents: &HashMap<String, Vec<u8>>,
    opts: &PackOptions,
) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    crate::repository_path::reject_link(parent)?;
    crate::repository_path::reject_link(path)?;
    if !parent.exists() {
        bail!("FMS output parent does not exist: {}", parent.display())
    }
    crate::writer::require_local_filesystem(parent)?;

    let temporary = parent.join(format!(".{}.fms.part", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = File::create_new(&temporary)
            .with_context(|| format!("creating staged FMS export {}", temporary.display()))?;
        pack_fms(
            &mut file,
            store,
            session,
            workspace,
            export_profile,
            documents,
            opts,
        )?;
        file.sync_all().context("syncing staged FMS export")?;
        drop(file);
        crate::repository_path::reject_link(path)?;
        fs::rename(&temporary, path)
            .with_context(|| format!("publishing FMS export {}", path.display()))?;
        crate::durability::sync_directory(parent).map_err(|error| {
            anyhow::Error::new(crate::durability::PublicationUncertain::new(
                path.to_path_buf(),
                error,
            ))
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn canonical_store_root(store_root: &Path) -> Result<PathBuf> {
    crate::repository_path::reject_link(store_root)?;
    let metadata = std::fs::symlink_metadata(store_root)
        .with_context(|| format!("reading session store metadata {}", store_root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        anyhow::bail!(
            "session store root must be a non-symlink directory: {}",
            store_root.display()
        );
    }
    std::fs::canonicalize(store_root)
        .with_context(|| format!("canonicalizing session store {}", store_root.display()))
}

fn plan_cas_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_entries: &[PackEntry],
    solution_entries: &[PackEntry],
    project_documents: &HashMap<String, Vec<u8>>,
) -> Result<Vec<CasPackEntry>> {
    let mut documents = HashMap::new();
    for entry in run_entries.iter().chain(solution_entries) {
        documents.insert(entry.archive_path.clone(), entry.snapshot.clone());
    }

    // Validate the namespace without reading unrelated CAS contents.
    // The shared archive walker resolves only the selected graph from files.
    let objects = store_root.join("objects/sha256");
    if store_source_exists(&objects)? {
        validate_store_source(store_root, canonical_root, &objects, true)?;
        for entry in std::fs::read_dir(&objects)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("objects/sha256/{name}");
            validate_portable_namespace_path(&relative)?;
            reachability::validate_object_ref(&name)?;
            validate_store_source(store_root, canonical_root, &entry.path(), false)?;
        }
    }
    // The separately supplied current workspace snapshot carries both CAS
    // and ordinary run-artifact edges. Validate its exact export bytes against
    // the selected inventory, not against extra files left in the source store.
    let snapshot = project_documents.get("current_live_snapshot.json")
        .or_else(|| project_documents.get("project/current_live_snapshot.json"));
    let report = if let Some(snapshot) = snapshot {
        let inline = HashMap::from([(
            "project/current_live_snapshot.json".to_string(), snapshot.clone(),
        )]);
        reachability::walk_export_file_documents_with_project(
            &documents, canonical_root, &inline,
        )?
    } else {
        reachability::walk_export_file_documents(&documents, canonical_root)?
    };
    report.require_complete()?;

    let mut entries = Vec::new();
    let mut object_refs = report.object_refs.into_iter().collect::<Vec<_>>();
    object_refs.sort_unstable();
    for hash in object_refs {
        let archive_path = format!("objects/sha256/{hash}");
        validate_portable_namespace_path(&archive_path)?;
        let source = store_root.join(&archive_path);
        validate_store_source(store_root, canonical_root, &source, false)?;
        let byte_count = crate::cas::verified_file_length(&source, &hash)?;
        entries.push(CasPackEntry {
            archive_path,
            source,
            object_ref: hash,
            byte_count,
        });
    }
    Ok(entries)
}

fn plan_solution_entries(
    store_root: &Path,
    canonical_root: &Path,
    profile: &FmsExportProfile,
) -> Result<Vec<PackEntry>> {
    if matches!(profile.include_artifacts, ArtifactPolicy::None) {
        return Ok(Vec::new());
    }
    let directory = store_root.join("solutions");
    if !store_source_exists(&directory)? {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    plan_artifact_directory(
        store_root,
        canonical_root,
        &directory,
        "solutions",
        &mut entries,
    )?;
    Ok(entries)
}

fn plan_solution_tensor_owner_entries(
    store_root: &Path,
    canonical_root: &Path,
    solution_entries: &[PackEntry],
    run_entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let mut owners: BTreeMap<String, (String, ArchiveFileSnapshot)> = BTreeMap::new();
    for entry in solution_entries {
        let Some((directory, expected_revision)) = solution_entry_identity(&entry.archive_path)?
        else {
            continue;
        };
        let data = entry
            .snapshot
            .read_control(canonical_root, &entry.archive_path)?;
        let solution: fullmag_quantities::SolutionSet = serde_json::from_slice(&data)
            .with_context(|| format!("parsing solution set `{}`", entry.archive_path))?;
        solution
            .validate()
            .with_context(|| format!("validating solution set `{}`", entry.archive_path))?;
        if crate::cas::hex_sha256(solution.solution_set_id.as_bytes()) != directory {
            bail!(
                "solution-set directory does not match logical identity `{}`",
                entry.archive_path
            );
        }
        if expected_revision.is_some_and(|revision| solution.revision != revision) {
            bail!(
                "solution-set revision path identity mismatch `{}`",
                entry.archive_path
            );
        }
        let has_tensor = solution.members.iter().any(|member| {
            member
                .artifacts
                .iter()
                .any(|artifact| {
                    artifact.schema_id == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA
                        || artifact.schema_id == crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
                })
        });
        if !has_tensor {
            continue;
        }

        crate::repository_path::validate_store_id(&solution.run_id)
            .with_context(|| format!("invalid tensor solution owner run `{}`", solution.run_id))?;
        let run_intent_path = store_root
            .join("runs")
            .join(&solution.run_id)
            .join("run_intent.json");
        let intent_data = read_store_file_if_exists(store_root, canonical_root, &run_intent_path)?
            .with_context(|| {
                format!(
                    "typed tensor solution `{}` requires owner run intent `{}`",
                    entry.archive_path,
                    run_intent_path.display()
                )
            })?;
        let intent: FmsRunIntent = serde_json::from_slice(&intent_data)
            .with_context(|| format!("parsing tensor owner run intent `{}`", solution.run_id))?;
        intent
            .validate()
            .with_context(|| format!("validating tensor owner run intent `{}`", solution.run_id))?;
        if intent.run_id != solution.run_id {
            bail!(
                "tensor solution `{}` owner run intent identity mismatch",
                entry.archive_path
            );
        }
        let owner_digest = format!("sha256:{}", intent.payload_sha256);
        if owner_digest != solution.provenance.run_spec_digest {
            bail!(
                "tensor solution `{}` RunSpec provenance does not match owner run intent",
                entry.archive_path
            );
        }
        if let Some((previous_digest, _)) = owners.get(&solution.run_id) {
            if previous_digest != &solution.provenance.run_spec_digest {
                bail!(
                    "tensor solutions for run `{}` have conflicting RunSpec provenance",
                    solution.run_id
                );
            }
            continue;
        }
        owners.insert(
            solution.run_id.clone(),
            (owner_digest, ArchiveFileSnapshot::from_bytes(&intent_data)),
        );
    }

    for (run_id, (_, snapshot)) in owners {
        let entry = PackEntry {
            archive_path: format!("runs/{run_id}/run_intent.json"),
            snapshot,
        };
        push_unique_pack_entry(run_entries, entry)?;
    }
    Ok(())
}

fn solution_entry_identity(path: &str) -> Result<Option<(&str, Option<u64>)>> {
    let mut components = path.split('/');
    if components.next() != Some("solutions") {
        return Ok(None);
    }
    let Some(directory) = components.next() else {
        return Ok(None);
    };
    reachability::validate_object_ref(directory)?;
    let rest = components.collect::<Vec<_>>();
    match rest.as_slice() {
        ["manifest.json"] => Ok(Some((directory, None))),
        ["revisions", file_name] => {
            let revision_text = file_name
                .strip_suffix(".json")
                .filter(|value| {
                    value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit())
                })
                .with_context(|| format!("invalid solution-set revision filename `{file_name}`"))?;
            let revision = revision_text.parse::<u64>()?;
            if revision == 0 {
                bail!("solution-set revision must be positive");
            }
            Ok(Some((directory, Some(revision))))
        }
        _ => Ok(None),
    }
}

fn push_unique_pack_entry(entries: &mut Vec<PackEntry>, entry: PackEntry) -> Result<()> {
    if let Some(existing) = entries
        .iter()
        .find(|existing| existing.archive_path == entry.archive_path)
    {
        if existing.snapshot.byte_count == entry.snapshot.byte_count
            && existing.snapshot.content_sha256 == entry.snapshot.content_sha256
        {
            return Ok(());
        }
        bail!("duplicate archive path with conflicting content `{}`", entry.archive_path);
    }
    entries.push_entry(entry)
}

fn plan_run_entries(
    store_root: &Path,
    canonical_root: &Path,
    session: &FmsSessionManifest,
    profile: &FmsExportProfile,
) -> Result<Vec<PackEntry>> {
    let mut entries = Vec::new();
    let mut seen_refs = HashSet::new();
    for run_ref in &session.run_refs {
        let run_id = parse_run_ref(run_ref)?;
        if !seen_refs.insert(run_ref) {
            anyhow::bail!("duplicate run reference `{run_ref}`");
        }
        let run_dir = store_root.join("runs").join(run_id);
        let run_manifest = run_dir.join("run_manifest.json");
        if let Some(data) = read_store_file_if_exists(store_root, canonical_root, &run_manifest)? {
            entries.push_entry(PackEntry::from_bytes(run_ref.clone(), data))?;
        }
        let run_intent = run_dir.join("run_intent.json");
        if let Some(data) = read_store_file_if_exists(store_root, canonical_root, &run_intent)? {
            entries.push_entry(PackEntry::from_bytes(format!("runs/{run_id}/run_intent.json"), data))?;
        }
        let run_catalog = run_dir.join("run_catalog.json");
        if let Some(data) = read_store_file_if_exists(store_root, canonical_root, &run_catalog)? {
            entries.push_entry(PackEntry::from_bytes(format!("runs/{run_id}/run_catalog.json"), data))?;
        }
        let artifact_catalog = run_dir.join("artifact_catalog.json");
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &artifact_catalog)?
        {
            entries.push_entry(PackEntry::from_bytes(format!("runs/{run_id}/artifact_catalog.json"), data))?;
        }
        let preparation_receipt = run_dir.join("preparation_receipt.json");
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &preparation_receipt)?
        {
            entries.push_entry(PackEntry::from_bytes(format!("runs/{run_id}/preparation_receipt.json"), data))?;
        }
        let task_receipt_dir = run_dir.join("task_preparation_receipts");
        if store_source_exists(&task_receipt_dir)? {
            validate_store_source(store_root, canonical_root, &task_receipt_dir, true)?;
            let mut receipt_files = Vec::new();
            for entry in fs::read_dir(&task_receipt_dir)? {
                let entry = entry?;
                crate::repository_path::reject_link(&entry.path())?;
                if !entry.file_type()?.is_file() {
                    bail!("task preparation receipt entry must be a file");
                }
                receipt_files.push(entry);
            }
            if !receipt_files.is_empty() {
                let catalog_path = run_dir.join("run_catalog.json");
                let catalog_data =
                    read_store_file_if_exists(store_root, canonical_root, &catalog_path)?
                        .context("task preparation receipts require a durable run catalog")?;
                let catalog: FmsRunCatalog = serde_json::from_slice(&catalog_data)
                    .context("task preparation receipt run catalog is not typed")?;
                catalog.validate()?;
                if catalog.run_id != run_id {
                    bail!("task preparation receipt catalog identity does not match run path");
                }
                let intent_path = run_dir.join("run_intent.json");
                let intent_data =
                    read_store_file_if_exists(store_root, canonical_root, &intent_path)?
                        .context("task preparation receipts require an accepted run intent")?;
                let intent: FmsRunIntent = serde_json::from_slice(&intent_data)
                    .context("task preparation receipt run intent is not typed")?;
                intent.validate()?;
                for entry in receipt_files {
                    let file_name = entry.file_name().to_string_lossy().into_owned();
                    let archive_path =
                        format!("runs/{run_id}/task_preparation_receipts/{file_name}");
                    validate_portable_namespace_path(&archive_path)?;
                    let data =
                        read_store_file_if_exists(store_root, canonical_root, &entry.path())?
                            .context("task preparation receipt disappeared during export")?;
                    let receipt: FmsTaskPreparationReceipt = serde_json::from_slice(&data)
                        .context("task preparation receipt is not typed")?;
                    if receipt.relative_path()? != archive_path {
                        bail!("task preparation receipt path identity mismatch");
                    }
                    receipt.validate_for_catalog(&catalog)?;
                    receipt.validate_for_run_intent(&intent)?;
                    entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
                }
            }
        }
        plan_resource_lease_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_preparation_resource_lease_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_task_admission_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_retry_decision_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_preparation_retry_decision_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_worker_process_exit_receipt_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_preparation_process_launch_entries(store_root, canonical_root, run_id, &mut entries)?;
        plan_preparation_process_exit_receipt_entries(
            store_root,
            canonical_root,
            run_id,
            &mut entries,
        )?;
        plan_coordinator_journal_entries(store_root, canonical_root, run_id, &mut entries)?;
        let inbox_root = store_root.join("runs").join(run_id).join("worker_inbox");
        if store_source_exists(&inbox_root)? {
            for file in fs::read_dir(&inbox_root)? {
                let file = file?;
                crate::repository_path::reject_link(&file.path())?;
                if !file.file_type()?.is_file() {
                    bail!("worker inbox entry must be a file");
                }
                let archive_path = format!(
                    "runs/{run_id}/worker_inbox/{}",
                    file.file_name().to_string_lossy()
                );
                validate_portable_namespace_path(&archive_path)?;
                if let Some(data) =
                    read_store_file_if_exists(store_root, canonical_root, &file.path())?
                {
                    let record: crate::FmsWorkerInboxRecord = serde_json::from_slice(&data)?;
                    if record.relative_path()? != archive_path {
                        bail!("worker inbox path identity mismatch");
                    }
                    entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
                }
            }
        }
        if profile.needs_checkpoints() {
            plan_checkpoint_entries(store_root, canonical_root, run_id, &mut entries)?;
        }
        if profile.include_artifacts() {
            plan_artifact_entries(store_root, canonical_root, run_id, &mut entries)?;
        }
    }
    Ok(entries)
}

fn plan_resource_lease_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root.join("runs").join(run_id).join("resource_leases");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "resource_leases path is not a directory: {}",
            root.display()
        );
    }
    for resource_entry in fs::read_dir(&root)? {
        let resource_entry = resource_entry?;
        crate::repository_path::reject_link(&resource_entry.path())?;
        if !resource_entry.file_type()?.is_dir() {
            bail!("resource lease resource entry is not a directory");
        }
        let resource_id = resource_entry.file_name().to_string_lossy().into_owned();
        crate::repository_path::validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(resource_entry.path())? {
            let lease_entry = lease_entry?;
            crate::repository_path::reject_link(&lease_entry.path())?;
            if !lease_entry.file_type()?.is_file() {
                bail!("resource lease record is not a file");
            }
            let file_name = lease_entry.file_name().to_string_lossy().into_owned();
            let Some(lease_token) = file_name.strip_suffix(".json") else {
                bail!("resource lease record must be JSON: `{file_name}`");
            };
            crate::repository_path::validate_store_id(lease_token)?;
            let archive_path = format!("runs/{run_id}/resource_leases/{resource_id}/{file_name}");
            validate_portable_namespace_path(&archive_path)?;
            if let Some(data) =
                read_store_file_if_exists(store_root, canonical_root, &lease_entry.path())?
            {
                entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
            }
        }
    }
    Ok(())
}

fn plan_retry_decision_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root.join("runs").join(run_id).join("retry_decisions");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "retry_decisions path is not a directory: {}",
            root.display()
        );
    }
    for decision_entry in fs::read_dir(&root)? {
        let decision_entry = decision_entry?;
        crate::repository_path::reject_link(&decision_entry.path())?;
        if !decision_entry.file_type()?.is_file() {
            bail!("retry decision entry is not a file");
        }
        let file_name = decision_entry.file_name().to_string_lossy().into_owned();
        let Some(decision_id) = file_name.strip_suffix(".json") else {
            bail!("retry decision record must be JSON: `{file_name}`");
        };
        crate::repository_path::validate_store_id(decision_id)?;
        let archive_path = format!("runs/{run_id}/retry_decisions/{file_name}");
        validate_portable_namespace_path(&archive_path)?;
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &decision_entry.path())?
        {
            entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
        }
    }
    Ok(())
}

fn plan_preparation_resource_lease_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root
        .join("runs")
        .join(run_id)
        .join("preparation_resource_leases");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "preparation_resource_leases path is not a directory: {}",
            root.display()
        );
    }
    for resource_entry in fs::read_dir(&root)? {
        let resource_entry = resource_entry?;
        crate::repository_path::reject_link(&resource_entry.path())?;
        if !resource_entry.file_type()?.is_dir() {
            bail!("preparation resource lease resource entry is not a directory");
        }
        let resource_id = resource_entry.file_name().to_string_lossy().into_owned();
        crate::repository_path::validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(resource_entry.path())? {
            let lease_entry = lease_entry?;
            crate::repository_path::reject_link(&lease_entry.path())?;
            if !lease_entry.file_type()?.is_file() {
                bail!("preparation resource lease record is not a file");
            }
            let file_name = lease_entry.file_name().to_string_lossy().into_owned();
            let Some(lease_token) = file_name.strip_suffix(".json") else {
                bail!("preparation resource lease record must be JSON: `{file_name}`");
            };
            crate::repository_path::validate_store_id(lease_token)?;
            let archive_path =
                format!("runs/{run_id}/preparation_resource_leases/{resource_id}/{file_name}");
            validate_portable_namespace_path(&archive_path)?;
            if let Some(data) =
                read_store_file_if_exists(store_root, canonical_root, &lease_entry.path())?
            {
                let lease: crate::FmsPreparationResourceLease = serde_json::from_slice(&data)?;
                if lease.relative_path()? != archive_path {
                    bail!("preparation resource lease path identity mismatch");
                }
                entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
            }
        }
    }
    Ok(())
}

fn plan_preparation_retry_decision_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root
        .join("runs")
        .join(run_id)
        .join("preparation_retry_decisions");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "preparation_retry_decisions path is not a directory: {}",
            root.display()
        );
    }
    for decision_entry in fs::read_dir(&root)? {
        let decision_entry = decision_entry?;
        crate::repository_path::reject_link(&decision_entry.path())?;
        if !decision_entry.file_type()?.is_file() {
            bail!("preparation retry decision entry is not a file");
        }
        let file_name = decision_entry.file_name().to_string_lossy().into_owned();
        let Some(decision_id) = file_name.strip_suffix(".json") else {
            bail!("preparation retry decision must be JSON: `{file_name}`");
        };
        crate::repository_path::validate_store_id(decision_id)?;
        let archive_path = format!("runs/{run_id}/preparation_retry_decisions/{file_name}");
        validate_portable_namespace_path(&archive_path)?;
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &decision_entry.path())?
        {
            let decision: crate::FmsPreparationRetryDecision =
                serde_json::from_slice(&data).context("preparation retry decision is not typed")?;
            if decision.relative_path()? != archive_path {
                bail!("preparation retry decision path identity mismatch");
            }
            entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
        }
    }
    Ok(())
}

fn plan_worker_process_exit_receipt_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root
        .join("runs")
        .join(run_id)
        .join("worker_process_exit_receipts");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "worker_process_exit_receipts path is not a directory: {}",
            root.display()
        );
    }
    for receipt_entry in fs::read_dir(&root)? {
        let receipt_entry = receipt_entry?;
        crate::repository_path::reject_link(&receipt_entry.path())?;
        if !receipt_entry.file_type()?.is_file() {
            bail!("worker process exit receipt entry is not a file");
        }
        let file_name = receipt_entry.file_name().to_string_lossy().into_owned();
        let Some(receipt_id) = file_name.strip_suffix(".json") else {
            bail!("worker process exit receipt must be JSON: `{file_name}`");
        };
        crate::repository_path::validate_store_id(receipt_id)?;
        let archive_path = format!("runs/{run_id}/worker_process_exit_receipts/{file_name}");
        validate_portable_namespace_path(&archive_path)?;
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &receipt_entry.path())?
        {
            let receipt: crate::FmsWorkerProcessExitReceipt = serde_json::from_slice(&data)
                .context("worker process exit receipt is not typed")?;
            if receipt.relative_path()? != archive_path {
                bail!("worker process exit receipt path identity mismatch");
            }
            entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
        }
    }
    Ok(())
}

fn plan_preparation_process_exit_receipt_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root
        .join("runs")
        .join(run_id)
        .join("preparation_process_exit_receipts");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "preparation_process_exit_receipts path is not a directory: {}",
            root.display()
        );
    }
    for receipt_entry in fs::read_dir(&root)? {
        let receipt_entry = receipt_entry?;
        crate::repository_path::reject_link(&receipt_entry.path())?;
        if !receipt_entry.file_type()?.is_file() {
            bail!("preparation process exit receipt entry is not a file");
        }
        let file_name = receipt_entry.file_name().to_string_lossy().into_owned();
        let Some(receipt_id) = file_name.strip_suffix(".json") else {
            bail!("preparation process exit receipt must be JSON: `{file_name}`");
        };
        crate::repository_path::validate_store_id(receipt_id)?;
        let archive_path = format!("runs/{run_id}/preparation_process_exit_receipts/{file_name}");
        validate_portable_namespace_path(&archive_path)?;
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &receipt_entry.path())?
        {
            let receipt: crate::FmsPreparationProcessExitReceipt = serde_json::from_slice(&data)
                .context("preparation process exit receipt is not typed")?;
            if receipt.relative_path()? != archive_path {
                bail!("preparation process exit receipt path identity mismatch");
            }
            entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
        }
    }
    Ok(())
}

fn plan_preparation_process_launch_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root
        .join("runs")
        .join(run_id)
        .join("preparation_process_launches");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "preparation_process_launches path is not a directory: {}",
            root.display()
        );
    }
    for launch_entry in fs::read_dir(&root)? {
        let launch_entry = launch_entry?;
        crate::repository_path::reject_link(&launch_entry.path())?;
        if !launch_entry.file_type()?.is_file() {
            bail!("preparation process launch entry is not a file");
        }
        let file_name = launch_entry.file_name().to_string_lossy().into_owned();
        let Some(launch_id) = file_name.strip_suffix(".json") else {
            bail!("preparation process launch must be JSON: `{file_name}`");
        };
        crate::repository_path::validate_store_id(launch_id)?;
        let archive_path = format!("runs/{run_id}/preparation_process_launches/{file_name}");
        validate_portable_namespace_path(&archive_path)?;
        if let Some(data) =
            read_store_file_if_exists(store_root, canonical_root, &launch_entry.path())?
        {
            let launch: crate::FmsPreparationProcessLaunch =
                serde_json::from_slice(&data).context("preparation process launch is not typed")?;
            if launch.relative_path()? != archive_path {
                bail!("preparation process launch path identity mismatch");
            }
            entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
        }
    }
    Ok(())
}

fn plan_task_admission_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root.join("runs").join(run_id).join("task_admissions");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "task_admissions path is not a directory: {}",
            root.display()
        );
    }
    for task_entry in fs::read_dir(&root)? {
        let task_entry = task_entry?;
        crate::repository_path::reject_link(&task_entry.path())?;
        if !task_entry.file_type()?.is_dir() {
            bail!("task admission task entry is not a directory");
        }
        let task_id = task_entry.file_name().to_string_lossy().into_owned();
        crate::repository_path::validate_store_id(&task_id)?;
        for record_entry in fs::read_dir(task_entry.path())? {
            let record_entry = record_entry?;
            crate::repository_path::reject_link(&record_entry.path())?;
            if !record_entry.file_type()?.is_file() {
                bail!("task admission record is not a file");
            }
            let file_name = record_entry.file_name().to_string_lossy().into_owned();
            let Some(attempt_id) = file_name.strip_suffix(".json") else {
                bail!("task admission record must be JSON: `{file_name}`");
            };
            crate::repository_path::validate_store_id(attempt_id)?;
            let archive_path = format!("runs/{run_id}/task_admissions/{task_id}/{file_name}");
            validate_portable_namespace_path(&archive_path)?;
            if let Some(data) =
                read_store_file_if_exists(store_root, canonical_root, &record_entry.path())?
            {
                let record: FmsTaskAdmissionRecord =
                    serde_json::from_slice(&data).context("task admission record is not typed")?;
                record.validate()?;
                if record.lease.run_id != run_id
                    || record.task.task_id != task_id
                    || record.lease.attempt_id != attempt_id
                {
                    bail!("task admission identity does not match its path");
                }
                entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
            }
        }
    }
    Ok(())
}

fn plan_coordinator_journal_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let root = store_root
        .join("runs")
        .join(run_id)
        .join("coordinator_journal");
    if !store_source_exists(&root)? {
        return Ok(());
    }
    if !root.is_dir() {
        bail!(
            "coordinator_journal path is not a directory: {}",
            root.display()
        );
    }
    for direction_entry in fs::read_dir(&root)? {
        let direction_entry = direction_entry?;
        crate::repository_path::reject_link(&direction_entry.path())?;
        if !direction_entry.file_type()?.is_dir() {
            bail!("coordinator journal stream is not a directory");
        }
        let direction = direction_entry.file_name().to_string_lossy().into_owned();
        crate::repository_path::validate_store_id(&direction)?;
        if !matches!(direction.as_str(), "command" | "event") {
            bail!("unknown coordinator journal direction `{direction}`");
        }
        for journal_entry in fs::read_dir(direction_entry.path())? {
            let journal_entry = journal_entry?;
            crate::repository_path::reject_link(&journal_entry.path())?;
            if !journal_entry.file_type()?.is_file() {
                bail!("coordinator journal entry is not a file");
            }
            let file_name = journal_entry.file_name().to_string_lossy().into_owned();
            let Some(entry_id) = file_name.strip_suffix(".json") else {
                bail!("coordinator journal record must be JSON: `{file_name}`");
            };
            crate::repository_path::validate_store_id(entry_id)?;
            let archive_path = format!("runs/{run_id}/coordinator_journal/{direction}/{file_name}");
            validate_portable_namespace_path(&archive_path)?;
            if let Some(data) =
                read_store_file_if_exists(store_root, canonical_root, &journal_entry.path())?
            {
                entries.push_entry(PackEntry::from_bytes(archive_path, data))?;
            }
        }
    }
    Ok(())
}

fn parse_run_ref(run_ref: &str) -> Result<&str> {
    let Some(run_id) = run_ref
        .strip_prefix("runs/")
        .and_then(|value| value.strip_suffix("/run_manifest.json"))
    else {
        anyhow::bail!("invalid run reference `{run_ref}`");
    };
    if run_id.is_empty() || run_id.contains('/') {
        anyhow::bail!("invalid run reference `{run_ref}`");
    }
    let canonical_ref = format!("runs/{run_id}/run_manifest.json");
    if canonical_ref != run_ref {
        anyhow::bail!("invalid run reference `{run_ref}`");
    }
    validate_portable_namespace_path(&canonical_ref)
        .with_context(|| format!("invalid run reference `{run_ref}`"))?;
    Ok(run_id)
}

fn plan_checkpoint_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let checkpoint_dir = store_root.join("runs").join(run_id).join("checkpoints");
    if !store_source_exists(&checkpoint_dir)? {
        return Ok(());
    }
    validate_store_source(store_root, canonical_root, &checkpoint_dir, true)?;
    for checkpoint in std::fs::read_dir(&checkpoint_dir)? {
        let checkpoint = checkpoint?;
        let checkpoint_type = checkpoint.file_type()?;
        if checkpoint_type.is_symlink() {
            anyhow::bail!(
                "symlink source is not permitted: {}",
                checkpoint.path().display()
            );
        }
        if !checkpoint_type.is_dir() {
            anyhow::bail!(
                "unsupported checkpoint source: {}",
                checkpoint.path().display()
            );
        }
        let checkpoint_name = portable_file_name(&checkpoint)?;
        let checkpoint_prefix = format!("runs/{run_id}/checkpoints/{checkpoint_name}");
        validate_portable_namespace_path(&checkpoint_prefix)?;
        validate_store_source(store_root, canonical_root, &checkpoint.path(), true)?;
        for file in std::fs::read_dir(checkpoint.path())? {
            let file = file?;
            let file_type = file.file_type()?;
            if file_type.is_symlink() {
                anyhow::bail!("symlink source is not permitted: {}", file.path().display());
            }
            if !file_type.is_file() {
                anyhow::bail!("unsupported checkpoint source: {}", file.path().display());
            }
            let name = portable_file_name(&file)?;
            let archive_path = format!("{checkpoint_prefix}/{name}");
            validate_portable_namespace_path(&archive_path)?;
            entries.push_entry(PackEntry::from_file(archive_path, store_root, canonical_root, &file.path())?)?;
        }
    }
    Ok(())
}

fn plan_artifact_entries(
    store_root: &Path,
    canonical_root: &Path,
    run_id: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    let artifacts = store_root.join("runs").join(run_id).join("artifacts");
    if !store_source_exists(&artifacts)? {
        return Ok(());
    }
    plan_artifact_directory(
        store_root,
        canonical_root,
        &artifacts,
        &format!("runs/{run_id}/artifacts"),
        entries,
    )
}

fn plan_artifact_directory(
    store_root: &Path,
    canonical_root: &Path,
    directory: &Path,
    prefix: &str,
    entries: &mut Vec<PackEntry>,
) -> Result<()> {
    validate_portable_namespace_path(prefix)?;
    validate_store_source(store_root, canonical_root, directory, true)?;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            anyhow::bail!(
                "symlink source is not permitted: {}",
                entry.path().display()
            );
        }
        let name = portable_file_name(&entry)?;
        let archive_path = format!("{prefix}/{name}");
        validate_portable_namespace_path(&archive_path)?;
        if file_type.is_dir() {
            plan_artifact_directory(
                store_root,
                canonical_root,
                &entry.path(),
                &archive_path,
                entries,
            )?;
        } else if file_type.is_file() {
            entries.push_entry(PackEntry::from_file(archive_path, store_root, canonical_root, &entry.path())?)?;
        } else {
            anyhow::bail!("unsupported artifact source: {}", entry.path().display());
        }
    }
    Ok(())
}

fn portable_file_name(entry: &std::fs::DirEntry) -> Result<String> {
    entry.file_name().into_string().map_err(|_| {
        anyhow::anyhow!(
            "store source name is not valid UTF-8: {}",
            entry.path().display()
        )
    })
}

fn read_store_file_if_exists(
    store_root: &Path,
    canonical_root: &Path,
    source: &Path,
) -> Result<Option<Vec<u8>>> {
    if !store_source_exists(source)? {
        return Ok(None);
    }
    Ok(Some(read_store_file(store_root, canonical_root, source)?))
}

fn store_source_exists(source: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(source) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error)
            .with_context(|| format!("reading store source metadata {}", source.display())),
    }
}

fn read_store_file(store_root: &Path, canonical_root: &Path, source: &Path) -> Result<Vec<u8>> {
    validate_store_source(store_root, canonical_root, source, false)?;
    let file = File::open(source)?;
    if file.metadata()?.len() > MAX_CONTROL_DOCUMENT_BYTES {
        bail!("structural export document exceeds metadata budget: {}", source.display());
    }
    let mut data = Vec::new();
    file.take(MAX_CONTROL_DOCUMENT_BYTES + 1).read_to_end(&mut data)?;
    if data.len() as u64 > MAX_CONTROL_DOCUMENT_BYTES {
        bail!("structural export document exceeds metadata budget: {}", source.display());
    }
    Ok(data)
}

fn validate_store_source(
    store_root: &Path,
    canonical_root: &Path,
    source: &Path,
    must_be_directory: bool,
) -> Result<()> {
    let relative = source
        .strip_prefix(store_root)
        .with_context(|| format!("store source is outside root: {}", source.display()))?;
    let mut current = PathBuf::from(store_root);
    for component in relative.components() {
        let Component::Normal(component) = component else {
            anyhow::bail!("unsafe store source: {}", source.display());
        };
        current.push(component);
        crate::repository_path::reject_link(&current)?;
        let metadata = std::fs::symlink_metadata(&current)
            .with_context(|| format!("reading store source metadata {}", current.display()))?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!("symlink source is not permitted: {}", current.display());
        }
    }
    let metadata = std::fs::symlink_metadata(source)?;
    if (must_be_directory && !metadata.file_type().is_dir())
        || (!must_be_directory && !metadata.file_type().is_file())
    {
        anyhow::bail!("unsupported store source: {}", source.display());
    }
    let canonical_source = std::fs::canonicalize(source)?;
    if !canonical_source.starts_with(canonical_root) {
        anyhow::bail!("store source escapes session root: {}", source.display());
    }
    Ok(())
}

fn validate_pack_input(
    workspace: &FmsWorkspaceManifest,
    documents: &HashMap<String, Vec<u8>>,
) -> Result<()> {
    if workspace.script_ref != "project/main.py" {
        anyhow::bail!("workspace script_ref must be `project/main.py`");
    }

    let mut archive_paths = HashSet::new();
    let mut script: Option<&[u8]> = None;
    for (name, data) in documents {
        let archive_path = project_archive_path(name)?;
        validate_portable_namespace_path(&archive_path)?;
        if !archive_paths.insert(portable_extraction_key(&archive_path)) {
            anyhow::bail!("duplicate archive path or case-fold collision `{archive_path}`");
        }
        if archive_path == "project/main.py" {
            script = Some(data);
        }
    }

    let script = script.context("new .fms archives require non-empty `project/main.py`")?;
    if script.is_empty() {
        anyhow::bail!("new .fms archives require non-empty `project/main.py`");
    }
    let actual = crate::cas::hex_sha256(script);
    if actual != workspace.script_sha256 {
        anyhow::bail!(
            "script SHA-256 mismatch: expected {}, got {actual}",
            workspace.script_sha256
        );
    }
    Ok(())
}

fn project_archive_path(name: &str) -> Result<String> {
    if name.starts_with("project/") {
        return Ok(name.to_string());
    }
    // `documents` is a project-relative map by API contract.
    if name.starts_with('/') || name.starts_with('\\') {
        anyhow::bail!("unsafe project document path `{name}`");
    }
    Ok(format!("project/{name}"))
}

fn validate_export_plan(
    session: &FmsSessionManifest,
    workspace: &FmsWorkspaceManifest,
    export_profile: &FmsExportProfile,
    documents: &HashMap<String, Vec<u8>>,
    run_entries: &[PackEntry],
    solution_entries: &[PackEntry],
    cas_entries: &[CasPackEntry],
) -> Result<()> {
    let mut entries = vec![
        (
            "manifest/session.json".to_string(),
            archive_entry_size(&serde_json::to_vec_pretty(session)?)?,
        ),
        (
            "manifest/workspace.json".to_string(),
            archive_entry_size(&serde_json::to_vec_pretty(workspace)?)?,
        ),
        (
            "manifest/export_profile.json".to_string(),
            archive_entry_size(&serde_json::to_vec_pretty(export_profile)?)?,
        ),
    ];
    entries.extend(
        documents
            .iter()
            .map(|(name, data)| Ok((project_archive_path(name)?, archive_entry_size(data)?)))
            .collect::<Result<Vec<_>>>()?,
    );
    entries.extend(
        run_entries
            .iter()
            .map(|entry| Ok((entry.archive_path.clone(), entry.snapshot.byte_count)))
            .collect::<Result<Vec<_>>>()?,
    );
    entries.extend(
        solution_entries
            .iter()
            .map(|entry| Ok((entry.archive_path.clone(), entry.snapshot.byte_count)))
            .collect::<Result<Vec<_>>>()?,
    );
    entries.extend(
        cas_entries
            .iter()
            .map(|entry| (entry.archive_path.clone(), entry.byte_count)),
    );
    validate_export_entry_metadata(entries)
}

fn archive_entry_size(data: &[u8]) -> Result<u64> {
    u64::try_from(data.len()).context("archive entry size does not fit u64")
}

fn validate_export_entry_metadata(entries: Vec<(String, u64)>) -> Result<()> {
    let mut registry = HashSet::new();
    let mut limits = ArchiveLimitAccounting::default();
    let mut directory_bytes = 0_u64;
    for (path, uncompressed_size) in entries {
        validate_portable_namespace_path(&path)?;
        if !registry.insert(portable_extraction_key(&path)) {
            anyhow::bail!("duplicate archive path or case-fold collision `{path}`");
        }
        limits.account_entry(uncompressed_size)?;
        if path.len() > u16::MAX as usize {
            bail!("ZIP entry name exceeds portable header limit");
        }
        // Fixed central header and room for all three ZIP64 u64 fields.
        // Export has no entry comments or caller-supplied extra fields.
        directory_bytes = directory_bytes.checked_add(46 + path.len() as u64 + 28)
            .context("ZIP central directory budget overflow")?;
        if directory_bytes > MAX_ZIP_DIRECTORY_BYTES {
            bail!("ZIP central directory exceeds metadata budget");
        }
    }
    Ok(())
}

fn write_json<W: Write + Seek, T: serde::Serialize>(
    zip: &mut zip::ZipWriter<W>,
    path: &str,
    value: &T,
    opts: SimpleFileOptions,
) -> Result<()> {
    let data = serde_json::to_vec_pretty(value)?;
    zip.start_file(path, opts)?;
    zip.write_all(&data)?;
    Ok(())
}

// ── Unpack (import) ────────────────────────────────────────────────────

/// Inspect a `.fms` file without persisting its contents.
pub fn inspect_fms<R: Read + Seek>(reader: R) -> Result<SessionInspection> {
    Ok(preflight_fms(reader, &[])?.inspection)
}

/// Validate an `.fms` archive before making any of its contents available.
///
/// `required_documents` are archive paths that the caller needs to consume.
/// The returned document bytes are identical to the ZIP entry bytes.
pub fn preflight_fms<R: Read + Seek>(
    reader: R,
    required_documents: &[&str],
) -> Result<FmsPreflight> {
    let mut source = ArchiveSource::new(reader)?;
    let scan = scan_zip_directory(&mut source)?;
    source.seek(SeekFrom::Start(0))?;
    let mut archive = zip::ZipArchive::new(source)?;
    let mut documents = HashMap::new();
    if archive.len() != scan.entries.len() {
        anyhow::bail!("ZIP central directory entry count is inconsistent");
    }

    for (index, metadata) in scan.entries.iter().enumerate() {
        let name = &metadata.name;
        let mut entry = archive.by_index(index)?;
        if entry.name_raw() != name.as_bytes()
            || entry.size() != metadata.uncompressed_size
            || entry.compressed_size() != metadata.compressed_size
        {
            bail!("ZIP entry metadata disagrees with validated central directory");
        }
        if entry.is_symlink() {
            anyhow::bail!("symlink entries are not permitted (`{name}`)");
        }
        if name.ends_with('/') {
            continue;
        }

        let mut data = Vec::new();
        let read_limit = metadata.uncompressed_size.checked_add(1)
            .context("ZIP entry read limit overflow")?;
        (&mut entry).take(read_limit).read_to_end(&mut data)?;
        if data.len() as u64 != metadata.uncompressed_size {
            bail!("ZIP entry `{name}` actual uncompressed length differs from declaration");
        }
        if let Some(expected_digest) = cas_digest_from_path(&name)? {
            let actual_digest = crate::cas::hex_sha256(&data);
            if actual_digest != expected_digest {
                anyhow::bail!(
                    "CAS SHA-256 mismatch for `{name}`: expected {expected_digest}, got {actual_digest}"
                );
            }
        }
        documents.insert(name.clone(), data);
    }

    let session: FmsSessionManifest =
        document_json(&documents, "manifest/session.json").context("reading session manifest")?;
    let workspace: FmsWorkspaceManifest = document_json(&documents, "manifest/workspace.json")
        .context("reading workspace manifest")?;
    let export_profile: FmsExportProfile =
        document_json(&documents, "manifest/export_profile.json")
            .context("reading export profile manifest")?;

    if workspace.script_ref != "project/main.py" {
        anyhow::bail!("workspace script_ref must be `project/main.py`");
    }
    let script = documents
        .get("project/main.py")
        .context("new .fms archives require `project/main.py`")?;
    if script.is_empty() {
        anyhow::bail!("new .fms archives require non-empty `project/main.py`");
    }
    let script_digest = crate::cas::hex_sha256(script);
    if script_digest != workspace.script_sha256 {
        anyhow::bail!(
            "script SHA-256 mismatch: expected {}, got {script_digest}",
            workspace.script_sha256
        );
    }
    for required in required_documents {
        validate_portable_namespace_path(required)?;
        if !documents.contains_key(*required) {
            anyhow::bail!("required archive document `{required}` is missing");
        }
    }

    let reachability = reachability::walk_archive_documents(&documents, ReachabilityMode::Restore)?;
    let inspection = build_inspection(&session, &ArchiveDocuments::Memory(&documents), scan.total_compressed, &reachability);
    Ok(FmsPreflight {
        session,
        workspace,
        export_profile,
        inspection,
        reachability,
        documents,
    })
}

/// A validated archive whose decoded payloads reside in an owned private directory.
/// The handle must remain alive until inspection or import has finished.
#[derive(Debug)]
pub struct FmsStagedPreflight {
    pub session: FmsSessionManifest,
    pub workspace: FmsWorkspaceManifest,
    pub export_profile: FmsExportProfile,
    pub inspection: SessionInspection,
    pub reachability: ReachabilityReport,
    root: PathBuf,
    documents: HashMap<String, ArchiveFileSnapshot>,
}

impl FmsStagedPreflight {
    pub fn contains_document(&self, name: &str) -> bool {
        self.documents.contains_key(name)
    }

    /// Read one explicitly requested control document within the metadata budget.
    pub fn read_document(&self, name: &str) -> Result<Vec<u8>> {
        validate_portable_namespace_path(name)?;
        self.documents.get(name).context("required archive document is missing")?
            .read_control(&self.root, name)
    }
}

impl Drop for FmsStagedPreflight {
    fn drop(&mut self) {
        // Only this handle's exclusive UUID directory is eligible for cleanup.
        if crate::repository_path::reject_link(&self.root).is_ok() {
            if let Err(error) = fs::remove_dir_all(&self.root) {
                tracing::warn!(path = %self.root.display(), %error, "archive staging cleanup failed");
            }
        }
    }
}

/// Decode once into private files beneath the caller's managed storage root.
/// Admission reserves two decoded copies plus metadata/headroom before decoding;
/// it is an observation of free capacity, not a cross-process disk reservation.
pub fn preflight_fms_staged<R: Read + Seek>(
    reader: R,
    required_documents: &[&str],
    staging_parent: &Path,
) -> Result<FmsStagedPreflight> {
    use sha2::{Digest, Sha256};
    let mut source = ArchiveSource::new(reader)?;
    let scan = scan_zip_directory(&mut source)?;
    crate::repository_path::reject_link(staging_parent)?;
    let parent = fs::canonicalize(staging_parent)?;
    let decoded = scan.entries.iter().try_fold(0u64, |sum, entry| {
        sum.checked_add(entry.uncompressed_size).context("archive disk budget overflow")
    })?;
    let metadata_budget = (scan.entries.len() as u64).checked_mul(16 * 1024)
        .context("archive metadata disk budget overflow")?;
    let required = decoded.checked_mul(2)
        .and_then(|size| size.checked_add(metadata_budget))
        .and_then(|size| size.checked_add(256 * 1024 * 1024))
        .context("archive disk admission overflow")?;
    crate::archive_capacity::require_capacity(&parent, required)?;
    let root = parent.join(format!(".fms-decode-{}", uuid::Uuid::new_v4()));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)] {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&root).context("creating exclusive archive staging")?;
    let mut owner = ArchiveStagingOwner(root);
    let mut documents = HashMap::new();
    source.seek(SeekFrom::Start(0))?;
    let mut archive = zip::ZipArchive::new(source)?;
    if archive.len() != scan.entries.len() { bail!("ZIP central directory entry count is inconsistent"); }
    for (index, metadata) in scan.entries.iter().enumerate() {
        let name = &metadata.name;
        let mut entry = archive.by_index(index)?;
        if entry.name_raw() != name.as_bytes() || entry.size() != metadata.uncompressed_size
            || entry.compressed_size() != metadata.compressed_size {
            bail!("ZIP entry metadata disagrees with validated central directory");
        }
        if entry.is_symlink() { bail!("symlink entries are not permitted (`{name}`)"); }
        if name.ends_with('/') { continue; }
        let path = crate::repository_path::checked_path(&owner.0, name)?;
        fs::create_dir_all(path.parent().context("archive document parent missing")?)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        let mut hasher = Sha256::new();
        let mut length = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        // One additional byte forces CRC/EOF validation and rejects underdeclared sizes.
        let mut bounded = (&mut entry).take(metadata.uncompressed_size.checked_add(1)
            .context("ZIP entry read limit overflow")?);
        loop {
            let count = bounded.read(&mut buffer)?;
            if count == 0 { break; }
            length = length.checked_add(count as u64).context("decoded length overflow")?;
            if length > metadata.uncompressed_size { bail!("ZIP entry `{name}` exceeds declared length"); }
            hasher.update(&buffer[..count]);
            file.write_all(&buffer[..count])?;
        }
        if length != metadata.uncompressed_size { bail!("ZIP entry `{name}` actual length differs from declaration"); }
        file.flush()?;
        let digest = format!("{:x}", hasher.finalize());
        if let Some(expected) = cas_digest_from_path(name)? {
            if digest != expected { bail!("CAS SHA-256 mismatch for `{name}`"); }
        }
        documents.insert(name.clone(), ArchiveFileSnapshot { byte_count: length, content_sha256: digest });
    }
    let view = ArchiveDocuments::Files { snapshots: &documents, root: &owner.0 };
    let json = |name: &str| -> Result<Vec<u8>> {
        view.read(name)?.map(|value| value.into_owned()).with_context(|| format!("entry `{name}` missing"))
    };
    let session: FmsSessionManifest = serde_json::from_slice(&json("manifest/session.json")?)?;
    let workspace: FmsWorkspaceManifest = serde_json::from_slice(&json("manifest/workspace.json")?)?;
    let export_profile: FmsExportProfile = serde_json::from_slice(&json("manifest/export_profile.json")?)?;
    if workspace.script_ref != "project/main.py" { bail!("workspace script_ref must be `project/main.py`"); }
    let script = documents.get("project/main.py").context("new .fms archives require `project/main.py`")?;
    if script.byte_count == 0 || script.content_sha256 != workspace.script_sha256 {
        bail!("archive script is empty or SHA-256 mismatched");
    }
    for required in required_documents {
        validate_portable_namespace_path(required)?;
        if !documents.contains_key(*required) { bail!("required archive document `{required}` is missing"); }
    }
    let reachability = reachability::walk_import_file_documents(&documents, &owner.0)?;
    let inspection = build_inspection(&session, &view, scan.total_compressed, &reachability);
    let root = std::mem::take(&mut owner.0);
    Ok(FmsStagedPreflight { session, workspace, export_profile, inspection, reachability, root, documents })
}

struct ArchiveStagingOwner(PathBuf);
impl Drop for ArchiveStagingOwner {
    fn drop(&mut self) {
        if self.0.as_os_str().is_empty() { return; }
        if crate::repository_path::reject_link(&self.0).is_ok() {
            if let Err(error) = fs::remove_dir_all(&self.0) {
                tracing::warn!(path = %self.0.display(), %error, "archive staging cleanup failed");
            }
        }
    }
}

/// Publish an already validated archive without decoding it a second time.
pub fn unpack_fms_staged(preflight: &FmsStagedPreflight, store: &SessionStore) -> Result<FmsSessionManifest> {
    if matches!(preflight.session.profile, SaveProfile::Solved | SaveProfile::Resume | SaveProfile::Archive) {
        preflight.reachability.require_complete()?;
    } else {
        preflight.reachability.require_visualization_safe()?;
    }
    let _lease = store.write_transaction()?;
    ensure_unpack_destination_pristine(store.root())?;
    for phase in 0..3 {
        for (name, snapshot) in &preflight.documents {
            let object = name.starts_with("objects/sha256/");
            let marker = name.ends_with("/checkpoint.json");
            if (phase == 0 && object) || (phase == 1 && !object && !marker) || (phase == 2 && !object && marker) {
                let source = crate::repository_path::checked_path(&preflight.root, name)?;
                if object {
                    store.cas().put_file(&source, &snapshot.content_sha256, snapshot.byte_count)?;
                } else {
                    store.write_import_document_file(name, &source, &snapshot.content_sha256, snapshot.byte_count)?;
                }
            }
        }
    }
    store.solution_sets().reconcile_all()?;
    store.commit_session(&preflight.session)?;
    Ok(preflight.session.clone())
}

fn scan_zip_directory<R: Read + Seek>(source: &mut ArchiveSource<R>) -> Result<ZipDirectoryScan> {
    // Search only the bounded EOF tail instead of scanning the full source.
    let tail_length = source.len().min(22 + u16::MAX as u64);
    let tail_offset = source.len() - tail_length;
    let tail = source.read_at(tail_offset, tail_length as usize)?;
    let eocd_in_tail = tail.windows(4).enumerate().rev().find_map(|(offset, signature)| {
        if signature != b"PK\x05\x06" || offset + 22 > tail.len() {
            return None;
        }
        let comment_length = u16::from_le_bytes([tail[offset + 20], tail[offset + 21]]) as usize;
        (offset + 22 + comment_length == tail.len()).then_some(offset)
    }).context("ZIP end-of-central-directory record not found or invalid comment length")?;
    let eocd = tail_offset + eocd_in_tail as u64;
    let standard = &tail[eocd_in_tail..eocd_in_tail + 22];
    if u16_le(standard, 4)? != 0 || u16_le(standard, 6)? != 0
        || u16_le(standard, 8)? != u16_le(standard, 10)?
    {
        bail!("multi-disk ZIP archives are not supported");
    }
    let standard_entry_count = u16_le(standard, 10)? as u64;
    let standard_directory_size = u32_le(standard, 12)? as u64;
    let standard_directory_offset = u32_le(standard, 16)? as u64;
    let locator = if eocd >= 20 {
        source.read_at(eocd - 20, 20)?
    } else {
        Vec::new()
    };
    let has_zip64_locator = locator.get(..4) == Some(b"PK\x06\x07".as_slice());
    let (entry_count, directory_size, directory_offset, metadata_start) =
        if has_zip64_locator || standard_entry_count == u16::MAX as u64
            || standard_directory_size == u32::MAX as u64
            || standard_directory_offset == u32::MAX as u64
        {
            let locator_offset = eocd.checked_sub(20).context("ZIP64 locator not found")?;
            if !has_zip64_locator {
                bail!("ZIP64 locator not found");
            }
            if u32_le(&locator, 4)? != 0 || u32_le(&locator, 16)? != 1 {
                bail!("multi-disk ZIP64 archives are not supported");
            }
            let zip64_offset = u64_le(&locator, 8)?;
            let zip64 = source.read_at(zip64_offset, 56)?;
            if &zip64[..4] != b"PK\x06\x06" || u64_le(&zip64, 4)? < 44 {
                bail!("ZIP64 end-of-central-directory record not found");
            }
            let record_size = u64_le(&zip64, 4)?;
            if record_size > MAX_ZIP_DIRECTORY_BYTES {
                bail!("ZIP64 end record exceeds metadata budget");
            }
            let record_end = zip64_offset.checked_add(12)
                .and_then(|offset| offset.checked_add(record_size))
                .context("ZIP64 record size overflow")?;
            if record_end > locator_offset {
                bail!("ZIP64 record overlaps locator");
            }
            if u32_le(&zip64, 16)? != 0 || u32_le(&zip64, 20)? != 0
                || u64_le(&zip64, 24)? != u64_le(&zip64, 32)?
            {
                bail!("multi-disk ZIP64 archives are not supported");
            }
            let count = u64_le(&zip64, 32)?;
            let size = u64_le(&zip64, 40)?;
            let offset = u64_le(&zip64, 48)?;
            if (standard_entry_count != u16::MAX as u64 && standard_entry_count != count)
                || (standard_directory_size != u32::MAX as u64 && standard_directory_size != size)
                || (standard_directory_offset != u32::MAX as u64 && standard_directory_offset != offset)
            {
                bail!("ZIP64 and standard directory declarations disagree");
            }
            (count, size, offset, zip64_offset)
        } else {
            (standard_entry_count, standard_directory_size, standard_directory_offset, eocd)
        };

    ArchiveLimitAccounting::validate_declared_entry_count(entry_count)?;
    if directory_size > MAX_ZIP_DIRECTORY_BYTES {
        bail!("ZIP central directory exceeds metadata budget");
    }
    let directory_end = directory_offset.checked_add(directory_size)
        .context("ZIP central directory size overflow")?;
    if directory_end > metadata_start {
        bail!("truncated or overlapping ZIP central directory");
    }
    let mut offset = directory_offset;
    let mut entries = Vec::with_capacity(entry_count as usize);
    let mut seen_names = HashSet::new();
    let mut limits = ArchiveLimitAccounting::default();
    let mut total_compressed = 0_u64;
    for _ in 0..entry_count {
        if offset.checked_add(46).is_none_or(|end| end > directory_end) {
            bail!("malformed ZIP central directory entry");
        }
        let header = source.read_at(offset, 46)?;
        if &header[..4] != b"PK\x01\x02" {
            bail!("malformed ZIP central directory entry");
        }
        if u16_le(&header, 34)? != 0 {
            bail!("multi-disk ZIP entries are not supported");
        }
        let mut compressed_size = u32_le(&header, 20)? as u64;
        let mut uncompressed_size = u32_le(&header, 24)? as u64;
        let name_length = u16_le(&header, 28)? as usize;
        let extra_length = u16_le(&header, 30)? as usize;
        let comment_length = u16_le(&header, 32)? as usize;
        let variable_length = name_length + extra_length + comment_length;
        let entry_end = offset.checked_add(46 + variable_length as u64)
            .context("ZIP central directory entry size overflow")?;
        if entry_end > directory_end {
            bail!("truncated ZIP central directory entry");
        }
        let variable = source.read_at(offset + 46, variable_length)?;
        let name = std::str::from_utf8(&variable[..name_length])
            .context("ZIP entry name is not valid UTF-8")?.to_owned();
        validate_portable_namespace_path(&name)?;
        if !seen_names.insert(portable_extraction_key(&name)) {
            bail!("duplicate ZIP entry or case-fold collision `{name}`");
        }
        let extra = &variable[name_length..name_length + extra_length];
        let needs_uncompressed = uncompressed_size == u32::MAX as u64;
        let needs_compressed = compressed_size == u32::MAX as u64;
        if needs_uncompressed || needs_compressed {
            let (zip64_uncompressed, zip64_compressed) =
                zip64_sizes(extra, needs_uncompressed, needs_compressed)?;
            if needs_uncompressed {
                uncompressed_size = zip64_uncompressed.context("ZIP64 uncompressed size is missing")?;
            }
            if needs_compressed {
                compressed_size = zip64_compressed.context("ZIP64 compressed size is missing")?;
            }
        }
        limits.account_entry(uncompressed_size)?;
        total_compressed = total_compressed.checked_add(compressed_size)
            .context("compressed ZIP size overflow")?;
        entries.push(ZipDirectoryEntry { name, compressed_size, uncompressed_size });
        offset = entry_end;
    }
    if offset != directory_end {
        bail!("ZIP central directory has trailing data");
    }
    Ok(ZipDirectoryScan { entries, total_compressed })
}

fn zip64_sizes(
    extra: &[u8],
    needs_uncompressed: bool,
    needs_compressed: bool,
) -> Result<(Option<u64>, Option<u64>)> {
    let mut offset = 0;
    while offset + 4 <= extra.len() {
        let field_id = u16_le(extra, offset)?;
        let field_len = u16_le(extra, offset + 2)? as usize;
        let field_end = offset + 4 + field_len;
        if field_end > extra.len() {
            anyhow::bail!("truncated ZIP extra field");
        }
        if field_id == 0x0001 {
            let values = &extra[offset + 4..field_end];
            let mut value_offset = 0;
            let uncompressed = if needs_uncompressed {
                let value = values
                    .get(value_offset..value_offset + 8)
                    .map(|_| u64_le(values, value_offset))
                    .transpose()?;
                value_offset += 8;
                value
            } else {
                None
            };
            let compressed = if needs_compressed {
                values
                    .get(value_offset..value_offset + 8)
                    .map(|_| u64_le(values, value_offset))
                    .transpose()?
            } else {
                None
            };
            return Ok((uncompressed, compressed));
        }
        offset = field_end;
    }
    Ok((None, None))
}

fn u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .context("truncated ZIP integer")?;
    Ok(u16::from_le_bytes(slice.try_into().unwrap()))
}

fn u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .context("truncated ZIP integer")?;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn u64_le(bytes: &[u8], offset: usize) -> Result<u64> {
    let slice = bytes
        .get(offset..offset + 8)
        .context("truncated ZIP integer")?;
    Ok(u64::from_le_bytes(slice.try_into().unwrap()))
}

fn build_inspection(
    session: &FmsSessionManifest,
    documents: &ArchiveDocuments<'_>,
    total_compressed: u64,
    reachability: &ReachabilityReport,
) -> SessionInspection {
    let entry_names = documents.keys().cloned().collect::<HashSet<_>>();
    let mut warnings = Vec::new();
    warnings.extend(reachability.warnings.iter().cloned());

    // Try to find the latest checkpoint.
    let mut latest_cp: Option<CheckpointSummary> = None;
    let mut latest_checkpoint_ref: Option<String> = None;
    let mut latest_checkpoint_order: Option<(u64, chrono::DateTime<chrono::Utc>, String)> = None;
    for run_ref in &session.run_refs {
        let parts: Vec<&str> = run_ref.split('/').collect();
        if parts.len() < 2 || parts[0] != "runs" || parts[1].is_empty() {
            warnings.push(format!("invalid run reference '{run_ref}'"));
            continue;
        }
        let run_id = parts[1];
        if !entry_names.contains(run_ref) {
            warnings.push(format!(
                "run manifest '{run_ref}' is missing from the archive"
            ));
        }
        let checkpoint_prefix = format!("runs/{run_id}/checkpoints/");
        let checkpoint_names = entry_names
            .iter()
            .filter(|name| {
                name.starts_with(&checkpoint_prefix) && name.ends_with("/checkpoint.json")
            })
            .cloned()
            .collect::<Vec<_>>();
        if matches!(session.profile, SaveProfile::Resume | SaveProfile::Archive)
            && checkpoint_names.is_empty()
        {
            warnings.push(format!(
                "{} session run '{run_id}' has no packaged checkpoint",
                match session.profile {
                    SaveProfile::Resume => "resume",
                    SaveProfile::Archive => "archive",
                    _ => unreachable!(),
                }
            ));
        }
        if matches!(
            session.profile,
            SaveProfile::Solved | SaveProfile::Resume | SaveProfile::Archive
        ) && !entry_names
            .iter()
            .any(|name| name.starts_with(&format!("runs/{run_id}/artifacts/")))
        {
            warnings.push(format!("solved run '{run_id}' has no packaged artifacts"));
        }
        for name in checkpoint_names {
            match documents.read(&name).and_then(|data| {
                let data = data.context("checkpoint descriptor disappeared")?;
                serde_json::from_slice::<FmsCheckpoint>(&data).map_err(Into::into)
            }) {
                Ok(cp) => {
                    let summary = CheckpointSummary {
                        checkpoint_id: cp.checkpoint_id,
                        step: cp.step,
                        time_s: cp.time_s,
                        study_kind: cp.compatibility.study_kind.unwrap_or_default(),
                    };
                    let candidate_order = (cp.step, cp.created_at, summary.checkpoint_id.clone());
                    if latest_checkpoint_order
                        .as_ref()
                        .map_or(true, |previous| candidate_order > previous.clone())
                    {
                        latest_checkpoint_order = Some(candidate_order);
                        latest_checkpoint_ref = Some(name.clone());
                        latest_cp = Some(summary);
                    }
                }
                Err(error) => warnings.push(format!(
                    "checkpoint descriptor '{name}' cannot be read: {error}"
                )),
            }
        }
    }

    let latest_status = latest_checkpoint_ref
        .as_deref()
        .and_then(|reference| reachability.checkpoint_status.get(reference));
    let has_primary_payload = latest_status.is_some_and(|status| status.primary);
    let has_restart_payload = latest_status.is_some_and(|status| status.restart);
    let restore_class = if latest_cp.is_some()
        && matches!(session.profile, SaveProfile::Resume | SaveProfile::Archive)
        && reachability.complete
        && has_primary_payload
        && has_restart_payload
    {
        RestoreClass::LogicalResume // actual exact_resume needs runtime check
    } else if has_primary_payload
        && matches!(
            session.profile,
            SaveProfile::Solved | SaveProfile::Resume | SaveProfile::Archive
        )
    {
        RestoreClass::InitialConditionImport
    } else {
        RestoreClass::ConfigOnly
    };
    if matches!(
        session.profile,
        SaveProfile::Solved | SaveProfile::Resume | SaveProfile::Archive
    ) && latest_cp.is_some()
        && !has_primary_payload
    {
        warnings.push("checkpoint has no material primary field payload".into());
    }
    if matches!(session.profile, SaveProfile::Resume | SaveProfile::Archive)
        && latest_cp.is_some()
        && !has_restart_payload
    {
        warnings.push("resume profile has no complete restart payload; downgraded".into());
    }

    SessionInspection {
        format_version: session.format.clone(),
        session_id: session.session_id.clone(),
        name: session.name.clone(),
        profile: session.profile,
        created_by_version: session.created_by_version.clone(),
        created_at: session.created_at,
        saved_at: session.saved_at,
        run_count: session.run_refs.len(),
        latest_checkpoint: latest_cp,
        restore_class,
        warnings,
        total_size_bytes: total_compressed,
    }
}

/// Extract a `.fms` archive into a `SessionStore`.
pub fn unpack_fms<R: Read + Seek>(reader: R, store: &SessionStore) -> Result<FmsSessionManifest> {
    unpack_fms_inner(reader, store, true)
}

/// Extract an archive for a read-only visualization import.
///
/// The archive is still fully preflighted: paths, ZIP limits, document
/// digests, and typed checkpoint payloads are validated before anything is
/// written. A read-only import may retain the two known opaque project
/// documents, but missing payloads and unknown references remain fail-closed.
pub fn unpack_fms_for_visualization<R: Read + Seek>(
    reader: R,
    store: &SessionStore,
) -> Result<FmsSessionManifest> {
    unpack_fms_inner(reader, store, false)
}

fn unpack_fms_inner<R: Read + Seek>(
    reader: R,
    store: &SessionStore,
    require_complete_reachability: bool,
) -> Result<FmsSessionManifest> {
    let preflight = preflight_fms(reader, &[])?;

    if require_complete_reachability
        && matches!(
            preflight.session.profile,
            SaveProfile::Solved | SaveProfile::Resume | SaveProfile::Archive
        )
    {
        preflight.reachability.require_complete()?;
    } else {
        preflight.reachability.require_visualization_safe()?;
    }

    let _lease = store.write_transaction()?;
    ensure_unpack_destination_pristine(store.root())?;

    // Preflight has already checked all paths, limits, and content digests.
    // Materialize immutable CAS objects first, ordinary documents second, and
    // checkpoint markers last.  A marker is the publication boundary and must
    // never become visible before its common state and payloads exist.
    for (name, data) in &preflight.documents {
        if name.starts_with("objects/sha256/") {
            store.cas().put(&data)?;
        }
    }
    for (name, data) in &preflight.documents {
        if !name.starts_with("objects/sha256/") && !name.ends_with("/checkpoint.json") {
            store.write_import_document(name, data)?;
        }
    }
    for (name, data) in &preflight.documents {
        if name.ends_with("/checkpoint.json") {
            store.write_import_document(name, data)?;
        }
    }
    store.solution_sets().reconcile_all()?;

    // Commit the session manifest.
    store.commit_session(&preflight.session)?;

    Ok(preflight.session)
}

fn ensure_unpack_destination_pristine(root: &Path) -> Result<()> {
    let allowed_files = ["WRITER.lock", "WRITER.owner.json", "LOCK"];
    let allowed_directories = [
        "manifests",
        "runs",
        "scheduler_pools",
        "live_command_journals",
        "recovery",
        "temp",
        "objects",
        "solutions",
    ];
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        crate::repository_path::reject_link(&entry.path())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_file() {
            if !allowed_files.contains(&name.as_str()) {
                bail!("import requires an isolated empty staging store; existing file `{name}`")
            }
            continue;
        }
        if !entry.file_type()?.is_dir() || !allowed_directories.contains(&name.as_str()) {
            bail!("import requires an isolated empty staging store; existing root `{name}`")
        }
        if name == "objects" {
            for object_entry in fs::read_dir(entry.path())? {
                let object_entry = object_entry?;
                crate::repository_path::reject_link(&object_entry.path())?;
                let object_name = object_entry.file_name().to_string_lossy().into_owned();
                if object_name != "sha256" && object_name != "pins" {
                    bail!(
                        "import requires an isolated empty staging store; unknown objects root `{object_name}`"
                    )
                }
                if object_entry.file_type()?.is_dir()
                    && fs::read_dir(object_entry.path())?
                        .next()
                        .transpose()?
                        .is_some()
                {
                    bail!(
                        "import requires an isolated empty staging store; objects/{object_name} is not empty"
                    )
                }
            }
        } else if fs::read_dir(entry.path())?.next().transpose()?.is_some() {
            bail!("import requires an isolated empty staging store; existing data under `{name}`")
        }
    }
    Ok(())
}

fn document_json<T: serde::de::DeserializeOwned>(
    documents: &HashMap<String, Vec<u8>>,
    name: &str,
) -> Result<T> {
    let data = documents
        .get(name)
        .with_context(|| format!("entry `{name}` not found in archive"))?;
    serde_json::from_slice(&data).with_context(|| format!("parsing JSON from `{name}`"))
}

/// Validates the portable namespace used for every FMS extraction target.
///
/// Names remain unchanged after validation; this only defines which names can
/// safely refer to a target on every supported extraction filesystem.
fn validate_portable_namespace_path(name: &str) -> Result<()> {
    let bytes = name.as_bytes();
    let has_windows_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if !name.is_ascii()
        || name.is_empty()
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(char::is_control)
        || has_windows_prefix
    {
        if !name.is_ascii() {
            anyhow::bail!("FMS archive paths must use ASCII components: `{name}`");
        }
        anyhow::bail!("unsafe archive path `{name}`");
    }
    let non_directory_name = name.strip_suffix('/').unwrap_or(name);
    if non_directory_name.is_empty()
        || non_directory_name.split('/').any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment.ends_with([' ', '.'])
                || is_windows_reserved_device(segment)
        })
    {
        anyhow::bail!("unsafe archive path `{name}`");
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        anyhow::bail!("unsafe archive path `{name}`");
    }

    let key = portable_extraction_key(name);
    if key.starts_with("project/") && !name.starts_with("project/") {
        anyhow::bail!("non-canonical project path `{name}`");
    }
    if key.starts_with("objects/sha256/") {
        if !name.starts_with("objects/sha256/") {
            anyhow::bail!("non-canonical CAS path `{name}`");
        }
        cas_digest_from_path(name)?;
    }
    Ok(())
}

fn is_windows_reserved_device(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (bytes.len() == 4
            && matches!(&bytes[..3], b"COM" | b"LPT")
            && matches!(bytes[3], b'1'..=b'9'))
}

fn cas_digest_from_path(name: &str) -> Result<Option<&str>> {
    let Some(digest) = name.strip_prefix("objects/sha256/") else {
        return Ok(None);
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        anyhow::bail!("invalid CAS object path `{name}`");
    }
    Ok(Some(digest))
}

/// Maps a validated archive path into the case-insensitive filesystem domain
/// used for portable extraction collision detection. Archive names and hashes
/// remain byte-for-byte unchanged.
fn portable_extraction_key(name: &str) -> String {
    name.to_ascii_lowercase()
}

// ── Export profile helpers ─────────────────────────────────────────────

impl FmsExportProfile {
    pub fn needs_checkpoints(&self) -> bool {
        matches!(
            self.profile,
            SaveProfile::Resume | SaveProfile::Archive | SaveProfile::Recovery
        )
    }

    pub fn include_artifacts(&self) -> bool {
        !matches!(self.include_artifacts, ArtifactPolicy::None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_quantities::{
        ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind,
        SolutionArtifactRef, SolutionExecutionStatus, SolutionMember, SolutionSet,
        SolutionSetManifestState, SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
    };
    use std::io::{Cursor, Read, Write};

    fn test_session() -> FmsSessionManifest {
        FmsSessionManifest::new("s-001", "Test", SaveProfile::Compact)
    }

    fn test_run(run_id: &str) -> FmsRunManifest {
        let now = chrono::Utc::now();
        FmsRunManifest {
            run_id: run_id.into(),
            status: RunStatus::Completed,
            study_kind: "time_evolution".into(),
            backend: "cpu".into(),
            precision: "f64".into(),
            started_at: now,
            finished_at: Some(now),
            total_steps: 0,
            total_time_s: 0.0,
            plan_ref: None,
            live_state_ref: None,
            latest_checkpoint_ref: None,
            artifact_index_ref: None,
        }
    }

    fn test_workspace(script: &[u8]) -> FmsWorkspaceManifest {
        FmsWorkspaceManifest {
            workspace_id: "local-live".into(),
            problem_name: "test_problem".into(),
            project_ref: "project/".into(),
            script_ref: "project/main.py".into(),
            script_sha256: crate::cas::hex_sha256(script),
            ui_state_ref: "project/ui_state.json".into(),
            scene_document_ref: "project/scene_document.json".into(),
            script_builder_ref: None,
            model_builder_graph_ref: None,
            asset_index_ref: None,
        }
    }

    fn archive_with_entries(
        workspace: &FmsWorkspaceManifest,
        entries: impl IntoIterator<Item = (String, Vec<u8>)>,
    ) -> Vec<u8> {
        archive_with_workspace_value(serde_json::to_value(workspace).unwrap(), entries)
    }

    fn archive_with_workspace_value(
        workspace: serde_json::Value,
        entries: impl IntoIterator<Item = (String, Vec<u8>)>,
    ) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        write_json(
            &mut writer,
            "manifest/session.json",
            &test_session(),
            options,
        )
        .unwrap();
        write_json(&mut writer, "manifest/workspace.json", &workspace, options).unwrap();
        write_json(
            &mut writer,
            "manifest/export_profile.json",
            &FmsExportProfile::for_profile(SaveProfile::Compact),
            options,
        )
        .unwrap();
        for (name, data) in entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(&data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn pack_fixture(
        profile: SaveProfile,
    ) -> (
        tempfile::TempDir,
        SessionStore,
        FmsSessionManifest,
        FmsWorkspaceManifest,
        FmsExportProfile,
        HashMap<String, Vec<u8>>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let script = b"print('verified')".to_vec();
        let session = test_session();
        let workspace = test_workspace(&script);
        let mut documents = HashMap::new();
        documents.insert("main.py".to_string(), script);
        (
            directory,
            store,
            session,
            workspace,
            FmsExportProfile::for_profile(profile),
            documents,
        )
    }

    fn portable_solution(object_ref: String, byte_length: u64) -> SolutionSet {
        let digest = |character: char| format!("sha256:{}", character.to_string().repeat(64));
        SolutionSet {
            schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "solution:portable".to_string(),
            revision: 1,
            run_id: "run:portable".to_string(),
            manifest_state: SolutionSetManifestState::Closed,
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: ScientificAssessment {
                status: ScientificAssessmentStatus::Unassessed,
                reason: Some("not assessed".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            provenance: SolutionSetProvenance {
                run_spec_digest: digest('a'),
                model_digest: digest('b'),
                physics_digest: digest('c'),
                discretization_digest: digest('d'),
                resolved_plan_digest: digest('e'),
                acquisition_digest: digest('f'),
                seed_digest: None,
            },
            members: vec![SolutionMember {
                member_id: "member:portable".to_string(),
                task_id: "task:portable".to_string(),
                attempt_id: "attempt:portable".to_string(),
                ownership_epoch: 1,
                case_id: None,
                stage_id: "stage:portable".to_string(),
                execution_status: SolutionExecutionStatus::Succeeded,
                scientific_assessment: ScientificAssessment {
                    status: ScientificAssessmentStatus::Unassessed,
                    reason: Some("not assessed".to_string()),
                    evidence_artifact_ids: Vec::new(),
                },
                artifacts: vec![SolutionArtifactRef {
                    artifact_id: "artifact:portable".to_string(),
                    kind: SolutionArtifactKind::State,
                    schema_id: "fullmag.state.test.v1".to_string(),
                    object_ref,
                    byte_length,
                    accepted_state: None,
                }],
            }],
            coverage: Vec::new(),
        }
    }

    #[test]
    fn staged_preflight_restores_opaque_files_and_removes_only_owned_staging() {
        let parent = tempfile::tempdir().unwrap();
        let sentinel = parent.path().join("preserved");
        fs::write(&sentinel, b"foreign").unwrap();
        let script = b"print('verified')".to_vec();
        let workspace = test_workspace(&script);
        let payload = vec![13u8; MAX_CONTROL_DOCUMENT_BYTES as usize + 1];
        let archive = archive_with_entries(&workspace, [
            ("project/main.py".to_string(), script),
            ("project/opaque.json".to_string(), payload.clone()),
        ]);
        let staged = preflight_fms_staged(Cursor::new(&archive), &[], parent.path()).unwrap();
        let root = staged.root.clone();
        assert!(staged.contains_document("project/opaque.json"));
        assert!(staged.read_document("project/opaque.json").is_err());
        let legacy = preflight_fms(Cursor::new(&archive), &[]).unwrap();
        assert_eq!(staged.inspection.restore_class, legacy.inspection.restore_class);
        let store = SessionStore::open(parent.path().join("restored")).unwrap();
        unpack_fms_staged(&staged, &store).unwrap();
        assert_eq!(store.read_document("project/opaque.json").unwrap().unwrap(), payload);
        drop(staged);
        assert!(!root.exists());
        assert_eq!(fs::read(sentinel).unwrap(), b"foreign");
    }

    #[test]
    fn staged_decode_failure_cleans_owned_directory_and_changed_payload_fails_closed() {
        let parent = tempfile::tempdir().unwrap();
        let script = b"print('verified')".to_vec();
        let workspace = test_workspace(&script);
        let invalid = archive_with_entries(&workspace, [("project/main.py".to_string(), b"changed".to_vec())]);
        assert!(preflight_fms_staged(Cursor::new(invalid), &[], parent.path()).is_err());
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
        let archive = archive_with_entries(&workspace, [("project/main.py".to_string(), script)]);
        let staged = preflight_fms_staged(Cursor::new(archive), &[], parent.path()).unwrap();
        fs::write(staged.root.join("project/main.py"), b"changed").unwrap();
        assert!(staged.read_document("project/main.py").is_err());
        let store = SessionStore::open(parent.path().join("restored")).unwrap();
        assert!(unpack_fms_staged(&staged, &store).is_err());
        assert!(store.current_session().unwrap().is_none());
    }

    #[test]
    fn scanner_reads_bounded_metadata_from_large_seekable_source() {
        use std::cell::Cell;
        use std::rc::Rc;
        struct CountReads {
            input: Cursor<Vec<u8>>,
            bytes: Rc<Cell<usize>>,
        }
        impl Read for CountReads {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = self.input.read(buffer)?;
                self.bytes.set(self.bytes.get() + count);
                Ok(count)
            }
        }
        impl Seek for CountReads {
            fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
                self.input.seek(position)
            }
        }
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("project/large.bin", SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)).unwrap();
        writer.write_all(&vec![31; 4 * 1024 * 1024]).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let count = Rc::new(Cell::new(0));
        let mut source = ArchiveSource::new(CountReads {
            input: Cursor::new(bytes), bytes: count.clone(),
        }).unwrap();
        let scan = scan_zip_directory(&mut source).unwrap();
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].uncompressed_size, 4 * 1024 * 1024);
        assert!(count.get() < 128 * 1024);
    }

    #[test]
    fn preflight_preserves_nonzero_input_position() {
        let script = b"print('window')";
        let archive = archive_with_entries(&test_workspace(script),
            [("project/main.py".to_string(), script.to_vec())]);
        let mut bytes = b"ignored prefix".to_vec();
        let start = bytes.len();
        bytes.extend(archive);
        let mut input = Cursor::new(bytes);
        input.set_position(start as u64);
        let checked = preflight_fms(input, &[]).unwrap();
        assert_eq!(checked.documents["project/main.py"], script);
    }

    #[test]
    fn scanner_checks_comment_length_and_ignores_signature_inside_comment() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.set_comment("comment PK\x05\x06 suffix");
        let bytes = writer.finish().unwrap().into_inner();
        let mut source = ArchiveSource::new(Cursor::new(bytes.clone())).unwrap();
        assert!(scan_zip_directory(&mut source).unwrap().entries.is_empty());
        let mut truncated = bytes;
        truncated.pop();
        let mut source = ArchiveSource::new(Cursor::new(truncated)).unwrap();
        assert!(scan_zip_directory(&mut source).is_err());
    }

    #[test]
    fn preflight_rejects_actual_size_mismatch_and_entry_disk_number() {
        let script = b"print('size')";
        let original = archive_with_entries(&test_workspace(script),
            [("project/main.py".to_string(), script.to_vec())]);
        let eocd = original.windows(4).rposition(|bytes| bytes == b"PK\x05\x06").unwrap();
        let directory = u32_le(&original, eocd + 16).unwrap() as usize;
        let mut offset = directory;
        let target = loop {
            let length = u16_le(&original, offset + 28).unwrap() as usize;
            if &original[offset + 46..offset + 46 + length] == b"project/main.py" {
                break offset;
            }
            offset += 46 + length + u16_le(&original, offset + 30).unwrap() as usize
                + u16_le(&original, offset + 32).unwrap() as usize;
        };
        for declared in [script.len() as u32 - 1, script.len() as u32 + 1] {
            let mut malformed = original.clone();
            let local = u32_le(&malformed, target + 42).unwrap() as usize;
            malformed[target + 24..target + 28].copy_from_slice(&declared.to_le_bytes());
            malformed[local + 22..local + 26].copy_from_slice(&declared.to_le_bytes());
            assert!(preflight_fms(Cursor::new(malformed), &[]).is_err());
        }
        let mut malformed = original;
        malformed[target + 34..target + 36].copy_from_slice(&1_u16.to_le_bytes());
        let mut source = ArchiveSource::new(Cursor::new(malformed)).unwrap();
        assert!(scan_zip_directory(&mut source).err().unwrap().to_string().contains("multi-disk"));
    }

    fn empty_zip64_fixture() -> Vec<u8> {
        let mut zip64 = vec![0_u8; 56];
        zip64[..4].copy_from_slice(b"PK\x06\x06");
        zip64[4..12].copy_from_slice(&44_u64.to_le_bytes());
        let mut locator = vec![0_u8; 20];
        locator[..4].copy_from_slice(b"PK\x06\x07");
        locator[16..20].copy_from_slice(&1_u32.to_le_bytes());
        let mut standard = vec![0_u8; 22];
        standard[..4].copy_from_slice(b"PK\x05\x06");
        standard[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        standard[10..12].copy_from_slice(&u16::MAX.to_le_bytes());
        standard[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        standard[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        [zip64, locator, standard].concat()
    }

    #[test]
    fn scanner_rejects_zip64_overflow_overlap_and_metadata_budget() {
        let bytes = empty_zip64_fixture();
        let mut source = ArchiveSource::new(Cursor::new(bytes.clone())).unwrap();
        assert!(scan_zip_directory(&mut source).unwrap().entries.is_empty());
        for (offset, value) in [(4, u64::MAX), (40, MAX_ZIP_DIRECTORY_BYTES + 1),
            (48, u64::MAX), (56 + 8, u64::MAX)] {
            let mut malformed = bytes.clone();
            malformed[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            let mut source = ArchiveSource::new(Cursor::new(malformed)).unwrap();
            assert!(scan_zip_directory(&mut source).is_err());
        }
        let mut multiple_disks = bytes;
        multiple_disks[16..20].copy_from_slice(&1_u32.to_le_bytes());
        let mut source = ArchiveSource::new(Cursor::new(multiple_disks)).unwrap();
        assert!(scan_zip_directory(&mut source).is_err());
    }

    #[test]
    fn solved_archive_round_trips_solution_set_and_exact_cas_object() {
        let (_directory, store, mut session, workspace, profile, documents) =
            pack_fixture(SaveProfile::Solved);
        session.profile = SaveProfile::Solved;
        let payload = b"portable solution state";
        let object_ref = store.cas().put(payload).expect("publish CAS object");
        let solution = portable_solution(object_ref.clone(), payload.len() as u64);
        store
            .publish_solution_set(&solution)
            .expect("publish solution set");

        let mut archive = Cursor::new(Vec::new());
        pack_fms(
            &mut archive,
            &store,
            &session,
            &workspace,
            &profile,
            &documents,
            &PackOptions::default(),
        )
        .expect("pack solved archive");
        let archive = archive.into_inner();
        let directory = crate::cas::hex_sha256(solution.solution_set_id.as_bytes());
        let current_path = format!("solutions/{directory}/manifest.json");
        let revision_path = format!("solutions/{directory}/revisions/{:020}.json", 1);
        let preflight = preflight_fms(Cursor::new(&archive), &[]).expect("preflight archive");
        assert!(preflight.documents.contains_key(&current_path));
        assert!(preflight.documents.contains_key(&revision_path));
        assert_eq!(
            preflight.documents[&format!("objects/sha256/{object_ref}")],
            payload
        );

        let restored_directory = tempfile::tempdir().expect("restored store directory");
        let restored = SessionStore::open(restored_directory.path().join("store"))
            .expect("open restored store");
        unpack_fms(Cursor::new(archive), &restored).expect("restore solved archive");
        assert_eq!(
            restored
                .solution_sets()
                .read(&solution.solution_set_id)
                .unwrap(),
            Some(solution)
        );
        assert_eq!(restored.cas().get(&object_ref).unwrap().unwrap(), payload);
    }

    #[test]
    fn file_backed_export_preserves_graph_and_rejects_corrupt_reachable_bytes() {
        let (_directory, store, _session, _workspace, profile, _documents) =
            pack_fixture(SaveProfile::Solved);
        let payload = vec![23_u8; 2 * 1024 * 1024 + 17];
        let object_ref = store.cas().put(&payload).unwrap();
        store
            .publish_solution_set(&portable_solution(object_ref.clone(), payload.len() as u64))
            .unwrap();
        let unused_ref = store.cas().put(b"unused").unwrap();
        // An unreachable object is not an input to this export graph.
        fs::write(
            store.root().join("objects/sha256").join(&unused_ref),
            b"changed unused",
        )
        .unwrap();
        let canonical_root = canonical_store_root(store.root()).unwrap();
        let entries = plan_solution_entries(store.root(), &canonical_root, &profile).unwrap();
        let snapshots = entries.iter()
            .map(|entry| (entry.archive_path.clone(), entry.snapshot.clone()))
            .collect::<HashMap<_, _>>();
        let disk = reachability::walk_export_file_documents(&snapshots, &canonical_root).unwrap();
        let mut documents = entries.iter().map(|entry| (
            entry.archive_path.clone(),
            entry.snapshot.read_control(&canonical_root, &entry.archive_path).unwrap(),
        )).collect::<HashMap<_, _>>();
        disk.require_complete().unwrap();
        documents.insert(format!("objects/sha256/{object_ref}"), payload.clone());
        let memory =
            reachability::walk_archive_documents(&documents, ReachabilityMode::Export).unwrap();
        memory.require_complete().unwrap();
        assert_eq!(disk.object_refs, memory.object_refs);
        assert_eq!(disk.file_refs, memory.file_refs);
        assert!(!disk.object_refs.contains(&unused_ref));
        let plan = plan_cas_entries(store.root(), &canonical_root, &[], &entries, &HashMap::new()).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].byte_count, payload.len() as u64);
        fs::write(&plan[0].source, vec![24_u8; payload.len()]).unwrap();
        assert!(plan_cas_entries(store.root(), &canonical_root, &[], &entries, &HashMap::new()).is_err());
    }

    #[test]
    fn opaque_json_named_artifact_is_streamed_above_control_budget() {
        let (_directory, store, _session, _workspace, _profile, _documents) =
            pack_fixture(SaveProfile::Solved);
        let relative = "runs/run-opaque/artifacts/large.json";
        let source = store.root().join(relative);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let file = File::create(&source).unwrap();
        file.set_len(MAX_CONTROL_DOCUMENT_BYTES + 1).unwrap();
        let root = canonical_store_root(store.root()).unwrap();
        let mut entries = Vec::new();
        plan_artifact_directory(store.root(), &root, source.parent().unwrap(),
            "runs/run-opaque/artifacts", &mut entries).unwrap();
        assert_eq!(entries.len(), 1);
        let snapshots = entries.iter().map(|entry|
            (entry.archive_path.clone(), entry.snapshot.clone())).collect();
        reachability::walk_export_file_documents(&snapshots, &root)
            .unwrap().require_complete().unwrap();
        let entry = &entries[0];
        assert_eq!(entry.snapshot.byte_count, MAX_CONTROL_DOCUMENT_BYTES + 1);
        crate::cas::copy_verified_file(&source, &entry.snapshot.content_sha256,
            entry.snapshot.byte_count, &mut std::io::sink()).unwrap();
        assert!(entry.snapshot.read_control(&root, relative).is_err());
    }

    #[test]
    fn document_inventory_rejects_entry_count_before_growth() {
        let mut entries = (0..MAX_ZIP_ENTRIES).map(|index|
            PackEntry::from_bytes(format!("runs/r/artifacts/{index}"), Vec::new()))
            .collect::<Vec<_>>();
        assert!(entries.push_entry(PackEntry::from_bytes(
            "runs/r/artifacts/overflow".to_string(), Vec::new())).is_err());
        assert_eq!(entries.len(), MAX_ZIP_ENTRIES);
    }

    #[test]
    fn lazy_solution_history_preserves_stale_current_and_rejects_bad_chains() {
        let (_directory, store, _session, _workspace, _profile, _documents) =
            pack_fixture(SaveProfile::Solved);
        let payload = b"history payload".to_vec();
        let object_ref = store.cas().put(&payload).unwrap();
        let mut first = portable_solution(object_ref.clone(), payload.len() as u64);
        first.manifest_state = SolutionSetManifestState::Open;
        first.execution_status = SolutionExecutionStatus::Running;
        let mut second = first.clone();
        second.revision = 2;
        let directory = crate::cas::hex_sha256(first.solution_set_id.as_bytes());
        let current_path = format!("solutions/{directory}/manifest.json");
        let first_path = format!("solutions/{directory}/revisions/{:020}.json", 1);
        let second_path = format!("solutions/{directory}/revisions/{:020}.json", 2);
        let mut documents = HashMap::from([
            (current_path.clone(), serde_json::to_vec(&first).unwrap()),
            (first_path.clone(), serde_json::to_vec(&first).unwrap()),
            (second_path.clone(), serde_json::to_vec(&second).unwrap()),
        ]);
        let check = |documents: &HashMap<String, Vec<u8>>| {
            let mut memory = documents.clone();
            memory.insert(format!("objects/sha256/{object_ref}"), payload.clone());
            let memory = reachability::walk_archive_documents(&memory, ReachabilityMode::Export);
            let mut snapshots = HashMap::new();
            for (name, data) in documents {
                let path = store.root().join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, data).unwrap();
                snapshots.insert(name.clone(), ArchiveFileSnapshot::from_bytes(data));
            }
            let disk = reachability::walk_export_file_documents(&snapshots, store.root());
            (memory, disk)
        };
        let (memory, disk) = check(&documents);
        let memory = memory.unwrap();
        let disk = disk.unwrap();
        memory.require_complete().unwrap();
        disk.require_complete().unwrap();
        assert_eq!(memory.file_refs, disk.file_refs);
        assert_eq!(memory.object_refs, disk.object_refs);
        // A lagging current pointer is accepted only when its exact revision matches.
        let mut conflict = first.clone();
        conflict.scientific_assessment.reason = Some("different current".to_string());
        documents.insert(current_path.clone(), serde_json::to_vec(&conflict).unwrap());
        let (memory, disk) = check(&documents);
        assert!(memory.is_err() && disk.is_err());
        documents.insert(current_path, serde_json::to_vec(&first).unwrap());
        let removed = documents.remove(&first_path).unwrap();
        let (memory, disk) = check(&documents);
        assert!(memory.is_err() && disk.is_err());
        documents.insert(first_path, removed);
        second.run_id = "run:changed".to_string();
        documents.insert(second_path.clone(), serde_json::to_vec(&second).unwrap());
        let (memory, disk) = check(&documents);
        assert!(memory.is_err() && disk.is_err());
        second = first.clone();
        second.revision = 3;
        documents.insert(second_path, serde_json::to_vec(&second).unwrap());
        let (memory, disk) = check(&documents);
        assert!(memory.is_err() && disk.is_err());
    }

    fn assert_pack_rejected_without_output(
        store: &SessionStore,
        session: &FmsSessionManifest,
        workspace: &FmsWorkspaceManifest,
        export_profile: &FmsExportProfile,
        documents: &HashMap<String, Vec<u8>>,
        expected_error: &str,
    ) {
        let mut output = Cursor::new(Vec::new());
        let error = pack_fms(
            &mut output,
            store,
            session,
            workspace,
            export_profile,
            documents,
            &PackOptions::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains(expected_error));
        assert!(output.into_inner().is_empty());
    }

    #[test]
    fn pack_rejects_invalid_run_references_before_output_or_external_read() {
        for run_ref in ["../outside-file", "/outside/run_manifest.json"] {
            let (directory, store, mut session, workspace, profile, documents) =
                pack_fixture(SaveProfile::Compact);
            std::fs::write(directory.path().join("outside-file"), b"secret").unwrap();
            session.run_refs.push(run_ref.to_string());

            assert_pack_rejected_without_output(
                &store,
                &session,
                &workspace,
                &profile,
                &documents,
                "invalid run reference",
            );
            assert_eq!(
                std::fs::read(directory.path().join("outside-file")).unwrap(),
                b"secret"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn pack_rejects_unsafe_artifact_name_before_output() {
        let (_directory, store, mut session, workspace, profile, documents) =
            pack_fixture(SaveProfile::Solved);
        session
            .run_refs
            .push("runs/run-001/run_manifest.json".to_string());
        store
            .write_import_document(
                "runs/run-001/run_manifest.json",
                &serde_json::to_vec(&test_run("run-001")).unwrap(),
            )
            .unwrap();
        let artifacts = store.root().join("runs/run-001/artifacts");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("bad:artifact"), b"secret").unwrap();

        assert_pack_rejected_without_output(
            &store,
            &session,
            &workspace,
            &profile,
            &documents,
            "unsafe archive path",
        );
    }

    #[cfg(unix)]
    #[test]
    fn pack_rejects_symlink_artifact_before_output() {
        use std::os::unix::fs::symlink;

        let (directory, store, mut session, workspace, profile, documents) =
            pack_fixture(SaveProfile::Solved);
        session
            .run_refs
            .push("runs/run-001/run_manifest.json".to_string());
        store
            .write_import_document(
                "runs/run-001/run_manifest.json",
                &serde_json::to_vec(&test_run("run-001")).unwrap(),
            )
            .unwrap();
        let outside = directory.path().join("outside-file");
        std::fs::write(&outside, b"secret").unwrap();
        let artifacts = store.root().join("runs/run-001/artifacts");
        std::fs::create_dir_all(&artifacts).unwrap();
        symlink(&outside, artifacts.join("leak")).unwrap();

        assert_pack_rejected_without_output(
            &store, &session, &workspace, &profile, &documents, "symlink",
        );
        assert_eq!(std::fs::read(outside).unwrap(), b"secret");
    }

    #[test]
    fn pack_rejects_non_ascii_archive_path_components_before_output() {
        for name in ["Ż.json", "ż.json", "e\u{301}.json"] {
            let (_directory, store, session, workspace, profile, mut documents) =
                pack_fixture(SaveProfile::Compact);
            documents.insert(name.to_string(), b"{}".to_vec());

            assert_pack_rejected_without_output(
                &store, &session, &workspace, &profile, &documents, "ASCII",
            );
        }
    }

    #[test]
    fn portable_namespace_rejects_unsafe_artifact_name() {
        let error =
            validate_portable_namespace_path("runs/run-001/artifacts/bad:artifact").unwrap_err();
        assert!(error.to_string().contains("unsafe archive path"));
    }

    #[cfg(unix)]
    #[test]
    fn pack_rejects_case_folded_dynamic_artifact_collision_before_output() {
        let (_directory, store, mut session, workspace, profile, documents) =
            pack_fixture(SaveProfile::Solved);
        session
            .run_refs
            .push("runs/run-001/run_manifest.json".to_string());
        store
            .write_import_document(
                "runs/run-001/run_manifest.json",
                &serde_json::to_vec(&test_run("run-001")).unwrap(),
            )
            .unwrap();
        let artifacts = store.root().join("runs/run-001/artifacts");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("result.bin"), b"first").unwrap();
        std::fs::write(artifacts.join("RESULT.bin"), b"second").unwrap();

        assert_pack_rejected_without_output(
            &store,
            &session,
            &workspace,
            &profile,
            &documents,
            "case-fold collision",
        );
    }

    #[test]
    fn export_plan_rejects_case_folded_dynamic_artifact_collision() {
        let error = validate_export_entry_metadata(vec![
            ("runs/run-001/artifacts/result.bin".to_string(), 5),
            ("runs/run-001/artifacts/RESULT.bin".to_string(), 6),
        ])
        .unwrap_err();
        assert!(error.to_string().contains("case-fold collision"));
    }

    #[test]
    fn pack_rejects_more_than_100000_entries_before_output() {
        let (_directory, store, session, workspace, profile, mut documents) =
            pack_fixture(SaveProfile::Compact);
        documents.extend(
            (0..MAX_ZIP_ENTRIES).map(|index| (format!("document-{index}.json"), Vec::new())),
        );

        assert_pack_rejected_without_output(
            &store,
            &session,
            &workspace,
            &profile,
            &documents,
            "too many ZIP entries",
        );
    }

    #[test]
    fn pack_rejects_tampered_cas_object_before_output() {
        let (_directory, store, mut session, workspace, profile, documents) =
            pack_fixture(SaveProfile::Resume);
        session
            .run_refs
            .push("runs/run-001/run_manifest.json".to_string());
        store
            .write_import_document(
                "runs/run-001/run_manifest.json",
                &serde_json::to_vec(&test_run("run-001")).unwrap(),
            )
            .unwrap();
        let payload_hash = store.cas().put(&[0u8; 8]).unwrap();
        let mut descriptor = TensorDescriptor::new_f64("m", vec![1], vec!["node".into()]);
        descriptor.chunks.push(TensorChunk {
            object_ref: payload_hash.clone(),
            offset: 0,
            length: 8,
            sha256: Some(payload_hash),
        });
        let descriptor_hash = store.cas().put_json(&descriptor).unwrap();
        let mut checkpoint = FmsCheckpoint::new("run-001", 0, 0.0, 1e-12);
        checkpoint.field_refs.push(FieldRef {
            name: "m".to_string(),
            role: FieldRole::Primary,
            tensor_descriptor_ref: descriptor_hash.clone(),
        });
        let common_state = CommonSolverState {
            step: checkpoint.step,
            time_s: checkpoint.time_s,
            dt: checkpoint.dt,
            energies: SolverEnergies::default(),
            magnetization_ref: None,
        };
        store
            .write_import_document(
                &checkpoint.common_state_ref,
                &serde_json::to_vec(&common_state).unwrap(),
            )
            .unwrap();
        let checkpoint_path = format!(
            "runs/run-001/checkpoints/{}/checkpoint.json",
            checkpoint.checkpoint_id
        );
        store
            .write_import_document(&checkpoint_path, &serde_json::to_vec(&checkpoint).unwrap())
            .unwrap();
        let descriptor_path = store.root().join("objects/sha256").join(descriptor_hash);
        std::fs::write(descriptor_path, b"tampered CAS bytes").unwrap();

        assert_pack_rejected_without_output(
            &store,
            &session,
            &workspace,
            &profile,
            &documents,
            "CAS SHA-256",
        );
    }

    #[test]
    fn export_metadata_rejects_more_than_64_gib_without_allocating_payload() {
        let error = validate_export_entry_metadata(vec![(
            "project/main.py".to_string(),
            MAX_UNCOMPRESSED_ZIP_BYTES + 1,
        )])
        .unwrap_err();

        assert!(error.to_string().contains("uncompressed ZIP size"));
    }

    fn rename_central_directory_entry(mut archive: Vec<u8>, from: &str, to: &str) -> Vec<u8> {
        assert_eq!(from.len(), to.len());
        let eocd = archive
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap();
        let entry_count = u16::from_le_bytes([archive[eocd + 10], archive[eocd + 11]]);
        let central_offset =
            u32::from_le_bytes(archive[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        let mut offset = central_offset;
        for _ in 0..entry_count {
            assert_eq!(&archive[offset..offset + 4], b"PK\x01\x02");
            let name_len =
                u16::from_le_bytes(archive[offset + 28..offset + 30].try_into().unwrap()) as usize;
            let extra_len =
                u16::from_le_bytes(archive[offset + 30..offset + 32].try_into().unwrap()) as usize;
            let comment_len =
                u16::from_le_bytes(archive[offset + 32..offset + 34].try_into().unwrap()) as usize;
            let record_end = offset + 46 + name_len + extra_len + comment_len;
            if &archive[offset + 46..offset + 46 + name_len] == from.as_bytes() {
                archive[offset + 46..offset + 46 + name_len].copy_from_slice(to.as_bytes());
                let local_offset =
                    u32::from_le_bytes(archive[offset + 42..offset + 46].try_into().unwrap())
                        as usize;
                assert_eq!(&archive[local_offset..local_offset + 4], b"PK\x03\x04");
                let local_name_len = u16::from_le_bytes(
                    archive[local_offset + 26..local_offset + 28]
                        .try_into()
                        .unwrap(),
                ) as usize;
                assert_eq!(local_name_len, to.len());
                archive[local_offset + 30..local_offset + 30 + local_name_len]
                    .copy_from_slice(to.as_bytes());
                return archive;
            }
            offset = record_end;
        }
        panic!("entry `{from}` exists in central directory");
    }

    #[test]
    fn preflight_preserves_the_exact_main_py_bytes() {
        let script = b"# keep CRLF exactly\r\nprint('  spacing  ')\r\n";
        let workspace = test_workspace(script);
        let archive = archive_with_entries(
            &workspace,
            [
                ("project/main.py".to_string(), script.to_vec()),
                ("project/ui_state.json".to_string(), b"{}".to_vec()),
            ],
        );

        let preflight = preflight_fms(
            Cursor::new(archive),
            &["project/main.py", "project/ui_state.json"],
        )
        .unwrap();

        assert_eq!(preflight.documents["project/main.py"], script);
        assert_eq!(preflight.workspace.script_ref, "project/main.py");
    }

    #[test]
    fn preflight_rejects_an_archive_without_the_declared_script() {
        let script = b"print('missing')";
        let archive = archive_with_entries(&test_workspace(script), []);

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("project/main.py"));
    }

    #[test]
    fn manifest_content_ids_are_rejected_before_import_writes() {
        // ZIP entry names are all valid; the attack is inside session.json.
        for id in [
            "../escape",
            "/absolute",
            "C:drive",
            "a\\b",
            "NUL",
            "CON.json",
        ] {
            let script = b"print('unchanged')";
            let mut session = test_session();
            session.session_id = id.into();
            let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            write_json(&mut writer, "manifest/session.json", &session, options).unwrap();
            write_json(
                &mut writer,
                "manifest/workspace.json",
                &test_workspace(script),
                options,
            )
            .unwrap();
            write_json(
                &mut writer,
                "manifest/export_profile.json",
                &FmsExportProfile::for_profile(SaveProfile::Compact),
                options,
            )
            .unwrap();
            writer.start_file("project/main.py", options).unwrap();
            writer.write_all(script).unwrap();
            let archive = writer.finish().unwrap().into_inner();
            assert!(preflight_fms(Cursor::new(&archive), &[]).is_err(), "{id}");

            let directory = tempfile::tempdir().unwrap();
            let sentinel = directory.path().join("sentinel");
            fs::write(&sentinel, b"preserve outside staging").unwrap();
            let store = SessionStore::open(directory.path().join("store")).unwrap();
            let owner_before = fs::read(store.root().join("WRITER.owner.json")).unwrap();
            assert!(unpack_fms(Cursor::new(archive), &store).is_err(), "{id}");
            assert_eq!(fs::read(sentinel).unwrap(), b"preserve outside staging");
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
            assert_eq!(
                fs::read(store.root().join("WRITER.owner.json")).unwrap(),
                owner_before,
                "invalid archive must be rejected before acquiring a writer"
            );
            assert!(store.current_session().unwrap().is_none());
            assert!(store.cas().list().unwrap().is_empty());
            assert!(store.read_document("project/main.py").unwrap().is_none());
            assert_eq!(
                fs::read_dir(store.root().join("manifests"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }

    #[test]
    fn preflight_rejects_a_workspace_manifest_without_script_hash() {
        let script = b"print('missing hash')";
        let mut workspace = serde_json::to_value(test_workspace(script)).unwrap();
        workspace.as_object_mut().unwrap().remove("script_sha256");
        let archive = archive_with_workspace_value(
            workspace,
            [("project/main.py".to_string(), script.to_vec())],
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(format!("{error:#}").contains("script_sha256"));
    }

    #[test]
    fn preflight_rejects_a_mismatched_script_hash() {
        let script = b"print('integrity')";
        let mut workspace = test_workspace(script);
        workspace.script_sha256 = "0".repeat(64);
        let archive = archive_with_entries(
            &workspace,
            [("project/main.py".to_string(), script.to_vec())],
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("script SHA-256"));
    }

    #[test]
    fn preflight_rejects_duplicate_project_main_py() {
        let script = b"print('once')";
        let archive = rename_central_directory_entry(
            archive_with_entries(
                &test_workspace(script),
                [
                    ("project/main.py".to_string(), script.to_vec()),
                    ("project/dupe.py".to_string(), script.to_vec()),
                ],
            ),
            "project/dupe.py",
            "project/main.py",
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().to_lowercase().contains("duplicate"));
    }

    #[test]
    fn preflight_rejects_parent_traversal() {
        let script = b"print('safe')";
        let archive = archive_with_entries(
            &test_workspace(script),
            [
                ("project/main.py".to_string(), script.to_vec()),
                ("../escape".to_string(), b"bad".to_vec()),
            ],
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("unsafe archive path"));
    }

    #[test]
    fn preflight_rejects_absolute_paths() {
        let script = b"print('safe')";
        let archive = archive_with_entries(
            &test_workspace(script),
            [
                ("project/main.py".to_string(), script.to_vec()),
                ("/absolute".to_string(), b"bad".to_vec()),
            ],
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("unsafe archive path"));
    }

    #[test]
    fn preflight_rejects_windows_prefix_paths() {
        let script = b"print('safe')";
        let archive = archive_with_entries(
            &test_workspace(script),
            [
                ("project/main.py".to_string(), script.to_vec()),
                ("C:/escape".to_string(), b"bad".to_vec()),
            ],
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("unsafe archive path"));
    }

    fn assert_script_alias_is_rejected(alias: &str) {
        let script = b"print('verified')";
        let archive = archive_with_entries(
            &test_workspace(script),
            [
                ("project/main.py".to_string(), script.to_vec()),
                (alias.to_string(), b"print('unverified')".to_vec()),
            ],
        );

        let error = preflight_fms(Cursor::new(&archive), &[]).unwrap_err();
        assert!(error.to_string().contains("unsafe archive path"));

        let store_dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(store_dir.path().join("store")).unwrap();
        let error = unpack_fms(Cursor::new(archive), &store).unwrap_err();
        assert!(error.to_string().contains("unsafe archive path"));
        assert_eq!(store.read_document("project/main.py").unwrap(), None);
    }

    #[test]
    fn preflight_and_unpack_reject_current_directory_script_alias() {
        assert_script_alias_is_rejected("./project/main.py");
    }

    #[test]
    fn preflight_and_unpack_reject_repeated_separator_script_alias() {
        assert_script_alias_is_rejected("project//main.py");
    }

    #[test]
    fn preflight_and_unpack_reject_inner_current_directory_script_alias() {
        assert_script_alias_is_rejected("project/./main.py");
    }

    fn assert_case_fold_collision_is_rejected(
        entries: Vec<(String, Vec<u8>)>,
        expected_error: &str,
    ) {
        let archive = archive_with_entries(&test_workspace(b"print('verified')"), entries);

        let error = preflight_fms(Cursor::new(&archive), &[]).unwrap_err();
        assert!(error.to_string().contains(expected_error));

        let store_dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(store_dir.path().join("store")).unwrap();
        let error = unpack_fms(Cursor::new(archive), &store).unwrap_err();
        assert!(error.to_string().contains(expected_error));
        assert_eq!(store.read_document("project/main.py").unwrap(), None);
    }

    fn assert_rejected_before_store_mutation(archive: Vec<u8>, expected_error: &str) {
        let error = preflight_fms(Cursor::new(&archive), &[]).unwrap_err();
        assert!(error.to_string().contains(expected_error));

        let store_dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(store_dir.path().join("store")).unwrap();
        let error = unpack_fms(Cursor::new(archive), &store).unwrap_err();
        assert!(error.to_string().contains(expected_error));
        assert_eq!(store.read_document("project/main.py").unwrap(), None);
        assert!(store.cas().list().unwrap().is_empty());
    }

    fn archive_with_symlink(name: &str) -> Vec<u8> {
        let script = b"print('verified')";
        let workspace = test_workspace(script);
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        write_json(
            &mut writer,
            "manifest/session.json",
            &test_session(),
            options,
        )
        .unwrap();
        write_json(&mut writer, "manifest/workspace.json", &workspace, options).unwrap();
        write_json(
            &mut writer,
            "manifest/export_profile.json",
            &FmsExportProfile::for_profile(SaveProfile::Compact),
            options,
        )
        .unwrap();
        writer.start_file("project/main.py", options).unwrap();
        writer.write_all(script).unwrap();
        writer.add_symlink(name, "target", options).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn preflight_and_unpack_reject_portable_namespace_aliases() {
        for alias in [
            "project/main.py.",
            "project/main.py ",
            r"project\main.py",
            "project/main.py:alternate",
            "project/CON.txt",
            "project/COM1.log",
            "project/LPT9",
        ] {
            let archive = archive_with_entries(
                &test_workspace(b"print('verified')"),
                [
                    ("project/main.py".to_string(), b"print('verified')".to_vec()),
                    (alias.to_string(), b"malicious".to_vec()),
                ],
            );
            assert_rejected_before_store_mutation(archive, "unsafe archive path");
        }
    }

    #[test]
    fn preflight_and_unpack_reject_noncanonical_case_folded_cas_path() {
        let digest = crate::cas::hex_sha256(b"expected CAS bytes");
        let archive = archive_with_entries(
            &test_workspace(b"print('verified')"),
            [
                ("project/main.py".to_string(), b"print('verified')".to_vec()),
                (
                    format!("OBJECTS/SHA256/{digest}"),
                    b"tampered CAS bytes".to_vec(),
                ),
            ],
        );
        assert_rejected_before_store_mutation(archive, "non-canonical CAS path");
    }

    #[test]
    fn preflight_and_unpack_reject_symlink_entries() {
        assert_rejected_before_store_mutation(archive_with_symlink("project/link"), "symlink");
    }

    #[test]
    fn preflight_and_unpack_reject_non_ascii_regular_document_names() {
        let script = b"print('verified')";
        let archive = archive_with_entries(
            &test_workspace(script),
            [
                ("project/main.py".to_string(), script.to_vec()),
                ("project/zażółć.json".to_string(), b"{}".to_vec()),
            ],
        );

        assert_rejected_before_store_mutation(archive, "ASCII");
    }

    #[test]
    fn preflight_and_unpack_reject_case_folded_script_alias() {
        assert_case_fold_collision_is_rejected(
            vec![
                ("project/main.py".to_string(), b"print('verified')".to_vec()),
                (
                    "PROJECT/MAIN.PY".to_string(),
                    b"print('unverified')".to_vec(),
                ),
            ],
            "non-canonical project path",
        );
    }

    #[test]
    fn preflight_and_unpack_reject_case_folded_document_alias() {
        assert_case_fold_collision_is_rejected(
            vec![
                ("project/main.py".to_string(), b"print('verified')".to_vec()),
                ("project/ui_state.json".to_string(), b"{}".to_vec()),
                ("PROJECT/UI_STATE.JSON".to_string(), b"malicious".to_vec()),
            ],
            "non-canonical project path",
        );
    }

    #[test]
    fn preflight_and_unpack_reject_case_folded_cas_alias() {
        let data = b"CAS bytes".to_vec();
        let digest = crate::cas::hex_sha256(&data);
        assert_case_fold_collision_is_rejected(
            vec![
                ("project/main.py".to_string(), b"print('verified')".to_vec()),
                (format!("objects/sha256/{digest}"), data.clone()),
                (
                    format!("OBJECTS/SHA256/{}", digest.to_ascii_uppercase()),
                    data,
                ),
            ],
            "non-canonical CAS path",
        );
    }

    #[test]
    fn preflight_and_unpack_reject_case_folded_regular_document_collision() {
        assert_case_fold_collision_is_rejected(
            vec![
                ("project/main.py".to_string(), b"print('verified')".to_vec()),
                ("runs/notes.txt".to_string(), b"first".to_vec()),
                ("RUNS/NOTES.TXT".to_string(), b"second".to_vec()),
            ],
            "case-fold collision",
        );
    }

    #[test]
    fn preflight_rejects_a_cas_object_with_a_mismatched_digest() {
        let script = b"print('safe')";
        let digest = crate::cas::hex_sha256(b"expected object");
        let archive = archive_with_entries(
            &test_workspace(script),
            [
                ("project/main.py".to_string(), script.to_vec()),
                (format!("objects/sha256/{digest}"), b"other object".to_vec()),
            ],
        );

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("CAS SHA-256"));
    }

    #[test]
    fn preflight_rejects_more_than_100000_entries() {
        let script = b"print('safe')";
        let workspace = test_workspace(script);
        let entries = std::iter::once(("project/main.py".to_string(), script.to_vec()))
            .chain((0..100_000).map(|index| (format!("project/doc-{index}"), Vec::new())));
        let archive = archive_with_entries(&workspace, entries);

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("too many ZIP entries"));
    }

    #[test]
    fn preflight_rejects_more_than_64_gib_of_declared_uncompressed_data() {
        let script = b"print('safe')";
        let workspace = test_workspace(script);
        let archive = archive_with_entries(
            &workspace,
            std::iter::once(("project/main.py".to_string(), script.to_vec()))
                .chain((0..17).map(|index| (format!("project/large-{index}"), Vec::new()))),
        );
        let mut archive = archive;
        let eocd = archive
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap();
        let entry_count = u16::from_le_bytes([archive[eocd + 10], archive[eocd + 11]]);
        let mut offset =
            u32::from_le_bytes(archive[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        let mut patched = 0;
        for _ in 0..entry_count {
            assert_eq!(&archive[offset..offset + 4], b"PK\x01\x02");
            let local_offset =
                u32::from_le_bytes(archive[offset + 42..offset + 46].try_into().unwrap()) as usize;
            archive[offset + 24..offset + 28].copy_from_slice(&(u32::MAX - 1).to_le_bytes());
            archive[local_offset + 22..local_offset + 26]
                .copy_from_slice(&(u32::MAX - 1).to_le_bytes());
            let name_len =
                u16::from_le_bytes(archive[offset + 28..offset + 30].try_into().unwrap()) as usize;
            let extra_len =
                u16::from_le_bytes(archive[offset + 30..offset + 32].try_into().unwrap()) as usize;
            let comment_len =
                u16::from_le_bytes(archive[offset + 32..offset + 34].try_into().unwrap()) as usize;
            offset += 46 + name_len + extra_len + comment_len;
            patched += 1;
        }
        assert_eq!(patched, 21);

        let error = preflight_fms(Cursor::new(archive), &[]).unwrap_err();

        assert!(error.to_string().contains("uncompressed ZIP size"));
    }

    #[test]
    fn pack_inspect_unpack_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();

        // Prepare session.
        let session = FmsSessionManifest::new("s-001", "Test", SaveProfile::Compact);
        store.commit_session(&session).unwrap();

        let script = b"# fullmag script\nprint('hello')".to_vec();
        let workspace = FmsWorkspaceManifest {
            workspace_id: "local-live".into(),
            problem_name: "test_problem".into(),
            project_ref: "project/".into(),
            script_ref: "project/main.py".into(),
            script_sha256: crate::cas::hex_sha256(&script),
            ui_state_ref: "project/ui_state.json".into(),
            scene_document_ref: "project/scene_document.json".into(),
            script_builder_ref: None,
            model_builder_graph_ref: None,
            asset_index_ref: None,
        };
        let export_profile = FmsExportProfile::for_profile(SaveProfile::Compact);

        let mut docs = HashMap::new();
        docs.insert("main.py".into(), script);
        docs.insert("ui_state.json".into(), b"{}".to_vec());
        docs.insert("scene_document.json".into(), b"{}".to_vec());

        // Pack to memory.
        let mut buf = Cursor::new(Vec::new());
        pack_fms(
            &mut buf,
            &store,
            &session,
            &workspace,
            &export_profile,
            &docs,
            &PackOptions::default(),
        )
        .unwrap();

        let fms_data = buf.into_inner();
        assert!(!fms_data.is_empty());

        // Every archive emitted by pack_fms must satisfy the same preflight gate
        // that protects inspect and unpack.
        let preflight = preflight_fms(Cursor::new(&fms_data), &[]).unwrap();
        assert_eq!(preflight.session.session_id, "s-001");

        // Inspect.
        let inspection = inspect_fms(Cursor::new(&fms_data)).unwrap();
        assert_eq!(inspection.session_id, "s-001");
        assert_eq!(inspection.profile, SaveProfile::Compact);

        // Unpack into a new store.
        let dir2 = tempfile::tempdir().unwrap();
        let store2 = SessionStore::open(dir2.path().join("store")).unwrap();
        let loaded = unpack_fms(Cursor::new(&fms_data), &store2).unwrap();
        assert_eq!(loaded.session_id, "s-001");

        // Verify documents were extracted.
        let script = store2.read_document("project/main.py").unwrap();
        assert!(script.is_some());
        assert!(String::from_utf8_lossy(&script.unwrap()).contains("hello"));
    }

    #[test]
    fn inspect_reports_when_a_solved_run_has_no_packaged_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let mut session = FmsSessionManifest::new("s-001", "Test", SaveProfile::Solved);
        session
            .run_refs
            .push("runs/run-001/run_manifest.json".to_string());
        store
            .commit_run(&FmsRunManifest {
                run_id: "run-001".to_string(),
                status: RunStatus::Completed,
                study_kind: "eigenmode".to_string(),
                backend: "fem".to_string(),
                precision: "double".to_string(),
                started_at: chrono::Utc::now(),
                finished_at: Some(chrono::Utc::now()),
                total_steps: 1,
                total_time_s: 0.0,
                plan_ref: None,
                live_state_ref: None,
                latest_checkpoint_ref: None,
                artifact_index_ref: None,
            })
            .unwrap();
        store.commit_session(&session).unwrap();
        let script = b"# fullmag script".to_vec();
        let workspace = FmsWorkspaceManifest {
            workspace_id: "local-live".into(),
            problem_name: "test_problem".into(),
            project_ref: "project/".into(),
            script_ref: "project/main.py".into(),
            script_sha256: crate::cas::hex_sha256(&script),
            ui_state_ref: "project/ui_state.json".into(),
            scene_document_ref: "project/scene_document.json".into(),
            script_builder_ref: None,
            model_builder_graph_ref: None,
            asset_index_ref: None,
        };
        let mut documents = HashMap::new();
        documents.insert("main.py".into(), script);

        let mut buffer = Cursor::new(Vec::new());
        pack_fms(
            &mut buffer,
            &store,
            &session,
            &workspace,
            &FmsExportProfile::for_profile(SaveProfile::Solved),
            &documents,
            &PackOptions::default(),
        )
        .unwrap();

        let inspection = inspect_fms(Cursor::new(buffer.into_inner())).unwrap();
        assert!(inspection
            .warnings
            .iter()
            .any(|warning| warning.contains("no packaged artifacts")));
    }
    fn live_snapshot_bytes(
        run_id: &str,
        artifacts: &[(&str, &str)],
        object_ref: Option<&str>,
    ) -> Vec<u8> {
        let artifacts = artifacts
            .iter()
            .map(|&(path, kind)| serde_json::json!({"path": path, "kind": kind}))
            .collect::<Vec<_>>();
        let latest_fields = object_ref
            .map(|object_ref| serde_json::json!({"m": {"payload_ref": object_ref}}))
            .unwrap_or_else(|| serde_json::json!({}));
        serde_json::to_vec(&serde_json::json!({
            "session_protocol_version": "v2",
            "capability_profile_version": "v1",
            "session": {"session_id": "s-001", "run_id": run_id},
            "runtime_status": {},
            "artifacts": artifacts,
            "display_selection": {},
            "preview_config": {},
            "mesh_revision": 1,
            "mesh_build_revision": 1,
            "latest_fields": latest_fields,
        }))
        .unwrap()
    }

    fn archive_with_live_snapshot(
        script: &[u8],
        snapshot: &[u8],
        run_artifacts: impl IntoIterator<Item = (String, Vec<u8>)>,
    ) -> Vec<u8> {
        let mut entries = vec![
            ("project/main.py".to_string(), script.to_vec()),
            ("project/ui_state.json".to_string(), b"{}".to_vec()),
            ("project/scene_document.json".to_string(), b"{}".to_vec()),
            (
                "project/current_live_snapshot.json".to_string(),
                snapshot.to_vec(),
            ),
        ];
        entries.extend(run_artifacts);
        archive_with_entries(&test_workspace(script), entries)
    }

    fn assert_snapshot_import_left_destination_pristine(
        store: &SessionStore,
        owner_before: &[u8],
    ) {
        assert_eq!(
            fs::read(store.root().join("WRITER.owner.json")).unwrap(),
            owner_before
        );
        assert!(store.current_session().unwrap().is_none());
        for relative in [
            "project/main.py",
            "project/ui_state.json",
            "project/scene_document.json",
            "project/current_live_snapshot.json",
        ] {
            assert_eq!(store.read_document(relative).unwrap(), None, "{relative}");
        }
        assert!(store.cas().list().unwrap().is_empty());
        assert!(
            !store
                .root()
                .join("runs/run-live/artifacts/eigen/spectrum.json")
                .exists()
        );
        assert_eq!(
            fs::read_dir(store.root().join("manifests"))
                .unwrap()
                .count(),
            0
        );
    }

    fn assert_imported_live_artifacts(store: &SessionStore) {
        assert_eq!(
            store.current_session().unwrap().unwrap().session_id,
            "s-001"
        );
        assert_eq!(
            store
                .read_document("runs/run-live/artifacts/eigen/spectrum.json")
                .unwrap()
                .as_deref(),
            Some(&b"spectrum bytes"[..])
        );
        assert_eq!(
            store
                .read_document("runs/run-live/artifacts/fields/m.zarr/.zgroup")
                .unwrap()
                .as_deref(),
            Some(&b"{}"[..])
        );
        assert_eq!(
            store
                .read_document("runs/run-live/artifacts/fields/m.zarr/0")
                .unwrap()
                .as_deref(),
            Some(&b"zarr chunk"[..])
        );
    }

    #[test]
    fn public_unpackers_reject_missing_snapshot_artifacts_before_store_mutation() {
        let script = b"print('snapshot artifact')";
        let snapshot = live_snapshot_bytes(
            "run-live",
            &[("eigen/spectrum.json", "json")],
            None,
        );
        let archive = archive_with_live_snapshot(script, &snapshot, std::iter::empty::<(String, Vec<u8>)>());

        let parent = tempfile::tempdir().unwrap();
        let store = SessionStore::open(parent.path().join("store")).unwrap();
        let owner_before = fs::read(store.root().join("WRITER.owner.json")).unwrap();

        let error = unpack_fms(Cursor::new(archive.clone()), &store).unwrap_err();
        assert!(
            format!("{error:#}").contains("runs/run-live/artifacts/eigen/spectrum.json"),
            "{error:#}"
        );
        assert_snapshot_import_left_destination_pristine(&store, &owner_before);

        let error = unpack_fms_for_visualization(Cursor::new(archive.clone()), &store)
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("runs/run-live/artifacts/eigen/spectrum.json"),
            "{error:#}"
        );
        assert_snapshot_import_left_destination_pristine(&store, &owner_before);

        let staged = preflight_fms_staged(Cursor::new(archive), &[], parent.path()).unwrap();
        assert!(!staged.reachability.complete);
        let error = unpack_fms_staged(&staged, &store).unwrap_err();
        assert!(
            format!("{error:#}").contains("runs/run-live/artifacts/eigen/spectrum.json"),
            "{error:#}"
        );
        assert_snapshot_import_left_destination_pristine(&store, &owner_before);
        drop(staged);
    }

    #[test]
    fn public_unpackers_accept_snapshot_file_and_nonempty_zarr_subtree() {
        let script = b"print('snapshot artifacts')";
        let snapshot = live_snapshot_bytes(
            "run-live",
            &[
                ("eigen/spectrum.json", "json"),
                ("fields/m.zarr", "zarr"),
            ],
            None,
        );
        let archive = archive_with_live_snapshot(
            script,
            &snapshot,
            [
                (
                    "runs/run-live/artifacts/eigen/spectrum.json".to_string(),
                    b"spectrum bytes".to_vec(),
                ),
                (
                    "runs/run-live/artifacts/fields/m.zarr/.zgroup".to_string(),
                    b"{}".to_vec(),
                ),
                (
                    "runs/run-live/artifacts/fields/m.zarr/0".to_string(),
                    b"zarr chunk".to_vec(),
                ),
            ],
        );

        let unpack_parent = tempfile::tempdir().unwrap();
        let unpack_store = SessionStore::open(unpack_parent.path().join("store")).unwrap();
        unpack_fms(Cursor::new(archive.clone()), &unpack_store).unwrap();
        assert_imported_live_artifacts(&unpack_store);

        let visualization_parent = tempfile::tempdir().unwrap();
        let visualization_store =
            SessionStore::open(visualization_parent.path().join("store")).unwrap();
        unpack_fms_for_visualization(Cursor::new(archive.clone()), &visualization_store).unwrap();
        assert_imported_live_artifacts(&visualization_store);

        let staged_parent = tempfile::tempdir().unwrap();
        let staged = preflight_fms_staged(
            Cursor::new(archive),
            &[],
            staged_parent.path(),
        )
        .unwrap();
        let staged_store = SessionStore::open(staged_parent.path().join("store")).unwrap();
        unpack_fms_staged(&staged, &staged_store).unwrap();
        assert_imported_live_artifacts(&staged_store);
        drop(staged);
    }

    #[test]
    fn compact_export_binds_snapshot_artifacts_and_preserves_cas_references() {
        let (_directory, store, mut session, workspace, profile, base_documents) =
            pack_fixture(SaveProfile::Compact);
        assert!(matches!(profile.include_artifacts, ArtifactPolicy::None));
        session
            .run_refs
            .push("runs/run-export/run_manifest.json".to_string());
        store.commit_run(&test_run("run-export")).unwrap();

        let payload = b"snapshot-owned CAS payload";
        let object_ref = store.cas().put(payload).unwrap();
        let source_artifact = store
            .root()
            .join("runs/run-export/artifacts/eigen/spectrum.json");
        fs::create_dir_all(source_artifact.parent().unwrap()).unwrap();
        fs::write(&source_artifact, b"spectrum exists in source store").unwrap();

        for snapshot_key in [
            "current_live_snapshot.json",
            "project/current_live_snapshot.json",
        ] {
            let mut documents = base_documents.clone();
            documents.insert("ui_state.json".to_string(), b"{}".to_vec());
            documents.insert("scene_document.json".to_string(), b"{}".to_vec());
            documents.insert(
                snapshot_key.to_string(),
                live_snapshot_bytes(
                    "run-export",
                    &[("eigen/spectrum.json", "json")],
                    Some(&object_ref),
                ),
            );

            let error = pack_fms(
                Cursor::new(Vec::new()),
                &store,
                &session,
                &workspace,
                &profile,
                &documents,
                &PackOptions::default(),
            )
            .unwrap_err();
            assert!(
                format!("{error:#}")
                    .contains("runs/run-export/artifacts/eigen/spectrum.json"),
                "{error:#}"
            );

            documents.insert(
                snapshot_key.to_string(),
                live_snapshot_bytes("run-export", &[], Some(&object_ref)),
            );
            let mut output = Cursor::new(Vec::new());
            pack_fms(
                &mut output,
                &store,
                &session,
                &workspace,
                &profile,
                &documents,
                &PackOptions::default(),
            )
            .unwrap();
            let archive = output.into_inner();
            {
                let mut zip = zip::ZipArchive::new(Cursor::new(&archive)).unwrap();
                let name = format!("objects/sha256/{object_ref}");
                let mut cas_object = zip.by_name(&name).unwrap();
                let mut archived_payload = Vec::new();
                cas_object.read_to_end(&mut archived_payload).unwrap();
                assert_eq!(archived_payload, payload);
            }
            let preflight = preflight_fms(Cursor::new(archive), &[]).unwrap();
            assert!(preflight.reachability.object_refs.contains(&object_ref));
        }
    }

}

#[cfg(test)]
#[path = "fms_owner_closure_tests.rs"]
mod owner_closure_tests;
