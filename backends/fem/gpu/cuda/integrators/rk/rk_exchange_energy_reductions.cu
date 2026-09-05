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

#include <algorithm>
#include <cstddef>
#include <limits>
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
    int reduction_blocks = blocks;
    if (gpu.mesh_regions.has_periodic_reduced_nodes) {
        if (!gpu.legacy_exchange.periodic_reduced_ready ||
            gpu.legacy_exchange.periodic_reduced_row_offsets == nullptr ||
            gpu.legacy_exchange.periodic_reduced_col_indices == nullptr ||
            gpu.legacy_exchange.periodic_reduced_values == nullptr ||
            gpu.mesh_regions.periodic_reduced_representative_nodes == nullptr ||
            gpu.legacy_exchange.periodic_reduced_rows == 0u ||
            gpu.legacy_exchange.periodic_reduced_rows >
                static_cast<uint64_t>(std::numeric_limits<int>::max())) {
            reason =
                "GPU periodic exchange energy requires a precomputed reduced CSR and representative map";
            return false;
        }
        const int reduced_rows = static_cast<int>(gpu.legacy_exchange.periodic_reduced_rows);
        fullmag_cuda_periodic_reduced_exchange_energy_blocks(
            gpu.legacy_exchange.periodic_reduced_row_offsets,
            gpu.legacy_exchange.periodic_reduced_col_indices,
            gpu.legacy_exchange.periodic_reduced_values,
            gpu.mesh_regions.periodic_reduced_representative_nodes,
            gpu.magnetization.m.x,
            gpu.magnetization.m.y,
            gpu.magnetization.m.z,
            gpu.reductions.scalar_workspace,
            reduced_rows,
            stream);
        reduction_blocks = (reduced_rows + 255) / 256;
    } else {
        fullmag_cuda_legacy_sparse_exchange_energy_blocks(
            gpu.legacy_exchange.csr_row_offsets,
            gpu.legacy_exchange.csr_col_indices,
            gpu.legacy_exchange.csr_values,
            gpu.magnetization.m.x,
            gpu.magnetization.m.y,
            gpu.magnetization.m.z,
            gpu.reductions.scalar_workspace,
            n,
            stream);
    }
    if (!cuda_launch_ok("launch GPU RK exchange energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t rc = fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        reduction_blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::ExchangeEnergy),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(rc, "launch GPU RK exchange energy reduction", reason) ||
        !cuda_launch_ok("launch GPU RK exchange energy reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
