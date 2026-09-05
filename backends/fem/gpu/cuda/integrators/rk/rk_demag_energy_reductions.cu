/*
 * GPU CUDA RK demag final energy reductions source contract.
 *
 * This source owns final demag energy validation, kernel launch, and scalar
 * reduction for the device-resident RK stats
 * path. It does not own generic final energy orchestration, scalar readback,
 * stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
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

bool gpu_rk_reduce_final_demag_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    if (!ctx.demag.enabled) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.materials.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr ||
        gpu.fields.h_demag.x == nullptr || gpu.fields.h_demag.y == nullptr || gpu.fields.h_demag.z == nullptr) {
        reason = "GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag";
        return false;
    }
    fullmag_cuda_demag_energy_blocks(
        gpu.magnetization.m.x,
        gpu.magnetization.m.y,
        gpu.magnetization.m.z,
        gpu.fields.h_demag.x,
        gpu.fields.h_demag.y,
        gpu.fields.h_demag.z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK demag energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t rc = fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::DemagEnergy),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(rc, "launch GPU RK demag energy reduction", reason) ||
        !cuda_launch_ok("launch GPU RK demag energy reduction", reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
