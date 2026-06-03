/*
 * GPU CUDA RK component copy module header.
 *
 * Declares component-field device-copy and device-to-host AoS download helpers
 * used by the device-resident RK stepper. Scalar readback remains in
 * rk_scalar_readback.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

bool gpu_rk_copy_component_device(
    const FemGpuComponentField &src,
    FemGpuComponentField &dst,
    uint64_t node_count,
    cudaStream_t stream,
    const char *operation,
    std::string &reason);

bool gpu_rk_download_component_device_to_aos(
    Context &ctx,
    const FemGpuComponentField &src,
    std::vector<double> &out_xyz,
    cudaStream_t stream,
    const char *operation,
    std::string &reason);

} // namespace fullmag::fem
#endif
