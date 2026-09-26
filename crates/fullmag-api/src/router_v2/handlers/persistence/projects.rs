//! Project document transport and explicit immutable run submission.
//!
//! The handler deliberately creates a short-lived application aggregate for
//! each request. It validates/reads/encodes `.fms` bytes through the single
//! `fullmag-application` repository adapter, but never opens a runtime session,
//! starts preparation, or publishes a filesystem target. Submit durably
//! records an accepted intent without scheduling a worker.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::{
    CreateProjectRequest, DocumentMode, FileProjectRepository, ProjectApplication, ProjectId,
    ProjectSource, RunId, RunIntent, RunSpecification, SubmitDisposition,
};
use fullmag_authoring::StudyPlan;
use fullmag_plan::StudyProblemCatalog;
use std::path::Path as FsPath;
use std::sync::Arc;

use crate::error::ApiError;
use crate::schemas::projects::{
    ProjectArchiveDurability, ProjectArchiveRequest, ProjectCreateRequest, ProjectDocumentMode,
    ProjectDocumentResource, ProjectMigrationResource, ProjectRunCatalogState,
    ProjectRunExecutionState, ProjectRunListQuery, ProjectRunListResource,
    ProjectRunMaterializationResource, ProjectRunRequestedExecutionResource, ProjectRunResource,
    ProjectRunSubmitDisposition, ProjectRunSubmitRequest, ProjectRunSubmitResource,
    ProjectRunSummaryResource, ProjectRunTaskCancellationDisposition,
    ProjectRunTaskCancellationRequest, ProjectRunTaskCancellationResource, ProjectRunTaskLifecycle,
    ProjectRunTaskResource, PROJECT_ARCHIVE_MAX_BYTES,
};
use crate::types::AppState;

