/*
 * GPU CUDA scalar reduction workspace memory source contract.
 *
 * Keeps scalar reduction buffer allocation, CUB temporary-storage sizing, and
 * cleanup inside the CUDA reductions module instead of FemGpuState lifecycle
 * policy code.
 */

#include "gpu/cuda/reductions/reduction_workspace_memory.hpp"

#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/state/device_memory.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <limits>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr uint32_t kCudaBlockSize = 256;

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool force_pageable_scalar_readback()
{
    const char *value = std::getenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    return value != nullptr && std::strcmp(value, "1") == 0;
}
#endif

} // namespace

bool gpu_reduction_workspace_allocate(
    FemGpuReductionWorkspaceDeviceState &reductions,
    uint64_t node_count,
    uint64_t &device_bytes,
    uint64_t &reduction_workspace_bytes,
    std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    const uint64_t reduce_blocks = (node_count + kCudaBlockSize - 1ull) / kCudaBlockSize;
    if (reduce_blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "FemGpuState reduction block count is too large for CUB device max";
        return false;
    }
    if (reduce_blocks >
        ((std::numeric_limits<uint64_t>::max() / sizeof(double)) - FEM_GPU_SCALAR_RESULT_SLOTS) / 3u) {
        error = "FemGpuState reduction workspace byte count is too large";
        return false;
    }
    if (!gpu_device_allocate_double(reductions.scalar_workspace, 3u * reduce_blocks, device_bytes, error) ||
        !gpu_device_allocate_double(reductions.scalar_result, FEM_GPU_SCALAR_RESULT_SLOTS, device_bytes, error) ||
        !gpu_device_allocate_u64(reductions.dmi_diagnostics, 2u, device_bytes, error)) {
        return false;
    }
    const bool forced_pageable = force_pageable_scalar_readback();
    const cudaError_t host_scalar_status = forced_pageable
        ? cudaErrorMemoryAllocation
        : cudaHostAlloc(
              reinterpret_cast<void **>(&reductions.host_scalar_result),
              FEM_GPU_SCALAR_RESULT_SLOTS * sizeof(double),
              cudaHostAllocDefault);
    if (host_scalar_status == cudaSuccess) {
        reductions.scalar_result_pinned = true;
    } else if (host_scalar_status == cudaErrorMemoryAllocation) {
        // A pageable fixed-size fallback preserves numerical semantics when
        // the process or driver has exhausted its pinned-host allowance. The
        // readback helper synchronizes the stream before consuming the data,
        // so only transfer overlap is degraded. Clear the allocation error
        // before issuing subsequent CUDA work on this thread.
        cudaGetLastError();
        reductions.host_scalar_result = reductions.pageable_scalar_result.data();
        reductions.scalar_result_pinned = false;
        std::fprintf(
            stderr,
            "[fullmag_fem][warning] %s; using pageable scalar readback "
            "fallback; numerical semantics are unchanged, transfer overlap "
            "is disabled\n",
            forced_pageable
                ? "pageable scalar readback was forced for qualification"
                : "cudaHostAlloc scalar readback staging returned cudaErrorMemoryAllocation");
    } else {
        error = std::string("cudaHostAlloc FemGpuState scalar readback staging failed: ") +
            cudaGetErrorString(host_scalar_status);
        reductions.host_scalar_result = nullptr;
        reductions.scalar_result_pinned = false;
        return false;
    }

    size_t reduce_temp_storage_bytes = 0;
    const cudaError_t max_query_status = fullmag_cuda_device_max(
        reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        reductions.scalar_result,
        nullptr,
        reduce_temp_storage_bytes,
        nullptr);
    if (!cuda_ok(max_query_status, "fullmag_cuda_device_max temporary storage query", error)) {
        return false;
    }
    size_t reduce_min_temp_storage_bytes = 0;
    const cudaError_t min_query_status = fullmag_cuda_device_min(
        reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        reductions.scalar_result,
        nullptr,
        reduce_min_temp_storage_bytes,
        nullptr);
    if (!cuda_ok(min_query_status, "fullmag_cuda_device_min temporary storage query", error)) {
        return false;
    }
    size_t reduce_sum_temp_storage_bytes = 0;
    const cudaError_t sum_query_status = fullmag_cuda_device_sum(
        reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        reductions.scalar_result,
        nullptr,
        reduce_sum_temp_storage_bytes,
        nullptr);
    if (!cuda_ok(sum_query_status, "fullmag_cuda_device_sum temporary storage query", error)) {
        return false;
    }
    reduce_temp_storage_bytes =
        std::max({reduce_temp_storage_bytes, reduce_min_temp_storage_bytes, reduce_sum_temp_storage_bytes});
    if (reduce_temp_storage_bytes > 0 &&
        !gpu_device_allocate_bytes(
            &reductions.temp_storage,
            reduce_temp_storage_bytes,
            device_bytes,
            error)) {
        return false;
    }

    reductions.temp_storage_bytes = static_cast<uint64_t>(reduce_temp_storage_bytes);
    reduction_workspace_bytes =
        (3u * reduce_blocks + FEM_GPU_SCALAR_RESULT_SLOTS) * sizeof(double) +
        2u * sizeof(uint64_t) +
        reductions.temp_storage_bytes;
    return true;
#else
    (void)reductions;
    (void)node_count;
    (void)device_bytes;
    (void)reduction_workspace_bytes;
    error = "FemGpuState device allocation requested but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

void gpu_reduction_workspace_free(FemGpuReductionWorkspaceDeviceState &reductions)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (reductions.host_scalar_result != nullptr && reductions.scalar_result_pinned) {
        cudaFreeHost(reductions.host_scalar_result);
    }
    reductions.host_scalar_result = nullptr;
    reductions.scalar_result_pinned = false;
#else
    reductions.host_scalar_result = nullptr;
    reductions.scalar_result_pinned = false;
#endif
    gpu_device_free_double(reductions.scalar_workspace);
    gpu_device_free_double(reductions.scalar_result);
    gpu_device_free_u64(reductions.dmi_diagnostics);
    gpu_device_free_bytes(reductions.temp_storage);
}

} // namespace fullmag::fem
