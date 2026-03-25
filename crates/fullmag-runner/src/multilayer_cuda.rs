//! CUDA-assisted runner for public multilayer / multi-body FDM problems.
//!
//! Current scope:
//! - body-local exchange / local field observables on CUDA per layer,
//! - global cross-body demag via the existing multilayer convolution runtime,
//! - synchronous Heun stepping on the host,
//! - scalar traces and concatenated field snapshots.

use fullmag_engine::{
    multilayer::{FdmLayerRuntime, KernelPair, MultilayerDemagRuntime},
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig,
    MaterialParameters, MU0,
};
use fullmag_fdm_demag::{compute_exact_self_kernel, compute_shifted_kernel};
use fullmag_ir::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR,
    FdmMultilayerPlanIR, FdmPlanIR, GridDimensions, IntegratorChoice, OutputIR,
};

use crate::native_fdm::{is_cuda_available, NativeFdmBackend};
use crate::relaxation::relaxation_converged;
use crate::schedules::{
    collect_field_schedules, collect_scalar_schedules, is_due, OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, RunError, RunResult, RunStatus,
    StateObservables, StepStats, StepUpdate,
};

use std::time::Instant;

#[derive(Debug, Clone)]
struct LayerContext {
    magnet_name: String,
    origin: [f64; 3],
    convolution_grid: [usize; 3],
    convolution_cell_size: [f64; 3],
    needs_transfer: bool,
    problem: ExchangeLlgProblem,
}

struct LayerGpuContext {
    backend: NativeFdmBackend,
    cell_count: usize,
}

pub(crate) fn execute_cuda_fdm_multilayer(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_impl(
        plan,
        until_seconds,
        outputs,
        None::<(&[u32; 3], &mut dyn FnMut(StepUpdate))>,
    )
}

pub(crate) fn execute_cuda_fdm_multilayer_with_callback(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    on_step: &mut impl FnMut(StepUpdate),
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_impl(
        plan,
        until_seconds,
        outputs,
        Some((&plan.common_cells, on_step)),
    )
}

fn execute_cuda_fdm_multilayer_impl(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate))>,
) -> Result<ExecutedRun, RunError> {
    if !is_cuda_available() {
        return Err(RunError {
            message: "FULLMAG_FDM_EXECUTION=cuda requested for multilayer FDM, but CUDA backend is not available".to_string(),
        });
    }
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    if plan.precision != ExecutionPrecision::Double {
        return Err(RunError {
            message: "CUDA-assisted multilayer FDM runner currently supports only double precision".to_string(),
        });
    }
    if plan.integrator != IntegratorChoice::Heun {
        return Err(RunError {
            message: "CUDA-assisted multilayer FDM runner currently supports only the heun integrator".to_string(),
        });
    }

    let (contexts, mut states) = build_contexts_and_states(plan)?;
    let mut gpu_contexts = build_gpu_contexts(plan)?;
    let demag_runtime = if plan.enable_demag {
        Some(build_multilayer_demag_runtime(plan)?)
    } else {
        None
    };

    let device_info = gpu_contexts
        .first()
        .and_then(|gpu| gpu.backend.device_info().ok());

    let initial_magnetization = flatten_layers(
        &states
            .iter()
            .map(|state| state.magnetization().to_vec())
            .collect::<Vec<_>>(),
    );
    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut field_snapshots: Vec<FieldSnapshot> = Vec::new();
    let mut step_count = 0u64;

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let initial_observables =
        observe_multilayer_cuda(&contexts, &mut gpu_contexts, &states, demag_runtime.as_ref())?;
    if default_scalar_trace {
        steps.push(make_step_stats(0, 0.0, 0.0, 0, &initial_observables));
    }
    record_due_fields(
        &initial_observables,
        0,
        0.0,
        0.0,
        &mut field_schedules,
        &mut field_snapshots,
    )?;

    let mut previous_total_energy = Some(initial_observables.total_energy);
    while current_time(&states) < until_seconds {
        let dt_step = dt.min(until_seconds - current_time(&states));
        let wall_start = Instant::now();
        step_multilayer_cuda(
            &contexts,
            &mut gpu_contexts,
            &mut states,
            demag_runtime.as_ref(),
            dt_step,
        )?;
        let wall_time_ns = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        let observables =
            observe_multilayer_cuda(&contexts, &mut gpu_contexts, &states, demag_runtime.as_ref())?;
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
                .any(|schedule| is_due(latest_stats.time, schedule.next_time))
        {
            steps.push(latest_stats.clone());
            for schedule in &mut scalar_schedules {
                if is_due(latest_stats.time, schedule.next_time) {
                    schedule.next_time += schedule.every_seconds;
                }
            }
        }

        record_due_fields(
            &observables,
            latest_stats.step,
            latest_stats.time,
            latest_stats.dt,
            &mut field_schedules,
            &mut field_snapshots,
        )?;

        if let Some((grid, on_step)) = live.as_mut() {
            on_step(StepUpdate {
                stats: latest_stats.clone(),
                grid: [grid[0], grid[1], grid[2]],
                fem_mesh: None,
                magnetization: None,
                finished: false,
            });
        }

        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            latest_stats.step >= control.max_steps
                || relaxation_converged(
                    control,
                    &latest_stats,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    average_damping(&contexts),
                )
        });
        previous_total_energy = Some(latest_stats.e_total);
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables =
        observe_multilayer_cuda(&contexts, &mut gpu_contexts, &states, demag_runtime.as_ref())?;
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
        steps.push(final_stats.clone());
    }
    for schedule in &mut field_schedules {
        let values = select_field_values(&final_observables, &schedule.name)?;
        field_snapshots.push(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        });
    }

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps,
            final_magnetization: flatten_layers(
                &states
                    .iter()
                    .map(|state| state.magnetization().to_vec())
                    .collect::<Vec<_>>(),
            ),
        },
        initial_magnetization,
        field_snapshots,
        provenance: ExecutionProvenance {
            execution_engine: "cuda_assisted_multilayer".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: if plan.enable_demag {
                Some("multilayer_tensor_fft_newell".to_string())
            } else {
                None
            },
            fft_backend: if plan.enable_demag {
                Some("rustfft".to_string())
            } else {
                None
            },
            device_name: device_info.as_ref().map(|info| info.name.clone()),
            compute_capability: device_info
                .as_ref()
                .map(|info| info.compute_capability.clone()),
            cuda_driver_version: device_info.as_ref().map(|info| info.driver_version),
            cuda_runtime_version: device_info.as_ref().map(|info| info.runtime_version),
        },
    })
}

