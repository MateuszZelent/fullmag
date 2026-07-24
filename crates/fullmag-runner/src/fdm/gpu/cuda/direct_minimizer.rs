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
    direct_minimizer_gradient_invalid, direct_minimizer_within_runtime_budget, energy_metric_dot,
    nonlinear_cg_descent_direction_dot, nonlinear_cg_initial_step_size, nonlinear_cg_line_search,
    nonlinear_cg_next_direction, projected_gradient_line_search,
    projected_gradient_step_size_update, snapshot_trial_evaluation_counts,
    DirectMinimizerAlgorithm, DirectMinimizerControl, DirectMinimizerState,
    DirectMinimizerTrialEvaluation, NONLINEAR_CG_MAX_BACKTRACK, PROJECTED_GRADIENT_MAX_BACKTRACK,
};
use crate::relaxation::vector_math::tangent_gradient_from_field;
use crate::relaxation::{RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation};
use crate::scalar_metrics::single_object_scalars;
use crate::types::{LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

pub(crate) struct CudaDirectMinimizerOutcome {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) cancelled: bool,
    pub(crate) numerical_stagnation: bool,
}

fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values.iter().flat_map(|v| v.iter().copied()).collect()
}

fn ensure_single_object_scalars(stats: &mut StepStats, object_id: &str) {
    if stats.per_object_scalars.is_empty() {
        stats.per_object_scalars = single_object_scalars(object_id, stats);
    }
}

