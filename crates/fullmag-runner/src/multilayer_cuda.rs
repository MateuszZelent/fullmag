//! CUDA-assisted runner for public multilayer / multi-body FDM problems.
//!
//! Current scope:
//! - body-local exchange / local field observables on CUDA per layer,
//! - global cross-body demag via the existing multilayer convolution runtime,
//! - synchronous Heun stepping on the host,
//! - scalar traces and concatenated field snapshots.

use fullmag_engine::{
    multilayer::{
        FdmLayerRuntime, FdmLayerRuntimeF32, KernelPair, KernelPairF32, MultilayerDemagRuntime,
        MultilayerDemagRuntimeF32,
    },
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig,
    MaterialParameters, MU0,
};
use fullmag_fdm_demag::{compute_exact_self_kernel, compute_shifted_kernel};
use fullmag_ir::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR,
    FdmMultilayerPlanIR, FdmPlanIR, GridDimensions, IntegratorChoice, OutputIR,
};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::native_fdm::{is_cuda_available, NativeFdmBackend};
use crate::relaxation::{llg_overdamped_uses_pure_damping, relaxation_converged};
use crate::scalar_metrics::apply_average_m_to_step_stats;
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
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
    problem: ExchangeLlgProblem,
}

struct LayerGpuContext {
    backend: NativeFdmBackend,
    cell_count: usize,
}

#[derive(Debug, Clone)]
struct LayerStateSingle {
    magnetization: Vec<[f32; 3]>,
    time_seconds: f64,
}

#[derive(Debug, Clone)]
struct NativeStackedLayer {
    native_grid: [usize; 3],
    offset: [usize; 3],
}

struct NativeStackedCudaPlan {
    combined_plan: FdmPlanIR,
    layers: Vec<NativeStackedLayer>,
    global_grid: [u32; 3],
}

#[allow(dead_code)]
pub(crate) fn execute_cuda_fdm_multilayer(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_streaming(plan, until_seconds, outputs, None)
}

pub(crate) fn execute_cuda_fdm_multilayer_streaming(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_impl(
        plan,
        until_seconds,
        outputs,
        None::<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
        artifact_writer,
    )
}

#[allow(dead_code)]
pub(crate) fn execute_cuda_fdm_multilayer_with_callback(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_with_callback_streaming(plan, until_seconds, outputs, None, on_step)
}

pub(crate) fn execute_cuda_fdm_multilayer_with_callback_streaming(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    artifact_writer: Option<ArtifactPipelineSender>,
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_impl(
        plan,
        until_seconds,
        outputs,
        Some((&plan.common_cells, on_step)),
        artifact_writer,
    )
}

fn execute_cuda_fdm_multilayer_impl(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
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
    // DP45/ABM3/Heun all supported by native CUDA backend
    match plan.integrator {
        IntegratorChoice::Heun
        | IntegratorChoice::Rk45
        | IntegratorChoice::Rk23
        | IntegratorChoice::Abm3 => {}
        other => {
            return Err(RunError {
                message: format!(
                    "CUDA-assisted multilayer FDM runner does not support integrator {:?}",
                    other
                ),
            });
        }
    }
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());

    if let Some(native_stacked) = build_native_stacked_cuda_plan(plan)? {
        return execute_native_stacked_cuda_multilayer(
            plan,
            &native_stacked,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        );
    }

    let gpu_contexts = build_gpu_contexts(plan)?;
    match plan.precision {
        ExecutionPrecision::Double => {
            let (contexts, states) = build_contexts_and_states(plan, pure_damping_relax)?;
            let demag_runtime = if plan.enable_demag {
                Some(build_multilayer_demag_runtime(plan)?)
            } else {
                None
            };
            execute_cuda_assisted_multilayer_double(
                plan,
                until_seconds,
                outputs,
                live,
                artifact_writer,
                pure_damping_relax,
                contexts,
                states,
                gpu_contexts,
                demag_runtime,
            )
        }
        ExecutionPrecision::Single => {
            let (contexts, states) = build_contexts_and_states(plan, pure_damping_relax)?;
            let demag_runtime = if plan.enable_demag {
                Some(build_multilayer_demag_runtime_f32(plan)?)
            } else {
                None
            };
            let single_states = states
                .into_iter()
                .map(|state| LayerStateSingle {
                    magnetization: to_f32_vectors(state.magnetization()),
                    time_seconds: state.time_seconds,
                })
                .collect::<Vec<_>>();
            execute_cuda_assisted_multilayer_single(
                plan,
                until_seconds,
                outputs,
                live,
                artifact_writer,
                pure_damping_relax,
                contexts,
                single_states,
                gpu_contexts,
                demag_runtime,
            )
        }
    }
}

fn build_contexts_and_states(
    plan: &FdmMultilayerPlanIR,
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
        let dynamics = LlgConfig::new(
            plan.gyromagnetic_ratio,
            fullmag_engine::TimeIntegrator::Heun,
        )
        .map_err(|error| RunError {
            message: format!("LLG for magnet '{}': {}", layer.magnet_name, error),
        })?
        .with_precession_enabled(!pure_damping_relax);
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
            message: format!(
                "problem construction for magnet '{}': {}",
                layer.magnet_name, error
            ),
        })?;
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

