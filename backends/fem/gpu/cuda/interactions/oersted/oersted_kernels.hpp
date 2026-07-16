/*
 * GPU CUDA Oersted kernels module header.
 *
 * Declares exported FEM CUDA wrappers for scaled Oersted effective-field
 * accumulation.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

/// h_accum += scale * h_add (component-wise).
void fullmag_cuda_add_scaled_field_inplace(
    const double *h_add,
    double *h_accum,
    double scale,
    int N,
    cudaStream_t stream = nullptr);

/// h_out = scale * h_basis (component-wise).
void fullmag_cuda_scale_field(
    const double *h_basis,
    double *h_out,
    double scale,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
