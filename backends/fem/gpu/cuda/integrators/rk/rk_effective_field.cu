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

__global__ void fused_effective_field_kernel(
    const double *__restrict__ hex_x, const double *__restrict__ hex_y, const double *__restrict__ hex_z,
    const double *__restrict__ hdem_x, const double *__restrict__ hdem_y, const double *__restrict__ hdem_z,
    const double *__restrict__ hext_x, const double *__restrict__ hext_y, const double *__restrict__ hext_z,
    const double *__restrict__ hani_x, const double *__restrict__ hani_y, const double *__restrict__ hani_z,
    const double *__restrict__ hcub_x, const double *__restrict__ hcub_y, const double *__restrict__ hcub_z,
    const double *__restrict__ hdmi_x, const double *__restrict__ hdmi_y, const double *__restrict__ hdmi_z,
    const double *__restrict__ hbdmi_x, const double *__restrict__ hbdmi_y, const double *__restrict__ hbdmi_z,
    const double *__restrict__ hmel_x, const double *__restrict__ hmel_y, const double *__restrict__ hmel_z,
    const double *__restrict__ hth_x, const double *__restrict__ hth_y, const double *__restrict__ hth_z,
    double *__restrict__ heff_x, double *__restrict__ heff_y, double *__restrict__ heff_z,
    int n,
    EffectiveFieldApplyMask mask)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    double x = (hex_x != nullptr ? hex_x[i] : 0.0) + (hdem_x != nullptr ? hdem_x[i] : 0.0);
    double y = (hex_y != nullptr ? hex_y[i] : 0.0) + (hdem_y != nullptr ? hdem_y[i] : 0.0);
    double z = (hex_z != nullptr ? hex_z[i] : 0.0) + (hdem_z != nullptr ? hdem_z[i] : 0.0);

    if (mask.has_external && hext_x != nullptr) {
        x += hext_x[i]; y += hext_y[i]; z += hext_z[i];
    }
    if (mask.uniaxial_anisotropy && hani_x != nullptr) {
        x += hani_x[i]; y += hani_y[i]; z += hani_z[i];
    }
    if (mask.cubic_anisotropy && hcub_x != nullptr) {
        x += hcub_x[i]; y += hcub_y[i]; z += hcub_z[i];
    }
    if (mask.interfacial_dmi && hdmi_x != nullptr) {
        x += hdmi_x[i]; y += hdmi_y[i]; z += hdmi_z[i];
    }
    if (mask.bulk_dmi && hbdmi_x != nullptr) {
        x += hbdmi_x[i]; y += hbdmi_y[i]; z += hbdmi_z[i];
    }
    if (mask.magnetoelastic && hmel_x != nullptr) {
        x += hmel_x[i]; y += hmel_y[i]; z += hmel_z[i];
    }
    if (mask.thermal && hth_x != nullptr) {
        x += hth_x[i]; y += hth_y[i]; z += hth_z[i];
    }

    heff_x[i] = x;
    heff_y[i] = y;
    heff_z[i] = z;
}

} // namespace

bool gpu_rk_accumulate_effective_field_fused(
    const EffectiveFieldInputs &inputs,
    cudaStream_t stream,
    std::string &reason)
{
    if (inputs.n <= 0) {
        return true;
    }
    if (inputs.out_h_eff_x == nullptr || inputs.out_h_eff_y == nullptr || inputs.out_h_eff_z == nullptr) {
        reason = "fused effective field output pointer is null";
        return false;
    }
    constexpr int kBlockSize = 256;
    const int blocks = (inputs.n + kBlockSize - 1) / kBlockSize;
    fused_effective_field_kernel<<<blocks, kBlockSize, 0, stream>>>(
        inputs.x.h_ex, inputs.y.h_ex, inputs.z.h_ex,
        inputs.x.h_demag, inputs.y.h_demag, inputs.z.h_demag,
        inputs.x.h_ext, inputs.y.h_ext, inputs.z.h_ext,
        inputs.x.h_ani, inputs.y.h_ani, inputs.z.h_ani,
        inputs.x.h_cubic_ani, inputs.y.h_cubic_ani, inputs.z.h_cubic_ani,
        inputs.x.h_dmi, inputs.y.h_dmi, inputs.z.h_dmi,
        inputs.x.h_bulk_dmi, inputs.y.h_bulk_dmi, inputs.z.h_bulk_dmi,
        inputs.x.h_mel, inputs.y.h_mel, inputs.z.h_mel,
        inputs.x.h_therm, inputs.y.h_therm, inputs.z.h_therm,
        inputs.out_h_eff_x, inputs.out_h_eff_y, inputs.out_h_eff_z,
        inputs.n,
        inputs.mask);
    return cuda_launch_ok("launch fused GPU RK effective field accumulation", reason);
}

