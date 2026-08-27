//! Runtime selection helpers for user/env policy, registry lookup, and device hints.

use fullmag_ir::{ExecutionDevice, FdmPlanIR, FemPlanIR, ProblemIR};
use serde_json::Value;

use crate::fdm::gpu::cuda::native as native_fdm;
use crate::runtime_registry::RuntimeRegistry;
use crate::solver_runtime::diagnostics::{runtime_fallback, runtime_warn_once};
use crate::solver_runtime::engine::{fdm_engine_id, EngineResolution, FdmEngine};
use crate::types::{ExecutionRequestProvenance, ResolvedFallback, RunError};

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

pub(crate) fn runtime_device_override(problem: &ProblemIR) -> Option<&str> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_device_override")
        .and_then(Value::as_object)
        .filter(|value| value.get("source").and_then(Value::as_str) == Some("managed_launcher"))
        .and_then(|value| value.get("device"))
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

pub(crate) fn fdm_execution_request_provenance(problem: &ProblemIR) -> ExecutionRequestProvenance {
    ExecutionRequestProvenance {
        backend: problem
            .backend_policy
            .requested_backend
            .as_str()
            .to_string(),
        device: requested_registry_device_for_fdm(problem),
        precision: runtime_precision(problem).to_string(),
        mode: match problem.validation_profile.execution_mode {
            fullmag_ir::ExecutionMode::Strict => "strict",
            fullmag_ir::ExecutionMode::Extended => "extended",
            fullmag_ir::ExecutionMode::Hybrid => "hybrid",
        }
        .to_string(),
    }
}

pub(super) fn public_fdm_gpu_charge_device_request_from_sources(
    script_device: Option<&str>,
    execution_env: Option<&str>,
) -> String {
    match execution_env {
        Some("gpu") | Some("cuda") => "gpu".to_string(),
        Some(other) => other.to_string(),
        None => script_device.unwrap_or("auto").replace("cuda", "gpu"),
    }
}

