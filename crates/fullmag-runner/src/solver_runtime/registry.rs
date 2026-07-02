//! Runtime-registry engine resolution for backend dispatch.

use fullmag_ir::{BackendPlanIR, FemPlanIR, ProblemIR};

use crate::runtime_registry::RuntimeRegistry;
use crate::solver_runtime::diagnostics::runtime_fallback;
use crate::solver_runtime::engine::{
    fem_engine_id, DispatchEngine, DispatchEngineResolution, FdmEngine, FemEngine,
};
use crate::solver_runtime::fem_selection::{
    has_antenna_field_source, resolve_fem_engine_for_plan_with_trail, resolve_fem_engine_with_trail,
};
use crate::solver_runtime::selection::{
    apply_runtime_gpu_index, requested_registry_device_for_fdm, requested_registry_device_for_fem,
    resolve_fdm_engine_with_trail, resolve_registry_runtime_for_backend, runtime_fem_order,
    runtime_precision, should_fallback_to_cpu_for_small_fem_gpu,
};
use crate::types::RunError;

pub(crate) fn resolve_fdm_engine_with_registry(
    problem: &ProblemIR,
    registry: &RuntimeRegistry,
    _explicit_selection: bool,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let requested_device = requested_registry_device_for_fdm(problem);
    let requested_precision = runtime_precision(problem).to_string();
    let resolved = resolve_registry_runtime_for_backend(
        registry,
        "fdm",
        &requested_device,
        &requested_precision,
    )
    .ok_or_else(|| RunError {
        message: format!(
            "no advertised FDM runtime matches device={} precision={}",
            requested_device, requested_precision
        ),
    })?;

    let engine = match resolved.device.as_str() {
        "gpu" => FdmEngine::CudaFdm,
        _ => FdmEngine::CpuReference,
    };
    let fallback = resolved.fallback;

    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fdm(engine),
        fallback,
        runtime_family: Some(resolved.runtime_family),
        worker: Some(resolved.worker),
        resolved_backend: "fdm".to_string(),
        resolved_device: resolved.device,
        resolved_precision: requested_precision,
    })
}

