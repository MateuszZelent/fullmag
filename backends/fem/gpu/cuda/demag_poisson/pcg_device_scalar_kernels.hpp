#pragma once
#include <cstdint>
#include <cstddef>

namespace fullmag::fem {
// Keep this host queue policy shared with the terminal/readback contracts.
// Two pre-loop AMG calls plus the first five queued calls fit the seven-call
// post-latch budget even when initialization already found a terminal state.
constexpr uint32_t demag_pcg_next_batch_iterations(uint32_t queued, uint32_t maximum)
{
    if (queued >= maximum) return 0u;
    const uint32_t limit = queued == 0u ? 5u : 8u;
    const uint32_t remaining = maximum - queued;
    return remaining < limit ? remaining : limit;
}
}

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
namespace fullmag::fem {
enum class DemagPcgStatus : uint32_t { Running, Converged, MaxIterations, Breakdown, Nonfinite };
struct DemagPcgState {
    DemagPcgStatus status;
    uint32_t iterations, rhs_nonzero, residual_nonzero;
    double denominator, rho, previous_rho, curvature, alpha, beta;
    double epsilon, relative_residual, relative_tolerance, absolute_tolerance;
    uint32_t max_iterations;
};
cudaError_t demag_pcg_initialize(DemagPcgState*, const double*, double*, double*, double*, int, bool, double, double, uint32_t, cudaStream_t);
cudaError_t demag_pcg_dot(const double*, const double*, int, double*, void*, size_t&, double*, DemagPcgState*, cudaStream_t);
cudaError_t demag_pcg_finish_denominator(DemagPcgState*, cudaStream_t);
cudaError_t demag_pcg_initial_residual(const double*, const double*, double*, double*, int, DemagPcgState*, cudaStream_t);
cudaError_t demag_pcg_gate(const double*, double*, int, DemagPcgState*, cudaStream_t);
cudaError_t demag_pcg_alpha(DemagPcgState*, cudaStream_t);
cudaError_t demag_pcg_update(double*, double*, const double*, const double*, int, DemagPcgState*, cudaStream_t);
cudaError_t demag_pcg_finish_rho(DemagPcgState*, bool, cudaStream_t);
cudaError_t demag_pcg_direction(const double*, double*, int, DemagPcgState*, bool, cudaStream_t);
}
#endif
