#include "frequency_domain/floquet_dynamic_demag_k.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"

#include "cpu/frequency_domain/contour_interval_solver.hpp"
#include "cpu/frequency_domain/mode_deduplication.hpp"
#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"
#include "cpu/frequency_domain/slepc_modal_eigen.hpp"
#include "cpu/frequency_domain/spectral_transform.hpp"
#include "cpu/frequency_domain/window_partition.hpp"
#include "frequency_domain/mode_kinematics.hpp"
#include "frequency_domain/solver_progress.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <utility>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kWindowDedupFrequencyRelativeTolerance = 1.0e-8;
constexpr double kWindowDedupFrequencyAbsoluteToleranceHz = 1.0e-12;
constexpr double kWindowDedupOverlapThreshold = 0.90;
constexpr const char *kNativeFloquetCountCertificateUnavailableReason =
    "native_floquet_count_certificate_unavailable";

bool dynamic_demag_k_payload_is_declared(const ModalEigenRequest &) noexcept;
bool dynamic_demag_k_payload_is_consistent(const ModalEigenRequest &) noexcept;
bool modal_request_is_nonzero_k_floquet(const ModalEigenRequest &) noexcept;
bool effective_dense_stiffness_for_request(
    const ModalEigenRequest &,
    std::vector<double> &,
    const double **) noexcept;

std::string escape_json_string(const char *value)
{
    if (value == nullptr) {
        return "";
    }
    std::string escaped;
    for (const char *it = value; *it != '\0'; ++it) {
        switch (*it) {
        case '\\':
            escaped += "\\\\";
            break;
        case '"':
            escaped += "\\\"";
            break;
        case '\n':
            escaped += "\\n";
            break;
        case '\r':
            escaped += "\\r";
            break;
        case '\t':
            escaped += "\\t";
            break;
        default:
            escaped += *it;
            break;
        }
    }
    return escaped;
}

std::string with_operator_diagnostics(
    std::string diagnostics_json,
    const char *operator_diagnostics_json)
{
    if (operator_diagnostics_json == nullptr || operator_diagnostics_json[0] == '\0') {
        return diagnostics_json;
    }
    if (diagnostics_json.empty() || diagnostics_json.back() != '}') {
        return diagnostics_json;
    }
    diagnostics_json.pop_back();
    diagnostics_json += ",\"operator_diagnostics\":";
    if (operator_diagnostics_json[0] == '{' || operator_diagnostics_json[0] == '[') {
        diagnostics_json += operator_diagnostics_json;
    } else {
        diagnostics_json += "\"";
        diagnostics_json += escape_json_string(operator_diagnostics_json);
        diagnostics_json += "\"";
    }
    diagnostics_json += "}";
    return diagnostics_json;
}

std::string format_double(double value) noexcept
{
    // JSON has no NaN/Infinity literals.  A failed or incomplete native
    // solve may leave a diagnostic scalar non-finite; publish null so the
    // runner can parse the envelope and reject the result through its
    // finite-value/certification gates instead of failing on malformed JSON.
    if (!std::isfinite(value)) {
        return "null";
    }
    char buffer[64]{};
    const int written = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        return "0";
    }
    return buffer;
}

std::string floquet_shifted_ksp_configuration_json_field(
    const SLEPcTinyGyrotropicModalEigenResult &result)
{
    if (!result.shifted_ksp_configuration_before_eps_available) {
        return "\"shifted_ksp_configuration_before_eps\":null";
    }
    return std::string("\"shifted_ksp_configuration_before_eps\":{") +
        "\"phase\":\"before_eps_solve\",\"pc_side\":" +
        std::to_string(result.shifted_ksp_pc_side_before_eps) +
        ",\"norm_type\":" +
        std::to_string(result.shifted_ksp_norm_type_before_eps) + "}";
}

// Serialize cached measurements only: a hard EPSSolve error can invalidate
// the PETSc object graph, so publication must never query solver handles.
std::string floquet_shifted_ksp_diagnostics_json_fields(
    const SLEPcTinyGyrotropicModalEigenResult &result,
    bool include_basic_fields)
{
    if (result.solver_adapter == nullptr ||
        std::strcmp(result.solver_adapter, "floquet_airbox_cpu_schur_slepc") != 0) {
        return "";
    }
    std::string json =
        "\"ksp_diagnostics_available\":" +
        std::string(result.ksp_diagnostics_available ? "true" : "false") +
        "," + floquet_shifted_ksp_configuration_json_field(result) +
        ",\"ksp_monitor_progress\":{"
        "\"schema_version\":\"floquet_shifted_ksp_monitor_progress.v1\","
        "\"phase\":\"during_eps_solve\","
        "\"source\":\"petsc_ksp_monitor\","
        "\"monitor_registered\":" +
        std::string(result.ksp_monitor_registered ? "true" : "false") +
        ",\"available\":" +
        std::string(result.ksp_monitor_observation_count > 0 ? "true" : "false") +
        ",\"observation_count\":" +
        std::to_string(result.ksp_monitor_observation_count) +
        ",\"observation_count_scope\":\"all_shifted_ksp_monitor_callbacks_during_one_epsolve\""
        ",\"last_iteration_available\":" +
        std::string(result.ksp_monitor_last_iteration_available ? "true" : "false") +
        ",\"last_iteration\":" +
        (result.ksp_monitor_last_iteration_available
            ? std::to_string(result.ksp_monitor_last_iteration)
            : std::string("null")) +
        ",\"recursive_residual_available\":" +
        std::string(result.ksp_monitor_recursive_residual_available
            ? "true" : "false") +
        ",\"recursive_residual_norm\":" +
        (result.ksp_monitor_recursive_residual_available
            ? format_double(result.ksp_monitor_recursive_residual_norm)
            : std::string("null")) +
        ",\"recursive_residual_semantics\":\"petsc_monitor_recursive_norm_not_true_residual\""
        ",\"last_observed_reason_available\":" +
        std::string(result.ksp_monitor_last_reason_available ? "true" : "false") +
        ",\"last_observed_reason\":" +
        (result.ksp_monitor_last_reason_available
            ? std::to_string(result.ksp_monitor_last_observed_reason)
            : std::string("null")) +
        ",\"last_observed_reason_is_final\":false}" +
        ",\"ksp_true_residual_criterion\":{"
        "\"schema_version\":\"floquet_shifted_ksp_true_residual_criterion.v1\","
        "\"reference_norm\":\"rhs_norm_zero_initial_guess\","
        "\"solve_count\":" + std::to_string(result.ksp_true_criterion_solve_count) +
        ",\"measured_count\":" + std::to_string(result.ksp_true_criterion_measured_count) +
        ",\"violation_count\":" + std::to_string(result.ksp_true_criterion_violation_count) +
        ",\"unavailable_count\":" + std::to_string(result.ksp_true_criterion_unavailable_count) +
        ",\"maximum_tolerance_ratio\":" + format_double(result.ksp_true_criterion_maximum_tolerance_ratio) +
        "},\"ksp_last_iterations\":" +
        std::to_string(result.ksp_last_iterations) +
        ",\"ksp_last_true_residual_available\":" +
        std::string(result.ksp_last_true_residual_available
            ? "true" : "false") +
        ",\"ksp_last_true_residual_norm\":" +
        format_double(result.ksp_last_true_residual_norm) +
        ",\"ksp_last_rhs_norm\":" +
        format_double(result.ksp_last_rhs_norm) +
        ",\"ksp_last_true_relative_residual\":" +
        format_double(result.ksp_last_true_relative_residual) +
        ",\"ksp_true_residual_sample_count\":" +
        std::to_string(result.ksp_true_residual_sample_count) +
        ",\"ksp_true_residual_measurement_failure_count\":" +
        std::to_string(result.ksp_true_residual_measurement_failure_count) +
        ",\"ksp_max_true_relative_residual\":" +
        format_double(result.ksp_max_true_relative_residual) +
        ",\"ksp_pc_side\":" +
        (result.ksp_last_true_residual_available
            ? std::to_string(result.ksp_pc_side)
            : std::string("null")) +
        ",\"ksp_norm_type\":" +
        (result.ksp_last_true_residual_available
            ? std::to_string(result.ksp_norm_type)
            : std::string("null")) +
        ",\"ksp_converged_reason\":" +
        (result.ksp_converged_reason_available
            ? std::to_string(result.ksp_converged_reason)
            : std::string("null")) +
        ",\"ksp_residual_norm_semantics\":\"petsc_configured_norm_from_last_shift_invert_solve\"" +
        ",\"eps_converged_reason\":" +
        (result.eps_converged_reason_available
            ? std::to_string(result.eps_converged_reason)
            : std::string("null")) +
        ",\"eps_dimensions_available\":" +
        std::string(result.eps_dimensions_available ? "true" : "false") +
        ",\"eps_nev\":" +
        (result.eps_dimensions_available
            ? std::to_string(result.eps_nev)
            : std::string("null")) +
        ",\"eps_ncv\":" +
        (result.eps_dimensions_available
            ? std::to_string(result.eps_ncv)
            : std::string("null")) +
        ",\"eps_mpd\":" +
        (result.eps_dimensions_available && result.eps_mpd > 0
            ? std::to_string(result.eps_mpd)
            : std::string("null"));
    json +=
        ",\"floquet_eps_nev_refill\":{"
        "\"schema_version\":\"floquet_eps_nev_refill.v1\","
        "\"attempt_count\":" + std::to_string(result.eps_attempt_count) +
        ",\"solved_attempt_count\":" +
        std::to_string(result.eps_solved_attempt_count) +
        ",\"initial_nev\":" +
        (result.eps_initial_nev > 0
            ? std::to_string(result.eps_initial_nev)
            : std::string("null")) +
        ",\"last_solved_nev\":" +
        (result.eps_dimensions_available
            ? std::to_string(result.eps_nev)
            : std::string("null")) +
        ",\"last_finalized_attempt\":" +
        (result.eps_finalized_attempt_number > 0
            ? std::to_string(result.eps_finalized_attempt_number)
            : std::string("null")) +
        ",\"last_finalized_nev\":" +
        (result.eps_finalized_nev > 0
            ? std::to_string(result.eps_finalized_nev)
            : std::string("null")) +
        ",\"unique_certified_mode_count\":" +
        std::to_string(result.eps_unique_certified_mode_count) +
        ",\"iteration_budget_available\":" +
        std::string(result.eps_iteration_budget_available ? "true" : "false") +
        ",\"outer_iteration_budget_exhausted\":" +
        std::string(result.eps_outer_iteration_budget_exhausted ? "true" : "false") +
        ",\"outer_iteration_budget\":" +
        (result.eps_iteration_budget_available
            ? std::to_string(result.max_outer_iterations)
            : std::string("null")) +
        ",\"cumulative_outer_iterations_available\":" +
        std::string(result.eps_cumulative_iterations_available ? "true" : "false") +
        ",\"cumulative_outer_iterations\":" +
        (result.eps_cumulative_iterations_available
            ? std::to_string(result.outer_iterations)
            : std::string("null")) +
        ",\"cancellation_observed\":" +
        std::string(result.eps_cancellation_observed ? "true" : "false") + "}";
    json +=
        ",\"eps_monitor_iteration_scope\":\"last_actual_eps_attempt\"";
    if (result.unsupported_reason != nullptr &&
        std::strcmp(
            result.unsupported_reason,
            "floquet_slepc_solve_failed") == 0) {
        const auto &probe = result.shifted_ksp_failure_probe;
        json +=
            ",\"shifted_ksp_failure_probe\":{"
            "\"schema_version\":\"shifted_ksp_failure_probe.v1\","
            "\"scope\":\"internal_shifted_linear_system_not_original_descriptor\","
            "\"eps_dimension_semantics\":\"arguments_passed_to_EPSSetDimensions_not_resolved_dimensions\","
            "\"eps_attempt_number\":" +
            (probe.eps_attempt_number > 0
                ? std::to_string(probe.eps_attempt_number)
                : std::string("null")) +
            ",\"eps_dimension_arguments_available\":" +
            std::string(probe.eps_dimension_arguments_available ? "true" : "false") +
            ",\"eps_nev_argument\":" +
            (probe.eps_dimension_arguments_available
                ? std::to_string(probe.eps_nev_argument)
                : std::string("null")) +
            ",\"eps_ncv_argument\":" +
            (probe.eps_dimension_arguments_available
                ? std::to_string(probe.eps_ncv_argument)
                : std::string("null")) +
            ",\"callback_observation_available\":" +
            std::string(probe.callback_observation_available ? "true" : "false") +
            ",\"callback_count\":" + std::to_string(probe.callback_count) +
            ",\"callback_count_scope\":\"registered_callbacks_during_this_eps_attempt\""
            ",\"last_callback_iteration\":" +
            (probe.callback_count > 0
                ? std::to_string(probe.last_callback_iteration)
                : std::string("null")) +
            ",\"last_recursive_residual_available\":" +
            std::string(probe.last_recursive_residual_available ? "true" : "false") +
            ",\"last_recursive_residual_norm\":" +
            (probe.last_recursive_residual_available
                ? format_double(probe.last_recursive_residual_norm)
                : std::string("null")) +
            ",\"last_default_reason_available\":" +
            std::string(probe.last_default_reason_available ? "true" : "false") +
            ",\"last_default_reason\":" +
            (probe.last_default_reason_available
                ? std::to_string(probe.last_default_reason)
                : std::string("null")) +
            ",\"last_reason_after_gate_available\":" +
            std::string(probe.last_reason_after_gate_available ? "true" : "false") +
            ",\"last_reason_after_gate\":" +
            (probe.last_reason_after_gate_available
                ? std::to_string(probe.last_reason_after_gate)
                : std::string("null")) +
            ",\"true_probe_attempt_count\":" +
            std::to_string(probe.true_probe_attempt_count) +
            ",\"true_probe_attempt_count_scope\":\"positive_default_reason_callbacks_during_this_eps_attempt\""
            ",\"true_probe_count\":" +
            std::to_string(probe.true_probe_count) +
            ",\"true_probe_count_scope\":\"completed_true_gate_measurements_during_this_eps_attempt\""
            ",\"true_probe_measurement_failure_count\":" +
            std::to_string(probe.true_probe_measurement_failure_count) +
            ",\"last_true_probe\":{"
            "\"available\":" +
            std::string(probe.last_true_probe_available ? "true" : "false") +
            ",\"callback_ordinal\":" +
            (probe.true_probe_attempt_count > 0
                ? std::to_string(probe.last_true_probe_callback_ordinal)
                : std::string("null")) +
            ",\"iteration\":" +
            (probe.true_probe_attempt_count > 0
                ? std::to_string(probe.last_true_probe_iteration)
                : std::string("null")) +
            ",\"recursive_residual_available\":" +
            std::string(probe.last_true_probe_recursive_residual_available
                ? "true" : "false") +
            ",\"recursive_residual_norm\":" +
            (probe.last_true_probe_recursive_residual_available
                ? format_double(probe.last_true_probe_recursive_residual_norm)
                : std::string("null")) +
            ",\"default_reason_available\":" +
            std::string(probe.last_true_probe_default_reason_available
                ? "true" : "false") +
            ",\"default_reason\":" +
            (probe.last_true_probe_default_reason_available
                ? std::to_string(probe.last_true_probe_default_reason)
                : std::string("null")) +
            ",\"reason_after_gate_available\":" +
            std::string(probe.last_true_probe_reason_after_gate_available
                ? "true" : "false") +
            ",\"reason_after_gate\":" +
            (probe.last_true_probe_reason_after_gate_available
                ? std::to_string(probe.last_true_probe_reason_after_gate)
                : std::string("null")) +
            ",\"rhs_l2_norm\":" +
            (probe.last_true_probe_available
                ? format_double(probe.last_true_rhs_norm)
                : std::string("null")) +
            ",\"true_residual_l2_norm\":" +
            (probe.last_true_probe_available
                ? format_double(probe.last_true_residual_norm)
                : std::string("null")) +
            ",\"rtol\":" +
            (probe.true_probe_attempt_count > 0
                ? format_double(probe.last_true_rtol)
                : std::string("null")) +
            ",\"atol\":" +
            (probe.true_probe_attempt_count > 0
                ? format_double(probe.last_true_atol)
                : std::string("null")) +
            ",\"threshold_l2_norm\":" +
            (probe.last_true_probe_available
                ? format_double(probe.last_true_residual_threshold)
                : std::string("null")) +
            ",\"tolerance_ratio_available\":" +
            std::string(probe.last_true_tolerance_ratio_available
                ? "true" : "false") +
            ",\"true_residual_to_threshold_ratio\":" +
            (probe.last_true_tolerance_ratio_available
                ? format_double(probe.last_true_tolerance_ratio)
                : std::string("null")) + "}}";
    }
    // Sparse nearest success already publishes these configuration fields.
    // Window and nearest failure need them here; emit each key exactly once.
    if (include_basic_fields) {
        json +=
            ",\"ksp_type\":\"" + std::string(result.ksp_type) +
            "\",\"ksp_rtol\":" + format_double(result.ksp_rtol) +
            ",\"ksp_atol\":" + format_double(result.ksp_atol) +
            ",\"ksp_final_residual\":" +
            format_double(result.ksp_final_residual);
    }
    return json;
}

std::string floquet_demag_operator_probe_json_field(
    const FloquetDemagOperatorProbeResult &probe)
{
    if (!probe.requested) {
        return {};
    }
    const auto sample_json = [](const char *direction,
                                const FloquetDemagOperatorProbeSample &sample) {
        return "\"" + std::string(direction) + "\":{"
            "\"attempted\":" + (sample.attempted ? "true" : "false") +
            ",\"passed\":" + (sample.passed ? "true" : "false") +
            ",\"q_l2_norm\":" + format_double(sample.q_l2_norm) +
            ",\"potential_relative_residual\":" +
            format_double(sample.potential_relative_residual) +
            ",\"self_energy_j\":" + format_double(sample.self_energy_j) +
            ",\"potential_energy_j\":" +
            format_double(sample.potential_energy_j) +
            ",\"energy_form_relative_defect\":" +
            format_double(sample.energy_form_relative_defect) + "}";
    };
    const char *status = probe.passed
        ? "passed"
        : probe.available ? "failed" : "not_observable";
    return "\"dynamic_demag_operator_probe\":{"
        "\"schema_version\":\"floquet_dynamic_demag_operator_probe.v1\","
        "\"status\":\"" + std::string(status) + "\","
        "\"potential_equation\":\"P_phi_plus_A_phiq_q_equals_zero\","
        "\"potential_coefficient_unit\":\"A\","
        "\"energy_unit\":\"J\","
        "\"relative_tolerance\":1e-8,"
        "\"field_reconstruction\":\"not_included_in_this_probe\","
        "\"hermitian_relative_defect\":" +
        format_double(probe.hermitian_relative_defect) + "," +
        sample_json("global_y", probe.global_y) + "," +
        sample_json("global_z", probe.global_z) + "}";
}

