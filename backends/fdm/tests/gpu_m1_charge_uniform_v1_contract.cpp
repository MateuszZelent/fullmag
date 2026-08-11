#include "fullmag_fdm.h"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kChargeFaceVoltage = 1;

extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t boundary);

struct ChargeFaceV1 {
    uint32_t kind;
    uint32_t axis;
    int32_t side;
    uint32_t reserved;
    uint64_t adjacent_cell;
    double area;
    double value;
};

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
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

bool close(double actual, double expected, double rtol, double atol = 0.0) {
    return std::abs(actual - expected) <= atol + rtol * std::abs(expected);
}

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string hex(const uint8_t *bytes, size_t count) {
    std::string value;
    value.reserve(2 * count);
    constexpr char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < count; ++i) {
        value.push_back(digits[bytes[i] >> 4]);
        value.push_back(digits[bytes[i] & 0xf]);
    }
    return value;
}

} // namespace

int main() {
    constexpr uint64_t nx = 64, ny = 4, nz = 2;
    constexpr uint64_t cells = nx * ny * nz;
    constexpr double h = 1.0e-9;
    constexpr double sigma = 5.0e6;
    constexpr double left_v = 64.0e-3;
    constexpr double right_v = 0.0;
    constexpr double expected_jx = 5.0e12;

    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess, "an actual CUDA device is required; SKIP is forbidden");
    cudaDeviceProp device_properties{};
    require(cudaGetDeviceProperties(&device_properties, device) == cudaSuccess,
            "actual CUDA device properties are required");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy = FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 128ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 64ULL * 1024ULL * 1024ULL;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "FP64 strict CUDA context creation failed");

    std::vector<uint8_t> mask(cells, 1);
    std::vector<double> conductivity(cells, sigma);
    std::vector<ChargeFaceV1> faces;
    faces.reserve(2 * ny * nz);
    for (uint64_t z = 0; z < nz; ++z) {
        for (uint64_t y = 0; y < ny; ++y) {
            faces.push_back({kChargeFaceVoltage, 0, -1, 0, nx * (y + ny * z), h * h, left_v});
            faces.push_back({kChargeFaceVoltage, 0, +1, 0, nx - 1 + nx * (y + ny * z), h * h, right_v});
        }
    }
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t x = 0; x < nx; ++x) {
        faces.push_back({FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 1, -1, 0,
                         x + nx * ny * z, h * h, 0.0});
        faces.push_back({FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 1, +1, 0,
                         x + nx * (ny - 1 + ny * z), h * h, 0.0});
    }
    for (uint64_t y = 0; y < ny; ++y) for (uint64_t x = 0; x < nx; ++x) {
        faces.push_back({FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 2, -1, 0,
                         x + nx * y, h * h, 0.0});
        faces.push_back({FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 2, +1, 0,
                         x + nx * (y + ny * (nz - 1)), h * h, 0.0});
    }
    std::array<uint32_t, 4> formula_ids{{1, 1, 1, 1}};
    std::array<uint8_t, 1> empty{{0}};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        view(mask.data(), mask.size(), sizeof(mask[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8),
        view(conductivity.data(), conductivity.size(), sizeof(conductivity[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64),
        view(empty.data(), 0, sizeof(empty[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(faces.data(), faces.size(), sizeof(ChargeFaceV1), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(), 0, sizeof(empty[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(formula_ids.data(), formula_ids.size(), sizeof(formula_ids[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U32),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    descriptor.grid[0] = nx;
    descriptor.grid[1] = ny;
    descriptor.grid[2] = nz;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = h;
    descriptor.descriptor_revision = 1;
    descriptor.source_revision = 1;
    std::fill(std::begin(descriptor.descriptor_digest), std::end(descriptor.descriptor_digest), 0x5a);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    const uint32_t descriptor_status =
        fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
            created.context_handle, &descriptor);
    if (descriptor_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "uniform descriptor status=%u\n", descriptor_status);
    require(descriptor_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "uniform charge descriptor upload failed");

    fullmag_fdm_gpu_charge_solve_request_v1 solve{};
    init_record(solve);
    solve.context_handle = created.context_handle;
    solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    solve.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    solve.attempt_id = 1;
    solve.stage_id = 1;
    solve.source_revision = 1;
    solve.static_revision = 1;
    solve.relative_tolerance = 1.0e-13;
    solve.max_iterations = 500;
    fullmag_fdm_gpu_charge_solve_result_v1 solved{};
    init_record(solved);
    const uint32_t solve_status = fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved);
    if (solve_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        (void)fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle);
        std::fprintf(stderr,
                     "FAIL: charge_uniform_v1 expected solve=OK, got status=%u (Phase1 RED expects UNSUPPORTED=1)\n",
                     solve_status);
        return 1;
    }
    require(solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            "uniform charge solve did not converge");
    require(solved.physical_residual <= 1.0e-10 && solved.component_balance <= 1.0e-10 &&
                solved.electrode_balance <= 1.0e-10,
            "uniform charge physical balance exceeded the frozen tolerance");

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, solved.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "uniform charge candidate was not atomically accepted");

    std::vector<double> potential(cells);
    const uint64_t jx_count = (nx + 1) * ny * nz;
    const uint64_t jy_count = nx * (ny + 1) * nz;
    const uint64_t jz_count = nx * ny * (nz + 1);
    std::vector<double> current(jx_count + jy_count + jz_count);
    auto readback = [&](const fullmag_fdm_gpu_charge_snapshot_info_v1 &accepted,
                        uint32_t field, std::vector<double> &destination) {
        auto destination_view = view(destination.data(), destination.size(), sizeof(double),
                                     FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
                                     field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
                                         ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
                                         : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
        destination_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle = created.context_handle;
        request.snapshot_handle = accepted.snapshot_handle;
        request.field_id = field;
        request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count = destination.size();
        request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
        request.expected_bytes = destination.size() * sizeof(double);
        request.accepted_sequence = accepted.accepted_sequence;
        require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "accepted charge artifact readback failed");
    };
    readback(snapshot, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, potential);
    readback(snapshot, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, current);

    for (uint64_t z = 0; z < nz; ++z) for (uint64_t y = 0; y < ny; ++y)
        for (uint64_t x = 0; x < nx; ++x) {
            const uint64_t i = x + nx * (y + ny * z);
            const double expected = left_v - (static_cast<double>(x) + 0.5) * 1.0e-3;
            require(close(potential[i], expected, 1.0e-12), "uniform analytic V profile mismatch");
        }
    double max_jx_relative_error = 0.0;
    for (uint64_t i = 0; i < jx_count; ++i)
        max_jx_relative_error = std::max(
            max_jx_relative_error, std::abs(current[i] - expected_jx) / expected_jx);
    if (max_jx_relative_error > 1.0e-12)
        std::fprintf(stderr, "uniform Jx max relative error=%.17g\n", max_jx_relative_error);
    require(max_jx_relative_error <= 1.0e-12, "uniform oriented Jx mismatch");
    double max_transverse = 0.0;
    for (uint64_t i = jx_count; i < current.size(); ++i)
        max_transverse = std::max(max_transverse, std::abs(current[i]));
    require(max_transverse / expected_jx <= 1.0e-12,
            "uniform transverse face current exceeded the frozen Jc relative tolerance");

    fullmag_fdm_gpu_charge_solve_request_v1 cached_solve = solve;
    cached_solve.attempt_id = 2;
    fullmag_fdm_gpu_charge_solve_result_v1 cached_solved{};
    init_record(cached_solved);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&cached_solve, &cached_solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                cached_solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED &&
                solved.transfer_count == 5 && cached_solved.transfer_count == 5,
            "unchanged descriptor cache-reuse solve failed");
    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 32> telemetry{};
    uint64_t telemetry_count = 0;
    const uint32_t telemetry_status = fullmag_fdm_gpu_transport_query_telemetry_v1(
        created.context_handle, 0, telemetry.data(), telemetry.size(), &telemetry_count);
    if (telemetry_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK || telemetry_count != 24)
        std::fprintf(stderr, "uniform telemetry diagnostics: status=%u count=%llu\n",
                     telemetry_status, static_cast<unsigned long long>(telemetry_count));
    require(telemetry_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && telemetry_count == 24,
            "bounded charge telemetry query did not publish upload, readback and two complete solve audits");
    uint64_t scalar_transfer_count = 0, synchronization_count = 0;
    uint64_t static_upload_count = 0, d2d_count = 0, artifact_readback_count = 0;
    std::array<uint8_t, 32> hierarchy_digest{};
    for (uint64_t i = 0; i < telemetry_count; ++i) {
        const auto &record = telemetry[i];
        require(record.audit_sequence == i + 1 &&
                    record.abi_version == FULLMAG_FDM_GPU_TRANSPORT_ABI_V1 &&
                    record.struct_size == sizeof(record),
                "charge telemetry cursor/order/prefix drifted");
        if (record.reason ==
                   FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H) {
            ++scalar_transfer_count;
            require(record.direction == FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H &&
                        record.bytes > 0 && record.count == 1,
                    "bounded scalar D2H transfer audit is incomplete");
        } else if (record.reason ==
                   FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE) {
            ++synchronization_count;
            require(record.direction ==
                            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL &&
                        record.count == 1,
                    "device synchronization telemetry is incomplete");
        } else if (record.reason ==
                   FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D) {
            ++static_upload_count;
            require(record.direction == FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D &&
                        record.bytes > 0 && record.count > 0,
                    "static upload transfer telemetry is incomplete");
        } else if (record.reason ==
                   FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D) {
            ++d2d_count;
            require(record.direction == FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D &&
                        record.bytes > 0 && (record.count == 1 || record.count == 2),
                    "solve-state D2D telemetry is incomplete");
        } else if (record.reason ==
                   FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H) {
            ++artifact_readback_count;
            require(record.direction == FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H &&
                        ((record.bytes == potential.size() * sizeof(double) && record.count == 1) ||
                         (record.bytes == current.size() * sizeof(double) && record.count == 3)),
                    "explicit Jc readback telemetry is incomplete");
        } else {
            require(false, "charge solve emitted a non-frozen v1 telemetry reason");
        }
    }
    uint64_t hierarchy_builds = 0, hierarchy_cache_hits = 0, amg_apply_count = 0;
    uint64_t host_fallback_count = 0, fine_unknowns = 0, coarse_unknowns = 0;
    uint32_t hierarchy_levels = 0;
    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                created.context_handle, &hierarchy_builds, &hierarchy_cache_hits,
                &amg_apply_count, &host_fallback_count, &fine_unknowns,
                &coarse_unknowns, &hierarchy_levels, hierarchy_digest.data()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                hierarchy_builds == 1 && hierarchy_cache_hits == 1 &&
                amg_apply_count == solved.iterations + cached_solved.iterations &&
                scalar_transfer_count == 7 && synchronization_count == 11 &&
                static_upload_count == 1 && d2d_count == 3 &&
                artifact_readback_count == 2 &&
                host_fallback_count == 0 &&
                hierarchy_levels >= 2 && coarse_unknowns > 0 && coarse_unknowns < fine_unknowns &&
                std::any_of(hierarchy_digest.begin(), hierarchy_digest.end(),
                            [](uint8_t byte) { return byte != 0; }),
            "AMG hierarchy/cache/transfer/fallback audit did not satisfy the frozen contract");
    uint64_t tail_count = 0;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                created.context_handle, telemetry[telemetry_count - 1].audit_sequence,
                telemetry.data(), telemetry.size(), &tail_count) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && tail_count == 0,
            "telemetry cursor replayed already-consumed audit records");

    fullmag_fdm_gpu_charge_snapshot_info_v1 warm_snapshot{};
    init_record(warm_snapshot);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, cached_solved.provisional_generation,
                &warm_snapshot) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "warm charge candidate was not atomically accepted");
    uint64_t warm_promotions = 0, warm_uses = 0, warm_cells = 0;
    uint64_t warm_descriptor_revision = 0, warm_source_revision = 0;
    uint32_t warm_valid = 0;
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
                created.context_handle, &warm_promotions, &warm_uses, &warm_cells,
                &warm_descriptor_revision, &warm_source_revision, &warm_valid) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_promotions == 2 && warm_uses == 1 && warm_cells == cells &&
                warm_descriptor_revision == 1 && warm_source_revision == 1 &&
                warm_valid == 1,
            "accepted FP64 charge state was not retained and used as the warm start");
    std::vector<double> accepted_warm(cells);
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_readback_v1(
                created.context_handle, accepted_warm.data(), accepted_warm.size()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "accepted warm vector readback failed");

    require(fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                created.context_handle, 13) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "warm-start rejected-candidate fault hook failed");
    auto rejected_solve = solve;
    rejected_solve.attempt_id = 3;
    fullmag_fdm_gpu_charge_solve_result_v1 rejected_result{};
    init_record(rejected_result);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&rejected_solve, &rejected_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
            "injected rejected candidate did not fail closed");
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
                created.context_handle, &warm_promotions, &warm_uses, &warm_cells,
                &warm_descriptor_revision, &warm_source_revision, &warm_valid) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_promotions == 2 && warm_uses == 1 && warm_valid == 1,
            "rejected candidate overwrote the last accepted warm state");
    std::vector<double> rejected_warm(cells);
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_readback_v1(
                created.context_handle, rejected_warm.data(), rejected_warm.size()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                std::memcmp(rejected_warm.data(), accepted_warm.data(),
                            cells * sizeof(double)) == 0,
            "rejected candidate changed the accepted warm potential bytes");

    auto incompatible_source = solve;
    incompatible_source.attempt_id = 4;
    incompatible_source.source_revision = 2;
    fullmag_fdm_gpu_charge_solve_result_v1 incompatible_result{};
    init_record(incompatible_result);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(
                &incompatible_source, &incompatible_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
            "incompatible source revision did not fail before warm-start reuse");
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
                created.context_handle, &warm_promotions, &warm_uses, &warm_cells,
                &warm_descriptor_revision, &warm_source_revision, &warm_valid) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_promotions == 2 && warm_uses == 1 && warm_valid == 1,
            "incompatible source revision consumed or replaced the warm state");

    auto recovered_solve = solve;
    recovered_solve.attempt_id = 5;
    fullmag_fdm_gpu_charge_solve_result_v1 recovered{};
    init_record(recovered);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&recovered_solve, &recovered) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                recovered.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED &&
                recovered.physical_residual <= 1.0e-10 &&
                recovered.component_balance <= 1.0e-10 &&
                recovered.electrode_balance <= 1.0e-10,
            "accepted warm start did not preserve charge convergence and balance");
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
                created.context_handle, &warm_promotions, &warm_uses, &warm_cells,
                &warm_descriptor_revision, &warm_source_revision, &warm_valid) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_promotions == 2 && warm_uses == 2 && warm_valid == 1,
            "recovered solve did not report use of the accepted warm state");
    fullmag_fdm_gpu_charge_snapshot_info_v1 recovered_snapshot{};
    init_record(recovered_snapshot);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, recovered.provisional_generation,
                &recovered_snapshot) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "recovered warm candidate was not atomically accepted");
    std::vector<double> recovered_potential(cells);
    std::vector<double> recovered_current(current.size());
    readback(recovered_snapshot, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
             recovered_potential);
    readback(recovered_snapshot, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
             recovered_current);
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t y = 0; y < ny; ++y)
        for (uint64_t x = 0; x < nx; ++x) {
            const uint64_t i = x + nx * (y + ny * z);
            const double expected = left_v - (static_cast<double>(x) + 0.5) * 1.0e-3;
            require(close(recovered_potential[i], expected, 1.0e-12),
                    "recovered warm V profile differs from the analytic reference");
        }
    for (uint64_t i = 0; i < jx_count; ++i)
        require(close(recovered_current[i], expected_jx, 1.0e-12),
                "recovered warm Jx differs from the analytic reference");
    for (uint64_t i = jx_count; i < recovered_current.size(); ++i)
        require(std::abs(recovered_current[i]) / expected_jx <= 1.0e-12,
                "recovered warm transverse current exceeds the analytic reference");
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
                created.context_handle, &warm_promotions, &warm_uses, &warm_cells,
                &warm_descriptor_revision, &warm_source_revision, &warm_valid) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_promotions == 3 && warm_uses == 2 && warm_valid == 1,
            "recovered accepted state did not promote the verified warm vector");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(recovered_snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "recovered snapshot destroy failed");

    auto promotion_fault_solve = solve;
    promotion_fault_solve.attempt_id = 6;
    fullmag_fdm_gpu_charge_solve_result_v1 promotion_fault_result{};
    init_record(promotion_fault_result);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(
                &promotion_fault_solve, &promotion_fault_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "warm promotion fault solve setup failed");
    std::vector<double> committed_warm(cells);
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_readback_v1(
                created.context_handle, committed_warm.data(), committed_warm.size()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "warm promotion fault baseline readback failed");
    for (uint32_t boundary : {70u, 71u}) {
        require(fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                    created.context_handle, boundary) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "warm promotion fault hook setup failed");
        fullmag_fdm_gpu_charge_snapshot_info_v1 failed_snapshot{};
        init_record(failed_snapshot);
        require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                    created.context_handle, promotion_fault_result.provisional_generation,
                    &failed_snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR,
                "warm promotion fault did not fail closed");
        std::vector<double> after_failure(cells);
        require(fullmag_fdm_gpu_transport_test_charge_warm_start_readback_v1(
                    created.context_handle, after_failure.data(), after_failure.size()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                std::memcmp(after_failure.data(), committed_warm.data(),
                            cells * sizeof(double)) == 0,
                "failed warm promotion changed the accepted warm vector");
    }
    fullmag_fdm_gpu_charge_snapshot_info_v1 recovered_promotion_snapshot{};
    init_record(recovered_promotion_snapshot);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, promotion_fault_result.provisional_generation,
                &recovered_promotion_snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_charge_snapshot_destroy_v1(
                    recovered_promotion_snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "warm promotion retry after fault did not commit cleanly");

    auto changed_descriptor = descriptor;
    changed_descriptor.descriptor_revision = 2;
    std::fill(std::begin(changed_descriptor.descriptor_digest),
              std::end(changed_descriptor.descriptor_digest), 0x6b);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &changed_descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
            "changed static identity reused a live hierarchy cache");
    require(fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
                created.context_handle, &warm_promotions, &warm_uses, &warm_cells,
                &warm_descriptor_revision, &warm_source_revision, &warm_valid) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_promotions == 3 && warm_uses == 2 && warm_valid == 1,
            "incompatible descriptor consumed or replaced the warm state");
    fullmag_fdm_gpu_transport_context_create_result_v1 changed_created{};
    init_record(changed_created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &changed_created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    changed_created.context_handle, &changed_descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "changed static identity did not create a fresh cache scope");
    auto changed_solve = solve;
    changed_solve.context_handle = changed_created.context_handle;
    changed_solve.attempt_id = 3;
    changed_solve.static_revision = 2;
    fullmag_fdm_gpu_charge_solve_result_v1 changed_solved{};
    init_record(changed_solved);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&changed_solve, &changed_solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "changed static identity fresh-cache solve failed");
    uint64_t changed_builds = 0, changed_hits = 0, changed_amg = 0, changed_fallback = 0;
    uint64_t changed_fine = 0, changed_coarse = 0;
    uint32_t changed_levels = 0;
    std::array<uint8_t, 32> changed_digest{};
    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                changed_created.context_handle, &changed_builds, &changed_hits,
                &changed_amg, &changed_fallback, &changed_fine, &changed_coarse,
                &changed_levels, changed_digest.data()) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                changed_builds == 1 && changed_hits == 0 && changed_amg > 0 &&
                changed_fallback == 0 &&
                fullmag_fdm_gpu_transport_context_destroy_v1(changed_created.context_handle) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "changed static identity did not invalidate hierarchy reuse exactly");

    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "snapshot destroy failed");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(warm_snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "warm snapshot destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "context destroy failed");

    const char *evidence_path = std::getenv("FULLMAG_FDM_GPU_M1_CHARGE_EVIDENCE_PATH");
    require(evidence_path != nullptr && evidence_path[0] != '\0', "evidence path is required");
    std::ofstream evidence(evidence_path, std::ios::trunc);
    require(evidence.good(), "cannot create charge evidence JSON");
    evidence << "{\n  \"workload\": \"charge_uniform_v1\",\n"
             << "  \"device_ordinal\": " << device << ",\n"
             << "  \"device_name\": \"" << device_properties.name << "\",\n"
             << "  \"device_uuid\": \"" << hex(created.device_uuid, 16) << "\",\n"
             << "  \"compute_major\": " << created.compute_major << ",\n"
             << "  \"compute_minor\": " << created.compute_minor << ",\n"
             << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
             << "  \"cuda_driver\": " << created.cuda_driver << ",\n"
             << "  \"build_digest\": \"" << hex(created.build_digest, 32) << "\",\n"
             << "  \"engine_id\": \"fdm_charge_cg_cuda_v1\",\n"
             << "  \"iterations\": " << solved.iterations << ",\n"
             << std::setprecision(17)
             << "  \"algebraic_residual\": " << solved.algebraic_residual << ",\n"
             << "  \"physical_residual\": " << solved.physical_residual << ",\n"
             << "  \"component_balance\": " << solved.component_balance << ",\n"
             << "  \"electrode_balance\": " << solved.electrode_balance << ",\n"
             << "  \"snapshot_digest\": \"" << hex(snapshot.snapshot_content_digest, 32) << "\",\n"
             << "  \"hierarchy_levels\": " << hierarchy_levels << ",\n"
             << "  \"fine_unknown_count\": " << fine_unknowns << ",\n"
             << "  \"coarse_unknown_count\": " << coarse_unknowns << ",\n"
             << "  \"hierarchy_digest\": \"" << hex(hierarchy_digest.data(), 32) << "\",\n"
             << "  \"hierarchy_build_count\": " << hierarchy_builds << ",\n"
             << "  \"hierarchy_cache_hit_count\": " << hierarchy_cache_hits << ",\n"
             << "  \"amg_apply_count\": " << amg_apply_count << ",\n"
             << "  \"scalar_transfer_record_count\": " << scalar_transfer_count << ",\n"
             << "  \"synchronization_record_count\": " << synchronization_count << ",\n"
             << "  \"host_fallback_count\": " << host_fallback_count << "\n}\n";
    require(evidence.good(), "failed to commit charge evidence JSON");
    return 0;
}
