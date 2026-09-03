/*
 * HYPRE residual-validation policy contract.
 *
 * The policy is intentionally pure so its expensive residual-work decision is
 * testable without MFEM, HYPRE, or a CUDA device.
 */

#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(static_cast<bool>(input), "unable to read source contract input");
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void expect(bool solver_converged, bool has_absolute_tolerance, bool force,
            bool expected_rhs_norm, bool expected_independent)
{
    const auto actual = fullmag::fem::resolve_hypre_residual_validation_needs(
        solver_converged, has_absolute_tolerance, force);
    check(actual.rhs_norm == expected_rhs_norm, "unexpected HYPRE RHS norm policy");
    check(
        actual.independent_residual == expected_independent,
        "unexpected HYPRE independent residual policy");
}

void expect_force_validation_environment(
    const char *value,
    bool expected_ok,
    bool expected_forced)
{
    if (value == nullptr) {
        unsetenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL");
    } else {
        check(
            setenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL", value, 1) == 0,
            "unable to set independent-residual qualification environment");
    }
    bool forced = !expected_forced;
    std::string error;
    const bool ok = fullmag::fem::read_force_independent_residual_validation(
        forced, error);
    check(ok == expected_ok, "unexpected qualification environment status");
    check(forced == expected_forced, "unexpected qualification environment value");
    check(
        expected_ok || error.find("expected 0 or 1") != std::string::npos,
        "invalid qualification environment must fail with a strict-value error");
}

} // namespace

int main()
{
    check(
        fullmag::fem::should_validate_independent_residual(false, false),
        "a non-converged HYPRE solve must receive independent residual validation");
    check(
        !fullmag::fem::should_validate_independent_residual(true, false),
        "an ordinarily converged HYPRE solve must skip independent residual validation");
    check(
        fullmag::fem::should_validate_independent_residual(true, true),
        "qualification policy must be able to force independent residual validation");

    // The ordinary path avoids all validation work after a converged solve,
    // except the RHS norm needed to certify an explicitly requested absolute
    // tolerance. A non-converged or forced path computes both quantities.
    expect(false, false, false, true, true);
    expect(false, true, false, true, true);
    expect(false, false, true, true, true);
    expect(false, true, true, true, true);
    expect(true, false, false, false, false);
    expect(true, true, false, true, false);
    expect(true, false, true, true, true);
    expect(true, true, true, true, true);

    expect_force_validation_environment(nullptr, true, false);
    expect_force_validation_environment("0", true, false);
    expect_force_validation_environment("1", true, true);
    expect_force_validation_environment("true", false, false);
    unsetenv("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL");

    const auto root = fem_source_root();
    const std::string solver = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
    const std::string policy = read_text_file(
        root / "gpu" / "cuda" / "runtime" / "hypre_device_policy.cpp");
    check(
        solver.find("HYPRE_SetMemoryLocation(") == std::string::npos &&
            solver.find("HYPRE_SetExecutionPolicy(") == std::string::npos &&
            solver.find("HYPRE_SetSpTransUseVendor(") == std::string::npos &&
            solver.find("HYPRE_SetSpMVUseVendor(") == std::string::npos &&
            solver.find("HYPRE_SetSpGemmUseVendor(") == std::string::npos,
        "HYPRE process-wide setters must not be owned by the solver module");
    check(
        policy.find("HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE)") != std::string::npos &&
            policy.find("HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE)") != std::string::npos &&
            policy.find("HYPRE_SetSpTransUseVendor(1)") != std::string::npos &&
            policy.find("HYPRE_SetSpMVUseVendor(1)") != std::string::npos &&
            policy.find("HYPRE_SetSpGemmUseVendor(1)") != std::string::npos,
        "shared HYPRE policy must retain all process-wide setters");

    return 0;
}
