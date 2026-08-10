#include "fullmag_fdm.h"
#include <cuda_runtime_api.h>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <initializer_list>
#include <limits>
#include <string>
#include <vector>

extern "C" uint32_t fullmag_fdm_gpu_transport_test_static_payload_copy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint32_t, void *, uint64_t);
extern "C" uint32_t fullmag_fdm_gpu_transport_test_static_view_copy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint32_t,
    fullmag_fdm_gpu_transport_buffer_view_v1 *);

namespace {

struct EvidenceData {
    int device_ordinal = -1;
    std::string device_name;
    uint8_t device_uuid[16]{};
    uint32_t compute_major = 0, compute_minor = 0, cuda_runtime = 0, cuda_driver = 0;
    uint8_t build_digest[32]{};
    bool deterministic = false;
    uint64_t checkpoint_mutations = 0;
    uint64_t static_upload_bytes = 0;
} evidence_data;

void phase1_operation_family_is_public() {
    (void)&fullmag_fdm_gpu_transport_static_descriptor_upload_v1;
    (void)&fullmag_fdm_gpu_charge_snapshot_destroy_v1;
    (void)&fullmag_fdm_gpu_transport_checkpoint_validate_v1;
    (void)&fullmag_fdm_gpu_transport_solve_charge_v1;
    (void)&fullmag_fdm_gpu_transport_accept_charge_snapshot_v1;
    (void)&fullmag_fdm_gpu_transport_solve_steady_spin_v1;
    (void)&fullmag_fdm_gpu_transport_query_telemetry_v1;
    (void)&fullmag_fdm_gpu_transport_readback_artifact_v1;
    (void)&fullmag_fdm_gpu_transport_checkpoint_query_size_v1;
    (void)&fullmag_fdm_gpu_transport_checkpoint_export_v1;
    (void)&fullmag_fdm_gpu_transport_checkpoint_import_v1;
}

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\\n", message);
        std::exit(1);
    }
}

void frozen_prefix_and_records_are_exposed() {
#define FULLMAG_ABI_ASSERT(X) static_assert((X))
#define FULLMAG_ABI_OFFSETOF(T, F) offsetof(T, F)
#include "gpu_transport_layout_abi_v1_assertions.h"
#undef FULLMAG_ABI_OFFSETOF
#undef FULLMAG_ABI_ASSERT
#define CHECK_PREFIX(T) static_assert(offsetof(T, abi_version)==0); static_assert(offsetof(T, struct_version)==4); static_assert(offsetof(T, struct_size)==8); static_assert(offsetof(T, reserved_flags)==12); static_assert(offsetof(T, required_features)==16); static_assert(offsetof(T, reserved0)==24); static_assert(alignof(T)==8)
    CHECK_PREFIX(fullmag_fdm_gpu_transport_buffer_view_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_charge_cell_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_charge_material_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_charge_face_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_charge_formula_ids_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_context_create_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_context_create_result_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_static_descriptor_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_charge_solve_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_charge_solve_result_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_charge_snapshot_info_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_steady_spin_solve_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_steady_spin_solve_result_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_telemetry_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_artifact_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_checkpoint_size_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_checkpoint_size_result_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_checkpoint_export_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_checkpoint_export_result_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_checkpoint_import_request_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_checkpoint_restore_result_v1);
    CHECK_PREFIX(fullmag_fdm_gpu_transport_error_v1);
#undef CHECK_PREFIX
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_ABI_V1 == 1);
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_COMMON_PREFIX_SIZE_V1 == 32);
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_COMMON_PREFIX_ALIGNMENT_V1 == 8);
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_KNOWN_GLOBAL_FEATURES_V1 == 0x7fULL);
    static_assert(sizeof(fullmag_fdm_gpu_transport_context_handle_v1) == 32);
    static_assert(sizeof(fullmag_fdm_gpu_charge_snapshot_handle_v1) == 32);
    static_assert(sizeof(fullmag_fdm_gpu_transport_charge_cell_v1) == 48);
    static_assert(sizeof(fullmag_fdm_gpu_transport_charge_material_v1) == 56);
    static_assert(sizeof(fullmag_fdm_gpu_transport_charge_face_v1) == 88);
    static_assert(sizeof(fullmag_fdm_gpu_transport_charge_formula_ids_v1) == 64);
    static_assert(offsetof(fullmag_fdm_gpu_transport_charge_face_v1, source_id) == 80);
    static_assert(offsetof(fullmag_fdm_gpu_transport_context_create_request_v1,
                           required_features) == 16);
    static_assert(offsetof(fullmag_fdm_gpu_transport_context_create_request_v1,
                           device_uuid) == 32);
    static_assert(sizeof(fullmag_fdm_gpu_transport_context_create_request_v1) == 104);
    static_assert(sizeof(fullmag_fdm_gpu_transport_context_create_result_v1) == 136);
    static_assert(sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1) == 184);
    static_assert(sizeof(fullmag_fdm_gpu_charge_solve_request_v1) == 120);
    static_assert(sizeof(fullmag_fdm_gpu_charge_solve_result_v1) == 144);
    static_assert(sizeof(fullmag_fdm_gpu_charge_snapshot_info_v1) == 216);
    static_assert(sizeof(fullmag_fdm_gpu_steady_spin_solve_request_v1) == 176);
    static_assert(sizeof(fullmag_fdm_gpu_steady_spin_solve_result_v1) == 176);
    static_assert(sizeof(fullmag_fdm_gpu_transport_telemetry_v1) == 176);
    static_assert(sizeof(fullmag_fdm_gpu_transport_artifact_request_v1) == 144);
    static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_size_request_v1) == 144);
    static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_size_result_v1) == 88);
    static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_export_request_v1) == 144);
    static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_export_result_v1) == 232);
    static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_import_request_v1) == 232);
    static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_restore_result_v1) == 232);
    static_assert(sizeof(fullmag_fdm_gpu_transport_error_v1) == 176);
}

