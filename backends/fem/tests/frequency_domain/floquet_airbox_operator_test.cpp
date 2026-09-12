/*
 * floquet_airbox_operator_test.cpp - bounded MFEM Floquet airbox assembly
 * contract tests.
 */

#include "cpu/frequency_domain/floquet_airbox_operator.hpp"

#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <memory>
#include <tuple>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_close(double actual, double expected, const char *message)
{
    check(std::abs(actual - expected) < 1.0e-12, message);
}

#if FULLMAG_HAS_MFEM_STACK

std::unique_ptr<mfem::ComplexSparseMatrix> make_complex_matrix(
    int rows,
    int columns,
    std::initializer_list<std::tuple<int, int, double>> real_entries,
    std::initializer_list<std::tuple<int, int, double>> imaginary_entries)
{
    auto real = std::make_unique<mfem::SparseMatrix>(rows, columns);
    auto imaginary = std::make_unique<mfem::SparseMatrix>(rows, columns);
    for (const auto &[row, column, value] : real_entries) {
        real->Add(row, column, value);
    }
    for (const auto &[row, column, value] : imaginary_entries) {
        imaginary->Add(row, column, value);
    }
    real->Finalize();
    imaginary->Finalize();
    return std::make_unique<mfem::ComplexSparseMatrix>(
        real.release(),
        imaginary.release(),
        true,
        true,
        mfem::ComplexOperator::HERMITIAN);
}

void reduces_phase_constrained_airbox_blocks_before_schur_elimination()
{
    // C = [1, exp(-i*pi/2)] maps two full scalar-potential DOFs to one
    // periodic class.  With P=I and A_phiq=[1,1], C^H A_phiq=1+i and
    // C^H P C=2, hence D=-(1+i)(1-i)/2=-1.
    auto scalar_operator = make_complex_matrix(
        2,
        2,
        {{0, 0, 1.0}, {1, 1, 1.0}},
        {});
    auto scalar_constraint = make_complex_matrix(
        2,
        1,
        {{0, 0, 1.0}},
        {{1, 0, -1.0}});
    auto tangent_source = make_complex_matrix(
        2,
        1,
        {{0, 0, 1.0}, {1, 0, 1.0}},
        {});

    fd::FloquetAirboxDynamicDemagKProblem problem{};
    problem.scalar_operator = scalar_operator.get();
    problem.scalar_constraint = scalar_constraint.get();
    problem.tangent_source = tangent_source.get();
    problem.k_rad_per_m[0] = 1.0;

    fd::FloquetAirboxDynamicDemagKResult result{};
    check(
        fd::assemble_floquet_airbox_dynamic_demag_k(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        "phase-reduced Floquet airbox Schur assembly succeeds");
    check(result.real_split_row_major.size() == 4,
          "one tangent DOF produces a 2x2 real-split Schur block");
    check_close(result.real_split_row_major[0], -1.0,
                "phase-reduced Schur real-real entry is exact");
    check_close(result.real_split_row_major[1], 0.0,
                "phase-reduced Schur real-imag entry vanishes");
    check_close(result.real_split_row_major[2], 0.0,
                "phase-reduced Schur imag-real entry vanishes");
    check_close(result.real_split_row_major[3], -1.0,
                "phase-reduced Schur imag-imag entry is exact");
    check_close(result.diagnostics.k_norm_rad_per_m, 1.0,
                "airbox diagnostics preserve the nonzero wavevector");
}

void rejects_missing_floquet_airbox_blocks_without_fallback()
{
    fd::FloquetAirboxDynamicDemagKProblem problem{};
    problem.k_rad_per_m[2] = 1.0;
    fd::FloquetAirboxDynamicDemagKResult result{};
    check(
        fd::assemble_floquet_airbox_dynamic_demag_k(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "missing Floquet airbox blocks are rejected");
    check(result.real_split_row_major.empty(),
          "rejected airbox assembly does not publish a partial matrix");
}

#endif

} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK
    reduces_phase_constrained_airbox_blocks_before_schur_elimination();
    rejects_missing_floquet_airbox_blocks_without_fallback();
#endif
    return 0;
}
