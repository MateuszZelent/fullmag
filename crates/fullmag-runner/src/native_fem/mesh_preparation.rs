use super::PackedNativeMesh;
use fullmag_fem_sys as ffi;
use fullmag_plan::NativeFemMeshSpaceEvidence;
use sha2::{Digest, Sha256};
use std::ffi::c_char;

const TOPOLOGY_DIGEST_SCHEMA: &str = "mfem_mesh_space.topology.v1";
const MARKER_MAP_DIGEST_SCHEMA: &str = "mfem_mesh_space.marker_map.v1";

pub fn prepare_fem_mesh_space(
    mesh: &fullmag_ir::MeshIR,
    fe_order: u32,
) -> Result<NativeFemMeshSpaceEvidence, String> {
    let packed = PackedNativeMesh::new(mesh);
    let descriptor = packed.descriptor(mesh);
    let expected_topology = topology_fingerprint(mesh)?;
    let expected_markers = marker_map_fingerprint(mesh)?;
    let request = ffi::fullmag_fem_mesh_space_preparation_request_v1 {
        abi_version: ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_mesh_space_preparation_request_v1>()
            as u32,
        mesh: &descriptor,
        fe_order,
        reserved_flags: 0,
    };
    let mut evidence = empty_evidence();
    let mut error = [0 as c_char; 512];
    let status = unsafe {
        ffi::fullmag_fem_prepare_mesh_space_v1(
            &request,
            &mut evidence,
            error.as_mut_ptr(),
            error.len() as u64,
        )
    };
    if status != ffi::FULLMAG_FEM_OK {
        let message = error
            .iter()
            .take_while(|byte| **byte != 0)
            .map(|byte| *byte as u8)
            .collect::<Vec<_>>();
        let message = String::from_utf8_lossy(&message);
        return Err(if message.is_empty() {
            format!("native FEM mesh-space producer failed with status {status}")
        } else {
            format!("native FEM mesh-space producer failed: {message}")
        });
    }

    if evidence.abi_version != ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION
        || evidence.struct_size as usize
            != std::mem::size_of::<ffi::fullmag_fem_mesh_space_preparation_evidence_v1>()
    {
        return Err("native FEM mesh-space producer returned an incompatible ABI record".into());
    }
    if evidence.mesh_dimension != 3
        || evidence.fe_family != ffi::FULLMAG_FEM_FE_FAMILY_H1
        || evidence.fe_order != fe_order
        || evidence.mesh_matches_canonical_input != 1
    {
        return Err(
            "native FEM mesh-space producer returned mismatched mesh or FE identity".into(),
        );
    }
    if evidence.node_count != mesh.nodes.len() as u64
        || evidence.cell_count != mesh.cells.types.len() as u64
        || evidence.boundary_element_count == 0
        || evidence.local_dof_count == 0
        || evidence.true_dof_count == 0
        || evidence.true_dof_count > evidence.local_dof_count
        || evidence.local_dof_count != evidence.node_count
        || evidence.true_dof_count != evidence.node_count
    {
        return Err(
            "native FEM mesh-space producer returned inconsistent mesh or DOF counts".into(),
        );
    }
    if evidence.invalid_cell_count != 0
        || evidence.quality_sample_count == 0
        || !evidence.min_jacobian_determinant.is_finite()
        || evidence.min_jacobian_determinant <= 0.0
        || !evidence.max_jacobian_determinant.is_finite()
        || evidence.max_jacobian_determinant < evidence.min_jacobian_determinant
    {
        return Err(
            "native FEM mesh-space producer returned invalid Jacobian quality evidence".into(),
        );
    }

    let topology = read_fingerprint(&evidence.topology_fingerprint, "topology")?;
    let markers = read_fingerprint(&evidence.marker_map_fingerprint, "marker map")?;
    let quality = read_fingerprint(&evidence.quality_fingerprint, "quality")?;
    let space = read_fingerprint(&evidence.space_fingerprint, "space")?;
    if topology != expected_topology || markers != expected_markers {
        return Err(
            "native FEM fingerprints do not match the independently encoded canonical mesh".into(),
        );
    }

    Ok(NativeFemMeshSpaceEvidence {
        abi_version: evidence.abi_version,
        producer_id: ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_PRODUCER_ID.into(),
        schema_version: ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_SCHEMA_VERSION.into(),
        producer_version: ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_PRODUCER_VERSION.into(),
        mesh_matches_canonical_input: true,
        canonical_mesh_fingerprint: normalize_sha256(&mesh.topology_fingerprint_v6()),
        topology_fingerprint: topology,
        marker_map_fingerprint: markers,
        quality_fingerprint: quality,
        space_fingerprint: space,
        mesh_dimension: evidence.mesh_dimension,
        fe_family: "H1".into(),
        fe_order: evidence.fe_order,
        node_count: evidence.node_count,
        cell_count: evidence.cell_count,
        boundary_element_count: evidence.boundary_element_count,
        local_dof_count: evidence.local_dof_count,
        true_dof_count: evidence.true_dof_count,
        quality_sample_count: evidence.quality_sample_count,
        invalid_cell_count: evidence.invalid_cell_count,
        min_jacobian_determinant: evidence.min_jacobian_determinant,
        max_jacobian_determinant: evidence.max_jacobian_determinant,
    })
}

