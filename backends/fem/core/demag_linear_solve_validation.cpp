#include "core/demag_linear_solve_validation.hpp"

#include <cmath>
#include <iomanip>
#include <sstream>

namespace fullmag::fem {

const char *to_string(DemagResidualNormKind kind) noexcept
{
    switch (kind) {
    case DemagResidualNormKind::L2:
        return "L2";
    case DemagResidualNormKind::Preconditioned:
        return "preconditioned";
    case DemagResidualNormKind::Unknown:
    default:
        return "unknown";
    }
}

const char *to_string(DemagResidualCertificationKind kind) noexcept
{
    switch (kind) {
    case DemagResidualCertificationKind::ReportedRecursive:
        return "reported_recursive";
    case DemagResidualCertificationKind::TrueResidual:
        return "true_residual";
    case DemagResidualCertificationKind::Unavailable:
    default:
        return "unavailable";
    }
}

bool validate_demag_linear_solve_result(
    const DemagLinearSolveResult &result,
    std::string &error)
{
    const bool norm_valid = (result.norm_kind == DemagResidualNormKind::L2);
    const bool certification_valid =
        result.certification_kind != DemagResidualCertificationKind::Unavailable &&
        ((result.certification_kind == DemagResidualCertificationKind::TrueResidual &&
          result.residual_independently_certified) ||
         (result.certification_kind == DemagResidualCertificationKind::ReportedRecursive &&
          (result.solver_reported_converged || result.residual_independently_certified)));

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

    if (norm_valid &&
        certification_valid &&
        relative_residual_valid &&
        absolute_residual_valid &&
        iterations_valid &&
        (relative_converged || absolute_converged)) {
        return true;
    }

    std::ostringstream message;
    message << std::setprecision(17)
            << "FEM demag linear solve rejected: solver_kind=" << result.solver_kind
            << ", norm_kind=" << to_string(result.norm_kind)
            << ", certification_kind=" << to_string(result.certification_kind)
            << ", solver_reported_converged="
            << (result.solver_reported_converged ? "true" : "false")
            << ", residual_independently_certified="
            << (result.residual_independently_certified ? "true" : "false")
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
