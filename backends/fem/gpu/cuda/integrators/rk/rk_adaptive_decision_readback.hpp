/*
 * GPU CUDA RK adaptive decision readback module header.
 *
 * Declares the transitional host-side adaptive accept/reject control boundary
 * for embedded RK methods. Device error-norm reductions remain in
 * rk_error_norm_runtime, and compute residency remains separate from this
 * small control-scalar readback.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_control_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

struct GpuAdaptiveDecisionReadback {
    GpuAdaptiveResult adaptive_result;
    double error_norm;
    double max_norm_defect;
    double max_spin_rotation;
};

bool gpu_rk_read_attempt_control_packet(
    Context &ctx,
    cudaStream_t stream,
    GpuRkAttemptControlPacket &packet,
    std::string &reason);

bool gpu_rk_read_adaptive_error_norm_decision_host(
    Context &ctx,
    cudaStream_t stream,
    double dt_attempt,
    int order_est,
    GpuAdaptiveDecisionReadback &decision,
    std::string &reason);

} // namespace fullmag::fem
#endif
