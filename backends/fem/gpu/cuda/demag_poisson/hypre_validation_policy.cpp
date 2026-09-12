#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"

namespace fullmag::fem {

HypreResidualValidationNeeds resolve_hypre_residual_validation_needs(
    bool solver_reported_converged,
    bool has_absolute_tolerance,
    bool force_independent_validation) noexcept
{
    const bool independent_residual =
        !solver_reported_converged || force_independent_validation;
    return HypreResidualValidationNeeds{
        independent_residual || has_absolute_tolerance,
        independent_residual,
    };
}

} // namespace fullmag::fem
