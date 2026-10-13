/*
 * floquet_dynamic_demag_k_test.cpp - bounded nonzero-k complex Schur
 * provider contract tests.
 */

#include "frequency_domain/floquet_dynamic_demag_k.hpp"

#include <algorithm>
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
    check(
        diagnostics.max_relative_potential_solve_residual < 1.0e-12,
        "diagnostics record a small scalar-potential solve residual");
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
    const Complex a_qphi[2] = {Complex(-2.0, 0.0), Complex(2.0, 0.0)};
    const Complex p[4] = {
        Complex(4.0, 0.0), Complex(-4.0, 0.0),
        Complex(-4.0, 0.0), Complex(4.0, 0.0),
    };
    Complex a_phiq[2] = {Complex(-3.0, 0.0), Complex(3.0, 0.0)};
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
    a_phiq[0] = Complex(5.0, 0.0); // Incompatible omitted equation.
    fd::FloquetDynamicDemagKDiagnostics diagnostics{};
    std::fill(output.begin(), output.end(), 123.0);
    check(fd::build_floquet_dynamic_demag_k_real_split(
              problem, output.data(), output.size(), &diagnostics) ==
              fd::FrequencyDomainStatus::operator_error,
          "incompatible pinned equation rejects the Schur result");
    check(diagnostics.max_relative_potential_solve_residual > 1.0,
          "incompatible source produces a measured nonzero residual");
    check(!diagnostics.potential_solve_certified, "failed solve is not certified");
    for (double value : output) check(value == 123.0, "failed solve leaves output unpublished");

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


void multiple_pivots_preserve_complex_multiple_rhs()
{
    // Manufacture B = P X, so the independent Schur oracle is -A X.
    // P forces a row exchange at both the first and second pivots.
    for (bool complex_case : {false, true}) {
        const Complex scale = complex_case ? Complex(1.0, 0.5) : Complex(1.0, 0.0);
        const double entries[9] = {1, 2, 3, 4, 5, 6, 7, 8, 10};
        Complex p[9];
        for (int i = 0; i < 9; ++i) p[i] = entries[i] * scale;
        const Complex x[6] = {
            Complex(1, 1), Complex(2, -1),
            Complex(1, -2), Complex(-1, 3),
            Complex(1, 0.5), Complex(4, 2)};
        const Complex a[6] = {
            Complex(1, 0), Complex(0, 1), Complex(2, -1),
            Complex(-1, 2), Complex(3, 0), Complex(0, -2)};
        Complex b[6]{};
        Complex expected[4]{};
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 2; ++j)
                for (int k = 0; k < 3; ++k)
                    b[i * 2 + j] += p[i * 3 + k] * x[k * 2 + j];
        for (int i = 0; i < 2; ++i)
            for (int j = 0; j < 2; ++j)
                for (int k = 0; k < 3; ++k)
                    expected[i * 2 + j] -= a[i * 3 + k] * x[k * 2 + j];
        fd::FloquetDynamicDemagKProblem problem{};
        problem.q_dof_count = 2;
        problem.phi_dof_count = 3;
        problem.p_row_major = p;
        problem.p_value_count = 9;
        problem.a_qphi_row_major = a;
        problem.a_qphi_value_count = 6;
        problem.a_phiq_row_major = b;
        problem.a_phiq_value_count = 6;
        problem.k_rad_per_m[0] = 1;
        double output[16]{};
        fd::FloquetDynamicDemagKDiagnostics diagnostics{};
        check(fd::build_floquet_dynamic_demag_k_real_split(
                  problem, output, 16, &diagnostics) == fd::FrequencyDomainStatus::ok,
              "multiple-pivot solve succeeds");
        for (int i = 0; i < 2; ++i)
            for (int j = 0; j < 2; ++j) {
                const Complex value = expected[i * 2 + j];
                check_close(output[i * 4 + j], value.real(), "pivoted Schur real-real");
                check_close(output[i * 4 + j + 2], -value.imag(), "pivoted Schur real-imag");
                check_close(output[(i + 2) * 4 + j], value.imag(), "pivoted Schur imag-real");
                check_close(output[(i + 2) * 4 + j + 2], value.real(), "pivoted Schur imag-imag");
            }
        check(diagnostics.potential_solve_certified && diagnostics.certified_rhs_count == 2,
              "all multiple RHS are certified");
        check(diagnostics.max_relative_potential_solve_residual < 1e-12,
              "multiple-pivot original potential residual");
    }
}


