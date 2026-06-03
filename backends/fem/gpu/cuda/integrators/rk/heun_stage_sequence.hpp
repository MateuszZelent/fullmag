/*
 * GPU CUDA Heun stage sequence module header.
 *
 * Declares the Heun accept sequence used by the device-resident RK attempt
 * scheduler. Generic attempt backup, FSAL reuse, common predictors,
 * normalization, and non-Heun RK sequences remain outside this module.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

struct Context;

void gpu_rk_run_heun_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double active_dt);

} // namespace fullmag::fem
#endif
