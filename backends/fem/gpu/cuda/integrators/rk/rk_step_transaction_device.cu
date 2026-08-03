#include "gpu/cuda/integrators/rk/rk_step_transaction_device.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"

#include <cuda_runtime.h>

#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <vector>

namespace fullmag::fem {
namespace {

using TransactionTelemetry = GpuRkTransactionTelemetryRuntimeState;
constexpr size_t kMaxTransactionTimingEventPairs = 128u;

bool transaction_profile_enabled(const Context &ctx)
{
    const auto &timings = ctx.gpu_state.rk_phase_timings;
    if (timings.override_configured) {
        return timings.override_enabled;
    }
    const char *raw = std::getenv("FULLMAG_FEM_STEP_PROFILE");
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
        std::strcmp(raw, "true") == 0 ||
        std::strcmp(raw, "TRUE") == 0 ||
        std::strcmp(raw, "on") == 0 ||
        std::strcmp(raw, "ON") == 0 ||
        std::strcmp(raw, "yes") == 0 ||
        std::strcmp(raw, "YES") == 0;
}

uint64_t saturating_add(uint64_t lhs, uint64_t rhs)
{
    return lhs > std::numeric_limits<uint64_t>::max() - rhs
        ? std::numeric_limits<uint64_t>::max()
        : lhs + rhs;
}

uint64_t saturating_mul(uint64_t lhs, uint64_t rhs)
{
    return lhs != 0 && rhs > std::numeric_limits<uint64_t>::max() / lhs
        ? std::numeric_limits<uint64_t>::max()
        : lhs * rhs;
}

void reset_transaction_sample(TransactionTelemetry &telemetry)
{
    telemetry.capture_used = 0;
    telemetry.restore_used = 0;
    telemetry.capture_bytes = 0;
    telemetry.restore_bytes = 0;
    telemetry.capture_device_elapsed_ns = 0;
    telemetry.restore_device_elapsed_ns = 0;
}

void reset_transaction_sample_at_public_step_start(Context &ctx)
{
    /*
     * run_backend_step clears the CPU transaction telemetry exactly once at
     * the public-step boundary.  Energy-rejection retries keep the counter
     * nonzero, so their GPU capture/restore samples remain aggregated.
     */
    if (ctx.stepper.transaction_telemetry.step_transaction_begin_count == 0) {
        reset_transaction_sample(ctx.gpu_state.rk_transaction_telemetry);
    }
}

void destroy_event_pairs(std::vector<TransactionTelemetry::EventPair> &events)
{
    for (auto &pair : events) {
        if (pair.start_event != nullptr) {
            cudaEventDestroy(static_cast<cudaEvent_t>(pair.start_event));
            pair.start_event = nullptr;
        }
        if (pair.stop_event != nullptr) {
            cudaEventDestroy(static_cast<cudaEvent_t>(pair.stop_event));
            pair.stop_event = nullptr;
        }
    }
    events.clear();
}

bool ensure_event_pair(
    std::vector<TransactionTelemetry::EventPair> &events,
    size_t index,
    uint64_t &created,
    const char *label,
    std::string &error)
{
    if (index >= kMaxTransactionTimingEventPairs) {
        error = std::string(label) + " exceeds bounded event-pair capacity";
        return false;
    }
    try {
        if (events.size() <= index) {
            events.resize(index + 1u);
        }
    } catch (const std::bad_alloc &) {
        error = std::string(label) + " allocation failed";
        return false;
    }
    auto &pair = events[index];
    if (pair.start_event == nullptr) {
        cudaEvent_t event = nullptr;
        const auto rc = cudaEventCreate(&event);
        if (rc != cudaSuccess) {
            error = std::string(label) + " start event creation failed: " +
                cudaGetErrorString(rc);
            return false;
        }
        pair.start_event = static_cast<void *>(event);
        created = saturating_add(created, 1u);
    }
    if (pair.stop_event == nullptr) {
        cudaEvent_t event = nullptr;
        const auto rc = cudaEventCreate(&event);
        if (rc != cudaSuccess) {
            error = std::string(label) + " stop event creation failed: " +
                cudaGetErrorString(rc);
            return false;
        }
        pair.stop_event = static_cast<void *>(event);
    }
    return true;
}

bool record_event(void *event, cudaStream_t stream, const char *label, std::string &error)
{
    const auto rc = cudaEventRecord(static_cast<cudaEvent_t>(event), stream);
    if (rc != cudaSuccess) {
        error = std::string(label) + " failed: " + cudaGetErrorString(rc);
        return false;
    }
    return true;
}

uint64_t transaction_payload_bytes(const Context &ctx)
{
    const auto &gpu = ctx.gpu_state.device;
    const uint64_t node_count = gpu.lifecycle.node_count;
    // 13 three-component fields: m, k0, and the eleven published H fields.
    uint64_t bytes = saturating_mul(
        saturating_mul(node_count, 13u * 3u), sizeof(double));
    if (gpu.demag_poisson.poisson_solution != nullptr) {
        bytes = saturating_add(bytes, saturating_mul(
            gpu.demag_poisson.scalar_dof_count, sizeof(double)));
    }
    if (gpu.demag_poisson.poisson_solution_full != nullptr) {
        bytes = saturating_add(bytes, saturating_mul(
            gpu.demag_poisson.full_scalar_dof_count, sizeof(double)));
    }
    return bytes;
}

bool collect_event_pairs(
    std::vector<TransactionTelemetry::EventPair> &events,
    size_t &used,
    uint64_t &elapsed_ns,
    const char *label,
    std::string &error)
{
    for (size_t index = 0; index < used; ++index) {
        float elapsed_ms = 0.0f;
        const auto rc = cudaEventElapsedTime(
            &elapsed_ms,
            static_cast<cudaEvent_t>(events[index].start_event),
            static_cast<cudaEvent_t>(events[index].stop_event));
        if (rc != cudaSuccess) {
            error = std::string(label) + " failed: " + cudaGetErrorString(rc);
            return false;
        }
        const uint64_t elapsed = elapsed_ms > 0.0f
            ? static_cast<uint64_t>(elapsed_ms * 1000000.0f)
            : 0u;
        elapsed_ns = saturating_add(elapsed_ns, elapsed);
    }
    used = 0;
    return true;
}

bool copy_scalar(
    const double *source,
    double *destination,
    uint64_t count,
    cudaStream_t stream,
    const char *label,
    std::string &error)
{
    if (source == nullptr) {
        return true;
    }
    if (destination == nullptr) {
        error = std::string(label) + " backup storage is unavailable";
        return false;
    }
    const auto rc = cudaMemcpyAsync(
        destination,
        source,
        static_cast<size_t>(count) * sizeof(double),
        cudaMemcpyDeviceToDevice,
        stream);
    if (rc != cudaSuccess) {
        error = std::string(label) + " failed: " + cudaGetErrorString(rc);
        return false;
    }
    return true;
}

bool copy_published_device_state(
    Context &ctx,
    bool restore,
    bool record_telemetry,
    std::string &error)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu.lifecycle.allocated) {
        return true;
    }
    auto stream = static_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const uint64_t count = gpu.lifecycle.node_count;
    auto &telemetry = ctx.gpu_state.rk_transaction_telemetry;
    auto &events = restore ? telemetry.restore_events : telemetry.capture_events;
    auto &used = restore ? telemetry.restore_used : telemetry.capture_used;
    auto &created = restore
        ? telemetry.restore_event_pairs_created
        : telemetry.capture_event_pairs_created;
    if (record_telemetry) {
        if (!ensure_event_pair(
                events,
                used,
                created,
                restore
                    ? "GPU RK transaction restore timing"
                    : "GPU RK transaction capture timing",
                error)) {
            return false;
        }
        if (!record_event(
                events[used].start_event,
                stream,
                restore
                    ? "cudaEventRecord GPU RK transaction restore start"
                    : "cudaEventRecord GPU RK transaction capture start",
                error)) {
            return false;
        }
    }
    auto copy_component = [&](FemGpuComponentField &live,
                              FemGpuComponentField &backup,
                              const char *label) {
        const auto &source = restore ? backup : live;
        auto &destination = restore ? live : backup;
        return gpu_rk_copy_component_device(
            source, destination, count, stream, label, error);
    };

