/*
 * GPU CUDA RK field metric final reductions module header.
 *
 * Declares final H_eff, H_demag, and torque metric reductions for the
 * device-resident RK stats path. Observable orchestration remains in
 * rk_observable_reductions.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_final_field_metric_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
