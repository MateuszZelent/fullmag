/*
 * GPU CUDA STT kernels module header.
 *
 * Declares exported FEM CUDA wrappers for Slonczewski CPP and Zhang-Li CIP
 * spin-transfer torque contributions to the device-resident RK RHS.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Add Slonczewski spin-transfer torque to an already assembled RHS.
void fullmag_cuda_add_slonczewski_stt_rhs(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *alpha,
    const uint8_t *magnetic_node_mask,
    double *dmx,
    double *dmy,
    double *dmz,
    double *block_max_rhs,
    double current_density_mag,
    double current_sign,
    double gamma_mu0,
    double uniform_alpha,
    double free_layer_thickness,
    double degree,
    double lambda,
    double epsilon_prime,
    double px,
    double py,
    double pz,
    int N,
    cudaStream_t stream = nullptr);

/// Add Zhang-Li spin-transfer torque using tetrahedral element gradients.
void fullmag_cuda_add_zhang_li_stt_rhs(
    const double *nodes_xyz,
    const uint32_t *elements,
    const uint8_t *magnetic_element_mask,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *alpha,
    const uint8_t *magnetic_node_mask,
    double *work_x,
    double *work_y,
    double *work_z,
    double *node_weight,
    double *dmx,
    double *dmy,
    double *dmz,
    double *block_max_rhs,
    double current_x,
    double current_y,
    double current_z,
    double degree,
    double beta,
    double uniform_alpha,
    int element_count,
    int node_count,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
