//! Native CUDA FDM execution loop.

use fullmag_ir::{FdmPlanIR, OutputIR};
#[cfg(feature = "cuda")]
use sha2::{Digest, Sha256};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(feature = "cuda")]
use crate::artifact_pipeline::ArtifactRecorder;
#[cfg(feature = "cuda")]
use crate::constraints::FrozenSpinsCheckpointV1;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::artifacts::{
    capture_initial_cuda_fields, record_cuda_due_outputs, record_cuda_final_outputs,
    record_cuda_initial_scalar, CudaFieldCaptureLedger,
};
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::live_observations::FdmLiveObservationScheduler;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::{NativeFdmBackend, NativeStatsMode, NativeStatsPolicy};
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::spin_transport::{
    GpuM1TransportSession, NativeGpuM1TransportAbi, PreparedGpuM1Descriptor,
};
#[cfg(feature = "cuda")]
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
#[cfg(feature = "cuda")]
use crate::preview::{build_grid_preview_field, flatten_vectors};
#[cfg(feature = "cuda")]
use crate::quantities::{
    active_fdm_preview_quantities, field_materialization_quantity_ids, quantity_spec,
};
#[cfg(feature = "cuda")]
use crate::relaxation::direct_minimizer::direct_minimizer_control;
#[cfg(feature = "cuda")]
use crate::relaxation::{
    apply_energy_minimizer_provenance, llg_overdamped_uses_pure_damping,
    RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation,
    CUDA_FDM_HOST_DIRECT_MINIMIZER_REALIZATION,
};
#[cfg(feature = "cuda")]
use crate::scalar_metrics::{
    apply_average_m_to_step_stats_with_active_mask, scalar_row_due, single_object_scalars,
};
#[cfg(feature = "cuda")]
use crate::schedules::{
    collect_field_schedules, collect_scalar_schedules, is_due, OutputSchedule,
    OUTPUT_TIME_TOLERANCE,
};
#[cfg(feature = "cuda")]
use crate::time_dependence::evaluate_time_dependence;
use crate::types::{ExecutedRun, LiveStepConsumer, RunError};
#[cfg(feature = "cuda")]
use crate::types::{
    ExecutionProvenance, FdmGpuEndpointCacheTelemetry, FdmGpuObservationPolicyProvenance,
    LiveFieldMaterializationState, LiveFieldMaterializationStatus, LivePreviewField,
    LivePreviewRequest, RunResult, RunStatus, StepAction, StepStats, StepUpdate,
};
#[cfg(feature = "cuda")]
use crate::{
    FdmGpuAcceptedStateSnapshotV1, ObservationClock, FDM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE,
};

#[cfg(feature = "cuda")]
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Wall-clock cadence of native stats snapshots for a live consumer when the
/// native policy leaves per-step energies unfilled (projector reads at 2 Hz).
#[cfg(feature = "cuda")]
const LIVE_STATS_SNAPSHOT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Preserve the last accepted clock and mark cancellation without manufacturing
/// a new accepted step. `current_accepted` is the backend's existing snapshot.
#[cfg(feature = "cuda")]
fn mark_cuda_cancelled_preserving_accepted<T: Clone>(
    latest_accepted: &mut Option<T>,
    current_accepted: &T,
    cancelled: &mut bool,
) {
    *cancelled = true;
    if latest_accepted.is_none() {
        *latest_accepted = Some(current_accepted.clone());
    }
}

/// Convert the native interrupt sentinel into cancellation. `None` is emitted
/// by `NativeFdmBackend::step_interruptible` only for
/// FULLMAG_FDM_ERR_INTERRUPTED; the native integrator rolls that candidate
/// step back before returning.
#[cfg(feature = "cuda")]
fn resolve_interruptible_cuda_step<T: Clone>(
    step: Option<T>,
    latest_accepted: &mut Option<T>,
    current_accepted: &T,
    cancelled: &mut bool,
) -> Option<T> {
    let Some(step) = step else {
        mark_cuda_cancelled_preserving_accepted(latest_accepted, current_accepted, cancelled);
        return None;
    };
    Some(step)
}

#[cfg(feature = "cuda")]
pub(super) fn capture_full_active_cuda_fields(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    grid: [u32; 3],
    source_step: u64,
    source_time_seconds: f64,
    config_revision: u64,
    magnetization: Option<&[[f64; 3]]>,
) -> Result<Vec<LivePreviewField>, RunError> {
    let quantities = field_materialization_quantity_ids();
    let quantities = crate::live_demand::retain_demanded_live_quantities(
        active_fdm_preview_quantities(crate::dispatch::FdmEngine::CudaFdm, plan, &quantities),
    );
    capture_cuda_fields_for_quantities(
        backend,
        plan,
        grid,
        source_step,
        source_time_seconds,
        config_revision,
        magnetization,
        &quantities,
    )
}

#[cfg(feature = "cuda")]
fn capture_one_active_cuda_field(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    grid: [u32; 3],
    source_step: u64,
    source_time_seconds: f64,
    config_revision: u64,
    magnetization: &[[f64; 3]],
    quantity: &str,
) -> Result<LivePreviewField, RunError> {
    let fields = capture_cuda_fields_for_quantities(
        backend,
        plan,
        grid,
        source_step,
        source_time_seconds,
        config_revision,
        Some(magnetization),
        &[quantity],
    )?;
    if fields.len() != 1 {
        return Err(RunError {
            message: format!(
                "CUDA FDM terminal observation did not produce active quantity '{quantity}'"
            ),
        });
    }
    Ok(fields.into_iter().next().expect("one captured field"))
}

#[cfg(feature = "cuda")]
#[allow(clippy::too_many_arguments)]
fn capture_cuda_fields_for_quantities(
    backend: &NativeFdmBackend,
    plan: &FdmPlanIR,
    grid: [u32; 3],
    source_step: u64,
    source_time_seconds: f64,
    config_revision: u64,
    magnetization: Option<&[[f64; 3]]>,
    requested_quantities: &[&str],
) -> Result<Vec<LivePreviewField>, RunError> {
    let quantities = active_fdm_preview_quantities(
        crate::dispatch::FdmEngine::CudaFdm,
        plan,
        requested_quantities,
    );
    let cell_count = (grid[0] as usize)
        .checked_mul(grid[1] as usize)
        .and_then(|count| count.checked_mul(grid[2] as usize))
        .ok_or_else(|| RunError {
            message: "CUDA live field capture grid size overflow".to_string(),
        })?;
    let owned_magnetization;
    let magnetization = if let Some(magnetization) = magnetization {
        magnetization
    } else {
        owned_magnetization = backend.copy_m(cell_count)?;
        &owned_magnetization
    };
    if magnetization.len() != cell_count {
        return Err(RunError {
            message: format!(
                "CUDA live field capture expected {cell_count} magnetization cells, received {}",
                magnetization.len()
            ),
        });
    }

    let capture_started = Instant::now();
    let base_request = LivePreviewRequest {
        revision: config_revision,
        quantity: "m".to_string(),
        component: "3D".to_string(),
        layer: 0,
        all_layers: true,
        every_n: 1,
        x_chosen_size: grid[0],
        y_chosen_size: grid[1],
        auto_scale_enabled: false,
        max_points: 0,
    };
    let mut fields = Vec::with_capacity(quantities.len());
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let field = if quantity == "m" {
            build_grid_preview_field(&request, magnetization, grid, plan.active_mask.as_deref())
        } else {
            backend.copy_live_preview_field(&request, grid, plan.active_mask.as_deref())?
        };
        let expected_components = quantity_spec(quantity)
            .map(|spec| spec.n_comp as usize)
            .unwrap_or(3);
        let expected_values = cell_count
            .checked_mul(expected_components)
            .ok_or_else(|| RunError {
                message: format!("CUDA live field '{}' value count overflow", quantity),
            })?;
        if field.original_grid != grid
            || field.preview_grid != grid
            || field.auto_downscaled
            || field.vector_field_values.len() != expected_values
        {
            return Err(RunError {
                message: format!(
                    "CUDA live field '{}' did not produce the required full grid {:?}",
                    quantity, grid
                ),
            });
        }
        fields.push(field);
    }

    let materialization_wall_time_ns = capture_started.elapsed().as_nanos() as u64;
    let materialized_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    for field in &mut fields {
        field.config_revision = config_revision;
        field.source_step = source_step;
        field.source_time_seconds = Some(source_time_seconds);
        field.source_revision = config_revision;
        field.materialized_at_unix_ms = materialized_at_unix_ms;
        field.materialization_wall_time_ns = materialization_wall_time_ns;
    }
    Ok(fields)
}

#[cfg(feature = "cuda")]
pub(super) fn mark_full_fields_materialized(stats: &mut StepStats, fields: &[LivePreviewField]) {
    for field in fields {
        stats
            .field_materialization_states
            .retain(|status| status.quantity != field.quantity);
        stats
            .field_materialization_states
            .push(LiveFieldMaterializationStatus {
                quantity: field.quantity.clone(),
                source_step: field.source_step,
                request_revision: field.source_revision,
                state: LiveFieldMaterializationState::Complete,
                error: None,
            });
    }
}

#[cfg(feature = "cuda")]
pub(super) fn mark_full_fields_materialization_error(
    stats: &mut StepStats,
    plan: &FdmPlanIR,
    source_step: u64,
    request_revision: u64,
    error: &str,
) {
    let quantities = field_materialization_quantity_ids();
    let quantities = active_fdm_preview_quantities(
        crate::dispatch::FdmEngine::CudaFdm,
        plan,
        &quantities,
    );
    for quantity in quantities {
        stats
            .field_materialization_states
            .retain(|status| status.quantity != quantity);
        stats
            .field_materialization_states
            .push(LiveFieldMaterializationStatus {
                quantity: quantity.to_string(),
                source_step,
                request_revision,
                state: LiveFieldMaterializationState::Error,
                error: Some(error.to_string()),
            });
    }
}

