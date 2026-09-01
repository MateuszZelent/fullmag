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
//! │     ├─ checkpoints/
//! │     └─ artifacts/
//! └─ objects/
//!    └─ sha256/
//! ```

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

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
    pub documents: HashMap<String, Vec<u8>>,
}

const MAX_ZIP_ENTRIES: usize = 100_000;
const MAX_UNCOMPRESSED_ZIP_BYTES: u64 = 64 * 1024 * 1024 * 1024;

struct ZipDirectoryScan {
    names: Vec<String>,
    total_compressed: u64,
}

struct PackEntry {
    archive_path: String,
    data: Vec<u8>,
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
    validate_pack_input(workspace, documents)?;
    let canonical_root = canonical_store_root(store.root())?;
    let run_entries = plan_run_entries(store.root(), &canonical_root, session, export_profile)?;
    let cas_entries = plan_cas_entries(store.root(), &canonical_root, &run_entries)?;
    validate_export_plan(
        session,
        workspace,
        export_profile,
        documents,
        &run_entries,
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
        zip.write_all(&entry.data)?;
    }

    // ── objects/ ───────────────────────────────────────────────────────
    // Only include CAS objects that are referenced by packed checkpoints.
    for entry in cas_entries {
        // Use Stored for binary blobs — they're already compressed or incompressible.
        let blob_opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        zip.start_file(&entry.archive_path, blob_opts)?;
        zip.write_all(&entry.data)?;
    }

    zip.finish()?;
    Ok(())
}

fn canonical_store_root(store_root: &Path) -> Result<PathBuf> {
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
) -> Result<Vec<PackEntry>> {
    let mut entries = Vec::new();
    let mut hashes = HashSet::new();
    for entry in run_entries
        .iter()
        .filter(|entry| entry.archive_path.ends_with("/checkpoint.json"))
    {
        let checkpoint: FmsCheckpoint = serde_json::from_slice(&entry.data)
            .with_context(|| format!("parsing packaged checkpoint {}", entry.archive_path))?;
        hashes.extend(
            checkpoint
                .field_refs
                .into_iter()
                .map(|field_ref| field_ref.tensor_descriptor_ref),
        );
    }
    for hash in hashes {
        let archive_path = format!("objects/sha256/{hash}");
        validate_portable_namespace_path(&archive_path)?;
        let source = store_root.join(&archive_path);
        if let Some(data) = read_store_file_if_exists(store_root, canonical_root, &source)? {
            let actual = crate::cas::hex_sha256(&data);
            if actual != hash {
                anyhow::bail!(
                    "CAS SHA-256 mismatch for `{archive_path}`: expected {hash}, got {actual}"
                );
            }
            entries.push(PackEntry { archive_path, data });
        }
    }
    Ok(entries)
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
            entries.push(PackEntry {
                archive_path: run_ref.clone(),
                data,
            });
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
            entries.push(PackEntry {
                archive_path,
                data: read_store_file(store_root, canonical_root, &file.path())?,
            });
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
            entries.push(PackEntry {
                archive_path,
                data: read_store_file(store_root, canonical_root, &entry.path())?,
            });
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
    std::fs::read(source).with_context(|| format!("reading store source {}", source.display()))
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
    cas_entries: &[PackEntry],
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
            .map(|entry| Ok((entry.archive_path.clone(), archive_entry_size(&entry.data)?)))
            .collect::<Result<Vec<_>>>()?,
    );
    entries.extend(
        cas_entries
            .iter()
            .map(|entry| Ok((entry.archive_path.clone(), archive_entry_size(&entry.data)?)))
            .collect::<Result<Vec<_>>>()?,
    );
    validate_export_entry_metadata(entries)
}

fn archive_entry_size(data: &[u8]) -> Result<u64> {
    u64::try_from(data.len()).context("archive entry size does not fit u64")
}

