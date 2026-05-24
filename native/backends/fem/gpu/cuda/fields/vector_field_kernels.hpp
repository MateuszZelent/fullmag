/*
 * GPU CUDA vector field kernels module header.
 *
 * Declares exported FEM CUDA wrappers for shared vector field operations.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Normalize each (mx,my,mz) to unit length (SoA layout).
void fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    int N, cudaStream_t stream = nullptr);

/// h_eff = h_ex + h_demag [+ h_ext] (element-wise, SoA component).
void fullmag_cuda_accumulate_heff(
    const double *h_ex, const double *h_demag, const double *h_ext,
    double *h_eff,
    int N, bool has_ext, cudaStream_t stream = nullptr);

/// Zero a sparse index list in a device vector.
void fullmag_cuda_zero_indexed_values(
    double *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream = nullptr);

/// h_accum += h_add (component-wise).
void fullmag_cuda_add_field_inplace(
    const double *h_add,
    double *h_accum,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif // FULLMAG_HAS_CUDA_RUNTIME
