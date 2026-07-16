//! CUDA-assisted runner for public multilayer / multi-body FDM problems.
//!
//! Current scope:
//! - body-local exchange / local field observables on CUDA per layer,
//! - global cross-body demag via the existing multilayer convolution runtime,
//! - fixed-step Heun/RK4/RK23 staged native v2 stepping for explicit CUDA execution,
//! - scalar traces and concatenated field snapshots.

use fullmag_engine::{
    multilayer::{
        FdmLayerRuntime, FdmLayerRuntimeF32, KernelPair, KernelPairF32, MultilayerDemagRuntime,
        MultilayerDemagRuntimeF32,
    },
    CellSize, CubicAnisotropyConfig, EffectiveFieldObservables, EffectiveFieldTerms,
    ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig, MaterialParameters,
    UniaxialAnisotropyConfig, MU0,
};
use fullmag_fdm_demag::{compute_exact_self_kernel, compute_shifted_kernel, TransferBoundaryPolicy};
use fullmag_ir::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR,
    FdmMultilayerPlanIR, FdmPlanIR, GridDimensions, IntegratorChoice, OutputIR,
};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::fdm::artifacts::select_state_observable_field;
use crate::fdm::validate_multilayer_grid_budget;
use crate::fdm::gpu::cuda::native::{is_cuda_available, DeviceInfo, NativeFdmBackend};
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

struct LayerGpuContext {
    backend: NativeFdmBackend,
    cell_count: usize,
}

struct NativeMultilayerDemagOperator {
    backend: NativeFdmBackend,
    layer_cell_counts: Vec<usize>,
}

#[derive(Debug, Clone)]
struct LayerStateSingle {
    magnetization: Vec<[f32; 3]>,
    time_seconds: f64,
}

#[derive(Debug, Clone)]
struct NativeStackedLayer {
    magnet_name: String,
    native_grid: [usize; 3],
    offset: [usize; 3],
    context: LayerContext,
}

struct NativeStackedCudaPlan {
    combined_plan: FdmPlanIR,
    layers: Vec<NativeStackedLayer>,
    global_grid: [u32; 3],
}

fn disabled_inter_body_exchange_pairs(layer_count: usize) -> Vec<(u32, u32, f64)> {
    let mut pairs = Vec::new();
    for left in 0..layer_count {
        for right in (left + 1)..layer_count {
            pairs.push(((left + 1) as u32, (right + 1) as u32, 0.0));
        }
    }
    pairs
}

#[allow(dead_code)]
pub(crate) fn execute_cuda_fdm_multilayer(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_multilayer_with_live(plan, until_seconds, outputs, None, None)
}

pub(crate) fn execute_cuda_fdm_multilayer_with_live(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<(&[u32; 3], &mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    validate_multilayer_grid_budget(plan)?;
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
    let native_stacked = resolve_cuda_multilayer_execution_shape(plan)?;
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());

    if let Some(native_stacked) = native_stacked {
        return execute_native_stacked_cuda_multilayer(
            plan,
            &native_stacked,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        );
    }

    let native_demag = build_native_multilayer_demag_operator(plan)?;
    let gpu_contexts = build_gpu_contexts(plan)?;
    match plan.precision {
        ExecutionPrecision::Double => {
            let (contexts, states) = build_contexts_and_states(plan, pure_damping_relax)?;
            let demag_runtime = if plan.enable_demag && native_demag.is_none() {
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
                native_demag,
            )
        }
        ExecutionPrecision::Single => {
            let (contexts, states) = build_contexts_and_states(plan, pure_damping_relax)?;
            let demag_runtime = if plan.enable_demag && native_demag.is_none() {
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
                native_demag,
            )
        }
    }
}

