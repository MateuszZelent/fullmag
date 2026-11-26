//! Relaxation provenance mapping.

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
use crate::types::FemDirectMinimizerPolicyProvenance;
use crate::types::{ExecutionProvenance, FdmCpuStateLayoutProvenance};

#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
const DIRECTION_POLICY_ENV: &str = "FULLMAG_FEM_DIRECT_MINIMIZER_DIRECTION_POLICY";
#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
const LINEAR_SOLVER_ENV: &str = "FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER";
#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
const PRECONDITIONER_ENV: &str = "FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER";

fn direct_energy_minimizer_name(algorithm: RelaxationAlgorithmIR) -> Option<&'static str> {
    match algorithm {
        RelaxationAlgorithmIR::ProjectedGradientBb => Some("projected_gradient_bb"),
        RelaxationAlgorithmIR::NonlinearCg => Some("nonlinear_cg"),
        RelaxationAlgorithmIR::TangentPlaneImplicit => Some("tangent_plane_implicit"),
        RelaxationAlgorithmIR::LlgOverdamped => None,
    }
}

pub(crate) const CPU_SOA_DIRECT_MINIMIZER_REALIZATION: &str = "cpu_soa_tangent_gradient";
/// AoS BB/NCG kernels used when the problem rejects the SoA fast path
/// (Frozen Spins, spatial Ms/A/alpha).
pub(crate) const CPU_AOS_DIRECT_MINIMIZER_REALIZATION: &str = "cpu_aos_tangent_gradient";
/// Host-orchestrated CUDA FDM direct-minimizer realization (nonlinear-CG):
/// the optimizer state, tangent gradient, and Armijo line search run on the
/// host over device field and energy evaluation
/// (`fdm/gpu/cuda/direct_minimizer.rs`).
pub(crate) const CUDA_FDM_HOST_DIRECT_MINIMIZER_REALIZATION: &str =
    "cuda_fdm_host_tangent_gradient";
pub(crate) const NATIVE_LLG_TIME_INTEGRATOR_REALIZATION: &str = "native_llg_time_integrator";
/// Layout rejection recorded by the CPU runner for coupled spin transport.
/// It forces the AoS state but leaves the direct-minimizer kernels on SoA.
const COUPLED_SPIN_TRANSPORT_LAYOUT_REJECTION: &str = "coupled_spin_transport";

/// CPU FDM direct-minimizer realization; `soa_supported` must be the
/// `ExchangeLlgProblem::soa_fast_path_supported` value that also selects the
/// BB/NCG kernels.
pub(crate) fn cpu_direct_minimizer_realization(soa_supported: bool) -> &'static str {
    if soa_supported {
        CPU_SOA_DIRECT_MINIMIZER_REALIZATION
    } else {
        CPU_AOS_DIRECT_MINIMIZER_REALIZATION
    }
}

/// Expected CPU FDM direct-minimizer realization derived from the recorded
/// state layout: a problem-level SoA rejection selects the AoS kernels.
pub(crate) fn expected_cpu_direct_minimizer_realization(
    layout: Option<&FdmCpuStateLayoutProvenance>,
) -> &'static str {
    let problem_rejected_soa = layout
        .and_then(|layout| layout.rejection_reason.as_deref())
        .is_some_and(|reason| reason != COUPLED_SPIN_TRANSPORT_LAYOUT_REJECTION);
    cpu_direct_minimizer_realization(!problem_rejected_soa)
}

