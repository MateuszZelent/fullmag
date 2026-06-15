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
    const double frequencies_hz[] = {1.0e9, 1.5e9};
    const double excitation_field_A_m[] = {0.0, 1.0, 0.0};

    FullmagFemDrivenResponseRequest invalid{};
    invalid.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    invalid.operator_request.abi_version = 999u;
    FullmagFemFrequencyDomainResult invalid_result =
        fullmag_fem_driven_response_solve(&invalid);
    check(invalid_result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "invalid driven ABI must return validation_error");
    check(contains(invalid_result.diagnostics_json, "unsupported_abi_version"),
          "invalid driven ABI exposes diagnostics");
    fullmag_fem_frequency_domain_result_destroy(&invalid_result);

    FullmagFemDrivenResponseRequest request{};
    request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.mesh_asset_id = "mesh";
    request.operator_request.equilibrium_source_kind = "relax";
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.alpha = 0.01;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 2;
    request.excitation_field_A_m = excitation_field_A_m;
    request.excitation_field_len = 3;
    request.excitation_phase_rad = 0.0;
    request.residual_tolerance = 1.0e-8;
    request.max_linear_iterations = 256;

    FullmagFemFrequencyDomainResult result = fullmag_fem_driven_response_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "driven skeleton returns structured unavailable");
    check(contains(result.diagnostics_json, "\"study_product\":\"driven_response\""),
          "driven diagnostics preserve study_product");
    check(contains(result.result_json, "\"status\":\"unavailable\""),
          "driven result json reports unavailable");
    fullmag_fem_frequency_domain_result_destroy(&result);

    return 0;
}
