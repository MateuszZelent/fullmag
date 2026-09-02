#pragma once

#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <cstdint>

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME
void fullmag_cuda_fem_bem_apply(
    const uint32_t *near_row_offsets,
    const uint32_t *near_column_indices,
    const double *near_values,
    const AcaHMatrixDemagBemFarBlock *far_blocks,
    const double *far_u,
    const double *far_v,
    const uint32_t *boundary_permutation,
    const uint32_t *boundary_tdofs,
    const double *u1_full,
    double *u2_boundary,
    int boundary_rows,
    int far_block_count,
    int max_rank,
    cudaStream_t stream);

void fullmag_cuda_fem_bem_build_dirichlet_rhs(
    const uint32_t *row_offsets,
    const uint32_t *column_indices,
    const double *values,
    const int32_t *boundary_tdof_to_row,
    const double *boundary_values,
    double *rhs,
    int rows,
    cudaStream_t stream);

void fullmag_cuda_fem_bem_combine_potentials(
    const double *u1,
    const double *u2,
    double *total,
    int rows,
    cudaStream_t stream);
#endif

} // namespace fullmag::fem
