#ifndef FULLMAG_FDM_TRANSPORT_GPU_ABI_V1_H
#define FULLMAG_FDM_TRANSPORT_GPU_ABI_V1_H

#include <stdint.h>

#if defined(__cplusplus)
#define FULLMAG_GPU_ALIGN8 alignas(8)
#define FULLMAG_GPU_ALIGN8_FIELD
#else
/* C11 `_Alignas` cannot appear between `struct` and its tag. Aligning the
 * first member gives the containing record the same portable alignment. */
#define FULLMAG_GPU_ALIGN8
#define FULLMAG_GPU_ALIGN8_FIELD _Alignas(8)
#endif

#define FULLMAG_FDM_GPU_TRANSPORT_ABI_V1 1u
#define FULLMAG_FDM_GPU_TRANSPORT_COMMON_PREFIX_SIZE_V1 32u
#define FULLMAG_FDM_GPU_TRANSPORT_COMMON_PREFIX_ALIGNMENT_V1 8u
#define FULLMAG_FDM_GPU_TRANSPORT_KNOWN_GLOBAL_FEATURES_V1 UINT64_C(0x7f)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FLAGS_LEGAL_V1 UINT32_C(0x3f)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1 UINT32_C(0x3f)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER UINT32_C(0x01)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION UINT32_C(0x02)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED UINT32_C(0x04)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SCIENTIFIC_COMMIT UINT32_C(0x08)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL UINT32_C(0x10)
#define FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED UINT32_C(0x20)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_CHARGE_ARRAYS UINT32_C(0x01)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_CHARGE_OBSERVATIONS UINT32_C(0x02)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_SPIN_ARRAYS UINT32_C(0x04)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_SPIN_OBSERVATIONS_TORQUE UINT32_C(0x08)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_WARM_STARTS UINT32_C(0x10)
#define FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_CONTINUATION_META UINT32_C(0x20)

#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY UINT64_C(0x01)
#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS UINT64_C(0x02)
#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE UINT64_C(0x04)
#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN UINT64_C(0x08)
#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2 UINT64_C(0x10)
#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1 UINT64_C(0x20)
#define FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK UINT64_C(0x40)

#define FULLMAG_GPU_PREFIX FULLMAG_GPU_ALIGN8_FIELD uint32_t abi_version; uint32_t struct_version; uint32_t struct_size; uint32_t reserved_flags; uint64_t required_features; uint64_t reserved0

typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_context_handle_v1 { FULLMAG_GPU_ALIGN8_FIELD uint64_t registry_cookie; uint64_t slot, generation, type_tag; } fullmag_fdm_gpu_transport_context_handle_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_charge_snapshot_handle_v1 { FULLMAG_GPU_ALIGN8_FIELD uint64_t registry_cookie; uint64_t slot, generation, type_tag; } fullmag_fdm_gpu_charge_snapshot_handle_v1;

