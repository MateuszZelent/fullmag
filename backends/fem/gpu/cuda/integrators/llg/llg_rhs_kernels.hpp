/*
 * GPU CUDA LLG RHS kernels module header.
 *
 * Declares exported FEM CUDA wrappers for fused LLG right-hand-side kernels.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

/// Fused LLG RHS: dm/dt = -gamma_bar (p m x H + alpha m x (m x H)),
/// per-block max reduction.
/// `precession_enabled=false` sets p=0 for pure damping relaxation.
void fullmag_cuda_llg_rhs_fused(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    double *dmx, double *dmy, double *dmz,
    double *block_max_rhs,
    const double *alpha_field,
    double gamma, double alpha,
    bool use_alpha_field,
    bool precession_enabled,
    int N, cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif // FULLMAG_HAS_CUDA_RUNTIME
