//! Replay exact accepted Relax artifacts through the existing scientific gate.
//! The neutral CAS codec validates transport; this boundary validates physics,
//! source identity and the independently recomputed native endpoint.
use crate::{
    AcceptedFemRelaxExactArtifacts, AcceptedFemRelaxStageHandoff, CertifiedFemEquilibriumFields,
    FemRelaxationProducerProvenance, RecomputedFemLinearizationCertificateV1, RunError,
    StageFemMeshAsset, FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH,
};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR, StageCompletionIR};
use serde::de::DeserializeOwned;
use std::collections::{BTreeMap, BTreeSet};

const MAX_REPLAY_BYTES: usize = 64 * 1024 * 1024;

pub struct ReplayedFemRelaxation {
    pub handoff: AcceptedFemRelaxStageHandoff,
    /// These exact values have passed the same certificate as `handoff`.
    pub equilibrium_magnetization: Vec<[f64; 3]>,
}

fn invalid(message: impl Into<String>) -> RunError {
    RunError {
        message: format!("accepted FEM equilibrium replay: {}", message.into()),
    }
}

fn member<'a>(members: &'a BTreeMap<String, Vec<u8>>, path: &str) -> Result<&'a [u8], RunError> {
    members
        .get(path)
        .map(Vec::as_slice)
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| invalid(format!("missing exact member {path}")))
}

fn decode<T: DeserializeOwned>(
    members: &BTreeMap<String, Vec<u8>>,
    path: &str,
) -> Result<T, RunError> {
    serde_json::from_slice(member(members, path)?)
        .map_err(|error| invalid(format!("invalid {path}: {error}")))
}

/// Reconstruct the existing verified handoff without solving or relaxing.
/// No member discovery, certificate relabelling or cross-version fallback occurs.
pub fn replay_accepted_fem_relaxation(
    members: &BTreeMap<String, Vec<u8>>,
    expected_run_id: &str,
    expected_stage_id: &str,
    execution_plan_fingerprint: &str,
) -> Result<ReplayedFemRelaxation, RunError> {
    for identity in [expected_run_id, expected_stage_id] {
        fullmag_session::repository_path::validate_store_id(identity)
            .map_err(|error| invalid(error.to_string()))?;
    }
    let total = members
        .values()
        .try_fold(0usize, |sum, bytes| sum.checked_add(bytes.len()))
        .ok_or_else(|| invalid("member size overflow"))?;
    if members.len() != 7 || total > MAX_REPLAY_BYTES {
        return Err(invalid("unexpected member closure or byte budget"));
    }
    let plan: ExecutionPlanIR = decode(members, "source/execution_plan.json")?;
    let actual_fingerprint = fullmag_session::canonical_json_sha256(
        &serde_json::to_value(&plan).map_err(|error| invalid(error.to_string()))?,
    );
    if execution_plan_fingerprint != actual_fingerprint {
        return Err(invalid("source execution plan fingerprint differs"));
    }
    let BackendPlanIR::Fem(source_plan) = &plan.backend_plan else {
        return Err(invalid("source plan is not time-domain FEM"));
    };
    if source_plan.relaxation.is_none() {
        return Err(invalid("source plan is not a Relax producer"));
    }
    let accepted_path =
        CertifiedFemEquilibriumFields::accepted_artifact_path_for_material(&source_plan.material);
    let (certified_path, recomputed_path) =
        CertifiedFemEquilibriumFields::artifact_paths_for_material(&source_plan.material);
    let expected = BTreeSet::from([
        "source/execution_plan.json",
        "source/completion.json",
        "source/m0.json",
        FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH,
        accepted_path,
        certified_path,
        recomputed_path,
    ]);
    if members.keys().any(|key| !expected.contains(key.as_str())) {
        return Err(invalid(
            "members differ from the source material certificate family",
        ));
    }
    let mesh = StageFemMeshAsset::build_from_backend_plan(&plan.backend_plan)
        .ok_or_else(|| invalid("source plan has no canonical FEM mesh"))?;
    let completion: StageCompletionIR = decode(members, "source/completion.json")?;
    let m0: Vec<[f64; 3]> = decode(members, "source/m0.json")?;
    if m0.is_empty() || m0.iter().flatten().any(|value| !value.is_finite()) {
        return Err(invalid(
            "source equilibrium has nonfinite or missing samples",
        ));
    }
    let accepted_fields: CertifiedFemEquilibriumFields = decode(members, accepted_path)?;
    let certified_fields: CertifiedFemEquilibriumFields = decode(members, certified_path)?;
    let recomputed_certificate: RecomputedFemLinearizationCertificateV1 =
        decode(members, recomputed_path)?;
    let provenance: FemRelaxationProducerProvenance =
        decode(members, FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH)?;
    let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax_verified_with_exact_artifacts_and_provenance(
        expected_run_id, expected_stage_id, "relaxation", true,
        source_plan, &mesh.payload, &completion, m0.clone(),
        accepted_fields, certified_fields, recomputed_certificate,
        AcceptedFemRelaxExactArtifacts {
            accepted_fields_json: member(members, accepted_path)?.to_vec(),
            certified_fields_json: member(members, certified_path)?.to_vec(),
            recomputed_certificate_json: member(members, recomputed_path)?.to_vec(),
        },
        provenance,
        member(members, FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH)?.to_vec(),
    )?;
    Ok(ReplayedFemRelaxation {
        handoff,
        equilibrium_magnetization: m0,
    })
}

