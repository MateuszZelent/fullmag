/*
 * GPU CUDA RK adaptive decision readback module header.
 *
 * Declares the transitional host-side adaptive accept/reject decision boundary
 * for embedded RK methods. Device error-norm reductions remain in
 * rk_error_norm_runtime.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

struct GpuAdaptiveDecisionReadback {
    GpuAdaptiveResult adaptive_result;
    double error_norm;
};

bool gpu_rk_read_adaptive_error_norm_decision_host(
    Context &ctx,
    cudaStream_t stream,
    GpuAdaptiveDecisionReadback &decision,
    std::string &reason);

} // namespace fullmag::fem
#endif
