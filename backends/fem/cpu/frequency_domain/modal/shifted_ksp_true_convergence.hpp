#pragma once

#include <algorithm>
#include <cmath>
#include <new>
#include <type_traits>

#include <petscksp.h>

namespace fullmag::fem::frequency_domain::detail {

// PETSc headers are the ABI authority: older releases accept void*, while
// PetscCtxDestroyFn accepts void**. Do not guess a PETSC_VERSION threshold.
template <typename FunctionPointer>
struct FloquetPetscDestroyArgument;

template <typename Return, typename Argument>
struct FloquetPetscDestroyArgument<Return (*)(Argument)> {
    using type = Argument;
};
using FloquetPetscContextDestroyArgument =
    typename FloquetPetscDestroyArgument<decltype(&KSPConvergedDefaultDestroy)>::type;

inline void *borrow_floquet_petsc_destroy_context(void *context)
{
    return context;
}

inline void *borrow_floquet_petsc_destroy_context(void **context)
{
    if (context == nullptr) {
        return nullptr;
    }
    void *borrowed = *context;
    *context = nullptr;
    return borrowed;
}

template <typename Destroy>
inline PetscErrorCode invoke_floquet_petsc_context_destroy(
    Destroy destroy,
    void *&context)
{
    if (context == nullptr) {
        return 0;
    }
    using Argument = typename FloquetPetscDestroyArgument<Destroy>::type;
    static_assert(std::is_same_v<Argument, void *> || std::is_same_v<Argument, void **>,
                  "Unsupported PETSc context destroy ABI");
    PetscErrorCode error = 0;
    if constexpr (std::is_same_v<Argument, void **>) {
        error = destroy(&context);
    } else {
        error = destroy(context);
    }
    context = nullptr;
    return error;
}

inline PetscErrorCode destroy_floquet_ksp_default_context(void *&context)
{
    return invoke_floquet_petsc_context_destroy(&KSPConvergedDefaultDestroy, context);
}

struct FloquetShiftedKspTrueConvergenceContext {
    void *default_context = nullptr;
    Vec candidate_solution = nullptr;
    Vec true_residual = nullptr;
    PetscReal rtol = 0.0;
    PetscReal atol = 0.0;
    PetscInt max_iterations = 0;
};

inline PetscErrorCode clear_floquet_shifted_ksp_true_convergence_context(
    FloquetShiftedKspTrueConvergenceContext *context)
{
    if (context == nullptr) {
        return 0;
    }

    PetscErrorCode first_error = 0;
    if (context->true_residual != nullptr) {
        const PetscErrorCode error = VecDestroy(&context->true_residual);
        context->true_residual = nullptr;
        if (first_error == 0) {
            first_error = error;
        }
    }
    if (context->candidate_solution != nullptr) {
        const PetscErrorCode error = VecDestroy(&context->candidate_solution);
        context->candidate_solution = nullptr;
        if (first_error == 0) {
            first_error = error;
        }
    }
    if (context->default_context != nullptr) {
        const PetscErrorCode error =
            destroy_floquet_ksp_default_context(context->default_context);
        context->default_context = nullptr;
        if (first_error == 0) {
            first_error = error;
        }
    }
    return first_error;
}

inline PetscErrorCode destroy_floquet_shifted_ksp_true_convergence_context(
    FloquetPetscContextDestroyArgument raw_context)
{
    // The solver retains the outer allocation until KSP/EPS cleanup finishes.
    // PETSc owns the callback slot and nested default context, not that allocation.
    return clear_floquet_shifted_ksp_true_convergence_context(
        static_cast<FloquetShiftedKspTrueConvergenceContext *>(
            borrow_floquet_petsc_destroy_context(raw_context)));
}

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
        (void)clear_floquet_shifted_ksp_true_convergence_context(context);
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
    PetscInt max_iterations)
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

    PetscErrorCode error = KSPConvergedDefault(
        ksp,
        iteration,
        recursive_residual_norm,
        reason,
        context->default_context);
    if (error != 0 || *reason <= 0) {
        return error;
    }

    Mat operator_matrix = nullptr;
    Vec rhs = nullptr;
    error = KSPGetOperators(ksp, &operator_matrix, nullptr);
    if (error != 0) {
        return error;
    }
    if (operator_matrix == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }
    error = KSPGetRhs(ksp, &rhs);
    if (error != 0) {
        return error;
    }
    if (rhs == nullptr) {
        return PETSC_ERR_ARG_WRONGSTATE;
    }

    error = KSPBuildSolution(ksp, context->candidate_solution, nullptr);
    if (error != 0) {
        return error;
    }
    error = MatMult(
        operator_matrix,
        context->candidate_solution,
        context->true_residual);
    if (error != 0) {
        return error;
    }
    // VecAYPX(y, -1, b) computes y <- b - y.
    error = VecAYPX(context->true_residual, -1.0, rhs);
    if (error != 0) {
        return error;
    }

    PetscReal rhs_norm = 0.0;
    PetscReal residual_norm = 0.0;
    error = VecNorm(rhs, NORM_2, &rhs_norm);
    if (error != 0) {
        return error;
    }
    error = VecNorm(context->true_residual, NORM_2, &residual_norm);
    if (error != 0) {
        return error;
    }

    return apply_floquet_shifted_true_residual_gate(
        iteration,
        rhs_norm,
        residual_norm,
        reason,
        context->rtol,
        context->atol,
        context->max_iterations);
}

} // namespace fullmag::fem::frequency_domain::detail