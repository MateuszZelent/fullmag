use super::PackedNativeMesh;
use fullmag_fem_sys as ffi;
use std::ffi::{c_char, c_void};
use std::ptr;

const ERROR_CAPACITY: usize = 512;

struct NativeSnapshotHandle(*mut c_void);

impl Drop for NativeSnapshotHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ffi::fullmag_fem_tracking_mass_snapshot_destroy_v1(self.0) };
        }
    }
}

#[derive(Debug)]
pub(crate) struct TrackingMassSnapshot {
    generation: u64,
    magnetic_volume_m3: f64,
    row_offsets: Vec<u64>,
    columns: Vec<u32>,
    values_m3: Vec<f64>,
    canonical_vertex_ids: Vec<u32>,
    scalar_dof_ids: Vec<u32>,
    topology_sha256: [u8; 32],
    marker_map_sha256: [u8; 32],
    element_mask_sha256: [u8; 32],
    canonical_dof_map_sha256: [u8; 32],
    csr_sha256: [u8; 32],
    source_snapshot_sha256: [u8; 32],
    identity_sha256: [u8; 32],
}

impl TrackingMassSnapshot {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn magnetic_volume_m3(&self) -> f64 {
        self.magnetic_volume_m3
    }

    pub(crate) fn row_offsets(&self) -> &[u64] {
        &self.row_offsets
    }

    pub(crate) fn columns(&self) -> &[u32] {
        &self.columns
    }

    pub(crate) fn values_m3(&self) -> &[f64] {
        &self.values_m3
    }

    pub(crate) fn canonical_vertex_ids(&self) -> &[u32] {
        &self.canonical_vertex_ids
    }

    pub(crate) fn scalar_dof_ids(&self) -> &[u32] {
        &self.scalar_dof_ids
    }

    pub(crate) fn topology_sha256(&self) -> &[u8; 32] {
        &self.topology_sha256
    }

    pub(crate) fn marker_map_sha256(&self) -> &[u8; 32] {
        &self.marker_map_sha256
    }

    pub(crate) fn element_mask_sha256(&self) -> &[u8; 32] {
        &self.element_mask_sha256
    }

    pub(crate) fn canonical_dof_map_sha256(&self) -> &[u8; 32] {
        &self.canonical_dof_map_sha256
    }

    pub(crate) fn csr_sha256(&self) -> &[u8; 32] {
        &self.csr_sha256
    }

    pub(crate) fn source_snapshot_sha256(&self) -> &[u8; 32] {
        &self.source_snapshot_sha256
    }

    pub(crate) fn identity_sha256(&self) -> &[u8; 32] {
        &self.identity_sha256
    }
}

fn ffi_error(status: i32, buffer: &[c_char], operation: &str) -> String {
    let bytes = buffer
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    let message = String::from_utf8_lossy(&bytes);
    if message.is_empty() {
        format!("native tracking mass {operation} failed with status {status}")
    } else {
        format!("native tracking mass {operation} failed: {message}")
    }
}

fn zeroed_vec<T: Clone>(length: usize, value: T, label: &str) -> Result<Vec<T>, String> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(length)
        .map_err(|error| format!("could not reserve {label}: {error}"))?;
    output.resize(length, value);
    Ok(output)
}

