#include "fullmag/fdm/transport/gpu_abi_v1.h"
#include "charge/device_solver.hpp"
#include "charge/checkpoint_codec.hpp"

#include <cuda_runtime_api.h>

#include <array>
#include <algorithm>
#include <cstddef>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr uint64_t kCookie = UINT64_C(0x464d475055545231);
constexpr uint64_t kContextTag = UINT64_C(0x434f4e5445585431);
constexpr uint64_t kSnapshotTag = UINT64_C(0x534e415053484f31);
constexpr uint64_t kSupportedFeatures =
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1 |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;

using ChargeBuffers = fullmag::fdm::gpu::transport::charge::Buffers;
using ChargeHierarchyCache = fullmag::fdm::gpu::transport::charge::HierarchyCache;
using CudaFailurePolicy = fullmag::fdm::gpu::transport::charge::CudaFailurePolicy;

struct LegacyChargeFaceV1 {
    uint32_t kind;
    uint32_t axis;
    int32_t side;
    uint32_t reserved;
    uint64_t adjacent_cell;
    double area;
    double value;
};
static_assert(sizeof(LegacyChargeFaceV1) == 40);

struct Slot {
    uint64_t generation = 0;
    bool active = false;
    bool tombstone = false;
    int device = -1;
    std::array<uint8_t, 16> device_uuid{};
    std::array<uint8_t, 32> build_identity{};
    uint32_t compute_major = 0;
    uint32_t compute_minor = 0;
    uint32_t cuda_runtime = 0;
    uint32_t cuda_driver = 0;
    cudaStream_t stream = nullptr;
    bool static_uploaded = false;
    uint64_t descriptor_revision = 0;
    uint64_t source_revision = 0;
    uint64_t enabled_features = 0;
    std::array<uint8_t, 32> descriptor_digest{};
    uint32_t live_snapshots = 0;
    uint64_t type_tag = 0;
    uint64_t parent_slot = UINT64_MAX;
    uint64_t parent_generation = 0;
    void *static_descriptor_device = nullptr;
    void *static_views_device = nullptr;
    std::array<void *, 6> static_payload_device{};
    std::array<uint64_t, 6> static_payload_bytes{};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> static_views_host{};
    std::vector<uint64_t> charge_adjacent_cells;
    std::vector<uint32_t> charge_axes;
    std::vector<int32_t> charge_sides;
    std::vector<double> charge_areas;
    std::vector<double> charge_values;
    std::vector<std::string> charge_source_ids;
    std::array<uint64_t, 3> grid{};
    std::array<double, 3> cell_size{};
    uint64_t allocator_limit = 0;
    uint64_t workspace_limit = 0;
    uint64_t provisional_generation = 0;
    uint64_t accepted_sequence = 0;
    ChargeBuffers provisional{};
    ChargeBuffers accepted{};
    ChargeHierarchyCache hierarchy_cache{};
    uint64_t iterations = 0;
    double algebraic_residual = 0.0;
    double physical_residual = 0.0;
    double component_balance = 0.0;
    double electrode_balance = 0.0;
    std::array<uint8_t, 32> candidate_digest{};
    std::array<uint8_t, 16> snapshot_lineage{};
    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 128> telemetry{};
    uint64_t telemetry_count = 0;
    uint64_t telemetry_sequence = 0;
    std::array<uint8_t, 32> operation_audit_digest{};
    uint64_t hierarchy_build_count = 0;
    uint64_t hierarchy_cache_hit_count = 0;
    uint64_t amg_apply_count = 0;
    uint64_t host_fallback_count = 0;
    uint64_t fine_unknown_count = 0;
    uint64_t coarse_unknown_count = 0;
    uint32_t hierarchy_levels = 0;
    std::array<uint8_t, 32> hierarchy_digest{};
    bool test_force_import_digest_mismatch = false;
    uint32_t test_failure_boundary = 0;
};

std::array<Slot, 4> slots{};
std::mutex registry_mutex;

bool same(const fullmag_fdm_gpu_transport_context_handle_v1 &, size_t,
          uint64_t);

uint32_t require_charge_feature(
    const fullmag_fdm_gpu_transport_context_handle_v1 &context) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        !slot.static_uploaded)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    return (slot.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) != 0
        ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
        : FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
}

template <typename Function>
uint32_t abi_allocation_guard(Function &&function) noexcept {
    try {
        return function();
    } catch (const std::bad_alloc &) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    } catch (const std::length_error &) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    } catch (...) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
}

extern "C" void fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
    const void *, uint64_t, uint8_t[32]);

bool reserve_telemetry_sequences(const Slot &slot, uint64_t count) {
    return count <= UINT64_MAX - slot.telemetry_sequence;
}

bool append_charge_telemetry(
    Slot &slot, uint32_t direction, uint32_t reason, uint32_t status,
    uint32_t event_flags, uint64_t bytes, uint64_t count,
    uint64_t attempt_id, uint64_t stage_id, uint64_t iteration,
    const uint8_t scientific_digest[32] = nullptr) {
    if (!reserve_telemetry_sequences(slot, 1)) return false;
    if (slot.telemetry_count == slot.telemetry.size()) {
        std::move(slot.telemetry.begin() + 1, slot.telemetry.end(), slot.telemetry.begin());
        --slot.telemetry_count;
    }
    auto &record = slot.telemetry[slot.telemetry_count++];
    record = {};
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
    record.audit_sequence = ++slot.telemetry_sequence;
    record.direction = direction;
    record.reason = reason;
    record.status = status;
    record.event_flags = event_flags;
    record.bytes = bytes;
    record.count = count;
    record.attempt_id = attempt_id;
    record.stage_id = stage_id;
    record.iteration = iteration;
    record.stream_id = 1;
    record.event_id = record.audit_sequence;
    static_assert(offsetof(fullmag_fdm_gpu_transport_telemetry_v1,
                           operation_audit_digest) == 112);
    static_assert(offsetof(fullmag_fdm_gpu_transport_telemetry_v1,
                           scientific_continuation_digest) == 144);
    std::array<uint8_t, 176> audit_domain{};
    std::memcpy(audit_domain.data(), slot.operation_audit_digest.data(), 32);
    std::memcpy(audit_domain.data() + 32, &record, 144);
    fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
        audit_domain.data(), audit_domain.size(), record.operation_audit_digest);
    std::memcpy(slot.operation_audit_digest.data(), record.operation_audit_digest, 32);
    if (scientific_digest != nullptr)
        std::memcpy(record.scientific_continuation_digest, scientific_digest, 32);
    return true;
}

struct AuditBoundary {
    uint32_t direction;
    uint32_t reason;
    uint32_t flags;
    uint64_t bytes;
    uint64_t count;
};

void publish_boundary_failure(
    Slot &slot, uint32_t boundary_base, uint32_t failed_boundary,
    const AuditBoundary *boundaries, size_t boundary_count,
    uint64_t attempt_id, uint64_t stage_id,
    uint64_t iteration, const uint8_t scientific_digest[32]) {
    if (failed_boundary < boundary_base ||
        failed_boundary >= boundary_base + boundary_count) return;
    const size_t failed_index = failed_boundary - boundary_base;
    for (size_t index = 0; index <= failed_index; ++index) {
        const auto &boundary = boundaries[index];
        const bool failed = index == failed_index;
        append_charge_telemetry(
            slot, boundary.direction, boundary.reason,
            failed ? FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED
                   : FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            boundary.flags |
                (failed ? FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED : 0),
            failed ? 0 : boundary.bytes, failed ? 0 : boundary.count,
            attempt_id, stage_id, iteration,
            scientific_digest);
    }
}