/// Expected CUDA single-grid FDM direct-minimizer realization.
///
/// Single-layer `ProjectedGradientBb` executes fully device-resident via
/// `single_layer_bb.cu` (`native_cuda_pgbb`, matching device-resident
/// multilayer CUDA PG-BB and the relaxation qualification contract), while
/// `NonlinearCg` remains host-orchestrated (`cuda_fdm_host_tangent_gradient`).
pub(crate) fn cuda_fdm_direct_minimizer_realization(
    algorithm: RelaxationAlgorithmIR,
) -> Option<&'static str> {
    match algorithm {
        RelaxationAlgorithmIR::ProjectedGradientBb => {
            native_direct_minimizer_realization(algorithm, true)
        }
        RelaxationAlgorithmIR::NonlinearCg => Some(CUDA_FDM_HOST_DIRECT_MINIMIZER_REALIZATION),
        RelaxationAlgorithmIR::TangentPlaneImplicit | RelaxationAlgorithmIR::LlgOverdamped => None,
    }
}

pub(crate) fn native_direct_minimizer_realization(
    algorithm: RelaxationAlgorithmIR,
    gpu: bool,
) -> Option<&'static str> {
    match (algorithm, gpu) {
        (RelaxationAlgorithmIR::ProjectedGradientBb, false) => Some("native_mfem_pgbb"),
        (RelaxationAlgorithmIR::ProjectedGradientBb, true) => Some("native_cuda_pgbb"),
        (RelaxationAlgorithmIR::NonlinearCg, false) => Some("native_mfem_nonlinear_cg"),
        (RelaxationAlgorithmIR::NonlinearCg, true) => Some("native_cuda_nonlinear_cg"),
        (RelaxationAlgorithmIR::TangentPlaneImplicit, false) => Some("native_mfem_tpi"),
        _ => None,
    }
}

