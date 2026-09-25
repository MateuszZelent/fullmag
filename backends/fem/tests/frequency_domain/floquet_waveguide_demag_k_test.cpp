#include "frequency_domain/floquet_waveguide_demag_k.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

using fullmag::fem::frequency_domain::FloquetWaveguideDemagKGaugePolicy;
using fullmag::fem::frequency_domain::FloquetWaveguideDemagKDiagnostics;
using fullmag::fem::frequency_domain::FloquetWaveguideDemagKProblem;
using fullmag::fem::frequency_domain::FrequencyDomainStatus;
using fullmag::fem::frequency_domain::build_floquet_waveguide_demag_k_real_split;

namespace {

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
    std::cout << "floquet waveguide demag-k contract tests passed\n";
    return 0;
}
