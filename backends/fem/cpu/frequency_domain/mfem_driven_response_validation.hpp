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
    const double *uniaxial_anisotropy_axis = nullptr;
    double uniaxial_anisotropy_field_a_per_m = 0.0;
    const double *alpha_per_node = nullptr;
    const MfemDmiElementTangentData *dmi_elements = nullptr;
    std::uint64_t dmi_element_count = 0;
    const double *dmi_lumped_mass = nullptr;
    const double *dmi_ms_field = nullptr;
    double dmi_uniform_ms = 0.0;
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
    const double *drive_imag = nullptr;
};

struct MfemDrivenResponseValidationResult {
    static constexpr std::uint64_t gmres_relative_residual_history_capacity = 64;
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t response_dof_count = 0;
    std::uint64_t response_frequency_count = 0;
    double max_frequency_hz = 0.0;
    double max_abs_response = 0.0;
    double max_abs_stiffness_matrix = 0.0;
    double max_abs_mass_matrix = 0.0;
    std::uint64_t total_iteration_count = 0;
    std::uint64_t max_iterations_for_frequency = 0;
    std::uint64_t restart_iterations_for_frequency = 0;
    std::uint64_t progress_interval_iterations = 1;
    std::uint64_t operator_apply_count = 0;
    std::uint64_t stiffness_apply_count = 0;
    std::uint64_t mass_apply_count = 0;
    std::uint64_t complex_stiffness_apply_count = 0;
    std::uint64_t complex_mass_apply_count = 0;
    std::uint64_t right_preconditioner_apply_count = 0;
    std::uint64_t gmres_orthogonalization_count = 0;
    std::uint64_t gmres_restart_count = 0;
    std::uint64_t progress_callback_count = 0;
    double solver_relative_tolerance = 0.0;
    double solver_absolute_tolerance = 0.0;
    double rhs_l2_norm = 0.0;
    double initial_residual_l2_norm = 0.0;
    double initial_relative_residual_l2_norm = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    double minimum_tracked_relative_residual_l2_norm = 0.0;
    std::uint64_t minimum_tracked_relative_residual_iteration = 0;
    double last_tracked_relative_residual_l2_norm = 0.0;
    double last_recomputed_relative_residual_l2_norm = 0.0;
    bool residual_consistency_degraded = false;
    double residual_consistency_ratio = 0.0;
    bool stagnation_detected = false;
    std::uint64_t stagnation_iteration = 0;
    double stagnation_relative_residual_ratio = 0.0;
    double rhs_real_l2_norm = 0.0;
    double rhs_imag_l2_norm = 0.0;
    double residual_real_l2_norm = 0.0;
    double residual_imag_l2_norm = 0.0;
    double response_real_l2_norm = 0.0;
    double response_imag_l2_norm = 0.0;
    bool right_preconditioner_probe_available = false;
    double right_preconditioner_probe_residual_l2_norm = 0.0;
    double right_preconditioner_probe_relative_residual_l2_norm = 0.0;
    bool right_preconditioner_fallback_probe_available = false;
    double right_preconditioner_fallback_probe_residual_l2_norm = 0.0;
    double right_preconditioner_fallback_probe_relative_residual_l2_norm = 0.0;
    bool right_preconditioner_auto_disabled = false;
    double right_preconditioner_probe_disable_relative_threshold = 0.0;
    char right_preconditioner_auto_disable_reason[64] = "";
    bool right_preconditioner_pilot_available = false;
    std::uint64_t right_preconditioner_pilot_iterations = 0;
    double right_preconditioner_primary_pilot_residual_l2_norm = 0.0;
    double right_preconditioner_primary_pilot_relative_residual_l2_norm = 0.0;
    double right_preconditioner_fallback_pilot_residual_l2_norm = 0.0;
    double right_preconditioner_fallback_pilot_relative_residual_l2_norm = 0.0;
    double right_preconditioner_unpreconditioned_pilot_residual_l2_norm = 0.0;
    double right_preconditioner_unpreconditioned_pilot_relative_residual_l2_norm = 0.0;
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
    bool demag_tangent_linearity_check = false;
    double demag_tangent_probe_input_l2_norm = 0.0;
    double demag_tangent_probe_output_l2_norm = 0.0;
    double demag_tangent_additivity_max_abs_error = 0.0;
    double demag_tangent_homogeneity_max_abs_error = 0.0;
    double demag_tangent_additivity_relative_error = 0.0;
    double demag_tangent_homogeneity_relative_error = 0.0;
    double demag_tangent_repeat_relative_error = 0.0;
    double demag_tangent_zero_after_nonzero_l2_norm = 0.0;
    bool demag_tangent_provider_parity_available = false;
    double demag_tangent_provider_parity_host_l2_norm = 0.0;
    double demag_tangent_provider_parity_with_potential_l2_norm = 0.0;
    double demag_tangent_provider_parity_difference_l2_norm = 0.0;
    double demag_tangent_provider_parity_relative_l2_error = 0.0;
    double residual_growth_factor = 0.0;
    bool right_preconditioner_applied = false;
    char krylov_preconditioner[64] = "none";
    char error_message[128] = "";
};

FrequencyDomainStatus solve_mfem_driven_response_validation_problem(
    const MfemDrivenResponseValidationProblem &problem,
    MfemDrivenResponseValidationResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
