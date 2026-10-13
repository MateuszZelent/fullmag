#include "frequency_domain/floquet_waveguide_demag_k.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using fullmag::fem::frequency_domain::FloquetWaveguideDemagKGaugePolicy;
using fullmag::fem::frequency_domain::FloquetWaveguideDemagKDiagnostics;
using fullmag::fem::frequency_domain::FloquetWaveguideDemagKProblem;
using fullmag::fem::frequency_domain::FrequencyDomainStatus;
using fullmag::fem::frequency_domain::build_floquet_waveguide_demag_k_real_split;

namespace {

using Complex = std::complex<double>;

void verify_known_solution_and_original_residual(
    std::size_t dimension,
    const std::vector<double> &poisson,
    const std::vector<Complex> &expected_solution,
    double k)
{
    assert(dimension > 0);
    assert(poisson.size() == dimension * dimension);
    assert(expected_solution.size() == dimension * dimension);

    const std::vector<double> mass(dimension * dimension, 0.0);
    std::vector<double> qphi_perp(dimension * dimension, 0.0);
    const std::vector<double> qphi_axial(dimension * dimension, 0.0);
    std::vector<double> phiq_perp(dimension * dimension, 0.0);
    std::vector<double> phiq_axial(dimension * dimension, 0.0);
    for (std::size_t i = 0; i < dimension; ++i) {
        qphi_perp[i * dimension + i] = 1.0;
    }
    for (std::size_t row = 0; row < dimension; ++row) {
        for (std::size_t column = 0; column < dimension; ++column) {
            Complex value{0.0, 0.0};
            for (std::size_t inner = 0; inner < dimension; ++inner) {
                value += poisson[row * dimension + inner] *
                    expected_solution[inner * dimension + column];
            }
            phiq_perp[row * dimension + column] = value.real();
            phiq_axial[row * dimension + column] = k == 0.0 ? 0.0 : value.imag() / k;
        }
    }

    FloquetWaveguideDemagKProblem problem{};
    problem.q_dof_count = dimension;
    problem.phi_dof_count = dimension;
    problem.k_perp_row_major = poisson.data();
    problem.mass_row_major = mass.data();
    problem.a_qphi_perp_row_major = qphi_perp.data();
    problem.a_qphi_axial_row_major = qphi_axial.data();
    problem.a_phiq_perp_row_major = phiq_perp.data();
    problem.a_phiq_axial_row_major = phiq_axial.data();
    problem.k_rad_per_m = k;

    const std::size_t split_dimension = 2u * dimension;
    std::vector<double> output(split_dimension * split_dimension, 0.0);
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) == FrequencyDomainStatus::ok);

    double rhs_scale = 0.0;
    double max_original_residual = 0.0;
    for (std::size_t row = 0; row < dimension; ++row) {
        for (std::size_t column = 0; column < dimension; ++column) {
            const Complex recovered_solution(
                -output[row * split_dimension + column],
                output[row * split_dimension + dimension + column]);
            assert(std::abs(recovered_solution - expected_solution[row * dimension + column]) <=
                1.0e-11 * std::max(1.0, std::abs(expected_solution[row * dimension + column])));

            Complex residual{0.0, 0.0};
            for (std::size_t inner = 0; inner < dimension; ++inner) {
                const Complex solution_value(
                    -output[inner * split_dimension + column],
                    output[inner * split_dimension + dimension + column]);
                residual += poisson[row * dimension + inner] * solution_value;
            }
            const Complex rhs(
                phiq_perp[row * dimension + column],
                k * phiq_axial[row * dimension + column]);
            rhs_scale = std::max(rhs_scale, std::abs(rhs));
            max_original_residual = std::max(max_original_residual, std::abs(residual - rhs));
        }
    }
    assert(max_original_residual <= 1.0e-11 * std::max(1.0, rhs_scale));
}

void late_pivot_real_rhs_satisfies_original_system_residual()
{
    // The SPD repro needs a late pivot: column one swaps rows 1 and 2.
    // Its first RHS is A*[1,1,1]^T = [7,5,15]^T.
    const std::vector<double> matrix{
        4.0, 1.0, 2.0,
        1.0, 1.0, 3.0,
        2.0, 3.0, 10.0,
    };
    const std::vector<Complex> expected_solution{
        {1.0, 0.0}, {0.0, 0.0}, {1.0, 0.0},
        {1.0, 0.0}, {1.0, 0.0}, {0.0, 0.0},
        {1.0, 0.0}, {0.0, 0.0}, {-1.0, 0.0},
    };
    verify_known_solution_and_original_residual(3, matrix, expected_solution, 0.0);
}

void multiple_pivot_complex_rhs_satisfies_original_system_residual()
{
    // Partial pivoting swaps at columns zero and one.
    const std::vector<double> matrix{
        0.0, 2.0, 1.0,
        3.0, 1.0, 0.0,
        1.0, 5.0, 4.0,
    };
    const std::vector<Complex> expected_solution{
        {1.0, 1.0}, {0.5, -2.0}, {-2.0, 1.0},
        {2.0, -1.0}, {-1.0, 0.25}, {0.75, 0.5},
        {-1.0, 0.5}, {2.0, 3.0}, {1.0, -1.0},
    };
    verify_known_solution_and_original_residual(3, matrix, expected_solution, 1.0);
}

