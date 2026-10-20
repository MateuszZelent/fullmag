//! Shared policy for preserving certified mixed-P1 body markers.

use std::collections::BTreeSet;

use fullmag_ir::FemPlanIR;

/// Return the certified magnetic body markers for a V2 mixed-P1 plan.
///
/// A V2 certificate owns distinct body identities. Runtime normalization must
/// preserve those identities for native certificate packing; the native backend
/// derives its separate binary magnetic mask from the non-zero markers.
/// Legacy V1 plans have no V2 certificate and intentionally keep the historical
/// binary marker normalization.
pub(crate) fn mixed_v2_body_markers(plan: &FemPlanIR) -> Option<BTreeSet<u32>> {
    plan.mesh_build_report
        .as_ref()
        .and_then(|report| report.mixed_layer_topology_certificate_v2.as_ref())
        .map(|certificate| {
            certificate
                .magnetic_regions
                .iter()
                .map(|region| region.body_marker)
                .collect()
        })
}
