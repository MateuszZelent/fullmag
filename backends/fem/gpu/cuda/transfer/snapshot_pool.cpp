/*
 * GPU CUDA snapshot-pool runtime implementation.
 *
 * All heavyweight CUDA allocation and event creation occurs during backend
 * initialization. Snapshot submission only leases a fixed slot and enqueues
 * work on the persistent runtime streams.
 */

#include "gpu/cuda/transfer/snapshot_pool.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <limits>

namespace fullmag::fem {

FemGpuSnapshotPoolState::~FemGpuSnapshotPoolState()
{
    destroy_gpu_snapshot_pool(*this);
}

void destroy_gpu_snapshot_pool(FemGpuSnapshotPoolState &pool)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    for (auto &slot : pool.slots) {
        if (slot.done_event != nullptr) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.done_event));
            slot.done_event = nullptr;
        }
        if (slot.staging_done_event != nullptr) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.staging_done_event));
            slot.staging_done_event = nullptr;
        }
        if (slot.ready_event != nullptr) {
            cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.ready_event));
            slot.ready_event = nullptr;
        }
        if (slot.host_aos != nullptr) {
            cudaFreeHost(slot.host_aos);
            slot.host_aos = nullptr;
        }
    }
    if (pool.staging.x != nullptr) {
        cudaFree(pool.staging.x);
        pool.staging.x = nullptr;
    }
    if (pool.staging.y != nullptr) {
        cudaFree(pool.staging.y);
        pool.staging.y = nullptr;
    }
    if (pool.staging.z != nullptr) {
        cudaFree(pool.staging.z);
        pool.staging.z = nullptr;
    }
#endif
    pool.component_bytes = 0;
    pool.host_aos_bytes = 0;
    __atomic_store_n(&pool.leased_slots, 0, __ATOMIC_RELEASE);
    __atomic_store_n(&pool.retired_slots, 0, __ATOMIC_RELEASE);
    pool.initialized = false;
}

bool initialize_gpu_snapshot_pool(
    FemGpuSnapshotPoolState &pool,
    uint64_t node_count,
    std::string &error)
{
    destroy_gpu_snapshot_pool(pool);
    if (node_count == 0 ||
        node_count > std::numeric_limits<std::size_t>::max() / (3u * sizeof(double))) {
        error = "FEM GPU snapshot pool received invalid node count";
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    pool.component_bytes = static_cast<std::size_t>(node_count) * sizeof(double);
    pool.host_aos_bytes = pool.component_bytes * 3u;

    auto fail = [&](const char *label, cudaError_t status) -> bool {
        error = std::string(label) + ": " + cudaGetErrorString(status);
        destroy_gpu_snapshot_pool(pool);
        return false;
    };

    cudaError_t status = cudaMalloc(&pool.staging.x, pool.component_bytes);
    if (status != cudaSuccess) return fail("cudaMalloc(FEM snapshot pool.x)", status);
    status = cudaMalloc(&pool.staging.y, pool.component_bytes);
    if (status != cudaSuccess) return fail("cudaMalloc(FEM snapshot pool.y)", status);
    status = cudaMalloc(&pool.staging.z, pool.component_bytes);
    if (status != cudaSuccess) return fail("cudaMalloc(FEM snapshot pool.z)", status);

    for (auto &slot : pool.slots) {
        status = cudaHostAlloc(&slot.host_aos, pool.host_aos_bytes, cudaHostAllocDefault);
        if (status != cudaSuccess) {
            return fail("cudaHostAlloc(FEM snapshot pool.host_aos)", status);
        }
        cudaEvent_t ready_event{};
        status = cudaEventCreateWithFlags(&ready_event, cudaEventDisableTiming);
        if (status != cudaSuccess) {
            return fail("cudaEventCreate(FEM snapshot pool.ready_event)", status);
        }
        slot.ready_event = reinterpret_cast<void *>(ready_event);

        cudaEvent_t staging_done_event{};
        status = cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming);
        if (status != cudaSuccess) {
            return fail("cudaEventCreate(FEM snapshot pool.staging_done_event)", status);
        }
        slot.staging_done_event = reinterpret_cast<void *>(staging_done_event);

        cudaEvent_t done_event{};
        status = cudaEventCreateWithFlags(&done_event, cudaEventDisableTiming);
        if (status != cudaSuccess) {
            return fail("cudaEventCreate(FEM snapshot pool.done_event)", status);
        }
        slot.done_event = reinterpret_cast<void *>(done_event);
    }
    __atomic_store_n(&pool.leased_slots, 0, __ATOMIC_RELEASE);
    __atomic_store_n(&pool.retired_slots, 0, __ATOMIC_RELEASE);
    pool.initialized = true;
    return true;
#else
    (void)pool;
    error = "FEM GPU snapshot pool requires CUDA runtime support";
    return false;
#endif
}

