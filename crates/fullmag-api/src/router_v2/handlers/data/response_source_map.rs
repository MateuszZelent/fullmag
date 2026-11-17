//! Exact native FMR sample-to-source-mesh binding. No count-based inference.

use crate::error::ApiError;
use fullmag_runner::FrequencyResponseInputDescriptor;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct ResponseSourceMeshIdentity {
    pub mesh_generation_id: String,
    pub topology_fingerprint: String,
    pub node_count: u64,
    pub indexing: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ResponseInputEnvelope {
    pub schema_version: String,
    pub descriptor: FrequencyResponseInputDescriptor,
    pub source_mesh_identity: ResponseSourceMeshIdentity,
    pub equilibrium_verified: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ResponsePointBinding {
    pub full_node_count: u64,
    pub native_node_count: u64,
    pub topology_fingerprint: String,
    pub equilibrium_sha256: String,
    pub magnetic_node_indices_sha256: String,
}

pub(crate) fn validate_source_map(
    envelope: &ResponseInputEnvelope,
    current_topology: &str,
    current_generation: Option<&str>,
    current_node_count: usize,
    point: &ResponsePointBinding,
    raw_map: Option<&[u8]>,
    point_count: usize,
) -> Result<Vec<u32>, ApiError> {
    let invalid =
        |reason: &str| ApiError::conflict(format!("response_field_source_map_invalid: {reason}"));
    let descriptor = &envelope.descriptor;
    let source = &envelope.source_mesh_identity;
    if envelope.schema_version != "fullmag.fem.driven_response_input.v1"
        || envelope.equilibrium_verified
        || source.indexing != "full_domain_node_order"
        || source.topology_fingerprint != current_topology
        || current_generation != Some(source.mesh_generation_id.as_str())
        || source.mesh_generation_id.is_empty()
        || usize::try_from(source.node_count).ok() != Some(current_node_count)
        || source.node_count != descriptor.full_node_count
    {
        return Err(invalid(
            "source mesh identity differs from current prepared FEM mesh",
        ));
    }
    let raw_digest = |text: &str| {
        text.len() == 64
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !descriptor
        .topology_fingerprint
        .strip_prefix("sha256:")
        .is_some_and(raw_digest)
        || !raw_digest(&descriptor.equilibrium_sha256)
        || !raw_digest(&descriptor.magnetic_node_indices_sha256)
        || descriptor.native_node_count == 0
        || descriptor.native_node_count > descriptor.full_node_count
        || usize::try_from(descriptor.native_node_count).ok() != Some(point_count)
        || descriptor.magnetic_node_indices.len() != point_count
        || point.full_node_count != descriptor.full_node_count
        || point.native_node_count != descriptor.native_node_count
        || point.topology_fingerprint != descriptor.topology_fingerprint
        || point.equilibrium_sha256 != descriptor.equilibrium_sha256
        || point.magnetic_node_indices_sha256 != descriptor.magnetic_node_indices_sha256
    {
        return Err(invalid(
            "point payload differs from its exact input descriptor",
        ));
    }
    let raw_map =
        raw_map.ok_or_else(|| ApiError::conflict("response_field_source_map_unavailable"))?;
    let expected_bytes = point_count
        .checked_mul(8)
        .ok_or_else(|| invalid("map length overflow"))?;
    if raw_map.len() != expected_bytes
        || fullmag_session::hex_sha256(raw_map) != descriptor.magnetic_node_indices_sha256
    {
        return Err(invalid("ordered map byte length or SHA-256 mismatch"));
    }
    let mut previous = None;
    descriptor
        .magnetic_node_indices
        .iter()
        .zip(raw_map.chunks_exact(8))
        .map(|(&index, encoded)| {
            let stored = u64::from_le_bytes(
                encoded
                    .try_into()
                    .map_err(|_| invalid("invalid map element"))?,
            );
            if stored != index
                || index >= descriptor.full_node_count
                || previous.is_some_and(|prior| index <= prior)
            {
                return Err(invalid(
                    "map must preserve unique increasing native full-plan node order",
                ));
            }
            previous = Some(index);
            u32::try_from(index).map_err(|_| invalid("node index exceeds FMVP v5 capacity"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (ResponseInputEnvelope, ResponsePointBinding, Vec<u8>) {
        let map = vec![1_u64, 3];
        let bytes = map.iter().flat_map(|n| n.to_le_bytes()).collect::<Vec<_>>();
        let descriptor = FrequencyResponseInputDescriptor {
            full_node_count: 5,
            native_node_count: 2,
            topology_fingerprint: format!("sha256:{}", "a".repeat(64)),
            equilibrium_sha256: "b".repeat(64),
            magnetic_node_indices: map,
            magnetic_node_indices_sha256: fullmag_session::hex_sha256(&bytes),
        };
        let point = ResponsePointBinding {
            full_node_count: descriptor.full_node_count,
            native_node_count: descriptor.native_node_count,
            topology_fingerprint: descriptor.topology_fingerprint.clone(),
            equilibrium_sha256: descriptor.equilibrium_sha256.clone(),
            magnetic_node_indices_sha256: descriptor.magnetic_node_indices_sha256.clone(),
        };
        (
            ResponseInputEnvelope {
                schema_version: "fullmag.fem.driven_response_input.v1".into(),
                descriptor,
                source_mesh_identity: ResponseSourceMeshIdentity {
                    mesh_generation_id: "mesh-exact".into(),
                    topology_fingerprint: "payload-topology-exact".into(),
                    node_count: 5,
                    indexing: "full_domain_node_order".into(),
                },
                equilibrium_verified: false,
            },
            point,
            bytes,
        )
    }

    fn checked(
        e: &ResponseInputEnvelope,
        p: &ResponsePointBinding,
        bytes: Option<&[u8]>,
    ) -> Result<Vec<u32>, ApiError> {
        validate_source_map(
            e,
            "payload-topology-exact",
            Some("mesh-exact"),
            5,
            p,
            bytes,
            2,
        )
    }

    #[test]
    fn response_map_accepts_exact_nonprefix_native_order() {
        let (e, p, b) = fixture();
        assert_eq!(checked(&e, &p, Some(&b)).unwrap(), vec![1, 3]);
    }

    #[test]
    fn response_map_rejects_same_count_permutation_or_corrupt_digest() {
        let (mut e, p, b) = fixture();
        e.descriptor.magnetic_node_indices.swap(0, 1);
        assert!(checked(&e, &p, Some(&b)).is_err());
        let (e, mut p, b) = fixture();
        p.magnetic_node_indices_sha256 = "c".repeat(64);
        assert!(checked(&e, &p, Some(&b)).is_err());
    }

    #[test]
    fn response_map_rejects_foreign_topology_or_generation_even_when_counts_match() {
        let (mut e, p, b) = fixture();
        e.source_mesh_identity.topology_fingerprint = "foreign".into();
        assert!(checked(&e, &p, Some(&b)).is_err());
        let (mut e, p, b) = fixture();
        e.source_mesh_identity.mesh_generation_id = "foreign".into();
        assert!(checked(&e, &p, Some(&b)).is_err());
    }

    #[test]
    fn response_map_rejects_missing_payload_or_out_of_range_duplicate_indices() {
        let (e, p, b) = fixture();
        assert!(checked(&e, &p, None).is_err());
        for indices in [vec![1, 5], vec![1, 1]] {
            let mut e = e.clone();
            e.descriptor.magnetic_node_indices = indices;
            assert!(checked(&e, &p, Some(&b)).is_err());
        }
    }
}

/// Accepted v3 fields require immutable, explicit sample identity. Legacy
/// artifacts keep their historical reader; a damaged new closure cannot fall
/// through to count-only inference.
pub(crate) fn resolve_source_map(
    snapshot: &crate::types::SessionStateResponse,
    artifact_dir: &std::path::Path,
    point_path: &str,
    generation: Option<&fullmag_runner::artifact_generation::GenerationCapture>,
    point_count: usize,
) -> Result<Option<Vec<u32>>, ApiError> {
    use crate::router_v2::handlers::analysis::results::{
        read_frequency_domain_field_payload_in_generation,
        read_result_artifact_snapshot_in_generation,
    };
    let point_snapshot =
        read_result_artifact_snapshot_in_generation(artifact_dir, point_path, generation)?;
    let compact_point = point_snapshot
        .as_ref()
        .and_then(|(p, _)| p.get("schema_version"))
        .and_then(serde_json::Value::as_str)
        == Some("fullmag.fem.driven_response_point.v1");
    let manifest = read_result_artifact_snapshot_in_generation(
        artifact_dir,
        "frequency_domain/manifest.v1.json",
        generation,
    )?;
    let declared_v3 = manifest
        .as_ref()
        .and_then(|(m, _)| m.pointer("/artifacts/response_sweep_v3_path"))
        .is_some();
    let committed_v3 = generation.is_some_and(|g| {
        g.commit
            .content
            .members
            .contains_key("response/magnetic_response_sweep.v3.json")
    });
    if !declared_v3 && !committed_v3 && !compact_point {
        return Ok(None);
    }
    let generation = generation.ok_or_else(|| {
        ApiError::conflict("response_field_source_map_requires_immutable_generation")
    })?;
    let (manifest, _) =
        manifest.ok_or_else(|| ApiError::conflict("response_field_source_manifest_missing"))?;
    if !committed_v3
        || manifest
            .pointer("/artifacts/response_sweep_v3_path")
            .and_then(serde_json::Value::as_str)
            != Some("response/magnetic_response_sweep.v3.json")
    {
        return Err(ApiError::conflict(
            "response_field_compact_sweep_binding_missing",
        ));
    }
    let descriptor_path = manifest
        .pointer("/artifacts/response_input_descriptor_v1_path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ApiError::conflict("response_field_source_descriptor_path_missing"))?;
    if descriptor_path != "input/descriptor.v1.json" {
        return Err(ApiError::conflict(
            "response_field_source_descriptor_path_unsupported",
        ));
    }
    let (value, _) = read_result_artifact_snapshot_in_generation(
        artifact_dir,
        descriptor_path,
        Some(generation),
    )?
    .ok_or_else(|| ApiError::conflict("response_field_source_descriptor_missing"))?;
    let envelope: ResponseInputEnvelope = serde_json::from_value(value).map_err(|e| {
        ApiError::conflict(format!("response_field_source_descriptor_invalid: {e}"))
    })?;
    let mesh = snapshot
        .fem_mesh
        .as_ref()
        .ok_or_else(|| ApiError::conflict("response_field_source_mesh_unavailable"))?;
    let expected_bytes = envelope
        .descriptor
        .native_node_count
        .checked_mul(8)
        .ok_or_else(|| ApiError::conflict("response_field_source_map_size_overflow"))?;
    if envelope.descriptor.native_node_count > mesh.nodes.len() as u64
        || expected_bytes > 256 * 1024 * 1024
        || generation
            .commit
            .content
            .members
            .get("input/magnetic_node_indices.u64le")
            .is_none_or(|entry| entry.byte_length != expected_bytes)
    {
        return Err(ApiError::conflict(
            "response_field_source_map_length_mismatch",
        ));
    }
    let raw_map = read_frequency_domain_field_payload_in_generation(
        artifact_dir,
        "input/magnetic_node_indices.u64le",
        Some(generation),
    )?
    .map(|(bytes, _)| bytes);
    let (point, _) =
        point_snapshot.ok_or_else(|| ApiError::conflict("response_field_source_point_missing"))?;
    if point
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
        != Some("fullmag.fem.driven_response_point.v1")
        || point
            .get("component_basis")
            .or_else(|| point.pointer("/field/component_basis"))
            .and_then(serde_json::Value::as_str)
            != Some("global_xyz")
        || point
            .get("component_count")
            .and_then(serde_json::Value::as_u64)
            != Some(3)
    {
        return Err(ApiError::conflict(
            "response_field_source_point_requires_global_xyz",
        ));
    }
    if point
        .get("source_mesh_generation_id")
        .and_then(serde_json::Value::as_str)
        != Some(envelope.source_mesh_identity.mesh_generation_id.as_str())
        || point
            .get("source_mesh_topology_fingerprint")
            .and_then(serde_json::Value::as_str)
            != Some(envelope.source_mesh_identity.topology_fingerprint.as_str())
    {
        return Err(ApiError::conflict(
            "response_field_point_source_mesh_identity_mismatch",
        ));
    }
    let binding: ResponsePointBinding = serde_json::from_value(point).map_err(|e| {
        ApiError::conflict(format!("response_field_source_point_binding_invalid: {e}"))
    })?;
    validate_source_map(
        &envelope,
        mesh.topology_fingerprint(),
        mesh.generation_id.as_deref(),
        mesh.nodes.len(),
        &binding,
        raw_map.as_deref(),
        point_count,
    )
    .map(Some)
}
