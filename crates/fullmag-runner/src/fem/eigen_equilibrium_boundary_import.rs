use super::eigen_equilibrium_contract::{
    certified_equilibrium_artifact_filenames,
    linearization_identity_v2_content_sha256_from_preimage_bytes,
    validate_linearization_identity_source_snapshots, LinearizationIdentityPreimageV1,
    LinearizationIdentityV2, LoadedEquilibriumArtifact, LINEARIZATION_IDENTITY_PREIMAGE_V1,
    LINEARIZATION_IDENTITY_V2,
};
use super::eigen_policy::k_sampling_is_single_k0;
use super::equilibrium_identity::EquilibriumIdentitySignaturesV1;
use crate::types::RunError;
use fullmag_ir::{
    FemEigenPlanIR, KSamplingIR, SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const LINEARIZATION_IDENTITY_FILENAME: &str = "linearization_identity.v2.json";
const LINEARIZATION_IDENTITY_PREIMAGE_FILENAME: &str = "linearization_identity_preimage.v1.json";

struct SourceSidecarLocation {
    directory: PathBuf,
    sample_index: usize,
    artifact_prefixes: Vec<String>,
}

pub(super) fn validate_modal_boundary_equilibrium_import(
    target_plan: &FemEigenPlanIR,
    source_artifact_path: &str,
    source_artifact: &LoadedEquilibriumArtifact,
    target_boundary_signature: &str,
) -> Result<(), RunError> {
    validate_modal_boundary_equilibrium_import_inner(
        target_plan,
        source_artifact_path,
        source_artifact,
    )
    .map_err(|reason| RunError {
        message: format!(
            "equilibrium_boundary_hash_mismatch: stored '{}' does not match recomputed '{}': import proof rejected: {}",
            source_artifact.boundary_signature, target_boundary_signature, reason
        ),
    })
}

fn validate_modal_boundary_equilibrium_import_inner(
    target_plan: &FemEigenPlanIR,
    source_artifact_path: &str,
    source_artifact: &LoadedEquilibriumArtifact,
) -> Result<(), String> {
    let source_schema = source_artifact
        .value
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "source artifact schema_version is missing".to_string())?;
    let expected_state_schema = match source_schema {
        "equilibrium_artifact.v7" => "LinearizationState.v6",
        "equilibrium_artifact.v8" => "LinearizationState.v7",
        _ => return Err("source artifact schema is unsupported".into()),
    };
    let (artifact_filename, state_filename) =
        certified_equilibrium_artifact_filenames(Some(source_schema), Some(expected_state_schema))
            .map_err(|error| error.message)?;
    if source_artifact
        .value
        .get("content_sha256")
        .and_then(serde_json::Value::as_str)
        != Some(source_artifact.content_sha256.as_str())
        || source_artifact
            .value
            .get("boundary_signature")
            .and_then(serde_json::Value::as_str)
            != Some(source_artifact.boundary_signature.as_str())
    {
        return Err("loaded source artifact fields disagree with its semantic payload".to_string());
    }

    let location = source_sidecar_location(source_artifact_path, artifact_filename)?;
    let identity_path = location.directory.join(LINEARIZATION_IDENTITY_FILENAME);
    let identity_bytes = std::fs::read(&identity_path).map_err(|error| {
        format!(
            "linearization identity sidecar is missing or unreadable: {} ({error})",
            identity_path.display()
        )
    })?;
    let identity: LinearizationIdentityV2 =
        serde_json::from_slice(&identity_bytes).map_err(|error| {
            format!(
                "linearization identity sidecar is invalid: {} ({error})",
                identity_path.display()
            )
        })?;

    if identity.schema_version != LINEARIZATION_IDENTITY_V2
        || identity.sample_index != location.sample_index
        || identity.equilibrium_artifact_schema != source_schema
        || identity.equilibrium_artifact_sha256 != source_artifact.content_sha256
    {
        return Err("linearization identity does not bind the imported artifact and sample".into());
    }
    let (_, identity_state_filename) = certified_equilibrium_artifact_filenames(
        Some(&identity.equilibrium_artifact_schema),
        Some(&identity.linearization_state_schema),
    )
    .map_err(|error| error.message)?;
    if identity_state_filename != state_filename {
        return Err("linearization identity artifact schema pair is inconsistent".into());
    }
    validate_identity_artifact_paths(&identity, &location, artifact_filename, state_filename)?;
    validate_linearization_identity_source_snapshots(&identity).map_err(|error| error.message)?;

    let preimage_path = location
        .directory
        .join(LINEARIZATION_IDENTITY_PREIMAGE_FILENAME);
    let preimage_sidecar_bytes = std::fs::read(&preimage_path).map_err(|error| {
        format!(
            "linearization identity preimage sidecar is missing or unreadable: {} ({error})",
            preimage_path.display()
        )
    })?;
    let preimage_sidecar: LinearizationIdentityPreimageV1 =
        serde_json::from_slice(&preimage_sidecar_bytes).map_err(|error| {
            format!(
                "linearization identity preimage sidecar is invalid: {} ({error})",
                preimage_path.display()
            )
        })?;
    if preimage_sidecar.schema_version != LINEARIZATION_IDENTITY_PREIMAGE_V1
        || preimage_sidecar.identity_schema != LINEARIZATION_IDENTITY_V2
        || preimage_sidecar.identity_content_sha256 != identity.content_sha256
    {
        return Err("linearization identity preimage sidecar schema or link is invalid".into());
    }
    let exact_preimage = preimage_sidecar.identity_preimage_json.as_bytes();
    if raw_sha256(exact_preimage) != preimage_sidecar.identity_preimage_sha256
        || linearization_identity_v2_content_sha256_from_preimage_bytes(exact_preimage)
            != identity.content_sha256
    {
        return Err("linearization identity exact preimage digest mismatch".into());
    }
    let mut preimage_identity: LinearizationIdentityV2 = serde_json::from_slice(exact_preimage)
        .map_err(|error| format!("linearization identity exact preimage is invalid: {error}"))?;
    let mut published_identity = identity.clone();
    preimage_identity.content_sha256.clear();
    published_identity.content_sha256.clear();
    if preimage_identity != published_identity {
        return Err("linearization identity typed fields differ from the exact preimage".into());
    }

    let snapshot_path = location.directory.join("consumer_plan_snapshot.v1.json");
    let snapshot_bytes = std::fs::read(&snapshot_path).map_err(|error| {
        format!(
            "consumer plan snapshot is missing or unreadable: {} ({error})",
            snapshot_path.display()
        )
    })?;
    if raw_sha256(&snapshot_bytes) != identity.consumer_plan_snapshot_sha256 {
        return Err("consumer plan snapshot raw-byte digest mismatch".into());
    }
    let source_plan: FemEigenPlanIR = serde_json::from_slice(&snapshot_bytes)
        .map_err(|error| format!("consumer plan snapshot is invalid: {error}"))?;

    let source_signatures = EquilibriumIdentitySignaturesV1::from_eigen_plan(&source_plan)
        .map_err(|error| error.message)?;
    let target_signatures = EquilibriumIdentitySignaturesV1::from_eigen_plan(target_plan)
        .map_err(|error| error.message)?;
    if source_signatures != target_signatures {
        return Err(
            "source and target static material, physics, or equilibrium boundary signatures differ"
                .into(),
        );
    }
    if identity.equilibrium_material_signature != source_signatures.equilibrium_material_signature
        || identity.equilibrium_material_preimage_json
            != source_signatures.equilibrium_material_preimage_json
        || identity.equilibrium_static_physics_signature
            != source_signatures.equilibrium_static_physics_signature
        || identity.equilibrium_static_physics_preimage_json
            != source_signatures.equilibrium_static_physics_preimage_json
        || identity.equilibrium_boundary_signature
            != source_signatures.equilibrium_boundary_signature
        || identity.equilibrium_boundary_preimage_json
            != source_signatures.equilibrium_boundary_preimage_json
        || identity.material_signature != source_artifact.material_signature
    {
        return Err(
            "linearization identity physical signatures do not match the source plan".into(),
        );
    }

    if !is_allowed_floquet_periodic_change(&source_plan, target_plan) {
        return Err(
            "spin-wave configuration is not an exact Floquet/Periodic kind-only migration".into(),
        );
    }

    let source_boundary =
        super::eigen_shared_domain::legacy_modal_boundary_snapshot_signature(&source_plan)
            .map_err(|error| error.message)?;
    if source_boundary != source_artifact.boundary_signature {
        return Err("source plan does not reproduce the artifact legacy boundary signature".into());
    }
    Ok(())
}

