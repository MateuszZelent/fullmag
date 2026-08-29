/*
 * poisson_airbox_modal_eigen_slepc_test.cpp - PA-E2 CPU sparse/full-coupled
 * Poisson-airbox k=0 modal eigensolve contract tests.
 */

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "cpu/frequency_domain/poisson_airbox_schur_matshell.hpp"
#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"
#include "frequency_domain/modal_gpu_krylov.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <string>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

extern "C" int fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    const double *v_q_real,
    const double *v_q_imag,
    unsigned long long v_q_count,
    double *out_q_real,
    double *out_q_imag,
    unsigned long long out_q_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len);

extern "C" int fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    unsigned int max_iterations,
    double *out_frequency_hz,
    double *out_relative_residual,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len);

extern "C" int fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_descriptor(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    const double *x_real,
    const double *x_imag,
    unsigned long long x_count,
    double *out_y_real,
    double *out_y_imag,
    unsigned long long out_y_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len);

extern "C" int fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_shifted_descriptor(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    const double *x_real,
    const double *x_imag,
    unsigned long long x_count,
    double *out_y_real,
    double *out_y_imag,
    unsigned long long out_y_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len);

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

int always_cancel(void *)
{
    return 1;
}

std::string read_text(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(input.good(), "expected artifact file must be readable");
    return std::string(
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>());
}

void write_text(const std::filesystem::path &path, const std::string &text)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path);
    check(output.good(), "expected artifact file must be writable");
    output << text;
}

double json_number_after(const char *json, const char *key)
{
    const char *position = std::strstr(json, key);
    check(position != nullptr, "expected diagnostics JSON metric key must exist");
    position += std::strlen(key);
    char *end = nullptr;
    const double value = std::strtod(position, &end);
    check(end != position && std::isfinite(value), "expected diagnostics JSON metric must be finite");
    return value;
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

struct WindowSpectrumFixture {
    std::uint64_t q_count = 0;
    CsrOwned a_qq{};
    CsrOwned a_qphi{};
    CsrOwned a_phiq{};
    CsrOwned a_phiphi{};
    CsrOwned b_qq{};

    fd::PoissonAirboxEigenBlockProblem problem(
        double frequency_min_hz,
        double frequency_max_hz,
        std::uint32_t requested_mode_count) const
    {
        fd::PoissonAirboxEigenBlockProblem value{};
        value.q_dof_count = q_count;
        value.phi_dof_count = 1;
        value.A_qq = a_qq.view();
        value.A_qphi = a_qphi.view();
        value.A_phiq = a_phiq.view();
        value.A_phiphi = a_phiphi.view();
        value.B_qq = b_qq.view();
        value.outer_boundary_kind = "poisson_robin";
        value.robin_beta = 1.0;
        value.gauge_policy = "none";
        value.gauge_reason = "coercive_outer_boundary";
        value.assembly_kind = "mfem_weak_form_shared_domain";
        value.production_shared_domain = true;
        value.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
        value.magnetic_pair_count = 1;
        value.airbox_pair_count = 1;
        value.target_kind = "frequency_window";
        value.frequency_min_hz = frequency_min_hz;
        value.frequency_max_hz = frequency_max_hz;
        value.target_frequency_hz = 0.5 * (frequency_min_hz + frequency_max_hz);
        value.residual_tolerance = 1.0e-8;
        value.requested_mode_count = requested_mode_count;
        value.max_outer_iterations = 64;
        value.max_linear_iterations = 512;
        return value;
    }
};

WindowSpectrumFixture make_window_spectrum_fixture(
    const std::vector<double> &physical_frequencies_hz)
{
    WindowSpectrumFixture fixture{};
    fixture.q_count = 2u * physical_frequencies_hz.size();
    const std::size_t q_count = static_cast<std::size_t>(fixture.q_count);
    std::vector<double> a_qq(q_count * q_count, 0.0);
    std::vector<double> b_qq(q_count * q_count, 0.0);
    for (std::size_t mode = 0; mode < physical_frequencies_hz.size(); ++mode) {
        const std::size_t first = 2u * mode;
        const std::size_t second = first + 1u;
        const double omega = kTwoPi * physical_frequencies_hz[mode];
        a_qq[first * q_count + first] = omega;
        a_qq[second * q_count + second] = omega;
        b_qq[first * q_count + second] = -1.0;
        b_qq[second * q_count + first] = 1.0;
    }
    std::vector<double> a_qphi(q_count, 0.0);
    std::vector<double> a_phiq(q_count, 0.0);
    a_qphi.front() = 1.0e-6;
    a_phiq.front() = 1.0e-6;
    const double a_phiphi[1] = {1.0};
    fixture.a_qq = dense_to_csr(fixture.q_count, fixture.q_count, a_qq.data());
    fixture.a_qphi = dense_to_csr(fixture.q_count, 1, a_qphi.data());
    fixture.a_phiq = dense_to_csr(1, fixture.q_count, a_phiq.data());
    fixture.a_phiphi = dense_to_csr(1, 1, a_phiphi);
    fixture.b_qq = dense_to_csr(fixture.q_count, fixture.q_count, b_qq.data());
    return fixture;
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
    problem.outer_boundary_kind = "pure_neumann";
    problem.robin_beta = 0.0;
    problem.gauge_policy = "mean_zero_augmented";
    problem.gauge_reason = "pure_neumann_nullspace";
    problem.assembly_kind = "synthetic_algebraic_oracle";
    // Keep the shift strictly between eigenvalues.  An exact eigenvalue shift
    // makes the shift-invert linear system singular by construction.
    problem.target_frequency_hz = 1.5e9;
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
        fixture.sparse_result.slepc_reported_backward_error ==
            fixture.sparse_result.eigen_residual_relative,
        "PA-E2 must preserve SLEPc backward error independently");
    check(
        fixture.sparse_result.reconstructed_full_descriptor_backward_error ==
            fixture.sparse_result.full_residual_reconstruction_relative_error,
        "PA-E2 legacy full residual must alias the reconstructed descriptor error");
    check(fixture.sparse_result.accepted_modes.size() == 1,
          "PA-E2 fixture must expose the accepted mode detail");
    check(
        fixture.sparse_result.accepted_modes.front().relative_residual ==
            fixture.sparse_result.accepted_modes.front()
                .full_residual_reconstruction_relative_error,
        "PA-E2 per-mode public residual must be the certified full descriptor residual");
    check(
        fixture.sparse_result.accepted_modes.front().slepc_reported_backward_error ==
            fixture.sparse_result.slepc_reported_backward_error,
        "PA-E2 per-mode detail must preserve the independent SLEPc backward error");
    check(
        fixture.sparse_result.reconstructed_full_descriptor_backward_error ==
            std::max(
                fixture.sparse_result.magnetic_block_backward_error,
                std::max(
                    fixture.sparse_result.poisson_block_backward_error,
                    fixture.sparse_result.gauge_constraint_backward_error)),
        "PA-E2 reconstructed descriptor error must be the maximum blockwise error");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"slepc_reported_backward_error\""),
        "PA-E2 diagnostics must publish the independent SLEPc backward error");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"reconstructed_full_descriptor_backward_error\""),
        "PA-E2 diagnostics must publish the reconstructed descriptor error");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"reconstruction_vs_slepc_ratio\""),
        "PA-E2 diagnostics must publish reconstruction-to-SLEPc disagreement");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"spectral_pencil_kind\":\"real_frequency_rotated\""),
        "PA-E2 must solve through the managed real-frequency-rotated pencil");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"target_representation\":\"tau=omega_target\""),
        "PA-E2 must publish the real tau target instead of an imaginary-axis target");
    check(
        fixture.sparse_result.gauge_mean_abs <= 1.0e-12,
        "PA-E2 eigenvector potential must satisfy the mean-zero gauge");
    check(
        fixture.sparse_result.relative_reference_frequency_error <= 1.0e-10,
        "PA-E2 sparse SLEPc frequency must match the PA-E1 dense oracle");
}

void ReconstructedResidualCannotBeHiddenBySlepcBackwardError()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    const double vector_real[5] = {1.0, 0.0, 1000.0, -1000.0, 0.0};
    const double vector_imag[5] = {};
    fd::PoissonAirboxModalResidualMetrics metrics{};

    check(
        fd::evaluate_poisson_airbox_modal_residuals(
            problem,
            vector_real,
            vector_imag,
            5,
            0.0,
            kTwoPi * 2.0e9,
            1.0e-14,
            &metrics) == fd::FrequencyDomainStatus::ok,
        "PA-E2 residual evaluator must accept a finite full descriptor vector");
    check(
        metrics.slepc_reported_backward_error == 1.0e-14,
        "PA-E2 residual evaluator must preserve the independent SLEPc error");
    check(
        metrics.reconstructed_full_descriptor_backward_error > 1.0e-4,
        "PA-E2 reconstructed residual must expose a deliberately bad phi block");
    check(
        metrics.reconstructed_full_descriptor_backward_error >
            1.0e6 * metrics.slepc_reported_backward_error,
        "PA-E2 must not replace a bad reconstructed residual with the SLEPc error");
    check(
        metrics.reconstructed_full_descriptor_backward_error ==
            std::max(
                metrics.magnetic_block_backward_error,
                std::max(
                    metrics.poisson_block_backward_error,
                    metrics.gauge_constraint_backward_error)),
        "PA-E2 full certification residual must be the maximum blockwise backward error");
    check(
        metrics.reconstruction_vs_slepc_ratio > 1.0e6,
        "PA-E2 diagnostics must expose disagreement between reconstruction and SLEPc");
}

void ResidualCertificationRejectsBackendAndReconstructionDisagreement()
{
    fd::PoissonAirboxModalResidualMetrics metrics{};
    metrics.slepc_reported_backward_error = 1.0e-14;
    metrics.reconstructed_full_descriptor_backward_error = 1.0e-2;
    metrics.reconstruction_vs_slepc_ratio = 1.0e12;
    metrics.magnetic_block_backward_error = 1.0e-2;
    metrics.poisson_block_backward_error = 1.0e-6;
    metrics.gauge_constraint_backward_error = 1.0e-8;
    fd::PoissonAirboxModalEigenResult result{};

    check(
        fd::apply_poisson_airbox_modal_residual_certification(
            metrics,
            1.0e-10,
            &result) == fd::FrequencyDomainStatus::solve_error,
        "PA-E2 certification must reject a bad reconstruction despite a small SLEPc error");
    check(
        result.full_residual_reconstruction_relative_error == 1.0e-2,
        "PA-E2 certification must not replace the reconstructed residual with min(SLEPc, full)");
    check(
        !result.full_residual_certified,
        "PA-E2 result must keep failed reconstruction certification explicit");
}

