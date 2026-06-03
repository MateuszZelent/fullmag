/*
 * GPU CUDA RK local field contributions module header.
 *
 * Declares per-stage local effective-field contribution generation for the
 * device-resident RK RHS. RHS orchestration remains in rk_rhs_runtime.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_local_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