/// Bind the exact certified endpoint into a copy of the immutable target plan.
/// Validation occurs before the accepted worker reserves a native attempt.
pub fn materialize_accepted_fem_relaxation_target(
    plan: &ExecutionPlanIR,
    replayed: &ReplayedFemRelaxation,
) -> Result<ExecutionPlanIR, RunError> {
    let mut bound = plan.clone();
    let BackendPlanIR::FemEigen(eigen) = &mut bound.backend_plan else {
        return Err(invalid("equilibrium consumer is not FEM eigen"));
    };
    if eigen.equilibrium != fullmag_ir::EquilibriumSourceIR::RelaxedInitialState {
        return Err(invalid(
            "typed Relax handoff requires the declared relaxed equilibrium source",
        ));
    }
    if replayed.equilibrium_magnetization.len() != eigen.mesh.nodes.len() {
        return Err(invalid("equilibrium and target node counts differ"));
    }
    eigen.equilibrium_magnetization = replayed.equilibrium_magnetization.clone();
    if matches!(
        &eigen.k_sampling,
        Some(fullmag_ir::KSamplingIR::Path { .. })
    ) {
        // Validate the outer static-equilibrium envelope with the existing
        // path-aware continuation contract. Keep the authored Relax marker:
        // the path executor performs the strict Single -> Provided transition
        // and certificate check for every materialized point before solving.
        let mut continuation = eigen.clone();
        continuation.equilibrium = fullmag_ir::EquilibriumSourceIR::Provided;
        replayed
            .handoff
            .validate_provided_continuation_plan(&continuation)?;
    } else {
        replayed.handoff.validate_target_plan(eigen)?;
    }
    Ok(bound)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_native_closure_cannot_be_replaced_by_an_initial_state() {
        let members = BTreeMap::from([("source/m0.json".into(), b"[[1,0,0]]".to_vec())]);
        assert!(
            replay_accepted_fem_relaxation(&members, "run-exact", "relax", &"a".repeat(64))
                .is_err()
        );
    }
    #[test]
    fn invalid_source_owner_is_rejected_before_replay() {
        assert!(replay_accepted_fem_relaxation(
            &BTreeMap::new(),
            "../foreign",
            "relax",
            &"a".repeat(64)
        )
        .is_err());
    }
}