pub(crate) fn resolve_fem_engine_with_registry(
    problem: &ProblemIR,
    registry: &RuntimeRegistry,
    explicit_selection: bool,
    plan: Option<&FemPlanIR>,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let requested_device = requested_registry_device_for_fem(problem);
    let requested_precision = runtime_precision(problem).to_string();
    let resolved = resolve_registry_runtime_for_backend(
        registry,
        "fem",
        &requested_device,
        &requested_precision,
    )
    .ok_or_else(|| RunError {
        message: format!(
            "no advertised FEM runtime matches device={} precision={}",
            requested_device, requested_precision
        ),
    })?;

    let engine = match resolved.device.as_str() {
        "gpu" => FemEngine::NativeGpu,
        _ => FemEngine::CpuNative,
    };
    let mut fallback = resolved.fallback;

    if engine == FemEngine::NativeGpu {
        if has_antenna_field_source(problem) {
            if explicit_selection {
                return Err(RunError {
                    message:
                        "FEM GPU execution was requested, but native FEM GPU currently does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)"
                            .to_string(),
                });
            }
            let cpu_resolved =
                resolve_registry_runtime_for_backend(registry, "fem", "cpu", &requested_precision)
                    .ok_or_else(|| {
                        RunError {
                message: "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                    .to_string(),
            }
                    })?;
            let message = "FEM engine falling back to MFEM/libCEED/hypre CPU FEM — native FEM GPU does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)".to_string();
            fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "current_modules_force_cpu",
                message,
            ));
            return Ok(DispatchEngineResolution {
                engine: DispatchEngine::Fem(FemEngine::CpuNative),
                fallback,
                runtime_family: Some(cpu_resolved.runtime_family),
                worker: Some(cpu_resolved.worker),
                resolved_backend: "fem".to_string(),
                resolved_device: "cpu".to_string(),
                resolved_precision: requested_precision,
            });
        }

        let fe_order = runtime_fem_order(problem);
        if fe_order != 1 {
            if explicit_selection {
                return Err(RunError {
                    message: format!(
                        "native FEM GPU execution was requested, but the current native backend supports fe_order=1 only (requested order={}, fallback_reason=fem_gpu_fe_order_unsupported)",
                        fe_order
                    ),
                });
            }
            let cpu_resolved =
                resolve_registry_runtime_for_backend(registry, "fem", "cpu", &requested_precision)
                    .ok_or_else(|| {
                        RunError {
                message: "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                    .to_string(),
            }
                    })?;
            let message = format!(
                "native FEM GPU backend currently supports fe_order=1 only; falling back to MFEM/libCEED/hypre CPU FEM for requested fe_order={} (fallback_reason=fem_gpu_fe_order_unsupported)",
                fe_order
            );
            fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "fem_gpu_fe_order_unsupported",
                message,
            ));
            return Ok(DispatchEngineResolution {
                engine: DispatchEngine::Fem(FemEngine::CpuNative),
                fallback,
                runtime_family: Some(cpu_resolved.runtime_family),
                worker: Some(cpu_resolved.worker),
                resolved_backend: "fem".to_string(),
                resolved_device: "cpu".to_string(),
                resolved_precision: requested_precision,
            });
        }

        if let Some(fem_plan) = plan {
            if let Some(min_nodes) = should_fallback_to_cpu_for_small_fem_gpu(fem_plan) {
                if explicit_selection {
                    return Err(RunError {
                        message: format!(
                            "native FEM GPU execution was requested, but plan has {} nodes below FULLMAG_FEM_GPU_MIN_NODES={} (fallback_reason=fem_gpu_small_mesh_policy)",
                            fem_plan.mesh.nodes.len(),
                            min_nodes
                        ),
                    });
                }
                let cpu_resolved = resolve_registry_runtime_for_backend(
                    registry,
                    "fem",
                    "cpu",
                    &requested_precision,
                )
                .ok_or_else(|| RunError {
                    message:
                        "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                            .to_string(),
                })?;
                let message = format!(
                    "FEM plan has {} nodes, below FULLMAG_FEM_GPU_MIN_NODES={} — falling back to MFEM/libCEED/hypre CPU FEM engine",
                    fem_plan.mesh.nodes.len(),
                    min_nodes
                );
                fallback = Some(runtime_fallback(
                    fem_engine_id(FemEngine::NativeGpu),
                    fem_engine_id(FemEngine::CpuNative),
                    "fem_gpu_small_mesh_policy",
                    message,
                ));
                return Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(FemEngine::CpuNative),
                    fallback,
                    runtime_family: Some(cpu_resolved.runtime_family),
                    worker: Some(cpu_resolved.worker),
                    resolved_backend: "fem".to_string(),
                    resolved_device: "cpu".to_string(),
                    resolved_precision: requested_precision,
                });
            }
        }
    }

    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fem(engine),
        fallback,
        runtime_family: Some(resolved.runtime_family),
        worker: Some(resolved.worker),
        resolved_backend: "fem".to_string(),
        resolved_device: resolved.device,
        resolved_precision: requested_precision,
    })
}

pub(crate) fn resolve_with_registry(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
    explicit_selection: bool,
) -> Result<DispatchEngineResolution, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match registry {
        Some(registry) => match &plan.backend_plan {
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => {
                resolve_fdm_engine_with_registry(problem, registry, explicit_selection)
            }
            BackendPlanIR::Fem(fem) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, Some(fem))
            }
            BackendPlanIR::FemEigen(_) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, None)
            }
        },
        None => match &plan.backend_plan {
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => {
                let resolution = resolve_fdm_engine_with_trail(problem)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fdm(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fdm".to_string(),
                    resolved_device: match resolution.engine {
                        FdmEngine::CudaFdm => "gpu".to_string(),
                        FdmEngine::CpuReference => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                })
            }
            BackendPlanIR::Fem(fem) => {
                let resolution = resolve_fem_engine_for_plan_with_trail(problem, fem)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fem".to_string(),
                    resolved_device: match resolution.engine {
                        FemEngine::NativeGpu => "gpu".to_string(),
                        FemEngine::CpuNative => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                })
            }
            BackendPlanIR::FemEigen(_) => {
                let resolution = resolve_fem_engine_with_trail(problem)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fem".to_string(),
                    resolved_device: match resolution.engine {
                        FemEngine::NativeGpu => "gpu".to_string(),
                        FemEngine::CpuNative => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                })
            }
        },
    }
}
