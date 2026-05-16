//! Binary serializers used by the resource-first v1 data plane.

const FIELD_VECTOR_BINARY_HEADER_LEN: usize = 48;
const FIELD_VECTOR_BINARY_VERSION: u8 = 2;
const FIELD_VECTOR_BINARY_KIND_F64: u8 = 1;
const FIELD_VECTOR_BINARY_QUANTITY_ID_LEN: usize = 16;
const FEM_MESH_TOPOLOGY_BINARY_HEADER_LEN: usize = 32;
const FEM_MESH_TOPOLOGY_BINARY_VERSION: u8 = 1;
const FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32: u8 = 1;

pub(crate) fn serialize_field_vector_binary_v2(
    quantity_id: &str,
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
) -> Result<Vec<u8>, String> {
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

    let mut out = Vec::with_capacity(FIELD_VECTOR_BINARY_HEADER_LEN + values.len() * 8);
    out.extend_from_slice(b"FMVP");
    out.push(FIELD_VECTOR_BINARY_VERSION);
    out.push(FIELD_VECTOR_BINARY_KIND_F64);
    out.push(n_comp as u8);
    out.push(0u8);
    // Bytes 8..12 are reserved for future FMVP header flags.
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
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

    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }

    Ok(out)
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
    use super::serialize_field_vector_binary_v2;

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
}
