use super::eigen_capability::{
    insert_native_cpu_modal_window_rejection_contract, native_cpu_modal_window_rejection_reason,
    native_cpu_modal_window_rejection_scope,
};
use super::eigen_policy::resolved_demag_realization;
use super::eigen_projection::tangent_bases;
use super::eigen_reduction::{
    tangent_frame_identity_mismatch, tangent_transport_matrix, tangent_transport_nonunitarity,
};
use crate::types::AuxiliaryArtifact;
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::Vector3;
use fullmag_ir::EigenDampingPolicyIR;
use fullmag_ir::EigenNormalizationIR;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::KSamplingIR;
use fullmag_ir::OutputIR;
use fullmag_ir::SpinWaveBoundaryConditionIR;
use fullmag_ir::SpinWaveBoundaryKindIR;
use num_complex::Complex64;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub(super) fn requested_mode_indices(outputs: &[OutputIR]) -> std::collections::BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| {
            if let OutputIR::EigenMode { indices, .. } = output {
                Some(indices.iter().copied())
            } else {
                None
            }
        })
        .flatten()
        .collect()
}

/// Native single-k artifacts use the actual returned vector slots. Path
/// publication resolves public raw identities from the emitted spectrum.
pub(super) fn requested_mode_indices_for_result(outputs: &[OutputIR], returned_count: usize) -> Result<BTreeSet<u32>, RunError> {
    if outputs.iter().any(|output| matches!(output, OutputIR::EigenMode { all_modes: true, .. })) {
        let count = u32::try_from(returned_count).map_err(|_| RunError {
            message: "returned native mode count exceeds output selector range".to_string(),
        })?;
        Ok((0..count).collect())
    } else {
        Ok(requested_mode_indices(outputs))
    }
}

pub(super) fn json_artifact(
    path: impl Into<String>,
    value: &serde_json::Value,
) -> Result<AuxiliaryArtifact, RunError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| RunError {
        message: format!("failed to serialize eigen artifact: {}", error),
    })?;
    Ok(AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    })
}

fn binary_artifact(path: impl Into<String>, bytes: Vec<u8>) -> AuxiliaryArtifact {
    AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    }
}

/// R4 sidecars are a closed family.  Keep the path spelling and family
/// mapping in one Rust contract so single-k and multi-k publication cannot
/// silently diverge.  `{:04}` is a minimum width: sample 10000 is therefore
/// canonically named `sample_10000`, not padded to an arbitrary width.
pub(crate) const R4_SIDECAR_DEFINITIONS: [(&str, &str, Option<&str>); 9] = [
    (
        "accepted_fem_equilibrium_fields_v1_paths",
        "accepted_fem_equilibrium_fields.v1.json",
        Some("v1"),
    ),
    (
        "accepted_fem_equilibrium_fields_v2_paths",
        "accepted_fem_equilibrium_fields.v2.json",
        Some("v2"),
    ),
    (
        "linearization_identity_v2_paths",
        "linearization_identity.v2.json",
        Some("v2"),
    ),
    (
        "linearization_identity_preimage_v1_paths",
        "linearization_identity_preimage.v1.json",
        Some("v2"),
    ),
    (
        "certified_fem_equilibrium_fields_v1_paths",
        "certified_fem_equilibrium_fields.v1.json",
        Some("v1"),
    ),
    (
        "certified_fem_equilibrium_fields_v2_paths",
        "certified_fem_equilibrium_fields.v2.json",
        Some("v2"),
    ),
    (
        "recomputed_fem_linearization_certificate_v1_paths",
        "recomputed_fem_linearization_certificate.v1.json",
        Some("v1"),
    ),
    (
        "recomputed_fem_linearization_certificate_v2_paths",
        "recomputed_fem_linearization_certificate.v2.json",
        Some("v2"),
    ),
    (
        "consumer_plan_snapshot_v1_paths",
        super::eigen_equilibrium_contract::CONSUMER_PLAN_SNAPSHOT_FILENAME,
        None,
    ),
];

/// Non-shared Floquet sidecars are a separate provenance family.  They must
/// never be folded into the shared R4 identity/certification gate: a complete
/// non-shared path set only proves that the producer published the three
/// historical identity/source payloads for every computed sample.  The final
/// native-input diagnostic payloads have a separate structural family below
/// so historical three-sidecar coverage remains byte-for-byte compatible.
pub(crate) const NONSHARED_FLOQUET_SIDECAR_DEFINITIONS: [(&str, &str, &str); 3] = [
    (
        "nonshared_floquet_operator_identity_v1_paths",
        "nonshared_floquet_operator_identity.v1.json",
        "nonshared_floquet_operator_identity_v1_path",
    ),
    (
        "nonshared_floquet_operator_identity_preimage_v1_paths",
        "nonshared_floquet_operator_identity_preimage.v1.json",
        "nonshared_floquet_operator_identity_preimage_v1_path",
    ),
    (
        "nonshared_floquet_source_state_v1_paths",
        "nonshared_floquet_source_state.v1.json",
        "nonshared_floquet_source_state_v1_path",
    ),
];

/// Final native-input diagnostic sidecars are structural evidence only.  Keep
/// them independent from the historical three-sidecar coverage so an old
/// bundle does not change status or lose its singular aliases merely because
/// this additive family was introduced.
pub(crate) const NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS:
    [(&str, &str, &str); 2] = [
    (
        "nonshared_floquet_native_input_diagnostics_v1_paths",
        "native_input_operator_diagnostics.v1.json",
        "nonshared_floquet_native_input_diagnostics_v1_path",
    ),
    (
        "nonshared_floquet_native_input_diagnostics_preimage_v1_paths",
        "native_input_operator_diagnostics_preimage.v1.json",
        "nonshared_floquet_native_input_diagnostics_preimage_v1_path",
    ),
];

/// Parse exactly the canonical `eigen/metadata/sample_NNNN/<filename>` path.
/// The width is a minimum width, matching Rust `format!("{index:04}")` and
/// allowing `sample_10000` without inventing a second five-digit convention.
pub(crate) fn canonical_sample_scoped_index(
    relative_path: &str,
    filename: &str,
) -> Option<usize> {
    let prefix = "eigen/metadata/sample_";
    let suffix = format!("/{filename}");
    if relative_path.contains('\\')
        || !relative_path.starts_with(prefix)
        || !relative_path.ends_with(&suffix)
    {
        return None;
    }
    let token = &relative_path[prefix.len()..relative_path.len() - suffix.len()];
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let sample_index = token.parse::<usize>().ok()?;
    (token == format!("{sample_index:04}")).then_some(sample_index)
}

/// Parse exactly the nested path used by the native-input diagnostic producer:
/// `eigen/metadata/sample_NNNN/nonshared_source/<filename>`.
///
/// This is intentionally separate from `canonical_sample_scoped_index`:
/// historical three-sidecar files live directly below the sample directory,
/// while the final C ABI diagnostic pair is emitted below `nonshared_source`.
fn canonical_native_input_diagnostics_sample_scoped_index(
    relative_path: &str,
    filename: &str,
) -> Option<usize> {
    let prefix = "eigen/metadata/sample_";
    let suffix = format!("/nonshared_source/{filename}");
    if relative_path.contains('\\')
        || !relative_path.starts_with(prefix)
        || !relative_path.ends_with(&suffix)
    {
        return None;
    }
    let token = &relative_path[prefix.len()..relative_path.len() - suffix.len()];
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let sample_index = token.parse::<usize>().ok()?;
    (token == format!("{sample_index:04}")).then_some(sample_index)
}

fn is_sample_scoped_sidecar_candidate(relative_path: &str, filename: &str) -> bool {
    let prefix = "eigen/metadata/sample_";
    let suffix = format!("/{filename}");
    relative_path.starts_with(prefix) && relative_path.ends_with(&suffix)
}

fn r4_artifact_bytes<'a>(
    artifacts: &'a [AuxiliaryArtifact],
    relative_path: &str,
) -> Option<&'a [u8]> {
    artifacts
        .iter()
        .find(|artifact| artifact.relative_path == relative_path)
        .map(|artifact| artifact.bytes.as_slice())
}

#[derive(Debug, Clone)]
pub(crate) struct R4SidecarCoverage {
    pub(crate) status: String,
    pub(crate) reason: String,
    pub(crate) accepted_family: Option<String>,
    pub(crate) computed_sample_indices: BTreeSet<usize>,
    pub(crate) accepted_sample_indices: BTreeSet<usize>,
    pub(crate) identity_sample_indices: BTreeSet<usize>,
    pub(crate) missing_recomputed_keys: Vec<String>,
    pub(crate) identity_content_sha256_by_sample: BTreeMap<String, String>,
    pub(crate) paths_by_key: BTreeMap<String, Vec<String>>,
    pub(crate) has_any_sidecars: bool,
    pub(crate) structural_complete: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct NonSharedFloquetSidecarCoverage {
    pub(crate) status: String,
    pub(crate) reason: String,
    pub(crate) computed_sample_indices: BTreeSet<usize>,
    pub(crate) missing_keys: Vec<String>,
    pub(crate) paths_by_key: BTreeMap<String, Vec<String>>,
    pub(crate) has_any_sidecars: bool,
    pub(crate) structural_complete: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct NonSharedFloquetNativeInputDiagnosticsCoverage {
    pub(crate) status: String,
    pub(crate) reason: String,
    pub(crate) computed_sample_indices: BTreeSet<usize>,
    pub(crate) missing_keys: Vec<String>,
    pub(crate) paths_by_key: BTreeMap<String, Vec<String>>,
    pub(crate) has_any_sidecars: bool,
    pub(crate) structural_complete: bool,
}

impl NonSharedFloquetSidecarCoverage {
    pub(crate) fn manifest_value(&self) -> serde_json::Value {
        serde_json::json!({
            "status": self.status,
            "qualification": "NOT_VERIFIED",
            "reason": self.reason,
            "computed_sample_indices": self.computed_sample_indices.iter().copied().collect::<Vec<_>>(),
            "missing_keys": self.missing_keys,
            "structural_complete": self.structural_complete,
            "operator_replay": "NOT_VERIFIED",
            "scientific_qualification": "NOT_VERIFIED",
        })
    }
}

impl NonSharedFloquetNativeInputDiagnosticsCoverage {
    pub(crate) fn manifest_value(&self) -> serde_json::Value {
        serde_json::json!({
            "status": self.status,
            "qualification": "NOT_VERIFIED",
            "reason": self.reason,
            "computed_sample_indices": self.computed_sample_indices.iter().copied().collect::<Vec<_>>(),
            "missing_keys": self.missing_keys,
            "sidecar_paths_by_key": self.paths_by_key,
            "structural_complete": self.structural_complete,
            "native_operator_replay": "NOT_VERIFIED",
            "scientific_qualification": "NOT_VERIFIED",
        })
    }
}

impl R4SidecarCoverage {
    pub(crate) fn manifest_value(&self) -> serde_json::Value {
        serde_json::json!({
            "status": self.status,
            "qualification": "NOT_VERIFIED",
            "reason": self.reason,
            "accepted_family": self.accepted_family,
            "computed_sample_indices": self.computed_sample_indices.iter().copied().collect::<Vec<_>>(),
            "accepted_sample_indices": self.accepted_sample_indices.iter().copied().collect::<Vec<_>>(),
            "identity_sample_indices": self.identity_sample_indices.iter().copied().collect::<Vec<_>>(),
            "missing_recomputed_keys": self.missing_recomputed_keys,
            "identity_content_sha256_by_sample": self.identity_content_sha256_by_sample,
            "structural_complete": self.structural_complete,
            "payload_replay": "NOT_VERIFIED",
        })
    }
}

fn r4_sidecar_path_sets(
    artifacts: &[AuxiliaryArtifact],
) -> (
    BTreeMap<String, Vec<String>>,
    Vec<String>,
) {
    let mut paths_by_key = BTreeMap::new();
    let mut invalid_paths = Vec::new();
    for (key, filename, _) in R4_SIDECAR_DEFINITIONS {
        let mut paths = artifacts
            .iter()
            .filter_map(|artifact| {
                if is_sample_scoped_sidecar_candidate(&artifact.relative_path, filename)
                    && canonical_sample_scoped_index(&artifact.relative_path, filename).is_none()
                {
                    invalid_paths.push(artifact.relative_path.clone());
                    return None;
                }
                canonical_sample_scoped_index(&artifact.relative_path, filename)
                    .map(|_| artifact.relative_path.clone())
            })
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| {
            canonical_sample_scoped_index(path, filename).unwrap_or(usize::MAX)
        });
        paths.dedup();
        paths_by_key.insert(key.to_string(), paths);
    }
    invalid_paths.sort();
    invalid_paths.dedup();
    (paths_by_key, invalid_paths)
}

fn nonshared_floquet_sidecar_path_sets(
    artifacts: &[AuxiliaryArtifact],
) -> (
    BTreeMap<String, Vec<String>>,
    Vec<String>,
) {
    let mut paths_by_key = BTreeMap::new();
    let mut invalid_paths = Vec::new();
    for (key, filename, _) in NONSHARED_FLOQUET_SIDECAR_DEFINITIONS {
        let mut paths = artifacts
            .iter()
            .filter_map(|artifact| {
                if is_sample_scoped_sidecar_candidate(&artifact.relative_path, filename)
                    && canonical_sample_scoped_index(&artifact.relative_path, filename).is_none()
                {
                    invalid_paths.push(artifact.relative_path.clone());
                    return None;
                }
                canonical_sample_scoped_index(&artifact.relative_path, filename)
                    .map(|_| artifact.relative_path.clone())
            })
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| {
            canonical_sample_scoped_index(path, filename).unwrap_or(usize::MAX)
        });
        paths.dedup();
        paths_by_key.insert(key.to_string(), paths);
    }
    invalid_paths.sort();
    invalid_paths.dedup();
    (paths_by_key, invalid_paths)
}

fn nonshared_floquet_path_set(
    paths_by_key: &BTreeMap<String, Vec<String>>,
    key: &str,
) -> BTreeSet<usize> {
    let filename = NONSHARED_FLOQUET_SIDECAR_DEFINITIONS
        .iter()
        .find(|(candidate, _, _)| *candidate == key)
        .map(|(_, filename, _)| *filename);
    let Some(filename) = filename else {
        return BTreeSet::new();
    };
    paths_by_key
        .get(key)
        .into_iter()
        .flatten()
        .filter_map(|path| canonical_sample_scoped_index(path, filename))
        .collect()
}

fn nonshared_floquet_native_input_diagnostics_sidecar_path_sets(
    artifacts: &[AuxiliaryArtifact],
) -> (
    BTreeMap<String, Vec<String>>,
    Vec<String>,
) {
    let mut paths_by_key = BTreeMap::new();
    let mut invalid_paths = Vec::new();
    for (key, filename, _) in
        NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS
    {
        let mut paths = Vec::new();
        let mut seen_paths = BTreeSet::new();
        for artifact in artifacts {
            if !is_sample_scoped_sidecar_candidate(&artifact.relative_path, filename) {
                continue;
            }
            if canonical_native_input_diagnostics_sample_scoped_index(
                &artifact.relative_path,
                filename,
            )
            .is_none()
            {
                invalid_paths.push(artifact.relative_path.clone());
                continue;
            }
            if !seen_paths.insert(artifact.relative_path.clone()) {
                invalid_paths.push(format!(
                    "{} (duplicate non-shared Floquet native-input sidecar path)",
                    artifact.relative_path
                ));
                continue;
            }
            paths.push(artifact.relative_path.clone());
        }
        paths.sort_by_key(|path| {
            canonical_native_input_diagnostics_sample_scoped_index(path, filename)
                .unwrap_or(usize::MAX)
        });
        paths_by_key.insert(key.to_string(), paths);
    }
    invalid_paths.sort();
    invalid_paths.dedup();
    (paths_by_key, invalid_paths)
}

fn nonshared_floquet_native_input_diagnostics_path_set(
    paths_by_key: &BTreeMap<String, Vec<String>>,
    key: &str,
) -> BTreeSet<usize> {
    let filename = NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS
        .iter()
        .find(|(candidate, _, _)| *candidate == key)
        .map(|(_, filename, _)| *filename);
    let Some(filename) = filename else {
        return BTreeSet::new();
    };
    paths_by_key
        .get(key)
        .into_iter()
        .flatten()
        .filter_map(|path| {
            canonical_native_input_diagnostics_sample_scoped_index(path, filename)
        })
        .collect()
}

/// Discover non-shared Floquet sidecars and require a complete per-sample
/// path set.  This is deliberately structural only: it does not parse or
/// certify the operator, source state, or physical preimages.
pub(crate) fn inspect_nonshared_floquet_sidecars(
    artifacts: &[AuxiliaryArtifact],
    computed_sample_indices: &[usize],
) -> NonSharedFloquetSidecarCoverage {
    let computed_sample_count = computed_sample_indices.len();
    let computed_sample_indices = computed_sample_indices.iter().copied().collect::<BTreeSet<_>>();
    let (paths_by_key, invalid_paths) = nonshared_floquet_sidecar_path_sets(artifacts);
    let has_any_sidecars = paths_by_key.values().any(|paths| !paths.is_empty())
        || !invalid_paths.is_empty();
    let empty = || NonSharedFloquetSidecarCoverage {
        status: "historical".to_string(),
        reason: "non-shared Floquet sidecars are absent from this manifest".to_string(),
        computed_sample_indices: computed_sample_indices.clone(),
        missing_keys: Vec::new(),
        paths_by_key: paths_by_key.clone(),
        has_any_sidecars,
        structural_complete: false,
    };
    if !has_any_sidecars {
        return empty();
    }
    if computed_sample_indices.len() != computed_sample_count {
        return NonSharedFloquetSidecarCoverage {
            status: "invalid".to_string(),
            reason: "computed path samples contain duplicate sample_index values".to_string(),
            ..empty()
        };
    }
    if !invalid_paths.is_empty() {
        return NonSharedFloquetSidecarCoverage {
            status: "invalid".to_string(),
            reason: format!(
                "non-canonical non-shared Floquet sidecar paths: {}",
                invalid_paths.join(", ")
            ),
            ..empty()
        };
    }

    let mut missing_keys = Vec::new();
    for (key, _, _) in NONSHARED_FLOQUET_SIDECAR_DEFINITIONS {
        let samples = nonshared_floquet_path_set(&paths_by_key, key);
        if !samples.is_subset(&computed_sample_indices) {
            return NonSharedFloquetSidecarCoverage {
                status: "invalid".to_string(),
                reason: format!(
                    "non-shared Floquet sidecar {key} contains samples outside computed samples"
                ),
                ..empty()
            };
        }
        if samples != computed_sample_indices {
            missing_keys.push(key.to_string());
        }
    }
    if !missing_keys.is_empty() {
        return NonSharedFloquetSidecarCoverage {
            status: "missing_sidecars".to_string(),
            reason: format!(
                "non-shared Floquet sidecar arrays do not cover every computed sample: {}",
                missing_keys.join(", ")
            ),
            missing_keys,
            ..empty()
        };
    }
    NonSharedFloquetSidecarCoverage {
        status: "path_coverage_complete".to_string(),
        reason: "non-shared Floquet sidecar paths cover every computed sample; operator replay remains separate".to_string(),
        computed_sample_indices,
        missing_keys,
        paths_by_key,
        has_any_sidecars,
        structural_complete: true,
    }
}

