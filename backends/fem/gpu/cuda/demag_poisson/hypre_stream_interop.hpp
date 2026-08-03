/*
 * Version-pinned CUDA stream interop for strict FEM GPU Hypre demag.
 *
 * This owner borrows the exact HYPRE compute stream and owns only the CUDA
 * events used to order Fullmag producers and consumers around Hypre Mult.
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_CUDA_RUNTIME
struct HypreApplyTimingEventPair {
    cudaEvent_t start_event = nullptr;
    cudaEvent_t stop_event = nullptr;
};

struct HypreStreamInterop {
    cudaStream_t hypre_stream = nullptr;
    cudaEvent_t fullmag_ready = nullptr;
    cudaEvent_t hypre_done = nullptr;
    cudaEvent_t hypre_validation_done = nullptr;
    uint64_t event_wait_count = 0;
    uint64_t global_sync_count = 0;
    /* CPU enqueue time for each dependency pair; never GPU blocking time. */
    uint64_t last_wait_in_enqueue_wall_time_ns = 0;
    uint64_t last_wait_out_enqueue_wall_time_ns = 0;
    std::vector<HypreApplyTimingEventPair> apply_timing_events{};
    size_t apply_timing_used = 0;
    size_t active_apply_timing_index = 0;
    uint64_t apply_timing_overflow_count = 0;
    uint64_t apply_timing_completed_count = 0;
    uint64_t apply_device_elapsed_time_ns = 0;
    bool apply_timing_active = false;
    bool apply_timing_enabled = false;
    bool ready = false;
};

bool initialize_hypre_stream_interop(
    HypreStreamInterop &interop,
    std::string &error);

bool hypre_wait_for_fullmag(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error);

bool fullmag_wait_for_hypre(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error);

bool mfem_default_stream_wait_for_hypre_validation(
    HypreStreamInterop &interop,
    std::string &error);

bool prepare_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    bool enabled,
    size_t required_count,
    std::string &error);

void reset_hypre_apply_device_timing(HypreStreamInterop &interop) noexcept;

bool begin_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    std::string &error);

bool end_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    std::string &error);

bool collect_hypre_apply_device_timing(
    HypreStreamInterop &interop,
    uint64_t &elapsed_time_ns,
    std::string &error);

void destroy_hypre_apply_device_timing_events(
    HypreStreamInterop &interop) noexcept;

bool prepare_context_hypre_apply_device_timing(
    Context &ctx,
    bool enabled,
    size_t required_count,
    std::string &error);

void reset_context_hypre_apply_device_timing(Context &ctx) noexcept;

bool collect_context_hypre_apply_device_timing(
    Context &ctx,
    uint64_t &elapsed_time_ns,
    std::string &error);

uint64_t context_hypre_apply_timed_solve_count(
    const Context &ctx) noexcept;

void destroy_context_hypre_apply_device_timing_events(Context &ctx) noexcept;

void destroy_hypre_stream_interop(HypreStreamInterop &interop) noexcept;
#endif

} // namespace fullmag::fem
