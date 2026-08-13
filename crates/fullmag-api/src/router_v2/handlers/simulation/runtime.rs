use std::collections::{BTreeSet, HashMap};
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
use crate::router_v2::handlers::analysis::hysteresis::{
    hysteresis_bookmarks_resource, read_hysteresis_minor_loops_if_available,
    read_hysteresis_points_if_available, read_hysteresis_settle_trace_if_available,
};
use crate::schemas::hysteresis::{
    HysteresisBookmarkSchema, HysteresisExecutionTreeNode, HysteresisExecutionTreeResource,
    HysteresisFieldUnitProvenanceSchema, HysteresisMinorLoopSchema, HysteresisOrientationSchema,
    HysteresisPointSchema, HysteresisProgressSchema, HysteresisProtocolSchema,
    HysteresisResolvedSettleStepSchema, HysteresisSettlePipelineSchema,
    HysteresisSettleTraceEntrySchema, HysteresisStagePlanSchema, HysteresisStageSaturationSchema,
    HysteresisStorageEstimateSchema,
};
use crate::schemas::preparation::{
    PreparationClockAdjustment, PreparationExecutionSummary, PreparationFailureResource,
    PreparationLogEntryResource, PreparationLogLevel, PreparationProgressStage, PreparationStageId,
    PreparationStageStatus, PreparationStatus, SimulationPreparationResource,
};
use crate::schemas::relaxation::{
    canonical_torque_apm, torque_t_from_apm, RelaxationAlgorithm, StageMetricKind, StageMetricUnit,
    StageStopReason,
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
    path = "/v2/sessions/current/simulation/preparation",
    responses(
        (status = 200, description = "Current simulation preparation resource", body = SimulationPreparationResource),
        (status = 404, description = "Simulation preparation is not available", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "simulation"
)]
pub async fn get_simulation_preparation(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SimulationPreparationResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let preparation = snapshot
        .simulation_preparation
        .as_ref()
        .ok_or_else(|| ApiError::not_found("simulation preparation unavailable"))?;

    const CANONICAL_STAGE_IDS: [&str; 9] = [
        "runtime_startup",
        "script_materialization",
        "validation",
        "planning",
        "domain_preparation",
        "meshing",
        "mesh_postprocessing",
        "solver_initialization",
        "ready",
    ];
    if preparation.stages.len() != CANONICAL_STAGE_IDS.len()
        || !preparation
            .stages
            .iter()
            .map(|stage| stage.id.as_str())
            .eq(CANONICAL_STAGE_IDS)
    {
        return Err(ApiError::internal(
            "simulation preparation stages do not match the canonical nine-stage order",
        ));
    }

    let stages = preparation
        .stages
        .iter()
        .map(|stage| {
            if stage.progress_percent.is_some_and(|percent| percent > 100) {
                return Err(ApiError::internal(format!(
                    "simulation preparation stage '{}' has progress above 100",
                    stage.id
                )));
            }
            Ok(PreparationProgressStage {
                id: preparation_stage_id(&stage.id)?,
                label: bounded_preparation_string(&stage.label, 128),
                detail: bounded_preparation_string(&stage.detail, 1024),
                status: preparation_stage_status(&stage.status)?,
                started_at_unix_ms: stage.started_at_unix_ms,
                completed_at_unix_ms: stage.completed_at_unix_ms,
                duration_ms: stage.duration_ms,
                clock_adjustment: stage.clock_adjustment.as_ref().map(|adjustment| {
                    PreparationClockAdjustment {
                        observed_at_unix_ms: adjustment.observed_at_unix_ms,
                        stage_started_at_unix_ms: adjustment.stage_started_at_unix_ms,
                        backward_delta_ms: adjustment.backward_delta_ms,
                    }
                }),
                progress_percent: stage.progress_percent,
                progress_label: stage
                    .progress_label
                    .as_deref()
                    .map(|value| bounded_preparation_string(value, 256)),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let log_tail_start = preparation.log_tail.len().saturating_sub(200);
    let log_tail = preparation.log_tail[log_tail_start..]
        .iter()
        .map(|entry| {
            Ok(PreparationLogEntryResource {
                timestamp_unix_ms: entry.timestamp_unix_ms,
                level: preparation_log_level(&entry.level)?,
                stage_id: preparation_stage_id(&entry.stage_id)?,
                message: bounded_preparation_string(&entry.message, 2048),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let failure = preparation
        .failure
        .as_ref()
        .map(|failure| -> Result<PreparationFailureResource, ApiError> {
            Ok(PreparationFailureResource {
                error_code: bounded_preparation_string(&failure.error_code, 128),
                summary: bounded_preparation_string(&failure.summary, 1024),
                detail: failure
                    .detail
                    .as_deref()
                    .map(|value| bounded_preparation_string(value, 1024)),
                stage_id: preparation_stage_id(&failure.stage_id)?,
                diagnostics_correlation_id: failure
                    .diagnostics_correlation_id
                    .as_deref()
                    .map(|value| bounded_preparation_string(value, 256)),
            })
        })
        .transpose()?;

    Ok(Json(SimulationPreparationResource {
        preparation_id: bounded_preparation_string(&preparation.preparation_id, 128),
        revision: preparation.revision,
        status: preparation_status(&preparation.status)?,
        active_stage_id: preparation
            .active_stage_id
            .as_deref()
            .map(preparation_stage_id)
            .transpose()?,
        started_at_unix_ms: preparation.started_at_unix_ms,
        completed_at_unix_ms: preparation.completed_at_unix_ms,
        requested_execution: PreparationExecutionSummary {
            backend: Some(bounded_preparation_string(
                &snapshot.session.requested_backend,
                128,
            )),
            device: Some(bounded_preparation_string(
                &snapshot.session.requested_device,
                128,
            )),
            precision: Some(bounded_preparation_string(
                &snapshot.session.requested_precision,
                128,
            )),
            mode: Some(bounded_preparation_string(
                &snapshot.session.requested_mode,
                128,
            )),
            runtime_family: None,
            engine_id: None,
            worker: None,
        },
        resolved_execution: resolved_preparation_execution(snapshot),
        stages,
        log_tail,
        failure,
    }))
}

fn resolved_preparation_execution(
    snapshot: &SessionStateResponse,
) -> Option<PreparationExecutionSummary> {
    let session = &snapshot.session;
    if session.resolved_backend.is_none()
        && session.resolved_device.is_none()
        && session.resolved_precision.is_none()
        && session.resolved_mode.is_none()
        && session.resolved_runtime_family.is_none()
        && session.resolved_engine_id.is_none()
        && session.resolved_worker.is_none()
    {
        return None;
    }
    Some(PreparationExecutionSummary {
        backend: bounded_preparation_optional_string(session.resolved_backend.as_deref()),
        device: bounded_preparation_optional_string(session.resolved_device.as_deref()),
        precision: bounded_preparation_optional_string(session.resolved_precision.as_deref()),
        mode: bounded_preparation_optional_string(session.resolved_mode.as_deref()),
        runtime_family: bounded_preparation_optional_string(
            session.resolved_runtime_family.as_deref(),
        ),
        engine_id: bounded_preparation_optional_string(session.resolved_engine_id.as_deref()),
        worker: bounded_preparation_optional_string(session.resolved_worker.as_deref()),
    })
}

fn bounded_preparation_optional_string(value: Option<&str>) -> Option<String> {
    value.map(|value| bounded_preparation_string(value, 128))
}

fn bounded_preparation_string(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn preparation_status(value: &str) -> Result<PreparationStatus, ApiError> {
    match value {
        "connecting" => Ok(PreparationStatus::Connecting),
        "running" => Ok(PreparationStatus::Running),
        "ready" => Ok(PreparationStatus::Ready),
        "failed" => Ok(PreparationStatus::Failed),
        other => Err(ApiError::internal(format!(
            "unknown simulation preparation status: {other}"
        ))),
    }
}

fn preparation_stage_id(value: &str) -> Result<PreparationStageId, ApiError> {
    match value {
        "runtime_startup" => Ok(PreparationStageId::RuntimeStartup),
        "script_materialization" => Ok(PreparationStageId::ScriptMaterialization),
        "validation" => Ok(PreparationStageId::Validation),
        "planning" => Ok(PreparationStageId::Planning),
        "domain_preparation" => Ok(PreparationStageId::DomainPreparation),
        "meshing" => Ok(PreparationStageId::Meshing),
        "mesh_postprocessing" => Ok(PreparationStageId::MeshPostprocessing),
        "solver_initialization" => Ok(PreparationStageId::SolverInitialization),
        "ready" => Ok(PreparationStageId::Ready),
        other => Err(ApiError::internal(format!(
            "unknown simulation preparation stage: {other}"
        ))),
    }
}

fn preparation_stage_status(value: &str) -> Result<PreparationStageStatus, ApiError> {
    match value {
        "pending" => Ok(PreparationStageStatus::Pending),
        "active" => Ok(PreparationStageStatus::Active),
        "completed" => Ok(PreparationStageStatus::Completed),
        "failed" => Ok(PreparationStageStatus::Failed),
        "skipped" => Ok(PreparationStageStatus::Skipped),
        other => Err(ApiError::internal(format!(
            "unknown simulation preparation stage status: {other}"
        ))),
    }
}

fn preparation_log_level(value: &str) -> Result<PreparationLogLevel, ApiError> {
    match value {
        "info" => Ok(PreparationLogLevel::Info),
        "warning" => Ok(PreparationLogLevel::Warning),
        "error" => Ok(PreparationLogLevel::Error),
        other => Err(ApiError::internal(format!(
            "unknown simulation preparation log level: {other}"
        ))),
    }
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
            .map(|(index, record)| {
                let kind = record
                    .kind
                    .clone()
                    .or_else(|| stage_kind_for_index(stage, index));
                let progress =
                    frequency_response_stage_progress(snapshot, stage, index, kind.as_deref());
                StageExecutionRecordResource {
                    stage_id: record
                        .stage_id
                        .clone()
                        .unwrap_or_else(|| stage_id_for_index(index)),
                    index: index as u32,
                    label: Some(format!("Stage {}", index + 1)),
                    kind,
                    action: None,
                    status: record.status.as_str().to_string(),
                    command_id: record.command_id.clone(),
                    started_at_unix_ms: record.started_at_unix_ms,
                    completed_at_unix_ms: record.completed_at_unix_ms,
                    time_to_tolerance_seconds: time_to_tolerance_seconds(record),
                    reason: record.reason.clone().map(StageStopReason::from),
                    converged: record.converged,
                    artifact_refs: record.artifact_refs.clone(),
                    checkpoint_ref: record.checkpoint_ref.clone(),
                    loaded_state_ref: record.loaded_state_ref.clone(),
                    resume_from_checkpoint_ref: record.resume_from_checkpoint_ref.clone(),
                    state_transition: record.state_transition.clone(),
                    state_transition_kind: record.state_transition_kind.clone(),
                    state_transition_reason: record.state_transition_reason.clone(),
                    state_transfer_operator_kind: record.state_transfer_operator_kind.clone(),
                    state_transition_ui_presentation: record
                        .state_transition_ui_presentation
                        .clone(),
                    metric_kind: record.metric.map(StageMetricKind::from),
                    metric_unit: record.metric.map(StageMetricUnit::from),
                    metric_name: record.metric_name.clone(),
                    metric_value: record.metric_value,
                    threshold: record.threshold,
                    progress_percent: progress
                        .as_ref()
                        .and_then(|value| value.progress_percent)
                        .or(record.progress_percent),
                    progress_label: progress
                        .as_ref()
                        .and_then(|value| value.progress_label.clone())
                        .or_else(|| record.progress_label.clone()),
                    progress_detail: progress
                        .as_ref()
                        .and_then(|value| value.progress_detail.clone())
                        .or_else(|| record.progress_detail.clone()),
                    last_progress_unix_ms: progress
                        .as_ref()
                        .and_then(|value| value.last_progress_unix_ms)
                        .or(record.last_progress_unix_ms),
                    current_field_m_t: record.current_field_m_t,
                    current_point_index: record.current_point_index,
                    current_settle_step_index: record.current_settle_step_index,
                    current_settle_step_kind: record.current_settle_step_kind.clone(),
                    current_settle_step_method: record.current_settle_step_method.clone(),
                }
            })
            .collect(),
    })
    .into_response())
}

struct StageProgressProjection {
    progress_percent: Option<f64>,
    progress_label: Option<String>,
    progress_detail: Option<String>,
    last_progress_unix_ms: Option<u64>,
}

fn time_to_tolerance_seconds(record: &StageExecutionRecord) -> Option<f64> {
    if record.status != crate::types::StageLifecycleState::Completed || !record.converged {
        return None;
    }
    let metric_matches_reason = matches!(
        (record.reason, record.metric, record.metric_name.as_deref()),
        (
            Some(fullmag_ir::StageStopReason::Torque),
            Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
            Some("max_torque_apm")
        ) | (
            Some(fullmag_ir::StageStopReason::Energy),
            Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
            Some("total_energy_plateau_range_J")
        )
    );
    if !metric_matches_reason {
        return None;
    }
    let metric_value = record.metric_value?;
    let threshold = record.threshold?;
    if !metric_value.is_finite()
        || !threshold.is_finite()
        || metric_value < 0.0
        || threshold < 0.0
        || metric_value > threshold
    {
        return None;
    }
    let elapsed_ms = record
        .completed_at_unix_ms?
        .checked_sub(record.started_at_unix_ms?)?;
    Some(elapsed_ms as f64 / 1_000.0)
}

#[cfg(test)]
mod time_to_tolerance_tests {
    use super::time_to_tolerance_seconds;
    use crate::types::StageExecutionRecord;
    use fullmag_ir::{StageMetricKind, StageStopReason};

    fn completion(
        reason: StageStopReason,
        metric: StageMetricKind,
        metric_name: &str,
        metric_value: f64,
        threshold: f64,
    ) -> StageExecutionRecord {
        serde_json::from_value(serde_json::json!({
            "status": "completed",
            "converged": true,
            "reason": reason,
            "metric": metric,
            "metric_name": metric_name,
            "metric_value": metric_value,
            "threshold": threshold,
            "started_at_unix_ms": 1_000,
            "completed_at_unix_ms": 6_000,
        }))
        .expect("valid stage execution fixture")
    }

    #[test]
    fn duration_is_exposed_only_for_tolerance_qualified_completion() {
        for record in [
            completion(
                StageStopReason::Torque,
                StageMetricKind::MaxTorqueApm,
                "max_torque_apm",
                5.0,
                10.0,
            ),
            completion(
                StageStopReason::Energy,
                StageMetricKind::TotalEnergyPlateauRangeJ,
                "total_energy_plateau_range_J",
                1.0e-20,
                2.0e-20,
            ),
        ] {
            assert_eq!(time_to_tolerance_seconds(&record), Some(5.0));
        }
    }

    #[test]
    fn duration_fails_closed_for_incoherent_completion_records() {
        let valid = completion(
            StageStopReason::Torque,
            StageMetricKind::MaxTorqueApm,
            "max_torque_apm",
            5.0,
            10.0,
        );
        let mut invalid = Vec::new();

        for (status, converged, reason) in [
            ("completed", false, StageStopReason::MaxSteps),
            ("completed", false, StageStopReason::MaxPseudotime),
            ("completed", false, StageStopReason::MaxPhysicalTime),
            ("cancelled", false, StageStopReason::UserCancelled),
            ("failed", false, StageStopReason::BackendError),
        ] {
            let mut record = valid.clone();
            record.status = serde_json::from_value(serde_json::json!(status)).unwrap();
            record.converged = converged;
            record.reason = Some(reason);
            invalid.push(record);
        }
        let mutate = |change: fn(&mut StageExecutionRecord)| {
            let mut record = valid.clone();
            change(&mut record);
            record
        };
        invalid.extend([
            mutate(|record| record.reason = None),
            mutate(|record| record.metric = None),
            mutate(|record| record.metric_name = None),
            mutate(|record| record.metric_value = None),
            mutate(|record| record.threshold = None),
            mutate(|record| record.metric_value = Some(f64::NAN)),
            mutate(|record| record.threshold = Some(f64::INFINITY)),
            mutate(|record| record.metric_value = Some(-1.0)),
            mutate(|record| record.threshold = Some(-1.0)),
            mutate(|record| record.metric_value = Some(11.0)),
            mutate(|record| record.metric = Some(StageMetricKind::TotalEnergyPlateauRangeJ)),
            mutate(|record| record.metric_name = Some("total_energy_plateau_range_J".to_string())),
            mutate(|record| record.started_at_unix_ms = None),
            mutate(|record| record.completed_at_unix_ms = None),
            mutate(|record| record.started_at_unix_ms = Some(7_000)),
        ]);

        let mut stagnation = valid.clone();
        stagnation.status = serde_json::from_value(serde_json::json!("failed")).unwrap();
        stagnation.converged = false;
        stagnation.reason = Some(StageStopReason::Gradient);
        stagnation.metric = Some(StageMetricKind::NumericalStagnation);
        stagnation.metric_name = Some("numerical_stagnation".to_string());
        stagnation.metric_value = Some(1.0);
        stagnation.threshold = Some(1.0);
        invalid.push(stagnation);

        for status in ["skipped", "stopped"] {
            let mut record = valid.clone();
            record.status = serde_json::from_value(serde_json::json!(status)).unwrap();
            record.converged = false;
            record.reason = None;
            invalid.push(record);
        }

        for record in invalid {
            assert_eq!(time_to_tolerance_seconds(&record), None, "{record:?}");
        }
    }
}

fn frequency_response_stage_progress(
    snapshot: &SessionStateResponse,
    stage: &StageExecutionState,
    index: usize,
    kind: Option<&str>,
) -> Option<StageProgressProjection> {
    if stage.active_stage_index != Some(index) || !is_frequency_response_stage_kind(kind) {
        return None;
    }
    let live_state = snapshot.live_state.as_ref()?;
    let progress = live_state
        .latest_step
        .per_object_scalars
        .get("fem_frequency_response_progress")?;
    let total = finite_positive(progress.get("total_frequency_count").copied())?;
    let completed = finite_nonnegative(progress.get("completed_frequency_count").copied())?;
    let percent = progress
        .get("percent")
        .copied()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.clamp(0.0, 100.0))
        .or_else(|| Some(((completed / total) * 100.0).clamp(0.0, 100.0)));
    let current_point = (completed.floor() as u64).saturating_add(1);
    let total_points = total.floor().max(1.0) as u64;
    let current_point = current_point.clamp(1, total_points);
    let mut detail_parts = Vec::new();
    if let Some(demag_mode) = frequency_response_demag_mode_from_progress(progress) {
        detail_parts.push(format!("demag={demag_mode}"));
    }
    if let (Some(min_hz), Some(max_hz)) = (
        finite_positive(progress.get("frequency_min_hz").copied()),
        finite_positive(progress.get("frequency_max_hz").copied()),
    ) {
        detail_parts.push(format!(
            "range={:.6}-{:.6} GHz",
            min_hz / 1.0e9,
            max_hz / 1.0e9
        ));
    }
    detail_parts.push(format!("frequency point {current_point}/{total_points}"));
    detail_parts.push(format!("completed={}", completed.floor().max(0.0) as u64));
    if let Some(frequency_hz) = finite_positive(progress.get("frequency_hz").copied()) {
        detail_parts.push(format!("f={:.6} GHz", frequency_hz / 1.0e9));
    }
    if let Some(iteration) = finite_nonnegative(progress.get("iteration").copied()) {
        if let Some(max_iterations) =
            finite_positive(progress.get("max_iterations_for_frequency").copied())
        {
            detail_parts.push(format!(
                "GMRES iteration={}/{}",
                iteration.floor() as u64,
                max_iterations.floor() as u64
            ));
        } else {
            detail_parts.push(format!("GMRES iteration={}", iteration.floor() as u64));
        }
    }
    if let Some(solve_fraction) =
        finite_nonnegative(progress.get("current_frequency_solve_fraction").copied())
    {
        detail_parts.push(format!(
            "current frequency solve={:.0}%",
            solve_fraction.clamp(0.0, 1.0) * 100.0
        ));
    }
    if let Some(residual) = finite_nonnegative(progress.get("relative_residual_l2_norm").copied()) {
        detail_parts.push(format!("relative residual={residual:.3e}"));
    }

    Some(StageProgressProjection {
        progress_percent: percent,
        progress_label: Some("solving frequency point".to_string()),
        progress_detail: Some(detail_parts.join("; ")),
        last_progress_unix_ms: u64::try_from(live_state.updated_at_unix_ms).ok(),
    })
}

fn is_frequency_response_stage_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("frequency_response" | "flat_frequency_response"))
}

fn frequency_response_demag_mode_from_progress(
    progress: &HashMap<String, f64>,
) -> Option<&'static str> {
    if progress
        .get("demag_periodic_airbox_k0")
        .copied()
        .unwrap_or(0.0)
        > 0.0
    {
        Some("periodic_airbox_k0")
    } else if progress.get("demag_floquet_airbox").copied().unwrap_or(0.0) > 0.0 {
        Some("floquet_airbox")
    } else if progress.get("demag_enabled").copied().unwrap_or(0.0) > 0.0 {
        Some("enabled")
    } else {
        None
    }
}

fn finite_positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

fn finite_nonnegative(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
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
    let site_count = current_hysteresis_storage_site_count(&state).await;
    let storage_estimate = estimate_hysteresis_storage(&stage.value, site_count);
    Ok(Json(HysteresisStagePlanSchema {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        field_min_m_t: value_f64(stage.value.get("field_min_mT")),
        field_max_m_t: value_f64(stage.value.get("field_max_mT")),
        field_step_m_t: value_f64(stage.value.get("field_step_mT")),
        field_values_m_t: value_f64_array(stage.value.get("field_values_mT")),
        field_unit_provenance: field_unit_provenance_schema(
            stage.value.get("field_unit_provenance"),
        ),
        field_schedule: stage.value.get("field_schedule").cloned(),
        schedule_refinements: stage.value.get("schedule_refinements").cloned(),
        angular_family: stage.value.get("angular_family").cloned(),
        adaptive_refinement: stage.value.get("adaptive_refinement").cloned(),
        minor_loops: stage.value.get("minor_loops").cloned(),
        branch_mode: value_string(stage.value.get("branch_mode")),
        storage_estimate: Some(storage_estimate),
    }))
}

fn estimate_hysteresis_storage(
    stage: &serde_json::Map<String, Value>,
    site_count: Option<u64>,
) -> HysteresisStorageEstimateSchema {
    let point_count = Some(materialize_hysteresis_stage_field_values(stage).len() as u64);
    let storage = stage.get("storage");
    let (policy, snapshot_count, mut warnings) =
        estimate_hysteresis_snapshot_count(storage, point_count);
    let components_per_site = 3;
    let bytes_per_component = 8;
    let estimated_bytes = snapshot_count
        .zip(site_count)
        .and_then(|(snapshots, sites)| {
            snapshots
                .checked_mul(sites)
                .and_then(|value| value.checked_mul(u64::from(components_per_site)))
                .and_then(|value| value.checked_mul(u64::from(bytes_per_component)))
        });

    if point_count.is_none() {
        warnings.push(
            "Point count is unknown because the field schedule cannot be resolved yet.".to_string(),
        );
    }
    if snapshot_count.unwrap_or(0) > 0 && site_count.is_none() {
        warnings.push(
            "Domain site count is unavailable before a realized mesh or field resource is loaded; byte estimate is pending."
                .to_string(),
        );
    }

    let status = if estimated_bytes.is_some() {
        "estimated"
    } else if point_count.is_some() || snapshot_count.is_some() {
        "partial"
    } else {
        "unknown"
    }
    .to_string();

    HysteresisStorageEstimateSchema {
        policy,
        point_count,
        snapshot_count,
        site_count,
        components_per_site,
        bytes_per_component,
        estimated_bytes,
        status,
        warnings,
    }
}

async fn current_hysteresis_storage_site_count(state: &Arc<AppState>) -> Option<u64> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard.as_ref()?;
    if let Some(mesh) = snapshot.fem_mesh.as_ref() {
        return Some(mesh.nodes.len() as u64);
    }
    latest_field_site_count(snapshot.latest_fields.get("m"))
}

fn latest_field_site_count(value: Option<&Value>) -> Option<u64> {
    let values = value?.as_array()?;
    if values.is_empty() {
        return None;
    }
    if values.iter().all(|entry| {
        entry
            .as_array()
            .is_some_and(|components| components.len() == 3)
    }) {
        return Some(values.len() as u64);
    }
    if values.len() % 3 == 0 && values.iter().all(Value::is_number) {
        return Some((values.len() / 3) as u64);
    }
    None
}

fn estimate_hysteresis_snapshot_count(
    storage: Option<&Value>,
    point_count: Option<u64>,
) -> (String, Option<u64>, Vec<String>) {
    let mut warnings = Vec::new();
    let Some(storage) = storage else {
        return ("average_only".to_string(), Some(0), warnings);
    };
    let magnetization = storage
        .get("magnetization")
        .and_then(Value::as_str)
        .unwrap_or("none");
    match magnetization {
        "all" | "every_step" => {
            if point_count.unwrap_or(0) > 100 {
                warnings.push(
                    "Every-step magnetization snapshots can create large artifacts for dense hysteresis schedules."
                        .to_string(),
                );
            }
            ("every_step".to_string(), point_count, warnings)
        }
        "selected" | "every_n" => {
            let every_n = storage
                .get("every_n")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0);
            let snapshot_count = point_count
                .zip(every_n)
                .map(|(points, every_n)| points.saturating_add(every_n - 1) / every_n);
            if every_n.is_none() {
                warnings.push(
                    "Selected snapshot storage is missing a positive every_n value.".to_string(),
                );
            }
            (
                every_n
                    .map(|value| format!("selected_every_{value}"))
                    .unwrap_or_else(|| "selected".to_string()),
                snapshot_count,
                warnings,
            )
        }
        "key_events" => {
            warnings.push(
                "Key-event snapshot count depends on the executed magnetization trajectory."
                    .to_string(),
            );
            ("key_events".to_string(), None, warnings)
        }
        "none" => ("scalar_averages_only".to_string(), Some(0), warnings),
        other => {
            warnings.push(format!("Unknown magnetization storage policy '{other}'."));
            (other.to_string(), None, warnings)
        }
    }
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
    let resolved_steps = build_hysteresis_resolved_settle_steps(&stage);
    let resolved_branch_ids = build_hysteresis_resolved_branch_ids(&stage);
    Ok(Json(HysteresisSettlePipelineSchema {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        settle_pipeline: stage.value.get("settle_pipeline").cloned(),
        resolved_steps,
        resolved_branch_ids,
    }))
}

fn build_hysteresis_resolved_settle_steps(
    stage: &HysteresisSceneStage,
) -> Vec<HysteresisResolvedSettleStepSchema> {
    let Some(pipeline) = stage
        .value
        .get("settle_pipeline")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut resolved_steps = Vec::new();
    if let Some(steps) = pipeline.get("steps").and_then(Value::as_array) {
        for step in steps {
            push_hysteresis_resolved_settle_step(&mut resolved_steps, step, None, None);
        }
        return resolved_steps;
    }

    if let Some(default_step) = pipeline.get("default") {
        push_hysteresis_resolved_settle_step(
            &mut resolved_steps,
            default_step,
            Some("default"),
            None,
        );
    }
    if let Some(branches) = pipeline.get("branches").and_then(Value::as_array) {
        for branch in branches {
            let branch_when = branch.get("when").and_then(Value::as_str);
            if let Some(run) = branch.get("run") {
                push_hysteresis_resolved_settle_step(
                    &mut resolved_steps,
                    run,
                    Some("branch"),
                    branch_when,
                );
            }
        }
    }
    resolved_steps
}

fn push_hysteresis_resolved_settle_step(
    resolved_steps: &mut Vec<HysteresisResolvedSettleStepSchema>,
    step: &Value,
    pipeline_role: Option<&str>,
    branch_when: Option<&str>,
) {
    let step_index = resolved_steps.len() as u32;
    let kind = value_string(step.get("kind")).unwrap_or_else(|| "settle".to_string());
    let method = value_string(step.get("method")).unwrap_or_else(|| kind.clone());
    let mut resolved_parameters = step.clone();
    if let Some(object) = resolved_parameters.as_object_mut() {
        if let Some(role) = pipeline_role {
            object.insert("pipeline_role".to_string(), Value::String(role.to_string()));
        }
        if let Some(when) = branch_when {
            object.insert("branch_when".to_string(), Value::String(when.to_string()));
        }
    }
    resolved_steps.push(HysteresisResolvedSettleStepSchema {
        step_index,
        step_id: format!("settle_step_{step_index:03}_{kind}"),
        kind,
        method,
        applies_to: step.get("applies_to").cloned(),
        on_non_convergence: value_string(step.get("on_non_convergence")),
        resolved_parameters,
    });
}

fn build_hysteresis_resolved_branch_ids(stage: &HysteresisSceneStage) -> Vec<String> {
    let values = materialize_hysteresis_stage_field_values(&stage.value);
    infer_hysteresis_execution_branch_segments(&values)
        .into_iter()
        .map(|segment| hysteresis_execution_branch_id(segment.direction, segment.branch_index))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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
    let points = read_hysteresis_points_if_available(&state, &stage.stage_id).await?;
    let minor_loops = read_hysteresis_minor_loops_if_available(&state, &stage.stage_id).await?;
    let settle_trace = read_hysteresis_settle_trace_if_available(&state, &stage.stage_id).await?;
    let bookmark_resource = if query.include_bookmarks.unwrap_or(true) {
        Some(hysteresis_bookmarks_resource(&state, &stage).await)
    } else {
        None
    };
    let bookmark_revision = bookmark_resource
        .as_ref()
        .map_or(stage.revision, |resource| resource.revision);
    let bookmarks = bookmark_resource
        .map(|resource| resource.bookmarks)
        .unwrap_or_default();
    Ok(Json(build_hysteresis_execution_tree(
        stage,
        progress,
        query,
        points,
        minor_loops,
        settle_trace,
        bookmarks,
        bookmark_revision,
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
        .and_then(|live| {
            average_hysteresis_live_magnetization(&live.latest_step, snapshot.fem_mesh.as_ref())
        })
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

fn average_hysteresis_live_magnetization(
    step: &crate::types::StepUpdateView,
    snapshot_mesh: Option<&fullmag_runner::FemMeshPayload>,
) -> Option<[f64; 3]> {
    let values = step.magnetization.as_ref()?;
    if values.len() < 3 || values.len() % 3 != 0 {
        return None;
    }
    if let Some(mesh) = snapshot_mesh {
        if let Some(weighted) = average_fem_magnetization_by_element_volume(values, mesh) {
            return Some(weighted);
        }
        let mut node_indices = BTreeSet::new();
        for part in &mesh.mesh_parts {
            if part.role != "magnetic_object" {
                continue;
            }
            if !part.node_indices.is_empty() {
                node_indices.extend(part.node_indices.iter().copied());
            } else {
                let start = part.node_start;
                let end = part.node_start.saturating_add(part.node_count);
                node_indices.extend(start..end);
            }
        }
        if !node_indices.is_empty() {
            return average_indexed_magnetization(values, node_indices);
        }
        if !mesh.object_segments.is_empty() {
            let mut segment_indices = BTreeSet::new();
            for segment in &mesh.object_segments {
                let start = segment.node_start;
                let end = segment.node_start.saturating_add(segment.node_count);
                segment_indices.extend(start..end);
            }
            if !segment_indices.is_empty() {
                return average_indexed_magnetization(values, segment_indices);
            }
        }
    }
    average_flat_magnetization(values, 0, values.len() / 3)
}

fn project_hysteresis_m_parallel(m_avg: [f64; 3], stage: &serde_json::Map<String, Value>) -> f64 {
    let axis = hysteresis_measurement_axis(stage);
    m_avg[0] * axis[0] + m_avg[1] * axis[1] + m_avg[2] * axis[2]
}

fn average_fem_magnetization_by_element_volume(
    values: &[f64],
    mesh: &fullmag_runner::FemMeshPayload,
) -> Option<[f64; 3]> {
    let tet_elements = mesh.require_tet4_elements().ok()?;
    let point_count = values.len() / 3;
    let mut total = [0.0; 3];
    let mut total_weight = 0.0;

    for part in &mesh.mesh_parts {
        if part.role != "magnetic_object" {
            continue;
        }
        let start = part.element_start as usize;
        let end = start.saturating_add(part.element_count as usize);
        let Some(elements) = tet_elements.get(start..end) else {
            continue;
        };
        for element in elements {
            let volume = tetrahedron_volume(mesh, *element)?;
            if !volume.is_finite() || volume <= 0.0 {
                continue;
            }
            let node_weight = volume / 4.0;
            for node_index in element {
                let index = *node_index as usize;
                if index >= point_count {
                    continue;
                }
                let offset = index * 3;
                total[0] += values[offset] * node_weight;
                total[1] += values[offset + 1] * node_weight;
                total[2] += values[offset + 2] * node_weight;
                total_weight += node_weight;
            }
        }
    }

    if total_weight > 0.0 {
        Some([
            total[0] / total_weight,
            total[1] / total_weight,
            total[2] / total_weight,
        ])
    } else {
        None
    }
}

fn tetrahedron_volume(mesh: &fullmag_runner::FemMeshPayload, element: [u32; 4]) -> Option<f64> {
    let a = *mesh.nodes.get(element[0] as usize)?;
    let b = *mesh.nodes.get(element[1] as usize)?;
    let c = *mesh.nodes.get(element[2] as usize)?;
    let d = *mesh.nodes.get(element[3] as usize)?;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let cross = [
        ac[1] * ad[2] - ac[2] * ad[1],
        ac[2] * ad[0] - ac[0] * ad[2],
        ac[0] * ad[1] - ac[1] * ad[0],
    ];
    let triple = ab[0] * cross[0] + ab[1] * cross[1] + ab[2] * cross[2];
    Some(triple.abs() / 6.0)
}

fn hysteresis_measurement_axis(stage: &serde_json::Map<String, Value>) -> [f64; 3] {
    let field_axis = hysteresis_field_axis(stage);
    let Some(axis) = stage.get("measurement_axis") else {
        return field_axis;
    };

    hysteresis_measurement_axis_from_value(axis, field_axis).unwrap_or(field_axis)
}

fn hysteresis_measurement_axis_from_value(axis: &Value, field_axis: [f64; 3]) -> Option<[f64; 3]> {
    if let Some(named) = axis.as_str() {
        return Some(match named {
            "field_axis" => field_axis,
            "sample_normal" => [0.0, 0.0, 1.0],
            "easy_axis" => [0.0, 0.0, 1.0],
            _ => field_axis,
        });
    }

    let object = axis.as_object()?;
    if let Some(vector) = value_vec3(object.get("vector")) {
        return Some(normalized_axis_or_default(vector));
    }
    let kind = object.get("kind").and_then(Value::as_str)?;
    Some(match kind {
        "field_axis" => field_axis,
        "sample_normal" => [0.0, 0.0, 1.0],
        "easy_axis" => [0.0, 0.0, 1.0],
        _ => field_axis,
    })
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
    let latest_scalar_row = snapshot.scalar_rows.last();
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

    let stage_completion = current_stage_completion(snapshot);
    let max_torque_apm = latest.and_then(|value| canonical_torque_apm(value.max_torque_Apm));
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
        relaxation_algorithm: metadata_string(
            snapshot.metadata.as_ref(),
            &["relaxation_algorithm"],
        )
        .or_else(|| {
            metadata_string(
                snapshot.metadata.as_ref(),
                &["execution_plan", "backend_plan", "relax_algorithm"],
            )
        })
        .as_deref()
        .and_then(RelaxationAlgorithm::parse),
        integrator: metadata_string(
            snapshot.metadata.as_ref(),
            &["execution_plan", "backend_plan", "integrator"],
        ),
        dt_seconds: latest.map(|value| value.dt),
        error_estimate: latest_scalar_row.and_then(|value| value.error_estimate),
        max_error: latest_scalar_row.and_then(|value| value.max_error),
        dt_suggested_seconds: latest_scalar_row.and_then(|value| value.dt_suggested),
        rejected_attempts: latest_scalar_row.map(|value| value.rejected_attempts),
        sim_time_seconds: latest.map(|value| value.time),
        pseudo_time_seconds: latest_scalar_row
            .and_then(|value| value.pseudo_time_s)
            .or_else(|| latest.and_then(|value| value.pseudo_time_s)),
        active_runtime_seconds: latest_scalar_row
            .and_then(|value| value.active_runtime_s)
            .or_else(|| latest.map(|value| value.wall_time_ns as f64 * 1.0e-9)),
        step_index: latest.map(|value| value.step),
        last_step_updated_at_unix_ms: snapshot
            .live_state
            .as_ref()
            .map(|value| value.updated_at_unix_ms.min(u64::MAX as u128) as u64),
        max_torque_t: max_torque_apm.and_then(torque_t_from_apm),
        max_torque_apm,
        max_rhs_norm_per_s: latest.map(|value| value.max_dm_dt),
        max_torque: max_torque_apm,
        converged: stage_completion.map(|value| value.converged),
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
    let latest_energy_row = latest_energy_row(snapshot);
    let scoped_magnetization = if let Some(values) = object_scalars {
        Some([
            number_from_metric(values, "mx").unwrap_or(initial_m[0]),
            number_from_metric(values, "my").unwrap_or(initial_m[1]),
            number_from_metric(values, "mz").unwrap_or(initial_m[2]),
        ])
    } else {
        latest_magnetization_average(snapshot, &canonical_object_id, initial_m)
    };
    let has_solver_sample = object_scalars.is_some() || latest_energy_row.is_some();
    let source = if object_scalars.is_some() {
        "solver_per_object"
    } else if scoped_magnetization.is_some() {
        "solver_spatial_object"
    } else if latest_energy_row.is_some() {
        "solver_energy_only"
    } else {
        "initial_state"
    };
    let step = object_scalars
        .and_then(|values| number_from_metric(values, "step").map(|value| value as u64))
        .or_else(|| latest_energy_row.as_ref().map(|row| row.step))
        .unwrap_or(0);
    let time_seconds = object_scalars
        .and_then(|values| number_from_metric(values, "time"))
        .or_else(|| latest_energy_row.as_ref().map(|row| row.time))
        .unwrap_or(0.0);

    let magnetization_average = if has_solver_sample {
        scoped_magnetization
    } else {
        Some(initial_m)
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
            latest_energy_row.as_ref().map(|row| ObjectEnergySummary {
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
        magnetization_average: magnetization_average.map(|values| ObjectMagnetizationAverage {
            mx: values[0],
            my: values[1],
            mz: values[2],
        }),
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
        max_relaxation_time_s: record.command.until_seconds,
        max_steps: record.command.max_steps,
        torque_tolerance_apm: record.command.torque_tolerance,
        torque_tolerance: record.command.torque_tolerance,
        energy_tolerance: record.command.energy_tolerance,
        energy_tolerance_j: record.command.energy_tolerance,
        integrator: record.command.integrator.clone(),
        fixed_timestep: record.command.fixed_timestep,
        max_error: record.command.max_error,
        solver_policy: record.command.solver_policy.clone(),
        relax_algorithm: record
            .command
            .relax_algorithm
            .as_deref()
            .and_then(RelaxationAlgorithm::parse),
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
            error_estimate: None,
            max_error: None,
            dt_suggested: None,
            rejected_attempts: 0,
            pseudo_time_s: live_state.latest_step.pseudo_time_s,
            active_runtime_s: Some(live_state.latest_step.wall_time_ns as f64 * 1.0e-9),
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
            per_object_scalars: live_state.latest_step.per_object_scalars.clone(),
            table_expressions: Vec::new(),
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
    if let Some(mesh) = snapshot.fem_mesh.as_ref() {
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
    let single_object_scene = snapshot
        .scene_document
        .as_ref()
        .is_some_and(|scene| scene.objects.len() == 1);
    if single_object_scene {
        average_flat_magnetization(values, 0, values.len() / 3).or(Some(fallback))
    } else {
        None
    }
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

fn current_stage_completion(snapshot: &SessionStateResponse) -> Option<&StageExecutionRecord> {
    let execution = snapshot.stage_execution.as_ref()?;
    execution
        .active_stage_index
        .and_then(|index| execution.stages.get(index))
        .or_else(|| {
            execution.stages.iter().rev().find(|record| {
                matches!(
                    record.status,
                    crate::types::StageLifecycleState::Skipped
                        | crate::types::StageLifecycleState::Completed
                        | crate::types::StageLifecycleState::Cancelled
                        | crate::types::StageLifecycleState::Stopped
                        | crate::types::StageLifecycleState::Failed
                )
            })
        })
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
    points: Vec<HysteresisPointSchema>,
    minor_loops: Vec<HysteresisMinorLoopSchema>,
    settle_trace: Vec<HysteresisSettleTraceEntrySchema>,
    bookmarks: Vec<HysteresisBookmarkSchema>,
    bookmark_revision: u64,
) -> HysteresisExecutionTreeResource {
    let before = query.before.unwrap_or(2).min(50);
    let after = query.after.unwrap_or(3).min(50);
    let window = query.window.clone().unwrap_or_else(|| "active".to_string());
    let values = materialize_hysteresis_stage_field_values(&stage.value);
    let total_points = values.len() as u32;
    let active_point_index = if progress.status == "completed" {
        None
    } else {
        infer_hysteresis_active_point_index(&progress, &values)
    };
    let points_by_id: HashMap<u32, HysteresisPointSchema> = points
        .into_iter()
        .filter_map(|point| {
            u32::try_from(point.point_id)
                .ok()
                .map(|point_id| (point_id, point))
        })
        .collect();
    let settle_trace_by_step: HashMap<(u32, usize), HysteresisSettleTraceEntrySchema> =
        settle_trace
            .into_iter()
            .filter_map(|entry| {
                entry
                    .point_id
                    .and_then(|point_id| u32::try_from(point_id).ok())
                    .map(|point_id| ((point_id, entry.step_index), entry))
            })
            .collect();

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
                &points_by_id,
                &settle_trace_by_step,
                &query,
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
    nodes.extend(hysteresis_branch_nodes(
        &stage,
        &progress,
        &points_by_id,
        &settle_trace_by_step,
        &query,
        &values,
        start,
        end,
        active_point_index,
        progress.status == "completed",
        stage.revision.max(progress.revision),
    ));
    nodes.extend(hysteresis_minor_loop_branch_nodes(
        &stage,
        &progress,
        &points_by_id,
        &settle_trace_by_step,
        &query,
        &minor_loops,
        start,
        end,
        active_point_index,
        progress.status == "completed",
        stage.revision.max(progress.revision),
    ));
    let revision = stage.revision.max(progress.revision).max(bookmark_revision);
    nodes.extend(hysteresis_bookmark_nodes(&stage, bookmarks, revision));

    HysteresisExecutionTreeResource {
        revision,
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

fn hysteresis_bookmark_nodes(
    stage: &HysteresisSceneStage,
    bookmarks: Vec<HysteresisBookmarkSchema>,
    revision: u64,
) -> Vec<HysteresisExecutionTreeNode> {
    bookmarks
        .into_iter()
        .map(|bookmark| HysteresisExecutionTreeNode {
            node_id: format!("{}:bookmark:{}", stage.stage_id, bookmark.point_id),
            kind: "bookmark".to_string(),
            stage_id: stage.stage_id.clone(),
            point_id: Some(bookmark.point_id),
            settle_step_id: None,
            status: "ready".to_string(),
            label: bookmark.label,
            resource_ref: Some(bookmark.resource_ref),
            selection_ref: Some(bookmark.selection_ref),
            mesh_identity: None,
            field_orientation: bookmark.field_orientation,
            measurement_axis: bookmark.measurement_axis,
            field_revision: None,
            updated_revision: revision,
            children: Vec::new(),
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct HysteresisBranchTreeSegment {
    branch_index: u32,
    direction: i32,
    start_point_id: u32,
    end_point_id: u32,
}

fn hysteresis_branch_nodes(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    points_by_id: &HashMap<u32, HysteresisPointSchema>,
    settle_trace_by_step: &HashMap<(u32, usize), HysteresisSettleTraceEntrySchema>,
    query: &HysteresisExecutionTreeQuery,
    values: &[f64],
    window_start: u32,
    window_end: u32,
    active_point_index: Option<u32>,
    stage_completed: bool,
    revision: u64,
) -> Vec<HysteresisExecutionTreeNode> {
    let segments = infer_hysteresis_execution_branch_segments(values);
    if segments.len() < 2 {
        return Vec::new();
    }
    segments
        .into_iter()
        .map(|segment| {
            hysteresis_branch_node(
                stage,
                progress,
                points_by_id,
                settle_trace_by_step,
                query,
                values,
                segment,
                window_start,
                window_end,
                active_point_index,
                stage_completed,
                revision,
            )
        })
        .collect()
}

fn hysteresis_branch_node(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    points_by_id: &HashMap<u32, HysteresisPointSchema>,
    settle_trace_by_step: &HashMap<(u32, usize), HysteresisSettleTraceEntrySchema>,
    query: &HysteresisExecutionTreeQuery,
    values: &[f64],
    segment: HysteresisBranchTreeSegment,
    window_start: u32,
    window_end: u32,
    active_point_index: Option<u32>,
    stage_completed: bool,
    revision: u64,
) -> HysteresisExecutionTreeNode {
    let branch_id = hysteresis_execution_branch_id(segment.direction, segment.branch_index);
    let label = if segment.direction < 0 {
        "Descending branch"
    } else {
        "Ascending branch"
    };
    let status = match active_point_index {
        Some(active) if active < segment.start_point_id => "queued",
        Some(active) if active <= segment.end_point_id => "active",
        Some(_) => "done",
        None if stage_completed => "done",
        _ => "queued",
    };
    let mut children = vec![HysteresisExecutionTreeNode {
        node_id: format!("{}:branch:{branch_id}:points", stage.stage_id),
        kind: "summary".to_string(),
        stage_id: stage.stage_id.clone(),
        point_id: None,
        settle_step_id: None,
        status: status.to_string(),
        label: format!("Points {}-{}", segment.start_point_id, segment.end_point_id),
        resource_ref: Some(format!(
            "/v2/sessions/current/analysis/hysteresis/{}/branches",
            stage.stage_id
        )),
        selection_ref: Some(format!(
            "hysteresis-branch-points:{}:{branch_id}",
            stage.stage_id
        )),
        mesh_identity: None,
        field_orientation: None,
        measurement_axis: None,
        field_revision: None,
        updated_revision: revision,
        children: Vec::new(),
    }];
    let child_start = segment.start_point_id.max(window_start);
    let child_end = segment.end_point_id.min(window_end);
    if child_start <= child_end {
        for point_id in child_start..=child_end {
            if let Some(field_value_m_t) = values.get(point_id as usize).copied() {
                children.push(hysteresis_field_point_node(
                    stage,
                    progress,
                    points_by_id,
                    settle_trace_by_step,
                    query,
                    point_id,
                    field_value_m_t,
                    active_point_index,
                ));
            }
        }
    }
    HysteresisExecutionTreeNode {
        node_id: format!("{}:branch:{branch_id}", stage.stage_id),
        kind: "branch".to_string(),
        stage_id: stage.stage_id.clone(),
        point_id: None,
        settle_step_id: None,
        status: status.to_string(),
        label: label.to_string(),
        resource_ref: Some(format!(
            "/v2/sessions/current/analysis/hysteresis/{}/branches",
            stage.stage_id
        )),
        selection_ref: Some(format!("hysteresis-branch:{}:{branch_id}", stage.stage_id)),
        mesh_identity: None,
        field_orientation: None,
        measurement_axis: None,
        field_revision: None,
        updated_revision: revision,
        children,
    }
}

fn hysteresis_minor_loop_branch_nodes(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    points_by_id: &HashMap<u32, HysteresisPointSchema>,
    settle_trace_by_step: &HashMap<(u32, usize), HysteresisSettleTraceEntrySchema>,
    query: &HysteresisExecutionTreeQuery,
    minor_loops: &[HysteresisMinorLoopSchema],
    window_start: u32,
    window_end: u32,
    active_point_index: Option<u32>,
    stage_completed: bool,
    revision: u64,
) -> Vec<HysteresisExecutionTreeNode> {
    minor_loops
        .iter()
        .filter_map(|minor_loop| {
            hysteresis_minor_loop_branch_node(
                stage,
                progress,
                points_by_id,
                settle_trace_by_step,
                query,
                minor_loop,
                window_start,
                window_end,
                active_point_index,
                stage_completed,
                revision,
            )
        })
        .collect()
}

fn hysteresis_minor_loop_branch_node(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    points_by_id: &HashMap<u32, HysteresisPointSchema>,
    settle_trace_by_step: &HashMap<(u32, usize), HysteresisSettleTraceEntrySchema>,
    query: &HysteresisExecutionTreeQuery,
    minor_loop: &HysteresisMinorLoopSchema,
    window_start: u32,
    window_end: u32,
    active_point_index: Option<u32>,
    stage_completed: bool,
    revision: u64,
) -> Option<HysteresisExecutionTreeNode> {
    let start_point_id = minor_loop
        .reversal_point_id
        .or_else(|| minor_loop.points.first().map(|point| point.point_id))
        .and_then(|point_id| u32::try_from(point_id).ok())?;
    let end_point_id = minor_loop
        .return_point_id
        .or_else(|| minor_loop.points.last().map(|point| point.point_id))
        .and_then(|point_id| u32::try_from(point_id).ok())?;
    let branch_id = hysteresis_minor_loop_branch_id(&minor_loop.loop_id);
    let status = match active_point_index {
        Some(active) if active < start_point_id => "queued",
        Some(active) if active <= end_point_id => "active",
        Some(_) => "done",
        None if stage_completed => "done",
        _ => "queued",
    };
    let mut children = vec![HysteresisExecutionTreeNode {
        node_id: format!("{}:branch:{branch_id}:points", stage.stage_id),
        kind: "summary".to_string(),
        stage_id: stage.stage_id.clone(),
        point_id: None,
        settle_step_id: None,
        status: status.to_string(),
        label: format!("Points {start_point_id}-{end_point_id}"),
        resource_ref: Some(format!(
            "/v2/sessions/current/analysis/hysteresis/{}/minor-loops",
            stage.stage_id
        )),
        selection_ref: Some(format!(
            "hysteresis-minor-loop-points:{}:{}",
            stage.stage_id, minor_loop.loop_id
        )),
        mesh_identity: None,
        field_orientation: None,
        measurement_axis: None,
        field_revision: None,
        updated_revision: revision,
        children: Vec::new(),
    }];
    let child_start = start_point_id.max(window_start);
    let child_end = end_point_id.min(window_end);
    if child_start <= child_end {
        for point_id in child_start..=child_end {
            let field_value_m_t = minor_loop
                .points
                .iter()
                .find(|point| u32::try_from(point.point_id).ok() == Some(point_id))
                .map(|point| point.field_value_m_t)
                .or_else(|| {
                    points_by_id
                        .get(&point_id)
                        .map(|point| point.field_value_m_t)
                });
            if let Some(field_value_m_t) = field_value_m_t {
                children.push(hysteresis_field_point_node(
                    stage,
                    progress,
                    points_by_id,
                    settle_trace_by_step,
                    query,
                    point_id,
                    field_value_m_t,
                    active_point_index,
                ));
            }
        }
    }
    Some(HysteresisExecutionTreeNode {
        node_id: format!("{}:branch:{branch_id}", stage.stage_id),
        kind: "branch".to_string(),
        stage_id: stage.stage_id.clone(),
        point_id: None,
        settle_step_id: None,
        status: status.to_string(),
        label: format!("Minor loop {}", minor_loop.loop_id),
        resource_ref: Some(format!(
            "/v2/sessions/current/analysis/hysteresis/{}/minor-loops",
            stage.stage_id
        )),
        selection_ref: Some(format!(
            "hysteresis-minor-loop:{}:{}",
            stage.stage_id, minor_loop.loop_id
        )),
        mesh_identity: None,
        field_orientation: None,
        measurement_axis: None,
        field_revision: None,
        updated_revision: revision,
        children,
    })
}

fn infer_hysteresis_execution_branch_segments(values: &[f64]) -> Vec<HysteresisBranchTreeSegment> {
    if values.len() < 2 {
        return Vec::new();
    }

    let mut segments = Vec::new();
    let mut start_point_id = 0u32;
    let mut current_direction = 0i32;

    for idx in 1..values.len() {
        let step_direction = hysteresis_step_direction(values[idx - 1], values[idx]);
        if step_direction == 0 {
            continue;
        }
        if current_direction == 0 {
            current_direction = step_direction;
            continue;
        }
        if step_direction != current_direction {
            let end_point_id = (idx - 1) as u32;
            if end_point_id > start_point_id {
                segments.push(HysteresisBranchTreeSegment {
                    branch_index: segments.len() as u32,
                    direction: current_direction,
                    start_point_id,
                    end_point_id,
                });
            }
            start_point_id = end_point_id;
            current_direction = step_direction;
        }
    }

    if current_direction != 0 {
        let end_point_id = values.len().saturating_sub(1) as u32;
        if end_point_id > start_point_id {
            segments.push(HysteresisBranchTreeSegment {
                branch_index: segments.len() as u32,
                direction: current_direction,
                start_point_id,
                end_point_id,
            });
        }
    }
    segments
}

fn hysteresis_step_direction(previous: f64, next: f64) -> i32 {
    let delta = next - previous;
    if delta > 1e-12 {
        1
    } else if delta < -1e-12 {
        -1
    } else {
        0
    }
}

fn hysteresis_execution_branch_id(direction: i32, branch_index: u32) -> String {
    let base = if direction < 0 {
        "descending"
    } else {
        "ascending"
    };
    if branch_index < 2 {
        base.to_string()
    } else {
        format!("{base}-{branch_index}")
    }
}

fn hysteresis_minor_loop_branch_id(loop_id: &str) -> String {
    sanitize_hysteresis_execution_id_segment(loop_id)
}

fn sanitize_hysteresis_execution_id_segment(value: &str) -> String {
    let mut segment = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            segment.push(character.to_ascii_lowercase());
        } else if !segment.ends_with('-') {
            segment.push('-');
        }
    }
    segment.trim_matches('-').to_string()
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
        mesh_identity: None,
        field_orientation: None,
        measurement_axis: None,
        field_revision: None,
        updated_revision: revision,
        children: Vec::new(),
    }
}

fn hysteresis_field_point_node(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    points_by_id: &HashMap<u32, HysteresisPointSchema>,
    settle_trace_by_step: &HashMap<(u32, usize), HysteresisSettleTraceEntrySchema>,
    query: &HysteresisExecutionTreeQuery,
    point_id: u32,
    field_value_m_t: f64,
    active_point_index: Option<u32>,
) -> HysteresisExecutionTreeNode {
    let status = match active_point_index {
        _ if progress.status == "completed" => "done",
        Some(active) if point_id < active => "done",
        Some(active) if point_id == active => "active",
        Some(_) => "queued",
        _ => "queued",
    };
    let has_settle_trace = settle_trace_by_step
        .keys()
        .any(|(trace_point_id, _step_index)| *trace_point_id == point_id);
    let mut children = if status == "active" || has_settle_trace {
        hysteresis_settle_algorithm_nodes(stage, progress, settle_trace_by_step, point_id)
    } else {
        Vec::new()
    };
    if let Some(point) = points_by_id.get(&point_id) {
        children.extend(hysteresis_point_observation_nodes(
            stage,
            point,
            point_id,
            query,
            stage.revision.max(progress.revision),
        ));
    }
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
        mesh_identity: None,
        field_orientation: None,
        measurement_axis: None,
        field_revision: None,
        updated_revision: stage.revision.max(progress.revision),
        children,
    }
}

fn hysteresis_point_observation_nodes(
    stage: &HysteresisSceneStage,
    point: &HysteresisPointSchema,
    point_id: u32,
    query: &HysteresisExecutionTreeQuery,
    revision: u64,
) -> Vec<HysteresisExecutionTreeNode> {
    let mut nodes = Vec::new();
    if query.include_snapshots.unwrap_or(true) {
        if let Some(snapshot_id) = point.snapshot_id.as_deref() {
            let resource_ref = point
                .snapshot_vector_resource_ref
                .clone()
                .or_else(|| point.snapshot_resource_ref.clone())
                .unwrap_or_else(|| {
                    format!(
                        "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id={snapshot_id}&stage_id={}",
                        stage.stage_id
                    )
                });
            let snapshot_status = hysteresis_snapshot_tree_status(point);
            let snapshot_label = if snapshot_status == "missing" {
                format!("Snapshot {snapshot_id} missing")
            } else {
                format!("Snapshot {snapshot_id}")
            };
            nodes.push(HysteresisExecutionTreeNode {
                node_id: format!("{}:point:{point_id}:snapshot:{snapshot_id}", stage.stage_id),
                kind: "snapshot".to_string(),
                stage_id: stage.stage_id.clone(),
                point_id: Some(point_id),
                settle_step_id: None,
                status: snapshot_status.to_string(),
                label: snapshot_label,
                resource_ref: Some(resource_ref),
                selection_ref: Some(format!(
                    "hysteresis-snapshot:{}:{point_id}:{snapshot_id}",
                    stage.stage_id
                )),
                mesh_identity: None,
                field_orientation: point.field_orientation.clone(),
                measurement_axis: point.measurement_axis.clone(),
                field_revision: None,
                updated_revision: revision,
                children: Vec::new(),
            });
        }
    }
    if query.include_warnings.unwrap_or(true) {
        if let Some(warning_count) = point.warning_count.filter(|count| *count > 0) {
            nodes.push(HysteresisExecutionTreeNode {
                node_id: format!("{}:point:{point_id}:warnings", stage.stage_id),
                kind: "warning".to_string(),
                stage_id: stage.stage_id.clone(),
                point_id: Some(point_id),
                settle_step_id: None,
                status: "warning".to_string(),
                label: format!("{warning_count} warning(s)"),
                resource_ref: Some(format!(
                    "/v2/sessions/current/analysis/hysteresis/{}/steps/{point_id}",
                    stage.stage_id
                )),
                selection_ref: Some(format!("hysteresis-warning:{}:{point_id}", stage.stage_id)),
                mesh_identity: None,
                field_orientation: None,
                measurement_axis: None,
                field_revision: None,
                updated_revision: revision,
                children: Vec::new(),
            });
        }
    }
    nodes
}

fn hysteresis_snapshot_tree_status(point: &HysteresisPointSchema) -> &'static str {
    match point.snapshot_storage_status.as_deref() {
        Some("missing") => "missing",
        Some("unknown") => "warning",
        _ => "done",
    }
}

fn hysteresis_settle_algorithm_nodes(
    stage: &HysteresisSceneStage,
    progress: &HysteresisProgressSchema,
    settle_trace_by_step: &HashMap<(u32, usize), HysteresisSettleTraceEntrySchema>,
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
            let trace_status = settle_trace_by_step
                .get(&(point_id, idx))
                .map(|entry| hysteresis_settle_trace_tree_status(&entry.status));
            let status = trace_status.unwrap_or_else(|| match active_step {
                Some(active) if idx_u32 < active => "done",
                Some(active) if idx_u32 == active => "active",
                Some(_) => "queued",
                None => "queued",
            });
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
                mesh_identity: None,
                field_orientation: None,
                measurement_axis: None,
                field_revision: None,
                updated_revision: stage.revision.max(progress.revision),
                children: Vec::new(),
            }
        })
        .collect()
}

fn hysteresis_settle_trace_tree_status(status: &str) -> &'static str {
    match status {
        "converged" | "completed" | "completed_duration" | "done" => "done",
        "skipped" => "skipped",
        "non_converged" | "warning" => "warning",
        "failed" | "error" => "failed",
        "running" | "active" => "active",
        _ => "queued",
    }
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

fn field_unit_provenance_schema(
    value: Option<&Value>,
) -> Option<HysteresisFieldUnitProvenanceSchema> {
    value
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
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
        stage_id: Some(
            record
                .stage_id
                .clone()
                .unwrap_or_else(|| stage_id_for_index(index)),
        ),
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

    if let Some(stage_id) = hysteresis_invalidation_stage_id(snapshot, stage_linkage) {
        push_hysteresis_command_invalidations(&mut resources, &stage_id, snapshot, state);
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

fn hysteresis_invalidation_stage_id(
    snapshot: &SessionStateResponse,
    stage_linkage: Option<&CommandStageLinkage>,
) -> Option<String> {
    let stage_execution = snapshot.stage_execution.as_ref()?;
    let linkage = stage_linkage?;
    let stage_index = linkage.stage_index? as usize;
    let stage_record = stage_execution.stages.get(stage_index)?;
    if is_hysteresis_stage_kind(stage_record.kind.as_deref())
        || is_hysteresis_stage_kind(stage_execution.active_stage_kind.as_deref())
    {
        return linkage.stage_id.clone();
    }
    None
}

fn push_hysteresis_command_invalidations(
    resources: &mut Vec<CommandResourceInvalidationResource>,
    stage_id: &str,
    snapshot: &SessionStateResponse,
    state: &str,
) {
    let stage_revision = snapshot.state_version;
    let scalar_revision = snapshot.scalar_revision.max(snapshot.state_version);
    for resource_key in [
        format!("simulation/stages/{stage_id}/hysteresis/progress"),
        format!("simulation/stages/{stage_id}/hysteresis/execution-tree"),
        format!("simulation/stages/{stage_id}/hysteresis/saturation"),
    ] {
        push_command_invalidation(
            resources,
            &resource_key,
            stage_revision,
            "hysteresis stage runtime",
            state,
        );
    }
    for resource_key in [
        format!("analysis/hysteresis/{stage_id}/metrics"),
        format!("analysis/hysteresis/{stage_id}/points"),
        format!("analysis/hysteresis/{stage_id}/branches"),
        format!("analysis/hysteresis/{stage_id}/minor-loops"),
        format!("analysis/hysteresis/{stage_id}/reversal-fields"),
        format!("analysis/hysteresis/{stage_id}/adaptive-refinement"),
        format!("analysis/hysteresis/{stage_id}/saturation"),
        format!("analysis/hysteresis-family/{stage_id}"),
    ] {
        push_command_invalidation(
            resources,
            &resource_key,
            scalar_revision,
            "hysteresis analysis readback",
            state,
        );
    }
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
