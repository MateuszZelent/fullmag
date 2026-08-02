/*
 * Exact HYPRE 3.1.0 CUDA stream adapter for strict FEM GPU demag.
 */

#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"
#include "context.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/runtime/nvtx_ranges.hpp"

#include <algorithm>
#include <new>

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
#include <mfem/config/_config.hpp>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_config.h>
#include <_hypre_utilities.h>

#if MFEM_VERSION != 40900
#error "FEM GPU HYPRE stream interop requires MFEM 4.9.0"
#endif

static_assert(
    HYPRE_RELEASE_NUMBER == 30100,
    "FEM GPU HYPRE stream interop requires HYPRE 3.1.0");

// HYPRE publishes the handle macro in _hypre_utilities.h, but its CUDA stream
// accessor declaration is emitted only by the NVCC-oriented C++ private
// header. The symbol is exported by the pinned HYPRE 3.1.0 library.
cudaStream_t hypre_DeviceDataComputeStream(hypre_DeviceData *data);
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_ENABLE_NVTX
extern "C" uint64_t fullmag_fem_nvtx_range_start(const char *name) noexcept
{
    return nvtx::start(name);
}

extern "C" void fullmag_fem_nvtx_range_end(uint64_t id) noexcept
{
    nvtx::end(id);
}
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

} // namespace

void destroy_hypre_stream_interop(HypreStreamInterop &interop) noexcept
{
    destroy_hypre_apply_device_timing_events(interop);
    if (interop.fullmag_ready != nullptr) {
        cudaEventDestroy(interop.fullmag_ready);
    }
    if (interop.hypre_done != nullptr) {
        cudaEventDestroy(interop.hypre_done);
    }
    if (interop.hypre_validation_done != nullptr) {
        cudaEventDestroy(interop.hypre_validation_done);
    }
    interop = HypreStreamInterop{};
}

void destroy_hypre_apply_device_timing_events(
    HypreStreamInterop &interop) noexcept
{
    for (auto &event : interop.apply_timing_events) {
        if (event.start_event != nullptr) {
            cudaEventDestroy(event.start_event);
        }
        if (event.stop_event != nullptr) {
            cudaEventDestroy(event.stop_event);
        }
    }
    interop.apply_timing_events.clear();
    interop.apply_timing_used = 0;
    interop.active_apply_timing_index = 0;
    interop.apply_timing_overflow_count = 0;
    interop.apply_timing_completed_count = 0;
    interop.apply_device_elapsed_time_ns = 0;
    interop.apply_timing_active = false;
    interop.apply_timing_enabled = false;
    interop.last_wait_in_enqueue_wall_time_ns = 0;
    interop.last_wait_out_enqueue_wall_time_ns = 0;
}

bool prepare_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    bool enabled,
    size_t required_count,
    std::string &error)
{
    if (!enabled) {
        destroy_hypre_apply_device_timing_events(interop);
        return true;
    }
    const size_t old_count = interop.apply_timing_events.size();
    if (old_count < required_count) {
        try {
            interop.apply_timing_events.resize(required_count);
        } catch (const std::bad_alloc &) {
            error = "strict FEM GPU demag HYPRE apply timing pool allocation failed";
            return false;
        }
    }
    for (size_t index = old_count; index < required_count; ++index) {
        auto &event = interop.apply_timing_events[index];
        if (!cuda_ok(
                cudaEventCreate(&event.start_event),
                "cudaEventCreate strict FEM GPU demag HYPRE apply timing start",
                error) ||
            !cuda_ok(
                cudaEventCreate(&event.stop_event),
                "cudaEventCreate strict FEM GPU demag HYPRE apply timing stop",
                error)) {
            destroy_hypre_apply_device_timing_events(interop);
            return false;
        }
    }
    interop.apply_timing_enabled = true;
    return true;
}

void reset_hypre_apply_device_timing(HypreStreamInterop &interop) noexcept
{
    interop.apply_timing_used = 0;
    interop.active_apply_timing_index = 0;
    interop.apply_timing_overflow_count = 0;
    interop.apply_timing_completed_count = 0;
    interop.apply_device_elapsed_time_ns = 0;
    interop.apply_timing_active = false;
    interop.last_wait_in_enqueue_wall_time_ns = 0;
    interop.last_wait_out_enqueue_wall_time_ns = 0;
}