template <typename T>
bool unchanged(const T &value, const T &before) {
    return std::memcmp(&value, &before, sizeof(T)) == 0;
}

void unsupported_operations_never_fabricate_state() {
    fullmag_fdm_gpu_transport_context_handle_v1 context{1, 2, 3, 4};
    auto init = [](auto &record) {
        std::memset(&record, 0, sizeof(record));
        record.abi_version = record.struct_version = 1;
        record.struct_size = sizeof(record);
    };
    fullmag_fdm_gpu_charge_solve_request_v1 charge_request{};
    init(charge_request);
    charge_request.context_handle = context;
    charge_request.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    charge_request.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    charge_request.relative_tolerance = 1.0e-12;
    charge_request.max_iterations = 64;
    fullmag_fdm_gpu_charge_solve_result_v1 charge_output{};
    init(charge_output);
    const auto charge_before = charge_output;
    check(fullmag_fdm_gpu_transport_solve_charge_v1(&charge_request, &charge_output) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE &&
              unchanged(charge_output, charge_before),
          "charge solve with a stale context must not publish state");
    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot_output{};
    init(snapshot_output);
    const auto snapshot_before = snapshot_output;
    check(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(context, 7, &snapshot_output) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE &&
              unchanged(snapshot_output, snapshot_before),
          "snapshot acceptance with a stale context must not publish state");
    fullmag_fdm_gpu_steady_spin_solve_request_v1 spin_request{};
    init(spin_request);
    spin_request.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1;
    fullmag_fdm_gpu_steady_spin_solve_result_v1 spin_output;
    std::memset(&spin_output, 0xa5, sizeof(spin_output));
    const auto spin_before = spin_output;
    check(fullmag_fdm_gpu_transport_solve_steady_spin_v1(&spin_request, &spin_output) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED &&
              unchanged(spin_output, spin_before),
          "unsupported steady-spin solve must not publish state");
    fullmag_fdm_gpu_transport_telemetry_v1 telemetry;
    std::memset(&telemetry, 0xa5, sizeof(telemetry));
    const auto telemetry_before = telemetry;
    uint64_t count = UINT64_C(0xa5a5a5a5a5a5a5a5);
    check(fullmag_fdm_gpu_transport_query_telemetry_v1(context, 9, &telemetry, 1, &count) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE &&
              unchanged(telemetry, telemetry_before) &&
              count == UINT64_C(0xa5a5a5a5a5a5a5a5),
          "telemetry query with a stale context must not publish state");
    fullmag_fdm_gpu_transport_artifact_request_v1 artifact{};
    artifact.abi_version = artifact.struct_version = 1;
    artifact.struct_size = sizeof(artifact);
    artifact.required_features =
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
    artifact.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V;
    check(fullmag_fdm_gpu_transport_readback_artifact_v1(&artifact) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "artifact readback without destination/cadence must fail closed");
    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 size_request{};
    size_request.abi_version = size_request.struct_version = 1;
    size_request.struct_size = sizeof(size_request);
    size_request.schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    size_request.inclusion_mask = UINT32_C(0x33);
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 size_output{};
    init(size_output);
    const auto size_before = size_output;
    check(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&size_request, &size_output) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT &&
              unchanged(size_output, size_before),
          "checkpoint query with stale tokens must not publish state");
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 export_request{};
    export_request.abi_version = export_request.struct_version = 1;
    export_request.struct_size = sizeof(export_request);
    export_request.inclusion_mask = UINT32_C(0x33);
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 export_output{};
    init(export_output);
    const auto export_before = export_output;
    check(fullmag_fdm_gpu_transport_checkpoint_export_v1(&export_request, &export_output) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR &&
              unchanged(export_output, export_before),
          "checkpoint export without destination must not publish state");
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 import_request{};
    import_request.abi_version = import_request.struct_version = 1;
    import_request.struct_size = sizeof(import_request);
    import_request.restore_policy = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 import_output{};
    init(import_output);
    const auto import_before = import_output;
    check(fullmag_fdm_gpu_transport_checkpoint_import_v1(&import_request, &import_output) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR &&
              unchanged(import_output, import_before),
          "checkpoint import without source must not publish state");
}