std::string floquet_dense_oracle_json_field(
    const FloquetDenseOracleDiagnostics &oracle)
{
    if (!oracle.requested) {
        return "\"floquet_dense_oracle\":null";
    }
    return std::string("\"floquet_dense_oracle\":{") +
        "\"schema_version\":\"floquet_dense_original_schur_oracle.v1\"," +
        "\"status\":\"" + std::string(oracle.status != nullptr ? oracle.status : "unknown") +
        "\",\"reason\":\"" + std::string(oracle.reason != nullptr ? oracle.reason : "") +
        "\",\"available\":" + std::string(oracle.available ? "true" : "false") +
        ",\"candidate_found\":" + std::string(oracle.candidate_found ? "true" : "false") +
        ",\"action_match\":" + std::string(oracle.action_match ? "true" : "false") +
        ",\"st_type\":\"" +
        std::string(oracle.st_shift_zero ? "shift" : "unverified") +
        "\",\"st_shift\":" +
        std::string(oracle.st_shift_zero ? "0" : "null") +
        ",\"eps_type\":\"" + std::string(oracle.eps_type) +
        "\",\"problem_type\":\"" + std::string(oracle.problem_type) +
        "\",\"spectral_transform\":\"" +
        std::string(oracle.spectral_transform) +
        "\",\"q_complex_dof_count\":" + std::to_string(oracle.q_complex_dof_count) +
        ",\"phi_dof_count\":" + std::to_string(oracle.phi_dof_count) +
        ",\"real_split_dimension\":" + std::to_string(oracle.real_split_dimension) +
        ",\"eps_converged_count\":" + std::to_string(oracle.eps_converged_count) +
        ",\"eps_converged_reason\":" +
        (oracle.eps_converged_reason_available
             ? std::to_string(oracle.eps_converged_reason)
             : std::string("null")) +
        ",\"action_probe_count\":" + std::to_string(oracle.action_probe_count) +
        ",\"operator_normalization_scale\":" +
        format_double(oracle.operator_normalization_scale) +
        ",\"action_relative_error_max\":" +
        format_double(oracle.action_relative_error_max) +
        ",\"poisson_relative_residual_max\":" +
        format_double(oracle.poisson_relative_residual_max) +
        ",\"eps_absolute_residual\":" +
        format_double(oracle.eps_absolute_residual) +
        ",\"rotated_omega_rad_s\":" +
        format_double(oracle.rotated_omega_rad_s) +
        ",\"rotated_imaginary_rad_s\":" +
        format_double(oracle.rotated_imaginary_rad_s) +
        ",\"frequency_hz\":" + format_double(oracle.frequency_hz) +
        ",\"frequency_distance_hz\":" +
        format_double(oracle.frequency_distance_hz) +
        ",\"raw_lambda_real_per_s\":" +
        format_double(oracle.raw_lambda_real_per_s) +
        ",\"raw_lambda_imag_rad_per_s\":" +
        format_double(oracle.raw_lambda_imag_rad_per_s) +
        ",\"projected_lambda_real_per_s\":" +
        format_double(oracle.projected_lambda_real_per_s) +
        ",\"projected_lambda_imag_rad_per_s\":" +
        format_double(oracle.projected_lambda_imag_rad_per_s) +
        ",\"magnetic_residual_raw\":" +
        format_double(oracle.magnetic_residual_raw) +
        ",\"magnetic_residual_projected\":" +
        format_double(oracle.magnetic_residual_projected) +
        ",\"potential_residual\":" +
        format_double(oracle.potential_residual) +
        ",\"q_projection_ratio\":" +
        format_double(oracle.q_projection_ratio) + "}";
}

std::string floquet_schur_action_diagnostic_json_field(
    const FloquetSchurActionDiagnostic &diagnostic)
{
    if (!diagnostic.requested) {
        return "\"floquet_schur_action_diagnostic\":null";
    }
    return std::string("\"floquet_schur_action_diagnostic\":{") +
        "\"schema_version\":\"floquet_schur_action_diagnostic.v1\","
        "\"status\":\"" +
        escape_json_string(diagnostic.status != nullptr ? diagnostic.status : "unknown") +
        "\",\"reason\":\"" +
        escape_json_string(diagnostic.reason != nullptr ? diagnostic.reason : "") +
        "\",\"available\":" +
        std::string(diagnostic.available ? "true" : "false") +
        ",\"pre_eps_only\":" +
        std::string(diagnostic.pre_eps_only ? "true" : "false") +
        ",\"dense_materialization\":" +
        std::string(diagnostic.dense_materialization ? "true" : "false") +
        ",\"measurement_phase\":\"" +
        escape_json_string(
            diagnostic.measurement_phase != nullptr
                ? diagnostic.measurement_phase : "unknown") +
        "\",\"workspace_scope\":\"" +
        escape_json_string(
            diagnostic.workspace_scope != nullptr
                ? diagnostic.workspace_scope : "unknown") +
        "\",\"q_complex_dof_count\":" +
        std::to_string(diagnostic.q_complex_dof_count) +
        ",\"real_split_dimension\":" +
        std::to_string(diagnostic.real_split_dimension) +
        ",\"context_phase_sign\":" +
        std::to_string(diagnostic.context_phase_sign) +
        ",\"action_count\":" + std::to_string(diagnostic.action_count) +
        ",\"expected_action_count\":" +
        std::to_string(diagnostic.expected_action_count) +
        ",\"nonzero_signal_count\":" +
        std::to_string(diagnostic.nonzero_signal_count) +
        ",\"operator_normalization_scale\":" +
        format_double(diagnostic.operator_normalization_scale) +
        ",\"preconditioner_normalization_scale\":" +
        format_double(diagnostic.preconditioner_normalization_scale) +
        ",\"max_potential_relative_residual\":" +
        format_double(diagnostic.max_potential_relative_residual) +
        ",\"max_repeatability_relative_defect\":" +
        format_double(diagnostic.max_repeatability_relative_defect) +
        ",\"repeatability_first_relative_defect\":" +
        format_double(diagnostic.repeatability_first_relative_defect) +
        ",\"repeatability_second_relative_defect\":" +
        format_double(diagnostic.repeatability_second_relative_defect) +
        ",\"max_homogeneity_relative_defect\":" +
        format_double(diagnostic.max_homogeneity_relative_defect) +
        ",\"homogeneity_half_relative_defect\":" +
        format_double(diagnostic.homogeneity_half_relative_defect) +
        ",\"homogeneity_double_relative_defect\":" +
        format_double(diagnostic.homogeneity_double_relative_defect) +
        ",\"homogeneity_tiny_relative_defect\":" +
        format_double(diagnostic.homogeneity_tiny_relative_defect) +
        ",\"additivity_relative_defect\":" +
        format_double(diagnostic.additivity_relative_defect) +
        ",\"mat_shell_reconstruction_relative_defect\":" +
        format_double(diagnostic.mat_shell_reconstruction_relative_defect) +
        ",\"min_cancellation_ratio\":" +
        format_double(diagnostic.min_cancellation_ratio) +
        ",\"max_magnetic_l2_norm\":" +
        format_double(diagnostic.max_magnetic_l2_norm) +
        ",\"max_feedback_l2_norm\":" +
        format_double(diagnostic.max_feedback_l2_norm) +
        ",\"max_combined_l2_norm\":" +
        format_double(diagnostic.max_combined_l2_norm) +
        ",\"min_rhs_l2_norm\":" +
        format_double(diagnostic.min_rhs_l2_norm) +
        ",\"max_rhs_l2_norm\":" +
        format_double(diagnostic.max_rhs_l2_norm) + "}";
}

void append_optional_json_field(std::string &json, const std::string &field)
{
    if (field.empty() || json.empty() || json.back() != '}') {
        return;
    }
    json.pop_back();
    if (json.size() > 1u) {
        json += ",";
    }
    json += field;
    json += "}";
}

bool is_nearest_frequency_target(const ModalEigenRequest &request) noexcept
{
    return request.target_kind != nullptr &&
        std::strcmp(request.target_kind, "nearest_frequency") == 0;
}

std::string nearest_frequency_metadata_json(
    const ModalEigenRequest &request,
    bool solve_complete)
{
    if (!is_nearest_frequency_target(request)) {
        return {};
    }
    return "\"target_kind\":\"nearest_frequency\","
        "\"target_frequency_hz\":" +
        format_double(request.target_frequency_hz) +
        ",\"spectrum_completeness\":\"selected_only\","
        "\"window_complete\":false,"
        "\"solve_complete\":" +
        std::string(solve_complete ? "true" : "false");
}

void append_nearest_frequency_metadata(
    std::string &json,
    const ModalEigenRequest &request,
    FrequencyDomainStatus status)
{
    append_optional_json_field(
        json,
        nearest_frequency_metadata_json(
            request,
            status == FrequencyDomainStatus::ok));
}

std::string mode_kinematics_json_fields(ComplexEigenvalue lambda)
{
    const ModeKinematics kinematics = map_eigenvalue(
        lambda,
        FrequencyDomainPhaseConvention::exp_i_omega_t);
    return
        "\"frequency_hz\":" + format_double(kinematics.frequency_hz) +
        ",\"omega_rad_s\":" + format_double(kinematics.omega_rad_s) +
        ",\"eigenvalue_real\":" + format_double(kinematics.lambda.real_per_s) +
        ",\"eigenvalue_imag\":" + format_double(kinematics.lambda.imag_rad_per_s) +
        ",\"lambda_real_per_s\":" + format_double(kinematics.lambda.real_per_s) +
        ",\"lambda_imag_rad_per_s\":" + format_double(kinematics.lambda.imag_rad_per_s) +
        ",\"decay_rate_per_s\":" + format_double(kinematics.decay_rate_per_s) +
        ",\"branch_sign\":" + std::to_string(kinematics.branch_sign) +
        ",\"stable\":" + std::string(kinematics.stable ? "true" : "false");
}

std::string operator_k_vector_diagnostics_json(const ModalEigenRequest &request)
{
    const double *k_vector = request.operator_request.k_vector_rad_m;
    int k_vector_len = request.operator_request.k_vector_len;
    if ((k_vector == nullptr || k_vector_len <= 0) &&
        request.has_floquet_k_vector) {
        k_vector = request.floquet_k_vector_rad_per_m;
        k_vector_len = 3;
    }
    if (k_vector == nullptr || k_vector_len <= 0) {
        return "";
    }
    std::string json =
        ",\"k_vector_len\":" +
        std::to_string(k_vector_len) +
        ",\"k_vector_rad_m\":[";
    for (int index = 0; index < k_vector_len; ++index) {
        if (index != 0) {
            json += ",";
        }
        json += format_double(k_vector[index]);
    }
    json += "]";
    return json;
}

std::string modal_floquet_periodic_pair_diagnostics_json(
    const ModalEigenRequest &request)
{
    if (request.floquet_periodic_pair_count == 0) {
        return "";
    }
    return ",\"floquet_periodic_pair_count\":" +
           std::to_string(request.floquet_periodic_pair_count);
}

std::string dynamic_demag_k_diagnostics_json(
    const ModalEigenRequest &request)
{
    if (!dynamic_demag_k_payload_is_declared(request)) {
        return "";
    }
    return ",\"dynamic_demag_k_operator\":{\"payload_kind\":\"dense_real_split_tangent_matrix\",\"value_count\":" +
        std::to_string(request.dynamic_demag_k_tangent_matrix_value_count) +
        ",\"assembly_owner\":\"caller_supplied_preassembled\"}";
}

std::string with_modal_request_diagnostics(
    std::string diagnostics_json,
    const ModalEigenRequest &request,
    FrequencyDomainStatus status)
{
    if (!diagnostics_json.empty() && diagnostics_json.back() == '}') {
        diagnostics_json.pop_back();
        diagnostics_json += operator_k_vector_diagnostics_json(request);
        diagnostics_json += modal_floquet_periodic_pair_diagnostics_json(request);
        diagnostics_json += dynamic_demag_k_diagnostics_json(request);
        const std::string nearest_metadata =
            nearest_frequency_metadata_json(
                request,
                status == FrequencyDomainStatus::ok);
        if (!nearest_metadata.empty()) {
            diagnostics_json += ",";
            diagnostics_json += nearest_metadata;
        }
        if (modal_request_is_nonzero_k_floquet(request)) {
            diagnostics_json += ",\"floquet_modal_solver_model\":\"";
            diagnostics_json += floquet_modal_solver_model();
            diagnostics_json += "\"";
        }
        diagnostics_json += "}";
    }
    return with_operator_diagnostics(
        std::move(diagnostics_json),
        request.operator_request.operator_diagnostics_json);
}

bool modal_request_is_nonzero_k_floquet(const ModalEigenRequest &request) noexcept
{
    const double *k_vector = request.operator_request.k_vector_rad_m;
    int k_vector_len = request.operator_request.k_vector_len;
    if ((k_vector == nullptr || k_vector_len <= 0) &&
        request.has_floquet_k_vector) {
        k_vector = request.floquet_k_vector_rad_per_m;
        k_vector_len = 3;
    }
    if (request.operator_request.spin_wave_bc_kind == nullptr ||
        std::strcmp(request.operator_request.spin_wave_bc_kind, "floquet") != 0 ||
        k_vector == nullptr ||
        k_vector_len <= 0) {
        return false;
    }
    for (int index = 0; index < k_vector_len; ++index) {
        if (std::abs(k_vector[index]) > 0.0) {
            return true;
        }
    }
    return false;
}

bool modal_request_has_bloch_floquet_tangent_operator_payload(
    const ModalEigenRequest &request) noexcept
{
    const char *diagnostics = request.operator_request.operator_diagnostics_json;
    if (request.floquet_periodic_pair_count == 0 || diagnostics == nullptr) {
        return false;
    }
    if (request.floquet_shared_domain_operator != nullptr) {
        return std::strstr(
                   diagnostics,
                   "\"payload_kind\":\"certified_shared_domain\"") != nullptr;
    }
    return std::strstr(
               diagnostics,
               "\"payload_kind\":\"bloch_floquet_tangent_operator\"") != nullptr;
}

const char *modal_request_gated_operator_term(
    const ModalEigenRequest &request) noexcept
{
    const char *diagnostics = request.operator_request.operator_diagnostics_json;
    if (diagnostics == nullptr ||
        std::strstr(diagnostics, "\"operator_terms_included\"") == nullptr) {
        return nullptr;
    }
    if (std::strstr(diagnostics, "\"dynamic_demag\"") != nullptr) {
        // An owned shared-domain operator or an explicit complete, finite
        // dense k-dependent payload proves materialization. Optional-payload
        // consistency alone also accepts absence and is not such a proof.
        if (request.floquet_shared_domain_operator == nullptr &&
            (!dynamic_demag_k_payload_is_declared(request) ||
             !dynamic_demag_k_payload_is_consistent(request))) {
            return "dynamic_demag";
        }
    }
    if (std::strstr(diagnostics, "\"floquet_airbox\"") != nullptr) {
        return "floquet_airbox";
    }
    if (std::strstr(diagnostics, "\"periodic_poisson\"") != nullptr) {
        return "periodic_poisson";
    }
    if (std::strstr(diagnostics, "\"interfacial_dmi\"") != nullptr) {
        return "interfacial_dmi";
    }
    if (std::strstr(diagnostics, "\"bulk_dmi\"") != nullptr) {
        return "bulk_dmi";
    }
    if (std::strstr(diagnostics, "\"dmi\"") != nullptr) {
        return "dmi";
    }
    if (std::strstr(diagnostics, "\"demag\"") != nullptr) {
        return "demag";
    }
    if (std::strstr(diagnostics, "\"magnetoelastic\"") != nullptr) {
        return "magnetoelastic";
    }
    return nullptr;
}

FrequencyDomainContractResult nonzero_k_floquet_modal_operator_missing(
    const ModalEigenRequest &request) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.error_message =
        "native FEM modal_eigen production CPU nonzero-k Floquet operator is not implemented yet";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"solver_adapter_status\":\"unsupported\","
        "\"unsupported_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\","
        "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\","
        "\"production_cpu_rejection_scope\":\"selected_spectrum_nonzero_k_floquet_modal\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\","
        "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"modal_periodic_pair_contract_available\":" +
        std::string(request.floquet_periodic_pair_count > 0 ? "true" : "false") +
        ","
        "\"spectral_transform\":\"shift_invert\","
        "\"phasor_convention\":\"exp_i_omega_t\"}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0,"
        "\"unsupported_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\","
        "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\"}";
    result.result_json = with_modal_request_diagnostics(result.result_json, request, result.status);
    result.artifact_manifest_path.clear();
    return result;
}

FrequencyDomainContractResult nonzero_k_floquet_modal_gated_operator_terms_present(
    const ModalEigenRequest &request,
    const char *gated_operator_term) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.error_message =
        "native FEM modal_eigen production CPU nonzero-k Floquet operator diagnostics include gated production terms";
    const std::string term =
        gated_operator_term == nullptr ? "unknown" : gated_operator_term;
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"solver_adapter_status\":\"unsupported\","
        "\"unsupported_reason\":\"production_cpu_modal_gated_operator_terms_present\","
        "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\","
        "\"production_cpu_rejection_scope\":\"selected_spectrum_nonzero_k_floquet_modal_operator_terms\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_without_gated_terms\","
        "\"gated_operator_term\":\"" +
        escape_json_string(term.c_str()) +
        "\",\"spectral_transform\":\"shift_invert\","
        "\"phasor_convention\":\"exp_i_omega_t\"}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0,"
        "\"unsupported_reason\":\"production_cpu_modal_gated_operator_terms_present\","
        "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_without_gated_terms\","
        "\"gated_operator_term\":\"" +
        escape_json_string(term.c_str()) + "\"}";
    result.result_json = with_modal_request_diagnostics(result.result_json, request, result.status);
    result.artifact_manifest_path.clear();
    return result;
}

FrequencyDomainContractResult nonzero_k_floquet_modal_dynamic_demag_k_missing(
    const ModalEigenRequest &request) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.error_message =
        "native FEM modal_eigen production CPU nonzero-k Floquet dynamic demag-k operator is not implemented yet";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"solver_adapter_status\":\"unsupported\","
        "\"unsupported_reason\":\"production_cpu_modal_dynamic_demag_k_operator_missing\","
        "\"production_cpu_rejection_reason\":\"production_cpu_modal_dynamic_demag_k_operator_missing\","
        "\"production_cpu_rejection_scope\":\"selected_spectrum_nonzero_k_floquet_modal_dynamic_demag\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_dynamic_demag_k\","
        "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"required_demag_payload_kind\":\"dynamic_demag_k_operator\","
        "\"dynamic_demag_operator_source\":\"missing_numeric_fem_demag_k\","
        "\"requested_demag_realization\":\"" +
        escape_json_string(request.operator_request.demag_realization) +
        "\",\"modal_periodic_pair_contract_available\":" +
        std::string(request.floquet_periodic_pair_count > 0 ? "true" : "false") +
        ",\"spectral_transform\":\"shift_invert\","
        "\"phasor_convention\":\"exp_i_omega_t\"}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0,"
        "\"unsupported_reason\":\"production_cpu_modal_dynamic_demag_k_operator_missing\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_dynamic_demag_k\","
        "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"required_demag_payload_kind\":\"dynamic_demag_k_operator\","
        "\"dynamic_demag_operator_source\":\"missing_numeric_fem_demag_k\"}";
    result.result_json = with_modal_request_diagnostics(result.result_json, request, result.status);
    result.artifact_manifest_path.clear();
    return result;
}