enum {
    FULLMAG_FDM_GPU_TRANSPORT_BOOL_FALSE = 0,
    FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE = 1,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U32 = 2,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U64 = 3,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_I32 = 4,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64 = 5,
    FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES = 6,
    FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR = 1,
    FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_XYZ = 2,
    FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ = 3,
    FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ROW_MAJOR_Q_IA = 4,
    FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ = 5,
    FULLMAG_FDM_GPU_TRANSPORT_PRECISION_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE = 1,
    FULLMAG_FDM_GPU_TRANSPORT_PRECISION_SINGLE_KNOWN_UNSUPPORTED = 2,
    FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY = 1,
    FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY = 2,
    FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY = 3,
    FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY = 4,
    FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY = 2,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING = 3,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK = 2,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL = 3,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2 = 2,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_SML_RESERVOIR_V2 = 3,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_REACTION = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_TORQUE = 2,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE = 3,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_BLOCK_JACOBI_PROTOTYPE_V1 = 2,
    FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT = 1,
    FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT = 2,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_UNSET = 0,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS = 2,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_NON_FINITE = 3,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE = 4,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_PHYSICAL_BALANCE_FAILURE = 5,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CANCELLED = 6,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_NONE = 0,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D = 1,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H = 2,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL = 3,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D = 4,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D = 1,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H = 2,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H = 3,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H = 4,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D = 5,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE = 6,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_EVENT_WAIT = 7,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT = 8,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D = 9,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CONTROL_STATE_H2D = 10,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS = 0,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED = 1,
    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED = 2,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V = 1,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C = 2,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S = 3,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA = 4,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT = 5,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_CHARGE_INTERFACE_TRACE = 6,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TRANSPORT_OBSERVATIONS = 7,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FORBIDDEN = 0,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_ACCEPTED_STEP = 1,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FINAL_STATE = 2,
    FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST = 3,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_INVALID = 0,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_NOT_RESTORED = 0,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_CHARGE_ACCEPTED = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED = 2,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID = 1,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE = 2,
    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_SPIN = 3,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK = 0,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED = 1,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_INCOMPATIBLE_ABI = 2,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR = 3,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_POINTER_SPACE = 4,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE = 5,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY = 6,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_NONCONVERGED = 7,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_BALANCE_FAILURE = 8,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT = 9,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_STRICT_GPU_RESIDENCY_VIOLATION = 10,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR = 11,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_LIVE_SNAPSHOT = 12,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED = 13,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES = 14,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE = 15,
    FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE = 16,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_NONE = 0,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_BUFFER_VIEW_V1 = 1,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CONTEXT_CREATE_REQUEST_V1 = 2,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CONTEXT_CREATE_RESULT_V1 = 3,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_STATIC_DESCRIPTOR_V1 = 4,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHARGE_SOLVE_REQUEST_V1 = 5,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHARGE_SOLVE_RESULT_V1 = 6,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHARGE_SNAPSHOT_INFO_V1 = 7,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_STEADY_SPIN_SOLVE_REQUEST_V1 = 8,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_STEADY_SPIN_SOLVE_RESULT_V1 = 9,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_TRANSPORT_TELEMETRY_V1 = 10,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_ARTIFACT_REQUEST_V1 = 11,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_SIZE_REQUEST_V1 = 12,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_SIZE_RESULT_V1 = 13,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_EXPORT_REQUEST_V1 = 14,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_EXPORT_RESULT_V1 = 15,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_IMPORT_REQUEST_V1 = 16,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_RESTORE_RESULT_V1 = 17,
    FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_TRANSPORT_ERROR_V1 = 18
};

typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_buffer_view_v1 { FULLMAG_GPU_PREFIX; uint64_t address, element_count, byte_stride, byte_length; uint32_t element_type, pointer_space, component_order, reserved1; } fullmag_fdm_gpu_transport_buffer_view_v1;
/*
 * Append-only payload records owned by the v1 transport descriptor.  They are
 * deliberately not members of the frozen 18-record operation manifest: each
 * payload carries the same typed/versioned prefix and is selected by an
 * enclosing buffer view.  A consumer must accept a larger struct_size and
 * ignore an unknown tail, but must reject a smaller record or non-zero
 * reserved fields.
 */
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_charge_cell_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t active, conductor, material_index, reserved1;
} fullmag_fdm_gpu_transport_charge_cell_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_charge_material_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t material_index, reserved1;
    double conductivity;
    uint64_t material_revision;
} fullmag_fdm_gpu_transport_charge_material_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_charge_face_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t kind, axis;
    int32_t side, outward_sign;
    uint64_t adjacent_cell, canonical_face_index;
    double area, value;
    uint64_t source_id;
} fullmag_fdm_gpu_transport_charge_face_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_charge_formula_ids_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t formula_id, operator_id, engine_id, residual_id;
    uint64_t operator_revision, reserved1;
} fullmag_fdm_gpu_transport_charge_formula_ids_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_spin_cell_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t active, conductor, material_index, reserved1;
    uint32_t spin_active, torque_target, region_id, reserved2;
    double saturation_magnetization;
} fullmag_fdm_gpu_transport_spin_cell_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_spin_material_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t material_index, reserved1;
    double conductivity;
    uint64_t material_revision;
    double spin_conductivity, polarization, spin_hall_angle;
    double spin_flip_length, exchange_length, dephasing_length;
    uint64_t spin_revision;
} fullmag_fdm_gpu_transport_spin_material_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_spin_boundary_face_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t kind, axis;
    int32_t side, outward_sign;
    uint64_t adjacent_cell, canonical_face_index;
    double area, potential_xyz[3];
    uint64_t source_id;
} fullmag_fdm_gpu_transport_spin_boundary_face_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_spin_interface_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t kind, axis;
    int32_t orientation;
    uint32_t reserved1;
    uint64_t negative_cell, positive_cell, from_cell, to_cell;
    uint64_t canonical_face_index;
    double area, G_up, G_down, G_r, G_i, magnetization_xyz[3];
    uint64_t source_id, topology_id;
    uint32_t charge_edge_enabled, reserved2;
} fullmag_fdm_gpu_transport_spin_interface_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_spin_observation_record_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t kind, axis;
    int32_t orientation;
    uint32_t reserved1;
    uint64_t cell_index, source_id, topology_id, canonical_face_index;
    uint64_t negative_cell, positive_cell, from_cell, to_cell;
    uint32_t region_id, reserved2;
    double charge_from_trace_v, charge_to_trace_v, charge_delta_trace_v;
    double lane0_xyz[3], lane1_xyz[3], lane2_xyz[3];
    double lane3_xyz[3], lane4_xyz[3], lane5_xyz[3];
} fullmag_fdm_gpu_transport_spin_observation_record_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_charge_interface_trace_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t axis;
    int32_t orientation;
    uint32_t reserved1, reserved2;
    uint64_t source_id, topology_id, canonical_face_index;
    uint64_t negative_cell, positive_cell, from_cell, to_cell;
    double from_trace_v, to_trace_v, delta_trace_v, oriented_current_density;
} fullmag_fdm_gpu_transport_charge_interface_trace_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_formula_ids_v1 {
    FULLMAG_GPU_PREFIX;
    uint32_t formula_id, operator_id, engine_id, residual_id;
    uint64_t operator_revision, reserved1;
    uint32_t spin_formula_id, spin_operator_id, electric_reconstruction_id;
    uint32_t interface_formula_id, torque_operator_id, spin_engine_id;
    uint32_t preconditioner_id, spin_residual_id, local_residual_id, reserved2;
    uint64_t spin_operator_revision, preconditioner_revision;
    double gamma_e;
    uint64_t gmres_restart, reserved3;
} fullmag_fdm_gpu_transport_formula_ids_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_context_create_request_v1 { FULLMAG_GPU_PREFIX; uint8_t device_uuid[16]; int32_t device_ordinal; uint32_t precision, strict_residency, deterministic; uint64_t allocator_limit, workspace_limit; uint32_t stream_policy, reserved1; uint64_t requested_device_features, reserved2; } fullmag_fdm_gpu_transport_context_create_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_context_create_result_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; uint8_t device_uuid[16]; uint32_t compute_major, compute_minor, cuda_runtime, cuda_driver; uint8_t build_digest[32]; uint64_t supported_features; } fullmag_fdm_gpu_transport_context_create_result_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_static_descriptor_v1 { FULLMAG_GPU_PREFIX; uint64_t grid[3]; double cell_size[3]; uint64_t descriptor_revision, source_revision; uint8_t descriptor_digest[32]; uint64_t masks_view_ptr, materials_view_ptr, interfaces_view_ptr, charge_faces_view_ptr, spin_faces_view_ptr, formula_ids_view_ptr, reserved1; } fullmag_fdm_gpu_transport_static_descriptor_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_charge_solve_request_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; uint32_t solver_policy, gauge_policy; uint64_t attempt_id, stage_id, source_revision, static_revision; double relative_tolerance; uint64_t max_iterations; } fullmag_fdm_gpu_charge_solve_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_charge_solve_result_v1 { FULLMAG_GPU_PREFIX; uint64_t provisional_generation, iterations; uint32_t reason, reserved1; double algebraic_residual, physical_residual, component_balance, electrode_balance; uint64_t transfer_count, transfer_bytes, peak_bytes; uint8_t candidate_digest[32]; } fullmag_fdm_gpu_charge_solve_result_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_charge_snapshot_info_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; uint8_t snapshot_lineage_id[16]; uint64_t accepted_sequence, local_generation, source_revision, operator_revision; uint8_t snapshot_content_digest[32], convergence_digest[32]; uint64_t device_bytes; } fullmag_fdm_gpu_charge_snapshot_info_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_steady_spin_solve_request_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; uint64_t accepted_sequence, m_stage_view_ptr, torque_view_ptr; uint32_t solver_policy, reserved1; uint64_t attempt_id, stage_id, source_revision, operator_revision; double relative_tolerance; uint64_t max_iterations; } fullmag_fdm_gpu_steady_spin_solve_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_steady_spin_solve_result_v1 { FULLMAG_GPU_PREFIX; uint64_t iterations; uint32_t reason, reserved1; double algebraic_residual, local_balance, global_balance, interface_balance, torque_balance; uint64_t transfer_count, transfer_bytes, peak_bytes; uint8_t snapshot_content_digest[32], deterministic_compute_digest[32]; } fullmag_fdm_gpu_steady_spin_solve_result_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_telemetry_v1 { FULLMAG_GPU_PREFIX; uint64_t audit_sequence; uint32_t direction, reason, status, event_flags; uint64_t bytes, count, attempt_id, stage_id, iteration, stream_id, event_id; uint8_t operation_audit_digest[32], scientific_continuation_digest[32]; } fullmag_fdm_gpu_transport_telemetry_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_artifact_request_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; uint32_t field_id, cadence; uint64_t range_begin, range_count, destination_view_ptr, expected_bytes, accepted_sequence; } fullmag_fdm_gpu_transport_artifact_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_checkpoint_size_request_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; uint64_t accepted_sequence; uint32_t schema_version, inclusion_mask; uint8_t static_descriptor_digest[32]; } fullmag_fdm_gpu_transport_checkpoint_size_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_checkpoint_size_result_v1 { FULLMAG_GPU_PREFIX; uint64_t required_bytes; uint32_t section_count, alignment, schema_version, inclusion_mask; uint8_t snapshot_content_digest[32]; } fullmag_fdm_gpu_transport_checkpoint_size_result_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_checkpoint_export_request_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; uint64_t accepted_sequence, cadence_id, destination_view_ptr, exact_capacity, expected_size; uint32_t inclusion_mask, reserved1; } fullmag_fdm_gpu_transport_checkpoint_export_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_checkpoint_export_result_v1 { FULLMAG_GPU_PREFIX; uint64_t committed_bytes; uint8_t payload_sha256[32], snapshot_digest[32], spin_digest[32], warm_start_digest[32]; uint64_t audit_sequence; uint8_t snapshot_lineage_id[16]; uint64_t accepted_sequence; uint8_t operation_audit_digest[32]; } fullmag_fdm_gpu_transport_checkpoint_export_result_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_checkpoint_import_request_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; uint64_t source_view_ptr; uint8_t expected_payload_sha256[32], device_uuid[16], build_digest[32], static_descriptor_digest[32]; uint32_t restore_policy, reserved1; uint64_t expected_bytes; uint8_t audit_parent_digest[32]; } fullmag_fdm_gpu_transport_checkpoint_import_request_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 { FULLMAG_GPU_PREFIX; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; uint8_t snapshot_lineage_id[16]; uint64_t accepted_sequence; uint8_t snapshot_content_digest[32], spin_digest[32], warm_start_digest[32]; uint64_t audit_sequence; uint32_t restored_state, reserved1; uint8_t operation_audit_digest[32]; } fullmag_fdm_gpu_transport_checkpoint_restore_result_v1;
typedef struct FULLMAG_GPU_ALIGN8 fullmag_fdm_gpu_transport_error_v1 { FULLMAG_GPU_PREFIX; uint32_t status, record_id, field_offset, reserved1, requested_abi, available_abi, requested_struct, available_struct; uint64_t requested_features, available_features; fullmag_fdm_gpu_transport_context_handle_v1 context_handle; fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle; uint64_t attempt_id, diagnostic_ptr, diagnostic_capacity, diagnostic_length; } fullmag_fdm_gpu_transport_error_v1;

