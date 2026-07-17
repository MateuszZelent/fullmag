//! Native CUDA FDM execution loop.

use fullmag_ir::{FdmPlanIR, OutputIR};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(feature = "cuda")]
use crate::artifact_pipeline::ArtifactRecorder;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::artifacts::{
    capture_initial_cuda_fields, record_cuda_due_outputs, record_cuda_final_outputs,
};
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
#[cfg(feature = "cuda")]
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
#[cfg(feature = "cuda")]
use crate::preview::flatten_vectors;
#[cfg(feature = "cuda")]
use crate::relaxation::{
    llg_overdamped_uses_pure_damping, relaxation_converged, relaxation_stop_criteria_satisfied,
    RelaxationEnergyPlateauWindow,
};
#[cfg(feature = "cuda")]
use crate::relaxation_direct_minimizer::{
    apply_direct_minimizer_step_metrics, direct_minimizer_control,
    direct_minimizer_gradient_degenerate, direct_minimizer_gradient_norm_sq,
    direct_minimizer_step_budget, nonlinear_cg_descent_direction_dot,
    nonlinear_cg_initial_step_size, nonlinear_cg_line_search, nonlinear_cg_next_direction,
    projected_gradient_line_search, projected_gradient_step_size_update, DirectMinimizerAlgorithm,
    DirectMinimizerState, DirectMinimizerTrialEvaluation,
};
#[cfg(feature = "cuda")]
use crate::relaxation_vector_math::{max_torque_from_field, tangent_gradient_from_field};
#[cfg(feature = "cuda")]
use crate::scalar_metrics::{
    apply_average_m_to_step_stats, scalar_outputs_request_average_m, scalar_row_due,
    single_object_scalars,
};
#[cfg(feature = "cuda")]
use crate::schedules::{collect_field_schedules, collect_scalar_schedules};
use crate::types::{ExecutedRun, LiveStepConsumer, RunError};
#[cfg(feature = "cuda")]
use crate::types::{ExecutionProvenance, RunResult, RunStatus, StepAction, StepStats, StepUpdate};

#[cfg(feature = "cuda")]
fn ensure_single_object_scalars(stats: &mut StepStats, object_id: &str) {
    if stats.per_object_scalars.is_empty() {
        stats.per_object_scalars = single_object_scalars(object_id, stats);
    }
}

#[cfg(feature = "cuda")]
pub(crate) fn execute_cuda_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    crate::fdm::reject_adaptive_cuda_single_grid_plan(plan)?;
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }

    let mut backend = NativeFdmBackend::create(plan)?;
    let device_info = backend.device_info()?;
    let cell_count = (plan.grid.cells[0] as usize)
        * (plan.grid.cells[1] as usize)
        * (plan.grid.cells[2] as usize);
    let initial_magnetization = backend.copy_m(cell_count)?;
    let dt = crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
        .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);

    let mut steps = Vec::new();
    let provenance = ExecutionProvenance {
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
        ..Default::default()
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();
    capture_initial_cuda_fields(&backend, cell_count, &mut field_schedules, &mut artifacts)?;

    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut current_stats = backend.snapshot_step_stats(plan.grid.cells)?;
    ensure_single_object_scalars(&mut current_stats, "free");

    if let Some(direct_minimizer) = direct_minimizer_control(plan.relaxation.as_ref()) {
        let control = direct_minimizer.control;
        latest_stats = Some(current_stats.clone());
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
                    let preview_targets_global_scalar =
                        display_is_global_scalar(&display_selection);
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
    } else {
        while current_time < until_seconds {
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
                        magnetization: None,
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

            let dt_step = dt.min(until_seconds - current_time);
            let interrupt_requested = live
                .as_ref()
                .and_then(|consumer| consumer.interrupt_requested);
            let Some(mut stats) = backend.step_interruptible(dt_step, interrupt_requested)? else {
                continue;
            };
            ensure_single_object_scalars(&mut stats, "free");
            current_time = stats.time;
            latest_stats = Some(stats.clone());
            current_stats = stats.clone();
            let due_scalar_row = scalar_row_due(&scalar_schedules, stats.time);
            let average_requested = scalar_outputs_request_average_m(&scalar_schedules);
            let mut sampled_stats = stats.clone();
            let mut magnetization_cache: Option<Vec<[f64; 3]>> = None;
            if due_scalar_row && average_requested {
                if magnetization_cache.is_none() {
                    magnetization_cache = Some(backend.copy_m(cell_count)?);
                }
                apply_average_m_to_step_stats(
                    &mut sampled_stats,
                    magnetization_cache
                        .as_deref()
                        .expect("magnetization cache initialized"),
                );
            }
            if let Some(live) = live.as_mut() {
                let heavy_payload_every = live.field_every_n.max(1);
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
                let magnetization = if stats.step % heavy_payload_every == 0 {
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
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    Some(backend.copy_live_preview_field(
                        &request,
                        plan.grid.cells,
                        plan.active_mask.as_deref(),
                    )?)
                } else {
                    None
                };
                let action = (live.on_step)(StepUpdate {
                    stats: sampled_stats.clone(),
                    grid: live.grid,
                    fem_mesh: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
                    scalar_row_due: due_scalar_row
                        || (preview_due && preview_targets_global_scalar),
                    finished: false,
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
            record_cuda_due_outputs(
                &backend,
                cell_count,
                &sampled_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
            let energy_plateau_range = energy_plateau.record(stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || relaxation_converged(
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

    record_cuda_final_outputs(
        &backend,
        cell_count,
        latest_stats.clone(),
        default_scalar_trace,
        &scalar_schedules,
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )?;

    let final_magnetization = backend.copy_m(cell_count)?;
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
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: latest_stats.as_ref().map_or(0, |stats| stats.step),
            relaxation_time_s: latest_stats.as_ref().map(|stats| stats.time),
            numerical_stagnation: false,
        },
    );

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

#[cfg(not(feature = "cuda"))]
pub(crate) fn execute_cuda_fdm(
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