bool gpu_snapshot_pool_acquire(
    FemGpuSnapshotPoolState &pool,
    FemGpuSnapshotPoolLease &lease,
    std::string &error)
{
    lease = {};
    if (!pool.initialized) {
        error = "FEM GPU snapshot pool is not initialized";
        return false;
    }
    uint32_t observed = __atomic_load_n(&pool.leased_slots, __ATOMIC_ACQUIRE);
    for (;;) {
        std::size_t slot_index = kFemGpuSnapshotPoolCapacity;
        for (std::size_t candidate = 0; candidate < kFemGpuSnapshotPoolCapacity; ++candidate) {
            const uint32_t bit = uint32_t{1} << candidate;
            if ((observed & bit) == 0) {
                slot_index = candidate;
                break;
            }
#if FULLMAG_HAS_CUDA_RUNTIME
            uint32_t retired = __atomic_load_n(&pool.retired_slots, __ATOMIC_ACQUIRE);
            const uint32_t desired_retired = retired & ~bit;
            if ((retired & bit) != 0 &&
                cudaEventQuery(reinterpret_cast<cudaEvent_t>(pool.slots[candidate].done_event)) ==
                    cudaSuccess &&
                __atomic_compare_exchange_n(
                    &pool.retired_slots,
                    &retired,
                    desired_retired,
                    false,
                    __ATOMIC_ACQ_REL,
                    __ATOMIC_ACQUIRE)) {
                const auto &slot = pool.slots[candidate];
                lease.slot_index = candidate;
                lease.host_aos = slot.host_aos;
                lease.staging = pool.staging;
                lease.ready_event = slot.ready_event;
                lease.staging_done_event = slot.staging_done_event;
                lease.done_event = slot.done_event;
                return true;
            }
#endif
        }
        if (slot_index == kFemGpuSnapshotPoolCapacity) {
            error = "FEM GPU snapshot pool exhausted (8 snapshots already in flight)";
            return false;
        }
        const uint32_t desired = observed | (uint32_t{1} << slot_index);
        if (__atomic_compare_exchange_n(
                &pool.leased_slots,
                &observed,
                desired,
                true,
                __ATOMIC_ACQ_REL,
                __ATOMIC_ACQUIRE)) {
            const auto &slot = pool.slots[slot_index];
            lease.slot_index = slot_index;
            lease.host_aos = slot.host_aos;
            lease.staging = pool.staging;
            lease.ready_event = slot.ready_event;
            lease.staging_done_event = slot.staging_done_event;
            lease.done_event = slot.done_event;
            return true;
        }
    }
}

void gpu_snapshot_pool_release(
    FemGpuSnapshotPoolState &pool,
    std::size_t slot_index,
    bool work_complete)
{
    if (slot_index >= kFemGpuSnapshotPoolCapacity) {
        return;
    }
    const uint32_t bit = uint32_t{1} << slot_index;
    if (work_complete) {
        __atomic_fetch_and(&pool.retired_slots, ~bit, __ATOMIC_ACQ_REL);
        __atomic_fetch_and(&pool.leased_slots, ~bit, __ATOMIC_ACQ_REL);
    } else {
        __atomic_fetch_or(&pool.retired_slots, bit, __ATOMIC_ACQ_REL);
    }
}

} // namespace fullmag::fem
