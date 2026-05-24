/*
 * GPU CUDA RK exchange dispatch source contract.
 *
 * This source owns validation and launch dispatch for the legacy sparse
 * exchange operator used by the GPU RK RHS runtime. It does not own exchange
 * assembly/upload, RHS orchestration, demag dispatch, local fields, LLG RHS,
 * RK stage scheduling, final statistics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp"

#include "gpu/cuda/exchange/exchange_kernels.hpp"

#include <cuda_runtime.h>

#include <cstdint>
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

bool gpu_rk_compute_legacy_sparse_exchange(
    FemGpuState &gpu,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason)
{
    if (!gpu.legacy_exchange.uploaded ||
        gpu.legacy_exchange.csr_row_offsets == nullptr ||
        gpu.legacy_exchange.csr_col_indices == nullptr ||
        gpu.legacy_exchange.csr_values == nullptr ||
        gpu.ms == nullptr ||
        gpu.mesh_metrics.inv_lumped_mass == nullptr) {
        reason = "GPU legacy sparse exchange requires uploaded CSR/mass device buffers";
        return false;
    }
    if (gpu.legacy_exchange.rows != gpu.node_count ||
        gpu.legacy_exchange.cols != gpu.node_count ||
        gpu.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU legacy sparse exchange dimensions do not match RK node_count";
        return false;
    }

    const int rows = static_cast<int>(gpu.node_count);
    fullmag_cuda_legacy_sparse_exchange(
        gpu.legacy_exchange.csr_row_offsets,
        gpu.legacy_exchange.csr_col_indices,
        gpu.legacy_exchange.csr_values,
        m.x,
        gpu.ms,
        gpu.mesh_metrics.inv_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.h_ex.x,
        rows,
        stream);
    fullmag_cuda_legacy_sparse_exchange(
        gpu.legacy_exchange.csr_row_offsets,
        gpu.legacy_exchange.csr_col_indices,
        gpu.legacy_exchange.csr_values,
        m.y,
        gpu.ms,
        gpu.mesh_metrics.inv_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.h_ex.y,
        rows,
        stream);
    fullmag_cuda_legacy_sparse_exchange(
        gpu.legacy_exchange.csr_row_offsets,
        gpu.legacy_exchange.csr_col_indices,
        gpu.legacy_exchange.csr_values,
        m.z,
        gpu.ms,
        gpu.mesh_metrics.inv_lumped_mass,
        gpu.magnetic_node_mask,
        gpu.h_ex.z,
        rows,
        stream);
    return cuda_launch_ok("launch GPU legacy sparse exchange", reason);
}

} // namespace fullmag::fem