fn empty_evidence() -> ffi::fullmag_fem_mesh_space_preparation_evidence_v1 {
    ffi::fullmag_fem_mesh_space_preparation_evidence_v1 {
        abi_version: ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_mesh_space_preparation_evidence_v1>()
            as u32,
        mesh_dimension: 0,
        fe_family: 0,
        fe_order: 0,
        mesh_matches_canonical_input: 0,
        node_count: 0,
        cell_count: 0,
        boundary_element_count: 0,
        local_dof_count: 0,
        true_dof_count: 0,
        quality_sample_count: 0,
        invalid_cell_count: 0,
        min_jacobian_determinant: 0.0,
        max_jacobian_determinant: 0.0,
        topology_fingerprint: [0; ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY],
        marker_map_fingerprint: [0; ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY],
        quality_fingerprint: [0; ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY],
        space_fingerprint: [0; ffi::FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY],
    }
}

fn read_fingerprint(value: &[c_char; 65], label: &str) -> Result<String, String> {
    let bytes = value
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    let hex = std::str::from_utf8(&bytes)
        .map_err(|_| format!("native FEM {label} fingerprint is not ASCII"))?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("native FEM {label} fingerprint is malformed"));
    }
    Ok(format!("sha256:{hex}"))
}

fn normalize_sha256(value: &str) -> String {
    if value.starts_with("sha256:") {
        value.to_owned()
    } else {
        format!("sha256:{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tetrahedron_mesh() -> fullmag_ir::MeshIR {
        fullmag_ir::MeshIR::from_legacy_tet4(
            "mesh-space-preparation-contract".into(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            vec![[0, 1, 2, 3]],
            vec![3],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            std::collections::HashMap::new(),
        )
    }

    #[test]
    fn runner_preparation_exercises_native_mesh_space_abi() {
        let mesh = tetrahedron_mesh();
        let evidence = prepare_fem_mesh_space(&mesh, 1)
            .expect("native producer should return evidence for a valid Tet4 H1 P1 mesh");

        assert!(evidence.mesh_matches_canonical_input);
        assert_eq!(
            evidence.canonical_mesh_fingerprint,
            mesh.topology_fingerprint_v6()
        );
        assert_eq!(evidence.mesh_dimension, 3);
        assert_eq!(evidence.fe_family, "H1");
        assert_eq!(evidence.fe_order, 1);
        assert_eq!(evidence.node_count, 4);
        assert_eq!(evidence.cell_count, 1);
        assert_eq!(evidence.boundary_element_count, 4);
        assert_eq!(evidence.local_dof_count, 4);
        assert_eq!(evidence.true_dof_count, 4);
        assert!(evidence.quality_sample_count > 0);
        assert_eq!(evidence.invalid_cell_count, 0);
        assert!(evidence.min_jacobian_determinant > 0.0);
        for fingerprint in [
            &evidence.topology_fingerprint,
            &evidence.marker_map_fingerprint,
            &evidence.quality_fingerprint,
            &evidence.space_fingerprint,
        ] {
            assert!(fingerprint.starts_with("sha256:"));
            assert_eq!(fingerprint.len(), 71);
        }

        let error = prepare_fem_mesh_space(&mesh, 2)
            .expect_err("native producer must reject unsupported H1 P2");
        assert!(error.contains("native FEM mesh-space producer failed"));
    }
}

struct CanonicalDigest {
    payload: Vec<u8>,
}

impl CanonicalDigest {
    fn new(schema: &str) -> Self {
        let mut digest = Self {
            payload: Vec::new(),
        };
        digest.add_string("schema", schema);
        digest
    }

    fn add_field(&mut self, name: &str, kind: u8, value: &[u8]) {
        self.payload
            .extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(name.as_bytes());
        self.payload.push(kind);
        self.payload
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(value);
    }

    fn add_string(&mut self, name: &str, value: &str) {
        self.add_field(name, 1, value.as_bytes());
    }

    fn add_u64(&mut self, name: &str, value: u64) {
        self.add_field(name, 2, &value.to_be_bytes());
    }

    fn add_bytes(&mut self, name: &str, value: &[u8]) {
        self.add_field(name, 3, value);
    }

    fn finish(self) -> String {
        format!("sha256:{:x}", Sha256::digest(self.payload))
    }
}

fn packed_u32(values: impl IntoIterator<Item = u32>) -> Vec<u8> {
    values.into_iter().flat_map(u32::to_be_bytes).collect()
}

fn packed_u64(values: impl IntoIterator<Item = u64>) -> Vec<u8> {
    values.into_iter().flat_map(u64::to_be_bytes).collect()
}

fn topology_fingerprint(mesh: &fullmag_ir::MeshIR) -> Result<String, String> {
    let mut digest = CanonicalDigest::new(TOPOLOGY_DIGEST_SCHEMA);
    digest.add_u64("node_count", mesh.nodes.len() as u64);
    digest.add_u64("cell_count", mesh.cells.types.len() as u64);
    digest.add_u64("facet_count", mesh.facets.types.len() as u64);
    let mut nodes = Vec::with_capacity(mesh.nodes.len() * 24);
    for node in &mesh.nodes {
        for coordinate in node {
            let value = if *coordinate == 0.0 { 0.0 } else { *coordinate };
            nodes.extend_from_slice(&value.to_bits().to_be_bytes());
        }
    }
    digest.add_bytes("nodes_xyz_be", &nodes);
    let cell_types = mesh.cells.types.iter().map(|kind| match kind {
        fullmag_ir::FemCellTypeIR::Tet4 => ffi::FULLMAG_FEM_CELL_TET4,
        fullmag_ir::FemCellTypeIR::Prism6 => ffi::FULLMAG_FEM_CELL_PRISM6,
        fullmag_ir::FemCellTypeIR::Pyramid5 => ffi::FULLMAG_FEM_CELL_PYRAMID5,
        fullmag_ir::FemCellTypeIR::Hex8 => ffi::FULLMAG_FEM_CELL_HEX8,
    });
    digest.add_bytes("cell_types_be", &packed_u32(cell_types));
    digest.add_bytes(
        "cell_offsets_be",
        &packed_u32(mesh.cells.offsets.iter().copied()),
    );
    digest.add_bytes(
        "cell_nodes_be",
        &packed_u32(mesh.cells.nodes.iter().copied()),
    );
    digest.add_bytes(
        "cell_global_ordinals_be",
        &packed_u64(mesh.cells.global_ordinals.iter().copied()),
    );
    let facet_types = mesh.facets.types.iter().map(|kind| match kind {
        fullmag_ir::FemFacetTypeIR::Tri3 => ffi::FULLMAG_FEM_FACET_TRI3,
        fullmag_ir::FemFacetTypeIR::Quad4 => ffi::FULLMAG_FEM_FACET_QUAD4,
    });
    digest.add_bytes("facet_types_be", &packed_u32(facet_types));
    let facet_roles = mesh.facets.roles.iter().map(|role| match role {
        fullmag_ir::FemFacetRoleIR::Exterior => ffi::FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        fullmag_ir::FemFacetRoleIR::MaterialInterface => {
            ffi::FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE
        }
        fullmag_ir::FemFacetRoleIR::PeriodicSeam => ffi::FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
    });
    digest.add_bytes("facet_roles_be", &packed_u32(facet_roles));
    digest.add_bytes(
        "facet_offsets_be",
        &packed_u32(mesh.facets.offsets.iter().copied()),
    );
    digest.add_bytes(
        "facet_nodes_be",
        &packed_u32(mesh.facets.nodes.iter().copied()),
    );
    digest.add_bytes(
        "facet_global_ordinals_be",
        &packed_u64(mesh.facets.global_ordinals.iter().copied()),
    );
    digest.add_bytes(
        "periodic_node_pairs_be",
        &packed_u32(
            mesh.periodic_node_pairs
                .iter()
                .flat_map(|pair| [pair.node_a, pair.node_b]),
        ),
    );
    Ok(digest.finish())
}

fn marker_map_fingerprint(mesh: &fullmag_ir::MeshIR) -> Result<String, String> {
    if mesh.cells.global_ordinals.len() != mesh.element_markers.len()
        || mesh.facets.global_ordinals.len() != mesh.boundary_markers.len()
        || mesh.facets.roles.len() != mesh.boundary_markers.len()
    {
        return Err("canonical mesh marker arrays do not match their ordinal topology".into());
    }
    let mut digest = CanonicalDigest::new(MARKER_MAP_DIGEST_SCHEMA);
    digest.add_u64("cell_count", mesh.cells.types.len() as u64);
    digest.add_u64("facet_count", mesh.facets.types.len() as u64);
    let mut cell_markers = Vec::with_capacity(mesh.element_markers.len() * 12);
    for (ordinal, marker) in mesh.cells.global_ordinals.iter().zip(&mesh.element_markers) {
        cell_markers.extend_from_slice(&ordinal.to_be_bytes());
        cell_markers.extend_from_slice(&marker.to_be_bytes());
    }
    digest.add_bytes("cell_ordinal_marker_pairs_be", &cell_markers);
    let mut facet_markers = Vec::with_capacity(mesh.boundary_markers.len() * 12);
    for (ordinal, marker) in mesh
        .facets
        .global_ordinals
        .iter()
        .zip(&mesh.boundary_markers)
    {
        facet_markers.extend_from_slice(&ordinal.to_be_bytes());
        facet_markers.extend_from_slice(&marker.to_be_bytes());
    }
    digest.add_bytes("facet_ordinal_marker_pairs_be", &facet_markers);
    let facet_roles = mesh.facets.roles.iter().map(|role| match role {
        fullmag_ir::FemFacetRoleIR::Exterior => ffi::FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        fullmag_ir::FemFacetRoleIR::MaterialInterface => {
            ffi::FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE
        }
        fullmag_ir::FemFacetRoleIR::PeriodicSeam => ffi::FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
    });
    digest.add_bytes("facet_roles_be", &packed_u32(facet_roles));
    digest.add_bytes(
        "periodic_boundary_pair_markers_be",
        &packed_u32(
            mesh.periodic_boundary_pairs
                .iter()
                .flat_map(|pair| [pair.marker_a, pair.marker_b]),
        ),
    );
    Ok(digest.finish())
}
