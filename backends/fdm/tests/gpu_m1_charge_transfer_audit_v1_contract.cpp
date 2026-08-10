#include "fullmag_fdm.h"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

extern "C" void fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
    const void *payload, uint64_t payload_size, uint8_t digest[32]);
extern "C" uint32_t fullmag_fdm_gpu_transport_test_force_import_digest_mismatch_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t enabled);
extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t boundary);
extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t provisional_generation, uint64_t telemetry_sequence);
extern "C" uint32_t fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *provisional_generation, uint64_t *telemetry_sequence,
    uint64_t *telemetry_count);

namespace {

constexpr uint64_t kFeatures =
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1 |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fullmag_fdm_gpu_transport_buffer_view_v1 view(
    const void *data, uint64_t count, uint64_t stride, uint32_t element_type,
    uint32_t component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = element_type;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = component_order;
    return result;
}

fullmag_fdm_gpu_transport_charge_face_v1 face(
    uint32_t kind, uint32_t axis, int32_t side, uint64_t adjacent,
    uint64_t canonical_index, double area, double value, uint64_t source_id) {
    fullmag_fdm_gpu_transport_charge_face_v1 result{};
    init_record(result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    result.kind = kind;
    result.axis = axis;
    result.side = side;
    result.outward_sign = side;
    result.adjacent_cell = adjacent;
    result.canonical_face_index = canonical_index;
    result.area = area;
    result.value = value;
    result.source_id = source_id;
    return result;
}

struct ExpectedEvent {
    uint32_t direction;
    uint32_t reason;
    uint32_t status;
    uint64_t bytes;
    uint64_t count;
    uint32_t flags;
};

ExpectedEvent event(uint32_t direction, uint32_t reason, uint64_t bytes,
                    uint64_t count,
                    uint32_t status = FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS) {
    return {direction, reason, status, bytes, count, 0};
}

uint32_t expected_flags(const char *scope, uint64_t index) {
    constexpr uint32_t transfer = FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER;
    constexpr uint32_t sync = FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION;
    constexpr uint32_t cadence =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    constexpr uint32_t commit =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SCIENTIFIC_COMMIT;
    constexpr uint32_t provisional =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    constexpr uint32_t failed = FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED;
    if (std::strcmp(scope, "source") == 0) {
        if (index == 0 || index == 2) return transfer;
        if (index == 1 || index == 3) return sync;
        if (index >= 4 && index <= 10)
            return ((index == 5 || index == 8 || index == 10) ? sync : transfer) |
                provisional;
        return ((index & 1) == 1 ? transfer : sync) | cadence;
    }
    if (index == 0 || index == 2) return transfer;
    if (index == 1 || index == 3 || index == 5 || index == 7) return sync;
    if (index == 4) return failed;
    if (index == 6 || index == 8) return transfer;
    if (index == 9) return sync | commit;
    return ((index & 1) == 0 ? transfer : sync) | cadence;
}

std::array<uint8_t, 32> verify_exact_audit(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const std::vector<ExpectedEvent> &expected, const char *scope) {
    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 32> records{};
    uint64_t count = UINT64_MAX;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                context, 0, records.data(), records.size(), &count) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "telemetry query failed");
    if (count != expected.size())
        std::fprintf(stderr, "%s telemetry count: expected=%zu actual=%llu\n",
                     scope, expected.size(), static_cast<unsigned long long>(count));
    require(count == expected.size(), "telemetry event count drifted");