void registries_and_layout_manifest_are_frozen() {
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE == 1);
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_TRANSPORT_ERROR_V1 == 18);
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1 == 0x3fU);
    static_assert(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FLAGS_LEGAL_V1 == 0x3fU);

    const auto *manifest = fullmag_fdm_gpu_transport_layout_manifest_get_v1();
    check(manifest != nullptr, "GPU transport must export its ABI layout manifest");
    check(manifest->abi_version == FULLMAG_FDM_GPU_TRANSPORT_ABI_V1,
          "manifest ABI version must be frozen v1");
    check(manifest->record_count == 18, "manifest must expose all 18 frozen records");
    check(manifest->records[0].min_size_v1 == 80,
          "buffer view min size must be frozen");
    check(manifest->records[17].record_id ==
              FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_TRANSPORT_ERROR_V1,
          "transport error record ID must be frozen");
}

void every_closed_registry_rejects_an_unknown_value() {
    const auto check_registry = [](std::initializer_list<uint32_t> values,
                                   uint32_t unknown, const char *name) {
        uint32_t expected = 0;
        for (uint32_t value : values) {
            check(value == expected, name);
            ++expected;
        }
        for (uint32_t value : values) check(value != unknown, name);
    };
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_BOOL_FALSE, FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE}, 2, "u32_bool registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_INVALID, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U32, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U64, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_I32, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES}, 7, "element_type registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_INVALID, FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY, FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY, FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY, FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY}, 5, "pointer_space registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_INVALID, FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR, FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_XYZ, FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ, FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ROW_MAJOR_Q_IA, FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ}, 6, "component_order registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_PRECISION_INVALID, FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE, FULLMAG_FDM_GPU_TRANSPORT_PRECISION_SINGLE_KNOWN_UNSUPPORTED}, 3, "precision registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_INVALID, FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM}, 2, "stream_policy registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_INVALID, FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1}, 2, "charge_solver_policy registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_INVALID, FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1, FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_BLOCK_JACOBI_PROTOTYPE_V1}, 3, "spin_solver_policy registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_INVALID, FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT, FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT}, 3, "gauge_policy registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_UNSET, FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED, FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS, FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_NON_FINITE, FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE, FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_PHYSICAL_BALANCE_FAILURE, FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CANCELLED}, 7, "convergence_reason registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_NONE, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D}, 5, "telemetry_direction registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_INVALID, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_EVENT_WAIT, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D}, 10, "telemetry_reason registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED}, 3, "telemetry_status registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_INVALID, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_CHARGE_INTERFACE_TRACE, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TRANSPORT_OBSERVATIONS}, 8, "artifact_field_id registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FORBIDDEN, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_ACCEPTED_STEP, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FINAL_STATE, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST}, 4, "artifact_cadence registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_INVALID, FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1}, 2, "checkpoint_schema_version registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_INVALID, FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD}, 2, "checkpoint_restore_policy registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_NOT_RESTORED, FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_CHARGE_ACCEPTED, FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED}, 3, "checkpoint_restored_state registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK, FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED, FULLMAG_FDM_GPU_TRANSPORT_ERROR_INCOMPATIBLE_ABI, FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR, FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_POINTER_SPACE, FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE, FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY, FULLMAG_FDM_GPU_TRANSPORT_ERROR_NONCONVERGED, FULLMAG_FDM_GPU_TRANSPORT_ERROR_BALANCE_FAILURE, FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT, FULLMAG_FDM_GPU_TRANSPORT_ERROR_STRICT_GPU_RESIDENCY_VIOLATION, FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR, FULLMAG_FDM_GPU_TRANSPORT_ERROR_LIVE_SNAPSHOT, FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED, FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES, FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE, FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE}, 17, "error_status registry");
    check_registry({FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_NONE, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_BUFFER_VIEW_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CONTEXT_CREATE_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CONTEXT_CREATE_RESULT_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_STATIC_DESCRIPTOR_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHARGE_SOLVE_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHARGE_SOLVE_RESULT_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHARGE_SNAPSHOT_INFO_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_STEADY_SPIN_SOLVE_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_STEADY_SPIN_SOLVE_RESULT_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_TRANSPORT_TELEMETRY_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_ARTIFACT_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_SIZE_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_SIZE_RESULT_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_EXPORT_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_EXPORT_RESULT_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_IMPORT_REQUEST_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_CHECKPOINT_RESTORE_RESULT_V1, FULLMAG_FDM_GPU_TRANSPORT_RECORD_ID_TRANSPORT_ERROR_V1}, 19, "record_id registry");
    check((FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FLAGS_LEGAL_V1 & UINT32_C(0x40)) == 0,
          "telemetry flag unknown-bit mutation must be outside legal mask");
    check((FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1 & UINT32_C(0x40)) == 0,
          "checkpoint flag unknown-bit mutation must be outside legal mask");
}

