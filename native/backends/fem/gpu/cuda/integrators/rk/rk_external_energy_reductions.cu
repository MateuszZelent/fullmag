/*
 * GPU CUDA RK external final energy reductions source contract.
 *
 * This source owns final Zeeman/external-field energy validation, kernel
 * launch, and scalar reduction for the device-resident RK stats path. It does
 * not own generic final energy orchestration, scalar readback, stats
 * publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/interactions/zeeman/zeeman_kernels.hpp"
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

bool gpu_rk_reduce_final_external_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    if (!ctx.zeeman.has_external_field) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr ||
        gpu.h_ext.x == nullptr || gpu.h_ext.y == nullptr || gpu.h_ext.z == nullptr) {
        reason = "GPU RK external energy requires device-resident Ms, lumped mass, and H_ext";
        return false;
    }
    fullmag_cuda_external_energy_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.h_ext.x,
        gpu.h_ext.y,
        gpu.h_ext.z,
        gpu.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK external energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::ExternalEnergy),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK external energy reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
