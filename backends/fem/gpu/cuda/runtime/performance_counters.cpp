#include "gpu/cuda/runtime/performance_counters.hpp"

#include <algorithm>
#include <cstddef>

static_assert(sizeof(fullmag_fem_gpu_performance_snapshot_v1) == 480);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, completed_step) == 32);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, physical_rhs_evaluations) == 80);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, accepted_rhs_evaluations) == 240);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, physical_exchange_elapsed_ns) == 400);

namespace fullmag::fem {
namespace {

void copy_state_fields(
    GpuPerformanceCounterState &target,
    const GpuPerformanceCounterState &source)
{
    target.available = source.available;
    target.attempt_active = source.attempt_active;
    target.execution_class = source.execution_class;
    target.precision = source.precision;
    target.integrator = source.integrator;
    target.device_ordinal = source.device_ordinal;
    target.next_execution_id = source.next_execution_id;
    target.next_operator_id = source.next_operator_id;
    target.active_step = source.active_step;
    target.active_execution_id = source.active_execution_id;
    target.active_operator_id = source.active_operator_id;
    target.completed_attempt_count = source.completed_attempt_count;
    target.rejected_attempt_count = source.rejected_attempt_count;
    target.failed_attempt_count = source.failed_attempt_count;
    target.active = source.active;
    target.pending_accepted_step = source.pending_accepted_step;
    target.pending_accepted_step_id = source.pending_accepted_step_id;
    target.pending_accepted_step_active = source.pending_accepted_step_active;
    target.physical_lifetime = source.physical_lifetime;
    target.accepted_lifetime = source.accepted_lifetime;
    target.completed = source.completed;
}

void add_delta(GpuPerformanceCounterDelta &target, const GpuPerformanceCounterDelta &delta)
{
    target.rhs_evaluations += delta.rhs_evaluations;
    target.exchange_applies += delta.exchange_applies;
    target.exchange_launches += delta.exchange_launches;
    target.exchange_nnz_visited += delta.exchange_nnz_visited;
    target.demag_solves += delta.demag_solves;
    target.demag_iterations += delta.demag_iterations;
    target.demag_rhs_norm_evaluations += delta.demag_rhs_norm_evaluations;
    target.demag_stage_energy_evaluations += delta.demag_stage_energy_evaluations;
    target.normalization_launches += delta.normalization_launches;
    target.normalization_readbacks += delta.normalization_readbacks;
    target.adaptive_readbacks += delta.adaptive_readbacks;
    target.control_fences += delta.control_fences;
    target.endpoint_cache_hits += delta.endpoint_cache_hits;
    target.endpoint_cache_misses += delta.endpoint_cache_misses;
    target.endpoint_cache_invalidations += delta.endpoint_cache_invalidations;
    target.device_to_device_bytes += delta.device_to_device_bytes;
    target.control_d2h_bytes += delta.control_d2h_bytes;
    target.bulk_d2h_bytes += delta.bulk_d2h_bytes;
    target.exchange_elapsed_ns += delta.exchange_elapsed_ns;
    target.demag_assemble_elapsed_ns += delta.demag_assemble_elapsed_ns;
    target.demag_recover_elapsed_ns += delta.demag_recover_elapsed_ns;
    target.demag_energy_elapsed_ns += delta.demag_energy_elapsed_ns;
    target.rhs_elapsed_ns += delta.rhs_elapsed_ns;
    target.demag_rhs_norm_sum += delta.demag_rhs_norm_sum;
    target.demag_stage_energy_sum_joules += delta.demag_stage_energy_sum_joules;
}

void reset_delta(GpuPerformanceCounterDelta &delta)
{
    delta = {};
}

void fill_delta(
    fullmag_fem_gpu_performance_snapshot_v1 &out,
    const GpuPerformanceCounterDelta &physical,
    const GpuPerformanceCounterDelta &accepted)
{
    out.physical_rhs_evaluations = physical.rhs_evaluations;
    out.physical_exchange_applies = physical.exchange_applies;
    out.physical_exchange_launches = physical.exchange_launches;
    out.physical_exchange_nnz_visited = physical.exchange_nnz_visited;
    out.physical_demag_solves = physical.demag_solves;
    out.physical_demag_iterations = physical.demag_iterations;
    out.physical_demag_rhs_norm_evaluations = physical.demag_rhs_norm_evaluations;
    out.physical_demag_stage_energy_evaluations = physical.demag_stage_energy_evaluations;
    out.physical_normalization_launches = physical.normalization_launches;
    out.physical_normalization_readbacks = physical.normalization_readbacks;
    out.physical_adaptive_readbacks = physical.adaptive_readbacks;
    out.physical_control_fences = physical.control_fences;
    out.physical_endpoint_cache_hits = physical.endpoint_cache_hits;
    out.physical_endpoint_cache_misses = physical.endpoint_cache_misses;
    out.physical_endpoint_cache_invalidations = physical.endpoint_cache_invalidations;
    out.physical_device_to_device_bytes = physical.device_to_device_bytes;
    out.physical_control_d2h_bytes = physical.control_d2h_bytes;
    out.physical_bulk_d2h_bytes = physical.bulk_d2h_bytes;
    out.physical_demag_rhs_norm_sum = physical.demag_rhs_norm_sum;
    out.physical_demag_stage_energy_sum_joules = physical.demag_stage_energy_sum_joules;
    out.accepted_rhs_evaluations = accepted.rhs_evaluations;
    out.accepted_exchange_applies = accepted.exchange_applies;
    out.accepted_exchange_launches = accepted.exchange_launches;
    out.accepted_exchange_nnz_visited = accepted.exchange_nnz_visited;
    out.accepted_demag_solves = accepted.demag_solves;
    out.accepted_demag_iterations = accepted.demag_iterations;
    out.accepted_demag_rhs_norm_evaluations = accepted.demag_rhs_norm_evaluations;
    out.accepted_demag_stage_energy_evaluations = accepted.demag_stage_energy_evaluations;
    out.accepted_normalization_launches = accepted.normalization_launches;
    out.accepted_normalization_readbacks = accepted.normalization_readbacks;
    out.accepted_adaptive_readbacks = accepted.adaptive_readbacks;
    out.accepted_control_fences = accepted.control_fences;
    out.accepted_endpoint_cache_hits = accepted.endpoint_cache_hits;
    out.accepted_endpoint_cache_misses = accepted.endpoint_cache_misses;
    out.accepted_endpoint_cache_invalidations = accepted.endpoint_cache_invalidations;
    out.accepted_device_to_device_bytes = accepted.device_to_device_bytes;
    out.accepted_control_d2h_bytes = accepted.control_d2h_bytes;
    out.accepted_bulk_d2h_bytes = accepted.bulk_d2h_bytes;
    out.accepted_demag_rhs_norm_sum = accepted.demag_rhs_norm_sum;
    out.accepted_demag_stage_energy_sum_joules = accepted.demag_stage_energy_sum_joules;
}

void fill_phase_channels(
    fullmag_fem_gpu_performance_snapshot_v1 &out,
    const GpuPerformanceCounterDelta &physical,
    const GpuPerformanceCounterDelta &accepted)
{
    out.physical_exchange_elapsed_ns = physical.exchange_elapsed_ns;
    out.physical_demag_assemble_elapsed_ns = physical.demag_assemble_elapsed_ns;
    out.physical_demag_recover_elapsed_ns = physical.demag_recover_elapsed_ns;
    out.physical_demag_energy_elapsed_ns = physical.demag_energy_elapsed_ns;
    out.physical_rhs_elapsed_ns = physical.rhs_elapsed_ns;
    out.accepted_exchange_elapsed_ns = accepted.exchange_elapsed_ns;
    out.accepted_demag_assemble_elapsed_ns = accepted.demag_assemble_elapsed_ns;
    out.accepted_demag_recover_elapsed_ns = accepted.demag_recover_elapsed_ns;
    out.accepted_demag_energy_elapsed_ns = accepted.demag_energy_elapsed_ns;
    out.accepted_rhs_elapsed_ns = accepted.rhs_elapsed_ns;
}

} // namespace

GpuPerformanceCounterState::GpuPerformanceCounterState(
    const GpuPerformanceCounterState &other)
{
    const std::lock_guard<std::mutex> lock(other.mutex);
    copy_state_fields(*this, other);
}

GpuPerformanceCounterState &GpuPerformanceCounterState::operator=(
    const GpuPerformanceCounterState &other)
{
    if (this == &other) {
        return *this;
    }
    std::scoped_lock lock(mutex, other.mutex);
    copy_state_fields(*this, other);
    return *this;
}

GpuPerformanceCounterState::GpuPerformanceCounterState(
    GpuPerformanceCounterState &&other) noexcept
{
    const std::lock_guard<std::mutex> lock(other.mutex);
    copy_state_fields(*this, other);
}

GpuPerformanceCounterState &GpuPerformanceCounterState::operator=(
    GpuPerformanceCounterState &&other) noexcept
{
    if (this == &other) {
        return *this;
    }
    std::scoped_lock lock(mutex, other.mutex);
    copy_state_fields(*this, other);
    return *this;
}

void gpu_performance_reset(GpuPerformanceCounterState &state)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    state.available = false;
    state.attempt_active = false;
    state.execution_class = FULLMAG_FEM_GPU_EXECUTION_UNKNOWN;
    state.precision = 0;
    state.integrator = 0;
    state.device_ordinal = -1;
    state.next_execution_id = 1;
    state.next_operator_id = 1;
    state.active_step = 0;
    state.active_execution_id = 0;
    state.active_operator_id = 0;
    state.completed_attempt_count = 0;
    state.rejected_attempt_count = 0;
    state.failed_attempt_count = 0;
    reset_delta(state.active);
    reset_delta(state.pending_accepted_step);
    state.pending_accepted_step_id = 0;
    state.pending_accepted_step_active = false;
    reset_delta(state.physical_lifetime);
    reset_delta(state.accepted_lifetime);
    state.completed = {};
}

