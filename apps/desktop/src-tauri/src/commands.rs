use crate::{compute_probe, provenance, recent_index};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::{
    DocumentMode, DurabilityGuarantee, FileProjectRepository, OpaqueDocument, ProjectApplication,
    ProjectSource, ProjectTarget, SaveProjectRequest,
};
use crate::workspace_commands::{self, WorkspaceHost};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_PROJECT_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_base: String,
    pub ui_url: String,
    pub launch_intent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickedTextFile {
    pub path: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOpenSummary {
    pub path: String,
    pub project_id: String,
    pub schema_version: String,
    pub revision: u64,
    pub dirty: bool,
    pub mode: String,
    pub read_only_reason: Option<String>,
    pub source_hash: Option<String>,
    pub migrated: bool,
    pub can_write: bool,
    pub warnings: Vec<String>,
    pub preserved_paths: Vec<String>,
    pub runtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOpenArchive {
    pub path: String,
    pub file_name: String,
    pub archive_base64: String,
    pub summary: ProjectOpenSummary,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectSaveRequest {
    pub archive_base64: String,
    pub display_name: String,
    pub target_path: Option<String>,
    pub expected_project_id: Option<String>,
    pub expected_revision: Option<u64>,
    pub client_intent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSaveSummary {
    pub path: String,
    pub project_id: String,
    pub revision: u64,
    pub save_as: bool,
    pub durability: String,
    pub data_file_synced: bool,
    pub parent_directory_synced: bool,
    pub power_loss_qualified: bool,
}

/// The preview of a finished run: a PNG and the colour mapping it was drawn with.
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectOutcomePreview {
    pub png_base64: String,
    pub colouring: String,
}

/// A finished run to record in a project file: the run record (see
/// `provenance` for its fields) and, optionally, a preview thumbnail.
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectOutcomeRequest {
    pub path: String,
    pub run: Value,
    pub preview: Option<ProjectOutcomePreview>,
}

#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<PickedTextFile>, String> {
    let result = app
        .dialog()
        .file()
        .add_filter(
            "Simulation files",
            &["py", "json", "fm", "yaml", "yml", "txt"],
        )
        .blocking_pick_file();
    let Some(path) = result else {
        return Ok(None);
    };

    let file_path = path
        .into_path()
        .map_err(|_| "selected path is not available on this platform".to_string())?;
    let text = fs::read_to_string(&file_path)
        .map_err(|error| format!("failed to read {}: {error}", file_path.display()))?;
    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("selected_file")
        .to_string();

    Ok(Some(PickedTextFile {
        path: file_path.display().to_string(),
        name,
        text,
    }))
}

fn summary_from_view(path: &Path, view: fullmag_application::DocumentView) -> ProjectOpenSummary {
    let (mode, read_only_reason) = match view.mode {
        DocumentMode::ReadWrite => ("read_write".to_string(), None),
        DocumentMode::ReadOnly { reason } => ("read_only".to_string(), Some(reason)),
    };
    ProjectOpenSummary {
        path: path.display().to_string(),
        project_id: view.project_id.as_str().to_string(),
        schema_version: view.schema_version,
        revision: view.revision,
        dirty: view.dirty,
        mode,
        read_only_reason,
        source_hash: view.source_hash,
        migrated: view.migration.migrated,
        can_write: view.migration.can_write,
        warnings: view.migration.warnings,
        preserved_paths: view.migration.preserved_paths,
        runtime: "untouched".into(),
    }
}

/// The open summary and the project's own name (not the file stem), which the
/// workspace database records.
fn open_project_file(path: PathBuf) -> Result<(ProjectOpenSummary, String), String> {
    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let opened = application
        .open(ProjectSource::Path(path.clone()))
        .map_err(|error| error.to_string())?;
    let summary = summary_from_view(&path, opened.view);
    let name = application
        .current_document()
        .map(|document| document.definition.name.clone())
        .unwrap_or_default();
    Ok((summary, name))
}

/// Record, best effort, that a project was opened. The database can be locked,
/// damaged or read-only; that never stops a project from opening.
async fn mirror_project_open(
    app: &AppHandle,
    workspace: &WorkspaceHost,
    path: &Path,
    summary: &ProjectOpenSummary,
    name: &str,
) {
    let event = workspace_commands::project_open_event(
        path,
        &summary.project_id,
        Some(name).filter(|name| !name.trim().is_empty()),
        summary.revision,
        summary.mode == "read_only",
    );
    workspace_commands::mirror(workspace, workspace_commands::legacy_index_path(app), move |ws| {
        ws.record_best_effort(&event);
    })
    .await;
}

fn read_project_archive(path: &Path) -> Result<(ProjectOpenSummary, Vec<u8>, String), String> {
    // Validate the selected path through the repository adapter first.  This
    // rejects symlink/reparse-point chains before the bytes are handed to the
    // webview, while the second read preserves the original archive bytes for
    // a byte-faithful host Save.
    let (summary, name) = open_project_file(path.to_path_buf())?;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "project path is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_PROJECT_ARCHIVE_BYTES {
        return Err(format!(
            "project archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"
        ));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    Ok((summary, bytes, name))
}

/// Open a project definition through the same application/repository boundary
/// used by the CLI.  It never restores a runtime session or starts a solve.
#[tauri::command]
pub async fn open_project_path(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    path: String,
) -> Result<ProjectOpenSummary, String> {
    let file_path = PathBuf::from(path);
    let (summary, name) = open_project_file(file_path.clone())?;
    mirror_project_open(&app, workspace.inner(), &file_path, &summary, &name).await;
    Ok(summary)
}

#[tauri::command]
pub async fn open_project_dialog(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Option<ProjectOpenSummary>, String> {
    let result = app
        .dialog()
        .file()
        .add_filter("Fullmag project", &["fms"])
        .blocking_pick_file();
    let Some(path) = result else {
        return Ok(None);
    };
    let file_path = path
        .into_path()
        .map_err(|_| "selected project path is not available on this platform".to_string())?;
    let (summary, name) = open_project_file(file_path.clone())?;
    mirror_project_open(&app, workspace.inner(), &file_path, &summary, &name).await;
    Ok(Some(summary))
}

/// Select a results/temporary parent without creating or removing files.
#[tauri::command]
pub async fn pick_output_directory(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    selected
        .map(|path| {
            path.into_path()
                .map(|path| path.display().to_string())
                .map_err(|_| "selected directory is not a local filesystem path".to_string())
        })
        .transpose()
}

/// Open a project through the host file dialog and return the validated bytes
/// to the webview.  The path is retained only as a host-owned Save target; the
/// browser API never receives an arbitrary filesystem path.
#[tauri::command]
pub async fn open_project_archive_dialog(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Option<ProjectOpenArchive>, String> {
    let result = app
        .dialog()
        .file()
        .add_filter("Fullmag project", &["fms"])
        .blocking_pick_file();
    let Some(path) = result else {
        return Ok(None);
    };
    let file_path = path
        .into_path()
        .map_err(|_| "selected project path is not available on this platform".to_string())?;
    let (summary, bytes, name) = read_project_archive(&file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("fullmag-project.fms")
        .to_string();
    mirror_project_open(&app, workspace.inner(), &file_path, &summary, &name).await;
    Ok(Some(ProjectOpenArchive {
        path: file_path.display().to_string(),
        file_name,
        archive_base64: STANDARD.encode(bytes),
        summary,
    }))
}

fn decode_project_archive(request: &ProjectSaveRequest) -> Result<Vec<u8>, String> {
    if request.display_name.trim().is_empty() {
        return Err("project archive display_name must not be empty".into());
    }
    let bytes = STANDARD
        .decode(request.archive_base64.as_bytes())
        .map_err(|error| format!("invalid_project_archive_encoding: {error}"))?;
    if bytes.is_empty() {
        return Err("project archive must not be empty".into());
    }
    if bytes.len() as u64 > MAX_PROJECT_ARCHIVE_BYTES {
        return Err(format!(
            "project archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"
        ));
    }
    Ok(bytes)
}

fn save_summary(receipt: fullmag_application::SaveReceipt) -> ProjectSaveSummary {
    let (durability, data_file_synced, parent_directory_synced, power_loss_qualified) =
        match receipt.durability {
            DurabilityGuarantee::FilesystemSynced {
                data_file_synced,
                parent_directory_synced,
                power_loss_qualified,
            } => (
                "filesystem_synced".to_string(),
                data_file_synced,
                parent_directory_synced,
                power_loss_qualified,
            ),
            DurabilityGuarantee::MemoryOnly => ("memory_only".to_string(), false, false, false),
            DurabilityGuarantee::Unspecified => ("unspecified".to_string(), false, false, false),
        };
    ProjectSaveSummary {
        path: receipt.target.path().display().to_string(),
        project_id: receipt.project_id.as_str().to_string(),
        revision: receipt.revision,
        save_as: receipt.save_as,
        durability,
        data_file_synced,
        parent_directory_synced,
        power_loss_qualified,
    }
}

/// An opaque document of the file currently open in `application`.
fn stored_document(
    application: &ProjectApplication<FileProjectRepository>,
    path: &str,
) -> Option<OpaqueDocument> {
    application.current_document().and_then(|document| {
        document
            .opaque_documents
            .iter()
            .find(|stored| stored.path() == path)
            .cloned()
    })
}

fn save_project_archive_to_target(
    request: ProjectSaveRequest,
    target: PathBuf,
) -> Result<ProjectSaveSummary, String> {
    let bytes = decode_project_archive(&request)?;
    let mut incoming = ProjectApplication::new(FileProjectRepository::new());
    let opened = incoming
        .open(ProjectSource::Bytes {
            display_name: request.display_name.clone(),
            bytes,
        })
        .map_err(|error| error.to_string())?;
    if !opened.view.mode.is_writable() || !opened.view.migration.can_write {
        return Err(opened
            .view
            .migration
            .warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "project is read-only and cannot be saved".into()));
    }

    let existing = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "project target may not be a symlink: {}",
                    target.display()
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "reading project target {}: {error}",
                target.display()
            ))
        }
    };

    if !existing {
        let receipt = incoming
            .save_detached(
                ProjectTarget::Path(target),
                request.client_intent_id.clone(),
            )
            .map_err(|error| error.to_string())?;
        return Ok(save_summary(receipt));
    }

    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let opened_existing = application
        .open(ProjectSource::Path(target.clone()))
        .map_err(|error| error.to_string())?;
    let existing_view = opened_existing.view;
    if let Some(expected_project_id) = request.expected_project_id.as_deref() {
        if expected_project_id != existing_view.project_id.as_str() {
            return Err(format!(
                "project identity conflict: expected {expected_project_id}, found {}",
                existing_view.project_id.as_str()
            ));
        }
    }
    if let Some(expected_revision) = request.expected_revision {
        if expected_revision != existing_view.revision {
            return Err(format!(
                "project revision conflict: expected {expected_revision}, found {}",
                existing_view.revision
            ));
        }
    }
    if opened.view.project_id != existing_view.project_id {
        return Err("project identity conflict between archive and target".into());
    }
    let incoming_base_revision = opened
        .view
        .persisted_revision
        .unwrap_or(opened.view.revision);
    if incoming_base_revision != existing_view.revision {
        return Err(format!(
            "project archive is based on revision {incoming_base_revision}, but target is revision {}",
            existing_view.revision
        ));
    }
    if opened.view.source_hash != existing_view.source_hash {
        let mut candidate = incoming
            .current_document()
            .cloned()
            .ok_or_else(|| "project archive has no current document".to_string())?;
        // The save changes the project, so it is recorded. History comes from
        // the document already on disk: the archive the webview sends back can
        // predate earlier saves and must not overwrite them. `replace_draft`
        // advances the revision by one, which is the revision being recorded.
        let stored = stored_document(&application, provenance::PROVENANCE_PATH);
        provenance::stamp_envelope(
            &mut candidate,
            stored.as_ref(),
            &provenance::author_identity(),
            &recent_index::rfc3339_utc(std::time::SystemTime::now()),
            existing_view.revision.saturating_add(1),
        );
        // Only the host writes the thumbnail, so a webview archive without one
        // must not delete the stored one.
        provenance::carry_thumbnail(
            &mut candidate,
            stored_document(&application, recent_index::THUMBNAIL_PATH).as_ref(),
        );
        application
            .replace_draft(candidate, existing_view.revision)
            .map_err(|error| error.to_string())?;
    }
    let receipt = application
        .save(SaveProjectRequest {
            target: None,
            expected_revision: Some(existing_view.revision),
            client_intent_id: request.client_intent_id,
        })
        .map_err(|error| error.to_string())?;
    Ok(save_summary(receipt))
}

/// Persist a validated project archive through the same application and file
/// repository used by CLI/Python.  The dialog is host-owned when no target is
/// supplied; an existing target is revision- and identity-checked before it is
/// replaced.
#[tauri::command]
pub async fn save_project_archive(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    request: ProjectSaveRequest,
) -> Result<ProjectSaveSummary, String> {
    let target = match request.target_path.clone() {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        Some(_) => return Err("project target path must not be empty".into()),
        None => {
            let result = app
                .dialog()
                .file()
                .add_filter("Fullmag project", &["fms"])
                .set_file_name(request.display_name.clone())
                .blocking_save_file();
            let Some(path) = result else {
                return Err("project save cancelled".into());
            };
            path.into_path().map_err(|_| {
                "selected project path is not available on this platform".to_string()
            })?
        }
    };
    let saved = save_project_archive_to_target(request, target)?;
    let event = workspace_commands::project_save_event(
        Path::new(&saved.path),
        &saved.project_id,
        saved.revision,
        saved.save_as,
    );
    workspace_commands::mirror(
        workspace.inner(),
        workspace_commands::legacy_index_path(&app),
        move |ws| {
            ws.record_best_effort(&event);
        },
    )
    .await;
    Ok(saved)
}

/// Record a finished run, and optionally its preview thumbnail, in the project
/// file at `request.path`, as one revision-checked save. The run is upserted by
/// `run_id` and a history entry is appended; the preview replaces
/// `project/preview/thumb.png` and its colouring is stored in the provenance.
/// The file is left untouched when anything is invalid or damaged. Returns the
/// archive as now written, like opening it would.
fn record_project_outcome(
    request: ProjectOutcomeRequest,
    identity: &Value,
    at: &str,
) -> Result<ProjectOpenArchive, String> {
    let preview = match &request.preview {
        Some(preview) => {
            let png = STANDARD
                .decode(preview.png_base64.as_bytes())
                .map_err(|error| format!("invalid_preview_encoding: {error}"))?;
            provenance::validate_preview(&png, &preview.colouring)?;
            Some((png, preview.colouring.as_str()))
        }
        None => None,
    };
    let run_id = request
        .run
        .get("run_id")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let target = PathBuf::from(&request.path);
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| format!("reading project {}: {error}", target.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "project path may not be a symlink: {}",
            target.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "project path is not a regular file: {}",
            target.display()
        ));
    }
    if metadata.len() > MAX_PROJECT_ARCHIVE_BYTES {
        return Err(format!(
            "project archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"
        ));
    }

    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let view = application
        .open(ProjectSource::Path(target.clone()))
        .map_err(|error| error.to_string())?
        .view;
    if !view.mode.is_writable() || !view.migration.can_write {
        return Err(view
            .migration
            .warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "project is read-only and cannot record runs".into()));
    }

    let mut candidate = application
        .current_document()
        .cloned()
        .ok_or_else(|| "project has no current document".to_string())?;
    // `replace_draft` advances the revision by one: that is the revision recorded.
    let stored = stored_document(&application, provenance::PROVENANCE_PATH);
    let mut bytes = provenance::record_run(
        stored.as_ref().map(OpaqueDocument::bytes),
        &request.run,
        identity,
        at,
        view.revision.saturating_add(1),
    )?;
    if let Some((png, colouring)) = preview {
        bytes = provenance::record_preview(&bytes, colouring, run_id, at)?;
        provenance::set_document(&mut candidate, recent_index::THUMBNAIL_PATH, png)?;
    }
    provenance::set_document(&mut candidate, provenance::PROVENANCE_PATH, bytes)?;

    application
        .replace_draft(candidate, view.revision)
        .map_err(|error| error.to_string())?;
    application
        .save(SaveProjectRequest {
            target: None,
            expected_revision: Some(view.revision),
            client_intent_id: None,
        })
        .map_err(|error| error.to_string())?;

    let (summary, archive, _) = read_project_archive(&target)?;
    Ok(ProjectOpenArchive {
        path: target.display().to_string(),
        file_name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("fullmag-project.fms")
            .to_string(),
        archive_base64: STANDARD.encode(archive),
        summary,
    })
}