fn checked_csr_bound(
    mesh: &fullmag_ir::MeshIR,
    magnetic_cell_mask: &[u8],
) -> Result<usize, String> {
    if mesh.nodes.len() > u32::MAX as usize {
        return Err("tracking mass mesh exceeds the canonical uint32 vertex index range".into());
    }
    let packed_node_count = u32::try_from(mesh.cells.nodes.len())
        .map_err(|_| "tracking mass connectivity exceeds uint32 storage".to_string())?;
    if mesh.cells.types.len() != magnetic_cell_mask.len()
        || mesh.cells.offsets.len() != mesh.cells.types.len().saturating_add(1)
        || mesh.cells.offsets.first().copied() != Some(0)
        || mesh.cells.offsets.last().copied() != Some(packed_node_count)
    {
        return Err("tracking mass mask or typed connectivity does not match the mesh".into());
    }
    if mesh
        .cells
        .offsets
        .windows(2)
        .any(|pair| pair[0] > pair[1] || pair[1] > packed_node_count)
    {
        return Err("tracking mass cell offsets are not monotonic and bounded".into());
    }
    if magnetic_cell_mask.iter().any(|value| *value > 1) {
        return Err("tracking mass magnetic cell mask values must be zero or one".into());
    }
    if !mesh.element_markers.is_empty() && mesh.element_markers.len() != mesh.cells.types.len() {
        return Err("tracking mass element markers do not match the typed cell count".into());
    }
    let mut bound = 0usize;
    let mut selected_cells = 0usize;
    for (cell, selected) in magnetic_cell_mask.iter().copied().enumerate() {
        if selected == 0 {
            continue;
        }
        if mesh
            .element_markers
            .get(cell)
            .is_some_and(|marker| *marker == 0)
        {
            return Err(format!("tracking mass mask selects air-marked cell {cell}"));
        }
        selected_cells += 1;
        let local_dofs = match mesh.cells.types[cell] {
            fullmag_ir::FemCellTypeIR::Tet4 => 4usize,
            fullmag_ir::FemCellTypeIR::Prism6 => 6usize,
            _ => return Err("tracking mass selected cells must be Tet4 or Prism6".into()),
        };
        let contribution = local_dofs
            .checked_mul(local_dofs)
            .ok_or_else(|| "tracking mass topological CSR bound overflowed".to_string())?;
        bound = bound
            .checked_add(contribution)
            .ok_or_else(|| "tracking mass topological CSR bound overflowed".to_string())?;
        let begin = mesh.cells.offsets[cell] as usize;
        let end = mesh.cells.offsets[cell + 1] as usize;
        if end.checked_sub(begin) != Some(local_dofs)
            || mesh.cells.nodes[begin..end]
                .iter()
                .any(|node| *node as usize >= mesh.nodes.len())
        {
            return Err(format!(
                "tracking mass cell {cell} has invalid typed connectivity"
            ));
        }
    }
    if selected_cells == 0 {
        return Err("tracking mass requires at least one magnetic cell".into());
    }
    Ok(bound)
}

fn parse_sha256(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("build source snapshot identity is not a lowercase SHA-256 digest".into());
    }
    let mut digest = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = (pair[0] as char)
            .to_digit(16)
            .ok_or("invalid source digest")? as u8;
        let low = (pair[1] as char)
            .to_digit(16)
            .ok_or("invalid source digest")? as u8;
        digest[index] = (high << 4) | low;
    }
    Ok(digest)
}

fn close_relative(actual: f64, expected: f64, tolerance: f64) -> bool {
    if !actual.is_finite() || !expected.is_finite() {
        return false;
    }
    let scale = actual.abs().max(expected.abs());
    scale == 0.0 || (actual - expected).abs() <= tolerance * scale
}

