//! FEM direct-minimizer execution loop.
//!
//! This module owns the native FEM orchestration for bootstrap energy
//! minimizers. Backend implementations still own magnetization upload,
//! effective-field refresh, observables, and scalar extraction.

use fullmag_ir::FemPlanIR;

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::{ensure_fem_object_scalars, flatten_vectors};
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::{relaxation_stop_criteria_satisfied, RelaxationEnergyPlateauWindow};
use crate::relaxation_direct_minimizer::{
    apply_direct_minimizer_step_metrics, direct_minimizer_gradient_degenerate,
    direct_minimizer_gradient_norm_sq, direct_minimizer_step_budget,
    nonlinear_cg_descent_direction_dot, nonlinear_cg_initial_step_size, nonlinear_cg_line_search,
    nonlinear_cg_next_direction, projected_gradient_line_search,
    projected_gradient_step_size_update, DirectMinimizerAlgorithm, DirectMinimizerControl,
    DirectMinimizerState, DirectMinimizerTrialEvaluation,
};
use crate::relaxation_vector_math::{max_torque_from_field, tangent_gradient_from_field};
use crate::types::{FemMeshPayload, LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

use super::preview::build_fem_cached_preview_fields;

pub(crate) struct DirectMinimizerExecution {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
}

pub(crate) fn execute_direct_minimizer(
    backend: &mut NativeFemBackend,
    plan: &FemPlanIR,
    node_count: usize,
    direct_minimizer: DirectMinimizerControl<'_>,
    mut current_stats: StepStats,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: &mut ArtifactRecorder,
    steps: &mut Vec<StepStats>,
    energy_plateau: &mut RelaxationEnergyPlateauWindow,
    mut last_preview_revision: Option<u64>,
) -> Result<DirectMinimizerExecution, RunError> {
    let control = direct_minimizer.control;
    let mut latest_stats: Option<StepStats> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut state = DirectMinimizerState::new(
        backend.copy_m(node_count)?,
        backend.copy_h_eff(node_count)?,
        current_stats.e_total,
    );

    while state.accepted_steps < direct_minimizer_step_budget(control) {
        if live
            .as_ref()
            .is_some_and(|consumer| consumer.initial_snapshot)
        {
            if let Some(live) = live.as_mut() {
                if let Some(display_selection) = live.display_selection.map(|get| get()) {
                    let preview_due = display_refresh_due(
                        last_preview_revision,
                        &display_selection,
                        current_stats.step,
                    );
                    let preview_targets_global_scalar =
                        display_is_global_scalar(&display_selection);
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let request = display_selection.preview_request();
                        Some(backend.copy_live_preview_field(&request, node_count)?)
                    } else {
                        None
                    };
                    let cached_preview_fields = if preview_due {
                        build_fem_cached_preview_fields(
                            backend,
                            &display_selection,
                            plan,
                            node_count,
                        )
                    } else {
                        None
                    };
                    if current_stats.step <= 2 || preview_due {
                        eprintln!(
                            "[fullmag-runner] native-fem bootstrap live update step={} every_n={} preview_due={} preview_quantity={} preview_field={} cached_preview_fields={} global_scalar={} mag_len={}",
                            current_stats.step,
                            u64::from(display_selection.selection.every_n.max(1)),
                            preview_due,
                            display_selection.selection.quantity.as_str(),
                            preview_field.is_some(),
                            cached_preview_fields
                                .as_ref()
                                .map(|fields| fields.len())
                                .unwrap_or(0),
                            preview_targets_global_scalar,
                            node_count.saturating_mul(3),
                        );
                    }
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: Some(FemMeshPayload::from(plan)),
                        magnetization: Some(flatten_vectors(&state.magnetization)),
                        preview_field,
                        cached_preview_fields,
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        finished: false,
                    });
                    if preview_due {
                        last_preview_revision = Some(display_selection.revision);
                    }
                    match action {
                        StepAction::Continue => {}
                        StepAction::Stop => {
                            cancelled = true;
                            break;
                        }
                        StepAction::Pause => {
                            paused = true;
                            break;
                        }
                    }
                }
            }
        }

        if paused {
            break;
        }

        let max_torque = max_torque_from_field(&state.magnetization, &state.h_eff);
        if control
            .stop
            .torque_tolerance_apm
            .is_some_and(|threshold| max_torque <= threshold)
        {
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
                        let mut stats = backend.snapshot_step_stats(node_count)?;
                        ensure_fem_object_scalars(&mut stats, plan);
                        Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                            energy_j: stats.e_total,
                            stats,
                        })
                    },
                )?;
                trial_lambda = accepted_trial.step_size;
                let trial_stats = accepted_trial.stats;
                let m_trial = accepted_trial.magnetization;

                let h_eff_new = backend.copy_h_eff(node_count)?;
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
                        let mut stats = backend.snapshot_step_stats(node_count)?;
                        ensure_fem_object_scalars(&mut stats, plan);
                        Ok::<_, RunError>(DirectMinimizerTrialEvaluation {
                            energy_j: stats.e_total,
                            stats,
                        })
                    },
                )?;
                trial_lambda = accepted_trial.step_size;
                let trial_stats = accepted_trial.stats;
                let m_trial = accepted_trial.magnetization;

                let h_eff_new = backend.copy_h_eff(node_count)?;
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
        ensure_fem_object_scalars(&mut accepted_stats, plan);

        artifacts.record_scalar(&accepted_stats)?;
        steps.push(accepted_stats.clone());
        latest_stats = Some(accepted_stats.clone());
        current_stats = accepted_stats;

        if cancelled {
            break;
        }

        let energy_plateau_range = energy_plateau.record(state.energy_j);
        if relaxation_stop_criteria_satisfied(control, energy_plateau_range, torque_apm) {
            break;
        }
    }

    Ok(DirectMinimizerExecution {
        latest_stats,
        cancelled,
        paused,
    })
}
