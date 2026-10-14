#pragma once

#include "../slepc_modal_eigen.hpp"
#include "../../../core/petsc_slepc_runtime.hpp"
#include "shifted_ksp_true_convergence.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>

#include <petscksp.h>

namespace fullmag::fem::frequency_domain::detail {

// This snapshot is intentionally a plain value object. `inner_ksp` is a
// borrowed identity while the owning PCSHELL context remains alive; callers
// must not retain or destroy it through the snapshot.
struct FloquetShiftedKspCertifiedRecoverySnapshot {
    KSP inner_ksp = nullptr;
    bool original_settings_available = false;
    PetscReal original_rtol = std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal original_atol = std::numeric_limits<PetscReal>::quiet_NaN();
    PetscReal original_dtol = std::numeric_limits<PetscReal>::quiet_NaN();
    PetscInt original_max_iterations = 0;

    std::uint64_t solve_count = 0;
    std::uint64_t certified_count = 0;
    std::uint64_t failed_count = 0;
    std::uint64_t recovery_attempt_count = 0;
    std::uint64_t recovered_solve_count = 0;
    std::uint64_t inner_attempt_count = 0;
    std::uint64_t failed_inner_attempt_count = 0;
    std::uint64_t cycle_count_total = 0;
    std::uint64_t cumulative_iterations_total = 0;
    PetscInt last_cycle_count = 0;
    PetscInt last_cumulative_iterations = 0;
    PetscInt max_cumulative_iterations_per_solve = 0;
    PetscInt last_candidate_iteration = -1;
    PetscInt last_terminal_iteration = -1;
    const char *last_candidate_source = "none";

    bool last_certified = false;
    bool last_recovered = false;
    bool last_inner_reason_available = false;
    int last_inner_reason = 0;
    bool last_failed_inner_reason_available = false;
    int last_failed_inner_reason = 0;
    PetscInt last_failed_inner_iterations = 0;
    bool last_rhs_norm_available = false;
    PetscReal last_rhs_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    bool final_residual_available = false;
    PetscReal final_residual = std::numeric_limits<PetscReal>::quiet_NaN();
    bool threshold_available = false;
    PetscReal threshold = std::numeric_limits<PetscReal>::quiet_NaN();
    // Cross-solve maximum over every independently recomputed inner attempt,
    // including rejected candidates; this is not the final-candidate ratio.
    bool max_tolerance_ratio_available = false;
    PetscReal max_tolerance_ratio = std::numeric_limits<PetscReal>::quiet_NaN();
    const char *certificate_source = "none";

    PetscErrorCode primary_error = PETSC_SUCCESS;
    PetscErrorCode cleanup_error = PETSC_SUCCESS;
    bool unsafe = false;
};

struct FloquetShiftedKspCertifiedRecoveryContext {
    FloquetShiftedKspCertifiedRecoverySnapshot snapshot{};
    KSP inner_ksp = nullptr; // One owned PETSc reference.
    FloquetShiftedKspTrueConvergenceContext *true_convergence_context = nullptr;
    Mat operator_matrix = nullptr; // Borrowed from the outer PCSHELL.
    Mat preconditioner_matrix = nullptr; // Borrowed from the outer PCSHELL.
    Vec solution_backup = nullptr;
    Vec true_residual = nullptr;
    PetscBool original_initial_guess_nonzero = PETSC_FALSE;
    bool operators_configured = false;
    bool setup_available = false;
    bool applying = false;
    bool cleanup_failed = false;
};

inline void mark_floquet_certified_recovery_unsafe(
    FloquetShiftedKspCertifiedRecoveryContext *context,
    PetscErrorCode error) noexcept
{
    if (context != nullptr) {
        context->snapshot.unsafe = true;
        if (context->snapshot.primary_error == PETSC_SUCCESS &&
            error != PETSC_SUCCESS) {
            context->snapshot.primary_error = error;
        }
    }
    fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
}

inline void mark_floquet_certified_recovery_quarantined(void *raw_context)
{
    auto *context = static_cast<FloquetShiftedKspCertifiedRecoveryContext *>(
        raw_context);
    if (context == nullptr) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        return;
    }
    context->cleanup_failed = true;
    context->snapshot.unsafe = true;
    if (context->snapshot.cleanup_error == PETSC_SUCCESS) {
        context->snapshot.cleanup_error = PETSC_ERR_LIB;
    }
    fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
}

inline bool destroy_floquet_certified_recovery_ksp(void *raw_context)
{
    auto *context = static_cast<FloquetShiftedKspCertifiedRecoveryContext *>(
        raw_context);
    if (context == nullptr || context->inner_ksp == nullptr) {
        return true;
    }
    KSP owned = context->inner_ksp;
    const PetscErrorCode error = KSPDestroy(&owned);
    if (error != PETSC_SUCCESS || owned != nullptr) {
        context->snapshot.cleanup_error = error != PETSC_SUCCESS
            ? error
            : PETSC_ERR_LIB;
        return false;
    }
    context->inner_ksp = nullptr;
    context->snapshot.inner_ksp = nullptr;
    return true;
}

