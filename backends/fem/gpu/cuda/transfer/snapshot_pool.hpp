#pragma once

/*
 * GPU CUDA snapshot-pool runtime contract.
 *
 * Owns the bounded persistent CUDA resources used to capture immutable FEM
 * observable snapshots without allocating, pinning, or creating streams and
 * events inside the solver callback. The low-priority I/O stream remains
 * owned by CudaRuntimeState; this pool owns only snapshot buffers and events.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace fullmag::fem {

constexpr std::size_t kFemGpuSnapshotPoolCapacity = 8;

struct FemGpuSnapshotPoolSlot {
    void *host_aos = nullptr;
    void *ready_event = nullptr;
    void *staging_done_event = nullptr;
    void *done_event = nullptr;
};

struct FemGpuSnapshotPoolState {
    FemGpuSnapshotPoolState() = default;
    ~FemGpuSnapshotPoolState();
    FemGpuSnapshotPoolState(const FemGpuSnapshotPoolState &) = delete;
    FemGpuSnapshotPoolState &operator=(const FemGpuSnapshotPoolState &) = delete;

    FemGpuComponentField staging{};
    FemGpuSnapshotPoolSlot slots[kFemGpuSnapshotPoolCapacity]{};
    std::size_t component_bytes = 0;
    std::size_t host_aos_bytes = 0;
    uint32_t leased_slots = 0;
    uint32_t retired_slots = 0;
    bool initialized = false;
};

struct FemGpuSnapshotPoolLease {
    std::size_t slot_index = kFemGpuSnapshotPoolCapacity;
    void *host_aos = nullptr;
    FemGpuComponentField staging{};
    void *ready_event = nullptr;
    void *staging_done_event = nullptr;
    void *done_event = nullptr;
};

bool initialize_gpu_snapshot_pool(
    FemGpuSnapshotPoolState &pool,
    uint64_t node_count,
    std::string &error);

void destroy_gpu_snapshot_pool(FemGpuSnapshotPoolState &pool);

bool gpu_snapshot_pool_acquire(
    FemGpuSnapshotPoolState &pool,
    FemGpuSnapshotPoolLease &lease,
    std::string &error);

void gpu_snapshot_pool_release(
    FemGpuSnapshotPoolState &pool,
    std::size_t slot_index,
    bool work_complete);

} // namespace fullmag::fem
