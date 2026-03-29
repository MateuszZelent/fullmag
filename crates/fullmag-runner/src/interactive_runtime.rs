use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use std::collections::HashSet;

use fullmag_engine::fem::{FemLlgProblem, FemLlgState};
use fullmag_engine::{ExchangeLlgProblem, ExchangeLlgState, FftWorkspace, IntegratorBuffers};
use fullmag_ir::{BackendPlanIR, FdmPlanIR, FemPlanIR, OutputIR, ProblemIR, RelaxationAlgorithmIR};

use crate::cpu_reference;
use crate::dispatch::{self, FdmEngine, FemEngine};
use crate::fem_reference;
#[cfg(feature = "cuda")]
use crate::native_fdm::NativeFdmBackend;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{DeviceInfo as FemDeviceInfo, NativeFemBackend};
use crate::preview::{build_grid_preview_field, normalize_quantity_id, select_observables};
use crate::relaxation::{llg_overdamped_uses_pure_damping, relaxation_converged};
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, LivePreviewField, LivePreviewRequest,
    RunError, RunResult, RunStatus, StateObservables, StepAction, StepStats, StepUpdate,
};

pub struct InteractiveFdmPreviewRuntime {
    inner: InteractiveFdmPreviewRuntimeInner,
}

enum InteractiveFdmPreviewRuntimeInner {
    Cpu(CpuInteractiveFdmPreviewRuntime),
    #[cfg(feature = "cuda")]
    Cuda(CudaInteractiveFdmPreviewRuntime),
}

struct CpuInteractiveFdmPreviewRuntime {
    problem: ExchangeLlgProblem,
    state: ExchangeLlgState,
    fft_workspace: FftWorkspace,
    integrator_buffers: IntegratorBuffers,
    original_grid: [u32; 3],
    plan_signature: FdmPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
}

#[cfg(feature = "cuda")]
struct CudaInteractiveFdmPreviewRuntime {
    backend: NativeFdmBackend,
    original_grid: [u32; 3],
    plan_signature: FdmPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
    total_time: f64,
}

pub struct InteractiveFemPreviewRuntime {
    inner: InteractiveFemPreviewRuntimeInner,
}

enum InteractiveFemPreviewRuntimeInner {
    Cpu(CpuInteractiveFemPreviewRuntime),
    #[cfg(feature = "fem-gpu")]
    Gpu(GpuInteractiveFemPreviewRuntime),
}

struct CpuInteractiveFemPreviewRuntime {
    problem: FemLlgProblem,
    state: FemLlgState,
    mesh: crate::types::FemMeshPayload,
    plan_signature: FemPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
}

#[cfg(feature = "fem-gpu")]
struct GpuInteractiveFemPreviewRuntime {
    backend: NativeFemBackend,
    mesh: crate::types::FemMeshPayload,
    node_count: usize,
    plan_signature: FemPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
    total_time: f64,
}

