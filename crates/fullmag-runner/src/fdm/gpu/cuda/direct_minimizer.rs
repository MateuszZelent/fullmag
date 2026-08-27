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
    apply_direct_minimizer_step_metrics, direct_minimizer_energy_tolerance_j,
    direct_minimizer_gradient_degenerate, direct_minimizer_gradient_invalid,
    direct_minimizer_within_runtime_budget, energy_metric_dot, format_line_search_failure_message,
    mask_vectors_to_active_domain, nonlinear_cg_descent_direction_dot,
    nonlinear_cg_initial_step_size, nonlinear_cg_line_search_with_tolerance,
    nonlinear_cg_next_direction, projected_gradient_line_search_with_tolerance,
    projected_gradient_step_size_update, snapshot_trial_evaluation_counts,
    DirectMinimizerAlgorithm, DirectMinimizerControl, DirectMinimizerLineSearchFailure,
    DirectMinimizerState, DirectMinimizerTrialEvaluation, NONLINEAR_CG_MAX_BACKTRACK,
    PROJECTED_GRADIENT_MAX_BACKTRACK,
};
use crate::relaxation::vector_math::tangent_gradient_from_field;
use crate::relaxation::{RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation};
use crate::scalar_metrics::single_object_scalars;
use crate::types::{LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

pub(crate) struct CudaDirectMinimizerOutcome {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) cancelled: bool,
    pub(crate) torque_confirmed: bool,
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

fn line_search_failure_diagnostics(
    state: &DirectMinimizerState,
    ms_apm: &[f64],
    volumes_m3: &[f64],
    cell_volume_m3: f64,
) -> (f64, f64, usize, f64, f64, f64) {
    let mut gradient_max_apm: f64 = 0.0;
    let mut active_gradient_max_apm: f64 = 0.0;
    let mut active_cell_count = 0usize;
    let mut ms_min_apm = f64::INFINITY;
    let mut ms_max_apm = f64::NEG_INFINITY;
    for ((gradient, ms), volume) in state
        .gradient
        .iter()
        .zip(ms_apm.iter())
        .zip(volumes_m3.iter())
    {
        let norm =
            (gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2])
                .sqrt();
        gradient_max_apm = gradient_max_apm.max(norm);
        if *volume > 0.0 {
            active_cell_count += 1;
            active_gradient_max_apm = active_gradient_max_apm.max(norm);
            ms_min_apm = ms_min_apm.min(*ms);
            ms_max_apm = ms_max_apm.max(*ms);
        }
    }
    if active_cell_count == 0 {
        ms_min_apm = 0.0;
        ms_max_apm = 0.0;
    }
    (
        gradient_max_apm,
        active_gradient_max_apm,
        active_cell_count,
        cell_volume_m3,
        ms_min_apm,
        ms_max_apm,
    )
}