inline bool destroy_floquet_certified_recovery_solution_backup(void *raw_context)
{
    auto *context = static_cast<FloquetShiftedKspCertifiedRecoveryContext *>(
        raw_context);
    if (context == nullptr || context->solution_backup == nullptr) {
        return true;
    }
    Vec owned = context->solution_backup;
    const PetscErrorCode error = VecDestroy(&owned);
    if (error != PETSC_SUCCESS || owned != nullptr) {
        context->snapshot.cleanup_error = error != PETSC_SUCCESS
            ? error
            : PETSC_ERR_LIB;
        return false;
    }
    context->solution_backup = nullptr;
    return true;
}

inline bool destroy_floquet_certified_recovery_residual(void *raw_context)
{
    auto *context = static_cast<FloquetShiftedKspCertifiedRecoveryContext *>(
        raw_context);
    if (context == nullptr || context->true_residual == nullptr) {
        return true;
    }
    Vec owned = context->true_residual;
    const PetscErrorCode error = VecDestroy(&owned);
    if (error != PETSC_SUCCESS || owned != nullptr) {
        context->snapshot.cleanup_error = error != PETSC_SUCCESS
            ? error
            : PETSC_ERR_LIB;
        return false;
    }
    context->true_residual = nullptr;
    return true;
}

inline bool destroy_floquet_certified_recovery_workspaces(
    FloquetShiftedKspCertifiedRecoveryContext *context) noexcept
{
    if (context == nullptr) {
        return true;
    }
    const SLEPcModalDestroyOperation operations[] = {
        {context, destroy_floquet_certified_recovery_solution_backup},
        {context, destroy_floquet_certified_recovery_residual},
    };
    return run_slepc_modal_destroy_sequence(
        operations,
        sizeof(operations) / sizeof(operations[0]),
        mark_floquet_certified_recovery_quarantined,
        context);
}

inline void record_floquet_certified_recovery_primary_error(
    FloquetShiftedKspCertifiedRecoveryContext *context,
    PetscErrorCode error) noexcept
{
    if (context != nullptr && error != PETSC_SUCCESS &&
        context->snapshot.primary_error == PETSC_SUCCESS) {
        context->snapshot.primary_error = error;
    }
}

inline PetscErrorCode floquet_certified_recovery_context_from_pc(
    PC pc,
    FloquetShiftedKspCertifiedRecoveryContext **context)
{
    if (pc == nullptr || context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    *context = nullptr;
    if (fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
        return PETSC_ERR_LIB;
    }
    void *raw_context = nullptr;
    const PetscErrorCode error = PCShellGetContext(pc, &raw_context);
    if (error != PETSC_SUCCESS) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        return error;
    }
    if (raw_context == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }
    *context = static_cast<FloquetShiftedKspCertifiedRecoveryContext *>(
        raw_context);
    if ((*context)->snapshot.unsafe) {
        (*context)->snapshot.unsafe = true;
        return PETSC_ERR_LIB;
    }
    return PETSC_SUCCESS;
}

inline PetscErrorCode floquet_shifted_certified_recovery_shell_setup(PC pc)
{
    FloquetShiftedKspCertifiedRecoveryContext *context = nullptr;
    PetscErrorCode error = floquet_certified_recovery_context_from_pc(
        pc,
        &context);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    Mat operator_matrix = nullptr;
    Mat preconditioner_matrix = nullptr;
    error = PCGetOperators(pc, &operator_matrix, &preconditioner_matrix);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    if (operator_matrix == nullptr || preconditioner_matrix == nullptr) {
        error = PETSC_ERR_ARG_WRONGSTATE;
        record_floquet_certified_recovery_primary_error(context, error);
        return error;
    }

    Mat inner_operator = nullptr;
    Mat inner_preconditioner = nullptr;
    error = KSPGetOperators(
        context->inner_ksp,
        &inner_operator,
        &inner_preconditioner);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    const bool operators_changed = !context->operators_configured ||
        inner_operator != operator_matrix ||
        inner_preconditioner != preconditioner_matrix;
    if (operators_changed) {
        error = KSPSetOperators(
            context->inner_ksp,
            operator_matrix,
            preconditioner_matrix);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            return error;
        }
    }

    const bool operator_changed = context->operator_matrix != operator_matrix;
    if (operator_changed || context->solution_backup == nullptr ||
        context->true_residual == nullptr) {
        if (!destroy_floquet_certified_recovery_workspaces(context)) {
            context->cleanup_failed = true;
            context->snapshot.unsafe = true;
            return context->snapshot.cleanup_error != PETSC_SUCCESS
                ? context->snapshot.cleanup_error
                : PETSC_ERR_LIB;
        }
        error = MatCreateVecs(
            operator_matrix,
            &context->solution_backup,
            &context->true_residual);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            return error;
        }
    }
    // Setup runs when the outer shell is set up, not once per apply. Refresh
    // the inner KSP's setup state even when PETSc returns the same matrix
    // handles, since their operator state may have changed in place.
    error = KSPSetUp(context->inner_ksp);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    context->operator_matrix = operator_matrix;
    context->preconditioner_matrix = preconditioner_matrix;
    context->operators_configured = true;
    context->setup_available = true;
    return PETSC_SUCCESS;
}