#[cfg(feature = "cuda")]
fn mark_field_materialization_error(
    stats: &mut StepStats,
    quantity: &str,
    source_step: u64,
    request_revision: u64,
    error: &str,
) {
    stats
        .field_materialization_states
        .retain(|status| status.quantity != quantity);
    stats
        .field_materialization_states
        .push(LiveFieldMaterializationStatus {
            quantity: quantity.to_string(),
            source_step,
            request_revision,
            state: LiveFieldMaterializationState::Error,
            error: Some(error.to_string()),
        });
}

#[cfg(feature = "cuda")]
fn frozen_spins_checkpoint_value(
    plan: &FdmPlanIR,
    frozen_state: Option<&fullmag_engine::FrozenSpinsState>,
    magnetization: &[[f64; 3]],
    step: u64,
    time_s: f64,
    dt: f64,
) -> Result<Option<serde_json::Value>, RunError> {
    let (Some(frozen_plan), Some(frozen_state)) = (plan.frozen_spins.as_ref(), frozen_state) else {
        return Ok(None);
    };
    let checkpoint = FrozenSpinsCheckpointV1::from_runtime(
        frozen_plan,
        frozen_state,
        magnetization,
        step,
        time_s,
        dt,
        "fdm_cuda",
        "cuda",
        match plan.precision {
            fullmag_ir::ExecutionPrecision::Double => "double",
            fullmag_ir::ExecutionPrecision::Single => "single",
        },
    )
    .map_err(|error| RunError {
        message: format!("serializing CUDA Frozen Spins checkpoint: {error}"),
    })?;
    let plan_bytes = serde_json::to_vec(plan).map_err(|error| RunError {
        message: format!("serializing CUDA FDM plan identity: {error}"),
    })?;
    let checkpoint =
        checkpoint.with_problem_sha256(format!("sha256:{:x}", Sha256::digest(plan_bytes)));
    serde_json::to_value(checkpoint)
        .map(Some)
        .map_err(|error| RunError {
            message: format!("serializing CUDA Frozen Spins checkpoint: {error}"),
        })
}

#[cfg(feature = "cuda")]
fn ensure_single_object_scalars(stats: &mut StepStats, object_id: &str) {
    if stats.per_object_scalars.is_empty() {
        stats.per_object_scalars = single_object_scalars(object_id, stats);
    }
}

#[cfg(feature = "cuda")]
fn apply_regional_drive_energy(
    plan: &FdmPlanIR,
    stats: &mut StepStats,
    magnetization: &[[f64; 3]],
) {
    let cell_volume = plan.cell_size[0] * plan.cell_size[1] * plan.cell_size[2];
    // A cellwise Ms field weights each cell like the device energy reductions do.
    let saturation_magnetisation = |index: usize| {
        plan.material
            .ms_field
            .as_ref()
            .map_or(plan.material.saturation_magnetisation, |ms| ms[index])
    };
    let mut magnetization_dot_field = 0.0;
    for resolved in &plan.regional_field_drive_bases {
        if !resolved.drive.enabled {
            continue;
        }
        let waveform_time_s = super::canonical_fdm_waveform_time(
            plan,
            resolved.drive.time_origin,
            stats.time,
        );
        let multiplier = evaluate_time_dependence(&resolved.drive.waveform, waveform_time_s);
        for (index, (m, field)) in magnetization.iter().zip(&resolved.field_xyz).enumerate() {
            if plan.active_mask.as_ref().is_some_and(|mask| !mask[index]) {
                continue;
            }
            magnetization_dot_field += multiplier
                * saturation_magnetisation(index)
                * (m[0] * field[0] + m[1] * field[1] + m[2] * field[2]);
        }
    }
    for resolved in &plan.solved_antenna_drive_bases {
        if !resolved.drive.activation.is_active_for(
            plan.time_stage.study_kind,
            plan.time_stage.active_stage_id.as_deref(),
        ) {
            continue;
        }
        let waveform_time_s = super::canonical_fdm_waveform_time(
            plan,
            resolved.drive.time_origin,
            stats.time,
        );
        let multiplier = evaluate_time_dependence(&resolved.drive.waveform, waveform_time_s);
        for (index, (m, field)) in magnetization
            .iter()
            .zip(&resolved.field_xyz_apm_per_a)
            .enumerate()
        {
            if plan.active_mask.as_ref().is_some_and(|mask| !mask[index]) {
                continue;
            }
            magnetization_dot_field += multiplier
                * resolved.drive.peak_current_a
                * saturation_magnetisation(index)
                * (m[0] * field[0] + m[1] * field[1] + m[2] * field[2]);
        }
    }
    stats.e_drive = -crate::MU0 * cell_volume * magnetization_dot_field;
}

#[cfg(feature = "cuda")]
fn public_gpu_device_ordinal() -> Result<i32, RunError> {
    let raw = std::env::var("FULLMAG_FDM_GPU_INDEX").unwrap_or_else(|_| "0".to_string());
    raw.parse::<i32>()
        .ok()
        .filter(|ordinal| *ordinal >= 0)
        .ok_or_else(|| RunError {
            message: format!("FULLMAG_FDM_GPU_INDEX must be a non-negative i32, got '{raw}'"),
        })
}

#[cfg(feature = "cuda")]
fn should_refresh_cuda_terminal_stats(
    quantity_mask: u64,
    has_accepted_step_table: bool,
    direct_minimizer: bool,
) -> bool {
    (quantity_mask != 0 || has_accepted_step_table) && !direct_minimizer
}

#[cfg(feature = "cuda")]
fn adaptive_batch_execution_eligible(
    plan: &FdmPlanIR,
    live: bool,
    has_accepted_step_autosave_schedules: bool,
) -> bool {
    // The batch ABI runs only through the adaptive CUDA graph, which bakes
    // stage times into its capture and rejects time-dependent drives.
    plan.adaptive_timestep.is_some()
        && plan.relaxation.is_none()
        && plan.spin_transport_plans.is_empty()
        && !plan_uploads_time_dependent_drive(plan)
        && !live
        // The native batch ABI exposes only terminal accepted-state outputs.
        // Accepted-step table or field autosaves require the regular loop.
        && !has_accepted_step_autosave_schedules
}

#[cfg(feature = "cuda")]
/// Mirrors the drives `native.rs` uploads, enabled or not.
fn plan_uploads_time_dependent_drive(plan: &FdmPlanIR) -> bool {
    let dynamic = |waveform: &fullmag_ir::TimeDependenceIR| {
        !matches!(waveform, fullmag_ir::TimeDependenceIR::Constant)
    };
    plan.regional_field_drive_bases
        .iter()
        .any(|basis| dynamic(&basis.drive.waveform))
        || plan
            .solved_antenna_drive_bases
            .iter()
            .any(|basis| dynamic(&basis.drive.waveform))
}

#[cfg(feature = "cuda")]
fn append_solved_antenna_drive_events(
    events: &mut Vec<f64>,
    drive: &fullmag_ir::SolvedAntennaDriveIR,
    stage_start_s: f64,
    waveform_origin_s: f64,
    stage_end_s: f64,
    tolerance_s: f64,
) {
    let offsets = match &drive.waveform {
        fullmag_ir::TimeDependenceIR::Pulse { t_on, t_off } => vec![*t_on, *t_off],
        fullmag_ir::TimeDependenceIR::PiecewiseLinear { points } => {
            points.iter().map(|[time_s, _]| *time_s).collect()
        }
        fullmag_ir::TimeDependenceIR::Constant
        | fullmag_ir::TimeDependenceIR::Sinusoidal { .. }
        | fullmag_ir::TimeDependenceIR::SincPulse { .. } => Vec::new(),
    };
    for offset_s in offsets {
        let time_s = match drive.time_origin {
            fullmag_ir::FieldTimeOriginIR::StageLocal => waveform_origin_s + offset_s,
            fullmag_ir::FieldTimeOriginIR::Absolute => offset_s,
        };
        if time_s > stage_start_s + tolerance_s && time_s < stage_end_s - tolerance_s {
            events.push(time_s);
        }
    }
}

#[cfg(feature = "cuda")]
fn cuda_drive_event_schedule(plan: &FdmPlanIR, until_seconds: f64) -> Vec<f64> {
    let stage_start_s = plan.time_stage.start_time_s;
    let stage_end_s = stage_start_s + until_seconds;
    let tolerance_s = crate::schedules::OUTPUT_TIME_TOLERANCE;
    let mut events = vec![stage_start_s, stage_end_s];
    events.extend(crate::time_events::resolved_stage_drive_discontinuities_with_origin(
        &plan.field_drives,
        &plan.solved_antenna_drive_bases,
        stage_start_s,
        plan.time_stage.waveform_origin_time_s(),
        stage_end_s,
        tolerance_s,
    ));
    for resolved in &plan.solved_antenna_drive_bases {
        if resolved.drive.activation.is_active_for(
            plan.time_stage.study_kind,
            plan.time_stage.active_stage_id.as_deref(),
        ) {
            append_solved_antenna_drive_events(
                &mut events,
                &resolved.drive,
                stage_start_s,
                plan.time_stage.waveform_origin_time_s(),
                stage_end_s,
                tolerance_s,
            );
        }
    }
    events.retain(|time_s| time_s.is_finite());
    events.sort_by(f64::total_cmp);
    events.dedup_by(|right, left| (*right - *left).abs() <= tolerance_s);
    events
}

#[cfg(feature = "cuda")]
fn cap_cuda_target_to_drive_event(
    plan: &FdmPlanIR,
    current_solver_time_s: f64,
    proposed_target_solver_time_s: f64,
    drive_events_s: &[f64],
) -> f64 {
    let current_absolute_s = super::canonical_fdm_time(plan, current_solver_time_s);
    let proposed_absolute_s = super::canonical_fdm_time(plan, proposed_target_solver_time_s);
    drive_events_s
        .iter()
        .copied()
        .find(|event_s| {
            *event_s > current_absolute_s + crate::schedules::OUTPUT_TIME_TOLERANCE
                && *event_s < proposed_absolute_s - crate::schedules::OUTPUT_TIME_TOLERANCE
        })
        .map_or(proposed_target_solver_time_s, |event_s| {
            event_s - plan.time_stage.start_time_s
        })
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone)]
struct ResolvedObservationPolicy {
    native: NativeStatsPolicy,
    requested_contract: String,
    requested_quantity_ids: Vec<String>,
    requested_min_period_s: Option<f64>,
}

