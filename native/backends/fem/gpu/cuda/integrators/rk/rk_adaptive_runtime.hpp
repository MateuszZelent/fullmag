/*
 * GPU CUDA RK adaptive runtime module header.
 *
 * Declares adaptive-step policy and device error-norm helpers used by the
 * device-resident RK stepper. Step orchestration remains in rk_step.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "cpu/mfem/integrators/rk_tableau.hpp"
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

bool gpu_rk_compute_adaptive_error_norm_device(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    cudaStream_t stream,
    int n,
    int blocks,
    double &error_norm,
    std::string &reason);

} // namespace fullmag::fem
#endif
