/*
 * GPU CUDA RK effective field accumulation source contract.
 *
 * This source owns H_eff accumulation for the device-resident RK RHS: base
 * exchange/demag/external composition, local field additions, DMI additions,
 * and specialized interaction accumulation delegation. It does not own local
 * field generation, exchange, demag dispatch, LLG RHS evaluation, direct torque
 * terms, RK step scheduling, final statistics, GPU RK planning, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"

#include "context.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_oersted_field.hpp"

#include <cuda_runtime.h>

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

bool gpu_rk_accumulate_effective_field(
    Context &ctx,
    cudaStream_t stream,
    int n,
    const char *base_label,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    fullmag_cuda_accumulate_heff(gpu.h_ex.x, gpu.h_demag.x, gpu.h_ext.x, gpu.h_eff.x, n, true, stream);
    fullmag_cuda_accumulate_heff(gpu.h_ex.y, gpu.h_demag.y, gpu.h_ext.y, gpu.h_eff.y, n, true, stream);
    fullmag_cuda_accumulate_heff(gpu.h_ex.z, gpu.h_demag.z, gpu.h_ext.z, gpu.h_eff.z, n, true, stream);
    if (!cuda_launch_ok(base_label, reason)) {
        return false;
    }
    if (ctx.anisotropy.uniaxial_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_ani.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_ani.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_ani.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.anisotropy.cubic_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_cubic_ani.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.dmi.interfacial_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_dmi.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_dmi.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_dmi.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK interfacial DMI h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.dmi.bulk_enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_bulk_dmi.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK bulk DMI h_eff accumulation", reason)) {
            return false;
        }
    }
    if (!gpu_rk_accumulate_oersted_field(ctx, stream, n, reason)) {
        return false;
    }
    if (ctx.magnetoelastic.enabled) {
        fullmag_cuda_add_field_inplace(gpu.h_mel.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_mel.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_mel.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic h_eff accumulation", reason)) {
            return false;
        }
    }
    if (ctx.thermal_brown.temperature > 0.0) {
        fullmag_cuda_add_field_inplace(gpu.h_therm.x, gpu.h_eff.x, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_therm.y, gpu.h_eff.y, n, stream);
        fullmag_cuda_add_field_inplace(gpu.h_therm.z, gpu.h_eff.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK thermal h_eff accumulation", reason)) {
            return false;
        }
    }
    return true;
}

} // namespace fullmag::fem
