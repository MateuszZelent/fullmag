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
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.fields.h_eff.x,
        gpu.fields.h_eff.y,
        gpu.fields.h_eff.z,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.reductions.scalar_workspace,
        gpu.rk.error.x,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK field metric blocks", reason)) {
        return false;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t max_h_rc = fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxHEff),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(max_h_rc, "launch GPU RK max H_eff reduction", reason) ||
        !cuda_launch_ok("launch GPU RK max H_eff reduction", reason)) {
        return false;
    }

    if (ctx.demag.enabled) {
        // Use gpu.rk.error.y as a scratch target for block_max_torque; gpu.rk.error.x
        // still holds per-block H_eff torque values for MaxTorque below.
        fullmag_cuda_field_metric_blocks(
            gpu.magnetization.m.x,
            gpu.magnetization.m.y,
            gpu.magnetization.m.z,
            gpu.fields.h_demag.x,
            gpu.fields.h_demag.y,
            gpu.fields.h_demag.z,
            gpu.mesh_regions.magnetic_node_mask,
            gpu.reductions.scalar_workspace,
            gpu.rk.error.y,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK demag field metric blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        const cudaError_t demag_rc = fullmag_cuda_device_max(
            gpu.reductions.scalar_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxHDemag),
            gpu.reductions.temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_ok(demag_rc, "launch GPU RK max H_demag reduction", reason) ||
            !cuda_launch_ok("launch GPU RK max H_demag reduction", reason)) {
            return false;
        }
    }

    reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t torque_rc = fullmag_cuda_device_max(
        gpu.rk.error.x,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxTorque),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(torque_rc, "launch GPU RK max torque reduction", reason)) {
        return false;
    }
    return cuda_launch_ok("launch GPU RK max torque reduction", reason);
}

} // namespace fullmag::fem