void workspace_budget_counts_peak_owned_vectors_and_rejects_below_threshold()
{
    // Peak payload is two phi-by-phi complex matrices, two phi-vectors,
    // one q-by-q Schur matrix, and the size_t pivot vector.
    const std::uint64_t phi = 4096;
    const std::uint64_t q = 1;
    const double one = 1.0;
    FloquetWaveguideDemagKProblem small_problem{};
    small_problem.q_dof_count = 1;
    small_problem.phi_dof_count = 1;
    small_problem.k_perp_row_major = &one;
    small_problem.mass_row_major = &one;
    small_problem.a_qphi_perp_row_major = &one;
    small_problem.a_qphi_axial_row_major = &one;
    small_problem.a_phiq_perp_row_major = &one;
    small_problem.a_phiq_axial_row_major = &one;
    std::vector<double> small_output(4, 0.0);
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    const std::uint64_t small_requirement = 5u * sizeof(Complex) + sizeof(std::size_t);
    small_problem.workspace_budget_bytes = small_requirement;
    assert(build_floquet_waveguide_demag_k_real_split(
               small_problem, small_output.data(), small_output.size(), &diagnostics) ==
        FrequencyDomainStatus::ok);
    small_problem.workspace_budget_bytes = small_requirement - 1u;
    assert(build_floquet_waveguide_demag_k_real_split(
               small_problem, small_output.data(), small_output.size(), &diagnostics) ==
        FrequencyDomainStatus::validation_error);

    const std::uint64_t expected_bytes =
        (2u * phi * phi + 2u * phi + q * q) * sizeof(Complex) +
        phi * sizeof(std::size_t);
    FloquetWaveguideDemagKProblem problem{};
    problem.q_dof_count = q;
    problem.phi_dof_count = phi;
    problem.workspace_budget_bytes = expected_bytes - 1u;

    std::vector<double> output(4, 0.0);
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) ==
        FrequencyDomainStatus::validation_error);
    assert(std::string(diagnostics.error_message).find("workspace exceeds") != std::string::npos);
}

void workspace_budget_formula_rejects_overflow_without_allocating()
{
    FloquetWaveguideDemagKProblem problem{};
    problem.q_dof_count = 1;
    problem.phi_dof_count = std::numeric_limits<std::uint64_t>::max();
    problem.workspace_budget_bytes = std::numeric_limits<std::uint64_t>::max();

    std::vector<double> output(4, 0.0);
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) ==
        FrequencyDomainStatus::validation_error);
    assert(std::string(diagnostics.error_message).find("size overflow") != std::string::npos);
}

FloquetWaveguideDemagKProblem scalar_problem(double k)
{
    static const double transverse_laplacian[] = {2.0};
    static const double transverse_mass[] = {3.0};
    static const double qphi_perp[] = {5.0};
    static const double qphi_axial[] = {2.0};
    static const double phiq_perp[] = {7.0};
    static const double phiq_axial[] = {-1.0};
    FloquetWaveguideDemagKProblem problem{};
    problem.q_dof_count = 1;
    problem.phi_dof_count = 1;
    problem.k_perp_row_major = transverse_laplacian;
    problem.mass_row_major = transverse_mass;
    problem.a_qphi_perp_row_major = qphi_perp;
    problem.a_qphi_axial_row_major = qphi_axial;
    problem.a_phiq_perp_row_major = phiq_perp;
    problem.a_phiq_axial_row_major = phiq_axial;
    problem.k_rad_per_m = k;
    return problem;
}

void scalar_modified_helmholtz_and_realification()
{
    const auto problem = scalar_problem(4.0);
    std::vector<double> output(4, 0.0);
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    const auto status = build_floquet_waveguide_demag_k_real_split(
        problem, output.data(), output.size(), &diagnostics);
    assert(status == FrequencyDomainStatus::ok);
    // P=2+4^2*3=50, A_qphi=5+8i, A_phiq=7-4i,
    // D=-(5+8i)(7-4i)/50=-1.34-0.72i.
    assert(std::abs(output[0] + 1.34) < 1.0e-12);
    assert(std::abs(output[1] - 0.72) < 1.0e-12);
    assert(std::abs(output[2] + 0.72) < 1.0e-12);
    assert(std::abs(output[3] + 1.34) < 1.0e-12);
    assert(std::abs(diagnostics.k_squared - 16.0) < 1.0e-12);
    assert(diagnostics.max_pivot_abs > 49.9);
}

void zero_k_limit_uses_the_transverse_block()
{
    const auto problem = scalar_problem(0.0);
    std::vector<double> output(4, 0.0);
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) == FrequencyDomainStatus::ok);
    assert(std::abs(output[0] + 17.5) < 1.0e-12);
    assert(std::abs(output[1]) < 1.0e-12);
    assert(std::abs(output[2]) < 1.0e-12);
    assert(std::abs(output[3] + 17.5) < 1.0e-12);
}

void pin_first_dof_is_explicit_and_malformed_inputs_fail()
{
    auto problem = scalar_problem(1.0);
    problem.gauge_policy = FloquetWaveguideDemagKGaugePolicy::pin_first_dof;
    std::vector<double> output(4, 0.0);
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    // Pinning a one-dimensional scalar space leaves no potential unknown.
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) == FrequencyDomainStatus::solve_error);
    assert(diagnostics.error_message[0] != '\0');

    problem = scalar_problem(1.0);
    problem.workspace_budget_bytes = 1;
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) == FrequencyDomainStatus::validation_error);

    problem = scalar_problem(1.0);
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), 3, &diagnostics) == FrequencyDomainStatus::validation_error);
}

} // namespace

int main()
{
    scalar_modified_helmholtz_and_realification();
    zero_k_limit_uses_the_transverse_block();
    pin_first_dof_is_explicit_and_malformed_inputs_fail();
    late_pivot_real_rhs_satisfies_original_system_residual();
    multiple_pivot_complex_rhs_satisfies_original_system_residual();
    workspace_budget_counts_peak_owned_vectors_and_rejects_below_threshold();
    workspace_budget_formula_rejects_overflow_without_allocating();
    std::cout << "floquet waveguide demag-k contract tests passed\n";
    return 0;
}