    std::array<uint8_t, 32> previous{};
    for (uint64_t i = 0; i < count; ++i) {
        const auto &record = records[i];
        auto want = expected[i];
        want.flags = expected_flags(scope, i);
        require(record.abi_version == FULLMAG_FDM_GPU_TRANSPORT_ABI_V1 &&
                    record.struct_version == 1 && record.struct_size == sizeof(record) &&
                    record.reserved_flags == 0 && record.reserved0 == 0 &&
                    (record.required_features & ~kFeatures) == 0,
                "telemetry prefix is not a legal bounded v1 record");
        if (record.direction != want.direction || record.reason != want.reason ||
            record.status != want.status || record.event_flags != want.flags ||
            record.bytes != want.bytes ||
            record.count != want.count) {
            std::fprintf(stderr,
                         "%s event[%llu]: got dir=%u reason=%u status=%u flags=%u bytes=%llu count=%llu; "
                         "expected dir=%u reason=%u status=%u flags=%u bytes=%llu count=%llu\n",
                         scope, static_cast<unsigned long long>(i), record.direction,
                         record.reason, record.status, record.event_flags,
                         static_cast<unsigned long long>(record.bytes),
                         static_cast<unsigned long long>(record.count), want.direction,
                         want.reason, want.status, want.flags,
                         static_cast<unsigned long long>(want.bytes),
                         static_cast<unsigned long long>(want.count));
        }
        require(record.audit_sequence == i + 1 && record.direction == want.direction &&
                    record.reason == want.reason && record.status == want.status &&
                    record.event_flags == want.flags &&
                    record.bytes == want.bytes && record.count == want.count,
                "telemetry order/status/direction/reason/bytes/count drifted");
        require(record.stream_id == 1 && record.event_id == record.audit_sequence,
                "bounded single-stream audit identity drifted");

        std::array<uint8_t, 32 + 144> chain_input{};
        std::memcpy(chain_input.data(), previous.data(), previous.size());
        std::memcpy(chain_input.data() + previous.size(), &record, 112);
        std::array<uint8_t, 32> independently_derived{};
        fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
            chain_input.data(), chain_input.size(), independently_derived.data());
        require(std::memcmp(record.operation_audit_digest,
                            independently_derived.data(), independently_derived.size()) == 0,
                "operation audit is not the normative append-only SHA-256 chain");
        previous = independently_derived;
    }

    uint64_t tail_count = UINT64_MAX;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                context, count, records.data(), records.size(), &tail_count) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && tail_count == 0,
            "telemetry cursor replayed an append-only record");
    return previous;
}

void verify_fault_suffix(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint64_t cursor,
    const std::vector<ExpectedEvent> &expected) {
    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 128> records{};
    uint64_t count = 0;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                context, 0, records.data(), records.size(), &count) == 0,
            "fault telemetry query failed");
    if (count != cursor + expected.size())
        std::fprintf(stderr, "fault telemetry suffix: cursor=%llu expected=%zu actual=%llu\n",
                     static_cast<unsigned long long>(cursor), expected.size(),
                     static_cast<unsigned long long>(count));
    require(count == cursor + expected.size(), "fault telemetry suffix length drifted");
    std::array<uint8_t, 32> previous{};
    for (uint64_t index = 0; index < count; ++index) {
        const auto &record = records[index];
        require(record.audit_sequence == index + 1 && record.event_id == index + 1 &&
                    record.audit_sequence != 0,
                "fault audit identity wrapped or drifted");
        std::array<uint8_t, 176> chain_input{};
        std::memcpy(chain_input.data(), previous.data(), 32);
        // The operation digest field begins at byte 112 and is zero while the
        // producer hashes the record; only the immutable prefix participates.
        std::memcpy(chain_input.data() + 32, &record, 112);
        std::array<uint8_t, 32> independently_derived{};
        fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
            chain_input.data(), chain_input.size(), independently_derived.data());
        if (std::memcmp(record.operation_audit_digest,
                        independently_derived.data(), 32) != 0)
            std::fprintf(stderr,
                         "fault SHA mismatch index=%llu cursor=%llu count=%llu got0=%02x want0=%02x\n",
                         static_cast<unsigned long long>(index),
                         static_cast<unsigned long long>(cursor),
                         static_cast<unsigned long long>(count),
                         unsigned(record.operation_audit_digest[0]),
                         unsigned(independently_derived[0]));
        require(std::memcmp(record.operation_audit_digest,
                            independently_derived.data(), 32) == 0,
                "fault audit SHA parent chain drifted");
        previous = independently_derived;
        if (index < cursor) continue;
        const auto &want = expected[index - cursor];
        require(record.direction == want.direction && record.reason == want.reason &&
                    record.status == want.status && record.event_flags == want.flags &&
                    record.bytes == want.bytes && record.count == want.count,
                "fault audit direction/reason/status/flags/bytes/count drifted");
    }
    require(!expected.empty() &&
                records[count - 1].status ==
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED &&
                (records[count - 1].event_flags &
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED) != 0,
            "fault suffix did not terminate in FAILED");
}

