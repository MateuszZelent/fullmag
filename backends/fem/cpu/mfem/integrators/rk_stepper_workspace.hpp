#pragma once

#include "cpu/mfem/integrators/rk_tableau.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"
#include "cpu/mfem/interactions/stt.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace fullmag::fem {

/*
 * Reusable explicit Runge-Kutta stepper workspace.
 *
 * The native FEM explicit RK path reuses these AOS buffers across accepted and
 * rejected steps: private candidate magnetization, stage RHS vectors, temporary effective
 * fields, adaptive error estimates, the host transaction journal, and the FSAL
 * cache validity flag. The structure contains storage only; physical RHS
 * assembly and time integration live in the RK modules.
 *
 * It does not evaluate stage RHS, advance time, compose H_eff, or own adaptive
 * accept/reject policy.
 */
/*
 * Validity dimensions for an accepted endpoint field/RHS cache.
 *
 * Each dimension is explicit so a future source or projection change cannot
 * be hidden behind one aggregate boolean. The cache is reusable only when all
 * dimensions are true; FSAL reuse adds the separate autonomous-source gate in
 * the step owner.
 */
struct EndpointCacheValidity {
    bool state = false;
    bool time = false;
    bool dynamic_sources = false;
    bool transport = false;
    bool projection = false;

    bool valid() const noexcept
    {
        return state && time && dynamic_sources && transport && projection;
    }
};

enum class RkFinalRefreshReason : uint32_t {
    NotEvaluated = 0,
    CacheHit = 1,
    NonFsalTableau = 2,
    CandidateStateMismatch = 3,
    EndpointTimeMismatch = 4,
    DynamicSourceChanged = 5,
    TransportSourceChanged = 6,
    ProjectionMismatch = 7,
    CacheUnavailable = 8,
};

/*
 * Per-public-step telemetry for the CPU accepted-endpoint decision.
 *
 * Counters describe only the terminal accepted attempt: rejected attempts
 * retain their existing attempt trace and demag counters. No storage is
 * allocated in the RK hot loop.
 */
struct RkEndpointTelemetry {
    EndpointCacheValidity cache_validity{};
    RkFinalRefreshReason final_refresh_reason = RkFinalRefreshReason::NotEvaluated;
    uint64_t final_rhs_evaluations = 0;
    uint64_t extra_poisson_solves = 0;
    uint64_t endpoint_cache_hits = 0;
    uint64_t endpoint_refreshes = 0;
    uint64_t accepted_step_wall_time_ns = 0;
};

struct StepperWorkspace {
    StepperWorkspace() = default;
    ~StepperWorkspace();
    StepperWorkspace(const StepperWorkspace &other);
    StepperWorkspace &operator=(const StepperWorkspace &other);
    StepperWorkspace(StepperWorkspace &&other) noexcept;
    StepperWorkspace &operator=(StepperWorkspace &&other) noexcept;

    bool allocated = false;
    std::size_t dof_len = 0;                       // n_nodes * 3
    int stages = 0;                                // currently allocated RK stages
    std::vector<double> k[MAX_RK_STAGES];          // stage derivatives k_i
    std::vector<double> m_stage;                   // temp: m at stage evaluation point
    std::vector<double> m_candidate;               // private high-order candidate
    std::vector<double> h_ex_tmp;                  // temp exchange field
    std::vector<double> h_demag_tmp;               // temp demag field
    std::vector<double> h_eff_tmp;                 // temp effective field
    SttWorkspace stt;                              // temp direct-torque scratch
    std::vector<double> err;                       // error = h*(b_hi - b_lo) . K
    RkStepTransactionJournalPtr transaction_journal;
    std::unique_ptr<RkAttemptCacheSnapshot> attempt_checkpoint;
    bool fsal_valid = false;                       // true when k[0] holds valid FSAL RHS
    RkEndpointTelemetry endpoint_telemetry{};
};

enum class RkStepFailurePoint : uint32_t {
    None = 0,
    AfterCandidateMagnetization = 1,
    DuringFinalFieldRefresh = 2,
    DuringFinalStatistics = 3,
};

struct RkStepFailureInjectionState {
    RkStepFailurePoint next = RkStepFailurePoint::None;
    uint64_t injected_count = 0;
};

