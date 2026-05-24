/*
 * GPU CUDA RK exchange final energy reductions source contract.
 *
 * This source owns final legacy sparse exchange energy kernel launch and
 * scalar reduction for the device-resident RK stats path. It does not own
 * generic final energy orchestration, scalar readback, stats publication, or
 * C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"

#include <cuda_runtime.h>

#include <cstddef>
#include <string>

namespace fullmag::fem {

namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

} // namespace

bool gpu_rk_reduce_final_exchange_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    fullmag_cuda_legacy_sparse_exchange_energy_blocks(
        gpu.legacy_exchange.csr_row_offsets,
        gpu.legacy_exchange.csr_col_indices,
        gpu.legacy_exchange.csr_values,
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK exchange energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::ExchangeEnergy),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK exchange energy reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
