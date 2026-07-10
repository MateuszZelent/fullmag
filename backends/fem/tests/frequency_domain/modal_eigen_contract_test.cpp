#include "cpu/frequency_domain/mfem_modal_operator_payload.hpp"
#include "fullmag_fem.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

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

std::string read_text(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(input.good(), "expected modal C ABI artifact file must be readable");
    return std::string(
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>());
}

struct CsrOwned {
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    FullmagFemCsrMatrixView view() const
    {
        return FullmagFemCsrMatrixView{
            rows,
            columns,
            row_offsets.data(),
            static_cast<std::uint64_t>(row_offsets.size()),
            column_indices.data(),
            static_cast<std::uint64_t>(column_indices.size()),
            values.data(),
            static_cast<std::uint64_t>(values.size())};
    }
};

CsrOwned dense_to_csr(
    std::uint64_t rows,
    std::uint64_t columns,
    const double *row_major_values)
{
    CsrOwned csr{};
    csr.rows = rows;
    csr.columns = columns;
    csr.row_offsets.reserve(static_cast<std::size_t>(rows + 1));
    csr.row_offsets.push_back(0);
    for (std::uint64_t row = 0; row < rows; ++row) {
        for (std::uint64_t column = 0; column < columns; ++column) {
            const double value =
                row_major_values[static_cast<std::size_t>(row * columns + column)];
            if (value != 0.0) {
                csr.column_indices.push_back(static_cast<std::uint32_t>(column));
                csr.values.push_back(value);
            }
        }
        csr.row_offsets.push_back(static_cast<std::uint32_t>(csr.values.size()));
    }
    return csr;
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

void modal_shift_invert_dense_full_2x2_payload_accepts_k0_kittel_macrospin()
{
    constexpr double mu0 = 1.25663706212e-6;
    constexpr double gamma0_rad_s_per_a_m = 2.211e5;
    constexpr double field_t = 0.02;
    constexpr double field_a_per_m = field_t / mu0;
    constexpr double omega_rad_s = gamma0_rad_s_per_a_m * field_a_per_m;
    constexpr double expected_frequency_hz = omega_rad_s / (2.0 * M_PI);
    const double stiffness_matrix_row_major[] = {
        omega_rad_s,
        0.0,
        0.0,
        omega_rad_s,
    };
    constexpr double gyrotropic_mass_row_major[] = {
        0.0,
        1.0,
        -1.0,
        0.0,
    };
    constexpr double tangent_mass_row_major[] = {
        1.0,
        0.0,
        0.0,
        1.0,
    };

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.target_frequency_hz = 2.55e9;
    request.frequency_min_hz = 100.0e6;
    request.frequency_max_hz = 5.0e9;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.mfem_mass_matrix_row_major = tangent_mass_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"rust_full_2x2_dense_operator\","
        "\"payload_kind\":\"rust_full_2x2_dense_operator\"}";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "full_2x2 Kittel dense payload should solve through production SLEPc path");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "full_2x2 Kittel dense payload accepts one positive-frequency mode");
    const double frequency_hz =
        extract_json_number(result.result_json, "\"frequency_hz\":");
    check(std::abs(frequency_hz - expected_frequency_hz) / expected_frequency_hz < 1.0e-10,
          "full_2x2 Kittel dense payload frequency matches gamma0 H/(2*pi)");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "full_2x2 Kittel dense payload remains unavailable without SLEPc");
#endif
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

