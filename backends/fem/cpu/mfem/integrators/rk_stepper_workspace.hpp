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
 * rejected steps: magnetization backup, stage RHS vectors, temporary effective
 * fields, adaptive error estimates, the host transaction journal, and the FSAL
 * cache validity flag. The structure contains storage only; physical RHS
 * assembly and time integration live in the RK modules.
 *
 * It does not evaluate stage RHS, advance time, compose H_eff, or own adaptive
 * accept/reject policy.
 */
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
    std::vector<double> m_backup;                  // backup of m before stage loop
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
 * copied; they intentionally exclude fixed-size object metadata. Adaptive
 * attempt-cache counters remain separate from the outer accepted-step
 * transaction so retry overhead is not mistaken for a committed step.
 *
 * This is native owner state only. ABI/API/UI publication is a separate
 * versioned propagation task.
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
