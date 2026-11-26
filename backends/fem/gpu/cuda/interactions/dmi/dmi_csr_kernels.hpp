#pragma once

/*
 * GPU CUDA sparse CSR DMI kernels module header.
 *
 * Declares deterministic row-wise CSR DMI field/energy SpMV and compensated
 * double-double polarized energy increment wrappers for arbitrary H1 P1 meshes.
 */

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME && \
    (!defined(__has_include) || __has_include(<cuda_runtime.h>))
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Deterministic row-wise CSR DMI field projection and optional per-block energy.
/// Pass energy_block_sums == nullptr on intermediate RK stages to skip energy reduction.
void fullmag_cuda_dmi_csr_field_energy(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_dx,
    const double *csr_dy,
    const double *csr_dz,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_block_sums,
    double uniform_ms,
    int node_count,
    cudaStream_t stream = nullptr);

/// Periodic class-reduced P^T D P CSR DMI field projection and optional per-block energy.
/// periodic_reduced_representative_nodes is reduced-row-indexed (len == reduced_row_count).
void fullmag_cuda_dmi_csr_periodic_field_energy(
    const uint32_t *reduced_row_offsets,
    const uint32_t *reduced_col_indices,
    const double *reduced_dx,
    const double *reduced_dy,
    const double *reduced_dz,
    const double *reduced_mass,
    const uint32_t *periodic_reduced_node,
    const uint32_t *periodic_reduced_representative_nodes,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const uint8_t *magnetic_node_mask,
    double *reduced_rx,
    double *reduced_ry,
    double *reduced_rz,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_block_sums,
    double uniform_ms,
    int reduced_row_count,
    int node_count,
    cudaStream_t stream = nullptr);

/// Polarized CSR DMI energy increment E(m1)-E(m0) and conservative absolute scale S_abs
/// using double-double compensated arithmetic (supports both direct and periodic CSR).
/// When non-null, periodic_reduced_representative_nodes is reduced-row-indexed (len == row_count).
void fullmag_cuda_dmi_csr_energy_difference(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_dx,
    const double *csr_dy,
    const double *csr_dz,
    const double *m0x,
    const double *m0y,
    const double *m0z,
    const double *m1x,
    const double *m1y,
    const double *m1z,
    double *delta_block_sums,
    double *absolute_block_sums,
    int row_count,
    cudaStream_t stream = nullptr,
    const uint32_t *periodic_reduced_representative_nodes = nullptr);

} // namespace fullmag::fem
#endif
