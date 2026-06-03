//! CUDA FDM direct-minimizer execution loop.
//!
//! The CUDA FDM backend owns field transfer and observable refresh. This module
//! owns the runner-side direct-minimizer loop for the FDM CUDA lane so
//! `dispatch.rs` can stay focused on backend selection and finalization.

use fullmag_ir::FdmPlanIR;

use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::relaxation::direct_minimizer::{
    apply_direct_minimizer_step_metrics, direct_minimizer_gradient_degenerate,
    direct_minimizer_gradient_norm_sq, direct_minimizer_step_budget,
    nonlinear_cg_descent_direction_dot, nonlinear_cg_initial_step_size, nonlinear_cg_line_search,
    nonlinear_cg_next_direction, projected_gradient_line_search,
    projected_gradient_step_size_update, DirectMinimizerAlgorithm, DirectMinimizerControl,
    DirectMinimizerState, DirectMinimizerTrialEvaluation,
};
use crate::relaxation::vector_math::{max_torque_from_field, tangent_gradient_from_field};
use crate::relaxation::{relaxation_stop_criteria_satisfied, RelaxationEnergyPlateauWindow};
use crate::scalar_metrics::single_object_scalars;
use crate::types::{LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

pub(crate) struct CudaDirectMinimizerOutcome {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) cancelled: bool,
}

fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values.iter().flat_map(|v| v.iter().copied()).collect()
}

fn ensure_single_object_scalars(stats: &mut StepStats, object_id: &str) {
    if stats.per_object_scalars.is_empty() {
        stats.per_object_scalars = single_object_scalars(object_id, stats);
    }
}

pub(crate) fn execute_direct_minimizer(
    backend: &mut NativeFdmBackend,
    plan: &FdmPlanIR,
    cell_count: usize,
    direct_minimizer: DirectMinimizerControl<'_>,
    mut current_stats: StepStats,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: &mut ArtifactRecorder,
    steps: &mut Vec<StepStats>,
    energy_plateau: &mut RelaxationEnergyPlateauWindow,
    mut last_preview_revision: Option<u64>,
) -> Result<CudaDirectMinimizerOutcome, RunError> {
    let control = direct_minimizer.control;
    let mut latest_stats = Some(current_stats.clone());
    let mut cancelled = false;
    let mut state = DirectMinimizerState::new(
        backend.copy_m(cell_count)?,
        backend.copy_h_eff(cell_count)?,
        current_stats.e_total,
    );

    while state.accepted_steps < direct_minimizer_step_budget(control) {
        if let Some(live) = live.as_mut() {
            if let Some(display_selection) = live.display_selection.map(|get| get()) {
                let preview_due = display_refresh_due(
                    last_preview_revision,
                    &display_selection,
                    current_stats.step,
                );
                let preview_targets_global_scalar = display_is_global_scalar(&display_selection);
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let request = display_selection.preview_request();
                    Some(backend.copy_live_preview_field(
                        &request,
                        plan.grid.cells,
                        plan.active_mask.as_deref(),
                    )?)
                } else {
                    None
                };
                let action = (live.on_step)(StepUpdate {
                    stats: current_stats.clone(),
                    grid: live.grid,
                    fem_mesh: None,
                    magnetization: Some(flatten_vectors(&state.magnetization)),
                    preview_field,
                    cached_preview_fields: None,
                    scalar_row_due: preview_due && preview_targets_global_scalar,
                    finished: false,
                });
                if preview_due {
                    last_preview_revision = Some(display_selection.revision);
                }
                if action == StepAction::Stop {
                    cancelled = true;
                    break;
                }
            }
        }
        if cancelled {
            break;
        }

        let max_torque = max_torque_from_field(&state.magnetization, &state.h_eff);
        if relaxation_stop_criteria_satisfied(control, None, max_torque) {
            break;
        }
        let g_norm_sq = direct_minimizer_gradient_norm_sq(&state.gradient);
        if direct_minimizer_gradient_degenerate(g_norm_sq) {
            break;
        }

        let mut trial_lambda = state.step_size;
        let (trial_stats, m_trial) = match direct_minimizer.algorithm {
            DirectMinimizerAlgorithm::ProjectedGradientBb => {
                let accepted_trial = projected_gradient_line_search(
                    state.energy_j,
                    g_norm_sq,
                    &state.magnetization,
                    &state.gradient,
                    trial_lambda,
                    |trial| {
                        backend.upload_magnetization(trial)?;
                        backend.refresh_observables()?;
                        let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                        ensure_single_object_scalars(&mut stats, "free");
                        Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                            energy_j: stats.e_total,
                            stats,
                        })
                    },
                )?;
                trial_lambda = accepted_trial.step_size;
                let trial_stats = accepted_trial.stats;
                let m_trial = accepted_trial.magnetization;

                let h_eff_new = backend.copy_h_eff(cell_count)?;
                let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);

                let step_size_update = projected_gradient_step_size_update(
                    &state.magnetization,
                    &m_trial,
                    &state.gradient,
                    &g_new,
                    state.use_bb1,
                    state.reset_consecutive,
                );
                state.step_size = step_size_update.step_size;
                state.use_bb1 = step_size_update.use_bb1;
                state.reset_consecutive = step_size_update.reset_consecutive;

                state.h_eff = h_eff_new;
                state.gradient = g_new;
                (trial_stats, m_trial)
            }
            DirectMinimizerAlgorithm::NonlinearCg => {
                let p_dot_g = nonlinear_cg_descent_direction_dot(
                    &mut state.search_direction,
                    &state.gradient,
                );
                trial_lambda = nonlinear_cg_initial_step_size(&state.search_direction);

                let accepted_trial = nonlinear_cg_line_search(
                    state.energy_j,
                    p_dot_g,
                    &state.magnetization,
                    &state.search_direction,
                    trial_lambda,
                    |trial| {
                        backend.upload_magnetization(trial)?;
                        backend.refresh_observables()?;
                        let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                        ensure_single_object_scalars(&mut stats, "free");
                        Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                            energy_j: stats.e_total,
                            stats,
                        })
                    },
                )?;
                trial_lambda = accepted_trial.step_size;
                let trial_stats = accepted_trial.stats;
                let m_trial = accepted_trial.magnetization;

                let h_eff_new = backend.copy_h_eff(cell_count)?;
                let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);
                state.search_direction = nonlinear_cg_next_direction(
                    &m_trial,
                    &state.gradient,
                    &g_new,
                    &state.search_direction,
                    g_norm_sq,
                    state.accepted_steps + 1,
                );
                state.h_eff = h_eff_new;
                state.gradient = g_new;
                state.step_size = trial_lambda;
                (trial_stats, m_trial)
            }
        };

        state.magnetization = m_trial;
        state.energy_j = trial_stats.e_total;
        state.accepted_steps += 1;

        let mut accepted_stats = trial_stats.clone();
        let torque_apm = apply_direct_minimizer_step_metrics(
            &mut accepted_stats,
            state.accepted_steps,
            trial_lambda,
            &state.magnetization,
            &state.h_eff,
        );
        ensure_single_object_scalars(&mut accepted_stats, "free");

        artifacts.record_scalar(&accepted_stats)?;
        steps.push(accepted_stats.clone());
        latest_stats = Some(accepted_stats.clone());
        current_stats = accepted_stats;

        let energy_plateau_range = energy_plateau.record(state.energy_j);
        if relaxation_stop_criteria_satisfied(control, energy_plateau_range, torque_apm) {
            break;
        }
    }

    Ok(CudaDirectMinimizerOutcome {
        latest_stats,
        cancelled,
    })
}
