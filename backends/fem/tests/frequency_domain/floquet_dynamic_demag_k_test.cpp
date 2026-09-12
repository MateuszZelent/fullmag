/*
 * floquet_dynamic_demag_k_test.cpp - bounded nonzero-k complex Schur
 * provider contract tests.
 */

#include "frequency_domain/floquet_dynamic_demag_k.hpp"

#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

using Complex = std::complex<double>;

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

void nonzero_k_dense_schur_is_realified_for_modal_abi()
{
    // One magnetic DOF and one scalar-potential DOF are sufficient to prove
    // both the Schur sign and the [Re, Im] block layout.
    const Complex a_qphi[1] = {Complex(2.0, 1.0)};
    const Complex p[1] = {Complex(4.0, 2.0)};
    const Complex a_phiq[1] = {Complex(3.0, -1.0)};
    fd::FloquetDynamicDemagKProblem problem{};
    problem.q_dof_count = 1;
    problem.phi_dof_count = 1;
    problem.a_qphi_row_major = a_qphi;
    problem.a_qphi_value_count = 1;
    problem.p_row_major = p;
    problem.p_value_count = 1;
    problem.a_phiq_row_major = a_phiq;
    problem.a_phiq_value_count = 1;
    problem.k_rad_per_m[0] = 2.0;

    std::vector<double> output(4, 0.0);
    fd::FloquetDynamicDemagKDiagnostics diagnostics{};
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::ok,
        "nonzero-k dense Schur provider succeeds");

    const Complex expected = -(a_qphi[0] * a_phiq[0] / p[0]);
    check_close(output[0], expected.real(), "realified Schur real-real entry matches");
    check_close(output[1], -expected.imag(), "realified Schur real-imag entry matches");
    check_close(output[2], expected.imag(), "realified Schur imag-real entry matches");
    check_close(output[3], expected.real(), "realified Schur imag-imag entry matches");
    check_close(diagnostics.k_norm_rad_per_m, 2.0, "diagnostics preserve Floquet wavevector norm");
    check(diagnostics.max_abs_schur_entry > 0.0, "diagnostics record Schur magnitude");
}

void hermitian_blocks_produce_hermitian_dynamic_demag()
{
    const Complex a_qphi[2] = {Complex(1.0, 0.0), Complex(0.0, 2.0)};
    const Complex p[1] = {Complex(2.0, 0.0)};
    const Complex a_phiq[2] = {Complex(1.0, 0.0), Complex(0.0, -2.0)};
    fd::FloquetDynamicDemagKProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 1;
    problem.a_qphi_row_major = a_qphi;
    problem.a_qphi_value_count = 2;
    problem.p_row_major = p;
    problem.p_value_count = 1;
    problem.a_phiq_row_major = a_phiq;
    problem.a_phiq_value_count = 2;
    problem.k_rad_per_m[1] = 1.0;

    std::vector<double> output(16, 0.0);
    fd::FloquetDynamicDemagKDiagnostics diagnostics{};
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::ok,
        "Hermitian nonzero-k blocks assemble");
    check(diagnostics.max_abs_hermitian_residual < 1.0e-12,
          "Hermitian input blocks produce a Hermitian demag Schur complement");
    // D = -1/2 [ [1, -2i], [2i, 4] ].  The realification therefore has a
    // positive semidefinite sign only after the caller applies its magnetic
    // Hessian convention; this test checks the exact complex placement.
    check_close(output[0], -0.5, "q0 real block is realified exactly");
    check_close(output[1], 0.0, "q0-q1 real coupling has zero real part");
    check_close(output[2], 0.0, "q1-q0 real coupling has zero real part");
    check_close(output[5], -2.0, "q1 real block is realified exactly");
    check_close(output[3], -1.0, "q0-to-q1 imaginary block has the expected sign");
    check_close(output[9], 1.0, "q1-to-q0 imaginary block has the expected sign");
}

