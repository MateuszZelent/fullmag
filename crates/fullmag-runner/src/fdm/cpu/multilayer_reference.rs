//! CPU reference runner for public multilayer / multi-body FDM problems.
//!
//! Current public scope:
//! - multiple ferromagnets with body-local exchange,
//! - global demag via multilayer convolution,
//! - fixed-step Heun/RK4/RK23/RK45/ABM3 stepping,
//! - scalar traces and concatenated field snapshots.

use fullmag_engine::{
    multilayer::{FdmLayerRuntime, KernelPair, MultilayerDemagRuntime},
    AxisBoundary, CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, ExchangeLlgProblem,
    ExchangeLlgState, FdmBoundaryPolicy, GridShape, LlgConfig, MaterialParameters,
    UniaxialAnisotropyConfig, MU0,
};
use fullmag_fdm_demag::{compute_exact_self_kernel, compute_shifted_kernel, TransferBoundaryPolicy};
use fullmag_ir::{ExecutionPrecision, FdmMultilayerPlanIR, IntegratorChoice, OutputIR};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::derived_fields::compute_torque_field;
use crate::derived_fields::max_torque_residual_apm_from_field;
use crate::fdm::artifacts::select_state_observable_field;
use crate::fdm::multilayer::make_multilayer_step_stats as make_step_stats;
use crate::fdm::schedules::record_due_fields;
use crate::relaxation::{
    llg_overdamped_uses_pure_damping, relaxation_converged, RelaxationEnergyPlateauWindow,
};
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, RunError, RunResult, RunStatus,
    StateObservables, StepAction, StepStats, StepUpdate,
};

use std::time::Instant;

#[derive(Debug, Clone)]
struct LayerContext {
    magnet_name: String,
    origin: [f64; 3],
    convolution_grid: [usize; 3],
    convolution_cell_size: [f64; 3],
    needs_transfer: bool,
    transfer_boundary_policy: TransferBoundaryPolicy,
    problem: ExchangeLlgProblem,
}

