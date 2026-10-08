//! Binary serializers used by the resource-first data plane.

const FIELD_VECTOR_BINARY_HEADER_LEN: usize = 48;
const FIELD_VECTOR_BINARY_VERSION: u8 = 2;
const FIELD_VECTOR_BINARY_VERSION_V3: u8 = 3;
const FIELD_VECTOR_BINARY_VERSION_V4: u8 = 4;
const FIELD_VECTOR_BINARY_VERSION_V5: u8 = 5;
const FIELD_VECTOR_BINARY_KIND_F64: u8 = 1;
const FIELD_VECTOR_BINARY_QUANTITY_ID_LEN: usize = 16;
const FIELD_VECTOR_METADATA_FIXED_LEN: usize = 68;
const FIELD_VECTOR_METADATA_VERSION: u16 = 2;
const FIELD_VECTOR_METADATA_V4_FIXED_LEN: usize = 80;
const FIELD_VECTOR_METADATA_V4_VERSION: u16 = 3;
const FIELD_VECTOR_METADATA_V5_FIXED_LEN: usize = 88;
const FIELD_VECTOR_METADATA_V5_VERSION: u16 = 4;
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
    pub domain_generation_id: &'a str,
    pub mesh_topology_revision: u64,
    pub mesh_topology_hash: [u8; 32],
    pub scope_kind: &'a str,
    pub scope_id: &'a str,
    pub indexing: FieldVectorIndexing,
    pub node_indices: &'a [u32],
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FieldVectorBinaryMetadataV4<'a> {
    pub domain_generation_id: &'a str,
    pub mesh_topology_revision: u64,
    pub mesh_topology_hash: [u8; 32],
    pub scope_kind: &'a str,
    pub scope_id: &'a str,
    pub indexing: FieldVectorIndexing,
    pub node_indices: &'a [u32],
    pub source_kind: &'a str,
    pub source_id: &'a str,
    pub source_revision: u64,
    pub field_generation_id: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FieldVectorSourceMetadata<'a> {
    pub source_kind: &'a str,
    pub source_id: &'a str,
    pub source_revision: u64,
    pub field_generation_id: &'a str,
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

