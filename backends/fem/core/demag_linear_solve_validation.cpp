#include "core/demag_linear_solve_validation.hpp"

#include <cmath>
#include <iomanip>
#include <sstream>

namespace fullmag::fem {

bool validate_demag_linear_solve_result(
    const DemagLinearSolveResult &result,
    std::string &error)
{
    const bool relative_residual_valid =
        std::isfinite(result.relative_residual) && result.relative_residual >= 0.0;
    const bool absolute_residual_valid =
        !result.has_absolute_residual ||
        (std::isfinite(result.absolute_residual) && result.absolute_residual >= 0.0);
    const bool relative_converged =
        relative_residual_valid &&
        std::isfinite(result.relative_tolerance) &&
        result.relative_tolerance > 0.0 &&
        result.relative_residual <= result.relative_tolerance;
    const bool absolute_converged =
        result.has_absolute_tolerance &&
        result.has_absolute_residual &&
        absolute_residual_valid &&
        std::isfinite(result.absolute_tolerance) &&
        result.absolute_tolerance > 0.0 &&
        result.absolute_residual <= result.absolute_tolerance;
    const bool iterations_valid =
        result.iterations >= 0 &&
        result.max_iterations > 0 &&
        static_cast<uint32_t>(result.iterations) <= result.max_iterations;

    if (result.solver_reported_converged &&
        relative_residual_valid &&
        absolute_residual_valid &&
        iterations_valid &&
        (relative_converged || absolute_converged)) {
        return true;
    }

    std::ostringstream message;
    message << std::setprecision(17)
            << "FEM demag linear solve rejected: solver_kind=" << result.solver_kind
            << ", solver_reported_converged="
            << (result.solver_reported_converged ? "true" : "false")
            << ", iterations=" << result.iterations
            << ", residual=" << result.relative_residual
            << ", relative_tolerance=" << result.relative_tolerance
            << ", absolute_residual=";
    if (result.has_absolute_residual) {
        message << result.absolute_residual;
    } else {
        message << "unavailable";
    }
    message << ", absolute_tolerance=";
    if (result.has_absolute_tolerance) {
        message << result.absolute_tolerance;
    } else {
        message << "disabled";
    }
    message << ", max_iterations=" << result.max_iterations;
    error = message.str();
    return false;
}

} // namespace fullmag::fem
