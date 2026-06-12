#pragma once

#include "cpu/frequency_domain/mfem_driven_response_validation.hpp"
#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/operator_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct DrivenFrequencyResponseTinyValidationProblem {
    bool enabled = false;
    std::uint64_t tangent_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    const double *mass_matrix_row_major = nullptr;
    const double *stiffness_diagonal = nullptr;
    const double *mass_diagonal = nullptr;
    const double *drive_real = nullptr;
};

struct DrivenFrequencyResponseMfemValidationProblem {
    bool enabled = false;
    MfemOperatorContextDescriptor descriptor{};
    MfemTangentSpaceLayout layout{};
    const TangentFrameNode *nodes = nullptr;
    const TangentOperatorEdgeBlock *exchange_edges = nullptr;
    std::uint64_t exchange_edge_count = 0;
    const double *h_ext_a_per_m = nullptr;
    const double *drive_real = nullptr;
};

struct DrivenFrequencyResponseSolveRequest {
    DrivenFrequencyResponseRequest solve_request{};
    const char *output_directory = nullptr;
    bool write_partial_artifacts = false;
    bool (*cancel_requested)(void *user_data) = nullptr;
    void *cancel_user_data = nullptr;
    DrivenFrequencyResponseTinyValidationProblem tiny_validation_problem{};
    DrivenFrequencyResponseMfemValidationProblem mfem_validation_problem{};
};

struct DrivenFrequencyResponseSolveResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    std::uint64_t total_frequency_count = 0;
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t written_frequency_point_artifacts = 0;
    char *error_message = nullptr;
    char *diagnostics_json = nullptr;
    char *result_json = nullptr;
    char *artifact_manifest_path = nullptr;
};

FrequencyDomainStatus solve_driven_frequency_response(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult *out_result) noexcept;

void release_driven_frequency_response_result(
    DrivenFrequencyResponseSolveResult *result) noexcept;

} // namespace fullmag::fem::frequency_domain
