/*
 * GPU CUDA prescribed-SOT kernel module.
 *
 * Declares the device-resident local SI/Gilbert source used by the FEM RK
 * direct-torque path. Transport/SHE equations remain outside this module.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Add prescribed_sot.fullmag.v1 to an already assembled device RHS.
void fullmag_cuda_add_prescribed_sot_rhs(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *alpha,
    const uint8_t *magnetic_node_mask,
    const uint8_t *active_node_mask,
    double *dmx,
    double *dmy,
    double *dmz,
    double *block_max_rhs,
    double current_density_am2,
    double xi_dl,
    double xi_fl,
    double envelope_value,
    double gamma0,
    double thickness,
    double sigma_x,
    double sigma_y,
    double sigma_z,
    int node_count,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
