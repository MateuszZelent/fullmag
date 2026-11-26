/*
 * GPU CUDA Poisson demag linear temporal predictor source contract.
 *
 * This source owns lazy Krylov-only device history allocation, the 2-step
 * linear extrapolation kernel phi^(0)(t_eval) = phi_n + alpha * (phi_n - phi_{n-1}),
 * monotonic stage-time and dt-ratio guards, accepted-potential commit, and
 * idempotent teardown. Direct cuDSS solves never call into this module.
 */

#include "gpu/cuda/demag_poisson/demag_predictor.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME

namespace {

constexpr int kPredictorBlockSize = 256;
constexpr double kMaxPredictorDtRatio = 2.0;

__global__ void demag_linear_predict_potential_kernel(
    const double *__restrict__ phi_curr,
    const double *__restrict__ phi_prev,
    double *__restrict__ phi_out,
    double alpha,
    uint64_t rows)
{
    const uint64_t stride =
        static_cast<uint64_t>(gridDim.x) * static_cast<uint64_t>(blockDim.x);
    for (uint64_t idx =
             static_cast<uint64_t>(blockIdx.x) * static_cast<uint64_t>(blockDim.x) +
             static_cast<uint64_t>(threadIdx.x);
         idx < rows;
         idx += stride) {
        const double curr = phi_curr[idx];
        const double prev = phi_prev[idx];
        phi_out[idx] = curr + alpha * (curr - prev);
    }
}

} // namespace

void gpu_demag_predictor_destroy(GpuDemagLinearPredictorState &state)
{
    if (state.d_phi_curr != nullptr) {
        cudaFree(state.d_phi_curr);
        state.d_phi_curr = nullptr;
    }
    if (state.d_phi_prev != nullptr) {
        cudaFree(state.d_phi_prev);
        state.d_phi_prev = nullptr;
    }
    state.capacity = 0;
    gpu_demag_predictor_invalidate(state);
}

bool gpu_demag_predictor_apply_warm_start(
    GpuDemagLinearPredictorState &state,
    double stage_time_s,
    double step_dt_s,
    uint64_t operator_signature,
    double *d_solution,
    uint64_t rows,
    cudaStream_t stream,
    bool &predicted,
    std::string &reason)
{
    predicted = false;
    reason.clear();
    if (d_solution == nullptr || rows == 0) {
        return true;
    }
    if (state.history_count < 2u ||
        state.d_phi_curr == nullptr ||
        state.d_phi_prev == nullptr ||
        state.capacity != rows) {
        return true;
    }
    if (state.operator_signature != operator_signature) {
        gpu_demag_predictor_invalidate(state);
        return true;
    }
    if (!std::isfinite(stage_time_s) ||
        !std::isfinite(step_dt_s) ||
        !std::isfinite(state.t_curr) ||
        !std::isfinite(state.t_prev) ||
        step_dt_s <= 0.0) {
        return true;
    }
    // Never overwrite a fresher equal-time stage solution (e.g. RK4 stage 2
    // after stage 1 at c=0.5, RK4 final refresh after stage 3 at c=1.0, or
    // RK45 stage 6 after stage 5 at c=1.0) with lower-order linear prediction.
    if (!(stage_time_s > state.last_solved_stage_time_s)) {
        return true;
    }
    const double dt_prev = state.t_curr - state.t_prev;
    if (!(dt_prev > 0.0)) {
        return true;
    }
    const double dt_ratio = step_dt_s / dt_prev;
    if (!std::isfinite(dt_ratio) || !(dt_ratio > 0.0) || dt_ratio > kMaxPredictorDtRatio) {
        return true;
    }
    const double alpha = (stage_time_s - state.t_curr) / dt_prev;
    if (!std::isfinite(alpha) || !(alpha > 0.0) || alpha > kMaxPredictorDtRatio) {
        return true;
    }

    const unsigned int blocks = static_cast<unsigned int>(std::min<uint64_t>(
        (rows + static_cast<uint64_t>(kPredictorBlockSize) - 1u) /
            static_cast<uint64_t>(kPredictorBlockSize),
        65535u));
    demag_linear_predict_potential_kernel<<<blocks, kPredictorBlockSize, 0, stream>>>(
        state.d_phi_curr,
        state.d_phi_prev,
        d_solution,
        alpha,
        rows);
    const cudaError_t launch_status = cudaPeekAtLastError();
    if (launch_status != cudaSuccess) {
        reason = std::string("launch GPU Poisson demag linear predictor failed: ") +
                 cudaGetErrorString(launch_status);
        return false;
    }
    predicted = true;
    return true;
}

bool gpu_demag_predictor_commit_accepted_potential(
    GpuDemagLinearPredictorState &state,
    const double *d_accepted_solution,
    uint64_t rows,
    double endpoint_time_s,
    uint64_t operator_signature,
    cudaStream_t stream,
    std::string &reason)
{
    reason.clear();
    if (d_accepted_solution == nullptr || rows == 0 ||
        !std::isfinite(endpoint_time_s)) {
        gpu_demag_predictor_invalidate(state);
        return true;
    }
    if (rows > std::numeric_limits<size_t>::max() / sizeof(double)) {
        gpu_demag_predictor_invalidate(state);
        reason = "GPU Poisson demag linear predictor allocation size overflow";
        return false;
    }

    const size_t bytes = static_cast<size_t>(rows) * sizeof(double);
    if (state.capacity != rows ||
        state.d_phi_curr == nullptr ||
        state.d_phi_prev == nullptr) {
        gpu_demag_predictor_destroy(state);
        double *phi_curr = nullptr;
        double *phi_prev = nullptr;
        cudaError_t alloc_rc = cudaMalloc(&phi_curr, bytes);
        if (alloc_rc != cudaSuccess) {
            reason = std::string("cudaMalloc GPU Poisson demag predictor phi_curr failed: ") +
                     cudaGetErrorString(alloc_rc);
            return false;
        }
        alloc_rc = cudaMalloc(&phi_prev, bytes);
        if (alloc_rc != cudaSuccess) {
            cudaFree(phi_curr);
            reason = std::string("cudaMalloc GPU Poisson demag predictor phi_prev failed: ") +
                     cudaGetErrorString(alloc_rc);
            return false;
        }
        state.d_phi_curr = phi_curr;
        state.d_phi_prev = phi_prev;
        state.capacity = rows;
        state.history_count = 0;
    }

    const bool can_shift_previous =
        state.history_count >= 1u &&
        state.operator_signature == operator_signature &&
        std::isfinite(state.t_curr) &&
        endpoint_time_s > state.t_curr;

    if (can_shift_previous) {
        std::swap(state.d_phi_prev, state.d_phi_curr);
        state.t_prev = state.t_curr;
        state.history_count = 2u;
    } else {
        state.t_prev = 0.0;
        state.history_count = 1u;
    }

    const cudaError_t copy_rc = cudaMemcpyAsync(
        state.d_phi_curr,
        d_accepted_solution,
        bytes,
        cudaMemcpyDeviceToDevice,
        stream);
    if (copy_rc != cudaSuccess) {
        gpu_demag_predictor_invalidate(state);
        reason = std::string("cudaMemcpyAsync GPU Poisson demag predictor commit failed: ") +
                 cudaGetErrorString(copy_rc);
        return false;
    }

    state.t_curr = endpoint_time_s;
    state.operator_signature = operator_signature;
    state.last_solved_stage_time_s = endpoint_time_s;
    return true;
}

#endif

} // namespace fullmag::fem
