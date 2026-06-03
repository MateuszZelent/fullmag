/*
 * GPU CUDA RK adaptive runtime module header.
 *
 * Declares adaptive-step policy and reject-restore helpers used by the
 * device-resident RK stepper. Step orchestration and device error-norm
 * reductions remain in dedicated RK modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

struct GpuAdaptiveResult {
    bool accepted;
    double dt_next;
};

GpuAdaptiveResult gpu_rk_adaptive_pi_step(Context &ctx, double error_norm);

bool gpu_rk_restore_adaptive_reject_magnetization_device(
    FemGpuState &gpu,
    cudaStream_t stream,
    std::string &reason);

} // namespace fullmag::fem
#endif