pub(crate) fn apply_energy_minimizer_provenance(
    provenance: &mut ExecutionProvenance,
    relaxation: Option<&RelaxationControlIR>,
) {
    let Some(name) = relaxation
        .and_then(|control| direct_energy_minimizer_name(control.algorithm))
        .map(str::to_string)
    else {
        return;
    };

    provenance.requested_energy_minimizer = Some(name.clone());
    provenance.resolved_energy_minimizer = Some(name);
    provenance.energy_minimizer_realization = None;
    provenance.resolved_integrator = None;
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
fn resolve_fem_direct_minimizer_policy(
    gpu: bool,
    direction_override: Option<&str>,
    linear_solver_override: Option<&str>,
    preconditioner_override: Option<&str>,
    gpu_bb: bool,
    gpu_bb_policy: Option<fullmag_ir::FemGpuBbPreconditionerIR>,
) -> FemDirectMinimizerPolicyProvenance {
    if gpu {
        if !gpu_bb {
            return FemDirectMinimizerPolicyProvenance {
                direction_policy_source: None,
                requested_direction_policy: "device_tangent_gradient".to_string(),
                resolved_direction_policy: "device_tangent_gradient".to_string(),
                direction_fallback_reason: None,
                requested_linear_solver: "not_used".to_string(),
                resolved_linear_solver: "not_used".to_string(),
                requested_preconditioner: "not_used".to_string(),
                resolved_preconditioner: "not_used".to_string(),
                environment_overrides: Vec::new(),
            };
        }
        let effective_policy =
            gpu_bb_policy.unwrap_or(fullmag_ir::FemGpuBbPreconditionerIR::Auto);
        let preconditioned = matches!(
            effective_policy,
            fullmag_ir::FemGpuBbPreconditionerIR::Auto
                | fullmag_ir::FemGpuBbPreconditionerIR::ExchangeMass
        );
        return FemDirectMinimizerPolicyProvenance {
            direction_policy_source: gpu_bb_policy
                .map(|_| "discretization_hints.fem.gpu_bb_preconditioner".to_string()),
            requested_direction_policy: effective_policy.as_str().to_string(),
            resolved_direction_policy: if preconditioned {
                "device_exchange_mass_preconditioned"
            } else {
                "device_tangent_gradient"
            }
            .to_string(),
            direction_fallback_reason: if effective_policy
                == fullmag_ir::FemGpuBbPreconditionerIR::None
            {
                Some("policy_none".to_string())
            } else {
                None
            },
            requested_linear_solver: if preconditioned {
                "cooperative_device_pcg"
            } else {
                "not_used"
            }
            .to_string(),
            resolved_linear_solver: if preconditioned {
                "cooperative_device_pcg"
            } else {
                "not_used"
            }
            .to_string(),
            requested_preconditioner: if preconditioned {
                "device_jacobi"
            } else {
                "not_used"
            }
            .to_string(),
            resolved_preconditioner: if preconditioned {
                "device_jacobi"
            } else {
                "not_used"
            }
            .to_string(),
            environment_overrides: Vec::new(),
        };
    }

    let requested_direction = direction_override.unwrap_or("exchange_mass_preconditioned");
    let raw_direction = matches!(
        direction_override,
        Some("raw_tangent_gradient" | "device_tangent_gradient" | "none")
    );
    let resolved_direction = if raw_direction {
        "raw_tangent_gradient"
    } else {
        "exchange_mass_preconditioned"
    };
    let requested_solver = linear_solver_override.unwrap_or("mfem_serial");
    let requested_preconditioner = preconditioner_override.unwrap_or("boomer_amg");
    let (resolved_solver, resolved_preconditioner) = if raw_direction {
        ("not_used", "not_used")
    } else if matches!(linear_solver_override, Some("hypre" | "HYPRE")) {
        let preconditioner = match preconditioner_override {
            Some("jacobi" | "JACOBI") => "jacobi",
            Some("none" | "NONE") => "none",
            _ => "boomer_amg",
        };
        ("hypre_pcg", preconditioner)
    } else {
        ("mfem_cg", "gauss_seidel")
    };
    let mut environment_overrides = Vec::new();
    if direction_override.is_some() {
        environment_overrides.push(DIRECTION_POLICY_ENV.to_string());
    }
    if linear_solver_override.is_some() {
        environment_overrides.push(LINEAR_SOLVER_ENV.to_string());
    }
    if preconditioner_override.is_some() {
        environment_overrides.push(PRECONDITIONER_ENV.to_string());
    }

    FemDirectMinimizerPolicyProvenance {
        direction_policy_source: None,
        requested_direction_policy: requested_direction.to_string(),
        resolved_direction_policy: resolved_direction.to_string(),
        direction_fallback_reason: None,
        requested_linear_solver: requested_solver.to_string(),
        resolved_linear_solver: resolved_solver.to_string(),
        requested_preconditioner: requested_preconditioner.to_string(),
        resolved_preconditioner: resolved_preconditioner.to_string(),
        environment_overrides,
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
pub(crate) fn apply_fem_direct_minimizer_policy_provenance(
    provenance: &mut ExecutionProvenance,
    relaxation: Option<&RelaxationControlIR>,
    gpu: bool,
    gpu_bb_policy: Option<fullmag_ir::FemGpuBbPreconditionerIR>,
) {
    if relaxation
        .and_then(|control| direct_energy_minimizer_name(control.algorithm))
        .is_none()
    {
        return;
    }
    provenance.fem_direct_minimizer_policy = Some(resolve_fem_direct_minimizer_policy(
        gpu,
        std::env::var(DIRECTION_POLICY_ENV).ok().as_deref(),
        std::env::var(LINEAR_SOLVER_ENV).ok().as_deref(),
        std::env::var(PRECONDITIONER_ENV).ok().as_deref(),
        relaxation
            .is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::ProjectedGradientBb),
        gpu_bb_policy,
    ));
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
pub(crate) fn apply_native_fem_gpu_bb_preconditioner_runtime_provenance(
    provenance: &mut ExecutionProvenance,
    requested_policy: Option<&str>,
    resolved_enabled: bool,
    solver_kind: &str,
    preconditioner_kind: &str,
    fallback_reason: Option<&str>,
) {
    if provenance.execution_engine != "fem_native_gpu"
        || provenance.resolved_energy_minimizer.as_deref() != Some("projected_gradient_bb")
    {
        return;
    }
    let Some(policy) = provenance.fem_direct_minimizer_policy.as_mut() else {
        return;
    };
    if let Some(requested) = requested_policy {
        policy.requested_direction_policy = requested.to_string();
    }
    policy.resolved_direction_policy = if resolved_enabled {
        "device_exchange_mass_preconditioned"
    } else {
        "device_tangent_gradient"
    }
    .to_string();
    policy.resolved_linear_solver = solver_kind.to_string();
    policy.resolved_preconditioner = preconditioner_kind.to_string();
    policy.direction_fallback_reason = fallback_reason
        .filter(|reason| !reason.is_empty())
        .map(str::to_string);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_fem_realization_is_lane_and_algorithm_specific() {
        assert_eq!(
            native_direct_minimizer_realization(RelaxationAlgorithmIR::ProjectedGradientBb, false),
            Some("native_mfem_pgbb")
        );
        assert_eq!(
            native_direct_minimizer_realization(RelaxationAlgorithmIR::ProjectedGradientBb, true),
            Some("native_cuda_pgbb")
        );
    }

    #[test]
    fn cuda_fdm_realization_distinguishes_resident_pgbb_from_host_ncg() {
        assert_eq!(
            cuda_fdm_direct_minimizer_realization(RelaxationAlgorithmIR::ProjectedGradientBb),
            Some("native_cuda_pgbb")
        );
        assert_eq!(
            cuda_fdm_direct_minimizer_realization(RelaxationAlgorithmIR::NonlinearCg),
            Some(CUDA_FDM_HOST_DIRECT_MINIMIZER_REALIZATION)
        );
        assert_eq!(
            cuda_fdm_direct_minimizer_realization(RelaxationAlgorithmIR::TangentPlaneImplicit),
            None
        );
        assert_eq!(
            cuda_fdm_direct_minimizer_realization(RelaxationAlgorithmIR::LlgOverdamped),
            None
        );
    }

    #[test]
    fn fem_cpu_policy_records_requested_and_resolved_environment_overrides() {
        let policy = resolve_fem_direct_minimizer_policy(
            false,
            Some("raw_tangent_gradient"),
            Some("hypre"),
            Some("jacobi"),
            false,
            None,
        );

        assert_eq!(policy.requested_direction_policy, "raw_tangent_gradient");
        assert_eq!(policy.resolved_direction_policy, "raw_tangent_gradient");
        assert_eq!(policy.requested_linear_solver, "hypre");
        assert_eq!(policy.resolved_linear_solver, "not_used");
        assert_eq!(policy.requested_preconditioner, "jacobi");
        assert_eq!(policy.resolved_preconditioner, "not_used");
        assert_eq!(
            policy.environment_overrides,
            vec![DIRECTION_POLICY_ENV, LINEAR_SOLVER_ENV, PRECONDITIONER_ENV]
        );
    }

    #[test]
    fn fem_cpu_policy_records_actual_default_serial_realization() {
        let policy = resolve_fem_direct_minimizer_policy(false, None, None, None, false, None);

        assert_eq!(
            policy.resolved_direction_policy,
            "exchange_mass_preconditioned"
        );
        assert_eq!(policy.resolved_linear_solver, "mfem_cg");
        assert_eq!(policy.resolved_preconditioner, "gauss_seidel");
        assert!(policy.environment_overrides.is_empty());
    }

    #[test]
    fn fem_gpu_policy_does_not_claim_cpu_environment_controls() {
        let policy = resolve_fem_direct_minimizer_policy(
            true,
            Some("raw_tangent_gradient"),
            Some("hypre"),
            Some("jacobi"),
            false,
            None,
        );

        assert_eq!(policy.resolved_direction_policy, "device_tangent_gradient");
        assert_eq!(policy.resolved_linear_solver, "not_used");
        assert_eq!(policy.resolved_preconditioner, "not_used");
        assert!(policy.environment_overrides.is_empty());
    }

    #[test]
    fn gpu_bb_typed_policy_preserves_request_and_ignores_cpu_environment() {
        use fullmag_ir::FemGpuBbPreconditionerIR as Policy;
        for (requested, enabled, fallback) in [
            (Policy::Auto, true, None),
            (Policy::None, false, Some("policy_none")),
            (Policy::ExchangeMass, true, None),
        ] {
            let policy = resolve_fem_direct_minimizer_policy(
                true,
                Some("raw_tangent_gradient"),
                Some("hypre"),
                Some("none"),
                true,
                Some(requested),
            );
            assert_eq!(policy.requested_direction_policy, requested.as_str());
            assert_eq!(
                policy.resolved_direction_policy,
                if enabled {
                    "device_exchange_mass_preconditioned"
                } else {
                    "device_tangent_gradient"
                }
            );
            assert_eq!(policy.direction_fallback_reason.as_deref(), fallback);
            assert_eq!(
                policy.resolved_linear_solver,
                if enabled {
                    "cooperative_device_pcg"
                } else {
                    "not_used"
                }
            );
            assert_eq!(
                policy.resolved_preconditioner,
                if enabled { "device_jacobi" } else { "not_used" }
            );
            assert_eq!(
                policy.direction_policy_source.as_deref(),
                Some("discretization_hints.fem.gpu_bb_preconditioner")
            );
            assert!(policy.environment_overrides.is_empty());
        }
        let default = resolve_fem_direct_minimizer_policy(true, None, None, None, true, None);
        assert_eq!(default.requested_direction_policy, "auto");
        assert_eq!(
            default.resolved_direction_policy,
            "device_exchange_mass_preconditioned"
        );
        assert_eq!(default.direction_fallback_reason, None);
        assert_eq!(default.resolved_linear_solver, "cooperative_device_pcg");
        assert_eq!(default.resolved_preconditioner, "device_jacobi");
        assert!(default.direction_policy_source.is_none());
        let ncg = resolve_fem_direct_minimizer_policy(true, None, None, None, false, None);
        assert_eq!(ncg.requested_direction_policy, "device_tangent_gradient");
        assert_eq!(ncg.resolved_direction_policy, "device_tangent_gradient");
        assert_eq!(ncg.resolved_linear_solver, "not_used");
        assert_eq!(ncg.direction_fallback_reason, None);
    }

    #[test]
    fn runtime_gpu_bb_attestation_separates_auto_request_from_resolved_execution() {
        let mut provenance = ExecutionProvenance {
            execution_engine: "fem_native_gpu".to_string(),
            resolved_energy_minimizer: Some("projected_gradient_bb".to_string()),
            fem_direct_minimizer_policy: Some(resolve_fem_direct_minimizer_policy(
                true,
                None,
                None,
                None,
                true,
                Some(fullmag_ir::FemGpuBbPreconditionerIR::Auto),
            )),
            ..ExecutionProvenance::default()
        };

        apply_native_fem_gpu_bb_preconditioner_runtime_provenance(
            &mut provenance,
            Some("auto"),
            true,
            "cooperative_device_pcg",
            "device_jacobi",
            None,
        );
        let enabled = provenance
            .fem_direct_minimizer_policy
            .as_ref()
            .expect("policy present");
        assert_eq!(enabled.requested_direction_policy, "auto");
        assert_eq!(
            enabled.resolved_direction_policy,
            "device_exchange_mass_preconditioned"
        );
        assert_eq!(enabled.resolved_linear_solver, "cooperative_device_pcg");
        assert_eq!(enabled.resolved_preconditioner, "device_jacobi");
        assert_eq!(enabled.direction_fallback_reason, None);
        let enabled_json = serde_json::to_value(enabled).expect("serialize enabled policy");
        assert!(enabled_json.get("direction_fallback_reason").is_none());

        apply_native_fem_gpu_bb_preconditioner_runtime_provenance(
            &mut provenance,
            Some("auto"),
            false,
            "not_used",
            "not_used",
            Some("exchange_disabled"),
        );
        let fallback = provenance
            .fem_direct_minimizer_policy
            .as_ref()
            .expect("policy present");
        assert_eq!(fallback.requested_direction_policy, "auto");
        assert_eq!(fallback.resolved_direction_policy, "device_tangent_gradient");
        assert_eq!(fallback.resolved_linear_solver, "not_used");
        assert_eq!(fallback.resolved_preconditioner, "not_used");
        assert_eq!(
            fallback.direction_fallback_reason.as_deref(),
            Some("exchange_disabled")
        );
        let fallback_json = serde_json::to_value(fallback).expect("serialize fallback policy");
        assert_eq!(
            fallback_json["direction_fallback_reason"],
            "exchange_disabled"
        );

        // Non-GPU or non-PGBB provenance must not be overwritten.
        let mut cpu_provenance = ExecutionProvenance {
            execution_engine: "fem_native_cpu".to_string(),
            resolved_energy_minimizer: Some("projected_gradient_bb".to_string()),
            fem_direct_minimizer_policy: Some(resolve_fem_direct_minimizer_policy(
                false, None, None, None, true, None,
            )),
            ..ExecutionProvenance::default()
        };
        let before = cpu_provenance.fem_direct_minimizer_policy.clone();
        apply_native_fem_gpu_bb_preconditioner_runtime_provenance(
            &mut cpu_provenance,
            Some("auto"),
            false,
            "not_used",
            "not_used",
            Some("exchange_disabled"),
        );
        assert_eq!(cpu_provenance.fem_direct_minimizer_policy, before);
    }

    #[test]
    fn cpu_fdm_realization_follows_problem_soa_rejection() {
        let layout = |executed: &str, reason: Option<&str>| FdmCpuStateLayoutProvenance {
            requested: "auto".to_string(),
            resolved: executed.to_string(),
            executed: executed.to_string(),
            rejection_reason: reason.map(str::to_string),
            projection_policy: None,
            projection_realization: None,
        };
        assert_eq!(
            expected_cpu_direct_minimizer_realization(Some(&layout("soa_xyz", None))),
            CPU_SOA_DIRECT_MINIMIZER_REALIZATION
        );
        assert_eq!(
            expected_cpu_direct_minimizer_realization(Some(&layout(
                "aos_xyz",
                Some("frozen_spins")
            ))),
            CPU_AOS_DIRECT_MINIMIZER_REALIZATION
        );
        assert_eq!(
            expected_cpu_direct_minimizer_realization(Some(&layout(
                "aos_xyz",
                Some(COUPLED_SPIN_TRANSPORT_LAYOUT_REJECTION)
            ))),
            CPU_SOA_DIRECT_MINIMIZER_REALIZATION
        );
        assert_eq!(
            cpu_direct_minimizer_realization(false),
            CPU_AOS_DIRECT_MINIMIZER_REALIZATION
        );
    }

    #[test]
    fn fem_direct_minimizer_policy_is_serialized_in_execution_provenance() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fem_direct_minimizer_policy = Some(resolve_fem_direct_minimizer_policy(
            false,
            None,
            Some("hypre"),
            Some("jacobi"),
            false,
            None,
        ));

        let value = serde_json::to_value(provenance).expect("serialize execution provenance");
        let policy = &value["fem_direct_minimizer_policy"];
        assert_eq!(policy["requested_linear_solver"], "hypre");
        assert_eq!(policy["resolved_linear_solver"], "hypre_pcg");
        assert_eq!(policy["resolved_preconditioner"], "jacobi");
        assert_eq!(
            policy["environment_overrides"],
            serde_json::json!([LINEAR_SOLVER_ENV, PRECONDITIONER_ENV])
        );
    }
}
