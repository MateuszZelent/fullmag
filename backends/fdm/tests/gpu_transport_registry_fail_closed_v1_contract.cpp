#include "fullmag_fdm.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

template <typename T>
void init_record(T &record) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
}

template <typename T>
bool unchanged(const T &record, const T &before) {
    return std::memcmp(&record, &before, sizeof(record)) == 0;
}

void context_create_classifies_unknown_and_known_unsupported_values() {
    fullmag_fdm_gpu_transport_context_create_request_v1 request{};
    init_record(request);
    request.device_ordinal = 0;
    request.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    request.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    request.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    request.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;

    fullmag_fdm_gpu_transport_context_create_result_v1 result{};
    init_record(result);
    const auto pristine = result;

    request.precision = 3;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown precision must be invalid, not an unsupported execution mode");
    check(unchanged(result, pristine), "unknown precision must not publish a context");

    request.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_SINGLE_KNOWN_UNSUPPORTED;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED,
          "known FP32 precision must report exact unsupported status");
    check(unchanged(result, pristine), "unsupported precision must not publish a context");

    request.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    request.strict_residency = 2;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown strict_residency boolean must fail closed");
    request.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    request.deterministic = 2;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown deterministic boolean must fail closed");
    request.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    request.stream_policy = 2;
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown stream policy must be invalid, not unsupported");

    request.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    request.required_features = UINT64_C(0x80);
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
          "unknown required feature bit must have the dedicated status");
    request.required_features = 0;
    request.requested_device_features = UINT64_C(0x4);
    check(fullmag_fdm_gpu_transport_context_create_v1(&request, &result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              (result.supported_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) != 0,
          "implemented M1 charge feature must be published by actual-device context creation");
    check(fullmag_fdm_gpu_transport_context_destroy_v1(result.context_handle) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
          "M1 charge feature-probe context teardown failed");
}

void phase1_stubs_validate_closed_request_registries_before_unsupported() {
    fullmag_fdm_gpu_charge_solve_request_v1 charge{};
    init_record(charge);
    fullmag_fdm_gpu_charge_solve_result_v1 charge_result{};
    init_record(charge_result);
    const auto charge_before = charge_result;

    charge.solver_policy = 2;
    check(fullmag_fdm_gpu_transport_solve_charge_v1(&charge, &charge_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown charge solver policy must fail before the phase-1 unsupported stub");
    check(unchanged(charge_result, charge_before),
          "rejected charge policy must not mutate its result");
    charge.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    charge.gauge_policy = 3;
    check(fullmag_fdm_gpu_transport_solve_charge_v1(&charge, &charge_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown gauge policy must fail before the phase-1 unsupported stub");

    fullmag_fdm_gpu_steady_spin_solve_request_v1 spin{};
    init_record(spin);
    fullmag_fdm_gpu_steady_spin_solve_result_v1 spin_result{};
    init_record(spin_result);
    const auto spin_before = spin_result;
    spin.solver_policy = 3;
    check(fullmag_fdm_gpu_transport_solve_steady_spin_v1(&spin, &spin_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown spin solver policy must fail before the phase-1 unsupported stub");
    check(unchanged(spin_result, spin_before),
          "rejected spin policy must not mutate its result");
    spin.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_BLOCK_JACOBI_PROTOTYPE_V1;
    check(fullmag_fdm_gpu_transport_solve_steady_spin_v1(&spin, &spin_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED,
          "known prototype spin policy must report exact unsupported status");

    fullmag_fdm_gpu_transport_artifact_request_v1 artifact{};
    init_record(artifact);
    artifact.required_features =
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
    artifact.field_id = 8;
    artifact.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    check(fullmag_fdm_gpu_transport_readback_artifact_v1(&artifact) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown artifact field must fail before the phase-1 unsupported stub");
    artifact.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V;
    artifact.cadence = 4;
    check(fullmag_fdm_gpu_transport_readback_artifact_v1(&artifact) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown artifact cadence must fail before the phase-1 unsupported stub");
}

void checkpoint_stubs_validate_enums_flags_and_features_before_unsupported() {
    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 size_request{};
    init_record(size_request);
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 size_result{};
    init_record(size_result);
    const auto size_before = size_result;
    size_request.schema_version = 2;
    check(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&size_request, &size_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown checkpoint schema must fail before the phase-1 unsupported stub");
    check(unchanged(size_result, size_before),
          "rejected checkpoint schema must not mutate its result");
    size_request.schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    size_request.inclusion_mask = UINT32_C(0x40);
    check(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&size_request, &size_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
          "unknown checkpoint inclusion bit must use unsupported-required status");
    size_request.inclusion_mask = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_CHARGE_ARRAYS;
    check(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&size_request, &size_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "known but incomplete checkpoint inclusion combination must fail closed");
    size_request.inclusion_mask = UINT32_C(0x33);
    size_request.required_features = UINT64_C(0x80);
    check(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&size_request, &size_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
          "unknown checkpoint required feature must retain its dedicated status");

    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 export_request{};
    init_record(export_request);
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 export_result{};
    init_record(export_result);
    export_request.inclusion_mask = UINT32_C(0x40);
    check(fullmag_fdm_gpu_transport_checkpoint_export_v1(&export_request, &export_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
          "checkpoint export unknown inclusion bits must use unsupported-required status");
    export_request.inclusion_mask = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_CHARGE_ARRAYS;
    check(fullmag_fdm_gpu_transport_checkpoint_export_v1(&export_request, &export_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "checkpoint export must reject incomplete known inclusion combinations");

    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 import_request{};
    init_record(import_request);
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 restore_result{};
    init_record(restore_result);
    import_request.restore_policy = 2;
    check(fullmag_fdm_gpu_transport_checkpoint_import_v1(&import_request, &restore_result) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
          "unknown restore policy must fail before the phase-1 unsupported stub");
}

} // namespace

int main() {
    context_create_classifies_unknown_and_known_unsupported_values();
    phase1_stubs_validate_closed_request_registries_before_unsupported();
    checkpoint_stubs_validate_enums_flags_and_features_before_unsupported();
    return 0;
}
