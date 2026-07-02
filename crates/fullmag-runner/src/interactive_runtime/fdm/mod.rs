pub(crate) mod cpu;
#[cfg(feature = "cuda")]
pub(crate) mod cuda;

use super::*;

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

    pub(super) fn from_fdm_plan(plan: &FdmPlanIR, engine: FdmEngine) -> Result<Self, RunError> {
        let inner = match engine {
            FdmEngine::CpuReference => {
                let (problem, state) = cpu_reference::build_snapshot_problem_and_state(plan)?;
                let state_soa = if problem.soa_fast_path_supported() {
                    Some(state.to_soa())
                } else {
                    None
                };
                let fft_workspace = problem.create_workspace();
                let integrator_buffers = problem.create_integrator_buffers();
                let provenance = cpu_execution_provenance(plan)?;
                InteractiveFdmPreviewRuntimeInner::Cpu(CpuInteractiveFdmPreviewRuntime {
                    problem,
                    state,
                    state_soa,
                    last_step_report: None,
                    fft_workspace,
                    integrator_buffers,
                    original_grid: plan.grid.cells,
                    plan_signature: normalize_plan_signature(plan),
                    provenance,
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
