/*
 * GPU CUDA RK45 stage sequence module header.
 *
 * Declares the Dormand-Prince RK45 stage sequence used by the device-resident
 * RK attempt scheduler. Generic attempt backup, FSAL reuse, non-RK45 accepts,
 * and BS23 adaptive k3 handling remain in rk_stage_schedule.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_run_rk45_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    std::string &reason);

} // namespace fullmag::fem
#endif
