use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use std::collections::HashSet;

#[cfg(feature = "fem-gpu")]
use fullmag_engine::fem::FemBackendId;
use fullmag_engine::fem::{FemIntegratorWorkspace, FemLlgProblem, FemLlgState};
use fullmag_engine::{ExchangeLlgProblem, ExchangeLlgState, FftWorkspace, IntegratorBuffers};
use fullmag_ir::{BackendPlanIR, FdmPlanIR, FemPlanIR, OutputIR, ProblemIR, RelaxationAlgorithmIR};

use crate::cpu_reference;
use crate::dispatch::{self, FdmEngine, FemEngine};
use crate::fem_baseline;
#[cfg(feature = "cuda")]
use crate::native_fdm::{NativeFdmBackend, NativeFdmPreviewSnapshot};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{DeviceInfo as FemDeviceInfo, NativeFemBackend};
use crate::preview::{
    build_grid_preview_field, build_mesh_preview_field_with_active_mask, mesh_quantity_active_mask,
    select_observables,
};
use crate::quantities::normalized_quantity_name;
use crate::relaxation::{llg_overdamped_uses_pure_damping, relaxation_converged};
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, LivePreviewField, LivePreviewRequest,
    RunError, RunResult, RunStatus, StateObservables, StepAction, StepStats, StepUpdate,
};
use crate::DisplaySelectionState;

pub(crate) fn display_refresh_due(
    last_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    local_step: u64,
) -> bool {
    let cadence = u64::from(display_state.selection.every_n.max(1));
    last_preview_revision != Some(display_state.revision)
        || local_step <= 1
        || local_step % cadence == 0
}

pub(crate) fn cached_preview_refresh_due(
    last_cached_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    local_step: u64,
    field_every_n: u64,
) -> bool {
    let cadence = field_every_n.max(1);
    last_cached_preview_revision != Some(display_state.revision)
        || local_step <= 1
        || local_step % cadence == 0
}

pub(crate) fn cached_preview_quantities_for(
    display_state: &DisplaySelectionState,
) -> Vec<&'static str> {
    let active_quantity = (!display_is_global_scalar(display_state))
        .then_some(display_state.selection.quantity.as_str());
    crate::quantities::cached_preview_quantity_ids()
        .into_iter()
        .filter(|quantity| Some(*quantity) != active_quantity)
        .collect()
}

fn build_cached_grid_preview_fields(
    display_state: &DisplaySelectionState,
    observables: &StateObservables,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Option<Vec<LivePreviewField>> {
    let quantities = cached_preview_quantities_for(display_state);
    if quantities.is_empty() {
        return None;
    }
    let base_request = display_state.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let values = select_observables(observables, quantity).ok()?;
        cached.push(build_grid_preview_field(
            &request,
            values,
            grid,
            active_mask,
        ));
    }
    Some(cached)
}

fn build_cached_mesh_preview_fields(
    display_state: &DisplaySelectionState,
    observables: &StateObservables,
    mesh: &fullmag_ir::MeshIR,
) -> Option<Vec<LivePreviewField>> {
    let quantities = cached_preview_quantities_for(display_state);
    if quantities.is_empty() {
        return None;
    }
    let base_request = display_state.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let values = select_observables(observables, quantity).ok()?;
        cached.push(build_mesh_preview_field_with_active_mask(
            &request,
            values,
            mesh_quantity_active_mask(quantity, mesh),
        ));
    }
    Some(cached)
}

pub(crate) fn display_is_global_scalar(display_state: &DisplaySelectionState) -> bool {
    matches!(
        display_state.selection.kind,
        crate::DisplayKind::GlobalScalar
    )
}

#[cfg(test)]
mod tests {
    use super::{cached_preview_refresh_due, display_refresh_due};
    use crate::interactive::display::DisplaySelectionState;

