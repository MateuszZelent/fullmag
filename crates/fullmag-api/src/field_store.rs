//! Binary serializers used by the resource-first data plane.

const FIELD_VECTOR_BINARY_HEADER_LEN: usize = 48;
const FIELD_VECTOR_BINARY_VERSION: u8 = 2;
const FIELD_VECTOR_BINARY_VERSION_V3: u8 = 3;
const FIELD_VECTOR_BINARY_KIND_F64: u8 = 1;
const FIELD_VECTOR_BINARY_QUANTITY_ID_LEN: usize = 16;
const FIELD_VECTOR_METADATA_FIXED_LEN: usize = 68;
const FIELD_VECTOR_METADATA_VERSION: u16 = 1;
const FEM_MESH_TOPOLOGY_BINARY_HEADER_LEN: usize = 32;
const FEM_MESH_TOPOLOGY_BINARY_VERSION: u8 = 1;
const FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FieldVectorIndexing {
    FullDomain,
    ExplicitNodeIndices,
    SampledNodeIndices,
    #[allow(dead_code)]
    LegacyCountOnly,
}

impl FieldVectorIndexing {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::FullDomain => "full_domain",
            Self::ExplicitNodeIndices => "explicit_node_indices",
            Self::SampledNodeIndices => "sampled_node_indices",
            Self::LegacyCountOnly => "legacy_count_only",
        }
    }

    fn code(self) -> u32 {
        match self {
            Self::FullDomain => 0,
            Self::ExplicitNodeIndices => 1,
            Self::SampledNodeIndices => 2,
            Self::LegacyCountOnly => 3,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FieldVectorBinaryMetadata<'a> {
    pub domain_generation_id: u64,
    pub mesh_topology_revision: u64,
    pub mesh_topology_hash: [u8; 32],
    pub scope_kind: &'a str,
    pub scope_id: &'a str,
    pub indexing: FieldVectorIndexing,
    pub node_indices: &'a [u32],
}

pub(crate) fn serialize_field_vector_binary_v2(
    quantity_id: &str,
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
) -> Result<Vec<u8>, String> {
    validate_field_vector_payload(n_comp, grid, values)?;

    let mut out = Vec::with_capacity(FIELD_VECTOR_BINARY_HEADER_LEN + values.len() * 8);
    write_field_vector_header(
        &mut out,
        FIELD_VECTOR_BINARY_VERSION,
        n_comp,
        0,
        values.len(),
        grid,
        quantity_id,
    );

    write_f64_values(&mut out, values);

    Ok(out)
}

pub(crate) fn serialize_field_vector_binary_v3(
    quantity_id: &str,
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
    metadata: &FieldVectorBinaryMetadata<'_>,
) -> Result<Vec<u8>, String> {
    validate_field_vector_payload(n_comp, grid, values)?;
    let point_count = values.len() / n_comp;
    match metadata.indexing {
        FieldVectorIndexing::ExplicitNodeIndices | FieldVectorIndexing::SampledNodeIndices => {
            if metadata.node_indices.len() != point_count {
                return Err(format!(
                    "FMVP v3 node_indices length mismatch: expected {point_count}, got {}",
                    metadata.node_indices.len()
                ));
            }
        }
        FieldVectorIndexing::FullDomain | FieldVectorIndexing::LegacyCountOnly => {
            if !metadata.node_indices.is_empty() {
                return Err(
                    "FMVP v3 full/legacy indexing must not include node_indices".to_string()
                );
            }
        }
    }

    let metadata_block = encode_field_vector_metadata(metadata)?;
    let mut out = Vec::with_capacity(
        FIELD_VECTOR_BINARY_HEADER_LEN + metadata_block.len() + values.len() * 8,
    );
    write_field_vector_header(
        &mut out,
        FIELD_VECTOR_BINARY_VERSION_V3,
        n_comp,
        metadata_block.len(),
        values.len(),
        grid,
        quantity_id,
    );
    out.extend_from_slice(&metadata_block);
    debug_assert_eq!(out.len() % 8, 0);
    write_f64_values(&mut out, values);

    Ok(out)
}

fn validate_field_vector_payload(
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
) -> Result<(), String> {
    if n_comp == 0 {
        return Err("FMVP n_comp must be greater than zero".to_string());
    }
    if n_comp > u8::MAX as usize {
        return Err(format!("FMVP n_comp {n_comp} exceeds u8 header capacity"));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err("FMVP payload contains non-finite values".to_string());
    }
    let expected_value_count = grid
        .iter()
        .try_fold(1usize, |acc, value| acc.checked_mul(*value as usize))
        .and_then(|point_count| point_count.checked_mul(n_comp))
        .ok_or_else(|| "FMVP grid*n_comp overflows usize".to_string())?;
    if values.len() != expected_value_count {
        return Err(format!(
            "FMVP value count mismatch: expected {expected_value_count}, got {}",
            values.len()
        ));
    }

    Ok(())
}

fn write_field_vector_header(
    out: &mut Vec<u8>,
    version: u8,
    n_comp: usize,
    metadata_len: usize,
    value_count: usize,
    grid: [u32; 3],
    quantity_id: &str,
) {
    out.extend_from_slice(b"FMVP");
    out.push(version);
    out.push(FIELD_VECTOR_BINARY_KIND_F64);
    out.push(n_comp as u8);
    out.push(0u8);
    out.extend_from_slice(&(metadata_len as u32).to_le_bytes());
    out.extend_from_slice(&(value_count as u32).to_le_bytes());
    out.extend_from_slice(&grid[0].to_le_bytes());
    out.extend_from_slice(&grid[1].to_le_bytes());
    out.extend_from_slice(&grid[2].to_le_bytes());

    let id_bytes = quantity_id.as_bytes();
    let copy_len = id_bytes.len().min(FIELD_VECTOR_BINARY_QUANTITY_ID_LEN);
    out.extend_from_slice(&id_bytes[..copy_len]);
    for _ in copy_len..FIELD_VECTOR_BINARY_QUANTITY_ID_LEN {
        out.push(0u8);
    }
    // Bytes 44..48 are reserved padding after the fixed quantity id field.
    out.extend_from_slice(&[0u8; 4]);
}

fn encode_field_vector_metadata(
    metadata: &FieldVectorBinaryMetadata<'_>,
) -> Result<Vec<u8>, String> {
    let scope_kind_bytes = metadata.scope_kind.as_bytes();
    let scope_id_bytes = metadata.scope_id.as_bytes();
    if scope_kind_bytes.len() > u16::MAX as usize {
        return Err("FMVP v3 scope_kind exceeds u16 length".to_string());
    }
    if scope_id_bytes.len() > u16::MAX as usize {
        return Err("FMVP v3 scope_id exceeds u16 length".to_string());
    }
    if metadata.node_indices.len() > u32::MAX as usize {
        return Err("FMVP v3 node_indices exceeds u32 length".to_string());
    }

    let raw_len = FIELD_VECTOR_METADATA_FIXED_LEN
        + scope_kind_bytes.len()
        + scope_id_bytes.len()
        + metadata.node_indices.len() * std::mem::size_of::<u32>();
    let metadata_len = align_to_eight(raw_len);
    let mut out = Vec::with_capacity(metadata_len);
    out.extend_from_slice(b"FMMI");
    out.extend_from_slice(&FIELD_VECTOR_METADATA_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&metadata.domain_generation_id.to_le_bytes());
    out.extend_from_slice(&metadata.mesh_topology_revision.to_le_bytes());
    out.extend_from_slice(&metadata.mesh_topology_hash);
    out.extend_from_slice(&metadata.indexing.code().to_le_bytes());
    out.extend_from_slice(&(metadata.node_indices.len() as u32).to_le_bytes());
    out.extend_from_slice(&(scope_kind_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&(scope_id_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(scope_kind_bytes);
    out.extend_from_slice(scope_id_bytes);
    for node_index in metadata.node_indices {
        out.extend_from_slice(&node_index.to_le_bytes());
    }
    out.resize(metadata_len, 0);
    Ok(out)
}

fn align_to_eight(value: usize) -> usize {
    value.next_multiple_of(8)
}

fn write_f64_values(out: &mut Vec<u8>, values: &[f64]) {
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

pub(crate) fn serialize_fem_mesh_topology_binary_v1(
    mesh: &fullmag_runner::FemMeshPayload,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        FEM_MESH_TOPOLOGY_BINARY_HEADER_LEN
            + mesh.nodes.len() * 3 * std::mem::size_of::<f64>()
            + mesh.elements.len() * 4 * std::mem::size_of::<u32>()
            + mesh.boundary_faces.len() * 3 * std::mem::size_of::<u32>()
            + mesh.element_markers.len() * std::mem::size_of::<u32>()
            + mesh.boundary_markers.len() * std::mem::size_of::<u32>(),
    );

    out.extend_from_slice(b"FMMT");
    out.push(FEM_MESH_TOPOLOGY_BINARY_VERSION);
    out.push(FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(mesh.nodes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.elements.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.boundary_faces.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.element_markers.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.boundary_markers.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for node in &mesh.nodes {
        out.extend_from_slice(&node[0].to_le_bytes());
        out.extend_from_slice(&node[1].to_le_bytes());
        out.extend_from_slice(&node[2].to_le_bytes());
    }
    for element in &mesh.elements {
        out.extend_from_slice(&element[0].to_le_bytes());
        out.extend_from_slice(&element[1].to_le_bytes());
        out.extend_from_slice(&element[2].to_le_bytes());
        out.extend_from_slice(&element[3].to_le_bytes());
    }
    for face in &mesh.boundary_faces {
        out.extend_from_slice(&face[0].to_le_bytes());
        out.extend_from_slice(&face[1].to_le_bytes());
        out.extend_from_slice(&face[2].to_le_bytes());
    }
    for marker in &mesh.element_markers {
        out.extend_from_slice(&marker.to_le_bytes());
    }
    for marker in &mesh.boundary_markers {
        out.extend_from_slice(&marker.to_le_bytes());
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{
        FieldVectorBinaryMetadata, FieldVectorIndexing, serialize_field_vector_binary_v2,
        serialize_field_vector_binary_v3,
    };

    #[test]
    fn field_vector_serializer_rejects_zero_component_count() {
        let error = serialize_field_vector_binary_v2("m", 0, [1, 1, 1], &[])
            .expect_err("zero-component FMVP payloads must be rejected");

        assert!(error.contains("n_comp"));
    }

    #[test]
    fn field_vector_serializer_rejects_non_finite_values() {
        let error = serialize_field_vector_binary_v2("m", 1, [1, 1, 1], &[f64::NAN])
            .expect_err("non-finite FMVP payloads must be rejected");

        assert!(error.contains("non-finite"));
    }

    #[test]
    fn field_vector_serializer_v3_encodes_full_domain_metadata() {
        let metadata = FieldVectorBinaryMetadata {
            domain_generation_id: 42,
            mesh_topology_revision: 7,
            mesh_topology_hash: [0xAB; 32],
            scope_kind: "full",
            scope_id: "",
            indexing: FieldVectorIndexing::FullDomain,
            node_indices: &[],
        };

        let binary =
            serialize_field_vector_binary_v3("m", 3, [1, 1, 1], &[1.0, 0.0, 0.0], &metadata)
                .expect("FMVP v3 full-domain payload should serialize");

        assert_eq!(&binary[0..4], b"FMVP");
        assert_eq!(binary[4], 3);
        assert_eq!(&binary[48..52], b"FMMI");
        assert_eq!(u64::from_le_bytes(binary[56..64].try_into().unwrap()), 42);
        assert_eq!(u64::from_le_bytes(binary[64..72].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(binary[104..108].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(binary[108..112].try_into().unwrap()), 0);
    }

    #[test]
    fn field_vector_serializer_v3_encodes_explicit_node_indices() {
        let metadata = FieldVectorBinaryMetadata {
            domain_generation_id: 42,
            mesh_topology_revision: 7,
            mesh_topology_hash: [0xCD; 32],
            scope_kind: "part",
            scope_id: "part:a",
            indexing: FieldVectorIndexing::ExplicitNodeIndices,
            node_indices: &[3, 1],
        };

        let binary = serialize_field_vector_binary_v3(
            "h_eff",
            3,
            [2, 1, 1],
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &metadata,
        )
        .expect("FMVP v3 explicit-index payload should serialize");
        let metadata_len = u32::from_le_bytes(binary[8..12].try_into().unwrap()) as usize;
        let metadata_end = 48 + metadata_len;

        assert_eq!(u32::from_le_bytes(binary[104..108].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(binary[108..112].try_into().unwrap()), 2);
        let node_indices_offset = 48 + 68 + "part".len() + "part:a".len();
        assert_eq!(
            &binary[node_indices_offset..node_indices_offset + 8],
            &[3, 0, 0, 0, 1, 0, 0, 0]
        );
        assert_eq!(metadata_end % 8, 0);
    }

    #[test]
    fn field_vector_serializer_v3_validates_node_indices_by_indexing() {
        let sampled = FieldVectorBinaryMetadata {
            domain_generation_id: 42,
            mesh_topology_revision: 7,
            mesh_topology_hash: [0xEF; 32],
            scope_kind: "part",
            scope_id: "part:a",
            indexing: FieldVectorIndexing::SampledNodeIndices,
            node_indices: &[3],
        };
        let sampled_error = serialize_field_vector_binary_v3(
            "h_eff",
            3,
            [2, 1, 1],
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &sampled,
        )
        .expect_err("sampled payloads must carry one node index per point");
        assert!(sampled_error.contains("node_indices length mismatch"));

        let legacy = FieldVectorBinaryMetadata {
            indexing: FieldVectorIndexing::LegacyCountOnly,
            node_indices: &[0],
            ..sampled
        };
        let legacy_error =
            serialize_field_vector_binary_v3("m", 3, [1, 1, 1], &[1.0, 0.0, 0.0], &legacy)
                .expect_err("legacy count-only payloads must not carry node indices");
        assert!(legacy_error.contains("must not include node_indices"));
    }
}
