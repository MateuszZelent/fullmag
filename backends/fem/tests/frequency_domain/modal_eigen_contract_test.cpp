#include "cpu/frequency_domain/mfem_modal_operator_payload.hpp"
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
int g_progress_event_count = 0;

void reset_progress_capture()
{
    g_last_progress_json[0] = '\0';
    g_progress_event_count = 0;
}

void capture_progress(void *, const char *progress_json)
{
    ++g_progress_event_count;
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

void modal_shift_invert_validation_reports_slepc_adapter_configuration()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK,
          "macrospin SLEPc modal validation should succeed");
#if FULLMAG_FEM_WITH_SLEPC
    check(contains(result.diagnostics_json, "\"solver_adapter\":\"slepc_modal_eigen\""),
          "macrospin validation diagnostics must name the SLEPc modal adapter");
    check(contains(result.diagnostics_json, "\"solver_family\":\"slepc_shift_invert_validation\""),
          "macrospin validation diagnostics must report the SLEPc shift-invert family");
    check(contains(result.diagnostics_json, "\"eps_type\":\"krylovschur\""),
          "macrospin validation diagnostics must report the SLEPc EPS type");
    check(contains(result.diagnostics_json, "\"slepc_problem_type\":\"gnhep\""),
          "macrospin validation diagnostics must report the generalized non-Hermitian problem type");
    check(contains(result.diagnostics_json, "\"spectral_transform\":\"shift_invert\""),
          "macrospin validation diagnostics must report shift-invert spectral transform");
    check(contains(result.diagnostics_json, "\"which_eigenpairs\":\"target_magnitude\""),
          "macrospin validation diagnostics must report target-magnitude eigenpair selection");
    check(contains(result.diagnostics_json, "\"ksp_type\":\"preonly\""),
          "macrospin validation diagnostics must report the shifted linear KSP type");
    check(contains(result.diagnostics_json, "\"pc_type\":\"lu\""),
          "macrospin validation diagnostics must report the shifted linear PC type");
    check(contains(result.diagnostics_json, "\"ksp_rtol\":"),
          "macrospin validation diagnostics must report KSP relative tolerance");
    check(contains(result.diagnostics_json, "\"ksp_atol\":"),
          "macrospin validation diagnostics must report KSP absolute tolerance");
    check(contains(result.diagnostics_json, "\"ksp_max_iterations\":128"),
          "macrospin validation diagnostics must report KSP iteration cap");
    check(contains(result.diagnostics_json, "\"ksp_final_residual\":"),
          "macrospin validation diagnostics must report final KSP residual");
    check(contains(result.result_json, "\"solver_adapter\":\"slepc_modal_eigen\""),
          "macrospin validation result must name the SLEPc modal adapter");
#else
    check(contains(result.diagnostics_json, "\"solver_family\":\"analytic_validation_shift_target\""),
          "non-SLEPc macrospin validation keeps the analytic validation family");