std::string format_slepc_modes_json(
    const std::vector<SLEPcModalAcceptedMode> &accepted_modes)
{
    std::string modes = "[";
    for (std::size_t index = 0; index < accepted_modes.size(); ++index) {
        const SLEPcModalAcceptedMode &mode = accepted_modes[index];
        if (index != 0) {
            modes += ",";
        }
        modes +=
            "{\"mode_index\":" + std::to_string(index) +
            ",\"slepc_eigenpair_index\":" +
            std::to_string(mode.eigenpair_index) +
            ",\"positive_frequency_pair_index\":" +
            std::to_string(mode.positive_frequency_pair_index) +
            "," +
            mode_kinematics_json_fields({mode.lambda_real, mode.lambda_imag}) +
            ",\"relative_residual\":" +
            format_double(mode.relative_residual) +
            ",\"discarded_negative_frequency_partner\":true,"
            "\"mode_vector_real\":[";
        for (std::size_t component = 0; component < mode.mode_vector.size(); ++component) {
            if (component != 0) {
                modes += ",";
            }
            modes += format_double(std::real(mode.mode_vector[component]));
        }
        modes += "],\"mode_vector_imag\":[";
        for (std::size_t component = 0; component < mode.mode_vector.size(); ++component) {
            if (component != 0) {
                modes += ",";
            }
            modes += format_double(std::imag(mode.mode_vector[component]));
        }
        modes += "]";
        if (mode.floquet_mode_vector_physical_complex) {
                modes += ",\"q_layout\":\"interleaved_node_component\",\"mode_q_real\":[";
                for (std::size_t component = 0; component < mode.mode_vector.size(); ++component) {
                    if (component != 0) {
                        modes += ",";
                    }
                    modes += format_double(std::real(mode.mode_vector[component]));
                }
                modes += "],\"mode_q_imag\":[";
                for (std::size_t component = 0; component < mode.mode_vector.size(); ++component) {
                    if (component != 0) {
                        modes += ",";
                    }
                    modes += format_double(std::imag(mode.mode_vector[component]));
                }
                modes += "],\"mode_phi_real\":[";
                for (std::size_t component = 0;
                     component < mode.floquet_potential_real_split.size();
                     ++component) {
                    if (component != 0) {
                        modes += ",";
                    }
                    modes += format_double(
                        mode.floquet_potential_real_split[component].real());
                }
                modes += "],\"mode_phi_imag\":[";
                for (std::size_t component = 0;
                     component < mode.floquet_potential_real_split.size();
                     ++component) {
                    if (component != 0) {
                        modes += ",";
                    }
                    modes += format_double(
                        mode.floquet_potential_real_split[component].imag());
                }
                modes += "],\"potential_dof_count\":" +
                    std::to_string(mode.floquet_potential_real_split.size());
        }
        if (mode.floquet_mode_vector_physical_complex) {
            const double reduced_descriptor_residual = std::max(
                mode.floquet_magnetic_residual,
                mode.floquet_potential_residual);
            modes += ",\"floquet_descriptor_certified\":" +
                std::string(mode.floquet_descriptor_certified ? "true" : "false") +
                ",\"floquet_seam_frame_certified\":" +
                std::string(mode.floquet_seam_frame_certified ? "true" : "false") +
                ",\"floquet_gauge_policy_satisfied\":" +
                std::string(mode.floquet_gauge_policy_satisfied ? "true" : "false") +
                ",\"poisson_boundary_kind\":\"" +
                escape_json_string(mode.floquet_poisson_boundary_kind.data()) +
                "\",\"poisson_gauge_policy\":\"" +
                escape_json_string(mode.floquet_poisson_gauge_policy.data()) +
                "\",\"floquet_geometric_bc_certified\":false,"
                "\"floquet_full_descriptor_certified\":" +
                std::string(mode.floquet_descriptor_certified ? "true" : "false") +
                ",\"floquet_certificate_scope\":\"" +
                std::string(mode.floquet_descriptor_certified
                    ? "full_projected_weak_form_and_periodic_seams"
                    : "reduced_original_blocks_only") +
                "\","
                "\"potential_representation\":\"complex_coefficients\","
                "\"magnetic_relative_residual\":" +
                format_double(mode.floquet_magnetic_residual) +
                ",\"potential_relative_residual\":" +
                format_double(mode.floquet_potential_residual) +
                ",\"reduced_magnetic_relative_residual\":" +
                format_double(mode.floquet_magnetic_residual) +
                ",\"reduced_potential_relative_residual\":" +
                format_double(mode.floquet_potential_residual) +
                ",\"reduced_descriptor_relative_residual\":" +
                format_double(reduced_descriptor_residual) +
                ",\"floquet_full_magnetic_relative_residual\":" +
                format_double(mode.floquet_full_magnetic_residual) +
                ",\"floquet_full_potential_relative_residual\":" +
                format_double(mode.floquet_full_potential_residual) +
                ",\"floquet_scalar_phase_seam_relative_residual\":" +
                format_double(mode.floquet_scalar_phase_seam_residual) +
                ",\"floquet_tangent_frame_seam_relative_residual\":" +
                format_double(mode.floquet_tangent_frame_seam_residual) +
                ",\"floquet_cartesian_magnetic_seam_relative_residual\":" +
                format_double(mode.floquet_cartesian_seam_residual) +
                ",\"floquet_equilibrium_pair_relative_residual\":" +
                format_double(mode.floquet_equilibrium_pair_residual) +
                ",\"magnetic_block_backward_error\":" +
                format_double(mode.floquet_magnetic_residual) +
                ",\"poisson_block_backward_error\":" +
                format_double(mode.floquet_potential_residual) +
                ",\"gauge_constraint_backward_error\":null,"
                "\"gauge_constraint_policy\":\"nonzero_k_poisson_without_mean_constraint\","
                "\"reduced_original_block_residuals\":{"
                "\"magnetic\":" +
                format_double(mode.floquet_magnetic_residual) +
                ",\"potential\":" +
                format_double(mode.floquet_potential_residual) +
                ",\"full\":" +
                format_double(reduced_descriptor_residual) + "}";
        } else if (mode.floquet_descriptor_certified) {
            modes += ",\"floquet_descriptor_certified\":true,"
                "\"floquet_geometric_bc_certified\":false,"
                "\"potential_representation\":\"doubled_real_split_complex_coefficients\","
                "\"magnetic_relative_residual\":" + format_double(mode.floquet_magnetic_residual) +
                ",\"potential_relative_residual\":" + format_double(mode.floquet_potential_residual);
            for (int part=0; part<2; ++part) {
                modes += part==0 ? ",\"potential_vector_real\":[" : ",\"potential_vector_imag\":[";
                for (std::size_t i=0;i<mode.floquet_potential_real_split.size();++i) {
                    if(i) modes += ",";
                    modes += format_double(part==0 ? mode.floquet_potential_real_split[i].real()
                                                  : mode.floquet_potential_real_split[i].imag());
                }
                modes += "]";
            }
        }
        modes += "}";
    }
    modes += "]";
    return modes;
}

std::string format_slepc_modes_json(
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result)
{
    return format_slepc_modes_json(slepc_result.accepted_modes);
}

std::string generic_slepc_nev_refill_json_field(
    const SLEPcTinyGyrotropicModalEigenResult &result)
{
    if (result.solver_adapter == nullptr ||
        std::strcmp(result.solver_adapter, "slepc_modal_eigen") != 0) {
        return {};
    }
    return
        "\"slepc_modal_nev_refill\":{"
        "\"schema_version\":\"generic_slepc_modal_nev_refill.v1\","
        "\"adapter_status\":\"" +
        escape_json_string(result.status != nullptr ? result.status : "unknown") + "\""
        ",\"accepted_mode_count\":" +
        std::to_string(result.accepted_mode_count) +
        ",\"unique_certified_mode_count\":" +
        std::to_string(result.eps_unique_certified_mode_count) +
        ",\"attempt_count\":" + std::to_string(result.eps_attempt_count) +
        ",\"solved_attempt_count\":" +
        std::to_string(result.eps_solved_attempt_count) +
        ",\"initial_nev\":" +
        (result.eps_initial_nev > 0
            ? std::to_string(result.eps_initial_nev)
            : std::string("null")) +
        ",\"initial_resolved_ncv\":" +
        (result.eps_initial_ncv > 0
            ? std::to_string(result.eps_initial_ncv)
            : std::string("null")) +
        ",\"initial_resolved_mpd\":" +
        (result.eps_initial_mpd > 0
            ? std::to_string(result.eps_initial_mpd)
            : std::string("null")) +
        ",\"last_attempt_dimensions_available\":" +
        std::string(result.eps_dimensions_available ? "true" : "false") +
        ",\"last_attempt_nev\":" +
        (result.eps_dimensions_available
            ? std::to_string(result.eps_nev)
            : std::string("null")) +
        ",\"last_attempt_ncv\":" +
        (result.eps_dimensions_available
            ? std::to_string(result.eps_ncv)
            : std::string("null")) +
        ",\"last_attempt_mpd\":" +
        (result.eps_dimensions_available && result.eps_mpd > 0
            ? std::to_string(result.eps_mpd)
            : std::string("null")) +
        ",\"last_finalized_attempt\":" +
        (result.eps_finalized_attempt_number > 0
            ? std::to_string(result.eps_finalized_attempt_number)
            : std::string("null")) +
        ",\"last_finalized_nev\":" +
        (result.eps_finalized_nev > 0
            ? std::to_string(result.eps_finalized_nev)
            : std::string("null")) +
        ",\"iteration_budget_available\":" +
        std::string(result.eps_iteration_budget_available ? "true" : "false") +
        ",\"outer_iteration_budget\":" +
        (result.eps_iteration_budget_available
            ? std::to_string(result.max_outer_iterations)
            : std::string("null")) +
        ",\"cumulative_outer_iterations_available\":" +
        std::string(result.eps_cumulative_iterations_available ? "true" : "false") +
        ",\"cumulative_outer_iterations\":" +
        (result.eps_cumulative_iterations_available
            ? std::to_string(result.outer_iterations)
            : std::string("null")) +
        ",\"eps_converged_reason\":" +
        (result.eps_converged_reason_available
            ? std::to_string(result.eps_converged_reason)
            : std::string("null")) +
        ",\"unsupported_reason\":\"" +
        escape_json_string(result.unsupported_reason != nullptr
            ? result.unsupported_reason : "") + "\"}";
}

std::string format_slepc_partial_candidate_metadata_json(
    const std::vector<SLEPcModalAcceptedMode> &candidates)
{
    std::string json = "\"certified_partial_candidates\":[";
    for (std::size_t index = 0; index < candidates.size(); ++index) {
        const SLEPcModalAcceptedMode &candidate = candidates[index];
        if (index != 0) {
            json += ",";
        }
        json +=
            "{\"slepc_eigenpair_index\":" +
            std::to_string(candidate.eigenpair_index) +
            ",\"frequency_hz\":" + format_double(candidate.frequency_hz) +
            ",\"relative_residual\":" +
            format_double(candidate.relative_residual) + "}";
    }
    json += "]";
    return json;
}

bool has_dense_modal_payload(const ModalEigenRequest &request) noexcept
{
    return request.mfem_operator_enabled != 0 &&
        request.mfem_tangent_dof_count > 0 &&
        request.mfem_stiffness_matrix_row_major != nullptr &&
        request.mfem_gyrotropic_matrix_row_major != nullptr;
}

SLEPcTinyGyrotropicModalEigenResult solve_modal_spectrum_for_request(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request,
    const FloquetPotentialReconstruction *reconstruction) noexcept
{
    if (modal_request_is_nonzero_k_floquet(request)) {
        auto solved = solve_floquet_modal_spectrum(request, spectral_request);
        if (reconstruction && solved.ok) {
            for (auto &mode : solved.accepted_modes) {
                FloquetModalResidual residual;
                if (certify_floquet_realified_mode(
                        *reconstruction, reconstruction->magnetic_stiffness_real_split,
                        spectral_request.gyrotropic_matrix_row_major,
                        mode.mode_vector, {mode.lambda_real,mode.lambda_imag}, &residual)
                    != FrequencyDomainStatus::ok) {
                    solved.ok=false;
                    solved.status="solve_error";
                    solved.unsupported_reason="floquet_original_descriptor_residual_failed";
                    solved.accepted_modes.clear();
                    solved.accepted_mode_count=0;
                    return solved;
                }
                mode.floquet_descriptor_certified=true;
                mode.floquet_magnetic_residual=residual.magnetic_relative_residual;
                mode.floquet_potential_residual=residual.potential_relative_residual;
                mode.floquet_potential_real_split=std::move(residual.potential_real_split);
            }
        }
        return solved;
    }
    return solve_slepc_tiny_gyrotropic_modal_eigen(spectral_request);
}

SLEPcTinyGyrotropicModalEigenResult solve_sparse_modal_spectrum_for_request(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request,
    FloquetSharedDomainSparseModalSolveContext *reuse_context) noexcept
{
    if (modal_request_is_nonzero_k_floquet(request)) {
        // The reused shared-domain entry point must pass through the same
        // request/operator/device/phase/payload admission as the ordinary
        // sparse Floquet route.  Calling the lower-level owner directly is
        // necessary for one-window state reuse, but it must never bypass the
        // public CPU Floquet contract.
        const FloquetModalSolverAdmission admission =
            admit_floquet_modal_sparse_request(request, spectral_request);
        if (!admission.accepted) {
            SLEPcTinyGyrotropicModalEigenResult rejected{};
            rejected.status = "validation_error";
            rejected.unsupported_reason = admission.reason;
            return rejected;
        }
        if (spectral_request.floquet_shared_domain_operator != nullptr &&
            reuse_context != nullptr) {
            return solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(
                *spectral_request.floquet_shared_domain_operator,
                spectral_request,
                reuse_context);
        }
        return solve_floquet_modal_sparse_spectrum(request, spectral_request);
    }
    return solve_slepc_sparse_gyrotropic_modal_eigen(spectral_request);
}

bool dynamic_demag_k_payload_is_declared(const ModalEigenRequest &request) noexcept
{
    return request.dynamic_demag_k_tangent_matrix_row_major != nullptr ||
        request.dynamic_demag_k_tangent_matrix_value_count != 0;
}

bool dynamic_demag_k_payload_is_consistent(
    const ModalEigenRequest &request) noexcept
{
    const bool declared = dynamic_demag_k_payload_is_declared(request);
    if (!declared) {
        return true;
    }
    if (!modal_request_is_nonzero_k_floquet(request) ||
        request.operator_request.include_demag == 0 ||
        request.mfem_sparse_operator_enabled != 0 ||
        !has_dense_modal_payload(request) ||
        request.dynamic_demag_k_tangent_matrix_row_major == nullptr) {
        return false;
    }
    const std::uint64_t n = request.mfem_tangent_dof_count;
    if (n > std::numeric_limits<std::uint64_t>::max() / n) {
        return false;
    }
    const std::uint64_t expected = n * n;
    if (expected > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return false;
    }
    if (request.dynamic_demag_k_tangent_matrix_value_count != expected) {
        return false;
    }
    for (std::uint64_t index = 0; index < expected; ++index) {
        if (!std::isfinite(request.dynamic_demag_k_tangent_matrix_row_major[index])) {
            return false;
        }
    }
    return true;
}

// Build the tangent stiffness consumed by the SLEPc adapter.  The caller
// supplies the already assembled, topology-bound k-dependent demagnetisation
// contribution; this adapter only adds it to the static restoring Hessian.
// A missing or malformed payload is never replaced by the k=0/static field
// term.
bool effective_dense_stiffness_for_request(
    const ModalEigenRequest &request,
    std::vector<double> &storage,
    const double **out_stiffness) noexcept
{
    if (out_stiffness == nullptr || !has_dense_modal_payload(request)) {
        return false;
    }
    *out_stiffness = request.mfem_stiffness_matrix_row_major;
    if (!dynamic_demag_k_payload_is_declared(request)) {
        return true;
    }
    if (!dynamic_demag_k_payload_is_consistent(request)) {
        return false;
    }
    const std::uint64_t n = request.mfem_tangent_dof_count;
    const std::uint64_t value_count = n * n;
    try {
        storage.assign(
            request.mfem_stiffness_matrix_row_major,
            request.mfem_stiffness_matrix_row_major + value_count);
        for (std::uint64_t index = 0; index < value_count; ++index) {
            storage[static_cast<std::size_t>(index)] +=
                request.dynamic_demag_k_tangent_matrix_row_major[index];
        }
    } catch (...) {
        storage.clear();
        return false;
    }
    *out_stiffness = storage.data();
    return true;
}

bool has_sparse_modal_payload(const ModalEigenRequest &request) noexcept
{
    return request.mfem_sparse_operator_enabled != 0 ||
        request.floquet_shared_domain_operator != nullptr;
}

std::uint64_t sparse_modal_tangent_dof_count(
    const ModalEigenRequest &request) noexcept
{
    return request.floquet_shared_domain_operator != nullptr
        ? request.floquet_shared_domain_operator->q_complex_dof_count
        : request.mfem_sparse_stiffness_csr.row_count;
}

bool sparse_modal_tangent_dof_count_is_supported(
    const ModalEigenRequest &request) noexcept
{
    const std::uint64_t count = sparse_modal_tangent_dof_count(request);
    return count > 0u &&
        count <= static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2);
}

bool csr_matrix_view_is_consistent(const CsrMatrixView &view) noexcept
{
    if (view.row_count == 0 ||
        view.column_count == 0 ||
        view.row_offsets == nullptr ||
        view.row_offsets_len != view.row_count + 1u ||
        view.column_indices == nullptr ||
        view.values == nullptr ||
        view.column_indices_len != view.values_len) {
        return false;
    }
    if (view.row_offsets[0] != 0u ||
        view.row_offsets[view.row_count] != view.values_len) {
        return false;
    }
    for (uint64_t row = 0; row < view.row_count; ++row) {
        if (view.row_offsets[row] > view.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (uint64_t entry = 0; entry < view.column_indices_len; ++entry) {
        if (view.column_indices[entry] >= view.column_count) {
            return false;
        }
    }
    return true;
}

bool sparse_modal_payload_shapes_match(const ModalEigenRequest &request) noexcept
{
    if (request.floquet_shared_domain_operator != nullptr) {
        return sparse_modal_tangent_dof_count_is_supported(request);
    }
    const CsrMatrixView &stiffness = request.mfem_sparse_stiffness_csr;
    const CsrMatrixView &gyrotropic = request.mfem_sparse_gyrotropic_csr;
    const CsrMatrixView &mass = request.mfem_sparse_mass_csr;
    return stiffness.row_count == stiffness.column_count &&
        gyrotropic.row_count == stiffness.row_count &&
        gyrotropic.column_count == stiffness.column_count &&
        mass.row_count == stiffness.row_count &&
        mass.column_count == stiffness.column_count;
}

FrequencyDomainContractResult dense_payload_validation_error(
    const ModalEigenRequest &request,
    const char *message,
    const char *reason) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::validation_error;
    result.error_message = message != nullptr ? message : "";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
        "\"reason\":\"" +
        std::string(reason != nullptr ? reason : "validation_error") +
        "\"}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"validation_error\","
        "\"accepted_mode_count\":0}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    return result;
}

FrequencyDomainContractResult sparse_payload_validation_error(
    const ModalEigenRequest &request,
    const char *message,
    const char *reason) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::validation_error;
    result.error_message = message != nullptr ? message : "";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"mfem_operator_payload\":\"sparse_csr\","
        "\"reason\":\"" +
        std::string(reason != nullptr ? reason : "validation_error") +
        "\"}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"validation_error\","
        "\"accepted_mode_count\":0}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    return result;
}

FrequencyDomainContractResult sparse_payload_solver_pending_result(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection,
    const ModalShiftSelection &shift,
    const SLEPcModalEigenAdapterStatus &adapter,
    bool contour_interval) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.error_message =
        "native FEM modal sparse CSR operator payload is not connected to the SLEPc production solver yet";
    const char *spectral_transform =
        contour_interval ? "contour_interval" : "shift_invert";
    const char *solver_model =
        contour_interval ? "contour_interval_sparse_csr_pending" :
            "slepc_shift_invert_production_cpu_sparse_csr_pending";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"mfem_operator_request\":true,"
        "\"mfem_operator_payload\":\"sparse_csr\","
        "\"tangent_dof_count\":" +
        std::to_string(sparse_modal_tangent_dof_count(request)) +
        ",\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_model\":\"" +
        std::string(solver_model) +
        "\",\"spectral_transform\":\"" +
        std::string(spectral_transform) +
        "\"";
    if (!contour_interval) {
        result.diagnostics_json +=
            ",\"shift_selection_policy\":\"" +
            std::string(shift.selection_policy) +
            "\",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s);
    }
    result.diagnostics_json +=
        ",\"solver_adapter\":\"" +
        std::string(adapter.solver_adapter) +
        "\",\"solver_adapter_status\":\"sparse_payload_pending\","
        "\"requires_slepc\":true,"
        "\"modal_eigen_native_cpu_slepc_available\":" +
        std::string(adapter.slepc_available ? "true" : "false") +
        ",\"unsupported_reason\":\"sparse_modal_operator_payload_solver_pending\"}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0,"
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"unsupported_reason\":\"sparse_modal_operator_payload_solver_pending\"";
    if (!contour_interval) {
        result.result_json +=
            ",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz);
    }
    result.result_json += "}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    return result;
}

