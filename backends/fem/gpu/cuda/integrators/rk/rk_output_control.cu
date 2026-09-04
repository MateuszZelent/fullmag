/*
 * GPU CUDA RK output control and transactional candidate state implementation.
 */

#include "gpu/cuda/integrators/rk/rk_output_control.hpp"
#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "fullmag_adaptive_step_decision.hpp"

#include <cmath>
#include <cstring>
#include <algorithm>

namespace fullmag::fem {

namespace {

__device__ __host__ void compute_decision_core(
    int order_est,
    double dt_min,
    double dt_max,
    double safety,
    double growth_limit,
    double shrink_limit,
    double dt_attempt,
    double error_current,
    double error_previous,
    bool has_previous_error,
    RkDecisionSlot &out)
{
    if (order_est <= 0 || order_est > 16 ||
        !isfinite(dt_min) || !isfinite(dt_max) || dt_min <= 0.0 || dt_max < dt_min ||
        !isfinite(safety) || !isfinite(growth_limit) || !isfinite(shrink_limit) ||
        safety <= 0.0 || safety > 1.0 || growth_limit <= 1.0 ||
        shrink_limit <= 0.0 || shrink_limit >= 1.0 ||
        !isfinite(dt_attempt) || dt_attempt <= 0.0 || dt_attempt < dt_min || dt_attempt > dt_max ||
        !isfinite(error_current) || error_current < 0.0 ||
        !isfinite(error_previous) || (has_previous_error && error_previous <= 0.0)) {
        out.decision = 3u; // failed
        out.reason = 3u;   // invalid
        out.next_dt = dt_attempt;
        out.ratio = 1.0;
        out.valid = 1u;
        return;
    }

    const bool accepted = error_current <= 1.0;
    const bool at_dt_min = dt_attempt <= dt_min ||
        (dt_attempt - dt_min) <= dt_min * (4.0 * 2.220446049250313e-16);
    if (!accepted && at_dt_min) {
        out.decision = 3u; // failed
        out.reason = 2u;   // dt_min_exhausted
        out.next_dt = dt_min;
        out.ratio = 1.0;
        out.valid = 1u;
        return;
    }

    double raw_ratio = growth_limit;
    if (error_current > 0.0) {
        const double scale = 1.0 / static_cast<double>(order_est + 1);
        raw_ratio = accepted && has_previous_error
            ? safety * pow(error_current, -0.7 * scale) * pow(error_previous, 0.4 * scale)
            : safety * pow(error_current, -scale);
    }
    const double clamped_ratio = fmin(fmax(raw_ratio, shrink_limit), growth_limit);
    const double dt_next = fmin(fmax(dt_attempt * clamped_ratio, dt_min), dt_max);

    out.decision = accepted ? 1u : 2u;
    out.reason = accepted ? 0u : 1u;
    out.error_norm = error_current;
    out.dt_attempt = dt_attempt;
    out.next_dt = dt_next;
    out.ratio = dt_next / dt_attempt;
    out.valid = 1u;
}

__global__ void compute_device_decision_kernel(
    int order_est,
    double dt_min,
    double dt_max,
    double safety,
    double growth_limit,
    double shrink_limit,
    double dt_attempt,
    double error_current,
    double error_previous,
    bool has_previous_error,
    RkDecisionSlot *out_slot)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        compute_decision_core(
            order_est, dt_min, dt_max, safety, growth_limit, shrink_limit,
            dt_attempt, error_current, error_previous, has_previous_error,
            *out_slot);
    }
}

} // namespace

bool rk_candidate_state_allocate(
    RkCandidateState &candidate,
    uint64_t node_count,
    std::string &error)
{
    rk_candidate_state_destroy(candidate);
    candidate.node_count = node_count;
    candidate.host_m.clear();

    const size_t bytes = static_cast<size_t>(node_count) * sizeof(double);
    cudaError_t rc = cudaMalloc(&candidate.m_candidate.x, bytes);
    if (rc != cudaSuccess) {
        error = std::string("cudaMalloc candidate.m_candidate.x failed: ") + cudaGetErrorString(rc);
        rk_candidate_state_destroy(candidate);
        return false;
    }
    rc = cudaMalloc(&candidate.m_candidate.y, bytes);
    if (rc != cudaSuccess) {
        error = std::string("cudaMalloc candidate.m_candidate.y failed: ") + cudaGetErrorString(rc);
        rk_candidate_state_destroy(candidate);
        return false;
    }
    rc = cudaMalloc(&candidate.m_candidate.z, bytes);
    if (rc != cudaSuccess) {
        error = std::string("cudaMalloc candidate.m_candidate.z failed: ") + cudaGetErrorString(rc);
        rk_candidate_state_destroy(candidate);
        return false;
    }
    rc = cudaMalloc(&candidate.d_slots, 2 * sizeof(RkDecisionSlot));
    if (rc != cudaSuccess) {
        error = std::string("cudaMalloc candidate.d_slots failed: ") + cudaGetErrorString(rc);
        rk_candidate_state_destroy(candidate);
        return false;
    }
    cudaMemset(candidate.d_slots, 0, 2 * sizeof(RkDecisionSlot));

    candidate.active_slot = 0;
    candidate.candidate_version = 0;
    candidate.accepted_version = 0;
    candidate.candidate_valid = false;
    candidate.fsal_valid = false;
    error.clear();
    return true;
}

