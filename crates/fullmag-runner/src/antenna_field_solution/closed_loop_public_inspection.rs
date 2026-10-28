//! Read-only inspection of the canonical closed-loop bundle; never qualification.
use super::closed_loop_v2;
use crate::types::{AuxiliaryArtifact, RunError};
use serde_json::Value;
use std::{collections::BTreeMap, fs, io::Read, path::{Component, Path}};

pub struct LoadedAntennaClosedLoopInspection {
    pub metadata: Value,
    pub payloads: BTreeMap<String, Vec<u8>>,
}

fn read(root: &Path, relative: &str, limit: usize) -> Result<Vec<u8>, RunError> {
    let relative = Path::new(relative);
    if relative.is_absolute() || !relative.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(closed_loop_v2::invalid("unsafe inspection path"));
    }
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&path).map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
        if metadata.file_type().is_symlink() || fs::canonicalize(&path).map_err(|e| closed_loop_v2::invalid(&e.to_string()))? != path {
            return Err(closed_loop_v2::invalid("aliased inspection descendant"));
        }
    }
    let mut file = fs::File::open(&path).map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    let metadata = file.metadata().map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    if !metadata.is_file() || metadata.len() > limit as u64 { return Err(closed_loop_v2::invalid("inspection read bound")); }
    let mut bytes = Vec::new();
    (&mut file).take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    if bytes.len() as u64 != metadata.len() || bytes.len() > limit || file.metadata().map_err(|e| closed_loop_v2::invalid(&e.to_string()))?.len() != metadata.len() {
        return Err(closed_loop_v2::invalid("inspection changed during read"));
    }
    Ok(bytes)
}

/// Reads exactly the published closure and runs the same neutral verifier as publication.
pub fn load_published_antenna_closed_loop_inspection(
    artifact_dir: &Path, manifest_ref: &str, stage_id: &str, output_id: &str,
    port_mode_id: &str, content_digest: &str,
) -> Result<LoadedAntennaClosedLoopInspection, RunError> {
    if output_id.is_empty() || output_id.len() > 255 || output_id.contains("..")
        || !output_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        || manifest_ref != format!("antenna/field_solutions/{output_id}/manifest.v2.json") {
        return Err(closed_loop_v2::invalid("inspection reference identity"));
    }
    let root = fs::canonicalize(artifact_dir).map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    let bytes = read(&root, manifest_ref, super::ANTENNA_FIELD_MANIFEST_MAX_BYTES)?;
    let lengths = closed_loop_v2::payload_lengths(&bytes)?;
    let total = lengths.values().try_fold(0usize, |sum, n| sum.checked_add(*n))
        .ok_or_else(|| closed_loop_v2::invalid("inspection aggregate overflow"))?;
    if total > 512 * 1024 * 1024 { return Err(closed_loop_v2::invalid("inspection aggregate read bound")); }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    if manifest["stage_id"] != stage_id || manifest["solution_id"] != output_id
        || manifest["port_mode_id"] != port_mode_id || manifest["content_digest"] != content_digest {
        return Err(closed_loop_v2::invalid("inspection stage/output/port/digest mismatch"));
    }
    let mut artifacts = Vec::new();
    for (path, length) in lengths { artifacts.push(AuxiliaryArtifact { bytes: read(&root, &path, length)?, relative_path: path }); }
    closed_loop_v2::verify(&bytes, &artifacts, true)?;
    inspection_view(manifest, artifacts)
}

/// Build the same bounded field view from an accepted CAS bundle without extraction.
/// The caller must bind the operation owner and its admitted transport budget.
pub fn load_antenna_closed_loop_inspection_bytes(
    manifest_bytes: &[u8], artifacts: Vec<AuxiliaryArtifact>, stage_id: &str,
    output_id: &str, port_mode_id: &str, content_digest: &str, max_bytes: usize,
) -> Result<LoadedAntennaClosedLoopInspection, RunError> {
    verify_antenna_closed_loop_inspection_bytes(manifest_bytes, &artifacts, stage_id,
        output_id, port_mode_id, content_digest, max_bytes)?;
    let manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    inspection_view(manifest, artifacts)
}

