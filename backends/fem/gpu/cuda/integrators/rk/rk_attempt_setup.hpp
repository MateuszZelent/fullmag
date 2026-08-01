/*
 * GPU CUDA RK attempt setup module header.
 *
 * Declares the common device-resident setup for one RK attempt: backup, FSAL
 * reuse detection, optional k0 RHS refresh, first predictor, normalization,
 * and k1 RHS refresh. Per-integrator stages, accepts, adaptive policy, and
 * final accounting remain outside this module.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_prepare_stage_attempt(
    Context &ctx,
    cudaStream_t stream,
    int n,
    bool is_heun,
    bool is_rk45,
    bool fsal_method,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    bool &fsal_reused,
    std::string &reason);

bool gpu_rk_capture_pre_normalization_candidate(
    Context &ctx,
    cudaStream_t stream,
    std::string &reason);

} // namespace fullmag::fem
#endif
