/*
 * GPU CUDA RK anisotropy final energy reductions source contract.
 *
 * This source owns final uniaxial and cubic anisotropy energy kernel launches
 * and reductions for the device-resident RK stats path. It does not own
 * generic final energy orchestration, scalar readback, stats publication, or
 * C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"

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

bool gpu_rk_reduce_final_anisotropy_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);

    if (ctx.anisotropy.uniaxial_enabled) {
        if (gpu.ms == nullptr || gpu.ku == nullptr || gpu.ku2 == nullptr ||
            gpu.exchange_lumped_mass == nullptr ||
            gpu.h_ani.x == nullptr || gpu.h_ani.y == nullptr || gpu.h_ani.z == nullptr) {
            reason = "GPU RK uniaxial anisotropy energy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers";
            return false;
        }
        fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.ku,
            gpu.ku2,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_ani.x,
            gpu.h_ani.y,
            gpu.h_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy.uniaxial_Ku,
            ctx.anisotropy.uniaxial_Ku2,
            ctx.anisotropy.uniaxial_axis[0],
            ctx.anisotropy.uniaxial_axis[1],
            ctx.anisotropy.uniaxial_axis[2],
            !ctx.material_fields.Ku_field.empty(),
            !ctx.material_fields.Ku2_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::AnisotropyEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy energy reduction", reason)) {
            return false;
        }
    }

    if (ctx.anisotropy.cubic_enabled) {
        if (gpu.ms == nullptr || gpu.kc1 == nullptr || gpu.kc2 == nullptr ||
            gpu.kc3 == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_cubic_ani.x == nullptr || gpu.h_cubic_ani.y == nullptr ||
            gpu.h_cubic_ani.z == nullptr) {
            reason = "GPU RK cubic anisotropy energy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers";
            return false;
        }
        fullmag_cuda_cubic_anisotropy_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.kc1,
            gpu.kc2,
            gpu.kc3,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_cubic_ani.x,
            gpu.h_cubic_ani.y,
            gpu.h_cubic_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy.cubic_Kc1,
            ctx.anisotropy.cubic_Kc2,
            ctx.anisotropy.cubic_Kc3,
            ctx.anisotropy.cubic_axis1[0],
            ctx.anisotropy.cubic_axis1[1],
            ctx.anisotropy.cubic_axis1[2],
            ctx.anisotropy.cubic_axis2[0],
            ctx.anisotropy.cubic_axis2[1],
            ctx.anisotropy.cubic_axis2[2],
            !ctx.material_fields.Kc1_field.empty(),
            !ctx.material_fields.Kc2_field.empty(),
            !ctx.material_fields.Kc3_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::CubicAnisotropyEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy energy reduction", reason)) {
            return false;
        }
    }

    return true;
}

} // namespace fullmag::fem
