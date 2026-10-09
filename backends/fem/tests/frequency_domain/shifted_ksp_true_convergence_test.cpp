#include "shifted_ksp_true_convergence.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>


namespace detail = fullmag::fem::frequency_domain::detail;

namespace {

bool check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
    }
    return condition;
}

bool check_petsc(PetscErrorCode error, const char *message)
{
    if (error == 0) {
        return true;
    }
    std::fprintf(stderr, "FAIL: %s (PETSc error %d)\n",
                 message, static_cast<int>(error));
    return false;
}

struct CandidateDiagnosticCleanupProbe {
    int destroy_calls = 0;
};

PetscErrorCode fail_candidate_diagnostic_cleanup(void **raw_context)
{
    if (raw_context == nullptr || *raw_context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *probe = static_cast<CandidateDiagnosticCleanupProbe *>(*raw_context);
    ++probe->destroy_calls;
    return PETSC_ERR_LIB;
}

bool candidate_diagnostic_cleanup_failure_is_not_retried()
{
    detail::FloquetShiftedKspTrueConvergenceContext context{};
    CandidateDiagnosticCleanupProbe probe{};
    context.candidate_operator_diagnostic_context = &probe;
    context.candidate_operator_diagnostic_destroy =
        fail_candidate_diagnostic_cleanup;

    const PetscErrorCode first_error =
        detail::clear_floquet_shifted_ksp_true_convergence_context(&context);
    const bool first_preserved =
        first_error == PETSC_ERR_LIB &&
        context.candidate_operator_diagnostic_cleanup_failed &&
        context.cleanup_failed && context.cleanup_error == PETSC_ERR_LIB &&
        context.candidate_operator_diagnostic_context == &probe &&
        probe.destroy_calls == 1;
    const PetscErrorCode repeated_error =
        detail::clear_floquet_shifted_ksp_true_convergence_context(&context);
    const bool retry_blocked =
        repeated_error == PETSC_ERR_LIB && probe.destroy_calls == 1 &&
        context.candidate_operator_diagnostic_context == &probe;
    return check(first_preserved,
                 "candidate diagnostic cleanup failure retains its opaque owner") &&
        check(retry_blocked,
              "failed candidate diagnostic cleanup is not retried or dereferenced");
}

bool candidate_diagnostic_setup_transaction_fails_closed()
{
    int push_calls = 0;
    int setup_calls = 0;
    int cleanup_calls = 0;
    int pop_calls = 0;
    const auto push_failure = detail::run_floquet_candidate_diagnostic_setup_transaction(
        [&]() { ++push_calls; return PETSC_ERR_LIB; },
        [&]() { ++setup_calls; return PETSC_SUCCESS; },
        [&]() { ++cleanup_calls; return PETSC_SUCCESS; },
        [&]() { ++pop_calls; return PETSC_SUCCESS; });
    const bool push_failed_closed =
        push_failure.fatal_error == PETSC_ERR_LIB &&
        push_calls == 1 && setup_calls == 0 && cleanup_calls == 0 && pop_calls == 0;

    push_calls = setup_calls = cleanup_calls = pop_calls = 0;
    const auto cleanup_and_pop_failure =
        detail::run_floquet_candidate_diagnostic_setup_transaction(
            [&]() { ++push_calls; return PETSC_SUCCESS; },
            [&]() { ++setup_calls; return PETSC_ERR_ARG_WRONGSTATE; },
            [&]() { ++cleanup_calls; return PETSC_ERR_LIB; },
            [&]() { ++pop_calls; return PETSC_ERR_FP; });
    const bool first_cleanup_error_preserved =
        cleanup_and_pop_failure.setup_error == PETSC_ERR_ARG_WRONGSTATE &&
        cleanup_and_pop_failure.cleanup_error == PETSC_ERR_LIB &&
        cleanup_and_pop_failure.pop_error == PETSC_ERR_FP &&
        cleanup_and_pop_failure.fatal_error == PETSC_ERR_LIB &&
        push_calls == 1 && setup_calls == 1 && cleanup_calls == 1 && pop_calls == 1;

    push_calls = setup_calls = cleanup_calls = pop_calls = 0;
    const auto pop_only_failure =
        detail::run_floquet_candidate_diagnostic_setup_transaction(
            [&]() { ++push_calls; return PETSC_SUCCESS; },
            [&]() { ++setup_calls; return PETSC_SUCCESS; },
            [&]() { ++cleanup_calls; return PETSC_SUCCESS; },
            [&]() { ++pop_calls; return PETSC_ERR_FP; });
    const bool pop_failure_is_fatal =
        pop_only_failure.fatal_error == PETSC_ERR_FP &&
        push_calls == 1 && setup_calls == 1 && cleanup_calls == 0 && pop_calls == 1;

    return check(push_failed_closed,
                 "failed diagnostic error-handler push does not run setup or continue") &&
        check(first_cleanup_error_preserved,
              "diagnostic cleanup error stays primary when error-handler pop also fails") &&
        check(pop_failure_is_fatal,
              "diagnostic error-handler pop failure is terminal after successful setup");
}

bool candidate_poisson_relative_residual_rejects_overflow()
{
    PetscReal relative = std::numeric_limits<PetscReal>::quiet_NaN();
    const PetscErrorCode finite_error =
        detail::calculate_floquet_relative_residual(0.5, 1.0, &relative);
    const bool finite_operands_are_reported =
        finite_error == PETSC_SUCCESS && relative == 0.5;

    relative = std::numeric_limits<PetscReal>::quiet_NaN();
    const PetscErrorCode overflow_error = detail::calculate_floquet_relative_residual(
        std::numeric_limits<PetscReal>::max(),
        std::numeric_limits<PetscReal>::min(),
        &relative);
    const bool overflow_is_unavailable =
        overflow_error == PETSC_ERR_FP && std::isnan(static_cast<double>(relative));
    return check(finite_operands_are_reported,
                 "finite Poisson residual operands produce their relative ratio") &&
        check(overflow_is_unavailable,
              "finite Poisson residual operands whose ratio overflows remain unavailable");
}


struct InjectedTrueConvergenceProbe {
    detail::FloquetShiftedKspTrueConvergenceContext *context = nullptr;
    void *default_context = nullptr;
    Mat matrix = nullptr;
    Vec independent_residual = nullptr;
    PetscInt oracle_positive_count = 0;
    PetscInt withheld_count = 0;
    PetscInt accepted_count = 0;
};

PetscErrorCode inject_tiny_recursive_norm_into_true_callback(
    KSP ksp,
    PetscInt iteration,
    PetscReal recursive_residual_norm,
    KSPConvergedReason *reason,
    void *raw_probe)
{
    if (raw_probe == nullptr || reason == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *probe = static_cast<InjectedTrueConvergenceProbe *>(raw_probe);
    if (probe->context == nullptr || probe->default_context == nullptr ||
        probe->matrix == nullptr || probe->independent_residual == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }

    const PetscReal injected_recursive_norm = iteration > 0
        ? static_cast<PetscReal>(1.0e-30)
        : recursive_residual_norm;
    KSPConvergedReason oracle_reason = KSP_CONVERGED_ITERATING;
    PetscErrorCode error = KSPConvergedDefault(
        ksp,
        iteration,
        injected_recursive_norm,
        &oracle_reason,
        probe->default_context);
    if (error != 0) {
        return error;
    }
    if (iteration > 0) {
        if (oracle_reason <= 0) {
            return PETSC_ERR_PLIB;
        }
        ++probe->oracle_positive_count;
    }

    error = detail::floquet_shifted_true_convergence_test(
        ksp,
        iteration,
        injected_recursive_norm,
        reason,
        probe->context);
    if (error != 0 || iteration <= 0) {
        return error;
    }

    Vec rhs = nullptr;
    error = KSPGetRhs(ksp, &rhs);
    if (error != 0) {
        return error;
    }
    if (rhs == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }
    error = MatMult(
        probe->matrix,
        probe->context->candidate_solution,
        probe->independent_residual);
    if (error != 0) {
        return error;
    }
    error = VecAYPX(probe->independent_residual, -1.0, rhs);
    if (error != 0) {
        return error;
    }

    PetscReal rhs_norm = 0.0;
    PetscReal residual_norm = 0.0;
    error = VecNorm(rhs, NORM_2, &rhs_norm);
    if (error != 0) {
        return error;
    }
    error = VecNorm(probe->independent_residual, NORM_2, &residual_norm);
    if (error != 0) {
        return error;
    }
    const PetscReal threshold = std::max(
        probe->context->atol,
        probe->context->rtol * rhs_norm);
    if (!std::isfinite(static_cast<double>(threshold))) {
        return PETSC_ERR_FP;
    }
    if (residual_norm > threshold) {
        if (*reason > 0) {
            return PETSC_ERR_PLIB;
        }
        if (*reason == KSP_CONVERGED_ITERATING) {
            ++probe->withheld_count;
        }
    } else if (*reason > 0) {
        ++probe->accepted_count;
    }
    return 0;
}

PetscErrorCode destroy_injected_true_convergence_probe_value(
    InjectedTrueConvergenceProbe *probe)
{
    if (probe == nullptr) {
        return 0;
    }
    PetscErrorCode first_error =
        detail::clear_floquet_shifted_ksp_true_convergence_context(
            probe->context);
    if (probe->default_context != nullptr) {
        const PetscErrorCode error =
            detail::destroy_floquet_ksp_default_convergence_context(
                &probe->default_context);
        if (first_error == 0) {
            first_error = error;
        }
    }
    return first_error;
}

#if PETSC_VERSION_LT(3, 24, 0)
PetscErrorCode destroy_injected_true_convergence_probe(void *raw_probe)
{
    return destroy_injected_true_convergence_probe_value(
        static_cast<InjectedTrueConvergenceProbe *>(raw_probe));
}
#else
PetscErrorCode destroy_injected_true_convergence_probe(void **raw_probe)
{
    if (raw_probe == nullptr) {
        return 0;
    }
    const PetscErrorCode error = destroy_injected_true_convergence_probe_value(
        static_cast<InjectedTrueConvergenceProbe *>(*raw_probe));
    *raw_probe = nullptr;
    return error;
}
#endif
bool exercise_recursive_gap_gate()
{
    KSP ksp = nullptr;
    void *default_context = nullptr;
    bool ok = true;

    if (!check_petsc(KSPCreate(PETSC_COMM_SELF, &ksp),
                     "create synthetic KSP")) {
        return false;
    }
    ok = ok && check_petsc(KSPSetType(ksp, KSPGMRES),
                           "set synthetic KSP type");
    ok = ok && check_petsc(KSPSetTolerances(
                               ksp, 1.0e-12, 0.0, PETSC_DEFAULT, 20),
                           "set synthetic KSP tolerances");
    ok = ok && check_petsc(KSPConvergedDefaultCreate(&default_context),
                           "create PETSc default convergence context");

    KSPConvergedReason provisional = KSP_CONVERGED_ITERATING;
    if (ok) {
        ok = check_petsc(KSPConvergedDefault(
                             ksp, 0, 1.0, &provisional, default_context),
                         "record synthetic initial recursive norm");
    }
    if (ok) {
        ok = check_petsc(KSPConvergedDefault(
                             ksp, 1, 1.0e-30, &provisional, default_context),
                         "feed tiny synthetic recursive norm");
    }
    ok = ok && check(provisional > 0,
                     "tiny recursive norm must produce a provisional positive reason");

    KSPConvergedReason rejected = provisional;
    if (ok) {
        ok = check_petsc(detail::apply_floquet_shifted_true_residual_gate(
                             1, 1.0, 1.0, &rejected, 1.0e-12, 0.0, 20),
                         "apply true-residual gate to false recursive convergence");
    }
    ok = ok && check(rejected == KSP_CONVERGED_ITERATING,
                     "large true residual must withhold provisional convergence");

    KSPConvergedReason accepted = provisional;
    if (ok) {
        ok = check_petsc(detail::apply_floquet_shifted_true_residual_gate(
                             1, 1.0, 1.0e-13, &accepted, 1.0e-12, 0.0, 20),
                         "apply true-residual gate to a valid candidate");
    }
    ok = ok && check(accepted == provisional,
                     "candidate meeting the true threshold keeps its positive reason");

    KSPConvergedReason exhausted = provisional;
    if (ok) {
        ok = check_petsc(detail::apply_floquet_shifted_true_residual_gate(
                             20, 1.0, 1.0, &exhausted, 1.0e-12, 0.0, 20),
                         "apply iteration-budget rule");
    }
    ok = ok && check(exhausted == KSP_DIVERGED_ITS,
                     "failed true residual at the budget must diverge on iteration count");

    KSPConvergedReason zero_rhs = KSP_CONVERGED_ATOL;
    if (ok) {
        ok = check_petsc(detail::apply_floquet_shifted_true_residual_gate(
                             1, 0.0, 0.0, &zero_rhs, 1.0e-12, 0.0, 20),
                         "apply exact zero-RHS threshold");
    }
    ok = ok && check(zero_rhs == KSP_CONVERGED_ATOL,
                     "zero RHS and zero residual satisfy an exact zero threshold");

    KSPConvergedReason nonzero_zero_rhs = KSP_CONVERGED_ATOL;
    if (ok) {
        ok = check_petsc(detail::apply_floquet_shifted_true_residual_gate(
                             1, 0.0, 1.0e-30, &nonzero_zero_rhs,
                             1.0e-12, 0.0, 20),
                         "reject nonzero residual at a zero threshold");
    }
    ok = ok && check(nonzero_zero_rhs == KSP_CONVERGED_ITERATING,
                     "nonzero residual must fail an exact zero threshold");

    KSPConvergedReason negative_budget = KSP_DIVERGED_ITS;
    if (ok) {
        ok = check_petsc(detail::apply_floquet_shifted_true_residual_gate(
                             20, 1.0, 0.0, &negative_budget,
                             1.0e-12, 0.0, 20),
                         "preserve PETSc negative budget reason");
    }
    ok = ok && check(negative_budget == KSP_DIVERGED_ITS,
                     "negative PETSc reasons remain final");

    if (default_context != nullptr) {
        ok = check_petsc(
                 detail::destroy_floquet_ksp_default_convergence_context(
                     &default_context),
                 "destroy synthetic PETSc default context") && ok;
    }
    if (ksp != nullptr) {
        ok = check_petsc(KSPDestroy(&ksp), "destroy synthetic KSP") && ok;
    }
    return ok;
}

bool run_ksp_case(
    const char *ksp_type,
    bool zero_rhs,
    PetscInt max_iterations,
    bool expect_convergence,
    bool force_tiny_recursive_norm = false,
    bool zero_operator = false,
    bool expect_build_breakdown = false)
{
    Mat matrix = nullptr;
    Vec solution = nullptr;
    Vec rhs = nullptr;
    Vec true_residual = nullptr;
    KSP ksp = nullptr;
    detail::FloquetShiftedKspTrueConvergenceContext *context = nullptr;
    InjectedTrueConvergenceProbe probe{};
    bool ok = true;

    const auto cleanup = [&]() {
        if (ksp != nullptr) {
            (void)KSPDestroy(&ksp);
        }
        if (context != nullptr) {
            (void)detail::clear_floquet_shifted_ksp_true_convergence_context(
                context);
            delete context;
            context = nullptr;
        }
        if (probe.default_context != nullptr) {
            (void)detail::destroy_floquet_ksp_default_convergence_context(
                &probe.default_context);
        }
        if (true_residual != nullptr) {
            (void)VecDestroy(&true_residual);
        }
        if (rhs != nullptr) {
            (void)VecDestroy(&rhs);
        }
        if (solution != nullptr) {
            (void)VecDestroy(&solution);
        }
        if (matrix != nullptr) {
            (void)MatDestroy(&matrix);
        }
    };
    const auto fail = [&](const char *message, PetscErrorCode error) {
        std::fprintf(stderr, "FAIL: %s", message);
        if (error != 0) {
            std::fprintf(stderr, " (PETSc error %d)", static_cast<int>(error));
        }
        std::fprintf(stderr, "\n");
        cleanup();
        return false;
    };

    PetscErrorCode error = MatCreateSeqAIJ(
        PETSC_COMM_SELF, 3, 3, 1, nullptr, &matrix);
    if (error != 0) {
        return fail("create test matrix", error);
    }
    if (!zero_operator) {
        for (PetscInt row = 0; row < 3; ++row) {
            error = MatSetValue(
                matrix, row, row, static_cast<PetscScalar>(1 << row),
                INSERT_VALUES);
            if (error != 0) {
                return fail("set test matrix diagonal", error);
            }
        }
    }
    error = MatAssemblyBegin(matrix, MAT_FINAL_ASSEMBLY);
    if (error == 0) {
        error = MatAssemblyEnd(matrix, MAT_FINAL_ASSEMBLY);
    }
    if (error != 0) {
        return fail("assemble test matrix", error);
    }
    error = MatCreateVecs(matrix, &solution, &rhs);
    if (error == 0) {
        error = VecDuplicate(rhs, &true_residual);
    }
    if (error != 0) {
        return fail("create test vectors", error);
    }
    error = VecSet(solution, 0.0);
    if (error == 0 && zero_rhs) {
        error = VecSet(rhs, 0.0);
    } else if (error == 0) {
        const PetscInt indices[3] = {0, 1, 2};
        const PetscScalar values[3] = {1.0, 1.0, 1.0};
        error = VecSetValues(rhs, 3, indices, values, INSERT_VALUES);
        if (error == 0) {
            error = VecAssemblyBegin(rhs);
        }
        if (error == 0) {
            error = VecAssemblyEnd(rhs);
        }
    }
    if (error != 0) {
        return fail("initialize test vectors", error);
    }

    error = KSPCreate(PETSC_COMM_SELF, &ksp);
    if (error == 0) {
        error = KSPSetOperators(ksp, matrix, matrix);
    }
    if (error == 0) {
        error = KSPSetType(ksp, ksp_type);
    }
    if (error == 0) {
        error = KSPGMRESSetRestart(ksp, 3);
    }
    if (error == 0) {
        error = KSPSetPCSide(ksp, PC_RIGHT);
    }
    if (error == 0) {
        error = KSPSetNormType(ksp, KSP_NORM_UNPRECONDITIONED);
    }
    PC pc = nullptr;
    if (error == 0) {
        error = KSPGetPC(ksp, &pc);
    }
    if (error == 0) {
        error = PCSetType(pc, PCNONE);
    }
    if (error == 0) {
        error = KSPSetTolerances(
            ksp, 1.0e-12, 0.0, PETSC_DEFAULT, max_iterations);
    }
    if (error == 0 && expect_build_breakdown) {
        error = KSPSetErrorIfNotConverged(ksp, PETSC_FALSE);
    }
    if (error == 0) {
        error = KSPSetInitialGuessNonzero(ksp, PETSC_FALSE);
    }
    if (error == 0) {
        error = detail::create_floquet_shifted_ksp_true_convergence_context(
            ksp, &context);
    }
    if (error == 0 && force_tiny_recursive_norm) {
        probe.context = context;
        probe.matrix = matrix;
        probe.independent_residual = true_residual;
        error = KSPConvergedDefaultCreate(&probe.default_context);
    }
    if (error == 0 && force_tiny_recursive_norm) {
        error = KSPSetConvergenceTest(
            ksp,
            inject_tiny_recursive_norm_into_true_callback,
            &probe,
            destroy_injected_true_convergence_probe);
    } else if (error == 0) {
        error = KSPSetConvergenceTest(
            ksp,
            detail::floquet_shifted_true_convergence_test,
            context,
            detail::destroy_floquet_shifted_ksp_true_convergence_context);
    }
    if (error != 0) {
        return fail("configure true-residual KSP", error);
    }

    error = KSPSolve(ksp, rhs, solution);
    if (error != 0) {
        return fail("solve test system", error);
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    error = KSPGetConvergedReason(ksp, &reason);
    if (error != 0) {
        return fail("read KSP convergence reason", error);
    }
    KSPConvergedReason callback_reason = KSP_CONVERGED_ITERATING;
    if (expect_build_breakdown) {
        if (!check(reason < 0,
                   "zero-operator KSPSolve exits with its original negative reason") ||
            !check(context->true_probe_attempt_count == 0 &&
                       !context->last_true_build_reason_available &&
                       !context->last_true_probe_available,
                   "GMRES breakdown precedes any positive-reason candidate probe")) {
            cleanup();
            return false;
        }
        const auto callback_count_before_probe = context->callback_count;
        error = detail::floquet_shifted_true_convergence_test(
            ksp, 1, 0.0, &callback_reason, context);
        if (error != 0) {
            return fail("exercise the production callback on the live breakdown KSP", error);
        }
        if (!check(context->callback_count == callback_count_before_probe + 1,
                   "explicit live probe adds exactly one production callback")) {
            cleanup();
            return false;
        }

    }
    const bool callback_snapshot_available = context->callback_count > 0;
    if (zero_rhs && !callback_snapshot_available) {
        if (!check(reason == KSP_CONVERGED_ATOL &&
                       !context->callback_observation_available &&
                       !context->last_default_reason_available &&
                       !context->last_reason_after_gate_available &&
                       context->true_probe_count == 0,
                   "zero initial residual may converge before the callback runs")) {
            cleanup();
            return false;
        }
    } else if (!check(callback_snapshot_available &&
                          context->callback_observation_available &&
                          context->last_callback_iteration >= 0 &&
                          context->last_default_reason_available &&
                          (expect_build_breakdown
                               ? !context->last_reason_after_gate_available
                               : context->last_reason_after_gate_available),
                      "callback snapshot retains its latest iteration and only records a gate reason when the gate ran")) {
        cleanup();
        return false;
    }

    if (expect_convergence) {
        if (!check(reason > 0, "GMRES/FGMRES true solve must converge") ||
            !check_petsc(MatMult(matrix, solution, true_residual),
                         "compute final test residual") ||
            !check_petsc(VecAYPX(true_residual, -1.0, rhs),
                         "form final test residual")) {
            cleanup();
            return false;
        }
        PetscReal rhs_norm = 0.0;
        PetscReal residual_norm = 0.0;
        if (!check_petsc(VecNorm(rhs, NORM_2, &rhs_norm),
                         "compute test RHS norm") ||
            !check_petsc(VecNorm(true_residual, NORM_2, &residual_norm),
                         "compute final true residual norm") ||
            !check(residual_norm <= std::max(
                       static_cast<PetscReal>(0.0),
                       static_cast<PetscReal>(1.0e-12) * rhs_norm),
                   "reported positive reason must pass the true threshold")) {
            cleanup();
            return false;
        }
        if (callback_snapshot_available) {
            const PetscReal expected_probe_threshold = std::max(
                context->atol,
                context->rtol * context->last_true_rhs_norm);
            if (!check(context->last_true_probe_available &&
                           context->last_true_build_reason_available &&
                           context->last_true_build_reason == static_cast<int>(KSP_CONVERGED_ITERATING) &&
                           (zero_rhs || (context->last_true_solution_norm_available &&
                                         context->last_true_solution_norm > 0.0)) &&
                           context->true_probe_count > 0 &&
                           context->last_true_probe_default_reason_available &&
                           context->last_true_probe_reason_after_gate_available &&
                           context->last_true_probe_iteration >= 0 &&
                           std::isfinite(static_cast<double>(context->last_true_rhs_norm)) &&
                           std::isfinite(static_cast<double>(context->last_true_residual_norm)) &&
                           context->last_true_residual_threshold == expected_probe_threshold,
                       "true-probe snapshot retains finite live norms and the exact unchanged gate threshold")) {
                cleanup();
                return false;
            }
            if (!check(context->last_true_probe_callback_ordinal <=
                           context->callback_count,
                       "true-probe callback ordinal stays within the KSP callback history")) {
                cleanup();
                return false;
            }
            if (context->last_true_probe_callback_ordinal ==
                context->callback_count) {
                if (!check(context->last_true_probe_reason_after_gate ==
                               context->last_reason_after_gate,
                           "same-iteration callback and true-probe reasons remain paired")) {
                    cleanup();
                    return false;
                }
            }
            if (zero_rhs &&
                !check(context->last_true_residual_threshold == 0.0 &&
                           !context->last_true_tolerance_ratio_available,
                       "zero-threshold probe keeps its ratio unavailable instead of fabricating a value")) {
                cleanup();
                return false;
            }
            if (!zero_rhs && context->last_true_residual_threshold > 0.0) {
                const PetscReal expected_ratio =
                    context->last_true_residual_norm /
                    context->last_true_residual_threshold;
                if (!check(context->last_true_tolerance_ratio_available &&
                               context->last_true_tolerance_ratio == expected_ratio,
                           "positive-threshold probe records only its measured residual ratio")) {
                    cleanup();
                    return false;
                }
            }
        } else if (!check(zero_rhs && context->true_probe_count == 0 &&
                              !context->last_true_probe_available,
                          "zero-RHS fast path does not fabricate callback probe data")) {
            cleanup();
            return false;
        }

        if (force_tiny_recursive_norm) {
            if (!check(probe.oracle_positive_count > 0,
                       "injected recursive norm must produce positive defaults") ||
                !check(probe.withheld_count > 0,
                       "large live residual must be withheld by the registered callback") ||
                !check(probe.accepted_count > 0,
                       "a later live candidate must pass the true-residual gate")) {
                cleanup();
                return false;
            }

            // Reuse the same KSP and callback workspace with a different RHS.
            error = detail::destroy_floquet_ksp_default_convergence_context(
                &probe.default_context);
            if (error != 0) {
                return fail("reset oracle convergence context", error);
            }
            error = KSPConvergedDefaultCreate(&probe.default_context);
            if (error != 0) {
                return fail("recreate oracle convergence context", error);
            }
            probe.oracle_positive_count = 0;
            probe.withheld_count = 0;
            probe.accepted_count = 0;
            error = VecSet(solution, 0.0);
            if (error == 0) {
                error = VecSet(rhs, 0.0);
            }
            const PetscInt indices[3] = {0, 1, 2};
            const PetscScalar second_values[3] = {2.0, -1.5, 0.25};
            if (error == 0) {
                error = VecSetValues(
                    rhs, 3, indices, second_values, INSERT_VALUES);
            }
            if (error == 0) {
                error = VecAssemblyBegin(rhs);
            }
            if (error == 0) {
                error = VecAssemblyEnd(rhs);
            }
            if (error == 0) {
                error = KSPSolve(ksp, rhs, solution);
            }
            if (error != 0) {
                return fail("solve second RHS with reused true-gate context", error);
            }
            reason = KSP_CONVERGED_ITERATING;
            error = KSPGetConvergedReason(ksp, &reason);
            if (error != 0) {
                return fail("read second-RHS convergence reason", error);
            }
            if (!check(reason > 0,
                       "second RHS must eventually converge with the same KSP") ||
                !check(probe.oracle_positive_count > 0,
                       "second RHS receives injected positive recursive reasons") ||
                !check(probe.withheld_count > 0,
                       "second RHS large live residual is withheld") ||
                !check(probe.accepted_count > 0,
                       "second RHS later passes using its current candidate")) {
                cleanup();
                return false;
            }

            if (!check_petsc(MatMult(matrix, solution, true_residual),
                             "compute second-RHS true residual") ||
                !check_petsc(VecAYPX(true_residual, -1.0, rhs),
                             "form second-RHS true residual")) {
                cleanup();
                return false;
            }
            rhs_norm = 0.0;
            residual_norm = 0.0;
            if (!check_petsc(VecNorm(rhs, NORM_2, &rhs_norm),
                             "compute second-RHS norm") ||
                !check_petsc(VecNorm(true_residual, NORM_2, &residual_norm),
                             "compute second-RHS residual norm") ||
                !check(residual_norm <= 1.0e-12 * rhs_norm,
                       "second RHS positive reason must meet its current tolerance")) {
                cleanup();
                return false;
            }
        }
    } else if (expect_build_breakdown) {
        if (!check(reason < 0,
                   "real zero-operator KSPSolve keeps its negative exit reason") ||
            !check(callback_reason == KSP_DIVERGED_BREAKDOWN,
                   "production callback preserves GMRES build-solution breakdown") ||
            !check(context->true_probe_attempt_count > 0 &&
                       context->last_true_probe_default_reason_available &&
                       context->last_true_probe_default_reason > 0 &&
                       context->last_true_build_reason_available &&
                       context->last_true_build_reason ==
                           static_cast<int>(KSP_DIVERGED_BREAKDOWN),
                   "successful solution-build call records its live negative KSP reason") ||
            !check(!context->last_true_probe_available &&
                       context->true_probe_count == 0 &&
                       context->true_probe_measurement_failure_count == 0,
                   "breakdown does not count as a completed or failed vector measurement") ||
            !check(!context->last_true_solution_norm_available &&
                       std::isnan(static_cast<double>(
                           context->last_true_solution_norm)) &&
                       !context->last_true_operator_action_norm_available &&
                       std::isnan(static_cast<double>(
                           context->last_true_operator_action_norm)),
                   "breakdown leaves solution and operator-action norms unavailable") ||
            !check(!context->last_true_probe_reason_after_gate_available &&
                       !context->last_reason_after_gate_available,
                   "breakdown exits before recording a true-residual gate result")) {
            cleanup();
            return false;
        }
    } else if (!check(reason == KSP_DIVERGED_ITS,
                      "one-iteration budget must retain DIVERGED_ITS")) {
        cleanup();
        return false;
    }

    cleanup();
    return ok;
}

} // namespace

int main(int argc, char **argv)
{
    PetscErrorCode error = PetscInitialize(&argc, &argv, nullptr, nullptr);
    if (error != 0) {
        std::fprintf(stderr, "FAIL: initialize PETSc (error %d)\n",
                     static_cast<int>(error));
        return 1;
    }

    bool ok = candidate_diagnostic_cleanup_failure_is_not_retried();
    ok = candidate_diagnostic_setup_transaction_fails_closed() && ok;
    ok = candidate_poisson_relative_residual_rejects_overflow() && ok;
    ok = exercise_recursive_gap_gate() && ok;
    ok = run_ksp_case(KSPGMRES, false, 30, true) && ok;
    ok = run_ksp_case(KSPGMRES, false, 30, false, false, true, true) && ok;
    ok = run_ksp_case(KSPGMRES, false, 30, true, true) && ok;
    ok = run_ksp_case(KSPFGMRES, false, 30, true) && ok;
    ok = run_ksp_case(KSPGMRES, true, 30, true) && ok;
    ok = run_ksp_case(KSPGMRES, false, 1, false) && ok;

    error = PetscFinalize();
    if (error != 0) {
        std::fprintf(stderr, "FAIL: finalize PETSc (error %d)\n",
                     static_cast<int>(error));
        ok = false;
    }
    if (ok) {
        std::puts("PASS: shifted KSP true-convergence regression");
        return 0;
    }
    return 1;
}