const char *stop_reason_or_default(
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result) noexcept
{
    return slepc_result.unsupported_reason != nullptr &&
            slepc_result.unsupported_reason[0] != '\0' ?
        slepc_result.unsupported_reason :
        "slepc_production_solve_failed";
}

bool subwindow_is_clean_empty_window(
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result) noexcept
{
    const char *unsupported_reason =
        slepc_result.unsupported_reason != nullptr
            ? slepc_result.unsupported_reason : "";
    // The ABI stores SLEPc's EPSConvergedReason as an int.  SLEPc uses zero
    // for EPS_CONVERGED_ITERATING and negative values for divergence.  A
    // positive reason plus converged pairs is therefore required before an
    // empty frequency interval may be treated as an exhausted subwindow.
    // Every candidate-rejection counter must remain zero: a residual, vector,
    // reconstruction or EPS failure is a hard failure, never an empty band.
    return !slepc_result.ok &&
        slepc_result.status != nullptr &&
        std::strcmp(slepc_result.status, "solve_error") == 0 &&
        std::strcmp(unsupported_reason,
                    "no_positive_frequency_eigenpair_in_window") == 0 &&
        slepc_result.eps_converged_reason_available &&
        slepc_result.eps_converged_reason > 0 &&
        slepc_result.converged_eigenpair_count > 0 &&
        slepc_result.positive_frequency_candidate_count > 0 &&
        slepc_result.frequency_window_candidate_count == 0 &&
        slepc_result.residual_evaluation_candidate_count == 0 &&
        slepc_result.residual_rejection_count == 0 &&
        slepc_result.non_real_rotated_eigenvalue_count == 0 &&
        slepc_result.eigenpair_evaluation_failure_count == 0 &&
        slepc_result.mode_vector_failure_count == 0 &&
        slepc_result.potential_reconstruction_failure_count == 0;
}

bool is_frequency_window(const ModalEigenRequest &request) noexcept
{
    const char *target_kind = request.target_kind != nullptr ? request.target_kind : "";
    return std::strcmp(target_kind, "frequency_window") == 0 &&
        std::isfinite(request.frequency_min_hz) &&
        std::isfinite(request.frequency_max_hz) &&
        request.frequency_min_hz < request.frequency_max_hz;
}

FrequencyWindowPartitionRequest partition_request_from_modal_request(
    const ModalEigenRequest &request) noexcept
{
    FrequencyWindowPartitionRequest partition_request{};
    partition_request.frequency_min_hz = request.frequency_min_hz;
    partition_request.frequency_max_hz = request.frequency_max_hz;
    partition_request.requested_mode_count = request.requested_mode_count;
    partition_request.completeness_policy = request.completeness_policy;
    return partition_request;
}

ModalShiftSelection subwindow_shift_selection(const FrequencySubwindow &subwindow) noexcept
{
    ModalShiftSelection shift{};
    shift.target_kind = "frequency_window";
    shift.selection_policy = "subwindow_midpoint";
    shift.shift_frequency_hz = subwindow.shift_hz;
    shift.shift_omega_rad_s = omega_rad_s_from_frequency_hz(subwindow.shift_hz);
    return shift;
}

struct DenseSubwindowSolve {
    FrequencySubwindow subwindow{};
    SLEPcTinyGyrotropicModalEigenResult result{};
    const char *stop_reason = "window_exhausted";
};

const char *subwindow_stop_reason(
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result) noexcept
{
    if (slepc_result.status != nullptr &&
        std::strcmp(slepc_result.status, "cancelled") == 0) {
        return "cancelled";
    }
    if (slepc_result.status != nullptr &&
        std::strcmp(slepc_result.status, "partial") == 0) {
        return "partial_convergence";
    }
    if (slepc_result.ok) {
        return "converged";
    }
    if (subwindow_is_clean_empty_window(slepc_result)) {
        return "window_exhausted";
    }
    if (std::strcmp(slepc_result.unsupported_reason, "residual_tolerance_not_met") == 0) {
        return "residual_not_met";
    }
    return stop_reason_or_default(slepc_result);
}

bool subwindow_requires_fail_closed(
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result,
    int completeness_policy) noexcept
{
    // A clean empty interval is not a solver failure: a converged positive EPS
    // set can simply have its nearest positive mode in a later subwindow.
    // Every other solve/validation error remains fail-closed so an EPS failure
    // or rejected physical residual can never be published as a nearest mode.
    if (slepc_result.ok || slepc_result.status == nullptr) {
        return false;
    }
    if (std::strcmp(slepc_result.status, "validation_error") == 0) {
        return true;
    }
    if (std::strcmp(slepc_result.status, "partial") == 0) {
        const bool generic_slepc_adapter =
            slepc_result.solver_adapter != nullptr &&
            std::strcmp(slepc_result.solver_adapter, "slepc_modal_eigen") == 0;
        if (!generic_slepc_adapter) {
            return false;
        }
        const char *unsupported_reason =
            slepc_result.unsupported_reason != nullptr
                ? slepc_result.unsupported_reason : "";
        return completeness_policy != 0 ||
            std::strcmp(
                unsupported_reason,
                "slepc_modal_nev_refill_dimension_limit_reached") != 0;
    }
    if (std::strcmp(slepc_result.status, "solve_error") != 0) {
        return false;
    }
    return !subwindow_is_clean_empty_window(slepc_result);
}

std::string production_window_diagnostics_json(
    const ModalEigenRequest &request,
    const FrequencyWindowPartition &partition,
    const std::vector<DenseSubwindowSolve> &subwindow_solves,
    const std::vector<SLEPcModalAcceptedMode> &accepted_modes,
    std::size_t accepted_mode_count_before_cap,
    bool truncated_by_requested_count)
{
    if (partition.subwindows.empty()) {
        return "";
    }
    double resolved_min_hz = partition.subwindows.front().search_min_hz;
    double resolved_max_hz = partition.subwindows.front().search_max_hz;
    for (const FrequencySubwindow &subwindow : partition.subwindows) {
        resolved_min_hz = std::min(resolved_min_hz, subwindow.search_min_hz);
        resolved_max_hz = std::max(resolved_max_hz, subwindow.search_max_hz);
    }

    const bool certified =
        partition.uncertified_subwindows.empty() &&
        std::strcmp(partition.certification_method, "none") != 0;
    const bool native_floquet_certified_count_unavailable =
        request.floquet_shared_domain_operator != nullptr &&
        request.completeness_policy == 1;
    const bool exhausted_without_modes =
        !native_floquet_certified_count_unavailable &&
        !truncated_by_requested_count &&
        accepted_modes.empty() &&
        !subwindow_solves.empty() &&
        std::all_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return std::strcmp(solve.stop_reason, "window_exhausted") == 0 ||
                    std::strcmp(solve.stop_reason, "converged") == 0;
            });
    const bool partial_convergence =
        std::any_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return std::strcmp(solve.stop_reason, "window_exhausted") != 0 &&
                    std::strcmp(solve.stop_reason, "converged") != 0;
            });
    const bool generic_dimension_limited_partial_without_modes =
        request.completeness_policy == 0 && accepted_modes.empty() &&
        std::any_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return solve.result.solver_adapter != nullptr &&
                    std::strcmp(solve.result.solver_adapter, "slepc_modal_eigen") == 0 &&
                    solve.result.status != nullptr &&
                    std::strcmp(solve.result.status, "partial") == 0 &&
                    solve.result.unsupported_reason != nullptr &&
                    std::strcmp(
                        solve.result.unsupported_reason,
                        "slepc_modal_nev_refill_dimension_limit_reached") == 0;
            });
    const bool hard_failure = std::any_of(
        subwindow_solves.begin(),
        subwindow_solves.end(),
        [&request](const DenseSubwindowSolve &solve) {
            return subwindow_requires_fail_closed(
                solve.result, request.completeness_policy);
        }) || generic_dimension_limited_partial_without_modes;
    const std::string completeness_status = hard_failure ?
        "solver_error" : (truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (exhausted_without_modes ? "window_exhausted" :
            (partial_convergence ? "partial_convergence" :
                (certified ? "certified" : "not_certified"))));
    const char *additional_modes_may_exist =
        (!hard_failure && certified && !truncated_by_requested_count) ? "false" : "true";
    double ksp_final_residual = 0.0;
    for (const DenseSubwindowSolve &solve : subwindow_solves) {
        if (std::isfinite(solve.result.ksp_final_residual)) {
            ksp_final_residual =
                std::max(ksp_final_residual, solve.result.ksp_final_residual);
        }
    }
    std::string json =
        "\"requested_window_hz\":[" +
        format_double(request.frequency_min_hz) + "," +
        format_double(request.frequency_max_hz) + "],"
        "\"resolved_search_window_hz\":[" +
        format_double(resolved_min_hz) + "," +
        format_double(resolved_max_hz) + "],";
    if (!subwindow_solves.empty()) {
        const SLEPcTinyGyrotropicModalEigenResult &policy =
            subwindow_solves.front().result;
        json +=
            "\"ksp_type\":\"" +
            std::string(policy.ksp_type) +
            "\",\"ksp_orthogonalization\":\"" +
            std::string(policy.ksp_orthogonalization) +
            "\",\"pc_type\":\"" +
            std::string(policy.pc_type) +
            "\",\"max_outer_iterations\":" +
            std::to_string(policy.max_outer_iterations) +
            ",\"ksp_rtol\":" +
            format_double(policy.ksp_rtol) +
            ",\"ksp_atol\":" +
            format_double(policy.ksp_atol) +
            ",\"ksp_max_iterations\":" +
            std::to_string(policy.ksp_max_iterations) +
            ",\"ksp_restart\":" +
            std::to_string(policy.ksp_restart) +
            ",\"ksp_breakdown_tolerance\":" +
            format_double(policy.ksp_breakdown_tolerance) +
            ",\"ksp_final_residual\":" +
            format_double(ksp_final_residual) +
            ",\"factorization_package\":\"" +
            std::string(policy.factorization_package) +
            "\",\"factorization_shift_policy\":\"" +
            std::string(policy.factorization_shift_policy) +
            "\",\"factorization_shift_amount\":" +
            format_double(policy.factorization_shift_amount) +
            ",\"operator_normalization_scale\":" +
            format_double(policy.operator_normalization_scale) +
            ",\"preconditioner_normalization_scale\":" +
            format_double(policy.preconditioner_normalization_scale) +
            ",\"nullspace_policy\":\"" +
            std::string(policy.nullspace_policy) +
            "\",";
    }
    json +=
        "\"window_completeness\":{"
        "\"policy\":\"" +
        std::string(partition.completeness_policy) +
        "\",\"status\":\"" +
        completeness_status +
        "\",\"certification_method\":\"" +
        std::string(partition.certification_method) +
        "\",\"estimated_modes_in_window\":" +
        std::to_string(partition.estimated_modes_in_window) +
        ",\"certified_modes_in_window\":" +
        std::to_string(partition.certified_modes_in_window) +
        ",\"returned_modes\":" +
        std::to_string(accepted_modes.size()) +
        ",\"accepted_modes_before_cap\":" +
        std::to_string(accepted_mode_count_before_cap) +
        ",\"result_truncated\":" +
        std::string(truncated_by_requested_count ? "true" : "false") +
        (truncated_by_requested_count ?
            ",\"truncation_reason\":\"requested_mode_cap\"" :
            "") +
        ",\"additional_modes_may_exist\":" +
        std::string(additional_modes_may_exist) +
        (native_floquet_certified_count_unavailable
            ? ",\"certification_unavailable_reason\":\"" +
                std::string(kNativeFloquetCountCertificateUnavailableReason) + "\""
            : "") +
        "},\"subwindows\":[";

    for (std::size_t i = 0; i < subwindow_solves.size(); ++i) {
        const DenseSubwindowSolve &solve = subwindow_solves[i];
        const FrequencySubwindow &subwindow = solve.subwindow;
        if (i != 0) {
            json += ",";
        }
        const bool has_floquet_candidate_diagnostics =
            solve.result.solver_adapter != nullptr &&
            std::strcmp(
                solve.result.solver_adapter,
                "floquet_airbox_cpu_schur_slepc") == 0;
        json +=
            "{\"index\":" +
            std::to_string(subwindow.index) +
            ",\"status\":\"" +
            std::string(
                solve.result.status != nullptr ? solve.result.status : "unknown") +
            "\",\"requested_hz\":[" +
            format_double(subwindow.requested_min_hz) + "," +
            format_double(subwindow.requested_max_hz) +
            "],\"search_hz\":[" +
            format_double(subwindow.search_min_hz) + "," +
            format_double(subwindow.search_max_hz) +
            "],\"shift_hz\":" +
            format_double(subwindow.shift_hz) +
            ",\"shift_frequency_hz\":" +
            format_double(subwindow.shift_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(omega_rad_s_from_frequency_hz(subwindow.shift_hz)) +
            ",\"outer_iterations\":" +
            std::to_string(solve.result.outer_iterations) +
            ",\"linear_iterations_total\":" +
            std::to_string(solve.result.linear_iterations_total) +
            ",\"candidate_modes\":" +
            std::to_string(solve.result.converged_eigenpair_count) +
            ",\"operator_normalization_scale\":" +
            format_double(solve.result.operator_normalization_scale) +
            ",\"preconditioner_normalization_scale\":" +
            format_double(solve.result.preconditioner_normalization_scale) +
            ",\"unsupported_reason\":\"" +
            std::string(solve.result.unsupported_reason) +
            "\",\"positive_frequency_candidates\":" +
            std::to_string(solve.result.positive_frequency_candidate_count) +
            ",\"frequency_window_candidates\":" +
            std::to_string(solve.result.frequency_window_candidate_count) +
            ",\"residual_rejections\":" +
            std::to_string(solve.result.residual_rejection_count) +
            ",\"non_real_rotated_eigenvalues\":" +
            std::to_string(solve.result.non_real_rotated_eigenvalue_count) +
            ",\"candidate_relative_residual_max\":" +
            format_double(solve.result.max_candidate_relative_residual);
        const std::string generic_refill_diagnostics =
            generic_slepc_nev_refill_json_field(solve.result);
        if (!generic_refill_diagnostics.empty()) {
            json += "," + generic_refill_diagnostics;
            if (solve.result.status != nullptr &&
                std::strcmp(solve.result.status, "partial") == 0) {
                json +=
                    ",\"certified_partial_candidate_count\":" +
                    std::to_string(solve.result.accepted_modes.size());
                if (!solve.result.accepted_modes.empty()) {
                    json += "," + format_slepc_partial_candidate_metadata_json(
                        solve.result.accepted_modes);
                }
            }
        }
        if (has_floquet_candidate_diagnostics) {
            json +=
                ",\"residual_evaluation_candidates\":" +
                std::to_string(
                    solve.result.residual_evaluation_candidate_count) +
                "," + floquet_shifted_ksp_diagnostics_json_fields(solve.result, true) +
                ",\"eps_monitor_iteration\":" +
                std::to_string(solve.result.eps_monitor_iteration) +
                ",\"eps_first_unconverged_error_estimate\":" +
                format_double(solve.result.eps_first_unconverged_error_estimate) +
                ",\"eps_convergence_test\":\"absolute_true_residual\"" +
                ",\"eps_normalized_absolute_tolerance\":" +
                format_double(solve.result.eps_normalized_absolute_tolerance) +
                ",\"eps_normalized_absolute_residual_max\":" +
                format_double(solve.result.max_eps_normalized_absolute_residual) +
                ",\"floquet_magnetic_relative_residual_max\":" +
                format_double(
                    solve.result.max_floquet_magnetic_relative_residual) +
                ",\"floquet_potential_relative_residual_max\":" +
                format_double(
                    solve.result.max_floquet_potential_relative_residual) +
                ",\"worst_candidate_frequency_hz\":" +
                format_double(solve.result.worst_candidate_frequency_hz) +
                ",\"worst_candidate_residuals\":{\"eps_normalized_absolute\":" +
                format_double(
                    solve.result.worst_candidate_eps_normalized_absolute_residual) +
                ",\"magnetic\":" +
                format_double(
                    solve.result.worst_candidate_floquet_magnetic_relative_residual) +
                ",\"potential\":" +
                format_double(
                    solve.result.worst_candidate_floquet_potential_relative_residual) +
                ",\"magnetic_unprojected\":" +
                format_double(
                    solve.result.worst_candidate_unprojected_magnetic_relative_residual) +
                ",\"rotated_imaginary_rad_s\":" +
                format_double(
                    solve.result.worst_candidate_rotated_imaginary_rad_s) +
                ",\"q_projection_ratio\":" +
                format_double(
                    solve.result.worst_candidate_q_projection_ratio) +
                "}" +
                ",\"eigenpair_evaluation_failures\":" +
                std::to_string(
                    solve.result.eigenpair_evaluation_failure_count) +
                ",\"mode_vector_failures\":" +
                std::to_string(solve.result.mode_vector_failure_count) +
                ",\"potential_reconstruction_failures\":" +
                std::to_string(
                    solve.result.potential_reconstruction_failure_count) +
                "," +
                floquet_dense_oracle_json_field(solve.result.floquet_dense_oracle) +
                "," +
                floquet_schur_action_diagnostic_json_field(
                    solve.result.floquet_schur_action_diagnostic);
        }
        const std::string demag_probe_json_field =
            floquet_demag_operator_probe_json_field(
                solve.result.dynamic_demag_operator_probe);
        if (!demag_probe_json_field.empty()) {
            json += ",";
            json += demag_probe_json_field;
        }
        json +=
            ",\"candidate_frequency_hz\":[" +
            format_double(solve.result.min_candidate_frequency_hz) + "," +
            format_double(solve.result.max_candidate_frequency_hz) + "]" +
            ",\"accepted_modes\":" +
            std::to_string(solve.result.accepted_mode_count) +
            ",\"residual_max\":" +
            format_double(solve.result.max_relative_residual) +
            ",\"stop_reason\":\"" +
            std::string(solve.stop_reason) +
            "\"}";
    }
    json +=
        "],\"accepted_mode_count_after_dedup\":" +
        std::to_string(accepted_modes.size());
    return json;
}

double contour_max_relative_residual(
    const ContourIntervalSolveResult &contour_result) noexcept
{
    double residual = 0.0;
    for (const ContourIntervalMode &mode : contour_result.modes) {
        residual = std::max(residual, mode.relative_residual);
    }
    return residual;
}

std::string format_contour_modes_json(
    const std::vector<ContourIntervalMode> &accepted_modes)
{
    std::string modes = "[";
    for (std::size_t index = 0; index < accepted_modes.size(); ++index) {
        const ContourIntervalMode &mode = accepted_modes[index];
        if (index != 0) {
            modes += ",";
        }
        modes +=
            "{\"mode_index\":" + std::to_string(index) +
            ",\"positive_frequency_pair_index\":" +
            std::to_string(index) +
            "," +
            mode_kinematics_json_fields(
                {std::real(mode.eigenvalue), std::imag(mode.eigenvalue)}) +
            ",\"relative_residual\":" +
            format_double(mode.relative_residual) +
            ",\"discarded_negative_frequency_partner\":true,"
            "\"mode_vector_real\":[";
        for (std::size_t component = 0; component < mode.mode_vector.size(); ++component) {
            if (component != 0) {
                modes += ",";
            }
            modes += format_double(std::real(mode.mode_vector[component]));
        }
        modes += "],\"mode_vector_imag\":[";
        for (std::size_t component = 0; component < mode.mode_vector.size(); ++component) {
            if (component != 0) {
                modes += ",";
            }
            modes += format_double(std::imag(mode.mode_vector[component]));
        }
        modes += "]";
        if (mode.floquet_descriptor_certified) {
            modes += ",\"floquet_descriptor_certified\":true,"
                "\"floquet_geometric_bc_certified\":false,"
                "\"potential_representation\":\"doubled_real_split_complex_coefficients\","
                "\"magnetic_relative_residual\":" +
                format_double(mode.floquet_magnetic_residual) +
                ",\"potential_relative_residual\":" +
                format_double(mode.floquet_potential_residual);
            for (int part = 0; part < 2; ++part) {
                modes += part == 0 ? ",\"potential_vector_real\":[" :
                    ",\"potential_vector_imag\":[";
                for (std::size_t i = 0;
                     i < mode.floquet_potential_real_split.size();
                     ++i) {
                    if (i != 0) {
                        modes += ",";
                    }
                    modes += format_double(
                        part == 0 ?
                            mode.floquet_potential_real_split[i].real() :
                            mode.floquet_potential_real_split[i].imag());
                }
                modes += "]";
            }
        }
        modes += "}";
    }
    modes += "]";
    return modes;
}

