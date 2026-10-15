//! Parent-owned identity publication for hash-validated native k-worker outputs.
//! The private relaxation handoff never crosses the process boundary.

use super::eigen_equilibrium::load_certified_equilibrium_artifact;
use super::eigen_equilibrium_contract::{
    certified_equilibrium_artifact_filenames, AcceptedFemRelaxStageHandoff,
    LinearizationIdentityArtifacts,
};
use crate::types::{AuxiliaryArtifact, RunError};
use fullmag_ir::{EquilibriumSourceIR, FemEigenPlanIR};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn error(reason: &str) -> RunError {
    RunError {
        message: format!("worker_identity_publication_{reason}"),
    }
}

fn exact_json(artifacts: &[AuxiliaryArtifact], path: &str) -> Result<Value, RunError> {
    let mut matches = artifacts
        .iter()
        .filter(|artifact| artifact.relative_path == path);
    let artifact = matches
        .next()
        .ok_or_else(|| error(&format!("missing_artifact: {path}")))?;
    if matches.next().is_some() {
        return Err(error(&format!("duplicate_artifact: {path}")));
    }
    serde_json::from_slice(&artifact.bytes)
        .map_err(|cause| error(&format!("invalid_artifact_json: {path}: {cause}")))
}

/// Called only after the process pool has verified request, executable and output
/// byte hashes. The build identity is the parent's real executable identity.
/// Missing private evidence keeps the legacy Artifact-only route unqualified.
pub(super) fn publish_worker_identity(
    plan: &FemEigenPlanIR,
    sample_index: usize,
    final_magnetization: &[[f64; 3]],
    expected_input_raw_sha256: &str,
    handoff: Option<&AcceptedFemRelaxStageHandoff>,
    consumer_build_identity: Value,
    artifacts: &mut Vec<AuxiliaryArtifact>,
) -> Result<Option<String>, RunError> {
    let Some(handoff) = handoff else {
        return Ok(None);
    };
    if handoff.verified_replay().is_none() {
        return Err(error("missing_verified_handoff"));
    }
    if final_magnetization != handoff.equilibrium_magnetization
        || final_magnetization.len() != plan.mesh.nodes.len()
        || final_magnetization
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(error("final_magnetization_mismatch"));
    }
    let EquilibriumSourceIR::Artifact { path } = &plan.equilibrium else {
        return Err(error("requires_certified_artifact_input"));
    };
    let source_bytes =
        std::fs::read(path).map_err(|cause| error(&format!("read_input: {cause}")))?;
    if format!("sha256:{:x}", Sha256::digest(&source_bytes)) != expected_input_raw_sha256 {
        return Err(error("input_raw_sha256_mismatch"));
    }
    let source = load_certified_equilibrium_artifact(path, plan.mesh.nodes.len())?;
    // The loader reads the immutable source independently. Detect a changed file
    // instead of binding its earlier hash to a later decoded value.
    if std::fs::read(path).map_err(|cause| error(&format!("reread_input: {cause}")))?
        != source_bytes
        || serde_json::from_slice::<Value>(&source_bytes)
            .map_err(|cause| error(&format!("decode_input: {cause}")))?
            != source.value
    {
        return Err(error("input_changed_during_replay"));
    }
    if source.m0 != handoff.equilibrium_magnetization
        || source.producer_run_id != handoff.source_run_id
        || source.completion_sha256 != handoff.completion_sha256
        || source.acceptance_certificate != handoff.acceptance
    {
        return Err(error("input_handoff_binding_mismatch"));
    }
    let (equilibrium_name, state_name) =
        match source.value.get("schema_version").and_then(Value::as_str) {
            Some("equilibrium_artifact.v7") => certified_equilibrium_artifact_filenames(
                Some("equilibrium_artifact.v7"),
                Some("LinearizationState.v6"),
            )?,
            Some("equilibrium_artifact.v8") => certified_equilibrium_artifact_filenames(
                Some("equilibrium_artifact.v8"),
                Some("LinearizationState.v7"),
            )?,
            _ => return Err(error("unsupported_input_schema")),
        };
    let prefix = format!("eigen/metadata/sample_{sample_index:04}");
    let equilibrium_path = format!("{prefix}/{equilibrium_name}");
    let state_path = format!("{prefix}/{state_name}");
    for other in [
        "equilibrium_artifact.v7.json",
        "equilibrium_artifact.v8.json",
        "linearization_state.v6.json",
        "linearization_state.v7.json",
    ] {
        if other != equilibrium_name
            && other != state_name
            && artifacts
                .iter()
                .any(|artifact| artifact.relative_path == format!("{prefix}/{other}"))
        {
            return Err(error("conflicting_schema_family"));
        }
    }
    let equilibrium = exact_json(artifacts, &equilibrium_path)?;
    let state = exact_json(artifacts, &state_path)?;
    let view = LinearizationIdentityArtifacts::from_published_artifacts(&equilibrium, &state)?;
    let spectrum = exact_json(artifacts, "eigen/spectrum.json")?;
    let diagnostics = spectrum
        .get("solver_diagnostics")
        .and_then(Value::as_object)
        .ok_or_else(|| error("missing_spectrum_diagnostics"))?;
    for (field, expected) in [
        (
            "equilibrium_artifact_sha256",
            equilibrium.get("content_sha256"),
        ),
        ("linearization_state_sha256", state.get("content_sha256")),
    ] {
        if diagnostics.get(field) != expected || expected.is_none() {
            return Err(error(&format!("spectrum_state_binding_mismatch: {field}")));
        }
    }
    let marker = diagnostics
        .get("linearization_handoff")
        .and_then(Value::as_object)
        .ok_or_else(|| error("missing_spectrum_handoff_marker"))?;
    if marker.get("equilibrium_artifact_schema") != equilibrium.get("schema_version")
        || marker.get("linearization_state_schema") != state.get("schema_version")
        || marker
            .get("accepted_for_frequency_operator")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(error("spectrum_handoff_marker_mismatch"));
    }
    if view.equilibrium_artifact_digest() != source.content_sha256 || equilibrium != source.value {
        return Err(error("output_equilibrium_input_mismatch"));
    }
    // Boundary is target-specific (Gamma/Floquet may differ). The remaining
    // snapshots must retain the source's independently verified static state.
    for field in [
        "mesh_signature",
        "material_signature",
        "physics_signature",
        "static_demag_signature",
    ] {
        if state.get(field) != equilibrium.get(field) || state.get(field).is_none() {
            return Err(error(&format!("state_snapshot_mismatch: {field}")));
        }
    }
    if state.get("mesh_signature").and_then(Value::as_str)
        != Some(plan.mesh.topology_fingerprint_v6().as_str())
        || state.get("boundary_signature").and_then(Value::as_str)
            != Some(
                super::eigen_shared_domain::legacy_modal_boundary_snapshot_signature(plan)?
                    .as_str(),
            )
        || state.get("producer_run_id").and_then(Value::as_str)
            != Some(handoff.source_run_id.as_str())
        || state
            .get("equilibrium_acceptance_certificate_sha256")
            .and_then(Value::as_str)
            != Some(handoff.completion_sha256.as_str())
        || state.get("equilibrium_acceptance_certificate")
            != Some(
                &serde_json::to_value(&handoff.acceptance)
                    .map_err(|cause| error(&format!("acceptance_json: {cause}")))?,
            )
    {
        return Err(error("state_target_binding_mismatch"));
    }
    let target_topology = fullmag_engine::fem::MeshTopology::from_ir(&plan.mesh)
        .map_err(|cause| error(&format!("target_mesh_topology: {cause}")))?;
    let operator_m0 = super::eigen_shared_domain::extend_equilibrium_m0_to_air_nodes(
        &target_topology,
        &source.m0,
    );
    if state.get("m0") != Some(&serde_json::json!(operator_m0))
        || state.get("external_field_a_per_m") != Some(&serde_json::json!(plan.external_field))
        || state.get("m0_air_extension_policy").and_then(Value::as_str)
            != Some("fixed_unit_z_on_nonmagnetic_nodes_v1")
    {
        return Err(error("state_operator_m0_or_field_mismatch"));
    }
    for field in [
        "h_eff0_a_per_m",
        "h_demag0_a_per_m",
        "phi0_a",
        "phi0_requirement",
    ] {
        if state.get(field) != equilibrium.get(field) || state.get(field).is_none() {
            return Err(error(&format!("state_static_field_mismatch: {field}")));
        }
    }
    let topology = plan
        .mesh
        .mixed_topology_fingerprint_v3()
        .map_err(|cause| error(&format!("target_mesh_identity: {cause}")))?;
    let (identity, snapshot) = handoff.build_linearization_identity_v2_from_artifacts(
        plan,
        &view,
        sample_index,
        equilibrium_path,
        state_path,
        topology,
        consumer_build_identity,
    )?;
    let digest = identity.content_sha256.clone();
    // Validate every new sidecar before appending anything. Do not clone the
    // worker's potentially large mode-field buffers just to publish metadata.
    let mut bundle = Vec::new();
    super::eigen_native_artifacts::append_verified_linearization_identity_bundle(
        &mut bundle,
        &identity,
        &snapshot,
        handoff,
    )?;
    for sidecar in &bundle {
        let mut existing = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path == sidecar.relative_path);
        if let Some(first) = existing.next() {
            if existing.next().is_some() || first.bytes != sidecar.bytes {
                return Err(error(&format!(
                    "signed_sidecar_conflict: {}",
                    sidecar.relative_path
                )));
            }
        }
    }
    bundle.retain(|sidecar| {
        !artifacts
            .iter()
            .any(|artifact| artifact.relative_path == sidecar.relative_path)
    });
    artifacts.extend(bundle);
    Ok(Some(digest))
}
