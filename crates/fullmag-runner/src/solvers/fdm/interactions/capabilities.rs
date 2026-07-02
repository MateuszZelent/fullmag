//! FDM interaction capability rejection rules.

use fullmag_ir::{FdmPlanIR, OutputIR};

pub(crate) fn unsupported_cpu_fdm_terms(
    plan: &FdmPlanIR,
    outputs: &[OutputIR],
) -> Vec<&'static str> {
    let mut unsupported = Vec::new();
    if plan.has_oersted_cylinder {
        unsupported.push("oersted");
    }
    if plan.boundary_geometry.is_some() || plan.boundary_correction.is_some() {
        unsupported.push("boundary_correction");
    }
    // Fields available in CPU FDM snapshots: m, H_ex, H_demag, H_ext, H_ani, H_dmi, H_eff.
    // H_ant is not exposed as a separate observable by the reference engine.
    if outputs.iter().any(|output| match output {
        OutputIR::Field { name, .. } | OutputIR::Scalar { name, .. } => {
            matches!(
                name.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "E_mel" | "E_el" | "E_kin_el"
            )
        }
        OutputIR::Snapshot { field, .. } => {
            matches!(
                field.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "H_ant"
            )
        }
        _ => false,
    }) {
        unsupported.push("unsupported_outputs");
    }
    unsupported.sort_unstable();
    unsupported.dedup();
    unsupported
}