#[cfg(feature = "cuda")]
fn scalar_stats_quantity_mask(name: &str) -> u64 {
    match name {
        "E_ex" => fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_EX,
        "E_demag" => fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_DEMAG,
        "E_ext" | "E_drive" => fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_EXT,
        "E_total" => fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_TOTAL,
        "max_dm_dt" => fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_MAX_RHS,
        "max_h_eff" => fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_MAX_H_EFF,
        "time" | "step" | "solver_dt" | "mx" | "my" | "mz" => 0,
        _ => 0,
    }
}

#[cfg(feature = "cuda")]
fn resolve_observation_policy(
    plan: &FdmPlanIR,
    outputs: &[OutputIR],
    live: bool,
) -> ResolvedObservationPolicy {
    if direct_minimizer_control(plan.relaxation.as_ref()).is_some() {
        return ResolvedObservationPolicy {
            native: NativeStatsPolicy::full(1),
            requested_contract: "direct_minimizer_full_step_diagnostics".to_string(),
            requested_quantity_ids: vec!["all".to_string()],
            requested_min_period_s: None,
        };
    }

    let mut mask = 0;
    let mut requested_quantity_ids = Vec::new();
    let mut requested_min_period_s: Option<f64> = None;
    for output in outputs {
        let (name, every_seconds) = match output {
            OutputIR::Scalar {
                name,
                every_seconds,
            }
            | OutputIR::ScalarResolvedAuto {
                name,
                every_seconds,
                ..
            } => (name, *every_seconds),
            _ => continue,
        };
        mask |= scalar_stats_quantity_mask(name);
        if !requested_quantity_ids.contains(name) {
            requested_quantity_ids.push(name.clone());
        }
        requested_min_period_s = Some(
            requested_min_period_s.map_or(every_seconds, |current| current.min(every_seconds)),
        );
    }

    let default_final_scalar = requested_quantity_ids.is_empty();
    if default_final_scalar || live {
        mask |= fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_ALL;
    }
    if plan.relaxation.is_some() {
        mask |= fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_TOTAL
            | fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_MAX_TORQUE;
    }

    let stride = match (requested_min_period_s, plan.fixed_timestep) {
        (Some(period), Some(dt)) if period.is_finite() && dt.is_finite() && dt > 0.0 => {
            (period / dt).ceil().clamp(1.0, u32::MAX as f64) as u32
        }
        _ => 1,
    };
    // Relaxation needs a fresh free-DOF torque on every accepted step (0580).
    // Native CONTROL diagnostics support fixed steps only: adaptive RK paths
    // return metadata-only zero values in that mode. Request full native
    // scalar reductions for adaptive LLG so missing measurements cannot count
    // as three zero-torque confirmations. No host field reconstruction is used.
    let native = if plan.relaxation.is_some() {
        if plan.adaptive_timestep.is_some()
            && plan.relaxation.as_ref().is_some_and(|control| {
                control.algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped
            })
        {
            NativeStatsPolicy::full(1)
        } else {
            NativeStatsPolicy::control(1)
        }
    } else if mask == 0 {
        NativeStatsPolicy::none(stride)
    } else {
        NativeStatsPolicy::requested(stride, mask)
    };
    let requested_contract = if plan.relaxation.is_some() {
        "relaxation_control_plus_scheduled_outputs"
    } else if live {
        "interactive_selection_plus_scheduled_outputs"
    } else if default_final_scalar {
        "default_final_scalar"
    } else {
        "scheduled_outputs"
    };
    ResolvedObservationPolicy {
        native,
        requested_contract: requested_contract.to_string(),
        requested_quantity_ids,
        requested_min_period_s,
    }
}

#[cfg(feature = "cuda")]
fn adaptive_batch_target(
    current_time: f64,
    current_dt: f64,
    until_seconds: f64,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
) -> (f64, u32) {
    let mut due_now = false;
    let mut next_boundary = until_seconds;
    for schedule in scalar_schedules.iter().chain(field_schedules) {
        if is_due(current_time, schedule.next_time) {
            due_now = true;
        } else if schedule.next_time < next_boundary {
            next_boundary = schedule.next_time;
        }
    }
    if due_now {
        (
            (current_time + current_dt)
                .min(next_boundary)
                .min(until_seconds),
            1,
        )
    } else {
        (next_boundary, 64)
    }
}

