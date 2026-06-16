#include "frequency_domain/modal_eigen_solver.hpp"

#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>

namespace fullmag::fem::frequency_domain {

namespace {

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

FrequencyDomainContractResult validation_error_result(
    const char *study_product,
    const char *message,
    const char *reason,
    const char *operator_diagnostics_json = nullptr) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::validation_error;
    result.error_message = message != nullptr ? message : "";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
        "\"study_product\":\"" +
        std::string(study_product != nullptr ? study_product : "") +
        "\",\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"reason\":\"" +
        std::string(reason != nullptr ? reason : "validation_error") +
        "\"}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_contract_result.v1\","
        "\"study_product\":\"" +
        std::string(study_product != nullptr ? study_product : "") +
        "\",\"status\":\"validation_error\"}";
    return result;
}

bool output_directory_required(int write_partial_artifacts, const char *output_directory) noexcept
{
    return write_partial_artifacts != 0 &&
           (output_directory == nullptr || output_directory[0] == '\0');
}

bool cancel_requested(const ModalEigenRequest &request) noexcept
{
    return request.cancel_requested != nullptr &&
        request.cancel_requested(request.cancel_user_data) != 0;
}

std::string format_double(double value) noexcept
{
    char buffer[64]{};
    const int written = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        return "0";
    }
    return buffer;
}

void emit_progress(
    const ModalEigenRequest &request,
    double shift_frequency_hz,
    std::uint64_t candidate_mode_count,
    std::uint64_t accepted_mode_count,
    double relative_residual,
    const char *stop_reason = nullptr) noexcept
{
    if (request.progress_callback == nullptr) {
        return;
    }
    const std::string stop_reason_json = stop_reason == nullptr ?
        "null" :
        std::string("\"") + escape_json_string(stop_reason) + "\"";
    char progress_json[1024]{};
    const int written = std::snprintf(
        progress_json,
        sizeof(progress_json),
        "{\"schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_phase\":\"solving_shift_invert\","
        "\"execution_lane\":\"validation\","
        "\"requested_mode_count\":%d,"
        "\"accepted_mode_count\":%llu,"
        "\"candidate_mode_count\":%llu,"
        "\"current_shift_hz\":%.17g,"
        "\"outer_iteration\":1,"
        "\"max_outer_iterations\":%d,"
        "\"linear_iteration\":1,"
        "\"max_linear_iterations\":%d,"
        "\"current_residual_relative_l2\":%.17g,"
        "\"target_residual_relative_l2\":%.17g,"
        "\"partial_artifacts_available\":false,"
        "\"latest_artifact_manifest_path\":\"\","
        "\"stop_reason\":%s}",
        request.requested_mode_count,
        static_cast<unsigned long long>(accepted_mode_count),
        static_cast<unsigned long long>(candidate_mode_count),
        shift_frequency_hz,
        request.max_outer_iterations,
        request.max_linear_iterations,
        relative_residual,
        request.residual_tolerance,
        stop_reason_json.c_str());
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(progress_json)) {
        return;
    }
    request.progress_callback(request.progress_user_data, progress_json);
}

double target_shift_frequency_hz(const ModalEigenRequest &request) noexcept
{
    const char *target_kind = request.target_kind != nullptr ? request.target_kind : "";
    if (std::strcmp(target_kind, "nearest_frequency") == 0) {
        return request.target_frequency_hz;
    }
    if (std::strcmp(target_kind, "frequency_window") == 0) {
        return 0.5 * (request.frequency_min_hz + request.frequency_max_hz);
    }
    return 0.0;
}

bool load_tiny_validation_matrix(
    const double *matrix_row_major,
    const double *diagonal,
    double out_matrix[4]) noexcept
{
    if (matrix_row_major != nullptr) {
        for (int i = 0; i < 4; ++i) {
            out_matrix[i] = matrix_row_major[i];
        }
        return true;
    }
    if (diagonal != nullptr) {
        out_matrix[0] = diagonal[0];
        out_matrix[1] = 0.0;
        out_matrix[2] = 0.0;
        out_matrix[3] = diagonal[1];
        return true;
    }
    return false;
}

double complex_vector_norm2(const std::complex<double> v[2]) noexcept
{
    return std::sqrt(std::norm(v[0]) + std::norm(v[1]));
}

FrequencyDomainContractResult interrupted_result(
    const ModalEigenRequest &request,
    const char *message,
    const char *stop_reason) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::interrupted;
    result.error_message = message != nullptr ? message : "";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"interrupted\","
        "\"complete\":false,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"tiny_validation_solver\":true,"
        "\"stop_reason\":\"" +
        std::string(stop_reason != nullptr ? stop_reason : "cancel_requested") +
        "\"}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"interrupted\","
        "\"accepted_mode_count\":0}";
    return result;
}

