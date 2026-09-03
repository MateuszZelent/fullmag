/*
 * GPU CUDA RK effective field accumulation module header.
 *
 * Declares H_eff accumulation for the device-resident RK RHS. Interaction
 * field generation and direct torque RHS terms remain in their owning modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

struct EffectiveFieldApplyMask {
    bool has_external = false;
    bool uniaxial_anisotropy = false;
    bool cubic_anisotropy = false;
    bool interfacial_dmi = false;
    bool bulk_dmi = false;
    bool magnetoelastic = false;
    bool thermal = false;
};

struct EffectiveFieldComponentPointers {
    const double *h_ex = nullptr;
    const double *h_demag = nullptr;
    const double *h_ext = nullptr;
    const double *h_ani = nullptr;
    const double *h_cubic_ani = nullptr;
    const double *h_dmi = nullptr;
    const double *h_bulk_dmi = nullptr;
    const double *h_mel = nullptr;
    const double *h_therm = nullptr;
};

struct EffectiveFieldInputs {
    EffectiveFieldComponentPointers x;
    EffectiveFieldComponentPointers y;
    EffectiveFieldComponentPointers z;
    double *out_h_eff_x = nullptr;
    double *out_h_eff_y = nullptr;
    double *out_h_eff_z = nullptr;
    int n = 0;
    EffectiveFieldApplyMask mask{};
};

bool gpu_rk_accumulate_effective_field_fused(
    const EffectiveFieldInputs &inputs,
    cudaStream_t stream,
    std::string &reason);

bool gpu_rk_accumulate_effective_field(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    const char *base_label,
    std::string &reason);

} // namespace fullmag::fem
#endif
