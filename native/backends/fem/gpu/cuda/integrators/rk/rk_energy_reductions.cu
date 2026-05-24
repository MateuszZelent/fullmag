/*
 * GPU CUDA RK final energy reductions source contract.
 *
 * This source owns final energy kernel launches and reductions for the
 * device-resident RK stats path. It does not own RK step orchestration, RHS
 * assembly, scalar readback, stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp"
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

bool gpu_rk_reduce_final_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);

    if (!gpu_rk_reduce_final_exchange_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_demag_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (ctx.zeeman.has_external_field) {
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
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
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.scalar_reduce_workspace,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK external energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
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
    }

    if (!gpu_rk_reduce_final_dmi_energy_terms(ctx, stream, n, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_anisotropy_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_magnetoelastic_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