fn execute_cuda_assisted_multilayer_double(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
    pure_damping_relax: bool,
    contexts: Vec<LayerContext>,
    mut states: Vec<ExchangeLlgState>,
    mut gpu_contexts: Vec<LayerGpuContext>,
    demag_runtime: Option<MultilayerDemagRuntime>,
) -> Result<ExecutedRun, RunError> {
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
    let mut step_count = 0u64;
    let provenance = assisted_multilayer_provenance(plan, device_info.clone());
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let initial_observables = observe_multilayer_cuda(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
    )?;
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

    let mut previous_total_energy = Some(initial_observables.total_energy);
    let mut cancelled = false;
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

        let observables = observe_multilayer_cuda(
            &contexts,
            &mut gpu_contexts,
            &states,
            demag_runtime.as_ref(),
        )?;
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
                stats: latest_stats.clone(),
                grid: [grid[0], grid[1], grid[2]],
                fem_mesh: None,
                magnetization: None,
                preview_field: None,
                scalar_row_due: false,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
            }
        }

        if cancelled {
            break;
        }

        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            latest_stats.step >= control.max_steps
                || relaxation_converged(
                    control,
                    &latest_stats,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    average_damping(&contexts),
                    pure_damping_relax,
                )
        });
        previous_total_energy = Some(latest_stats.e_total);
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables = observe_multilayer_cuda(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
    )?;
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
        let values = select_field_values(&final_observables, &schedule.name)?;
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        })?;
    }

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();

    Ok(ExecutedRun {
        result: RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
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
        field_snapshot_count,
        provenance,
    })
}

fn execute_cuda_assisted_multilayer_single(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
    pure_damping_relax: bool,
    contexts: Vec<LayerContext>,
    mut states: Vec<LayerStateSingle>,
    mut gpu_contexts: Vec<LayerGpuContext>,
    demag_runtime: Option<MultilayerDemagRuntimeF32>,
) -> Result<ExecutedRun, RunError> {
    let device_info = gpu_contexts
        .first()
        .and_then(|gpu| gpu.backend.device_info().ok());

    let initial_magnetization = flatten_layers_single(&states);
    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count = 0u64;
    let provenance = assisted_multilayer_provenance(plan, device_info.clone());
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let initial_observables = observe_multilayer_cuda_single(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
    )?;
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

    let mut previous_total_energy = Some(initial_observables.total_energy);
    let mut cancelled = false;
    while current_time_single(&states) < until_seconds {
        let dt_step = dt.min(until_seconds - current_time_single(&states));
        let wall_start = Instant::now();
        step_multilayer_cuda_single(
            &contexts,
            &mut gpu_contexts,
            &mut states,
            demag_runtime.as_ref(),
            dt_step,
        )?;
        let wall_time_ns = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        let observables = observe_multilayer_cuda_single(
            &contexts,
            &mut gpu_contexts,
            &states,
            demag_runtime.as_ref(),
        )?;
        let latest_stats = make_step_stats(
            step_count,
            current_time_single(&states),
            dt_step,
            wall_time_ns,
            &observables,
        );

        if default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(latest_stats.time, schedule.next_time))
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
                stats: latest_stats.clone(),
                grid: [grid[0], grid[1], grid[2]],
                fem_mesh: None,
                magnetization: None,
                preview_field: None,
                scalar_row_due: false,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
            }
        }

        if cancelled {
            break;
        }

        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            latest_stats.step >= control.max_steps
                || relaxation_converged(
                    control,
                    &latest_stats,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    average_damping(&contexts),
                    pure_damping_relax,
                )
        });
        previous_total_energy = Some(latest_stats.e_total);
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables = observe_multilayer_cuda_single(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
    )?;
    let final_stats = make_step_stats(
        step_count,
        current_time_single(&states),
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
        let values = select_field_values(&final_observables, &schedule.name)?;
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        })?;
    }

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();

    Ok(ExecutedRun {
        result: RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: flatten_layers_single(&states),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        provenance,
    })
}

fn assisted_multilayer_provenance(
    plan: &FdmMultilayerPlanIR,
    device_info: Option<crate::native_fdm::DeviceInfo>,
) -> ExecutionProvenance {
    ExecutionProvenance {
        execution_engine: "cuda_assisted_multilayer".to_string(),
        precision: precision_name(plan.precision).to_string(),
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
    }
}

