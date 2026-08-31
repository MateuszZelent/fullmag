/*
 * api.cpp — Public C ABI implementation for the FDM backend.
 *
 * This file dispatches to the internal Context and kernel implementations.
 * It is the sole file that exposes symbols matching fullmag_fdm.h.
 */

#include "fullmag_fdm.h"
#include "fullmag_adaptive_step_decision.hpp"
#include "context.hpp"
#include "plan_ingestion_v2.hpp"
#include "../gpu/cuda/integrators/fsal_policy.hpp"
#include "../gpu/cuda/runtime/step_transaction_controller.hpp"

#include <cstdlib>
#include <cstring>
#include <new>
#include <memory>
#include <optional>
#include <algorithm>
#include <random>
#include <array>
#include <cmath>
#include <limits>

using namespace fullmag::fdm;

// Forward declarations from .cu files — must be in correct namespace
namespace fullmag { namespace fdm {
extern void launch_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_dp45_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_dp45_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_abm3_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_abm3_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk4_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk4_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk23_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_rk23_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern bool launch_rk23_adaptive_batch_fp64(
    Context &, double, double, uint32_t, AdaptiveDeviceControl *, uint32_t,
    uint32_t &);
extern bool launch_rk23_adaptive_batch_fp32(
    Context &, double, double, uint32_t, AdaptiveDeviceControl *, uint32_t,
    uint32_t &);
extern bool launch_dp45_adaptive_batch_fp64(
    Context &, double, double, uint32_t, AdaptiveDeviceControl *, uint32_t,
    uint32_t &);
extern bool launch_dp45_adaptive_batch_fp32(
    Context &, double, double, uint32_t, AdaptiveDeviceControl *, uint32_t,
    uint32_t &);
extern void launch_multilayer_demag_field_fp64(Context &ctx);
extern void launch_multilayer_demag_field_fp32(Context &ctx);
extern void launch_multilayer_exchange_field_fp64(Context &ctx);
extern void launch_multilayer_exchange_field_fp32(Context &ctx);
extern bool launch_multilayer_dmi_field_fp64(Context &ctx);
extern bool launch_multilayer_dmi_field_fp32(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp64(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp32(Context &ctx);
extern bool launch_multilayer_effective_field_fp64(Context &ctx);
extern bool launch_multilayer_effective_field_fp32(Context &ctx);
extern void launch_multilayer_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_multilayer_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_multilayer_rk4_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_multilayer_rk4_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_multilayer_rk23_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
extern void launch_multilayer_rk23_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
#if FULLMAG_HAS_CUDA
extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
#endif
} }

namespace fullmag { namespace fdm {

void context_record_adaptive_numerics_terminal(
    Context &ctx,
    const AdaptiveDeviceControl &control,
    int order_estimate)
{
    const auto checked_increment = [&ctx](uint64_t &counter) {
        if (counter == std::numeric_limits<uint64_t>::max()) {
            ctx.adaptive_numerics_accounting_valid = false;
            return false;
        }
        ++counter;
        return true;
    };
    checked_increment(ctx.adaptive_numerics_terminal_observation_count);
    ctx.adaptive_numerics_last_terminal_error = control.embedded_error;
    ctx.adaptive_numerics_last_terminal_norm_defect =
        control.last_max_norm_defect;
    ctx.adaptive_numerics_last_terminal_spin_rotation =
        control.last_max_spin_rotation_radians;
    ctx.adaptive_numerics_max_attempt_error = fmax(
        ctx.adaptive_numerics_max_attempt_error,
        control.max_attempt_error);
    ctx.adaptive_numerics_max_attempt_norm_defect = fmax(
        ctx.adaptive_numerics_max_attempt_norm_defect,
        control.max_attempt_norm_defect);
    ctx.adaptive_numerics_max_attempt_spin_rotation = fmax(
        ctx.adaptive_numerics_max_attempt_spin_rotation,
        control.max_attempt_spin_rotation_radians);

    if (control.reason == ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED) {
        return;
    }
    const adaptive::Policy policy{
        order_estimate,
        ctx.adaptive_dt_min,
        ctx.adaptive_dt_max,
        ctx.adaptive_safety,
        ctx.adaptive_growth_limit,
        ctx.adaptive_shrink_limit};
    const adaptive::Input input{
        control.dt_attempt,
        control.error,
        control.decision_input_previous_error,
        control.decision_input_has_previous_error != 0};
    const auto expected = adaptive::decide(policy, input);
    checked_increment(ctx.adaptive_numerics_decision_comparison_count);

    const uint32_t expected_decision =
        expected.kind == adaptive::DecisionKind::accepted
            ? ADAPTIVE_DEVICE_DECISION_ACCEPTED
            : expected.kind == adaptive::DecisionKind::retry
                ? ADAPTIVE_DEVICE_DECISION_RETRY
                : ADAPTIVE_DEVICE_DECISION_FAILED;
    uint32_t expected_reason = ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR;
    switch (expected.reason) {
        case adaptive::DecisionReason::within_tolerance:
            expected_reason = ADAPTIVE_DEVICE_REASON_WITHIN_TOLERANCE;
            break;
        case adaptive::DecisionReason::error_above_tolerance:
            expected_reason = ADAPTIVE_DEVICE_REASON_ERROR_ABOVE_TOLERANCE;
            break;
        case adaptive::DecisionReason::dt_min_exhausted:
            expected_reason = ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED;
            break;
        case adaptive::DecisionReason::invalid_timestep:
            expected_reason = ADAPTIVE_DEVICE_REASON_INVALID_TIMESTEP;
            break;
        case adaptive::DecisionReason::invalid_previous_error:
            expected_reason = ADAPTIVE_DEVICE_REASON_INVALID_PREVIOUS_ERROR;
            break;
        default:
            expected_reason = ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR;
            break;
    }
    if (control.decision != expected_decision ||
        control.reason != expected_reason) {
        checked_increment(ctx.adaptive_numerics_decision_divergence_count);
    }
}

} }

namespace {

bool reject_step_transaction_mutation(Context &ctx, const char *operation)
{
    if (!ctx.gpu_workspace_step_active) return false;
    ctx.last_error = std::string(operation) + "_during_step_transaction";
    return true;
}

class ReceiptSolverPhaseGuard {
public:
    explicit ReceiptSolverPhaseGuard(Context &context)
        : context_(context), previous_(fullmag_fdm_set_solver_phase_active(
              *context.execution_receipt, true)),
          previous_local_pipeline_phase_(context.local_pipeline_solver_phase_active)
    {
        context_.local_pipeline_solver_phase_active = true;
        fullmag_fdm_begin_operator_execution_attempt(*context.execution_receipt);
    }

    ~ReceiptSolverPhaseGuard() {
        if (!committed_) {
            fullmag_fdm_discard_operator_execution_attempt(
                *context_.execution_receipt);
        }
        fullmag_fdm_accumulate_execution_receipt_audit(context_);
        context_.local_pipeline_solver_phase_active =
            previous_local_pipeline_phase_;
        fullmag_fdm_set_solver_phase_active(*context_.execution_receipt, previous_);
    }

    void commit() {
        fullmag_fdm_commit_operator_execution_attempt(*context_.execution_receipt);
        committed_ = true;
    }