impl TrackingMassSnapshot {
    pub(crate) fn from_mesh(
        mesh: &fullmag_ir::MeshIR,
        magnetic_cell_mask: &[u8],
        generation: u64,
    ) -> Result<Self, String> {
        if generation == 0 {
            return Err("tracking mass generation must be nonzero".into());
        }
        let nnz_bound = checked_csr_bound(mesh, magnetic_cell_mask)?;
        let row_count = mesh.nodes.len();
        let row_offset_count = row_count
            .checked_add(1)
            .ok_or_else(|| "tracking mass CSR row count overflowed".to_string())?;
        let packed = PackedNativeMesh::new(mesh);
        let descriptor = packed.descriptor(mesh);
        let request = ffi::fullmag_fem_tracking_mass_snapshot_request_v1 {
            abi_version: ffi::FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_tracking_mass_snapshot_request_v1>()
                as u32,
            mesh: &descriptor,
            magnetic_cell_mask: magnetic_cell_mask.as_ptr(),
            magnetic_cell_mask_count: u64::try_from(magnetic_cell_mask.len())
                .map_err(|_| "tracking mass cell mask length exceeds uint64".to_string())?,
            generation,
        };

        let mut error = [0 as c_char; ERROR_CAPACITY];
        let mut raw_handle = ptr::null_mut();
        let create_status = unsafe {
            ffi::fullmag_fem_tracking_mass_snapshot_create_v1(
                &request,
                &mut raw_handle,
                error.as_mut_ptr(),
                error.len() as u64,
            )
        };
        let native = NativeSnapshotHandle(raw_handle);
        if create_status != ffi::FULLMAG_FEM_OK {
            return Err(ffi_error(create_status, &error, "creation"));
        }
        if native.0.is_null() {
            return Err(
                "native tracking mass producer returned success without a snapshot handle".into(),
            );
        }

        let mut info = ffi::fullmag_fem_tracking_mass_snapshot_info_v1 {
            abi_version: ffi::FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_tracking_mass_snapshot_info_v1>()
                as u32,
            generation: 0,
            canonical_vertex_count: 0,
            nonzero_count: 0,
            magnetic_volume_m3: 0.0,
            topology_sha256: [0; 32],
            marker_map_sha256: [0; 32],
            element_mask_sha256: [0; 32],
            canonical_dof_map_sha256: [0; 32],
            csr_sha256: [0; 32],
            source_snapshot_sha256: [0; 32],
            identity_sha256: [0; 32],
        };
        error.fill(0);
        let info_status = unsafe {
            ffi::fullmag_fem_tracking_mass_snapshot_get_info_v1(
                native.0,
                &mut info,
                error.as_mut_ptr(),
                error.len() as u64,
            )
        };
        if info_status != ffi::FULLMAG_FEM_OK {
            return Err(ffi_error(info_status, &error, "metadata query"));
        }
        if info.abi_version != ffi::FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION
            || info.struct_size as usize
                != std::mem::size_of::<ffi::fullmag_fem_tracking_mass_snapshot_info_v1>()
            || info.generation != generation
            || info.canonical_vertex_count != row_count as u64
            || info.nonzero_count > nnz_bound as u64
            || !info.magnetic_volume_m3.is_finite()
            || info.magnetic_volume_m3 <= 0.0
        {
            return Err(
                "native tracking mass metadata does not match the typed mesh request".into(),
            );
        }

        let build_identity = fullmag_build_info::identity();
        let expected_source_digest = parse_sha256(&build_identity.source_snapshot_sha256)?;
        if info.source_snapshot_sha256 != expected_source_digest {
            return Err(
                "tracking mass DSO source snapshot differs from the Rust build identity".into(),
            );
        }
        for (label, digest) in [
            ("topology", &info.topology_sha256),
            ("marker map", &info.marker_map_sha256),
            ("element mask", &info.element_mask_sha256),
            ("canonical DOF map", &info.canonical_dof_map_sha256),
            ("CSR", &info.csr_sha256),
            ("source snapshot", &info.source_snapshot_sha256),
            ("overall identity", &info.identity_sha256),
        ] {
            if digest.iter().all(|byte| *byte == 0) {
                return Err(format!("native tracking mass {label} digest is empty"));
            }
        }

        let nnz = usize::try_from(info.nonzero_count)
            .map_err(|_| "tracking mass nonzero count exceeds addressable memory".to_string())?;
        let mut row_offsets = zeroed_vec(row_offset_count, 0u64, "tracking mass row offsets")?;
        let mut columns = zeroed_vec(nnz, 0u32, "tracking mass columns")?;
        let mut values_m3 = zeroed_vec(nnz, 0.0f64, "tracking mass values")?;
        let mut canonical_vertex_ids = zeroed_vec(row_count, 0u32, "canonical vertex map")?;
        let mut scalar_dof_ids = zeroed_vec(row_count, 0u32, "scalar DOF map")?;
        error.fill(0);
        let copy_status = unsafe {
            ffi::fullmag_fem_tracking_mass_snapshot_copy_v1(
                native.0,
                generation,
                info.identity_sha256.as_ptr(),
                u64::try_from(row_offsets.len())
                    .map_err(|_| "row offset capacity exceeds uint64")?,
                u64::try_from(columns.len()).map_err(|_| "column capacity exceeds uint64")?,
                u64::try_from(values_m3.len()).map_err(|_| "value capacity exceeds uint64")?,
                u64::try_from(canonical_vertex_ids.len())
                    .map_err(|_| "canonical vertex capacity exceeds uint64")?,
                u64::try_from(scalar_dof_ids.len())
                    .map_err(|_| "scalar DOF capacity exceeds uint64")?,
                row_offsets.as_mut_ptr(),
                columns.as_mut_ptr(),
                values_m3.as_mut_ptr(),
                canonical_vertex_ids.as_mut_ptr(),
                scalar_dof_ids.as_mut_ptr(),
                error.as_mut_ptr(),
                error.len() as u64,
            )
        };
        if copy_status != ffi::FULLMAG_FEM_OK {
            return Err(ffi_error(copy_status, &error, "copy"));
        }

        validate_snapshot(
            mesh,
            magnetic_cell_mask,
            info.magnetic_volume_m3,
            &row_offsets,
            &columns,
            &values_m3,
            &canonical_vertex_ids,
            &scalar_dof_ids,
        )?;
        let snapshot = Self {
            generation,
            magnetic_volume_m3: info.magnetic_volume_m3,
            row_offsets,
            columns,
            values_m3,
            canonical_vertex_ids,
            scalar_dof_ids,
            topology_sha256: info.topology_sha256,
            marker_map_sha256: info.marker_map_sha256,
            element_mask_sha256: info.element_mask_sha256,
            canonical_dof_map_sha256: info.canonical_dof_map_sha256,
            csr_sha256: info.csr_sha256,
            source_snapshot_sha256: info.source_snapshot_sha256,
            identity_sha256: info.identity_sha256,
        };
        drop(native);
        Ok(snapshot)
    }
}