void ConjugatedCandidateRequiresConjugatedEigenvalue()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    const double vector_real[5] = {
        0.6347055818368641,
        0.0,
        0.0,
        0.0,
        0.0};
    const double vector_imag[5] = {
        0.0,
        -0.6309510410933259,
        -0.315475520546663,
        0.31547552054666295,
        0.0};
    double conjugated_imag[5] = {};
    for (std::size_t index = 0; index < 5; ++index) {
        conjugated_imag[index] = -vector_imag[index];
    }
    constexpr double omega = 12641148128.614883;
    fd::PoissonAirboxModalResidualMetrics positive{};
    fd::PoissonAirboxModalResidualMetrics invalid_mixed_pair{};
    fd::PoissonAirboxModalResidualMetrics conjugated_pair{};

    check(
        fd::evaluate_poisson_airbox_modal_residuals(
            problem, vector_real, vector_imag, 5, 0.0, omega, 1.0e-14, &positive) ==
            fd::FrequencyDomainStatus::ok,
        "PA-E2 must evaluate the positive-frequency eigenpair");
    check(
        fd::evaluate_poisson_airbox_modal_residuals(
            problem,
            vector_real,
            conjugated_imag,
            5,
            0.0,
            omega,
            1.0e-14,
            &invalid_mixed_pair) == fd::FrequencyDomainStatus::ok,
        "PA-E2 must evaluate a deliberately mixed conjugate candidate");
    check(
        fd::evaluate_poisson_airbox_modal_residuals(
            problem,
            vector_real,
            conjugated_imag,
            5,
            0.0,
            -omega,
            1.0e-14,
            &conjugated_pair) == fd::FrequencyDomainStatus::ok,
        "PA-E2 must evaluate the fully conjugated eigenpair");
    check(
        positive.reconstructed_full_descriptor_backward_error <= 1.0e-12,
        "PA-E2 positive-frequency analytical eigenpair must satisfy the descriptor");
    check(
        invalid_mixed_pair.reconstructed_full_descriptor_backward_error >= 0.9,
        "PA-E2 must reject conj(x) paired with unchanged positive lambda");
    check(
        conjugated_pair.reconstructed_full_descriptor_backward_error <= 1.0e-12,
        "PA-E2 must accept conjugation only together with conj(lambda)");
}

void ResidualEvaluatorRejectsNonfiniteComputedMetrics()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    const double vector_real[5] = {1.0e308, -1.0e308, 1.0e308, -1.0e308, 0.0};
    fd::PoissonAirboxModalResidualMetrics metrics{};
    check(
        fd::evaluate_poisson_airbox_modal_residuals(
            problem,
            vector_real,
            nullptr,
            5,
            0.0,
            kTwoPi * 2.0e9,
            0.0,
            &metrics) == fd::FrequencyDomainStatus::operator_error,
        "PA-E2 residual evaluator must reject overflow instead of publishing inf or nan");
}

void AppliesFullCoupledShiftInvertActionReference()
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
    const double sigma_re = 0.0;
    const double sigma_im = kTwoPi * 1.25e9;
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};
    double out_re[2] = {};
    double out_im[2] = {};
    fd::PoissonAirboxModalShiftInvertActionResult result{};

    check(
        fd::apply_poisson_airbox_modal_shift_invert_action_cpu_reference(
            sparse_problem,
            sigma_re,
            sigma_im,
            v_re,
            v_im,
            2,
            out_re,
            out_im,
            2,
            &result) == fd::FrequencyDomainStatus::ok,
        result.error_message);

    const double output_norm =
        std::sqrt(out_re[0] * out_re[0] + out_im[0] * out_im[0] +
                  out_re[1] * out_re[1] + out_im[1] * out_im[1]);
    check(output_norm > 0.0, "PA-G3 CPU reference shift-invert action must produce a nonzero q output");
    check(
        result.shifted_system_relative_residual <= 1.0e-10,
        "PA-G3 CPU reference shift-invert action must solve (A - sigma B)^-1 Bv accurately");
    check(
        contains(result.diagnostics_json, "\"operator_family\":\"full_modal_shift_invert\""),
        "PA-G3 CPU reference diagnostics must identify full modal shift-invert");
    check(
        contains(result.diagnostics_json, "\"full_modal_shift_invert_claim\":true"),
        "PA-G3 CPU reference diagnostics must explicitly claim the modal shift-invert action");
}

void AppliesGpuFullCoupledShiftInvertActionAndMatchesCpuReference()
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
    const double sigma_re = 0.0;
    const double sigma_im = kTwoPi * 1.25e9;
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};
    double cpu_re[2] = {};
    double cpu_im[2] = {};
    fd::PoissonAirboxModalShiftInvertActionResult cpu_result{};
    check(
        fd::apply_poisson_airbox_modal_shift_invert_action_cpu_reference(
            sparse_problem,
            sigma_re,
            sigma_im,
            v_re,
            v_im,
            2,
            cpu_re,
            cpu_im,
            2,
            &cpu_result) == fd::FrequencyDomainStatus::ok,
        cpu_result.error_message);

    double gpu_re[2] = {};
    double gpu_im[2] = {};
    char diagnostics_json[4096] = {};
    char error_message[256] = {};
    check(
        fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action(
            &sparse_problem,
            sigma_re,
            sigma_im,
            v_re,
            v_im,
            2,
            gpu_re,
            gpu_im,
            2,
            diagnostics_json,
            sizeof(diagnostics_json),
            error_message,
            sizeof(error_message)) == 0,
        error_message);

    double numerator = 0.0;
    double denominator = 0.0;
    for (std::size_t index = 0; index < 2; ++index) {
        const double dr = gpu_re[index] - cpu_re[index];
        const double di = gpu_im[index] - cpu_im[index];
        numerator += dr * dr + di * di;
        denominator += cpu_re[index] * cpu_re[index] + cpu_im[index] * cpu_im[index];
    }
    const double relative_error =
        std::sqrt(numerator) / (std::sqrt(denominator) + 1.0e-300);
    check(
        relative_error <= 1.0e-10,
        "PA-G3f GPU modal shift-invert action must match the CPU full-coupled reference");
    check(
        contains(diagnostics_json, "\"schema_version\":\"gpu_modal_shift_invert_action.v1\""),
        "PA-G3f GPU action diagnostics must expose the GPU modal action schema");
    check(
        contains(diagnostics_json, "\"operator_family\":\"full_modal_shift_invert\""),
        "PA-G3f GPU action diagnostics must identify full modal shift-invert");
    check(
        contains(diagnostics_json, "\"algebraic_action\":\"(A - sigma B)^-1 Bv\""),
        "PA-G3f GPU action diagnostics must identify the algebraic action");
    check(
        contains(diagnostics_json, "\"rhs_family\":\"modal_mass_times_vector\""),
        "PA-G3f GPU action diagnostics must identify Bv as the RHS family");
    check(
        contains(diagnostics_json, "\"full_modal_shift_invert_claim\":true"),
        "PA-G3f GPU action diagnostics must claim true modal shift-invert");
    check(
        contains(diagnostics_json, "\"frequency_response_proxy\":false"),
        "PA-G3f GPU action diagnostics must explicitly reject the frequency-response proxy path");

    const char *artifact_root_raw = std::getenv("FULLMAG_PA_G3F_OUTPUT_DIR");
    if (artifact_root_raw != nullptr && artifact_root_raw[0] != '\0') {
        const std::filesystem::path artifact_root = artifact_root_raw;
        const std::filesystem::path diagnostics_dir =
            artifact_root / "eigen" / "diagnostics";
        const std::filesystem::path cpu_action_path =
            diagnostics_dir / "poisson_airbox_modal_shift_invert_action.v1.json";
        const std::filesystem::path gpu_action_path =
            diagnostics_dir / "gpu_modal_shift_invert_action.v1.json";
        const std::filesystem::path parity_path =
            artifact_root / "gpu_modal_shift_invert_action_parity.v1.json";
        write_text(cpu_action_path, std::string(cpu_result.diagnostics_json) + "\n");
        write_text(gpu_action_path, std::string(diagnostics_json) + "\n");

        const double gpu_residual = json_number_after(
            diagnostics_json,
            "\"shifted_system_relative_residual\":");
        char parity_json[4096] = {};
        std::snprintf(
            parity_json,
            sizeof(parity_json),
            "{"
            "\"schema_version\":\"gpu_modal_shift_invert_action_parity.v1\","
            "\"lane\":\"gpu_poisson_airbox_k0\","
            "\"execution_policy\":\"device\","
            "\"memory_location\":\"device\","
            "\"fallback_used\":false,"
            "\"source\":{"
            "\"cpu_action_artifact\":\"%s\","
            "\"gpu_action_artifact\":\"%s\""
            "},"
            "\"gpu_modal_shift_invert_action_parity\":{"
            "\"status\":\"passed\","
            "\"fallback_used\":false,"
            "\"operator_family\":\"full_modal_shift_invert\","
            "\"algebraic_action\":\"(A - sigma B)^-1 Bv\","
            "\"rhs_family\":\"modal_mass_times_vector\","
            "\"cpu_reference_schema_version\":\"poisson_airbox_modal_shift_invert_action.v1\","
            "\"gpu_action_schema_version\":\"gpu_modal_shift_invert_action.v1\","
            "\"full_modal_shift_invert_claim\":true,"
            "\"per_iteration_h2d_count\":0,"
            "\"per_iteration_d2h_count\":0,"
            "\"max_relative_action_error\":%.17g,"
            "\"q_response_relative_l2_error\":%.17g,"
            "\"shifted_system_relative_residual_cpu\":%.17g,"
            "\"shifted_system_relative_residual_gpu\":%.17g"
            "}"
            "}\n",
            cpu_action_path.string().c_str(),
            gpu_action_path.string().c_str(),
            relative_error,
            relative_error,
            cpu_result.shifted_system_relative_residual,
            gpu_residual);
        write_text(parity_path, parity_json);
    }
}

