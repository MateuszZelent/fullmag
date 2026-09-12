/*
 * GPU RK deferred normalization and typed control-packet kernels.
 */

#include "gpu/cuda/integrators/rk/rk_attempt_control_kernels.hpp"

#include <cfloat>
#include <cmath>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

__global__ void reset_attempt_control_packet_kernel(
    GpuRkAttemptControlPacket *__restrict__ packet)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        packet->flags = GpuRkAttemptFlagNone;
        packet->error_norm = 0.0;
        packet->max_norm_defect = 0.0;
        packet->max_spin_rotation = 0.0;
        packet->suggested_dt = 0.0;
        packet->decision = 0u;
        packet->reason = 0u;
    }
}

__global__ void deferred_normalize_kernel(
    const FemGpuComponentField target,
    const FemGpuComponentField safe_fallback,
    const uint8_t *__restrict__ magnetic_node_mask,
    GpuRkAttemptControlPacket *__restrict__ packet,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N || (magnetic_node_mask != nullptr && magnetic_node_mask[i] == 0u)) {
        return;
    }
    const double x = target.x[i];
    const double y = target.y[i];
    const double z = target.z[i];
    const double norm = sqrt(x * x + y * y + z * z);
    if (isfinite(x) && isfinite(y) && isfinite(z) &&
        isfinite(norm) && norm >= DBL_MIN) {
        const double inverse = 1.0 / norm;
        target.x[i] = x * inverse;
        target.y[i] = y * inverse;
        target.z[i] = z * inverse;
        return;
    }

    target.x[i] = safe_fallback.x[i];
    target.y[i] = safe_fallback.y[i];
    target.z[i] = safe_fallback.z[i];
    atomicOr(reinterpret_cast<unsigned long long *>(&packet->flags),
             static_cast<unsigned long long>(GpuRkAttemptFlagInvalidNormalization));
}

__global__ void publish_adaptive_metrics_kernel(
    GpuRkAttemptControlPacket *__restrict__ packet,
    const double *__restrict__ scalar_result)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        packet->error_norm = scalar_result[0];
        packet->max_norm_defect = scalar_result[1];
        packet->max_spin_rotation = scalar_result[2];
        if (!isfinite(packet->error_norm) ||
            !isfinite(packet->max_norm_defect) ||
            !isfinite(packet->max_spin_rotation)) {
            packet->flags |= GpuRkAttemptFlagNonFiniteError;
        }
    }
}

} // namespace

void fullmag_cuda_reset_attempt_control_packet(
    GpuRkAttemptControlPacket *packet,
    cudaStream_t stream)
{
    reset_attempt_control_packet_kernel<<<1, 1, 0, stream>>>(packet);
}

void fullmag_cuda_normalize_vectors_deferred(
    const FemGpuComponentField &target,
    const FemGpuComponentField &safe_fallback,
    const uint8_t *magnetic_node_mask,
    GpuRkAttemptControlPacket *packet,
    int N,
    cudaStream_t stream,
    GpuPerformanceCounterState *performance_counters)
{
    deferred_normalize_kernel<<<(N + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        target,
        safe_fallback,
        magnetic_node_mask,
        packet,
        N);
    if (performance_counters != nullptr) {
        GpuPerformanceCounterDelta delta{};
        delta.normalization_launches = 1;
        gpu_performance_note(*performance_counters, delta);
    }
}

void fullmag_cuda_publish_adaptive_metrics(
    GpuRkAttemptControlPacket *packet,
    const double *scalar_result,
    cudaStream_t stream)
{
    publish_adaptive_metrics_kernel<<<1, 1, 0, stream>>>(packet, scalar_result);
}

} // namespace fullmag::fem