/// Record a finished run and its preview in the project file; see
/// `record_project_outcome`. Runs off the async executor: it reads and writes
/// the archive and looks up the author through git.
#[tauri::command]
pub async fn project_record_outcome(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    request: ProjectOutcomeRequest,
) -> Result<ProjectOpenArchive, String> {
    let run = request.run.clone();
    let now = std::time::SystemTime::now();
    let archive = tauri::async_runtime::spawn_blocking(move || {
        record_project_outcome(
            request,
            &provenance::author_identity(),
            &recent_index::rfc3339_utc(now),
        )
    })
    .await
    .map_err(|error| format!("recording the run was interrupted: {error}"))??;

    // Best effort: the database must never fail a recorded run. The run event
    // updates the item's use and `last_run`; the refresh re-reads the archive so
    // a fresh thumbnail and summary appear without a rescan.
    let path = PathBuf::from(&archive.path);
    let event = workspace_commands::project_run_event(
        &path,
        &archive.summary.project_id,
        &run,
        archive.summary.revision,
        &recent_index::rfc3339_utc(now),
    );
    workspace_commands::mirror(
        workspace.inner(),
        workspace_commands::legacy_index_path(&app),
        move |ws| {
            ws.record_best_effort(&event);
            let _ = recent_index::refresh_project(ws, &path);
        },
    )
    .await;
    Ok(archive)
}