void SolvesGpuDensePoissonAirboxModalEigenAndMatchesCpuReference()
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

    double gpu_frequency_hz = 0.0;
    double gpu_relative_residual = 1.0;
    char diagnostics_json[4096] = {};
    char error_message[256] = {};
    check(
        fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver(
            &sparse_problem,
            0.0,
            kTwoPi * 1.25e9,
            24,
            &gpu_frequency_hz,
            &gpu_relative_residual,
            diagnostics_json,
            sizeof(diagnostics_json),
            error_message,
            sizeof(error_message)) == 0,
        error_message);

    const double relative_frequency_error =
        std::abs(gpu_frequency_hz - fixture.sparse_result.frequency_hz) /
        (std::abs(fixture.sparse_result.frequency_hz) + 1.0e-300);
    check(relative_frequency_error <= 1.0e-8,
          "GPU-G5a dense modal eigensolver frequency must match CPU/SLEPc reference");
    check(gpu_relative_residual <= 1.0e-8,
          "GPU-G5a dense modal eigensolver must certify the full descriptor residual");
    check(
        contains(diagnostics_json, "\"schema_version\":\"gpu_modal_poisson_airbox_eigensolver.v1\""),
        "GPU-G5a diagnostics must expose the modal Poisson-airbox eigensolver schema");
    check(
        contains(diagnostics_json, "\"lane\":\"gpu_poisson_airbox_k0_dense_validation\""),
        "GPU-G5a diagnostics must identify the bounded Poisson-airbox validation lane");
    check(
        contains(diagnostics_json, "\"execution_lane\":\"gpu_dense_modal_validation\""),
        "GPU-G5a diagnostics must identify the dense modal validation execution lane");
    check(
        contains(diagnostics_json, "\"solver_adapter\":\"gpu_dense_poisson_airbox_modal_dense_validation_contract\""),
        "GPU-G5a diagnostics must identify the bounded dense validation adapter");
    check(
        contains(diagnostics_json, "\"operator_storage\":\"device\""),
        "GPU-G5a diagnostics must report device operator storage");
    check(
        contains(diagnostics_json, "\"eigensolver_iteration_location\":\"device\""),
        "GPU-G5a diagnostics must report device iteration location");
    check(
        contains(diagnostics_json, "\"persistent_solver_context\":false"),
        "GPU-G5a diagnostics must report the non-persistent solver context");
    check(
        contains(diagnostics_json, "\"scalable_sparse_or_matrix_free\":false"),
        "GPU-G5a diagnostics must reject scalable sparse or matrix-free status");
    check(
        contains(diagnostics_json, "\"validation_only\":true"),
        "GPU-G5a diagnostics must report validation-only status");
    check(
        contains(diagnostics_json, "\"production_modal_claim\":false"),
        "GPU-G5a diagnostics must reject a production modal claim");
    check(
        contains(diagnostics_json, "\"gpu_device_resident_modal_eigensolver\":false"),
        "GPU-G5a diagnostics must reject the broad device-resident modal claim");
    check(
        contains(diagnostics_json, "\"frequency_response_proxy\":false"),
        "GPU-G5a diagnostics must reject frequency-response proxy semantics");
    check(
        contains(diagnostics_json, "\"cpu_fallback\":\"disabled\""),
        "GPU-G5a diagnostics must keep CPU fallback disabled");

    const char *artifact_root_raw = std::getenv("FULLMAG_PA_G3F_OUTPUT_DIR");
    if (artifact_root_raw != nullptr && artifact_root_raw[0] != '\0') {
        const std::filesystem::path artifact_root = artifact_root_raw;
        const std::filesystem::path artifact_path =
            artifact_root / "eigen" / "diagnostics" /
            "gpu_modal_poisson_airbox_eigensolver.v1.json";
        write_text(artifact_path, std::string(diagnostics_json) + "\n");
    }
}

void AppliesGpuFullCoupledDescriptorAndMatchesCpuReference()
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
    const double x_re[5] = {1.0, -0.5, 0.25, -0.75, 0.125};
    const double x_im[5] = {0.2, 0.1, -0.4, 0.6, -0.3};

    const unsigned long long nq = sparse_problem.q_dof_count;
    const unsigned long long np = sparse_problem.phi_dof_count;
    const unsigned long long total = nq + np + 1;
    double cpu_re[5] = {};
    double cpu_im[5] = {};
    for (std::uint64_t row = 0; row < sparse_problem.A_qq.row_count; ++row) {
        for (std::uint32_t entry = sparse_problem.A_qq.row_offsets[row];
             entry < sparse_problem.A_qq.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = sparse_problem.A_qq.column_indices[entry];
            cpu_re[row] += sparse_problem.A_qq.values[entry] * x_re[column];
            cpu_im[row] += sparse_problem.A_qq.values[entry] * x_im[column];
        }
        for (std::uint32_t entry = sparse_problem.A_qphi.row_offsets[row];
             entry < sparse_problem.A_qphi.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = nq + sparse_problem.A_qphi.column_indices[entry];
            cpu_re[row] += sparse_problem.A_qphi.values[entry] * x_re[column];
            cpu_im[row] += sparse_problem.A_qphi.values[entry] * x_im[column];
        }
    }
    for (std::uint64_t row = 0; row < sparse_problem.A_phiphi.row_count; ++row) {
        const std::uint64_t output_row = nq + row;
        for (std::uint32_t entry = sparse_problem.A_phiq.row_offsets[row];
             entry < sparse_problem.A_phiq.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = sparse_problem.A_phiq.column_indices[entry];
            cpu_re[output_row] += sparse_problem.A_phiq.values[entry] * x_re[column];
            cpu_im[output_row] += sparse_problem.A_phiq.values[entry] * x_im[column];
        }
        for (std::uint32_t entry = sparse_problem.A_phiphi.row_offsets[row];
             entry < sparse_problem.A_phiphi.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = nq + sparse_problem.A_phiphi.column_indices[entry];
            cpu_re[output_row] += sparse_problem.A_phiphi.values[entry] * x_re[column];
            cpu_im[output_row] += sparse_problem.A_phiphi.values[entry] * x_im[column];
        }
        cpu_re[output_row] += sparse_problem.phi_mean_weights[row] * x_re[nq + np];
        cpu_im[output_row] += sparse_problem.phi_mean_weights[row] * x_im[nq + np];
        cpu_re[nq + np] += sparse_problem.phi_mean_weights[row] * x_re[nq + row];
        cpu_im[nq + np] += sparse_problem.phi_mean_weights[row] * x_im[nq + row];
    }

    double gpu_re[5] = {};
    double gpu_im[5] = {};
    char diagnostics_json[4096] = {};
    char error_message[256] = {};
    check(
        fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_descriptor(
            &sparse_problem,
            x_re,
            x_im,
            total,
            gpu_re,
            gpu_im,
            total,
            diagnostics_json,
            sizeof(diagnostics_json),
            error_message,
            sizeof(error_message)) == 0,
        error_message);

    double numerator = 0.0;
    double denominator = 0.0;
    for (std::size_t index = 0; index < total; ++index) {
        const double dr = gpu_re[index] - cpu_re[index];
        const double di = gpu_im[index] - cpu_im[index];
        numerator += dr * dr + di * di;
        denominator += cpu_re[index] * cpu_re[index] + cpu_im[index] * cpu_im[index];
    }
    const double relative_error =
        std::sqrt(numerator) / (std::sqrt(denominator) + 1.0e-300);
    check(
        relative_error <= 1.0e-12,
        "GPU-G5b descriptor apply must match CPU full-coupled descriptor Ax");
    check(
        contains(diagnostics_json, "\"schema_version\":\"gpu_modal_poisson_airbox_descriptor_apply.v1\""),
        "GPU-G5b descriptor apply diagnostics must expose its schema");
    check(
        contains(diagnostics_json, "\"operator_family\":\"full_coupled_poisson_airbox_modal_pencil\""),
        "GPU-G5b descriptor apply diagnostics must identify the modal descriptor pencil");
    check(
        contains(diagnostics_json, "\"algebraic_action\":\"A*x\""),
        "GPU-G5b descriptor apply diagnostics must identify descriptor A*x");
    check(
        contains(diagnostics_json, "\"matrix_format\":\"csr_device_apply\""),
        "GPU-G5b descriptor apply diagnostics must identify CSR device apply");
    check(
        contains(diagnostics_json, "\"frequency_response_proxy\":false"),
        "GPU-G5b descriptor apply must reject frequency-response proxy semantics");
    check(
        contains(diagnostics_json, "\"gpu_device_resident_operator_apply\":true"),
        "GPU-G5b descriptor apply must claim device-resident operator apply");

    const char *artifact_root_raw = std::getenv("FULLMAG_PA_G3F_OUTPUT_DIR");
    if (artifact_root_raw != nullptr && artifact_root_raw[0] != '\0') {
        const std::filesystem::path artifact_root = artifact_root_raw;
        const std::filesystem::path artifact_path =
            artifact_root / "eigen" / "diagnostics" /
            "gpu_modal_poisson_airbox_descriptor_apply.v1.json";
        write_text(artifact_path, std::string(diagnostics_json) + "\n");
    }
}

void AppliesGpuShiftedFullCoupledDescriptorAndMatchesCpuReference()
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
    const double sigma_re = 0.0;
    const double sigma_im = kTwoPi * 1.25e9;
    const double x_re[5] = {1.0, -0.5, 0.25, -0.75, 0.125};
    const double x_im[5] = {0.2, 0.1, -0.4, 0.6, -0.3};

    const unsigned long long nq = sparse_problem.q_dof_count;
    const unsigned long long np = sparse_problem.phi_dof_count;
    const unsigned long long total = nq + np + 1;
    double cpu_re[5] = {};
    double cpu_im[5] = {};
    for (std::uint64_t row = 0; row < sparse_problem.A_qq.row_count; ++row) {
        for (std::uint32_t entry = sparse_problem.A_qq.row_offsets[row];
             entry < sparse_problem.A_qq.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = sparse_problem.A_qq.column_indices[entry];
            cpu_re[row] += sparse_problem.A_qq.values[entry] * x_re[column];
            cpu_im[row] += sparse_problem.A_qq.values[entry] * x_im[column];
        }
        for (std::uint32_t entry = sparse_problem.A_qphi.row_offsets[row];
             entry < sparse_problem.A_qphi.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = nq + sparse_problem.A_qphi.column_indices[entry];
            cpu_re[row] += sparse_problem.A_qphi.values[entry] * x_re[column];
            cpu_im[row] += sparse_problem.A_qphi.values[entry] * x_im[column];
        }
    }
    for (std::uint64_t row = 0; row < sparse_problem.A_phiphi.row_count; ++row) {
        const std::uint64_t output_row = nq + row;
        for (std::uint32_t entry = sparse_problem.A_phiq.row_offsets[row];
             entry < sparse_problem.A_phiq.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = sparse_problem.A_phiq.column_indices[entry];
            cpu_re[output_row] += sparse_problem.A_phiq.values[entry] * x_re[column];
            cpu_im[output_row] += sparse_problem.A_phiq.values[entry] * x_im[column];
        }
        for (std::uint32_t entry = sparse_problem.A_phiphi.row_offsets[row];
             entry < sparse_problem.A_phiphi.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = nq + sparse_problem.A_phiphi.column_indices[entry];
            cpu_re[output_row] += sparse_problem.A_phiphi.values[entry] * x_re[column];
            cpu_im[output_row] += sparse_problem.A_phiphi.values[entry] * x_im[column];
        }
        cpu_re[output_row] += sparse_problem.phi_mean_weights[row] * x_re[nq + np];
        cpu_im[output_row] += sparse_problem.phi_mean_weights[row] * x_im[nq + np];
        cpu_re[nq + np] += sparse_problem.phi_mean_weights[row] * x_re[nq + row];
        cpu_im[nq + np] += sparse_problem.phi_mean_weights[row] * x_im[nq + row];
    }
    for (std::uint64_t row = 0; row < sparse_problem.B_qq.row_count; ++row) {
        double bx_re = 0.0;
        double bx_im = 0.0;
        for (std::uint32_t entry = sparse_problem.B_qq.row_offsets[row];
             entry < sparse_problem.B_qq.row_offsets[row + 1];
             ++entry) {
            const std::uint64_t column = sparse_problem.B_qq.column_indices[entry];
            bx_re += sparse_problem.B_qq.values[entry] * x_re[column];
            bx_im += sparse_problem.B_qq.values[entry] * x_im[column];
        }
        cpu_re[row] -= sigma_re * bx_re - sigma_im * bx_im;
        cpu_im[row] -= sigma_re * bx_im + sigma_im * bx_re;
    }

    double gpu_re[5] = {};
    double gpu_im[5] = {};
    char diagnostics_json[4096] = {};
    char error_message[256] = {};
    check(
        fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_shifted_descriptor(
            &sparse_problem,
            sigma_re,
            sigma_im,
            x_re,
            x_im,
            total,
            gpu_re,
            gpu_im,
            total,
            diagnostics_json,
            sizeof(diagnostics_json),
            error_message,
            sizeof(error_message)) == 0,
        error_message);

    double numerator = 0.0;
    double denominator = 0.0;
    for (std::size_t index = 0; index < total; ++index) {
        const double dr = gpu_re[index] - cpu_re[index];
        const double di = gpu_im[index] - cpu_im[index];
        numerator += dr * dr + di * di;
        denominator += cpu_re[index] * cpu_re[index] + cpu_im[index] * cpu_im[index];
    }
    const double relative_error =
        std::sqrt(numerator) / (std::sqrt(denominator) + 1.0e-300);
    check(
        relative_error <= 1.0e-12,
        "GPU-G5c shifted descriptor apply must match CPU (A - sigma B)x");
    check(
        contains(diagnostics_json, "\"schema_version\":\"gpu_modal_poisson_airbox_shifted_descriptor_apply.v1\""),
        "GPU-G5c shifted descriptor diagnostics must expose its schema");
    check(
        contains(diagnostics_json, "\"algebraic_action\":\"(A - sigma B)*x\""),
        "GPU-G5c shifted descriptor diagnostics must identify shifted apply");
    check(
        contains(diagnostics_json, "\"matrix_format\":\"csr_device_shifted_apply\""),
        "GPU-G5c shifted descriptor diagnostics must identify CSR shifted device apply");
    check(
        contains(diagnostics_json, "\"frequency_response_proxy\":false"),
        "GPU-G5c shifted descriptor apply must reject frequency-response proxy semantics");
    check(
        contains(diagnostics_json, "\"gpu_device_resident_shifted_operator_apply\":true"),
        "GPU-G5c shifted descriptor apply must claim device-resident shifted operator apply");

    const char *artifact_root_raw = std::getenv("FULLMAG_PA_G3F_OUTPUT_DIR");
    if (artifact_root_raw != nullptr && artifact_root_raw[0] != '\0') {
        const std::filesystem::path artifact_root = artifact_root_raw;
        const std::filesystem::path artifact_path =
            artifact_root / "eigen" / "diagnostics" /
            "gpu_modal_poisson_airbox_shifted_descriptor_apply.v1.json";
        write_text(artifact_path, std::string(diagnostics_json) + "\n");
    }
}