FrequencyDomainContractResult contour_descriptor_certification_error(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection,
    const char *reason,
    int failed_mode_index) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::solve_error;
    result.error_message =
        "native FEM modal_eigen contour interval Floquet descriptor certification failed";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"solve_error\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_adapter\":\"contour_interval_solver\","
        "\"solver_model\":\"contour_interval_production_cpu_dense\","
        "\"spectral_transform\":\"contour_integral\","
        "\"floquet_descriptor_certified\":false,"
        "\"floquet_geometric_bc_certified\":false,"
        "\"unsupported_reason\":\"" +
        std::string(reason != nullptr ? reason : "floquet_original_descriptor_residual_failed") +
        "\",\"failed_mode_index\":" +
        (failed_mode_index >= 0 ? std::to_string(failed_mode_index) : "null") +
        "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"solve_error\","
        "\"accepted_mode_count\":0,"
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"floquet_descriptor_certified\":false,"
        "\"floquet_geometric_bc_certified\":false,"
        "\"unsupported_reason\":\"" +
        std::string(reason != nullptr ? reason : "floquet_original_descriptor_residual_failed") +
        "\"}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    return result;
}

std::string production_contour_window_diagnostics_json(
    const ModalEigenRequest &request,
    const ContourIntervalSolveResult &contour_result,
    bool truncated_by_requested_count)
{
    const bool certified_count_policy = request.completeness_policy == 1;
    const char *policy = certified_count_policy ? "certified_count" : "best_effort";
    const char *certification_method =
        certified_count_policy && contour_result.count_certificate ?
            "contour_interval_count" :
            (certified_count_policy ? "contour_interval_best_effort" : "none");
    const char *completeness_status = truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (certified_count_policy && contour_result.count_certificate ?
            "certified" :
            "not_certified");
    const char *additional_modes_may_exist =
        certified_count_policy && contour_result.count_certificate &&
                !truncated_by_requested_count ?
            "false" :
            "true";
    int linear_iterations_total = 0;
    for (const ContourPointSolveDiagnostic &point : contour_result.contour_points) {
        linear_iterations_total += point.linear_iterations;
    }
    const double shift_frequency_hz =
        0.5 * (request.frequency_min_hz + request.frequency_max_hz);
    const double max_residual =
        contour_max_relative_residual(contour_result);
    const char *subwindow_stop_reason = truncated_by_requested_count ?
        "requested_count_reached" :
        (contour_result.stop_reason != nullptr ?
            contour_result.stop_reason :
            "partial_convergence");
    std::string json =
        "\"requested_window_hz\":[" +
        format_double(request.frequency_min_hz) + "," +
        format_double(request.frequency_max_hz) + "],"
        "\"resolved_search_window_hz\":[" +
        format_double(request.frequency_min_hz) + "," +
        format_double(request.frequency_max_hz) + "],"
        "\"window_completeness\":{"
        "\"policy\":\"" +
        std::string(policy) +
        "\",\"status\":\"" +
        completeness_status +
        "\",\"certification_method\":\"" +
        certification_method +
        "\",\"estimated_modes_in_window\":" +
        std::to_string(contour_result.estimated_mode_count) +
        ",\"certified_modes_in_window\":" +
        std::to_string(certified_count_policy && contour_result.count_certificate ?
            contour_result.estimated_mode_count :
            0) +
        ",\"returned_modes\":" +
        std::to_string(contour_result.accepted_mode_count) +
        ",\"result_truncated\":" +
        std::string(truncated_by_requested_count ? "true" : "false") +
        (truncated_by_requested_count ?
            ",\"truncation_reason\":\"requested_mode_cap\"" :
            "") +
        ",\"additional_modes_may_exist\":" +
        additional_modes_may_exist +
        "},\"subwindows\":[{"
        "\"index\":0,"
        "\"requested_hz\":[" +
        format_double(request.frequency_min_hz) + "," +
        format_double(request.frequency_max_hz) +
        "],\"search_hz\":[" +
        format_double(request.frequency_min_hz) + "," +
        format_double(request.frequency_max_hz) +
        "],\"shift_hz\":" +
        format_double(shift_frequency_hz) +
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(omega_rad_s_from_frequency_hz(shift_frequency_hz)) +
        ",\"outer_iterations\":" +
        std::to_string(std::max(1, contour_result.quadrature_refinements + 1)) +
        ",\"linear_iterations_total\":" +
        std::to_string(linear_iterations_total) +
        ",\"candidate_modes\":" +
        std::to_string(contour_result.estimated_mode_count) +
        ",\"accepted_modes\":" +
        std::to_string(contour_result.accepted_mode_count) +
        ",\"residual_max\":" +
        format_double(max_residual) +
        ",\"stop_reason\":\"" +
        std::string(subwindow_stop_reason) +
        "\"}]";
    return json;
}

void emit_production_contour_progress(
    const ModalEigenRequest &request,
    const ContourIntervalSolveResult &contour_result) noexcept
{
    if (request.progress_callback == nullptr) {
        return;
    }
    for (const ContourPointSolveDiagnostic &point : contour_result.contour_points) {
        SolverProgressState state{};
        state.study_product = "modal_eigen";
        state.solver_phase = "solving_contour_interval";
        state.execution_lane = "production_cpu";
        state.stop_reason = nullptr;
        state.contour_point_index = static_cast<int>(point.index);
        state.contour_point_count = contour_result.contour_point_count;
        state.linear_iteration = point.linear_iterations;
        state.max_linear_iterations = request.max_linear_iterations;
        char progress_json[1024];
        if (solver_progress_json(state, progress_json, sizeof(progress_json)) == 0) {
            continue;
        }
        request.progress_callback(request.progress_user_data, progress_json);
    }
}

FrequencyDomainContractResult solve_dense_production_modal_contour_payload(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection,
    const FloquetPotentialReconstruction *reconstruction) noexcept
{
    // The contour adapter currently maps its returned pencil eigenvalues with
    // the exp(+i omega t) convention.  Refuse the other convention explicitly
    // so the certificate and published frequency cannot silently use a wrong
    // sign.
    if (request.phase_convention !=
        FrequencyDomainPhaseConvention::exp_i_omega_t) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen contour interval supports exp_i_omega_t phase convention only",
            "contour_interval_phase_convention_unsupported");
    }
    if (request.mfem_tangent_dof_count == 0 ||
        request.mfem_tangent_dof_count % 2 != 0) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen contour interval dense payload requires a positive even tangent DOF count",
            "contour_interval_dense_payload_requires_even_tangent_dofs");
    }

    std::vector<double> effective_stiffness;
    const double *stiffness = nullptr;
    if (!effective_dense_stiffness_for_request(
            request,
            effective_stiffness,
            &stiffness)) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dynamic demag-k payload is malformed",
            "invalid_dynamic_demag_k_tangent_matrix");
    }

    ContourIntervalSolverRequest contour_request{};
    contour_request.frequency_min_hz = request.frequency_min_hz;
    contour_request.frequency_max_hz = request.frequency_max_hz;
    contour_request.requested_mode_count = request.requested_mode_count;
    contour_request.residual_tolerance = request.residual_tolerance;
    contour_request.max_outer_iterations = request.max_outer_iterations;
    contour_request.max_linear_iterations = request.max_linear_iterations;
    contour_request.eigensolver_family = request.eigensolver_family;
    contour_request.completeness_policy = request.completeness_policy;
    contour_request.contour_point_count = 16;
    contour_request.tangent_dof_count = request.mfem_tangent_dof_count;
    contour_request.stiffness_matrix_row_major =
        stiffness;
    contour_request.gyrotropic_mass_matrix_row_major =
        request.mfem_gyrotropic_matrix_row_major;

    ContourIntervalSolveResult contour_result =
        solve_tiny_contour_interval(contour_request);
    const bool truncated_by_requested_count =
        request.requested_mode_count > 0 &&
        contour_result.estimated_mode_count > contour_result.accepted_mode_count &&
        contour_result.accepted_mode_count == request.requested_mode_count;
    const char *window_stop_reason = truncated_by_requested_count ?
        "requested_count_reached" :
        (contour_result.stop_reason != nullptr ? contour_result.stop_reason : "converged");
    if (!contour_result.ok || contour_result.modes.empty()) {
        FrequencyDomainContractResult result{};
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "native FEM modal_eigen production CPU contour interval solve failed";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"production_cpu\","
            "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
            "\"production_solver_available\":true,"
            "\"tiny_validation_solver\":false,"
            "\"mfem_operator_request\":true,"
            "\"tangent_dof_count\":" +
            std::to_string(request.mfem_tangent_dof_count) +
            ",\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"solver_selection_reason\":\"" +
            std::string(selection.reason) +
            "\",\"solver_adapter\":\"contour_interval_solver\","
            "\"solver_model\":\"contour_interval_production_cpu_dense\","
            "\"solver_family\":\"contour_interval_production_cpu_dense\","
            "\"spectral_transform\":\"contour_integral\","
            "\"stop_reason\":\"" +
            std::string(window_stop_reason) +
            "\",";
        result.diagnostics_json += production_contour_window_diagnostics_json(
            request,
            contour_result,
            truncated_by_requested_count);
        result.diagnostics_json += ",";
        result.diagnostics_json += contour_interval_diagnostics_json(contour_result);
        result.diagnostics_json += "}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0,"
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"stop_reason\":\"" +
            std::string(window_stop_reason) +
            "\",\"window_completeness\":\"not_certified\"}";
        append_nearest_frequency_metadata(result.result_json, request, result.status);
        return result;
    }

    if (reconstruction != nullptr) {
        if (reconstruction->magnetic_stiffness_real_split == nullptr) {
            return contour_descriptor_certification_error(
                request,
                selection,
                "floquet_descriptor_original_magnetic_stiffness_missing",
                -1);
        }
        for (std::size_t index = 0; index < contour_result.modes.size(); ++index) {
            ContourIntervalMode &mode = contour_result.modes[index];
            FloquetModalResidual residual{};
            const FrequencyDomainStatus certification_status =
                certify_floquet_realified_mode(
                    *reconstruction,
                    reconstruction->magnetic_stiffness_real_split,
                    request.mfem_gyrotropic_matrix_row_major,
                    mode.mode_vector,
                    mode.eigenvalue,
                    &residual);
            if (certification_status != FrequencyDomainStatus::ok ||
                !residual.certified) {
                return contour_descriptor_certification_error(
                    request,
                    selection,
                    "floquet_original_descriptor_residual_failed",
                    static_cast<int>(index));
            }
            mode.floquet_descriptor_certified = true;
            mode.floquet_magnetic_residual =
                residual.magnetic_relative_residual;
            mode.floquet_potential_residual =
                residual.potential_relative_residual;
            mode.floquet_potential_real_split =
                std::move(residual.potential_real_split);
        }
    }

    emit_production_contour_progress(request, contour_result);
    const ContourIntervalMode &first_mode = contour_result.modes.front();
    const bool certified_count_policy = request.completeness_policy == 1;
    const std::string completeness_status = truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (certified_count_policy && contour_result.count_certificate ?
            "certified" :
            "not_certified");
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"execution_lane\":\"production_cpu\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":true,"
        "\"tiny_validation_solver\":false,"
        "\"mfem_operator_request\":true,"
        "\"tangent_dof_count\":" +
        std::to_string(request.mfem_tangent_dof_count) +
        ",\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
        "\"algebraic_form\":\"gyrotropic_generalized\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_adapter\":\"contour_interval_solver\","
        "\"solver_model\":\"contour_interval_production_cpu_dense\","
        "\"solver_family\":\"contour_interval_production_cpu_dense\","
        "\"spectral_transform\":\"contour_integral\","
        "\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, exp_i_omega_t), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase)\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"stop_reason\":\"" +
        std::string(window_stop_reason) +
        "\",\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(contour_result.accepted_mode_count) +
        ",\"candidate_mode_count\":" +
        std::to_string(contour_result.estimated_mode_count) +
        ",\"relative_residual_max\":" +
        format_double(contour_max_relative_residual(contour_result)) +
        ",";
    result.diagnostics_json += production_contour_window_diagnostics_json(
        request,
        contour_result,
        truncated_by_requested_count);
    result.diagnostics_json += ",";
    result.diagnostics_json += contour_interval_diagnostics_json(contour_result);
    result.diagnostics_json += "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"solver_adapter\":\"contour_interval_solver\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"stop_reason\":\"" +
        std::string(window_stop_reason) +
        "\",\"accepted_mode_count\":" +
        std::to_string(contour_result.accepted_mode_count) +
        "," +
        mode_kinematics_json_fields(
            {std::real(first_mode.eigenvalue), std::imag(first_mode.eigenvalue)}) +
        ",\"relative_residual\":" +
        format_double(first_mode.relative_residual) +
        ",\"window_completeness\":\"" +
        completeness_status +
        "\",\"modes\":" +
        format_contour_modes_json(contour_result.modes) + "}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    result.artifact_manifest_path.clear();
    return result;
}

