//! Relaxation provenance mapping.

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

use crate::types::ExecutionProvenance;
#[cfg(any(feature = "fem-gpu", test))]
use crate::types::FemDirectMinimizerPolicyProvenance;

#[cfg(any(feature = "fem-gpu", test))]
const DIRECTION_POLICY_ENV: &str = "FULLMAG_FEM_DIRECT_MINIMIZER_DIRECTION_POLICY";
#[cfg(any(feature = "fem-gpu", test))]
const LINEAR_SOLVER_ENV: &str = "FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER";
#[cfg(any(feature = "fem-gpu", test))]
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
pub(crate) const NATIVE_LLG_TIME_INTEGRATOR_REALIZATION: &str = "native_llg_time_integrator";

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

#[cfg(any(feature = "fem-gpu", test))]
fn resolve_fem_direct_minimizer_policy(
    gpu: bool,
    direction_override: Option<&str>,
    linear_solver_override: Option<&str>,
    preconditioner_override: Option<&str>,
) -> FemDirectMinimizerPolicyProvenance {
    if gpu {
        return FemDirectMinimizerPolicyProvenance {
            requested_direction_policy: "device_tangent_gradient".to_string(),
            resolved_direction_policy: "device_tangent_gradient".to_string(),
            requested_linear_solver: "not_used".to_string(),
            resolved_linear_solver: "not_used".to_string(),
            requested_preconditioner: "not_used".to_string(),
            resolved_preconditioner: "not_used".to_string(),
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
        requested_direction_policy: requested_direction.to_string(),
        resolved_direction_policy: resolved_direction.to_string(),
        requested_linear_solver: requested_solver.to_string(),
        resolved_linear_solver: resolved_solver.to_string(),
        requested_preconditioner: requested_preconditioner.to_string(),
        resolved_preconditioner: resolved_preconditioner.to_string(),
        environment_overrides,
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn apply_fem_direct_minimizer_policy_provenance(
    provenance: &mut ExecutionProvenance,
    relaxation: Option<&RelaxationControlIR>,
    gpu: bool,
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
    ));
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
    fn fem_cpu_policy_records_requested_and_resolved_environment_overrides() {
        let policy = resolve_fem_direct_minimizer_policy(
            false,
            Some("raw_tangent_gradient"),
            Some("hypre"),
            Some("jacobi"),
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
        let policy = resolve_fem_direct_minimizer_policy(false, None, None, None);

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
        );

        assert_eq!(policy.resolved_direction_policy, "device_tangent_gradient");
        assert_eq!(policy.resolved_linear_solver, "not_used");
        assert_eq!(policy.resolved_preconditioner, "not_used");
        assert!(policy.environment_overrides.is_empty());
    }

    #[test]
    fn fem_direct_minimizer_policy_is_serialized_in_execution_provenance() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fem_direct_minimizer_policy = Some(resolve_fem_direct_minimizer_policy(
            false,
            None,
            Some("hypre"),
            Some("jacobi"),
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
