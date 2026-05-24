/*
 * GPU CUDA RK field metric final reductions source contract.
 *
 * This source owns final H_eff, H_demag, and torque metric kernel launches and
 * scalar reductions for the device-resident RK stats path. It does not own
 * generic observable orchestration, magnetization averages, scalar readback,
 * stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp"

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

bool gpu_rk_reduce_final_field_metric_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    fullmag_cuda_field_metric_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.h_eff.x,
        gpu.h_eff.y,
        gpu.h_eff.z,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        gpu.error.x,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK field metric blocks", reason)) {
        return false;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxHEff),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK max H_eff reduction", reason)) {
        return false;
    }

    if (ctx.demag.enabled) {
        // Use gpu.error.y as a scratch target for block_max_torque; gpu.error.x
        // still holds per-block H_eff torque values for MaxTorque below.
        fullmag_cuda_field_metric_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.h_demag.x,
            gpu.h_demag.y,
            gpu.h_demag.z,
            gpu.magnetic_node_mask,
            gpu.scalar_reduce_workspace,
            gpu.error.y,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK demag field metric blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_max(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxHDemag),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK max H_demag reduction", reason)) {
            return false;
        }
    }

    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.error.x,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxTorque),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    return cuda_launch_ok("launch GPU RK max torque reduction", reason);
}

} // namespace fullmag::fem