    #[test]
    fn display_refresh_due_honors_selection_revision_and_every_n() {
        let mut display_state = DisplaySelectionState::default();
        display_state.revision = 7;
        display_state.selection.every_n = 50;

        assert!(display_refresh_due(None, &display_state, 0));
        assert!(display_refresh_due(Some(6), &display_state, 13));
        assert!(display_refresh_due(Some(7), &display_state, 0));
        assert!(display_refresh_due(Some(7), &display_state, 1));
        assert!(!display_refresh_due(Some(7), &display_state, 2));
        assert!(!display_refresh_due(Some(7), &display_state, 49));
        assert!(display_refresh_due(Some(7), &display_state, 50));
        assert!(display_refresh_due(Some(7), &display_state, 100));
    }

    #[test]
    fn cached_preview_refresh_due_honors_field_every_n() {
        let mut display_state = DisplaySelectionState::default();
        display_state.revision = 3;

        assert!(cached_preview_refresh_due(None, &display_state, 0, 25));
        assert!(cached_preview_refresh_due(Some(2), &display_state, 17, 25));
        assert!(cached_preview_refresh_due(Some(3), &display_state, 0, 25));
        assert!(cached_preview_refresh_due(Some(3), &display_state, 1, 25));
        assert!(!cached_preview_refresh_due(Some(3), &display_state, 2, 25));
        assert!(!cached_preview_refresh_due(Some(3), &display_state, 24, 25));
        assert!(cached_preview_refresh_due(Some(3), &display_state, 25, 25));
    }
}

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
    #[allow(dead_code)]
    Cpu(CpuInteractiveFemPreviewRuntime),
    #[cfg(feature = "fem-gpu")]
    Gpu(GpuInteractiveFemPreviewRuntime),
}

struct CpuInteractiveFemPreviewRuntime {
    problem: FemLlgProblem,
    state: FemLlgState,
    integrator_ws: FemIntegratorWorkspace,
    antenna_field: Vec<[f64; 3]>,
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
    antenna_field: Vec<[f64; 3]>,
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

