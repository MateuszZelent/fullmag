//! Stateless execution-intent preview. Never admits or starts a worker.

use axum::{extract::State, Json};
use fullmag_application::{materialize_study_execution, StudyStepExecutionInput};
use fullmag_session::execution_profiles::ExecutionProfileCatalog;
use serde_json::json;
use std::sync::Arc;

use crate::{
    error::ApiError,
    schemas::compute_preview::{
        ComputeAdmissionState, ComputePreviewRequest, ComputePreviewResource, ComputePreviewStep,
    },
    types::AppState,
};

#[utoipa::path(
    post,
    path = "/v2/platform/compute/preview",
    request_body = ComputePreviewRequest,
    responses(
        (status = 200, description = "Canonical intent preview; host admission is not evaluated", body = ComputePreviewResource),
        (status = 400, description = "Invalid or oversized canonical study inputs"),
        (status = 409, description = "Profile revision or immutable reference conflict"),
        (status = 503, description = "No configured profile store")
    ),
    tag = "platform"
)]
pub async fn post_compute_preview(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ComputePreviewRequest>,
) -> Result<Json<ComputePreviewResource>, ApiError> {
    let root = super::compute_profiles::configured_root(&state)?;
    let instance_id = state.request_scope_instance_id.to_string();
    let preview = tokio::task::spawn_blocking(move || {
        let profiles = super::compute_profiles::read_validated_catalog(root)?;
        build_preview(request, profiles, &instance_id)
    })
    .await
    .map_err(|error| ApiError::internal(format!("compute preview task failed: {error}")))??;
    Ok(Json(preview))
}

fn build_preview(
    request: ComputePreviewRequest,
    profiles: ExecutionProfileCatalog,
    instance: &str,
) -> Result<ComputePreviewResource, ApiError> {
    if request.inputs.len() > 256 || request.study_plan.steps.len() > 256 {
        return Err(ApiError::bad_request(
            "Compute preview supports at most 256 study steps.",
        ));
    }
    if request.expected_profile_catalog_revision != profiles.revision {
        return Err(ApiError::conflict_with_code(
            "execution_profile_revision_conflict",
            "Refresh profiles before rebuilding the preview.",
        ));
    }
    request
        .study_plan
        .validate_for_execution()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let mut source_inputs = request
        .inputs
        .iter()
        .map(|input| {
            json!({
                "step_id": input.step_id, "problem": input.problem, "layers": input.layers,
            })
        })
        .collect::<Vec<_>>();
    source_inputs.sort_by(|left, right| left["step_id"].as_str().cmp(&right["step_id"].as_str()));
    let source_digest = fullmag_session::canonical_json_sha256(&json!({
        "study_plan": request.study_plan, "inputs": source_inputs,
    }));
    let mut seen = std::collections::BTreeSet::new();
    for input in &request.inputs {
        if !seen.insert(&input.step_id)
            || !request
                .study_plan
                .steps
                .iter()
                .any(|step| step.enabled && step.step_id == input.step_id)
        {
            return Err(ApiError::bad_request(
                "Study preview has duplicate, unknown or disabled input steps.",
            ));
        }
        input
            .problem
            .validate()
            .map_err(|errors| ApiError::bad_request(errors.join("; ")))?;
    }
    if seen.len()
        != request
            .study_plan
            .steps
            .iter()
            .filter(|step| step.enabled)
            .count()
    {
        return Err(ApiError::bad_request(
            "Study preview is missing an enabled input step.",
        ));
    }
    for step in request.study_plan.steps.iter().filter(|step| step.enabled) {
        let reference = &step.execution_profile;
        if !profiles.entries.iter().any(|entry| {
            entry.profile.profile_id == reference.profile_id
                && entry.profile.version == reference.version
        }) {
            return Err(ApiError::conflict_with_code(
                "execution_profile_reference_conflict",
                format!(
                    "Publish execution profile {}@{} before previewing this study.",
                    reference.profile_id, reference.version
                ),
            ));
        }
    }
    let inputs = request
        .inputs
        .into_iter()
        .map(|input| StudyStepExecutionInput {
            step_id: input.step_id,
            problem: input.problem,
            layers: input.layers,
        })
        .collect();
    let catalog = materialize_study_execution(&request.study_plan, inputs, |id, version| {
        profiles
            .entries
            .iter()
            .find(|entry| entry.profile.profile_id == id && entry.profile.version == version)
            .map(|entry| entry.profile.clone())
            .ok_or_else(|| "Pinned profile is missing.".into())
    })
    .map_err(ApiError::bad_request)?;
    fullmag_plan::lower_study_plan_with_catalog(&request.study_plan, &catalog).map_err(
        |error| {
            ApiError::bad_request(format!(
                "study execution preview cannot be planned: {error}"
            ))
        },
    )?;
    let catalog_value =
        serde_json::to_value(&catalog).map_err(|error| ApiError::internal(error.to_string()))?;
    let study_catalog_sha256 = fullmag_session::canonical_json_sha256(&catalog_value);
    let preview_id = fullmag_session::canonical_json_sha256(&json!({
        "instance": instance, "source": source_digest, "catalog": study_catalog_sha256, "profile_revision": profiles.revision,
    }));
    let steps = catalog
        .entries()
        .iter()
        .map(|entry| ComputePreviewStep {
            step_id: entry.step_id().into(),
            execution: entry
                .execution_materialization()
                .expect("application materialized every enabled step")
                .clone(),
        })
        .collect();
    let preview = ComputePreviewResource {
        schema_version: "compute_execution_preview.v1".into(),
        preview_id,
        source_digest,
        profile_catalog_revision: profiles.revision,
        study_problem_catalog: serde_json::from_value(catalog_value)
            .map_err(|error| ApiError::internal(error.to_string()))?,
        study_catalog_sha256,
        steps,
        admission_state: ComputeAdmissionState::NotEvaluated,
        blocking_reasons: vec!["host_admission_not_evaluated".into()],
    };
    if serde_json::to_vec(&preview)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .len()
        > 8 * 1024 * 1024
    {
        return Err(ApiError::bad_request(
            "Compute preview exceeds the 8 MiB response limit.",
        ));
    }
    Ok(preview)
}

#[cfg(test)]
#[path = "compute_preview_tests.rs"]
mod tests;
