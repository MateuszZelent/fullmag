//! Engine dispatch: selects between CPU reference and native backends.
//!
//! Reads `FULLMAG_FDM_EXECUTION` env var:
//! - `auto` (default): use CUDA if compiled and available, else CPU
//! - `cpu`: force CPU reference
//! - `cuda`: force CUDA, fail if unavailable
//!
//! Reads `FULLMAG_FEM_EXECUTION` env var:
//! - `auto` (default): use native FEM GPU if compiled and available, else CPU reference
//! - `cpu`: force CPU reference
//! - `gpu`: force native FEM GPU, fail if unavailable

use fullmag_ir::{FdmMultilayerPlanIR, FdmPlanIR, FemPlanIR, OutputIR, ProblemIR};
use serde_json::Value;

use crate::cpu_reference;
use crate::fem_reference;
#[cfg(feature = "cuda")]
use crate::multilayer_cuda;
use crate::multilayer_reference;
use crate::native_fdm;
#[cfg(feature = "cuda")]
use crate::native_fdm::NativeFdmBackend;
use crate::native_fem;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemBackend;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::relaxation::relaxation_converged;
#[cfg(feature = "cuda")]
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
#[cfg(all(feature = "fem-gpu", not(feature = "cuda")))]
use crate::schedules::{collect_field_schedules, collect_scalar_schedules};
use crate::types::{ExecutedRun, LivePreviewRequest, LiveStepConsumer, RunError, StepAction, StepUpdate};
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::types::{ExecutionProvenance, FieldSnapshot, RunResult, RunStatus, StepStats};

/// Which execution engine to use for FDM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FdmEngine {
    /// CPU reference engine (fullmag-engine).
    CpuReference,
    /// Native CUDA FDM backend.
    CudaFdm,
}

/// Which execution engine to use for FEM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemEngine {
    /// CPU reference engine (fullmag-engine).
    CpuReference,
    /// Native GPU FEM backend scaffold / future MFEM backend.
    NativeGpu,
}

/// Resolve which FDM engine to use based on environment and availability.
pub(crate) fn resolve_fdm_engine(problem: &ProblemIR) -> Result<FdmEngine, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let ir_policy = runtime_fdm_policy(problem);
    let (policy, env_override) = match std::env::var("FULLMAG_FDM_EXECUTION") {
        Ok(env_val) => {
            if env_val != ir_policy {
                eprintln!(
                    "warning: FULLMAG_FDM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
            }
            (env_val, true)
        }
        Err(_) => (ir_policy.to_string(), false),
    };
    let _ = env_override; // reserved for future diagnostics

    let engine = match policy.as_str() {
        "cpu" => Ok(FdmEngine::CpuReference),
        "cuda" => {
            if native_fdm::is_cuda_available() {
                Ok(FdmEngine::CudaFdm)
            } else {
                Err(RunError {
                    message: "FULLMAG_FDM_EXECUTION=cuda but CUDA backend is not available"
                        .to_string(),
                })
            }
        }
        "auto" | _ => {
            if native_fdm::is_cuda_available() {
                Ok(FdmEngine::CudaFdm)
            } else {
                Ok(FdmEngine::CpuReference)
            }
        }
    }?;

    // Reject direct-minimization algorithms (BB/NCG) on CUDA — not yet ported
    if engine == FdmEngine::CudaFdm {
        reject_direct_minimization_on_cuda(problem)?;
    }

    Ok(engine)
}

