/*
 * poisson_airbox_modal_eigen_slepc_test.cpp - PA-E2 CPU sparse/full-coupled
 * Poisson-airbox k=0 modal eigensolve contract tests.
 */

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"

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
    fd::PoissonAirboxModalEigenResult sparse_result{};
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

void SolvesSparseFullCoupledDescriptorAndMatchesDenseOracle()
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
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(
            sparse_problem,
            &fixture.sparse_result) == fd::FrequencyDomainStatus::ok,
        fixture.sparse_result.error_message);

    check(fixture.sparse_result.positive_frequency_branch_found,
          "PA-E2 must select a positive-frequency eigenbranch");
    check(
        fixture.sparse_result.full_residual_reconstruction_relative_error <= 1.0e-10,
        "PA-E2 must reconstruct the full descriptor residual from the returned eigenvector");
    check(
        fixture.sparse_result.gauge_mean_abs <= 1.0e-12,
        "PA-E2 eigenvector potential must satisfy the mean-zero gauge");
    check(
        fixture.sparse_result.relative_reference_frequency_error <= 1.0e-10,
        "PA-E2 sparse SLEPc frequency must match the PA-E1 dense oracle");
}

void EmitsSlepcAdapterDiagnostics()
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
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(
            sparse_problem,
            &fixture.sparse_result) == fd::FrequencyDomainStatus::ok,
        fixture.sparse_result.error_message);
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_slepc\""),
        "PA-E2 diagnostics must name the full-coupled SLEPc adapter");
    check(
        contains(fixture.sparse_result.diagnostics_json, "\"demag_kind\":\"periodic_airbox_k0\""),
        "PA-E2 diagnostics must claim periodic_airbox_k0 only on the full-coupled sparse path");
    check(
        contains(fixture.sparse_result.diagnostics_json, "\"gauge_policy\":\"mean_zero_augmented\""),
        "PA-E2 diagnostics must record mean-zero augmented gauge");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"periodic_mesh_certificate\":{\"schema_version\":\"periodic_mesh_certificate.v5\""),
        "PA-E2 diagnostics must carry the periodic mesh certificate schema");
    check(
        contains(fixture.sparse_result.diagnostics_json, "\"magnetic_pair_count\":1"),
        "PA-E2 diagnostics must carry magnetic periodic pair count");
    check(
        contains(fixture.sparse_result.diagnostics_json, "\"airbox_pair_count\":1"),
        "PA-E2 diagnostics must carry airbox periodic pair count");
}

void RejectsSyntheticPaE1DemagKind()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.demag_kind = "synthetic_poisson_airbox_k0";

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject the PA-E1 synthetic demag_kind");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_requires_periodic_airbox_k0"),
        "PA-E2 synthetic demag rejection must preserve a specific reason");
}

void RejectsMissingPeriodicMeshCertificate()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.periodic_mesh_certificate_required = true;
    problem.periodic_mesh_certificate_schema = nullptr;
    problem.magnetic_pair_count = 0;
    problem.airbox_pair_count = 0;

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject periodic_airbox_k0 without periodic mesh certificate metadata");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_requires_periodic_mesh_certificate"),
        "PA-E2 missing certificate rejection must preserve a specific reason");
}

void RejectsDecoupledDemagBlocks()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    CsrOwned A_qphi{};
    A_qphi.rows = 2;
    A_qphi.columns = 2;
    A_qphi.row_offsets = {0, 2, 4};
    A_qphi.column_indices = {0, 1, 0, 1};
    A_qphi.values = {0.0, 0.0, 0.0, 0.0};
    CsrOwned A_phiq{};
    A_phiq.rows = 2;
    A_phiq.columns = 2;
    A_phiq.row_offsets = {0, 2, 4};
    A_phiq.column_indices = {0, 1, 0, 1};
    A_phiq.values = {0.0, 0.0, 0.0, 0.0};
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.A_qphi = A_qphi.view();
    problem.A_phiq = A_phiq.view();

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject periodic_airbox_k0 when demag coupling blocks are zero");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_requires_full_coupled_blocks"),
        "PA-E2 decoupled demag rejection must preserve a specific reason");
}

void RejectsZeroMeanZeroGaugeWeights()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fixture.weights[0] = 0.0;
    fixture.weights[1] = 0.0;
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject zero mean-zero gauge weights before solving");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_requires_mean_zero_gauge"),
        "PA-E2 zero gauge-weight rejection must preserve a specific reason");
    check(
        contains(result.error_message, "positive normalized"),
        "PA-E2 zero gauge-weight rejection must report positive normalized weights");
}

void RejectsNegativeMeanZeroGaugeWeights()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fixture.weights[0] = -0.5;
    fixture.weights[1] = 1.5;
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject negative mean-zero gauge weights before solving");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_requires_mean_zero_gauge"),
        "PA-E2 negative gauge-weight rejection must preserve a specific reason");
    check(
        contains(result.error_message, "positive normalized"),
        "PA-E2 negative gauge-weight rejection must report positive normalized weights");
}

} // namespace

int main()
{
    SolvesSparseFullCoupledDescriptorAndMatchesDenseOracle();
    EmitsSlepcAdapterDiagnostics();
    RejectsSyntheticPaE1DemagKind();
    RejectsMissingPeriodicMeshCertificate();
    RejectsDecoupledDemagBlocks();
    RejectsZeroMeanZeroGaugeWeights();
    RejectsNegativeMeanZeroGaugeWeights();
    return 0;
}
