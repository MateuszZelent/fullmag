/*
 * GPU CUDA RK final energy reductions module header.
 *
 * Declares final energy reductions for the device-resident RK stats path.
 * Scalar slot layout and stats publication remain in rk_step_stats.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_final_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
