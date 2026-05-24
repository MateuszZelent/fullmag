/*
 * GPU CUDA RK DMI field contributions module header.
 *
 * Declares per-stage interfacial and bulk DMI field generation for the
 * device-resident RK RHS. H_eff accumulation remains in rk_effective_field.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_dmi_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
