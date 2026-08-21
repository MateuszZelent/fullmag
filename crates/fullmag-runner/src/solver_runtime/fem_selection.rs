//! FEM runtime selection policy, availability handling, and fallback trails.

use fullmag_ir::{FemPlanIR, ProblemIR};

use crate::native_fem;
use crate::solver_runtime::diagnostics::{runtime_fallback, runtime_info_once, runtime_warn_once};
use crate::solver_runtime::engine::{fem_engine_id, FemEngine, FemEngineResolution};
use crate::solver_runtime::fem_crossover::resolve_auto_fem_plan_device;
use crate::solver_runtime::selection::{
    apply_runtime_gpu_index, effective_fem_device_request, effective_fem_device_request_for_plan,
    fem_policy_requires_gpu, reject_frozen_spins_fem_execution,
    reject_frozen_spins_fem_plan_execution, runtime_fem_order, runtime_fem_policy,
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
) -> Result<FemEngineResolution, RunError> {
    reject_frozen_spins_fem_execution(problem)?;
    apply_runtime_gpu_index(problem, "fem");
    let policy = effective_fem_device_request(problem);
    let availability = native_fem::native_availability();
    resolve_fem_engine_with_effective_request_and_availability(problem, &policy, &availability)
}

fn resolve_fem_engine_with_effective_request_and_availability(
    problem: &ProblemIR,
    policy: &str,
    availability: &native_fem::GpuAvailability,
) -> Result<FemEngineResolution, RunError> {
    let script_policy = runtime_fem_policy(problem);
    if policy != script_policy {
        runtime_warn_once(&format!(
            "effective FEM device request={} overrides script runtime_selection.device={script_policy}",
            policy
        ));
    }
    resolve_fem_engine_with_availability(
        problem,
        policy,
        true,
        runtime_fem_order(problem),
        availability,
    )
}

