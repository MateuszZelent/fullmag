/*
 * GPU CUDA Zeeman kernels module header.
 *
 * Declares exported FEM CUDA wrappers for external-field Zeeman energy
 * evaluation.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Per-block Zeeman energy partials:
/// -mu0 * Ms_i * (m_i . H_ext_i) * lumped_mass_i.
void fullmag_cuda_external_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *h_ext_x,
    const double *h_ext_y,
    const double *h_ext_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_sums,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
