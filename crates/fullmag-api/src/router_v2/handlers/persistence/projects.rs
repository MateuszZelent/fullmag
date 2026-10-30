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
use chrono::Utc;
use fullmag_application::{
    ApplicationError, BatchExpansionRequest, CreateProjectRequest, DocumentMode,
    FileProjectRepository, OpaqueDocument, ProjectApplication, ProjectId, ProjectSource,
    RawJsonEnvelope, RunId, RunIntent, RunSpecification, SubmitDisposition, TaskId,
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
    ProjectBatchSubmitRequest, ProjectBatchSubmitResource, ProjectBatchAxisSummaryResource,
    ProjectBatchCasesQuery, ProjectBatchCasesResource, ProjectBatchCasePublishedRunResource,
    ProjectBatchCaseState, ProjectBatchCaseSummaryResource, ProjectBatchCaseTaskSummaryResource,
    ProjectBatchExpansionState, ProjectBatchListQuery, ProjectBatchFailurePolicy,
    ProjectBatchListResource, ProjectBatchSummaryResource,
    ProjectBatchCommandAction, ProjectBatchCommandDisposition, ProjectBatchCommandRequest,
    ProjectBatchCommandResource, ProjectBatchRetryResource,
    ProjectCreateRequest, ProjectDocumentMode, ProjectDocumentResource, ProjectMigrationResource,
    ProjectRunCatalogState, ProjectRunExecutionState, ProjectRunListQuery, ProjectRunListResource,
    ProjectRunMaterializationResource, ProjectRunMinimumResourceBudgetResource,
    ProjectRunRequestedExecutionResource, ProjectRunResource, ProjectRunSubmitDisposition,
    ProjectRunSubmitRequest, ProjectRunSubmitResource, ProjectRunSummaryResource,
    ProjectRunTaskCancellationDisposition, ProjectRunTaskCancellationIntentResource,
    ProjectRunTaskCancellationRequest, ProjectRunTaskCancellationResource,
    ProjectRunTaskCancellationState, ProjectRunTaskCancellationSummary, ProjectRunTaskLifecycle,
    ProjectRunTaskResource, ProjectRunTaskRetryDisposition, ProjectRunTaskRetryRequest,
    ProjectRunTaskRetryResource, ProjectRunTaskStopResource, PROJECT_ARCHIVE_MAX_BYTES,
};
use crate::types::AppState;

const AUTHORING_SOURCE_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[path = "execution_profile_submission.rs"]
mod execution_profile_submission;

#[path = "run_intent_preparation.rs"]
pub(crate) mod run_intent_preparation;

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
    catalog_revision: u64,
    execution: Option<crate::schemas::projects::ProjectRunTaskExecutionResource>,
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
                    .get_bounded(object_ref, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)
                    .map_err(|error| ApiError::internal(error.to_string()))?
                    .ok_or_else(|| {
                        ApiError::internal("study output manifest CAS object is missing")
                    })?;
                // This resource exposes identity metadata, not numerical observation admission.
                let manifest = fullmag_runtime_control::read_study_output_manifest_projection(&bytes)
                    .map_err(|error| {
                        ApiError::internal(format!("invalid study output manifest: {error}"))
                    })?;
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
    let cancellation = store
        .read_task_cancellation_intent(run_id, &task.task_id)
        .map_err(|error| ApiError::internal(format!("reading cancellation intent: {error:#}")))?;
    if let Some(intent) = &cancellation {
        intent
            .validate_task_scope(store, &task, catalog_revision)
            .map_err(|error| {
                ApiError::internal(format!("invalid cancellation task scope: {error:#}"))
            })?;
    }
    let mut resource = ProjectRunTaskResource::from(task);
    resource.accepted_state_ref = accepted_state_ref.map(Into::into);
    resource.execution = execution;
    resource.cancellation_intent = cancellation.map(|intent| ProjectRunTaskCancellationSummary {
        cancellation_id: intent.cancellation_id,
        reason: intent.reason,
        expected_catalog_revision: intent.expected_catalog_revision,
        created_at: intent.created_at.to_rfc3339(),
    });
    Ok(resource)
}

fn project_run_task_execution_by_id(
    store: &fullmag_session::SessionStore,
    intent: &fullmag_session::FmsRunIntent,
    specification: &RunSpecification,
) -> Result<
    Option<
        std::collections::BTreeMap<
            String,
            crate::schemas::projects::ProjectRunTaskExecutionResource,
        >,
    >,
    ApiError,
> {
    let (Some(study_object_ref), Some(catalog_object_ref)) = (
        intent.study_object_ref.as_deref(),
        intent.study_catalog_object_ref.as_deref(),
    ) else {
        if intent.study_object_ref.is_none() && intent.study_catalog_object_ref.is_none() {
            return Ok(None);
        }
        return Err(ApiError::internal(
            "accepted run has an incomplete immutable StudyPlan/catalog reference pair",
        ));
    };
    if study_object_ref != specification.study.plan_sha256.as_str()
        || catalog_object_ref != specification.study_catalog_sha256.as_str()
    {
        return Err(ApiError::internal(
            "accepted run StudyPlan/catalog references differ from RunSpec",
        ));
    }

    let study_bytes = store
        .cas()
        .get(study_object_ref)
        .map_err(|error| ApiError::internal(format!("read accepted StudyPlan: {error}")))?
        .ok_or_else(|| ApiError::internal("accepted StudyPlan CAS object is missing"))?;
    if fullmag_session::hex_sha256(&study_bytes) != study_object_ref {
        return Err(ApiError::internal(
            "accepted StudyPlan bytes differ from their immutable CAS reference",
        ));
    }
    let study: fullmag_authoring::StudyPlan = serde_json::from_slice(&study_bytes).map_err(|error| {
        ApiError::internal(format!("invalid accepted StudyPlan: {error}"))
    })?;
    study
        .validate_for_execution()
        .map_err(|error| ApiError::internal(format!("invalid accepted StudyPlan: {error}")))?;
    let study_digest = study.canonical_sha256().map_err(|error| {
        ApiError::internal(format!("hash accepted StudyPlan: {error}"))
    })?;
    if study.study_id.as_str() != specification.study.study_id.as_str()
        || study.schema_version.as_str() != specification.study.plan_version.as_str()
        || study_digest.as_str() != study_object_ref
    {
        return Err(ApiError::internal(
            "accepted StudyPlan identity differs from the immutable RunSpec reference",
        ));
    }

    let catalog_bytes = store
        .cas()
        .get(catalog_object_ref)
        .map_err(|error| ApiError::internal(format!("read accepted StudyProblemCatalog: {error}")))?
        .ok_or_else(|| ApiError::internal("accepted StudyProblemCatalog CAS object is missing"))?;
    if fullmag_session::hex_sha256(&catalog_bytes) != catalog_object_ref {
        return Err(ApiError::internal(
            "accepted StudyProblemCatalog bytes differ from their immutable CAS reference",
        ));
    }
    let catalog: StudyProblemCatalog = serde_json::from_slice(&catalog_bytes)
        .map_err(|error| ApiError::internal(format!("invalid accepted StudyProblemCatalog: {error}")))?;
    catalog.validate_for(&study).map_err(|error| {
        ApiError::internal(format!("invalid accepted StudyProblemCatalog: {error}"))
    })?;

    let mut by_task_id = std::collections::BTreeMap::new();
    for entry in catalog.entries() {
        let task_id = fullmag_session::task_id_for_study_step(
            specification.run_id.as_str(),
            entry.step_id(),
        )
        .map_err(|error| ApiError::internal(format!("derive accepted Study task identity: {error}")))?;
        let execution = crate::schemas::projects::ProjectRunTaskExecutionResource {
            step_id: entry.step_id().to_owned(),
            materialization: entry.execution_materialization().cloned(),
        };
        if by_task_id.insert(task_id, execution).is_some() {
            return Err(ApiError::internal(
                "accepted Study catalog maps multiple steps to one durable task",
            ));
        }
    }
    Ok(Some(by_task_id))
}

fn project_batch_case_published_run(
    store: &fullmag_session::SessionStore,
    batch_intent: &fullmag_session::FmsBatchIntent,
    project_id: &ProjectId,
    case: &fullmag_application::BatchCase,
    child_intent: fullmag_session::FmsRunIntent,
) -> Result<ProjectBatchCasePublishedRunResource, ApiError> {
    let expected_run_id = case.specification.run_id.as_str();
    let expected_idempotency_key =
        batch_case_idempotency_key(&batch_intent.batch_id, &case.case_id);
    if child_intent.run_id != expected_run_id
        || child_intent.idempotency_key != expected_idempotency_key
    {
        return Err(ApiError::internal(format!(
            "published batch case `{}` has a mismatched child run identity",
            case.case_id
        )));
    }

    let specification: RunSpecification =
        serde_json::from_value(child_intent.specification.clone()).map_err(|error| {
            ApiError::internal(format!("invalid durable batch child RunSpec: {error}"))
        })?;
    let fingerprint = specification
        .fingerprint()
        .map_err(|error| {
            ApiError::internal(format!("invalid durable batch child RunSpec: {error}"))
        })?;
    let mut expected_specification = case.specification.clone();
    // Case materialization deterministically binds per-case StudyPlan/catalog
    // digests. Every other RunSpecification field must remain the accepted
    // manifest value.
    expected_specification.study.plan_sha256 = specification.study.plan_sha256.clone();
    expected_specification.study_catalog_sha256 = specification.study_catalog_sha256.clone();
    if specification != expected_specification
        || specification.run_id.as_str() != expected_run_id
        || specification.snapshot.project_id.as_str() != project_id.as_str()
        || case.specification.snapshot.project_id.as_str() != project_id.as_str()
        || child_intent.payload_sha256 != fingerprint
        || child_intent.definition_object_ref.as_deref()
            != Some(batch_intent.definition_object_ref.as_str())
        || child_intent.study_object_ref.as_deref()
            != Some(specification.study.plan_sha256.as_str())
        || child_intent.study_catalog_object_ref.as_deref()
            != Some(specification.study_catalog_sha256.as_str())
        || child_intent.asset_object_refs != batch_intent.asset_object_refs
    {
        return Err(ApiError::internal(format!(
            "published batch case `{}` child intent differs from its accepted identity",
            case.case_id
        )));
    }

    let catalog = store
        .read_run_catalog(expected_run_id)
        .map_err(|error| ApiError::internal(format!("read batch child task catalog: {error:#}")))?;
    let (catalog_state, catalog_revision, tasks) = match catalog {
        Some(catalog) => {
            if catalog.run_id != expected_run_id || catalog.tasks.is_empty() {
                return Err(ApiError::internal(format!(
                    "published batch case `{}` has an incomplete child task catalog",
                    case.case_id
                )));
            }
            let catalog_revision = catalog.revision;
            let mut tasks = Vec::with_capacity(catalog.tasks.len());
            for task in catalog.tasks {
                let cancellation = store
                    .read_task_cancellation_intent(expected_run_id, &task.task_id)
                    .map_err(|error| {
                        ApiError::internal(format!(
                            "read batch child cancellation intent: {error:#}"
                        ))
                    })?;
                if let Some(intent) = &cancellation {
                    intent
                        .validate_task_scope(store, &task, catalog_revision)
                        .map_err(|error| {
                            ApiError::internal(format!(
                                "invalid batch child cancellation scope: {error:#}"
                            ))
                        })?;
                }
                tasks.push(ProjectBatchCaseTaskSummaryResource {
                    task_id: task.task_id,
                    lifecycle: task.lifecycle.into(),
                    cancellation_requested: cancellation.is_some(),
                });
            }
            (
                ProjectRunCatalogState::Materialized,
                Some(catalog_revision),
                tasks,
            )
        }
        None => (
            ProjectRunCatalogState::PendingMaterialization,
            None,
            Vec::new(),
        ),
    };

    Ok(ProjectBatchCasePublishedRunResource {
        run_id: child_intent.run_id,
        catalog_state,
        catalog_revision,
        tasks,
    })
}