fn restore_previous_state_after_failed_line_search(
    backend: &mut NativeFdmBackend,
    magnetization: &[[f64; 3]],
    algorithm: &str,
    max_backtracks: u32,
    failure: DirectMinimizerLineSearchFailure,
) -> Result<RunError, RunError> {
    backend.upload_magnetization(magnetization)?;
    backend.refresh_observables()?;
    Ok(RunError {
        message: format!(
            "{}; previous magnetization was restored",
            format_line_search_failure_message(algorithm, max_backtracks, failure)
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
    let mut torque_confirmed = false;
    let mut numerical_stagnation = false;
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let active_mask = plan.active_mask.as_deref();
    let mut state = DirectMinimizerState::new(
        backend.copy_m(cell_count)?,
        backend.copy_h_eff(cell_count)?,
        current_stats.e_total,
    );
    mask_vectors_to_active_domain(&mut state.magnetization, active_mask);
    mask_vectors_to_active_domain(&mut state.h_eff, active_mask);
    mask_vectors_to_active_domain(&mut state.gradient, active_mask);
    mask_vectors_to_active_domain(&mut state.search_direction, active_mask);
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
                    coupled_checkpoint: None,
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
                    terminal_field_snapshot: false,
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
        let current_torque_apm = crate::relaxation::vector_math::max_torque_from_field(
            &state.magnetization,
            &state.h_eff,
        );
        if torque_confirmation.observe_at_accepted_step(
            control,
            energy_plateau.range(),
            current_torque_apm,
            state.accepted_steps,
        ) {
            torque_confirmed = true;
            break;
        }
        if direct_minimizer_gradient_degenerate(weighted_gradient_norm_sq) {
            if control.stop.torque_tolerance_apm.is_some_and(|threshold| {
                current_torque_apm.is_finite() && current_torque_apm <= threshold
            }) && control.stop.energy_tolerance_j.is_none()
            {
                for _ in 0..2 {
                    backend.refresh_observables()?;
                    let mut fresh_h_eff = backend.copy_h_eff(cell_count)?;
                    mask_vectors_to_active_domain(&mut fresh_h_eff, active_mask);
                    let fresh_torque_apm = crate::relaxation::vector_math::max_torque_from_field(
                        &state.magnetization,
                        &fresh_h_eff,
                    );
                    state.h_eff = fresh_h_eff;
                    if torque_confirmation.observe(
                        control,
                        energy_plateau.range(),
                        fresh_torque_apm,
                    ) {
                        torque_confirmed = true;
                        break;
                    }
                }
                if !torque_confirmed {
                    numerical_stagnation = true;
                }
                break;
            }
            numerical_stagnation = true;
            break;
        }

        let mut trial_lambda = state.step_size;
        let energy_tolerance_j =
            direct_minimizer_energy_tolerance_j(plan.precision, state.energy_j);
        let (trial_stats, m_trial, line_search_backtracks, energy_evaluations) =
            match direct_minimizer.algorithm {
                DirectMinimizerAlgorithm::ProjectedGradientBb => {
                    let direction_dot_gradient_j_per_step = -weighted_gradient_norm_sq;
                    let initial_trial_step_size = trial_lambda;
                    let mut trial_evaluations = 0u32;
                    let mut last_trial_energy_j = f64::NAN;
                    let mut last_trial_step_size = initial_trial_step_size;
                    let Some(accepted_trial) = projected_gradient_line_search_with_tolerance(
                        state.energy_j,
                        direction_dot_gradient_j_per_step,
                        &state.magnetization,
                        &state.gradient,
                        &state.h_eff,
                        trial_lambda,
                        energy_tolerance_j,
                        &ms_apm,
                        &volumes_m3,
                        plan.active_mask.as_deref(),
                        |trial| {
                            let step_size =
                                initial_trial_step_size * 0.5_f64.powi(trial_evaluations as i32);
                            trial_evaluations = trial_evaluations.saturating_add(1);
                            backend.upload_magnetization(trial)?;
                            let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                            ensure_single_object_scalars(&mut stats, "free");
                            last_trial_energy_j = stats.e_total;
                            last_trial_step_size = step_size;
                            Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                                energy_j: stats.e_total,
                                stats,
                            })
                        },
                    )?
                    else {
                        let diagnostics = line_search_failure_diagnostics(
                            &state,
                            &ms_apm,
                            &volumes_m3,
                            cell_volume_m3,
                        );
                        return Err(restore_previous_state_after_failed_line_search(
                            backend,
                            &state.magnetization,
                            "projected-gradient BB",
                            PROJECTED_GRADIENT_MAX_BACKTRACK,
                            DirectMinimizerLineSearchFailure {
                                previous_energy_j: state.energy_j,
                                last_trial_energy_j,
                                initial_step_size_m_per_a: initial_trial_step_size,
                                last_trial_step_size_m_per_a: last_trial_step_size,
                                direction_dot_gradient_j_per_step,
                                energy_tolerance_j,
                                evaluations: trial_evaluations,
                                gradient_max_apm: diagnostics.0,
                                active_gradient_max_apm: diagnostics.1,
                                active_cell_count: diagnostics.2,
                                cell_volume_m3: diagnostics.3,
                                ms_min_apm: diagnostics.4,
                                ms_max_apm: diagnostics.5,
                            },
                        )?);
                    };
                    trial_lambda = accepted_trial.step_size;
                    let line_search_backtracks = accepted_trial.backtracks;
                    let energy_evaluations = accepted_trial.energy_evaluations;
                    let trial_stats = accepted_trial.stats;

                    let mut m_trial = accepted_trial.magnetization;
                    mask_vectors_to_active_domain(&mut m_trial, active_mask);
                    let mut h_eff_new = backend.copy_h_eff(cell_count)?;
                    mask_vectors_to_active_domain(&mut h_eff_new, active_mask);
                    let mut g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);
                    mask_vectors_to_active_domain(&mut g_new, active_mask);

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
                    let initial_trial_step_size = trial_lambda;
                    let mut trial_evaluations = 0u32;
                    let mut last_trial_energy_j = f64::NAN;
                    let mut last_trial_step_size = initial_trial_step_size;

                    let Some(accepted_trial) = nonlinear_cg_line_search_with_tolerance(
                        state.energy_j,
                        p_dot_g,
                        &state.magnetization,
                        &state.h_eff,
                        &state.search_direction,
                        trial_lambda,
                        energy_tolerance_j,
                        &ms_apm,
                        &volumes_m3,
                        plan.active_mask.as_deref(),
                        |trial| {
                            let step_size =
                                initial_trial_step_size * 0.5_f64.powi(trial_evaluations as i32);
                            trial_evaluations = trial_evaluations.saturating_add(1);
                            backend.upload_magnetization(trial)?;
                            let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                            ensure_single_object_scalars(&mut stats, "free");
                            last_trial_energy_j = stats.e_total;
                            last_trial_step_size = step_size;
                            Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                                energy_j: stats.e_total,
                                stats,
                            })
                        },
                    )?
                    else {
                        let diagnostics = line_search_failure_diagnostics(
                            &state,
                            &ms_apm,
                            &volumes_m3,
                            cell_volume_m3,
                        );
                        return Err(restore_previous_state_after_failed_line_search(
                            backend,
                            &state.magnetization,
                            "nonlinear-CG",
                            NONLINEAR_CG_MAX_BACKTRACK,
                            DirectMinimizerLineSearchFailure {
                                previous_energy_j: state.energy_j,
                                last_trial_energy_j,
                                initial_step_size_m_per_a: initial_trial_step_size,
                                last_trial_step_size_m_per_a: last_trial_step_size,
                                direction_dot_gradient_j_per_step: p_dot_g,
                                energy_tolerance_j,
                                evaluations: trial_evaluations,
                                gradient_max_apm: diagnostics.0,
                                active_gradient_max_apm: diagnostics.1,
                                active_cell_count: diagnostics.2,
                                cell_volume_m3: diagnostics.3,
                                ms_min_apm: diagnostics.4,
                                ms_max_apm: diagnostics.5,
                            },
                        )?);
                    };
                    trial_lambda = accepted_trial.step_size;
                    let line_search_backtracks = accepted_trial.backtracks;
                    let energy_evaluations = accepted_trial.energy_evaluations;
                    let trial_stats = accepted_trial.stats;
                    let mut m_trial = accepted_trial.magnetization;
                    mask_vectors_to_active_domain(&mut m_trial, active_mask);

                    let mut h_eff_new = backend.copy_h_eff(cell_count)?;
                    mask_vectors_to_active_domain(&mut h_eff_new, active_mask);
                    let mut g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);
                    mask_vectors_to_active_domain(&mut g_new, active_mask);
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
            plan.active_mask.as_deref(),
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

        artifacts.observe_energy_evaluation();
        artifacts.record_scalar(&accepted_stats)?;
        steps.push(accepted_stats.clone());
        latest_stats = Some(accepted_stats.clone());
        current_stats = accepted_stats;

        let energy_plateau_range = energy_plateau.record(state.energy_j);
        if torque_confirmation.observe_at_accepted_step(
            control,
            energy_plateau_range,
            torque_apm,
            state.accepted_steps,
        ) {
            torque_confirmed = true;
            break;
        }
    }

    Ok(CudaDirectMinimizerOutcome {
        latest_stats,
        cancelled,
        torque_confirmed,
        numerical_stagnation,
    })
}
