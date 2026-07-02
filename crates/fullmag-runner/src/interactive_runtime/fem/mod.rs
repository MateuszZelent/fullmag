use super::*;

mod cpu;
#[cfg(feature = "fem-gpu")]
mod gpu;

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
