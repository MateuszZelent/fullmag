//! Runtime-free preparation from exact project bytes and compiled Study inputs.
//! This endpoint never opens an accepted-run store or a runtime session.

use axum::{extract::Path, Json};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::{
    FileProjectRepository, ProjectId, ProjectRepository, ProjectSource, RunIntentAuthoring,
};
use fullmag_authoring::StudyPlan;
use fullmag_plan::StudyProblemCatalog;

use crate::error::ApiError;
use crate::schemas::projects::{
    ProjectRunIntentRequest, ProjectRunIntentResource, PROJECT_ARCHIVE_MAX_BYTES,
};

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/{project_id}/run-intent",
    params(("project_id" = String, Path, description = "Exact archived project identity")),
    request_body = ProjectRunIntentRequest,
    responses(
        (status = 200, description = "Prepared immutable identity; not accepted or admitted", body = ProjectRunIntentResource),
        (status = 400, description = "Invalid archive or compiled authoring inputs"),
        (status = 409, description = "Project identity or revision conflict; read-only archive")
    ),
    tag = "persistence"
)]
pub(crate) async fn prepare(
    Path(project_id): Path<String>,
    Json(request): Json<ProjectRunIntentRequest>,
) -> Result<Json<ProjectRunIntentResource>, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| ApiError::bad_request(format!("invalid project_id: {error}")))?;
    tokio::task::spawn_blocking(move || prepare_identity(project_id, request))
        .await
        .map_err(|error| ApiError::internal(format!("run identity preparation failed: {error}")))?
        .map(Json)
}

fn prepare_identity(
    project_id: ProjectId,
    request: ProjectRunIntentRequest,
) -> Result<ProjectRunIntentResource, ApiError> {
    // Bound the encoded input before allocating a decoded archive.
    let encoded_limit = PROJECT_ARCHIVE_MAX_BYTES.div_ceil(3) * 4;
    if request.archive_base64.len() > encoded_limit {
        return Err(ApiError::bad_request(
            "project archive transport limit exceeded",
        ));
    }
    let archive = STANDARD
        .decode(request.archive_base64.as_bytes())
        .map_err(|error| {
            ApiError::bad_request(format!("invalid_project_archive_encoding: {error}"))
        })?;
    if archive.len() > PROJECT_ARCHIVE_MAX_BYTES {
        return Err(ApiError::bad_request(
            "project archive transport limit exceeded",
        ));
    }
    let opened = FileProjectRepository::new()
        .open(ProjectSource::Bytes {
            display_name: "prepared-project.fms".into(),
            bytes: archive,
        })
        .map_err(|error| ApiError::bad_request(format!("invalid_project_archive: {error}")))?;
    if opened.read_only_reason.is_some() || !opened.migration.can_write {
        return Err(ApiError::conflict("prepared project archive is read-only"));
    }
    let definition = &opened.envelope.definition;
    if definition.project_id != project_id || definition.revision != request.expected_revision {
        return Err(ApiError::conflict(
            "archived project identity or revision differs from request",
        ));
    }
    let authored: RunIntentAuthoring = serde_json::from_value(serde_json::Value::Object(
        request.run_authoring.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_run_authoring: {error}")))?;
    let study: StudyPlan = serde_json::from_value(serde_json::Value::Object(
        request.study_plan.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_study_plan: {error}")))?;
    let catalog: StudyProblemCatalog = serde_json::from_value(serde_json::Value::Object(
        request.study_problem_catalog.into_iter().collect(),
    ))
    .map_err(|error| ApiError::bad_request(format!("invalid_study_problem_catalog: {error}")))?;
    let intent = fullmag_application::materialize_run_intent(
        &opened.envelope,
        &study,
        &catalog,
        authored,
        &request.asset_paths,
    )
    .map_err(|error| ApiError::bad_request(format!("invalid_run_preparation: {error:#}")))?;
    crate::accepted_solver_profile::validate_study_profile(&intent.specification.parameters, &study)
        .map_err(|error| ApiError::bad_request(format!("invalid_solver_profile: {error:#}")))?;
    let plan = fullmag_plan::lower_study_plan_with_catalog(&study, &catalog)
        .map_err(|error| ApiError::bad_request(format!("invalid_study_plan: {error:#}")))?;
    fullmag_runtime_control::validate_requested_execution(&intent.specification, &catalog, &plan)
        .map_err(|error| ApiError::bad_request(format!("invalid_execution_request: {error:#}")))?;
    let payload_fingerprint = intent
        .payload_fingerprint()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let run_intent = serde_json::to_value(intent)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .as_object()
        .ok_or_else(|| ApiError::internal("canonical RunIntent is not an object"))?
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Ok(ProjectRunIntentResource {
        project_id: project_id.as_str().into(),
        definition_revision: definition.revision,
        payload_fingerprint,
        run_intent,
    })
}

#[cfg(test)]
#[path = "run_intent_preparation_tests.rs"]
mod tests;
