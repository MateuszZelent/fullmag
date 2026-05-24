/*
 * GPU CUDA RK demag dispatch module header.
 *
 * Declares per-stage demag dispatch used by the RK RHS runtime. Strict device
 * Poisson and explicit hybrid CPU Poisson compatibility routing live behind
 * this boundary.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_compute_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason);

} // namespace fullmag::fem
#endif
