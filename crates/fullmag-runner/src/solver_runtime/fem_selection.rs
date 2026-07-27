//! FEM runtime selection policy, availability handling, and fallback trails.

use fullmag_ir::{FemPlanIR, ProblemIR};

use crate::native_fem;
use crate::solver_runtime::diagnostics::{runtime_fallback, runtime_info_once, runtime_warn_once};
use crate::solver_runtime::engine::{fem_engine_id, EngineResolution, FemEngine};
use crate::solver_runtime::fem_crossover::resolve_auto_fem_plan_device;
use crate::solver_runtime::selection::{
    all_in_gpu_fem_env_requested, apply_runtime_gpu_index, effective_fem_device_request,
    fem_policy_requires_gpu, runtime_fem_order, runtime_fem_policy,
};
use crate::types::RunError;

pub(crate) fn has_antenna_field_source(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            fullmag_ir::CurrentModuleIR::AntennaFieldSource { .. }
        )
    })
}

fn native_fem_cpu_unavailable_error(
    availability: &native_fem::GpuAvailability,
    context: &str,
) -> RunError {
    RunError {
        message: format!(
            "native FEM CPU backend is not available for {}: {}",
            context, availability.reason
        ),
    }
}

/// Resolve which FEM engine to use based on environment and availability.
pub(crate) fn resolve_fem_engine_with_trail(
    problem: &ProblemIR,
) -> Result<EngineResolution<FemEngine>, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let ir_policy = runtime_fem_policy(problem);
    let fe_order = runtime_fem_order(problem);
    let (policy, env_override) = match std::env::var("FULLMAG_FEM_EXECUTION") {
        Ok(env_val) => {
            if env_val != ir_policy {
                let message = format!(
                    "FULLMAG_FEM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
                runtime_warn_once(&message);
            }
            (env_val, true)
        }
        Err(_) if all_in_gpu_fem_env_requested() => ("all_in_gpu".to_string(), true),
        Err(_) => (ir_policy.to_string(), false),
    };

    let availability = native_fem::native_availability();
    resolve_fem_engine_with_availability(problem, &policy, env_override, fe_order, &availability)
}

pub(crate) fn resolve_fem_engine_with_availability(
    problem: &ProblemIR,
    policy: &str,
    _env_override: bool,
    fe_order: u32,
    availability: &native_fem::GpuAvailability,
) -> Result<EngineResolution<FemEngine>, RunError> {
    if has_antenna_field_source(problem) {
        if fem_policy_requires_gpu(policy) {
            return Err(RunError {
                message:
                    "FEM GPU execution was requested, but native FEM GPU currently does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)"
                        .to_string(),
            });
        }
        if !availability.native_fem_cpu_available {
            return Err(native_fem_cpu_unavailable_error(
                availability,
                "current_modules_force_cpu fallback",
            ));
        }
        let message = "FEM engine falling back to MFEM/libCEED/hypre CPU FEM — native FEM GPU does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)".to_string();
        runtime_warn_once(&message);
        return Ok(EngineResolution {
            engine: FemEngine::CpuNative,
            fallback: Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "current_modules_force_cpu",
                message,
            )),
        });
    }

    match policy {
        "cpu" => {
            if !availability.native_fem_cpu_available {
                return Err(native_fem_cpu_unavailable_error(
                    availability,
                    "requested FEM CPU execution",
                ));
            }
            Ok(EngineResolution {
                engine: FemEngine::CpuNative,
                fallback: None,
            })
        }
        "gpu" | "all_in_gpu" => {
            if !availability.native_fem_gpu_available {
                Err(RunError {
                    message: format!(
                        "explicit FEM GPU execution was requested, but the native FEM GPU backend is not available: {}",
                        availability.reason
                    ),
                })
            } else if !availability.native_fem_gpu_full_demag_available
                && fem_policy_requires_gpu(policy)
            {
                Err(RunError {
                    message: format!(
                        "FEM GPU execution was requested, but strict full-in-GPU demag is unavailable: {} (fallback_reason=native_fem_gpu_full_demag_unavailable)",
                        availability.reason_gpu
                    ),
                })
            } else if fe_order != 1 {
                Err(RunError {
                    message: format!(
                        "explicit FEM GPU execution was requested, but the current native backend supports fe_order=1 only (requested order={}, fallback_reason=fem_gpu_fe_order_unsupported)",
                        fe_order
                    ),
                })
            } else {
                Ok(EngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                })
            }
        }
        "auto" | _ => {
            if availability.native_fem_gpu_available && fe_order == 1 {
                Ok(EngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                })
            } else if availability.native_fem_gpu_available && fe_order != 1 {
                if !availability.native_fem_cpu_available {
                    return Err(native_fem_cpu_unavailable_error(
                        availability,
                        "FEM auto fe_order fallback",
                    ));
                }
                let message = format!(
                    "native FEM GPU backend currently supports fe_order=1 only; falling back to MFEM/libCEED/hypre CPU FEM for requested fe_order={} (fallback_reason=fem_gpu_fe_order_unsupported)",
                    fe_order
                );
                runtime_warn_once(&message);
                Ok(EngineResolution {
                    engine: FemEngine::CpuNative,
                    fallback: Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        "fem_gpu_fe_order_unsupported",
                        message,
                    )),
                })
            } else {
                if !availability.native_fem_cpu_available {
                    return Err(native_fem_cpu_unavailable_error(
                        availability,
                        "FEM auto execution",
                    ));
                }
                let message = format!(
                    "native FEM GPU backend is not available — using MFEM/libCEED/hypre CPU FEM engine (fallback_reason=native_fem_gpu_unavailable; reason={})",
                    availability.reason
                );
                runtime_info_once(&message);
                Ok(EngineResolution {
                    engine: FemEngine::CpuNative,
                    fallback: Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        "native_fem_gpu_unavailable",
                        message,
                    )),
                })
            }
        }
    }
}

pub(crate) fn resolve_fem_engine(problem: &ProblemIR) -> Result<FemEngine, RunError> {
    resolve_fem_engine_with_trail(problem).map(|resolution| resolution.engine)
}

pub(crate) fn resolve_fem_engine_for_plan_with_trail(
    problem: &ProblemIR,
    plan: &FemPlanIR,
    preview_enabled: bool,
) -> Result<EngineResolution<FemEngine>, RunError> {
    if !native_fem::is_cpu_available() {
        return Err(RunError {
            message:
                "time-domain FEM execution requires the MFEM/libCEED runtime stack, but this launcher \
                 does not report native FEM CPU availability. Use the managed FEM runtime or rebuild \
                 the launcher with MFEM/libCEED/hypre CPU support."
                    .to_string(),
        });
    }
    let mut resolution = resolve_fem_engine_with_trail(problem)?;
    if resolution.engine == FemEngine::NativeGpu && effective_fem_device_request(problem) == "auto"
    {
        let decision = resolve_auto_fem_plan_device(plan, preview_enabled);
        if decision.resolved == "cpu" {
            let message = format!(
                "FEM auto-device policy resolved {} nodes to CPU ({})",
                plan.mesh.nodes.len(),
                decision.reason
            );
            resolution.engine = FemEngine::CpuNative;
            resolution.fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                &decision.reason,
                message,
            ));
        }
    }
    Ok(resolution)
}