/// Resolve which FEM engine to use based on environment and availability.
pub(crate) fn resolve_fem_engine(problem: &ProblemIR) -> Result<FemEngine, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let ir_policy = runtime_fem_policy(problem);
    let fe_order = runtime_fem_order(problem);
    let policy = match std::env::var("FULLMAG_FEM_EXECUTION") {
        Ok(env_val) => {
            if env_val != ir_policy {
                eprintln!(
                    "warning: FULLMAG_FEM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
            }
            env_val
        }
        Err(_) => ir_policy.to_string(),
    };

    match policy.as_str() {
        "cpu" => Ok(FemEngine::CpuReference),
        "gpu" => {
            if !native_fem::is_gpu_available() {
                Err(RunError {
                    message:
                        "FULLMAG_FEM_EXECUTION=gpu but the native FEM GPU backend is not available"
                            .to_string(),
                })
            } else if fe_order != 1 {
                Err(RunError {
                    message: format!(
                        "FULLMAG_FEM_EXECUTION=gpu requested native FEM GPU execution, but the current native backend supports fe_order=1 only (requested order={})",
                        fe_order
                    ),
                })
            } else {
                Ok(FemEngine::NativeGpu)
            }
        }
        "auto" | _ => {
            if native_fem::is_gpu_available() && fe_order == 1 {
                Ok(FemEngine::NativeGpu)
            } else {
                if native_fem::is_gpu_available() && fe_order != 1 {
                    eprintln!(
                        "warning: native FEM GPU backend currently supports fe_order=1 only; falling back to CPU for requested FEM order={}",
                        fe_order
                    );
                }
                Ok(FemEngine::CpuReference)
            }
        }
    }
}

fn runtime_selection(problem: &ProblemIR) -> Option<&serde_json::Map<String, Value>> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
}

fn runtime_device(problem: &ProblemIR) -> Option<&str> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
}

fn runtime_device_index(problem: &ProblemIR) -> Option<u32> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device_index"))
        .and_then(Value::as_u64)
        .map(|index| index as u32)
}

fn runtime_fdm_policy(problem: &ProblemIR) -> &'static str {
    match runtime_device(problem) {
        Some("cpu") => "cpu",
        Some("cuda") | Some("gpu") => "cuda",
        _ => "auto",
    }
}

fn runtime_fem_policy(problem: &ProblemIR) -> &'static str {
    match runtime_device(problem) {
        Some("cpu") => "cpu",
        Some("cuda") | Some("gpu") => "gpu",
        _ => "auto",
    }
}

fn runtime_fem_order(problem: &ProblemIR) -> u32 {
    problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fem.as_ref())
        .map(|hints| hints.order)
        .unwrap_or(1)
}

fn apply_runtime_gpu_index(problem: &ProblemIR, backend: &str) {
    let Some(index) = runtime_device_index(problem) else {
        return;
    };
    let specific_env = match backend {
        "fdm" => "FULLMAG_FDM_GPU_INDEX",
        "fem" => "FULLMAG_FEM_GPU_INDEX",
        _ => return,
    };
    if std::env::var_os(specific_env).is_none() {
        std::env::set_var(specific_env, index.to_string());
    }
    if std::env::var_os("FULLMAG_CUDA_DEVICE_INDEX").is_none() {
        std::env::set_var("FULLMAG_CUDA_DEVICE_INDEX", index.to_string());
    }
}

/// Reject BB and NCG relaxation algorithms on CUDA — they are only implemented
/// for the CPU reference engine. Return a clear error instead of silent fallback.
fn reject_direct_minimization_on_cuda(problem: &ProblemIR) -> Result<(), RunError> {
    use fullmag_ir::RelaxationAlgorithmIR;

    // Check if the study is a relaxation with a direct-minimization algorithm
    let algorithm = match &problem.study {
        fullmag_ir::StudyIR::Relaxation { algorithm, .. } => algorithm,
        _ => return Ok(()),
    };

    match algorithm {
        RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg => {
            Err(RunError {
                message: format!(
                    "relaxation algorithm '{}' is only implemented for the CPU reference engine; \
                     use algorithm='llg_overdamped' for CUDA execution, or switch to device='cpu'",
                    algorithm.as_str()
                ),
            })
        }
        _ => Ok(()),
    }
}

