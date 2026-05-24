/*
 * GPU CUDA RK step preflight module header.
 *
 * Declares step-level validation and launch-parameter preparation used by the
 * device-resident RK stepper. Attempt looping and accepted-step finalization
 * remain in dedicated RK modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "cpu/mfem/integrators/rk_tableau.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

struct GpuRkStepPreflight {
    int n = 0;
    int blocks = 0;
    cudaStream_t stream = nullptr;
    bool is_heun = false;
    bool is_rk4 = false;
    bool is_rk23 = false;
    bool is_rk45 = false;
    bool adaptive = false;
    bool fsal_method = false;
};

bool gpu_rk_prepare_step_preflight(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    GpuRkStepPreflight &result,
    std::string &reason);

} // namespace fullmag::fem
#endif