pub(crate) fn public_fdm_gpu_charge_device_request(problem: &ProblemIR) -> String {
    let execution_env = std::env::var("FULLMAG_FDM_EXECUTION").ok();
    public_fdm_gpu_charge_device_request_from_sources(
        runtime_device(problem),
        execution_env.as_deref(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FemSelectionEnvSnapshot {
    execution: Option<String>,
    all_in_gpu: Option<String>,
}

impl FemSelectionEnvSnapshot {
    fn capture() -> Self {
        Self {
            execution: std::env::var("FULLMAG_FEM_EXECUTION").ok(),
            all_in_gpu: std::env::var("FULLMAG_FEM_ALL_IN_GPU").ok(),
        }
    }

    fn from_sources(execution: Option<&str>, all_in_gpu: Option<&str>) -> Self {
        Self {
            execution: execution.map(str::to_string),
            all_in_gpu: all_in_gpu.map(str::to_string),
        }
    }

    fn all_in_gpu_requested(&self) -> bool {
        matches!(self.execution.as_deref(), Some("all_in_gpu"))
            || env_flag_enabled(self.all_in_gpu.as_deref())
    }
}

pub(crate) fn effective_fem_device_request(problem: &ProblemIR) -> String {
    let snapshot = FemSelectionEnvSnapshot::capture();
    effective_fem_device_request_from_snapshot(
        runtime_device(problem),
        runtime_device_override(problem),
        &snapshot,
    )
}

pub(crate) fn effective_fem_device_request_from_metadata(problem: &ProblemIR) -> String {
    effective_fem_device_request_from_sources(
        runtime_device(problem),
        runtime_device_override(problem),
        None,
        false,
    )
}

pub(crate) fn effective_fem_device_request_for_plan(
    problem: &ProblemIR,
    plan: &FemPlanIR,
) -> String {
    plan.mesh_build_report
        .as_ref()
        .and_then(|report| report.mixed_topology_provenance.as_ref())
        .map(|provenance| match provenance.requested_device {
            ExecutionDevice::Cpu => "cpu".to_string(),
            ExecutionDevice::Gpu => "gpu".to_string(),
            ExecutionDevice::Auto => "auto".to_string(),
        })
        .unwrap_or_else(|| effective_fem_device_request(problem))
}

fn effective_fem_device_request_from_snapshot(
    script_device: Option<&str>,
    managed_override: Option<&str>,
    snapshot: &FemSelectionEnvSnapshot,
) -> String {
    effective_fem_device_request_from_sources(
        script_device,
        managed_override,
        snapshot.execution.as_deref(),
        snapshot.all_in_gpu_requested(),
    )
}

pub(super) fn effective_fem_device_request_from_sources(
    script_device: Option<&str>,
    managed_override: Option<&str>,
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
        None => managed_override
            .or(script_device)
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

fn normalize_fdm_execution_policy(value: &str) -> Result<&str, RunError> {
    match value {
        "cpu" => Ok("cpu"),
        "gpu" | "cuda" => Ok("cuda"),
        "auto" => Ok("auto"),
        other => Err(RunError {
            message: format!(
                "unsupported FULLMAG_FDM_EXECUTION={other}; expected cpu, gpu, cuda, or auto"
            ),
        }),
    }
}

pub(crate) fn require_public_fdm_gpu_charge_runtime_selection(
    charge_plan_active: bool,
    requested_device: &str,
    resolution: &EngineResolution<FdmEngine>,
) -> Result<(), RunError> {
    if !charge_plan_active {
        return Ok(());
    }
    if requested_device == "gpu"
        && resolution.engine == FdmEngine::CudaFdm
        && resolution.fallback.is_none()
    {
        return Ok(());
    }
    Err(RunError {
        message: format!(
            "fdm_gpu_charge_runtime_scope_rejected: requested_device={requested_device}; resolved_engine={}; required=explicit_gpu+cuda_available+no_cpu_fallback; fallback=none",
            fdm_engine_id(resolution.engine)
        ),
    })
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

fn problem_has_enabled_frozen_spins(problem: &ProblemIR) -> bool {
    problem
        .magnetization_constraints
        .iter()
        .any(|constraint| constraint.frozen_spins().enabled)
}

pub(crate) fn reject_frozen_spins_cuda_execution(problem: &ProblemIR) -> Result<(), RunError> {
    // The native single-grid CUDA lane now validates and consumes the
    // append-only mask/reference ABI. Unsupported multilayer plans are
    // rejected by the canonical FDM planner before reaching this hook.
    let _ = problem;
    Ok(())
}

pub(crate) fn reject_frozen_spins_cuda_plan_execution(plan: &FdmPlanIR) -> Result<(), RunError> {
    // Capability negotiation is performed by NativeFdmBackend::create(),
    // after the compiled native library reports its feature bits. Keeping the
    // generic planner hook permissive avoids a stale source-level rejection.
    let _ = plan;
    Ok(())
}

pub(crate) fn reject_frozen_spins_fem_execution(problem: &ProblemIR) -> Result<(), RunError> {
    if problem_has_enabled_frozen_spins(problem) {
        if runtime_fem_order(problem) > 1 {
            return Err(RunError {
                message: "frozen_spins_fem_fe_order_unsupported: fe_order > 1 is not supported with frozen spins without explicit high-order true-DOF map".to_string(),
            });
        }
        if let fullmag_ir::StudyIR::Relaxation { algorithm, .. } = &problem.study {
            match algorithm {
                fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit => {
                    return Err(RunError {
                        message: format!("frozen_spins_fem_tpi_unqualified: native FEM direct minimizer '{algorithm:?}' does not support frozen spins constraints"),
                    });
                }
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
                | fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped => {}
            }
        }
    }
    Ok(())
}

pub(crate) fn reject_frozen_spins_fem_plan_execution(plan: &FemPlanIR) -> Result<(), RunError> {
    if plan.frozen_spins.is_some() {
        if plan.fe_order > 1 {
            return Err(RunError {
                message: "frozen_spins_fem_fe_order_unsupported: fe_order > 1 is not supported with frozen spins without explicit high-order true-DOF map".to_string(),
            });
        }
    }
    Ok(())
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
    let requested_policy = match std::env::var("FULLMAG_FDM_EXECUTION") {
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
    let policy = normalize_fdm_execution_policy(&requested_policy)?;

    let availability_route = crate::fdm::gpu::cuda::route::resolve_fdm_gpu_availability_route(
        policy,
        native_fdm::is_cuda_available(),
    )?;
    let resolution = match availability_route {
        crate::fdm::gpu::cuda::route::FdmGpuAvailabilityRoute::CpuRequested => EngineResolution {
            engine: FdmEngine::CpuReference,
            fallback: None,
        },
        crate::fdm::gpu::cuda::route::FdmGpuAvailabilityRoute::Cuda => EngineResolution {
            engine: FdmEngine::CudaFdm,
            fallback: None,
        },
        crate::fdm::gpu::cuda::route::FdmGpuAvailabilityRoute::CpuAutoFallback { reason } => {
            EngineResolution {
                engine: FdmEngine::CpuReference,
                fallback: Some(runtime_fallback(
                    fdm_engine_id(FdmEngine::CudaFdm),
                    fdm_engine_id(FdmEngine::CpuReference),
                    reason,
                    "preferred CUDA FDM runtime is unavailable; using CPU reference engine"
                        .to_string(),
                )),
            }
        }
    };

    if resolution.engine == FdmEngine::CudaFdm {
        reject_frozen_spins_cuda_execution(problem)?;
    }

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

pub(crate) fn resolve_fdm_engine_for_plan_with_trail(
    problem: &ProblemIR,
    plan: &FdmPlanIR,
) -> Result<EngineResolution<FdmEngine>, RunError> {
    let requested_device = public_fdm_gpu_charge_device_request(problem);
    let resolution = resolve_fdm_engine_with_trail(problem)?;
    if resolution.engine == FdmEngine::CudaFdm {
        reject_frozen_spins_cuda_plan_execution(plan)?;
    }
    require_public_fdm_gpu_charge_runtime_selection(
        !plan.fdm_gpu_charge_transports.is_empty(),
        &requested_device,
        &resolution,
    )?;
    Ok(resolution)
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
    let snapshot = FemSelectionEnvSnapshot::capture();
    matches!(
        snapshot.execution.as_deref(),
        Some("gpu") | Some("all_in_gpu")
    )
}

fn env_flag_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "on" | "yes")
    )
}

pub(crate) fn all_in_gpu_fem_env_requested() -> bool {
    FemSelectionEnvSnapshot::capture().all_in_gpu_requested()
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
    use super::{
        effective_fem_device_request_from_snapshot, effective_fem_device_request_from_sources,
        normalize_fdm_execution_policy, public_fdm_gpu_charge_device_request_from_sources,
        require_public_fdm_gpu_charge_runtime_selection, resolve_fdm_engine_with_trail,
        FemSelectionEnvSnapshot,
    };
    use crate::solver_runtime::engine::{EngineResolution, FdmEngine};
    use fullmag_ir::{
        ConstraintActivationIR, EmptySelectionPolicyIR, FrozenReferencePolicyIR, FrozenSpinsIR,
        InactiveSelectionPolicyIR, MagnetizationConstraintIR, ProblemIR, SelectionExprIR,
        SelectionMembershipPolicyIR, FROZEN_SPINS_SCHEMA_VERSION,
    };
    use serde_json::Value;
    use std::sync::{LazyLock, Mutex};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn fdm_execution_policy_normalizes_gpu_alias_and_rejects_unknown_values() {
        assert_eq!(normalize_fdm_execution_policy("gpu").unwrap(), "cuda");
        assert_eq!(normalize_fdm_execution_policy("cuda").unwrap(), "cuda");
        assert_eq!(normalize_fdm_execution_policy("cpu").unwrap(), "cpu");
        assert_eq!(normalize_fdm_execution_policy("auto").unwrap(), "auto");
        assert!(normalize_fdm_execution_policy("unexpected").is_err());
    }

    #[test]
    fn public_gpu_charge_preserves_explicit_auto_and_unknown_environment_requests() {
        assert_eq!(
            public_fdm_gpu_charge_device_request_from_sources(Some("gpu"), None),
            "gpu"
        );
        assert_eq!(
            public_fdm_gpu_charge_device_request_from_sources(Some("cuda"), None),
            "gpu"
        );
        assert_eq!(
            public_fdm_gpu_charge_device_request_from_sources(Some("gpu"), Some("auto")),
            "auto"
        );
        assert_eq!(
            public_fdm_gpu_charge_device_request_from_sources(Some("gpu"), Some("unexpected")),
            "unexpected"
        );
        assert_eq!(
            public_fdm_gpu_charge_device_request_from_sources(Some("auto"), Some("cuda")),
            "gpu"
        );
    }

    #[test]
    fn public_gpu_charge_rejects_every_non_gpu_runtime_request() {
        let resolved_cuda = EngineResolution {
            engine: FdmEngine::CudaFdm,
            fallback: None,
        };
        for requested in ["cpu", "auto", "unexpected"] {
            let error =
                require_public_fdm_gpu_charge_runtime_selection(true, requested, &resolved_cuda)
                    .expect_err("public GPU charge must require an explicit GPU request");
            assert!(
                error
                    .message
                    .contains("fdm_gpu_charge_runtime_scope_rejected")
                    && error
                        .message
                        .contains(&format!("requested_device={requested}"))
                    && error.message.contains("fallback=none"),
                "{}",
                error.message
            );
        }
    }

    #[test]
    fn public_gpu_charge_rejects_unavailable_cuda_without_cpu_fallback() {
        let resolved_cpu = EngineResolution {
            engine: FdmEngine::CpuReference,
            fallback: None,
        };
        let error = require_public_fdm_gpu_charge_runtime_selection(true, "gpu", &resolved_cpu)
            .expect_err("public GPU charge must fail when CUDA is unavailable");
        assert!(
            error
                .message
                .contains("fdm_gpu_charge_runtime_scope_rejected")
                && error.message.contains("resolved_engine=fdm_cpu_reference")
                && error.message.contains("fallback=none"),
            "{}",
            error.message
        );
    }

    #[test]
    fn public_gpu_charge_accepts_only_explicit_cuda_without_fallback() {
        let resolved_cuda = EngineResolution {
            engine: FdmEngine::CudaFdm,
            fallback: None,
        };
        require_public_fdm_gpu_charge_runtime_selection(true, "gpu", &resolved_cuda)
            .expect("explicit GPU plus CUDA must pass");
        require_public_fdm_gpu_charge_runtime_selection(false, "auto", &resolved_cuda)
            .expect("legacy FDM plans retain their current selection policy");

        let cuda_with_fallback = EngineResolution {
            engine: FdmEngine::CudaFdm,
            fallback: Some(crate::solver_runtime::diagnostics::runtime_fallback(
                "fdm_cuda",
                "fdm_cpu_reference",
                "test_fallback",
                "test fallback".into(),
            )),
        };
        let error =
            require_public_fdm_gpu_charge_runtime_selection(true, "gpu", &cuda_with_fallback)
                .expect_err("public GPU charge must reject every fallback trail");
        assert!(error.message.contains("fallback=none"));
    }

    #[test]
    fn fem_effective_request_collision_matrix_is_deterministic() {
        for script in ["cpu", "auto", "gpu"] {
            assert_eq!(
                effective_fem_device_request_from_sources(Some(script), None, None, false),
                script
            );
            for execution_env in ["cpu", "auto", "gpu"] {
                assert_eq!(
                    effective_fem_device_request_from_sources(
                        Some(script),
                        None,
                        Some(execution_env),
                        false,
                    ),
                    execution_env,
                    "FULLMAG_FEM_EXECUTION must override script device"
                );
                assert_eq!(
                    effective_fem_device_request_from_sources(
                        Some(script),
                        None,
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
    fn fem_effective_request_is_derived_from_one_immutable_environment_snapshot() {
        let snapshot = FemSelectionEnvSnapshot::from_sources(Some("cpu"), Some("true"));
        assert_eq!(
            effective_fem_device_request_from_snapshot(Some("auto"), Some("cpu"), &snapshot),
            "gpu"
        );
        assert_eq!(snapshot.execution.as_deref(), Some("cpu"));
        assert_eq!(snapshot.all_in_gpu.as_deref(), Some("true"));
    }

    #[test]
    fn managed_override_is_separate_from_script_and_below_live_environment_priority() {
        assert_eq!(
            effective_fem_device_request_from_sources(Some("auto"), Some("cpu"), None, false,),
            "cpu",
        );
        assert_eq!(
            effective_fem_device_request_from_sources(
                Some("auto"),
                Some("cpu"),
                Some("gpu"),
                false,
            ),
            "gpu",
        );
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

    #[test]
    fn frozen_spins_cuda_guard_allows_authored_problem_constraints_until_native_capability_check() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .magnetization_constraints
            .push(MagnetizationConstraintIR::FrozenSpins(FrozenSpinsIR {
                schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
                id: "pin-strip".to_string(),
                name: "Pinned strip".to_string(),
                enabled: true,
                selector: SelectionExprIR::AllMagnetic {},
                reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
                membership: SelectionMembershipPolicyIR::Static {},
                activation: ConstraintActivationIR::AllStages {},
                empty_selection: EmptySelectionPolicyIR::Error,
                inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
            }));

        super::reject_frozen_spins_cuda_execution(&problem)
            .expect("native CUDA capability negotiation owns the final gate");
    }

    #[test]
    fn frozen_spins_fem_guard_rejects_unsupported_fe_order() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fem: Some(fullmag_ir::FemHintsIR {
                order: 2,
                hmax: 1.0,
                mesh: None,
                demag_solver_policy: None,
            }),
            fdm: None,
            hybrid: None,
        });
        problem
            .magnetization_constraints
            .push(MagnetizationConstraintIR::FrozenSpins(FrozenSpinsIR {
                schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
                id: "pin-strip".to_string(),
                name: "Pinned strip".to_string(),
                enabled: true,
                selector: SelectionExprIR::AllMagnetic {},
                reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
                membership: SelectionMembershipPolicyIR::Static {},
                activation: ConstraintActivationIR::AllStages {},
                empty_selection: EmptySelectionPolicyIR::Error,
                inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
            }));

        let error = super::reject_frozen_spins_fem_execution(&problem)
            .expect_err("high-order FEM must reject frozen spins without explicit true-DOF map");
        assert!(error
            .message
            .starts_with("frozen_spins_fem_fe_order_unsupported:"));

        problem
            .backend_policy
            .discretization_hints
            .as_mut()
            .unwrap()
            .fem
            .as_mut()
            .unwrap()
            .order = 1;
        assert!(
            super::reject_frozen_spins_fem_execution(&problem).is_ok(),
            "P1 FEM must accept frozen spins on qualified lanes"
        );
    }
}