#[cfg(feature = "cuda")]
pub(crate) fn execute_cuda_fdm(
    requested_backend: fullmag_ir::BackendTarget,
    requested_device: &str,
    execution_mode: fullmag_ir::ExecutionMode,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    let has_dynamic_drive = plan
        .regional_field_drive_bases
        .iter()
        .any(|basis| {
            basis.drive.enabled
                && !matches!(basis.drive.waveform, fullmag_ir::TimeDependenceIR::Constant)
        })
        || plan.solved_antenna_drive_bases.iter().any(|basis| {
            !matches!(basis.drive.waveform, fullmag_ir::TimeDependenceIR::Constant)
        });
    if has_dynamic_drive
        && plan.time_stage.waveform_origin_time_s() != plan.time_stage.start_time_s
    {
        return Err(RunError {
            message: "exact stage-local waveform resume is not qualified for FDM CUDA execution"
                .to_string(),
        });
    }
    crate::solver_runtime::selection::reject_frozen_spins_cuda_plan_execution(plan)?;
    if plan.frozen_spins.is_some() && direct_minimizer_control(plan.relaxation.as_ref()).is_some() {
        return Err(RunError {
            message: "frozen_spins_cuda_direct_minimizer_unqualified: native CUDA BB/NCG does not yet consume the resolved frozen reference during trial retractions".to_string(),
        });
    }
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let observation_policy = resolve_observation_policy(plan, outputs, live.is_some());

    let mut gpu_transport = if plan.spin_transport_plans.is_empty() {
        None
    } else {
        let prepared = PreparedGpuM1Descriptor::from_plan(plan, public_gpu_device_ordinal()?)
            .map_err(|error| RunError {
                message: format!("materializing public GPU M1 transport failed: {error}"),
            })?;
        let mut session = GpuM1TransportSession::create(NativeGpuM1TransportAbi, prepared)
            .map_err(|error| RunError {
                message: format!("creating public GPU M1 transport session failed: {error}"),
            })?;
        session.solve_charge(1, 0).map_err(|error| RunError {
            message: format!("solving public GPU M1 charge snapshot failed: {error}"),
        })?;
        Some(session)
    };
    let has_accepted_step_autosave_schedules = artifact_writer
        .as_ref()
        .is_some_and(ArtifactPipelineSender::has_accepted_step_autosave_schedules);
    let use_adaptive_batch = adaptive_batch_execution_eligible(
        plan,
        live.is_some(),
        has_accepted_step_autosave_schedules,
    );
    let mut backend = if use_adaptive_batch {
        NativeFdmBackend::create_for_adaptive_batch_with_policy(plan, observation_policy.native)?
    } else {
        NativeFdmBackend::create_with_stats_policy(plan, observation_policy.native)?
    };
    if let Some(session) = gpu_transport.as_ref() {
        let binding = session.llg_binding().map_err(|error| RunError {
            message: format!("materializing public GPU M1 LLG binding failed: {error}"),
        })?;
        backend.bind_gpu_transport(&binding)?;
    }
    let device_info = backend.device_info()?;
    let (receipt_lifecycle, initial_execution_receipt) =
        crate::fdm::gpu::cuda::native::residency::FdmGpuReceiptLifecycle::begin(
            &backend,
            requested_device,
            execution_mode,
        )?;
    backend.set_checkpoint_execution_identity(
        requested_backend,
        requested_device,
        execution_mode,
        plan.integrator
            .unwrap_or(fullmag_ir::IntegratorChoice::Heun),
    )?;
    let cell_count = (plan.grid.cells[0] as usize)
        * (plan.grid.cells[1] as usize)
        * (plan.grid.cells[2] as usize);
    let initial_magnetization = backend.copy_m(cell_count)?;
    let frozen_spins_state = plan
        .frozen_spins
        .as_ref()
        .map(|frozen_plan| {
            fullmag_engine::FrozenSpinsState::capture_at_activation(
                frozen_plan,
                plan.active_mask.as_deref(),
                &initial_magnetization,
            )
            .map_err(|error| RunError {
                message: format!("CUDA Frozen Spins activation: {error}"),
            })
        })
        .transpose()?;
    let timestep_policy = if direct_minimizer_control(plan.relaxation.as_ref()).is_some() {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?)
    };
    let initial_dt = timestep_policy.as_ref().map(|policy| policy.initial_dt());
    let mut steps = Vec::new();
    let fdm_fft_execution =
        crate::fdm::resolve_cuda_fft_execution_for_demag(plan.enable_demag, plan.fft.as_ref())?;
    let mut provenance = ExecutionProvenance {
        execution_engine: "cuda_fdm".to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        transport_modules: crate::fdm::cpu::spin_transport::fdm_gpu_transport_execution_provenance(
            plan,
        ),
        fdm_gpu_execution_receipt: Some(initial_execution_receipt),
        fdm_gpu_observation_policy: Some(FdmGpuObservationPolicyProvenance {
            requested_contract: observation_policy.requested_contract.clone(),
            requested_quantity_ids: observation_policy.requested_quantity_ids.clone(),
            requested_min_period_s: observation_policy.requested_min_period_s,
            resolved_mode: observation_policy.native.mode.as_str().to_string(),
            resolved_quantity_mask: observation_policy.native.quantity_mask,
            resolved_stride: observation_policy.native.stride,
            executed_mode: backend.stats_policy().mode.as_str().to_string(),
            executed_quantity_mask: backend.stats_policy().quantity_mask,
            executed_stride: backend.stats_policy().stride,
        }),
        fdm_fft_execution,
        timestep_policy,
        executed_physics_kinds: if direct_minimizer_control(plan.relaxation.as_ref()).is_none()
            && (plan.zhang_li_formula_version.is_some()
                || plan.slonczewski_formula_version.is_some()
                || plan.sot_formula_version.is_some())
        {
            vec!["spin_torque".to_string()]
        } else {
            Vec::new()
        },
        ..Default::default()
    };
    apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
    if direct_minimizer_control(plan.relaxation.as_ref()).is_some() {
        provenance.energy_minimizer_realization =
            Some(CUDA_FDM_HOST_DIRECT_MINIMIZER_REALIZATION.to_string());
    }
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let default_scalar_trace = scalar_schedules.is_empty();
    let drive_event_schedule = cuda_drive_event_schedule(plan, until_seconds);
    let mut field_capture_ledger = CudaFieldCaptureLedger::default();
    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut numerical_stagnation = false;
    let mut direct_minimizer_torque_confirmed = false;
    let mut current_stats = if observation_policy.native.mode == NativeStatsMode::Control {
        backend.snapshot_step_stats_with_policy(plan.grid.cells, NativeStatsPolicy::full(1))?
    } else {
        backend.snapshot_step_stats(plan.grid.cells)?
    };
    ensure_single_object_scalars(&mut current_stats, "free");
    capture_initial_cuda_fields(
        &backend,
        plan,
        cell_count,
        &current_stats,
        &mut field_schedules,
        &mut field_capture_ledger,
        &mut artifacts,
    )?;
    let mut initial_scalar_stats = if artifacts.accepted_step_table_due(current_stats.step) {
        let mut table_stats = backend.snapshot_step_stats_with_policy(
            plan.grid.cells,
            NativeStatsPolicy::full(1),
        )?;
        ensure_single_object_scalars(&mut table_stats, "free");
        table_stats
    } else {
        current_stats.clone()
    };
    backend.apply_average_m_to_step_stats_from_values(
        &mut initial_scalar_stats,
        &initial_magnetization,
    );
    apply_regional_drive_energy(plan, &mut initial_scalar_stats, &initial_magnetization);
    record_cuda_initial_scalar(
        &initial_scalar_stats,
        default_scalar_trace,
        &mut scalar_schedules,
        &mut steps,
        &mut artifacts,
    )?;
    let mut live_observations = live
        .as_ref()
        .map(|_| FdmLiveObservationScheduler::new(plan, plan.grid.cells));
    let mut final_frozen_checkpoint = frozen_spins_checkpoint_value(
        plan,
        frozen_spins_state.as_ref(),
        &initial_magnetization,
        current_stats.step,
        current_stats.time,
        current_stats.dt,
    )?;

    if let Some(direct_minimizer) = direct_minimizer_control(plan.relaxation.as_ref()) {
        let outcome = crate::fdm::gpu::cuda::direct_minimizer::execute_direct_minimizer(
            &mut backend,
            plan,
            cell_count,
            direct_minimizer,
            current_stats.clone(),
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            &mut energy_plateau,
            last_preview_revision,
            live_observations.as_mut(),
        )?;
        latest_stats = outcome.latest_stats;
        if let Some(stats) = latest_stats.clone() {
            current_stats = stats;
        }
        cancelled = outcome.cancelled;
        direct_minimizer_torque_confirmed = outcome.torque_confirmed;
        numerical_stagnation = outcome.numerical_stagnation;
    } else {
        let mut dt = initial_dt.expect("LLG execution requires a resolved timestep policy");
        let mut last_live_stats_snapshot: Option<Instant> = None;
        while current_time < until_seconds {
            if use_adaptive_batch {
                if current_time + OUTPUT_TIME_TOLERANCE >= until_seconds {
                    break;
                }
                let (target_time, max_steps) = adaptive_batch_target(
                    current_time,
                    dt,
                    until_seconds,
                    &scalar_schedules,
                    &field_schedules,
                );
                let target_time = cap_cuda_target_to_drive_event(
                    plan,
                    current_time,
                    target_time,
                    &drive_event_schedule,
                );
                let Some(batch) =
                    backend.step_adaptive_batch_interruptible(dt, target_time, max_steps, None)?
                else {
                    continue;
                };
                let terminal = *batch
                    .last()
                    .expect("native batch is validated as non-empty");
                current_time = terminal.time;
                dt = terminal.suggested_next_dt;

                let observation_due = max_steps == 1 || is_due(current_time, target_time);
                if !observation_due {
                    continue;
                }
                let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                stats.error_estimate = Some(terminal.normalized_error);
                stats.rejected_attempts = terminal.rejected_attempts;
                stats.dt_suggested = Some(terminal.suggested_next_dt);
                ensure_single_object_scalars(&mut stats, "free");
                latest_stats = Some(stats.clone());
                current_stats = stats.clone();
                let magnetization = backend.copy_m(cell_count)?;
                let mut sampled_stats = stats.clone();
                apply_average_m_to_step_stats_with_active_mask(
                    &mut sampled_stats,
                    &magnetization,
                    plan.active_mask.as_deref(),
                    plan.material.ms_field.as_deref(),
                );
                apply_regional_drive_energy(plan, &mut sampled_stats, &magnetization);
                record_cuda_due_outputs(
                    &backend,
                    plan,
                    cell_count,
                    &sampled_stats,
                    Some(&magnetization),
                    None,
                    &mut scalar_schedules,
                    &mut field_schedules,
                    &mut steps,
                    &mut field_capture_ledger,
                    &mut artifacts,
                )?;
                continue;
            }
            if let Some(live) = live.as_mut() {
                if let Some(display_selection) = live.display_selection.map(|get| get()) {
                    let preview_due = display_refresh_due(
                        last_preview_revision,
                        &display_selection,
                        current_stats.step,
                    );
                    let preview_targets_global_scalar =
                        display_is_global_scalar(&display_selection);
                    let mut observation_publication = live_observations.as_mut().map(|scheduler| {
                        scheduler.observe(
                            &backend,
                            &display_selection,
                            current_stats.step,
                            current_stats.time,
                            current_stats.dt,
                        )
                    });
                    let (preview_field, cached_preview_fields) =
                        if let Some(publication) = observation_publication.as_mut() {
                            publication.apply_to_stats(&mut current_stats);
                            (
                                publication.preview_field.take(),
                                publication.cached_preview_fields.take(),
                            )
                        } else {
                            (None, None)
                        };
                    let action = (live.on_step)(StepUpdate {
                        coupled_checkpoint: final_frozen_checkpoint.clone(),
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh_generation_id: None,
                        magnetization: None,
                        preview_field,
                        cached_preview_fields,
                        hysteresis_field_m_t: None,
                        hysteresis_point_index: None,
                        hysteresis_settle_step_index: None,
                        hysteresis_settle_step_kind: None,
                        hysteresis_settle_step_method: None,
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        terminal_field_snapshot: false,
                        finished: false,
                        magnetization_carrier: None,
                    });
                    if preview_due {
                        last_preview_revision = Some(display_selection.revision);
                    }
                    if action == StepAction::Stop {
                        mark_cuda_cancelled_preserving_accepted(
                            &mut latest_stats,
                            &current_stats,
                            &mut cancelled,
                        );
                        break;
                    }
                }
            }

            let dt_step = crate::time_events::cap_timestep_to_next_event(
                super::canonical_fdm_time(plan, current_time),
                dt.min(until_seconds - current_time),
                &drive_event_schedule,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let interrupt_requested = live
                .as_ref()
                .and_then(|consumer| consumer.interrupt_requested);
            let step = backend.step_interruptible(dt_step, interrupt_requested)?;
            let Some(mut stats) = resolve_interruptible_cuda_step(
                step,
                &mut latest_stats,
                &current_stats,
                &mut cancelled,
            ) else {
                // The interrupted attempt rolled back. Finalize from the
                // backend's last accepted magnetization instead of retrying it.
                break;
            };
            // Adaptive integrators return the controller's next step size with
            // the accepted step; snapshots below replace `stats` and drop it.
            if let Some(next_dt) = stats.dt_suggested {
                dt = next_dt;
            }
            let due_scalar_row = scalar_row_due(&scalar_schedules, stats.time);
            let native_relaxation_full = plan.relaxation.is_some()
                && observation_policy.native.mode == NativeStatsMode::Full;
            let native_relaxation_control = plan.relaxation.is_some()
                && observation_policy.native.mode == NativeStatsMode::Control;
            let native_stats_observed =
                due_scalar_row && !native_relaxation_full && !native_relaxation_control;
            if native_relaxation_control && due_scalar_row {
                stats = backend
                    .snapshot_step_stats_with_policy(plan.grid.cells, NativeStatsPolicy::full(1))?;
            } else if native_stats_observed {
                stats = backend.snapshot_step_stats(plan.grid.cells)?;
            }
            // Requested/None native policies never fill energies or torque in
            // the step itself; such a step returns them as zeros. A live
            // consumer therefore gets a real snapshot at a bounded wall-clock
            // cadence, and the other steps are not labelled physical rows.
            let native_step_unobserved = matches!(
                observation_policy.native.mode,
                NativeStatsMode::Requested | NativeStatsMode::None
            ) && !native_stats_observed;
            let live_stats_due = native_step_unobserved
                && live.is_some()
                && last_live_stats_snapshot
                    .is_none_or(|last| last.elapsed() >= LIVE_STATS_SNAPSHOT_INTERVAL);
            if live_stats_due {
                stats = backend.snapshot_step_stats(plan.grid.cells)?;
                last_live_stats_snapshot = Some(Instant::now());
            }
            let step_stats_observed = !native_step_unobserved || live_stats_due;
            ensure_single_object_scalars(&mut stats, "free");
            current_time = stats.time;
            latest_stats = Some(stats.clone());
            current_stats = stats.clone();
            if !step_stats_observed {
                // The next loop iteration publishes these stats to the live
                // consumer before it steps; they must not read as a measurement.
                current_stats.kind = fullmag_quantities::StepDataKind::LegacyUnclassified;
            }
            // The checkpoint exists only for frozen-spin plans; without one this
            // device-to-host copy of m on every live step had no consumer.
            if live.is_some() && frozen_spins_state.is_some() {
                let frozen_magnetization = backend.copy_m(cell_count)?;
                final_frozen_checkpoint = frozen_spins_checkpoint_value(
                    plan,
                    frozen_spins_state.as_ref(),
                    &frozen_magnetization,
                    stats.step,
                    stats.time,
                    stats.dt,
                )?;
            }
            let mut sampled_stats = stats.clone();
            if !step_stats_observed {
                sampled_stats.kind = fullmag_quantities::StepDataKind::LegacyUnclassified;
            }
            let mut magnetization_cache: Option<Vec<[f64; 3]>> = None;
            if due_scalar_row {
                if magnetization_cache.is_none() {
                    magnetization_cache = Some(backend.copy_m(cell_count)?);
                }
                apply_average_m_to_step_stats_with_active_mask(
                    &mut sampled_stats,
                    magnetization_cache
                        .as_deref()
                        .expect("magnetization cache initialized"),
                    plan.active_mask.as_deref(),
                    plan.material.ms_field.as_deref(),
                );
                apply_regional_drive_energy(
                    plan,
                    &mut sampled_stats,
                    magnetization_cache
                        .as_deref()
                        .expect("magnetization cache initialized"),
                );
            }
            if let Some(live) = live.as_mut() {
                let heavy_payload_every = live.field_every_n.max(1);
                let heavy_payload_due = stats.step % heavy_payload_every == 0;
                if heavy_payload_due && !due_scalar_row {
                    if magnetization_cache.is_none() {
                        magnetization_cache = Some(backend.copy_m(cell_count)?);
                    }
                    apply_average_m_to_step_stats_with_active_mask(
                        &mut sampled_stats,
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                        plan.active_mask.as_deref(),
                        plan.material.ms_field.as_deref(),
                    );
                    apply_regional_drive_energy(
                        plan,
                        &mut sampled_stats,
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                    );
                }
                let display_selection = live.display_selection.map(|get| get());
                let preview_due = display_selection
                    .as_ref()
                    .map(|selection| {
                        display_refresh_due(last_preview_revision, selection, stats.step)
                    })
                    .unwrap_or(false);
                let preview_targets_global_scalar = display_selection
                    .as_ref()
                    .is_some_and(display_is_global_scalar);
                if preview_due
                    && preview_targets_global_scalar
                    && !native_stats_observed
                    && !native_relaxation_control
                {
                    stats = backend.snapshot_step_stats(plan.grid.cells)?;
                    ensure_single_object_scalars(&mut stats, "free");
                    sampled_stats = stats.clone();
                    latest_stats = Some(stats.clone());
                    current_stats = stats.clone();
                    if magnetization_cache.is_none() {
                        magnetization_cache = Some(backend.copy_m(cell_count)?);
                    }
                    apply_average_m_to_step_stats_with_active_mask(
                        &mut sampled_stats,
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                        plan.active_mask.as_deref(),
                        plan.material.ms_field.as_deref(),
                    );
                    apply_regional_drive_energy(
                        plan,
                        &mut sampled_stats,
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                    );
                }
                let magnetization = if heavy_payload_due {
                    if magnetization_cache.is_none() {
                        magnetization_cache = Some(backend.copy_m(cell_count)?);
                    }
                    Some(flatten_vectors(
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                    ))
                } else {
                    None
                };
                let mut observation_publication =
                    display_selection.as_ref().and_then(|display_selection| {
                        live_observations.as_mut().map(|scheduler| {
                            scheduler.observe(
                                &backend,
                                display_selection,
                                stats.step,
                                stats.time,
                                stats.dt,
                            )
                        })
                    });
                let (preview_field, scheduler_cached_preview_fields) =
                    if let Some(publication) = observation_publication.as_mut() {
                        publication.apply_to_stats(&mut sampled_stats);
                        (
                            publication.preview_field.take(),
                            publication.cached_preview_fields.take(),
                        )
                    } else {
                        (None, None)
                    };
                let full_fields_due = heavy_payload_due && live.field_every_n == 1;
                let cached_preview_fields = if full_fields_due {
                    let capture_started = Instant::now();
                    match capture_full_active_cuda_fields(
                        &backend,
                        plan,
                        live.grid,
                        sampled_stats.step,
                        sampled_stats.time,
                        display_selection
                            .as_ref()
                            .map(|selection| selection.revision)
                            .unwrap_or(0),
                        magnetization_cache.as_deref(),
                    ) {
                        Ok(mut fields) => {
                            mark_full_fields_materialized(&mut sampled_stats, &fields);
                            if let Some(mut scheduler_fields) = scheduler_cached_preview_fields {
                                scheduler_fields.retain(|scheduled| {
                                    !fields
                                        .iter()
                                        .any(|full| full.quantity == scheduled.quantity)
                                });
                                fields.extend(scheduler_fields);
                            }
                            sampled_stats.cached_preview_wall_time_ns = sampled_stats
                                .cached_preview_wall_time_ns
                                .saturating_add(capture_started.elapsed().as_nanos() as u64);
                            Some(fields)
                        }
                        Err(error) => {
                            let source_step = sampled_stats.step;
                            mark_full_fields_materialization_error(
                                &mut sampled_stats,
                                plan,
                                source_step,
                                display_selection
                                    .as_ref()
                                    .map(|selection| selection.revision)
                                    .unwrap_or(0),
                                &error.message,
                            );
                            sampled_stats.cached_preview_wall_time_ns = sampled_stats
                                .cached_preview_wall_time_ns
                                .saturating_add(capture_started.elapsed().as_nanos() as u64);
                            None
                        }
                    }
                } else {
                    scheduler_cached_preview_fields
                };
                let action = (live.on_step)(StepUpdate {
                    coupled_checkpoint: final_frozen_checkpoint.clone(),
                    stats: sampled_stats.clone(),
                    grid: live.grid,
                    fem_mesh_generation_id: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    scalar_row_due: due_scalar_row
                        || (preview_due && preview_targets_global_scalar),
                    terminal_field_snapshot: false,
                    finished: false,
                    magnetization_carrier: None,
                });
                if preview_due {
                    last_preview_revision = Some(
                        display_selection
                            .as_ref()
                            .expect("checked preview_due")
                            .revision,
                    );
                }
                if action == StepAction::Stop {
                    cancelled = true;
                }
            }
            if cancelled {
                break;
            }
            let stage_table_stats = if artifacts.accepted_step_table_due(stats.step) {
                // A stage table row always uses a full artifact snapshot, even
                // when a narrower OutputIR row is due at the same accepted state.
                // Keep this separate from control and live/current statistics.
                let mut table_stats = backend.snapshot_step_stats_with_policy(
                    plan.grid.cells,
                    NativeStatsPolicy::full(1),
                )?;
                ensure_single_object_scalars(&mut table_stats, "free");
                if magnetization_cache.is_none() {
                    magnetization_cache = Some(backend.copy_m(cell_count)?);
                }
                let magnetization = magnetization_cache
                    .as_deref()
                    .expect("table snapshot magnetization cache initialized");
                apply_average_m_to_step_stats_with_active_mask(
                    &mut table_stats,
                    magnetization,
                    plan.active_mask.as_deref(),
                    plan.material.ms_field.as_deref(),
                );
                apply_regional_drive_energy(plan, &mut table_stats, magnetization);
                Some(table_stats)
            } else {
                None
            };
            record_cuda_due_outputs(
                &backend,
                plan,
                cell_count,
                &sampled_stats,
                magnetization_cache.as_deref(),
                stage_table_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut field_capture_ledger,
                &mut artifacts,
            )?;
            let energy_plateau_range = if native_relaxation_control && !due_scalar_row {
                energy_plateau.range()
            } else {
                energy_plateau.record(stats.e_total)
            };
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }
    }

    let has_accepted_step_table = artifacts.has_accepted_step_table();
    if latest_stats.is_some()
        && should_refresh_cuda_terminal_stats(
            observation_policy.native.quantity_mask,
            has_accepted_step_table,
            direct_minimizer_control(plan.relaxation.as_ref()).is_some(),
        )
    {
        let mut final_stats = if has_accepted_step_table
            || observation_policy.native.mode == NativeStatsMode::Control
        {
            backend.snapshot_step_stats_with_policy(plan.grid.cells, NativeStatsPolicy::full(1))?
        } else {
            backend.snapshot_step_stats(plan.grid.cells)?
        };
        ensure_single_object_scalars(&mut final_stats, "free");
        latest_stats = Some(final_stats.clone());
    }

    let final_magnetization = backend.copy_m(cell_count)?;
    if let Some(final_stats) = latest_stats.as_mut() {
        apply_average_m_to_step_stats_with_active_mask(
            final_stats,
            &final_magnetization,
            plan.active_mask.as_deref(),
            plan.material.ms_field.as_deref(),
        );
        apply_regional_drive_energy(plan, final_stats, &final_magnetization);
    }
    let accepted_state_snapshot = if plan.spin_transport_plans.is_empty()
        && plan.fdm_gpu_charge_transports.is_empty()
        && plan.frozen_spins.is_none()
        && plan.temperature.unwrap_or(0.0) <= 0.0
        && plan.thermal_seed_config.is_none()
    {
        let stats = latest_stats.as_ref().ok_or_else(|| RunError {
            message: "completed CUDA FDM run has no accepted terminal clock".to_string(),
        })?;
        Some(
            FdmGpuAcceptedStateSnapshotV1::from_final_magnetization(
                ObservationClock {
                    accepted_step: stats.step,
                    time_seconds: stats.time,
                    dt_seconds: (stats.dt > 0.0).then_some(stats.dt),
                },
                &final_magnetization,
            )
            .map_err(|error| RunError {
                message: format!("materializing FDM GPU accepted state snapshot: {error}"),
            })?,
        )
    } else {
        None
    };

    record_cuda_final_outputs(
        &backend,
        plan,
        cell_count,
        latest_stats.clone(),
        &scalar_schedules,
        &field_schedules,
        &mut steps,
        &mut field_capture_ledger,
        &mut artifacts,
    )?;

    final_frozen_checkpoint = frozen_spins_checkpoint_value(
        plan,
        frozen_spins_state.as_ref(),
        &final_magnetization,
        latest_stats.as_ref().map_or(0, |stats| stats.step),
        latest_stats.as_ref().map_or(0.0, |stats| stats.time),
        latest_stats.as_ref().map_or(0.0, |stats| stats.dt),
    )?;
    let terminal_capture = latest_stats
        .clone()
        .unwrap_or_else(|| current_stats.clone());
    let mut terminal_stats = terminal_capture;
    if let Some(scheduler) = live_observations.as_mut() {
        let terminal_display_state = live
            .as_ref()
            .and_then(|consumer| consumer.display_selection.map(|get| get()))
            .unwrap_or_default();
        let mut publication = scheduler.finish(
            &backend,
            &terminal_display_state,
            terminal_stats.step,
            terminal_stats.time,
            terminal_stats.dt,
        );
        publication.apply_to_stats(&mut terminal_stats);
        // Terminal accepted-field fragments are a durable observation stream.
        // The bounded display scheduler remains useful for its status updates,
        // but its sampled fields are not mixed into that stream.
        drop(publication.preview_field.take());
        drop(publication.cached_preview_fields.take());
        if latest_stats.is_some() {
            latest_stats = Some(terminal_stats.clone());
        }
    }
    if let Some(live) = live.as_mut() {
        let config_revision = live
            .display_selection
            .map(|get| get())
            .map(|selection| selection.revision)
            .unwrap_or(0);
        let quantities = field_materialization_quantity_ids();
        let quantities = active_fdm_preview_quantities(
            crate::dispatch::FdmEngine::CudaFdm,
            plan,
            &quantities,
        );
        for quantity in &quantities {
            terminal_stats
                .field_materialization_states
                .retain(|status| status.quantity != *quantity);
            terminal_stats.field_materialization_states.push(
                LiveFieldMaterializationStatus {
                    quantity: (*quantity).to_string(),
                    source_step: terminal_stats.step,
                    request_revision: config_revision,
                    state: LiveFieldMaterializationState::Pending,
                    error: None,
                },
            );
        }
        let terminal_magnetization = flatten_vectors(&final_magnetization);
        for quantity in &quantities {
            let capture_started = Instant::now();
            let cached_preview_fields = match capture_one_active_cuda_field(
                &backend,
                plan,
                live.grid,
                terminal_stats.step,
                terminal_stats.time,
                config_revision,
                &final_magnetization,
                quantity,
            ) {
                Ok(field) => {
                    mark_full_fields_materialized(
                        &mut terminal_stats,
                        std::slice::from_ref(&field),
                    );
                    Some(vec![field])
                }
                Err(error) => {
                    eprintln!(
                        "[fullmag-runner] CUDA FDM terminal observation quantity {}: {}",
                        quantity, error.message
                    );
                    let source_step = terminal_stats.step;
                    mark_field_materialization_error(
                        &mut terminal_stats,
                        quantity,
                        source_step,
                        config_revision,
                        &error.message,
                    );
                    None
                }
            };
            let capture_wall_time_ns = capture_started.elapsed().as_nanos() as u64;
            let field_copy_bytes = cached_preview_fields
                .as_ref()
                .and_then(|fields| fields.first())
                .map_or(0, |field| (field.vector_field_values.len() as u64).saturating_mul(8));
            let magnetization_bytes = (terminal_magnetization.len() as u64).saturating_mul(8);
            terminal_stats.field_copy_bytes = terminal_stats
                .field_copy_bytes
                .saturating_add(magnetization_bytes)
                .saturating_add(field_copy_bytes);
            terminal_stats.field_copy_wall_time_ns = terminal_stats
                .field_copy_wall_time_ns
                .saturating_add(capture_wall_time_ns);
            terminal_stats.cached_preview_wall_time_ns = terminal_stats
                .cached_preview_wall_time_ns
                .saturating_add(capture_wall_time_ns);

            let action = (live.on_step)(StepUpdate {
                coupled_checkpoint: final_frozen_checkpoint.clone(),
                stats: terminal_stats.clone(),
                grid: live.grid,
                fem_mesh_generation_id: None,
                magnetization: Some(terminal_magnetization.clone()),
                preview_field: None,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                terminal_field_snapshot: true,
                finished: false,
                magnetization_carrier: None,
            });
            if action == StepAction::Stop {
                cancelled = true;
            }
        }
        if latest_stats.is_some() {
            latest_stats = Some(terminal_stats);
        }
    }
    if let Some(session) = gpu_transport.as_mut() {
        backend.unbind_gpu_transport()?;
        session.close().map_err(|error| RunError {
            message: format!("closing public GPU M1 transport session failed: {error}"),
        })?;
    }
    let endpoint = backend.endpoint_cache_telemetry()?;
    provenance.fdm_gpu_endpoint_cache_telemetry = Some(FdmGpuEndpointCacheTelemetry {
        cache_identity_valid: endpoint.cache_identity_valid,
        stats_valid: endpoint.stats_valid,
        accepted_state_revision: endpoint.accepted_state_revision,
        valid_field_mask: endpoint.valid_field_mask,
        refresh_request_count: endpoint.refresh_request_count,
        refresh_execution_count: endpoint.refresh_execution_count,
        refresh_cache_hit_count: endpoint.refresh_cache_hit_count,
        invalidation_count: endpoint.invalidation_count,
        stats_snapshot_request_count: endpoint.stats_snapshot_request_count,
        stats_snapshot_cache_hit_count: endpoint.stats_snapshot_cache_hit_count,
        field_snapshot_request_count: endpoint.field_snapshot_request_count,
        field_snapshot_latency_total_ns: endpoint.field_snapshot_latency_total_ns,
        field_snapshot_latency_max_ns: endpoint.field_snapshot_latency_max_ns,
        exchange_evaluation_count: endpoint.exchange_evaluation_count,
        demag_evaluation_count: endpoint.demag_evaluation_count,
        demag_forward_fft_count: endpoint.demag_forward_fft_count,
        demag_inverse_fft_count: endpoint.demag_inverse_fft_count,
        effective_field_evaluation_count: endpoint.effective_field_evaluation_count,
        energy_reduction_count: endpoint.energy_reduction_count,
        last_step_exchange_evaluation_count: endpoint.last_step_exchange_evaluation_count,
        last_step_demag_evaluation_count: endpoint.last_step_demag_evaluation_count,
        last_step_demag_forward_fft_count: endpoint.last_step_demag_forward_fft_count,
        last_step_demag_inverse_fft_count: endpoint.last_step_demag_inverse_fft_count,
        last_step_effective_field_evaluation_count: endpoint
            .last_step_effective_field_evaluation_count,
        last_step_energy_reduction_count: endpoint.last_step_energy_reduction_count,
    });
    receipt_lifecycle.finalize_after_outcome(
        &backend,
        &mut provenance,
        Some(&mut artifacts),
        Ok(()),
    )?;
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::resolve_stage_completion(
        status,
        plan.relaxation.as_ref(),
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: latest_stats.as_ref().map(|stats| stats.max_torque_Apm),
            torque_confirmed: torque_confirmation.confirmed() || direct_minimizer_torque_confirmed,
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: latest_stats.as_ref().map_or(0, |stats| stats.step),
            relaxation_time_s: latest_stats.as_ref().map(|stats| stats.time),
            numerical_stagnation,
        },
    );

    let mut auxiliary_artifacts: Vec<_> = final_frozen_checkpoint
        .map(|checkpoint| {
            serde_json::to_vec_pretty(&checkpoint)
                .map(|bytes| crate::types::AuxiliaryArtifact {
                    relative_path: "constraints/frozen_spins_checkpoint.v1.json".to_string(),
                    bytes,
                })
                .map_err(|error| RunError {
                    message: format!("serializing CUDA Frozen Spins checkpoint artifact: {error}"),
                })
        })
        .transpose()?
        .into_iter()
        .collect();
    if let Some(snapshot) = accepted_state_snapshot {
        auxiliary_artifacts.push(crate::types::AuxiliaryArtifact {
            relative_path: FDM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE.to_string(),
            bytes: serde_json::to_vec_pretty(&snapshot).map_err(|error| RunError {
                message: format!("serializing FDM GPU accepted state snapshot: {error}"),
            })?,
        });
    }

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization,
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts,
        provenance,
    })
}

