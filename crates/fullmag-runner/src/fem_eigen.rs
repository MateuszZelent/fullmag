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
pub use crate::fem::eigen_equilibrium_contract::{
    AcceptedFemRelaxExactArtifacts, AcceptedFemRelaxStageHandoff,
    FemRelaxationProducerBuildIdentity, FemRelaxationProducerPayloadRef,
    FemRelaxationProducerPayloads, FemRelaxationProducerPlanSnapshot,
    FemRelaxationProducerProvenance, FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1,
    FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH, FEM_RELAXATION_PRODUCER_PROVENANCE_V1,
};
pub(crate) use crate::fem::eigen_equilibrium_contract::{
    accepted_relax_to_eigen_handoff_from_run, AcceptedFemEigenEquilibriumHandoff,
    fem_relaxation_producer_provenance_sample_relative_path,
    FemRelaxationProducerStageIdentity,
};
pub(crate) use crate::fem::eigen_execution::{
    execute_baseline_fem_eigen, execute_baseline_fem_eigen_with_progress, execute_cpu_fem_eigen,
    execute_cpu_fem_eigen_with_producer_identity,
    execute_cpu_fem_eigen_with_handoff_and_progress_and_producer_identity,
    execute_cpu_fem_eigen_with_handoff, execute_cpu_fem_eigen_with_handoff_and_progress,
    execute_cpu_fem_eigen_with_progress_and_producer_identity,
    execute_cpu_fem_eigen_with_progress, execute_cpu_fem_eigen_with_progress_and_stage_handoff,
    execute_cpu_fem_eigen_with_progress_and_stage_handoff_and_producer_identity,
    execute_cpu_fem_eigen_with_stage_handoff, execute_gpu_fem_eigen,
    execute_gpu_fem_eigen_with_handoff_and_progress_and_producer_identity,
    execute_gpu_fem_eigen_with_handoff, execute_gpu_fem_eigen_with_progress_and_stage_handoff,
    execute_gpu_fem_eigen_with_progress_and_stage_handoff_and_producer_identity,
    execute_gpu_fem_eigen_with_producer_identity,
    execute_gpu_fem_eigen_with_stage_handoff, execute_planned_fem_eigen,
    execute_planned_fem_eigen_with_progress_and_producer_identity,
    execute_planned_fem_eigen_with_producer_identity,
    execute_planned_fem_eigen_with_handoff, execute_planned_fem_eigen_with_handoff_and_progress,
    execute_planned_fem_eigen_with_progress,
    execute_planned_fem_eigen_with_progress_and_stage_handoff_and_producer_identity,
    execute_planned_fem_eigen_with_progress_and_stage_handoff,
    execute_planned_fem_eigen_with_stage_handoff, reject_unsupported_floquet_dynamic_demag,
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
    accepted_fields: &crate::types::CertifiedFemEquilibriumFields,
    certified_fields: &crate::types::CertifiedFemEquilibriumFields,
    certificate: &crate::types::RecomputedFemLinearizationCertificateV1,
) -> Result<(), crate::types::RunError> {
    let reject = |reason: &str| crate::types::RunError {
        message: format!("recomputed_linearization_certificate_invalid: {reason}"),
    };
    let has_uniaxial = plan.material.uniaxial_anisotropy.is_some();
    let (schema, provider, field_schema) = if has_uniaxial {
        ("RecomputedFemLinearizationCertificate.v2", "native_fem_final_state_refresh.v2",
         "CertifiedFemEquilibriumFields.v2")
    } else {
        ("RecomputedFemLinearizationCertificate.v1", "native_fem_final_state_refresh.v1",
         "CertifiedFemEquilibriumFields.v1")
    };
    if certificate.schema_version != schema
        || certificate.status != "matched"
        || certificate.recompute_provider != provider
        || accepted_fields.schema_version != field_schema
        || certified_fields.schema_version != field_schema
        || accepted_fields.h_anisotropy_a_per_m.is_some() != has_uniaxial
        || certified_fields.h_anisotropy_a_per_m.is_some() != has_uniaxial
        || certificate.max_h_anisotropy_difference_a_per_m.is_some() != has_uniaxial
    {
        return Err(reject("schema, status, provider, or material field mismatch"));
    }
    crate::fem::eigen_equilibrium_contract::validate_certified_equilibrium_fields(
        accepted_fields, source_mesh.nodes.len(),
    )?;
    crate::fem::eigen_equilibrium_contract::validate_certified_equilibrium_fields(
        certified_fields, source_mesh.nodes.len(),
    )?;
    if certificate.max_h_anisotropy_difference_a_per_m
        .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err(reject("anisotropy comparison evidence is non-finite or negative"));
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
    if certificate.accepted_fields_content_sha256 != accepted_fields.content_sha256
        || crate::types::certified_equilibrium_fields_sha256(accepted_fields)
            != accepted_fields.content_sha256
        || certificate.recomputed_fields_content_sha256 != certified_fields.content_sha256
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
    if [
        &certificate.equilibrium_content_sha256,
        &certificate.mesh_topology_sha256,
        &certificate.equilibrium_material_signature,
        &certificate.equilibrium_static_physics_signature,
        &certificate.equilibrium_boundary_signature,
        &certificate.accepted_fields_content_sha256,
        &certificate.recomputed_fields_content_sha256,
    ]
    .into_iter()
    .any(|digest| !is_sha256_digest(digest.as_str()))
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
        || certificate.field_absolute_tolerance_a_per_m
            != crate::types::FEM_LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M
        || certificate.field_relative_tolerance
            != crate::types::FEM_LINEARIZATION_FIELD_RELATIVE_TOLERANCE
        || certificate.phi_absolute_tolerance_a
            != crate::types::FEM_LINEARIZATION_PHI_ABSOLUTE_TOLERANCE_A
    {
        return Err(reject("comparison evidence is incomplete or non-finite"));
    }

    let mut validate_field_difference = |label: &str,
                                         recorded: f64,
                                         recomputed: Option<f64>,
                                         scale: f64|
     -> Result<(), crate::types::RunError> {
        let difference = recomputed.ok_or_else(|| reject(&format!(
            "{label} accepted/recomputed field shapes differ"
        )))?;
        if recorded != difference {
            return Err(reject(&format!(
                "{label} difference does not match independent replay"
            )));
        }
        let tolerance = crate::types::FEM_LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M
            + crate::types::FEM_LINEARIZATION_FIELD_RELATIVE_TOLERANCE * scale.max(1.0);
        if difference > tolerance {
            return Err(reject(&format!(
                "{label} accepted/recomputed difference exceeds tolerance"
            )));
        }
        Ok(())
    };
    validate_field_difference(
        "h_ex0",
        certificate.max_h_ex_difference_a_per_m,
        max_vector_difference(&accepted_fields.h_ex_a_per_m, &certified_fields.h_ex_a_per_m),
        max_vector_amplitude(&accepted_fields.h_ex_a_per_m)
            .max(max_vector_amplitude(&certified_fields.h_ex_a_per_m)),
    )?;
    validate_field_difference(
        "h_demag0",
        certificate.max_h_demag_difference_a_per_m,
        max_vector_difference(&accepted_fields.h_demag_a_per_m, &certified_fields.h_demag_a_per_m),
        max_vector_amplitude(&accepted_fields.h_demag_a_per_m)
            .max(max_vector_amplitude(&certified_fields.h_demag_a_per_m)),
    )?;
    validate_field_difference(
        "h_ext0",
        certificate.max_h_ext_difference_a_per_m,
        max_vector_difference(&accepted_fields.h_ext_a_per_m, &certified_fields.h_ext_a_per_m),
        max_vector_amplitude(&accepted_fields.h_ext_a_per_m)
            .max(max_vector_amplitude(&certified_fields.h_ext_a_per_m)),
    )?;
    validate_field_difference(
        "h_eff0",
        certificate.max_h_eff_difference_a_per_m,
        max_vector_difference(&accepted_fields.h_eff_a_per_m, &certified_fields.h_eff_a_per_m),
        max_vector_amplitude(&accepted_fields.h_eff_a_per_m)
            .max(max_vector_amplitude(&certified_fields.h_eff_a_per_m)),
    )?;
    if let (Some(accepted_anisotropy), Some(certified_anisotropy)) = (
        &accepted_fields.h_anisotropy_a_per_m,
        &certified_fields.h_anisotropy_a_per_m,
    ) {
        let recorded_anisotropy = certificate
            .max_h_anisotropy_difference_a_per_m
            .ok_or_else(|| reject("V2 certificate is missing anisotropy difference"))?;
        validate_field_difference(
            "h_anisotropy0",
            recorded_anisotropy,
            max_vector_difference(accepted_anisotropy, certified_anisotropy),
            max_vector_amplitude(accepted_anisotropy)
                .max(max_vector_amplitude(certified_anisotropy)),
        )?;
    }
    let max_phi_difference = max_scalar_difference(&accepted_fields.phi_a, &certified_fields.phi_a)
        .ok_or_else(|| reject("phi accepted/recomputed field shapes differ"))?;
    if certificate.max_phi_difference_a != max_phi_difference {
        return Err(reject("phi difference does not match independent replay"));
    }
    let phi_tolerance = crate::types::FEM_LINEARIZATION_PHI_ABSOLUTE_TOLERANCE_A
        + crate::types::FEM_LINEARIZATION_FIELD_RELATIVE_TOLERANCE
            * max_scalar_amplitude(&accepted_fields.phi_a)
                .max(max_scalar_amplitude(&certified_fields.phi_a))
                .max(1.0);
    if max_phi_difference > phi_tolerance {
        return Err(reject("phi accepted/recomputed difference exceeds tolerance"));
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn max_vector_difference(left: &[[f64; 3]], right: &[[f64; 3]]) -> Option<f64> {
    (left.len() == right.len()).then(|| {
        left.iter()
            .zip(right)
            .flat_map(|(left, right)| left.iter().zip(right))
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f64, f64::max)
    })
}

fn max_vector_amplitude(values: &[[f64; 3]]) -> f64 {
    values
        .iter()
        .flatten()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max)
}

fn max_scalar_difference(left: &[f64], right: &[f64]) -> Option<f64> {
    (left.len() == right.len()).then(|| {
        left.iter()
            .zip(right)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f64, f64::max)
    })
}

fn max_scalar_amplitude(values: &[f64]) -> f64 {
    values
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max)
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