void gpu_performance_configure(
    GpuPerformanceCounterState &state,
    bool available,
    uint32_t execution_class,
    uint32_t precision,
    uint32_t integrator,
    int32_t device_ordinal)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    state.available = available;
    state.execution_class = execution_class;
    state.precision = precision;
    state.integrator = integrator;
    state.device_ordinal = device_ordinal;
}

void gpu_performance_begin_attempt(
    GpuPerformanceCounterState &state,
    uint64_t step,
    uint64_t execution_id,
    uint64_t operator_id)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    if (state.attempt_active) {
        return;
    }
    if (state.pending_accepted_step_active &&
        state.pending_accepted_step_id != step) {
        reset_delta(state.pending_accepted_step);
        state.pending_accepted_step_id = 0;
        state.pending_accepted_step_active = false;
    }
    if (!state.pending_accepted_step_active) {
        state.pending_accepted_step_id = step;
        state.pending_accepted_step_active = true;
    }
    state.attempt_active = true;
    state.active_step = step;
    state.active_execution_id = execution_id != 0 ? execution_id : state.next_execution_id++;
    state.active_operator_id = operator_id != 0 ? operator_id : state.next_operator_id++;
    reset_delta(state.active);
}

void gpu_performance_note(
    GpuPerformanceCounterState &state,
    const GpuPerformanceCounterDelta &delta)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        return;
    }
    add_delta(state.active, delta);
}