/// Execute an FDM plan using the selected engine.
pub(crate) fn execute_fdm(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => {
            cpu_reference::execute_reference_fdm(plan, until_seconds, outputs)
        }
        FdmEngine::CudaFdm => execute_cuda_fdm(plan, until_seconds, outputs),
    }
}

pub(crate) fn execute_fdm_multilayer(
    engine: FdmEngine,
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => {
            multilayer_reference::execute_reference_fdm_multilayer(plan, until_seconds, outputs)
        }
        FdmEngine::CudaFdm => {
            #[cfg(feature = "cuda")]
            {
                return multilayer_cuda::execute_cuda_fdm_multilayer(plan, until_seconds, outputs);
            }
            #[cfg(not(feature = "cuda"))]
            {
                return Err(RunError {
                    message:
                        "FULLMAG_FDM_EXECUTION=cuda requested for multilayer FDM, but fullmag-runner was built without the cuda feature"
                            .to_string(),
                });
            }
        }
    }
}

/// Execute a FEM plan using the selected engine.
pub(crate) fn execute_fem(
    engine: FemEngine,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    match engine {
        FemEngine::CpuReference => {
            fem_reference::execute_reference_fem(plan, until_seconds, outputs)
        }
        FemEngine::NativeGpu => execute_native_fem_impl(plan, until_seconds, outputs, None),
    }
}

/// Execute FEM with a per-step callback for live streaming.
pub(crate) fn execute_fem_with_callback(
    engine: FemEngine,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FemEngine::CpuReference => fem_reference::execute_reference_fem_with_callback(
            plan,
            until_seconds,
            outputs,
            field_every_n,
            on_step,
        ),
        FemEngine::NativeGpu => execute_native_fem_impl(
            plan,
            until_seconds,
            outputs,
            Some(LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n,
                preview_request: None,
                on_step,
            }),
        ),
    }
}

pub(crate) fn execute_fem_with_live_preview(
    engine: FemEngine,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FemEngine::CpuReference => fem_reference::execute_reference_fem_with_live_preview(
            plan,
            until_seconds,
            outputs,
            field_every_n,
            preview_request,
            on_step,
        ),
        FemEngine::NativeGpu => execute_native_fem_impl(
            plan,
            until_seconds,
            outputs,
            Some(LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n,
                preview_request: Some(preview_request),
                on_step,
            }),
        ),
    }
}

/// Execute FDM with a per-step callback for live streaming.
pub(crate) fn execute_fdm_with_callback(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    grid: [u32; 3],
    field_every_n: u64,
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => cpu_reference::execute_reference_fdm_with_callback(
            plan,
            until_seconds,
            outputs,
            grid,
            field_every_n,
            on_step,
        ),
        FdmEngine::CudaFdm => execute_cuda_fdm_impl(
            plan,
            until_seconds,
            outputs,
            Some(LiveStepConsumer {
                grid,
                field_every_n,
                preview_request: None,
                on_step,
            }),
        ),
    }
}

pub(crate) fn execute_fdm_with_live_preview(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    grid: [u32; 3],
    field_every_n: u64,
    preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => cpu_reference::execute_reference_fdm_with_live_preview(
            plan,
            until_seconds,
            outputs,
            grid,
            field_every_n,
            preview_request,
            on_step,
        ),
        FdmEngine::CudaFdm => execute_cuda_fdm_impl(
            plan,
            until_seconds,
            outputs,
            Some(LiveStepConsumer {
                grid,
                field_every_n,
                preview_request: Some(preview_request),
                on_step,
            }),
        ),
    }
}

pub(crate) fn execute_fdm_multilayer_with_callback(
    engine: FdmEngine,
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => {
            multilayer_reference::execute_reference_fdm_multilayer_with_callback(
                plan,
                until_seconds,
                outputs,
                on_step,
            )
        }
        FdmEngine::CudaFdm => {
            #[cfg(feature = "cuda")]
            {
                return multilayer_cuda::execute_cuda_fdm_multilayer_with_callback(
                    plan,
                    until_seconds,
                    outputs,
                    on_step,
                );
            }
            #[cfg(not(feature = "cuda"))]
            {
                return Err(RunError {
                    message:
                        "FULLMAG_FDM_EXECUTION=cuda requested for multilayer FDM, but fullmag-runner was built without the cuda feature"
                            .to_string(),
                });
            }
        }
    }
}