void modal_nonzero_k_floquet_payload_rejects_until_production_operator_exists()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};
    constexpr double k_vector_rad_m[] = {1.0e6, 0.0, 0.0};

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.k_vector_rad_m = k_vector_rad_m;
    request.operator_request.k_vector_len = 3;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet modal payload must remain unavailable until the production operator exists");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "nonzero-k Floquet modal diagnostics expose production CPU rejection reason");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_scope\":\"selected_spectrum_nonzero_k_floquet_modal\""),
          "nonzero-k Floquet modal diagnostics expose rejection scope");
    check(contains(result.diagnostics_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\""),
          "nonzero-k Floquet modal diagnostics name the missing operator contract");
    check(contains(result.diagnostics_json,
                   "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\""),
          "nonzero-k Floquet modal diagnostics name the missing operator payload kind");
    check(contains(result.diagnostics_json, "\"modal_periodic_pair_contract_available\":false"),
          "nonzero-k Floquet modal diagnostics report missing modal periodic-pair contract");
    check(contains(result.result_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_periodic_pairs\""),
          "nonzero-k Floquet modal result names the missing operator contract");
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[1000000,0,0]"),
          "nonzero-k Floquet modal diagnostics preserve the requested k-vector");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_tail_payload_preserves_periodic_pair_contract()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal Floquet tail payload must reject until the production operator exists");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "modal Floquet tail diagnostics expose production CPU rejection reason");
    check(contains(result.diagnostics_json, "\"k_vector_rad_m\":[1000000,0,0]"),
          "modal Floquet tail diagnostics preserve the requested k-vector");
    check(contains(result.diagnostics_json, "\"floquet_periodic_pair_count\":1"),
          "modal Floquet tail diagnostics preserve the periodic-pair count");
    check(contains(result.diagnostics_json,
                   "\"modal_periodic_pair_contract_available\":true"),
          "modal Floquet tail diagnostics report the supplied periodic-pair contract");
    check(contains(result.diagnostics_json,
                   "\"required_operator_payload_kind\":\"bloch_floquet_tangent_operator\""),
          "modal Floquet tail diagnostics still name the missing operator payload kind");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_reaches_production_solver()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "nonzero-k Floquet Bloch payload reaches the production SLEPc path");
    check(contains(result.diagnostics_json, "\"execution_lane\":\"production_cpu\""),
          "nonzero-k Floquet Bloch payload diagnostics report production lane");
    check(contains(result.result_json, "\"accepted_mode_count\":1"),
          "nonzero-k Floquet Bloch payload solves one accepted mode");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet Bloch payload remains unavailable without SLEPc");
