/*
 * GPU CUDA RK final observable reductions source contract.
 *
 * This source owns final field metric, torque, and average magnetization
 * reductions for the device-resident RK stats path. It does not own RK step
 * orchestration, RHS assembly, scalar readback, stats publication, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/kernels/kernels.hpp"

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

bool gpu_rk_reduce_final_observable_terms(
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
        // Use gpu.error.y as a scratch target for block_max_torque — we only
        // need block_max_h (scalar_reduce_workspace) from this call. gpu.error.x
        // must not be overwritten here because it holds the per-block H_eff
        // torque values that are reduced into max_torque immediately below.
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
    if (!cuda_launch_ok("launch GPU RK max torque reduction", reason)) {
        return false;
    }

    fullmag_cuda_magnetization_sum_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        gpu.error.x,
        gpu.error.y,
        gpu.error.z,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetization average blocks", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MxSum),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK mx average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.x,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MySum),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK my average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.y,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MzSum),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK mz average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.z,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MagneticCount),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetic count reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