bool begin_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    std::string &error)
{
    if (!interop.apply_timing_enabled) {
        return true;
    }
    if (interop.apply_timing_active) {
        error = "strict FEM GPU demag HYPRE apply device timing is already active";
        return false;
    }
    if (interop.apply_timing_used >= interop.apply_timing_events.size()) {
        interop.apply_timing_overflow_count += 1;
        return true;
    }
    const size_t index = interop.apply_timing_used++;
    auto &event = interop.apply_timing_events[index];
    if (!cuda_ok(
            cudaEventRecord(event.start_event, interop.hypre_stream),
            "cudaEventRecord strict FEM GPU demag HYPRE apply timing start",
            error)) {
        return false;
    }
    interop.active_apply_timing_index = index;
    interop.apply_timing_active = true;
    return true;
}

bool end_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    std::string &error)
{
    if (!interop.apply_timing_enabled || !interop.apply_timing_active) {
        return true;
    }
    auto &event =
        interop.apply_timing_events[interop.active_apply_timing_index];
    if (!cuda_ok(
            cudaEventRecord(event.stop_event, interop.hypre_stream),
            "cudaEventRecord strict FEM GPU demag HYPRE apply timing stop",
            error)) {
        interop.apply_timing_active = false;
        return false;
    }
    interop.apply_timing_active = false;
    interop.apply_timing_completed_count += 1;
    return true;
}

bool collect_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    uint64_t &elapsed_time_ns,
    std::string &error)
{
    interop.apply_device_elapsed_time_ns = 0;
    const size_t bounded_used = std::min(
        interop.apply_timing_used,
        interop.apply_timing_events.size());
    for (size_t index = 0; index < bounded_used; ++index) {
        auto &event = interop.apply_timing_events[index];
        float elapsed_ms = 0.0f;
        const cudaError_t rc = cudaEventElapsedTime(
            &elapsed_ms,
            event.start_event,
            event.stop_event);
        if (rc != cudaSuccess) {
            error = std::string("cudaEventElapsedTime strict FEM GPU demag HYPRE apply failed: ") +
                cudaGetErrorString(rc);
            return false;
        }
        if (elapsed_ms > 0.0f) {
            interop.apply_device_elapsed_time_ns +=
                static_cast<uint64_t>(elapsed_ms * 1000000.0f);
        }
    }
    elapsed_time_ns = interop.apply_device_elapsed_time_ns;
    return true;
}

bool prepare_context_hypre_apply_device_timing(
    Context &ctx,
    bool enabled,
    size_t required_count,
    std::string &error)
{
    auto *workspace = workspace_ptr(ctx);
    return workspace == nullptr || prepare_hypre_apply_device_timing(
        workspace->stream_interop,
        enabled,
        required_count,
        error);
}

void reset_context_hypre_apply_device_timing(Context &ctx) noexcept
{
    if (auto *workspace = workspace_ptr(ctx); workspace != nullptr) {
        reset_hypre_apply_device_timing(workspace->stream_interop);
    }
}

bool collect_context_hypre_apply_device_timing(
    Context &ctx,
    uint64_t &elapsed_time_ns,
    std::string &error)
{
    auto *workspace = workspace_ptr(ctx);
    if (workspace == nullptr) {
        elapsed_time_ns = 0;
        return true;
    }
    return collect_hypre_apply_device_timing(
        workspace->stream_interop,
        elapsed_time_ns,
        error);
}

uint64_t context_hypre_apply_timed_solve_count(
    const Context &ctx) noexcept
{
    const auto *workspace = workspace_ptr(ctx);
    return workspace == nullptr
        ? 0
        : workspace->stream_interop.apply_timing_completed_count;
}

void destroy_context_hypre_apply_device_timing_events(Context &ctx) noexcept
{
    if (auto *workspace = workspace_ptr(ctx); workspace != nullptr) {
        destroy_hypre_apply_device_timing_events(workspace->stream_interop);
    }
}