    auto &rk = gpu.rk;
    auto &fields = gpu.fields;
    if (!copy_component(gpu.magnetization.m, rk.transaction_m, "GPU RK transaction magnetization copy") ||
        !copy_component(rk.k[0], rk.transaction_k0, "GPU RK transaction FSAL copy") ||
        !copy_component(fields.h_ex, rk.transaction_h_ex, "GPU RK transaction H_ex copy") ||
        !copy_component(fields.h_demag, rk.transaction_h_demag, "GPU RK transaction H_demag copy") ||
        !copy_component(fields.h_drive, rk.transaction_h_drive, "GPU RK transaction H_drive copy") ||
        !copy_component(fields.h_ani, rk.transaction_h_ani, "GPU RK transaction H_ani copy") ||
        !copy_component(fields.h_cubic_ani, rk.transaction_h_cubic_ani, "GPU RK transaction H_cubic copy") ||
        !copy_component(fields.h_dmi, rk.transaction_h_dmi, "GPU RK transaction H_dmi copy") ||
        !copy_component(fields.h_bulk_dmi, rk.transaction_h_bulk_dmi, "GPU RK transaction H_bulk_dmi copy") ||
        !copy_component(fields.h_oe, rk.transaction_h_oe, "GPU RK transaction H_oe copy") ||
        !copy_component(fields.h_therm, rk.transaction_h_therm, "GPU RK transaction H_therm copy") ||
        !copy_component(fields.h_mel, rk.transaction_h_mel, "GPU RK transaction H_mel copy") ||
        !copy_component(fields.h_eff, rk.transaction_h_eff, "GPU RK transaction H_eff copy")) {
        return false;
    }

