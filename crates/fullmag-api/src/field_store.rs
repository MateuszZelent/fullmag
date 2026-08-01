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
const FEM_MESH_TOPOLOGY_BINARY_V2_HEADER_LEN: usize = 64;
const FEM_MESH_TOPOLOGY_BINARY_V2_VERSION: u8 = 2;
const FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32: u8 = 1;
const MAX_FEM_MESH_TOPOLOGY_BINARY_BYTES: usize = 512 * 1024 * 1024;

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

#[allow(dead_code)]
pub(crate) fn serialize_fem_mesh_topology_binary_v1(
    mesh: &fullmag_runner::FemMeshPayload,
) -> Result<Vec<u8>, String> {
    let elements = mesh.require_tet4_elements().map_err(|error| {
        format!("FMMT v1 requires tet4 topology; mixed topology is deferred to FMMT v2: {error}")
    })?;
    let boundary_faces = mesh.require_tri3_boundary_faces().map_err(|error| {
        format!("FMMT v1 requires tri3 facets; mixed topology is deferred to FMMT v2: {error}")
    })?;
    let mut out = Vec::with_capacity(
        FEM_MESH_TOPOLOGY_BINARY_HEADER_LEN
            + mesh.nodes.len() * 3 * std::mem::size_of::<f64>()
            + mesh.cell_count() * 4 * std::mem::size_of::<u32>()
            + mesh.facet_count() * 3 * std::mem::size_of::<u32>()
            + mesh.element_markers.len() * std::mem::size_of::<u32>()
            + mesh.boundary_markers.len() * std::mem::size_of::<u32>(),
    );

    out.extend_from_slice(b"FMMT");
    out.push(FEM_MESH_TOPOLOGY_BINARY_VERSION);
    out.push(FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(mesh.nodes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.cell_count() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.facet_count() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.element_markers.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.boundary_markers.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for node in &mesh.nodes {
        out.extend_from_slice(&node[0].to_le_bytes());
        out.extend_from_slice(&node[1].to_le_bytes());
        out.extend_from_slice(&node[2].to_le_bytes());
    }
    for element in &elements {
        out.extend_from_slice(&element[0].to_le_bytes());
        out.extend_from_slice(&element[1].to_le_bytes());
        out.extend_from_slice(&element[2].to_le_bytes());
        out.extend_from_slice(&element[3].to_le_bytes());
    }
    for face in &boundary_faces {
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

    Ok(out)
}

fn checked_u32_len(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("FMMT v2 {label} exceeds u32 capacity"))
}

fn checked_fem_mesh_topology_binary_v2_len(
    section_lengths: &[(usize, usize)],
) -> Result<usize, String> {
    let mut byte_len = FEM_MESH_TOPOLOGY_BINARY_V2_HEADER_LEN;
    for (element_count, bytes_per_element) in section_lengths {
        byte_len = byte_len
            .checked_add(7)
            .map(|value| value & !7)
            .ok_or_else(|| "FMMT v2 byte length overflow".to_string())?;
        byte_len = byte_len
            .checked_add(
                element_count
                    .checked_mul(*bytes_per_element)
                    .ok_or_else(|| "FMMT v2 byte length overflow".to_string())?,
            )
            .ok_or_else(|| "FMMT v2 byte length overflow".to_string())?;
        if byte_len > MAX_FEM_MESH_TOPOLOGY_BINARY_BYTES {
            return Err(format!(
                "FMMT v2 topology exceeds {} byte limit: {byte_len}",
                MAX_FEM_MESH_TOPOLOGY_BINARY_BYTES
            ));
        }
    }
    Ok(byte_len)
}

fn validate_connectivity<T: Copy>(
    label: &str,
    types: &[T],
    offsets: &[u32],
    nodes: &[u32],
    node_count: usize,
    arity: impl Fn(T) -> usize,
) -> Result<(), String> {
    let expected_offset_count = types
        .len()
        .checked_add(1)
        .ok_or_else(|| format!("FMMT v2 {label} count overflow"))?;
    if offsets.len() != expected_offset_count {
        return Err(format!(
            "FMMT v2 {label} offsets length mismatch: expected {expected_offset_count}, got {}",
            offsets.len()
        ));
    }
    if offsets.first().copied() != Some(0) {
        return Err(format!("FMMT v2 {label} offsets must start at zero"));
    }

    for (ordinal, entity_type) in types.iter().copied().enumerate() {
        let start = offsets[ordinal] as usize;
        let end = offsets[ordinal + 1] as usize;
        if end < start || end > nodes.len() {
            return Err(format!(
                "FMMT v2 {label} {ordinal} has invalid CSR range {start}..{end}"
            ));
        }
        let expected_arity = arity(entity_type);
        if end - start != expected_arity {
            return Err(format!(
                "FMMT v2 {label} {ordinal} has arity {}, expected {expected_arity}",
                end - start
            ));
        }
        if let Some(node) = nodes[start..end]
            .iter()
            .copied()
            .find(|node| *node as usize >= node_count)
        {
            return Err(format!(
                "FMMT v2 {label} {ordinal} references out-of-range node {node}"
            ));
        }
    }

    if offsets.last().copied().map(|value| value as usize) != Some(nodes.len()) {
        return Err(format!(
            "FMMT v2 {label} offsets do not cover the connectivity array"
        ));
    }
    Ok(())
}

fn validate_optional_markers(
    label: &str,
    marker_count: usize,
    entity_count: usize,
) -> Result<(), String> {
    if marker_count != 0 && marker_count != entity_count {
        return Err(format!(
            "FMMT v2 {label} marker count mismatch: expected zero or {entity_count}, got {marker_count}"
        ));
    }
    Ok(())
}

fn pad_to_eight(out: &mut Vec<u8>) {
    out.resize(out.len().next_multiple_of(8), 0);
}

fn write_u32_values(out: &mut Vec<u8>, values: &[u32]) {
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn write_u64_values(out: &mut Vec<u8>, values: &[u64]) {
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn fem_cell_type_code(cell_type: fullmag_ir::FemCellTypeIR) -> u32 {
    match cell_type {
        fullmag_ir::FemCellTypeIR::Tet4 => 1,
        fullmag_ir::FemCellTypeIR::Prism6 => 2,
        fullmag_ir::FemCellTypeIR::Pyramid5 => 3,
        fullmag_ir::FemCellTypeIR::Hex8 => 4,
    }
}

fn fem_facet_type_code(facet_type: fullmag_ir::FemFacetTypeIR) -> u32 {
    match facet_type {
        fullmag_ir::FemFacetTypeIR::Tri3 => 1,
        fullmag_ir::FemFacetTypeIR::Quad4 => 2,
    }
}

fn fem_facet_role_code(role: fullmag_ir::FemFacetRoleIR) -> u32 {
    match role {
        fullmag_ir::FemFacetRoleIR::Exterior => 1,
        fullmag_ir::FemFacetRoleIR::MaterialInterface => 2,
        fullmag_ir::FemFacetRoleIR::PeriodicSeam => 3,
    }
}

pub(crate) fn serialize_fem_mesh_topology_binary_v2(
    mesh: &fullmag_runner::FemMeshPayload,
) -> Result<Vec<u8>, String> {
    let node_count = checked_u32_len(mesh.nodes.len(), "node count")?;
    let cell_count = checked_u32_len(mesh.cells.types.len(), "cell count")?;
    let facet_count = checked_u32_len(mesh.facets.types.len(), "facet count")?;
    let cell_connectivity_count =
        checked_u32_len(mesh.cells.nodes.len(), "cell connectivity count")?;
    let facet_connectivity_count =
        checked_u32_len(mesh.facets.nodes.len(), "facet connectivity count")?;
    let cell_marker_count = checked_u32_len(mesh.element_markers.len(), "cell marker count")?;
    let facet_marker_count = checked_u32_len(mesh.boundary_markers.len(), "facet marker count")?;
    let cell_global_ordinal_count = checked_u32_len(
        mesh.cells.global_ordinals.len(),
        "cell global ordinal count",
    )?;
    let facet_global_ordinal_count = checked_u32_len(
        mesh.facets.global_ordinals.len(),
        "facet global ordinal count",
    )?;

    if mesh
        .nodes
        .iter()
        .flatten()
        .any(|coordinate| !coordinate.is_finite())
    {
        return Err("FMMT v2 nodes contain non-finite coordinates".to_string());
    }
    validate_connectivity(
        "cell",
        &mesh.cells.types,
        &mesh.cells.offsets,
        &mesh.cells.nodes,
        mesh.nodes.len(),
        fullmag_ir::FemCellTypeIR::arity,
    )?;
    validate_connectivity(
        "facet",
        &mesh.facets.types,
        &mesh.facets.offsets,
        &mesh.facets.nodes,
        mesh.nodes.len(),
        fullmag_ir::FemFacetTypeIR::arity,
    )?;
    if !mesh.cells.global_ordinals.is_empty()
        && mesh.cells.global_ordinals.len() != mesh.cells.types.len()
    {
        return Err(format!(
            "FMMT v2 cell global ordinal count mismatch: expected zero or {}, got {}",
            mesh.cells.types.len(),
            mesh.cells.global_ordinals.len()
        ));
    }
    if !mesh.cells.mesh_parts.is_empty() && mesh.cells.mesh_parts.len() != mesh.cells.types.len() {
        return Err(format!(
            "FMMT v2 cell mesh-part count mismatch: expected zero or {}, got {}",
            mesh.cells.types.len(),
            mesh.cells.mesh_parts.len()
        ));
    }
    if mesh.facets.roles.len() != mesh.facets.types.len() {
        return Err(format!(
            "FMMT v2 facet role count mismatch: expected {}, got {}",
            mesh.facets.types.len(),
            mesh.facets.roles.len()
        ));
    }
    if !mesh.facets.global_ordinals.is_empty()
        && mesh.facets.global_ordinals.len() != mesh.facets.types.len()
    {
        return Err(format!(
            "FMMT v2 facet global ordinal count mismatch: expected zero or {}, got {}",
            mesh.facets.types.len(),
            mesh.facets.global_ordinals.len()
        ));
    }
    validate_optional_markers("cell", mesh.element_markers.len(), mesh.cells.types.len())?;
    validate_optional_markers(
        "facet",
        mesh.boundary_markers.len(),
        mesh.facets.types.len(),
    )?;

    let mut section_lengths = vec![
        (mesh.nodes.len(), 3 * std::mem::size_of::<f64>()),
        (mesh.cells.types.len(), std::mem::size_of::<u32>()),
        (mesh.cells.offsets.len(), std::mem::size_of::<u32>()),
        (mesh.cells.nodes.len(), std::mem::size_of::<u32>()),
        (mesh.facets.types.len(), std::mem::size_of::<u32>()),
        (mesh.facets.roles.len(), std::mem::size_of::<u32>()),
        (mesh.facets.offsets.len(), std::mem::size_of::<u32>()),
        (mesh.facets.nodes.len(), std::mem::size_of::<u32>()),
        (mesh.element_markers.len(), std::mem::size_of::<u32>()),
        (mesh.boundary_markers.len(), std::mem::size_of::<u32>()),
    ];
    if !mesh.cells.global_ordinals.is_empty() {
        section_lengths.push((mesh.cells.global_ordinals.len(), std::mem::size_of::<u64>()));
    }
    if !mesh.facets.global_ordinals.is_empty() {
        section_lengths.push((
            mesh.facets.global_ordinals.len(),
            std::mem::size_of::<u64>(),
        ));
    }
    let expected_byte_len = checked_fem_mesh_topology_binary_v2_len(&section_lengths)?;

    let mut out = Vec::with_capacity(expected_byte_len);
    out.extend_from_slice(b"FMMT");
    out.push(FEM_MESH_TOPOLOGY_BINARY_V2_VERSION);
    out.push(FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32);
    out.extend_from_slice(&0u16.to_le_bytes());
    for count in [
        node_count,
        cell_count,
        facet_count,
        cell_connectivity_count,
        facet_connectivity_count,
        cell_marker_count,
        facet_marker_count,
    ] {
        out.extend_from_slice(&count.to_le_bytes());
    }
    out.extend_from_slice(&(FEM_MESH_TOPOLOGY_BINARY_V2_HEADER_LEN as u32).to_le_bytes());
    out.extend_from_slice(&cell_global_ordinal_count.to_le_bytes());
    out.extend_from_slice(&facet_global_ordinal_count.to_le_bytes());
    out.resize(FEM_MESH_TOPOLOGY_BINARY_V2_HEADER_LEN, 0);

    pad_to_eight(&mut out);
    for node in &mesh.nodes {
        write_f64_values(&mut out, node);
    }
    pad_to_eight(&mut out);
    write_u32_values(
        &mut out,
        &mesh
            .cells
            .types
            .iter()
            .copied()
            .map(fem_cell_type_code)
            .collect::<Vec<_>>(),
    );
    pad_to_eight(&mut out);
    write_u32_values(&mut out, &mesh.cells.offsets);
    pad_to_eight(&mut out);
    write_u32_values(&mut out, &mesh.cells.nodes);
    pad_to_eight(&mut out);
    write_u32_values(
        &mut out,
        &mesh
            .facets
            .types
            .iter()
            .copied()
            .map(fem_facet_type_code)
            .collect::<Vec<_>>(),
    );
    pad_to_eight(&mut out);
    write_u32_values(
        &mut out,
        &mesh
            .facets
            .roles
            .iter()
            .copied()
            .map(fem_facet_role_code)
            .collect::<Vec<_>>(),
    );
    pad_to_eight(&mut out);
    write_u32_values(&mut out, &mesh.facets.offsets);
    pad_to_eight(&mut out);
    write_u32_values(&mut out, &mesh.facets.nodes);
    pad_to_eight(&mut out);
    write_u32_values(&mut out, &mesh.element_markers);
    pad_to_eight(&mut out);
    write_u32_values(&mut out, &mesh.boundary_markers);
    if !mesh.cells.global_ordinals.is_empty() {
        pad_to_eight(&mut out);
        write_u64_values(&mut out, &mesh.cells.global_ordinals);
    }
    if !mesh.facets.global_ordinals.is_empty() {
        pad_to_eight(&mut out);
        write_u64_values(&mut out, &mesh.facets.global_ordinals);
    }

    debug_assert_eq!(out.len(), expected_byte_len);

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        checked_fem_mesh_topology_binary_v2_len, serialize_fem_mesh_topology_binary_v2,
        serialize_field_vector_binary_v2, serialize_field_vector_binary_v3,
        FieldVectorBinaryMetadata, FieldVectorIndexing,
    };

    fn mixed_topology_mesh() -> fullmag_runner::FemMeshPayload {
        fullmag_runner::FemMeshPayload {
            mesh_name: "mixed".to_string(),
            mesh_id: "mixed:1".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
                [0.0, 1.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR {
                types: vec![
                    fullmag_ir::FemCellTypeIR::Tet4,
                    fullmag_ir::FemCellTypeIR::Prism6,
                    fullmag_ir::FemCellTypeIR::Pyramid5,
                    fullmag_ir::FemCellTypeIR::Hex8,
                ],
                offsets: vec![0, 4, 10, 15, 23],
                nodes: vec![
                    0, 1, 2, 4, 0, 1, 2, 4, 5, 6, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 5, 6, 7,
                ],
                global_ordinals: vec![10, 11, 9_007_199_254_740_993, u64::MAX],
                mesh_parts: Vec::new(),
            },
            element_markers: vec![1, 2, 3, 4],
            facets: fullmag_ir::FemFacetConnectivityIR {
                types: vec![
                    fullmag_ir::FemFacetTypeIR::Tri3,
                    fullmag_ir::FemFacetTypeIR::Quad4,
                    fullmag_ir::FemFacetTypeIR::Tri3,
                ],
                roles: vec![
                    fullmag_ir::FemFacetRoleIR::Exterior,
                    fullmag_ir::FemFacetRoleIR::MaterialInterface,
                    fullmag_ir::FemFacetRoleIR::PeriodicSeam,
                ],
                offsets: vec![0, 3, 7, 10],
                nodes: vec![0, 1, 2, 0, 1, 5, 4, 4, 5, 6],
                global_ordinals: vec![20, 9_007_199_254_740_995, u64::MAX],
            },
            boundary_markers: vec![5, 6, 7],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some("mixed-generation".to_string()),
            per_domain_quality: Default::default(),
            build_report: None,
        }
    }

    #[test]
    fn fem_mesh_topology_v2_encodes_mixed_csr_sections_and_codes() {
        let binary = serialize_fem_mesh_topology_binary_v2(&mixed_topology_mesh())
            .expect("mixed FMMT v2 payload should serialize");

        assert_eq!(&binary[0..4], b"FMMT");
        assert_eq!(binary[4], 2);
        assert_eq!(binary[5], 1);
        assert_eq!(u32::from_le_bytes(binary[8..12].try_into().unwrap()), 8);
        assert_eq!(u32::from_le_bytes(binary[12..16].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(binary[16..20].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(binary[20..24].try_into().unwrap()), 23);
        assert_eq!(u32::from_le_bytes(binary[24..28].try_into().unwrap()), 10);
        assert_eq!(u32::from_le_bytes(binary[28..32].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(binary[32..36].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(binary[36..40].try_into().unwrap()), 64);
        assert_eq!(u32::from_le_bytes(binary[40..44].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(binary[44..48].try_into().unwrap()), 3);
        assert!(binary[48..64].iter().all(|value| *value == 0));

        assert_eq!(
            &binary[256..272],
            &[1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0]
        );
        assert_eq!(
            &binary[272..292],
            &[0, 0, 0, 0, 4, 0, 0, 0, 10, 0, 0, 0, 15, 0, 0, 0, 23, 0, 0, 0]
        );
        assert_eq!(&binary[392..404], &[1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(&binary[408..420], &[1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);
        assert_eq!(u64::from_le_bytes(binary[512..520].try_into().unwrap()), 10,);
        assert_eq!(
            u64::from_le_bytes(binary[528..536].try_into().unwrap()),
            9_007_199_254_740_993,
        );
        assert_eq!(
            u64::from_le_bytes(binary[536..544].try_into().unwrap()),
            u64::MAX,
        );
        assert_eq!(
            u64::from_le_bytes(binary[552..560].try_into().unwrap()),
            9_007_199_254_740_995,
        );
        assert_eq!(
            u64::from_le_bytes(binary[560..568].try_into().unwrap()),
            u64::MAX,
        );
        assert_eq!(binary.len(), 568);
    }

    #[test]
    fn fem_mesh_topology_v2_rejects_malformed_csr_and_metadata() {
        let mut bad_offsets = mixed_topology_mesh();
        bad_offsets.cells.offsets[2] = 3;
        let error = serialize_fem_mesh_topology_binary_v2(&bad_offsets)
            .expect_err("non-monotonic CSR offsets must be rejected");
        assert!(error.contains("invalid CSR range"));

        let mut missing_roles = mixed_topology_mesh();
        missing_roles.facets.roles.pop();
        let error = serialize_fem_mesh_topology_binary_v2(&missing_roles)
            .expect_err("missing facet roles must be rejected");
        assert!(error.contains("facet role count mismatch"));

        let mut legacy_ordinals = mixed_topology_mesh();
        legacy_ordinals.cells.global_ordinals.clear();
        legacy_ordinals.facets.global_ordinals.clear();
        let binary = serialize_fem_mesh_topology_binary_v2(&legacy_ordinals)
            .expect("legacy empty global ordinal vectors remain legal");
        assert_eq!(u32::from_le_bytes(binary[40..44].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(binary[44..48].try_into().unwrap()), 0);
        assert_eq!(binary.len(), 508);
    }

    #[test]
    fn fem_mesh_topology_v2_rejects_oversized_payload_before_allocation() {
        let error = checked_fem_mesh_topology_binary_v2_len(&[(usize::MAX, 24)])
            .expect_err("oversized topology must reject before allocation");

        assert!(error.contains("byte length overflow") || error.contains("byte limit"));
    }

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
