//! Frozen, append-only FDM GPU transport ABI v1 records.

#![allow(non_camel_case_types)]

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct gpu_prefix_v1 {
    pub abi_version: u32,
    pub struct_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u32,
    pub required_features: u64,
    pub reserved0: u64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct fullmag_fdm_gpu_transport_context_handle_v1 {
    pub registry_cookie: u64,
    pub slot: u64,
    pub generation: u64,
    pub type_tag: u64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct fullmag_fdm_gpu_charge_snapshot_handle_v1 {
    pub registry_cookie: u64,
    pub slot: u64,
    pub generation: u64,
    pub type_tag: u64,
}
macro_rules! record { ($name:ident { $($field:ident:$ty:ty),* $(,)? }) => { #[repr(C)] #[derive(Clone,Copy,Default)] pub struct $name { pub prefix:gpu_prefix_v1,$(pub $field:$ty),* } }; }
record!(fullmag_fdm_gpu_transport_buffer_view_v1 {
    address: u64,
    element_count: u64,
    byte_stride: u64,
    byte_length: u64,
    element_type: u32,
    pointer_space: u32,
    component_order: u32,
    reserved1: u32
});
record!(fullmag_fdm_gpu_transport_charge_cell_v1 {
    active: u32,
    conductor: u32,
    material_index: u32,
    reserved1: u32
});
record!(fullmag_fdm_gpu_transport_charge_material_v1 {
    material_index: u32,
    reserved1: u32,
    conductivity: f64,
    material_revision: u64
});
record!(fullmag_fdm_gpu_transport_charge_face_v1 {
    kind: u32,
    axis: u32,
    side: i32,
    outward_sign: i32,
    adjacent_cell: u64,
    canonical_face_index: u64,
    area: f64,
    value: f64,
    source_id: u64
});
record!(fullmag_fdm_gpu_transport_charge_formula_ids_v1 {
    formula_id: u32,
    operator_id: u32,
    engine_id: u32,
    residual_id: u32,
    operator_revision: u64,
    reserved1: u64
});
record!(fullmag_fdm_gpu_transport_context_create_request_v1 {
    device_uuid: [u8; 16],
    device_ordinal: i32,
    precision: u32,
    strict_residency: u32,
    deterministic: u32,
    allocator_limit: u64,
    workspace_limit: u64,
    stream_policy: u32,
    reserved1: u32,
    requested_device_features: u64,
    reserved2: u64
});
record!(fullmag_fdm_gpu_transport_context_create_result_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    device_uuid: [u8; 16],
    compute_major: u32,
    compute_minor: u32,
    cuda_runtime: u32,
    cuda_driver: u32,
    build_digest: [u8; 32],
    supported_features: u64
});
record!(fullmag_fdm_gpu_transport_static_descriptor_v1 {
    grid: [u64; 3],
    cell_size: [f64; 3],
    descriptor_revision: u64,
    source_revision: u64,
    descriptor_digest: [u8; 32],
    masks_view_ptr: u64,
    materials_view_ptr: u64,
    interfaces_view_ptr: u64,
    charge_faces_view_ptr: u64,
    spin_faces_view_ptr: u64,
    formula_ids_view_ptr: u64,
    reserved1: u64
});
record!(fullmag_fdm_gpu_charge_solve_request_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    solver_policy: u32,
    gauge_policy: u32,
    attempt_id: u64,
    stage_id: u64,
    source_revision: u64,
    static_revision: u64,
    relative_tolerance: f64,
    max_iterations: u64
});
record!(fullmag_fdm_gpu_charge_solve_result_v1 {
    provisional_generation: u64,
    iterations: u64,
    reason: u32,
    reserved1: u32,
    algebraic_residual: f64,
    physical_residual: f64,
    component_balance: f64,
    electrode_balance: f64,
    transfer_count: u64,
    transfer_bytes: u64,
    peak_bytes: u64,
    candidate_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_charge_snapshot_info_v1 {
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot_lineage_id: [u8; 16],
    accepted_sequence: u64,
    local_generation: u64,
    source_revision: u64,
    operator_revision: u64,
    snapshot_content_digest: [u8; 32],
    convergence_digest: [u8; 32],
    device_bytes: u64
});
record!(fullmag_fdm_gpu_steady_spin_solve_request_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    accepted_sequence: u64,
    m_stage_view_ptr: u64,
    torque_view_ptr: u64,
    solver_policy: u32,
    reserved1: u32,
    attempt_id: u64,
    stage_id: u64,
    source_revision: u64,
    operator_revision: u64,
    relative_tolerance: f64,
    max_iterations: u64
});
record!(fullmag_fdm_gpu_steady_spin_solve_result_v1 {
    iterations: u64,
    reason: u32,
    reserved1: u32,
    algebraic_residual: f64,
    local_balance: f64,
    global_balance: f64,
    interface_balance: f64,
    torque_balance: f64,
    transfer_count: u64,
    transfer_bytes: u64,
    peak_bytes: u64,
    snapshot_content_digest: [u8; 32],
    deterministic_compute_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_telemetry_v1 {
    audit_sequence: u64,
    direction: u32,
    reason: u32,
    status: u32,
    event_flags: u32,
    bytes: u64,
    count: u64,
    attempt_id: u64,
    stage_id: u64,
    iteration: u64,
    stream_id: u64,
    event_id: u64,
    operation_audit_digest: [u8; 32],
    scientific_continuation_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_artifact_request_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    field_id: u32,
    cadence: u32,
    range_begin: u64,
    range_count: u64,
    destination_view_ptr: u64,
    expected_bytes: u64,
    accepted_sequence: u64
});
record!(fullmag_fdm_gpu_transport_checkpoint_size_request_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    accepted_sequence: u64,
    schema_version: u32,
    inclusion_mask: u32,
    static_descriptor_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_checkpoint_size_result_v1 {
    required_bytes: u64,
    section_count: u32,
    alignment: u32,
    schema_version: u32,
    inclusion_mask: u32,
    snapshot_content_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_checkpoint_export_request_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    accepted_sequence: u64,
    cadence_id: u64,
    destination_view_ptr: u64,
    exact_capacity: u64,
    expected_size: u64,
    inclusion_mask: u32,
    reserved1: u32
});
record!(fullmag_fdm_gpu_transport_checkpoint_export_result_v1 {
    committed_bytes: u64,
    payload_sha256: [u8; 32],
    snapshot_digest: [u8; 32],
    spin_digest: [u8; 32],
    warm_start_digest: [u8; 32],
    audit_sequence: u64,
    snapshot_lineage_id: [u8; 16],
    accepted_sequence: u64,
    operation_audit_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_checkpoint_import_request_v1 {
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    source_view_ptr: u64,
    expected_payload_sha256: [u8; 32],
    device_uuid: [u8; 16],
    build_digest: [u8; 32],
    static_descriptor_digest: [u8; 32],
    restore_policy: u32,
    reserved1: u32,
    expected_bytes: u64,
    audit_parent_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 {
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    snapshot_lineage_id: [u8; 16],
    accepted_sequence: u64,
    snapshot_content_digest: [u8; 32],
    spin_digest: [u8; 32],
    warm_start_digest: [u8; 32],
    audit_sequence: u64,
    restored_state: u32,
    reserved1: u32,
    operation_audit_digest: [u8; 32]
});
record!(fullmag_fdm_gpu_transport_error_v1 {
    status: u32,
    record_id: u32,
    field_offset: u32,
    reserved1: u32,
    requested_abi: u32,
    available_abi: u32,
    requested_struct: u32,
    available_struct: u32,
    requested_features: u64,
    available_features: u64,
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot_handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    attempt_id: u64,
    diagnostic_ptr: u64,
    diagnostic_capacity: u64,
    diagnostic_length: u64
});

pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE: u64 = 0x04;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1: u32 = 1;

extern "C" {
    pub fn fullmag_fdm_gpu_transport_context_create_v1(
        request: *const fullmag_fdm_gpu_transport_context_create_request_v1,
        result: *mut fullmag_fdm_gpu_transport_context_create_result_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_context_destroy_v1(
        context: fullmag_fdm_gpu_transport_context_handle_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        descriptor: *const fullmag_fdm_gpu_transport_static_descriptor_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_solve_charge_v1(
        request: *const fullmag_fdm_gpu_charge_solve_request_v1,
        result: *mut fullmag_fdm_gpu_charge_solve_result_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        provisional_generation: u64,
        snapshot_info: *mut fullmag_fdm_gpu_charge_snapshot_info_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_query_telemetry_v1(
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        cursor: u64,
        records: *mut fullmag_fdm_gpu_transport_telemetry_v1,
        record_capacity: u64,
        record_count: *mut u64,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_readback_artifact_v1(
        request: *const fullmag_fdm_gpu_transport_artifact_request_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
        request: *const fullmag_fdm_gpu_transport_checkpoint_size_request_v1,
        result: *mut fullmag_fdm_gpu_transport_checkpoint_size_result_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_checkpoint_export_v1(
        request: *const fullmag_fdm_gpu_transport_checkpoint_export_request_v1,
        result: *mut fullmag_fdm_gpu_transport_checkpoint_export_result_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_transport_checkpoint_import_v1(
        request: *const fullmag_fdm_gpu_transport_checkpoint_import_request_v1,
        result: *mut fullmag_fdm_gpu_transport_checkpoint_restore_result_v1,
    ) -> u32;
    pub fn fullmag_fdm_gpu_charge_snapshot_destroy_v1(
        snapshot: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    ) -> u32;
}

pub const FROZEN_U32_REGISTRIES_V1: &[&[u32]] = &[
    &[0, 1],
    &[0, 1, 2, 3, 4, 5, 6],
    &[0, 1, 2, 3, 4],
    &[0, 1, 2, 3, 4, 5],
    &[0, 1, 2],
    &[0, 1],
    &[0, 1],
    &[0, 1, 2],
    &[0, 1, 2],
    &[0, 1, 2, 3, 4, 5, 6],
    &[0, 1, 2, 3, 4],
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    &[0, 1, 2],
    &[0, 1, 2, 3, 4, 5, 6, 7],
    &[0, 1, 2, 3],
    &[0, 1],
    &[0, 1],
    &[0, 1, 2],
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    &[
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ],
];
pub const FROZEN_U32_FLAG_LEGAL_MASKS_V1: [u32; 2] = [0x3f, 0x3f];

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{align_of, offset_of, size_of};
    macro_rules! layout {($t:ty,$size:expr,$($f:ident:$o:expr),+)=>{{assert_eq!(size_of::<$t>(),$size);assert_eq!(align_of::<$t>(),8);$(assert_eq!(offset_of!($t,$f),$o);)+}}}
    #[test]
    fn gpu_transport_abi_layout_matches_every_frozen_tail_offset() {
        layout!(fullmag_fdm_gpu_transport_buffer_view_v1,80,address:32,element_count:40,byte_stride:48,byte_length:56,element_type:64,pointer_space:68,component_order:72,reserved1:76);
        layout!(fullmag_fdm_gpu_transport_charge_cell_v1,48,active:32,conductor:36,material_index:40,reserved1:44);
        layout!(fullmag_fdm_gpu_transport_charge_material_v1,56,material_index:32,reserved1:36,conductivity:40,material_revision:48);
        layout!(fullmag_fdm_gpu_transport_charge_face_v1,88,kind:32,axis:36,side:40,outward_sign:44,adjacent_cell:48,canonical_face_index:56,area:64,value:72,source_id:80);
        layout!(fullmag_fdm_gpu_transport_charge_formula_ids_v1,64,formula_id:32,operator_id:36,engine_id:40,residual_id:44,operator_revision:48,reserved1:56);
        layout!(fullmag_fdm_gpu_transport_context_create_request_v1,104,device_uuid:32,device_ordinal:48,precision:52,strict_residency:56,deterministic:60,allocator_limit:64,workspace_limit:72,stream_policy:80,reserved1:84,requested_device_features:88,reserved2:96);
        layout!(fullmag_fdm_gpu_transport_context_create_result_v1,136,context_handle:32,device_uuid:64,compute_major:80,compute_minor:84,cuda_runtime:88,cuda_driver:92,build_digest:96,supported_features:128);
        layout!(fullmag_fdm_gpu_transport_static_descriptor_v1,184,grid:32,cell_size:56,descriptor_revision:80,source_revision:88,descriptor_digest:96,masks_view_ptr:128,materials_view_ptr:136,interfaces_view_ptr:144,charge_faces_view_ptr:152,spin_faces_view_ptr:160,formula_ids_view_ptr:168,reserved1:176);
        layout!(fullmag_fdm_gpu_charge_solve_request_v1,120,context_handle:32,solver_policy:64,gauge_policy:68,attempt_id:72,stage_id:80,source_revision:88,static_revision:96,relative_tolerance:104,max_iterations:112);
        layout!(fullmag_fdm_gpu_charge_solve_result_v1,144,provisional_generation:32,iterations:40,reason:48,reserved1:52,algebraic_residual:56,physical_residual:64,component_balance:72,electrode_balance:80,transfer_count:88,transfer_bytes:96,peak_bytes:104,candidate_digest:112);
        layout!(fullmag_fdm_gpu_charge_snapshot_info_v1,216,snapshot_handle:32,context_handle:64,snapshot_lineage_id:96,accepted_sequence:112,local_generation:120,source_revision:128,operator_revision:136,snapshot_content_digest:144,convergence_digest:176,device_bytes:208);
        layout!(fullmag_fdm_gpu_steady_spin_solve_request_v1,176,context_handle:32,snapshot_handle:64,accepted_sequence:96,m_stage_view_ptr:104,torque_view_ptr:112,solver_policy:120,reserved1:124,attempt_id:128,stage_id:136,source_revision:144,operator_revision:152,relative_tolerance:160,max_iterations:168);
        layout!(fullmag_fdm_gpu_steady_spin_solve_result_v1,176,iterations:32,reason:40,reserved1:44,algebraic_residual:48,local_balance:56,global_balance:64,interface_balance:72,torque_balance:80,transfer_count:88,transfer_bytes:96,peak_bytes:104,snapshot_content_digest:112,deterministic_compute_digest:144);
        layout!(fullmag_fdm_gpu_transport_telemetry_v1,176,audit_sequence:32,direction:40,reason:44,status:48,event_flags:52,bytes:56,count:64,attempt_id:72,stage_id:80,iteration:88,stream_id:96,event_id:104,operation_audit_digest:112,scientific_continuation_digest:144);
        layout!(fullmag_fdm_gpu_transport_artifact_request_v1,144,context_handle:32,snapshot_handle:64,field_id:96,cadence:100,range_begin:104,range_count:112,destination_view_ptr:120,expected_bytes:128,accepted_sequence:136);
        layout!(fullmag_fdm_gpu_transport_checkpoint_size_request_v1,144,context_handle:32,snapshot_handle:64,accepted_sequence:96,schema_version:104,inclusion_mask:108,static_descriptor_digest:112);
        layout!(fullmag_fdm_gpu_transport_checkpoint_size_result_v1,88,required_bytes:32,section_count:40,alignment:44,schema_version:48,inclusion_mask:52,snapshot_content_digest:56);
        layout!(fullmag_fdm_gpu_transport_checkpoint_export_request_v1,144,context_handle:32,snapshot_handle:64,accepted_sequence:96,cadence_id:104,destination_view_ptr:112,exact_capacity:120,expected_size:128,inclusion_mask:136,reserved1:140);
        layout!(fullmag_fdm_gpu_transport_checkpoint_export_result_v1,232,committed_bytes:32,payload_sha256:40,snapshot_digest:72,spin_digest:104,warm_start_digest:136,audit_sequence:168,snapshot_lineage_id:176,accepted_sequence:192,operation_audit_digest:200);
        layout!(fullmag_fdm_gpu_transport_checkpoint_import_request_v1,232,context_handle:32,source_view_ptr:64,expected_payload_sha256:72,device_uuid:104,build_digest:120,static_descriptor_digest:152,restore_policy:184,reserved1:188,expected_bytes:192,audit_parent_digest:200);
        layout!(fullmag_fdm_gpu_transport_checkpoint_restore_result_v1,232,snapshot_handle:32,snapshot_lineage_id:64,accepted_sequence:80,snapshot_content_digest:88,spin_digest:120,warm_start_digest:152,audit_sequence:184,restored_state:192,reserved1:196,operation_audit_digest:200);
        layout!(fullmag_fdm_gpu_transport_error_v1,176,status:32,record_id:36,field_offset:40,reserved1:44,requested_abi:48,available_abi:52,requested_struct:56,available_struct:60,requested_features:64,available_features:72,context_handle:80,snapshot_handle:112,attempt_id:144,diagnostic_ptr:152,diagnostic_capacity:160,diagnostic_length:168);
    }
    #[test]
    fn every_registry_and_flag_mask_rejects_its_first_unknown_value() {
        assert_eq!(FROZEN_U32_REGISTRIES_V1.len(), 20);
        for r in FROZEN_U32_REGISTRIES_V1 {
            for (i, v) in r.iter().enumerate() {
                assert_eq!(*v, i as u32)
            }
            assert!(!r.contains(&(r.len() as u32)));
        }
        for mask in FROZEN_U32_FLAG_LEGAL_MASKS_V1 {
            assert_eq!(mask, 0x3f);
            assert_eq!(mask & 0x40, 0)
        }
    }
    #[test]
    fn known_unsupported_values_remain_distinct_from_unknown_values() {
        const PRECISION: &[u32] = FROZEN_U32_REGISTRIES_V1[4];
        const SPIN_SOLVER_POLICY: &[u32] = FROZEN_U32_REGISTRIES_V1[7];
        assert!(PRECISION.contains(&2), "FP32 is a known ABI value");
        assert!(
            !PRECISION.contains(&3),
            "the first unknown precision stays outside the registry"
        );
        assert!(
            SPIN_SOLVER_POLICY.contains(&2),
            "block-Jacobi prototype is a known ABI value"
        );
        assert!(
            !SPIN_SOLVER_POLICY.contains(&3),
            "the first unknown spin policy stays outside the registry"
        );
    }
    #[test]
    fn typed_charge_payload_ids_are_closed_without_extending_the_frozen_manifest() {
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE, 0x04);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INVALID, 0);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY, 2);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 3);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1, 1);
        assert_eq!(FROZEN_U32_REGISTRIES_V1.len(), 20);
    }
}