fn batch_case_idempotency_key(batch_id: &str, case_id: &str) -> String {
    let identity = format!("{batch_id}\0{case_id}");
    format!(
        "batch-case-{}",
        fullmag_session::hex_sha256(identity.as_bytes())
    )
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
    crate::accepted_solver_profile::validate_study_profile(&intent.specification.parameters, &study)
        .map_err(|error| ApiError::bad_request(format!("invalid_solver_profile: {error:#}")))?;
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
    path = "/v2/persistence/projects/{project_id}/batches",
    params(("project_id" = String, Path, description = "Pinned project identity")),
    request_body = ProjectBatchSubmitRequest,
    responses(
        (status = 201, description = "Durable immutable batch parent accepted", body = ProjectBatchSubmitResource),
        (status = 200, description = "Identical batch submit replayed", body = ProjectBatchSubmitResource),
        (status = 400, description = "Invalid immutable batch inputs"),
        (status = 409, description = "Project identity, batch identity or idempotency conflict")
    ),
    tag = "persistence"
)]
pub async fn submit_batch(
    Path(project_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectBatchSubmitRequest>,
) -> Result<(StatusCode, Json<ProjectBatchSubmitResource>), ApiError> {
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
    let batch_request: BatchExpansionRequest = serde_json::from_value(serde_json::Value::Object(
        request.batch_request.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_batch_request: {error}")))?;
    let study: StudyPlan = serde_json::from_value(serde_json::Value::Object(
        request.study_plan.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_study_plan: {error}")))?;
    let catalog: StudyProblemCatalog = serde_json::from_value(serde_json::Value::Object(
        request.study_problem_catalog.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_study_problem_catalog: {error}")))?;
    crate::accepted_solver_profile::validate_study_profile(&batch_request.template.parameters, &study)
        .map_err(|error| ApiError::bad_request(format!("invalid_solver_profile: {error:#}")))?;
    if batch_request.template.snapshot.project_id != project_id {
        return Err(ApiError::conflict(
            "batch template project_id differs from request path",
        ));
    }
    let idempotency_key = request.idempotency_key;
    let asset_paths = request.asset_paths;
    let receipt = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed batch storage is not configured"))?;
        let store = fullmag_session::SessionStore::open(store_root).map_err(|error| {
            map_run_store_error(error, |error| ApiError::internal(error.to_string()))
        })?;
        let batch_already_accepted = store
            .find_batch_intent(&idempotency_key)
            .map_err(|error| ApiError::internal(format!("read batch intent: {error:#}")))?
            .is_some();
        if !batch_already_accepted {
            execution_profile_submission::validate_published_profiles(&store, &study, &catalog)?;
        }
        let output_storage_defaults = if batch_already_accepted {
            None
        } else {
            let settings = crate::router_v2::handlers::platform::output_storage::load_defaults()?;
            settings.validate().map_err(|error| {
                ApiError::internal(format!("resolved OutputStorage defaults are invalid: {error}"))
            })?;
            Some(settings)
        };
        let result = crate::run_intent_persistence::commit_archived_batch_intent(
            &store,
            &project_id,
            &idempotency_key,
            &batch_request,
            &archive,
            &study,
            &catalog,
            &asset_paths,
            output_storage_defaults,
        );
        let receipt = result.map_err(|error| {
            let detail = format!("{error:#}");
            if detail.contains("idempotency key")
                && detail.contains("already accepted for another payload")
                || detail.contains("batch intent path already exists")
            {
                ApiError::conflict("batch identity or idempotency key is already in use")
            } else {
                map_run_store_error(error, |error| {
                    ApiError::bad_request(format!("invalid_batch_submission: {error:#}"))
                })
            }
        })?;
        Ok::<_, ApiError>(receipt)
    })
    .await
    .map_err(|error| ApiError::internal(format!("batch submission task failed: {error}")))??;
    let (status, disposition) = match receipt.disposition {
        crate::run_intent_persistence::BatchSubmitDisposition::Accepted => {
            (StatusCode::CREATED, ProjectRunSubmitDisposition::Accepted)
        }
        crate::run_intent_persistence::BatchSubmitDisposition::Replayed => {
            (StatusCode::OK, ProjectRunSubmitDisposition::Replayed)
        }
    };
    Ok((
        status,
        Json(ProjectBatchSubmitResource {
            disposition,
            batch_id: receipt.batch_id,
            manifest_sha256: receipt.manifest_sha256,
            case_count: receipt.case_count,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/batches",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ProjectBatchListQuery
    ),
    responses(
        (status = 200, description = "Page of durable batch parents for one project", body = ProjectBatchListResource),
        (status = 400, description = "Invalid page size or cursor")
    ),
    tag = "persistence"
)]
pub async fn list_batches(
    Path(project_id): Path<String>,
    Query(query): Query<ProjectBatchListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProjectBatchListResource>, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request(
            "batch list limit must be from 1 to 100",
        ));
    }
    let cursor = query
        .cursor
        .map(|value| {
            fullmag_session::repository_path::validate_store_id(&value)
                .map_err(|error| ApiError::bad_request(format!("invalid batch cursor: {error}")))?;
            Ok::<_, ApiError>(value)
        })
        .transpose()?;
    let resource = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed batch storage is not configured"))?;
        if !store_root.exists() {
            return Ok::<_, ApiError>(ProjectBatchListResource {
                project_id: project_id.as_str().into(),
                batches: Vec::new(),
                next_cursor: None,
            });
        }
        let store = fullmag_session::SessionStore::open_existing(store_root)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut matched = Vec::new();
        for intent in store
            .list_batch_intents()
            .map_err(|error| ApiError::internal(format!("list durable batches: {error:#}")))?
        {
            if intent
                .specification
                .pointer("/request/template/snapshot/project_id")
                .and_then(serde_json::Value::as_str)
                != Some(project_id.as_str())
            {
                continue;
            }
            let manifest_bytes = store
                .cas()
                .get(&intent.manifest_object_ref)
                .map_err(|error| ApiError::internal(format!("read batch manifest: {error:#}")))?
                .ok_or_else(|| ApiError::internal("durable batch manifest is missing"))?;
            intent
                .validate_manifest_bytes(&manifest_bytes)
                .map_err(|error| ApiError::internal(format!("invalid batch manifest: {error:#}")))?;
            let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
                .map_err(|error| ApiError::internal(format!("decode batch manifest: {error}")))?;
            let case_count = manifest
                .get("cases")
                .and_then(serde_json::Value::as_array)
                .map(|cases| cases.len() as u64)
                .ok_or_else(|| ApiError::internal("batch manifest has no cases array"))?;
            let progress = store
                .read_batch_expansion_progress(&intent.batch_id)
                .map_err(|error| ApiError::internal(format!("read batch expansion progress: {error:#}")))?;
            let (published_case_count, command_revision, expansion_state) = progress.map_or(
                (0, 0, ProjectBatchExpansionState::Pending),
                |progress| {
                    let state = match progress.state {
                        fullmag_session::FmsBatchExpansionState::Pending => {
                            ProjectBatchExpansionState::Pending
                        }
                        fullmag_session::FmsBatchExpansionState::Expanding => {
                            ProjectBatchExpansionState::Expanding
                        }
                        fullmag_session::FmsBatchExpansionState::Complete => {
                            ProjectBatchExpansionState::Complete
                        }
                        fullmag_session::FmsBatchExpansionState::Stopped => {
                            ProjectBatchExpansionState::Stopped
                        }
                        fullmag_session::FmsBatchExpansionState::Paused => {
                            ProjectBatchExpansionState::Paused
                        }
                        fullmag_session::FmsBatchExpansionState::Cancelled => {
                            ProjectBatchExpansionState::Cancelled
                        }
                    };
                    (
                        progress.next_case_index,
                        progress.commands.len() as u64,
                        state,
                    )
                },
            );
            let max_parallel_cases = intent
                .specification
                .pointer("/request/max_parallel_cases")
                .and_then(serde_json::Value::as_u64)
                .map(u32::try_from)
                .transpose()
                .map_err(|_| ApiError::internal("batch max_parallel_cases exceeds u32"))?;
            matched.push((
                intent,
                case_count,
                max_parallel_cases,
                published_case_count,
                command_revision,
                expansion_state,
            ));
        }
        let start = if let Some(cursor) = cursor {
            matched
                .iter()
                .position(|(intent, _, _, _, _, _)| intent.batch_id == cursor)
                .map(|position| position + 1)
                .ok_or_else(|| ApiError::bad_request("batch cursor is not in this project"))?
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
            page.last().map(|(intent, _, _, _, _, _)| intent.batch_id.clone())
        } else {
            None
        };
        let batches = page
            .into_iter()
            .map(|(intent, case_count, max_parallel_cases, published_case_count, command_revision, expansion_state)| {
                let manifest_sha256 = intent
                    .specification
                    .get("manifest_sha256")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| ApiError::internal("batch intent has no manifest digest"))?;
                let failure_policy = match intent
                    .specification
                    .pointer("/request/failure_policy")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("continue_independent")
                {
                    "continue_independent" => ProjectBatchFailurePolicy::ContinueIndependent,
                    "stop_admission" => ProjectBatchFailurePolicy::StopAdmission,
                    _ => return Err(ApiError::internal("batch intent has an invalid failure policy")),
                };
                Ok(ProjectBatchSummaryResource {
                    batch_id: intent.batch_id,
                    accepted_at: intent.accepted_at.to_rfc3339(),
                    manifest_sha256: manifest_sha256.to_string(),
                    case_count,
                    max_parallel_cases,
                    failure_policy,
                    published_case_count,
                    command_revision,
                    expansion_state,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        Ok::<_, ApiError>(ProjectBatchListResource {
            project_id: project_id.as_str().into(),
            batches,
            next_cursor,
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("batch list task failed: {error}")))??;
    Ok(Json(resource))
}

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/{project_id}/batches/{batch_id}/commands",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("batch_id" = String, Path, description = "Durable batch identity")
    ),
    request_body = ProjectBatchCommandRequest,
    responses(
        (status = 202, description = "Durable batch admission command accepted", body = ProjectBatchCommandResource),
        (status = 200, description = "Identical batch command replayed", body = ProjectBatchCommandResource),
        (status = 400, description = "Invalid batch command"),
        (status = 404, description = "Accepted batch is missing"),
        (status = 409, description = "Project scope, command revision, or lifecycle conflict"),
        (status = 500, description = "Durable batch state is inconsistent")
    ),
    tag = "persistence"
)]
pub async fn command_batch(
    Path((project_id, batch_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectBatchCommandRequest>,
) -> Result<(StatusCode, Json<ProjectBatchCommandResource>), ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    fullmag_session::repository_path::validate_store_id(&batch_id)
        .map_err(|error| ApiError::bad_request(format!("invalid batch_id: {error}")))?;
    fullmag_session::repository_path::validate_store_id(&request.command_id)
        .map_err(|error| ApiError::bad_request(format!("invalid command_id: {error}")))?;
    let action = match request.action {
        ProjectBatchCommandAction::PauseAdmission => {
            fullmag_session::FmsBatchCommandAction::PauseAdmission
        }
        ProjectBatchCommandAction::ResumeAdmission => {
            fullmag_session::FmsBatchCommandAction::ResumeAdmission
        }
        ProjectBatchCommandAction::CancelAdmission => {
            fullmag_session::FmsBatchCommandAction::CancelAdmission
        }
        ProjectBatchCommandAction::Retry => fullmag_session::FmsBatchCommandAction::Retry,
    };
    let result = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed batch storage is not configured"))?;
        let store = open_existing_run_store(store_root)?;
        let intent = store
            .read_batch_intent(&batch_id)
            .map_err(|error| ApiError::internal(format!("read batch intent: {error:#}")))?
            .ok_or_else(|| ApiError::not_found("accepted batch is missing"))?;
        if intent
            .specification
            .pointer("/request/template/snapshot/project_id")
            .and_then(serde_json::Value::as_str)
            != Some(project_id.as_str())
        {
            return Err(ApiError::conflict("batch belongs to another project"));
        }
        let retry_input = match (request.action, request.retry.as_ref()) {
            (ProjectBatchCommandAction::Retry, Some(retry)) => Some(retry),
            (ProjectBatchCommandAction::Retry, None) => {
                return Err(ApiError::bad_request(
                    "retry command requires a case, task, retry ID, and catalog revision",
                ));
            }
            (_, Some(_)) => {
                return Err(ApiError::bad_request(
                    "retry target is only valid for a retry command",
                ));
            }
            (_, None) => None,
        };
        let mut retry_case_id = None;
        let mut retry_run_id = None;
        let mut retry_task_id = None;
        let mut retry_request = None;
        let retry_target = if let Some(retry) = retry_input {
            fullmag_session::repository_path::validate_store_id(&retry.case_id)
                .map_err(|error| ApiError::bad_request(format!("invalid case_id: {error}")))?;
            let task_id = TaskId::parse(retry.task_id.clone())
                .map_err(|error| ApiError::bad_request(format!("invalid task_id: {error}")))?;
            TaskId::parse(retry.retry_id.clone())
                .map_err(|error| ApiError::bad_request(format!("invalid retry_id: {error}")))?;
            if retry.expected_catalog_revision == 0 {
                return Err(ApiError::bad_request(
                    "expected_catalog_revision must be positive",
                ));
            }
            let manifest_bytes = store
                .cas()
                .get(&intent.manifest_object_ref)
                .map_err(|error| ApiError::internal(format!("read retry batch manifest: {error:#}")))?
                .ok_or_else(|| ApiError::internal("durable retry batch manifest is missing"))?;
            intent
                .validate_manifest_bytes(&manifest_bytes)
                .map_err(|error| ApiError::internal(format!("validate retry batch manifest: {error:#}")))?;
            let manifest: fullmag_application::BatchExpansionManifest =
                serde_json::from_slice(&manifest_bytes)
                    .map_err(|error| ApiError::internal(format!("decode retry batch manifest: {error}")))?;
            manifest
                .validate_integrity()
                .map_err(|error| ApiError::internal(format!("invalid retry batch manifest: {error}")))?;
            let batch_case = manifest
                .cases
                .iter()
                .find(|case| case.case_id == retry.case_id)
                .ok_or_else(|| ApiError::not_found("batch case is missing from its immutable manifest"))?;
            let run_id = batch_case.specification.run_id.clone();
            let child_intent = store
                .read_run_intent(run_id.as_str())
                .map_err(|error| ApiError::internal(format!("read retry case run intent: {error:#}")))?
                .ok_or_else(|| ApiError::conflict("batch case has not been published yet"))?;
            let published_run = project_batch_case_published_run(
                &store,
                &intent,
                &project_id,
                batch_case,
                child_intent,
            )?;
            if !matches!(published_run.catalog_state, ProjectRunCatalogState::Materialized) {
                return Err(ApiError::conflict(
                    "batch case task catalog must be materialized before retry",
                ));
            }
            if !published_run.tasks.iter().any(|task| task.task_id == retry.task_id) {
                return Err(ApiError::not_found("task is missing from the selected batch case"));
            }
            retry_case_id = Some(retry.case_id.clone());
            retry_run_id = Some(run_id.clone());
            retry_task_id = Some(task_id.clone());
            retry_request = Some(ProjectRunTaskRetryRequest {
                retry_id: retry.retry_id.clone(),
                expected_catalog_revision: retry.expected_catalog_revision,
            });
            Some(fullmag_session::FmsBatchRetryTarget {
                case_id: retry.case_id.clone(),
                run_id: run_id.as_str().to_owned(),
                task_id: task_id.as_str().to_owned(),
                retry_id: retry.retry_id.clone(),
                expected_catalog_revision: retry.expected_catalog_revision,
            })
        } else {
            None
        };
        let command = if let Some(target) = retry_target.clone() {
            fullmag_session::FmsBatchCommandIntent::new_retry(
                batch_id.clone(),
                request.command_id.clone(),
                request.expected_revision,
                target,
                request.reason.clone(),
            )
        } else {
            fullmag_session::FmsBatchCommandIntent::new(
                batch_id.clone(),
                request.command_id.clone(),
                request.expected_revision,
                action,
                request.reason.clone(),
            )
        };
        command
            .validate()
            .map_err(|error| ApiError::bad_request(format!("invalid batch command: {error}")))?;

        let mut retry_task_resource = None;
        let _compound_writer = if retry_target.is_some() {
            Some(
                store
                    .write_transaction()
                    .map_err(|error| {
                        map_run_store_error(error, |error| {
                            ApiError::internal(format!("acquiring batch retry transaction: {error:#}"))
                        })
                    })?,
            )
        } else {
            None
        };
        if let (Some(run_id), Some(task_id), Some(retry_request)) = (
            retry_run_id.as_ref(),
            retry_task_id.as_ref(),
            retry_request.as_ref(),
        ) {
            store
                .validate_batch_command(&command)
                .map_err(batch_command_store_error)?;
            let (_, task_retry) = retry_run_task_in_store(
                &store,
                &project_id,
                run_id,
                task_id,
                retry_request,
            )?;
            retry_task_resource = Some(task_retry);
        }
        let disposition = store
            .commit_batch_command(&command)
            .map_err(batch_command_store_error)?;
        let progress = store
            .read_batch_expansion_progress(&batch_id)
            .map_err(|error| ApiError::internal(format!("read batch command state: {error:#}")))?
            .ok_or_else(|| ApiError::internal("batch command checkpoint disappeared"))?;
        let expansion_state = match progress.state {
            fullmag_session::FmsBatchExpansionState::Pending => ProjectBatchExpansionState::Pending,
            fullmag_session::FmsBatchExpansionState::Expanding => ProjectBatchExpansionState::Expanding,
            fullmag_session::FmsBatchExpansionState::Complete => ProjectBatchExpansionState::Complete,
            fullmag_session::FmsBatchExpansionState::Stopped => ProjectBatchExpansionState::Stopped,
            fullmag_session::FmsBatchExpansionState::Paused => ProjectBatchExpansionState::Paused,
            fullmag_session::FmsBatchExpansionState::Cancelled => ProjectBatchExpansionState::Cancelled,
        };
        let command_record = progress
            .commands
            .iter()
            .find(|entry| entry.command_id == command.command_id)
            .ok_or_else(|| ApiError::internal("accepted batch command is missing from checkpoint"))?;
        let status = match disposition {
            fullmag_session::BatchCommandCommitDisposition::Accepted => StatusCode::ACCEPTED,
            fullmag_session::BatchCommandCommitDisposition::Replayed => StatusCode::OK,
        };
        let response = ProjectBatchCommandResource {
            disposition: match disposition {
                fullmag_session::BatchCommandCommitDisposition::Accepted => {
                    ProjectBatchCommandDisposition::Accepted
                }
                fullmag_session::BatchCommandCommitDisposition::Replayed => {
                    ProjectBatchCommandDisposition::Replayed
                }
            },
            batch_id: batch_id.clone(),
            command_id: command_record.command_id.clone(),
            action: request_action_from_storage(command_record.action),
            revision: command_record.revision,
            command_revision: u64::try_from(progress.commands.len())
                .map_err(|_| ApiError::internal("batch command revision exceeds u64"))?,
            expansion_state,
            retry: match (retry_case_id, retry_task_resource) {
                (Some(case_id), Some(task)) => Some(ProjectBatchRetryResource { case_id, task }),
                (None, None) => None,
                _ => return Err(ApiError::internal("batch retry response is incomplete")),
            },
        };
        Ok::<_, ApiError>((status, response))
    })
    .await
    .map_err(|error| ApiError::internal(format!("batch command task failed: {error}")))??;
    Ok((result.0, Json(result.1)))
}

fn request_action_from_storage(
    action: fullmag_session::FmsBatchCommandAction,
) -> ProjectBatchCommandAction {
    match action {
        fullmag_session::FmsBatchCommandAction::PauseAdmission => {
            ProjectBatchCommandAction::PauseAdmission
        }
        fullmag_session::FmsBatchCommandAction::ResumeAdmission => {
            ProjectBatchCommandAction::ResumeAdmission
        }
        fullmag_session::FmsBatchCommandAction::CancelAdmission => {
            ProjectBatchCommandAction::CancelAdmission
        }
        fullmag_session::FmsBatchCommandAction::Retry => ProjectBatchCommandAction::Retry,
    }
}

fn batch_command_store_error(error: anyhow::Error) -> ApiError {
    map_run_store_error(error, |error| {
        if let Some(conflict) = error.downcast_ref::<fullmag_session::BatchCommandConflict>() {
            let code = match conflict {
                fullmag_session::BatchCommandConflict::Revision { .. } => {
                    "batch_command_revision_conflict"
                }
                fullmag_session::BatchCommandConflict::Identity => {
                    "batch_command_identity_conflict"
                }
                fullmag_session::BatchCommandConflict::InvalidTransition { .. } => {
                    "batch_command_state_conflict"
                }
            };
            ApiError::conflict_with_code(code, format!("{error:#}"))
        } else {
            ApiError::internal(format!("validating or recording batch command: {error:#}"))
        }
    })
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/batches/{batch_id}/cases",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("batch_id" = String, Path, description = "Durable batch identity"),
        ProjectBatchCasesQuery
    ),
    responses(
        (status = 200, description = "Page of manifest cases with verified published child run and task catalog lifecycle", body = ProjectBatchCasesResource),
        (status = 400, description = "Invalid page size or cursor"),
        (status = 404, description = "Accepted batch is missing"),
        (status = 409, description = "Batch belongs to another project"),
        (status = 500, description = "Durable manifest, child run, or task catalog is incomplete or inconsistent")
    ),
    tag = "persistence"
)]
pub async fn list_batch_cases(
    Path((project_id, batch_id)): Path<(String, String)>,
    Query(query): Query<ProjectBatchCasesQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProjectBatchCasesResource>, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    fullmag_session::repository_path::validate_store_id(&batch_id)
        .map_err(|error| ApiError::bad_request(format!("invalid batch_id: {error}")))?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request(
            "batch case list limit must be from 1 to 100",
        ));
    }
    let cursor = query.cursor;
    let resource = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed batch storage is not configured"))?;
        let store = open_existing_run_store(store_root)?;
        let intent = store
            .read_batch_intent(&batch_id)
            .map_err(|error| ApiError::internal(format!("read batch intent: {error:#}")))?
            .ok_or_else(|| ApiError::not_found("accepted batch is missing"))?;
        if intent
            .specification
            .pointer("/request/template/snapshot/project_id")
            .and_then(serde_json::Value::as_str)
            != Some(project_id.as_str())
        {
            return Err(ApiError::conflict("batch belongs to another project"));
        }
        let manifest_bytes = store
            .cas()
            .get(&intent.manifest_object_ref)
            .map_err(|error| ApiError::internal(format!("read batch manifest: {error:#}")))?
            .ok_or_else(|| ApiError::internal("durable batch manifest is missing"))?;
        let manifest: fullmag_application::BatchExpansionManifest =
            serde_json::from_slice(&manifest_bytes)
                .map_err(|error| ApiError::internal(format!("decode batch manifest: {error}")))?;
        manifest
            .validate_integrity()
            .map_err(|error| ApiError::internal(format!("invalid batch manifest: {error:#}")))?;
        if manifest.batch_id != batch_id {
            return Err(ApiError::internal("batch manifest identity differs from its path"));
        }
        let axes = manifest
            .axes
            .iter()
            .map(|axis| ProjectBatchAxisSummaryResource {
                name: axis.name.clone(),
                canonical_unit: axis.canonical_unit.clone(),
            })
            .collect();
        let progress = store
            .read_batch_expansion_progress(&batch_id)
            .map_err(|error| ApiError::internal(format!("read batch expansion progress: {error:#}")))?;
        let published_case_count = progress.map_or(0, |progress| progress.next_case_index);
        let total_case_count = u64::try_from(manifest.cases.len())
            .map_err(|_| ApiError::internal("batch manifest case count exceeds u64"))?;
        if published_case_count > total_case_count {
            return Err(ApiError::internal(
                "batch expansion cursor exceeds the immutable manifest",
            ));
        }
        let start = if let Some(cursor) = cursor {
            fullmag_session::repository_path::validate_store_id(&cursor)
                .map_err(|error| ApiError::bad_request(format!("invalid case cursor: {error}")))?;
            manifest
                .cases
                .iter()
                .position(|case| case.case_id == cursor)
                .map(|position| position + 1)
                .ok_or_else(|| ApiError::bad_request("case cursor is not in this batch"))?
        } else {
            0
        };
        let mut page = manifest
            .cases
            .iter()
            .enumerate()
            .skip(start)
            .take(limit as usize + 1)
            .collect::<Vec<_>>();
        let has_more = page.len() > limit as usize;
        if has_more {
            page.pop();
        }
        let next_cursor = if has_more {
            page.last().map(|(_, case)| case.case_id.clone())
        } else {
            None
        };
        let cases = page
            .into_iter()
            .map(|(case_index, case)| {
                let case_index = u64::try_from(case_index)
                    .map_err(|_| ApiError::internal("batch case index exceeds u64"))?;
                let child_intent = store
                    .read_run_intent(case.specification.run_id.as_str())
                    .map_err(|error| {
                        ApiError::internal(format!("read batch child run intent: {error:#}"))
                    })?;
                let published_run = match child_intent {
                    Some(child_intent) => {
                        if case_index > published_case_count {
                            return Err(ApiError::internal(format!(
                                "batch case `{}` has a durable child beyond the contiguous expansion cursor",
                                case.case_id
                            )));
                        }
                        Some(project_batch_case_published_run(
                            &store,
                            &intent,
                            &project_id,
                            case,
                            child_intent,
                        )?)
                    }
                    None if case_index < published_case_count => {
                        return Err(ApiError::internal(format!(
                            "batch expansion cursor includes case `{}` without a durable child run",
                            case.case_id
                        )));
                    }
                    None => None,
                };
                let state = match published_run.as_ref().map(|run| run.catalog_state) {
                    Some(ProjectRunCatalogState::Materialized) => {
                        ProjectBatchCaseState::Materialized
                    }
                    Some(ProjectRunCatalogState::PendingMaterialization) => {
                        ProjectBatchCaseState::PendingMaterialization
                    }
                    None => ProjectBatchCaseState::PendingExpansion,
                };
                Ok(ProjectBatchCaseSummaryResource {
                    case_id: case.case_id.clone(),
                    planned_run_id: case.specification.run_id.as_str().into(),
                    parameter_tuple: case.parameter_tuple.clone(),
                    state,
                    published_run,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        Ok::<_, ApiError>(ProjectBatchCasesResource {
            batch_id,
            axes,
            cases,
            next_cursor,
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("batch case list task failed: {error}")))??;
    Ok(Json(resource))
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
        let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
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
        (status = 202, description = "Durable Stop command or pre-claim cancellation request accepted", body = ProjectRunTaskCancellationResource),
        (status = 200, description = "Identical cancellation request replayed", body = ProjectRunTaskCancellationResource),
        (status = 400, description = "Invalid task identity or cancellation reason"),
        (status = 404, description = "Accepted run intent is missing"),
        (status = 409, description = "Task state, catalog revision or cancellation identity conflicts")
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
    if request.reason.trim().is_empty()
        || (request.cancellation_id.is_some() && request.reason.len() > 4096)
    {
        return Err(ApiError::bad_request(
            "cancellation reason must be nonempty and at most 4096 bytes",
        ));
    }
    if request.cancellation_id.is_some() != request.expected_catalog_revision.is_some() {
        return Err(ApiError::bad_request(
            "cancellation_id and expected_catalog_revision must be supplied together",
        ));
    }
    if let Some(id) = &request.cancellation_id {
        fullmag_application::TaskId::parse(id)
            .map_err(|error| ApiError::bad_request(format!("invalid cancellation_id: {error}")))?;
        if request.expected_catalog_revision == Some(0) {
            return Err(ApiError::bad_request(
                "expected_catalog_revision must be positive",
            ));
        }
    }
    let result = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        let store = open_existing_run_store(store_root)?;
        let run_intent = store
            .read_run_intent(run_id.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("accepted run intent is missing"))?;
        let specification: RunSpecification = serde_json::from_value(run_intent.specification)
            .map_err(|error| ApiError::internal(format!("invalid durable RunSpec: {error}")))?;
        if specification.snapshot.project_id != project_id {
            return Err(ApiError::conflict("run belongs to another project"));
        }
        if let (Some(id), Some(revision)) =
            (request.cancellation_id, request.expected_catalog_revision)
        {
            let _writer = store.write_transaction().map_err(|error| {
                map_run_store_error(error, |error| {
                    ApiError::internal(format!("acquiring cancellation writer: {error:#}"))
                })
            })?;
            let (disposition, intent, current_revision) = store
                .request_task_cancellation_intent(
                    run_id.as_str(),
                    task_id.as_str(),
                    &id,
                    revision,
                    &request.reason,
                )
                .map_err(|error| {
                    map_run_store_error(error, |error| {
                        if let Some(conflict) = error.downcast_ref::<fullmag_session::TaskCancellationIntentConflict>() {
                            let code = match conflict {
                                fullmag_session::TaskCancellationIntentConflict::CatalogRevision { expected, actual } if actual > expected => "run_task_cancel_revision_conflict",
                                fullmag_session::TaskCancellationIntentConflict::IntentConflict => "run_task_cancel_identity_conflict",
                                _ => "run_task_cancel_state_conflict",
                            };
                            ApiError::conflict_with_code(code, format!("{error:#}"))
                        } else {
                            ApiError::internal(format!("recording cancellation intent: {error:#}"))
                        }
                    })
                })?;
            let catalog = store
                .read_run_catalog(run_id.as_str())
                .map_err(|error| ApiError::internal(error.to_string()))?
                .ok_or_else(|| ApiError::internal("cancellation catalog disappeared"))?;
            let task = catalog
                .tasks
                .into_iter()
                .find(|task| task.task_id == task_id.as_str())
                .ok_or_else(|| ApiError::internal("cancellation task disappeared"))?;
            let (status, disposition) = match disposition {
                fullmag_session::TaskCancellationIntentCommitDisposition::Recorded => (
                    StatusCode::ACCEPTED,
                    ProjectRunTaskCancellationDisposition::Accepted,
                ),
                fullmag_session::TaskCancellationIntentCommitDisposition::Replayed => (
                    StatusCode::OK,
                    ProjectRunTaskCancellationDisposition::Replayed,
                ),
            };
            return Ok((
                status,
                ProjectRunTaskCancellationResource::Requested(
                    ProjectRunTaskCancellationIntentResource {
                        disposition,
                        run_id: run_id.as_str().into(),
                        task_id: task_id.as_str().into(),
                        cancellation_id: intent.cancellation_id,
                        cancellation_state: ProjectRunTaskCancellationState::Requested,
                        lifecycle: ProjectRunTaskResource::from(task).lifecycle,
                        catalog_revision: current_revision,
                        expected_catalog_revision: intent.expected_catalog_revision,
                    },
                ),
            ));
        }
        let stopped = fullmag_runtime_control::request_accepted_task_stop(
            &store,
            &run_id,
            task_id.as_str(),
            &request.reason,
        )
        .map_err(|error| {
            map_run_store_error(error, |error| {
                ApiError::conflict_with_code("run_task_cancel_rejected", format!("{error:#}"))
            })
        })?;
        let (status, disposition) = match stopped.disposition {
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
            ProjectRunTaskCancellationResource::Stop(ProjectRunTaskStopResource {
                disposition,
                run_id: run_id.as_str().into(),
                task_id: task_id.as_str().into(),
                command_id: stopped.command.message_id,
                lifecycle: ProjectRunTaskLifecycle::Stopping,
                catalog_revision: stopped.catalog_revision,
            }),
        ))
    })
    .await
    .map_err(|error| ApiError::internal(format!("run cancellation task failed: {error}")))??;
    Ok((result.0, Json(result.1)))
}

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/tasks/{task_id}/retry",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable child run identity"),
        ("task_id" = String, Path, description = "Exact durable task identity")
    ),
    request_body = ProjectRunTaskRetryRequest,
    responses(
        (status = 202, description = "A fresh attempt was durably queued after terminal reconciliation", body = ProjectRunTaskRetryResource),
        (status = 200, description = "Identical retry request replayed", body = ProjectRunTaskRetryResource),
        (status = 400, description = "Invalid retry identity or catalog revision"),
        (status = 404, description = "Accepted run intent is missing"),
        (status = 409, description = "Task is not retryable, the catalog changed, terminal proof or its exact lease release is missing, or a lease is still active")
    ),
    tag = "persistence"
)]
pub async fn retry_run_task(
    Path((project_id, run_id, task_id)): Path<(String, String, String)>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectRunTaskRetryRequest>,
) -> Result<(StatusCode, Json<ProjectRunTaskRetryResource>), ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    let run_id = RunId::parse(run_id)
        .map_err(|error| ApiError::bad_request(format!("invalid run_id: {error}")))?;
    let task_id = TaskId::parse(task_id)
        .map_err(|error| ApiError::bad_request(format!("invalid task_id: {error}")))?;
    let result = tokio::task::spawn_blocking(move || {
        let store_root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        let store = open_existing_run_store(store_root)?;
        retry_run_task_in_store(&store, &project_id, &run_id, &task_id, &request)
    })
    .await
    .map_err(|error| ApiError::internal(format!("run task retry failed: {error}")))??;
    Ok((result.0, Json(result.1)))
}

