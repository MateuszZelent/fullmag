// ── GPU CUDA RK adaptive error-norm runtime source contract ─────────────
// This source owns device error-norm reduction helpers for embedded adaptive
// RK methods. It does not own RK step orchestration, adaptive PI policy,
// transitional host decision readback, reject restore, RHS assembly, stage
// kernels, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/adaptive_error_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"

#include <algorithm>
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

bool gpu_rk_reduce_adaptive_error_norm_device(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (gpu.scalar_reduce_temp_storage == nullptr ||
        gpu.scalar_reduce_temp_storage_bytes == 0) {
        reason = "GPU RK adaptive error norm requires preallocated CUB reduction temp storage";
        return false;
    }

    fullmag_cuda_adaptive_error_norm_blocks(
        gpu.m_backup.x, gpu.m_backup.y, gpu.m_backup.z,
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.k[6].x, gpu.k[6].y, gpu.k[6].z,
        tableau.b_hi[0], tableau.b_hi[1], tableau.b_hi[2], tableau.b_hi[3],
        tableau.b_hi[4], tableau.b_hi[5], tableau.b_hi[6],
        tableau.b_lo[0], tableau.b_lo[1], tableau.b_lo[2], tableau.b_lo[3],
        tableau.b_lo[4], tableau.b_lo[5], tableau.b_lo[6],
        dt_seconds,
        ctx.adaptive_dt.atol,
        ctx.adaptive_dt.rtol,
        gpu.scalar_reduce_workspace,
        tableau.stages,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK adaptive error norm blocks", reason)) {
        return false;
    }

    std::size_t reduce_bytes = static_cast<std::size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        std::max(1, blocks),
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK adaptive error norm reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
