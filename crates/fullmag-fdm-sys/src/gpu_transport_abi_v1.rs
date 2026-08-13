//! Frozen, append-only FDM GPU transport ABI v1 records.

#![allow(non_camel_case_types)]
#![allow(non_snake_case)]

use crate::fullmag_fdm_backend;

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
record!(fullmag_fdm_gpu_transport_llg_binding_v1 {
    transport_context: fullmag_fdm_gpu_transport_context_handle_v1,
    charge_snapshot: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    accepted_sequence: u64,
    source_revision: u64,
    operator_revision: u64,
    relative_tolerance: f64,
    max_iterations: u64,
    reserved1: u64
});
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
record!(fullmag_fdm_gpu_transport_spin_cell_v1 {
    active: u32,
    conductor: u32,
    material_index: u32,
    reserved1: u32,
    spin_active: u32,
    torque_target: u32,
    region_id: u32,
    reserved2: u32,
    saturation_magnetization: f64
});
record!(fullmag_fdm_gpu_transport_spin_material_v1 {
    material_index: u32,
    reserved1: u32,
    conductivity: f64,
    material_revision: u64,
    spin_conductivity: f64,
    polarization: f64,
    spin_hall_angle: f64,
    spin_flip_length: f64,
    exchange_length: f64,
    dephasing_length: f64,
    spin_revision: u64
});
record!(fullmag_fdm_gpu_transport_spin_boundary_face_v1 {
    kind: u32,
    axis: u32,
    side: i32,
    outward_sign: i32,
    adjacent_cell: u64,
    canonical_face_index: u64,
    area: f64,
    potential_xyz: [f64; 3],
    source_id: u64
});
record!(fullmag_fdm_gpu_transport_spin_interface_v1 {
    kind: u32,
    axis: u32,
    orientation: i32,
    reserved1: u32,
    negative_cell: u64,
    positive_cell: u64,
    from_cell: u64,
    to_cell: u64,
    canonical_face_index: u64,
    area: f64,
    G_up: f64,
    G_down: f64,
    G_r: f64,
    G_i: f64,
    magnetization_xyz: [f64; 3],
    source_id: u64,
    topology_id: u64,
    charge_edge_enabled: u32,
    reserved2: u32
});
record!(fullmag_fdm_gpu_transport_spin_observation_record_v1 {
    kind: u32,
    axis: u32,
    orientation: i32,
    reserved1: u32,
    cell_index: u64,
    source_id: u64,
    topology_id: u64,
    canonical_face_index: u64,
    negative_cell: u64,
    positive_cell: u64,
    from_cell: u64,
    to_cell: u64,
    region_id: u32,
    reserved2: u32,
    charge_from_trace_v: f64,
    charge_to_trace_v: f64,
    charge_delta_trace_v: f64,
    lane0_xyz: [f64; 3],
    lane1_xyz: [f64; 3],
    lane2_xyz: [f64; 3],
    lane3_xyz: [f64; 3],
    lane4_xyz: [f64; 3],
    lane5_xyz: [f64; 3]
});
record!(fullmag_fdm_gpu_transport_charge_interface_trace_v1 {
    axis: u32,
    orientation: i32,
    reserved1: u32,
    reserved2: u32,
    source_id: u64,
    topology_id: u64,
    canonical_face_index: u64,
    negative_cell: u64,
    positive_cell: u64,
    from_cell: u64,
    to_cell: u64,
    from_trace_v: f64,
    to_trace_v: f64,
    delta_trace_v: f64,
    oriented_current_density: f64
});
record!(fullmag_fdm_gpu_transport_formula_ids_v1 {
    formula_id: u32,
    operator_id: u32,
    engine_id: u32,
    residual_id: u32,
    operator_revision: u64,
    reserved1: u64,
    spin_formula_id: u32,
    spin_operator_id: u32,
    electric_reconstruction_id: u32,
    interface_formula_id: u32,
    torque_operator_id: u32,
    spin_engine_id: u32,
    preconditioner_id: u32,
    spin_residual_id: u32,
    local_residual_id: u32,
    reserved2: u32,
    spin_operator_revision: u64,
    preconditioner_revision: u64,
    gamma_e: f64,
    gmres_restart: u64,
    reserved3: u64
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

pub const FULLMAG_FDM_GPU_TRANSPORT_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_BOOL_FALSE: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY: u64 = 0x01;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS: u64 = 0x02;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE: u64 = 0x04;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1: u64 = 0x20;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK: u64 = 0x40;
pub const FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64: u32 = 5;
pub const FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES: u32 = 6;
pub const FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_XYZ: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ: u32 = 5;
pub const FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY: u32 = 4;
pub const FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA: u32 = 4;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT: u32 = 5;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FORBIDDEN: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_ACCEPTED_STEP: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FINAL_STATE: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT: u32 = 9;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_ALL_V1: u32 = 0x3f;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN: u64 = 0x08;
pub const FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2: u64 = 0x10;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_SML_RESERVOIR_V2: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_REACTION: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_TORQUE: u32 = 2;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE: u32 = 3;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_INVALID: u32 = 0;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1: u32 = 1;
pub const FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1: u32 = 1;

extern "C" {
    pub fn fullmag_fdm_context_bind_gpu_transport_v1(
        context: *mut fullmag_fdm_backend,
        binding: *const fullmag_fdm_gpu_transport_llg_binding_v1,
    ) -> i32;
    pub fn fullmag_fdm_context_unbind_gpu_transport_v1(context: *mut fullmag_fdm_backend) -> i32;
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
    pub fn fullmag_fdm_gpu_transport_solve_steady_spin_v1(
        request: *const fullmag_fdm_gpu_steady_spin_solve_request_v1,
        result: *mut fullmag_fdm_gpu_steady_spin_solve_result_v1,
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
        layout!(fullmag_fdm_gpu_transport_llg_binding_v1,144,transport_context:32,charge_snapshot:64,accepted_sequence:96,source_revision:104,operator_revision:112,relative_tolerance:120,max_iterations:128,reserved1:136);
        layout!(fullmag_fdm_gpu_transport_buffer_view_v1,80,address:32,element_count:40,byte_stride:48,byte_length:56,element_type:64,pointer_space:68,component_order:72,reserved1:76);
        layout!(fullmag_fdm_gpu_transport_charge_cell_v1,48,active:32,conductor:36,material_index:40,reserved1:44);
        layout!(fullmag_fdm_gpu_transport_charge_material_v1,56,material_index:32,reserved1:36,conductivity:40,material_revision:48);
        layout!(fullmag_fdm_gpu_transport_charge_face_v1,88,kind:32,axis:36,side:40,outward_sign:44,adjacent_cell:48,canonical_face_index:56,area:64,value:72,source_id:80);
        layout!(fullmag_fdm_gpu_transport_charge_formula_ids_v1,64,formula_id:32,operator_id:36,engine_id:40,residual_id:44,operator_revision:48,reserved1:56);
        layout!(fullmag_fdm_gpu_transport_spin_cell_v1,72,active:32,conductor:36,material_index:40,reserved1:44,spin_active:48,torque_target:52,region_id:56,reserved2:60,saturation_magnetization:64);
        layout!(fullmag_fdm_gpu_transport_spin_material_v1,112,material_index:32,reserved1:36,conductivity:40,material_revision:48,spin_conductivity:56,polarization:64,spin_hall_angle:72,spin_flip_length:80,exchange_length:88,dephasing_length:96,spin_revision:104);
        layout!(fullmag_fdm_gpu_transport_spin_boundary_face_v1,104,kind:32,axis:36,side:40,outward_sign:44,adjacent_cell:48,canonical_face_index:56,area:64,potential_xyz:72,source_id:96);
        layout!(fullmag_fdm_gpu_transport_spin_interface_v1,176,kind:32,axis:36,orientation:40,reserved1:44,negative_cell:48,positive_cell:56,from_cell:64,to_cell:72,canonical_face_index:80,area:88,G_up:96,G_down:104,G_r:112,G_i:120,magnetization_xyz:128,source_id:152,topology_id:160,charge_edge_enabled:168,reserved2:172);
        layout!(fullmag_fdm_gpu_transport_spin_observation_record_v1,288,kind:32,axis:36,orientation:40,reserved1:44,cell_index:48,source_id:56,topology_id:64,canonical_face_index:72,negative_cell:80,positive_cell:88,from_cell:96,to_cell:104,region_id:112,reserved2:116,charge_from_trace_v:120,charge_to_trace_v:128,charge_delta_trace_v:136,lane0_xyz:144,lane1_xyz:168,lane2_xyz:192,lane3_xyz:216,lane4_xyz:240,lane5_xyz:264);
        layout!(fullmag_fdm_gpu_transport_charge_interface_trace_v1,136,axis:32,orientation:36,reserved1:40,reserved2:44,source_id:48,topology_id:56,canonical_face_index:64,negative_cell:72,positive_cell:80,from_cell:88,to_cell:96,from_trace_v:104,to_trace_v:112,delta_trace_v:120,oriented_current_density:128);
        layout!(fullmag_fdm_gpu_transport_formula_ids_v1,144,formula_id:32,operator_id:36,engine_id:40,residual_id:44,operator_revision:48,reserved1:56,spin_formula_id:64,spin_operator_id:68,electric_reconstruction_id:72,interface_formula_id:76,torque_operator_id:80,spin_engine_id:84,preconditioner_id:88,spin_residual_id:92,local_residual_id:96,reserved2:100,spin_operator_revision:104,preconditioner_revision:112,gamma_e:120,gmres_restart:128,reserved3:136);
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
        assert_eq!(
            FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1,
            1
        );
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1, 1);
        assert_eq!(
            FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1,
            1
        );
        assert_eq!(FROZEN_U32_REGISTRIES_V1.len(), 20);
    }

    #[test]
    fn public_charge_runner_constants_match_the_frozen_native_registry() {
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ABI_V1, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY, 0x01);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS, 0x02);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK, 0x40);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT, 2);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, 2);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S, 3);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA, 4);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT, 5);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FORBIDDEN, 0);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_ACCEPTED_STEP, 1);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FINAL_STATE, 2);
        assert_eq!(
            FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST,
            3
        );
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK, 0);
    }
    #[test]
    fn typed_spin_payload_ids_are_closed_without_extending_the_frozen_manifest() {
        let registries: &[&[u32]] = &[
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_SML_RESERVOIR_V2,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_REACTION,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_TORQUE,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1,
            ],
            &[
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_INVALID,
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1,
            ],
        ];
        for registry in registries {
            for (index, value) in registry.iter().enumerate() {
                assert_eq!(*value, index as u32);
            }
            assert!(!registry.contains(&(registry.len() as u32)));
        }
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN, 0x08);
        assert_eq!(FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2, 0x10);
        assert_eq!(FROZEN_U32_REGISTRIES_V1.len(), 20);
    }
}
