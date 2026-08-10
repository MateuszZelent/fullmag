// ── GPU CUDA RK RHS runtime source contract ───────────────────────────
// This source owns device-resident RHS assembly orchestration for GPU RK:
// exchange dispatch delegation, DMI field contribution dispatch, demag dispatch
// delegation, local-field contribution dispatch, H_eff accumulation, LLG RHS
// dispatch delegation, and direct torque dispatch. It does not own exchange
// validation/kernel dispatch, demag mode dispatch, fused LLG RHS launch, DMI
// field generation, local-field generation, direct torque RHS additions, RK
// step orchestration, final stats, stage kernels, adaptive policy, interaction
// kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_demag_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"
#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"
#include "gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"

#include <string>
#include <vector>

namespace fullmag::fem {

namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

struct GpuRkPhaseTimer {
    GpuRkPhaseTimingRuntimeState::EventPair *event = nullptr;
    cudaStream_t stream = nullptr;
    const char *label = nullptr;
    bool active = false;

    bool start(
        bool enabled,
        std::vector<GpuRkPhaseTimingRuntimeState::EventPair> &events,
        size_t &used_count,
        uint64_t &overflow_count,
        cudaStream_t phase_stream,
        const char *phase_label,
        std::string &reason)
    {
        if (!enabled) {
            return true;
        }
        stream = phase_stream;
        label = phase_label;
        if (used_count >= events.size()) {
            overflow_count += 1;
            return true;
        }
        event = &events[used_count];
        used_count += 1;
        if (event->start_event == nullptr || event->stop_event == nullptr) {
            reason = std::string(label) + " was not prepared before GPU RK hot loop";
            event = nullptr;
            return false;
        }
        if (!cuda_ok(
                cudaEventRecord(static_cast<cudaEvent_t>(event->start_event), stream),
                label,
                reason)) {
            event = nullptr;
            return false;
        }
        active = true;
        return true;
    }

    bool finish(std::string &reason)
    {
        if (!active) {
            return true;
        }
        if (!cuda_ok(
                cudaEventRecord(static_cast<cudaEvent_t>(event->stop_event), stream),
                label,
                reason)) {
            active = false;
            event = nullptr;
            return false;
        }
        active = false;
        event = nullptr;
        return true;
    }
};

bool gpu_rk_accumulate_effective_field_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    const char *label,
    std::string &reason,
    bool fresh_demag_initial_guess = false)
{
    auto &timings = ctx.gpu_state.rk_phase_timings;
    GpuRkPhaseTimer exchange_timer;
    if (!exchange_timer.start(
            timings.enabled,
            timings.exchange_events,
            timings.exchange_used,
            timings.exchange_overflow_count,
            stream,
            "GPU RK exchange phase timing",
            reason)) {
        return false;
    }
    if (!gpu_rk_compute_legacy_sparse_exchange(ctx.gpu_state.device, m, stream, reason)) {
        return false;
    }
    if (!exchange_timer.finish(reason)) {
        return false;
    }
    if (!gpu_rk_compute_dmi_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    const bool demag_ok = fresh_demag_initial_guess
        ? gpu_rk_compute_demag_for_device_stage_fresh(ctx, m, stream, reason)
        : gpu_rk_compute_demag_for_device_stage(ctx, m, stream, reason);
    if (!demag_ok) {
        return false;
    }
    if (!gpu_rk_compute_local_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    return gpu_rk_accumulate_effective_field(ctx, stream, n, evaluation_time_s, label, reason);
}

} // namespace

bool gpu_rk_compute_effective_field_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    const char *label,
    std::string &reason)
{
    return gpu_rk_accumulate_effective_field_for_magnetization(
        ctx, m, stream, n, evaluation_time_s, label, reason);
}

bool gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    const char *label,
    std::string &reason)
{
    return gpu_rk_accumulate_effective_field_for_magnetization(
        ctx, m, stream, n, evaluation_time_s, label, reason, true);
}

bool gpu_rk_compute_rhs_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    double evaluation_time_s,
    const char *label,
    std::string &reason)
{
    if (!gpu_rk_accumulate_effective_field_for_magnetization(
            ctx, m, stream, n, evaluation_time_s, label, reason)) {
        return false;
    }

    auto &timings = ctx.gpu_state.rk_phase_timings;
    GpuRkPhaseTimer rhs_timer;
    if (!rhs_timer.start(
            timings.enabled,
            timings.rhs_events,
            timings.rhs_used,
            timings.rhs_overflow_count,
            stream,
            "GPU RK RHS phase timing",
            reason)) {
        return false;
    }
    if (!gpu_rk_compute_llg_rhs(ctx, m, rhs, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_add_direct_torques(ctx, m, rhs, stream, n, evaluation_time_s, reason)) {
        return false;
    }
    if (!rhs_timer.finish(reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
