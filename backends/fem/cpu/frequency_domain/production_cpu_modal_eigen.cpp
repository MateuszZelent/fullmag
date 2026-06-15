#include "frequency_domain/modal_eigen_solver.hpp"

#include "frequency_domain/solver_progress.hpp"

namespace fullmag::fem::frequency_domain {

FrequencyDomainContractResult production_cpu_modal_eigen_unavailable(
    const ModalEigenRequest &request) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.error_message =
        "native FEM modal_eigen production CPU solver is not implemented yet";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"execution_lane\":\"production_cpu\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"unsupported_reason\":\"modal_solver_not_implemented\"}";
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"unavailable\","
        "\"accepted_mode_count\":0}";
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace fullmag::fem::frequency_domain