void ModalContractWritesShiftInvertActionArtifact()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::DensePoissonAirboxEigenOracleProblem dense_problem =
        dense_problem_from_fixture(fixture);
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(
            dense_problem,
            &fixture.dense_result) == fd::FrequencyDomainStatus::ok,
        fixture.dense_result.error_message);

    fd::ModalEigenRequest request{};
    request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.gamma_rad_s_T = 1.76085963023e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.requested_mode_count = 1;
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.residual_tolerance = 1.0e-10;
    request.max_outer_iterations = 64;
    request.max_linear_iterations = 128;
    const std::filesystem::path output_dir =
        std::filesystem::temp_directory_path() /
        "fullmag-pa-g3b-modal-shift-invert-action-contract";
    std::filesystem::remove_all(output_dir);
    std::filesystem::create_directories(output_dir);
    const std::string output_dir_string = output_dir.string();
    request.output_directory = output_dir_string.c_str();
    request.write_partial_artifacts = 1;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = fixture.A_qq.view();
    request.poisson_airbox_a_qphi_csr = fixture.A_qphi.view();
    request.poisson_airbox_a_phiq_csr = fixture.A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = fixture.A_phiphi.view();
    request.poisson_airbox_b_qq_csr = fixture.B_qq.view();
    request.poisson_airbox_phi_mean_weights = fixture.weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz =
        fixture.dense_result.frequency_hz;
    request.poisson_airbox_periodic_mesh_certificate_schema =
        "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_shift_invert_action_enabled = 1;
    request.poisson_airbox_shift_sigma_real = 0.0;
    request.poisson_airbox_shift_sigma_imag = kTwoPi * 1.25e9;
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};
    request.poisson_airbox_shift_action_vector_real = v_re;
    request.poisson_airbox_shift_action_vector_imag = v_im;
    request.poisson_airbox_shift_action_vector_count = 2;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";

    const fd::FrequencyDomainContractResult result =
        fd::solve_modal_eigen_contract(request);

    check(result.status == fd::FrequencyDomainStatus::ok,
          result.error_message.c_str());
    check(
        result.artifact_manifest_path.find("poisson_airbox_modal_shift_invert_action.v1.json") !=
            std::string::npos,
        "PA-G3b modal contract result must point at the shift-invert action artifact");
    const std::filesystem::path artifact_path =
        output_dir / "eigen" / "diagnostics" /
        "poisson_airbox_modal_shift_invert_action.v1.json";
    const std::string artifact = read_text(artifact_path);
    check(
        artifact.find("\"schema_version\":\"poisson_airbox_modal_shift_invert_action.v1\"") !=
            std::string::npos,
        "PA-G3b modal action artifact must expose schema version");
    check(
        artifact.find("\"operator_family\":\"full_modal_shift_invert\"") !=
            std::string::npos,
        "PA-G3b modal action artifact must identify full modal shift-invert");
    check(
        artifact.find("\"algebraic_action\":\"(A - sigma B)^-1 Bv\"") !=
            std::string::npos,
        "PA-G3b modal action artifact must identify the algebraic action");
    check(
        artifact.find("\"full_modal_shift_invert_claim\":true") !=
            std::string::npos,
        "PA-G3b modal action artifact must claim true modal shift-invert");
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
            "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_slepc\""),
        "PA-E2 singular pure-Neumann diagnostics must name the Schur adapter");
    check(
        contains(
            fixture.sparse_result.diagnostics_json,
            "\"requested_solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_slepc\""),
        "PA-E2 singular pure-Neumann diagnostics must preserve the requested full-coupled adapter");
    check(
        contains(fixture.sparse_result.diagnostics_json, "\"validation_only\":true"),
        "PA-E2 synthetic singular pure-Neumann diagnostics must remain validation-only");
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

void AnalyticalReferenceDoesNotGateTheModalSolve()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.expected_reference_frequency_hz = 1.0;

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        "PA-E2 analytical reference mismatch must remain a postsolve diagnostic, not a solve gate");
    check(
        !result.reference_frequency_certified,
        "PA-E2 must preserve the failed analytical-reference comparison as postsolve metadata");
    check(
        result.full_residual_certified,
        "PA-E2 analytical-reference mismatch must not weaken descriptor residual certification");
}

void RejectsZeroRequestedModeCountAndUnknownTargetKind()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);

    problem.requested_mode_count = 0;
    fd::PoissonAirboxModalEigenResult zero_count_result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &zero_count_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject requested_mode_count=0 instead of silently promoting it to one");
    check(
        contains(zero_count_result.diagnostics_json, "poisson_airbox_eigen_invalid_requested_mode_count"),
        "PA-E2 zero mode-count rejection must publish a stable reason");

    problem = sparse_problem_from_fixture(fixture);
    problem.target_kind = "unsupported_target";
    fd::PoissonAirboxModalEigenResult target_result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &target_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject an unknown target_kind before invoking SLEPc");
    check(
        contains(target_result.diagnostics_json, "poisson_airbox_eigen_unsupported_target_kind"),
        "PA-E2 unknown target rejection must publish a stable reason");
}

void RejectsFrequencyWindowOnFullCoupledAdapter()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 1.0e9;
    problem.frequency_max_hz = 2.0e9;
    problem.target_frequency_hz = 0.0;
    problem.solver_adapter = "k0_poisson_airbox_cpu_full_coupled_slepc";
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    problem.phi_mean_weights = nullptr;
    problem.phi_mean_weights_count = 0;

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 full-coupled adapter must not silently ignore a frequency window");
    check(
        contains(result.diagnostics_json,
                 "poisson_airbox_eigen_frequency_window_requires_schur_adapter"),
        "PA-E2 frequency-window adapter rejection must publish a stable reason");
}

void PublishesCanonicalResidualFieldsAndSolverReasons()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(
        contains(result.diagnostics_json,
                 "\"modal_original_unscaled_full_descriptor_backward_error\":"),
        "PA-E2 must publish the canonical original-unscaled full residual field");
    check(
        contains(result.diagnostics_json,
                 "\"modal_original_unscaled_magnetic_block_backward_error\":"),
        "PA-E2 must publish the canonical original-unscaled magnetic residual field");
    check(
        contains(result.diagnostics_json,
                 "\"modal_original_unscaled_poisson_block_backward_error\":"),
        "PA-E2 must publish the canonical original-unscaled Poisson residual field");
    check(
        contains(result.diagnostics_json,
                 "\"modal_original_unscaled_gauge_constraint_backward_error\":"),
        "PA-E2 must publish the canonical original-unscaled gauge residual field");
    check(
        contains(result.diagnostics_json, "\"slepc_converged_reason\":"),
        "PA-E2 must publish the explicit SLEPc convergence reason");
    check(
        contains(result.diagnostics_json, "\"stop_reason\":"),
        "PA-E2 must publish the explicit solver stop reason");
}

void FrequencyWindowPublishesCompleteCertificateForSyntheticFixture()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 2.0e9, 3.0e9});
    const fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        0.5e9,
        2.5e9,
        2);

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.window_complete,
          "synthetic CPU frequency window must expose a complete-window certificate");
    check(result.window_subwindow_count == 50u,
          "complete-window certificate must preserve the exact 16+34 subwindow schedule");
    check(result.window_completed_subwindow_count == result.window_subwindow_count,
          "complete-window certificate must account for every subwindow");
    check(result.window_failed_subwindow_count == 0u,
          "complete-window certificate must report no failed subwindows");
    check(contains(
              result.diagnostics_json,
              "\"operator_context_scope\":\"frequency_window\""),
          "CPU diagnostics must identify frequency-window operator ownership");
    check(json_number_after(
              result.diagnostics_json,
              "\"operator_context_setup_count\":") == 1.0,
          "a complete CPU window must configure one persistent operator context");
    check(json_number_after(
              result.diagnostics_json,
              "\"poisson_factorization_setup_count\":") == 1.0,
          "a complete CPU window must factorize Poisson exactly once");
    check(json_number_after(
              result.diagnostics_json,
              "\"shift_solver_setup_count\":") == 50.0,
          "a complete CPU window must configure one shift solver per planned subwindow");
    check(contains(result.diagnostics_json, "\"window_completeness\":{\"status\":\"certified\""),
          "CPU diagnostics must publish a certified window-completeness object");
    check(contains(result.diagnostics_json, "\"window_certificate\":"),
          "CPU diagnostics must publish the complete-window certificate payload");
    check(contains(result.window_certificate_json,
                   "\"method\":\"shift_nev_refinement_subspace_v1\""),
          "complete-window certificate must name the two-pass refinement method");
    check(contains(result.window_certificate_json, "\"base_schedule\":{"),
          "complete-window certificate must publish the base schedule state");
    check(contains(result.window_certificate_json, "\"refinement_schedule\":{"),
          "complete-window certificate must publish the refinement schedule state");
    const double requested_nev = json_number_after(
        result.window_certificate_json,
        "\"requested_nev\":");
    const double refined_nev = json_number_after(
        result.window_certificate_json,
        "\"refined_nev\":");
    check(requested_nev > 0.0,
          "complete-window certificate must publish a positive base SLEPc nev");
    check(refined_nev > requested_nev,
          "complete-window certificate must publish a numerically larger refinement nev");
    check(contains(result.window_certificate_json, "\"cluster_ranks\":[1,1]"),
          "complete-window certificate must publish stable physical cluster ranks");
    check(contains(result.window_certificate_json, "\"coverage_margins_hz\":{"),
          "complete-window certificate must publish positive edge coverage margins");
    check(json_number_after(result.window_certificate_json, "\"lower\":") > 0.0,
          "complete-window certificate must have a positive lower coverage margin");
    check(json_number_after(result.window_certificate_json, "\"upper\":") > 0.0,
          "complete-window certificate must have a positive upper coverage margin");
    check(json_number_after(result.window_certificate_json,
                            "\"min_subspace_overlap\":") >= 1.0 - 1.0e-6,
          "complete-window certificate must certify invariant-subspace stability");
    check(contains(result.window_certificate_json,
                   "\"perturbation_result\":\"stable\""),
          "complete-window certificate must record the stable refinement result");
    check(contains(result.window_certificate_json,
                   "\"base_schedule_summary_ref\":\"executed_subwindows_json#pass=base\""),
          "complete-window certificate must reference the full base schedule summary");
    check(contains(result.window_certificate_json,
                   "\"refinement_schedule_summary_ref\":\"executed_subwindows_json#pass=refinement\""),
          "complete-window certificate must reference the full refinement schedule summary");
    check(!contains(result.executed_subwindows_json, "diagnostics_truncated"),
          "certified window must never hide a truncated schedule summary");
}