impl InteractiveFdmPreviewRuntime {
    pub fn create(problem: &ProblemIR) -> Result<Self, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Err(RunError {
                message:
                    "interactive FDM preview runtime is supported only for single-layer FDM plans"
                        .to_string(),
            });
        };
        let engine = dispatch::resolve_fdm_engine(problem)?;
        Self::from_fdm_plan(fdm, engine)
    }

    fn from_fdm_plan(plan: &FdmPlanIR, engine: FdmEngine) -> Result<Self, RunError> {
        let inner = match engine {
            FdmEngine::CpuReference => {
                let (problem, state) = cpu_reference::build_snapshot_problem_and_state(plan)?;
                let fft_workspace = problem.create_workspace();
                let integrator_buffers = problem.create_integrator_buffers();
                InteractiveFdmPreviewRuntimeInner::Cpu(CpuInteractiveFdmPreviewRuntime {
                    problem,
                    state,
                    fft_workspace,
                    integrator_buffers,
                    original_grid: plan.grid.cells,
                    plan_signature: normalize_plan_signature(plan),
                    provenance: cpu_execution_provenance(plan),
                    total_steps: 0,
                })
            }
            FdmEngine::CudaFdm => {
                #[cfg(feature = "cuda")]
                {
                    let backend = NativeFdmBackend::create(plan)?;
                    let device_info = backend.device_info()?;
                    InteractiveFdmPreviewRuntimeInner::Cuda(CudaInteractiveFdmPreviewRuntime {
                        backend,
                        original_grid: plan.grid.cells,
                        plan_signature: normalize_plan_signature(plan),
                        provenance: cuda_execution_provenance(plan, &device_info),
                        total_steps: 0,
                        total_time: 0.0,
                    })
                }
                #[cfg(not(feature = "cuda"))]
                {
                    return Err(RunError {
                        message:
                            "interactive CUDA FDM preview runtime requested but the runner was built without cuda"
                                .to_string(),
                    });
                }
            }
        };
        Ok(Self { inner })
    }

    pub fn matches_plan(&self, plan: &FdmPlanIR) -> bool {
        let normalized = normalize_plan_signature(plan);
        match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.plan_signature == normalized,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                runtime.plan_signature == normalized
            }
        }
    }

    pub fn execution_provenance(&self) -> ExecutionProvenance {
        match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.provenance.clone(),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.provenance.clone(),
        }
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
        }
    }

    pub fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_preview(request),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.snapshot_preview(request),
        }
    }

    pub fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
        }
    }

    pub fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                grid,
                field_every_n,
                preview_request,
                on_step,
            ),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                grid,
                field_every_n,
                preview_request,
                on_step,
            ),
        }
    }

    pub(crate) fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    grid,
                    field_every_n,
                    preview_request,
                    artifact_writer,
                    on_step,
                ),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    grid,
                    field_every_n,
                    preview_request,
                    artifact_writer,
                    on_step,
                ),
        }
    }
}

impl InteractiveFemPreviewRuntime {
    pub fn create(problem: &ProblemIR) -> Result<Self, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Err(RunError {
                message:
                    "interactive FEM preview runtime is supported only for FEM execution plans"
                        .to_string(),
            });
        };
        let engine = dispatch::resolve_fem_engine(problem)?;
        Self::from_fem_plan(fem, engine)
    }

    fn from_fem_plan(plan: &FemPlanIR, engine: FemEngine) -> Result<Self, RunError> {
        let mesh = crate::types::FemMeshPayload {
            nodes: plan.mesh.nodes.clone(),
            elements: plan.mesh.elements.clone(),
            boundary_faces: plan.mesh.boundary_faces.clone(),
        };
        let inner = match engine {
            FemEngine::CpuReference => {
                if plan.precision != fullmag_ir::ExecutionPrecision::Double {
                    return Err(RunError {
                        message:
                            "execution_precision='single' is not executable in the FEM CPU reference runner; use 'double'"
                                .to_string(),
                    });
                }
                let (problem, state) = fem_reference::build_problem_and_state(plan)?;
                InteractiveFemPreviewRuntimeInner::Cpu(CpuInteractiveFemPreviewRuntime {
                    problem,
                    state,
                    mesh,
                    plan_signature: normalize_fem_plan_signature(plan),
                    provenance: fem_reference::execution_provenance(plan),
                    total_steps: 0,
                })
            }
            FemEngine::NativeGpu => {
                #[cfg(feature = "fem-gpu")]
                {
                    let backend = NativeFemBackend::create(plan)?;
                    let device_info = backend.device_info()?;
                    InteractiveFemPreviewRuntimeInner::Gpu(GpuInteractiveFemPreviewRuntime {
                        backend,
                        mesh,
                        node_count: plan.mesh.nodes.len(),
                        plan_signature: normalize_fem_plan_signature(plan),
                        provenance: fem_gpu_execution_provenance(plan, &device_info),
                        total_steps: 0,
                        total_time: 0.0,
                    })
                }
                #[cfg(not(feature = "fem-gpu"))]
                {
                    return Err(RunError {
                        message:
                            "interactive native FEM runtime requested but the runner was built without fem-gpu"
                                .to_string(),
                    });
                }
            }
        };
        Ok(Self { inner })
    }

    pub fn matches_plan(&self, plan: &FemPlanIR) -> bool {
        let normalized = normalize_fem_plan_signature(plan);
        match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.plan_signature == normalized,
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.plan_signature == normalized,
        }
    }

    pub fn execution_provenance(&self) -> ExecutionProvenance {
        match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.provenance.clone(),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.provenance.clone(),
        }
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
        }
    }

    pub fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_preview(request),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.snapshot_preview(request),
        }
    }

    pub fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
        }
    }

    pub fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                field_every_n,
                preview_request,
                on_step,
            ),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                field_every_n,
                preview_request,
                on_step,
            ),
        }
    }

    pub(crate) fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    field_every_n,
                    artifact_writer,
                    preview_request,
                    on_step,
                ),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    field_every_n,
                    artifact_writer,
                    preview_request,
                    on_step,
                ),
        }
    }
}

