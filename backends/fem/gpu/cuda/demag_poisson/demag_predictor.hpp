#pragma once

/*
 * Two-step linear temporal predictor for GPU Poisson Krylov warm-start.
 *
 * Extrapolates accepted step potentials phi_n and phi_{n-1} to strictly
 * advancing RK stage times (stage_time_s > last_solved_stage_time_s). Buffers
 * are allocated lazily only when Krylov runs; cuDSS direct solves never touch
 * predictor state or allocate history buffers.
 */

#include <cstdint>
#include <limits>
#include <string>

#if FULLMAG_HAS_CUDA_RUNTIME
#if defined(__has_include)
#if __has_include(<cuda_runtime.h>)
#define FULLMAG_DEMAG_PREDICTOR_HAS_CUDA_HEADER 1
#include <cuda_runtime.h>
#else
#define FULLMAG_DEMAG_PREDICTOR_HAS_CUDA_HEADER 0
#endif
#else
#define FULLMAG_DEMAG_PREDICTOR_HAS_CUDA_HEADER 1
#include <cuda_runtime.h>
#endif
#else
#define FULLMAG_DEMAG_PREDICTOR_HAS_CUDA_HEADER 0
#endif

namespace fullmag::fem {

struct GpuDemagLinearPredictorState {
    double *d_phi_curr = nullptr;
    double *d_phi_prev = nullptr;
    uint64_t capacity = 0;
    uint32_t history_count = 0;
    double t_curr = 0.0;
    double t_prev = 0.0;
    uint64_t operator_signature = 0;
    double last_solved_stage_time_s = -std::numeric_limits<double>::infinity();
    uint64_t commit_generation = 0;
};

/// Clears predictor validity metadata without freeing device history buffers.
inline void gpu_demag_predictor_invalidate(
    GpuDemagLinearPredictorState &state) noexcept
{
    state.history_count = 0;
    state.t_curr = 0.0;
    state.t_prev = 0.0;
    state.operator_signature = 0;
    state.last_solved_stage_time_s = -std::numeric_limits<double>::infinity();
}

#if FULLMAG_HAS_CUDA_RUNTIME

/// Idempotently frees device buffers and invalidates predictor metadata.
void gpu_demag_predictor_destroy(GpuDemagLinearPredictorState &state);

#if FULLMAG_DEMAG_PREDICTOR_HAS_CUDA_HEADER

/// Writes phi^(0)(stage_time_s) = phi_n + alpha * (phi_n - phi_{n-1}) into
/// `d_solution` when all history, monotonic stage-time, dt_ratio <= 2.0, and
/// operator-signature guards pass; otherwise leaves `d_solution` untouched.
bool gpu_demag_predictor_apply_warm_start(
    GpuDemagLinearPredictorState &state,
    double stage_time_s,
    double step_dt_s,
    uint64_t operator_signature,
    double *d_solution,
    uint64_t rows,
    cudaStream_t stream,
    bool &predicted,
    std::string &reason);

/// Lazily allocates history buffers (Krylov-only) and shifts the newly
/// accepted endpoint potential into `d_phi_curr`.
bool gpu_demag_predictor_commit_accepted_potential(
    GpuDemagLinearPredictorState &state,
    const double *d_accepted_solution,
    uint64_t rows,
    double endpoint_time_s,
    uint64_t operator_signature,
    cudaStream_t stream,
    std::string &reason);

#endif

#endif

} // namespace fullmag::fem
