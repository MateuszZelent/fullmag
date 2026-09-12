#include "gpu/cuda/runtime/performance_counters.hpp"

#include <cassert>
#include <cstdint>

using namespace fullmag::fem;

int main()
{
    GpuPerformanceCounterState state;
    auto initial = gpu_performance_snapshot(state);
    assert(initial.abi_version == FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION);
    assert(initial.struct_size == sizeof(initial));
    assert(initial.available == 0u);
    assert(initial.completed_step == 0u);

    gpu_performance_configure(
        state,
        true,
        FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT,
        64u,
        4u,
        0);
    gpu_performance_begin_attempt(state, 7u, 101u, 202u);
    GpuPerformanceCounterDelta delta{};
    delta.rhs_evaluations = 5u;
    delta.exchange_applies = 5u;
    delta.exchange_launches = 2u;
    delta.exchange_nnz_visited = 31u;
    delta.demag_solves = 3u;
    delta.normalization_launches = 4u;
    delta.normalization_readbacks = 1u;
    delta.control_fences = 1u;
    delta.device_to_device_bytes = 96u;
    delta.control_d2h_bytes = 24u;
    delta.exchange_elapsed_ns = 11u;
    gpu_performance_note(state, delta);

    auto active = gpu_performance_snapshot(state);
    assert(active.completed_step == 0u);
    assert(active.physical_rhs_evaluations == 0u);
    assert(active.accepted_rhs_evaluations == 0u);

    gpu_performance_commit_attempt(state);
    auto committed = gpu_performance_snapshot(state);
    assert(committed.completed_step == 7u);
    assert(committed.completed_execution_id == 101u);
    assert(committed.completed_operator_id == 202u);
    assert(committed.completed_attempt_count == 1u);
    assert(committed.physical_rhs_evaluations == 5u);
    assert(committed.accepted_rhs_evaluations == 5u);
    assert(committed.physical_device_to_device_bytes == 96u);
    assert(committed.accepted_device_to_device_bytes == 96u);

    gpu_performance_begin_attempt(state, 8u, 102u, 203u);
    GpuPerformanceCounterDelta rejected{};
    rejected.rhs_evaluations = 2u;
    rejected.demag_solves = 1u;
    gpu_performance_note(state, rejected);
    gpu_performance_reject_attempt(state);
    auto after_reject = gpu_performance_snapshot(state);
    assert(after_reject.completed_step == 7u);
    assert(after_reject.physical_rhs_evaluations == 7u);
    assert(after_reject.accepted_rhs_evaluations == 5u);
    assert(after_reject.rejected_attempt_count == 1u);

    gpu_performance_begin_attempt(state, 8u, 103u, 204u);
    GpuPerformanceCounterDelta accepted_after_retry{};
    accepted_after_retry.rhs_evaluations = 3u;
    gpu_performance_note(state, accepted_after_retry);
    gpu_performance_commit_attempt(state);
    auto after_retry_commit = gpu_performance_snapshot(state);
    assert(after_retry_commit.completed_step == 8u);
    assert(after_retry_commit.physical_rhs_evaluations == 10u);
    assert(after_retry_commit.accepted_rhs_evaluations == 10u);
    assert(after_retry_commit.rejected_attempt_count == 1u);

    gpu_performance_begin_attempt(state, 9u, 104u, 205u);
    gpu_performance_note(state, rejected);
    gpu_performance_fail_attempt(state);
    auto after_failure = gpu_performance_snapshot(state);
    assert(after_failure.completed_step == 8u);
    assert(after_failure.physical_rhs_evaluations == 12u);
    assert(after_failure.accepted_rhs_evaluations == 10u);
    assert(after_failure.failed_attempt_count == 1u);
    return 0;
}