pub(crate) fn serialize_field_vector_binary_v4(
    quantity_id: &str,
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
    metadata: &FieldVectorBinaryMetadataV4<'_>,
) -> Result<Vec<u8>, String> {
    validate_field_vector_payload(n_comp, grid, values)?;
    validate_indexing(
        point_count(values, n_comp),
        metadata.indexing,
        metadata.node_indices,
        4,
    )?;
    let metadata_block = encode_field_vector_metadata_v4(metadata)?;
    let mut out = Vec::with_capacity(
        FIELD_VECTOR_BINARY_HEADER_LEN + metadata_block.len() + values.len() * 8,
    );
    write_field_vector_header(
        &mut out,
        FIELD_VECTOR_BINARY_VERSION_V4,
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

pub(crate) fn serialize_field_vector_binary_v5(
    quantity_id: &str,
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
    metadata: &FieldVectorBinaryMetadata<'_>,
    source: Option<&FieldVectorSourceMetadata<'_>>,
) -> Result<Vec<u8>, String> {
    validate_field_vector_payload(n_comp, grid, values)?;
    validate_indexing(
        point_count(values, n_comp),
        metadata.indexing,
        metadata.node_indices,
        FIELD_VECTOR_BINARY_VERSION_V5,
    )?;

    let quantity_id_bytes = quantity_id.as_bytes();
    if quantity_id_bytes.is_empty()
        || quantity_id_bytes.len() > u16::MAX as usize
        || quantity_id.chars().any(char::is_control)
    {
        return Err(
            "FMVP v5 full quantity id must be non-empty, contain no control characters, and fit u16 bytes"
                .to_string(),
        );
    }
    if values.len() > u32::MAX as usize {
        return Err("FMVP v5 value count exceeds u32 header capacity".to_string());
    }

    let scope_kind = metadata.scope_kind.as_bytes();
    let scope_id = metadata.scope_id.as_bytes();
    let domain_generation_id = metadata.domain_generation_id.as_bytes();
    for (value, label, required) in [
        (scope_kind, "scope_kind", false),
        (scope_id, "scope_id", false),
        (domain_generation_id, "domain_generation_id", true),
    ] {
        if (required && value.is_empty()) || value.len() > u16::MAX as usize {
            return Err(format!("FMVP v5 {label} must fit a non-empty u16 string"));
        }
    }

    let (source_kind, source_id, source_revision, field_generation_id) =
        if let Some(source) = source {
            let source_kind = source.source_kind.as_bytes();
            let source_id = source.source_id.as_bytes();
            let field_generation_id = source.field_generation_id.as_bytes();
            for (value, label) in [
                (source_kind, "source_kind"),
                (source_id, "source_id"),
                (field_generation_id, "field_generation_id"),
            ] {
                if value.is_empty() || value.len() > u16::MAX as usize {
                    return Err(format!("FMVP v5 {label} must fit a non-empty u16 string"));
                }
            }
            if !matches!(source.source_kind, "live" | "observation_frame") {
                return Err("FMVP v5 source_kind must be live or observation_frame".to_string());
            }
            (
                source_kind,
                source_id,
                source.source_revision,
                field_generation_id,
            )
        } else {
            (&[][..], &[][..], 0, &[][..])
        };

    if metadata.node_indices.len() > u32::MAX as usize {
        return Err("FMVP v5 node_indices exceeds u32 length".to_string());
    }
    if metadata.indexing == FieldVectorIndexing::LegacyCountOnly
        && (metadata.mesh_topology_revision != 0
            || metadata.mesh_topology_hash != [0; 32]
            || !metadata.node_indices.is_empty())
    {
        return Err(
            "FMVP v5 legacy_count_only requires absent topology (zero revision/hash) and no node indices"
                .to_string(),
        );
    }

    let node_indices_bytes = metadata
        .node_indices
        .len()
        .checked_mul(std::mem::size_of::<u32>())
        .ok_or_else(|| "FMVP v5 node_indices byte length overflows usize".to_string())?;
    let raw_len = [
        FIELD_VECTOR_METADATA_V5_FIXED_LEN,
        scope_kind.len(),
        scope_id.len(),
        domain_generation_id.len(),
        source_kind.len(),
        source_id.len(),
        field_generation_id.len(),
        quantity_id_bytes.len(),
        node_indices_bytes,
    ]
    .into_iter()
    .try_fold(0usize, usize::checked_add)
    .ok_or_else(|| "FMVP v5 metadata byte length overflows usize".to_string())?;
    let metadata_len = raw_len
        .checked_add(7)
        .map(|value| value & !7)
        .ok_or_else(|| "FMVP v5 aligned metadata byte length overflows usize".to_string())?;
    let metadata_len_u32 = u32::try_from(metadata_len)
        .map_err(|_| "FMVP v5 metadata byte length exceeds u32 capacity".to_string())?;
    let output_capacity = FIELD_VECTOR_BINARY_HEADER_LEN
        .checked_add(metadata_len)
        .and_then(|length| {
            values
                .len()
                .checked_mul(std::mem::size_of::<f64>())
                .and_then(|value_bytes| length.checked_add(value_bytes))
        })
        .ok_or_else(|| "FMVP v5 output byte length overflows usize".to_string())?;

    let mut metadata_block = Vec::with_capacity(metadata_len);
    metadata_block.extend_from_slice(b"FMMI");
    metadata_block.extend_from_slice(&FIELD_VECTOR_METADATA_V5_VERSION.to_le_bytes());
    metadata_block.extend_from_slice(&0u16.to_le_bytes());
    metadata_block.extend_from_slice(&(domain_generation_id.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&(source_kind.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&(source_id.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&(field_generation_id.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&metadata.mesh_topology_revision.to_le_bytes());
    metadata_block.extend_from_slice(&metadata.mesh_topology_hash);
    metadata_block.extend_from_slice(&metadata.indexing.code().to_le_bytes());
    metadata_block.extend_from_slice(&(metadata.node_indices.len() as u32).to_le_bytes());
    metadata_block.extend_from_slice(&(scope_kind.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&(scope_id.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&source_revision.to_le_bytes());
    metadata_block.extend_from_slice(&[0u8; 4]);
    metadata_block.extend_from_slice(&(quantity_id_bytes.len() as u16).to_le_bytes());
    metadata_block.extend_from_slice(&[0u8; 6]);
    debug_assert_eq!(metadata_block.len(), FIELD_VECTOR_METADATA_V5_FIXED_LEN);
    metadata_block.extend_from_slice(scope_kind);
    metadata_block.extend_from_slice(scope_id);
    metadata_block.extend_from_slice(domain_generation_id);
    metadata_block.extend_from_slice(source_kind);
    metadata_block.extend_from_slice(source_id);
    metadata_block.extend_from_slice(field_generation_id);
    metadata_block.extend_from_slice(quantity_id_bytes);
    for node_index in metadata.node_indices {
        metadata_block.extend_from_slice(&node_index.to_le_bytes());
    }
    metadata_block.resize(metadata_len, 0);

    let mut out = Vec::with_capacity(output_capacity);
    write_field_vector_header(
        &mut out,
        FIELD_VECTOR_BINARY_VERSION_V5,
        n_comp,
        metadata_len_u32 as usize,
        values.len(),
        grid,
        quantity_id,
    );
    out.extend_from_slice(&metadata_block);
    debug_assert_eq!(out.len() % 8, 0);
    write_f64_values(&mut out, values);
    Ok(out)
}

fn point_count(values: &[f64], n_comp: usize) -> usize {
    values.len() / n_comp
}

fn validate_indexing(
    point_count: usize,
    indexing: FieldVectorIndexing,
    node_indices: &[u32],
    version: u8,
) -> Result<(), String> {
    match indexing {
        FieldVectorIndexing::ExplicitNodeIndices | FieldVectorIndexing::SampledNodeIndices => {
            if node_indices.len() != point_count {
                return Err(format!(
                    "FMVP v{version} node_indices length mismatch: expected {point_count}, got {}",
                    node_indices.len()
                ));
            }
        }
        FieldVectorIndexing::FullDomain | FieldVectorIndexing::LegacyCountOnly => {
            if !node_indices.is_empty() {
                return Err(format!(
                    "FMVP v{version} full/legacy indexing must not include node_indices"
                ));
            }
        }
    }
    Ok(())
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
    let generation_id_bytes = metadata.domain_generation_id.as_bytes();
    if scope_kind_bytes.len() > u16::MAX as usize {
        return Err("FMVP v3 scope_kind exceeds u16 length".to_string());
    }
    if scope_id_bytes.len() > u16::MAX as usize {
        return Err("FMVP v3 scope_id exceeds u16 length".to_string());
    }
    if generation_id_bytes.is_empty() || generation_id_bytes.len() > u16::MAX as usize {
        return Err("FMVP v3 domain_generation_id must fit a non-empty u16 string".to_string());
    }
    if metadata.node_indices.len() > u32::MAX as usize {
        return Err("FMVP v3 node_indices exceeds u32 length".to_string());
    }

    let raw_len = FIELD_VECTOR_METADATA_FIXED_LEN
        + scope_kind_bytes.len()
        + scope_id_bytes.len()
        + generation_id_bytes.len()
        + metadata.node_indices.len() * std::mem::size_of::<u32>();
    let metadata_len = align_to_eight(raw_len);
    let mut out = Vec::with_capacity(metadata_len);
    out.extend_from_slice(b"FMMI");
    out.extend_from_slice(&FIELD_VECTOR_METADATA_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(generation_id_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0u8; 6]);
    out.extend_from_slice(&metadata.mesh_topology_revision.to_le_bytes());
    out.extend_from_slice(&metadata.mesh_topology_hash);
    out.extend_from_slice(&metadata.indexing.code().to_le_bytes());
    out.extend_from_slice(&(metadata.node_indices.len() as u32).to_le_bytes());
    out.extend_from_slice(&(scope_kind_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&(scope_id_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(scope_kind_bytes);
    out.extend_from_slice(scope_id_bytes);
    out.extend_from_slice(generation_id_bytes);
    for node_index in metadata.node_indices {
        out.extend_from_slice(&node_index.to_le_bytes());
    }
    out.resize(metadata_len, 0);
    Ok(out)
}

fn encode_field_vector_metadata_v4(
    metadata: &FieldVectorBinaryMetadataV4<'_>,
) -> Result<Vec<u8>, String> {
    let scope_kind = metadata.scope_kind.as_bytes();
    let scope_id = metadata.scope_id.as_bytes();
    let domain_generation_id = metadata.domain_generation_id.as_bytes();
    let source_kind = metadata.source_kind.as_bytes();
    let source_id = metadata.source_id.as_bytes();
    let field_generation_id = metadata.field_generation_id.as_bytes();
    for (value, label, required) in [
        (scope_kind, "scope_kind", false),
        (scope_id, "scope_id", false),
        (domain_generation_id, "domain_generation_id", true),
        (source_kind, "source_kind", true),
        (source_id, "source_id", true),
        (field_generation_id, "field_generation_id", true),
    ] {
        if (required && value.is_empty()) || value.len() > u16::MAX as usize {
            return Err(format!("FMVP v4 {label} must fit a non-empty u16 string"));
        }
    }
    if !matches!(metadata.source_kind, "live" | "observation_frame") {
        return Err("FMVP v4 source_kind must be live or observation_frame".to_string());
    }
    if metadata.node_indices.len() > u32::MAX as usize {
        return Err("FMVP v4 node_indices exceeds u32 length".to_string());
    }

    let raw_len = FIELD_VECTOR_METADATA_V4_FIXED_LEN
        + scope_kind.len()
        + scope_id.len()
        + domain_generation_id.len()
        + source_kind.len()
        + source_id.len()
        + field_generation_id.len()
        + metadata.node_indices.len() * std::mem::size_of::<u32>();
    let mut out = Vec::with_capacity(align_to_eight(raw_len));
    out.extend_from_slice(b"FMMI");
    out.extend_from_slice(&FIELD_VECTOR_METADATA_V4_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(domain_generation_id.len() as u16).to_le_bytes());
    out.extend_from_slice(&(source_kind.len() as u16).to_le_bytes());
    out.extend_from_slice(&(source_id.len() as u16).to_le_bytes());
    out.extend_from_slice(&(field_generation_id.len() as u16).to_le_bytes());
    out.extend_from_slice(&metadata.mesh_topology_revision.to_le_bytes());
    out.extend_from_slice(&metadata.mesh_topology_hash);
    out.extend_from_slice(&metadata.indexing.code().to_le_bytes());
    out.extend_from_slice(&(metadata.node_indices.len() as u32).to_le_bytes());
    out.extend_from_slice(&(scope_kind.len() as u16).to_le_bytes());
    out.extend_from_slice(&(scope_id.len() as u16).to_le_bytes());
    out.extend_from_slice(&metadata.source_revision.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    debug_assert_eq!(out.len(), FIELD_VECTOR_METADATA_V4_FIXED_LEN);
    out.extend_from_slice(scope_kind);
    out.extend_from_slice(scope_id);
    out.extend_from_slice(domain_generation_id);
    out.extend_from_slice(source_kind);
    out.extend_from_slice(source_id);
    out.extend_from_slice(field_generation_id);
    for node_index in metadata.node_indices {
        out.extend_from_slice(&node_index.to_le_bytes());
    }
    out.resize(align_to_eight(raw_len), 0);
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
        serialize_field_vector_binary_v4, serialize_field_vector_binary_v5,
        FieldVectorBinaryMetadata, FieldVectorBinaryMetadataV4, FieldVectorIndexing,
        FieldVectorSourceMetadata,
    };

    fn full_domain_v5_metadata() -> FieldVectorBinaryMetadata<'static> {
        FieldVectorBinaryMetadata {
            domain_generation_id: "sha256:domain",
            mesh_topology_revision: 17,
            mesh_topology_hash: [0xAB; 32],
            scope_kind: "full",
            scope_id: "",
            indexing: FieldVectorIndexing::FullDomain,
            node_indices: &[],
        }
    }

    fn v5_metadata_block(binary: &[u8]) -> &[u8] {
        assert_eq!(&binary[..4], b"FMVP");
        assert_eq!(binary[4], 5);
        let metadata_len = u32::from_le_bytes(binary[8..12].try_into().unwrap()) as usize;
        assert!(metadata_len >= 88);
        assert!(48 + metadata_len <= binary.len());
        let metadata = &binary[48..48 + metadata_len];
        assert_eq!(&metadata[..4], b"FMMI");
        assert_eq!(u16::from_le_bytes(metadata[4..6].try_into().unwrap()), 4);
        metadata
    }

    fn v5_full_quantity_id(binary: &[u8]) -> String {
        let metadata = v5_metadata_block(binary);
        let scope_kind_len = u16::from_le_bytes(metadata[64..66].try_into().unwrap()) as usize;
        let scope_id_len = u16::from_le_bytes(metadata[66..68].try_into().unwrap()) as usize;
        let domain_generation_id_len =
            u16::from_le_bytes(metadata[8..10].try_into().unwrap()) as usize;
        let source_kind_len = u16::from_le_bytes(metadata[10..12].try_into().unwrap()) as usize;
        let source_id_len = u16::from_le_bytes(metadata[12..14].try_into().unwrap()) as usize;
        let field_generation_id_len =
            u16::from_le_bytes(metadata[14..16].try_into().unwrap()) as usize;
        let quantity_id_len = u16::from_le_bytes(metadata[80..82].try_into().unwrap()) as usize;
        let quantity_id_start = 88
            + scope_kind_len
            + scope_id_len
            + domain_generation_id_len
            + source_kind_len
            + source_id_len
            + field_generation_id_len;
        String::from_utf8(metadata[quantity_id_start..quantity_id_start + quantity_id_len].to_vec())
            .expect("FMVP v5 full quantity id should be valid UTF-8")
    }

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
    fn field_vector_v4_embeds_exact_observation_source_identity() {
        let metadata = FieldVectorBinaryMetadataV4 {
            domain_generation_id: "sha256:domain",
            mesh_topology_revision: 17,
            mesh_topology_hash: [0xab; 32],
            scope_kind: "full",
            scope_id: "",
            indexing: FieldVectorIndexing::FullDomain,
            node_indices: &[],
            source_kind: "observation_frame",
            source_id: "frame-123",
            source_revision: 29,
            field_generation_id: "field:frame-123:m:29",
        };

        let binary =
            serialize_field_vector_binary_v4("m", 3, [1, 1, 1], &[1.0, 0.0, 0.0], &metadata)
                .expect("source-qualified FMVP v4 should serialize");

        assert_eq!(&binary[..4], b"FMVP");
        assert_eq!(binary[4], 4);
        assert_eq!(&binary[48..52], b"FMMI");
        assert_eq!(u16::from_le_bytes(binary[52..54].try_into().unwrap()), 3);
        assert_eq!(u64::from_le_bytes(binary[116..124].try_into().unwrap()), 29);
        let metadata_length = u32::from_le_bytes(binary[8..12].try_into().unwrap()) as usize;
        let metadata_text = String::from_utf8_lossy(&binary[128..48 + metadata_length]);
        assert!(metadata_text.contains("observation_frame"));
        assert!(metadata_text.contains("frame-123"));
        assert!(metadata_text.contains("field:frame-123:m:29"));
    }

    #[test]
    fn field_vector_serializer_v3_encodes_full_domain_metadata() {
        let metadata = FieldVectorBinaryMetadata {
            domain_generation_id: "42",
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
        assert_eq!(u16::from_le_bytes(binary[52..54].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(binary[56..58].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(binary[64..72].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(binary[104..108].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(binary[108..112].try_into().unwrap()), 0);
        assert_eq!(&binary[120..122], b"42");
    }

    #[test]
    fn field_vector_serializer_v3_encodes_explicit_node_indices() {
        let metadata = FieldVectorBinaryMetadata {
            domain_generation_id: "42",
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
        let node_indices_offset =
            48 + 68 + "part".len() + "part:a".len() + metadata.domain_generation_id.len();
        assert_eq!(
            &binary[node_indices_offset..node_indices_offset + 8],
            &[3, 0, 0, 0, 1, 0, 0, 0]
        );
        assert_eq!(metadata_end % 8, 0);
    }

    #[test]
    fn field_vector_serializer_v3_validates_node_indices_by_indexing() {
        let sampled = FieldVectorBinaryMetadata {
            domain_generation_id: "42",
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

    #[test]
    fn field_vector_v5_preserves_full_quantity_ids_with_colliding_legacy_prefixes() {
        let first_id = "analysis:eigen:sample-0000:mode-0000";
        let second_id = "analysis:eigen:sample-0000:mode-0001";
        assert_eq!(&first_id.as_bytes()[..16], &second_id.as_bytes()[..16]);

        let first = serialize_field_vector_binary_v5(
            first_id,
            1,
            [1, 1, 1],
            &[3.0],
            &full_domain_v5_metadata(),
            None,
        )
        .expect("FMVP v5 should preserve the first full quantity id");
        let second = serialize_field_vector_binary_v5(
            second_id,
            1,
            [1, 1, 1],
            &[4.0],
            &full_domain_v5_metadata(),
            None,
        )
        .expect("FMVP v5 should preserve the second full quantity id");

        assert_eq!(&first[28..44], &first_id.as_bytes()[..16]);
        assert_eq!(&second[28..44], &second_id.as_bytes()[..16]);
        assert_eq!(&first[28..44], &second[28..44]);
        assert_eq!(v5_full_quantity_id(&first), first_id);
        assert_eq!(v5_full_quantity_id(&second), second_id);

        let metadata = v5_metadata_block(&first);
        assert_eq!(u16::from_le_bytes(metadata[10..12].try_into().unwrap()), 0);
        assert_eq!(u16::from_le_bytes(metadata[12..14].try_into().unwrap()), 0);
        assert_eq!(u16::from_le_bytes(metadata[14..16].try_into().unwrap()), 0);
        assert_eq!(u64::from_le_bytes(metadata[68..76].try_into().unwrap()), 0);
        assert!(metadata[82..88].iter().all(|byte| *byte == 0));
        assert_eq!(metadata.len() % 8, 0);
    }

    #[test]
    fn field_vector_v5_keeps_full_utf8_identity_when_legacy_prefix_splits_codepoint() {
        let quantity_id = "123456789012345é-eigen-mode";
        let prefix = &quantity_id.as_bytes()[..16];
        assert!(std::str::from_utf8(prefix).is_err());

        let binary = serialize_field_vector_binary_v5(
            quantity_id,
            1,
            [1, 1, 1],
            &[1.0],
            &full_domain_v5_metadata(),
            None,
        )
        .expect("FMVP v5 should allow a raw legacy prefix to split UTF-8");
        assert_eq!(&binary[28..44], prefix);
        assert_eq!(v5_full_quantity_id(&binary), quantity_id);
    }

    #[test]
    fn field_vector_v5_encodes_complete_source_identity_and_rejects_partial_groups() {
        let source = FieldVectorSourceMetadata {
            source_kind: "observation_frame",
            source_id: "frame-123",
            source_revision: 29,
            field_generation_id: "field:frame-123:m:29",
        };
        let binary = serialize_field_vector_binary_v5(
            "analysis:frequency-response:frequency-0001",
            1,
            [1, 1, 1],
            &[2.0],
            &full_domain_v5_metadata(),
            Some(&source),
        )
        .expect("FMVP v5 should encode complete source provenance");
        let metadata = v5_metadata_block(&binary);
        assert_eq!(u16::from_le_bytes(metadata[10..12].try_into().unwrap()), 17);
        assert_eq!(u16::from_le_bytes(metadata[12..14].try_into().unwrap()), 9);
        assert_eq!(u16::from_le_bytes(metadata[14..16].try_into().unwrap()), 20);
        assert_eq!(u64::from_le_bytes(metadata[68..76].try_into().unwrap()), 29);

        let partial_source = FieldVectorSourceMetadata {
            source_id: "",
            ..source
        };
        let error = serialize_field_vector_binary_v5(
            "analysis:frequency-response:frequency-0001",
            1,
            [1, 1, 1],
            &[2.0],
            &full_domain_v5_metadata(),
            Some(&partial_source),
        )
        .expect_err("a partially qualified source group must be rejected");
        assert!(error.contains("source_id"));

        let unsupported_source = FieldVectorSourceMetadata {
            source_kind: "analysis",
            ..source
        };
        let error = serialize_field_vector_binary_v5(
            "analysis:frequency-response:frequency-0001",
            1,
            [1, 1, 1],
            &[2.0],
            &full_domain_v5_metadata(),
            Some(&unsupported_source),
        )
        .expect_err("FMVP v5 must retain the v4 source-kind vocabulary");
        assert!(error.contains("source_kind"));
    }

    #[test]
    fn field_vector_v5_requires_valid_full_quantity_identity_and_finite_values() {
        let metadata = full_domain_v5_metadata();
        for invalid_id in ["", "bad\0quantity", "bad\nquantity"] {
            let error =
                serialize_field_vector_binary_v5(invalid_id, 1, [1, 1, 1], &[1.0], &metadata, None)
                    .expect_err("empty and control-containing full quantity ids must reject");
            assert!(error.contains("full quantity id"));
        }

        let oversized_id = "q".repeat(u16::MAX as usize + 1);
        let error =
            serialize_field_vector_binary_v5(&oversized_id, 1, [1, 1, 1], &[1.0], &metadata, None)
                .expect_err("full quantity id length must fit in u16 bytes");
        assert!(error.contains("full quantity id"));

        let error = serialize_field_vector_binary_v5(
            "analysis:field",
            1,
            [1, 1, 1],
            &[f64::NAN],
            &metadata,
            None,
        )
        .expect_err("FMVP v5 must reject non-finite values");
        assert!(error.contains("non-finite"));
    }

    #[test]
    fn field_vector_v5_legacy_count_only_is_an_explicit_absent_topology_sentinel() {
        let absent_topology = FieldVectorBinaryMetadata {
            domain_generation_id: "fdm-domain-generation",
            mesh_topology_revision: 0,
            mesh_topology_hash: [0; 32],
            scope_kind: "full",
            scope_id: "",
            indexing: FieldVectorIndexing::LegacyCountOnly,
            node_indices: &[],
        };
        let binary = serialize_field_vector_binary_v5(
            "analysis:frequency-response:frequency-0001",
            1,
            [1, 1, 1],
            &[1.0],
            &absent_topology,
            None,
        )
        .expect("the explicit absent-topology sentinel should serialize");
        let metadata = v5_metadata_block(&binary);
        assert_eq!(u64::from_le_bytes(metadata[16..24].try_into().unwrap()), 0);
        assert!(metadata[24..56].iter().all(|byte| *byte == 0));
        assert_eq!(u32::from_le_bytes(metadata[56..60].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(metadata[60..64].try_into().unwrap()), 0);
        assert_eq!(u64::from_le_bytes(metadata[68..76].try_into().unwrap()), 0);

        let fabricated_topology = FieldVectorBinaryMetadata {
            mesh_topology_revision: 1,
            ..absent_topology
        };
        let error = serialize_field_vector_binary_v5(
            "analysis:frequency-response:frequency-0001",
            1,
            [1, 1, 1],
            &[1.0],
            &fabricated_topology,
            None,
        )
        .expect_err("legacy count-only may not claim a topology revision");
        assert!(error.contains("absent topology"));

        let fabricated_hash = FieldVectorBinaryMetadata {
            mesh_topology_hash: [1; 32],
            ..absent_topology
        };
        let error = serialize_field_vector_binary_v5(
            "analysis:frequency-response:frequency-0001",
            1,
            [1, 1, 1],
            &[1.0],
            &fabricated_hash,
            None,
        )
        .expect_err("legacy count-only may not claim a topology hash");
        assert!(error.contains("absent topology"));
    }
}
