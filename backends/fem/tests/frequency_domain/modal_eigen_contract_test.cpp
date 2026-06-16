#include "fullmag_fem.h"

#include <cmath>
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

double extract_json_number(const char *json, const char *key)
{
    check(json != nullptr, "JSON buffer must be present");
    const char *start = std::strstr(json, key);
    check(start != nullptr, "JSON key must be present");
    start += std::strlen(key);
    char *end = nullptr;
    const double value = std::strtod(start, &end);
    check(end != start, "JSON numeric value must parse");
    return value;
}

char g_last_progress_json[2048]{};

void reset_progress_capture()
{
    g_last_progress_json[0] = '\0';
}

void capture_progress(void *, const char *progress_json)
{
    if (progress_json == nullptr) {
        g_last_progress_json[0] = '\0';
        return;
    }
    std::snprintf(
        g_last_progress_json,
        sizeof(g_last_progress_json),
        "%s",
        progress_json);
}

int always_cancel(void *)
{
    return 1;
}

FullmagFemModalEigenRequest base_request()
{
    FullmagFemModalEigenRequest request{};
    request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    request.operator_request.mesh_asset_id = "macrospin_validation";
    request.operator_request.equilibrium_source_kind = "provided";
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.alpha = 0.0;
    request.requested_mode_count = 1;
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 0.16;
    request.frequency_min_hz = 0.0;
    request.frequency_max_hz = 1.0;
    request.residual_tolerance = 1.0e-12;
    request.max_outer_iterations = 32;
    request.max_linear_iterations = 128;
    return request;
}

void modal_dependency_info_is_reported()
{
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
}

void modal_invalid_abi_returns_validation_error()
{
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
}

void modal_shift_invert_finds_macrospin_mode()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK, "macrospin modal validation should succeed");
    check(contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
          "macrospin modal validation diagnostics identify validation lane");
    check(contains(result.result_json, "\"status\":\"ok\""),
          "macrospin modal result reports ok");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "macrospin modal result accepts one positive-frequency mode");
    const double frequency_hz =
        extract_json_number(result.result_json, "\"frequency_hz\":");
    check(std::abs(frequency_hz - 0.15915494309189535) < 1.0e-12,
          "macrospin modal frequency matches 1/(2*pi)");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_residual_below_tolerance()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK, "macrospin residual validation should succeed");
    const double residual =
        extract_json_number(result.result_json, "\"relative_residual\":");
    check(residual <= request.residual_tolerance,
          "macrospin modal residual must satisfy requested tolerance");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_reports_ksp_iterations()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    reset_progress_capture();
    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;
    request.progress_callback = capture_progress;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK, "progress-reporting modal validation should succeed");
    check(contains(g_last_progress_json, "\"solver_phase\":\"solving_shift_invert\""),
          "modal progress phase reports solving_shift_invert");
    check(contains(g_last_progress_json, "\"outer_iteration\":1"),
          "modal progress reports outer iterations");
    check(contains(g_last_progress_json, "\"linear_iteration\":1"),
          "modal progress reports shifted linear iterations");
    check(contains(g_last_progress_json, "\"accepted_mode_count\":1"),
          "modal progress reports accepted mode count");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_cancel_returns_interrupted()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;
    request.cancel_requested = always_cancel;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_INTERRUPTED,
          "modal cancellation must report interrupted");
    check(contains(result.diagnostics_json, "\"status\":\"interrupted\""),
          "cancelled modal diagnostics report interrupted");
    check(contains(result.diagnostics_json, "\"stop_reason\":\"cancel_requested\""),
          "cancelled modal diagnostics report cancel stop reason");
    check(contains(result.result_json, "\"status\":\"interrupted\""),
          "cancelled modal result reports interrupted");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void frequency_window_reports_unresolved_subwindow()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.max_outer_iterations = 0;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_SOLVE_ERROR,
          "unresolved frequency window must not report ok");
    check(contains(result.diagnostics_json, "\"window_completeness\""),
          "unresolved frequency window diagnostics include completeness");
    check(contains(result.diagnostics_json, "\"status\":\"partial_convergence\""),
          "unresolved frequency window reports partial convergence");
    check(contains(result.diagnostics_json, "\"stop_reason\":\"max_iterations\""),
          "unresolved frequency window records max_iterations stop reason");
    check(contains(result.result_json, "\"window_completeness\":\"partial_convergence\""),
          "unresolved frequency window result exposes completeness status");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_without_validation_problem_stays_unavailable()
{
    FullmagFemModalEigenRequest request = base_request();

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal contract without validation problem stays unavailable");
    check(contains(result.diagnostics_json, "\"study_product\":\"modal_eigen\""),
          "modal diagnostics preserve study_product");
    check(contains(result.diagnostics_json, "progress_schema_version"),
          "modal diagnostics expose progress schema");
    check(contains(result.result_json, "\"status\":\"unavailable\""),
          "modal result json reports unavailable");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

} // namespace

int main()
{
    FullmagFemFrequencyDomainResult zeroed{};
    fullmag_fem_frequency_domain_result_destroy(&zeroed);
    check(zeroed.status == static_cast<FullmagFemFrequencyDomainStatus>(0),
          "destroy on zeroed result must be idempotent");

    modal_dependency_info_is_reported();
    modal_invalid_abi_returns_validation_error();
    modal_shift_invert_finds_macrospin_mode();
    modal_shift_invert_residual_below_tolerance();
    modal_shift_invert_reports_ksp_iterations();
    modal_shift_invert_cancel_returns_interrupted();
    frequency_window_reports_unresolved_subwindow();
    modal_without_validation_problem_stays_unavailable();
    return 0;
}
