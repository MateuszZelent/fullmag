use crate::antenna_spectrum::FieldTetraBvh;
pub(crate) mod direct_quadrature;
pub use direct_quadrature::AntennaQuadratureEvidenceRef;
use direct_quadrature::{DirectOerstedSnapshot, DirectQuadratureEvidence, EVIDENCE_SCHEMA};
use crate::types::{AuxiliaryArtifact, RunError};
use fullmag_ir::{
    AntennaFieldSolveStageIR, AntennaSpectrumRequestIR, AntennaTargetProjectionRefIR, FdmPlanIR,
    FemPlanIR, FieldTargetIR, ProblemIR, ProblemIRV04, ResolvedSolvedAntennaDriveBasisIR,
    SolvedAntennaDriveIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const ANTENNA_FIELD_SOLUTION_SCHEMA: &str = "antenna_field_solution.v1";
pub(crate) const ANTENNA_FIELD_MANIFEST_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaFieldSolutionSignatures {
    pub current_solution_signature: String,
    pub field_solution_signature: String,
    pub target_projection_signatures: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_signatures: Option<AntennaDependencySignatures>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaDependencySignatures {
    pub terminal: String,
    pub solver: String,
    pub sampling: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AntennaFieldBasisInput {
    pub port_mode_id: String,
    pub measured_positive_terminal_current_a: f64,
    pub electric_potential_v: Vec<f64>,
    pub current_density_xyz_apm2: Vec<[f64; 3]>,
    pub magnetic_field_xyz_apm: Vec<[f64; 3]>,
    pub current_balance_certificate_digest: String,
    pub quadrature_diagnostics: serde_json::Value,
    pub oersted_operator_version: String,
    pub direct_quadrature_snapshot: Option<DirectOerstedSnapshot>,
}

#[derive(Debug, Clone)]
pub(crate) struct AntennaFieldSolutionInput {
    pub asset_id: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub stage_id: String,
    pub geometry_revision: String,
    pub material_revision: String,
    pub mesh_digest: String,
    pub requested_execution: serde_json::Value,
    pub resolved_execution: serde_json::Value,
    pub gauge_policy: String,
    pub solver_policy: serde_json::Value,
    pub signatures: AntennaFieldSolutionSignatures,
    pub conductor_positions_xyz_m: Vec<[f64; 3]>,
    pub sample_positions_xyz_m: Vec<[f64; 3]>,
    pub sample_carrier: AntennaSampleCarrier,
    /// Optional P1 tetrahedral topology for the field-sampling carrier.
    /// Without it, spectrum sampling remains limited to exact immutable
    /// sample-coordinate lookup for backwards-compatible assets.
    pub sample_tet4_cells: Option<Vec<[u32; 4]>>,
    pub bases: Vec<AntennaFieldBasisInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AntennaSampleCarrier {
    pub domain: FieldTargetIR,
    pub carrier_kind: String,
    pub location: String,
    pub topology_digest: String,
}

fn validate_sample_carrier(carrier: Option<&AntennaSampleCarrier>) -> Result<(), RunError> {
    let Some(carrier) = carrier else {
        // Legacy point carriers remain readable without mesh-adoption metadata.
        return Ok(());
    };
    validate_nonempty("sample carrier kind", &carrier.carrier_kind)?;
    let digest_is_valid = carrier.topology_digest.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if carrier.location != "node" || !digest_is_valid {
        return Err(RunError {
            message: "antenna sample carrier requires node location and a canonical SHA-256 topology digest".into(),
        });
    }
    match &carrier.domain {
        FieldTargetIR::Global {} => {}
        FieldTargetIR::Object { object_id } => validate_nonempty("sample carrier object_id", object_id)?,
        FieldTargetIR::Region { object_id, region_id } => {
            validate_nonempty("sample carrier object_id", object_id)?;
            validate_nonempty("sample carrier region_id", region_id)?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct BinaryFieldRef<'a> {
    path: &'a str,
    sha256: &'a str,
    scalar_type: &'static str,
    layout: &'static str,
    unit: &'static str,
    value_count: usize,
}

#[derive(Debug, Serialize)]
struct BasisManifest<'a> {
    port_mode_id: &'a str,
    measured_positive_terminal_current_a: f64,
    normalization_current_a: f64,
    normalization_scale: f64,
    current_balance_certificate_digest: &'a str,
    electric_potential_per_ampere: BinaryFieldRef<'a>,
    current_density_per_ampere: BinaryFieldRef<'a>,
    magnetic_field_per_ampere: BinaryFieldRef<'a>,
    quadrature_diagnostics: &'a serde_json::Value,
    oersted_operator_version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    quadrature_evidence: Option<&'a AntennaQuadratureEvidenceRef>,
}

#[derive(Debug, Serialize)]
struct SolutionManifest<'a> {
    schema_version: &'static str,
    asset_id: &'a str,
    status: &'static str,
    solution_id: &'a str,
    source_object_id: &'a str,
    current_transport_id: &'a str,
    stage_id: &'a str,
    geometry_revision: &'a str,
    material_revision: &'a str,
    mesh_digest: &'a str,
    requested_execution: &'a serde_json::Value,
    resolved_execution: &'a serde_json::Value,
    gauge_policy: &'a str,
    solver_policy: &'a serde_json::Value,
    signatures: &'a AntennaFieldSolutionSignatures,
    conductor_positions: BinaryFieldRef<'a>,
    sample_positions: BinaryFieldRef<'a>,
    sample_carrier: &'a AntennaSampleCarrier,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_topology: Option<BinaryFieldRef<'a>>,
    assumptions: [&'static str; 4],
    bases: Vec<BasisManifest<'a>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredBinaryFieldRef {
    path: String,
    sha256: String,
    scalar_type: String,
    layout: String,
    unit: String,
    value_count: usize,
}

#[derive(Debug, Deserialize)]
struct StoredBasisManifest {
    port_mode_id: String,
    measured_positive_terminal_current_a: f64,
    normalization_current_a: f64,
    normalization_scale: f64,
    electric_potential_per_ampere: StoredBinaryFieldRef,
    current_density_per_ampere: StoredBinaryFieldRef,
    magnetic_field_per_ampere: StoredBinaryFieldRef,
    #[serde(default)]
    current_balance_certificate_digest: String,
    #[serde(default)]
    quadrature_diagnostics: serde_json::Value,
    #[serde(default)]
    oersted_operator_version: Option<String>,
    #[serde(default)]
    quadrature_evidence: Option<AntennaQuadratureEvidenceRef>,
}

fn validate_basis_normalization(bases: &[StoredBasisManifest]) -> Result<(), RunError> {
    for basis in bases {
        let current = basis.measured_positive_terminal_current_a;
        if !current.is_finite()
            || current <= 0.0
            || basis.normalization_current_a != 1.0
            || !basis.normalization_scale.is_finite()
            || basis.normalization_scale <= 0.0
            || basis.normalization_scale != 1.0 / current
        {
            return Err(RunError {
                message: format!("antenna port '{}' has invalid per-ampere normalization", basis.port_mode_id),
            });
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct StoredSolutionManifest {
    schema_version: String,
    asset_id: String,
    status: String,
    solution_id: String,
    source_object_id: String,
    #[serde(default)]
    geometry_revision: String,
    #[serde(default)]
    material_revision: String,
    #[serde(default)]
    mesh_digest: String,
    signatures: AntennaFieldSolutionSignatures,
    conductor_positions: StoredBinaryFieldRef,
    sample_positions: StoredBinaryFieldRef,
    #[serde(default)]
    sample_carrier: Option<AntennaSampleCarrier>,
    #[serde(default)]
    sample_topology: Option<StoredBinaryFieldRef>,
    bases: Vec<StoredBasisManifest>,
}

fn validate_nonempty(label: &str, value: &str) -> Result<(), RunError> {
    if value.trim().is_empty() {
        Err(RunError {
            message: format!("{label} must not be empty"),
        })
    } else {
        Ok(())
    }
}

fn signatures_are_valid(signatures: &AntennaFieldSolutionSignatures) -> bool {
    fn valid_sha256(signature: &str) -> bool {
        signature.strip_prefix("sha256:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    }

    valid_sha256(&signatures.current_solution_signature)
        && valid_sha256(&signatures.field_solution_signature)
        && signatures
            .target_projection_signatures
            .values()
            .all(|signature| valid_sha256(signature))
        && signatures.dependency_signatures.as_ref().is_none_or(|dependencies| {
            [&dependencies.terminal, &dependencies.solver, &dependencies.sampling]
                .into_iter()
                .all(|signature| valid_sha256(signature))
        })
}

fn parse_verified_manifest(
    manifest_bytes: &[u8],
) -> Result<(String, StoredSolutionManifest), RunError> {
    if manifest_bytes.len() > ANTENNA_FIELD_MANIFEST_MAX_BYTES {
        return Err(RunError { message: "antenna field solution manifest exceeds size bound".into() });
    }
    crate::antenna_external_lead_solution::reject_unqualified_external_lead_source(manifest_bytes)?;
    let crate::artifact_json::UnambiguousJson(mut canonical_value) =
        serde_json::from_slice(manifest_bytes).map_err(|error| RunError {
            message: format!("parse antenna field solution manifest: {error}"),
        })?;
    let published_digest = canonical_value
        .as_object_mut()
        .and_then(|object| object.remove("content_digest"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| RunError {
            message: "antenna field solution manifest has no content_digest".into(),
        })?;
    let canonical = serde_json::to_vec(&canonical_value).map_err(|error| RunError {
        message: format!("canonicalize antenna field solution manifest: {error}"),
    })?;
    if format!("sha256:{}", sha256(&canonical)) != published_digest {
        return Err(RunError {
            message: "antenna field solution manifest content_digest mismatch".into(),
        });
    }
    canonical_value["content_digest"] = serde_json::Value::String(published_digest.clone());
    let manifest: StoredSolutionManifest =
        serde_json::from_value(canonical_value).map_err(|error| RunError {
            message: format!("validate antenna field solution manifest: {error}"),
        })?;
    validate_sample_carrier(manifest.sample_carrier.as_ref())?;
    validate_basis_normalization(&manifest.bases)?;
    if manifest.schema_version != ANTENNA_FIELD_SOLUTION_SCHEMA
        || manifest.status != "ready"
        || manifest.asset_id.trim().is_empty()
        || !signatures_are_valid(&manifest.signatures)
    {
        return Err(RunError {
            message: "antenna field solution schema, status, asset id, or signatures are invalid"
                .into(),
        });
    }
    Ok((published_digest, manifest))
}

pub(crate) fn verify_antenna_field_solution_manifest(
    manifest_bytes: &[u8],
) -> Result<(), RunError> {
    parse_verified_manifest(manifest_bytes).map(|_| ())
}

/// Exact read limits from an unambiguous, content-addressed manifest.
/// This checks metadata before I/O; numerical acceptance still requires the payload verifier.
pub(crate) fn antenna_field_solution_payload_lengths(
    manifest_bytes: &[u8],
) -> Result<BTreeMap<String, usize>, RunError> {
    let (_, manifest) = parse_verified_manifest(manifest_bytes)?;
    let mut lengths = BTreeMap::new();
    let prefix = format!("antenna/field_solutions/{}/", manifest.solution_id);
    let invalid = || RunError { message: "invalid antenna payload read metadata".into() };
    let mut insert = |path: &str, length: usize| -> Result<(), RunError> {
        if length == 0 || !path.starts_with(&prefix) || path.len() == prefix.len()
            || path.contains(['\\', ':'])
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
            || lengths.insert(path.to_owned(), length).is_some()
        {
            return Err(invalid());
        }
        Ok(())
    };
    let mut binary = |reference: &StoredBinaryFieldRef, scalar: &str, layout: &str, unit: &str,
                      width: usize| -> Result<(), RunError> {
        if reference.scalar_type != scalar || reference.layout != layout || reference.unit != unit
            || reference.value_count == 0
        { return Err(invalid()); }
        insert(&reference.path, reference.value_count.checked_mul(width).ok_or_else(invalid)?)
    };
    let conductor_values = manifest.conductor_positions.value_count;
    let sample_values = manifest.sample_positions.value_count;
    if conductor_values == 0 || conductor_values % 3 != 0 || sample_values == 0
        || sample_values % 3 != 0 || manifest.bases.is_empty()
    { return Err(invalid()); }
    binary(&manifest.conductor_positions, "float64_le", "node_xyz_interleaved", "m", 8)?;
    binary(&manifest.sample_positions, "float64_le", "sample_xyz_interleaved", "m", 8)?;
    if let Some(topology) = &manifest.sample_topology {
        if topology.value_count % 4 != 0 { return Err(invalid()); }
        binary(topology, "uint32_le", "tet4_connectivity", "1", 4)?;
    }
    let mut ports = BTreeSet::new();
    for basis in &manifest.bases {
        match basis.oersted_operator_version.as_deref() {
            Some(version) if version == fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION => {
                if basis.quadrature_evidence.is_none() { return Err(invalid()); }
            }
            Some(version) if version == fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION => {
                if basis.quadrature_evidence.is_some()
                    || basis.quadrature_diagnostics.get("operator_version").and_then(|v| v.as_str()) != Some(version)
                { return Err(invalid()); }
            }
            _ => return Err(invalid()),
        }
        if basis.port_mode_id.trim().is_empty() || !ports.insert(&basis.port_mode_id)
            || basis.electric_potential_per_ampere.value_count != conductor_values / 3
            || basis.current_density_per_ampere.value_count != conductor_values
            || basis.magnetic_field_per_ampere.value_count != sample_values
        { return Err(invalid()); }
        binary(&basis.electric_potential_per_ampere, "float64_le", "node_scalar", "V/A", 8)?;
        binary(&basis.current_density_per_ampere, "float64_le", "sample_xyz_interleaved", "A/m^2/A", 8)?;
        binary(&basis.magnetic_field_per_ampere, "float64_le", "sample_xyz_interleaved", "A/m/A", 8)?;
    }
    // Release the metadata closure's mutable borrow before inserting binary evidence.
    drop(binary);
    for basis in &manifest.bases {
        if let Some(evidence) = &basis.quadrature_evidence {
            if evidence.schema_version != EVIDENCE_SCHEMA || evidence.target_count == 0
                || evidence.target_count as u64 > direct_quadrature::MAX_TARGETS
                || evidence.target_count != sample_values / 3
                || direct_quadrature::RECORD_BYTES.checked_mul(evidence.target_count)
                    .and_then(|n| direct_quadrature::HEADER_BYTES.checked_add(n)) != Some(evidence.byte_length)
            { return Err(invalid()); }
            insert(&evidence.path, evidence.byte_length)?;
        }
    }
    // All raw payloads coexist during verification. Individual lengths can
    // fit while their aggregate cannot; reject that before payload I/O.
    lengths.values().try_fold(manifest_bytes.len(), |total, length| {
        total.checked_add(*length).ok_or_else(|| RunError {
            message: "antenna stored payload aggregate size overflows address space".into(),
        })
    })?;
    Ok(lengths)
}

fn verify_binary_ref(
    reference: &StoredBinaryFieldRef,
    payloads: &[AuxiliaryArtifact],
    scalar_type: &str,
    layout: &str,
    unit: &str,
) -> Result<(), RunError> {
    if reference.scalar_type != scalar_type
        || reference.layout != layout
        || reference.unit != unit
        || reference.value_count == 0
    {
        return Err(RunError {
            message: format!(
                "antenna field payload '{}' has incompatible metadata",
                reference.path
            ),
        });
    }
    let payload = payloads
        .iter()
        .find(|artifact| artifact.relative_path == reference.path)
        .ok_or_else(|| RunError {
            message: format!("missing antenna field payload '{}'", reference.path),
        })?;
    if sha256(&payload.bytes) != reference.sha256
        || payload.bytes.len() != reference.value_count.saturating_mul(8)
        || payload.bytes.chunks_exact(8).any(|chunk| {
            !f64::from_le_bytes(chunk.try_into().expect("eight-byte chunk")).is_finite()
        })
    {
        return Err(RunError {
            message: format!(
                "antenna field payload '{}' sha256, size, or finite-value check failed",
                reference.path
            ),
        });
    }
    Ok(())
}

fn verify_tet4_topology_ref(
    reference: &StoredBinaryFieldRef,
    payloads: &[AuxiliaryArtifact],
    sample_count: usize,
) -> Result<(), RunError> {
    if reference.scalar_type != "uint32_le"
        || reference.layout != "tet4_connectivity"
        || reference.unit != "1"
        || reference.value_count == 0
        || reference.value_count % 4 != 0
    {
        return Err(RunError {
            message: format!(
                "antenna field topology payload '{}' has incompatible metadata",
                reference.path
            ),
        });
    }
    let payload = payloads
        .iter()
        .find(|artifact| artifact.relative_path == reference.path)
        .ok_or_else(|| RunError {
            message: format!("missing antenna field payload '{}'", reference.path),
        })?;
    let expected_bytes = reference
        .value_count
        .checked_mul(4)
        .ok_or_else(|| RunError {
            message: format!(
                "antenna field topology payload '{}' size overflows address space",
                reference.path
            ),
        })?;
    if sha256(&payload.bytes) != reference.sha256 || payload.bytes.len() != expected_bytes {
        return Err(RunError {
            message: format!(
                "antenna field topology payload '{}' sha256 or size check failed",
                reference.path
            ),
        });
    }
    for chunk in payload.bytes.chunks_exact(16) {
        for offset in [0, 4, 8, 12] {
            let node = u32::from_le_bytes(
                chunk[offset..offset + 4]
                    .try_into()
                    .expect("four-byte chunk"),
            ) as usize;
            if node >= sample_count {
                return Err(RunError {
                    message: format!(
                        "antenna field topology payload '{}' references sample node {} outside carrier of {} nodes",
                        reference.path, node, sample_count
                    ),
                });
            }
        }
    }
    Ok(())
}

/// Validate the content-addressed manifest and every binary it references.
pub fn verify_antenna_field_solution_asset(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
) -> Result<(), RunError> {
    verify_field_solution_payloads(manifest_bytes, payloads, true)
}

/// Validate all referenced data, allowing enclosing bundle diagnostics/manifest.
/// This is the same scientific gate as full-asset verification, not a weaker load path.
pub fn verify_antenna_field_solution_referenced_data(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
) -> Result<(), RunError> {
    verify_field_solution_payloads(manifest_bytes, payloads, false)
}

fn verify_field_solution_payloads(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
    require_exact_payload_set: bool,
) -> Result<(), RunError> {
    antenna_field_solution_payload_lengths(manifest_bytes)?;
    let (_, manifest) = parse_verified_manifest(manifest_bytes)?;
    let mut expected_paths = BTreeSet::from([
        manifest.conductor_positions.path.as_str(),
        manifest.sample_positions.path.as_str(),
    ]);
    verify_binary_ref(
        &manifest.conductor_positions,
        payloads,
        "float64_le",
        "node_xyz_interleaved",
        "m",
    )?;
    verify_binary_ref(
        &manifest.sample_positions,
        payloads,
        "float64_le",
        "sample_xyz_interleaved",
        "m",
    )?;
    if manifest.conductor_positions.value_count % 3 != 0
        || manifest.sample_positions.value_count % 3 != 0
        || manifest.bases.is_empty()
    {
        return Err(RunError {
            message: "antenna field solution carriers or port bases are empty/incompatible".into(),
        });
    }
    let conductor_count = manifest.conductor_positions.value_count / 3;
    let sample_value_count = manifest.sample_positions.value_count;
    let sample_count = sample_value_count / 3;
    if let Some(topology) = manifest.sample_topology.as_ref() {
        if !expected_paths.insert(topology.path.as_str()) {
            return Err(RunError {
                message: format!(
                    "duplicate antenna field payload reference '{}'",
                    topology.path
                ),
            });
        }
        verify_tet4_topology_ref(topology, payloads, sample_count)?;
    }
    let mut ports = BTreeSet::new();
    for basis in &manifest.bases {
        if basis.port_mode_id.trim().is_empty()
            || !ports.insert(basis.port_mode_id.as_str())
            || basis.normalization_current_a != 1.0
            || basis.electric_potential_per_ampere.value_count != conductor_count
            || basis.current_density_per_ampere.value_count
                != manifest.conductor_positions.value_count
            || basis.magnetic_field_per_ampere.value_count != sample_value_count
        {
            return Err(RunError {
                message: "antenna field solution port basis has incompatible identity or shape"
                    .into(),
            });
        }
        for path in [
            basis.electric_potential_per_ampere.path.as_str(),
            basis.current_density_per_ampere.path.as_str(),
            basis.magnetic_field_per_ampere.path.as_str(),
        ] {
            if !expected_paths.insert(path) {
                return Err(RunError {
                    message: format!("duplicate antenna field payload reference '{path}'"),
                });
            }
        }
        verify_binary_ref(
            &basis.electric_potential_per_ampere,
            payloads,
            "float64_le",
            "node_scalar",
            "V/A",
        )?;
        verify_binary_ref(
            &basis.current_density_per_ampere,
            payloads,
            "float64_le",
            "sample_xyz_interleaved",
            "A/m^2/A",
        )?;
        verify_binary_ref(
            &basis.magnetic_field_per_ampere,
            payloads,
            "float64_le",
            "sample_xyz_interleaved",
            "A/m/A",
        )?;
        if let Some(reference) = &basis.quadrature_evidence {
            if !expected_paths.insert(reference.path.as_str()) {
                return Err(RunError { message: "duplicate antenna evidence reference".into() });
            }
        }
        verify_basis_quadrature(&manifest, basis, payloads)?;
    }
    let actual_paths = payloads
        .iter()
        .map(|artifact| artifact.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    if actual_paths.len() != payloads.len()
        || (require_exact_payload_set && actual_paths != expected_paths)
    {
        return Err(RunError {
            message: "antenna field solution contains duplicate, missing, or unreferenced payloads"
                .into(),
        });
    }
    Ok(())
}

fn verify_basis_quadrature(
    manifest: &StoredSolutionManifest,
    basis: &StoredBasisManifest,
    payloads: &[AuxiliaryArtifact],
) -> Result<(), RunError> {
    let direct = fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION;
    match basis.oersted_operator_version.as_deref() {
        Some(version) if version == direct => {
            let reference = basis.quadrature_evidence.as_ref().ok_or_else(|| RunError {
                message: "direct v3 antenna basis is missing retained quadrature evidence".into(),
            })?;
            let payload = payloads.iter().find(|artifact| artifact.relative_path == reference.path)
                .ok_or_else(|| RunError { message: "missing antenna quadrature evidence payload".into() })?;
            if reference.schema_version != EVIDENCE_SCHEMA || reference.byte_length != payload.bytes.len()
                || sha256(&payload.bytes) != reference.sha256
            {
                return Err(RunError { message: "antenna quadrature evidence schema/hash/length mismatch".into() });
            }
            let evidence = DirectQuadratureEvidence::decode(&payload.bytes)?;
            if reference.target_count != evidence.snapshot.targets.len() {
                return Err(RunError { message: "antenna quadrature evidence target count mismatch".into() });
            }
            let positions = payloads.iter().find(|a| a.relative_path == manifest.sample_positions.path)
                .ok_or_else(|| RunError { message: "missing antenna positions".into() })?;
            let field = payloads.iter().find(|a| a.relative_path == basis.magnetic_field_per_ampere.path)
                .ok_or_else(|| RunError { message: "missing antenna normalized field".into() })?;
            evidence.verify_binding(
                &decode_xyz_f64_le(&positions.bytes, manifest.sample_positions.value_count)?,
                &decode_xyz_f64_le(&field.bytes, basis.magnetic_field_per_ampere.value_count)?,
                basis.measured_positive_terminal_current_a, basis.normalization_scale,
                &basis.current_balance_certificate_digest, &basis.quadrature_diagnostics,
            )
        }
        Some(version) if version == fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION => {
            if basis.quadrature_evidence.is_some()
                || basis.quadrature_diagnostics.get("operator_version").and_then(|v| v.as_str()) != Some(version)
            {
                return Err(RunError { message: "mixed direct/vector-potential antenna evidence".into() });
            }
            // OE-F2 retains its own native residual/gauge checks; not a direct-v3 certificate.
            Ok(())
        }
        _ => Err(RunError {
            message: "antenna basis has absent/unsupported operator evidence; archival readability does not certify reuse".into(),
        }),
    }
}

/// Verify that a published asset was produced from the same resolved
/// conductor, port, material and field-solution dependencies as the current
/// authoring model. Target projections are recomputed against the resolved
/// LLG topology and do not invalidate an otherwise current source field.
/// A valid content digest alone proves only that the immutable file was not
/// tampered with; it does not prove that its source field is current.
pub fn verify_antenna_field_solution_signatures(
    manifest_bytes: &[u8],
    expected: &AntennaFieldSolutionSignatures,
) -> Result<(), RunError> {
    verify_antenna_field_solution_signatures_with_revisions(manifest_bytes, expected, None)
}

pub(crate) fn verify_antenna_field_solution_signatures_with_revisions(
    manifest_bytes: &[u8],
    expected: &AntennaFieldSolutionSignatures,
    expected_revisions: Option<(&str, &str, &str)>,
) -> Result<(), RunError> {
    let (_, manifest) = parse_verified_manifest(manifest_bytes)?;
    let mut changed = Vec::new();
    if let Some((geometry_revision, material_revision, mesh_digest)) = expected_revisions {
        if manifest.geometry_revision != geometry_revision || manifest.mesh_digest != mesh_digest {
            changed.push("geometry");
        }
        if manifest.material_revision != material_revision {
            changed.push("material");
        }
    }
    match (
        manifest.signatures.dependency_signatures.as_ref(),
        expected.dependency_signatures.as_ref(),
    ) {
        (Some(stored), Some(current)) => {
            if stored.terminal != current.terminal {
                changed.push("terminal");
            }
            if stored.solver != current.solver {
                changed.push("solver");
            }
            if stored.sampling != current.sampling {
                changed.push("sampling");
            }
        }
        (None, Some(_)) | (Some(_), None) => changed.extend(["terminal", "solver", "sampling"]),
        (None, None) => {}
    }
    if !changed.is_empty() {
        return Err(RunError {
            message: format!(
                "antenna field solution is stale for the current model; changed dependencies: {}",
                changed.join(", ")
            ),
        });
    }
    if manifest.signatures.current_solution_signature != expected.current_solution_signature
        || manifest.signatures.field_solution_signature != expected.field_solution_signature
    {
        let changed = [
            (
                "current_solution_signature",
                manifest.signatures.current_solution_signature
                    != expected.current_solution_signature,
            ),
            (
                "field_solution_signature",
                manifest.signatures.field_solution_signature != expected.field_solution_signature,
            ),
        ]
        .into_iter()
        .filter_map(|(name, differs)| differs.then_some(name))
        .collect::<Vec<_>>();
        return Err(RunError {
            message: format!(
                "antenna field solution is stale for the current model; dependency signatures differ: {}",
                changed.join(", ")
            ),
        });
    }
    Ok(())
}

fn encode_f64(values: impl IntoIterator<Item = f64>) -> Vec<u8> {
    let iterator = values.into_iter();
    let (lower, _) = iterator.size_hint();
    let mut bytes = Vec::with_capacity(lower * std::mem::size_of::<f64>());
    for value in iterator {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn encode_scaled_basis_f64(
    values: impl IntoIterator<Item = f64>,
    scale: f64,
    port_mode_id: &str,
    quantity: &str,
) -> Result<Vec<u8>, RunError> {
    let iterator = values.into_iter();
    let (lower, _) = iterator.size_hint();
    let mut bytes = Vec::with_capacity(lower * std::mem::size_of::<f64>());
    for value in iterator {
        let scaled = value * scale;
        if !value.is_finite() || !scaled.is_finite() {
            return Err(RunError {
                message: format!(
                    "port mode '{port_mode_id}' {quantity} contains a non-finite input or overflows during per-ampere normalization"
                ),
            });
        }
        bytes.extend_from_slice(&scaled.to_le_bytes());
    }
    Ok(bytes)
}

fn encode_u32(values: impl IntoIterator<Item = u32>) -> Vec<u8> {
    let iterator = values.into_iter();
    let (lower, _) = iterator.size_hint();
    let mut bytes = Vec::with_capacity(lower * std::mem::size_of::<u32>());
    for value in iterator {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn decode_xyz_f64_le(bytes: &[u8], value_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
    let expected_bytes = value_count.checked_mul(8).ok_or_else(|| RunError {
        message: "antenna field payload size overflows address space".into(),
    })?;
    if value_count % 3 != 0 || bytes.len() != expected_bytes {
        return Err(RunError {
            message: format!(
                "antenna field payload has {} bytes for {value_count} declared values",
                bytes.len()
            ),
        });
    }
    let mut field = Vec::new();
    field.try_reserve_exact(value_count / 3).map_err(|error| RunError {
        message: format!("reserve decoded antenna field buffer: {error}"),
    })?;
    for xyz in bytes.chunks_exact(24) {
        let component = |offset| f64::from_le_bytes(xyz[offset..offset + 8].try_into().unwrap());
        let value = [component(0), component(8), component(16)];
        if !value.iter().all(|component| component.is_finite()) {
            return Err(RunError {
                message: "antenna field payload contains a non-finite value".into(),
            });
        }
        field.push(value);
    }
    Ok(field)
}

fn decode_tet4_u32_le(
    bytes: &[u8],
    value_count: usize,
    sample_count: usize,
) -> Result<Vec<[u32; 4]>, RunError> {
    let expected_bytes = value_count.checked_mul(4).ok_or_else(|| RunError {
        message: "antenna field topology payload size overflows address space".into(),
    })?;
    if value_count == 0 || value_count % 4 != 0 || bytes.len() != expected_bytes {
        return Err(RunError {
            message: format!(
                "antenna field topology payload has {} bytes for {value_count} declared values",
                bytes.len()
            ),
        });
    }
    let mut cells = Vec::new();
    cells.try_reserve_exact(value_count / 4).map_err(|error| RunError {
        message: format!("reserve decoded antenna topology buffer: {error}"),
    })?;
    for tet in bytes.chunks_exact(16) {
        let mut nodes = [0_u32; 4];
        for (local, chunk) in tet.chunks_exact(4).enumerate() {
            nodes[local] = u32::from_le_bytes(chunk.try_into().expect("four-byte chunk"));
            if nodes[local] as usize >= sample_count {
                return Err(RunError {
                    message: format!(
                        "antenna field topology payload references sample node {} outside carrier of {} nodes",
                        nodes[local], sample_count
                    ),
                });
            }
        }
        cells.push(nodes);
    }
    Ok(cells)
}

/// Load a solved basis onto explicit FEM nodes or FDM cell centres.
///
/// This production projection first reuses exact source coordinates and then
/// uses the immutable tet4 carrier for deterministic P1 interpolation.  A
/// different topology therefore works when it is a node reordering, strict
/// subset, or a point inside the certified source carrier.  Point locations
/// outside that carrier and legacy point-only assets remain fail-closed rather
/// than falling back to nearest-node lookup or broadcasting.
pub fn load_solved_antenna_drive_basis_projected(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
    drive: SolvedAntennaDriveIR,
    expected_solution_id: &str,
    expected_source_object_id: &str,
    expected_content_digest: &str,
    expected_sample_count: usize,
    target_positions_xyz_m: &[[f64; 3]],
    target_mask: Option<&[bool]>,
) -> Result<ResolvedSolvedAntennaDriveBasisIR, RunError> {
    verify_antenna_field_solution_referenced_data(manifest_bytes, payloads)?;
    crate::antenna_external_lead_solution::reject_unqualified_external_lead_source(manifest_bytes)?;
    let mut canonical_value: serde_json::Value =
        serde_json::from_slice(manifest_bytes).map_err(|error| RunError {
            message: format!("parse antenna field solution manifest: {error}"),
        })?;
    let published_digest = canonical_value
        .as_object_mut()
        .and_then(|object| object.remove("content_digest"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| RunError {
            message: "antenna field solution manifest has no content_digest".into(),
        })?;
    let canonical = serde_json::to_vec(&canonical_value).map_err(|error| RunError {
        message: format!("canonicalize antenna field solution manifest: {error}"),
    })?;
    if format!("sha256:{}", sha256(&canonical)) != published_digest
        || published_digest != expected_content_digest
    {
        return Err(RunError {
            message: "antenna field solution manifest content_digest mismatch or stale reference"
                .into(),
        });
    }

    canonical_value["content_digest"] = serde_json::Value::String(published_digest.clone());
    let manifest: StoredSolutionManifest =
        serde_json::from_value(canonical_value).map_err(|error| RunError {
            message: format!("validate antenna field solution manifest: {error}"),
        })?;
    validate_sample_carrier(manifest.sample_carrier.as_ref())?;
    validate_basis_normalization(&manifest.bases)?;
    if manifest.schema_version != ANTENNA_FIELD_SOLUTION_SCHEMA
        || manifest.status != "ready"
        || manifest.asset_id.trim().is_empty()
        || !signatures_are_valid(&manifest.signatures)
        || manifest.solution_id != expected_solution_id
        || manifest.source_object_id != expected_source_object_id
    {
        return Err(RunError {
            message: "antenna field solution identity or schema mismatch".into(),
        });
    }
    let basis = manifest
        .bases
        .iter()
        .find(|basis| basis.port_mode_id == drive.port_mode_id)
        .ok_or_else(|| RunError {
            message: format!(
                "antenna field solution '{}' has no port mode '{}'",
                manifest.solution_id, drive.port_mode_id
            ),
        })?;
    let field_ref = &basis.magnetic_field_per_ampere;
    if basis.normalization_current_a != 1.0
        || field_ref.scalar_type != "float64_le"
        || field_ref.layout != "sample_xyz_interleaved"
        || field_ref.unit != "A/m/A"
    {
        return Err(RunError {
            message: "antenna H_per_A metadata is incompatible with the target projection".into(),
        });
    }
    let expected_field_values = field_ref.value_count;
    if expected_sample_count == 0 {
        return Err(RunError {
            message: "antenna target projection requires a non-empty target sample set".into(),
        });
    }
    let field_payload = payloads
        .iter()
        .find(|artifact| artifact.relative_path == field_ref.path)
        .ok_or_else(|| RunError {
            message: format!("missing antenna field payload '{}'", field_ref.path),
        })?;
    if sha256(&field_payload.bytes) != field_ref.sha256 {
        return Err(RunError {
            message: format!("antenna field payload '{}' sha256 mismatch", field_ref.path),
        });
    }
    let source_field_xyz_apm_per_a =
        decode_xyz_f64_le(&field_payload.bytes, expected_field_values)?;
    if let Some(mask) = target_mask {
        if mask.len() != expected_sample_count {
            return Err(RunError {
                message: format!(
                    "antenna target projection mask has {} entries; expected {expected_sample_count}",
                    mask.len()
                ),
            });
        }
    }
    let target_positions = target_positions_xyz_m;
    let (mut field_xyz_apm_per_a, mapping_digest) = {
        if target_positions.len() != expected_sample_count {
            return Err(RunError {
                message: format!(
                    "antenna target projection received {} target positions; expected {expected_sample_count}",
                    target_positions.len()
                ),
            });
        }
        if target_positions
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: "antenna target projection requires finite target coordinates".into(),
            });
        }
        if manifest.sample_positions.value_count % 3 != 0
            || manifest.sample_positions.value_count / 3 != source_field_xyz_apm_per_a.len()
            || manifest.sample_positions.scalar_type != "float64_le"
            || manifest.sample_positions.layout != "sample_xyz_interleaved"
            || manifest.sample_positions.unit != "m"
        {
            return Err(RunError {
                message: "antenna target projection source coordinate carrier is incompatible"
                    .into(),
            });
        }
        let sample_positions_payload = payloads
            .iter()
            .find(|artifact| artifact.relative_path == manifest.sample_positions.path)
            .ok_or_else(|| RunError {
                message: format!(
                    "missing antenna field payload '{}'",
                    manifest.sample_positions.path
                ),
            })?;
        if sha256(&sample_positions_payload.bytes) != manifest.sample_positions.sha256 {
            return Err(RunError {
                message: format!(
                    "antenna field payload '{}' sha256 mismatch",
                    manifest.sample_positions.path
                ),
            });
        }
        let source_positions = decode_xyz_f64_le(
            &sample_positions_payload.bytes,
            manifest.sample_positions.value_count,
        )?;
        let sample_tet4_cells = manifest
            .sample_topology
            .as_ref()
            .map(|reference| {
                let payload = payloads
                    .iter()
                    .find(|artifact| artifact.relative_path == reference.path)
                    .ok_or_else(|| RunError {
                        message: format!(
                            "missing antenna field topology payload '{}'",
                            reference.path
                        ),
                    })?;
                verify_tet4_topology_ref(reference, payloads, source_positions.len())?;
                decode_tet4_u32_le(
                    &payload.bytes,
                    reference.value_count,
                    source_positions.len(),
                )
            })
            .transpose()?;
        let coordinate_scale = source_positions
            .iter()
            .chain(target_positions.iter())
            .flatten()
            .map(|value| value.abs())
            .fold(0.0_f64, f64::max)
            .max(f64::MIN_POSITIVE);
        let tetra_bvh = sample_tet4_cells
            .as_deref()
            .map(|cells| FieldTetraBvh::build(&source_positions, cells, coordinate_scale * 1.0e-12))
            .transpose()?;
        let mut source_by_coordinate =
            std::collections::HashMap::with_capacity(source_positions.len());
        for (index, position) in source_positions.iter().copied().enumerate() {
            let key = coordinate_key(position);
            if source_by_coordinate.insert(key, index).is_some() {
                return Err(RunError {
                    message:
                        "antenna target projection source coordinate carrier contains duplicate nodes"
                            .into(),
                });
            }
        }
        let mut projected = Vec::with_capacity(target_positions.len());
        let mut mapping = Vec::with_capacity(target_positions.len().saturating_mul(5));
        let mut used_interpolation = false;
        for (target_index, position) in target_positions.iter().copied().enumerate() {
            if target_mask.is_some_and(|mask| !mask[target_index]) {
                projected.push([0.0; 3]);
                mapping.push(u64::MAX);
                continue;
            }
            if let Some(source_index) = source_by_coordinate.get(&coordinate_key(position)).copied()
            {
                projected.push(source_field_xyz_apm_per_a[source_index]);
                mapping.push(source_index as u64);
                continue;
            }
            let (tetra_index, weights) = tetra_bvh
                .as_ref()
                .and_then(|bvh| {
                    sample_tet4_cells.as_deref().and_then(|cells| {
                        bvh.locate(position, &source_positions, cells)
                    })
                })
                .ok_or_else(|| RunError {
                    message: format!(
                        "antenna target projection requires an explicit interpolation for target sample {target_index}; no source node or containing tet4 element was found"
                    ),
                })?;
            let cell = sample_tet4_cells
                .as_deref()
                .and_then(|cells| cells.get(tetra_index).copied())
                .ok_or_else(|| RunError {
                    message: format!(
                        "antenna target projection interpolation selected missing tet4 element {tetra_index}"
                    ),
                })?;
            let value = std::array::from_fn(|component| {
                weights
                    .iter()
                    .copied()
                    .zip(cell)
                    .map(|(weight, node)| {
                        weight * source_field_xyz_apm_per_a[node as usize][component]
                    })
                    .sum::<f64>()
            });
            if value.iter().any(|component| !component.is_finite()) {
                return Err(RunError {
                    message: format!(
                        "antenna target projection produced a non-finite P1 value at target sample {target_index}"
                    ),
                });
            }
            projected.push(value);
            mapping.push(tetra_index as u64);
            mapping.extend(weights.iter().copied().map(f64::to_bits));
            used_interpolation = true;
        }
        let mapping_digest = sha256_u64(&mapping);
        let mapping_digest = if used_interpolation {
            format!("fem_p1_interpolation_v1:{mapping_digest}")
        } else {
            format!("identity_coordinates_v1:{mapping_digest}")
        };
        (projected, mapping_digest)
    };
    let mask_digest = if let Some(mask) = target_mask {
        for (value, selected) in field_xyz_apm_per_a.iter_mut().zip(mask) {
            if !selected {
                *value = [0.0; 3];
            }
        }
        sha256(
            &mask
                .iter()
                .map(|value| u8::from(*value))
                .collect::<Vec<_>>(),
        )
    } else {
        "global".into()
    };
    Ok(ResolvedSolvedAntennaDriveBasisIR {
        drive,
        solution_id: manifest.solution_id,
        source_object_id: manifest.source_object_id,
        field_xyz_apm_per_a,
        projection_signature: format!(
            "{}:{}:{}:{}",
            published_digest, field_ref.sha256, mask_digest, mapping_digest
        ),
    })
}

fn coordinate_key(position: [f64; 3]) -> [u64; 3] {
    position.map(|value| if value == 0.0 { 0.0_f64.to_bits() } else { value.to_bits() })
}

fn sha256_u64(values: &[u64]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<u64>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    sha256(&bytes)
}

/// Immutable resource payload resolved for one opaque antenna solution asset.
/// The runner deliberately never interprets `asset_id` as a filesystem path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntennaFieldSolutionAsset {
    pub manifest_bytes: Vec<u8>,
    pub payloads: Vec<AuxiliaryArtifact>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AntennaFieldSolutionSamples {
    pub solution_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub sample_positions_xyz_m: Vec<[f64; 3]>,
    pub magnetic_field_xyz_apm_per_a: Vec<[f64; 3]>,
    pub sample_tet4_cells: Option<Vec<[u32; 4]>>,
    pub content_digest: String,
}

/// Load the immutable coordinates and per-ampere field for source-spectrum
/// analysis. Every referenced binary is verified independently of plan state.
pub fn load_antenna_field_solution_samples(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
    port_mode_id: &str,
    expected_solution_id: &str,
    expected_source_object_id: &str,
    expected_content_digest: &str,
) -> Result<AntennaFieldSolutionSamples, RunError> {
    verify_antenna_field_solution_referenced_data(manifest_bytes, payloads)?;
    crate::antenna_external_lead_solution::reject_unqualified_external_lead_source(manifest_bytes)?;
    let mut canonical_value: serde_json::Value =
        serde_json::from_slice(manifest_bytes).map_err(|error| RunError {
            message: format!("parse antenna field solution manifest: {error}"),
        })?;
    let published_digest = canonical_value
        .as_object_mut()
        .and_then(|object| object.remove("content_digest"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| RunError {
            message: "antenna field solution manifest has no content_digest".into(),
        })?;
    let canonical = serde_json::to_vec(&canonical_value).map_err(|error| RunError {
        message: format!("canonicalize antenna field solution manifest: {error}"),
    })?;
    if format!("sha256:{}", sha256(&canonical)) != published_digest
        || published_digest != expected_content_digest
    {
        return Err(RunError {
            message: "antenna field solution manifest content_digest mismatch or stale reference"
                .into(),
        });
    }
    canonical_value["content_digest"] = serde_json::Value::String(published_digest.clone());
    let manifest: StoredSolutionManifest =
        serde_json::from_value(canonical_value).map_err(|error| RunError {
            message: format!("validate antenna field solution manifest: {error}"),
        })?;
    validate_sample_carrier(manifest.sample_carrier.as_ref())?;
    validate_basis_normalization(&manifest.bases)?;
    if manifest.schema_version != ANTENNA_FIELD_SOLUTION_SCHEMA
        || manifest.status != "ready"
        || manifest.asset_id.trim().is_empty()
        || !signatures_are_valid(&manifest.signatures)
        || manifest.solution_id != expected_solution_id
        || manifest.source_object_id != expected_source_object_id
    {
        return Err(RunError {
            message: "antenna field solution identity or schema mismatch".into(),
        });
    }
    let basis = manifest
        .bases
        .iter()
        .find(|basis| basis.port_mode_id == port_mode_id)
        .ok_or_else(|| RunError {
            message: format!(
                "antenna field solution '{}' has no port mode '{port_mode_id}'",
                manifest.solution_id
            ),
        })?;
    let positions_ref = &manifest.sample_positions;
    let field_ref = &basis.magnetic_field_per_ampere;
    if basis.normalization_current_a != 1.0
        || positions_ref.scalar_type != "float64_le"
        || positions_ref.layout != "sample_xyz_interleaved"
        || positions_ref.unit != "m"
        || field_ref.scalar_type != "float64_le"
        || field_ref.layout != "sample_xyz_interleaved"
        || field_ref.unit != "A/m/A"
        || positions_ref.value_count == 0
        || positions_ref.value_count != field_ref.value_count
    {
        return Err(RunError {
            message: "antenna source-spectrum carrier metadata is incompatible".into(),
        });
    }
    let decode = |reference: &StoredBinaryFieldRef| -> Result<Vec<[f64; 3]>, RunError> {
        let payload = payloads
            .iter()
            .find(|artifact| artifact.relative_path == reference.path)
            .ok_or_else(|| RunError {
                message: format!("missing antenna field payload '{}'", reference.path),
            })?;
        if sha256(&payload.bytes) != reference.sha256 {
            return Err(RunError {
                message: format!("antenna field payload '{}' sha256 mismatch", reference.path),
            });
        }
        decode_xyz_f64_le(&payload.bytes, reference.value_count)
    };
    let sample_tet4_cells = manifest
        .sample_topology
        .as_ref()
        .map(|reference| {
            let payload = payloads
                .iter()
                .find(|artifact| artifact.relative_path == reference.path)
                .ok_or_else(|| RunError {
                    message: format!("missing antenna field payload '{}'", reference.path),
                })?;
            verify_tet4_topology_ref(reference, payloads, positions_ref.value_count / 3)?;
            decode_tet4_u32_le(
                &payload.bytes,
                reference.value_count,
                positions_ref.value_count / 3,
            )
        })
        .transpose()?;
    Ok(AntennaFieldSolutionSamples {
        solution_id: manifest.solution_id,
        source_object_id: manifest.source_object_id,
        port_mode_id: port_mode_id.to_string(),
        sample_positions_xyz_m: decode(positions_ref)?,
        magnetic_field_xyz_apm_per_a: decode(field_ref)?,
        sample_tet4_cells,
        content_digest: published_digest,
    })
}

/// Resolve the source port for an [`AntennaSpectrumRequestIR`] and load its
/// immutable per-ampere carrier.  Older requests remain valid only when the
/// published solution contains exactly one port basis.  Multi-port assets
/// fail closed instead of silently choosing the first basis.
pub fn load_antenna_field_solution_samples_for_spectrum(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
    request: &AntennaSpectrumRequestIR,
) -> Result<AntennaFieldSolutionSamples, RunError> {
    let reference = request.solution_ref.published().ok_or_else(|| RunError {
        message: format!("antenna source-spectrum request '{}' has an unresolved stage output", request.id),
    })?;
    let (_, manifest) = parse_verified_manifest(manifest_bytes)?;
    let port_mode_id = match request.port_mode_id.as_deref() {
        Some(port_mode_id) if !port_mode_id.trim().is_empty() => port_mode_id,
        Some(_) => {
            return Err(RunError {
                message: format!(
                    "antenna source-spectrum request '{}' has an empty port_mode_id",
                    request.id
                ),
            })
        }
        None => match manifest.bases.as_slice() {
            [basis] => basis.port_mode_id.as_str(),
            [] => {
                return Err(RunError {
                    message: format!(
                        "antenna source-spectrum solution '{}' contains no port basis",
                        reference.output_id
                    ),
                })
            }
            _ => {
                return Err(RunError {
                    message: format!(
                        "antenna source-spectrum request '{}' must identify one port basis; the immutable solution contains {} port bases",
                        request.id,
                        manifest.bases.len()
                    ),
                })
            }
        },
    };
    load_antenna_field_solution_samples(
        manifest_bytes,
        payloads,
        port_mode_id,
        &reference.output_id,
        &manifest.source_object_id,
        &reference.content_digest,
    )
}

/// Verify and project all authored solution references into a resolved FEM
/// plan. The session/artifact layer owns opaque-id lookup; this boundary owns
/// content verification and canonical target projection.
pub fn materialize_fem_solved_antenna_drives(
    problem: &ProblemIRV04,
    plan: &mut FemPlanIR,
    assets: &BTreeMap<String, AntennaFieldSolutionAsset>,
) -> Result<(), RunError> {
    problem.validate().map_err(|reasons| RunError {
        message: format!("invalid antenna composition: {}", reasons.join("; ")),
    })?;

    let target_topology_digest = resolved_target_topology_digest(&plan.mesh)?;

    let materialized = materialize_solved_antenna_drive_parts(
        &problem.solved_antenna_drives,
        &plan.time_stage,
        &problem.antenna_target_projections,
        &problem.antenna_field_solve_stages,
        plan.mesh.nodes.len(),
        &plan.mesh.nodes,
        &target_topology_digest,
        assets,
        |target| {
            fullmag_plan::resolve_fem_antenna_projection_mask(plan, target).map_err(|error| {
                RunError {
                    message: format!("resolve FEM antenna target: {}", error.reasons.join("; ")),
                }
            })
        },
    )?;
    plan.solved_antenna_drive_bases = materialized;
    Ok(())
}

/// Resolve immutable antenna field-solution artifacts authored through the
/// public ProblemIR 0.3 contract into one FEM LLG plan.  Artifact verification
/// and projection are shared with the 0.4 path so both public surfaces consume
/// exactly the same per-ampere field basis.
pub fn materialize_fem_solved_antenna_drives_v03(
    problem: &ProblemIR,
    plan: &mut FemPlanIR,
    assets: &BTreeMap<String, AntennaFieldSolutionAsset>,
) -> Result<(), RunError> {
    problem.validate().map_err(|reasons| RunError {
        message: format!("invalid antenna composition: {}", reasons.join("; ")),
    })?;

    let target_topology_digest = resolved_target_topology_digest(&plan.mesh)?;

    let materialized = materialize_solved_antenna_drive_parts(
        &problem.solved_antenna_drives,
        &plan.time_stage,
        &problem.antenna_target_projections,
        &problem.antenna_field_solve_stages,
        plan.mesh.nodes.len(),
        &plan.mesh.nodes,
        &target_topology_digest,
        assets,
        |target| {
            fullmag_plan::resolve_fem_antenna_projection_mask(plan, target).map_err(|error| {
                RunError {
                    message: format!("resolve FEM antenna target: {}", error.reasons.join("; ")),
                }
            })
        },
    )?;
    plan.solved_antenna_drive_bases = materialized;
    Ok(())
}

/// Resolve an immutable field-solution asset onto the cell-centred FDM grid.
///
/// Source samples at cell centres are reused directly; otherwise a supported
/// source mesh is interpolated at the cell centres. The active-cell mask is
/// applied before sampling because inactive FDM cells are not LLG degrees of
/// freedom. Unsupported or incomplete source sampling fails explicitly.
pub fn materialize_fdm_solved_antenna_drives(
    problem: &ProblemIRV04,
    plan: &mut FdmPlanIR,
    assets: &BTreeMap<String, AntennaFieldSolutionAsset>,
) -> Result<(), RunError> {
    problem.validate().map_err(|reasons| RunError {
        message: format!("invalid antenna composition: {}", reasons.join("; ")),
    })?;
    materialize_fdm_solved_antenna_drive_parts(
        &problem.solved_antenna_drives,
        &problem.antenna_target_projections,
        &problem.antenna_field_solve_stages,
        plan,
        assets,
    )
}

/// Resolve the public 0.3 antenna composition onto an FDM cell-centred grid.
pub fn materialize_fdm_solved_antenna_drives_v03(
    problem: &ProblemIR,
    plan: &mut FdmPlanIR,
    assets: &BTreeMap<String, AntennaFieldSolutionAsset>,
) -> Result<(), RunError> {
    problem.validate().map_err(|reasons| RunError {
        message: format!("invalid antenna composition: {}", reasons.join("; ")),
    })?;
    materialize_fdm_solved_antenna_drive_parts(
        &problem.solved_antenna_drives,
        &problem.antenna_target_projections,
        &problem.antenna_field_solve_stages,
        plan,
        assets,
    )
}

fn materialize_fdm_solved_antenna_drive_parts(
    drives: &[SolvedAntennaDriveIR],
    projections: &[AntennaTargetProjectionRefIR],
    stages: &[AntennaFieldSolveStageIR],
    plan: &mut FdmPlanIR,
    assets: &BTreeMap<String, AntennaFieldSolutionAsset>,
) -> Result<(), RunError> {
    if !drives.iter().any(|drive| {
        drive.activation.is_active_for(
            plan.time_stage.study_kind,
            plan.time_stage.active_stage_id.as_deref(),
        )
    }) {
        plan.solved_antenna_drive_bases.clear();
        return Ok(());
    }
    let target_positions = fdm_cell_center_positions(plan)?;
    let active_mask = fdm_active_mask(plan, target_positions.len())?;
    let target_topology_digest = fdm_target_topology_digest(plan)?;
    let materialized = materialize_solved_antenna_drive_parts(
        drives,
        &plan.time_stage,
        projections,
        stages,
        target_positions.len(),
        &target_positions,
        &target_topology_digest,
        assets,
        |target| fdm_antenna_projection_mask(plan, target, &active_mask),
    )?;
    plan.solved_antenna_drive_bases = materialized;
    Ok(())
}

fn materialize_solved_antenna_drive_parts<F>(
    drives: &[SolvedAntennaDriveIR],
    time_stage: &fullmag_ir::TimeStageContextIR,
    projections: &[AntennaTargetProjectionRefIR],
    stages: &[AntennaFieldSolveStageIR],
    expected_sample_count: usize,
    target_positions: &[[f64; 3]],
    target_topology_digest: &str,
    assets: &BTreeMap<String, AntennaFieldSolutionAsset>,
    resolve_target_mask: F,
) -> Result<Vec<ResolvedSolvedAntennaDriveBasisIR>, RunError>
where
    F: Fn(&FieldTargetIR) -> Result<Option<Vec<bool>>, RunError>,
{
    let mut materialized = Vec::with_capacity(drives.len());
    let mut drive_ids = BTreeSet::new();
    for drive in drives {
        if !drive_ids.insert(drive.id.as_str()) {
            return Err(RunError {
                message: format!("duplicate solved antenna drive '{}'", drive.id),
            });
        }
        if !drive.activation.is_active_for(
            time_stage.study_kind,
            time_stage.active_stage_id.as_deref(),
        ) {
            continue;
        }
        let projection = projections
            .iter()
            .find(|projection| projection.id == drive.projection_ref)
            .ok_or_else(|| RunError {
                message: format!(
                    "solved antenna drive '{}' references missing projection '{}'",
                    drive.id, drive.projection_ref
                ),
            })?;
        let stage = stages
            .iter()
            .find(|stage| stage.id == projection.solution.stage_id())
            .ok_or_else(|| RunError {
                message: format!(
                    "antenna projection '{}' references missing solve stage '{}'",
                    projection.id,
                    projection.solution.stage_id()
                ),
            })?;
        if !stage
            .port_mode_ids
            .iter()
            .any(|id| id == &drive.port_mode_id)
        {
            return Err(RunError {
                message: format!(
                    "solved antenna drive '{}' port mode '{}' was not solved by stage '{}'",
                    drive.id, drive.port_mode_id, stage.id
                ),
            });
        }
        let reference = projection.solution.published().ok_or_else(|| RunError {
            message: format!(
                "antenna projection '{}' has unresolved stage output '{}/{}'",
                projection.id,
                projection.solution.stage_id(),
                projection.solution.output_id()
            ),
        })?;
        let asset = assets.get(&reference.asset_id).ok_or_else(|| RunError {
            message: format!(
                "antenna solution asset '{}' is not resolved in the session artifact store",
                reference.asset_id
            ),
        })?;
        let target_mask = resolve_target_mask(&projection.target).map_err(|error| RunError {
            message: format!(
                "resolve antenna projection '{}': {}",
                projection.id, error.message
            ),
        })?;
        let mut resolved = load_solved_antenna_drive_basis_projected(
            &asset.manifest_bytes,
            &asset.payloads,
            drive.clone(),
            &reference.output_id,
            &stage.source_object_id,
            &reference.content_digest,
            expected_sample_count,
            target_positions,
            target_mask.as_deref(),
        )?;
        if resolved
            .field_xyz_apm_per_a
            .iter()
            .flatten()
            .any(|value| !(*value * drive.peak_current_a).is_finite())
        {
            return Err(RunError {
                message: format!(
                    "solved antenna drive '{}' peak current produces a non-finite projected H field",
                    drive.id
                ),
            });
        }
        resolved.projection_signature.push_str(":target_topology:");
        resolved.projection_signature.push_str(target_topology_digest);
        materialized.push(resolved);
    }
    Ok(materialized)
}

fn resolved_target_topology_digest(value: &impl Serialize) -> Result<String, RunError> {
    let bytes = serde_json::to_vec(value).map_err(|error| RunError {
        message: format!("serialize resolved antenna target topology: {error}"),
    })?;
    Ok(format!("sha256:{}", sha256(&bytes)))
}

pub(crate) fn fdm_target_topology_digest(plan: &FdmPlanIR) -> Result<String, RunError> {
    resolved_target_topology_digest(&(
        plan.origin_m,
        &plan.grid,
        plan.cell_size,
        &plan.region_mask,
        &plan.active_mask,
    ))
}

fn fdm_cell_center_positions(plan: &FdmPlanIR) -> Result<Vec<[f64; 3]>, RunError> {
    let certificate = plan.grid_certificate.as_ref().ok_or_else(|| RunError {
        message: "FDM antenna target projection requires a grid certificate".into(),
    })?;
    certificate
        .validate_against_masks(plan.active_mask.as_deref(), &plan.region_mask)
        .map_err(|message| RunError {
            message: format!("FDM antenna target grid certificate is invalid: {message}"),
        })?;
    if certificate.origin_m != plan.origin_m
        || certificate.counts != plan.grid.cells
        || certificate.cell_m != plan.cell_size
    {
        return Err(RunError {
            message: "FDM antenna target grid certificate does not match resolved plan".into(),
        });
    }
    let [nx, ny, nz] = plan.grid.cells;
    let expected = usize::try_from(
        u64::from(nx)
            .checked_mul(u64::from(ny))
            .and_then(|value| value.checked_mul(u64::from(nz)))
            .ok_or_else(|| RunError {
                message: "FDM antenna target grid cell count overflows usize".into(),
            })?,
    )
    .map_err(|_| RunError {
        message: "FDM antenna target grid cell count is not addressable".into(),
    })?;
    if expected == 0 {
        return Err(RunError {
            message: "FDM antenna target projection requires a non-empty grid".into(),
        });
    }
    if plan.initial_magnetization.len() != expected || plan.region_mask.len() != expected {
        return Err(RunError {
            message: format!(
                "FDM antenna target topology has {expected} cells but initial_magnetization={} and region_mask={}",
                plan.initial_magnetization.len(),
                plan.region_mask.len()
            ),
        });
    }
    let mut positions = Vec::with_capacity(expected);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                positions.push([
                    plan.origin_m[0] + (f64::from(x) + 0.5) * plan.cell_size[0],
                    plan.origin_m[1] + (f64::from(y) + 0.5) * plan.cell_size[1],
                    plan.origin_m[2] + (f64::from(z) + 0.5) * plan.cell_size[2],
                ]);
            }
        }
    }
    Ok(positions)
}

fn fdm_active_mask(plan: &FdmPlanIR, expected: usize) -> Result<Vec<bool>, RunError> {
    let mask = plan
        .active_mask
        .clone()
        .unwrap_or_else(|| vec![true; expected]);
    if mask.len() != expected {
        return Err(RunError {
            message: format!(
                "FDM antenna active mask has {} entries; expected {expected}",
                mask.len()
            ),
        });
    }
    if !mask.iter().any(|active| *active) {
        return Err(RunError {
            message: "FDM antenna target projection has no active cells".into(),
        });
    }
    Ok(mask)
}

fn fdm_antenna_projection_mask(
    plan: &FdmPlanIR,
    target: &FieldTargetIR,
    active_mask: &[bool],
) -> Result<Option<Vec<bool>>, RunError> {
    let certificate = plan.grid_certificate.as_ref().ok_or_else(|| RunError {
        message: "FDM antenna target projection requires a grid certificate".into(),
    })?;
    if certificate.region_legend.is_empty() && matches!(target, FieldTargetIR::Region { .. }) {
        return Err(RunError {
            message: "FDM antenna region target requires a resolved region legend".into(),
        });
    }
    let mut selected_regions = BTreeSet::new();
    match target {
        FieldTargetIR::Global {} => {}
        FieldTargetIR::Object { object_id } => {
            selected_regions.extend(
                certificate
                    .region_legend
                    .iter()
                    .filter(|entry| entry.object_id == *object_id)
                    .map(|entry| entry.numeric_id),
            );
            if selected_regions.is_empty()
                && !(certificate.object_ids.len() == 1
                    && certificate.object_ids.first() == Some(object_id))
            {
                return Err(RunError {
                    message: format!(
                        "FDM antenna object target '{object_id}' has no resolved object or region cells"
                    ),
                });
            }
        }
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => {
            let Some(entry) = certificate
                .region_legend
                .iter()
                .find(|entry| entry.object_id == *object_id && entry.region_id == *region_id)
            else {
                return Err(RunError {
                    message: format!(
                        "FDM antenna region target '{object_id}:{region_id}' has no resolved region marker"
                    ),
                });
            };
            selected_regions.insert(entry.numeric_id);
        }
    }
    let mut mask = active_mask.to_vec();
    if !selected_regions.is_empty() {
        for (selected, region) in mask.iter_mut().zip(&plan.region_mask) {
            *selected &= selected_regions.contains(region);
        }
    }
    if !mask.iter().any(|selected| *selected) {
        return Err(RunError {
            message: format!("FDM antenna target {target:?} selects no active cells"),
        });
    }
    Ok(Some(mask))
}

pub(crate) fn build_antenna_field_solution_artifacts(
    input: &AntennaFieldSolutionInput,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    for (label, value) in [
        ("asset_id", input.asset_id.as_str()),
        ("solution_id", input.solution_id.as_str()),
        ("source_object_id", input.source_object_id.as_str()),
        ("current_transport_id", input.current_transport_id.as_str()),
        ("stage_id", input.stage_id.as_str()),
        ("geometry_revision", input.geometry_revision.as_str()),
        ("material_revision", input.material_revision.as_str()),
        ("mesh_digest", input.mesh_digest.as_str()),
        ("gauge_policy", input.gauge_policy.as_str()),
    ] {
        validate_nonempty(label, value)?;
    }
    if !signatures_are_valid(&input.signatures) {
        return Err(RunError {
            message: "antenna field solution signatures must be sha256: followed by 64 lowercase hex digits".into(),
        });
    }
    if input.bases.is_empty() {
        return Err(RunError {
            message: "antenna field solution requires at least one port-mode basis".into(),
        });
    }
    if input.sample_positions_xyz_m.is_empty()
        || input
            .sample_positions_xyz_m
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(RunError {
            message: "antenna field solution requires finite sample positions".into(),
        });
    }
    validate_sample_carrier(Some(&input.sample_carrier))?;
    if input.conductor_positions_xyz_m.is_empty()
        || input
            .conductor_positions_xyz_m
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(RunError {
            message: "antenna field solution requires finite conductor positions".into(),
        });
    }

    let conductor_positions_path = format!(
        "antenna/field_solutions/{}/conductor_positions_xyz_m.f64le",
        input.solution_id
    );
    let conductor_positions_bytes = encode_f64(
        input
            .conductor_positions_xyz_m
            .iter()
            .flat_map(|value| value.iter().copied()),
    );
    let conductor_positions_sha = sha256(&conductor_positions_bytes);

    let sample_positions_path = format!(
        "antenna/field_solutions/{}/sample_positions_xyz_m.f64le",
        input.solution_id
    );
    let sample_positions_bytes = encode_f64(
        input
            .sample_positions_xyz_m
            .iter()
            .flat_map(|value| value.iter().copied()),
    );
    let sample_positions_sha = sha256(&sample_positions_bytes);

    let sample_topology = input.sample_tet4_cells.as_ref().map(|cells| {
        let bytes = encode_u32(cells.iter().flat_map(|cell| cell.iter().copied()));
        let path = format!(
            "antenna/field_solutions/{}/sample_topology_tet4.u32le",
            input.solution_id
        );
        let sha = sha256(&bytes);
        (path, bytes, sha, cells.len() * 4)
    });
    if let Some((_, _, _, value_count)) = sample_topology.as_ref() {
        if *value_count == 0 {
            return Err(RunError {
                message: "antenna field solution tetrahedral sampling topology must not be empty"
                    .into(),
            });
        }
        for (cell_index, cell) in input
            .sample_tet4_cells
            .as_ref()
            .expect("sample topology is present")
            .iter()
            .enumerate()
        {
            if cell
                .iter()
                .any(|node| *node as usize >= input.sample_positions_xyz_m.len())
            {
                return Err(RunError {
                    message: format!(
                        "antenna field solution sampling tetrahedron {cell_index} references a node outside the sample carrier"
                    ),
                });
            }
        }
    }

    struct EncodedBasis {
        potential_path: String,
        current_path: String,
        field_path: String,
        potential_sha: String,
        current_sha: String,
        field_sha: String,
        potential_bytes: Vec<u8>,
        current_bytes: Vec<u8>,
        field_bytes: Vec<u8>,
        potential_count: usize,
        current_count: usize,
        field_count: usize,
        scale: f64,
        evidence: Option<(AntennaQuadratureEvidenceRef, Vec<u8>)>,
    }

    let mut encoded = Vec::with_capacity(input.bases.len());
    for basis in &input.bases {
        validate_nonempty("port_mode_id", &basis.port_mode_id)?;
        validate_nonempty(
            "current_balance_certificate_digest",
            &basis.current_balance_certificate_digest,
        )?;
        let current = basis.measured_positive_terminal_current_a;
        if !current.is_finite() || current <= 1.0e-30 {
            return Err(RunError {
                message: format!(
                    "port mode '{}' measured positive terminal current must be finite and positive",
                    basis.port_mode_id
                ),
            });
        }
        if basis.electric_potential_v.len() != input.conductor_positions_xyz_m.len()
            || basis.current_density_xyz_apm2.len() != input.conductor_positions_xyz_m.len()
            || basis.magnetic_field_xyz_apm.len() != input.sample_positions_xyz_m.len()
        {
            return Err(RunError {
                message: format!(
                    "port mode '{}' V/J counts must match the conductor carrier and H must match the field-sampling carrier",
                    basis.port_mode_id
                ),
            });
        }
        let scale = 1.0 / current;
        if !scale.is_finite() {
            return Err(RunError {
                message: format!(
                    "port mode '{}' per-ampere normalization scale is non-finite",
                    basis.port_mode_id
                ),
            });
        }
        let potential_bytes = encode_scaled_basis_f64(
            basis.electric_potential_v.iter().copied(),
            scale,
            &basis.port_mode_id,
            "electric potential",
        )?;
        let current_bytes = encode_scaled_basis_f64(
            basis
                .current_density_xyz_apm2
                .iter()
                .flat_map(|value| value.iter().copied()),
            scale,
            &basis.port_mode_id,
            "current density",
        )?;
        let field_bytes = encode_scaled_basis_f64(
            basis
                .magnetic_field_xyz_apm
                .iter()
                .flat_map(|value| value.iter().copied()),
            scale,
            &basis.port_mode_id,
            "magnetic field",
        )?;
        let base = format!(
            "antenna/field_solutions/{}/{}",
            input.solution_id, basis.port_mode_id
        );
        let evidence = match basis.oersted_operator_version.as_str() {
            fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION => {
                let snapshot = basis.direct_quadrature_snapshot.clone().ok_or_else(|| RunError {
                    message: "cannot publish direct v3 antenna basis without full native snapshot".into(),
                })?;
                if snapshot.targets.len() != input.sample_positions_xyz_m.len()
                    || snapshot.targets.iter().zip(&basis.magnetic_field_xyz_apm)
                        .any(|(row, field)| row.h_xyz_apm.iter().zip(field)
                            .any(|(a, b)| a.to_bits() != b.to_bits()))
                {
                    return Err(RunError { message: "native raw H snapshot differs from publication input".into() });
                }
                let evidence = DirectQuadratureEvidence {
                    snapshot, measured_positive_terminal_current_a: current,
                    normalization_scale: scale,
                    current_balance_certificate_digest: basis.current_balance_certificate_digest.clone(),
                };
                evidence.verify_binding(
                    &input.sample_positions_xyz_m,
                    &decode_xyz_f64_le(&field_bytes, basis.magnetic_field_xyz_apm.len() * 3)?,
                    current, scale, &basis.current_balance_certificate_digest, &basis.quadrature_diagnostics,
                )?;
                let bytes = evidence.encode()?;
                Some((AntennaQuadratureEvidenceRef {
                    schema_version: EVIDENCE_SCHEMA.into(), path: format!("{base}/direct_quadrature.v1.bin"),
                    sha256: sha256(&bytes), byte_length: bytes.len(), target_count: evidence.snapshot.targets.len(),
                }, bytes))
            }
            fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION => {
                if basis.direct_quadrature_snapshot.is_some()
                    || basis.quadrature_diagnostics.get("operator_version").and_then(|v| v.as_str())
                        != Some(fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION)
                {
                    return Err(RunError { message: "mixed direct/vector-potential publication input".into() });
                }
                None
            }
            _ => return Err(RunError { message: "unsupported antenna Oersted publication operator".into() }),
        };
        encoded.push(EncodedBasis {
            potential_path: format!("{base}/V_per_A.f64le"),
            current_path: format!("{base}/J_per_A.f64le"),
            field_path: format!("{base}/H_per_A.f64le"),
            potential_sha: sha256(&potential_bytes),
            current_sha: sha256(&current_bytes),
            field_sha: sha256(&field_bytes),
            potential_count: basis.electric_potential_v.len(),
            current_count: basis.current_density_xyz_apm2.len() * 3,
            field_count: basis.magnetic_field_xyz_apm.len() * 3,
            potential_bytes,
            current_bytes,
            field_bytes,
            scale,
            evidence,
        });
    }

    let bases = input
        .bases
        .iter()
        .zip(&encoded)
        .map(|(basis, data)| BasisManifest {
            port_mode_id: &basis.port_mode_id,
            measured_positive_terminal_current_a: basis.measured_positive_terminal_current_a,
            normalization_current_a: 1.0,
            normalization_scale: data.scale,
            current_balance_certificate_digest: &basis.current_balance_certificate_digest,
            electric_potential_per_ampere: BinaryFieldRef {
                path: &data.potential_path,
                sha256: &data.potential_sha,
                scalar_type: "float64_le",
                layout: "node_scalar",
                unit: "V/A",
                value_count: data.potential_count,
            },
            current_density_per_ampere: BinaryFieldRef {
                path: &data.current_path,
                sha256: &data.current_sha,
                scalar_type: "float64_le",
                layout: "sample_xyz_interleaved",
                unit: "A/m^2/A",
                value_count: data.current_count,
            },
            magnetic_field_per_ampere: BinaryFieldRef {
                path: &data.field_path,
                sha256: &data.field_sha,
                scalar_type: "float64_le",
                layout: "sample_xyz_interleaved",
                unit: "A/m/A",
                value_count: data.field_count,
            },
            quadrature_diagnostics: &basis.quadrature_diagnostics,
            oersted_operator_version: &basis.oersted_operator_version,
            quadrature_evidence: data.evidence.as_ref().map(|(reference, _)| reference),
        })
        .collect();
    let manifest = SolutionManifest {
        schema_version: ANTENNA_FIELD_SOLUTION_SCHEMA,
        asset_id: &input.asset_id,
        status: "ready",
        solution_id: &input.solution_id,
        source_object_id: &input.source_object_id,
        current_transport_id: &input.current_transport_id,
        stage_id: &input.stage_id,
        geometry_revision: &input.geometry_revision,
        material_revision: &input.material_revision,
        mesh_digest: &input.mesh_digest,
        requested_execution: &input.requested_execution,
        resolved_execution: &input.resolved_execution,
        gauge_policy: &input.gauge_policy,
        solver_policy: &input.solver_policy,
        signatures: &input.signatures,
        conductor_positions: BinaryFieldRef {
            path: &conductor_positions_path,
            sha256: &conductor_positions_sha,
            scalar_type: "float64_le",
            layout: "node_xyz_interleaved",
            unit: "m",
            value_count: input.conductor_positions_xyz_m.len() * 3,
        },
        sample_positions: BinaryFieldRef {
            path: &sample_positions_path,
            sha256: &sample_positions_sha,
            scalar_type: "float64_le",
            layout: "sample_xyz_interleaved",
            unit: "m",
            value_count: input.sample_positions_xyz_m.len() * 3,
        },
        sample_carrier: &input.sample_carrier,
        sample_topology: sample_topology.as_ref().map(|(path, _, sha, value_count)| {
            BinaryFieldRef {
                path,
                sha256: sha,
                scalar_type: "uint32_le",
                layout: "tet4_connectivity",
                unit: "1",
                value_count: *value_count,
            }
        }),
        assumptions: [
            "linear_ohmic_conduction",
            "nonmagnetic_background",
            "quasistatic_free_current_field",
            "no_eddy_current_backreaction",
        ],
        bases,
    };
    let manifest_without_digest = serde_json::to_value(&manifest).map_err(|error| RunError {
        message: format!("serialize antenna field solution manifest: {error}"),
    })?;
    let canonical = serde_json::to_vec(&manifest_without_digest).map_err(|error| RunError {
        message: format!("canonicalize antenna field solution manifest: {error}"),
    })?;
    let content_digest = format!("sha256:{}", sha256(&canonical));
    let mut published = manifest_without_digest;
    published["content_digest"] = serde_json::Value::String(content_digest);
    let manifest_bytes = serde_json::to_vec_pretty(&published).map_err(|error| RunError {
        message: format!("publish antenna field solution manifest: {error}"),
    })?;

    let mut artifacts = Vec::with_capacity(encoded.len() * 3 + 4);
    artifacts.push(AuxiliaryArtifact {
        relative_path: conductor_positions_path,
        bytes: conductor_positions_bytes,
    });
    artifacts.push(AuxiliaryArtifact {
        relative_path: sample_positions_path,
        bytes: sample_positions_bytes,
    });
    if let Some((path, bytes, _, _)) = sample_topology {
        artifacts.push(AuxiliaryArtifact {
            relative_path: path,
            bytes,
        });
    }
    for data in encoded {
        artifacts.push(AuxiliaryArtifact {
            relative_path: data.potential_path,
            bytes: data.potential_bytes,
        });
        artifacts.push(AuxiliaryArtifact {
            relative_path: data.current_path,
            bytes: data.current_bytes,
        });
        artifacts.push(AuxiliaryArtifact {
            relative_path: data.field_path,
            bytes: data.field_bytes,
        });
        if let Some((reference, bytes)) = data.evidence {
            artifacts.push(AuxiliaryArtifact { relative_path: reference.path, bytes });
        }
    }
    verify_antenna_field_solution_asset(&manifest_bytes, &artifacts)?;
    artifacts.push(AuxiliaryArtifact {
        relative_path: format!(
            "antenna/field_solutions/{}/manifest.v1.json",
            input.solution_id
        ),
        bytes: manifest_bytes,
    });
    Ok(artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(current_a: f64) -> AntennaFieldSolutionInput {
        AntennaFieldSolutionInput {
            asset_id: "afs-fixture".into(),
            solution_id: "solution_1".into(),
            source_object_id: "antenna_1".into(),
            current_transport_id: "current_1".into(),
            stage_id: "solve_antenna_1".into(),
            geometry_revision: "geometry-r1".into(),
            material_revision: "material-r1".into(),
            mesh_digest: "mesh-digest".into(),
            requested_execution: serde_json::json!({"device": "auto"}),
            resolved_execution: serde_json::json!({"device": "cpu", "precision": "double"}),
            gauge_policy: "dirichlet_reference".into(),
            solver_policy: serde_json::json!({"relative_tolerance": 1e-10}),
            signatures: AntennaFieldSolutionSignatures {
                current_solution_signature: format!("sha256:{}", "1".repeat(64)),
                field_solution_signature: format!("sha256:{}", "2".repeat(64)),
                target_projection_signatures: BTreeMap::from([(
                    "object:magnet".into(),
                    format!("sha256:{}", "3".repeat(64)),
                )]),
                dependency_signatures: None,
            },
            conductor_positions_xyz_m: vec![[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
            sample_positions_xyz_m: vec![[0.1, 0.2, 0.3]],
            sample_carrier: AntennaSampleCarrier {
                domain: FieldTargetIR::Object { object_id: "magnet".into() },
                carrier_kind: "fem_mesh_asset:magnet".into(),
                location: "node".into(),
                topology_digest: format!("sha256:{}", "4".repeat(64)),
            },
            sample_tet4_cells: None,
            bases: vec![AntennaFieldBasisInput {
                port_mode_id: "common".into(),
                measured_positive_terminal_current_a: current_a,
                electric_potential_v: vec![2.0, 4.0],
                current_density_xyz_apm2: vec![[2.0, 4.0, 6.0], [8.0, 10.0, 12.0]],
                magnetic_field_xyz_apm: vec![[8.0, 10.0, 12.0]],
                current_balance_certificate_digest: "balance-digest".into(),
                // Synthetic non-direct plumbing fixture; not an OE-F2 science certificate.
                quadrature_diagnostics: serde_json::json!({"operator_version": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION}),
                oersted_operator_version: fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION.into(),
                direct_quadrature_snapshot: None,
            }],
        }
    }

    fn decode_first_f64(bytes: &[u8]) -> f64 {
        f64::from_le_bytes(bytes[0..8].try_into().unwrap())
    }

    fn drive() -> SolvedAntennaDriveIR {
        serde_json::from_value(serde_json::json!({
            "id": "drive_1",
            "name": "Drive 1",
            "projection_ref": "projection_1",
            "port_mode_id": "common",
            "peak_current_a": 0.25,
            "waveform": {"kind": "constant"},
            "time_origin": "absolute",
            "activation": {"kind": "all_time_evolution"}
        }))
        .unwrap()
    }

    fn spectrum_request(port_mode_id: Option<&str>) -> AntennaSpectrumRequestIR {
        let mut value = serde_json::json!({
            "id": "source_k",
            "solution_ref": {
                "stage_id": "solve_antenna_1",
                "output_id": "solution_1",
                "asset_id": "afs-fixture",
                "content_digest": "sha256:verified"
            },
            "target": {"kind": "global"},
            "transform": "spatial_fft",
            "sampling_plane": {
                "origin_m": [0.1, 0.2, 0.3],
                "axis_u": [1.0, 0.0, 0.0],
                "axis_v": [0.0, 1.0, 0.0],
                "extent_u_m": 1.0,
                "extent_v_m": 1.0,
                "sample_count_u": 2,
                "sample_count_v": 2,
                "interpolation": "fem_element",
                "outside_policy": "zero"
            },
            "window": "rectangular",
            "normalization": "unitary_discrete",
            "component": "x",
            "output_id": "spectrum"
        });
        if let Some(port_mode_id) = port_mode_id {
            value["port_mode_id"] = serde_json::Value::String(port_mode_id.to_string());
        }
        serde_json::from_value(value).unwrap()
    }

    fn manifest_digest(bytes: &[u8]) -> String {
        serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["content_digest"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn fdm_projection_fixture() -> (
        FdmPlanIR,
        AntennaTargetProjectionRefIR,
        AntennaFieldSolveStageIR,
    ) {
        let mut plan = FdmPlanIR::default();
        plan.time_stage.study_kind = fullmag_ir::StudyKindIR::TimeEvolution;
        plan.origin_m = [0.0, 0.0, 0.0];
        plan.grid.cells = [2, 1, 1];
        plan.cell_size = [2.0, 2.0, 2.0];
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; 2];
        plan.region_mask = vec![0, 0];
        plan.active_mask = Some(vec![true, false]);
        plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_masks(
                plan.origin_m,
                plan.grid.cells,
                plan.cell_size,
                1,
                1,
                plan.active_mask.as_deref(),
                &plan.region_mask,
            )
            .unwrap()
            .with_object_ids(vec!["antenna_1".into()]),
        );
        let projection = AntennaTargetProjectionRefIR {
            id: "projection_1".into(),
            solution: fullmag_ir::AntennaSolutionRefIR::Published(
                fullmag_ir::AntennaFieldSolutionRefIR {
                    stage_id: "solve_antenna_1".into(),
                    output_id: "solution_1".into(),
                    asset_id: "afs-fixture".into(),
                    content_digest: "sha256:placeholder".into(),
                },
            ),
            target: FieldTargetIR::Global {},
            output_id: "solution_1".into(),
        };
        let stage = AntennaFieldSolveStageIR {
            id: "solve_antenna_1".into(),
            source_object_id: "antenna_1".into(),
            current_transport_id: "current_1".into(),
            port_mode_ids: vec!["common".into()],
            conservative_current_view_ref: Some("current_1:rt0".into()),
            model: fullmag_ir::AntennaFieldModelIR::QuasistaticConductionBiotSavart3d,
            oersted_realization: fullmag_ir::AntennaOerstedRealizationIR::DirectTetraQuadrature,
            conductor_mesh_policy: "authored_shared_domain".into(),
            field_sampling_domain: FieldTargetIR::Global {},
            target_refs: vec![FieldTargetIR::Global {}],
            solver_policy: "production_default".into(),
            outputs: vec![fullmag_ir::AntennaNamedOutputIR {
                id: "solution_1".into(),
                quantity: "H_ant_basis".into(),
            }],
        };
        (plan, projection, stage)
    }

    #[test]
    fn publishes_payloads_before_manifest_and_normalizes_to_one_ampere() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        assert_eq!(decode_first_f64(&artifacts[0].bytes), 0.1);
        assert_eq!(decode_first_f64(&artifacts[1].bytes), 0.1);
        assert_eq!(decode_first_f64(&artifacts[2].bytes), 1.0);
        assert_eq!(decode_first_f64(&artifacts[3].bytes), 1.0);
        assert_eq!(decode_first_f64(&artifacts[4].bytes), 4.0);
        assert!(artifacts
            .last()
            .unwrap()
            .relative_path
            .ends_with("manifest.v1.json"));
        let manifest: serde_json::Value =
            serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        assert_eq!(manifest["schema_version"], ANTENNA_FIELD_SOLUTION_SCHEMA);
        assert_eq!(manifest["asset_id"], "afs-fixture");
        assert_eq!(manifest["status"], "ready");
        assert_eq!(manifest["conductor_positions"]["unit"], "m");
        assert_eq!(manifest["sample_positions"]["unit"], "m");
        assert_eq!(manifest["sample_carrier"]["domain"]["object_id"], "magnet");
        assert_eq!(manifest["sample_carrier"]["carrier_kind"], "fem_mesh_asset:magnet");
        assert_eq!(manifest["sample_carrier"]["location"], "node");
        assert_eq!(manifest["sample_carrier"]["topology_digest"], format!("sha256:{}", "4".repeat(64)));
        assert_eq!(
            manifest["sample_positions"]["layout"],
            "sample_xyz_interleaved"
        );
        assert_eq!(manifest["bases"][0]["normalization_current_a"], 1.0);
        assert!(manifest["content_digest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn readers_reject_rehashed_invalid_normalization_in_an_unselected_port() {
        let mut fixture = input(2.0);
        let mut other = fixture.bases[0].clone();
        other.port_mode_id = "other".into();
        fixture.bases.push(other);
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let payloads = &artifacts[..artifacts.len() - 1];
        let published = &artifacts.last().unwrap().bytes;
        verify_antenna_field_solution_asset(published, payloads).unwrap();
        for (field, value) in [
            ("normalization_scale", Some(serde_json::json!(2.0))),
            ("measured_positive_terminal_current_a", Some(serde_json::json!(0.0))),
            ("measured_positive_terminal_current_a", Some(serde_json::json!(-2.0))),
            ("normalization_current_a", Some(serde_json::json!(2.0))),
            ("normalization_scale", None),
            ("measured_positive_terminal_current_a", None),
        ] {
            let mut manifest: serde_json::Value = serde_json::from_slice(published).unwrap();
            let basis = manifest["bases"][1].as_object_mut().unwrap();
            if let Some(value) = value {
                basis.insert(field.into(), value);
            } else {
                basis.remove(field);
            }
            manifest.as_object_mut().unwrap().remove("content_digest");
            let digest = format!("sha256:{}", sha256(&serde_json::to_vec(&manifest).unwrap()));
            manifest["content_digest"] = serde_json::json!(digest);
            let bytes = serde_json::to_vec(&manifest).unwrap();
            assert!(verify_antenna_field_solution_manifest(&bytes).is_err(), "{field}");
            assert!(verify_antenna_field_solution_asset(&bytes, payloads).is_err(), "{field}");
            assert!(load_antenna_field_solution_samples(
                &bytes, payloads, "common", "solution_1", "antenna_1", &digest,
            ).is_err(), "{field}");
            assert!(load_solved_antenna_drive_basis_projected(
                &bytes, payloads, drive(), "solution_1", "antenna_1", &digest,
                1, &fixture.sample_positions_xyz_m, None,
            ).is_err(), "{field}");
        }
    }

    #[test]
    fn payload_read_plan_refuses_unsafe_alias_and_overflow_metadata() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        for mutation in 0..7 {
            let mut value = original.clone();
            match mutation {
                0 => value["sample_positions"]["path"] = value["conductor_positions"]["path"].clone(),
                1 => value["sample_positions"]["path"] = serde_json::json!("antenna/field_solutions/other/positions.bin"),
                2 => value["sample_positions"]["path"] = serde_json::json!("antenna/field_solutions/solution_1/../positions.bin"),
                3 => value["sample_positions"]["path"] = serde_json::json!("antenna/field_solutions/solution_1/positions.bin:stream"),
                4 => value["bases"][0]["magnetic_field_per_ampere"]["unit"] = serde_json::json!("T"),
                5 => value["conductor_positions"]["value_count"] = serde_json::json!(usize::MAX),
                _ => value["bases"][0]["magnetic_field_per_ampere"]["value_count"] = serde_json::json!(6),
            }
            value.as_object_mut().unwrap().remove("content_digest");
            value["content_digest"] = serde_json::json!(format!("sha256:{}", sha256(&serde_json::to_vec(&value).unwrap())));
            assert!(antenna_field_solution_payload_lengths(&serde_json::to_vec(&value).unwrap()).is_err(), "{mutation}");
        }
    }

    #[test]
    fn direct_read_plan_applies_evidence_bounds_before_payload_io() {
        let fixture = direct_evidence_fixture();
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        antenna_field_solution_payload_lengths(&artifacts.last().unwrap().bytes).unwrap();
        for mutation in 0..4 {
            let mut value = original.clone();
            match mutation {
                0 => { value["bases"][0].as_object_mut().unwrap().remove("quadrature_evidence"); }
                1 => value["bases"][0]["quadrature_evidence"]["target_count"] = serde_json::json!(direct_quadrature::MAX_TARGETS + 1),
                2 => value["bases"][0]["quadrature_evidence"]["byte_length"] = serde_json::json!(usize::MAX),
                _ => value["bases"][0]["quadrature_evidence"]["schema_version"] = serde_json::json!("fem_direct_oersted_evidence.v2"),
            }
            value.as_object_mut().unwrap().remove("content_digest");
            value["content_digest"] = serde_json::json!(format!("sha256:{}", sha256(&serde_json::to_vec(&value).unwrap())));
            assert!(antenna_field_solution_payload_lengths(&serde_json::to_vec(&value).unwrap()).is_err(), "{mutation}");
        }
    }

    #[test]
    fn read_plan_refuses_aggregate_overflow_with_valid_individual_lengths() {
        let mut fixture = input(2.0);
        let mut other = fixture.bases[0].clone();
        other.port_mode_id = "other".into();
        fixture.bases.push(other);
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        // Each buffer fits even the per-allocation isize bound, but the
        // positions and two magnetic-field buffers cannot coexist in usize.
        let count = (usize::MAX / 16 / 3) * 3;
        assert!(count.checked_mul(8).unwrap() <= isize::MAX as usize);
        value["sample_positions"]["value_count"] = serde_json::json!(count);
        for basis in value["bases"].as_array_mut().unwrap() {
            basis["magnetic_field_per_ampere"]["value_count"] = serde_json::json!(count);
        }
        value.as_object_mut().unwrap().remove("content_digest");
        value["content_digest"] = serde_json::json!(format!("sha256:{}", sha256(&serde_json::to_vec(&value).unwrap())));
        let error = antenna_field_solution_payload_lengths(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(error.message.contains("aggregate size overflows"));
    }

    #[test]
    fn decoded_buffers_preserve_values_and_validation() {
        let bytes: Vec<u8> = [1.0_f64, -2.0, 3.0].into_iter().flat_map(f64::to_le_bytes).collect();
        assert_eq!(decode_xyz_f64_le(&bytes, 3).unwrap(), vec![[1.0, -2.0, 3.0]]);
        assert!(decode_xyz_f64_le(&bytes, 6).is_err());
        let nonfinite: Vec<u8> = [1.0_f64, f64::NAN, 3.0].into_iter().flat_map(f64::to_le_bytes).collect();
        assert!(decode_xyz_f64_le(&nonfinite, 3).is_err());
        let topology: Vec<u8> = [0_u32, 1, 2, 3].into_iter().flat_map(u32::to_le_bytes).collect();
        assert_eq!(decode_tet4_u32_le(&topology, 4, 4).unwrap(), vec![[0, 1, 2, 3]]);
        assert!(decode_tet4_u32_le(&topology, 4, 3).is_err());
        assert!(decode_tet4_u32_le(&topology, 8, 4).is_err());
    }

    #[test]
    fn read_plan_preserves_vector_potential_carrier_support_above_direct_limit() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        let count = (direct_quadrature::MAX_TARGETS as usize + 1) * 3;
        value["sample_positions"]["value_count"] = serde_json::json!(count);
        value["bases"][0]["magnetic_field_per_ampere"]["value_count"] = serde_json::json!(count);
        value.as_object_mut().unwrap().remove("content_digest");
        value["content_digest"] = serde_json::json!(format!("sha256:{}", sha256(&serde_json::to_vec(&value).unwrap())));
        let lengths = antenna_field_solution_payload_lengths(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(lengths[value["sample_positions"]["path"].as_str().unwrap()], count * 8);
        // Metadata support only: no payload allocation, solve or numerical qualification.
    }

    #[test]
    fn readers_refuse_duplicate_manifest_keys_even_when_last_value_and_digest_are_valid() {
        let mut fixture = direct_evidence_fixture();
        let mut other = fixture.bases[0].clone();
        other.port_mode_id = "other".into();
        fixture.bases.push(other);
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let payloads = &artifacts[..artifacts.len() - 1];
        let published = &artifacts.last().unwrap().bytes;
        verify_antenna_field_solution_asset(published, payloads).unwrap();
        let digest = manifest_digest(published);
        let text = std::str::from_utf8(published).unwrap();
        for (key, earlier_value) in [
            ("status", "\"failed\""),
            ("measured_positive_terminal_current_a", "0.0"),
            ("quadrature_scope", "\"local_pair\""),
            ("target_count", "0"),
            ("content_digest", "\"invalid\""),
        ] {
            let prefix = format!("\"{key}\":");
            assert!(text.contains(&prefix));
            let duplicate = text.replace(&prefix, &format!("{prefix}{earlier_value},{prefix}"));
            // A last-key-wins reader sees exactly the original valid manifest.
            assert_eq!(serde_json::from_str::<serde_json::Value>(&duplicate).unwrap(),
                       serde_json::from_slice::<serde_json::Value>(published).unwrap());
            let bytes = duplicate.as_bytes();
            assert!(verify_antenna_field_solution_manifest(bytes).unwrap_err().message.contains("duplicate JSON key"), "{key}");
            assert!(verify_antenna_field_solution_asset(bytes, payloads).is_err(), "{key}");
            assert!(load_antenna_field_solution_samples(
                bytes, payloads, "common", "solution_1", "antenna_1", &digest,
            ).is_err(), "{key}");
            assert!(load_solved_antenna_drive_basis_projected(
                bytes, payloads, drive(), "solution_1", "antenna_1", &digest,
                fixture.sample_positions_xyz_m.len(), &fixture.sample_positions_xyz_m, None,
            ).is_err(), "{key}");
        }
        let escaped_duplicate = text.replacen("\"status\":", r#""\u0073tatus":"failed","status":"#, 1);
        assert!(verify_antenna_field_solution_manifest(escaped_duplicate.as_bytes()).is_err());
    }

    fn direct_evidence_fixture() -> AntennaFieldSolutionInput {
        // Synthetic binary-ledger fixture, not a solved physical conductor.
        let evidence = direct_quadrature::tests::example();
        let mut fixture = input(evidence.measured_positive_terminal_current_a);
        fixture.sample_positions_xyz_m = evidence.snapshot.targets.iter().map(|r| r.target_xyz_m).collect();
        let basis = &mut fixture.bases[0];
        basis.magnetic_field_xyz_apm = evidence.snapshot.targets.iter().map(|r| r.h_xyz_apm).collect();
        basis.current_balance_certificate_digest = evidence.current_balance_certificate_digest;
        basis.oersted_operator_version = fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION.into();
        basis.quadrature_diagnostics = evidence.snapshot.diagnostics();
        basis.direct_quadrature_snapshot = Some(evidence.snapshot);
        fixture
    }

    #[test]
    fn direct_evidence_publication_and_both_loaders_bind_nonunit_current() {
        let fixture = direct_evidence_fixture();
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        verify_antenna_field_solution_asset(&manifest.bytes, &artifacts[..artifacts.len() - 1]).unwrap();
        // Enclosing runtime bundles may include the manifest and other artifacts.
        let samples = load_antenna_field_solution_samples(
            &manifest.bytes, &artifacts, "common", "solution_1", "antenna_1", &digest,
        ).unwrap();
        assert_eq!(samples.magnetic_field_xyz_apm_per_a[0][0].to_bits(), (0.5_f64 / 3.0).to_bits());
        assert_eq!(samples.magnetic_field_xyz_apm_per_a[0][1].to_bits(), (-0.0_f64).to_bits());
        load_solved_antenna_drive_basis_projected(
            &manifest.bytes, &artifacts, drive(), "solution_1", "antenna_1", &digest,
            12, &fixture.sample_positions_xyz_m, None,
        ).unwrap();
    }

    #[test]
    fn both_loaders_refuse_bad_direct_evidence_after_complete_rehash() {
        let fixture = direct_evidence_fixture();
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let mut payloads = artifacts[..artifacts.len() - 1].to_vec();
        let evidence = payloads.iter_mut().find(|a| a.relative_path.ends_with("direct_quadrature.v1.bin")).unwrap();
        evidence.bytes[336..344].copy_from_slice(&1.0_f64.to_le_bytes()); // raw E exceeds tau
        let evidence_sha = sha256(&evidence.bytes);
        let mut value: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        value["bases"][0]["quadrature_evidence"]["sha256"] = serde_json::json!(evidence_sha);
        value.as_object_mut().unwrap().remove("content_digest");
        let digest = format!("sha256:{}", sha256(&serde_json::to_vec(&value).unwrap()));
        value["content_digest"] = serde_json::json!(digest);
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(verify_antenna_field_solution_asset(&bytes, &payloads).is_err());
        assert!(load_antenna_field_solution_samples(
            &bytes, &payloads, "common", "solution_1", "antenna_1", &digest,
        ).is_err());
        assert!(load_solved_antenna_drive_basis_projected(
            &bytes, &payloads, drive(), "solution_1", "antenna_1", &digest,
            12, &fixture.sample_positions_xyz_m, None,
        ).is_err());
    }

    #[test]
    fn direct_publication_refuses_missing_or_misbound_native_snapshot() {
        let mut fixture = direct_evidence_fixture();
        fixture.bases[0].direct_quadrature_snapshot = None;
        assert!(build_antenna_field_solution_artifacts(&fixture).is_err());
        let mut fixture = direct_evidence_fixture();
        fixture.bases[0].magnetic_field_xyz_apm[0][0] = 0.6;
        assert!(build_antenna_field_solution_artifacts(&fixture).is_err());
    }

    #[test]
    fn readers_refuse_missing_mixed_future_and_duplicate_direct_evidence() {
        let fixture = direct_evidence_fixture();
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        for mutation in 0..7 {
            let mut payloads = artifacts[..artifacts.len() - 1].to_vec();
            let mut value: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
            match mutation {
                0 => { value["bases"][0].as_object_mut().unwrap().remove("quadrature_evidence"); }
                1 => { value["bases"][0].as_object_mut().unwrap().remove("oersted_operator_version"); }
                2 => { value["bases"][0]["oersted_operator_version"] = serde_json::json!(fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION); }
                3 => { value["bases"][0]["quadrature_evidence"]["schema_version"] = serde_json::json!("fem_direct_oersted_evidence.v2"); }
                4 => { value["bases"][0]["quadrature_evidence"]["path"] = value["bases"][0]["magnetic_field_per_ampere"]["path"].clone(); }
                5 => {
                    let duplicate = payloads.iter().find(|a| a.relative_path.ends_with("direct_quadrature.v1.bin")).unwrap().clone();
                    payloads.push(duplicate);
                }
                _ => { value["bases"][0]["quadrature_diagnostics"]["relative_scale_floor_apm"] = serde_json::json!(-0.0); }
            }
            value.as_object_mut().unwrap().remove("content_digest");
            let digest = format!("sha256:{}", sha256(&serde_json::to_vec(&value).unwrap()));
            value["content_digest"] = serde_json::json!(digest);
            let bytes = serde_json::to_vec(&value).unwrap();
            assert!(verify_antenna_field_solution_asset(&bytes, &payloads).is_err(), "mutation {mutation}");
            assert!(load_antenna_field_solution_samples(
                &bytes, &payloads, "common", "solution_1", "antenna_1", &digest,
            ).is_err(), "mutation {mutation}");
            assert!(load_solved_antenna_drive_basis_projected(
                &bytes, &payloads, drive(), "solution_1", "antenna_1", &digest,
                12, &fixture.sample_positions_xyz_m, None,
            ).is_err(), "mutation {mutation}");
        }
    }

    #[test]
    fn rejects_invalid_sample_carrier_before_publication() {
        for invalid in [
            AntennaSampleCarrier { carrier_kind: " ".into(), ..input(1.0).sample_carrier },
            AntennaSampleCarrier { location: "cell".into(), ..input(1.0).sample_carrier },
            AntennaSampleCarrier { topology_digest: "sha256:invalid".into(), ..input(1.0).sample_carrier },
            AntennaSampleCarrier { domain: FieldTargetIR::Object { object_id: "".into() }, ..input(1.0).sample_carrier },
        ] {
            let mut fixture = input(1.0);
            fixture.sample_carrier = invalid;
            assert!(build_antenna_field_solution_artifacts(&fixture).is_err());
        }
    }

    #[test]
    fn publishes_and_loads_tetrahedral_sampling_topology() {
        let mut fixture = input(1.0);
        fixture.sample_positions_xyz_m = vec![
            [0.0, 0.0, -1.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        fixture.bases[0].magnetic_field_xyz_apm = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
        ];
        fixture.sample_tet4_cells = Some(vec![[0, 1, 2, 3]]);
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let manifest_value: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
        assert_eq!(
            manifest_value["sample_topology"]["layout"],
            "tet4_connectivity"
        );
        verify_antenna_field_solution_asset(&manifest.bytes, &artifacts[..artifacts.len() - 1])
            .unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let loaded = load_antenna_field_solution_samples(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            "common",
            "solution_1",
            "antenna_1",
            &digest,
        )
        .unwrap();
        assert_eq!(loaded.sample_tet4_cells, Some(vec![[0, 1, 2, 3]]));
    }

    #[test]
    fn fdm_materialization_uses_cell_centers_and_masks_inactive_cells() {
        let mut fixture = input(2.0);
        fixture.sample_positions_xyz_m = vec![[1.0, 1.0, 1.0], [3.0, 1.0, 1.0]];
        fixture.bases[0].magnetic_field_xyz_apm = vec![[8.0, 10.0, 12.0], [16.0, 18.0, 20.0]];
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let (mut plan, mut projection, stage) = fdm_projection_fixture();
        if let fullmag_ir::AntennaSolutionRefIR::Published(reference) = &mut projection.solution {
            reference.content_digest = digest;
        }
        let assets = BTreeMap::from([(
            "afs-fixture".into(),
            AntennaFieldSolutionAsset {
                manifest_bytes: manifest.bytes.clone(),
                payloads: artifacts[..artifacts.len() - 1].to_vec(),
            },
        )]);
        materialize_fdm_solved_antenna_drive_parts(
            &[drive()],
            &[projection],
            &[stage],
            &mut plan,
            &assets,
        )
        .unwrap();
        assert_eq!(plan.solved_antenna_drive_bases.len(), 1);
        assert_eq!(
            plan.solved_antenna_drive_bases[0].field_xyz_apm_per_a,
            vec![[4.0, 5.0, 6.0], [0.0, 0.0, 0.0]]
        );
        let expected_topology = resolved_target_topology_digest(&(
            plan.origin_m,
            &plan.grid,
            plan.cell_size,
            &plan.region_mask,
            &plan.active_mask,
        ))
        .unwrap();
        assert!(plan.solved_antenna_drive_bases[0]
            .projection_signature
            .ends_with(&format!(":target_topology:{expected_topology}")));
        crate::antenna_fields::validate_fdm_antenna_sample_counts(&plan, 2).unwrap();
        plan.origin_m[0] += plan.cell_size[0];
        let error =
            crate::antenna_fields::validate_fdm_antenna_sample_counts(&plan, 2).unwrap_err();
        assert!(error.message.contains("target topology differs"));
        plan.origin_m[0] -= plan.cell_size[0];
        plan.solved_antenna_drive_bases[0].projection_signature = "legacy".into();
        let error =
            crate::antenna_fields::validate_fdm_antenna_sample_counts(&plan, 2).unwrap_err();
        assert!(error.message.contains("target topology differs"));
        assert_ne!(
            expected_topology,
            resolved_target_topology_digest(&(
                plan.origin_m,
                &plan.grid,
                plan.cell_size,
                &[0_u32, 1_u32],
                &plan.active_mask,
            ))
            .unwrap()
        );
    }

    #[test]
    fn solved_antenna_materialization_rejects_peak_current_field_overflow() {
        let mut fixture = input(2.0);
        fixture.sample_positions_xyz_m = vec![[1.0, 1.0, 1.0], [3.0, 1.0, 1.0]];
        fixture.bases[0].magnetic_field_xyz_apm = vec![[8.0, 10.0, 12.0], [16.0, 18.0, 20.0]];
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let (mut plan, mut projection, stage) = fdm_projection_fixture();
        if let fullmag_ir::AntennaSolutionRefIR::Published(reference) = &mut projection.solution {
            reference.content_digest = digest;
        }
        let assets = BTreeMap::from([(
            "afs-fixture".into(),
            AntennaFieldSolutionAsset {
                manifest_bytes: manifest.bytes.clone(),
                payloads: artifacts[..artifacts.len() - 1].to_vec(),
            },
        )]);
        let mut excessive = drive();
        excessive.peak_current_a = f64::MAX;
        let error = materialize_fdm_solved_antenna_drive_parts(
            &[excessive],
            &[projection],
            &[stage],
            &mut plan,
            &assets,
        )
        .expect_err("finite H/A and peak current must not overflow the LLG field");
        assert!(error.message.contains("non-finite projected H field"));
        assert!(plan.solved_antenna_drive_bases.is_empty());
    }

    #[test]
    fn fdm_materialization_interpolates_active_cell_and_skips_outside_inactive_cell() {
        let mut fixture = input(2.0);
        fixture.sample_positions_xyz_m = vec![
            [0.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [0.0, 4.0, 0.0],
            [0.0, 0.0, 4.0],
        ];
        fixture.bases[0].magnetic_field_xyz_apm = fixture.sample_positions_xyz_m.clone();
        fixture.sample_tet4_cells = Some(vec![[0, 1, 2, 3]]);
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let (mut plan, mut projection, stage) = fdm_projection_fixture();
        if let fullmag_ir::AntennaSolutionRefIR::Published(reference) = &mut projection.solution {
            reference.content_digest = digest;
        }
        let assets = BTreeMap::from([(
            "afs-fixture".into(),
            AntennaFieldSolutionAsset {
                manifest_bytes: manifest.bytes.clone(),
                payloads: artifacts[..artifacts.len() - 1].to_vec(),
            },
        )]);

        materialize_fdm_solved_antenna_drive_parts(
            &[drive()],
            &[projection],
            &[stage],
            &mut plan,
            &assets,
        )
        .unwrap();
        assert_eq!(
            plan.solved_antenna_drive_bases[0].field_xyz_apm_per_a,
            vec![[0.5, 0.5, 0.5], [0.0, 0.0, 0.0]]
        );
    }

    #[test]
    fn fdm_antenna_projection_rejects_stale_grid_certificate() {
        let (mut plan, _, _) = fdm_projection_fixture();
        plan.origin_m[0] = 1.0;
        let error = fdm_cell_center_positions(&plan).unwrap_err();
        assert!(error.message.contains("does not match resolved plan"));

        let (mut plan, _, _) = fdm_projection_fixture();
        plan.region_mask[0] = 1;
        let error = fdm_cell_center_positions(&plan).unwrap_err();
        assert!(error.message.contains("grid certificate is invalid"));
    }

    #[test]
    fn inactive_fdm_antenna_drive_does_not_require_a_future_asset() {
        let (mut plan, projection, stage) = fdm_projection_fixture();
        plan.time_stage.study_kind = fullmag_ir::StudyKindIR::Relaxation;
        materialize_fdm_solved_antenna_drive_parts(
            &[drive()],
            &[projection],
            &[stage],
            &mut plan,
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(plan.solved_antenna_drive_bases.is_empty());
    }

    #[test]
    fn fem_target_mask_skips_unselected_missing_nodes() {
        let mut fixture = input(2.0);
        fixture.sample_positions_xyz_m = vec![[1.0, 1.0, 1.0]];
        fixture.bases[0].magnetic_field_xyz_apm = vec![[8.0, 10.0, 12.0]];
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let resolved = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            2,
            &[[1.0, 1.0, 1.0], [3.0, 1.0, 1.0]],
            Some(&[true, false]),
        )
        .unwrap();
        assert_eq!(
            resolved.field_xyz_apm_per_a,
            vec![[4.0, 5.0, 6.0], [0.0, 0.0, 0.0]]
        );
    }

    #[test]
    fn identity_projection_treats_signed_zero_as_the_same_coordinate() {
        let mut fixture = input(2.0);
        fixture.sample_positions_xyz_m = vec![[-0.0, 0.0, -0.0]];
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let resolved = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            1,
            &[[0.0, -0.0, 0.0]],
            None,
        )
        .unwrap();
        assert_eq!(resolved.field_xyz_apm_per_a, vec![[4.0, 5.0, 6.0]]);
    }

    #[test]
    fn fdm_target_projection_rejects_missing_region_marker() {
        let (plan, _, _) = fdm_projection_fixture();
        let error = fdm_antenna_projection_mask(
            &plan,
            &FieldTargetIR::Region {
                object_id: "antenna_1".into(),
                region_id: "core".into(),
            },
            &[true, false],
        )
        .unwrap_err();
        assert!(error.message.contains("resolved region legend"));
    }

    #[test]
    fn rejects_zero_measured_terminal_current() {
        let error = build_antenna_field_solution_artifacts(&input(0.0)).unwrap_err();
        assert!(error.message.contains("finite and positive"));
        assert!(build_antenna_field_solution_artifacts(&input(-1.0)).is_err());
    }

    #[test]
    fn rejects_nonfinite_or_overflowed_per_ampere_basis_before_publication() {
        let mut potential = input(1.0e-29);
        potential.bases[0].electric_potential_v[0] = f64::MAX;
        let error = build_antenna_field_solution_artifacts(&potential).unwrap_err();
        assert!(error.message.contains("electric potential"));
        assert!(error.message.contains("per-ampere normalization"));

        let mut current = input(1.0e-29);
        current.bases[0].current_density_xyz_apm2[0][0] = f64::MAX;
        let error = build_antenna_field_solution_artifacts(&current).unwrap_err();
        assert!(error.message.contains("current density"));

        let mut field = input(1.0e-29);
        field.bases[0].magnetic_field_xyz_apm[0][0] = f64::MAX;
        let error = build_antenna_field_solution_artifacts(&field).unwrap_err();
        assert!(error.message.contains("magnetic field"));

        let mut nonfinite = input(2.0);
        nonfinite.bases[0].electric_potential_v[0] = f64::NAN;
        let error = build_antenna_field_solution_artifacts(&nonfinite).unwrap_err();
        assert!(error.message.contains("non-finite input"));
    }

    #[test]
    fn loads_verified_field_basis_for_the_requested_port() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let resolved = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            1,
            &[[0.1, 0.2, 0.3]],
            None,
        )
        .unwrap();
        assert_eq!(resolved.field_xyz_apm_per_a, vec![[4.0, 5.0, 6.0]]);
        assert_eq!(resolved.drive.peak_current_a, 0.25);
        assert!(!resolved.projection_signature.is_empty());

        let masked = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            1,
            &[[0.1, 0.2, 0.3]],
            Some(&[false]),
        )
        .unwrap();
        assert_eq!(masked.field_xyz_apm_per_a, vec![[0.0; 3]]);
        assert_ne!(masked.projection_signature, resolved.projection_signature);

        let samples = load_antenna_field_solution_samples(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            "common",
            "solution_1",
            "antenna_1",
            &digest,
        )
        .unwrap();
        assert_eq!(samples.sample_positions_xyz_m, vec![[0.1, 0.2, 0.3]]);
        assert_eq!(samples.magnetic_field_xyz_apm_per_a, vec![[4.0, 5.0, 6.0]]);
    }

    #[test]
    fn source_spectrum_loader_selects_explicit_port_and_rejects_ambiguous_legacy_request() {
        let mut fixture = input(2.0);
        fixture.bases.push(AntennaFieldBasisInput {
            port_mode_id: "port_b".into(),
            measured_positive_terminal_current_a: 2.0,
            electric_potential_v: vec![4.0, 8.0],
            current_density_xyz_apm2: vec![[4.0, 8.0, 12.0], [16.0, 20.0, 24.0]],
            magnetic_field_xyz_apm: vec![[14.0, 16.0, 18.0]],
            current_balance_certificate_digest: "balance-b".into(),
            // Synthetic non-direct multi-port plumbing fixture.
            quadrature_diagnostics: serde_json::json!({"operator_version": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION}),
            oersted_operator_version: fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION.into(),
            direct_quadrature_snapshot: None,
        });
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let mut explicit_request = spectrum_request(Some("port_b"));
        if let fullmag_ir::AntennaSolutionRefIR::Published(reference) = &mut explicit_request.solution_ref {
            reference.content_digest = digest.clone();
        }
        let samples = load_antenna_field_solution_samples_for_spectrum(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            &explicit_request,
        )
        .unwrap();
        assert_eq!(samples.port_mode_id, "port_b");
        assert_eq!(samples.magnetic_field_xyz_apm_per_a, vec![[7.0, 8.0, 9.0]]);

        let mut legacy_request = spectrum_request(None);
        if let fullmag_ir::AntennaSolutionRefIR::Published(reference) = &mut legacy_request.solution_ref {
            reference.content_digest = digest.clone();
        }
        let error = load_antenna_field_solution_samples_for_spectrum(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            &legacy_request,
        )
        .expect_err("multi-port spectrum requests must not select the first basis");
        assert!(error.message.contains("must identify one port basis"));
        assert!(digest.starts_with("sha256:"));
    }

    #[test]
    fn projects_a_shared_nodal_basis_by_coordinate_without_broadcasting() {
        let mut fixture = input(2.0);
        fixture.sample_positions_xyz_m = vec![[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];
        fixture.bases[0].magnetic_field_xyz_apm = vec![[8.0, 10.0, 12.0], [16.0, 18.0, 20.0]];
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let target_positions = vec![[0.4, 0.5, 0.6], [0.1, 0.2, 0.3]];
        let resolved = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            target_positions.len(),
            &target_positions,
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.field_xyz_apm_per_a,
            vec![[8.0, 9.0, 10.0], [4.0, 5.0, 6.0]]
        );
        assert!(resolved.projection_signature.contains("sha256:"));
        assert!(resolved
            .projection_signature
            .contains(":identity_coordinates_v1:"));

        let missing_position = vec![[9.0, 9.0, 9.0]];
        let error = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            missing_position.len(),
            &missing_position,
            None,
        )
        .expect_err("unmatched target nodes must not be broadcast or extrapolated");
        assert!(error.message.contains("explicit interpolation"));
    }

    #[test]
    fn projects_a_field_basis_with_deterministic_tet4_p1_interpolation() {
        let mut fixture = input(1.0);
        fixture.sample_positions_xyz_m = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        fixture.bases[0].magnetic_field_xyz_apm = vec![
            [0.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [0.0, 8.0, 0.0],
            [0.0, 0.0, 12.0],
        ];
        fixture.sample_tet4_cells = Some(vec![[0, 1, 2, 3]]);
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = artifacts.last().unwrap();
        let digest = manifest_digest(&manifest.bytes);
        let target_positions = vec![[0.25, 0.25, 0.25]];
        let resolved = load_solved_antenna_drive_basis_projected(
            &manifest.bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            target_positions.len(),
            &target_positions,
            None,
        )
        .unwrap();
        assert_eq!(resolved.field_xyz_apm_per_a.len(), 1);
        let value = resolved.field_xyz_apm_per_a[0];
        assert!((value[0] - 1.0).abs() < 1.0e-12);
        assert!((value[1] - 2.0).abs() < 1.0e-12);
        assert!((value[2] - 3.0).abs() < 1.0e-12);
        assert!(resolved
            .projection_signature
            .contains(":fem_p1_interpolation_v1:"));
    }

    #[test]
    fn rejects_unimplemented_sample_to_mesh_projection_instead_of_broadcasting() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let digest = manifest_digest(&artifacts.last().unwrap().bytes);
        let error = load_solved_antenna_drive_basis_projected(
            &artifacts.last().unwrap().bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            2,
            &[[0.1, 0.2, 0.3], [9.0, 9.0, 9.0]],
            None,
        )
        .expect_err("different carrier topology must fail closed");
        assert!(error.message.contains("explicit interpolation"));
    }

    #[test]
    fn rejects_tampered_manifest_and_field_payload() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let digest = manifest_digest(&artifacts.last().unwrap().bytes);
        let mut manifest = artifacts.last().unwrap().bytes.clone();
        let index = manifest.iter().position(|byte| *byte == b's').unwrap();
        manifest[index] = b'x';
        assert!(load_solved_antenna_drive_basis_projected(
            &manifest,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            1,
            &[[0.1, 0.2, 0.3]],
            None,
        )
        .is_err());

        let mut payloads = artifacts[..artifacts.len() - 1].to_vec();
        payloads
            .iter_mut()
            .find(|artifact| artifact.relative_path.ends_with("H_per_A.f64le"))
            .expect("magnetic field payload")
            .bytes[0] ^= 1;
        assert!(load_solved_antenna_drive_basis_projected(
            &artifacts.last().unwrap().bytes,
            &payloads,
            drive(),
            "solution_1",
            "antenna_1",
            &digest,
            1,
            &[[0.1, 0.2, 0.3]],
            None,
        )
        .unwrap_err()
        .message
        .contains("sha256 mismatch"));

        assert!(load_solved_antenna_drive_basis_projected(
            &artifacts.last().unwrap().bytes,
            &artifacts[..artifacts.len() - 1],
            drive(),
            "solution_1",
            "antenna_1",
            "obsolete-digest",
            1,
            &[[0.1, 0.2, 0.3]],
            None,
        )
        .unwrap_err()
        .message
        .contains("stale reference"));
    }

    #[test]
    fn dependency_signature_mismatch_rejects_an_intact_old_asset() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let manifest = &artifacts.last().unwrap().bytes;
        let mut expected = serde_json::from_slice::<serde_json::Value>(manifest)
            .unwrap()
            .get("signatures")
            .cloned()
            .map(|value| serde_json::from_value::<AntennaFieldSolutionSignatures>(value).unwrap())
            .unwrap();
        expected.current_solution_signature = format!("sha256:{}", "f".repeat(64));

        let error = verify_antenna_field_solution_signatures(manifest, &expected)
            .expect_err("an old but untampered asset must not pass current-model validation");
        assert!(error.message.contains("current_solution_signature"));
    }

    #[test]
    fn dependency_signatures_identify_terminal_solver_and_sampling_changes() {
        let mut fixture = input(2.0);
        fixture.signatures.dependency_signatures = Some(AntennaDependencySignatures {
            terminal: format!("sha256:{}", "4".repeat(64)),
            solver: format!("sha256:{}", "5".repeat(64)),
            sampling: format!("sha256:{}", "6".repeat(64)),
        });
        let artifacts = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let manifest = &artifacts.last().unwrap().bytes;
        for category in ["terminal", "solver", "sampling"] {
            let mut expected = fixture.signatures.clone();
            let dependencies = expected.dependency_signatures.as_mut().unwrap();
            match category {
                "terminal" => dependencies.terminal = format!("sha256:{}", "7".repeat(64)),
                "solver" => dependencies.solver = format!("sha256:{}", "8".repeat(64)),
                "sampling" => dependencies.sampling = format!("sha256:{}", "9".repeat(64)),
                _ => unreachable!(),
            }
            let error = verify_antenna_field_solution_signatures(manifest, &expected)
                .expect_err("a changed dependency must invalidate the immutable field solution");
            assert!(error.message.contains(&format!("changed dependencies: {category}")));
        }
    }

    #[test]
    fn missing_detailed_dependency_signatures_are_stale_even_with_matching_aggregate_hashes() {
        let mut fixture = input(2.0);
        let old_manifest = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let old_manifest = &old_manifest.last().unwrap().bytes;
        let detailed = AntennaDependencySignatures {
            terminal: format!("sha256:{}", "4".repeat(64)),
            solver: format!("sha256:{}", "5".repeat(64)),
            sampling: format!("sha256:{}", "6".repeat(64)),
        };
        fixture.signatures.dependency_signatures = Some(detailed);
        let error = verify_antenna_field_solution_signatures(old_manifest, &fixture.signatures)
            .expect_err("an intact legacy manifest lacks the required dependency certificate");
        assert!(error
            .message
            .contains("changed dependencies: terminal, solver, sampling"));

        let new_manifest = build_antenna_field_solution_artifacts(&fixture).unwrap();
        let new_manifest = &new_manifest.last().unwrap().bytes;
        fixture.signatures.dependency_signatures = None;
        let error = verify_antenna_field_solution_signatures(new_manifest, &fixture.signatures)
            .expect_err("an expectation without detailed dependencies must not accept them");
        assert!(error
            .message
            .contains("changed dependencies: terminal, solver, sampling"));
    }

    #[test]
    fn rejects_malformed_dependency_digest_before_publication() {
        let mut fixture = input(2.0);
        fixture.signatures.dependency_signatures = Some(AntennaDependencySignatures {
            terminal: "sha256:short".into(),
            solver: format!("sha256:{}", "5".repeat(64)),
            sampling: format!("sha256:{}", "6".repeat(64)),
        });
        let error = build_antenna_field_solution_artifacts(&fixture).unwrap_err();
        assert!(error.message.contains("64 lowercase hex digits"));
    }

    #[test]
    fn manifest_integrity_is_checked_without_loading_field_payloads() {
        let artifacts = build_antenna_field_solution_artifacts(&input(2.0)).unwrap();
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        manifest["signatures"]["current_solution_signature"] =
            serde_json::Value::String(format!("sha256:{}", "f".repeat(64)));
        let tampered = serde_json::to_vec(&manifest).unwrap();
        let error = verify_antenna_field_solution_manifest(&tampered).unwrap_err();
        assert!(error.message.contains("content_digest mismatch"));
    }
}