#[cfg(not(feature = "cuda"))]
pub(crate) fn execute_cuda_fdm(
    _requested_backend: fullmag_ir::BackendTarget,
    _requested_device: &str,
    _execution_mode: fullmag_ir::ExecutionMode,
    _plan: &FdmPlanIR,
    _until_seconds: f64,
    _outputs: &[OutputIR],
    _live: Option<LiveStepConsumer<'_>>,
    _artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    Err(RunError {
        message:
            "CUDA FDM backend requested but fullmag-runner was built without the 'cuda' feature"
                .to_string(),
    })
}

#[cfg(all(test, feature = "cuda"))]
mod adaptive_batch_tests {
    use super::{
        adaptive_batch_target, cap_cuda_target_to_drive_event, cuda_drive_event_schedule,
        execute_cuda_fdm, record_cuda_initial_scalar, resolve_observation_policy, OutputSchedule,
    };
    use crate::artifact_pipeline::ArtifactRecorder;
    use crate::fdm::gpu::cuda::native::NativeStatsMode;
    use crate::fdm::gpu::cuda::{canonical_fdm_time, canonical_fdm_waveform_time};
    use crate::types::{ExecutionProvenance, StepStats};
    use fullmag_ir::{
        AdaptiveTimeStepIR, AdaptiveToleranceModeIR, BackendTarget, ExchangeBoundaryCondition,
        ExecutionMode, ExecutionPrecision, FdmMaterialIR, FdmPlanIR, FieldDriveKindIR,
        FieldSpatialProfileIR, FieldTargetIR, FieldTimeOriginIR, GridDimensions, IntegratorChoice,
        OutputIR, RegionalFieldDriveIR, ResolvedSolvedAntennaDriveBasisIR, SolvedAntennaDriveIR,
        StudyKindIR, TimeDependenceIR,
    };

