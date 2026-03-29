use std::collections::HashSet;

use fullmag_engine::{
    ExchangeLlgProblem, ExchangeLlgState, FftWorkspace, IntegratorBuffers,
};
use fullmag_ir::{BackendPlanIR, FdmPlanIR, ProblemIR, RelaxationAlgorithmIR};

use crate::cpu_reference;
use crate::dispatch::{self, FdmEngine};
#[cfg(feature = "cuda")]
use crate::native_fdm::NativeFdmBackend;
use crate::preview::{build_grid_preview_field, normalize_quantity_id, select_observables};
use crate::relaxation::{llg_overdamped_uses_pure_damping, relaxation_converged};
use crate::types::{
    ExecutionProvenance, LivePreviewField, LivePreviewRequest, RunError, RunResult, RunStatus,
    StepAction, StepStats, StepUpdate,
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
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.plan_signature == normalized,
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
        for quantity in quantities.iter().map(|quantity| normalize_quantity_id(quantity)) {
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
            let scalar_row_due = local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
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
        self.backend.copy_live_preview_field(request, self.original_grid)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let mut cached = Vec::new();
        let mut seen = HashSet::new();

        for quantity in quantities.iter().map(|quantity| normalize_quantity_id(quantity)) {
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
            let scalar_row_due = local_stats.step <= 1 || local_stats.step % field_every_n.max(1) == 0;
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
}

fn normalize_plan_signature(plan: &FdmPlanIR) -> FdmPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
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
