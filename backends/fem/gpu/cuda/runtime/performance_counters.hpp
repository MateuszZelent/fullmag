#pragma once

/*
 * Host-owned, transactional FEM GPU performance counters.
 *
 * This module deliberately does not allocate CUDA events or device memory.
 * Producers add counters at existing owner boundaries and publish a complete
 * snapshot only when an outer attempt is committed.  A rejected or failed
 * attempt contributes to physical lifetime totals but never becomes the
 * completed snapshot visible to callers.
 */

#include "fullmag_fem.h"

#include <cstdint>
#include <array>
#include <mutex>

namespace fullmag::fem {

struct GpuPerformanceCounterDelta {
    fullmag_fem_gpu_mandatory_control_counters_v1 mandatory_controls{};
    uint64_t rhs_evaluations = 0;
    uint64_t exchange_applies = 0;
    uint64_t exchange_launches = 0;
    uint64_t exchange_nnz_visited = 0;
    uint64_t demag_solves = 0;
    uint64_t demag_iterations = 0;
    uint64_t demag_rhs_norm_evaluations = 0;
    uint64_t demag_stage_energy_evaluations = 0;
    uint64_t normalization_launches = 0;
    uint64_t normalization_readbacks = 0;
    uint64_t adaptive_readbacks = 0;
    uint64_t control_fences = 0;
    uint64_t endpoint_cache_hits = 0;
    uint64_t endpoint_cache_misses = 0;
    uint64_t endpoint_cache_invalidations = 0;
    uint64_t device_to_device_bytes = 0;
    uint64_t control_d2h_bytes = 0;
    uint64_t device_pcg_status_readbacks = 0;
    uint64_t device_pcg_control_d2h_bytes = 0;
    uint64_t device_pcg_solves = 0;
    uint64_t device_pcg_active_iterations = 0;
    uint64_t bulk_d2h_bytes = 0;
    uint64_t exchange_elapsed_ns = 0;
    uint64_t demag_assemble_elapsed_ns = 0;
    uint64_t demag_recover_elapsed_ns = 0;
    uint64_t demag_energy_elapsed_ns = 0;
    uint64_t rhs_elapsed_ns = 0;
    double demag_rhs_norm_sum = 0.0;
    double demag_stage_energy_sum_joules = 0.0;
};

struct GpuPerformanceCounterState {
    GpuPerformanceCounterState() = default;
    GpuPerformanceCounterState(const GpuPerformanceCounterState &other);
    GpuPerformanceCounterState &operator=(const GpuPerformanceCounterState &other);
    GpuPerformanceCounterState(GpuPerformanceCounterState &&other) noexcept;
    GpuPerformanceCounterState &operator=(GpuPerformanceCounterState &&other) noexcept;

    mutable std::mutex mutex{};
    bool available = false;
    bool attempt_active = false;
    uint32_t execution_class = FULLMAG_FEM_GPU_EXECUTION_UNKNOWN;
    uint32_t precision = 0;
    uint32_t integrator = 0;
    int32_t device_ordinal = -1;
    uint64_t next_execution_id = 1;
    uint64_t next_operator_id = 1;
    uint64_t active_step = 0;
    uint64_t active_execution_id = 0;
    uint64_t active_operator_id = 0;
    uint64_t completed_attempt_count = 0;
    uint64_t rejected_attempt_count = 0;
    uint64_t failed_attempt_count = 0;
    GpuPerformanceCounterDelta active{};
    // Work for the current logical step, including rejected retries; it is
    // moved to accepted_lifetime only when that step commits.
    GpuPerformanceCounterDelta pending_accepted_step{};
    uint64_t pending_accepted_step_id = 0;
    bool pending_accepted_step_active = false;
    GpuPerformanceCounterDelta physical_lifetime{};
    GpuPerformanceCounterDelta accepted_lifetime{};
    fullmag_fem_gpu_performance_snapshot_v1 completed{};
};

/* Reset all metadata and lifetime counters when the owning GPU state is
 * destroyed or re-created.  The mutex remains embedded so snapshots stay
 * safe for concurrent readers; explicit copy/move operations preserve the
 * surrounding Context value semantics without copying the mutex itself. */
void gpu_performance_reset(GpuPerformanceCounterState &state);

void gpu_performance_configure(
    GpuPerformanceCounterState &state,
    bool available,
    uint32_t execution_class,
    uint32_t precision,
    uint32_t integrator,
    int32_t device_ordinal);

void gpu_performance_begin_attempt(
    GpuPerformanceCounterState &state,
    uint64_t step,
    uint64_t execution_id = 0,
    uint64_t operator_id = 0);

void gpu_performance_note(
    GpuPerformanceCounterState &state,
    const GpuPerformanceCounterDelta &delta);

void gpu_performance_commit_attempt(GpuPerformanceCounterState &state);
void gpu_performance_reject_attempt(GpuPerformanceCounterState &state);
void gpu_performance_fail_attempt(GpuPerformanceCounterState &state);

// Transaction owner for direct minimizers. Unclosed exits, including exception
// unwinding, publish failed physical work and leave no active counter delta.
class GpuPerformanceAttemptScope {
public:
    GpuPerformanceAttemptScope(GpuPerformanceCounterState &state, uint64_t step)
        : state_(state)
    {
        gpu_performance_begin_attempt(state_, step);
    }
    ~GpuPerformanceAttemptScope()
    {
        if (active_) gpu_performance_fail_attempt(state_);
    }
    GpuPerformanceAttemptScope(const GpuPerformanceAttemptScope &) = delete;
    GpuPerformanceAttemptScope &operator=(const GpuPerformanceAttemptScope &) = delete;
    void commit()
    {
        gpu_performance_commit_attempt(state_);
        active_ = false;
    }
    void reject()
    {
        gpu_performance_reject_attempt(state_);
        active_ = false;
    }
private:
    GpuPerformanceCounterState &state_;
    bool active_ = true;
};

fullmag_fem_gpu_performance_snapshot_v1 gpu_performance_snapshot(
    const GpuPerformanceCounterState &state);

} // namespace fullmag::fem

namespace fullmag::fem {
fullmag_fem_poisson_device_pcg_counters_v1 gpu_performance_device_pcg_snapshot(
    const GpuPerformanceCounterState &state, uint64_t status_record_bytes);
}

namespace fullmag::fem {
void add_mandatory_control_counters(fullmag_fem_gpu_mandatory_control_counters_v1 &target,
    const fullmag_fem_gpu_mandatory_control_counters_v1 &delta);
fullmag_fem_gpu_mandatory_control_counters_v1 gpu_performance_mandatory_controls_snapshot(
    const GpuPerformanceCounterState &state);
}

namespace fullmag::fem {
bool resolve_confirmation_control_delta(const std::array<uint64_t,6> &before,
    const std::array<uint64_t,6> &after, fullmag_fem_gpu_mandatory_control_counters_v1 &out);
}