FrequencyDomainContractResult solve_tiny_validation_modal_problem(
    const ModalEigenRequest &request) noexcept
{
    FrequencyDomainContractResult result{};
    if (request.tiny_validation_tangent_dof_count != 2) {
        return validation_error_result(
            "modal_eigen",
            "modal tiny validation currently requires exactly two tangent DOFs",
            "tiny_validation_requires_two_dofs",
            request.operator_request.operator_diagnostics_json);
    }
    if (cancel_requested(request)) {
        return interrupted_result(
            request,
            "native FEM modal_eigen validation solve was interrupted before shift-invert",
            "cancel_requested");
    }

    double stiffness[4]{};
    double gyrotropic_mass[4]{};
    if (!load_tiny_validation_matrix(
            request.tiny_validation_stiffness_matrix_row_major,
            request.tiny_validation_stiffness_diagonal,
            stiffness) ||
        !load_tiny_validation_matrix(
            request.tiny_validation_mass_matrix_row_major,
            request.tiny_validation_mass_diagonal,
            gyrotropic_mass)) {
        return validation_error_result(
            "modal_eigen",
            "modal tiny validation requires stiffness and gyrotropic mass matrices",
            "tiny_validation_missing_matrices",
            request.operator_request.operator_diagnostics_json);
    }

    const double det_g =
        gyrotropic_mass[0] * gyrotropic_mass[3] -
        gyrotropic_mass[1] * gyrotropic_mass[2];
    const double coeff_linear =
        -stiffness[0] * gyrotropic_mass[3] -
        stiffness[3] * gyrotropic_mass[0] +
        stiffness[1] * gyrotropic_mass[2] +
        stiffness[2] * gyrotropic_mass[1];
    const double det_k =
        stiffness[0] * stiffness[3] -
        stiffness[1] * stiffness[2];
    if (!std::isfinite(det_g) || std::abs(det_g) <= 1.0e-18) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation gyrotropic mass matrix is singular";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }

    const std::complex<double> discriminant(
        coeff_linear * coeff_linear - 4.0 * det_g * det_k,
        0.0);
    const std::complex<double> sqrt_discriminant = std::sqrt(discriminant);
    const std::complex<double> lambda_candidates[2] = {
        (-coeff_linear - sqrt_discriminant) / (2.0 * det_g),
        (-coeff_linear + sqrt_discriminant) / (2.0 * det_g),
    };
    constexpr double kTwoPi = 2.0 * 3.14159265358979323846264338327950288;
    const double shift_frequency_hz = target_shift_frequency_hz(request);
    std::complex<double> chosen_lambda(
        std::numeric_limits<double>::quiet_NaN(),
        std::numeric_limits<double>::quiet_NaN());
    double chosen_omega = std::numeric_limits<double>::quiet_NaN();
    double chosen_frequency_hz = std::numeric_limits<double>::quiet_NaN();
    double best_shift_distance = std::numeric_limits<double>::infinity();
    std::uint64_t candidate_mode_count = 0;
    for (std::complex<double> lambda_candidate : lambda_candidates) {
        if (!std::isfinite(lambda_candidate.real()) ||
            !std::isfinite(lambda_candidate.imag())) {
            continue;
        }
        double omega_candidate = std::imag(lambda_candidate);
        if (std::abs(omega_candidate) <= 1.0e-15) {
            omega_candidate = std::real(lambda_candidate);
        }
        if (!std::isfinite(omega_candidate) || omega_candidate <= 0.0) {
            continue;
        }
        const double frequency_hz = omega_candidate / kTwoPi;
        ++candidate_mode_count;
        const char *target_kind = request.target_kind != nullptr ? request.target_kind : "";
        bool in_target = true;
        if (std::strcmp(target_kind, "frequency_window") == 0) {
            in_target =
                frequency_hz >= request.frequency_min_hz &&
                frequency_hz <= request.frequency_max_hz;
        }
        if (!in_target) {
            continue;
        }
        const double shift_distance = std::abs(frequency_hz - shift_frequency_hz);
        if (!std::isfinite(chosen_omega) || shift_distance < best_shift_distance) {
            best_shift_distance = shift_distance;
            chosen_lambda = lambda_candidate;
            chosen_omega = omega_candidate;
            chosen_frequency_hz = frequency_hz;
        }
    }
    if (!std::isfinite(chosen_omega)) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation found no positive-frequency mode in the requested target";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }

    const std::complex<double> pencil[4] = {
        stiffness[0] - chosen_lambda * gyrotropic_mass[0],
        stiffness[1] - chosen_lambda * gyrotropic_mass[1],
        stiffness[2] - chosen_lambda * gyrotropic_mass[2],
        stiffness[3] - chosen_lambda * gyrotropic_mass[3],
    };
    std::complex<double> eigenvector[2] = {-pencil[1], pencil[0]};
    if (std::fmax(std::abs(eigenvector[0]), std::abs(eigenvector[1])) <= 1.0e-15) {
        eigenvector[0] = -pencil[3];
        eigenvector[1] = pencil[2];
    }
    const double eigenvector_norm = complex_vector_norm2(eigenvector);
    if (!(eigenvector_norm > 0.0) || !std::isfinite(eigenvector_norm)) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation failed to construct an eigenvector";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }
    eigenvector[0] /= eigenvector_norm;
    eigenvector[1] /= eigenvector_norm;

    const std::complex<double> k_phi[2] = {
        stiffness[0] * eigenvector[0] + stiffness[1] * eigenvector[1],
        stiffness[2] * eigenvector[0] + stiffness[3] * eigenvector[1],
    };
    const std::complex<double> g_phi[2] = {
        gyrotropic_mass[0] * eigenvector[0] + gyrotropic_mass[1] * eigenvector[1],
        gyrotropic_mass[2] * eigenvector[0] + gyrotropic_mass[3] * eigenvector[1],
    };
    const std::complex<double> residual[2] = {
        k_phi[0] - chosen_lambda * g_phi[0],
        k_phi[1] - chosen_lambda * g_phi[1],
    };
    const double residual_norm = complex_vector_norm2(residual);
    const double denom =
        complex_vector_norm2(k_phi) +
        std::abs(chosen_lambda) * complex_vector_norm2(g_phi);
    const double relative_residual =
        denom > 0.0 ? residual_norm / denom : std::numeric_limits<double>::infinity();
    if (!(relative_residual <= request.residual_tolerance)) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation found a mode but residual exceeded tolerance";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }

    if (cancel_requested(request)) {
        return interrupted_result(
            request,
            "native FEM modal_eigen validation solve was interrupted during shift-invert",
            "cancel_requested");
    }

    emit_progress(
        request,
        shift_frequency_hz,
        candidate_mode_count,
        1,
        relative_residual);

    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"algebraic_form\":\"first_order_complex\","
        "\"solver_family\":\"analytic_validation_shift_target\","
        "\"slepc_problem_type\":\"validation_not_slepc\","
        "\"positive_frequency_filter\":\"imag(lambda) > 0\","
        "\"eigenvalue_to_frequency\":\"frequency_hz = abs(imag(lambda))/(2*pi)\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":1,"
        "\"candidate_mode_count\":" +
        std::to_string(candidate_mode_count) +
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz) +
        ",\"outer_iteration\":1,"
        "\"linear_iteration\":1,"
        "\"relative_residual_max\":" +
        format_double(relative_residual) + "}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"accepted_mode_count\":1,"
        "\"frequency_hz\":" +
        format_double(chosen_frequency_hz) +
        ",\"omega_rad_s\":" +
        format_double(chosen_omega) +
        ",\"eigenvalue_real\":" +
        format_double(std::real(chosen_lambda)) +
        ",\"eigenvalue_imag\":" +
        format_double(std::imag(chosen_lambda)) + ","
        "\"relative_residual\":" +
        format_double(relative_residual) +
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz) + "}";
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace

