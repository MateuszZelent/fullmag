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
    ApplicationError, CreateProjectRequest, DocumentMode, FileProjectRepository, OpaqueDocument,
    ProjectApplication, ProjectId, ProjectSource, RawJsonEnvelope, RunId, RunIntent,
    RunSpecification, SubmitDisposition,
};
use fullmag_authoring::{
    validate_scene_document, validate_scene_document_for_authoring, SceneDocument, StudyPlan,
};
use fullmag_plan::StudyProblemCatalog;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path as FsPath, PathBuf as FsPathBuf};
use std::sync::Arc;

use crate::error::ApiError;
use crate::schemas::projects::{
    ProjectArchiveDurability, ProjectArchiveRequest, ProjectAuthoringUpdateRequest,
    ProjectCreateRequest, ProjectDocumentMode, ProjectDocumentResource, ProjectMigrationResource,
    ProjectRunCatalogState, ProjectRunExecutionState, ProjectRunListQuery, ProjectRunListResource,
    ProjectRunMaterializationResource, ProjectRunMinimumResourceBudgetResource,
    ProjectRunRequestedExecutionResource, ProjectRunResource, ProjectRunSubmitDisposition,
    ProjectRunSubmitRequest, ProjectRunSubmitResource, ProjectRunSummaryResource,
    ProjectRunTaskCancellationDisposition, ProjectRunTaskCancellationRequest,
    ProjectRunTaskCancellationResource, ProjectRunTaskLifecycle, ProjectRunTaskResource,
    PROJECT_ARCHIVE_MAX_BYTES,
};
use crate::types::AppState;

const AUTHORING_SOURCE_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[path = "execution_profile_submission.rs"]
mod execution_profile_submission;

/// Removes only the known generated source file.  The helper owns its
/// `scene-export-*.json` lifecycle; any unexpected file left in the private
/// directory is intentionally retained for diagnosis instead of being
/// removed recursively.
struct GeneratedSourceGuard {
    dir: FsPathBuf,
    path: FsPathBuf,
}

impl Drop for GeneratedSourceGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        // This is intentionally non-recursive.  The helper owns the known
        // `scene-export-*.json` files; retaining any unexpected file keeps a
        // diagnosis available and prevents us from deleting outside the
        // private directory's known outputs.
        let _ = fs::remove_dir(&self.dir);
    }
}

fn map_run_store_error(
    error: anyhow::Error,
    otherwise: impl FnOnce(anyhow::Error) -> ApiError,
) -> ApiError {
    if error.is::<fullmag_session::StoreWriterBusy>() {
        ApiError::conflict_with_code(
            "run_store_busy",
            "run storage has an active writer; retry the same request after it completes",
        )
    } else if let Some(backlog) = error.downcast_ref::<fullmag_session::RunBacklogFull>() {
        ApiError::too_many_requests_with_code(
            "run_backlog_full",
            format!(
                "accepted run backlog is full ({}/{}); retry after a run reaches a terminal state",
                backlog.active_run_count, backlog.limit
            ),
        )
    } else {
        otherwise(error)
    }
}

