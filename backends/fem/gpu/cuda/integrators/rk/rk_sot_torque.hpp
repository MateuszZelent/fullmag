/* GPU CUDA RK prescribed-SOT direct-torque module. */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_add_prescribed_sot_torque(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    std::string &reason);

} // namespace fullmag::fem
#endif
