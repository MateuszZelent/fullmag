//! Runtime selection helpers for user/env policy, registry lookup, and device hints.

use fullmag_ir::ProblemIR;
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

pub(crate) fn effective_fem_device_request(problem: &ProblemIR) -> String {
    effective_fem_device_request_from_sources(
        runtime_device(problem),
        std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref(),
        all_in_gpu_fem_env_requested(),
    )
}

fn effective_fem_device_request_from_sources(
    script_device: Option<&str>,
    execution_env: Option<&str>,
    all_in_gpu_requested: bool,
) -> String {
    if all_in_gpu_requested {
        return "gpu".to_string();
    }
    match execution_env {
        Some("cpu") => "cpu".to_string(),
        Some("gpu") | Some("cuda") | Some("all_in_gpu") => "gpu".to_string(),
        Some("auto") => "auto".to_string(),
        None => script_device.unwrap_or("auto").replace("cuda", "gpu"),
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

fn has_prescribed_zeeman_mask_antenna(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            fullmag_ir::CurrentModuleIR::AntennaFieldSource {
                model: fullmag_ir::AntennaFieldSourceModelIR::PrescribedZeemanMask,
                ..
            }
        )
    })
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
    let policy = match std::env::var("FULLMAG_FDM_EXECUTION") {
        Ok(env_val) => {
            if env_val != ir_policy {
                let message = format!(
                    "FULLMAG_FDM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
                runtime_warn_once(&message);
            }
            env_val
        }
        Err(_) => ir_policy.to_string(),
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
            } else {
                Err(RunError {
                    message:
                        "FDM CUDA execution was requested, but the CUDA backend is not available"
                            .to_string(),
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
                    fallback: Some(runtime_fallback(
                        fdm_engine_id(FdmEngine::CudaFdm),
                        fdm_engine_id(FdmEngine::CpuReference),
                        "fdm_cuda_unavailable",
                        "preferred CUDA FDM runtime is unavailable; using CPU reference engine"
                            .to_string(),
                    )),
                })
            }
        }
    }?;

    if resolution.engine == FdmEngine::CudaFdm && has_prescribed_zeeman_mask_antenna(problem) {
        if policy == "cuda" {
            return Err(RunError {
                message: "FDM CUDA execution was requested, but CUDA FDM currently does not support prescribed_zeeman_mask antenna sources (fallback_reason=antenna_zeeman_mask_force_cpu)".to_string(),
            });
        }
        let message = "FDM engine falling back to CPU reference — CUDA FDM currently does not support prescribed_zeeman_mask antenna sources (fallback_reason=antenna_zeeman_mask_force_cpu)".to_string();
        runtime_warn_once(&message);
        return Ok(EngineResolution {
            engine: FdmEngine::CpuReference,
            fallback: Some(runtime_fallback(
                fdm_engine_id(FdmEngine::CudaFdm),
                fdm_engine_id(FdmEngine::CpuReference),
                "antenna_zeeman_mask_force_cpu",
                message,
            )),
        });
    }

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

#[cfg(test)]
mod tests {
    use super::{effective_fem_device_request_from_sources, resolve_fdm_engine_with_trail};
    use fullmag_ir::ProblemIR;
    use serde_json::Value;
    use std::sync::{LazyLock, Mutex};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn fem_effective_request_collision_matrix_is_deterministic() {
        for script in ["cpu", "auto", "gpu"] {
            assert_eq!(
                effective_fem_device_request_from_sources(Some(script), None, false),
                script
            );
            for execution_env in ["cpu", "auto", "gpu"] {
                assert_eq!(
                    effective_fem_device_request_from_sources(
                        Some(script),
                        Some(execution_env),
                        false,
                    ),
                    execution_env,
                    "FULLMAG_FEM_EXECUTION must override script device"
                );
                assert_eq!(
                    effective_fem_device_request_from_sources(
                        Some(script),
                        Some(execution_env),
                        true,
                    ),
                    "gpu",
                    "FULLMAG_FEM_ALL_IN_GPU must override both script and execution env"
                );
            }
        }
    }

    #[test]
    fn script_forced_gpu_fails_closed_when_cuda_is_unavailable() {
        let _guard = ENV_LOCK.lock().expect("lock FDM execution environment");
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            Value::Object(
                [("device".to_string(), Value::String("gpu".to_string()))]
                    .into_iter()
                    .collect(),
            ),
        );
        unsafe {
            std::env::remove_var("FULLMAG_FDM_EXECUTION");
        }

        let error = resolve_fdm_engine_with_trail(&problem)
            .expect_err("a script-forced GPU request must not fall back to CPU");

        assert!(error.message.contains("CUDA backend is not available"));
    }

    #[test]
    fn auto_fdm_gpu_miss_keeps_a_cpu_fallback_trail() {
        let _guard = ENV_LOCK.lock().expect("lock FDM execution environment");
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            Value::Object(
                [("device".to_string(), Value::String("auto".to_string()))]
                    .into_iter()
                    .collect(),
            ),
        );
        unsafe {
            std::env::remove_var("FULLMAG_FDM_EXECUTION");
        }

        let resolution = resolve_fdm_engine_with_trail(&problem)
            .expect("auto FDM request should select an available engine");

        assert_eq!(resolution.engine, super::FdmEngine::CpuReference);
        let fallback = resolution
            .fallback
            .expect("unavailable CUDA must remain visible for auto FDM");
        assert_eq!(fallback.reason, "fdm_cuda_unavailable");
    }
}
