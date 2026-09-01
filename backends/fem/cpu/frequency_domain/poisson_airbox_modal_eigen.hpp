#pragma once

#include "frequency_domain/modal_eigen_request.hpp"

#include <complex>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <vector>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kPoissonAirboxEigenBlockProblemAbiVersion = 5;

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
    const char *target_kind = "nearest_frequency";
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
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

    // Canonical shared-domain identities validated by the public request
    // boundary.  Production persistence compares these exact identities;
    // direct algebraic fixtures without them use a validation-only content
    // signature and must not claim canonical identity provenance.
    const char *mesh_generation_identity = nullptr;
    const char *equilibrium_digest = nullptr;
    const char *bias_field_sample_signature = nullptr;
    const char *boundary_gauge_digest = nullptr;
    const char *operator_input_digest = nullptr;

    bool k0_only = true;
    bool alpha_zero_required = true;
    bool symmetric_mesh_certificate_required = true;
    bool periodic_mesh_certificate_required = true;
    bool real_fem_blocks = true;
    // Direct C++ fixtures may provide shared-domain-shaped algebraic blocks
    // for validation.  Only the API path that consumed a real shared-domain
    // payload may describe the resulting lane as production-intended.
    bool production_shared_domain = false;
    // Synthetic algebraic fixtures must opt into this adapter explicitly.  It
    // is never accepted as production provenance and may use bounded
    // materialized validation operators.
    bool validation_only_adapter = false;

    // Runtime control callbacks are appended to preserve the algebraic block
    // layout.  Production CPU/GPU lanes poll cancellation from PETSc KSP
    // iterations and publish the same progress JSON as the public ABI.
    void *cancel_user_data = nullptr;
    int (*cancel_requested)(void *user_data) = nullptr;
    void *progress_user_data = nullptr;
    void (*progress_callback)(void *user_data, const char *progress_json) = nullptr;
    // Optional one-based frequency-window location carried through nested
    // shift-invert callbacks. Zero counts mean a nearest-frequency solve.
    const char *progress_window_phase = nullptr;
    std::uint32_t progress_current_subwindow = 0;
    std::uint32_t progress_total_subwindows = 0;
    double progress_subwindow_elapsed_seconds = 0.0;
    double progress_window_elapsed_seconds = 0.0;
};

inline bool poisson_airbox_modal_cancel_requested(
    const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    return problem.cancel_requested != nullptr &&
        problem.cancel_requested(problem.cancel_user_data) != 0;
}

inline void poisson_airbox_modal_emit_progress(
    const PoissonAirboxEigenBlockProblem &problem,
    const char *solver_phase,
    const char *execution_lane,
    std::uint32_t outer_iteration,
    std::uint32_t candidate_mode_count,
    std::uint32_t accepted_mode_count,
    std::uint32_t linear_iteration,
    double residual_relative,
    const char *stop_reason = nullptr) noexcept
{
    if (problem.progress_callback == nullptr) {
        return;
    }
    char progress_json[1024]{};
    const int written = std::snprintf(
        progress_json,
        sizeof(progress_json),
        "{\"schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_phase\":\"%s\","
        "\"execution_lane\":\"%s\","
        "\"candidate_mode_count\":%u,"
        "\"accepted_mode_count\":%u,"
        "\"outer_iteration\":%u,"
        "\"max_outer_iterations\":%u,"
        "\"linear_iteration\":%u,"
        "\"max_linear_iterations\":%u,"
        "\"current_residual_relative_l2\":%.17g,"
        "\"target_residual_relative_l2\":%.17g,"
        "\"window_phase\":%s,"
        "\"current_subwindow\":%u,"
        "\"total_subwindows\":%u,"
        "\"subwindow_elapsed_seconds\":%.17g,"
        "\"window_elapsed_seconds\":%.17g,"
        "\"partial_artifacts_available\":false,"
        "\"latest_artifact_manifest_path\":\"\","
        "\"stop_reason\":%s}",
        solver_phase != nullptr ? solver_phase : "solving_shift_invert",
        execution_lane != nullptr ? execution_lane : "production_cpu",
        candidate_mode_count,
        accepted_mode_count,
        outer_iteration,
        problem.max_outer_iterations,
        linear_iteration,
        problem.max_linear_iterations,
        residual_relative,
        problem.residual_tolerance,
        problem.progress_window_phase != nullptr
            ? (std::strcmp(problem.progress_window_phase, "base") == 0
                   ? "\"base\""
                   : "\"refinement\"")
            : "null",
        problem.progress_current_subwindow,
        problem.progress_total_subwindows,
        problem.progress_subwindow_elapsed_seconds,
        problem.progress_window_elapsed_seconds,
        stop_reason != nullptr ? "\"cancel_requested\"" : "null");
    if (written > 0 && static_cast<std::size_t>(written) < sizeof(progress_json)) {
        problem.progress_callback(problem.progress_user_data, progress_json);
    }
}

struct PoissonAirboxModalEigenResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_dof_count = 0;
    std::uint64_t magnetic_pair_count = 0;
    std::uint64_t airbox_pair_count = 0;

    std::uint32_t converged_eigenpair_count = 0;
    std::uint32_t finite_real_eigenpair_count = 0;
    std::uint32_t positive_frequency_eigenpair_count = 0;
    std::uint32_t action_residual_evaluated_count = 0;
    std::uint32_t action_residual_evaluation_failed_count = 0;
    std::uint32_t q_vector_extraction_failed_count = 0;
    std::uint32_t full_vector_reconstruction_failed_count = 0;
    std::uint32_t full_vector_nonfinite_count = 0;
    std::uint32_t reconstructed_mode_count = 0;
    std::uint32_t full_residual_evaluation_failed_count = 0;
    std::uint32_t full_residual_rejected_count = 0;
    std::uint32_t full_residual_accepted_count = 0;
    // Post-EPS correction telemetry. These counters explain whether a
    // positive Ritz pair was actually refined before the original descriptor
    // residual was evaluated; they do not change the acceptance gate.
    std::uint32_t refinement_attempted_count = 0;
    std::uint32_t refinement_succeeded_count = 0;
    std::uint32_t refinement_failed_count = 0;
    std::uint32_t accepted_mode_count = 0;
    std::uint32_t selected_eigenpair_index = 0;
    std::uint32_t outer_iterations = 0;

    // Bounded classification of the raw real-scalar SLEPc Ritz values.  This
    // is diagnostic evidence for the rotated-pencil convention and does not
    // alter the production acceptance filter.
    std::uint32_t raw_ritz_retrieval_failed_count = 0;
    std::uint32_t raw_ritz_nonfinite_count = 0;
    std::uint32_t raw_ritz_finite_count = 0;
    std::uint32_t raw_ritz_complex_rejected_count = 0;
    std::uint32_t raw_ritz_real_axis_count = 0;
    std::uint32_t raw_ritz_positive_count = 0;
    std::uint32_t raw_ritz_negative_count = 0;
    std::uint32_t raw_ritz_zero_count = 0;
    std::uint32_t raw_ritz_in_window_count = 0;
    std::uint32_t raw_ritz_out_of_window_count = 0;
    std::uint32_t operator_context_setup_count = 0;
    std::uint32_t poisson_factorization_setup_count = 0;
    std::uint32_t shift_solver_setup_count = 0;
    std::uint64_t refinement_linear_iteration_count = 0;
    int refinement_last_ksp_reason_code = 0;

    double eigenvalue_real = 0.0;
    double eigenvalue_imag = 0.0;
    double omega_rad_s = 0.0;
    double frequency_hz = 0.0;
    double eigen_residual_relative = 0.0;
    double full_residual_reconstruction_relative_error = 0.0;
    double slepc_reported_backward_error = 0.0;
    double reconstructed_full_descriptor_backward_error = 0.0;
    double reconstruction_vs_slepc_ratio = 0.0;
    double magnetic_block_backward_error = 0.0;
    double poisson_block_backward_error = 0.0;
    double gauge_constraint_backward_error = 0.0;
    double magnetic_residual_l2 = 0.0;
    double poisson_residual_l2 = 0.0;
    double gauge_residual_abs = 0.0;
    double poisson_constraint_relative_residual = 0.0;
    double gauge_mean_abs = 0.0;
    double refinement_final_action_residual = 0.0;
    double expected_reference_frequency_hz = 0.0;
    double relative_reference_frequency_error = 0.0;
    double descriptor_mass_norm = 0.0;
    double descriptor_operator_norm = 0.0;
    double angular_frequency_scale = 1.0;
    double mass_scale = 1.0;
    double operator_scale = 1.0;
    double target_eigenvalue_scaled = 0.0;

    // The Schur operator remains a MatShell.  This records only the bounded
    // shifted-system preconditioner selected for the outer SLEPc transform.
    char shifted_preconditioner_kind[64]{};
    char operator_context_scope[32]{};
    char raw_ritz_classification_json[2048]{};
    // Exact provenance for every shift executed by a frequency-window solve.
    // Kept separate so the common diagnostics writer can embed it verbatim.
    // Two-pass production windows currently execute 16 base plus 34 refined
    // shifts. Each entry embeds bounded raw-Ritz evidence, so 64 KiB can
    // truncate an otherwise complete certificate. Keep enough fixed storage
    // for the full fail-closed schedule without allocating across the native
    // result boundary.
    char executed_subwindows_json[262144]{};
    // Stable solver/window outcome fields.  These are native diagnostics, not
    // part of the public C ABI request/result layout.
    char slepc_converged_reason[64]{};
    int slepc_converged_reason_code = 0;
    char stop_reason[96]{};
    std::uint32_t window_subwindow_count = 0;
    std::uint32_t window_completed_subwindow_count = 0;
    std::uint32_t window_failed_subwindow_count = 0;
    std::uint32_t window_empty_subwindow_count = 0;
    char window_certificate_json[8192]{};
    // The GPU Schur/KSP context is cached by an exact content signature of
    // the coupled CSR blocks and numerical tolerances.  This distinguishes a
    // real reuse from the legacy per-call allocation path.
    bool operator_context_reused = false;
    char operator_context_signature[32]{};

    // Logical host/device transfer counts for the modal solve.  These are
    // measured at the native block/vector boundaries and are copied into the
    // diagnostics resource; they are not estimates supplied by the runner.
    std::uint64_t setup_h2d_transfer_count = 0;
    std::uint64_t final_d2h_transfer_count = 0;
    // The persistent PETSc/SLEPc adapter allocates its operator, Krylov,
    // Poisson, and residual workspaces before entering the repeated modal
    // action loop.  This counter is the explicit native-loop allocation
    // telemetry; it must remain zero for the production device lane.
    std::uint64_t hot_loop_allocations = 0;
    std::uint64_t hot_loop_h2d_bytes = 0;
    std::uint64_t hot_loop_d2h_bytes = 0;

    // GPU PETSc/SLEPc execution telemetry.  These fields are populated only
    // by the GPU adapters; zero/false means that the corresponding native
    // measurement was not available, not that the operation did not occur.
    std::uint64_t operator_apply_count = 0;
    std::uint64_t poisson_solve_count = 0;
    std::uint64_t poisson_iteration_count = 0;
    std::uint64_t shift_linear_iteration_count = 0;
    std::uint32_t eps_monitor_iteration_count = 0;
    std::int32_t eps_converged_reason = 0;
    bool eps_reason_available = false;
    bool eps_cancellation_observed = false;
    bool persistent_context_verified = false;
    bool device_residency_verified = false;
    bool hypre_device_policy_observed = false;
    bool hypre_device_policy_configured = false;
    bool hypre_memory_location_device = false;
    bool hypre_execution_policy_device = false;
    bool hypre_vendor_sptrans_enabled = false;
    bool hypre_vendor_spmv_enabled = false;
    bool hypre_vendor_spgemm_enabled = false;
    int hypre_first_error_code = 0;
    char hypre_failure_reason[96]{};
    bool hot_loop_telemetry_measured = false;
    bool window_complete = false;
    bool window_failed_subwindow = false;
    bool window_cancelled = false;
    char eps_stop_reason[64]{};

    bool gauge_augmented = false;
    bool q_layout_interleaved_node_component = false;
    bool positive_frequency_branch_found = false;
    bool full_residual_certified = false;
    bool reference_frequency_certified = false;

    struct AcceptedMode {
        std::uint32_t eigenpair_index = 0;
        double eigenvalue_real = 0.0;
        double eigenvalue_imag = 0.0;
        double omega_rad_s = 0.0;
        // The backend-reported SLEPc error is diagnostic only.  The public
        // relative_residual below is always the reconstructed full descriptor
        // residual certified against the original coupled blocks.
        double slepc_reported_backward_error = 0.0;
        double frequency_hz = 0.0;
        double relative_residual = 0.0;
        double full_residual_reconstruction_relative_error = 0.0;
        double magnetic_block_backward_error = 0.0;
        double poisson_block_backward_error = 0.0;
        double gauge_constraint_backward_error = 0.0;
        double magnetic_residual_l2 = 0.0;
        double poisson_residual_l2 = 0.0;
        double gauge_residual_abs = 0.0;
        double gauge_mean_abs = 0.0;
        std::vector<std::complex<double>> full_vector{};
    };
    std::vector<AcceptedMode> accepted_modes{};

    // The top-level diagnostics embed executed_subwindows_json verbatim.
    char diagnostics_json[524288]{};
};

struct PoissonAirboxModalResidualMetrics {
    double slepc_reported_backward_error = 0.0;
    double reconstructed_full_descriptor_backward_error = 0.0;
    double reconstruction_vs_slepc_ratio = 0.0;
    double magnetic_block_backward_error = 0.0;
    double poisson_block_backward_error = 0.0;
    double gauge_constraint_backward_error = 0.0;
    double gauge_mean_abs = 0.0;
    // Original, unscaled block norms retained for scientific diagnostics. The
    // relative fields above are the acceptance quantities.
    double magnetic_residual_l2 = 0.0;
    double poisson_residual_l2 = 0.0;
    double gauge_residual_abs = 0.0;
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

FrequencyDomainStatus evaluate_poisson_airbox_modal_residuals(
    const PoissonAirboxEigenBlockProblem &problem,
    const double *full_vector_real,
    const double *full_vector_imag,
    std::uint64_t full_vector_count,
    double lambda_real,
    double lambda_imag,
    double slepc_reported_backward_error,
    PoissonAirboxModalResidualMetrics *out_metrics) noexcept;

FrequencyDomainStatus apply_poisson_airbox_modal_residual_certification(
    const PoissonAirboxModalResidualMetrics &metrics,
    double residual_tolerance,
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
