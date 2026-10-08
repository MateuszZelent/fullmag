#include "shifted_ksp_true_convergence.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>


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

PetscErrorCode destroy_injected_true_convergence_probe(
    detail::FloquetPetscContextDestroyArgument raw_context)
{
    void *raw_probe = detail::borrow_floquet_petsc_destroy_context(raw_context);
    if (raw_probe == nullptr) {
        return 0;
    }
    auto *probe = static_cast<InjectedTrueConvergenceProbe *>(raw_probe);
    PetscErrorCode first_error =
        detail::clear_floquet_shifted_ksp_true_convergence_context(
            probe->context);
    if (probe->default_context != nullptr) {
        const PetscErrorCode error =
            detail::destroy_floquet_ksp_default_context(probe->default_context);
        probe->default_context = nullptr;
        if (first_error == 0) {
            first_error = error;
        }
    }
    return first_error;
}
PetscErrorCode legacy_destroy_abi_probe(void *context)
{
    ++*static_cast<int *>(context);
    return 0;
}

PetscErrorCode current_destroy_abi_probe(void **context)
{
    ++*static_cast<int *>(*context);
    *context = nullptr;
    return 0;
}

bool exercise_destroy_context_abis()
{
    int legacy_calls = 0;
    void *legacy_context = &legacy_calls;
    bool ok = check_petsc(detail::invoke_floquet_petsc_context_destroy(
        legacy_destroy_abi_probe, legacy_context), "legacy void* destroy ABI");
    ok = check(legacy_calls == 1 && legacy_context == nullptr,
               "legacy destroy clears its slot exactly once") && ok;
    ok = check_petsc(detail::invoke_floquet_petsc_context_destroy(
        legacy_destroy_abi_probe, legacy_context), "legacy repeated cleanup") && ok;
    ok = check(legacy_calls == 1, "legacy repeated cleanup is idempotent") && ok;
    int current_calls = 0;
    void *current_context = &current_calls;
    ok = check_petsc(detail::invoke_floquet_petsc_context_destroy(
        current_destroy_abi_probe, current_context), "current void** destroy ABI") && ok;
    ok = check(current_calls == 1 && current_context == nullptr,
               "current destroy receives and clears its slot") && ok;
    ok = check_petsc(detail::invoke_floquet_petsc_context_destroy(
        current_destroy_abi_probe, current_context), "current repeated cleanup") && ok;
    ok = check(current_calls == 1, "current repeated cleanup is idempotent") && ok;
    void *borrowed = &current_calls;
    ok = check(detail::borrow_floquet_petsc_destroy_context(&borrowed) == &current_calls
               && borrowed == nullptr, "callback clears the PETSc slot without freeing caller storage") && ok;
    return ok;
}

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
        ok = check_petsc(detail::destroy_floquet_ksp_default_context(default_context),
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
    bool force_tiny_recursive_norm = false)
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
            (void)detail::destroy_floquet_ksp_default_context(probe.default_context);
            probe.default_context = nullptr;
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
    for (PetscInt row = 0; row < 3; ++row) {
        error = MatSetValue(
            matrix, row, row, static_cast<PetscScalar>(1 << row),
            INSERT_VALUES);
        if (error != 0) {
            return fail("set test matrix diagonal", error);
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
            error = detail::destroy_floquet_ksp_default_context(probe.default_context);
            if (error != 0) {
                return fail("reset oracle convergence context", error);
            }
            probe.default_context = nullptr;
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

    bool ok = exercise_destroy_context_abis();
    ok = exercise_recursive_gap_gate() && ok;
    ok = run_ksp_case(KSPGMRES, false, 30, true) && ok;
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