/// Discover only the two final native-input diagnostic sidecars.  This gate
/// is deliberately independent from the historical three-sidecar coverage:
/// old bundles keep their old status and aliases, while a new partial pair is
/// visible as a structural gap without becoming native or scientific proof.
pub(crate) fn inspect_nonshared_floquet_native_input_diagnostics_sidecars(
    artifacts: &[AuxiliaryArtifact],
    computed_sample_indices: &[usize],
) -> NonSharedFloquetNativeInputDiagnosticsCoverage {
    let computed_sample_count = computed_sample_indices.len();
    let computed_sample_indices = computed_sample_indices.iter().copied().collect::<BTreeSet<_>>();
    let (paths_by_key, invalid_paths) =
        nonshared_floquet_native_input_diagnostics_sidecar_path_sets(artifacts);
    let has_any_sidecars = paths_by_key.values().any(|paths| !paths.is_empty())
        || !invalid_paths.is_empty();
    let empty = || NonSharedFloquetNativeInputDiagnosticsCoverage {
        status: "historical".to_string(),
        reason: "native-input diagnostic sidecars are absent from this manifest".to_string(),
        computed_sample_indices: computed_sample_indices.clone(),
        missing_keys: Vec::new(),
        paths_by_key: paths_by_key.clone(),
        has_any_sidecars,
        structural_complete: false,
    };
    if !has_any_sidecars {
        return empty();
    }
    if computed_sample_indices.len() != computed_sample_count {
        return NonSharedFloquetNativeInputDiagnosticsCoverage {
            status: "invalid".to_string(),
            reason: "computed path samples contain duplicate sample_index values".to_string(),
            ..empty()
        };
    }
    if !invalid_paths.is_empty() {
        return NonSharedFloquetNativeInputDiagnosticsCoverage {
            status: "invalid".to_string(),
            reason: format!(
                "non-canonical or duplicate native-input diagnostic sidecar paths: {}",
                invalid_paths.join(", ")
            ),
            ..empty()
        };
    }

    let mut missing_keys = Vec::new();
    for (key, _, _) in NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS {
        let samples = nonshared_floquet_native_input_diagnostics_path_set(&paths_by_key, key);
        if !samples.is_subset(&computed_sample_indices) {
            return NonSharedFloquetNativeInputDiagnosticsCoverage {
                status: "invalid".to_string(),
                reason: format!(
                    "native-input diagnostic sidecar {key} contains samples outside computed samples"
                ),
                ..empty()
            };
        }
        if samples != computed_sample_indices {
            missing_keys.push(key.to_string());
        }
    }
    if !missing_keys.is_empty() {
        return NonSharedFloquetNativeInputDiagnosticsCoverage {
            status: "missing_sidecars".to_string(),
            reason: format!(
                "native-input diagnostic sidecar arrays do not cover every computed sample: {}",
                missing_keys.join(", ")
            ),
            missing_keys,
            ..empty()
        };
    }
    NonSharedFloquetNativeInputDiagnosticsCoverage {
        status: "path_coverage_complete".to_string(),
        reason: "native-input diagnostic sidecar paths cover every computed sample; native replay remains separate".to_string(),
        computed_sample_indices,
        missing_keys,
        paths_by_key,
        has_any_sidecars,
        structural_complete: true,
    }
}

fn r4_path_set(paths_by_key: &BTreeMap<String, Vec<String>>, key: &str) -> BTreeSet<usize> {
    let filename = R4_SIDECAR_DEFINITIONS
        .iter()
        .find(|(candidate, _, _)| *candidate == key)
        .map(|(_, filename, _)| *filename);
    let Some(filename) = filename else {
        return BTreeSet::new();
    };
    paths_by_key
        .get(key)
        .into_iter()
        .flatten()
        .filter_map(|path| canonical_sample_scoped_index(path, filename))
        .collect()
}

fn validate_consumer_plan_snapshot(
    identity: &super::eigen_equilibrium_contract::LinearizationIdentityV2,
    artifacts: &[AuxiliaryArtifact],
) -> Result<(), String> {
    let path = super::eigen_equilibrium_contract::consumer_plan_snapshot_relative_path(
        identity.sample_index,
    );
    let Some(bytes) = r4_artifact_bytes(artifacts, &path) else {
        return Err(format!("consumer plan snapshot sidecar is missing: {path}"));
    };
    let actual_digest = format!("sha256:{:x}", Sha256::digest(bytes));
    if actual_digest != identity.consumer_plan_snapshot_sha256 {
        return Err(format!(
            "consumer plan snapshot digest does not match identity for sample {}",
            identity.sample_index
        ));
    }
    serde_json::from_slice::<FemEigenPlanIR>(bytes)
        .map_err(|error| format!("consumer plan snapshot JSON is invalid: {error}"))?;
    // Do not serialize `plan` again here.  `FemEigenPlanIR` contains map-like
    // values whose iteration order is not a consumer-side proof of the
    // producer bytes.  The raw SHA above is the exact-byte binding; parsing
    // only proves that the bound bytes are a valid plan payload.
    Ok(())
}

fn validate_r4_identity_links(
    identity: &super::eigen_equilibrium_contract::LinearizationIdentityV2,
    artifacts: &[AuxiliaryArtifact],
    accepted_family: &str,
    allow_missing_recomputed: bool,
    allow_unscoped_state_paths: bool,
) -> Result<(), String> {
    let sample_index = identity.sample_index;
    let equilibrium_name = if accepted_family == "v1" {
        "equilibrium_artifact.v7.json"
    } else {
        "equilibrium_artifact.v8.json"
    };
    let state_name = if accepted_family == "v1" {
        "linearization_state.v6.json"
    } else {
        "linearization_state.v7.json"
    };
    let fields_version = accepted_family;
    let expected = [
        (
            "equilibrium_artifact_path",
            format!("eigen/metadata/sample_{sample_index:04}/{equilibrium_name}"),
            identity.equilibrium_artifact_path.as_str(),
            None,
            false,
        ),
        (
            "linearization_state_path",
            format!("eigen/metadata/sample_{sample_index:04}/{state_name}"),
            identity.linearization_state_path.as_str(),
            None,
            false,
        ),
        (
            "accepted_fields_path",
            format!(
                "eigen/metadata/sample_{sample_index:04}/accepted_fem_equilibrium_fields.{fields_version}.json"
            ),
            identity.accepted_fields_path.as_str(),
            Some(identity.accepted_fields_bytes_sha256.as_str()),
            false,
        ),
        (
            "certified_fields_path",
            format!(
                "eigen/metadata/sample_{sample_index:04}/certified_fem_equilibrium_fields.{fields_version}.json"
            ),
            identity.certified_fields_path.as_str(),
            Some(identity.certified_fields_bytes_sha256.as_str()),
            true,
        ),
        (
            "recomputed_certificate_path",
            format!(
                "eigen/metadata/sample_{sample_index:04}/recomputed_fem_linearization_certificate.{fields_version}.json"
            ),
            identity.recomputed_certificate_path.as_str(),
            Some(identity.recomputed_certificate_bytes_sha256.as_str()),
            true,
        ),
    ];
    for (field, expected_path, actual_path, raw_digest, recomputed_payload) in expected {
        let root_state_path = if allow_unscoped_state_paths
            && matches!(field, "equilibrium_artifact_path" | "linearization_state_path")
        {
            Some(format!(
                "eigen/metadata/{}",
                expected_path.rsplit('/').next().unwrap_or_default()
            ))
        } else {
            None
        };
        let path_matches = actual_path == expected_path
            || root_state_path.as_deref().is_some_and(|root| actual_path == root);
        if !path_matches {
            return Err(format!("{field} does not match canonical sample path"));
        }
        let Some(bytes) = r4_artifact_bytes(artifacts, actual_path) else {
            if recomputed_payload && allow_missing_recomputed {
                continue;
            }
            return Err(format!("{field} points to a missing sidecar"));
        };
        if let Some(expected_digest) = raw_digest {
            let actual_digest = format!("sha256:{:x}", Sha256::digest(bytes));
            if actual_digest != expected_digest {
                return Err(format!("{field} raw byte digest does not match identity"));
            }
        }

        let value = serde_json::from_slice::<serde_json::Value>(bytes)
            .map_err(|error| format!("{field} JSON is invalid: {error}"))?;
        let expected_schema = match field {
            "accepted_fields_path" | "certified_fields_path" => {
                format!("CertifiedFemEquilibriumFields.{fields_version}")
            }
            "recomputed_certificate_path" => {
                format!("RecomputedFemLinearizationCertificate.{fields_version}")
            }
            _ => String::new(),
        };
        if !expected_schema.is_empty()
            && value.get("schema_version").and_then(serde_json::Value::as_str)
                != Some(expected_schema.as_str())
        {
            return Err(format!("{field} schema does not match identity family"));
        }
        match field {
            "equilibrium_artifact_path" | "linearization_state_path" => {
                let content = value
                    .get("content_sha256")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| format!("{field} is missing content_sha256"))?;
                let expected_content = if field == "equilibrium_artifact_path" {
                    &identity.equilibrium_artifact_sha256
                } else {
                    &identity.linearization_state_sha256
                };
                if content != expected_content {
                    return Err(format!("{field} content digest does not match identity"));
                }
            }
            "accepted_fields_path" => {
                let content = value
                    .get("content_sha256")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| format!("{field} is missing content_sha256"))?;
                if content != identity.accepted_fields_content_sha256 {
                    return Err(format!("{field} content digest does not match identity"));
                }
            }
            "certified_fields_path" => {
                let content = value
                    .get("content_sha256")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| format!("{field} is missing content_sha256"))?;
                if content != identity.certified_fields_content_sha256 {
                    return Err(format!("{field} content digest does not match identity"));
                }
            }
            "recomputed_certificate_path" => {
                let certificate = serde_json::from_slice::<
                    crate::types::RecomputedFemLinearizationCertificateV1,
                >(bytes)
                .map_err(|error| format!("{field} typed payload is invalid: {error}"))?;
                if certificate.content_sha256 != identity.recomputed_certificate_content_sha256
                {
                    return Err(format!("{field} content digest does not match identity"));
                }
                let preimage_sha =
                    crate::types::recomputed_fem_linearization_certificate_preimage_sha256(
                        &certificate,
                    )
                    .map_err(|error| error.message)?;
                if preimage_sha != identity.recomputed_certificate_preimage_sha256 {
                    return Err(format!(
                        "{field} exact preimage digest does not match identity"
                    ));
                }
                let preimage = crate::types::recomputed_fem_linearization_certificate_preimage_bytes(
                    &certificate,
                )
                .map_err(|error| error.message)?;
                let preimage_text = String::from_utf8(preimage)
                    .map_err(|error| format!("{field} exact preimage is not UTF-8: {error}"))?;
                if preimage_text != identity.recomputed_certificate_preimage_json {
                    return Err(format!("{field} exact preimage does not match identity"));
                }
            }
            _ => {}
        }
    }
    let expected_accepted_schema = format!("CertifiedFemEquilibriumFields.{fields_version}");
    let expected_recomputed_schema =
        format!("RecomputedFemLinearizationCertificate.{fields_version}");
    if identity.accepted_fields_schema != expected_accepted_schema
        || identity.certified_fields_schema != expected_accepted_schema
        || identity.recomputed_certificate_schema != expected_recomputed_schema
    {
        return Err("identity schema family does not match accepted sidecars".to_string());
    }
    Ok(())
}

/// Inspect the actual sidecar bytes and paths used by a single-k or path
/// producer.  This is a structural gate only: a complete family still reports
/// `payload_replay_pending` because physical field replay is a separate gate.
pub(crate) fn inspect_r4_sidecars(
    artifacts: &[AuxiliaryArtifact],
    computed_sample_indices: &[usize],
) -> R4SidecarCoverage {
    let computed_sample_count = computed_sample_indices.len();
    let computed_sample_indices = computed_sample_indices.iter().copied().collect::<BTreeSet<_>>();
    let (paths_by_key, invalid_paths) = r4_sidecar_path_sets(artifacts);
    let has_any_sidecars = paths_by_key.values().any(|paths| !paths.is_empty())
        || !invalid_paths.is_empty();
    let empty = || R4SidecarCoverage {
        status: "historical".to_string(),
        reason: "R4 sidecar arrays are absent from this manifest".to_string(),
        accepted_family: None,
        computed_sample_indices: computed_sample_indices.clone(),
        accepted_sample_indices: BTreeSet::new(),
        identity_sample_indices: BTreeSet::new(),
        missing_recomputed_keys: Vec::new(),
        identity_content_sha256_by_sample: BTreeMap::new(),
        paths_by_key: paths_by_key.clone(),
        has_any_sidecars,
        structural_complete: false,
    };
    if !has_any_sidecars {
        return empty();
    }
    if computed_sample_indices.len() != computed_sample_count {
        return R4SidecarCoverage {
            status: "invalid".to_string(),
            reason: "computed path samples contain duplicate sample_index values".to_string(),
            ..empty()
        };
    }
    if !invalid_paths.is_empty() {
        return R4SidecarCoverage {
            status: "invalid".to_string(),
            reason: format!(
                "non-canonical R4 sidecar paths: {}",
                invalid_paths.join(", ")
            ),
            ..empty()
        };
    }
    let accepted_v1 = r4_path_set(&paths_by_key, "accepted_fem_equilibrium_fields_v1_paths");
    let accepted_v2 = r4_path_set(&paths_by_key, "accepted_fem_equilibrium_fields_v2_paths");
    let (accepted_family, accepted_sample_indices) = match (accepted_v1.is_empty(), accepted_v2.is_empty()) {
        (false, false) => {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: "R4 accepted sidecars mix v1 and v2 families".to_string(),
                ..empty()
            };
        }
        (false, true) => ("v1", accepted_v1),
        (true, false) => ("v2", accepted_v2),
        (true, true) => {
            return R4SidecarCoverage {
                status: "missing_accepted".to_string(),
                reason: "R4 identity/certified/recomputed sidecars require accepted fields".to_string(),
                ..empty()
            };
        }
    };
    if accepted_sample_indices != computed_sample_indices {
        return R4SidecarCoverage {
            status: "invalid".to_string(),
            reason: "accepted R4 sample index set does not match computed samples".to_string(),
            accepted_family: Some(accepted_family.to_string()),
            accepted_sample_indices,
            ..empty()
        };
    }
    let identity_samples = r4_path_set(&paths_by_key, "linearization_identity_v2_paths");
    let preimage_samples = r4_path_set(&paths_by_key, "linearization_identity_preimage_v1_paths");
    if !identity_samples.is_empty() && identity_samples != accepted_sample_indices {
        return R4SidecarCoverage {
            status: "invalid".to_string(),
            reason: "identity and accepted R4 sample index sets differ".to_string(),
            accepted_family: Some(accepted_family.to_string()),
            accepted_sample_indices,
            identity_sample_indices: identity_samples,
            ..empty()
        };
    }
    if !preimage_samples.is_empty() && preimage_samples != identity_samples {
        return R4SidecarCoverage {
            status: "invalid".to_string(),
            reason: "identity preimage and identity sample index sets differ".to_string(),
            accepted_family: Some(accepted_family.to_string()),
            accepted_sample_indices,
            identity_sample_indices: identity_samples,
            ..empty()
        };
    }
    if identity_samples.is_empty() || preimage_samples.is_empty() {
        return R4SidecarCoverage {
            status: "missing_identity".to_string(),
            reason: "R4 identity and exact preimage sidecars are incomplete; replay is not verified".to_string(),
            accepted_family: Some(accepted_family.to_string()),
            accepted_sample_indices,
            identity_sample_indices: identity_samples,
            ..empty()
        };
    }
    let required_new = if accepted_family == "v1" {
        [
            "certified_fem_equilibrium_fields_v1_paths",
            "recomputed_fem_linearization_certificate_v1_paths",
        ]
    } else {
        [
            "certified_fem_equilibrium_fields_v2_paths",
            "recomputed_fem_linearization_certificate_v2_paths",
        ]
    };
    let opposite_new = if accepted_family == "v1" {
        [
            "certified_fem_equilibrium_fields_v2_paths",
            "recomputed_fem_linearization_certificate_v2_paths",
        ]
    } else {
        [
            "certified_fem_equilibrium_fields_v1_paths",
            "recomputed_fem_linearization_certificate_v1_paths",
        ]
    };
    if opposite_new
        .iter()
        .any(|key| !r4_path_set(&paths_by_key, key).is_empty())
    {
        return R4SidecarCoverage {
            status: "invalid".to_string(),
            reason: "R4 certified/recomputed sidecar families are mixed".to_string(),
            accepted_family: Some(accepted_family.to_string()),
            accepted_sample_indices,
            identity_sample_indices: identity_samples,
            ..empty()
        };
    }
    let mut missing_recomputed_keys = Vec::new();
    for key in required_new {
        let sample_indices = r4_path_set(&paths_by_key, key);
        if sample_indices == accepted_sample_indices {
            continue;
        }
        if !sample_indices.is_subset(&accepted_sample_indices) {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!(
                    "R4 certified/recomputed sidecar {key} contains samples outside accepted fields"
                ),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
        missing_recomputed_keys.push(key.to_string());
    }
    let allow_missing_recomputed = !missing_recomputed_keys.is_empty();
    if !allow_missing_recomputed {
        let consumer_plan_samples =
            r4_path_set(&paths_by_key, "consumer_plan_snapshot_v1_paths");
        if !consumer_plan_samples.is_subset(&accepted_sample_indices) {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: "consumer plan snapshot samples are outside the computed R4 samples"
                    .to_string(),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
        if consumer_plan_samples != computed_sample_indices {
            return R4SidecarCoverage {
                status: "missing_consumer_plan_snapshot".to_string(),
                reason:
                    "consumer_plan_snapshot.v1.json must be present for every computed sample"
                        .to_string(),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
    }

    let mut identity_content_sha256_by_sample = BTreeMap::new();
    for sample_index in &identity_samples {
        let identity_path = format!(
            "eigen/metadata/sample_{sample_index:04}/linearization_identity.v2.json"
        );
        let preimage_path = format!(
            "eigen/metadata/sample_{sample_index:04}/linearization_identity_preimage.v1.json"
        );
        let Some(identity_bytes) = r4_artifact_bytes(artifacts, &identity_path) else {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!("missing identity sidecar {identity_path}"),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        };
        let Some(preimage_bytes) = r4_artifact_bytes(artifacts, &preimage_path) else {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!("missing identity preimage sidecar {preimage_path}"),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        };
        let identity = match serde_json::from_slice::<
            super::eigen_equilibrium_contract::LinearizationIdentityV2,
        >(identity_bytes) {
            Ok(identity) => identity,
            Err(error) => {
                return R4SidecarCoverage {
                    status: "invalid".to_string(),
                    reason: format!("identity sidecar {identity_path} is invalid: {error}"),
                    accepted_family: Some(accepted_family.to_string()),
                    accepted_sample_indices,
                    identity_sample_indices: identity_samples,
                    ..empty()
                };
            }
        };
        if identity.sample_index != *sample_index {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!("identity {identity_path} has the wrong sample_index"),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
        if let Err(error) = super::eigen_equilibrium_contract::
            validate_linearization_identity_source_snapshots(&identity)
        {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!(
                    "identity source snapshot validation failed for sample {sample_index}: {}",
                    error.message
                ),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
        let sidecar = match serde_json::from_slice::<
            super::eigen_equilibrium_contract::LinearizationIdentityPreimageV1,
        >(preimage_bytes) {
            Ok(sidecar) => sidecar,
            Err(error) => {
                return R4SidecarCoverage {
                    status: "invalid".to_string(),
                    reason: format!("identity preimage {preimage_path} is invalid: {error}"),
                    accepted_family: Some(accepted_family.to_string()),
                    accepted_sample_indices,
                    identity_sample_indices: identity_samples,
                    ..empty()
                };
            }
        };
        let preimage = sidecar.identity_preimage_json.as_bytes();
        let mut expected_preimage_identity = identity.clone();
        expected_preimage_identity.content_sha256.clear();
        let preimage_identity = serde_json::from_slice::<
            super::eigen_equilibrium_contract::LinearizationIdentityV2,
        >(preimage);
        let valid_preimage = sidecar.schema_version
            == super::eigen_equilibrium_contract::LINEARIZATION_IDENTITY_PREIMAGE_V1
            && sidecar.identity_schema
                == super::eigen_equilibrium_contract::LINEARIZATION_IDENTITY_V2
            && sidecar.identity_content_sha256 == identity.content_sha256
            && sidecar.identity_preimage_sha256
                == format!("sha256:{:x}", Sha256::digest(preimage))
            && preimage_identity.as_ref().is_ok_and(|value| value == &expected_preimage_identity)
            && super::eigen_equilibrium_contract::linearization_identity_v2_content_sha256_from_preimage_bytes(
                preimage,
            ) == identity.content_sha256;
        if !valid_preimage {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!("identity/preimage exact-byte link failed for sample {sample_index}"),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
        if let Err(reason) = validate_r4_identity_links(
            &identity,
            artifacts,
            accepted_family,
            allow_missing_recomputed,
            computed_sample_indices.len() == 1,
        ) {
            return R4SidecarCoverage {
                status: "invalid".to_string(),
                reason: format!("identity own-link check failed for sample {sample_index}: {reason}"),
                accepted_family: Some(accepted_family.to_string()),
                accepted_sample_indices,
                identity_sample_indices: identity_samples,
                ..empty()
            };
        }
        if !allow_missing_recomputed {
            if let Err(reason) = validate_consumer_plan_snapshot(&identity, artifacts) {
                return R4SidecarCoverage {
                    status: "invalid".to_string(),
                    reason: format!(
                        "consumer plan snapshot check failed for sample {sample_index}: {reason}"
                    ),
                    accepted_family: Some(accepted_family.to_string()),
                    accepted_sample_indices,
                    identity_sample_indices: identity_samples,
                    ..empty()
                };
            }
        }
        identity_content_sha256_by_sample.insert(sample_index.to_string(), identity.content_sha256);
    }
    if allow_missing_recomputed {
        return R4SidecarCoverage {
            status: "missing_recomputed".to_string(),
            reason: format!(
                "R4 certified/recomputed sidecar arrays are missing or incomplete: {}",
                missing_recomputed_keys.join(", ")
            ),
            accepted_family: Some(accepted_family.to_string()),
            computed_sample_indices,
            accepted_sample_indices,
            identity_sample_indices: identity_samples,
            missing_recomputed_keys,
            identity_content_sha256_by_sample,
            paths_by_key,
            has_any_sidecars,
            structural_complete: false,
        };
    }
    R4SidecarCoverage {
        status: "payload_replay_pending".to_string(),
        reason: "R4 sidecar paths and exact identity links are structurally consistent; physical payload replay remains a separate gate".to_string(),
        accepted_family: Some(accepted_family.to_string()),
        computed_sample_indices,
        accepted_sample_indices,
        identity_sample_indices: identity_samples,
        missing_recomputed_keys: Vec::new(),
        identity_content_sha256_by_sample,
        paths_by_key,
        has_any_sidecars,
        structural_complete: true,
    }
}

pub(crate) fn sample_scoped_signed_sidecar_paths(
    artifacts: &[AuxiliaryArtifact],
    filename: &str,
) -> Vec<String> {
    let mut paths = artifacts
        .iter()
        .filter_map(|artifact| {
            canonical_sample_scoped_index(&artifact.relative_path, filename)
                .map(|_| artifact.relative_path.to_string())
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| {
        canonical_sample_scoped_index(path, filename).unwrap_or(usize::MAX)
    });
    paths.dedup();
    paths
}

/// Return the immutable producer provenance sidecars in numeric sample order.
/// The returned strings are the producer-published paths; this helper only
/// selects and orders them and never rewrites their spelling or payload.
pub(crate) fn sample_scoped_producer_provenance_paths(
    artifacts: &[AuxiliaryArtifact],
) -> Vec<String> {
    sample_scoped_signed_sidecar_paths(artifacts, "producer_provenance.v1.json")
}

pub(super) fn published_artifact_sha256(
    artifacts: &[AuxiliaryArtifact],
    relative_path: &str,
) -> Result<String, RunError> {
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == relative_path)
        .ok_or_else(|| RunError {
            message: format!(
                "missing published artifact required for content digest: {relative_path}"
            ),
        })?;
    Ok(format!("sha256:{:x}", Sha256::digest(&artifact.bytes)))
}

fn validate_published_linearization_identity_sidecars(
    summary_payload: &serde_json::Value,
    auxiliary_artifacts: &[AuxiliaryArtifact],
    sample_index: usize,
) -> Result<Option<(String, String)>, RunError> {
    let Some(diagnostics) = summary_payload
        .get("solver_diagnostics")
        .and_then(serde_json::Value::as_object)
    else {
        return Ok(None);
    };
    let Some(identity_digest_value) = diagnostics.get("linearization_identity_sha256") else {
        return Ok(None);
    };
    let identity_digest = identity_digest_value.as_str().ok_or_else(|| RunError {
        message: "linearization_identity_sha256_must_be_string".to_string(),
    })?;
    let identity_path = format!(
        "eigen/metadata/sample_{sample_index:04}/linearization_identity.v2.json"
    );
    let preimage_path = format!(
        "eigen/metadata/sample_{sample_index:04}/linearization_identity_preimage.v1.json"
    );
    let identity_artifact = auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == identity_path)
        .ok_or_else(|| RunError {
            message: format!(
                "linearization_identity_v2_artifact_missing_for_published_digest: {identity_path}"
            ),
        })?;
    let identity = serde_json::from_slice::<
        super::eigen_equilibrium_contract::LinearizationIdentityV2,
    >(&identity_artifact.bytes)
    .map_err(|error| RunError {
        message: format!("linearization_identity_v2_artifact_invalid: {error}"),
    })?;
    if identity.sample_index != sample_index {
        return Err(RunError {
            message: format!(
                "linearization_identity_v2_sample_index_mismatch: expected {sample_index}, got {}",
                identity.sample_index
            ),
        });
    }
    super::eigen_equilibrium_contract::validate_linearization_identity_source_snapshots(&identity)?;
    if identity.content_sha256 != identity_digest {
        return Err(RunError {
            message: "linearization_identity_sha256_does_not_match_published_identity".to_string(),
        });
    }
    let preimage_artifact = auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == preimage_path)
        .ok_or_else(|| RunError {
            message: format!(
                "linearization_identity_preimage_v1_artifact_missing: {preimage_path}"
            ),
        })?;
    let sidecar = serde_json::from_slice::<
        super::eigen_equilibrium_contract::LinearizationIdentityPreimageV1,
    >(&preimage_artifact.bytes)
    .map_err(|error| RunError {
        message: format!("linearization_identity_preimage_v1_artifact_invalid: {error}"),
    })?;
    if sidecar.schema_version
        != super::eigen_equilibrium_contract::LINEARIZATION_IDENTITY_PREIMAGE_V1
        || sidecar.identity_schema != super::eigen_equilibrium_contract::LINEARIZATION_IDENTITY_V2
    {
        return Err(RunError {
            message: "linearization_identity_preimage_v1_schema_mismatch".to_string(),
        });
    }
    if sidecar.identity_content_sha256 != identity_digest {
        return Err(RunError {
            message: "linearization_identity_preimage_v1_identity_digest_mismatch".to_string(),
        });
    }
    let preimage_bytes = sidecar.identity_preimage_json.as_bytes();
    let preimage_bytes_sha256 = format!("sha256:{:x}", Sha256::digest(preimage_bytes));
    if sidecar.identity_preimage_sha256 != preimage_bytes_sha256 {
        return Err(RunError {
            message: "linearization_identity_preimage_v1_bytes_digest_mismatch".to_string(),
        });
    }
    let preimage_identity = serde_json::from_slice::<
        super::eigen_equilibrium_contract::LinearizationIdentityV2,
    >(preimage_bytes)
    .map_err(|error| RunError {
        message: format!("linearization_identity_v2_preimage_json_invalid: {error}"),
    })?;
    let mut expected_preimage = identity.clone();
    expected_preimage.content_sha256.clear();
    if preimage_identity != expected_preimage {
        return Err(RunError {
            message: "linearization_identity_v2_preimage_value_mismatch".to_string(),
        });
    }
    let recomputed_identity_digest =
        super::eigen_equilibrium_contract::linearization_identity_v2_content_sha256_from_preimage_bytes(
            preimage_bytes,
        );
    if recomputed_identity_digest != identity_digest {
        return Err(RunError {
            message: "linearization_identity_v2_framed_digest_mismatch".to_string(),
        });
    }
    Ok(Some((identity_path, preimage_path)))
}

pub(super) fn mode_field_id(sample_index: usize, raw_mode_index: u64) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

pub(super) fn mode_field_resource_key(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
        mode_field_id(sample_index, raw_mode_index)
    )
}

pub(super) fn modal_sample_id(plan: &FemEigenPlanIR, sample_index: usize) -> String {
    let prefix = if !plan.bias_field_samples.is_empty() {
        "bias-field-sample"
    } else {
        match plan.k_sampling {
            Some(KSamplingIR::Path { .. }) => "k-path-sample",
            Some(KSamplingIR::Single { .. }) | None => "k-sample",
        }
    };
    format!("{prefix}-{sample_index:04}")
}

fn mode_meta_resource_key(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{raw_mode_index}/meta"
    )
}

pub(super) fn mode_metadata_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/modes/sample_{sample_index:04}/mode_{raw_mode_index:04}.json")
}

fn mode_payload_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/vector.bin")
}

