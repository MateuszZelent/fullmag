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
use std::path::{Component, Path};

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
        let archive_path = if name.starts_with("project/") {
            name.clone()
        } else {
            format!("project/{name}")
        };
        zip.start_file(&archive_path, fopts)?;
        zip.write_all(data)?;
    }

    // ── runs/ ──────────────────────────────────────────────────────────
    for run_ref in &session.run_refs {
        // run_ref is like "runs/run-000001/run_manifest.json"
        if let Some(data) = store.read_document(run_ref)? {
            zip.start_file(run_ref, fopts)?;
            zip.write_all(&data)?;
        }

        // Extract run_id from path.
        let parts: Vec<&str> = run_ref.split('/').collect();
        if parts.len() >= 2 {
            let run_id = parts[1];
            pack_run_checkpoints(&mut zip, store, run_id, export_profile, fopts)?;
            if export_profile.include_artifacts() {
                pack_run_artifacts(&mut zip, store, run_id, fopts)?;
            }
        }
    }

    // ── objects/ ───────────────────────────────────────────────────────
    // Only include CAS objects that are referenced by packed checkpoints.
    let live_refs = store.collect_live_refs()?;
    for hash in &live_refs {
        if let Some(data) = store.cas().get(hash)? {
            let path = format!("objects/sha256/{hash}");
            // Use Stored for binary blobs — they're already compressed or incompressible.
            let blob_opts = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(true);
            zip.start_file(&path, blob_opts)?;
            zip.write_all(&data)?;
        }
    }

    zip.finish()?;
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
        let archive_path = if name.starts_with("project/") {
            name.clone()
        } else {
            // `documents` is a project-relative map by API contract.
            if name.starts_with('/') || name.starts_with('\\') {
                anyhow::bail!("unsafe project document path `{name}`");
            }
            format!("project/{name}")
        };
        validate_archive_path(&archive_path)?;
        if !archive_paths.insert(archive_path.clone()) {
            anyhow::bail!("duplicate archive path `{archive_path}`");
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

fn pack_run_checkpoints<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    store: &SessionStore,
    run_id: &str,
    profile: &FmsExportProfile,
    opts: SimpleFileOptions,
) -> Result<()> {
    // Only pack checkpoints if the profile warrants it.
    if !profile.needs_checkpoints() {
        return Ok(());
    }
    let cp_base = format!("runs/{run_id}/checkpoints");
    let cp_dir = store.root().join(&cp_base);
    if !cp_dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&cp_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let cp_name = entry.file_name();
            let cp_name = cp_name.to_string_lossy();
            // Pack all files in this checkpoint directory.
            for file_entry in std::fs::read_dir(entry.path())? {
                let file_entry = file_entry?;
                if file_entry.file_type()?.is_file() {
                    let fname = file_entry.file_name();
                    let fname = fname.to_string_lossy();
                    let archive_path = format!("{cp_base}/{cp_name}/{fname}");
                    let data = std::fs::read(file_entry.path())?;
                    zip.start_file(&archive_path, opts)?;
                    zip.write_all(&data)?;
                }
            }
        }
    }
    Ok(())
}

fn pack_run_artifacts<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    store: &SessionStore,
    run_id: &str,
    opts: SimpleFileOptions,
) -> Result<()> {
    let art_dir = store.root().join("runs").join(run_id).join("artifacts");
    if !art_dir.exists() {
        return Ok(());
    }
    pack_directory_recursive(zip, &art_dir, &format!("runs/{run_id}/artifacts"), opts)
}

fn pack_directory_recursive<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    dir: &Path,
    prefix: &str,
    opts: SimpleFileOptions,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let archive_path = format!("{prefix}/{name}");
        if entry.file_type()?.is_dir() {
            pack_directory_recursive(zip, &entry.path(), &archive_path, opts)?;
        } else {
            let data = std::fs::read(entry.path())?;
            zip.start_file(&archive_path, opts)?;
            zip.write_all(&data)?;
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
        validate_archive_path(required)?;
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

    if entry_count > MAX_ZIP_ENTRIES as u64 {
        anyhow::bail!("too many ZIP entries: {entry_count} exceeds {MAX_ZIP_ENTRIES}");
    }
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
    let mut total_uncompressed = 0u64;
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
        validate_archive_path(&name)?;
        if !seen_names.insert(name.clone()) {
            anyhow::bail!("duplicate ZIP entry `{name}`");
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
        total_uncompressed = total_uncompressed
            .checked_add(uncompressed_size)
            .context("uncompressed ZIP size overflow")?;
        if total_uncompressed > MAX_UNCOMPRESSED_ZIP_BYTES {
            anyhow::bail!(
                "uncompressed ZIP size exceeds {} bytes",
                MAX_UNCOMPRESSED_ZIP_BYTES
            );
        }
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

fn validate_archive_path(name: &str) -> Result<()> {
    let bytes = name.as_bytes();
    let has_windows_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if name.is_empty() || name.contains('\\') || has_windows_prefix {
        anyhow::bail!("unsafe archive path `{name}`");
    }
    let non_directory_name = name.strip_suffix('/').unwrap_or(name);
    if non_directory_name.is_empty()
        || non_directory_name
            .split('/')
            .any(|segment| segment.is_empty() || segment == ".")
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
    Ok(())
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