#[cfg(feature = "cuda")]
fn execute_cuda_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm_impl(plan, until_seconds, outputs, None)
}

#[cfg(feature = "cuda")]
fn execute_cuda_fdm_impl(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }

    let mut backend = NativeFdmBackend::create(plan)?;
    let device_info = backend.device_info()?;
    let cell_count = (plan.grid.cells[0] as usize)
        * (plan.grid.cells[1] as usize)
        * (plan.grid.cells[2] as usize);
    let initial_magnetization = backend.copy_m(cell_count)?;
    let dt = plan.fixed_timestep.unwrap_or(1e-13);

    let mut steps = Vec::new();
    let mut field_snapshots = Vec::new();
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();
    capture_initial_cuda_fields(
        &backend,
        cell_count,
        &mut field_schedules,
        &mut field_snapshots,
    )?;

    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut previous_total_energy: Option<f64> = None;
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    while current_time < until_seconds {
        let dt_step = dt.min(until_seconds - current_time);
        let stats = backend.step(dt_step)?;
        current_time = stats.time;
        latest_stats = Some(stats.clone());
        if let Some(live) = live.as_mut() {
            let emit_every = live.field_every_n.max(1);
            let preview_request = live.preview_request.map(|get| get());
            let preview_due = preview_request
                .as_ref()
                .map(|request| {
                    let preview_emit_every = u64::from(request.every_n.max(1));
                    last_preview_revision != Some(request.revision)
                        || stats.step <= 1
                        || stats.step % preview_emit_every == 0
                })
                .unwrap_or(false);
            let magnetization = if live.preview_request.is_none() && stats.step % emit_every == 0 {
                Some(flatten_vectors(&backend.copy_m(cell_count)?))
            } else {
                None
            };
            let preview_field = if preview_due {
                let request = preview_request.as_ref().expect("checked preview_due");
                let preview = backend.copy_live_preview_field(request, plan.grid.cells)?;
                last_preview_revision = Some(request.revision);
                Some(preview)
            } else {
                None
            };
            let action = (live.on_step)(StepUpdate {
                stats: stats.clone(),
                grid: live.grid,
                fem_mesh: None,
                magnetization,
                preview_field,
                finished: false,
            });
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
            &stats,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut field_snapshots,
        )?;
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            stats.step >= control.max_steps
                || relaxation_converged(
                    control,
                    &stats,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    plan.material.damping,
                )
        });
        previous_total_energy = Some(stats.e_total);
        if stop_for_relaxation {
            break;
        }
    }

    record_cuda_final_outputs(
        &backend,
        cell_count,
        latest_stats,
        default_scalar_trace,
        &field_schedules,
        &mut steps,
        &mut field_snapshots,
    )?;

    let final_magnetization = backend.copy_m(cell_count)?;

    Ok(ExecutedRun {
        result: RunResult {
            status: if cancelled { RunStatus::Cancelled } else { RunStatus::Completed },
            steps,
            final_magnetization,
        },
        initial_magnetization,
        field_snapshots,
        provenance: ExecutionProvenance {
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
            device_name: Some(device_info.name),
            compute_capability: Some(device_info.compute_capability),
            cuda_driver_version: Some(device_info.driver_version),
            cuda_runtime_version: Some(device_info.runtime_version),
        },
    })
}

#[cfg(feature = "fem-gpu")]
fn execute_native_fem(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_native_fem_impl(plan, until_seconds, outputs, None)
}