std::vector<ExpectedEvent> failed_prefix(
    const std::vector<ExpectedEvent> &boundaries, size_t failed_index) {
    std::vector<ExpectedEvent> result(boundaries.begin(),
                                      boundaries.begin() + failed_index + 1);
    result.back().status = FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED;
    result.back().flags |= FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED;
    result.back().bytes = 0;
    result.back().count = 0;
    return result;
}

std::string hex(const uint8_t *bytes, size_t count) {
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (size_t i = 0; i < count; ++i) output << std::setw(2) << unsigned(bytes[i]);
    return output.str();
}

} // namespace

int main() {
    constexpr uint64_t nx = 8, ny = 2, nz = 1;
    constexpr uint64_t cells = nx * ny * nz;
    constexpr double h = 1.0e-9;
    constexpr double sigma = 5.0e6;
    constexpr double left_v = 8.0e-3;

    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess,
            "an actual CUDA device is required; SKIP is forbidden");
    cudaDeviceProp device_properties{};
    require(cudaGetDeviceProperties(&device_properties, device) == cudaSuccess,
            "actual CUDA device properties are required");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1 |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 32ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 16ULL * 1024ULL * 1024ULL;

    std::array<fullmag_fdm_gpu_transport_charge_cell_v1, cells> cell_records{};
    for (auto &cell : cell_records) {
        init_record(cell, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        cell.active = cell.conductor = 1;
        cell.material_index = 0;
    }
    fullmag_fdm_gpu_transport_charge_material_v1 material{};
    init_record(material, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    material.material_index = 0;
    material.conductivity = sigma;
    material.material_revision = 1;
    std::array<fullmag_fdm_gpu_transport_charge_material_v1, 1> materials{{material}};
    fullmag_fdm_gpu_transport_charge_formula_ids_v1 formula{};
    init_record(formula, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 1;

    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> faces;
    for (uint64_t y = 0; y < ny; ++y) {
        faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE,
                             0, -1, nx * y, (nx + 1) * y, h * h, left_v,
                             1 + faces.size()));
        faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE,
                             0, +1, nx - 1 + nx * y, nx + (nx + 1) * y,
                             h * h, 0.0, 1 + faces.size()));
    }
    for (uint64_t x = 0; x < nx; ++x) {
        faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                             1, -1, x, x, h * h, 0.0, 1 + faces.size()));
        faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                             1, +1, x + nx, x + nx * ny, h * h, 0.0,
                             1 + faces.size()));
    }
    for (uint64_t y = 0; y < ny; ++y) for (uint64_t x = 0; x < nx; ++x) {
        const uint64_t adjacent = x + nx * y;
        faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                             2, -1, adjacent, adjacent, h * h, 0.0,
                             1 + faces.size()));
        faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                             2, +1, adjacent, adjacent + cells, h * h, 0.0,
                             1 + faces.size()));
    }
    std::array<uint8_t, 1> empty{{0}};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        view(cell_records.data(), cell_records.size(), sizeof(cell_records[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(materials.data(), materials.size(), sizeof(materials[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(), 0, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(faces.data(), faces.size(), sizeof(faces[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(), 0, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(&formula, 1, sizeof(formula),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    descriptor.grid[0] = nx; descriptor.grid[1] = ny; descriptor.grid[2] = nz;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = h;
    descriptor.descriptor_revision = descriptor.source_revision = 1;
    std::fill(std::begin(descriptor.descriptor_digest),
              std::end(descriptor.descriptor_digest), 0xa7);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);

    const uint64_t static_payload_bytes =
        views[0].byte_length + views[1].byte_length + views[3].byte_length +
        views[5].byte_length;
    const uint64_t static_upload_bytes = sizeof(descriptor) + sizeof(views) + static_payload_bytes;
    constexpr uint64_t static_upload_count = 6; // descriptor + view table + four payloads

    const std::vector<ExpectedEvent> static_fault_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
         static_upload_bytes, static_upload_count,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS, 0, 1,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
         sizeof(uint32_t), 1,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS, 0, 1,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION},
    }};
    for (uint32_t boundary = 1; boundary <= 4; ++boundary) {
        fullmag_fdm_gpu_transport_context_create_result_v1 fault_context{};
        init_record(fault_context);
        require(fullmag_fdm_gpu_transport_context_create_v1(&create, &fault_context) == 0 &&
                    fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                        fault_context.context_handle, boundary) == 0,
                "static fault context setup failed");
        require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    fault_context.context_handle, &descriptor) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
                "static boundary fault did not fail transactionally");
        verify_fault_suffix(fault_context.context_handle, 0,
                            failed_prefix(static_fault_boundaries, boundary - 1));
        require(fullmag_fdm_gpu_transport_context_destroy_v1(
                    fault_context.context_handle) == 0,
                "static fault context retained partial state");
    }

    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "strict FP64 source context creation failed");
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "typed complete static descriptor upload failed");

    fullmag_fdm_gpu_charge_solve_request_v1 solve{};
    init_record(solve, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    solve.context_handle = created.context_handle;
    solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    solve.gauge_policy =
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    solve.attempt_id = 41;
    solve.stage_id = 7;
    solve.source_revision = solve.static_revision = 1;
    solve.relative_tolerance = 1.0e-12;
    solve.max_iterations = 256;
    fullmag_fdm_gpu_charge_solve_result_v1 solved{};
    init_record(solved, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            "charge solve failed");
    const uint64_t solve_state_bytes = cells * (sizeof(uint8_t) + sizeof(double));
    constexpr uint64_t metrics_bytes = 128;
    constexpr uint32_t provisional_transfer =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    constexpr uint32_t provisional_sync =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    const std::vector<ExpectedEvent> solve_fault_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         0, sizeof(uint32_t), 1, provisional_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, provisional_sync},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
         0, solve_state_bytes, 2, provisional_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         0, metrics_bytes, 1, provisional_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, provisional_sync},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         0, 32, 1, provisional_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, provisional_sync},
    }};
    for (uint32_t boundary = 10; boundary <= 16; ++boundary) {
        fullmag_fdm_gpu_transport_context_create_result_v1 fault_context{};
        init_record(fault_context);
        require(fullmag_fdm_gpu_transport_context_create_v1(&create, &fault_context) == 0 &&
                    fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                        fault_context.context_handle, &descriptor) == 0 &&
                    fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                        fault_context.context_handle, boundary) == 0,
                "solve fault context setup failed");
        auto fault_solve = solve;
        fault_solve.context_handle = fault_context.context_handle;
        fullmag_fdm_gpu_charge_solve_result_v1 fault_result{};
        init_record(fault_result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        require(fullmag_fdm_gpu_transport_solve_charge_v1(
                    &fault_solve, &fault_result) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
                "solve boundary fault did not fail transactionally");
        verify_fault_suffix(fault_context.context_handle, 4,
                            failed_prefix(solve_fault_boundaries, boundary - 10));
        require(fullmag_fdm_gpu_transport_context_destroy_v1(
                    fault_context.context_handle) == 0,
                "solve fault context retained provisional state");
    }

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, solved.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "charge snapshot accept failed");

    const uint64_t jx_count = (nx + 1) * ny * nz;
    const uint64_t jy_count = nx * (ny + 1) * nz;
    const uint64_t jz_count = nx * ny * (nz + 1);
    const uint64_t current_count = jx_count + jy_count + jz_count;
    const uint64_t potential_bytes = cells * sizeof(double);
    const uint64_t current_bytes = current_count * sizeof(double);
    std::vector<double> potential(cells), current(current_count);
    auto readback = [&](fullmag_fdm_gpu_transport_context_handle_v1 context,
                        fullmag_fdm_gpu_charge_snapshot_handle_v1 handle,
                        uint64_t accepted_sequence, uint32_t field,
                        std::vector<double> &destination) {
        auto destination_view = view(
            destination.data(), destination.size(), sizeof(double),
            FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
            field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
                ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
                : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
        destination_view.pointer_space =
            FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle = context;
        request.snapshot_handle = handle;
        request.field_id = field;
        request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count = destination.size();
        request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
        request.expected_bytes = destination.size() * sizeof(double);
        request.accepted_sequence = accepted_sequence;
        return fullmag_fdm_gpu_transport_readback_artifact_v1(&request);
    };
    const uint32_t potential_readback = readback(
        created.context_handle, snapshot.snapshot_handle, snapshot.accepted_sequence,
        FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, potential);
    const uint32_t current_readback = readback(
        created.context_handle, snapshot.snapshot_handle, snapshot.accepted_sequence,
        FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, current);
    if (potential_readback != 0 || current_readback != 0)
        std::fprintf(stderr, "source readback diagnostics: V=%u Jc=%u\n",
                     potential_readback, current_readback);
    require(potential_readback == 0 && current_readback == 0,
            "source V/J artifact readback failed");

    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 size_request{};
    init_record(size_request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                  FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    size_request.context_handle = created.context_handle;
    size_request.snapshot_handle = snapshot.snapshot_handle;
    size_request.accepted_sequence = snapshot.accepted_sequence;
    size_request.schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    size_request.inclusion_mask = UINT32_C(0x33);
    std::memcpy(size_request.static_descriptor_digest, descriptor.descriptor_digest, 32);
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 size_result{};
    init_record(size_result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&size_request, &size_result) == 0,
            "checkpoint size query failed");
    std::vector<uint8_t> checkpoint(size_result.required_bytes);
    auto checkpoint_destination = view(checkpoint.data(), checkpoint.size(), 1,
                                       FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    checkpoint_destination.pointer_space =
        FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 export_request{};
    init_record(export_request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    export_request.context_handle = created.context_handle;
    export_request.snapshot_handle = snapshot.snapshot_handle;
    export_request.accepted_sequence = snapshot.accepted_sequence;
    export_request.cadence_id = 1;
    export_request.destination_view_ptr = reinterpret_cast<uint64_t>(&checkpoint_destination);
    export_request.exact_capacity = export_request.expected_size = checkpoint.size();
    export_request.inclusion_mask = UINT32_C(0x33);
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 exported{};
    init_record(exported, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                              FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_export_v1(&export_request, &exported) == 0,
            "checkpoint export failed");
    std::array<uint8_t, 32> successful_payload_sha{};
    std::memcpy(successful_payload_sha.data(), exported.payload_sha256,
                successful_payload_sha.size());

    const uint64_t static_validation_bytes = sizeof(uint32_t);
    const uint64_t gauge_bytes = sizeof(uint32_t);
    const uint64_t export_vector_bytes =
        cells * (sizeof(uint8_t) + sizeof(double)) + potential_bytes + current_bytes;
    const auto source_audit_digest = verify_exact_audit(created.context_handle, {
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
              static_upload_bytes, static_upload_count),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
              static_validation_bytes, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
              gauge_bytes, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
              solve_state_bytes, 2),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
              metrics_bytes, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H, 32, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
              potential_bytes, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
              current_bytes, 3),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H, 32, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
              export_vector_bytes, 6),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
    }, "source");

    uint64_t source_fault_cursor = 19;
    const uint32_t cadence_transfer =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    const uint32_t cadence_sync =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    const std::vector<ExpectedEvent> artifact_fault_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
         0, potential_bytes, 1, cadence_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, cadence_sync},
    }};
    for (uint32_t boundary = 20; boundary <= 21; ++boundary) {
        require(fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                    created.context_handle, boundary) == 0 &&
                    readback(created.context_handle, snapshot.snapshot_handle,
                             snapshot.accepted_sequence,
                             FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, potential) ==
                        FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
                "artifact boundary fault did not fail transactionally");
        auto expected = failed_prefix(artifact_fault_boundaries, boundary - 20);
        verify_fault_suffix(created.context_handle, source_fault_cursor, expected);
        source_fault_cursor += expected.size();
    }
    const std::vector<ExpectedEvent> export_fault_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         0, 32, 1, cadence_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, cadence_sync},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
         0, export_vector_bytes, 6, cadence_transfer},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, cadence_sync},
    }};
    for (uint32_t boundary = 30; boundary <= 33; ++boundary) {
        require(fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                    created.context_handle, boundary) == 0,
                "export fault hook setup failed");
        init_record(exported, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                  FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
        require(fullmag_fdm_gpu_transport_checkpoint_export_v1(
                    &export_request, &exported) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
                "export boundary fault did not fail transactionally");
        auto expected = failed_prefix(export_fault_boundaries, boundary - 30);
        verify_fault_suffix(created.context_handle, source_fault_cursor, expected);
        source_fault_cursor += expected.size();
    }

    fullmag_fdm_gpu_transport_context_create_result_v1 restored_context{};
    init_record(restored_context);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &restored_context) == 0 &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    restored_context.context_handle, &descriptor) == 0,
            "fresh restore context/static upload failed");
    auto checkpoint_source = view(checkpoint.data(), checkpoint.size(), 1,
                                  FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 import_request{};
    init_record(import_request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    import_request.context_handle = restored_context.context_handle;
    import_request.source_view_ptr = reinterpret_cast<uint64_t>(&checkpoint_source);
    std::memcpy(import_request.expected_payload_sha256,
                successful_payload_sha.data(), successful_payload_sha.size());
    std::memcpy(import_request.device_uuid, restored_context.device_uuid, 16);
    std::memcpy(import_request.build_digest, restored_context.build_digest, 32);
    std::memcpy(import_request.static_descriptor_digest, descriptor.descriptor_digest, 32);
    import_request.restore_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    import_request.expected_bytes = checkpoint.size();
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 restored{};
    init_record(restored, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                              FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    const std::vector<ExpectedEvent> import_fault_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
         0, potential_bytes + current_bytes, 4,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         0, 32, 1, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         0, 0, 1, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION},
    }};
    for (uint32_t boundary = 40; boundary <= 44; ++boundary) {
        fullmag_fdm_gpu_transport_context_create_result_v1 fault_context{};
        init_record(fault_context);
        require(fullmag_fdm_gpu_transport_context_create_v1(&create, &fault_context) == 0 &&
                    fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                        fault_context.context_handle, &descriptor) == 0 &&
                    fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                        fault_context.context_handle, boundary) == 0,
                "import fault context setup failed");
        auto fault_import = import_request;
        fault_import.context_handle = fault_context.context_handle;
        std::memcpy(fault_import.device_uuid, fault_context.device_uuid, 16);
        std::memcpy(fault_import.build_digest, fault_context.build_digest, 32);
        fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 fault_restore{};
        init_record(fault_restore, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                      FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
        const uint32_t fault_status = fullmag_fdm_gpu_transport_checkpoint_import_v1(
            &fault_import, &fault_restore);
        if (fault_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR)
            std::fprintf(stderr, "import fault boundary=%u status=%u\n",
                         boundary, fault_status);
        require(fault_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
                "import boundary fault did not fail transactionally");
        verify_fault_suffix(fault_context.context_handle, 4,
                            failed_prefix(import_fault_boundaries, boundary - 40));
        require(fullmag_fdm_gpu_transport_context_destroy_v1(
                    fault_context.context_handle) == 0,
                "import fault context retained restored state");
    }
    fullmag_fdm_gpu_transport_context_create_result_v1 overflow_context{};
    init_record(overflow_context);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &overflow_context) == 0 &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    overflow_context.context_handle, &descriptor) == 0,
            "rejected-import overflow context setup failed");
    auto overflow_import = import_request;
    overflow_import.context_handle = overflow_context.context_handle;
    std::memcpy(overflow_import.device_uuid, overflow_context.device_uuid, 16);
    std::memcpy(overflow_import.build_digest, overflow_context.build_digest, 32);
    overflow_import.expected_payload_sha256[0] ^= UINT8_C(1);
    require(fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
                overflow_context.context_handle, 0, UINT64_MAX - 1) == 0,
            "rejected-import telemetry max-1 setup failed");
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 overflow_restore{};
    init_record(overflow_restore, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                      FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(
                &overflow_import, &overflow_restore) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
            "first rejected import did not publish sequence UINT64_MAX");
    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 1> overflow_records{};
    uint64_t overflow_count = 0;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                overflow_context.context_handle, UINT64_MAX - 1,
                overflow_records.data(), overflow_records.size(), &overflow_count) == 0 &&
                overflow_count == 1 &&
                overflow_records[0].audit_sequence == UINT64_MAX &&
                overflow_records[0].reason ==
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT,
            "rejected-import max sequence event was not retained exactly");
    uint64_t overflow_generation = 0, overflow_sequence = 0,
             overflow_telemetry_count = 0;
    require(fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
                overflow_context.context_handle, &overflow_generation,
                &overflow_sequence, &overflow_telemetry_count) == 0 &&
                overflow_generation == 0 && overflow_sequence == UINT64_MAX,
            "first rejected import corrupted runtime counters");
    std::array<uint8_t, 32> overflow_digest{};
    std::memcpy(overflow_digest.data(),
                overflow_records[0].operation_audit_digest, overflow_digest.size());
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(
                &overflow_import, &overflow_restore) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
            "second rejected import did not fail before sequence wrap");
    uint64_t final_generation = 0, final_sequence = 0, final_count = 0;
    require(fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
                overflow_context.context_handle, &final_generation,
                &final_sequence, &final_count) == 0 &&
                final_generation == overflow_generation &&
                final_sequence == overflow_sequence &&
                final_count == overflow_telemetry_count,
            "rejected-import overflow mutated counters");
    overflow_count = 0;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                overflow_context.context_handle, UINT64_MAX - 1,
                overflow_records.data(), overflow_records.size(), &overflow_count) == 0 &&
                overflow_count == 1 &&
                std::memcmp(overflow_records[0].operation_audit_digest,
                            overflow_digest.data(), overflow_digest.size()) == 0,
            "rejected-import overflow mutated the audit digest");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(
                overflow_context.context_handle) == 0,
            "rejected-import overflow context teardown failed");
    checkpoint.back() ^= 1;
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(&import_request, &restored) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
            "mutated checkpoint import did not reject before CUDA transfer");
    checkpoint.back() ^= 1;
    fullmag_fdm_gpu_transport_context_create_result_v1 failed_context{};
    init_record(failed_context);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &failed_context) == 0 &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    failed_context.context_handle, &descriptor) == 0 &&
                fullmag_fdm_gpu_transport_test_force_import_digest_mismatch_v1(
                    failed_context.context_handle, 1) == 0,
            "post-H2D failure context setup failed");
    auto failed_import = import_request;
    failed_import.context_handle = failed_context.context_handle;
    std::memcpy(failed_import.device_uuid, failed_context.device_uuid, 16);
    std::memcpy(failed_import.build_digest, failed_context.build_digest, 32);
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 failed_restore{};
    init_record(failed_restore, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(
                &failed_import, &failed_restore) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
            "post-H2D digest mismatch did not fail closed");
    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 16> failed_records{};
    uint64_t failed_count = 0;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                failed_context.context_handle, 0, failed_records.data(),
                failed_records.size(), &failed_count) == 0 && failed_count == 9,
            "post-H2D failure audit event count drifted");
    const auto &failed_h2d = failed_records[5];
    require(failed_h2d.direction == FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D &&
                failed_h2d.reason ==
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D &&
                failed_h2d.status == FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED &&
                failed_h2d.event_flags ==
                    (FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED) &&
                failed_h2d.bytes == potential_bytes + current_bytes &&
                failed_h2d.count == 4 &&
                failed_records[8].status ==
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED &&
                (failed_records[8].event_flags &
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SCIENTIFIC_COMMIT) == 0,
            "post-H2D failure reason/status/bytes/commit audit drifted");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(
                failed_context.context_handle) == 0,
            "post-H2D failure context retained partial scientific state");

    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(&import_request, &restored) == 0,
            "fresh-context checkpoint import failed");
    std::vector<double> restored_potential(cells), restored_current(current_count);
    require(readback(restored_context.context_handle, restored.snapshot_handle,
                     restored.accepted_sequence,
                     FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, restored_potential) == 0 &&
                readback(restored_context.context_handle, restored.snapshot_handle,
                         restored.accepted_sequence,
                         FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
                         restored_current) == 0,
            "restored V/J artifact readback failed");
    require(std::memcmp(restored_potential.data(), potential.data(), potential_bytes) == 0 &&
                std::memcmp(restored_current.data(), current.data(), current_bytes) == 0,
            "restore changed V/J or used a hidden re-solve fallback");

    const auto restore_audit_digest = verify_exact_audit(restored_context.context_handle, {
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
              static_upload_bytes, static_upload_count),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
              static_validation_bytes, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_NONE,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT, 0, 0,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
              potential_bytes + current_bytes, 4),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H, 32, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
              potential_bytes, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
              current_bytes, 3),
        event(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
              FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE, 0, 1),
    }, "restore");

    uint64_t builds = 0, hits = 0, applies = 0, fallbacks = UINT64_MAX;
    uint64_t fine = 0, coarse = 0;
    uint32_t levels = 0;
    std::array<uint8_t, 32> hierarchy_digest{};
    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                restored_context.context_handle, &builds, &hits, &applies, &fallbacks,
                &fine, &coarse, &levels, hierarchy_digest.data()) == 0 &&
                builds == 0 && hits == 0 && applies == 0 && fallbacks == 0,
            "checkpoint import used a hidden solve/CPU fallback/source graph");

    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(restored.snapshot_handle) == 0 &&
                fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) == 0 &&
                fullmag_fdm_gpu_transport_context_destroy_v1(restored_context.context_handle) == 0 &&
                fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) == 0,
            "transfer-audit teardown failed");
    const char *evidence_path =
        std::getenv("FULLMAG_FDM_GPU_M1_CHARGE_TRANSFER_AUDIT_EVIDENCE_PATH");
    require(evidence_path != nullptr && evidence_path[0] != '\0',
            "transfer-audit evidence path is required");
    std::ofstream evidence(evidence_path, std::ios::trunc);
    require(evidence.good(), "cannot create transfer-audit evidence JSON");
    evidence << "{\n  \"workload\": \"strict_residency_v1\",\n"
             << "  \"device_ordinal\": " << device << ",\n"
             << "  \"device_name\": \"" << device_properties.name << "\",\n"
             << "  \"device_uuid\": \"" << hex(created.device_uuid, 16) << "\",\n"
             << "  \"compute_major\": " << created.compute_major << ",\n"
             << "  \"compute_minor\": " << created.compute_minor << ",\n"
             << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
             << "  \"cuda_driver\": " << created.cuda_driver << ",\n"
             << "  \"build_digest\": \"" << hex(created.build_digest, 32) << "\",\n"
             << "  \"source_event_count\": 19,\n"
             << "  \"restore_event_count\": 14,\n"
             << "  \"source_operation_audit_digest\": \""
             << hex(source_audit_digest.data(), source_audit_digest.size()) << "\",\n"
             << "  \"restore_operation_audit_digest\": \""
             << hex(restore_audit_digest.data(), restore_audit_digest.size()) << "\",\n"
             << "  \"host_fallback_count\": 0,\n"
             << "  \"exact_order_verified\": true\n}\n";
    require(evidence.good(), "failed to commit transfer-audit evidence JSON");
    std::puts("PASS: FDM GPU M1 charge exact transfer-audit contract");
    return 0;
}