fn build_contexts_and_states(
    plan: &FdmMultilayerPlanIR,
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
        let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, fullmag_engine::TimeIntegrator::Heun)
            .map_err(|error| RunError {
                message: format!("LLG for magnet '{}': {}", layer.magnet_name, error),
            })?;
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            cell_size,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: false,
                external_field: plan.external_field,
            },
            layer.native_active_mask.clone(),
        )
        .map_err(|error| RunError {
            message: format!("problem construction for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let state = problem
            .new_state(layer.initial_magnetization.clone())
            .map_err(|error| RunError {
                message: format!("state construction for magnet '{}': {}", layer.magnet_name, error),
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
            problem,
        });
    }

    Ok((contexts, states))
}

fn build_gpu_contexts(plan: &FdmMultilayerPlanIR) -> Result<Vec<LayerGpuContext>, RunError> {
    plan.layers
        .iter()
        .map(|layer| {
            let single_plan = single_layer_cuda_plan(plan, layer);
            let cell_count = layer.initial_magnetization.len();
            Ok(LayerGpuContext {
                backend: NativeFdmBackend::create(&single_plan)?,
                cell_count,
            })
        })
        .collect()
}

fn single_layer_cuda_plan(plan: &FdmMultilayerPlanIR, layer: &FdmLayerPlanIR) -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions {
            cells: layer.native_grid,
        },
        cell_size: layer.native_cell_size,
        region_mask: vec![0; layer.initial_magnetization.len()],
        active_mask: layer.native_active_mask.clone(),
        initial_magnetization: layer.initial_magnetization.clone(),
        material: FdmMaterialIR {
            name: layer.material.name.clone(),
            saturation_magnetisation: layer.material.saturation_magnetisation,
            exchange_stiffness: layer.material.exchange_stiffness,
            damping: layer.material.damping,
        },
        enable_exchange: plan.enable_exchange,
        enable_demag: false,
        external_field: None,
        gyromagnetic_ratio: plan.gyromagnetic_ratio,
        precision: plan.precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: plan.integrator,
        fixed_timestep: plan.fixed_timestep,
        relaxation: None,
    }
}