fn validate_export_entry_metadata(entries: Vec<(String, u64)>) -> Result<()> {
    let mut registry = HashSet::new();
    let mut limits = ArchiveLimitAccounting::default();
    for (path, uncompressed_size) in entries {
        validate_portable_namespace_path(&path)?;
        if !registry.insert(portable_extraction_key(&path)) {
            anyhow::bail!("duplicate archive path or case-fold collision `{path}`");
        }
        limits.account_entry(uncompressed_size)?;
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
    let mut reader = reader;
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    let scan = scan_zip_directory(&bytes)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut documents = HashMap::new();
    if archive.len() != scan.names.len() {
        anyhow::bail!("ZIP central directory entry count is inconsistent");
    }

    for (index, name) in scan.names.iter().enumerate() {
        let mut entry = archive.by_index(index)?;
        if entry.is_symlink() {
            anyhow::bail!("symlink entries are not permitted (`{name}`)");
        }
        if name.ends_with('/') {
            continue;
        }

        let mut data = Vec::new();
        entry.read_to_end(&mut data)?;
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

    let inspection = build_inspection(&session, &documents, scan.total_compressed);
    Ok(FmsPreflight {
        session,
        workspace,
        export_profile,
        inspection,
        documents,
    })
}

fn scan_zip_directory(bytes: &[u8]) -> Result<ZipDirectoryScan> {
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .context("ZIP end-of-central-directory record not found")?;
    if eocd + 22 > bytes.len() {
        anyhow::bail!("truncated ZIP end-of-central-directory record");
    }

    let standard_entry_count = u16_le(bytes, eocd + 10)? as u64;
    let standard_directory_size = u32_le(bytes, eocd + 12)? as u64;
    let standard_directory_offset = u32_le(bytes, eocd + 16)? as u64;
    let (entry_count, directory_size, directory_offset) = if standard_entry_count == u16::MAX as u64
        || standard_directory_size == u32::MAX as u64
        || standard_directory_offset == u32::MAX as u64
    {
        if eocd < 20 || &bytes[eocd - 20..eocd - 16] != b"PK\x06\x07" {
            anyhow::bail!("ZIP64 locator not found");
        }
        let zip64_offset = u64_le(bytes, eocd - 12)? as usize;
        if zip64_offset + 56 > bytes.len()
            || &bytes[zip64_offset..zip64_offset + 4] != b"PK\x06\x06"
        {
            anyhow::bail!("ZIP64 end-of-central-directory record not found");
        }
        (
            u64_le(bytes, zip64_offset + 32)?,
            u64_le(bytes, zip64_offset + 40)?,
            u64_le(bytes, zip64_offset + 48)?,
        )
    } else {
        (
            standard_entry_count,
            standard_directory_size,
            standard_directory_offset,
        )
    };

    ArchiveLimitAccounting::validate_declared_entry_count(entry_count)?;
    let directory_end = directory_offset
        .checked_add(directory_size)
        .context("ZIP central directory size overflow")?;
    if directory_end > bytes.len() as u64 {
        anyhow::bail!("truncated ZIP central directory");
    }

    let mut offset = directory_offset as usize;
    let directory_end = directory_end as usize;
    let mut names = Vec::with_capacity(entry_count as usize);
    let mut seen_names = HashSet::new();
    let mut limits = ArchiveLimitAccounting::default();
    let mut total_compressed = 0u64;
    for _ in 0..entry_count {
        if offset + 46 > directory_end || &bytes[offset..offset + 4] != b"PK\x01\x02" {
            anyhow::bail!("malformed ZIP central directory entry");
        }
        let mut compressed_size = u32_le(bytes, offset + 20)? as u64;
        let mut uncompressed_size = u32_le(bytes, offset + 24)? as u64;
        let name_len = u16_le(bytes, offset + 28)? as usize;
        let extra_len = u16_le(bytes, offset + 30)? as usize;
        let comment_len = u16_le(bytes, offset + 32)? as usize;
        let entry_end = offset
            .checked_add(46 + name_len + extra_len + comment_len)
            .context("ZIP central directory entry size overflow")?;
        if entry_end > directory_end {
            anyhow::bail!("truncated ZIP central directory entry");
        }
        let name = std::str::from_utf8(&bytes[offset + 46..offset + 46 + name_len])
            .context("ZIP entry name is not valid UTF-8")?
            .to_owned();
        validate_portable_namespace_path(&name)?;
        if !seen_names.insert(portable_extraction_key(&name)) {
            anyhow::bail!("duplicate ZIP entry or case-fold collision `{name}`");
        }
        let extra = &bytes[offset + 46 + name_len..offset + 46 + name_len + extra_len];
        let needs_zip64_uncompressed = uncompressed_size == u32::MAX as u64;
        let needs_zip64_compressed = compressed_size == u32::MAX as u64;
        if needs_zip64_uncompressed || needs_zip64_compressed {
            let (zip64_uncompressed, zip64_compressed) =
                zip64_sizes(extra, needs_zip64_uncompressed, needs_zip64_compressed)?;
            if uncompressed_size == u32::MAX as u64 {
                uncompressed_size =
                    zip64_uncompressed.context("ZIP64 uncompressed size is missing")?;
            }
            if compressed_size == u32::MAX as u64 {
                compressed_size = zip64_compressed.context("ZIP64 compressed size is missing")?;
            }
        }
        limits.account_entry(uncompressed_size)?;
        total_compressed = total_compressed.saturating_add(compressed_size);
        names.push(name);
        offset = entry_end;
    }
    if offset != directory_end {
        anyhow::bail!("ZIP central directory has trailing data");
    }
    Ok(ZipDirectoryScan {
        names,
        total_compressed,
    })
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
    documents: &HashMap<String, Vec<u8>>,
    total_compressed: u64,
) -> SessionInspection {
    let entry_names = documents.keys().cloned().collect::<HashSet<_>>();
    let mut warnings = Vec::new();

    // Try to find the latest checkpoint.
    let mut latest_cp: Option<CheckpointSummary> = None;
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
            match document_json::<FmsCheckpoint>(documents, &name) {
                Ok(cp) => {
                    let summary = CheckpointSummary {
                        checkpoint_id: cp.checkpoint_id,
                        step: cp.step,
                        time_s: cp.time_s,
                        study_kind: cp.compatibility.study_kind.unwrap_or_default(),
                    };
                    if latest_cp
                        .as_ref()
                        .map_or(true, |prev| summary.step > prev.step)
                    {
                        latest_cp = Some(summary);
                    }
                }
                Err(error) => warnings.push(format!(
                    "checkpoint descriptor '{name}' cannot be read: {error}"
                )),
            }
        }
    }

    let restore_class = if latest_cp.is_some()
        && matches!(session.profile, SaveProfile::Resume | SaveProfile::Archive)
    {
        RestoreClass::LogicalResume // actual exact_resume needs runtime check
    } else if matches!(session.profile, SaveProfile::Solved) {
        RestoreClass::InitialConditionImport
    } else {
        RestoreClass::ConfigOnly
    };

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
    let preflight = preflight_fms(reader, &[])?;

    // Preflight has already checked all paths, limits, and content digests.
    for (name, data) in &preflight.documents {
        if name.starts_with("objects/sha256/") {
            store.cas().put(&data)?;
        } else {
            store.write_document(name, data)?;
        }
    }

    // Commit the session manifest.
    store.commit_session(&preflight.session)?;

    Ok(preflight.session)
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
    use std::io::{Cursor, Write};

    fn test_session() -> FmsSessionManifest {
        FmsSessionManifest::new("s-001", "Test", SaveProfile::Compact)
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
            .write_document("runs/run-001/run_manifest.json", b"{}")
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
            .write_document("runs/run-001/run_manifest.json", b"{}")
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
            .write_document("runs/run-001/run_manifest.json", b"{}")
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
            .write_document("runs/run-001/run_manifest.json", b"{}")
            .unwrap();
        let hash = store.cas().put(b"original CAS bytes").unwrap();
        let mut checkpoint = FmsCheckpoint::new("run-001", 0, 0.0, 1e-12);
        checkpoint.field_refs.push(FieldRef {
            name: "m".to_string(),
            role: FieldRole::Primary,
            tensor_descriptor_ref: hash.clone(),
        });
        store
            .write_document(
                "runs/run-001/checkpoints/cp-000000/checkpoint.json",
                &serde_json::to_vec(&checkpoint).unwrap(),
            )
            .unwrap();
        std::fs::write(
            store.root().join("objects/sha256").join(hash),
            b"tampered CAS bytes",
        )
        .unwrap();

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
        store.commit_session(&session).unwrap();
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
}