fn retry_run_task_in_store(
    store: &fullmag_session::SessionStore,
    project_id: &ProjectId,
    run_id: &RunId,
    task_id: &TaskId,
    request: &ProjectRunTaskRetryRequest,
) -> Result<(StatusCode, ProjectRunTaskRetryResource), ApiError> {
    TaskId::parse(request.retry_id.clone())
        .map_err(|error| ApiError::bad_request(format!("invalid retry_id: {error}")))?;
    if request.expected_catalog_revision == 0 {
        return Err(ApiError::bad_request(
            "expected_catalog_revision must be positive",
        ));
    }
    let run_intent = store
        .read_run_intent(run_id.as_str())
        .map_err(|error| ApiError::internal(format!("reading accepted run intent: {error:#}")))?
        .ok_or_else(|| ApiError::not_found("accepted run intent is missing"))?;
    let specification: RunSpecification = serde_json::from_value(run_intent.specification)
        .map_err(|error| ApiError::internal(format!("invalid durable RunSpec: {error}")))?;
    if specification.snapshot.project_id != *project_id {
        return Err(ApiError::conflict("run belongs to another project"));
    }

    // Serialize the revision check, exit-proof check and durable decision
    // with all scheduler/catalog writes. A retry never releases a lease.
    let _writer = store
        .write_transaction()
        .map_err(|error| ApiError::internal(format!("acquiring task retry writer: {error:#}")))?;

    if let Some(existing) = store
        .read_retry_decision(run_id.as_str(), &request.retry_id)
        .map_err(|error| ApiError::internal(format!("reading retry decision: {error:#}")))?
    {
        if existing.task_id != task_id.as_str()
            || existing.action != fullmag_session::FmsRetryAction::Retry
            || existing.trigger != fullmag_session::FmsRetryTrigger::ExplicitOperatorRequest
        {
            return Err(ApiError::conflict_with_code(
                "run_task_retry_identity_conflict",
                "retry_id is already bound to a different durable decision",
            ));
        }
        ensure_retry_terminal_proof(&store, &existing)?;
        let catalog = store
            .read_run_catalog(run_id.as_str())
            .map_err(|error| ApiError::internal(format!("reading retried run catalog: {error:#}")))?
            .ok_or_else(|| ApiError::internal("retried run catalog disappeared"))?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id.as_str())
            .ok_or_else(|| ApiError::internal("retried task disappeared from its catalog"))?;
        let decision_still_fences_task = task.attempt_id.as_deref()
            == Some(existing.attempt_id.as_str())
            && task.ownership_epoch == Some(existing.ownership_epoch);
        if decision_still_fences_task {
            if !matches!(
                task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Failed
                    | fullmag_session::FmsTaskLifecycle::Interrupted
            ) {
                return Err(ApiError::conflict_with_code(
                    "run_task_retry_state_conflict",
                    "the task changed state before its durable retry decision was applied",
                ));
            }
            if store
                .read_active_resource_lease_for_retry_decision(&existing)
                .map_err(|error| ApiError::internal(format!("checking retry lease: {error:#}")))?
                .is_some()
            {
                return Err(ApiError::conflict_with_code(
                    "run_task_retry_lease_active",
                    "the previous worker lease is still active; refresh after reconciliation",
                ));
            }
            store
                .apply_retry_decision(&existing)
                .map_err(|error| ApiError::internal(format!(
                    "recovering the durable retry decision: {error:#}"
                )))?;
        }
        let catalog = store
            .read_run_catalog(run_id.as_str())
            .map_err(|error| ApiError::internal(format!("reading reconciled retry catalog: {error:#}")))?
            .ok_or_else(|| ApiError::internal("reconciled retry catalog disappeared"))?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id.as_str())
            .ok_or_else(|| ApiError::internal("reconciled retry task disappeared"))?;
        return Ok((
            StatusCode::OK,
            ProjectRunTaskRetryResource {
                disposition: ProjectRunTaskRetryDisposition::Replayed,
                run_id: run_id.as_str().into(),
                task_id: task_id.as_str().into(),
                retry_id: existing.decision_id,
                previous_attempt_id: existing.attempt_id,
                previous_ownership_epoch: existing.ownership_epoch,
                lifecycle: ProjectRunTaskLifecycle::from(task.lifecycle),
                catalog_revision: catalog.revision,
            },
        ));
    }

    let catalog = store
        .read_run_catalog(run_id.as_str())
        .map_err(|error| ApiError::internal(format!("reading run catalog for retry: {error:#}")))?
        .ok_or_else(|| ApiError::conflict("task catalog has not been materialized"))?;
    if catalog.revision != request.expected_catalog_revision {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_revision_conflict",
            format!(
                "task catalog revision changed from {} to {}; refresh before retrying",
                request.expected_catalog_revision, catalog.revision
            ),
        ));
    }
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id.as_str())
        .cloned()
        .ok_or_else(|| ApiError::not_found("task is missing from the run catalog"))?;
    if !matches!(
        task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Failed
            | fullmag_session::FmsTaskLifecycle::Interrupted
    ) {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_state_conflict",
            "only failed or interrupted tasks can be retried",
        ));
    }
    let (Some(attempt_id), Some(ownership_epoch), Some(resource_id)) = (
        task.attempt_id.as_deref(),
        task.ownership_epoch,
        task.resource_id.as_deref(),
    ) else {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_terminal_proof_required",
            "retry requires a reconciled task attempt and resource identity",
        ));
    };

    let mut matching_receipts = store
        .list_worker_process_exit_receipts(run_id.as_str())
        .map_err(|error| ApiError::internal(format!("reading worker exit receipts: {error:#}")))?
        .into_iter()
        .filter(|receipt| {
            receipt.task_id == task_id.as_str()
                && receipt.attempt_id == attempt_id
                && receipt.ownership_epoch == ownership_epoch
                && receipt.run_id == run_id.as_str()
                && receipt.resource_id == resource_id
        })
        .collect::<Vec<_>>();
    if matching_receipts.len() != 1 {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_terminal_proof_required",
            "retry requires one durable process-exit receipt for the current attempt",
        ));
    }
    let receipt = matching_receipts
        .pop()
        .ok_or_else(|| ApiError::internal("matching worker exit receipt disappeared"))?;
    receipt
        .validate_for_task(&task)
        .map_err(|error| ApiError::internal(format!("invalid worker exit receipt: {error:#}")))?;
    if receipt.status_success || receipt.stop_requested {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_terminal_proof_required",
            "successful or operator-stopped attempts cannot be retried",
        ));
    }

    let prior_attempt_decision = store
        .list_retry_decisions(run_id.as_str())
        .map_err(|error| ApiError::internal(format!("reading existing retry decisions: {error:#}")))?
        .into_iter()
        .find(|decision| {
            decision.task_id == task_id.as_str()
                && decision.attempt_id == attempt_id
                && decision.ownership_epoch == ownership_epoch
        });
    if let Some(existing) = prior_attempt_decision {
        if existing.action != fullmag_session::FmsRetryAction::Retry {
            return Err(ApiError::conflict_with_code(
                "run_task_retry_already_decided",
                "a different durable decision already exists for the current attempt",
            ));
        }
        ensure_retry_terminal_proof(&store, &existing)?;
        if store
            .read_active_resource_lease_for_retry_decision(&existing)
            .map_err(|error| ApiError::internal(format!("checking recovered retry lease: {error:#}")))?
            .is_some()
        {
            return Err(ApiError::conflict_with_code(
                "run_task_retry_lease_active",
                "the previous worker lease is still active; refresh after reconciliation",
            ));
        }
        store
            .apply_retry_decision(&existing)
            .map_err(|error| ApiError::internal(format!(
                "recovering the existing durable retry decision: {error:#}"
            )))?;
        let catalog = store
            .read_run_catalog(run_id.as_str())
            .map_err(|error| ApiError::internal(format!("reading recovered retry catalog: {error:#}")))?
            .ok_or_else(|| ApiError::internal("recovered retry catalog disappeared"))?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id.as_str())
            .ok_or_else(|| ApiError::internal("recovered retry task disappeared"))?;
        return Ok((
            StatusCode::OK,
            ProjectRunTaskRetryResource {
                disposition: ProjectRunTaskRetryDisposition::Replayed,
                run_id: run_id.as_str().into(),
                task_id: task_id.as_str().into(),
                retry_id: existing.decision_id,
                previous_attempt_id: existing.attempt_id,
                previous_ownership_epoch: existing.ownership_epoch,
                lifecycle: ProjectRunTaskLifecycle::from(task.lifecycle),
                catalog_revision: catalog.revision,
            },
        ));
    }

    let decision = fullmag_session::FmsRetryDecision {
        schema_version: fullmag_session::FMS_RETRY_DECISION_SCHEMA.into(),
        decision_id: request.retry_id.clone(),
        run_id: run_id.as_str().into(),
        task_id: task_id.as_str().into(),
        attempt_id: attempt_id.into(),
        ownership_epoch,
        trigger: fullmag_session::FmsRetryTrigger::ExplicitOperatorRequest,
        action: fullmag_session::FmsRetryAction::Retry,
        reason: "explicit local operator retry".into(),
        created_at: Utc::now(),
    };
    ensure_retry_terminal_proof(&store, &decision)?;
    if store
        .read_active_resource_lease_for_retry_decision(&decision)
        .map_err(|error| ApiError::internal(format!("checking terminal retry lease: {error:#}")))?
        .is_some()
    {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_lease_active",
            "the previous worker lease is still active; refresh after reconciliation",
        ));
    }
    store
        .commit_retry_decision(&decision)
        .map_err(|error| ApiError::internal(format!(
            "persisting the durable retry decision: {error:#}"
        )))?;
    store
        .apply_retry_decision(&decision)
        .map_err(|error| ApiError::internal(format!("applying the durable retry decision: {error:#}")))?;
    let retried_catalog = store
        .read_run_catalog(run_id.as_str())
        .map_err(|error| ApiError::internal(format!("reading queued retry catalog: {error:#}")))?
        .ok_or_else(|| ApiError::internal("queued retry catalog disappeared"))?;
    let retried_task = retried_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id.as_str())
        .ok_or_else(|| ApiError::internal("queued retry task disappeared"))?;
    Ok((
        StatusCode::ACCEPTED,
        ProjectRunTaskRetryResource {
            disposition: ProjectRunTaskRetryDisposition::Accepted,
            run_id: run_id.as_str().into(),
            task_id: task_id.as_str().into(),
            retry_id: decision.decision_id,
            previous_attempt_id: decision.attempt_id,
            previous_ownership_epoch: decision.ownership_epoch,
            lifecycle: ProjectRunTaskLifecycle::from(retried_task.lifecycle),
            catalog_revision: retried_catalog.revision,
        },
    ))

}