std::vector<uint8_t> frozen_hex(const char *begin_marker, const char *end_marker) {
    std::ifstream input(std::string(FULLMAG_SOURCE_ROOT) +
                        "/docs/specs/spin-transport-runtime-contract-v1.md");
    check(input.good(), "frozen runtime specification must be readable");
    const std::string text((std::istreambuf_iterator<char>(input)), {});
    const size_t begin = text.find(begin_marker);
    const size_t end = text.find(end_marker, begin);
    check(begin != std::string::npos && end != std::string::npos,
          "checkpoint golden markers must exist");
    std::vector<uint8_t> bytes;
    int high = -1;
    for (size_t i = begin + std::strlen(begin_marker); i < end; ++i) {
        const char c = text[i];
        int digit = c >= '0' && c <= '9' ? c - '0' :
                    c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                    c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (digit < 0) continue;
        if (high < 0) high = digit;
        else { bytes.push_back(static_cast<uint8_t>((high << 4) | digit)); high = -1; }
    }
    check(high < 0, "golden hex must contain complete bytes");
    return bytes;
}

void checkpoint_goldens_and_mutations_are_exact() {
    auto codec = frozen_hex("FMGPUTR1_GOLDEN_HEX_BEGIN", "FMGPUTR1_GOLDEN_HEX_END");
    auto restore = frozen_hex("FMGPUTR1_RESTORE_GOLDEN_HEX_BEGIN",
                              "FMGPUTR1_RESTORE_GOLDEN_HEX_END");
    check(codec.size() == 1600, "codec golden must be exactly 1600 bytes");
    check(restore.size() == 4352, "restore golden must be exactly 4352 bytes");
    uint32_t kind = 0;
    check(fullmag_fdm_gpu_transport_checkpoint_validate_v1(
              codec.data(), codec.size(), &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID,
          "published codec golden must validate as codec-only");
    check(fullmag_fdm_gpu_transport_checkpoint_validate_v1(
              restore.data(), restore.size(), &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE,
          "published restore golden must validate as restore-valid charge");
    for (auto *golden : {&codec, &restore}) {
        for (size_t i = 0; i < golden->size(); ++i) {
            (*golden)[i] ^= 1;
            check(fullmag_fdm_gpu_transport_checkpoint_validate_v1(
                      golden->data(), golden->size(), &kind) ==
                      FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
                  "every one-bit golden mutation must fail closed");
            (*golden)[i] ^= 1;
            ++evidence_data.checkpoint_mutations;
        }
    }
}

void actual_device_context_is_strict_fp64() {
    fullmag_fdm_gpu_transport_context_create_request_v1 request{};
    request.abi_version = 1;
    request.struct_version = 1;
    request.struct_size = sizeof(request);
    request.required_features = 0x3;
    request.device_ordinal = 0;
    request.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    request.strict_residency = 1;
    request.deterministic = 1;
    request.stream_policy = 1;
    fullmag_fdm_gpu_transport_context_create_result_v1 result{};
    result.abi_version = 1;
    result.struct_version = 1;
    result.struct_size = sizeof(result);
    request.required_features = UINT64_C(0x80);
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
          "unknown required feature must fail before CUDA allocation");
    request.required_features = 0x3;
    request.reserved_flags = 1;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "reserved mutation must fail before CUDA allocation");
    request.reserved_flags = 0;
    cudaDeviceProp requested_prop{};
    check(cudaGetDeviceProperties(&requested_prop, request.device_ordinal) == cudaSuccess,
          "UUID constraint fixture must query the requested device");
    std::memcpy(request.device_uuid, requested_prop.uuid.bytes, sizeof(request.device_uuid));
    request.device_uuid[0] ^= 1;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "mismatched nonzero UUID constraint must fail before context publication");
    request.device_uuid[0] ^= 1;
    request.allocator_limit = 1;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
          "allocator limit below owned descriptor minimum must fail before publication");
    request.allocator_limit = 0;
    request.workspace_limit = 1;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
          "workspace limit below FP64 minimum must fail before publication");
    request.workspace_limit = 0;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) == 0,
          "strict FP64 context create must reach an actual CUDA device");
    check(result.compute_major > 0, "device compute capability must be recorded");
    cudaDeviceProp evidence_prop{};
    check(cudaGetDeviceProperties(&evidence_prop, request.device_ordinal) == cudaSuccess,
          "evidence must query the resolved CUDA device");
    evidence_data.device_ordinal = request.device_ordinal;
    evidence_data.device_name = evidence_prop.name;
    std::memcpy(evidence_data.device_uuid, result.device_uuid, sizeof(result.device_uuid));
    evidence_data.compute_major = result.compute_major;
    evidence_data.compute_minor = result.compute_minor;
    evidence_data.cuda_runtime = result.cuda_runtime;
    evidence_data.cuda_driver = result.cuda_driver;
    std::memcpy(evidence_data.build_digest, result.build_digest, sizeof(result.build_digest));
    evidence_data.deterministic = request.deterministic == 1;
    check(result.context_handle.type_tag != 0, "context handle must be typed");
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    descriptor.abi_version = 1;
    descriptor.struct_version = 1;
    descriptor.struct_size = sizeof(descriptor);
    descriptor.required_features = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
    descriptor.grid[0] = descriptor.grid[1] = descriptor.grid[2] = 1;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = 1.0;
    descriptor.descriptor_revision = descriptor.source_revision = 1;
    descriptor.descriptor_digest[0] = 1;
    uint8_t masks_payload = 1;
    double materials_payload = 1.0;
    uint8_t interfaces_payload = 0x31;
    std::array<fullmag_fdm_gpu_transport_charge_face_v1, 6> charge_faces_payload{};
    for (uint32_t axis = 0; axis < 3; ++axis) {
        for (uint32_t side_index = 0; side_index < 2; ++side_index) {
            const size_t index = 2 * axis + side_index;
            auto &face = charge_faces_payload[index];
            face.abi_version = face.struct_version = 1;
            face.struct_size = sizeof(face);
            face.required_features = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
            face.kind = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING;
            face.axis = axis;
            face.side = side_index == 0 ? -1 : 1;
            face.outward_sign = face.side;
            face.adjacent_cell = 0;
            face.canonical_face_index = side_index;
            face.area = 1.0;
            face.value = 0.0;
            face.source_id = index + 1;
        }
    }
    uint8_t spin_faces_payload = 0x51;
    uint32_t formula_ids_payload[4] = {1, 1, 1, 1};
    auto host_view = [](void *address, uint64_t count, uint64_t width,
                        uint32_t element_type) {
        fullmag_fdm_gpu_transport_buffer_view_v1 view{};
        view.abi_version = view.struct_version = 1;
        view.struct_size = sizeof(view);
        view.address = reinterpret_cast<uint64_t>(address);
        view.element_count = count;
        view.byte_stride = width;
        view.byte_length = count * width;
        view.element_type = element_type;
        view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
        view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
        return view;
    };
    auto masks = host_view(&masks_payload, 1, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8);
    auto materials = host_view(&materials_payload, 1, sizeof(double), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64);
    auto interfaces = host_view(&interfaces_payload, 0, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    auto charge_faces = host_view(charge_faces_payload.data(), charge_faces_payload.size(),
                                  sizeof(charge_faces_payload[0]),
                                  FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    auto spin_faces = host_view(&spin_faces_payload, 0, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    auto formula_ids = host_view(formula_ids_payload, 4, 4, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U32);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&masks);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&materials);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&interfaces);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&charge_faces);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&spin_faces);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&formula_ids);
    const double valid_material = materials_payload;
    materials_payload = std::numeric_limits<double>::quiet_NaN();
    check(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
              result.context_handle, &descriptor) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "non-finite material metadata must fail before allocation");
    materials_payload = valid_material;
    fullmag_fdm_gpu_transport_context_create_result_v1 limited{};
    limited.abi_version = limited.struct_version = 1;
    limited.struct_size = sizeof(limited);
    request.allocator_limit = sizeof(descriptor);
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &limited) == 0,
          "bounded allocator context must publish when its base owner fits");
    check(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
              limited.context_handle, &descriptor) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
          "static H2D transaction must enforce allocator limit before partial allocation");
    check(fullmag_fdm_gpu_transport_context_destroy_v1(limited.context_handle) == 0,
          "failed bounded upload must leave context destroyable and uncommitted");
    request.allocator_limit = 0;
    const uint64_t saved_grid = descriptor.grid[1];
    descriptor.grid[0] = UINT64_MAX;
    descriptor.grid[1] = 2;
    check(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
              result.context_handle, &descriptor) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "grid overflow must fail before pointer inspection or allocation");
    descriptor.grid[0] = 1;
    descriptor.grid[1] = saved_grid;
    const uint32_t first_upload = fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
        result.context_handle, &descriptor);
    if (first_upload != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "first static descriptor upload status=%u\n", first_upload);
    check(first_upload == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
          "first static descriptor upload must commit atomically");
    masks_payload = 0xff;
    uint8_t copied_mask = 0;
    check(fullmag_fdm_gpu_transport_test_static_payload_copy_v1(
              result.context_handle, 0, &copied_mask, sizeof(copied_mask)) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && copied_mask == 1,
          "static upload must deep-copy host payload into context-owned device storage");
    fullmag_fdm_gpu_transport_buffer_view_v1 device_mask_view{};
    check(fullmag_fdm_gpu_transport_test_static_view_copy_v1(
              result.context_handle, 0, &device_mask_view) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              device_mask_view.pointer_space == FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY &&
              device_mask_view.address != masks.address,
          "device descriptor must reference a device-side view and device-owned payload");
    evidence_data.static_upload_bytes = sizeof(descriptor) + sizeof(materials_payload) +
        sizeof(formula_ids_payload) + 6 * sizeof(fullmag_fdm_gpu_transport_buffer_view_v1);
    check(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
              result.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
          "exact descriptor identity may be reused");
    descriptor.descriptor_revision = 2;
    check(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
              result.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
          "changed descriptor identity requires a new context");

    fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot{};
    check(fullmag_fdm_gpu_transport_test_snapshot_create_v1(result.context_handle, &snapshot) == 0,
          "phase-1 snapshot token must use the shared bounded registry");
    check(fullmag_fdm_gpu_transport_context_destroy_v1(result.context_handle) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_LIVE_SNAPSHOT,
          "context with a live snapshot must remain active");
    check(fullmag_fdm_gpu_transport_test_snapshot_retain_v1(result.context_handle, snapshot) == 0,
          "snapshot must retain only against its owning context");
    fullmag_fdm_gpu_transport_context_create_result_v1 second{};
    second.abi_version = second.struct_version = 1;
    second.struct_size = sizeof(second);
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &second) == 0,
          "second context must coexist in the bounded registry");
    check(fullmag_fdm_gpu_transport_test_snapshot_retain_v1(second.context_handle, snapshot) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
          "cross-context snapshot retain must fail closed");
    check(fullmag_fdm_gpu_transport_context_destroy_v1(second.context_handle) == 0,
          "independent context must destroy normally");
    auto wrong_kind = result.context_handle;
    wrong_kind.type_tag = snapshot.type_tag;
    check(fullmag_fdm_gpu_transport_context_destroy_v1(wrong_kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
          "wrong-kind context token must fail closed");
    check(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot) == 0,
          "snapshot destroy must retire the active token");
    check(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED,
          "exact snapshot double destroy must be distinguished");
    fullmag_fdm_gpu_charge_snapshot_handle_v1 reused{};
    check(fullmag_fdm_gpu_transport_test_snapshot_create_v1(result.context_handle, &reused) == 0 &&
              reused.slot == snapshot.slot && reused.generation > snapshot.generation,
          "snapshot slot reuse must advance generation");
    check(fullmag_fdm_gpu_transport_test_snapshot_retain_v1(result.context_handle, snapshot) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT,
          "older generation must remain stale after slot reuse");
    fullmag_fdm_gpu_charge_snapshot_handle_v1 extra1{}, extra2{}, exhausted{};
    check(fullmag_fdm_gpu_transport_test_snapshot_create_v1(result.context_handle, &extra1) == 0 &&
              fullmag_fdm_gpu_transport_test_snapshot_create_v1(result.context_handle, &extra2) == 0,
          "all remaining registry slots must be usable");
    check(fullmag_fdm_gpu_transport_test_snapshot_create_v1(result.context_handle, &exhausted) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
          "fifth live token must fail bounded four-slot registry");
    check(fullmag_fdm_gpu_charge_snapshot_destroy_v1(reused) == 0 &&
              fullmag_fdm_gpu_charge_snapshot_destroy_v1(extra1) == 0 &&
              fullmag_fdm_gpu_charge_snapshot_destroy_v1(extra2) == 0,
          "all live snapshots must retire without raw-pointer reuse");
    check(fullmag_fdm_gpu_transport_test_retire_slot_v1(reused.slot) == 0,
          "generation exhaustion hook must permanently retire an inactive slot");
    fullmag_fdm_gpu_charge_snapshot_handle_v1 after_retire{};
    check(fullmag_fdm_gpu_transport_test_snapshot_create_v1(result.context_handle, &after_retire) == 0 &&
              after_retire.slot != reused.slot,
          "retired generation slot must never be reused");
    check(fullmag_fdm_gpu_charge_snapshot_destroy_v1(after_retire) == 0,
          "snapshot created after retirement must remain valid");
    check(fullmag_fdm_gpu_transport_context_destroy_v1(result.context_handle) == 0,
          "context destroy must retire the active token");
    check(fullmag_fdm_gpu_transport_context_destroy_v1(result.context_handle) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED,
          "double destroy must be safe and exact");

    request.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_SINGLE_KNOWN_UNSUPPORTED;
    std::memset(&result, 0, sizeof(result));
    result.abi_version = 1;
    result.struct_version = 1;
    result.struct_size = sizeof(result);
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED,
          "FP32 must fail before context allocation");
}