void validation_rejects_zero_k_singular_p_and_budget_overflow()
{
    const Complex coupling[1] = {Complex(1.0, 0.0)};
    const Complex p_identity[1] = {Complex(1.0, 0.0)};
    fd::FloquetDynamicDemagKProblem problem{};
    problem.q_dof_count = 1;
    problem.phi_dof_count = 1;
    problem.a_qphi_row_major = coupling;
    problem.a_qphi_value_count = 1;
    problem.p_row_major = p_identity;
    problem.p_value_count = 1;
    problem.a_phiq_row_major = coupling;
    problem.a_phiq_value_count = 1;
    std::vector<double> output(4, 0.0);
    fd::FloquetDynamicDemagKDiagnostics diagnostics{};

    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::validation_error,
        "zero-k request is rejected instead of becoming a k=0 fallback");

    problem.k_rad_per_m[2] = 1.0;
    problem.p_row_major = nullptr;
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::validation_error,
        "missing scalar-potential matrix is rejected");

    const Complex singular[1] = {Complex(0.0, 0.0)};
    problem.p_row_major = singular;
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::operator_error,
        "singular scalar-potential block is reported as an operator error");

    problem.p_row_major = p_identity;
    problem.workspace_budget_bytes = 1;
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::validation_error,
        "dense workspace budget is enforced before allocation");
}

void pin_first_phi_gauge_excludes_the_pinned_dof()
{
    const Complex a_qphi[2] = {Complex(7.0, 0.0), Complex(2.0, 0.0)};
    const Complex p[4] = {
        Complex(0.0, 0.0), Complex(9.0, 0.0),
        Complex(0.0, 0.0), Complex(4.0, 0.0),
    };
    const Complex a_phiq[2] = {Complex(5.0, 0.0), Complex(3.0, 0.0)};
    fd::FloquetDynamicDemagKProblem problem{};
    problem.q_dof_count = 1;
    problem.phi_dof_count = 2;
    problem.a_qphi_row_major = a_qphi;
    problem.a_qphi_value_count = 2;
    problem.p_row_major = p;
    problem.p_value_count = 4;
    problem.a_phiq_row_major = a_phiq;
    problem.a_phiq_value_count = 2;
    problem.k_rad_per_m[0] = 1.0;
    problem.gauge_policy = fd::FloquetDynamicDemagKGaugePolicy::pin_first_dof;

    std::vector<double> output(4, 0.0);
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            nullptr) == fd::FrequencyDomainStatus::ok,
        "pin-first-dof Floquet Schur provider succeeds");
    // The pinned phi_0 row/column is excluded, so only 2 * 3 / 4 remains.
    check_close(output[0], -1.5, "pin-first-dof Schur uses the unpinned scalar potential");
}

void pin_first_phi_gauge_rejects_a_single_potential_dof()
{
    const Complex coupling[1] = {Complex(1.0, 0.0)};
    const Complex p[1] = {Complex(1.0, 0.0)};
    fd::FloquetDynamicDemagKProblem problem{};
    problem.q_dof_count = 1;
    problem.phi_dof_count = 1;
    problem.a_qphi_row_major = coupling;
    problem.a_qphi_value_count = 1;
    problem.p_row_major = p;
    problem.p_value_count = 1;
    problem.a_phiq_row_major = coupling;
    problem.a_phiq_value_count = 1;
    problem.k_rad_per_m[0] = 1.0;
    problem.gauge_policy = fd::FloquetDynamicDemagKGaugePolicy::pin_first_dof;

    std::vector<double> output(4, 0.0);
    fd::FloquetDynamicDemagKDiagnostics diagnostics{};
    check(
        fd::build_floquet_dynamic_demag_k_real_split(
            problem,
            output.data(),
            output.size(),
            &diagnostics) == fd::FrequencyDomainStatus::validation_error,
        "pin-first-dof gauge rejects a scalar space with no unpinned DOF");
}

} // namespace

int main()
{
    nonzero_k_dense_schur_is_realified_for_modal_abi();
    hermitian_blocks_produce_hermitian_dynamic_demag();
    validation_rejects_zero_k_singular_p_and_budget_overflow();
    pin_first_phi_gauge_excludes_the_pinned_dof();
    pin_first_phi_gauge_rejects_a_single_potential_dof();
    return 0;
}