void emit_production_shift_invert_progress(
    const ModalEigenRequest &request,
    const ModalShiftSelection &shift,
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result,
    const char *stop_reason = nullptr) noexcept
{
    if (request.progress_callback == nullptr) {
        return;
    }

    const int outer_iteration =
        slepc_result.outer_iterations > 0 ? slepc_result.outer_iterations : 1;
    const int max_outer_iterations =
        slepc_result.max_outer_iterations > 0 ?
            slepc_result.max_outer_iterations :
            request.max_outer_iterations;
    const int linear_iteration =
        slepc_result.linear_iterations_total > 0 ?
            slepc_result.linear_iterations_total :
            1;
    const int max_linear_iterations =
        slepc_result.ksp_max_iterations > 0 ?
            slepc_result.ksp_max_iterations :
            request.max_linear_iterations;
    const std::string stop_reason_json = stop_reason == nullptr ?
        "null" :
        std::string("\"") + escape_json_string(stop_reason) + "\"";
    const std::string progress_json =
        "{\"schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_phase\":\"solving_shift_invert\","
        "\"execution_lane\":\"production_cpu\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count) +
        ",\"candidate_mode_count\":" +
        std::to_string(slepc_result.converged_eigenpair_count) +
        ",\"converged_mode_count\":" +
        std::to_string(slepc_result.converged_eigenpair_count) +
        ",\"current_shift_hz\":" +
        format_double(shift.shift_frequency_hz) +
        ",\"shift_frequency_hz\":" +
        format_double(shift.shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(shift.shift_omega_rad_s) +
        ",\"outer_iteration\":" +
        std::to_string(outer_iteration) +
        ",\"max_outer_iterations\":" +
        std::to_string(max_outer_iterations) +
        ",\"linear_iteration\":" +
        std::to_string(linear_iteration) +
        ",\"max_linear_iterations\":" +
        std::to_string(max_linear_iterations) +
        ",\"current_residual_relative_l2\":" +
        format_double(slepc_result.max_relative_residual) +
        ",\"target_residual_relative_l2\":" +
        format_double(request.residual_tolerance) +
        ",\"partial_artifacts_available\":false,"
        "\"latest_artifact_manifest_path\":\"\","
        "\"stop_reason\":" +
        stop_reason_json + "}";

    request.progress_callback(request.progress_user_data, progress_json.c_str());
}

FrequencyDomainContractResult solve_dense_production_modal_window_payload(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection,
    const FloquetPotentialReconstruction *reconstruction) noexcept
{
    FrequencyWindowPartition partition =
        partition_frequency_window(partition_request_from_modal_request(request));
    if (partition.subwindows.empty()) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen frequency window is invalid",
            "invalid_frequency_window");
    }

    SLEPcTangentMassActionContext tangent_mass_context{};
    const CsrMatrixView no_sparse_mass{};
    if (!create_slepc_tangent_mass_action_context(
            static_cast<int>(request.mfem_tangent_dof_count),
            request.mfem_mass_matrix_row_major,
            no_sparse_mass,
            &tangent_mass_context)) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dense tangent mass is missing or invalid",
            "invalid_tangent_mass_metric");
    }

    std::vector<DenseSubwindowSolve> subwindow_solves;
    subwindow_solves.reserve(partition.subwindows.size());
    std::vector<SLEPcModalAcceptedMode> candidate_modes;
    bool subwindow_hard_failure = false;
    const char *subwindow_failure_reason = nullptr;
    for (const FrequencySubwindow &subwindow : partition.subwindows) {
        SLEPcTinyGyrotropicModalEigenRequest slepc_request{};
        slepc_request.tangent_dof_count =
            static_cast<int>(request.mfem_tangent_dof_count);
        slepc_request.stiffness_matrix_row_major =
            request.mfem_stiffness_matrix_row_major;
        slepc_request.gyrotropic_matrix_row_major =
            request.mfem_gyrotropic_matrix_row_major;
        slepc_request.tangent_mass_matrix_row_major =
            request.mfem_mass_matrix_row_major;
        slepc_request.tangent_mass_action_context = &tangent_mass_context;
        slepc_request.requested_mode_count = subwindow.guard_modes_per_shift;
        slepc_request.target_frequency_hz = subwindow.shift_hz;
        slepc_request.frequency_min_hz = subwindow.search_min_hz;
        slepc_request.frequency_max_hz = subwindow.search_max_hz;
        slepc_request.residual_tolerance = request.residual_tolerance;
        slepc_request.max_outer_iterations = request.max_outer_iterations;
        slepc_request.max_linear_iterations = request.max_linear_iterations;
        slepc_request.phase_convention = request.phase_convention;
        SLEPcTinyGyrotropicModalEigenResult slepc_result =
            solve_modal_spectrum_for_request(request, slepc_request, reconstruction);
        const char *stop_reason = subwindow_stop_reason(slepc_result);
        emit_production_shift_invert_progress(
            request,
            subwindow_shift_selection(subwindow),
            slepc_result,
            std::strcmp(stop_reason, "converged") == 0 ? nullptr : stop_reason);

        for (SLEPcModalAcceptedMode mode : slepc_result.accepted_modes) {
            if (mode.frequency_hz < request.frequency_min_hz ||
                mode.frequency_hz > request.frequency_max_hz) {
                continue;
            }
            candidate_modes.push_back(std::move(mode));
        }
        subwindow_solves.push_back(
            DenseSubwindowSolve{subwindow, std::move(slepc_result), stop_reason});
        const DenseSubwindowSolve &completed_subwindow = subwindow_solves.back();
        if (subwindow_requires_fail_closed(
                completed_subwindow.result, request.completeness_policy)) {
            subwindow_hard_failure = true;
            subwindow_failure_reason = completed_subwindow.result.unsupported_reason;
            break;
        }
    }

    SLEPcModalCandidateFinalization finalization =
        finalize_slepc_modal_candidates_with_context(
            candidate_modes,
            tangent_mass_context,
            kWindowDedupFrequencyRelativeTolerance,
            kWindowDedupFrequencyAbsoluteToleranceHz,
            kWindowDedupOverlapThreshold,
            request.target_frequency_hz,
            request.requested_mode_count,
            SLEPcModalCandidateSelection::lowest_frequency);
    if (!finalization.success) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dense tangent mass is missing or invalid",
            "invalid_tangent_mass_metric");
    }
    std::vector<SLEPcModalAcceptedMode> accepted_modes =
        std::move(finalization.accepted_modes);
    const std::size_t accepted_mode_count_before_cap =
        finalization.unique_candidate_count_before_cap;
    const bool truncated_by_requested_count =
        finalization.truncated_by_requested_count;
    const bool exhausted_without_modes =
        !truncated_by_requested_count &&
        accepted_modes.empty() &&
        !subwindow_solves.empty() &&
        std::all_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return std::strcmp(solve.stop_reason, "window_exhausted") == 0 ||
                    std::strcmp(solve.stop_reason, "converged") == 0;
            });
    const bool partial_convergence =
        std::any_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return std::strcmp(solve.stop_reason, "window_exhausted") != 0 &&
                    std::strcmp(solve.stop_reason, "converged") != 0;
            });
    const bool generic_refill_partial = std::any_of(
        subwindow_solves.begin(),
        subwindow_solves.end(),
        [](const DenseSubwindowSolve &solve) {
            return solve.result.solver_adapter != nullptr &&
                std::strcmp(solve.result.solver_adapter, "slepc_modal_eigen") == 0 &&
                solve.result.status != nullptr &&
                std::strcmp(solve.result.status, "partial") == 0;
        });
    const bool generic_dimension_limited_partial = std::any_of(
        subwindow_solves.begin(),
        subwindow_solves.end(),
        [](const DenseSubwindowSolve &solve) {
            return solve.result.solver_adapter != nullptr &&
                std::strcmp(solve.result.solver_adapter, "slepc_modal_eigen") == 0 &&
                solve.result.status != nullptr &&
                std::strcmp(solve.result.status, "partial") == 0 &&
                solve.result.unsupported_reason != nullptr &&
                std::strcmp(
                    solve.result.unsupported_reason,
                    "slepc_modal_nev_refill_dimension_limit_reached") == 0;
        });
    const bool best_effort_dimension_limited_partial_with_modes =
        request.completeness_policy == 0 &&
        generic_dimension_limited_partial &&
        !subwindow_hard_failure &&
        !accepted_modes.empty();
    if (generic_dimension_limited_partial && accepted_modes.empty()) {
        subwindow_hard_failure = true;
        subwindow_failure_reason =
            "slepc_modal_nev_refill_dimension_limit_reached";
    }
    const bool window_complete =
        !subwindow_hard_failure &&
        !best_effort_dimension_limited_partial_with_modes &&
        !generic_refill_partial;
    const char *window_stop_reason = subwindow_hard_failure
        ? "subwindow_failed" : (truncated_by_requested_count ?
        "requested_count_reached" :
        (accepted_modes.empty() ?
            (partial_convergence ? "partial_convergence" : "window_exhausted") :
            (partial_convergence ? "partial_convergence" : "converged")));
    const char *window_completeness_status = subwindow_hard_failure
        ? "solver_error" : (truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (exhausted_without_modes ? "window_exhausted" :
            (partial_convergence ? "partial_convergence" : "not_certified")));
    for (std::size_t index = 0; index < accepted_modes.size(); ++index) {
        accepted_modes[index].positive_frequency_pair_index =
            static_cast<int>(index);
    }

    FrequencyDomainContractResult result{};
    const std::string window_diagnostics = production_window_diagnostics_json(
        request,
        partition,
        subwindow_solves,
        accepted_modes,
        accepted_mode_count_before_cap,
        truncated_by_requested_count);
    if (subwindow_hard_failure || accepted_modes.empty()) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message = subwindow_hard_failure
            ? "native FEM modal_eigen production CPU multi-shift solve stopped after an incomplete or failed subwindow: " +
                std::string(subwindow_failure_reason != nullptr
                    ? subwindow_failure_reason : "subwindow_solver_failed")
            : "native FEM modal_eigen production CPU multi-shift solve found no accepted modes in the requested window";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"production_cpu\","
            "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
            "\"production_solver_available\":true,"
            "\"tiny_validation_solver\":false,"
            "\"mfem_operator_request\":true,"
            "\"tangent_dof_count\":" +
            std::to_string(request.mfem_tangent_dof_count) +
            ",\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"solver_selection_reason\":\"" +
            std::string(selection.reason) +
            "\",\"spectral_transform\":\"shift_invert\","
            "\"solver_model\":\"slepc_multi_shift_invert_production_cpu_dense\","
            "\"stop_reason\":\"" +
            std::string(window_stop_reason) +
            "\",";
        if (subwindow_hard_failure && subwindow_failure_reason != nullptr) {
            result.diagnostics_json +=
                "\"failure_reason\":\"" +
                escape_json_string(subwindow_failure_reason) + "\",";
        }
        result.diagnostics_json += window_diagnostics;
        result.diagnostics_json += "}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0,"
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"stop_reason\":\"" +
            std::string(window_stop_reason) +
            "\",\"window_completeness\":\"" +
            std::string(window_completeness_status) +
            "\"}";
        return result;
    }

    double max_relative_residual = 0.0;
    for (const SLEPcModalAcceptedMode &mode : accepted_modes) {
        max_relative_residual =
            std::max(max_relative_residual, mode.relative_residual);
    }
    const SLEPcModalAcceptedMode &first_mode = accepted_modes.front();
    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    const char *deduplication_inner_product = "mfem_tangent_mass";
    const char *deduplication_mass_matrix = "provided_dense_row_major";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":" + std::string(window_complete ? "true" : "false") + ","
        "\"execution_lane\":\"production_cpu\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":true,"
        "\"tiny_validation_solver\":false,"
        "\"mfem_operator_request\":true,"
        "\"tangent_dof_count\":" +
        std::to_string(request.mfem_tangent_dof_count) +
        ",\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
        "\"algebraic_form\":\"gyrotropic_generalized\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_adapter\":\"slepc_modal_eigen\","
        "\"solver_model\":\"slepc_multi_shift_invert_production_cpu_dense\","
        "\"solver_family\":\"slepc_multi_shift_invert_production_cpu_dense\","
        "\"spectral_transform\":\"shift_invert\","
        "\"stop_reason\":\"" +
        std::string(window_stop_reason) +
        "\","
        "\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, exp_i_omega_t), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase)\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(accepted_modes.size()) +
        ",\"relative_residual_max\":" +
        format_double(max_relative_residual) +
        ",\"candidate_mode_count_before_dedup\":" +
        std::to_string(candidate_modes.size()) +
        ",\"deduplication_frequency_relative_tolerance\":" +
        format_double(kWindowDedupFrequencyRelativeTolerance) +
        ",\"deduplication_frequency_absolute_tolerance_hz\":" +
        format_double(kWindowDedupFrequencyAbsoluteToleranceHz) +
        ",\"deduplication_overlap_threshold\":" +
        format_double(kWindowDedupOverlapThreshold) +
        ",\"deduplication_inner_product\":\"" +
        std::string(deduplication_inner_product) +
        "\",\"deduplication_mass_matrix\":\"" +
        std::string(deduplication_mass_matrix) + "\"" +
        ",";
    result.diagnostics_json += window_diagnostics;
    result.diagnostics_json += "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"solver_adapter\":\"slepc_modal_eigen\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"stop_reason\":\"" +
        std::string(window_stop_reason) +
        "\",\"accepted_mode_count\":" +
        std::to_string(accepted_modes.size()) +
        "," +
        mode_kinematics_json_fields({first_mode.lambda_real, first_mode.lambda_imag}) +
        ",\"relative_residual\":" +
        format_double(first_mode.relative_residual) +
        ",\"window_completeness\":\"" +
        std::string(window_completeness_status) +
        "\","
        "\"modes\":" +
        format_slepc_modes_json(accepted_modes) + "}";
    result.artifact_manifest_path.clear();
    return result;
}

FrequencyDomainContractResult solve_dense_production_modal_payload(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection,
    const ModalShiftSelection &shift,
    const FloquetPotentialReconstruction *reconstruction) noexcept
{
    if (request.mfem_tangent_dof_count >
        static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dense payload is too large for the current SLEPc adapter ABI",
            "mfem_modal_operator_payload_too_large_for_dense_adapter");
    }

    std::vector<double> effective_stiffness;
    const double *stiffness = nullptr;
    if (!effective_dense_stiffness_for_request(
            request,
            effective_stiffness,
            &stiffness)) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dynamic demag-k payload is malformed",
            "invalid_dynamic_demag_k_tangent_matrix");
    }
    ModalEigenRequest effective_request = request;
    effective_request.mfem_stiffness_matrix_row_major = stiffness;

    if (is_frequency_window(request)) {
        return solve_dense_production_modal_window_payload(effective_request, selection, reconstruction);
    }

    SLEPcTangentMassActionContext tangent_mass_context{};
    const CsrMatrixView no_sparse_mass{};
    if (!create_slepc_tangent_mass_action_context(
            static_cast<int>(request.mfem_tangent_dof_count),
            request.mfem_mass_matrix_row_major,
            no_sparse_mass,
            &tangent_mass_context)) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dense tangent mass is missing or invalid",
            "invalid_tangent_mass_metric");
    }

    SLEPcTinyGyrotropicModalEigenRequest slepc_request{};
    slepc_request.tangent_dof_count =
        static_cast<int>(request.mfem_tangent_dof_count);
    slepc_request.stiffness_matrix_row_major =
        stiffness;
    slepc_request.gyrotropic_matrix_row_major =
        request.mfem_gyrotropic_matrix_row_major;
    slepc_request.tangent_mass_matrix_row_major =
        request.mfem_mass_matrix_row_major;
    slepc_request.tangent_mass_action_context = &tangent_mass_context;
    slepc_request.requested_mode_count = request.requested_mode_count;
    slepc_request.target_frequency_hz = shift.shift_frequency_hz;
    slepc_request.frequency_min_hz = request.frequency_min_hz;
    slepc_request.frequency_max_hz = request.frequency_max_hz;
    slepc_request.residual_tolerance = request.residual_tolerance;
    slepc_request.max_outer_iterations = request.max_outer_iterations;
    slepc_request.max_linear_iterations = request.max_linear_iterations;
    slepc_request.phase_convention = request.phase_convention;
    const SLEPcTinyGyrotropicModalEigenResult slepc_result =
        solve_modal_spectrum_for_request(request, slepc_request, reconstruction);

    FrequencyDomainContractResult result{};
    if (!slepc_result.ok) {
        const char *stop_reason = stop_reason_or_default(slepc_result);
        const bool generic_slepc_result =
            slepc_result.solver_adapter != nullptr &&
            std::strcmp(slepc_result.solver_adapter, "slepc_modal_eigen") == 0;
        const bool generic_refill_partial =
            generic_slepc_result &&
            slepc_result.status != nullptr &&
            std::strcmp(slepc_result.status, "partial") == 0;
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message = generic_refill_partial
            ? "native FEM modal_eigen nearest-frequency solve did not certify the requested count; certified partial candidates remain diagnostic only"
            : "native FEM modal_eigen production CPU SLEPc shift-invert solve failed";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"production_cpu\","
            "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
            "\"production_solver_available\":true,"
            "\"tiny_validation_solver\":false,"
            "\"mfem_operator_request\":true,"
            "\"tangent_dof_count\":" +
            std::to_string(request.mfem_tangent_dof_count) +
            ",\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"solver_selection_reason\":\"" +
            std::string(selection.reason) +
            "\",\"spectral_transform\":\"shift_invert\","
            "\"solver_adapter\":\"" +
            std::string(slepc_result.solver_adapter) +
            "\",\"solver_model\":\"slepc_shift_invert_production_cpu\","
            "\"solver_family\":\"slepc_shift_invert_production_cpu\","
            "\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s) +
            ",\"stop_reason\":\"" +
            std::string(stop_reason) +
            "\"}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
        if (generic_slepc_result) {
            append_optional_json_field(
                result.diagnostics_json,
                generic_slepc_nev_refill_json_field(slepc_result));
            if (generic_refill_partial || !slepc_result.accepted_modes.empty()) {
                append_optional_json_field(
                    result.diagnostics_json,
                    "\"certified_partial_candidate_count\":" +
                        std::to_string(slepc_result.accepted_modes.size()) + "," +
                        format_slepc_partial_candidate_metadata_json(
                            slepc_result.accepted_modes));
            }
        }
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0,"
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s) +
            "}";
        append_nearest_frequency_metadata(result.result_json, request, result.status);
        return result;
    }

    emit_production_shift_invert_progress(request, shift, slepc_result);

    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"execution_lane\":\"production_cpu\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":true,"
        "\"tiny_validation_solver\":false,"
        "\"mfem_operator_request\":true,"
        "\"tangent_dof_count\":" +
        std::to_string(request.mfem_tangent_dof_count) +
        ",\"mfem_operator_payload\":\"dense_gyrotropic_matrix\","
        "\"algebraic_form\":\"gyrotropic_generalized\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_adapter\":\"" +
        std::string(slepc_result.solver_adapter) +
        "\",\"solver_model\":\"slepc_shift_invert_production_cpu\","
        "\"solver_family\":\"slepc_shift_invert_production_cpu\","
        "\"execution_policy\":\"" +
        std::string(slepc_result.execution_policy) +
        "\",\"execution_scope\":\"" +
        std::string(slepc_result.execution_scope) +
        "\",\"communicator\":\"" +
        std::string(slepc_result.communicator) +
        "\",\"scalability_scope\":\"" +
        std::string(slepc_result.scalability_scope) +
        "\",\"poisson_ksp_type\":\"" +
        std::string(slepc_result.poisson_ksp_type) +
        "\",\"poisson_pc_type\":\"" +
        std::string(slepc_result.poisson_pc_type) +
        "\",\"poisson_factorization_package\":\"" +
        std::string(slepc_result.poisson_factorization_package) +
        "\",\"poisson_factorization_shift_policy\":\"" +
        std::string(slepc_result.poisson_factorization_shift_policy) +
        "\",\"poisson_iteration_semantics\":\"" +
        std::string(slepc_result.poisson_iteration_semantics) +
        "\",\"poisson_ksp_rtol\":" +
        format_double(slepc_result.poisson_ksp_rtol) +
        ",\"poisson_ksp_atol\":" +
        format_double(slepc_result.poisson_ksp_atol) +
        ",\"poisson_ksp_max_iterations\":" +
        std::to_string(slepc_result.poisson_ksp_max_iterations) +
        ","
        "\"eps_type\":\"" +
        std::string(slepc_result.eps_type) +
        "\",\"slepc_problem_type\":\"" +
        std::string(slepc_result.problem_type) +
        "\",\"spectral_transform\":\"" +
        std::string(slepc_result.spectral_transform) +
        "\",\"which_eigenpairs\":\"" +
        std::string(slepc_result.which_eigenpairs) +
        "\",\"ksp_type\":\"" +
        std::string(slepc_result.ksp_type) +
        "\",\"pc_type\":\"" +
        std::string(slepc_result.pc_type) +
        "\",\"ksp_rtol\":" +
        format_double(slepc_result.ksp_rtol) +
        ",\"ksp_atol\":" +
        format_double(slepc_result.ksp_atol) +
        ",\"ksp_max_iterations\":" +
        std::to_string(slepc_result.ksp_max_iterations) +
        ",\"ksp_restart\":" +
        std::to_string(slepc_result.ksp_restart) +
        ",\"ksp_breakdown_tolerance\":" +
        format_double(slepc_result.ksp_breakdown_tolerance) +
        ",\"ksp_final_residual\":" +
        format_double(slepc_result.ksp_final_residual) +
        ",\"factorization_package\":\"" +
        std::string(slepc_result.factorization_package) +
        "\",\"factorization_shift_policy\":\"" +
        std::string(slepc_result.factorization_shift_policy) +
        "\",\"factorization_shift_amount\":" +
        format_double(slepc_result.factorization_shift_amount) +
        ",\"operator_normalization_scale\":" +
        format_double(slepc_result.operator_normalization_scale) +
        ",\"preconditioner_normalization_scale\":" +
        format_double(slepc_result.preconditioner_normalization_scale) +
        ",\"nullspace_policy\":\"" +
        std::string(slepc_result.nullspace_policy) +
        "\",\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, exp_i_omega_t), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase)\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count) +
        ","
        "\"candidate_mode_count\":" +
        std::to_string(slepc_result.converged_eigenpair_count) +
        ",\"shift_frequency_hz\":" +
        format_double(shift.shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(shift.shift_omega_rad_s) +
        ",\"outer_iteration\":" +
        std::to_string(slepc_result.outer_iterations) +
        ",\"linear_iteration\":1,"
        "\"linear_iterations_total\":" +
        std::to_string(slepc_result.linear_iterations_total) +
        ",\"relative_residual_max\":" +
        format_double(slepc_result.max_relative_residual) + "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    append_optional_json_field(
        result.diagnostics_json,
        generic_slepc_nev_refill_json_field(slepc_result));
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"solver_adapter\":\"" +
        std::string(slepc_result.solver_adapter) +
        "\",\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count) +
        ","
        + mode_kinematics_json_fields(
            {slepc_result.lambda_real, slepc_result.lambda_imag}) +
        ",\"relative_residual\":" +
        format_double(slepc_result.relative_residual) +
        ",\"shift_frequency_hz\":" +
        format_double(shift.shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(shift.shift_omega_rad_s) +
        ",\"modes\":" +
        format_slepc_modes_json(slepc_result) + "}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    result.artifact_manifest_path.clear();
    return result;
}

FrequencyDomainContractResult solve_sparse_production_modal_window_payload(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection) noexcept;

