#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"

#include <algorithm>
#include <cstddef>
#include <mutex>

static_assert(sizeof(fullmag_fem_gpu_performance_snapshot_v1) == 480);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, completed_step) == 32);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, physical_rhs_evaluations) == 80);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, accepted_rhs_evaluations) == 240);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v1, physical_exchange_elapsed_ns) == 400);

static_assert(sizeof(fullmag_fem_gpu_performance_snapshot_v3) == 792);
static_assert(alignof(fullmag_fem_gpu_performance_snapshot_v3) == 8);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, abi_version) == 0);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, struct_size) == 4);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, setup_count) == 8);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, execution_kind) == 88);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, execution_generation_id) == 120);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_step_count) == 144);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_effective_field_applies) == 216);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_effective_field_applies) == 344);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_device_to_device_bytes) == 472);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, compute_host_sync_count) == 584);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, kernel_launch_coverage_mask) == 624);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, initial_residency) == 648);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_exchange_elapsed_ns) == 672);
static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, refinement_wall_time_ns) == 784);

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
    target.effective_field_applies += delta.effective_field_applies;
    target.energy_evaluations += delta.energy_evaluations;
    target.armijo_candidates += delta.armijo_candidates;
    target.gradient_wall_time_ns += delta.gradient_wall_time_ns;
    target.retraction_wall_time_ns += delta.retraction_wall_time_ns;
    target.line_search_wall_time_ns += delta.line_search_wall_time_ns;
    target.direction_update_wall_time_ns += delta.direction_update_wall_time_ns;
    target.refinement_wall_time_ns += delta.refinement_wall_time_ns;
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