    pub fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_step_stats(),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.snapshot_step_stats(),
        }
    }

    pub fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                grid,
                field_every_n,
                display_selection,
                interrupt_requested,
                on_step,
            ),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                grid,
                field_every_n,
                display_selection,
                interrupt_requested,
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
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
                    display_selection,
                    interrupt_requested,
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
                    display_selection,
                    interrupt_requested,
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
        let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?;
        eprintln!(
            "[fullmag-runner] interactive FEM engine: resolved_engine_id={} fallback={:?}",
            dispatch::fem_engine_label(resolution.engine),
            resolution.fallback.as_ref().map(|f| &f.reason),
        );
        Self::from_fem_plan(fem, resolution.engine)
    }

    fn from_fem_plan(plan: &FemPlanIR, engine: FemEngine) -> Result<Self, RunError> {
        #[cfg(not(feature = "fem-gpu"))]
        {
            let _ = (plan, engine);
            return Err(RunError {
                message:
                    "interactive native FEM runtime requested but the runner was built without fem-gpu"
                        .to_string(),
            });
        }

        #[cfg(feature = "fem-gpu")]
        {
            let effective_plan = match engine {
                FemEngine::CpuNative => fem_plan_for_cpu_native(plan),
                FemEngine::NativeGpu => plan.clone(),
            };
            let mesh = crate::types::FemMeshPayload::from(&effective_plan);
            let backend = NativeFemBackend::create(&effective_plan)?;
            let device_info = backend.device_info()?;
            let antenna_field = crate::antenna_fields::compute_antenna_field(&effective_plan)?;
            let inner = InteractiveFemPreviewRuntimeInner::Gpu(GpuInteractiveFemPreviewRuntime {
                backend,
                mesh,
                node_count: effective_plan.mesh.nodes.len(),
                plan_signature: normalize_fem_plan_signature(&effective_plan),
                provenance: fem_gpu_execution_provenance(&effective_plan, &device_info),
                total_steps: 0,
                total_time: 0.0,
                antenna_field,
            });
            Ok(Self { inner })
        }
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
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                field_every_n,
                display_selection,
                interrupt_requested,
                on_step,
            ),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                field_every_n,
                display_selection,
                interrupt_requested,
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
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
                    display_selection,
                    interrupt_requested,
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
                    display_selection,
                    interrupt_requested,
                    on_step,
                ),
        }
    }

    pub fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_step_stats(),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.snapshot_step_stats(),
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
            select_observables(&observables, &request.quantity)?,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
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
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(build_grid_preview_field(
                &preview_request,
                select_observables(&observables, quantity)?,
                self.original_grid,
                self.plan_signature.active_mask.as_deref(),
            ));
        }
        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        Ok(make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &observables,
        ))
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy =
            Some(cpu_reference::observe_state(&self.problem, &self.state)?.total_energy);
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let initial_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut current_observables = initial_observables;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                build_cached_grid_preview_fields(
                    &display_state,
                    &current_observables,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

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

            // Build lightweight StepStats from the StepReport (no redundant
            // observe).  Full observe_state is deferred until we know that
            // preview or cached-preview data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or cached preview refresh).
            let needs_observables =
                (preview_due && !display_is_global_scalar(&display_state)) || cached_preview_due;

            if needs_observables {
                let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
                current_observables = observables;
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                build_cached_grid_preview_fields(
                    &display_state,
                    &current_observables,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        _interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
            display_selection,
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
            auxiliary_artifacts: vec![],
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_cpu_streaming_loop(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy =
            Some(cpu_reference::observe_state(&self.problem, &self.state)?.total_energy);
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested: None, // CPU FDM checks interrupt via on_step StepAction
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

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

            // Build lightweight StepStats from the StepReport (no redundant
            // observe).  Full observe_state is deferred until we know that
            // outputs, preview, or field data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());

            // Determine what outputs are due BEFORE deciding whether to run
            // the expensive observe_state.
            let scalar_output_due = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            let due_field_names: Vec<String> = field_schedules
                .iter()
                .filter(|schedule| is_due(local_stats.time, schedule.next_time))
                .map(|schedule| schedule.name.clone())
                .collect();

            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let needs_observables = scalar_output_due
                || !due_field_names.is_empty()
                || (preview_due && !display_is_global_scalar(&display_state));

            // Only run the expensive full observe when actually needed.
            if needs_observables {
                let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
                current_observables = observables;
            }

            if scalar_output_due || !due_field_names.is_empty() {
                record_due_cpu_outputs(
                    &current_observables,
                    local_stats.step,
                    local_stats.time,
                    report.dt_used,
                    wall_elapsed,
                    scalar_schedules,
                    field_schedules,
                    steps,
                    artifacts,
                )?;
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            // Cooperative checkpoint: poll for pending control requests
            let control = checkpoint.check_control();
            if control != crate::interactive::commands::RuntimeControlOutcome::Continue {
                cancelled = true;
                break;
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
        );

        Ok(RunResult {
            status,
            steps: steps.clone(),
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }
}

#[cfg(feature = "cuda")]
impl CudaInteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        self.backend.refresh_observables()
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.backend.copy_live_preview_field(
            request,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
        )
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
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(self.backend.copy_live_preview_field(
                &preview_request,
                self.original_grid,
                self.plan_signature.active_mask.as_deref(),
            )?);
        }

        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats(self.original_grid)
    }

    fn begin_cached_preview_prefetch(
        &self,
        display_state: &DisplaySelectionState,
    ) -> Result<Option<Vec<NativeFdmPreviewSnapshot>>, RunError> {
        let quantities = cached_preview_quantities_for(display_state);
        if quantities.is_empty() {
            return Ok(None);
        }
        let base_request = display_state.preview_request();
        let mut snapshots = Vec::with_capacity(quantities.len());
        let mut seen = HashSet::new();
        for quantity in quantities
            .into_iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut request = base_request.clone();
            request.quantity = quantity.to_string();
            snapshots.push(
                self.backend
                    .begin_live_preview_snapshot(&request, self.original_grid)?,
            );
        }
        Ok(Some(snapshots))
    }

    fn resolve_cached_preview_prefetch(
        &self,
        snapshots: Vec<NativeFdmPreviewSnapshot>,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        snapshots
            .into_iter()
            .map(|snapshot| {
                snapshot.into_live_preview_field(self.plan_signature.active_mask.as_deref())
            })
            .collect()
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy: Option<f64> = None;
        let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut current_local_stats = self.backend.snapshot_step_stats(grid)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;
        let initial_display_state = (checkpoint.display_selection)();
        let mut pending_cached_preview_snapshots =
            self.begin_cached_preview_prefetch(&initial_display_state)?;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                match pending_cached_preview_snapshots.take() {
                    Some(snapshots) => Some(self.resolve_cached_preview_prefetch(snapshots)?),
                    None => {
                        let preview_cfg = display_state.preview_request();
                        let quantities = cached_preview_quantities_for(&display_state);
                        if quantities.is_empty() {
                            None
                        } else {
                            Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                        }
                    }
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }
            let post_step_display_state = (checkpoint.display_selection)();
            // Only start async cached-preview GPU→CPU copies when the next
            // iteration will actually consume them.
            let next_cached_step = (total_stats.step - base_step) + 1;
            if cached_preview_refresh_due(
                last_cached_preview_revision,
                &post_step_display_state,
                next_cached_step,
                field_every_n,
            ) {
                pending_cached_preview_snapshots =
                    self.begin_cached_preview_prefetch(&post_step_display_state)?;
            } else {
                pending_cached_preview_snapshots = None;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let stop_for_relaxation = if let Some(control) = plan.relaxation.as_ref() {
                if let Some(completion) = self.backend.stage_completion()? {
                    backend_completion = Some(completion);
                    true
                } else {
                    local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                        || relaxation_converged(
                            control,
                            &total_stats,
                            previous_total_energy,
                            plan.gyromagnetic_ratio,
                            plan.material.damping,
                            pure_damping_relax,
                        )
                }
            } else {
                false
            };
            previous_total_energy = Some(total_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = if let Some(mut completion) = backend_completion {
            completion.status = match status {
                RunStatus::Completed => "completed",
                RunStatus::Cancelled => "cancelled",
                RunStatus::Paused => "paused",
                RunStatus::Failed => "failed",
            }
            .to_string();
            completion
        } else {
            crate::relaxation::infer_stage_completion(
                status,
                plan.relaxation.as_ref(),
                &steps,
                plan.gyromagnetic_ratio,
                plan.material.damping,
                pure_damping_relax,
            )
        };

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.backend.copy_m(cell_count)?,
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy: Option<f64> = None;
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_local_stats = self.backend.snapshot_step_stats(grid)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;
        let initial_display_state = (checkpoint.display_selection)();
        let mut pending_cached_preview_snapshots =
            self.begin_cached_preview_prefetch(&initial_display_state)?;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                match pending_cached_preview_snapshots.take() {
                    Some(snapshots) => Some(self.resolve_cached_preview_prefetch(snapshots)?),
                    None => {
                        let preview_cfg = display_state.preview_request();
                        let quantities = cached_preview_quantities_for(&display_state);
                        if quantities.is_empty() {
                            None
                        } else {
                            Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                        }
                    }
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }
            let post_step_display_state = (checkpoint.display_selection)();
            // Only start async cached-preview GPU→CPU copies when the next
            // iteration will actually consume them.
            let next_cached_step = (total_stats.step - base_step) + 1;
            if cached_preview_refresh_due(
                last_cached_preview_revision,
                &post_step_display_state,
                next_cached_step,
                field_every_n,
            ) {
                pending_cached_preview_snapshots =
                    self.begin_cached_preview_prefetch(&post_step_display_state)?;
            } else {
                pending_cached_preview_snapshots = None;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
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
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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
        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
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
            auxiliary_artifacts: vec![],
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
        let observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        Ok(build_mesh_preview_field_with_active_mask(
            request,
            select_observables(&observables, &request.quantity)?,
            mesh_quantity_active_mask(&request.quantity, &self.plan_signature.mesh),
        ))
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut cached = Vec::new();
        let mut seen = HashSet::new();
        for quantity in quantities
            .iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(build_mesh_preview_field_with_active_mask(
                &preview_request,
                select_observables(&observables, quantity)?,
                mesh_quantity_active_mask(quantity, &self.plan_signature.mesh),
            ));
        }
        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        let observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        Ok(make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &observables,
        ))
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy = Some(
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?
                .total_energy,
        );
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let initial_observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut current_observables = initial_observables;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                build_cached_mesh_preview_fields(
                    &display_state,
                    &current_observables,
                    &self.plan_signature.mesh,
                )
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (current_local_stats.step == 0).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step_with_workspace(&mut self.state, dt_step, &mut self.integrator_ws)
                .map_err(|error| RunError {
                    message: format!("interactive FEM CPU step failed: {}", error),
                })?;
            let step_wall_us = wall_start.elapsed().as_micros();
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // demag / observe).  Full observe_state is deferred until we know
            // that preview or cached-preview data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or cached preview refresh).
            let needs_observables =
                (preview_due && !display_is_global_scalar(&display_state)) || cached_preview_due;

            if needs_observables {
                let observe_start = std::time::Instant::now();
                let observables =
                    fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
                let observe_us = observe_start.elapsed().as_micros();
                current_observables = observables;

                if self.total_steps % 100 == 0 && (observe_us > 100 || step_wall_us > 5000) {
                    eprintln!(
                        "[fullmag-runner] FEM CPU step {} telemetry: integrate={:.1}ms observe={:.1}ms",
                        self.total_steps,
                        step_wall_us as f64 / 1000.0,
                        observe_us as f64 / 1000.0,
                    );
                }
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                build_cached_mesh_preview_fields(
                    &display_state,
                    &current_observables,
                    &self.plan_signature.mesh,
                )
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let initial_observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy = Some(
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?
                .total_energy,
        );
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (current_local_stats.step == 0).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step_with_workspace(&mut self.state, dt_step, &mut self.integrator_ws)
                .map_err(|error| RunError {
                    message: format!("interactive FEM CPU step failed: {}", error),
                })?;
            let step_wall_us = wall_start.elapsed().as_micros();
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // demag / observe).  Full observe_state is deferred until we know
            // that preview or field-snapshot data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());

            // Determine what outputs are due BEFORE deciding whether to run
            // the expensive observe_state.
            let scalar_due_for_output = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            let due_field_names: Vec<String> = field_schedules
                .iter()
                .filter(|schedule| is_due(local_stats.time, schedule.next_time))
                .map(|schedule| schedule.name.clone())
                .collect();

            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let needs_observables = !due_field_names.is_empty()
                || (preview_due && !display_is_global_scalar(&display_state));

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or field snapshot output).
            if needs_observables {
                let observe_start = std::time::Instant::now();
                let observables =
                    fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
                let observe_us = observe_start.elapsed().as_micros();
                current_observables = observables.clone();

                if self.total_steps % 100 == 0 && (observe_us > 100 || step_wall_us > 5000) {
                    eprintln!(
                        "[fullmag-runner] FEM CPU output-step {} telemetry: integrate={:.1}ms observe={:.1}ms",
                        self.total_steps,
                        step_wall_us as f64 / 1000.0,
                        observe_us as f64 / 1000.0,
                    );
                }

                // Record field snapshots that are due.
                if !due_field_names.is_empty() {
                    for name in &due_field_names {
                        artifacts.record_field_snapshot(FieldSnapshot {
                            name: name.clone(),
                            step: local_stats.step,
                            time: local_stats.time,
                            solver_dt: report.dt_used,
                            values: select_output_field_values_from_observables(
                                &observables,
                                name,
                            )?,
                        })?;
                    }
                    advance_due_schedules(&mut field_schedules, local_stats.time);
                }
            }

            // Record scalar outputs (uses StepStats only, no vector fields).
            if scalar_due_for_output {
                artifacts.record_scalar(&local_stats)?;
                steps.push(local_stats.clone());
                advance_due_schedules(&mut scalar_schedules, local_stats.time);
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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
            let final_observables =
                fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
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
        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
        );
        Ok(ExecutedRun {
            result: RunResult {
                status,
                steps,
                final_magnetization: self.state.magnetization().to_vec(),
                completion: Some(completion),
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
            auxiliary_artifacts: vec![],
        })
    }
}

#[cfg(feature = "fem-gpu")]
impl GpuInteractiveFemPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        let _ = self.backend.snapshot_step_stats(self.node_count)?;
        Ok(())
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        if normalized_quantity_name(&request.quantity).ok() == Some("H_ant") {
            return Ok(build_mesh_preview_field_with_active_mask(
                request,
                &self.antenna_field,
                None,
            ));
        }
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
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            if quantity == "H_ant" {
                cached.push(build_mesh_preview_field_with_active_mask(
                    &preview_request,
                    &self.antenna_field,
                    None,
                ));
            } else {
                cached.push(
                    self.backend
                        .copy_live_preview_field(&preview_request, self.node_count)?,
                );
            }
        }

        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats(self.node_count)
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy: Option<f64> = None;
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut current_local_stats = self.backend.snapshot_step_stats(self.node_count)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                let preview_cfg = display_state.preview_request();
                let quantities = cached_preview_quantities_for(&display_state);
                if quantities.is_empty() {
                    None
                } else {
                    Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (current_local_stats.step == 0).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_preview_due = cached_preview_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_preview_due {
                let preview_cfg = display_state.preview_request();
                let quantities = cached_preview_quantities_for(&display_state);
                if quantities.is_empty() {
                    None
                } else {
                    Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                }
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_preview_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.backend.copy_m(self.node_count)?,
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
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
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut previous_total_energy: Option<f64> = None;
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_local_stats = self.backend.snapshot_step_stats(self.node_count)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (current_local_stats.step == 0).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
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
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
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
        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            pure_damping_relax,
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
            auxiliary_artifacts: vec![],
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

#[cfg(feature = "fem-gpu")]
fn fem_plan_for_cpu_native(plan: &FemPlanIR) -> FemPlanIR {
    let mut native = plan.clone();
    if native.mfem_device_string.is_none() {
        native.mfem_device_string = Some("cpu".to_string());
    }
    native
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
        "H_ant" => observables.antenna_field.clone(),
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
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: None,
        resolved_integrator: None,
        requested_demag_realization: None,
        resolved_demag_realization: None,
        dt_policy: None,
        mfem_device: None,
        demag_refresh_interval_s: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
    }
}

#[cfg(feature = "cuda")]
fn cuda_execution_provenance(
    plan: &FdmPlanIR,
    device_info: &crate::native_fdm::DeviceInfo,
) -> ExecutionProvenance {
    let dt_policy = if plan.adaptive_timestep.is_some() {
        Some("adaptive".to_string())
    } else if plan.fixed_timestep.is_some() {
        Some("user".to_string())
    } else {
        Some("fallback".to_string())
    };
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
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: Some(format!("{:?}", plan.integrator)),
        resolved_integrator: Some(format!("{:?}", plan.integrator)),
        requested_demag_realization: None,
        resolved_demag_realization: None,
        dt_policy,
        mfem_device: None,
        demag_refresh_interval_s: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
    }
}

#[cfg(feature = "fem-gpu")]
fn fem_gpu_execution_provenance(
    plan: &FemPlanIR,
    device_info: &FemDeviceInfo,
) -> ExecutionProvenance {
    let dt_policy = if plan.adaptive_timestep.is_some() {
        Some("adaptive".to_string())
    } else if plan.fixed_timestep.is_some() {
        Some("user".to_string())
    } else {
        Some("fallback".to_string())
    };
    let execution_engine = native_fem_backend_id(plan).provenance_name();
    let resolved_demag_realization = resolved_native_fem_demag(plan);
    ExecutionProvenance {
        execution_engine: execution_engine.to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: resolved_demag_realization
            .map(|realization| realization.provenance_name().to_string()),
        fft_backend: None,
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: Some(format!("{:?}", plan.integrator)),
        resolved_integrator: Some(format!("{:?}", plan.integrator)),
        requested_demag_realization: plan
            .demag_realization
            .map(|r| r.provenance_name().to_string()),
        resolved_demag_realization: resolved_demag_realization
            .map(|realization| realization.provenance_name().to_string()),
        dt_policy,
        mfem_device: plan.mfem_device_string.clone(),
        demag_refresh_interval_s: plan
            .field_refresh
            .as_ref()
            .and_then(|policy| policy.demag_interval_s),
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_backend_id(plan: &FemPlanIR) -> FemBackendId {
    if plan.mfem_device_string.as_deref() == Some("cpu") {
        FemBackendId::CpuNative
    } else {
        FemBackendId::GpuNative
    }
}

#[cfg(feature = "fem-gpu")]
fn resolved_native_fem_demag(plan: &FemPlanIR) -> Option<fullmag_ir::ResolvedFemDemagIR> {
    if plan.enable_demag {
        Some(
            plan.demag_realization
                .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
        )
    } else {
        None
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
    stats.per_object_scalars = observables.per_object_scalars.clone();
    stats
}

/// Lightweight version of `make_step_stats` that uses only the `StepReport`
/// scalars and the current magnetization vector, avoiding a full
/// `observe_state` (which recomputes all fields including demag).
fn make_step_stats_from_report(
    step: u64,
    time: f64,
    report: &fullmag_engine::StepReport,
    wall_time_ns: u64,
    magnetization: &[[f64; 3]],
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: report.dt_used,
        e_ex: report.exchange_energy_joules,
        e_demag: report.demag_energy_joules,
        e_ext: report.external_energy_joules,
        e_total: report.total_energy_joules,
        max_dm_dt: report.max_rhs_amplitude,
        max_h_eff: report.max_effective_field_amplitude,
        max_h_demag: report.max_demag_field_amplitude,
        max_torque_Apm: report.max_torque_Apm,
        max_torque_T: report.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    crate::scalar_metrics::apply_average_m_to_step_stats(&mut stats, magnetization);
    stats
}

// ---------------------------------------------------------------------------
// InteractiveBackend trait implementations
// ---------------------------------------------------------------------------

use crate::interactive::backend::{BackendGeometry, InteractiveBackend};

impl InteractiveBackend for InteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.upload_magnetization(magnetization)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.snapshot_preview(request)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        self.snapshot_vector_fields(quantities, request)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.snapshot_step_stats()
    }

    fn execution_provenance(&self) -> ExecutionProvenance {
        self.execution_provenance()
    }

    fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.matches_plan(fdm))
    }

    fn geometry(&self) -> BackendGeometry {
        let grid = match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(r) => r.original_grid,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(r) => r.original_grid,
        };
        BackendGeometry::Fdm { grid }
    }

    fn execute_streaming(
        &mut self,
        problem: &ProblemIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Err(RunError {
                message: "InteractiveBackend(FDM)::execute_streaming requires FDM plan".into(),
            });
        };
        self.execute_with_live_preview_streaming(
            fdm,
            until_seconds,
            &plan.output_plan.outputs,
            fdm.grid.cells,
            field_every_n,
            display_selection,
            interrupt_requested,
            artifact_writer,
            on_step,
        )
    }
}

impl InteractiveBackend for InteractiveFemPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.upload_magnetization(magnetization)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.snapshot_preview(request)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        self.snapshot_vector_fields(quantities, request)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.snapshot_step_stats()
    }

    fn execution_provenance(&self) -> ExecutionProvenance {
        self.execution_provenance()
    }

    fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.matches_plan(fem))
    }

    fn geometry(&self) -> BackendGeometry {
        let mesh = match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(r) => r.mesh.clone(),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(r) => r.mesh.clone(),
        };
        BackendGeometry::Fem { mesh }
    }

    fn execute_streaming(
        &mut self,
        problem: &ProblemIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Err(RunError {
                message: "InteractiveBackend(FEM)::execute_streaming requires FEM plan".into(),
            });
        };
        self.execute_with_live_preview_streaming(
            fem,
            until_seconds,
            &plan.output_plan.outputs,
            field_every_n,
            artifact_writer,
            display_selection,
            interrupt_requested,
            on_step,
        )
    }
}