void reconstructs_complex_potential_with_original_residual()
{
    fd::FloquetPotentialReconstruction blocks;
    blocks.q_count=3;
    blocks.phi_count=3;
    blocks.p={1.,2.,3.,4.,5.,6.,7.,8.,10.};
    blocks.a_phiq=blocks.p;
    const std::vector<Complex> q={Complex(1,2),Complex(-2,1),Complex(3,-1)};
    fd::FloquetReconstructedPotential result;
    check(fd::reconstruct_floquet_potential(blocks,q,&result)==fd::FrequencyDomainStatus::ok,
          "complex mode potential reconstruction succeeds");
    check(result.certified && result.phi.size()==3, "reconstruction certificate");
    for (int i=0;i<3;++i)
        check(std::abs(result.phi[i]+q[i])<1e-12,"potential equals manufactured minus q");
    check(result.relative_residual<1e-12,"original potential residual");
    blocks.q_count=1;
    blocks.phi_count=2;
    blocks.p={4.,-4.,-4.,4.};
    blocks.a_phiq={1.,-1.};
    blocks.gauge_policy=fd::FloquetDynamicDemagKGaugePolicy::pin_first_dof;
    check(fd::reconstruct_floquet_potential(blocks,{Complex(1,0)},&result)==
          fd::FrequencyDomainStatus::ok,"compatible gauge reconstructs");
    check_close(result.phi[0].real(),0.0,"pinned potential");
    check_close(result.phi[1].real(),0.25,"unpinned potential");
    blocks.a_phiq[0]=2.;
    check(fd::reconstruct_floquet_potential(blocks,{Complex(1,0)},&result)==
          fd::FrequencyDomainStatus::operator_error,"incompatible original equation rejects");
    check(!result.certified && result.phi.empty(),"no stale potential on failure");
}


void original_descriptor_rejects_wrong_magnetic_equation()
{
    fd::FloquetPotentialReconstruction b;
    b.q_count=1; b.phi_count=1; b.p={2.}; b.a_phiq={1.}; b.a_qphi={1.};
    b.magnetic_stiffness_real_split_value_count = 4u;
    double k[4]={2.5,0.,0.,2.5}, g[4]={1.,0.,0.,1.};
    fd::FloquetModalResidual r;
    const std::vector<Complex> z={Complex(1,2),Complex(3,-1)};
    check(fd::certify_floquet_realified_mode(b,k,g,z,Complex(2,0),&r)==
          fd::FrequencyDomainStatus::ok,"original descriptor accepts exact doubled mode");
    check(r.certified && r.potential_real_split.size()==2,"descriptor preserves potential");
    for(int i=0;i<2;++i)
        check(std::abs(r.potential_real_split[i]+0.5*z[i])<1e-12,"both realification sectors reconstructed");
    k[0]+=1.;
    check(fd::certify_floquet_realified_mode(b,k,g,z,Complex(2,0),&r)==
          fd::FrequencyDomainStatus::operator_error,"wrong magnetic equation rejects");
    check(!r.certified && r.potential_real_split.empty(),"failed descriptor does not publish potential");
    b.magnetic_stiffness_real_split_value_count = 3u;
    check(fd::certify_floquet_realified_mode(b,k,g,z,Complex(2,0),&r)==
          fd::FrequencyDomainStatus::validation_error,
          "mismatched magnetic operator bound rejects before descriptor evaluation");
    check(!r.certified && r.potential_real_split.empty(),
          "mismatched magnetic operator bound does not publish potential");
}

} // namespace

void reconstruction_preserves_scalar_pivot_policy()
{
    fd::FloquetPotentialReconstruction blocks;
    blocks.q_count = blocks.phi_count = 1;
    blocks.p = {Complex(1e-15, 0.)};
    blocks.a_phiq = blocks.p;
    blocks.pivot_tolerance = 1e-16;
    fd::FloquetReconstructedPotential result;
    check(fd::reconstruct_floquet_potential(blocks, {Complex(2., -3.)}, &result) ==
              fd::FrequencyDomainStatus::ok,
          "reconstruction uses the admitted scalar pivot tolerance");
    check(result.certified && std::abs(result.phi[0] - Complex(-2., 3.)) < 1e-12,
          "small-scale potential matches manufactured solution");
    blocks.pivot_tolerance = 1e-14;
    check(fd::reconstruct_floquet_potential(blocks, {Complex(2., -3.)}, &result) ==
              fd::FrequencyDomainStatus::operator_error,
          "stricter pivot tolerance rejects the same scalar block");
    check(!result.certified && result.phi.empty(), "failed factorization clears prior result");
    blocks.pivot_tolerance = 0.;
    check(fd::reconstruct_floquet_potential(blocks, {Complex(2., -3.)}, &result) ==
              fd::FrequencyDomainStatus::validation_error,
          "invalid pivot tolerance is rejected before solve");
}

int main()
{
    reconstruction_preserves_scalar_pivot_policy();
    original_descriptor_rejects_wrong_magnetic_equation();
    reconstructs_complex_potential_with_original_residual();
    multiple_pivots_preserve_complex_multiple_rhs();
    nonzero_k_dense_schur_is_realified_for_modal_abi();
    hermitian_blocks_produce_hermitian_dynamic_demag();
    validation_rejects_zero_k_singular_p_and_budget_overflow();
    pin_first_phi_gauge_excludes_the_pinned_dof();
    pin_first_phi_gauge_rejects_a_single_potential_dof();
    return 0;
}
