use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use fullmag_authoring::{MagnetizationAsset, SceneDocument, SceneObject};
use fullmag_runner::RuntimeStatus;
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::runtime::{
    CommandDetailResource, CommandDiagnosticReferenceResource, CommandExecutionReadbackResource,
    CommandQueueStatusResource, CommandResourceInvalidationResource, CommandStatusResource,
    CurrentRunResource, ObjectEnergySummary, ObjectMagnetizationAverage, ObjectMetricsResource,
    RuntimeCommandReadinessResource, SolverEnergyCurrentResource, SolverEnergyHistoryResource,
    SolverEnergyRow, SolverStatusResource, StageExecutionRecordResource, StageExecutionResource,
};
use crate::session::{build_runtime_status_view, effective_runtime_status_code};
use crate::types::{
    AppState, CommandCompletionState, CommandLifecycleState, ScalarRow, SessionStateResponse,
    StageExecutionRecord, StageExecutionState, TrackedCommandRecord,
};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct EnergyHistoryQuery {
    /// Optional max number of most recent rows to return.
    pub limit: Option<usize>,
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
        (status = 404, description = "No stage execution data"),
    ),
    tag = "simulation"
)]
pub async fn get_stage_execution(
    State(state): State<Arc<AppState>>,
) -> Result<Json<StageExecutionResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let stage = snapshot
        .stage_execution
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no stage execution data"))?;

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
                metric_name: record.metric_name.clone(),
                metric_value: record.metric_value,
                threshold: record.threshold,
            })
            .collect(),
    }))
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
        warnings: snapshot
            .engine_log
            .iter()
            .filter(|entry| entry.level.eq_ignore_ascii_case("warn"))
            .map(|entry| entry.message.clone())
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
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
    let revision = ledger.back().map(|record| record.command.seq).unwrap_or(0);
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
    per_object
        .get(object_id)
        .or_else(|| per_object.get(object_name))
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
    if let Some(segment) = live_state.latest_step.fem_mesh.as_ref().and_then(|mesh| {
        mesh.object_segments
            .iter()
            .find(|segment| segment.object_id == object_id)
    }) {
        return average_flat_magnetization(
            values,
            segment.node_start as usize,
            segment.node_count as usize,
        )
        .or(Some(fallback));
    }
    average_flat_magnetization(values, 0, values.len() / 3).or(Some(fallback))
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
