/*
 * GPU CUDA exchange kernels module header.
 *
 * Declares exported FEM CUDA wrappers for the legacy sparse exchange field and
 * exchange energy kernels used by the device-resident RK path.
 *
 * Physics contract:
 * - field path: H_ex = -2 M_lumped^-1 K_A m / (mu0 Ms),
 * - energy path: E_ex = sum_i m_i . (K_A m)_i across x/y/z components.
 *
 * The current GPU RK exchange realization is the legacy sparse/lumped path. It
 * does not implement the CPU/MFEM consistent-mass projection policy.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>
#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

namespace fullmag::fem {

/// Legacy assembled FEM exchange:
/// h_ex = -2/(mu0*Ms) * M_lumped^-1 * K * m.
/// Nonmagnetic FEM nodes are skipped when magnetic_node_mask is present.
void fullmag_cuda_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *m_component,
    const double *ms,
    const double *inv_lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream = nullptr,
    SparseApplyVariant variant = SparseApplyVariant::ScalarRow);

/// Fused non-periodic legacy sparse exchange for all three SoA components.
/// The row scale is precomputed once per runtime coefficient upload/setup.
void fullmag_cuda_legacy_sparse_exchange_xyz(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *mx,
    const double *my,
    const double *mz,
    const double *row_scale,
    const double *inv_lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *hx,
    double *hy,
    double *hz,
    int rows,
    cudaStream_t stream = nullptr,
    SparseApplyVariant variant = SparseApplyVariant::ScalarRow);

/// Build -2/(mu0*Ms_i) once per exchange setup. The inverse lumped mass is
/// applied after the compensated CSR sum to preserve the legacy operation
/// order and roundoff envelope.
void fullmag_cuda_prepare_exchange_row_scale(
    const double *ms,
    double *row_scale,
    int rows,
    cudaStream_t stream = nullptr);

/// Periodic assembled FEM exchange with CPU lumped periodic projection:
/// reduced_rhs[c] = sum_{i in class c} (K m)_i,
/// reduced_mass[c] = sum_{i in class c} M_lumped_i,
/// H_i = -2 reduced_rhs[class(i)] / (mu0 Ms_rep(class(i)) reduced_mass[class(i)]).
void fullmag_cuda_periodic_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *m_component,
    const double *ms,
    const double *lumped_mass,
    const uint32_t *periodic_reduced_node,
    const uint32_t *periodic_representative_nodes,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream = nullptr);

/// Apply the precomputed class-level periodic CSR in O(nnz_reduced + N): one
/// reduced XYZ apply followed by a deterministic representative lift.
void fullmag_cuda_periodic_reduced_exchange_xyz(
    const uint32_t *reduced_row_offsets,
    const uint32_t *reduced_col_indices,
    const double *reduced_values,
    const double *reduced_mass,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const uint32_t *periodic_reduced_node,
    const uint32_t *periodic_representative_nodes,
    const uint8_t *magnetic_node_mask,
    double *reduced_hx,
    double *reduced_hy,
    double *reduced_hz,
    double *hx,
    double *hy,
    double *hz,
    int rows,
    int reduced_rows,
    cudaStream_t stream = nullptr);

/// Per-block exchange energy partials for the class-level periodic CSR.
/// The reduced rows and representative map preserve the same graph-Laplacian
/// difference semantics as the full assembled operator without scanning every
/// source row in each periodic class.
void fullmag_cuda_periodic_reduced_exchange_energy_blocks(
    const uint32_t *reduced_row_offsets,
    const uint32_t *reduced_col_indices,
    const double *reduced_values,
    const uint32_t *periodic_reduced_representative_nodes,
    const double *mx,
    const double *my,
    const double *mz,
    double *block_sums,
    int reduced_rows,
    cudaStream_t stream = nullptr);

/// Per-block exchange energy partials for legacy sparse operator:
/// sum_i m_i · (K m)_i across x/y/z components.
/// GPU RK planning requires exchange to be enabled before this reduction is
/// used, so uploaded CSR exchange state is a precondition.
void fullmag_cuda_legacy_sparse_exchange_energy_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *mx,
    const double *my,
    const double *mz,
    double *block_sums,
    int rows,
    cudaStream_t stream = nullptr);

void fullmag_cuda_legacy_sparse_exchange_difference_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *current_mx, const double *current_my, const double *current_mz,
    const double *trial_mx, const double *trial_my, const double *trial_mz,
    double *block_delta,
    double *block_absolute_terms,
    int rows,
    cudaStream_t stream = nullptr);

/// Per-block polarized exchange-energy differences for the class-level
/// periodic CSR.  The compensated edge arithmetic is shared with the full
/// compatibility path so Armijo roundoff bounds remain comparable.
void fullmag_cuda_periodic_reduced_exchange_difference_blocks(
    const uint32_t *reduced_row_offsets,
    const uint32_t *reduced_col_indices,
    const double *reduced_values,
    const uint32_t *periodic_reduced_representative_nodes,
    const double *current_mx,
    const double *current_my,
    const double *current_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    double *block_delta,
    double *block_absolute_terms,
    int reduced_rows,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
