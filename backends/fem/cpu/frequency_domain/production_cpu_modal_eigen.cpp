#include "frequency_domain/modal_eigen_solver.hpp"

#include "frequency_domain/solver_progress.hpp"

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

} // namespace

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

#ifndef FULLMAG_FEM_PETSC_VERSION
#define FULLMAG_FEM_PETSC_VERSION ""
#endif

#ifndef FULLMAG_FEM_SLEPC_VERSION
#define FULLMAG_FEM_SLEPC_VERSION ""
#endif

FrequencyDomainContractResult production_cpu_modal_eigen_unavailable(
    const ModalEigenRequest &request) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    const char *error_message = FULLMAG_FEM_WITH_SLEPC != 0
                                    ? "native FEM modal_eigen production CPU solver is not implemented yet; PETSc/SLEPc dependency stack is available but the solver adapter is still pending"
                                    : "native FEM modal_eigen production CPU solver requires PETSc/SLEPc, but fullmag_fem was built without SLEPc support";
    const char *unsupported_reason = FULLMAG_FEM_WITH_SLEPC != 0
                                         ? "modal_solver_not_implemented"
                                         : "slepc_not_available";
    const char *slepc_available =
        FULLMAG_FEM_WITH_SLEPC != 0 ? "true" : "false";
    result.error_message = error_message;
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"modal_eigen_native_cpu_slepc_available\":" +
        std::string(slepc_available) +
        ",\"petsc_version\":\"" + FULLMAG_FEM_PETSC_VERSION +
        "\",\"slepc_version\":\"" + FULLMAG_FEM_SLEPC_VERSION +
        "\",\"unsupported_reason\":\"" + unsupported_reason + "\"}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0}";
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace fullmag::fem::frequency_domain
