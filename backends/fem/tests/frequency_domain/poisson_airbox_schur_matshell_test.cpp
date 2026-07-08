/*
 * poisson_airbox_schur_matshell_test.cpp - PA-E3 CPU Schur MatShell
 * Poisson-airbox k=0 modal eigensolve certification tests.
 */

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "cpu/frequency_domain/poisson_airbox_schur_matshell.hpp"
#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"
#include "frequency_domain/planner/frequency_solve_planner.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool contains(const char *haystack, const char *needle)
{
    return haystack != nullptr && std::strstr(haystack, needle) != nullptr;
}

struct CsrOwned {
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    fd::CsrMatrixView view() const
    {
        return fd::CsrMatrixView{
            rows,
            columns,
            row_offsets.data(),
            static_cast<std::uint64_t>(row_offsets.size()),
            column_indices.data(),
            static_cast<std::uint64_t>(column_indices.size()),
            values.data(),
            static_cast<std::uint64_t>(values.size())};
    }
};

CsrOwned dense_to_csr(
    std::uint64_t rows,
    std::uint64_t columns,
    const double *row_major_values)
{
    CsrOwned csr{};
    csr.rows = rows;
    csr.columns = columns;
    csr.row_offsets.reserve(static_cast<std::size_t>(rows + 1));
    csr.row_offsets.push_back(0);
    for (std::uint64_t row = 0; row < rows; ++row) {
        for (std::uint64_t column = 0; column < columns; ++column) {
            const double value =
                row_major_values[static_cast<std::size_t>(row * columns + column)];
            if (value != 0.0) {
                csr.column_indices.push_back(static_cast<std::uint32_t>(column));
                csr.values.push_back(value);
            }
        }
        csr.row_offsets.push_back(static_cast<std::uint32_t>(csr.values.size()));
    }
    return csr;
}

struct TinySparseFixture {
    double a_qq[4] = {};
    double a_qphi[4] = {};
    double a_phiq[4] = {};
    double a_phiphi[4] = {};
    double b_qq[4] = {};
    double weights[2] = {0.5, 0.5};
    CsrOwned A_qq{};
    CsrOwned A_qphi{};
    CsrOwned A_phiq{};
    CsrOwned A_phiphi{};
    CsrOwned B_qq{};
    fd::DensePoissonAirboxEigenOracleResult dense_result{};
};

TinySparseFixture make_tiny_full_coupled_fixture()
{
    TinySparseFixture fixture{};
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    std::memcpy(fixture.a_qq, a_qq, sizeof(a_qq));
    std::memcpy(fixture.a_qphi, a_qphi, sizeof(a_qphi));
    std::memcpy(fixture.a_phiq, a_phiq, sizeof(a_phiq));
    std::memcpy(fixture.a_phiphi, a_phiphi, sizeof(a_phiphi));
    std::memcpy(fixture.b_qq, b_qq, sizeof(b_qq));

    fixture.A_qq = dense_to_csr(2, 2, fixture.a_qq);
    fixture.A_qphi = dense_to_csr(2, 2, fixture.a_qphi);
    fixture.A_phiq = dense_to_csr(2, 2, fixture.a_phiq);
    fixture.A_phiphi = dense_to_csr(2, 2, fixture.a_phiphi);
    fixture.B_qq = dense_to_csr(2, 2, fixture.b_qq);
    return fixture;
}

