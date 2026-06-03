/*
 * GPU CUDA RK stage schedule module header.
 *
 * Declares one accepted/rejected RK attempt over device-resident stage buffers.
 * Adaptive accept/reject policy remains outside this module; low-level
 * predictor and accept kernels live in dedicated predictor and per-integrator
 * accept modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

struct GpuRkStageAttemptResult {
    uint32_t rhs_evaluations = 0;
    bool fsal_reused = false;
};

bool gpu_rk_run_stage_attempt(
    Context &ctx,
    cudaStream_t stream,
    int n,
    bool is_heun,
    bool is_rk4,
    bool is_rk23,
    bool is_rk45,
    bool adaptive,
    bool fsal_method,
    double active_dt,
    GpuRkStageAttemptResult &result,
    std::string &reason);

} // namespace fullmag::fem
#endif
