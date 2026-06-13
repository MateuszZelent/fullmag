/*
 * GPU CUDA anisotropy kernels module header.
 *
 * Declares exported FEM CUDA wrappers for local uniaxial and cubic anisotropy
 * field accumulation and energy evaluation.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Uniaxial anisotropy field and per-block energy partials.
void fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *ku,
    const double *ku2,
    const double *axis_x_field,
    const double *axis_y_field,
    const double *axis_z_field,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_ani_x,
    double *h_ani_y,
    double *h_ani_z,
    double *block_sums,
    double uniform_ku,
    double uniform_ku2,
    double axis_x,
    double axis_y,
    double axis_z,
    bool use_ku_field,
    bool use_ku2_field,
    bool use_axis_field,
    int N,
    cudaStream_t stream = nullptr);

/// Cubic anisotropy field and per-block energy partials.
void fullmag_cuda_cubic_anisotropy_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *kc1,
    const double *kc2,
    const double *kc3,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_cubic_x,
    double *h_cubic_y,
    double *h_cubic_z,
    double *block_sums,
    double uniform_kc1,
    double uniform_kc2,
    double uniform_kc3,
    double c1x,
    double c1y,
    double c1z,
    double c2x,
    double c2y,
    double c2z,
    bool use_kc1_field,
    bool use_kc2_field,
    bool use_kc3_field,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