bool initialize_hypre_stream_interop(
    HypreStreamInterop &interop,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    destroy_hypre_stream_interop(interop);
    interop.hypre_stream = hypre_HandleComputeStream(hypre_handle());
    if (interop.hypre_stream == nullptr) {
        error = "strict FEM GPU demag could not borrow the HYPRE 3.1.0 compute stream";
        return false;
    }
    if (!cuda_ok(
            cudaEventCreateWithFlags(&interop.fullmag_ready, cudaEventDisableTiming),
            "cudaEventCreate strict FEM GPU demag Fullmag-ready",
            error) ||
        !cuda_ok(
            cudaEventCreateWithFlags(&interop.hypre_done, cudaEventDisableTiming),
            "cudaEventCreate strict FEM GPU demag HYPRE-done",
            error) ||
        !cuda_ok(
            cudaEventCreateWithFlags(&interop.hypre_validation_done, cudaEventDisableTiming),
            "cudaEventCreate strict FEM GPU demag HYPRE-validation-done",
            error)) {
        destroy_hypre_stream_interop(interop);
        return false;
    }
    interop.ready = true;
    return true;
#else
    (void)interop;
    error = "strict FEM GPU demag HYPRE stream interop requires MFEM MPI";
    return false;
#endif
}

bool hypre_wait_for_fullmag(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error)
{
    if (!interop.ready || interop.hypre_stream == nullptr ||
        interop.fullmag_ready == nullptr) {
        error = "strict FEM GPU demag HYPRE stream interop is not initialized";
        return false;
    }
    // Enqueue timing is opt-in with the rest of the HYPRE timing telemetry.
    // Keep the dependency events and their ordering active when profiling is
    // disabled, but avoid paying for host clock reads on every demag solve.
    const bool measure_enqueue = interop.apply_timing_enabled;
    const auto enqueue_start = measure_enqueue
        ? FemSteadyClock::now()
        : FemSteadyClock::time_point{};
    if (!cuda_ok(
            cudaEventRecord(interop.fullmag_ready, fullmag_stream),
            "cudaEventRecord strict FEM GPU demag Fullmag-ready",
            error) ||
        !cuda_ok(
            cudaStreamWaitEvent(interop.hypre_stream, interop.fullmag_ready, 0),
            "cudaStreamWaitEvent strict FEM GPU demag HYPRE waits for Fullmag",
            error)) {
        return false;
    }
    interop.last_wait_in_enqueue_wall_time_ns = measure_enqueue
        ? elapsed_ns(enqueue_start)
        : 0;
    interop.event_wait_count += 1u;
    return true;
}

bool fullmag_wait_for_hypre(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error)
{
    if (!interop.ready || interop.hypre_stream == nullptr ||
        interop.hypre_done == nullptr) {
        error = "strict FEM GPU demag HYPRE stream interop is not initialized";
        return false;
    }
    const bool measure_enqueue = interop.apply_timing_enabled;
    const auto enqueue_start = measure_enqueue
        ? FemSteadyClock::now()
        : FemSteadyClock::time_point{};
    if (!cuda_ok(
            cudaEventRecord(interop.hypre_done, interop.hypre_stream),
            "cudaEventRecord strict FEM GPU demag HYPRE-done",
            error) ||
        !cuda_ok(
            cudaStreamWaitEvent(fullmag_stream, interop.hypre_done, 0),
            "cudaStreamWaitEvent strict FEM GPU demag Fullmag waits for HYPRE",
            error)) {
        return false;
    }
    interop.last_wait_out_enqueue_wall_time_ns = measure_enqueue
        ? elapsed_ns(enqueue_start)
        : 0;
    interop.event_wait_count += 1u;
    return true;
}

bool mfem_default_stream_wait_for_hypre_validation(
    HypreStreamInterop &interop,
    std::string &error)
{
    if (!interop.ready || interop.hypre_stream == nullptr ||
        interop.hypre_validation_done == nullptr) {
        error = "strict FEM GPU demag HYPRE stream interop is not initialized";
        return false;
    }
    if (!cuda_ok(
            cudaEventRecord(interop.hypre_validation_done, interop.hypre_stream),
            "cudaEventRecord strict FEM GPU demag HYPRE-validation-done",
            error) ||
        !cuda_ok(
            cudaStreamWaitEvent(nullptr, interop.hypre_validation_done, 0),
            "cudaStreamWaitEvent strict FEM GPU demag MFEM waits for HYPRE validation",
            error)) {
        return false;
    }
    interop.event_wait_count += 1u;
    return true;
#endif

} // namespace fullmag::fem
