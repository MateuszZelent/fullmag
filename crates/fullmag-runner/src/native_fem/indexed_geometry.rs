//! Cold, exclusively owned live MFEM node/cell snapshot hashing.
//! A later chunk failure discards the whole hasher; no partial digest escapes.

use super::{ffi, NativeFemBackend};
use crate::types::RunError;
use fullmag_quantities::fem_native_indexed_geometry::{
    FemNativeIndexedGeometryHasher, FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES,
};

impl NativeFemBackend {
    pub(crate) fn indexed_geometry_sha256(
        &mut self,
        node_count: u64,
        cell_count: u64,
    ) -> Result<String, RunError> {
        let mut digest = FemNativeIndexedGeometryHasher::new(node_count, cell_count)
            .map_err(|message| RunError { message })?;
        // &mut self keeps safe Rust users from mutating or observing the same
        // handle concurrently. Call only after stepping and preview handoff.
        let mut nodes = vec![[0.; 3]; FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES];
        let mut first = 0;
        while first < node_count {
            let count =
                (node_count - first).min(FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES as u64) as usize;
            let rc = unsafe {
                ffi::node_map::fullmag_fem_backend_copy_local_node_geometry_v1(
                    self.handle,
                    node_count,
                    cell_count,
                    first,
                    count as u64,
                    nodes.as_mut_ptr().cast::<f64>(),
                    (count * 3) as u64,
                )
            };
            if rc != ffi::FULLMAG_FEM_OK {
                return Err(self.last_error_or("native FEM indexed node geometry read failed"));
            }
            digest
                .append_nodes(&nodes[..count])
                .map_err(|message| RunError { message })?;
            first += count as u64;
        }
        drop(nodes);
        let mut cells = vec![[0; 9]; FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES];
        first = 0;
        while first < cell_count {
            let count =
                (cell_count - first).min(FEM_NATIVE_GEOMETRY_CHUNK_ENTITIES as u64) as usize;
            let rc = unsafe {
                ffi::node_map::fullmag_fem_backend_copy_local_cell_geometry_v1(
                    self.handle,
                    node_count,
                    cell_count,
                    first,
                    count as u64,
                    cells.as_mut_ptr().cast::<u32>(),
                    (count * 9) as u64,
                )
            };
            if rc != ffi::FULLMAG_FEM_OK {
                return Err(self.last_error_or("native FEM indexed cell geometry read failed"));
            }
            digest
                .append_cells(&cells[..count])
                .map_err(|message| RunError { message })?;
            first += count as u64;
        }
        digest.finish().map_err(|message| RunError { message })
    }
}