fn build_multilayer_demag_runtime(plan: &FdmMultilayerPlanIR) -> Result<MultilayerDemagRuntime, RunError> {
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

fn observe_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = compute_demag_fields(contexts, states, demag_runtime);
    let mut magnetization = Vec::new();
    let mut exchange_field = Vec::new();
    let mut demag_field = Vec::new();
    let mut external_field = Vec::new();
    let mut effective_field = Vec::new();
    let mut exchange_energy = 0.0;
    let mut demag_energy = 0.0;
    let mut external_energy = 0.0;
    let mut max_dm_dt: f64 = 0.0;
    let mut max_h_eff: f64 = 0.0;
    let mut max_h_demag: f64 = 0.0;

    for ((index, context), gpu) in contexts.iter().enumerate().zip(gpu_contexts.iter_mut()) {
        let state = &states[index];
        gpu.backend.upload_magnetization(state.magnetization())?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex(gpu.cell_count)?;
        zero_outside_active(&mut local_exchange, context.problem.active_mask.as_deref());

        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external = context.problem.external_field(state).map_err(|error| RunError {
            message: format!("external field for magnet '{}': {}", context.magnet_name, error),
        })?;
        zero_outside_active(&mut local_external, context.problem.active_mask.as_deref());
        let mut local_effective = zero_vectors(local_exchange.len());
        for cell in 0..local_effective.len() {
            local_effective[cell] =
                add(add(local_exchange[cell], local_demag[cell]), local_external[cell]);
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer(context, state.magnetization(), &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        exchange_energy += context.problem.exchange_energy(state).map_err(|error| RunError {
            message: format!("exchange energy for magnet '{}': {}", context.magnet_name, error),
        })?;
        demag_energy += state
            .magnetization()
            .iter()
            .zip(local_demag.iter())
            .map(|(m, h)| -0.5 * MU0 * layer_ms * dot(*m, *h) * layer_cell_volume)
            .sum::<f64>();
        external_energy += state
            .magnetization()
            .iter()
            .zip(local_external.iter())
            .map(|(m, h)| -MU0 * layer_ms * dot(*m, *h) * layer_cell_volume)
            .sum::<f64>();
        max_dm_dt = max_dm_dt.max(max_norm(&rhs));
        max_h_eff = max_h_eff.max(max_norm(&local_effective));
        max_h_demag = max_h_demag.max(max_norm(&local_demag));

        magnetization.extend_from_slice(state.magnetization());
        exchange_field.extend(local_exchange);
        demag_field.extend(local_demag);
        external_field.extend(local_external);
        effective_field.extend(local_effective);
    }

    Ok(StateObservables {
        magnetization,
        exchange_field,
        demag_field,
        external_field,
        effective_field,
        exchange_energy,
        demag_energy,
        external_energy,
        total_energy: exchange_energy + demag_energy + external_energy,
        max_dm_dt,
        max_h_eff,
        max_h_demag,
    })
}

fn step_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &mut [ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    dt: f64,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization().to_vec())
        .collect::<Vec<_>>();
    let k1 = llg_rhs_multilayer_cuda(contexts, gpu_contexts, &m0, demag_runtime)?;
    let predicted = m0
        .iter()
        .zip(k1.iter())
        .map(|(layer_m, layer_k)| {
            layer_m
                .iter()
                .zip(layer_k.iter())
                .map(|(m, k)| normalized(add(*m, scale(*k, dt))))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;
    let k2 = llg_rhs_multilayer_cuda(contexts, gpu_contexts, &predicted, demag_runtime)?;
    let corrected = m0
        .iter()
        .zip(k1.iter().zip(k2.iter()))
        .map(|(layer_m, (layer_k1, layer_k2))| {
            layer_m
                .iter()
                .zip(layer_k1.iter().zip(layer_k2.iter()))
                .map(|(m, (rhs1, rhs2))| normalized(add(*m, scale(add(*rhs1, *rhs2), 0.5 * dt))))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;

    for (state, new_layer) in states.iter_mut().zip(corrected.into_iter()) {
        state.set_magnetization(new_layer).map_err(|error| RunError {
            message: format!("setting multilayer magnetization: {}", error),
        })?;
        state.time_seconds += dt;
    }
    Ok(())
}

fn llg_rhs_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
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
    for ((context, gpu), state) in contexts.iter().zip(gpu_contexts.iter_mut()).zip(states.iter()) {
        gpu.backend.upload_magnetization(state.magnetization())?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex(gpu.cell_count)?;
        zero_outside_active(&mut local_exchange, context.problem.active_mask.as_deref());
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external = context.problem.external_field(state).map_err(|error| RunError {
            message: format!("external field for magnet '{}': {}", context.magnet_name, error),
        })?;
        zero_outside_active(&mut local_external, context.problem.active_mask.as_deref());
        let mut local_effective = zero_vectors(local_exchange.len());
        for cell in 0..local_effective.len() {
            local_effective[cell] =
                add(add(local_exchange[cell], local_demag[cell]), local_external[cell]);
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        rhs_layers.push(llg_rhs_for_layer(context, state.magnetization(), &local_effective));
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
        })
        .collect::<Vec<_>>();
    runtime.compute_demag_fields(&mut layers);
    for (index, layer) in layers.into_iter().enumerate() {
        zero[index] = layer.h_demag;
    }
    zero
}

fn record_due_fields(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    field_schedules: &mut [OutputSchedule],
    field_snapshots: &mut Vec<FieldSnapshot>,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        field_snapshots.push(FieldSnapshot {
            name: name.clone(),
            step,
            time,
            solver_dt,
            values: select_field_values(observables, &name)?,
        });
    }
    for schedule in field_schedules {
        if is_due(time, schedule.next_time) {
            schedule.next_time += schedule.every_seconds;
        }
    }
    Ok(())
}

fn select_field_values(observables: &StateObservables, name: &str) -> Result<Vec<[f64; 3]>, RunError> {
    Ok(match name {
        "m" => observables.magnetization.clone(),
        "H_ex" => observables.exchange_field.clone(),
        "H_demag" => observables.demag_field.clone(),
        "H_ext" => observables.external_field.clone(),
        "H_eff" => observables.effective_field.clone(),
        other => {
            return Err(RunError {
                message: format!("unsupported multilayer field snapshot '{}'", other),
            })
        }
    })
}

fn current_time(states: &[ExchangeLlgState]) -> f64 {
    states.first().map(|state| state.time_seconds).unwrap_or(0.0)
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
    layers.iter().flat_map(|layer| layer.iter().copied()).collect()
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
) -> StepStats {
    StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        wall_time_ns,
    }
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
        .map(|(m, h)| llg_rhs_from_field(*m, *h, context.problem.material.damping, context.problem.dynamics.gyromagnetic_ratio))
        .collect()
}

fn llg_rhs_from_field(
    magnetization: [f64; 3],
    field: [f64; 3],
    damping: f64,
    gyromagnetic_ratio: f64,
) -> [f64; 3] {
    let gamma_bar = gyromagnetic_ratio / (1.0 + damping * damping);
    let precession = cross(magnetization, field);
    let damping_term = cross(magnetization, precession);
    scale(add(precession, scale(damping_term, damping)), -gamma_bar)
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

fn normalized(v: [f64; 3]) -> Result<[f64; 3], String> {
    let length = norm(v);
    if length <= 1e-30 {
        if v == [0.0, 0.0, 0.0] {
            return Ok(v);
        }
        return Err("magnetization vector collapsed to zero during multilayer step".to_string());
    }
    Ok([v[0] / length, v[1] / length, v[2] / length])
}

#[cfg(all(test, feature = "cuda"))]
mod tests {
    use super::*;
    use crate::multilayer_reference;
    use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

    fn make_plan(enable_demag: bool) -> FdmMultilayerPlanIR {
        FdmMultilayerPlanIR {
            mode: "two_d_stack".to_string(),
            common_cells: [4, 4, 1],
            layers: vec![
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
                    },
                    convolution_grid: [4, 4, 1],
                    convolution_cell_size: [2e-9, 2e-9, 1e-9],
                    convolution_origin: [-4e-9, -4e-9, 3e-9],
                    transfer_kind: "identity".to_string(),
                },
            ],
            enable_exchange: true,
            enable_demag,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                torque_tolerance: 1e-4,
                energy_tolerance: None,
                max_steps: 10,
            }),
            planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                eligibility: "eligible".to_string(),
                estimated_pair_kernels: 4,
                estimated_unique_kernels: 3,
                estimated_kernel_bytes: 0,
                warnings: Vec::new(),
            },
        }
    }

    #[test]
    fn cuda_assisted_multilayer_tracks_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!("skipping cuda-assisted multilayer test: CUDA backend is not available");
            return;
        }

        let plan = make_plan(true);
        let cpu = multilayer_reference::execute_reference_fdm_multilayer(&plan, 2e-13, &[])
            .expect("cpu multilayer");
        let cuda = execute_cuda_fdm_multilayer(&plan, 2e-13, &[])
            .expect("cuda-assisted multilayer");

        let cpu_final = cpu.result.steps.last().expect("cpu final");
        let cuda_final = cuda.result.steps.last().expect("cuda final");
        let rel_gap = (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs().max(1e-30);
        assert!(
            rel_gap < 5e-3,
            "cuda-assisted multilayer should stay close to cpu reference; rel_gap={rel_gap} cpu={} cuda={}",
            cpu_final.e_total,
            cuda_final.e_total
        );
    }
}