fn ensure_retry_terminal_proof(
    store: &fullmag_session::SessionStore,
    decision: &fullmag_session::FmsRetryDecision,
) -> Result<(), ApiError> {
    let matching_receipts = store
        .list_worker_process_exit_receipts(&decision.run_id)
        .map_err(|error| ApiError::internal(format!("reading retry terminal proof: {error:#}")))?
        .into_iter()
        .filter(|receipt| {
            receipt.run_id == decision.run_id
                && receipt.task_id == decision.task_id
                && receipt.attempt_id == decision.attempt_id
                && receipt.ownership_epoch == decision.ownership_epoch
        })
        .collect::<Vec<_>>();
    if matching_receipts.len() != 1 {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_terminal_proof_required",
            "retry requires one durable process-exit receipt for the previous attempt",
        ));
    }
    let receipt = matching_receipts
        .first()
        .ok_or_else(|| ApiError::internal("matching worker exit receipt disappeared"))?;
    receipt
        .validate()
        .map_err(|error| ApiError::internal(format!("invalid worker exit receipt: {error:#}")))?;
    if receipt.status_success || receipt.stop_requested {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_terminal_proof_required",
            "successful or operator-stopped attempts cannot be retried",
        ));
    }

    let lease = store
        .read_resource_lease(&receipt.run_id, &receipt.resource_id, &receipt.lease_token)
        .map_err(|error| ApiError::internal(format!("reading retry terminal lease: {error:#}")))?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "run_task_retry_lease_release_required",
                "retry requires the exact previous resource lease to be durably released",
            )
        })?;
    if !worker_exit_receipt_matches_released_lease(receipt, &lease) {
        return Err(ApiError::conflict_with_code(
            "run_task_retry_lease_release_required",
            "retry requires the exact previous resource lease to be durably released",
        ));
    }
    Ok(())
}

