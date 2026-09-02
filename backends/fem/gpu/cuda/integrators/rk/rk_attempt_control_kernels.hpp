#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME

#include "gpu/cuda/integrators/rk/rk_attempt_control_state.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/state/component_field.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

void fullmag_cuda_reset_attempt_control_packet(
    GpuRkAttemptControlPacket *packet,
    cudaStream_t stream = nullptr);

void fullmag_cuda_normalize_vectors_deferred(
    const FemGpuComponentField &target,
    const FemGpuComponentField &safe_fallback,
    const uint8_t *magnetic_node_mask,
    GpuRkAttemptControlPacket *packet,
    int N,
    cudaStream_t stream = nullptr,
    GpuPerformanceCounterState *performance_counters = nullptr);

void fullmag_cuda_publish_adaptive_metrics(
    GpuRkAttemptControlPacket *packet,
    const double *scalar_result,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem

#endif