bool gpu_rk_accumulate_effective_field(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    const char *base_label,
    std::string &reason)
{
    (void)base_label;
    auto &gpu = ctx.gpu_state.device;
    EffectiveFieldInputs inputs;
    inputs.n = n;
    inputs.out_h_eff_x = gpu.fields.h_eff.x;
    inputs.out_h_eff_y = gpu.fields.h_eff.y;
    inputs.out_h_eff_z = gpu.fields.h_eff.z;

    inputs.x.h_ex = gpu.fields.h_ex.x;
    inputs.y.h_ex = gpu.fields.h_ex.y;
    inputs.z.h_ex = gpu.fields.h_ex.z;

    inputs.x.h_demag = gpu.fields.h_demag.x;
    inputs.y.h_demag = gpu.fields.h_demag.y;
    inputs.z.h_demag = gpu.fields.h_demag.z;

    inputs.mask.has_external = ctx.zeeman.has_external_field;
    inputs.x.h_ext = gpu.fields.h_ext.x;
    inputs.y.h_ext = gpu.fields.h_ext.y;
    inputs.z.h_ext = gpu.fields.h_ext.z;

    inputs.mask.uniaxial_anisotropy = ctx.anisotropy.uniaxial_enabled;
    inputs.x.h_ani = gpu.fields.h_ani.x;
    inputs.y.h_ani = gpu.fields.h_ani.y;
    inputs.z.h_ani = gpu.fields.h_ani.z;

    inputs.mask.cubic_anisotropy = ctx.anisotropy.cubic_enabled;
    inputs.x.h_cubic_ani = gpu.fields.h_cubic_ani.x;
    inputs.y.h_cubic_ani = gpu.fields.h_cubic_ani.y;
    inputs.z.h_cubic_ani = gpu.fields.h_cubic_ani.z;

    inputs.mask.interfacial_dmi = ctx.dmi.interfacial_enabled;
    inputs.x.h_dmi = gpu.fields.h_dmi.x;
    inputs.y.h_dmi = gpu.fields.h_dmi.y;
    inputs.z.h_dmi = gpu.fields.h_dmi.z;

    inputs.mask.bulk_dmi = ctx.dmi.bulk_enabled;
    inputs.x.h_bulk_dmi = gpu.fields.h_bulk_dmi.x;
    inputs.y.h_bulk_dmi = gpu.fields.h_bulk_dmi.y;
    inputs.z.h_bulk_dmi = gpu.fields.h_bulk_dmi.z;

    inputs.mask.magnetoelastic = ctx.magnetoelastic.enabled;
    inputs.x.h_mel = gpu.fields.h_mel.x;
    inputs.y.h_mel = gpu.fields.h_mel.y;
    inputs.z.h_mel = gpu.fields.h_mel.z;

    inputs.mask.thermal = (ctx.thermal_brown.temperature > 0.0);
    inputs.x.h_therm = gpu.fields.h_therm.x;
    inputs.y.h_therm = gpu.fields.h_therm.y;
    inputs.z.h_therm = gpu.fields.h_therm.z;

    if (!gpu_rk_accumulate_effective_field_fused(inputs, stream, reason)) {
        return false;
    }
    if (!gpu_regional_field_drive_materialize_and_accumulate(
            ctx, stream, n, evaluation_time_s, true, reason)) {
        return false;
    }
    if (!gpu_rk_accumulate_oersted_field(ctx, stream, n, evaluation_time_s, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
