#pragma once

#include <cstdint>
#include <string>

namespace fullmag::fem {

enum class DemagResidualNormKind : uint8_t {
    Unknown = 0,
    L2 = 1,
    Preconditioned = 2,
};

enum class DemagResidualCertificationKind : uint8_t {
    Unavailable = 0,
    ReportedRecursive = 1,
    TrueResidual = 2,
};

const char *to_string(DemagResidualNormKind kind) noexcept;
const char *to_string(DemagResidualCertificationKind kind) noexcept;

struct DemagLinearSolveResult {
    const char *solver_kind = "unknown";
    DemagResidualNormKind norm_kind = DemagResidualNormKind::L2;
    DemagResidualCertificationKind certification_kind = DemagResidualCertificationKind::ReportedRecursive;
    bool solver_reported_converged = false;
    bool residual_independently_certified = false;
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
