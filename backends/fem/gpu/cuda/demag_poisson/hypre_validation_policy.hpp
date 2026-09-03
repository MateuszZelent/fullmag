#pragma once

/*
 * Pure policy for deciding which HYPRE residual validation work is required.
 *
 * The solver-reported relative residual remains authoritative for the normal
 * converged path.  An absolute tolerance needs the RHS norm, while a failed
 * or explicitly forced validation path needs an independent A*x-b residual.
 */

#include <string>

namespace fullmag::fem {

struct HypreResidualValidationNeeds {
    bool rhs_norm = false;
    bool independent_residual = false;
};

bool should_validate_independent_residual(
    bool solver_reported_converged,
    bool forced) noexcept;

bool read_force_independent_residual_validation(
    bool &forced,
    std::string &error);

HypreResidualValidationNeeds resolve_hypre_residual_validation_needs(
    bool solver_reported_converged,
    bool has_absolute_tolerance,
    bool force_independent_validation) noexcept;

} // namespace fullmag::fem