fn resolve_cuda_multilayer_execution_shape(
    plan: &FdmMultilayerPlanIR,
) -> Result<Option<NativeStackedCudaPlan>, RunError> {
    let native_stacked = build_native_stacked_cuda_plan(plan)?;
    if native_stacked.is_none()
        && !matches!(
            plan.integrator,
            IntegratorChoice::Heun | IntegratorChoice::Rk4 | IntegratorChoice::Rk23
        )
    {
        return Err(RunError {
            message: format!(
                "the staged v2 CUDA multilayer FDM runner currently supports only 'heun', 'rk4', and fixed-step 'rk23' integrators; {:?} is executable only for native single-grid-compatible multilayer stacks",
                plan.integrator
            ),
        });
    }
    Ok(native_stacked)
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

fn build_native_multilayer_demag_operator(
    plan: &FdmMultilayerPlanIR,
) -> Result<Option<NativeMultilayerDemagOperator>, RunError> {
    if !plan.enable_demag {
        return Ok(None);
    }
    if plan
        .layers
        .iter()
        .any(|layer| layer.transfer_kind != "identity")
    {
        return Ok(None);
    }

    let layer_cell_counts = plan
        .layers
        .iter()
        .map(|layer| {
            (layer.native_grid[0] as usize)
                * (layer.native_grid[1] as usize)
                * (layer.native_grid[2] as usize)
        })
        .collect::<Vec<_>>();
    Ok(Some(NativeMultilayerDemagOperator {
        backend: NativeFdmBackend::create_multilayer_v2(plan)?,
        layer_cell_counts,
    }))
}

impl NativeMultilayerDemagOperator {
    fn compute_demag_fields(
        &mut self,
        states: &[ExchangeLlgState],
    ) -> Result<Vec<Vec<[f64; 3]>>, RunError> {
        for (layer_index, state) in states.iter().enumerate() {
            self.backend
                .upload_layer_magnetization(layer_index as u32, state.magnetization())?;
        }
        self.backend.refresh_multilayer_demag()?;
        self.layer_cell_counts
            .iter()
            .enumerate()
            .map(|(layer_index, cell_count)| {
                self.backend
                    .copy_layer_h_demag(layer_index as u32, *cell_count)
            })
            .collect()
    }

    fn compute_demag_fields_f32(
        &mut self,
        states: &[LayerStateSingle],
    ) -> Result<Vec<Vec<[f32; 3]>>, RunError> {
        for (layer_index, state) in states.iter().enumerate() {
            self.backend
                .upload_layer_magnetization_f32(layer_index as u32, &state.magnetization)?;
        }
        self.backend.refresh_multilayer_demag()?;
        self.layer_cell_counts
            .iter()
            .enumerate()
            .map(|(layer_index, cell_count)| {
                self.backend
                    .copy_layer_h_demag_f32(layer_index as u32, *cell_count)
            })
            .collect()
    }
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
    mut native_demag: Option<NativeMultilayerDemagOperator>,
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
    let native_demag_enabled = native_demag.is_some();
    let provenance =
        assisted_multilayer_provenance(plan, device_info.clone(), native_demag_enabled);
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
        native_demag.as_mut(),
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

    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut cancelled = false;
    let mut paused = false;
    while current_time(&states) < until_seconds {
        let dt_step = dt.min(until_seconds - current_time(&states));
        let wall_start = Instant::now();
        step_multilayer_cuda(
            &contexts,
            &mut gpu_contexts,
            &mut states,
            demag_runtime.as_ref(),
            native_demag.as_mut(),
            dt_step,
            plan.integrator,
        )?;
        let wall_time_ns = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        let observables = observe_multilayer_cuda(
            &contexts,
            &mut gpu_contexts,
            &states,
            demag_runtime.as_ref(),
            native_demag.as_mut(),
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

    let final_observables = observe_multilayer_cuda(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
        native_demag.as_mut(),
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
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: Some(final_stats.max_torque_Apm),
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: final_stats.step,
            relaxation_time_s: Some(final_stats.time),
            numerical_stagnation: false,
        },
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
    mut native_demag: Option<NativeMultilayerDemagOperator>,
) -> Result<ExecutedRun, RunError> {
    let device_info = gpu_contexts
        .first()
        .and_then(|gpu| gpu.backend.device_info().ok());

    let initial_magnetization = flatten_layers_single(&states);
    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count = 0u64;
    let native_demag_enabled = native_demag.is_some();
    let provenance =
        assisted_multilayer_provenance(plan, device_info.clone(), native_demag_enabled);
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
        native_demag.as_mut(),
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

    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut cancelled = false;
    let mut paused = false;
    while current_time_single(&states) < until_seconds {
        let dt_step = dt.min(until_seconds - current_time_single(&states));
        let wall_start = Instant::now();
        step_multilayer_cuda_single(
            &contexts,
            &mut gpu_contexts,
            &mut states,
            demag_runtime.as_ref(),
            native_demag.as_mut(),
            dt_step,
            plan.integrator,
        )?;
        let wall_time_ns = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        let observables = observe_multilayer_cuda_single(
            &contexts,
            &mut gpu_contexts,
            &states,
            demag_runtime.as_ref(),
            native_demag.as_mut(),
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

    let final_observables = observe_multilayer_cuda_single(
        &contexts,
        &mut gpu_contexts,
        &states,
        demag_runtime.as_ref(),
        native_demag.as_mut(),
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
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: Some(final_stats.max_torque_Apm),
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: final_stats.step,
            relaxation_time_s: Some(final_stats.time),
            numerical_stagnation: false,
        },
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization: flatten_layers_single(&states),
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn assisted_multilayer_provenance(
    plan: &FdmMultilayerPlanIR,
    device_info: Option<DeviceInfo>,
    native_demag_enabled: bool,
) -> ExecutionProvenance {
    ExecutionProvenance {
        execution_engine: "cuda_assisted_multilayer".to_string(),
        precision: precision_name(plan.precision).to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some(
                if native_demag_enabled {
                    "native_multilayer_tensor_fft_newell"
                } else {
                    "multilayer_tensor_fft_newell"
                }
                .to_string(),
            )
        } else {
            None
        },
        fft_backend: if plan.enable_demag {
            Some(
                if native_demag_enabled {
                    "cuFFT"
                } else {
                    "rustfft"
                }
                .to_string(),
            )
        } else {
            None
        },
        device_name: device_info.as_ref().map(|info| info.name.clone()),
        compute_capability: device_info
            .as_ref()
            .map(|info| info.compute_capability.clone()),
        cuda_driver_version: device_info.as_ref().map(|info| info.driver_version),
        cuda_runtime_version: device_info.as_ref().map(|info| info.runtime_version),
        ..Default::default()
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
    let (layer_contexts, _) = build_contexts_and_states(plan, false)?;

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
    let total_cells = fullmag_plan::checked_fdm_grid_cost(
        global_grid,
        fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )
    .map_err(|error| RunError {
        message: format!("native stacked global grid budget rejected before allocation: {error}"),
    })
    .and_then(|cost| {
        usize::try_from(cost.cells).map_err(|_| RunError {
            message: format!(
                "native stacked global grid cell count {} is not addressable",
                cost.cells
            ),
        })
    })?;
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
            magnet_name: layer.magnet_name.clone(),
            native_grid,
            offset,
            context: layer_contexts[layer_index].clone(),
        });
    }

    Ok(Some(NativeStackedCudaPlan {
        combined_plan: FdmPlanIR {
            origin_m: min_origin,
            grid: GridDimensions { cells: global_grid },
            cell_size: reference_cell_size,
            grid_certificate: None,
            region_mask,
            active_mask: Some(active_mask),
            initial_magnetization,
            material: reference_material.clone(),
            enable_exchange: plan.enable_exchange,
            enable_demag: plan.enable_demag,
            external_field: plan.external_field,
            antenna_zeeman_masks: Vec::new(),
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precision: plan.precision,
            exchange_bc: plan.exchange_bc,
            periodicity: plan.periodicity.clone(),
            resolved_periodic_images: plan.resolved_periodic_images.clone(),
            integrator: Some(plan.integrator),
            fixed_timestep: plan.fixed_timestep,
            adaptive_timestep: None,
            field_refresh: plan.field_refresh.clone(),
            relaxation: plan.relaxation.clone(),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            boundary_geometry: None,
            inter_region_exchange: disabled_inter_body_exchange_pairs(plan.layers.len()),
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            slonczewski_formula_version: None,
            slonczewski_stack_normal: None,
            slonczewski_target: None,
            slonczewski_active_mask: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            sot_formula_version: None,
            sot_target: None,
            sot_active_mask: None,
            sot_envelope: None,
            sot_drive: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            temperature: None,
            interfacial_dmi: plan.interfacial_dmi,
            bulk_dmi: plan.bulk_dmi,
            dind_field: None,
            dbulk_field: None,
            mel_b1: None,
            mel_b2: None,
            mel_uniform_strain: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
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

    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut latest_stats: Option<StepStats> = None;
    let mut cancelled = false;
    let mut paused = false;
    while latest_stats.as_ref().map_or(0.0, |stats| stats.time) < until_seconds {
        let current_time = latest_stats.as_ref().map_or(0.0, |stats| stats.time);
        let dt_step = dt.min(until_seconds - current_time);
        let native_stats = backend.step(dt_step)?;
        if let Some(next) = native_stats.dt_suggested {
            dt = next;
        }
        let need_observables = default_scalar_trace
            || scalar_schedules
                .iter()
                .any(|schedule| is_due(native_stats.time, schedule.next_time))
            || field_schedules
                .iter()
                .any(|schedule| is_due(native_stats.time, schedule.next_time))
            || live.is_some()
            || plan.relaxation.is_some();
        let observables = if need_observables {
            Some(observe_native_stacked_cuda(&backend, native)?)
        } else {
            None
        };
        let stats = observables
            .as_ref()
            .map(|observables| make_native_stacked_step_stats(&native_stats, observables))
            .unwrap_or(native_stats);

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
                    coupled_checkpoint: None,
                    stats: stats.clone(),
                    grid: native.global_grid,
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
        } else if let Some((_, on_step)) = live.as_mut() {
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: stats.clone(),
                grid: native.global_grid,
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

        let energy_plateau_range = energy_plateau.record(stats.e_total);
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                || relaxation_converged(
                    control,
                    &stats,
                    energy_plateau_range,
                    plan.gyromagnetic_ratio,
                    native.combined_plan.material.damping,
                    pure_damping_relax,
                )
        });
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
            values: select_state_observable_field(&final_observables, &schedule.name, false)?,
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
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: Some(final_stats.max_torque_Apm),
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: final_stats.step,
            relaxation_time_s: Some(final_stats.time),
            numerical_stagnation: false,
        },
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization: final_observables.magnetization.clone(),
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn make_native_stacked_step_stats(
    native_step: &StepStats,
    observables: &StateObservables,
) -> StepStats {
    let mut stats = make_step_stats(
        native_step.step,
        native_step.time,
        native_step.dt,
        native_step.wall_time_ns,
        observables,
    );
    stats.dt_suggested = native_step.dt_suggested;
    stats
}

fn single_layer_cuda_plan(plan: &FdmMultilayerPlanIR, layer: &FdmLayerPlanIR) -> FdmPlanIR {
    FdmPlanIR {
        origin_m: layer.native_origin,
        grid: GridDimensions {
            cells: layer.native_grid,
        },
        cell_size: layer.native_cell_size,
        grid_certificate: None,
        region_mask: vec![0; layer.initial_magnetization.len()],
        active_mask: layer.native_active_mask.clone(),
        initial_magnetization: layer.initial_magnetization.clone(),
        material: FdmMaterialIR {
            name: layer.material.name.clone(),
            saturation_magnetisation: layer.material.saturation_magnetisation,
            exchange_stiffness: layer.material.exchange_stiffness,
            damping: layer.material.damping,
            uniaxial_anisotropy_ku1: layer.material.uniaxial_anisotropy_ku1,
            uniaxial_anisotropy_ku2: layer.material.uniaxial_anisotropy_ku2,
            anisotropy_axis: layer.material.anisotropy_axis,
            cubic_anisotropy_kc1: layer.material.cubic_anisotropy_kc1,
            cubic_anisotropy_kc2: layer.material.cubic_anisotropy_kc2,
            cubic_anisotropy_kc3: layer.material.cubic_anisotropy_kc3,
            cubic_anisotropy_axis1: layer.material.cubic_anisotropy_axis1,
            cubic_anisotropy_axis2: layer.material.cubic_anisotropy_axis2,
            ..Default::default()
        },
        enable_exchange: plan.enable_exchange,
        enable_demag: false,
        external_field: plan.external_field,
        antenna_zeeman_masks: Vec::new(),
        gyromagnetic_ratio: plan.gyromagnetic_ratio,
        precision: plan.precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: None,
        resolved_periodic_images: None,
        integrator: Some(plan.integrator),
        fixed_timestep: plan.fixed_timestep,
        adaptive_timestep: None,
        field_refresh: plan.field_refresh.clone(),
        relaxation: None,
        boundary_correction: None,
        boundary_phi_floor: None,
        boundary_delta_min: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        slonczewski_formula_version: None,
        slonczewski_stack_normal: None,
        slonczewski_target: None,
        slonczewski_active_mask: None,
        sot_current_density: None,
        sot_xi_dl: None,
        sot_xi_fl: None,
        sot_sigma: None,
        sot_thickness: None,
        sot_formula_version: None,
        sot_target: None,
        sot_active_mask: None,
        sot_envelope: None,
        sot_drive: None,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        temperature: None,
        interfacial_dmi: plan.interfacial_dmi,
        bulk_dmi: plan.bulk_dmi,
        dind_field: None,
        dbulk_field: None,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        oersted_realization: None,
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
    let pair_capacity = plan.layers.len().checked_mul(plan.layers.len()).ok_or_else(|| {
        RunError {
            message: "FDM multilayer kernel-pair count overflow before allocation".to_string(),
        }
    })?;
    let mut kernel_pairs = Vec::with_capacity(pair_capacity);
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
    let pair_capacity = plan.layers.len().checked_mul(plan.layers.len()).ok_or_else(|| {
        RunError {
            message: "FDM multilayer f32 kernel-pair count overflow before allocation".to_string(),
        }
    })?;
    let mut kernel_pairs = Vec::with_capacity(pair_capacity);
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
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = if let Some(native_demag) = native_demag {
        native_demag.compute_demag_fields(states)?
    } else {
        compute_demag_fields(contexts, states, demag_runtime)
    };
    let mut magnetization = Vec::new();
    let mut exchange_field = Vec::new();
    let mut demag_field = Vec::new();
    let mut external_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut dmi_field = Vec::new();
    let mut effective_field = Vec::new();
    let mut torque_field = Vec::new();
    let mut exchange_energy = 0.0;
    let mut demag_energy = 0.0;
    let mut external_energy = 0.0;
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let mut max_dm_dt: f64 = 0.0;
    let mut max_h_eff: f64 = 0.0;
    let mut max_h_demag: f64 = 0.0;
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();

    for ((index, context), gpu) in contexts.iter().enumerate().zip(gpu_contexts.iter_mut()) {
        let state = &states[index];
        gpu.backend.upload_magnetization(state.magnetization())?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex(gpu.cell_count)?;
        zero_outside_active(&mut local_exchange, context.problem.active_mask.as_deref());
        let local_observables = context.problem.observe(state).map_err(|error| RunError {
            message: format!(
                "local observables for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;

        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
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
            local_effective[cell] = add(
                add(local_effective[cell], local_demag[cell]),
                sub(local_exchange[cell], local_observables.exchange_field[cell]),
            );
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

fn step_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &mut [ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    mut native_demag: Option<&mut NativeMultilayerDemagOperator>,
    dt: f64,
    integrator: IntegratorChoice,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization().to_vec())
        .collect::<Vec<_>>();
    let corrected = crate::fdm::multilayer::explicit_rk_step(&m0, dt, integrator, |m| {
        llg_rhs_multilayer_cuda(
            contexts,
            gpu_contexts,
            m,
            demag_runtime,
            native_demag.as_mut().map(|operator| &mut **operator),
        )
        .map_err(|error| error.message)
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

fn llg_rhs_multilayer_cuda(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    magnetizations: &[Vec<[f64; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntime>,
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
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
    let mut layer_demag = if let Some(native_demag) = native_demag {
        native_demag.compute_demag_fields(&states)?
    } else {
        compute_demag_fields(contexts, &states, demag_runtime)
    };
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
        let local_observables = context.problem.observe(state).map_err(|error| RunError {
            message: format!(
                "local observables for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_effective = local_observables.effective_field;
        for cell in 0..local_effective.len() {
            local_effective[cell] = add(
                add(local_effective[cell], local_demag[cell]),
                sub(local_exchange[cell], local_observables.exchange_field[cell]),
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
            transfer_boundary_policy: context.transfer_boundary_policy,
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
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<StateObservables, RunError> {
    let mut layer_demag = if let Some(native_demag) = native_demag {
        native_demag.compute_demag_fields_f32(states)?
    } else {
        compute_demag_fields_single(contexts, states, demag_runtime)
    };
    let mut magnetization = Vec::new();
    let mut exchange_field = Vec::new();
    let mut demag_field = Vec::new();
    let mut external_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut dmi_field = Vec::new();
    let mut effective_field = Vec::new();
    let mut torque_field = Vec::new();
    let mut exchange_energy = 0.0;
    let mut demag_energy = 0.0;
    let mut external_energy = 0.0;
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let mut max_dm_dt: f64 = 0.0;
    let mut max_h_eff: f64 = 0.0;
    let mut max_h_demag: f64 = 0.0;
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();

    for ((index, context), gpu) in contexts.iter().enumerate().zip(gpu_contexts.iter_mut()) {
        let state = &states[index];
        let local_magnetization = to_f64_vectors(&state.magnetization);
        gpu.backend.upload_magnetization_f32(&state.magnetization)?;
        gpu.backend.refresh_observables()?;

        let mut local_exchange = gpu.backend.copy_h_ex_f32(gpu.cell_count)?;
        zero_outside_active_f32(&mut local_exchange, context.problem.active_mask.as_deref());
        let local_observables = observe_context_f32(context, &state.magnetization)?;
        let local_observable_exchange = to_f32_vectors(&local_observables.exchange_field);

        let mut local_demag = layer_demag.remove(0);
        zero_outside_active_f32(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_external = to_f32_vectors(&local_observables.external_field);
        let mut local_anisotropy = context.problem.anisotropy_field(&local_magnetization);
        let mut local_dmi = to_f32_vectors(&local_observables.dmi_field);
        zero_outside_active_f32(&mut local_external, context.problem.active_mask.as_deref());
        zero_outside_active(
            &mut local_anisotropy,
            context.problem.active_mask.as_deref(),
        );
        zero_outside_active_f32(&mut local_dmi, context.problem.active_mask.as_deref());
        let mut local_effective = to_f32_vectors(&local_observables.effective_field);
        for cell in 0..local_effective.len() {
            local_effective[cell] = add_f32(
                add_f32(local_effective[cell], local_demag[cell]),
                sub_f32(local_exchange[cell], local_observable_exchange[cell]),
            );
        }
        zero_outside_active_f32(&mut local_effective, context.problem.active_mask.as_deref());
        let rhs = llg_rhs_for_layer_f32(context, &state.magnetization, &local_effective);

        let layer_cell_volume = context.problem.cell_size.volume();
        let layer_ms = context.problem.material.saturation_magnetisation;
        let local_exchange_energy = local_observables.exchange_energy_joules;
        let local_demag_energy = field_energy_from_vectors_f32(
            &state.magnetization,
            &local_demag,
            -0.5 * MU0 * layer_ms * layer_cell_volume,
        );
        let local_external_energy = field_energy_from_vectors_f32(
            &state.magnetization,
            &local_external,
            -MU0 * layer_ms * layer_cell_volume,
        );
        let local_anisotropy_energy = local_observables.anisotropy_energy_joules;
        let local_dmi_energy = local_observables.dmi_energy_joules;
        exchange_energy += local_exchange_energy;
        demag_energy += local_demag_energy;
        external_energy += local_external_energy;
        anisotropy_energy += local_anisotropy_energy;
        dmi_energy += local_dmi_energy;
        max_dm_dt = max_dm_dt.max(max_norm_f32(&rhs));
        max_h_eff = max_h_eff.max(max_norm_f32(&local_effective));
        max_h_demag = max_h_demag.max(max_norm_f32(&local_demag));
        torque_field.extend(compute_torque_field(
            &local_magnetization,
            &to_f64_vectors(&local_effective),
            context.problem.material.damping,
            context.problem.dynamics.precession_enabled,
        ));

        let [mx, my, mz] =
            crate::scalar_metrics::average_magnetization_components(&local_magnetization);
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

        magnetization.extend(local_magnetization);
        exchange_field.extend(to_f64_vectors(&local_exchange));
        demag_field.extend(to_f64_vectors(&local_demag));
        external_field.extend(to_f64_vectors(&local_external));
        anisotropy_field.extend(local_anisotropy);
        dmi_field.extend(to_f64_vectors(&local_dmi));
        effective_field.extend(to_f64_vectors(&local_effective));
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

fn step_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    states: &mut [LayerStateSingle],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
    mut native_demag: Option<&mut NativeMultilayerDemagOperator>,
    dt: f64,
    integrator: IntegratorChoice,
) -> Result<(), RunError> {
    let m0 = states
        .iter()
        .map(|state| state.magnetization.clone())
        .collect::<Vec<_>>();
    let corrected = explicit_rk_step_single(&m0, dt as f32, integrator, |m| {
        llg_rhs_multilayer_cuda_single(
            contexts,
            gpu_contexts,
            m,
            demag_runtime,
            native_demag.as_mut().map(|operator| &mut **operator),
        )
    })?;

    for (state, new_layer) in states.iter_mut().zip(corrected.into_iter()) {
        state.magnetization = new_layer;
        state.time_seconds += dt;
    }
    Ok(())
}

fn explicit_rk_step_single<F>(
    initial: &[Vec<[f32; 3]>],
    dt: f32,
    integrator: IntegratorChoice,
    mut rhs: F,
) -> Result<Vec<Vec<[f32; 3]>>, RunError>
where
    F: FnMut(&[Vec<[f32; 3]>]) -> Result<Vec<Vec<[f32; 3]>>, RunError>,
{
    let k1 = rhs(initial)?;
    match integrator {
        IntegratorChoice::Heun => {
            let y2 = combine_normalized_single(initial, &[(&k1, dt)])?;
            let k2 = rhs(&y2)?;
            combine_normalized_single(initial, &[(&k1, 0.5 * dt), (&k2, 0.5 * dt)])
        }
        IntegratorChoice::Rk4 => {
            let y2 = combine_normalized_single(initial, &[(&k1, 0.5 * dt)])?;
            let k2 = rhs(&y2)?;
            let y3 = combine_normalized_single(initial, &[(&k2, 0.5 * dt)])?;
            let k3 = rhs(&y3)?;
            let y4 = combine_normalized_single(initial, &[(&k3, dt)])?;
            let k4 = rhs(&y4)?;
            combine_normalized_single(
                initial,
                &[
                    (&k1, dt / 6.0),
                    (&k2, dt / 3.0),
                    (&k3, dt / 3.0),
                    (&k4, dt / 6.0),
                ],
            )
        }
        IntegratorChoice::Rk23 => {
            let y2 = combine_normalized_single(initial, &[(&k1, 0.5 * dt)])?;
            let k2 = rhs(&y2)?;
            let y3 = combine_normalized_single(initial, &[(&k2, 0.75 * dt)])?;
            let k3 = rhs(&y3)?;
            combine_normalized_single(
                initial,
                &[
                    (&k1, 2.0 * dt / 9.0),
                    (&k2, dt / 3.0),
                    (&k3, 4.0 * dt / 9.0),
                ],
            )
        }
        unsupported => Err(RunError {
            message: format!("staged multilayer explicit RK does not implement {unsupported:?}"),
        }),
    }
}

fn combine_normalized_single(
    initial: &[Vec<[f32; 3]>],
    increments: &[(&[Vec<[f32; 3]>], f32)],
) -> Result<Vec<Vec<[f32; 3]>>, RunError> {
    initial
        .iter()
        .enumerate()
        .map(|(layer_index, layer)| {
            layer
                .iter()
                .enumerate()
                .map(|(cell_index, m)| {
                    let mut value = *m;
                    for (stage, coefficient) in increments {
                        for component in 0..3 {
                            value[component] +=
                                coefficient * stage[layer_index][cell_index][component];
                        }
                    }
                    normalized_f32(value).map_err(|message| RunError { message })
                })
                .collect()
        })
        .collect()
}

fn llg_rhs_multilayer_cuda_single(
    contexts: &[LayerContext],
    gpu_contexts: &mut [LayerGpuContext],
    magnetizations: &[Vec<[f32; 3]>],
    demag_runtime: Option<&MultilayerDemagRuntimeF32>,
    native_demag: Option<&mut NativeMultilayerDemagOperator>,
) -> Result<Vec<Vec<[f32; 3]>>, RunError> {
    let mut layer_demag = if let Some(native_demag) = native_demag {
        let states = magnetizations
            .iter()
            .map(|magnetization| LayerStateSingle {
                magnetization: magnetization.clone(),
                time_seconds: 0.0,
            })
            .collect::<Vec<_>>();
        native_demag.compute_demag_fields_f32(&states)?
    } else {
        compute_demag_fields_single_from_m(contexts, magnetizations, demag_runtime)
    };
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
        let local_observables = observe_context_f32(context, magnetization)?;
        let local_observable_exchange = to_f32_vectors(&local_observables.exchange_field);
        let mut local_demag = layer_demag.remove(0);
        zero_outside_active_f32(&mut local_demag, context.problem.active_mask.as_deref());
        let mut local_effective = to_f32_vectors(&local_observables.effective_field);
        for cell in 0..local_effective.len() {
            local_effective[cell] = add_f32(
                add_f32(local_effective[cell], local_demag[cell]),
                sub_f32(local_exchange[cell], local_observable_exchange[cell]),
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
            transfer_boundary_policy: context.transfer_boundary_policy,
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
    observe_native_stacked_fields(
        native,
        &magnetization_full,
        &exchange_full,
        &demag_full,
        &external_full,
        &effective_full,
    )
}

fn observe_native_stacked_fields(
    native: &NativeStackedCudaPlan,
    magnetization_full: &[[f64; 3]],
    exchange_full: &[[f64; 3]],
    demag_full: &[[f64; 3]],
    external_full: &[[f64; 3]],
    effective_full: &[[f64; 3]],
) -> Result<StateObservables, RunError> {
    let cell_count = magnetization_full.len();
    let active_mask = native.combined_plan.active_mask.as_deref();
    let cell_volume = native.combined_plan.cell_size[0]
        * native.combined_plan.cell_size[1]
        * native.combined_plan.cell_size[2];
    let ms = native.combined_plan.material.saturation_magnetisation;

    let exchange_energy = if native.combined_plan.enable_exchange {
        field_energy_from_full(
            magnetization_full,
            exchange_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };
    let demag_energy = if native.combined_plan.enable_demag {
        field_energy_from_full(magnetization_full, demag_full, active_mask, ms, cell_volume)
    } else {
        0.0
    };
    let external_energy = if native.combined_plan.external_field.is_some() {
        field_energy_from_full(
            magnetization_full,
            external_full,
            active_mask,
            ms,
            cell_volume,
        )
    } else {
        0.0
    };
    let global_grid = [
        native.global_grid[0] as usize,
        native.global_grid[1] as usize,
        native.global_grid[2] as usize,
    ];
    let mut per_object_scalars: std::collections::HashMap<
        String,
        std::collections::HashMap<String, f64>,
    > = std::collections::HashMap::new();
    let mut dmi_field = Vec::new();
    let mut anisotropy_field = Vec::new();
    let mut anisotropy_energy = 0.0;
    let mut dmi_energy = 0.0;
    let local_energy_factor = -0.5 * MU0 * ms * cell_volume;
    for layer in &native.layers {
        let mut local_exchange_energy = 0.0;
        let mut local_demag_energy = 0.0;
        let mut local_external_energy = 0.0;
        let mut mx_sum = 0.0;
        let mut my_sum = 0.0;
        let mut mz_sum = 0.0;
        let mut active_count = 0usize;
        for z in 0..layer.native_grid[2] {
            for y in 0..layer.native_grid[1] {
                for x in 0..layer.native_grid[0] {
                    let gx = layer.offset[0] + x;
                    let gy = layer.offset[1] + y;
                    let gz = layer.offset[2] + z;
                    let global_index =
                        gz * global_grid[1] * global_grid[0] + gy * global_grid[0] + gx;
                    if active_mask.is_some_and(|mask| !mask[global_index]) {
                        continue;
                    }
                    let m = magnetization_full[global_index];
                    mx_sum += m[0];
                    my_sum += m[1];
                    mz_sum += m[2];
                    active_count += 1;
                    if native.combined_plan.enable_exchange {
                        local_exchange_energy +=
                            local_energy_factor * dot(m, exchange_full[global_index]);
                    }
                    if native.combined_plan.enable_demag {
                        local_demag_energy +=
                            local_energy_factor * dot(m, demag_full[global_index]);
                    }
                    if native.combined_plan.external_field.is_some() {
                        local_external_energy +=
                            local_energy_factor * dot(m, external_full[global_index]);
                    }
                }
            }
        }
        let local_magnetization =
            extract_native_stacked_layer_field(magnetization_full, native, layer);
        let local_state = ExchangeLlgState::new(layer.context.problem.grid, local_magnetization)
            .map_err(|error| RunError {
                message: format!(
                    "native stacked local state for magnet '{}': {}",
                    layer.magnet_name, error
                ),
            })?;
        let local_observables = layer
            .context
            .problem
            .observe(&local_state)
            .map_err(|error| RunError {
                message: format!(
                    "native stacked local observables for magnet '{}': {}",
                    layer.magnet_name, error
                ),
            })?;
        let mut local_anisotropy = layer
            .context
            .problem
            .anisotropy_field(local_state.magnetization());
        zero_outside_active(
            &mut local_anisotropy,
            layer.context.problem.active_mask.as_deref(),
        );
        let mut local_dmi = local_observables.dmi_field;
        zero_outside_active(&mut local_dmi, layer.context.problem.active_mask.as_deref());
        let local_anisotropy_energy = local_observables.anisotropy_energy_joules;
        let local_dmi_energy = local_observables.dmi_energy_joules;
        anisotropy_energy += local_anisotropy_energy;
        dmi_energy += local_dmi_energy;
        anisotropy_field.extend(local_anisotropy);
        dmi_field.extend(local_dmi);

        let inv = if active_count > 0 {
            1.0 / active_count as f64
        } else {
            0.0
        };
        per_object_scalars.insert(
            layer.magnet_name.clone(),
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
                ("mx".to_string(), mx_sum * inv),
                ("my".to_string(), my_sum * inv),
                ("mz".to_string(), mz_sum * inv),
            ]),
        );
    }
    let max_dm_dt = max_rhs_norm_from_full(
        magnetization_full,
        effective_full,
        active_mask,
        native.combined_plan.material.damping,
        native.combined_plan.gyromagnetic_ratio,
        !llg_overdamped_uses_pure_damping(native.combined_plan.relaxation.as_ref()),
    );
    let max_h_eff = max_norm_from_full(effective_full, active_mask);
    let max_h_demag = max_norm_from_full(demag_full, active_mask);
    for values in per_object_scalars.values_mut() {
        values.insert("max_dm_dt".to_string(), max_dm_dt);
        values.insert("max_h_eff".to_string(), max_h_eff);
        values.insert("max_h_demag".to_string(), max_h_demag);
    }

    let magnetization = extract_native_stacked_field(magnetization_full, native);
    let effective_field = extract_native_stacked_field(effective_full, native);
    let torque_field = compute_torque_field(
        &magnetization,
        &effective_field,
        native.combined_plan.material.damping,
        !llg_overdamped_uses_pure_damping(native.combined_plan.relaxation.as_ref()),
    );
    let max_torque_apm = max_torque_residual_apm_from_field(&magnetization, &effective_field);

    Ok(StateObservables {
        magnetization,
        torque_field,
        exchange_field: extract_native_stacked_field(exchange_full, native),
        demag_field: extract_native_stacked_field(demag_full, native),
        external_field: extract_native_stacked_field(external_full, native),
        antenna_field: vec![[0.0, 0.0, 0.0]; cell_count],
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

fn extract_native_stacked_field(
    full_field: &[[f64; 3]],
    native: &NativeStackedCudaPlan,
) -> Vec<[f64; 3]> {
    let mut values = Vec::new();
    for layer in &native.layers {
        values.extend(extract_native_stacked_layer_field(
            full_field, native, layer,
        ));
    }
    values
}

fn extract_native_stacked_layer_field(
    full_field: &[[f64; 3]],
    native: &NativeStackedCudaPlan,
    layer: &NativeStackedLayer,
) -> Vec<[f64; 3]> {
    let global_grid = [
        native.global_grid[0] as usize,
        native.global_grid[1] as usize,
        native.global_grid[2] as usize,
    ];
    let mut values = Vec::new();
    for z in 0..layer.native_grid[2] {
        for y in 0..layer.native_grid[1] {
            for x in 0..layer.native_grid[0] {
                let gx = layer.offset[0] + x;
                let gy = layer.offset[1] + y;
                let gz = layer.offset[2] + z;
                let global_index = gz * global_grid[1] * global_grid[0] + gy * global_grid[0] + gx;
                values.push(full_field[global_index]);
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

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn sub_f32(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
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

fn observe_context_f32(
    context: &LayerContext,
    magnetization: &[[f32; 3]],
) -> Result<EffectiveFieldObservables, RunError> {
    let state = context
        .problem
        .new_state(to_f64_vectors(magnetization))
        .map_err(|error| RunError {
            message: format!(
                "temporary single-precision observables state for magnet '{}': {}",
                context.magnet_name, error
            ),
        })?;
    context.problem.observe(&state).map_err(|error| RunError {
        message: format!(
            "single-precision local observables for magnet '{}': {}",
            context.magnet_name, error
        ),
    })
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
    use crate::fdm::cpu::multilayer_reference;
    use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

    fn manufactured_rhs_single(
        state: &[Vec<[f32; 3]>],
    ) -> Result<Vec<Vec<[f32; 3]>>, RunError> {
        Ok(state
            .iter()
            .map(|layer| {
                layer
                    .iter()
                    .map(|m| [m[1] + 0.25 * m[0], -0.5 * m[0] + m[2], m[0] - 0.2 * m[2]])
                    .collect()
            })
            .collect())
    }

    #[test]
    fn staged_single_precision_executes_requested_tableau() {
        let initial = vec![vec![[1.0_f32, 0.0, 0.0]]];
        let heun = explicit_rk_step_single(
            &initial,
            0.2,
            IntegratorChoice::Heun,
            manufactured_rhs_single,
        )
        .expect("Heun step");
        let rk4 = explicit_rk_step_single(
            &initial,
            0.2,
            IntegratorChoice::Rk4,
            manufactured_rhs_single,
        )
        .expect("RK4 step");
        let rk23 = explicit_rk_step_single(
            &initial,
            0.2,
            IntegratorChoice::Rk23,
            manufactured_rhs_single,
        )
        .expect("RK23 step");

        for (actual, expected) in [
            (&heun, [0.98021667, -0.07564913, 0.18290020]),
            (&rk4, [0.98012969, -0.07565319, 0.18336407]),
            (&rk23, [0.98013383, -0.07563269, 0.18335039]),
        ] {
            for component in 0..3 {
                assert!((actual[0][0][component] - expected[component]).abs() < 2.0e-6);
            }
        }
        assert_ne!(heun, rk4);
        assert_ne!(heun, rk23);
        assert_ne!(rk4, rk23);
    }

    fn make_plan(enable_demag: bool, precision: ExecutionPrecision) -> FdmMultilayerPlanIR {
        FdmMultilayerPlanIR {
            mode: "two_d_stack".to_string(),
            common_cells: [4, 4, 1],
            resolved_periodic_images: None,
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
            ],
            enable_exchange: true,
            enable_demag,
            external_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 2.211e5,
            precision,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            field_refresh: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
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
            resolved_periodic_images: None,
            field_refresh: None,
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
                        ..Default::default()
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
                        ..Default::default()
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
            interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 2.211e5,
            precision,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            periodicity: None,
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

    fn add_global_dmi_texture(plan: &mut FdmMultilayerPlanIR) {
        plan.enable_exchange = false;
        plan.interfacial_dmi = Some(1.5e-3);
        plan.bulk_dmi = Some(2.5e-3);
        let layer_nx = plan.layers[0].native_grid[0] as usize;
        for (index, value) in plan.layers[0].initial_magnetization.iter_mut().enumerate() {
            let x = (index % layer_nx) as f64;
            let angle = 0.35 * x;
            *value = [angle.cos(), 0.0, angle.sin()];
        }
    }

    fn add_uniaxial_anisotropy_texture(plan: &mut FdmMultilayerPlanIR) {
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
    }

    #[test]
    fn cuda_assisted_layer_contexts_preserve_global_dmi_terms() {
        let mut plan = make_assisted_plan(false, ExecutionPrecision::Double);
        add_global_dmi_texture(&mut plan);

        let (contexts, states) =
            build_contexts_and_states(&plan, false).expect("CUDA-assisted contexts should build");
        let dmi = contexts[0]
            .problem
            .dmi_field(&states[0])
            .expect("DMI field should compute");

        assert!(
            max_norm(&dmi) > 0.0,
            "CUDA-assisted multilayer layer contexts must preserve global DMI"
        );
    }

    #[test]
    fn native_stacked_cuda_plan_preserves_global_dmi_constants() {
        let mut plan = make_plan(false, ExecutionPrecision::Double);
        add_global_dmi_texture(&mut plan);

        let native = build_native_stacked_cuda_plan(&plan)
            .expect("native stacked plan should build")
            .expect("plan should be eligible for native stacked fast path");

        assert_eq!(native.combined_plan.interfacial_dmi, plan.interfacial_dmi);
        assert_eq!(native.combined_plan.bulk_dmi, plan.bulk_dmi);
    }

    #[test]
    fn native_stacked_cuda_plan_disables_inter_body_exchange_pairs() {
        let plan = make_touching_plan(ExecutionPrecision::Double);

        let native = build_native_stacked_cuda_plan(&plan)
            .expect("native stacked plan should build")
            .expect("touching plan should be eligible for native stacked fast path");

        assert_eq!(
            native.combined_plan.inter_region_exchange,
            vec![(1, 2, 0.0)],
            "combined single-grid plan must preserve object-object free surfaces explicitly because the native FDM region default is harmonic mean"
        );
    }

    #[test]
    fn staged_v2_cuda_allows_fixed_step_rk23_but_rejects_rk45() {
        let mut plan = make_plan(false, ExecutionPrecision::Double);
        plan.integrator = IntegratorChoice::Rk45;

        let native = resolve_cuda_multilayer_execution_shape(&plan)
            .expect("native stacked RK45 should be a valid CUDA multilayer execution shape")
            .expect("plan should use native single-grid fast path");
        assert_eq!(native.combined_plan.integrator, Some(IntegratorChoice::Rk45));

        let mut assisted = make_assisted_plan(false, ExecutionPrecision::Double);
        assisted.integrator = IntegratorChoice::Rk23;
        assert!(
            resolve_cuda_multilayer_execution_shape(&assisted)
                .expect("heterogeneous staged v2 fixed-step RK23 should be accepted")
                .is_none(),
            "heterogeneous staged v2 should not resolve through the native stacked fast path"
        );

        assisted.integrator = IntegratorChoice::Rk45;
        let err = match resolve_cuda_multilayer_execution_shape(&assisted) {
            Err(err) => err,
            Ok(_) => panic!("heterogeneous staged v2 RK45 should remain unsupported"),
        };
        assert!(
            err.message.contains("staged v2")
                && err.message.contains("'heun', 'rk4', and fixed-step 'rk23'"),
            "unexpected error: {}",
            err.message
        );
    }

    #[test]
    fn native_stacked_observables_include_layer_dmi_outputs() {
        let mut plan = make_plan(false, ExecutionPrecision::Double);
        add_global_dmi_texture(&mut plan);
        let native = build_native_stacked_cuda_plan(&plan)
            .expect("native stacked plan should build")
            .expect("plan should be eligible for native stacked fast path");
        let cell_count = native.combined_plan.initial_magnetization.len();
        let zero_field = vec![[0.0, 0.0, 0.0]; cell_count];

        let observables = observe_native_stacked_fields(
            &native,
            &native.combined_plan.initial_magnetization,
            &zero_field,
            &zero_field,
            &zero_field,
            &zero_field,
        )
        .expect("native stacked field assembly should compute");

        assert_eq!(observables.dmi_field.len(), 32);
        assert!(
            max_norm(&observables.dmi_field) > 0.0,
            "native stacked observables must preserve H_dmi for field snapshots"
        );
        assert!(
            observables.dmi_energy.abs() > 0.0,
            "native stacked observables must preserve DMI scalar energy"
        );
        assert!(
            observables
                .per_object_scalars
                .get("free")
                .and_then(|values| values.get("e_dmi"))
                .is_some_and(|value| value.abs() > 0.0),
            "native stacked per-object scalars must include layer-local DMI energy"
        );
    }

    #[test]
    fn native_stacked_observables_include_layer_anisotropy_outputs() {
        let mut plan = make_plan(false, ExecutionPrecision::Double);
        add_uniaxial_anisotropy_texture(&mut plan);
        let native = build_native_stacked_cuda_plan(&plan)
            .expect("native stacked plan should build")
            .expect("plan should be eligible for native stacked fast path");
        let cell_count = native.combined_plan.initial_magnetization.len();
        let zero_field = vec![[0.0, 0.0, 0.0]; cell_count];

        let observables = observe_native_stacked_fields(
            &native,
            &native.combined_plan.initial_magnetization,
            &zero_field,
            &zero_field,
            &zero_field,
            &zero_field,
        )
        .expect("native stacked field assembly should compute");

        assert_eq!(observables.anisotropy_field.len(), 32);
        assert!(
            max_norm(&observables.anisotropy_field) > 0.0,
            "native stacked observables must preserve H_ani for field snapshots"
        );
        assert!(
            observables.anisotropy_energy.abs() > 0.0,
            "native stacked observables must preserve anisotropy scalar energy"
        );
        let selected = select_state_observable_field(&observables, "H_ani", false)
            .expect("H_ani should be selectable from native stacked observables");
        assert_eq!(
            max_vector_component_diff(&selected, &observables.anisotropy_field),
            0.0
        );
    }

    #[test]
    fn native_stacked_stats_use_layer_observables_instead_of_combined_grid_scalars() {
        let mut per_object_scalars = std::collections::HashMap::new();
        per_object_scalars.insert(
            "bottom".to_string(),
            std::collections::HashMap::from([
                ("e_total".to_string(), 4.0),
                ("mx".to_string(), 1.0),
            ]),
        );
        per_object_scalars.insert(
            "top".to_string(),
            std::collections::HashMap::from([
                ("e_total".to_string(), 6.0),
                ("my".to_string(), 1.0),
            ]),
        );
        let observables = StateObservables {
            magnetization: vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            torque_field: Vec::new(),
            exchange_field: Vec::new(),
            demag_field: Vec::new(),
            external_field: Vec::new(),
            antenna_field: Vec::new(),
            effective_field: Vec::new(),
            anisotropy_field: Vec::new(),
            dmi_field: Vec::new(),
            magnetoelastic_field: Vec::new(),
            cubic_anisotropy_field: Vec::new(),
            bulk_dmi_field: Vec::new(),
            oersted_field: Vec::new(),
            thermal_field: Vec::new(),
            exchange_energy: 1.0,
            demag_energy: 2.0,
            external_energy: 3.0,
            anisotropy_energy: 0.5,
            dmi_energy: 0.25,
            total_energy: 6.75,
            max_dm_dt: 7.0,
            max_h_eff: 8.0,
            max_h_demag: 9.0,
            max_torque_Apm: 10.0,
            per_object_scalars,
        };
        let native_step = StepStats {
            step: 12,
            time: 3.0e-13,
            dt: 1.0e-13,
            e_total: 999.0,
            wall_time_ns: 42,
            dt_suggested: Some(2.0e-13),
            per_object_scalars: std::collections::HashMap::from([(
                "free".to_string(),
                std::collections::HashMap::from([("e_total".to_string(), 999.0)]),
            )]),
            ..StepStats::default()
        };

        let stats = make_native_stacked_step_stats(&native_step, &observables);

        assert_eq!(stats.step, native_step.step);
        assert_eq!(stats.time, native_step.time);
        assert_eq!(stats.dt, native_step.dt);
        assert_eq!(stats.wall_time_ns, native_step.wall_time_ns);
        assert_eq!(stats.dt_suggested, native_step.dt_suggested);
        assert_eq!(stats.e_total, observables.total_energy);
        assert_eq!(stats.e_ex, observables.exchange_energy);
        assert_eq!(stats.e_demag, observables.demag_energy);
        assert_eq!(stats.e_ani, observables.anisotropy_energy);
        assert_eq!(stats.e_dmi, observables.dmi_energy);
        assert_eq!(stats.max_rhs_norm_per_s, observables.max_dm_dt);
        assert_eq!(stats.max_torque_Apm, observables.max_torque_Apm);
        assert_eq!(stats.max_torque_T, observables.max_torque_Apm * crate::MU0);
        assert_eq!(stats.per_object_scalars.len(), 2);
        assert!(stats.per_object_scalars.contains_key("bottom"));
        assert!(stats.per_object_scalars.contains_key("top"));
        assert!(!stats.per_object_scalars.contains_key("free"));
    }

    #[test]
    fn cuda_assisted_multilayer_tracks_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!("skipping cuda-assisted multilayer test: CUDA backend is not available");
            return;
        }

        let plan = make_plan(true, ExecutionPrecision::Double);
        let cpu =
            multilayer_reference::execute_reference_fdm_multilayer(&plan, 2e-13, &[], None, None)
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
        let cpu =
            multilayer_reference::execute_reference_fdm_multilayer(&plan, 1e-13, &[], None, None)
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
        assert_eq!(
            double_run.provenance.demag_operator_kind.as_deref(),
            Some("native_multilayer_tensor_fft_newell")
        );
        assert_eq!(double_run.provenance.fft_backend.as_deref(), Some("cuFFT"));
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
