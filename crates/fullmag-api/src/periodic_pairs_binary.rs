//! Deterministic binary data-plane codec for FEM periodic node/face pairs.

use crate::schemas::mesh::{MeshPeriodicPairsResource, PeriodicValidationStatus};

const MAGIC: &[u8; 4] = b"FMPP";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 20;

/// Encode the heavy periodic node/face mappings without duplicating the JSON
/// control-plane diagnostics. All integer fields are little-endian and pair
/// records are sorted by their stable `pair_id`.
pub(crate) fn encode_periodic_pairs_binary_v1(
    resource: &MeshPeriodicPairsResource,
) -> Result<Vec<u8>, String> {
    let pair_count = u32::try_from(resource.pairs.len())
        .map_err(|_| "periodic pair count exceeds binary codec limit".to_string())?;
    let mut pairs = resource.pairs.iter().collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.pair_id.cmp(&right.pair_id));

    let mut output = Vec::with_capacity(HEADER_LEN);
    output.extend_from_slice(MAGIC);
    output.push(VERSION);
    output.push(status_code(resource.status));
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&resource.revision.to_le_bytes());
    output.extend_from_slice(&pair_count.to_le_bytes());

    for pair in pairs {
        let pair_id = pair.pair_id.as_bytes();
        let pair_id_len = u32::try_from(pair_id.len())
            .map_err(|_| "periodic pair id exceeds binary codec limit".to_string())?;
        output.extend_from_slice(&pair_id_len.to_le_bytes());
        output.extend_from_slice(pair_id);
        output.extend_from_slice(&pair.marker_a.to_le_bytes());
        output.extend_from_slice(&pair.marker_b.to_le_bytes());

        let node_pair_count = u32::try_from(pair.node_pairs.len()).map_err(|_| {
            format!(
                "node-pair count for '{}' exceeds binary codec limit",
                pair.pair_id
            )
        })?;
        let face_pair_count = u32::try_from(pair.boundary_face_pairs.len()).map_err(|_| {
            format!(
                "boundary face-pair count for '{}' exceeds binary codec limit",
                pair.pair_id
            )
        })?;
        output.extend_from_slice(&node_pair_count.to_le_bytes());
        output.extend_from_slice(&face_pair_count.to_le_bytes());
        for [source, destination] in &pair.node_pairs {
            output.extend_from_slice(&source.to_le_bytes());
            output.extend_from_slice(&destination.to_le_bytes());
        }
        for face in &pair.boundary_face_pairs {
            output.extend_from_slice(&face.face_a.to_le_bytes());
            output.extend_from_slice(&face.face_b.to_le_bytes());
            let vertex_pair_count = u32::try_from(face.vertex_pairs.len()).map_err(|_| {
                format!(
                    "vertex-pair count for '{}' face {} exceeds binary codec limit",
                    pair.pair_id, face.face_a
                )
            })?;
            output.extend_from_slice(&vertex_pair_count.to_le_bytes());
            for [source, destination] in &face.vertex_pairs {
                output.extend_from_slice(&source.to_le_bytes());
                output.extend_from_slice(&destination.to_le_bytes());
            }
        }
    }

    Ok(output)
}

fn status_code(status: PeriodicValidationStatus) -> u8 {
    match status {
        PeriodicValidationStatus::Valid => 1,
        PeriodicValidationStatus::Invalid => 2,
        PeriodicValidationStatus::Stale => 3,
        PeriodicValidationStatus::Unavailable => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::encode_periodic_pairs_binary_v1;
    use crate::schemas::mesh::{MeshPeriodicPairsResource, PeriodicValidationStatus};

    #[test]
    fn codec_is_deterministic_for_same_resource() {
        let resource = MeshPeriodicPairsResource {
            revision: 41,
            schema_version: "periodic_pairs.v1".to_string(),
            status: PeriodicValidationStatus::Valid,
            status_reasons: Vec::new(),
            topology_fingerprint: None,
            certificate_fingerprint: None,
            certificate_revision: None,
            mesh_generation_id: None,
            source_scene_revision: None,
            pairs: Vec::new(),
        };
        let first = encode_periodic_pairs_binary_v1(&resource).unwrap();
        let second = encode_periodic_pairs_binary_v1(&resource).unwrap();
        assert_eq!(first, second);
        assert_eq!(&first[..4], b"FMPP");
        assert_eq!(first[4], 1);
    }
}
