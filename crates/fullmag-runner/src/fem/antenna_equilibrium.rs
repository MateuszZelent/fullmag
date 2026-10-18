//! Canonical accepted Relax receipt for transverse antenna analysis.
//! The constructor preserves the existing producer certificates; it does not
//! manufacture eigen acceptance or authorize an unqualified antenna basis.

use super::eigen_equilibrium_contract::{AcceptedFemRelaxStageHandoff, AcceptedFemRelaxStageHandoffV3Record};
use crate::types::{AuxiliaryArtifact, FemMeshPayload, RecomputedFemLinearizationCertificateV1, RunError};
use fullmag_ir::{EquilibriumRefIR, EquilibriumReferenceIR, FemPlanIR, FieldTargetIR};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

const SCHEMA: &str = "antenna_accepted_equilibrium.v1";
const PREFIX: &str = "antenna/accepted_equilibria";
const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;

fn error(message: impl Into<String>) -> RunError { RunError { message: message.into() } }
fn hash(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, RunError> {
    serde_json::to_vec(value).map_err(|cause| error(format!("accepted equilibrium serialization: {cause}")))
}
fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, RunError> {
    let value = serde_json::from_slice::<crate::artifact_json::UnambiguousJson>(bytes)
        .map_err(|cause| error(format!("accepted equilibrium JSON: {cause}")))?.0;
    serde_json::from_value(value).map_err(|cause| error(format!("accepted equilibrium schema: {cause}")))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct InputRef { path: String, sha256: String, byte_count: u64 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct AcceptedEquilibriumManifest {
    schema_version: String,
    asset_id: String,
    equilibrium_id: String,
    content_digest: String,
    source_run_id: String,
    source_stage_id: String,
    authored_stage_id: String,
    output_id: String,
    resolved_execution_engine: String,
    completion_sha256: String,
    owning_plan: InputRef,
    relax_receipt: InputRef,
    recomputed_certificate: InputRef,
    accepted_fields: InputRef,
}

fn manifest_digest(manifest: &AcceptedEquilibriumManifest) -> Result<String, RunError> {
    let mut value = serde_json::to_value(manifest).map_err(|cause| error(cause.to_string()))?;
    let object = value.as_object_mut().ok_or_else(|| error("equilibrium manifest is not an object"))?;
    for key in ["asset_id", "equilibrium_id", "content_digest"] { object.remove(key); }
    let mut bytes = b"antenna_accepted_equilibrium.v1\0".to_vec();
    bytes.extend(encode(&value)?);
    Ok(hash(&bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaEquilibriumBinding {
    pub schema_version: String,
    pub producer_contract: String,
    pub resolved_execution_engine: String,
    pub asset_id: String,
    pub equilibrium_id: String,
    pub content_digest: String,
    pub source_run_id: String,
    pub source_stage_id: String,
    pub authored_stage_id: String,
    pub completion_sha256: String,
    pub acceptance_certificate_sha256: String,
    pub recomputed_certificate_sha256: String,
    pub certified_fields_sha256: String,
    pub equilibrium_content_sha256: String,
    pub mesh_generation_id: String,
    pub mesh_topology_sha256: String,
    pub indexing_sha256: String,
    pub part_registry_sha256: String,
    pub owning_plan_sha256: String,
    pub material_signature: String,
    pub static_physics_signature: String,
    pub boundary_signature: String,
    pub static_demag_sha256: String,
    pub source_carrier_sha256: String,
    pub source_solution_ref: Option<fullmag_ir::AntennaFieldSolutionRefIR>,
    pub target: FieldTargetIR,
    pub mapping_digest: String,
    pub normalization: String,
    pub norm_floor: f64,
    pub projection_version: String,
}

/// Fields and constructors are private. Only the canonical loader below can
/// issue this execution authority after rebuilding the existing Relax receipt.
pub struct VerifiedAntennaEquilibriumContext {
    plan: FemPlanIR,
    receipt: AcceptedFemRelaxStageHandoff,
    binding: AntennaEquilibriumBinding,
}

fn validate_inputs(
    plan: &FemPlanIR, receipt: &AcceptedFemRelaxStageHandoffV3Record,
    accepted_fields: &crate::types::CertifiedFemEquilibriumFields,
    recomputed: &RecomputedFemLinearizationCertificateV1,
) -> Result<AcceptedFemRelaxStageHandoff, RunError> {
    if plan.time_stage.study_kind != fullmag_ir::StudyKindIR::Relaxation {
        return Err(error("accepted equilibrium requires the actual Relax owning plan"));
    }
    if plan.precision != fullmag_ir::ExecutionPrecision::Double || plan.fe_order != 1 {
        return Err(error("transverse equilibrium requires FEM P1/double"));
    }
    if recomputed.field_absolute_tolerance_a_per_m != 1.0e-6
        || recomputed.field_relative_tolerance != 1.0e-8
        || recomputed.phi_absolute_tolerance_a != 1.0e-12 {
        return Err(error("accepted equilibrium recompute tolerances differ from canonical Relax producer"));
    }
    let mesh = FemMeshPayload::from(plan);
    crate::validate_recomputed_fem_linearization_certificate(plan, &mesh,
        &receipt.equilibrium_magnetization, accepted_fields, &receipt.certified_fields, recomputed)?;
    let rebuilt = AcceptedFemRelaxStageHandoff::from_completed_relax(
        &receipt.source_run_id, &receipt.source_stage_id, &receipt.source_stage_kind,
        true, plan, &mesh, &receipt.completion, receipt.equilibrium_magnetization.clone(),
        receipt.certified_fields.clone(),
    )?;
    if rebuilt.v3_record() != *receipt {
        return Err(error("accepted equilibrium Relax receipt mismatch"));
    }
    Ok(rebuilt)
}

/// Immutable artifacts from the actual accepted producer. The caller publishes
/// these payloads before the manifest; no successful output is produced on error.
pub fn accepted_antenna_equilibrium_artifacts(
    plan: &FemPlanIR, receipt: &AcceptedFemRelaxStageHandoff,
    recomputed: &RecomputedFemLinearizationCertificateV1, resolved_execution_engine: &str, authored_stage_id: &str,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    if resolved_execution_engine != "fem_cpu_native" { return Err(error("transverse equilibrium publisher requires actual FEM CPU native execution")); }
    if authored_stage_id.trim().is_empty() { return Err(error("accepted equilibrium requires an exact authored stage identity")); }
    let record = receipt.v3_record();
    let replay = receipt.verified_replay.as_ref()
        .ok_or_else(|| error("accepted equilibrium requires the independent accepted fields from verified producer replay"))?;
    if replay.accepted_fields_json.is_empty() || replay.accepted_fields_json.len() as u64 > MAX_INPUT_BYTES {
        return Err(error("accepted equilibrium baseline exceeds artifact budget or is empty"));
    }
    let accepted_fields: crate::types::CertifiedFemEquilibriumFields = parse(&replay.accepted_fields_json)?;
    if accepted_fields != replay.accepted_fields || replay.certified_fields != record.certified_fields
        || replay.recomputed_certificate != *recomputed {
        return Err(error("accepted equilibrium independent producer replay mismatch"));
    }
    validate_inputs(plan, &record, &accepted_fields, recomputed)?;
    let inputs = [("owning_plan.json", encode(plan)?),
        ("relax_receipt.v3.json", encode(&record)?),
        ("recomputed_certificate.v1.json", encode(recomputed)?), ("accepted_fields.json", replay.accepted_fields_json.clone())];
    let reference = |index: usize| InputRef { path: inputs[index].0.into(),
        sha256: hash(&inputs[index].1), byte_count: inputs[index].1.len() as u64 };
    let mut manifest = AcceptedEquilibriumManifest {
        schema_version: SCHEMA.into(), asset_id: String::new(), equilibrium_id: String::new(),
        content_digest: String::new(), source_run_id: record.source_run_id,
        source_stage_id: record.source_stage_id, authored_stage_id: authored_stage_id.into(), output_id: "accepted_equilibrium".into(),
        resolved_execution_engine: resolved_execution_engine.into(),
        completion_sha256: record.completion_sha256,
        owning_plan: reference(0), relax_receipt: reference(1), recomputed_certificate: reference(2), accepted_fields: reference(3),
    };
    manifest.content_digest = manifest_digest(&manifest)?;
    let digest = manifest.content_digest.strip_prefix("sha256:").ok_or_else(|| error("equilibrium digest"))?;
    manifest.asset_id = digest.to_string();
    manifest.equilibrium_id = format!("{SCHEMA}:{digest}");
    let base = format!("{PREFIX}/{}", manifest.asset_id);
    let mut artifacts = inputs.into_iter().map(|(name, bytes)| AuxiliaryArtifact {
        relative_path: format!("{base}/{name}"), bytes,
    }).collect::<Vec<_>>();
    artifacts.push(AuxiliaryArtifact { relative_path: format!("{base}/manifest.v1.json"), bytes: encode(&manifest)? });
    // This is an artifact-owned stage output record, not an independent registry.
    let stage_key = hash(manifest.authored_stage_id.as_bytes());
    artifacts.push(AuxiliaryArtifact {
        relative_path: format!("{PREFIX}/stage_outputs/{}.v1.json", &stage_key[7..]),
        bytes: encode(&manifest)?,
    });
    Ok(artifacts)
}

fn read(root: &Path, relative: &str) -> Result<Vec<u8>, RunError> {
    if relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || relative.contains('\\') || relative.contains(':') {
        return Err(error("accepted equilibrium artifact path is invalid"));
    }
    let root = root.canonicalize().map_err(|cause| error(cause.to_string()))?;
    let path = root.join(relative).canonicalize().map_err(|cause| error(cause.to_string()))?;
    if !path.starts_with(&root) { return Err(error("accepted equilibrium path escapes artifact store")); }
    let size = std::fs::metadata(&path).map_err(|cause| error(cause.to_string()))?.len();
    if size > MAX_INPUT_BYTES { return Err(error("accepted equilibrium input exceeds artifact budget")); }
    let file = std::fs::File::open(path).map_err(|cause| error(cause.to_string()))?;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes).map_err(|cause| error(cause.to_string()))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES { return Err(error("accepted equilibrium input exceeds artifact budget")); }
    Ok(bytes)
}

pub fn load_verified_antenna_equilibrium(
    root: &Path, reference: &EquilibriumRefIR,
) -> Result<VerifiedAntennaEquilibriumContext, RunError> {
    if !reference.is_valid() { return Err(error("invalid equilibrium reference")); }
    let relative = match reference {
        EquilibriumRefIR::Reference(EquilibriumReferenceIR::StageOutput { stage_id, output_id }) => {
            if output_id != "accepted_equilibrium" { return Err(error("unknown accepted equilibrium output")); }
            format!("{PREFIX}/stage_outputs/{}.v1.json", &hash(stage_id.as_bytes())[7..])
        },
        EquilibriumRefIR::Reference(EquilibriumReferenceIR::Artifact { asset_id, .. }) => {
            if asset_id.len() != 64 || !asset_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err(error("accepted equilibrium asset_id is not a content identity"));
            }
            format!("{PREFIX}/{asset_id}/manifest.v1.json")
        },
        EquilibriumRefIR::LegacyId(id) => {
            let (schema, digest) = id.split_once(':').ok_or_else(|| error("equilibrium identity"))?;
            if schema != SCHEMA { return Err(error("v7 equilibrium requires its canonical owner validation context")); }
            format!("{PREFIX}/{digest}/manifest.v1.json")
        },
    };
    let manifest: AcceptedEquilibriumManifest = parse(&read(root, &relative)?)?;
    let digest = manifest_digest(&manifest)?;
    if manifest.schema_version != SCHEMA || manifest.content_digest != digest
        || manifest.asset_id != digest[7..] || manifest.equilibrium_id != format!("{SCHEMA}:{}", &digest[7..])
        || manifest.authored_stage_id.trim().is_empty() || manifest.output_id != "accepted_equilibrium" || manifest.resolved_execution_engine != "fem_cpu_native" {
        return Err(error("accepted equilibrium manifest identity mismatch"));
    }
    match reference {
        EquilibriumRefIR::Reference(EquilibriumReferenceIR::StageOutput { stage_id, .. }) if *stage_id != manifest.authored_stage_id => return Err(error("equilibrium source stage mismatch")),
        EquilibriumRefIR::Reference(EquilibriumReferenceIR::Artifact { equilibrium_id, content_digest, .. }) if *equilibrium_id != manifest.equilibrium_id || *content_digest != digest => return Err(error("equilibrium immutable reference mismatch")),
        EquilibriumRefIR::LegacyId(id) if *id != manifest.equilibrium_id => return Err(error("equilibrium identity mismatch")),
        _ => {},
    }
    let base = format!("{PREFIX}/{}", manifest.asset_id);
    let stored_manifest: AcceptedEquilibriumManifest = parse(&read(root, &format!("{base}/manifest.v1.json"))?)?;
    if stored_manifest != manifest { return Err(error("equilibrium stage-output pin mismatch")); }
    let payload = |reference: &InputRef, expected: &str| -> Result<Vec<u8>, RunError> {
        if reference.path != expected { return Err(error("equilibrium input name mismatch")); }
        let bytes = read(root, &format!("{base}/{expected}"))?;
        if bytes.len() as u64 != reference.byte_count || hash(&bytes) != reference.sha256 {
            return Err(error("equilibrium input content identity mismatch"));
        }
        Ok(bytes)
    };
    let plan: FemPlanIR = parse(&payload(&manifest.owning_plan, "owning_plan.json")?)?;
    let record: AcceptedFemRelaxStageHandoffV3Record = parse(&payload(&manifest.relax_receipt, "relax_receipt.v3.json")?)?;
    let recomputed: RecomputedFemLinearizationCertificateV1 = parse(&payload(&manifest.recomputed_certificate, "recomputed_certificate.v1.json")?)?;
    let accepted_fields: crate::types::CertifiedFemEquilibriumFields = parse(&payload(&manifest.accepted_fields, "accepted_fields.json")?)?;
    let receipt = validate_inputs(&plan, &record, &accepted_fields, &recomputed)?;
    if record.source_run_id != manifest.source_run_id || record.source_stage_id != manifest.source_stage_id
        || record.completion_sha256 != manifest.completion_sha256 {
        return Err(error("equilibrium producer/completion mismatch"));
    }
    let binding = AntennaEquilibriumBinding {
        schema_version: "antenna_equilibrium_binding.v1".into(), producer_contract: record.schema_version.clone(),
        resolved_execution_engine: manifest.resolved_execution_engine,
        asset_id: manifest.asset_id, equilibrium_id: manifest.equilibrium_id, content_digest: digest,
        source_run_id: record.source_run_id, source_stage_id: record.source_stage_id,
        authored_stage_id: manifest.authored_stage_id,
        completion_sha256: record.completion_sha256, acceptance_certificate_sha256: record.acceptance_certificate_sha256,
        recomputed_certificate_sha256: recomputed.content_sha256,
        certified_fields_sha256: record.certified_fields_content_sha256,
        equilibrium_content_sha256: record.equilibrium_content_sha256,
        mesh_generation_id: record.stage_fem_mesh_generation_id, mesh_topology_sha256: record.source_mesh_topology_sha256,
        indexing_sha256: record.indexing_sha256, part_registry_sha256: record.part_registry_sha256,
        owning_plan_sha256: manifest.owning_plan.sha256,
        material_signature: record.equilibrium_material_signature, static_physics_signature: record.equilibrium_static_physics_signature,
        boundary_signature: record.equilibrium_boundary_signature,
        static_demag_sha256: hash(&encode(&(&record.certified_fields.h_demag_a_per_m, &record.certified_fields.phi_a))?),
        source_carrier_sha256: String::new(), source_solution_ref: None,
        target: FieldTargetIR::Global {}, mapping_digest: String::new(), normalization: "p1_direction_normalized.v1".into(),
        norm_floor: 1.0e-12, projection_version: "antenna_transverse_projection.v1".into(),
    };
    Ok(VerifiedAntennaEquilibriumContext { plan, receipt, binding })
}

impl VerifiedAntennaEquilibriumContext {
    pub(crate) fn authorizes(&self, reference: &EquilibriumRefIR) -> bool {
        match reference {
            EquilibriumRefIR::Reference(EquilibriumReferenceIR::StageOutput { stage_id, output_id }) =>
                stage_id == &self.binding.authored_stage_id && output_id == "accepted_equilibrium",
            EquilibriumRefIR::Reference(EquilibriumReferenceIR::Artifact { asset_id, equilibrium_id, content_digest }) =>
                asset_id == &self.binding.asset_id && equilibrium_id == &self.binding.equilibrium_id && content_digest == &self.binding.content_digest,
            EquilibriumRefIR::LegacyId(id) => id == &self.binding.equilibrium_id,
        }
    }

    pub(crate) fn sample(
        &self, target: &FieldTargetIR, positions: &[[f64; 3]], margin: f64,
        interrupt: Option<&AtomicBool>,
    ) -> Result<(Vec<[f64; 3]>, AntennaEquilibriumBinding), RunError> {
        let selected = fullmag_plan::resolve_fem_antenna_transverse_cell_mask(&self.plan, target)
            .map_err(|cause| error(cause.reasons.join("; ")))?;
        let mut cells = Vec::new();
        let mut ordinals = Vec::new();
        for (ordinal, selected) in selected.into_iter().enumerate() {
            if !selected { continue; }
            let nodes = self.plan.mesh.cells.item_nodes(ordinal).ok_or_else(|| error("missing equilibrium cell"))?;
            let tet: [u32; 4] = nodes.try_into().map_err(|_| error("transverse equilibrium requires actual Tet4 cells"))?;
            cells.push(tet); ordinals.push(ordinal);
        }
        let bvh = crate::antenna_spectrum::FieldTetraBvh::build_interruptible(&self.plan.mesh.nodes, &cells, margin, interrupt)?;
        let mut vectors = Vec::with_capacity(positions.len());
        let mut mapping = Vec::with_capacity(positions.len().saturating_mul(5));
        for position in positions {
            if interrupt.is_some_and(|signal| signal.load(Ordering::Acquire)) { return Err(error("equilibrium projection cancelled")); }
            let (cell, weights) = bvh.locate(*position, &self.plan.mesh.nodes, &cells)
                .ok_or_else(|| error("transverse equilibrium sample lies outside the magnetic target ROI"))?;
            let raw: [f64; 3] = std::array::from_fn(|axis| weights.iter().zip(cells[cell])
                .map(|(weight, node)| *weight * self.receipt.equilibrium_magnetization[node as usize][axis]).sum());
            let norm = raw.into_iter().map(|value| value * value).sum::<f64>().sqrt();
            if !norm.is_finite() || norm <= 1.0e-12 { return Err(error("transverse equilibrium interpolant norm is at or below 1e-12")); }
            let unit = raw.map(|value| value / norm);
            if unit.iter().any(|value| !value.is_finite()) { return Err(error("non-finite transverse equilibrium direction")); }
            vectors.push(unit);
            mapping.extend((ordinals[cell] as u64).to_le_bytes());
            for weight in weights { mapping.extend(weight.to_bits().to_le_bytes()); }
        }
        let mut binding = self.binding.clone(); binding.target = target.clone(); binding.mapping_digest = hash(&mapping);
        Ok((vectors, binding))
    }
}

/// Commit the immutable producer payloads before exposing the artifact-owned stage pin.
pub fn publish_accepted_antenna_equilibrium(
    root: &Path, artifacts: &[AuxiliaryArtifact],
) -> Result<Vec<String>, RunError> {
    if artifacts.len() != 6 { return Err(error("accepted equilibrium requires its closed artifact set")); }
    let manifest: AcceptedEquilibriumManifest = parse(&artifacts[4].bytes)?;
    let reference = EquilibriumRefIR::Reference(EquilibriumReferenceIR::Artifact {
        asset_id: manifest.asset_id.clone(), equilibrium_id: manifest.equilibrium_id.clone(), content_digest: manifest.content_digest.clone(),
    });
    if !reference.is_valid() || manifest.content_digest != manifest_digest(&manifest)? {
        return Err(error("accepted equilibrium publication identity mismatch"));
    }
    let expected_base = format!("{PREFIX}/{}", manifest.asset_id);
    for (artifact, name) in artifacts[..5].iter().zip(["owning_plan.json", "relax_receipt.v3.json", "recomputed_certificate.v1.json", "accepted_fields.json", "manifest.v1.json"]) {
        if artifact.relative_path != format!("{expected_base}/{name}") {
            return Err(error("accepted equilibrium publication payload namespace mismatch"));
        }
    }
    if artifacts[5].bytes != artifacts[4].bytes
        || artifacts[5].relative_path != format!("{PREFIX}/stage_outputs/{}.v1.json", &hash(manifest.authored_stage_id.as_bytes())[7..]) {
        return Err(error("equilibrium artifact-owned stage pin identity mismatch"));
    }
    let first = Path::new(&artifacts[0].relative_path);
    let base = first.parent().ok_or_else(|| error("equilibrium artifact namespace"))?;
    if !base.starts_with(PREFIX) || base.components().count() != 3 {
        return Err(error("equilibrium artifact namespace"));
    }
    let destination = root.join(base);
    let parent = destination.parent().ok_or_else(|| error("equilibrium artifact parent"))?;
    std::fs::create_dir_all(parent).map_err(|cause| error(cause.to_string()))?;
    if !destination.exists() {
        let temporary = tempfile::Builder::new().prefix(".accepted-equilibrium-").tempdir_in(parent)
            .map_err(|cause| error(cause.to_string()))?;
        for artifact in &artifacts[..5] {
            let path = Path::new(&artifact.relative_path).strip_prefix(base).map_err(|_| error("equilibrium payload namespace"))?;
            if path.components().count() != 1 { return Err(error("equilibrium payload name")); }
            std::fs::write(temporary.path().join(path), &artifact.bytes).map_err(|cause| error(cause.to_string()))?;
        }
        // All payloads and the manifest become visible in one directory rename.
        std::fs::rename(temporary.path(), &destination).map_err(|cause| error(cause.to_string()))?;
    }
    for artifact in &artifacts[..5] {
        if read(root, &artifact.relative_path)? != artifact.bytes { return Err(error("immutable accepted equilibrium artifact collision")); }
    }
    // Reopen the complete owning receipt before committing any successful pin.
    load_verified_antenna_equilibrium(root, &reference)?;
    let pin = &artifacts[5];
    if pin.bytes != artifacts[4].bytes
        || artifacts[4].relative_path != format!("{PREFIX}/{}/manifest.v1.json", manifest.asset_id)
        || pin.relative_path != format!("{PREFIX}/stage_outputs/{}.v1.json", &hash(manifest.authored_stage_id.as_bytes())[7..]) {
        return Err(error("equilibrium artifact-owned stage pin identity mismatch"));
    }
    if !pin.relative_path.starts_with(&format!("{PREFIX}/stage_outputs/")) {
        return Err(error("equilibrium stage pin namespace"));
    }
    let pin_path = root.join(&pin.relative_path);
    let pin_parent = pin_path.parent().ok_or_else(|| error("equilibrium pin parent"))?;
    std::fs::create_dir_all(pin_parent).map_err(|cause| error(cause.to_string()))?;
    if !pin_path.exists() {
        let mut temporary = tempfile::NamedTempFile::new_in(pin_parent).map_err(|cause| error(cause.to_string()))?;
        use std::io::Write;
        temporary.write_all(&pin.bytes).map_err(|cause| error(cause.to_string()))?;
        temporary.persist_noclobber(&pin_path).map_err(|cause| error(cause.to_string()))?;
    }
    if read(root, &pin.relative_path)? != pin.bytes { return Err(error("immutable equilibrium stage pin collision")); }
    Ok(artifacts.iter().map(|artifact| artifact.relative_path.clone()).collect())
}