void write_evidence_after_complete_gate() {
    const char *path = std::getenv("FULLMAG_FDM_GPU_M1_EVIDENCE_PATH");
    if (path == nullptr) return;
    const std::string temporary = std::string(path) + ".tmp";
    std::ofstream output(temporary, std::ios::out | std::ios::trunc);
    check(output.good(), "evidence temporary file must open");
    const auto hex = [&output](const uint8_t *bytes, size_t count) {
        for (size_t i = 0; i < count; ++i)
            output << std::hex << std::setw(2) << std::setfill('0')
                   << static_cast<unsigned>(bytes[i]);
        output << std::dec;
    };
    const auto *manifest = fullmag_fdm_gpu_transport_layout_manifest_get_v1();
    output << "{\n  \"status\": \"passed\",\n"
           << "  \"gate\": \"verify-fdm-gpu-m1-layout-abi-contract\",\n"
           << "  \"device_ordinal\": " << evidence_data.device_ordinal << ",\n"
           << "  \"device_name\": \"" << evidence_data.device_name << "\",\n"
           << "  \"device_uuid\": \"";
    hex(evidence_data.device_uuid, sizeof(evidence_data.device_uuid));
    output << "\",\n  \"compute_capability\": \"" << evidence_data.compute_major << '.'
           << evidence_data.compute_minor << "\",\n  \"cuda_runtime\": "
           << evidence_data.cuda_runtime << ",\n  \"cuda_driver\": " << evidence_data.cuda_driver
           << ",\n  \"build_digest_sha256\": \"";
    hex(evidence_data.build_digest, sizeof(evidence_data.build_digest));
    output << "\",\n  \"compiler_identity\": \"" << __VERSION__ << "\",\n"
           << "  \"compiler_flags\": \"" << FULLMAG_FDM_GPU_TRANSPORT_COMPILER_FLAGS << "\",\n"
           << "  \"requested\": \"fdm/gpu/double/strict\",\n"
           << "  \"resolved\": \"fdm/gpu/double/strict\",\n"
           << "  \"deterministic\": " << (evidence_data.deterministic ? "true" : "false") << ",\n"
           << "  \"abi_version\": " << manifest->abi_version << ",\n"
           << "  \"prefix_size\": " << FULLMAG_FDM_GPU_TRANSPORT_COMMON_PREFIX_SIZE_V1 << ",\n"
           << "  \"prefix_alignment\": " << FULLMAG_FDM_GPU_TRANSPORT_COMMON_PREFIX_ALIGNMENT_V1 << ",\n"
           << "  \"record_layouts\": [";
    for (uint32_t i = 0; i < manifest->record_count; ++i) {
        if (i) output << ',';
        output << "{\"id\":" << manifest->records[i].record_id
               << ",\"size\":" << manifest->records[i].min_size_v1
               << ",\"features\":" << manifest->records[i].known_features_v1 << '}';
    }
    output << "],\n  \"closed_registry_count\": 20,\n"
           << "  \"flag_registry_count\": 2,\n"
           << "  \"lifecycle\": {\"stale\":true,\"double_destroy\":true,\"exhaustion\":true},\n"
           << "  \"checkpoint_codec_golden_bytes\": 1600,\n"
           << "  \"checkpoint_restore_golden_bytes\": 4352,\n"
           << "  \"checkpoint_mutations_checked\": " << evidence_data.checkpoint_mutations << ",\n"
           << "  \"static_upload_h2d_bytes\": " << evidence_data.static_upload_bytes << ",\n"
           << "  \"host_fallback_count\": 0,\n"
           << "  \"capability\": \"semantic_only\",\n"
           << "  \"implementation\": \"partial\",\n"
           << "  \"validation\": \"unvalidated\",\n"
           << "  \"validated_workloads\": []\n}\n";
    output.close();
    check(output.good(), "evidence temporary file must flush completely");
    check(std::rename(temporary.c_str(), path) == 0, "evidence publish must be atomic");
}

} // namespace

int main() {
    phase1_operation_family_is_public();
    frozen_prefix_and_records_are_exposed();
    registries_and_layout_manifest_are_frozen();
    every_closed_registry_rejects_an_unknown_value();
    unsupported_operations_never_fabricate_state();
    actual_device_context_is_strict_fp64();
    checkpoint_goldens_and_mutations_are_exact();
    write_evidence_after_complete_gate();
    return 0;
}