/// Locations scanned on rebuild: `FULLMAG_PROJECT_ROOTS` (path-list syntax of
/// the platform), the roots the last scan used, and `<Documents>/Fullmag`.
fn recent_project_roots(documents: Option<PathBuf>, previous: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(configured) = std::env::var_os("FULLMAG_PROJECT_ROOTS") {
        roots.extend(std::env::split_paths(&configured));
    }
    roots.extend(previous);
    if let Some(documents) = documents {
        roots.push(documents.join("Fullmag"));
    }
    let mut seen = std::collections::HashSet::new();
    roots.retain(|root| seen.insert(root.clone()));
    roots
}

/// What this desktop build is, for the About page and bug reports.
#[tauri::command]
pub fn app_build_info() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "project_schema": fullmag_application::CURRENT_PROJECT_SCHEMA,
    })
}

/// Who the user is, for the start screen's greeting: git config, then the OS user.
#[tauri::command]
pub async fn author_identity() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(provenance::author_identity)
        .await
        .map_err(|error| format!("identity lookup was interrupted: {error}"))
}

/// Authors, citation, history and runs of the archive at `path`, read lazily
/// when the inspector opens a provenance tab.
#[tauri::command]
pub async fn project_provenance_read(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || provenance::read_from_archive(Path::new(&path)))
        .await
        .map_err(|error| format!("provenance read was interrupted: {error}"))?
}

