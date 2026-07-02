//! Runtime selection helpers for user/env policy, registry lookup, and device hints.

use fullmag_ir::{FemPlanIR, ProblemIR};
use serde_json::Value;

use crate::fdm::gpu::cuda::native as native_fdm;
use crate::runtime_registry::RuntimeRegistry;
use crate::solver_runtime::diagnostics::{runtime_fallback, runtime_warn_once};
use crate::solver_runtime::engine::{fdm_engine_id, EngineResolution, FdmEngine};
use crate::types::{ResolvedFallback, RunError};

pub(crate) fn runtime_selection(problem: &ProblemIR) -> Option<&serde_json::Map<String, Value>> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
}

pub(crate) fn runtime_device(problem: &ProblemIR) -> Option<&str> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
}

pub(crate) fn runtime_precision(problem: &ProblemIR) -> &str {
    runtime_selection(problem)
        .and_then(|selection| selection.get("precision"))
        .and_then(Value::as_str)
        .unwrap_or(match problem.backend_policy.execution_precision {
            fullmag_ir::ExecutionPrecision::Single => "single",
            fullmag_ir::ExecutionPrecision::Double => "double",
        })
}

pub(crate) fn requested_registry_device_for_fdm(problem: &ProblemIR) -> String {
    match std::env::var("FULLMAG_FDM_EXECUTION").ok().as_deref() {
        Some("cpu") => "cpu".to_string(),
        Some("cuda") => "gpu".to_string(),
        Some("auto") | None => runtime_device(problem)
            .unwrap_or("auto")
            .replace("cuda", "gpu"),
        Some(other) => other.replace("cuda", "gpu"),
    }
}

pub(crate) fn requested_registry_device_for_fem(problem: &ProblemIR) -> String {
    if all_in_gpu_fem_env_requested() {
        return "gpu".to_string();
    }
    match std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref() {
        Some("cpu") => "cpu".to_string(),
        Some("gpu") | Some("cuda") | Some("all_in_gpu") => "gpu".to_string(),
        Some("auto") | None => runtime_device(problem)
            .unwrap_or("auto")
            .replace("cuda", "gpu"),
        Some(other) => other.replace("cuda", "gpu"),
    }
}

pub(crate) struct RegistryRuntimeMatch {
    pub runtime_family: String,
    pub worker: String,
    pub device: String,
    pub fallback: Option<ResolvedFallback>,
}

pub(crate) fn resolve_registry_runtime_for_backend(
    registry: &RuntimeRegistry,
    backend: &str,
    requested_device: &str,
    precision: &str,
) -> Option<RegistryRuntimeMatch> {
    if requested_device != "auto" {
        let resolved = registry.resolve(backend, requested_device, precision)?;
        return Some(RegistryRuntimeMatch {
            runtime_family: resolved.runtime_family,
            worker: resolved.worker,
            device: requested_device.to_string(),
            fallback: None,
        });
    }

    if let Some(resolved) = registry.resolve(backend, "gpu", precision) {
        return Some(RegistryRuntimeMatch {
            runtime_family: resolved.runtime_family,
            worker: resolved.worker,
            device: "gpu".to_string(),
            fallback: None,
        });
    }

    registry
        .resolve(backend, "cpu", precision)
        .map(|resolved| RegistryRuntimeMatch {
            runtime_family: resolved.runtime_family,
            worker: resolved.worker,
            device: "cpu".to_string(),
            fallback: Some(runtime_fallback(
                &format!("{backend}_gpu"),
                &format!("{backend}_cpu"),
                match backend {
                    "fdm" => "fdm_cuda_unavailable",
                    "fem" => "native_fem_gpu_unavailable",
                    _ => "runtime_unavailable",
                },
                format!(
                    "preferred {backend} GPU runtime is unavailable in the runtime registry; using CPU runtime"
                ),
            )),
        })
}

fn runtime_device_index(problem: &ProblemIR) -> Option<u32> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device_index"))
        .and_then(Value::as_u64)
        .map(|index| index as u32)
}

pub(crate) fn runtime_fdm_policy(problem: &ProblemIR) -> &'static str {
    match runtime_device(problem) {
        Some("cpu") => "cpu",
        Some("cuda") | Some("gpu") => "cuda",
        _ => "auto",
    }
}

pub(crate) fn runtime_fem_policy(problem: &ProblemIR) -> &'static str {
    match runtime_device(problem) {
        Some("cpu") => "cpu",
        Some("cuda") | Some("gpu") => "gpu",
        _ => "auto",
    }
}