fullmag_fem_gpu_performance_snapshot_v3 gpu_performance_snapshot_v3(
    const FemGpuExecutionReceiptRuntimeState &receipt_state,
    const GpuPerformanceCounterState &perf_state)
{
    std::scoped_lock lock(receipt_state.mutex, perf_state.mutex);
    fullmag_fem_gpu_performance_snapshot_v3 out{};
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION;
    out.struct_size = sizeof(out);
    out.setup_count = receipt_state.accepted_performance.setup_count;
    out.apply_count = receipt_state.accepted_performance.apply_count;
    out.kernel_launch_count = receipt_state.accepted_performance.kernel_launch_count;
    out.compute_fence_count = receipt_state.accepted_performance.compute_fence_count;
    out.snapshot_fence_count = receipt_state.accepted_performance.snapshot_fence_count;
    out.export_fence_count = receipt_state.accepted_performance.export_fence_count;
    out.selected_sparse_kernel_id = receipt_state.accepted_performance.selected_sparse_kernel_id;
    out.setup_wall_time_ns = receipt_state.accepted_performance.setup_wall_time_ns;
    out.apply_wall_time_ns = receipt_state.accepted_performance.apply_wall_time_ns;
    out.accepted_finalization_wall_time_ns =
        receipt_state.accepted_performance.accepted_finalization_wall_time_ns;

    out.execution_kind = static_cast<uint32_t>(receipt_state.execution_kind);
    out.relaxation_algorithm = static_cast<uint32_t>(receipt_state.relaxation_algorithm);
    out.attempt_model = static_cast<uint32_t>(receipt_state.attempt_model);
    out.control_policy = static_cast<uint32_t>(receipt_state.control_policy);
    out.terminal_outcome = static_cast<uint32_t>(receipt_state.terminal_outcome);
    out.execution_class = perf_state.execution_class != FULLMAG_FEM_GPU_EXECUTION_UNKNOWN
        ? perf_state.execution_class
        : execution_class_to_abi(receipt_state.execution_class);
    out.precision = perf_state.precision != 0 ? perf_state.precision : receipt_state.precision;
    out.device_ordinal = perf_state.device_ordinal != -1 ? perf_state.device_ordinal : receipt_state.device_ordinal;

    out.execution_generation_id = receipt_state.execution_generation_id;
    out.available = perf_state.available ? 1u : 0u;
    out.compute_closed = receipt_state.compute_closed ? 1u : 0u;
    out.observation_closed = receipt_state.observation_closed ? 1u : 0u;
    out.frozen = receipt_state.performance_snapshot_frozen ? 1u : 0u;

    out.accepted_step_count = receipt_state.accepted_step_count;
    out.physical_outer_attempt_count = receipt_state.outer_attempt_count;
    out.rejected_candidate_count = receipt_state.rejected_candidate_count;
    out.failed_candidate_count = receipt_state.failed_candidate_count;
    out.cancelled_outer_attempt_count = receipt_state.cancelled_outer_attempt_count;
    out.paused_outer_attempt_count = receipt_state.paused_outer_attempt_count;
    out.failed_outer_attempt_count = receipt_state.failed_attempt_count;
    out.stationary_observation_count = receipt_state.stationary_observation_count;
    out.refinement_evaluation_count = receipt_state.refinement_evaluation_count;

    out.physical_effective_field_applies = perf_state.physical_lifetime.effective_field_applies;
    out.physical_energy_evaluations = perf_state.physical_lifetime.energy_evaluations;
    out.physical_armijo_candidates = perf_state.physical_lifetime.armijo_candidates;
    out.physical_rhs_evaluations = perf_state.physical_lifetime.rhs_evaluations;
    out.physical_exchange_applies = perf_state.physical_lifetime.exchange_applies;
    out.physical_exchange_launches = perf_state.physical_lifetime.exchange_launches;
    out.physical_exchange_nnz_visited = perf_state.physical_lifetime.exchange_nnz_visited;
    out.physical_demag_solves = perf_state.physical_lifetime.demag_solves;
    out.physical_demag_iterations = perf_state.physical_lifetime.demag_iterations;
    out.physical_normalization_launches = perf_state.physical_lifetime.normalization_launches;
    out.physical_normalization_readbacks = perf_state.physical_lifetime.normalization_readbacks;
    out.physical_adaptive_readbacks = perf_state.physical_lifetime.adaptive_readbacks;
    out.physical_control_fences = perf_state.physical_lifetime.control_fences;
    out.physical_endpoint_cache_hits = perf_state.physical_lifetime.endpoint_cache_hits;
    out.physical_endpoint_cache_misses = perf_state.physical_lifetime.endpoint_cache_misses;
    out.physical_endpoint_cache_invalidations = perf_state.physical_lifetime.endpoint_cache_invalidations;

    out.accepted_effective_field_applies = perf_state.accepted_lifetime.effective_field_applies;
    out.accepted_energy_evaluations = perf_state.accepted_lifetime.energy_evaluations;
    out.accepted_armijo_candidates = perf_state.accepted_lifetime.armijo_candidates;
    out.accepted_rhs_evaluations = perf_state.accepted_lifetime.rhs_evaluations;
    out.accepted_exchange_applies = perf_state.accepted_lifetime.exchange_applies;
    out.accepted_exchange_launches = perf_state.accepted_lifetime.exchange_launches;
    out.accepted_exchange_nnz_visited = perf_state.accepted_lifetime.exchange_nnz_visited;
    out.accepted_demag_solves = perf_state.accepted_lifetime.demag_solves;
    out.accepted_demag_iterations = perf_state.accepted_lifetime.demag_iterations;
    out.accepted_normalization_launches = perf_state.accepted_lifetime.normalization_launches;
    out.accepted_normalization_readbacks = perf_state.accepted_lifetime.normalization_readbacks;
    out.accepted_adaptive_readbacks = perf_state.accepted_lifetime.adaptive_readbacks;
    out.accepted_control_fences = perf_state.accepted_lifetime.control_fences;
    out.accepted_endpoint_cache_hits = perf_state.accepted_lifetime.endpoint_cache_hits;
    out.accepted_endpoint_cache_misses = perf_state.accepted_lifetime.endpoint_cache_misses;
    out.accepted_endpoint_cache_invalidations = perf_state.accepted_lifetime.endpoint_cache_invalidations;

    out.physical_device_to_device_bytes = perf_state.physical_lifetime.device_to_device_bytes;
    out.accepted_device_to_device_bytes = perf_state.accepted_lifetime.device_to_device_bytes;
    out.setup_h2d_bytes = receipt_state.setup_h2d_bytes;
    out.setup_d2h_bytes = receipt_state.setup_d2h_bytes;
    out.compute_h2d_bytes = receipt_state.compute_h2d_bytes;
    out.compute_d2h_bytes = receipt_state.compute_d2h_bytes;
    out.control_h2d_bytes = receipt_state.control_h2d_bytes;
    out.control_d2h_bytes = receipt_state.control_d2h_bytes;
    out.exchange_h2d_bytes = receipt_state.exchange_h2d_bytes;
    out.exchange_d2h_bytes = receipt_state.exchange_d2h_bytes;
    out.snapshot_h2d_bytes = receipt_state.snapshot_h2d_bytes;
    out.snapshot_d2h_bytes = receipt_state.snapshot_d2h_bytes;
    out.export_h2d_bytes = receipt_state.export_h2d_bytes;
    out.export_d2h_bytes = receipt_state.export_d2h_bytes;

    out.compute_host_sync_count = receipt_state.compute_host_sync_count;
    out.control_host_sync_count = receipt_state.control_host_sync_count;
    out.exchange_host_sync_count = receipt_state.exchange_host_sync_count;
    out.snapshot_host_sync_count = receipt_state.snapshot_host_sync_count;
    out.export_host_sync_count = receipt_state.export_host_sync_count;

    out.kernel_launch_coverage_mask = receipt_state.kernel_launch_coverage_mask;
    out.required_coverage_mask = receipt_state.required_coverage_mask;
    out.unclassified_event_count = receipt_state.unclassified_event_count;

    out.initial_residency = receipt_state.initial_residency;
    out.final_residency = receipt_state.final_residency;
    out.residency_transition_count = receipt_state.residency_transition_count;
    out.residency_violation_count = receipt_state.residency_violation_count;

    out.physical_exchange_elapsed_ns = perf_state.physical_lifetime.exchange_elapsed_ns;
    out.physical_demag_assemble_elapsed_ns = perf_state.physical_lifetime.demag_assemble_elapsed_ns;
    out.physical_demag_recover_elapsed_ns = perf_state.physical_lifetime.demag_recover_elapsed_ns;
    out.physical_demag_energy_elapsed_ns = perf_state.physical_lifetime.demag_energy_elapsed_ns;
    out.physical_rhs_elapsed_ns = perf_state.physical_lifetime.rhs_elapsed_ns;
    out.accepted_exchange_elapsed_ns = perf_state.accepted_lifetime.exchange_elapsed_ns;
    out.accepted_demag_assemble_elapsed_ns = perf_state.accepted_lifetime.demag_assemble_elapsed_ns;
    out.accepted_demag_recover_elapsed_ns = perf_state.accepted_lifetime.demag_recover_elapsed_ns;
    out.accepted_demag_energy_elapsed_ns = perf_state.accepted_lifetime.demag_energy_elapsed_ns;
    out.accepted_rhs_elapsed_ns = perf_state.accepted_lifetime.rhs_elapsed_ns;

    out.gradient_wall_time_ns = perf_state.physical_lifetime.gradient_wall_time_ns;
    out.retraction_wall_time_ns = perf_state.physical_lifetime.retraction_wall_time_ns;
    out.line_search_wall_time_ns = perf_state.physical_lifetime.line_search_wall_time_ns;
    out.direction_update_wall_time_ns = perf_state.physical_lifetime.direction_update_wall_time_ns;
    out.refinement_wall_time_ns = perf_state.physical_lifetime.refinement_wall_time_ns;

    return out;
}

} // namespace fullmag::fem
