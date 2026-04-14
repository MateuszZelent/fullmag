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

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::Path;

use anyhow::{Context, Result};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::store::SessionStore;
use crate::types::*;

/// Options controlling how the `.fms` file is written.
pub struct PackOptions {
    pub compression: CompressionProfile,
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

/// Inspect a `.fms` file without fully extracting it.
pub fn inspect_fms<R: Read + Seek>(reader: R) -> Result<SessionInspection> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let _total_size = archive
        .by_name("manifest/session.json")
        .map(|f| f.size())
        .unwrap_or(0);

    let session: FmsSessionManifest = read_json_entry(&mut archive, "manifest/session.json")
        .context("reading session manifest")?;

    // Try to find the latest checkpoint.
    let mut latest_cp: Option<CheckpointSummary> = None;
    for run_ref in &session.run_refs {
        let parts: Vec<&str> = run_ref.split('/').collect();
        if parts.len() >= 2 {
            let run_id = parts[1];
            // Scan for checkpoint directories.
            let prefix = format!("runs/{run_id}/checkpoints/");
            for i in 0..archive.len() {
                let entry = archive.by_index(i)?;
                let name = entry.name().to_string();
                if name.starts_with(&prefix) && name.ends_with("/checkpoint.json") {
                    drop(entry);
                    if let Ok(cp) = read_json_entry::<FmsCheckpoint, _>(&mut archive, &name) {
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
                }
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

    // Compute total size from all entries.
    let mut total_compressed = 0u64;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index_raw(i) {
            total_compressed += entry.compressed_size();
        }
    }

    Ok(SessionInspection {
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
        warnings: Vec::new(),
        total_size_bytes: total_compressed,
    })
}

/// Extract a `.fms` archive into a `SessionStore`.
pub fn unpack_fms<R: Read + Seek>(reader: R, store: &SessionStore) -> Result<FmsSessionManifest> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let session: FmsSessionManifest = read_json_entry(&mut archive, "manifest/session.json")?;

    // Extract all entries into the store.
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }

        if name.starts_with("objects/sha256/") {
            // CAS objects — put into CAS store directly.
            let mut data = Vec::new();
            entry.read_to_end(&mut data)?;
            store.cas().put(&data)?;
        } else {
            // Regular documents — write to store.
            let mut data = Vec::new();
            entry.read_to_end(&mut data)?;
            store.write_document(&name, &data)?;
        }
    }

    // Commit the session manifest.
    store.commit_session(&session)?;

    Ok(session)
}

fn read_json_entry<T: serde::de::DeserializeOwned, R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<T> {
    let mut entry = archive
        .by_name(name)
        .with_context(|| format!("entry `{name}` not found in archive"))?;
    let mut data = Vec::new();
    entry.read_to_end(&mut data)?;
    serde_json::from_slice(&data).with_context(|| format!("parsing JSON from `{name}`"))
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
    use std::io::Cursor;

    #[test]
    fn pack_inspect_unpack_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();

        // Prepare session.
        let session = FmsSessionManifest::new("s-001", "Test", SaveProfile::Compact);
        store.commit_session(&session).unwrap();

        let workspace = FmsWorkspaceManifest {
            workspace_id: "local-live".into(),
            problem_name: "test_problem".into(),
            project_ref: "project/".into(),
            ui_state_ref: "project/ui_state.json".into(),
            scene_document_ref: "project/scene_document.json".into(),
            script_builder_ref: None,
            model_builder_graph_ref: None,
            asset_index_ref: None,
        };
        let export_profile = FmsExportProfile::for_profile(SaveProfile::Compact);

        let mut docs = HashMap::new();
        docs.insert(
            "main.py".into(),
            b"# fullmag script\nprint('hello')".to_vec(),
        );
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
}
