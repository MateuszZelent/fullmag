#pragma once

#include "frequency_domain/canonical_digest.hpp"
#include "frequency_domain/modal_eigen_result.hpp"
#include "fullmag_fem.h"
#include "gpu/frequency_domain/modal_augmented_window.hpp"

#include <array>
#include <limits>
#include <string_view>

namespace fullmag::fem::frequency_domain::gpu {

// Bind the ordered, disjoint iteration captures. Setup and export between
// intervals do not contribute to iteration counters.
inline bool bind_augmented_iteration_trace(
    const CertifiedOpenAirboxWindow &window, ModalGpuExecutionAttestation &attestation)
{
    using namespace cuda_trace;
    constexpr auto required_counters =
        modal_eps_counter_coverage_transfers | modal_eps_counter_coverage_allocations |
        modal_eps_counter_coverage_host_sync | modal_eps_counter_coverage_full_vector_crossings;
    if (window.subsolves.empty()) {
        attestation.native_trace_unavailable_reason = "cudss_iteration_trace_missing";
        return false;
    }

    constexpr auto max_count = std::numeric_limits<std::uint64_t>::max();
    CanonicalDigestBuilder digest("modal_cudss_ordered_iteration_traces.v1");
    const auto &first = window.subsolves.front().native_trace;
    attestation.native_trace_flags = modal_eps_trace_complete;
    attestation.native_trace_phase_coverage = first.phase_coverage;
    attestation.native_trace_counter_coverage = first.counter_coverage;
    attestation.native_trace_start_ns = first.start_ns;
    const auto checked_add = [](std::uint64_t &total, std::uint64_t value) {
        if (value > max_count - total) {
            return false;
        }
        total += value;
        return true;
    };

    for (const auto &subsolve : window.subsolves) {
        const auto &trace = subsolve.native_trace;
        const std::string_view hex(trace.native_trace_sha256, 64);
        if (trace.schema_version != 1 || trace.flags != modal_eps_trace_complete ||
            (trace.counter_coverage & required_counters) != required_counters ||
            trace.kernel_records == 0 || trace.start_ns == 0 || trace.start_ns >= trace.end_ns ||
            trace.start_ns < attestation.native_trace_end_ns ||
            trace.native_trace_sha256[64] != '\0' ||
            hex.find_first_not_of("0123456789abcdef") != std::string_view::npos ||
            hex.find_first_not_of('0') == std::string_view::npos) {
            attestation.native_trace_flags = trace.flags;
            attestation.native_trace_unavailable_reason = "cudss_iteration_trace_incomplete";
            return false;
        }
        if (trace.h2d_count != 0 || trace.h2d_bytes != 0 ||
            trace.d2h_count != 0 || trace.d2h_bytes != 0 ||
            trace.h2h_count != 0 || trace.h2h_bytes != 0 ||
            trace.p2p_count != 0 || trace.p2p_bytes != 0 ||
            trace.allocation_count != 0 || trace.allocation_bytes != 0 ||
            trace.release_count != 0 || trace.release_bytes != 0 ||
            trace.host_sync_count != 0 || trace.host_sync_duration_ns != 0 ||
            trace.full_vector_crossings != 0) {
            attestation.native_trace_h2d_count = trace.h2d_count;
            attestation.native_trace_h2d_bytes = trace.h2d_bytes;
            attestation.native_trace_d2h_count = trace.d2h_count;
            attestation.native_trace_d2h_bytes = trace.d2h_bytes;
            attestation.native_trace_allocation_count = trace.allocation_count;
            attestation.native_trace_allocation_bytes = trace.allocation_bytes;
            attestation.native_trace_release_count = trace.release_count;
            attestation.native_trace_release_bytes = trace.release_bytes;
            attestation.native_trace_host_sync_count = trace.host_sync_count;
            attestation.native_trace_host_sync_duration_ns = trace.host_sync_duration_ns;
            attestation.native_trace_unavailable_reason = "cudss_iteration_trace_host_activity_or_allocation";
            return false;
        }

        if ((trace.counter_coverage & modal_eps_counter_coverage_scalar_telemetry_d2h) == 0) {
            attestation.native_trace_unavailable_reason = "cudss_iteration_trace_scalar_telemetry_unverified";
            return false;
        }

        digest.add_double("shift_hz", subsolve.shift_hz);
        digest.add_string("native_trace_sha256", hex);
        attestation.native_trace_end_ns = trace.end_ns;
        attestation.native_trace_phase_coverage &= trace.phase_coverage;
        attestation.native_trace_counter_coverage &= trace.counter_coverage;
        if (!checked_add(attestation.native_trace_observed_activity_records, trace.observed_activity_records) ||
            !checked_add(attestation.native_trace_kernel_records, trace.kernel_records) ||
            !checked_add(attestation.native_trace_kernel_duration_ns, trace.kernel_duration_ns) ||
            !checked_add(attestation.native_trace_d2d_count, trace.d2d_count) ||
            !checked_add(attestation.native_trace_d2d_bytes, trace.d2d_bytes)) {
            attestation.native_trace_unavailable_reason = "cudss_iteration_trace_counter_overflow";
            return false;
        }
    }

    const auto hex = digest.sha256_hex();
    if (hex.size() != 64 || hex.find_first_not_of('0') == std::string::npos) {
        attestation.native_trace_unavailable_reason = "cudss_iteration_trace_digest_missing";
        return false;
    }
    const auto nibble = [](char c) -> std::uint8_t { return c <= '9' ? c - '0' : c - 'a' + 10; };
    for (std::size_t index = 0; index < attestation.native_trace_sha256.size(); ++index) {
        attestation.native_trace_sha256[index] = (nibble(hex[2 * index]) << 4) | nibble(hex[2 * index + 1]);
    }
    attestation.native_trace_complete = true;
    attestation.measurement_coverage_flags |= FULLMAG_FEM_MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP |
        FULLMAG_FEM_MODAL_GPU_COVERAGE_SCALAR_TELEMETRY;
    return true;
}

} // namespace fullmag::fem::frequency_domain::gpu
