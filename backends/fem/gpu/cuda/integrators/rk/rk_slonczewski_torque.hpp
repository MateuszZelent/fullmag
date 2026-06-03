/*
 * GPU CUDA RK Slonczewski torque module header.
 *
 * Declares the Slonczewski STT direct-torque contribution for the
 * device-resident RK RHS. Generic direct-torque orchestration remains in
 * rk_direct_torques.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_add_slonczewski_torque(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    std::string &reason);

} // namespace fullmag::fem
#endif