pub(super) fn floquet_potential_payload_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/potential_real_split.bin"
    )
}

/// Serialize the native Floquet potential descriptor in its published
/// doubled real-split complex coefficient layout.  Each coefficient is one
/// little-endian `(real, imag)` pair; this is a coefficient payload rather
/// than a Cartesian mesh field.
pub(super) fn floquet_potential_payload_bytes(values: &[Complex64]) -> Result<Vec<u8>, RunError> {
    if values.is_empty() || values.len() % 2 != 0 {
        return Err(RunError {
            message: format!(
                "native Floquet potential payload requires a non-empty even coefficient count, got {}",
                values.len()
            ),
        });
    }
    let mut bytes = Vec::with_capacity(values.len() * 2 * std::mem::size_of::<f64>());
    for (index, value) in values.iter().enumerate() {
        if !value.re.is_finite() || !value.im.is_finite() {
            return Err(RunError {
                message: format!(
                    "native Floquet potential payload contains a non-finite coefficient at index {index}"
                ),
            });
        }
        bytes.extend_from_slice(&value.re.to_le_bytes());
        bytes.extend_from_slice(&value.im.to_le_bytes());
    }
    Ok(bytes)
}

fn mode_zarr_store_path() -> &'static str {
    "eigen/mode_fields.zarr"
}

fn mode_zarr_sample_group_path(sample_index: usize) -> String {
    format!("eigen/mode_fields.zarr/sample_{sample_index:04}")
}

fn mode_zarr_mode_group_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/mode_fields.zarr/sample_{sample_index:04}/mode_{raw_mode_index:04}")
}

fn mode_zarr_array_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "{}/vector_xyz_complex",
        mode_zarr_mode_group_path(sample_index, raw_mode_index)
    )
}

fn mode_zarr_chunk_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "{}/0.0.0",
        mode_zarr_array_path(sample_index, raw_mode_index)
    )
}

pub(super) fn mode_vector_entries(
    value: &serde_json::Value,
    field: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    let entries = value
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: format!("requested mode field payload is missing {field}"),
        })?;
    if entries.is_empty() {
        return Err(RunError {
            message: format!("requested mode field payload {field} must not be empty"),
        });
    }
    entries
        .iter()
        .enumerate()
        .map(|(entry_index, entry)| {
            let components = entry.as_array().ok_or_else(|| RunError {
                message: format!(
                    "requested mode field payload {field}[{entry_index}] must be a Cartesian XYZ array"
                ),
            })?;
            if components.len() != 3 {
                return Err(RunError {
                    message: format!(
                        "requested mode field payload {field}[{entry_index}] must contain exactly three Cartesian components"
                    ),
                });
            }
            let mut vector = [0.0; 3];
            for (component_index, component) in components.iter().enumerate() {
                let numeric = component.as_f64().filter(|numeric| numeric.is_finite()).ok_or_else(|| {
                    RunError {
                        message: format!(
                            "requested mode field payload {field}[{entry_index}][{component_index}] must be finite"
                        ),
                    }
                })?;
                vector[component_index] = numeric;
            }
            Ok(vector)
        })
        .collect()
}

fn mode_payload_bytes(real: &[[f64; 3]], imag: &[[f64; 3]]) -> Result<Vec<u8>, RunError> {
    if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
        return Err(RunError {
            message: format!(
                "requested mode field payload requires equal non-empty real/imag XYZ samples: real={}, imag={}",
                real.len(),
                imag.len()
            ),
        });
    }
    let sample_count = real.len();
    let mut bytes = Vec::with_capacity(sample_count * 6 * std::mem::size_of::<f64>());
    for (index, (real_sample, imag_sample)) in real.iter().zip(imag.iter()).enumerate() {
        for component in 0..3 {
            if !real_sample[component].is_finite() || !imag_sample[component].is_finite() {
                return Err(RunError {
                    message: format!(
                        "requested mode field payload contains non-finite Cartesian component at sample {index}, component {component}"
                    ),
                });
            }
            bytes.extend_from_slice(&real_sample[component].to_le_bytes());
            bytes.extend_from_slice(&imag_sample[component].to_le_bytes());
        }
    }
    Ok(bytes)
}

fn mode_amplitude_summary(amplitude: &serde_json::Value, sample_count: usize) -> serde_json::Value {
    let values: Vec<f64> = amplitude
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_f64()).collect())
        .unwrap_or_default();
    let max = values.iter().copied().fold(0.0, f64::max);
    let mean = if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    };
    serde_json::json!({
        "sample_count": sample_count,
        "max": max,
        "mean": mean,
    })
}

fn mode_component_summary(sample_count: usize) -> serde_json::Value {
    serde_json::json!({
        "real_sample_count": sample_count,
        "imag_sample_count": sample_count,
        "component_count": 3,
    })
}

fn zarr_group_artifact(path: impl Into<String>) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zgroup", path.into()),
        &serde_json::json!({
            "zarr_format": 2,
        }),
    )
}

fn mode_zarr_store_attrs_artifact() -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zattrs", mode_zarr_store_path()),
        &serde_json::json!({
            "fullmag_kind": "frequency_domain_mode_field_store",
            "schema_version": 1,
            "preferred_container": "zarr",
            "quantity_ids": ["delta_m"],
            "axes": ["sample", "mode", "spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "storage_layout": "aos_xyz_complex_pairs",
            "compatibility_binary_exports": true,
        }),
    )
}

fn mode_zarr_array_metadata_artifact(
    sample_index: usize,
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    let chunk_sample_count = sample_count.max(1);
    json_artifact(
        format!(
            "{}/.zarray",
            mode_zarr_array_path(sample_index, raw_mode_index)
        ),
        &serde_json::json!({
            "zarr_format": 2,
            "shape": [sample_count, 3, 2],
            "chunks": [chunk_sample_count, 3, 2],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }),
    )
}

fn mode_zarr_array_attrs_artifact(
    sample_index: usize,
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!(
            "{}/.zattrs",
            mode_zarr_array_path(sample_index, raw_mode_index)
        ),
        &serde_json::json!({
            "quantity_id": "delta_m",
            "unit": "1",
            "value_kind": "complex_spatial_vector",
            "component_basis": "global_xyz",
            "axes": ["spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "sample_index": sample_index,
            "raw_mode_index": raw_mode_index,
            "mode_field_sample_count": sample_count,
            "storage_layout": "aos_xyz_complex_pairs",
        }),
    )
}

fn production_k0_publication_adapter(adapter: Option<&str>) -> bool {
    matches!(
        adapter,
        Some("k0_poisson_airbox_cpu_full_coupled_slepc")
            | Some("k0_poisson_airbox_cpu_schur_slepc")
            | Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    )
}

