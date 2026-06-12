use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use fullmag_authoring::{MagnetizationAsset, SceneDocument, SceneObject};
use fullmag_runner::RuntimeStatus;
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::hysteresis::{
    HysteresisExecutionTreeNode, HysteresisExecutionTreeResource, HysteresisOrientationSchema,
    HysteresisProgressSchema, HysteresisProtocolSchema, HysteresisSettlePipelineSchema,
    HysteresisStagePlanSchema, HysteresisStageSaturationSchema,
};
use crate::schemas::runtime::{
    CommandDetailResource, CommandDiagnosticReferenceResource, CommandExecutionReadbackResource,
    CommandQueueStatusResource, CommandResourceInvalidationResource, CommandStatusResource,
    CurrentRunResource, ObjectEnergySummary, ObjectMagnetizationAverage, ObjectMetricsResource,
    RuntimeCommandReadinessResource, SolverEnergyCurrentResource, SolverEnergyHistoryResource,
    SolverEnergyRow, SolverStatusResource, StageExecutionRecordResource, StageExecutionResource,
};
use crate::session::{
    build_runtime_status_view, command_ledger_revisions, effective_runtime_status_code,
};
use crate::types::{
    AppState, CommandCompletionState, CommandLifecycleState, ScalarRow, SessionStateResponse,
    StageExecutionRecord, StageExecutionState, TrackedCommandRecord,
};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct EnergyHistoryQuery {
    /// Optional max number of most recent rows to return.
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct HysteresisExecutionTreeQuery {
    pub window: Option<String>,
    pub before: Option<u32>,
    pub after: Option<u32>,
    pub include_bookmarks: Option<bool>,
    pub include_warnings: Option<bool>,
    pub include_snapshots: Option<bool>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/runs/current",
    responses(
        (status = 200, description = "Current run resource", body = CurrentRunResource),
        (status = 404, description = "No active run"),
    ),
    tag = "simulation"
)]
pub async fn get_current_run(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CurrentRunResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let run = snapshot
        .run
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active run"))?;
    let stage = snapshot.stage_execution.as_ref();

    Ok(Json(CurrentRunResource {
        run_id: run.run_id.clone(),
        session_id: snapshot.session.session_id.clone(),
        revision: snapshot.state_version,
        status: run.status.clone(),
        status_reason: None,
        started_at: snapshot.session.started_at_unix_ms.to_string(),
        total_steps: run.total_steps as u64,
        solver_time_seconds: run.final_time,
        final_exchange_energy: run.final_e_ex,
        final_demag_energy: run.final_e_demag,
        final_zeeman_energy: run.final_e_ext,
        final_anisotropy_energy: run.final_e_ani,
        final_dmi_energy: run.final_e_dmi,
        final_total_energy: run.final_e_total,
        artifact_dir: run.artifact_dir.clone(),
        requested_backend: snapshot.session.requested_backend.clone(),
        requested_device: snapshot.session.requested_device.clone(),
        requested_precision: snapshot.session.requested_precision.clone(),
        requested_mode: snapshot.session.requested_mode.clone(),
        resolved_backend: snapshot.session.resolved_backend.clone(),
        resolved_device: snapshot.session.resolved_device.clone(),
        resolved_precision: snapshot.session.resolved_precision.clone(),
        resolved_mode: snapshot.session.resolved_mode.clone(),
        resolved_runtime_family: snapshot.session.resolved_runtime_family.clone(),
        resolved_engine_id: snapshot.session.resolved_engine_id.clone(),
        resolved_worker: snapshot.session.resolved_worker.clone(),
        resolved_fallback: snapshot.session.resolved_fallback.as_ref().map(Into::into),
        active_stage_index: stage
            .and_then(|value| value.active_stage_index)
            .map(|value| value as u32),
        active_stage_kind: stage.and_then(|value| value.active_stage_kind.clone()),
        total_stages: stage.map(|value| value.total_stages as u32),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/runs/{run_id}",
    params(
        ("run_id" = String, Path, description = "Run identifier. The local runtime currently exposes the active run read-model."),
    ),
    responses(
        (status = 200, description = "Run resource", body = CurrentRunResource),
        (status = 404, description = "Run not found"),
    ),
    tag = "simulation"
)]
pub async fn get_run_by_id(
    State(state): State<Arc<AppState>>,
    Path(run_id): Path<String>,
) -> Result<Json<CurrentRunResource>, ApiError> {
    let current = get_current_run(State(state)).await?;
    if current.run_id == run_id {
        Ok(current)
    } else {
        Err(ApiError::not_found(format!("run not found: {run_id}")))
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/execution",
    responses(
        (status = 200, description = "Current stage execution read-model", body = StageExecutionResource),
        (status = 204, description = "Stage execution read-model is not available yet"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "simulation"
)]
pub async fn get_stage_execution(
    State(state): State<Arc<AppState>>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let Some(stage) = snapshot.stage_execution.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    Ok(Json(StageExecutionResource {
        revision: snapshot.state_version,
        runtime_state: stage.runtime_state.as_str().to_string(),
        total_stages: stage.total_stages as u32,
        completed_stage_indexes: stage
            .completed_stage_indexes
            .iter()
            .map(|value| *value as u32)
            .collect(),
        stage_statuses: stage
            .stage_statuses
            .iter()
            .map(|status| status.as_str().to_string())
            .collect(),
        active_stage_index: stage.active_stage_index.map(|value| value as u32),
        active_stage_kind: stage.active_stage_kind.clone(),
        stages: stage
            .stages
            .iter()
            .enumerate()
            .map(|(index, record)| StageExecutionRecordResource {
                stage_id: record
                    .stage_id
                    .clone()
                    .unwrap_or_else(|| stage_id_for_index(index)),
                index: index as u32,
                label: Some(format!("Stage {}", index + 1)),
                kind: record
                    .kind
                    .clone()
                    .or_else(|| stage_kind_for_index(stage, index)),
                action: None,
                status: record.status.as_str().to_string(),
                command_id: record.command_id.clone(),
                started_at_unix_ms: record.started_at_unix_ms,
                completed_at_unix_ms: record.completed_at_unix_ms,
                reason: record.reason.as_ref().map(stage_stop_reason_string),
                artifact_refs: record.artifact_refs.clone(),
                checkpoint_ref: record.checkpoint_ref.clone(),
                loaded_state_ref: record.loaded_state_ref.clone(),
                resume_from_checkpoint_ref: record.resume_from_checkpoint_ref.clone(),
                state_transition: record.state_transition.clone(),
                state_transition_kind: record.state_transition_kind.clone(),
                state_transition_reason: record.state_transition_reason.clone(),
                state_transfer_operator_kind: record.state_transfer_operator_kind.clone(),
                state_transition_ui_presentation: record.state_transition_ui_presentation.clone(),
                metric_name: record.metric_name.clone(),
                metric_value: record.metric_value,
                threshold: record.threshold,
                current_field_m_t: record.current_field_m_t,
                current_point_index: record.current_point_index,
                current_settle_step_index: record.current_settle_step_index,
                current_settle_step_kind: record.current_settle_step_kind.clone(),
                current_settle_step_method: record.current_settle_step_method.clone(),
            })
            .collect(),
    })
    .into_response())
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/plan",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Requested hysteresis field plan for a stage", body = HysteresisStagePlanSchema),
        (status = 404, description = "No matching hysteresis stage plan"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_plan(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisStagePlanSchema>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    Ok(Json(HysteresisStagePlanSchema {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        field_min_m_t: value_f64(stage.value.get("field_min_mT")),
        field_max_m_t: value_f64(stage.value.get("field_max_mT")),
        field_step_m_t: value_f64(stage.value.get("field_step_mT")),
        field_values_m_t: value_f64_array(stage.value.get("field_values_mT")),
        field_schedule: stage.value.get("field_schedule").cloned(),
        schedule_refinements: stage.value.get("schedule_refinements").cloned(),
        angular_family: stage.value.get("angular_family").cloned(),
        adaptive_refinement: stage.value.get("adaptive_refinement").cloned(),
        minor_loops: stage.value.get("minor_loops").cloned(),
        branch_mode: value_string(stage.value.get("branch_mode")),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/protocol",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Requested hysteresis protocol for a stage", body = HysteresisProtocolSchema),
        (status = 404, description = "No matching hysteresis stage protocol"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_protocol(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisProtocolSchema>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    Ok(Json(HysteresisProtocolSchema {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        initial_protocol: value_string(stage.value.get("initial_protocol")),
        branch_mode: value_string(stage.value.get("branch_mode")),
        saturation: stage.value.get("saturation").cloned(),
        storage: stage.value.get("storage").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/saturation",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Requested saturation policy and optional executed probe summary for a hysteresis stage", body = HysteresisStageSaturationSchema),
        (status = 404, description = "No matching hysteresis stage saturation resource"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_stage_saturation(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisStageSaturationSchema>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    let saturation =
        crate::router_v2::handlers::analysis::hysteresis::read_hysteresis_saturation_result(
            &state,
            &stage.stage_id,
        )
        .await;
    let (result_status, result) = match saturation {
        Ok(result) => ("available".to_string(), Some(result)),
        Err(error) if error.status == StatusCode::NOT_FOUND => ("not_available".to_string(), None),
        Err(error) => return Err(error),
    };

    Ok(Json(HysteresisStageSaturationSchema {
        revision: stage.revision,
        stage_id: stage.stage_id.clone(),
        stage_index: stage.stage_index,
        requested: stage.value.get("saturation").cloned(),
        result_status,
        result,
        analysis_resource_ref: format!(
            "/v2/sessions/current/analysis/hysteresis/{}/saturation",
            stage.stage_id
        ),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/orientation",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Requested hysteresis orientation for a stage", body = HysteresisOrientationSchema),
        (status = 404, description = "No matching hysteresis stage orientation"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_orientation(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisOrientationSchema>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    Ok(Json(HysteresisOrientationSchema {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        orientation: stage.value.get("orientation").cloned(),
        direction: value_vec3(stage.value.get("direction")),
        measurement_axis: stage.value.get("measurement_axis").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/settle-pipeline",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Requested hysteresis settle pipeline for a stage", body = HysteresisSettlePipelineSchema),
        (status = 404, description = "No matching hysteresis stage settle pipeline"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_settle_pipeline(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisSettlePipelineSchema>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    Ok(Json(HysteresisSettlePipelineSchema {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        settle_pipeline: stage.value.get("settle_pipeline").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/execution-tree",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
        HysteresisExecutionTreeQuery,
    ),
    responses(
        (status = 200, description = "Windowed hysteresis execution tree for Explorer", body = HysteresisExecutionTreeResource),
        (status = 404, description = "No matching hysteresis stage execution tree"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_execution_tree(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
    Query(query): Query<HysteresisExecutionTreeQuery>,
) -> Result<Json<HysteresisExecutionTreeResource>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    let progress = resolve_hysteresis_stage_progress(&state, &stage.stage_id).await?;
    Ok(Json(build_hysteresis_execution_tree(
        stage, progress, query,
    )))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/progress",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Live hysteresis progress for a stage", body = HysteresisProgressSchema),
        (status = 404, description = "No matching hysteresis stage progress"),
    ),
    tag = "simulation"
)]
pub async fn get_hysteresis_progress(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisProgressSchema>, ApiError> {
    let mut progress = resolve_hysteresis_stage_progress(&state, &stage_id).await?;
    if let Ok(stage) = resolve_hysteresis_scene_stage(&state, &progress.stage_id).await {
        enrich_hysteresis_progress_counts(&mut progress, &stage);
        attach_hysteresis_live_magnetization(&state, &mut progress, &stage).await;
    }
    Ok(Json(progress))
}

async fn resolve_hysteresis_stage_progress(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<HysteresisProgressSchema, ApiError> {
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return Err(ApiError::not_found("no active workspace"));
    };
    let Some(stage_execution) = snapshot.stage_execution.as_ref() else {
        return Err(ApiError::not_found(
            "stage execution read-model is not available",
        ));
    };

    for (index, record) in stage_execution.stages.iter().enumerate() {
        if !stage_identifier_matches(record, index, stage_id) {
            continue;
        }

        let record_kind = record.kind.as_deref();
        let active_stage_kind = stage_kind_for_index(stage_execution, index);
        if !is_hysteresis_stage_kind(record_kind)
            && !is_hysteresis_stage_kind(active_stage_kind.as_deref())
        {
            return Err(ApiError::not_found(format!(
                "stage '{}' is not a hysteresis stage",
                stage_id
            )));
        }

        return Ok(HysteresisProgressSchema {
            revision: snapshot.state_version,
            stage_id: record
                .stage_id
                .clone()
                .unwrap_or_else(|| stage_id_for_index(index)),
            stage_index: index as u32,
            stage_kind: Some("hysteresis".to_string()),
            status: record.status.as_str().to_string(),
            active: stage_execution.active_stage_index == Some(index),
            total_points: None,
            completed_points: None,
            active_point_index: None,
            queued_points: None,
            current_field_m_t: record.current_field_m_t,
            current_point_index: record.current_point_index,
            current_settle_step_index: record.current_settle_step_index,
            current_settle_step_kind: record.current_settle_step_kind.clone(),
            current_settle_step_method: record.current_settle_step_method.clone(),
            current_m_avg: None,
            current_m_parallel: None,
        });
    }

    Err(ApiError::not_found(format!(
        "hysteresis stage '{}' not found",
        stage_id
    )))
}

fn is_hysteresis_stage_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("hysteresis" | "flat_hysteresis"))
}

fn enrich_hysteresis_progress_counts(
    progress: &mut HysteresisProgressSchema,
    stage: &HysteresisSceneStage,
) {
    let values = materialize_hysteresis_stage_field_values(&stage.value);
    let total_points = values.len() as u32;
    let active_point_index = infer_hysteresis_active_point_index(progress, &values)
        .filter(|_| matches!(progress.status.as_str(), "running" | "paused"));
    let completed_points = match progress.status.as_str() {
        "completed" | "skipped" => total_points,
        "pending" => 0,
        _ => active_point_index
            .or(progress.current_point_index)
            .unwrap_or(0)
            .min(total_points),
    };
    let active_points = u32::from(active_point_index.is_some());
    let queued_points = total_points.saturating_sub(completed_points + active_points);

    progress.total_points = Some(total_points);
    progress.completed_points = Some(completed_points);
    progress.active_point_index = active_point_index;
    progress.queued_points = Some(queued_points);
}

async fn attach_hysteresis_live_magnetization(
    state: &Arc<AppState>,
    progress: &mut HysteresisProgressSchema,
    stage: &HysteresisSceneStage,
) {
    if !progress.active || !matches!(progress.status.as_str(), "running" | "paused") {
        return;
    }

    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return;
    };
    let m_avg = snapshot
        .live_state
        .as_ref()
        .and_then(|live| live.latest_step.magnetization.as_ref())
        .and_then(|values| average_flat_magnetization(values, 0, values.len() / 3))
        .or_else(|| {
            snapshot
                .scalar_rows
                .last()
                .map(|row| [row.mx, row.my, row.mz])
        });
    let Some(m_avg) = m_avg else {
        return;
    };
    if !m_avg.iter().all(|value| value.is_finite()) {
        return;
    }

    progress.current_m_avg = Some(m_avg);
    progress.current_m_parallel = Some(project_hysteresis_m_parallel(m_avg, &stage.value));
}

fn project_hysteresis_m_parallel(m_avg: [f64; 3], stage: &serde_json::Map<String, Value>) -> f64 {
    let axis = hysteresis_field_axis(stage);
    m_avg[0] * axis[0] + m_avg[1] * axis[1] + m_avg[2] * axis[2]
}

fn hysteresis_field_axis(stage: &serde_json::Map<String, Value>) -> [f64; 3] {
    if let Some(orientation) = stage.get("orientation").and_then(Value::as_object) {
        if let Some(preset) = orientation.get("preset_name").and_then(Value::as_str) {
            return match preset {
                "oop_negative" => [0.0, 0.0, -1.0],
                "in_plane_x" => [1.0, 0.0, 0.0],
                "in_plane_y" => [0.0, 1.0, 0.0],
                _ => [0.0, 0.0, 1.0],
            };
        }
        if let Some(vector) = value_vec3(orientation.get("vector")) {
            return normalized_axis_or_default(vector);
        }
        if orientation
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "sample")
        {
            if let (Some(theta), Some(phi)) = (
                value_f64(orientation.get("theta")),
                value_f64(orientation.get("phi")),
            ) {
                if theta.is_finite() && phi.is_finite() {
                    let theta_rad = theta * std::f64::consts::PI / 180.0;
                    let phi_rad = phi * std::f64::consts::PI / 180.0;
                    return [
                        theta_rad.sin() * phi_rad.cos(),
                        theta_rad.sin() * phi_rad.sin(),
                        theta_rad.cos(),
                    ];
                }
            }
        }
    }

    if let Some(direction) = value_vec3(stage.get("direction")) {
        return normalized_axis_or_default(direction);
    }

    [0.0, 0.0, 1.0]
}

fn normalized_axis_or_default(vector: [f64; 3]) -> [f64; 3] {
    let norm = (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
    if norm > 1e-15 && norm.is_finite() {
        [vector[0] / norm, vector[1] / norm, vector[2] / norm]
    } else {
        [0.0, 0.0, 1.0]
    }
}

fn infer_hysteresis_active_point_index(
    progress: &HysteresisProgressSchema,
    values: &[f64],
) -> Option<u32> {
    if let Some(point_index) = progress
        .current_point_index
        .filter(|point_index| (*point_index as usize) < values.len())
    {
        return Some(point_index);
    }
    let current_field = progress.current_field_m_t?;
    values
        .iter()
        .position(|value| (value - current_field).abs() <= 1.0e-9)
        .map(|index| index as u32)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/solver/status",
    responses(
        (status = 200, description = "Detailed solver status read-model", body = SolverStatusResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "simulation"
)]
pub async fn get_solver_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SolverStatusResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let latest = snapshot.live_state.as_ref().map(|value| &value.latest_step);
    let runtime_status = build_runtime_status_view(&effective_runtime_status_code(snapshot));
    let mut warnings = material_field_plan_warnings(snapshot.metadata.as_ref());
    for warning in snapshot
        .engine_log
        .iter()
        .filter(|entry| entry.level.eq_ignore_ascii_case("warn"))
        .map(|entry| entry.message.clone())
    {
        if !warnings.contains(&warning) {
            warnings.push(warning);
        }
    }
    if warnings.len() > 8 {
        warnings.drain(0..warnings.len() - 8);
    }

    Ok(Json(SolverStatusResource {
        revision: snapshot.state_version,
        runtime_state: runtime_status.code.clone(),
        runtime_status_kind: runtime_status_kind(&runtime_status),
        runtime_status_code: runtime_status.code.clone(),
        session_status: snapshot.session.status.clone(),
        is_busy: runtime_status.is_busy,
        can_accept_commands: runtime_status.can_accept_commands,
        run_id: snapshot.run.as_ref().map(|value| value.run_id.clone()),
        stage_kind: snapshot
            .stage_execution
            .as_ref()
            .and_then(|value| value.active_stage_kind.clone()),
        algorithm: metadata_string(
            snapshot.metadata.as_ref(),
            &["execution_plan", "backend_plan", "kind"],
        ),
        integrator: metadata_string(
            snapshot.metadata.as_ref(),
            &["execution_plan", "backend_plan", "integrator"],
        ),
        dt_seconds: latest.map(|value| value.dt),
        sim_time_seconds: latest.map(|value| value.time),
        step_index: latest.map(|value| value.step),
        last_step_updated_at_unix_ms: snapshot
            .live_state
            .as_ref()
            .map(|value| value.updated_at_unix_ms.min(u64::MAX as u128) as u64),
        max_torque_t: latest.map(|value| value.max_torque_T),
        max_torque_apm: latest.map(|value| value.max_torque_Apm),
        max_torque: latest.map(|value| value.max_torque_T),
        converged: latest.map(|value| value.finished),
        last_error: snapshot
            .engine_log
            .iter()
            .rev()
            .find(|entry| entry.level.eq_ignore_ascii_case("error"))
            .map(|entry| entry.message.clone()),
        warnings,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/solver/energies/current",
    responses(
        (status = 200, description = "Current solver energy sample", body = SolverEnergyCurrentResource),
        (status = 404, description = "No solver energy data"),
    ),
    tag = "simulation"
)]
pub async fn get_solver_energies_current(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SolverEnergyCurrentResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let latest_row =
        latest_energy_row(snapshot).ok_or_else(|| ApiError::not_found("no solver energy data"))?;

    Ok(Json(SolverEnergyCurrentResource {
        revision: snapshot.scalar_revision,
        step: latest_row.step,
        time_seconds: latest_row.time,
        exchange: latest_row.e_ex,
        demag: latest_row.e_demag,
        zeeman: latest_row.e_ext,
        anisotropy: latest_row.e_ani,
        dmi: latest_row.e_dmi,
        total: latest_row.e_total,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/solver/energies/history",
    params(EnergyHistoryQuery),
    responses(
        (status = 200, description = "Solver energy history", body = SolverEnergyHistoryResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "simulation"
)]
pub async fn get_solver_energies_history(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EnergyHistoryQuery>,
) -> Result<Json<SolverEnergyHistoryResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let total_rows = snapshot.scalar_rows.len();
    let rows = match query.limit {
        Some(limit) => {
            let start = total_rows.saturating_sub(limit);
            &snapshot.scalar_rows[start..]
        }
        None => snapshot.scalar_rows.as_slice(),
    };

    Ok(Json(SolverEnergyHistoryResource {
        revision: snapshot.scalar_revision,
        total_rows: total_rows as u64,
        returned_rows: rows.len() as u64,
        rows: rows
            .iter()
            .map(|row| SolverEnergyRow {
                step: row.step,
                time_seconds: row.time,
                exchange: row.e_ex,
                demag: row.e_demag,
                zeeman: row.e_ext,
                anisotropy: row.e_ani,
                dmi: row.e_dmi,
                total: row.e_total,
            })
            .collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/objects/{object_id}/metrics",
    params(
        ("object_id" = String, Path, description = "Scene object id or name"),
    ),
    responses(
        (status = 200, description = "Selected object magnetization and energy read-model", body = ObjectMetricsResource),
        (status = 404, description = "Object or workspace not found"),
    ),
    tag = "simulation"
)]
pub async fn get_object_metrics(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<ObjectMetricsResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no authoring scene"))?;
    let object = scene
        .objects
        .iter()
        .find(|object| object.id == object_id || object.name == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let canonical_object_id = object.id.clone();
    let initial_m = initial_magnetization_for_object(scene, object);
    let object_scalars = latest_object_scalars(snapshot, &canonical_object_id, &object.name);
    let latest_row = latest_solver_sample(snapshot);
    let has_solver_sample = object_scalars.is_some() || latest_row.is_some();
    let source = if object_scalars.is_some() {
        "solver_per_object"
    } else if latest_row.is_some() {
        "solver_global"
    } else {
        "initial_state"
    };
    let step = object_scalars
        .and_then(|values| number_from_metric(values, "step").map(|value| value as u64))
        .or_else(|| latest_row.as_ref().map(|row| row.step))
        .unwrap_or(0);
    let time_seconds = object_scalars
        .and_then(|values| number_from_metric(values, "time"))
        .or_else(|| latest_row.as_ref().map(|row| row.time))
        .unwrap_or(0.0);

    let magnetization_average = if let Some(values) = object_scalars {
        [
            number_from_metric(values, "mx").unwrap_or(initial_m[0]),
            number_from_metric(values, "my").unwrap_or(initial_m[1]),
            number_from_metric(values, "mz").unwrap_or(initial_m[2]),
        ]
    } else if has_solver_sample {
        latest_magnetization_average(snapshot, &canonical_object_id, initial_m)
            .or_else(|| latest_row.as_ref().map(|row| [row.mx, row.my, row.mz]))
            .unwrap_or(initial_m)
    } else {
        initial_m
    };

    let zero_energies = ObjectEnergySummary {
        exchange: 0.0,
        demag: 0.0,
        zeeman: 0.0,
        anisotropy: 0.0,
        dmi: 0.0,
        total: 0.0,
    };
    let energies = object_scalars
        .map(|values| ObjectEnergySummary {
            exchange: number_from_metric(values, "e_ex").unwrap_or(0.0),
            demag: number_from_metric(values, "e_demag").unwrap_or(0.0),
            zeeman: number_from_metric(values, "e_ext").unwrap_or(0.0),
            anisotropy: number_from_metric(values, "e_ani").unwrap_or(0.0),
            dmi: number_from_metric(values, "e_dmi").unwrap_or(0.0),
            total: number_from_metric(values, "e_total").unwrap_or(0.0),
        })
        .or_else(|| {
            latest_row.as_ref().map(|row| ObjectEnergySummary {
                exchange: row.e_ex,
                demag: row.e_demag,
                zeeman: row.e_ext,
                anisotropy: row.e_ani,
                dmi: row.e_dmi,
                total: row.e_total,
            })
        })
        .unwrap_or(zero_energies);

    Ok(Json(ObjectMetricsResource {
        object_id: canonical_object_id,
        revision: if has_solver_sample {
            snapshot.scalar_revision
        } else {
            snapshot.state_version
        },
        source: source.to_string(),
        has_solver_sample,
        step,
        time_seconds,
        magnetization_average: ObjectMagnetizationAverage {
            mx: magnetization_average[0],
            my: magnetization_average[1],
            mz: magnetization_average[2],
        },
        energies,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/commands",
    responses(
        (status = 200, description = "Current command queue and dispatch ledger", body = CommandQueueStatusResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "simulation"
)]
pub async fn get_command_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CommandQueueStatusResource>, ApiError> {
    ensure_workspace(&state).await?;
    let ledger = state.current_command_ledger.lock().await;
    let pending_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Queued)
        .count() as u64;
    let accepted_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Accepted)
        .count() as u64;
    let dispatched_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Dispatched)
        .count() as u64;
    let running_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Running)
        .count() as u64;
    let completed_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Completed)
        .count() as u64;
    let rejected_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Rejected)
        .count() as u64;
    let failed_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Failed)
        .count() as u64;
    let revision = command_ledger_revisions(&ledger).command_queue_revision;
    let (can_accept_commands, runtime_controls) = {
        let guard = state.current_live_state.read().await;
        let snapshot = guard.as_ref();
        (
            snapshot
                .map(|value| value.runtime_status.can_accept_commands)
                .unwrap_or(false),
            runtime_command_readiness_resources(snapshot, &ledger),
        )
    };

    Ok(Json(CommandQueueStatusResource {
        revision,
        pending_count,
        accepted_count,
        dispatched_count,
        running_count,
        completed_count,
        rejected_count,
        failed_count,
        can_accept_commands,
        runtime_controls,
        commands: ledger.iter().map(command_status_resource).collect(),
    }))
}

fn runtime_command_readiness_resources(
    snapshot: Option<&SessionStateResponse>,
    ledger: &std::collections::VecDeque<TrackedCommandRecord>,
) -> Vec<RuntimeCommandReadinessResource> {
    [
        "solve",
        "compute_fields",
        "compute_energies",
        "pause",
        "resume",
        "stop",
        "skip",
    ]
    .into_iter()
    .map(|kind| {
        let reason = runtime_command_disabled_reason(snapshot, ledger, kind);
        RuntimeCommandReadinessResource {
            kind: kind.to_string(),
            enabled: reason.is_none(),
            reason,
        }
    })
    .collect()
}

fn runtime_command_disabled_reason(
    snapshot: Option<&SessionStateResponse>,
    ledger: &std::collections::VecDeque<TrackedCommandRecord>,
    kind: &str,
) -> Option<String> {
    let Some(snapshot) = snapshot else {
        return Some("Runtime state is unavailable.".into());
    };
    let state = RuntimeStatus::from_status_code(&effective_runtime_status_code(snapshot));
    match kind {
        "pause" => (state != RuntimeStatus::Running).then(|| "Runtime is not running.".into()),
        "resume" => (state != RuntimeStatus::Paused).then(|| "Runtime is not paused.".into()),
        "stop" => (!matches!(state, RuntimeStatus::Running | RuntimeStatus::Paused))
            .then(|| "Runtime is not active.".into()),
        "skip" => runtime_skip_disabled_reason(snapshot, state),
        "solve" | "compute_fields" | "compute_energies" => {
            runtime_compute_disabled_reason(ledger, state)
        }
        _ => Some("Unsupported runtime command.".into()),
    }
}

fn runtime_compute_disabled_reason(
    ledger: &std::collections::VecDeque<TrackedCommandRecord>,
    state: RuntimeStatus,
) -> Option<String> {
    if has_active_compute_command(ledger) {
        return Some("A runtime command is already active.".into());
    }
    if matches!(state, RuntimeStatus::Running | RuntimeStatus::Paused) {
        return Some("Runtime is already active.".into());
    }
    if !state.can_accept_commands() {
        return Some("Runtime is not accepting compute commands.".into());
    }
    if matches!(
        state,
        RuntimeStatus::AwaitingCommand | RuntimeStatus::WaitingForCompute
    ) {
        return None;
    }
    Some("Runtime is not ready for compute commands.".into())
}

fn runtime_skip_disabled_reason(
    snapshot: &SessionStateResponse,
    state: RuntimeStatus,
) -> Option<String> {
    let active_stage_index = snapshot
        .stage_execution
        .as_ref()
        .and_then(|stage| stage.active_stage_index);
    if active_stage_index.is_none() {
        return Some("No active stage is available to skip.".into());
    }
    (!matches!(state, RuntimeStatus::Running | RuntimeStatus::Paused))
        .then(|| "Runtime is not in an active stage.".into())
}

fn has_active_compute_command(ledger: &std::collections::VecDeque<TrackedCommandRecord>) -> bool {
    ledger.iter().any(|record| {
        matches!(
            record.command.kind.as_str(),
            "solve" | "compute_fields" | "compute_energies"
        ) && matches!(
            record.status,
            CommandLifecycleState::Queued
                | CommandLifecycleState::Accepted
                | CommandLifecycleState::Dispatched
                | CommandLifecycleState::Running
        )
    })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/commands/{command_id}",
    params(
        ("command_id" = String, Path, description = "Command identifier"),
    ),
    responses(
        (status = 200, description = "Command submission and dispatch detail", body = CommandDetailResource),
        (status = 404, description = "Command not found"),
    ),
    tag = "simulation"
)]
pub async fn get_command_detail(
    State(state): State<Arc<AppState>>,
    Path(command_id): Path<String>,
) -> Result<Json<CommandDetailResource>, ApiError> {
    ensure_workspace(&state).await?;
    let record = {
        let ledger = state.current_command_ledger.lock().await;
        ledger
            .iter()
            .find(|record| record.command.command_id == command_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("command not found"))?
    };
    let (
        stage_linkage,
        run_id,
        requested_execution,
        resolved_execution,
        resource_invalidations,
        diagnostics,
    ) = {
        let guard = state.current_live_state.read().await;
        let stage_linkage = guard.as_ref().and_then(|snapshot| {
            command_stage_linkage(
                snapshot.stage_execution.as_ref(),
                record.command.command_id.as_str(),
                &record.command.target,
            )
        });
        let run_id = guard.as_ref().map(|snapshot| {
            snapshot
                .run
                .as_ref()
                .map(|run| run.run_id.clone())
                .unwrap_or_else(|| snapshot.session.run_id.clone())
        });
        let requested_execution = guard.as_ref().map(requested_execution_readback);
        let resolved_execution = guard.as_ref().and_then(resolved_execution_readback);
        let resource_invalidations =
            command_resource_invalidations(&record, guard.as_ref(), stage_linkage.as_ref());
        let diagnostics =
            command_diagnostic_references(&record, guard.as_ref(), stage_linkage.as_ref());
        (
            stage_linkage,
            run_id,
            requested_execution,
            resolved_execution,
            resource_invalidations,
            diagnostics,
        )
    };
    let accepted_at_unix_ms = Some(record.command.created_at_unix_ms);
    let started_at_unix_ms = record.dispatched_at_unix_ms.or_else(|| {
        stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.started_at_unix_ms)
    });
    let terminal_at_unix_ms = record.completed_at_unix_ms.or_else(|| {
        stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.completed_at_unix_ms)
    });

    Ok(Json(CommandDetailResource {
        command_id: record.command.command_id.clone(),
        request_id: record.request_id.clone(),
        seq: record.command.seq,
        kind: record.command.kind.clone(),
        target: record.command.target.clone(),
        reason: record.command.reason.clone(),
        precondition: record.command.precondition.clone(),
        client_intent_id: record.command.client_intent_id.clone(),
        requested_at_unix_ms: record.command.requested_at_unix_ms,
        stage_id: stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.stage_id.clone())
            .or_else(|| command_stage_id(&record.command.target)),
        stage_index: stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.stage_index)
            .or_else(|| command_stage_index(&record.command.target)),
        run_id,
        requested_execution,
        resolved_execution,
        resource_invalidations,
        diagnostics,
        status: record.status.as_str().to_string(),
        created_at_unix_ms: record.command.created_at_unix_ms,
        accepted_at_unix_ms,
        dispatched_at_unix_ms: record.dispatched_at_unix_ms,
        started_at_unix_ms,
        completed_at_unix_ms: record.completed_at_unix_ms,
        terminal_at_unix_ms,
        completion_status: record
            .completion_status
            .map(command_completion_state_string),
        error: record.error.clone(),
        until_seconds: record.command.until_seconds,
        max_steps: record.command.max_steps,
        torque_tolerance_apm: record.command.torque_tolerance,
        torque_tolerance: record.command.torque_tolerance,
        energy_tolerance: record.command.energy_tolerance,
        integrator: record.command.integrator.clone(),
        fixed_timestep: record.command.fixed_timestep,
        max_error: record.command.max_error,
        relax_algorithm: record.command.relax_algorithm.clone(),
        relax_alpha: record.command.relax_alpha,
        mesh_target: record.command.mesh_target.clone(),
        mesh_reason: record.command.mesh_reason.clone(),
        artifact_refs: stage_linkage
            .as_ref()
            .map(|linkage| linkage.artifact_refs.clone())
            .unwrap_or_default(),
        checkpoint_ref: stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.checkpoint_ref.clone()),
        loaded_state_ref: stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.loaded_state_ref.clone()),
        resume_from_checkpoint_ref: stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.resume_from_checkpoint_ref.clone()),
        state_transition: stage_linkage
            .as_ref()
            .and_then(|linkage| linkage.state_transition.clone()),
    }))
}

fn latest_energy_row(snapshot: &SessionStateResponse) -> Option<ScalarRow> {
    snapshot.scalar_rows.last().cloned().or_else(|| {
        snapshot.live_state.as_ref().map(|live_state| ScalarRow {
            step: live_state.latest_step.step,
            time: live_state.latest_step.time,
            solver_dt: live_state.latest_step.dt,
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
            e_ex: live_state.latest_step.e_ex,
            e_demag: live_state.latest_step.e_demag,
            e_ext: live_state.latest_step.e_ext,
            e_ani: live_state.latest_step.e_ani,
            e_dmi: live_state.latest_step.e_dmi,
            e_total: live_state.latest_step.e_total,
            max_dm_dt: live_state.latest_step.max_dm_dt,
            max_h_eff: live_state.latest_step.max_h_eff,
            max_h_demag: live_state.latest_step.max_h_demag,
            max_torque_Apm: live_state.latest_step.max_torque_Apm,
            max_torque_T: live_state.latest_step.max_torque_T,
        })
    })
}

fn latest_solver_sample(snapshot: &SessionStateResponse) -> Option<ScalarRow> {
    snapshot.scalar_rows.last().cloned().or_else(|| {
        let live_state = snapshot.live_state.as_ref()?;
        if snapshot.scalar_revision == 0 && live_state.latest_step.step == 0 {
            return None;
        }
        Some(ScalarRow {
            step: live_state.latest_step.step,
            time: live_state.latest_step.time,
            solver_dt: live_state.latest_step.dt,
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
            e_ex: live_state.latest_step.e_ex,
            e_demag: live_state.latest_step.e_demag,
            e_ext: live_state.latest_step.e_ext,
            e_ani: live_state.latest_step.e_ani,
            e_dmi: live_state.latest_step.e_dmi,
            e_total: live_state.latest_step.e_total,
            max_dm_dt: live_state.latest_step.max_dm_dt,
            max_h_eff: live_state.latest_step.max_h_eff,
            max_h_demag: live_state.latest_step.max_h_demag,
            max_torque_Apm: live_state.latest_step.max_torque_Apm,
            max_torque_T: live_state.latest_step.max_torque_T,
        })
    })
}

fn latest_object_scalars<'a>(
    snapshot: &'a SessionStateResponse,
    object_id: &str,
    object_name: &str,
) -> Option<&'a HashMap<String, f64>> {
    let per_object = &snapshot.live_state.as_ref()?.latest_step.per_object_scalars;
    let get_fallback = |id: &str| {
        per_object.get(id).or_else(|| {
            if id.ends_with("_geom") {
                per_object.get(&id[..id.len() - 5])
            } else {
                per_object.get(&format!("{}_geom", id))
            }
        })
    };
    get_fallback(object_id)
        .or_else(|| get_fallback(object_name))
        .or_else(|| {
            if per_object.len() == 1 {
                per_object.values().next()
            } else {
                None
            }
        })
}

fn number_from_metric(values: &HashMap<String, f64>, key: &str) -> Option<f64> {
    values.get(key).copied().filter(|value| value.is_finite())
}

fn initial_magnetization_for_object(scene: &SceneDocument, object: &SceneObject) -> [f64; 3] {
    object
        .magnetization_ref
        .as_ref()
        .and_then(|asset_id| {
            scene
                .magnetization_assets
                .iter()
                .find(|asset| asset.id == *asset_id)
        })
        .and_then(magnetization_asset_direction)
        .unwrap_or([0.0, 0.0, 1.0])
}

fn magnetization_asset_direction(asset: &MagnetizationAsset) -> Option<[f64; 3]> {
    if let Some(values) = asset
        .value
        .as_ref()
        .and_then(|values| number_slice3(values))
    {
        return Some(values);
    }
    asset
        .preset_params
        .as_ref()
        .and_then(|params| params.get("direction"))
        .and_then(value_array3)
}

fn number_slice3(values: &[f64]) -> Option<[f64; 3]> {
    if values.len() < 3 || !values[..3].iter().all(|value| value.is_finite()) {
        return None;
    }
    Some([values[0], values[1], values[2]])
}

fn value_array3(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    if values.len() < 3 {
        return None;
    }
    let out = [
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ];
    out.iter().all(|value| value.is_finite()).then_some(out)
}

fn runtime_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn latest_magnetization_average(
    snapshot: &SessionStateResponse,
    object_id: &str,
    fallback: [f64; 3],
) -> Option<[f64; 3]> {
    let live_state = snapshot.live_state.as_ref()?;
    let values = live_state.latest_step.magnetization.as_ref()?;
    if values.len() < 3 || values.len() % 3 != 0 {
        return None;
    }
    if let Some(mesh) = live_state.latest_step.fem_mesh.as_ref() {
        if let Some(average) = mesh
            .mesh_parts
            .iter()
            .find(|part| mesh_part_matches_object(part, object_id))
            .and_then(|part| average_part_magnetization(values, part))
        {
            return Some(average);
        }
        if let Some(segment) = mesh
            .object_segments
            .iter()
            .find(|segment| runtime_object_ids_match(&segment.object_id, object_id))
        {
            return average_flat_magnetization(
                values,
                segment.node_start as usize,
                segment.node_count as usize,
            )
            .or(Some(fallback));
        }
    }
    average_flat_magnetization(values, 0, values.len() / 3).or(Some(fallback))
}

fn mesh_part_matches_object(part: &fullmag_runner::FemMeshPartPayload, object_id: &str) -> bool {
    part.role == "magnetic_object"
        && (part
            .object_id
            .as_deref()
            .is_some_and(|id| runtime_object_ids_match(id, object_id))
            || part
                .geometry_id
                .as_deref()
                .is_some_and(|id| runtime_object_ids_match(id, object_id))
            || runtime_object_ids_match(&part.id, object_id))
}

fn average_part_magnetization(
    values: &[f64],
    part: &fullmag_runner::FemMeshPartPayload,
) -> Option<[f64; 3]> {
    if !part.node_indices.is_empty() {
        return average_indexed_magnetization(values, part.node_indices.iter().copied());
    }
    average_flat_magnetization(values, part.node_start as usize, part.node_count as usize)
}

fn average_indexed_magnetization(
    values: &[f64],
    indices: impl IntoIterator<Item = u32>,
) -> Option<[f64; 3]> {
    let node_count = values.len() / 3;
    let mut sum = [0.0; 3];
    let mut used = 0usize;
    for index in indices {
        let index = index as usize;
        if index >= node_count {
            continue;
        }
        let offset = index * 3;
        let vector = [values[offset], values[offset + 1], values[offset + 2]];
        if !vector.iter().all(|value| value.is_finite()) {
            continue;
        }
        sum[0] += vector[0];
        sum[1] += vector[1];
        sum[2] += vector[2];
        used += 1;
    }
    if used == 0 {
        return None;
    }
    let scale = 1.0 / used as f64;
    Some([sum[0] * scale, sum[1] * scale, sum[2] * scale])
}

fn average_flat_magnetization(values: &[f64], start: usize, count: usize) -> Option<[f64; 3]> {
    if count == 0 {
        return None;
    }
    let end = start.saturating_add(count).min(values.len() / 3);
    if end <= start {
        return None;
    }
    let mut sum = [0.0; 3];
    let mut used = 0usize;
    for index in start..end {
        let offset = index * 3;
        let vector = [values[offset], values[offset + 1], values[offset + 2]];
        if !vector.iter().all(|value| value.is_finite()) {
            continue;
        }
        sum[0] += vector[0];
        sum[1] += vector[1];
        sum[2] += vector[2];
        used += 1;
    }
    if used == 0 {
        return None;
    }
    let scale = 1.0 / used as f64;
    Some([sum[0] * scale, sum[1] * scale, sum[2] * scale])
}

fn metadata_string(metadata: Option<&Value>, path: &[&str]) -> Option<String> {
    let mut current = metadata?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}

fn material_field_plan_warnings(metadata: Option<&Value>) -> Vec<String> {
    metadata
        .and_then(|value| value.get("execution_plan"))
        .and_then(|value| value.get("common"))
        .and_then(|value| value.get("material_field_plans"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|plan| plan.get("warnings").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn stage_stop_reason_string(reason: &fullmag_ir::StageStopReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("kind")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            _ => None,
        })
        .unwrap_or_else(|| format!("{reason:?}"))
}

fn runtime_status_kind(status: &crate::types::RuntimeStatusView) -> String {
    format!("{:?}", status.kind).to_ascii_lowercase()
}

fn command_status_resource(record: &TrackedCommandRecord) -> CommandStatusResource {
    CommandStatusResource {
        command_id: record.command.command_id.clone(),
        request_id: record.request_id.clone(),
        seq: record.command.seq,
        kind: record.command.kind.clone(),
        target: record.command.target.clone(),
        reason: record.command.reason.clone(),
        status: record.status.as_str().to_string(),
        created_at_unix_ms: record.command.created_at_unix_ms,
        dispatched_at_unix_ms: record.dispatched_at_unix_ms,
        completed_at_unix_ms: record.completed_at_unix_ms,
        completion_status: record
            .completion_status
            .map(command_completion_state_string),
        error: record.error.clone(),
    }
}

fn stage_id_for_index(index: usize) -> String {
    format!("stage-{index:03}")
}

pub(crate) struct HysteresisSceneStage {
    pub(crate) revision: u64,
    pub(crate) stage_id: String,
    pub(crate) stage_index: u32,
    pub(crate) value: serde_json::Map<String, Value>,
}

fn build_hysteresis_execution_tree(
    stage: HysteresisSceneStage,
    progress: HysteresisProgressSchema,
    query: HysteresisExecutionTreeQuery,
) -> HysteresisExecutionTreeResource {
    let before = query.before.unwrap_or(2).min(50);
    let after = query.after.unwrap_or(3).min(50);
    let window = query.window.unwrap_or_else(|| "active".to_string());
    let values = materialize_hysteresis_stage_field_values(&stage.value);
    let total_points = values.len() as u32;
    let active_point_index = infer_hysteresis_active_point_index(&progress, &values);

    let (start, end) = if total_points == 0 {
        (0, 0)
    } else if window == "active" {
        let active = active_point_index.unwrap_or(0);
        (
            active.saturating_sub(before),
            (active + after).min(total_points.saturating_sub(1)),
        )
    } else {
        (0, (before + after).min(total_points.saturating_sub(1)))
    };

    let mut nodes = Vec::new();
    if start > 0 {
        nodes.push(hysteresis_summary_node(
            &stage.stage_id,
            "completed-before",
            "done",
            format!("Completed {} points", start),
            stage.revision,
        ));
    }

    for idx in start..=end {
        if let Some(field_value_m_t) = values.get(idx as usize).copied() {
            nodes.push(hysteresis_field_point_node(
                &stage,
                &progress,
                idx,
                field_value_m_t,
                active_point_index,
            ));
        }
    }

    if end + 1 < total_points {
        nodes.push(hysteresis_summary_node(
            &stage.stage_id,
            "queued-after",
            "queued",
            format!("Queued {} points", total_points - end - 1),
            stage.revision,
        ));
    }

    HysteresisExecutionTreeResource {
        revision: stage.revision.max(progress.revision),
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        window,
        before,
        after,
        include_bookmarks: query.include_bookmarks.unwrap_or(true),
        include_warnings: query.include_warnings.unwrap_or(true),
        include_snapshots: query.include_snapshots.unwrap_or(true),
        total_points,
        active_point_index,
        nodes,
    }
}

fn hysteresis_summary_node(
    stage_id: &str,
    node_suffix: &str,
    status: &str,
    label: String,
    revision: u64,
) -> HysteresisExecutionTreeNode {
    HysteresisExecutionTreeNode {
        node_id: format!("{stage_id}:{node_suffix}"),
        kind: "transition".to_string(),
        stage_id: stage_id.to_string(),
        point_id: None,
        settle_step_id: None,
        status: status.to_string(),
        label,
        resource_ref: None,
        selection_ref: None,
        updated_revision: revision,
        children: Vec::new(),
    }
}

fn hysteresis_field_point_node(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    point_id: u32,
    field_value_m_t: f64,
    active_point_index: Option<u32>,
) -> HysteresisExecutionTreeNode {
    let status = match active_point_index {
        Some(active) if point_id < active => "done",
        Some(active) if point_id == active => "active",
        Some(_) => "queued",
        None if progress.status == "completed" => "done",
        _ => "queued",
    };
    let children = if status == "active" {
        hysteresis_settle_algorithm_nodes(stage, progress, point_id)
    } else {
        Vec::new()
    };
    HysteresisExecutionTreeNode {
        node_id: format!("{}:point:{point_id}", stage.stage_id),
        kind: "field_point".to_string(),
        stage_id: stage.stage_id.clone(),
        point_id: Some(point_id),
        settle_step_id: None,
        status: status.to_string(),
        label: format!("H = {field_value_m_t:+.3} mT"),
        resource_ref: Some(format!(
            "/v2/sessions/current/analysis/hysteresis/{}/steps/{point_id}",
            stage.stage_id
        )),
        selection_ref: Some(format!("hysteresis-point:{}:{point_id}", stage.stage_id)),
        updated_revision: stage.revision.max(progress.revision),
        children,
    }
}

fn hysteresis_settle_algorithm_nodes(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    point_id: u32,
) -> Vec<HysteresisExecutionTreeNode> {
    let steps = stage
        .value
        .get("settle_pipeline")
        .and_then(|pipeline| pipeline.get("steps"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(Vec::new);
    let active_step = progress.current_settle_step_index;
    steps
        .iter()
        .enumerate()
        .map(|(idx, step)| {
            let idx_u32 = idx as u32;
            let kind = value_string(step.get("kind")).unwrap_or_else(|| "settle".to_string());
            let method = value_string(step.get("method")).unwrap_or_else(|| kind.clone());
            let status = match active_step {
                Some(active) if idx_u32 < active => "done",
                Some(active) if idx_u32 == active => "active",
                Some(_) => "queued",
                None => "queued",
            };
            HysteresisExecutionTreeNode {
                node_id: format!("{}:point:{point_id}:settle:{idx_u32}", stage.stage_id),
                kind: "settle_algorithm".to_string(),
                stage_id: stage.stage_id.clone(),
                point_id: Some(point_id),
                settle_step_id: Some(format!("settle_step_{idx_u32:03}_{kind}")),
                status: status.to_string(),
                label: format!("{kind} {method}"),
                resource_ref: Some(format!(
                    "/v2/sessions/current/analysis/hysteresis/{}/steps/{point_id}/settle-trace",
                    stage.stage_id
                )),
                selection_ref: Some(format!(
                    "hysteresis-settle:{}:{point_id}:{idx_u32}",
                    stage.stage_id
                )),
                updated_revision: stage.revision.max(progress.revision),
                children: Vec::new(),
            }
        })
        .collect()
}

fn materialize_hysteresis_stage_field_values(stage: &serde_json::Map<String, Value>) -> Vec<f64> {
    if let Some(values) = value_f64_array(stage.get("field_values_mT")) {
        return values;
    }
    if let Some(segments) = stage
        .get("field_schedule")
        .and_then(|schedule| schedule.get("segments"))
        .and_then(Value::as_array)
    {
        let mut values = Vec::new();
        for segment in segments {
            let start = value_f64(segment.get("start")).unwrap_or(0.0);
            let stop = value_f64(segment.get("stop")).unwrap_or(start);
            let step = value_f64(segment.get("step")).unwrap_or(1.0);
            let endpoint_policy = value_string(segment.get("endpoint_policy"))
                .unwrap_or_else(|| "include_stop".to_string());
            for (idx, value) in materialize_field_segment_m_t(start, stop, step)
                .into_iter()
                .enumerate()
            {
                let include = match endpoint_policy.as_str() {
                    "skip_start" => idx > 0,
                    "include_both" => true,
                    _ => idx > 0 || values.last().is_none_or(|last| !same_m_t(*last, value)),
                };
                if include {
                    values.push(value);
                }
            }
        }
        return values;
    }

    let min = value_f64(stage.get("field_min_mT")).unwrap_or(-100.0);
    let max = value_f64(stage.get("field_max_mT")).unwrap_or(100.0);
    let step = value_f64(stage.get("field_step_mT")).unwrap_or(5.0).abs();
    match value_string(stage.get("branch_mode")).as_deref() {
        Some("major_loop") => {
            let mut values = materialize_field_segment_m_t(max, min, step);
            values.extend(
                materialize_field_segment_m_t(min, max, step)
                    .into_iter()
                    .skip(1),
            );
            values
        }
        Some("virgin_curve") => materialize_field_segment_m_t(0.0, max, step),
        Some("virgin_then_major_loop") => {
            let mut values = materialize_field_segment_m_t(0.0, max, step);
            values.extend(
                materialize_field_segment_m_t(max, min, step)
                    .into_iter()
                    .skip(1),
            );
            values.extend(
                materialize_field_segment_m_t(min, max, step)
                    .into_iter()
                    .skip(1),
            );
            values
        }
        _ => materialize_field_segment_m_t(min, max, step),
    }
}

fn materialize_field_segment_m_t(start: f64, stop: f64, step: f64) -> Vec<f64> {
    let abs_step = step.abs();
    if !start.is_finite() || !stop.is_finite() || !abs_step.is_finite() || abs_step <= 1e-15 {
        return vec![start, stop];
    }
    let direction = if stop >= start { 1.0 } else { -1.0 };
    let signed_step = abs_step * direction;
    let mut values = vec![start];
    let mut value = start;
    loop {
        let next = value + signed_step;
        if (direction > 0.0 && next >= stop - 1e-9) || (direction < 0.0 && next <= stop + 1e-9) {
            break;
        }
        values.push(next);
        value = next;
    }
    if values.last().is_none_or(|last| !same_m_t(*last, stop)) {
        values.push(stop);
    }
    values
}

fn same_m_t(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-9
}

pub(crate) async fn resolve_hysteresis_scene_stage(
    state: &Arc<AppState>,
    requested: &str,
) -> Result<HysteresisSceneStage, ApiError> {
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return Err(ApiError::not_found("no active workspace"));
    };
    let Some(scene) = snapshot.scene_document.as_ref() else {
        return Err(ApiError::not_found("scene document is not available"));
    };

    for (index, stage) in scene.study.stages.iter().enumerate() {
        let value = serde_json::to_value(stage)
            .map_err(|error| ApiError::internal(format!("failed to serialize stage: {error}")))?;
        let Some(object) = value.as_object() else {
            continue;
        };
        if !scene_stage_identifier_matches(object, index, requested) {
            continue;
        }
        if object.get("kind").and_then(Value::as_str) != Some("hysteresis") {
            return Err(ApiError::not_found(format!(
                "stage '{}' is not a hysteresis stage",
                requested
            )));
        }
        return Ok(HysteresisSceneStage {
            revision: snapshot.state_version,
            stage_id: object
                .get("stage_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| stage_id_for_index(index)),
            stage_index: index as u32,
            value: object.clone(),
        });
    }

    Err(ApiError::not_found(format!(
        "hysteresis stage '{}' not found",
        requested
    )))
}

fn scene_stage_identifier_matches(
    stage: &serde_json::Map<String, Value>,
    index: usize,
    requested: &str,
) -> bool {
    stage.get("stage_id").and_then(Value::as_str) == Some(requested)
        || stage_id_for_index(index) == requested
        || format!("stage_{index}") == requested
}

fn stage_identifier_matches(record: &StageExecutionRecord, index: usize, requested: &str) -> bool {
    record.stage_id.as_deref() == Some(requested)
        || stage_id_for_index(index) == requested
        || format!("stage_{index}") == requested
        || index.to_string() == requested
}

fn value_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn value_f64_array(value: Option<&Value>) -> Option<Vec<f64>> {
    value.and_then(Value::as_array).map(|values| {
        values
            .iter()
            .filter_map(Value::as_f64)
            .collect::<Vec<f64>>()
    })
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn value_vec3(value: Option<&Value>) -> Option<[f64; 3]> {
    let values = value?.as_array()?;
    if values.len() != 3 {
        return None;
    }
    Some([
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ])
}

fn stage_kind_for_index(stage: &crate::types::StageExecutionState, index: usize) -> Option<String> {
    if stage.active_stage_index == Some(index) {
        return stage.active_stage_kind.clone();
    }
    None
}

fn command_stage_id(
    target: &Option<crate::schemas::commands::RuntimeCommandTarget>,
) -> Option<String> {
    match target {
        Some(crate::schemas::commands::RuntimeCommandTarget::CurrentStage {
            stage_id: Some(stage_id),
        })
        | Some(crate::schemas::commands::RuntimeCommandTarget::StageId { stage_id }) => {
            Some(stage_id.clone())
        }
        Some(crate::schemas::commands::RuntimeCommandTarget::StageIndex { stage_index }) => {
            Some(stage_id_for_index(*stage_index as usize))
        }
        _ => None,
    }
}

fn command_stage_index(
    target: &Option<crate::schemas::commands::RuntimeCommandTarget>,
) -> Option<u32> {
    match target {
        Some(crate::schemas::commands::RuntimeCommandTarget::StageIndex { stage_index }) => {
            Some(*stage_index)
        }
        Some(crate::schemas::commands::RuntimeCommandTarget::CurrentStage {
            stage_id: Some(stage_id),
        })
        | Some(crate::schemas::commands::RuntimeCommandTarget::StageId { stage_id }) => {
            parse_stage_index(stage_id)
        }
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct CommandStageLinkage {
    stage_id: Option<String>,
    stage_index: Option<u32>,
    started_at_unix_ms: Option<u128>,
    completed_at_unix_ms: Option<u128>,
    artifact_refs: Vec<String>,
    checkpoint_ref: Option<String>,
    loaded_state_ref: Option<String>,
    resume_from_checkpoint_ref: Option<String>,
    state_transition: Option<String>,
}

fn command_stage_linkage(
    stage: Option<&StageExecutionState>,
    command_id: &str,
    target: &Option<crate::schemas::commands::RuntimeCommandTarget>,
) -> Option<CommandStageLinkage> {
    let stage = stage?;
    if let Some((index, record)) = stage
        .stages
        .iter()
        .enumerate()
        .find(|(_, record)| record.command_id.as_deref() == Some(command_id))
    {
        return Some(command_stage_linkage_from_record(index, record));
    }

    let stage_index = command_stage_index(target)? as usize;
    stage
        .stages
        .get(stage_index)
        .map(|record| command_stage_linkage_from_record(stage_index, record))
}

fn command_stage_linkage_from_record(
    index: usize,
    record: &StageExecutionRecord,
) -> CommandStageLinkage {
    CommandStageLinkage {
        stage_id: Some(stage_id_for_index(index)),
        stage_index: Some(index as u32),
        started_at_unix_ms: record.started_at_unix_ms.map(u128::from),
        completed_at_unix_ms: record.completed_at_unix_ms.map(u128::from),
        artifact_refs: record.artifact_refs.clone(),
        checkpoint_ref: record.checkpoint_ref.clone(),
        loaded_state_ref: record.loaded_state_ref.clone(),
        resume_from_checkpoint_ref: record.resume_from_checkpoint_ref.clone(),
        state_transition: record.state_transition.clone(),
    }
}

fn command_resource_invalidations(
    record: &TrackedCommandRecord,
    snapshot: Option<&SessionStateResponse>,
    stage_linkage: Option<&CommandStageLinkage>,
) -> Vec<CommandResourceInvalidationResource> {
    let mut resources = Vec::new();
    push_command_invalidation(
        &mut resources,
        "simulation/commands",
        record.command.seq,
        "command lifecycle",
        "observed",
    );

    let Some(snapshot) = snapshot else {
        return resources;
    };

    let state = command_downstream_invalidation_state(record.status);
    match record.command.kind.as_str() {
        "run" | "relax" | "solve" | "pause" | "resume" | "stop" | "skip" => {
            push_command_invalidation(
                &mut resources,
                "simulation/stages/execution",
                snapshot.state_version,
                "stage lifecycle",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/runs/current",
                snapshot.state_version,
                "run lifecycle",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/solver/status",
                snapshot.state_version,
                "runtime state",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "data/scalars",
                snapshot.scalar_revision,
                "solver scalar history",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/solver/energies/current",
                snapshot.scalar_revision,
                "energy readback",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/solver/energies/history",
                snapshot.scalar_revision,
                "energy history",
                state,
            );
        }
        "compute_fields" => {
            push_command_invalidation(
                &mut resources,
                "data/fields",
                snapshot.state_version,
                "field buffers",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "visualization/display",
                snapshot.state_version,
                "field display freshness",
                state,
            );
        }
        "compute_energies" => {
            push_command_invalidation(
                &mut resources,
                "data/scalars",
                snapshot.scalar_revision,
                "scalar history",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/solver/energies/current",
                snapshot.scalar_revision,
                "energy readback",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/solver/energies/history",
                snapshot.scalar_revision,
                "energy history",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "simulation/objects/*/metrics",
                snapshot.scalar_revision,
                "object metric readback",
                state,
            );
        }
        "remesh" => {
            push_command_invalidation(
                &mut resources,
                "meshing/builds/current",
                snapshot.mesh_build_revision,
                "mesh build lifecycle",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "meshing/shared-domain/manifest",
                snapshot.mesh_revision,
                "shared-domain mesh manifest",
                state,
            );
            push_command_invalidation(
                &mut resources,
                "data/domain/topology",
                snapshot.mesh_revision,
                "topology buffers",
                state,
            );
        }
        "save_vtk" => {
            push_command_invalidation(
                &mut resources,
                "data/artifacts",
                snapshot.artifacts.len() as u64,
                "artifact export",
                state,
            );
        }
        "set_solver_profile" => {
            push_command_invalidation(
                &mut resources,
                "diagnostics/solver-profile",
                snapshot.solver_profile.revision,
                "solver profiler configuration",
                state,
            );
        }
        _ => {}
    }

    if stage_linkage.is_some_and(|linkage| !linkage.artifact_refs.is_empty()) {
        push_command_invalidation(
            &mut resources,
            "data/artifacts",
            snapshot.artifacts.len() as u64,
            "stage artifact linkage",
            state,
        );
    }
    if stage_linkage.is_some_and(|linkage| {
        linkage.checkpoint_ref.is_some()
            || linkage.loaded_state_ref.is_some()
            || linkage.resume_from_checkpoint_ref.is_some()
    }) {
        push_command_invalidation(
            &mut resources,
            "persistence/checkpoints",
            snapshot.state_version,
            "checkpoint state linkage",
            state,
        );
    }
    push_command_invalidation(
        &mut resources,
        "diagnostics/engine-log",
        snapshot.engine_log.len() as u64,
        "engine diagnostics",
        state,
    );

    resources
}

fn push_command_invalidation(
    resources: &mut Vec<CommandResourceInvalidationResource>,
    resource_key: &str,
    revision: u64,
    reason: &str,
    state: &str,
) {
    if resources
        .iter()
        .any(|resource| resource.resource_key == resource_key)
    {
        return;
    }
    resources.push(CommandResourceInvalidationResource {
        resource_key: resource_key.to_string(),
        revision,
        reason: reason.to_string(),
        state: state.to_string(),
    });
}

fn command_downstream_invalidation_state(status: CommandLifecycleState) -> &'static str {
    match status {
        CommandLifecycleState::Queued | CommandLifecycleState::Accepted => "expected",
        CommandLifecycleState::Dispatched
        | CommandLifecycleState::Running
        | CommandLifecycleState::Completed
        | CommandLifecycleState::Rejected
        | CommandLifecycleState::Failed => "observed",
    }
}

fn command_diagnostic_references(
    record: &TrackedCommandRecord,
    snapshot: Option<&SessionStateResponse>,
    stage_linkage: Option<&CommandStageLinkage>,
) -> Vec<CommandDiagnosticReferenceResource> {
    let mut diagnostics = Vec::new();
    if let Some(error) = record.error.as_ref() {
        diagnostics.push(CommandDiagnosticReferenceResource {
            resource_key: "simulation/commands".into(),
            revision: record.command.seq,
            severity: "error".into(),
            message: error.clone(),
        });
    }

    if let Some(snapshot) = snapshot {
        diagnostics.push(CommandDiagnosticReferenceResource {
            resource_key: "diagnostics/engine-log".into(),
            revision: snapshot.engine_log.len() as u64,
            severity: "info".into(),
            message: "Engine log may contain runtime entries for this command.".into(),
        });
        if record.command.kind == "set_solver_profile" {
            diagnostics.push(CommandDiagnosticReferenceResource {
                resource_key: "diagnostics/solver-profile".into(),
                revision: snapshot.solver_profile.revision,
                severity: "info".into(),
                message: "Solver profiler configuration and samples are available as a diagnostics resource."
                    .into(),
            });
        }
        if stage_linkage.is_some_and(|linkage| !linkage.artifact_refs.is_empty()) {
            diagnostics.push(CommandDiagnosticReferenceResource {
                resource_key: "data/artifacts".into(),
                revision: snapshot.artifacts.len() as u64,
                severity: "info".into(),
                message: "Command produced stage artifacts; inspect artifact resources for payload detail."
                    .into(),
            });
        }
    }

    diagnostics
}

fn parse_stage_index(stage_id: &str) -> Option<u32> {
    stage_id.strip_prefix("stage-")?.parse::<u32>().ok()
}

fn requested_execution_readback(
    snapshot: &SessionStateResponse,
) -> CommandExecutionReadbackResource {
    CommandExecutionReadbackResource {
        backend: Some(snapshot.session.requested_backend.clone()),
        device: Some(snapshot.session.requested_device.clone()),
        precision: Some(snapshot.session.requested_precision.clone()),
        mode: Some(snapshot.session.requested_mode.clone()),
        runtime_family: None,
        engine_id: None,
        worker: None,
    }
}

fn resolved_execution_readback(
    snapshot: &SessionStateResponse,
) -> Option<CommandExecutionReadbackResource> {
    if snapshot.session.resolved_backend.is_none()
        && snapshot.session.resolved_device.is_none()
        && snapshot.session.resolved_precision.is_none()
        && snapshot.session.resolved_mode.is_none()
        && snapshot.session.resolved_runtime_family.is_none()
        && snapshot.session.resolved_engine_id.is_none()
        && snapshot.session.resolved_worker.is_none()
    {
        return None;
    }

    Some(CommandExecutionReadbackResource {
        backend: snapshot.session.resolved_backend.clone(),
        device: snapshot.session.resolved_device.clone(),
        precision: snapshot.session.resolved_precision.clone(),
        mode: snapshot.session.resolved_mode.clone(),
        runtime_family: snapshot.session.resolved_runtime_family.clone(),
        engine_id: snapshot.session.resolved_engine_id.clone(),
        worker: snapshot.session.resolved_worker.clone(),
    })
}

fn command_completion_state_string(state: CommandCompletionState) -> String {
    state.as_str().to_string()
}

async fn ensure_workspace(state: &Arc<AppState>) -> Result<(), ApiError> {
    let guard = state.current_live_state.read().await;
    if guard.is_some() {
        Ok(())
    } else {
        Err(ApiError::not_found("no active local live workspace"))
    }
}
