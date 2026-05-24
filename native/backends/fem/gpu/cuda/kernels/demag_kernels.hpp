/*
 * GPU CUDA demag kernels module header.
 *
 * Declares exported FEM CUDA wrappers used by the strict device Poisson demag
 * stage for RHS assembly, scalar-potential recovery, and demag energy blocks.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Device Poisson demag RHS: b = Bx mx + By my + Bz mz.
void fullmag_cuda_demag_rhs_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values_x,
    const double *csr_values_y,
    const double *csr_values_z,
    const double *mx,
    const double *my,
    const double *mz,
    double *rhs,
    int rows,
    cudaStream_t stream = nullptr);

/// Device Poisson demag recovery: h_component = G_component u.
void fullmag_cuda_demag_recovery_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *u,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream = nullptr);

/// Per-block demag energy partials:
/// -0.5 * mu0 * Ms_i * (m_i . H_demag_i) * lumped_mass_i.
void fullmag_cuda_demag_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *h_demag_x,
    const double *h_demag_y,
    const double *h_demag_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_sums,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