uint32_t append_rejected_import_telemetry(
    const fullmag_fdm_gpu_transport_checkpoint_import_request_v1 &request) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (request.context_handle.registry_cookie != kCookie ||
        request.context_handle.type_tag != kContextTag ||
        request.context_handle.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[request.context_handle.slot];
    if (!same(request.context_handle, request.context_handle.slot, slot.generation) ||
        !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (!reserve_telemetry_sequences(slot, 1))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    if (!append_charge_telemetry(
        slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_NONE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
        0, 0, 0, 0, 0, nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

void release_charge_buffers(ChargeBuffers &buffers) {
    fullmag::fdm::gpu::transport::charge::release(buffers);
}

void release_charge_hierarchy(ChargeHierarchyCache &cache) {
    fullmag::fdm::gpu::transport::charge::release(cache);
}

uint32_t accepted_charge_content_digest(
    Slot &parent, const ChargeBuffers &buffers, uint64_t accepted_sequence,
    const std::array<uint8_t, 16> &lineage, std::array<uint8_t, 32> *digest,
    CudaFailurePolicy *failure_policy = nullptr, uint32_t copy_boundary = 0,
    uint32_t sync_boundary = 0) {
    fullmag::fdm::gpu::transport::charge::ContentDigestIdentity identity{};
    identity.device_uuid = parent.device_uuid;
    identity.build_digest = parent.build_identity;
    identity.static_digest = parent.descriptor_digest;
    identity.lineage = lineage;
    identity.grid = parent.grid;
    identity.cell_size = parent.cell_size;
    identity.compute_major = parent.compute_major;
    identity.compute_minor = parent.compute_minor;
    identity.cuda_driver = parent.cuda_driver;
    identity.cuda_runtime = parent.cuda_runtime;
    identity.descriptor_revision = parent.descriptor_revision;
    identity.source_revision = parent.source_revision;
    identity.accepted_sequence = accepted_sequence;
    identity.iterations = parent.iterations;
    identity.component_balance = parent.component_balance;
    identity.physical_residual = parent.physical_residual;
    return fullmag::fdm::gpu::transport::charge::content_digest_device(
        buffers, parent.static_payload_device[3],
        parent.static_views_host[3].element_count,
        parent.static_views_host[3].byte_stride,
        identity, parent.stream, digest->data(), failure_policy,
        copy_boundary, sync_boundary);
}

uint32_t validate_prefix(uint32_t abi_version, uint32_t struct_version,
                         uint32_t struct_size, uint32_t min_size,
                         uint32_t reserved_flags, uint64_t required_features,
                         uint64_t known_features, uint64_t reserved0) {
    if (abi_version != 1 || struct_version != 1 || struct_size < min_size) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INCOMPATIBLE_ABI;
    }
    if (required_features & ~known_features) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    }
    if (reserved_flags != 0 || reserved0 != 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

bool same(const fullmag_fdm_gpu_transport_context_handle_v1 &h, size_t slot,
          uint64_t generation) {
    return h.registry_cookie == kCookie && h.slot == slot &&
           h.generation == generation && h.type_tag == kContextTag;
}

bool same_snapshot(const fullmag_fdm_gpu_charge_snapshot_handle_v1 &h, size_t slot,
                   uint64_t generation) {
    return h.registry_cookie == kCookie && h.slot == slot &&
           h.generation == generation && h.type_tag == kSnapshotTag;
}

uint32_t validate_host_view(uint64_t view_address,
                            fullmag_fdm_gpu_transport_buffer_view_v1 *validated) {
    if (view_address == 0 || validated == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const auto *view = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        static_cast<uintptr_t>(view_address));
    const uint32_t prefix = validate_prefix(
        view->abi_version, view->struct_version, view->struct_size, sizeof(*view),
        view->reserved_flags, view->required_features, 0, view->reserved0);
    if (prefix != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return prefix;
    if (view->reserved1 != 0 || view->element_type == 0 || view->element_type > 6 ||
        view->component_order == 0 || view->component_order > 5)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (view->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_POINTER_SPACE;
    const uint64_t width = view->element_type == 1 ? 1 :
        view->element_type == 2 || view->element_type == 4 ? 4 :
        view->element_type == 3 || view->element_type == 5 ? 8 : 1;
    if (view->element_count != 0 && view->byte_stride > UINT64_MAX / view->element_count)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (view->byte_stride < width || view->byte_length != view->element_count * view->byte_stride ||
        (view->address != 0 && view->address % width != 0) ||
        (view->byte_length != 0 && view->address == 0))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    *validated = *view;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

bool all_zero(const uint8_t *bytes, size_t size) {
    for (size_t i = 0; i < size; ++i) if (bytes[i] != 0) return false;
    return true;
}

std::array<uint8_t, 32> build_digest() {
    constexpr const char *hex = FULLMAG_FDM_GPU_TRANSPORT_BUILD_DIGEST_HEX;
    static_assert(sizeof(FULLMAG_FDM_GPU_TRANSPORT_BUILD_DIGEST_HEX) == 65,
                  "generated build digest must be 64 hexadecimal characters");
    const auto nibble = [](char c) -> uint8_t {
        return static_cast<uint8_t>(c >= '0' && c <= '9' ? c - '0' :
                                    c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                                    c >= 'A' && c <= 'F' ? c - 'A' + 10 : 0xff);
    };
    std::array<uint8_t, 32> digest{};
    for (size_t i = 0; i < digest.size(); ++i) {
        const uint8_t high = nibble(hex[2 * i]);
        const uint8_t low = nibble(hex[2 * i + 1]);
        if (high > 0x0f || low > 0x0f) return {};
        digest[i] = static_cast<uint8_t>((high << 4) | low);
    }
    return digest;
}

}

extern "C" uint32_t fullmag_fdm_gpu_transport_context_create_v1(
    const fullmag_fdm_gpu_transport_context_create_request_v1 *request,
    fullmag_fdm_gpu_transport_context_create_result_v1 *result) {
    if (request == nullptr || result == nullptr) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    uint32_t status = validate_prefix(
        request->abi_version, request->struct_version, request->struct_size,
        sizeof(*request), request->reserved_flags, request->required_features,
        UINT64_C(0x7f), request->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        return status;
    }
    status = validate_prefix(result->abi_version, result->struct_version,
                             result->struct_size, sizeof(*result),
                             result->reserved_flags, result->required_features,
                             UINT64_C(0x7f), result->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        return status;
    }
    if (request->reserved1 != 0 || request->reserved2 != 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    if (((request->required_features | request->requested_device_features) &
         ~FULLMAG_FDM_GPU_TRANSPORT_KNOWN_GLOBAL_FEATURES_V1) != 0 ||
        ((request->required_features | request->requested_device_features) &
         ~kSupportedFeatures) != 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    }
    if (request->precision > FULLMAG_FDM_GPU_TRANSPORT_PRECISION_SINGLE_KNOWN_UNSUPPORTED ||
        request->precision == FULLMAG_FDM_GPU_TRANSPORT_PRECISION_INVALID ||
        request->strict_residency > 1 || request->deterministic > 1 ||
        request->stream_policy > FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM ||
        request->stream_policy == FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_INVALID) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    if (request->precision != FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE ||
        request->strict_residency != 1) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
    }

    int device_count = 0;
    if (cudaGetDeviceCount(&device_count) != cudaSuccess || request->device_ordinal < 0 ||
        request->device_ordinal >= device_count) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    cudaDeviceProp prop{};
    if (cudaGetDeviceProperties(&prop, request->device_ordinal) != cudaSuccess) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (!all_zero(request->device_uuid, sizeof(request->device_uuid)) &&
        std::memcmp(request->device_uuid, prop.uuid.bytes, sizeof(request->device_uuid)) != 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    const uint64_t minimum_owned_bytes = sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1);
    if ((request->allocator_limit != 0 && request->allocator_limit < minimum_owned_bytes) ||
        (request->workspace_limit != 0 && request->workspace_limit < sizeof(double))) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    }
    if (cudaSetDevice(request->device_ordinal) != cudaSuccess) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }

    std::lock_guard<std::mutex> lock(registry_mutex);
    for (size_t i = 0; i < slots.size(); ++i) {
        Slot &slot = slots[i];
        if (slot.active || slot.generation == UINT64_MAX) {
            continue;
        }
        cudaStream_t stream = nullptr;
        if (cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking) != cudaSuccess) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        ++slot.generation;
        slot.active = true;
        slot.tombstone = false;
        slot.device = request->device_ordinal;
        std::memcpy(slot.device_uuid.data(), prop.uuid.bytes, slot.device_uuid.size());
        slot.compute_major = static_cast<uint32_t>(prop.major);
        slot.compute_minor = static_cast<uint32_t>(prop.minor);
        slot.stream = stream;
        slot.type_tag = kContextTag;
        slot.static_uploaded = false;
        slot.enabled_features = 0;
        slot.live_snapshots = 0;
        slot.allocator_limit = request->allocator_limit;
        slot.workspace_limit = request->workspace_limit;
        slot.static_payload_device.fill(nullptr);
        slot.static_payload_bytes.fill(0);
        slot.static_views_host.fill({});
        slot.charge_adjacent_cells.clear();
        slot.charge_axes.clear();
        slot.charge_sides.clear();
        slot.charge_areas.clear();
        slot.charge_values.clear();
        slot.charge_source_ids.clear();
        slot.static_views_device = nullptr;
        slot.grid.fill(0);
        slot.cell_size.fill(0.0);
        slot.provisional_generation = 0;
        slot.accepted_sequence = 0;
        slot.provisional = {};
        slot.accepted = {};
        slot.hierarchy_cache = {};
        slot.telemetry.fill({});
        slot.telemetry_count = 0;
        slot.telemetry_sequence = 0;
        slot.operation_audit_digest.fill(0);
        slot.hierarchy_build_count = 0;
        slot.hierarchy_cache_hit_count = 0;
        slot.amg_apply_count = 0;
        slot.host_fallback_count = 0;
        slot.fine_unknown_count = 0;
        slot.coarse_unknown_count = 0;
        slot.hierarchy_levels = 0;
        slot.hierarchy_digest.fill(0);
        slot.test_force_import_digest_mismatch = false;
        slot.test_failure_boundary = 0;
        result->context_handle = {kCookie, i, slot.generation, kContextTag};
        std::memcpy(result->device_uuid, prop.uuid.bytes, sizeof(result->device_uuid));
        result->compute_major = static_cast<uint32_t>(prop.major);
        result->compute_minor = static_cast<uint32_t>(prop.minor);
        int runtime = 0;
        int driver = 0;
        (void)cudaRuntimeGetVersion(&runtime);
        (void)cudaDriverGetVersion(&driver);
        result->cuda_runtime = static_cast<uint32_t>(runtime);
        result->cuda_driver = static_cast<uint32_t>(driver);
        slot.cuda_runtime = result->cuda_runtime;
        slot.cuda_driver = result->cuda_driver;
        const auto digest = build_digest();
        std::memcpy(result->build_digest, digest.data(), digest.size());
        slot.build_identity = digest;
        result->supported_features = kSupportedFeatures;
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_context_destroy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size()) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || slot.type_tag != kContextTag) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    if (!slot.active && slot.tombstone) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED;
    }
    if (!slot.active) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    if (slot.live_snapshots != 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_LIVE_SNAPSHOT;
    }
    (void)cudaSetDevice(slot.device);
    release_charge_buffers(slot.provisional);
    release_charge_buffers(slot.accepted);
    release_charge_hierarchy(slot.hierarchy_cache);
    if (cudaStreamDestroy(slot.stream) != cudaSuccess) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (slot.static_descriptor_device != nullptr) {
        if (cudaFree(slot.static_descriptor_device) != cudaSuccess)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        slot.static_descriptor_device = nullptr;
    }
    if (slot.static_views_device != nullptr) {
        if (cudaFree(slot.static_views_device) != cudaSuccess)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        slot.static_views_device = nullptr;
    }
    for (void *&payload : slot.static_payload_device) {
        if (payload != nullptr && cudaFree(payload) != cudaSuccess)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        payload = nullptr;
    }
    slot.stream = nullptr;
    slot.active = false;
    slot.tombstone = true;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t static_descriptor_upload_impl(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_transport_static_descriptor_v1 *descriptor) {
    if (descriptor == nullptr) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    uint32_t status = validate_prefix(
        descriptor->abi_version, descriptor->struct_version, descriptor->struct_size,
        sizeof(*descriptor), descriptor->reserved_flags, descriptor->required_features,
        UINT64_C(0x1c), descriptor->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        return status;
    }
    if (descriptor->reserved1 != 0 || descriptor->descriptor_revision == 0 ||
        descriptor->source_revision == 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    uint64_t cells = 1;
    for (size_t axis = 0; axis < 3; ++axis) {
        if (descriptor->grid[axis] == 0 ||
            descriptor->grid[axis] > UINT64_MAX / cells ||
            !std::isfinite(descriptor->cell_size[axis]) ||
            descriptor->cell_size[axis] <= 0.0) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        cells *= descriptor->grid[axis];
    }
    if (cells > UINT64_MAX / sizeof(double)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    bool digest_nonzero = false;
    for (uint8_t byte : descriptor->descriptor_digest) {
        digest_nonzero = digest_nonzero || byte != 0;
    }
    if (!digest_nonzero) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }

    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size()) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || slot.type_tag != kContextTag ||
        !slot.active) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    const bool same_identity =
        slot.descriptor_revision == descriptor->descriptor_revision &&
        slot.source_revision == descriptor->source_revision &&
        std::memcmp(slot.descriptor_digest.data(), descriptor->descriptor_digest,
                    slot.descriptor_digest.size()) == 0;
    if (slot.static_uploaded) {
        return same_identity ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
                             : FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    const std::array<uint64_t, 6> view_addresses = {
        descriptor->masks_view_ptr, descriptor->materials_view_ptr,
        descriptor->interfaces_view_ptr, descriptor->charge_faces_view_ptr,
        descriptor->spin_faces_view_ptr, descriptor->formula_ids_view_ptr};
    const bool charge_enabled =
        (descriptor->required_features &
         FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) != 0;
    if (!charge_enabled) {
        // The feature graph owns interpretation of charge-specific fields.  A
        // descriptor without M1 charge may carry opaque/sentinel values in
        // those append-only ABI fields; they must never be dereferenced.
        if (cudaSetDevice(slot.device) != cudaSuccess)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        void *device_descriptor = nullptr;
        if (cudaMalloc(&device_descriptor, sizeof(*descriptor)) != cudaSuccess)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
        if (cudaMemcpyAsync(device_descriptor, descriptor, sizeof(*descriptor),
                            cudaMemcpyHostToDevice, slot.stream) != cudaSuccess ||
            cudaStreamSynchronize(slot.stream) != cudaSuccess) {
            (void)cudaFree(device_descriptor);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        slot.descriptor_revision = descriptor->descriptor_revision;
        slot.source_revision = descriptor->source_revision;
        std::memcpy(slot.descriptor_digest.data(), descriptor->descriptor_digest,
                    slot.descriptor_digest.size());
        slot.enabled_features = descriptor->required_features;
        slot.static_descriptor_device = device_descriptor;
        slot.grid = {descriptor->grid[0], descriptor->grid[1], descriptor->grid[2]};
        slot.cell_size = {descriptor->cell_size[0], descriptor->cell_size[1],
                          descriptor->cell_size[2]};
        slot.static_uploaded = true;
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }
    if (!reserve_telemetry_sequences(slot, 4))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{};
    uint64_t payload_bytes = 0;
    for (size_t i = 0; i < views.size(); ++i) {
        status = validate_host_view(view_addresses[i], &views[i]);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
        if (views[i].byte_length > UINT64_MAX - payload_bytes)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        payload_bytes += views[i].byte_length;
    }
    constexpr uint64_t view_record_bytes =
        sizeof(fullmag_fdm_gpu_transport_buffer_view_v1) * 6;
    constexpr uint64_t fixed_static_bytes =
        sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1) + view_record_bytes;
    if (payload_bytes > UINT64_MAX - fixed_static_bytes)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const uint64_t owned_bytes = fixed_static_bytes + payload_bytes;
    if (slot.allocator_limit != 0 && owned_bytes > slot.allocator_limit)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const bool legacy_cells =
        views[0].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8 &&
        views[0].element_count == cells;
    const bool typed_cells =
        views[0].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES &&
        views[0].element_count == cells &&
        views[0].byte_stride >= sizeof(fullmag_fdm_gpu_transport_charge_cell_v1);
    const bool legacy_materials =
        views[1].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64 &&
        (views[1].element_count == 1 || views[1].element_count == cells);
    const bool typed_materials =
        views[1].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES &&
        views[1].element_count != 0 &&
        views[1].byte_stride >= sizeof(fullmag_fdm_gpu_transport_charge_material_v1);
    const bool legacy_formula =
        views[5].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U32 &&
        views[5].element_count >= 4;
    const bool typed_formula =
        views[5].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES &&
        views[5].element_count == 1 &&
        views[5].byte_stride >= sizeof(fullmag_fdm_gpu_transport_charge_formula_ids_v1);
    const bool legacy_faces = views[3].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES &&
        (views[3].element_count == 0 || views[3].byte_stride == sizeof(LegacyChargeFaceV1));
    const bool typed_faces = views[3].element_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES &&
        (views[3].element_count == 0 ||
         views[3].byte_stride >= sizeof(fullmag_fdm_gpu_transport_charge_face_v1));
    if ((!legacy_cells && !typed_cells) || (!legacy_materials && !typed_materials) ||
        (!legacy_formula && !typed_formula) || (!legacy_faces && !typed_faces))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (legacy_materials) {
        for (uint64_t i = 0; i < views[1].element_count; ++i) {
            const auto *value = reinterpret_cast<const double *>(
                reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[1].address)) +
                i * views[1].byte_stride);
            if (!std::isfinite(*value) || *value <= 0.0)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
    } else {
        for (uint64_t i = 0; i < views[1].element_count; ++i) {
            const auto *material = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_material_v1 *>(
                reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[1].address)) +
                i * views[1].byte_stride);
            status = validate_prefix(material->abi_version, material->struct_version,
                material->struct_size, sizeof(*material), material->reserved_flags,
                material->required_features, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
                material->reserved0);
            if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
            if (material->reserved1 != 0 || material->material_revision == 0 ||
                !std::isfinite(material->conductivity) || material->conductivity <= 0.0)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            for (uint64_t j = 0; j < i; ++j) {
                const auto *prior = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_material_v1 *>(
                    reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[1].address)) +
                    j * views[1].byte_stride);
                if (prior->material_index == material->material_index)
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            }
        }
    }
    if (typed_cells) {
        for (uint64_t i = 0; i < cells; ++i) {
            const auto *cell = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_cell_v1 *>(
                reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[0].address)) +
                i * views[0].byte_stride);
            status = validate_prefix(cell->abi_version, cell->struct_version, cell->struct_size,
                sizeof(*cell), cell->reserved_flags, cell->required_features,
                FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE, cell->reserved0);
            if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
            if (cell->active > 1 || cell->conductor > 1 || cell->reserved1 != 0 ||
                (cell->conductor != 0 && cell->active == 0))
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            if (cell->active && cell->conductor && typed_materials) {
                bool found = false;
                for (uint64_t material_index = 0; material_index < views[1].element_count; ++material_index) {
                    const auto *material = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_material_v1 *>(
                        reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[1].address)) +
                        material_index * views[1].byte_stride);
                    found = found || material->material_index == cell->material_index;
                }
                if (!found) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            }
        }
    }
    if (legacy_formula) {
        for (uint64_t i = 0; i < views[5].element_count; ++i) {
            const auto *value = reinterpret_cast<const uint32_t *>(
                reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[5].address)) +
                i * views[5].byte_stride);
            if (*value == 0) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
    } else {
        const auto *formula = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_formula_ids_v1 *>(
            static_cast<uintptr_t>(views[5].address));
        status = validate_prefix(formula->abi_version, formula->struct_version, formula->struct_size,
            sizeof(*formula), formula->reserved_flags, formula->required_features,
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE, formula->reserved0);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
        if (formula->formula_id != FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1 ||
            formula->operator_id != FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1 ||
            formula->engine_id != FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1 ||
            formula->residual_id != FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1 ||
            formula->operator_revision == 0 || formula->reserved1 != 0)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    std::vector<uint64_t> charge_adjacent_cells;
    std::vector<uint32_t> charge_axes;
    std::vector<int32_t> charge_sides;
    std::vector<double> charge_areas;
    std::vector<double> charge_values;
    std::vector<std::string> charge_source_ids;
    for (uint64_t i = 0; i < views[3].element_count; ++i) {
        const uint8_t *bytes = reinterpret_cast<const uint8_t *>(
            static_cast<uintptr_t>(views[3].address)) + i * views[3].byte_stride;
        uint32_t kind = 0, axis = 0;
        int32_t side = 0;
        uint64_t adjacent = 0;
        uint64_t canonical_face_index = UINT64_MAX;
        uint64_t source_id = i + 1;
        double area = 0.0, value = 0.0;
        if (legacy_faces) {
            const auto *face = reinterpret_cast<const LegacyChargeFaceV1 *>(bytes);
            if (face->reserved != 0) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            kind = face->kind; axis = face->axis; side = face->side;
            adjacent = face->adjacent_cell; area = face->area; value = face->value;
        } else {
            const auto *face = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_face_v1 *>(bytes);
            status = validate_prefix(face->abi_version, face->struct_version, face->struct_size,
                sizeof(*face), face->reserved_flags, face->required_features,
                FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE, face->reserved0);
            if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
            if (face->outward_sign != face->side || face->source_id == 0)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            kind = face->kind; axis = face->axis; side = face->side;
            adjacent = face->adjacent_cell; area = face->area; value = face->value;
            canonical_face_index = face->canonical_face_index;
            source_id = face->source_id;
        }
        if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INVALID ||
            kind > FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING || axis > 2 ||
            (side != -1 && side != 1) || adjacent >= cells || !std::isfinite(area) ||
            area <= 0.0 || !std::isfinite(value) ||
            (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING && value != 0.0))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const uint64_t x = adjacent % descriptor->grid[0];
        const uint64_t yz = adjacent / descriptor->grid[0];
        const uint64_t y = yz % descriptor->grid[1];
        const uint64_t z = yz / descriptor->grid[1];
        const uint64_t coordinate = axis == 0 ? x : axis == 1 ? y : z;
        const uint64_t extent = descriptor->grid[axis];
        const double expected_area = axis == 0
            ? descriptor->cell_size[1] * descriptor->cell_size[2]
            : axis == 1 ? descriptor->cell_size[0] * descriptor->cell_size[2]
                        : descriptor->cell_size[0] * descriptor->cell_size[1];
        const uint64_t expected_face_index = axis == 0
            ? (side < 0 ? 0 : descriptor->grid[0]) +
                (descriptor->grid[0] + 1) * (y + descriptor->grid[1] * z)
            : axis == 1
                ? x + descriptor->grid[0] *
                    ((side < 0 ? 0 : descriptor->grid[1]) +
                     (descriptor->grid[1] + 1) * z)
                : x + descriptor->grid[0] *
                    (y + descriptor->grid[1] * (side < 0 ? 0 : descriptor->grid[2]));
        const bool adjacent_active = legacy_cells
            ? *(reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[0].address)) +
                adjacent * views[0].byte_stride) != 0
            : [&]() {
                const auto *cell = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_cell_v1 *>(
                    reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[0].address)) +
                    adjacent * views[0].byte_stride);
                return cell->active != 0 && cell->conductor != 0;
              }();
        if ((side == -1 && coordinate != 0) || (side == 1 && coordinate + 1 != extent) ||
            std::abs(area - expected_area) > 1.0e-12 * expected_area || !adjacent_active ||
            (typed_faces && canonical_face_index != expected_face_index))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        for (uint64_t j = 0; j < i; ++j) {
            const uint8_t *prior_bytes = reinterpret_cast<const uint8_t *>(
                static_cast<uintptr_t>(views[3].address)) + j * views[3].byte_stride;
            uint32_t prior_axis = 0; int32_t prior_side = 0; uint64_t prior_adjacent = 0;
            if (legacy_faces) {
                const auto *prior = reinterpret_cast<const LegacyChargeFaceV1 *>(prior_bytes);
                prior_axis = prior->axis; prior_side = prior->side; prior_adjacent = prior->adjacent_cell;
            } else {
                const auto *prior = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_face_v1 *>(prior_bytes);
                prior_axis = prior->axis; prior_side = prior->side; prior_adjacent = prior->adjacent_cell;
            }
            if (prior_axis == axis && prior_side == side && prior_adjacent == adjacent)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY) {
            charge_adjacent_cells.push_back(adjacent);
            charge_axes.push_back(axis);
            charge_sides.push_back(side);
            charge_areas.push_back(area);
            charge_values.push_back(value);
            charge_source_ids.push_back(std::to_string(source_id));
        }
    }
    for (size_t i = 0; i < views.size(); ++i) for (size_t j = i + 1; j < views.size(); ++j) {
        const uint64_t a0 = views[i].address, a1 = a0 + views[i].byte_length;
        const uint64_t b0 = views[j].address, b1 = b0 + views[j].byte_length;
        if (a1 < a0 || b1 < b0 || (views[i].byte_length && views[j].byte_length && a0 < b1 && b0 < a1))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    }
    void *device_descriptor = nullptr;
    void *device_views = nullptr;
    std::array<void *, 6> device_payloads{};
    if (cudaSetDevice(slot.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (cudaMalloc(&device_descriptor, sizeof(*descriptor)) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    if (cudaMalloc(&device_views, view_record_bytes) != cudaSuccess) {
        (void)cudaFree(device_descriptor);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    for (size_t i = 0; i < views.size(); ++i) {
        if (views[i].byte_length == 0) continue;
        if (cudaMalloc(&device_payloads[i], views[i].byte_length) != cudaSuccess) {
            for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
            (void)cudaFree(device_views);
            (void)cudaFree(device_descriptor);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
        }
    }
    auto device_view_records = views;
    for (size_t i = 0; i < device_view_records.size(); ++i) {
        device_view_records[i].address = reinterpret_cast<uint64_t>(device_payloads[i]);
        device_view_records[i].pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY;
    }
    auto device_descriptor_record = *descriptor;
    uint64_t *descriptor_view_fields[] = {
        &device_descriptor_record.masks_view_ptr, &device_descriptor_record.materials_view_ptr,
        &device_descriptor_record.interfaces_view_ptr, &device_descriptor_record.charge_faces_view_ptr,
        &device_descriptor_record.spin_faces_view_ptr, &device_descriptor_record.formula_ids_view_ptr};
    for (size_t i = 0; i < views.size(); ++i)
        *descriptor_view_fields[i] = reinterpret_cast<uint64_t>(device_views) + i * sizeof(views[i]);
    CudaFailurePolicy failure_policy{slot.test_failure_boundary, 0};
    if (failure_policy.requested_boundary == 1) {
        failure_policy.failed_boundary = 1;
        slot.test_failure_boundary = 0;
        const AuditBoundary failed{FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER, 0, 0};
        publish_boundary_failure(slot, 1, 1, &failed, 1, 0, 0, 0,
                                 descriptor->descriptor_digest);
        for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
        (void)cudaFree(device_views); (void)cudaFree(device_descriptor);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    uint64_t submitted_fixed_bytes = 0;
    uint64_t submitted_fixed_count = 0;
    if (cudaMemcpyAsync(device_views, device_view_records.data(), view_record_bytes,
                        cudaMemcpyHostToDevice, slot.stream) == cudaSuccess) {
        submitted_fixed_bytes += view_record_bytes;
        ++submitted_fixed_count;
    } else {
        append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            submitted_fixed_bytes, submitted_fixed_count, 0, 0, 0,
            descriptor->descriptor_digest);
        for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
        (void)cudaFree(device_views);
        (void)cudaFree(device_descriptor);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaMemcpyAsync(device_descriptor, &device_descriptor_record,
                        sizeof(device_descriptor_record), cudaMemcpyHostToDevice,
                        slot.stream) == cudaSuccess) {
        submitted_fixed_bytes += sizeof(device_descriptor_record);
        ++submitted_fixed_count;
    } else {
        append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            submitted_fixed_bytes, submitted_fixed_count, 0, 0, 0,
            descriptor->descriptor_digest);
        for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
        (void)cudaFree(device_views);
        (void)cudaFree(device_descriptor);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    uint64_t submitted_payload_count = 0;
    uint64_t submitted_payload_bytes = 0;
    for (size_t i = 0; i < views.size(); ++i) {
        if (views[i].byte_length != 0 && cudaMemcpyAsync(
                device_payloads[i], reinterpret_cast<const void *>(static_cast<uintptr_t>(views[i].address)),
                views[i].byte_length, cudaMemcpyHostToDevice, slot.stream) != cudaSuccess) {
            append_charge_telemetry(
                slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
                submitted_fixed_bytes + submitted_payload_bytes,
                submitted_fixed_count + submitted_payload_count, 0, 0, 0,
                descriptor->descriptor_digest);
            for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
            (void)cudaFree(device_views);
            (void)cudaFree(device_descriptor);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        if (views[i].byte_length != 0) {
            ++submitted_payload_count;
            submitted_payload_bytes += views[i].byte_length;
        }
    }
    if (failure_policy.requested_boundary == 2) {
        failure_policy.failed_boundary = 2;
        slot.test_failure_boundary = 0;
        const std::array<AuditBoundary, 2> failed{{
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
             sizeof(*descriptor) + view_record_bytes + payload_bytes,
             2 + submitted_payload_count},
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 0},
        }};
        publish_boundary_failure(slot, 1, 2, failed.data(), failed.size(),
                                 0, 0, 0, descriptor->descriptor_digest);
        for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
        (void)cudaFree(device_views); (void)cudaFree(device_descriptor);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaStreamSynchronize(slot.stream) != cudaSuccess) {
        append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
            sizeof(*descriptor) + view_record_bytes + payload_bytes,
            2 + std::count_if(views.begin(), views.end(),
                              [](const auto &view) { return view.byte_length != 0; }),
            0, 0, 0, descriptor->descriptor_digest);
        append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 1, 0, 0, 0, descriptor->descriptor_digest);
        for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
        (void)cudaFree(device_views);
        (void)cudaFree(device_descriptor);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    uint64_t nonempty_payloads = 0;
    for (const auto &view_record : views)
        nonempty_payloads += view_record.byte_length != 0 ? 1 : 0;
    const std::array<AuditBoundary, 4> static_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
         sizeof(*descriptor) + view_record_bytes + payload_bytes,
         2 + nonempty_payloads},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
         sizeof(uint32_t), 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 1},
    }};
    fullmag::fdm::gpu::transport::charge::SolveInput validation_input{};
    validation_input.grid = {descriptor->grid[0], descriptor->grid[1], descriptor->grid[2]};
    validation_input.cell_size = {
        descriptor->cell_size[0], descriptor->cell_size[1], descriptor->cell_size[2]};
    validation_input.payloads = device_payloads;
    validation_input.views = device_view_records;
    validation_input.stream = slot.stream;
    validation_input.failure_policy = &failure_policy;
    if ((descriptor->required_features &
         FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) != 0) {
        status = fullmag::fdm::gpu::transport::charge::validate_static_payload_device(
            validation_input, 3, 4);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
            if (failure_policy.failed_boundary != 0) {
                slot.test_failure_boundary = 0;
                publish_boundary_failure(slot, 1, failure_policy.failed_boundary,
                    static_boundaries.data(), static_boundaries.size(), 0, 0, 0,
                    descriptor->descriptor_digest);
            }
            for (void *payload : device_payloads) if (payload) (void)cudaFree(payload);
            (void)cudaFree(device_views);
            (void)cudaFree(device_descriptor);
            return status;
        }
    }
    slot.descriptor_revision = descriptor->descriptor_revision;
    slot.source_revision = descriptor->source_revision;
    std::memcpy(slot.descriptor_digest.data(), descriptor->descriptor_digest,
                slot.descriptor_digest.size());
    slot.static_uploaded = true;
    slot.enabled_features = descriptor->required_features;
    slot.static_descriptor_device = device_descriptor;
    slot.static_views_device = device_views;
    slot.static_payload_device = device_payloads;
    slot.static_views_host = views;
    slot.charge_adjacent_cells = std::move(charge_adjacent_cells);
    slot.charge_axes = std::move(charge_axes);
    slot.charge_sides = std::move(charge_sides);
    slot.charge_areas = std::move(charge_areas);
    slot.charge_values = std::move(charge_values);
    slot.charge_source_ids = std::move(charge_source_ids);
    slot.grid = {descriptor->grid[0], descriptor->grid[1], descriptor->grid[2]};
    slot.cell_size = {descriptor->cell_size[0], descriptor->cell_size[1], descriptor->cell_size[2]};
    for (size_t i = 0; i < views.size(); ++i) slot.static_payload_bytes[i] = views[i].byte_length;
    append_charge_telemetry(
        slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
        sizeof(*descriptor) + view_record_bytes + payload_bytes,
        2 + nonempty_payloads, 0, 0, 0, slot.descriptor_digest.data());
    append_charge_telemetry(
        slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
        0, 1, 0, 0, 0, slot.descriptor_digest.data());
    append_charge_telemetry(
        slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
        sizeof(uint32_t), 1, 0, 0, 0, slot.descriptor_digest.data());
    append_charge_telemetry(
        slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
        0, 1, 0, 0, 0, slot.descriptor_digest.data());
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_transport_static_descriptor_v1 *descriptor) {
    return abi_allocation_guard(
        [&] { return static_descriptor_upload_impl(context, descriptor); });
}