inline PetscErrorCode restore_floquet_certified_recovery_settings(
    FloquetShiftedKspCertifiedRecoveryContext *context)
{
    if (context == nullptr || context->snapshot.unsafe ||
        fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
        return PETSC_ERR_LIB;
    }
    PetscErrorCode error = KSPSetTolerances(
        context->inner_ksp,
        context->snapshot.original_rtol,
        context->snapshot.original_atol,
        context->snapshot.original_dtol,
        context->snapshot.original_max_iterations);
    if (error != PETSC_SUCCESS) {
        context->snapshot.cleanup_error = error;
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    error = KSPSetInitialGuessNonzero(
        context->inner_ksp,
        context->original_initial_guess_nonzero);
    if (error != PETSC_SUCCESS) {
        context->snapshot.cleanup_error = error;
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    return PETSC_SUCCESS;
}

inline bool floquet_cached_true_gate_rejected_current_candidate(
    const FloquetShiftedKspCertifiedRecoveryContext *context,
    std::uint64_t callback_count_before_cycle,
    PetscInt terminal_iteration) noexcept
{
    if (context == nullptr || context->true_convergence_context == nullptr) {
        return false;
    }
    const auto *true_context = context->true_convergence_context;
    return !true_context->cleanup_failed &&
        !true_context->candidate_operator_diagnostic_cleanup_failed &&
        true_context->owned_true_probe_solution_available &&
        true_context->owned_true_probe_solution != nullptr &&
        true_context->owned_true_probe_attempt_id ==
            true_context->current_inner_attempt_id &&
        true_context->current_inner_attempt_id ==
            context->snapshot.inner_attempt_count &&
        true_context->owned_true_probe_callback_ordinal >
            callback_count_before_cycle &&
        true_context->owned_true_probe_callback_ordinal ==
            true_context->callback_count &&
        true_context->last_true_probe_available &&
        true_context->last_true_probe_default_reason_available &&
        true_context->last_true_probe_default_reason > 0 &&
        true_context->last_true_probe_reason_after_gate_available &&
        true_context->last_true_probe_reason_after_gate ==
            KSP_CONVERGED_ITERATING &&
        true_context->last_true_probe_callback_ordinal ==
            true_context->owned_true_probe_callback_ordinal &&
        true_context->last_true_probe_iteration ==
            true_context->owned_true_probe_iteration &&
        true_context->owned_true_probe_iteration > 0 &&
        true_context->owned_true_probe_iteration <= terminal_iteration &&
        true_context->last_true_build_reason_available &&
        true_context->last_true_build_reason >= 0 &&
        true_context->last_true_build_reason ==
            true_context->owned_true_probe_build_reason &&
        true_context->owned_true_probe_build_reason >= 0 &&
        true_context->last_true_solution_norm_available &&
        std::isfinite(static_cast<double>(
            true_context->last_true_solution_norm)) &&
        true_context->last_true_solution_norm >= 0.0 &&
        std::isfinite(static_cast<double>(true_context->last_true_residual_norm)) &&
        std::isfinite(static_cast<double>(
            true_context->last_true_residual_threshold)) &&
        true_context->last_true_residual_norm >= 0.0 &&
        true_context->last_true_residual_threshold >= 0.0 &&
        true_context->last_true_residual_norm >
            true_context->last_true_residual_threshold;
}

inline PetscErrorCode floquet_recompute_certified_recovery_residual(
    FloquetShiftedKspCertifiedRecoveryContext *context,
    Vec rhs,
    Vec candidate,
    PetscReal *residual_norm,
    bool *finite)
{
    if (context == nullptr || rhs == nullptr || candidate == nullptr ||
        residual_norm == nullptr || finite == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    if (context->operator_matrix == nullptr || context->true_residual == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }
    *residual_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    *finite = false;
    PetscReal candidate_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    PetscErrorCode error = VecNorm(candidate, NORM_2, &candidate_norm);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    if (!std::isfinite(static_cast<double>(candidate_norm)) || candidate_norm < 0.0) {
        return PETSC_SUCCESS;
    }
    error = MatMult(context->operator_matrix, candidate, context->true_residual);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    error = VecAYPX(
        context->true_residual,
        static_cast<PetscScalar>(-1.0),
        rhs);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    error = VecNorm(context->true_residual, NORM_2, residual_norm);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    *finite = std::isfinite(static_cast<double>(*residual_norm)) &&
        *residual_norm >= 0.0;
    return PETSC_SUCCESS;
}

inline PetscErrorCode floquet_select_owned_true_probe_candidate(
    FloquetShiftedKspCertifiedRecoveryContext *context,
    Vec rhs,
    Vec solution,
    std::uint64_t callback_count_before_cycle,
    KSPConvergedReason terminal_reason,
    PetscInt terminal_iteration,
    PetscInt cumulative_iterations,
    PetscReal rhs_norm,
    PetscReal threshold,
    PetscReal previous_residual,
    PetscReal committed_residual,
    bool *selected,
    PetscReal *selected_residual)
{
    if (selected == nullptr || selected_residual == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    *selected = false;
    *selected_residual = std::numeric_limits<PetscReal>::quiet_NaN();
    if (context == nullptr || rhs == nullptr || solution == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    if (context->solution_backup == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }
    if (terminal_reason != KSP_DIVERGED_BREAKDOWN ||
        !context->snapshot.last_inner_reason_available ||
        context->snapshot.last_inner_reason != static_cast<int>(terminal_reason) ||
        !floquet_cached_true_gate_rejected_current_candidate(
            context,
            callback_count_before_cycle,
            terminal_iteration) ||
        !std::isfinite(static_cast<double>(rhs_norm)) || rhs_norm <= 0.0 ||
        !std::isfinite(static_cast<double>(threshold)) || threshold < 0.0 ||
        std::isnan(static_cast<double>(previous_residual)) ||
        previous_residual < 0.0 ||
        !std::isfinite(static_cast<double>(committed_residual)) ||
        committed_residual <= threshold || cumulative_iterations < 0 ||
        cumulative_iterations > context->snapshot.original_max_iterations) {
        return PETSC_SUCCESS;
    }

    bool candidate_finite = false;
    PetscReal candidate_residual = std::numeric_limits<PetscReal>::quiet_NaN();
    PetscErrorCode error = floquet_recompute_certified_recovery_residual(
        context,
        rhs,
        context->true_convergence_context->owned_true_probe_solution,
        &candidate_residual,
        &candidate_finite);
    if (error != PETSC_SUCCESS || !candidate_finite) {
        return error;
    }
    // A cached candidate is usable only when the owner independently measures
    // strict progress against both the terminal vector and the previous
    // accepted iterate. A still-unconverged candidate also needs budget left.
    if (!(candidate_residual < committed_residual &&
          candidate_residual < rhs_norm &&
          candidate_residual < previous_residual)) {
        return PETSC_SUCCESS;
    }
    const PetscInt remaining_iterations =
        context->snapshot.original_max_iterations - cumulative_iterations;
    if (candidate_residual > threshold && remaining_iterations <= 0) {
        return PETSC_SUCCESS;
    }

    error = VecCopy(
        context->true_convergence_context->owned_true_probe_solution,
        solution);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    error = VecCopy(
        context->true_convergence_context->owned_true_probe_solution,
        context->solution_backup);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    context->snapshot.last_candidate_iteration =
        context->true_convergence_context->owned_true_probe_iteration;
    context->snapshot.last_terminal_iteration = terminal_iteration;
    context->snapshot.last_candidate_source = "owned_true_probe_cache";
    *selected_residual = candidate_residual;
    *selected = true;
    return PETSC_SUCCESS;
}

inline bool floquet_mark_owner_candidate_certified(
    FloquetShiftedKspCertifiedRecoveryContext *context,
    KSPConvergedReason terminal_reason,
    bool owner_recomputed_residual_available,
    PetscReal residual_norm,
    PetscReal threshold,
    bool owned_true_probe_candidate) noexcept
{
    if (context == nullptr || !owner_recomputed_residual_available ||
        (terminal_reason <= 0 && terminal_reason != KSP_DIVERGED_BREAKDOWN) ||
        !std::isfinite(static_cast<double>(residual_norm)) || residual_norm < 0.0 ||
        !std::isfinite(static_cast<double>(threshold)) || threshold < 0.0 ||
        residual_norm > threshold) {
        return false;
    }
    context->snapshot.last_certified = true;
    context->snapshot.certificate_source = owned_true_probe_candidate
        ? "owner_recomputed_owned_true_probe_cache"
        : "owner_recomputed_true_residual";
    return true;
}

inline PetscErrorCode fail_floquet_certified_recovery_without_unsafe_graph(
    FloquetShiftedKspCertifiedRecoveryContext *context,
    PetscErrorCode error)
{
    record_floquet_certified_recovery_primary_error(context, error);
    if (context != nullptr) {
        ++context->snapshot.failed_count;
        context->snapshot.last_certified = false;
        context->snapshot.last_recovered = false;
    }
    return error;
}

inline PetscErrorCode floquet_shifted_certified_recovery_shell_apply(
    PC pc,
    Vec rhs,
    Vec solution)
{
    FloquetShiftedKspCertifiedRecoveryContext *context = nullptr;
    PetscErrorCode error = floquet_certified_recovery_context_from_pc(
        pc,
        &context);
    if (error != PETSC_SUCCESS) {
        return error;
    }
    if (rhs == nullptr || solution == nullptr) {
        return fail_floquet_certified_recovery_without_unsafe_graph(
            context,
            PETSC_ERR_ARG_NULL);
    }
    if (!context->setup_available || context->operator_matrix == nullptr ||
        context->solution_backup == nullptr || context->true_residual == nullptr ||
        context->inner_ksp == nullptr || context->true_convergence_context == nullptr) {
        return fail_floquet_certified_recovery_without_unsafe_graph(
            context,
            PETSC_ERR_ARG_WRONGSTATE);
    }
    if (context->true_convergence_context->cleanup_failed ||
        context->true_convergence_context->
            candidate_operator_diagnostic_cleanup_failed) {
        const PetscErrorCode cleanup_error =
            context->true_convergence_context->cleanup_error != PETSC_SUCCESS
                ? context->true_convergence_context->cleanup_error
                : PETSC_ERR_LIB;
        context->snapshot.cleanup_error = cleanup_error;
        mark_floquet_certified_recovery_unsafe(context, cleanup_error);
        ++context->snapshot.failed_count;
        return cleanup_error;
    }
    if (context->applying) {
        return fail_floquet_certified_recovery_without_unsafe_graph(
            context,
            PETSC_ERR_ARG_WRONGSTATE);
    }
    context->applying = true;
    ++context->snapshot.solve_count;
    context->snapshot.last_certified = false;
    context->snapshot.last_recovered = false;
    context->snapshot.last_inner_reason_available = false;
    context->snapshot.final_residual_available = false;
    context->snapshot.last_rhs_norm_available = false;
    context->snapshot.threshold_available = false;
    context->snapshot.certificate_source = "none";
    context->snapshot.last_cycle_count = 0;
    context->snapshot.last_cumulative_iterations = 0;
    context->snapshot.last_candidate_iteration = -1;
    context->snapshot.last_terminal_iteration = -1;
    context->snapshot.last_candidate_source = "none";

    PetscReal rhs_norm = std::numeric_limits<PetscReal>::quiet_NaN();
    error = VecNorm(rhs, NORM_2, &rhs_norm);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        context->applying = false;
        ++context->snapshot.failed_count;
        return error;
    }
    if (!std::isfinite(static_cast<double>(rhs_norm)) || rhs_norm < 0.0) {
        context->applying = false;
        return fail_floquet_certified_recovery_without_unsafe_graph(
            context,
            PETSC_ERR_FP);
    }
    context->snapshot.last_rhs_norm_available = true;
    context->snapshot.last_rhs_norm = rhs_norm;
    const PetscReal relative_threshold =
        context->snapshot.original_rtol * rhs_norm;
    const PetscReal threshold = std::max(
        context->snapshot.original_atol,
        relative_threshold);
    if (!std::isfinite(static_cast<double>(relative_threshold)) ||
        !std::isfinite(static_cast<double>(threshold)) || threshold < 0.0) {
        context->applying = false;
        return fail_floquet_certified_recovery_without_unsafe_graph(
            context,
            PETSC_ERR_FP);
    }
    context->snapshot.threshold_available = true;
    context->snapshot.threshold = threshold;

    if (rhs_norm == 0.0) {
        PetscReal rhs_infinity_norm = std::numeric_limits<PetscReal>::quiet_NaN();
        error = VecNorm(rhs, NORM_INFINITY, &rhs_infinity_norm);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }
        if (!std::isfinite(static_cast<double>(rhs_infinity_norm)) ||
            rhs_infinity_norm != 0.0) {
            context->applying = false;
            return fail_floquet_certified_recovery_without_unsafe_graph(
                context,
                PETSC_ERR_FP);
        }
        error = VecSet(solution, static_cast<PetscScalar>(0.0));
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }
        context->snapshot.final_residual_available = true;
        context->snapshot.final_residual = 0.0;
        context->snapshot.last_certified = true;
        context->snapshot.certificate_source = "zero_rhs_certificate";
        ++context->snapshot.certified_count;
        context->applying = false;
        return PETSC_SUCCESS;
    }

    error = KSPSetTolerances(
        context->inner_ksp,
        context->snapshot.original_rtol,
        context->snapshot.original_atol,
        context->snapshot.original_dtol,
        context->snapshot.original_max_iterations);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        context->applying = false;
        ++context->snapshot.failed_count;
        return error;
    }
    error = KSPSetInitialGuessNonzero(context->inner_ksp, PETSC_FALSE);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        context->applying = false;
        ++context->snapshot.failed_count;
        return error;
    }
    error = VecSet(solution, static_cast<PetscScalar>(0.0));
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        context->applying = false;
        ++context->snapshot.failed_count;
        return error;
    }

    PetscErrorCode numerical_failure = PETSC_SUCCESS;
    PetscReal previous_residual = std::numeric_limits<PetscReal>::infinity();
    PetscInt cumulative_iterations = 0;
    bool use_nonzero_initial_guess = false;
    for (;;) {
        if (cumulative_iterations >= context->snapshot.original_max_iterations) {
            numerical_failure = PETSC_ERR_NOT_CONVERGED;
            break;
        }
        const PetscInt remaining_iterations =
            context->snapshot.original_max_iterations - cumulative_iterations;
        if (remaining_iterations <= 0) {
            numerical_failure = PETSC_ERR_NOT_CONVERGED;
            break;
        }
        if (use_nonzero_initial_guess) {
            error = KSPSetInitialGuessNonzero(context->inner_ksp, PETSC_TRUE);
            if (error != PETSC_SUCCESS) {
                mark_floquet_certified_recovery_unsafe(context, error);
                context->applying = false;
                ++context->snapshot.failed_count;
                return error;
            }
            error = VecCopy(context->solution_backup, solution);
            if (error != PETSC_SUCCESS) {
                mark_floquet_certified_recovery_unsafe(context, error);
                context->applying = false;
                ++context->snapshot.failed_count;
                return error;
            }
        }
        error = KSPSetTolerances(
            context->inner_ksp,
            context->snapshot.original_rtol,
            context->snapshot.original_atol,
            context->snapshot.original_dtol,
            remaining_iterations);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }

        const std::uint64_t callback_count_before_cycle =
            context->true_convergence_context->callback_count;
        ++context->snapshot.inner_attempt_count;
        context->true_convergence_context->current_inner_attempt_id =
            context->snapshot.inner_attempt_count;
        ++context->snapshot.cycle_count_total;
        ++context->snapshot.last_cycle_count;
        error = KSPSolve(context->inner_ksp, rhs, solution);
        // KSPSolve's returned error is the primary operation failure even if
        // the convergence callback also recorded a separate cleanup fault.
        record_floquet_certified_recovery_primary_error(context, error);
        if (context->true_convergence_context->cleanup_failed ||
            context->true_convergence_context->
                candidate_operator_diagnostic_cleanup_failed) {
            const PetscErrorCode cleanup_error =
                context->true_convergence_context->cleanup_error != PETSC_SUCCESS
                    ? context->true_convergence_context->cleanup_error
                    : PETSC_ERR_LIB;
            context->snapshot.cleanup_error = cleanup_error;
            mark_floquet_certified_recovery_unsafe(context, cleanup_error);
            context->applying = false;
            ++context->snapshot.failed_inner_attempt_count;
            ++context->snapshot.failed_count;
            return context->snapshot.primary_error != PETSC_SUCCESS
                ? context->snapshot.primary_error
                : cleanup_error;
        }
        if (fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
            mark_floquet_certified_recovery_unsafe(context, PETSC_ERR_LIB);
            context->applying = false;
            ++context->snapshot.failed_inner_attempt_count;
            ++context->snapshot.failed_count;
            return context->snapshot.primary_error != PETSC_SUCCESS
                ? context->snapshot.primary_error
                : PETSC_ERR_LIB;
        }
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_inner_attempt_count;
            ++context->snapshot.failed_count;
            return error;
        }

        PetscInt cycle_iterations = 0;
        error = KSPGetIterationNumber(context->inner_ksp, &cycle_iterations);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }
        KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
        error = KSPGetConvergedReason(context->inner_ksp, &reason);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }
        context->snapshot.last_inner_reason_available = true;
        context->snapshot.last_inner_reason = static_cast<int>(reason);
        if (cycle_iterations < 0 ||
            cumulative_iterations >
                std::numeric_limits<PetscInt>::max() - cycle_iterations) {
            numerical_failure = PETSC_ERR_ARG_OUTOFRANGE;
            break;
        }
        context->snapshot.last_terminal_iteration = cycle_iterations;
        cumulative_iterations += cycle_iterations;
        context->snapshot.last_cumulative_iterations = cumulative_iterations;
        if (std::numeric_limits<std::uint64_t>::max() -
                context->snapshot.cumulative_iterations_total <
            static_cast<std::uint64_t>(cycle_iterations)) {
            numerical_failure = PETSC_ERR_ARG_OUTOFRANGE;
            break;
        }
        context->snapshot.cumulative_iterations_total +=
            static_cast<std::uint64_t>(cycle_iterations);
        context->snapshot.max_cumulative_iterations_per_solve = std::max(
            context->snapshot.max_cumulative_iterations_per_solve,
            cumulative_iterations);
        if (reason < 0) {
            ++context->snapshot.failed_inner_attempt_count;
            context->snapshot.last_failed_inner_reason_available = true;
            context->snapshot.last_failed_inner_reason =
                static_cast<int>(reason);
            context->snapshot.last_failed_inner_iterations = cycle_iterations;
        }
        if (cycle_iterations > remaining_iterations) {
            numerical_failure = PETSC_ERR_ARG_OUTOFRANGE;
            break;
        }

        bool committed_candidate_finite = false;
        PetscReal residual_norm = std::numeric_limits<PetscReal>::quiet_NaN();
        error = floquet_recompute_certified_recovery_residual(
            context,
            rhs,
            solution,
            &residual_norm,
            &committed_candidate_finite);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }
        if (!committed_candidate_finite) {
            numerical_failure = PETSC_ERR_FP;
            break;
        }
        bool cached_candidate_selected = false;
        PetscReal cached_candidate_residual =
            std::numeric_limits<PetscReal>::quiet_NaN();
        error = floquet_select_owned_true_probe_candidate(
            context,
            rhs,
            solution,
            callback_count_before_cycle,
            reason,
            cycle_iterations,
            cumulative_iterations,
            rhs_norm,
            threshold,
            previous_residual,
            residual_norm,
            &cached_candidate_selected,
            &cached_candidate_residual);
        if (error != PETSC_SUCCESS) {
            mark_floquet_certified_recovery_unsafe(context, error);
            context->applying = false;
            ++context->snapshot.failed_count;
            return error;
        }
        if (cached_candidate_selected) {
            residual_norm = cached_candidate_residual;
        } else {
            context->snapshot.last_candidate_iteration = cycle_iterations;
            context->snapshot.last_candidate_source =
                "committed_inner_solution";
            error = VecCopy(solution, context->solution_backup);
            if (error != PETSC_SUCCESS) {
                mark_floquet_certified_recovery_unsafe(context, error);
                context->applying = false;
                ++context->snapshot.failed_count;
                return error;
            }
        }
        context->snapshot.final_residual_available = true;
        context->snapshot.final_residual = residual_norm;
        if (threshold > 0.0) {
            const PetscReal tolerance_ratio = residual_norm / threshold;
            if (std::isfinite(static_cast<double>(tolerance_ratio)) &&
                tolerance_ratio >= 0.0) {
                context->snapshot.max_tolerance_ratio =
                    context->snapshot.max_tolerance_ratio_available
                        ? std::max(
                            context->snapshot.max_tolerance_ratio,
                            tolerance_ratio)
                        : tolerance_ratio;
                context->snapshot.max_tolerance_ratio_available = true;
            }
        }

        if (floquet_mark_owner_candidate_certified(
                context,
                reason,
                true,
                residual_norm,
                threshold,
                cached_candidate_selected)) {
            break;
        }
        if (residual_norm <= threshold) {
            numerical_failure = PETSC_ERR_NOT_CONVERGED;
            break;
        }
        if (cumulative_iterations == 0 || reason != KSP_DIVERGED_BREAKDOWN ||
            !floquet_cached_true_gate_rejected_current_candidate(
                context,
                callback_count_before_cycle,
                cycle_iterations)) {
            numerical_failure = PETSC_ERR_NOT_CONVERGED;
            break;
        }
        const PetscInt next_remaining =
            context->snapshot.original_max_iterations - cumulative_iterations;
        if (next_remaining <= 0 || residual_norm >= previous_residual ||
            residual_norm >= rhs_norm) {
            numerical_failure = PETSC_ERR_NOT_CONVERGED;
            break;
        }
        previous_residual = residual_norm;
        ++context->snapshot.recovery_attempt_count;
        use_nonzero_initial_guess = true;
    }

    if (context->snapshot.last_cumulative_iterations == 0 &&
        context->snapshot.final_residual_available &&
        context->snapshot.final_residual > threshold) {
        numerical_failure = PETSC_ERR_NOT_CONVERGED;
    }
    if (context->snapshot.last_cycle_count > 0) {
        context->snapshot.max_cumulative_iterations_per_solve = std::max(
            context->snapshot.max_cumulative_iterations_per_solve,
            context->snapshot.last_cumulative_iterations);
    }
    const PetscErrorCode solve_failure = numerical_failure != PETSC_SUCCESS
        ? numerical_failure
        : (context->snapshot.last_certified
               ? PETSC_SUCCESS
               : PETSC_ERR_NOT_CONVERGED);
    record_floquet_certified_recovery_primary_error(context, solve_failure);
    const PetscErrorCode settings_restore_error =
        restore_floquet_certified_recovery_settings(context);
    context->applying = false;
    if (settings_restore_error != PETSC_SUCCESS) {
        context->snapshot.last_certified = false;
        context->snapshot.last_recovered = false;
        context->snapshot.certificate_source = "none";
        ++context->snapshot.failed_count;
        return context->snapshot.primary_error != PETSC_SUCCESS
            ? context->snapshot.primary_error
            : settings_restore_error;
    }
    if (solve_failure != PETSC_SUCCESS) {
        return fail_floquet_certified_recovery_without_unsafe_graph(
            context,
            solve_failure);
    }
    if (context->snapshot.last_certified) {
        ++context->snapshot.certified_count;
        if (context->snapshot.last_cycle_count > 1) {
            context->snapshot.last_recovered = true;
            ++context->snapshot.recovered_solve_count;
        }
    }
    return PETSC_SUCCESS;
}

