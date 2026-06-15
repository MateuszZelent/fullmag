#include "frequency_domain/modal_eigen_solver.hpp"

#include "frequency_domain/solver_progress.hpp"

namespace fullmag::fem::frequency_domain {

namespace {

FrequencyDomainContractResult validation_error_result(
    const char *study_product,
    const char *message,
    const char *reason) noexcept
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

} // namespace

FrequencyDomainContractResult solve_modal_eigen_contract(
    const ModalEigenRequest &request) noexcept
{
    if (request.abi_version != kFrequencyDomainAbiVersion ||
        request.operator_request.abi_version != kFrequencyDomainAbiVersion) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen request uses an unsupported ABI version",
            "unsupported_abi_version");
    }
    if (output_directory_required(request.write_partial_artifacts, request.output_directory)) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen write_partial_artifacts requires output_directory",
            "missing_output_directory");
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
            "unsupported_abi_version");
    }
    if (output_directory_required(request.write_partial_artifacts, request.output_directory)) {
        return validation_error_result(
            "driven_response",
            "native FEM driven_response write_partial_artifacts requires output_directory",
            "missing_output_directory");
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
    result.result_json =
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"study_product\":\"driven_response\","
        "\"status\":\"unavailable\"}";
    return result;
}

} // namespace fullmag::fem::frequency_domain
