//! Native FEM relaxation finalization.
//!
//! The execution loops own stepping. This module owns the post-loop relaxation
//! closure: final stats, cached-preview flush, scheduled field snapshots,
//! provenance refresh, and stage-completion projection.

use fullmag_ir::FemPlanIR;

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::{apply_native_fem_runtime_contract, fem_poisson_demag_provenance, FemEngine};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::{resolve_stage_completion, RelaxationCompletionMetrics};
use crate::schedules::OutputSchedule;
use crate::types::{
    ExecutedRun, FieldSnapshot, LiveStepConsumer, RunError, RunResult, RunStatus, StepStats,
    StepUpdate,
};

use super::preview::build_fem_final_cached_preview_fields;
use super::scalars::ensure_fem_object_scalars;
use super::snapshots::copy_native_fem_field_snapshot;

pub(crate) struct NativeFemRelaxationFinalization {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
}

pub(crate) fn finalize_native_fem_relaxation(
    backend: &mut NativeFemBackend,
    engine: FemEngine,
    plan: &FemPlanIR,
    node_count: usize,
    initial_magnetization: Vec<[f64; 3]>,
    mut field_schedules: Vec<OutputSchedule>,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: ArtifactRecorder,
    mut steps: Vec<StepStats>,
    finalization: NativeFemRelaxationFinalization,
) -> Result<ExecutedRun, RunError> {
    let mut artifacts = artifacts;
    let mut final_stats = finalization.latest_stats.unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_ani: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    ensure_fem_object_scalars(&mut final_stats, plan);
    let finalization_start = std::time::Instant::now();
    let mut finalization_field_copy_wall_time_ns = 0_u64;
    let mut finalization_field_copy_bytes = 0_u64;
    let mut diagnostic_field_snapshots = Vec::<FieldSnapshot>::new();

    // Refresh device-resident component fields at the accepted final state
    // before any synchronous or asynchronous field snapshot selects H_eff.
    // This is required for strict GPU runs without device Poisson demag too.
    let _refreshed_final_snapshot_stats = backend.snapshot_step_stats(node_count)?;

    // Flush a final cached-preview update so H_demag/H_eff land in preview_cache
    // regardless of whether the last loop iteration had preview_due = true.
    if let Some(live) = live.as_mut() {
        if let Some(display_selection) = live.display_selection.map(|get| get()) {
            let cached_start = std::time::Instant::now();
            if let Some(cached) = build_fem_final_cached_preview_fields(
                backend,
                engine,
                &display_selection,
                plan,
                node_count,
            ) {
                let cached_preview_wall_time_ns = cached_start.elapsed().as_nanos() as u64;
                let mut live_stats = final_stats.clone();
                live_stats.cached_preview_wall_time_ns = cached_preview_wall_time_ns;
                live_stats.wall_time_ns = live_stats
                    .wall_time_ns
                    .saturating_add(cached_preview_wall_time_ns);
                let _ = (live.on_step)(StepUpdate {
                    stats: live_stats,
                    grid: live.grid,
                    fem_mesh: None,
                    magnetization: None,
                    preview_field: None,
                    cached_preview_fields: Some(cached),
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    scalar_row_due: false,
                    finished: false,
                });
            }
        }
    }

    for schedule in &mut field_schedules {
        let copy_start = std::time::Instant::now();
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(
                &schedule.name,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
            )?;
            artifacts.record_native_fem_field_snapshot(snapshot)?;
            if matches!(schedule.name.as_str(), "H_demag" | "demag_phi") {
                let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
                diagnostic_field_snapshots.push(FieldSnapshot {
                    name: schedule.name.clone(),
                    step: final_stats.step,
                    time: final_stats.time,
                    solver_dt: final_stats.dt,
                    values,
                });
            }
            finalization_field_copy_wall_time_ns =
                finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
            finalization_field_copy_bytes =
                finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(node_count));
        } else {
            let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
            finalization_field_copy_wall_time_ns =
                finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
            finalization_field_copy_bytes =
                finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(values.len()));
            artifacts.record_field_snapshot(FieldSnapshot {
                name: schedule.name.clone(),
                step: final_stats.step,
                time: final_stats.time,
                solver_dt: final_stats.dt,
                values,
            })?;
        }
    }

    let copy_start = std::time::Instant::now();
    let final_magnetization = copy_native_fem_field_snapshot(backend, "m", node_count)?;
    finalization_field_copy_wall_time_ns =
        finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
    finalization_field_copy_bytes =
        finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(final_magnetization.len()));
    let (mut field_snapshots, field_snapshot_count, mut provenance) = artifacts.finish();
    field_snapshots.extend(diagnostic_field_snapshots);
    let finalization_wall_time_ns = elapsed_ns(finalization_start);
    final_stats.finalization_wall_time_ns = finalization_wall_time_ns;
    final_stats.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
    final_stats.finalization_field_copy_bytes = finalization_field_copy_bytes;
    final_stats.wall_time_ns = final_stats
        .wall_time_ns
        .saturating_add(finalization_wall_time_ns);
    if let Some(last_step) = steps.last_mut() {
        last_step.finalization_wall_time_ns = finalization_wall_time_ns;
        last_step.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
        last_step.finalization_field_copy_bytes = finalization_field_copy_bytes;
        last_step.wall_time_ns = last_step
            .wall_time_ns
            .saturating_add(finalization_wall_time_ns);
    }
    provenance.fem_poisson_demag = fem_poisson_demag_provenance(plan, Some(&final_stats));
    let gpu_state_info = backend.gpu_state_info()?;
    let gpu_rk_plan_info = backend.gpu_rk_plan_info()?;
    apply_native_fem_runtime_contract(
        &mut provenance,
        plan,
        Some(&final_stats),
        Some(&gpu_state_info),
        Some(&gpu_rk_plan_info),
    );
    let status = if finalization.paused {
        RunStatus::Paused
    } else if finalization.cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = if let Some(mut completion) = finalization.backend_completion {
        completion.status = match status {
            RunStatus::Completed => "completed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Paused => "paused",
            RunStatus::Failed => "failed",
        }
        .to_string();
        completion
    } else {
        resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: final_stats.step,
                relaxation_time_s: Some(final_stats.time),
                numerical_stagnation: false,
            },
        )
    };

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
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn elapsed_ns(start: std::time::Instant) -> u64 {
    start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
}

fn vector3_f64_bytes(len: usize) -> u64 {
    let bytes = len
        .saturating_mul(3)
        .saturating_mul(std::mem::size_of::<f64>());
    bytes.min(u64::MAX as usize) as u64
}