inline PetscErrorCode destroy_floquet_shifted_ksp_certified_recovery_shell(
    PC pc)
{
    if (pc == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    if (fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
        // Do not query the shell or destroy owned PETSc handles after the
        // process-wide runtime has been quarantined. The context remains
        // intentionally retained for OS reclamation.
        return PETSC_ERR_LIB;
    }
    void *raw_context = nullptr;
    const PetscErrorCode context_error = PCShellGetContext(pc, &raw_context);
    if (context_error != PETSC_SUCCESS) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        return context_error;
    }
    auto *context = static_cast<FloquetShiftedKspCertifiedRecoveryContext *>(raw_context);
    if (context == nullptr) {
        return PETSC_SUCCESS;
    }
    if (context->snapshot.unsafe || context->cleanup_failed ||
        fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked() ||
        (context->true_convergence_context != nullptr &&
         (context->true_convergence_context->cleanup_failed ||
          context->true_convergence_context->
              candidate_operator_diagnostic_cleanup_failed))) {
        mark_floquet_certified_recovery_quarantined(context);
        return context->snapshot.cleanup_error != PETSC_SUCCESS
            ? context->snapshot.cleanup_error
            : PETSC_ERR_LIB;
    }
    const SLEPcModalDestroyOperation operations[] = {
        {context, destroy_floquet_certified_recovery_ksp},
        {context, destroy_floquet_certified_recovery_solution_backup},
        {context, destroy_floquet_certified_recovery_residual},
    };
    if (!run_slepc_modal_destroy_sequence(
            operations,
            sizeof(operations) / sizeof(operations[0]),
            mark_floquet_certified_recovery_quarantined,
            context)) {
        context->cleanup_failed = true;
        return context->snapshot.cleanup_error != PETSC_SUCCESS
            ? context->snapshot.cleanup_error
            : PETSC_ERR_LIB;
    }
    delete context;
    return PETSC_SUCCESS;
}