fn map_run_store_error(
    error: anyhow::Error,
    otherwise: impl FnOnce(anyhow::Error) -> ApiError,
) -> ApiError {
    if error.is::<fullmag_session::StoreWriterBusy>() {
        ApiError::conflict_with_code(
            "run_store_busy",
            "run storage has an active writer; retry the same request after it completes",
        )
    } else {
        otherwise(error)
    }
}

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/{project_id}/runs",
    params(("project_id" = String, Path, description = "Pinned project identity")),
    request_body = ProjectRunSubmitRequest,
    responses(
        (status = 201, description = "Durable run intent accepted", body = ProjectRunSubmitResource),
        (status = 200, description = "Identical submit replayed", body = ProjectRunSubmitResource),
        (status = 400, description = "Invalid immutable submission inputs"),
        (status = 409, description = "Project identity or idempotency conflict")
    ),
    tag = "persistence"
)]
pub async fn submit_run(
    Path(project_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectRunSubmitRequest>,
) -> Result<(StatusCode, Json<ProjectRunSubmitResource>), ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let archive = STANDARD
        .decode(request.archive_base64.as_bytes())
        .map_err(|error| {
            ApiError::bad_request(format!("invalid_project_archive_encoding: {error}"))
        })?;
    if archive.len() > PROJECT_ARCHIVE_MAX_BYTES {
        return Err(ApiError::bad_request(format!(
            "project archive exceeds {} byte transport limit",
            PROJECT_ARCHIVE_MAX_BYTES
        )));
    }
    let intent: RunIntent = serde_json::from_value(serde_json::Value::Object(
        request.run_intent.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_run_intent: {error}")))?;
    let study: StudyPlan = serde_json::from_value(serde_json::Value::Object(
        request.study_plan.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_study_plan: {error}")))?;
    let catalog: StudyProblemCatalog = serde_json::from_value(serde_json::Value::Object(
        request.study_problem_catalog.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_study_problem_catalog: {error}")))?;
    if intent.specification.snapshot.project_id != project_id {
        return Err(ApiError::conflict(
            "run snapshot project_id differs from request path",
        ));
    }
    let asset_paths = request.asset_paths;
    let (accepted, materialized) = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        let store = fullmag_session::SessionStore::open(store_root).map_err(|error| {
            map_run_store_error(error, |error| ApiError::internal(error.to_string()))
        })?;
        let result = crate::run_intent_persistence::commit_archived_run_intent(
            &store,
            &intent,
            &archive,
            &study,
            &catalog,
            &asset_paths,
        );
        if result.is_err()
            && intent.validate().is_ok()
            && store
                .find_run_intent(&intent.idempotency_key)
                .map_err(|error| ApiError::internal(error.to_string()))?
                .is_some_and(|existing| {
                    intent
                        .payload_fingerprint()
                        .is_ok_and(|fingerprint| existing.payload_sha256 != fingerprint)
                })
        {
            return Err(ApiError::conflict(
                "idempotency key was accepted for another run specification",
            ));
        }
        let accepted = result.map_err(|error| {
            map_run_store_error(error, |error| {
                ApiError::bad_request(format!("invalid_run_submission: {error:#}"))
            })
        })?;
        let materialized = store
            .read_run_catalog(accepted.run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?
            .is_some();
        Ok((accepted, materialized))
    })
    .await
    .map_err(|error| ApiError::internal(format!("run submission task failed: {error}")))??;
    let (status, disposition) = match accepted.disposition {
        SubmitDisposition::Accepted => (StatusCode::CREATED, ProjectRunSubmitDisposition::Accepted),
        SubmitDisposition::Replayed => (StatusCode::OK, ProjectRunSubmitDisposition::Replayed),
    };
    Ok((
        status,
        Json(ProjectRunSubmitResource {
            disposition,
            execution_state: if materialized {
                ProjectRunExecutionState::PendingPreparation
            } else {
                ProjectRunExecutionState::PendingMaterialization
            },
            run_id: accepted.run_id.as_str().into(),
            payload_fingerprint: accepted.payload_fingerprint,
        }),
    ))
}

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/materialization",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity")
    ),
    responses(
        (status = 200, description = "Idempotent durable task catalog materialization", body = ProjectRunMaterializationResource),
        (status = 400, description = "Immutable study cannot be materialized"),
        (status = 404, description = "Accepted run intent is missing"),
        (status = 409, description = "Run belongs to another project")
    ),
    tag = "persistence"
)]
pub async fn materialize_run(
    Path((project_id, run_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProjectRunMaterializationResource>, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let run_id = RunId::parse(run_id)
        .map_err(|error| ApiError::bad_request(format!("invalid run_id: {error}")))?;
    let catalog = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        let store = open_existing_run_store(store_root)?;
        let intent = store
            .read_run_intent(run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("accepted run intent is missing"))?;
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .map_err(|error| ApiError::bad_request(format!("invalid accepted RunSpec: {error}")))?;
        if specification.snapshot.project_id != project_id {
            return Err(ApiError::conflict("run belongs to another project"));
        }
        crate::run_intent_persistence::materialize_accepted_run_catalog(
            &store,
            run_id.as_str(),
            &project_id,
        )
        .map_err(|error| {
            map_run_store_error(error, |error| {
                ApiError::bad_request(format!("run_materialization_failed: {error:#}"))
            })
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("run materialization task failed: {error}")))??;
    Ok(Json(ProjectRunMaterializationResource {
        run_id: catalog.run_id,
        catalog_revision: catalog.revision,
        task_ids: catalog.tasks.into_iter().map(|task| task.task_id).collect(),
        execution_state: ProjectRunExecutionState::PendingPreparation,
    }))
}

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/tasks/{task_id}/cancellation",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity"),
        ("task_id" = String, Path, description = "Exact durable task identity")
    ),
    request_body = ProjectRunTaskCancellationRequest,
    responses(
        (status = 202, description = "Durable Stop command accepted", body = ProjectRunTaskCancellationResource),
        (status = 200, description = "Identical Stop command replayed", body = ProjectRunTaskCancellationResource),
        (status = 400, description = "Invalid task identity or cancellation reason"),
        (status = 404, description = "Accepted run intent is missing"),
        (status = 409, description = "Task is not running or a conflicting cancellation exists")
    ),
    tag = "persistence"
)]
pub async fn cancel_run_task(
    Path((project_id, run_id, task_id)): Path<(String, String, String)>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectRunTaskCancellationRequest>,
) -> Result<(StatusCode, Json<ProjectRunTaskCancellationResource>), ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let run_id = RunId::parse(run_id)
        .map_err(|error| ApiError::bad_request(format!("invalid run_id: {error}")))?;
    let task_id = fullmag_application::TaskId::parse(task_id)
        .map_err(|error| ApiError::bad_request(format!("invalid task_id: {error}")))?;
    if request.reason.trim().is_empty() {
        return Err(ApiError::bad_request(
            "cancellation reason must not be empty",
        ));
    }
    let response_run_id = run_id.as_str().to_owned();
    let response_task_id = task_id.as_str().to_owned();
    let reason = request.reason;
    let result = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        let store = open_existing_run_store(store_root)?;
        let intent = store
            .read_run_intent(run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("accepted run intent is missing"))?;
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .map_err(|error| ApiError::internal(format!("invalid durable RunSpec: {error}")))?;
        if specification.snapshot.project_id != project_id {
            return Err(ApiError::conflict("run belongs to another project"));
        }
        fullmag_runtime_control::request_accepted_task_stop(
            &store,
            &run_id,
            task_id.as_str(),
            &reason,
        )
        .map_err(|error| {
            map_run_store_error(error, |error| {
                ApiError::conflict_with_code("run_task_cancel_rejected", format!("{error:#}"))
            })
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("run cancellation task failed: {error}")))??;
    let (status, disposition) = match result.disposition {
        fullmag_runtime_control::AcceptedTaskStopDisposition::Accepted => (
            StatusCode::ACCEPTED,
            ProjectRunTaskCancellationDisposition::Accepted,
        ),
        fullmag_runtime_control::AcceptedTaskStopDisposition::Replayed => (
            StatusCode::OK,
            ProjectRunTaskCancellationDisposition::Replayed,
        ),
    };
    Ok((
        status,
        Json(ProjectRunTaskCancellationResource {
            disposition,
            run_id: response_run_id,
            task_id: response_task_id,
            command_id: result.command.message_id,
            lifecycle: ProjectRunTaskLifecycle::Stopping,
            catalog_revision: result.catalog_revision,
        }),
    ))
}

