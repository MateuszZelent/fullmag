#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kDensePoissonAirboxEigenOracleAbiVersion = 1;

struct DenseComplexVectorView {
    const double *real = nullptr;
    const double *imag = nullptr;
    std::uint64_t count = 0;
};

struct DenseMutableComplexVectorView {
    double *real = nullptr;
    double *imag = nullptr;
    std::uint64_t count = 0;
};

struct DenseRealMatrixView {
    const double *values_row_major = nullptr;
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
};

struct DensePoissonAirboxEigenOracleProblem {
    std::uint32_t abi_version = kDensePoissonAirboxEigenOracleAbiVersion;
    std::uint64_t struct_size = sizeof(DensePoissonAirboxEigenOracleProblem);

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;

    DenseRealMatrixView A_qq{};
    DenseRealMatrixView A_qphi{};
    DenseRealMatrixView A_phiq{};
    DenseRealMatrixView A_phiphi{};
    DenseRealMatrixView B_qq{};

    const double *phi_mean_weights = nullptr;
    std::uint64_t phi_mean_weights_count = 0;

    DenseComplexVectorView test_q{};

    double expected_positive_frequency_hz = 0.0;
    double expected_frequency_relative_tolerance = 1.0e-10;

    double relative_tolerance = 1.0e-10;
    double absolute_tolerance = 1.0e-12;

    const char *gauge_policy = "mean_zero_augmented";
    const char *eigenvalue_convention = "lambda_imag_positive_frequency";
    const char *phasor_convention = "exp_plus_i_omega_t";
    const char *demag_kind = "synthetic_poisson_airbox_k0";
    const char *test_id = "pa_e1_dense_poisson_airbox_eigen_oracle";

    bool require_alpha_zero = true;
    bool require_k0 = true;
    bool synthetic_no_mesh = true;
};

struct DensePoissonAirboxEigenOracleResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::ok;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_phi_dof_count = 0;

    double schur_apply_relative_error = 0.0;
    double schur_explicit_symmetry_check = 0.0;
    double full_residual_reconstruction_relative_error = 0.0;
    double poisson_constraint_relative_residual = 0.0;
    double gauge_mean_abs = 0.0;
    double sign_flip_relative_error = 0.0;

    double eigenvalue_real = 0.0;
    double eigenvalue_imag = 0.0;
    double omega_rad_s = 0.0;
    double frequency_hz = 0.0;
    double eigen_residual_relative = 0.0;
    double expected_positive_frequency_hz = 0.0;
    double relative_frequency_error = 0.0;

    bool gauge_augmented = false;
    bool schur_certified = false;
    bool full_residual_certified = false;
    bool positive_frequency_branch_found = false;

    char diagnostics_json[8192]{};
};

FrequencyDomainStatus solve_dense_poisson_airbox_eigen_oracle(
    const DensePoissonAirboxEigenOracleProblem &problem,
    DensePoissonAirboxEigenOracleResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
