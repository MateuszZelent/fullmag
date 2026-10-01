//! Canonical MeshIR projection matching the live MFEM node/cell exporter.
//! This deliberately does not replace full topology or physics identities.

use crate::{FemCellTypeIR, FemConnectivityIR};
use fullmag_quantities::fem_native_indexed_geometry::{
    FemNativeIndexedGeometryHasher, FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES,
};

pub fn fem_native_indexed_geometry_sha256(
    nodes: &[[f64; 3]],
    cells: &FemConnectivityIR,
) -> Result<String, String> {
    let mut digest = FemNativeIndexedGeometryHasher::new(nodes.len() as u64, cells.len() as u64)?;
    if cells.offsets.len() != cells.len() + 1
        || cells.offsets.first() != Some(&0)
        || cells.offsets.last().copied().map(|length| length as usize) != Some(cells.nodes.len())
    {
        return Err("canonical geometry projection has invalid connectivity offsets".into());
    }
    for chunk in nodes.chunks(FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES) {
        digest.append_nodes(chunk)?;
    }
    let mut records = Vec::with_capacity(FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES);
    for (ordinal, cell_type) in cells.types.iter().enumerate() {
        let cell_nodes = cells
            .item_nodes(ordinal)
            .ok_or("canonical geometry projection cell range is invalid")?;
        if cell_nodes.len() != cell_type.arity() {
            return Err("canonical geometry projection cell arity is invalid".into());
        }
        let mut record = [0; 9];
        record[0] = match cell_type {
            FemCellTypeIR::Tet4 => 1,
            FemCellTypeIR::Prism6 => 2,
            FemCellTypeIR::Pyramid5 => 3,
            FemCellTypeIR::Hex8 => 4,
        };
        record[1..=cell_nodes.len()].copy_from_slice(cell_nodes);
        records.push(record);
        if records.len() == FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES {
            digest.append_cells(&records)?;
            records.clear();
        }
    }
    if !records.is_empty() {
        digest.append_cells(&records)?;
    }
    digest.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_projection_binds_coordinates_and_ordered_connectivity() {
        let nodes = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
        let cells = FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
        let original = fem_native_indexed_geometry_sha256(&nodes, &cells).unwrap();
        let mut reordered = cells.clone();
        reordered.nodes.swap(1, 2);
        assert_ne!(
            fem_native_indexed_geometry_sha256(&nodes, &reordered).unwrap(),
            original
        );
        let mut non_topological = cells.clone();
        non_topological.global_ordinals = vec![100];
        assert_eq!(
            fem_native_indexed_geometry_sha256(&nodes, &non_topological).unwrap(),
            original
        );
        let mut invalid = cells;
        invalid.offsets[1] = 3;
        assert!(fem_native_indexed_geometry_sha256(&nodes, &invalid).is_err());
    }
}