#[cfg(feature = "fem-gpu")]
fn execute_native_fem_impl(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }

    let mut backend = NativeFemBackend::create(plan)?;
    let device_info = backend.device_info()?;
    let node_count = plan.mesh.nodes.len();
    let initial_magnetization = backend.copy_m(node_count)?;
    let dt = plan.fixed_timestep.unwrap_or(1e-13);

    let mut steps = Vec::new();
    let mut field_snapshots = Vec::new();
    let scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut previous_total_energy: Option<f64> = None;
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    while current_time < until_seconds {
        let dt_step = dt.min(until_seconds - current_time);
        let stats = backend.step(dt_step)?;
        current_time = stats.time;
        latest_stats = Some(stats.clone());
        if let Some(live) = live.as_mut() {
            let emit_every = live.field_every_n.max(1);
            let preview_request = live.preview_request.map(|get| get());
            let preview_due = preview_request
                .as_ref()
                .map(|request| {
                    let preview_emit_every = u64::from(request.every_n.max(1));
                    last_preview_revision != Some(request.revision)
                        || stats.step <= 1
                        || stats.step % preview_emit_every == 0
                })
                .unwrap_or(false);
            let magnetization = if live.preview_request.is_none() && stats.step % emit_every == 0 {
                Some(flatten_vectors(&backend.copy_m(node_count)?))
            } else {
                None
            };
            let preview_field = if preview_due {
                let request = preview_request.as_ref().expect("checked preview_due");
                let preview = backend.copy_live_preview_field(request, node_count)?;
                last_preview_revision = Some(request.revision);
                Some(preview)
            } else {
                None
            };
            let action = (live.on_step)(StepUpdate {
                stats: stats.clone(),
                grid: live.grid,
                fem_mesh: Some(crate::types::FemMeshPayload {
                    nodes: plan.mesh.nodes.clone(),
                    elements: plan.mesh.elements.clone(),
                    boundary_faces: plan.mesh.boundary_faces.clone(),
                }),
                magnetization,
                preview_field,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
            }
        }
        if cancelled {
            break;
        }
        if default_scalar_trace || scalar_schedules.is_empty() {
            steps.push(stats);
        } else {
            steps.push(stats);
        }
        let latest = steps.last().expect("just pushed stats");
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            latest.step >= control.max_steps
                || relaxation_converged(
                    control,
                    latest,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    plan.material.damping,
                )
        });
        previous_total_energy = Some(latest.e_total);
        if stop_for_relaxation {
            break;
        }
    }

    let final_stats = latest_stats.unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });

    for schedule in &mut field_schedules {
        let values = match schedule.name.as_str() {
            "m" => backend.copy_m(node_count)?,
            "H_ex" => backend.copy_h_ex(node_count)?,
            "H_demag" => backend.copy_h_demag(node_count)?,
            "H_ext" => backend.copy_h_ext(node_count)?,
            "H_eff" => backend.copy_h_eff(node_count)?,
            other => {
                return Err(RunError {
                    message: format!("unsupported native FEM field snapshot '{}'", other),
                })
            }
        };
        field_snapshots.push(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        });
    }

    let final_magnetization = backend.copy_m(node_count)?;

    Ok(ExecutedRun {
        result: RunResult {
            status: if cancelled { RunStatus::Cancelled } else { RunStatus::Completed },
            steps,
            final_magnetization,
        },
        initial_magnetization,
        field_snapshots,
        provenance: ExecutionProvenance {
            execution_engine: "native_fem_gpu".to_string(),
            precision: match plan.precision {
                fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
                fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
            },
            demag_operator_kind: if plan.enable_demag {
                Some("fem_transfer_grid_fdm_demag".to_string())
            } else {
                None
            },
            fft_backend: if plan.enable_demag {
                Some("cuFFT".to_string())
            } else {
                None
            },
            device_name: Some(device_info.name),
            compute_capability: Some(device_info.compute_capability),
            cuda_driver_version: Some(device_info.driver_version),
            cuda_runtime_version: Some(device_info.runtime_version),
        },
    })
}