typedef struct fullmag_fdm_gpu_transport_layout_record_v1 { uint32_t record_id, min_size_v1; uint64_t known_features_v1; } fullmag_fdm_gpu_transport_layout_record_v1;
typedef struct fullmag_fdm_gpu_transport_layout_manifest_v1 { uint32_t abi_version, record_count; fullmag_fdm_gpu_transport_layout_record_v1 records[18]; } fullmag_fdm_gpu_transport_layout_manifest_v1;

#ifdef __cplusplus
extern "C" {
#endif
const fullmag_fdm_gpu_transport_layout_manifest_v1 *fullmag_fdm_gpu_transport_layout_manifest_get_v1(void);
uint32_t fullmag_fdm_gpu_transport_context_create_v1(
    const fullmag_fdm_gpu_transport_context_create_request_v1 *request,
    fullmag_fdm_gpu_transport_context_create_result_v1 *result);
uint32_t fullmag_fdm_gpu_transport_context_destroy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context);
uint32_t fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_transport_static_descriptor_v1 *descriptor);
uint32_t fullmag_fdm_gpu_charge_snapshot_destroy_v1(
    fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot);
uint32_t fullmag_fdm_gpu_transport_checkpoint_validate_v1(
    const void *payload, uint64_t payload_size, uint32_t *validation_kind);
