/*
 * GPU CUDA RK direct torque module header.
 *
 * Declares direct tau contributions for the device-resident RK RHS. Effective
 * field composition and LLG field RHS evaluation remain in their owning
 * modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_add_direct_torques(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    std::string &reason);

} // namespace fullmag::fem
#endif
