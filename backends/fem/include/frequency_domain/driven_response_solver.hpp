#pragma once

#include "cpu/frequency_domain/mfem_driven_response_validation.hpp"
#include "cpu/frequency_domain/production_cpu_driven_response.hpp"
#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/operator_contract.hpp"
#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kDrivenFrequencyResponseSolveRequestAbiVersion = 12;

struct DrivenFrequencyResponseSolverOptions {
    // Zero-valued options use the runtime defaults selected by the production
    // solver and reported in diagnostics.
    double relative_tolerance = 0.0;
    double absolute_tolerance = 0.0;
    std::uint64_t max_iterations = 0;
    std::uint64_t restart_iterations = 0;
    std::uint64_t progress_interval_iterations = 0;
};

struct DrivenFrequencyResponseTinyValidationProblem {
    bool enabled = false;
    std::uint64_t tangent_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    std::uint64_t stiffness_matrix_value_count = 0;
    const double *mass_matrix_row_major = nullptr;
    std::uint64_t mass_matrix_value_count = 0;
    const double *stiffness_diagonal = nullptr;
    std::uint64_t stiffness_diagonal_value_count = 0;
    const double *mass_diagonal = nullptr;
    std::uint64_t mass_diagonal_value_count = 0;
    const double *drive_real = nullptr;
    std::uint64_t drive_real_value_count = 0;
    const double *drive_imag = nullptr;
    std::uint64_t drive_imag_value_count = 0;
};

struct DrivenFrequencyResponseMfemValidationProblem {
    bool enabled = false;
    MfemOperatorContextDescriptor descriptor{};
    MfemTangentSpaceLayout layout{};
    const TangentFrameNode *nodes = nullptr;
    std::uint64_t node_count = 0;
    const TangentOperatorEdgeBlock *exchange_edges = nullptr;
    std::uint64_t exchange_edge_count = 0;
    const double *h_ext_a_per_m = nullptr;
    std::uint64_t h_ext_value_count = 0;
    const double *uniaxial_anisotropy_axis = nullptr;
    std::uint64_t uniaxial_anisotropy_axis_value_count = 0;
    double uniaxial_anisotropy_field_a_per_m = 0.0;
    const double *alpha_per_node = nullptr;
    std::uint64_t alpha_value_count = 0;
    const MfemDmiElementTangentData *dmi_elements = nullptr;
    std::uint64_t dmi_element_count = 0;
    const double *dmi_lumped_mass = nullptr;
    std::uint64_t dmi_lumped_mass_value_count = 0;
    const double *dmi_ms_field = nullptr;
    std::uint64_t dmi_ms_field_value_count = 0;
    double dmi_uniform_ms = 0.0;
    const double *observable_ms_field = nullptr;
    std::uint64_t observable_ms_field_len = 0;
    double observable_uniform_ms = 0.0;
    const double *drive_real = nullptr;
    std::uint64_t drive_real_value_count = 0;
    const double *drive_imag = nullptr;
    std::uint64_t drive_imag_value_count = 0;
    const std::uint64_t *static_periodic_node_pairs = nullptr;
    std::uint64_t static_periodic_node_pair_count = 0;
    ProductionCpuFrequencyDomainApply apply_demag_tangent = nullptr;
    ProductionCpuFrequencyDomainApplyWithPotential apply_demag_tangent_with_potential = nullptr;
    void *demag_tangent_user_data = nullptr;
    const double *demag_tangent_matrix_row_major = nullptr;
    std::uint64_t demag_tangent_matrix_value_count = 0;
};

struct DrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem {
    bool enabled = false;
    std::uint64_t delta_m_tangent_dof_count = 0;
    std::uint64_t delta_phi_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    std::uint64_t stiffness_matrix_value_count = 0;
    const double *mass_matrix_row_major = nullptr;
    std::uint64_t mass_matrix_value_count = 0;
    ProductionCpuFrequencyDomainApply apply_stiffness = nullptr;
    ProductionCpuFrequencyDomainApply apply_mass = nullptr;
    ProductionCpuFrequencyDomainComplexApply apply_complex_stiffness = nullptr;
    ProductionCpuFrequencyDomainComplexApply apply_complex_mass = nullptr;
    void *operator_user_data = nullptr;
    ProductionCpuFrequencyDomainRightPreconditioner apply_right_preconditioner = nullptr;
    void *right_preconditioner_user_data = nullptr;
    const char *right_preconditioner_name = nullptr;
    const double *drive_real = nullptr;
    std::uint64_t drive_real_value_count = 0;
    const double *drive_imag = nullptr;
    std::uint64_t drive_imag_value_count = 0;
    const char *operator_source = nullptr;
    const char *artifact_revision = nullptr;
    const char *solver_kind = nullptr;
    const char *frequency_point_solver_model = nullptr;
};

enum class DrivenFrequencyResponseExecutionLane : std::uint32_t {
    validation,
    production_cpu,
    production_gpu,
};

enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};

struct DrivenFrequencyResponseSolveRequest {
    std::uint32_t abi_version = kDrivenFrequencyResponseSolveRequestAbiVersion;
    std::uint32_t reserved_contract_flags = 0;
    // struct_size == 0 preserves legacy/default C++ callers. Nonzero values
    // must match sizeof(DrivenFrequencyResponseSolveRequest).
    std::uint64_t struct_size = 0;
    DrivenFrequencyResponseRequest solve_request{};
    DrivenFrequencyResponseSolverOptions solver_options{};
    const char *output_directory = nullptr;
    bool write_partial_artifacts = false;
    const char *operator_diagnostics_json = nullptr;
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
    FrequencyDriveKind drive_kind =
        FrequencyDriveKind::dynamic_field_phasor_a_per_m;
    bool require_nonzero_rhs = false;
    const FrequencyDomainFloquetPeriodicPair *floquet_periodic_pairs = nullptr;
    std::uint64_t floquet_periodic_pair_count = 0;
    bool requires_periodic_airbox_dynamic_demag = false;
    bool requires_floquet_airbox_dynamic_demag = false;
    std::uint64_t magnetic_periodic_constraint_set_count = 0;
    std::uint64_t magnetostatic_periodic_constraint_set_count = 0;
    std::uint64_t periodic_airbox_delta_m_tangent_dof_count = 0;
    std::uint64_t periodic_airbox_delta_phi_dof_count = 0;
    const std::uint64_t *periodic_airbox_magnetostatic_periodic_node_pairs = nullptr;
    std::uint64_t periodic_airbox_magnetostatic_periodic_node_pair_count = 0;
    DrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem periodic_airbox_coupled_block_problem{};
    DrivenFrequencyResponseTinyValidationProblem tiny_validation_problem{};
    DrivenFrequencyResponseMfemValidationProblem mfem_validation_problem{};
};

struct DrivenFrequencyResponseSolveResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    std::uint64_t total_frequency_count = 0;
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t written_frequency_point_artifacts = 0;
    // Owned UTF-8, null-terminated buffers allocated by the native solver.
    // Call release_driven_frequency_response_result once the result is no
    // longer needed; the release function is idempotent and clears all fields.
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
