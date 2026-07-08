/*
 * poisson_airbox_eigen_oracle_test.cpp - PA-E1 dense Poisson-airbox
 * k=0 modal eigensolve oracle contract tests.
 */

#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

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

void RejectsMissingGaugeWeights()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "missing gauge weights must be rejected");
    check(
        contains(result.error_message, "gauge") ||
            contains(result.diagnostics_json, "poisson_airbox_eigen_requires_mean_zero_gauge"),
        "missing gauge weights must name mean-zero gauge");
}

void RejectsPinFirstGaugePolicy()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.gauge_policy = "pin_first_dof";

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "pin_first_dof must not be accepted by the PA-E1 production oracle");
    check(contains(result.diagnostics_json, "poisson_airbox_eigen_requires_mean_zero_gauge"),
          "pin_first_dof rejection must name the mean-zero gauge requirement");
}

void RejectsNegativeGaugeWeights()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {-0.5, 1.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "negative gauge weights must be rejected");
    check(contains(result.diagnostics_json, "poisson_airbox_eigen_requires_mean_zero_gauge"),
          "negative gauge-weight rejection must name the mean-zero gauge requirement");
    check(contains(result.error_message, "positive normalized"),
          "negative gauge-weight rejection must report positive normalized weights");
}

void RejectsProductionPeriodicAirboxDemagClaim()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.demag_kind = "periodic_airbox_k0";

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "PA-E1 synthetic oracle must reject production periodic_airbox_k0 claims");
    check(contains(result.diagnostics_json, "poisson_airbox_eigen_pa_e1_synthetic_only"),
          "production demag_kind rejection must preserve synthetic-only reason");
}

void MeanZeroAugmentedGaugeSolvesSingularPoisson()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {-1.0, 0.0, 1.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const double q_re[2] = {1.0, 0.0};
    const double q_im[2] = {0.0, 0.0};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.test_q = fd::DenseComplexVectorView{q_re, q_im, 2};
    problem.expected_positive_frequency_hz = 2.0e9;

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.gauge_augmented, "oracle must use mean-zero gauge augmentation");
    check(result.augmented_phi_dof_count == 3, "augmented Poisson system adds one gauge row");
    check(result.gauge_mean_abs <= 1.0e-12, "reconstructed potential must be mean-zero");
}

void SchurApplyMatchesExplicitSchur()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const double q_re[2] = {0.75, -0.25};
    const double q_im[2] = {0.125, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.test_q = fd::DenseComplexVectorView{q_re, q_im, 2};

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.schur_apply_relative_error <= 1.0e-10,
          "matrix-free Schur apply must match explicit Schur");
    check(result.schur_certified, "Schur certification flag must be true");
}

void FullResidualReconstructionMatchesReducedEigenpair()
{
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.full_residual_reconstruction_relative_error <= 1.0e-10,
          "full descriptor residual must reconstruct the reduced eigenpair");
    check(result.poisson_constraint_relative_residual <= 1.0e-10,
          "Poisson algebraic row residual must be tiny");
    check(result.full_residual_certified, "full residual certification flag must be true");
}

void PositiveFrequencyBranchMatchesToyGyrotropicPencil()
{
    const double f0 = 2.0e9;
    const double omega0 = kTwoPi * f0;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const double q_re[2] = {1.0, 0.0};
    const double q_im[2] = {0.0, 0.0};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.test_q = fd::DenseComplexVectorView{q_re, q_im, 2};
    problem.expected_positive_frequency_hz = f0;
    problem.expected_frequency_relative_tolerance = 1.0e-10;

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.positive_frequency_branch_found, "positive branch must be selected");
    check(std::abs(result.frequency_hz - f0) / f0 <= 1.0e-10,
          "positive branch frequency must match omega/(2*pi)");
    check(std::abs(result.eigenvalue_imag - omega0) / omega0 <= 1.0e-10,
          "positive branch eigenvalue imaginary part must be omega");
}

void SyntheticDemagKittelFrequencyMatchesExpectedWithCorrectSign()
{
    const double h0 = kTwoPi * 1.0e9;
    const double demag_delta = 0.5 * h0;
    const double expected_hz = std::sqrt(h0 * (h0 + demag_delta)) / kTwoPi;
    const double a_qq[4] = {0.0, -h0, h0, 0.0};
    const double a_qphi[4] = {-demag_delta, demag_delta, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.expected_positive_frequency_hz = expected_hz;
    problem.expected_frequency_relative_tolerance = 1.0e-10;
    problem.demag_kind = "synthetic_demag_factor";

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.relative_frequency_error <= 1.0e-10,
          "correct synthetic demag sign must match the Kittel-like frequency");
    check(contains(result.diagnostics_json, "\"demag_kind\":\"synthetic_demag_factor\""),
          "synthetic demag-factor toy must not claim production periodic_airbox_k0");
}

void SignFlipBreaksSyntheticDemagKittelFrequency()
{
    const double h0 = kTwoPi * 1.0e9;
    const double demag_delta = 0.5 * h0;
    const double expected_hz = std::sqrt(h0 * (h0 + demag_delta)) / kTwoPi;
    const double a_qq[4] = {0.0, -h0, h0, 0.0};
    const double a_qphi[4] = {demag_delta, -demag_delta, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.expected_positive_frequency_hz = expected_hz;
    problem.expected_frequency_relative_tolerance = 1.0e-10;
    problem.demag_kind = "synthetic_demag_factor";

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::solve_error,
        "flipping A_qphi must break the synthetic demag frequency check");
    check(result.relative_frequency_error > 1.0e-2,
          "sign-flip frequency error must be large enough to catch sign mistakes");
}

void EmitsOracleDiagnosticsJson()
{
    const double f0 = 2.0e9;
    const double omega0 = kTwoPi * f0;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiq[4] = {0.0, 0.0, 0.0, 0.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};

    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.expected_positive_frequency_hz = f0;

    fd::DensePoissonAirboxEigenOracleResult result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(contains(result.diagnostics_json, "\"schema_version\":\"poisson_airbox_eigen_oracle.v1\""),
          "diagnostics JSON must declare oracle schema");
    check(contains(result.diagnostics_json, "\"study_product\":\"modal_eigen\""),
          "diagnostics JSON must declare modal eigen study product");
    check(contains(result.diagnostics_json, "\"demag_kind\":\"synthetic_poisson_airbox_k0\""),
          "diagnostics JSON must not claim production periodic_airbox_k0");
    check(contains(result.diagnostics_json, "\"production_periodic_airbox_claim\":false"),
          "diagnostics JSON must reject production periodic-airbox claims");
}

} // namespace

int main()
{
    RejectsMissingGaugeWeights();
    RejectsPinFirstGaugePolicy();
    RejectsNegativeGaugeWeights();
    RejectsProductionPeriodicAirboxDemagClaim();
    MeanZeroAugmentedGaugeSolvesSingularPoisson();
    SchurApplyMatchesExplicitSchur();
    FullResidualReconstructionMatchesReducedEigenpair();
    PositiveFrequencyBranchMatchesToyGyrotropicPencil();
    SyntheticDemagKittelFrequencyMatchesExpectedWithCorrectSign();
    SignFlipBreaksSyntheticDemagKittelFrequency();
    EmitsOracleDiagnosticsJson();
    return 0;
}
