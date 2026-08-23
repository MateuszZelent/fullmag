#include "fullmag/fdm/transport/gpu_abi_v1.h"
#include "context.hpp"
#include "charge/device_solver.hpp"
#include "charge/checkpoint_codec.hpp"
#include "spin/checkpoint_codec.hpp"
#include "spin/device_solver.hpp"

#include <cuda_runtime_api.h>

#include <array>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <thread>
#include <new>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace {
constexpr uint64_t kCookie = UINT64_C(0x464d475055545231);
constexpr uint64_t kContextTag = UINT64_C(0x434f4e5445585431);
constexpr uint64_t kSnapshotTag = UINT64_C(0x534e415053484f31);
constexpr uint64_t kSupportedFeatures =
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2 |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1 |
    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;

using ChargeBuffers = fullmag::fdm::gpu::transport::charge::Buffers;
using ChargeHierarchyCache = fullmag::fdm::gpu::transport::charge::HierarchyCache;
using CudaFailurePolicy = fullmag::fdm::gpu::transport::charge::CudaFailurePolicy;
using SpinBuffers = fullmag::fdm::gpu::transport::spin::Buffers;
using SpinSparseState = fullmag::fdm::gpu::transport::spin::SparseState;

bool finite_host_double(double value) {
    uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    return (bits & UINT64_C(0x7ff0000000000000)) !=
           UINT64_C(0x7ff0000000000000);
}

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
    uint64_t spin_operator_revision = 0;
    uint64_t spin_preconditioner_revision = 0;
    uint64_t enabled_features = 0;
    uint64_t requested_features = 0;
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
    std::vector<uint64_t> interface_source_ids, interface_topology_ids;
    std::vector<uint64_t> interface_authored_to_canonical;
    std::vector<uint32_t> interface_axes;
    std::vector<uint64_t> interface_face_linear, interface_negative_cells,
        interface_positive_cells, interface_from_cells, interface_to_cells;
    std::vector<int32_t> interface_orientations;
    std::array<uint64_t, 3> grid{};
    std::array<double, 3> cell_size{};
    uint64_t allocator_limit = 0;
    uint64_t workspace_limit = 0;
    uint64_t provisional_generation = 0;
    uint64_t accepted_sequence = 0;
    ChargeBuffers provisional{};
    ChargeBuffers accepted{};
    SpinBuffers spin_accepted{};
    SpinBuffers spin_trial{};
    SpinSparseState spin_sparse_state{};
    double *llg_m_stage = nullptr;
    double *llg_torque = nullptr;
    uint64_t llg_cells = 0;
    cudaEvent_t llg_m_ready = nullptr;
    cudaEvent_t llg_torque_ready = nullptr;
    uint64_t llg_stage_evaluation_count = 0;
    uint64_t llg_binding_owner_id = 0;
    uint64_t llg_binding_snapshot_slot = UINT64_MAX;
    uint64_t llg_binding_snapshot_generation = 0;
    bool llg_torque_in_flight = false;
    bool llg_step_transaction_active = false;
    uint64_t llg_step_attempt_id = 0;
    bool llg_step_has_stage_time = false;
    double llg_step_last_stage_time = 0.0;
    uint64_t test_fail_llg_attempt_id = 0;
    uint64_t test_fail_llg_stage_id = 0;
    uint32_t test_llg_completion_fault = 0;
    std::atomic<uint32_t> test_llg_hold_state{0};
    uint64_t spin_trial_hierarchy_build_count = 0;
    uint64_t spin_trial_hierarchy_cache_hit_count = 0;
    uint64_t spin_trial_amg_apply_count = 0;
    uint64_t spin_trial_fine_unknown_count = 0;
    uint64_t spin_trial_coarse_unknown_count = 0;
    uint32_t spin_trial_hierarchy_levels = 0;
    std::array<uint8_t, 32> spin_trial_hierarchy_digest{};
    uint64_t spin_trial_iterations = 0;
    uint64_t spin_trial_work_budget = 0;
    uint32_t spin_trial_convergence_reason = 0;
    double spin_trial_local_balance = 0.0;
    double spin_trial_global_balance = 0.0;
    double spin_trial_interface_balance = 0.0;
    double spin_trial_torque_balance = 0.0;
    std::array<uint8_t, 32> spin_trial_compute_digest{};
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
    uint64_t spin_accepted_commit_count = 0;
    uint64_t spin_failed_rollback_count = 0;
    bool test_last_retry_sparse_state_empty = false;
    bool test_last_retry_trial_metadata_empty = false;
    bool spin_solve_active = false;
    uint64_t spin_solve_token = 0;
    uint64_t spin_hierarchy_build_count = 0;
    uint64_t spin_hierarchy_cache_hit_count = 0;
    uint64_t spin_amg_apply_count = 0;
    uint64_t spin_fine_unknown_count = 0;
    uint64_t spin_coarse_unknown_count = 0;
    uint32_t spin_hierarchy_levels = 0;
    std::array<uint8_t, 32> spin_hierarchy_digest{};
    uint64_t spin_iterations = 0;
    uint64_t spin_work_budget = 0;
    uint32_t spin_convergence_reason = 0;
    double spin_local_balance = 0.0;
    double spin_global_balance = 0.0;
    double spin_interface_balance = 0.0;
    double spin_torque_balance = 0.0;
    std::array<uint8_t, 32> spin_deterministic_compute_digest{};
    fullmag::fdm::gpu::transport::spin::memory::Plan spin_memory_plan{};
    bool test_force_import_digest_mismatch = false;
    uint32_t test_failure_boundary = 0;
};

std::array<Slot, 4> slots{};
std::mutex registry_mutex;
uint64_t next_llg_binding_owner_id = 1;
std::atomic<uint32_t> test_spin_solve_barrier_arrivals{0};
std::atomic<uint32_t> test_spin_solve_barrier_expected{0};

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

void release_spin_buffers(SpinBuffers &buffers) {
    fullmag::fdm::gpu::transport::spin::release(buffers);
}

void release_spin_sparse_state(SpinSparseState &state) {
    fullmag::fdm::gpu::transport::spin::release(state);
}

void release_llg_binding_storage(Slot &slot) {
    if (slot.llg_m_ready != nullptr) (void)cudaEventDestroy(slot.llg_m_ready);
    if (slot.llg_torque_ready != nullptr) (void)cudaEventDestroy(slot.llg_torque_ready);
    if (slot.llg_m_stage != nullptr) (void)cudaFree(slot.llg_m_stage);
    if (slot.llg_torque != nullptr) (void)cudaFree(slot.llg_torque);
    slot.llg_m_ready = nullptr;
    slot.llg_torque_ready = nullptr;
    slot.llg_m_stage = nullptr;
    slot.llg_torque = nullptr;
    slot.llg_cells = 0;
    slot.llg_stage_evaluation_count = 0;
    slot.llg_binding_owner_id = 0;
    slot.llg_binding_snapshot_slot = UINT64_MAX;
    slot.llg_binding_snapshot_generation = 0;
    slot.llg_torque_in_flight = false;
    slot.llg_step_transaction_active = false;
    slot.llg_step_attempt_id = 0;
    slot.llg_step_has_stage_time = false;
    slot.llg_step_last_stage_time = 0.0;
}

void reset_spin_trial_metadata(Slot &slot) {
    slot.spin_trial_hierarchy_build_count = 0;
    slot.spin_trial_hierarchy_cache_hit_count = 0;
    slot.spin_trial_amg_apply_count = 0;
    slot.spin_trial_fine_unknown_count = 0;
    slot.spin_trial_coarse_unknown_count = 0;
    slot.spin_trial_hierarchy_levels = 0;
    slot.spin_trial_hierarchy_digest.fill(0);
    slot.spin_trial_iterations = 0;
    slot.spin_trial_work_budget = 0;
    slot.spin_trial_convergence_reason = 0;
    slot.spin_trial_local_balance = 0.0;
    slot.spin_trial_global_balance = 0.0;
    slot.spin_trial_interface_balance = 0.0;
    slot.spin_trial_torque_balance = 0.0;
    slot.spin_trial_compute_digest.fill(0);
}

bool spin_sparse_state_empty(const SpinSparseState &state) {
    return state.storage.owned_bytes == 0 &&
           state.hierarchy.owned_bytes == 0 &&
           state.hierarchy.level_count == 0 && !state.hierarchy.valid &&
           state.workspace.owned_bytes == 0;
}

bool spin_trial_metadata_empty(const Slot &slot) {
    const auto all_zero = [](const auto &bytes) {
        return std::all_of(bytes.begin(), bytes.end(),
                           [](uint8_t value) { return value == 0; });
    };
    return slot.spin_trial_hierarchy_build_count == 0 &&
           slot.spin_trial_hierarchy_cache_hit_count == 0 &&
           slot.spin_trial_amg_apply_count == 0 &&
           slot.spin_trial_fine_unknown_count == 0 &&
           slot.spin_trial_coarse_unknown_count == 0 &&
           slot.spin_trial_hierarchy_levels == 0 &&
           all_zero(slot.spin_trial_hierarchy_digest) &&
           slot.spin_trial_iterations == 0 &&
           slot.spin_trial_work_budget == 0 &&
           slot.spin_trial_convergence_reason == 0 &&
           slot.spin_trial_local_balance == 0.0 &&
           slot.spin_trial_global_balance == 0.0 &&
           slot.spin_trial_interface_balance == 0.0 &&
           slot.spin_trial_torque_balance == 0.0 &&
           all_zero(slot.spin_trial_compute_digest);
}

uint32_t accepted_charge_content_digest(
    Slot &parent, const ChargeBuffers &buffers, uint64_t accepted_sequence,
    const std::array<uint8_t, 16> &lineage, uint64_t iterations,
    double component_balance, double physical_residual,
    std::array<uint8_t, 32> *digest,
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
    identity.iterations = iterations;
    identity.component_balance = component_balance;
    identity.physical_residual = physical_residual;
    return fullmag::fdm::gpu::transport::charge::content_digest_device(
        buffers, parent.static_payload_device[3],
        parent.static_views_host[3].element_count,
        parent.static_views_host[3].byte_stride,
        parent.static_payload_device[2], parent.static_views_host[2].byte_stride,
        identity, parent.stream, digest->data(), failure_policy,
        copy_boundary, sync_boundary);
}

void populate_checkpoint_interface_identity(
    const Slot &parent, fullmag::fdm::gpu::transport::charge::CheckpointData *data) {
    data->interface_source_ids = parent.interface_source_ids;
    data->interface_topology_ids = parent.interface_topology_ids;
    data->interface_axes = parent.interface_axes;
    data->interface_face_linear = parent.interface_face_linear;
    data->interface_negative_cells = parent.interface_negative_cells;
    data->interface_positive_cells = parent.interface_positive_cells;
    data->interface_from_cells = parent.interface_from_cells;
    data->interface_to_cells = parent.interface_to_cells;
    data->interface_orientations = parent.interface_orientations;
}

void initialize_spin_checkpoint_data(
    const Slot &parent, const Slot &snapshot,
    fullmag::fdm::gpu::transport::spin::SpinCheckpointData *data) {
    const SpinBuffers &buffers = snapshot.spin_accepted;
    data->source_revision = parent.source_revision;
    data->operator_revision = parent.spin_operator_revision;
    data->preconditioner_revision = parent.spin_preconditioner_revision;
    data->convergence_reason = snapshot.spin_convergence_reason;
    data->iterations = snapshot.spin_iterations;
    data->work_budget = snapshot.spin_work_budget;
    data->local_balance = snapshot.spin_local_balance;
    data->global_balance = snapshot.spin_global_balance;
    data->interface_balance = snapshot.spin_interface_balance;
    data->torque_balance = snapshot.spin_torque_balance;
    data->deterministic_compute_digest =
        snapshot.spin_deterministic_compute_digest;
    data->mu_s.resize(3 * buffers.cells);
    data->qx.resize(buffers.qx_values);
    data->qy.resize(buffers.qy_values);
    data->qz.resize(buffers.qz_values);
    for (auto &reaction : data->reactions) reaction.resize(buffers.cells);
    for (auto &torque : data->torque) torque.resize(buffers.cells);
    data->interface_source_ids = parent.interface_source_ids;
    data->interface_topology_ids = parent.interface_topology_ids;
    data->interface_axes = parent.interface_axes;
    data->interface_face_linear = parent.interface_face_linear;
    data->interface_negative_cells = parent.interface_negative_cells;
    data->interface_positive_cells = parent.interface_positive_cells;
    data->interface_from_cells = parent.interface_from_cells;
    data->interface_to_cells = parent.interface_to_cells;
    data->interface_orientations = parent.interface_orientations;
    for (auto &values : data->interface_values)
        values.resize(buffers.interface_observation_count);
    data->restart_position = 0;
    data->basis_count = 0;
    data->warm_iterate.resize(3 * buffers.cells);
    data->warm_basis.clear();
    data->deterministic_reduction_state.assign(
        parent.spin_hierarchy_digest.begin(), parent.spin_hierarchy_digest.end());
}

bool copy_spin_checkpoint_to_host(
    const Slot &parent, const Slot &snapshot,
    fullmag::fdm::gpu::transport::spin::SpinCheckpointData *data,
    uint64_t *copied_bytes, uint64_t *copied_count) {
    const SpinBuffers &buffers = snapshot.spin_accepted;
    auto copy = [&](void *destination, const void *source, uint64_t bytes) {
        if (bytes == 0) return true;
        if (destination == nullptr || source == nullptr ||
            cudaMemcpyAsync(destination, source, bytes, cudaMemcpyDeviceToHost,
                            parent.stream) != cudaSuccess)
            return false;
        *copied_bytes += bytes;
        ++*copied_count;
        return true;
    };
    const uint64_t cell_bytes = buffers.cells * sizeof(double);
    if (!copy(data->mu_s.data(), buffers.mu_x, cell_bytes) ||
        !copy(data->mu_s.data() + buffers.cells, buffers.mu_y, cell_bytes) ||
        !copy(data->mu_s.data() + 2 * buffers.cells, buffers.mu_z, cell_bytes) ||
        !copy(data->qx.data(), buffers.qx, buffers.qx_values * sizeof(double)) ||
        !copy(data->qy.data(), buffers.qy, buffers.qy_values * sizeof(double)) ||
        !copy(data->qz.data(), buffers.qz, buffers.qz_values * sizeof(double)))
        return false;
    const std::array<const double *, 3> reactions{{
        buffers.reaction_sf, buffers.reaction_j, buffers.reaction_phi}};
    const std::array<const double *, 3> torques{{
        buffers.torque_volume, buffers.torque_surface, buffers.torque_total}};
    for (uint32_t lane = 0; lane < 3; ++lane)
        for (uint32_t component = 0; component < 3; ++component) {
            if (!copy(data->reactions[3 * lane + component].data(),
                      reactions[lane] + component * buffers.cells, cell_bytes) ||
                !copy(data->torque[3 * lane + component].data(),
                      torques[lane] + component * buffers.cells, cell_bytes))
                return false;
        }
    std::fill(data->torque[9].begin(), data->torque[9].end(), 0.0);
    if (!data->torque[9].empty()) data->torque[9][0] = snapshot.spin_torque_balance;
    data->warm_iterate = data->mu_s;
    std::vector<fullmag_fdm_gpu_transport_spin_observation_record_v1> observations(
        buffers.interface_observation_count);
    if (!copy(observations.data(), buffers.interface_observations,
              observations.size() * sizeof(observations[0])))
        return false;
    if (cudaStreamSynchronize(parent.stream) != cudaSuccess) return false;
    for (size_t index = 0; index < observations.size(); ++index) {
        const auto &record = observations[index];
        if (record.source_id != data->interface_source_ids[index] ||
            record.topology_id != data->interface_topology_ids[index] ||
            record.axis != data->interface_axes[index] ||
            record.canonical_face_index != data->interface_face_linear[index] ||
            record.negative_cell != data->interface_negative_cells[index] ||
            record.positive_cell != data->interface_positive_cells[index] ||
            record.from_cell != data->interface_from_cells[index] ||
            record.to_cell != data->interface_to_cells[index] ||
            record.orientation != data->interface_orientations[index])
            return false;
        for (uint32_t component = 0; component < 3; ++component) {
            data->interface_values[component][index] = record.lane0_xyz[component];
            data->interface_values[3 + component][index] = record.lane1_xyz[component];
            data->interface_values[6 + component][index] = record.lane2_xyz[component];
            data->interface_values[9 + component][index] = record.lane3_xyz[component];
            data->interface_values[12 + component][index] = record.lane4_xyz[component];
            data->interface_values[15 + component][index] = record.lane5_xyz[component];
        }
    }
    return true;
}