void FrequencyWindowCertifiesDegenerateClusterByInvariantSubspace()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.5e9, 1.5e9, 3.0e9});
    const fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        1.0e9,
        2.0e9,
        2);

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.window_complete,
          "degenerate frequency cluster must be certified as a complete invariant subspace");
    check(result.accepted_mode_count == 2u,
          "degenerate frequency cluster must preserve its physical rank");
    check(contains(result.window_certificate_json, "\"cluster_ranks\":[2]"),
          "degenerate frequency certificate must publish rank two");
    check(json_number_after(result.window_certificate_json,
                            "\"min_subspace_overlap\":") >= 1.0 - 1.0e-6,
          "degenerate frequency certificate must compare the invariant subspace, not basis vectors");
}

void FrequencyWindowFailsClosedWhenRequestSplitsDegenerateCluster()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.5e9, 1.5e9, 3.0e9});
    const fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        1.0e9,
        2.0e9,
        1);

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
            fd::FrequencyDomainStatus::solve_error,
        "frequency window must fail closed when the requested count splits a degenerate cluster");
    check(!result.window_complete,
          "refinement disagreement must never publish complete=true");
    check(std::strcmp(result.stop_reason,
                      "frequency_window_refinement_disagreement") == 0,
          "refinement disagreement must publish the stable stop reason");
    check(contains(result.window_certificate_json,
                   "\"method\":\"shift_nev_refinement_subspace_v1\""),
          "refinement disagreement must still publish the attempted method");
    check(contains(
              result.window_certificate_json,
              "\"base_schedule\":{\"state\":\"completed\","
              "\"planned_subwindow_count\":16,\"completed_subwindow_count\":16,"
              "\"failed_subwindow_count\":0,\"cancelled\":false}"),
          "refinement disagreement must prove that the base schedule completed cleanly");
    check(contains(
              result.window_certificate_json,
              "\"refinement_schedule\":{\"state\":\"completed\","
              "\"planned_subwindow_count\":34,\"completed_subwindow_count\":34,"
              "\"failed_subwindow_count\":0,\"cancelled\":false}"),
          "refinement disagreement must prove that the refinement schedule completed cleanly");
    const double requested_nev = json_number_after(
        result.window_certificate_json,
        "\"requested_nev\":");
    const double refined_nev = json_number_after(
        result.window_certificate_json,
        "\"refined_nev\":");
    check(requested_nev > 0.0 && refined_nev > requested_nev,
          "refinement disagreement must execute a numerically larger refinement nev");
    check(contains(result.window_certificate_json,
                   "\"perturbation_result\":\"requested_count_splits_cluster\""),
          "refinement disagreement must identify the split degenerate cluster");
    check(contains(result.window_certificate_json, "\"cluster_ranks\":[2]"),
          "refinement disagreement must publish the observed rank-two cluster");
    check(json_number_after(result.window_certificate_json, "\"lower\":") > 0.0 &&
              json_number_after(result.window_certificate_json, "\"upper\":") > 0.0,
          "refinement disagreement must retain positive edge-coverage margins");
    check(!contains(result.window_certificate_json, "\"truncated\":true") &&
              !contains(result.executed_subwindows_json, "diagnostics_truncated"),
          "refinement disagreement must not be inferred from truncated diagnostics");
    check(!contains(result.window_certificate_json, "\"status\":\"certified\""),
          "refinement disagreement must never publish a certified certificate");
}

void FrequencyWindowEmptyFailurePreservesFlagsAndCounts()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 2.0e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        0.5e9,
        2.5e9,
        2);
    problem.A_qq.row_count = std::numeric_limits<std::uint64_t>::max();

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
            fd::FrequencyDomainStatus::solve_error,
        "frequency window must fail when every nearest-frequency operator setup fails");
    check(result.window_failed_subwindow,
          "empty failed window must publish window_failed_subwindow=true");
    check(!result.window_cancelled,
          "empty failed window must not be misclassified as cancelled");
    check(result.window_completed_subwindow_count == 0u,
          "empty failed window must not count failed subwindows as completed");
    check(result.window_failed_subwindow_count == result.window_subwindow_count &&
              result.window_failed_subwindow_count == 50u,
          "empty failed window must account for every planned subwindow as failed");
    check(contains(result.window_certificate_json, "\"status\":\"failed\""),
          "empty failed window must publish a failed certificate");
    check(!contains(result.executed_subwindows_json, "diagnostics_truncated"),
          "empty failed window test must preserve the full schedule summary");
}

void FrequencyWindowCancellationPreservesStopReason()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 0.5e9;
    problem.frequency_max_hz = 2.5e9;
    problem.target_frequency_hz = 0.0;
    problem.solver_adapter = "k0_poisson_airbox_cpu_schur_slepc";
    problem.cancel_requested = &always_cancel;

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
            fd::FrequencyDomainStatus::interrupted,
        "PA-E2 cancelled frequency window must report interrupted status");
    check(!result.window_complete,
          "PA-E2 cancelled frequency window must never advertise complete coverage");
    check(result.window_cancelled,
          "PA-E2 cancelled frequency window must publish window_cancelled=true");
    check(!result.window_failed_subwindow,
          "PA-E2 cancellation must not publish window_failed_subwindow=true");
    check(result.window_failed_subwindow_count == 0u,
          "PA-E2 cancellation must not misclassify the interrupted subwindow as a solver failure");
    check(std::strcmp(result.stop_reason, "cancel_requested") == 0,
          "PA-E2 cancellation must preserve the exact stop reason");
    check(contains(result.diagnostics_json, "\"window_completeness\":{\"status\":\"not_certified\""),
          "PA-E2 cancelled window diagnostics must remain schema-compatible and non-certified");
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

void SolvesRobinAndDirichletWithoutGauge()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    const double coercive_a_phiphi_values[4] = {2.0, -1.0, -1.0, 2.0};
    const CsrOwned coercive_a_phiphi = dense_to_csr(
        2,
        2,
        coercive_a_phiphi_values);
    for (const char *outer_boundary_kind : {"poisson_robin", "poisson_dirichlet"}) {
        fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
        problem.A_phiphi = coercive_a_phiphi.view();
        problem.outer_boundary_kind = outer_boundary_kind;
        problem.robin_beta =
            std::strcmp(outer_boundary_kind, "poisson_robin") == 0 ? 1.0 : 0.0;
        problem.gauge_policy = "none";
        problem.gauge_reason = "coercive_outer_boundary";
        problem.assembly_kind = "synthetic_algebraic_oracle";
        problem.phi_mean_weights = nullptr;
        problem.phi_mean_weights_count = 0;

        fd::PoissonAirboxModalEigenResult result{};
        check(
            fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
                fd::FrequencyDomainStatus::ok,
            "PA-E2 no-gauge outer boundaries must solve without mean-zero augmentation");
        const std::string outer_boundary_provenance =
            "\"outer_boundary_kind\":\"" + std::string(outer_boundary_kind) + "\"";
        check(
            contains(result.diagnostics_json, outer_boundary_provenance.c_str()),
            "PA-E2 no-gauge diagnostic provenance must record the outer boundary kind");
        check(
            contains(result.diagnostics_json, "\"gauge_policy\":\"none\""),
            "PA-E2 Robin/Dirichlet diagnostic provenance must record gauge_policy=none");
        check(
            contains(result.diagnostics_json, "\"gauge_reason\":\"coercive_outer_boundary\""),
            "PA-E2 no-gauge diagnostic provenance must record the gauge reason");
        check(
            contains(result.diagnostics_json, "\"assembly_kind\":\"synthetic_algebraic_oracle\""),
            "PA-E2 no-gauge diagnostic provenance must record the assembly kind");
        check(
            contains(result.diagnostics_json, "\"production_implication\":false"),
            "PA-E2 synthetic no-gauge provenance must state that it has no production implication");
        check(
            contains(
                result.diagnostics_json,
                "\"algebraic_form\":\"full_coupled_descriptor_no_gauge\""),
            "PA-E2 no-gauge diagnostics must identify the non-augmented descriptor");
        check(
            contains(result.diagnostics_json, "\"augmented_dof_count\":4"),
            "PA-E2 no-gauge diagnostics must report only q/phi degrees of freedom");
        check(!result.gauge_augmented,
              "PA-E2 no-gauge solve must not report a synthetic gauge degree of freedom");
    }
}

void PureNeumannRequiresMeanZeroGaugeWithWeights()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.outer_boundary_kind = "pure_neumann";
    problem.robin_beta = 0.0;
    problem.gauge_policy = "mean_zero_augmented";
    problem.gauge_reason = "pure_neumann_nullspace";
    problem.assembly_kind = "synthetic_algebraic_oracle";

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(
        contains(result.diagnostics_json, "\"outer_boundary_kind\":\"pure_neumann\""),
        "PA-E2 pure-Neumann diagnostic provenance must record the outer boundary kind");
    check(
        contains(result.diagnostics_json, "\"gauge_policy\":\"mean_zero_augmented\""),
        "PA-E2 pure-Neumann diagnostic provenance must record the mean-zero gauge");
    check(
        contains(result.diagnostics_json, "\"gauge_reason\":\"pure_neumann_nullspace\""),
        "PA-E2 pure-Neumann diagnostic provenance must record the gauge reason");
    check(
        contains(result.diagnostics_json, "\"assembly_kind\":\"synthetic_algebraic_oracle\""),
        "PA-E2 pure-Neumann diagnostic provenance must record the assembly kind");
    check(
        contains(result.diagnostics_json, "\"production_implication\":false"),
        "PA-E2 synthetic pure-Neumann provenance must state that it has no production implication");
}

