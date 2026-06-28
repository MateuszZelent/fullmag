#pragma once

#include "cpu/frequency_domain/mfem_driven_response_validation.hpp"
#include "cpu/frequency_domain/production_cpu_driven_response.hpp"
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
    const double *drive_imag = nullptr;
};

struct DrivenFrequencyResponseMfemValidationProblem {
    bool enabled = false;
    MfemOperatorContextDescriptor descriptor{};
    MfemTangentSpaceLayout layout{};
    const TangentFrameNode *nodes = nullptr;
    const TangentOperatorEdgeBlock *exchange_edges = nullptr;
    std::uint64_t exchange_edge_count = 0;
    const double *h_ext_a_per_m = nullptr;
    const double *uniaxial_anisotropy_axis = nullptr;
    double uniaxial_anisotropy_field_a_per_m = 0.0;
    const double *alpha_per_node = nullptr;
    const MfemDmiElementTangentData *dmi_elements = nullptr;
    std::uint64_t dmi_element_count = 0;
    const double *dmi_lumped_mass = nullptr;
    const double *dmi_ms_field = nullptr;
    double dmi_uniform_ms = 0.0;
    const double *drive_real = nullptr;
    const double *drive_imag = nullptr;
    const std::uint64_t *static_periodic_node_pairs = nullptr;
    std::uint64_t static_periodic_node_pair_count = 0;
    ProductionCpuFrequencyDomainApply apply_demag_tangent = nullptr;
    void *demag_tangent_user_data = nullptr;
    const double *demag_tangent_matrix_row_major = nullptr;
};

struct DrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem {
    bool enabled = false;
    std::uint64_t delta_m_tangent_dof_count = 0;
    std::uint64_t delta_phi_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    const double *mass_matrix_row_major = nullptr;
    const double *drive_real = nullptr;
    const double *drive_imag = nullptr;
};

enum class DrivenFrequencyResponseExecutionLane {
    validation,
    production_cpu,
    production_gpu,
};

struct DrivenFrequencyResponseSolveRequest {
    DrivenFrequencyResponseRequest solve_request{};
    const char *output_directory = nullptr;
    bool write_partial_artifacts = false;
    bool (*cancel_requested)(void *user_data) = nullptr;
    void *cancel_user_data = nullptr;
    ProductionCpuFrequencyDomainProgress progress_callback = nullptr;
    void *progress_user_data = nullptr;
    DrivenFrequencyResponseExecutionLane execution_lane =
        DrivenFrequencyResponseExecutionLane::validation;
    bool has_floquet_k_vector = false;
    double floquet_k_vector_rad_per_m[3] = {0.0, 0.0, 0.0};
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
    const FrequencyDomainFloquetPeriodicPair *floquet_periodic_pairs = nullptr;
    std::uint64_t floquet_periodic_pair_count = 0;
    bool requires_periodic_airbox_dynamic_demag = false;
    std::uint64_t magnetic_periodic_constraint_set_count = 0;
    std::uint64_t magnetostatic_periodic_constraint_set_count = 0;
    std::uint64_t periodic_airbox_delta_m_tangent_dof_count = 0;
    std::uint64_t periodic_airbox_delta_phi_dof_count = 0;
    DrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem periodic_airbox_coupled_block_problem{};
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