#[cfg(not(feature = "fem-gpu"))]
fn execute_native_fem(
    _plan: &FemPlanIR,
    _until_seconds: f64,
    _outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    Err(RunError {
        message:
            "native FEM GPU backend requested but fullmag-runner was built without the 'fem-gpu' feature"
                .to_string(),
    })
}

#[cfg(not(feature = "fem-gpu"))]
fn execute_native_fem_impl(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    _live: Option<LiveStepConsumer<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_native_fem(plan, until_seconds, outputs)
}

#[cfg(not(feature = "cuda"))]
fn execute_cuda_fdm(
    _plan: &FdmPlanIR,
    _until_seconds: f64,
    _outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    Err(RunError {
        message:
            "CUDA FDM backend requested but fullmag-runner was built without the 'cuda' feature"
                .to_string(),
    })
}

#[cfg(not(feature = "cuda"))]
fn execute_cuda_fdm_impl(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    _live: Option<LiveStepConsumer<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_cuda_fdm(plan, until_seconds, outputs)
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

#[cfg(feature = "cuda")]
fn capture_initial_cuda_fields(
    backend: &NativeFdmBackend,
    cell_count: usize,
    field_schedules: &mut [OutputSchedule],
    field_snapshots: &mut Vec<FieldSnapshot>,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        let values = match name.as_str() {
            "m" => backend.copy_m(cell_count)?,
            "H_ex" => backend.copy_h_ex(cell_count)?,
            "H_demag" => backend.copy_h_demag(cell_count)?,
            "H_ext" => backend.copy_h_ext(cell_count)?,
            "H_eff" => backend.copy_h_eff(cell_count)?,
            other => {
                return Err(RunError {
                    message: format!("unsupported CUDA field snapshot '{}'", other),
                })
            }
        };
        field_snapshots.push(FieldSnapshot {
            name: name.clone(),
            step: 0,
            time: 0.0,
            solver_dt: 0.0,
            values,
        });
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_cuda_due_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    stats: &StepStats,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    field_snapshots: &mut Vec<FieldSnapshot>,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        steps.push(stats.clone());
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        let values = match name.as_str() {
            "m" => backend.copy_m(cell_count)?,
            "H_ex" => backend.copy_h_ex(cell_count)?,
            "H_demag" => backend.copy_h_demag(cell_count)?,
            "H_ext" => backend.copy_h_ext(cell_count)?,
            "H_eff" => backend.copy_h_eff(cell_count)?,
            other => {
                return Err(RunError {
                    message: format!("unsupported CUDA field snapshot '{}'", other),
                })
            }
        };
        field_snapshots.push(FieldSnapshot {
            name: name.clone(),
            step: stats.step,
            time: stats.time,
            solver_dt: stats.dt,
            values,
        });
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_cuda_final_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    field_snapshots: &mut Vec<FieldSnapshot>,
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
        steps.push(latest_stats.clone());
    }

    let requested_field_names = field_schedules
        .iter()
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    let missing_field_names = requested_field_names
        .into_iter()
        .filter(|name| {
            field_snapshots
                .iter()
                .rev()
                .find(|snapshot| snapshot.name == *name)
                .map(|snapshot| !same_time(snapshot.time, latest_stats.time))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    for name in missing_field_names {
        let values = match name.as_str() {
            "m" => backend.copy_m(cell_count)?,
            "H_ex" => backend.copy_h_ex(cell_count)?,
            "H_demag" => backend.copy_h_demag(cell_count)?,
            "H_ext" => backend.copy_h_ext(cell_count)?,
            "H_eff" => backend.copy_h_eff(cell_count)?,
            other => {
                return Err(RunError {
                    message: format!("unsupported CUDA field snapshot '{}'", other),
                })
            }
        };
        field_snapshots.push(FieldSnapshot {
            name,
            step: latest_stats.step,
            time: latest_stats.time,
            solver_dt: latest_stats.dt,
            values,
        });
    }

    Ok(())
}
