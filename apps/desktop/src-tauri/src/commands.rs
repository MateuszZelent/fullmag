use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::{
    DocumentMode, DurabilityGuarantee, FileProjectRepository, ProjectApplication, ProjectSource,
    ProjectTarget, SaveProjectRequest,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
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

fn open_project_file(path: PathBuf) -> Result<ProjectOpenSummary, String> {
    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let opened = application
        .open(ProjectSource::Path(path.clone()))
        .map_err(|error| error.to_string())?;
    Ok(summary_from_view(&path, opened.view))
}

fn read_project_archive(path: &Path) -> Result<(ProjectOpenSummary, Vec<u8>), String> {
    // Validate the selected path through the repository adapter first.  This
    // rejects symlink/reparse-point chains before the bytes are handed to the
    // webview, while the second read preserves the original archive bytes for
    // a byte-faithful host Save.
    let summary = open_project_file(path.to_path_buf())?;
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
    Ok((summary, bytes))
}

/// Open a project definition through the same application/repository boundary
/// used by the CLI.  It never restores a runtime session or starts a solve.
#[tauri::command]
pub async fn open_project_path(path: String) -> Result<ProjectOpenSummary, String> {
    open_project_file(PathBuf::from(path))
}

#[tauri::command]
pub async fn open_project_dialog(app: AppHandle) -> Result<Option<ProjectOpenSummary>, String> {
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
    open_project_file(file_path).map(Some)
}

/// Open a project through the host file dialog and return the validated bytes
/// to the webview.  The path is retained only as a host-owned Save target; the
/// browser API never receives an arbitrary filesystem path.
#[tauri::command]
pub async fn open_project_archive_dialog(
    app: AppHandle,
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
    let (summary, bytes) = read_project_archive(&file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("fullmag-project.fms")
        .to_string();
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
        let candidate = incoming
            .current_document()
            .cloned()
            .ok_or_else(|| "project archive has no current document".to_string())?;
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
    save_project_archive_to_target(request, target)
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
    use super::{save_project_archive_to_target, ProjectSaveRequest};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use fullmag_application::{FileProjectRepository, ProjectEnvelope, ProjectId};
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
}