fn modal_publication_contract(
    plan: &FemEigenPlanIR,
    summary_payload: &serde_json::Value,
) -> Result<serde_json::Value, RunError> {
    let diagnostics = summary_payload
        .get("solver_diagnostics")
        .and_then(serde_json::Value::as_object);
    let adapter = diagnostics
        .and_then(|object| object.get("solver_adapter"))
        .and_then(serde_json::Value::as_str);
    let production_k0 = production_k0_publication_adapter(adapter);

    let required_string = |key: &str| -> Result<Option<String>, RunError> {
        let value = diagnostics
            .and_then(|object| object.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty() && *value != "unknown")
            .map(str::to_owned);
        if production_k0 && value.is_none() {
            return Err(RunError {
                message: format!(
                    "production K0 modal publication requires solver_diagnostics.{key}"
                ),
            });
        }
        Ok(value)
    };
    let required_bool = |key: &str| -> Result<Option<bool>, RunError> {
        let value = diagnostics
            .and_then(|object| object.get(key))
            .and_then(serde_json::Value::as_bool);
        if production_k0 && value.is_none() {
            return Err(RunError {
                message: format!(
                    "production K0 modal publication requires boolean solver_diagnostics.{key}"
                ),
            });
        }
        Ok(value)
    };

    let engine_id = required_string("engine_id")?;
    let solve_succeeded = required_bool("solve_succeeded")?;
    let fields_available = required_bool("fields_available")?;
    let spectrum_completeness = required_string("spectrum_completeness")?;
    let window_complete = required_bool("window_complete")?;
    let equilibrium_digest = required_string("equilibrium_artifact_sha256")?;
    let source_topology = required_string("source_mesh_topology_sha256")?;
    let resolved_device = diagnostics
        .and_then(|object| object.get("resolved_execution"))
        .and_then(serde_json::Value::as_object)
        .and_then(|object| object.get("device"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && *value != "unknown")
        .map(str::to_owned)
        .or_else(|| {
            diagnostics
                .and_then(|object| object.get("execution_lane"))
                .and_then(serde_json::Value::as_str)
                .map(|lane| if lane.contains("gpu") { "gpu" } else { "cpu" }.to_string())
        });
    if production_k0 && resolved_device.is_none() {
        return Err(RunError {
            message: "production K0 modal publication requires resolved device identity"
                .to_string(),
        });
    }

    let topology_fingerprint =
        plan.mesh
            .mixed_topology_fingerprint_v3()
            .map_err(|error| RunError {
                message: format!(
                "production modal publication requires a finite v3 source mesh identity: {error}"
            ),
            })?;
    if production_k0
        && source_topology
            .as_deref()
            .is_some_and(|source| source != topology_fingerprint)
    {
        return Err(RunError {
            message:
                "production K0 modal publication source topology does not match the published mesh"
                    .to_string(),
        });
    }

    let mut contract = serde_json::Map::new();
    for (key, value) in [
        (
            "engine_id",
            engine_id.clone().map(serde_json::Value::String),
        ),
        (
            "solve_succeeded",
            solve_succeeded.map(serde_json::Value::Bool),
        ),
        (
            "fields_available",
            fields_available.map(serde_json::Value::Bool),
        ),
        (
            "spectrum_completeness",
            spectrum_completeness.map(serde_json::Value::String),
        ),
        (
            "window_complete",
            window_complete.map(serde_json::Value::Bool),
        ),
    ] {
        if let Some(value) = value {
            contract.insert(key.to_string(), value);
        }
    }
    contract.insert(
        "candidate_identity".to_string(),
        serde_json::json!({
            "schema_version": "frequency_domain_candidate_identity.v1",
            "mesh_id": plan.mesh_name,
            "mesh_generation_id": crate::artifacts::solver_mesh_signature(&plan.mesh),
            "topology_fingerprint": topology_fingerprint,
            "equilibrium_artifact_sha256": equilibrium_digest,
            "engine_id": engine_id,
            "device": resolved_device,
            "source_identity": crate::artifacts::build_identity_json(),
        }),
    );
    Ok(serde_json::Value::Object(contract))
}

fn insert_modal_publication_contract(target: &mut serde_json::Value, contract: &serde_json::Value) {
    let (Some(target), Some(contract)) = (target.as_object_mut(), contract.as_object()) else {
        return;
    };
    for (key, value) in contract {
        target.insert(key.clone(), value.clone());
    }
}

const FLOQUET_CERTIFICATE_KEYS: [&str; 13] = [
    "floquet_descriptor_certified",
    "floquet_geometric_bc_certified",
    "potential_representation",
    "magnetic_relative_residual",
    "potential_relative_residual",
    "potential_dof_count",
    "potential_payload_path",
    "potential_payload_sha256",
    "potential_payload_encoding",
    "potential_binary_layout",
    "potential_value_count",
    "potential_vector_real",
    "potential_vector_imag",
];

const FLOQUET_REFERENCE_KEYS: [&str; 5] = [
    "potential_payload_path",
    "potential_payload_sha256",
    "potential_payload_encoding",
    "potential_binary_layout",
    "potential_value_count",
];

#[derive(Clone, Debug)]
struct FloquetModeMetadata {
    potential_representation: String,
    magnetic_relative_residual: f64,
    potential_relative_residual: f64,
    potential_dof_count: usize,
}

#[derive(Clone, Debug)]
struct FloquetPotentialPublication {
    metadata: FloquetModeMetadata,
    payload_path: String,
    payload_sha256: String,
    payload_value_count: usize,
}

fn floquet_mode_metadata_json(metadata: &FloquetModeMetadata) -> serde_json::Value {
    serde_json::json!({
        "floquet_descriptor_certified": true,
        "floquet_geometric_bc_certified": false,
        "potential_representation": metadata.potential_representation.clone(),
        "magnetic_relative_residual": metadata.magnetic_relative_residual,
        "potential_relative_residual": metadata.potential_relative_residual,
        "potential_dof_count": metadata.potential_dof_count,
    })
}

fn floquet_publication_json(publication: &FloquetPotentialPublication) -> serde_json::Value {
    let mut fields = floquet_mode_metadata_json(&publication.metadata);
    let object = fields
        .as_object_mut()
        .expect("Floquet metadata must remain an object");
    object.insert(
        "potential_payload_path".to_string(),
        serde_json::json!(publication.payload_path.clone()),
    );
    object.insert(
        "potential_payload_sha256".to_string(),
        serde_json::json!(publication.payload_sha256.clone()),
    );
    object.insert(
        "potential_payload_encoding".to_string(),
        serde_json::json!("f64_interleaved_real_imag"),
    );
    object.insert(
        "potential_binary_layout".to_string(),
        serde_json::json!("complex_f64_pairs_little_endian"),
    );
    object.insert(
        "potential_value_count".to_string(),
        serde_json::json!(publication.payload_value_count),
    );
    fields
}

fn insert_floquet_fields(
    target: &mut serde_json::Map<String, serde_json::Value>,
    fields: &serde_json::Value,
) {
    let Some(fields) = fields.as_object() else {
        return;
    };
    for (key, value) in fields {
        target.insert(key.clone(), value.clone());
    }
}

fn remove_floquet_reference_fields(target: &mut serde_json::Map<String, serde_json::Value>) {
    for key in FLOQUET_REFERENCE_KEYS {
        target.remove(key);
    }
}

fn parse_floquet_mode_metadata(
    mode: &serde_json::Value,
) -> Result<Option<FloquetModeMetadata>, RunError> {
    let has_any = FLOQUET_CERTIFICATE_KEYS
        .iter()
        .any(|key| mode.get(*key).is_some());
    if !has_any {
        return Ok(None);
    }
    if mode
        .get("potential_representation")
        .and_then(serde_json::Value::as_str)
        == Some("complex_coefficients")
    {
        if FLOQUET_REFERENCE_KEYS
            .iter()
            .any(|key| mode.get(*key).is_some())
            || mode.get("potential_vector_real").is_some()
            || mode.get("potential_vector_imag").is_some()
        {
            return Err(RunError {
                message: "physical Floquet potential must not use the legacy doubled-real sidecar contract"
                    .to_string(),
            });
        }
        return Ok(None);
    }
    let descriptor_certified = mode
        .get("floquet_descriptor_certified")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| RunError {
            message:
                "Floquet modal artifact certificate requires boolean floquet_descriptor_certified"
                    .to_string(),
        })?;
    if !descriptor_certified {
        if FLOQUET_CERTIFICATE_KEYS[1..]
            .iter()
            .any(|key| mode.get(*key).is_some())
        {
            return Err(RunError {
                message: "non-certified Floquet modal artifact carries certificate metadata"
                    .to_string(),
            });
        }
        return Ok(None);
    }
    let geometric_bc_certified = mode
        .get("floquet_geometric_bc_certified")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| RunError {
            message:
                "Floquet modal artifact certificate requires boolean floquet_geometric_bc_certified"
                    .to_string(),
        })?;
    if geometric_bc_certified {
        return Err(RunError {
            message: "Floquet modal artifact cannot claim geometric BC certification".to_string(),
        });
    }
    if mode.get("potential_vector_real").is_some() || mode.get("potential_vector_imag").is_some() {
        return Err(RunError {
            message:
                "Floquet modal artifact must persist potential coefficients in binary, not inline arrays"
                    .to_string(),
        });
    }
    let potential_representation = mode
        .get("potential_representation")
        .and_then(serde_json::Value::as_str)
        .filter(|value| *value == "doubled_real_split_complex_coefficients")
        .map(str::to_owned)
        .ok_or_else(|| RunError {
            message: "Floquet modal artifact certificate has unsupported potential representation"
                .to_string(),
        })?;
    let required_residual = |key: &str| -> Result<f64, RunError> {
        let value = mode
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && (0.0..=1.0e-8).contains(value))
            .ok_or_else(|| RunError {
                message: format!(
                    "Floquet modal artifact certificate field '{key}' must be finite and in [0, 1e-8]"
                ),
            })?;
        Ok(value)
    };
    let magnetic_relative_residual = required_residual("magnetic_relative_residual")?;
    let potential_relative_residual = required_residual("potential_relative_residual")?;
    let potential_dof_count = mode
        .get("potential_dof_count")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0 && *value % 2 == 0)
        .ok_or_else(|| RunError {
            message:
                "Floquet modal artifact certificate requires a positive even potential_dof_count"
                    .to_string(),
        })?;

    let has_references = FLOQUET_REFERENCE_KEYS
        .iter()
        .any(|key| mode.get(*key).is_some());
    if has_references {
        let path = mode
            .get("potential_payload_path")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty());
        let digest = mode
            .get("potential_payload_sha256")
            .and_then(serde_json::Value::as_str)
            .filter(|value| value.starts_with("sha256:"));
        let encoding = mode
            .get("potential_payload_encoding")
            .and_then(serde_json::Value::as_str);
        let layout = mode
            .get("potential_binary_layout")
            .and_then(serde_json::Value::as_str);
        let value_count = mode
            .get("potential_value_count")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok());
        if path.is_none()
            || digest.is_none()
            || encoding != Some("f64_interleaved_real_imag")
            || layout != Some("complex_f64_pairs_little_endian")
            || value_count != Some(potential_dof_count.saturating_mul(2))
        {
            return Err(RunError {
                message:
                    "Floquet modal artifact has an incomplete or inconsistent potential payload reference"
                        .to_string(),
            });
        }
    }

    Ok(Some(FloquetModeMetadata {
        potential_representation,
        magnetic_relative_residual,
        potential_relative_residual,
        potential_dof_count,
    }))
}

fn validate_floquet_potential_payload(
    bytes: &[u8],
    expected_dof_count: usize,
    context: &str,
) -> Result<(String, usize), RunError> {
    let expected_bytes = expected_dof_count
        .checked_mul(2 * std::mem::size_of::<f64>())
        .ok_or_else(|| RunError {
            message: format!("{context}: Floquet potential payload size overflows usize"),
        })?;
    if bytes.len() != expected_bytes {
        return Err(RunError {
            message: format!(
                "{context}: Floquet potential payload length {} does not match {} coefficients",
                bytes.len(),
                expected_dof_count
            ),
        });
    }
    for (index, pair) in bytes.chunks_exact(16).enumerate() {
        let real = f64::from_le_bytes(pair[0..8].try_into().expect("8-byte real component"));
        let imag = f64::from_le_bytes(pair[8..16].try_into().expect("8-byte imag component"));
        if !real.is_finite() || !imag.is_finite() {
            return Err(RunError {
                message: format!(
                    "{context}: Floquet potential payload contains a non-finite coefficient at index {index}"
                ),
            });
        }
    }
    Ok((
        format!("sha256:{:x}", Sha256::digest(bytes)),
        expected_dof_count * 2,
    ))
}

fn collect_floquet_potential_publications(
    modes: &[serde_json::Value],
    requested_modes: &std::collections::BTreeSet<u32>,
    auxiliary_artifacts: &[AuxiliaryArtifact],
    sample_index: usize,
) -> Result<
    (
        BTreeMap<u64, FloquetModeMetadata>,
        BTreeMap<u64, FloquetPotentialPublication>,
    ),
    RunError,
> {
    let mut metadata_by_mode = BTreeMap::new();
    let mut publications = BTreeMap::new();
    for mode in modes {
        let raw_mode_index = mode
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let metadata = parse_floquet_mode_metadata(mode)?;
        let payload_path = floquet_potential_payload_path(sample_index, raw_mode_index);
        let payload_artifacts = auxiliary_artifacts
            .iter()
            .filter(|artifact| artifact.relative_path == payload_path)
            .collect::<Vec<_>>();
        let mode_declares_references = FLOQUET_REFERENCE_KEYS
            .iter()
            .any(|key| mode.get(*key).is_some());
        if payload_artifacts.len() > 1 {
            return Err(RunError {
                message: format!(
                    "Floquet mode {raw_mode_index} has duplicate potential payload artifacts"
                ),
            });
        }
        let selected = u32::try_from(raw_mode_index)
            .ok()
            .is_some_and(|index| requested_modes.contains(&index));
        match metadata {
            None => {
                if !payload_artifacts.is_empty() {
                    return Err(RunError {
                        message: format!(
                            "non-certified Floquet mode {raw_mode_index} has a potential payload artifact"
                        ),
                    });
                }
            }
            Some(metadata) => {
                metadata_by_mode.insert(raw_mode_index, metadata.clone());
                if mode_declares_references && payload_artifacts.is_empty() {
                    return Err(RunError {
                        message: format!(
                            "Floquet mode {raw_mode_index} declares a potential payload reference but the artifact is missing"
                        ),
                    });
                }
                if let Some(artifact) = payload_artifacts.first() {
                    if !selected {
                        return Err(RunError {
                            message: format!(
                                "unrequested Floquet mode {raw_mode_index} has a persisted potential payload"
                            ),
                        });
                    }
                    let (payload_sha256, payload_value_count) = validate_floquet_potential_payload(
                        &artifact.bytes,
                        metadata.potential_dof_count,
                        &format!("Floquet mode {raw_mode_index}"),
                    )?;
                    if let Some(declared_path) = mode
                        .get("potential_payload_path")
                        .and_then(serde_json::Value::as_str)
                    {
                        if declared_path != payload_path {
                            return Err(RunError {
                                message: format!(
                                    "Floquet mode {raw_mode_index} potential payload reference path does not match the sample/mode identity"
                                ),
                            });
                        }
                    }
                    if let Some(declared_sha256) = mode
                        .get("potential_payload_sha256")
                        .and_then(serde_json::Value::as_str)
                    {
                        if declared_sha256 != payload_sha256 {
                            return Err(RunError {
                                message: format!(
                                    "Floquet mode {raw_mode_index} potential payload digest does not match the persisted bytes"
                                ),
                            });
                        }
                    }
                    if let Some(declared_value_count) = mode
                        .get("potential_value_count")
                        .and_then(serde_json::Value::as_u64)
                    {
                        if usize::try_from(declared_value_count).ok() != Some(payload_value_count) {
                            return Err(RunError {
                                message: format!(
                                    "Floquet mode {raw_mode_index} potential payload value count does not match the persisted bytes"
                                ),
                            });
                        }
                    }
                    let publication = FloquetPotentialPublication {
                        metadata,
                        payload_path,
                        payload_sha256,
                        payload_value_count,
                    };
                    publications.insert(raw_mode_index, publication);
                } else if selected {
                    return Err(RunError {
                        message: format!(
                            "requested certified Floquet mode {raw_mode_index} has no persisted potential payload"
                        ),
                    });
                }
            }
        }
    }
    Ok((metadata_by_mode, publications))
}