impl CpuInteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.state
            .set_magnetization(magnetization.to_vec())
            .map_err(|error| RunError {
                message: format!("setting interactive CPU magnetization failed: {}", error),
            })
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        Ok(build_grid_preview_field(
            request,
            select_observables(&observables, &request.quantity),
            self.original_grid,
        ))
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut cached = Vec::new();
        let mut seen = HashSet::new();
        for quantity in quantities
            .iter()
            .map(|quantity| normalize_quantity_id(quantity))
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(build_grid_preview_field(
                &preview_request,
                select_observables(&observables, quantity),
                self.original_grid,
            ));
        }
        Ok(cached)
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        if plan.relaxation.as_ref().is_some_and(|control| {
            matches!(
                control.algorithm,
                RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
            )
        }) {
            return Err(RunError {
                message:
                    "interactive CPU runtime does not yet support BB/NCG direct-minimization relaxation"
                        .to_string(),
            });
        }

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy =
            Some(cpu_reference::observe_state(&self.problem, &self.state)?.total_energy);
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut steps: Vec<StepStats> = Vec::new();

        while self.state.time_seconds - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step_with_buffers(
                    &mut self.state,
                    dt_step,
                    &mut self.fft_workspace,
                    &mut self.integrator_buffers,
                )
                .map_err(|error| RunError {
                    message: format!("interactive CPU step failed: {}", error),
                })?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
            let total_stats = make_step_stats(
                self.total_steps,
                self.state.time_seconds,
                report.dt_used,
                wall_elapsed,
                &observables,
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&observables, &preview_cfg.quantity),
                    grid,
                ))
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            steps.push(local_stats.clone());
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        Ok(RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        if plan.relaxation.as_ref().is_some_and(|control| {
            matches!(
                control.algorithm,
                RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
            )
        }) {
            return Err(RunError {
                message:
                    "interactive CPU runtime does not yet support BB/NCG direct-minimization relaxation"
                        .to_string(),
            });
        }

        let initial_magnetization = self.state.magnetization().to_vec();
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        let initial_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut steps = Vec::new();
        if default_scalar_trace {
            let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
        } else {
            record_due_cpu_outputs(
                &initial_observables,
                0,
                0.0,
                0.0,
                0,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }
        let result = self.execute_cpu_streaming_loop(
            plan,
            until_seconds,
            grid,
            field_every_n,
            preview_request,
            on_step,
            default_scalar_trace,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        Ok(ExecutedRun {
            result,
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_cpu_streaming_loop(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
        default_scalar_trace: bool,
        scalar_schedules: &mut [OutputSchedule],
        field_schedules: &mut [OutputSchedule],
        steps: &mut Vec<StepStats>,
        artifacts: &mut ArtifactRecorder,
    ) -> Result<RunResult, RunError> {
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy =
            Some(cpu_reference::observe_state(&self.problem, &self.state)?.total_energy);
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut latest_local_stats: Option<StepStats> = None;

        while self.state.time_seconds - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step_with_buffers(
                    &mut self.state,
                    dt_step,
                    &mut self.fft_workspace,
                    &mut self.integrator_buffers,
                )
                .map_err(|error| RunError {
                    message: format!("interactive CPU step failed: {}", error),
                })?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
            let total_stats = make_step_stats(
                self.total_steps,
                self.state.time_seconds,
                report.dt_used,
                wall_elapsed,
                &observables,
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            latest_local_stats = Some(local_stats.clone());

            record_due_cpu_outputs(
                &observables,
                local_stats.step,
                local_stats.time,
                report.dt_used,
                wall_elapsed,
                scalar_schedules,
                field_schedules,
                steps,
                artifacts,
            )?;

            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&observables, &preview_cfg.quantity),
                    grid,
                ))
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        if let Some(final_stats) = latest_local_stats {
            let final_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
            record_final_cpu_outputs(
                &final_observables,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
                default_scalar_trace,
                field_schedules,
                steps,
                artifacts,
            )?;
        }

        Ok(RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps: steps.clone(),
            final_magnetization: self.state.magnetization().to_vec(),
        })
    }
}

#[cfg(feature = "cuda")]
impl CudaInteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.backend
            .copy_live_preview_field(request, self.original_grid)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let mut cached = Vec::new();
        let mut seen = HashSet::new();

        for quantity in quantities
            .iter()
            .map(|quantity| normalize_quantity_id(quantity))
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(
                self.backend
                    .copy_live_preview_field(&preview_request, self.original_grid)?,
            );
        }

        Ok(cached)
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CUDA runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy: Option<f64> = None;
        let mut last_preview_revision: Option<u64> = None;
        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let mut cancelled = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());

        while self.total_time - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let total_stats = self.backend.step(dt_step)?;
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(self.backend.copy_live_preview_field(&preview_cfg, grid)?)
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            steps.push(local_stats.clone());
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        Ok(RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: self.backend.copy_m(cell_count)?,
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CUDA runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let initial_magnetization = self.backend.copy_m(cell_count)?;
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        capture_initial_cuda_runtime_fields(
            &self.backend,
            cell_count,
            &mut field_schedules,
            &mut artifacts,
        )?;

        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy: Option<f64> = None;
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;

        while self.total_time - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let total_stats = self.backend.step(dt_step)?;
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            latest_local_stats = Some(local_stats.clone());
            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(self.backend.copy_live_preview_field(&preview_cfg, grid)?)
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            record_due_cuda_runtime_outputs(
                &self.backend,
                cell_count,
                &local_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        record_final_cuda_runtime_outputs(
            &self.backend,
            cell_count,
            latest_local_stats,
            default_scalar_trace,
            &scalar_schedules,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )?;

        let final_magnetization = self.backend.copy_m(cell_count)?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        Ok(ExecutedRun {
            result: RunResult {
                status: if cancelled {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Completed
                },
                steps,
                final_magnetization,
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
        })
    }
}

impl CpuInteractiveFemPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.state
            .set_magnetization(magnetization.to_vec())
            .map_err(|error| RunError {
                message: format!(
                    "setting interactive FEM CPU magnetization failed: {}",
                    error
                ),
            })
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let observables = fem_reference::observe_state(&self.problem, &self.state)?;
        Ok(crate::preview::build_mesh_preview_field(
            request,
            select_observables(&observables, &request.quantity),
        ))
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let observables = fem_reference::observe_state(&self.problem, &self.state)?;
        let mut cached = Vec::new();
        let mut seen = HashSet::new();
        for quantity in quantities
            .iter()
            .map(|quantity| normalize_quantity_id(quantity))
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(crate::preview::build_mesh_preview_field(
                &preview_request,
                select_observables(&observables, quantity),
            ));
        }
        Ok(cached)
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !self.plan_signature.eq(&normalize_fem_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive FEM CPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy =
            Some(fem_reference::observe_state(&self.problem, &self.state)?.total_energy);
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut steps: Vec<StepStats> = Vec::new();

        while self.state.time_seconds - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step(&mut self.state, dt_step)
                .map_err(|error| RunError {
                    message: format!("interactive FEM CPU step failed: {}", error),
                })?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            let observables = fem_reference::observe_state(&self.problem, &self.state)?;
            let total_stats = make_step_stats(
                self.total_steps,
                self.state.time_seconds,
                report.dt_used,
                wall_elapsed,
                &observables,
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(crate::preview::build_mesh_preview_field(
                    &preview_cfg,
                    select_observables(&observables, &preview_cfg.quantity),
                ))
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            steps.push(local_stats.clone());
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        Ok(RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_fem_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive FEM CPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let initial_magnetization = self.state.magnetization().to_vec();
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        let initial_observables = fem_reference::observe_state(&self.problem, &self.state)?;
        let mut steps = Vec::new();
        if default_scalar_trace {
            let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
        } else {
            record_due_cpu_outputs(
                &initial_observables,
                0,
                0.0,
                0.0,
                0,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy =
            Some(fem_reference::observe_state(&self.problem, &self.state)?.total_energy);
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut latest_local_stats: Option<StepStats> = None;

        while self.state.time_seconds - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step(&mut self.state, dt_step)
                .map_err(|error| RunError {
                    message: format!("interactive FEM CPU step failed: {}", error),
                })?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            let observables = fem_reference::observe_state(&self.problem, &self.state)?;
            let total_stats = make_step_stats(
                self.total_steps,
                self.state.time_seconds,
                report.dt_used,
                wall_elapsed,
                &observables,
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            latest_local_stats = Some(local_stats.clone());

            record_due_cpu_outputs(
                &observables,
                local_stats.step,
                local_stats.time,
                report.dt_used,
                wall_elapsed,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(crate::preview::build_mesh_preview_field(
                    &preview_cfg,
                    select_observables(&observables, &preview_cfg.quantity),
                ))
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        if let Some(final_stats) = latest_local_stats {
            let final_observables = fem_reference::observe_state(&self.problem, &self.state)?;
            record_final_cpu_outputs(
                &final_observables,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
                default_scalar_trace,
                &field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
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
                final_magnetization: self.state.magnetization().to_vec(),
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
        })
    }
}

#[cfg(feature = "fem-gpu")]
impl GpuInteractiveFemPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.backend
            .copy_live_preview_field(request, self.node_count)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let mut cached = Vec::new();
        let mut seen = HashSet::new();

        for quantity in quantities
            .iter()
            .map(|quantity| normalize_quantity_id(quantity))
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(
                self.backend
                    .copy_live_preview_field(&preview_request, self.node_count)?,
            );
        }

        Ok(cached)
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !self.plan_signature.eq(&normalize_fem_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive FEM GPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy: Option<f64> = None;
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());

        while self.total_time - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let total_stats = self.backend.step(dt_step)?;
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(
                    self.backend
                        .copy_live_preview_field(&preview_cfg, self.node_count)?,
                )
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            steps.push(local_stats.clone());
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        Ok(RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: self.backend.copy_m(self.node_count)?,
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_fem_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive FEM GPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let initial_magnetization = self.backend.copy_m(self.node_count)?;
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        capture_initial_native_fem_runtime_fields(
            &self.backend,
            self.node_count,
            &mut field_schedules,
            &mut artifacts,
        )?;

        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = plan
            .fixed_timestep
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(1e-13);
        let mut previous_total_energy: Option<f64> = None;
        let mut last_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;

        while self.total_time - base_time < until_seconds {
            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let total_stats = self.backend.step(dt_step)?;
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            latest_local_stats = Some(local_stats.clone());
            let preview_cfg = preview_request();
            let preview_emit_every = u64::from(preview_cfg.every_n.max(1));
            let preview_due = last_preview_revision != Some(preview_cfg.revision)
                || local_stats.step <= 1
                || local_stats.step % preview_emit_every == 0;
            let preview_field = if preview_due {
                last_preview_revision = Some(preview_cfg.revision);
                Some(
                    self.backend
                        .copy_live_preview_field(&preview_cfg, self.node_count)?,
                )
            } else {
                None
            };
            let scalar_row_due =
                local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                scalar_row_due,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
                break;
            }

            record_due_native_fem_runtime_outputs(
                &self.backend,
                self.node_count,
                &local_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.max_steps
                    || relaxation_converged(
                        control,
                        &total_stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        record_final_native_fem_runtime_outputs(
            &self.backend,
            self.node_count,
            latest_local_stats,
            default_scalar_trace,
            &scalar_schedules,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )?;

        let final_magnetization = self.backend.copy_m(self.node_count)?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        Ok(ExecutedRun {
            result: RunResult {
                status: if cancelled {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Completed
                },
                steps,
                final_magnetization,
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
        })
    }
}

fn normalize_plan_signature(plan: &FdmPlanIR) -> FdmPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
}

fn normalize_fem_plan_signature(plan: &FemPlanIR) -> FemPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
}

fn record_due_cpu_outputs(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(time, schedule.next_time));
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    if scalar_due {
        let stats = make_step_stats(step, time, solver_dt, wall_time_ns, observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
        advance_due_schedules(scalar_schedules, time);
    }

    if !due_field_names.is_empty() {
        for name in due_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time,
                solver_dt,
                values: select_output_field_values_from_observables(observables, &name)?,
            })?;
        }
        advance_due_schedules(field_schedules, time);
    }

    Ok(())
}

fn record_final_cpu_outputs(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, time))
            .unwrap_or(true);

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|sampled| !same_time(sampled, time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !need_scalar && missing_field_names.is_empty() {
        return Ok(());
    }

    if need_scalar {
        let stats = make_step_stats(step, time, solver_dt, 0, observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }

    for name in missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time,
            solver_dt,
            values: select_output_field_values_from_observables(observables, &name)?,
        })?;
    }

    Ok(())
}