FrequencyDomainContractResult solve_sparse_production_modal_payload(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection,
    const ModalShiftSelection &shift) noexcept
{
    if (sparse_modal_tangent_dof_count(request) >
        static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        return sparse_payload_validation_error(
            request,
            "native FEM modal_eigen sparse payload is too large for the current SLEPc adapter ABI",
            "mfem_modal_operator_payload_too_large_for_sparse_adapter");
    }

    if (is_frequency_window(request)) {
        return solve_sparse_production_modal_window_payload(request, selection);
    }

    const bool shared_domain_floquet =
        request.floquet_shared_domain_operator != nullptr;
    const bool native_floquet_sparse = shared_domain_floquet;
    SLEPcTangentMassActionContext tangent_mass_context{};
    if (!shared_domain_floquet &&
        !create_slepc_tangent_mass_action_context(
            static_cast<int>(sparse_modal_tangent_dof_count(request)),
            nullptr,
            request.mfem_sparse_mass_csr,
            &tangent_mass_context)) {
        return sparse_payload_validation_error(
            request,
            "native FEM modal_eigen sparse tangent mass is missing or invalid",
            "invalid_tangent_mass_metric");
    }

    SLEPcSparseGyrotropicModalEigenRequest slepc_request{};
    slepc_request.tangent_dof_count =
        static_cast<int>(sparse_modal_tangent_dof_count(request));
    slepc_request.stiffness_csr = request.mfem_sparse_stiffness_csr;
    slepc_request.gyrotropic_csr = request.mfem_sparse_gyrotropic_csr;
    slepc_request.tangent_mass_csr = request.mfem_sparse_mass_csr;
    slepc_request.tangent_mass_action_context = shared_domain_floquet
        ? nullptr : &tangent_mass_context;
    slepc_request.floquet_shared_domain_operator =
        request.floquet_shared_domain_operator;
    slepc_request.requested_mode_count = request.requested_mode_count;
    slepc_request.target_frequency_hz = shift.shift_frequency_hz;
    slepc_request.frequency_min_hz = request.frequency_min_hz;
    slepc_request.frequency_max_hz = request.frequency_max_hz;
    slepc_request.residual_tolerance = request.residual_tolerance;
    slepc_request.max_outer_iterations = request.max_outer_iterations;
    slepc_request.max_linear_iterations = request.max_linear_iterations;
    slepc_request.phase_convention = request.phase_convention;
    slepc_request.cancel_user_data = request.cancel_user_data;
    slepc_request.cancel_requested = request.cancel_requested;
    const SLEPcTinyGyrotropicModalEigenResult slepc_result =
        solve_sparse_modal_spectrum_for_request(request, slepc_request, nullptr);

    FrequencyDomainContractResult result{};
    const char *kSparsePayload = native_floquet_sparse
        ? "floquet_shared_domain_sparse_matshell"
        : "sparse_csr";
    const char *kSparseAdapter = native_floquet_sparse
        ? "floquet_airbox_cpu_schur_slepc"
        : "slepc_modal_eigen";
    const char *kSparseSolverModel = native_floquet_sparse
        ? "floquet_real_frequency_slepc_sparse"
        : "slepc_shift_invert_production_cpu_sparse_csr";
    const std::string demag_probe_json_field =
        floquet_demag_operator_probe_json_field(
            slepc_result.dynamic_demag_operator_probe);
    const std::string schur_action_diagnostic_json_field =
        floquet_schur_action_diagnostic_json_field(
            slepc_result.floquet_schur_action_diagnostic);
    const std::string shifted_ksp_diagnostics_json_fields = floquet_shifted_ksp_diagnostics_json_fields(
        slepc_result, !slepc_result.ok);
    if (!slepc_result.ok) {
        const char *stop_reason = stop_reason_or_default(slepc_result);
        const bool cancelled =
            slepc_result.status != nullptr &&
            std::strcmp(slepc_result.status, "cancelled") == 0;
        const bool partial =
            slepc_result.status != nullptr &&
            std::strcmp(slepc_result.status, "partial") == 0;
        const bool generic_slepc_result =
            !native_floquet_sparse &&
            slepc_result.solver_adapter != nullptr &&
            std::strcmp(slepc_result.solver_adapter, "slepc_modal_eigen") == 0;
        const bool generic_refill_partial = generic_slepc_result && partial;
        result.status = cancelled
            ? FrequencyDomainStatus::interrupted
            : FrequencyDomainStatus::solve_error;
        result.error_message = cancelled
            ? "native FEM modal_eigen production CPU sparse CSR SLEPc shift-invert solve was cancelled"
            : generic_refill_partial
                ? "native FEM modal_eigen nearest-frequency solve did not certify the requested count; certified partial candidates remain diagnostic only"
                : partial
                    ? "native FEM modal_eigen production CPU sparse CSR SLEPc shift-invert solve did not certify the requested mode count"
                : "native FEM modal_eigen production CPU sparse CSR SLEPc shift-invert solve failed";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"" +
            std::string(cancelled ? "interrupted" : "solve_error") +
            "\","
            "\"complete\":false,"
            "\"execution_lane\":\"production_cpu\","
            "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
            "\"production_solver_available\":true,"
            "\"tiny_validation_solver\":false,"
            "\"mfem_operator_request\":true,"
            "\"tangent_dof_count\":" +
            std::to_string(sparse_modal_tangent_dof_count(request)) +
            ",\"mfem_operator_payload\":\"" +
            std::string(kSparsePayload) + "\","
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"solver_selection_reason\":\"" +
            std::string(selection.reason) +
            "\",\"spectral_transform\":\"shift_invert\","
            "\"solver_adapter\":\"" +
            std::string(slepc_result.solver_adapter) +
            "\",\"solver_model\":\"" +
            std::string(kSparseSolverModel) +
            "\",\"solver_family\":\"" +
            std::string(kSparseSolverModel) +
            "\",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s) +
            ",\"stop_reason\":\"" +
            std::string(stop_reason) +
            "\"}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
        if (generic_slepc_result) {
            append_optional_json_field(
                result.diagnostics_json,
                generic_slepc_nev_refill_json_field(slepc_result));
            if (generic_refill_partial || !slepc_result.accepted_modes.empty()) {
                append_optional_json_field(
                    result.diagnostics_json,
                    "\"certified_partial_candidate_count\":" +
                        std::to_string(slepc_result.accepted_modes.size()) + "," +
                        format_slepc_partial_candidate_metadata_json(
                            slepc_result.accepted_modes));
            }
        }
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"" +
            std::string(cancelled ? "interrupted" : "solve_error") +
            "\","
            "\"accepted_mode_count\":" +
            std::to_string(generic_slepc_result ? 0 : slepc_result.accepted_mode_count) +
            ",\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s) +
            ",\"stop_reason\":\"" +
            std::string(stop_reason) +
            "\"";
        if (!generic_slepc_result) {
            result.result_json +=
                ",\"modes\":" + format_slepc_modes_json(slepc_result);
        }
        result.result_json += "}";
        append_nearest_frequency_metadata(result.result_json, request, result.status);
        append_optional_json_field(
            result.diagnostics_json, shifted_ksp_diagnostics_json_fields);
        append_optional_json_field(result.diagnostics_json, demag_probe_json_field);
        append_optional_json_field(result.result_json, demag_probe_json_field);
        append_optional_json_field(
            result.diagnostics_json, schur_action_diagnostic_json_field);
        append_optional_json_field(
            result.result_json, schur_action_diagnostic_json_field);
        return result;
    }

    emit_production_shift_invert_progress(request, shift, slepc_result);

    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"execution_lane\":\"production_cpu\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":true,"
        "\"tiny_validation_solver\":false,"
        "\"mfem_operator_request\":true,"
        "\"tangent_dof_count\":" +
        std::to_string(sparse_modal_tangent_dof_count(request)) +
        ",\"mfem_operator_payload\":\"" +
        std::string(kSparsePayload) + "\","
        "\"algebraic_form\":\"real_frequency_rotated_gyrotropic_sparse_csr\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_adapter\":\"" +
        std::string(slepc_result.solver_adapter) +
        "\",\"solver_model\":\"" +
        std::string(kSparseSolverModel) +
        "\",\"solver_family\":\"" +
        std::string(kSparseSolverModel) +
        "\",\"execution_policy\":\"" +
        std::string(slepc_result.execution_policy) +
        "\",\"execution_scope\":\"" +
        std::string(slepc_result.execution_scope) +
        "\",\"communicator\":\"" +
        std::string(slepc_result.communicator) +
        "\",\"scalability_scope\":\"" +
        std::string(slepc_result.scalability_scope) +
        "\",\"poisson_ksp_type\":\"" +
        std::string(slepc_result.poisson_ksp_type) +
        "\",\"poisson_pc_type\":\"" +
        std::string(slepc_result.poisson_pc_type) +
        "\",\"poisson_factorization_package\":\"" +
        std::string(slepc_result.poisson_factorization_package) +
        "\",\"poisson_factorization_shift_policy\":\"" +
        std::string(slepc_result.poisson_factorization_shift_policy) +
        "\",\"poisson_iteration_semantics\":\"" +
        std::string(slepc_result.poisson_iteration_semantics) +
        "\",\"poisson_ksp_rtol\":" +
        format_double(slepc_result.poisson_ksp_rtol) +
        ",\"poisson_ksp_atol\":" +
        format_double(slepc_result.poisson_ksp_atol) +
        ",\"poisson_ksp_max_iterations\":" +
        std::to_string(slepc_result.poisson_ksp_max_iterations) +
        ",\"eps_type\":\"" +
        std::string(slepc_result.eps_type) +
        "\",\"slepc_problem_type\":\"" +
        std::string(slepc_result.problem_type) +
        "\",\"spectral_transform\":\"" +
        std::string(slepc_result.spectral_transform) +
        "\",\"which_eigenpairs\":\"" +
        std::string(slepc_result.which_eigenpairs) +
        "\",\"ksp_type\":\"" +
        std::string(slepc_result.ksp_type) +
        "\",\"pc_type\":\"" +
        std::string(slepc_result.pc_type) +
        "\",\"ksp_rtol\":" +
        format_double(slepc_result.ksp_rtol) +
        ",\"ksp_atol\":" +
        format_double(slepc_result.ksp_atol) +
        ",\"ksp_max_iterations\":" +
        std::to_string(slepc_result.ksp_max_iterations) +
        ",\"ksp_restart\":" +
        std::to_string(slepc_result.ksp_restart) +
        ",\"ksp_breakdown_tolerance\":" +
        format_double(slepc_result.ksp_breakdown_tolerance) +
        ",\"ksp_final_residual\":" +
        format_double(slepc_result.ksp_final_residual) +
        ",\"factorization_package\":\"" +
        std::string(slepc_result.factorization_package) +
        "\",\"factorization_shift_policy\":\"" +
        std::string(slepc_result.factorization_shift_policy) +
        "\",\"factorization_shift_amount\":" +
        format_double(slepc_result.factorization_shift_amount) +
        ",\"operator_normalization_scale\":" +
        format_double(slepc_result.operator_normalization_scale) +
        ",\"preconditioner_normalization_scale\":" +
        format_double(slepc_result.preconditioner_normalization_scale) +
        ",\"nullspace_policy\":\"" +
        std::string(slepc_result.nullspace_policy) +
        "\",\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, exp_i_omega_t), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase)\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count) +
        ",\"candidate_mode_count\":" +
        std::to_string(slepc_result.converged_eigenpair_count) +
        ",\"shift_frequency_hz\":" +
        format_double(shift.shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(shift.shift_omega_rad_s) +
        ",\"outer_iteration\":" +
        std::to_string(slepc_result.outer_iterations) +
        ",\"linear_iteration\":1,"
        "\"linear_iterations_total\":" +
        std::to_string(slepc_result.linear_iterations_total) +
        ",\"relative_residual_max\":" +
        format_double(slepc_result.max_relative_residual) + "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    append_optional_json_field(
        result.diagnostics_json,
        generic_slepc_nev_refill_json_field(slepc_result));
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"solver_adapter\":\"" +
        std::string(kSparseAdapter) +
        "\",\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count) +
        "," +
        mode_kinematics_json_fields(
            {slepc_result.lambda_real, slepc_result.lambda_imag}) +
        ",\"relative_residual\":" +
        format_double(slepc_result.relative_residual) +
        ",\"shift_frequency_hz\":" +
        format_double(shift.shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(shift.shift_omega_rad_s) +
        ",\"modes\":" +
        format_slepc_modes_json(slepc_result) + "}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    append_optional_json_field(
        result.diagnostics_json, shifted_ksp_diagnostics_json_fields);
    append_optional_json_field(result.diagnostics_json, demag_probe_json_field);
    append_optional_json_field(result.result_json, demag_probe_json_field);
    append_optional_json_field(
        result.diagnostics_json, schur_action_diagnostic_json_field);
    append_optional_json_field(
        result.result_json, schur_action_diagnostic_json_field);
    result.artifact_manifest_path.clear();
    return result;
}

