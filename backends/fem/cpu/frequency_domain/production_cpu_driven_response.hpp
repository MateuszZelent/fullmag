#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/linearized_dynamic_pencil.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint64_t kProductionCpuGmresResidualHistoryCapacity = 64;
constexpr std::uint64_t kProductionCpuDrivenResponseDefaultProgressIntervalIterations = 128;

using ProductionCpuFrequencyDomainApply =
    FrequencyDomainStatus (*)(void *user_data, const double *in, double *out, char error_message[128]);

using ProductionCpuFrequencyDomainComplexApply =
    FrequencyDomainStatus (*)(
        void *user_data,
        const double *in_real,
        const double *in_imag,
        double *out_real,
        double *out_imag,
        char error_message[128]);

using ProductionCpuFrequencyDomainApplyWithPotential =
    FrequencyDomainStatus (*)(
        void *user_data,
        const double *in,
        double *out,
        double *out_phi,
        std::uint64_t out_phi_len,
        char error_message[128]);

using ProductionCpuFrequencyDomainBlockProject =
    FrequencyDomainStatus (*)(
        void *user_data,
        const double *in,
        double *out,
        std::uint64_t tangent_dof_count,
        char error_message[128]);

using ProductionCpuFrequencyDomainRightPreconditioner =
    FrequencyDomainStatus (*)(
        void *user_data,
        double omega_rad_per_s,
        const double *in,
        double *out,
        std::uint64_t tangent_dof_count,
        char error_message[128]);

struct ProductionCpuDrivenResponseProgress {
    std::uint64_t frequency_index = 0;
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t total_frequency_count = 0;
    std::uint64_t iteration_count = 0;
    double frequency_hz = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    bool converged = false;
};

using ProductionCpuFrequencyDomainProgress =
    void (*)(void *user_data, const ProductionCpuDrivenResponseProgress &progress);

struct ProductionCpuDrivenResponseProblem {
    std::uint64_t tangent_dof_count = 0;
    const double *frequencies_hz = nullptr;
    std::uint64_t frequency_count = 0;
    const double *drive_real = nullptr;
    ProductionCpuFrequencyDomainApply apply_stiffness = nullptr;
    ProductionCpuFrequencyDomainApply apply_mass = nullptr;
    ProductionCpuFrequencyDomainComplexApply apply_complex_stiffness = nullptr;
    ProductionCpuFrequencyDomainComplexApply apply_complex_mass = nullptr;
    void *operator_user_data = nullptr;
    double relative_tolerance = 1.0e-3;
    double absolute_tolerance = 0.0;
    std::uint64_t max_iterations = 8192;
    std::uint64_t restart_iterations = 8192;
    double *out_response_real = nullptr;
    double *out_response_imag = nullptr;
    std::uint64_t response_capacity = 0;
    double *out_residual_l2_norm = nullptr;
    double *out_relative_residual_l2_norm = nullptr;
    std::uint64_t residual_capacity = 0;
    bool (*cancel_requested)(void *user_data) = nullptr;
    void *cancel_user_data = nullptr;
    ProductionCpuFrequencyDomainProgress progress_callback = nullptr;
    void *progress_user_data = nullptr;
    const double *drive_imag = nullptr;
    double angular_frequency_sign = 1.0;
    ProductionCpuFrequencyDomainBlockProject project_block = nullptr;
    void *project_block_user_data = nullptr;
    std::uint64_t progress_interval_iterations =
        kProductionCpuDrivenResponseDefaultProgressIntervalIterations;
    ProductionCpuFrequencyDomainRightPreconditioner apply_right_preconditioner = nullptr;
    void *right_preconditioner_user_data = nullptr;
    const char *krylov_preconditioner_name = nullptr;
    ProductionCpuFrequencyDomainRightPreconditioner fallback_apply_right_preconditioner = nullptr;
    void *fallback_right_preconditioner_user_data = nullptr;
    const char *fallback_krylov_preconditioner_name = nullptr;
    std::uint64_t logical_delta_m_dof_count = 0;
    std::uint64_t logical_delta_phi_dof_count = 0;
    const char *coupled_residual_partition_status = nullptr;
    bool auto_disable_harmful_right_preconditioner = false;
    double right_preconditioner_probe_disable_relative_threshold = 1.0;
    std::uint64_t right_preconditioner_auto_pilot_iterations = 0;
    // Optional canonical reference action.  When present, GMRES and every
    // recomputed residual consume this same Aomega owner.
    const LinearizedDynamicPencil *linearized_dynamic_pencil = nullptr;

