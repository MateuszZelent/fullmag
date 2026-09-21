//! Runtime-free project document transport.
//!
//! The handler deliberately creates a short-lived application aggregate for
//! each request. It validates/reads/encodes `.fms` bytes through the single
//! `fullmag-application` repository adapter, but never opens a runtime session,
//! starts preparation, or publishes a filesystem target.

use axum::{http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::{
    CreateProjectRequest, DocumentMode, FileProjectRepository, ProjectApplication, ProjectSource,
};

use crate::error::ApiError;
use crate::schemas::projects::{
    ProjectArchiveDurability, ProjectArchiveRequest, ProjectCreateRequest, ProjectDocumentMode,
    ProjectDocumentResource, ProjectMigrationResource, PROJECT_ARCHIVE_MAX_BYTES,
};

#[utoipa::path(
    post,
    path = "/v2/persistence/projects",
    request_body = ProjectCreateRequest,
    responses(
        (status = 201, description = "Created runtime-free project document bytes", body = ProjectDocumentResource),
        (status = 400, description = "Invalid project name or archive encoding")
    ),
    tag = "persistence"
)]
pub async fn create(
    Json(request): Json<ProjectCreateRequest>,
) -> Result<(StatusCode, Json<ProjectDocumentResource>), ApiError> {
    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let view = application
        .create(CreateProjectRequest::new(request.name))
        .map_err(|error| ApiError::bad_request(format!("invalid_project_document: {error}")))?;
    let archive = encode_current(&application)?;
    Ok((
        StatusCode::CREATED,
        Json(resource_from_application(&application, view, archive)?),
    ))
}

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/open",
    request_body = ProjectArchiveRequest,
    responses(
        (status = 200, description = "Opened and validated runtime-free project document", body = ProjectDocumentResource),
        (status = 400, description = "Invalid or unsupported project archive")
    ),
    tag = "persistence"
)]
pub async fn open(
    Json(request): Json<ProjectArchiveRequest>,
) -> Result<Json<ProjectDocumentResource>, ApiError> {
    let source_bytes = decode_archive(&request)?;
    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let opened = application
        .open(ProjectSource::Bytes {
            display_name: request.display_name,
            bytes: source_bytes.clone(),
        })
        .map_err(|error| ApiError::bad_request(format!("invalid_project_document: {error}")))?;
    // Unknown schemas stay read-only and must be returned byte-for-byte. A
    // writable migration may publish canonical archive bytes in memory;
    // neither branch claims durable publication.
    let archive = if opened.view.mode.is_writable() {
        encode_current(&application)?
    } else {
        source_bytes
    };
    Ok(Json(resource_from_application(
        &application,
        opened.view,
        archive,
    )?))
}

fn decode_archive(request: &ProjectArchiveRequest) -> Result<Vec<u8>, ApiError> {
    if request.display_name.trim().is_empty() {
        return Err(ApiError::bad_request(
            "project archive display_name must not be empty",
        ));
    }
    let bytes = STANDARD
        .decode(request.archive_base64.as_bytes())
        .map_err(|error| {
            ApiError::bad_request(format!("invalid_project_archive_encoding: {error}"))
        })?;
    if bytes.len() > PROJECT_ARCHIVE_MAX_BYTES {
        return Err(ApiError::bad_request(format!(
            "project archive exceeds {} byte transport limit",
            PROJECT_ARCHIVE_MAX_BYTES
        )));
    }
    Ok(bytes)
}

fn encode_current(
    application: &ProjectApplication<FileProjectRepository>,
) -> Result<Vec<u8>, ApiError> {
    let document = application
        .current_document()
        .ok_or_else(|| ApiError::internal("project application has no current document"))?;
    FileProjectRepository::new()
        .encode_archive(document)
        .map_err(|error| ApiError::bad_request(format!("project archive is not writable: {error}")))
}

fn resource_from_application(
    application: &ProjectApplication<FileProjectRepository>,
    view: fullmag_application::DocumentView,
    archive: Vec<u8>,
) -> Result<ProjectDocumentResource, ApiError> {
    let name = application
        .current_document()
        .map(|document| document.definition.name.clone())
        .ok_or_else(|| ApiError::internal("project application lost current document"))?;
    let mode = match view.mode {
        DocumentMode::ReadWrite => ProjectDocumentMode::ReadWrite,
        DocumentMode::ReadOnly { reason } => ProjectDocumentMode::ReadOnly { reason },
    };
    Ok(ProjectDocumentResource {
        project_id: view.project_id.as_str().to_string(),
        name,
        schema_version: view.schema_version,
        revision: view.revision,
        persisted_revision: view.persisted_revision,
        dirty: view.dirty,
        mode,
        source_hash: view.source_hash,
        migration: ProjectMigrationResource {
            source_schema: view.migration.source_schema,
            target_schema: view.migration.target_schema,
            migrated: view.migration.migrated,
            can_write: view.migration.can_write,
            warnings: view.migration.warnings,
            preserved_paths: view.migration.preserved_paths,
        },
        archive_base64: STANDARD.encode(archive),
        durability: ProjectArchiveDurability::MemoryOnly,
    })
}
