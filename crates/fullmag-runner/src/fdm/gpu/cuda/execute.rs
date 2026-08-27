//! Native CUDA FDM execution loop.

use fullmag_ir::{FdmPlanIR, OutputIR};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(feature = "cuda")]
use crate::artifact_pipeline::ArtifactRecorder;
#[cfg(feature = "cuda")]
use crate::constraints::FrozenSpinsCheckpointV1;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::artifacts::{
    capture_initial_cuda_fields, record_cuda_due_outputs, record_cuda_final_outputs,
};
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::spin_transport::{
    GpuM1TransportSession, NativeGpuM1TransportAbi, PreparedGpuM1Descriptor,
};
#[cfg(feature = "cuda")]
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
#[cfg(feature = "cuda")]
use crate::preview::flatten_vectors;
#[cfg(feature = "cuda")]
use crate::relaxation::direct_minimizer::direct_minimizer_control;
#[cfg(feature = "cuda")]
use crate::relaxation::{
    llg_overdamped_uses_pure_damping, RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation,
};
#[cfg(feature = "cuda")]
use crate::scalar_metrics::{
    apply_average_m_to_step_stats_with_active_mask, scalar_row_due, single_object_scalars,
};
#[cfg(feature = "cuda")]
use crate::schedules::{collect_field_schedules, collect_scalar_schedules};
use crate::types::{ExecutedRun, LiveStepConsumer, RunError};
#[cfg(feature = "cuda")]
use crate::types::{ExecutionProvenance, RunResult, RunStatus, StepAction, StepStats, StepUpdate};

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
    let mut backend = NativeFdmBackend::create(plan)?;
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
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut numerical_stagnation = false;
    let mut direct_minimizer_torque_confirmed = false;
    let mut current_stats = backend.snapshot_step_stats(plan.grid.cells)?;
    ensure_single_object_scalars(&mut current_stats, "free");
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
            current_stats,
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            &mut energy_plateau,
            last_preview_revision,
        )?;
        latest_stats = outcome.latest_stats;
        cancelled = outcome.cancelled;
        direct_minimizer_torque_confirmed = outcome.torque_confirmed;
        numerical_stagnation = outcome.numerical_stagnation;
    } else {
        let dt = initial_dt.expect("LLG execution requires a resolved timestep policy");
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
                        coupled_checkpoint: final_frozen_checkpoint.clone(),
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh_generation_id: None,
                        magnetization: None,
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
            if live.is_some() {
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
            let due_scalar_row = scalar_row_due(&scalar_schedules, stats.time);
            let mut sampled_stats = stats.clone();
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
                    coupled_checkpoint: final_frozen_checkpoint.clone(),
                    stats: sampled_stats.clone(),
                    grid: live.grid,
                    fem_mesh_generation_id: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
                    terminal_field_snapshot: false,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
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
                magnetization_cache.as_deref(),
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
            let energy_plateau_range = energy_plateau.record(stats.e_total);
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
    final_frozen_checkpoint = frozen_spins_checkpoint_value(
        plan,
        frozen_spins_state.as_ref(),
        &final_magnetization,
        latest_stats.as_ref().map_or(0, |stats| stats.step),
        latest_stats.as_ref().map_or(0.0, |stats| stats.time),
        latest_stats.as_ref().map_or(0.0, |stats| stats.dt),
    )?;
    if let Some(session) = gpu_transport.as_mut() {
        backend.unbind_gpu_transport()?;
        session.close().map_err(|error| RunError {
            message: format!("closing public GPU M1 transport session failed: {error}"),
        })?;
    }
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

    let auxiliary_artifacts = final_frozen_checkpoint
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
        .transpose()?;

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
        auxiliary_artifacts: auxiliary_artifacts.into_iter().collect(),
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
