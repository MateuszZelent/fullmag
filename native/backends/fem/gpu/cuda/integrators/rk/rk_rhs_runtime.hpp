/*
 * GPU CUDA RK RHS runtime module header.
 *
 * Declares device-resident RHS assembly helpers used by the RK stepper. Stage
 * scheduling remains in rk_step.cu; final statistics live in rk_step_stats.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx);

bool gpu_rk_compute_rhs_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    const char *label,
    std::string &reason);

} // namespace fullmag::fem
#endif