fn validate_snapshot(
    mesh: &fullmag_ir::MeshIR,
    magnetic_cell_mask: &[u8],
    expected_volume_m3: f64,
    row_offsets: &[u64],
    columns: &[u32],
    values_m3: &[f64],
    canonical_vertex_ids: &[u32],
    scalar_dof_ids: &[u32],
) -> Result<(), String> {
    let rows = mesh.nodes.len();
    if row_offsets.len() != rows.saturating_add(1)
        || columns.len() != values_m3.len()
        || canonical_vertex_ids.len() != rows
        || scalar_dof_ids.len() != rows
        || row_offsets.first().copied() != Some(0)
        || row_offsets.last().copied() != Some(columns.len() as u64)
    {
        return Err("tracking mass CSR or canonical map has inconsistent extents".into());
    }
    if row_offsets
        .windows(2)
        .any(|pair| pair[0] > pair[1] || pair[1] > columns.len() as u64)
    {
        return Err("tracking mass CSR row offsets are not monotonic and bounded".into());
    }
    let mut active_vertices = zeroed_vec(rows, false, "tracking mass active-vertex validation")?;
    for (cell, selected) in magnetic_cell_mask.iter().copied().enumerate() {
        if selected == 0 {
            continue;
        }
        let begin = mesh.cells.offsets[cell] as usize;
        let end = mesh.cells.offsets[cell + 1] as usize;
        for vertex in &mesh.cells.nodes[begin..end] {
            active_vertices[*vertex as usize] = true;
        }
    }
    let mut total_volume_m3 = 0.0;
    let mut total_volume_compensation = 0.0;
    for row in 0..rows {
        if canonical_vertex_ids[row] != row as u32 || scalar_dof_ids[row] != row as u32 {
            return Err(
                "native tracking mass changed canonical vertex or scalar DOF ordering".into(),
            );
        }
        let begin = usize::try_from(row_offsets[row])
            .map_err(|_| "tracking mass row offset exceeds addressable memory")?;
        let end = usize::try_from(row_offsets[row + 1])
            .map_err(|_| "tracking mass row offset exceeds addressable memory")?;
        if begin > end || end > columns.len() {
            return Err("tracking mass CSR row offsets are not monotonic and bounded".into());
        }
        let mut row_sum = 0.0;
        let mut previous = None;
        for offset in begin..end {
            let column = columns[offset] as usize;
            let value = values_m3[offset];
            if column >= rows || !value.is_finite() || value <= 0.0 {
                return Err("tracking mass CSR contains an invalid column or value".into());
            }
            if previous.is_some_and(|last| last >= column) {
                return Err("tracking mass CSR columns are not strictly sorted".into());
            }
            previous = Some(column);
            let reverse_begin = row_offsets[column] as usize;
            let reverse_end = row_offsets[column + 1] as usize;
            let reverse_offset = columns[reverse_begin..reverse_end]
                .binary_search(&(row as u32))
                .map_err(|_| "tracking mass CSR is missing a symmetric entry")?;
            let reverse = values_m3[reverse_begin + reverse_offset];
            if !close_relative(value, reverse, 128.0 * f64::EPSILON) {
                return Err(
                    "tracking mass CSR is not symmetric within relative assembly precision".into(),
                );
            }
            if !active_vertices[column] {
                return Err("tracking mass couples a magnetic row to an air-only vertex".into());
            }
            row_sum += value;
            if !row_sum.is_finite() {
                return Err("tracking mass CSR row sum is nonfinite".into());
            }
        }
        if active_vertices[row] {
            if row_sum <= 0.0 {
                return Err("magnetic tracking mass row is not positive".into());
            }
        } else if begin != end || row_sum != 0.0 {
            return Err("air-only tracking mass row is not empty and exactly zero".into());
        }
        let corrected_row_sum = row_sum - total_volume_compensation;
        let next_total = total_volume_m3 + corrected_row_sum;
        total_volume_compensation = (next_total - total_volume_m3) - corrected_row_sum;
        total_volume_m3 = next_total;
        if !total_volume_m3.is_finite() {
            return Err("tracking mass total volume is nonfinite".into());
        }
    }
    if !close_relative(total_volume_m3, expected_volume_m3, 1.0e-12) {
        return Err("tracking mass CSR row sums do not reproduce its magnetic volume".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tetrahedron_mesh() -> fullmag_ir::MeshIR {
        fullmag_ir::MeshIR::from_legacy_tet4(
            "tracking-mass-snapshot-contract".into(),
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

    fn prism6_mesh_at_nanoscale() -> fullmag_ir::MeshIR {
        let mut mesh = tetrahedron_mesh();
        mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0e-9, 0.0, 0.0],
            [0.0, 1.0e-9, 0.0],
            [0.0, 0.0, 1.0e-9],
            [1.0e-9, 0.0, 1.0e-9],
            [0.0, 1.0e-9, 1.0e-9],
        ];
        mesh.cells = fullmag_ir::FemConnectivityIR {
            types: vec![fullmag_ir::FemCellTypeIR::Prism6],
            offsets: vec![0, 6],
            nodes: vec![0, 1, 2, 3, 4, 5],
            global_ordinals: vec![44],
            mesh_parts: Vec::new(),
        };
        mesh.element_markers = vec![7];
        mesh.facets = fullmag_ir::FemFacetConnectivityIR {
            types: vec![
                fullmag_ir::FemFacetTypeIR::Tri3,
                fullmag_ir::FemFacetTypeIR::Tri3,
                fullmag_ir::FemFacetTypeIR::Quad4,
                fullmag_ir::FemFacetTypeIR::Quad4,
                fullmag_ir::FemFacetTypeIR::Quad4,
            ],
            roles: vec![fullmag_ir::FemFacetRoleIR::Exterior; 5],
            offsets: vec![0, 3, 6, 10, 14, 18],
            nodes: vec![0, 2, 1, 3, 4, 5, 0, 1, 4, 3, 1, 2, 5, 4, 2, 0, 3, 5],
            global_ordinals: vec![0, 1, 2, 3, 4],
        };
        mesh.boundary_markers = vec![1; 5];
        mesh
    }

    #[test]
    fn tracking_mass_snapshot_ffi_matches_packed_mesh_identity() {
        let mesh = tetrahedron_mesh();
        let snapshot = TrackingMassSnapshot::from_mesh(&mesh, &[1], 17)
            .expect("typed Tet4 mesh should cross the native tracking-mass C ABI");
        assert_eq!(snapshot.generation, 17);
        assert_eq!(snapshot.canonical_vertex_ids, vec![0, 1, 2, 3]);
        assert_eq!(snapshot.scalar_dof_ids, vec![0, 1, 2, 3]);
        assert_eq!(snapshot.row_offsets, vec![0, 4, 8, 12, 16]);
        assert_eq!(snapshot.columns.len(), 16);
        assert_eq!(snapshot.values_m3.len(), 16);
        assert!((snapshot.magnetic_volume_m3 - 1.0 / 6.0).abs() < 1.0e-14);
        assert!(snapshot
            .source_snapshot_sha256
            .iter()
            .any(|byte| *byte != 0));
        assert!(snapshot.identity_sha256.iter().any(|byte| *byte != 0));
        for row in 0..4 {
            let row_sum: f64 = snapshot.values_m3
                [snapshot.row_offsets[row] as usize..snapshot.row_offsets[row + 1] as usize]
                .iter()
                .sum();
            assert!((row_sum - 1.0 / 24.0).abs() < 1.0e-14);
        }

        let prism = prism6_mesh_at_nanoscale();
        let prism_snapshot = TrackingMassSnapshot::from_mesh(&prism, &[1], 44)
            .expect("typed Prism6 mesh should cross the native tracking-mass C ABI");
        let expected_volume = 5.0e-28;
        assert_eq!(prism_snapshot.generation, 44);
        assert_eq!(prism_snapshot.canonical_vertex_ids, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(prism_snapshot.scalar_dof_ids, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(prism_snapshot.row_offsets, vec![0, 6, 12, 18, 24, 30, 36]);
        assert_eq!(prism_snapshot.columns.len(), 36);
        assert_eq!(prism_snapshot.values_m3.len(), 36);
        assert!(close_relative(
            prism_snapshot.magnetic_volume_m3,
            expected_volume,
            1.0e-12
        ));
        for row in 0..6usize {
            let mut row_sum = 0.0;
            for offset in prism_snapshot.row_offsets[row] as usize
                ..prism_snapshot.row_offsets[row + 1] as usize
            {
                let column = prism_snapshot.columns[offset] as usize;
                let same_triangle_vertex = row % 3 == column % 3;
                let same_axial_level = (row < 3) == (column < 3);
                let expected = if same_triangle_vertex {
                    if same_axial_level {
                        expected_volume / 18.0
                    } else {
                        expected_volume / 36.0
                    }
                } else if same_axial_level {
                    expected_volume / 36.0
                } else {
                    expected_volume / 72.0
                };
                assert!(close_relative(
                    prism_snapshot.values_m3[offset],
                    expected,
                    1.0e-12
                ));
                row_sum += prism_snapshot.values_m3[offset];
            }
            assert!(close_relative(row_sum, expected_volume / 6.0, 1.0e-12));
        }
        println!("PASS: fem_tracking_mass_snapshot_rust_ffi_contract");
    }
}
