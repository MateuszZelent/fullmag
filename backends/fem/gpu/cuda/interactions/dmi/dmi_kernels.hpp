/*
 * GPU CUDA DMI kernels module header.
 *
 * Declares exported FEM CUDA wrappers for interfacial and bulk DMI weak
 * residual field projection and energy evaluation.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// DMI weak-residual field projection and energy for linear tetrahedra.
void fullmag_cuda_dmi_field_energy(
    const double *nodes_xyz,
    const uint32_t *elements,
    const uint8_t *magnetic_element_mask,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *d_field,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *residual_x,
    double *residual_y,
    double *residual_z,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_out,
    double uniform_ms,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count,
    int node_count,
    cudaStream_t stream = nullptr);

/// Polarized DMI increment E(m1)-E(m0) on linear tetrahedra, one value per element.
void fullmag_cuda_dmi_energy_difference(
    const double *nodes_xyz, const uint32_t *elements, const uint8_t *magnetic_element_mask,
    const double *m0x, const double *m0y, const double *m0z,
    const double *m1x, const double *m1y, const double *m1z,
    const double *d_field, double *element_delta,
    double *element_absolute_terms,
    double uniform_d, double nx, double ny, double nz,
    bool use_d_field, bool bulk_mode, int element_count,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
