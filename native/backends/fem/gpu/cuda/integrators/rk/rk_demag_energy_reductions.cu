/*
 * GPU CUDA RK demag final energy reductions source contract.
 *
 * This source owns final demag energy validation, kernel launch, Robin
 * boundary reduction, and scalar reduction for the device-resident RK stats
 * path. It does not own generic final energy orchestration, scalar readback,
 * stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
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
        gpu.h_demag.x == nullptr || gpu.h_demag.y == nullptr || gpu.h_demag.z == nullptr) {
        reason = "GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag";
        return false;
    }
    fullmag_cuda_demag_energy_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.h_demag.x,
        gpu.h_demag.y,
        gpu.h_demag.z,
        gpu.materials.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK demag energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::DemagEnergy),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK demag energy reduction", reason)) {
        return false;
    }

    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
        ctx.poisson_demag.robin_effective_beta > 0.0) {
        if (!reduce_device_demag_robin_boundary_energy(
                ctx,
                gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::DemagRobinBoundaryEnergy),
                stream,
                reason)) {
            return false;
        }
    }

    return true;
}

} // namespace fullmag::fem