fn source_sidecar_location(
    source_artifact_path: &str,
    expected_artifact_filename: &str,
) -> Result<SourceSidecarLocation, String> {
    let artifact_path = Path::new(source_artifact_path);
    if artifact_path.file_name().and_then(|name| name.to_str()) != Some(expected_artifact_filename)
    {
        return Err("source artifact path does not use its certified schema filename".into());
    }
    let parent = artifact_path
        .parent()
        .ok_or_else(|| "source artifact path has no parent directory".to_string())?;
    let parent_name = parent
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "source artifact parent directory is not UTF-8".to_string())?;

    if let Some(sample_index) = parse_sample_directory(parent_name) {
        let metadata = parent
            .parent()
            .ok_or_else(|| "sample-scoped artifact has no metadata parent".to_string())?;
        if metadata.file_name().and_then(|name| name.to_str()) != Some("metadata")
            || metadata
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some("eigen")
        {
            return Err("sample-scoped source artifact is outside canonical eigen metadata".into());
        }
        return Ok(SourceSidecarLocation {
            directory: parent.to_path_buf(),
            sample_index,
            artifact_prefixes: vec![format!("eigen/metadata/{parent_name}")],
        });
    }

    if parent_name == "metadata"
        && parent
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("eigen")
    {
        return Ok(SourceSidecarLocation {
            directory: parent.join("sample_0000"),
            sample_index: 0,
            artifact_prefixes: vec![
                "eigen/metadata".to_string(),
                "eigen/metadata/sample_0000".to_string(),
            ],
        });
    }
    Err("source artifact is outside the two canonical eigen metadata layouts".into())
}

