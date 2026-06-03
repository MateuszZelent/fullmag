/*
 * GPU CUDA RK anisotropy local field module header.
 *
 * Declares uniaxial and cubic anisotropy local-field contributions for the
 * device-resident RK RHS. Generic local-field orchestration remains in
 * rk_local_fields.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_anisotropy_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