void gpu_performance_commit_attempt(GpuPerformanceCounterState &state)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        return;
    }
    add_delta(state.physical_lifetime, state.active);
    add_delta(state.pending_accepted_step, state.active);
    add_delta(state.accepted_lifetime, state.pending_accepted_step);
    auto &out = state.completed;
    out = {};
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION;
    out.struct_size = sizeof(out);
    out.available = state.available ? 1u : 0u;
    out.execution_class = state.execution_class;
    out.precision = state.precision;
    out.integrator = state.integrator;
    out.device_ordinal = state.device_ordinal;
    out.completed_step = state.active_step;
    out.completed_execution_id = state.active_execution_id;
    out.completed_operator_id = state.active_operator_id;
    state.completed_attempt_count += 1;
    out.completed_attempt_count = state.completed_attempt_count;
    out.rejected_attempt_count = state.rejected_attempt_count;
    out.failed_attempt_count = state.failed_attempt_count;
    fill_delta(out, state.physical_lifetime, state.accepted_lifetime);
    fill_phase_channels(out, state.physical_lifetime, state.accepted_lifetime);
    state.attempt_active = false;
    reset_delta(state.active);
    reset_delta(state.pending_accepted_step);
    state.pending_accepted_step_id = 0;
    state.pending_accepted_step_active = false;
}

void gpu_performance_reject_attempt(GpuPerformanceCounterState &state)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        return;
    }
    add_delta(state.physical_lifetime, state.active);
    add_delta(state.pending_accepted_step, state.active);
    state.rejected_attempt_count += 1;
    state.attempt_active = false;
    reset_delta(state.active);
}

void gpu_performance_fail_attempt(GpuPerformanceCounterState &state)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        return;
    }
    add_delta(state.physical_lifetime, state.active);
    state.failed_attempt_count += 1;
    state.attempt_active = false;
    reset_delta(state.active);
    reset_delta(state.pending_accepted_step);
    state.pending_accepted_step_id = 0;
    state.pending_accepted_step_active = false;
}

fullmag_fem_gpu_performance_snapshot_v1 gpu_performance_snapshot(
    const GpuPerformanceCounterState &state)
{
    const std::lock_guard<std::mutex> lock(state.mutex);
    auto out = state.completed;
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION;
    out.struct_size = sizeof(out);
    out.available = state.available ? 1u : 0u;
    out.execution_class = state.execution_class;
    out.precision = state.precision;
    out.integrator = state.integrator;
    out.device_ordinal = state.device_ordinal;
    out.completed_attempt_count = state.completed_attempt_count;
    out.rejected_attempt_count = state.rejected_attempt_count;
    out.failed_attempt_count = state.failed_attempt_count;
    // A rejected/failed attempt is not a completed step, but its physical
    // work remains visible in the latest stable snapshot.  The active delta
    // is intentionally excluded until one of the terminal attempt methods
    // transfers it into the lifetime totals.
    fill_delta(out, state.physical_lifetime, state.accepted_lifetime);
    fill_phase_channels(out, state.physical_lifetime, state.accepted_lifetime);
    return out;
}

} // namespace fullmag::fem
