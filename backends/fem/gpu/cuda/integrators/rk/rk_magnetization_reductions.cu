/*
 * GPU CUDA RK magnetization final reductions source contract.
 *
 * This source owns final average-magnetization kernel launch and scalar
 * reductions for the device-resident RK stats path. It does not own generic
 * observable orchestration, field metrics, scalar readback, stats publication,
 * or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_magnetization_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/observables/observable_kernels.hpp"
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

bool gpu_rk_reduce_final_magnetization_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    fullmag_cuda_magnetization_sum_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.mesh_metrics.node_volumes,
        gpu.materials.ms,
        gpu.reductions.scalar_workspace,
        gpu.rk.error.x,
        gpu.rk.error.y,
        gpu.rk.error.z,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetization average blocks", reason)) {
        return false;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t mx_rc = fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MxSum),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(mx_rc, "launch GPU RK mx average reduction", reason) ||
        !cuda_launch_ok("launch GPU RK mx average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t my_rc = fullmag_cuda_device_sum(
        gpu.rk.error.x,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MySum),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(my_rc, "launch GPU RK my average reduction", reason) ||
        !cuda_launch_ok("launch GPU RK my average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t mz_rc = fullmag_cuda_device_sum(
        gpu.rk.error.y,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MzSum),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(mz_rc, "launch GPU RK mz average reduction", reason) ||
        !cuda_launch_ok("launch GPU RK mz average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t w_rc = fullmag_cuda_device_sum(
        gpu.rk.error.z,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MomentWeight),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(w_rc, "launch GPU RK magnetic moment weight reduction", reason)) {
        return false;
    }
    return cuda_launch_ok("launch GPU RK magnetic moment weight reduction", reason);
}

} // namespace fullmag::fem