void RejectsUnsupportedBoundaryGaugePairsBeforeSlepcSetup()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    const struct {
        const char *outer_boundary_kind;
        const char *gauge_policy;
        const char *gauge_reason;
    } invalid_cases[] = {
        {"poisson_robin", "mean_zero_augmented", "pure_neumann_nullspace"},
        {"poisson_dirichlet", "mean_zero_augmented", "pure_neumann_nullspace"},
        {"pure_neumann", "none", "coercive_outer_boundary"},
    };

    for (const auto &invalid_case : invalid_cases) {
        fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
        problem.outer_boundary_kind = invalid_case.outer_boundary_kind;
        problem.robin_beta =
            std::strcmp(invalid_case.outer_boundary_kind, "poisson_robin") == 0 ? 1.0 : 0.0;
        problem.gauge_policy = invalid_case.gauge_policy;
        problem.gauge_reason = invalid_case.gauge_reason;
        problem.assembly_kind = "synthetic_algebraic_oracle";
        if (std::strcmp(invalid_case.gauge_policy, "none") == 0) {
            problem.phi_mean_weights = nullptr;
            problem.phi_mean_weights_count = 0;
        }

        fd::PoissonAirboxModalEigenResult result{};
        check(
            fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
                fd::FrequencyDomainStatus::validation_error,
            "PA-E2 must reject unsupported Poisson-airbox boundary/gauge combinations");
        check(
            contains(result.diagnostics_json, "poisson_airbox_eigen_boundary_gauge_mismatch"),
            "PA-E2 boundary/gauge mismatch must preserve a pre-SLEPc rejection reason");
    }
}

void RejectsInconsistentProvenanceBeforeSlepcSetup()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.gauge_reason = "coercive_outer_boundary";

    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject pure-Neumann provenance with a coercive-boundary reason");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_gauge_reason_mismatch"),
        "PA-E2 gauge-reason mismatch must preserve a pre-SLEPc rejection reason");

    problem = sparse_problem_from_fixture(fixture);
    problem.assembly_kind = "shared_domain_p1";
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E2 must reject an unimplemented assembly kind");
    check(
        contains(result.diagnostics_json, "poisson_airbox_eigen_unsupported_assembly_kind"),
        "PA-E2 assembly-kind rejection must preserve a pre-SLEPc reason");
}

void SolvesSharedDomainCpuSchurModalFixture()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    const double omega = kTwoPi * 2.0e9;
    const double a_qq[4] = {omega, 0.0, 0.0, omega};
    const double coupling[4] = {1.0e-6, 0.0, 0.0, 0.0};
    const double poisson[4] = {1.0, 0.0, 0.0, 1.0};
    const double b_qq[4] = {0.0, -1.0, 1.0, 0.0};
    std::memcpy(fixture.a_qq, a_qq, sizeof(a_qq));
    std::memcpy(fixture.a_qphi, coupling, sizeof(coupling));
    std::memcpy(fixture.a_phiq, coupling, sizeof(coupling));
    std::memcpy(fixture.a_phiphi, poisson, sizeof(poisson));
    std::memcpy(fixture.b_qq, b_qq, sizeof(b_qq));
    fixture.A_qq = dense_to_csr(2, 2, fixture.a_qq);
    fixture.A_qphi = dense_to_csr(2, 2, fixture.a_qphi);
    fixture.A_phiq = dense_to_csr(2, 2, fixture.a_phiq);
    fixture.A_phiphi = dense_to_csr(2, 2, fixture.a_phiphi);
    fixture.B_qq = dense_to_csr(2, 2, fixture.b_qq);
    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    problem.phi_mean_weights = nullptr;
    problem.phi_mean_weights_count = 0;
    problem.assembly_kind = "mfem_weak_form_shared_domain";
    problem.production_shared_domain = true;
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    // Keep the shift strictly off the exact eigenvalue: shift-invert is
    // undefined for a singular A-tau B factorization.
    problem.target_kind = "nearest_frequency";
    problem.target_frequency_hz = 1.9e9;
    problem.expected_reference_frequency_hz = 0.0;
    problem.residual_tolerance = 1.0e-8;
    problem.requested_mode_count = 1;
    problem.max_outer_iterations = 64;
    problem.max_linear_iterations = 512;

    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result);
    check(status == fd::FrequencyDomainStatus::ok, result.error_message);
    check(result.accepted_mode_count == 1u,
          "shared-domain CPU Schur fixture must return one accepted mode");
    check(result.full_residual_certified,
          "shared-domain CPU Schur fixture must certify the full descriptor residual");
    check(contains(result.diagnostics_json,
                   "\"algebraic_form\":\"schur_reduced_descriptor\""),
          "shared-domain CPU diagnostics must identify the Schur-reduced descriptor");
    check(contains(result.diagnostics_json,
                   "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_slepc\""),
          "shared-domain CPU diagnostics must identify the Schur adapter");
    check(contains(result.diagnostics_json,
                   "\"engine_id\":\"native_fem.frequency_domain.k0_poisson_airbox_cpu_schur_slepc.v1\""),
          "shared-domain CPU diagnostics must publish a stable engine identity");
    check(contains(result.diagnostics_json, "\"solve_succeeded\":true"),
          "shared-domain CPU diagnostics must separate solve success from completeness");
    check(contains(result.diagnostics_json, "\"fields_available\":true"),
          "shared-domain CPU diagnostics must disclose accepted mode availability");
    check(contains(result.diagnostics_json,
                   "\"spectrum_completeness\":\"selected_only\""),
          "nearest-frequency CPU diagnostics must remain explicitly selected-only");
    check(contains(result.diagnostics_json, "\"window_complete\":false"),
          "nearest-frequency CPU diagnostics must never claim a complete window");
    check(contains(result.diagnostics_json,
                   "\"requested_execution\":\"production_cpu\""),
          "shared-domain CPU diagnostics must preserve the requested execution lane");
    check(contains(result.diagnostics_json,
                   "\"resolved_execution\":\"production_cpu\""),
          "shared-domain CPU diagnostics must preserve the resolved execution lane");
    check(contains(result.diagnostics_json,
                   "\"production_implication\":true"),
          "shared-domain CPU diagnostics must identify production-intended execution");
    check(contains(result.diagnostics_json,
                   "\"validation_only\":false"),
          "shared-domain CPU diagnostics must not describe the production lane as validation-only");
    check(contains(result.diagnostics_json,
                   "\"persistent_solver_context\":true"),
          "shared-domain CPU diagnostics must disclose the persistent Poisson context");
    check(contains(result.diagnostics_json,
                   "\"operator_context_scope\":\"single_shift\""),
          "single-shift CPU diagnostics must identify owned operator scope");
    check(result.operator_context_setup_count == 1u,
          "single-shift CPU solve must configure one operator context");
    check(result.poisson_factorization_setup_count == 1u,
          "single-shift CPU solve must configure one Poisson factorization");
    check(result.shift_solver_setup_count == 1u,
          "single-shift CPU solve must configure one shift solver");
    check(contains(result.diagnostics_json,
                   "\"gpu_device_resident_modal_eigensolver\":false"),
          "shared-domain CPU diagnostics must identify host-resident execution");
    check(contains(result.diagnostics_json,
                   "\"full_residual_certified\":true"),
          "shared-domain CPU diagnostics must publish scalar full-residual certification");
    check(contains(result.diagnostics_json,
                   "\"spectral_pencil_kind\":\"real_frequency_rotated\""),
          "shared-domain CPU Schur diagnostics must publish the real split pencil");
    check(contains(result.diagnostics_json,
                   "\"target_representation\":\"tau=omega_target\""),
          "shared-domain CPU Schur diagnostics must publish the real tau target");
    check(contains(result.diagnostics_json,
                   "\"raw_ritz_classification\":{"),
          "shared-domain CPU diagnostics must publish bounded raw Ritz classification");
    check(contains(result.diagnostics_json,
                   "\"complex_rejected_count\":"),
          "raw Ritz diagnostics must count pairs rejected away from the real axis");
    check(contains(result.diagnostics_json,
                   "\"kr_scaled_range\":["),
          "raw Ritz diagnostics must publish the observed real-part range");
    check(contains(result.diagnostics_json,
                   "\"ki_scaled_range\":["),
          "raw Ritz diagnostics must publish the observed imaginary-part range");
    check(contains(result.diagnostics_json,
                   "\"samples\":[{"),
          "raw Ritz diagnostics must retain bounded per-pair samples");
    check(contains(result.diagnostics_json,
                   "\"ksp_type\":\"preonly\""),
          "bounded shared-domain CPU Schur diagnostics must report the exact direct shifted solve");
}

void solve_shared_domain_cpu_schur_fixture_above_exact_preconditioner_cap(
    double descriptor_scale,
    bool require_scaled_pencil_diagnostics)
{
    constexpr std::uint64_t q_count = 514;
    constexpr std::uint64_t pair_count = q_count / 2;
    CsrOwned a_qq{};
    CsrOwned a_qphi{};
    CsrOwned a_phiq{};
    CsrOwned a_phiphi{};
    CsrOwned b_qq{};
    a_qq.rows = q_count;
    a_qq.columns = q_count;
    a_qphi.rows = q_count;
    a_qphi.columns = 1;
    a_phiq.rows = 1;
    a_phiq.columns = q_count;
    a_phiphi.rows = 1;
    a_phiphi.columns = 1;
    b_qq.rows = q_count;
    b_qq.columns = q_count;
    a_qq.row_offsets.push_back(0);
    a_qphi.row_offsets.push_back(0);
    b_qq.row_offsets.push_back(0);
    for (std::uint64_t pair = 0; pair < pair_count; ++pair) {
        const double omega = kTwoPi * (2.0e9 + static_cast<double>(pair) * 1.0e7);
        for (std::uint64_t component = 0; component < 2; ++component) {
            const std::uint64_t row = 2 * pair + component;
            a_qq.column_indices.push_back(static_cast<std::uint32_t>(row));
            a_qq.values.push_back(descriptor_scale * omega);
            a_qq.row_offsets.push_back(static_cast<std::uint32_t>(a_qq.values.size()));
            if (row == 0) {
                a_qphi.column_indices.push_back(0);
                a_qphi.values.push_back(descriptor_scale * 1.0e-6);
            }
            a_qphi.row_offsets.push_back(static_cast<std::uint32_t>(a_qphi.values.size()));
            b_qq.column_indices.push_back(static_cast<std::uint32_t>(
                component == 0 ? row + 1 : row - 1));
            b_qq.values.push_back(
                descriptor_scale * (component == 0 ? -1.0 : 1.0));
            b_qq.row_offsets.push_back(static_cast<std::uint32_t>(b_qq.values.size()));
        }
    }
    a_phiq.row_offsets = {0, 1};
    a_phiq.column_indices = {0};
    // Scale only the magnetic equations.  The scalar Poisson row remains in
    // its natural conditioning so this fixture isolates the modal pencil
    // normalization from an unrelated tiny-Poisson-factorization test.
    a_phiq.values = {1.0e-6};
    a_phiphi.row_offsets = {0, 1};
    a_phiphi.column_indices = {0};
    a_phiphi.values = {1.0};

    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = q_count;
    problem.phi_dof_count = 1;
    problem.A_qq = a_qq.view();
    problem.A_qphi = a_qphi.view();
    problem.A_phiq = a_phiq.view();
    problem.A_phiphi = a_phiphi.view();
    problem.B_qq = b_qq.view();
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    problem.assembly_kind = "mfem_weak_form_shared_domain";
    problem.production_shared_domain = true;
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    problem.target_frequency_hz = 1.9e9;
    problem.residual_tolerance = 1.0e-8;
    problem.requested_mode_count = 1;
    problem.max_outer_iterations = 64;
    problem.max_linear_iterations = 512;

    fd::PoissonAirboxModalEigenResult result{};
    check(fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
              fd::FrequencyDomainStatus::ok,
          result.error_message);
    check(result.accepted_mode_count == 1u,
          "shared-domain CPU Schur GMRES fixture must return one accepted mode");
    check(result.full_residual_certified,
          "shared-domain CPU Schur GMRES fixture must certify the full descriptor residual");
    check(result.reconstructed_full_descriptor_backward_error <=
              problem.residual_tolerance,
          "shared-domain CPU Schur GMRES fixture must satisfy the requested full residual");
    check(std::abs(result.frequency_hz - 2.0e9) / 2.0e9 <= 1.0e-8,
          "dimensionless CPU scaling must preserve the physical two-gigahertz mode");
    check(contains(result.diagnostics_json, "\"ksp_type\":\"gmres\""),
          "fixture above the exact-preconditioner cap must exercise GMRES convergence");
    check(contains(result.diagnostics_json, "\"refinement_attempted_count\":"),
          "shared-domain CPU Schur diagnostics must publish Ritz refinement attempts");
    check(contains(result.diagnostics_json, "\"refinement_succeeded_count\":"),
          "shared-domain CPU Schur diagnostics must publish Ritz refinement successes");
    check(contains(result.diagnostics_json, "\"refinement_failed_count\":"),
          "shared-domain CPU Schur diagnostics must publish Ritz refinement failures");
    if (require_scaled_pencil_diagnostics) {
        check(contains(result.diagnostics_json,
                       "\"descriptor_scaling\":{"
                       "\"kind\":\"dimensionless_frequency\",\"applied\":true"),
              "SI-scaled CPU Schur diagnostics must report dimensionless pencil scaling");
        check(json_number_after(result.diagnostics_json,
                                "\"angular_frequency_scale\":") > 1.0,
              "SI-scaled CPU Schur diagnostics must publish a nontrivial frequency scale");
        check(json_number_after(result.diagnostics_json,
                                "\"mass_scale\":") > 1.0,
              "SI-scaled CPU Schur diagnostics must publish mass normalization");
    }
}