fn inspection_view(manifest: Value, artifacts: Vec<AuxiliaryArtifact>)
    -> Result<LoadedAntennaClosedLoopInspection, RunError> {
    let mut metadata = serde_json::Map::new();
    for key in ["schema_version", "status", "content_digest", "asset_id", "solution_id", "source_object_id", "current_transport_id", "stage_id", "port_mode_id", "source", "requested_intent", "resolved_execution", "sample_carrier", "vertex_count", "cell_count", "face_count", "weak_reaction_count", "target_count", "sample_cell_count", "signed_normalization_a", "scale_per_a", "direct_evidence_schema", "payloads"] {
        metadata.insert(key.into(), manifest[key].clone());
    }
    // The canonical surface policy retains fixed-order arrays in the manifest
    // and evidence. The thin control-plane view names each scalar counter.
    if manifest["direct_evidence_schema"] == super::surface_rt0_evidence_v1::SCHEMA {
        const WORK_NAMES: [&str; 14] = [
            "source_target_pairs", "face_precision_passes", "whole_face_formulas",
            "signed_fan_panels", "exact_fraction_operations", "exact_integer_operations",
            "exact_comparisons", "real_divisions", "copied_input_bytes",
            "reserved_output_bytes", "sqrt_calls", "log_calls", "log1p_calls", "atan2_calls",
        ];
        for intent in ["requested_intent", "resolved_execution"] {
            let policy = metadata.get_mut(intent).and_then(|v| v.get_mut("surface_field_policy"))
                .ok_or_else(|| closed_loop_v2::invalid("surface metadata policy absent"))?;
            let typed: fullmag_ir::AntennaSurfaceFieldPolicyIR = serde_json::from_value(policy.clone())
                .map_err(|_|closed_loop_v2::invalid("surface metadata policy shape"))?;
            if !typed.validation_errors("surface_field_policy").is_empty() {
                return Err(closed_loop_v2::invalid("surface metadata policy gate"));
            }
            for (name, counts) in [("total",typed.limits.total),("per_target",typed.limits.per_target)] {
                let named: serde_json::Map<String,Value> = WORK_NAMES.iter().zip(counts)
                    .map(|(key,value)|((*key).to_owned(),Value::from(value))).collect();
                policy["limits"][name]=Value::Object(named);
            }
        }
        metadata.insert("surface_counter_encoding".into(),"named_work_kind.v1".into());
    }
    // These are scalar provenance maps, never mesh or authoring payload carriers.
    fn scalar_map(value: &Value) -> bool {
        match value { Value::Array(_) => false, Value::Object(m) => m.values().all(scalar_map), _ => true }
    }
    if !scalar_map(&metadata["requested_intent"]) || !scalar_map(&metadata["resolved_execution"])
        || serde_json::to_vec(&metadata).map_err(|e| closed_loop_v2::invalid(&e.to_string()))?.len() > 64 * 1024 {
        return Err(closed_loop_v2::invalid("thin inspection metadata bound or numerical arrays"));
    }
    metadata.insert("validation_scope".into(), "full_cold_bundle".into());
    metadata.insert("qualification".into(), "NOT VERIFIED".into());
    metadata.insert("field_scope".into(), "full_closed_loop.inspection_only.v2".into());
    let mut payloads = BTreeMap::new();
    for artifact in artifacts {
        let name = Path::new(&artifact.relative_path).file_stem().and_then(|s| s.to_str())
            .ok_or_else(|| closed_loop_v2::invalid("payload name"))?.to_owned();
        payloads.insert(name, artifact.bytes);
    }
    Ok(LoadedAntennaClosedLoopInspection { metadata: Value::Object(metadata), payloads })
}


/// Verify an accepted single-CAS bundle without extraction or native execution.
/// Caller supplies the immutable operation owner and the admitted byte budget.
/// Success validates inspection integrity only; it does not qualify a field basis.
pub fn verify_antenna_closed_loop_inspection_bytes(
    manifest_bytes: &[u8],
    artifacts: &[AuxiliaryArtifact],
    stage_id: &str,
    output_id: &str,
    port_mode_id: &str,
    content_digest: &str,
    max_bytes: usize,
) -> Result<(), RunError> {
    if manifest_bytes.is_empty() || manifest_bytes.len() > super::ANTENNA_FIELD_MANIFEST_MAX_BYTES {
        return Err(closed_loop_v2::invalid("inspection manifest bound"));
    }
    let total = artifacts.iter().try_fold(manifest_bytes.len(), |sum, artifact| {
        sum.checked_add(artifact.bytes.len())
    }).ok_or_else(|| closed_loop_v2::invalid("inspection aggregate overflow"))?;
    if total > max_bytes.min(512 * 1024 * 1024) {
        return Err(closed_loop_v2::invalid("inspection aggregate byte budget"));
    }
    // The canonical parser rejects ambiguous JSON and validates signed identity.
    let lengths = closed_loop_v2::payload_lengths(manifest_bytes)?;
    if lengths.len() != artifacts.len() {
        return Err(closed_loop_v2::invalid("inspection payload closure mismatch"));
    }
    let manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|e| closed_loop_v2::invalid(&e.to_string()))?;
    if stage_id.is_empty() || output_id.is_empty() || port_mode_id.is_empty()
        || !content_digest.starts_with("sha256:")
        || manifest["stage_id"] != stage_id || manifest["solution_id"] != output_id
        || manifest["port_mode_id"] != port_mode_id || manifest["content_digest"] != content_digest {
        return Err(closed_loop_v2::invalid("inspection stage/output/port/digest mismatch"));
    }
    closed_loop_v2::verify(manifest_bytes, artifacts, true)
}

#[cfg(test)]
mod accepted_bundle_tests {
    use super::*;

    #[test]
    fn framing_fixture_does_not_become_a_physically_verified_inspection() {
        let manifest = br#"{"schema_version":"antenna_field_solution.v2","status":"inspection_only","solution_id":"output","payloads":{}}"#;
        assert!(verify_antenna_closed_loop_inspection_bytes(
            manifest, &[], "stage", "output", "port", &format!("sha256:{}", "a".repeat(64)), 4096,
        ).is_err());
    }

    #[test]
    fn byte_budget_is_checked_before_manifest_parse() {
        let manifest = br#"{}"#;
        let error = verify_antenna_closed_loop_inspection_bytes(
            manifest, &[], "stage", "output", "port", "sha256:invalid", 1,
        ).unwrap_err();
        assert!(error.message.contains("aggregate byte budget"));
    }
}