pub(super) fn write_eigen_v2_bundle(
    plan: &FemEigenPlanIR,
    summary_payload: &serde_json::Value,
    requested_modes: &std::collections::BTreeSet<u32>,
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
    sample_index: usize,
) -> Result<(), RunError> {
    let producer_provenance_v1_paths =
        sample_scoped_producer_provenance_paths(auxiliary_artifacts);
    let producer_provenance_v1_path = match producer_provenance_v1_paths.as_slice() {
        [only] => Some(only.clone()),
        _ => producer_provenance_v1_paths
            .iter()
            .find(|path| {
                canonical_sample_scoped_index(path, "producer_provenance.v1.json")
                    == Some(sample_index)
            })
            .cloned(),
    };
    let publication_contract = modal_publication_contract(plan, summary_payload)?;
    let modal_source_topology_fingerprint =
        plan.mesh
            .mixed_topology_fingerprint_v3()
            .map_err(|error| RunError {
                message: format!("modal field source mesh identity is invalid: {error}"),
            })?;
    let modes = summary_payload
        .get("modes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let (floquet_metadata_by_mode, floquet_publications) = collect_floquet_potential_publications(
        &modes,
        requested_modes,
        auxiliary_artifacts,
        sample_index,
    )?;
    let k_vector = match plan.k_sampling.as_ref() {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) | None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let solver_model = summary_payload
        .get("solver_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let manifest_phase_convention = modes
        .first()
        .and_then(|mode| mode.get("phasor_convention"))
        .and_then(|value| value.as_str())
        .unwrap_or("exp_minus_i_omega_t");

    // A mode selected for field export is only visualizable after the complete
    // global Cartesian complex payload has been validated.  Modes not selected
    // by the author remain legitimate spectrum-only observations and never
    // receive a dangling field identifier.
    let mut visualizable_mode_indices = BTreeSet::new();
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .ok_or_else(|| RunError {
                message: format!(
                    "requested mode {raw_mode_index} has no legacy payload artifact for Cartesian field export"
                ),
            })
            .and_then(|artifact| {
                serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| {
                    RunError {
                        message: format!(
                            "requested mode {raw_mode_index} legacy payload is invalid JSON: {error}"
                        ),
                    }
                })
            })?;
        let real = mode_vector_entries(&legacy_mode, "real").map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        let imag = mode_vector_entries(&legacy_mode, "imag").map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        let _ = mode_payload_bytes(&real, &imag).map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        visualizable_mode_indices.insert(raw_mode_index);
    }

    let spectrum_v2_modes: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut mode = mode.clone();
            if let Some(object) = mode.as_object_mut() {
                object.remove("component_participation");
                remove_floquet_reference_fields(object);
                object.insert(
                    "raw_mode_index".to_string(),
                    serde_json::json!(raw_mode_index),
                );
                object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
                let mode_field_available = visualizable_mode_indices.contains(&raw_mode_index);
                object.insert(
                    "mode_field_available".to_string(),
                    serde_json::json!(mode_field_available),
                );
                if mode_field_available {
                    object.insert(
                        "mode_field_id".to_string(),
                        serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                    );
                    object.insert(
                        "mode_field_resource_key".to_string(),
                        serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                    );
                }
                if let Some(metadata) = floquet_metadata_by_mode.get(&raw_mode_index) {
                    insert_floquet_fields(object, &floquet_mode_metadata_json(metadata));
                }
                if let Some(publication) = floquet_publications.get(&raw_mode_index) {
                    insert_floquet_fields(object, &floquet_publication_json(publication));
                }
            }
            mode
        })
        .collect();
    let mut spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_model": summary_payload["solver_kind"],
        "sample_count": 1,
        "mode_count": spectrum_v2_modes.len(),
        "samples": [{
            "sample_id": modal_sample_id(plan, sample_index),
            "sample_index": sample_index,
            "label": label,
            "k_vector": k_vector,
            "path_s": 0.0,
            "segment_index": 0,
            "t_in_segment": 0.0,
            "external_field_a_per_m": plan.external_field,
            "mesh_id": plan.mesh_name,
            "topology_revision": plan.mesh.topology_fingerprint_v6(),
            "modes": spectrum_v2_modes,
        }],
    });
    insert_modal_publication_contract(&mut spectrum_v2, &publication_contract);
    auxiliary_artifacts.push(json_artifact("eigen/spectrum.v2.json", &spectrum_v2)?);
    let spectrum_v2_revision =
        published_artifact_sha256(auxiliary_artifacts, "eigen/spectrum.v2.json")?;

    let participation_solver_device = if solver_model.contains("gpu") {
        "gpu"
    } else {
        "cpu"
    };
    let spectrum_v3_modes = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let participation = match mode.get("component_participation") {
                Some(value) => {
                    serde_json::from_value::<crate::eigen::ModalParticipationObservable>(
                        value.clone(),
                    )
                    .map_err(|error| RunError {
                        message: format!(
                            "mode {raw_mode_index} has invalid component participation: {error}"
                        ),
                    })?
                }
                None => crate::eigen::ModalParticipationObservable::unavailable_without_context(
                    participation_solver_device,
                ),
            };
            let mut mode = mode.clone();
            let object = mode.as_object_mut().ok_or_else(|| RunError {
                message: format!("mode {raw_mode_index} summary is not a JSON object"),
            })?;
            remove_floquet_reference_fields(object);
            object.insert(
                "mode_id".to_string(),
                serde_json::json!(format!("sample-{sample_index:04}/mode-{raw_mode_index:04}")),
            );
            object.insert(
                "raw_mode_index".to_string(),
                serde_json::json!(raw_mode_index),
            );
            object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
            let mode_field_available = visualizable_mode_indices.contains(&raw_mode_index);
            object.insert(
                "mode_field_available".to_string(),
                serde_json::json!(mode_field_available),
            );
            object.insert(
                "component_participation".to_string(),
                serde_json::to_value(participation).map_err(|error| RunError {
                    message: format!(
                        "mode {raw_mode_index} component participation cannot serialize: {error}"
                    ),
                })?,
            );
            if mode_field_available {
                object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                );
                object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                );
            }
            if let Some(metadata) = floquet_metadata_by_mode.get(&raw_mode_index) {
                insert_floquet_fields(object, &floquet_mode_metadata_json(metadata));
            }
            if let Some(publication) = floquet_publications.get(&raw_mode_index) {
                insert_floquet_fields(object, &floquet_publication_json(publication));
            }
            Ok(mode)
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let mut spectrum_v3 = serde_json::json!({
        "schema_version": "eigen_spectrum.v3",
        "solver_model": summary_payload["solver_kind"],
        "sample_count": 1,
        "mode_count": spectrum_v3_modes.len(),
        "samples": [{
            "sample_id": modal_sample_id(plan, sample_index),
            "sample_index": sample_index,
            "label": label,
            "k_vector": k_vector,
            "path_s": 0.0,
            "segment_index": 0,
            "t_in_segment": 0.0,
            "external_field_a_per_m": plan.external_field,
            "mesh_id": plan.mesh_name,
            "topology_revision": plan.mesh.topology_fingerprint_v6(),
            "modes": spectrum_v3_modes,
        }],
    });
    insert_modal_publication_contract(&mut spectrum_v3, &publication_contract);
    auxiliary_artifacts.push(json_artifact("eigen/spectrum.v3.json", &spectrum_v3)?);

    let branches: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut point = serde_json::json!({
                "branch_id": raw_mode_index,
                "cluster_id": mode["cluster_id"],
                "multiplicity": mode["multiplicity"],
                "label": format!("mode_{raw_mode_index:04}"),
                "points": [{
                    "sample_id": modal_sample_id(plan, sample_index),
                    "mode_id": format!("sample-{sample_index:04}/mode-{raw_mode_index:04}"),
                    "sample_index": sample_index,
                    "raw_mode_index": raw_mode_index,
                    "frequency_hz": mode["frequency_hz"],
                    "frequency_real_hz": mode["frequency_real_hz"],
                    "frequency_imag_hz": mode["frequency_imag_hz"],
                    "angular_frequency_rad_per_s": mode["angular_frequency_rad_per_s"],
                    "tracking_confidence": 1.0,
                    "tracking_score_source": "seed",
                    "modal_overlap_available": false,
                    "overlap_prev": null,
                    "mode_field_available": visualizable_mode_indices.contains(&raw_mode_index),
                }],
            });
            if visualizable_mode_indices.contains(&raw_mode_index) {
                let point_object = point["points"][0]
                    .as_object_mut()
                    .expect("branch point must remain an object");
                point_object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                );
                point_object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                );
            }
            point
        })
        .collect();
    auxiliary_artifacts.push(json_artifact(
        "eigen/branches.v2.json",
        &serde_json::json!({
            "schema_version": "eigen_branches.v2",
            "solver_model": summary_payload["solver_kind"],
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
            "branches": branches,
            "diagnostics": {
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            },
        }),
    )?);
    if !auxiliary_artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "eigen/dispersion.csv")
    {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                sample_index,
                &modal_sample_id(plan, sample_index),
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }

    let mut mode_metadata_paths = Vec::new();
    let mut mode_resource_keys = Vec::new();
    let mut wrote_mode_zarr_store = false;
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .ok_or_else(|| RunError {
                message: format!("requested mode {raw_mode_index} disappeared before publication"),
            })
            .and_then(|artifact| {
                serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| {
                    RunError {
                        message: format!(
                            "requested mode {raw_mode_index} legacy payload is invalid JSON: {error}"
                        ),
                    }
                })
            })?;
        let real = mode_vector_entries(&legacy_mode, "real")?;
        let imag = mode_vector_entries(&legacy_mode, "imag")?;
        let sample_count = real.len();
        let source_node_count = plan.mesh.nodes.len();
        if sample_count != source_node_count {
            return Err(RunError {
                message: format!(
                    "requested mode {raw_mode_index} payload node count {sample_count} does not match source mesh node count {source_node_count}"
                ),
            });
        }
        let metadata_path = mode_metadata_path(sample_index, raw_mode_index);
        let payload_path = mode_payload_path(sample_index, raw_mode_index);
        let zarr_array_path = mode_zarr_array_path(sample_index, raw_mode_index);
        let zarr_chunk_path = mode_zarr_chunk_path(sample_index, raw_mode_index);
        let field_id = mode_field_id(sample_index, raw_mode_index);
        let field_resource = mode_field_resource_key(sample_index, raw_mode_index);
        let payload_bytes = mode_payload_bytes(&real, &imag)?;
        let payload_sha256 = format!("sha256:{:x}", Sha256::digest(&payload_bytes));
        let mut metadata = serde_json::json!({
            "schema_version": "eigen_mode.v2",
            "solver_model": summary_payload["solver_kind"],
            "sample_index": sample_index,
            "raw_mode_index": raw_mode_index,
            "branch_id": raw_mode_index,
            "frequency_hz": legacy_mode["frequency_hz"],
            "frequency_real_hz": legacy_mode["frequency_real_hz"],
            "frequency_imag_hz": legacy_mode["frequency_imag_hz"],
            "angular_frequency_rad_per_s": legacy_mode["angular_frequency_rad_per_s"],
            "eigenvalue_real": legacy_mode["eigenvalue_real"],
            "eigenvalue_imag": legacy_mode["eigenvalue_imag"],
            "normalization": legacy_mode["normalization"],
            "damping_policy": legacy_mode["damping_policy"],
            "source_mesh_identity": {
                "mesh_id": plan.mesh_name,
                "topology_fingerprint": modal_source_topology_fingerprint,
                "indexing": "full_domain_node_order",
                "node_count": source_node_count,
            },
            "payload_sha256": payload_sha256,
            "source_spectrum_revision": spectrum_v2_revision.clone(),
        });
        insert_modal_publication_contract(&mut metadata, &publication_contract);
        if let Some(object) = metadata.as_object_mut() {
            object.insert("mode_field_id".to_string(), serde_json::json!(field_id));
            object.insert(
                "mode_field_resource_key".to_string(),
                serde_json::json!(field_resource),
            );
            object.insert(
                "residual_norm".to_string(),
                legacy_mode["residual_norm"].clone(),
            );
            object.insert(
                "residual_absolute_l2".to_string(),
                legacy_mode["residual_absolute_l2"].clone(),
            );
            object.insert(
                "residual_relative_l2".to_string(),
                legacy_mode["residual_relative_l2"].clone(),
            );
            object.insert(
                "residual_linf".to_string(),
                legacy_mode["residual_linf"].clone(),
            );
            object.insert("mass_norm".to_string(), legacy_mode["mass_norm"].clone());
            for key in [
                "cluster_id",
                "cluster_size",
                "multiplicity",
                "q_dof_count",
                "phi_dof_count",
                "native_q_phi_payload",
                "q_real",
                "q_imag",
                "phi_real",
                "phi_imag",
                "external_field_a_per_m",
                "assembly_kind",
                "operator_input_signature_sha256",
                "phase_constraint_sha256",
                "equilibrium_artifact_sha256",
                "linearization_state_sha256",
                "periodic_mesh_certificate_sha256",
                "relax_to_eigen_handoff_sha256",
                "relax_to_eigen_source_mesh_topology_sha256",
                "source_mesh_topology_sha256",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            if let Some(metadata) = floquet_metadata_by_mode.get(&raw_mode_index) {
                insert_floquet_fields(object, &floquet_mode_metadata_json(metadata));
            }
            if let Some(publication) = floquet_publications.get(&raw_mode_index) {
                insert_floquet_fields(object, &floquet_publication_json(publication));
            }
            if let Some(block_residuals) = legacy_mode.get("block_residuals") {
                object.insert("block_residuals".to_string(), block_residuals.clone());
            }
            for key in [
                "angular_frequency_imag_rad_per_s",
                "complex_frequency_convention",
                "damping_rate_hz",
                "linewidth_fwhm_hz",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            object.insert(
                "tangent_leakage_mean_abs".to_string(),
                legacy_mode["tangent_leakage_mean_abs"].clone(),
            );
            object.insert(
                "tangent_leakage_max_abs".to_string(),
                legacy_mode["tangent_leakage_max_abs"].clone(),
            );
            object.insert(
                "tangent_leakage_weighted_relative_l2".to_string(),
                legacy_mode["tangent_leakage_weighted_relative_l2"].clone(),
            );
            object.insert(
                "omega_rad_s".to_string(),
                legacy_mode["omega_rad_s"].clone(),
            );
            object.insert(
                "phasor_convention".to_string(),
                legacy_mode["phasor_convention"].clone(),
            );
            object.insert(
                "eigenvalue_mapping".to_string(),
                legacy_mode["eigenvalue_mapping"].clone(),
            );
            object.insert(
                "gamma_rad_s_T".to_string(),
                legacy_mode["gamma_rad_s_T"].clone(),
            );
            object.insert(
                "gamma0_rad_s_per_A_m".to_string(),
                legacy_mode["gamma0_rad_s_per_A_m"].clone(),
            );
            object.insert(
                "mu0_T_m_per_A".to_string(),
                legacy_mode["mu0_T_m_per_A"].clone(),
            );
            object.insert(
                "dominant_polarization".to_string(),
                legacy_mode["dominant_polarization"].clone(),
            );
            object.insert("k_vector".to_string(), legacy_mode["k_vector"].clone());
            object.insert(
                "value_kind".to_string(),
                serde_json::json!("complex_spatial_vector"),
            );
            object.insert(
                "component_basis".to_string(),
                serde_json::json!("global_xyz"),
            );
            object.insert("component_count".to_string(), serde_json::json!(3));
            object.insert("components".to_string(), serde_json::json!(["x", "y", "z"]));
            object.insert(
                "payload_encoding".to_string(),
                serde_json::json!("f64_interleaved_real_imag_xyz"),
            );
            object.insert(
                "binary_layout".to_string(),
                serde_json::json!("complex_f64_pairs_little_endian"),
            );
            object.insert(
                "complex_pair_count".to_string(),
                serde_json::json!(sample_count * 3),
            );
            object.insert(
                "payload_value_count".to_string(),
                serde_json::json!(sample_count * 6),
            );
            object.insert(
                "available_views".to_string(),
                serde_json::json!([
                    "complex",
                    "real",
                    "imag",
                    "abs",
                    "amplitude",
                    "phase",
                    "phase_rotated_real"
                ]),
            );
            object.insert(
                "default_view".to_string(),
                serde_json::json!("phase_rotated_real"),
            );
            object.insert("default_phase_rad".to_string(), serde_json::json!(0.0));
            object.insert(
                "mode_field_sample_count".to_string(),
                serde_json::json!(sample_count),
            );
            object.insert(
                "amplitude_summary".to_string(),
                mode_amplitude_summary(&legacy_mode["amplitude"], sample_count),
            );
            object.insert(
                "component_summary".to_string(),
                mode_component_summary(sample_count),
            );
            object.insert("storage_format".to_string(), serde_json::json!("zarr"));
            object.insert(
                "zarr_store_path".to_string(),
                serde_json::json!(mode_zarr_store_path()),
            );
            object.insert(
                "zarr_array_path".to_string(),
                serde_json::json!(zarr_array_path),
            );
            object.insert(
                "zarr_chunk_path".to_string(),
                serde_json::json!(zarr_chunk_path.clone()),
            );
            object.insert("zarr_dtype".to_string(), serde_json::json!("<f8"));
            object.insert(
                "zarr_shape".to_string(),
                serde_json::json!([sample_count, 3, 2]),
            );
            object.insert(
                "zarr_chunk_shape".to_string(),
                serde_json::json!([sample_count.max(1), 3, 2]),
            );
            object.insert("zarr_compressor".to_string(), serde_json::Value::Null);
            object.insert(
                "compatibility_binary_payload_path".to_string(),
                serde_json::json!(payload_path.clone()),
            );
        }
        auxiliary_artifacts.push(json_artifact(metadata_path.clone(), &metadata)?);
        if !wrote_mode_zarr_store {
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_store_path())?);
            auxiliary_artifacts.push(mode_zarr_store_attrs_artifact()?);
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_sample_group_path(
                sample_index,
            ))?);
            wrote_mode_zarr_store = true;
        }
        auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_mode_group_path(
            sample_index,
            raw_mode_index,
        ))?);
        auxiliary_artifacts.push(mode_zarr_array_metadata_artifact(
            sample_index,
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(mode_zarr_array_attrs_artifact(
            sample_index,
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(binary_artifact(zarr_chunk_path, payload_bytes.clone()));
        auxiliary_artifacts.push(binary_artifact(payload_path, payload_bytes));
        mode_metadata_paths.push(metadata_path);
        mode_resource_keys.push(mode_meta_resource_key(sample_index, raw_mode_index));
    }

    let published_solver_diagnostics = summary_payload
        .get("solver_diagnostics")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| modal_solver_diagnostics_json(plan, solver_model, modes.len()));
    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &published_solver_diagnostics,
    )?);

    let linearization_identity_paths = validate_published_linearization_identity_sidecars(
        summary_payload,
        auxiliary_artifacts,
        sample_index,
    )?;
    let r4_coverage = inspect_r4_sidecars(auxiliary_artifacts, &[sample_index]);
    let nonshared_floquet_coverage =
        inspect_nonshared_floquet_sidecars(auxiliary_artifacts, &[sample_index]);
    let nonshared_floquet_native_input_diagnostics_coverage =
        inspect_nonshared_floquet_native_input_diagnostics_sidecars(
            auxiliary_artifacts,
            &[sample_index],
        );

    let has_mode_fields = !mode_metadata_paths.is_empty();
    let spectrum_revision = spectrum_v2_revision;
    let branches_revision =
        published_artifact_sha256(auxiliary_artifacts, "eigen/branches.v2.json")?;
    let mut manifest = serde_json::json!({
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "modal_eigen",
        "equilibrium_identity": summary_payload
            .get("solver_diagnostics")
            .and_then(|value| value.get("equilibrium_artifact_sha256"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "mesh_identity": crate::artifacts::solver_mesh_signature(&plan.mesh),
        "boundary_context": modal_boundary_context(plan),
        "k_sampling": modal_k_sampling_manifest(plan.k_sampling.as_ref()),
        "stage_kind": "eigenmodes",
        "status": "ready",
        "complete": true,
        "physics": {
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": manifest_phase_convention,
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": normalization_label(plan.normalization),
        },
        "artifacts": {
            "spectrum_v2_path": "eigen/spectrum.v2.json",
            "branches_v2_path": "eigen/branches.v2.json",
            "dispersion_csv_path": "eigen/dispersion.csv",
            "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
            "mode_field_zarr_store_path": if has_mode_fields {
                serde_json::json!(mode_zarr_store_path())
            } else {
                serde_json::Value::Null
            },
            "mode_field_storage_format": if has_mode_fields { "zarr" } else { "none" },
            "mode_metadata_paths": mode_metadata_paths,
            "linearization_identity_v2_path": linearization_identity_paths
                .as_ref()
                .map(|(identity_path, _)| serde_json::json!(identity_path))
                .unwrap_or(serde_json::Value::Null),
            "linearization_identity_preimage_v1_path": linearization_identity_paths
                .as_ref()
                .map(|(_, preimage_path)| serde_json::json!(preimage_path))
                .unwrap_or(serde_json::Value::Null),
            "producer_provenance_v1_path": producer_provenance_v1_path,
            "producer_provenance_v1_paths": producer_provenance_v1_paths,
            "linearization_identity_sha256_by_sample": serde_json::json!({}),
        },
        "resources": {
            "spectrum_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            "branches_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
            "dispersion_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
            "mode_field_resources": mode_resource_keys,
        },
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
        },
        "cross_artifact_refs": [
            {
                "relation": "source_spectrum",
                "artifact": "eigen/spectrum.v2.json",
                "revision": spectrum_revision,
            },
            {
                "relation": "source_branches",
                "artifact": "eigen/branches.v2.json",
                "revision": branches_revision,
            },
        ],
    });
    if summary_payload
        .get("solver_diagnostics")
        .and_then(|value| value.get("linearization_state_sha256"))
        .is_some()
    {
        if let Some(artifacts) = manifest
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            let handoff = &summary_payload["solver_diagnostics"]["linearization_handoff"];
            if handoff["accepted_for_frequency_operator"].as_bool() != Some(true) {
                return Err(RunError { message: "equilibrium_artifact_schema_pair_invalid: missing accepted linearization handoff".to_string() });
            }
            let (equilibrium_filename, _) =
                super::eigen_equilibrium_contract::certified_equilibrium_artifact_filenames(
                    handoff["equilibrium_artifact_schema"].as_str(),
                    handoff["linearization_state_schema"].as_str(),
                )?;
            let canonical_material = equilibrium_filename == "equilibrium_artifact.v8.json";
            artifacts.insert(
                if canonical_material {
                    "equilibrium_artifact_v8_path"
                } else {
                    "equilibrium_artifact_v7_path"
                }
                .to_string(),
                serde_json::json!(if canonical_material {
                    "eigen/metadata/equilibrium_artifact.v8.json"
                } else {
                    "eigen/metadata/equilibrium_artifact.v7.json"
                }),
            );
            artifacts.insert(
                if canonical_material {
                    "linearization_state_v7_path"
                } else {
                    "linearization_state_v6_path"
                }
                .to_string(),
                serde_json::json!(if canonical_material {
                    "eigen/metadata/linearization_state.v7.json"
                } else {
                    "eigen/metadata/linearization_state.v6.json"
                }),
            );
        }
    }
    if r4_coverage.has_any_sidecars {
        if let Some(artifacts) = manifest
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            for (key, _, _) in R4_SIDECAR_DEFINITIONS {
                let paths = r4_coverage
                    .paths_by_key
                    .get(key)
                    .cloned()
                    .unwrap_or_default();
                artifacts.insert(key.to_string(), serde_json::json!(paths));
            }
            let consumer_plan_paths = r4_coverage
                .paths_by_key
                .get("consumer_plan_snapshot_v1_paths")
                .cloned()
                .unwrap_or_default();
            artifacts.insert(
                "consumer_plan_snapshot_v1_path".to_string(),
                consumer_plan_paths
                    .first()
                    .filter(|_| consumer_plan_paths.len() == 1)
                    .map_or(serde_json::Value::Null, |path| {
                        serde_json::json!(path)
                    }),
            );
            artifacts.insert(
                "linearization_identity_sha256_by_sample".to_string(),
                serde_json::json!(r4_coverage.identity_content_sha256_by_sample.clone()),
            );
        }
    } else if let Some(artifacts) = manifest
        .get_mut("artifacts")
        .and_then(serde_json::Value::as_object_mut)
    {
        artifacts.remove("linearization_identity_sha256_by_sample");
    }
    if nonshared_floquet_coverage.has_any_sidecars {
        if let Some(artifacts) = manifest
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            // Preserve the historical three-sidecar selector and aliases.
            for (key, _, alias) in NONSHARED_FLOQUET_SIDECAR_DEFINITIONS {
                let paths = nonshared_floquet_coverage
                    .paths_by_key
                    .get(key)
                    .cloned()
                    .unwrap_or_default();
                artifacts.insert(key.to_string(), serde_json::json!(paths));
                artifacts.insert(
                    alias.to_string(),
                    paths
                        .first()
                        .filter(|_| {
                            nonshared_floquet_coverage.structural_complete && paths.len() == 1
                        })
                        .map_or(serde_json::Value::Null, |path| serde_json::json!(path)),
                );
            }
        }
    }
    if nonshared_floquet_native_input_diagnostics_coverage.has_any_sidecars {
        if let Some(artifacts) = manifest
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            // The final C ABI diagnostic pair is additive structural evidence;
            // it is kept separate from historical three-sidecar coverage.
            for (key, _, alias) in
                NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS
            {
                let paths = nonshared_floquet_native_input_diagnostics_coverage
                    .paths_by_key
                    .get(key)
                    .cloned()
                    .unwrap_or_default();
                artifacts.insert(key.to_string(), serde_json::json!(paths));
                artifacts.insert(
                    alias.to_string(),
                    paths
                        .first()
                        .filter(|_| {
                            nonshared_floquet_native_input_diagnostics_coverage
                                .structural_complete
                                && paths.len() == 1
                        })
                        .map_or(serde_json::Value::Null, |path| serde_json::json!(path)),
                );
            }
        }
    }
    if let Some(diagnostics) = manifest
        .get_mut("diagnostics")
        .and_then(serde_json::Value::as_object_mut)
    {
        diagnostics.insert("r4_replay".to_string(), r4_coverage.manifest_value());
        diagnostics.insert(
            "nonshared_floquet_replay".to_string(),
            nonshared_floquet_coverage.manifest_value(),
        );
        diagnostics.insert(
            "nonshared_floquet_native_input_diagnostics_replay".to_string(),
            nonshared_floquet_native_input_diagnostics_coverage.manifest_value(),
        );
    }
    if let (Some(manifest_object), Some(diagnostics_object)) = (
        manifest.as_object_mut(),
        summary_payload["solver_diagnostics"].as_object(),
    ) {
        for key in [
            "physics_contract_version",
            "operator_dictionary_version",
            "implementation_state",
            "validation_state",
            "validated_scope",
            "requested_execution",
            "resolved_execution",
            "assembly_kind",
            "operator_input_signature_sha256",
            "phase_constraint_sha256",
            "equilibrium_artifact_sha256",
            "linearization_state_sha256",
            "linearization_identity_sha256",
            "periodic_mesh_certificate_sha256",
            "relax_to_eigen_handoff_sha256",
            "relax_to_eigen_source_mesh_topology_sha256",
            "source_mesh_topology_sha256",
            "boundary_gauge",
            "spectral",
            "block_residuals",
            "device_transfer_audit",
            "engine_id",
            "solve_succeeded",
            "fields_available",
            "spectrum_completeness",
            "window_complete",
        ] {
            if let Some(value) = diagnostics_object.get(key) {
                manifest_object.insert(key.to_string(), value.clone());
            }
        }
        if let Some(contract_object) = publication_contract.as_object() {
            for (key, value) in contract_object {
                manifest_object.insert(key.clone(), value.clone());
            }
        }
        if let Some(validation) = plan.dispersion_validation.as_ref() {
            manifest_object.insert(
                "validation".to_string(),
                serde_json::json!({"dispersion_validation": validation}),
            );
        } else {
            // Keep the manifest schema explicit for direct single-point modal
            // solves.  Consumers distinguish an empty validation object
            // (executed but not analytically certified) from a missing field.
            manifest_object.insert("validation".to_string(), serde_json::json!({}));
        }
    }
    auxiliary_artifacts.push(json_artifact(
        "frequency_domain/manifest.v1.json",
        &manifest,
    )?);

    Ok(())
}