fn worker_exit_receipt_matches_released_lease(
    receipt: &fullmag_session::FmsWorkerProcessExitReceipt,
    lease: &fullmag_session::FmsResourceLease,
) -> bool {
    lease.state == fullmag_session::FmsResourceLeaseState::Released
        && lease.released_at.is_some()
        && lease.run_id == receipt.run_id
        && lease.task_id == receipt.task_id
        && lease.attempt_id == receipt.attempt_id
        && lease.ownership_epoch == receipt.ownership_epoch
        && lease.resource_id == receipt.resource_id
        && lease.lease_token == receipt.lease_token
        && lease.heartbeat_sequence == receipt.lease_heartbeat_sequence
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

    #[test]
    fn retry_requires_the_exact_released_lease_for_its_exit_receipt() {
        let receipt = fullmag_session::FmsWorkerProcessExitReceipt {
            schema_version: fullmag_session::FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "receipt-1".into(),
            run_id: "run-1".into(),
            task_id: "task-1".into(),
            attempt_id: "attempt-1".into(),
            ownership_epoch: 1,
            resource_id: "resource-1".into(),
            lease_token: "lease-1".into(),
            lease_heartbeat_sequence: 4,
            process_id: 123,
            process_start_token: None,
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            stop_requested: false,
            failure_reason: Some("worker failed".into()),
            observed_at: chrono::Utc::now(),
        };
        let now = chrono::Utc::now();
        let lease = fullmag_session::FmsResourceLease {
            schema_version: fullmag_session::FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: receipt.resource_id.clone(),
            kind: fullmag_session::FmsResourceKind::Cpu,
            budget: fullmag_session::FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 0,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            run_id: receipt.run_id.clone(),
            task_id: receipt.task_id.clone(),
            attempt_id: receipt.attempt_id.clone(),
            ownership_epoch: receipt.ownership_epoch,
            lease_token: receipt.lease_token.clone(),
            state: fullmag_session::FmsResourceLeaseState::Released,
            acquired_at: now.clone(),
            heartbeat_at: now.clone(),
            heartbeat_sequence: receipt.lease_heartbeat_sequence,
            released_at: Some(now),
            host_launch_binding: None,
        };

        assert!(worker_exit_receipt_matches_released_lease(&receipt, &lease));

        let mut active_lease = lease.clone();
        active_lease.state = fullmag_session::FmsResourceLeaseState::Active;
        active_lease.released_at = None;
        assert!(!worker_exit_receipt_matches_released_lease(
            &receipt,
            &active_lease
        ));

        let mut stale_lease = lease.clone();
        stale_lease.heartbeat_sequence -= 1;
        assert!(!worker_exit_receipt_matches_released_lease(
            &receipt,
            &stale_lease
        ));
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
        let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
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
                let mut task_execution_by_id = project_run_task_execution_by_id(
                    &store,
                    &intent,
                    &specification,
                )?;
                let has_immutable_study_refs = task_execution_by_id.is_some();
                let mut tasks = Vec::with_capacity(catalog.tasks.len());
                for task in catalog.tasks {
                    let execution = task_execution_by_id
                        .as_mut()
                        .and_then(|entries| entries.remove(&task.task_id));
                    if has_immutable_study_refs && execution.is_none() {
                        return Err(ApiError::internal(format!(
                            "durable task `{}` has no matching immutable Study step",
                            task.task_id
                        )));
                    }
                    tasks.push(project_run_task_resource(
                        &store,
                        run_id.as_str(),
                        artifact_catalog.as_ref(),
                        catalog.revision,
                        execution,
                        task,
                    )?);
                }
                if task_execution_by_id.is_some_and(|entries| !entries.is_empty()) {
                    return Err(ApiError::internal(
                        "accepted Study catalog contains steps without durable run tasks",
                    ));
                }
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
    let mut draft = application
        .current_document()
        .cloned()
        .ok_or_else(|| ApiError::internal("project application has no current document"))?;
    // Only a freshly created project is known to have no historical runs.
    draft.opaque_documents.push(
        OpaqueDocument::new(
            super::script_project::PROVENANCE_PATH,
            br#"{"authors":[],"history":[],"runs":[]}"#.to_vec(),
        )
        .map_err(|error| ApiError::internal(format!("invalid provenance path: {error}")))?,
    );
    let view = application
        .replace_draft(draft, view.revision)
        .map_err(|error| ApiError::internal(format!("initialize project provenance: {error}")))?;
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
    let authoring_scene_document = opened_authoring_scene(&application, &opened.view);
    let mut resource = resource_from_application(&application, opened.view, archive)?;
    resource.authoring_scene_document = authoring_scene_document;
    Ok(Json(resource))
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
    let renderable = !scene_document.objects.is_empty()
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
        let rendered = crate::script::try_render_scene_document_for_persistence(
            repo_root,
            &private_dir,
            &generated_source_path,
            &scene_document,
        )?;
        if let Some(rendered) = rendered {
            let generated_source = read_generated_source(&generated_source_path)?;
            if rendered.bytes_written != generated_source.len() {
                return Err(ApiError::internal(
                    "canonical SceneDocument render helper byte count is inconsistent",
                ));
            }
            Some(generated_source)
        } else {
            None
        }
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

pub(super) fn map_authoring_application_error(
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

pub(super) fn encode_current(
    application: &ProjectApplication<FileProjectRepository>,
) -> Result<Vec<u8>, ApiError> {
    let document = application
        .current_document()
        .ok_or_else(|| ApiError::internal("project application has no current document"))?;
    FileProjectRepository::new()
        .encode_archive(document)
        .map_err(|error| ApiError::bad_request(format!("project archive is not writable: {error}")))
}

fn opened_authoring_scene(
    application: &ProjectApplication<FileProjectRepository>,
    view: &fullmag_application::DocumentView,
) -> Option<std::collections::BTreeMap<String, Value>> {
    if !view.mode.is_writable() || !view.migration.can_write || view.migration.migrated
        || view.schema_version != fullmag_application::CURRENT_PROJECT_SCHEMA
        || view.migration.source_schema != fullmag_application::CURRENT_PROJECT_SCHEMA
        || view.source_hash.is_none()
    {
        return None;
    }
    let document = application.current_document()?;
    if !document.assets.is_empty()
        || !document.raw_definition.unknown_object_fields(
            ["schema", "project_id", "name", "revision", "scene"]).is_empty()
        || document.opaque_documents.iter().any(|entry| {
            if matches!(entry.path(),
                "project/provenance.json" | "project/source/script.py" | "project/source/script.json")
            {
                return false;
            }
            // Accept only the exact content-addressed history emitted by this writer.
            entry.path() != format!("project/source-history/{:x}.py", Sha256::digest(entry.bytes()))
        })
    {
        return None;
    }
    let provenance = document.opaque_documents.iter()
        .find(|entry| entry.path() == super::script_project::PROVENANCE_PATH)?;
    let raw: Value = serde_json::from_slice(provenance.bytes()).ok()?;
    // The display parser drops malformed records. Never infer "no runs" from it.
    if !raw.get("runs")?.as_array()?.is_empty() { return None; }
    let parsed = fullmag_workspace_inspect::provenance::parse_provenance(provenance.bytes()).ok()?;
    for key in ["authors", "history", "runs"] {
        if raw.get(key)?.as_array()? != parsed.get(key)?.as_array()? { return None; }
    }
    if raw.as_object()?.keys().any(|key| !matches!(key.as_str(), "authors" | "history" | "runs" | "citation"))
        || raw["history"].as_array()?.iter().any(|entry|
            !matches!(entry["kind"].as_str(), Some("import" | "edit")) || entry.get("run_id").is_some())
    {
        return None;
    }
    let raw_scene = document.definition.scene.value();
    if raw_scene.get("version")?.as_str()? != "scene.v2" { return None; }
    let scene: SceneDocument = serde_json::from_value(raw_scene.clone()).ok()?;
    validate_scene_document_for_authoring(&scene).ok()?;
    // Structural drafts can retain unsupported execution strings as evidence;
    // an activation projection still requires the canonical backend contract.
    serde_json::from_value::<fullmag_ir::BackendTarget>(Value::String(
        scene.study.requested_backend.trim().to_ascii_lowercase(),
    )).ok()?;
    let projected = authoring_scene_wire_projection(raw_scene, &scene)?;
    if !raw_scene_survives_projection(raw_scene, &projected)
        || scene_references_unmaterialized_assets(&projected)
    {
        return None;
    }
    // Open has no asset materialization lease; external fields remain evidence-only.
    if scene.study.initial_state.is_some()
        || scene.magnetization_assets.iter().any(|asset| asset.source_path.is_some())
    {
        return None;
    }
    Some(raw_scene.as_object()?.iter().map(|(key, value)| (key.clone(), value.clone())).collect())
}


/// Compare Python's redundant Universe wire names with the canonical typed
/// values without changing the serialization used by checkpoint identities.
fn authoring_scene_wire_projection(raw: &Value, scene: &SceneDocument) -> Option<Value> {
    let mut projected = serde_json::to_value(scene).ok()?;
    for owner in ["/universe", "/study/universe_mesh"] {
        let Some(supplied) = raw.pointer(owner).and_then(Value::as_object) else { continue; };
        let canonical = projected.pointer_mut(owner)?.as_object_mut()?;
        for (current, legacy) in [
            ("maximum_element_size", "airbox_hmax"),
            ("minimum_element_size", "airbox_hmin"),
            ("curvature_factor", "airbox_curvature_factor"),
            ("narrow_region_resolution", "airbox_narrow_region_resolution"),
        ] {
            if supplied.contains_key(current) {
                // Values come only from the validated typed state, never raw JSON.
                let value = canonical.get(legacy).cloned().unwrap_or(Value::Null);
                canonical.insert(current.into(), value);
            }
        }
        for field in ["size", "center", "padding", "airbox_hmax", "airbox_hmin",
            "airbox_growth_rate", "airbox_grading", "airbox_curvature_factor",
            "airbox_narrow_region_resolution"] {
            if supplied.get(field) == Some(&Value::Null) && !canonical.contains_key(field) {
                canonical.insert(field.into(), Value::Null);
            }
        }
    }
    Some(projected)
}

/// Supplied semantic values must survive typed projection. Only exact empty
/// placeholders emitted by the canonical Python scene producer may be omitted.
fn raw_scene_survives_projection(raw: &Value, projected: &Value) -> bool {
    fn at<'a>(raw: &'a Value, projected: &Value, path: &mut Vec<&'a str>) -> bool {
        match (raw, projected) {
            (Value::Object(raw), Value::Object(projected)) => raw.iter().all(|(key, value)| {
                path.push(key);
                let survives = match projected.get(key) {
                    Some(next) => at(value, next, path),
                    None => known_omitted_scene_default(path, value),
                };
                path.pop();
                survives
            }),
            (Value::Array(raw), Value::Array(projected)) => {
                raw.len() == projected.len() && raw.iter().zip(projected).all(|(a, b)| {
                    path.push("*");
                    let survives = at(a, b, path);
                    path.pop();
                    survives
                })
            }
            (Value::Number(a), Value::Number(b)) => exact_projected_number(a, b),
            _ => raw == projected,
        }
    }
    at(raw, projected, &mut Vec::new())
}

/// These are complete owner paths, never field-name or generic empty-value
/// exceptions. Some Python mesh/solver placeholders have no Rust realization;
/// their nonempty values remain evidence-only rather than implying support.
fn known_omitted_scene_default(path: &[&str], value: &Value) -> bool {
    let Some((field, owner)) = path.split_last() else { return false; };
    let empty_array = value.as_array().is_some_and(Vec::is_empty);
    let empty_object = value.as_object().is_some_and(serde_json::Map::is_empty);
    match owner {
        [] => (value.is_null() && *field == "universe") || (empty_array && matches!(*field,
            "objects" | "couplings" | "materials" | "magnetization_assets" | "selections"
            | "magnetization_constraints" | "current_transports" | "spin_transports"
            | "spin_torques" | "oersted_fields" | "antenna_port_modes"
            | "antenna_field_solve_stages" | "antenna_target_projections"
            | "solved_antenna_drives" | "antenna_spectrum_requests")),
        ["current_modules"] => (empty_array && *field == "modules")
            || (value.is_null() && *field == "excitation_analysis"),
        ["field_drives"] => empty_array && *field == "drives",
        ["monitors"] => empty_array && *field == "planar",
        ["outputs"] => empty_array && *field == "items",
        ["editor"] => (value.is_null() && matches!(*field,
            "selected_object_id" | "gizmo_mode" | "transform_space" | "selected_entity_id"
            | "focused_entity_id" | "object_view_mode" | "air_mesh_visible"
            | "air_mesh_opacity" | "active_visualization_preset_ref" | "active_transform_scope"))
            || (empty_object && *field == "mesh_entity_view_state")
            || (empty_array && *field == "visualization_presets"),
        ["objects", "*"] => (value.is_null() && matches!(*field,
            "region_name" | "magnetization_ref" | "object_mesh" | "mesh_override"
            | "absorbing_boundary" | "notes"))
            || (empty_array && matches!(*field, "physics_stack" | "regions"
                | "allocated_region_ids" | "material_parameter_fields" | "tags"))
            || (empty_object && matches!(*field, "region_overrides" | "visualization_hint")),
        ["study"] => (value.is_null() && matches!(*field,
            "backend" | "requested_cpu_threads" | "fem_demag_solver_policy" | "demag_realization"
            | "fdm" | "external_field" | "rotated_interfacial_dmi" | "universe_mesh"
            | "study_pipeline" | "table_autosave" | "output_storage" | "execution_profile"
            | "initial_state")) || (empty_array && matches!(*field,
                "mesh_interfaces" | "stages" | "execution_layers")),
        ["study", "solver"] => value.as_str() == Some("")
            && matches!(*field, "gamma" | "max_relaxation_time_s"),
        ["study", "mesh_defaults" | "shared_domain_mesh"]
        | ["objects", "*", "object_mesh" | "mesh_override"] => {
            let per_object = owner[0] == "objects";
            (empty_array && matches!(*field, "boundary_layer_target_curve_selectors"
                | "boundary_layer_target_curve_tags" | "boundary_layer_target_surface_selectors"
                | "boundary_layer_target_surface_tags"))
                || (value.is_null() && matches!(*field, "boundary_layer_count"
                    | "boundary_layer_stretching" | "resolved_narrow_regions"
                    | "resolved_size_from_curvature"))
                || (value.as_str() == Some("") && matches!(*field, "boundary_layer_thickness"
                    | "interface_maximum_element_size"))
                || (!per_object && value.as_str() == Some("") && matches!(*field,
                    "corner_extent" | "corner_maximum_element_size" | "corner_transition_distance"
                    | "edge_maximum_element_size" | "edge_thickness" | "edge_transition_distance"))
                || (per_object && empty_array && matches!(*field, "operations" | "size_fields"))
                || (per_object && value.is_null() && matches!(*field,
                    "algorithm_2d" | "algorithm_3d" | "calibrate_for" | "compute_quality"
                    | "element_family" | "exact_layer_count" | "mesh_strategy" | "narrow_regions"
                    | "optimize" | "optimize_iterations" | "order" | "per_element_quality"
                    | "size_factor" | "size_from_curvature" | "size_preset" | "smoothing_steps"
                    | "source" | "sweep_direction" | "sweep_face_meshing" | "through_thickness_distribution"
                    | "through_thickness_element_ratio" | "through_thickness_elements"
                    | "through_thickness_symmetric" | "topology" | "transition_growth" | "transition_policy"))
        }
        _ => false,
    }
}

fn exact_projected_number(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    if a == b { return true; }
    let (integer, float) = if a.is_f64() { (b, a) } else { (a, b) };
    if !float.is_f64() { return false; }
    let Some(value) = float.as_f64() else { return false; };
    if !value.is_finite() || value.fract() != 0.0 { return false; }
    if let Some(integer) = integer.as_u64() {
        value >= 0.0 && value < 18_446_744_073_709_551_616.0 && value as u64 == integer
    } else if let Some(integer) = integer.as_i64() {
        value >= -9_223_372_036_854_775_808.0 && value < 9_223_372_036_854_775_808.0
            && value as i64 == integer
    } else {
        false
    }
}

/// Open has no archive-asset materialization owner. Conservatively retain
/// asset-bearing authoring payloads as evidence, including opaque extensions.
fn scene_references_unmaterialized_assets(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            key == "asset_id"
                || (matches!(key.as_str(), "source_path" | "mode_basis_ref" | "equilibrium_ref")
                    && value.as_str().is_some_and(|text| !text.trim().is_empty()))
                || scene_references_unmaterialized_assets(value)
        }),
        Value::Array(items) => items.iter().any(scene_references_unmaterialized_assets),
        _ => false,
    }
}