FrequencyDomainContractResult solve_modal_eigen_contract(
    const ModalEigenRequest &request) noexcept
{
    if (request.abi_version != kFrequencyDomainAbiVersion ||
        request.operator_request.abi_version != kFrequencyDomainAbiVersion) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen request uses an unsupported ABI version",
            "unsupported_abi_version",
            request.operator_request.operator_diagnostics_json);
    }
    if (output_directory_required(request.write_partial_artifacts, request.output_directory)) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen write_partial_artifacts requires output_directory",
            "missing_output_directory",
            request.operator_request.operator_diagnostics_json);
    }
    if (request.tiny_validation_enabled != 0) {
        return solve_tiny_validation_modal_problem(request);
    }
    return production_cpu_modal_eigen_unavailable(request);
}

FrequencyDomainContractResult solve_driven_response_contract(
    const DrivenResponseContractRequest &request) noexcept
{
    if (request.abi_version != kFrequencyDomainAbiVersion ||
        request.operator_request.abi_version != kFrequencyDomainAbiVersion) {
        return validation_error_result(
            "driven_response",
            "native FEM driven_response request uses an unsupported ABI version",
            "unsupported_abi_version",
            request.operator_request.operator_diagnostics_json);
    }
    if (output_directory_required(request.write_partial_artifacts, request.output_directory)) {
        return validation_error_result(
            "driven_response",
            "native FEM driven_response write_partial_artifacts requires output_directory",
            "missing_output_directory",
            request.operator_request.operator_diagnostics_json);
    }

    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.error_message =
        "native FEM driven_response ABI v1 skeleton is not implemented yet";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"study_product\":\"driven_response\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"frequency_count\":" +
        std::to_string(request.frequency_count) +
        ",\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"unsupported_reason\":\"driven_response_v1_skeleton_not_implemented\"}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"study_product\":\"driven_response\","
        "\"status\":\"unavailable\"}";
    return result;
}

} // namespace fullmag::fem::frequency_domain