enum class RkAttemptDecision : uint32_t {
    Accepted = 1,
    Retry = 2,
    Failed = 3,
};

struct RkAttemptRecord {
    uint64_t attempt = 0;
    uint64_t target_step = 0;
    double time_seconds = 0.0;
    double dt_attempt_seconds = 0.0;
    double eta = 0.0;
    double max_norm_defect = 0.0;
    double max_spin_rotation = 0.0;
    RkAttemptDecision decision = RkAttemptDecision::Accepted;
    uint32_t reason = 0;
    double dt_next_seconds = 0.0;
    uint32_t demag_solve_count = 0;
    uint32_t demag_linear_iterations = 0;
    double demag_linear_residual = 0.0;
    uint32_t rhs_evaluations = 0;
    int32_t estimator_order = 0;
    // Native adaptive FEM norm receipt; zero means fixed-step/no reduction.
    uint32_t error_norm_type = 0;
    uint64_t active_node_count = 0;
    double active_measure = 0.0;
    double normalization_denominator = 0.0;
    double max_scaled_error = 0.0;
    double weighted_rms_error = 0.0;
};

struct RkAttemptTraceState {
    static constexpr std::size_t max_records = 64;
    std::vector<RkAttemptRecord> records;
};

/*
 * Per-public-step telemetry for the explicit-RK transaction owners.
 *
 * The outer transaction records the host snapshot and queued device-to-device
 * checkpoint separately because the CUDA capture is asynchronous. Device
 * restore time includes the existing rollback stream synchronization. Payload
 * byte counters describe dynamic host buffers and device buffers actually
 * copied; CPU generation swaps therefore report zero host payload bytes and
 * expose capacity-growing snapshot allocations separately. Adaptive
 * attempt-cache counters remain separate from the outer accepted-step
 * transaction so retry overhead is not mistaken for a committed step.
 *
 * This is native owner state only. ABI/API/UI publication crosses a separate
 * versioned propagation boundary.
 */
struct RkTransactionTelemetryState {
    uint64_t step_transaction_begin_count = 0;
    uint64_t step_transaction_commit_count = 0;
    uint64_t step_transaction_rollback_count = 0;
    uint64_t attempt_cache_capture_count = 0;
    uint64_t attempt_cache_restore_count = 0;

    uint64_t step_transaction_begin_wall_time_ns = 0;
    uint64_t step_transaction_host_capture_wall_time_ns = 0;
    uint64_t step_transaction_device_capture_enqueue_wall_time_ns = 0;
    uint64_t step_transaction_commit_wall_time_ns = 0;
    uint64_t step_transaction_rollback_wall_time_ns = 0;
    uint64_t step_transaction_host_restore_wall_time_ns = 0;
    uint64_t step_transaction_device_restore_wall_time_ns = 0;
    uint64_t attempt_cache_capture_wall_time_ns = 0;
    uint64_t attempt_cache_restore_wall_time_ns = 0;

    uint64_t step_transaction_host_snapshot_payload_bytes = 0;
    uint64_t step_transaction_device_snapshot_payload_bytes = 0;
    uint64_t step_transaction_host_restore_payload_bytes = 0;
    uint64_t step_transaction_device_restore_payload_bytes = 0;
    uint64_t attempt_cache_snapshot_payload_bytes = 0;
    uint64_t attempt_cache_restore_payload_bytes = 0;
    uint64_t attempt_cache_allocation_count = 0;
    uint64_t step_transaction_cpu_snapshot_allocation_count = 0;
    uint64_t step_transaction_peak_rss_bytes = 0;
};

/*
 * Runtime owner for the reusable explicit RK workspace.
 *
 * Context stores this owner rather than a flat StepperWorkspace so the
 * integrator subsystem remains the boundary for RK storage. It does not
 * evaluate stages, choose tableaus, advance time, or own adaptive policy.
 */
struct RkStepperRuntimeState {
    StepperWorkspace workspace{};
    RkStepFailureInjectionState failure_injection{};
    RkAttemptTraceState attempt_trace{};
    RkTransactionTelemetryState transaction_telemetry{};
};

} // namespace fullmag::fem