/// Resolve which FDM engine to use based on environment and availability.
pub(crate) fn resolve_fdm_engine_with_trail(
    problem: &ProblemIR,
) -> Result<EngineResolution<FdmEngine>, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let ir_policy = runtime_fdm_policy(problem);
    let (policy, env_override) = match std::env::var("FULLMAG_FDM_EXECUTION") {
        Ok(env_val) => {
            if env_val != ir_policy {
                let message = format!(
                    "FULLMAG_FDM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
                runtime_warn_once(&message);
            }
            (env_val, true)
        }
        Err(_) => (ir_policy.to_string(), false),
    };

    let resolution = match policy.as_str() {
        "cpu" => Ok(EngineResolution {
            engine: FdmEngine::CpuReference,
            fallback: None,
        }),
        "cuda" => {
            if native_fdm::is_cuda_available() {
                Ok(EngineResolution {
                    engine: FdmEngine::CudaFdm,
                    fallback: None,
                })
            } else if env_override {
                Err(RunError {
                    message: "FULLMAG_FDM_EXECUTION=cuda but CUDA backend is not available"
                        .to_string(),
                })
            } else {
                let message = "script requested CUDA FDM execution, but the CUDA backend is not available — falling back to CPU".to_string();
                runtime_warn_once(&message);
                Ok(EngineResolution {
                    engine: FdmEngine::CpuReference,
                    fallback: Some(runtime_fallback(
                        fdm_engine_id(FdmEngine::CudaFdm),
                        fdm_engine_id(FdmEngine::CpuReference),
                        "fdm_cuda_unavailable",
                        message,
                    )),
                })
            }
        }
        "auto" | _ => {
            if native_fdm::is_cuda_available() {
                Ok(EngineResolution {
                    engine: FdmEngine::CudaFdm,
                    fallback: None,
                })
            } else {
                Ok(EngineResolution {
                    engine: FdmEngine::CpuReference,
                    fallback: runtime_device(problem)
                        .filter(|device| matches!(*device, "gpu" | "cuda"))
                        .map(|_| {
                            runtime_fallback(
                                fdm_engine_id(FdmEngine::CudaFdm),
                                fdm_engine_id(FdmEngine::CpuReference),
                                "fdm_cuda_unavailable",
                                "preferred CUDA FDM runtime is unavailable; using CPU reference engine".to_string(),
                            )
                        }),
                })
            }
        }
    }?;

    Ok(resolution)
}

pub(crate) fn resolve_fdm_engine(problem: &ProblemIR) -> Result<FdmEngine, RunError> {
    resolve_fdm_engine_with_trail(problem).map(|resolution| resolution.engine)
}

pub(crate) fn runtime_fem_order(problem: &ProblemIR) -> u32 {
    problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fem.as_ref())
        .map(|hints| hints.order)
        .unwrap_or(1)
}

pub(crate) fn fem_gpu_execution_forced() -> bool {
    matches!(
        std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref(),
        Some("gpu") | Some("all_in_gpu")
    )
}

fn env_flag_enabled(value: Option<String>) -> bool {
    matches!(
        value
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "on" | "yes")
    )
}

pub(crate) fn all_in_gpu_fem_env_requested() -> bool {
    matches!(
        std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref(),
        Some("all_in_gpu")
    ) || env_flag_enabled(std::env::var("FULLMAG_FEM_ALL_IN_GPU").ok())
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn all_in_gpu_fem_required() -> bool {
    all_in_gpu_fem_env_requested()
}

pub(crate) fn fem_policy_requires_gpu(policy: &str) -> bool {
    matches!(policy, "gpu" | "all_in_gpu")
}

fn fem_gpu_min_nodes_threshold() -> Option<usize> {
    match std::env::var("FULLMAG_FEM_GPU_MIN_NODES") {
        Ok(raw) => match raw.trim().parse::<usize>() {
            Ok(0) => None,
            Ok(value) => Some(value),
            Err(_) => None,
        },
        Err(_) => None,
    }
}

pub(crate) fn should_fallback_to_cpu_for_small_fem_gpu(plan: &FemPlanIR) -> Option<usize> {
    if fem_gpu_execution_forced() {
        return None;
    }
    let min_nodes = fem_gpu_min_nodes_threshold()?;
    let node_count = plan.mesh.nodes.len();
    (node_count < min_nodes).then_some(min_nodes)
}

pub(crate) fn apply_runtime_gpu_index(problem: &ProblemIR, backend: &str) {
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