void rk_candidate_state_destroy(
    RkCandidateState &candidate)
{
    if (candidate.m_candidate.x != nullptr) {
        cudaFree(candidate.m_candidate.x);
        candidate.m_candidate.x = nullptr;
    }
    if (candidate.m_candidate.y != nullptr) {
        cudaFree(candidate.m_candidate.y);
        candidate.m_candidate.y = nullptr;
    }
    if (candidate.m_candidate.z != nullptr) {
        cudaFree(candidate.m_candidate.z);
        candidate.m_candidate.z = nullptr;
    }
    if (candidate.d_slots != nullptr) {
        cudaFree(candidate.d_slots);
        candidate.d_slots = nullptr;
    }
    candidate.host_m.clear();
    candidate.node_count = 0;
    candidate.candidate_valid = false;
}

bool rk_candidate_upload_m(
    RkCandidateState &candidate,
    const double *host_m,
    uint64_t node_count,
    cudaStream_t stream,
    std::string &error)
{
    if (host_m == nullptr || node_count != candidate.node_count) {
        error = "invalid upload pointer or node count";
        return false;
    }
    candidate.host_m.assign(host_m, host_m + static_cast<size_t>(node_count) * 3u);

    if (candidate.m_candidate.x != nullptr) {
        std::vector<double> hx(node_count), hy(node_count), hz(node_count);
        for (size_t i = 0; i < node_count; ++i) {
            hx[i] = host_m[3 * i + 0];
            hy[i] = host_m[3 * i + 1];
            hz[i] = host_m[3 * i + 2];
        }
        const size_t bytes = static_cast<size_t>(node_count) * sizeof(double);
        cudaError_t rc = cudaMemcpy(candidate.m_candidate.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (rc != cudaSuccess) { error = "cudaMemcpy candidate.x failed"; return false; }
        rc = cudaMemcpy(candidate.m_candidate.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (rc != cudaSuccess) { error = "cudaMemcpy candidate.y failed"; return false; }
        rc = cudaMemcpy(candidate.m_candidate.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (rc != cudaSuccess) { error = "cudaMemcpy candidate.z failed"; return false; }
    }
    return true;
}

bool rk_candidate_capture_device(
    RkCandidateState &candidate,
    const FemGpuComponentField &source_m,
    uint64_t node_count,
    cudaStream_t stream,
    std::string &error)
{
    if (node_count != candidate.node_count || candidate.m_candidate.x == nullptr) {
        error = "candidate unallocated or dimension mismatch";
        return false;
    }
    if (!gpu_rk_copy_component_device(
            source_m,
            candidate.m_candidate,
            static_cast<int>(node_count),
            stream,
            "rk_candidate_capture_device",
            error)) {
        return false;
    }
    candidate.candidate_valid = true;
    candidate.candidate_version += 1;
    error.clear();
    return true;
}

bool commit_candidate(
    Context &ctx,
    RkCandidateState &candidate,
    cudaStream_t stream,
    std::string &error)
{
    if (candidate.force_commit_failure) {
        error = "injected commit_candidate failure";
        return false;
    }
    auto &gpu = ctx.gpu_state.device;
    if (gpu.lifecycle.allocated && candidate.m_candidate.x != nullptr && gpu.magnetization.m.x != nullptr) {
        if (!gpu_rk_copy_component_device(
                candidate.m_candidate,
                gpu.magnetization.m,
                static_cast<int>(candidate.node_count),
                stream,
                "commit_candidate device copy",
                error)) {
            return false;
        }
    }

    if (!candidate.host_m.empty()) {
        ctx.state.m_xyz = candidate.host_m;
    }
    ctx.state.current_time += candidate.dt;
    ctx.state.step_count += 1;
    candidate.accepted_version = candidate.candidate_version;
    candidate.candidate_valid = true;
    candidate.receipt.accepted_step_count += 1;

    if (candidate.fsal_valid) {
        gpu.rk.fsal_valid = true;
    }
    error.clear();
    return true;
}

bool rollback_candidate(
    Context &ctx,
    RkCandidateState &candidate,
    cudaStream_t stream,
    std::string &error)
{
    (void)ctx;
    (void)stream;
    candidate.candidate_valid = false;
    candidate.fsal_valid = false;
    candidate.receipt.rejected_attempt_count += 1;
    error.clear();
    return true;
}

void rk_compute_device_decision(
    int order_est,
    double dt_min,
    double dt_max,
    double safety,
    double growth_limit,
    double shrink_limit,
    double dt_attempt,
    double error_current,
    double error_previous,
    bool has_previous_error,
    RkDecisionSlot &out_slot,
    cudaStream_t stream)
{
    (void)stream;
    compute_decision_core(
        order_est, dt_min, dt_max, safety, growth_limit, shrink_limit,
        dt_attempt, error_current, error_previous, has_previous_error,
        out_slot);
}

void rk_launch_device_decision_kernel(
    int order_est,
    double dt_min,
    double dt_max,
    double safety,
    double growth_limit,
    double shrink_limit,
    double dt_attempt,
    double error_current,
    double error_previous,
    bool has_previous_error,
    RkDecisionSlot *d_out_slot,
    cudaStream_t stream)
{
    if (d_out_slot != nullptr) {
        compute_device_decision_kernel<<<1, 1, 0, stream>>>(
            order_est, dt_min, dt_max, safety, growth_limit, shrink_limit,
            dt_attempt, error_current, error_previous, has_previous_error,
            d_out_slot);
    }
}

} // namespace fullmag::fem