fn parse_sample_directory(name: &str) -> Option<usize> {
    let digits = name.strip_prefix("sample_")?;
    if digits.len() < 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn validate_identity_artifact_paths(
    identity: &LinearizationIdentityV2,
    location: &SourceSidecarLocation,
    artifact_filename: &str,
    state_filename: &str,
) -> Result<(), String> {
    let mut matched_prefix = None;
    for prefix in &location.artifact_prefixes {
        let expected_artifact_path = format!("{prefix}/{artifact_filename}");
        if identity.equilibrium_artifact_path == expected_artifact_path {
            matched_prefix = Some(prefix);
            break;
        }
    }
    let prefix = matched_prefix.ok_or_else(|| {
        "linearization identity artifact path is not the canonical imported artifact path"
            .to_string()
    })?;
    if identity.linearization_state_path != format!("{prefix}/{state_filename}") {
        return Err(
            "linearization identity state path does not share the artifact publication path".into(),
        );
    }
    Ok(())
}

fn is_allowed_floquet_periodic_change(
    source_plan: &FemEigenPlanIR,
    target_plan: &FemEigenPlanIR,
) -> bool {
    let source_kind = source_plan.spin_wave_bc.kind();
    let target_kind = target_plan.spin_wave_bc.kind();
    if !matches!(
        (source_kind, target_kind),
        (
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet
        ) | (
            SpinWaveBoundaryKindIR::Floquet,
            SpinWaveBoundaryKindIR::Periodic
        )
    ) {
        return false;
    }
    if !same_spin_wave_config_except_kind(&source_plan.spin_wave_bc, &target_plan.spin_wave_bc) {
        return false;
    }
    if !single_k_is_finite(source_plan.k_sampling.as_ref())
        || !single_k_is_finite(target_plan.k_sampling.as_ref())
    {
        return false;
    }
    (source_kind != SpinWaveBoundaryKindIR::Periodic
        || k_sampling_is_single_k0(source_plan.k_sampling.as_ref()))
        && (target_kind != SpinWaveBoundaryKindIR::Periodic
            || k_sampling_is_single_k0(target_plan.k_sampling.as_ref()))
}

fn same_spin_wave_config_except_kind(
    source: &SpinWaveBoundaryConditionIR,
    target: &SpinWaveBoundaryConditionIR,
) -> bool {
    match (source, target) {
        (
            SpinWaveBoundaryConditionIR::Legacy(source_kind),
            SpinWaveBoundaryConditionIR::Legacy(target_kind),
        ) => source_kind != target_kind,
        (
            SpinWaveBoundaryConditionIR::Config(source_config),
            SpinWaveBoundaryConditionIR::Config(target_config),
        ) => {
            let mut normalized_source = source_config.clone();
            let mut normalized_target = target_config.clone();
            normalized_source.kind = SpinWaveBoundaryKindIR::Periodic;
            normalized_target.kind = SpinWaveBoundaryKindIR::Periodic;
            normalized_source == normalized_target
        }
        _ => false,
    }
}

fn single_k_is_finite(k_sampling: Option<&KSamplingIR>) -> bool {
    matches!(
        k_sampling,
        Some(KSamplingIR::Single { k_vector })
            if k_vector.iter().all(|component| component.is_finite())
    )
}

fn raw_sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::eigen_equilibrium_contract::{
        consumer_plan_snapshot_bytes, linearization_identity_v2_preimage_sidecar_bytes,
    };
    use crate::fem::eigen_tests::minimal_native_modal_plan;
    use crate::fem::eigen_types::AcceptedEquilibriumCriterion;
    use fullmag_ir::{
        EquilibriumSourceIR, PhaseConventionIR, SpinWaveBoundaryConfigIR, StageMetricKind,
        StageStopReason,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(1);

    struct ImportFixture {
        root: PathBuf,
        artifact_path: PathBuf,
        sidecar_directory: PathBuf,
        source_plan: FemEigenPlanIR,
        target_plan: FemEigenPlanIR,
        source_artifact: LoadedEquilibriumArtifact,
        identity: LinearizationIdentityV2,
    }

    impl ImportFixture {
        fn new(
            source_kind: SpinWaveBoundaryKindIR,
            target_kind: SpinWaveBoundaryKindIR,
            source_k: [f64; 3],
            target_k: [f64; 3],
            schema: &'static str,
            sample_index: Option<usize>,
        ) -> Self {
            let mut source_plan = minimal_native_modal_plan();
            source_plan.spin_wave_bc = configured_boundary(source_kind);
            source_plan.k_sampling = Some(KSamplingIR::Single { k_vector: source_k });
            if schema == "equilibrium_artifact.v8" {
                source_plan.material.uniaxial_anisotropy = Some(1.0e4);
            }
            let mut target_plan = source_plan.clone();
            target_plan.spin_wave_bc = configured_boundary(target_kind);
            target_plan.k_sampling = Some(KSamplingIR::Single { k_vector: target_k });

            let source_signatures =
                EquilibriumIdentitySignaturesV1::from_eigen_plan(&source_plan).unwrap();
            let source_boundary =
                super::super::eigen_shared_domain::legacy_modal_boundary_snapshot_signature(
                    &source_plan,
                )
                .unwrap();
            let artifact_material_signature = if schema == "equilibrium_artifact.v8" {
                source_signatures.equilibrium_material_signature.clone()
            } else {
                super::super::eigen_digest::shared_domain_content_digest(
                    "material_signature",
                    &source_plan.material,
                )
                .unwrap()
            };
            let mut artifact_value = serde_json::json!({
                "schema_version": schema,
                "producer_run_id": "run-boundary-import-fixture",
                "mesh_signature": format!("sha256:{}", "1".repeat(64)),
                "material_signature": artifact_material_signature,
                "physics_signature": format!("sha256:{}", "2".repeat(64)),
                "boundary_signature": source_boundary,
                "static_demag_signature": format!("sha256:{}", "3".repeat(64))
            });
            let content_sha256 = seal_artifact(&mut artifact_value, schema);
            let source_artifact = LoadedEquilibriumArtifact {
                value: artifact_value,
                m0: vec![[0.0, 0.0, 1.0]],
                h_eff0: vec![[0.0, 1.0, 0.0]],
                h_demag0: vec![[0.0, 0.0, 0.0]],
                phi0: vec![0.0],
                equilibrium_id: format!(
                    "{schema}:{}",
                    content_sha256.strip_prefix("sha256:").unwrap()
                ),
                producer_run_id: "run-boundary-import-fixture".to_string(),
                content_sha256: content_sha256.clone(),
                mesh_signature: format!("sha256:{}", "1".repeat(64)),
                material_signature: artifact_material_signature.clone(),
                physics_signature: format!("sha256:{}", "2".repeat(64)),
                boundary_signature: source_boundary,
                static_demag_signature: format!("sha256:{}", "3".repeat(64)),
                demag_model: "none".to_string(),
                m0_norm_tolerance: 1.0e-8,
                phi0_requirement: "required_for_restart_or_provenance".to_string(),
                periodic_mesh_certificate: serde_json::json!({}),
                acceptance_certificate: AcceptedEquilibriumCriterion {
                    criterion: "energy".to_string(),
                    metric_kind: StageMetricKind::TotalEnergyPlateauRangeJ,
                    metric_value: 0.0,
                    threshold: 1.0e-12,
                    unit: "J".to_string(),
                    status: "completed".to_string(),
                    converged: true,
                    stop_reason: StageStopReason::Energy,
                },
                completion_sha256: format!("sha256:{}", "4".repeat(64)),
            };

            let id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "fullmag-eigen-equilibrium-boundary-import-{}-{id}",
                std::process::id()
            ));
            let metadata_directory = root.join("eigen").join("metadata");
            let artifact_prefix = match sample_index {
                Some(index) => format!("eigen/metadata/sample_{index:04}"),
                None => "eigen/metadata/sample_0000".to_string(),
            };
            let artifact_directory = match sample_index {
                Some(index) => metadata_directory.join(format!("sample_{index:04}")),
                None => metadata_directory.clone(),
            };
            let sidecar_directory = match sample_index {
                Some(_) => artifact_directory.clone(),
                None => metadata_directory.join("sample_0000"),
            };
            std::fs::create_dir_all(&artifact_directory).unwrap();
            std::fs::create_dir_all(&sidecar_directory).unwrap();
            let (artifact_filename, state_filename) = certified_equilibrium_artifact_filenames(
                Some(schema),
                Some(if schema == "equilibrium_artifact.v8" {
                    "LinearizationState.v7"
                } else {
                    "LinearizationState.v6"
                }),
            )
            .unwrap();
            let artifact_path = artifact_directory.join(artifact_filename);
            source_plan.equilibrium = EquilibriumSourceIR::Artifact {
                path: artifact_path.to_string_lossy().into_owned(),
            };
            target_plan.equilibrium = EquilibriumSourceIR::Artifact {
                path: artifact_path.to_string_lossy().into_owned(),
            };
            std::fs::write(
                &artifact_path,
                serde_json::to_vec_pretty(&source_artifact.value).unwrap(),
            )
            .unwrap();

            let sample_index = sample_index.unwrap_or(0);
            let snapshot_bytes = consumer_plan_snapshot_bytes(&source_plan).unwrap();
            let mut identity = identity_fixture(
                sample_index,
                &artifact_prefix,
                artifact_filename,
                state_filename,
                &source_artifact,
                &source_signatures,
                &artifact_material_signature,
                &snapshot_bytes,
            );
            write_identity_sidecars(&sidecar_directory, &mut identity);
            std::fs::write(
                sidecar_directory.join("consumer_plan_snapshot.v1.json"),
                snapshot_bytes,
            )
            .unwrap();

            Self {
                root,
                artifact_path,
                sidecar_directory,
                source_plan,
                target_plan,
                source_artifact,
                identity,
            }
        }

        fn validate(&self) -> Result<(), RunError> {
            let target_boundary =
                super::super::eigen_shared_domain::legacy_modal_boundary_snapshot_signature(
                    &self.target_plan,
                )
                .unwrap();
            validate_modal_boundary_equilibrium_import(
                &self.target_plan,
                &self.artifact_path.to_string_lossy(),
                &self.source_artifact,
                &target_boundary,
            )
        }

        fn reseal_identity(&mut self) {
            write_identity_sidecars(&self.sidecar_directory, &mut self.identity);
        }

        fn reseal_artifact_boundary(&mut self, boundary: &str) {
            self.source_artifact.value["boundary_signature"] = serde_json::json!(boundary);
            let schema = self.source_artifact.value["schema_version"]
                .as_str()
                .unwrap()
                .to_string();
            let content_sha256 = seal_artifact(&mut self.source_artifact.value, &schema);
            self.source_artifact.content_sha256 = content_sha256.clone();
            self.source_artifact.equilibrium_id = format!(
                "{schema}:{}",
                content_sha256.strip_prefix("sha256:").unwrap()
            );
            self.source_artifact.boundary_signature = boundary.to_string();
            self.identity.equilibrium_artifact_sha256 = content_sha256;
            self.reseal_identity();
            std::fs::write(
                &self.artifact_path,
                serde_json::to_vec_pretty(&self.source_artifact.value).unwrap(),
            )
            .unwrap();
        }
    }

    impl Drop for ImportFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn configured_boundary(kind: SpinWaveBoundaryKindIR) -> SpinWaveBoundaryConditionIR {
        SpinWaveBoundaryConditionIR::Config(SpinWaveBoundaryConfigIR {
            kind,
            boundary_pair_id: Some("x-periodic".to_string()),
            pair_ids: vec!["x-periodic".to_string()],
            phase_convention: PhaseConventionIR::ExpMinusIKDotDeltaR,
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        })
    }

    fn identity_fixture(
        sample_index: usize,
        artifact_prefix: &str,
        artifact_filename: &str,
        state_filename: &str,
        source_artifact: &LoadedEquilibriumArtifact,
        signatures: &EquilibriumIdentitySignaturesV1,
        material_signature: &str,
        snapshot_bytes: &[u8],
    ) -> LinearizationIdentityV2 {
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut identity: LinearizationIdentityV2 = serde_json::from_value(serde_json::json!({
            "schema_version": LINEARIZATION_IDENTITY_V2,
            "sample_index": sample_index,
            "equilibrium_artifact_schema": source_artifact.value["schema_version"],
            "linearization_state_schema": if source_artifact.value["schema_version"] == "equilibrium_artifact.v8" { "LinearizationState.v7" } else { "LinearizationState.v6" },
            "accepted_fields_schema": "CertifiedFemEquilibriumFields.v2",
            "certified_fields_schema": "CertifiedFemEquilibriumFields.v2",
            "recomputed_certificate_schema": "RecomputedFemLinearizationCertificate.v1",
            "handoff_schema_version": "AcceptedFemRelaxStageHandoff.v2",
            "handoff_content_sha256": digest.clone(),
            "source_run_id": "run-boundary-import-fixture",
            "source_stage_id": "stage-boundary-import-fixture",
            "source_stage_kind": "relaxation",
            "producer_plan_snapshot_sha256": digest.clone(),
            "consumer_plan_snapshot_sha256": raw_sha256(snapshot_bytes),
            "producer_build_identity": {"source_snapshot_sha256": "a".repeat(64)},
            "consumer_build_identity": {"source_snapshot_sha256": "a".repeat(64)},
            "producer_source_snapshot_sha256": "a".repeat(64),
            "consumer_source_snapshot_sha256": "a".repeat(64),
            "cross_build_policy": "same_source_snapshot_required",
            "source_mesh_topology_sha256": digest.clone(),
            "modal_mesh_topology_fingerprint_v3": digest.clone(),
            "node_count": 4,
            "equilibrium_content_sha256": format!("sha256:{}", "c".repeat(64)),
            "equilibrium_artifact_path": format!("{artifact_prefix}/{artifact_filename}"),
            "equilibrium_artifact_sha256": source_artifact.content_sha256,
            "linearization_state_path": format!("{artifact_prefix}/{state_filename}"),
            "linearization_state_sha256": digest.clone(),
            "equilibrium_material_signature": signatures.equilibrium_material_signature,
            "equilibrium_material_preimage_json": signatures.equilibrium_material_preimage_json,
            "equilibrium_static_physics_signature": signatures.equilibrium_static_physics_signature,
            "equilibrium_static_physics_preimage_json": signatures.equilibrium_static_physics_preimage_json,
            "equilibrium_boundary_signature": signatures.equilibrium_boundary_signature,
            "equilibrium_boundary_preimage_json": signatures.equilibrium_boundary_preimage_json,
            "material_signature": material_signature,
            "material_identity_kind": if (source_artifact.value["schema_version"] == "equilibrium_artifact.v8") { "canonical_equilibrium_material.v2" } else { "raw_material.v1" },
            "material_provenance_signature": digest.clone(),
            "material_provenance_scope": "materialization_plan",
            "material_provenance_preimage_json": "{}",
            "producer_material_provenance_signature": digest.clone(),
            "producer_material_provenance_preimage_json": "{}",
            "accepted_fields_content_sha256": digest.clone(),
            "accepted_fields_path": format!("{artifact_prefix}/accepted_fem_equilibrium_fields.v2.json"),
            "certified_fields_content_sha256": digest.clone(),
            "certified_fields_path": format!("{artifact_prefix}/certified_fem_equilibrium_fields.v2.json"),
            "recomputed_certificate_content_sha256": digest.clone(),
            "recomputed_certificate_path": format!("{artifact_prefix}/recomputed_fem_linearization_certificate.v1.json"),
            "accepted_fields_bytes_sha256": digest.clone(),
            "certified_fields_bytes_sha256": digest.clone(),
            "recomputed_certificate_bytes_sha256": digest.clone(),
            "recomputed_certificate_preimage_json": "{}",
            "recomputed_certificate_preimage_sha256": digest,
            "content_sha256": ""
        }))
        .unwrap();
        let preimage = serde_json::to_vec(&identity).unwrap();
        identity.content_sha256 =
            linearization_identity_v2_content_sha256_from_preimage_bytes(&preimage);
        identity
    }

    fn write_identity_sidecars(directory: &Path, identity: &mut LinearizationIdentityV2) {
        identity.content_sha256.clear();
        let preimage = serde_json::to_vec(identity).unwrap();
        identity.content_sha256 =
            linearization_identity_v2_content_sha256_from_preimage_bytes(&preimage);
        std::fs::write(
            directory.join(LINEARIZATION_IDENTITY_FILENAME),
            serde_json::to_vec_pretty(identity).unwrap(),
        )
        .unwrap();
        std::fs::write(
            directory.join(LINEARIZATION_IDENTITY_PREIMAGE_FILENAME),
            linearization_identity_v2_preimage_sidecar_bytes(identity).unwrap(),
        )
        .unwrap();
    }

    fn seal_artifact(value: &mut serde_json::Value, schema: &str) -> String {
        let object = value.as_object_mut().unwrap();
        object.remove("content_sha256");
        object.remove("equilibrium_id");
        let content_sha256 =
            super::super::eigen_digest::shared_domain_content_digest(schema, value).unwrap();
        value["content_sha256"] = serde_json::json!(content_sha256);
        value["equilibrium_id"] = serde_json::json!(format!(
            "{schema}:{}",
            content_sha256.strip_prefix("sha256:").unwrap()
        ));
        content_sha256
    }

    fn assert_boundary_import_rejected(fixture: &ImportFixture) {
        let error = fixture.validate().unwrap_err();
        assert!(
            error
                .message
                .starts_with("equilibrium_boundary_hash_mismatch:"),
            "unexpected rejection prefix: {}",
            error.message
        );
    }

    #[test]
    fn equilibrium_boundary_import_accepts_both_migration_directions() {
        let periodic_bootstrap = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        assert!(periodic_bootstrap.validate().is_ok());

        let mut root_published_path = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        root_published_path.identity.equilibrium_artifact_path =
            "eigen/metadata/equilibrium_artifact.v7.json".to_string();
        root_published_path.identity.linearization_state_path =
            "eigen/metadata/linearization_state.v6.json".to_string();
        root_published_path.reseal_identity();
        assert!(root_published_path.validate().is_ok());

        let floquet_source = ImportFixture::new(
            SpinWaveBoundaryKindIR::Floquet,
            SpinWaveBoundaryKindIR::Periodic,
            [0.0, 0.0, 1.0e7],
            [0.0, 0.0, 0.0],
            "equilibrium_artifact.v8",
            Some(3),
        );
        assert!(floquet_source.validate().is_ok());
    }

    #[test]
    fn equilibrium_boundary_import_rejects_missing_or_mutated_proof_sidecars() {
        for missing in [
            LINEARIZATION_IDENTITY_FILENAME,
            LINEARIZATION_IDENTITY_PREIMAGE_FILENAME,
            "consumer_plan_snapshot.v1.json",
        ] {
            let fixture = ImportFixture::new(
                SpinWaveBoundaryKindIR::Periodic,
                SpinWaveBoundaryKindIR::Floquet,
                [0.0, 0.0, 0.0],
                [0.0, 0.0, 1.0e7],
                "equilibrium_artifact.v7",
                None,
            );
            std::fs::remove_file(fixture.sidecar_directory.join(missing)).unwrap();
            assert_boundary_import_rejected(&fixture);
        }

        let fixture = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        let snapshot = fixture
            .sidecar_directory
            .join("consumer_plan_snapshot.v1.json");
        let mut bytes = std::fs::read(&snapshot).unwrap();
        bytes.push(b' ');
        std::fs::write(snapshot, bytes).unwrap();
        assert_boundary_import_rejected(&fixture);

        let fixture = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        let preimage_path = fixture
            .sidecar_directory
            .join(LINEARIZATION_IDENTITY_PREIMAGE_FILENAME);
        let mut sidecar: LinearizationIdentityPreimageV1 =
            serde_json::from_slice(&std::fs::read(&preimage_path).unwrap()).unwrap();
        sidecar.identity_preimage_json.push(' ');
        std::fs::write(preimage_path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        assert_boundary_import_rejected(&fixture);
    }

    #[test]
    fn equilibrium_boundary_import_rejects_inconsistent_identity_and_artifact_links() {
        let mut artifact_mismatch = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        artifact_mismatch.source_artifact.content_sha256 = format!("sha256:{}", "f".repeat(64));
        assert_boundary_import_rejected(&artifact_mismatch);

        let mut source_boundary_mismatch = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        source_boundary_mismatch.reseal_artifact_boundary(&format!("sha256:{}", "f".repeat(64)));
        assert_boundary_import_rejected(&source_boundary_mismatch);

        let mut signature_mismatch = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        signature_mismatch
            .identity
            .equilibrium_static_physics_signature = format!("sha256:{}", "e".repeat(64));
        signature_mismatch.reseal_identity();
        assert_boundary_import_rejected(&signature_mismatch);
    }

    #[test]
    fn equilibrium_boundary_import_rejects_non_kind_dynamic_and_static_changes() {
        let mut pair_id = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        if let SpinWaveBoundaryConditionIR::Config(config) = &mut pair_id.target_plan.spin_wave_bc {
            config.boundary_pair_id = Some("y-periodic".to_string());
        }
        assert_boundary_import_rejected(&pair_id);

        let mut surface_term = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        if let SpinWaveBoundaryConditionIR::Config(config) =
            &mut surface_term.target_plan.spin_wave_bc
        {
            config.surface_anisotropy_ks = Some(1.0e-3);
            config.surface_anisotropy_axis = Some([1.0, 0.0, 0.0]);
        }
        assert_boundary_import_rejected(&surface_term);

        let periodic_nonzero = ImportFixture::new(
            SpinWaveBoundaryKindIR::Floquet,
            SpinWaveBoundaryKindIR::Periodic,
            [0.0, 0.0, 1.0e7],
            [1.0e5, 0.0, 0.0],
            "equilibrium_artifact.v7",
            None,
        );
        assert_boundary_import_rejected(&periodic_nonzero);

        let mut material = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        material.target_plan.material.exchange_stiffness *= 1.01;
        assert_boundary_import_rejected(&material);

        let mut static_physics = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        static_physics.target_plan.external_field = Some([1.0, 0.0, 0.0]);
        assert_boundary_import_rejected(&static_physics);

        let mut airbox = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        airbox.target_plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 1.4,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: None,
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: None,
            factor_source: None,
            boundary_marker_source: None,
        });
        assert_boundary_import_rejected(&airbox);

        let mut pairs = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        pairs.target_plan.mesh.periodic_boundary_pairs.push(
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "changed".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 1,
                marker_b: 2,
                translation: None,
                tolerance: None,
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            },
        );
        assert_boundary_import_rejected(&pairs);
    }

    #[test]
    fn equilibrium_boundary_import_preserves_static_exchange_boundary_guard() {
        let mut fixture = ImportFixture::new(
            SpinWaveBoundaryKindIR::Periodic,
            SpinWaveBoundaryKindIR::Floquet,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0e7],
            "equilibrium_artifact.v7",
            None,
        );
        let snapshot_path = fixture
            .sidecar_directory
            .join("consumer_plan_snapshot.v1.json");
        let mut snapshot: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&snapshot_path).unwrap()).unwrap();
        snapshot["exchange_bc"] = serde_json::json!("unsupported_exchange_condition");
        let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
        fixture.identity.consumer_plan_snapshot_sha256 = raw_sha256(&snapshot_bytes);
        fixture.reseal_identity();
        std::fs::write(snapshot_path, snapshot_bytes).unwrap();
        assert_boundary_import_rejected(&fixture);
    }
}
