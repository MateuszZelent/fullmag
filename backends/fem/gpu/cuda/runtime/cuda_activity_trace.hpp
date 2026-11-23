#pragma once

#include <cstdint>

namespace fullmag::fem::cuda_trace {

// The host clock registered as the CUPTI activity timestamp source on Linux.
std::uint64_t host_activity_timestamp_ns() noexcept;

enum ModalEpsSolveTraceFlag : std::uint64_t {
    modal_eps_trace_complete = 1ULL << 0,
    modal_eps_trace_unavailable = 1ULL << 1,
    modal_eps_trace_unsupported = 1ULL << 2,
    modal_eps_trace_unclassified = 1ULL << 3,
    modal_eps_trace_lost = 1ULL << 4,
    modal_eps_trace_flush_failed = 1ULL << 5,
    modal_eps_trace_buffer_overflow = 1ULL << 6,
    modal_eps_trace_invalid_window = 1ULL << 7,
    modal_eps_trace_no_kernel_activity = 1ULL << 8,
};

enum ModalEpsSolveTraceCoverage : std::uint64_t {
    modal_eps_coverage_kernel = 1ULL << 0,
    modal_eps_coverage_runtime_api = 1ULL << 1,
    modal_eps_coverage_driver_api = 1ULL << 2,
    modal_eps_coverage_memcpy = 1ULL << 3,
    modal_eps_coverage_memset = 1ULL << 4,
    modal_eps_coverage_synchronization = 1ULL << 5,
    modal_eps_coverage_memory = 1ULL << 6,
    modal_eps_coverage_cuda_event_metadata = 1ULL << 7,
};

enum ModalEpsSolveCounterCoverage : std::uint64_t {
    modal_eps_counter_coverage_transfers = 1ULL << 0,
    modal_eps_counter_coverage_allocations = 1ULL << 1,
    modal_eps_counter_coverage_host_sync = 1ULL << 2,
    // A complete transfer trace with zero D2H proves zero scalar telemetry transfers.
    modal_eps_counter_coverage_scalar_telemetry_d2h = 1ULL << 3,
    modal_eps_counter_coverage_full_vector_crossings = 1ULL << 4,
};

enum ModalEpsSolveAllocationKindCoverage : std::uint64_t {
    modal_eps_allocation_kind_device = 1ULL << 0,
    modal_eps_allocation_kind_managed = 1ULL << 1,
    modal_eps_allocation_kind_host = 1ULL << 2,
};

struct PhaseTokenV1 {
    std::uint64_t capture_token = 0;
    std::uint64_t value = 0;
    std::uint64_t flags = 0;
};

struct ModalEpsSolveTraceV1 {
    std::uint64_t schema_version = 1;
    std::uint64_t start_ns = 0;
    std::uint64_t end_ns = 0;
    std::uint64_t observed_activity_records = 0;
    // Observed timed record kinds. Counter coverage separately gates semantic counters.
    std::uint64_t phase_coverage = 0;
    // Set bits mean the corresponding counter family is complete; otherwise its values are unavailable.
    std::uint64_t counter_coverage = 0;
    std::uint64_t kernel_records = 0;
    std::uint64_t kernel_duration_ns = 0;
    std::uint64_t h2d_count = 0;
    std::uint64_t h2d_bytes = 0;
    std::uint64_t d2h_count = 0;
    std::uint64_t d2h_bytes = 0;
    std::uint64_t d2d_count = 0;
    std::uint64_t d2d_bytes = 0;
    std::uint64_t h2h_count = 0;
    std::uint64_t h2h_bytes = 0;
    std::uint64_t p2p_count = 0;
    std::uint64_t p2p_bytes = 0;
    std::uint64_t allocation_count = 0;
    std::uint64_t allocation_bytes = 0;
    std::uint64_t release_count = 0;
    std::uint64_t release_bytes = 0;
    std::uint64_t device_allocation_count = 0;
    std::uint64_t device_allocation_bytes = 0;
    std::uint64_t device_release_count = 0;
    std::uint64_t device_release_bytes = 0;
    std::uint64_t managed_allocation_count = 0;
    std::uint64_t managed_allocation_bytes = 0;
    std::uint64_t managed_release_count = 0;
    std::uint64_t managed_release_bytes = 0;
    std::uint64_t host_allocation_count = 0;
    std::uint64_t host_allocation_bytes = 0;
    std::uint64_t host_release_count = 0;
    std::uint64_t host_release_bytes = 0;
    std::uint64_t allocation_kind_coverage = 0;
    std::uint64_t host_sync_count = 0;
    std::uint64_t host_sync_duration_ns = 0;
    std::uint64_t untimed_metadata_records = 0;
    std::uint64_t scalar_telemetry_d2h_count = 0;
    std::uint64_t scalar_telemetry_d2h_bytes = 0;
    // Exact-size H2D/D2H records; coverage is clear if other sizes make vector grouping ambiguous.
    std::uint64_t full_vector_crossings = 0;
    std::uint64_t flags = 0;
    // SHA-256 of the versioned chain of canonical timed CUPTI records in
    // delivery order. Includes only records starting in [start_ns, end_ns).
    // Empty unless flags contains modal_eps_trace_complete.
    char native_trace_sha256[65]{};
};

struct ModalEpsSolveTraceConfigV1 {
    // CUPTI cannot attribute a nonzero transfer to EPS telemetry by payload size.
    std::uint64_t scalar_telemetry_bytes = 0;
    // Exact payload size supplied by the native caller for vector grouping.
    std::uint64_t full_vector_bytes = 0;
};

bool begin_modal_eps_solve_v1(
    const ModalEpsSolveTraceConfigV1 &config,
    PhaseTokenV1 *token) noexcept;
bool end_modal_eps_solve_v1(
    PhaseTokenV1 token,
    ModalEpsSolveTraceV1 *report) noexcept;

} // namespace fullmag::fem::cuda_trace
