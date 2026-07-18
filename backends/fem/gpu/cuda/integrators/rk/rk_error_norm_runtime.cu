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
    if (gpu.reductions.temp_storage == nullptr ||
        gpu.reductions.temp_storage_bytes == 0) {
        reason = "GPU RK adaptive error norm requires preallocated CUB reduction temp storage";
        return false;
    }

    fullmag_cuda_adaptive_error_norm_blocks(
        gpu.rk.m_backup.x, gpu.rk.m_backup.y, gpu.rk.m_backup.z,
        gpu.rk.m_stage.x, gpu.rk.m_stage.y, gpu.rk.m_stage.z,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.rk.k[0].x, gpu.rk.k[0].y, gpu.rk.k[0].z,
        gpu.rk.k[1].x, gpu.rk.k[1].y, gpu.rk.k[1].z,
        gpu.rk.k[2].x, gpu.rk.k[2].y, gpu.rk.k[2].z,
        gpu.rk.k[3].x, gpu.rk.k[3].y, gpu.rk.k[3].z,
        gpu.rk.k[4].x, gpu.rk.k[4].y, gpu.rk.k[4].z,
        gpu.rk.k[5].x, gpu.rk.k[5].y, gpu.rk.k[5].z,
        gpu.rk.k[6].x, gpu.rk.k[6].y, gpu.rk.k[6].z,
        tableau.b_hi[0], tableau.b_hi[1], tableau.b_hi[2], tableau.b_hi[3],
        tableau.b_hi[4], tableau.b_hi[5], tableau.b_hi[6],
        tableau.b_lo[0], tableau.b_lo[1], tableau.b_lo[2], tableau.b_lo[3],
        tableau.b_lo[4], tableau.b_lo[5], tableau.b_lo[6],
        dt_seconds,
        ctx.adaptive_dt.atol,
        ctx.adaptive_dt.rtol,
        ctx.adaptive_dt.has_norm_tolerance,
        ctx.adaptive_dt.norm_tolerance,
        ctx.adaptive_dt.has_max_spin_rotation,
        ctx.adaptive_dt.max_spin_rotation,
        gpu.reductions.scalar_workspace,
        gpu.reductions.scalar_workspace + blocks,
        gpu.reductions.scalar_workspace + 2 * blocks,
        tableau.stages,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK adaptive error norm blocks", reason)) {
        return false;
    }

    std::size_t reduce_bytes = static_cast<std::size_t>(gpu.reductions.temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace,
        std::max(1, blocks),
        gpu.reductions.scalar_result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK adaptive error norm reduction", reason)) {
        return false;
    }

    fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace + blocks,
        std::max(1, blocks),
        gpu.reductions.scalar_result + 1,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK norm-defect reduction", reason)) {
        return false;
    }
    fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace + 2 * blocks,
        std::max(1, blocks),
        gpu.reductions.scalar_result + 2,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK spin-rotation reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
