/*
 * GPU CUDA RK attempt loop module header.
 *
 * Declares the fixed/adaptive accepted-attempt loop used by the device-
 * resident RK stepper. Step preflight and accepted-step finalization remain
 * in rk_step_preflight.hpp/.cu and rk_final_refresh.hpp/.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "cpu/mfem/integrators/rk_tableau.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

struct GpuRkAcceptedAttemptResult {
    double active_dt = 0.0;
    double error_estimate = 0.0;
    double suggested_dt = 0.0;
    uint32_t rejected_attempts = 0;
    uint32_t total_stage_rhs_evaluations = 0;
    bool fsal_reused = false;
};

bool gpu_rk_run_accepted_attempt_loop(
    Context &ctx,
    const ExplicitTableau &tableau,
    cudaStream_t stream,
    int n,
    int blocks,
    bool is_heun,
    bool is_rk4,
    bool is_rk23,
    bool is_rk45,
    bool adaptive,
    bool fsal_method,
    double dt_seconds,
    GpuRkAcceptedAttemptResult &result,
    std::string &reason);

} // namespace fullmag::fem
#endif
