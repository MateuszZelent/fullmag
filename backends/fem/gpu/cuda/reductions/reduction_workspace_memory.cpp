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
        (std::numeric_limits<uint64_t>::max() / sizeof(double)) - FEM_GPU_SCALAR_RESULT_SLOTS) {
        error = "FemGpuState reduction workspace byte count is too large";
        return false;
    }
    if (!gpu_device_allocate_double(reductions.scalar_workspace, reduce_blocks, device_bytes, error) ||
        !gpu_device_allocate_double(reductions.scalar_result, FEM_GPU_SCALAR_RESULT_SLOTS, device_bytes, error)) {
        return false;
    }
    if (!cuda_ok(
            cudaHostAlloc(
                reinterpret_cast<void **>(&reductions.host_scalar_result),
                FEM_GPU_SCALAR_RESULT_SLOTS * sizeof(double),
                cudaHostAllocDefault),
            "cudaHostAlloc FemGpuState scalar readback staging",
            error)) {
        reductions.host_scalar_result = nullptr;
        return false;
    }

    size_t reduce_temp_storage_bytes = 0;
    fullmag_cuda_device_max(
        reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        reductions.scalar_result,
        nullptr,
        reduce_temp_storage_bytes,
        nullptr);
    size_t reduce_sum_temp_storage_bytes = 0;
    fullmag_cuda_device_sum(
        reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        reductions.scalar_result,
        nullptr,
        reduce_sum_temp_storage_bytes,
        nullptr);
    reduce_temp_storage_bytes =
        std::max(reduce_temp_storage_bytes, reduce_sum_temp_storage_bytes);
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
        (reduce_blocks + FEM_GPU_SCALAR_RESULT_SLOTS) * sizeof(double) +
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
    if (reductions.host_scalar_result != nullptr) {
        cudaFreeHost(reductions.host_scalar_result);
        reductions.host_scalar_result = nullptr;
    }
#else
    reductions.host_scalar_result = nullptr;
#endif
    gpu_device_free_double(reductions.scalar_workspace);
    gpu_device_free_double(reductions.scalar_result);
    gpu_device_free_bytes(reductions.temp_storage);
}

} // namespace fullmag::fem