fn build_native_stacked_cuda_plan(
    plan: &FdmMultilayerPlanIR,
) -> Result<Option<NativeStackedCudaPlan>, RunError> {
    let Some(first_layer) = plan.layers.first() else {
        return Ok(None);
    };

    let reference_material = &first_layer.material;
    let reference_cell_size = first_layer.native_cell_size;
    if plan.layers.iter().any(|layer| {
        layer.material != *reference_material || layer.native_cell_size != reference_cell_size
    }) {
        return Ok(None);
    }

    let mut min_origin = first_layer.native_origin;
    let mut max_extent = [
        first_layer.native_origin[0] + first_layer.native_grid[0] as f64 * reference_cell_size[0],
        first_layer.native_origin[1] + first_layer.native_grid[1] as f64 * reference_cell_size[1],
        first_layer.native_origin[2] + first_layer.native_grid[2] as f64 * reference_cell_size[2],
    ];
    for layer in plan.layers.iter().skip(1) {
        for axis in 0..3 {
            min_origin[axis] = min_origin[axis].min(layer.native_origin[axis]);
            max_extent[axis] = max_extent[axis].max(
                layer.native_origin[axis]
                    + layer.native_grid[axis] as f64 * reference_cell_size[axis],
            );
        }
    }

    let mut global_grid = [0u32; 3];
    for axis in 0..3 {
        let cells = (max_extent[axis] - min_origin[axis]) / reference_cell_size[axis];
        let rounded = cells.round();
        if (cells - rounded).abs() > 1e-6 || rounded < 1.0 {
            return Ok(None);
        }
        global_grid[axis] = rounded as u32;
    }

    let global_grid_usize = [
        global_grid[0] as usize,
        global_grid[1] as usize,
        global_grid[2] as usize,
    ];
    let total_cells = global_grid_usize[0] * global_grid_usize[1] * global_grid_usize[2];
    let mut active_mask = vec![false; total_cells];
    let mut region_mask = vec![0u32; total_cells];
    let mut initial_magnetization = vec![[0.0, 0.0, 0.0]; total_cells];
    let mut layers = Vec::with_capacity(plan.layers.len());

    for (layer_index, layer) in plan.layers.iter().enumerate() {
        let native_grid = [
            layer.native_grid[0] as usize,
            layer.native_grid[1] as usize,
            layer.native_grid[2] as usize,
        ];
        let mut offset = [0usize; 3];
        for axis in 0..3 {
            let offset_cells =
                (layer.native_origin[axis] - min_origin[axis]) / reference_cell_size[axis];
            let rounded = offset_cells.round();
            if (offset_cells - rounded).abs() > 1e-6 || rounded < 0.0 {
                return Ok(None);
            }
            offset[axis] = rounded as usize;
        }

        for z in 0..native_grid[2] {
            for y in 0..native_grid[1] {
                for x in 0..native_grid[0] {
                    let local_index = z * native_grid[1] * native_grid[0] + y * native_grid[0] + x;
                    let is_active = layer
                        .native_active_mask
                        .as_ref()
                        .map_or(true, |mask| mask[local_index]);
                    if !is_active {
                        continue;
                    }

                    let gx = offset[0] + x;
                    let gy = offset[1] + y;
                    let gz = offset[2] + z;
                    if gx >= global_grid_usize[0]
                        || gy >= global_grid_usize[1]
                        || gz >= global_grid_usize[2]
                    {
                        return Ok(None);
                    }
                    let global_index = gz * global_grid_usize[1] * global_grid_usize[0]
                        + gy * global_grid_usize[0]
                        + gx;
                    if active_mask[global_index] {
                        return Err(RunError {
                            message: format!(
                                "native single-grid multilayer CUDA fast path encountered overlapping active cells between bodies near global cell ({gx}, {gy}, {gz})"
                            ),
                        });
                    }
                    active_mask[global_index] = true;
                    region_mask[global_index] = (layer_index + 1) as u32;
                    initial_magnetization[global_index] = layer.initial_magnetization[local_index];
                }
            }
        }

        layers.push(NativeStackedLayer {
            native_grid,
            offset,
        });
    }

    Ok(Some(NativeStackedCudaPlan {
        combined_plan: FdmPlanIR {
            grid: GridDimensions { cells: global_grid },
            cell_size: reference_cell_size,
            region_mask,
            active_mask: Some(active_mask),
            initial_magnetization,
            material: reference_material.clone(),
            enable_exchange: plan.enable_exchange,
            enable_demag: plan.enable_demag,
            external_field: plan.external_field,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precision: plan.precision,
            exchange_bc: plan.exchange_bc,
            integrator: plan.integrator,
            fixed_timestep: plan.fixed_timestep,
            adaptive_timestep: None,
            relaxation: plan.relaxation.clone(),
            boundary_correction: None,
            boundary_geometry: None,
            inter_region_exchange: vec![],
        },
        layers,
        global_grid,
    }))
}

fn execute_native_stacked_cuda_multilayer(
    plan: &FdmMultilayerPlanIR,
    native: &NativeStackedCudaPlan,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    let mut backend = NativeFdmBackend::create(&native.combined_plan)?;
    let device_info = backend.device_info().ok();
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let mut steps: Vec<StepStats> = Vec::new();
    let provenance = ExecutionProvenance {
        execution_engine: "cuda_native_multilayer_single_grid".to_string(),
        precision: precision_name(native.combined_plan.precision).to_string(),
        demag_operator_kind: if native.combined_plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if native.combined_plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: device_info.as_ref().map(|info| info.name.clone()),
        compute_capability: device_info
            .as_ref()
            .map(|info| info.compute_capability.clone()),
        cuda_driver_version: device_info.as_ref().map(|info| info.driver_version),
        cuda_runtime_version: device_info.as_ref().map(|info| info.runtime_version),
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();
    let mut dt = native
        .combined_plan
        .fixed_timestep
        .or_else(|| {
            native
                .combined_plan
                .adaptive_timestep
                .as_ref()
                .and_then(|a| a.dt_initial)
        })
        .unwrap_or(1e-13);
    let initial_magnetization = flatten_layers(
        &plan
            .layers
            .iter()
            .map(|layer| layer.initial_magnetization.clone())
            .collect::<Vec<_>>(),
    );

    let initial_observables = observe_native_stacked_cuda(&backend, native)?;
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

    let mut previous_total_energy = Some(initial_observables.total_energy);
    let mut latest_stats: Option<StepStats> = None;
    let mut cancelled = false;
    while latest_stats.as_ref().map_or(0.0, |stats| stats.time) < until_seconds {
        let current_time = latest_stats.as_ref().map_or(0.0, |stats| stats.time);
        let dt_step = dt.min(until_seconds - current_time);
        let stats = backend.step(dt_step)?;
        if let Some(next) = stats.dt_suggested {
            dt = next;
        }
        let need_observables = default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(stats.time, schedule.next_time))
            || field_schedules
                .iter()
                .any(|schedule| is_due(stats.time, schedule.next_time))
            || live.is_some();
        let observables = if need_observables {
            Some(observe_native_stacked_cuda(&backend, native)?)
        } else {
            None
        };

        if default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(stats.time, schedule.next_time))
        {
            artifacts.record_scalar(&stats)?;
            steps.push(stats.clone());
            advance_due_schedules(&mut scalar_schedules, stats.time);
        }

        if let Some(observables) = observables.as_ref() {
            record_due_fields(
                observables,
                stats.step,
                stats.time,
                stats.dt,
                &mut field_schedules,
                &mut artifacts,
            )?;
            if let Some((_, on_step)) = live.as_mut() {
                let action = on_step(StepUpdate {
                    stats: stats.clone(),
                    grid: native.global_grid,
                    fem_mesh: None,
                    magnetization: None,
                    preview_field: None,
                    scalar_row_due: false,
                    finished: false,
                });
                if action == StepAction::Stop {
                    cancelled = true;
                }
            }
        } else if let Some((_, on_step)) = live.as_mut() {
            let action = on_step(StepUpdate {
                stats: stats.clone(),
                grid: native.global_grid,
                fem_mesh: None,
                magnetization: None,
                preview_field: None,
                scalar_row_due: false,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
            }
        }

        if cancelled {
            break;
        }

        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            stats.step >= control.max_steps
                || relaxation_converged(
                    control,
                    &stats,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    native.combined_plan.material.damping,
                    pure_damping_relax,
                )
        });
        previous_total_energy = Some(stats.e_total);
        latest_stats = Some(stats);
        if stop_for_relaxation {
            break;
        }
    }

    let final_observables = observe_native_stacked_cuda(&backend, native)?;
    let final_stats =
        latest_stats.unwrap_or_else(|| make_step_stats(0, 0.0, 0.0, 0, &final_observables));
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
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values: select_field_values(&final_observables, &schedule.name)?,
        })?;
    }

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();

    Ok(ExecutedRun {
        result: RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: final_observables.magnetization.clone(),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        provenance,
    })
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
        adaptive_timestep: None,
        relaxation: None,
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
    }
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

