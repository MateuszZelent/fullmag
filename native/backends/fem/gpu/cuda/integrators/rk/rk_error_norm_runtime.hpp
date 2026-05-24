/*
 * GPU CUDA RK adaptive error-norm runtime module header.
 *
 * Declares device-resident embedded RK adaptive error-norm reductions used by
 * the RK stepper. Adaptive policy, transitional host decision readback, and
 * reject restore remain in dedicated RK modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "cpu/mfem/integrators/rk_tableau.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_adaptive_error_norm_device(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