fn modal_boundary_context(plan: &FemEigenPlanIR) -> &'static str {
    match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet => "floquet_periodic",
        SpinWaveBoundaryKindIR::Free
        | SpinWaveBoundaryKindIR::Pinned
        | SpinWaveBoundaryKindIR::SurfaceAnisotropy => "finite_open",
    }
}

fn modal_k_sampling_manifest(k_sampling: Option<&KSamplingIR>) -> serde_json::Value {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => serde_json::json!({
            "kind": "single",
            "vector_rad_per_m": k_vector,
        }),
        Some(KSamplingIR::Path {
            points,
            samples_per_segment,
            closed,
        }) => serde_json::json!({
            "kind": "path",
            "points": points,
            "samples_per_segment": samples_per_segment,
            "closed": closed,
        }),
        None => serde_json::Value::Null,
    }
}

pub(super) fn normalization_label(normalization: EigenNormalizationIR) -> &'static str {
    match normalization {
        EigenNormalizationIR::UnitL2 => "unit_l2",
        EigenNormalizationIR::UnitMaxAmplitude => "unit_max_amplitude",
    }
}

pub(super) fn modal_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    solver_model: &str,
    mode_count: usize,
) -> serde_json::Value {
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": solver_model,
        "resolved_solver_family": solver_model,
        "spectral_transform": "none",
        "algebraic_form": "reference_effective_field_generalized",
        "matrix_equation": "K u = lambda M u",
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
        "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
        "production_gyrotropic_mapping": false,
        "sample_count": 1,
        "mode_count": mode_count,
        "requested_mode_count": plan.count,
        "normalization": normalization_label(plan.normalization),
    });
    merge_modal_transport_diagnostics(&mut diagnostics, modal_tangent_transport_diagnostics(plan));
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut subwindows = Vec::with_capacity(subwindow_count);
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        for index in 0..subwindow_count {
            let sub_min = frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
            let sub_max =
                frequency_min_hz + (index + 1) as f64 * window_width / subwindow_count as f64;
            let sub_width = sub_max - sub_min;
            let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
            let search_max = sub_max + guard_fraction * sub_width;
            let shift_frequency_hz = 0.5 * (sub_min + sub_max);
            resolved_min_hz = resolved_min_hz.min(search_min);
            resolved_max_hz = resolved_max_hz.max(search_max);
            subwindows.push(serde_json::json!({
                "index": index,
                "requested_hz": [sub_min, sub_max],
                "search_hz": [search_min, search_max],
                "shift_hz": shift_frequency_hz,
                "shift_frequency_hz": shift_frequency_hz,
                "shift_omega_rad_s": 2.0 * std::f64::consts::PI * shift_frequency_hz,
                "outer_iterations": 0,
                "linear_iterations_total": 0,
                "candidate_modes": 0,
                "accepted_modes": 0,
                "residual_max": 0.0,
                "stop_reason": "window_exhausted",
            }));
        }
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": 0,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            object.insert("subwindows".to_string(), serde_json::json!(subwindows));
        }
    }
    if let Some(reason) = native_cpu_modal_window_rejection_reason(plan) {
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "production_cpu_rejection_reason".to_string(),
                serde_json::json!(reason),
            );
            object.insert(
                "production_cpu_rejection_scope".to_string(),
                serde_json::json!(native_cpu_modal_window_rejection_scope(reason)),
            );
            insert_native_cpu_modal_window_rejection_contract(object, reason);
        }
    }
    diagnostics
}

pub(crate) fn modal_tangent_transport_diagnostics(plan: &FemEigenPlanIR) -> serde_json::Value {
    if !matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return serde_json::json!({
            "basis_transport_policy": "not_applicable",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
        });
    }

    let topology = match MeshTopology::from_ir(&plan.mesh) {
        Ok(topology) => topology,
        Err(error) => {
            return serde_json::json!({
                "basis_transport_policy": "unavailable",
                "basis_transport_error": format!("MeshTopology: {}", error),
                "floquet_tangent_frame_max_mismatch": f64::NAN,
                "floquet_tangent_transport_max_nonunitarity": f64::NAN,
            });
        }
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    let bases = tangent_bases(&plan.equilibrium_magnetization);
    let mut max_mismatch: f64 = 0.0;
    let mut max_nonunitarity: f64 = 0.0;
    for (_, node_a, node_b) in selected_pairs {
        let node_a = node_a as usize;
        let node_b = node_b as usize;
        if node_a >= bases.len()
            || node_b >= bases.len()
            || topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let transport = tangent_transport_matrix(bases[node_a], bases[node_b]);
        max_mismatch = max_mismatch.max(tangent_frame_identity_mismatch(
            bases[node_a],
            bases[node_b],
        ));
        max_nonunitarity = max_nonunitarity.max(tangent_transport_nonunitarity(transport));
    }
    serde_json::json!({
        "basis_transport_policy": if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "tangent_frame_transport"
        } else {
            "tangent_frame_identity"
        },
        "floquet_tangent_frame_max_mismatch": max_mismatch,
        "floquet_tangent_transport_max_nonunitarity": max_nonunitarity,
    })
}

pub(super) fn merge_modal_transport_diagnostics(
    target: &mut serde_json::Value,
    transport: serde_json::Value,
) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(transport_object) = transport.as_object() else {
        return;
    };
    for (key, value) in transport_object {
        target_object.insert(key.clone(), value.clone());
    }
}

pub(super) fn damping_policy_label(policy: EigenDampingPolicyIR) -> &'static str {
    match policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

pub(super) fn damping_imaginary_factor(damping: f64, policy: EigenDampingPolicyIR) -> f64 {
    match policy {
        EigenDampingPolicyIR::Ignore => 0.0,
        EigenDampingPolicyIR::Include => damping.abs() / (1.0 + damping * damping),
    }
}

pub(super) fn spin_wave_bc_label(bc: SpinWaveBoundaryConditionIR) -> &'static str {
    match bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

pub(super) fn spin_wave_bc_json(bc: &SpinWaveBoundaryConditionIR) -> serde_json::Value {
    serde_json::json!({
        "kind": spin_wave_bc_label(bc.clone()),
        "boundary_pair_id": bc.boundary_pair_id(),
        "pair_ids": bc.boundary_pair_ids(),
        "phase_convention": bc.phase_convention(),
        "surface_anisotropy_ks": bc.surface_anisotropy_ks(),
        "surface_anisotropy_axis": bc.surface_anisotropy_axis(),
    })
}

pub(super) fn solver_kind_label(plan: &FemEigenPlanIR) -> &'static str {
    if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "cpu_full_2x2_phase_reduced_floquet"
        } else {
            "cpu_phase_reduced_floquet"
        }
    } else {
        match (plan.operator.kind, plan.damping_policy) {
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Ignore) => {
                "cpu_full_2x2_symmetric"
            }
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Include) => {
                "cpu_full_2x2_damped"
            }
            (_, EigenDampingPolicyIR::Ignore) => "cpu_reference_symmetric",
            (_, EigenDampingPolicyIR::Include) => "cpu_generalized_eigen",
        }
    }
}

pub(super) fn solver_notes(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> &'static str {
    if complex_reduction && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "phase-aware Floquet reduction on the full 2x2 tangent-frame block with phase*(T_node^T T_root) transport"
    } else if complex_reduction {
        "phase-aware periodic reduction on a real doubled Hermitian block"
    } else if use_sparse && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "sparse LOBPCG on full 2×2 Herring-Kittel block operator (2N DOF)"
    } else if use_sparse {
        "sparse LOBPCG iterative eigensolver for large DOF systems"
    } else if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "full 2×2 Herring-Kittel block operator in tangent plane (2N DOF)"
    } else if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        "damping artifacts use first-order alpha linewidth correction over the CPU reference eigenbasis"
    } else {
        "cpu reference symmetric eigen solve"
    }
}

pub(super) fn solver_capabilities(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut capabilities = vec!["cpu_reference_eigen", "artifact_backed_analyze"];
    if use_sparse {
        capabilities.push("sparse_lobpcg");
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        capabilities.push("full_2x2_herring_kittel");
    }
    match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => capabilities.push("free_bc"),
        SpinWaveBoundaryKindIR::Pinned => capabilities.push("pinned_bc"),
        SpinWaveBoundaryKindIR::Periodic => capabilities.push("periodic_zero_phase"),
        SpinWaveBoundaryKindIR::Floquet => capabilities.push("floquet_phase_reduction"),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            capabilities.push("surface_anisotropy_boundary_term")
        }
    }
    if plan.enable_exchange {
        capabilities.push("exchange");
    }
    if plan.enable_demag {
        match resolved_demag_realization(plan)
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
        {
            fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => {
                capabilities.push("demag_poisson_dirichlet")
            }
            fullmag_ir::ResolvedFemDemagIR::PoissonRobin => {
                capabilities.push("demag_poisson_robin")
            }
            fullmag_ir::ResolvedFemDemagIR::Bem => capabilities.push("demag_bem"),
            fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => {
                capabilities.push("demag_fredkin_koehler")
            }
            fullmag_ir::ResolvedFemDemagIR::Fmm => capabilities.push("demag_fmm"),
        }
    }
    if plan.external_field.is_some() {
        capabilities.push("zeeman");
    }
    if plan.interfacial_dmi.is_some() {
        capabilities.push("interfacial_dmi");
    }
    if plan.bulk_dmi.is_some() {
        capabilities.push("bulk_dmi");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        capabilities.push("damping_linewidth_metadata");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        capabilities.push("frequency_window_filter");
    }
    if complex_reduction {
        capabilities.push("complex_mode_projection");
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            capabilities.push("floquet_tangent_frame_transport");
        }
    }
    capabilities
}

pub(super) fn solver_limitations(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut limitations = Vec::new();
    if use_sparse {
        limitations.push("sparse_lobpcg_may_miss_modes_near_degeneracy");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        limitations.push("frequency_window_is_filtered_after_reference_solve");
        limitations.push("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates");
        limitations.push("no_shift_invert_or_feast_window_solver_yet");
    }
    if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        limitations.push("scalar_projection_only_accurate_for_uniform_equilibrium");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        limitations.push("no_generalized_qz_backend");
        limitations.push("damping_is_first_order_linewidth_correction");
    }
    if complex_reduction {
        limitations.push("floquet_uses_phase_reduced_hermitian_block");
        if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            limitations.push("scalar_floquet_requires_identity_tangent_frame_transport");
        }
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        limitations.push("dmi_operator_is_cpu_first_reference_approximation");
    }
    if matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy
    ) {
        limitations.push("surface_anisotropy_requires_exposed_boundary_faces");
    }
    limitations
}

pub(super) fn demag_realization_label(realization: fullmag_ir::ResolvedFemDemagIR) -> &'static str {
    realization.provenance_name()
}

pub(super) fn equilibrium_source_json(equilibrium: &EquilibriumSourceIR) -> serde_json::Value {
    match equilibrium {
        EquilibriumSourceIR::Provided => serde_json::json!({ "kind": "provided" }),
        EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

pub(super) fn k_vector_json(k_sampling: Option<&KSamplingIR>) -> serde_json::Value {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => serde_json::json!(k_vector),
        Some(KSamplingIR::Path { .. }) => serde_json::json!([0.0, 0.0, 0.0]),
        None => serde_json::Value::Null,
    }
}

pub(super) fn dispersion_csv(
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let mut csv = String::from("mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n");
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            csv.push_str(&format!(
                "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}\n",
                entry["index"].as_u64().unwrap_or(0),
                k_vector[0],
                k_vector[1],
                k_vector[2],
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
            ));
        }
    }
    csv
}

pub(super) fn dispersion_v2_csv(
    sample_index: usize,
    sample_id: &str,
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
    visualizable_mode_indices: &BTreeSet<u64>,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let mut csv = String::from(
        "sample_index,sample_id,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,mode_id,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_available,mode_field_id,mode_field_resource_key\n",
    );
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            let raw_mode_index = entry["index"].as_u64().unwrap_or(0);
            let mode_field_available = visualizable_mode_indices.contains(&raw_mode_index);
            let (field_id, field_resource_key) = if mode_field_available {
                (
                    mode_field_id(sample_index, raw_mode_index),
                    mode_field_resource_key(sample_index, raw_mode_index),
                )
            } else {
                (String::new(), String::new())
            };
            let residual_norm = entry["residual_norm"]
                .as_f64()
                .map(|value| format!("{value:.16e}"))
                .unwrap_or_default();
            let line_width_hz = entry["frequency_imag_hz"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| format!("{:.16e}", 2.0 * value))
                .unwrap_or_default();
            let mode_id = format!("sample-{sample_index:04}/mode-{raw_mode_index:04}");
            csv.push_str(&format!(
                "{sample_index},{},{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{},{:.16e},{:.16e},{},{},{},seed,{},{},{}\n",
                sample_id,
                0.0,
                k_vector[0],
                k_vector[1],
                k_vector[2],
                label,
                raw_mode_index,
                mode_id,
                raw_mode_index,
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                line_width_hz,
                residual_norm,
                "",
                mode_field_available,
                field_id,
                field_resource_key,
            ));
        }
    }
    csv
}

/// Classify the dominant polarization character of a spin-wave mode.
///
/// Heuristics (all for the real scalar LLG linearization):
/// - `"uniform"`: mode amplitude is spatially homogeneous (Kittel / macrospin mode).
///   Criterion: mean amplitude over active nodes ≥ 60 % of the maximum.
/// - `"op"`: equilibrium is predominantly out-of-plane (|⟨mz⟩| > 0.7 ⇒ mz-dominated modes).
/// - `"ip"`: default for in-plane equilibrium configurations.
/// - `"mixed"`: fallback when the active node set is empty or max amplitude is degenerate.
pub(super) fn classify_polarization(
    amplitude: &[f64],
    active_nodes: &[usize],
    equilibrium: &[Vector3],
    max_amplitude: f64,
) -> &'static str {
    if active_nodes.is_empty() || max_amplitude < 1e-30 {
        return "mixed";
    }

    let n = active_nodes.len() as f64;

    // Spatial uniformity: mean / max over active nodes.
    let mean_amplitude: f64 = active_nodes.iter().map(|&i| amplitude[i]).sum::<f64>() / n;
    if mean_amplitude / max_amplitude > 0.6 {
        return "uniform";
    }

    // Determine equilibrium orientation: average |mz| over active nodes.
    let mean_mz_abs: f64 = if equilibrium.len() > *active_nodes.iter().max().unwrap_or(&0) {
        active_nodes
            .iter()
            .map(|&i| equilibrium[i][2].abs())
            .sum::<f64>()
            / n
    } else {
        0.0
    };

    if mean_mz_abs > 0.7 {
        "op"
    } else {
        "ip"
    }
}

#[cfg(test)]
mod floquet_potential_tests {
    use super::*;

    #[test]
    fn floquet_potential_publication_roundtrips_digest_and_shape() {
        let values = [
            Complex64::new(1.0, -2.0),
            Complex64::new(3.0, -4.0),
            Complex64::new(5.0, -6.0),
            Complex64::new(7.0, -8.0),
        ];
        let bytes = floquet_potential_payload_bytes(&values)
            .expect("even finite Floquet coefficients should serialize");
        let mode = serde_json::json!({
            "index": 2,
            "floquet_descriptor_certified": true,
            "floquet_geometric_bc_certified": false,
            "potential_representation": "doubled_real_split_complex_coefficients",
            "magnetic_relative_residual": 1.0e-10,
            "potential_relative_residual": 2.0e-10,
            "potential_dof_count": values.len(),
        });
        let path = floquet_potential_payload_path(3, 2);
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: path.clone(),
            bytes: bytes.clone(),
        }];

        let (metadata, publications) = collect_floquet_potential_publications(
            &[mode],
            &BTreeSet::from([2_u32]),
            &artifacts,
            3,
        )
        .expect("valid Floquet publication should be accepted");
        assert_eq!(metadata[&2].potential_dof_count, values.len());
        let publication = &publications[&2];
        assert_eq!(publication.payload_path, path);
        assert_eq!(publication.payload_value_count, values.len() * 2);
        assert_eq!(
            publication.payload_sha256,
            format!("sha256:{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(
            floquet_publication_json(publication)["potential_binary_layout"],
            "complex_f64_pairs_little_endian"
        );
    }

    #[test]
    fn floquet_potential_publication_rejects_noncertified_payload() {
        let mode = serde_json::json!({
            "index": 0,
            "floquet_descriptor_certified": false,
        });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: floquet_potential_payload_path(0, 0),
            bytes: vec![0; 32],
        }];

        let error = collect_floquet_potential_publications(
            &[mode],
            &BTreeSet::from([0_u32]),
            &artifacts,
            0,
        )
        .expect_err("non-certified mode must not publish a potential payload");
        assert!(error.message.contains("non-certified"));
    }

    #[test]
    fn physical_floquet_potential_does_not_require_legacy_sidecar() {
        let mode = serde_json::json!({
            "index": 4,
            "floquet_descriptor_certified": true,
            "floquet_full_descriptor_certified": true,
            "floquet_seam_frame_certified": true,
            "floquet_gauge_policy_satisfied": true,
            "floquet_geometric_bc_certified": false,
            "potential_representation": "complex_coefficients",
            "potential_dof_count": 51,
            "magnetic_relative_residual": 1.0e-12,
            "potential_relative_residual": 2.0e-12,
        });

        let (metadata, publications) =
            collect_floquet_potential_publications(&[mode], &BTreeSet::from([4_u32]), &[], 2)
                .expect(
                    "physical potential is carried by the q/phi payload, not the legacy sidecar",
                );
        assert!(metadata.is_empty());
        assert!(publications.is_empty());
    }

    #[test]
    fn floquet_potential_publication_rejects_nonfinite_payload_bytes() {
        let mode = serde_json::json!({
            "index": 1,
            "floquet_descriptor_certified": true,
            "floquet_geometric_bc_certified": false,
            "potential_representation": "doubled_real_split_complex_coefficients",
            "magnetic_relative_residual": 1.0e-10,
            "potential_relative_residual": 2.0e-10,
            "potential_dof_count": 2,
        });
        let mut bytes = vec![0; 32];
        bytes[0..8].copy_from_slice(&f64::NAN.to_le_bytes());
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: floquet_potential_payload_path(0, 1),
            bytes,
        }];

        let error = collect_floquet_potential_publications(
            &[mode],
            &BTreeSet::from([1_u32]),
            &artifacts,
            0,
        )
        .expect_err("non-finite coefficient must be rejected");
        assert!(error.message.contains("non-finite"));
    }
}

#[cfg(test)]
mod linearization_identity_sidecar_tests {
    use super::*;
    use crate::types::AuxiliaryArtifact;
    use sha2::{Digest, Sha256};

