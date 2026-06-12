#pragma once

#include "cpu/frequency_domain/dense_driven_response.hpp"
#include "cpu/frequency_domain/mfem_linearized_operator.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemDrivenResponseValidationProblem {
    MfemOperatorContextDescriptor descriptor{};
    MfemTangentSpaceLayout layout{};
    const TangentFrameNode *nodes = nullptr;
    const TangentOperatorEdgeBlock *exchange_edges = nullptr;
    std::uint64_t exchange_edge_count = 0;
    const double *h_ext_a_per_m = nullptr;
    double gamma0 = 0.0;
    double alpha = 0.0;
    const double *frequencies_hz = nullptr;
    std::uint64_t frequency_count = 0;
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

struct MfemDrivenResponseValidationResult {
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t response_dof_count = 0;
    std::uint64_t response_frequency_count = 0;
    double max_frequency_hz = 0.0;
    double max_abs_response = 0.0;
    double max_abs_stiffness_matrix = 0.0;
    double max_abs_mass_matrix = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus solve_mfem_driven_response_validation_problem(
    const MfemDrivenResponseValidationProblem &problem,
    MfemDrivenResponseValidationResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