#endif
    const double diagnostics_shift_frequency_hz =
        extract_json_number(result.diagnostics_json, "\"shift_frequency_hz\":");
    check(std::abs(diagnostics_shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "macrospin validation diagnostics must report the requested shift frequency");
    const double diagnostics_shift_omega_rad_s =
        extract_json_number(result.diagnostics_json, "\"shift_omega_rad_s\":");
    check(std::abs(diagnostics_shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "macrospin validation diagnostics must report the angular shift");
    const double result_shift_frequency_hz =
        extract_json_number(result.result_json, "\"shift_frequency_hz\":");
    check(std::abs(result_shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "macrospin validation result must report the requested shift frequency");
    const double result_shift_omega_rad_s =
        extract_json_number(result.result_json, "\"shift_omega_rad_s\":");
    check(std::abs(result_shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "macrospin validation result must report the angular shift");
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
    const double current_shift_hz =
        extract_json_number(g_last_progress_json, "\"current_shift_hz\":");
    check(std::abs(current_shift_hz - request.target_frequency_hz) < 1.0e-15,
          "modal progress preserves the legacy current shift");
    const double shift_frequency_hz =
        extract_json_number(g_last_progress_json, "\"shift_frequency_hz\":");
    check(std::abs(shift_frequency_hz - request.target_frequency_hz) < 1.0e-15,
          "modal progress reports shift frequency provenance");
    const double shift_omega_rad_s =
        extract_json_number(g_last_progress_json, "\"shift_omega_rad_s\":");
    check(std::abs(shift_omega_rad_s - 2.0 * M_PI * request.target_frequency_hz) < 1.0e-15,
          "modal progress reports angular shift provenance");
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

void frequency_window_wide_auto_selects_contour_interval_solver()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    reset_progress_capture();
    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.eigensolver_family = 0;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_mass_matrix_row_major = gyrotropic_mass_row_major;
    request.progress_callback = capture_progress;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_OK,
          "wide frequency window should select the contour interval solver");
    check(contains(result.diagnostics_json, "\"resolved_solver_family\":\"contour_interval\""),
          "wide frequency window diagnostics expose the contour solver family");
    check(contains(result.diagnostics_json, "\"solver_selection_reason\":\"frequency_window_relative_width_ge_0.5\""),
          "wide frequency window diagnostics expose resolved policy");
    check(contains(result.diagnostics_json, "\"contour_point_count\":16"),
          "contour diagnostics expose contour point count");
    check(contains(result.diagnostics_json, "\"certified_count\":true"),
          "contour diagnostics expose certified contour count separately");
    check(contains(result.result_json, "\"window_completeness\":\"certified\""),
          "contour interval result exposes certified window completeness");
    check(g_progress_event_count == 16,
          "contour interval solve must emit one progress event per contour point");
    check(contains(g_last_progress_json, "\"solver_phase\":\"solving_contour_interval\""),
          "contour progress reports solving_contour_interval");
    check(contains(g_last_progress_json, "\"contour_point_index\":15"),
          "contour progress reports the final contour point index");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_frequency_window_production_payload_contour_accepts_multiple_modes()
{
    constexpr double stiffness_matrix_row_major[] = {
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 2.0, 0.0,
        0.0, 0.0, 0.0, 2.0,
    };
    constexpr double gyrotropic_matrix_row_major[] = {
        0.0, -1.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, -1.0,
        0.0, 0.0, 1.0, 0.0,
    };

    reset_progress_capture();
    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.5;
    request.requested_mode_count = 4;
    request.eigensolver_family = 2;
    request.completeness_policy = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 4;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_matrix_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\",\"tangent_dof_count\":4}";
    request.progress_callback = capture_progress;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "multi-mode production contour payload should solve through the contour interval adapter");
    check(contains(result.diagnostics_json, "\"resolved_solver_family\":\"contour_interval\""),
          "multi-mode contour diagnostics expose the contour solver family");
    check(contains(result.diagnostics_json, "\"solver_model\":\"contour_interval_production_cpu_dense\""),
          "multi-mode contour diagnostics publish the production contour solver model");
    check(contains(result.diagnostics_json, "\"solver_family\":\"contour_interval_production_cpu_dense\""),
          "multi-mode contour diagnostics report the production contour family");
    check(contains(result.diagnostics_json, "\"estimated_mode_count\":2"),
          "multi-mode contour diagnostics publish the certified mode count");
    check(contains(result.diagnostics_json, "\"projection_rank\":2"),
          "multi-mode contour diagnostics publish projector rank");
    check(contains(result.diagnostics_json, "\"accepted_mode_count\":2"),
          "multi-mode contour diagnostics accept both modes");
    check(contains(result.result_json, "\"accepted_mode_count\":2"),
          "multi-mode contour result accepts both modes");
    check(contains(result.result_json, "\"frequency_hz\":0.159154943091895"),
          "multi-mode contour result includes the lower positive mode");
    check(contains(result.result_json, "\"frequency_hz\":0.318309886183790"),
          "multi-mode contour result includes the upper positive mode");
    check(contains(result.result_json, "\"mode_vector_real\":["),
          "multi-mode contour result publishes global real mode vectors");
    check(contains(result.result_json, "\"mode_vector_imag\":["),
          "multi-mode contour result publishes global imaginary mode vectors");
    check(contains(result.result_json, "\"window_completeness\":\"certified\""),
          "multi-mode contour result exposes certified window completeness");
    check(g_progress_event_count == 16,
          "multi-mode production contour payload must emit one progress event per contour point");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "multi-mode production contour payload remains unavailable without SLEPc");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_payload_can_be_assembled_from_mfem_operator()
{
    namespace fd = fullmag::fem::frequency_domain;

    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM modal payload tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM modal payload tangent layout succeeds");

    const double h_ext_a_per_m[] = {0.0, 0.0, 1.0};
    const double tangent_lumped_mass[] = {2.0};
    double stiffness_matrix_row_major[4]{};
    double dynamic_mass_matrix_row_major[4]{};
    double tangent_mass_matrix_row_major[4]{};
    fd::MfemModalDenseOperatorPayloadResult payload_result{};
    const fd::FrequencyDomainStatus payload_status =
        fd::assemble_mfem_modal_dense_operator_payload(
            fd::MfemModalDenseOperatorPayloadProblem{
                descriptor,
                layout,
                &node,
                nullptr,
                0,
                h_ext_a_per_m,
                nullptr,
                0.0,
                nullptr,
                tangent_lumped_mass,
                1.0,
                0.0,
                stiffness_matrix_row_major,
                dynamic_mass_matrix_row_major,
                tangent_mass_matrix_row_major,
                4,
            },
            &payload_result);

    check(payload_status == fd::FrequencyDomainStatus::ok,
          "MFEM modal dense payload assembly succeeds");
    check(payload_result.tangent_dof_count == 2,
          "MFEM modal payload keeps tangent DOF count");
    check(std::strcmp(payload_result.payload_kind, "dense_linearized_mfem_operator") == 0,
          "MFEM modal payload reports dense linearized payload kind");
    check(std::strcmp(payload_result.algebraic_form, "first_order_complex") == 0,
          "MFEM modal payload reports first-order complex algebraic form");
    check(std::abs(payload_result.max_abs_tangent_mass_matrix - 2.0) < 1.0e-12,
          "MFEM modal payload reports tangent mass matrix scale");
    check(std::abs(stiffness_matrix_row_major[0]) < 1.0e-12,
          "MFEM modal payload dynamic matrix k00");
    check(std::abs(stiffness_matrix_row_major[1] + 1.0) < 1.0e-12,
          "MFEM modal payload dynamic matrix k01");
    check(std::abs(stiffness_matrix_row_major[2] - 1.0) < 1.0e-12,
          "MFEM modal payload dynamic matrix k10");
    check(std::abs(stiffness_matrix_row_major[3]) < 1.0e-12,
          "MFEM modal payload dynamic matrix k11");
    check(std::abs(dynamic_mass_matrix_row_major[0] - 1.0) < 1.0e-12,
          "MFEM modal payload mass matrix m00");
    check(std::abs(dynamic_mass_matrix_row_major[1]) < 1.0e-12,
          "MFEM modal payload mass matrix m01");
    check(std::abs(dynamic_mass_matrix_row_major[2]) < 1.0e-12,
          "MFEM modal payload mass matrix m10");
    check(std::abs(dynamic_mass_matrix_row_major[3] - 1.0) < 1.0e-12,
          "MFEM modal payload mass matrix m11");
    check(std::abs(tangent_mass_matrix_row_major[0] - 2.0) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt00");
    check(std::abs(tangent_mass_matrix_row_major[1]) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt01");
    check(std::abs(tangent_mass_matrix_row_major[2]) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt10");
    check(std::abs(tangent_mass_matrix_row_major[3] - 2.0) < 1.0e-12,
          "MFEM modal payload tangent mass matrix mt11");

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = payload_result.tangent_dof_count;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = dynamic_mass_matrix_row_major;
    request.mfem_mass_matrix_row_major = tangent_mass_matrix_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\",\"payload_kind\":\"dense_linearized_mfem_operator\"}";
    constexpr double k_vector_rad_m[] = {0.0, 0.0, 0.0};
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "MFEM-assembled modal payload should solve through production SLEPc path");
    check(contains(result.diagnostics_json, "\"execution_lane\":\"production_cpu\""),
          "MFEM-assembled modal payload diagnostics report production lane");
    check(contains(result.diagnostics_json, "\"solver_family\":\"slepc_multi_shift_invert_production_cpu_dense\""),
          "MFEM-assembled modal payload diagnostics report production multi-shift SLEPc family");
    check(contains(result.diagnostics_json, "\"solver_model\":\"slepc_multi_shift_invert_production_cpu_dense\""),
          "MFEM-assembled modal payload diagnostics publish production multi-shift solver model");
    check(contains(result.diagnostics_json, "\"deduplication_mass_matrix\":\"provided\""),
          "MFEM-assembled modal payload diagnostics report provided tangent mass");
    const double frequency_hz =
        extract_json_number(result.result_json, "\"frequency_hz\":");
    check(std::abs(frequency_hz - 0.15915494309189535) < 1.0e-10,
          "MFEM-assembled modal payload frequency matches one radian per second");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "MFEM-assembled modal payload remains unavailable without SLEPc");
#endif
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "MFEM-assembled modal payload diagnostics preserve explicit k-vector");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator()
{
    namespace fd = fullmag::fem::frequency_domain;

    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM sparse modal payload tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM sparse modal payload tangent layout succeeds");

    const double h_ext_a_per_m[] = {0.0, 0.0, 1.0};
    const double tangent_lumped_mass[] = {2.0};
    uint32_t dynamic_offsets[3]{};
    uint32_t dynamic_columns[2]{};
    double dynamic_values[2]{};
    uint32_t gyrotropic_offsets[3]{};
    uint32_t gyrotropic_columns[2]{};
    double gyrotropic_values[2]{};
    uint32_t mass_offsets[3]{};
    uint32_t mass_columns[2]{};
    double mass_values[2]{};
    fd::MfemModalSparseOperatorPayloadResult payload_result{};
    const fd::FrequencyDomainStatus payload_status =
        fd::assemble_mfem_modal_sparse_operator_payload(
            fd::MfemModalSparseOperatorPayloadProblem{
                fd::MfemModalDenseOperatorPayloadProblem{
                    descriptor,
                    layout,
                    &node,
                    nullptr,
                    0,
                    h_ext_a_per_m,
                    nullptr,
                    0.0,
                    nullptr,
                    tangent_lumped_mass,
                    1.0,
                    0.0,
                    nullptr,
                    nullptr,
                    nullptr,
                    0,
                },
                fd::MfemModalCsrOutputBuffer{
                    dynamic_offsets,
                    3,
                    dynamic_columns,
                    2,
                    dynamic_values,
                    2,
                },
                fd::MfemModalCsrOutputBuffer{
                    gyrotropic_offsets,
                    3,
                    gyrotropic_columns,
                    2,
                    gyrotropic_values,
                    2,
                },
                fd::MfemModalCsrOutputBuffer{
                    mass_offsets,
                    3,
                    mass_columns,
                    2,
                    mass_values,
                    2,
                },
                1.0e-15,
            },
            &payload_result);

    check(payload_status == fd::FrequencyDomainStatus::ok,
          "MFEM modal sparse payload assembly succeeds");
    check(payload_result.tangent_dof_count == 2,
          "MFEM sparse modal payload keeps tangent DOF count");
    check(std::strcmp(payload_result.payload_kind, "sparse_csr_from_dense_linearized_mfem_operator") == 0,
          "MFEM sparse modal payload reports materialized sparse payload kind");
    check(payload_result.dynamic_matrix_nnz == 2,
          "MFEM sparse modal dynamic matrix keeps two nonzero entries");
    check(payload_result.dynamic_mass_matrix_nnz == 2,
          "MFEM sparse modal gyrotropic mass matrix keeps two nonzero entries");
    check(payload_result.tangent_mass_matrix_nnz == 2,
          "MFEM sparse modal tangent mass matrix keeps two nonzero entries");
    check(dynamic_offsets[0] == 0 && dynamic_offsets[1] == 1 && dynamic_offsets[2] == 2,
          "MFEM sparse modal dynamic row offsets are compact");
    check(dynamic_columns[0] == 1 && dynamic_columns[1] == 0,
          "MFEM sparse modal dynamic columns preserve off-diagonal gyrotropic structure");
    check(std::abs(dynamic_values[0] + 1.0) < 1.0e-12,
          "MFEM sparse modal dynamic first value");
    check(std::abs(dynamic_values[1] - 1.0) < 1.0e-12,
          "MFEM sparse modal dynamic second value");
    check(gyrotropic_offsets[0] == 0 && gyrotropic_offsets[1] == 1 && gyrotropic_offsets[2] == 2,
          "MFEM sparse modal gyrotropic row offsets are compact");
    check(gyrotropic_columns[0] == 0 && gyrotropic_columns[1] == 1,
          "MFEM sparse modal gyrotropic columns preserve diagonal mass");
    check(std::abs(gyrotropic_values[0] - 1.0) < 1.0e-12,
          "MFEM sparse modal gyrotropic first value");
    check(std::abs(gyrotropic_values[1] - 1.0) < 1.0e-12,
          "MFEM sparse modal gyrotropic second value");
    check(mass_offsets[0] == 0 && mass_offsets[1] == 1 && mass_offsets[2] == 2,
          "MFEM sparse modal tangent mass row offsets are compact");
    check(mass_columns[0] == 0 && mass_columns[1] == 1,
          "MFEM sparse modal tangent mass columns preserve diagonal mass");
    check(std::abs(mass_values[0] - 2.0) < 1.0e-12,
          "MFEM sparse modal tangent mass first value");
    check(std::abs(mass_values[1] - 2.0) < 1.0e-12,
          "MFEM sparse modal tangent mass second value");

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_sparse_operator_enabled = 1;
    request.mfem_sparse_stiffness_csr =
        FullmagFemCsrMatrixView{2, 2, dynamic_offsets, 3, dynamic_columns, payload_result.dynamic_matrix_nnz, dynamic_values, payload_result.dynamic_matrix_nnz};
    request.mfem_sparse_gyrotropic_csr =
        FullmagFemCsrMatrixView{2, 2, gyrotropic_offsets, 3, gyrotropic_columns, payload_result.dynamic_mass_matrix_nnz, gyrotropic_values, payload_result.dynamic_mass_matrix_nnz};
    request.mfem_sparse_mass_csr =
        FullmagFemCsrMatrixView{2, 2, mass_offsets, 3, mass_columns, payload_result.tangent_mass_matrix_nnz, mass_values, payload_result.tangent_mass_matrix_nnz};
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\",\"payload_kind\":\"sparse_csr_from_dense_linearized_mfem_operator\"}";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "MFEM-assembled sparse modal payload should solve through production SLEPc path");
    check(contains(result.diagnostics_json, "\"mfem_operator_payload\":\"sparse_csr\""),
          "MFEM-assembled sparse modal payload diagnostics report sparse CSR payload");
    check(contains(result.diagnostics_json, "\"solver_model\":\"slepc_multi_shift_invert_production_cpu_sparse_csr\""),
          "MFEM-assembled sparse modal payload diagnostics report sparse multi-shift SLEPc family");
    check(contains(result.diagnostics_json, "\"deduplication_mass_matrix\":\"provided_sparse_csr\""),
          "MFEM-assembled sparse modal payload diagnostics report provided sparse tangent mass");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "MFEM-assembled sparse modal payload remains unavailable without SLEPc");
#endif
    check(!contains(result.diagnostics_json, "\"mfem_operator_payload\":\"dense_gyrotropic_matrix\""),
          "MFEM-assembled sparse modal payload must not fall back to the dense MFEM payload lane");
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

void modal_sparse_validation_error_preserves_explicit_k_vector()
{
    constexpr double k_vector_rad_m[] = {0.0, 0.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.mfem_sparse_operator_enabled = 1;
    request.mfem_sparse_stiffness_csr.row_count = 1;
    request.mfem_sparse_stiffness_csr.column_count = 1;
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_VALIDATION_ERROR,
          "modal sparse validation error keeps validation status");
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "modal sparse validation diagnostics preserve the explicit k-vector");
    check(contains(result.diagnostics_json, "\"k_vector_len\":3"),
          "modal sparse validation diagnostics preserve the explicit k-vector length");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_diagnostics_preserve_explicit_k_vector()
{
    constexpr double k_vector_rad_m[] = {0.0, 0.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[0,0,0]"),
          "modal diagnostics preserve the explicit k-vector");
    check(contains(result.diagnostics_json, "\"k_vector_len\":3"),
          "modal diagnostics preserve the explicit k-vector length");
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
    modal_shift_invert_validation_reports_slepc_adapter_configuration();
    modal_shift_invert_reports_ksp_iterations();
    modal_shift_invert_cancel_returns_interrupted();
    frequency_window_reports_unresolved_subwindow();
    frequency_window_wide_auto_selects_contour_interval_solver();
    modal_frequency_window_production_payload_contour_accepts_multiple_modes();
    modal_shift_invert_payload_can_be_assembled_from_mfem_operator();
    modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator();
    modal_without_validation_problem_stays_unavailable();
    modal_sparse_validation_error_preserves_explicit_k_vector();
    modal_diagnostics_preserve_explicit_k_vector();
    return 0;
}