void SolvesSharedDomainCpuSchurModalFixtureAboveExactPreconditionerCap()
{
    solve_shared_domain_cpu_schur_fixture_above_exact_preconditioner_cap(1.0, false);
}

void SolvesSiScaledSharedDomainCpuSchurModalFixtureAboveExactPreconditionerCap()
{
    solve_shared_domain_cpu_schur_fixture_above_exact_preconditioner_cap(1.0e-30, true);
}

void ReturnsRequestedSharedDomainCpuSchurModes()
{
    constexpr std::uint64_t q_count = 4;
    constexpr std::uint64_t phi_count = 1;
    const double omega_1 = kTwoPi * 1.0e9;
    const double omega_2 = kTwoPi * 2.0e9;
    const double a_qq_values[16] = {
        omega_1, 0.0, 0.0, 0.0,
        0.0, omega_1, 0.0, 0.0,
        0.0, 0.0, omega_2, 0.0,
        0.0, 0.0, 0.0, omega_2,
    };
    const double a_qphi_values[4] = {1.0e-6, 0.0, 0.0, 0.0};
    const double a_phiq_values[4] = {1.0e-6, 0.0, 0.0, 0.0};
    const double a_phiphi_values[1] = {1.0};
    const double b_qq_values[16] = {
        0.0, -1.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, -1.0,
        0.0, 0.0, 1.0, 0.0,
    };
    CsrOwned a_qq = dense_to_csr(q_count, q_count, a_qq_values);
    CsrOwned a_qphi = dense_to_csr(q_count, phi_count, a_qphi_values);
    CsrOwned a_phiq = dense_to_csr(phi_count, q_count, a_phiq_values);
    CsrOwned a_phiphi = dense_to_csr(phi_count, phi_count, a_phiphi_values);
    CsrOwned b_qq = dense_to_csr(q_count, q_count, b_qq_values);

    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = q_count;
    problem.phi_dof_count = phi_count;
    problem.A_qq = a_qq.view();
    problem.A_qphi = a_qphi.view();
    problem.A_phiq = a_phiq.view();
    problem.A_phiphi = a_phiphi.view();
    problem.B_qq = b_qq.view();
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    problem.assembly_kind = "mfem_weak_form_shared_domain";
    problem.production_shared_domain = true;
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    problem.target_frequency_hz = 1.5e9;
    problem.expected_reference_frequency_hz = 0.0;
    problem.residual_tolerance = 1.0e-8;
    problem.requested_mode_count = 2;
    problem.max_outer_iterations = 64;
    problem.max_linear_iterations = 512;

    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result);
    check(status == fd::FrequencyDomainStatus::ok, result.error_message);
    check(result.accepted_mode_count == 2u,
          "shared-domain CPU Schur selected spectrum must return both requested modes");
    check(result.finite_real_eigenpair_count == result.converged_eigenpair_count,
          "shared-domain CPU Schur must classify every converged real-split eigenpair");
    check(result.positive_frequency_eigenpair_count >= result.accepted_mode_count,
          "shared-domain CPU Schur must count positive-frequency candidates before filtering");
    check(result.action_residual_evaluated_count ==
              result.positive_frequency_eigenpair_count,
          "shared-domain CPU Schur must evaluate the action residual for every positive-frequency candidate");
    check(result.reconstructed_mode_count == result.action_residual_evaluated_count,
          "shared-domain CPU Schur fixture must reconstruct every residual-evaluated candidate");
    check(result.full_residual_accepted_count >= result.accepted_mode_count,
          "shared-domain CPU Schur fixture must count every full-residual accepted candidate before publication capping");
    check(result.action_residual_evaluation_failed_count == 0u &&
              result.q_vector_extraction_failed_count == 0u &&
              result.full_vector_reconstruction_failed_count == 0u &&
              result.full_vector_nonfinite_count == 0u &&
              result.full_residual_evaluation_failed_count == 0u &&
              result.full_residual_rejected_count == 0u,
          "shared-domain CPU Schur fixture must not report rejection-stage failures for accepted synthetic modes");
    check(contains(result.diagnostics_json,
                   "\"full_residual_accepted_count\":"),
          "shared-domain CPU Schur diagnostics must publish rejection-stage counters");
    std::vector<double> frequencies;
    for (const auto &mode : result.accepted_modes) {
        frequencies.push_back(mode.frequency_hz);
    }
    std::sort(frequencies.begin(), frequencies.end());
    check(frequencies.size() == 2u &&
              std::abs(frequencies[0] - 1.0e9) < 1.0 &&
              std::abs(frequencies[1] - 2.0e9) < 1.0,
          "shared-domain CPU Schur selected spectrum must return distinct physical modes, not J-equivalent duplicates");

    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 0.5e9;
    problem.frequency_max_hz = 2.5e9;
    problem.target_frequency_hz = 2.0e9;
    problem.requested_mode_count = 1;
    result = {};
    check(fd::solve_poisson_airbox_modal_eigen_cpu_schur(problem, &result) ==
              fd::FrequencyDomainStatus::ok,
          result.error_message);
    check(result.accepted_mode_count == 1u &&
              std::abs(result.frequency_hz - 1.0e9) < 1.0,
          "frequency-window Schur selection must publish the lowest in-window mode instead of the mode nearest the midpoint shift");
    check(contains(result.diagnostics_json,
                   "\"target_kind\":\"frequency_window\""),
          "frequency-window Schur diagnostics must preserve the requested target kind");
    check(contains(result.diagnostics_json, "\"subwindows\":[{"),
          "frequency-window Schur diagnostics must publish executed subwindows");
    check(contains(result.diagnostics_json, "\"shift_frequency_hz\":"),
          "frequency-window Schur diagnostics must publish each executed shift");
    check(contains(result.diagnostics_json, "\"accepted_frequencies_hz\":["),
          "frequency-window Schur diagnostics must publish accepted frequencies per shift");
    check(contains(result.diagnostics_json, "\"candidate_mode_count\":"),
          "frequency-window Schur diagnostics must distinguish raw shifted candidates from globally in-window accepted modes");
    check(contains(result.diagnostics_json,
                   "\"candidate_mode_count_kind\":\"raw_ritz_in_window\""),
          "frequency-window Schur diagnostics must identify the candidate count semantics");
    check(contains(result.diagnostics_json,
                   "\"raw_ritz_in_window_count\":"),
          "frequency-window Schur diagnostics must expose raw in-window Ritz counts");
    check(contains(result.diagnostics_json,
                   "\"full_residual_accepted_count\":"),
          "frequency-window Schur diagnostics must expose residual-stage counts per subwindow");
    check(contains(result.diagnostics_json,
                   "\"action_residual_evaluation_failed_count\":"),
          "frequency-window Schur diagnostics must expose action-residual failures per subwindow");
    check(contains(result.diagnostics_json,
                   "\"q_vector_extraction_failed_count\":"),
          "frequency-window Schur diagnostics must expose q-vector extraction failures per subwindow");
    check(contains(result.diagnostics_json,
                   "\"full_vector_reconstruction_failed_count\":"),
          "frequency-window Schur diagnostics must expose full-vector reconstruction failures per subwindow");
    check(contains(result.diagnostics_json,
                   "\"full_residual_rejected_count\":"),
          "frequency-window Schur diagnostics must expose full-residual rejection counts per subwindow");
}

