#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct ModalResponseDiagonalValidationProblem {
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t mode_count = 0;
    const double *frequencies_hz = nullptr;
    std::uint64_t frequency_count = 0;
    const double *mode_shapes_row_major = nullptr;
    std::uint64_t mode_shape_value_count = 0;
    const double *modal_stiffness_diagonal = nullptr;
    std::uint64_t modal_stiffness_value_count = 0;
    const double *modal_mass_diagonal = nullptr;
    std::uint64_t modal_mass_value_count = 0;
    const double *drive_real = nullptr;
    const double *drive_imag = nullptr;
    double *out_response_real = nullptr;
    double *out_response_imag = nullptr;
    std::uint64_t response_capacity = 0;
    const double *sparse_direct_sample_frequencies_hz = nullptr;
    std::uint64_t sparse_direct_sample_frequency_count = 0;
};

struct ModalResponseValidationResult {
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t sparse_direct_sample_count = 0;
    std::uint64_t mode_count = 0;
    double max_abs_response = 0.0;
    double max_sample_error_l2_norm = 0.0;
    double max_relative_sample_error_l2_norm = 0.0;
    double max_sparse_direct_sample_error_l2_norm = 0.0;
    double max_sparse_direct_relative_sample_error_l2_norm = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus solve_modal_response_diagonal_validation_problem(
    const ModalResponseDiagonalValidationProblem &problem,
    ModalResponseValidationResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