pub(crate) fn resolve_fem_engine_with_availability(
    problem: &ProblemIR,
    policy: &str,
    _env_override: bool,
    fe_order: u32,
    availability: &native_fem::GpuAvailability,
) -> Result<FemEngineResolution, RunError> {
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
        return Ok(FemEngineResolution {
            engine: FemEngine::CpuNative,
            fallback: Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "current_modules_force_cpu",
                message,
            )),
            fem_crossover_decision: None,
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
            Ok(FemEngineResolution {
                engine: FemEngine::CpuNative,
                fallback: None,
                fem_crossover_decision: None,
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
                Ok(FemEngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                    fem_crossover_decision: None,
                })
            }
        }
        "auto" | _ => {
            if availability.native_fem_gpu_available && fe_order == 1 {
                Ok(FemEngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                    fem_crossover_decision: None,
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
                Ok(FemEngineResolution {
                    engine: FemEngine::CpuNative,
                    fallback: Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        "fem_gpu_fe_order_unsupported",
                        message,
                    )),
                    fem_crossover_decision: None,
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
                Ok(FemEngineResolution {
                    engine: FemEngine::CpuNative,
                    fallback: Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        "native_fem_gpu_unavailable",
                        message,
                    )),
                    fem_crossover_decision: None,
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
) -> Result<FemEngineResolution, RunError> {
    reject_frozen_spins_fem_execution(problem)?;
    reject_frozen_spins_fem_plan_execution(plan)?;
    apply_runtime_gpu_index(problem, "fem");
    let requested_device = effective_fem_device_request_for_plan(problem, plan);
    let availability = native_fem::native_availability();
    if !availability.native_fem_cpu_available {
        return Err(RunError {
            message:
                "time-domain FEM execution requires the MFEM/libCEED runtime stack, but this launcher                  does not report native FEM CPU availability. Use the managed FEM runtime or rebuild                  the launcher with MFEM/libCEED/hypre CPU support."
                    .to_string(),
        });
    }
    if !plan.spin_transport_plans.is_empty() {
        let policy = std::env::var("FULLMAG_FEM_EXECUTION")
            .unwrap_or_else(|_| runtime_fem_policy(problem).to_string());
        if fem_policy_requires_gpu(&policy) {
            return Err(RunError {
                message: "FEM steady spin transport is qualified only for CPU-double; an explicit GPU execution request cannot fall back before provenance".to_string(),
            });
        }
        return Ok(FemEngineResolution {
            engine: FemEngine::CpuNative,
            fallback: None,
            fem_crossover_decision: None,
        });
    }
    let mut resolution = resolve_fem_engine_with_effective_request_and_availability(
        problem,
        &requested_device,
        &availability,
    )?;
    if requested_device == "auto" {
        let mut decision = resolve_auto_fem_plan_device(plan, preview_enabled);
        if resolution.engine == FemEngine::NativeGpu && decision.resolved == "cpu" {
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
        decision.resolved = match resolution.engine {
            FemEngine::CpuNative => "cpu".to_string(),
            FemEngine::NativeGpu => "gpu".to_string(),
        };
        if let Some(fallback) = resolution.fallback.as_ref() {
            decision.reason = fallback.reason.clone();
        }
        resolution.fem_crossover_decision = Some(decision);
    }
    Ok(resolution)
}
#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{BackendTarget, DiscretizationHintsIR, FdmHintsIR, FemHintsIR};
    use serde_json::Value;

    fn fem_policy_problem(script_device: &str) -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
            fdm: Some(FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
                boundary_correction: None,
                boundary_phi_floor: None,
                boundary_delta_min: None,
            }),
            fem: Some(FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: None,
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            Value::Object(
                [(
                    "device".to_string(),
                    Value::String(script_device.to_string()),
                )]
                .into_iter()
                .collect(),
            ),
        );
        problem
    }

    fn full_availability() -> native_fem::GpuAvailability {
        native_fem::GpuAvailability {
            available: true,
            available_any: true,
            available_cpu: true,
            available_gpu: true,
            built_with_mfem_stack: true,
            built_with_cuda_runtime: true,
            built_with_ceed: false,
            native_fem_cpu_available: true,
            native_fem_gpu_available: true,
            native_fem_gpu_full_demag_available: true,
            mfem_cuda_available: true,
            hypre_gpu_available: true,
            libceed_used_hot_path: false,
            visible_cuda_device_count: 1,
            requested_gpu_index: -1,
            resolved_gpu_index: 0,
            memory_free_bytes: 8_000_000_000,
            memory_total_bytes: 12_000_000_000,
            reason: "test CPU/GPU availability".to_string(),
            reason_cpu: "test CPU availability".to_string(),
            reason_gpu: "test GPU availability".to_string(),
        }
    }

    #[test]
    fn retained_resolver_uses_the_canonical_effective_request_collision_matrix() {
        let availability = full_availability();
        for script_device in ["cpu", "auto", "gpu"] {
            for execution_env in [None, Some("cpu"), Some("auto"), Some("gpu")] {
                for all_in_gpu in [false, true] {
                    let expected_request =
                        crate::solver_runtime::selection::effective_fem_device_request_from_sources(
                            Some(script_device),
                            None,
                            execution_env,
                            all_in_gpu,
                        );
                    let resolution = resolve_fem_engine_with_effective_request_and_availability(
                        &fem_policy_problem(script_device),
                        &expected_request,
                        &availability,
                    )
                    .expect("the retained resolver should select an available FEM lane");
                    let expected_engine = if expected_request == "cpu" {
                        FemEngine::CpuNative
                    } else {
                        FemEngine::NativeGpu
                    };
                    assert_eq!(
                        resolution.engine, expected_engine,
                        "script={script_device} execution={execution_env:?} all_in_gpu={all_in_gpu}"
                    );
                }
            }
        }
    }

    #[test]
    fn managed_cpu_override_resolves_cpu_without_fallback_while_script_stays_auto() {
        let mut problem = fem_policy_problem("auto");
        problem.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            serde_json::json!({"device": "cpu", "source": "managed_launcher"}),
        );
        let effective = crate::solver_runtime::selection::effective_fem_device_request_from_sources(
            crate::solver_runtime::selection::runtime_device(&problem),
            crate::solver_runtime::selection::runtime_device_override(&problem),
            None,
            false,
        );
        let resolution = resolve_fem_engine_with_effective_request_and_availability(
            &problem,
            &effective,
            &full_availability(),
        )
        .expect("managed CPU override must resolve the CPU engine");

        assert_eq!(
            crate::solver_runtime::selection::runtime_device(&problem),
            Some("auto"),
        );
        assert_eq!(effective, "cpu");
        assert_eq!(resolution.engine, FemEngine::CpuNative);
        assert!(resolution.fallback.is_none());
    }
}
