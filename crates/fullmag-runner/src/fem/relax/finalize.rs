//! Native FEM relaxation finalization.
//!
//! The execution loops own stepping. This module owns the post-loop relaxation
//! closure: final stats, cached-preview flush, scheduled field snapshots,
//! provenance refresh, and stage-completion projection.

use fullmag_ir::FemPlanIR;

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::{apply_native_fem_runtime_contract, fem_poisson_demag_provenance};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::{infer_stage_completion, llg_overdamped_uses_pure_damping};
use crate::schedules::OutputSchedule;
use crate::types::{
    ExecutedRun, FieldSnapshot, LiveStepConsumer, RunError, RunResult, RunStatus, StepStats,
    StepUpdate,
};

use super::preview::build_fem_cached_preview_fields;
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
    plan: &FemPlanIR,
    node_count: usize,
    initial_magnetization: Vec<[f64; 3]>,
    mut field_schedules: Vec<OutputSchedule>,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: ArtifactRecorder,
    steps: Vec<StepStats>,
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

    // Flush a final cached-preview update so H_demag/H_eff land in preview_cache
    // regardless of whether the last loop iteration had preview_due = true.
    if let Some(live) = live.as_mut() {
        if let Some(display_selection) = live.display_selection.map(|get| get()) {
            if let Some(cached) =
                build_fem_cached_preview_fields(backend, &display_selection, plan, node_count)
            {
                let _ = (live.on_step)(StepUpdate {
                    stats: final_stats.clone(),
                    grid: live.grid,
                    fem_mesh: None,
                    magnetization: None,
                    preview_field: None,
                    cached_preview_fields: Some(cached),
                    scalar_row_due: false,
                    finished: false,
                });
            }
        }
    }

    for schedule in &mut field_schedules {
        let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        })?;
    }

    let final_magnetization = backend.copy_m(node_count)?;
    let (field_snapshots, field_snapshot_count, mut provenance) = artifacts.finish();
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
        infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
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