uint32_t fullmag_fdm_gpu_transport_solve_charge_v1(
    const fullmag_fdm_gpu_charge_solve_request_v1 *request,
    fullmag_fdm_gpu_charge_solve_result_v1 *result);
uint32_t fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t provisional_generation,
    fullmag_fdm_gpu_charge_snapshot_info_v1 *snapshot_info);
uint32_t fullmag_fdm_gpu_transport_solve_steady_spin_v1(
    const fullmag_fdm_gpu_steady_spin_solve_request_v1 *request,
    fullmag_fdm_gpu_steady_spin_solve_result_v1 *result);
uint32_t fullmag_fdm_gpu_transport_query_telemetry_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t cursor,
    fullmag_fdm_gpu_transport_telemetry_v1 *records,
    uint64_t record_capacity,
    uint64_t *record_count);
uint32_t fullmag_fdm_gpu_transport_readback_artifact_v1(
    const fullmag_fdm_gpu_transport_artifact_request_v1 *request);
uint32_t fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
    const fullmag_fdm_gpu_transport_checkpoint_size_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 *result);
uint32_t fullmag_fdm_gpu_transport_checkpoint_export_v1(
    const fullmag_fdm_gpu_transport_checkpoint_export_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 *result);
uint32_t fullmag_fdm_gpu_transport_checkpoint_import_v1(
    const fullmag_fdm_gpu_transport_checkpoint_import_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 *result);
/* Phase-1 contract hooks. They create no scientific state and are not solver APIs. */
uint32_t fullmag_fdm_gpu_transport_test_snapshot_create_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag_fdm_gpu_charge_snapshot_handle_v1 *snapshot);
uint32_t fullmag_fdm_gpu_transport_test_snapshot_retain_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot);
uint32_t fullmag_fdm_gpu_transport_test_retire_slot_v1(uint64_t slot);
uint32_t fullmag_fdm_gpu_transport_test_charge_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *hierarchy_build_count,
    uint64_t *hierarchy_cache_hit_count,
    uint64_t *amg_apply_count,
    uint64_t *host_fallback_count,
    uint64_t *fine_unknown_count,
    uint64_t *coarse_unknown_count,
    uint32_t *hierarchy_levels,
    uint8_t hierarchy_digest[32]);
uint32_t fullmag_fdm_gpu_transport_test_charge_hierarchy_readback_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *aggregate, uint64_t aggregate_count,
    double *coarse_diagonal, uint64_t coarse_count,
    double *structured_edge_weight, uint64_t edge_count);
uint32_t fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *promotion_count, uint64_t *use_count, uint64_t *cells,
    uint64_t *descriptor_revision, uint64_t *source_revision, uint32_t *valid);
uint32_t fullmag_fdm_gpu_transport_test_charge_warm_start_readback_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, double *potential,
    uint64_t count);
#ifdef __cplusplus
}
#endif

#undef FULLMAG_GPU_PREFIX
#undef FULLMAG_GPU_ALIGN8_FIELD
#undef FULLMAG_GPU_ALIGN8
#endif