    #[test]
    fn live_stop_before_first_cuda_step_retains_initial_state_without_event() {
        let initial = StepStats {
            step: 0,
            time: 0.0,
            dt: 0.0,
            e_total: 0.75,
            ..StepStats::default()
        };
        let mut latest_accepted = None;
        let mut cancelled = false;
        let mut accepted_step_events = 0;
        let action = crate::types::StepAction::Stop;

        loop {
            if action == crate::types::StepAction::Stop {
                super::mark_cuda_cancelled_preserving_accepted(
                    &mut latest_accepted,
                    &initial,
                    &mut cancelled,
                );
                break;
            }
            accepted_step_events += 1;
        }

        assert!(cancelled, "Stop before stepping must remain cancellation");
        assert_eq!(accepted_step_events, 0);
        let retained = latest_accepted.expect("initial backend snapshot remains accepted");
        assert_eq!(retained.step, 0);
        assert_eq!(retained.time, 0.0);
        assert_eq!(retained.e_total, 0.75);

        let source = include_str!("execute.rs");
        let pre_step_stop = source
            .split("if action == StepAction::Stop {")
            .nth(1)
            .expect("live Stop branch before the first native step")
            .split("break;")
            .next()
            .expect("Stop branch terminator");
        assert!(pre_step_stop.contains("mark_cuda_cancelled_preserving_accepted"));
    }