uint32_t materialize_spin_checkpoint_from_host(
    const Slot &parent,
    const fullmag::fdm::gpu::transport::spin::SpinCheckpointData &data,
    SpinBuffers *restored) {
    const uint64_t cells = parent.grid[0] * parent.grid[1] * parent.grid[2];
    const uint64_t qx_values = 3 * (parent.grid[0] + 1) * parent.grid[1] * parent.grid[2];
    const uint64_t qy_values = 3 * parent.grid[0] * (parent.grid[1] + 1) * parent.grid[2];
    const uint64_t qz_values = 3 * parent.grid[0] * parent.grid[1] * (parent.grid[2] + 1);
    if (data.mu_s.size() != 3 * cells || data.qx.size() != qx_values ||
        data.qy.size() != qy_values || data.qz.size() != qz_values ||
        data.interface_source_ids.size() != parent.interface_source_ids.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    for (const auto &values : data.reactions)
        if (values.size() != cells)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    for (const auto &values : data.torque)
        if (values.size() != cells)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;

    restored->cells = cells;
    restored->qx_values = qx_values;
    restored->qy_values = qy_values;
    restored->qz_values = qz_values;
    restored->interface_observation_count = data.interface_source_ids.size();
    restored->observation_count = 2 * cells + restored->interface_observation_count;
    auto allocate_copy = [&](auto **destination, const auto *source,
                             uint64_t count) {
        using Value = std::remove_pointer_t<std::decay_t<decltype(*destination)>>;
        const uint64_t bytes = count * sizeof(Value);
        if (bytes == 0) return true;
        return cudaMalloc(reinterpret_cast<void **>(destination), bytes) == cudaSuccess &&
               cudaMemcpyAsync(*destination, source, bytes, cudaMemcpyHostToDevice,
                               parent.stream) == cudaSuccess;
    };
    std::vector<double> reaction_sf(3 * cells), reaction_j(3 * cells),
        reaction_phi(3 * cells), torque_volume(3 * cells),
        torque_surface(3 * cells), torque_total(3 * cells);
    for (uint32_t component = 0; component < 3; ++component) {
        std::copy(data.reactions[component].begin(), data.reactions[component].end(),
                  reaction_sf.begin() + component * cells);
        std::copy(data.reactions[3 + component].begin(), data.reactions[3 + component].end(),
                  reaction_j.begin() + component * cells);
        std::copy(data.reactions[6 + component].begin(), data.reactions[6 + component].end(),
                  reaction_phi.begin() + component * cells);
        std::copy(data.torque[component].begin(), data.torque[component].end(),
                  torque_volume.begin() + component * cells);
        std::copy(data.torque[3 + component].begin(), data.torque[3 + component].end(),
                  torque_surface.begin() + component * cells);
        std::copy(data.torque[6 + component].begin(), data.torque[6 + component].end(),
                  torque_total.begin() + component * cells);
    }
    std::vector<uint8_t> cell_records(parent.static_views_host[0].byte_length);
    if (cudaMemcpyAsync(cell_records.data(), parent.static_payload_device[0],
                        cell_records.size(), cudaMemcpyDeviceToHost,
                        parent.stream) != cudaSuccess ||
        cudaStreamSynchronize(parent.stream) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    std::vector<uint32_t> region_ids(cells);
    for (uint64_t cell = 0; cell < cells; ++cell) {
        const auto *record = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_cell_v1 *>(
            cell_records.data() + cell * parent.static_views_host[0].byte_stride);
        region_ids[cell] = record->region_id;
    }
    std::vector<fullmag_fdm_gpu_transport_spin_observation_record_v1> observations(
        restored->interface_observation_count);
    for (size_t index = 0; index < observations.size(); ++index) {
        auto &record = observations[index];
        record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
        record.struct_version = 1;
        record.struct_size = sizeof(record);
        record.required_features = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
        record.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE;
        record.axis = data.interface_axes[index];
        record.orientation = data.interface_orientations[index];
        record.source_id = data.interface_source_ids[index];
        record.topology_id = data.interface_topology_ids[index];
        record.canonical_face_index = data.interface_face_linear[index];
        record.negative_cell = data.interface_negative_cells[index];
        record.positive_cell = data.interface_positive_cells[index];
        record.from_cell = data.interface_from_cells[index];
        record.to_cell = data.interface_to_cells[index];
        for (uint32_t component = 0; component < 3; ++component) {
            record.lane0_xyz[component] = data.interface_values[component][index];
            record.lane1_xyz[component] = data.interface_values[3 + component][index];
            record.lane2_xyz[component] = data.interface_values[6 + component][index];
            record.lane3_xyz[component] = data.interface_values[9 + component][index];
            record.lane4_xyz[component] = data.interface_values[12 + component][index];
            record.lane5_xyz[component] = data.interface_values[15 + component][index];
        }
    }
    const bool copied =
        allocate_copy(&restored->mu_x, data.mu_s.data(), cells) &&
        allocate_copy(&restored->mu_y, data.mu_s.data() + cells, cells) &&
        allocate_copy(&restored->mu_z, data.mu_s.data() + 2 * cells, cells) &&
        allocate_copy(&restored->qx, data.qx.data(), qx_values) &&
        allocate_copy(&restored->qy, data.qy.data(), qy_values) &&
        allocate_copy(&restored->qz, data.qz.data(), qz_values) &&
        allocate_copy(&restored->reaction_sf, reaction_sf.data(), reaction_sf.size()) &&
        allocate_copy(&restored->reaction_j, reaction_j.data(), reaction_j.size()) &&
        allocate_copy(&restored->reaction_phi, reaction_phi.data(), reaction_phi.size()) &&
        allocate_copy(&restored->torque_volume, torque_volume.data(), torque_volume.size()) &&
        allocate_copy(&restored->torque_surface, torque_surface.data(), torque_surface.size()) &&
        allocate_copy(&restored->torque_total, torque_total.data(), torque_total.size()) &&
        allocate_copy(&restored->cell_region_ids, region_ids.data(), region_ids.size()) &&
        allocate_copy(&restored->interface_observations, observations.data(), observations.size());
    if (!copied || cudaStreamSynchronize(parent.stream) != cudaSuccess) {
        release_spin_buffers(*restored);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
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
        slot.requested_features =
            request->required_features | request->requested_device_features;
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
        slot.interface_authored_to_canonical.clear();
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
        slot.spin_sparse_state = {};
        slot.llg_m_stage = nullptr;
        slot.llg_torque = nullptr;
        slot.llg_cells = 0;
        slot.llg_m_ready = nullptr;
        slot.llg_torque_ready = nullptr;
        slot.llg_stage_evaluation_count = 0;
        slot.llg_binding_owner_id = 0;
        slot.llg_binding_snapshot_slot = UINT64_MAX;
        slot.llg_binding_snapshot_generation = 0;
        slot.llg_torque_in_flight = false;
        slot.llg_step_transaction_active = false;
        slot.llg_step_attempt_id = 0;
        slot.llg_step_has_stage_time = false;
        slot.llg_step_last_stage_time = 0.0;
        slot.test_fail_llg_attempt_id = 0;
        slot.test_fail_llg_stage_id = 0;
        slot.test_llg_completion_fault = 0;
        slot.test_llg_hold_state.store(0, std::memory_order_relaxed);
        slot.spin_solve_active = false;
        slot.spin_solve_token = 0;
        release_spin_buffers(slot.spin_trial);
        reset_spin_trial_metadata(slot);
        slot.spin_accepted_commit_count = 0;
        slot.spin_failed_rollback_count = 0;
        slot.spin_hierarchy_build_count = 0;
        slot.spin_hierarchy_cache_hit_count = 0;
        slot.spin_amg_apply_count = 0;
        slot.spin_fine_unknown_count = 0;
        slot.spin_coarse_unknown_count = 0;
        slot.spin_hierarchy_levels = 0;
        slot.spin_hierarchy_digest.fill(0);
        slot.spin_iterations = 0;
        slot.spin_work_budget = 0;
        slot.spin_convergence_reason = 0;
        slot.spin_local_balance = 0.0;
        slot.spin_global_balance = 0.0;
        slot.spin_interface_balance = 0.0;
        slot.spin_torque_balance = 0.0;
        slot.spin_deterministic_compute_digest.fill(0);
        slot.spin_memory_plan = {};
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
    if (slot.llg_binding_owner_id != 0 || slot.spin_solve_active) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    if (slot.live_snapshots != 0) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_LIVE_SNAPSHOT;
    }
    (void)cudaSetDevice(slot.device);
    release_charge_buffers(slot.provisional);
    release_charge_buffers(slot.accepted);
    release_spin_buffers(slot.spin_accepted);
    release_spin_buffers(slot.spin_trial);
    release_spin_sparse_state(slot.spin_sparse_state);
    release_charge_hierarchy(slot.hierarchy_cache);
    release_llg_binding_storage(slot);
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
    slot.spin_memory_plan = {};
    slot.active = false;
    slot.tombstone = true;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t static_descriptor_upload_impl(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_transport_static_descriptor_v1 *descriptor) {
    const auto trace_begin = std::chrono::steady_clock::now();
    auto trace_phase = [&](const char *phase) {
        if (std::getenv("FULLMAG_FDM_GPU_TRACE_STATIC_UPLOAD") == nullptr) return;
        std::fprintf(stderr, "static_upload_phase phase=%s elapsed=%.6f\n", phase,
                     std::chrono::duration<double>(
                         std::chrono::steady_clock::now() - trace_begin).count());
        std::fflush(stderr);
    };
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
    const std::array<double, 3> cell_face_area = {
        descriptor->cell_size[1] * descriptor->cell_size[2],
        descriptor->cell_size[0] * descriptor->cell_size[2],
        descriptor->cell_size[0] * descriptor->cell_size[1]};
    if (!std::all_of(cell_face_area.begin(), cell_face_area.end(),
                     [](double value) { return finite_host_double(value) && value > 0.0; }))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
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
    if ((descriptor->required_features & ~slot.requested_features) != 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    const bool charge_enabled =
        (descriptor->required_features &
         FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) != 0;
    const bool same_identity =
        slot.descriptor_revision == descriptor->descriptor_revision &&
        slot.source_revision == descriptor->source_revision &&
        ((slot.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) != 0) ==
            charge_enabled &&
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
    if (!charge_enabled) {
        // The feature graph owns interpretation of charge-specific fields.  A
        // descriptor without M1 charge may carry opaque/sentinel values in
        // those append-only ABI fields; they must never be dereferenced.
        slot.descriptor_revision = descriptor->descriptor_revision;
        slot.source_revision = descriptor->source_revision;
        std::memcpy(slot.descriptor_digest.data(), descriptor->descriptor_digest,
                    slot.descriptor_digest.size());
        slot.enabled_features = slot.requested_features &
            ~FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
        slot.static_descriptor_device = nullptr;
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
    trace_phase("views");
    auto checked_mul = [](uint64_t left, uint64_t right, uint64_t *result) {
        if (right != 0 && left > UINT64_MAX / right) return false;
        *result = left * right;
        return true;
    };
    auto checked_add = [](uint64_t left, uint64_t right, uint64_t *result) {
        if (left > UINT64_MAX - right) return false;
        *result = left + right;
        return true;
    };
    uint64_t yz_faces = 0, xz_faces = 0, xy_faces = 0;
    uint64_t external_face_pairs = 0, expected_external_faces = 0;
    if (!checked_mul(descriptor->grid[1], descriptor->grid[2], &yz_faces) ||
        !checked_mul(descriptor->grid[0], descriptor->grid[2], &xz_faces) ||
        !checked_mul(descriptor->grid[0], descriptor->grid[1], &xy_faces) ||
        !checked_add(yz_faces, xz_faces, &external_face_pairs) ||
        !checked_add(external_face_pairs, xy_faces, &external_face_pairs) ||
        !checked_mul(external_face_pairs, UINT64_C(2), &expected_external_faces) ||
        views[3].element_count != expected_external_faces) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
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
    std::vector<uint32_t> typed_material_ids;
    if (legacy_materials) {
        for (uint64_t i = 0; i < views[1].element_count; ++i) {
            const auto *value = reinterpret_cast<const double *>(
                reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(views[1].address)) +
                i * views[1].byte_stride);
            if (!finite_host_double(*value) || *value <= 0.0)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
    } else {
        typed_material_ids.reserve(static_cast<size_t>(views[1].element_count));
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
                !finite_host_double(material->conductivity) || material->conductivity <= 0.0)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            typed_material_ids.push_back(material->material_index);
        }
        std::sort(typed_material_ids.begin(), typed_material_ids.end());
        if (std::adjacent_find(typed_material_ids.begin(), typed_material_ids.end()) !=
            typed_material_ids.end())
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
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
                if (!std::binary_search(typed_material_ids.begin(), typed_material_ids.end(),
                                        cell->material_index))
                    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            }
        }
    }
    trace_phase("charge_materials_cells");
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
    const bool spin_enabled =
        (descriptor->required_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN) != 0;
    uint64_t spin_operator_revision = 0;
    uint64_t spin_preconditioner_revision = 0;
    std::vector<uint64_t> interface_source_ids, interface_topology_ids;
    std::vector<uint32_t> interface_axes;
    std::vector<uint64_t> interface_face_linear, interface_negative_cells,
        interface_positive_cells, interface_from_cells, interface_to_cells;
    std::vector<int32_t> interface_orientations;
    const auto *charge_cell_bytes = reinterpret_cast<const uint8_t *>(
        static_cast<uintptr_t>(views[0].address));
    const auto *interface_bytes = reinterpret_cast<const uint8_t *>(
        static_cast<uintptr_t>(views[2].address));
    auto charge_cell_at = [&](uint64_t index) {
        return reinterpret_cast<const fullmag_fdm_gpu_transport_charge_cell_v1 *>(
            charge_cell_bytes + index * views[0].byte_stride);
    };
    if (views[2].element_count != 0 &&
        (!typed_cells || !typed_materials ||
         views[2].element_type != FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES ||
         views[2].byte_stride != sizeof(fullmag_fdm_gpu_transport_spin_interface_v1)))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::vector<std::pair<uint32_t, uint64_t>> interface_face_keys;
    std::vector<uint64_t> interface_source_keys, interface_topology_keys;
    std::vector<uint64_t> interface_order;
    interface_face_keys.reserve(static_cast<size_t>(views[2].element_count));
    interface_source_keys.reserve(static_cast<size_t>(views[2].element_count));
    interface_topology_keys.reserve(static_cast<size_t>(views[2].element_count));
    interface_order.reserve(static_cast<size_t>(views[2].element_count));
    for (uint64_t i = 0; i < views[2].element_count; ++i) {
        const auto *record = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            interface_bytes + i * views[2].byte_stride);
        status = validate_prefix(record->abi_version, record->struct_version,
            record->struct_size, sizeof(*record), record->reserved_flags,
            record->required_features, UINT64_C(0x1f), record->reserved0);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
        if (record->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_SML_RESERVOIR_V2)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
        if ((record->kind != FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT &&
             record->kind != FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) ||
            record->axis > 2 || (record->orientation != -1 && record->orientation != 1) ||
            record->reserved1 != 0 || record->reserved2 != 0 ||
            record->negative_cell >= cells || record->positive_cell >= cells ||
            record->from_cell >= cells || record->to_cell >= cells ||
            record->source_id == 0 || record->topology_id == 0 ||
            !finite_host_double(record->area) || record->area <= 0.0 ||
            !finite_host_double(record->G_up) || record->G_up < 0.0 ||
            !finite_host_double(record->G_down) || record->G_down < 0.0 ||
            !finite_host_double(record->G_r) || record->G_r < 0.0 ||
            !finite_host_double(record->G_i))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const double total_conductance = record->G_up + record->G_down;
        if (!finite_host_double(total_conductance))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const uint64_t negative = record->negative_cell;
        const uint64_t nx = descriptor->grid[0], ny = descriptor->grid[1];
        const uint64_t x = negative % nx;
        const uint64_t yz = negative / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        const bool has_positive = record->axis == 0 ? x + 1 < descriptor->grid[0]
            : record->axis == 1 ? y + 1 < descriptor->grid[1]
                                : z + 1 < descriptor->grid[2];
        if (!has_positive)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const uint64_t expected_positive = record->axis == 0 ? negative + 1
            : record->axis == 1 ? negative + nx : negative + nx * ny;
        const uint64_t expected_face = record->axis == 0
            ? x + 1 + (nx + 1) * (y + ny * z)
            : record->axis == 1
                ? x + nx * (y + 1 + (ny + 1) * z)
                : x + nx * (y + ny * (z + 1));
        const bool endpoints_match =
            (record->from_cell == negative && record->to_cell == expected_positive) ||
            (record->from_cell == expected_positive && record->to_cell == negative);
        const int32_t expected_orientation = record->from_cell == negative ? 1 : -1;
        const bool endpoints_active = charge_cell_at(negative)->active != 0 &&
            charge_cell_at(negative)->conductor != 0 &&
            charge_cell_at(expected_positive)->active != 0 &&
            charge_cell_at(expected_positive)->conductor != 0;
        if (record->positive_cell != expected_positive ||
            record->canonical_face_index != expected_face || !endpoints_match ||
            record->orientation != expected_orientation || !endpoints_active ||
            std::abs(record->area - cell_face_area[record->axis]) >
                1.0e-12 * cell_face_area[record->axis])
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const double norm_squared = record->magnetization_xyz[0] * record->magnetization_xyz[0] +
            record->magnetization_xyz[1] * record->magnetization_xyz[1] +
            record->magnetization_xyz[2] * record->magnetization_xyz[2];
        if (record->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2 &&
            (!finite_host_double(norm_squared) ||
             std::abs(std::sqrt(norm_squared) - 1.0) > 1.0e-8))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        if (record->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT &&
            (record->G_up != 0.0 || record->G_down != 0.0 ||
             record->G_r != 0.0 || record->G_i != 0.0))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const bool charge_edge =
            record->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT ||
            total_conductance > 0.0;
        if (record->charge_edge_enabled != static_cast<uint32_t>(charge_edge))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        interface_face_keys.emplace_back(record->axis, record->canonical_face_index);
        interface_source_keys.push_back(record->source_id);
        interface_topology_keys.push_back(record->topology_id);
        interface_order.push_back(i);
    }
    auto has_duplicate = [](auto &keys) {
        std::sort(keys.begin(), keys.end());
        return std::adjacent_find(keys.begin(), keys.end()) != keys.end();
    };
    if (has_duplicate(interface_face_keys) || has_duplicate(interface_source_keys) ||
        has_duplicate(interface_topology_keys))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::sort(interface_order.begin(), interface_order.end(), [&](uint64_t left, uint64_t right) {
        const auto *a = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            interface_bytes + left * views[2].byte_stride);
        const auto *b = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            interface_bytes + right * views[2].byte_stride);
        if (a->axis != b->axis) return a->axis < b->axis;
        return a->canonical_face_index < b->canonical_face_index;
    });
    std::vector<uint8_t> canonical_interface_payload(
        static_cast<size_t>(views[2].byte_length));
    std::vector<uint64_t> interface_authored_to_canonical(interface_order.size());
    for (size_t canonical = 0; canonical < interface_order.size(); ++canonical) {
        interface_authored_to_canonical[interface_order[canonical]] = canonical;
        const auto *record = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            interface_bytes + interface_order[canonical] * views[2].byte_stride);
        std::memcpy(canonical_interface_payload.data() + canonical * views[2].byte_stride,
                    record, static_cast<size_t>(views[2].byte_stride));
        interface_source_ids.push_back(record->source_id);
        interface_topology_ids.push_back(record->topology_id);
        interface_axes.push_back(record->axis);
        interface_face_linear.push_back(record->canonical_face_index);
        interface_negative_cells.push_back(record->negative_cell);
        interface_positive_cells.push_back(record->positive_cell);
        interface_from_cells.push_back(record->from_cell);
        interface_to_cells.push_back(record->to_cell);
        interface_orientations.push_back(record->orientation);
    }
    if (spin_enabled) {
        const uint64_t external_faces =
            2 * (descriptor->grid[1] * descriptor->grid[2] +
                 descriptor->grid[0] * descriptor->grid[2] +
                 descriptor->grid[0] * descriptor->grid[1]);
        if (!typed_cells || !typed_materials || !typed_formula ||
            views[0].byte_stride != sizeof(fullmag_fdm_gpu_transport_spin_cell_v1) ||
            views[1].byte_stride != sizeof(fullmag_fdm_gpu_transport_spin_material_v1) ||
            views[2].byte_stride != sizeof(fullmag_fdm_gpu_transport_spin_interface_v1) ||
            views[3].byte_stride != sizeof(fullmag_fdm_gpu_transport_charge_face_v1) ||
            views[4].byte_stride != sizeof(fullmag_fdm_gpu_transport_spin_boundary_face_v1) ||
            views[5].byte_stride != sizeof(fullmag_fdm_gpu_transport_formula_ids_v1) ||
            views[3].element_count != external_faces ||
            views[4].element_count != external_faces)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        const auto *formula = reinterpret_cast<const fullmag_fdm_gpu_transport_formula_ids_v1 *>(
            static_cast<uintptr_t>(views[5].address));
        if (formula->spin_formula_id != FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1 ||
            formula->spin_operator_id != FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1 ||
            formula->electric_reconstruction_id != FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1 ||
            formula->interface_formula_id != FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2 ||
            formula->torque_operator_id != FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1 ||
            formula->spin_engine_id != FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1 ||
            formula->preconditioner_id != FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1 ||
            formula->spin_residual_id != FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1 ||
            formula->local_residual_id != FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1 ||
            formula->reserved2 != 0 || formula->reserved3 != 0 ||
            formula->spin_operator_revision == 0 || formula->preconditioner_revision == 0 ||
            !std::isfinite(formula->gamma_e) || formula->gamma_e <= 0.0 ||
            formula->gmres_restart != 50)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        spin_operator_revision = formula->spin_operator_revision;
        spin_preconditioner_revision = formula->preconditioner_revision;

        const auto *cell_bytes = reinterpret_cast<const uint8_t *>(
            static_cast<uintptr_t>(views[0].address));
        const auto *material_bytes = reinterpret_cast<const uint8_t *>(
            static_cast<uintptr_t>(views[1].address));
        const auto *interface_bytes = reinterpret_cast<const uint8_t *>(
            static_cast<uintptr_t>(views[2].address));
        const auto *spin_face_bytes = reinterpret_cast<const uint8_t *>(
            static_cast<uintptr_t>(views[4].address));
        if (views[0].element_count != cells || views[1].element_count == 0)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        auto cell_at = [&](uint64_t index) {
            return reinterpret_cast<const fullmag_fdm_gpu_transport_spin_cell_v1 *>(
                cell_bytes + index * views[0].byte_stride);
        };
        auto material_at = [&](uint64_t index) {
            return reinterpret_cast<const fullmag_fdm_gpu_transport_spin_material_v1 *>(
                material_bytes + index * views[1].byte_stride);
        };
        for (uint64_t i = 0; i < views[1].element_count; ++i) {
            const auto *material = material_at(i);
            status = validate_prefix(material->abi_version, material->struct_version,
                material->struct_size, sizeof(*material), material->reserved_flags,
                material->required_features, UINT64_C(0x1f), material->reserved0);
            if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
            if (material->reserved1 != 0 || material->material_revision == 0 ||
                material->spin_revision == 0 || !std::isfinite(material->conductivity) ||
                material->conductivity <= 0.0 ||
                !std::isfinite(material->spin_conductivity) ||
                material->spin_conductivity <= 0.0 ||
                !std::isfinite(material->polarization) || material->polarization < -1.0 ||
                material->polarization > 1.0 || !std::isfinite(material->spin_hall_angle) ||
                !std::isfinite(material->spin_flip_length) ||
                !std::isfinite(material->exchange_length) ||
                !std::isfinite(material->dephasing_length) ||
                material->spin_flip_length < 0.0 || material->exchange_length < 0.0 ||
                material->dephasing_length < 0.0)
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        for (uint64_t i = 0; i < cells; ++i) {
            const auto *cell = cell_at(i);
            status = validate_prefix(cell->abi_version, cell->struct_version,
                cell->struct_size, sizeof(*cell), cell->reserved_flags,
                cell->required_features, UINT64_C(0x1f), cell->reserved0);
            if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
            if (cell->reserved1 != 0 || cell->reserved2 != 0 ||
                (cell->spin_active != 0 && (cell->active == 0 || cell->conductor == 0)) ||
                (cell->torque_target != 0 && (!std::isfinite(cell->saturation_magnetization) ||
                                              cell->saturation_magnetization <= 0.0)))
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
            if (!std::binary_search(typed_material_ids.begin(), typed_material_ids.end(),
                                    cell->material_index))
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
        for (uint64_t i = 0; i < views[4].element_count; ++i) {
            const auto *face = reinterpret_cast<
                const fullmag_fdm_gpu_transport_spin_boundary_face_v1 *>(
                spin_face_bytes + i * views[4].byte_stride);
            status = validate_prefix(face->abi_version, face->struct_version,
                face->struct_size, sizeof(*face), face->reserved_flags,
                face->required_features, UINT64_C(0x1f), face->reserved0);
            if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
            if (face->kind < FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING ||
                face->kind > FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL ||
                face->axis > 2 || (face->side != -1 && face->side != 1) ||
                face->outward_sign != face->side || face->adjacent_cell >= cells ||
                face->source_id == 0 || !std::isfinite(face->area) || face->area <= 0.0 ||
                !std::all_of(std::begin(face->potential_xyz), std::end(face->potential_xyz),
                             [](double value) { return std::isfinite(value); }) ||
                (face->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING &&
                 (face->potential_xyz[0] != 0.0 || face->potential_xyz[1] != 0.0 ||
                  face->potential_xyz[2] != 0.0)))
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        }
    }
    trace_phase("spin_materials_cells_faces_interfaces");
    std::vector<uint64_t> charge_adjacent_cells;
    std::vector<uint32_t> charge_axes;
    std::vector<int32_t> charge_sides;
    std::vector<double> charge_areas;
    std::vector<double> charge_values;
    std::vector<std::string> charge_source_ids;
    std::vector<std::pair<uint64_t, uint64_t>> charge_face_order;
    charge_face_order.reserve(static_cast<size_t>(views[3].element_count));
    if (cells > UINT64_MAX / 6)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    std::vector<uint8_t> charge_face_identity_seen(6 * cells, uint8_t{0});
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
        const uint64_t identity =
            (uint64_t{2} * axis + (side > 0 ? 1u : 0u)) * cells + adjacent;
        if (charge_face_identity_seen[identity] != 0)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        charge_face_identity_seen[identity] = 1;
        const uint64_t x_boundary_faces = 2 * descriptor->grid[1] * descriptor->grid[2];
        const uint64_t y_boundary_faces = 2 * descriptor->grid[0] * descriptor->grid[2];
        const uint64_t boundary_ordinal = axis == 0
            ? (side > 0 ? descriptor->grid[1] * descriptor->grid[2] : 0) +
                y + descriptor->grid[1] * z
            : axis == 1
                ? x_boundary_faces +
                    (side > 0 ? descriptor->grid[0] * descriptor->grid[2] : 0) +
                    x + descriptor->grid[0] * z
                : x_boundary_faces + y_boundary_faces +
                    (side > 0 ? descriptor->grid[0] * descriptor->grid[1] : 0) +
                    x + descriptor->grid[0] * y;
        charge_face_order.emplace_back(boundary_ordinal, i);
        if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY) {
            charge_adjacent_cells.push_back(adjacent);
            charge_axes.push_back(axis);
            charge_sides.push_back(side);
            charge_areas.push_back(area);
            charge_values.push_back(value);
            charge_source_ids.push_back(std::to_string(source_id));
        }
    }
    std::sort(charge_face_order.begin(), charge_face_order.end());
    for (uint64_t ordinal = 0; ordinal < expected_external_faces; ++ordinal)
        if (charge_face_order[static_cast<size_t>(ordinal)].first != ordinal)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::vector<uint8_t> canonical_charge_face_payload(
        static_cast<size_t>(views[3].byte_length));
    for (size_t canonical = 0; canonical < charge_face_order.size(); ++canonical) {
        const uint64_t original = charge_face_order[canonical].second;
        const auto *source = reinterpret_cast<const uint8_t *>(
            static_cast<uintptr_t>(views[3].address)) + original * views[3].byte_stride;
        std::memcpy(canonical_charge_face_payload.data() + canonical * views[3].byte_stride,
                    source, static_cast<size_t>(views[3].byte_stride));
    }
    trace_phase("charge_faces");
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
    trace_phase("device_allocations");
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
        const void *host_payload = reinterpret_cast<const void *>(
            static_cast<uintptr_t>(views[i].address));
        if (i == 2 && !canonical_interface_payload.empty())
            host_payload = canonical_interface_payload.data();
        if (i == 3 && !canonical_charge_face_payload.empty())
            host_payload = canonical_charge_face_payload.data();
        if (views[i].byte_length != 0 && cudaMemcpyAsync(
                device_payloads[i], host_payload,
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
    trace_phase("h2d_and_sync");
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
    slot.spin_operator_revision = spin_operator_revision;
    slot.spin_preconditioner_revision = spin_preconditioner_revision;
    std::memcpy(slot.descriptor_digest.data(), descriptor->descriptor_digest,
                slot.descriptor_digest.size());
    slot.static_uploaded = true;
    slot.enabled_features = slot.requested_features;
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
    slot.interface_source_ids = std::move(interface_source_ids);
    slot.interface_authored_to_canonical = std::move(interface_authored_to_canonical);
    slot.interface_topology_ids = std::move(interface_topology_ids);
    slot.interface_axes = std::move(interface_axes);
    slot.interface_face_linear = std::move(interface_face_linear);
    slot.interface_negative_cells = std::move(interface_negative_cells);
    slot.interface_positive_cells = std::move(interface_positive_cells);
    slot.interface_from_cells = std::move(interface_from_cells);
    slot.interface_to_cells = std::move(interface_to_cells);
    slot.interface_orientations = std::move(interface_orientations);
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
    device_input.descriptor_revision = slot.descriptor_revision;
    device_input.source_revision = slot.source_revision;
    device_input.gauge_policy = request->gauge_policy;
    device_input.hierarchy_cache = &slot.hierarchy_cache;
    CudaFailurePolicy failure_policy{slot.test_failure_boundary, 0};
    device_input.failure_policy = &failure_policy;
    fullmag::fdm::gpu::transport::charge::SolveOutput device_output{};
    status = fullmag::fdm::gpu::transport::charge::solve_device(device_input, &device_output);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        if (failure_policy.failed_boundary != 0) {
            slot.test_failure_boundary = 0;
            const uint64_t metrics_bytes =
                fullmag::fdm::gpu::transport::charge::solve_metrics_bytes();
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
                     FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL,
                 metrics_bytes, 1},
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
    std::array<uint8_t, 32> candidate_digest{};
    status = accepted_charge_content_digest(
        slot, device_output.buffers, candidate_sequence, candidate_lineage,
        device_output.iterations, device_output.component_balance,
        device_output.physical_residual, &candidate_digest, &failure_policy, 15, 16);
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
    if (device_output.warm_start_used)
        ++slot.hierarchy_cache.warm_use_count;
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
    size_t snapshot_index = slots.size();
    for (size_t i = 0; i < slots.size(); ++i) {
        if (!slots[i].active && slots[i].generation != UINT64_MAX) {
            snapshot_index = i;
            break;
        }
    }
    if (snapshot_index == slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint64_t accepted_sequence = parent.accepted_sequence + 1;
    if (!parent.hierarchy_cache.valid ||
        parent.hierarchy_cache.warm_potential == nullptr ||
        parent.hierarchy_cache.warm_potential_staging == nullptr ||
        parent.hierarchy_cache.cells != parent.provisional.cells ||
        parent.provisional.cells > UINT64_MAX / sizeof(double)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    if (cudaSetDevice(parent.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (!reserve_telemetry_sequences(parent, 2))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint64_t warm_copy_bytes = parent.provisional.cells * sizeof(double);
    const bool inject_copy_failure = parent.test_failure_boundary == 70;
    const bool inject_sync_failure = parent.test_failure_boundary == 71;
    if (inject_copy_failure || inject_sync_failure)
        parent.test_failure_boundary = 0;
    if (inject_copy_failure ||
        cudaMemcpyAsync(parent.hierarchy_cache.warm_potential_staging,
                        parent.provisional.potential, warm_copy_bytes,
                        cudaMemcpyDeviceToDevice, parent.stream) != cudaSuccess) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 0, 0, 0, parent.iterations, parent.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t warm_sync = inject_sync_failure
        ? cudaErrorUnknown
        : cudaStreamSynchronize(parent.stream);
    if (inject_sync_failure || warm_sync != cudaSuccess) {
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
            warm_copy_bytes, 1, 0, 0, parent.iterations,
            parent.candidate_digest.data());
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 0, 0, 0, parent.iterations, parent.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    std::swap(parent.hierarchy_cache.warm_potential,
              parent.hierarchy_cache.warm_potential_staging);
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SCIENTIFIC_COMMIT,
        warm_copy_bytes, 1, 0, 0, parent.iterations, parent.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SCIENTIFIC_COMMIT,
        0, 1, 0, 0, parent.iterations, parent.candidate_digest.data());
    parent.hierarchy_cache.warm_descriptor_revision = parent.descriptor_revision;
    parent.hierarchy_cache.warm_source_revision = parent.source_revision;
    parent.hierarchy_cache.warm_valid = true;
    ++parent.hierarchy_cache.warm_promotion_count;
    std::array<uint8_t, 16> lineage{};
    for (size_t byte = 0; byte < lineage.size(); ++byte)
        lineage[byte] = static_cast<uint8_t>(
            parent.descriptor_digest[byte] ^ ((accepted_sequence + byte) & 0xff));
    const std::array<uint8_t, 32> content_digest = parent.candidate_digest;
    Slot &snapshot = slots[snapshot_index];
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
    snapshot_info->snapshot_handle = {kCookie, snapshot_index, snapshot.generation, kSnapshotTag};
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
         snapshot.accepted.jy_count + snapshot.accepted.jz_count +
         4 * snapshot.accepted.interface_count) * sizeof(double);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_solve_steady_spin_v1(
    const fullmag_fdm_gpu_steady_spin_solve_request_v1 *request,
    fullmag_fdm_gpu_steady_spin_solve_result_v1 *result) {
    if (request == nullptr || result == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    uint32_t status = validate_prefix(
        request->abi_version, request->struct_version, request->struct_size,
        sizeof(*request), request->reserved_flags, request->required_features,
        UINT64_C(0x1f), request->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    status = validate_prefix(
        result->abi_version, result->struct_version, result->struct_size,
        sizeof(*result), result->reserved_flags, result->required_features,
        UINT64_C(0x1f), result->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    if (request->solver_policy !=
            FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1 ||
        request->reserved1 != 0 || !std::isfinite(request->relative_tolerance) ||
        request->relative_tolerance <= 0.0 || request->relative_tolerance >= 1.0 ||
        request->max_iterations == 0 || request->m_stage_view_ptr == 0 ||
        request->torque_view_ptr == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;

    const auto *m_view = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        static_cast<uintptr_t>(request->m_stage_view_ptr));
    const auto *torque_view = reinterpret_cast<const fullmag_fdm_gpu_transport_buffer_view_v1 *>(
        static_cast<uintptr_t>(request->torque_view_ptr));
    status = validate_prefix(m_view->abi_version, m_view->struct_version,
        m_view->struct_size, sizeof(*m_view), m_view->reserved_flags,
        m_view->required_features, 0, m_view->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;
    status = validate_prefix(torque_view->abi_version, torque_view->struct_version,
        torque_view->struct_size, sizeof(*torque_view), torque_view->reserved_flags,
        torque_view->required_features, 0, torque_view->reserved0);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) return status;

    std::unique_lock<std::mutex> lock(registry_mutex);
    const auto &context = request->context_handle;
    const auto &snapshot_handle = request->snapshot_handle;
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size() || snapshot_handle.registry_cookie != kCookie ||
        snapshot_handle.type_tag != kSnapshotTag || snapshot_handle.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    Slot &parent = slots[context.slot];
    Slot &snapshot = slots[snapshot_handle.slot];
    if (!same(context, context.slot, parent.generation) || !parent.active ||
        !snapshot.active || snapshot.generation != snapshot_handle.generation ||
        snapshot.parent_slot != context.slot ||
        snapshot.parent_generation != context.generation ||
        snapshot.accepted_sequence != request->accepted_sequence)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;
    if ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN) == 0 ||
        (parent.requested_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (request->source_revision != parent.source_revision ||
        request->operator_revision != parent.spin_operator_revision)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const bool transactional = parent.llg_binding_owner_id != 0;
    if (transactional &&
        (!parent.llg_step_transaction_active ||
         parent.llg_step_attempt_id != request->attempt_id ||
         parent.llg_binding_snapshot_slot != snapshot_handle.slot ||
         parent.llg_binding_snapshot_generation != snapshot_handle.generation)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }

    const uint64_t cells = parent.grid[0] * parent.grid[1] * parent.grid[2];
    uint64_t vector_values = 0;
    if (cells > UINT64_MAX / 3) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    vector_values = 3 * cells;
    if (m_view->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY ||
        torque_view->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY ||
        m_view->element_type != FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64 ||
        torque_view->element_type != FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64 ||
        m_view->component_order != FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ ||
        torque_view->component_order != FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ ||
        m_view->byte_stride != sizeof(double) || torque_view->byte_stride != sizeof(double) ||
        m_view->element_count != vector_values || torque_view->element_count != vector_values ||
        m_view->byte_length != vector_values * sizeof(double) ||
        torque_view->byte_length != vector_values * sizeof(double) ||
        m_view->address == 0 || torque_view->address == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_POINTER_SPACE;
    if (cudaSetDevice(parent.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;

    fullmag::fdm::gpu::transport::spin::SolveInput input{};
    for (uint32_t axis = 0; axis < 3; ++axis) {
        input.grid[axis] = parent.grid[axis];
        input.cell_size[axis] = parent.cell_size[axis];
    }
    for (uint32_t view = 0; view < 6; ++view) {
        input.payloads[view] = parent.static_payload_device[view];
        input.views[view] = parent.static_views_host[view];
    }
    input.accepted_potential = snapshot.accepted.potential;
    input.accepted_jx = snapshot.accepted.jx;
    input.accepted_jy = snapshot.accepted.jy;
    input.accepted_jz = snapshot.accepted.jz;
    input.accepted_jx_count = snapshot.accepted.jx_count;
    input.accepted_jy_count = snapshot.accepted.jy_count;
    input.accepted_jz_count = snapshot.accepted.jz_count;
    input.accepted_interface_from_trace_v = snapshot.accepted.interface_from_trace_v;
    input.accepted_interface_to_trace_v = snapshot.accepted.interface_to_trace_v;
    input.accepted_interface_delta_trace_v = snapshot.accepted.interface_delta_trace_v;
    input.accepted_interface_charge_current_density =
        snapshot.accepted.interface_charge_current_density;
    input.accepted_interface_count = snapshot.accepted.interface_count;
    std::memcpy(input.accepted_snapshot_digest,
                snapshot.candidate_digest.data(), 32);
    input.m_stage = reinterpret_cast<const double *>(static_cast<uintptr_t>(m_view->address));
    input.torque_destination = reinterpret_cast<double *>(
        static_cast<uintptr_t>(torque_view->address));
    input.stream = parent.stream;
    input.allocator_limit = parent.allocator_limit;
    input.workspace_limit = parent.workspace_limit;
    input.relative_tolerance = request->relative_tolerance;
    input.max_iterations = request->max_iterations;
    input.sparse_state = &parent.spin_sparse_state;
    input.operator_revision = request->operator_revision;
    input.test_failure_boundary = parent.test_failure_boundary;
    parent.test_failure_boundary = 0;
    input.interface_negative_cells_host = parent.interface_negative_cells.data();
    input.interface_positive_cells_host = parent.interface_positive_cells.data();
    uint64_t resident_bytes = sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1) +
        6 * sizeof(fullmag_fdm_gpu_transport_buffer_view_v1);
    for (uint64_t bytes : parent.static_payload_bytes) resident_bytes += bytes;
    resident_bytes += snapshot.accepted.cells * sizeof(uint8_t);
    resident_bytes += (2 * snapshot.accepted.cells + snapshot.accepted.jx_count +
                       snapshot.accepted.jy_count + snapshot.accepted.jz_count +
                       4 * snapshot.accepted.interface_count) * sizeof(double);
    resident_bytes += 2 * vector_values * sizeof(double);
    resident_bytes += snapshot.spin_accepted.owned_bytes +
        snapshot.spin_trial.owned_bytes;
    input.resident_external_bytes = resident_bytes;
    input.old_accepted_bytes = transactional
        ? snapshot.spin_trial.owned_bytes
        : snapshot.spin_accepted.owned_bytes;
    input.tracked_resident_bytes =
        resident_bytes - input.old_accepted_bytes;
    size_t free_device_bytes = 0;
    size_t total_device_bytes = 0;
    if (cudaMemGetInfo(&free_device_bytes, &total_device_bytes) != cudaSuccess ||
        free_device_bytes > total_device_bytes)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    input.free_device_bytes = free_device_bytes;
    input.total_device_bytes = total_device_bytes;
    input.static_baseline_bytes = total_device_bytes - free_device_bytes;
    if (parent.spin_solve_active || parent.spin_solve_token == UINT64_MAX)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (!reserve_telemetry_sequences(parent, 4))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint64_t solve_token = ++parent.spin_solve_token;
    const uint64_t context_generation = parent.generation;
    const uint64_t snapshot_generation = snapshot.generation;
    parent.spin_solve_active = true;
    lock.unlock();
    const uint32_t barrier_expected =
        test_spin_solve_barrier_expected.load(std::memory_order_acquire);
    bool barrier_complete = true;
    if (barrier_expected != 0) {
        test_spin_solve_barrier_arrivals.fetch_add(1, std::memory_order_acq_rel);
        const auto deadline = std::chrono::steady_clock::now() +
            std::chrono::seconds(5);
        while (test_spin_solve_barrier_arrivals.load(std::memory_order_acquire) <
               barrier_expected) {
            if (std::chrono::steady_clock::now() >= deadline) {
                barrier_complete = false;
                break;
            }
            std::this_thread::yield();
        }
    }
    fullmag::fdm::gpu::transport::spin::SolveOutput output{};
    status = barrier_complete
        ? fullmag::fdm::gpu::transport::spin::solve_device(input, &output)
        : FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    lock.lock();
    if (!parent.active || parent.generation != context_generation ||
        !snapshot.active || snapshot.generation != snapshot_generation ||
        !parent.spin_solve_active || parent.spin_solve_token != solve_token) {
        release_spin_buffers(output.buffers);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    }
    parent.spin_solve_active = false;
    parent.spin_memory_plan = output.memory_plan;
    result->iterations = output.iterations;
    result->reason = output.reason;
    result->algebraic_residual = output.algebraic_residual;
    result->local_balance = output.local_balance;
    result->global_balance = output.global_balance;
    result->interface_balance = output.interface_balance;
    result->torque_balance = output.torque_balance;
    result->transfer_count = output.transfer_count;
    result->transfer_bytes = output.transfer_bytes;
    result->peak_bytes = output.peak_bytes;
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        if (!transactional) ++parent.spin_failed_rollback_count;
        append_charge_telemetry(
            parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_NONE,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_REJECTED_ATTEMPT,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_FAILED,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED,
            0, 0, request->attempt_id, request->stage_id, output.iterations,
            snapshot.candidate_digest.data());
        return status;
    }

    const uint32_t stage_transfer_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    const uint32_t stage_sync_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION |
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_PROVISIONAL;
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CONTROL_STATE_H2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        stage_transfer_flags, output.control_h2d_bytes,
        output.control_h2d_count, request->attempt_id, request->stage_id,
        output.iterations, snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        stage_transfer_flags, output.control_d2h_bytes,
        output.control_d2h_count, request->attempt_id, request->stage_id,
        output.iterations, snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        stage_sync_flags, 0, output.control_host_sync_count,
        request->attempt_id, request->stage_id, output.iterations,
        snapshot.candidate_digest.data());
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVE_STATE_D2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        stage_transfer_flags, vector_values * sizeof(double), 1,
        request->attempt_id, request->stage_id, output.iterations,
        snapshot.candidate_digest.data());

    if (transactional) {
        release_spin_buffers(snapshot.spin_trial);
        snapshot.spin_trial = output.buffers;
        parent.spin_trial_hierarchy_build_count += output.hierarchy_build_count;
        parent.spin_trial_hierarchy_cache_hit_count += output.cache_hit_count;
        parent.spin_trial_amg_apply_count += output.amg_apply_count;
        parent.spin_trial_fine_unknown_count = output.fine_unknowns;
        parent.spin_trial_coarse_unknown_count = output.coarse_unknowns;
        parent.spin_trial_hierarchy_levels = output.hierarchy_levels;
        std::memcpy(parent.spin_trial_hierarchy_digest.data(),
                    output.hierarchy_digest, 32);
        parent.spin_trial_iterations = output.iterations;
        parent.spin_trial_work_budget = request->max_iterations;
        parent.spin_trial_convergence_reason = output.reason;
        parent.spin_trial_local_balance = output.local_balance;
        parent.spin_trial_global_balance = output.global_balance;
        parent.spin_trial_interface_balance = output.interface_balance;
        parent.spin_trial_torque_balance = output.torque_balance;
        std::memcpy(parent.spin_trial_compute_digest.data(),
                    output.deterministic_compute_digest, 32);
        std::memcpy(result->snapshot_content_digest,
                    snapshot.candidate_digest.data(), 32);
        std::memcpy(result->deterministic_compute_digest,
                    output.deterministic_compute_digest, 32);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }

    release_spin_buffers(snapshot.spin_accepted);
    snapshot.spin_accepted = output.buffers;
    ++parent.spin_accepted_commit_count;
    parent.spin_hierarchy_build_count += output.hierarchy_build_count;
    parent.spin_hierarchy_cache_hit_count += output.cache_hit_count;
    parent.spin_amg_apply_count += output.amg_apply_count;
    parent.spin_fine_unknown_count = output.fine_unknowns;
    parent.spin_coarse_unknown_count = output.coarse_unknowns;
    parent.spin_hierarchy_levels = output.hierarchy_levels;
    std::memcpy(parent.spin_hierarchy_digest.data(), output.hierarchy_digest, 32);
    snapshot.spin_iterations = output.iterations;
    snapshot.spin_work_budget = request->max_iterations;
    snapshot.spin_convergence_reason = output.reason;
    snapshot.spin_local_balance = output.local_balance;
    snapshot.spin_global_balance = output.global_balance;
    snapshot.spin_interface_balance = output.interface_balance;
    snapshot.spin_torque_balance = output.torque_balance;
    std::memcpy(snapshot.spin_deterministic_compute_digest.data(),
                output.deterministic_compute_digest, 32);
    std::memcpy(result->snapshot_content_digest, snapshot.candidate_digest.data(), 32);
    std::memcpy(result->deterministic_compute_digest,
                output.deterministic_compute_digest, 32);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_spin_solve_barrier_v1(
    uint32_t expected) {
    if (expected != 0 && expected != 2)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    test_spin_solve_barrier_arrivals.store(0, std::memory_order_release);
    test_spin_solve_barrier_expected.store(expected, std::memory_order_release);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
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
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C &&
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S &&
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA &&
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT &&
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_CHARGE_INTERFACE_TRACE &&
        request->field_id != FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TRANSPORT_OBSERVATIONS)
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
    const bool observation_stream = request->field_id ==
        FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TRANSPORT_OBSERVATIONS;
    const bool interface_trace_stream = request->field_id ==
        FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_CHARGE_INTERFACE_TRACE;
    const bool oriented_face_field =
        request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C ||
        request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA;
    const bool scalar_field = request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V;
    const uint32_t expected_component_order = observation_stream || interface_trace_stream || scalar_field
        ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR
        : oriented_face_field
            ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
            : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
    const uint64_t element_bytes = observation_stream
        ? sizeof(fullmag_fdm_gpu_transport_spin_observation_record_v1)
        : interface_trace_stream
            ? sizeof(fullmag_fdm_gpu_transport_charge_interface_trace_v1)
        : sizeof(double);
    if (request->range_count > UINT64_MAX / element_bytes ||
        destination->pointer_space != FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY ||
        destination->element_type != (observation_stream || interface_trace_stream
            ? FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES
            : FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64) ||
        destination->component_order != expected_component_order ||
        destination->byte_stride != element_bytes || destination->address == 0 ||
        destination->element_count != request->range_count ||
        request->expected_bytes != request->range_count * element_bytes ||
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
    if ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE) == 0 ||
        (parent.requested_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (!reserve_telemetry_sequences(parent, 2))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    uint64_t total = 0;
    if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V)
        total = snapshot.accepted.cells;
    else if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C)
        total = snapshot.accepted.jx_count + snapshot.accepted.jy_count +
                snapshot.accepted.jz_count;
    else if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S)
        total = 3 * snapshot.spin_accepted.cells;
    else if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA)
        total = snapshot.spin_accepted.qx_values + snapshot.spin_accepted.qy_values +
                snapshot.spin_accepted.qz_values;
    else if (interface_trace_stream)
        total = snapshot.accepted.interface_count;
    else if (observation_stream)
        total = snapshot.spin_accepted.observation_count;
    else
        total = 3 * snapshot.spin_accepted.cells;
    const bool spin_field=request->field_id==FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S||
        request->field_id==FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA||
        request->field_id==FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT||observation_stream;
    if (spin_field &&
        snapshot.spin_accepted.mu_x == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (request->range_begin > total || request->range_count > total - request->range_begin)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (cudaSetDevice(parent.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    uint8_t *host = reinterpret_cast<uint8_t *>(static_cast<uintptr_t>(destination->address));
    uint64_t begin = request->range_begin;
    uint64_t remaining = request->range_count;
    uint64_t transfer_segments = 0;
    uint64_t transferred_bytes = 0;
    fullmag_fdm_gpu_transport_spin_observation_record_v1 *observation_staging = nullptr;
    std::array<std::vector<double>,4> interface_trace_values;
    const uint32_t cadence_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    const std::array<AuditBoundary, 2> artifact_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | cadence_flags,
         interface_trace_stream?request->range_count*4*sizeof(double):request->expected_bytes,
         interface_trace_stream?UINT64_C(4):UINT64_C(1)},
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
    bool copied = false;
    if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V) {
        copied = copy_range(snapshot.accepted.potential, snapshot.accepted.cells);
    } else if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C) {
        copied = copy_range(snapshot.accepted.jx, snapshot.accepted.jx_count) &&
                 copy_range(snapshot.accepted.jy, snapshot.accepted.jy_count) &&
                 copy_range(snapshot.accepted.jz, snapshot.accepted.jz_count);
    } else if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S) {
        copied = copy_range(snapshot.spin_accepted.mu_x, snapshot.spin_accepted.cells) &&
                 copy_range(snapshot.spin_accepted.mu_y, snapshot.spin_accepted.cells) &&
                 copy_range(snapshot.spin_accepted.mu_z, snapshot.spin_accepted.cells);
    } else if (request->field_id == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA) {
        copied = copy_range(snapshot.spin_accepted.qx, snapshot.spin_accepted.qx_values) &&
                 copy_range(snapshot.spin_accepted.qy, snapshot.spin_accepted.qy_values) &&
                 copy_range(snapshot.spin_accepted.qz, snapshot.spin_accepted.qz_values);
    } else if (interface_trace_stream) {
        const uint64_t count=remaining;
        const uint64_t start=begin;
        for(auto &values:interface_trace_values) values.resize(count);
        const std::array<const double *,4> sources{{
            snapshot.accepted.interface_from_trace_v,snapshot.accepted.interface_to_trace_v,
            snapshot.accepted.interface_delta_trace_v,
            snapshot.accepted.interface_charge_current_density}};
        copied=true;
        for(size_t lane=0;lane<sources.size()&&copied;++lane) {
            for(uint64_t output=0;output<count&&copied;++output) {
                const uint64_t authored=start+output;
                const uint64_t canonical=parent.interface_authored_to_canonical[authored];
                copied=cudaMemcpyAsync(interface_trace_values[lane].data()+output,
                    sources[lane]+canonical,sizeof(double),cudaMemcpyDeviceToHost,
                    parent.stream)==cudaSuccess;
                if(copied){++transfer_segments;transferred_bytes+=sizeof(double);}
            }
        }
        remaining=0;
    } else if (observation_stream) {
        const uint64_t count = remaining;
        constexpr uint64_t kObservationChunkRecords = 4096;
        const uint64_t staging_count = std::min(count, kObservationChunkRecords);
        copied = count == 0 || cudaMalloc(
            reinterpret_cast<void **>(&observation_staging),
            staging_count * sizeof(*observation_staging)) == cudaSuccess;
        uint64_t offset = 0;
        while (copied && offset < count) {
            const uint64_t chunk = std::min(kObservationChunkRecords, count - offset);
            copied = fullmag::fdm::gpu::transport::spin::materialize_observation_range(
                         snapshot.spin_accepted, begin + offset, chunk,
                         observation_staging, parent.stream) ==
                         FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                     cudaMemcpyAsync(
                         host + offset * sizeof(*observation_staging),
                         observation_staging, chunk * sizeof(*observation_staging),
                         cudaMemcpyDeviceToHost, parent.stream) == cudaSuccess;
            if (copied) {
                ++transfer_segments;
                transferred_bytes += chunk * sizeof(*observation_staging);
            }
            offset += chunk;
        }
        remaining = 0;
    } else {
        copied = copy_range(snapshot.spin_accepted.torque_total,
                            3 * snapshot.spin_accepted.cells);
    }
    if (!copied || remaining != 0) {
        if (observation_staging != nullptr) (void)cudaFree(observation_staging);
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
        if (observation_staging != nullptr) (void)cudaFree(observation_staging);
        parent.test_failure_boundary = 0;
        auto boundaries = artifact_boundaries;
        boundaries[0].bytes = transferred_bytes;
        boundaries[0].count = transfer_segments;
        publish_boundary_failure(parent, 20, 21, boundaries.data(),
            boundaries.size(), 0, 0, 0, snapshot.candidate_digest.data());
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaStreamSynchronize(parent.stream) != cudaSuccess) {
        if (observation_staging != nullptr) (void)cudaFree(observation_staging);
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
    if (observation_staging != nullptr) {
        (void)cudaFree(observation_staging);
        observation_staging = nullptr;
    }
    if(interface_trace_stream) {
        auto *records=reinterpret_cast<fullmag_fdm_gpu_transport_charge_interface_trace_v1 *>(
            static_cast<uintptr_t>(destination->address));
        for(uint64_t output=0;output<request->range_count;++output) {
            const uint64_t authored=request->range_begin+output;
            const uint64_t index=parent.interface_authored_to_canonical[authored];
            auto &record=records[output]; std::memset(&record,0,sizeof(record));
            record.abi_version=FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
            record.struct_version=1;record.struct_size=sizeof(record);
            record.required_features=FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE|
                FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
            record.axis=parent.interface_axes[index];record.orientation=parent.interface_orientations[index];
            record.source_id=parent.interface_source_ids[index];record.topology_id=parent.interface_topology_ids[index];
            record.canonical_face_index=parent.interface_face_linear[index];
            record.negative_cell=parent.interface_negative_cells[index];record.positive_cell=parent.interface_positive_cells[index];
            record.from_cell=parent.interface_from_cells[index];record.to_cell=parent.interface_to_cells[index];
            record.from_trace_v=interface_trace_values[0][output];record.to_trace_v=interface_trace_values[1][output];
            record.delta_trace_v=interface_trace_values[2][output];
            record.oriented_current_density=interface_trace_values[3][output];
        }
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
    if (request->inclusion_mask != UINT32_C(0x33) &&
        request->inclusion_mask != UINT32_C(0x3f))
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
    populate_checkpoint_interface_identity(parent, &data);
    data.interface_from_trace_v.resize(snapshot.accepted.interface_count);
    data.interface_to_trace_v.resize(snapshot.accepted.interface_count);
    data.interface_delta_trace_v.resize(snapshot.accepted.interface_count);
    data.interface_charge_current_density.resize(snapshot.accepted.interface_count);
    data.active.resize(snapshot.accepted.cells); data.conductivity.resize(snapshot.accepted.cells);
    data.potential.resize(snapshot.accepted.cells); data.jx.resize(snapshot.accepted.jx_count);
    data.jy.resize(snapshot.accepted.jy_count); data.jz.resize(snapshot.accepted.jz_count);
    const bool include_spin = request->inclusion_mask == UINT32_C(0x3f);
    std::vector<uint8_t> payload;
    if (include_spin) {
        if (snapshot.spin_accepted.mu_x == nullptr ||
            (parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN) == 0)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
        fullmag::fdm::gpu::transport::spin::SpinCheckpointData spin_data{};
        initialize_spin_checkpoint_data(parent, snapshot, &spin_data);
        if (!fullmag::fdm::gpu::transport::spin::build_checkpoint(
                data, spin_data, &payload))
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    } else if (!fullmag::fdm::gpu::transport::charge::build_checkpoint(
                   &data, &payload)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    }
    result->required_bytes = payload.size();
    result->section_count = include_spin ? 20 : 11;
    result->alignment = 64;
    result->schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    result->inclusion_mask = request->inclusion_mask;
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
    if (request->reserved1 != 0 ||
        (request->inclusion_mask != UINT32_C(0x33) &&
         request->inclusion_mask != UINT32_C(0x3f)) ||
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
    const bool include_spin = request->inclusion_mask == UINT32_C(0x3f);
    if (include_spin &&
        ((parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN) == 0 ||
         snapshot.spin_accepted.mu_x == nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (!reserve_telemetry_sequences(parent, 4))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint32_t checkpoint_flags =
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED;
    CudaFailurePolicy failure_policy{parent.test_failure_boundary, 0};
    std::array<uint8_t, 32> verified_digest{};
    status = accepted_charge_content_digest(
        parent, snapshot.accepted, snapshot.accepted_sequence,
        snapshot.snapshot_lineage, snapshot.iterations, snapshot.component_balance,
        snapshot.physical_residual, &verified_digest, &failure_policy, 30, 31);
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
    populate_checkpoint_interface_identity(parent, &data);
    data.active.resize(snapshot.accepted.cells); data.conductivity.resize(snapshot.accepted.cells);
    data.potential.resize(snapshot.accepted.cells); data.jx.resize(snapshot.accepted.jx_count);
    data.jy.resize(snapshot.accepted.jy_count); data.jz.resize(snapshot.accepted.jz_count);
    data.interface_from_trace_v.resize(snapshot.accepted.interface_count);
    data.interface_to_trace_v.resize(snapshot.accepted.interface_count);
    data.interface_delta_trace_v.resize(snapshot.accepted.interface_count);
    data.interface_charge_current_density.resize(snapshot.accepted.interface_count);
    uint64_t export_bytes = data.active.size() +
        (data.conductivity.size() + data.potential.size() + data.jx.size() +
         data.jy.size() + data.jz.size() + 4 * snapshot.accepted.interface_count) *
            sizeof(double);
    uint64_t export_count = 6 + (snapshot.accepted.interface_count == 0 ? 0 : 4);
    fullmag::fdm::gpu::transport::spin::SpinCheckpointData spin_data{};
    if (include_spin) {
        initialize_spin_checkpoint_data(parent, snapshot, &spin_data);
        export_bytes += (spin_data.mu_s.size() + spin_data.qx.size() +
            spin_data.qy.size() + spin_data.qz.size() +
            spin_data.warm_iterate.size()) * sizeof(double);
        for (const auto &values : spin_data.reactions)
            export_bytes += values.size() * sizeof(double);
        for (size_t index = 0; index < 9; ++index)
            export_bytes += spin_data.torque[index].size() * sizeof(double);
        export_bytes += snapshot.spin_accepted.interface_observation_count *
            sizeof(fullmag_fdm_gpu_transport_spin_observation_record_v1);
    }
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
             FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags,
             export_bytes, export_count},
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
                     data.jz.size() * sizeof(double)) ||
        (snapshot.accepted.interface_count != 0 &&
         (!export_copy(data.interface_from_trace_v.data(),
                       snapshot.accepted.interface_from_trace_v,
                       snapshot.accepted.interface_count * sizeof(double)) ||
          !export_copy(data.interface_to_trace_v.data(),
                       snapshot.accepted.interface_to_trace_v,
                       snapshot.accepted.interface_count * sizeof(double)) ||
          !export_copy(data.interface_delta_trace_v.data(),
                       snapshot.accepted.interface_delta_trace_v,
                       snapshot.accepted.interface_count * sizeof(double)) ||
          !export_copy(data.interface_charge_current_density.data(),
                       snapshot.accepted.interface_charge_current_density,
                       snapshot.accepted.interface_count * sizeof(double))))) {
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
    if (include_spin && !copy_spin_checkpoint_to_host(
            parent, snapshot, &spin_data, &copied_export_bytes,
            &copied_export_count)) {
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    std::vector<uint8_t> payload;
    const bool built = include_spin
        ? fullmag::fdm::gpu::transport::spin::build_checkpoint(
              data, spin_data, &payload)
        : fullmag::fdm::gpu::transport::charge::build_checkpoint(&data, &payload);
    if (!built || payload.size() != request->exact_capacity)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    std::memcpy(reinterpret_cast<void *>(static_cast<uintptr_t>(destination->address)),
                payload.data(), payload.size());
    result->committed_bytes = payload.size();
    fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
        payload.data(), payload.size(), result->payload_sha256);
    std::memcpy(result->snapshot_digest,
                include_spin ? spin_data.snapshot_digest.data()
                             : data.snapshot_digest.data(), 32);
    if (include_spin) {
        std::memcpy(result->spin_digest, spin_data.spin_digest.data(), 32);
        std::memcpy(result->warm_start_digest,
                    spin_data.warm_start_digest.data(), 32);
    } else {
        std::memset(result->spin_digest, 0, 32);
        fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
            data.potential.data(), data.potential.size() * sizeof(double),
            result->warm_start_digest);
    }
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
        copied_export_bytes, copied_export_count, 0, 0, snapshot.iterations,
        snapshot.candidate_digest.data());
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
    uint32_t checkpoint_kind = 0;
    if (fullmag_fdm_gpu_transport_checkpoint_validate_v1(
            payload, request->expected_bytes, &checkpoint_kind) !=
        FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
    const bool restore_spin = checkpoint_kind ==
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_SPIN;
    fullmag::fdm::gpu::transport::spin::SpinCheckpointData spin_data{};
    if (restore_spin && !fullmag::fdm::gpu::transport::spin::parse_checkpoint(
            payload, request->expected_bytes, &spin_data))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE;
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
    if (restore_spin &&
        (parent.enabled_features & FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN) == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (!reserve_telemetry_sequences(parent, 5))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    bool interface_identity_matches =
        data.interface_source_ids.size() == parent.interface_source_ids.size();
    std::vector<double> from_trace(parent.interface_source_ids.size());
    std::vector<double> to_trace(parent.interface_source_ids.size());
    std::vector<double> delta_trace(parent.interface_source_ids.size());
    std::vector<double> current_density(parent.interface_source_ids.size());
    std::vector<uint8_t> consumed(data.interface_source_ids.size(), 0);
    for (size_t i = 0; interface_identity_matches && i < parent.interface_source_ids.size(); ++i) {
        size_t found = data.interface_source_ids.size();
        for (size_t j = 0; j < data.interface_source_ids.size(); ++j) {
            if (!consumed[j] && data.interface_source_ids[j] == parent.interface_source_ids[i] &&
                data.interface_topology_ids[j] == parent.interface_topology_ids[i]) {
                found = j;
                break;
            }
        }
        if (found == data.interface_source_ids.size() ||
            data.interface_axes[found] != parent.interface_axes[i] ||
            data.interface_face_linear[found] != parent.interface_face_linear[i] ||
            data.interface_negative_cells[found] != parent.interface_negative_cells[i] ||
            data.interface_positive_cells[found] != parent.interface_positive_cells[i] ||
            data.interface_from_cells[found] != parent.interface_from_cells[i] ||
            data.interface_to_cells[found] != parent.interface_to_cells[i] ||
            data.interface_orientations[found] != parent.interface_orientations[i]) {
            interface_identity_matches = false;
            break;
        }
        consumed[found] = 1;
        from_trace[i] = data.interface_from_trace_v[found];
        to_trace[i] = data.interface_to_trace_v[found];
        delta_trace[i] = data.interface_delta_trace_v[found];
        current_density[i] = data.interface_charge_current_density[found];
    }
    if (interface_identity_matches) {
        data.interface_from_trace_v = std::move(from_trace);
        data.interface_to_trace_v = std::move(to_trace);
        data.interface_delta_trace_v = std::move(delta_trace);
        data.interface_charge_current_density = std::move(current_density);
        populate_checkpoint_interface_identity(parent, &data);
    }
    const bool spin_identity_matches = !restore_spin ||
        (spin_data.source_revision == parent.source_revision &&
         spin_data.operator_revision == parent.spin_operator_revision &&
         spin_data.preconditioner_revision == parent.spin_preconditioner_revision &&
         spin_data.interface_source_ids == parent.interface_source_ids &&
         spin_data.interface_topology_ids == parent.interface_topology_ids &&
         spin_data.interface_axes == parent.interface_axes &&
         spin_data.interface_face_linear == parent.interface_face_linear &&
         spin_data.interface_negative_cells == parent.interface_negative_cells &&
         spin_data.interface_positive_cells == parent.interface_positive_cells &&
         spin_data.interface_from_cells == parent.interface_from_cells &&
         spin_data.interface_to_cells == parent.interface_to_cells &&
         spin_data.interface_orientations == parent.interface_orientations);
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
        data.charge_source_ids != parent.charge_source_ids || !interface_identity_matches ||
        !spin_identity_matches ||
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
    restored.interface_count = data.interface_from_trace_v.size();
    fullmag::fdm::gpu::transport::charge::SolveInput static_input{};
    static_input.grid = parent.grid; static_input.cell_size = parent.cell_size;
    static_input.payloads = parent.static_payload_device; static_input.views = parent.static_views_host;
    static_input.stream = parent.stream;
    CudaFailurePolicy failure_policy{parent.test_failure_boundary, 0};
    static_input.failure_policy = &failure_policy;
    const uint64_t import_bytes =
        (data.potential.size() + data.jx.size() + data.jy.size() + data.jz.size() +
         4 * restored.interface_count) *
        sizeof(double);
    const std::array<AuditBoundary, 5> import_boundaries{{
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION, 0, 1},
        {FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
         FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER, import_bytes,
         UINT64_C(4) + (restored.interface_count == 0 ? UINT64_C(0) : UINT64_C(4))},
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
        !allocate_and_copy(&restored.jz, data.jz) ||
        (restored.interface_count != 0 &&
         (!allocate_and_copy(&restored.interface_from_trace_v, data.interface_from_trace_v) ||
          !allocate_and_copy(&restored.interface_to_trace_v, data.interface_to_trace_v) ||
          !allocate_and_copy(&restored.interface_delta_trace_v, data.interface_delta_trace_v) ||
          !allocate_and_copy(&restored.interface_charge_current_density,
                             data.interface_charge_current_density)))) {
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
    status = accepted_charge_content_digest(
        parent, restored, data.accepted_sequence, data.lineage, data.iterations,
        data.component_balance, data.physical_residual, &restored_digest,
        &failure_policy, 43, 44);
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
    const std::array<uint8_t, 32> checkpoint_snapshot_digest =
        restore_spin ? spin_data.snapshot_digest : data.snapshot_digest;
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK ||
        (!restore_spin && restored_digest != data.snapshot_digest)) {
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
    if (restore_spin) data.snapshot_digest = restored_digest;
    SpinBuffers restored_spin{};
    if (restore_spin) {
        status = materialize_spin_checkpoint_from_host(parent, spin_data,
                                                       &restored_spin);
        if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
            release_charge_buffers(restored);
            return status;
        }
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
        if (restore_spin) {
            snapshot.spin_accepted = restored_spin;
            snapshot.spin_iterations = spin_data.iterations;
            snapshot.spin_work_budget = spin_data.work_budget;
            snapshot.spin_convergence_reason = spin_data.convergence_reason;
            snapshot.spin_local_balance = spin_data.local_balance;
            snapshot.spin_global_balance = spin_data.global_balance;
            snapshot.spin_interface_balance = spin_data.interface_balance;
            snapshot.spin_torque_balance = spin_data.torque_balance;
            snapshot.spin_deterministic_compute_digest =
                spin_data.deterministic_compute_digest;
            parent.spin_hierarchy_digest = {};
            if (spin_data.deterministic_reduction_state.size() >= 32)
                std::copy_n(spin_data.deterministic_reduction_state.begin(), 32,
                            parent.spin_hierarchy_digest.begin());
        }
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
        std::memcpy(result->snapshot_content_digest,
                    checkpoint_snapshot_digest.data(), 32);
        if (restore_spin) {
            std::memcpy(result->spin_digest, spin_data.spin_digest.data(), 32);
            std::memcpy(result->warm_start_digest,
                        spin_data.warm_start_digest.data(), 32);
        } else {
            std::memset(result->spin_digest, 0, 32);
            fullmag::fdm::gpu::transport::charge::checkpoint_sha256(
                data.potential.data(), data.potential.size() * sizeof(double),
                result->warm_start_digest);
        }
        result->audit_sequence = parent.telemetry_sequence;
        result->restored_state = restore_spin
            ? FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED
            : FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_CHARGE_ACCEPTED;
        std::memcpy(result->operation_audit_digest,
                    parent.operation_audit_digest.data(), 32);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    }
    release_spin_buffers(restored_spin);
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
        (boundary >= 40 && boundary <= 44) || boundary == 60 ||
        (boundary >= 70 && boundary <= 71);
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
    if (!append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED,
            sizeof(*destination), 1, 0, 0, 0, nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
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
    if (!append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED,
            destination_bytes, 1, 0, 0, 0, nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
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
        if (parent.generation == slot.parent_generation &&
            (parent.spin_solve_active ||
             (parent.llg_binding_owner_id != 0 &&
              parent.llg_binding_snapshot_slot == snapshot.slot &&
              parent.llg_binding_snapshot_generation == snapshot.generation))) {
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
        }
        if (parent.device >= 0) (void)cudaSetDevice(parent.device);
        if (parent.generation == slot.parent_generation && parent.live_snapshots != 0)
            --parent.live_snapshots;
    }
    release_charge_buffers(slot.accepted);
    release_spin_buffers(slot.spin_accepted);
    release_spin_buffers(slot.spin_trial);
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

extern "C" uint32_t
fullmag_fdm_gpu_transport_test_accept_zero_charge_snapshot_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag_fdm_gpu_charge_snapshot_info_v1 *snapshot_info) {
    if (snapshot_info == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &parent = slots[context.slot];
    if (!same(context, context.slot, parent.generation) || !parent.active ||
        !parent.static_uploaded)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (cudaSetDevice(parent.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    const uint64_t cells = parent.grid[0] * parent.grid[1] * parent.grid[2];
    const uint64_t jx_count = (parent.grid[0] + 1) * parent.grid[1] * parent.grid[2];
    const uint64_t jy_count = parent.grid[0] * (parent.grid[1] + 1) * parent.grid[2];
    const uint64_t jz_count = parent.grid[0] * parent.grid[1] * (parent.grid[2] + 1);
    fullmag::fdm::gpu::transport::charge::SolveInput static_input{};
    static_input.grid = parent.grid;
    static_input.cell_size = parent.cell_size;
    static_input.payloads = parent.static_payload_device;
    static_input.views = parent.static_views_host;
    static_input.stream = parent.stream;
    for (size_t index = 0; index < slots.size(); ++index) {
        Slot &snapshot = slots[index];
        if (snapshot.active || snapshot.generation == UINT64_MAX) continue;
        ChargeBuffers accepted{};
        accepted.cells = cells;
        accepted.jx_count = jx_count;
        accepted.jy_count = jy_count;
        accepted.jz_count = jz_count;
        accepted.interface_count = 0;
        auto allocate_zero_device = [&](void **pointer, uint64_t bytes) {
            return bytes == 0 ||
                (cudaMalloc(pointer, bytes) == cudaSuccess &&
                 cudaMemsetAsync(*pointer, 0, bytes, parent.stream) == cudaSuccess);
        };
        if (fullmag::fdm::gpu::transport::charge::materialize_static_state(
                static_input, &accepted) != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK ||
            !allocate_zero_device(reinterpret_cast<void **>(&accepted.potential),
                                  cells * sizeof(double)) ||
            !allocate_zero_device(reinterpret_cast<void **>(&accepted.jx),
                                  jx_count * sizeof(double)) ||
            !allocate_zero_device(reinterpret_cast<void **>(&accepted.jy),
                                  jy_count * sizeof(double)) ||
            !allocate_zero_device(reinterpret_cast<void **>(&accepted.jz),
                                  jz_count * sizeof(double)) ||
            cudaStreamSynchronize(parent.stream) != cudaSuccess) {
            release_charge_buffers(accepted);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
        }
        constexpr uint64_t accepted_sequence = 1;
        std::array<uint8_t, 16> lineage{};
        lineage[0] = 1;
        std::array<uint8_t, 32> content_digest{};
        const uint32_t digest_status = accepted_charge_content_digest(
            parent, accepted, accepted_sequence, lineage, 0, 0.0, 0.0,
            &content_digest);
        if (digest_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
            release_charge_buffers(accepted);
            return digest_status;
        }
        ++snapshot.generation;
        snapshot.active = true;
        snapshot.tombstone = false;
        snapshot.type_tag = kSnapshotTag;
        snapshot.parent_slot = context.slot;
        snapshot.parent_generation = context.generation;
        snapshot.accepted_sequence = accepted_sequence;
        snapshot.accepted = accepted;
        snapshot.candidate_digest = content_digest;
        snapshot.snapshot_lineage = lineage;
        ++parent.live_snapshots;
        *snapshot_info = {};
        snapshot_info->abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
        snapshot_info->struct_version = 1;
        snapshot_info->struct_size = sizeof(*snapshot_info);
        snapshot_info->required_features =
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
        snapshot_info->snapshot_handle =
            {kCookie, index, snapshot.generation, kSnapshotTag};
        snapshot_info->accepted_sequence = snapshot.accepted_sequence;
        snapshot_info->source_revision = parent.source_revision;
        snapshot_info->operator_revision = parent.descriptor_revision;
        std::memcpy(snapshot_info->snapshot_content_digest,
                    snapshot.candidate_digest.data(), 32);
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

extern "C" uint32_t fullmag_fdm_gpu_transport_test_charge_hierarchy_readback_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *aggregate, uint64_t aggregate_count,
    double *coarse_diagonal, uint64_t coarse_count,
    double *structured_edge_weight, uint64_t edge_count) {
    if (aggregate == nullptr || coarse_diagonal == nullptr ||
        structured_edge_weight == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        !slot.hierarchy_cache.valid || aggregate_count != slot.hierarchy_cache.cells ||
        coarse_count != slot.hierarchy_cache.coarse_cells)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const uint64_t coarse_nx = (slot.grid[0] + 1) / 2;
    const uint64_t coarse_ny = (slot.grid[1] + 1) / 2;
    const uint64_t coarse_nz = (slot.grid[2] + 1) / 2;
    const uint64_t expected_edges =
        (coarse_nx > 1 ? (coarse_nx - 1) * coarse_ny * coarse_nz : 0) +
        (coarse_ny > 1 ? coarse_nx * (coarse_ny - 1) * coarse_nz : 0) +
        (coarse_nz > 1 ? coarse_nx * coarse_ny * (coarse_nz - 1) : 0);
    if (edge_count != expected_edges || cudaSetDevice(slot.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (cudaMemcpy(aggregate, slot.hierarchy_cache.aggregate,
                   aggregate_count * sizeof(uint64_t), cudaMemcpyDeviceToHost) != cudaSuccess ||
        cudaMemcpy(coarse_diagonal, slot.hierarchy_cache.coarse_diag,
                   coarse_count * sizeof(double), cudaMemcpyDeviceToHost) != cudaSuccess ||
        cudaMemcpy(structured_edge_weight, slot.hierarchy_cache.coarse_edge_weight,
                   edge_count * sizeof(double), cudaMemcpyDeviceToHost) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (!append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED,
            aggregate_count * sizeof(uint64_t) + coarse_count * sizeof(double) +
                edge_count * sizeof(double),
            3, 0, 0, 0, nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_charge_warm_start_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint64_t *promotion_count,
    uint64_t *use_count, uint64_t *cells, uint64_t *descriptor_revision,
    uint64_t *source_revision, uint32_t *valid) {
    if (promotion_count == nullptr || use_count == nullptr || cells == nullptr ||
        descriptor_revision == nullptr || source_revision == nullptr || valid == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const ChargeHierarchyCache &cache = slot.hierarchy_cache;
    *promotion_count = cache.warm_promotion_count;
    *use_count = cache.warm_use_count;
    *cells = cache.cells;
    *descriptor_revision = cache.warm_descriptor_revision;
    *source_revision = cache.warm_source_revision;
    *valid = cache.warm_valid ? 1u : 0u;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_charge_warm_start_readback_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, double *potential,
    uint64_t count) {
    if (potential == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    const ChargeHierarchyCache &cache = slot.hierarchy_cache;
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        !cache.warm_valid || cache.warm_potential == nullptr || count != cache.cells ||
        count > UINT64_MAX / sizeof(double))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    if (cudaSetDevice(slot.device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (cudaMemcpy(potential, cache.warm_potential, count * sizeof(double),
                   cudaMemcpyDeviceToHost) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (!append_charge_telemetry(
            slot, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_ARTIFACT_READBACK_D2H,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
            FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER |
                FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_CADENCE_AUTHORIZED,
            count * sizeof(double), 1, 0, 0, 0, nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_spin_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *hierarchy_build_count, uint64_t *hierarchy_cache_hit_count,
    uint64_t *amg_apply_count, uint64_t *host_fallback_count,
    uint64_t *fine_unknown_count, uint64_t *coarse_unknown_count,
    uint32_t *hierarchy_levels, uint8_t hierarchy_digest[32],
    uint64_t *accepted_commit_count, uint64_t *failed_rollback_count) {
    if (hierarchy_build_count == nullptr || hierarchy_cache_hit_count == nullptr ||
        amg_apply_count == nullptr || host_fallback_count == nullptr ||
        fine_unknown_count == nullptr || coarse_unknown_count == nullptr ||
        hierarchy_levels == nullptr || hierarchy_digest == nullptr ||
        accepted_commit_count == nullptr || failed_rollback_count == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    *hierarchy_build_count = slot.spin_hierarchy_build_count;
    *hierarchy_cache_hit_count = slot.spin_hierarchy_cache_hit_count;
    *amg_apply_count = slot.spin_amg_apply_count;
    *host_fallback_count = 0;
    *fine_unknown_count = slot.spin_fine_unknown_count;
    *coarse_unknown_count = slot.spin_coarse_unknown_count;
    *hierarchy_levels = slot.spin_hierarchy_levels;
    std::memcpy(hierarchy_digest, slot.spin_hierarchy_digest.data(), 32);
    *accepted_commit_count = slot.spin_accepted_commit_count;
    *failed_rollback_count = slot.spin_failed_rollback_count;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_fail_llg_stage_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t attempt_id, uint64_t stage_id) {
    if (attempt_id == 0 || stage_id == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        slot.llg_binding_owner_id == 0 || slot.llg_step_transaction_active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.test_fail_llg_attempt_id = attempt_id;
    slot.test_fail_llg_stage_id = stage_id;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_llg_completion_fault_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t boundary) {
    if (boundary < 1 || boundary > 5)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        slot.llg_binding_owner_id == 0 || slot.llg_step_transaction_active ||
        slot.llg_torque_in_flight)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.test_llg_completion_fault = boundary;
    slot.test_llg_hold_state.store(0, std::memory_order_release);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_retry_llg_drain_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context) {
    cudaStream_t stream = nullptr;
    int device = -1;
    {
        std::lock_guard<std::mutex> lock(registry_mutex);
        if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
            context.slot >= slots.size())
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
        Slot &slot = slots[context.slot];
        if (!same(context, context.slot, slot.generation) || !slot.active ||
            !slot.llg_torque_in_flight)
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
        stream = slot.stream;
        device = slot.device;
    }
    if (cudaSetDevice(device) != cudaSuccess ||
        cudaStreamSynchronize(stream) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        !slot.llg_torque_in_flight)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.llg_torque_in_flight = false;
    if (slot.llg_step_transaction_active &&
        slot.llg_binding_snapshot_slot < slots.size()) {
        Slot &snapshot = slots[slot.llg_binding_snapshot_slot];
        if (snapshot.active &&
            snapshot.generation == slot.llg_binding_snapshot_generation) {
            release_spin_buffers(snapshot.spin_trial);
            release_spin_sparse_state(slot.spin_sparse_state);
            ++slot.spin_failed_rollback_count;
            slot.llg_step_transaction_active = false;
            slot.llg_step_attempt_id = 0;
            slot.llg_step_has_stage_time = false;
            slot.llg_step_last_stage_time = 0.0;
            reset_spin_trial_metadata(slot);
        }
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_llg_hold_state_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t *reached) {
    if (reached == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    *reached = slot.test_llg_hold_state.load(std::memory_order_acquire);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_release_llg_hold_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active ||
        slot.test_llg_hold_state.load(std::memory_order_acquire) != 1)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    slot.test_llg_hold_state.store(2, std::memory_order_release);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_spin_memory_plan_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag::fdm::gpu::transport::spin::memory::Plan *plan) {
    if (plan == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    *plan = slot.spin_memory_plan;
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

namespace fullmag::fdm {
namespace {

bool ensure_llg_binding_storage(Slot &slot, uint64_t cells) {
    if (slot.llg_cells == cells && slot.llg_m_stage != nullptr &&
        slot.llg_torque != nullptr && slot.llg_m_ready != nullptr &&
        slot.llg_torque_ready != nullptr) {
        return true;
    }
    release_llg_binding_storage(slot);
    if (cells == 0 || cells > UINT64_MAX / (6 * sizeof(double))) return false;
    const uint64_t owned_bytes = 6 * cells * sizeof(double);
    if (slot.allocator_limit != 0 && owned_bytes > slot.allocator_limit) return false;
    const size_t vector_bytes = static_cast<size_t>(3 * cells * sizeof(double));
    if (cudaMalloc(reinterpret_cast<void **>(&slot.llg_m_stage), vector_bytes) !=
            cudaSuccess ||
        cudaMalloc(reinterpret_cast<void **>(&slot.llg_torque), vector_bytes) !=
            cudaSuccess ||
        cudaEventCreateWithFlags(&slot.llg_m_ready, cudaEventDisableTiming) !=
            cudaSuccess ||
        cudaEventCreateWithFlags(&slot.llg_torque_ready, cudaEventDisableTiming) !=
            cudaSuccess) {
        release_llg_binding_storage(slot);
        return false;
    }
    slot.llg_cells = cells;
    return true;
}

bool device_field_matches(const DeviceVectorField &field, int device) {
    const void *pointers[3] = {field.x, field.y, field.z};
    for (const void *pointer : pointers) {
        cudaPointerAttributes attributes{};
        if (pointer == nullptr || cudaPointerGetAttributes(&attributes, pointer) !=
                cudaSuccess ||
            attributes.type != cudaMemoryTypeDevice || attributes.device != device) {
            return false;
        }
    }
    return true;
}

bool import_transport_receipt_telemetry(
    Context &ctx,
    const Slot &slot)
{
    auto &receipt = *ctx.execution_receipt;
    std::lock_guard<std::mutex> lock(receipt.accounting_mutex);
    for (uint64_t index = 0; index < slot.telemetry_count; ++index) {
        const auto &record = slot.telemetry[index];
        if (record.audit_sequence <= receipt.transport_telemetry_cursor) continue;
        if (!fullmag_fdm_accept_transport_telemetry_sequence_locked(
                receipt, record.audit_sequence)) {
            ctx.last_error = "GPU transport telemetry sequence has a gap";
            return false;
        }
        if (record.status != FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS) {
            continue;
        }
        switch (fullmag_fdm_classify_transport_telemetry(record)) {
            case TransportReceiptCategory::Ignore:
            case TransportReceiptCategory::ObservationHostSync:
                break;
            case TransportReceiptCategory::SetupH2D:
                fullmag_fdm_checked_add(
                    receipt, receipt.setup_full_vector_h2d_count, record.count);
                fullmag_fdm_checked_add(
                    receipt, receipt.setup_full_vector_h2d_bytes, record.bytes);
                break;
            case TransportReceiptCategory::ScalarD2H:
                fullmag_fdm_checked_add(
                    receipt, ctx.hot_loop_d2h_bytes, record.bytes);
                fullmag_fdm_checked_add(
                    receipt, ctx.hot_loop_control_scalar_d2h_bytes, record.bytes);
                break;
            case TransportReceiptCategory::SolverHotLoopH2D:
                fullmag_fdm_checked_add(
                    receipt, receipt.hot_loop_full_vector_h2d_count, record.count);
                fullmag_fdm_checked_add(
                    receipt, receipt.hot_loop_full_vector_h2d_bytes, record.bytes);
                break;
            case TransportReceiptCategory::SolverHotLoopD2H:
                fullmag_fdm_checked_add(
                    receipt, receipt.hot_loop_full_vector_d2h_count, record.count);
                fullmag_fdm_checked_add(
                    receipt, receipt.hot_loop_full_vector_d2h_bytes, record.bytes);
                break;
            case TransportReceiptCategory::ScalarHostSync:
                fullmag_fdm_checked_add(
                    receipt, ctx.hot_loop_host_sync_count, record.count);
                fullmag_fdm_checked_add(
                    receipt, ctx.hot_loop_control_scalar_host_sync_count, record.count);
                break;
            case TransportReceiptCategory::ObservationH2D:
                fullmag_fdm_checked_add(
                    receipt, receipt.observation_full_vector_h2d_count, record.count);
                fullmag_fdm_checked_add(
                    receipt, receipt.observation_full_vector_h2d_bytes, record.bytes);
                break;
            case TransportReceiptCategory::ObservationD2H:
                fullmag_fdm_checked_add(
                    receipt, receipt.observation_full_vector_d2h_count, record.count);
                fullmag_fdm_checked_add(
                    receipt, receipt.observation_full_vector_d2h_bytes, record.bytes);
                break;
            case TransportReceiptCategory::DeviceExecution:
                receipt.required_operator_mask |= FULLMAG_FDM_OPERATOR_GPU_TRANSPORT;
                receipt.pending_device_operator_mask |= FULLMAG_FDM_OPERATOR_GPU_TRANSPORT;
                break;
            case TransportReceiptCategory::Invalid:
                receipt.accounting_valid = false;
                ctx.last_error = "GPU transport telemetry reason/flags mismatch";
                return false;
        }
    }
    return receipt.accounting_valid;
}

bool evaluate_bound_gpu_transport_rhs(
    Context &ctx,
    const DeviceVectorField &m_stage,
    double t_stage,
    uint64_t attempt_id,
    uint64_t stage_id,
    DeviceVectorField &torque_view)
{
    const auto binding = ctx.gpu_transport_rhs.descriptor;
    fullmag_fdm_gpu_transport_buffer_view_v1 m_view{};
    fullmag_fdm_gpu_transport_buffer_view_v1 torque_buffer_view{};
    {
        std::lock_guard<std::mutex> lock(registry_mutex);
        const auto &context = binding.transport_context;
        const auto &snapshot_handle = binding.charge_snapshot;
        if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
            context.slot >= slots.size() ||
            snapshot_handle.registry_cookie != kCookie ||
            snapshot_handle.type_tag != kSnapshotTag ||
            snapshot_handle.slot >= slots.size()) {
            ctx.last_error = "bound GPU transport handle is stale";
            return false;
        }
        Slot &parent = slots[context.slot];
        const Slot &snapshot = slots[snapshot_handle.slot];
        if (!same(context, context.slot, parent.generation) || !parent.active ||
            !snapshot.active || snapshot.generation != snapshot_handle.generation ||
            snapshot.parent_slot != context.slot ||
            snapshot.parent_generation != context.generation ||
            snapshot.accepted_sequence != binding.accepted_sequence ||
            parent.source_revision != binding.source_revision ||
            parent.spin_operator_revision != binding.operator_revision ||
            parent.grid[0] != ctx.nx || parent.grid[1] != ctx.ny ||
            parent.grid[2] != ctx.nz || parent.llg_cells != ctx.cell_count ||
            !device_field_matches(m_stage, parent.device)) {
            ctx.last_error = "bound GPU transport state no longer matches the LLG context";
            return false;
        }
        if (ctx.gpu_transport_owner_id == 0 ||
            parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
            parent.llg_binding_snapshot_slot != snapshot_handle.slot ||
            parent.llg_binding_snapshot_generation != snapshot_handle.generation ||
            parent.llg_torque_in_flight) {
            ctx.last_error = "GPU transport LLG binding ownership is not exclusive";
            return false;
        }
        if (!std::isfinite(t_stage) || !parent.llg_step_transaction_active ||
            parent.llg_step_attempt_id != attempt_id ||
            (parent.llg_step_has_stage_time &&
             t_stage < parent.llg_step_last_stage_time)) {
            ctx.last_error =
                "GPU transport LLG stage time or attempt ordering is invalid";
            return false;
        }
        parent.llg_step_has_stage_time = true;
        parent.llg_step_last_stage_time = t_stage;
        if (parent.test_fail_llg_attempt_id == attempt_id &&
            parent.test_fail_llg_stage_id == stage_id) {
            parent.test_fail_llg_attempt_id = 0;
            parent.test_fail_llg_stage_id = 0;
            ctx.last_error = "test-injected late GPU transport stage failure";
            return false;
        }
        if (cudaSetDevice(parent.device) != cudaSuccess ||
            cudaEventRecord(parent.llg_m_ready, context_compute_stream(ctx)) !=
                cudaSuccess ||
            cudaStreamWaitEvent(parent.stream, parent.llg_m_ready, 0) != cudaSuccess) {
            ctx.last_error = "failed to order LLG stage state before GPU transport solve";
            return false;
        }
        const size_t component_bytes =
            static_cast<size_t>(ctx.cell_count * sizeof(double));
        if (cudaMemcpyAsync(parent.llg_m_stage, m_stage.x, component_bytes,
                            cudaMemcpyDeviceToDevice, parent.stream) != cudaSuccess ||
            cudaMemcpyAsync(parent.llg_m_stage + ctx.cell_count, m_stage.y,
                            component_bytes, cudaMemcpyDeviceToDevice,
                            parent.stream) != cudaSuccess ||
            cudaMemcpyAsync(parent.llg_m_stage + 2 * ctx.cell_count, m_stage.z,
                            component_bytes, cudaMemcpyDeviceToDevice,
                            parent.stream) != cudaSuccess) {
            ctx.last_error = "failed to stage device-resident LLG magnetization";
            return false;
        }
        const uint64_t values = 3 * ctx.cell_count;
        m_view = {};
        m_view.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
        m_view.struct_version = 1;
        m_view.struct_size = sizeof(m_view);
        m_view.address = reinterpret_cast<uint64_t>(parent.llg_m_stage);
        m_view.element_count = values;
        m_view.byte_stride = sizeof(double);
        m_view.byte_length = values * sizeof(double);
        m_view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
        m_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY;
        m_view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
        torque_buffer_view = m_view;
        torque_buffer_view.address = reinterpret_cast<uint64_t>(parent.llg_torque);
        torque_buffer_view.pointer_space =
            FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY;
        parent.llg_torque_in_flight = true;
    }

    fullmag_fdm_gpu_steady_spin_solve_request_v1 request{};
    request.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    request.struct_version = 1;
    request.struct_size = sizeof(request);
    request.required_features = binding.required_features;
    request.context_handle = binding.transport_context;
    request.snapshot_handle = binding.charge_snapshot;
    request.accepted_sequence = binding.accepted_sequence;
    request.m_stage_view_ptr = reinterpret_cast<uint64_t>(&m_view);
    request.torque_view_ptr = reinterpret_cast<uint64_t>(&torque_buffer_view);
    request.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1;
    request.attempt_id = attempt_id;
    request.stage_id = stage_id;
    request.source_revision = binding.source_revision;
    request.operator_revision = binding.operator_revision;
    request.relative_tolerance = binding.relative_tolerance;
    request.max_iterations = binding.max_iterations;
    fullmag_fdm_gpu_steady_spin_solve_result_v1 result{};
    result.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    result.struct_version = 1;
    result.struct_size = sizeof(result);
    result.required_features = binding.required_features;
    const uint32_t status = fullmag_fdm_gpu_transport_solve_steady_spin_v1(
        &request, &result);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        cudaStream_t transport_stream = nullptr;
        int device = -1;
        {
            std::lock_guard<std::mutex> lock(registry_mutex);
            if (binding.transport_context.slot < slots.size()) {
                Slot &parent = slots[binding.transport_context.slot];
                if (same(binding.transport_context,
                         binding.transport_context.slot, parent.generation) &&
                    parent.active &&
                    parent.llg_binding_owner_id == ctx.gpu_transport_owner_id) {
                    transport_stream = parent.stream;
                    device = parent.device;
                }
            }
        }
        const bool drained = transport_stream != nullptr &&
            cudaSetDevice(device) == cudaSuccess &&
            cudaStreamSynchronize(transport_stream) == cudaSuccess;
        {
            std::lock_guard<std::mutex> lock(registry_mutex);
            if (binding.transport_context.slot < slots.size()) {
                Slot &parent = slots[binding.transport_context.slot];
                if (same(binding.transport_context,
                         binding.transport_context.slot, parent.generation) &&
                    parent.active &&
                    parent.llg_binding_owner_id == ctx.gpu_transport_owner_id &&
                    drained)
                    parent.llg_torque_in_flight = false;
            }
        }
        ctx.last_error = drained
            ? "GPU transport stage solve failed with status " +
                  std::to_string(status)
            : "GPU transport stage solve failed and its stream could not be drained";
        return false;
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto &context = binding.transport_context;
    if (context.slot >= slots.size()) {
        ctx.last_error = "bound GPU transport context disappeared after stage solve";
        return false;
    }
    Slot &parent = slots[context.slot];
    if (!same(context, context.slot, parent.generation) || !parent.active ||
        parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
        !parent.llg_torque_in_flight ||
        cudaSetDevice(parent.device) != cudaSuccess ||
        cudaEventRecord(parent.llg_torque_ready, parent.stream) != cudaSuccess ||
        cudaStreamWaitEvent(context_compute_stream(ctx), parent.llg_torque_ready, 0) !=
            cudaSuccess) {
        if (parent.llg_binding_owner_id == ctx.gpu_transport_owner_id)
            parent.llg_torque_in_flight = false;
        ctx.last_error = "failed to order GPU transport torque before LLG RHS";
        return false;
    }
    torque_view.x = parent.llg_torque;
    torque_view.y = parent.llg_torque + ctx.cell_count;
    torque_view.z = parent.llg_torque + 2 * ctx.cell_count;
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SOLVED_TRANSPORT_RHS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        0, 0, 1, attempt_id, stage_id, result.iterations,
        result.deterministic_compute_digest);
    if (!import_transport_receipt_telemetry(ctx, parent)) {
        parent.llg_torque_in_flight = false;
        return false;
    }
    ctx.gpu_transport_test_completion_fault = parent.test_llg_completion_fault;
    parent.test_llg_completion_fault = 0;
    ++parent.llg_stage_evaluation_count;
    return true;
}

} // namespace

bool context_bind_gpu_transport_rhs(
    Context &ctx,
    const fullmag_fdm_gpu_transport_llg_binding_v1 &binding)
{
    const uint32_t status = validate_prefix(
        binding.abi_version, binding.struct_version, binding.struct_size,
        sizeof(binding), binding.reserved_flags, binding.required_features,
        UINT64_C(0x1f), binding.reserved0);
    constexpr uint64_t required =
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;
    if (ctx.gpu_transport_rhs.active ||
        status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK || binding.reserved1 != 0 ||
        (binding.required_features & required) != required ||
        !std::isfinite(binding.relative_tolerance) ||
        binding.relative_tolerance <= 0.0 || binding.relative_tolerance >= 1.0 ||
        binding.max_iterations == 0 ||
        ctx.precision != FULLMAG_FDM_PRECISION_DOUBLE ||
        ctx.has_multilayer_plan_v2 ||
        (ctx.integrator != FULLMAG_FDM_INTEGRATOR_HEUN &&
         ctx.integrator != FULLMAG_FDM_INTEGRATOR_RK4 &&
         ctx.integrator != FULLMAG_FDM_INTEGRATOR_RK23 &&
         ctx.integrator != FULLMAG_FDM_INTEGRATOR_DP45 &&
         ctx.integrator != FULLMAG_FDM_INTEGRATOR_ABM3)) {
        ctx.last_error =
            "GPU transport LLG binding requires a supported single-grid FP64 "
            "explicit integrator";
        return false;
    }

    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto &context = binding.transport_context;
    const auto &snapshot_handle = binding.charge_snapshot;
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size() ||
        snapshot_handle.registry_cookie != kCookie ||
        snapshot_handle.type_tag != kSnapshotTag ||
        snapshot_handle.slot >= slots.size()) {
        ctx.last_error = "GPU transport LLG binding uses stale registry handles";
        return false;
    }
    Slot &parent = slots[context.slot];
    const Slot &snapshot = slots[snapshot_handle.slot];
    const uint64_t enabled_required = required | binding.required_features;
    if (!same(context, context.slot, parent.generation) || !parent.active ||
        !parent.static_uploaded || !snapshot.active ||
        snapshot.generation != snapshot_handle.generation ||
        snapshot.parent_slot != context.slot ||
        snapshot.parent_generation != context.generation ||
        snapshot.accepted_sequence != binding.accepted_sequence ||
        parent.source_revision != binding.source_revision ||
        parent.spin_operator_revision != binding.operator_revision ||
        parent.llg_binding_owner_id != 0 ||
        (parent.enabled_features & enabled_required) != enabled_required ||
        parent.grid[0] != ctx.nx || parent.grid[1] != ctx.ny ||
        parent.grid[2] != ctx.nz ||
        cudaSetDevice(parent.device) != cudaSuccess ||
        !device_field_matches(ctx.m, parent.device) ||
        !ensure_llg_binding_storage(parent, ctx.cell_count)) {
        ctx.last_error =
            "GPU transport descriptor, snapshot, grid, or device does not match LLG";
        return false;
    }
    if (!import_transport_receipt_telemetry(ctx, parent)) return false;
    if (ctx.gpu_transport_owner_id == 0) {
        if (next_llg_binding_owner_id == 0) ++next_llg_binding_owner_id;
        ctx.gpu_transport_owner_id = next_llg_binding_owner_id++;
    }
    parent.llg_binding_owner_id = ctx.gpu_transport_owner_id;
    parent.llg_binding_snapshot_slot = snapshot_handle.slot;
    parent.llg_binding_snapshot_generation = snapshot_handle.generation;
    parent.llg_torque_in_flight = false;
    ctx.gpu_transport_rhs.descriptor = binding;
    ctx.gpu_transport_rhs.evaluate = &evaluate_bound_gpu_transport_rhs;
    ctx.gpu_transport_rhs.torque_view = {};
    ctx.gpu_transport_rhs.active = true;
    ctx.last_error.clear();
    return true;
}

bool context_unbind_gpu_transport_rhs(Context &ctx) {
    if (!ctx.gpu_transport_rhs.active) return false;
    // Unit-level evaluators do not own a transport registry Slot.  Public
    // bindings always receive a non-zero owner id in context_bind above.
    if (ctx.gpu_transport_owner_id == 0) {
        ctx.gpu_transport_rhs = {};
        return true;
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto context = ctx.gpu_transport_rhs.descriptor.transport_context;
    if (context.slot >= slots.size()) return false;
    Slot &parent = slots[context.slot];
    if (!same(context, context.slot, parent.generation) || !parent.active ||
        parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
        parent.llg_torque_in_flight || parent.llg_step_transaction_active ||
        parent.spin_solve_active) {
        return false;
    }
    parent.llg_binding_owner_id = 0;
    parent.llg_binding_snapshot_slot = UINT64_MAX;
    parent.llg_binding_snapshot_generation = 0;
    ctx.gpu_transport_rhs = {};
    return true;
}

bool context_begin_gpu_transport_step(Context &ctx, uint64_t attempt_id) {
    if (!ctx.gpu_transport_rhs.active || ctx.gpu_transport_owner_id == 0)
        return true;
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto binding = ctx.gpu_transport_rhs.descriptor;
    if (binding.transport_context.slot >= slots.size() ||
        binding.charge_snapshot.slot >= slots.size()) return false;
    Slot &parent = slots[binding.transport_context.slot];
    Slot &snapshot = slots[binding.charge_snapshot.slot];
    if (!same(binding.transport_context, binding.transport_context.slot,
              parent.generation) || !parent.active ||
        parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
        parent.llg_step_transaction_active || parent.llg_torque_in_flight ||
        !snapshot.active ||
        snapshot.generation != binding.charge_snapshot.generation) {
        return false;
    }
    release_spin_buffers(snapshot.spin_trial);
    reset_spin_trial_metadata(parent);
    parent.llg_step_transaction_active = true;
    parent.llg_step_attempt_id = attempt_id;
    parent.llg_step_has_stage_time = false;
    parent.llg_step_last_stage_time = 0.0;
    return true;
}

bool context_retry_gpu_transport_step(Context &ctx) {
    if (!ctx.gpu_transport_rhs.active) return true;
    if (ctx.gpu_transport_attempt_generation == UINT64_MAX) {
        ctx.last_error = "bound spin-transport attempt identity exhausted";
        return false;
    }
    // Unit-level controlled evaluators have no registry owner, but still use
    // the same monotonic attempt identity contract as public bindings.
    if (ctx.gpu_transport_owner_id == 0) {
        ctx.gpu_transport_active_attempt_id =
            ++ctx.gpu_transport_attempt_generation;
        return true;
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto binding = ctx.gpu_transport_rhs.descriptor;
    if (binding.transport_context.slot >= slots.size() ||
        binding.charge_snapshot.slot >= slots.size()) return false;
    Slot &parent = slots[binding.transport_context.slot];
    Slot &snapshot = slots[binding.charge_snapshot.slot];
    if (!same(binding.transport_context, binding.transport_context.slot,
              parent.generation) || !parent.active ||
        parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
        !parent.llg_step_transaction_active || parent.llg_torque_in_flight ||
        parent.spin_solve_active || !snapshot.active ||
        snapshot.generation != binding.charge_snapshot.generation) {
        return false;
    }
    release_spin_buffers(snapshot.spin_trial);
    release_spin_sparse_state(parent.spin_sparse_state);
    ++parent.spin_failed_rollback_count;
    reset_spin_trial_metadata(parent);
    parent.test_last_retry_sparse_state_empty =
        spin_sparse_state_empty(parent.spin_sparse_state);
    parent.test_last_retry_trial_metadata_empty =
        spin_trial_metadata_empty(parent);
    const uint64_t attempt_id = ++ctx.gpu_transport_attempt_generation;
    ctx.gpu_transport_active_attempt_id = attempt_id;
    parent.llg_step_attempt_id = attempt_id;
    parent.llg_step_has_stage_time = false;
    parent.llg_step_last_stage_time = 0.0;
    return true;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_retry_reset_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *sparse_release_count, uint64_t *trial_reset_count)
{
    if (sparse_release_count == nullptr || trial_reset_count == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (context.registry_cookie != kCookie || context.type_tag != kContextTag ||
        context.slot >= slots.size())
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    const Slot &slot = slots[context.slot];
    if (!same(context, context.slot, slot.generation) || !slot.active)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    *sparse_release_count = slot.test_last_retry_sparse_state_empty ? 1 : 0;
    *trial_reset_count = slot.test_last_retry_trial_metadata_empty ? 1 : 0;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

bool context_commit_gpu_transport_step(Context &ctx) {
    if (!ctx.gpu_transport_rhs.active) {
        ctx.gpu_transport_active_attempt_id = 0;
        return true;
    }
    if (ctx.gpu_transport_owner_id == 0) {
        ctx.gpu_transport_active_attempt_id = 0;
        return true;
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto binding = ctx.gpu_transport_rhs.descriptor;
    if (binding.transport_context.slot >= slots.size() ||
        binding.charge_snapshot.slot >= slots.size()) return false;
    Slot &parent = slots[binding.transport_context.slot];
    Slot &snapshot = slots[binding.charge_snapshot.slot];
    if (parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
        !parent.llg_step_transaction_active || parent.llg_torque_in_flight ||
        !snapshot.active || snapshot.spin_trial.owned_bytes == 0) return false;
    release_spin_buffers(snapshot.spin_accepted);
    snapshot.spin_accepted = snapshot.spin_trial;
    snapshot.spin_trial = {};
    ++parent.spin_accepted_commit_count;
    parent.spin_hierarchy_build_count += parent.spin_trial_hierarchy_build_count;
    parent.spin_hierarchy_cache_hit_count += parent.spin_trial_hierarchy_cache_hit_count;
    parent.spin_amg_apply_count += parent.spin_trial_amg_apply_count;
    parent.spin_fine_unknown_count = parent.spin_trial_fine_unknown_count;
    parent.spin_coarse_unknown_count = parent.spin_trial_coarse_unknown_count;
    parent.spin_hierarchy_levels = parent.spin_trial_hierarchy_levels;
    parent.spin_hierarchy_digest = parent.spin_trial_hierarchy_digest;
    snapshot.spin_iterations = parent.spin_trial_iterations;
    snapshot.spin_work_budget = parent.spin_trial_work_budget;
    snapshot.spin_convergence_reason = parent.spin_trial_convergence_reason;
    snapshot.spin_local_balance = parent.spin_trial_local_balance;
    snapshot.spin_global_balance = parent.spin_trial_global_balance;
    snapshot.spin_interface_balance = parent.spin_trial_interface_balance;
    snapshot.spin_torque_balance = parent.spin_trial_torque_balance;
    snapshot.spin_deterministic_compute_digest = parent.spin_trial_compute_digest;
    parent.llg_step_transaction_active = false;
    parent.llg_step_attempt_id = 0;
    parent.llg_step_has_stage_time = false;
    parent.llg_step_last_stage_time = 0.0;
    reset_spin_trial_metadata(parent);
    ctx.gpu_transport_active_attempt_id = 0;
    return true;
}

bool context_rollback_gpu_transport_step(Context &ctx) {
    if (!ctx.gpu_transport_rhs.active) {
        ctx.gpu_transport_active_attempt_id = 0;
        return true;
    }
    if (ctx.gpu_transport_owner_id == 0) {
        ctx.gpu_transport_active_attempt_id = 0;
        return true;
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto binding = ctx.gpu_transport_rhs.descriptor;
    if (binding.transport_context.slot >= slots.size() ||
        binding.charge_snapshot.slot >= slots.size()) return false;
    Slot &parent = slots[binding.transport_context.slot];
    Slot &snapshot = slots[binding.charge_snapshot.slot];
    if (parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
        !parent.llg_step_transaction_active || parent.llg_torque_in_flight ||
        !snapshot.active) return false;
    release_spin_buffers(snapshot.spin_trial);
    // Sparse operator/hierarchy/workspace state is mutated while solving trial
    // stages.  It is not accepted scientific state, so a rejected outer step
    // discards it explicitly; retry rebuilds from the accepted snapshot.
    release_spin_sparse_state(parent.spin_sparse_state);
    ++parent.spin_failed_rollback_count;
    parent.llg_step_transaction_active = false;
    parent.llg_step_attempt_id = 0;
    parent.llg_step_has_stage_time = false;
    parent.llg_step_last_stage_time = 0.0;
    reset_spin_trial_metadata(parent);
    ctx.gpu_transport_active_attempt_id = 0;
    return true;
}

bool context_evaluate_gpu_transport_rhs(
    Context &ctx,
    const DeviceVectorField &m_stage,
    double t_stage,
    uint64_t attempt_id,
    uint64_t stage_id)
{
    if (!ctx.gpu_transport_rhs.active) {
        ctx.gpu_transport_rhs.torque_view = {};
        return true;
    }
    if (ctx.gpu_transport_rhs.evaluate == nullptr) {
        ctx.last_error = "GPU transport RHS binding has no evaluator";
        return false;
    }
    if (!context_begin_compute_stream_work(ctx, "GPU transport m_stage"))
        return false;
    DeviceVectorField torque_view{};
    if (!ctx.gpu_transport_rhs.evaluate(
            ctx, m_stage, t_stage, attempt_id, stage_id, torque_view)) {
        if (ctx.last_error.empty())
            ctx.last_error = "GPU transport RHS evaluator rejected the stage";
        return false;
    }
    if (torque_view.x == nullptr || torque_view.y == nullptr ||
        torque_view.z == nullptr) {
        ctx.last_error = "GPU transport RHS evaluator returned an empty torque view";
        return false;
    }
    ctx.gpu_transport_rhs.torque_view = torque_view;
    return true;
}

bool context_complete_gpu_transport_rhs(Context &ctx) {
    if (!ctx.gpu_transport_rhs.active) return true;
    if (ctx.gpu_transport_owner_id == 0) {
        const bool drained =
            cudaStreamSynchronize(context_compute_stream(ctx)) == cudaSuccess;
        ctx.gpu_transport_rhs.torque_view = {};
        return drained;
    }
    const auto context = ctx.gpu_transport_rhs.descriptor.transport_context;
    int device = -1;
    cudaEvent_t completion_event = nullptr;
    std::atomic<uint32_t> *hold_state = nullptr;
    {
        std::lock_guard<std::mutex> lock(registry_mutex);
        if (context.slot >= slots.size()) return false;
        Slot &parent = slots[context.slot];
        if (!same(context, context.slot, parent.generation) || !parent.active ||
            parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
            !parent.llg_torque_in_flight) {
            return false;
        }
        device = parent.device;
        completion_event = parent.llg_torque_ready;
        hold_state = &parent.test_llg_hold_state;
        if (ctx.gpu_transport_test_completion_fault == 4)
            hold_state->store(1, std::memory_order_release);
    }

    while (hold_state->load(std::memory_order_acquire) == 1)
        std::this_thread::yield();

    const cudaStream_t stream = context_compute_stream(ctx);
    const bool inject_record_failure =
        ctx.gpu_transport_test_completion_fault == 2 ||
        ctx.gpu_transport_test_completion_fault == 5;
    const bool inject_sync_failure =
        ctx.gpu_transport_test_completion_fault == 3;
    const bool inject_fallback_failure =
        ctx.gpu_transport_test_completion_fault == 5;
    bool completion_ok = cudaSetDevice(device) == cudaSuccess;
    const cudaError_t record_status = !completion_ok
        ? cudaErrorInvalidDevice
        : inject_record_failure
            ? cudaErrorUnknown
            : cudaEventRecord(completion_event, stream);
    completion_ok = completion_ok && record_status == cudaSuccess;
    cudaError_t sync_status = cudaSuccess;
    if (record_status == cudaSuccess)
        sync_status = inject_sync_failure
            ? cudaErrorUnknown
            : cudaEventSynchronize(completion_event);
    bool fallback_drained = false;
    if (record_status != cudaSuccess || sync_status != cudaSuccess ||
        inject_fallback_failure) {
        // A stream synchronization is the local fallback drain.  It never
        // blocks unrelated contexts or devices like cudaDeviceSynchronize.
        fallback_drained = !inject_fallback_failure &&
            cudaStreamSynchronize(stream) == cudaSuccess;
        completion_ok = false;
    }
    const bool drain_confirmed =
        (record_status == cudaSuccess && sync_status == cudaSuccess &&
         !inject_fallback_failure) || fallback_drained;

    {
        std::lock_guard<std::mutex> lock(registry_mutex);
        if (context.slot >= slots.size()) return false;
        Slot &parent = slots[context.slot];
        if (!same(context, context.slot, parent.generation) || !parent.active ||
            parent.llg_binding_owner_id != ctx.gpu_transport_owner_id ||
            !parent.llg_torque_in_flight) {
            return false;
        }
        if (drain_confirmed) {
            parent.llg_torque_in_flight = false;
            parent.test_llg_hold_state.store(0, std::memory_order_release);
        }
    }
    if (drain_confirmed) ctx.gpu_transport_rhs.torque_view = {};
    ctx.gpu_transport_test_completion_fault = 0;
    return completion_ok && !inject_record_failure && !inject_sync_failure;
}

} // namespace fullmag::fdm