    auto copy_optional_scalar = [&] (
        double *live,
        double *backup,
        uint64_t scalar_count,
        const char *label) {
        if (live == nullptr) {
            return true;
        }
        return restore
            ? copy_scalar(backup, live, scalar_count, stream, label, error)
            : copy_scalar(live, backup, scalar_count, stream, label, error);
    };
    if (gpu.demag_poisson.poisson_solution != nullptr &&
        !copy_optional_scalar(
            gpu.demag_poisson.poisson_solution,
            rk.transaction_poisson_solution,
            gpu.demag_poisson.scalar_dof_count,
            "GPU RK transaction Poisson solution copy")) {
        return false;
    }
    if (gpu.demag_poisson.poisson_solution_full != nullptr &&
        !copy_optional_scalar(
            gpu.demag_poisson.poisson_solution_full,
            rk.transaction_poisson_solution_full,
            gpu.demag_poisson.full_scalar_dof_count,
            "GPU RK transaction full Poisson solution copy")) {
        return false;
    }

    if (record_telemetry) {
        if (!record_event(
                events[used].stop_event,
                stream,
                restore
                    ? "cudaEventRecord GPU RK transaction restore stop"
                    : "cudaEventRecord GPU RK transaction capture stop",
                error)) {
            return false;
        }
        used += 1u;
        auto &bytes = restore ? telemetry.restore_bytes : telemetry.capture_bytes;
        bytes = saturating_add(bytes, transaction_payload_bytes(ctx));
    }

    if (restore) {
        const auto rc = cudaStreamSynchronize(stream);
        if (rc != cudaSuccess) {
            error = std::string("GPU RK transaction rollback synchronization failed: ") +
                cudaGetErrorString(rc);
            return false;
        }
        if (record_telemetry &&
            !collect_event_pairs(
                events,
                used,
                telemetry.restore_device_elapsed_ns,
                "GPU RK transaction restore timing readback",
                error)) {
            return false;
        }
    }
    return true;
}

} // namespace

bool gpu_rk_capture_step_transaction_device(Context &ctx, std::string &error)
{
    const bool profile_enabled = transaction_profile_enabled(ctx);
    if (profile_enabled) {
        // Clear only at the first outer transaction of a public step; event
        // handles remain allocated for reuse across retries and steps.
        reset_transaction_sample_at_public_step_start(ctx);
    } else if (
        (!ctx.gpu_state.rk_transaction_telemetry.capture_events.empty() ||
         !ctx.gpu_state.rk_transaction_telemetry.restore_events.empty())) {
        gpu_rk_destroy_step_transaction_timing(ctx);
    }
    return copy_published_device_state(
        ctx,
        false,
        profile_enabled,
        error);
}

bool gpu_rk_restore_step_transaction_device(Context &ctx, std::string &error)
{
    const bool profile_enabled = transaction_profile_enabled(ctx);
    return copy_published_device_state(
        ctx,
        true,
        profile_enabled,
        error);
}

bool gpu_relax_capture_step_transaction_device_unprofiled(
    Context &ctx,
    std::string &error)
{
    return copy_published_device_state(ctx, false, false, error);
}

bool gpu_relax_restore_step_transaction_device_unprofiled(
    Context &ctx,
    std::string &error)
{
    return copy_published_device_state(ctx, true, false, error);
}

bool gpu_rk_collect_step_transaction_timing(Context &ctx, std::string &error)
{
    auto &telemetry = ctx.gpu_state.rk_transaction_telemetry;
    if (!transaction_profile_enabled(ctx)) {
        return true;
    }
    return collect_event_pairs(
               telemetry.capture_events,
               telemetry.capture_used,
               telemetry.capture_device_elapsed_ns,
               "GPU RK transaction capture timing readback",
               error) &&
        collect_event_pairs(
               telemetry.restore_events,
               telemetry.restore_used,
               telemetry.restore_device_elapsed_ns,
               "GPU RK transaction restore timing readback",
               error);
}

void gpu_rk_destroy_step_transaction_timing(Context &ctx)
{
    auto &telemetry = ctx.gpu_state.rk_transaction_telemetry;
    destroy_event_pairs(telemetry.capture_events);
    destroy_event_pairs(telemetry.restore_events);
    telemetry = {};
}

} // namespace fullmag::fem