FrequencyDomainContractResult solve_sparse_production_modal_window_payload(
    const ModalEigenRequest &request,
    const ModalSolverSelection &selection) noexcept
{
    if (sparse_modal_tangent_dof_count(request) >
        static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        return sparse_payload_validation_error(
            request,
            "native FEM modal_eigen sparse payload is too large for the current SLEPc adapter ABI",
            "mfem_modal_operator_payload_too_large_for_sparse_adapter");
    }

    FrequencyWindowPartition partition =
        partition_frequency_window(partition_request_from_modal_request(request));
    if (partition.subwindows.empty()) {
        return sparse_payload_validation_error(
            request,
            "native FEM modal_eigen sparse CSR frequency window is invalid",
            "invalid_frequency_window");
    }

    const bool shared_domain_floquet =
        request.floquet_shared_domain_operator != nullptr;
    const bool native_floquet_sparse = shared_domain_floquet;
    const bool native_floquet_certified_count_unavailable =
        native_floquet_sparse && request.completeness_policy == 1;
    SLEPcTangentMassActionContext tangent_mass_context{};
    if (!shared_domain_floquet &&
        !create_slepc_tangent_mass_action_context(
            static_cast<int>(sparse_modal_tangent_dof_count(request)),
            nullptr,
            request.mfem_sparse_mass_csr,
            &tangent_mass_context)) {
        return sparse_payload_validation_error(
            request,
            "native FEM modal_eigen sparse tangent mass is missing or invalid",
            "invalid_tangent_mass_metric");
    }

    std::vector<DenseSubwindowSolve> subwindow_solves;
    subwindow_solves.reserve(partition.subwindows.size());
    std::vector<SLEPcModalAcceptedMode> candidate_modes;
    bool subwindow_hard_failure = false;
    bool cancellation_interrupted = false;
    bool generic_slepc_refill_partial = false;
    bool generic_slepc_refill_dimension_limited = false;
    bool generic_slepc_refill_other_partial = false;
    bool native_floquet_refill_partial = false;
    bool native_floquet_refill_dimension_limited = false;
    bool native_floquet_refill_other_partial = false;
    const char *subwindow_failure_reason = nullptr;
    FloquetSharedDomainSparseModalSolveContext floquet_window_context{};
    FloquetSharedDomainSparseModalSolveContext *reuse_context =
        request.floquet_shared_domain_operator != nullptr
            ? &floquet_window_context
            : nullptr;
    for (const FrequencySubwindow &subwindow : partition.subwindows) {
        SLEPcSparseGyrotropicModalEigenRequest slepc_request{};
        slepc_request.tangent_dof_count =
            static_cast<int>(sparse_modal_tangent_dof_count(request));
        slepc_request.stiffness_csr = request.mfem_sparse_stiffness_csr;
        slepc_request.gyrotropic_csr = request.mfem_sparse_gyrotropic_csr;
        slepc_request.tangent_mass_csr = request.mfem_sparse_mass_csr;
        slepc_request.tangent_mass_action_context = shared_domain_floquet
            ? nullptr
            : &tangent_mass_context;
        slepc_request.floquet_shared_domain_operator =
            request.floquet_shared_domain_operator;
        slepc_request.requested_mode_count = subwindow.guard_modes_per_shift;
        slepc_request.target_frequency_hz = subwindow.shift_hz;
        slepc_request.frequency_min_hz = subwindow.search_min_hz;
        slepc_request.frequency_max_hz = subwindow.search_max_hz;
        slepc_request.residual_tolerance = request.residual_tolerance;
        slepc_request.max_outer_iterations = request.max_outer_iterations;
        slepc_request.max_linear_iterations = request.max_linear_iterations;
        slepc_request.phase_convention = request.phase_convention;
        slepc_request.cancel_user_data = request.cancel_user_data;
        slepc_request.cancel_requested = request.cancel_requested;
        SLEPcTinyGyrotropicModalEigenResult slepc_result =
            solve_sparse_modal_spectrum_for_request(
                request,
                slepc_request,
                reuse_context);
        if (slepc_result.status != nullptr &&
            std::strcmp(slepc_result.status, "partial") == 0) {
            const bool generic_slepc_adapter =
                slepc_result.solver_adapter != nullptr &&
                std::strcmp(slepc_result.solver_adapter, "slepc_modal_eigen") == 0;
            if (generic_slepc_adapter) {
                generic_slepc_refill_partial = true;
                if (slepc_result.unsupported_reason != nullptr &&
                    std::strcmp(
                        slepc_result.unsupported_reason,
                        "slepc_modal_nev_refill_dimension_limit_reached") == 0) {
                    generic_slepc_refill_dimension_limited = true;
                } else {
                    generic_slepc_refill_other_partial = true;
                }
            } else {
                native_floquet_refill_partial = true;
                if (slepc_result.unsupported_reason != nullptr &&
                    std::strcmp(
                        slepc_result.unsupported_reason,
                        "floquet_nev_refill_dimension_limit_reached") == 0) {
                    native_floquet_refill_dimension_limited = true;
                } else {
                    native_floquet_refill_other_partial = true;
                }
            }
        }
        const char *stop_reason = subwindow_stop_reason(slepc_result);
        emit_production_shift_invert_progress(
            request,
            subwindow_shift_selection(subwindow),
            slepc_result,
            std::strcmp(stop_reason, "converged") == 0 ? nullptr : stop_reason);

        for (SLEPcModalAcceptedMode mode : slepc_result.accepted_modes) {
            if (mode.frequency_hz < request.frequency_min_hz ||
                mode.frequency_hz > request.frequency_max_hz) {
                continue;
            }
            candidate_modes.push_back(std::move(mode));
        }
        subwindow_solves.push_back(
            DenseSubwindowSolve{subwindow, std::move(slepc_result), stop_reason});
        const DenseSubwindowSolve &completed_subwindow = subwindow_solves.back();
        if (subwindow_requires_fail_closed(
                completed_subwindow.result, request.completeness_policy)) {
            subwindow_hard_failure = true;
            subwindow_failure_reason = completed_subwindow.result.unsupported_reason;
            break;
        }
        if (completed_subwindow.result.status != nullptr &&
            std::strcmp(completed_subwindow.result.status, "cancelled") == 0) {
            cancellation_interrupted = true;
            break;
        }
    }

    std::vector<SLEPcModalAcceptedMode> accepted_modes;
    std::size_t accepted_mode_count_before_cap = 0;
    bool truncated_by_requested_count = false;
    if (request.floquet_shared_domain_operator != nullptr) {
        // All subwindow candidates refer to the same owned phase-reduced
        // tangent space. Reuse its physical mass without a dense allocation.
        std::vector<detail::CertifiedFloquetModalCandidate> merge_candidates;
        merge_candidates.reserve(candidate_modes.size());
        for (SLEPcModalAcceptedMode &mode : candidate_modes) {
            detail::CertifiedFloquetModalCandidate candidate{};
            candidate.mode = std::move(mode);
            candidate.target_distance = 0.0;
            merge_candidates.push_back(std::move(candidate));
        }
        const std::size_t merge_candidate_count = merge_candidates.size();
        detail::FloquetModalCandidateFinalization merged =
            detail::finalize_certified_floquet_candidates(
                std::move(merge_candidates),
                request.floquet_shared_domain_operator->q_complex_dof_count,
                request.floquet_shared_domain_operator->positive_tangent_mass,
                merge_candidate_count);
        if (!merged.success) {
            // Never turn a failed metric into an empty/exhausted success,
            // and retain an earlier hard subwindow failure if one occurred.
            if (!subwindow_hard_failure) {
                subwindow_hard_failure = true;
                subwindow_failure_reason = merged.failure_reason;
            }
        } else {
            accepted_modes.reserve(merged.accepted_candidates.size());
            for (detail::CertifiedFloquetModalCandidate &candidate :
                 merged.accepted_candidates) {
                accepted_modes.push_back(std::move(candidate.mode));
            }
        }
        std::sort(
            accepted_modes.begin(),
            accepted_modes.end(),
            [](const SLEPcModalAcceptedMode &left,
               const SLEPcModalAcceptedMode &right) {
                return left.frequency_hz < right.frequency_hz;
            });
        accepted_mode_count_before_cap = accepted_modes.size();
        truncated_by_requested_count = request.requested_mode_count > 0 &&
            accepted_mode_count_before_cap >
                static_cast<std::size_t>(request.requested_mode_count);
        if (truncated_by_requested_count) {
            accepted_modes.resize(static_cast<std::size_t>(request.requested_mode_count));
        }
    } else {
        const SLEPcModalCandidateFinalization finalization =
            finalize_slepc_modal_candidates_with_context(
            candidate_modes,
            tangent_mass_context,
            kWindowDedupFrequencyRelativeTolerance,
            kWindowDedupFrequencyAbsoluteToleranceHz,
            kWindowDedupOverlapThreshold,
            request.target_frequency_hz,
            request.requested_mode_count,
            SLEPcModalCandidateSelection::lowest_frequency);
        if (!finalization.success) {
            subwindow_hard_failure = true;
            subwindow_failure_reason =
                finalization.deduplication_status ==
                        ModalDeduplicationStatus::invalid_metric
                    ? "invalid_tangent_mass_metric"
                    : finalization.deduplication_status ==
                            ModalDeduplicationStatus::mass_action_failed
                        ? "tangent_mass_action_failed"
                        : "modal_candidate_finalization_failed";
        } else {
            accepted_modes = finalization.accepted_modes;
            accepted_mode_count_before_cap =
                finalization.unique_candidate_count_before_cap;
            truncated_by_requested_count =
                finalization.truncated_by_requested_count;
        }
    }
    const bool exhausted_without_modes =
        !native_floquet_certified_count_unavailable &&
        !truncated_by_requested_count &&
        accepted_modes.empty() &&
        !subwindow_solves.empty() &&
        std::all_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return std::strcmp(solve.stop_reason, "window_exhausted") == 0 ||
                    std::strcmp(solve.stop_reason, "converged") == 0;
            });
    const bool partial_convergence =
        std::any_of(
            subwindow_solves.begin(),
            subwindow_solves.end(),
            [](const DenseSubwindowSolve &solve) {
                return std::strcmp(solve.stop_reason, "window_exhausted") != 0 &&
                    std::strcmp(solve.stop_reason, "converged") != 0;
            });
    const bool generic_best_effort_dimension_limited_partial_with_modes =
        !native_floquet_sparse &&
        request.completeness_policy == 0 &&
        generic_slepc_refill_partial &&
        generic_slepc_refill_dimension_limited &&
        !generic_slepc_refill_other_partial &&
        !accepted_modes.empty();
    if (!native_floquet_sparse &&
        generic_slepc_refill_dimension_limited &&
        accepted_modes.empty()) {
        subwindow_hard_failure = true;
        subwindow_failure_reason =
            "slepc_modal_nev_refill_dimension_limit_reached";
    }
    const char *window_stop_reason = subwindow_hard_failure
        ? "subwindow_failed" : (cancellation_interrupted ?
            "cancelled" : (native_floquet_certified_count_unavailable ?
        "count_certificate_unavailable" : (truncated_by_requested_count ?
        "requested_count_reached" :
        (accepted_modes.empty() ?
            (partial_convergence ? "partial_convergence" : "window_exhausted") :
            (partial_convergence ? "partial_convergence" : "converged")))));
    const char *window_completeness_status = subwindow_hard_failure
        ? "solver_error" : (truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (exhausted_without_modes ? "window_exhausted" :
            (partial_convergence ? "partial_convergence" : "not_certified")));
    const bool window_complete =
        native_floquet_sparse
            ? std::strcmp(window_completeness_status, "certified") == 0
            : !subwindow_hard_failure &&
                !cancellation_interrupted && !generic_slepc_refill_partial;
    for (std::size_t index = 0; index < accepted_modes.size(); ++index) {
        accepted_modes[index].positive_frequency_pair_index =
            static_cast<int>(index);
    }

    FrequencyDomainContractResult result{};
    const char *kSparsePayload = native_floquet_sparse
        ? "floquet_shared_domain_sparse_matshell"
        : "sparse_csr";
    const char *kSparseAdapter = native_floquet_sparse
        ? "floquet_airbox_cpu_schur_slepc"
        : "slepc_modal_eigen";
    const char *kSparseWindowSolverModel = modal_request_is_nonzero_k_floquet(request)
        ? "floquet_multi_shift_invert_slepc_sparse"
        : "slepc_multi_shift_invert_production_cpu_sparse_csr";
    const std::string window_diagnostics = production_window_diagnostics_json(
        request,
        partition,
        subwindow_solves,
        accepted_modes,
        accepted_mode_count_before_cap,
        truncated_by_requested_count);
    if (subwindow_hard_failure) {
        const char *failure_reason = subwindow_failure_reason != nullptr
            ? subwindow_failure_reason : "subwindow_solver_failed";
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "native FEM modal_eigen production CPU sparse CSR multi-shift solve stopped after a hard subwindow or candidate merge failure: " +
            std::string(failure_reason);
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"production_cpu\","
            "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
            "\"production_solver_available\":true,"
            "\"tiny_validation_solver\":false,"
            "\"mfem_operator_request\":true,"
            "\"tangent_dof_count\":" +
            std::to_string(sparse_modal_tangent_dof_count(request)) +
            ",\"mfem_operator_payload\":\"" +
            std::string(kSparsePayload) +
            "\",\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"solver_selection_reason\":\"" +
            std::string(selection.reason) +
            "\",\"spectral_transform\":\"shift_invert\","
            "\"solver_model\":\"" +
            std::string(kSparseWindowSolverModel) +
            "\",\"stop_reason\":\"subwindow_failed\","
            "\"failure_reason\":\"" +
            std::string(failure_reason) +
            "\",\"accepted_mode_count\":" +
            std::to_string(accepted_modes.size()) + ",";
        result.diagnostics_json += window_diagnostics;
        result.diagnostics_json += "}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\",\"accepted_mode_count\":" +
            std::to_string(native_floquet_sparse ? accepted_modes.size() : 0u) +
            ",\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"stop_reason\":\"subwindow_failed\","
            "\"window_completeness\":\"solver_error\","
            "\"failure_reason\":\"" +
            escape_json_string(failure_reason) + "\"";
        if (native_floquet_sparse) {
            result.result_json +=
                ",\"modes\":" + format_slepc_modes_json(accepted_modes);
        }
        result.result_json += "}";
        return result;
    }
    if (accepted_modes.empty()) {
        const char *terminal_status = cancellation_interrupted
            ? "interrupted" : "solve_error";
        result.status = cancellation_interrupted
            ? FrequencyDomainStatus::interrupted
            : FrequencyDomainStatus::solve_error;
        result.error_message = cancellation_interrupted
            ? "native FEM modal_eigen production CPU sparse CSR multi-shift solve was cancelled"
            : native_floquet_certified_count_unavailable
                ? "native FEM modal_eigen certified_count requires a window count certificate; the sparse Floquet shift-invert adapter does not produce one"
                : "native FEM modal_eigen production CPU sparse CSR multi-shift solve found no accepted modes in the requested window";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"" +
            std::string(terminal_status) +
            "\","
            "\"complete\":false,"
            "\"execution_lane\":\"production_cpu\","
            "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
            "\"production_solver_available\":true,"
            "\"tiny_validation_solver\":false,"
            "\"mfem_operator_request\":true,"
            "\"tangent_dof_count\":" +
            std::to_string(sparse_modal_tangent_dof_count(request)) +
            ",\"mfem_operator_payload\":\"" +
            std::string(kSparsePayload) +
            "\","
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"solver_selection_reason\":\"" +
            std::string(selection.reason) +
            "\",\"spectral_transform\":\"shift_invert\","
            "\"solver_model\":\"" +
            std::string(kSparseWindowSolverModel) +
            "\",\"stop_reason\":\"" +
            std::string(window_stop_reason) +
            "\",";
        result.diagnostics_json += window_diagnostics;
        result.diagnostics_json += "}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"" +
            std::string(terminal_status) +
            "\","
            "\"accepted_mode_count\":0,"
            "\"resolved_solver_family\":\"" +
            std::string(selection.family) +
            "\",\"stop_reason\":\"" +
            std::string(window_stop_reason) +
            "\",\"window_completeness\":\"" +
            std::string(window_completeness_status) +
            "\"}";
        return result;
    }

    double max_relative_residual = 0.0;
    for (const SLEPcModalAcceptedMode &mode : accepted_modes) {
        max_relative_residual =
            std::max(max_relative_residual, mode.relative_residual);
    }
    const SLEPcModalAcceptedMode &first_mode = accepted_modes.front();
    // Internal NEV overfetch is not a public minimum mode count. A
    // best_effort window may return a nonempty certified pool after only the
    // legal dimension guard is exhausted, while its completeness stays partial.
    const bool native_floquet_best_effort_dimension_limited_partial_with_modes =
        native_floquet_sparse &&
        request.completeness_policy == 0 &&
        native_floquet_refill_partial &&
        native_floquet_refill_dimension_limited &&
        !native_floquet_refill_other_partial &&
        !accepted_modes.empty();
    const bool best_effort_dimension_limited_partial_with_modes =
        generic_best_effort_dimension_limited_partial_with_modes ||
        native_floquet_best_effort_dimension_limited_partial_with_modes;
    const bool refill_incomplete =
        (native_floquet_sparse && native_floquet_refill_partial ||
         !native_floquet_sparse && generic_slepc_refill_partial) &&
        !best_effort_dimension_limited_partial_with_modes;
    result.status = cancellation_interrupted
        ? FrequencyDomainStatus::interrupted
        : (refill_incomplete || native_floquet_certified_count_unavailable)
            ? FrequencyDomainStatus::solve_error
            : FrequencyDomainStatus::ok;
    result.error_message = cancellation_interrupted
        ? std::string("native FEM modal_eigen production CPU sparse CSR multi-shift solve was cancelled")
        : refill_incomplete
            ? (native_floquet_sparse ? std::string(
                  "native FEM modal_eigen production CPU Floquet window remained "
                  "incomplete after bounded refill; certified partial modes are retained")
              : std::string(
                  "native FEM modal_eigen generic sparse window remained incomplete "
                  "after bounded refill; no complete spectrum is claimed"))
            : native_floquet_certified_count_unavailable
                ? "native FEM modal_eigen certified_count requires a window count certificate; the sparse Floquet shift-invert adapter does not produce one"
                : std::string();
    const char *deduplication_inner_product =
        native_floquet_sparse ? "floquet_positive_tangent_mass" :
                                "mfem_sparse_tangent_mass";
    const char *deduplication_mass_matrix_status =
        native_floquet_sparse ? "provided_complex_csr" : "provided_sparse_csr";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"" +
        std::string(cancellation_interrupted
            ? "interrupted"
            : (refill_incomplete || native_floquet_certified_count_unavailable)
                ? "solve_error" : "ok") +
        "\","
        "\"complete\":" +
        std::string(window_complete ? "true" : "false") +
        ","
        "\"execution_lane\":\"production_cpu\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":true,"
        "\"tiny_validation_solver\":false,"
        "\"mfem_operator_request\":true,"
        "\"tangent_dof_count\":" +
        std::to_string(sparse_modal_tangent_dof_count(request)) +
        ",\"mfem_operator_payload\":\"" +
        std::string(kSparsePayload) +
        "\","
        "\"algebraic_form\":\"real_frequency_rotated_gyrotropic_sparse_csr\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_adapter\":\"" +
        std::string(kSparseAdapter) +
        "\","
        "\"solver_model\":\"" +
        std::string(kSparseWindowSolverModel) +
        "\",\"solver_family\":\"" +
        std::string(kSparseWindowSolverModel) +
        "\",\"spectral_transform\":\"shift_invert\","
        "\"stop_reason\":\"" +
        std::string(window_stop_reason) +
        "\","
        "\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, exp_i_omega_t), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase)\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(accepted_modes.size()) +
        ",\"relative_residual_max\":" +
        format_double(max_relative_residual) +
        ",\"candidate_mode_count_before_dedup\":" +
        std::to_string(candidate_modes.size()) +
        ",\"deduplication_frequency_relative_tolerance\":" +
        format_double(kWindowDedupFrequencyRelativeTolerance) +
        ",\"deduplication_frequency_absolute_tolerance_hz\":" +
        format_double(kWindowDedupFrequencyAbsoluteToleranceHz) +
        ",\"deduplication_overlap_threshold\":" +
        format_double(kWindowDedupOverlapThreshold) +
        ",\"deduplication_inner_product\":\"" +
        std::string(deduplication_inner_product) +
        "\",\"deduplication_mass_matrix\":\"" +
        std::string(deduplication_mass_matrix_status) +
        "\",";
    result.diagnostics_json += window_diagnostics;
    result.diagnostics_json += "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"" +
        std::string(cancellation_interrupted
            ? "interrupted"
            : (refill_incomplete || native_floquet_certified_count_unavailable)
                ? "solve_error" : "ok") +
        "\","
        "\"solver_adapter\":\"" +
        std::string(kSparseAdapter) +
        "\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"stop_reason\":\"" +
        std::string(window_stop_reason) +
        "\",\"accepted_mode_count\":" +
        std::to_string(accepted_modes.size()) +
        "," +
        mode_kinematics_json_fields({first_mode.lambda_real, first_mode.lambda_imag}) +
        ",\"relative_residual\":" +
        format_double(first_mode.relative_residual) +
        ",\"window_completeness\":\"" +
        std::string(window_completeness_status) +
        "\",\"modes\":" +
        format_slepc_modes_json(accepted_modes) + "}";
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace

#ifndef FULLMAG_FEM_PETSC_VERSION
#define FULLMAG_FEM_PETSC_VERSION ""
#endif

#ifndef FULLMAG_FEM_SLEPC_VERSION
#define FULLMAG_FEM_SLEPC_VERSION ""
#endif

FrequencyDomainContractResult production_cpu_modal_eigen_unavailable(
    const ModalEigenRequest &request,
    const FloquetPotentialReconstruction *reconstruction) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    if (dynamic_demag_k_payload_is_declared(request) &&
        !dynamic_demag_k_payload_is_consistent(request)) {
        return dense_payload_validation_error(
            request,
            "native FEM modal_eigen dynamic demag-k payload is malformed",
            "invalid_dynamic_demag_k_tangent_matrix");
    }
    if (modal_request_is_nonzero_k_floquet(request)) {
        if (!modal_request_has_bloch_floquet_tangent_operator_payload(request)) {
            return nonzero_k_floquet_modal_operator_missing(request);
        }
        if (request.operator_request.include_demag != 0 &&
            request.floquet_shared_domain_operator == nullptr) {
            if (!dynamic_demag_k_payload_is_declared(request)) {
                return nonzero_k_floquet_modal_dynamic_demag_k_missing(request);
            }
        }
        if (const char *gated_operator_term =
                modal_request_gated_operator_term(request)) {
            return nonzero_k_floquet_modal_gated_operator_terms_present(
                request,
                gated_operator_term);
        }
    }
    const ModalSolverSelection selection = select_modal_solver_for_frequency_window(
        request.frequency_min_hz,
        request.frequency_max_hz,
        request.eigensolver_family);
    const bool contour_interval =
        std::strcmp(selection.family, "contour_interval") == 0;
    const char *spectral_transform =
        contour_interval ? "contour_interval" : "shift_invert";
    const char *solver_model =
        contour_interval ? "contour_interval" : "slepc_shift_invert_production_cpu";
    const ModalShiftSelection shift = select_modal_shift(
        request.target_kind,
        request.target_frequency_hz,
        request.frequency_min_hz,
        request.frequency_max_hz);
    const SLEPcModalEigenAdapterStatus adapter =
        slepc_modal_eigen_adapter_status();
    if (has_sparse_modal_payload(request)) {
        const bool native_floquet_sparse =
            request.floquet_shared_domain_operator != nullptr;
        if ((!native_floquet_sparse &&
             (!csr_matrix_view_is_consistent(request.mfem_sparse_stiffness_csr) ||
              !csr_matrix_view_is_consistent(request.mfem_sparse_gyrotropic_csr) ||
              !csr_matrix_view_is_consistent(request.mfem_sparse_mass_csr))) ||
            !sparse_modal_payload_shapes_match(request)) {
            return sparse_payload_validation_error(
                request,
                "native FEM modal sparse CSR operator payload is malformed",
                "invalid_sparse_csr_payload");
        }
        if (!contour_interval && adapter.slepc_available) {
            return solve_sparse_production_modal_payload(request, selection, shift);
        }
        return sparse_payload_solver_pending_result(
            request,
            selection,
            shift,
            adapter,
            contour_interval);
    }
    if (!contour_interval &&
        adapter.slepc_available &&
        has_dense_modal_payload(request)) {
        return solve_dense_production_modal_payload(request, selection, shift, reconstruction);
    }
    if (contour_interval &&
        adapter.slepc_available &&
        has_dense_modal_payload(request)) {
        return solve_dense_production_modal_contour_payload(
            request,
            selection,
            reconstruction);
    }
    const char *solver_adapter_status = adapter.solver_adapter_status;
    const char *unsupported_reason = adapter.unsupported_reason;
    const char *unavailable_message = adapter.unavailable_message;
    if (contour_interval && adapter.slepc_available) {
        solver_adapter_status = "pending";
        unsupported_reason = "contour_interval_solver_not_implemented";
        unavailable_message =
            "native FEM modal_eigen contour interval production CPU solver is not implemented yet; PETSc/SLEPc dependency stack is available but the FEAST-style adapter is still pending";
    }
    const char *slepc_available = adapter.slepc_available ? "true" : "false";
    result.error_message = unavailable_message;
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"mfem_operator_request\":" +
        std::string(request.mfem_operator_enabled != 0 ? "true" : "false") +
        ",\"tangent_dof_count\":" +
        std::to_string(request.mfem_tangent_dof_count) +
        ",\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_model\":\"" +
        std::string(solver_model) +
        "\",\"spectral_transform\":\"" +
        std::string(spectral_transform) +
        "\"";
    if (!contour_interval) {
        result.diagnostics_json +=
            ",\"shift_selection_policy\":\"" +
            std::string(shift.selection_policy) +
            "\",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s);
    }
    result.diagnostics_json +=
        ",\"solver_adapter\":\"" +
        std::string(adapter.solver_adapter) +
        "\",\"solver_adapter_status\":\"" +
        std::string(solver_adapter_status) +
        "\",\"requires_slepc\":" +
        std::string(adapter.requires_slepc ? "true" : "false") +
        ","
        "\"modal_eigen_native_cpu_slepc_available\":" +
        std::string(slepc_available) +
        ",\"petsc_version\":\"" + FULLMAG_FEM_PETSC_VERSION +
        "\",\"slepc_version\":\"" + FULLMAG_FEM_SLEPC_VERSION +
        "\",\"unsupported_reason\":\"" + unsupported_reason + "\"";
    if (!contour_interval && adapter.slepc_available) {
        result.diagnostics_json +=
            ",\"eps_type\":\"" +
            std::string(adapter.eps_type) +
            "\",\"slepc_problem_type\":\"" +
            std::string(adapter.problem_type) +
            "\",\"which_eigenpairs\":\"" +
            std::string(adapter.which_eigenpairs) +
            "\",\"algebraic_form\":\"" +
            std::string(adapter.algebraic_form) +
            "\",\"ksp_type\":\"" +
            std::string(adapter.ksp_type) +
            "\",\"pc_type\":\"" +
            std::string(adapter.pc_type) +
            "\",\"factorization_package\":\"" +
            std::string(adapter.factorization_package) +
            "\",\"factorization_shift_policy\":\"" +
            std::string(adapter.factorization_shift_policy) +
            "\",\"nullspace_policy\":\"" +
            std::string(adapter.nullspace_policy) +
            "\",\"linear_tolerance_policy\":\"" +
            std::string(adapter.linear_tolerance_policy) +
            "\",\"positive_frequency_filter\":\"" +
            std::string(adapter.positive_frequency_filter) +
            "\",\"zero_frequency_mode_policy\":\"exclude_zero_frequency\""
            ",\"eigenvalue_to_frequency\":\"" +
            std::string(adapter.eigenvalue_to_frequency) + "\"";
    }
    result.diagnostics_json += "}";
    result.diagnostics_json =
        with_modal_request_diagnostics(result.diagnostics_json, request, result.status);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0,"
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\"";
    if (!contour_interval) {
        result.result_json +=
            ",\"shift_frequency_hz\":" +
            format_double(shift.shift_frequency_hz) +
            ",\"shift_omega_rad_s\":" +
            format_double(shift.shift_omega_rad_s);
    }
    result.result_json += "}";
    append_nearest_frequency_metadata(result.result_json, request, result.status);
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace fullmag::fem::frequency_domain
