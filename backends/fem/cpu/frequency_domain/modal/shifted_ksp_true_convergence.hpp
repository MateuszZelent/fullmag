#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <new>

#include <petscksp.h>

namespace fullmag::fem::frequency_domain::detail {

using FloquetCandidateOperatorDiagnosticBegin = void (*)(
    void *user_context,
    PetscInt iteration,
    std::uint64_t callback_ordinal) noexcept;
using FloquetCandidateOperatorDiagnosticCapture = PetscErrorCode (*)(
    void *user_context,
    PetscInt iteration,
    std::uint64_t callback_ordinal,
    KSP live_ksp,
    Mat shifted_operator,
    Vec shifted_rhs,
    Vec candidate_solution,
    Vec shifted_operator_action) noexcept;
using FloquetCandidateOperatorDiagnosticDestroy = PetscErrorCode (*)(
    void **user_context);

struct FloquetCandidateDiagnosticSetupTransaction {
    PetscErrorCode push_error = PETSC_SUCCESS;
    PetscErrorCode setup_error = PETSC_SUCCESS;
    PetscErrorCode cleanup_error = PETSC_SUCCESS;
    PetscErrorCode pop_error = PETSC_SUCCESS;
    PetscErrorCode fatal_error = PETSC_SUCCESS;
};

template <typename Push, typename Setup, typename Cleanup, typename Pop>
inline FloquetCandidateDiagnosticSetupTransaction
run_floquet_candidate_diagnostic_setup_transaction(
    Push push,
    Setup setup,
    Cleanup cleanup,
    Pop pop)
{
    FloquetCandidateDiagnosticSetupTransaction result{};
    result.push_error = push();
    if (result.push_error != PETSC_SUCCESS) {
        result.fatal_error = result.push_error;
        return result;
    }
    result.setup_error = setup();
    if (result.setup_error != PETSC_SUCCESS) {
        result.cleanup_error = cleanup();
    }
    // Pop even after cleanup failure so the global PETSc handler stack is
    // restored. The first cleanup error remains authoritative over a later
    // handler-pop failure.
    result.pop_error = pop();
    result.fatal_error = result.cleanup_error != PETSC_SUCCESS
        ? result.cleanup_error
        : result.pop_error;
    return result;
}

struct FloquetCandidateDiagnosticCaptureTransaction {
    PetscErrorCode push_error = PETSC_SUCCESS;
    PetscErrorCode capture_error = PETSC_SUCCESS;
    PetscErrorCode pop_error = PETSC_SUCCESS;
    PetscErrorCode fatal_error = PETSC_SUCCESS;
};

template <typename Push, typename Capture, typename Pop>
inline FloquetCandidateDiagnosticCaptureTransaction
run_floquet_candidate_diagnostic_capture_transaction(
    Push push,
    Capture capture,
    Pop pop)
{
    FloquetCandidateDiagnosticCaptureTransaction result{};
    result.push_error = push();
    if (result.push_error != PETSC_SUCCESS) {
        result.fatal_error = result.push_error;
        return result;
    }
    result.capture_error = capture();
    // Measurement failure remains caller-owned; only stack restoration is fatal.
    result.pop_error = pop();
    result.fatal_error = result.pop_error;
    return result;
}

inline PetscErrorCode floquet_live_pc_capture_fatal_error(
    const FloquetCandidateDiagnosticCaptureTransaction &transaction) noexcept
{
    if (transaction.push_error != PETSC_SUCCESS) {
        return transaction.push_error;
    }
    if (transaction.capture_error != PETSC_SUCCESS) {
        return transaction.capture_error;
    }
    return transaction.pop_error;
}

constexpr bool floquet_live_pc_observation_inputs_available(
    bool pc_available,
    bool pmat_available,
    bool rhs_available,
    bool candidate_snapshot_available,
    bool workspace_available) noexcept
{
    return pc_available && pmat_available && rhs_available &&
        candidate_snapshot_available && workspace_available;
}

constexpr bool floquet_candidate_shifted_lu_workspace_ready(
    bool exact_shifted_matrix_available,
    bool vectors_available,
    bool mat_shift_nonzero_factor_available,
    bool mat_shift_none_factor_available) noexcept
{
    return exact_shifted_matrix_available &&
        vectors_available &&
        mat_shift_nonzero_factor_available &&
        mat_shift_none_factor_available;
}

template <typename Outcome>
inline bool floquet_candidate_shifted_lu_outcome_complete(
    const Outcome &outcome) noexcept
{
    return outcome.factorization_setup_available &&
        outcome.factorization_setup_error_code == PETSC_SUCCESS &&
        outcome.solve_available &&
        outcome.solve_error_code == PETSC_SUCCESS &&
        outcome.solve_reason_available &&
        outcome.repeat_solve_reason_available &&
        outcome.preconditioner_solution_l2_norm_available &&
        outcome.preconditioner_residual_l2_norm_available &&
        outcome.preconditioner_relative_residual_available &&
        outcome.operator_solution_l2_norm_available &&
        outcome.repeat_operator_solution_l2_norm_available &&
        outcome.repeatability_relative_defect_available &&
        outcome.operator_residual_l2_norm_available &&
        outcome.operator_relative_residual_available &&
        outcome.operator_tolerance_ratio_available;
}

template <typename Comparison>
inline bool floquet_candidate_shifted_lu_comparison_complete(
    const Comparison &comparison,
    bool vectors_available) noexcept
{
    return floquet_candidate_shifted_lu_workspace_ready(
               comparison.exact_shifted_matrix_available,
               vectors_available,
               comparison.mat_shift_nonzero.factorization_setup_available,
               comparison.mat_shift_none.factorization_setup_available) &&
        comparison.rhs_available &&
        comparison.rhs_l2_norm_available &&
        comparison.true_residual_threshold_available &&
        floquet_candidate_shifted_lu_outcome_complete(
            comparison.mat_shift_nonzero) &&
        floquet_candidate_shifted_lu_outcome_complete(
            comparison.mat_shift_none);
}

inline PetscErrorCode calculate_floquet_relative_residual(
    PetscReal residual_norm,
    PetscReal rhs_norm,
    PetscReal *relative_residual) noexcept
{
    if (relative_residual == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    *relative_residual = std::numeric_limits<PetscReal>::quiet_NaN();
    if (!std::isfinite(static_cast<double>(residual_norm)) ||
        !std::isfinite(static_cast<double>(rhs_norm)) ||
        residual_norm < 0.0 || rhs_norm < 0.0) {
        return PETSC_ERR_FP;
    }
    const PetscReal denominator = std::max(
        rhs_norm,
        std::numeric_limits<PetscReal>::min());
    const PetscReal ratio = residual_norm / denominator;
    if (!std::isfinite(static_cast<double>(ratio)) || ratio < 0.0) {
        return PETSC_ERR_FP;
    }
    *relative_residual = ratio;
    return PETSC_SUCCESS;
}

struct FloquetShiftedKspTrueConvergenceContext {
    void *default_context = nullptr;
    Vec candidate_solution = nullptr;
    Vec true_residual = nullptr;
    PetscReal rtol = 0.0;
    PetscReal atol = 0.0;
    PetscInt max_iterations = 0;
    std::uint64_t callback_count = 0;
    bool callback_observation_available = false;
    PetscInt last_callback_iteration = -1;
    bool last_recursive_residual_available = false;
    PetscReal last_recursive_residual_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    bool last_default_reason_available = false;
    bool last_reason_after_gate_available = false;
    int last_default_reason = 0;
    int last_reason_after_gate = 0;
    std::uint64_t true_probe_attempt_count = 0;
    std::uint64_t true_probe_count = 0;
    std::uint64_t true_probe_measurement_failure_count = 0;
    std::uint64_t true_probe_auxiliary_measurement_failure_count = 0;
    bool last_true_build_reason_available = false;
    int last_true_build_reason = 0;
    bool last_true_probe_available = false;
    std::uint64_t last_true_probe_callback_ordinal = 0;
    PetscInt last_true_probe_iteration = -1;
    bool last_true_solution_norm_available = false;
    PetscReal last_true_solution_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    bool last_true_operator_action_norm_available = false;
    PetscReal last_true_operator_action_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal last_true_rhs_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal last_true_residual_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal last_true_residual_threshold =
        std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal last_true_rtol = std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal last_true_atol = std::numeric_limits<PetscReal>::quiet_NaN();
    bool last_true_probe_recursive_residual_available = false;
    PetscReal last_true_probe_recursive_residual_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    bool last_true_probe_default_reason_available = false;
    int last_true_probe_default_reason = 0;
    bool last_true_probe_reason_after_gate_available = false;
    int last_true_probe_reason_after_gate = 0;
    bool last_true_tolerance_ratio_available = false;
    PetscReal last_true_tolerance_ratio =
        std::numeric_limits<PetscReal>::quiet_NaN();
    void *candidate_operator_diagnostic_context = nullptr;
    FloquetCandidateOperatorDiagnosticBegin candidate_operator_diagnostic_begin =
        nullptr;
    FloquetCandidateOperatorDiagnosticCapture candidate_operator_diagnostic_capture =
        nullptr;
    FloquetCandidateOperatorDiagnosticDestroy candidate_operator_diagnostic_destroy =
        nullptr;
    bool candidate_operator_diagnostic_cleanup_failed = false;
    bool cleanup_failed = false;
    PetscErrorCode cleanup_error = PETSC_SUCCESS;
};

inline PetscErrorCode destroy_floquet_ksp_default_convergence_context(
    void **default_context)
{
    if (default_context == nullptr || *default_context == nullptr) {
        return 0;
    }
// PETSc 3.24 changed context destroy callbacks from a value pointer to the
// address of the context pointer. Keep the default-convergence resource helper
// compatible with the older runtime toolchain as well.
#if PETSC_VERSION_LT(3, 24, 0)
    void *owned_context = *default_context;
    const PetscErrorCode error = KSPConvergedDefaultDestroy(owned_context);
#else
    void *owned_context = *default_context;
    const PetscErrorCode error = KSPConvergedDefaultDestroy(&owned_context);
#endif
    if (error == PETSC_SUCCESS) {
        // PETSc 3.24 frees its local cctx without clearing the caller's slot.
        // A successful release transfers no remaining ownership, regardless
        // of whether that version also nulls its pointer-to-pointer argument.
        *default_context = nullptr;
    }
    return error;
}

inline PetscErrorCode clear_floquet_shifted_ksp_true_convergence_context(
    FloquetShiftedKspTrueConvergenceContext *context)
{
    if (context == nullptr) {
        return 0;
    }
    if (context->cleanup_failed) {
        return context->cleanup_error != PETSC_SUCCESS
            ? context->cleanup_error
            : PETSC_ERR_LIB;
    }

    if (context->candidate_operator_diagnostic_destroy != nullptr) {
        const PetscErrorCode error =
            context->candidate_operator_diagnostic_destroy(
                &context->candidate_operator_diagnostic_context);
        if (error != PETSC_SUCCESS ||
            context->candidate_operator_diagnostic_context != nullptr) {
            context->candidate_operator_diagnostic_cleanup_failed = true;
            context->cleanup_failed = true;
            context->cleanup_error = error != PETSC_SUCCESS
                ? error
                : PETSC_ERR_LIB;
            return context->cleanup_error;
        }
        context->candidate_operator_diagnostic_begin = nullptr;
        context->candidate_operator_diagnostic_capture = nullptr;
        context->candidate_operator_diagnostic_destroy = nullptr;
    }

    if (context->true_residual != nullptr) {
        Vec owned = context->true_residual;
        const PetscErrorCode error = VecDestroy(&owned);
        if (error != PETSC_SUCCESS || owned != nullptr) {
            context->cleanup_failed = true;
            context->cleanup_error = error != PETSC_SUCCESS ? error : PETSC_ERR_LIB;
            return context->cleanup_error;
        }
        context->true_residual = nullptr;
    }
    if (context->candidate_solution != nullptr) {
        Vec owned = context->candidate_solution;
        const PetscErrorCode error = VecDestroy(&owned);
        if (error != PETSC_SUCCESS || owned != nullptr) {
            context->cleanup_failed = true;
            context->cleanup_error = error != PETSC_SUCCESS ? error : PETSC_ERR_LIB;
            return context->cleanup_error;
        }
        context->candidate_solution = nullptr;
    }
    if (context->default_context != nullptr) {
        const PetscErrorCode error =
            destroy_floquet_ksp_default_convergence_context(
                &context->default_context);
        if (error != PETSC_SUCCESS || context->default_context != nullptr) {
            context->cleanup_failed = true;
            context->cleanup_error = error != PETSC_SUCCESS ? error : PETSC_ERR_LIB;
            return context->cleanup_error;
        }
    }
    return PETSC_SUCCESS;
}

inline PetscErrorCode destroy_floquet_shifted_ksp_true_convergence_context_value(
    FloquetShiftedKspTrueConvergenceContext *context)
{
    return clear_floquet_shifted_ksp_true_convergence_context(context);
}

#if PETSC_VERSION_LT(3, 24, 0)
inline PetscErrorCode destroy_floquet_shifted_ksp_true_convergence_context(
    void *raw_context)
{
    return destroy_floquet_shifted_ksp_true_convergence_context_value(
        static_cast<FloquetShiftedKspTrueConvergenceContext *>(raw_context));
}
#else
inline PetscErrorCode destroy_floquet_shifted_ksp_true_convergence_context(
    void **raw_context)
{
    if (raw_context == nullptr) {
        return 0;
    }
    const PetscErrorCode error =
        destroy_floquet_shifted_ksp_true_convergence_context_value(
            static_cast<FloquetShiftedKspTrueConvergenceContext *>(*raw_context));
    if (error == PETSC_SUCCESS) {
        *raw_context = nullptr;
    }
    return error;
}
#endif

inline PetscErrorCode create_floquet_shifted_ksp_true_convergence_context(
    KSP ksp,
    FloquetShiftedKspTrueConvergenceContext **result)
{
    if (ksp == nullptr || result == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    *result = nullptr;

    auto *context =
        new (std::nothrow) FloquetShiftedKspTrueConvergenceContext{};
    if (context == nullptr) {
        return PETSC_ERR_MEM;
    }

    Mat operator_matrix = nullptr;
    PetscErrorCode error = KSPGetOperators(ksp, &operator_matrix, nullptr);
    if (error == 0 && operator_matrix == nullptr) {
        error = PETSC_ERR_ARG_WRONGSTATE;
    }
    if (error == 0) {
        error = MatCreateVecs(
            operator_matrix,
            &context->candidate_solution,
            &context->true_residual);
    }
    if (error == 0) {
        error = KSPGetTolerances(
            ksp,
            &context->rtol,
            &context->atol,
            nullptr,
            &context->max_iterations);
    }
    if (error == 0 &&
        (!std::isfinite(static_cast<double>(context->rtol)) ||
         !std::isfinite(static_cast<double>(context->atol)) ||
         context->rtol < 0.0 || context->atol < 0.0)) {
        error = PETSC_ERR_ARG_OUTOFRANGE;
    }
    if (error == 0) {
        error = KSPConvergedDefaultCreate(&context->default_context);
    }
    if (error != 0) {
        const PetscErrorCode cleanup_error =
            clear_floquet_shifted_ksp_true_convergence_context(context);
        if (cleanup_error != PETSC_SUCCESS) {
            // The caller must retain this context with its unreleased PETSc
            // handles and quarantine the containing graph. Never delete the
            // C++ owner after an unsuccessful checked teardown.
            *result = context;
            return error;
        }
        delete context;
        return error;
    }

    *result = context;
    return 0;
}

inline PetscErrorCode apply_floquet_shifted_true_residual_gate(
    PetscInt iteration,
    PetscReal rhs_norm,
    PetscReal residual_norm,
    KSPConvergedReason *reason,
    PetscReal rtol,
    PetscReal atol,
    PetscInt max_iterations,
    PetscReal *threshold_out = nullptr)
{
    if (reason == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    // PETSc divergence, iteration-budget, and cancellation results are final.
    if (*reason <= 0) {
        return 0;
    }
    if (!std::isfinite(static_cast<double>(rhs_norm)) ||
        !std::isfinite(static_cast<double>(residual_norm)) ||
        !std::isfinite(static_cast<double>(rtol)) ||
        !std::isfinite(static_cast<double>(atol)) ||
        rhs_norm < 0.0 || residual_norm < 0.0 || rtol < 0.0 || atol < 0.0) {
        return PETSC_ERR_ARG_OUTOFRANGE;
    }

    const PetscReal relative_threshold = rtol * rhs_norm;
    const PetscReal threshold = std::max(atol, relative_threshold);
    if (!std::isfinite(static_cast<double>(relative_threshold)) ||
        !std::isfinite(static_cast<double>(threshold))) {
        return PETSC_ERR_FP;
    }
    if (threshold_out != nullptr) {
        *threshold_out = threshold;
    }
    if (residual_norm <= threshold) {
        return 0;
    }

    *reason = max_iterations > 0 && iteration >= max_iterations
        ? KSP_DIVERGED_ITS
        : KSP_CONVERGED_ITERATING;
    return 0;
}

inline PetscErrorCode floquet_shifted_true_convergence_test(
    KSP ksp,
    PetscInt iteration,
    PetscReal recursive_residual_norm,
    KSPConvergedReason *reason,
    void *raw_context)
{
    if (ksp == nullptr || reason == nullptr || raw_context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *context =
        static_cast<FloquetShiftedKspTrueConvergenceContext *>(raw_context);
    if (context->default_context == nullptr ||
        context->candidate_solution == nullptr ||
        context->true_residual == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }

    ++context->callback_count;
    context->callback_observation_available = false;
    context->last_default_reason_available = false;
    context->last_reason_after_gate_available = false;
    context->last_recursive_residual_available =
        std::isfinite(static_cast<double>(recursive_residual_norm));
    context->last_recursive_residual_norm =
        context->last_recursive_residual_available
            ? recursive_residual_norm
            : std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_callback_iteration = iteration;

    // The callback pointer aliases KSP's live reason. Keep a provisional
    // positive result local: PETSc 3.24 otherwise copies the stored solution
    // instead of building the current Krylov candidate in KSPBuildSolution.
    KSPConvergedReason default_reason = KSP_CONVERGED_ITERATING;
    PetscErrorCode error = KSPConvergedDefault(
        ksp,
        iteration,
        recursive_residual_norm,
        &default_reason,
        context->default_context);
    if (error != 0) {
        return error;
    }
    context->callback_observation_available = true;
    context->last_default_reason_available = true;
    context->last_default_reason = static_cast<int>(default_reason);
    if (default_reason <= 0) {
        *reason = default_reason;
        context->last_reason_after_gate_available = true;
        context->last_reason_after_gate = static_cast<int>(*reason);
        return 0;
    }
    context->last_reason_after_gate_available = false;

    ++context->true_probe_attempt_count;
    context->last_true_probe_available = false;
    context->last_true_build_reason_available = false;
    context->last_true_build_reason = 0;
    context->last_true_tolerance_ratio_available = false;
    context->last_true_solution_norm_available = false;
    context->last_true_solution_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_true_operator_action_norm_available = false;
    context->last_true_operator_action_norm =
        std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_true_probe_callback_ordinal = context->callback_count;
    context->last_true_probe_iteration = iteration;
    context->last_true_rhs_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_true_residual_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_true_residual_threshold =
        std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_true_rtol = context->rtol;
    context->last_true_atol = context->atol;
    context->last_true_tolerance_ratio =
        std::numeric_limits<PetscReal>::quiet_NaN();
    context->last_true_probe_default_reason_available = true;
    context->last_true_probe_default_reason = static_cast<int>(default_reason);
    context->last_true_probe_reason_after_gate_available = false;
    context->last_true_probe_recursive_residual_available =
        std::isfinite(static_cast<double>(recursive_residual_norm));
    context->last_true_probe_recursive_residual_norm =
        context->last_true_probe_recursive_residual_available
            ? recursive_residual_norm
            : std::numeric_limits<PetscReal>::quiet_NaN();
    if (context->candidate_operator_diagnostic_begin != nullptr) {
        context->candidate_operator_diagnostic_begin(
            context->candidate_operator_diagnostic_context,
            iteration,
            context->last_true_probe_callback_ordinal);
    }

    const auto record_probe_failure = [context](PetscErrorCode probe_error) {
        if (probe_error != 0) {
            ++context->true_probe_measurement_failure_count;
        }
        return probe_error;
    };

    Mat operator_matrix = nullptr;
    Vec rhs = nullptr;
    error = KSPGetOperators(ksp, &operator_matrix, nullptr);
    if (error != 0) {
        return record_probe_failure(error);
    }
    if (operator_matrix == nullptr) {
        return record_probe_failure(PETSC_ERR_ARG_WRONGSTATE);
    }
    error = KSPGetRhs(ksp, &rhs);
    if (error != 0) {
        return record_probe_failure(error);
    }
    if (rhs == nullptr) {
        return record_probe_failure(PETSC_ERR_ARG_WRONGSTATE);
    }

    error = KSPBuildSolution(ksp, context->candidate_solution, nullptr);
    if (error != 0) {
        return record_probe_failure(error);
    }

    // GMRES may report a breakdown while building a solution and still
    // return success without populating the destination vector. Preserve the
    // live KSP reason before observing that vector or applying the true gate.
    KSPConvergedReason build_reason = KSP_CONVERGED_ITERATING;
    error = KSPGetConvergedReason(ksp, &build_reason);
    if (error != 0) {
        return record_probe_failure(error);
    }
    context->last_true_build_reason_available = true;
    context->last_true_build_reason = static_cast<int>(build_reason);
    if (build_reason < 0) {
        *reason = build_reason;
        return 0;
    }

    // Cache diagnostics from the solution vector already built for this true
    // residual probe. Their optional measurement must not alter the residual
    // gate or KSP stop reason.
    PetscReal solution_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    const PetscErrorCode solution_norm_error = VecNorm(
        context->candidate_solution, NORM_2, &solution_norm);
    if (solution_norm_error == 0 &&
        std::isfinite(static_cast<double>(solution_norm)) && solution_norm >= 0.0) {
        context->last_true_solution_norm_available = true;
        context->last_true_solution_norm = solution_norm;
    } else {
        ++context->true_probe_auxiliary_measurement_failure_count;
    }
    error = MatMult(
        operator_matrix,
        context->candidate_solution,
        context->true_residual);
    if (error != 0) {
        return record_probe_failure(error);
    }
    // This observer receives the actual production operator, RHS, action, and
    // candidate before the callback mutates true_residual into b - A*x.
    // Ordinary optional measurement failures are cached; an error-handler stack
    // push or restoration failure fails the callback so the owning graph is
    // quarantined rather than used with uncertain PETSc global state.
    if (context->candidate_operator_diagnostic_capture != nullptr) {
        error = context->candidate_operator_diagnostic_capture(
            context->candidate_operator_diagnostic_context,
            iteration,
            context->last_true_probe_callback_ordinal,
            ksp,
            operator_matrix,
            rhs,
            context->candidate_solution,
            context->true_residual);
        if (error != PETSC_SUCCESS) {
            return record_probe_failure(error);
        }
    }
    PetscReal operator_action_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    const PetscErrorCode operator_action_norm_error = VecNorm(
        context->true_residual, NORM_2, &operator_action_norm);
    if (operator_action_norm_error == 0 &&
        std::isfinite(static_cast<double>(operator_action_norm)) &&
        operator_action_norm >= 0.0) {
        context->last_true_operator_action_norm_available = true;
        context->last_true_operator_action_norm = operator_action_norm;
    } else {
        ++context->true_probe_auxiliary_measurement_failure_count;
    }
    // VecAYPX(y, -1, b) computes y <- b - y.
    error = VecAYPX(context->true_residual, -1.0, rhs);
    if (error != 0) {
        return record_probe_failure(error);
    }

    PetscReal rhs_norm = 0.0;
    PetscReal residual_norm = 0.0;
    error = VecNorm(rhs, NORM_2, &rhs_norm);
    if (error != 0) {
        return record_probe_failure(error);
    }
    error = VecNorm(context->true_residual, NORM_2, &residual_norm);
    if (error != 0) {
        return record_probe_failure(error);
    }

    PetscReal threshold = std::numeric_limits<PetscReal>::quiet_NaN();
    *reason = default_reason;
    error = apply_floquet_shifted_true_residual_gate(
        iteration,
        rhs_norm,
        residual_norm,
        reason,
        context->rtol,
        context->atol,
        context->max_iterations,
        &threshold);
    if (error != 0) {
        return record_probe_failure(error);
    }
    context->last_true_probe_available = true;
    ++context->true_probe_count;
    context->last_true_rhs_norm = rhs_norm;
    context->last_true_residual_norm = residual_norm;
    context->last_true_residual_threshold = threshold;
    context->last_default_reason = static_cast<int>(default_reason);
    context->last_reason_after_gate_available = true;
    context->last_reason_after_gate = static_cast<int>(*reason);
    context->last_true_probe_reason_after_gate_available = true;
    context->last_true_probe_reason_after_gate = static_cast<int>(*reason);
    if (threshold > 0.0) {
        const PetscReal ratio = residual_norm / threshold;
        if (std::isfinite(static_cast<double>(ratio))) {
            context->last_true_tolerance_ratio_available = true;
            context->last_true_tolerance_ratio = ratio;
        }
    }
    return 0;
}

} // namespace fullmag::fem::frequency_domain::detail
