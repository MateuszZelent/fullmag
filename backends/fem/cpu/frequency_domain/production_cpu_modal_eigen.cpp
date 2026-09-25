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
    const ModalEigenRequest &request)
{
    if (!diagnostics_json.empty() && diagnostics_json.back() == '}') {
        diagnostics_json.pop_back();
        diagnostics_json += operator_k_vector_diagnostics_json(request);
        diagnostics_json += modal_floquet_periodic_pair_diagnostics_json(request);
        diagnostics_json += dynamic_demag_k_diagnostics_json(request);
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
        // A complete, finite k-dependent payload is the native provider's
        // proof that this term is materialized.  Keep the historical gate for
        // labelled-but-missing Rust/full2x2 terms.
        if (!dynamic_demag_k_payload_is_consistent(request)) {
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0,"
        "\"unsupported_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\","
        "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\","
        "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\"}";
    result.result_json = with_modal_request_diagnostics(result.result_json, request);
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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
    result.result_json = with_modal_request_diagnostics(result.result_json, request);
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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
    result.result_json = with_modal_request_diagnostics(result.result_json, request);
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
                ",\"floquet_geometric_bc_certified\":false,"
                "\"floquet_full_descriptor_certified\":false,"
                "\"floquet_certificate_scope\":\"reduced_original_blocks_only\","
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
                ",\"magnetic_block_backward_error\":" +
                format_double(mode.floquet_magnetic_residual) +
                ",\"poisson_block_backward_error\":" +
                format_double(mode.floquet_potential_residual) +
                ",\"gauge_constraint_backward_error\":0,"
                "\"gauge_constraint_policy\":\"not_applicable_nonzero_k_invertible_poisson\","
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
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    if (modal_request_is_nonzero_k_floquet(request)) {
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

std::vector<double> csr_matrix_view_to_dense_row_major(const CsrMatrixView &view)
{
    if (view.row_count == 0 ||
        view.column_count == 0 ||
        view.row_count > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()) ||
        view.column_count > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return {};
    }
    const std::size_t row_count = static_cast<std::size_t>(view.row_count);
    const std::size_t column_count = static_cast<std::size_t>(view.column_count);
    if (row_count > std::numeric_limits<std::size_t>::max() / column_count) {
        return {};
    }
    std::vector<double> dense(row_count * column_count, 0.0);
    for (std::size_t row = 0; row < row_count; ++row) {
        const std::uint32_t row_begin = view.row_offsets[row];
        const std::uint32_t row_end = view.row_offsets[row + 1u];
        for (std::uint32_t entry = row_begin; entry < row_end; ++entry) {
            const std::size_t column =
                static_cast<std::size_t>(view.column_indices[entry]);
            dense[row * column_count + column] += view.values[entry];
        }
    }
    return dense;
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"validation_error\","
        "\"accepted_mode_count\":0}";
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"validation_error\","
        "\"accepted_mode_count\":0}";
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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

std::vector<SLEPcModalAcceptedMode> deduplicate_slepc_modes_by_overlap(
    const std::vector<SLEPcModalAcceptedMode> &candidate_modes,
    std::size_t tangent_dof_count,
    const double *mass_matrix_row_major)
{
    std::vector<ModalCandidate> modal_candidates;
    modal_candidates.reserve(candidate_modes.size());
    for (std::size_t index = 0; index < candidate_modes.size(); ++index) {
        const SLEPcModalAcceptedMode &mode = candidate_modes[index];
        ModalCandidate candidate{};
        candidate.frequency_hz = mode.frequency_hz;
        candidate.relative_residual = mode.relative_residual;
        candidate.source_index = static_cast<int>(index);
        candidate.mode = mode.mode_vector;
        modal_candidates.push_back(std::move(candidate));
    }

    const std::vector<ModalCandidate> deduplicated =
        deduplicate_modes_by_frequency_and_overlap(
            modal_candidates,
            mass_matrix_row_major,
            tangent_dof_count,
            kWindowDedupFrequencyRelativeTolerance,
            kWindowDedupFrequencyAbsoluteToleranceHz,
            kWindowDedupOverlapThreshold);

    std::vector<SLEPcModalAcceptedMode> accepted_modes;
    accepted_modes.reserve(deduplicated.size());
    for (const ModalCandidate &candidate : deduplicated) {
        if (candidate.source_index < 0 ||
            static_cast<std::size_t>(candidate.source_index) >= candidate_modes.size()) {
            continue;
        }
        SLEPcModalAcceptedMode mode =
            candidate_modes[static_cast<std::size_t>(candidate.source_index)];
        mode.mode_vector = candidate.mode;
        accepted_modes.push_back(std::move(mode));
    }
    return accepted_modes;
}

const char *subwindow_stop_reason(
    const SLEPcTinyGyrotropicModalEigenResult &slepc_result) noexcept
{
    if (slepc_result.ok) {
        return "converged";
    }
    if (std::strcmp(slepc_result.unsupported_reason, "no_positive_frequency_eigenpair_in_window") == 0 ||
        std::strcmp(slepc_result.unsupported_reason, "no_accepted_positive_frequency_mode") == 0) {
        return "window_exhausted";
    }
    if (std::strcmp(slepc_result.unsupported_reason, "residual_tolerance_not_met") == 0) {
        return "residual_not_met";
    }
    return stop_reason_or_default(slepc_result);
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
    const std::string completeness_status = truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (exhausted_without_modes ? "window_exhausted" :
            (partial_convergence ? "partial_convergence" :
                (certified ? "certified" : "not_certified")));
    const char *additional_modes_may_exist =
        (certified && !truncated_by_requested_count) ? "false" : "true";
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
        "},\"subwindows\":[";

    for (std::size_t i = 0; i < subwindow_solves.size(); ++i) {
        const DenseSubwindowSolve &solve = subwindow_solves[i];
        const FrequencySubwindow &subwindow = solve.subwindow;
        if (i != 0) {
            json += ",";
        }
        json +=
            "{\"index\":" +
            std::to_string(subwindow.index) +
            ",\"requested_hz\":[" +
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
            format_double(solve.result.max_candidate_relative_residual) +
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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
            with_modal_request_diagnostics(result.diagnostics_json, request);
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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

    std::vector<DenseSubwindowSolve> subwindow_solves;
    subwindow_solves.reserve(partition.subwindows.size());
    std::vector<SLEPcModalAcceptedMode> candidate_modes;
    for (const FrequencySubwindow &subwindow : partition.subwindows) {
        SLEPcTinyGyrotropicModalEigenRequest slepc_request{};
        slepc_request.tangent_dof_count =
            static_cast<int>(request.mfem_tangent_dof_count);
        slepc_request.stiffness_matrix_row_major =
            request.mfem_stiffness_matrix_row_major;
        slepc_request.gyrotropic_matrix_row_major =
            request.mfem_gyrotropic_matrix_row_major;
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
    }

    std::vector<SLEPcModalAcceptedMode> accepted_modes =
        deduplicate_slepc_modes_by_overlap(
            candidate_modes,
            static_cast<std::size_t>(request.mfem_tangent_dof_count),
            request.mfem_mass_matrix_row_major);
    std::sort(
        accepted_modes.begin(),
        accepted_modes.end(),
        [](const SLEPcModalAcceptedMode &left, const SLEPcModalAcceptedMode &right) {
            return left.frequency_hz < right.frequency_hz;
        });
    const std::size_t accepted_mode_count_before_cap = accepted_modes.size();
    const bool truncated_by_requested_count =
        request.requested_mode_count > 0 &&
        accepted_mode_count_before_cap >
            static_cast<std::size_t>(request.requested_mode_count);
    if (truncated_by_requested_count) {
        accepted_modes.resize(static_cast<std::size_t>(request.requested_mode_count));
    }
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
    const char *window_stop_reason = truncated_by_requested_count ?
        "requested_count_reached" :
        (accepted_modes.empty() ?
            (partial_convergence ? "partial_convergence" : "window_exhausted") :
            (partial_convergence ? "partial_convergence" : "converged"));
    const char *window_completeness_status = truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (exhausted_without_modes ? "window_exhausted" :
            (partial_convergence ? "partial_convergence" : "not_certified"));
    for (std::size_t index = 0; index < accepted_modes.size(); ++index) {
        accepted_modes[index].positive_frequency_pair_index =
            static_cast<int>(index);
    }

    FrequencyDomainContractResult result{};
    const std::string window_diagnostics =
        production_window_diagnostics_json(
            request,
            partition,
            subwindow_solves,
            accepted_modes,
            accepted_mode_count_before_cap,
            truncated_by_requested_count);
    if (accepted_modes.empty()) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "native FEM modal_eigen production CPU multi-shift solve found no accepted modes in the requested window";
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
        result.diagnostics_json += window_diagnostics;
        result.diagnostics_json += "}";
        result.diagnostics_json =
            with_modal_request_diagnostics(result.diagnostics_json, request);
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
    const char *deduplication_inner_product =
        request.mfem_mass_matrix_row_major != nullptr ? "mfem_tangent_mass" :
                                                        "identity_tangent_dof";
    const char *deduplication_mass_matrix =
        request.mfem_mass_matrix_row_major != nullptr ? "provided" : "identity_fallback";
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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

    SLEPcTinyGyrotropicModalEigenRequest slepc_request{};
    slepc_request.tangent_dof_count =
        static_cast<int>(request.mfem_tangent_dof_count);
    slepc_request.stiffness_matrix_row_major =
        stiffness;
    slepc_request.gyrotropic_matrix_row_major =
        request.mfem_gyrotropic_matrix_row_major;
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
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "native FEM modal_eigen production CPU SLEPc shift-invert solve failed";
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
            with_modal_request_diagnostics(result.diagnostics_json, request);
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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

    SLEPcSparseGyrotropicModalEigenRequest slepc_request{};
    slepc_request.tangent_dof_count =
        static_cast<int>(sparse_modal_tangent_dof_count(request));
    slepc_request.stiffness_csr = request.mfem_sparse_stiffness_csr;
    slepc_request.gyrotropic_csr = request.mfem_sparse_gyrotropic_csr;
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
    const SLEPcTinyGyrotropicModalEigenResult slepc_result =
        solve_sparse_modal_spectrum_for_request(request, slepc_request);

    FrequencyDomainContractResult result{};
    const bool native_floquet_sparse =
        request.floquet_shared_domain_operator != nullptr;
    const char *kSparsePayload = native_floquet_sparse
        ? "floquet_shared_domain_sparse_matshell"
        : "sparse_csr";
    const char *kSparseAdapter = native_floquet_sparse
        ? "floquet_airbox_cpu_schur_slepc"
        : "slepc_modal_eigen";
    const char *kSparseSolverModel = native_floquet_sparse
        ? "floquet_real_frequency_slepc_sparse"
        : "slepc_shift_invert_production_cpu_sparse_csr";
    if (!slepc_result.ok) {
        const char *stop_reason = stop_reason_or_default(slepc_result);
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "native FEM modal_eigen production CPU sparse CSR SLEPc shift-invert solve failed";
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
            with_modal_request_diagnostics(result.diagnostics_json, request);
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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

    std::vector<DenseSubwindowSolve> subwindow_solves;
    subwindow_solves.reserve(partition.subwindows.size());
    std::vector<SLEPcModalAcceptedMode> candidate_modes;
    for (const FrequencySubwindow &subwindow : partition.subwindows) {
        SLEPcSparseGyrotropicModalEigenRequest slepc_request{};
        slepc_request.tangent_dof_count =
            static_cast<int>(sparse_modal_tangent_dof_count(request));
        slepc_request.stiffness_csr = request.mfem_sparse_stiffness_csr;
        slepc_request.gyrotropic_csr = request.mfem_sparse_gyrotropic_csr;
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
        SLEPcTinyGyrotropicModalEigenResult slepc_result =
            solve_sparse_modal_spectrum_for_request(request, slepc_request);
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
    }

    // The native shared-domain owner keeps the mass metric on the backend
    // side.  Materialising its CSR mass here would reintroduce the dense
    // Rust/CPU allocation that this path is designed to avoid.  Native modes
    // therefore use the bounded identity fallback for deduplication until a
    // sparse mass inner-product hook is available.
    std::vector<double> sparse_mass_matrix_row_major;
    const double *deduplication_mass_matrix = nullptr;
    if (request.floquet_shared_domain_operator == nullptr) {
        sparse_mass_matrix_row_major =
            csr_matrix_view_to_dense_row_major(request.mfem_sparse_mass_csr);
        deduplication_mass_matrix = sparse_mass_matrix_row_major.empty()
            ? nullptr
            : sparse_mass_matrix_row_major.data();
    }
    std::vector<SLEPcModalAcceptedMode> accepted_modes =
        deduplicate_slepc_modes_by_overlap(
            candidate_modes,
            static_cast<std::size_t>(sparse_modal_tangent_dof_count(request)),
            deduplication_mass_matrix);
    std::sort(
        accepted_modes.begin(),
        accepted_modes.end(),
        [](const SLEPcModalAcceptedMode &left, const SLEPcModalAcceptedMode &right) {
            return left.frequency_hz < right.frequency_hz;
        });
    const std::size_t accepted_mode_count_before_cap = accepted_modes.size();
    const bool truncated_by_requested_count =
        request.requested_mode_count > 0 &&
        accepted_mode_count_before_cap >
            static_cast<std::size_t>(request.requested_mode_count);
    if (truncated_by_requested_count) {
        accepted_modes.resize(static_cast<std::size_t>(request.requested_mode_count));
    }
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
    const char *window_stop_reason = truncated_by_requested_count ?
        "requested_count_reached" :
        (accepted_modes.empty() ?
            (partial_convergence ? "partial_convergence" : "window_exhausted") :
            (partial_convergence ? "partial_convergence" : "converged"));
    const char *window_completeness_status = truncated_by_requested_count ?
        "truncated_by_requested_count" :
        (exhausted_without_modes ? "window_exhausted" :
            (partial_convergence ? "partial_convergence" : "not_certified"));
    const bool native_floquet_sparse =
        request.floquet_shared_domain_operator != nullptr;
    const bool window_complete =
        !native_floquet_sparse ||
        std::strcmp(window_completeness_status, "certified") == 0;
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
    const std::string window_diagnostics =
        production_window_diagnostics_json(
            request,
            partition,
            subwindow_solves,
            accepted_modes,
            accepted_mode_count_before_cap,
            truncated_by_requested_count);
    if (accepted_modes.empty()) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "native FEM modal_eigen production CPU sparse CSR multi-shift solve found no accepted modes in the requested window";
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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
    const char *deduplication_inner_product =
        deduplication_mass_matrix != nullptr ? "mfem_sparse_tangent_mass" :
                                               "identity_tangent_dof";
    const char *deduplication_mass_matrix_status =
        deduplication_mass_matrix != nullptr ? "provided_sparse_csr" :
                                               "identity_fallback";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
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
        with_modal_request_diagnostics(result.diagnostics_json, request);
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
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace fullmag::fem::frequency_domain
