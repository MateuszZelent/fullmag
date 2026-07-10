//! Relaxation provenance mapping.

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

use crate::types::ExecutionProvenance;

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

pub(crate) fn native_direct_minimizer_realization(algorithm: RelaxationAlgorithmIR, gpu: bool) -> Option<&'static str> {
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
}
