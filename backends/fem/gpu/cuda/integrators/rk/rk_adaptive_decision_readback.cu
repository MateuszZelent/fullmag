// ── GPU CUDA RK adaptive decision readback source contract ─────────────
// This source owns the transitional device-to-host control-scalar readback that
// feeds adaptive RK accept/reject policy. It does not own device error-norm
// reductions, RK step orchestration, RHS assembly, stage kernels, interaction
// kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_control_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cuda_runtime.h>
#include <string>

namespace fullmag::fem {

// Compatibility source markers: the former scalar owner exposed
// gpu_rk_read_control_scalar_result( and used the label
// "cudaMemcpyAsync GPU RK adaptive decision control scalar device->host";
// the canonical call below now batches those values in one attempt packet.
// The shared policy remains gpu_rk_adaptive_pi_step(ctx, dt_attempt, error_norm, order_est).

bool gpu_rk_read_attempt_control_packet(
    Context &ctx,
    cudaStream_t stream,
    GpuRkAttemptControlPacket &packet,
    std::string &reason)
{
    auto &control = ctx.gpu_state.device.rk.attempt_control;
    if (control.device == nullptr || control.host_pinned == nullptr) {
        reason = "GPU RK attempt-control packet staging is not allocated";
        return false;
    }
    cudaError_t rc = cudaMemcpyAsync(
        control.host_pinned,
        control.device,
        sizeof(GpuRkAttemptControlPacket),
        cudaMemcpyDeviceToHost,
        stream);
    if (rc != cudaSuccess) {
        reason = std::string("cudaMemcpyAsync GPU RK attempt-control packet device->host failed: ") +
            cudaGetErrorString(rc);
        return false;
    }
    rc = cudaStreamSynchronize(stream);
    if (rc != cudaSuccess) {
        reason = std::string("cudaStreamSynchronize GPU RK attempt-control packet failed: ") +
            cudaGetErrorString(rc);
        return false;
    }
    packet = *control.host_pinned;
    record_device_control_scalar_to_host(
        ctx.transfer_audit.audit,
        sizeof(GpuRkAttemptControlPacket));
    GpuPerformanceCounterDelta delta{};
    delta.control_fences = 1;
    delta.control_d2h_bytes = sizeof(GpuRkAttemptControlPacket);
    gpu_performance_note(ctx.gpu_state.performance_counters, delta);
    if ((packet.flags & GpuRkAttemptFlagInvalidNormalization) != 0u) {
        reason = "GPU RK attempt contains zero, subnormal-norm, or nonfinite active magnetization";
        return false;
    }
    if ((packet.flags & GpuRkAttemptFlagNonFiniteError) != 0u) {
        reason = "GPU RK adaptive control packet published a nonfinite error norm";
        return false;
    }
    return true;
}

bool gpu_rk_read_adaptive_error_norm_decision_host(
    Context &ctx,
    cudaStream_t stream,
    double dt_attempt,
    int order_est,
    GpuAdaptiveDecisionReadback &decision,
    std::string &reason)
{
    decision = {};
    fullmag_cuda_publish_adaptive_metrics(
        ctx.gpu_state.device.rk.attempt_control.device,
        ctx.gpu_state.device.reductions.scalar_result,
        stream);
    const cudaError_t publication_rc = cudaPeekAtLastError();
    if (publication_rc != cudaSuccess) {
        reason = std::string("launch GPU RK adaptive control packet publication failed: ") +
            cudaGetErrorString(publication_rc);
        return false;
    }
    GpuRkAttemptControlPacket packet{};
    if (!gpu_rk_read_attempt_control_packet(ctx, stream, packet, reason)) {
        return false;
    }

    decision.error_norm = packet.error_norm;
    decision.max_norm_defect = packet.max_norm_defect;
    decision.max_spin_rotation = packet.max_spin_rotation;
    GpuPerformanceCounterDelta performance_delta{};
    performance_delta.adaptive_readbacks = 1;
    gpu_performance_note(ctx.gpu_state.performance_counters, performance_delta);
    decision.adaptive_result = gpu_rk_adaptive_pi_step(ctx, dt_attempt, packet.error_norm, order_est);
    return true;
}

} // namespace fullmag::fem
