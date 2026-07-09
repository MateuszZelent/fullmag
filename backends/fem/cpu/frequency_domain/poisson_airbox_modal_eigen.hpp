#pragma once

#include "frequency_domain/modal_eigen_request.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kPoissonAirboxEigenBlockProblemAbiVersion = 2;

struct PoissonAirboxEigenBlockProblem {
    std::uint32_t abi_version = kPoissonAirboxEigenBlockProblemAbiVersion;
    std::uint64_t struct_size = sizeof(PoissonAirboxEigenBlockProblem);

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;

    CsrMatrixView A_qq{};
    CsrMatrixView A_qphi{};
    CsrMatrixView A_phiq{};
    CsrMatrixView A_phiphi{};
    CsrMatrixView B_qq{};

    const double *phi_mean_weights = nullptr;
    std::uint64_t phi_mean_weights_count = 0;

    double target_frequency_hz = 0.0;
    double expected_reference_frequency_hz = 0.0;
    double residual_tolerance = 1.0e-10;
    std::uint32_t requested_mode_count = 1;
    std::uint32_t max_outer_iterations = 64;
    std::uint32_t max_linear_iterations = 128;

    const char *outer_boundary_kind = nullptr;
    double robin_beta = 0.0;
    const char *gauge_policy = nullptr;
    const char *gauge_reason = nullptr;
    const char *assembly_kind = nullptr;
    const char *demag_kind = "periodic_airbox_k0";
    const char *phasor_convention = "exp_plus_i_omega_t";
    const char *eigenvalue_convention = "lambda_imag_positive_frequency";
    const char *solver_adapter = "k0_poisson_airbox_cpu_full_coupled_slepc";
    const char *test_id = "pa_e2_poisson_airbox_modal_eigen_cpu_slepc";
    const char *periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    std::uint64_t magnetic_pair_count = 0;
    std::uint64_t airbox_pair_count = 0;

    bool k0_only = true;
    bool alpha_zero_required = true;
    bool symmetric_mesh_certificate_required = true;
    bool periodic_mesh_certificate_required = true;
    bool real_fem_blocks = true;
};

struct PoissonAirboxModalEigenResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_dof_count = 0;
    std::uint64_t magnetic_pair_count = 0;
    std::uint64_t airbox_pair_count = 0;

    std::uint32_t converged_eigenpair_count = 0;
    std::uint32_t accepted_mode_count = 0;
    std::uint32_t selected_eigenpair_index = 0;
    std::uint32_t outer_iterations = 0;

    double eigenvalue_real = 0.0;
    double eigenvalue_imag = 0.0;
    double omega_rad_s = 0.0;
    double frequency_hz = 0.0;
    double eigen_residual_relative = 0.0;
    double full_residual_reconstruction_relative_error = 0.0;
    double poisson_constraint_relative_residual = 0.0;
    double gauge_mean_abs = 0.0;
    double expected_reference_frequency_hz = 0.0;
    double relative_reference_frequency_error = 0.0;

    bool gauge_augmented = false;
    bool positive_frequency_branch_found = false;
    bool full_residual_certified = false;
    bool reference_frequency_certified = false;

    char diagnostics_json[8192]{};
};

struct PoissonAirboxModalShiftInvertActionResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_dof_count = 0;

    double sigma_real = 0.0;
    double sigma_imag = 0.0;
    double rhs_l2_norm = 0.0;
    double output_q_l2_norm = 0.0;
    double shifted_system_relative_residual = 0.0;

    bool full_modal_shift_invert_claim = false;

    char diagnostics_json[4096]{};
};

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_cpu_slepc(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept;

FrequencyDomainStatus apply_poisson_airbox_modal_shift_invert_action_cpu_reference(
    const PoissonAirboxEigenBlockProblem &problem,
    double sigma_real,
    double sigma_imag,
    const double *v_q_real,
    const double *v_q_imag,
    std::uint64_t v_q_count,
    double *out_q_real,
    double *out_q_imag,
    std::uint64_t out_q_count,
    PoissonAirboxModalShiftInvertActionResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
