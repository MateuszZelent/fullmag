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
};

struct DenseDrivenResponseValidationResult {
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t response_dof_count = 0;
    std::uint64_t response_frequency_count = 0;
    double max_frequency_hz = 0.0;
    double max_abs_response = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus solve_dense_driven_response_validation_problem(
    const DenseDrivenResponseValidationProblem &problem,
    DenseDrivenResponseValidationResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