fd::DensePoissonAirboxEigenOracleProblem dense_problem_from_fixture(
    const TinySparseFixture &fixture)
{
    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{fixture.a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{fixture.a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{fixture.a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{fixture.a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{fixture.b_qq, 2, 2};
    problem.phi_mean_weights = fixture.weights;
    problem.phi_mean_weights_count = 2;
    return problem;
}

fd::PoissonAirboxEigenBlockProblem sparse_problem_from_fixture(
    const TinySparseFixture &fixture)
{
    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fixture.A_qq.view();
    problem.A_qphi = fixture.A_qphi.view();
    problem.A_phiq = fixture.A_phiq.view();
    problem.A_phiphi = fixture.A_phiphi.view();
    problem.B_qq = fixture.B_qq.view();
    problem.phi_mean_weights = fixture.weights;
    problem.phi_mean_weights_count = 2;
    problem.target_frequency_hz = 2.0e9;
    problem.expected_reference_frequency_hz = fixture.dense_result.frequency_hz;
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    return problem;
}

void CertifiesSchurMatShellAgainstFullCoupledSparseReference()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::DensePoissonAirboxEigenOracleProblem dense_problem =
        dense_problem_from_fixture(fixture);
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(
            dense_problem,
            &fixture.dense_result) == fd::FrequencyDomainStatus::ok,
        fixture.dense_result.error_message);

    fd::PoissonAirboxEigenBlockProblem sparse_problem =
        sparse_problem_from_fixture(fixture);
    fd::PoissonAirboxSchurMatShellCertificationResult result{};
    check(
        fd::certify_poisson_airbox_schur_matshell_cpu(
            sparse_problem,
            &result) == fd::FrequencyDomainStatus::ok,
        result.error_message);

    check(result.created_petsc_matshell, "PA-E3 must create and use a PETSc MatShell");
    check(result.reused_mean_zero_poisson_setup, "PA-E3 must reuse the mean-zero Poisson setup");
    check(result.schur_certified, "PA-E3 Schur MatShell must certify");
    check(
        result.schur_apply_relative_error <= 1.0e-10,
        "PA-E3 MatShell apply must match explicit Schur on sampled vectors");
    check(
        result.full_sparse_reference_relative_frequency_error <= 1.0e-10,
        "PA-E3 Schur eigenfrequency must match PA-E2 full-coupled sparse reference");
    check(
        result.full_residual_reconstruction_relative_error <= 1.0e-10,
        "PA-E3 Schur eigenvector must reconstruct the full descriptor residual");
    check(
        contains(result.diagnostics_json, "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_matshell_slepc\""),
        "PA-E3 diagnostics must name the Schur MatShell adapter");
    check(
        contains(result.diagnostics_json, "\"certificate_key\""),
        "PA-E3 diagnostics must emit a Schur certificate key");
}

void PlannerRequiresExplicitCertifiedSchurSelection()
{
    fd::FrequencySolvePlannerInput implicit_input{};
    implicit_input.tiny_problem = false;
    implicit_input.periodic_airbox_k0 = true;
    implicit_input.periodic_mesh_symmetry_certified = true;
    implicit_input.schur_certified = true;
    implicit_input.schur_reduced_explicitly_requested = false;

    const fd::FrequencySolvePlan implicit_plan =
        fd::plan_frequency_response(implicit_input);
    check(
        implicit_plan.lane != fd::FrequencyExecutionLane::schur_reduced,
        "certified Schur must not be auto-selected without an explicit Schur request");
    check(
        !implicit_plan.use_schur_reduction,
        "implicit certified Schur plan must not enable Schur reduction");

    fd::FrequencySolvePlannerInput explicit_input = implicit_input;
    explicit_input.schur_reduced_explicitly_requested = true;

    const fd::FrequencySolvePlan explicit_plan =
        fd::plan_frequency_response(explicit_input);
    check(
        explicit_plan.lane == fd::FrequencyExecutionLane::schur_reduced,
        "explicit certified Schur request must select schur_reduced");
    check(
        explicit_plan.use_schur_reduction,
        "explicit certified Schur request must record Schur reduction");
}

void RejectsInvalidGaugeWeightsBeforeSchurCertification()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fixture.weights[0] = -0.5;
    fixture.weights[1] = 1.5;
    fd::PoissonAirboxEigenBlockProblem sparse_problem =
        sparse_problem_from_fixture(fixture);
    fd::PoissonAirboxSchurMatShellCertificationResult result{};

    check(
        fd::certify_poisson_airbox_schur_matshell_cpu(
            sparse_problem,
            &result) == fd::FrequencyDomainStatus::validation_error,
        "PA-E3 must reject invalid gauge weights before Schur certification");
    check(
        contains(result.diagnostics_json, "poisson_airbox_schur_requires_mean_zero_gauge"),
        "PA-E3 invalid gauge-weight rejection must use a Schur-specific reason");
    check(
        contains(result.error_message, "positive normalized"),
        "PA-E3 invalid gauge-weight rejection must report positive normalized weights");
}

} // namespace

int main()
{
    CertifiesSchurMatShellAgainstFullCoupledSparseReference();
    PlannerRequiresExplicitCertifiedSchurSelection();
    RejectsInvalidGaugeWeightsBeforeSchurCertification();
    return 0;
}
