/*
 * GPU CUDA RK4 stage sequence module header.
 *
 * Declares the RK4 midpoint/endpoint stage sequence used by the
 * device-resident RK attempt scheduler. Generic attempt backup, FSAL reuse,
 * RK23/BS23 sequencing, Heun accept, RK45 stages, and adaptive handling remain
 * outside this module.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_run_rk4_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    std::string &reason);

} // namespace fullmag::fem
#endif