fn restore_previous_state_after_failed_line_search(
    backend: &mut NativeFdmBackend,
    magnetization: &[[f64; 3]],
    algorithm: &str,
    max_backtracks: u32,
) -> Result<RunError, RunError> {
    backend.upload_magnetization(magnetization)?;
    backend.refresh_observables()?;
    Ok(RunError {
        message: format!(
            "FDM CUDA {algorithm} failed Armijo line search after {max_backtracks} backtracks; previous magnetization was restored"
        ),
    })
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
    let mut numerical_stagnation = false;
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let mut state = DirectMinimizerState::new(
        backend.copy_m(cell_count)?,
        backend.copy_h_eff(cell_count)?,
        current_stats.e_total,
    );
    let ms_apm = plan
        .material
        .ms_field
        .clone()
        .unwrap_or_else(|| vec![plan.material.saturation_magnetisation; cell_count]);
    let cell_volume_m3 = plan.cell_size.iter().product::<f64>();
    let volumes_m3 = (0..cell_count)
        .map(|index| {
            if plan
                .active_mask
                .as_ref()
                .is_none_or(|mask| mask.get(index).copied().unwrap_or(false))
            {
                cell_volume_m3
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();

    while direct_minimizer_within_runtime_budget(&state, control) {
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
                    fem_mesh_generation_id: None,
                    magnetization: Some(flatten_vectors(&state.magnetization)),
                    preview_field,
                    cached_preview_fields: None,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
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

        let weighted_gradient_norm_sq =
            energy_metric_dot(&state.gradient, &state.gradient, &ms_apm, &volumes_m3);
        if direct_minimizer_gradient_invalid(weighted_gradient_norm_sq) {
            return Err(RunError {
                message: "FDM CUDA direct-minimizer gradient metric is invalid".to_string(),
            });
        }
        if direct_minimizer_gradient_degenerate(weighted_gradient_norm_sq) {
            numerical_stagnation = true;
            break;
        }

        let mut trial_lambda = state.step_size;
        let (trial_stats, m_trial, line_search_backtracks, energy_evaluations) =
            match direct_minimizer.algorithm {
                DirectMinimizerAlgorithm::ProjectedGradientBb => {
                    let direction_dot_gradient_j_per_step = -weighted_gradient_norm_sq;
                    let Some(accepted_trial) = projected_gradient_line_search(
                        state.energy_j,
                        direction_dot_gradient_j_per_step,
                        &state.magnetization,
                        &state.gradient,
                        trial_lambda,
                        |trial| {
                            backend.upload_magnetization(trial)?;
                            let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                            ensure_single_object_scalars(&mut stats, "free");
                            Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                                energy_j: stats.e_total,
                                stats,
                            })
                        },
                    )?
                    else {
                        return Err(restore_previous_state_after_failed_line_search(
                            backend,
                            &state.magnetization,
                            "projected-gradient BB",
                            PROJECTED_GRADIENT_MAX_BACKTRACK,
                        )?);
                    };
                    trial_lambda = accepted_trial.step_size;
                    let line_search_backtracks = accepted_trial.backtracks;
                    let energy_evaluations = accepted_trial.energy_evaluations;
                    let trial_stats = accepted_trial.stats;
                    let m_trial = accepted_trial.magnetization;

                    let h_eff_new = backend.copy_h_eff(cell_count)?;
                    let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);

                    let step_size_update = projected_gradient_step_size_update(
                        &state.magnetization,
                        &m_trial,
                        &state.gradient,
                        &g_new,
                        &ms_apm,
                        &volumes_m3,
                        state.use_bb1,
                        state.reset_consecutive,
                    );
                    state.step_size = step_size_update.step_size;
                    state.use_bb1 = step_size_update.use_bb1;
                    state.reset_consecutive = step_size_update.reset_consecutive;

                    state.h_eff = h_eff_new;
                    state.gradient = g_new;
                    (
                        trial_stats,
                        m_trial,
                        line_search_backtracks,
                        energy_evaluations,
                    )
                }
                DirectMinimizerAlgorithm::NonlinearCg => {
                    let p_dot_g = nonlinear_cg_descent_direction_dot(
                        &mut state.search_direction,
                        &state.gradient,
                        &ms_apm,
                        &volumes_m3,
                    );
                    trial_lambda = nonlinear_cg_initial_step_size(&state.search_direction);

                    let Some(accepted_trial) = nonlinear_cg_line_search(
                        state.energy_j,
                        p_dot_g,
                        &state.magnetization,
                        &state.search_direction,
                        trial_lambda,
                        |trial| {
                            backend.upload_magnetization(trial)?;
                            let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                            ensure_single_object_scalars(&mut stats, "free");
                            Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                                energy_j: stats.e_total,
                                stats,
                            })
                        },
                    )?
                    else {
                        return Err(restore_previous_state_after_failed_line_search(
                            backend,
                            &state.magnetization,
                            "nonlinear-CG",
                            NONLINEAR_CG_MAX_BACKTRACK,
                        )?);
                    };
                    trial_lambda = accepted_trial.step_size;
                    let line_search_backtracks = accepted_trial.backtracks;
                    let energy_evaluations = accepted_trial.energy_evaluations;
                    let trial_stats = accepted_trial.stats;
                    let m_trial = accepted_trial.magnetization;

                    let h_eff_new = backend.copy_h_eff(cell_count)?;
                    let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);
                    state.search_direction = nonlinear_cg_next_direction(
                        &m_trial,
                        &state.gradient,
                        &g_new,
                        &state.search_direction,
                        &ms_apm,
                        &volumes_m3,
                        state.accepted_steps + 1,
                    );
                    state.h_eff = h_eff_new;
                    state.gradient = g_new;
                    state.step_size = trial_lambda;
                    (
                        trial_stats,
                        m_trial,
                        line_search_backtracks,
                        energy_evaluations,
                    )
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
        let scalar_metrics = accepted_stats
            .per_object_scalars
            .entry("free".to_string())
            .or_default();
        let evaluation_counts = snapshot_trial_evaluation_counts(energy_evaluations);
        scalar_metrics.insert(
            "line_search_backtracks".to_string(),
            f64::from(line_search_backtracks),
        );
        scalar_metrics.insert(
            "energy_evaluations".to_string(),
            f64::from(evaluation_counts.energy),
        );
        scalar_metrics.insert(
            "field_evaluations".to_string(),
            f64::from(evaluation_counts.field),
        );
        scalar_metrics.insert(
            "rhs_evaluations".to_string(),
            f64::from(evaluation_counts.rhs),
        );
        scalar_metrics.insert("accepted_steps".to_string(), state.accepted_steps as f64);

        artifacts.record_scalar(&accepted_stats)?;
        steps.push(accepted_stats.clone());
        latest_stats = Some(accepted_stats.clone());
        current_stats = accepted_stats;

        let energy_plateau_range = energy_plateau.record(state.energy_j);
        if torque_confirmation.observe(control, energy_plateau_range, torque_apm) {
            break;
        }
    }

    Ok(CudaDirectMinimizerOutcome {
        latest_stats,
        cancelled,
        numerical_stagnation,
    })
}
