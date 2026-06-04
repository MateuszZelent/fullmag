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
#[cfg(any(feature = "fem-gpu", test))]
pub(crate) const NATIVE_MFEM_DIRECT_MINIMIZER_REALIZATION: &str = "native_mfem_backend_relax_step";
pub(crate) const NATIVE_LLG_TIME_INTEGRATOR_REALIZATION: &str = "native_llg_time_integrator";

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
