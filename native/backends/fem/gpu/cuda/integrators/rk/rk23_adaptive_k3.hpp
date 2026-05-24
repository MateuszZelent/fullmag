/*
 * GPU CUDA RK23 adaptive k3 module header.
 *
 * Declares the post-accept Bogacki-Shampine k3 RHS refresh used by the
 * adaptive RK23 error estimator. RK23 accept sequencing, adaptive PI policy,
 * error-norm kernels, and accepted-step finalization remain outside this
 * module.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_rk23_adaptive_k3(
    Context &ctx,
    cudaStream_t stream,
    int n,
    uint32_t &stage_rhs_evaluations,
    std::string &reason);

} // namespace fullmag::fem
#endif
