#pragma once

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct DemagLinearSolveResult {
    const char *solver_kind = "unknown";
    bool solver_reported_converged = false;
    int iterations = 0;
    double relative_residual = 0.0;
    bool has_absolute_residual = false;
    double absolute_residual = 0.0;
    double relative_tolerance = 0.0;
    bool has_absolute_tolerance = false;
    double absolute_tolerance = 0.0;
    uint32_t max_iterations = 0;
};

bool validate_demag_linear_solve_result(
    const DemagLinearSolveResult &result,
    std::string &error);

} // namespace fullmag::fem