void SolvesSharedDomainGpuValidationModalFixture()
{
    TinySparseFixture fixture{};
    const double a_qq[4] = {0.5, -0.2, 0.2, 0.5};
    const double a_qphi[4] = {1.0e-3, -1.0e-3, 0.0, 5.0e-4};
    const double a_phiq[4] = {1.0e-3, 0.0, -1.0e-3, 5.0e-4};
    const double a_phiphi[4] = {2.0, -0.5, -0.5, 2.0};
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

    fd::PoissonAirboxEigenBlockProblem problem = sparse_problem_from_fixture(fixture);
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    problem.assembly_kind = "mfem_weak_form_shared_domain";
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    problem.phi_mean_weights = nullptr;
    problem.phi_mean_weights_count = 0;
    problem.target_frequency_hz = 0.2 / kTwoPi;
    problem.expected_reference_frequency_hz = 0.0;
    problem.residual_tolerance = 1.0e-6;
    problem.requested_mode_count = 1;
    problem.max_outer_iterations = 64;
    problem.max_linear_iterations = 512;

    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_gpu_device_krylov(problem, &result);
    if (status == fd::FrequencyDomainStatus::unavailable &&
        contains(result.error_message, "CUDA")) {
        return;
    }
    check(status == fd::FrequencyDomainStatus::ok, result.error_message);
    check(result.accepted_mode_count == 1u,
          "GPU modal K0 fixture must return one accepted mode");
    check(result.full_residual_certified,
          "GPU modal K0 fixture must certify the full residual");
    check(result.positive_frequency_branch_found && result.frequency_hz > 0.0,
          "GPU modal K0 fixture must select a positive-frequency branch");
    check(contains(result.diagnostics_json,
                   "\"gpu_device_resident_modal_eigensolver\":false"),
          "bounded GPU modal diagnostics must not claim device-resident Ritz state");
    check(contains(result.diagnostics_json, "\"validation_only\":true"),
          "bounded GPU modal diagnostics must identify the validation-only lane");
    check(contains(result.diagnostics_json,
                   "\"persistent_solver_context\":true"),
          "GPU modal K0 diagnostics must publish persistent context");
    check(contains(result.diagnostics_json,
                   "\"cpu_fallback\":\"disabled\""),
          "GPU modal K0 diagnostics must reject CPU fallback");

    problem.outer_boundary_kind = "pure_neumann";
    problem.robin_beta = 0.0;
    problem.gauge_policy = "mean_zero_augmented";
    problem.gauge_reason = "pure_neumann_nullspace";
    problem.phi_mean_weights = fixture.weights;
    problem.phi_mean_weights_count = 2;
    fd::PoissonAirboxModalEigenResult gauge_result{};
    const fd::FrequencyDomainStatus gauge_status =
        fd::solve_poisson_airbox_modal_eigen_gpu_device_krylov(problem, &gauge_result);
    check(gauge_status == fd::FrequencyDomainStatus::ok, gauge_result.error_message);
    check(gauge_result.gauge_augmented && gauge_result.accepted_mode_count == 1u,
          "GPU modal K0 gauge fixture must return an augmented accepted mode");
    check(gauge_result.full_residual_certified,
          "GPU modal K0 gauge fixture must certify the full residual");
    check(contains(gauge_result.diagnostics_json, "\"gauge_policy\":\"mean_zero_augmented\""),
          "GPU modal K0 gauge diagnostics must publish the mean-zero policy");
}

void SolvesSharedDomainGpuArnoldiModalFixture()
{
    constexpr std::uint64_t q_count = 66;
    constexpr std::uint64_t phi_count = 1;
    CsrOwned a_qq{};
    a_qq.rows = q_count;
    a_qq.columns = q_count;
    a_qq.row_offsets.reserve(static_cast<std::size_t>(q_count + 1u));
    a_qq.row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < q_count; ++row) {
        const std::uint64_t pair = row / 2u;
        const double frequency = 0.2 + 0.01 * static_cast<double>(pair);
        a_qq.column_indices.push_back(static_cast<std::uint32_t>(row));
        a_qq.values.push_back(0.0);
        a_qq.column_indices.push_back(static_cast<std::uint32_t>(row ^ 1u));
        a_qq.values.push_back(row % 2u == 0u ? -frequency : frequency);
        a_qq.row_offsets.push_back(static_cast<std::uint32_t>(a_qq.values.size()));
    }
    CsrOwned a_qphi{};
    a_qphi.rows = q_count;
    a_qphi.columns = phi_count;
    a_qphi.row_offsets.reserve(static_cast<std::size_t>(q_count + 1u));
    a_qphi.row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < q_count; ++row) {
        a_qphi.column_indices.push_back(0u);
        a_qphi.values.push_back(row % 2u == 0u ? 1.0e-3 : -1.0e-3);
        a_qphi.row_offsets.push_back(static_cast<std::uint32_t>(a_qphi.values.size()));
    }
    CsrOwned a_phiq{};
    a_phiq.rows = phi_count;
    a_phiq.columns = q_count;
    a_phiq.row_offsets = {0u};
    for (std::uint64_t column = 0; column < q_count; ++column) {
        a_phiq.column_indices.push_back(static_cast<std::uint32_t>(column));
        a_phiq.values.push_back(column % 2u == 0u ? 1.0e-3 : -1.0e-3);
    }
    a_phiq.row_offsets.push_back(static_cast<std::uint32_t>(a_phiq.values.size()));
    const double a_phiphi_values[1] = {1.0};
    CsrOwned a_phiphi = dense_to_csr(phi_count, phi_count, a_phiphi_values);
    CsrOwned b_qq{};
    b_qq.rows = q_count;
    b_qq.columns = q_count;
    b_qq.row_offsets.reserve(static_cast<std::size_t>(q_count + 1u));
    b_qq.row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < q_count; ++row) {
        b_qq.column_indices.push_back(static_cast<std::uint32_t>(row));
        b_qq.values.push_back(1.0);
        b_qq.row_offsets.push_back(static_cast<std::uint32_t>(b_qq.values.size()));
    }

    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = q_count;
    problem.phi_dof_count = phi_count;
    problem.A_qq = a_qq.view();
    problem.A_qphi = a_qphi.view();
    problem.A_phiq = a_phiq.view();
    problem.A_phiphi = a_phiphi.view();
    problem.B_qq = b_qq.view();
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    problem.assembly_kind = "mfem_weak_form_shared_domain";
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 0.19 / kTwoPi;
    problem.frequency_max_hz = 0.215 / kTwoPi;
    problem.target_frequency_hz = 0.202 / kTwoPi;
    problem.expected_reference_frequency_hz = 0.0;
    problem.residual_tolerance = 1.0e-6;
    problem.requested_mode_count = 1;
    problem.max_outer_iterations = 128;
    problem.max_linear_iterations = 4096;

    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_gpu_device_krylov(problem, &result);
    if (status == fd::FrequencyDomainStatus::unavailable &&
        contains(result.error_message, "CUDA")) {
        return;
    }
    check(status == fd::FrequencyDomainStatus::ok, result.error_message);
    check(result.accepted_mode_count == 1u,
          "GPU Arnoldi modal fixture must return one accepted mode");
    check(result.full_residual_certified,
          "GPU Arnoldi modal fixture must certify the full residual");
    check(contains(result.diagnostics_json, "\"modal_iteration_method\":\"arnoldi_ritz\""),
          "GPU Arnoldi modal diagnostics must identify Ritz extraction");
    check(contains(result.diagnostics_json, "\"linear_solver\":\"device_bicgstab\""),
          "GPU Arnoldi modal diagnostics must identify the device Krylov shifted action");
    check(contains(result.diagnostics_json, "\"preconditioner\":\"shifted_2x2_block_jacobi\""),
          "GPU Arnoldi modal diagnostics must identify the device magnetic block preconditioner");
    check(contains(result.diagnostics_json, "\"inner_linear_tolerance\":"),
          "GPU Arnoldi modal diagnostics must disclose the inner linear tolerance");
    check(contains(result.diagnostics_json, "\"ritz_state_location\":\"host_small_projected\""),
          "GPU Arnoldi modal diagnostics must disclose host projected Ritz extraction");
    check(contains(result.diagnostics_json, "\"host_ritz_extraction\":true"),
          "GPU Arnoldi modal diagnostics must disclose host projected Ritz extraction");
    check(contains(result.diagnostics_json, "\"scalable_selected_spectrum\":false"),
          "host-projected GPU Arnoldi must not publish scalable selected-spectrum support");
    check(std::abs(result.frequency_hz - 0.2 / kTwoPi) < 1.0e-5,
          "GPU Arnoldi modal fixture must select the nearest positive branch");
    check(result.frequency_hz >= problem.frequency_min_hz &&
              result.frequency_hz <= problem.frequency_max_hz,
          "GPU Arnoldi modal fixture must publish only modes inside the requested window");
}

} // namespace

int main()
{
    // Hosts without a CUDA driver may run the CPU/SLEPc contract explicitly;
    // GPU qualification remains a separate device-backed test lane.
    const bool skip_gpu_tests = std::getenv("FULLMAG_SKIP_GPU_TESTS") != nullptr;
    if (std::getenv("FULLMAG_NEAREST_SEMANTICS_FOCUSED") != nullptr) {
        SolvesSharedDomainCpuSchurModalFixture();
        return 0;
    }
    if (std::getenv("FULLMAG_REFINEMENT_TELEMETRY_FOCUSED") != nullptr) {
        SolvesSharedDomainCpuSchurModalFixtureAboveExactPreconditionerCap();
        return 0;
    }
    if (std::getenv("FULLMAG_N2_CW1_FOCUSED") != nullptr) {
        FrequencyWindowPublishesCompleteCertificateForSyntheticFixture();
        FrequencyWindowCertifiesDegenerateClusterByInvariantSubspace();
        FrequencyWindowFailsClosedWhenRequestSplitsDegenerateCluster();
        FrequencyWindowEmptyFailurePreservesFlagsAndCounts();
        FrequencyWindowCancellationPreservesStopReason();
        return 0;
    }
    ReturnsRequestedSharedDomainCpuSchurModes();
    SolvesSharedDomainCpuSchurModalFixture();
    SolvesSharedDomainCpuSchurModalFixtureAboveExactPreconditionerCap();
    SolvesSiScaledSharedDomainCpuSchurModalFixtureAboveExactPreconditionerCap();
    SolvesSparseFullCoupledDescriptorAndMatchesDenseOracle();
    ReconstructedResidualCannotBeHiddenBySlepcBackwardError();
    ResidualCertificationRejectsBackendAndReconstructionDisagreement();
    ConjugatedCandidateRequiresConjugatedEigenvalue();
    ResidualEvaluatorRejectsNonfiniteComputedMetrics();
    AppliesFullCoupledShiftInvertActionReference();
    if (!skip_gpu_tests) {
        AppliesGpuFullCoupledShiftInvertActionAndMatchesCpuReference();
        SolvesGpuDensePoissonAirboxModalEigenAndMatchesCpuReference();
        AppliesGpuFullCoupledDescriptorAndMatchesCpuReference();
        AppliesGpuShiftedFullCoupledDescriptorAndMatchesCpuReference();
    }
    ModalContractWritesShiftInvertActionArtifact();
    EmitsSlepcAdapterDiagnostics();
    AnalyticalReferenceDoesNotGateTheModalSolve();
    RejectsZeroRequestedModeCountAndUnknownTargetKind();
    RejectsFrequencyWindowOnFullCoupledAdapter();
    PublishesCanonicalResidualFieldsAndSolverReasons();
    FrequencyWindowPublishesCompleteCertificateForSyntheticFixture();
    FrequencyWindowCertifiesDegenerateClusterByInvariantSubspace();
    FrequencyWindowFailsClosedWhenRequestSplitsDegenerateCluster();
    FrequencyWindowEmptyFailurePreservesFlagsAndCounts();
    FrequencyWindowCancellationPreservesStopReason();
    RejectsSyntheticPaE1DemagKind();
    RejectsMissingPeriodicMeshCertificate();
    RejectsDecoupledDemagBlocks();
    RejectsZeroMeanZeroGaugeWeights();
    RejectsNegativeMeanZeroGaugeWeights();
    SolvesRobinAndDirichletWithoutGauge();
    PureNeumannRequiresMeanZeroGaugeWithWeights();
    RejectsUnsupportedBoundaryGaugePairsBeforeSlepcSetup();
    RejectsInconsistentProvenanceBeforeSlepcSetup();
    if (!skip_gpu_tests) {
        SolvesSharedDomainGpuValidationModalFixture();
        SolvesSharedDomainGpuArnoldiModalFixture();
    }
    return 0;
}