#endif
    check(!contains(result.diagnostics_json,
                    "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "nonzero-k Floquet Bloch payload must not be rejected as a missing operator");
    check(contains(result.diagnostics_json, "\"floquet_periodic_pair_count\":1"),
          "nonzero-k Floquet Bloch payload diagnostics preserve periodic-pair count");
    check(contains(result.diagnostics_json,
                   "\"payload_kind\":\"bloch_floquet_tangent_operator\""),
          "nonzero-k Floquet Bloch payload diagnostics preserve operator payload kind");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_rejects_gated_operator_terms()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"operator_terms_included\":[\"exchange\",\"dynamic_demag\"]}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet modal payload with gated operator terms must remain unavailable");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\""),
          "nonzero-k Floquet modal diagnostics expose gated operator terms rejection reason");
    check(contains(result.diagnostics_json, "\"gated_operator_term\":\"dynamic_demag\""),
          "nonzero-k Floquet modal diagnostics name the gated operator term");
    check(contains(result.result_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_gated_operator_terms_present\""),
          "nonzero-k Floquet modal result exposes gated operator terms rejection reason");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_nonzero_k_floquet_bloch_payload_with_demag_is_unavailable()
{
    constexpr double stiffness_matrix_row_major[] = {1.0, 0.0, 0.0, 1.0};
    constexpr double gyrotropic_mass_row_major[] = {0.0, -1.0, 1.0, 0.0};

    fullmag_fem_frequency_domain_floquet_periodic_pair pair{};
    pair.pair_id = "x_periodic_pair_0";
    pair.node_a = 10;
    pair.node_b = 20;
    pair.has_translation = 1;
    pair.translation_m[0] = 1.0e-6;
    pair.has_phase = 1;
    pair.phase_rad = -1.0;

    FullmagFemModalEigenRequest request = base_request();
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 0.1;
    request.frequency_max_hz = 0.2;
    request.eigensolver_family = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_tangent_dof_count = 2;
    request.mfem_stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.mfem_gyrotropic_matrix_row_major = gyrotropic_mass_row_major;
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "floquet_airbox";
    request.operator_request.operator_diagnostics_json =
        "{\"operator_family\":\"mfem_linearized_llg\","
        "\"payload_kind\":\"bloch_floquet_tangent_operator\","
        "\"demag_payload_kind\":\"dynamic_demag_k_operator\"}";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention =
        FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &pair;
    request.mfem_floquet_periodic_pair_count = 1;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "nonzero-k Floquet modal demag payload must remain unavailable until dynamic demag-k exists");
    check(contains(result.diagnostics_json,
                   "\"production_cpu_rejection_reason\":\"production_cpu_modal_dynamic_demag_k_operator_missing\""),
          "nonzero-k Floquet modal demag diagnostics reject a labelled dynamic demag-k payload");
    check(contains(result.diagnostics_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_dynamic_demag_k\""),
          "nonzero-k Floquet modal demag diagnostics name the dynamic demag-k operator contract");
    check(contains(result.diagnostics_json,
                   "\"required_demag_payload_kind\":\"dynamic_demag_k_operator\""),
          "nonzero-k Floquet modal demag diagnostics name the required demag payload kind");
    check(contains(result.diagnostics_json,
                   "\"dynamic_demag_operator_source\":\"missing_numeric_fem_demag_k\""),
          "nonzero-k Floquet modal demag diagnostics report missing dense block-real matrix data");
    check(!contains(result.diagnostics_json,
                    "\"dynamic_demag_operator_source\":\"provided_numeric_fem_demag_k_pending_full_fe_constraint_grad_k\""),
          "nonzero-k Floquet modal demag diagnostics must not report an unimplemented payload as provided");
    check(!contains(result.diagnostics_json,
                    "\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
          "nonzero-k Floquet modal demag must not be rejected as a generic missing Bloch payload");
    check(contains(result.result_json,
                   "\"required_operator_contract\":\"bloch_floquet_tangent_operator_with_dynamic_demag_k\""),
          "nonzero-k Floquet modal demag result names the dynamic demag-k operator contract");
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_poisson_airbox_tail_payload_reaches_full_coupled_solver()
{
    constexpr double omega0 = 6.283185307179586476925286766559 * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "periodic_airbox_k0";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.frequency_min_hz = 1.0e9;
    request.frequency_max_hz = 3.0e9;
    request.residual_tolerance = 1.0e-10;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = A_qq.view();
    request.poisson_airbox_a_qphi_csr = A_qphi.view();
    request.poisson_airbox_a_phiq_csr = A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    request.poisson_airbox_b_qq_csr = B_qq.view();
    request.poisson_airbox_phi_mean_weights = weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz = 2.0119012110259213e9;
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    if (result.status != FULLMAG_FEM_FD_OK) {
        std::fprintf(
            stderr,
            "modal Poisson-airbox tail status=%d error=%s diagnostics=%s result=%s\n",
            static_cast<int>(result.status),
            result.error_message != nullptr ? result.error_message : "",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "",
            result.result_json != nullptr ? result.result_json : "");
    }
    check(result.status == FULLMAG_FEM_FD_OK,
          "modal Poisson-airbox tail payload must solve through full-coupled SLEPc");
    check(contains(result.diagnostics_json,
                   "\"solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_slepc\""),
          "modal Poisson-airbox tail diagnostics name the full-coupled adapter");
    check(contains(result.diagnostics_json, "\"demag_kind\":\"periodic_airbox_k0\""),
          "modal Poisson-airbox tail diagnostics preserve periodic_airbox_k0");
    check(contains(result.diagnostics_json, "\"gauge_policy\":\"mean_zero_augmented\""),
          "modal Poisson-airbox tail diagnostics preserve mean-zero gauge");
    check(contains(result.result_json,
                   "\"solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_slepc\""),
          "modal Poisson-airbox tail result names the full-coupled adapter");
    check(contains(result.result_json, "\"demag_kind\":\"periodic_airbox_k0\""),
          "modal Poisson-airbox tail result preserves periodic_airbox_k0");
    check(contains(result.result_json, "\"phi_dof_count\":2"),
          "modal Poisson-airbox tail result reports phi DOF count");
    check(contains(result.result_json, "\"augmented_phi_dof_count\":3"),
          "modal Poisson-airbox tail result reports augmented phi DOF count");
    check(contains(result.result_json, "\"poisson_constraint_relative_residual\""),
          "modal Poisson-airbox tail result reports Poisson residual");
    check(contains(result.result_json, "\"periodic_mesh_certificate\""),
          "modal Poisson-airbox tail result reports periodic mesh certificate metadata");
    check(contains(result.result_json, "\"magnetic_pair_count\":1"),
          "modal Poisson-airbox tail result reports magnetic pair count");
    check(contains(result.result_json, "\"airbox_pair_count\":1"),
          "modal Poisson-airbox tail result reports airbox pair count");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal Poisson-airbox tail payload must require SLEPc when unavailable");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_poisson_airbox_tail_shift_invert_action_writes_artifact()
{
    constexpr double omega0 = 6.283185307179586476925286766559 * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};

    const std::filesystem::path output_dir =
        std::filesystem::temp_directory_path() /
        "fullmag-pa-g3d-modal-cabi-shift-invert-action";
    std::filesystem::remove_all(output_dir);
    std::filesystem::create_directories(output_dir);
    const std::string output_dir_string = output_dir.string();

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "periodic_airbox_k0";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.residual_tolerance = 1.0e-10;
    request.output_directory = output_dir_string.c_str();
    request.write_partial_artifacts = 1;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = A_qq.view();
    request.poisson_airbox_a_qphi_csr = A_qphi.view();
    request.poisson_airbox_a_phiq_csr = A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    request.poisson_airbox_b_qq_csr = B_qq.view();
    request.poisson_airbox_phi_mean_weights = weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz = 2.0119012110259213e9;
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";
    request.poisson_airbox_shift_invert_action_enabled = 1;
    request.poisson_airbox_shift_sigma_real = 0.0;
    request.poisson_airbox_shift_sigma_imag = 6.283185307179586476925286766559 * 1.25e9;
    request.poisson_airbox_shift_action_vector_real = v_re;
    request.poisson_airbox_shift_action_vector_imag = v_im;
    request.poisson_airbox_shift_action_vector_count = 2;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_FEM_WITH_SLEPC
    check(result.status == FULLMAG_FEM_FD_OK,
          "modal C ABI Poisson-airbox shift-invert action must solve");
    check(contains(result.artifact_manifest_path,
                   "poisson_airbox_modal_shift_invert_action.v1.json"),
          "modal C ABI result must point at the shift-invert action artifact");
    check(contains(result.result_json, "\"operator_family\":\"full_modal_shift_invert\""),
          "modal C ABI result must identify full modal shift-invert");
    const std::filesystem::path artifact_path =
        output_dir / "eigen" / "diagnostics" /
        "poisson_airbox_modal_shift_invert_action.v1.json";
    const std::string artifact = read_text(artifact_path);
    check(artifact.find("\"schema_version\":\"poisson_airbox_modal_shift_invert_action.v1\"") !=
              std::string::npos,
          "modal C ABI action artifact must expose schema version");
    check(artifact.find("\"full_modal_shift_invert_claim\":true") !=
              std::string::npos,
          "modal C ABI action artifact must claim true modal shift-invert");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal C ABI Poisson-airbox shift-invert action must require SLEPc when unavailable");
#endif
    fullmag_fem_frequency_domain_result_destroy(&result);
}

void modal_poisson_airbox_tail_gpu_shift_invert_action_writes_artifact()
{
    constexpr double omega0 = 6.283185307179586476925286766559 * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);
    const double v_re[2] = {1.0, -0.5};
    const double v_im[2] = {0.25, 0.75};

    const std::filesystem::path output_dir =
        std::filesystem::temp_directory_path() /
        "fullmag-pa-g3g-modal-cabi-gpu-shift-invert-action";
    std::filesystem::remove_all(output_dir);
    std::filesystem::create_directories(output_dir);
    const std::string output_dir_string = output_dir.string();

    FullmagFemModalEigenRequest request = base_request();
    request.operator_request.include_demag = 1;
    request.operator_request.demag_realization = "periodic_airbox_k0";
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.target_kind = "nearest_frequency";
    request.target_frequency_hz = 2.0e9;
    request.residual_tolerance = 1.0e-10;
    request.output_directory = output_dir_string.c_str();
    request.write_partial_artifacts = 1;
    request.poisson_airbox_block_enabled = 1;
    request.poisson_airbox_q_dof_count = 2;
    request.poisson_airbox_phi_dof_count = 2;
    request.poisson_airbox_a_qq_csr = A_qq.view();
    request.poisson_airbox_a_qphi_csr = A_qphi.view();
    request.poisson_airbox_a_phiq_csr = A_phiq.view();
    request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    request.poisson_airbox_b_qq_csr = B_qq.view();
    request.poisson_airbox_phi_mean_weights = weights;
    request.poisson_airbox_phi_mean_weights_count = 2;
    request.poisson_airbox_target_frequency_hz = 2.0e9;
    request.poisson_airbox_expected_reference_frequency_hz = 2.0119012110259213e9;
    request.poisson_airbox_periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    request.poisson_airbox_magnetic_pair_count = 1;
    request.poisson_airbox_airbox_pair_count = 1;
    request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    request.poisson_airbox_robin_beta = 0.0;
    request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";
    request.poisson_airbox_shift_invert_action_enabled = 1;
    request.poisson_airbox_shift_invert_action_device = 1;
    request.poisson_airbox_shift_sigma_real = 0.0;
    request.poisson_airbox_shift_sigma_imag = 6.283185307179586476925286766559 * 1.25e9;
    request.poisson_airbox_shift_action_vector_real = v_re;
    request.poisson_airbox_shift_action_vector_imag = v_im;
    request.poisson_airbox_shift_action_vector_count = 2;

    FullmagFemFrequencyDomainResult result = fullmag_fem_modal_eigen_solve(&request);
#if FULLMAG_HAS_CUDA_RUNTIME
    check(result.status == FULLMAG_FEM_FD_OK,
          "modal C ABI Poisson-airbox GPU shift-invert action must solve when CUDA is enabled");
    check(contains(result.artifact_manifest_path,
                   "gpu_modal_shift_invert_action.v1.json"),
          "modal C ABI result must point at the GPU shift-invert action artifact");
    check(contains(result.result_json,
                   "\"solver_adapter\":\"gpu_device_dense_modal_shift_invert_action_contract\""),
          "modal C ABI GPU action result must identify the GPU hidden action adapter");
    check(contains(result.result_json,
                   "\"execution_lane\":\"gpu_operator_host_modal_eigen_compatibility\""),
          "modal C ABI GPU action result must identify the hidden GPU-G4 compatibility lane");
    check(contains(result.result_json, "\"frequency_response_proxy\":false"),
          "modal C ABI GPU action result must reject frequency-response proxy semantics");
    const std::filesystem::path artifact_path =
        output_dir / "eigen" / "diagnostics" /
        "gpu_modal_shift_invert_action.v1.json";
    const std::string artifact = read_text(artifact_path);
    check(artifact.find("\"schema_version\":\"gpu_modal_shift_invert_action.v1\"") !=
              std::string::npos,
          "modal C ABI GPU action artifact must expose schema version");
    check(artifact.find("\"rhs_family\":\"modal_mass_times_vector\"") !=
              std::string::npos,
          "modal C ABI GPU action artifact must identify Bv RHS semantics");
    check(artifact.find("\"execution_lane\":\"gpu_operator_host_modal_eigen_compatibility\"") !=
              std::string::npos,
          "modal C ABI GPU action artifact must identify the hidden GPU-G4 compatibility lane");
    check(artifact.find("\"frequency_response_proxy\":false") !=
              std::string::npos,
          "modal C ABI GPU action artifact must reject frequency-response proxy semantics");
#else
    check(result.status == FULLMAG_FEM_FD_UNAVAILABLE,
          "modal C ABI Poisson-airbox GPU shift-invert action must require CUDA when unavailable");
#endif
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
    modal_shift_invert_dense_full_2x2_payload_accepts_k0_kittel_macrospin();
    modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator();
    modal_without_validation_problem_stays_unavailable();
    modal_sparse_validation_error_preserves_explicit_k_vector();
    modal_diagnostics_preserve_explicit_k_vector();
    modal_nonzero_k_floquet_payload_rejects_until_production_operator_exists();
    modal_nonzero_k_floquet_tail_payload_preserves_periodic_pair_contract();
    modal_nonzero_k_floquet_bloch_payload_reaches_production_solver();
    modal_nonzero_k_floquet_bloch_payload_rejects_gated_operator_terms();
    modal_nonzero_k_floquet_bloch_payload_with_demag_is_unavailable();
    modal_poisson_airbox_tail_payload_reaches_full_coupled_solver();
    modal_poisson_airbox_tail_shift_invert_action_writes_artifact();
    modal_poisson_airbox_tail_gpu_shift_invert_action_writes_artifact();
    return 0;
}