pub(super) fn resource_from_application(
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
        authoring_scene_document: None,
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

#[cfg(test)]
mod authoring_open_tests {
    use super::*;
    use serde_json::json;

    fn opened(provenance: Value) -> (ProjectApplication<FileProjectRepository>, fullmag_application::DocumentView) {
        let mut application = ProjectApplication::new(FileProjectRepository::new());
        let created = application.create(CreateProjectRequest::new("Archived authoring")).unwrap();
        let mut draft = application.current_document().unwrap().clone();
        draft.replace_scene(RawJsonEnvelope::from_value(json!({
            "version":"scene.v2","revision":11,
            "study":{"requested_backend":"fem","requested_device":"cpu","requested_precision":"double"}
        })).unwrap()).unwrap();
        for (path, bytes) in [
            ("project/provenance.json", serde_json::to_vec(&provenance).unwrap()),
            ("project/source/script.py", b"raise RuntimeError('must never execute')".to_vec()),
            ("project/source/script.json", b"{}".to_vec()),
        ] {
            draft.opaque_documents.push(OpaqueDocument::new(path,bytes).unwrap());
        }
        application.replace_draft(draft,created.revision).unwrap();
        let bytes = application.repository().encode_archive(application.current_document().unwrap()).unwrap();
        let mut reopened = ProjectApplication::new(FileProjectRepository::new());
        let result = reopened.open(ProjectSource::Bytes { display_name:"authoring.fms".into(),bytes }).unwrap();
        (reopened,result.view)
    }

    fn provenance() -> Value {
        json!({"authors":[],"history":[{"revision":0,"at":"2026-10-20T00:00:00Z","kind":"import","summary":"Original source"}],"runs":[]})
    }

    #[test]
    fn authoring_projection_uses_owner_parsed_archive_without_changing_source() {
        let (application,view) = opened(provenance());
        let before=application.current_document().unwrap().clone();
        let scene=opened_authoring_scene(&application,&view).unwrap();
        assert_eq!(scene["version"],"scene.v2");
        assert_eq!(scene["revision"],11);
        assert_eq!(application.current_document().unwrap(),&before);
        assert_eq!(view.project_id,before.definition.project_id);
        assert_eq!(view.revision,before.definition.revision);
    }

    #[test]
    fn universe_aliases_survive_archive_open_without_unknown_field_exceptions() {
        for owner in ["/universe", "/study/universe_mesh"] {
            for universe in [
                json!({"mode":"auto","size":null,"airbox_hmax":5e-7,"airbox_hmin":1.5e-7}),
                json!({"mode":"auto","size":null,"maximum_element_size":5e-7,"minimum_element_size":1.5e-7}),
                json!({"mode":"auto","size":null,"airbox_hmax":5e-7,"airbox_hmin":1.5e-7,
                    "maximum_element_size":5e-7,"minimum_element_size":1.5e-7}),
            ] {
                let (mut application, view) = opened(provenance());
                let mut draft = application.current_document().unwrap().clone();
                let mut raw = draft.definition.scene.value().clone();
                if owner == "/universe" {
                    raw["universe"] = universe;
                } else {
                    raw["study"]["universe_mesh"] = universe;
                }
                draft.replace_scene(RawJsonEnvelope::from_value(raw.clone()).unwrap()).unwrap();
                application.replace_draft(draft, view.revision).unwrap();
                let bytes = application.repository().encode_archive(application.current_document().unwrap()).unwrap();
                let mut cold = ProjectApplication::new(FileProjectRepository::new());
                let result = cold.open(ProjectSource::Bytes { display_name:"universe.fms".into(), bytes }).unwrap();
                let before = cold.current_document().unwrap().clone();
                let projected = opened_authoring_scene(&cold, &result.view).unwrap();
                assert_eq!(serde_json::to_value(projected).unwrap(), raw);
                assert_eq!(cold.current_document().unwrap(), &before);

                for unknown in [Value::Null, json!({}), json!([]), json!("future")] {
                    let mut unknown_raw = raw.clone();
                    unknown_raw.pointer_mut(owner).unwrap().as_object_mut().unwrap().insert("future".into(), unknown);
                    let scene: SceneDocument = serde_json::from_value(unknown_raw.clone()).unwrap();
                    let projected = authoring_scene_wire_projection(&unknown_raw, &scene).unwrap();
                    assert!(!raw_scene_survives_projection(&unknown_raw, &projected));
                }
                let mut conflict = raw;
                let universe = conflict.pointer_mut(owner).unwrap().as_object_mut().unwrap();
                universe.insert("airbox_hmax".into(), json!(5e-7));
                universe.insert("maximum_element_size".into(), json!(6e-7));
                assert!(serde_json::from_value::<SceneDocument>(conflict).is_err());
            }
        }
    }

    #[test]
    fn historical_malformed_missing_and_read_only_inputs_have_no_activation_projection() {
        for change in 0..7 {
            let mut provenance=provenance();
            match change {
                0 => provenance["runs"]=json!([{"unrecognised":"must not disappear"}]),
                1 => { provenance.as_object_mut().unwrap().remove("runs"); }
                2 => provenance["history"][0]["kind"]=json!("run"),
                3 => provenance["history"][0]["run_id"]=json!("accepted-run"),
                4 => provenance["authors"]=json!([{}]),
                5 => provenance["accepted_provenance"]=json!({}),
                _ => {}
            }
            let (application,mut view)=opened(provenance);
            if change==6 { view.mode=DocumentMode::ReadOnly {reason:"legacy execution archive".into()}; }
            assert!(opened_authoring_scene(&application,&view).is_none(),"change {change}");
        }
    }

    #[test]
    fn unresolved_assets_and_unknown_documents_remain_evidence_only() {
        for change in 0..5 {
            let (mut application,view)=opened(provenance());
            let mut draft=application.current_document().unwrap().clone();
            if change==0 {
                draft.assets.push(fullmag_application::OpaqueAsset::new("project/assets/mesh.dat",b"unresolved".to_vec(),None).unwrap());
            } else if change==1 {
                draft.opaque_documents.push(OpaqueDocument::new("project/accepted_provenance.json",b"{}".to_vec()).unwrap());
            } else {
                let mut scene = draft.definition.scene.value().clone();
                if change == 2 {
                    scene["study"]["requested_backend"] = json!("unknown");
                } else if change == 3 {
                    scene["study"]["initial_state"] = json!({"source_path":"missing.ovf","format":"ovf"});
                } else {
                    scene["magnetization_assets"] = json!([{"id":"external","name":"External","kind":"uniform","source_path":"missing.ovf"}]);
                }
                draft.replace_scene(RawJsonEnvelope::from_value(scene).unwrap()).unwrap();
            }
            application.replace_draft(draft,view.revision).unwrap();
            assert!(opened_authoring_scene(&application,&application.current().unwrap()).is_none(),"change {change}");
        }
    }

    #[test]
    fn omitted_defaults_survive_without_allowing_unknown_null_or_empty_fields() {
        let raw = json!({"version":"scene.v2","study":{"requested_backend":"fem"}});
        let scene: SceneDocument = serde_json::from_value(raw.clone()).unwrap();
        let projected = serde_json::to_value(&scene).unwrap();
        assert!(raw_scene_survives_projection(&raw, &projected));
        for unknown in [Value::Null, json!({}), json!([]), json!(""), json!("future")] {
            let mut raw = raw.clone();
            raw["study"]["future"] = unknown;
            assert!(!raw_scene_survives_projection(&raw, &projected));
        }
        // A known canonical empty collection carries no authored semantic state.
        assert!(raw_scene_survives_projection(&json!({"objects":[]}), &json!({})));
    }

    #[test]
    fn canonical_placeholder_exceptions_are_owner_and_value_exact() {
        for (owner, field, empty) in [
            ("/study/solver", "max_relaxation_time_s", json!("")),
            ("/study/mesh_defaults", "boundary_layer_count", Value::Null),
            ("/study/mesh_defaults", "boundary_layer_thickness", json!("")),
            ("/study/shared_domain_mesh", "boundary_layer_target_surface_tags", json!([])),
            ("/objects/0/mesh_override", "boundary_layer_thickness", json!("")),
        ] {
            let projected = json!({"study":{"solver":{},"mesh_defaults":{},"shared_domain_mesh":{}},
                "objects":[{"mesh_override":{}}]});
            let mut raw = projected.clone();
            raw.pointer_mut(owner).unwrap().as_object_mut().unwrap().insert(field.into(), empty.clone());
            assert!(raw_scene_survives_projection(&raw, &projected), "{owner}/{field}");
            for semantic in [json!("authored"), json!(1), json!([1]), json!({"value":1})] {
                raw.pointer_mut(owner).unwrap().as_object_mut().unwrap().insert(field.into(), semantic);
                assert!(!raw_scene_survives_projection(&raw, &projected), "{owner}/{field}");
            }
            // A valid placeholder name at an unrecognized owner is not an exception.
            assert!(!raw_scene_survives_projection(&json!({"extension":{(field):empty}}),
                &json!({"extension":{}})));
        }
        for empty in [Value::Null, json!({}), json!([]), json!("")] {
            assert!(!raw_scene_survives_projection(
                &json!({"study/solver/max_relaxation_time_s":empty}), &json!({})));
            assert!(!raw_scene_survives_projection(
                &json!({"study":{"solver":{"future":empty}}}), &json!({"study":{"solver":{}}})));
        }
    }

    #[test]
    fn unknown_nested_object_geometry_transform_and_tagged_fields_are_evidence_only() {
        let base = json!({
            "version":"scene.v2","revision":11,
            "objects":[{"id":"body","name":"Body","role":"geometry","material_ref":"",
                "geometry":{"geometry_kind":"Box","geometry_params":{"size":[1e-6,1e-6,1e-6]}},
                "transform":{"translation":[0,0,0]}}],
            "study":{"requested_backend":"fem","requested_device":"cpu","requested_precision":"double"}
        });
        for path in ["/objects/0", "/objects/0/geometry", "/objects/0/transform"] {
            for unknown in [Value::Null, json!({}), json!([]), json!(""), json!("preserve me")] {
                let mut raw = base.clone();
                raw.pointer_mut(path).unwrap().as_object_mut().unwrap().insert("future".into(), unknown);
                let scene: SceneDocument = serde_json::from_value(raw.clone()).unwrap();
                assert!(!raw_scene_survives_projection(&raw, &serde_json::to_value(&scene).unwrap()), "{path}");
                let (mut application, view) = opened(provenance());
                let mut draft = application.current_document().unwrap().clone();
                draft.replace_scene(RawJsonEnvelope::from_value(raw).unwrap()).unwrap();
                let current = application.replace_draft(draft, view.revision).unwrap();
                assert!(opened_authoring_scene(&application, &current).is_none());
            }
        }
        let raw = json!({"kind":"constant","value":1.0,"future":null});
        let field: fullmag_authoring::SceneMaterialParameterField = serde_json::from_value(raw.clone()).unwrap();
        assert!(!raw_scene_survives_projection(&raw, &serde_json::to_value(field).unwrap()));
    }

    #[test]
    fn numeric_projection_has_no_tolerance_or_large_integer_rounding() {
        for (raw, projected, expected) in [
            (json!(1), json!(1.0), true),
            (json!(-1), json!(-1.0), true),
            (json!(1e-12), json!(1e-12), true),
            (json!(1.0), json!(1.0 + 1e-12), false),
            (json!(9_007_199_254_740_993_u64), json!(9_007_199_254_740_992.0), false),
            (json!(u64::MAX), json!(18_446_744_073_709_551_616.0), false),
            (json!(i64::MIN), json!(-9_223_372_036_854_775_808.0), true),
        ] {
            assert_eq!(raw_scene_survives_projection(&raw, &projected), expected);
        }
    }

    #[test]
    fn all_nested_asset_reference_families_remain_evidence_only() {
        for reference in [
            json!({"objects":[{"material_parameter_fields":[{"value":{"kind":"sampled","asset_id":"missing"}}]}]}),
            json!({"objects":[{"regions":[{"material_overrides":[{"value":{"kind":"sampled","asset_id":"missing"}}]}]}]}),
            json!({"magnetization_constraints":[{"reference":{"kind":"explicit_field_asset","asset_id":"missing"}}]}),
            json!({"selections":[{"expression":{"kind":"inside_geometry","geometry":{"kind":"imported_solid","asset_id":"missing"}}}]}),
            json!({"antenna_target_projections":[{"solution":{"asset_id":"missing"}}]}),
            json!({"antenna_spectrum_requests":[{"equilibrium_ref":{"kind":"artifact","asset_id":"missing"}}]}),
            json!({"antenna_spectrum_requests":[{"equilibrium_ref":"legacy-artifact"}]}),
            json!({"antenna_spectrum_requests":[{"mode_basis_ref":"missing"}]}),
            json!({"opaque_payload":{"nested":[{"asset_id":null}]}}),
        ] {
            assert!(scene_references_unmaterialized_assets(&reference));
        }
        assert!(!scene_references_unmaterialized_assets(&json!({
            "solution":{"kind":"stage_output","stage_id":"solve","output_id":"basis"},
            "equilibrium_ref":{"kind":"stage_output","stage_id":"relax","output_id":"state"}
        })));
    }

}
