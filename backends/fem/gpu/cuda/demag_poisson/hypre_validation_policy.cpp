#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"

#include <cstdlib>
#include <cstring>

namespace fullmag::fem {

bool should_validate_independent_residual(
    bool solver_reported_converged,
    bool forced) noexcept
{
    return !solver_reported_converged || forced;
}

bool read_force_independent_residual_validation(
    bool &forced,
    std::string &error)
{
    forced = false;
    const char *value = std::getenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL");
    if (value == nullptr || std::strcmp(value, "0") == 0) {
        return true;
    }
    if (std::strcmp(value, "1") == 0) {
        forced = true;
        return true;
    }
    error = "FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL expected 0 or 1";
    return false;
}

HypreResidualValidationNeeds resolve_hypre_residual_validation_needs(
    bool solver_reported_converged,
    bool has_absolute_tolerance,
    bool force_independent_validation) noexcept
{
    const bool independent_residual = should_validate_independent_residual(
        solver_reported_converged, force_independent_validation);
    return HypreResidualValidationNeeds{
        independent_residual || has_absolute_tolerance,
        independent_residual,
    };
}

} // namespace fullmag::fem