fn select_output_field_values_from_observables(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = select_output_base_field_from_observables(observables, base)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported interactive output snapshot component '{}' in '{}'",
                        other, name
                    ),
                })
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }
    select_output_base_field_from_observables(observables, name)
}

fn select_output_base_field_from_observables(
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
                message: format!("unsupported interactive output field snapshot '{}'", other),
            })
        }
    })
}

#[cfg(feature = "fem-gpu")]
fn capture_initial_native_fem_runtime_fields(
    backend: &NativeFemBackend,
    node_count: usize,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: 0,
            time: 0.0,
            solver_dt: 0.0,
            values: copy_native_fem_field_values(backend, node_count, &name)?,
        })?;
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn record_due_native_fem_runtime_outputs(
    backend: &NativeFemBackend,
    node_count: usize,
    stats: &StepStats,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        artifacts.record_scalar(stats)?;
        steps.push(stats.clone());
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: stats.step,
            time: stats.time,
            solver_dt: stats.dt,
            values: copy_native_fem_field_values(backend, node_count, &name)?,
        })?;
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn record_final_native_fem_runtime_outputs(
    backend: &NativeFemBackend,
    node_count: usize,
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, latest_stats.time))
            .unwrap_or(true);
    if need_scalar {
        artifacts.record_scalar(&latest_stats)?;
        steps.push(latest_stats.clone());
    }

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|sampled| !same_time(sampled, latest_stats.time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in &missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: latest_stats.step,
            time: latest_stats.time,
            solver_dt: latest_stats.dt,
            values: copy_native_fem_field_values(backend, node_count, name)?,
        })?;
    }
    let _ = scalar_schedules;
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn copy_native_fem_field_values(
    backend: &NativeFemBackend,
    node_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = copy_native_fem_base_field_values(backend, node_count, base)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported interactive FEM snapshot component '{}' in '{}'",
                        other, name
                    ),
                })
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }

    copy_native_fem_base_field_values(backend, node_count, name)
}

