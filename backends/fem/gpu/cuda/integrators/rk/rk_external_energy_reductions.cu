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
#include "gpu/cuda/interactions/zeeman/regional_field_kernels.cuh"
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
    const bool has_drive = !ctx.zeeman.regional_drives.empty();
    if (!ctx.zeeman.has_external_field && !has_drive) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.materials.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr) {
        reason = "GPU RK Zeeman energy requires device-resident Ms and lumped mass";
        return false;
    }
    const auto reduce_field = [&](const FemGpuComponentField &field,
                                  GpuFinalScalarSlot slot,
                                  const char *blocks_label,
                                  const char *reduce_label) {
        fullmag_cuda_external_energy_blocks(
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            field.x, field.y, field.z, gpu.materials.ms,
            gpu.mesh_metrics.lumped_mass, gpu.mesh_regions.magnetic_node_mask,
            gpu.reductions.scalar_workspace, n, stream);
        if (!cuda_launch_ok(blocks_label, reason)) return false;
        size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.reductions.scalar_workspace, blocks,
            gpu_rk_final_scalar_result(gpu, slot), gpu.reductions.temp_storage,
            reduce_bytes, stream);
        return cuda_launch_ok(reduce_label, reason);
    };
    if (ctx.zeeman.has_external_field) {
        if (gpu.fields.h_ext.x == nullptr || gpu.fields.h_ext.y == nullptr ||
            gpu.fields.h_ext.z == nullptr) {
            reason = "GPU RK external energy requires device-resident H_ext";
            return false;
        }
        if (!reduce_field(gpu.fields.h_ext, GpuFinalScalarSlot::ExternalEnergy,
                "launch GPU RK external energy blocks", "launch GPU RK external energy reduction")) {
            return false;
        }
    }
    if (has_drive) {
        if (gpu.fields.h_drive.x == nullptr || gpu.fields.h_drive.y == nullptr ||
            gpu.fields.h_drive.z == nullptr) {
            reason = "GPU RK drive energy requires device-resident H_drive";
            return false;
        }
        if (!gpu_regional_field_drive_materialize_and_accumulate(
                ctx, stream, n, ctx.state.current_time, false, reason)) return false;
        if (!reduce_field(gpu.fields.h_drive, GpuFinalScalarSlot::DriveEnergy,
            "launch GPU RK drive energy blocks", "launch GPU RK drive energy reduction")) {
            return false;
        }
    }

    return true;
}

} // namespace fullmag::fem