    ReceiptSolverPhaseGuard(const ReceiptSolverPhaseGuard &) = delete;
    ReceiptSolverPhaseGuard &operator=(const ReceiptSolverPhaseGuard &) = delete;

private:
    Context &context_;
    bool previous_;
    bool previous_local_pipeline_phase_;
    bool committed_ = false;
};

std::optional<int> selected_cuda_device_from_env() {
    const char *specific = std::getenv("FULLMAG_FDM_GPU_INDEX");
    const char *generic = std::getenv("FULLMAG_CUDA_DEVICE_INDEX");
    const char *raw = specific != nullptr ? specific : generic;
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0) {
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

#if FULLMAG_HAS_CUDA
bool select_cuda_device_if_requested(Context &ctx) {
    auto selected = selected_cuda_device_from_env();
    if (!selected.has_value()) {
        return true;
    }
    cudaError_t err = cudaSetDevice(*selected);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaSetDevice", err);
        return false;
    }
    return true;
}

bool refresh_multilayer_transaction_observables(Context &ctx)
{
    ctx.last_error.clear();
    if (ctx.enable_demag) {
        if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            launch_multilayer_demag_field_fp64(ctx);
        } else {
            launch_multilayer_demag_field_fp32(ctx);
        }
        if (!ctx.last_error.empty()) return false;
    }
    if (ctx.enable_exchange) {
        if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            launch_multilayer_exchange_field_fp64(ctx);
        } else {
            launch_multilayer_exchange_field_fp32(ctx);
        }
        if (!ctx.last_error.empty()) return false;
    }
    if (ctx.has_interfacial_dmi || ctx.has_bulk_dmi) {
        const bool ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_dmi_field_fp64(ctx)
            : launch_multilayer_dmi_field_fp32(ctx);
        if (!ok) return false;
    }
    bool has_anisotropy = false;
    for (const auto &layer : ctx.multilayer_layers) {
        has_anisotropy = has_anisotropy || layer.has_uniaxial_anisotropy ||
            layer.has_cubic_anisotropy;
    }
    if (has_anisotropy) {
        const bool ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_anisotropy_field_fp64(ctx)
            : launch_multilayer_anisotropy_field_fp32(ctx);
        if (!ok) return false;
    }
    return ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? launch_multilayer_effective_field_fp64(ctx)
        : launch_multilayer_effective_field_fp32(ctx);
}

bool rollback_step_transaction(Context &ctx)
{
    const std::string primary_error = ctx.last_error;
    const bool state_restored = context_rollback_pre_step_state(ctx);
    context_invalidate_fsal_cache(
        ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
    const bool transport_restored = context_rollback_gpu_transport_step(ctx);
    context_invalidate_observables(ctx);
    const bool observables_restored = state_restored &&
        (ctx.has_multilayer_plan_v2
            ? refresh_multilayer_transaction_observables(ctx)
            : context_refresh_observables(ctx));
    const bool rollback_succeeded =
        state_restored && transport_restored && observables_restored;
    if (rollback_succeeded) {
        (void)context_commit_step_transaction_rollback_sample(ctx);
    } else {
        context_discard_step_transaction_rollback_sample(ctx);
    }
    ctx.last_error = primary_error;
    return rollback_succeeded;
}

int execute_single_grid_step_transaction(
    Context &ctx,
    double dt_seconds,
    fullmag_fdm_step_stats &trial_stats,
    fullmag_fdm_step_stats &out_stats,
    ReceiptSolverPhaseGuard &receipt_solver_phase)
{
    uint64_t transport_attempt_id = 0;
    const uint32_t injected_phase = ctx.step_transaction_test_failure_phase;
    ctx.step_transaction_test_failure_phase = 0;
    StepTransactionController transaction(
        static_cast<StepTransactionPhase>(injected_phase),
        injected_phase != 0,
        FULLMAG_FDM_ERR_CUDA);
    const int status = transaction.run(
        [&]() {
            ctx.step_fsal_reused = false;
            ctx.accepted_step_pending = false;
            ctx.fsal_pending = false;
            if (!context_begin_step_transaction_attempt(ctx)) {
                return FULLMAG_FDM_ERR_INVALID;
            }
            if (ctx.gpu_transport_rhs.active) {
                if (ctx.gpu_transport_attempt_generation == UINT64_MAX) {
                    ctx.last_error = "bound spin-transport attempt identity exhausted";
                    return FULLMAG_FDM_ERR_INVALID;
                }
                transport_attempt_id = ++ctx.gpu_transport_attempt_generation;
                ctx.gpu_transport_active_attempt_id = transport_attempt_id;
            }
            if (!context_begin_gpu_transport_step(ctx, transport_attempt_id)) {
                ctx.gpu_transport_active_attempt_id = 0;
                ctx.last_error = "failed to begin bound spin-transport step transaction";
                return FULLMAG_FDM_ERR_CUDA;
            }
            return FULLMAG_FDM_OK;
        },
        [&]() {
            if (!context_capture_pre_step_state(ctx)) return FULLMAG_FDM_ERR_CUDA;
            ctx.trial_dt = dt_seconds;
            return FULLMAG_FDM_OK;
        },
        [&]() {
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                switch (ctx.integrator) {
                    case FULLMAG_FDM_INTEGRATOR_DP45:
                        launch_dp45_step_fp64(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_ABM3:
                        launch_abm3_step_fp64(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_RK4:
                        launch_rk4_step_fp64(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_RK23:
                        launch_rk23_step_fp64(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_HEUN:
                    default:
                        launch_heun_step_fp64(ctx, dt_seconds, &trial_stats); break;
                }
            } else {
                switch (ctx.integrator) {
                    case FULLMAG_FDM_INTEGRATOR_DP45:
                        launch_dp45_step_fp32(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_ABM3:
                        launch_abm3_step_fp32(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_RK4:
                        launch_rk4_step_fp32(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_RK23:
                        launch_rk23_step_fp32(ctx, dt_seconds, &trial_stats); break;
                    case FULLMAG_FDM_INTEGRATOR_HEUN:
                    default:
                        launch_heun_step_fp32(ctx, dt_seconds, &trial_stats); break;
                }
            }
            if (ctx.step_interrupted) return FULLMAG_FDM_ERR_INTERRUPTED;
            if (ctx.last_error == "dt_min_exhausted") {
                return FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED;
            }
            if (!ctx.last_error.empty()) return FULLMAG_FDM_ERR_CUDA;
            const cudaError_t error = cudaGetLastError();
            if (error != cudaSuccess) {
                set_cuda_error(ctx, "integrator_step", error);
                return FULLMAG_FDM_ERR_CUDA;
            }
            return FULLMAG_FDM_OK;
        },
        [&]() {
            return poll_interrupt(ctx)
                ? FULLMAG_FDM_ERR_INTERRUPTED : FULLMAG_FDM_OK;
        },
        [&]() {
            return context_complete_solver_receipt_attempt(
                ctx, "cudaStreamSynchronize(single-grid receipt attempt)")
                ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_CUDA;
        },
        [&]() {
            if (context_commit_gpu_transport_step(ctx)) return FULLMAG_FDM_OK;
            ctx.last_error = "failed to commit bound spin-transport step transaction";
            return FULLMAG_FDM_ERR_CUDA;
        },
        [&]() {
            context_commit_accepted_step(ctx);
            context_publish_pending_fsal(ctx);
            context_discard_pre_step_state(ctx);
        },
        [&]() {
            fullmag_fdm_publish_hot_loop_audit(ctx, &trial_stats);
            fullmag_fdm_note_operator_device_execution(
                ctx, FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR);
            receipt_solver_phase.commit();
            if (fullmag_fdm_should_fill_step_stats(ctx)) {
                context_publish_endpoint_fields(
                    ctx, OBSERVABLE_ENDPOINT_CORE_FIELDS);
                context_publish_endpoint_stats(ctx, trial_stats);
            }
            context_finish_endpoint_step_accounting(ctx);
            (void)context_publish_accepted_step_stats(
                true, trial_stats, &out_stats);
        },
        [&]() {
            return rollback_step_transaction(ctx)
                ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_CUDA;
        });
    if (status != FULLMAG_FDM_OK && injected_phase != 0 &&
        ctx.last_error.empty()) {
        ctx.last_error = "injected step transaction failure";
    }
    return status;
}

int execute_multilayer_step_transaction(
    Context &ctx,
    double dt_seconds,
    fullmag_fdm_step_stats &trial_stats,
    fullmag_fdm_step_stats &out_stats,
    ReceiptSolverPhaseGuard &receipt_solver_phase)
{
    const uint32_t injected_phase = ctx.step_transaction_test_failure_phase;
    ctx.step_transaction_test_failure_phase = 0;
    StepTransactionController transaction(
        static_cast<StepTransactionPhase>(injected_phase),
        injected_phase != 0,
        FULLMAG_FDM_ERR_CUDA);
    const int status = transaction.run(
        [&]() {
            ctx.accepted_step_pending = false;
            if (!context_begin_step_transaction_attempt(ctx)) {
                return FULLMAG_FDM_ERR_INVALID;
            }
            return FULLMAG_FDM_OK;
        },
        [&]() {
            if (!context_capture_pre_step_state(ctx)) return FULLMAG_FDM_ERR_CUDA;
            ctx.trial_dt = dt_seconds;
            return FULLMAG_FDM_OK;
        },
        [&]() {
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23) {
                    launch_multilayer_rk23_step_fp64(ctx, dt_seconds, &trial_stats);
                } else if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK4) {
                    launch_multilayer_rk4_step_fp64(ctx, dt_seconds, &trial_stats);
                } else {
                    launch_multilayer_heun_step_fp64(ctx, dt_seconds, &trial_stats);
                }
            } else {
                if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23) {
                    launch_multilayer_rk23_step_fp32(ctx, dt_seconds, &trial_stats);
                } else if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK4) {
                    launch_multilayer_rk4_step_fp32(ctx, dt_seconds, &trial_stats);
                } else {
                    launch_multilayer_heun_step_fp32(ctx, dt_seconds, &trial_stats);
                }
            }
            if (!ctx.last_error.empty()) return FULLMAG_FDM_ERR_CUDA;
            const cudaError_t error = cudaGetLastError();
            if (error != cudaSuccess) {
                set_cuda_error(ctx, "multilayer_integrator_step", error);
                return FULLMAG_FDM_ERR_CUDA;
            }
            return FULLMAG_FDM_OK;
        },
        [&]() {
            return poll_interrupt(ctx)
                ? FULLMAG_FDM_ERR_INTERRUPTED : FULLMAG_FDM_OK;
        },
        [&]() {
            return context_complete_solver_receipt_attempt(
                ctx, "cudaStreamSynchronize(multilayer receipt attempt)")
                ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_CUDA;
        },
        []() { return FULLMAG_FDM_OK; },
        [&]() {
            context_commit_accepted_step(ctx);
            context_discard_pre_step_state(ctx);
        },
        [&]() {
            fullmag_fdm_publish_hot_loop_audit(ctx, &trial_stats);
            fullmag_fdm_note_operator_device_execution(
                ctx, FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR);
            receipt_solver_phase.commit();
            fullmag_fdm_publish_multilayer_demag_stage_counters(ctx, &trial_stats);
            context_finish_endpoint_step_accounting(ctx);
            (void)context_publish_accepted_step_stats(
                true, trial_stats, &out_stats);
        },
        [&]() {
            return rollback_step_transaction(ctx)
                ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_CUDA;
        });
    if (status != FULLMAG_FDM_OK && injected_phase != 0 &&
        ctx.last_error.empty()) {
        ctx.last_error = "injected step transaction failure";
    }
    return status;
}
#endif

#if FULLMAG_HAS_CUDA
bool refresh_multilayer_demag(Context &ctx) {
    ctx.last_error.clear();
    if (!ctx.enable_demag) {
        return true;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        launch_multilayer_demag_field_fp64(ctx);
    } else {
        launch_multilayer_demag_field_fp32(ctx);
    }
    return ctx.last_error.empty();
}
#endif

bool checked_product3(
    uint64_t first,
    uint64_t second,
    uint64_t third,
    uint64_t &result)
{
    if (second != 0 && first > std::numeric_limits<uint64_t>::max() / second) {
        return false;
    }
    const uint64_t first_second = first * second;
    if (third != 0 && first_second > std::numeric_limits<uint64_t>::max() / third) {
        return false;
    }
    result = first_second * third;
    return true;
}

bool checked_grid_cell_count(
    const fullmag_fdm_grid_desc &grid,
    uint64_t &cell_count)
{
    return checked_product3(grid.nx, grid.ny, grid.nz, cell_count);
}

bool checked_scaled_product3(
    uint64_t first,
    uint64_t second,
    uint64_t third,
    uint64_t scale,
    uint64_t &result)
{
    uint64_t product = 0;
    return checked_product3(first, second, third, product) &&
        fullmag_fdm_checked_transfer_bytes(product, scale, result);
}

bool validate_grid_desc(
    const fullmag_fdm_grid_desc &grid,
    const char *name,
    std::string &error,
    uint64_t *cell_count = nullptr)
{
    if (grid.nx == 0 || grid.ny == 0 || grid.nz == 0) {
        error = std::string(name) + " must have non-zero dimensions";
        return false;
    }
    if (grid.dx <= 0.0 || grid.dy <= 0.0 || grid.dz <= 0.0) {
        error = std::string(name) + " must have positive cell sizes";
        return false;
    }
    uint64_t checked_cell_count = 0;
    if (!checked_grid_cell_count(grid, checked_cell_count)) {
        error = std::string(name) + " cell count overflows uint64_t";
        return false;
    }
    if (cell_count != nullptr) {
        *cell_count = checked_cell_count;
    }
    return true;
}

bool valid_precision(fullmag_fdm_precision precision) {
    return precision == FULLMAG_FDM_PRECISION_SINGLE ||
        precision == FULLMAG_FDM_PRECISION_DOUBLE;
}

bool valid_integrator(fullmag_fdm_integrator integrator) {
    switch (integrator) {
        case FULLMAG_FDM_INTEGRATOR_HEUN:
        case FULLMAG_FDM_INTEGRATOR_DP45:
        case FULLMAG_FDM_INTEGRATOR_ABM3:
        case FULLMAG_FDM_INTEGRATOR_RK4:
        case FULLMAG_FDM_INTEGRATOR_RK23:
            return true;
        default:
            return false;
    }
}

bool valid_transfer_kind(fullmag_fdm_transfer_kind transfer_kind) {
    return transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY ||
        transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL;
}

bool validate_multilayer_plan_v2(
    const fullmag_fdm_multilayer_plan_desc_v2 &plan,
    std::string &error)
{
    if (!valid_precision(plan.precision)) {
        error = "unknown FDM precision in v2 plan";
        return false;
    }
    if (!valid_integrator(plan.integrator)) {
        error = "unknown FDM integrator in v2 plan";
        return false;
    }
    if (plan.layer_count == 0) {
        error = "layer_count must be greater than zero";
        return false;
    }
    if (plan.layers == nullptr) {
        error = "layers pointer must be present when layer_count is non-zero";
        return false;
    }

    for (uint32_t i = 0; i < plan.layer_count; ++i) {
        const fullmag_fdm_layer_desc_v2 &layer = plan.layers[i];
        uint64_t native_cell_count = 0;
        if (layer.layer_index != i) {
            error = "layer_index must match layer table order";
            return false;
        }
        if (!validate_grid_desc(
                layer.native_grid,
                "layer native_grid",
                error,
                &native_cell_count) ||
            !validate_grid_desc(layer.convolution_grid, "layer convolution_grid", error))
        {
            return false;
        }
        if (!valid_transfer_kind(layer.transfer_kind)) {
            error = "unknown layer transfer_kind in v2 plan";
            return false;
        }
        if (layer.material.saturation_magnetisation <= 0.0) {
            error = "layer material saturation_magnetisation must be positive";
            return false;
        }
        if (layer.material.exchange_stiffness < 0.0) {
            error = "layer material exchange_stiffness must be non-negative";
            return false;
        }
        if (layer.material.damping < 0.0) {
            error = "layer material damping must be non-negative";
            return false;
        }
        if (layer.material.gyromagnetic_ratio <= 0.0) {
            error = "layer material gyromagnetic_ratio must be positive";
            return false;
        }
        uint64_t expected_m_len = 0;
        if (!fullmag_fdm_checked_vector_bytes(
                native_cell_count, 1, expected_m_len)) {
            error = "layer initial_magnetization length overflows uint64_t";
            return false;
        }
        if (layer.initial_magnetization_xyz == nullptr) {
            error = "layer initial_magnetization_xyz must be present";
            return false;
        }
        if (layer.initial_magnetization_len != expected_m_len) {
            error = "layer initial_magnetization_len mismatch: expected "
                + std::to_string(expected_m_len)
                + ", got " + std::to_string(layer.initial_magnetization_len);
            return false;
        }
        if (layer.active_mask != nullptr &&
            layer.active_mask_len != native_cell_count)
        {
            error = "layer active_mask_len mismatch: expected "
                + std::to_string(native_cell_count)
                + ", got " + std::to_string(layer.active_mask_len);
            return false;
        }
    }

    if (plan.enable_demag) {
        if (plan.kernels == nullptr) {
            error = "kernels pointer must be present when demag is enabled";
            return false;
        }
        const uint64_t expected_kernel_count =
            static_cast<uint64_t>(plan.layer_count) * plan.layer_count;
        if (plan.kernel_count != expected_kernel_count) {
            error = "kernel_count mismatch: expected "
                + std::to_string(expected_kernel_count)
                + ", got " + std::to_string(plan.kernel_count);
            return false;
        }
        for (uint32_t i = 0; i < plan.kernel_count; ++i) {
            const fullmag_fdm_tensor_kernel_desc_v2 &kernel = plan.kernels[i];
            uint64_t expected_len = 0;
            if (kernel.dst_layer >= plan.layer_count || kernel.src_layer >= plan.layer_count) {
                error = "kernel layer index out of range";
                return false;
            }
            if (!validate_grid_desc(
                    kernel.fft_grid,
                    "kernel fft_grid",
                    error,
                    &expected_len)) {
                return false;
            }
            if (!kernel.kernel_xx || !kernel.kernel_yy || !kernel.kernel_zz ||
                !kernel.kernel_xy || !kernel.kernel_xz || !kernel.kernel_yz)
            {
                error = "kernel tensor spectra pointers must all be present";
                return false;
            }
            if (kernel.kernel_len != expected_len) {
                error = "kernel_len mismatch: expected "
                    + std::to_string(expected_len)
                    + ", got " + std::to_string(kernel.kernel_len);
                return false;
            }
        }
    }

    return true;
}

} // namespace

/* ── Availability ── */

int fullmag_fdm_is_available(void) {
#if FULLMAG_HAS_CUDA
    int device_count = 0;
    cudaError_t err = cudaGetDeviceCount(&device_count);
    if (err != cudaSuccess || device_count <= 0) {
        return 0;
    }
    auto selected = selected_cuda_device_from_env();
    if (selected.has_value() && *selected >= device_count) {
        return 0;
    }
    return 1;
#else
    return 0;
#endif
}

uint64_t fullmag_fdm_capability_bits_v1(void) {
    // The single-grid CUDA integrators consume a device-resident Frozen Spins
    // mask after all physical RHS sources are assembled. Multilayer plans are
    // still rejected by the planner and do not advertise this lane.
    return FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1;
}

/* ── Create ── */

fullmag_fdm_backend *fullmag_fdm_backend_create(
    const fullmag_fdm_plan_desc *plan)
{
#if FULLMAG_HAS_CUDA
    if (!plan) return nullptr;

    auto *ctx = new (std::nothrow) Context();
    if (!ctx) return nullptr;
    const bool has_frozen_spins = (plan->frozen_mask != nullptr
        || plan->frozen_mask_len != 0
        || plan->frozen_reference_xyz != nullptr
        || plan->frozen_reference_len != 0);
    if (has_frozen_spins) {
        uint64_t cell_count = 0;
        uint64_t reference_len = 0;
        if (!checked_grid_cell_count(plan->grid, cell_count) ||
            !fullmag_fdm_checked_vector_bytes(cell_count, 1, reference_len)) {
            ctx->last_error = "frozen_spins_cuda_abi_invalid: grid size overflows uint64_t";
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
        if (plan->frozen_mask == nullptr || plan->frozen_reference_xyz == nullptr
            || plan->frozen_mask_len != cell_count
            || plan->frozen_reference_len != reference_len)
        {
            ctx->last_error =
                "frozen_spins_cuda_abi_invalid: expected dense mask[cell_count] and f64 reference[3*cell_count]";
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }
    if (plan->precision == FULLMAG_FDM_PRECISION_SINGLE
        && plan->boundary_correction != FULLMAG_FDM_BOUNDARY_NONE)
    {
        ctx->last_error =
            "FDM FP32 sub-cell boundary correction is unavailable until field/energy parity is qualified; use double precision or boundary_correction=none";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (plan->enable_demag != 0 && plan->demag_kernel_spectrum_len == 0) {
        ctx->last_error =
            "FDM CUDA demag requires validated Newell tensor spectra; automatic native spectrum construction is unavailable";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (!select_cuda_device_if_requested(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    int device_ordinal = -1;
    if (cudaGetDevice(&device_ordinal) != cudaSuccess) {
        ctx->last_error = "failed to capture selected CUDA device for execution receipt";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    fullmag_fdm_set_device_ordinal(*ctx->execution_receipt, device_ordinal);

    // Copy grid
    ctx->nx = plan->grid.nx;
    ctx->ny = plan->grid.ny;
    ctx->nz = plan->grid.nz;
    if (!checked_grid_cell_count(plan->grid, ctx->cell_count)) {
        ctx->last_error = "grid cell count overflows uint64_t";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    ctx->dx = plan->grid.dx;
    ctx->dy = plan->grid.dy;
    ctx->dz = plan->grid.dz;

    // Copy material
    ctx->Ms    = plan->material.saturation_magnetisation;
    ctx->A     = plan->material.exchange_stiffness;
    ctx->alpha = plan->material.damping;
    ctx->gamma = plan->material.gyromagnetic_ratio;

    // Execution config
    ctx->precision  = plan->precision;
    ctx->integrator = plan->integrator;
    if (plan->stats_mode == FULLMAG_FDM_STATS_REQUESTED) {
        ctx->last_error =
            "requested stats mode requires fullmag_fdm_backend_set_stats_policy_v1";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    ctx->stats_mode = plan->stats_mode == FULLMAG_FDM_STATS_NONE
        ? FULLMAG_FDM_STATS_NONE
        : plan->stats_mode == FULLMAG_FDM_STATS_CONTROL
            ? FULLMAG_FDM_STATS_CONTROL
            : FULLMAG_FDM_STATS_FULL;
    ctx->stats_stride = plan->stats_stride == 0 ? 1 : plan->stats_stride;
    ctx->disable_precession = plan->disable_precession != 0;
    ctx->enable_exchange = plan->enable_exchange != 0;
    ctx->enable_demag = plan->enable_demag != 0;
    ctx->has_external_field = plan->has_external_field != 0;
    ctx->has_active_mask = plan->active_mask != nullptr;
    ctx->has_frozen_mask = plan->frozen_mask != nullptr;
    ctx->has_region_mask = plan->region_mask != nullptr;
    ctx->has_exchange_lut = ctx->has_region_mask; // always build LUT when regions are present
    ctx->has_demag_tensor_kernel = plan->demag_kernel_spectrum_len != 0;
    ctx->external_field[0] = plan->external_field_am[0];
    ctx->external_field[1] = plan->external_field_am[1];
    ctx->external_field[2] = plan->external_field_am[2];
    ctx->active_cell_count = ctx->cell_count;

    // Uniaxial Anisotropy
    ctx->has_uniaxial_anisotropy = plan->has_uniaxial_anisotropy != 0;
    ctx->Ku1 = plan->uniaxial_anisotropy_constant;
    ctx->Ku2 = plan->uniaxial_anisotropy_k2;
    ctx->anisU[0] = plan->anisotropy_axis[0];
    ctx->anisU[1] = plan->anisotropy_axis[1];
    ctx->anisU[2] = plan->anisotropy_axis[2];

    // Cubic Anisotropy
    ctx->has_cubic_anisotropy = plan->has_cubic_anisotropy != 0;
    ctx->Kc1 = plan->cubic_Kc1;
    ctx->Kc2 = plan->cubic_Kc2;
    ctx->Kc3 = plan->cubic_Kc3;
    ctx->cubic_axis1[0] = plan->cubic_axis1[0];
    ctx->cubic_axis1[1] = plan->cubic_axis1[1];
    ctx->cubic_axis1[2] = plan->cubic_axis1[2];
    ctx->cubic_axis2[0] = plan->cubic_axis2[0];
    ctx->cubic_axis2[1] = plan->cubic_axis2[1];
    ctx->cubic_axis2[2] = plan->cubic_axis2[2];

    // DMI
    ctx->has_interfacial_dmi = plan->has_interfacial_dmi != 0;
    ctx->D_interfacial = plan->dmi_D_interfacial;
    ctx->has_bulk_dmi = plan->has_bulk_dmi != 0;
    ctx->D_bulk = plan->dmi_D_bulk;

    // Magnetoelastic coupling (prescribed strain)
    ctx->has_magnetoelastic = plan->has_magnetoelastic != 0;
    ctx->mel_b1 = plan->mel_b1;
    ctx->mel_b2 = plan->mel_b2;
    for (int i = 0; i < 6; ++i) {
        ctx->mel_strain[i] = plan->mel_strain[i];
    }

    // Thermal noise
    ctx->temperature = plan->temperature;
    ctx->thermal_seed = plan->thermal_seed;
    if (ctx->temperature > 0.0 && ctx->thermal_seed == 0) {
        std::random_device entropy;
        ctx->thermal_seed =
            (static_cast<uint64_t>(entropy()) << 32) ^ static_cast<uint64_t>(entropy());
        if (ctx->thermal_seed == 0) ctx->thermal_seed = 1;
    }

    // Shared spin-torque inputs
    double px = plan->stt_p_x;
    double py = plan->stt_p_y;
    double pz = plan->stt_p_z;
    double p_sq = px*px + py*py + pz*pz;

    // Zhang-Li STT
    ctx->has_zhang_li_stt = (plan->current_density_x != 0 || plan->current_density_y != 0 || plan->current_density_z != 0)
                         && plan->stt_degree > 0
                         && !(p_sq > 0.0 && plan->stt_lambda > 0.0);
    ctx->current_density_x = plan->current_density_x;
    ctx->current_density_y = plan->current_density_y;
    ctx->current_density_z = plan->current_density_z;
    ctx->stt_degree = plan->stt_degree;
    ctx->stt_beta = plan->stt_beta;
    ctx->zhang_li_formula = plan->zhang_li_formula;
    if (ctx->has_zhang_li_stt && ctx->Ms > 0) {
        // Keep the historical v0 coefficient byte-for-byte stable.  The
        // MuMax3 realization uses the constants and 1/2 factor from
        // addzhanglitorque2.cu; its central spatial stencil is selected in
        // the CUDA RHS kernel by the same explicit formula discriminator.
        const bool mumax3 =
            ctx->zhang_li_formula == FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1;
        double mu_B = mumax3 ? 9.2740091523e-24 : 9.274009994e-24; // J/T
        double e = mumax3 ? 1.60217646e-19 : 1.60217662e-19;       // C
        double denominator = e * ctx->Ms * (1.0 + ctx->stt_beta * ctx->stt_beta);
        if (mumax3) {
            denominator *= 2.0;
        }
        double b = (ctx->stt_degree * mu_B) / denominator;
        ctx->stt_u_pf = b;
    } else {
        ctx->stt_u_pf = 0.0;
    }

    // Slonczewski STT (CPP / SOT)
    ctx->has_slonczewski_stt = p_sq > 0.0 && plan->stt_lambda > 0.0 
                            && (plan->current_density_x != 0 || plan->current_density_y != 0 || plan->current_density_z != 0);
    ctx->stt_p_x = px;
    ctx->stt_p_y = py;
    ctx->stt_p_z = pz;
    ctx->stt_lambda = plan->stt_lambda;
    ctx->stt_epsilon_prime = plan->stt_epsilon_prime;
    ctx->slonczewski_formula = plan->slonczewski_formula;
    ctx->has_slonczewski_active_mask = plan->slonczewski_active_mask != nullptr;
    ctx->stt_stack_normal[0] = plan->stt_stack_normal[0];
    ctx->stt_stack_normal[1] = plan->stt_stack_normal[1];
    ctx->stt_stack_normal[2] = plan->stt_stack_normal[2];
    
    if (ctx->has_slonczewski_stt && ctx->Ms > 0 && ctx->dz > 0) {
        double hbar = 1.054571817e-34; // Reduced Planck constant (J s)
        double e = ctx->slonczewski_formula == FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2
            ? 1.602176634e-19
            : 1.60217662e-19;          // Elementary charge (C)
        double mu_0 = 4.0 * kFullmagPi * 1e-7; // Vacuum permeability
        double js = sqrt(ctx->current_density_x*ctx->current_density_x +
                         ctx->current_density_y*ctx->current_density_y +
                         ctx->current_density_z*ctx->current_density_z);
        // Explicit-RHS prefactor: gamma_mu0 * J_n * hbar /
        // (e * mu_0 * M_s * d) for canonical v2; the legacy branch keeps
        // the historical 1/(2e) evaluator byte-for-byte.
        // Use explicit free layer thickness if provided, otherwise cell dz
        double d_free = plan->stt_free_layer_thickness > 0.0
                      ? plan->stt_free_layer_thickness : ctx->dz;
        double current_sign = plan->stt_current_sign == 0.0 ? 1.0 : plan->stt_current_sign;
        double signed_current = current_sign * js;
        double denominator_factor = 2.0;
        if (ctx->slonczewski_formula == FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2) {
            const double normal_norm = std::sqrt(
                ctx->stt_stack_normal[0] * ctx->stt_stack_normal[0] +
                ctx->stt_stack_normal[1] * ctx->stt_stack_normal[1] +
                ctx->stt_stack_normal[2] * ctx->stt_stack_normal[2]);
            if (!std::isfinite(normal_norm) || normal_norm <= 0.0) {
                ctx->last_error = "slonczewski.fullmag.v2 requires a finite nonzero stack normal";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            ctx->stt_stack_normal[0] /= normal_norm;
            ctx->stt_stack_normal[1] /= normal_norm;
            ctx->stt_stack_normal[2] /= normal_norm;
            signed_current =
                ctx->current_density_x * ctx->stt_stack_normal[0] +
                ctx->current_density_y * ctx->stt_stack_normal[1] +
                ctx->current_density_z * ctx->stt_stack_normal[2];
            denominator_factor = 1.0;
        }
        ctx->stt_cpp_pf = (signed_current * hbar * ctx->gamma) /
            (denominator_factor * e * mu_0 * ctx->Ms * d_free);
    } else {
        ctx->stt_cpp_pf = 0.0;
    }

    // ── Spin-Orbit Torque (SOT) ──
    ctx->has_sot       = plan->has_sot != 0;
    ctx->sot_formula   = plan->sot_formula;
    ctx->sot_je        = plan->sot_je;
    ctx->sot_xi_dl     = plan->sot_xi_dl;
    ctx->sot_xi_fl     = plan->sot_xi_fl;
    ctx->sot_sigma[0]  = plan->sot_sigma[0];
    ctx->sot_sigma[1]  = plan->sot_sigma[1];
    ctx->sot_sigma[2]  = plan->sot_sigma[2];
    ctx->sot_thickness =
        plan->sot_formula == FULLMAG_FDM_PRESCRIBED_SOT_V1
            ? plan->sot_thickness
            : (plan->sot_thickness > 0.0 ? plan->sot_thickness : 1.0e-9);
    ctx->has_sot_active_mask = plan->sot_active_mask != nullptr;

    // ── Oersted field (cylindrical conductor) ──
    ctx->has_oersted_cylinder = plan->has_oersted_cylinder != 0;
    ctx->oersted_current = plan->oersted_current;
    ctx->oersted_radius = plan->oersted_radius;
    for (int i = 0; i < 3; ++i) {
        ctx->oersted_center[i] = plan->oersted_center[i];
        ctx->oersted_axis[i] = plan->oersted_axis[i];
    }
    ctx->oersted_time_dep_kind = plan->oersted_time_dep_kind;
    ctx->oersted_time_dep_freq = plan->oersted_time_dep_freq;
    ctx->oersted_time_dep_phase = plan->oersted_time_dep_phase;
    ctx->oersted_time_dep_offset = plan->oersted_time_dep_offset;
    ctx->oersted_time_dep_t_on = plan->oersted_time_dep_t_on;
    ctx->oersted_time_dep_t_off = plan->oersted_time_dep_t_off;
    const bool has_oersted_field = plan->oersted_field_xyz != nullptr && plan->oersted_field_len != 0;
    ctx->has_oersted_field = ctx->has_oersted_cylinder || has_oersted_field;

    // Legacy v1 compatibility: embedded RK retained its historical adaptive
    // interpretation. Canonical fixed/adaptive semantics use the v2 symbol.
    ctx->adaptive_enabled =
        plan->integrator == FULLMAG_FDM_INTEGRATOR_DP45 ||
        plan->integrator == FULLMAG_FDM_INTEGRATOR_RK23;
    ctx->adaptive_tolerance_mode = FULLMAG_FDM_ADAPTIVE_MAX_ERROR;
    ctx->adaptive_atol = plan->adaptive_max_error > 0 ? plan->adaptive_max_error : 1e-5;
    ctx->adaptive_rtol = 0.0;
    ctx->adaptive_dt_min    = plan->adaptive_dt_min > 0    ? plan->adaptive_dt_min    : 1e-18;
    ctx->adaptive_dt_max    = plan->adaptive_dt_max > 0    ? plan->adaptive_dt_max    : 1e-10;
    ctx->adaptive_safety = plan->adaptive_headroom > 0  ? plan->adaptive_headroom  : 0.8;
    // Legacy v1 had no ratio clamp beyond dt_min/dt_max.
    ctx->adaptive_growth_limit = 1.0e300;
    ctx->adaptive_shrink_limit = 1.0e-300;
    ctx->adaptive_canonical_controller = false;

    // Validate
    if (ctx->cell_count == 0) {
        ctx->last_error = "grid has zero cells";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    uint64_t setup_bytes = 0;
    const uint64_t scalar_bytes =
        ctx->precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? sizeof(double) : sizeof(float);
    if (!fullmag_fdm_checked_vector_bytes(
            ctx->cell_count, scalar_bytes, setup_bytes)) {
        fullmag_fdm_invalidate_execution_receipt(*ctx->execution_receipt);
        ctx->last_error = "initial magnetization byte count overflow";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    const uint64_t expected_len = setup_bytes / scalar_bytes;
    if (plan->initial_magnetization_len != expected_len) {
        ctx->last_error = "initial_magnetization_len mismatch: expected "
            + std::to_string(expected_len)
            + ", got " + std::to_string(plan->initial_magnetization_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_active_mask && plan->active_mask_len != ctx->cell_count) {
        ctx->last_error = "active_mask_len mismatch: expected "
            + std::to_string(ctx->cell_count)
            + ", got " + std::to_string(plan->active_mask_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_active_mask &&
        std::none_of(
            plan->active_mask,
            plan->active_mask + plan->active_mask_len,
            [](uint8_t active) { return active != 0; })) {
        ctx->last_error = "active_mask contains no active cells";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_sot && ctx->sot_formula != FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0 &&
        ctx->sot_formula != FULLMAG_FDM_PRESCRIBED_SOT_V1)
    {
        ctx->last_error = "unsupported prescribed SOT formula discriminator";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_sot && ctx->sot_formula == FULLMAG_FDM_PRESCRIBED_SOT_V1 &&
        (!ctx->has_sot_active_mask || plan->sot_active_mask_len != ctx->cell_count))
    {
        ctx->last_error = "prescribed SOT requires sot_active_mask_len equal to cell_count";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_slonczewski_stt &&
        ctx->slonczewski_formula != FULLMAG_FDM_SLONCZEWSKI_LEGACY_FULLMAG_V0 &&
        ctx->slonczewski_formula != FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2)
    {
        ctx->last_error = "unsupported Slonczewski formula discriminator";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_slonczewski_stt &&
        ctx->slonczewski_formula == FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2 &&
        (!ctx->has_slonczewski_active_mask ||
         plan->slonczewski_active_mask_len != ctx->cell_count))
    {
        ctx->last_error = "slonczewski.fullmag.v2 requires slonczewski_active_mask_len equal to cell_count";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if ((!ctx->has_slonczewski_stt ||
         ctx->slonczewski_formula != FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2) &&
        (ctx->has_slonczewski_active_mask || plan->slonczewski_active_mask_len != 0))
    {
        ctx->last_error = "slonczewski_active_mask requires slonczewski.fullmag.v2";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_sot && ctx->sot_formula == FULLMAG_FDM_PRESCRIBED_SOT_V1 &&
        (!std::isfinite(ctx->sot_je) || !std::isfinite(ctx->sot_xi_dl) ||
         !std::isfinite(ctx->sot_xi_fl) || !std::isfinite(ctx->sot_thickness) ||
         ctx->sot_thickness <= 0.0 || !std::isfinite(ctx->sot_sigma[0]) ||
         !std::isfinite(ctx->sot_sigma[1]) || !std::isfinite(ctx->sot_sigma[2]) ||
         (ctx->sot_sigma[0] == 0.0 && ctx->sot_sigma[1] == 0.0 &&
          ctx->sot_sigma[2] == 0.0)))
    {
        ctx->last_error = "prescribed_sot.fullmag.v1 parameters are invalid";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if ((ctx->sot_formula != FULLMAG_FDM_PRESCRIBED_SOT_V1 || !ctx->has_sot) &&
        (ctx->has_sot_active_mask || plan->sot_active_mask_len != 0))
    {
        ctx->last_error = "sot_active_mask requires prescribed_sot.fullmag.v1";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_oersted_cylinder && has_oersted_field) {
        ctx->last_error =
            "oersted configuration is ambiguous: provide either OerstedCylinder or oersted_field_xyz, not both";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    const bool has_cellwise_material_field =
        plan->ms_field != nullptr || plan->a_field != nullptr || plan->alpha_field != nullptr
        || plan->dind_field != nullptr || plan->dbulk_field != nullptr
        || plan->ms_field_len != 0 || plan->a_field_len != 0 || plan->alpha_field_len != 0
        || plan->dind_field_len != 0 || plan->dbulk_field_len != 0;
    if (has_cellwise_material_field) {
        ctx->last_error =
            "FDM cellwise material fields reached native backend before kernel support is enabled; planner/runtime materialization must keep this path capability-gated";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (has_oersted_field && plan->oersted_field_len != ctx->cell_count * 3u) {
        ctx->last_error = "oersted_field_len mismatch: expected "
            + std::to_string(ctx->cell_count * 3u)
            + ", got " + std::to_string(plan->oersted_field_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_region_mask && plan->region_mask_len != ctx->cell_count) {
        ctx->last_error = "region_mask_len mismatch: expected "
            + std::to_string(ctx->cell_count)
            + ", got " + std::to_string(plan->region_mask_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_region_mask) {
        for (uint64_t index = 0; index < plan->region_mask_len; ++index) {
            if (plan->region_mask[index] > FULLMAG_FDM_MAX_REGION_ID) {
                ctx->last_error = "fdm_region_lut_capacity_exceeded: requested_region_id="
                    + std::to_string(plan->region_mask[index])
                    + " supported_region_ids="
                    + std::to_string(FULLMAG_FDM_MAX_REGION_ID);
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
        }
    }
    if (plan->exchange_pair_count != 0 && plan->exchange_pairs == nullptr) {
        ctx->last_error = "exchange_pair_count is non-zero but exchange_pairs is null";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (plan->exchange_pair_count != 0 && !ctx->has_region_mask) {
        ctx->last_error = "exchange_pairs require region_mask";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_active_mask) {
        ctx->active_mask_host.assign(plan->active_mask, plan->active_mask + plan->active_mask_len);
        ctx->active_cell_count = 0;
        for (uint8_t value : ctx->active_mask_host) {
            if (value != 0) {
                ctx->active_cell_count++;
            }
        }
    }
    if (ctx->has_region_mask) {
        ctx->region_mask_host.assign(plan->region_mask, plan->region_mask + plan->region_mask_len);
    }
    if (ctx->has_demag_tensor_kernel) {
        if (!plan->demag_kernel_xx_spectrum || !plan->demag_kernel_yy_spectrum
            || !plan->demag_kernel_zz_spectrum || !plan->demag_kernel_xy_spectrum
            || !plan->demag_kernel_xz_spectrum || !plan->demag_kernel_yz_spectrum)
        {
            ctx->last_error = "demag kernel spectra pointers must all be present when demag_kernel_spectrum_len is set";
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
        const bool has_explicit_fft_dims =
            plan->demag_fft_nx != 0 || plan->demag_fft_ny != 0 || plan->demag_fft_nz != 0;
        if (has_explicit_fft_dims) {
            if (plan->demag_fft_nx == 0 || plan->demag_fft_ny == 0 || plan->demag_fft_nz == 0) {
                ctx->last_error = "demag FFT dimensions must either all be zero or all be non-zero";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            uint64_t expected_spectrum_len = 0;
            if (!checked_scaled_product3(
                    plan->demag_fft_nx,
                    plan->demag_fft_ny,
                    plan->demag_fft_nz,
                    2,
                    expected_spectrum_len)) {
                ctx->last_error = "demag FFT spectrum length overflows uint64_t";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            if (plan->demag_kernel_spectrum_len != expected_spectrum_len) {
                ctx->last_error = "demag_kernel_spectrum_len mismatch: expected "
                    + std::to_string(expected_spectrum_len)
                    + " for explicit FFT dimensions "
                    + std::to_string(plan->demag_fft_nx) + "x"
                    + std::to_string(plan->demag_fft_ny) + "x"
                    + std::to_string(plan->demag_fft_nz)
                    + ", got " + std::to_string(plan->demag_kernel_spectrum_len);
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            ctx->fft_nx = plan->demag_fft_nx;
            ctx->fft_ny = plan->demag_fft_ny;
            ctx->fft_nz = plan->demag_fft_nz;
            ctx->thin_film_2d_demag = ctx->fft_nz == 1;
        } else {
            const uint64_t padded_nx = static_cast<uint64_t>(ctx->nx) * 2;
            const uint64_t padded_ny = static_cast<uint64_t>(ctx->ny) * 2;
            const uint64_t padded_nz = static_cast<uint64_t>(ctx->nz) * 2;
            uint64_t expected_spectrum_len_3d = 0;
            uint64_t expected_spectrum_len_2d = 0;
            if (!checked_scaled_product3(
                    padded_nx,
                    padded_ny,
                    padded_nz,
                    2,
                    expected_spectrum_len_3d) ||
                !checked_scaled_product3(
                    padded_nx,
                    padded_ny,
                    1,
                    2,
                    expected_spectrum_len_2d)) {
                ctx->last_error = "implicit demag FFT spectrum length overflows uint64_t";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            if (ctx->nz == 1 && plan->demag_kernel_spectrum_len == expected_spectrum_len_2d) {
                ctx->thin_film_2d_demag = true;
            } else if (plan->demag_kernel_spectrum_len == expected_spectrum_len_3d) {
                ctx->thin_film_2d_demag = false;
            } else {
                ctx->last_error = "demag_kernel_spectrum_len mismatch: expected "
                    + std::to_string(expected_spectrum_len_3d)
                    + " (3D)"
                    + (ctx->nz == 1
                        ? " or " + std::to_string(expected_spectrum_len_2d) + " (thin-film 2D)"
                        : std::string())
                    + ", got " + std::to_string(plan->demag_kernel_spectrum_len);
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
        }
    }

    if (!context_preflight_single_grid_workspace(*ctx, *plan)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Allocate device buffers
    if (!context_alloc_device(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    if (ctx->has_active_mask &&
        !context_upload_active_mask(*ctx, plan->active_mask, plan->active_mask_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_frozen_mask &&
        !context_upload_frozen_spins(
            *ctx,
            plan->frozen_mask,
            plan->frozen_mask_len,
            plan->frozen_reference_xyz,
            plan->frozen_reference_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_sot_active_mask &&
        !context_upload_sot_active_mask(
            *ctx, plan->sot_active_mask, plan->sot_active_mask_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_slonczewski_active_mask &&
        !context_upload_slonczewski_active_mask(
            *ctx, plan->slonczewski_active_mask, plan->slonczewski_active_mask_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (ctx->has_region_mask &&
        !context_upload_region_mask(*ctx, plan->region_mask, plan->region_mask_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    // Build or upload inter-region exchange coupling LUT
    if (ctx->has_exchange_lut) {
        constexpr uint64_t N = FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
        std::vector<double> lut_host(N * N, 0.0);
        if (plan->exchange_lut != nullptr && plan->exchange_lut_len == N * N) {
            // Use caller-provided LUT
            std::memcpy(lut_host.data(), plan->exchange_lut, N * N * sizeof(double));
        } else {
            switch (plan->exchange_pair_default) {
            case FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN:
                // Uniform-material harmonic mean is A for every active pair.
                std::fill(lut_host.begin(), lut_host.end(), ctx->A);
                break;
            case FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT:
                ctx->last_error =
                    "exchange_pair_default=explicit is not a valid default; use exchange_pairs for explicit overrides";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            case FULLMAG_FDM_EXCHANGE_PAIR_DISABLED:
            case FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED:
                // Legacy/free-surface default: A_ii = A, A_ij(i!=j) = 0.
                for (uint64_t r = 0; r < N; ++r) {
                    lut_host[r * N + r] = ctx->A;
                }
                break;
            default:
                ctx->last_error = "invalid exchange_pair_default";
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
            for (uint64_t index = 0; index < plan->exchange_pair_count; ++index) {
                const fullmag_fdm_exchange_pair_desc &pair = plan->exchange_pairs[index];
                if (pair.region_i > FULLMAG_FDM_MAX_REGION_ID ||
                    pair.region_j > FULLMAG_FDM_MAX_REGION_ID) {
                    ctx->last_error = "fdm_region_lut_capacity_exceeded: exchange pair region index exceeds supported_region_ids="
                        + std::to_string(FULLMAG_FDM_MAX_REGION_ID);
                    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
                }
                double value = 0.0;
                switch (pair.mode) {
                case FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN:
                    value = ctx->A * pair.scale;
                    break;
                case FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT:
                    value = pair.inter_exchange * pair.scale;
                    break;
                case FULLMAG_FDM_EXCHANGE_PAIR_DISABLED:
                    value = 0.0;
                    break;
                case FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED:
                    ctx->last_error = "exchange pair mode must not be unspecified";
                    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
                default:
                    ctx->last_error = "invalid exchange pair mode";
                    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
                }
                lut_host[pair.region_i * N + pair.region_j] = value;
                lut_host[pair.region_j * N + pair.region_i] = value;
            }
        }
        if (!context_upload_exchange_lut(*ctx, lut_host.data(), N * N)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
        ctx->exchange_lut_host = std::move(lut_host);
    }
    if (plan->demag_kernel_spectrum_len != 0 &&
        !context_upload_demag_kernel_spectra(
            *ctx,
            plan->demag_kernel_xx_spectrum,
            plan->demag_kernel_yy_spectrum,
            plan->demag_kernel_zz_spectrum,
            plan->demag_kernel_xy_spectrum,
            plan->demag_kernel_xz_spectrum,
            plan->demag_kernel_yz_spectrum,
            plan->demag_kernel_spectrum_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Upload boundary correction geometry data (T0/T1)
    if (plan->boundary_correction != FULLMAG_FDM_BOUNDARY_NONE
        && plan->volume_fraction != nullptr
        && plan->volume_fraction_len == ctx->cell_count)
    {
        uint8_t tier = static_cast<uint8_t>(plan->boundary_correction);
        double phi_floor = plan->boundary_phi_floor > 0.0
            ? plan->boundary_phi_floor : 0.05;
        double delta_min = plan->boundary_delta_min > 0.0
            ? plan->boundary_delta_min
            : 0.1 * std::min({ctx->dx, ctx->dy, ctx->dz});

        if (!context_upload_boundary_correction(
                *ctx, tier, phi_floor, delta_min,
                plan->volume_fraction,
                plan->face_link_xp, plan->face_link_xm,
                plan->face_link_yp, plan->face_link_ym,
                plan->face_link_zp, plan->face_link_zm,
                plan->delta_xp, plan->delta_xm,
                plan->delta_yp, plan->delta_ym,
                plan->delta_zp, plan->delta_zm,
                ctx->cell_count))
        {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }

        // Sparse demag boundary correction tensors
        if (plan->has_demag_boundary_corr
            && plan->demag_corr_target_idx != nullptr
            && plan->demag_corr_target_count > 0)
        {
            if (!context_upload_demag_boundary_corr(
                    *ctx,
                    plan->demag_corr_target_idx,
                    plan->demag_corr_source_idx,
                    plan->demag_corr_tensor,
                    plan->demag_corr_target_count,
                    plan->demag_corr_stencil_size))
            {
                return reinterpret_cast<fullmag_fdm_backend *>(ctx);
            }
        }
    }

    // Periodic boundary conditions (per-axis exchange wrapping)
    ctx->periodic_x = plan->periodic_x != 0;
    ctx->periodic_y = plan->periodic_y != 0;
    ctx->periodic_z = plan->periodic_z != 0;

    if (ctx->has_uniaxial_anisotropy) {
        if (!context_upload_anisotropy_fields(*ctx, plan->ku1_field, plan->ku2_field, ctx->cell_count)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }

    if (ctx->has_cubic_anisotropy) {
        if (!context_upload_cubic_anisotropy_fields(*ctx, plan->kc1_field, plan->kc2_field, plan->kc3_field, ctx->cell_count)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }

    // Precompute Oersted static field for I = 1 A
    if (ctx->has_oersted_cylinder) {
        if (!context_precompute_oersted_field(*ctx)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    } else if (has_oersted_field) {
        if (!context_upload_oersted_field(*ctx, plan->oersted_field_xyz, plan->oersted_field_len)) {
            return reinterpret_cast<fullmag_fdm_backend *>(ctx);
        }
    }

    // Upload initial magnetization
    if (!context_upload_magnetization_f64(
            *ctx, plan->initial_magnetization_xyz,
            plan->initial_magnetization_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (!context_refresh_observables(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (!context_build_workspace_dependency_identity_v1(*ctx, *plan)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Query device info
    context_query_device_info(*ctx);
    context_mark_gpu_workspace_setup_complete(*ctx);
    fullmag_fdm_commit_operator_residency(*ctx);

    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
#else
    (void)plan;
    return nullptr;
#endif
}

int fullmag_fdm_backend_create_time_policy_v2_checked(
    const fullmag_fdm_plan_desc_v2 *plan,
    fullmag_fdm_backend **out_handle)
{
    if (!out_handle) return FULLMAG_FDM_ERR_INVALID;
    *out_handle = nullptr;
    fullmag_fdm_plan_ingestion_v2 *raw_ingestion = nullptr;
    const int abi_status =
        fullmag_fdm_plan_ingestion_v2_create_checked(plan, &raw_ingestion);
    if (abi_status != FULLMAG_FDM_OK) return abi_status;
    std::unique_ptr<fullmag_fdm_plan_ingestion_v2> ingestion(raw_ingestion);
#if FULLMAG_HAS_CUDA
    plan = &plan_ingestion_descriptor(*ingestion);
    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan->base);
    if (!handle) return FULLMAG_FDM_ERR_CUDA;
    *out_handle = handle;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (!ctx->last_error.empty()) return FULLMAG_FDM_OK;

    const auto &policy = plan->time_policy;
    ctx->adaptive_enabled = policy.adaptive_enabled != 0;
    if (!ctx->adaptive_enabled) {
        ctx->fsal_valid = false;
        return FULLMAG_FDM_OK;
    }
    const bool compatible_integrator =
        plan->base.integrator == FULLMAG_FDM_INTEGRATOR_RK23 ||
        plan->base.integrator == FULLMAG_FDM_INTEGRATOR_DP45;
    const bool valid_mode =
        policy.adaptive_tolerance_mode == FULLMAG_FDM_ADAPTIVE_MAX_ERROR ||
        policy.adaptive_tolerance_mode == FULLMAG_FDM_ADAPTIVE_ADVANCED;
    const bool valid_tolerances =
        std::isfinite(policy.adaptive_atol) && policy.adaptive_atol >= 0.0 &&
        std::isfinite(policy.adaptive_rtol) && policy.adaptive_rtol >= 0.0 &&
        (policy.adaptive_atol > 0.0 || policy.adaptive_rtol > 0.0);
    const bool compatible_tolerance_mode =
        (policy.adaptive_tolerance_mode == FULLMAG_FDM_ADAPTIVE_MAX_ERROR &&
         policy.adaptive_atol > 0.0 && policy.adaptive_rtol == 0.0) ||
        (policy.adaptive_tolerance_mode == FULLMAG_FDM_ADAPTIVE_ADVANCED &&
         (policy.adaptive_atol > 0.0 || policy.adaptive_rtol > 0.0));
    const bool valid_bounds =
        std::isfinite(policy.adaptive_dt_min) && policy.adaptive_dt_min > 0.0 &&
        std::isfinite(policy.adaptive_dt_max) &&
        policy.adaptive_dt_max >= policy.adaptive_dt_min;
    const bool valid_controller =
        std::isfinite(policy.adaptive_safety) && policy.adaptive_safety > 0.0 &&
        policy.adaptive_safety <= 1.0 &&
        std::isfinite(policy.adaptive_growth_limit) && policy.adaptive_growth_limit > 1.0 &&
        std::isfinite(policy.adaptive_shrink_limit) && policy.adaptive_shrink_limit > 0.0 &&
        policy.adaptive_shrink_limit < 1.0;
    const bool valid_guards =
        (policy.has_adaptive_max_spin_rotation == 0 ||
         (policy.has_adaptive_max_spin_rotation == 1 &&
          std::isfinite(policy.adaptive_max_spin_rotation) &&
          policy.adaptive_max_spin_rotation > 0.0)) &&
        (policy.has_adaptive_norm_tolerance == 0 ||
         (policy.has_adaptive_norm_tolerance == 1 &&
          std::isfinite(policy.adaptive_norm_tolerance) &&
          policy.adaptive_norm_tolerance > 0.0));
    if (!compatible_integrator || !valid_mode || !valid_tolerances ||
        !compatible_tolerance_mode || !valid_bounds || !valid_controller ||
        !valid_guards)
    {
        ctx->last_error = "invalid complete adaptive timestep policy in fullmag_fdm_plan_desc_v2";
        return FULLMAG_FDM_OK;
    }

    ctx->adaptive_tolerance_mode = policy.adaptive_tolerance_mode;
    ctx->adaptive_atol = policy.adaptive_atol;
    ctx->adaptive_rtol = policy.adaptive_rtol;
    ctx->adaptive_dt_min = policy.adaptive_dt_min;
    ctx->adaptive_dt_max = policy.adaptive_dt_max;
    ctx->adaptive_safety = policy.adaptive_safety;
    ctx->adaptive_growth_limit = policy.adaptive_growth_limit;
    ctx->adaptive_shrink_limit = policy.adaptive_shrink_limit;
    ctx->adaptive_canonical_controller = true;
    ctx->adaptive_has_previous_error = false;
    ctx->adaptive_previous_error = 0.0;
    ctx->adaptive_rejected_attempts = 0;
    ctx->has_adaptive_max_spin_rotation = policy.has_adaptive_max_spin_rotation != 0;
    ctx->adaptive_max_spin_rotation = policy.adaptive_max_spin_rotation;
    ctx->has_adaptive_norm_tolerance = policy.has_adaptive_norm_tolerance != 0;
    ctx->adaptive_norm_tolerance = policy.adaptive_norm_tolerance;
    return FULLMAG_FDM_OK;
#else
    (void)plan;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

fullmag_fdm_backend *fullmag_fdm_backend_create_time_policy_v2(
    const fullmag_fdm_plan_desc_v2 *plan)
{
    fullmag_fdm_backend *handle = nullptr;
    (void)fullmag_fdm_backend_create_time_policy_v2_checked(plan, &handle);
    return handle;
}

fullmag_fdm_backend *fullmag_fdm_backend_create_v2(
    const fullmag_fdm_multilayer_plan_desc_v2 *plan)
{
#if FULLMAG_HAS_CUDA
    if (!plan) return nullptr;

    auto *ctx = new (std::nothrow) Context();
    if (!ctx) return nullptr;
    if (!select_cuda_device_if_requested(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    int device_ordinal = -1;
    if (cudaGetDevice(&device_ordinal) != cudaSuccess) {
        ctx->last_error = "failed to capture selected CUDA device for execution receipt";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    fullmag_fdm_set_device_ordinal(*ctx->execution_receipt, device_ordinal);

    if (plan->kind == FULLMAG_FDM_PLAN_UNIFORM_GRID) {
        ctx->last_error =
            "v2 uniform-grid execution is not implemented; use fullmag_fdm_backend_create";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (plan->kind != FULLMAG_FDM_PLAN_MULTILAYER_CONV) {
        ctx->last_error = "unknown FDM plan kind in v2 plan";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    std::string validation_error;
    if (!validate_multilayer_plan_v2(*plan, validation_error)) {
        ctx->last_error = validation_error;
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    ctx->precision = plan->precision;
    ctx->integrator = plan->integrator;
    if (plan->stats_mode == FULLMAG_FDM_STATS_REQUESTED) {
        ctx->last_error =
            "requested stats mode is unsupported for v2 multilayer handles";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    ctx->stats_mode = plan->stats_mode == FULLMAG_FDM_STATS_NONE
        ? FULLMAG_FDM_STATS_NONE
        : plan->stats_mode == FULLMAG_FDM_STATS_CONTROL
            ? FULLMAG_FDM_STATS_CONTROL
            : FULLMAG_FDM_STATS_FULL;
    ctx->stats_stride = plan->stats_stride == 0 ? 1 : plan->stats_stride;
    ctx->disable_precession = plan->disable_precession != 0;
    ctx->enable_exchange = plan->enable_exchange != 0;
    ctx->enable_demag = plan->enable_demag != 0;
    ctx->has_external_field = plan->has_external_field != 0;
    ctx->external_field[0] = plan->external_field_am[0];
    ctx->external_field[1] = plan->external_field_am[1];
    ctx->external_field[2] = plan->external_field_am[2];
    ctx->has_interfacial_dmi = plan->has_interfacial_dmi != 0;
    ctx->D_interfacial = plan->dmi_D_interfacial;
    ctx->has_bulk_dmi = plan->has_bulk_dmi != 0;
    ctx->D_bulk = plan->dmi_D_bulk;
    if (!context_upload_multilayer_plan_v2(*ctx, *plan)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (!context_create_compute_stream(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    if (!context_prepare_multilayer_fft_workspace_v2(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    ctx->last_error =
        "uploaded " + std::to_string(ctx->multilayer_layers.size())
        + " layers and " + std::to_string(ctx->multilayer_kernels.size())
        + " tensor kernels; prepared all FFT workspaces; native Heun/RK4/fixed-step RK23 timestep with optional demag and layer-local exchange is available for v2 multilayer handles";
    context_mark_gpu_workspace_setup_complete(*ctx);
    fullmag_fdm_commit_operator_residency(*ctx);
    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
#else
    (void)plan;
    return nullptr;
#endif
}

/* ── Step ── */

int fullmag_fdm_backend_set_stats_policy_v1(
    fullmag_fdm_backend *handle,
    const fullmag_fdm_stats_policy_v1 *policy)
{
#if FULLMAG_HAS_CUDA
    if (handle == nullptr || policy == nullptr) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (policy->abi_version != FULLMAG_FDM_STATS_POLICY_ABI_V1 ||
        policy->struct_size != sizeof(fullmag_fdm_stats_policy_v1))
    {
        ctx->last_error = "stats_policy_v1_abi_mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (ctx->accepted_step_pending) {
        ctx->last_error = "stats_policy_change_during_step_transaction";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (reject_step_transaction_mutation(*ctx, "stats_policy_change")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if ((policy->quantity_mask & ~FULLMAG_FDM_STATS_QUANTITY_ALL) != 0) {
        ctx->last_error = "stats_policy_v1_unknown_quantity_mask";
        return FULLMAG_FDM_ERR_INVALID;
    }

    uint64_t resolved_mask = 0;
    switch (policy->mode) {
    case FULLMAG_FDM_STATS_FULL:
        if (policy->quantity_mask != 0 &&
            policy->quantity_mask != FULLMAG_FDM_STATS_QUANTITY_ALL)
        {
            ctx->last_error = "stats_policy_v1_full_requires_all_quantities";
            return FULLMAG_FDM_ERR_INVALID;
        }
        resolved_mask = FULLMAG_FDM_STATS_QUANTITY_ALL;
        break;
    case FULLMAG_FDM_STATS_NONE:
        if (policy->quantity_mask != 0) {
            ctx->last_error = "stats_policy_v1_none_requires_empty_mask";
            return FULLMAG_FDM_ERR_INVALID;
        }
        break;
    case FULLMAG_FDM_STATS_CONTROL:
        if (policy->quantity_mask != 0 &&
            policy->quantity_mask != FULLMAG_FDM_STATS_QUANTITY_CONTROL)
        {
            ctx->last_error = "stats_policy_v1_control_requires_control_mask";
            return FULLMAG_FDM_ERR_INVALID;
        }
        resolved_mask = FULLMAG_FDM_STATS_QUANTITY_CONTROL;
        break;
    case FULLMAG_FDM_STATS_REQUESTED:
        if (ctx->has_multilayer_plan_v2) {
            ctx->last_error = "stats_policy_v1_requested_multilayer_unsupported";
            return FULLMAG_FDM_ERR_INVALID;
        }
        if (policy->quantity_mask == 0) {
            ctx->last_error = "stats_policy_v1_requested_requires_nonempty_mask";
            return FULLMAG_FDM_ERR_INVALID;
        }
        resolved_mask = policy->quantity_mask;
        break;
    default:
        ctx->last_error = "stats_policy_v1_unknown_mode";
        return FULLMAG_FDM_ERR_INVALID;
    }

    ctx->stats_mode = policy->mode;
    ctx->stats_stride = policy->stride == 0 ? 1 : policy->stride;
    ctx->stats_quantity_mask = resolved_mask;
    fullmag_fdm_set_operator_device_requirement(
        *ctx->execution_receipt,
        FULLMAG_FDM_OPERATOR_REDUCTION,
        ctx->adaptive_enabled || ctx->stats_mode == FULLMAG_FDM_STATS_FULL);
    ctx->endpoint_field_cache.stats_valid = false;
    ctx->endpoint_field_cache.stats_quantity_mask = 0;
    ctx->last_error.clear();
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)policy;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_step(
    fullmag_fdm_backend    *handle,
    double                  dt_seconds,
    fullmag_fdm_step_stats *out_stats)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_stats) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (dt_seconds <= 0.0) {
        ctx->last_error = "FDM step requires dt_seconds > 0";
        return FULLMAG_FDM_ERR_INVALID;
    }
    GpuWorkspaceStepAccountingGuard workspace_step_accounting(*ctx);
    fullmag_fdm_step_stats trial_stats{};
    // A rejected or failed attempt is retryable. Its diagnostic remains
    // observable until the next explicit public step begins, but must not
    // poison that next transaction.
    ctx->last_error.clear();
    ctx->step_interrupted = false;
    ctx->adaptive_rejected_attempts = 0;
    ctx->adaptive_attempt_trace_count = 0;
    fullmag_fdm_reset_hot_loop_audit(*ctx);
    context_begin_endpoint_step_accounting(*ctx);
    ReceiptSolverPhaseGuard receipt_solver_phase(*ctx);
    if (ctx->has_multilayer_plan_v2) {
        if (ctx->gpu_transport_rhs.active) {
            ctx->last_error =
                "spin transport is unsupported for v2 multilayer handles";
            return FULLMAG_FDM_ERR_INVALID;
        }
        if (ctx->integrator != FULLMAG_FDM_INTEGRATOR_HEUN &&
            ctx->integrator != FULLMAG_FDM_INTEGRATOR_RK4 &&
            ctx->integrator != FULLMAG_FDM_INTEGRATOR_RK23)
        {
            ctx->last_error =
                "native v2 multilayer timestep currently supports only Heun, RK4, and fixed-step RK23 integrators";
            return FULLMAG_FDM_ERR_INVALID;
        }

        return execute_multilayer_step_transaction(
            *ctx, dt_seconds, trial_stats, *out_stats, receipt_solver_phase);
    }

    return execute_single_grid_step_transaction(
        *ctx, dt_seconds, trial_stats, *out_stats, receipt_solver_phase);
#else
    (void)handle; (void)dt_seconds; (void)out_stats;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_step_adaptive_batch_v1(
    fullmag_fdm_backend *handle,
    double initial_dt_seconds,
    double target_time_seconds,
    uint32_t max_steps,
    fullmag_fdm_adaptive_batch_step_v1 *out_steps,
    uint32_t capacity,
    uint32_t *out_count)
{
#if FULLMAG_HAS_CUDA
    if (out_count != nullptr) *out_count = 0;
    if (handle == nullptr || out_steps == nullptr || out_count == nullptr ||
        !std::isfinite(initial_dt_seconds) || initial_dt_seconds <= 0.0 ||
        !std::isfinite(target_time_seconds) || max_steps == 0 ||
        max_steps > FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1 ||
        capacity < max_steps) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (ctx->has_multilayer_plan_v2 || !ctx->adaptive_enabled ||
        ctx->stats_mode == FULLMAG_FDM_STATS_FULL ||
        (ctx->integrator != FULLMAG_FDM_INTEGRATOR_RK23 &&
         ctx->integrator != FULLMAG_FDM_INTEGRATOR_DP45) ||
        !(target_time_seconds > ctx->current_time)) {
        ctx->last_error =
            "adaptive_batch_v1_requires_nonfull_stats_single_grid_rk23_or_rk45";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!context_adaptive_step_graph_configuration_supported(*ctx)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (poll_interrupt(*ctx)) return FULLMAG_FDM_ERR_INTERRUPTED;

    GpuWorkspaceStepAccountingGuard workspace_step_accounting(*ctx);
    ctx->last_error.clear();
    context_record_adaptive_execution_counter(
        *ctx, ctx->adaptive_public_batch_call_count);
    ctx->step_interrupted = false;
    ctx->adaptive_rejected_attempts = 0;
    ctx->adaptive_attempt_trace_count = 0;
    ctx->accepted_step_pending = false;
    ctx->fsal_pending = false;
    ctx->step_fsal_reused = false;
    fullmag_fdm_reset_hot_loop_audit(*ctx);
    ReceiptSolverPhaseGuard receipt_solver_phase(*ctx);
    if (!context_begin_step_transaction_attempt(*ctx)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!context_capture_pre_step_state(*ctx)) {
        (void)rollback_step_transaction(*ctx);
        return FULLMAG_FDM_ERR_CUDA;
    }

    std::array<AdaptiveDeviceControl,
               FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1> accepted{};
    uint32_t accepted_count = 0;
    bool launched = false;
    if (ctx->precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        launched = ctx->integrator == FULLMAG_FDM_INTEGRATOR_RK23
            ? launch_rk23_adaptive_batch_fp64(
                  *ctx, initial_dt_seconds, target_time_seconds, max_steps,
                  accepted.data(), static_cast<uint32_t>(accepted.size()),
                  accepted_count)
            : launch_dp45_adaptive_batch_fp64(
                  *ctx, initial_dt_seconds, target_time_seconds, max_steps,
                  accepted.data(), static_cast<uint32_t>(accepted.size()),
                  accepted_count);
    } else {
        launched = ctx->integrator == FULLMAG_FDM_INTEGRATOR_RK23
            ? launch_rk23_adaptive_batch_fp32(
                  *ctx, initial_dt_seconds, target_time_seconds, max_steps,
                  accepted.data(), static_cast<uint32_t>(accepted.size()),
                  accepted_count)
            : launch_dp45_adaptive_batch_fp32(
                  *ctx, initial_dt_seconds, target_time_seconds, max_steps,
                  accepted.data(), static_cast<uint32_t>(accepted.size()),
                  accepted_count);
    }
    if (!launched || accepted_count == 0 || !ctx->last_error.empty()) {
        const bool dt_min_exhausted = ctx->last_error == "dt_min_exhausted";
        (void)rollback_step_transaction(*ctx);
        return dt_min_exhausted
            ? FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED : FULLMAG_FDM_ERR_CUDA;
    }
    if (poll_interrupt(*ctx)) {
        (void)rollback_step_transaction(*ctx);
        return FULLMAG_FDM_ERR_INTERRUPTED;
    }

    std::array<fullmag_fdm_adaptive_batch_step_v1,
               FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1> published{};
    for (uint32_t index = 0; index < accepted_count; ++index) {
        const auto &control = accepted[index];
        context_record_adaptive_numerics_terminal(
            *ctx,
            control,
            ctx->integrator == FULLMAG_FDM_INTEGRATOR_DP45 ? 4 : 2);
        if (index + 1 == accepted_count) {
            context_stage_fsal_accepted_step(*ctx, control.dt_attempt);
        } else {
            context_stage_accepted_step(*ctx, control.dt_attempt);
        }
        context_commit_accepted_step(*ctx);
        auto &record = published[index];
        record.abi_version = FULLMAG_FDM_ADAPTIVE_BATCH_STEP_ABI_V1;
        record.struct_size = sizeof(record);
        record.decision = FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED;
        record.reason = static_cast<fullmag_fdm_adaptive_attempt_reason_v1>(
            control.reason);
        record.step = ctx->step_count;
        record.time_seconds = ctx->current_time;
        record.dt_seconds = control.dt_attempt;
        record.suggested_next_dt_seconds = control.dt_candidate;
        record.normalized_error = control.error;
        record.rejected_attempts = control.next_rejected_attempts;
    }
    context_publish_pending_fsal(*ctx);
    context_discard_pre_step_state(*ctx);
    context_invalidate_observables(*ctx);
    fullmag_fdm_step_stats audit_stats{};
    fullmag_fdm_publish_hot_loop_audit(*ctx, &audit_stats);
    fullmag_fdm_note_operator_device_execution(
        *ctx, FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR);
    receipt_solver_phase.commit();
    std::memcpy(
        out_steps,
        published.data(),
        accepted_count * sizeof(fullmag_fdm_adaptive_batch_step_v1));
    *out_count = accepted_count;
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)initial_dt_seconds;
    (void)target_time_seconds;
    (void)max_steps;
    (void)out_steps;
    (void)capacity;
    if (out_count != nullptr) *out_count = 0;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_context_bind_gpu_transport_v1(
    fullmag_fdm_backend *handle,
    const fullmag_fdm_gpu_transport_llg_binding_v1 *binding)
{
#if FULLMAG_HAS_CUDA
    if (handle == nullptr || binding == nullptr) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "gpu_transport_bind")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (ctx->has_multilayer_plan_v2) {
        ctx->last_error =
            "spin transport is unsupported for v2 multilayer handles";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!context_bind_gpu_transport_rhs(*ctx, *binding)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    context_note_transport_revision_change(*ctx);
    fullmag_fdm_commit_operator_residency(*ctx);
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)binding;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

extern "C" int fullmag_fdm_test_force_gpu_transport_adaptive_retry(
    fullmag_fdm_backend *handle)
{
    if (handle == nullptr) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (!ctx->gpu_transport_rhs.active || !ctx->adaptive_enabled)
        return FULLMAG_FDM_ERR_INVALID;
    ctx->gpu_transport_test_force_adaptive_retry = true;
    return FULLMAG_FDM_OK;
}

extern "C" int fullmag_fdm_test_inject_step_transaction_failure_once(
    fullmag_fdm_backend *handle,
    uint32_t phase)
{
#if FULLMAG_HAS_CUDA
    if (handle == nullptr ||
        phase < static_cast<uint32_t>(StepTransactionPhase::Integrator) ||
        phase > static_cast<uint32_t>(StepTransactionPhase::TransportCommit)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);
    ctx->step_transaction_test_failure_phase = phase;
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)phase;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_context_unbind_gpu_transport_v1(fullmag_fdm_backend *handle) {
#if FULLMAG_HAS_CUDA
    if (handle == nullptr) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "gpu_transport_unbind")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!context_unbind_gpu_transport_rhs(*ctx)) return FULLMAG_FDM_ERR_INVALID;
    context_note_transport_revision_change(*ctx);
    fullmag_fdm_commit_operator_residency(*ctx);
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_set_interrupt_poll(
    fullmag_fdm_backend *handle,
    fullmag_fdm_interrupt_poll_fn poll_fn,
    void *user_data)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    ctx->interrupt_poll = poll_fn;
    ctx->interrupt_poll_user_data = user_data;
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)poll_fn; (void)user_data;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Copy field ── */

int fullmag_fdm_backend_copy_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (out_len != ctx->cell_count * 3) {
        ctx->last_error = "out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_f64(*ctx, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_field_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    float                 *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (out_len != ctx->cell_count * 3) {
        ctx->last_error = "out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_f32(*ctx, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_scalar_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_values,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_values) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (out_len != ctx->cell_count) {
        ctx->last_error = "scalar_out_len_mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!context_download_scalar_f64(*ctx, observable, out_values, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_values; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_scalar_field_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    float                 *out_values,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_values) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (out_len != ctx->cell_count) {
        ctx->last_error = "scalar_out_len_mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!context_download_scalar_f32(*ctx, observable, out_values, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_values; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_layer_field_f64(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    fullmag_fdm_observable observable,
    double                *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!context_download_layer_field_f64(*ctx, layer_index, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)layer_index; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_layer_field_f32(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    fullmag_fdm_observable observable,
    float                 *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!context_download_layer_field_f32(*ctx, layer_index, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)layer_index; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_field_preview_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride,
    double                *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0
        || z_stride == 0)
    {
        return FULLMAG_FDM_ERR_INVALID;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);

    uint64_t expected_len =
        static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz * 3;
    if (out_len != expected_len) {
        ctx->last_error = "preview out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_preview_f64(
            *ctx,
            observable,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            out_xyz,
            out_len))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)observable;
    (void)preview_nx;
    (void)preview_ny;
    (void)preview_nz;
    (void)z_origin;
    (void)z_stride;
    (void)out_xyz;
    (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_copy_field_preview_f32(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride,
    float                 *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0
        || z_stride == 0)
    {
        return FULLMAG_FDM_ERR_INVALID;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);

    uint64_t expected_len =
        static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz * 3;
    if (out_len != expected_len) {
        ctx->last_error = "preview out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_preview_f32(
            *ctx,
            observable,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            out_xyz,
            out_len))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)observable;
    (void)preview_nx;
    (void)preview_ny;
    (void)preview_nz;
    (void)z_origin;
    (void)z_stride;
    (void)out_xyz;
    (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

fullmag_fdm_field_snapshot *fullmag_fdm_backend_begin_field_snapshot(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return nullptr;
    auto *ctx = reinterpret_cast<Context *>(handle);
    auto *snapshot = context_begin_async_field_snapshot(*ctx, observable);
    return reinterpret_cast<fullmag_fdm_field_snapshot *>(snapshot);
#else
    (void)handle;
    (void)observable;
    return nullptr;
#endif
}

fullmag_fdm_preview_snapshot *fullmag_fdm_backend_begin_preview_snapshot(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    uint32_t               preview_nx,
    uint32_t               preview_ny,
    uint32_t               preview_nz,
    uint32_t               z_origin,
    uint32_t               z_stride)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return nullptr;
    auto *ctx = reinterpret_cast<Context *>(handle);
    auto *snapshot = context_begin_async_preview_snapshot(
            *ctx,
            observable,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride);
    return reinterpret_cast<fullmag_fdm_preview_snapshot *>(snapshot);
#else
    (void)handle;
    (void)observable;
    (void)preview_nx;
    (void)preview_ny;
    (void)preview_nz;
    (void)z_origin;
    (void)z_stride;
    return nullptr;
#endif
}

int fullmag_fdm_field_snapshot_wait(
    fullmag_fdm_field_snapshot *snapshot,
    const void               **out_data,
    uint64_t                  *out_len_bytes,
    fullmag_fdm_snapshot_desc *out_desc)
{
#if FULLMAG_HAS_CUDA
    if (!snapshot || !out_data || !out_len_bytes || !out_desc) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::string error;
    const void *data = nullptr;
    uint64_t len_bytes = 0;
    fullmag_fdm_snapshot_desc desc{};
    if (!context_wait_async_field_snapshot(
            *reinterpret_cast<AsyncFieldSnapshot *>(snapshot),
            &data,
            len_bytes,
            desc,
            error))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }
    *out_data = data;
    *out_len_bytes = len_bytes;
    *out_desc = desc;
    return FULLMAG_FDM_OK;
#else
    (void)snapshot;
    (void)out_data;
    (void)out_len_bytes;
    (void)out_desc;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_preview_snapshot_wait(
    fullmag_fdm_preview_snapshot *snapshot,
    const void                 **out_data,
    uint64_t                    *out_len_bytes,
    fullmag_fdm_snapshot_desc   *out_desc)
{
#if FULLMAG_HAS_CUDA
    if (!snapshot || !out_data || !out_len_bytes || !out_desc) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    std::string error;
    const void *data = nullptr;
    uint64_t len_bytes = 0;
    fullmag_fdm_snapshot_desc desc{};
    if (!context_wait_async_preview_snapshot(
            *reinterpret_cast<AsyncPreviewSnapshot *>(snapshot),
            &data,
            len_bytes,
            desc,
            error))
    {
        return FULLMAG_FDM_ERR_CUDA;
    }
    *out_data = data;
    *out_len_bytes = len_bytes;
    *out_desc = desc;
    return FULLMAG_FDM_OK;
#else
    (void)snapshot;
    (void)out_data;
    (void)out_len_bytes;
    (void)out_desc;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

void fullmag_fdm_field_snapshot_destroy(
    fullmag_fdm_field_snapshot *snapshot)
{
#if FULLMAG_HAS_CUDA
    context_destroy_async_field_snapshot(
        reinterpret_cast<AsyncFieldSnapshot *>(snapshot));
#else
    (void)snapshot;
#endif
}

void fullmag_fdm_preview_snapshot_destroy(
    fullmag_fdm_preview_snapshot *snapshot)
{
#if FULLMAG_HAS_CUDA
    context_destroy_async_preview_snapshot(
        reinterpret_cast<AsyncPreviewSnapshot *>(snapshot));
#else
    (void)snapshot;
#endif
}

int fullmag_fdm_backend_upload_magnetization_f64(
    fullmag_fdm_backend   *handle,
    const double          *m_xyz,
    uint64_t               len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !m_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "magnetization_upload")) {
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (len != ctx->cell_count * 3) {
        ctx->last_error = "magnetization length mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_upload_magnetization_f64(*ctx, m_xyz, len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)m_xyz; (void)len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_upload_magnetization_f32(
    fullmag_fdm_backend   *handle,
    const float           *m_xyz,
    uint64_t               len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !m_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "magnetization_upload")) {
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (len != ctx->cell_count * 3) {
        ctx->last_error = "magnetization length mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_upload_magnetization_f32(*ctx, m_xyz, len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)m_xyz; (void)len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_query_size_v1(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_required_bytes) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_query_size_v1(*ctx, *out_required_bytes);
#else
    (void)handle; (void)out_required_bytes;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_export_v1(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v1 *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !destination || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_export_v1(
        *ctx, destination, exact_capacity, *out_info);
#else
    (void)handle; (void)destination; (void)exact_capacity; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_import_v1(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v1 *expected_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !source || !expected_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "checkpoint_import")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    return context_llg_checkpoint_import_v1(
        *ctx, source, exact_bytes, *expected_info);
#else
    (void)handle; (void)source; (void)exact_bytes; (void)expected_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_upload_layer_magnetization_f64(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    const double          *m_xyz,
    uint64_t               len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !m_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "layer_magnetization_upload")) {
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_upload_layer_magnetization_f64(*ctx, layer_index, m_xyz, len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)layer_index; (void)m_xyz; (void)len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_upload_layer_magnetization_f32(
    fullmag_fdm_backend   *handle,
    uint32_t               layer_index,
    const float           *m_xyz,
    uint64_t               len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !m_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "layer_magnetization_upload")) {
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_upload_layer_magnetization_f32(*ctx, layer_index, m_xyz, len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)layer_index; (void)m_xyz; (void)len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_refresh_multilayer_demag(
    fullmag_fdm_backend *handle)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!ctx->has_multilayer_plan_v2) {
        ctx->last_error =
            "explicit multilayer demag refresh requires a staged v2 multilayer plan";
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!refresh_multilayer_demag(*ctx)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_refresh_observables(
    fullmag_fdm_backend *handle)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!context_refresh_observables(*ctx)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_refresh_demag_observable(
    fullmag_fdm_backend *handle)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!context_refresh_demag_observable(*ctx)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_snapshot_stats(
    fullmag_fdm_backend *handle,
    fullmag_fdm_step_stats *out_stats)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_stats) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    ++ctx->endpoint_field_cache.stats_snapshot_request_count;

    if (ctx->has_multilayer_plan_v2) {
        std::memset(out_stats, 0, sizeof(*out_stats));
        out_stats->step = ctx->step_count;
        out_stats->time_seconds = ctx->current_time;
        out_stats->dt_seconds = ctx->current_dt;
        fullmag_fdm_publish_hot_loop_audit(*ctx, out_stats);
        fullmag_fdm_publish_multilayer_demag_stage_counters(*ctx, out_stats);
        return FULLMAG_FDM_OK;
    }

    if (!context_fill_current_stats(*ctx, out_stats)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)out_stats;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Device info ── */

int fullmag_fdm_backend_get_device_info(
    fullmag_fdm_backend     *handle,
    fullmag_fdm_device_info *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!ctx->device_info_valid) {
        if (!context_query_device_info(*ctx)) {
            return FULLMAG_FDM_ERR_CUDA;
        }
    }

    *out_info = ctx->device_info_cache;
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_query_size_v2(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_required_bytes) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_query_size_v2(*ctx, *out_required_bytes);
#else
    (void)handle; (void)out_required_bytes;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_export_v2(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v2 *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !destination || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_export_v2(
        *ctx, destination, exact_capacity, *out_info);
#else
    (void)handle; (void)destination; (void)exact_capacity; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_import_v2(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v2 *expected_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !source || !expected_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "checkpoint_import")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    return context_llg_checkpoint_import_v2(
        *ctx, source, exact_bytes, *expected_info);
#else
    (void)handle; (void)source; (void)exact_bytes; (void)expected_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_set_checkpoint_execution_identity_v3(
    fullmag_fdm_backend *handle,
    const fullmag_fdm_checkpoint_execution_identity_v3 *identity)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !identity) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "checkpoint_execution_identity_change")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    return context_set_checkpoint_execution_identity_v3(*ctx, *identity)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    (void)handle; (void)identity;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_workspace_dependency_identity_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_workspace_dependency_identity_v1 *out_identity)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_identity) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (out_identity->abi_version !=
            FULLMAG_FDM_WORKSPACE_DEPENDENCY_IDENTITY_ABI_V1 ||
        out_identity->struct_size != sizeof(*out_identity) ||
        !ctx->workspace_dependency_identity_v1_valid) {
        ctx->last_error = "workspace dependency identity v1 is unavailable or ABI-incompatible";
        return FULLMAG_FDM_ERR_ABI;
    }
    *out_identity = ctx->workspace_dependency_identity_v1;
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)out_identity;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_query_size_v3(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_required_bytes) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_query_size_v3(*ctx, *out_required_bytes);
#else
    (void)handle; (void)out_required_bytes;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_export_v3(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v3 *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !destination || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_export_v3(
        *ctx, destination, exact_capacity, *out_info);
#else
    (void)handle; (void)destination; (void)exact_capacity; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_import_v3(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v3 *expected_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !source || !expected_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "checkpoint_import")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    return context_llg_checkpoint_import_v3(
        *ctx, source, exact_bytes, *expected_info);
#else
    (void)handle; (void)source; (void)exact_bytes; (void)expected_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_query_size_v4(
    fullmag_fdm_backend *handle,
    uint64_t *out_required_bytes)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_required_bytes) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_query_size_v4(*ctx, *out_required_bytes);
#else
    (void)handle; (void)out_required_bytes;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_export_v4(
    fullmag_fdm_backend *handle,
    void *destination,
    uint64_t exact_capacity,
    fullmag_fdm_llg_checkpoint_info_v4 *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !destination || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_llg_checkpoint_export_v4(
        *ctx, destination, exact_capacity, *out_info);
#else
    (void)handle; (void)destination; (void)exact_capacity; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_llg_checkpoint_import_v4(
    fullmag_fdm_backend *handle,
    const void *source,
    uint64_t exact_bytes,
    const fullmag_fdm_llg_checkpoint_info_v4 *expected_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !source || !expected_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "checkpoint_import")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    return context_llg_checkpoint_import_v4(
        *ctx, source, exact_bytes, *expected_info);
#else
    (void)handle; (void)source; (void)exact_bytes; (void)expected_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_fsal_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_fsal_telemetry_v1 *out_telemetry)
{
    if (handle == nullptr || out_telemetry == nullptr) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context*>(handle);
    return context_get_fsal_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
}

int fullmag_fdm_backend_copy_adaptive_attempts_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_adaptive_attempt_v1 *out_attempts,
    uint32_t capacity,
    uint32_t *out_count)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_count) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    const uint32_t count = ctx->adaptive_attempt_trace_count;
    if (out_attempts == nullptr && capacity == 0) {
        *out_count = count;
        return FULLMAG_FDM_OK;
    }
    if (capacity < count || (count != 0 && out_attempts == nullptr)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (count != 0) {
        const cudaError_t err = cudaMemcpy(
            out_attempts,
            ctx->adaptive_attempt_trace_device,
            static_cast<size_t>(count) * sizeof(*out_attempts),
            cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(*ctx, "cudaMemcpy(adaptive_attempt_trace)", err);
            return FULLMAG_FDM_ERR_CUDA;
        }
    }
    *out_count = count;
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)out_attempts;
    (void)capacity;
    (void)out_count;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_fsal_telemetry_v2(
    fullmag_fdm_backend *handle,
    fullmag_fdm_fsal_telemetry_v2 *out_telemetry)
{
    if (handle == nullptr || out_telemetry == nullptr) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_get_fsal_telemetry_v2(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
}

int fullmag_fdm_backend_get_step_transaction_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_step_transaction_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_get_step_transaction_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_endpoint_cache_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_get_endpoint_cache_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_adaptive_execution_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_get_adaptive_execution_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_precision_policy_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_precision_policy_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    const auto *ctx = reinterpret_cast<const Context *>(handle);
    return context_get_precision_policy_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_local_pipeline_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_local_pipeline_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return context_get_local_pipeline_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_gpu_workspace_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    const auto *ctx = reinterpret_cast<const Context *>(handle);
    return context_get_gpu_workspace_telemetry_v1(*ctx, out_telemetry)
        ? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_get_adaptive_numerics_telemetry_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_adaptive_numerics_telemetry_v1 *out_telemetry)
{
    if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;
#if FULLMAG_HAS_CUDA
    if (out_telemetry->abi_version !=
            FULLMAG_FDM_ADAPTIVE_NUMERICS_TELEMETRY_ABI_V1 ||
        out_telemetry->struct_size != sizeof(*out_telemetry)) {
        return FULLMAG_FDM_ERR_ABI;
    }
    const auto *ctx = reinterpret_cast<const Context *>(handle);
    fullmag_fdm_adaptive_numerics_telemetry_v1 result{};
    result.abi_version = FULLMAG_FDM_ADAPTIVE_NUMERICS_TELEMETRY_ABI_V1;
    result.struct_size = sizeof(result);
    result.embedded_error_semantics =
        FULLMAG_FDM_EMBEDDED_ERROR_PRE_PROJECTION_DIFFERENCE;
    result.norm_defect_semantics =
        FULLMAG_FDM_NORM_DEFECT_POST_PROJECTION_ABS_UNIT;
    result.spin_rotation_semantics =
        FULLMAG_FDM_SPIN_ROTATION_ATTEMPT_GEODESIC_RADIANS;
    result.accounting_valid =
        ctx->adaptive_numerics_accounting_valid ? 1U : 0U;
    result.terminal_observation_count =
        ctx->adaptive_numerics_terminal_observation_count;
    result.decision_comparison_count =
        ctx->adaptive_numerics_decision_comparison_count;
    result.decision_divergence_count =
        ctx->adaptive_numerics_decision_divergence_count;
    result.last_terminal_normalized_error =
        ctx->adaptive_numerics_last_terminal_error;
    result.last_terminal_max_norm_defect =
        ctx->adaptive_numerics_last_terminal_norm_defect;
    result.last_terminal_max_spin_rotation_radians =
        ctx->adaptive_numerics_last_terminal_spin_rotation;
    result.max_attempt_normalized_error =
        ctx->adaptive_numerics_max_attempt_error;
    result.max_attempt_norm_defect =
        ctx->adaptive_numerics_max_attempt_norm_defect;
    result.max_attempt_spin_rotation_radians =
        ctx->adaptive_numerics_max_attempt_spin_rotation;
    *out_telemetry = result;
    return FULLMAG_FDM_OK;
#else
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_execution_receipt_v1(
    fullmag_fdm_backend *handle,
    fullmag_fdm_execution_receipt_v1 *out_receipt)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_receipt) return FULLMAG_FDM_ERR_INVALID;
    if (!fullmag_fdm_execution_receipt_request_valid(*out_receipt)) {
        return FULLMAG_FDM_ERR_ABI;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);
    const auto receipt = fullmag_fdm_make_execution_receipt(*ctx);
    *out_receipt = receipt;
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)out_receipt;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_execution_receipt_v2(
    fullmag_fdm_backend *handle,
    fullmag_fdm_execution_receipt_v2 *out_receipt)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_receipt) return FULLMAG_FDM_ERR_INVALID;
    if (!fullmag_fdm_execution_receipt_request_valid(*out_receipt)) {
        return FULLMAG_FDM_ERR_ABI;
    }
    auto *ctx = reinterpret_cast<Context *>(handle);
    const auto receipt = fullmag_fdm_make_execution_receipt_v2(*ctx);
    *out_receipt = receipt;
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)out_receipt;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

extern "C" int fullmag_fdm_test_record_residency_violation_v1(
    fullmag_fdm_backend *handle,
    uint32_t violation_kind,
    uint64_t bytes)
{
#if FULLMAG_HAS_CUDA
    if (!handle) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    switch (violation_kind) {
        case 1:
            if (bytes == 0) return FULLMAG_FDM_ERR_INVALID;
            fullmag_fdm_record_hot_loop_full_vector_h2d(*ctx, bytes);
            return FULLMAG_FDM_OK;
        case 2:
            if (bytes == 0) return FULLMAG_FDM_ERR_INVALID;
            fullmag_fdm_record_hot_loop_full_vector_d2h(*ctx, bytes);
            return FULLMAG_FDM_OK;
        case 3:
            if (bytes != 0) return FULLMAG_FDM_ERR_INVALID;
            fullmag_fdm_record_hot_loop_host_compute(*ctx);
            return FULLMAG_FDM_OK;
        default:
            return FULLMAG_FDM_ERR_INVALID;
    }
#else
    (void)handle;
    (void)violation_kind;
    (void)bytes;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

int fullmag_fdm_backend_set_static_external_field_f64(
    fullmag_fdm_backend *handle,
    const double *field_xyz,
    uint64_t field_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !field_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (reject_step_transaction_mutation(*ctx, "static_external_field_change")) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    const bool extends_setup_workspace =
        ctx->h_oe_static.x == nullptr && ctx->h_oe_static.y == nullptr &&
        ctx->h_oe_static.z == nullptr;
    const uint64_t allocation_count_before =
        ctx->gpu_workspace_total_device_allocation_count;
    const uint64_t allocation_bytes_before =
        ctx->gpu_workspace_total_device_allocation_bytes;
    if (!context_mark_static_external_field_profile(*ctx, field_xyz, field_len)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (extends_setup_workspace && ctx->gpu_workspace_setup_complete) {
        uint64_t expected_bytes = 0;
        const uint64_t scalar_bytes =
            ctx->precision == FULLMAG_FDM_PRECISION_DOUBLE
                ? sizeof(double) : sizeof(float);
        const bool baseline_was_current =
            allocation_count_before ==
                ctx->gpu_workspace_setup_device_allocation_count &&
            allocation_bytes_before ==
                ctx->gpu_workspace_setup_device_allocation_bytes;
        const bool expected_extension =
            ctx->gpu_workspace_total_device_allocation_count -
                    allocation_count_before ==
                3 &&
            fullmag_fdm_checked_vector_bytes(
                ctx->cell_count, scalar_bytes, expected_bytes) &&
            ctx->gpu_workspace_total_device_allocation_bytes -
                    allocation_bytes_before ==
                expected_bytes;
        if (!baseline_was_current || !expected_extension ||
            ctx->gpu_workspace_observed_step_count != 0) {
            ctx->gpu_workspace_accounting_valid = false;
            ctx->last_error =
                "static external field profile workspace extension violated setup accounting";
            return FULLMAG_FDM_ERR_INVALID;
        }
        ctx->gpu_workspace_setup_device_allocation_count =
            ctx->gpu_workspace_total_device_allocation_count;
        ctx->gpu_workspace_setup_device_allocation_bytes =
            ctx->gpu_workspace_total_device_allocation_bytes;
    }
    context_note_field_source_revision_change(*ctx);
    fullmag_fdm_commit_operator_residency(*ctx);
    return FULLMAG_FDM_OK;
#else
    (void)handle;
    (void)field_xyz;
    (void)field_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Error ── */

const char *fullmag_fdm_backend_last_error(fullmag_fdm_backend *handle) {
    if (!handle) return "null handle";
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return ctx->last_error.empty() ? nullptr : ctx->last_error.c_str();
#else
    return "CUDA backend not compiled";
#endif
}

/* ── Destroy ── */

void fullmag_fdm_backend_destroy(fullmag_fdm_backend *handle) {
    if (!handle) return;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (ctx->gpu_transport_rhs.active && !context_unbind_gpu_transport_rhs(*ctx)) {
        return;
    }
    context_free_device(*ctx);
    delete ctx;
#endif
}
