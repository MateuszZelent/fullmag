/*
 * GPU CUDA RK final observable reductions module header.
 *
 * Declares final field-metric, torque, and magnetization reductions for the
 * device-resident RK stats path. Scalar readback and stats publication remain
 * in rk_step_stats.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_final_observable_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
