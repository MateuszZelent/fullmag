//! Compatibility facade for the mechanically split FEM eigen runner workflow.

#![allow(unused_imports)]

pub(crate) use crate::fem::eigen_capability::{
    insert_native_cpu_modal_window_rejection_contract, native_cpu_modal_window_rejection_reason,
    native_cpu_modal_window_rejection_scope,
};
pub(crate) use crate::fem::eigen_certificate::{
    OwnedModalCertificateV6Binding, OwnedModalCertificateV6ClassDigest,
    OwnedModalCertificateV6RegionRole, OwnedModalCertificateV6Relation,
    OwnedModalCertificateV6View,
};
pub(crate) use crate::fem::eigen_constants::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON;
pub use crate::fem::eigen_equilibrium_contract::AcceptedFemRelaxStageHandoff;
pub(crate) use crate::fem::eigen_equilibrium_contract::{
    accepted_relax_to_eigen_handoff_from_run, AcceptedFemEigenEquilibriumHandoff,
};
pub(crate) use crate::fem::eigen_execution::{
    execute_baseline_fem_eigen, execute_baseline_fem_eigen_with_progress, execute_cpu_fem_eigen,
    execute_cpu_fem_eigen_with_handoff, execute_cpu_fem_eigen_with_progress,
    execute_cpu_fem_eigen_with_progress_and_stage_handoff, execute_gpu_fem_eigen,
    execute_gpu_fem_eigen_with_handoff, execute_gpu_fem_eigen_with_progress_and_stage_handoff,
    execute_planned_fem_eigen, execute_planned_fem_eigen_with_handoff,
    execute_planned_fem_eigen_with_progress,
    execute_planned_fem_eigen_with_progress_and_stage_handoff,
    reject_unsupported_floquet_dynamic_demag,
};
pub(crate) use crate::fem::eigen_execution_resolution::{
    resolve_fem_eigen_execution_resolution, resolve_planned_fem_eigen_execution,
    validate_bias_field_sample_execution_resolutions, FemEigenExecutionLane,
    PlannedFemEigenExecution,
};
pub(crate) use crate::fem::eigen_native_result::{
    native_poisson_airbox_k0_metrics_from_result_json, NativePoissonAirboxK0MetricsInput,
};
pub(crate) use crate::fem::eigen_output::modal_tangent_transport_diagnostics;
pub(crate) use crate::fem::eigen_progress::{FemEigenProgress, FemEigenProgressCallback};
pub(crate) use crate::fem::eigen_shared_domain::native_shared_domain_magnetic_assembly_available;

pub fn validate_recomputed_fem_linearization_certificate(
    plan: &fullmag_ir::FemPlanIR,
    source_mesh: &crate::types::FemMeshPayload,
    equilibrium_magnetization: &[[f64; 3]],
    certified_fields: &crate::types::CertifiedFemEquilibriumFields,
    certificate: &crate::types::RecomputedFemLinearizationCertificateV1,
) -> Result<(), crate::types::RunError> {
    let reject = |reason: &str| crate::types::RunError {
        message: format!("recomputed_linearization_certificate_invalid: {reason}"),
    };
    if certificate.schema_version != "RecomputedFemLinearizationCertificate.v1"
        || certificate.status != "matched"
        || certificate.recompute_provider != "native_fem_final_state_refresh.v1"
    {
        return Err(reject("schema, status, or provider mismatch"));
    }
    if certificate.node_count != source_mesh.nodes.len()
        || certificate.node_count != equilibrium_magnetization.len()
    {
        return Err(reject("node count mismatch"));
    }
    if certificate.content_sha256
        != crate::types::recomputed_fem_linearization_certificate_sha256(certificate)?
    {
        return Err(reject("content digest mismatch"));
    }
    if certificate.equilibrium_content_sha256
        != crate::types::recomputed_fem_equilibrium_content_sha256(equilibrium_magnetization)
    {
        return Err(reject("equilibrium digest mismatch"));
    }
    if certificate.mesh_topology_sha256 != crate::types::fem_mesh_topology_fingerprint(source_mesh)
    {
        return Err(reject("mesh topology digest mismatch"));
    }
    if certificate.recomputed_fields_content_sha256 != certified_fields.content_sha256
        || crate::types::certified_equilibrium_fields_sha256(certified_fields)
            != certified_fields.content_sha256
    {
        return Err(reject("recomputed field digest mismatch"));
    }
    let identity =
        crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(plan)?;
    if certificate.equilibrium_material_signature != identity.equilibrium_material_signature
        || certificate.equilibrium_static_physics_signature
            != identity.equilibrium_static_physics_signature
        || certificate.equilibrium_boundary_signature != identity.equilibrium_boundary_signature
    {
        return Err(reject("material, physics, or boundary signature mismatch"));
    }
    if certificate.accepted_fields_content_sha256.trim().is_empty()
        || certificate
            .accepted_fields_content_sha256
            .strip_prefix("sha256:")
            .is_none_or(|digest| digest.len() != 64)
        || [
            certificate.max_h_ex_difference_a_per_m,
            certificate.max_h_demag_difference_a_per_m,
            certificate.max_h_ext_difference_a_per_m,
            certificate.max_h_eff_difference_a_per_m,
            certificate.max_phi_difference_a,
            certificate.field_absolute_tolerance_a_per_m,
            certificate.field_relative_tolerance,
            certificate.phi_absolute_tolerance_a,
        ]
        .into_iter()
        .any(|value| !value.is_finite() || value < 0.0)
    {
        return Err(reject("comparison evidence is incomplete or non-finite"));
    }
    Ok(())
}

pub fn fem_relax_equilibrium_identity_signatures(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<[String; 3], crate::types::RunError> {
    let identity =
        crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(plan)?;
    Ok([
        identity.equilibrium_material_signature,
        identity.equilibrium_static_physics_signature,
        identity.equilibrium_boundary_signature,
    ])
}