extern "C" uint32_t fullmag_fdm_gpu_transport_solve_charge_v1(
    const fullmag_fdm_gpu_charge_solve_request_v1 *request,
    fullmag_fdm_gpu_charge_solve_result_v1 *result) {
    if (request == nullptr || result == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    uint32_t status = validate_prefix(
        request->abi_version, request->struct_version, request->struct_size,
        sizeof(*request), request->reserved_flags, request->required_features,
        UINT64_C(0x07), request->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    status = validate_prefix(
        result->abi_version, result->struct_version, result->struct_size,
        sizeof(*result), result->reserved_flags, result->required_features,
        UINT64_C(0x07), result->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if (request->solver_policy != FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1 ||
        request->gauge_policy == FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_INVALID ||
        request->gauge_policy > FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT ||
        !std::isfinite(request->relative_tolerance) || request->relative_tolerance <= 0.0 ||
        request->relative_tolerance >= 1.0 || request->max_iterations == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (request->gauge_policy !=
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;

    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto &context = request->context_handle;
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active || !slot.static_uploaded)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if ((slot.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (request->source_revision != slot.source_revision ||
        request->static_revision != slot.descriptor_revision)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (slot.accepted_sequence == UINT64_MAX ||
        slot.provisional_generation >= UINT64_MAX - 1 ||
        !reserve_telemetry_sequences(slot, 7))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    if (slot.grid[0] * slot.grid[1] * slot.grid[2] > UINT32_MAX)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    if (cudaSetDevice(slot.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    fullmag::fdm::gpu::transport::charge::SolveInput device_input{};
    device_input.grid = slot.grid;
    device_input.cell_size = slot.cell_size;
    device_input.payloads = slot.static_payload_device;
    device_input.views = slot.static_views_host;
    device_input.stream = slot.stream;
    device_input.allocator_limit = slot.allocator_limit;
    device_input.static_owned_bytes = sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1) +
        6 * sizeof(fullmag_fdm_gpu_transport_buffer_view_v1);
    for (uint64_t bytes : slot.static_payload_bytes)
        device_input.static_owned_bytes += bytes;
    device_input.workspace_limit = slot.workspace_limit;
    device_input.relative_tolerance = request->relative_tolerance;
    device_input.max_iterations = request->max_iterations;
    device_input.hierarchy_cache = &slot.hierarchy_cache;
    CudaFailurePolicy failure_policy{slot.test_failure_boundary, 0};
    device_input.failure_policy = &failure_policy;
    fullmag::fdm::gpu::transport::charge::SolveOutput device_output{};
    status = fullmag::fdm::gpu::transport::charge::solve_device(device_input, &device_output);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        if (failure_policy.failed_boundary != 0) {
            slot.test_failure_boundary = 0;
            const uint64_t failed_state_bytes =
                slot.grid[0] * slot.grid[1] * slot.grid[2] *
                (sizeof(uint8_t) + sizeof(double));
            const std::array<AuditBoundary, 5> boundaries{{
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL,
                 sizeof(uint32_t), 1},
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL, 0, 1},
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL,
                 failed_state_bytes, 2},
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL, 128, 1},
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL, 0, 1},
            }};
            publish_boundary_failure(slot, 10, failure_policy.failed_boundary,
                boundaries.data(), boundaries.size(), request->attempt_id,
                request->stage_id, device_output.iterations,
                slot.descriptor_digest.data());
        }
        if (status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR &&
            failure_policy.failed_boundary == 0) {
            append_charge_telemetry(
                slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
                device_output.transfer_bytes, device_output.transfer_bytes != 0 ? 1 : 0,
                request->attempt_id, request->stage_id, device_output.iterations,
                slot.descriptor_digest.data());
        }
        result->iterations = device_output.iterations;
        result->reason = device_output.reason;
        result->algebraic_residual = device_output.algebraic_residual;
        return status;
    }
    const uint64_t pending_state_copy_bytes =
        device_output.buffers.cells * (sizeof(uint8_t) + sizeof(double));
    const uint64_t pending_metrics_bytes =
        device_output.transfer_bytes >= sizeof(uint32_t)
            ? device_output.transfer_bytes - sizeof(uint32_t)
            : 0;
    const uint32_t provisional_transfer_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    const uint32_t provisional_sync_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    const std::array<AuditBoundary, 7> solve_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         provisional_transfer_flags, sizeof(uint32_t), 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         provisional_sync_flags, 0, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
         provisional_transfer_flags, pending_state_copy_bytes, 2},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         provisional_transfer_flags, pending_metrics_bytes, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         provisional_sync_flags, 0, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         provisional_transfer_flags, 32, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         provisional_sync_flags, 0, 1},
    }};
    const uint64_t candidate_sequence = slot.accepted_sequence + 1;
    std::array<uint8_t, 16> candidate_lineage{};
    for (size_t byte = 0; byte < candidate_lineage.size(); ++byte)
        candidate_lineage[byte] = static_cast<uint8_t>(
            slot.descriptor_digest[byte] ^ ((candidate_sequence + byte) & 0xff));
    const uint64_t saved_iterations = slot.iterations;
    const double saved_component_balance = slot.component_balance;
    const double saved_physical_residual = slot.physical_residual;
    slot.iterations = device_output.iterations;
    slot.component_balance = device_output.component_balance;
    slot.physical_residual = device_output.physical_residual;
    std::array<uint8_t, 32> candidate_digest{};
    status = accepted_charge_content_digest(
        slot, device_output.buffers, candidate_sequence, candidate_lineage,
        &candidate_digest, &failure_policy, 15, 16);
    slot.iterations = saved_iterations;
    slot.component_balance = saved_component_balance;
    slot.physical_residual = saved_physical_residual;
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        if (failure_policy.failed_boundary != 0) {
            slot.test_failure_boundary = 0;
            publish_boundary_failure(slot, 10, failure_policy.failed_boundary,
                solve_boundaries.data(), solve_boundaries.size(), request->attempt_id,
                request->stage_id, device_output.iterations,
                slot.descriptor_digest.data());
        }
        release_charge_buffers(device_output.buffers);
        return status;
    }
    release_charge_buffers(slot.provisional);
    slot.provisional = device_output.buffers;
    ++slot.provisional_generation;
    slot.iterations = device_output.iterations;
    slot.algebraic_residual = device_output.algebraic_residual;
    slot.physical_residual = device_output.physical_residual;
    slot.component_balance = device_output.component_balance;
    slot.electrode_balance = device_output.electrode_balance;
    slot.candidate_digest = candidate_digest;
    result->provisional_generation = slot.provisional_generation;
    result->iterations = device_output.iterations;
    result->reason = device_output.reason;
    result->algebraic_residual = device_output.algebraic_residual;
    result->physical_residual = device_output.physical_residual;
    result->component_balance = device_output.component_balance;
    result->electrode_balance = device_output.electrode_balance;
    const uint64_t state_copy_bytes = pending_state_copy_bytes;
    result->transfer_count = 5;
    result->transfer_bytes = device_output.transfer_bytes + state_copy_bytes + 32;
    result->peak_bytes = device_output.peak_bytes;
    std::memcpy(result->candidate_digest, slot.candidate_digest.data(),
                slot.candidate_digest.size());
    slot.hierarchy_build_count += device_output.hierarchy_build_count;
    slot.hierarchy_cache_hit_count += device_output.cache_hit_count;
    slot.amg_apply_count += device_output.amg_apply_count;
    slot.fine_unknown_count = device_output.fine_unknown_count;
    slot.coarse_unknown_count = device_output.coarse_unknown_count;
    slot.hierarchy_levels = device_output.hierarchy_levels;
    std::memcpy(slot.hierarchy_digest.data(), device_output.hierarchy_digest, 32);
    const uint32_t provisional_transfer =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    const uint32_t provisional_sync =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    auto append_solve = [&](uint32_t direction, uint32_t reason, uint32_t flags,
                            uint64_t bytes, uint64_t count) {
        append_charge_telemetry(
            slot, direction, reason, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            flags, bytes, count, request->attempt_id, request->stage_id,
            device_output.iterations, slot.candidate_digest.data());
    };
    const uint64_t metrics_bytes = pending_metrics_bytes;
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                 provisional_transfer, sizeof(uint32_t), 1);
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                 provisional_sync, 0, 1);
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
                 provisional_transfer, state_copy_bytes, 2);
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                 provisional_transfer, metrics_bytes, 1);
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                 provisional_sync, 0, 1);
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                 provisional_transfer, 32, 1);
    append_solve(FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                 provisional_sync, 0, 1);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t provisional_generation,
    fullmag_fdm_gpu_charge_snapshot_info_v1 *snapshot_info) {
    if (snapshot_info == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const uint32_t prefix = validate_prefix(
        snapshot_info->abi_version, snapshot_info->struct_version, snapshot_info->struct_size,
        sizeof(*snapshot_info), snapshot_info->reserved_flags, snapshot_info->required_features,
        UINT64_C(0x27), snapshot_info->reserved0);
    if (prefix != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return prefix;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &parent = slots[context.slot];
    if (!same(context, context.slot, parent.generation) || !parent.active ||
        parent.provisional.potential == nullptr ||
        provisional_generation != parent.provisional_generation)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (parent.accepted_sequence == UINT64_MAX)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint64_t accepted_sequence = parent.accepted_sequence + 1;
    std::array<uint8_t, 16> lineage{};
    for (size_t byte = 0; byte < lineage.size(); ++byte)
        lineage[byte] = static_cast<uint8_t>(
            parent.descriptor_digest[byte] ^ ((accepted_sequence + byte) & 0xff));
    const std::array<uint8_t, 32> content_digest = parent.candidate_digest;
    for (size_t i = 0; i < slots.size(); ++i) {
        Slot &snapshot = slots[i];
        if (snapshot.active || snapshot.generation == UINT64_MAX) continue;
        ++snapshot.generation;
        snapshot.active = true;
        snapshot.tombstone = false;
        snapshot.type_tag = kSnapshotTag;
        snapshot.parent_slot = context.slot;
        snapshot.parent_generation = context.generation;
        snapshot.accepted = parent.provisional;
        parent.provisional = {};
        snapshot.source_revision = parent.source_revision;
        snapshot.descriptor_revision = parent.descriptor_revision;
        snapshot.candidate_digest = content_digest;
        snapshot.iterations = parent.iterations;
        snapshot.algebraic_residual = parent.algebraic_residual;
        snapshot.physical_residual = parent.physical_residual;
        snapshot.component_balance = parent.component_balance;
        snapshot.electrode_balance = parent.electrode_balance;
        parent.accepted_sequence = accepted_sequence;
        snapshot.accepted_sequence = accepted_sequence;
        ++parent.live_snapshots;
        snapshot_info->snapshot_handle = {kCookie, i, snapshot.generation, kSnapshotTag};
        snapshot_info->context_handle = context;
        snapshot.snapshot_lineage = lineage;
        std::memcpy(snapshot_info->snapshot_lineage_id, snapshot.snapshot_lineage.data(), 16);
        snapshot_info->accepted_sequence = parent.accepted_sequence;
        snapshot_info->local_generation = provisional_generation;
        snapshot_info->source_revision = parent.source_revision;
        snapshot_info->operator_revision = parent.descriptor_revision;
        std::memcpy(snapshot_info->snapshot_content_digest, content_digest.data(), 32);
        for (size_t byte = 0; byte < 32; ++byte)
            snapshot_info->convergence_digest[byte] = static_cast<uint8_t>(
                content_digest[31 - byte] ^ ((parent.iterations + byte) & 0xff));
        snapshot_info->device_bytes = snapshot.accepted.cells +
            (2 * snapshot.accepted.cells + snapshot.accepted.jx_count +
             snapshot.accepted.jy_count + snapshot.accepted.jz_count) * sizeof(double);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_query_telemetry_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint64_t cursor,
    fullmag_fdm_gpu_transport_telemetry_v1 *records, uint64_t record_capacity,
    uint64_t *record_count) {
    if (record_count == nullptr || (record_capacity != 0 && records == nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    uint64_t published = 0;
    for (uint64_t i = 0; i < slot.telemetry_count && published < record_capacity; ++i) {
        if (slot.telemetry[i].audit_sequence <= cursor) continue;
        records[published++] = slot.telemetry[i];
    }
    *record_count = published;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_readback_artifact_v1(
    const fullmag_fdm_gpu_transport_artifact_request_v1 *request) {
    if (request == nullptr) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const uint32_t prefix = validate_prefix(
        request->abi_version, request->struct_version, request->struct_size,
        sizeof(*request), request->reserved_flags, request->required_features,
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK,
        request->reserved0);
    if (prefix != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return prefix;
    if (request->required_features !=
        (FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
         FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_INVALID ||
        request->field_id > FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TRANSPORT_OBSERVATIONS)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V &&
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
    if (request->cadence == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_FORBIDDEN ||
        request->cadence > FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST ||
        request->destination_view_ptr == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const uint32_t feature_status = require_charge_feature(request->context_handle);
    if (feature_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return feature_status;
    const auto *destination = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        static_cast<uintptr_t>(request->destination_view_ptr));
    const uint32_t destination_prefix = validate_prefix(
        destination->abi_version, destination->struct_version, destination->struct_size,
        sizeof(*destination), destination->reserved_flags, destination->required_features,
        0, destination->reserved0);
    if (destination_prefix != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return destination_prefix;
    if (destination->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY ||
        destination->element_type != FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64 ||
        destination->byte_stride != sizeof(double) || destination->address == 0 ||
        destination->element_count != request->range_count ||
        request->expected_bytes != request->range_count * sizeof(double) ||
        destination->byte_length != request->expected_bytes)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (request->context_handle.registry_cookie != kCookie ||
        request->context_handle.type_tag != kContextTag ||
        request->context_handle.slot >= slots.size() ||
        request->snapshot_handle.registry_cookie != kCookie ||
        request->snapshot_handle.type_tag != kSnapshotTag ||
        request->snapshot_handle.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    Slot &parent = slots[request->context_handle.slot];
    Slot &snapshot = slots[request->snapshot_handle.slot];
    if (!same(request->context_handle, request->context_handle.slot, parent.generation) ||
        !parent.active || !snapshot.active || snapshot.generation != request->snapshot_handle.generation ||
        snapshot.parent_slot != request->context_handle.slot ||
        snapshot.parent_generation != request->context_handle.generation ||
        snapshot.accepted_sequence != request->accepted_sequence)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    if ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (!reserve_telemetry_sequences(parent, 2))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint64_t total = request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V
        ? snapshot.accepted.cells
        : snapshot.accepted.jx_count + snapshot.accepted.jy_count + snapshot.accepted.jz_count;
    if (request->range_begin > total || request->range_count > total - request->range_begin)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (cudaSetDevice(parent.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    uint8_t *host = reinterpret_cast<uint8_t *>(static_cast<uintptr_t>(destination->address));
    uint64_t begin = request->range_begin;
    uint64_t remaining = request->range_count;
    uint64_t transfer_segments = 0;
    uint64_t transferred_bytes = 0;
    const uint32_t cadence_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    const std::array<AuditBoundary, 2> artifact_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | cadence_flags,
         request->expected_bytes, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | cadence_flags,
         0, 1},
    }};
    if (parent.test_failure_boundary == 20) {
        parent.test_failure_boundary = 0;
        publish_boundary_failure(parent, 20, 20, artifact_boundaries.data(),
            artifact_boundaries.size(), 0, 0, 0,
            snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    auto copy_range = [&](const double *source, uint64_t source_count) -> bool {
        if (remaining == 0) return true;
        if (begin >= source_count) {
            begin -= source_count;
            return true;
        }
        const uint64_t count = std::min(remaining, source_count - begin);
        const bool ok = cudaMemcpyAsync(host, source + begin, count * sizeof(double),
                                        cudaMemcpyDeviceToHost, parent.stream) == cudaSuccess;
        if (ok && count != 0) {
            ++transfer_segments;
            transferred_bytes += count * sizeof(double);
        }
        host += count * sizeof(double);
        remaining -= count;
        begin = 0;
        return ok;
    };
    bool copied = request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V
        ? copy_range(snapshot.accepted.potential, snapshot.accepted.cells)
        : copy_range(snapshot.accepted.jx, snapshot.accepted.jx_count) &&
          copy_range(snapshot.accepted.jy, snapshot.accepted.jy_count) &&
          copy_range(snapshot.accepted.jz, snapshot.accepted.jz_count);
    if (!copied || remaining != 0) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | cadence_flags |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            transferred_bytes, transfer_segments, 0, 0, 0,
            snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (parent.test_failure_boundary == 21) {
        parent.test_failure_boundary = 0;
        auto boundaries = artifact_boundaries;
        boundaries[0].bytes = transferred_bytes;
        boundaries[0].count = transfer_segments;
        publish_boundary_failure(parent, 20, 21, boundaries.data(),
            boundaries.size(), 0, 0, 0, snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaStreamSynchronize(parent.stream) != cudaSuccess) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | cadence_flags,
            transferred_bytes, transfer_segments, 0, 0, 0,
            snapshot.candidate_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | cadence_flags |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 1, 0, 0, 0, snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | cadence_flags,
        request->expected_bytes, transfer_segments, 0, 0, 0,
        snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | cadence_flags,
        0, 1, 0, 0, 0, snapshot.candidate_digest.data());
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t checkpoint_query_size_impl(
    const fullmag_fdm_gpu_transport_checkpoint_size_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 *result) {
    if (request == nullptr || result == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    uint32_t status = validate_prefix(request->abi_version, request->struct_version,
        request->struct_size, sizeof(*request), request->reserved_flags,
        request->required_features, UINT64_C(0x3f), request->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    status = validate_prefix(result->abi_version, result->struct_version,
        result->struct_size, sizeof(*result), result->reserved_flags,
        result->required_features, UINT64_C(0x3f), result->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if (request->schema_version != FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if ((request->inclusion_mask & ~FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1) != 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (request->inclusion_mask != UINT32_C(0x33))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (request->context_handle.slot >= slots.size() || request->snapshot_handle.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    Slot &parent = slots[request->context_handle.slot];
    Slot &snapshot = slots[request->snapshot_handle.slot];
    if (!same(request->context_handle, request->context_handle.slot, parent.generation) ||
        !parent.active || !same_snapshot(request->snapshot_handle,
            request->snapshot_handle.slot, snapshot.generation) ||
        !snapshot.active || snapshot.type_tag != kSnapshotTag ||
        snapshot.parent_slot != request->context_handle.slot ||
        snapshot.parent_generation != request->context_handle.generation ||
        snapshot.accepted_sequence != request->accepted_sequence)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    if ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (std::memcmp(request->static_descriptor_digest, parent.descriptor_digest.data(), 32) != 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    fullmag::fdm::gpu::transport::charge::CheckpointData data{};
    data.device_uuid = parent.device_uuid; data.build_digest = parent.build_identity;
    data.static_digest = parent.descriptor_digest; data.lineage = snapshot.snapshot_lineage;
    data.grid = parent.grid; data.cell_size = parent.cell_size;
    data.compute_major = parent.compute_major; data.compute_minor = parent.compute_minor;
    data.cuda_driver = parent.cuda_driver; data.cuda_runtime = parent.cuda_runtime;
    data.descriptor_revision = parent.descriptor_revision;
    data.source_revision = parent.source_revision; data.operator_revision = parent.descriptor_revision;
    data.accepted_sequence = snapshot.accepted_sequence; data.iterations = snapshot.iterations;
    data.convergence_reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
    data.component_balance = snapshot.component_balance; data.physical_residual = snapshot.physical_residual;
    data.charge_adjacent_cells = parent.charge_adjacent_cells;
    data.charge_axes = parent.charge_axes;
    data.charge_sides = parent.charge_sides;
    data.charge_areas = parent.charge_areas;
    data.charge_values = parent.charge_values;
    data.charge_source_ids = parent.charge_source_ids;
    data.active.resize(snapshot.accepted.cells); data.conductivity.resize(snapshot.accepted.cells);
    data.potential.resize(snapshot.accepted.cells); data.jx.resize(snapshot.accepted.jx_count);
    data.jy.resize(snapshot.accepted.jy_count); data.jz.resize(snapshot.accepted.jz_count);
    std::vector<uint8_t> payload;
    if (!fullmag::fdm::gpu::transport::charge::build_checkpoint(&data, &payload))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    result->required_bytes = payload.size(); result->section_count = 11; result->alignment = 64;
    result->schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    result->inclusion_mask = UINT32_C(0x33);
    std::memcpy(result->snapshot_content_digest, snapshot.candidate_digest.data(), 32);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
    const fullmag_fdm_gpu_transport_checkpoint_size_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 *result) {
    return abi_allocation_guard(
        [&] { return checkpoint_query_size_impl(request, result); });
}

uint32_t checkpoint_export_impl(
    const fullmag_fdm_gpu_transport_checkpoint_export_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 *result) {
    if (request == nullptr || result == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    uint32_t status = validate_prefix(request->abi_version, request->struct_version,
        request->struct_size, sizeof(*request), request->reserved_flags,
        request->required_features, UINT64_C(0x3f), request->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    status = validate_prefix(result->abi_version, result->struct_version,
        result->struct_size, sizeof(*result), result->reserved_flags,
        result->required_features, UINT64_C(0x3f), result->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if ((request->inclusion_mask & ~FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1) != 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (request->reserved1 != 0 || request->inclusion_mask != UINT32_C(0x33) ||
        request->destination_view_ptr == 0 || request->exact_capacity != request->expected_size)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    status = require_charge_feature(request->context_handle);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    const auto *destination = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        static_cast<uintptr_t>(request->destination_view_ptr));
    status = validate_prefix(destination->abi_version, destination->struct_version,
        destination->struct_size, sizeof(*destination), destination->reserved_flags,
        destination->required_features, 0, destination->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if (destination->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY ||
        destination->element_type != FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES ||
        destination->byte_stride != 1 || destination->address == 0 ||
        destination->byte_length != request->exact_capacity)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (request->context_handle.slot >= slots.size() || request->snapshot_handle.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    Slot &parent = slots[request->context_handle.slot];
    Slot &snapshot = slots[request->snapshot_handle.slot];
    if (!same(request->context_handle, request->context_handle.slot, parent.generation) ||
        !parent.active || !same_snapshot(request->snapshot_handle,
            request->snapshot_handle.slot, snapshot.generation) ||
        !snapshot.active || snapshot.type_tag != kSnapshotTag ||
        snapshot.parent_slot != request->context_handle.slot ||
        snapshot.parent_generation != request->context_handle.generation ||
        snapshot.accepted_sequence != request->accepted_sequence)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    if ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (!reserve_telemetry_sequences(parent, 4))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint32_t checkpoint_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    CudaFailurePolicy failure_policy{parent.test_failure_boundary, 0};
    std::array<uint8_t, 32> verified_digest{};
    status = accepted_charge_content_digest(
        parent, snapshot.accepted, snapshot.accepted_sequence,
        snapshot.snapshot_lineage, &verified_digest, &failure_policy, 30, 31);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        if (failure_policy.failed_boundary != 0) {
            parent.test_failure_boundary = 0;
            const std::array<AuditBoundary, 2> boundaries{{
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags, 32, 1},
                {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                 FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | checkpoint_flags, 0, 1},
            }};
            publish_boundary_failure(parent, 30, failure_policy.failed_boundary,
                boundaries.data(), boundaries.size(), 0, 0, snapshot.iterations,
                snapshot.candidate_digest.data());
        }
        if (status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR &&
            failure_policy.failed_boundary == 0)
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
                32, 1, 0, 0, snapshot.iterations,
                snapshot.candidate_digest.data());
        return status;
    }
    if (verified_digest != snapshot.candidate_digest)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    fullmag::fdm::gpu::transport::charge::CheckpointData data{};
    data.device_uuid = parent.device_uuid; data.build_digest = parent.build_identity;
    data.static_digest = parent.descriptor_digest; data.lineage = snapshot.snapshot_lineage;
    data.grid = parent.grid; data.cell_size = parent.cell_size;
    data.compute_major = parent.compute_major; data.compute_minor = parent.compute_minor;
    data.cuda_driver = parent.cuda_driver; data.cuda_runtime = parent.cuda_runtime;
    data.descriptor_revision = parent.descriptor_revision;
    data.source_revision = parent.source_revision; data.operator_revision = parent.descriptor_revision;
    data.accepted_sequence = snapshot.accepted_sequence; data.iterations = snapshot.iterations;
    data.convergence_reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
    data.component_balance = snapshot.component_balance; data.physical_residual = snapshot.physical_residual;
    data.snapshot_digest = snapshot.candidate_digest;
    data.charge_adjacent_cells = parent.charge_adjacent_cells;
    data.charge_axes = parent.charge_axes;
    data.charge_sides = parent.charge_sides;
    data.charge_areas = parent.charge_areas;
    data.charge_values = parent.charge_values;
    data.charge_source_ids = parent.charge_source_ids;
    data.active.resize(snapshot.accepted.cells); data.conductivity.resize(snapshot.accepted.cells);
    data.potential.resize(snapshot.accepted.cells); data.jx.resize(snapshot.accepted.jx_count);
    data.jy.resize(snapshot.accepted.jy_count); data.jz.resize(snapshot.accepted.jz_count);
    const uint64_t export_bytes = data.active.size() +
        (data.conductivity.size() + data.potential.size() + data.jx.size() +
         data.jy.size() + data.jz.size()) * sizeof(double);
    uint64_t copied_export_bytes = 0;
    uint64_t copied_export_count = 0;
    if (parent.test_failure_boundary == 32) {
        parent.test_failure_boundary = 0;
        const std::array<AuditBoundary, 3> boundaries{{
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags, 32, 1},
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | checkpoint_flags, 0, 1},
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags, export_bytes, 6},
        }};
        publish_boundary_failure(parent, 30, 32, boundaries.data(), boundaries.size(),
            0, 0, snapshot.iterations, snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    auto export_copy = [&](void *destination, const void *source, uint64_t bytes) {
        if (cudaMemcpyAsync(destination, source, bytes, cudaMemcpyDeviceToHost,
                            parent.stream) != cudaSuccess)
            return false;
        copied_export_bytes += bytes;
        ++copied_export_count;
        return true;
    };
    if (cudaSetDevice(parent.device) != cudaSuccess ||
        !export_copy(data.active.data(), snapshot.accepted.active, data.active.size()) ||
        !export_copy(data.conductivity.data(), snapshot.accepted.conductivity,
                     data.conductivity.size() * sizeof(double)) ||
        !export_copy(data.potential.data(), snapshot.accepted.potential,
                     data.potential.size() * sizeof(double)) ||
        !export_copy(data.jx.data(), snapshot.accepted.jx,
                     data.jx.size() * sizeof(double)) ||
        !export_copy(data.jy.data(), snapshot.accepted.jy,
                     data.jy.size() * sizeof(double)) ||
        !export_copy(data.jz.data(), snapshot.accepted.jz,
                     data.jz.size() * sizeof(double))) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            copied_export_bytes, copied_export_count, 0, 0, snapshot.iterations,
            snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (parent.test_failure_boundary == 33) {
        parent.test_failure_boundary = 0;
        const std::array<AuditBoundary, 4> boundaries{{
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags, 32, 1},
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | checkpoint_flags, 0, 1},
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags,
             copied_export_bytes, copied_export_count},
            {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | checkpoint_flags, 0, 1},
        }};
        publish_boundary_failure(parent, 30, 33, boundaries.data(), boundaries.size(),
            0, 0, snapshot.iterations, snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaStreamSynchronize(parent.stream) != cudaSuccess) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED,
            copied_export_bytes, copied_export_count, 0, 0, snapshot.iterations,
            snapshot.candidate_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 1, 0, 0, snapshot.iterations,
            snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    std::vector<uint8_t> payload;
    if (!fullmag::fdm::gpu::transport::charge::build_checkpoint(&data, &payload) ||
        payload.size() != request->exact_capacity)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    std::memcpy(reinterpret_cast<void *>(static_cast<uintptr_t>(destination->address)),
                payload.data(), payload.size());
    result->committed_bytes = payload.size();
    fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
        payload.data(), payload.size(), result->payload_sha256);
    std::memcpy(result->snapshot_digest, data.snapshot_digest.data(), 32);
    std::memset(result->spin_digest, 0, 32);
    fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
        data.potential.data(), data.potential.size() * sizeof(double), result->warm_start_digest);
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags,
        32, 1, 0, 0, snapshot.iterations, snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | checkpoint_flags,
        0, 1, 0, 0, snapshot.iterations, snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags,
        export_bytes, 6, 0, 0, snapshot.iterations, snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION | checkpoint_flags,
        0, 1, 0, 0, snapshot.iterations, snapshot.candidate_digest.data());
    result->audit_sequence = parent.telemetry_sequence;
    std::memcpy(result->snapshot_lineage_id, data.lineage.data(), 16);
    result->accepted_sequence = data.accepted_sequence;
    std::memcpy(result->operation_audit_digest,
                parent.operation_audit_digest.data(), 32);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_export_v1(
    const fullmag_fdm_gpu_transport_checkpoint_export_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 *result) {
    return abi_allocation_guard(
        [&] { return checkpoint_export_impl(request, result); });
}

uint32_t checkpoint_import_impl(
    const fullmag_fdm_gpu_transport_checkpoint_import_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 *result) {
    if (request == nullptr || result == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    uint32_t status = validate_prefix(request->abi_version, request->struct_version,
        request->struct_size, sizeof(*request), request->reserved_flags,
        request->required_features, UINT64_C(0x3f), request->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    status = validate_prefix(result->abi_version, result->struct_version,
        result->struct_size, sizeof(*result), result->reserved_flags,
        result->required_features, UINT64_C(0x3f), result->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if (request->restore_policy != FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD ||
        request->reserved1 != 0 || request->source_view_ptr == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    status = require_charge_feature(request->context_handle);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    const auto *source = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        static_cast<uintptr_t>(request->source_view_ptr));
    status = validate_prefix(source->abi_version, source->struct_version, source->struct_size,
        sizeof(*source), source->reserved_flags, source->required_features, 0, source->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if (source->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY ||
        source->element_type != FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES ||
        source->byte_stride != 1 || source->address == 0 ||
        source->byte_length != request->expected_bytes)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const auto *payload = reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(source->address));
    std::array<uint8_t, 32> payload_sha{};
    fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
        payload, request->expected_bytes, payload_sha.data());
    if (std::memcmp(payload_sha.data(), request->expected_payload_sha256, 32) != 0) {
        status = append_rejected_import_telemetry(*request);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    fullmag::fdm::gpu::transport::charge::CheckpointData data{};
    if (!fullmag::fdm::gpu::transport::charge::parse_checkpoint(
            payload, request->expected_bytes, &data)) {
        status = append_rejected_import_telemetry(*request);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (request->context_handle.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &parent = slots[request->context_handle.slot];
    if (!same(request->context_handle, request->context_handle.slot, parent.generation) ||
        !parent.active || !parent.static_uploaded || parent.live_snapshots != 0 ||
        parent.provisional.potential != nullptr || parent.provisional_generation != 0 ||
        parent.accepted_sequence != 0 || parent.hierarchy_cache.valid)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (!reserve_telemetry_sequences(parent, 5))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    if (data.device_uuid != parent.device_uuid || data.build_digest != parent.build_identity ||
        data.static_digest != parent.descriptor_digest || data.grid != parent.grid ||
        data.cell_size != parent.cell_size ||
        data.descriptor_revision != parent.descriptor_revision ||
        data.source_revision != parent.source_revision ||
        data.operator_revision != parent.descriptor_revision ||
        data.charge_adjacent_cells != parent.charge_adjacent_cells ||
        data.charge_axes != parent.charge_axes ||
        data.charge_sides != parent.charge_sides ||
        data.charge_areas != parent.charge_areas ||
        data.charge_values != parent.charge_values ||
        data.charge_source_ids != parent.charge_source_ids ||
        std::memcmp(request->device_uuid, parent.device_uuid.data(), 16) != 0 ||
        std::memcmp(request->build_digest, parent.build_identity.data(), 32) != 0 ||
        std::memcmp(request->static_descriptor_digest, parent.descriptor_digest.data(), 32) != 0) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_NONE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 0, 0, 0, 0, nullptr);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    ChargeBuffers restored{};
    restored.cells = data.potential.size(); restored.jx_count = data.jx.size();
    restored.jy_count = data.jy.size(); restored.jz_count = data.jz.size();
    fullmag::fdm::gpu::transport::charge::SolveInput static_input{};
    static_input.grid = parent.grid; static_input.cell_size = parent.cell_size;
    static_input.payloads = parent.static_payload_device; static_input.views = parent.static_views_host;
    static_input.stream = parent.stream;
    CudaFailurePolicy failure_policy{parent.test_failure_boundary, 0};
    static_input.failure_policy = &failure_policy;
    const uint64_t import_bytes =
        (data.potential.size() + data.jx.size() + data.jy.size() + data.jz.size()) *
        sizeof(double);
    const std::array<AuditBoundary, 5> import_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER, import_bytes, 4},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER, 32, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 1},
    }};
    status = fullmag::fdm::gpu::transport::charge::materialize_static_state(
        static_input, &restored, 40);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        if (failure_policy.failed_boundary != 0) {
            parent.test_failure_boundary = 0;
            publish_boundary_failure(parent, 40, failure_policy.failed_boundary,
                import_boundaries.data(), import_boundaries.size(), 0, 0,
                data.iterations, data.snapshot_digest.data());
        }
        if (status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR &&
            failure_policy.failed_boundary == 0)
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
                0, 0, 0, 0, data.iterations, data.snapshot_digest.data());
        return status;
    }
    uint64_t copied_import_bytes = 0;
    uint64_t copied_import_count = 0;
    if (parent.test_failure_boundary == 41) {
        parent.test_failure_boundary = 0;
        publish_boundary_failure(parent, 40, 41, import_boundaries.data(),
            import_boundaries.size(), 0, 0, data.iterations,
            data.snapshot_digest.data());
        release_charge_buffers(restored);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    auto allocate_and_copy = [&](double **destination, const std::vector<double> &values) {
        const uint64_t bytes = values.size() * sizeof(double);
        if (cudaMalloc(reinterpret_cast<void **>(destination), bytes) != cudaSuccess ||
            cudaMemcpyAsync(*destination, values.data(), bytes,
                            cudaMemcpyHostToDevice, parent.stream) != cudaSuccess)
            return false;
        copied_import_bytes += bytes;
        ++copied_import_count;
        return true;
    };
    if (!allocate_and_copy(&restored.potential, data.potential) ||
        !allocate_and_copy(&restored.jx, data.jx) || !allocate_and_copy(&restored.jy, data.jy) ||
        !allocate_and_copy(&restored.jz, data.jz)) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            copied_import_bytes, copied_import_count, 0, 0, data.iterations,
            data.snapshot_digest.data());
        release_charge_buffers(restored);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (parent.test_failure_boundary == 42) {
        parent.test_failure_boundary = 0;
        auto boundaries = import_boundaries;
        boundaries[1].bytes = copied_import_bytes;
        boundaries[1].count = copied_import_count;
        publish_boundary_failure(parent, 40, 42, boundaries.data(),
            boundaries.size(), 0, 0, data.iterations, data.snapshot_digest.data());
        release_charge_buffers(restored);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaStreamSynchronize(parent.stream) != cudaSuccess) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
            copied_import_bytes, copied_import_count, 0, 0, data.iterations,
            data.snapshot_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
        release_charge_buffers(restored);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    std::array<uint8_t, 32> restored_digest{};
    const uint64_t saved_iterations = parent.iterations;
    const double saved_component_balance = parent.component_balance;
    const double saved_physical_residual = parent.physical_residual;
    parent.iterations = data.iterations;
    parent.component_balance = data.component_balance;
    parent.physical_residual = data.physical_residual;
    status = accepted_charge_content_digest(
        parent, restored, data.accepted_sequence, data.lineage, &restored_digest,
        &failure_policy, 43, 44);
    parent.iterations = saved_iterations;
    parent.component_balance = saved_component_balance;
    parent.physical_residual = saved_physical_residual;
    if (parent.test_force_import_digest_mismatch &&
        status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        restored_digest[0] ^= UINT8_C(1);
    if (failure_policy.failed_boundary != 0) {
        parent.test_failure_boundary = 0;
        publish_boundary_failure(parent, 40, failure_policy.failed_boundary,
            import_boundaries.data(), import_boundaries.size(), 0, 0,
            data.iterations, data.snapshot_digest.data());
        release_charge_buffers(restored);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK ||
        restored_digest != data.snapshot_digest) {
        if (status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
                0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
                import_bytes, 4, 0, 0, data.iterations, data.snapshot_digest.data());
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
                0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
                32, 1, 0, 0, data.iterations, data.snapshot_digest.data());
            append_charge_telemetry(
                parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_REJECTED,
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                    FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
                0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
        }
        release_charge_buffers(restored);
        return status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
            ? status : FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    for (size_t i = 0; i < slots.size(); ++i) {
        Slot &snapshot = slots[i];
        if (snapshot.active || snapshot.generation == UINT64_MAX) continue;
        ++snapshot.generation; snapshot.active = true; snapshot.tombstone = false;
        snapshot.type_tag = kSnapshotTag; snapshot.parent_slot = request->context_handle.slot;
        snapshot.parent_generation = request->context_handle.generation; snapshot.accepted = restored;
        snapshot.source_revision = data.source_revision;
        snapshot.descriptor_revision = data.operator_revision;
        snapshot.accepted_sequence = data.accepted_sequence; snapshot.iterations = data.iterations;
        snapshot.component_balance = data.component_balance; snapshot.physical_residual = data.physical_residual;
        snapshot.candidate_digest = data.snapshot_digest; snapshot.snapshot_lineage = data.lineage;
        parent.accepted_sequence = data.accepted_sequence; ++parent.live_snapshots;
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
            0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
            import_bytes, 4, 0, 0, data.iterations, data.snapshot_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
            0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
            32, 1, 0, 0, data.iterations, data.snapshot_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SCIENTIFIC_COMMIT,
            0, 1, 0, 0, data.iterations, data.snapshot_digest.data());
        result->snapshot_handle = {kCookie, i, snapshot.generation, kSnapshotTag};
        std::memcpy(result->snapshot_lineage_id, data.lineage.data(), 16);
        result->accepted_sequence = data.accepted_sequence;
        std::memcpy(result->snapshot_content_digest, data.snapshot_digest.data(), 32);
        std::memset(result->spin_digest, 0, 32);
        fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
            data.potential.data(), data.potential.size() * sizeof(double), result->warm_start_digest);
        result->audit_sequence = parent.telemetry_sequence;
        result->restored_state = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_CHARGE_ACCEPTED;
        std::memcpy(result->operation_audit_digest,
                    parent.operation_audit_digest.data(), 32);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }
    release_charge_buffers(restored);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_force_import_digest_mismatch_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t enabled) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (enabled > 1 || context.registry_cookie != kCookie ||
        context.type_tag != kContextTag || context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.test_force_import_digest_mismatch = enabled != 0;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t provisional_generation, uint64_t telemetry_sequence) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.provisional_generation = provisional_generation;
    slot.telemetry_sequence = telemetry_sequence;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t boundary) {
    const bool legal = boundary == 0 || (boundary >= 1 && boundary <= 4) ||
        (boundary >= 10 && boundary <= 16) ||
        (boundary >= 20 && boundary <= 21) ||
        (boundary >= 30 && boundary <= 33) ||
        (boundary >= 40 && boundary <= 44);
    if (!legal) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.test_failure_boundary = boundary;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *provisional_generation, uint64_t *telemetry_sequence,
    uint64_t *telemetry_count) {
    if (provisional_generation == nullptr || telemetry_sequence == nullptr ||
        telemetry_count == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    *provisional_generation = slot.provisional_generation;
    *telemetry_sequence = slot.telemetry_sequence;
    *telemetry_count = slot.telemetry_count;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_import_v1(
    const fullmag_fdm_gpu_transport_checkpoint_import_request_v1 *request,
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 *result) {
    return abi_allocation_guard(
        [&] { return checkpoint_import_impl(request, result); });
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_static_view_copy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t view_index,
    fullmag_fdm_gpu_transport_buffer_view_v1 *destination) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size() || view_index >= 6 || destination == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        !slot.static_uploaded || slot.static_views_device == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const auto *source = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        slot.static_views_device) + view_index;
    if (cudaSetDevice(slot.device) != cudaSuccess || cudaMemcpy(destination, source,
            sizeof(*destination), cudaMemcpyDeviceToHost) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_static_payload_copy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t payload_index,
    void *destination, uint64_t destination_bytes) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size() || payload_index >= 6 || destination == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active || !slot.static_uploaded)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (destination_bytes != slot.static_payload_bytes[payload_index])
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (cudaSetDevice(slot.device) != cudaSuccess || cudaMemcpy(destination,
            slot.static_payload_device[payload_index], destination_bytes,
            cudaMemcpyDeviceToHost) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_charge_snapshot_destroy_v1(
    fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (snapshot.registry_cookie != kCookie || snapshot.type_tag != kSnapshotTag ||
        snapshot.slot >= slots.size()) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    }
    Slot &slot = slots[snapshot.slot];
    if (slot.generation != snapshot.generation || slot.type_tag != kSnapshotTag) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    }
    if (!slot.active && slot.tombstone) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED;
    }
    if (!slot.active) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    if (slot.parent_slot < slots.size()) {
        Slot &parent = slots[slot.parent_slot];
        if (parent.device >= 0) (void)cudaSetDevice(parent.device);
        if (parent.generation == slot.parent_generation && parent.live_snapshots != 0)
            --parent.live_snapshots;
    }
    release_charge_buffers(slot.accepted);
    slot.active = false;
    slot.tombstone = true;
    slot.parent_slot = UINT64_MAX;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_snapshot_create_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag_fdm_gpu_charge_snapshot_handle_v1 *snapshot) {
    if (snapshot == nullptr) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size()) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &parent = slots[context.slot];
    if (!parent.active || parent.generation != context.generation || parent.type_tag != kContextTag)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    for (size_t i=0;i<slots.size();++i) {
        Slot &slot=slots[i];
        if (slot.active || slot.generation==UINT64_MAX) continue;
        ++slot.generation;
        slot.active=true; slot.tombstone=false; slot.type_tag=kSnapshotTag;
        slot.parent_slot=context.slot; slot.parent_generation=context.generation;
        ++parent.live_snapshots;
        *snapshot={kCookie,i,slot.generation,kSnapshotTag};
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_snapshot_retain_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie!=kCookie || context.type_tag!=kContextTag ||
        context.slot>=slots.size() || snapshot.registry_cookie!=kCookie ||
        snapshot.type_tag!=kSnapshotTag || snapshot.slot>=slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    const Slot &parent=slots[context.slot];
    const Slot &slot=slots[snapshot.slot];
    if (!slot.active || slot.generation!=snapshot.generation || slot.type_tag!=kSnapshotTag)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    if (!parent.active || parent.generation!=context.generation ||
        slot.parent_slot!=context.slot || slot.parent_generation!=context.generation)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_charge_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *hierarchy_build_count, uint64_t *hierarchy_cache_hit_count,
    uint64_t *amg_apply_count, uint64_t *host_fallback_count,
    uint64_t *fine_unknown_count, uint64_t *coarse_unknown_count,
    uint32_t *hierarchy_levels, uint8_t hierarchy_digest[32]) {
    if (hierarchy_build_count == nullptr || hierarchy_cache_hit_count == nullptr ||
        amg_apply_count == nullptr || host_fallback_count == nullptr ||
        fine_unknown_count == nullptr || coarse_unknown_count == nullptr ||
        hierarchy_levels == nullptr || hierarchy_digest == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    *hierarchy_build_count = slot.hierarchy_build_count;
    *hierarchy_cache_hit_count = slot.hierarchy_cache_hit_count;
    *amg_apply_count = slot.amg_apply_count;
    *host_fallback_count = slot.host_fallback_count;
    *fine_unknown_count = slot.fine_unknown_count;
    *coarse_unknown_count = slot.coarse_unknown_count;
    *hierarchy_levels = slot.hierarchy_levels;
    std::memcpy(hierarchy_digest, slot.hierarchy_digest.data(), 32);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_retire_slot_v1(uint64_t slot_index) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (slot_index>=slots.size() || slots[slot_index].active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slots[slot_index].generation=UINT64_MAX;
    slots[slot_index].tombstone=true;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}
