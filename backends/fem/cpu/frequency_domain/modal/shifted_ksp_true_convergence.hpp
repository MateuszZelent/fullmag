#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <new>

#include <petscksp.h>

namespace fullmag::fem::frequency_domain::detail {

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
    bool last_true_probe_available = false;
    std::uint64_t last_true_probe_callback_ordinal = 0;
    PetscInt last_true_probe_iteration = -1;
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
    const PetscErrorCode error =
        KSPConvergedDefaultDestroy(*default_context);
#else
    const PetscErrorCode error = KSPConvergedDefaultDestroy(default_context);
#endif
    *default_context = nullptr;
    return error;
}

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
            destroy_floquet_ksp_default_convergence_context(
                &context->default_context);
        if (first_error == 0) {
            first_error = error;
        }
    }
    return first_error;
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
    *raw_context = nullptr;
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

    PetscErrorCode error = KSPConvergedDefault(
        ksp,
        iteration,
        recursive_residual_norm,
        reason,
        context->default_context);
    if (error != 0) {
        return error;
    }
    context->callback_observation_available = true;
    context->last_default_reason_available = true;
    context->last_default_reason = static_cast<int>(*reason);
    if (*reason <= 0) {
        context->last_reason_after_gate_available = true;
        context->last_reason_after_gate = static_cast<int>(*reason);
        return 0;
    }
    context->last_reason_after_gate_available = false;

    ++context->true_probe_attempt_count;
    context->last_true_probe_available = false;
    context->last_true_tolerance_ratio_available = false;
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
    context->last_true_probe_default_reason = static_cast<int>(*reason);
    context->last_true_probe_reason_after_gate_available = false;
    context->last_true_probe_recursive_residual_available =
        std::isfinite(static_cast<double>(recursive_residual_norm));
    context->last_true_probe_recursive_residual_norm =
        context->last_true_probe_recursive_residual_available
            ? recursive_residual_norm
            : std::numeric_limits<PetscReal>::quiet_NaN();

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
    error = MatMult(
        operator_matrix,
        context->candidate_solution,
        context->true_residual);
    if (error != 0) {
        return record_probe_failure(error);
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
    const int default_reason = static_cast<int>(*reason);
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
    context->last_default_reason = default_reason;
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