    #[test]
    fn interrupted_first_cuda_step_cancels_once_and_preserves_initial_accepted_clock() {
        let initial = StepStats {
            step: 0,
            time: 0.0,
            dt: 0.0,
            e_total: 1.25,
            ..StepStats::default()
        };
        let mut latest_accepted = None;
        let mut cancelled = false;
        let mut native_step_calls = 0;
        let mut accepted_step_events = 0;

        loop {
            native_step_calls += 1;
            let native_result: Option<StepStats> = None;
            let Some(_accepted) = super::resolve_interruptible_cuda_step(
                native_result,
                &mut latest_accepted,
                &initial,
                &mut cancelled,
            ) else {
                break;
            };
            accepted_step_events += 1;
        }

        assert_eq!(
            native_step_calls, 1,
            "an interrupted step must not be retried"
        );
        assert_eq!(
            accepted_step_events, 0,
            "interruption is not an accepted event"
        );
        assert!(cancelled, "native interruption must become cancellation");
        let retained = latest_accepted.expect("initial state remains accepted");
        assert_eq!(retained.step, 0);
        assert_eq!(retained.time, 0.0);
        assert_eq!(retained.e_total, 1.25);
    }

    #[test]
    fn interrupted_cuda_step_keeps_the_previous_accepted_state_and_exits_loop() {
        let accepted = StepStats {
            step: 9,
            time: 9.0e-15,
            e_total: 2.5,
            ..StepStats::default()
        };
        let mut latest_accepted = Some(accepted.clone());
        let mut cancelled = false;
        let mut native_step_calls = 0;
        let mut accepted_step_events = 1;

        loop {
            native_step_calls += 1;
            let native_result: Option<StepStats> = None;
            let Some(_accepted) = super::resolve_interruptible_cuda_step(
                native_result,
                &mut latest_accepted,
                &accepted,
                &mut cancelled,
            ) else {
                break;
            };
            accepted_step_events += 1;
        }

        assert_eq!(
            native_step_calls, 1,
            "an interrupted step must not be retried"
        );
        assert_eq!(
            accepted_step_events, 1,
            "interruption adds no accepted event"
        );
        assert!(cancelled, "native interruption must become cancellation");
        let retained = latest_accepted.expect("previous accepted state remains available");
        assert_eq!(retained.step, 9);
        assert_eq!(retained.time, 9.0e-15);
        assert_eq!(retained.e_total, 2.5);
    }

    #[test]
    fn interrupted_cuda_step_path_reaches_shared_cancelled_finalization() {
        let source = include_str!("execute.rs");
        let branch = source
            .split("let Some(mut stats) = resolve_interruptible_cuda_step(")
            .nth(1)
            .expect("single-step interruption branch")
            .split("};")
            .next()
            .expect("interruption branch terminator");
        assert!(branch.contains("break;"));
        assert!(!branch.contains("continue;"));
        assert!(!branch.contains("steps.push("));
        assert!(!branch.contains("record_cuda_due_outputs("));
        assert!(source.contains("record_cuda_final_outputs("));
        assert!(source.contains(
            "let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();"
        ));
        assert!(source.contains("RunStatus::Cancelled"));
        assert!(
            source.contains("step_adaptive_batch_interruptible(dt, target_time, max_steps, None)?")
        );
        let batch_eligibility = source
            .split("fn adaptive_batch_execution_eligible(")
            .nth(1)
            .expect("batch-eligibility gate");
        assert!(batch_eligibility.contains("plan.relaxation.is_none()"));
        assert!(batch_eligibility.contains("&& !live"));
        let runner = include_str!("../../../lib.rs");
        assert!(runner.contains("None => artifact_pipeline.finish()"));
        assert!(runner.contains("artifacts::write_artifacts("));
    }

    fn schedule(next_time: f64) -> OutputSchedule {
        OutputSchedule {
            name: "E_total".to_string(),
            every_seconds: 2.0e-12,
            next_time,
            last_sampled_time: None,
        }
    }

    #[test]
    fn terminal_native_refresh_preserves_direct_minimizer_accepted_clock() {
        let accepted = StepStats {
            step: 271,
            time: 0.0,
            dt: 0.0,
            e_total: 2.5e-19,
            ..StepStats::default()
        };
        let native_llg_snapshot = StepStats {
            step: 0,
            time: 0.0,
            dt: 0.0,
            e_total: 0.0,
            ..StepStats::default()
        };

        assert!(should_refresh_cuda_terminal_stats(1, false, false));
        assert!(should_refresh_cuda_terminal_stats(0, true, false));
        assert!(!should_refresh_cuda_terminal_stats(1, true, true));
        let terminal = if should_refresh_cuda_terminal_stats(1, true, true) {
            native_llg_snapshot
        } else {
            accepted
        };
        assert_eq!(terminal.step, 271);
        assert_eq!(terminal.time, 0.0);
        assert_eq!(terminal.dt, 0.0);
        assert_eq!(terminal.e_total, 2.5e-19);
    }

    #[test]
    fn accepted_step_autosave_cadence_disables_batching_but_time_only_streams_do_not() {
        let plan = FdmPlanIR {
            adaptive_timestep: Some(AdaptiveTimeStepIR {
                tolerance_mode: AdaptiveToleranceModeIR::MaxError,
                atol: 1.0e-8,
                rtol: 0.0,
                dt_initial: Some(1.0e-15),
                dt_min: 1.0e-17,
                dt_max: Some(1.0e-14),
                safety: 0.9,
                growth_limit: 2.0,
                shrink_limit: 0.25,
                max_spin_rotation: None,
                norm_tolerance: None,
            }),
            ..FdmPlanIR::default()
        };

        assert!(adaptive_batch_execution_eligible(&plan, false, false));
        assert!(
            !adaptive_batch_execution_eligible(&plan, false, true),
            "accepted-step table or field autosaves require an exact accepted state"
        );
    }

    // A stale due event still forces a bounded observation step. The stage-origin
    // scalar event is consumed before entering this batching helper below.
    #[test]
    fn due_output_forces_one_accepted_step_before_observation() {
        let (target, max_steps) =
            adaptive_batch_target(0.0, 2.0e-15, 1.0e-11, &[schedule(0.0)], &[]);

        assert_eq!(target, 2.0e-15);
        assert_eq!(max_steps, 1);
    }

    #[test]
    fn initial_scalar_consumes_t0_schedule_before_adaptive_batching() {
        let initial = StepStats {
            step: 0,
            time: 0.0,
            mx: 0.25,
            my: 0.5,
            mz: 0.75,
            e_total: 4.0e-19,
            ..StepStats::default()
        };
        let mut scalar = [schedule(0.0)];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance::default());

