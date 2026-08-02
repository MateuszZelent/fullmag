/*
 * GPU CUDA RK final step stats source contract.
 *
 * This source owns scalar slot access, scalar readback, and final stats
 * orchestration for device-resident RK steps. It does not own final
 * energy/observable reductions, stats publication, RK step scheduling, RHS
 * assembly, interaction physics kernels, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_step_transaction_device.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats_publication.hpp"
#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"

#include <cuda_runtime.h>

#include <array>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

int phase_timing_env_state()
{
    const char *raw = std::getenv("FULLMAG_FEM_STEP_PROFILE");
    if (raw == nullptr || *raw == '\0') {
        return -1;
    }
    if (std::strcmp(raw, "1") == 0 ||
        std::strcmp(raw, "true") == 0 ||
        std::strcmp(raw, "TRUE") == 0 ||
        std::strcmp(raw, "on") == 0 ||
        std::strcmp(raw, "ON") == 0 ||
        std::strcmp(raw, "yes") == 0 ||
        std::strcmp(raw, "YES") == 0) {
        return 1;
    }
    if (std::strcmp(raw, "0") == 0 ||
        std::strcmp(raw, "false") == 0 ||
        std::strcmp(raw, "FALSE") == 0 ||
        std::strcmp(raw, "off") == 0 ||
        std::strcmp(raw, "OFF") == 0 ||
        std::strcmp(raw, "no") == 0 ||
        std::strcmp(raw, "NO") == 0) {
        return 0;
    }
    return -1;
}

bool phase_timing_requested(Context &ctx)
{
    const auto &timings = ctx.gpu_state.rk_phase_timings;
    if (timings.override_configured) {
        return timings.override_enabled;
    }
    const int env_state = phase_timing_env_state();
    if (env_state >= 0) {
        return env_state != 0;
    }
    return false;
}

void destroy_phase_timing_events(
    std::vector<GpuRkPhaseTimingRuntimeState::EventPair> &events)
{
    for (auto &event : events) {
        if (event.start_event != nullptr) {
            cudaEventDestroy(static_cast<cudaEvent_t>(event.start_event));
            event.start_event = nullptr;
        }
        if (event.stop_event != nullptr) {
            cudaEventDestroy(static_cast<cudaEvent_t>(event.stop_event));
            event.stop_event = nullptr;
        }
    }
    events.clear();
}

bool ensure_phase_timing_events(
    std::vector<GpuRkPhaseTimingRuntimeState::EventPair> &events,
    size_t required_count,
    const char *label,
    std::string &reason)
{
    const size_t old_count = events.size();
    if (old_count < required_count) {
        try {
            events.resize(required_count);
        } catch (const std::bad_alloc &) {
            reason = std::string(label) + " allocation failed";
            return false;
        }
    }
    for (size_t i = old_count; i < required_count; ++i) {
        auto &event = events[i];
        if (event.start_event == nullptr) {
            cudaEvent_t cuda_event = nullptr;
            const auto rc = cudaEventCreate(&cuda_event);
            if (rc != cudaSuccess) {
                reason = std::string(label) + " start event creation failed: " +
                    cudaGetErrorString(rc);
                return false;
            }
            event.start_event = static_cast<void *>(cuda_event);
        }
        if (event.stop_event == nullptr) {
            cudaEvent_t cuda_event = nullptr;
            const auto rc = cudaEventCreate(&cuda_event);
            if (rc != cudaSuccess) {
                reason = std::string(label) + " stop event creation failed: " +
                    cudaGetErrorString(rc);
                return false;
            }
            event.stop_event = static_cast<void *>(cuda_event);
        }
    }
    return true;
}

bool collect_phase_timing_events(
    std::vector<GpuRkPhaseTimingRuntimeState::EventPair> &events,
    size_t used_count,
    uint64_t &accumulator_ns,
    const char *label,
    std::string &reason)
{
    const size_t bounded_used_count = std::min(used_count, events.size());
    for (size_t i = 0; i < bounded_used_count; ++i) {
        auto &event = events[i];
        float elapsed_ms = 0.0f;
        const auto rc = cudaEventElapsedTime(
            &elapsed_ms,
            static_cast<cudaEvent_t>(event.start_event),
            static_cast<cudaEvent_t>(event.stop_event));
        if (rc != cudaSuccess) {
            reason = std::string(label) + " failed: " + cudaGetErrorString(rc);
            return false;
        }
        if (elapsed_ms > 0.0f) {
            accumulator_ns += static_cast<uint64_t>(elapsed_ms * 1000000.0f);
        }
    }
    return true;
}

void reset_phase_timing_accumulators(Context &ctx)
{
    auto &timings = ctx.gpu_state.rk_phase_timings;
    timings.exchange_wall_time_ns = 0;
    timings.demag_assemble_wall_time_ns = 0;
    timings.demag_recover_wall_time_ns = 0;
    timings.demag_energy_wall_time_ns = 0;
    timings.rhs_wall_time_ns = 0;
    timings.exchange_used = 0;
    timings.demag_assemble_used = 0;
    timings.demag_recover_used = 0;
    timings.demag_energy_used = 0;
    timings.rhs_used = 0;
    timings.exchange_overflow_count = 0;
    timings.demag_assemble_overflow_count = 0;
    timings.demag_recover_overflow_count = 0;
    timings.demag_energy_overflow_count = 0;
    timings.rhs_overflow_count = 0;
#if FULLMAG_HAS_MFEM_STACK
    ctx.poisson_demag.step_assemble_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_apply_device_wall_time_ns = 0;
    ctx.poisson_demag.step_solver_apply_device_wall_time_ns = 0;
    ctx.poisson_demag.step_hypre_wait_in_enqueue_wall_time_ns = 0;
    ctx.poisson_demag.step_hypre_host_api_wall_time_ns = 0;
    ctx.poisson_demag.step_hypre_wait_out_enqueue_wall_time_ns = 0;
    ctx.poisson_demag.step_hypre_event_wait_count = 0;
    ctx.poisson_demag.step_hypre_timed_solve_count = 0;
    ctx.poisson_demag.step_recover_wall_time_ns = 0;
    ctx.poisson_demag.step_energy_wall_time_ns = 0;
#endif
}

void refresh_phase_timing_enablement(Context &ctx)
{
    auto &timings = ctx.gpu_state.rk_phase_timings;
    const bool enabled = phase_timing_requested(ctx);
    if (!timings.configured) {
        if (!enabled) {
            destroy_phase_timing_events(timings.exchange_events);
            destroy_phase_timing_events(timings.demag_assemble_events);
            destroy_phase_timing_events(timings.demag_recover_events);
            destroy_phase_timing_events(timings.demag_energy_events);
            destroy_phase_timing_events(timings.rhs_events);
#if FULLMAG_HAS_MFEM_STACK
            destroy_context_hypre_apply_device_timing_events(ctx);
#endif
        }
        timings.enabled = enabled;
        timings.configured = true;
        reset_phase_timing_accumulators(ctx);
        return;
    }
    if (timings.enabled == enabled) {
        return;
    }
    if (!enabled) {
        destroy_phase_timing_events(timings.exchange_events);
        destroy_phase_timing_events(timings.demag_assemble_events);
        destroy_phase_timing_events(timings.demag_recover_events);
        destroy_phase_timing_events(timings.demag_energy_events);
        destroy_phase_timing_events(timings.rhs_events);
#if FULLMAG_HAS_MFEM_STACK
        destroy_context_hypre_apply_device_timing_events(ctx);
#endif
    }
    timings.enabled = enabled;
    reset_phase_timing_accumulators(ctx);
}

bool collect_gpu_rk_phase_timing_events(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &timings = ctx.gpu_state.rk_phase_timings;
    timings.exchange_wall_time_ns = 0;
    timings.demag_assemble_wall_time_ns = 0;
    timings.demag_recover_wall_time_ns = 0;
    timings.demag_energy_wall_time_ns = 0;
    timings.rhs_wall_time_ns = 0;
    if (!timings.enabled) {
        stats.exchange_wall_time_ns = 0;
        stats.rhs_wall_time_ns = 0;
        return true;
    }
    if (!collect_phase_timing_events(
            timings.exchange_events,
            timings.exchange_used,
            timings.exchange_wall_time_ns,
            "GPU RK exchange phase timing readback",
            reason)) {
        return false;
    }
#if FULLMAG_HAS_MFEM_STACK
        if (!collect_context_hypre_apply_device_timing(
            ctx,
            ctx.poisson_demag.step_solver_apply_device_wall_time_ns,
            reason)) {
            return false;
        }
        ctx.poisson_demag.step_hypre_timed_solve_count =
            context_hypre_apply_timed_solve_count(ctx);
        ctx.poisson_demag.last_solver_apply_device_wall_time_ns =
        ctx.poisson_demag.step_solver_apply_device_wall_time_ns;
#endif
    if (!collect_phase_timing_events(
            timings.demag_assemble_events,
            timings.demag_assemble_used,
            timings.demag_assemble_wall_time_ns,
            "GPU RK demag assemble phase timing readback",
            reason)) {
        return false;
    }
    if (!collect_phase_timing_events(
            timings.demag_recover_events,
            timings.demag_recover_used,
            timings.demag_recover_wall_time_ns,
            "GPU RK demag recover phase timing readback",
            reason)) {
        return false;
    }
    if (!collect_phase_timing_events(
            timings.demag_energy_events,
            timings.demag_energy_used,
            timings.demag_energy_wall_time_ns,
            "GPU RK demag energy phase timing readback",
            reason)) {
        return false;
    }
    if (!collect_phase_timing_events(
            timings.rhs_events,
            timings.rhs_used,
            timings.rhs_wall_time_ns,
            "GPU RK RHS phase timing readback",
            reason)) {
        return false;
    }
    stats.exchange_wall_time_ns = timings.exchange_wall_time_ns;
    stats.rhs_wall_time_ns = timings.rhs_wall_time_ns;
#if FULLMAG_HAS_MFEM_STACK
    ctx.poisson_demag.step_assemble_wall_time_ns =
        timings.demag_assemble_wall_time_ns;
    ctx.poisson_demag.step_recover_wall_time_ns =
        timings.demag_recover_wall_time_ns;
    ctx.poisson_demag.step_energy_wall_time_ns =
        timings.demag_energy_wall_time_ns;
#endif
    return true;
}

} // namespace

double *gpu_rk_final_scalar_result(FemGpuState &gpu, GpuFinalScalarSlot slot)
{
    return gpu.reductions.scalar_result + static_cast<int>(slot);
}

bool gpu_rk_prepare_phase_timing_events(
    Context &ctx,
    const ExplicitTableau &tableau,
    std::string &reason)
{
    const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled;
    const uint64_t attempts = adaptive
        ? static_cast<uint64_t>(ctx.adaptive_dt.max_reject) + 1ull
        : 1ull;
    const uint64_t stages_per_attempt =
        static_cast<uint64_t>(std::max(1, tableau.stages));
    const size_t required_count =
        static_cast<size_t>(attempts * stages_per_attempt + 1ull);

    return gpu_rk_prepare_phase_timing_event_count(ctx, required_count, reason);
}

bool gpu_rk_prepare_phase_timing_event_count(
    Context &ctx,
    size_t required_count,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    auto &timings = ctx.gpu_state.rk_phase_timings;
    refresh_phase_timing_enablement(ctx);
    if (!gpu.lifecycle.allocated) {
        return true;
    }
    if (!timings.enabled) {
        return true;
    }

    if (!ensure_phase_timing_events(
            timings.exchange_events,
            required_count,
            "GPU RK exchange phase timing pool",
            reason)) {
        return false;
    }
    if (!ensure_phase_timing_events(
            timings.demag_assemble_events,
            required_count,
            "GPU RK demag assemble phase timing pool",
            reason)) {
        return false;
    }
    if (!ensure_phase_timing_events(
            timings.demag_recover_events,
            required_count,
            "GPU RK demag recover phase timing pool",
            reason)) {
        return false;
    }
    if (!ensure_phase_timing_events(
            timings.demag_energy_events,
            required_count,
            "GPU RK demag energy phase timing pool",
            reason)) {
        return false;
    }
    if (!ensure_phase_timing_events(
            timings.rhs_events,
            required_count,
            "GPU RK RHS phase timing pool",
            reason)) {
        return false;
    }
#if FULLMAG_HAS_MFEM_STACK
    return prepare_context_hypre_apply_device_timing(
        ctx,
        true,
        required_count,
        reason);
#endif
    return true;
}

void gpu_rk_reset_phase_timing_events(Context &ctx)
{
    reset_phase_timing_accumulators(ctx);
#if FULLMAG_HAS_MFEM_STACK
    reset_context_hypre_apply_device_timing(ctx);
#endif
}

void gpu_rk_destroy_phase_timing_events(Context &ctx)
{
    auto &timings = ctx.gpu_state.rk_phase_timings;
    timings.configured = false;
    timings.enabled = false;
    destroy_phase_timing_events(timings.exchange_events);
    destroy_phase_timing_events(timings.demag_assemble_events);
    destroy_phase_timing_events(timings.demag_recover_events);
    destroy_phase_timing_events(timings.demag_energy_events);
    destroy_phase_timing_events(timings.rhs_events);
#if FULLMAG_HAS_MFEM_STACK
    destroy_context_hypre_apply_device_timing_events(ctx);
#endif
    gpu_rk_destroy_step_transaction_timing(ctx);
    timings.exchange_wall_time_ns = 0;
    timings.demag_assemble_wall_time_ns = 0;
    timings.demag_recover_wall_time_ns = 0;
    timings.demag_energy_wall_time_ns = 0;
    timings.rhs_wall_time_ns = 0;
    timings.exchange_used = 0;
    timings.demag_assemble_used = 0;
    timings.demag_recover_used = 0;
    timings.demag_energy_used = 0;
    timings.rhs_used = 0;
    timings.exchange_overflow_count = 0;
    timings.demag_assemble_overflow_count = 0;
    timings.demag_recover_overflow_count = 0;
    timings.demag_energy_overflow_count = 0;
    timings.rhs_overflow_count = 0;
}

bool finalize_step_stats_impl(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    bool control_scalar_readback,
    double *tail_scalars,
    size_t tail_count,
    std::string &reason)
{
    if (tail_count > 0 &&
        (tail_scalars == nullptr ||
         kGpuFinalScalarSlots + tail_count > FEM_GPU_SCALAR_RESULT_SLOTS)) {
        reason = "GPU RK final scalar tail readback request exceeds scalar result slots";
        return false;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.residency.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        gpu.reductions.scalar_result == nullptr ||
        gpu.reductions.temp_storage == nullptr) {
        return true;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> scalar_storage{};

    const int n = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    if (blocks <= 0) {
        return true;
    }

    if (!gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_observable_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    const size_t read_count =
        tail_count > 0 ? FEM_GPU_SCALAR_RESULT_SLOTS : kGpuFinalScalarSlots;
    const bool read_ok = control_scalar_readback
        ? gpu_rk_read_control_scalar_results(
              ctx,
              stream,
              "cudaMemcpyAsync GPU RK final scalar stats device->host",
              scalar_storage.data(),
              read_count,
              reason)
        : gpu_rk_read_scalar_results(
              ctx,
              stream,
              "cudaMemcpyAsync GPU RK final scalar stats device->host",
              scalar_storage.data(),
              read_count,
              reason);
    if (!read_ok) {
        return false;
    }

    // The scalar readback above is the existing stream fence. Transaction
    // event elapsed values are collected only after that fence; this path
    // adds no synchronization to the RK hot loop.
    if (!gpu_rk_collect_step_transaction_timing(ctx, reason)) {
        return false;
    }

    if (!collect_gpu_rk_phase_timing_events(ctx, stats, reason)) {
        return false;
    }

    std::array<double, kGpuFinalScalarSlots> scalars{};
    std::copy_n(scalar_storage.begin(), kGpuFinalScalarSlots, scalars.begin());
    for (size_t i = 0; i < tail_count; ++i) {
        tail_scalars[i] = scalar_storage[kGpuFinalScalarSlots + i];
    }
    gpu_rk_publish_final_step_stats(ctx, scalars, stats);
    return true;
}

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    return finalize_step_stats_impl(ctx, stats, false, nullptr, 0, reason);
}

bool gpu_rk_finalize_step_stats_control_readback(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    return finalize_step_stats_impl(ctx, stats, true, nullptr, 0, reason);
}

bool gpu_rk_finalize_step_stats_control_readback_with_scalar_tail(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    double *tail_scalars,
    size_t tail_count,
    std::string &reason)
{
    return finalize_step_stats_impl(ctx, stats, true, tail_scalars, tail_count, reason);
}

} // namespace fullmag::fem