inline PetscErrorCode create_floquet_shifted_ksp_certified_recovery_shell(
    PC outer_pc,
    KSP inner_ksp,
    FloquetShiftedKspTrueConvergenceContext *true_convergence_context,
    FloquetShiftedKspCertifiedRecoveryContext **result)
{
    if (outer_pc == nullptr || inner_ksp == nullptr ||
        true_convergence_context == nullptr || result == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    *result = nullptr;
    if (fullmag::fem::runtime::petsc_slepc_process_is_unsafe_locked()) {
        return PETSC_ERR_LIB;
    }
    if (true_convergence_context->cleanup_failed ||
        true_convergence_context->candidate_operator_diagnostic_cleanup_failed ||
        true_convergence_context->candidate_solution == nullptr ||
        true_convergence_context->true_residual == nullptr) {
        return true_convergence_context->cleanup_error != PETSC_SUCCESS
            ? true_convergence_context->cleanup_error
            : PETSC_ERR_ARG_WRONGSTATE;
    }

    const char *pc_type = nullptr;
    PetscErrorCode error = PCGetType(outer_pc, &pc_type);
    if (error != PETSC_SUCCESS) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        return error;
    }
    if (pc_type == nullptr || std::strcmp(pc_type, PCSHELL) != 0) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }
    void *existing_context = nullptr;
    error = PCShellGetContext(outer_pc, &existing_context);
    if (error != PETSC_SUCCESS) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        return error;
    }
    if (existing_context != nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }

    auto *context = new (std::nothrow) FloquetShiftedKspCertifiedRecoveryContext{};
    if (context == nullptr) {
        return PETSC_ERR_MEM;
    }
    context->true_convergence_context = true_convergence_context;
    error = KSPGetTolerances(
        inner_ksp,
        &context->snapshot.original_rtol,
        &context->snapshot.original_atol,
        &context->snapshot.original_dtol,
        &context->snapshot.original_max_iterations);
    if (error != PETSC_SUCCESS) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        delete context;
        return error;
    }
    if (context->snapshot.original_max_iterations <= 0 ||
        !std::isfinite(static_cast<double>(context->snapshot.original_rtol)) ||
        !std::isfinite(static_cast<double>(context->snapshot.original_atol)) ||
        context->snapshot.original_rtol < 0.0 ||
        context->snapshot.original_atol < 0.0) {
        delete context;
        return PETSC_ERR_ARG_OUTOFRANGE;
    }
    error = KSPGetInitialGuessNonzero(
        inner_ksp,
        &context->original_initial_guess_nonzero);
    if (error != PETSC_SUCCESS) {
        fullmag::fem::runtime::mark_petsc_slepc_process_unsafe_locked();
        delete context;
        return error;
    }
    context->snapshot.original_settings_available = true;
    context->snapshot.inner_ksp = inner_ksp;

    // Keep the raw handle in the intentionally leaked quarantine owner before
    // attempting the reference operation: a failed PETSc call is ambiguous,
    // so no later teardown may guess whether its reference count changed.
    context->inner_ksp = inner_ksp;
    context->snapshot.inner_ksp = inner_ksp;
    error = PetscObjectReference(reinterpret_cast<PetscObject>(inner_ksp));
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        // The reference operation may have changed PETSc ownership before
        // returning its error. Retain the owner and do not guess.
        return error;
    }

    error = KSPSetErrorIfNotConverged(inner_ksp, PETSC_FALSE);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    error = PCShellSetSetUp(
        outer_pc,
        floquet_shifted_certified_recovery_shell_setup);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    error = PCShellSetApply(
        outer_pc,
        floquet_shifted_certified_recovery_shell_apply);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    error = PCShellSetDestroy(
        outer_pc,
        destroy_floquet_shifted_ksp_certified_recovery_shell);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    error = PCShellSetContext(outer_pc, context);
    if (error != PETSC_SUCCESS) {
        mark_floquet_certified_recovery_unsafe(context, error);
        return error;
    }
    *result = context;
    return PETSC_SUCCESS;
}

inline const FloquetShiftedKspCertifiedRecoverySnapshot *
floquet_shifted_ksp_certified_recovery_snapshot(
    const FloquetShiftedKspCertifiedRecoveryContext *context) noexcept
{
    return context != nullptr ? &context->snapshot : nullptr;
}

inline KSP floquet_shifted_ksp_certified_recovery_inner_ksp(
    FloquetShiftedKspCertifiedRecoveryContext *context) noexcept
{
    return context != nullptr ? context->inner_ksp : nullptr;
}

} // namespace fullmag::fem::frequency_domain::detail