        record_cuda_initial_scalar(
            &initial,
            false,
            &mut scalar,
            &mut steps,
            &mut artifacts,
        )
        .expect("record the due initial scalar row");

        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].step, 0);
        assert_eq!(steps[0].time, 0.0);
        assert_eq!(steps[0].mx, 0.25);
        assert_eq!(steps[0].e_total, 4.0e-19);
        assert_eq!(scalar[0].next_time, scalar[0].every_seconds);

        let (target, max_steps) =
            adaptive_batch_target(0.0, 2.0e-15, 1.0e-11, &scalar, &[]);
        assert_eq!(target, scalar[0].every_seconds);
        assert_eq!(max_steps, 64);
    }

    #[test]
    fn empty_output_list_records_only_the_existing_default_initial_scalar() {
        let initial = StepStats {
            step: 0,
            time: 0.0,
            e_total: 4.0e-19,
            ..StepStats::default()
        };
        let mut scalar: Vec<OutputSchedule> = Vec::new();
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance::default());

        record_cuda_initial_scalar(
            &initial,
            true,
            &mut scalar,
            &mut steps,
            &mut artifacts,
        )
        .expect("record default scalar trace at stage origin");

        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].step, 0);
        assert_eq!(steps[0].time, 0.0);
        assert_eq!(steps[0].e_total, 4.0e-19);
    }

    #[test]
    fn batch_stops_at_earliest_future_output_boundary() {
        let scalar = schedule(8.0e-12);
        let field = schedule(5.0e-12);
        let (target, max_steps) =
            adaptive_batch_target(2.0e-12, 2.0e-15, 1.0e-11, &[scalar], &[field]);

        assert_eq!(target, 5.0e-12);
        assert_eq!(max_steps, 64);
    }

    #[test]
    fn batch_without_outputs_targets_stage_end() {
        let (target, max_steps) = adaptive_batch_target(2.0e-12, 2.0e-15, 1.0e-11, &[], &[]);

        assert_eq!(target, 1.0e-11);
        assert_eq!(max_steps, 64);
    }

    #[test]
    fn native_cuda_stage_clock_maps_to_the_canonical_waveform_clock() {
        let mut plan = FdmPlanIR::default();
        plan.time_stage.start_time_s = 10.0;

        assert_eq!(canonical_fdm_time(&plan, 0.25), 10.25);
        assert_eq!(
            canonical_fdm_waveform_time(
                &plan,
                fullmag_ir::FieldTimeOriginIR::StageLocal,
                0.25,
            ),
            0.25
        );
        assert_eq!(
            canonical_fdm_waveform_time(
                &plan,
                fullmag_ir::FieldTimeOriginIR::Absolute,
                0.25,
            ),
            10.25
        );
    }

    #[test]
    fn cuda_drive_event_schedule_includes_regional_and_solved_antenna_edges() {
        let mut plan = FdmPlanIR::default();
        plan.time_stage.start_time_s = 10.0;
        plan.time_stage.study_kind = StudyKindIR::TimeEvolution;
        plan.field_drives = vec![RegionalFieldDriveIR {
            id: "regional".into(),
            name: "Regional".into(),
            kind: FieldDriveKindIR::Regional,
            enabled: true,
            target: FieldTargetIR::Global {},
            amplitude_b_t: 1.0e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: FieldSpatialProfileIR::Uniform {},
            waveform: TimeDependenceIR::Pulse {
                t_on: 1.0,
                t_off: 2.0,
            },
            time_origin: FieldTimeOriginIR::StageLocal,
            activation: fullmag_ir::DriveActivationIR::AllTimeEvolution {},
            migration: None,
        }];
        plan.solved_antenna_drive_bases = vec![ResolvedSolvedAntennaDriveBasisIR {
            drive: SolvedAntennaDriveIR {
                id: "solved".into(),
                name: "Solved".into(),
                projection_ref: "projection".into(),
                port_mode_id: "mode".into(),
                peak_current_a: 1.0,
                waveform: TimeDependenceIR::Pulse {
                    t_on: 12.0,
                    t_off: 13.0,
                },
                bandwidth_declaration: None,
                time_origin: FieldTimeOriginIR::Absolute,
                activation: fullmag_ir::DriveActivationIR::AllTimeEvolution {},
            },
            solution_id: "solution".into(),
            source_object_id: "antenna".into(),
            field_xyz_apm_per_a: vec![[0.0, 1.0, 0.0]],
            projection_signature: "signature".into(),
        }];

        assert_eq!(
            cuda_drive_event_schedule(&plan, 5.0),
            vec![10.0, 11.0, 12.0, 13.0, 15.0]
        );
        assert_eq!(
            cap_cuda_target_to_drive_event(&plan, 0.0, 5.0, &cuda_drive_event_schedule(&plan, 5.0)),
            1.0
        );
        plan.time_stage.start_time_s = 10.5;
        plan.time_stage.waveform_origin_time_s = Some(10.0);
        assert_eq!(
            cuda_drive_event_schedule(&plan, 4.5),
            vec![10.5, 11.0, 12.0, 13.0, 15.0]
        );
        assert_eq!(
            canonical_fdm_waveform_time(&plan, FieldTimeOriginIR::StageLocal, 0.25),
            0.75
        );
    }

    #[test]
    fn scalar_output_resolves_requested_mask_and_fixed_step_stride() {
        let mut plan = FdmPlanIR::default();
        plan.fixed_timestep = Some(1.0e-15);
        let outputs = vec![OutputIR::Scalar {
            name: "E_demag".to_string(),
            every_seconds: 5.0e-15,
        }];

        let resolved = resolve_observation_policy(&plan, &outputs, false);

        assert_eq!(resolved.native.mode, NativeStatsMode::Requested);
        assert_eq!(
            resolved.native.quantity_mask,
            fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_DEMAG
        );
        assert_eq!(resolved.native.stride, 5);
        assert_eq!(resolved.requested_quantity_ids, vec!["E_demag".to_string()]);
    }

    #[test]
    fn magnetization_only_output_avoids_native_scalar_reductions() {
        let plan = FdmPlanIR::default();
        let outputs = vec![OutputIR::Scalar {
            name: "mz".to_string(),
            every_seconds: 5.0e-15,
        }];

        let resolved = resolve_observation_policy(&plan, &outputs, false);

        assert_eq!(resolved.native.mode, NativeStatsMode::None);
        assert_eq!(resolved.native.quantity_mask, 0);
    }

    #[test]
    fn interactive_execution_resolves_all_on_demand_scalar_quantities() {
        let plan = FdmPlanIR::default();

        let resolved = resolve_observation_policy(&plan, &[], true);

        assert_eq!(resolved.native.mode, NativeStatsMode::Requested);
        assert_eq!(
            resolved.native.quantity_mask,
            fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_ALL
        );
    }

    #[test]
    fn adaptive_relaxation_requires_measured_torque_between_sparse_outputs() {
        let mut plan = FdmPlanIR::default();
        plan.integrator = Some(IntegratorChoice::Rk23);
        plan.fixed_timestep = Some(1.0e-15);
        plan.adaptive_timestep = None;
        plan.relaxation = Some(fullmag_ir::RelaxationControlIR {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(0.795774715459),
                energy_tolerance_j: None,
                max_steps: Some(200_000),
                max_relaxation_time_s: Some(2.0e-9),
            },
        });
        let outputs = vec![OutputIR::Scalar {
            name: "E_total".to_string(),
            every_seconds: 1.0e-9,
        }];

        let fixed = resolve_observation_policy(&plan, &outputs, false);
        assert_eq!(fixed.native.mode, NativeStatsMode::Control);
        assert_eq!(fixed.native.stride, 1);

        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            tolerance_mode: AdaptiveToleranceModeIR::MaxError,
            atol: 1.0e-7,
            rtol: 0.0,
            dt_initial: Some(1.0e-15),
            dt_min: 1.0e-17,
            dt_max: Some(1.0e-14),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        });
        let adaptive = resolve_observation_policy(&plan, &outputs, false);
        assert_eq!(adaptive.native.mode, NativeStatsMode::Full);
        assert_eq!(adaptive.native.stride, 1);
        assert_eq!(
            adaptive.native.quantity_mask,
            fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_ALL
        );
    }

    #[test]
    fn headless_adaptive_runner_batches_between_output_boundaries() {
        if !super::super::native::is_cuda_available() {
            eprintln!("skipping CUDA adaptive runner batch contract: native CUDA unavailable");
            return;
        }
        let mut plan = FdmPlanIR::default();
        plan.grid = GridDimensions { cells: [1, 1, 1] };
        plan.cell_size = [5.0e-9; 3];
        plan.region_mask = vec![0];
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]];
        plan.material = FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 8.0e5,
            exchange_stiffness: 13.0e-12,
            damping: 0.1,
            ..Default::default()
        };
        plan.gyromagnetic_ratio = 2.211e5;
        plan.precision = ExecutionPrecision::Double;
        plan.exchange_bc = ExchangeBoundaryCondition::Neumann;
        plan.integrator = Some(IntegratorChoice::Rk23);
        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            tolerance_mode: AdaptiveToleranceModeIR::MaxError,
            atol: 1.0e-6,
            rtol: 0.0,
            dt_initial: Some(1.0e-15),
            dt_min: 1.0e-16,
            dt_max: Some(2.0e-15),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        });
        plan.enable_exchange = false;
        plan.enable_demag = false;
        plan.external_field = Some([0.0, 0.0, 8.0e5]);
        plan.relaxation = None;
        let outputs = vec![
            OutputIR::Scalar {
                name: "E_total".to_string(),
                every_seconds: 5.0e-15,
            },
            OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 5.0e-15,
            },
        ];

        let executed = execute_cuda_fdm(
            BackendTarget::Fdm,
            "gpu",
            ExecutionMode::Strict,
            &plan,
            2.0e-14,
            &outputs,
            None,
            None,
        )
        .expect("headless adaptive CUDA execution must complete");

        let final_step = executed
            .result
            .steps
            .last()
            .expect("scheduled scalar observations must be published");
        assert!((final_step.time - 2.0e-14).abs() <= 1.0e-18);
        assert!(final_step.e_total.is_finite());
        assert!(final_step.max_h_eff.is_finite());
        assert_eq!(executed.field_snapshot_count, 5);
        let adaptive = executed
            .provenance
            .fdm_gpu_execution_receipt
            .as_ref()
            .and_then(|receipt| receipt.adaptive_execution.as_ref())
            .expect("adaptive execution telemetry must be published");
        assert_eq!(adaptive.realization, "cuda_conditional_graph_batched_v1");
        assert!(adaptive.accounting_valid);
        assert!(adaptive.graph_launch_count > adaptive.terminal_control_host_sync_count);
        assert_eq!(adaptive.step_completion_host_sync_count, 0);
        assert_eq!(
            adaptive.stats_none_host_sync_count,
            adaptive.terminal_control_host_sync_count
        );
        let observation = executed
            .provenance
            .fdm_gpu_observation_policy
            .as_ref()
            .expect("resolved observation policy must be published");
        assert_eq!(observation.requested_contract, "scheduled_outputs");
        assert_eq!(observation.resolved_mode, "requested");
        assert_eq!(observation.executed_mode, "requested");
        assert_eq!(
            observation.executed_quantity_mask,
            fullmag_fdm_sys::FULLMAG_FDM_STATS_QUANTITY_E_TOTAL
        );
        let endpoint = executed
            .provenance
            .fdm_gpu_endpoint_cache_telemetry
            .as_ref()
            .expect("endpoint cache telemetry must be published");
        assert!(endpoint.cache_identity_valid);
        assert!(endpoint.stats_snapshot_request_count > 0);
        assert_eq!(endpoint.demag_evaluation_count, 0);
    }
}
