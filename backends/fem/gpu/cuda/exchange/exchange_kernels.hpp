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

} // namespace fullmag::fem
#endif
