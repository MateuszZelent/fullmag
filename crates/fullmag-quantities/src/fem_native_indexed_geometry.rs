//! Indexed node/cell projection observed from a live scalar P1 MFEM mesh.
//! The digest excludes facets, markers, periodic metadata and solver physics.

use sha2::{Digest, Sha256};

pub const FEM_NATIVE_INDEXED_GEOMETRY_SCHEMA: &str = "fullmag.fem_native_indexed_geometry.v1";
pub const FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES: usize = 4096;
pub const FEM_NATIVE_GEOMETRY_CELL_WORDS: usize = 9;
pub const MAX_FEM_NATIVE_GEOMETRY_ENTITIES: u64 = 4 * 1024 * 1024;

/// Domain-separated schema + NUL, two U64LE counts, ordered F64LE xyz,
/// then ordered cells (type U32LE + eight node U32LE slots, zero padded).
/// IEEE bits, including signed zero, are preserved; no host byte casts.
pub struct FemNativeIndexedGeometryHasher {
    digest: Sha256,
    node_count: u64,
    cell_count: u64,
    nodes_written: u64,
    cells_written: u64,
}

impl FemNativeIndexedGeometryHasher {
    pub fn new(node_count: u64, cell_count: u64) -> Result<Self, String> {
        if node_count == 0
            || cell_count == 0
            || node_count > MAX_FEM_NATIVE_GEOMETRY_ENTITIES
            || cell_count > MAX_FEM_NATIVE_GEOMETRY_ENTITIES
        {
            return Err("native indexed geometry requires positive bounded extents".into());
        }
        let mut digest = Sha256::new();
        digest.update(FEM_NATIVE_INDEXED_GEOMETRY_SCHEMA.as_bytes());
        digest.update([0]);
        digest.update(node_count.to_le_bytes());
        digest.update(cell_count.to_le_bytes());
        Ok(Self {
            digest,
            node_count,
            cell_count,
            nodes_written: 0,
            cells_written: 0,
        })
    }

    pub fn append_nodes(&mut self, nodes: &[[f64; 3]]) -> Result<(), String> {
        if nodes.is_empty()
            || nodes.len() > FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES
            || self.cells_written != 0
            || nodes.len() as u64 > self.node_count - self.nodes_written
            || nodes
                .iter()
                .flatten()
                .any(|coordinate| !coordinate.is_finite())
        {
            return Err("invalid native indexed geometry node chunk".into());
        }
        for coordinate in nodes.iter().flatten() {
            self.digest.update(coordinate.to_le_bytes());
        }
        self.nodes_written += nodes.len() as u64;
        Ok(())
    }

    pub fn append_cells(
        &mut self,
        records: &[[u32; FEM_NATIVE_GEOMETRY_CELL_WORDS]],
    ) -> Result<(), String> {
        if records.is_empty()
            || records.len() > FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES
            || self.nodes_written != self.node_count
            || records.len() as u64 > self.cell_count - self.cells_written
        {
            return Err("invalid native indexed geometry cell chunk".into());
        }
        for record in records {
            let arity = match record[0] {
                1 => 4,
                2 => 6,
                3 => 5,
                4 => 8,
                _ => return Err("unknown native indexed geometry cell type".into()),
            };
            if record[1..=arity]
                .iter()
                .any(|node| *node as u64 >= self.node_count)
                || record[arity + 1..].iter().any(|padding| *padding != 0)
            {
                return Err("invalid native indexed geometry cell index or padding".into());
            }
        }
        for word in records.iter().flatten() {
            self.digest.update(word.to_le_bytes());
        }
        self.cells_written += records.len() as u64;
        Ok(())
    }

    pub fn finish(self) -> Result<String, String> {
        if self.nodes_written != self.node_count || self.cells_written != self.cell_count {
            return Err("native indexed geometry snapshot is incomplete".into());
        }
        Ok(format!("sha256:{:x}", self.digest.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NODES: [[f64; 3]; 4] = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    const CELL: [u32; 9] = [1, 0, 1, 2, 3, 0, 0, 0, 0];

    fn hash(nodes: &[[f64; 3]], cell: [u32; 9]) -> String {
        let mut digest = FemNativeIndexedGeometryHasher::new(4, 1).unwrap();
        for node in nodes {
            digest.append_nodes(std::slice::from_ref(node)).unwrap();
        }
        digest.append_cells(&[cell]).unwrap();
        digest.finish().unwrap()
    }

    #[test]
    fn geometry_digest_is_chunk_independent_and_preserves_index_and_ieee_bits() {
        let original = hash(&NODES, CELL);
        // Frozen independent Python hashlib/struct LE preimage fixture.
        assert_eq!(
            original,
            "sha256:46fbbd2c176d321c10ca26d7f9297fb1381d086a9f27c368151867462925c578"
        );
        let mut together = FemNativeIndexedGeometryHasher::new(4, 1).unwrap();
        together.append_nodes(&NODES).unwrap();
        together.append_cells(&[CELL]).unwrap();
        assert_eq!(together.finish().unwrap(), original);
        let mut negative_zero = NODES;
        negative_zero[0][0] = -0.;
        assert_ne!(hash(&negative_zero, CELL), original);
        let mut reordered = CELL;
        reordered.swap(2, 3);
        assert_ne!(hash(&NODES, reordered), original);
    }

    #[test]
    fn geometry_digest_rejects_incomplete_invalid_and_out_of_order_chunks() {
        let mut digest = FemNativeIndexedGeometryHasher::new(4, 1).unwrap();
        assert!(digest.append_cells(&[CELL]).is_err());
        assert!(digest.append_nodes(&[[f64::NAN, 0., 0.]]).is_err());
        digest.append_nodes(&NODES).unwrap();
        let mut padded = CELL;
        padded[8] = 1;
        assert!(digest.append_cells(&[padded]).is_err());
        let mut bad_index = CELL;
        bad_index[1] = 4;
        assert!(digest.append_cells(&[bad_index]).is_err());
        assert!(digest.finish().is_err());
        assert!(FemNativeIndexedGeometryHasher::new(0, 1).is_err());
        assert!(
            FemNativeIndexedGeometryHasher::new(MAX_FEM_NATIVE_GEOMETRY_ENTITIES + 1, 1).is_err()
        );
    }
}
