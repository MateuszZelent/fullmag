//! Append-only native local-node map ABI. Core periodic classes are not MFEM
//! true DOFs; output arrays are caller-owned and use exact declared extents.

use crate::fullmag_fem_backend;

pub const FULLMAG_FEM_LOCAL_NODE_MAP_V1_ABI_VERSION: u32 = 1;

#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct fullmag_fem_local_node_map_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub state_space: u32,
    pub reserved0: u32,
    pub local_node_count: u64,
    pub mfem_local_dof_count: u64,
    pub mfem_true_dof_count: u64,
    pub core_periodic_class_count: u64,
    pub core_periodic_map_revision: u64,
}

const _: () = {
    assert!(std::mem::size_of::<fullmag_fem_local_node_map_v1>() == 56);
    assert!(std::mem::align_of::<fullmag_fem_local_node_map_v1>() == 8);
    assert!(std::mem::offset_of!(fullmag_fem_local_node_map_v1, local_node_count) == 16);
    assert!(std::mem::offset_of!(fullmag_fem_local_node_map_v1, core_periodic_map_revision) == 48);
};

extern "C" {
    pub fn fullmag_fem_backend_copy_local_node_geometry_v1(
        handle: *mut fullmag_fem_backend,
        expected_total_nodes: u64,
        expected_total_cells: u64,
        first: u64,
        count: u64,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;
    pub fn fullmag_fem_backend_copy_local_cell_geometry_v1(
        handle: *mut fullmag_fem_backend,
        expected_total_nodes: u64,
        expected_total_cells: u64,
        first: u64,
        count: u64,
        out_records: *mut u32,
        out_len: u64,
    ) -> i32;
    pub fn fullmag_fem_backend_snapshot_local_node_map_v1(
        handle: *mut fullmag_fem_backend,
        out_map: *mut fullmag_fem_local_node_map_v1,
    ) -> i32;
    pub fn fullmag_fem_backend_copy_local_node_map_v1(
        handle: *mut fullmag_fem_backend,
        expected_revision: u64,
        local_to_mfem_dof: *mut u32,
        local_to_mfem_dof_len: u64,
        local_to_core_class: *mut u32,
        local_to_core_class_len: u64,
        class_representatives: *mut u32,
        class_representatives_len: u64,
    ) -> i32;
}
