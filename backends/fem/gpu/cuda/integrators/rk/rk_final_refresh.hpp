/*
 * GPU CUDA RK accepted-step final refresh module header.
 *
 * Declares accepted-step final RHS/H_eff refresh, FSAL propagation, max-RHS
 * reduction, and base step-stat publication. Stage scheduling remains in
 * rk_step.cu; final scalar energy/stat reductions remain in rk_step_stats.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "fullmag_fem.h"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_finalize_accepted_step(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    bool fsal_method,
    double active_dt,
    double error_estimate,
    double suggested_dt,
    uint32_t rejected_attempts,
    uint32_t total_stage_rhs_evaluations,
    bool fsal_reused,
    bool reuse_bs23_fsal_rhs,
    fullmag_fem_step_stats &stats,
    std::string &reason);

} // namespace fullmag::fem
#endif