    ProductionCpuDrivenResponseProblem() = default;

    ProductionCpuDrivenResponseProblem(
        std::uint64_t tangent_dof_count_in,
        const double *frequencies_hz_in,
        std::uint64_t frequency_count_in,
        const double *drive_real_in,
        ProductionCpuFrequencyDomainApply apply_stiffness_in,
        ProductionCpuFrequencyDomainApply apply_mass_in,
        void *operator_user_data_in,
        double relative_tolerance_in,
        std::uint64_t max_iterations_in,
        std::uint64_t restart_iterations_in,
        double *out_response_real_in = nullptr,
        double *out_response_imag_in = nullptr,
        std::uint64_t response_capacity_in = 0,
        double *out_residual_l2_norm_in = nullptr,
        double *out_relative_residual_l2_norm_in = nullptr,
        std::uint64_t residual_capacity_in = 0,
        bool (*cancel_requested_in)(void *user_data) = nullptr,
        void *cancel_user_data_in = nullptr,
        ProductionCpuFrequencyDomainProgress progress_callback_in = nullptr,
        void *progress_user_data_in = nullptr,
        const double *drive_imag_in = nullptr,
        double angular_frequency_sign_in = 1.0,
        ProductionCpuFrequencyDomainBlockProject project_block_in = nullptr,
        void *project_block_user_data_in = nullptr,
        std::uint64_t progress_interval_iterations_in =
            kProductionCpuDrivenResponseDefaultProgressIntervalIterations,
        ProductionCpuFrequencyDomainRightPreconditioner apply_right_preconditioner_in = nullptr,
        void *right_preconditioner_user_data_in = nullptr,
        const char *krylov_preconditioner_name_in = nullptr,
        std::uint64_t logical_delta_m_dof_count_in = 0,
        std::uint64_t logical_delta_phi_dof_count_in = 0,
        const char *coupled_residual_partition_status_in = nullptr,
        double absolute_tolerance_in = 0.0)
        : tangent_dof_count(tangent_dof_count_in),
          frequencies_hz(frequencies_hz_in),
          frequency_count(frequency_count_in),
          drive_real(drive_real_in),
          apply_stiffness(apply_stiffness_in),
          apply_mass(apply_mass_in),
          operator_user_data(operator_user_data_in),
          relative_tolerance(relative_tolerance_in),
          absolute_tolerance(absolute_tolerance_in),
          max_iterations(max_iterations_in),
          restart_iterations(restart_iterations_in),
          out_response_real(out_response_real_in),
          out_response_imag(out_response_imag_in),
          response_capacity(response_capacity_in),
          out_residual_l2_norm(out_residual_l2_norm_in),
          out_relative_residual_l2_norm(out_relative_residual_l2_norm_in),
          residual_capacity(residual_capacity_in),
          cancel_requested(cancel_requested_in),
          cancel_user_data(cancel_user_data_in),
          progress_callback(progress_callback_in),
          progress_user_data(progress_user_data_in),
          drive_imag(drive_imag_in),
          angular_frequency_sign(angular_frequency_sign_in),
          project_block(project_block_in),
          project_block_user_data(project_block_user_data_in),
          progress_interval_iterations(progress_interval_iterations_in),
          apply_right_preconditioner(apply_right_preconditioner_in),
          right_preconditioner_user_data(right_preconditioner_user_data_in),
          krylov_preconditioner_name(krylov_preconditioner_name_in),
          logical_delta_m_dof_count(logical_delta_m_dof_count_in),
          logical_delta_phi_dof_count(logical_delta_phi_dof_count_in),
          coupled_residual_partition_status(coupled_residual_partition_status_in)
    {
    }

