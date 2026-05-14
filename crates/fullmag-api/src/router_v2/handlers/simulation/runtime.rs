use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use fullmag_authoring::{MagnetizationAsset, SceneDocument, SceneObject};
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::runtime::{
    CommandDetailResource, CommandQueueStatusResource, CommandStatusResource, CurrentRunResource,
    ObjectEnergySummary, ObjectMagnetizationAverage, ObjectMetricsResource,
    SolverEnergyCurrentResource, SolverEnergyHistoryResource, SolverEnergyRow,
    SolverStatusResource, StageExecutionRecordResource, StageExecutionResource,
};
use crate::types::{
    AppState, CommandCompletionState, CommandLifecycleState, ScalarRow, SessionStateResponse,
    TrackedCommandRecord,
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
            .map(|record| StageExecutionRecordResource {
                status: record.status.as_str().to_string(),
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
        accepted_count,
        dispatched_count,
        running_count,
        completed_count,
        rejected_count,
        failed_count,
        can_accept_commands,
        commands: ledger.iter().map(command_status_resource).collect(),
    }))
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
    let ledger = state.current_command_ledger.lock().await;
    let record = ledger
        .iter()
        .find(|record| record.command.command_id == command_id)
        .ok_or_else(|| ApiError::not_found("command not found"))?;

    Ok(Json(CommandDetailResource {
        command_id: record.command.command_id.clone(),
        seq: record.command.seq,
        kind: record.command.kind.clone(),
        status: record.status.as_str().to_string(),
        created_at_unix_ms: record.command.created_at_unix_ms,
        dispatched_at_unix_ms: record.dispatched_at_unix_ms,
        completed_at_unix_ms: record.completed_at_unix_ms,
        completion_status: record
            .completion_status
            .map(command_completion_state_string),
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

fn runtime_status_kind(snapshot: &SessionStateResponse) -> String {
    format!("{:?}", snapshot.runtime_status.kind).to_ascii_lowercase()
}

fn command_status_resource(record: &TrackedCommandRecord) -> CommandStatusResource {
    CommandStatusResource {
        command_id: record.command.command_id.clone(),
        seq: record.command.seq,
        kind: record.command.kind.clone(),
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