    fn identity_fixture(
        sample_index: usize,
    ) -> super::super::eigen_equilibrium_contract::LinearizationIdentityV2 {
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut identity: super::super::eigen_equilibrium_contract::LinearizationIdentityV2 = serde_json::from_value(serde_json::json!({
            "schema_version": super::super::eigen_equilibrium_contract::LINEARIZATION_IDENTITY_V2,
            "sample_index": sample_index,
            "equilibrium_artifact_schema": "equilibrium_artifact.v8",
            "linearization_state_schema": "LinearizationState.v7",
            "accepted_fields_schema": "CertifiedFemEquilibriumFields.v2",
            "certified_fields_schema": "CertifiedFemEquilibriumFields.v2",
            "recomputed_certificate_schema": "RecomputedFemLinearizationCertificate.v1",
            "handoff_schema_version": "AcceptedFemRelaxStageHandoff.v2",
            "handoff_content_sha256": digest.clone(),
            "source_run_id": "run-test",
            "source_stage_id": "stage-test",
            "source_stage_kind": "relaxation",
            "producer_plan_snapshot_sha256": digest.clone(),
            "consumer_plan_snapshot_sha256": digest.clone(),
            "producer_build_identity": {"source_snapshot_sha256": "a".repeat(64)},
            "consumer_build_identity": {"source_snapshot_sha256": "a".repeat(64)},
            "producer_source_snapshot_sha256": "a".repeat(64),
            "consumer_source_snapshot_sha256": "a".repeat(64),
            "cross_build_policy": "same_source_snapshot_required",
            "source_mesh_topology_sha256": digest.clone(),
            "modal_mesh_topology_fingerprint_v3": digest.clone(),
            "node_count": 2,
            "equilibrium_content_sha256": digest.clone(),
            "equilibrium_artifact_path": "eigen/metadata/equilibrium_artifact.v8.json",
            "equilibrium_artifact_sha256": digest.clone(),
            "linearization_state_path": "eigen/metadata/linearization_state.v7.json",
            "linearization_state_sha256": digest.clone(),
            "equilibrium_material_signature": digest.clone(),
            "equilibrium_material_preimage_json": "{}",
            "equilibrium_static_physics_signature": digest.clone(),
            "equilibrium_static_physics_preimage_json": "{}",
            "equilibrium_boundary_signature": digest.clone(),
            "equilibrium_boundary_preimage_json": "{}",
            "material_signature": digest.clone(),
            "material_identity_kind": "canonical_equilibrium_material.v2",
            "material_provenance_signature": digest.clone(),
            "material_provenance_scope": "materialization_plan",
            "material_provenance_preimage_json": "{}",
            "producer_material_provenance_signature": digest.clone(),
            "producer_material_provenance_preimage_json": "{}",
            "accepted_fields_content_sha256": digest.clone(),
            "accepted_fields_path": "eigen/metadata/sample_0003/accepted_fem_equilibrium_fields.v2.json",
            "certified_fields_content_sha256": digest.clone(),
            "certified_fields_path": "eigen/metadata/sample_0003/certified_fem_equilibrium_fields.v2.json",
            "recomputed_certificate_content_sha256": digest.clone(),
            "recomputed_certificate_path": "eigen/metadata/sample_0003/recomputed_fem_linearization_certificate.v2.json",
            "accepted_fields_bytes_sha256": digest.clone(),
            "certified_fields_bytes_sha256": digest.clone(),
            "recomputed_certificate_bytes_sha256": digest.clone(),
            "recomputed_certificate_preimage_json": "{}",
            "recomputed_certificate_preimage_sha256": digest,
            "content_sha256": ""
        }))
        .expect("sidecar fixture must deserialize");
        let preimage = serde_json::to_vec(&identity).expect("identity preimage must serialize");
        identity.content_sha256 = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_content_sha256_from_preimage_bytes(&preimage);
        identity
    }

    fn complete_r4_fixture(sample_index: usize, consumer_plan_bytes: &[u8]) -> Vec<AuxiliaryArtifact> {
        let mut identity = identity_fixture(sample_index);
        let sample_prefix = format!("eigen/metadata/sample_{sample_index:04}");
        identity.recomputed_certificate_schema =
            "RecomputedFemLinearizationCertificate.v2".to_string();
        identity.equilibrium_artifact_path =
            format!("{sample_prefix}/equilibrium_artifact.v8.json");
        identity.linearization_state_path =
            format!("{sample_prefix}/linearization_state.v7.json");
        identity.accepted_fields_path =
            format!("{sample_prefix}/accepted_fem_equilibrium_fields.v2.json");
        identity.certified_fields_path =
            format!("{sample_prefix}/certified_fem_equilibrium_fields.v2.json");
        identity.recomputed_certificate_path =
            format!("{sample_prefix}/recomputed_fem_linearization_certificate.v2.json");
        identity.consumer_plan_snapshot_sha256 =
            format!("sha256:{:x}", Sha256::digest(consumer_plan_bytes));

        let accepted_fields = crate::types::CertifiedFemEquilibriumFields::from_fields_with_anisotropy(
            vec![[1.0, 0.0, 0.0]; 2],
            vec![[0.0, 1.0, 0.0]; 2],
            vec![[0.0, 0.0, 1.0]; 2],
            vec![[1.0, 1.0, 0.0]; 2],
            vec![[2.0, 2.0, 2.0]; 2],
            vec![0.0; 2],
        )
        .expect("accepted V2 fields fixture must be valid");
        let certified_fields = crate::types::CertifiedFemEquilibriumFields::from_fields_with_anisotropy(
            vec![[1.5, 0.0, 0.0]; 2],
            vec![[0.0, 1.5, 0.0]; 2],
            vec![[0.0, 0.0, 1.5]; 2],
            vec![[1.5, 1.5, 0.0]; 2],
            vec![[3.0, 3.0, 3.0]; 2],
            vec![0.0; 2],
        )
        .expect("certified V2 fields fixture must be valid");
        let accepted_bytes =
            serde_json::to_vec(&accepted_fields).expect("accepted fields must serialize");
        let certified_bytes =
            serde_json::to_vec(&certified_fields).expect("certified fields must serialize");
        identity.accepted_fields_content_sha256 = accepted_fields.content_sha256.clone();
        identity.certified_fields_content_sha256 = certified_fields.content_sha256.clone();
        identity.accepted_fields_bytes_sha256 =
            format!("sha256:{:x}", Sha256::digest(&accepted_bytes));
        identity.certified_fields_bytes_sha256 =
            format!("sha256:{:x}", Sha256::digest(&certified_bytes));

        let mut recomputed_certificate =
            crate::types::RecomputedFemLinearizationCertificateV1 {
                schema_version: "RecomputedFemLinearizationCertificate.v2".to_string(),
                status: "matched".to_string(),
                recompute_provider: "prepared-r4-fixture".to_string(),
                node_count: 2,
                equilibrium_content_sha256: identity.equilibrium_content_sha256.clone(),
                mesh_topology_sha256: identity.source_mesh_topology_sha256.clone(),
                equilibrium_material_signature: identity.equilibrium_material_signature.clone(),
                equilibrium_static_physics_signature: identity
                    .equilibrium_static_physics_signature
                    .clone(),
                equilibrium_boundary_signature: identity.equilibrium_boundary_signature.clone(),
                accepted_fields_content_sha256: accepted_fields.content_sha256.clone(),
                recomputed_fields_content_sha256: certified_fields.content_sha256.clone(),
                max_h_ex_difference_a_per_m: 0.0,
                max_h_demag_difference_a_per_m: 0.0,
                max_h_ext_difference_a_per_m: 0.0,
                max_h_anisotropy_difference_a_per_m: Some(0.0),
                max_h_eff_difference_a_per_m: 0.0,
                max_phi_difference_a: 0.0,
                field_absolute_tolerance_a_per_m:
                    crate::types::FEM_LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
                field_relative_tolerance: crate::types::FEM_LINEARIZATION_FIELD_RELATIVE_TOLERANCE,
                phi_absolute_tolerance_a: crate::types::FEM_LINEARIZATION_PHI_ABSOLUTE_TOLERANCE_A,
                content_sha256: String::new(),
            };
        recomputed_certificate.content_sha256 =
            crate::types::recomputed_fem_linearization_certificate_sha256(
                &recomputed_certificate,
            )
            .expect("recomputed certificate fixture must hash");
        let recomputed_bytes = serde_json::to_vec(&recomputed_certificate)
            .expect("recomputed certificate must serialize");
        let recomputed_preimage =
            crate::types::recomputed_fem_linearization_certificate_preimage_bytes(
                &recomputed_certificate,
            )
            .expect("recomputed certificate preimage must serialize");
        identity.recomputed_certificate_content_sha256 =
            recomputed_certificate.content_sha256.clone();
        identity.recomputed_certificate_bytes_sha256 =
            format!("sha256:{:x}", Sha256::digest(&recomputed_bytes));
        identity.recomputed_certificate_preimage_json =
            String::from_utf8(recomputed_preimage.clone()).expect("preimage must be UTF-8");
        identity.recomputed_certificate_preimage_sha256 =
            format!("sha256:{:x}", Sha256::digest(&recomputed_preimage));

        identity.content_sha256.clear();
        let identity_preimage =
            serde_json::to_vec(&identity).expect("identity fixture preimage must serialize");
        identity.content_sha256 = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_content_sha256_from_preimage_bytes(&identity_preimage);
        let identity_bytes = serde_json::to_vec(&identity).expect("identity must serialize");
        let identity_preimage_sidecar = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_preimage_sidecar_bytes(&identity)
            .expect("identity preimage sidecar must serialize");
        let equilibrium_bytes = serde_json::to_vec(&serde_json::json!({
            "content_sha256": identity.equilibrium_artifact_sha256,
        }))
        .expect("equilibrium fixture must serialize");
        let state_bytes = serde_json::to_vec(&serde_json::json!({
            "content_sha256": identity.linearization_state_sha256,
        }))
        .expect("state fixture must serialize");

        vec![
            AuxiliaryArtifact {
                relative_path: identity.equilibrium_artifact_path.clone(),
                bytes: equilibrium_bytes,
            },
            AuxiliaryArtifact {
                relative_path: identity.linearization_state_path.clone(),
                bytes: state_bytes,
            },
            AuxiliaryArtifact {
                relative_path: identity.accepted_fields_path.clone(),
                bytes: accepted_bytes,
            },
            AuxiliaryArtifact {
                relative_path: identity.certified_fields_path.clone(),
                bytes: certified_bytes,
            },
            AuxiliaryArtifact {
                relative_path: identity.recomputed_certificate_path.clone(),
                bytes: recomputed_bytes,
            },
            AuxiliaryArtifact {
                relative_path: format!(
                    "{sample_prefix}/linearization_identity.v2.json"
                ),
                bytes: identity_bytes,
            },
            AuxiliaryArtifact {
                relative_path: format!(
                    "{sample_prefix}/linearization_identity_preimage.v1.json"
                ),
                bytes: identity_preimage_sidecar,
            },
            AuxiliaryArtifact {
                relative_path: super::super::eigen_equilibrium_contract::
                    consumer_plan_snapshot_relative_path(sample_index),
                bytes: consumer_plan_bytes.to_vec(),
            },
        ]
    }

    #[test]
    fn complete_r4_single_k_sidecars_are_structurally_replayable() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let consumer_plan_bytes =
            super::super::eigen_equilibrium_contract::consumer_plan_snapshot_bytes(&plan)
                .expect("consumer plan fixture must serialize");
        let artifacts = complete_r4_fixture(0, &consumer_plan_bytes);

        let coverage = inspect_r4_sidecars(&artifacts, &[0]);

