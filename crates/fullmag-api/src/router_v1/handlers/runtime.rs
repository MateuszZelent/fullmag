use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::runtime::{
    CommandDetailResource, CommandQueueStatusResource, CommandStatusResource, CurrentRunResource,
    SolverEnergyCurrentResource, SolverEnergyHistoryResource, SolverEnergyRow,
    SolverStatusResource, StageExecutionRecordResource, StageExecutionResource,
};
use crate::types::{
    AppState, CommandLifecycleState, ScalarRow, SessionStateResponse, TrackedCommandRecord,
};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct EnergyHistoryQuery {
    /// Optional max number of most recent rows to return.
    pub limit: Option<usize>,
}

#[utoipa::path(
    get,
    path = "/v1/live/current/runs/current",
    responses(
        (status = 200, description = "Current run resource", body = CurrentRunResource),
        (status = 404, description = "No active run"),
    ),
    tag = "runtime"
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
    path = "/v1/live/current/stages/execution",
    responses(
        (status = 200, description = "Current stage execution read-model", body = StageExecutionResource),
        (status = 404, description = "No stage execution data"),
    ),
    tag = "runtime"
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
        runtime_state: stage.runtime_state.clone(),
        total_stages: stage.total_stages as u32,
        completed_stage_indexes: stage
            .completed_stage_indexes
            .iter()
            .map(|value| *value as u32)
            .collect(),
        stage_statuses: stage.stage_statuses.clone(),
        active_stage_index: stage.active_stage_index.map(|value| value as u32),
        active_stage_kind: stage.active_stage_kind.clone(),
        stages: stage
            .stages
            .iter()
            .map(|record| StageExecutionRecordResource {
                status: record.status.clone(),
                reason: record.reason.as_ref().map(stage_stop_reason_string),
                metric_name: record.metric_name.clone(),
                metric_value: record.metric_value,
                threshold: record.threshold,
            })
            .collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/solver/status",
    responses(
        (status = 200, description = "Detailed solver status read-model", body = SolverStatusResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "runtime"
)]
pub async fn get_solver_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SolverStatusResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let latest = snapshot.live_state.as_ref().map(|value| &value.latest_step);

    Ok(Json(SolverStatusResource {
        revision: snapshot.state_version,
        runtime_state: snapshot
            .live_state
            .as_ref()
            .map(|value| value.status.clone())
            .unwrap_or_else(|| snapshot.runtime_status.code.clone()),
        runtime_status_kind: runtime_status_kind(snapshot),
        runtime_status_code: snapshot.runtime_status.code.clone(),
        session_status: snapshot.session.status.clone(),
        is_busy: snapshot.runtime_status.is_busy,
        can_accept_commands: snapshot.runtime_status.can_accept_commands,
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
    path = "/v1/live/current/solver/energies/current",
    responses(
        (status = 200, description = "Current solver energy sample", body = SolverEnergyCurrentResource),
        (status = 404, description = "No solver energy data"),
    ),
    tag = "runtime"
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
        revision: snapshot.scalar_rows.len() as u64,
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
    path = "/v1/live/current/solver/energies/history",
    params(EnergyHistoryQuery),
    responses(
        (status = 200, description = "Solver energy history", body = SolverEnergyHistoryResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "runtime"
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
        revision: total_rows as u64,
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
    path = "/v1/live/current/commands/status",
    responses(
        (status = 200, description = "Current command queue and dispatch ledger", body = CommandQueueStatusResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "commands"
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
    let dispatched_count = ledger
        .iter()
        .filter(|record| record.status == CommandLifecycleState::Dispatched)
        .count() as u64;
    let revision = ledger.back().map(|record| record.command.seq).unwrap_or(0);
    let can_accept_commands = {
        let guard = state.current_live_state.read().await;
        guard
            .as_ref()
            .map(|snapshot| snapshot.runtime_status.can_accept_commands)
            .unwrap_or(false)
    };

    Ok(Json(CommandQueueStatusResource {
        revision,
        pending_count,
        dispatched_count,
        can_accept_commands,
        commands: ledger.iter().map(command_status_resource).collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/commands/{command_id}",
    params(
        ("command_id" = String, Path, description = "Command identifier"),
    ),
    responses(
        (status = 200, description = "Command submission and dispatch detail", body = CommandDetailResource),
        (status = 404, description = "Command not found"),
    ),
    tag = "commands"
)]
pub async fn get_command_detail(
    State(state): State<Arc<AppState>>,
    Path(command_id): Path<String>,
) -> Result<Json<CommandDetailResource>, ApiError> {
    ensure_workspace(&state).await?;
    let ledger = state.current_command_ledger.lock().await;
    let record = ledger
        .iter()
        .find(|record| record.command.command_id == command_id)
        .ok_or_else(|| ApiError::not_found("command not found"))?;

    Ok(Json(CommandDetailResource {
        command_id: record.command.command_id.clone(),
        seq: record.command.seq,
        kind: record.command.kind.clone(),
        status: command_status_string(&record.status).to_string(),
        created_at_unix_ms: record.command.created_at_unix_ms,
        dispatched_at_unix_ms: record.dispatched_at_unix_ms,
        error: record.error.clone(),
        until_seconds: record.command.until_seconds,
        max_steps: record.command.max_steps,
        torque_tolerance: record.command.torque_tolerance,
        energy_tolerance: record.command.energy_tolerance,
        integrator: record.command.integrator.clone(),
        fixed_timestep: record.command.fixed_timestep,
        max_error: record.command.max_error,
        relax_algorithm: record.command.relax_algorithm.clone(),
        relax_alpha: record.command.relax_alpha,
        mesh_target: record.command.mesh_target.clone(),
        mesh_reason: record.command.mesh_reason.clone(),
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

fn runtime_status_kind(snapshot: &SessionStateResponse) -> String {
    format!("{:?}", snapshot.runtime_status.kind).to_ascii_lowercase()
}

fn command_status_resource(record: &TrackedCommandRecord) -> CommandStatusResource {
    CommandStatusResource {
        command_id: record.command.command_id.clone(),
        seq: record.command.seq,
        kind: record.command.kind.clone(),
        status: command_status_string(&record.status).to_string(),
        created_at_unix_ms: record.command.created_at_unix_ms,
        dispatched_at_unix_ms: record.dispatched_at_unix_ms,
        error: record.error.clone(),
    }
}

fn command_status_string(status: &CommandLifecycleState) -> &'static str {
    match status {
        CommandLifecycleState::Queued => "queued",
        CommandLifecycleState::Dispatched => "dispatched",
    }
}

async fn ensure_workspace(state: &Arc<AppState>) -> Result<(), ApiError> {
    let guard = state.current_live_state.read().await;
    if guard.is_some() {
        Ok(())
    } else {
        Err(ApiError::not_found("no active local live workspace"))
    }
}
