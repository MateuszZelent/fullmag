/*
 * GPU CUDA exchange kernels module header.
 *
 * Declares exported FEM CUDA wrappers for the legacy sparse exchange field and
 * exchange energy kernels used by the device-resident RK path.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Legacy assembled FEM exchange: h_ex = -2/(mu0*Ms) * M_lumped^-1 * K * m.
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

/// Per-block exchange energy partials for legacy sparse operator:
/// sum_i m_i · (K m)_i across x/y/z components.
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
