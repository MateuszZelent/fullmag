/*
 * GPU CUDA magnetoelastic kernels module header.
 *
 * Declares exported FEM CUDA wrappers for prescribed-strain magnetoelastic
 * field and energy contributions in the device-resident RK path.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Prescribed-strain magnetoelastic field and per-block energy partials.
void fullmag_cuda_magnetoelastic_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    const double *per_node_strain_voigt,
    double *h_mel_x,
    double *h_mel_y,
    double *h_mel_z,
    double *block_sums,
    double b1,
    double b2,
    double e11,
    double e22,
    double e33,
    double tensor_e23,
    double tensor_e13,
    double tensor_e12,
    bool use_per_node_strain,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