    ProductionCpuDrivenResponseProblem(
        std::uint64_t tangent_dof_count_in,
        const double *frequencies_hz_in,
        std::uint64_t frequency_count_in,
        const double *drive_real_in,
        ProductionCpuFrequencyDomainApply apply_stiffness_in,
        ProductionCpuFrequencyDomainApply apply_mass_in,
        ProductionCpuFrequencyDomainComplexApply apply_complex_stiffness_in,
        ProductionCpuFrequencyDomainComplexApply apply_complex_mass_in,
        void *operator_user_data_in,
        double relative_tolerance_in,
        std::uint64_t max_iterations_in,
        std::uint64_t restart_iterations_in,
        double *out_response_real_in = nullptr,
        double *out_response_imag_in = nullptr,
        std::uint64_t response_capacity_in = 0,
        double *out_residual_l2_norm_in = nullptr,
        double *out_relative_residual_l2_norm_in = nullptr,
        std::uint64_t residual_capacity_in = 0,
        bool (*cancel_requested_in)(void *user_data) = nullptr,
        void *cancel_user_data_in = nullptr,
        ProductionCpuFrequencyDomainProgress progress_callback_in = nullptr,
        void *progress_user_data_in = nullptr,
        const double *drive_imag_in = nullptr,
        double angular_frequency_sign_in = 1.0,
        ProductionCpuFrequencyDomainBlockProject project_block_in = nullptr,
        void *project_block_user_data_in = nullptr,
        std::uint64_t progress_interval_iterations_in =
            kProductionCpuDrivenResponseDefaultProgressIntervalIterations,
        ProductionCpuFrequencyDomainRightPreconditioner apply_right_preconditioner_in = nullptr,
        void *right_preconditioner_user_data_in = nullptr,
        const char *krylov_preconditioner_name_in = nullptr,
        std::uint64_t logical_delta_m_dof_count_in = 0,
        std::uint64_t logical_delta_phi_dof_count_in = 0,
        const char *coupled_residual_partition_status_in = nullptr,
        double absolute_tolerance_in = 0.0)
        : ProductionCpuDrivenResponseProblem(
              tangent_dof_count_in,
              frequencies_hz_in,
              frequency_count_in,
              drive_real_in,
              apply_stiffness_in,
              apply_mass_in,
              operator_user_data_in,
              relative_tolerance_in,
              max_iterations_in,
              restart_iterations_in,
              out_response_real_in,
              out_response_imag_in,
              response_capacity_in,
              out_residual_l2_norm_in,
              out_relative_residual_l2_norm_in,
              residual_capacity_in,
              cancel_requested_in,
              cancel_user_data_in,
              progress_callback_in,
              progress_user_data_in,
              drive_imag_in,
              angular_frequency_sign_in,
              project_block_in,
              project_block_user_data_in,
              progress_interval_iterations_in,
              apply_right_preconditioner_in,
              right_preconditioner_user_data_in,
              krylov_preconditioner_name_in,
              logical_delta_m_dof_count_in,
              logical_delta_phi_dof_count_in,
              coupled_residual_partition_status_in,
              absolute_tolerance_in)
    {
        apply_complex_stiffness = apply_complex_stiffness_in;
        apply_complex_mass = apply_complex_mass_in;
    }
};

struct ProductionCpuDrivenResponseResult {
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t response_dof_count = 0;
    std::uint64_t total_iteration_count = 0;
    std::uint64_t max_iterations_for_frequency = 0;
    std::uint64_t restart_iterations_for_frequency = 0;
    std::uint64_t progress_interval_iterations =
        kProductionCpuDrivenResponseDefaultProgressIntervalIterations;
    std::uint64_t operator_apply_count = 0;
    std::uint64_t stiffness_apply_count = 0;
    std::uint64_t mass_apply_count = 0;
    std::uint64_t complex_stiffness_apply_count = 0;
    std::uint64_t complex_mass_apply_count = 0;
    std::uint64_t right_preconditioner_apply_count = 0;
    std::uint64_t gmres_orthogonalization_count = 0;
    std::uint64_t gmres_restart_count = 0;
    std::uint64_t progress_callback_count = 0;
    double max_frequency_hz = 0.0;
    double max_abs_response = 0.0;
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
    bool right_preconditioner_residual_consistency_degraded = false;
    double right_preconditioner_residual_consistency_ratio = 0.0;
    bool stagnation_detected = false;
    std::uint64_t stagnation_iteration = 0;
    double stagnation_relative_residual_ratio = 0.0;
    double residual_growth_factor = 0.0;
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
    double rhs_real_l2_norm = 0.0;
    double rhs_imag_l2_norm = 0.0;
    double residual_real_l2_norm = 0.0;
    double residual_imag_l2_norm = 0.0;
    double response_real_l2_norm = 0.0;
    double response_imag_l2_norm = 0.0;
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
    double gmres_relative_residual_history[kProductionCpuGmresResidualHistoryCapacity]{};
    bool right_preconditioner_applied = false;
    char krylov_preconditioner[64] = "none";
    char error_message[128] = "";
};

FrequencyDomainStatus solve_production_cpu_driven_response(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