#[cfg(feature = "fem-gpu")]
fn copy_native_fem_base_field_values(
    backend: &NativeFemBackend,
    node_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    match name {
        "m" => backend.copy_m(node_count),
        "H_ex" => backend.copy_h_ex(node_count),
        "H_demag" => backend.copy_h_demag(node_count),
        "H_ext" => backend.copy_h_ext(node_count),
        "H_eff" => backend.copy_h_eff(node_count),
        other => Err(RunError {
            message: format!(
                "unsupported interactive FEM output field snapshot '{}'",
                other
            ),
        }),
    }
}

#[cfg(feature = "cuda")]
fn capture_initial_cuda_runtime_fields(
    backend: &NativeFdmBackend,
    cell_count: usize,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: 0,
            time: 0.0,
            solver_dt: 0.0,
            values: copy_cuda_field_values(backend, cell_count, &name)?,
        })?;
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_due_cuda_runtime_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    stats: &StepStats,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        artifacts.record_scalar(stats)?;
        steps.push(stats.clone());
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: stats.step,
            time: stats.time,
            solver_dt: stats.dt,
            values: copy_cuda_field_values(backend, cell_count, &name)?,
        })?;
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_final_cuda_runtime_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, latest_stats.time))
            .unwrap_or(true);
    if need_scalar {
        artifacts.record_scalar(&latest_stats)?;
        steps.push(latest_stats.clone());
    }

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|sampled| !same_time(sampled, latest_stats.time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in &missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: latest_stats.step,
            time: latest_stats.time,
            solver_dt: latest_stats.dt,
            values: copy_cuda_field_values(backend, cell_count, name)?,
        })?;
    }
    let _ = scalar_schedules;
    Ok(())
}