/// GPU, CUDA, VRAM and CPU threads for the start screen's rail. Runs off the
/// async executor because it spawns `nvidia-smi`.
#[tauri::command]
pub async fn compute_probe() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(compute_probe::probe)
        .await
        .map_err(|error| format!("compute probe was interrupted: {error}"))
}

/// The recent-project list, a view of the workspace database's projects in
/// the shape of `recent-index.schema.json`.
#[tauri::command]
pub async fn recent_index_read(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Value, String> {
    workspace_commands::run(
        workspace.inner().clone(),
        workspace_commands::legacy_index_path(&app),
        |ws, _| recent_index::read_index(ws),
    )
    .await
}

/// Rescan the project locations. Runs off the async executor: it walks the
/// file system and opens every archive it finds.
#[tauri::command]
pub async fn recent_index_rebuild(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Value, String> {
    let documents = app.path().document_dir().ok();
    workspace_commands::run(
        workspace.inner().clone(),
        workspace_commands::legacy_index_path(&app),
        move |ws, _| {
            let roots = recent_project_roots(documents, recent_index::stored_roots(ws));
            recent_index::rebuild_index(ws, &roots, std::time::SystemTime::now())
        },
    )
    .await
}

#[tauri::command]
pub async fn recent_index_pin(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    project_id: String,
    pinned: bool,
) -> Result<Value, String> {
    workspace_commands::run(
        workspace.inner().clone(),
        workspace_commands::legacy_index_path(&app),
        move |ws, _| recent_index::set_pinned(ws, &project_id, pinned),
    )
    .await
}

/// Removes the row from the list only; the project file is never touched.
#[tauri::command]
pub async fn recent_index_forget(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    project_id: String,
) -> Result<Value, String> {
    workspace_commands::run(
        workspace.inner().clone(),
        workspace_commands::legacy_index_path(&app),
        move |ws, _| recent_index::forget(ws, &project_id),
    )
    .await
}

/// Read an archive the index points at and return the validated bytes, the
/// same way the file dialog does, so the webview never receives a free path.
#[tauri::command]
pub async fn open_project_archive_path(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    path: String,
) -> Result<ProjectOpenArchive, String> {
    let file_path = PathBuf::from(&path);
    let (summary, bytes, name) = read_project_archive(&file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("fullmag-project.fms")
        .to_string();
    // Best effort: the database must never stop a project from opening.
    mirror_project_open(&app, workspace.inner(), &file_path, &summary, &name).await;
    Ok(ProjectOpenArchive {
        path: file_path.display().to_string(),
        file_name,
        archive_base64: STANDARD.encode(bytes),
        summary,
    })
}

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    let open_target = if target.is_dir() {
        target
    } else {
        target.parent().unwrap_or(target)
    };

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(open_target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(open_target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_app_config(app: AppHandle) -> AppConfig {
    app.state::<AppConfig>().inner().clone()
}

#[cfg(test)]
mod tests {
    use super::{
        record_project_outcome, save_project_archive_to_target, ProjectOutcomePreview,
        ProjectOutcomeRequest, ProjectSaveRequest,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use fullmag_application::{FileProjectRepository, ProjectEnvelope, ProjectId};
    use fullmag_application::{ProjectApplication, ProjectRepository, ProjectSource};
    use serde_json::json;
    use tempfile::tempdir;

    fn request(archive_base64: String, target_path: String) -> ProjectSaveRequest {
        ProjectSaveRequest {
            archive_base64,
            display_name: "desktop.fms".into(),
            target_path: Some(target_path),
            expected_project_id: None,
            expected_revision: None,
            client_intent_id: Some("test-desktop-save".into()),
        }
    }

    #[test]
    fn detached_host_save_uses_the_application_writer_and_reports_sync() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("desktop.fms");
        let envelope =
            ProjectEnvelope::blank(ProjectId::parse("project-desktop").unwrap(), "Desktop")
                .unwrap();
        let archive = FileProjectRepository::new()
            .encode_archive(&envelope)
            .unwrap();
        let result = save_project_archive_to_target(
            request(STANDARD.encode(archive), target.display().to_string()),
            target.clone(),
        )
        .unwrap();

        assert!(target.is_file());
        assert_eq!(result.project_id, "project-desktop");
        assert_eq!(result.revision, 0);
        assert_eq!(result.durability, "filesystem_synced");
        assert!(result.data_file_synced);
        assert!(!result.power_loss_qualified);
    }

    #[test]
    fn host_save_rejects_a_stale_existing_target_before_publication() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("desktop.fms");
        let repository = FileProjectRepository::new();
        let envelope =
            ProjectEnvelope::blank(ProjectId::parse("project-desktop").unwrap(), "Desktop")
                .unwrap();
        let archive = repository.encode_archive(&envelope).unwrap();
        let first = request(
            STANDARD.encode(archive.clone()),
            target.display().to_string(),
        );
        save_project_archive_to_target(first, target.clone()).unwrap();

        let mut stale = request(STANDARD.encode(archive), target.display().to_string());
        stale.expected_project_id = Some("project-desktop".into());
        stale.expected_revision = Some(99);
        let error = save_project_archive_to_target(stale, target).unwrap_err();
        assert!(error.contains("revision conflict"));
    }

    #[test]
    fn host_save_replaces_an_existing_target_and_reports_the_new_revision() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("desktop.fms");
        let repository = FileProjectRepository::new();
        let envelope =
            ProjectEnvelope::blank(ProjectId::parse("project-desktop").unwrap(), "Desktop")
                .unwrap();
        let archive = repository.encode_archive(&envelope).unwrap();
        save_project_archive_to_target(
            request(STANDARD.encode(archive), target.display().to_string()),
            target.clone(),
        )
        .unwrap();

        let mut updated =
            ProjectEnvelope::blank(ProjectId::parse("project-desktop").unwrap(), "Updated")
                .unwrap();
        updated.rewrite_known_fields().unwrap();
        let updated_archive = repository.encode_archive(&updated).unwrap();
        let mut update_request = request(
            STANDARD.encode(updated_archive),
            target.display().to_string(),
        );
        update_request.expected_project_id = Some("project-desktop".into());
        update_request.expected_revision = Some(0);

        let result = save_project_archive_to_target(update_request, target).unwrap();
        assert_eq!(result.project_id, "project-desktop");
        assert_eq!(result.revision, 1);
    }

    #[test]
    fn changed_saves_append_history_taken_from_the_file_on_disk() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("history.fms");
        let repository = FileProjectRepository::new();
        let id = || ProjectId::parse("project-history").unwrap();

        let first = ProjectEnvelope::blank(id(), "First").unwrap();
        save_project_archive_to_target(
            request(
                STANDARD.encode(repository.encode_archive(&first).unwrap()),
                target.display().to_string(),
            ),
            target.clone(),
        )
        .unwrap();
        // A new file records nothing: it has no earlier state to differ from.
        assert!(
            crate::provenance::read_from_archive(&target).unwrap()["history"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let mut second = ProjectEnvelope::blank(id(), "Second").unwrap();
        second.rewrite_known_fields().unwrap();
        let mut save = request(
            STANDARD.encode(repository.encode_archive(&second).unwrap()),
            target.display().to_string(),
        );
        save.expected_project_id = Some("project-history".into());
        save.expected_revision = Some(0);
        assert_eq!(
            save_project_archive_to_target(save, target.clone())
                .unwrap()
                .revision,
            1
        );

        // The archive a webview holds after that save predates it: it carries no
        // provenance. The history on disk must survive the next save anyway.
        let mut third = ProjectEnvelope::blank(id(), "Third").unwrap();
        third.definition.revision = 1;
        third.rewrite_known_fields().unwrap();
        let mut save = request(
            STANDARD.encode(repository.encode_archive(&third).unwrap()),
            target.display().to_string(),
        );
        save.expected_project_id = Some("project-history".into());
        save.expected_revision = Some(1);
        assert_eq!(
            save_project_archive_to_target(save, target.clone())
                .unwrap()
                .revision,
            2
        );

        let provenance = crate::provenance::read_from_archive(&target).unwrap();
        let revisions: Vec<u64> = provenance["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["revision"].as_u64().unwrap())
            .collect();
        assert_eq!(revisions, vec![1, 2]);
        assert_eq!(provenance["history"][0]["summary"], "Saved revision 1");
    }

    fn tiny_png() -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(b"not really image data");
        png
    }

    fn outcome(path: &std::path::Path, run_id: &str, with_preview: bool) -> ProjectOutcomeRequest {
        ProjectOutcomeRequest {
            path: path.display().to_string(),
            run: json!({
                "run_id": run_id,
                "started_at": "2026-10-04T10:00:00Z",
                "finished_at": "2026-10-04T10:05:00Z",
                "status": "ready",
                "frames": 12
            }),
            preview: with_preview.then(|| ProjectOutcomePreview {
                png_base64: STANDARD.encode(tiny_png()),
                colouring: "hsl-sphere".into(),
            }),
        }
    }

    #[test]
    fn recording_an_outcome_writes_run_history_and_thumbnail_and_survives_a_stale_save() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("outcome.fms");
        let repository = FileProjectRepository::new();
        let id = || ProjectId::parse("project-outcome").unwrap();
        let first = ProjectEnvelope::blank(id(), "First").unwrap();
        save_project_archive_to_target(
            request(
                STANDARD.encode(repository.encode_archive(&first).unwrap()),
                target.display().to_string(),
            ),
            target.clone(),
        )
        .unwrap();

        let identity = json!({"name": "Anna"});
        let archive = record_project_outcome(
            outcome(&target, "run-1", true),
            &identity,
            "2026-10-04T10:06:00Z",
        )
        .unwrap();
        // Exactly one revision, and the returned archive reopens at it.
        assert_eq!(archive.summary.revision, 1);
        let mut reopened = ProjectApplication::new(FileProjectRepository::new());
        let view = reopened
            .open(ProjectSource::Bytes {
                display_name: archive.file_name.clone(),
                bytes: STANDARD.decode(&archive.archive_base64).unwrap(),
            })
            .unwrap()
            .view;
        assert_eq!(view.revision, 1);
        assert!(reopened
            .current_document()
            .unwrap()
            .opaque_documents
            .iter()
            .any(
                |document| document.path() == crate::recent_index::THUMBNAIL_PATH
                    && document.bytes() == tiny_png().as_slice()
            ));

        let provenance = crate::provenance::read_from_archive(&target).unwrap();
        assert_eq!(provenance["runs"][0]["run_id"], "run-1");
        assert_eq!(provenance["runs"][0]["frames"], 12);
        assert_eq!(provenance["history"][0]["kind"], "run");
        assert_eq!(provenance["history"][0]["revision"], 1);
        assert_eq!(provenance["history"][0]["by"], "Anna");
        assert_eq!(provenance["preview"]["colouring"], "hsl-sphere");
        assert_eq!(provenance["preview"]["run_id"], "run-1");

        // A second run of the same id replaces it; the revision moves by one.
        let archive = record_project_outcome(
            outcome(&target, "run-1", false),
            &identity,
            "2026-10-04T10:07:00Z",
        )
        .unwrap();
        assert_eq!(archive.summary.revision, 2);
        let provenance = crate::provenance::read_from_archive(&target).unwrap();
        assert_eq!(provenance["runs"].as_array().unwrap().len(), 1);
        assert_eq!(provenance["history"].as_array().unwrap().len(), 2);

        // The archive a webview holds knows nothing of runs or the thumbnail.
        let mut stale = ProjectEnvelope::blank(id(), "Edited").unwrap();
        stale.definition.revision = 2;
        stale.rewrite_known_fields().unwrap();
        let mut save = request(
            STANDARD.encode(repository.encode_archive(&stale).unwrap()),
            target.display().to_string(),
        );
        save.expected_project_id = Some("project-outcome".into());
        save.expected_revision = Some(2);
        assert_eq!(
            save_project_archive_to_target(save, target.clone())
                .unwrap()
                .revision,
            3
        );

        let provenance = crate::provenance::read_from_archive(&target).unwrap();
        assert_eq!(provenance["runs"].as_array().unwrap().len(), 1);
        assert_eq!(provenance["history"].as_array().unwrap().len(), 3);
        assert_eq!(provenance["history"][2]["summary"], "Saved revision 3");
        assert_eq!(provenance["preview"]["colouring"], "hsl-sphere");
        let stored = repository
            .open(ProjectSource::Path(target))
            .unwrap()
            .envelope;
        assert!(stored
            .opaque_documents
            .iter()
            .any(|document| document.path() == crate::recent_index::THUMBNAIL_PATH));
    }

    #[test]
    fn an_invalid_outcome_leaves_the_file_untouched() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("untouched.fms");
        let envelope =
            ProjectEnvelope::blank(ProjectId::parse("project-untouched").unwrap(), "Untouched")
                .unwrap();
        let archive = FileProjectRepository::new()
            .encode_archive(&envelope)
            .unwrap();
        save_project_archive_to_target(
            request(STANDARD.encode(archive), target.display().to_string()),
            target.clone(),
        )
        .unwrap();
        let before = std::fs::read(&target).unwrap();

        let mut bad_run = outcome(&target, "r", false);
        bad_run.run = json!({"run_id": "r", "status": "melted"});
        assert!(record_project_outcome(bad_run, &json!({}), "t").is_err());
        let mut bad_preview = outcome(&target, "r", true);
        bad_preview.preview.as_mut().unwrap().colouring = "rainbow".into();
        assert!(record_project_outcome(bad_preview, &json!({}), "t").is_err());
        let missing = outcome(&directory.path().join("absent.fms"), "r", false);
        assert!(record_project_outcome(missing, &json!({}), "t").is_err());

        assert_eq!(std::fs::read(&target).unwrap(), before);
    }
}
