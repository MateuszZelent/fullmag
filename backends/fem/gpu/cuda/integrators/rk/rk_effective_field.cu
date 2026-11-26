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
#include "gpu/cuda/interactions/zeeman/regional_field_kernels.cuh"

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
    double evaluation_time_s,
    const char *base_label,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    // The resolved plan, not buffer allocation, owns whether the uniform
    // external field participates in H_eff. Regional drives are materialized
    // separately below (lazy zeroed when inactive) and summed in the fused pass.
    const bool has_external_field = ctx.zeeman.has_external_field;
    if (!gpu_regional_field_drive_materialize_and_accumulate(
            ctx, stream, n, evaluation_time_s, false, reason)) {
        return false;
    }

    FemGpuHeffAccumulateTerms terms{};
    terms.h_ex_x = gpu.fields.h_ex.x;
    terms.h_ex_y = gpu.fields.h_ex.y;
    terms.h_ex_z = gpu.fields.h_ex.z;
    terms.h_demag_x = gpu.fields.h_demag.x;
    terms.h_demag_y = gpu.fields.h_demag.y;
    terms.h_demag_z = gpu.fields.h_demag.z;
    if (has_external_field) {
        terms.h_ext_x = gpu.fields.h_ext.x;
        terms.h_ext_y = gpu.fields.h_ext.y;
        terms.h_ext_z = gpu.fields.h_ext.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_EXT;
    }
    if (gpu.fields.regional_drive_count > 0) {
        terms.h_drive_x = gpu.fields.h_drive.x;
        terms.h_drive_y = gpu.fields.h_drive.y;
        terms.h_drive_z = gpu.fields.h_drive.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_DRIVE;
    }
    if (ctx.anisotropy.uniaxial_enabled) {
        terms.h_ani_x = gpu.fields.h_ani.x;
        terms.h_ani_y = gpu.fields.h_ani.y;
        terms.h_ani_z = gpu.fields.h_ani.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_ANI;
    }
    if (ctx.anisotropy.cubic_enabled) {
        terms.h_cubic_x = gpu.fields.h_cubic_ani.x;
        terms.h_cubic_y = gpu.fields.h_cubic_ani.y;
        terms.h_cubic_z = gpu.fields.h_cubic_ani.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_CUBIC;
    }
    if (ctx.dmi.interfacial_enabled || ctx.dmi.rotated_interfacial_enabled) {
        terms.h_dmi_x = gpu.fields.h_dmi.x;
        terms.h_dmi_y = gpu.fields.h_dmi.y;
        terms.h_dmi_z = gpu.fields.h_dmi.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_DMI;
    }
    if (ctx.dmi.bulk_enabled) {
        terms.h_bulk_dmi_x = gpu.fields.h_bulk_dmi.x;
        terms.h_bulk_dmi_y = gpu.fields.h_bulk_dmi.y;
        terms.h_bulk_dmi_z = gpu.fields.h_bulk_dmi.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_BULK_DMI;
    }
    if (!gpu_rk_prepare_oersted_heff_term(ctx, evaluation_time_s, terms, reason)) {
        return false;
    }
    if (ctx.magnetoelastic.enabled) {
        terms.h_mel_x = gpu.fields.h_mel.x;
        terms.h_mel_y = gpu.fields.h_mel.y;
        terms.h_mel_z = gpu.fields.h_mel.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_MEL;
    }
    if (ctx.thermal_brown.temperature > 0.0) {
        terms.h_therm_x = gpu.fields.h_therm.x;
        terms.h_therm_y = gpu.fields.h_therm.y;
        terms.h_therm_z = gpu.fields.h_therm.z;
        terms.active_mask |= FEM_GPU_HEFF_TERM_THERM;
    }

    fullmag_cuda_accumulate_heff_fused_xyz(
        terms,
        gpu.fields.h_eff.x,
        gpu.fields.h_eff.y,
        gpu.fields.h_eff.z,
        n,
        stream);
    return cuda_launch_ok(base_label, reason);
}

} // namespace fullmag::fem