#[cfg(feature = "cuda")]
fn copy_cuda_field_values(
    backend: &NativeFdmBackend,
    cell_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = copy_cuda_base_field_values(backend, cell_count, base)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported interactive CUDA snapshot component '{}' in '{}'",
                        other, name
                    ),
                })
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }

    copy_cuda_base_field_values(backend, cell_count, name)
}

#[cfg(feature = "cuda")]
fn copy_cuda_base_field_values(
    backend: &NativeFdmBackend,
    cell_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    match name {
        "m" => backend.copy_m(cell_count),
        "H_ex" => backend.copy_h_ex(cell_count),
        "H_demag" => backend.copy_h_demag(cell_count),
        "H_ext" => backend.copy_h_ext(cell_count),
        "H_eff" => backend.copy_h_eff(cell_count),
        other => Err(RunError {
            message: format!(
                "unsupported interactive CUDA output field snapshot '{}'",
                other
            ),
        }),
    }
}

fn cpu_execution_provenance(plan: &FdmPlanIR) -> ExecutionProvenance {
    ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if plan.enable_demag {
            Some("rustfft".to_string())
        } else {
            None
        },
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
    }
}

#[cfg(feature = "cuda")]
fn cuda_execution_provenance(
    plan: &FdmPlanIR,
    device_info: &crate::native_fdm::DeviceInfo,
) -> ExecutionProvenance {
    ExecutionProvenance {
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
    }
}

#[cfg(feature = "fem-gpu")]
fn fem_gpu_execution_provenance(
    plan: &FemPlanIR,
    device_info: &FemDeviceInfo,
) -> ExecutionProvenance {
    ExecutionProvenance {
        execution_engine: "native_fem_gpu".to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: if plan.enable_demag {
            Some(match plan.demag_realization.as_deref() {
                Some("poisson_airbox") => "fem_poisson_airbox".to_string(),
                _ => "fem_transfer_grid_tensor_fft_newell".to_string(),
            })
        } else {
            None
        },
        fft_backend: if plan.enable_demag
            && plan.demag_realization.as_deref() != Some("poisson_airbox")
        {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
    }
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &crate::types::StateObservables,
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
    crate::scalar_metrics::apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats
}