fn open_existing_run_store(root: &FsPath) -> Result<fullmag_session::SessionStore, ApiError> {
    match std::fs::symlink_metadata(root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found("accepted run intent is missing"));
        }
        Err(error) => return Err(ApiError::internal(error.to_string())),
    }
    fullmag_session::SessionStore::open_existing(root)
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[cfg(test)]
mod materialization_store_tests {
    use super::*;

    #[test]
    fn missing_run_store_returns_not_found_without_creating_storage() {
        let temp_root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let store_root = temp_root.join(format!(
            "fullmag-run-materialization-{}",
            uuid::Uuid::new_v4()
        ));

        let error = match open_existing_run_store(&store_root) {
            Ok(_) => panic!("missing run storage must not be initialized"),
            Err(error) => error,
        };

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        let was_created = store_root.exists();
        if was_created {
            let resolved = std::fs::canonicalize(&store_root).unwrap();
            assert!(resolved.starts_with(&temp_root));
            assert!(resolved
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("fullmag-run-materialization-")));
            std::fs::remove_dir_all(resolved).unwrap();
        }
        assert!(!was_created, "the handler must not create a missing store");
    }
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity")
    ),
    responses(
        (status = 200, description = "Durable run intent and task catalog snapshot", body = ProjectRunResource),
        (status = 404, description = "Accepted run intent is missing"),
        (status = 409, description = "Run belongs to another project")
    ),
    tag = "persistence"
)]
pub async fn get_run(
    Path((project_id, run_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProjectRunResource>, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let run_id = RunId::parse(run_id)
        .map_err(|error| ApiError::bad_request(format!("invalid run_id: {error}")))?;
    let resource = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        if !store_root.exists() {
            return Err(ApiError::not_found("accepted run intent is missing"));
        }
        let store = fullmag_session::SessionStore::open_existing(store_root)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let intent = store
            .read_run_intent(run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("accepted run intent is missing"))?;
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .map_err(|error| ApiError::internal(format!("invalid durable RunSpec: {error}")))?;
        if specification.snapshot.project_id != project_id {
            return Err(ApiError::conflict("run belongs to another project"));
        }
        if specification.run_id != run_id
            || specification
                .fingerprint()
                .map_err(|error| ApiError::internal(error.to_string()))?
                != intent.payload_sha256
        {
            return Err(ApiError::internal(
                "durable run identity or fingerprint is inconsistent",
            ));
        }
        let catalog = store
            .read_run_catalog(run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let (catalog_state, catalog_revision, tasks) = match catalog {
            Some(catalog) => (
                ProjectRunCatalogState::Materialized,
                Some(catalog.revision),
                catalog
                    .tasks
                    .into_iter()
                    .map(ProjectRunTaskResource::from)
                    .collect(),
            ),
            None => (
                ProjectRunCatalogState::PendingMaterialization,
                None,
                Vec::new(),
            ),
        };
        Ok(ProjectRunResource {
            project_id: project_id.as_str().into(),
            run_id: run_id.as_str().into(),
            payload_fingerprint: intent.payload_sha256,
            requested_execution: ProjectRunRequestedExecutionResource {
                backend: specification.requested_execution.backend,
                device: specification.requested_execution.device,
                precision: specification.requested_execution.precision,
                mode: specification.requested_execution.mode,
            },
            catalog_state,
            catalog_revision,
            tasks,
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("run read task failed: {error}")))??;
    Ok(Json(resource))
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ProjectRunListQuery
    ),
    responses(
        (status = 200, description = "Page of durable runs for one project", body = ProjectRunListResource),
        (status = 400, description = "Invalid page size or cursor")
    ),
    tag = "persistence"
)]
pub async fn list_runs(
    Path(project_id): Path<String>,
    Query(query): Query<ProjectRunListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProjectRunListResource>, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request(
            "run list limit must be from 1 to 100",
        ));
    }
    let cursor = query
        .cursor
        .map(RunId::parse)
        .transpose()
        .map_err(|error| ApiError::bad_request(format!("invalid run cursor: {error}")))?;
    let resource = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        if !store_root.exists() {
            return Ok(ProjectRunListResource {
                project_id: project_id.as_str().into(),
                runs: Vec::new(),
                next_cursor: None,
            });
        }
        let store = fullmag_session::SessionStore::open_existing(store_root)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut matched = Vec::new();
        for intent in store
            .list_run_intents()
            .map_err(|error| ApiError::internal(error.to_string()))?
        {
            if intent.specification["snapshot"]["project_id"].as_str() != Some(project_id.as_str())
            {
                continue;
            }
            let specification: RunSpecification =
                serde_json::from_value(intent.specification.clone()).map_err(|error| {
                    ApiError::internal(format!("invalid durable RunSpec: {error}"))
                })?;
            if specification.run_id.as_str() != intent.run_id
                || specification
                    .fingerprint()
                    .map_err(|error| ApiError::internal(error.to_string()))?
                    != intent.payload_sha256
            {
                return Err(ApiError::internal(
                    "durable run identity or fingerprint is inconsistent",
                ));
            }
            matched.push((intent, specification));
        }
        let start = if let Some(cursor) = cursor {
            matched
                .iter()
                .position(|(intent, _)| intent.run_id == cursor.as_str())
                .map(|position| position + 1)
                .ok_or_else(|| ApiError::bad_request("run cursor is not in this project"))?
        } else {
            0
        };
        let mut page = matched
            .into_iter()
            .skip(start)
            .take(limit as usize + 1)
            .collect::<Vec<_>>();
        let has_more = page.len() > limit as usize;
        if has_more {
            page.pop();
        }
        let next_cursor = if has_more {
            page.last().map(|(intent, _)| intent.run_id.clone())
        } else {
            None
        };
        let mut runs = Vec::with_capacity(page.len());
        for (intent, specification) in page {
            let catalog = store
                .read_run_catalog(&intent.run_id)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            let (catalog_state, catalog_revision, task_count) = match catalog {
                Some(catalog) => (
                    ProjectRunCatalogState::Materialized,
                    Some(catalog.revision),
                    catalog.tasks.len() as u64,
                ),
                None => (ProjectRunCatalogState::PendingMaterialization, None, 0),
            };
            runs.push(ProjectRunSummaryResource {
                run_id: intent.run_id,
                accepted_at: intent.accepted_at.to_rfc3339(),
                payload_fingerprint: intent.payload_sha256,
                requested_execution: ProjectRunRequestedExecutionResource {
                    backend: specification.requested_execution.backend,
                    device: specification.requested_execution.device,
                    precision: specification.requested_execution.precision,
                    mode: specification.requested_execution.mode,
                },
                catalog_state,
                catalog_revision,
                task_count,
            });
        }
        Ok(ProjectRunListResource {
            project_id: project_id.as_str().into(),
            runs,
            next_cursor,
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("run list task failed: {error}")))??;
    Ok(Json(resource))
}

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
