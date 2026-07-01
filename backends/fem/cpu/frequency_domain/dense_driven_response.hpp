#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct DenseDrivenResponseValidationProblem {
    std::uint64_t tangent_dof_count = 0;
    const double *frequencies_hz = nullptr;
    std::uint64_t frequency_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    const double *mass_matrix_row_major = nullptr;
    const double *stiffness_diagonal = nullptr;
    const double *mass_diagonal = nullptr;
    const double *drive_real = nullptr;
    double *out_response_real = nullptr;
    double *out_response_imag = nullptr;
    std::uint64_t response_capacity = 0;
    double *out_residual_l2_norm = nullptr;
    double *out_relative_residual_l2_norm = nullptr;
    std::uint64_t residual_capacity = 0;
    bool (*cancel_requested)(void *user_data) = nullptr;
    void *cancel_user_data = nullptr;
    const double *drive_imag = nullptr;
};

struct DenseDrivenResponseValidationResult {
    static constexpr std::uint64_t gmres_relative_residual_history_capacity = 64;
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t response_dof_count = 0;
    std::uint64_t response_frequency_count = 0;
    std::uint64_t total_iteration_count = 0;
    std::uint64_t max_iterations_for_frequency = 0;
    std::uint64_t restart_iterations_for_frequency = 0;
    std::uint64_t progress_interval_iterations = 1;
    double max_frequency_hz = 0.0;
    double max_abs_response = 0.0;
    double solver_relative_tolerance = 0.0;
    double rhs_l2_norm = 0.0;
    double initial_residual_l2_norm = 0.0;
    double initial_relative_residual_l2_norm = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    double minimum_tracked_relative_residual_l2_norm = 0.0;
    std::uint64_t minimum_tracked_relative_residual_iteration = 0;
    double last_tracked_relative_residual_l2_norm = 0.0;
    double last_recomputed_relative_residual_l2_norm = 0.0;
    double residual_growth_factor = 0.0;
    double rhs_delta_m_l2_norm = 0.0;
    double rhs_delta_phi_l2_norm = 0.0;
    double residual_delta_m_l2_norm = 0.0;
    double residual_delta_phi_l2_norm = 0.0;
    double relative_residual_delta_m_l2_norm = 0.0;
    double relative_residual_delta_phi_l2_norm = 0.0;
    double response_delta_m_l2_norm = 0.0;
    double response_delta_phi_l2_norm = 0.0;
    bool coupled_block_norms_available = false;
    char coupled_residual_partition_status[64] = "";
    std::uint64_t gmres_relative_residual_history_count = 0;
    double gmres_relative_residual_history[gmres_relative_residual_history_capacity]{};
    bool right_preconditioner_applied = false;
    char krylov_preconditioner[64] = "none";
    char error_message[128] = "";
};

FrequencyDomainStatus solve_dense_driven_response_validation_problem(
    const DenseDrivenResponseValidationProblem &problem,
    DenseDrivenResponseValidationResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
