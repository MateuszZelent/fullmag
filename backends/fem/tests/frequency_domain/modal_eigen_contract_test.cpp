#include "fullmag_fem.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool contains(const char *haystack, const char *needle)
{
    return haystack != nullptr && std::strstr(haystack, needle) != nullptr;
}

} // namespace

int main()
{
    FullmagFemFrequencyDomainResult zeroed{};
    fullmag_fem_frequency_domain_result_destroy(&zeroed);
    check(zeroed.status == static_cast<FullmagFemFrequencyDomainStatus>(0),
          "destroy on zeroed result must be idempotent");

    fullmag_fem_frequency_domain_dependency_info dependency_info{};
    check(
        fullmag_fem_get_frequency_domain_dependency_info(&dependency_info) ==
            FULLMAG_FEM_OK,
        "frequency-domain dependency info query succeeds");
    check(
        contains(
            dependency_info.diagnostics_json,
            "modal_eigen_native_cpu_slepc_available"),
        "dependency diagnostics expose modal_eigen_native_cpu_slepc_available");
#if FULLMAG_FEM_WITH_SLEPC
    check(dependency_info.petsc_available == 1, "PETSc dependency is available");
    check(dependency_info.slepc_available == 1, "SLEPc dependency is available");
    check(
        dependency_info.modal_eigen_native_cpu_slepc_available == 1,
        "modal_eigen native CPU SLEPc capability is available");
    check(std::strlen(dependency_info.petsc_version) > 0, "PETSc version is populated");
    check(std::strlen(dependency_info.slepc_version) > 0, "SLEPc version is populated");
#else
    check(dependency_info.slepc_available == 0, "SLEPc dependency is not available");
    check(
        dependency_info.modal_eigen_native_cpu_slepc_available == 0,
        "modal_eigen native CPU SLEPc capability is unavailable");
#endif

    FullmagFemModalEigenRequest invalid{};
    invalid.abi_version = 999u;
    invalid.operator_request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    FullmagFemFrequencyDomainResult invalid_result =
        fullmag_fem_modal_eigen_solve(&invalid);
    check(invalid_result.abi_version == FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
          "modal result returns ABI version");
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "invalid modal ABI must return validation_error");
    check(contains(invalid_result.diagnostics_json, "unsupported_abi_version"),
          "invalid modal ABI exposes diagnostics");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    FullmagFemModalEigenRequest request{};
    request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.mesh_asset_id = "mesh";
    request.operator_request.equilibrium_source_kind = "relax";
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.alpha = 0.01;
    request.requested_mode_count = 8;
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 1.0e8;
    request.frequency_max_hz = 5.0e9;
    request.residual_tolerance = 1.0e-8;
    request.max_outer_iterations = 32;
    request.max_linear_iterations = 128;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal skeleton returns structured unavailable");
    check(contains(result.diagnostics_json, "\"study_product\":\"modal_eigen\""),
          "modal diagnostics preserve study_product");
    check(contains(result.diagnostics_json, "progress_schema_version"),
          "modal diagnostics expose progress schema");
    check(contains(result.result_json, "\"status\":\"unavailable\""),
          "modal result json reports unavailable");
    fullmag_fem_frequency_domain_result_destroy(&result);

    return 0;
}