fn build_multilayer_demag_runtime_f32(
    plan: &FdmMultilayerPlanIR,
) -> Result<MultilayerDemagRuntimeF32, RunError> {
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
                fullmag_fdm_demag::compute_exact_self_kernel_f32(
                    conv_grid[0],
                    conv_grid[1],
                    conv_grid[2],
                    conv_cell_size[0],
                    conv_cell_size[1],
                    conv_cell_size[2],
                )
            } else {
                fullmag_fdm_demag::compute_shifted_kernel_f32(conv_grid, conv_cell_size, z_shift)
            };
            kernel_pairs.push(KernelPairF32 {
                src_layer: src_index,
                dst_layer: dst_index,
                kernel,
            });
        }
    }
    Ok(MultilayerDemagRuntimeF32::new(
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
        let mut local_external =
            context
                .problem
                .external_field(state)
                .map_err(|error| RunError {
                    message: format!(
                        "external field for magnet '{}': {}",
                        context.magnet_name, error
                    ),
                })?;
        zero_outside_active(&mut local_external, context.problem.active_mask.as_deref());
        let mut local_effective = zero_vectors(local_exchange.len());
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(
                add(local_exchange[cell], local_demag[cell]),
                local_external[cell],
            );
        }
        zero_outside_active(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer(context, state.magnetization(), &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        exchange_energy += context
            .problem
            .exchange_energy(state)
            .map_err(|error| RunError {
                message: format!(
                    "exchange energy for magnet '{}': {}",
                    context.magnet_name, error
                ),
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
        state
            .set_magnetization(new_layer)
            .map_err(|error| RunError {
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
    for ((context, gpu), state) in contexts
        .iter()
        .zip(gpu_contexts.iter_mut())
        .zip(states.iter())
    {
        gpu.backend.upload_magnetization(state.magnetization())?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex(gpu.cell_count)?;
        zero_outside_active(&mut local_exchange, context.problem.active_mask.as_deref());
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external =
            context
                .problem
                .external_field(state)
                .map_err(|error| RunError {
                    message: format!(
                        "external field for magnet '{}': {}",
                        context.magnet_name, error
                    ),
                })?;
        zero_outside_active(&mut local_external, context.problem.active_mask.as_deref());
        let mut local_effective = zero_vectors(local_exchange.len());
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(
                add(local_exchange[cell], local_demag[cell]),
                local_external[cell],
            );
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
        })
        .collect::<Vec<_>>();
    runtime.compute_demag_fields(&mut layers);
    for (index, layer) in layers.into_iter().enumerate() {
        zero[index] = layer.h_demag;
    }
    zero
}

fn observe_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &[LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = compute_demag_fields_single(contexts, states, demag_runtime);
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
        gpu.backend.upload_magnetization_f32(&state.magnetization)?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex_f32(gpu.cell_count)?;
        zero_outside_active_f32(&mut local_exchange, context.problem.active_mask.as_deref());

        let mut local_demag = layer_demag.remove(0);
        zero_outside_active_f32(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external = external_field_f32(context);
        zero_outside_active_f32(&mut local_external, context.problem.active_mask.as_deref());
        let mut local_effective = zero_vectors_f32(local_exchange.len());
        for cell in 0..local_effective.len() {
            local_effective[cell] = add_f32(
                add_f32(local_exchange[cell], local_demag[cell]),
                local_external[cell],
            );
        }
        zero_outside_active_f32(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer_f32(context, &state.magnetization, &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        exchange_energy += field_energy_from_vectors_f32(
            &state.magnetization,
            &local_exchange,
            -0.5 * MU0 * layer_ms * layer_cell_volume,
        );
        demag_energy += field_energy_from_vectors_f32(
            &state.magnetization,
            &local_demag,
            -0.5 * MU0 * layer_ms * layer_cell_volume,
        );
        external_energy += field_energy_from_vectors_f32(
            &state.magnetization,
            &local_external,
            -MU0 * layer_ms * layer_cell_volume,
        );
        max_dm_dt = max_dm_dt.max(max_norm_f32(&rhs));
        max_h_eff = max_h_eff.max(max_norm_f32(&local_effective));
        max_h_demag = max_h_demag.max(max_norm_f32(&local_demag));

        magnetization.extend(to_f64_vectors(&state.magnetization));
        exchange_field.extend(to_f64_vectors(&local_exchange));
        demag_field.extend(to_f64_vectors(&local_demag));
        external_field.extend(to_f64_vectors(&local_external));
        effective_field.extend(to_f64_vectors(&local_effective));
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

fn step_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &mut [LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
    dt: f64,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization.clone())
        .collect::<Vec<_>>();
    let k1 = llg_rhs_multilayer_cuda_single(contexts, gpu_contexts, &m0, demag_runtime)?;
    let dt_f32 = dt as f32;
    let predicted = m0
        .iter()
        .zip(k1.iter())
        .map(|(layer_m, layer_k)| {
            layer_m
                .iter()
                .zip(layer_k.iter())
                .map(|(m, k)| normalized_f32(add_f32(*m, scale_f32(*k, dt_f32))))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;
    let k2 = llg_rhs_multilayer_cuda_single(contexts, gpu_contexts, &predicted, demag_runtime)?;
    let corrected = m0
        .iter()
        .zip(k1.iter().zip(k2.iter()))
        .map(|(layer_m, (layer_k1, layer_k2))| {
            layer_m
                .iter()
                .zip(layer_k1.iter().zip(layer_k2.iter()))
                .map(|(m, (rhs1, rhs2))| {
                    normalized_f32(add_f32(*m, scale_f32(add_f32(*rhs1, *rhs2), 0.5 * dt_f32)))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| RunError { message })?;

    for (state, new_layer) in states.iter_mut().zip(corrected.into_iter()) {
        state.magnetization = new_layer;
        state.time_seconds += dt;
    }
    Ok(())
}

fn llg_rhs_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    magnetizations: &[Vec<[f32; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
) -> Result<Vec<Vec<[f32; 3]>>, RunError> {
    let mut layer_demag =
        compute_demag_fields_single_from_m(contexts, magnetizations, demag_runtime);
    let mut rhs_layers = Vec::with_capacity(contexts.len());
    for ((context, gpu), magnetization) in contexts
        .iter()
        .zip(gpu_contexts.iter_mut())
        .zip(magnetizations.iter())
    {
        gpu.backend.upload_magnetization_f32(magnetization)?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex_f32(gpu.cell_count)?;
        zero_outside_active_f32(&mut local_exchange, context.problem.active_mask.as_deref());
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active_f32(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external = external_field_f32(context);
        zero_outside_active_f32(&mut local_external, context.problem.active_mask.as_deref());
        let mut local_effective = zero_vectors_f32(local_exchange.len());
        for cell in 0..local_effective.len() {
            local_effective[cell] = add_f32(
                add_f32(local_exchange[cell], local_demag[cell]),
                local_external[cell],
            );
        }
        zero_outside_active_f32(&mut local_effective, context.problem.active_mask.as_deref());
        rhs_layers.push(llg_rhs_for_layer_f32(
            context,
            magnetization,
            &local_effective,
        ));
    }
    Ok(rhs_layers)
}

fn compute_demag_fields_single(
    contexts: &[LayerContext],
    states: &[LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
) -> Vec<Vec<[f32; 3]>> {
    compute_demag_fields_single_from_m(
        contexts,
        &states
            .iter()
            .map(|state| state.magnetization.clone())
            .collect::<Vec<_>>(),
        demag_runtime,
    )
}

fn compute_demag_fields_single_from_m(
    contexts: &[LayerContext],
    magnetizations: &[Vec<[f32; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
) -> Vec<Vec<[f32; 3]>> {
    let mut zero = contexts
        .iter()
        .map(|context| zero_vectors_f32(context.problem.grid.cell_count()))
        .collect::<Vec<_>>();
    let Some(runtime) = demag_runtime else {
        return zero;
    };

    let mut layers = contexts
        .iter()
        .zip(magnetizations.iter())
        .map(|(context, magnetization)| FdmLayerRuntimeF32 {
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
            m: magnetization.clone(),
            h_ex: zero_vectors_f32(context.problem.grid.cell_count()),
            h_demag: zero_vectors_f32(context.problem.grid.cell_count()),
            h_eff: zero_vectors_f32(context.problem.grid.cell_count()),
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

fn observe_native_stacked_cuda(
    backend: &NativeFdmBackend,
    native: &NativeStackedCudaPlan,
) -> Result<StateObservables, RunError> {
    let cell_count = native.combined_plan.initial_magnetization.len();
    let magnetization_full = backend.copy_m(cell_count)?;
    let exchange_full = backend.copy_h_ex(cell_count)?;
    let demag_full = backend.copy_h_demag(cell_count)?;
    let external_full = backend.copy_h_ext(cell_count)?;
    let effective_full = backend.copy_h_eff(cell_count)?;
    let active_mask = native.combined_plan.active_mask.as_deref();
    let cell_volume = native.combined_plan.cell_size[0]
        * native.combined_plan.cell_size[1]
        * native.combined_plan.cell_size[2];
    let ms = native.combined_plan.material.saturation_magnetisation;

    let exchange_energy = if native.combined_plan.enable_exchange {
        field_energy_from_full(
            &magnetization_full,
            &exchange_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };
    let demag_energy = if native.combined_plan.enable_demag {
        field_energy_from_full(
            &magnetization_full,
            &demag_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };
    let external_energy = if native.combined_plan.external_field.is_some() {
        field_energy_from_full(
            &magnetization_full,
            &external_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };

    Ok(StateObservables {
        magnetization: extract_native_stacked_field(&magnetization_full, native),
        exchange_field: extract_native_stacked_field(&exchange_full, native),
        demag_field: extract_native_stacked_field(&demag_full, native),
        external_field: extract_native_stacked_field(&external_full, native),
        effective_field: extract_native_stacked_field(&effective_full, native),
        exchange_energy,
        demag_energy,
        external_energy,
        total_energy: exchange_energy + demag_energy + external_energy,
        max_dm_dt: max_rhs_norm_from_full(
            &magnetization_full,
            &effective_full,
            active_mask,
            native.combined_plan.material.damping,
            native.combined_plan.gyromagnetic_ratio,
            !llg_overdamped_uses_pure_damping(native.combined_plan.relaxation.as_ref()),
        ),
        max_h_eff: max_norm_from_full(&effective_full, active_mask),
        max_h_demag: max_norm_from_full(&demag_full, active_mask),
    })
}

fn extract_native_stacked_field(
    full_field: &[[f64; 3]],
    native: &NativeStackedCudaPlan,
) -> Vec<[f64; 3]> {
    let global_grid = [
        native.global_grid[0] as usize,
        native.global_grid[1] as usize,
        native.global_grid[2] as usize,
    ];
    let mut values = Vec::new();
    for layer in &native.layers {
        for z in 0..layer.native_grid[2] {
            for y in 0..layer.native_grid[1] {
                for x in 0..layer.native_grid[0] {
                    let gx = layer.offset[0] + x;
                    let gy = layer.offset[1] + y;
                    let gz = layer.offset[2] + z;
                    let global_index =
                        gz * global_grid[1] * global_grid[0] + gy * global_grid[0] + gx;
                    values.push(full_field[global_index]);
                }
            }
        }
    }
    values
}

fn field_energy_from_full(
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
    active_mask: Option<&[bool]>,
    ms: f64,
    cell_volume: f64,
) -> f64 {
    let mut sum = 0.0;
    for index in 0..magnetization.len() {
        if active_mask.is_some_and(|mask| !mask[index]) {
            continue;
        }
        sum += -0.5 * MU0 * ms * dot(magnetization[index], field[index]) * cell_volume;
    }
    sum
}

fn max_norm_from_full(values: &[[f64; 3]], active_mask: Option<&[bool]>) -> f64 {
    values
        .iter()
        .enumerate()
        .filter(|(index, _)| active_mask.is_none_or(|mask| mask[*index]))
        .map(|(_, value)| norm(*value))
        .fold(0.0, f64::max)
}

fn max_rhs_norm_from_full(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
    active_mask: Option<&[bool]>,
    damping: f64,
    gyromagnetic_ratio: f64,
    precession_enabled: bool,
) -> f64 {
    magnetization
        .iter()
        .zip(effective_field.iter())
        .enumerate()
        .filter(|(index, _)| active_mask.is_none_or(|mask| mask[*index]))
        .map(|(_, (m, h))| {
            norm(llg_rhs_from_field(
                *m,
                *h,
                damping,
                gyromagnetic_ratio,
                precession_enabled,
            ))
        })
        .fold(0.0, f64::max)
}

fn record_due_fields(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time,
            solver_dt,
            values: select_field_values(observables, &name)?,
        })?;
    }
    advance_due_schedules(field_schedules, time);
    Ok(())
}

fn select_field_values(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    // Handle component-qualified names from fm.snapshot(), e.g. "m.z"
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let comp = &name[dot_pos + 1..];
        let full = select_base_field(observables, base)?;
        let idx = match comp {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            _ => {
                return Err(RunError {
                    message: format!("unsupported snapshot component '{}' in '{}'", comp, name),
                })
            }
        };
        // Store extracted scalar in x-component, zero the rest
        return Ok(full.iter().map(|v| [v[idx], 0.0, 0.0]).collect());
    }
    select_base_field(observables, name)
}

fn select_base_field(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
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
    states
        .first()
        .map(|state| state.time_seconds)
        .unwrap_or(0.0)
}

fn current_time_single(states: &[LayerStateSingle]) -> f64 {
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

fn flatten_layers_single(states: &[LayerStateSingle]) -> Vec<[f64; 3]> {
    states
        .iter()
        .flat_map(|state| to_f64_vectors(&state.magnetization))
        .collect()
}

fn precision_name(value: ExecutionPrecision) -> &'static str {
    match value {
        ExecutionPrecision::Single => "single",
        ExecutionPrecision::Double => "double",
    }
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
) -> StepStats {
    let mut stats = StepStats {
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
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats
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

fn zero_outside_active_f32(values: &mut [[f32; 3]], active_mask: Option<&[bool]>) {
    let Some(mask) = active_mask else {
        return;
    };
    for (value, active) in values.iter_mut().zip(mask.iter()) {
        if !active {
            *value = [0.0, 0.0, 0.0];
        }
    }
}

fn zero_vectors_f32(count: usize) -> Vec<[f32; 3]> {
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

fn llg_rhs_for_layer_f32(
    context: &LayerContext,
    magnetization: &[[f32; 3]],
    field: &[[f32; 3]],
) -> Vec<[f32; 3]> {
    let damping = context.problem.material.damping as f32;
    let gyromagnetic_ratio = context.problem.dynamics.gyromagnetic_ratio as f32;
    magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| {
            llg_rhs_from_field_f32(
                *m,
                *h,
                damping,
                gyromagnetic_ratio,
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

fn llg_rhs_from_field_f32(
    magnetization: [f32; 3],
    field: [f32; 3],
    damping: f32,
    gyromagnetic_ratio: f32,
    precession_enabled: bool,
) -> [f32; 3] {
    let gamma_bar = gyromagnetic_ratio / (1.0 + damping * damping);
    let precession = cross_f32(magnetization, field);
    let damping_term = cross_f32(magnetization, precession);
    let precession_term = if precession_enabled {
        precession
    } else {
        [0.0, 0.0, 0.0]
    };
    scale_f32(
        add_f32(precession_term, scale_f32(damping_term, damping)),
        -gamma_bar,
    )
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn add_f32(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(v: [f64; 3], factor: f64) -> [f64; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

fn scale_f32(v: [f32; 3], factor: f32) -> [f32; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn cross_f32(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn dot_f32(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(v: [f64; 3]) -> f64 {
    dot(v, v).sqrt()
}

fn norm_f32(v: [f32; 3]) -> f32 {
    dot_f32(v, v).sqrt()
}

fn max_norm(values: &[[f64; 3]]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

fn max_norm_f32(values: &[[f32; 3]]) -> f64 {
    values
        .iter()
        .map(|value| norm_f32(*value) as f64)
        .fold(0.0, f64::max)
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

fn normalized_f32(v: [f32; 3]) -> Result<[f32; 3], String> {
    let length = norm_f32(v);
    if length <= 1e-20 {
        if v == [0.0, 0.0, 0.0] {
            return Ok(v);
        }
        return Err("magnetization vector collapsed to zero during multilayer step".to_string());
    }
    Ok([v[0] / length, v[1] / length, v[2] / length])
}

fn to_f32_vectors(values: &[[f64; 3]]) -> Vec<[f32; 3]> {
    values
        .iter()
        .map(|value| [value[0] as f32, value[1] as f32, value[2] as f32])
        .collect()
}

fn to_f64_vectors(values: &[[f32; 3]]) -> Vec<[f64; 3]> {
    values
        .iter()
        .map(|value| [value[0] as f64, value[1] as f64, value[2] as f64])
        .collect()
}

fn external_field_f32(context: &LayerContext) -> Vec<[f32; 3]> {
    let external = context
        .problem
        .terms
        .external_field
        .unwrap_or([0.0, 0.0, 0.0]);
    let value = [external[0] as f32, external[1] as f32, external[2] as f32];
    (0..context.problem.grid.cell_count())
        .map(|index| {
            if context
                .problem
                .active_mask
                .as_ref()
                .is_none_or(|mask| mask[index])
            {
                value
            } else {
                [0.0, 0.0, 0.0]
            }
        })
        .collect()
}

fn field_energy_from_vectors_f32(
    magnetization: &[[f32; 3]],
    field: &[[f32; 3]],
    prefactor: f64,
) -> f64 {
    magnetization
        .iter()
        .zip(field.iter())
        .map(|(m, h)| prefactor * dot_f32(*m, *h) as f64)
        .sum()
}

#[cfg(all(test, feature = "cuda"))]
mod tests {
    use super::*;
    use crate::multilayer_reference;
    use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

    fn make_plan(enable_demag: bool, precision: ExecutionPrecision) -> FdmMultilayerPlanIR {
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
            precision,
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

    fn make_assisted_plan(
        enable_demag: bool,
        precision: ExecutionPrecision,
    ) -> FdmMultilayerPlanIR {
        let mut plan = make_plan(enable_demag, precision);
        plan.layers[1].material.name = "Py_variant".to_string();
        plan
    }

    fn make_touching_plan(precision: ExecutionPrecision) -> FdmMultilayerPlanIR {
        FdmMultilayerPlanIR {
            mode: "three_d".to_string(),
            common_cells: [2, 1, 1],
            layers: vec![
                FdmLayerPlanIR {
                    magnet_name: "bottom".to_string(),
                    native_grid: [2, 1, 1],
                    native_cell_size: [2e-9, 2e-9, 2e-9],
                    native_origin: [0.0, 0.0, 0.0],
                    native_active_mask: None,
                    initial_magnetization: vec![[1.0, 0.0, 0.0]; 2],
                    material: FdmMaterialIR {
                        name: "Py".to_string(),
                        saturation_magnetisation: 800e3,
                        exchange_stiffness: 13e-12,
                        damping: 0.1,
                    },
                    convolution_grid: [2, 1, 1],
                    convolution_cell_size: [2e-9, 2e-9, 2e-9],
                    convolution_origin: [0.0, 0.0, 0.0],
                    transfer_kind: "identity".to_string(),
                },
                FdmLayerPlanIR {
                    magnet_name: "top".to_string(),
                    native_grid: [2, 1, 1],
                    native_cell_size: [2e-9, 2e-9, 2e-9],
                    native_origin: [0.0, 0.0, 2e-9],
                    native_active_mask: None,
                    initial_magnetization: vec![[0.0, 1.0, 0.0]; 2],
                    material: FdmMaterialIR {
                        name: "Py".to_string(),
                        saturation_magnetisation: 800e3,
                        exchange_stiffness: 13e-12,
                        damping: 0.1,
                    },
                    convolution_grid: [2, 1, 1],
                    convolution_cell_size: [2e-9, 2e-9, 2e-9],
                    convolution_origin: [0.0, 0.0, 2e-9],
                    transfer_kind: "identity".to_string(),
                },
            ],
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            relaxation: None,
            planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                eligibility: "eligible".to_string(),
                estimated_pair_kernels: 4,
                estimated_unique_kernels: 1,
                estimated_kernel_bytes: 0,
                warnings: Vec::new(),
            },
        }
    }

    fn max_vector_component_diff(actual: &[[f64; 3]], expected: &[[f64; 3]]) -> f64 {
        actual
            .iter()
            .zip(expected.iter())
            .flat_map(|(a, e)| (0..3).map(move |component| (a[component] - e[component]).abs()))
            .fold(0.0, f64::max)
    }

    #[test]
    fn cuda_assisted_multilayer_tracks_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!("skipping cuda-assisted multilayer test: CUDA backend is not available");
            return;
        }

        let plan = make_plan(true, ExecutionPrecision::Double);
        let cpu = multilayer_reference::execute_reference_fdm_multilayer(&plan, 2e-13, &[])
            .expect("cpu multilayer");
        let cuda =
            execute_cuda_fdm_multilayer(&plan, 2e-13, &[]).expect("cuda-assisted multilayer");

        let cpu_final = cpu.result.steps.last().expect("cpu final");
        let cuda_final = cuda.result.steps.last().expect("cuda final");
        let rel_gap =
            (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs().max(1e-30);
        assert!(
            rel_gap < 5e-3,
            "cuda-assisted multilayer should stay close to cpu reference; rel_gap={rel_gap} cpu={} cuda={}",
            cpu_final.e_total,
            cuda_final.e_total
        );
        assert_eq!(
            cuda.provenance.execution_engine,
            "cuda_native_multilayer_single_grid"
        );
    }

    #[test]
    fn native_single_grid_multilayer_preserves_inter_body_exchange_barrier() {
        if !is_cuda_available() {
            eprintln!("skipping touching multilayer test: CUDA backend is not available");
            return;
        }

        let plan = make_touching_plan(ExecutionPrecision::Double);
        let cpu = multilayer_reference::execute_reference_fdm_multilayer(&plan, 1e-13, &[])
            .expect("cpu multilayer");
        let cuda = execute_cuda_fdm_multilayer(&plan, 1e-13, &[]).expect("cuda multilayer");

        let cpu_initial = cpu.result.steps.first().expect("cpu initial");
        let cuda_initial = cuda.result.steps.first().expect("cuda initial");
        assert!(
            cpu_initial.e_ex.abs() <= 1e-24,
            "touching CPU baseline should have zero inter-body exchange, got {}",
            cpu_initial.e_ex
        );
        assert!(
            cuda_initial.e_ex.abs() <= 1e-24,
            "native CUDA combined-grid path should keep exchange barrier across touching bodies, got {}",
            cuda_initial.e_ex
        );

        let cpu_final = cpu.result.steps.last().expect("cpu final");
        let cuda_final = cuda.result.steps.last().expect("cuda final");
        let rel_gap =
            (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs().max(1e-30);
        assert!(
            rel_gap < 5e-3,
            "touching-body native CUDA path should stay close to CPU multilayer reference; rel_gap={rel_gap} cpu={} cuda={}",
            cpu_final.e_total,
            cuda_final.e_total
        );
    }

    #[test]
    fn native_single_grid_multilayer_single_precision_stays_close_to_double_when_cuda_is_available()
    {
        if !is_cuda_available() {
            eprintln!(
                "skipping native multilayer single-precision test: CUDA backend is not available"
            );
            return;
        }

        let double_plan = make_plan(true, ExecutionPrecision::Double);
        let single_plan = make_plan(true, ExecutionPrecision::Single);
        let double_run =
            execute_cuda_fdm_multilayer(&double_plan, 2e-13, &[]).expect("double multilayer");
        let single_run =
            execute_cuda_fdm_multilayer(&single_plan, 2e-13, &[]).expect("single multilayer");

        assert_eq!(
            double_run.provenance.execution_engine,
            "cuda_native_multilayer_single_grid"
        );
        assert_eq!(
            single_run.provenance.execution_engine,
            "cuda_native_multilayer_single_grid"
        );
        assert_eq!(single_run.provenance.precision, "single");

        let max_m_diff = max_vector_component_diff(
            &single_run.result.final_magnetization,
            &double_run.result.final_magnetization,
        );
        assert!(
            max_m_diff <= 1e-5,
            "native multilayer single precision magnetization drift too large: {max_m_diff:.6e}"
        );

        let double_final = double_run.result.steps.last().expect("double final");
        let single_final = single_run.result.steps.last().expect("single final");
        let rel_gap = (single_final.e_total - double_final.e_total).abs()
            / double_final.e_total.abs().max(1e-30);
        assert!(
            rel_gap <= 1e-4,
            "native multilayer single precision total-energy drift too large: rel_gap={rel_gap}"
        );
    }

    #[test]
    fn cuda_assisted_multilayer_single_precision_stays_close_to_double_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping assisted multilayer single-precision test: CUDA backend is not available"
            );
            return;
        }

        let double_plan = make_assisted_plan(true, ExecutionPrecision::Double);
        let single_plan = make_assisted_plan(true, ExecutionPrecision::Single);
        let double_run = execute_cuda_fdm_multilayer(&double_plan, 2e-13, &[])
            .expect("double assisted multilayer");
        let single_run = execute_cuda_fdm_multilayer(&single_plan, 2e-13, &[])
            .expect("single assisted multilayer");

        assert_eq!(
            double_run.provenance.execution_engine,
            "cuda_assisted_multilayer"
        );
        assert_eq!(
            single_run.provenance.execution_engine,
            "cuda_assisted_multilayer"
        );
        assert_eq!(single_run.provenance.precision, "single");

        let max_m_diff = max_vector_component_diff(
            &single_run.result.final_magnetization,
            &double_run.result.final_magnetization,
        );
        assert!(
            max_m_diff <= 1e-5,
            "assisted multilayer single precision magnetization drift too large: {max_m_diff:.6e}"
        );

        let double_final = double_run.result.steps.last().expect("double final");
        let single_final = single_run.result.steps.last().expect("single final");
        let rel_gap = (single_final.e_total - double_final.e_total).abs()
            / double_final.e_total.abs().max(1e-30);
        assert!(
            rel_gap <= 1e-4,
            "assisted multilayer single precision total-energy drift too large: rel_gap={rel_gap}"
        );
    }
}