fn project_run_task_resource(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    artifact_catalog: Option<&fullmag_session::FmsArtifactCatalog>,
    task: fullmag_session::FmsTaskCatalogEntry,
) -> Result<ProjectRunTaskResource, ApiError> {
    let accepted_state_ref = match (task.attempt_id.as_deref(), task.ownership_epoch) {
        (Some(attempt_id), Some(ownership_epoch)) => {
            let mut manifests = artifact_catalog
                .into_iter()
                .flat_map(|catalog| catalog.entries.iter())
                .filter(|entry| {
                    entry.artifact_type == "study_output_manifest"
                        && entry.task_id == task.task_id
                        && entry.attempt_id == attempt_id
                        && entry.ownership_epoch == ownership_epoch
                        && task.artifact_ids.contains(&entry.artifact_id)
                });
            let manifest_entry = manifests.next();
            if manifests.next().is_some() {
                return Err(ApiError::internal(
                    "accepted run task has multiple output manifests for its current attempt",
                ));
            }
            if let Some(entry) = manifest_entry {
                let object_ref = entry.object_ref.as_deref().ok_or_else(|| {
                    ApiError::internal("study output manifest has no CAS reference")
                })?;
                if object_ref != entry.content_sha256 {
                    return Err(ApiError::internal(
                        "study output manifest digest differs from its CAS reference",
                    ));
                }
                let bytes = store
                    .cas()
                    .get(object_ref)
                    .map_err(|error| ApiError::internal(error.to_string()))?
                    .ok_or_else(|| {
                        ApiError::internal("study output manifest CAS object is missing")
                    })?;
                let manifest: fullmag_session::FmsStudyOutputManifest =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        ApiError::internal(format!("invalid study output manifest: {error}"))
                    })?;
                manifest
                    .validate()
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                if manifest.run_id != run_id
                    || manifest.task_id != task.task_id
                    || manifest.attempt_id != attempt_id
                    || manifest.ownership_epoch != ownership_epoch
                {
                    return Err(ApiError::internal(
                        "study output manifest identity differs from the run task",
                    ));
                }
                manifest.accepted_state_ref
            } else {
                None
            }
        }
        _ => None,
    };
    let mut resource = ProjectRunTaskResource::from(task);
    resource.accepted_state_ref = accepted_state_ref.map(Into::into);
    Ok(resource)
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
        (status = 409, description = "Project identity or idempotency conflict"),
        (status = 429, description = "Durable non-terminal run backlog is full")
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
        // A replay is governed by its accepted immutable inputs, not current
        // preferences. Only a new submission resolves published versions.
        if store
            .find_run_intent(&intent.idempotency_key)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .is_none()
        {
            execution_profile_submission::validate_published_profiles(&store, &study, &catalog)?;
        }
        let result = crate::run_intent_persistence::commit_archived_run_intent_with_backlog_limit(
            &store,
            &intent,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            state.submit_backlog_limit,
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
        (status = 409, description = "Task is not preparing/running or a conflicting cancellation exists")
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
        let artifact_catalog = store
            .read_artifact_catalog(run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let (catalog_state, catalog_revision, tasks) = match catalog {
            Some(catalog) => {
                let tasks = catalog
                    .tasks
                    .into_iter()
                    .map(|task| {
                        project_run_task_resource(
                            &store,
                            run_id.as_str(),
                            artifact_catalog.as_ref(),
                            task,
                        )
                    })
                    .collect::<Result<Vec<_>, ApiError>>()?;
                (
                    ProjectRunCatalogState::Materialized,
                    Some(catalog.revision),
                    tasks,
                )
            }
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
            scheduling_priority: specification.scheduling_priority,
            requested_execution: ProjectRunRequestedExecutionResource {
                backend: specification.requested_execution.backend,
                device: specification.requested_execution.device,
                precision: specification.requested_execution.precision,
                mode: specification.requested_execution.mode,
                minimum_resources: specification.requested_execution.minimum_resources.map(
                    |resources| ProjectRunMinimumResourceBudgetResource {
                        cpu_millis: resources.cpu_millis,
                        memory_bytes: resources.memory_bytes,
                        gpu_memory_bytes: resources.gpu_memory_bytes,
                        storage_bytes: resources.storage_bytes,
                    },
                ),
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
                scheduling_priority: specification.scheduling_priority,
                requested_execution: ProjectRunRequestedExecutionResource {
                    backend: specification.requested_execution.backend,
                    device: specification.requested_execution.device,
                    precision: specification.requested_execution.precision,
                    mode: specification.requested_execution.mode,
                    minimum_resources: specification.requested_execution.minimum_resources.map(
                        |resources| ProjectRunMinimumResourceBudgetResource {
                            cpu_millis: resources.cpu_millis,
                            memory_bytes: resources.memory_bytes,
                            gpu_memory_bytes: resources.gpu_memory_bytes,
                            storage_bytes: resources.storage_bytes,
                        },
                    ),
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

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/authoring",
    request_body = ProjectAuthoringUpdateRequest,
    responses(
        (status = 200, description = "Updated runtime-free project document bytes", body = ProjectDocumentResource),
        (status = 400, description = "Invalid project archive or scene document"),
        (status = 409, description = "Project identity, revision, or read-only conflict"),
        (status = 500, description = "Canonical source rendering failed")
    ),
    tag = "persistence"
)]
pub async fn authoring_update(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectAuthoringUpdateRequest>,
) -> Result<Json<ProjectDocumentResource>, ApiError> {
    let expected_project_id = ProjectId::parse(request.expected_project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid expected_project_id: {error}")))?;
    let scene_value = Value::Object(request.scene_document.into_iter().collect());
    if scene_value.get("version").and_then(Value::as_str) != Some("scene.v2") {
        return Err(ApiError::bad_request(
            "scene_document.version must explicitly be scene.v2",
        ));
    }
    let scene_document: SceneDocument = serde_json::from_value(scene_value.clone())
        .map_err(|error| ApiError::bad_request(format!("invalid scene_document: {error}")))?;
    validate_scene_document_for_authoring(&scene_document)
        .map_err(|error| ApiError::bad_request(format!("invalid scene_document: {error}")))?;

    let repo_root = state.repo_root.clone();
    let workspace_root = state.current_workspace_root.clone();
    let display_name = request.display_name;
    let archive_base64 = request.archive_base64;
    let expected_revision = request.expected_revision;
    let resource = tokio::task::spawn_blocking(move || {
        authoring_update_blocking(
            &repo_root,
            &workspace_root,
            display_name,
            archive_base64,
            expected_project_id,
            expected_revision,
            scene_value,
            scene_document,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("project authoring task failed: {error}")))??;
    Ok(Json(resource))
}

fn authoring_update_blocking(
    repo_root: &FsPath,
    workspace_root: &FsPath,
    display_name: String,
    archive_base64: String,
    expected_project_id: ProjectId,
    expected_revision: u64,
    scene_value: Value,
    scene_document: SceneDocument,
) -> Result<ProjectDocumentResource, ApiError> {
    let source_bytes = decode_archive(&ProjectArchiveRequest {
        display_name: display_name.clone(),
        archive_base64,
    })?;
    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let opened = application
        .open(ProjectSource::Bytes {
            display_name,
            bytes: source_bytes.clone(),
        })
        .map_err(map_authoring_application_error)?;
    if !opened.view.mode.is_writable() {
        return Err(ApiError::conflict(
            "project archive is read-only and cannot be authored",
        ));
    }
    if opened.view.project_id != expected_project_id {
        return Err(ApiError::conflict(
            "project identity differs from expected_project_id",
        ));
    }
    if opened.view.revision != expected_revision {
        return Err(ApiError::conflict(format!(
            "project revision differs from expected_revision: expected {}, found {}",
            expected_revision, opened.view.revision
        )));
    }

    let current = application
        .current_document()
        .cloned()
        .ok_or_else(|| ApiError::internal("project application has no current document"))?;
    let raw_scene_matches = current.definition.scene.value() == &scene_value;
    let renderable = scene_document
        .objects
        .iter()
        .any(|object| object.role == "magnet")
        && validate_scene_document(&scene_document).is_ok();
    let generated_source = if renderable {
        let private_dir = workspace_root.join(format!(
            ".fullmag-authoring-update-{}",
            crate::uuid_v4_hex()
        ));
        fs::create_dir_all(workspace_root).map_err(|error| {
            ApiError::internal(format!("failed to prepare authoring workspace: {error}"))
        })?;
        fs::create_dir(&private_dir).map_err(|error| {
            ApiError::internal(format!(
                "failed to create private authoring workspace: {error}"
            ))
        })?;
        let generated_source_path = private_dir.join("source.py");
        let _generated_source_guard = GeneratedSourceGuard {
            dir: private_dir.clone(),
            path: generated_source_path.clone(),
        };
        let rendered = crate::script::render_scene_document_via_python_helper_bounded(
            repo_root,
            &private_dir,
            &generated_source_path,
            &scene_document,
        )?;
        if !rendered.written {
            return Err(ApiError::internal(
                "canonical SceneDocument render helper did not write source",
            ));
        }
        let generated_source = read_generated_source(&generated_source_path)?;
        if rendered.bytes_written != generated_source.len() {
            return Err(ApiError::internal(
                "canonical SceneDocument render helper byte count is inconsistent",
            ));
        }
        Some(generated_source)
    } else {
        None
    };
    let source_matches =
        current.source.as_ref().map(|source| source.bytes()) == generated_source.as_deref();
    if raw_scene_matches && source_matches {
        return Ok(resource_from_application(
            &application,
            opened.view,
            source_bytes,
        )?);
    }

    let mut draft = current;
    let previous_source = draft
        .source
        .as_ref()
        .map(|source| (source.path().to_string(), source.bytes().to_vec()));
    if generated_source.is_none() {
        draft.source = None;
        if let Some((_, previous_bytes)) = previous_source.as_ref() {
            preserve_source_history(&mut draft, previous_bytes)?;
        }
    } else {
        let generated_source = generated_source
            .as_ref()
            .expect("renderable authoring scene has generated source");
        let source_entry_path = draft
            .source
            .as_ref()
            .map(|source| source.path().to_string())
            .unwrap_or_else(|| "project/source.py".to_string());
        if let Some((_, previous_bytes)) = previous_source.as_ref() {
            if previous_bytes != generated_source {
                preserve_source_history(&mut draft, previous_bytes)?;
            }
        }

        if draft
            .assets
            .iter()
            .any(|asset| asset.path() == source_entry_path.as_str())
        {
            return Err(ApiError::conflict(format!(
                "asset conflicts with canonical source path {source_entry_path}"
            )));
        }
        if let Some(conflict) = draft.opaque_documents.iter().find(|document| {
            document.path() == source_entry_path.as_str()
                && document.bytes() != generated_source.as_slice()
        }) {
            return Err(ApiError::conflict(format!(
                "opaque document conflicts with canonical source path {}",
                conflict.path()
            )));
        }
        // If an older archive listed the selected source path as opaque,
        // promote the exact entry to the source slot rather than emitting
        // duplicate ZIP entries. A differing entry was rejected above.
        draft
            .opaque_documents
            .retain(|document| document.path() != source_entry_path.as_str());
        draft.source = Some(
            OpaqueDocument::new(source_entry_path, generated_source.clone())
                .map_err(|error| ApiError::bad_request(format!("invalid source path: {error}")))?,
        );
    }
    let raw_scene = RawJsonEnvelope::from_value(scene_value)
        .map_err(|error| ApiError::bad_request(format!("invalid scene document: {error}")))?;
    draft
        .replace_scene(raw_scene)
        .map_err(|error| ApiError::bad_request(format!("invalid scene document: {error}")))?;
    // Validate the complete envelope before handing it to the application
    // writer.  This keeps duplicate source/asset/opaque paths and malformed
    // preserved entries at the request boundary instead of mutating the
    // in-memory document and discovering them only during ZIP encoding.
    draft
        .validate_for_save()
        .map_err(|error| ApiError::bad_request(format!("invalid project archive: {error}")))?;
    let view = application
        .replace_draft(draft, opened.view.revision)
        .map_err(map_authoring_application_error)?;
    let archive = encode_current(&application)?;
    if archive.len() > PROJECT_ARCHIVE_MAX_BYTES {
        return Err(ApiError::bad_request(format!(
            "updated project archive exceeds {} byte transport limit",
            PROJECT_ARCHIVE_MAX_BYTES
        )));
    }
    Ok(resource_from_application(&application, view, archive)?)
}

fn preserve_source_history(
    envelope: &mut fullmag_application::ProjectEnvelope,
    previous_bytes: &[u8],
) -> Result<(), ApiError> {
    let history_path = format!(
        "project/source-history/{:x}.py",
        Sha256::digest(previous_bytes)
    );
    if envelope
        .source
        .as_ref()
        .is_some_and(|source| source.path() == history_path.as_str())
        || envelope
            .assets
            .iter()
            .any(|asset| asset.path() == history_path.as_str())
    {
        return Err(ApiError::conflict(format!(
            "source history path {history_path} conflicts with an existing project entry"
        )));
    }
    if let Some(existing) = envelope
        .opaque_documents
        .iter()
        .find(|document| document.path() == history_path.as_str())
    {
        if existing.bytes() != previous_bytes {
            return Err(ApiError::conflict(format!(
                "source history path {} already contains different bytes",
                history_path
            )));
        }
        return Ok(());
    }
    envelope.opaque_documents.push(
        OpaqueDocument::new(history_path, previous_bytes.to_vec())
            .map_err(|error| ApiError::internal(format!("invalid source history path: {error}")))?,
    );
    Ok(())
}

fn read_generated_source(path: &FsPath) -> Result<Vec<u8>, ApiError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ApiError::internal(format!("canonical source output is unavailable: {error}"))
    })?;
    if !metadata.file_type().is_file() || metadata.len() > AUTHORING_SOURCE_MAX_BYTES {
        return Err(ApiError::internal(
            "canonical source output is not a bounded regular file",
        ));
    }
    let mut file = File::open(path).map_err(|error| {
        ApiError::internal(format!("failed to read canonical source output: {error}"))
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(AUTHORING_SOURCE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ApiError::internal(format!("failed to read canonical source: {error}")))?;
    if bytes.is_empty() || bytes.len() as u64 > AUTHORING_SOURCE_MAX_BYTES {
        return Err(ApiError::internal(
            "canonical source output is empty or exceeds the 8 MiB limit",
        ));
    }
    String::from_utf8(bytes.clone()).map_err(|error| {
        ApiError::internal(format!("canonical source output is not UTF-8: {error}"))
    })?;
    Ok(bytes)
}

fn map_authoring_application_error(
    error: ApplicationError<fullmag_application::FileRepositoryError>,
) -> ApiError {
    match error {
        ApplicationError::ReadOnly { reason, .. } => ApiError::conflict(format!(
            "project archive is read-only and cannot be authored: {reason}"
        )),
        ApplicationError::RevisionConflict { expected, actual } => ApiError::conflict(format!(
            "project revision conflict: expected {expected:?}, found {actual:?}"
        )),
        ApplicationError::ProjectIdMismatch => {
            ApiError::conflict("project identity differs from the current document")
        }
        ApplicationError::Repository(error) => {
            ApiError::bad_request(format!("invalid_project_document: {error}"))
        }
        ApplicationError::InvalidRequest(error) | ApplicationError::InvalidDefinition(error) => {
            ApiError::bad_request(error)
        }
        ApplicationError::RepositoryContract(error) => ApiError::internal(error),
        other => ApiError::internal(format!("project authoring application error: {other}")),
    }
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