        assert_eq!(coverage.status, "payload_replay_pending");
        assert!(coverage.structural_complete);
        assert_eq!(coverage.accepted_family.as_deref(), Some("v2"));
        assert_eq!(coverage.accepted_sample_indices, BTreeSet::from([0_usize]));
        assert_eq!(coverage.identity_sample_indices, BTreeSet::from([0_usize]));
        assert_eq!(
            coverage.paths_by_key["consumer_plan_snapshot_v1_paths"],
            vec![
                "eigen/metadata/sample_0000/consumer_plan_snapshot.v1.json".to_string()
            ]
        );
    }

    #[test]
    fn complete_r4_multi_k_sidecars_cover_every_computed_sample() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let consumer_plan_bytes =
            super::super::eigen_equilibrium_contract::consumer_plan_snapshot_bytes(&plan)
                .expect("consumer plan fixture must serialize");
        let artifacts = complete_r4_fixture(0, &consumer_plan_bytes)
            .into_iter()
            .chain(complete_r4_fixture(2, &consumer_plan_bytes))
            .collect::<Vec<_>>();

        let coverage = inspect_r4_sidecars(&artifacts, &[0, 2]);

        assert_eq!(coverage.status, "payload_replay_pending");
        assert!(coverage.structural_complete);
        assert_eq!(coverage.accepted_family.as_deref(), Some("v2"));
        assert_eq!(
            coverage.computed_sample_indices,
            BTreeSet::from([0_usize, 2_usize])
        );
        assert_eq!(
            coverage.accepted_sample_indices,
            BTreeSet::from([0_usize, 2_usize])
        );
        assert_eq!(
            coverage.identity_sample_indices,
            BTreeSet::from([0_usize, 2_usize])
        );
        assert_eq!(
            coverage.paths_by_key["consumer_plan_snapshot_v1_paths"],
            vec![
                "eigen/metadata/sample_0000/consumer_plan_snapshot.v1.json".to_string(),
                "eigen/metadata/sample_0002/consumer_plan_snapshot.v1.json".to_string(),
            ]
        );
    }

    fn published_fixture(
        sample_index: usize,
    ) -> (
        serde_json::Value,
        Vec<AuxiliaryArtifact>,
        super::super::eigen_equilibrium_contract::LinearizationIdentityV2,
        Vec<u8>,
    ) {
        let identity = identity_fixture(sample_index);
        let identity_path =
            format!("eigen/metadata/sample_{sample_index:04}/linearization_identity.v2.json");
        let preimage_path = format!(
            "eigen/metadata/sample_{sample_index:04}/linearization_identity_preimage.v1.json"
        );
        let identity_bytes = serde_json::to_vec(&identity).expect("identity must serialize");
        let preimage_sidecar = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_preimage_sidecar_bytes(&identity)
            .expect("valid identity must produce a sidecar");
        let preimage: super::super::eigen_equilibrium_contract::LinearizationIdentityPreimageV1 =
            serde_json::from_slice(&preimage_sidecar).expect("sidecar must deserialize");
        let preimage_bytes = preimage.identity_preimage_json.as_bytes().to_vec();
        let summary = serde_json::json!({
            "solver_diagnostics": {
                "linearization_identity_sha256": identity.content_sha256.clone()
            }
        });
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path: identity_path,
                bytes: identity_bytes,
            },
            AuxiliaryArtifact {
                relative_path: preimage_path,
                bytes: preimage_sidecar,
            },
        ];
        (summary, artifacts, identity, preimage_bytes)
    }

    #[test]
    fn source_snapshot_validator_binds_nested_builds_and_cross_build_policy() {
        let identity = identity_fixture(3);
        super::super::eigen_equilibrium_contract::
            validate_linearization_identity_source_snapshots(&identity)
            .expect("canonical raw source snapshots must validate");

        let mut prefixed = identity.clone();
        prefixed.producer_source_snapshot_sha256 = format!("sha256:{}", "a".repeat(64));
        let error = super::super::eigen_equilibrium_contract::
            validate_linearization_identity_source_snapshots(&prefixed)
            .expect_err("prefixed top-level source snapshot must be rejected");
        assert_eq!(error.message, "linearization_identity_source_snapshot_format_invalid");

        let mut nested_mismatch = identity.clone();
        nested_mismatch.producer_build_identity["source_snapshot_sha256"] =
            serde_json::json!("b".repeat(64));
        let error = super::super::eigen_equilibrium_contract::
            validate_linearization_identity_source_snapshots(&nested_mismatch)
            .expect_err("nested producer source snapshot must bind to top-level field");
        assert_eq!(
            error.message,
            "linearization_identity_source_snapshot_binding_mismatch"
        );

        let mut cross_build = identity;
        cross_build.consumer_build_identity["source_snapshot_sha256"] =
            serde_json::json!("b".repeat(64));
        cross_build.consumer_source_snapshot_sha256 = "b".repeat(64);
        let error = super::super::eigen_equilibrium_contract::
            validate_linearization_identity_source_snapshots(&cross_build)
            .expect_err("producer and consumer source snapshots must match");
        assert_eq!(
            error.message,
            "linearization_identity_cross_build_source_snapshot_mismatch"
        );
    }

    #[test]
    fn r4_inspection_rejects_prefixed_snapshot_with_valid_framed_hash() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let consumer_plan_bytes =
            super::super::eigen_equilibrium_contract::consumer_plan_snapshot_bytes(&plan)
                .expect("consumer plan fixture must serialize");
        let mut artifacts = complete_r4_fixture(0, &consumer_plan_bytes);
        let identity_path =
            "eigen/metadata/sample_0000/linearization_identity.v2.json";
        let preimage_path =
            "eigen/metadata/sample_0000/linearization_identity_preimage.v1.json";
        let identity_artifact = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == identity_path)
            .expect("identity fixture must be present");
        let mut identity: super::super::eigen_equilibrium_contract::LinearizationIdentityV2 =
            serde_json::from_slice(&identity_artifact.bytes)
                .expect("identity fixture must deserialize");
        identity.producer_source_snapshot_sha256 = format!("sha256:{}", "a".repeat(64));
        identity.content_sha256.clear();
        let preimage = serde_json::to_vec(&identity).expect("invalid identity must serialize");
        identity.content_sha256 = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_content_sha256_from_preimage_bytes(&preimage);
        let identity_bytes = serde_json::to_vec(&identity).expect("identity must serialize");
        let preimage_sidecar =
            super::super::eigen_equilibrium_contract::LinearizationIdentityPreimageV1 {
                schema_version: super::super::eigen_equilibrium_contract::
                    LINEARIZATION_IDENTITY_PREIMAGE_V1
                    .to_string(),
                identity_schema: super::super::eigen_equilibrium_contract::
                    LINEARIZATION_IDENTITY_V2
                    .to_string(),
                identity_preimage_json: String::from_utf8(preimage.clone())
                    .expect("identity preimage must be UTF-8"),
                identity_preimage_sha256: format!("sha256:{:x}", Sha256::digest(&preimage)),
                identity_content_sha256: identity.content_sha256.clone(),
            };
        let preimage_bytes =
            serde_json::to_vec(&preimage_sidecar).expect("preimage sidecar must serialize");
        for artifact in &mut artifacts {
            if artifact.relative_path == identity_path {
                artifact.bytes = identity_bytes.clone();
            } else if artifact.relative_path == preimage_path {
                artifact.bytes = preimage_bytes.clone();
            }
        }

        let coverage = inspect_r4_sidecars(&artifacts, &[0]);
        assert_eq!(coverage.status, "invalid");
        assert!(coverage.reason.contains("source snapshot validation"));
        assert!(coverage.reason.contains("format_invalid"));

        let summary = serde_json::json!({
            "solver_diagnostics": {
                "linearization_identity_sha256": identity.content_sha256.clone()
            }
        });
        let error = super::validate_published_linearization_identity_sidecars(
            &summary,
            &artifacts,
            0,
        )
        .expect_err("published identity validation must reject prefixed snapshots");
        assert!(error.message.contains("source_snapshot"));
    }

    #[test]
    fn consumer_plan_snapshot_is_bound_to_the_identity_sample_path() {
        let identity = identity_fixture(3);
        let wrong_sample_path =
            super::super::eigen_equilibrium_contract::consumer_plan_snapshot_relative_path(2);
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: wrong_sample_path,
            bytes: b"{}".to_vec(),
        }];
        let error = validate_consumer_plan_snapshot(&identity, &artifacts)
            .expect_err("a different sample path must not satisfy the identity");
        assert!(error.contains("sidecar is missing"));
    }

    #[test]
    fn consumer_plan_snapshot_rejects_bytes_with_a_different_identity_digest() {
        let identity = identity_fixture(3);
        let path =
            super::super::eigen_equilibrium_contract::consumer_plan_snapshot_relative_path(3);
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: path,
            bytes: b"{}".to_vec(),
        }];
        let error = validate_consumer_plan_snapshot(&identity, &artifacts)
            .expect_err("changed bytes must not satisfy the identity digest");
        assert!(error.contains("digest does not match identity"));
    }

    #[test]
    fn single_k_r4_manifest_helper_collects_complete_sample_arrays() {
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0000/accepted_fem_equilibrium_fields.v2.json"
                        .to_string(),
                bytes: b"accepted".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0000/linearization_identity.v2.json".to_string(),
                bytes: b"identity".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: "eigen/metadata/sample_0000/linearization_identity_preimage.v1.json"
                    .to_string(),
                bytes: b"preimage".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0000/certified_fem_equilibrium_fields.v2.json"
                        .to_string(),
                bytes: b"certified".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: "eigen/metadata/sample_0000/recomputed_fem_linearization_certificate.v2.json"
                    .to_string(),
                bytes: b"recomputed".to_vec(),
            },
        ];
        assert_eq!(
            sample_scoped_signed_sidecar_paths(
                &artifacts,
                "accepted_fem_equilibrium_fields.v2.json"
            ),
            vec![
                "eigen/metadata/sample_0000/accepted_fem_equilibrium_fields.v2.json"
            ]
        );
        assert_eq!(
            sample_scoped_signed_sidecar_paths(
                &artifacts,
                "linearization_identity_preimage.v1.json"
            ),
            vec![
                "eigen/metadata/sample_0000/linearization_identity_preimage.v1.json"
            ]
        );
        assert!(sample_scoped_signed_sidecar_paths(
            &artifacts,
            "accepted_fem_equilibrium_fields.v1.json"
        )
        .is_empty());
    }

    #[test]
    fn canonical_sample_paths_use_numeric_order_and_minimum_width() {
        let filename = "linearization_state.v7.json";
        let artifacts = [
            AuxiliaryArtifact {
                relative_path: format!("eigen/metadata/sample_{:04}/{filename}", 10_000),
                bytes: b"large".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: format!("eigen/metadata/sample_{:04}/{filename}", 9_999),
                bytes: b"small".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: format!("eigen/metadata/sample_00000/{filename}"),
                bytes: b"overpadded".to_vec(),
            },
        ];
        assert_eq!(
            canonical_sample_scoped_index(
                "eigen/metadata/sample_10000/linearization_state.v7.json",
                filename,
            ),
            Some(10_000)
        );
        assert_eq!(
            canonical_sample_scoped_index(
                "eigen/metadata/sample_00000/linearization_state.v7.json",
                filename,
            ),
            None
        );
        assert_eq!(
            sample_scoped_signed_sidecar_paths(&artifacts, filename),
            vec![
                "eigen/metadata/sample_9999/linearization_state.v7.json",
                "eigen/metadata/sample_10000/linearization_state.v7.json",
            ]
        );
    }

    #[test]
    fn nonshared_floquet_coverage_is_separate_and_requires_all_samples() {
        let artifacts = NONSHARED_FLOQUET_SIDECAR_DEFINITIONS
            .into_iter()
            .flat_map(|(_, filename, _)| {
                [0_usize, 2_usize].into_iter().map(move |sample_index| {
                    AuxiliaryArtifact {
                        relative_path: format!(
                            "eigen/metadata/sample_{sample_index:04}/{filename}"
                        ),
                        bytes: b"{}".to_vec(),
                    }
                })
            })
            .collect::<Vec<_>>();

        let coverage = inspect_nonshared_floquet_sidecars(&artifacts, &[0, 2]);
        assert_eq!(coverage.status, "path_coverage_complete");
        assert!(coverage.structural_complete);
        assert_eq!(
            coverage.computed_sample_indices,
            BTreeSet::from([0_usize, 2_usize])
        );
        let native_artifacts = NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS
            .into_iter()
            .flat_map(|(_, filename, _)| {
                [0_usize, 2_usize].into_iter().map(move |sample_index| {
                    AuxiliaryArtifact {
                        relative_path: format!(
                            "eigen/metadata/sample_{sample_index:04}/nonshared_source/{filename}"
                        ),
                        bytes: b"native-input".to_vec(),
                    }
                })
            })
            .collect::<Vec<_>>();
        let native_coverage =
            inspect_nonshared_floquet_native_input_diagnostics_sidecars(&native_artifacts, &[0, 2]);
        assert_eq!(native_coverage.status, "path_coverage_complete");
        assert!(native_coverage.structural_complete);
        assert_eq!(
            native_coverage
                .paths_by_key
                .get("nonshared_floquet_native_input_diagnostics_v1_paths")
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            inspect_r4_sidecars(&artifacts, &[0, 2]).status,
            "historical"
        );

        let partial = artifacts
            .into_iter()
            .filter(|artifact| {
                artifact.relative_path
                    != "eigen/metadata/sample_0002/nonshared_floquet_source_state.v1.json"
            })
            .collect::<Vec<_>>();
        let partial_coverage = inspect_nonshared_floquet_sidecars(&partial, &[0, 2]);
        assert_eq!(partial_coverage.status, "missing_sidecars");
        assert!(partial_coverage
            .missing_keys
            .contains(&"nonshared_floquet_source_state_v1_paths".to_string()));
        assert!(!partial_coverage.structural_complete);
    }

    #[test]
    fn nonshared_floquet_legacy_three_sidecar_bundle_stays_unverified() {
        let artifacts = NONSHARED_FLOQUET_SIDECAR_DEFINITIONS
            .into_iter()
            .take(3)
            .flat_map(|(_, filename, _)| {
                [0_usize, 2_usize].into_iter().map(move |sample_index| {
                    AuxiliaryArtifact {
                        relative_path: format!(
                            "eigen/metadata/sample_{sample_index:04}/{filename}"
                        ),
                        bytes: b"legacy".to_vec(),
                    }
                })
            })
            .collect::<Vec<_>>();

        let coverage = inspect_nonshared_floquet_sidecars(&artifacts, &[0, 2]);
        assert_eq!(coverage.status, "path_coverage_complete");
        assert!(coverage.structural_complete);
        let native_coverage =
            inspect_nonshared_floquet_native_input_diagnostics_sidecars(&artifacts, &[0, 2]);
        assert_eq!(native_coverage.status, "historical");
        assert!(!native_coverage.structural_complete);
        assert_eq!(
            native_coverage.manifest_value()["qualification"],
            "NOT_VERIFIED"
        );
    }

    #[test]
    fn nonshared_floquet_coverage_rejects_noncanonical_or_extra_samples() {
        let artifacts = vec![AuxiliaryArtifact {
            relative_path:
                "eigen/metadata/sample_00000/nonshared_floquet_source_state.v1.json"
                    .to_string(),
            bytes: b"{}".to_vec(),
        }];
        let noncanonical = inspect_nonshared_floquet_sidecars(&artifacts, &[0]);
        assert_eq!(noncanonical.status, "invalid");
        assert!(noncanonical.reason.contains("non-canonical"));

        let artifacts = NONSHARED_FLOQUET_SIDECAR_DEFINITIONS
            .into_iter()
            .map(|(_, filename, _)| AuxiliaryArtifact {
                relative_path: format!(
                    "eigen/metadata/sample_0007/{filename}"
                ),
                bytes: b"{}".to_vec(),
            })
            .collect::<Vec<_>>();
        let extra = inspect_nonshared_floquet_sidecars(&artifacts, &[0]);
        assert_eq!(extra.status, "invalid");
        assert!(extra.reason.contains("outside computed samples"));
    }

    #[test]
    fn nonshared_floquet_coverage_rejects_duplicate_paths() {
        let artifact = AuxiliaryArtifact {
            relative_path:
                "eigen/metadata/sample_0000/nonshared_source/native_input_operator_diagnostics.v1.json"
                    .to_string(),
            bytes: b"diagnostics".to_vec(),
        };
        let duplicate = AuxiliaryArtifact {
            relative_path: artifact.relative_path.clone(),
            bytes: b"different".to_vec(),
        };
        let coverage = inspect_nonshared_floquet_native_input_diagnostics_sidecars(
            &[artifact, duplicate],
            &[0],
        );
        assert_eq!(coverage.status, "invalid");
        assert!(coverage.reason.contains("duplicate"));
        assert!(!coverage.structural_complete);

        let flattened = AuxiliaryArtifact {
            relative_path:
                "eigen/metadata/sample_0000/native_input_operator_diagnostics.v1.json"
                    .to_string(),
            bytes: b"flattened".to_vec(),
        };
        let flattened_coverage = inspect_nonshared_floquet_native_input_diagnostics_sidecars(
            &[flattened],
            &[0],
        );
        assert_eq!(flattened_coverage.status, "invalid");
        assert!(flattened_coverage.reason.contains("non-canonical"));

        let traversed = AuxiliaryArtifact {
            relative_path:
                "eigen/metadata/sample_0000/nonshared_source/../native_input_operator_diagnostics.v1.json"
                    .to_string(),
            bytes: b"traversed".to_vec(),
        };
        let traversed_coverage = inspect_nonshared_floquet_native_input_diagnostics_sidecars(
            &[traversed],
            &[0],
        );
        assert_eq!(traversed_coverage.status, "invalid");
        assert!(traversed_coverage.reason.contains("non-canonical"));

        let extra = AuxiliaryArtifact {
            relative_path:
                "eigen/metadata/sample_0007/nonshared_source/native_input_operator_diagnostics.v1.json"
                    .to_string(),
            bytes: b"extra".to_vec(),
        };
        let extra_coverage = inspect_nonshared_floquet_native_input_diagnostics_sidecars(
            &[extra],
            &[0],
        );
        assert_eq!(extra_coverage.status, "invalid");
        assert!(extra_coverage.reason.contains("outside computed samples"));
    }

    #[test]
    fn producer_provenance_paths_are_numeric_and_preserve_source_spelling() {
        let artifacts = [
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0010/producer_provenance.v1.json".to_string(),
                bytes: b"ten".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0002/producer_provenance.v1.json".to_string(),
                bytes: b"two".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_00000/producer_provenance.v1.json".to_string(),
                bytes: b"noncanonical".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: "equilibrium/producer_provenance.v1.json".to_string(),
                bytes: b"source".to_vec(),
            },
        ];
        assert_eq!(
            sample_scoped_producer_provenance_paths(&artifacts),
            vec![
                "eigen/metadata/sample_0002/producer_provenance.v1.json".to_string(),
                "eigen/metadata/sample_0010/producer_provenance.v1.json".to_string(),
            ]
        );
        assert_eq!(artifacts[0].bytes, b"ten");
        assert_eq!(artifacts[1].bytes, b"two");
    }

    #[test]
    fn r4_coverage_is_explicit_for_history_and_partial_sample_sets() {
        let historical = inspect_r4_sidecars(&[], &[]);
        assert_eq!(historical.status, "historical");
        assert!(!historical.structural_complete);

        let accepted = vec![
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0000/accepted_fem_equilibrium_fields.v2.json"
                        .to_string(),
                bytes: b"accepted".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0002/accepted_fem_equilibrium_fields.v2.json"
                        .to_string(),
                bytes: b"accepted".to_vec(),
            },
        ];
        let incomplete = inspect_r4_sidecars(&accepted, &[0, 2]);
        assert_eq!(incomplete.status, "missing_identity");
        assert_eq!(
            incomplete.accepted_sample_indices,
            BTreeSet::from([0_usize, 2_usize])
        );

        let mismatched = inspect_r4_sidecars(&accepted, &[0, 2, 7]);
        assert_eq!(mismatched.status, "invalid");
        assert!(mismatched.reason.contains("computed samples"));
    }

    #[test]
    fn r4_coverage_rejects_partial_certified_family() {
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0000/accepted_fem_equilibrium_fields.v2.json"
                        .to_string(),
                bytes: b"accepted".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path:
                    "eigen/metadata/sample_0000/certified_fem_equilibrium_fields.v2.json"
                        .to_string(),
                bytes: b"certified".to_vec(),
            },
        ];
        let coverage = inspect_r4_sidecars(&artifacts, &[0]);
        assert_eq!(coverage.status, "missing_identity");
        assert!(!coverage.structural_complete);
    }

    #[test]
    fn r4_coverage_preserves_identity_evidence_when_recomputed_family_is_missing() {
        let sample_index = 3_usize;
        let mut identity = identity_fixture(sample_index);
        let equilibrium_bytes = serde_json::to_vec(&serde_json::json!({
            "content_sha256": identity.equilibrium_artifact_sha256.clone(),
        }))
        .expect("equilibrium fixture must serialize");
        let state_bytes = serde_json::to_vec(&serde_json::json!({
            "content_sha256": identity.linearization_state_sha256.clone(),
        }))
        .expect("state fixture must serialize");
        let accepted_bytes = serde_json::to_vec(&serde_json::json!({
            "schema_version": "CertifiedFemEquilibriumFields.v2",
            "content_sha256": identity.accepted_fields_content_sha256.clone(),
        }))
        .expect("accepted fixture must serialize");
        identity.accepted_fields_bytes_sha256 =
            format!("sha256:{:x}", Sha256::digest(&accepted_bytes));
        identity.content_sha256.clear();
        let identity_preimage =
            serde_json::to_vec(&identity).expect("identity preimage must serialize");
        identity.content_sha256 = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_content_sha256_from_preimage_bytes(&identity_preimage);
        let identity_bytes = serde_json::to_vec(&identity).expect("identity must serialize");
        let preimage_sidecar = super::super::eigen_equilibrium_contract::
            linearization_identity_v2_preimage_sidecar_bytes(&identity)
            .expect("identity preimage sidecar must serialize");
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/accepted_fem_equilibrium_fields.v2.json"
                ),
                bytes: accepted_bytes,
            },
            AuxiliaryArtifact {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/linearization_identity.v2.json"
                ),
                bytes: identity_bytes,
            },
            AuxiliaryArtifact {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/linearization_identity_preimage.v1.json"
                ),
                bytes: preimage_sidecar,
            },
            AuxiliaryArtifact {
                relative_path: "eigen/metadata/equilibrium_artifact.v8.json".to_string(),
                bytes: equilibrium_bytes,
            },
            AuxiliaryArtifact {
                relative_path: "eigen/metadata/linearization_state.v7.json".to_string(),
                bytes: state_bytes,
            },
        ];
        let coverage = inspect_r4_sidecars(&artifacts, &[sample_index]);
        assert_eq!(coverage.status, "missing_recomputed");
        assert_eq!(
            coverage.missing_recomputed_keys,
            vec![
                "certified_fem_equilibrium_fields_v2_paths".to_string(),
                "recomputed_fem_linearization_certificate_v2_paths".to_string(),
            ]
        );
        assert_eq!(
            coverage.identity_content_sha256_by_sample.get("3"),
            Some(&identity.content_sha256)
        );
        assert!(!coverage.structural_complete);
    }

    #[test]
    fn linearization_identity_preimage_sidecar_roundtrips_with_independent_framed_hash() {
        let (summary, artifacts, identity, preimage_bytes) = published_fixture(3);
        let expected_preimage_sha256 = format!("sha256:{:x}", Sha256::digest(&preimage_bytes));
        let mut framed = Sha256::new();
        framed
            .update(super::super::eigen_equilibrium_contract::LINEARIZATION_IDENTITY_V2.as_bytes());
        framed.update([0_u8]);
        framed.update((preimage_bytes.len() as u64).to_le_bytes());
        framed.update(&preimage_bytes);
        let expected_identity_sha256 = format!("sha256:{:x}", framed.finalize());

        assert_eq!(identity.content_sha256, expected_identity_sha256);
        let preimage_artifact = artifacts
            .iter()
            .find(|artifact| {
                artifact
                    .relative_path
                    .ends_with("linearization_identity_preimage.v1.json")
            })
            .expect("preimage sidecar must be published");
        let sidecar: super::super::eigen_equilibrium_contract::LinearizationIdentityPreimageV1 =
            serde_json::from_slice(&preimage_artifact.bytes).expect("sidecar must deserialize");
        assert_eq!(sidecar.identity_preimage_sha256, expected_preimage_sha256);
        assert_eq!(
            super::validate_published_linearization_identity_sidecars(&summary, &artifacts, 3)
                .expect("valid identity sidecars must validate"),
            Some((
                "eigen/metadata/sample_0003/linearization_identity.v2.json".to_string(),
                "eigen/metadata/sample_0003/linearization_identity_preimage.v1.json".to_string(),
            ))
        );
    }

    #[test]
    fn linearization_identity_sidecars_reject_mutated_preimage_bytes() {
        let (summary, mut artifacts, _, _) = published_fixture(0);
        let artifact = artifacts
            .iter_mut()
            .find(|artifact| {
                artifact
                    .relative_path
                    .ends_with("linearization_identity_preimage.v1.json")
            })
            .expect("preimage sidecar must be present");
        let mut sidecar: serde_json::Value =
            serde_json::from_slice(&artifact.bytes).expect("sidecar must be JSON");
        let original = sidecar["identity_preimage_json"]
            .as_str()
            .expect("preimage must be a string")
            .to_string();
        sidecar["identity_preimage_json"] = serde_json::json!(format!("{original} "));
        artifact.bytes = serde_json::to_vec(&sidecar).expect("mutated sidecar must serialize");

        let error =
            super::validate_published_linearization_identity_sidecars(&summary, &artifacts, 0)
                .expect_err("mutated preimage bytes must be rejected");
        assert!(error.message.contains("bytes_digest_mismatch"));
    }

    #[test]
    fn linearization_identity_sidecars_reject_identity_digest_tampering() {
        let (_, artifacts, _, _) = published_fixture(1);
        let tampered_summary = serde_json::json!({
            "solver_diagnostics": {
                "linearization_identity_sha256": format!("sha256:{}", "b".repeat(64))
            }
        });

        let error = super::validate_published_linearization_identity_sidecars(
            &tampered_summary,
            &artifacts,
            1,
        )
        .expect_err("tampered identity digest must be rejected");
        assert!(error.message.contains("does_not_match_published_identity"));
    }

    #[test]
    fn linearization_identity_sidecars_reject_sample_index_tampering() {
        let (summary, mut artifacts, _, _) = published_fixture(2);
        let artifact = artifacts
            .iter_mut()
            .find(|artifact| {
                artifact
                    .relative_path
                    .ends_with("linearization_identity.v2.json")
            })
            .expect("identity artifact must be present");
        let mut identity: serde_json::Value =
            serde_json::from_slice(&artifact.bytes).expect("identity must be JSON");
        identity["sample_index"] = serde_json::json!(7);
        artifact.bytes = serde_json::to_vec(&identity).expect("mutated identity must serialize");

        let error =
            super::validate_published_linearization_identity_sidecars(&summary, &artifacts, 2)
                .expect_err("sample index mismatch must be rejected");
        assert!(error.message.contains("sample_index_mismatch"));
    }

    #[test]
    fn linearization_identity_sidecars_reject_missing_artifacts_before_manifest_link() {
        let (summary, _, _, _) = published_fixture(4);
        let error = super::validate_published_linearization_identity_sidecars(&summary, &[], 4)
            .expect_err("missing identity must be rejected before manifest publication");
        assert!(error
            .message
            .contains("artifact_missing_for_published_digest"));
    }

    #[test]
    fn linearization_identity_sidecars_reject_missing_preimage_before_manifest_link() {
        let (summary, mut artifacts, _, _) = published_fixture(5);
        artifacts.retain(|artifact| {
            !artifact
                .relative_path
                .ends_with("linearization_identity_preimage.v1.json")
        });
        let error =
            super::validate_published_linearization_identity_sidecars(&summary, &artifacts, 5)
                .expect_err("missing preimage must be rejected before manifest publication");
        assert!(error.message.contains("preimage_v1_artifact_missing"));
    }
}