pub(crate) fn execute_reference_fdm_multilayer(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    crate::fdm::validate_multilayer_grid_budget(plan)?;
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    if plan.precision != ExecutionPrecision::Double {
        return Err(RunError {
            message: "public multilayer FDM CPU runner supports only double precision".to_string(),
        });
    }
    let integrator = match plan.integrator {
        IntegratorChoice::Heun => fullmag_engine::TimeIntegrator::Heun,
        IntegratorChoice::Rk4 => fullmag_engine::TimeIntegrator::RK4,
        IntegratorChoice::Rk23 => fullmag_engine::TimeIntegrator::RK23,
        IntegratorChoice::Rk45 => fullmag_engine::TimeIntegrator::RK45,
        IntegratorChoice::Abm3 => fullmag_engine::TimeIntegrator::ABM3,
    };
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());

    let (contexts, mut states) = build_contexts_and_states(plan, integrator, pure_damping_relax)?;
    let demag_runtime = if plan.enable_demag {
        Some(build_multilayer_demag_runtime(plan)?)
    } else {
        None
    };

    let initial_magnetization = flatten_layers(
        &states
            .iter()
            .map(|state| state.magnetization().to_vec())
            .collect::<Vec<_>>(),
    );
    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count = 0u64;
    let fft_backend = super::reference::resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let provenance = ExecutionProvenance {
        execution_engine: "cpu_reference_multilayer".to_string(),
        precision: "double".to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some("multilayer_tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: None,
        resolved_integrator: None,
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: None,
        resolved_demag_realization: None,
        dt_policy: None,
        llg_mode: None,
        mfem_device: None,
        demag_refresh_interval_s: None,
        fem_assembly_mode: None,
        fem_execution_mode: None,
        fem_gpu_qualification_status: None,
        fem_exchange_operator_mode: None,
        fem_data_residency: None,
        uses_cuda_kernels: None,
        uses_gpu_poisson: None,
        fem_demag_operator_mode: None,
        hypre_execution_policy: None,
        demag_residency: None,
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        hot_loop_control_scalar_d2h_bytes: None,
        hot_loop_control_scalar_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let initial_observables = observe_multilayer(&contexts, &states, demag_runtime.as_ref())?;
    if default_scalar_trace {
        let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }
    record_due_fields(
        &initial_observables,
        0,
        0.0,
        0.0,
        &mut field_schedules,
        &mut artifacts,
    )?;

    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut completion_metrics = crate::relaxation::RelaxationCompletionMetrics::default();
    let mut cancelled = false;
    let mut paused = false;
    while current_time(&states) < until_seconds {
        let dt_step = dt.min(until_seconds - current_time(&states));
        let wall_start = Instant::now();
        step_multilayer(
            &contexts,
            &mut states,
            demag_runtime.as_ref(),
            dt_step,
            plan.integrator,
        )?;
        let wall_time_ns = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        let observables = observe_multilayer(&contexts, &states, demag_runtime.as_ref())?;
        let latest_stats = make_step_stats(
            step_count,
            current_time(&states),
            dt_step,
            wall_time_ns,
            &observables,
        );

        if default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|s| is_due(latest_stats.time, s.next_time))
        {
            artifacts.record_scalar(&latest_stats)?;
            steps.push(latest_stats.clone());
            advance_due_schedules(&mut scalar_schedules, latest_stats.time);
        }

        record_due_fields(
            &observables,
            latest_stats.step,
            latest_stats.time,
            latest_stats.dt,
            &mut field_schedules,
            &mut artifacts,
        )?;

        if let Some((grid, on_step)) = live.as_mut() {
            let action = on_step(StepUpdate {
            coupled_checkpoint: None,
                stats: latest_stats.clone(),
                grid: [grid[0], grid[1], grid[2]],
                fem_mesh: None,
                magnetization: None,
                preview_field: None,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                finished: false,
            });
            match action {
                StepAction::Continue => {}
                StepAction::Stop => {
                    cancelled = true;
                }
                StepAction::Pause => {
                    paused = true;
                }
            }
        }

        if cancelled || paused {
            break;
        }

        let energy_plateau_range = energy_plateau.record(latest_stats.e_total);
        completion_metrics = crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: Some(latest_stats.max_torque_Apm),
            accepted_energy_plateau_range_j: energy_plateau_range,
            steps: step_count,
            relaxation_time_s: Some(latest_stats.time),
            numerical_stagnation: false,
        };
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            latest_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                || relaxation_converged(
                    control,
                    &latest_stats,
                    energy_plateau_range,
                    plan.gyromagnetic_ratio,
                    average_damping(&contexts),
                    pure_damping_relax,
                )
        });
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables = observe_multilayer(&contexts, &states, demag_runtime.as_ref())?;
    let final_stats = make_step_stats(
        step_count,
        current_time(&states),
        dt.min(until_seconds.max(dt)),
        0,
        &final_observables,
    );
    if !steps
        .iter()
        .any(|step| step.step == final_stats.step && (step.time - final_stats.time).abs() <= 1e-18)
    {
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats.clone());
    }
    for schedule in &mut field_schedules {
        if schedule
            .last_sampled_time
            .map(|time| same_time(time, final_stats.time))
            .unwrap_or(false)
        {
            continue;
        }
        let values = select_state_observable_field(&final_observables, &schedule.name, false)?;
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        })?;
    }

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if paused {
        RunStatus::Paused
    } else if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::resolve_stage_completion(
        status,
        plan.relaxation.as_ref(),
        completion_metrics,
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization: flatten_layers(
                &states
                    .iter()
                    .map(|state| state.magnetization().to_vec())
                    .collect::<Vec<_>>(),
            ),
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn build_contexts_and_states(
    plan: &FdmMultilayerPlanIR,
    integrator: fullmag_engine::TimeIntegrator,
    pure_damping_relax: bool,
) -> Result<(Vec<LayerContext>, Vec<ExchangeLlgState>), RunError> {
    let mut contexts = Vec::with_capacity(plan.layers.len());
    let mut states = Vec::with_capacity(plan.layers.len());

    for layer in &plan.layers {
        let grid = GridShape::new(
            layer.native_grid[0] as usize,
            layer.native_grid[1] as usize,
            layer.native_grid[2] as usize,
        )
        .map_err(|error| RunError {
            message: format!("grid for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let cell_size = CellSize::new(
            layer.native_cell_size[0],
            layer.native_cell_size[1],
            layer.native_cell_size[2],
        )
        .map_err(|error| RunError {
            message: format!("cell size for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let material = MaterialParameters::new(
            layer.material.saturation_magnetisation,
            layer.material.exchange_stiffness,
            layer.material.damping,
        )
        .map_err(|error| RunError {
            message: format!("material for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator)
            .map_err(|error| RunError {
                message: format!("LLG for magnet '{}': {}", layer.magnet_name, error),
            })?
            .with_precession_enabled(!pure_damping_relax);
        let mut problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            cell_size,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: false,
                external_field: plan.external_field,
                per_node_field: None,
                magnetoelastic: None,
                uniaxial_anisotropy: layer.material.uniaxial_anisotropy_ku1.map(|ku1| {
                    UniaxialAnisotropyConfig {
                        ku1,
                        ku2: layer.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                        axis: layer.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                    }
                }),
                cubic_anisotropy: layer.material.cubic_anisotropy_kc1.map(|kc1| {
                    CubicAnisotropyConfig {
                        kc1,
                        kc2: layer.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                        axis1: layer
                            .material
                            .cubic_anisotropy_axis1
                            .unwrap_or([1.0, 0.0, 0.0]),
                        axis2: layer
                            .material
                            .cubic_anisotropy_axis2
                            .unwrap_or([0.0, 1.0, 0.0]),
                    }
                }),
                interfacial_dmi: plan.interfacial_dmi,
                bulk_dmi: plan.bulk_dmi,
                zhang_li_stt: None,
                slonczewski_stt: None,
                sot: None,
                oersted_cylinder: None,
            },
            layer.native_active_mask.clone(),
        )
        .map_err(|error| RunError {
            message: format!(
                "problem construction for magnet '{}': {}",
                layer.magnet_name, error
            ),
        })?;
        // Wire periodic boundary policy
        if let Some(ref pbc) = plan.periodicity {
            let map_axis = |a: &fullmag_ir::AxisBoundary| match a {
                fullmag_ir::AxisBoundary::Periodic => AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open => AxisBoundary::Open,
            };
            problem.boundary_policy = FdmBoundaryPolicy {
                x: map_axis(&pbc.axes[0]),
                y: map_axis(&pbc.axes[1]),
                z: map_axis(&pbc.axes[2]),
            };
            if let Some(ic) = pbc.image_counts {
                problem.demag_image_counts = ic;
            }
        }
        problem.set_demag_boundary(
            crate::fdm::resolve_fdm_demag_boundary_for_periodicity(
                plan.periodicity.as_ref(),
                plan.enable_demag,
            )?,
        );
        let state = problem
            .new_state(layer.initial_magnetization.clone())
            .map_err(|error| RunError {
                message: format!(
                    "state construction for magnet '{}': {}",
                    layer.magnet_name, error
                ),
            })?;
        states.push(state);
        contexts.push(LayerContext {
            magnet_name: layer.magnet_name.clone(),
            origin: layer.native_origin,
            convolution_grid: [
                layer.convolution_grid[0] as usize,
                layer.convolution_grid[1] as usize,
                layer.convolution_grid[2] as usize,
            ],
            convolution_cell_size: layer.convolution_cell_size,
            needs_transfer: layer.transfer_kind != "identity",
            transfer_boundary_policy: TransferBoundaryPolicy::from_periodic_axes(
                plan.periodicity
                    .as_ref()
                    .map(|periodicity| {
                        periodicity.axes.map(|axis| {
                            matches!(axis, fullmag_ir::AxisBoundary::Periodic)
                        })
                    })
                    .unwrap_or([false; 3]),
            ),
            problem,
        });
    }

    Ok((contexts, states))
}

fn build_multilayer_demag_runtime(
    plan: &FdmMultilayerPlanIR,
) -> Result<MultilayerDemagRuntime, RunError> {
    let conv_grid = [
        plan.common_cells[0] as usize,
        plan.common_cells[1] as usize,
        plan.common_cells[2] as usize,
    ];
    let conv_cell_size = plan
        .layers
        .first()
        .map(|layer| layer.convolution_cell_size)
        .unwrap_or([1.0, 1.0, 1.0]);
    let mut kernel_pairs = Vec::with_capacity(plan.layers.len() * plan.layers.len());
    for (src_index, src_layer) in plan.layers.iter().enumerate() {
        for (dst_index, dst_layer) in plan.layers.iter().enumerate() {
            let z_shift = dst_layer.native_origin[2] - src_layer.native_origin[2];
            let kernel = if src_index == dst_index {
                compute_exact_self_kernel(
                    conv_grid[0],
                    conv_grid[1],
                    conv_grid[2],
                    conv_cell_size[0],
                    conv_cell_size[1],
                    conv_cell_size[2],
                )
            } else {
                compute_shifted_kernel(conv_grid, conv_cell_size, z_shift)
            };
            kernel_pairs.push(KernelPair {
                src_layer: src_index,
                dst_layer: dst_index,
                kernel,
            });
        }
    }
    Ok(MultilayerDemagRuntime::new(
        kernel_pairs,
        conv_grid,
        conv_cell_size,
    ))
}

fn observe_multilayer(
    contexts: &[LayerContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = compute_demag_fields(contexts, states, demag_runtime);
    let mut magnetization = Vec::new();
    let mut exchange_field = Vec::new();
    let mut demag_field = Vec::new();
    let mut external_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut dmi_field = Vec::new();
    let mut effective_field = Vec::new();
    let mut exchange_energy = 0.0;
    let mut demag_energy = 0.0;
    let mut external_energy = 0.0;
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let mut max_dm_dt: f64 = 0.0;
    let mut max_h_eff: f64 = 0.0;
    let mut max_h_demag: f64 = 0.0;
    let mut torque_field = Vec::new();
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();

    for (index, context) in contexts.iter().enumerate() {
        let state = &states[index];
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let local_observables = context.problem.observe(state).map_err(|error| RunError {
            message: format!(
                "local observables for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;
        let local_exchange = local_observables.exchange_field;
        let mut local_external = local_observables.external_field;
        let mut local_anisotropy = context.problem.anisotropy_field(state.magnetization());
        let mut local_dmi = local_observables.dmi_field;
        zero_outside_active(&mut local_external, context.problem.active_mask.as_deref());
        zero_outside_active(
            &mut local_anisotropy,
            context.problem.active_mask.as_deref(),
        );
        zero_outside_active(&mut local_dmi, context.problem.active_mask.as_deref());
        let mut local_effective = local_observables.effective_field;
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(local_effective[cell], local_demag[cell]);
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer(context, state.magnetization(), &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        let local_exchange_energy = local_observables.exchange_energy_joules;
        let local_demag_energy = state
            .magnetization()
            .iter()
            .zip(local_demag.iter())
            .map(|(m, h)| -0.5 * MU0 * layer_ms * dot(*m, *h) * layer_cell_volume)
            .sum::<f64>();
        let local_external_energy = state
            .magnetization()
            .iter()
            .zip(local_external.iter())
            .map(|(m, h)| -MU0 * layer_ms * dot(*m, *h) * layer_cell_volume)
            .sum::<f64>();
        let local_anisotropy_energy = local_observables.anisotropy_energy_joules;
        let local_dmi_energy = local_observables.dmi_energy_joules;
        exchange_energy += local_exchange_energy;
        demag_energy += local_demag_energy;
        external_energy += local_external_energy;
        anisotropy_energy += local_anisotropy_energy;
        dmi_energy += local_dmi_energy;
        max_dm_dt = max_dm_dt.max(max_norm(&rhs));
        max_h_eff = max_h_eff.max(max_norm(&local_effective));
        max_h_demag = max_h_demag.max(max_norm(&local_demag));
        torque_field.extend(compute_torque_field(
            state.magnetization(),
            &local_effective,
            context.problem.material.damping,
            context.problem.dynamics.precession_enabled,
        ));

        let [mx, my, mz] =
            crate::scalar_metrics::average_magnetization_components(state.magnetization());
        per_object_scalars.insert(
            context.magnet_name.clone(),
            std::collections::HashMap::from([
                ("e_ex".to_string(), local_exchange_energy),
                ("e_demag".to_string(), local_demag_energy),
                ("e_ext".to_string(), local_external_energy),
                ("e_ani".to_string(), local_anisotropy_energy),
                ("e_dmi".to_string(), local_dmi_energy),
                (
                    "e_total".to_string(),
                    local_exchange_energy
                        + local_demag_energy
                        + local_external_energy
                        + local_anisotropy_energy
                        + local_dmi_energy,
                ),
                ("mx".to_string(), mx),
                ("my".to_string(), my),
                ("mz".to_string(), mz),
            ]),
        );

        magnetization.extend_from_slice(state.magnetization());
        exchange_field.extend(local_exchange);
        demag_field.extend(local_demag);
        external_field.extend(local_external);
        anisotropy_field.extend(local_anisotropy);
        dmi_field.extend(local_dmi);
        effective_field.extend(local_effective);
    }

    for values in per_object_scalars.values_mut() {
        values.insert("max_dm_dt".to_string(), max_dm_dt);
        values.insert("max_h_eff".to_string(), max_h_eff);
        values.insert("max_h_demag".to_string(), max_h_demag);
    }

    let max_torque_apm = max_torque_residual_apm_from_field(&magnetization, &effective_field);

    Ok(StateObservables {
        magnetization,
        torque_field,
        exchange_field,
        demag_field,
        external_field,
        antenna_field: vec![[0.0, 0.0, 0.0]; effective_field.len()],
        effective_field,
        anisotropy_field,
        dmi_field,
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field: Vec::new(),
        thermal_field: Vec::new(),
        exchange_energy,
        demag_energy,
        external_energy,
        anisotropy_energy,
        dmi_energy,
        total_energy: exchange_energy
            + demag_energy
            + external_energy
            + anisotropy_energy
            + dmi_energy,
        max_dm_dt,
        max_h_eff,
        max_h_demag,
        max_torque_Apm: max_torque_apm,
        per_object_scalars,
    })
}

fn step_multilayer(
    contexts: &[LayerContext],
    states: &mut [ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    dt: f64,
    integrator: IntegratorChoice,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization().to_vec())
        .collect::<Vec<_>>();
    let corrected = crate::fdm::multilayer::explicit_rk_step(&m0, dt, integrator, |m| {
        llg_rhs_multilayer(contexts, m, demag_runtime).map_err(|error| error.message)
    })
    .map_err(|message| RunError { message })?;

    for (state, new_layer) in states.iter_mut().zip(corrected.into_iter()) {
        state
            .set_magnetization(new_layer)
            .map_err(|error| RunError {
                message: format!("setting multilayer magnetization: {}", error),
            })?;
        state.time_seconds += dt;
    }
    Ok(())
}

fn llg_rhs_multilayer(
    contexts: &[LayerContext],
    magnetizations: &[Vec<[f64; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Result<Vec<Vec<[f64; 3]>>, RunError> {
    let mut states = Vec::with_capacity(contexts.len());
    for (context, magnetization) in contexts.iter().zip(magnetizations.iter()) {
        states.push(
            context
                .problem
                .new_state(magnetization.clone())
                .map_err(|error| RunError {
                    message: format!(
                        "temporary multilayer state for magnet '{}': {}",
                        context.magnet_name, error
                    ),
                })?,
        );
    }
    let mut layer_demag = compute_demag_fields(contexts, &states, demag_runtime);
    let mut rhs_layers = Vec::with_capacity(contexts.len());
    for (index, context) in contexts.iter().enumerate() {
        let state = &states[index];
        let mut local_effective =
            context
                .problem
                .observable_effective_field(state)
                .map_err(|error| RunError {
                    message: format!(
                        "local effective field for magnet '{}': {}",
                        context.magnet_name, error
                    ),
                })?;
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(local_effective[cell], local_demag[cell]);
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        rhs_layers.push(llg_rhs_for_layer(
            context,
            state.magnetization(),
            &local_effective,
        ));
    }
    Ok(rhs_layers)
}

fn compute_demag_fields(
    contexts: &[LayerContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Vec<Vec<[f64; 3]>> {
    let mut zero = contexts
        .iter()
        .map(|context| zero_vectors(context.problem.grid.cell_count()))
        .collect::<Vec<_>>();
    let Some(runtime) = demag_runtime else {
        return zero;
    };

    let mut layers = contexts
        .iter()
        .zip(states.iter())
        .map(|(context, state)| FdmLayerRuntime {
            magnet_name: context.magnet_name.clone(),
            grid: [
                context.problem.grid.nx,
                context.problem.grid.ny,
                context.problem.grid.nz,
            ],
            cell_size: [
                context.problem.cell_size.dx,
                context.problem.cell_size.dy,
                context.problem.cell_size.dz,
            ],
            origin: context.origin,
            ms: context.problem.material.saturation_magnetisation,
            exchange_stiffness: context.problem.material.exchange_stiffness,
            damping: context.problem.material.damping,
            active_mask: context.problem.active_mask.clone(),
            m: state.magnetization().to_vec(),
            h_ex: zero_vectors(context.problem.grid.cell_count()),
            h_demag: zero_vectors(context.problem.grid.cell_count()),
            h_eff: zero_vectors(context.problem.grid.cell_count()),
            conv_grid: context.convolution_grid,
            conv_cell_size: context.convolution_cell_size,
            needs_transfer: context.needs_transfer,
            transfer_boundary_policy: context.transfer_boundary_policy,
        })
        .collect::<Vec<_>>();
    runtime.compute_demag_fields(&mut layers);
    for (index, layer) in layers.into_iter().enumerate() {
        zero[index] = layer.h_demag;
    }
    zero
}

fn current_time(states: &[ExchangeLlgState]) -> f64 {
    states
        .first()
        .map(|state| state.time_seconds)
        .unwrap_or(0.0)
}

fn average_damping(contexts: &[LayerContext]) -> f64 {
    if contexts.is_empty() {
        return 0.0;
    }
    contexts
        .iter()
        .map(|context| context.problem.material.damping)
        .sum::<f64>()
        / contexts.len() as f64
}

fn flatten_layers(layers: &[Vec<[f64; 3]>]) -> Vec<[f64; 3]> {
    layers
        .iter()
        .flat_map(|layer| layer.iter().copied())
        .collect()
}

fn zero_outside_active(values: &mut [[f64; 3]], active_mask: Option<&[bool]>) {
    let Some(mask) = active_mask else {
        return;
    };
    for (value, active) in values.iter_mut().zip(mask.iter()) {
        if !active {
            *value = [0.0, 0.0, 0.0];
        }
    }
}

fn zero_vectors(count: usize) -> Vec<[f64; 3]> {
    vec![[0.0, 0.0, 0.0]; count]
}

fn llg_rhs_for_layer(
    context: &LayerContext,
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| {
            llg_rhs_from_field(
                *m,
                *h,
                context.problem.material.damping,
                context.problem.dynamics.gyromagnetic_ratio,
                context.problem.dynamics.precession_enabled,
            )
        })
        .collect()
}

fn llg_rhs_from_field(
    magnetization: [f64; 3],
    field: [f64; 3],
    damping: f64,
    gyromagnetic_ratio: f64,
    precession_enabled: bool,
) -> [f64; 3] {
    let gamma_bar = gyromagnetic_ratio / (1.0 + damping * damping);
    let precession = cross(magnetization, field);
    let damping_term = cross(magnetization, precession);
    let precession_term = if precession_enabled {
        precession
    } else {
        [0.0, 0.0, 0.0]
    };
    scale(
        add(precession_term, scale(damping_term, damping)),
        -gamma_bar,
    )
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(v: [f64; 3], factor: f64) -> [f64; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(v: [f64; 3]) -> f64 {
    dot(v, v).sqrt()
}

fn max_norm(values: &[[f64; 3]]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, FdmLayerPlanIR, FdmMaterialIR, RelaxationControlIR,
    };

    fn make_plan(enable_demag: bool) -> FdmMultilayerPlanIR {
        let layers = vec![
                FdmLayerPlanIR {
                    magnet_name: "free".to_string(),
                    native_grid: [4, 4, 1],
                    native_cell_size: [2e-9, 2e-9, 1e-9],
                    native_origin: [-4e-9, -4e-9, 0.0],
                    native_active_mask: None,
                    initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
                    material: FdmMaterialIR {
                        name: "Py".to_string(),
                        saturation_magnetisation: 800e3,
                        exchange_stiffness: 13e-12,
                        damping: 0.1,
                        ..Default::default()
                    },
                    convolution_grid: [4, 4, 1],
                    convolution_cell_size: [2e-9, 2e-9, 1e-9],
                    convolution_origin: [-4e-9, -4e-9, 0.0],
                    transfer_kind: "identity".to_string(),
                },
                FdmLayerPlanIR {
                    magnet_name: "ref".to_string(),
                    native_grid: [4, 4, 1],
                    native_cell_size: [2e-9, 2e-9, 1e-9],
                    native_origin: [-4e-9, -4e-9, 3e-9],
                    native_active_mask: None,
                    initial_magnetization: vec![[0.0, 1.0, 0.0]; 16],
                    material: FdmMaterialIR {
                        name: "Py".to_string(),
                        saturation_magnetisation: 800e3,
                        exchange_stiffness: 13e-12,
                        damping: 0.1,
                        ..Default::default()
                    },
                    convolution_grid: [4, 4, 1],
                    convolution_cell_size: [2e-9, 2e-9, 1e-9],
                    convolution_origin: [-4e-9, -4e-9, 3e-9],
                    transfer_kind: "identity".to_string(),
                },
            ];
        let mut plan = FdmMultilayerPlanIR {
            mode: "two_d_stack".to_string(),
            common_cells: [4, 4, 1],
            grid_certificate: None,
            resolved_periodic_images: None,
            layers,
            enable_exchange: true,
            enable_demag,
            external_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            field_refresh: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-4),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_relaxation_time_s: None,
                },
            }),
            planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                eligibility: "eligible".to_string(),
                estimated_pair_kernels: 4,
                estimated_unique_kernels: 3,
                estimated_kernel_bytes: 36_864,
                warnings: Vec::new(),
            },
        };
        let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens(&plan.layers);
        plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
                [-4e-9, -4e-9, 0.0],
                [4, 4, 1],
                [2e-9, 2e-9, 1e-9],
                16,
                16 * fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
                None,
                &topology_tokens,
            )
            .expect("test certificate should be valid"),
        );
        plan
    }

    #[test]
    fn multilayer_reference_run_executes_two_layers() {
        let plan = make_plan(true);
        let executed = execute_reference_fdm_multilayer(&plan, 2e-13, &[], None, None)
            .expect("multilayer run should execute");
        assert_eq!(executed.result.status, RunStatus::Completed);
        assert_eq!(executed.result.final_magnetization.len(), 32);
        assert!(!executed.result.steps.is_empty());
        assert!(executed.result.steps.last().unwrap().e_demag.is_finite());
    }

    #[test]
    fn multilayer_exchange_only_has_zero_demag_energy() {
        let plan = make_plan(false);
        let executed = execute_reference_fdm_multilayer(&plan, 1e-13, &[], None, None)
            .expect("exchange-only multilayer run should execute");
        let final_step = executed.result.steps.last().unwrap();
        assert!(final_step.e_demag.abs() < 1e-30);
    }

    #[test]
    fn multilayer_reference_cpu_includes_global_dmi_in_observables_and_rhs() {
        let mut plan = make_plan(false);
        plan.enable_exchange = false;
        plan.interfacial_dmi = Some(1.5e-3);
        plan.bulk_dmi = Some(2.5e-3);
        let layer_nx = plan.layers[0].native_grid[0] as usize;
        for (index, value) in plan.layers[0].initial_magnetization.iter_mut().enumerate() {
            let x = (index % layer_nx) as f64;
            let angle = 0.35 * x;
            *value = [angle.cos(), 0.0, angle.sin()];
        }

        let (contexts, states) =
            build_contexts_and_states(&plan, fullmag_engine::TimeIntegrator::Heun, false)
                .expect("DMI multilayer contexts should build");
        let observables =
            observe_multilayer(&contexts, &states, None).expect("DMI observables should compute");
        assert_eq!(observables.dmi_field.len(), 32);
        assert!(
            max_norm(&observables.dmi_field) > 0.0,
            "global DMI must contribute an observable multilayer field"
        );
        assert!(
            observables.dmi_energy.abs() > 0.0,
            "global DMI must contribute multilayer energy"
        );

        let magnetizations = states
            .iter()
            .map(|state| state.magnetization().to_vec())
            .collect::<Vec<_>>();
        let rhs = llg_rhs_multilayer(&contexts, &magnetizations, None)
            .expect("DMI multilayer RHS should compute");
        assert!(
            rhs.iter().any(|layer| max_norm(layer) > 0.0),
            "global DMI must contribute to the multilayer RHS"
        );
    }

    #[test]
    fn multilayer_reference_cpu_exposes_layer_anisotropy_field_outputs() {
        let mut plan = make_plan(false);
        let tilted = [
            std::f64::consts::FRAC_1_SQRT_2,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
        ];
        for layer in &mut plan.layers {
            layer.initial_magnetization.fill(tilted);
            layer.material.uniaxial_anisotropy_ku1 = Some(4.0e5);
            layer.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
        }

        let (contexts, states) =
            build_contexts_and_states(&plan, fullmag_engine::TimeIntegrator::Heun, false)
                .expect("anisotropy multilayer contexts should build");
        let observables = observe_multilayer(&contexts, &states, None)
            .expect("anisotropy observables should compute");
        assert_eq!(observables.anisotropy_field.len(), 32);
        assert!(
            max_norm(&observables.anisotropy_field) > 0.0,
            "layer anisotropy must contribute an observable multilayer field"
        );

        let selected = select_state_observable_field(&observables, "H_ani", false)
            .expect("H_ani should be selectable from multilayer observables");
        assert_eq!(selected, observables.anisotropy_field);
    }
}
