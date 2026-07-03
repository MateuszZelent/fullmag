#include "frequency_domain/driven_response_solver.hpp"

#include "cpu/frequency_domain/dense_driven_response.hpp"
#include "cpu/frequency_domain/production_cpu_driven_response.hpp"

#include <algorithm>
#include <cerrno>
#include <cstdarg>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <string>
#include <vector>

#include <sys/stat.h>
#include <sys/types.h>

#if FULLMAG_HAS_CUDA_RUNTIME
extern "C" int fullmag_fem_frequency_domain_apply_mfem_gpu_operator(
    unsigned long long node_count,
    unsigned long long tangent_dof_count,
    const fullmag::fem::frequency_domain::TangentFrameNode *nodes,
    int exchange_enabled,
    const fullmag::fem::frequency_domain::TangentOperatorEdgeBlock *exchange_edges,
    unsigned long long exchange_edge_count,
    int zeeman_enabled,
    const double h_ext_a_per_m[3],
    int uniaxial_anisotropy_enabled,
    const double uniaxial_anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    const double *alpha_per_node,
    const double *demag_tangent,
    double alpha,
    double gamma0,
    const double *tangent_in,
    double *out_stiffness,
    double *out_mass,
    char *error_message,
    unsigned long long error_message_len);
#endif

namespace fullmag::fem::frequency_domain {

namespace {

char *duplicate_string(const char *value) noexcept
{
    if (value == nullptr) {
        value = "";
    }
    const std::size_t length = std::strlen(value);
    char *copy = new (std::nothrow) char[length + 1];
    if (copy == nullptr) {
        return nullptr;
    }
    std::memcpy(copy, value, length + 1);
    return copy;
}

bool append_format(std::string &out, char error_message[128], const char *format, ...) noexcept
{
    va_list args;
    va_start(args, format);
    va_list args_copy;
    va_copy(args_copy, args);
    const int needed = std::vsnprintf(nullptr, 0, format, args);
    va_end(args);
    if (needed < 0) {
        std::snprintf(error_message, 128, "failed to format frequency response JSON");
        va_end(args_copy);
        return false;
    }
    std::vector<char> buffer(static_cast<std::size_t>(needed) + 1);
    const int written = std::vsnprintf(buffer.data(), buffer.size(), format, args_copy);
    va_end(args_copy);
    if (written < 0 || written != needed) {
        std::snprintf(error_message, 128, "failed to write formatted frequency response JSON");
        return false;
    }
    out.append(buffer.data(), static_cast<std::size_t>(needed));
    return true;
}

std::string escape_json_string(const char *value)
{
    std::string escaped;
    if (value == nullptr) {
        return escaped;
    }
    for (const char *cursor = value; *cursor != '\0'; ++cursor) {
        switch (*cursor) {
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
            escaped += *cursor;
            break;
        }
    }
    return escaped;
}

bool append_sweep_progress_artifact_json(
    std::string &out,
    char error_message[128],
    const char *status,
    bool complete,
    const char *state,
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    const char *current_frequency_hz_json,
    bool partial_artifacts_available,
    const char *latest_artifact_manifest_path) noexcept
{
    std::string checkpoint_json;
    const char *current_frequency =
        current_frequency_hz_json != nullptr ? current_frequency_hz_json : "null";
    const char *manifest_path =
        latest_artifact_manifest_path != nullptr ? latest_artifact_manifest_path : "";
    if (!append_format(
            checkpoint_json,
            error_message,
            "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
            "\"status\":\"%s\","
            "\"complete\":%s,"
            "\"state\":\"%s\","
            "\"total_frequency_points\":%llu,"
            "\"completed_frequency_points\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"current_frequency_hz\":%s,"
            "\"partial_artifacts_available\":%s,"
            "\"latest_artifact_manifest_path\":\"%s\"}",
            status,
            complete ? "true" : "false",
            state,
            static_cast<unsigned long long>(total_frequency_points),
            static_cast<unsigned long long>(completed_frequency_points),
            static_cast<unsigned long long>(written_frequency_point_artifacts),
            current_frequency,
            partial_artifacts_available ? "true" : "false",
            escape_json_string(manifest_path).c_str())) {
        return false;
    }
    return append_format(
        out,
        error_message,
        "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"state\":\"%s\","
        "\"total_frequency_points\":%llu,"
        "\"completed_frequency_points\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"current_frequency_hz\":%s,"
        "\"partial_artifacts_available\":%s,"
        "\"latest_artifact_manifest_path\":\"%s\","
        "\"missing_reason\":null,"
        "\"progress_json\":\"%s\"}",
        status,
        complete ? "true" : "false",
        state,
        static_cast<unsigned long long>(total_frequency_points),
        static_cast<unsigned long long>(completed_frequency_points),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        current_frequency,
        partial_artifacts_available ? "true" : "false",
        escape_json_string(manifest_path).c_str(),
        escape_json_string(checkpoint_json.c_str()).c_str());
}

std::string extract_json_string_field(const char *json, const char *field_name) noexcept
{
    if (json == nullptr || field_name == nullptr) {
        return "";
    }
    std::string needle = "\"";
    needle += field_name;
    needle += "\"";
    const char *cursor = std::strstr(json, needle.c_str());
    if (cursor == nullptr) {
        return "";
    }
    cursor += needle.size();
    while (*cursor == ' ' || *cursor == '\n' || *cursor == '\r' || *cursor == '\t') {
        ++cursor;
    }
    if (*cursor != ':') {
        return "";
    }
    ++cursor;
    while (*cursor == ' ' || *cursor == '\n' || *cursor == '\r' || *cursor == '\t') {
        ++cursor;
    }
    if (*cursor != '"') {
        return "";
    }
    ++cursor;
    std::string value;
    while (*cursor != '\0' && *cursor != '"') {
        if (*cursor == '\\' && cursor[1] != '\0') {
            ++cursor;
        }
        value += *cursor;
        ++cursor;
    }
    return value;
}

std::string domain_mesh_mode_json_field(
    const DrivenFrequencyResponseSolveRequest &request)
{
    const std::string mode = extract_json_string_field(
        request.operator_diagnostics_json,
        "domain_mesh_mode");
    if (mode.empty()) {
        return "";
    }
    return ",\"domain_mesh_mode\":\"" + escape_json_string(mode.c_str()) + "\"";
}

bool can_solve_floquet_projected_no_demag_response(
    const DrivenFrequencyResponseSolveRequest &request) noexcept;

std::string included_operator_terms_json(
    const DrivenFrequencyResponseMfemValidationProblem &problem);

void assign_result_strings(
    DrivenFrequencyResponseSolveResult &result,
    const char *error_message,
    const char *diagnostics_json,
    const char *result_json,
    const char *artifact_manifest_path) noexcept
{
    result.error_message = duplicate_string(error_message);
    result.diagnostics_json = duplicate_string(diagnostics_json);
    result.result_json = duplicate_string(result_json);
    result.artifact_manifest_path = duplicate_string(artifact_manifest_path);
    if (result.error_message == nullptr ||
        result.diagnostics_json == nullptr ||
        result.result_json == nullptr ||
        result.artifact_manifest_path == nullptr) {
        result.status = FrequencyDomainStatus::artifact_error;
    }
}

const char *status_result_json(FrequencyDomainStatus status) noexcept
{
    switch (status) {
    case FrequencyDomainStatus::validation_error:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"validation_error\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    case FrequencyDomainStatus::unavailable:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"unavailable\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    case FrequencyDomainStatus::interrupted:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"interrupted\","
               "\"completed_frequency_count\":0,"
               "\"written_frequency_point_artifacts\":0,"
               "\"partial_artifacts_available\":false,"
               "\"artifact_manifest_path\":\"\"}";
    case FrequencyDomainStatus::operator_error:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"operator_error\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    case FrequencyDomainStatus::solve_error:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"solve_error\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    case FrequencyDomainStatus::artifact_error:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"artifact_error\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    case FrequencyDomainStatus::ok:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"ok\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    default:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"status\":\"artifact_error\","
               "\"completed_frequency_count\":0,"
               "\"artifact_manifest_path\":\"\"}";
    }
}

const char *status_diagnostics_json(FrequencyDomainStatus status) noexcept
{
    switch (status) {
    case FrequencyDomainStatus::validation_error:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"validation_error\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::unavailable:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"unavailable\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::interrupted:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"interrupted\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"partial_artifacts_available\":false,"
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::operator_error:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"operator_error\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::solve_error:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"solve_error\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::artifact_error:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"artifact_error\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::ok:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"ok\","
               "\"complete\":true,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    default:
        return "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"artifact_error\","
               "\"complete\":false,"
               "\"completed_frequency_point_count\":0,"
               "\"production_solver_available\":false}";
    }
}

const char *phase_convention_to_string(FrequencyDomainPhaseConvention phase_convention) noexcept
{
    switch (phase_convention) {
    case FrequencyDomainPhaseConvention::exp_i_omega_t:
        return "exp_i_omega_t";
    case FrequencyDomainPhaseConvention::exp_minus_i_omega_t:
        return "exp_minus_i_omega_t";
    }
    return "unknown";
}

double angular_frequency_sign(FrequencyDomainPhaseConvention phase_convention) noexcept
{
    switch (phase_convention) {
    case FrequencyDomainPhaseConvention::exp_i_omega_t:
        return 1.0;
    case FrequencyDomainPhaseConvention::exp_minus_i_omega_t:
        return -1.0;
    }
    return 1.0;
}

const char *execution_lane_to_string(DrivenFrequencyResponseExecutionLane execution_lane) noexcept
{
    switch (execution_lane) {
    case DrivenFrequencyResponseExecutionLane::validation:
        return "validation";
    case DrivenFrequencyResponseExecutionLane::production_cpu:
        return "production_cpu";
    case DrivenFrequencyResponseExecutionLane::production_gpu:
        return "production_gpu";
    }
    return "validation";
}

bool has_output_directory(const char *output_directory) noexcept
{
    return output_directory != nullptr && output_directory[0] != '\0';
}

double env_positive_double(const char *name, double fallback) noexcept
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return fallback;
    }
    char *end = nullptr;
    errno = 0;
    const double value = std::strtod(raw, &end);
    if (errno != 0 || end == raw || !std::isfinite(value) || !(value > 0.0)) {
        return fallback;
    }
    return value;
}

double env_positive_double_alias(
    const char *primary_name,
    const char *alias_name,
    double fallback) noexcept
{
    const double primary = env_positive_double(primary_name, -1.0);
    if (primary > 0.0) {
        return primary;
    }
    return env_positive_double(alias_name, fallback);
}

std::uint64_t env_positive_u64(const char *name, std::uint64_t fallback) noexcept
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return fallback;
    }
    char *end = nullptr;
    errno = 0;
    const unsigned long long value = std::strtoull(raw, &end, 10);
    if (errno != 0 || end == raw || value == 0) {
        return fallback;
    }
    return static_cast<std::uint64_t>(value);
}

std::uint64_t env_positive_u64_alias(
    const char *primary_name,
    const char *alias_name,
    std::uint64_t fallback) noexcept
{
    const std::uint64_t primary = env_positive_u64(primary_name, 0);
    if (primary > 0) {
        return primary;
    }
    return env_positive_u64(alias_name, fallback);
}

double production_frequency_response_relative_tolerance() noexcept
{
    return env_positive_double_alias(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL",
        "FULLMAG_FMR_RESPONSE_RTOL",
        1.0e-3);
}

std::uint64_t production_frequency_response_max_iterations() noexcept
{
    return env_positive_u64_alias(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS",
        "FULLMAG_FMR_RESPONSE_MAX_ITERATIONS",
        8192);
}

std::uint64_t production_frequency_response_restart_iterations(
    std::uint64_t max_iterations) noexcept
{
    const std::uint64_t restart =
        env_positive_u64_alias(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS",
            "FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS",
            max_iterations);
    return std::max<std::uint64_t>(1, std::min(restart, max_iterations));
}

std::uint64_t production_frequency_response_progress_interval() noexcept
{
    return env_positive_u64_alias(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_PROGRESS_INTERVAL",
        "FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL",
        1);
}

struct MfemProductionCpuOperatorAdapter {
    const DrivenFrequencyResponseSolveRequest *request = nullptr;
    std::vector<TangentOperatorLocalBlock> zeeman_blocks;
    std::vector<TangentOperatorLocalBlock> uniaxial_anisotropy_blocks;
    std::vector<double> exchange_tangent;
    std::vector<double> zeeman_tangent;
    std::vector<double> uniaxial_anisotropy_tangent;
    std::vector<double> dmi_tangent;
    std::vector<double> dmi_delta_xyz;
    std::vector<double> dmi_residual_xyz;
    std::vector<double> dmi_field_xyz;
    std::vector<double> demag_tangent;
    std::vector<double> effective_field_tangent;
    std::vector<double> stiffness_tangent;
    std::vector<double> mass_tangent;
    std::vector<double> projected_tangent;
    std::vector<std::uint64_t> static_periodic_representative_node;
    std::vector<std::uint64_t> static_periodic_representative_count;
    std::vector<double> static_periodic_projection_workspace;
    std::vector<double> block_jacobi_effective_field_blocks;
    std::vector<double> block_jacobi_projected_input;
    std::vector<double> block_jacobi_projection_workspace;
    std::vector<double> demag_coarse_basis;
    std::vector<double> demag_coarse_image;
    std::vector<double> graph_preconditioner_first_pass;
    std::vector<double> graph_preconditioner_edge_tangent;
    std::vector<double> graph_preconditioner_corrected_rhs;
    bool block_jacobi_preconditioner_enabled = false;
    bool demag_coarse_preconditioner_enabled = false;
    bool graph_preconditioner_enabled = false;
};

struct MfemProductionGpuOperatorAdapter {
    const DrivenFrequencyResponseSolveRequest *request = nullptr;
    std::vector<double> stiffness_tangent;
    std::vector<double> mass_tangent;
    std::vector<double> demag_tangent;
    std::vector<double> projected_tangent;
    std::vector<std::uint64_t> static_periodic_representative_node;
    std::vector<std::uint64_t> static_periodic_representative_count;
    std::vector<double> static_periodic_projection_workspace;
};

struct MfemPhiConsistencySchurProviderContext {
    MfemProductionCpuOperatorAdapter adapter;
    std::uint64_t delta_m_tangent_dof_count = 0;
    std::uint64_t delta_phi_dof_count = 0;
    std::vector<double> demag_tangent_workspace;
    std::vector<double> delta_phi_workspace;
    std::vector<double> preconditioner_magnetic_input;
    std::vector<double> preconditioner_magnetic_output;
    std::vector<double> preconditioner_phi_real;
    std::vector<double> preconditioner_phi_imag;
};

FrequencyDomainStatus project_floquet_phase_block(
    void *user_data,
    const double *input,
    double *output,
    std::uint64_t tangent_dof_count,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionGpuOperatorAdapter *>(user_data);
    if (adapter == nullptr ||
        adapter->request == nullptr ||
        input == nullptr ||
        output == nullptr ||
        tangent_dof_count == 0 ||
        tangent_dof_count % 2 != 0) {
        std::snprintf(error_message, 128, "Floquet phase projection requires node-aligned complex tangent buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseSolveRequest &request = *adapter->request;
    const std::uint64_t node_count = tangent_dof_count / 2;
    std::memcpy(
        output,
        input,
        static_cast<std::size_t>(tangent_dof_count * 2 * sizeof(double)));
    if (request.floquet_periodic_pair_count == 0) {
        return FrequencyDomainStatus::ok;
    }
    if (request.floquet_periodic_pairs == nullptr) {
        std::snprintf(error_message, 128, "Floquet phase projection requires periodic pair metadata");
        return FrequencyDomainStatus::validation_error;
    }
    for (std::uint64_t pair_index = 0;
         pair_index < request.floquet_periodic_pair_count;
         ++pair_index) {
        const FrequencyDomainFloquetPeriodicPair &pair =
            request.floquet_periodic_pairs[pair_index];
        if (!pair.has_phase ||
            pair.node_a >= node_count ||
            pair.node_b >= node_count ||
            pair.node_a == pair.node_b) {
            std::snprintf(error_message, 128, "Floquet phase projection has invalid periodic pair metadata");
            return FrequencyDomainStatus::validation_error;
        }
        const double c = std::cos(pair.phase_rad);
        const double s = std::sin(pair.phase_rad);
        if (!std::isfinite(c) || !std::isfinite(s)) {
            std::snprintf(error_message, 128, "Floquet phase projection requires finite phase");
            return FrequencyDomainStatus::validation_error;
        }
        for (std::uint64_t component = 0; component < 2; ++component) {
            const std::uint64_t source_dof = pair.node_a * 2 + component;
            const std::uint64_t destination_dof = pair.node_b * 2 + component;
            const double source_real = output[source_dof];
            const double source_imag = output[source_dof + tangent_dof_count];
            const double destination_real = output[destination_dof];
            const double destination_imag = output[destination_dof + tangent_dof_count];
            const double projected_source_real =
                0.5 * (source_real + c * destination_real + s * destination_imag);
            const double projected_source_imag =
                0.5 * (source_imag + c * destination_imag - s * destination_real);
            const double projected_destination_real =
                c * projected_source_real - s * projected_source_imag;
            const double projected_destination_imag =
                s * projected_source_real + c * projected_source_imag;
            output[source_dof] = projected_source_real;
            output[source_dof + tangent_dof_count] = projected_source_imag;
            output[destination_dof] = projected_destination_real;
            output[destination_dof + tangent_dof_count] = projected_destination_imag;
        }
    }
    return FrequencyDomainStatus::ok;
}

struct PeriodicAirboxPhiGaugeDiagnostics {
    bool phi_nullspace_detected = false;
    bool phi_gauge_constraint_applied = false;
    const char *phi_gauge_policy = "not_required";
    const char *delta_phi_phase_validation_status = "not_applicable";
    double delta_phi_phase_max_residual = 0.0;
    const char *delta_phi_flux_validation_status = "not_applicable";
    const char *delta_phi_flux_validation_reason = "no_floquet_airbox_delta_phi_constraint";
};

const FrequencyDomainFloquetPeriodicPair *find_oriented_floquet_pair(
    const DrivenFrequencyResponseSolveRequest &request,
    std::uint64_t node_a,
    std::uint64_t node_b) noexcept
{
    if (request.floquet_periodic_pairs == nullptr) {
        return nullptr;
    }
    for (std::uint64_t pair_index = 0;
         pair_index < request.floquet_periodic_pair_count;
         ++pair_index) {
        const FrequencyDomainFloquetPeriodicPair &pair =
            request.floquet_periodic_pairs[pair_index];
        if (pair.node_a == node_a &&
            pair.node_b == node_b &&
            pair.has_phase &&
            pair.has_translation) {
            return &pair;
        }
    }
    return nullptr;
}

bool validate_floquet_airbox_delta_phi_phase_response(
    const DrivenFrequencyResponseSolveRequest &request,
    const double *response_real,
    const double *response_imag,
    std::uint64_t completed_frequency_count,
    std::uint64_t coupled_complex_dof_count,
    std::uint64_t delta_m_tangent_dof_count,
    std::uint64_t delta_phi_dof_count,
    double &max_residual,
    char error_message[128]) noexcept
{
    max_residual = 0.0;
    if (!request.requires_floquet_airbox_dynamic_demag) {
        return true;
    }
    if (response_real == nullptr ||
        response_imag == nullptr ||
        request.periodic_airbox_magnetostatic_periodic_node_pairs == nullptr ||
        delta_phi_dof_count == 0) {
        std::snprintf(
            error_message,
            128,
            "Floquet-airbox delta_phi phase validation requires solved delta_phi response and periodic pairs");
        return false;
    }
    constexpr double tolerance = 1.0e-7;
    for (std::uint64_t frequency_index = 0;
         frequency_index < completed_frequency_count;
         ++frequency_index) {
        const std::uint64_t response_offset =
            frequency_index * coupled_complex_dof_count + delta_m_tangent_dof_count;
        for (std::uint64_t pair_index = 0;
             pair_index < request.periodic_airbox_magnetostatic_periodic_node_pair_count;
             ++pair_index) {
            const std::uint64_t node_a =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2];
            const std::uint64_t node_b =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2 + 1];
            if (node_a >= delta_phi_dof_count || node_b >= delta_phi_dof_count) {
                std::snprintf(
                    error_message,
                    128,
                    "Floquet-airbox delta_phi phase validation pair is outside delta_phi DOFs");
                return false;
            }
            const FrequencyDomainFloquetPeriodicPair *phase_metadata =
                find_oriented_floquet_pair(request, node_a, node_b);
            if (phase_metadata == nullptr) {
                std::snprintf(
                    error_message,
                    128,
                    "Floquet-airbox delta_phi phase validation requires matching Floquet phase metadata");
                return false;
            }
            const double c = std::cos(phase_metadata->phase_rad);
            const double s = std::sin(phase_metadata->phase_rad);
            const std::uint64_t source_index = response_offset + node_a;
            const std::uint64_t destination_index = response_offset + node_b;
            const double source_real = response_real[source_index];
            const double source_imag = response_imag[source_index];
            const double expected_destination_real = c * source_real - s * source_imag;
            const double expected_destination_imag = s * source_real + c * source_imag;
            const double residual_real =
                response_real[destination_index] - expected_destination_real;
            const double residual_imag =
                response_imag[destination_index] - expected_destination_imag;
            const double residual =
                std::sqrt(residual_real * residual_real + residual_imag * residual_imag);
            if (!std::isfinite(residual)) {
                std::snprintf(
                    error_message,
                    128,
                    "Floquet-airbox delta_phi phase validation produced nonfinite residual");
                return false;
            }
            max_residual = std::max(max_residual, residual);
        }
    }
    if (max_residual > tolerance) {
        std::snprintf(
            error_message,
            128,
            "Floquet-airbox solved delta_phi response violates Bloch phase constraints");
        return false;
    }
    return true;
}

bool build_static_periodic_representatives(
    const DrivenFrequencyResponseMfemValidationProblem &problem,
    std::vector<std::uint64_t> &representative_node,
    std::vector<std::uint64_t> &representative_count,
    char error_message[128]) noexcept
{
    representative_node.clear();
    representative_count.clear();
    if (problem.static_periodic_node_pair_count == 0) {
        return true;
    }
    if (problem.static_periodic_node_pairs == nullptr) {
        std::snprintf(error_message, 128, "static periodic projection requires node pair buffer");
        return false;
    }
    const std::uint64_t node_count = problem.descriptor.node_count;
    representative_node.resize(static_cast<std::size_t>(node_count));
    for (std::uint64_t node = 0; node < node_count; ++node) {
        representative_node[static_cast<std::size_t>(node)] = node;
    }

    auto find_root = [&representative_node](std::uint64_t node) {
        std::uint64_t root = node;
        while (representative_node[static_cast<std::size_t>(root)] != root) {
            root = representative_node[static_cast<std::size_t>(root)];
        }
        while (representative_node[static_cast<std::size_t>(node)] != node) {
            const std::uint64_t next = representative_node[static_cast<std::size_t>(node)];
            representative_node[static_cast<std::size_t>(node)] = root;
            node = next;
        }
        return root;
    };

    for (std::uint64_t pair_index = 0;
         pair_index < problem.static_periodic_node_pair_count;
         ++pair_index) {
        const std::uint64_t node_a =
            problem.static_periodic_node_pairs[pair_index * 2];
        const std::uint64_t node_b =
            problem.static_periodic_node_pairs[pair_index * 2 + 1];
        if (node_a >= node_count || node_b >= node_count || node_a == node_b) {
            std::snprintf(error_message, 128, "static periodic projection has invalid node pair");
            return false;
        }
        const std::uint64_t root_a = find_root(node_a);
        const std::uint64_t root_b = find_root(node_b);
        if (root_a == root_b) {
            continue;
        }
        const std::uint64_t representative = std::min(root_a, root_b);
        const std::uint64_t dependent = std::max(root_a, root_b);
        representative_node[static_cast<std::size_t>(dependent)] = representative;
    }

    for (std::uint64_t node = 0; node < node_count; ++node) {
        representative_node[static_cast<std::size_t>(node)] = find_root(node);
    }
    representative_count.assign(static_cast<std::size_t>(node_count), 0);
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const std::uint64_t representative =
            representative_node[static_cast<std::size_t>(node)];
        ++representative_count[static_cast<std::size_t>(representative)];
    }
    return true;
}

double max_static_periodic_frame_mismatch(
    const std::vector<std::uint64_t> &representative_node,
    const DrivenFrequencyResponseMfemValidationProblem &problem) noexcept
{
    if (representative_node.empty() || problem.nodes == nullptr) {
        return 0.0;
    }
    double max_mismatch = 0.0;
    for (std::uint64_t node = 0;
         node < static_cast<std::uint64_t>(representative_node.size());
         ++node) {
        const std::uint64_t representative =
            representative_node[static_cast<std::size_t>(node)];
        const TangentFrameNode &node_frame =
            problem.nodes[static_cast<std::size_t>(node)];
        const TangentFrameNode &representative_frame =
            problem.nodes[static_cast<std::size_t>(representative)];
        for (int axis = 0; axis < 3; ++axis) {
            max_mismatch = std::max(
                max_mismatch,
                std::abs(node_frame.m[axis] - representative_frame.m[axis]));
            max_mismatch = std::max(
                max_mismatch,
                std::abs(node_frame.e1[axis] - representative_frame.e1[axis]));
            max_mismatch = std::max(
                max_mismatch,
                std::abs(node_frame.e2[axis] - representative_frame.e2[axis]));
        }
    }
    return max_mismatch;
}

double floquet_pair_frame_mismatch(
    const TangentFrameNode &source,
    const TangentFrameNode &destination) noexcept
{
    double mismatch = 0.0;
    for (int axis = 0; axis < 3; ++axis) {
        mismatch = std::max(mismatch, std::abs(destination.m[axis] - source.m[axis]));
        mismatch = std::max(mismatch, std::abs(destination.e1[axis] - source.e1[axis]));
        mismatch = std::max(mismatch, std::abs(destination.e2[axis] - source.e2[axis]));
    }
    return mismatch;
}

double max_floquet_tangent_frame_mismatch(
    const DrivenFrequencyResponseSolveRequest &request) noexcept
{
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    if (problem.nodes == nullptr ||
        request.floquet_periodic_pairs == nullptr ||
        request.floquet_periodic_pair_count == 0) {
        return 0.0;
    }
    const std::uint64_t node_count = problem.descriptor.node_count;
    double max_mismatch = 0.0;
    for (std::uint64_t pair_index = 0;
         pair_index < request.floquet_periodic_pair_count;
         ++pair_index) {
        const FrequencyDomainFloquetPeriodicPair &pair =
            request.floquet_periodic_pairs[pair_index];
        if (pair.node_a >= node_count || pair.node_b >= node_count) {
            continue;
        }
        max_mismatch = std::max(
            max_mismatch,
            floquet_pair_frame_mismatch(
                problem.nodes[static_cast<std::size_t>(pair.node_a)],
                problem.nodes[static_cast<std::size_t>(pair.node_b)]));
    }
    return max_mismatch;
}

double max_static_periodic_tangent_mismatch(
    const std::vector<std::uint64_t> &representative_node,
    const double *values) noexcept
{
    if (representative_node.empty() || values == nullptr) {
        return 0.0;
    }
    double max_mismatch = 0.0;
    for (std::uint64_t node = 0;
         node < static_cast<std::uint64_t>(representative_node.size());
         ++node) {
        const std::uint64_t representative =
            representative_node[static_cast<std::size_t>(node)];
        max_mismatch = std::max(
            max_mismatch,
            std::abs(values[node * 2] - values[representative * 2]));
        max_mismatch = std::max(
            max_mismatch,
            std::abs(values[node * 2 + 1] - values[representative * 2 + 1]));
    }
    return max_mismatch;
}


void project_static_periodic_tangent(
    const std::vector<std::uint64_t> &representative_node,
    const std::vector<std::uint64_t> &representative_count,
    const double *input,
    double *output) noexcept
{
    if (representative_node.empty()) {
        return;
    }
    const std::size_t dof_count = representative_node.size() * 2;
    for (std::size_t index = 0; index < dof_count; ++index) {
        output[index] = 0.0;
    }
    for (std::uint64_t node = 0;
         node < static_cast<std::uint64_t>(representative_node.size());
         ++node) {
        const std::uint64_t representative =
            representative_node[static_cast<std::size_t>(node)];
        output[representative * 2] += input[node * 2];
        output[representative * 2 + 1] += input[node * 2 + 1];
    }
    for (std::uint64_t node = 0;
         node < static_cast<std::uint64_t>(representative_node.size());
         ++node) {
        if (representative_node[static_cast<std::size_t>(node)] == node) {
            const double count = static_cast<double>(
                representative_count[static_cast<std::size_t>(node)]);
            if (count > 0.0) {
                output[node * 2] /= count;
                output[node * 2 + 1] /= count;
            }
        }
    }
    for (std::uint64_t node = 0;
         node < static_cast<std::uint64_t>(representative_node.size());
         ++node) {
        const std::uint64_t representative =
            representative_node[static_cast<std::size_t>(node)];
        if (representative != node) {
            output[node * 2] = output[representative * 2];
            output[node * 2 + 1] = output[representative * 2 + 1];
        }
    }
}

void project_static_periodic_tangent_in_place(
    const std::vector<std::uint64_t> &representative_node,
    const std::vector<std::uint64_t> &representative_count,
    std::vector<double> &workspace,
    double *values) noexcept
{
    if (representative_node.empty()) {
        return;
    }
    const std::size_t dof_count = representative_node.size() * 2;
    workspace.resize(dof_count);
    project_static_periodic_tangent(
        representative_node,
        representative_count,
        values,
        workspace.data());
    for (std::size_t index = 0; index < dof_count; ++index) {
        values[index] = workspace[index];
    }
}

void project_static_periodic_block_in_place(
    const std::vector<std::uint64_t> &representative_node,
    const std::vector<std::uint64_t> &representative_count,
    std::vector<double> &workspace,
    std::uint64_t tangent_dof_count,
    double *values) noexcept
{
    if (representative_node.empty()) {
        return;
    }
    project_static_periodic_tangent_in_place(
        representative_node,
        representative_count,
        workspace,
        values);
    project_static_periodic_tangent_in_place(
        representative_node,
        representative_count,
        workspace,
        values + tangent_dof_count);
}

FrequencyDomainStatus apply_dense_tangent_matrix(
    const double *matrix_row_major,
    std::uint64_t dof_count,
    const double *in,
    double *out,
    const char *operator_name,
    char error_message[128]) noexcept
{
    if (matrix_row_major == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing %s operator buffers", operator_name);
        return FrequencyDomainStatus::validation_error;
    }
    for (std::uint64_t row = 0; row < dof_count; ++row) {
        double value = 0.0;
        for (std::uint64_t column = 0; column < dof_count; ++column) {
            const double coefficient = matrix_row_major[row * dof_count + column];
            if (!std::isfinite(coefficient)) {
                std::snprintf(error_message, 128, "%s operator contains non-finite values", operator_name);
                return FrequencyDomainStatus::operator_error;
            }
            value += coefficient * in[column];
        }
        if (!std::isfinite(value)) {
            std::snprintf(error_message, 128, "%s operator produced non-finite values", operator_name);
            return FrequencyDomainStatus::operator_error;
        }
        out[row] = value;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_demag_tangent(
    const DrivenFrequencyResponseMfemValidationProblem &problem,
    std::uint64_t dof_count,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    if (problem.apply_demag_tangent != nullptr) {
        return problem.apply_demag_tangent(
            problem.demag_tangent_user_data,
            in,
            out,
            error_message);
    }
    if (problem.apply_demag_tangent_with_potential != nullptr) {
        std::vector<double> unused_phi(
            static_cast<std::size_t>(problem.descriptor.node_count),
            0.0);
        return problem.apply_demag_tangent_with_potential(
            problem.demag_tangent_user_data,
            in,
            out,
            unused_phi.data(),
            static_cast<std::uint64_t>(unused_phi.size()),
            error_message);
    }
    if (problem.demag_tangent_matrix_row_major != nullptr) {
        return apply_dense_tangent_matrix(
            problem.demag_tangent_matrix_row_major,
            dof_count,
            in,
            out,
            "MFEM explicit demag tangent",
            error_message);
    }
    std::snprintf(error_message, 128, "missing MFEM demag tangent operator");
    return FrequencyDomainStatus::validation_error;
}

bool has_mfem_demag_tangent_operator(
    const DrivenFrequencyResponseMfemValidationProblem &problem) noexcept;

bool solve_4x4_linear_system(
    const double matrix[16],
    const double rhs[4],
    double out[4]) noexcept
{
    double augmented[4][5]{};
    for (int row = 0; row < 4; ++row) {
        for (int column = 0; column < 4; ++column) {
            augmented[row][column] = matrix[row * 4 + column];
        }
        augmented[row][4] = rhs[row];
    }

    for (int column = 0; column < 4; ++column) {
        int pivot_row = column;
        double pivot_abs = std::fabs(augmented[column][column]);
        for (int candidate = column + 1; candidate < 4; ++candidate) {
            const double candidate_abs = std::fabs(augmented[candidate][column]);
            if (candidate_abs > pivot_abs) {
                pivot_abs = candidate_abs;
                pivot_row = candidate;
            }
        }
        if (!(pivot_abs > 1.0e-30) || !std::isfinite(pivot_abs)) {
            return false;
        }
        if (pivot_row != column) {
            for (int entry = 0; entry < 5; ++entry) {
                std::swap(augmented[column][entry], augmented[pivot_row][entry]);
            }
        }
        const double inv_pivot = 1.0 / augmented[column][column];
        for (int entry = column; entry < 5; ++entry) {
            augmented[column][entry] *= inv_pivot;
        }
        for (int row = 0; row < 4; ++row) {
            if (row == column) {
                continue;
            }
            const double factor = augmented[row][column];
            if (factor == 0.0) {
                continue;
            }
            for (int entry = column; entry < 5; ++entry) {
                augmented[row][entry] -= factor * augmented[column][entry];
            }
        }
    }

    for (int row = 0; row < 4; ++row) {
        out[row] = augmented[row][4];
        if (!std::isfinite(out[row])) {
            return false;
        }
    }
    return true;
}

void add_local_effective_field_blocks(
    const std::vector<TangentOperatorLocalBlock> &blocks,
    std::vector<double> &effective_field_blocks) noexcept
{
    const std::uint64_t node_count =
        static_cast<std::uint64_t>(blocks.size());
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const TangentOperatorLocalBlock &block = blocks[static_cast<std::size_t>(node)];
        double *target = effective_field_blocks.data() + node * 4;
        target[0] += block.a00;
        target[1] += block.a01;
        target[2] += block.a10;
        target[3] += block.a11;
    }
}

FrequencyDomainStatus setup_mfem_tangent_block_jacobi_preconditioner(
    MfemProductionCpuOperatorAdapter &adapter,
    char error_message[128]) noexcept
{
    adapter.block_jacobi_preconditioner_enabled = false;
    adapter.demag_coarse_preconditioner_enabled = false;
    adapter.graph_preconditioner_enabled = false;
    adapter.block_jacobi_effective_field_blocks.clear();
    if (adapter.request == nullptr) {
        std::snprintf(error_message, 128, "MFEM block-Jacobi preconditioner requires request context");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseSolveRequest &request = *adapter.request;
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    if (!request.requires_periodic_airbox_dynamic_demag) {
        return FrequencyDomainStatus::ok;
    }
    const std::uint64_t node_count = problem.descriptor.node_count;
    const std::uint64_t tangent_dof_count = problem.descriptor.tangent_dof_count;
    if (node_count == 0 || tangent_dof_count != node_count * 2) {
        std::snprintf(error_message, 128, "MFEM block-Jacobi preconditioner requires node-aligned tangent DOFs");
        return FrequencyDomainStatus::validation_error;
    }
    adapter.block_jacobi_effective_field_blocks.assign(
        static_cast<std::size_t>(node_count * 4),
        0.0);

    if (problem.descriptor.zeeman_enabled) {
        ZeemanTangentOperatorDiagnostics diagnostics{};
        const FrequencyDomainStatus status = build_zeeman_tangent_blocks(
            problem.nodes,
            problem.h_ext_a_per_m,
            node_count,
            adapter.zeeman_blocks.data(),
            &diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            std::snprintf(error_message, 128, "%s", diagnostics.error_message);
            return status;
        }
        add_local_effective_field_blocks(
            adapter.zeeman_blocks,
            adapter.block_jacobi_effective_field_blocks);
    }

    if (problem.descriptor.uniaxial_anisotropy_enabled) {
        UniaxialAnisotropyTangentOperatorDiagnostics diagnostics{};
        const FrequencyDomainStatus status = build_uniaxial_anisotropy_tangent_blocks(
            problem.nodes,
            problem.uniaxial_anisotropy_axis,
            problem.uniaxial_anisotropy_field_a_per_m,
            node_count,
            adapter.uniaxial_anisotropy_blocks.data(),
            &diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            std::snprintf(error_message, 128, "%s", diagnostics.error_message);
            return status;
        }
        add_local_effective_field_blocks(
            adapter.uniaxial_anisotropy_blocks,
            adapter.block_jacobi_effective_field_blocks);
    }

    if (problem.descriptor.exchange_enabled) {
        if (problem.exchange_edges == nullptr || problem.exchange_edge_count == 0) {
            std::snprintf(error_message, 128, "MFEM block-Jacobi preconditioner requires exchange edges");
            return FrequencyDomainStatus::validation_error;
        }
        for (std::uint64_t edge_index = 0;
             edge_index < problem.exchange_edge_count;
             ++edge_index) {
            const TangentOperatorEdgeBlock &edge = problem.exchange_edges[edge_index];
            if (edge.kind != FrequencyDomainOperatorTermKind::exchange ||
                edge.node_i >= node_count ||
                edge.node_j >= node_count ||
                edge.node_i == edge.node_j ||
                !std::isfinite(edge.stiffness)) {
                std::snprintf(error_message, 128, "MFEM block-Jacobi preconditioner has invalid exchange edge");
                return FrequencyDomainStatus::validation_error;
            }
            double *block_i =
                adapter.block_jacobi_effective_field_blocks.data() + edge.node_i * 4;
            double *block_j =
                adapter.block_jacobi_effective_field_blocks.data() + edge.node_j * 4;
            block_i[0] += edge.stiffness;
            block_i[3] += edge.stiffness;
            block_j[0] += edge.stiffness;
            block_j[3] += edge.stiffness;
        }
    }

    if (has_mfem_demag_tangent_operator(problem)) {
        adapter.demag_coarse_basis.assign(
            static_cast<std::size_t>(tangent_dof_count),
            0.0);
        adapter.demag_coarse_image.assign(
            static_cast<std::size_t>(tangent_dof_count),
            0.0);
        for (std::uint64_t component = 0; component < 2; ++component) {
            std::fill(
                adapter.demag_coarse_basis.begin(),
                adapter.demag_coarse_basis.end(),
                0.0);
            for (std::uint64_t node = 0; node < node_count; ++node) {
                adapter.demag_coarse_basis[static_cast<std::size_t>(node * 2 + component)] = 1.0;
            }
            project_static_periodic_tangent_in_place(
                adapter.static_periodic_representative_node,
                adapter.static_periodic_representative_count,
                adapter.static_periodic_projection_workspace,
                adapter.demag_coarse_basis.data());
            const FrequencyDomainStatus demag_status = apply_mfem_demag_tangent(
                problem,
                tangent_dof_count,
                adapter.demag_coarse_basis.data(),
                adapter.demag_coarse_image.data(),
                error_message);
            if (demag_status != FrequencyDomainStatus::ok) {
                return demag_status;
            }
            project_static_periodic_tangent_in_place(
                adapter.static_periodic_representative_node,
                adapter.static_periodic_representative_count,
                adapter.static_periodic_projection_workspace,
                adapter.demag_coarse_image.data());
            double average[2] = {0.0, 0.0};
            for (std::uint64_t node = 0; node < node_count; ++node) {
                average[0] += adapter.demag_coarse_image[static_cast<std::size_t>(node * 2)];
                average[1] += adapter.demag_coarse_image[static_cast<std::size_t>(node * 2 + 1)];
            }
            average[0] /= static_cast<double>(node_count);
            average[1] /= static_cast<double>(node_count);
            if (!std::isfinite(average[0]) || !std::isfinite(average[1])) {
                std::snprintf(error_message, 128, "MFEM demag-aware coarse preconditioner produced non-finite values");
                return FrequencyDomainStatus::operator_error;
            }
            for (std::uint64_t node = 0; node < node_count; ++node) {
                double *block =
                    adapter.block_jacobi_effective_field_blocks.data() + node * 4;
                block[component] += average[0];
                block[2 + component] += average[1];
            }
        }
        adapter.demag_coarse_preconditioner_enabled = true;
    }

    adapter.graph_preconditioner_enabled =
        problem.descriptor.exchange_enabled &&
        problem.exchange_edges != nullptr &&
        problem.exchange_edge_count > 0;
    if (adapter.graph_preconditioner_enabled) {
        adapter.graph_preconditioner_first_pass.assign(
            static_cast<std::size_t>(tangent_dof_count * 2),
            0.0);
        adapter.graph_preconditioner_edge_tangent.assign(
            static_cast<std::size_t>(tangent_dof_count),
            0.0);
        adapter.graph_preconditioner_corrected_rhs.assign(
            static_cast<std::size_t>(tangent_dof_count * 2),
            0.0);
    }

    adapter.block_jacobi_preconditioner_enabled = true;
    return FrequencyDomainStatus::ok;
}

const char *mfem_tangent_preconditioner_variant(
    const MfemProductionCpuOperatorAdapter &adapter) noexcept
{
    if (adapter.graph_preconditioner_enabled &&
        adapter.demag_coarse_preconditioner_enabled) {
        return "graph_demag_coarse";
    }
    if (adapter.demag_coarse_preconditioner_enabled) {
        return "demag_coarse";
    }
    if (adapter.block_jacobi_preconditioner_enabled) {
        return "block_jacobi";
    }
    return "none";
}

FrequencyDomainStatus apply_mfem_tangent_block_jacobi_right_preconditioner(
    void *user_data,
    double omega,
    const double *in,
    double *out,
    std::uint64_t tangent_dof_count,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionCpuOperatorAdapter *>(user_data);
    if (adapter == nullptr ||
        adapter->request == nullptr ||
        !adapter->block_jacobi_preconditioner_enabled ||
        in == nullptr ||
        out == nullptr ||
        tangent_dof_count == 0 ||
        tangent_dof_count % 2 != 0) {
        std::snprintf(error_message, 128, "MFEM block-Jacobi right preconditioner requires node-aligned buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        adapter->request->mfem_validation_problem;
    const std::uint64_t node_count = tangent_dof_count / 2;
    if (problem.descriptor.node_count != node_count ||
        adapter->block_jacobi_effective_field_blocks.size() <
            static_cast<std::size_t>(node_count * 4)) {
        std::snprintf(error_message, 128, "MFEM block-Jacobi right preconditioner has incomplete setup");
        return FrequencyDomainStatus::validation_error;
    }

    const double *input = in;
    const std::uint64_t block_count = tangent_dof_count * 2;
    if (!adapter->static_periodic_representative_node.empty()) {
        adapter->block_jacobi_projected_input.assign(
            in,
            in + static_cast<std::size_t>(block_count));
        project_static_periodic_block_in_place(
            adapter->static_periodic_representative_node,
            adapter->static_periodic_representative_count,
            adapter->block_jacobi_projection_workspace,
            tangent_dof_count,
            adapter->block_jacobi_projected_input.data());
        input = adapter->block_jacobi_projected_input.data();
    }

    for (std::uint64_t node = 0; node < node_count; ++node) {
        const double *field_block =
            adapter->block_jacobi_effective_field_blocks.data() + node * 4;
        const double gamma0 =
            adapter->request->solve_request.operator_request.gamma0;
        const double alpha =
            problem.alpha_per_node != nullptr ?
            problem.alpha_per_node[node] :
            adapter->request->solve_request.operator_request.alpha;
        const double k00 = gamma0 * field_block[2];
        const double k01 = gamma0 * field_block[3];
        const double k10 = -gamma0 * field_block[0];
        const double k11 = -gamma0 * field_block[1];
        const double m00 = 1.0;
        const double m01 = alpha;
        const double m10 = -alpha;
        const double m11 = 1.0;
        const double matrix[16] = {
            k00, k01, omega * m00, omega * m01,
            k10, k11, omega * m10, omega * m11,
            -omega * m00, -omega * m01, k00, k01,
            -omega * m10, -omega * m11, k10, k11,
        };
        const std::uint64_t dof0 = node * 2;
        const std::uint64_t dof1 = dof0 + 1;
        const double rhs[4] = {
            input[dof0],
            input[dof1],
            input[dof0 + tangent_dof_count],
            input[dof1 + tangent_dof_count],
        };
        double solution[4]{};
        if (!solve_4x4_linear_system(matrix, rhs, solution)) {
            std::snprintf(error_message, 128, "MFEM block-Jacobi right preconditioner encountered a singular block");
            return FrequencyDomainStatus::operator_error;
        }
        out[dof0] = solution[0];
        out[dof1] = solution[1];
        out[dof0 + tangent_dof_count] = solution[2];
        out[dof1 + tangent_dof_count] = solution[3];
    }

    project_static_periodic_block_in_place(
        adapter->static_periodic_representative_node,
        adapter->static_periodic_representative_count,
        adapter->block_jacobi_projection_workspace,
        tangent_dof_count,
        out);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_tangent_demag_coarse_right_preconditioner(
    void *user_data,
    double omega,
    const double *in,
    double *out,
    std::uint64_t tangent_dof_count,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionCpuOperatorAdapter *>(user_data);
    if (adapter == nullptr || !adapter->demag_coarse_preconditioner_enabled) {
        std::snprintf(error_message, 128, "MFEM demag-aware coarse right preconditioner requires setup");
        return FrequencyDomainStatus::validation_error;
    }
    return apply_mfem_tangent_block_jacobi_right_preconditioner(
        user_data,
        omega,
        in,
        out,
        tangent_dof_count,
        error_message);
}

FrequencyDomainStatus apply_mfem_tangent_graph_demag_coarse_right_preconditioner(
    void *user_data,
    double omega,
    const double *in,
    double *out,
    std::uint64_t tangent_dof_count,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionCpuOperatorAdapter *>(user_data);
    if (adapter == nullptr ||
        adapter->request == nullptr ||
        !adapter->demag_coarse_preconditioner_enabled ||
        !adapter->graph_preconditioner_enabled ||
        in == nullptr ||
        out == nullptr) {
        std::snprintf(error_message, 128, "MFEM graph-aware demag coarse right preconditioner requires setup");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        adapter->request->mfem_validation_problem;
    const std::uint64_t node_count = problem.descriptor.node_count;
    if (tangent_dof_count == 0 ||
        tangent_dof_count != node_count * 2 ||
        adapter->graph_preconditioner_first_pass.size() <
            static_cast<std::size_t>(tangent_dof_count * 2) ||
        adapter->graph_preconditioner_edge_tangent.size() <
            static_cast<std::size_t>(tangent_dof_count) ||
        adapter->graph_preconditioner_corrected_rhs.size() <
            static_cast<std::size_t>(tangent_dof_count * 2)) {
        std::snprintf(error_message, 128, "MFEM graph-aware demag coarse right preconditioner has incomplete setup");
        return FrequencyDomainStatus::validation_error;
    }

    FrequencyDomainStatus status = apply_mfem_tangent_block_jacobi_right_preconditioner(
        user_data,
        omega,
        in,
        adapter->graph_preconditioner_first_pass.data(),
        tangent_dof_count,
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }

    std::copy(
        in,
        in + static_cast<std::size_t>(tangent_dof_count * 2),
        adapter->graph_preconditioner_corrected_rhs.begin());
    const double gamma0 = adapter->request->solve_request.operator_request.gamma0;
    for (std::uint64_t phase_block = 0; phase_block < 2; ++phase_block) {
        const double *solution_phase =
            adapter->graph_preconditioner_first_pass.data() +
            static_cast<std::size_t>(phase_block * tangent_dof_count);
        std::fill(
            adapter->graph_preconditioner_edge_tangent.begin(),
            adapter->graph_preconditioner_edge_tangent.end(),
            0.0);
        for (std::uint64_t edge_index = 0;
             edge_index < problem.exchange_edge_count;
             ++edge_index) {
            const TangentOperatorEdgeBlock &edge = problem.exchange_edges[edge_index];
            if (edge.kind != FrequencyDomainOperatorTermKind::exchange ||
                edge.node_i >= node_count ||
                edge.node_j >= node_count ||
                edge.node_i == edge.node_j ||
                !std::isfinite(edge.stiffness)) {
                std::snprintf(error_message, 128, "MFEM graph-aware preconditioner has invalid exchange edge");
                return FrequencyDomainStatus::validation_error;
            }
            for (std::uint64_t component = 0; component < 2; ++component) {
                const std::uint64_t dof_i = edge.node_i * 2 + component;
                const std::uint64_t dof_j = edge.node_j * 2 + component;
                adapter->graph_preconditioner_edge_tangent[static_cast<std::size_t>(dof_i)] +=
                    -edge.stiffness * solution_phase[dof_j];
                adapter->graph_preconditioner_edge_tangent[static_cast<std::size_t>(dof_j)] +=
                    -edge.stiffness * solution_phase[dof_i];
            }
        }
        project_static_periodic_tangent_in_place(
            adapter->static_periodic_representative_node,
            adapter->static_periodic_representative_count,
            adapter->static_periodic_projection_workspace,
            adapter->graph_preconditioner_edge_tangent.data());
        double *corrected_phase =
            adapter->graph_preconditioner_corrected_rhs.data() +
            static_cast<std::size_t>(phase_block * tangent_dof_count);
        for (std::uint64_t node = 0; node < node_count; ++node) {
            const std::uint64_t dof0 = node * 2;
            const std::uint64_t dof1 = dof0 + 1;
            const double off0 =
                gamma0 * adapter->graph_preconditioner_edge_tangent[static_cast<std::size_t>(dof1)];
            const double off1 =
                -gamma0 * adapter->graph_preconditioner_edge_tangent[static_cast<std::size_t>(dof0)];
            corrected_phase[dof0] -= off0;
            corrected_phase[dof1] -= off1;
        }
    }

    return apply_mfem_tangent_block_jacobi_right_preconditioner(
        user_data,
        omega,
        adapter->graph_preconditioner_corrected_rhs.data(),
        out,
        tangent_dof_count,
        error_message);
}

FrequencyDomainStatus probe_mfem_demag_tangent_linearity(
    const DrivenFrequencyResponseMfemValidationProblem &problem,
    MfemDrivenResponseValidationResult &result,
    char error_message[128]) noexcept
{
    if (!has_mfem_demag_tangent_operator(problem)) {
        return FrequencyDomainStatus::ok;
    }
    const std::uint64_t dof_count = problem.descriptor.tangent_dof_count;
    if (dof_count == 0) {
        std::snprintf(error_message, 128, "MFEM demag tangent linearity check requires tangent DOFs");
        return FrequencyDomainStatus::validation_error;
    }
    std::vector<double> a(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> b(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> sum(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> scaled(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> out_a(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> out_b(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> out_sum(static_cast<std::size_t>(dof_count), 0.0);
    std::vector<double> out_scaled(static_cast<std::size_t>(dof_count), 0.0);
    constexpr double scale = -1.75;
    for (std::uint64_t index = 0; index < dof_count; ++index) {
        a[static_cast<std::size_t>(index)] =
            1.0e-3 * static_cast<double>((index % 7) + 1);
        b[static_cast<std::size_t>(index)] =
            -5.0e-4 * static_cast<double>((index % 5) + 1);
        sum[static_cast<std::size_t>(index)] =
            a[static_cast<std::size_t>(index)] + b[static_cast<std::size_t>(index)];
        scaled[static_cast<std::size_t>(index)] =
            scale * a[static_cast<std::size_t>(index)];
    }
    FrequencyDomainStatus status = apply_mfem_demag_tangent(
        problem,
        dof_count,
        a.data(),
        out_a.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = apply_mfem_demag_tangent(
        problem,
        dof_count,
        b.data(),
        out_b.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = apply_mfem_demag_tangent(
        problem,
        dof_count,
        sum.data(),
        out_sum.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = apply_mfem_demag_tangent(
        problem,
        dof_count,
        scaled.data(),
        out_scaled.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    double additivity_error = 0.0;
    double homogeneity_error = 0.0;
    double additivity_reference = 0.0;
    double homogeneity_reference = 0.0;
    for (std::uint64_t index = 0; index < dof_count; ++index) {
        const std::size_t offset = static_cast<std::size_t>(index);
        const double additivity_expected = out_a[offset] + out_b[offset];
        const double homogeneity_expected = scale * out_a[offset];
        additivity_error = std::max(
            additivity_error,
            std::fabs(out_sum[offset] - additivity_expected));
        homogeneity_error = std::max(
            homogeneity_error,
            std::fabs(out_scaled[offset] - homogeneity_expected));
        additivity_reference = std::max(
            additivity_reference,
            std::max(std::fabs(out_sum[offset]), std::fabs(additivity_expected)));
        homogeneity_reference = std::max(
            homogeneity_reference,
            std::max(std::fabs(out_scaled[offset]), std::fabs(homogeneity_expected)));
    }
    const double additivity_relative_error = additivity_reference > 0.0
        ? additivity_error / additivity_reference
        : (additivity_error == 0.0 ? 0.0 : std::numeric_limits<double>::infinity());
    const double homogeneity_relative_error = homogeneity_reference > 0.0
        ? homogeneity_error / homogeneity_reference
        : (homogeneity_error == 0.0 ? 0.0 : std::numeric_limits<double>::infinity());
    if (!std::isfinite(additivity_error) ||
        !std::isfinite(homogeneity_error) ||
        !std::isfinite(additivity_relative_error) ||
        !std::isfinite(homogeneity_relative_error)) {
        std::snprintf(error_message, 128, "MFEM demag tangent linearity check produced non-finite diagnostics");
        return FrequencyDomainStatus::operator_error;
    }
    result.demag_tangent_linearity_check = true;
    result.demag_tangent_additivity_max_abs_error = additivity_error;
    result.demag_tangent_homogeneity_max_abs_error = homogeneity_error;
    result.demag_tangent_additivity_relative_error = additivity_relative_error;
    result.demag_tangent_homogeneity_relative_error = homogeneity_relative_error;
    return FrequencyDomainStatus::ok;
}

void copy_demag_tangent_linearity_diagnostics(
    const MfemDrivenResponseValidationResult &source,
    MfemDrivenResponseValidationResult &target) noexcept
{
    target.demag_tangent_linearity_check = source.demag_tangent_linearity_check;
    target.demag_tangent_additivity_max_abs_error =
        source.demag_tangent_additivity_max_abs_error;
    target.demag_tangent_homogeneity_max_abs_error =
        source.demag_tangent_homogeneity_max_abs_error;
    target.demag_tangent_additivity_relative_error =
        source.demag_tangent_additivity_relative_error;
    target.demag_tangent_homogeneity_relative_error =
        source.demag_tangent_homogeneity_relative_error;
}

void copy_production_cpu_preconditioner_diagnostics(
    const ProductionCpuDrivenResponseResult &source,
    MfemDrivenResponseValidationResult &target) noexcept
{
    target.right_preconditioner_applied = source.right_preconditioner_applied;
    std::strncpy(target.krylov_preconditioner, source.krylov_preconditioner, 63);
    target.krylov_preconditioner[63] = '\0';
    target.rhs_real_l2_norm = source.rhs_real_l2_norm;
    target.rhs_imag_l2_norm = source.rhs_imag_l2_norm;
    target.residual_real_l2_norm = source.residual_real_l2_norm;
    target.residual_imag_l2_norm = source.residual_imag_l2_norm;
    target.response_real_l2_norm = source.response_real_l2_norm;
    target.response_imag_l2_norm = source.response_imag_l2_norm;
    target.rhs_delta_m_l2_norm = source.rhs_delta_m_l2_norm;
    target.rhs_delta_phi_l2_norm = source.rhs_delta_phi_l2_norm;
    target.residual_delta_m_l2_norm = source.residual_delta_m_l2_norm;
    target.residual_delta_phi_l2_norm = source.residual_delta_phi_l2_norm;
    target.relative_residual_delta_m_l2_norm =
        source.relative_residual_delta_m_l2_norm;
    target.relative_residual_delta_phi_l2_norm =
        source.relative_residual_delta_phi_l2_norm;
    target.response_delta_m_l2_norm = source.response_delta_m_l2_norm;
    target.response_delta_phi_l2_norm = source.response_delta_phi_l2_norm;
    target.coupled_block_norms_available = source.coupled_block_norms_available;
    std::strncpy(
        target.coupled_residual_partition_status,
        source.coupled_residual_partition_status,
        63);
    target.coupled_residual_partition_status[63] = '\0';
    target.gmres_relative_residual_history_count = std::min<std::uint64_t>(
        source.gmres_relative_residual_history_count,
        MfemDrivenResponseValidationResult::gmres_relative_residual_history_capacity);
    for (std::uint64_t index = 0;
         index < target.gmres_relative_residual_history_count;
         ++index) {
        target.gmres_relative_residual_history[index] =
            source.gmres_relative_residual_history[index];
    }
}

void copy_production_cpu_diagnostics(
    const ProductionCpuDrivenResponseResult &source,
    DenseDrivenResponseValidationResult &target) noexcept
{
    target.total_iteration_count = source.total_iteration_count;
    target.max_iterations_for_frequency = source.max_iterations_for_frequency;
    target.restart_iterations_for_frequency = source.restart_iterations_for_frequency;
    target.progress_interval_iterations = source.progress_interval_iterations;
    target.solver_relative_tolerance = source.solver_relative_tolerance;
    target.rhs_l2_norm = source.rhs_l2_norm;
    target.initial_residual_l2_norm = source.initial_residual_l2_norm;
    target.initial_relative_residual_l2_norm = source.initial_relative_residual_l2_norm;
    target.minimum_tracked_relative_residual_l2_norm =
        source.minimum_tracked_relative_residual_l2_norm;
    target.minimum_tracked_relative_residual_iteration =
        source.minimum_tracked_relative_residual_iteration;
    target.last_tracked_relative_residual_l2_norm =
        source.last_tracked_relative_residual_l2_norm;
    target.last_recomputed_relative_residual_l2_norm =
        source.last_recomputed_relative_residual_l2_norm;
    target.residual_growth_factor = source.residual_growth_factor;
    target.rhs_delta_m_l2_norm = source.rhs_delta_m_l2_norm;
    target.rhs_delta_phi_l2_norm = source.rhs_delta_phi_l2_norm;
    target.residual_delta_m_l2_norm = source.residual_delta_m_l2_norm;
    target.residual_delta_phi_l2_norm = source.residual_delta_phi_l2_norm;
    target.relative_residual_delta_m_l2_norm =
        source.relative_residual_delta_m_l2_norm;
    target.relative_residual_delta_phi_l2_norm =
        source.relative_residual_delta_phi_l2_norm;
    target.response_delta_m_l2_norm = source.response_delta_m_l2_norm;
    target.response_delta_phi_l2_norm = source.response_delta_phi_l2_norm;
    target.coupled_block_norms_available = source.coupled_block_norms_available;
    std::strncpy(
        target.coupled_residual_partition_status,
        source.coupled_residual_partition_status,
        63);
    target.coupled_residual_partition_status[63] = '\0';
    target.right_preconditioner_applied = source.right_preconditioner_applied;
    std::strncpy(target.krylov_preconditioner, source.krylov_preconditioner, 63);
    target.krylov_preconditioner[63] = '\0';
    target.gmres_relative_residual_history_count = std::min<std::uint64_t>(
        source.gmres_relative_residual_history_count,
        DenseDrivenResponseValidationResult::gmres_relative_residual_history_capacity);
    for (std::uint64_t index = 0;
         index < target.gmres_relative_residual_history_count;
         ++index) {
        target.gmres_relative_residual_history[index] =
            source.gmres_relative_residual_history[index];
    }
}

const char *preconditioner_setup_status(const MfemDrivenResponseValidationResult &result) noexcept
{
    return result.right_preconditioner_applied ? "ok" : "not_configured";
}

std::string gmres_relative_residual_history_json(
    const MfemDrivenResponseValidationResult &result,
    char error_message[128])
{
    std::string json = "[";
    const std::uint64_t count = std::min<std::uint64_t>(
        result.gmres_relative_residual_history_count,
        MfemDrivenResponseValidationResult::gmres_relative_residual_history_capacity);
    for (std::uint64_t index = 0; index < count; ++index) {
        if (index != 0) {
            json += ",";
        }
        if (!append_format(
                json,
                error_message,
                "%.17g",
                result.gmres_relative_residual_history[index])) {
            return "[]";
        }
    }
    json += "]";
    return json;
}

std::string gmres_relative_residual_history_json(
    const ProductionCpuDrivenResponseResult &result,
    char error_message[128])
{
    std::string json = "[";
    const std::uint64_t count = std::min<std::uint64_t>(
        result.gmres_relative_residual_history_count,
        kProductionCpuGmresResidualHistoryCapacity);
    for (std::uint64_t index = 0; index < count; ++index) {
        if (index != 0) {
            json += ",";
        }
        if (!append_format(
                json,
                error_message,
                "%.17g",
                result.gmres_relative_residual_history[index])) {
            return "[]";
        }
    }
    json += "]";
    return json;
}

std::string gmres_relative_residual_history_json(
    const DenseDrivenResponseValidationResult &result,
    char error_message[128])
{
    std::string json = "[";
    const std::uint64_t count = std::min<std::uint64_t>(
        result.gmres_relative_residual_history_count,
        DenseDrivenResponseValidationResult::gmres_relative_residual_history_capacity);
    for (std::uint64_t index = 0; index < count; ++index) {
        if (index != 0) {
            json += ",";
        }
        if (!append_format(
                json,
                error_message,
                "%.17g",
                result.gmres_relative_residual_history[index])) {
            return "[]";
        }
    }
    json += "]";
    return json;
}

std::string coupled_block_norms_diagnostics_json(
    const MfemDrivenResponseValidationResult &result,
    char error_message[128])
{
    if (!result.coupled_block_norms_available ||
        result.coupled_residual_partition_status[0] == '\0') {
        return "";
    }
    std::string json;
    if (!append_format(
            json,
            error_message,
            "\"coupled_residual_partition_status\":\"%s\","
            "\"coupled_block_norms\":{\"rhs_delta_m_l2_norm\":%.17g,"
            "\"rhs_delta_phi_l2_norm\":%.17g,"
            "\"residual_delta_m_l2_norm\":%.17g,"
            "\"residual_delta_phi_l2_norm\":%.17g,"
            "\"relative_residual_delta_m_l2_norm\":%.17g,"
            "\"relative_residual_delta_phi_l2_norm\":%.17g,"
            "\"response_delta_m_l2_norm\":%.17g,"
            "\"response_delta_phi_l2_norm\":%.17g},",
            result.coupled_residual_partition_status,
            result.rhs_delta_m_l2_norm,
            result.rhs_delta_phi_l2_norm,
            result.residual_delta_m_l2_norm,
            result.residual_delta_phi_l2_norm,
            result.relative_residual_delta_m_l2_norm,
            result.relative_residual_delta_phi_l2_norm,
            result.response_delta_m_l2_norm,
            result.response_delta_phi_l2_norm)) {
        return "";
    }
    return json;
}

std::string coupled_block_norms_diagnostics_json(
    const DenseDrivenResponseValidationResult &result,
    char error_message[128])
{
    if (!result.coupled_block_norms_available ||
        result.coupled_residual_partition_status[0] == '\0') {
        return "";
    }
    std::string json;
    if (!append_format(
            json,
            error_message,
            "\"coupled_residual_partition_status\":\"%s\","
            "\"coupled_block_norms\":{\"rhs_delta_m_l2_norm\":%.17g,"
            "\"rhs_delta_phi_l2_norm\":%.17g,"
            "\"residual_delta_m_l2_norm\":%.17g,"
            "\"residual_delta_phi_l2_norm\":%.17g,"
            "\"relative_residual_delta_m_l2_norm\":%.17g,"
            "\"relative_residual_delta_phi_l2_norm\":%.17g,"
            "\"response_delta_m_l2_norm\":%.17g,"
            "\"response_delta_phi_l2_norm\":%.17g},",
            result.coupled_residual_partition_status,
            result.rhs_delta_m_l2_norm,
            result.rhs_delta_phi_l2_norm,
            result.residual_delta_m_l2_norm,
            result.residual_delta_phi_l2_norm,
            result.relative_residual_delta_m_l2_norm,
            result.relative_residual_delta_phi_l2_norm,
            result.response_delta_m_l2_norm,
            result.response_delta_phi_l2_norm)) {
        return "";
    }
    return json;
}

bool detects_constant_phi_nullspace(
    const double *matrix_row_major,
    std::uint64_t coupled_dof_count,
    std::uint64_t phi_start,
    std::uint64_t delta_phi_dof_count) noexcept
{
    if (matrix_row_major == nullptr ||
        coupled_dof_count == 0 ||
        delta_phi_dof_count == 0 ||
        phi_start + delta_phi_dof_count > coupled_dof_count) {
        return false;
    }

    double max_abs_coefficient = 0.0;
    for (std::uint64_t row = 0; row < coupled_dof_count; ++row) {
        for (std::uint64_t column = 0; column < coupled_dof_count; ++column) {
            max_abs_coefficient = std::max(
                max_abs_coefficient,
                std::fabs(matrix_row_major[row * coupled_dof_count + column]));
        }
    }
    const double tolerance =
        std::max(1.0, max_abs_coefficient) *
        static_cast<double>(std::max<std::uint64_t>(coupled_dof_count, 1)) *
        1.0e-10;

    for (std::uint64_t row = 0; row < coupled_dof_count; ++row) {
        double row_sum = 0.0;
        for (std::uint64_t phi = 0; phi < delta_phi_dof_count; ++phi) {
            row_sum += matrix_row_major[row * coupled_dof_count + phi_start + phi];
        }
        if (std::fabs(row_sum) > tolerance) {
            return false;
        }
    }
    for (std::uint64_t column = 0; column < coupled_dof_count; ++column) {
        double column_sum = 0.0;
        for (std::uint64_t phi = 0; phi < delta_phi_dof_count; ++phi) {
            column_sum += matrix_row_major[(phi_start + phi) * coupled_dof_count + column];
        }
        if (std::fabs(column_sum) > tolerance) {
            return false;
        }
    }
    return true;
}

bool has_degenerate_periodic_node_pair(
    const std::uint64_t *node_pairs,
    std::uint64_t node_pair_count) noexcept
{
    if (node_pairs == nullptr) {
        return false;
    }
    for (std::uint64_t pair_index = 0; pair_index < node_pair_count; ++pair_index) {
        const std::uint64_t node_a = node_pairs[pair_index * 2];
        const std::uint64_t node_b = node_pairs[pair_index * 2 + 1];
        if (node_a == node_b) {
            return true;
        }
    }
    return false;
}

bool has_periodic_node_pair_out_of_range(
    const std::uint64_t *node_pairs,
    std::uint64_t node_pair_count,
    std::uint64_t node_count) noexcept
{
    if (node_pairs == nullptr) {
        return false;
    }
    for (std::uint64_t pair_index = 0; pair_index < node_pair_count; ++pair_index) {
        const std::uint64_t node_a = node_pairs[pair_index * 2];
        const std::uint64_t node_b = node_pairs[pair_index * 2 + 1];
        if (node_a >= node_count || node_b >= node_count) {
            return true;
        }
    }
    return false;
}

FrequencyDomainStatus apply_mfem_production_cpu_operator(
    MfemProductionCpuOperatorAdapter *adapter,
    const double *in,
    char error_message[128]) noexcept
{
    if (adapter == nullptr || adapter->request == nullptr || in == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production CPU operator adapter");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseSolveRequest &request = *adapter->request;
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    MfemLinearizedOperatorDiagnostics diagnostics{};
    const double *operator_input = in;
    if (!adapter->static_periodic_representative_node.empty()) {
        project_static_periodic_tangent(
            adapter->static_periodic_representative_node,
            adapter->static_periodic_representative_count,
            in,
            adapter->projected_tangent.data());
        operator_input = adapter->projected_tangent.data();
    }
    const double *demag_tangent = nullptr;
    if (problem.apply_demag_tangent != nullptr) {
        const FrequencyDomainStatus demag_status = problem.apply_demag_tangent(
            problem.demag_tangent_user_data,
            operator_input,
            adapter->demag_tangent.data(),
            error_message);
        if (demag_status != FrequencyDomainStatus::ok) {
            return demag_status;
        }
        demag_tangent = adapter->demag_tangent.data();
    } else if (problem.apply_demag_tangent_with_potential != nullptr) {
        std::vector<double> unused_phi(
            static_cast<std::size_t>(request.periodic_airbox_delta_phi_dof_count),
            0.0);
        const FrequencyDomainStatus demag_status =
            problem.apply_demag_tangent_with_potential(
                problem.demag_tangent_user_data,
                operator_input,
                adapter->demag_tangent.data(),
                unused_phi.data(),
                request.periodic_airbox_delta_phi_dof_count,
                error_message);
        if (demag_status != FrequencyDomainStatus::ok) {
            return demag_status;
        }
        demag_tangent = adapter->demag_tangent.data();
    } else if (problem.demag_tangent_matrix_row_major != nullptr) {
        const FrequencyDomainStatus demag_status = apply_dense_tangent_matrix(
            problem.demag_tangent_matrix_row_major,
            request.solve_request.operator_request.tangent_dof_count,
            operator_input,
            adapter->demag_tangent.data(),
            "MFEM explicit demag tangent",
            error_message);
        if (demag_status != FrequencyDomainStatus::ok) {
            return demag_status;
        }
        demag_tangent = adapter->demag_tangent.data();
    }
    const FrequencyDomainStatus status = apply_mfem_linearized_cpu_operator(
        problem.descriptor,
        problem.layout,
        problem.nodes,
        problem.exchange_edges,
        problem.exchange_edge_count,
        problem.h_ext_a_per_m,
        problem.uniaxial_anisotropy_axis,
        problem.uniaxial_anisotropy_field_a_per_m,
        problem.alpha_per_node,
        request.solve_request.operator_request.gamma0,
        request.solve_request.operator_request.alpha,
        MfemLinearizedOperatorWorkspace{
            adapter->zeeman_blocks.data(),
            adapter->uniaxial_anisotropy_blocks.data(),
            adapter->exchange_tangent.data(),
            adapter->zeeman_tangent.data(),
            adapter->uniaxial_anisotropy_tangent.data(),
            adapter->effective_field_tangent.data(),
            nullptr,
            adapter->dmi_tangent.data(),
            problem.dmi_elements,
            problem.dmi_element_count,
            problem.dmi_lumped_mass,
            problem.dmi_ms_field,
            problem.dmi_uniform_ms,
            adapter->dmi_delta_xyz.data(),
            adapter->dmi_residual_xyz.data(),
            adapter->dmi_field_xyz.data(),
            demag_tangent,
        },
        operator_input,
        adapter->stiffness_tangent.data(),
        adapter->mass_tangent.data(),
        &diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        std::snprintf(error_message, 128, "%s", diagnostics.error_message);
        return status;
    }
    project_static_periodic_tangent_in_place(
        adapter->static_periodic_representative_node,
        adapter->static_periodic_representative_count,
        adapter->static_periodic_projection_workspace,
        adapter->stiffness_tangent.data());
    project_static_periodic_tangent_in_place(
        adapter->static_periodic_representative_node,
        adapter->static_periodic_representative_count,
        adapter->static_periodic_projection_workspace,
        adapter->mass_tangent.data());
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_production_cpu_mass_only(
    MfemProductionCpuOperatorAdapter *adapter,
    const double *in,
    char error_message[128]) noexcept
{
    if (adapter == nullptr || adapter->request == nullptr || in == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production CPU mass adapter");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseSolveRequest &request = *adapter->request;
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    const double *operator_input = in;
    if (!adapter->static_periodic_representative_node.empty()) {
        project_static_periodic_tangent(
            adapter->static_periodic_representative_node,
            adapter->static_periodic_representative_count,
            in,
            adapter->projected_tangent.data());
        operator_input = adapter->projected_tangent.data();
    }
    TangentFrequencyMassDiagnostics diagnostics{};
    const FrequencyDomainStatus status = apply_tangent_frequency_mass_operator(
        problem.nodes,
        operator_input,
        TangentWorkspaceShape{
            problem.descriptor.node_count,
            problem.descriptor.full_dof_count,
            problem.descriptor.tangent_dof_count,
        },
        request.solve_request.operator_request.alpha,
        problem.alpha_per_node,
        adapter->mass_tangent.data(),
        &diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        std::snprintf(error_message, 128, "%s", diagnostics.error_message);
        return status;
    }
    project_static_periodic_tangent_in_place(
        adapter->static_periodic_representative_node,
        adapter->static_periodic_representative_count,
        adapter->static_periodic_projection_workspace,
        adapter->mass_tangent.data());
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_production_cpu_stiffness(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionCpuOperatorAdapter *>(user_data);
    if (out == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production CPU stiffness output");
        return FrequencyDomainStatus::validation_error;
    }
    const FrequencyDomainStatus status =
        apply_mfem_production_cpu_operator(adapter, in, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::memcpy(
        out,
        adapter->stiffness_tangent.data(),
        static_cast<std::size_t>(adapter->request->solve_request.operator_request.tangent_dof_count * sizeof(double)));
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_production_cpu_mass(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionCpuOperatorAdapter *>(user_data);
    if (out == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production CPU mass output");
        return FrequencyDomainStatus::validation_error;
    }
    const FrequencyDomainStatus status =
        apply_mfem_production_cpu_mass_only(adapter, in, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::memcpy(
        out,
        adapter->mass_tangent.data(),
        static_cast<std::size_t>(adapter->request->solve_request.operator_request.tangent_dof_count * sizeof(double)));
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_phi_consistency_schur_stiffness(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *context = static_cast<MfemPhiConsistencySchurProviderContext *>(user_data);
    if (context == nullptr ||
        context->adapter.request == nullptr ||
        in == nullptr ||
        out == nullptr ||
        context->delta_m_tangent_dof_count == 0 ||
        context->delta_phi_dof_count == 0) {
        std::snprintf(error_message, 128, "MFEM phi-consistency Schur provider requires coupled buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        context->adapter.request->mfem_validation_problem;
    if (problem.apply_demag_tangent_with_potential == nullptr) {
        std::snprintf(error_message, 128, "MFEM phi-consistency Schur provider requires demag tangent-with-potential callback");
        return FrequencyDomainStatus::validation_error;
    }

    const FrequencyDomainStatus stiffness_status =
        apply_mfem_production_cpu_stiffness(
            &context->adapter,
            in,
            out,
            error_message);
    if (stiffness_status != FrequencyDomainStatus::ok) {
        return stiffness_status;
    }
    const FrequencyDomainStatus demag_status =
        problem.apply_demag_tangent_with_potential(
            problem.demag_tangent_user_data,
            in,
            context->demag_tangent_workspace.data(),
            context->delta_phi_workspace.data(),
            context->delta_phi_dof_count,
            error_message);
    if (demag_status != FrequencyDomainStatus::ok) {
        return demag_status;
    }

    double *phi_out = out + context->delta_m_tangent_dof_count;
    const double *phi_in = in + context->delta_m_tangent_dof_count;
    for (std::uint64_t phi = 0; phi < context->delta_phi_dof_count; ++phi) {
        phi_out[phi] =
            phi_in[phi] -
            context->delta_phi_workspace[static_cast<std::size_t>(phi)];
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_phi_consistency_schur_mass(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *context = static_cast<MfemPhiConsistencySchurProviderContext *>(user_data);
    if (context == nullptr ||
        context->adapter.request == nullptr ||
        in == nullptr ||
        out == nullptr ||
        context->delta_m_tangent_dof_count == 0 ||
        context->delta_phi_dof_count == 0) {
        std::snprintf(error_message, 128, "MFEM phi-consistency Schur mass provider requires coupled buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const FrequencyDomainStatus mass_status =
        apply_mfem_production_cpu_mass(
            &context->adapter,
            in,
            out,
            error_message);
    if (mass_status != FrequencyDomainStatus::ok) {
        return mass_status;
    }
    std::fill(
        out + context->delta_m_tangent_dof_count,
        out + context->delta_m_tangent_dof_count + context->delta_phi_dof_count,
        0.0);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_phi_consistency_schur_right_preconditioner(
    void *user_data,
    double omega,
    const double *in,
    double *out,
    std::uint64_t coupled_dof_count,
    char error_message[128]) noexcept
{
    auto *context = static_cast<MfemPhiConsistencySchurProviderContext *>(user_data);
    if (context == nullptr ||
        context->adapter.request == nullptr ||
        in == nullptr ||
        out == nullptr ||
        context->delta_m_tangent_dof_count == 0 ||
        context->delta_phi_dof_count == 0 ||
        coupled_dof_count != context->delta_m_tangent_dof_count + context->delta_phi_dof_count) {
        std::snprintf(error_message, 128, "MFEM phi-consistency Schur preconditioner requires coupled buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        context->adapter.request->mfem_validation_problem;
    if (problem.apply_demag_tangent_with_potential == nullptr) {
        std::snprintf(error_message, 128, "MFEM phi-consistency Schur preconditioner requires demag tangent-with-potential callback");
        return FrequencyDomainStatus::validation_error;
    }
    const std::uint64_t delta_m = context->delta_m_tangent_dof_count;
    const std::uint64_t delta_phi = context->delta_phi_dof_count;
    context->preconditioner_magnetic_input.assign(
        static_cast<std::size_t>(delta_m * 2),
        0.0);
    context->preconditioner_magnetic_output.assign(
        static_cast<std::size_t>(delta_m * 2),
        0.0);
    std::memcpy(
        context->preconditioner_magnetic_input.data(),
        in,
        static_cast<std::size_t>(delta_m * sizeof(double)));
    std::memcpy(
        context->preconditioner_magnetic_input.data() + delta_m,
        in + coupled_dof_count,
        static_cast<std::size_t>(delta_m * sizeof(double)));

    ProductionCpuFrequencyDomainRightPreconditioner magnetic_preconditioner = nullptr;
    if (context->adapter.graph_preconditioner_enabled) {
        magnetic_preconditioner = apply_mfem_tangent_graph_demag_coarse_right_preconditioner;
    } else if (context->adapter.demag_coarse_preconditioner_enabled) {
        magnetic_preconditioner = apply_mfem_tangent_demag_coarse_right_preconditioner;
    } else if (context->adapter.block_jacobi_preconditioner_enabled) {
        magnetic_preconditioner = apply_mfem_tangent_block_jacobi_right_preconditioner;
    }
    if (magnetic_preconditioner == nullptr) {
        std::memcpy(
            context->preconditioner_magnetic_output.data(),
            context->preconditioner_magnetic_input.data(),
            static_cast<std::size_t>(delta_m * 2 * sizeof(double)));
    } else {
        const FrequencyDomainStatus status = magnetic_preconditioner(
            &context->adapter,
            omega,
            context->preconditioner_magnetic_input.data(),
            context->preconditioner_magnetic_output.data(),
            delta_m,
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }

    std::memcpy(
        out,
        context->preconditioner_magnetic_output.data(),
        static_cast<std::size_t>(delta_m * sizeof(double)));
    std::memcpy(
        out + coupled_dof_count,
        context->preconditioner_magnetic_output.data() + delta_m,
        static_cast<std::size_t>(delta_m * sizeof(double)));

    context->preconditioner_phi_real.assign(static_cast<std::size_t>(delta_phi), 0.0);
    context->preconditioner_phi_imag.assign(static_cast<std::size_t>(delta_phi), 0.0);
    FrequencyDomainStatus phi_status = problem.apply_demag_tangent_with_potential(
        problem.demag_tangent_user_data,
        context->preconditioner_magnetic_output.data(),
        context->demag_tangent_workspace.data(),
        context->preconditioner_phi_real.data(),
        delta_phi,
        error_message);
    if (phi_status != FrequencyDomainStatus::ok) {
        return phi_status;
    }
    phi_status = problem.apply_demag_tangent_with_potential(
        problem.demag_tangent_user_data,
        context->preconditioner_magnetic_output.data() + delta_m,
        context->demag_tangent_workspace.data(),
        context->preconditioner_phi_imag.data(),
        delta_phi,
        error_message);
    if (phi_status != FrequencyDomainStatus::ok) {
        return phi_status;
    }

    for (std::uint64_t phi = 0; phi < delta_phi; ++phi) {
        out[delta_m + phi] =
            in[delta_m + phi] +
            context->preconditioner_phi_real[static_cast<std::size_t>(phi)];
        out[coupled_dof_count + delta_m + phi] =
            in[coupled_dof_count + delta_m + phi] +
            context->preconditioner_phi_imag[static_cast<std::size_t>(phi)];
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_production_gpu_operator(
    MfemProductionGpuOperatorAdapter *adapter,
    const double *in,
    char error_message[128]) noexcept
{
    if (adapter == nullptr || adapter->request == nullptr || in == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production GPU operator buffers");
        return FrequencyDomainStatus::validation_error;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    const DrivenFrequencyResponseSolveRequest &request = *adapter->request;
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    const double *operator_input = in;
    if (!adapter->static_periodic_representative_node.empty()) {
        project_static_periodic_tangent(
            adapter->static_periodic_representative_node,
            adapter->static_periodic_representative_count,
            in,
            adapter->projected_tangent.data());
        operator_input = adapter->projected_tangent.data();
    }
    const double *demag_tangent = nullptr;
    if (problem.apply_demag_tangent != nullptr) {
        const FrequencyDomainStatus demag_status = problem.apply_demag_tangent(
            problem.demag_tangent_user_data,
            operator_input,
            adapter->demag_tangent.data(),
            error_message);
        if (demag_status != FrequencyDomainStatus::ok) {
            return demag_status;
        }
        demag_tangent = adapter->demag_tangent.data();
    } else if (problem.demag_tangent_matrix_row_major != nullptr) {
        const FrequencyDomainStatus demag_status = apply_dense_tangent_matrix(
            problem.demag_tangent_matrix_row_major,
            request.solve_request.operator_request.tangent_dof_count,
            operator_input,
            adapter->demag_tangent.data(),
            "MFEM explicit demag tangent",
            error_message);
        if (demag_status != FrequencyDomainStatus::ok) {
            return demag_status;
        }
        demag_tangent = adapter->demag_tangent.data();
    }
    const int rc = fullmag_fem_frequency_domain_apply_mfem_gpu_operator(
        static_cast<unsigned long long>(problem.descriptor.node_count),
        static_cast<unsigned long long>(request.solve_request.operator_request.tangent_dof_count),
        problem.nodes,
        problem.descriptor.exchange_enabled ? 1 : 0,
        problem.exchange_edges,
        static_cast<unsigned long long>(problem.exchange_edge_count),
        problem.descriptor.zeeman_enabled ? 1 : 0,
        problem.h_ext_a_per_m,
        problem.descriptor.uniaxial_anisotropy_enabled ? 1 : 0,
        problem.uniaxial_anisotropy_axis,
        problem.uniaxial_anisotropy_field_a_per_m,
        problem.alpha_per_node,
        demag_tangent,
        request.solve_request.operator_request.alpha,
        request.solve_request.operator_request.gamma0,
        operator_input,
        adapter->stiffness_tangent.data(),
        adapter->mass_tangent.data(),
        error_message,
        128);
    if (rc != 0) {
        return FrequencyDomainStatus::operator_error;
    }
    project_static_periodic_tangent_in_place(
        adapter->static_periodic_representative_node,
        adapter->static_periodic_representative_count,
        adapter->static_periodic_projection_workspace,
        adapter->stiffness_tangent.data());
    project_static_periodic_tangent_in_place(
        adapter->static_periodic_representative_node,
        adapter->static_periodic_representative_count,
        adapter->static_periodic_projection_workspace,
        adapter->mass_tangent.data());
    return FrequencyDomainStatus::ok;
#else
    (void)adapter;
    (void)in;
    std::snprintf(error_message, 128, "native FEM frequency-domain production GPU requires CUDA runtime");
    return FrequencyDomainStatus::unavailable;
#endif
}

FrequencyDomainStatus apply_mfem_production_gpu_stiffness(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionGpuOperatorAdapter *>(user_data);
    if (out == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production GPU stiffness output");
        return FrequencyDomainStatus::validation_error;
    }
    const FrequencyDomainStatus status =
        apply_mfem_production_gpu_operator(adapter, in, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::memcpy(
        out,
        adapter->stiffness_tangent.data(),
        static_cast<std::size_t>(adapter->request->solve_request.operator_request.tangent_dof_count * sizeof(double)));
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_mfem_production_gpu_mass(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128]) noexcept
{
    auto *adapter = static_cast<MfemProductionGpuOperatorAdapter *>(user_data);
    if (out == nullptr) {
        std::snprintf(error_message, 128, "missing MFEM production GPU mass output");
        return FrequencyDomainStatus::validation_error;
    }
    const FrequencyDomainStatus status =
        apply_mfem_production_gpu_operator(adapter, in, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::memcpy(
        out,
        adapter->mass_tangent.data(),
        static_cast<std::size_t>(adapter->request->solve_request.operator_request.tangent_dof_count * sizeof(double)));
    return FrequencyDomainStatus::ok;
}

double canonical_phase(double phase_rad) noexcept
{
    constexpr double pi = 3.14159265358979323846;
    if (phase_rad <= -pi) {
        return pi;
    }
    return phase_rad;
}

double drive_global_phase_rad(
    const double *drive_real,
    const double *drive_imag,
    std::uint64_t tangent_dof_count) noexcept
{
    if (drive_real == nullptr) {
        return 0.0;
    }
    for (std::uint64_t dof = 0; dof < tangent_dof_count; ++dof) {
        const double real = drive_real[dof];
        const double imag = drive_imag == nullptr ? 0.0 : drive_imag[dof];
        if (real != 0.0 || imag != 0.0) {
            return canonical_phase(std::atan2(imag, real));
        }
    }
    return 0.0;
}

struct ResponsePointObservableJson {
    std::string susceptibility_tensor;
    std::string susceptibility_provenance;
    std::string absorbed_power_density_provenance;
    std::string tangent_leakage;
    double absorbed_power_density = 0.0;
};

struct ResponsePointSeriesJson {
    std::string m_complex;
    std::string component_amplitude;
    std::string component_phase;
    double response_phase = 0.0;
    double response_amplitude = 0.0;
};

bool build_response_point_series_json(
    const double *response_real,
    const double *response_imag,
    std::uint64_t response_dof_count,
    ResponsePointSeriesJson &out,
    char error_message[128]) noexcept
{
    out = {};
    out.m_complex = "[";
    out.component_amplitude = "[";
    out.component_phase = "[";
    for (std::uint64_t dof = 0; dof < response_dof_count; ++dof) {
        const double real_part = response_real == nullptr ? 0.0 : response_real[dof];
        const double imag_part = response_imag == nullptr ? 0.0 : response_imag[dof];
        const double component_amplitude = std::hypot(real_part, imag_part);
        const double component_phase = canonical_phase(std::atan2(imag_part, real_part));
        if (component_amplitude > out.response_amplitude) {
            out.response_amplitude = component_amplitude;
            out.response_phase = component_phase;
        }
        char component_json[128]{};
        int component_written = std::snprintf(
            component_json,
            sizeof(component_json),
            "%s[%.17g,%.17g]",
            dof == 0 ? "" : ",",
            real_part,
            imag_part);
        if (component_written < 0 ||
            static_cast<std::size_t>(component_written) >= sizeof(component_json)) {
            std::snprintf(error_message, 128, "failed to format response m_complex component");
            return false;
        }
        out.m_complex += component_json;
        component_written = std::snprintf(
            component_json,
            sizeof(component_json),
            "%s%.17g",
            dof == 0 ? "" : ",",
            component_amplitude);
        if (component_written < 0 ||
            static_cast<std::size_t>(component_written) >= sizeof(component_json)) {
            std::snprintf(error_message, 128, "failed to format response component amplitude");
            return false;
        }
        out.component_amplitude += component_json;
        component_written = std::snprintf(
            component_json,
            sizeof(component_json),
            "%s%.17g",
            dof == 0 ? "" : ",",
            component_phase);
        if (component_written < 0 ||
            static_cast<std::size_t>(component_written) >= sizeof(component_json)) {
            std::snprintf(error_message, 128, "failed to format response component phase");
            return false;
        }
        out.component_phase += component_json;
    }
    out.m_complex += "]";
    out.component_amplitude += "]";
    out.component_phase += "]";
    return true;
}

ResponsePointObservableJson build_response_point_observable_json(
    const double *response_real,
    const double *response_imag,
    const double *drive_real,
    const double *drive_imag,
    std::uint64_t tangent_dof_count,
    double angular_frequency_rad_per_s,
    const double *observable_ms_field,
    std::uint64_t observable_ms_field_len,
    double observable_uniform_ms) noexcept
{
    double drive_norm_squared = 0.0;
    double projected_real = 0.0;
    double projected_imag = 0.0;
    double projected_ms_real = 0.0;
    double projected_ms_imag = 0.0;
    const std::uint64_t node_count = tangent_dof_count / 2;
    const bool has_ms_field =
        observable_ms_field != nullptr &&
        observable_ms_field_len == node_count &&
        node_count > 0;
    const bool has_uniform_ms =
        std::isfinite(observable_uniform_ms) &&
        observable_uniform_ms > 0.0;
    bool ms_values_finite = true;
    for (std::uint64_t dof = 0; dof < tangent_dof_count; ++dof) {
        const double drive_re = drive_real == nullptr ? 0.0 : drive_real[dof];
        const double drive_im = drive_imag == nullptr ? 0.0 : drive_imag[dof];
        const double response_re = response_real == nullptr ? 0.0 : response_real[dof];
        const double response_im = response_imag == nullptr ? 0.0 : response_imag[dof];
        drive_norm_squared += drive_re * drive_re + drive_im * drive_im;
        const double dof_projected_real = response_re * drive_re + response_im * drive_im;
        const double dof_projected_imag = response_im * drive_re - response_re * drive_im;
        projected_real += dof_projected_real;
        projected_imag += dof_projected_imag;
        if (has_ms_field || has_uniform_ms) {
            const double ms = has_ms_field ?
                observable_ms_field[dof / 2] :
                observable_uniform_ms;
            if (!std::isfinite(ms) || ms <= 0.0) {
                ms_values_finite = false;
            } else {
                projected_ms_real += ms * dof_projected_real;
                projected_ms_imag += ms * dof_projected_imag;
            }
        }
    }

    const bool has_drive = drive_norm_squared > 0.0 && std::isfinite(drive_norm_squared);
    const bool has_ms = has_drive && ms_values_finite && (has_ms_field || has_uniform_ms);
    const double susceptibility_real = has_drive
        ? (has_ms ? projected_ms_real : projected_real) / drive_norm_squared
        : 0.0;
    const double susceptibility_imag = has_drive
        ? (has_ms ? projected_ms_imag : projected_imag) / drive_norm_squared
        : 0.0;
    const double dof_scale = tangent_dof_count == 0 ? 1.0 : static_cast<double>(tangent_dof_count);
    constexpr double mu0_t_m_per_a = 1.2566370614359172954e-6;
    const double absorbed_power_density = has_drive
        ? 0.5 *
            (has_ms ? mu0_t_m_per_a * std::fabs(projected_ms_imag) : std::fabs(projected_imag)) *
            std::fabs(angular_frequency_rad_per_s) / dof_scale
        : 0.0;

    ResponsePointObservableJson out{};
    if (!std::isfinite(susceptibility_real) ||
        !std::isfinite(susceptibility_imag) ||
        !std::isfinite(absorbed_power_density)) {
        out.susceptibility_tensor = "[[0.0,0.0]]";
        out.absorbed_power_density = 0.0;
    } else {
        char susceptibility_json[128]{};
        std::snprintf(
            susceptibility_json,
            sizeof(susceptibility_json),
            "[[%.17g,%.17g]]",
            susceptibility_real,
            susceptibility_imag);
        out.susceptibility_tensor = susceptibility_json;
        out.absorbed_power_density = absorbed_power_density;
    }
    if (has_ms) {
        out.susceptibility_provenance =
            std::string("{\"kind\":\"drive_projected_si_susceptibility\","
            "\"basis\":\"local_tangent_drive\","
            "\"component_pair_count\":1,"
            "\"full_tensor\":false,"
            "\"response_quantity\":\"delta_M_over_h_drive\","
            "\"response_units\":\"dimensionless\","
            "\"dimensionless_si_susceptibility\":true,"
            "\"requires_ms_for_chi_si\":false,"
            "\"ms_factor_applied\":true,"
            "\"ms_source\":\"") +
            (has_ms_field ? "per_node_field" : "uniform") +
            "\",\"normalization\":\"sum(Ms*response*conj(drive))/sum(abs(drive)^2)\"}";
        out.absorbed_power_density_provenance =
            std::string("{\"kind\":\"drive_projected_absorbed_power_density\","
            "\"basis\":\"local_tangent_drive\","
            "\"physical_power_density\":true,"
            "\"units\":\"W/m^3\","
            "\"requires_mu0_ms_factor\":false,"
            "\"mu0_ms_factor_applied\":true,"
            "\"ms_source\":\"") +
            (has_ms_field ? "per_node_field" : "uniform") +
            "\",\"normalization\":\"0.5*mu0*abs(omega)*abs(imag(sum(Ms*response*conj(drive))))/tangent_dof_count\","
            "\"volume_weighted\":false,"
            "\"spatial_reduction\":\"drive_projected_tangent_dof_average\","
            "\"full_power_density\":true}";
    } else {
        out.susceptibility_provenance =
            "{\"kind\":\"drive_projected_scalar\","
            "\"basis\":\"local_tangent_drive\","
            "\"component_pair_count\":1,"
            "\"full_tensor\":false,"
            "\"response_quantity\":\"delta_m_over_h_drive\","
            "\"response_units\":\"m/A\","
            "\"dimensionless_si_susceptibility\":false,"
            "\"requires_ms_for_chi_si\":true,"
            "\"ms_factor_applied\":false,"
            "\"normalization\":\"sum(response*conj(drive))/sum(abs(drive)^2)\"}";
        out.absorbed_power_density_provenance =
            "{\"kind\":\"drive_projected_absorption_proxy\","
            "\"basis\":\"local_tangent_drive\","
            "\"physical_power_density\":false,"
            "\"units\":\"proxy_not_W_per_m3\","
            "\"requires_mu0_ms_factor\":true,"
            "\"ms_factor_applied\":false,"
            "\"normalization\":\"0.5*abs(omega)*abs(imag(sum(response*conj(drive))))/tangent_dof_count\","
            "\"full_power_density\":false}";
    }
    out.tangent_leakage =
        "{\"status\":\"evaluated\","
        "\"basis\":\"local_tangent_frame\","
        "\"mean_abs_m0_dot_delta_m\":0.0,"
        "\"max_abs_m0_dot_delta_m\":0.0,"
        "\"reason\":\"response_is_reconstructed_from_two_tangent_components\"}";
    return out;
}

FrequencyDomainStatus write_text_artifact(
    const char *path,
    const char *content,
    char error_message[128]) noexcept
{
    FILE *output = std::fopen(path, "w");
    if (output == nullptr) {
        std::snprintf(error_message, 128, "failed to open artifact file: %s", path);
        return FrequencyDomainStatus::artifact_error;
    }
    const int write_status = std::fputs(content, output);
    const int close_status = std::fclose(output);
    if (write_status < 0 || close_status != 0) {
        std::snprintf(error_message, 128, "failed to write artifact file: %s", path);
        return FrequencyDomainStatus::artifact_error;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus write_binary_artifact(
    const char *path,
    const void *content,
    std::size_t byte_count,
    char error_message[128]) noexcept
{
    FILE *output = std::fopen(path, "wb");
    if (output == nullptr) {
        std::snprintf(error_message, 128, "failed to open binary artifact file: %s", path);
        return FrequencyDomainStatus::artifact_error;
    }
    const std::size_t written = std::fwrite(content, 1, byte_count, output);
    const int close_status = std::fclose(output);
    if (written != byte_count || close_status != 0) {
        std::snprintf(error_message, 128, "failed to write binary artifact file: %s", path);
        return FrequencyDomainStatus::artifact_error;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus write_zarr_group_artifact(
    const char *path,
    char error_message[128]) noexcept
{
    char zgroup_path[256]{};
    if (std::snprintf(zgroup_path, sizeof(zgroup_path), "%s/.zgroup", path) < 0 ||
        std::strlen(zgroup_path) >= sizeof(zgroup_path) - 1) {
        std::snprintf(error_message, 128, "failed to format Zarr group artifact path");
        return FrequencyDomainStatus::artifact_error;
    }
    return write_text_artifact(zgroup_path, "{\"zarr_format\":2}", error_message);
}

FrequencyDomainStatus write_response_zarr_store_attrs(
    const char *field_payloads_zarr_dir,
    char error_message[128]) noexcept
{
    char zattrs_path[256]{};
    if (std::snprintf(zattrs_path, sizeof(zattrs_path), "%s/.zattrs", field_payloads_zarr_dir) < 0 ||
        std::strlen(zattrs_path) >= sizeof(zattrs_path) - 1) {
        std::snprintf(error_message, 128, "failed to format Zarr store attrs path");
        return FrequencyDomainStatus::artifact_error;
    }
    return write_text_artifact(
        zattrs_path,
        "{\"fullmag_kind\":\"frequency_domain_response_field_store\","
        "\"schema_version\":1,"
        "\"preferred_container\":\"zarr\","
        "\"quantity_ids\":[\"dynamic_response\"],"
        "\"axes\":[\"frequency\",\"spatial_sample\",\"component\",\"complex\"],"
        "\"component_order\":[\"x\",\"y\",\"z\"],"
        "\"complex_order\":[\"real\",\"imag\"],"
        "\"storage_layout\":\"aos_xyz_complex_pairs\","
        "\"compatibility_binary_exports\":true}",
        error_message);
}

FrequencyDomainStatus write_response_zarr_array_artifacts(
    const char *array_dir,
    std::uint64_t sample_count,
    std::uint64_t component_count,
    const char *component_order_json,
    const char *component_basis,
    const char *value_kind,
    char error_message[128]) noexcept
{
    char zarray_path[256]{};
    char zattrs_path[256]{};
    if (std::snprintf(zarray_path, sizeof(zarray_path), "%s/.zarray", array_dir) < 0 ||
        std::snprintf(zattrs_path, sizeof(zattrs_path), "%s/.zattrs", array_dir) < 0 ||
        std::strlen(zarray_path) >= sizeof(zarray_path) - 1 ||
        std::strlen(zattrs_path) >= sizeof(zattrs_path) - 1) {
        std::snprintf(error_message, 128, "failed to format Zarr array artifact path");
        return FrequencyDomainStatus::artifact_error;
    }
    std::string zarray_json;
    if (!append_format(
            zarray_json,
            error_message,
            "{\"zarr_format\":2,"
            "\"shape\":[%llu,%llu,2],"
            "\"chunks\":[%llu,%llu,2],"
            "\"dtype\":\"<f8\","
            "\"compressor\":null,"
            "\"fill_value\":0.0,"
            "\"order\":\"C\","
            "\"filters\":null,"
            "\"dimension_separator\":\".\"}",
            static_cast<unsigned long long>(sample_count),
            static_cast<unsigned long long>(component_count),
            static_cast<unsigned long long>(sample_count == 0 ? 1 : sample_count),
            static_cast<unsigned long long>(component_count))) {
        return FrequencyDomainStatus::artifact_error;
    }
    FrequencyDomainStatus status =
        write_text_artifact(zarray_path, zarray_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::string zattrs_json;
    if (!append_format(
            zattrs_json,
            error_message,
            "{\"quantity_id\":\"delta_m\","
            "\"unit\":\"1\","
            "\"value_kind\":\"%s\","
            "\"component_basis\":\"%s\","
            "\"axes\":[\"spatial_sample\",\"component\",\"complex\"],"
            "\"component_order\":%s,"
            "\"complex_order\":[\"real\",\"imag\"],"
            "\"storage_layout\":\"aos_component_complex_pairs\"}",
            value_kind,
            component_basis,
            component_order_json)) {
        return FrequencyDomainStatus::artifact_error;
    }
    return write_text_artifact(zattrs_path, zattrs_json.c_str(), error_message);
}

FrequencyDomainStatus ensure_directory(const char *path, char error_message[128]) noexcept
{
    if (mkdir(path, 0777) == 0 || errno == EEXIST) {
        return FrequencyDomainStatus::ok;
    }
    std::snprintf(error_message, 128, "failed to create artifact directory: %s", path);
    return FrequencyDomainStatus::artifact_error;
}

bool has_mfem_demag_tangent_operator(
    const DrivenFrequencyResponseMfemValidationProblem &problem) noexcept
{
    return problem.apply_demag_tangent != nullptr ||
        problem.apply_demag_tangent_with_potential != nullptr ||
        problem.demag_tangent_matrix_row_major != nullptr;
}

const char *mfem_demag_tangent_operator_source(
    const DrivenFrequencyResponseMfemValidationProblem &problem) noexcept
{
    if (problem.apply_demag_tangent != nullptr ||
        problem.apply_demag_tangent_with_potential != nullptr) {
        return "matrix_free_demag_tangent_provider";
    }
    if (problem.demag_tangent_matrix_row_major != nullptr) {
        return "explicit_demag_tangent_matrix";
    }
    return "none";
}

FrequencyDomainStatus write_mfem_validation_artifacts(
    const DrivenFrequencyResponseSolveRequest &request,
    const MfemDrivenResponseValidationResult &validation_result,
    const double *response_real,
    const double *response_imag,
    const double *residual_l2_norm,
    const double *relative_residual_l2_norm,
    const char *run_status,
    bool complete,
    char manifest_path[256],
    char error_message[128]) noexcept
{
    if (!has_output_directory(request.output_directory)) {
        manifest_path[0] = '\0';
        return FrequencyDomainStatus::ok;
    }
    if (!complete && !request.write_partial_artifacts) {
        manifest_path[0] = '\0';
        return FrequencyDomainStatus::ok;
    }
    const char *incomplete_status =
        run_status != nullptr && run_status[0] != '\0' ? run_status : "interrupted";
    const char *artifact_status = complete ? "ready" : incomplete_status;
    const char *progress_state = complete ? "completed" : incomplete_status;
    const bool interrupted_artifact =
        !complete && std::strcmp(incomplete_status, "interrupted") == 0;
    const bool partial_artifacts_available =
        validation_result.completed_frequency_count > 0 || !interrupted_artifact;
    const bool write_field_payloads = request.solve_request.write_response_fields;
    const bool write_spatial_field_payloads =
        write_field_payloads &&
        request.mfem_validation_problem.nodes != nullptr &&
        request.mfem_validation_problem.descriptor.node_count > 0 &&
        request.mfem_validation_problem.descriptor.tangent_dof_count == validation_result.response_dof_count &&
        request.mfem_validation_problem.descriptor.tangent_dof_count ==
            request.mfem_validation_problem.descriptor.node_count * 2 &&
        request.mfem_validation_problem.descriptor.full_dof_count ==
            request.mfem_validation_problem.descriptor.node_count * 3;
    const std::string gmres_history_json =
        gmres_relative_residual_history_json(validation_result, error_message);
    const std::string coupled_block_norms_json =
        coupled_block_norms_diagnostics_json(validation_result, error_message);

    char frequency_domain_dir[256]{};
    char response_dir[256]{};
    char mesh_dir[256]{};
    char frequency_points_dir[256]{};
    char field_payloads_dir[256]{};
    char field_payloads_zarr_dir[256]{};
    char manifest[256]{};
    char sweep[256]{};
    char sweep_v2[256]{};
    char progress[256]{};
    char cancel_requested[256]{};
    char diagnostics[256]{};
    char diagnostics_dir[256]{};
    char solver_diagnostics[256]{};
    char periodic_pairs[256]{};
    if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
        std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
        std::snprintf(mesh_dir, sizeof(mesh_dir), "%s/mesh", request.output_directory) < 0 ||
        std::snprintf(frequency_points_dir, sizeof(frequency_points_dir), "%s/frequency_points", response_dir) < 0 ||
        std::snprintf(field_payloads_dir, sizeof(field_payloads_dir), "%s/field_payloads", response_dir) < 0 ||
        std::snprintf(field_payloads_zarr_dir, sizeof(field_payloads_zarr_dir), "%s/field_payloads.zarr", response_dir) < 0 ||
        std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
        std::snprintf(sweep, sizeof(sweep), "%s/magnetic_response_sweep.v1.json", response_dir) < 0 ||
        std::snprintf(sweep_v2, sizeof(sweep_v2), "%s/magnetic_response_sweep.v2.json", response_dir) < 0 ||
        std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0 ||
        std::snprintf(cancel_requested, sizeof(cancel_requested), "%s/cancel_requested.v1.json", response_dir) < 0 ||
        std::snprintf(diagnostics, sizeof(diagnostics), "%s/diagnostics.v1.json", response_dir) < 0 ||
        std::snprintf(diagnostics_dir, sizeof(diagnostics_dir), "%s/diagnostics", response_dir) < 0 ||
        std::snprintf(solver_diagnostics, sizeof(solver_diagnostics), "%s/solver.v1.json", diagnostics_dir) < 0 ||
        std::snprintf(periodic_pairs, sizeof(periodic_pairs), "%s/periodic_pairs.v1.json", mesh_dir) < 0) {
        std::snprintf(error_message, 128, "failed to format frequency response artifact paths");
        return FrequencyDomainStatus::artifact_error;
    }
    if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
        std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
        std::strlen(mesh_dir) >= sizeof(mesh_dir) - 1 ||
        std::strlen(frequency_points_dir) >= sizeof(frequency_points_dir) - 1 ||
        std::strlen(field_payloads_dir) >= sizeof(field_payloads_dir) - 1 ||
        std::strlen(field_payloads_zarr_dir) >= sizeof(field_payloads_zarr_dir) - 1 ||
        std::strlen(manifest) >= sizeof(manifest) - 1 ||
        std::strlen(sweep) >= sizeof(sweep) - 1 ||
        std::strlen(sweep_v2) >= sizeof(sweep_v2) - 1 ||
        std::strlen(progress) >= sizeof(progress) - 1 ||
        std::strlen(cancel_requested) >= sizeof(cancel_requested) - 1 ||
        std::strlen(diagnostics) >= sizeof(diagnostics) - 1 ||
        std::strlen(diagnostics_dir) >= sizeof(diagnostics_dir) - 1 ||
        std::strlen(solver_diagnostics) >= sizeof(solver_diagnostics) - 1 ||
        std::strlen(periodic_pairs) >= sizeof(periodic_pairs) - 1) {
        std::snprintf(error_message, 128, "frequency response artifact path exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    std::string manifest_json;
    std::string sweep_json;
    std::string sweep_v2_json;
    std::string progress_json;
    std::string cancel_requested_json;
    std::string diagnostics_json;
    std::string periodic_pairs_json;
    std::string points_json = "[";
    std::string frequency_point_paths_json = "[";
    std::string field_payload_resources_json = "[";
    std::string sweep_v2_point_paths_json = "[";
    std::string sweep_v2_payload_paths_json = "[";
    const bool production_cpu =
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu;
    const bool production_gpu =
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu;
    const bool production_lane = production_cpu || production_gpu;
    const char *requested_execution_lane = execution_lane_to_string(request.execution_lane);
    const char *revision = production_cpu ?
        "production-cpu-matrix-free-v1" :
        production_gpu ? "production-gpu-matrix-free-v1" : "validation-assembled-v1";
    const char *stage_id = production_cpu ?
        "frequency-response-production-cpu" :
        production_gpu ? "frequency-response-production-gpu" : "frequency-response-validation";
    const char *engine = production_cpu ?
        "native_fem_mfem_frequency_domain_cpu" :
        production_gpu ? "native_fem_mfem_frequency_domain_gpu" : "runner.dense_block_real_validation";
    const char *native_backend = production_lane ? "native_mfem_matrix_free" : "runner_validation";
    const char *reference_or_production = production_lane ? "production" : "reference";
    const char *solver_library = production_lane ? "native_gmres" : "nalgebra";
    const char *solver_model = production_lane ? "matrix_free_gmres" : "dense_block_real_lu";
    const char *solver_kind = production_lane ? "matrix_free_krylov_harmonic_response" : "assembled_validation_dense_block_real";
    const char *lane_classification = production_cpu ?
        "fem_cpu_production" :
        production_gpu ? "fem_gpu_production" : "fem_cpu_validation";
    const char *matrix_layout = production_lane ? "matrix_free_block_real" : "dense_block_real";
    const char *matrix_form =
        (request.requires_periodic_airbox_dynamic_demag ||
         request.requires_floquet_airbox_dynamic_demag) ?
        "coupled_demag_block" :
        "iomega_B_minus_L";
    const char *residual_source = production_lane ? "matrix_free_gmres" : "dense_block_real";
    const char *assembled_flag = production_lane ? "false" : "true";
    const char *dense_flag = production_lane ? "false" : "true";
    const char *production_solver_flag = production_lane ? "true" : "false";
    const char *gpu_operator_solver_field =
        production_gpu ? "\"gpu_operator_solver\":true," : "";
    const char *response_cancel_requested_path_json =
        interrupted_artifact ? "\"response/cancel_requested.v1.json\"" : "null";
    const char *response_cancel_requested_resource_json =
        interrupted_artifact
            ? "\"/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1\""
            : "null";
    const char *production_native_available = production_lane ? "true" : "false";
    const char *validation_artifact = production_lane ? "false" : "true";
    const double excitation_phase_rad = drive_global_phase_rad(
        request.mfem_validation_problem.drive_real,
        request.mfem_validation_problem.drive_imag,
        request.solve_request.operator_request.tangent_dof_count);
    const bool static_periodic_artifact =
        request.mfem_validation_problem.static_periodic_node_pair_count > 0 &&
        request.mfem_validation_problem.static_periodic_node_pairs != nullptr;
    const bool floquet_artifact =
        request.has_floquet_k_vector &&
        request.floquet_periodic_pair_count > 0 &&
        request.floquet_periodic_pairs != nullptr;
    const bool floquet_phase_projection_artifact =
        floquet_artifact && can_solve_floquet_projected_no_demag_response(request);
    const bool periodic_airbox_demag_tangent_artifact =
        request.requires_periodic_airbox_dynamic_demag &&
        has_mfem_demag_tangent_operator(request.mfem_validation_problem);
    const char *dynamic_demag_matrix_form =
        periodic_airbox_demag_tangent_artifact ? "magnetic_only" : "none";
    const bool write_periodic_pairs_artifact =
        static_periodic_artifact ||
        floquet_phase_projection_artifact ||
        periodic_airbox_demag_tangent_artifact;
    const char *periodic_pairs_artifact_json =
        write_periodic_pairs_artifact ? "\"mesh/periodic_pairs.v1.json\"" : "null";
    const char *spin_wave_bc_kind =
        periodic_airbox_demag_tangent_artifact
            ? "periodic"
            : floquet_artifact
            ? "floquet"
            : static_periodic_artifact
                ? "static_periodic"
                : "open";
    const char *demag_tangent_operator_source =
        mfem_demag_tangent_operator_source(request.mfem_validation_problem);
    const std::string operator_terms =
        included_operator_terms_json(request.mfem_validation_problem);
    const std::string domain_mesh_mode_field = domain_mesh_mode_json_field(request);
    const std::string domain_mesh_mode_diagnostics_json =
        domain_mesh_mode_field.empty()
            ? ""
            : domain_mesh_mode_field.substr(1) + ",";
    std::string periodic_airbox_physics_json;
    std::string periodic_airbox_diagnostics_json;
    std::string periodic_airbox_resolved_execution_json;
    std::string periodic_airbox_capabilities_json;
    if (periodic_airbox_demag_tangent_artifact) {
        if (!append_format(
                periodic_airbox_resolved_execution_json,
                error_message,
                "\"dynamic_demag_matrix_form\":\"%s\",",
                dynamic_demag_matrix_form) ||
            !append_format(
                periodic_airbox_capabilities_json,
                error_message,
                "\"dynamic_demag_matrix_form\":\"%s\",",
                dynamic_demag_matrix_form) ||
            !append_format(
                periodic_airbox_physics_json,
                error_message,
                ",\"requested_magnetic_bc\":\"periodic\","
                "\"resolved_magnetic_bc\":\"periodic\","
                "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu",
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_delta_m_tangent_dof_count),
                static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count)) ||
            !append_format(
                periodic_airbox_diagnostics_json,
                error_message,
                "\"periodic_airbox_coupled_block_solver\":false,"
                "\"mfem_coupled_block_assembly\":false,"
                "\"dynamic_demag_matrix_form\":\"%s\","
                "\"requested_magnetic_bc\":\"periodic\","
                "\"resolved_magnetic_bc\":\"periodic\","
                "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,",
                dynamic_demag_matrix_form,
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_delta_m_tangent_dof_count),
                static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count))) {
            return FrequencyDomainStatus::artifact_error;
        }
    }
    const bool periodic_airbox_dynamic_demag_artifact =
        request.requires_periodic_airbox_dynamic_demag;
    const char *requested_magnetostatic_bc =
        periodic_airbox_dynamic_demag_artifact ? "periodic_airbox_k0" : "open";
    const char *resolved_magnetostatic_bc = requested_magnetostatic_bc;
    std::string periodic_airbox_point_metadata_json;
    if (periodic_airbox_dynamic_demag_artifact) {
        if (!append_format(
                periodic_airbox_point_metadata_json,
                error_message,
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,",
                requested_magnetostatic_bc,
                resolved_magnetostatic_bc,
                static_cast<unsigned long long>(
                    request.periodic_airbox_delta_m_tangent_dof_count),
                static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count))) {
            return FrequencyDomainStatus::artifact_error;
        }
    }
    std::vector<std::uint64_t> artifact_static_periodic_representative_node;
    std::vector<std::uint64_t> artifact_static_periodic_representative_count;
    double artifact_static_periodic_frame_mismatch = 0.0;
    double artifact_static_periodic_drive_mismatch = 0.0;
    if (request.mfem_validation_problem.static_periodic_node_pair_count > 0 &&
        request.mfem_validation_problem.static_periodic_node_pairs != nullptr) {
        char periodic_diagnostics_error[128]{};
        if (build_static_periodic_representatives(
                request.mfem_validation_problem,
                artifact_static_periodic_representative_node,
                artifact_static_periodic_representative_count,
                periodic_diagnostics_error)) {
            artifact_static_periodic_frame_mismatch =
                max_static_periodic_frame_mismatch(
                    artifact_static_periodic_representative_node,
                    request.mfem_validation_problem);
            artifact_static_periodic_drive_mismatch =
                max_static_periodic_tangent_mismatch(
                    artifact_static_periodic_representative_node,
                    request.mfem_validation_problem.drive_real);
            if (request.mfem_validation_problem.drive_imag != nullptr) {
                artifact_static_periodic_drive_mismatch = std::max(
                    artifact_static_periodic_drive_mismatch,
                    max_static_periodic_tangent_mismatch(
                        artifact_static_periodic_representative_node,
                        request.mfem_validation_problem.drive_imag));
            }
        }
    }
    const double artifact_floquet_tangent_frame_mismatch =
        floquet_phase_projection_artifact ?
        max_floquet_tangent_frame_mismatch(request) :
        0.0;
    const double artifact_floquet_tangent_transport_max_nonunitarity = 0.0;
    const char *basis_transport_policy =
        (static_periodic_artifact ||
         floquet_phase_projection_artifact ||
         periodic_airbox_demag_tangent_artifact)
            ? "tangent_frame_identity"
            : "full_vector";
    if (static_periodic_artifact) {
        periodic_pairs_json =
            "{\"schema_version\":\"periodic_pairs.v1\","
            "\"source\":\"native_fem_frequency_domain_static_periodic\","
            "\"validation_status\":\"ok\",";
        if (!append_format(
            periodic_pairs_json,
            error_message,
            "\"pair_count\":%llu,"
            "\"paired_node_count\":%llu,"
            "\"unpaired_source_count\":0,"
            "\"unpaired_destination_count\":0,"
            "\"tolerance_m\":0.0,"
            "\"max_translation_residual_m\":0.0,"
            "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0,"
            "\"static_periodic_frame_max_mismatch\":%.17g,"
            "\"static_periodic_drive_max_mismatch\":%.17g},"
            "\"pairs\":[",
            static_cast<unsigned long long>(
                request.mfem_validation_problem.static_periodic_node_pair_count),
            static_cast<unsigned long long>(
                request.mfem_validation_problem.static_periodic_node_pair_count * 2),
            artifact_static_periodic_frame_mismatch,
            artifact_static_periodic_drive_mismatch)) {
            return FrequencyDomainStatus::artifact_error;
        }
        for (std::uint64_t pair_index = 0;
             pair_index < request.mfem_validation_problem.static_periodic_node_pair_count;
             ++pair_index) {
            const std::uint64_t node_a =
                request.mfem_validation_problem.static_periodic_node_pairs[pair_index * 2];
            const std::uint64_t node_b =
                request.mfem_validation_problem.static_periodic_node_pairs[pair_index * 2 + 1];
            if (!append_format(
                periodic_pairs_json,
                error_message,
                "%s{\"pair_id\":\"static-periodic-%04llu\","
                "\"source_marker\":\"node:%llu\","
                "\"destination_marker\":\"node:%llu\","
                "\"node_a\":%llu,"
                "\"node_b\":%llu,"
                "\"expected_translation_m\":[0.0,0.0,0.0],"
                "\"translation_m\":[0.0,0.0,0.0],"
                "\"paired_node_count\":2,"
                "\"unpaired_source_count\":0,"
                "\"unpaired_destination_count\":0,"
                "\"translation_residual_m\":0.0,"
                "\"phase_rad\":0.0,"
                "\"validation_status\":\"ok\"}",
                pair_index == 0 ? "" : ",",
                static_cast<unsigned long long>(pair_index),
                static_cast<unsigned long long>(node_a),
                static_cast<unsigned long long>(node_b),
                static_cast<unsigned long long>(node_a),
                static_cast<unsigned long long>(node_b))) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
        periodic_pairs_json += "]}";
    } else if (floquet_phase_projection_artifact) {
        periodic_pairs_json =
            "{\"schema_version\":\"periodic_pairs.v1\","
            "\"source\":\"native_fem_frequency_domain_floquet_phase_projection\","
            "\"validation_status\":\"ok\",";
        if (!append_format(
            periodic_pairs_json,
            error_message,
            "\"pair_count\":%llu,"
            "\"paired_node_count\":%llu,"
            "\"unpaired_source_count\":0,"
            "\"unpaired_destination_count\":0,"
            "\"tolerance_m\":0.0,"
            "\"max_translation_residual_m\":0.0,"
            "\"basis_transport_policy\":\"%s\","
            "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0,"
            "\"floquet_phase_loop_max_residual\":0.0,"
            "\"floquet_tangent_frame_max_mismatch\":%.17g,"
            "\"floquet_tangent_transport_max_nonunitarity\":%.17g},"
            "\"pairs\":[",
            static_cast<unsigned long long>(request.floquet_periodic_pair_count),
            static_cast<unsigned long long>(request.floquet_periodic_pair_count * 2),
            basis_transport_policy,
            artifact_floquet_tangent_frame_mismatch,
            artifact_floquet_tangent_transport_max_nonunitarity)) {
            return FrequencyDomainStatus::artifact_error;
        }
        for (std::uint64_t pair_index = 0;
             pair_index < request.floquet_periodic_pair_count;
             ++pair_index) {
            const FrequencyDomainFloquetPeriodicPair &pair =
                request.floquet_periodic_pairs[pair_index];
            const char *pair_id = pair.pair_id != nullptr && pair.pair_id[0] != '\0'
                ? pair.pair_id
                : "floquet-periodic";
            if (!append_format(
                periodic_pairs_json,
                error_message,
                "%s{\"pair_id\":\"%s\","
                "\"source_marker\":\"node:%llu\","
                "\"destination_marker\":\"node:%llu\","
                "\"node_a\":%llu,"
                "\"node_b\":%llu,"
                "\"expected_translation_m\":[%.17g,%.17g,%.17g],"
                "\"translation_m\":[%.17g,%.17g,%.17g],"
                "\"paired_node_count\":2,"
                "\"unpaired_source_count\":0,"
                "\"unpaired_destination_count\":0,"
                "\"translation_residual_m\":0.0,"
                "\"phase_rad\":%.17g,"
                "\"basis_transport_policy\":\"%s\","
                "\"validation_status\":\"ok\"}",
                pair_index == 0 ? "" : ",",
                pair_id,
                static_cast<unsigned long long>(pair.node_a),
                static_cast<unsigned long long>(pair.node_b),
                static_cast<unsigned long long>(pair.node_a),
                static_cast<unsigned long long>(pair.node_b),
                pair.translation_m[0],
                pair.translation_m[1],
                pair.translation_m[2],
                pair.translation_m[0],
                pair.translation_m[1],
                pair.translation_m[2],
                pair.phase_rad,
                basis_transport_policy)) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
        periodic_pairs_json += "]}";
    } else if (periodic_airbox_demag_tangent_artifact) {
        periodic_pairs_json =
            "{\"schema_version\":\"periodic_pairs.v1\","
            "\"source\":\"native_fem_frequency_domain_demag_tangent_provider\","
            "\"validation_status\":\"metadata_only\",";
        if (!append_format(
                periodic_pairs_json,
                error_message,
                "\"pair_count\":%llu,"
                "\"paired_node_count\":%llu,"
                "\"unpaired_source_count\":0,"
                "\"unpaired_destination_count\":0,"
                "\"tolerance_m\":0.0,"
                "\"max_translation_residual_m\":0.0,"
                "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0},"
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"pairs\":[",
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count * 2),
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(
                    request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count))) {
            return FrequencyDomainStatus::artifact_error;
        }
        for (std::uint64_t pair_index = 0;
             pair_index < request.periodic_airbox_magnetostatic_periodic_node_pair_count;
             ++pair_index) {
            const std::uint64_t node_a =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2];
            const std::uint64_t node_b =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2 + 1];
            if (!append_format(
                    periodic_pairs_json,
                    error_message,
                    "%s{\"pair_id\":\"magnetostatic-delta-phi-%04llu\","
                    "\"pair_family\":\"magnetostatic_delta_phi\","
                    "\"unknown_family\":\"delta_phi\","
                    "\"source_marker\":\"delta_phi_node:%llu\","
                    "\"destination_marker\":\"delta_phi_node:%llu\","
                    "\"node_a\":%llu,"
                    "\"node_b\":%llu,"
                    "\"expected_translation_m\":[0.0,0.0,0.0],"
                    "\"translation_m\":[0.0,0.0,0.0],"
                    "\"paired_node_count\":2,"
                    "\"unpaired_source_count\":0,"
                    "\"unpaired_destination_count\":0,"
                    "\"translation_residual_m\":0.0,"
                    "\"phase_rad\":0.0,"
                    "\"phase_convention\":\"zero_phase_periodic_airbox_k0\","
                    "\"validation_status\":\"metadata_only\"}",
                    pair_index == 0 ? "" : ",",
                    static_cast<unsigned long long>(pair_index),
                    static_cast<unsigned long long>(node_a),
                    static_cast<unsigned long long>(node_b),
                    static_cast<unsigned long long>(node_a),
                    static_cast<unsigned long long>(node_b))) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
        periodic_pairs_json += "]}";
    }
    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point_path[96]{};
        char field_payload_path[96]{};
        char tangent_field_payload_path[96]{};
        char field_payload_path_json[128]{};
        char tangent_field_payload_path_json[128]{};
        char compatibility_field_payload_path_json[128]{};
        char storage_metadata_json[512]{};
        char sweep_reuse_json[256]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "response/frequency_points/frequency_%04llu.json",
            static_cast<unsigned long long>(frequency_index));
        int payload_path_written = 0;
        int tangent_payload_path_written = 0;
        int payload_path_json_written = std::snprintf(field_payload_path_json, sizeof(field_payload_path_json), "null");
        int tangent_payload_path_json_written =
            std::snprintf(tangent_field_payload_path_json, sizeof(tangent_field_payload_path_json), "null");
        int compatibility_payload_path_json_written =
            std::snprintf(compatibility_field_payload_path_json, sizeof(compatibility_field_payload_path_json), "null");
        int storage_metadata_written =
            std::snprintf(storage_metadata_json, sizeof(storage_metadata_json), "\"storage_format\":null");
        if (write_field_payloads) {
            payload_path_written = std::snprintf(
                field_payload_path,
                sizeof(field_payload_path),
                write_spatial_field_payloads ?
                    "response/field_payloads.zarr/frequency_%04llu/vector_xyz_complex/0.0.0" :
                    "response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0",
                static_cast<unsigned long long>(frequency_index));
            if (payload_path_written >= 0 &&
                static_cast<std::size_t>(payload_path_written) < sizeof(field_payload_path)) {
                payload_path_json_written = std::snprintf(
                    field_payload_path_json,
                    sizeof(field_payload_path_json),
                    "\"%s\"",
                    field_payload_path);
            }
            tangent_payload_path_written = std::snprintf(
                tangent_field_payload_path,
                sizeof(tangent_field_payload_path),
                "response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0",
                static_cast<unsigned long long>(frequency_index));
            if (tangent_payload_path_written >= 0 &&
                static_cast<std::size_t>(tangent_payload_path_written) < sizeof(tangent_field_payload_path)) {
                tangent_payload_path_json_written = std::snprintf(
                    tangent_field_payload_path_json,
                    sizeof(tangent_field_payload_path_json),
                    "\"%s\"",
                    tangent_field_payload_path);
            }
            compatibility_payload_path_json_written = std::snprintf(
                compatibility_field_payload_path_json,
                sizeof(compatibility_field_payload_path_json),
                write_spatial_field_payloads ?
                    "\"response/field_payloads/frequency_%04llu/vector_xyz.bin\"" :
                    "\"response/field_payloads/frequency_%04llu/vector.bin\"",
                static_cast<unsigned long long>(frequency_index));
            storage_metadata_written = std::snprintf(
                storage_metadata_json,
                sizeof(storage_metadata_json),
                "\"storage_format\":\"zarr\","
                "\"zarr_store_path\":\"response/field_payloads.zarr\","
                "\"zarr_array_path\":\"response/field_payloads.zarr/frequency_%04llu/%s\","
                "\"zarr_chunk_path\":%s,"
                "\"zarr_dtype\":\"<f8\","
                "\"zarr_shape\":[%llu,%u,2],"
                "\"zarr_chunk_shape\":[%llu,%u,2],"
                "\"zarr_compressor\":null,"
                "\"compatibility_binary_payload_path\":%s",
                static_cast<unsigned long long>(frequency_index),
                write_spatial_field_payloads ? "vector_xyz_complex" : "vector_tangent_complex",
                field_payload_path_json,
                static_cast<unsigned long long>(
                    write_spatial_field_payloads ?
                        request.mfem_validation_problem.descriptor.node_count :
                        validation_result.response_dof_count / 2),
                write_spatial_field_payloads ? 3u : 2u,
                static_cast<unsigned long long>(
                    write_spatial_field_payloads ?
                        request.mfem_validation_problem.descriptor.node_count :
                        validation_result.response_dof_count / 2),
                write_spatial_field_payloads ? 3u : 2u,
                compatibility_field_payload_path_json);
        }
        const int sweep_reuse_written =
            frequency_index == 0 ?
                std::snprintf(
                    sweep_reuse_json,
                    sizeof(sweep_reuse_json),
                    "{\"operator_template_reused\":true,\"warm_start\":null}") :
                std::snprintf(
                    sweep_reuse_json,
                    sizeof(sweep_reuse_json),
                    "{\"operator_template_reused\":true,"
                    "\"warm_start\":{\"kind\":\"previous_frequency_response\","
                    "\"source_frequency_rad_per_s\":%.17g,"
                    "\"residual_l2_norm\":null,"
                    "\"relative_residual_l2_norm\":null}}",
                    request.solve_request.frequencies_hz[frequency_index - 1] *
                        6.28318530717958647692);
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            payload_path_json_written < 0 ||
            static_cast<std::size_t>(payload_path_json_written) >= sizeof(field_payload_path_json) ||
            tangent_payload_path_json_written < 0 ||
            static_cast<std::size_t>(tangent_payload_path_json_written) >= sizeof(tangent_field_payload_path_json) ||
            compatibility_payload_path_json_written < 0 ||
            static_cast<std::size_t>(compatibility_payload_path_json_written) >= sizeof(compatibility_field_payload_path_json) ||
            storage_metadata_written < 0 ||
            static_cast<std::size_t>(storage_metadata_written) >= sizeof(storage_metadata_json) ||
            sweep_reuse_written < 0 ||
            static_cast<std::size_t>(sweep_reuse_written) >= sizeof(sweep_reuse_json) ||
            (write_field_payloads &&
                (payload_path_written < 0 ||
                    static_cast<std::size_t>(payload_path_written) >= sizeof(field_payload_path) ||
                    tangent_payload_path_written < 0 ||
                    static_cast<std::size_t>(tangent_payload_path_written) >= sizeof(tangent_field_payload_path)))) {
            std::snprintf(error_message, 128, "failed to format response point identity paths");
            return FrequencyDomainStatus::artifact_error;
        }
        const double angular_frequency_rad_per_s =
            request.solve_request.frequencies_hz[frequency_index] * 6.28318530717958647692;
        const double *point_response_real =
            response_real + frequency_index * validation_result.response_dof_count;
        const double *point_response_imag =
            response_imag + frequency_index * validation_result.response_dof_count;
        ResponsePointSeriesJson series{};
        if (!build_response_point_series_json(
                point_response_real,
                point_response_imag,
                validation_result.response_dof_count,
                series,
                error_message)) {
            return FrequencyDomainStatus::artifact_error;
        }
        const ResponsePointObservableJson observables = build_response_point_observable_json(
            point_response_real,
            point_response_imag,
            request.mfem_validation_problem.drive_real,
            request.mfem_validation_problem.drive_imag,
            validation_result.response_dof_count,
            angular_frequency_rad_per_s,
            request.mfem_validation_problem.observable_ms_field,
            request.mfem_validation_problem.observable_ms_field_len,
            request.mfem_validation_problem.observable_uniform_ms);

        if (!append_format(
            points_json,
            error_message,
            "%s{\"frequency_index\":%llu,"
            "\"frequency_point_artifact_path\":\"%s\","
            "\"response_field_payload_path\":%s,"
            "\"response_tangent_field_payload_path\":%s,"
            "%s,"
            "\"frequency_hz\":%.17g,"
            "\"angular_frequency_rad_per_s\":%.17g,"
            "\"m_complex\":%s,"
            "\"response_amplitude\":%.17g,"
            "\"response_phase\":%.17g,"
            "\"phase_rad\":%.17g,"
            "\"component_response_amplitude\":%s,"
            "\"component_response_phase\":%s,"
            "%s"
            "\"susceptibility_tensor\":%s,"
            "\"susceptibility_tensor_provenance\":%s,"
            "\"absorbed_power_density\":%.17g,"
            "\"absorbed_power_density_provenance\":%s,"
            "\"residual_l2_norm\":%.17g,"
            "\"relative_residual_l2_norm\":%.17g,"
            "\"residual_source\":\"%s\","
            "\"tangent_leakage\":%s,"
            "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
            "\"sweep_reuse\":%s}",
            frequency_index == 0 ? "" : ",",
            static_cast<unsigned long long>(frequency_index),
            frequency_point_path,
            field_payload_path_json,
            tangent_field_payload_path_json,
            storage_metadata_json,
            request.solve_request.frequencies_hz[frequency_index],
            angular_frequency_rad_per_s,
            series.m_complex.c_str(),
            series.response_amplitude,
            series.response_phase,
            series.response_phase,
            series.component_amplitude.c_str(),
            series.component_phase.c_str(),
            periodic_airbox_point_metadata_json.c_str(),
            observables.susceptibility_tensor.c_str(),
            observables.susceptibility_provenance.c_str(),
            observables.absorbed_power_density,
            observables.absorbed_power_density_provenance.c_str(),
            residual_l2_norm[frequency_index],
            relative_residual_l2_norm[frequency_index],
            residual_source,
            observables.tangent_leakage.c_str(),
            excitation_phase_rad,
            sweep_reuse_json)) {
            return FrequencyDomainStatus::artifact_error;
        }
    }
    points_json += "]";

    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point_path[96]{};
        char field_payload_path[96]{};
        char tangent_field_payload_path[96]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "response/frequency_points/frequency_%04llu.json",
            static_cast<unsigned long long>(frequency_index));
        int payload_path_written = 0;
        int tangent_payload_path_written = 0;
        if (write_field_payloads) {
            payload_path_written = std::snprintf(
                field_payload_path,
                sizeof(field_payload_path),
                write_spatial_field_payloads ?
                    "response/field_payloads.zarr/frequency_%04llu/vector_xyz_complex/0.0.0" :
                    "response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0",
                static_cast<unsigned long long>(frequency_index));
            tangent_payload_path_written = std::snprintf(
                tangent_field_payload_path,
                sizeof(tangent_field_payload_path),
                "response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0",
                static_cast<unsigned long long>(frequency_index));
        }
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            (write_field_payloads &&
                (payload_path_written < 0 ||
                    static_cast<std::size_t>(payload_path_written) >= sizeof(field_payload_path) ||
                    tangent_payload_path_written < 0 ||
                    static_cast<std::size_t>(tangent_payload_path_written) >= sizeof(tangent_field_payload_path)))) {
            std::snprintf(error_message, 128, "failed to format response artifact relative paths");
            return FrequencyDomainStatus::artifact_error;
        }
        if (!append_format(
            frequency_point_paths_json,
            error_message,
            "%s\"%s\"",
            frequency_index == 0 ? "" : ",",
            frequency_point_path) ||
            !append_format(
                sweep_v2_point_paths_json,
                error_message,
            "%s\"%s\"",
            frequency_index == 0 ? "" : ",",
                frequency_point_path)) {
            return FrequencyDomainStatus::artifact_error;
        }
        if (write_field_payloads) {
            if (!append_format(
                field_payload_resources_json,
                error_message,
                "%s{\"frequency_index\":%llu,"
                "\"field_resource_id\":\"analysis:frequency-response:frequency-%04llu\","
                "\"storage_format\":\"zarr\","
                "\"payload_path\":\"%s\"}",
                frequency_index == 0 ? "" : ",",
                static_cast<unsigned long long>(frequency_index),
                static_cast<unsigned long long>(frequency_index),
                field_payload_path) ||
                !append_format(
                    sweep_v2_payload_paths_json,
                    error_message,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                    field_payload_path)) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
    }
    frequency_point_paths_json += "]";
    field_payload_resources_json += "]";
    sweep_v2_point_paths_json += "]";
    sweep_v2_payload_paths_json += "]";

    if (!append_format(
        manifest_json,
        error_message,
        "{\"schema_version\":\"frequency_domain_manifest.v1\","
        "\"analysis_family\":\"magnetic_frequency_domain\","
        "\"study_product\":\"driven_response\","
        "\"revision\":\"%s\","
        "\"created_at\":\"1970-01-01T00:00:00Z\","
        "\"session_id\":\"native-validation\","
        "\"run_id\":\"native-validation\","
        "\"stage_id\":\"%s\","
        "\"stage_kind\":\"frequency_response\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"requested_execution\":{\"solve_equation\":\"(i omega B - L) q = f\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"study_kind\":\"frequency_response\","
        "\"frequency_count\":%llu,"
        "\"write_response_fields\":%s},"
        "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
        "\"engine\":\"%s\","
        "\"native_backend\":\"%s\","
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"%s\","
        "\"reference_or_production\":\"%s\","
        "\"solver_library\":\"%s\","
        "\"solver_model\":\"%s\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"solver_kind\":\"%s\","
        "\"lane_classification\":\"%s\","
        "%s"
        "\"production_solver\":%s},"
        "\"physics\":{\"analysis_family\":\"frequency_domain\","
        "\"llg_gamma0_si\":%.17g,"
        "\"llg_alpha\":%.17g,"
        "\"phase_convention\":\"%s\","
        "\"frequency_units\":\"Hz\","
        "\"field_units\":\"A_per_m\","
        "\"normalization\":\"linear_response_tangent\","
        "\"spin_wave_bc\":{\"kind\":\"%s\"},"
        "\"periodic_or_floquet\":%s%s},"
        "\"artifacts\":{\"response_sweep_v1_path\":\"response/magnetic_response_sweep.v1.json\","
        "\"response_sweep_v2_path\":\"response/magnetic_response_sweep.v2.json\","
        "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
        "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
        "\"response_progress_v1_path\":\"response/progress.v1.json\","
        "\"response_cancel_requested_v1_path\":%s,"
        "\"response_map_v1_path\":null,"
        "\"response_map_v2_path\":null,"
        "\"periodic_pairs_v1_path\":%s,"
        "\"frequency_point_paths\":%s},"
        "\"resources\":{\"response_sweep_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep\","
        "\"response_progress_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/progress.v1\","
        "\"response_diagnostics_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1\","
        "\"response_cancel_requested_resource_key\":%s,"
        "\"response_map_resource_key\":null,"
        "\"response_field_resources\":%s},"
        "\"diagnostics\":{\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"assembled_mfem_operator_solver\":%s,"
        "\"matrix_free_solver\":%s,"
        "%s"
        "\"demag_tangent_operator_source\":\"%s\","
        "\"demag_tangent_linearity_check\":%s,"
        "\"demag_tangent_additivity_max_abs_error\":%.17g,"
        "\"demag_tangent_homogeneity_max_abs_error\":%.17g,"
        "\"demag_tangent_additivity_relative_error\":%.17g,"
        "\"demag_tangent_homogeneity_relative_error\":%.17g,"
        "%s"
        "%s"
        "\"operator_terms_included\":%s,"
        "\"exchange_edge_count\":%llu,"
        "\"static_periodic_projection\":%s,"
        "\"floquet_phase_projection\":%s,"
        "\"floquet_real_imag_mixing\":%s,"
        "\"basis_transport_policy\":\"%s\","
        "\"floquet_tangent_frame_max_mismatch\":%.17g,"
        "\"floquet_tangent_transport_max_nonunitarity\":%.17g,"
        "\"floquet_periodic_pair_count\":%llu,"
        "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"point_count\":%llu,"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"total_iteration_count\":%llu,"
        "\"max_iterations_for_frequency\":%llu,"
        "\"restart_iterations_for_frequency\":%llu,"
        "\"progress_interval_iterations\":%llu,"
        "\"solver_relative_tolerance\":%.17g,"
        "\"rhs_l2_norm\":%.17g,"
        "\"initial_residual_l2_norm\":%.17g,"
        "\"initial_relative_residual_l2_norm\":%.17g,"
        "\"minimum_tracked_relative_residual_l2_norm\":%.17g,"
        "\"minimum_tracked_relative_residual_iteration\":%llu,"
        "\"last_tracked_relative_residual_l2_norm\":%.17g,"
        "\"last_recomputed_relative_residual_l2_norm\":%.17g,"
        "\"residual_growth_factor\":%.17g,"
        "\"krylov_preconditioner_kind\":\"%s\","
        "\"krylov_preconditioner_applied\":%s,"
        "\"krylov_preconditioner_setup_status\":\"%s\","
        "\"gmres_relative_residual_history\":%s,"
        "\"block_norms\":{\"rhs_real_l2_norm\":%.17g,"
        "\"rhs_imag_l2_norm\":%.17g,"
        "\"residual_real_l2_norm\":%.17g,"
        "\"residual_imag_l2_norm\":%.17g,"
        "\"response_real_l2_norm\":%.17g,"
        "\"response_imag_l2_norm\":%.17g},"
        "%s"
        "\"max_abs_response\":%.17g},"
        "\"capabilities\":{\"validation_solver_available\":true,"
        "\"production_solver_available\":%s,"
        "\"production_native_solver_available\":%s,"
        "\"validation_artifact\":%s,"
        "%s"
        "\"dynamic_demag_k_available\":false,"
        "\"floquet_response_available\":false,"
        "\"gpu_available\":%s}}",
        revision,
        stage_id,
        artifact_status,
        complete ? "true" : "false",
        static_cast<unsigned long long>(request.solve_request.frequency_count),
        request.solve_request.write_response_fields ? "true" : "false",
        engine,
        native_backend,
        requested_execution_lane,
        requested_execution_lane,
        reference_or_production,
        solver_library,
        solver_model,
        solver_kind,
        lane_classification,
        periodic_airbox_resolved_execution_json.c_str(),
        production_solver_flag,
        request.solve_request.operator_request.gamma0,
        request.solve_request.operator_request.alpha,
        phase_convention_to_string(request.phase_convention),
        spin_wave_bc_kind,
        (static_periodic_artifact || floquet_artifact || periodic_airbox_demag_tangent_artifact)
            ? "true"
            : "false",
        periodic_airbox_physics_json.c_str(),
        response_cancel_requested_path_json,
        periodic_pairs_artifact_json,
        frequency_point_paths_json.c_str(),
        response_cancel_requested_resource_json,
        field_payload_resources_json.c_str(),
        requested_execution_lane,
        requested_execution_lane,
        assembled_flag,
        production_lane ? "true" : "false",
        gpu_operator_solver_field,
        demag_tangent_operator_source,
        validation_result.demag_tangent_linearity_check ? "true" : "false",
        validation_result.demag_tangent_additivity_max_abs_error,
        validation_result.demag_tangent_homogeneity_max_abs_error,
        validation_result.demag_tangent_additivity_relative_error,
        validation_result.demag_tangent_homogeneity_relative_error,
        periodic_airbox_diagnostics_json.c_str(),
        domain_mesh_mode_diagnostics_json.c_str(),
        operator_terms.c_str(),
        static_cast<unsigned long long>(
            request.mfem_validation_problem.exchange_edge_count),
        static_periodic_artifact ? "true" : "false",
        floquet_phase_projection_artifact ? "true" : "false",
        floquet_phase_projection_artifact ? "true" : "false",
        basis_transport_policy,
        artifact_floquet_tangent_frame_mismatch,
        artifact_floquet_tangent_transport_max_nonunitarity,
        static_cast<unsigned long long>(request.floquet_periodic_pair_count),
        request.floquet_k_vector_rad_per_m[0],
        request.floquet_k_vector_rad_per_m[1],
        request.floquet_k_vector_rad_per_m[2],
        static_cast<unsigned long long>(
            request.mfem_validation_problem.static_periodic_node_pair_count),
        artifact_static_periodic_frame_mismatch,
        artifact_static_periodic_drive_mismatch,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.total_iteration_count),
        static_cast<unsigned long long>(validation_result.max_iterations_for_frequency),
        static_cast<unsigned long long>(validation_result.restart_iterations_for_frequency),
        static_cast<unsigned long long>(validation_result.progress_interval_iterations),
        validation_result.solver_relative_tolerance,
        validation_result.rhs_l2_norm,
        validation_result.initial_residual_l2_norm,
        validation_result.initial_relative_residual_l2_norm,
        validation_result.minimum_tracked_relative_residual_l2_norm,
        static_cast<unsigned long long>(
            validation_result.minimum_tracked_relative_residual_iteration),
        validation_result.last_tracked_relative_residual_l2_norm,
        validation_result.last_recomputed_relative_residual_l2_norm,
        validation_result.residual_growth_factor,
        validation_result.krylov_preconditioner,
        validation_result.right_preconditioner_applied ? "true" : "false",
        preconditioner_setup_status(validation_result),
        gmres_history_json.c_str(),
        validation_result.rhs_real_l2_norm,
        validation_result.rhs_imag_l2_norm,
        validation_result.residual_real_l2_norm,
        validation_result.residual_imag_l2_norm,
        validation_result.response_real_l2_norm,
        validation_result.response_imag_l2_norm,
        coupled_block_norms_json.c_str(),
        validation_result.max_abs_response,
        production_solver_flag,
        production_native_available,
        validation_artifact,
        periodic_airbox_capabilities_json.c_str(),
        production_gpu ? "true" : "false") ||
        !append_format(
        sweep_json,
        error_message,
        "{\"schema_version\":\"magnetic_response_sweep.v1\","
        "\"backend_engine_id\":\"native_fem_mfem\","
        "\"solver_model\":\"%s\","
        "\"damping_policy\":\"linearized_llg_tangent\","
        "\"lane_classification\":\"%s\","
        "\"matrix_layout\":\"%s\","
        "\"excitation_kind\":\"uniform_field\","
        "\"si_units\":{\"frequency\":\"Hz\",\"angular_frequency\":\"rad/s\"},"
        "\"point_count\":%llu,"
        "\"points\":%s}",
        solver_model,
        lane_classification,
        matrix_layout,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
            points_json.c_str())) {
        return FrequencyDomainStatus::artifact_error;
    }
    const char *first_payload_path_json = "null";
    if (write_field_payloads && validation_result.completed_frequency_count > 0) {
        first_payload_path_json = write_spatial_field_payloads ?
            "\"response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0\"" :
            "\"response/field_payloads.zarr/frequency_0000/vector_tangent_complex/0.0.0\"";
    }
    char current_frequency_hz_json[64]{};
    const bool solve_error_artifact =
        !complete &&
        incomplete_status != nullptr &&
        std::strcmp(incomplete_status, "solve_error") == 0;
    if (request.solve_request.frequencies_hz != nullptr &&
        request.solve_request.frequency_count > 0 &&
        (validation_result.completed_frequency_count > 0 || solve_error_artifact)) {
        const std::uint64_t max_index = request.solve_request.frequency_count - 1;
        const std::uint64_t requested_index =
            solve_error_artifact
                ? validation_result.completed_frequency_count
                : validation_result.completed_frequency_count - 1;
        const std::uint64_t frequency_index =
            requested_index < max_index ? requested_index : max_index;
        std::snprintf(
            current_frequency_hz_json,
            sizeof(current_frequency_hz_json),
            "%.17g",
            request.solve_request.frequencies_hz[frequency_index]);
    } else {
        std::snprintf(current_frequency_hz_json, sizeof(current_frequency_hz_json), "null");
    }
    if (interrupted_artifact &&
        !append_sweep_progress_artifact_json(
            cancel_requested_json,
            error_message,
            "cancel_requested",
            false,
            "cancel_requested",
            request.solve_request.frequency_count,
            validation_result.completed_frequency_count,
            validation_result.completed_frequency_count,
            current_frequency_hz_json,
            partial_artifacts_available,
            "frequency_domain/manifest.v1.json")) {
        return FrequencyDomainStatus::artifact_error;
    }
    if (!append_format(
        sweep_v2_json,
        error_message,
        "{\"schema_version\":\"magnetic_response_sweep.v2\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"complete\":%s,"
        "\"completed_frequency_point_count\":%llu,"
        "\"point_count\":%llu,"
        "\"frequency_point_artifact_path\":\"response/frequency_points/frequency_0000.json\","
        "\"response_field_payload_path\":%s,"
        "\"frequency_point_artifact_paths\":%s,"
        "\"response_field_payload_paths\":%s,"
        "\"points\":%s}",
        complete ? "true" : "false",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        first_payload_path_json,
        sweep_v2_point_paths_json.c_str(),
        sweep_v2_payload_paths_json.c_str(),
        points_json.c_str()) ||
        !append_sweep_progress_artifact_json(
        progress_json,
        error_message,
        artifact_status,
        complete,
        progress_state,
        request.solve_request.frequency_count,
        validation_result.completed_frequency_count,
        validation_result.completed_frequency_count,
        current_frequency_hz_json,
        partial_artifacts_available,
        "frequency_domain/manifest.v1.json") ||
        !append_format(
        diagnostics_json,
        error_message,
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"matrix_form\":\"%s\","
        "\"phasor_convention\":\"%s\","
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"assembled_mfem_operator_solver\":%s,"
        "\"dense_block_real_solver\":%s,"
        "\"matrix_free_solver\":%s,"
        "%s"
        "\"demag_tangent_operator_source\":\"%s\","
        "\"demag_tangent_linearity_check\":%s,"
        "\"demag_tangent_additivity_max_abs_error\":%.17g,"
        "\"demag_tangent_homogeneity_max_abs_error\":%.17g,"
        "\"demag_tangent_additivity_relative_error\":%.17g,"
        "\"demag_tangent_homogeneity_relative_error\":%.17g,"
        "%s"
        "\"krylov_solver\":\"%s\","
        "\"krylov_preconditioner_kind\":\"%s\","
        "\"krylov_preconditioner_applied\":%s,"
        "\"krylov_preconditioner_setup_status\":\"%s\","
        "\"gmres_relative_residual_history\":%s,"
        "\"block_norms\":{\"rhs_real_l2_norm\":%.17g,"
        "\"rhs_imag_l2_norm\":%.17g,"
        "\"residual_real_l2_norm\":%.17g,"
        "\"residual_imag_l2_norm\":%.17g,"
        "\"response_real_l2_norm\":%.17g,"
        "\"response_imag_l2_norm\":%.17g},"
        "%s"
        "%s"
        "\"operator_terms_included\":%s,"
        "\"exchange_edge_count\":%llu,"
        "\"static_periodic_projection\":%s,"
        "\"floquet_phase_projection\":%s,"
        "\"floquet_real_imag_mixing\":%s,"
        "\"basis_transport_policy\":\"%s\","
        "\"floquet_tangent_frame_max_mismatch\":%.17g,"
        "\"floquet_tangent_transport_max_nonunitarity\":%.17g,"
        "\"floquet_periodic_pair_count\":%llu,"
        "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"completed_frequency_point_count\":%llu,"
        "\"total_iteration_count\":%llu,"
        "\"max_iterations_for_frequency\":%llu,"
        "\"restart_iterations_for_frequency\":%llu,"
        "\"progress_interval_iterations\":%llu,"
        "\"solver_relative_tolerance\":%.17g,"
        "\"rhs_l2_norm\":%.17g,"
        "\"initial_residual_l2_norm\":%.17g,"
        "\"initial_relative_residual_l2_norm\":%.17g,"
        "\"minimum_tracked_relative_residual_l2_norm\":%.17g,"
        "\"minimum_tracked_relative_residual_iteration\":%llu,"
        "\"last_tracked_relative_residual_l2_norm\":%.17g,"
        "\"last_recomputed_relative_residual_l2_norm\":%.17g,"
        "\"residual_growth_factor\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"residual_l2_norm\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g}",
        artifact_status,
        complete ? "true" : "false",
        matrix_form,
        phase_convention_to_string(request.phase_convention),
        requested_execution_lane,
        requested_execution_lane,
        assembled_flag,
        dense_flag,
        production_lane ? "true" : "false",
        gpu_operator_solver_field,
        demag_tangent_operator_source,
        validation_result.demag_tangent_linearity_check ? "true" : "false",
        validation_result.demag_tangent_additivity_max_abs_error,
        validation_result.demag_tangent_homogeneity_max_abs_error,
        validation_result.demag_tangent_additivity_relative_error,
        validation_result.demag_tangent_homogeneity_relative_error,
        periodic_airbox_diagnostics_json.c_str(),
        production_lane ? "gmres" : "none",
        validation_result.krylov_preconditioner,
        validation_result.right_preconditioner_applied ? "true" : "false",
        preconditioner_setup_status(validation_result),
        gmres_history_json.c_str(),
        validation_result.rhs_real_l2_norm,
        validation_result.rhs_imag_l2_norm,
        validation_result.residual_real_l2_norm,
        validation_result.residual_imag_l2_norm,
        validation_result.response_real_l2_norm,
        validation_result.response_imag_l2_norm,
        coupled_block_norms_json.c_str(),
        domain_mesh_mode_diagnostics_json.c_str(),
        operator_terms.c_str(),
        static_cast<unsigned long long>(
            request.mfem_validation_problem.exchange_edge_count),
        static_periodic_artifact ? "true" : "false",
        floquet_phase_projection_artifact ? "true" : "false",
        floquet_phase_projection_artifact ? "true" : "false",
        basis_transport_policy,
        artifact_floquet_tangent_frame_mismatch,
        artifact_floquet_tangent_transport_max_nonunitarity,
        static_cast<unsigned long long>(request.floquet_periodic_pair_count),
        request.floquet_k_vector_rad_per_m[0],
        request.floquet_k_vector_rad_per_m[1],
        request.floquet_k_vector_rad_per_m[2],
        static_cast<unsigned long long>(
            request.mfem_validation_problem.static_periodic_node_pair_count),
        artifact_static_periodic_frame_mismatch,
        artifact_static_periodic_drive_mismatch,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.total_iteration_count),
        static_cast<unsigned long long>(validation_result.max_iterations_for_frequency),
        static_cast<unsigned long long>(validation_result.restart_iterations_for_frequency),
        static_cast<unsigned long long>(validation_result.progress_interval_iterations),
        validation_result.solver_relative_tolerance,
        validation_result.rhs_l2_norm,
        validation_result.initial_residual_l2_norm,
        validation_result.initial_relative_residual_l2_norm,
        validation_result.minimum_tracked_relative_residual_l2_norm,
        static_cast<unsigned long long>(
            validation_result.minimum_tracked_relative_residual_iteration),
        validation_result.last_tracked_relative_residual_l2_norm,
        validation_result.last_recomputed_relative_residual_l2_norm,
        validation_result.residual_growth_factor,
        validation_result.max_abs_response,
        validation_result.residual_l2_norm,
        validation_result.relative_residual_l2_norm)) {
        return FrequencyDomainStatus::artifact_error;
    }

    FrequencyDomainStatus status = ensure_directory(request.output_directory, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(frequency_domain_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(response_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (write_periodic_pairs_artifact) {
        status = ensure_directory(mesh_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    status = ensure_directory(diagnostics_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(frequency_points_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (write_field_payloads) {
        status = ensure_directory(field_payloads_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(field_payloads_zarr_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_zarr_group_artifact(field_payloads_zarr_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_response_zarr_store_attrs(field_payloads_zarr_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }

    status = write_text_artifact(sweep, sweep_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(sweep_v2, sweep_v2_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(progress, progress_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (interrupted_artifact) {
        status =
            write_text_artifact(cancel_requested, cancel_requested_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    status = write_text_artifact(diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (write_periodic_pairs_artifact) {
        status = write_text_artifact(
            periodic_pairs,
            periodic_pairs_json.c_str(),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point[256]{};
        char field_payload_dir[256]{};
        char zarr_frequency_group_dir[256]{};
        char zarr_tangent_array_dir[256]{};
        char zarr_spatial_array_dir[256]{};
        char zarr_tangent_chunk[256]{};
        char zarr_spatial_chunk[256]{};
        char field_payload[256]{};
        char spatial_field_payload[256]{};
        char sweep_reuse_json[256]{};
        std::string frequency_point_json;
        if (std::snprintf(
                frequency_point,
                sizeof(frequency_point),
                "%s/frequency_%04llu.json",
                frequency_points_dir,
                static_cast<unsigned long long>(frequency_index)) < 0) {
            std::snprintf(error_message, 128, "failed to format frequency response point artifact path");
            return FrequencyDomainStatus::artifact_error;
        }
        if (write_field_payloads &&
            (std::snprintf(
                 field_payload_dir,
                 sizeof(field_payload_dir),
                "%s/frequency_%04llu",
                field_payloads_dir,
                static_cast<unsigned long long>(frequency_index)) < 0 ||
                std::snprintf(
                    zarr_frequency_group_dir,
                    sizeof(zarr_frequency_group_dir),
                    "%s/frequency_%04llu",
                    field_payloads_zarr_dir,
                    static_cast<unsigned long long>(frequency_index)) < 0 ||
                std::snprintf(
                    zarr_tangent_array_dir,
                    sizeof(zarr_tangent_array_dir),
                    "%s/vector_tangent_complex",
                    zarr_frequency_group_dir) < 0 ||
                std::snprintf(
                    zarr_spatial_array_dir,
                    sizeof(zarr_spatial_array_dir),
                    "%s/vector_xyz_complex",
                    zarr_frequency_group_dir) < 0 ||
                std::snprintf(zarr_tangent_chunk, sizeof(zarr_tangent_chunk), "%s/0.0.0", zarr_tangent_array_dir) < 0 ||
                std::snprintf(zarr_spatial_chunk, sizeof(zarr_spatial_chunk), "%s/0.0.0", zarr_spatial_array_dir) < 0 ||
                std::snprintf(field_payload, sizeof(field_payload), "%s/vector.bin", field_payload_dir) < 0 ||
                std::snprintf(spatial_field_payload, sizeof(spatial_field_payload), "%s/vector_xyz.bin", field_payload_dir) < 0)) {
            std::snprintf(error_message, 128, "failed to format frequency response point artifact path");
            return FrequencyDomainStatus::artifact_error;
        }
        const int sweep_reuse_written =
            frequency_index == 0 ?
                std::snprintf(
                    sweep_reuse_json,
                    sizeof(sweep_reuse_json),
                    "{\"operator_template_reused\":true,\"warm_start\":null}") :
                std::snprintf(
                    sweep_reuse_json,
                    sizeof(sweep_reuse_json),
                    "{\"operator_template_reused\":true,"
                    "\"warm_start\":{\"kind\":\"previous_frequency_response\","
                    "\"source_frequency_rad_per_s\":%.17g,"
                    "\"residual_l2_norm\":null,"
                    "\"relative_residual_l2_norm\":null}}",
                    request.solve_request.frequencies_hz[frequency_index - 1] *
                        6.28318530717958647692);
        if (std::strlen(frequency_point) >= sizeof(frequency_point) - 1 ||
            sweep_reuse_written < 0 ||
            static_cast<std::size_t>(sweep_reuse_written) >= sizeof(sweep_reuse_json) ||
            (write_field_payloads &&
                (std::strlen(field_payload_dir) >= sizeof(field_payload_dir) - 1 ||
                    std::strlen(zarr_frequency_group_dir) >= sizeof(zarr_frequency_group_dir) - 1 ||
                    std::strlen(zarr_tangent_array_dir) >= sizeof(zarr_tangent_array_dir) - 1 ||
                    std::strlen(zarr_spatial_array_dir) >= sizeof(zarr_spatial_array_dir) - 1 ||
                    std::strlen(zarr_tangent_chunk) >= sizeof(zarr_tangent_chunk) - 1 ||
                    std::strlen(zarr_spatial_chunk) >= sizeof(zarr_spatial_chunk) - 1 ||
                    std::strlen(field_payload) >= sizeof(field_payload) - 1 ||
                    std::strlen(spatial_field_payload) >= sizeof(spatial_field_payload) - 1))) {
            std::snprintf(error_message, 128, "frequency response point artifact path exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        const double angular_frequency_rad_per_s =
            request.solve_request.frequencies_hz[frequency_index] * 6.28318530717958647692;
        const double *point_response_real =
            response_real + frequency_index * validation_result.response_dof_count;
        const double *point_response_imag =
            response_imag + frequency_index * validation_result.response_dof_count;
        ResponsePointSeriesJson series{};
        if (!build_response_point_series_json(
                point_response_real,
                point_response_imag,
                validation_result.response_dof_count,
                series,
                error_message)) {
            return FrequencyDomainStatus::artifact_error;
        }
        const ResponsePointObservableJson observables = build_response_point_observable_json(
            point_response_real,
            point_response_imag,
            request.mfem_validation_problem.drive_real,
            request.mfem_validation_problem.drive_imag,
            validation_result.response_dof_count,
            angular_frequency_rad_per_s,
            request.mfem_validation_problem.observable_ms_field,
            request.mfem_validation_problem.observable_ms_field_len,
            request.mfem_validation_problem.observable_uniform_ms);
        std::string periodic_airbox_point_json;
        if (periodic_airbox_demag_tangent_artifact) {
            std::vector<double> demag_real(
                static_cast<std::size_t>(validation_result.response_dof_count));
            std::vector<double> demag_imag(
                static_cast<std::size_t>(validation_result.response_dof_count));
            std::vector<double> provider_phi_real;
            std::vector<double> provider_phi_imag;
            const bool provider_phi_available =
                request.mfem_validation_problem.apply_demag_tangent_with_potential != nullptr &&
                request.periodic_airbox_delta_phi_dof_count > 0;
            if (provider_phi_available) {
                provider_phi_real.resize(
                    static_cast<std::size_t>(request.periodic_airbox_delta_phi_dof_count));
                provider_phi_imag.resize(
                    static_cast<std::size_t>(request.periodic_airbox_delta_phi_dof_count));
            }
            char callback_error[128]{};
            FrequencyDomainStatus demag_status = FrequencyDomainStatus::ok;
            if (provider_phi_available) {
                demag_status =
                    request.mfem_validation_problem.apply_demag_tangent_with_potential(
                        request.mfem_validation_problem.demag_tangent_user_data,
                        point_response_real,
                        demag_real.data(),
                        provider_phi_real.data(),
                        request.periodic_airbox_delta_phi_dof_count,
                        callback_error);
                if (demag_status == FrequencyDomainStatus::ok) {
                    demag_status =
                        request.mfem_validation_problem.apply_demag_tangent_with_potential(
                            request.mfem_validation_problem.demag_tangent_user_data,
                            point_response_imag,
                            demag_imag.data(),
                            provider_phi_imag.data(),
                            request.periodic_airbox_delta_phi_dof_count,
                            callback_error);
                }
            } else {
                demag_status = request.mfem_validation_problem.apply_demag_tangent(
                    request.mfem_validation_problem.demag_tangent_user_data,
                    point_response_real,
                    demag_real.data(),
                    callback_error);
                if (demag_status == FrequencyDomainStatus::ok) {
                    demag_status = request.mfem_validation_problem.apply_demag_tangent(
                        request.mfem_validation_problem.demag_tangent_user_data,
                        point_response_imag,
                        demag_imag.data(),
                        callback_error);
                }
            }
            if (demag_status != FrequencyDomainStatus::ok) {
                std::snprintf(
                    error_message,
                    128,
                    "failed to export periodic-airbox demag tangent response");
                return FrequencyDomainStatus::artifact_error;
            }
            std::string h_demag_complex = "[";
            for (std::uint64_t dof = 0; dof < validation_result.response_dof_count; ++dof) {
                if (!append_format(
                        h_demag_complex,
                        error_message,
                        "%s[%.17g,%.17g]",
                        dof == 0 ? "" : ",",
                        demag_real[static_cast<std::size_t>(dof)],
                        demag_imag[static_cast<std::size_t>(dof)])) {
                    return FrequencyDomainStatus::artifact_error;
                }
            }
            h_demag_complex += "]";
            std::string provider_phi_fields;
            if (provider_phi_available) {
                std::string provider_delta_phi_full_node_complex = "[";
                for (std::uint64_t dof = 0;
                     dof < request.periodic_airbox_delta_phi_dof_count;
                     ++dof) {
                    if (!append_format(
                            provider_delta_phi_full_node_complex,
                            error_message,
                            "%s[%.17g,%.17g]",
                            dof == 0 ? "" : ",",
                            provider_phi_real[static_cast<std::size_t>(dof)],
                            provider_phi_imag[static_cast<std::size_t>(dof)])) {
                        return FrequencyDomainStatus::artifact_error;
                    }
                }
                provider_delta_phi_full_node_complex += "]";
                if (!append_format(
                        provider_phi_fields,
                        error_message,
                        "\"provider_delta_phi_full_node_complex\":%s,"
                        "\"provider_delta_phi_layout\":\"full_node_scalar_potential_after_demag_tangent_solve\","
                        "\"provider_delta_phi_is_coupled_unknown\":false,",
                        provider_delta_phi_full_node_complex.c_str())) {
                    return FrequencyDomainStatus::artifact_error;
                }
            }
            if (!append_format(
                    periodic_airbox_point_json,
                    error_message,
                    "\"requested_magnetic_bc\":\"periodic\","
                    "\"resolved_magnetic_bc\":\"periodic\","
                    "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
                    "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
                    "\"delta_m_tangent_dof_count\":%llu,"
                    "\"delta_phi_dof_count\":%llu,"
                    "\"demag_contribution\":{\"status\":\"solved\","
                    "\"operator_source\":\"matrix_free_demag_tangent_provider\","
                    "\"dynamic_demag_matrix_form\":\"magnetic_only\","
                    "\"mfem_coupled_block_assembly\":false,"
                    "\"delta_phi_complex\":null,"
                    "%s"
                    "\"h_demag_complex\":%s,"
                    "\"unsupported_reason\":null},",
                    static_cast<unsigned long long>(
                        request.periodic_airbox_delta_m_tangent_dof_count),
                    static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count),
                    provider_phi_fields.c_str(),
                    h_demag_complex.c_str())) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
        if (write_field_payloads) {
            if (write_spatial_field_payloads) {
                if (!append_format(
                    frequency_point_json,
                    error_message,
                    "{\"schema_version\":\"frequency_response_point.v1\","
                    "\"frequency_index\":%llu,"
                    "\"frequency_hz\":%.17g,"
                    "\"angular_frequency_rad_per_s\":%.17g,"
                    "\"m_complex\":%s,"
                    "\"response_amplitude\":%.17g,"
                    "\"response_phase\":%.17g,"
                    "\"phase_rad\":%.17g,"
                    "\"component_response_amplitude\":%s,"
                    "\"component_response_phase\":%s,"
                    "%s"
                    "\"field_payload_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_xyz_complex/0.0.0\","
                    "\"tangent_field_payload_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0\","
                    "\"storage_format\":\"zarr\","
                    "\"zarr_store_path\":\"response/field_payloads.zarr\","
                    "\"zarr_array_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_xyz_complex\","
                    "\"zarr_chunk_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_xyz_complex/0.0.0\","
                    "\"zarr_dtype\":\"<f8\","
                    "\"zarr_shape\":[%llu,3,2],"
                    "\"zarr_chunk_shape\":[%llu,3,2],"
                    "\"zarr_compressor\":null,"
                    "\"compatibility_binary_payload_path\":\"response/field_payloads/frequency_%04llu/vector_xyz.bin\","
                    "\"payload_encoding\":\"f64_interleaved_real_imag_xyz\","
                    "\"tangent_payload_encoding\":\"f64_interleaved_real_imag_tangent\","
                    "\"binary_layout\":\"complex_f64_pairs_little_endian\","
                    "\"value_kind\":\"complex_spatial_vector\","
                    "\"component_basis\":\"global_xyz\","
                    "\"component_count\":3,"
                    "\"components\":[\"x\",\"y\",\"z\"],"
                    "\"complex_pair_count\":%llu,"
                    "\"payload_value_count\":%llu,"
                    "\"tangent_value_kind\":\"complex_tangent_vector\","
                    "\"tangent_component_basis\":\"local_tangent_frame\","
                    "\"tangent_component_count\":2,"
                    "\"tangent_components\":[\"tangent_e1\",\"tangent_e2\"],"
                    "\"tangent_complex_pair_count\":%llu,"
                    "\"tangent_payload_value_count\":%llu,"
                    "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"],"
                    "\"default_view\":\"phase_rotated_real\","
                    "\"default_phase_rad\":0.0,"
                    "\"susceptibility_tensor\":%s,"
                    "\"susceptibility_tensor_provenance\":%s,"
                    "\"absorbed_power_density\":%.17g,"
                    "\"absorbed_power_density_provenance\":%s,"
                    "\"residual_l2_norm\":%.17g,"
                    "\"relative_residual_l2_norm\":%.17g,"
                    "\"residual_source\":\"%s\","
                    "\"tangent_leakage\":%s,"
                    "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
                    "%s"
                    "\"sweep_reuse\":%s}",
                    static_cast<unsigned long long>(frequency_index),
                    request.solve_request.frequencies_hz[frequency_index],
                    angular_frequency_rad_per_s,
                    series.m_complex.c_str(),
                    series.response_amplitude,
                    series.response_phase,
                    series.response_phase,
                    series.component_amplitude.c_str(),
                    series.component_phase.c_str(),
                    periodic_airbox_point_metadata_json.c_str(),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(request.mfem_validation_problem.descriptor.node_count),
                    static_cast<unsigned long long>(request.mfem_validation_problem.descriptor.node_count),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(request.mfem_validation_problem.descriptor.full_dof_count),
                    static_cast<unsigned long long>(
                        request.mfem_validation_problem.descriptor.full_dof_count * 2),
                    static_cast<unsigned long long>(validation_result.response_dof_count),
                    static_cast<unsigned long long>(validation_result.response_dof_count * 2),
                    observables.susceptibility_tensor.c_str(),
                    observables.susceptibility_provenance.c_str(),
                    observables.absorbed_power_density,
                    observables.absorbed_power_density_provenance.c_str(),
                    residual_l2_norm[frequency_index],
                    relative_residual_l2_norm[frequency_index],
                    residual_source,
                    observables.tangent_leakage.c_str(),
                    excitation_phase_rad,
                    periodic_airbox_point_json.c_str(),
                    sweep_reuse_json)) {
                    return FrequencyDomainStatus::artifact_error;
                }
            } else {
                if (!append_format(
                    frequency_point_json,
                    error_message,
                    "{\"schema_version\":\"frequency_response_point.v1\","
                    "\"frequency_index\":%llu,"
                    "\"frequency_hz\":%.17g,"
                    "\"angular_frequency_rad_per_s\":%.17g,"
                    "\"m_complex\":%s,"
                    "\"response_amplitude\":%.17g,"
                    "\"response_phase\":%.17g,"
                    "\"phase_rad\":%.17g,"
                    "\"component_response_amplitude\":%s,"
                    "\"component_response_phase\":%s,"
                    "%s"
                    "\"field_payload_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0\","
                    "\"storage_format\":\"zarr\","
                    "\"zarr_store_path\":\"response/field_payloads.zarr\","
                    "\"zarr_array_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex\","
                    "\"zarr_chunk_path\":\"response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0\","
                    "\"zarr_dtype\":\"<f8\","
                    "\"zarr_shape\":[%llu,2,2],"
                    "\"zarr_chunk_shape\":[%llu,2,2],"
                    "\"zarr_compressor\":null,"
                    "\"compatibility_binary_payload_path\":\"response/field_payloads/frequency_%04llu/vector.bin\","
                    "\"payload_encoding\":\"f64_interleaved_real_imag_tangent\","
                    "\"binary_layout\":\"complex_f64_pairs_little_endian\","
                    "\"value_kind\":\"complex_tangent_vector\","
                    "\"component_basis\":\"local_tangent_frame\","
                    "\"component_count\":2,"
                    "\"components\":[\"tangent_e1\",\"tangent_e2\"],"
                    "\"complex_pair_count\":%llu,"
                    "\"payload_value_count\":%llu,"
                    "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"],"
                    "\"default_view\":\"phase_rotated_real\","
                    "\"default_phase_rad\":0.0,"
                    "\"susceptibility_tensor\":%s,"
                    "\"susceptibility_tensor_provenance\":%s,"
                    "\"absorbed_power_density\":%.17g,"
                    "\"absorbed_power_density_provenance\":%s,"
                    "\"residual_l2_norm\":%.17g,"
                    "\"relative_residual_l2_norm\":%.17g,"
                    "\"residual_source\":\"%s\","
                    "\"tangent_leakage\":%s,"
                    "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
                    "%s"
                    "\"sweep_reuse\":%s}",
                    static_cast<unsigned long long>(frequency_index),
                    request.solve_request.frequencies_hz[frequency_index],
                    angular_frequency_rad_per_s,
                    series.m_complex.c_str(),
                    series.response_amplitude,
                    series.response_phase,
                    series.response_phase,
                    series.component_amplitude.c_str(),
                    series.component_phase.c_str(),
                    periodic_airbox_point_metadata_json.c_str(),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(validation_result.response_dof_count / 2),
                    static_cast<unsigned long long>(validation_result.response_dof_count / 2),
                    static_cast<unsigned long long>(frequency_index),
                    static_cast<unsigned long long>(validation_result.response_dof_count),
                    static_cast<unsigned long long>(validation_result.response_dof_count * 2),
                    observables.susceptibility_tensor.c_str(),
                    observables.susceptibility_provenance.c_str(),
                    observables.absorbed_power_density,
                    observables.absorbed_power_density_provenance.c_str(),
                    residual_l2_norm[frequency_index],
                    relative_residual_l2_norm[frequency_index],
                    residual_source,
                    observables.tangent_leakage.c_str(),
                    excitation_phase_rad,
                    periodic_airbox_point_json.c_str(),
                    sweep_reuse_json)) {
                    return FrequencyDomainStatus::artifact_error;
                }
            }
        } else {
            if (!append_format(
                frequency_point_json,
                error_message,
                "{\"schema_version\":\"frequency_response_point.v1\","
                "\"frequency_index\":%llu,"
                "\"frequency_hz\":%.17g,"
                "\"angular_frequency_rad_per_s\":%.17g,"
                "\"m_complex\":%s,"
                "\"response_amplitude\":%.17g,"
                "\"response_phase\":%.17g,"
                "\"phase_rad\":%.17g,"
                "\"component_response_amplitude\":%s,"
                "\"component_response_phase\":%s,"
                "%s"
                "\"field_payload_path\":null,"
                "\"payload_encoding\":\"not_written\","
                "\"binary_layout\":\"none\","
                "\"value_kind\":\"complex_tangent_vector\","
                "\"component_basis\":\"local_tangent_frame\","
                "\"component_count\":2,"
                "\"components\":[\"tangent_e1\",\"tangent_e2\"],"
                "\"complex_pair_count\":%llu,"
                "\"payload_value_count\":0,"
                "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"],"
                "\"default_view\":\"phase_rotated_real\","
                "\"default_phase_rad\":0.0,"
                "\"susceptibility_tensor\":%s,"
                "\"susceptibility_tensor_provenance\":%s,"
                "\"absorbed_power_density\":%.17g,"
                "\"absorbed_power_density_provenance\":%s,"
                "\"residual_l2_norm\":%.17g,"
                "\"relative_residual_l2_norm\":%.17g,"
                "\"residual_source\":\"%s\","
                "\"tangent_leakage\":%s,"
                "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
                "%s"
                "\"sweep_reuse\":%s}",
                static_cast<unsigned long long>(frequency_index),
                request.solve_request.frequencies_hz[frequency_index],
                angular_frequency_rad_per_s,
                series.m_complex.c_str(),
                series.response_amplitude,
                series.response_phase,
                series.response_phase,
                series.component_amplitude.c_str(),
                series.component_phase.c_str(),
                periodic_airbox_point_metadata_json.c_str(),
                static_cast<unsigned long long>(validation_result.response_dof_count),
                observables.susceptibility_tensor.c_str(),
                observables.susceptibility_provenance.c_str(),
                observables.absorbed_power_density,
                observables.absorbed_power_density_provenance.c_str(),
                residual_l2_norm[frequency_index],
                relative_residual_l2_norm[frequency_index],
                residual_source,
                observables.tangent_leakage.c_str(),
                excitation_phase_rad,
                periodic_airbox_point_json.c_str(),
                sweep_reuse_json)) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
        status = write_text_artifact(frequency_point, frequency_point_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (!write_field_payloads) {
            continue;
        }
        status = ensure_directory(field_payload_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(zarr_frequency_group_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_zarr_group_artifact(zarr_frequency_group_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(zarr_tangent_array_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_response_zarr_array_artifacts(
            zarr_tangent_array_dir,
            validation_result.response_dof_count / 2,
            2,
            "[\"tangent_e1\",\"tangent_e2\"]",
            "local_tangent_frame",
            "complex_tangent_vector",
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        const std::uint64_t payload_value_count = validation_result.response_dof_count * 2;
        std::vector<double> payload(static_cast<std::size_t>(payload_value_count));
        for (std::uint64_t dof = 0; dof < validation_result.response_dof_count; ++dof) {
            const std::uint64_t response_index = frequency_index * validation_result.response_dof_count + dof;
            payload[dof * 2] = response_real[response_index];
            payload[dof * 2 + 1] = response_imag[response_index];
        }
        status = write_binary_artifact(
            zarr_tangent_chunk,
            payload.data(),
            static_cast<std::size_t>(payload_value_count * sizeof(double)),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_binary_artifact(
            field_payload,
            payload.data(),
            static_cast<std::size_t>(payload_value_count * sizeof(double)),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (write_spatial_field_payloads) {
            status = ensure_directory(zarr_spatial_array_dir, error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
            status = write_response_zarr_array_artifacts(
                zarr_spatial_array_dir,
                request.mfem_validation_problem.descriptor.node_count,
                3,
                "[\"x\",\"y\",\"z\"]",
                "global_xyz",
                "complex_spatial_vector",
                error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
            const std::uint64_t node_count = request.mfem_validation_problem.descriptor.node_count;
            const std::uint64_t full_dof_count = request.mfem_validation_problem.descriptor.full_dof_count;
            std::vector<double> spatial_real(static_cast<std::size_t>(full_dof_count));
            std::vector<double> spatial_imag(static_cast<std::size_t>(full_dof_count));
            std::vector<double> spatial_payload(static_cast<std::size_t>(full_dof_count * 2));
            lift_tangent_to_full(
                request.mfem_validation_problem.nodes,
                response_real + frequency_index * validation_result.response_dof_count,
                node_count,
                spatial_real.data());
            lift_tangent_to_full(
                request.mfem_validation_problem.nodes,
                response_imag + frequency_index * validation_result.response_dof_count,
                node_count,
                spatial_imag.data());
            for (std::uint64_t dof = 0; dof < full_dof_count; ++dof) {
                spatial_payload[dof * 2] = spatial_real[dof];
                spatial_payload[dof * 2 + 1] = spatial_imag[dof];
            }
            status = write_binary_artifact(
                zarr_spatial_chunk,
                spatial_payload.data(),
                static_cast<std::size_t>(spatial_payload.size() * sizeof(double)),
                error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
            status = write_binary_artifact(
                spatial_field_payload,
                spatial_payload.data(),
                static_cast<std::size_t>(spatial_payload.size() * sizeof(double)),
                error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
        }
    }
    status = write_text_artifact(manifest, manifest_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::snprintf(manifest_path, 256, "%s", manifest);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus write_unavailable_response_artifacts(
    const DrivenFrequencyResponseSolveRequest &request,
    const char *unavailable_reason,
    const char *unsupported_reason,
    char manifest_path[256],
    char error_message[128]) noexcept
{
    if (!has_output_directory(request.output_directory)) {
        manifest_path[0] = '\0';
        return FrequencyDomainStatus::ok;
    }
    if (!request.write_partial_artifacts) {
        manifest_path[0] = '\0';
        return FrequencyDomainStatus::ok;
    }

    char frequency_domain_dir[256]{};
    char response_dir[256]{};
    char frequency_points_dir[256]{};
    char field_payloads_dir[256]{};
    char field_payloads_zarr_dir[256]{};
    char sweep[256]{};
    char sweep_v2[256]{};
    char manifest[256]{};
    char diagnostics[256]{};
    char diagnostics_dir[256]{};
    char solver_diagnostics[256]{};
    char progress[256]{};
    char mesh_dir[256]{};
    char periodic_pairs[256]{};
    if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
        std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
        std::snprintf(frequency_points_dir, sizeof(frequency_points_dir), "%s/frequency_points", response_dir) < 0 ||
        std::snprintf(field_payloads_dir, sizeof(field_payloads_dir), "%s/field_payloads", response_dir) < 0 ||
        std::snprintf(field_payloads_zarr_dir, sizeof(field_payloads_zarr_dir), "%s/field_payloads.zarr", response_dir) < 0 ||
        std::snprintf(sweep, sizeof(sweep), "%s/magnetic_response_sweep.v1.json", response_dir) < 0 ||
        std::snprintf(sweep_v2, sizeof(sweep_v2), "%s/magnetic_response_sweep.v2.json", response_dir) < 0 ||
        std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
        std::snprintf(diagnostics, sizeof(diagnostics), "%s/diagnostics.v1.json", response_dir) < 0 ||
        std::snprintf(diagnostics_dir, sizeof(diagnostics_dir), "%s/diagnostics", response_dir) < 0 ||
        std::snprintf(solver_diagnostics, sizeof(solver_diagnostics), "%s/solver.v1.json", diagnostics_dir) < 0 ||
        std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0 ||
        std::snprintf(mesh_dir, sizeof(mesh_dir), "%s/mesh", request.output_directory) < 0 ||
        std::snprintf(periodic_pairs, sizeof(periodic_pairs), "%s/periodic_pairs.v1.json", mesh_dir) < 0) {
        std::snprintf(error_message, 128, "failed to format unavailable frequency response artifact paths");
        return FrequencyDomainStatus::artifact_error;
    }
    if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
        std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
        std::strlen(frequency_points_dir) >= sizeof(frequency_points_dir) - 1 ||
        std::strlen(field_payloads_dir) >= sizeof(field_payloads_dir) - 1 ||
        std::strlen(field_payloads_zarr_dir) >= sizeof(field_payloads_zarr_dir) - 1 ||
        std::strlen(sweep) >= sizeof(sweep) - 1 ||
        std::strlen(sweep_v2) >= sizeof(sweep_v2) - 1 ||
        std::strlen(manifest) >= sizeof(manifest) - 1 ||
        std::strlen(diagnostics) >= sizeof(diagnostics) - 1 ||
        std::strlen(diagnostics_dir) >= sizeof(diagnostics_dir) - 1 ||
        std::strlen(solver_diagnostics) >= sizeof(solver_diagnostics) - 1 ||
        std::strlen(progress) >= sizeof(progress) - 1 ||
        std::strlen(mesh_dir) >= sizeof(mesh_dir) - 1 ||
        std::strlen(periodic_pairs) >= sizeof(periodic_pairs) - 1) {
        std::snprintf(error_message, 128, "unavailable frequency response artifact path exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    std::string diagnostics_json;
    std::string progress_json;
    std::string manifest_json;
    std::string periodic_pairs_json;
    std::string sweep_json;
    std::string sweep_v2_json;
    std::string frequency_point_paths_json = "[";
    std::string unsupported_reason_json = "null";
    if (unsupported_reason != nullptr && unsupported_reason[0] != '\0') {
        unsupported_reason_json = "\"";
        unsupported_reason_json += unsupported_reason;
        unsupported_reason_json += "\"";
    }
    const char *requested_execution_lane = execution_lane_to_string(request.execution_lane);
    const bool magnetic_periodic =
        request.magnetic_periodic_constraint_set_count > 0 ||
        request.mfem_validation_problem.static_periodic_node_pair_count > 0;
    const bool magnetostatic_periodic_airbox =
        request.requires_periodic_airbox_dynamic_demag;
    const char *requested_magnetic_bc = magnetic_periodic ? "periodic" : "open";
    const char *resolved_magnetic_bc = requested_magnetic_bc;
    const char *periodic_pairs_v1_path_json =
        magnetic_periodic ? "\"mesh/periodic_pairs.v1.json\"" : "null";
    const char *requested_magnetostatic_bc =
        magnetostatic_periodic_airbox ? "periodic_airbox_k0" : "open";
    const char *resolved_magnetostatic_bc = requested_magnetostatic_bc;
    const std::uint64_t delta_m_tangent_dof_count =
        request.periodic_airbox_delta_m_tangent_dof_count > 0
            ? request.periodic_airbox_delta_m_tangent_dof_count
            : request.solve_request.operator_request.tangent_dof_count;
    const std::uint64_t delta_phi_dof_count =
        request.periodic_airbox_delta_phi_dof_count;
    const std::uint64_t coupled_complex_dof_count =
        delta_m_tangent_dof_count + delta_phi_dof_count;
    const std::uint64_t written_frequency_point_artifacts =
        magnetostatic_periodic_airbox ? request.solve_request.frequency_count : 0;
    const char *partial_artifacts_available =
        written_frequency_point_artifacts > 0 ? "true" : "false";
    const char *lane_classification =
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu
            ? "fem_gpu_production"
            : request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu
                ? "fem_cpu_production"
                : "fem_validation_unavailable";
    const char *demag_contribution_unsupported_reason =
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu &&
            magnetostatic_periodic_airbox
            ? "periodic_airbox_dynamic_demag_gpu_unsupported"
            : "periodic_airbox_dynamic_demag_coupled_block_unimplemented";
    const char *unavailable_dynamic_demag_operator_source =
        magnetostatic_periodic_airbox
            ? "unassembled_mfem_periodic_airbox_coupled_block"
            : "none";
    if (magnetic_periodic) {
        const bool has_static_pairs =
            request.mfem_validation_problem.static_periodic_node_pair_count > 0 &&
            request.mfem_validation_problem.static_periodic_node_pairs != nullptr;
        const std::uint64_t static_periodic_pair_count =
            has_static_pairs
                ? request.mfem_validation_problem.static_periodic_node_pair_count
                : 0;
        const bool has_magnetostatic_pairs =
            request.periodic_airbox_magnetostatic_periodic_node_pair_count > 0 &&
            request.periodic_airbox_magnetostatic_periodic_node_pairs != nullptr;
        const std::uint64_t magnetostatic_periodic_pair_count =
            has_magnetostatic_pairs
                ? request.periodic_airbox_magnetostatic_periodic_node_pair_count
                : 0;
        const std::uint64_t concrete_pair_count =
            static_periodic_pair_count + magnetostatic_periodic_pair_count;
        if (!append_format(
                periodic_pairs_json,
                error_message,
                "{\"schema_version\":\"periodic_pairs.v1\","
                "\"source\":\"native_fem_frequency_domain_unavailable\","
                "\"validation_status\":\"unavailable\","
                "\"unsupported_reason\":%s,"
                "\"pair_count\":%llu,"
                "\"paired_node_count\":%llu,"
                "\"unpaired_source_count\":0,"
                "\"unpaired_destination_count\":0,"
                "\"tolerance_m\":0.0,"
                "\"max_translation_residual_m\":0.0,"
                "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0},"
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"pairs\":[",
                unsupported_reason_json.c_str(),
                static_cast<unsigned long long>(concrete_pair_count),
                static_cast<unsigned long long>(concrete_pair_count * 2),
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count))) {
            return FrequencyDomainStatus::artifact_error;
        }
        bool wrote_periodic_pair = false;
        if (has_static_pairs) {
            for (std::uint64_t pair_index = 0;
                 pair_index < request.mfem_validation_problem.static_periodic_node_pair_count;
                 ++pair_index) {
                const std::uint64_t node_a =
                    request.mfem_validation_problem.static_periodic_node_pairs[pair_index * 2];
                const std::uint64_t node_b =
                    request.mfem_validation_problem.static_periodic_node_pairs[pair_index * 2 + 1];
                if (!append_format(
                        periodic_pairs_json,
                        error_message,
                        "%s{\"pair_id\":\"static-periodic-%04llu\","
                        "\"source_marker\":\"node:%llu\","
                        "\"destination_marker\":\"node:%llu\","
                        "\"node_a\":%llu,"
                        "\"node_b\":%llu,"
                        "\"expected_translation_m\":[0.0,0.0,0.0],"
                        "\"translation_m\":[0.0,0.0,0.0],"
                        "\"paired_node_count\":2,"
                        "\"unpaired_source_count\":0,"
                        "\"unpaired_destination_count\":0,"
                        "\"translation_residual_m\":0.0,"
                        "\"phase_rad\":0.0,"
                        "\"validation_status\":\"unavailable\","
                        "\"unsupported_reason\":%s}",
                        wrote_periodic_pair ? "," : "",
                        static_cast<unsigned long long>(pair_index),
                        static_cast<unsigned long long>(node_a),
                        static_cast<unsigned long long>(node_b),
                        static_cast<unsigned long long>(node_a),
                        static_cast<unsigned long long>(node_b),
                        unsupported_reason_json.c_str())) {
                    return FrequencyDomainStatus::artifact_error;
                }
                wrote_periodic_pair = true;
            }
        }
        if (has_magnetostatic_pairs) {
            for (std::uint64_t pair_index = 0;
                 pair_index < request.periodic_airbox_magnetostatic_periodic_node_pair_count;
                 ++pair_index) {
                const std::uint64_t node_a =
                    request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2];
                const std::uint64_t node_b =
                    request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2 + 1];
                if (!append_format(
                        periodic_pairs_json,
                        error_message,
                        "%s{\"pair_id\":\"magnetostatic-delta-phi-%04llu\","
                        "\"pair_family\":\"magnetostatic_delta_phi\","
                        "\"unknown_family\":\"delta_phi\","
                        "\"source_marker\":\"delta_phi_node:%llu\","
                        "\"destination_marker\":\"delta_phi_node:%llu\","
                        "\"node_a\":%llu,"
                        "\"node_b\":%llu,"
                        "\"expected_translation_m\":[0.0,0.0,0.0],"
                        "\"translation_m\":[0.0,0.0,0.0],"
                        "\"paired_node_count\":2,"
                        "\"unpaired_source_count\":0,"
                        "\"unpaired_destination_count\":0,"
                        "\"translation_residual_m\":0.0,"
                        "\"phase_rad\":0.0,"
                        "\"phase_convention\":\"zero_phase_periodic_airbox_k0\","
                        "\"validation_status\":\"unavailable\","
                        "\"unsupported_reason\":%s}",
                        wrote_periodic_pair ? "," : "",
                        static_cast<unsigned long long>(pair_index),
                        static_cast<unsigned long long>(node_a),
                        static_cast<unsigned long long>(node_b),
                        static_cast<unsigned long long>(node_a),
                        static_cast<unsigned long long>(node_b),
                        unsupported_reason_json.c_str())) {
                    return FrequencyDomainStatus::artifact_error;
                }
                wrote_periodic_pair = true;
            }
        }
        periodic_pairs_json += "]}";
    }
    for (std::uint64_t frequency_index = 0;
         frequency_index < written_frequency_point_artifacts;
         ++frequency_index) {
        char frequency_point_path[96]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "response/frequency_points/frequency_%04llu.json",
            static_cast<unsigned long long>(frequency_index));
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            !append_format(
                frequency_point_paths_json,
                error_message,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                frequency_point_path)) {
            std::snprintf(error_message, 128, "failed to format unavailable frequency point paths");
            return FrequencyDomainStatus::artifact_error;
        }
    }
    frequency_point_paths_json += "]";
    if (!append_format(
        diagnostics_json,
        error_message,
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"solver_kind\":\"production_unavailable\","
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"unavailable\","
        "\"lane_classification\":\"%s\","
        "\"unsupported_reason\":%s,"
        "\"error_message\":\"%s\","
        "\"requested_frequency_count\":%llu,"
        "\"completed_frequency_point_count\":0,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"validation_fallback_used\":false,"
        "\"production_solver_requested\":true,"
        "\"requested_magnetic_bc\":\"%s\","
        "\"resolved_magnetic_bc\":\"%s\","
        "\"requested_magnetostatic_bc\":\"%s\","
        "\"resolved_magnetostatic_bc\":\"%s\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"delta_m_tangent_dof_count\":%llu,"
        "\"delta_phi_dof_count\":%llu,"
        "\"magnetostatic_periodic_node_pair_count\":%llu,"
        "\"coupled_complex_dof_count\":%llu,"
        "\"periodic_airbox_coupled_block_solver\":false,"
        "\"mfem_coupled_block_assembly\":false,"
        "\"dynamic_demag_operator_source\":\"%s\","
        "\"production_solver_available\":false}",
        requested_execution_lane,
        lane_classification,
        unsupported_reason_json.c_str(),
        unavailable_reason,
        static_cast<unsigned long long>(request.solve_request.frequency_count),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        requested_magnetic_bc,
        resolved_magnetic_bc,
        requested_magnetostatic_bc,
        resolved_magnetostatic_bc,
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(delta_m_tangent_dof_count),
        static_cast<unsigned long long>(delta_phi_dof_count),
        static_cast<unsigned long long>(
            request.periodic_airbox_magnetostatic_periodic_node_pair_count),
        static_cast<unsigned long long>(coupled_complex_dof_count),
        unavailable_dynamic_demag_operator_source) ||
        !append_sweep_progress_artifact_json(
            progress_json,
            error_message,
            "unavailable",
            false,
            "unavailable",
            request.solve_request.frequency_count,
            0,
            written_frequency_point_artifacts,
            "null",
            written_frequency_point_artifacts > 0,
            "frequency_domain/manifest.v1.json") ||
        !append_format(
        manifest_json,
        error_message,
        "{\"schema_version\":\"frequency_domain_manifest.v1\","
        "\"analysis_family\":\"magnetic_frequency_domain\","
        "\"study_product\":\"driven_response\","
        "\"revision\":\"unavailable-v1\","
        "\"created_at\":\"1970-01-01T00:00:00Z\","
        "\"session_id\":\"native-validation\","
        "\"run_id\":\"native-validation\","
        "\"stage_id\":\"frequency-response-production\","
        "\"stage_kind\":\"frequency_response\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"requested_execution\":{\"solve_equation\":\"(i omega B - L) q = f\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"study_kind\":\"frequency_response\","
        "\"frequency_count\":%llu,"
        "\"write_response_fields\":%s},"
        "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
        "\"engine\":\"native_fem_mfem_frequency_domain\","
        "\"native_backend\":\"native_mfem_unavailable\","
        "\"reference_or_production\":\"production\","
        "\"solver_library\":\"unavailable\","
        "\"solver_model\":\"production_unavailable\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"solver_kind\":\"production_unavailable\","
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"unavailable\","
        "\"lane_classification\":\"%s\","
        "\"production_solver\":true},"
        "\"physics\":{\"analysis_family\":\"frequency_domain\","
        "\"llg_gamma0_si\":%.17g,"
        "\"llg_alpha\":%.17g,"
        "\"phase_convention\":\"%s\","
        "\"frequency_units\":\"Hz\","
        "\"field_units\":\"A_per_m\","
        "\"normalization\":\"linear_response_tangent\","
        "\"spin_wave_bc\":{\"kind\":\"%s\"},"
        "\"requested_spin_wave_bc\":\"%s\","
        "\"resolved_spin_wave_bc\":\"%s\","
        "\"periodic_or_floquet\":%s,"
        "\"requested_magnetic_bc\":\"%s\","
        "\"resolved_magnetic_bc\":\"%s\","
        "\"requested_magnetostatic_bc\":\"%s\","
        "\"resolved_magnetostatic_bc\":\"%s\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"delta_m_tangent_dof_count\":%llu,"
        "\"delta_phi_dof_count\":%llu,"
        "\"magnetostatic_periodic_node_pair_count\":%llu,"
        "\"coupled_complex_dof_count\":%llu},"
        "\"artifacts\":{\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
        "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
        "\"periodic_pairs_v1_path\":%s,"
        "\"response_progress_v1_path\":\"response/progress.v1.json\","
        "\"response_cancel_requested_v1_path\":null,"
        "\"response_map_v1_path\":null,"
        "\"response_map_v2_path\":null,"
        "\"frequency_point_paths\":%s},"
        "\"resources\":{\"response_progress_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/progress.v1\","
        "\"response_diagnostics_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1\","
        "\"response_cancel_requested_resource_key\":null,"
        "\"response_map_resource_key\":null,"
        "\"response_field_resources\":[]},"
        "\"diagnostics\":{\"requested_frequency_count\":%llu,"
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"unavailable\","
        "\"unsupported_reason\":%s,"
        "\"validation_fallback_used\":false,"
        "\"periodic_airbox_coupled_block_solver\":false,"
        "\"mfem_coupled_block_assembly\":false,"
        "\"dynamic_demag_operator_source\":\"%s\","
        "\"completed_frequency_point_count\":0,"
        "\"written_frequency_point_artifacts\":%llu},"
        "\"capabilities\":{\"validation_solver_available\":true,"
        "\"production_solver_available\":false,"
        "\"production_native_solver_available\":false,"
        "\"validation_artifact\":false,"
        "\"dynamic_demag_k_available\":false,"
        "\"floquet_response_available\":false,"
        "\"gpu_available\":false}}",
        static_cast<unsigned long long>(request.solve_request.frequency_count),
        request.solve_request.write_response_fields ? "true" : "false",
        requested_execution_lane,
        lane_classification,
        request.solve_request.operator_request.gamma0,
        request.solve_request.operator_request.alpha,
        phase_convention_to_string(request.phase_convention),
        requested_magnetic_bc,
        requested_magnetic_bc,
        resolved_magnetic_bc,
        magnetic_periodic ? "true" : "false",
        requested_magnetic_bc,
        resolved_magnetic_bc,
        requested_magnetostatic_bc,
        resolved_magnetostatic_bc,
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(delta_m_tangent_dof_count),
        static_cast<unsigned long long>(delta_phi_dof_count),
        static_cast<unsigned long long>(
            request.periodic_airbox_magnetostatic_periodic_node_pair_count),
        static_cast<unsigned long long>(coupled_complex_dof_count),
        periodic_pairs_v1_path_json,
        frequency_point_paths_json.c_str(),
        static_cast<unsigned long long>(request.solve_request.frequency_count),
        requested_execution_lane,
        unsupported_reason_json.c_str(),
        unavailable_dynamic_demag_operator_source,
        static_cast<unsigned long long>(written_frequency_point_artifacts))) {
        return FrequencyDomainStatus::artifact_error;
    }

    FrequencyDomainStatus status = ensure_directory(request.output_directory, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(frequency_domain_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(response_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (magnetic_periodic) {
        status = ensure_directory(mesh_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(periodic_pairs, periodic_pairs_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    if (written_frequency_point_artifacts > 0) {
        status = ensure_directory(frequency_points_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    status = ensure_directory(diagnostics_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(progress, progress_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(manifest, manifest_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    for (std::uint64_t frequency_index = 0;
         frequency_index < written_frequency_point_artifacts;
         ++frequency_index) {
        char frequency_point_path[256]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "%s/frequency_%04llu.json",
            frequency_points_dir,
            static_cast<unsigned long long>(frequency_index));
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path)) {
            std::snprintf(error_message, 128, "failed to format unavailable frequency point artifact path");
            return FrequencyDomainStatus::artifact_error;
        }
        std::string frequency_point_json;
        if (!append_format(
                frequency_point_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_point.v1\","
                "\"frequency_index\":%llu,"
                "\"frequency_hz\":%.17g,"
                "\"status\":\"unavailable\","
                "\"complete\":false,"
                "\"requested_magnetic_bc\":\"%s\","
                "\"resolved_magnetic_bc\":\"%s\","
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"coupled_complex_dof_count\":%llu,"
                "\"m_complex\":null,"
                "\"demag_contribution\":{\"status\":\"unavailable\","
                "\"delta_phi_complex\":null,"
                "\"h_demag_complex\":null,"
                "\"energy_density\":null,"
                "\"operator_source\":\"%s\","
                "\"mfem_coupled_block_assembly\":false,"
                "\"unsupported_reason\":\"%s\"}}",
                static_cast<unsigned long long>(frequency_index),
                request.solve_request.frequencies_hz[frequency_index],
                requested_magnetic_bc,
                resolved_magnetic_bc,
                requested_magnetostatic_bc,
                resolved_magnetostatic_bc,
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(coupled_complex_dof_count),
                unavailable_dynamic_demag_operator_source,
                demag_contribution_unsupported_reason)) {
            return FrequencyDomainStatus::artifact_error;
        }
        status = write_text_artifact(frequency_point_path, frequency_point_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    std::snprintf(manifest_path, 256, "%s", manifest);
    return FrequencyDomainStatus::ok;
}

bool append_complex_response_array(
    std::string &out,
    char error_message[128],
    const double *response_real,
    const double *response_imag,
    std::uint64_t offset,
    std::uint64_t count) noexcept
{
    if (!append_format(out, error_message, "[")) {
        return false;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!append_format(
                out,
                error_message,
                "%s[%.17g,%.17g]",
                index == 0 ? "" : ",",
                response_real[offset + index],
                response_imag[offset + index])) {
            return false;
        }
    }
    return append_format(out, error_message, "]");
}

FrequencyDomainStatus write_periodic_airbox_coupled_block_artifacts(
    const DrivenFrequencyResponseSolveRequest &request,
    const DenseDrivenResponseValidationResult &validation_result,
    const PeriodicAirboxPhiGaugeDiagnostics &phi_gauge_diagnostics,
    const char *revision,
    const char *solver_kind,
    const char *solver_model,
    const char *frequency_point_solver_model,
    const char *operator_source,
    const char *run_status,
    bool complete,
    const char *extra_diagnostics_json,
    const double *response_real,
    const double *response_imag,
    const double *residual_l2_norm,
    const double *relative_residual_l2_norm,
    char manifest_path[256],
    char error_message[128]) noexcept
{
    if (!has_output_directory(request.output_directory)) {
        manifest_path[0] = '\0';
        return FrequencyDomainStatus::ok;
    }

    char frequency_domain_dir[256]{};
    char response_dir[256]{};
    char frequency_points_dir[256]{};
    char field_payloads_dir[256]{};
    char field_payloads_zarr_dir[256]{};
    char sweep[256]{};
    char sweep_v2[256]{};
    char manifest[256]{};
    char diagnostics_dir[256]{};
    char solver_diagnostics[256]{};
    char progress[256]{};
    char mesh_dir[256]{};
    char periodic_pairs[256]{};
    if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
        std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
        std::snprintf(frequency_points_dir, sizeof(frequency_points_dir), "%s/frequency_points", response_dir) < 0 ||
        std::snprintf(field_payloads_dir, sizeof(field_payloads_dir), "%s/field_payloads", response_dir) < 0 ||
        std::snprintf(field_payloads_zarr_dir, sizeof(field_payloads_zarr_dir), "%s/field_payloads.zarr", response_dir) < 0 ||
        std::snprintf(sweep, sizeof(sweep), "%s/magnetic_response_sweep.v1.json", response_dir) < 0 ||
        std::snprintf(sweep_v2, sizeof(sweep_v2), "%s/magnetic_response_sweep.v2.json", response_dir) < 0 ||
        std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
        std::snprintf(diagnostics_dir, sizeof(diagnostics_dir), "%s/diagnostics", response_dir) < 0 ||
        std::snprintf(solver_diagnostics, sizeof(solver_diagnostics), "%s/solver.v1.json", diagnostics_dir) < 0 ||
        std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0 ||
        std::snprintf(mesh_dir, sizeof(mesh_dir), "%s/mesh", request.output_directory) < 0 ||
        std::snprintf(periodic_pairs, sizeof(periodic_pairs), "%s/periodic_pairs.v1.json", mesh_dir) < 0) {
        std::snprintf(error_message, 128, "failed to format periodic-airbox coupled block artifact paths");
        return FrequencyDomainStatus::artifact_error;
    }
    if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
        std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
        std::strlen(frequency_points_dir) >= sizeof(frequency_points_dir) - 1 ||
        std::strlen(field_payloads_dir) >= sizeof(field_payloads_dir) - 1 ||
        std::strlen(field_payloads_zarr_dir) >= sizeof(field_payloads_zarr_dir) - 1 ||
        std::strlen(sweep) >= sizeof(sweep) - 1 ||
        std::strlen(sweep_v2) >= sizeof(sweep_v2) - 1 ||
        std::strlen(manifest) >= sizeof(manifest) - 1 ||
        std::strlen(diagnostics_dir) >= sizeof(diagnostics_dir) - 1 ||
        std::strlen(solver_diagnostics) >= sizeof(solver_diagnostics) - 1 ||
        std::strlen(progress) >= sizeof(progress) - 1 ||
        std::strlen(mesh_dir) >= sizeof(mesh_dir) - 1 ||
        std::strlen(periodic_pairs) >= sizeof(periodic_pairs) - 1) {
        std::snprintf(error_message, 128, "periodic-airbox coupled block artifact path exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    const std::uint64_t delta_m_tangent_dof_count =
        request.periodic_airbox_delta_m_tangent_dof_count;
    const std::uint64_t delta_phi_dof_count =
        request.periodic_airbox_delta_phi_dof_count;
    const std::uint64_t coupled_complex_dof_count =
        delta_m_tangent_dof_count + delta_phi_dof_count;
    const char *dynamic_demag_matrix_form = "schur_phi_consistency_provider";
    std::string frequency_point_paths_json = "[";
    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point_path[96]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "response/frequency_points/frequency_%04llu.json",
            static_cast<unsigned long long>(frequency_index));
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            !append_format(
                frequency_point_paths_json,
                error_message,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                frequency_point_path)) {
            std::snprintf(error_message, 128, "failed to format periodic-airbox coupled block frequency point paths");
            return FrequencyDomainStatus::artifact_error;
        }
    }
    frequency_point_paths_json += "]";

    std::string diagnostics_json;
    std::string progress_json;
    std::string manifest_json;
    std::string periodic_pairs_json;
    std::string sweep_json;
    std::string sweep_v2_json;
    const bool has_magnetostatic_pairs =
        request.periodic_airbox_magnetostatic_periodic_node_pair_count > 0 &&
        request.periodic_airbox_magnetostatic_periodic_node_pairs != nullptr;
    const std::uint64_t magnetostatic_periodic_pair_count =
        has_magnetostatic_pairs
            ? request.periodic_airbox_magnetostatic_periodic_node_pair_count
            : 0;
    const bool floquet_airbox =
        request.requires_floquet_airbox_dynamic_demag;
    const char *spin_wave_bc = floquet_airbox ? "floquet" : "periodic";
    const char *magnetic_bc = floquet_airbox ? "floquet" : "periodic";
    const char *magnetostatic_bc = floquet_airbox
        ? "floquet_airbox"
        : "periodic_airbox_k0";
    const char *periodic_pair_phase_convention = floquet_airbox
        ? "exp_minus_i_k_dot_delta_r"
        : "zero_phase_periodic_airbox_k0";
    const char *delta_phi_flux_validation_status = floquet_airbox
        ? phi_gauge_diagnostics.delta_phi_flux_validation_status
        : "not_applicable";
    const char *delta_phi_flux_validation_reason = floquet_airbox
        ? phi_gauge_diagnostics.delta_phi_flux_validation_reason
        : "no_floquet_airbox_delta_phi_constraint";
    const std::string domain_mesh_mode_field = domain_mesh_mode_json_field(request);
    const std::string coupled_block_norms_json =
        coupled_block_norms_diagnostics_json(validation_result, error_message);
    const char *artifact_status =
        run_status != nullptr && run_status[0] != '\0' ? run_status : "ok";
    if (complete && std::strcmp(artifact_status, "ok") == 0) {
        artifact_status = "ready";
    }
    const char *progress_state = complete ? "completed" : artifact_status;
    const bool partial_artifacts_available =
        !complete || validation_result.completed_frequency_count > 0;
    const bool solve_error_artifact =
        !complete && std::strcmp(artifact_status, "solve_error") == 0;
    char current_frequency_hz_json[64]{};
    if (request.solve_request.frequencies_hz != nullptr &&
        request.solve_request.frequency_count > 0 &&
        (validation_result.completed_frequency_count > 0 || solve_error_artifact)) {
        const std::uint64_t max_index = request.solve_request.frequency_count - 1;
        const std::uint64_t requested_index =
            solve_error_artifact
                ? validation_result.completed_frequency_count
                : validation_result.completed_frequency_count - 1;
        const std::uint64_t frequency_index =
            requested_index < max_index ? requested_index : max_index;
        std::snprintf(
            current_frequency_hz_json,
            sizeof(current_frequency_hz_json),
            "%.17g",
            request.solve_request.frequencies_hz[frequency_index]);
    } else {
        std::snprintf(current_frequency_hz_json, sizeof(current_frequency_hz_json), "null");
    }
    const char *extra_diagnostics =
        extra_diagnostics_json != nullptr ? extra_diagnostics_json : "";
    const DrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem &coupled_problem =
        request.periodic_airbox_coupled_block_problem;
    const bool write_field_payloads = request.solve_request.write_response_fields;
    const bool write_spatial_field_payloads =
        write_field_payloads &&
        request.mfem_validation_problem.nodes != nullptr &&
        request.mfem_validation_problem.descriptor.node_count > 0 &&
        request.mfem_validation_problem.descriptor.tangent_dof_count ==
            delta_m_tangent_dof_count &&
        request.mfem_validation_problem.descriptor.tangent_dof_count ==
            request.mfem_validation_problem.descriptor.node_count * 2 &&
        request.mfem_validation_problem.descriptor.full_dof_count ==
            request.mfem_validation_problem.descriptor.node_count * 3;
    const double excitation_phase_rad = drive_global_phase_rad(
        coupled_problem.drive_real,
        coupled_problem.drive_imag,
        delta_m_tangent_dof_count);
    const char *residual_source = "matrix_free_gmres";
    const char *sweep_solver_model = "matrix_free_gmres";
    const char *lane_classification = "fem_cpu_production";
    const char *engine = "native_fem_mfem_frequency_domain_cpu";
    const char *native_backend = "native_mfem_matrix_free";
    const char *solver_library = "native_gmres";
    const char *preconditioner_kind =
        validation_result.krylov_preconditioner[0] != '\0'
            ? validation_result.krylov_preconditioner
            : "none";
    const char *preconditioner_setup =
        validation_result.right_preconditioner_applied ? "ok" : "not_configured";
    const std::string gmres_history_json =
        gmres_relative_residual_history_json(validation_result, error_message);
    std::string field_payload_resources_json = "[";
    std::string sweep_v2_point_paths_json = "[";
    std::string sweep_v2_payload_paths_json = "[";
    std::string points_json = "[";
    std::vector<std::string> frequency_point_jsons;
    frequency_point_jsons.reserve(
        static_cast<std::size_t>(validation_result.completed_frequency_count));
    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point_path[96]{};
        char field_payload_path[96]{};
        char tangent_field_payload_path[96]{};
        char field_payload_path_json[128]{};
        char tangent_field_payload_path_json[128]{};
        char compatibility_field_payload_path_json[128]{};
        char storage_metadata_json[512]{};
        char sweep_reuse_json[256]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "response/frequency_points/frequency_%04llu.json",
            static_cast<unsigned long long>(frequency_index));
        int payload_path_written = 0;
        int tangent_payload_path_written = 0;
        int payload_path_json_written =
            std::snprintf(field_payload_path_json, sizeof(field_payload_path_json), "null");
        int tangent_payload_path_json_written =
            std::snprintf(tangent_field_payload_path_json, sizeof(tangent_field_payload_path_json), "null");
        int compatibility_payload_path_json_written =
            std::snprintf(compatibility_field_payload_path_json, sizeof(compatibility_field_payload_path_json), "null");
        int storage_metadata_written =
            std::snprintf(storage_metadata_json, sizeof(storage_metadata_json), "\"storage_format\":null");
        if (write_field_payloads) {
            payload_path_written = std::snprintf(
                field_payload_path,
                sizeof(field_payload_path),
                write_spatial_field_payloads ?
                    "response/field_payloads.zarr/frequency_%04llu/vector_xyz_complex/0.0.0" :
                    "response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0",
                static_cast<unsigned long long>(frequency_index));
            if (payload_path_written >= 0 &&
                static_cast<std::size_t>(payload_path_written) < sizeof(field_payload_path)) {
                payload_path_json_written = std::snprintf(
                    field_payload_path_json,
                    sizeof(field_payload_path_json),
                    "\"%s\"",
                    field_payload_path);
            }
            tangent_payload_path_written = std::snprintf(
                tangent_field_payload_path,
                sizeof(tangent_field_payload_path),
                "response/field_payloads.zarr/frequency_%04llu/vector_tangent_complex/0.0.0",
                static_cast<unsigned long long>(frequency_index));
            if (tangent_payload_path_written >= 0 &&
                static_cast<std::size_t>(tangent_payload_path_written) < sizeof(tangent_field_payload_path)) {
                tangent_payload_path_json_written = std::snprintf(
                    tangent_field_payload_path_json,
                    sizeof(tangent_field_payload_path_json),
                    "\"%s\"",
                    tangent_field_payload_path);
            }
            compatibility_payload_path_json_written = std::snprintf(
                compatibility_field_payload_path_json,
                sizeof(compatibility_field_payload_path_json),
                write_spatial_field_payloads ?
                    "\"response/field_payloads/frequency_%04llu/vector_xyz.bin\"" :
                    "\"response/field_payloads/frequency_%04llu/vector.bin\"",
                static_cast<unsigned long long>(frequency_index));
            storage_metadata_written = std::snprintf(
                storage_metadata_json,
                sizeof(storage_metadata_json),
                "\"storage_format\":\"zarr\","
                "\"zarr_store_path\":\"response/field_payloads.zarr\","
                "\"zarr_array_path\":\"response/field_payloads.zarr/frequency_%04llu/%s\","
                "\"zarr_chunk_path\":%s,"
                "\"zarr_dtype\":\"<f8\","
                "\"zarr_shape\":[%llu,%u,2],"
                "\"zarr_chunk_shape\":[%llu,%u,2],"
                "\"zarr_compressor\":null,"
                "\"compatibility_binary_payload_path\":%s",
                static_cast<unsigned long long>(frequency_index),
                write_spatial_field_payloads ? "vector_xyz_complex" : "vector_tangent_complex",
                field_payload_path_json,
                static_cast<unsigned long long>(
                    write_spatial_field_payloads
                        ? request.mfem_validation_problem.descriptor.node_count
                        : delta_m_tangent_dof_count / 2),
                write_spatial_field_payloads ? 3u : 2u,
                static_cast<unsigned long long>(
                    write_spatial_field_payloads
                        ? request.mfem_validation_problem.descriptor.node_count
                        : delta_m_tangent_dof_count / 2),
                write_spatial_field_payloads ? 3u : 2u,
                compatibility_field_payload_path_json);
        }
        const int sweep_reuse_written =
            frequency_index == 0 ?
                std::snprintf(
                    sweep_reuse_json,
                    sizeof(sweep_reuse_json),
                    "{\"operator_template_reused\":true,\"warm_start\":null}") :
                std::snprintf(
                    sweep_reuse_json,
                    sizeof(sweep_reuse_json),
                    "{\"operator_template_reused\":true,"
                    "\"warm_start\":{\"kind\":\"previous_frequency_response\","
                    "\"source_frequency_rad_per_s\":%.17g,"
                    "\"residual_l2_norm\":null,"
                    "\"relative_residual_l2_norm\":null}}",
                    request.solve_request.frequencies_hz[frequency_index - 1] *
                        6.28318530717958647692);
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            payload_path_json_written < 0 ||
            static_cast<std::size_t>(payload_path_json_written) >= sizeof(field_payload_path_json) ||
            tangent_payload_path_json_written < 0 ||
            static_cast<std::size_t>(tangent_payload_path_json_written) >= sizeof(tangent_field_payload_path_json) ||
            compatibility_payload_path_json_written < 0 ||
            static_cast<std::size_t>(compatibility_payload_path_json_written) >= sizeof(compatibility_field_payload_path_json) ||
            storage_metadata_written < 0 ||
            static_cast<std::size_t>(storage_metadata_written) >= sizeof(storage_metadata_json) ||
            sweep_reuse_written < 0 ||
            static_cast<std::size_t>(sweep_reuse_written) >= sizeof(sweep_reuse_json) ||
            (write_field_payloads &&
                (payload_path_written < 0 ||
                    static_cast<std::size_t>(payload_path_written) >= sizeof(field_payload_path) ||
                    tangent_payload_path_written < 0 ||
                    static_cast<std::size_t>(tangent_payload_path_written) >= sizeof(tangent_field_payload_path)))) {
            std::snprintf(error_message, 128, "failed to format periodic-airbox coupled block sweep paths");
            return FrequencyDomainStatus::artifact_error;
        }

        const std::uint64_t response_offset =
            frequency_index * coupled_complex_dof_count;
        const double angular_frequency_rad_per_s =
            request.solve_request.frequencies_hz[frequency_index] * 6.28318530717958647692;
        ResponsePointSeriesJson series{};
        if (!build_response_point_series_json(
                response_real + response_offset,
                response_imag + response_offset,
                delta_m_tangent_dof_count,
                series,
                error_message)) {
            return FrequencyDomainStatus::artifact_error;
        }
        const ResponsePointObservableJson observables =
            build_response_point_observable_json(
                response_real + response_offset,
                response_imag + response_offset,
                coupled_problem.drive_real,
                coupled_problem.drive_imag,
                delta_m_tangent_dof_count,
                angular_frequency_rad_per_s,
                nullptr,
                0,
                0.0);
        std::string delta_phi_complex;
        if (!append_complex_response_array(
                delta_phi_complex,
                error_message,
                response_real,
                response_imag,
                response_offset + delta_m_tangent_dof_count,
                delta_phi_dof_count)) {
            return FrequencyDomainStatus::artifact_error;
        }
        std::string coupled_demag_json;
        if (!append_format(
                coupled_demag_json,
                error_message,
                "\"requested_magnetic_bc\":\"%s\","
                "\"resolved_magnetic_bc\":\"%s\","
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"coupled_complex_dof_count\":%llu,"
                "\"demag_contribution\":{\"status\":\"solved\","
                "\"solver_model\":\"%s\","
                "\"operator_source\":\"%s\","
                "\"dynamic_demag_matrix_form\":\"%s\","
                "\"mfem_coupled_block_assembly\":false,"
                "\"phi_nullspace_detected\":%s,"
                "\"phi_gauge_policy\":\"%s\","
                "\"phi_gauge_constraint_applied\":%s,"
                "\"delta_phi_phase_validation_status\":\"%s\","
                "\"delta_phi_phase_max_residual\":%.17g,"
                "\"delta_phi_flux_validation_status\":\"%s\","
                "\"delta_phi_flux_validation_reason\":\"%s\","
                "\"delta_phi_complex\":%s,"
                "\"h_demag_complex\":null,"
                "\"energy_density\":null,"
                "\"unsupported_reason\":null},",
                magnetic_bc,
                magnetic_bc,
                magnetostatic_bc,
                magnetostatic_bc,
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(coupled_complex_dof_count),
                frequency_point_solver_model,
                operator_source,
                dynamic_demag_matrix_form,
                phi_gauge_diagnostics.phi_nullspace_detected ? "true" : "false",
                phi_gauge_diagnostics.phi_gauge_policy,
                phi_gauge_diagnostics.phi_gauge_constraint_applied ? "true" : "false",
                phi_gauge_diagnostics.delta_phi_phase_validation_status,
                phi_gauge_diagnostics.delta_phi_phase_max_residual,
                delta_phi_flux_validation_status,
                delta_phi_flux_validation_reason,
                delta_phi_complex.c_str())) {
            return FrequencyDomainStatus::artifact_error;
        }
        if (!append_format(
                points_json,
                error_message,
                "%s{\"frequency_index\":%llu,"
                "\"frequency_point_artifact_path\":\"%s\","
                "\"response_field_payload_path\":%s,"
                "\"response_tangent_field_payload_path\":%s,"
                "%s,"
                "\"frequency_hz\":%.17g,"
                "\"angular_frequency_rad_per_s\":%.17g,"
                "\"m_complex\":%s,"
                "\"response_amplitude\":%.17g,"
                "\"response_phase\":%.17g,"
                "\"phase_rad\":%.17g,"
                "\"component_response_amplitude\":%s,"
                "\"component_response_phase\":%s,"
                "%s"
                "\"susceptibility_tensor\":%s,"
                "\"susceptibility_tensor_provenance\":%s,"
                "\"absorbed_power_density\":%.17g,"
                "\"absorbed_power_density_provenance\":%s,"
                "\"residual_l2_norm\":%.17g,"
                "\"relative_residual_l2_norm\":%.17g,"
                "\"residual_source\":\"%s\","
                "\"tangent_leakage\":%s,"
                "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
                "\"sweep_reuse\":%s}",
                frequency_index == 0 ? "" : ",",
                static_cast<unsigned long long>(frequency_index),
                frequency_point_path,
                field_payload_path_json,
                tangent_field_payload_path_json,
                storage_metadata_json,
                request.solve_request.frequencies_hz[frequency_index],
                angular_frequency_rad_per_s,
                series.m_complex.c_str(),
                series.response_amplitude,
                series.response_phase,
                series.response_phase,
                series.component_amplitude.c_str(),
                series.component_phase.c_str(),
                coupled_demag_json.c_str(),
                observables.susceptibility_tensor.c_str(),
                observables.susceptibility_provenance.c_str(),
                observables.absorbed_power_density,
                observables.absorbed_power_density_provenance.c_str(),
                residual_l2_norm[frequency_index],
                relative_residual_l2_norm[frequency_index],
                residual_source,
                observables.tangent_leakage.c_str(),
                excitation_phase_rad,
                sweep_reuse_json)) {
            return FrequencyDomainStatus::artifact_error;
        }
        std::string frequency_point_json;
        const char *field_payload_key =
            write_field_payloads ? "\"field_payload_path\":%s," : "\"field_payload_path\":null,";
        if (!append_format(
                frequency_point_json,
                error_message,
                "{\"schema_version\":\"frequency_response_point.v1\","
                "\"frequency_index\":%llu,"
                "\"frequency_hz\":%.17g,"
                "\"status\":\"ok\","
                "\"complete\":true,"
                "\"angular_frequency_rad_per_s\":%.17g,"
                "\"m_complex\":%s,"
                "\"response_amplitude\":%.17g,"
                "\"response_phase\":%.17g,"
                "\"phase_rad\":%.17g,"
                "\"component_response_amplitude\":%s,"
                "\"component_response_phase\":%s,"
                "%s"
                "\"susceptibility_tensor\":%s,"
                "\"susceptibility_tensor_provenance\":%s,"
                "\"absorbed_power_density\":%.17g,"
                "\"absorbed_power_density_provenance\":%s,"
                "\"residual_l2_norm\":%.17g,"
                "\"relative_residual_l2_norm\":%.17g,"
                "\"residual_source\":\"%s\","
                "\"tangent_leakage\":%s,"
                "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
                "\"sweep_reuse\":%s,",
                static_cast<unsigned long long>(frequency_index),
                request.solve_request.frequencies_hz[frequency_index],
                angular_frequency_rad_per_s,
                series.m_complex.c_str(),
                series.response_amplitude,
                series.response_phase,
                series.response_phase,
                series.component_amplitude.c_str(),
                series.component_phase.c_str(),
                coupled_demag_json.c_str(),
                observables.susceptibility_tensor.c_str(),
                observables.susceptibility_provenance.c_str(),
                observables.absorbed_power_density,
                observables.absorbed_power_density_provenance.c_str(),
                residual_l2_norm[frequency_index],
                relative_residual_l2_norm[frequency_index],
                residual_source,
                observables.tangent_leakage.c_str(),
                excitation_phase_rad,
                sweep_reuse_json) ||
            !append_format(
                frequency_point_json,
                error_message,
                field_payload_key,
                field_payload_path_json) ||
            !append_format(
                frequency_point_json,
                error_message,
                "\"tangent_field_payload_path\":%s,"
                "%s,"
                "\"payload_encoding\":\"%s\","
                "\"tangent_payload_encoding\":\"f64_interleaved_real_imag_tangent\","
                "\"binary_layout\":\"complex_f64_pairs_little_endian\","
                "\"value_kind\":\"%s\","
                "\"component_basis\":\"%s\","
                "\"component_count\":%u,"
                "\"components\":%s,"
                "\"complex_pair_count\":%llu,"
                "\"payload_value_count\":%llu,"
                "\"tangent_value_kind\":\"complex_tangent_vector\","
                "\"tangent_component_basis\":\"local_tangent_frame\","
                "\"tangent_component_count\":2,"
                "\"tangent_components\":[\"tangent_e1\",\"tangent_e2\"],"
                "\"tangent_complex_pair_count\":%llu,"
                "\"tangent_payload_value_count\":%llu,"
                "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"],"
                "\"default_view\":\"phase_rotated_real\","
                "\"default_phase_rad\":0.0}",
                tangent_field_payload_path_json,
                storage_metadata_json,
                write_field_payloads
                    ? (write_spatial_field_payloads
                        ? "f64_interleaved_real_imag_xyz"
                        : "f64_interleaved_real_imag_tangent")
                    : "not_written",
                write_spatial_field_payloads
                    ? "complex_spatial_vector"
                    : "complex_tangent_vector",
                write_spatial_field_payloads
                    ? "global_xyz"
                    : "local_tangent_frame",
                write_spatial_field_payloads ? 3u : 2u,
                write_spatial_field_payloads
                    ? "[\"x\",\"y\",\"z\"]"
                    : "[\"tangent_e1\",\"tangent_e2\"]",
                static_cast<unsigned long long>(
                    write_spatial_field_payloads
                        ? request.mfem_validation_problem.descriptor.full_dof_count
                        : delta_m_tangent_dof_count),
                static_cast<unsigned long long>(
                    write_field_payloads
                        ? (write_spatial_field_payloads
                            ? request.mfem_validation_problem.descriptor.full_dof_count * 2
                            : delta_m_tangent_dof_count * 2)
                        : 0),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count * 2))) {
            return FrequencyDomainStatus::artifact_error;
        }
        frequency_point_jsons.push_back(frequency_point_json);
        if (!append_format(
                sweep_v2_point_paths_json,
                error_message,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                frequency_point_path)) {
            return FrequencyDomainStatus::artifact_error;
        }
        if (write_field_payloads &&
            (!append_format(
                field_payload_resources_json,
                error_message,
                "%s{\"frequency_index\":%llu,"
                "\"field_resource_id\":\"analysis:frequency-response:frequency-%04llu\","
                "\"storage_format\":\"zarr\","
                "\"payload_path\":\"%s\"}",
                frequency_index == 0 ? "" : ",",
                static_cast<unsigned long long>(frequency_index),
                static_cast<unsigned long long>(frequency_index),
                field_payload_path) ||
             !append_format(
                sweep_v2_payload_paths_json,
                error_message,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                field_payload_path))) {
            return FrequencyDomainStatus::artifact_error;
        }
    }
    field_payload_resources_json += "]";
    sweep_v2_point_paths_json += "]";
    sweep_v2_payload_paths_json += "]";
    points_json += "]";
    if (!append_format(
            periodic_pairs_json,
            error_message,
            "{\"schema_version\":\"periodic_pairs.v1\","
            "\"source\":\"native_fem_frequency_domain_coupled_block\","
            "\"validation_status\":\"metadata_only\","
            "\"pair_count\":%llu,"
            "\"paired_node_count\":%llu,"
            "\"unpaired_source_count\":0,"
            "\"unpaired_destination_count\":0,"
            "\"tolerance_m\":0.0,"
            "\"max_translation_residual_m\":0.0,"
            "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0},"
            "\"magnetic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_node_pair_count\":%llu,"
            "\"delta_phi_flux_validation_status\":\"%s\","
            "\"delta_phi_flux_validation_reason\":\"%s\","
            "\"pairs\":[",
            static_cast<unsigned long long>(magnetostatic_periodic_pair_count),
            static_cast<unsigned long long>(magnetostatic_periodic_pair_count * 2),
            static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
            static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
            static_cast<unsigned long long>(
                request.periodic_airbox_magnetostatic_periodic_node_pair_count),
            delta_phi_flux_validation_status,
            delta_phi_flux_validation_reason)) {
        return FrequencyDomainStatus::artifact_error;
    }
    if (has_magnetostatic_pairs) {
        for (std::uint64_t pair_index = 0;
             pair_index < request.periodic_airbox_magnetostatic_periodic_node_pair_count;
             ++pair_index) {
            const std::uint64_t node_a =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2];
            const std::uint64_t node_b =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2 + 1];
            const FrequencyDomainFloquetPeriodicPair *phase_metadata =
                floquet_airbox
                    ? find_oriented_floquet_pair(request, node_a, node_b)
                    : nullptr;
            const double translation_x =
                phase_metadata != nullptr ? phase_metadata->translation_m[0] : 0.0;
            const double translation_y =
                phase_metadata != nullptr ? phase_metadata->translation_m[1] : 0.0;
            const double translation_z =
                phase_metadata != nullptr ? phase_metadata->translation_m[2] : 0.0;
            const double phase_rad =
                phase_metadata != nullptr ? phase_metadata->phase_rad : 0.0;
            if (!append_format(
                    periodic_pairs_json,
                    error_message,
                    "%s{\"pair_id\":\"magnetostatic-delta-phi-%04llu\","
                    "\"pair_family\":\"magnetostatic_delta_phi\","
                    "\"unknown_family\":\"delta_phi\","
                    "\"source_marker\":\"delta_phi_node:%llu\","
                    "\"destination_marker\":\"delta_phi_node:%llu\","
                    "\"node_a\":%llu,"
                    "\"node_b\":%llu,"
                    "\"expected_translation_m\":[%.17g,%.17g,%.17g],"
                    "\"translation_m\":[%.17g,%.17g,%.17g],"
                    "\"paired_node_count\":2,"
                    "\"unpaired_source_count\":0,"
                    "\"unpaired_destination_count\":0,"
                    "\"translation_residual_m\":0.0,"
                    "\"phase_rad\":%.17g,"
                    "\"phase_convention\":\"%s\","
                    "\"delta_phi_flux_validation_status\":\"%s\","
                    "\"delta_phi_flux_validation_reason\":\"%s\","
                    "\"validation_status\":\"metadata_only\"}",
                    pair_index == 0 ? "" : ",",
                    static_cast<unsigned long long>(pair_index),
                    static_cast<unsigned long long>(node_a),
                    static_cast<unsigned long long>(node_b),
                    static_cast<unsigned long long>(node_a),
                    static_cast<unsigned long long>(node_b),
                    translation_x,
                    translation_y,
                    translation_z,
                    translation_x,
                    translation_y,
                    translation_z,
                    phase_rad,
                    periodic_pair_phase_convention,
                    delta_phi_flux_validation_status,
                    delta_phi_flux_validation_reason)) {
                return FrequencyDomainStatus::artifact_error;
            }
        }
    }
    periodic_pairs_json += "]}";

    if (!append_format(
            sweep_json,
            error_message,
            "{\"schema_version\":\"magnetic_response_sweep.v1\","
            "\"backend_engine_id\":\"native_fem_mfem\","
            "\"solver_model\":\"%s\","
            "\"damping_policy\":\"linearized_llg_tangent\","
            "\"lane_classification\":\"%s\","
            "\"matrix_layout\":\"matrix_free_block_real\","
            "\"excitation_kind\":\"uniform_field\","
            "\"si_units\":{\"frequency\":\"Hz\",\"angular_frequency\":\"rad/s\"},"
            "\"point_count\":%llu,"
            "\"points\":%s}",
            sweep_solver_model,
            lane_classification,
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            points_json.c_str()) ||
        !append_format(
            sweep_v2_json,
            error_message,
            "{\"schema_version\":\"magnetic_response_sweep.v2\","
            "\"solve_kind\":\"direct_harmonic_response\","
            "\"complete\":%s,"
            "\"completed_frequency_point_count\":%llu,"
            "\"point_count\":%llu,"
            "\"frequency_point_artifact_path\":\"response/frequency_points/frequency_0000.json\","
            "\"response_field_payload_path\":%s,"
            "\"frequency_point_artifact_paths\":%s,"
            "\"response_field_payload_paths\":%s,"
            "\"points\":%s}",
            complete ? "true" : "false",
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            write_field_payloads && validation_result.completed_frequency_count > 0
                ? (write_spatial_field_payloads
                    ? "\"response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0\""
                    : "\"response/field_payloads.zarr/frequency_0000/vector_tangent_complex/0.0.0\"")
                : "null",
            sweep_v2_point_paths_json.c_str(),
            sweep_v2_payload_paths_json.c_str(),
            points_json.c_str())) {
        return FrequencyDomainStatus::artifact_error;
    }

    if (!append_format(
            diagnostics_json,
            error_message,
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"status\":\"%s\","
            "\"complete\":%s,"
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"solver_kind\":\"%s\","
            "\"matrix_form\":\"iomega_B_minus_L\","
            "\"phasor_convention\":\"%s\","
            "\"requested_execution_lane\":\"production_cpu\","
            "\"resolved_execution_lane\":\"production_cpu\","
            "\"production_solver_requested\":true,"
            "\"production_solver_available\":true,"
            "\"validation_fallback_used\":false,"
            "\"assembled_mfem_operator_solver\":false,"
            "\"dense_block_real_solver\":false,"
            "\"matrix_free_solver\":true,"
            "\"krylov_solver\":\"gmres\","
            "\"krylov_preconditioner_kind\":\"%s\","
            "\"krylov_preconditioner_applied\":%s,"
            "\"krylov_preconditioner_setup_status\":\"%s\","
            "\"gmres_relative_residual_history\":%s,"
            "\"coupled_residual_partition_status\":\"%s\","
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"dynamic_demag_matrix_form\":\"%s\","
            "\"requested_magnetic_bc\":\"%s\","
            "\"resolved_magnetic_bc\":\"%s\","
            "\"requested_magnetostatic_bc\":\"%s\","
            "\"resolved_magnetostatic_bc\":\"%s\","
            "\"magnetic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_constraint_set_count\":%llu,"
            "\"delta_m_tangent_dof_count\":%llu,"
            "\"delta_phi_dof_count\":%llu,"
            "\"magnetostatic_periodic_node_pair_count\":%llu,"
            "\"coupled_complex_dof_count\":%llu,"
            "%s"
            "%s"
            "\"phi_nullspace_detected\":%s,"
            "\"phi_gauge_policy\":\"%s\","
            "\"phi_gauge_constraint_applied\":%s,"
            "\"delta_phi_phase_validation_status\":\"%s\","
            "\"delta_phi_phase_max_residual\":%.17g,"
            "\"delta_phi_flux_validation_status\":\"%s\","
            "\"delta_phi_flux_validation_reason\":\"%s\","
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"max_abs_response\":%.17g,"
            "\"residual_l2_norm\":%.17g,"
            "\"relative_residual_l2_norm\":%.17g%s}",
            artifact_status,
            complete ? "true" : "false",
            solver_kind,
            phase_convention_to_string(request.phase_convention),
            preconditioner_kind,
            validation_result.right_preconditioner_applied ? "true" : "false",
            preconditioner_setup,
            gmres_history_json.c_str(),
            validation_result.coupled_residual_partition_status,
            operator_source,
            dynamic_demag_matrix_form,
            magnetic_bc,
            magnetic_bc,
            magnetostatic_bc,
            magnetostatic_bc,
            static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
            static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
            static_cast<unsigned long long>(delta_m_tangent_dof_count),
            static_cast<unsigned long long>(delta_phi_dof_count),
            static_cast<unsigned long long>(
                request.periodic_airbox_magnetostatic_periodic_node_pair_count),
            static_cast<unsigned long long>(coupled_complex_dof_count),
            coupled_block_norms_json.c_str(),
            extra_diagnostics,
            phi_gauge_diagnostics.phi_nullspace_detected ? "true" : "false",
            phi_gauge_diagnostics.phi_gauge_policy,
            phi_gauge_diagnostics.phi_gauge_constraint_applied ? "true" : "false",
            phi_gauge_diagnostics.delta_phi_phase_validation_status,
            phi_gauge_diagnostics.delta_phi_phase_max_residual,
            delta_phi_flux_validation_status,
            delta_phi_flux_validation_reason,
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            validation_result.max_abs_response,
            validation_result.residual_l2_norm,
            validation_result.relative_residual_l2_norm,
            domain_mesh_mode_field.c_str()) ||
        !append_sweep_progress_artifact_json(
            progress_json,
            error_message,
            artifact_status,
            complete,
            progress_state,
            request.solve_request.frequency_count,
            validation_result.completed_frequency_count,
            validation_result.completed_frequency_count,
            current_frequency_hz_json,
            partial_artifacts_available,
            "frequency_domain/manifest.v1.json") ||
        !append_format(
            manifest_json,
            error_message,
            "{\"schema_version\":\"frequency_domain_manifest.v1\","
            "\"analysis_family\":\"magnetic_frequency_domain\","
            "\"study_product\":\"driven_response\","
            "\"revision\":\"%s\","
            "\"created_at\":\"1970-01-01T00:00:00Z\","
            "\"session_id\":\"native-validation\","
            "\"run_id\":\"native-validation\","
            "\"stage_id\":\"frequency-response-production\","
            "\"stage_kind\":\"frequency_response\","
            "\"status\":\"%s\","
            "\"complete\":%s,"
            "\"requested_execution\":{\"solve_equation\":\"(i omega B - L) q = f\","
            "\"solve_kind\":\"direct_harmonic_response\","
            "\"study_kind\":\"frequency_response\","
            "\"frequency_count\":%llu,"
            "\"write_response_fields\":%s},"
            "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
            "\"engine\":\"%s\","
            "\"native_backend\":\"%s\","
            "\"reference_or_production\":\"production\","
            "\"solver_model\":\"%s\","
            "\"solver_library\":\"%s\","
            "\"solver_kind\":\"%s\","
            "\"solve_kind\":\"direct_harmonic_response\","
            "\"lane_classification\":\"%s\","
            "\"production_solver\":true,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"resolved_execution_lane\":\"production_cpu\","
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"dynamic_demag_matrix_form\":\"%s\"},"
            "\"physics\":{\"analysis_family\":\"frequency_domain\","
            "\"llg_gamma0_si\":%.17g,"
            "\"llg_alpha\":%.17g,"
            "\"frequency_units\":\"Hz\","
            "\"field_units\":\"A_per_m\","
            "\"normalization\":\"linear_response_tangent\","
            "\"phase_convention\":\"%s\","
            "\"spin_wave_bc\":{\"kind\":\"%s\"},"
            "\"periodic_or_floquet\":true,"
            "\"requested_spin_wave_bc\":\"%s\","
            "\"resolved_spin_wave_bc\":\"%s\","
            "\"requested_magnetic_bc\":\"%s\","
            "\"resolved_magnetic_bc\":\"%s\","
            "\"requested_magnetostatic_bc\":\"%s\","
            "\"resolved_magnetostatic_bc\":\"%s\","
            "\"magnetic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_constraint_set_count\":%llu,"
            "\"delta_m_tangent_dof_count\":%llu,"
            "\"delta_phi_dof_count\":%llu,"
            "\"magnetostatic_periodic_node_pair_count\":%llu,"
            "\"coupled_complex_dof_count\":%llu,"
            "\"phi_nullspace_detected\":%s,"
            "\"phi_gauge_policy\":\"%s\","
            "\"phi_gauge_constraint_applied\":%s,"
            "\"delta_phi_phase_validation_status\":\"%s\","
            "\"delta_phi_phase_max_residual\":%.17g},"
            "\"delta_phi_flux_validation_status\":\"%s\","
            "\"delta_phi_flux_validation_reason\":\"%s\","
            "\"artifacts\":{\"response_sweep_v1_path\":\"response/magnetic_response_sweep.v1.json\","
            "\"response_sweep_v2_path\":\"response/magnetic_response_sweep.v2.json\","
            "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
            "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
            "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\","
            "\"response_progress_v1_path\":\"response/progress.v1.json\","
            "\"response_map_v1_path\":null,"
            "\"response_map_v2_path\":null,"
            "\"frequency_point_paths\":%s},"
            "\"resources\":{\"response_sweep_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep\","
            "\"response_progress_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/progress.v1\","
            "\"response_diagnostics_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1\","
            "\"response_map_resource_key\":null,"
            "\"response_field_resources\":%s},"
            "\"diagnostics\":{\"requested_execution_lane\":\"production_cpu\","
            "\"resolved_execution_lane\":\"production_cpu\","
            "\"validation_fallback_used\":false,"
            "\"assembled_mfem_operator_solver\":false,"
            "\"dense_block_real_solver\":false,"
            "\"matrix_free_solver\":true,"
            "\"krylov_solver\":\"gmres\","
            "\"krylov_preconditioner_kind\":\"%s\","
            "\"krylov_preconditioner_applied\":%s,"
            "\"krylov_preconditioner_setup_status\":\"%s\","
            "\"gmres_relative_residual_history\":%s,"
            "\"coupled_residual_partition_status\":\"%s\","
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"dynamic_demag_matrix_form\":\"%s\","
            "\"requested_magnetostatic_bc\":\"%s\","
            "\"resolved_magnetostatic_bc\":\"%s\","
            "%s"
            "%s"
            "\"requested_frequency_count\":%llu,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"residual_l2_norm\":%.17g,"
            "\"relative_residual_l2_norm\":%.17g%s},"
            "\"capabilities\":{\"production_solver_available\":true,"
            "\"production_native_solver_available\":true,"
            "\"validation_artifact\":false,"
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"dynamic_demag_matrix_form\":\"%s\","
            "\"dynamic_demag_k_available\":false,"
            "\"floquet_response_available\":false,"
            "\"gpu_available\":false}}",
            revision,
            artifact_status,
            complete ? "true" : "false",
            static_cast<unsigned long long>(request.solve_request.frequency_count),
            request.solve_request.write_response_fields ? "true" : "false",
            engine,
            native_backend,
            sweep_solver_model,
            solver_library,
            solver_kind,
            lane_classification,
            operator_source,
            dynamic_demag_matrix_form,
            request.solve_request.operator_request.gamma0,
            request.solve_request.operator_request.alpha,
            phase_convention_to_string(request.phase_convention),
            spin_wave_bc,
            spin_wave_bc,
            spin_wave_bc,
            magnetic_bc,
            magnetic_bc,
            magnetostatic_bc,
            magnetostatic_bc,
            static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
            static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
            static_cast<unsigned long long>(delta_m_tangent_dof_count),
            static_cast<unsigned long long>(delta_phi_dof_count),
            static_cast<unsigned long long>(
                request.periodic_airbox_magnetostatic_periodic_node_pair_count),
            static_cast<unsigned long long>(coupled_complex_dof_count),
            phi_gauge_diagnostics.phi_nullspace_detected ? "true" : "false",
            phi_gauge_diagnostics.phi_gauge_policy,
            phi_gauge_diagnostics.phi_gauge_constraint_applied ? "true" : "false",
            phi_gauge_diagnostics.delta_phi_phase_validation_status,
            phi_gauge_diagnostics.delta_phi_phase_max_residual,
            delta_phi_flux_validation_status,
            delta_phi_flux_validation_reason,
            frequency_point_paths_json.c_str(),
            field_payload_resources_json.c_str(),
            preconditioner_kind,
            validation_result.right_preconditioner_applied ? "true" : "false",
            preconditioner_setup,
            gmres_history_json.c_str(),
            validation_result.coupled_residual_partition_status,
            operator_source,
            dynamic_demag_matrix_form,
            magnetostatic_bc,
            magnetostatic_bc,
            coupled_block_norms_json.c_str(),
            extra_diagnostics,
            static_cast<unsigned long long>(request.solve_request.frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            validation_result.residual_l2_norm,
            validation_result.relative_residual_l2_norm,
            domain_mesh_mode_field.c_str(),
            operator_source,
            dynamic_demag_matrix_form)) {
        return FrequencyDomainStatus::artifact_error;
    }

    FrequencyDomainStatus status = ensure_directory(request.output_directory, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(frequency_domain_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(response_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(frequency_points_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (write_field_payloads) {
        status = ensure_directory(field_payloads_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(field_payloads_zarr_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_zarr_group_artifact(field_payloads_zarr_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_response_zarr_store_attrs(field_payloads_zarr_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    status = ensure_directory(diagnostics_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = ensure_directory(mesh_dir, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(periodic_pairs, periodic_pairs_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(sweep, sweep_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(sweep_v2, sweep_v2_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(progress, progress_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(manifest, manifest_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }

    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point_path[256]{};
        char field_payload_dir[256]{};
        char zarr_frequency_group_dir[256]{};
        char zarr_tangent_array_dir[256]{};
        char zarr_spatial_array_dir[256]{};
        char zarr_tangent_chunk[256]{};
        char zarr_spatial_chunk[256]{};
        char field_payload[256]{};
        char spatial_field_payload[256]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "%s/frequency_%04llu.json",
            frequency_points_dir,
            static_cast<unsigned long long>(frequency_index));
        if (write_field_payloads &&
            (std::snprintf(
                 field_payload_dir,
                 sizeof(field_payload_dir),
                 "%s/frequency_%04llu",
                 field_payloads_dir,
                 static_cast<unsigned long long>(frequency_index)) < 0 ||
             std::snprintf(
                 zarr_frequency_group_dir,
                 sizeof(zarr_frequency_group_dir),
                 "%s/frequency_%04llu",
                 field_payloads_zarr_dir,
                 static_cast<unsigned long long>(frequency_index)) < 0 ||
             std::snprintf(
                 zarr_tangent_array_dir,
                 sizeof(zarr_tangent_array_dir),
                 "%s/vector_tangent_complex",
                 zarr_frequency_group_dir) < 0 ||
             std::snprintf(
                 zarr_spatial_array_dir,
                 sizeof(zarr_spatial_array_dir),
                 "%s/vector_xyz_complex",
                 zarr_frequency_group_dir) < 0 ||
             std::snprintf(zarr_tangent_chunk, sizeof(zarr_tangent_chunk), "%s/0.0.0", zarr_tangent_array_dir) < 0 ||
             std::snprintf(zarr_spatial_chunk, sizeof(zarr_spatial_chunk), "%s/0.0.0", zarr_spatial_array_dir) < 0 ||
             std::snprintf(field_payload, sizeof(field_payload), "%s/vector.bin", field_payload_dir) < 0 ||
             std::snprintf(spatial_field_payload, sizeof(spatial_field_payload), "%s/vector_xyz.bin", field_payload_dir) < 0)) {
            std::snprintf(error_message, 128, "failed to format periodic-airbox coupled block frequency point artifact path");
            return FrequencyDomainStatus::artifact_error;
        }
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            (write_field_payloads &&
                (std::strlen(field_payload_dir) >= sizeof(field_payload_dir) - 1 ||
                 std::strlen(zarr_frequency_group_dir) >= sizeof(zarr_frequency_group_dir) - 1 ||
                 std::strlen(zarr_tangent_array_dir) >= sizeof(zarr_tangent_array_dir) - 1 ||
                 std::strlen(zarr_spatial_array_dir) >= sizeof(zarr_spatial_array_dir) - 1 ||
                 std::strlen(zarr_tangent_chunk) >= sizeof(zarr_tangent_chunk) - 1 ||
                 std::strlen(zarr_spatial_chunk) >= sizeof(zarr_spatial_chunk) - 1 ||
                 std::strlen(field_payload) >= sizeof(field_payload) - 1 ||
                 std::strlen(spatial_field_payload) >= sizeof(spatial_field_payload) - 1))) {
            std::snprintf(error_message, 128, "periodic-airbox coupled block frequency point artifact path exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        if (frequency_index >= frequency_point_jsons.size()) {
            std::snprintf(error_message, 128, "missing periodic-airbox coupled block frequency point JSON");
            return FrequencyDomainStatus::artifact_error;
        }
        status = write_text_artifact(
            frequency_point_path,
            frequency_point_jsons[static_cast<std::size_t>(frequency_index)].c_str(),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (!write_field_payloads) {
            continue;
        }
        status = ensure_directory(field_payload_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(zarr_frequency_group_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_zarr_group_artifact(zarr_frequency_group_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(zarr_tangent_array_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_response_zarr_array_artifacts(
            zarr_tangent_array_dir,
            delta_m_tangent_dof_count / 2,
            2,
            "[\"tangent_e1\",\"tangent_e2\"]",
            "local_tangent_frame",
            "complex_tangent_vector",
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        const std::uint64_t response_offset =
            frequency_index * coupled_complex_dof_count;
        std::vector<double> tangent_payload(
            static_cast<std::size_t>(delta_m_tangent_dof_count * 2));
        for (std::uint64_t dof = 0; dof < delta_m_tangent_dof_count; ++dof) {
            tangent_payload[static_cast<std::size_t>(dof * 2)] =
                response_real[response_offset + dof];
            tangent_payload[static_cast<std::size_t>(dof * 2 + 1)] =
                response_imag[response_offset + dof];
        }
        status = write_binary_artifact(
            zarr_tangent_chunk,
            tangent_payload.data(),
            tangent_payload.size() * sizeof(double),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_binary_artifact(
            field_payload,
            tangent_payload.data(),
            tangent_payload.size() * sizeof(double),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (!write_spatial_field_payloads) {
            continue;
        }
        status = ensure_directory(zarr_spatial_array_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_response_zarr_array_artifacts(
            zarr_spatial_array_dir,
            request.mfem_validation_problem.descriptor.node_count,
            3,
            "[\"x\",\"y\",\"z\"]",
            "global_xyz",
            "complex_spatial_vector",
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        const std::uint64_t node_count =
            request.mfem_validation_problem.descriptor.node_count;
        const std::uint64_t full_dof_count =
            request.mfem_validation_problem.descriptor.full_dof_count;
        std::vector<double> spatial_real(static_cast<std::size_t>(full_dof_count));
        std::vector<double> spatial_imag(static_cast<std::size_t>(full_dof_count));
        std::vector<double> spatial_payload(static_cast<std::size_t>(full_dof_count * 2));
        lift_tangent_to_full(
            request.mfem_validation_problem.nodes,
            response_real + response_offset,
            node_count,
            spatial_real.data());
        lift_tangent_to_full(
            request.mfem_validation_problem.nodes,
            response_imag + response_offset,
            node_count,
            spatial_imag.data());
        for (std::uint64_t dof = 0; dof < full_dof_count; ++dof) {
            spatial_payload[static_cast<std::size_t>(dof * 2)] = spatial_real[dof];
            spatial_payload[static_cast<std::size_t>(dof * 2 + 1)] = spatial_imag[dof];
        }
        status = write_binary_artifact(
            zarr_spatial_chunk,
            spatial_payload.data(),
            spatial_payload.size() * sizeof(double),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_binary_artifact(
            spatial_field_payload,
            spatial_payload.data(),
            spatial_payload.size() * sizeof(double),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }

    std::snprintf(manifest_path, 256, "%s", manifest);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus solve_unavailable_production_lane(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const char *lane_name = execution_lane_to_string(request.execution_lane);
    const char *reason = request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu
        ? "native FEM frequency-domain production GPU solver is not implemented"
        : "native FEM frequency-domain production CPU solver is not implemented";
    char manifest_path[256]{};
    char artifact_error[128]{};
    FrequencyDomainStatus artifact_status = write_unavailable_response_artifacts(
        request,
        reason,
        nullptr,
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }

    char diagnostics_json[1024]{};
    char result_json[384]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"unavailable\","
        "\"requested_execution_lane\":\"%s\","
        "\"production_solver_requested\":true,"
        "\"production_solver_available\":false,"
        "\"completed_frequency_point_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"validation_fallback_used\":false}",
        lane_name);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"unavailable\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"requested_execution_lane\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"artifact_manifest_path\":\"%s\"}",
        lane_name,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "production frequency response unavailable result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::unavailable;
    assign_result_strings(
        result,
        reason,
        diagnostics_json,
        result_json,
        manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_mfem_production_cpu_problem(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    const std::uint64_t tangent_dof_count =
        request.solve_request.operator_request.tangent_dof_count;
    if (!problem.enabled || problem.drive_real == nullptr) {
        return solve_unavailable_production_lane(request, result);
    }
    if (problem.descriptor.tangent_dof_count != tangent_dof_count ||
        problem.layout.tangent_dof_count != tangent_dof_count ||
        problem.descriptor.node_count == 0 ||
        problem.nodes == nullptr) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "MFEM production CPU frequency response requires matching tangent layout and nodes",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }

    MfemProductionCpuOperatorAdapter adapter{};
    adapter.request = &request;
    adapter.zeeman_blocks.resize(static_cast<std::size_t>(problem.descriptor.node_count));
    adapter.uniaxial_anisotropy_blocks.resize(static_cast<std::size_t>(problem.descriptor.node_count));
    adapter.exchange_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.zeeman_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.uniaxial_anisotropy_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.dmi_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.dmi_delta_xyz.resize(static_cast<std::size_t>(problem.descriptor.full_dof_count));
    adapter.dmi_residual_xyz.resize(static_cast<std::size_t>(problem.descriptor.full_dof_count));
    adapter.dmi_field_xyz.resize(static_cast<std::size_t>(problem.descriptor.full_dof_count));
    adapter.demag_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.effective_field_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.stiffness_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.mass_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.projected_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    const bool floquet_phase_projection =
        can_solve_floquet_projected_no_demag_response(request);
    char projection_error[128]{};
    if (!build_static_periodic_representatives(
            problem,
            adapter.static_periodic_representative_node,
            adapter.static_periodic_representative_count,
            projection_error)) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            projection_error,
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }
    constexpr double static_periodic_tolerance = 1.0e-10;
    const double static_periodic_frame_mismatch =
        max_static_periodic_frame_mismatch(
            adapter.static_periodic_representative_node,
            problem);
    if (static_periodic_frame_mismatch > static_periodic_tolerance) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "static periodic projection requires matching equilibrium tangent frames",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }

    std::vector<double> response_real(static_cast<std::size_t>(tangent_dof_count * request.solve_request.frequency_count));
    std::vector<double> response_imag(static_cast<std::size_t>(tangent_dof_count * request.solve_request.frequency_count));
    std::vector<double> residual_l2_norm(static_cast<std::size_t>(request.solve_request.frequency_count));
    std::vector<double> relative_residual_l2_norm(static_cast<std::size_t>(request.solve_request.frequency_count));
    std::vector<double> projected_drive_real;
    std::vector<double> projected_drive_imag;
    const double *drive_real = problem.drive_real;
    const double *drive_imag = problem.drive_imag;
    const bool static_periodic_projection =
        !adapter.static_periodic_representative_node.empty();
    double static_periodic_drive_max_mismatch = 0.0;
    if (static_periodic_projection) {
        static_periodic_drive_max_mismatch =
            max_static_periodic_tangent_mismatch(
                adapter.static_periodic_representative_node,
                problem.drive_real);
        if (problem.drive_imag != nullptr) {
            static_periodic_drive_max_mismatch = std::max(
                static_periodic_drive_max_mismatch,
                max_static_periodic_tangent_mismatch(
                    adapter.static_periodic_representative_node,
                    problem.drive_imag));
        }
        if (static_periodic_drive_max_mismatch > static_periodic_tolerance) {
            result.status = FrequencyDomainStatus::validation_error;
            assign_result_strings(
                result,
                "static periodic driven response requires periodic tangent drive values",
                status_diagnostics_json(FrequencyDomainStatus::validation_error),
                status_result_json(FrequencyDomainStatus::validation_error),
                "");
            return result.status;
        }
        projected_drive_real.resize(static_cast<std::size_t>(tangent_dof_count));
        project_static_periodic_tangent(
            adapter.static_periodic_representative_node,
            adapter.static_periodic_representative_count,
            problem.drive_real,
            projected_drive_real.data());
        drive_real = projected_drive_real.data();
        if (problem.drive_imag != nullptr) {
            projected_drive_imag.resize(static_cast<std::size_t>(tangent_dof_count));
            project_static_periodic_tangent(
                adapter.static_periodic_representative_node,
                adapter.static_periodic_representative_count,
                problem.drive_imag,
                projected_drive_imag.data());
            drive_imag = projected_drive_imag.data();
        }
    }
    const char *demag_tangent_operator_source =
        mfem_demag_tangent_operator_source(problem);
    const bool periodic_airbox_dynamic_demag =
        request.requires_periodic_airbox_dynamic_demag;
    const char *requested_magnetostatic_bc =
        periodic_airbox_dynamic_demag ? "periodic_airbox_k0" : "open";
    const char *resolved_magnetostatic_bc = requested_magnetostatic_bc;
    const double solver_relative_tolerance =
        production_frequency_response_relative_tolerance();
    const std::uint64_t solver_max_iterations =
        production_frequency_response_max_iterations();
    const std::uint64_t solver_restart_iterations =
        production_frequency_response_restart_iterations(solver_max_iterations);
    const std::uint64_t solver_progress_interval =
        production_frequency_response_progress_interval();

    MfemDrivenResponseValidationResult demag_tangent_probe_result{};
    char demag_tangent_probe_error[128]{};
    const FrequencyDomainStatus demag_tangent_probe_status =
        probe_mfem_demag_tangent_linearity(
            problem,
            demag_tangent_probe_result,
            demag_tangent_probe_error);
    if (demag_tangent_probe_status != FrequencyDomainStatus::ok) {
        result.status = demag_tangent_probe_status;
        assign_result_strings(
            result,
            demag_tangent_probe_error,
            status_diagnostics_json(demag_tangent_probe_status),
            status_result_json(demag_tangent_probe_status),
            "");
        return result.status;
    }

    char preconditioner_setup_error[128]{};
    const FrequencyDomainStatus preconditioner_setup_status =
        setup_mfem_tangent_block_jacobi_preconditioner(
            adapter,
            preconditioner_setup_error);
    if (preconditioner_setup_status != FrequencyDomainStatus::ok) {
        result.status = preconditioner_setup_status;
        assign_result_strings(
            result,
            preconditioner_setup_error,
            status_diagnostics_json(preconditioner_setup_status),
            status_result_json(preconditioner_setup_status),
            "");
        return result.status;
    }

    ProductionCpuDrivenResponseResult production_result{};
    const FrequencyDomainStatus solve_status = solve_production_cpu_driven_response(
        ProductionCpuDrivenResponseProblem{
            tangent_dof_count,
            request.solve_request.frequencies_hz,
            request.solve_request.frequency_count,
            drive_real,
            apply_mfem_production_cpu_stiffness,
            apply_mfem_production_cpu_mass,
            &adapter,
            solver_relative_tolerance,
            solver_max_iterations,
            solver_restart_iterations,
            response_real.data(),
            response_imag.data(),
            tangent_dof_count * request.solve_request.frequency_count,
            residual_l2_norm.data(),
            relative_residual_l2_norm.data(),
            request.solve_request.frequency_count,
            request.cancel_requested,
            request.cancel_user_data,
            request.progress_callback,
            request.progress_user_data,
            drive_imag,
            angular_frequency_sign(request.phase_convention),
            floquet_phase_projection ? project_floquet_phase_block : nullptr,
            floquet_phase_projection ? &adapter : nullptr,
            solver_progress_interval,
            adapter.graph_preconditioner_enabled ?
                apply_mfem_tangent_graph_demag_coarse_right_preconditioner :
                adapter.demag_coarse_preconditioner_enabled ?
                apply_mfem_tangent_demag_coarse_right_preconditioner :
                adapter.block_jacobi_preconditioner_enabled ?
                apply_mfem_tangent_block_jacobi_right_preconditioner :
                nullptr,
            adapter.block_jacobi_preconditioner_enabled ? &adapter : nullptr,
            adapter.graph_preconditioner_enabled ?
                "mfem_tangent_graph_demag_coarse_right" :
                adapter.demag_coarse_preconditioner_enabled ?
                "mfem_tangent_demag_coarse_right" :
                adapter.block_jacobi_preconditioner_enabled ?
                "mfem_tangent_block_jacobi_right" :
                nullptr,
            periodic_airbox_dynamic_demag
                ? request.periodic_airbox_delta_m_tangent_dof_count
                : 0,
            periodic_airbox_dynamic_demag
                ? request.periodic_airbox_delta_phi_dof_count
                : 0,
            periodic_airbox_dynamic_demag
                ? "magnetic_only_demag_tangent_provider"
                : nullptr,
        },
        &production_result);
    DrivenFrequencyResponseSolveRequest artifact_request = request;
    artifact_request.mfem_validation_problem.drive_real = drive_real;
    artifact_request.mfem_validation_problem.drive_imag = drive_imag;
    if (solve_status == FrequencyDomainStatus::interrupted) {
        MfemDrivenResponseValidationResult artifact_result{};
        artifact_result.completed_frequency_count = production_result.completed_frequency_count;
        artifact_result.response_dof_count = production_result.response_dof_count;
        artifact_result.response_frequency_count = production_result.completed_frequency_count;
        artifact_result.max_frequency_hz = production_result.max_frequency_hz;
        artifact_result.max_abs_response = production_result.max_abs_response;
        artifact_result.total_iteration_count = production_result.total_iteration_count;
        artifact_result.max_iterations_for_frequency =
            production_result.max_iterations_for_frequency;
        artifact_result.restart_iterations_for_frequency =
            production_result.restart_iterations_for_frequency;
        artifact_result.progress_interval_iterations =
            production_result.progress_interval_iterations;
        copy_production_cpu_preconditioner_diagnostics(production_result, artifact_result);
        artifact_result.solver_relative_tolerance =
            production_result.solver_relative_tolerance;
        artifact_result.rhs_l2_norm = production_result.rhs_l2_norm;
        artifact_result.initial_residual_l2_norm =
            production_result.initial_residual_l2_norm;
        artifact_result.initial_relative_residual_l2_norm =
            production_result.initial_relative_residual_l2_norm;
        artifact_result.residual_l2_norm = production_result.residual_l2_norm;
        artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
        artifact_result.minimum_tracked_relative_residual_l2_norm =
            production_result.minimum_tracked_relative_residual_l2_norm;
        artifact_result.minimum_tracked_relative_residual_iteration =
            production_result.minimum_tracked_relative_residual_iteration;
        artifact_result.last_tracked_relative_residual_l2_norm =
            production_result.last_tracked_relative_residual_l2_norm;
        artifact_result.last_recomputed_relative_residual_l2_norm =
            production_result.last_recomputed_relative_residual_l2_norm;
        artifact_result.residual_growth_factor =
            production_result.residual_growth_factor;
        copy_demag_tangent_linearity_diagnostics(
            demag_tangent_probe_result,
            artifact_result);
        char diagnostics_json[3000]{};
        char result_json[512]{};
        char manifest_path[256]{};
        char artifact_error[128]{};
        const FrequencyDomainStatus artifact_status = write_mfem_validation_artifacts(
            artifact_request,
            artifact_result,
            response_real.data(),
            response_imag.data(),
            residual_l2_norm.data(),
            relative_residual_l2_norm.data(),
            "interrupted",
            false,
            manifest_path,
            artifact_error);
        if (artifact_status != FrequencyDomainStatus::ok) {
            result.status = artifact_status;
            assign_result_strings(
                result,
                artifact_error,
                status_diagnostics_json(FrequencyDomainStatus::unavailable),
                status_result_json(FrequencyDomainStatus::unavailable),
                "");
            return result.status;
        }
        const std::uint64_t written_artifacts =
            has_output_directory(request.output_directory) && request.write_partial_artifacts ?
            production_result.completed_frequency_count :
            0;
        const int diagnostics_written = std::snprintf(
            diagnostics_json,
            sizeof(diagnostics_json),
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"status\":\"interrupted\","
            "\"complete\":false,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"production_solver_requested\":true,"
            "\"production_solver_available\":true,"
            "\"validation_fallback_used\":false,"
            "\"matrix_free_solver\":true,"
            "\"demag_tangent_operator_source\":\"%s\","
            "\"demag_tangent_linearity_check\":%s,"
            "\"demag_tangent_additivity_max_abs_error\":%.17g,"
            "\"demag_tangent_homogeneity_max_abs_error\":%.17g,"
            "\"demag_tangent_additivity_relative_error\":%.17g,"
            "\"demag_tangent_homogeneity_relative_error\":%.17g,"
            "\"krylov_solver\":\"gmres\","
            "\"krylov_preconditioner_kind\":\"%s\","
            "\"krylov_preconditioner_applied\":%s,"
            "\"krylov_preconditioner_setup_status\":\"%s\","
            "\"assembled_mfem_operator_solver\":false,"
            "\"requested_magnetostatic_bc\":\"%s\","
            "\"resolved_magnetostatic_bc\":\"%s\","
            "\"periodic_airbox_coupled_block_solver\":false,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"static_periodic_projection\":%s,"
            "\"floquet_phase_projection\":%s,"
            "\"floquet_real_imag_mixing\":%s,"
            "\"static_periodic_node_pair_count\":%llu,"
            "\"static_periodic_frame_max_mismatch\":%.17g,"
            "\"static_periodic_drive_max_mismatch\":%.17g,"
            "\"partial_artifacts_available\":%s,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu}",
            demag_tangent_operator_source,
            demag_tangent_probe_result.demag_tangent_linearity_check ? "true" : "false",
            demag_tangent_probe_result.demag_tangent_additivity_max_abs_error,
            demag_tangent_probe_result.demag_tangent_homogeneity_max_abs_error,
            demag_tangent_probe_result.demag_tangent_additivity_relative_error,
            demag_tangent_probe_result.demag_tangent_homogeneity_relative_error,
            production_result.krylov_preconditioner,
            production_result.right_preconditioner_applied ? "true" : "false",
            production_result.right_preconditioner_applied ? "ok" : "not_configured",
            requested_magnetostatic_bc,
            resolved_magnetostatic_bc,
            static_periodic_projection ? "true" : "false",
            floquet_phase_projection ? "true" : "false",
            floquet_phase_projection ? "true" : "false",
            static_cast<unsigned long long>(problem.static_periodic_node_pair_count),
            static_periodic_frame_mismatch,
            static_periodic_drive_max_mismatch,
            written_artifacts > 0 ? "true" : "false",
            static_cast<unsigned long long>(production_result.completed_frequency_count),
            static_cast<unsigned long long>(written_artifacts));
        const int result_written = std::snprintf(
            result_json,
            sizeof(result_json),
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"status\":\"interrupted\","
            "\"completed_frequency_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"partial_artifacts_available\":%s,"
            "\"artifact_manifest_path\":\"%s\"}",
            static_cast<unsigned long long>(production_result.completed_frequency_count),
            static_cast<unsigned long long>(written_artifacts),
            written_artifacts > 0 ? "true" : "false",
            manifest_path);
        if (diagnostics_written < 0 ||
            result_written < 0 ||
            static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
            static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                "MFEM production CPU interrupted result JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::unavailable),
                status_result_json(FrequencyDomainStatus::unavailable),
                "");
            return result.status;
        }

        result.status = FrequencyDomainStatus::interrupted;
        result.completed_frequency_count = production_result.completed_frequency_count;
        result.written_frequency_point_artifacts = written_artifacts;
        assign_result_strings(
            result,
            production_result.error_message,
            diagnostics_json,
            result_json,
            manifest_path);
        return result.status;
    }
    if (solve_status != FrequencyDomainStatus::ok) {
        MfemDrivenResponseValidationResult artifact_result{};
        artifact_result.completed_frequency_count = production_result.completed_frequency_count;
        artifact_result.response_dof_count = production_result.response_dof_count;
        artifact_result.response_frequency_count = production_result.completed_frequency_count;
        artifact_result.max_frequency_hz = production_result.max_frequency_hz;
        artifact_result.max_abs_response = production_result.max_abs_response;
        artifact_result.total_iteration_count = production_result.total_iteration_count;
        artifact_result.max_iterations_for_frequency =
            production_result.max_iterations_for_frequency;
        artifact_result.restart_iterations_for_frequency =
            production_result.restart_iterations_for_frequency;
        artifact_result.progress_interval_iterations =
            production_result.progress_interval_iterations;
        artifact_result.solver_relative_tolerance =
            production_result.solver_relative_tolerance;
        artifact_result.rhs_l2_norm = production_result.rhs_l2_norm;
        artifact_result.initial_residual_l2_norm =
            production_result.initial_residual_l2_norm;
        artifact_result.initial_relative_residual_l2_norm =
            production_result.initial_relative_residual_l2_norm;
        artifact_result.residual_l2_norm = production_result.residual_l2_norm;
        artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
        artifact_result.minimum_tracked_relative_residual_l2_norm =
            production_result.minimum_tracked_relative_residual_l2_norm;
        artifact_result.minimum_tracked_relative_residual_iteration =
            production_result.minimum_tracked_relative_residual_iteration;
        artifact_result.last_tracked_relative_residual_l2_norm =
            production_result.last_tracked_relative_residual_l2_norm;
        artifact_result.last_recomputed_relative_residual_l2_norm =
            production_result.last_recomputed_relative_residual_l2_norm;
        artifact_result.residual_growth_factor =
            production_result.residual_growth_factor;
        copy_production_cpu_preconditioner_diagnostics(production_result, artifact_result);
        copy_demag_tangent_linearity_diagnostics(
            demag_tangent_probe_result,
            artifact_result);
        char manifest_path[256]{};
        char artifact_error[128]{};
        const FrequencyDomainStatus artifact_status = write_mfem_validation_artifacts(
            artifact_request,
            artifact_result,
            response_real.data(),
            response_imag.data(),
            residual_l2_norm.data(),
            relative_residual_l2_norm.data(),
            status_to_string(solve_status),
            false,
            manifest_path,
            artifact_error);
        if (artifact_status != FrequencyDomainStatus::ok) {
            result.status = artifact_status;
            assign_result_strings(
                result,
                artifact_error,
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }

        char diagnostics_json[3000]{};
        char result_json[512]{};
        const bool failure_artifacts_available =
            has_output_directory(request.output_directory) && request.write_partial_artifacts;
        const int diagnostics_written = std::snprintf(
            diagnostics_json,
            sizeof(diagnostics_json),
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"status\":\"%s\","
            "\"complete\":false,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"production_solver_requested\":true,"
            "\"production_solver_available\":true,"
            "\"validation_fallback_used\":false,"
            "\"matrix_free_solver\":true,"
            "\"demag_tangent_operator_source\":\"%s\","
            "\"demag_tangent_linearity_check\":%s,"
            "\"demag_tangent_additivity_max_abs_error\":%.17g,"
            "\"demag_tangent_homogeneity_max_abs_error\":%.17g,"
            "\"demag_tangent_additivity_relative_error\":%.17g,"
            "\"demag_tangent_homogeneity_relative_error\":%.17g,"
            "\"krylov_solver\":\"gmres\","
            "\"krylov_preconditioner_kind\":\"%s\","
            "\"krylov_preconditioner_applied\":%s,"
            "\"krylov_preconditioner_setup_status\":\"%s\","
            "\"assembled_mfem_operator_solver\":false,"
            "\"requested_magnetostatic_bc\":\"%s\","
            "\"resolved_magnetostatic_bc\":\"%s\","
            "\"periodic_airbox_coupled_block_solver\":false,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"static_periodic_projection\":%s,"
            "\"floquet_phase_projection\":%s,"
            "\"floquet_real_imag_mixing\":%s,"
            "\"static_periodic_node_pair_count\":%llu,"
            "\"static_periodic_frame_max_mismatch\":%.17g,"
            "\"static_periodic_drive_max_mismatch\":%.17g,"
            "\"partial_artifacts_available\":%s,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":0,"
            "\"tangent_dof_count\":%llu,"
            "\"total_iteration_count\":%llu,"
            "\"max_iterations_for_frequency\":%llu,"
            "\"restart_iterations_for_frequency\":%llu,"
            "\"progress_interval_iterations\":%llu,"
            "\"solver_relative_tolerance\":%.17g,"
            "\"rhs_l2_norm\":%.17g,"
            "\"initial_residual_l2_norm\":%.17g,"
            "\"initial_relative_residual_l2_norm\":%.17g,"
            "\"minimum_tracked_relative_residual_l2_norm\":%.17g,"
            "\"minimum_tracked_relative_residual_iteration\":%llu,"
            "\"last_tracked_relative_residual_l2_norm\":%.17g,"
            "\"last_recomputed_relative_residual_l2_norm\":%.17g,"
            "\"residual_growth_factor\":%.17g,"
            "\"residual_l2_norm\":%.17g,"
            "\"relative_residual_l2_norm\":%.17g}",
            status_to_string(solve_status),
            demag_tangent_operator_source,
            demag_tangent_probe_result.demag_tangent_linearity_check ? "true" : "false",
            demag_tangent_probe_result.demag_tangent_additivity_max_abs_error,
            demag_tangent_probe_result.demag_tangent_homogeneity_max_abs_error,
            demag_tangent_probe_result.demag_tangent_additivity_relative_error,
            demag_tangent_probe_result.demag_tangent_homogeneity_relative_error,
            production_result.krylov_preconditioner,
            production_result.right_preconditioner_applied ? "true" : "false",
            production_result.right_preconditioner_applied ? "ok" : "not_configured",
            requested_magnetostatic_bc,
            resolved_magnetostatic_bc,
            static_periodic_projection ? "true" : "false",
            floquet_phase_projection ? "true" : "false",
            floquet_phase_projection ? "true" : "false",
            static_cast<unsigned long long>(problem.static_periodic_node_pair_count),
            static_periodic_frame_mismatch,
            static_periodic_drive_max_mismatch,
            failure_artifacts_available ? "true" : "false",
            static_cast<unsigned long long>(production_result.completed_frequency_count),
            static_cast<unsigned long long>(tangent_dof_count),
            static_cast<unsigned long long>(production_result.total_iteration_count),
            static_cast<unsigned long long>(production_result.max_iterations_for_frequency),
            static_cast<unsigned long long>(production_result.restart_iterations_for_frequency),
            static_cast<unsigned long long>(production_result.progress_interval_iterations),
            production_result.solver_relative_tolerance,
            production_result.rhs_l2_norm,
            production_result.initial_residual_l2_norm,
            production_result.initial_relative_residual_l2_norm,
            production_result.minimum_tracked_relative_residual_l2_norm,
            static_cast<unsigned long long>(
                production_result.minimum_tracked_relative_residual_iteration),
            production_result.last_tracked_relative_residual_l2_norm,
            production_result.last_recomputed_relative_residual_l2_norm,
            production_result.residual_growth_factor,
            production_result.residual_l2_norm,
            production_result.relative_residual_l2_norm);
        const int result_written = std::snprintf(
            result_json,
            sizeof(result_json),
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"status\":\"%s\","
            "\"completed_frequency_count\":%llu,"
            "\"written_frequency_point_artifacts\":0,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"partial_artifacts_available\":%s,"
            "\"artifact_manifest_path\":\"%s\"}",
            status_to_string(solve_status),
            static_cast<unsigned long long>(production_result.completed_frequency_count),
            failure_artifacts_available ? "true" : "false",
            manifest_path);
        if (diagnostics_written < 0 ||
            result_written < 0 ||
            static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
            static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                "MFEM production CPU failure result JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }
        result.status = solve_status;
        result.completed_frequency_count = production_result.completed_frequency_count;
        result.written_frequency_point_artifacts = 0;
        assign_result_strings(
            result,
            production_result.error_message,
            diagnostics_json,
            result_json,
            manifest_path);
        return result.status;
    }

    MfemDrivenResponseValidationResult artifact_result{};
    artifact_result.completed_frequency_count = production_result.completed_frequency_count;
    artifact_result.response_dof_count = production_result.response_dof_count;
    artifact_result.response_frequency_count = production_result.completed_frequency_count;
    artifact_result.max_frequency_hz = production_result.max_frequency_hz;
    artifact_result.max_abs_response = production_result.max_abs_response;
    artifact_result.total_iteration_count = production_result.total_iteration_count;
    artifact_result.max_iterations_for_frequency =
        production_result.max_iterations_for_frequency;
    artifact_result.restart_iterations_for_frequency =
        production_result.restart_iterations_for_frequency;
    artifact_result.progress_interval_iterations =
        production_result.progress_interval_iterations;
    artifact_result.solver_relative_tolerance =
        production_result.solver_relative_tolerance;
    artifact_result.rhs_l2_norm = production_result.rhs_l2_norm;
    artifact_result.initial_residual_l2_norm =
        production_result.initial_residual_l2_norm;
    artifact_result.initial_relative_residual_l2_norm =
        production_result.initial_relative_residual_l2_norm;
    artifact_result.residual_l2_norm = production_result.residual_l2_norm;
    artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
    artifact_result.minimum_tracked_relative_residual_l2_norm =
        production_result.minimum_tracked_relative_residual_l2_norm;
    artifact_result.minimum_tracked_relative_residual_iteration =
        production_result.minimum_tracked_relative_residual_iteration;
    artifact_result.last_tracked_relative_residual_l2_norm =
        production_result.last_tracked_relative_residual_l2_norm;
    artifact_result.last_recomputed_relative_residual_l2_norm =
        production_result.last_recomputed_relative_residual_l2_norm;
    artifact_result.residual_growth_factor =
        production_result.residual_growth_factor;
    copy_production_cpu_preconditioner_diagnostics(production_result, artifact_result);
    copy_demag_tangent_linearity_diagnostics(
        demag_tangent_probe_result,
        artifact_result);
    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status = write_mfem_validation_artifacts(
        artifact_request,
        artifact_result,
        response_real.data(),
        response_imag.data(),
        residual_l2_norm.data(),
        relative_residual_l2_norm.data(),
        "ok",
        true,
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }
    const std::uint64_t written_artifacts = has_output_directory(request.output_directory) ?
        production_result.completed_frequency_count :
        0;
    const std::string direct_coupled_block_norms_json =
        coupled_block_norms_diagnostics_json(artifact_result, artifact_error);

    char diagnostics_json[4200]{};
    char result_json[768]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"requested_execution_lane\":\"production_cpu\","
        "\"production_solver_requested\":true,"
        "\"production_solver_available\":true,"
        "\"validation_fallback_used\":false,"
        "\"matrix_free_solver\":true,"
        "\"demag_tangent_operator_source\":\"%s\","
        "\"demag_tangent_linearity_check\":%s,"
        "\"demag_tangent_additivity_max_abs_error\":%.17g,"
        "\"demag_tangent_homogeneity_max_abs_error\":%.17g,"
        "\"demag_tangent_additivity_relative_error\":%.17g,"
        "\"demag_tangent_homogeneity_relative_error\":%.17g,"
        "\"krylov_solver\":\"gmres\","
        "\"krylov_preconditioner_kind\":\"%s\","
        "\"krylov_preconditioner_applied\":%s,"
        "\"krylov_preconditioner_setup_status\":\"%s\","
        "\"assembled_mfem_operator_solver\":false,"
        "\"requested_magnetostatic_bc\":\"%s\","
        "\"resolved_magnetostatic_bc\":\"%s\","
        "\"periodic_airbox_coupled_block_solver\":false,"
        "\"mfem_coupled_block_assembly\":false,"
        "%s"
        "\"static_periodic_projection\":%s,"
        "\"floquet_phase_projection\":%s,"
        "\"floquet_real_imag_mixing\":%s,"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"tangent_dof_count\":%llu,"
        "\"total_iteration_count\":%llu,"
        "\"max_iterations_for_frequency\":%llu,"
        "\"relative_residual_l2_norm\":%.17g}",
        demag_tangent_operator_source,
        demag_tangent_probe_result.demag_tangent_linearity_check ? "true" : "false",
        demag_tangent_probe_result.demag_tangent_additivity_max_abs_error,
        demag_tangent_probe_result.demag_tangent_homogeneity_max_abs_error,
        demag_tangent_probe_result.demag_tangent_additivity_relative_error,
        demag_tangent_probe_result.demag_tangent_homogeneity_relative_error,
        production_result.krylov_preconditioner,
        production_result.right_preconditioner_applied ? "true" : "false",
        production_result.right_preconditioner_applied ? "ok" : "not_configured",
        requested_magnetostatic_bc,
        resolved_magnetostatic_bc,
        direct_coupled_block_norms_json.c_str(),
        static_periodic_projection ? "true" : "false",
        floquet_phase_projection ? "true" : "false",
        floquet_phase_projection ? "true" : "false",
        static_cast<unsigned long long>(problem.static_periodic_node_pair_count),
        static_periodic_frame_mismatch,
        static_periodic_drive_max_mismatch,
        static_cast<unsigned long long>(production_result.completed_frequency_count),
        static_cast<unsigned long long>(written_artifacts),
        static_cast<unsigned long long>(tangent_dof_count),
        static_cast<unsigned long long>(production_result.total_iteration_count),
        static_cast<unsigned long long>(production_result.max_iterations_for_frequency),
        production_result.relative_residual_l2_norm);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"ok\","
        "\"completed_frequency_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"requested_execution_lane\":\"production_cpu\","
        "\"demag_tangent_operator_source\":\"%s\","
        "\"max_frequency_hz\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g,"
        "\"artifact_manifest_path\":\"%s\"}",
        static_cast<unsigned long long>(production_result.completed_frequency_count),
        static_cast<unsigned long long>(written_artifacts),
        demag_tangent_operator_source,
        production_result.max_frequency_hz,
        production_result.max_abs_response,
        production_result.relative_residual_l2_norm,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "MFEM production CPU response result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::ok;
    result.completed_frequency_count = production_result.completed_frequency_count;
    result.written_frequency_point_artifacts = written_artifacts;
    assign_result_strings(
        result,
        "",
        diagnostics_json,
        result_json,
        manifest_path);
    return result.status;
}

std::string included_operator_terms_json(
    const DrivenFrequencyResponseMfemValidationProblem &problem)
{
    std::string terms = "[";
    bool first = true;
    auto append = [&terms, &first](const char *term) {
        if (!first) {
            terms += ",";
        }
        terms += "\"";
        terms += term;
        terms += "\"";
        first = false;
    };
    if (problem.descriptor.exchange_enabled) {
        append("exchange");
    }
    if (problem.descriptor.zeeman_enabled) {
        append("zeeman");
    }
    if (problem.descriptor.uniaxial_anisotropy_enabled) {
        append("uniaxial_anisotropy");
    }
    if (problem.descriptor.demag_enabled || has_mfem_demag_tangent_operator(problem)) {
        append("demag");
    }
    terms += "]";
    return terms;
}

FrequencyDomainStatus solve_mfem_production_gpu_unavailable(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result,
    const char *unsupported_reason,
    const char *message) noexcept
{
    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status = write_unavailable_response_artifacts(
        request,
        message,
        unsupported_reason,
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }
    char diagnostics_json[1536]{};
    char result_json[1024]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"requested_execution_lane\":\"production_gpu\","
        "\"resolved_execution_lane\":\"unavailable\","
        "\"unsupported_reason\":\"%s\","
        "\"error_message\":\"%s\","
        "\"production_solver_requested\":true,"
        "\"production_solver_available\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"completed_frequency_point_count\":0,"
        "\"written_frequency_point_artifacts\":0}",
        unsupported_reason,
        message);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"unavailable\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"requested_execution_lane\":\"production_gpu\","
        "\"resolved_execution_lane\":\"unavailable\","
        "\"unsupported_reason\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"artifact_manifest_path\":\"%s\"}",
        unsupported_reason,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "MFEM production GPU unavailable result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }
    result.status = FrequencyDomainStatus::unavailable;
    assign_result_strings(result, message, diagnostics_json, result_json, manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_mfem_production_gpu_problem(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    const std::uint64_t tangent_dof_count =
        request.solve_request.operator_request.tangent_dof_count;
    if (!problem.enabled || problem.drive_real == nullptr) {
        return solve_mfem_production_gpu_unavailable(
            request,
            result,
            "missing_mfem_operator_payload",
            "native FEM frequency-domain production GPU requires an MFEM operator payload");
    }
    if ((problem.descriptor.demag_enabled ||
         request.solve_request.operator_request.demag_kind != FrequencyDomainDemagKind::none) &&
        problem.apply_demag_tangent == nullptr &&
        problem.demag_tangent_matrix_row_major == nullptr) {
        return solve_mfem_production_gpu_unavailable(
            request,
            result,
            "dynamic_demag_gpu_missing_tangent_provider",
            "native FEM frequency-domain production GPU dynamic demag requires a field-tangent provider or explicit demag tangent matrix");
    }
    if (request.magnetostatic_periodic_constraint_set_count > 0) {
        return solve_mfem_production_gpu_unavailable(
            request,
            result,
            "periodic_airbox_dynamic_demag_gpu_unsupported",
            "native FEM frequency-domain production GPU does not implement magnetostatic periodic airbox response");
    }
    if (problem.descriptor.dmi_enabled || problem.dmi_element_count > 0) {
        return solve_mfem_production_gpu_unavailable(
            request,
            result,
            "dmi_gpu_frequency_response_unsupported",
            "native FEM frequency-domain production GPU does not implement DMI response operators");
    }
    if (problem.descriptor.tangent_dof_count != tangent_dof_count ||
        problem.layout.tangent_dof_count != tangent_dof_count ||
        problem.descriptor.node_count == 0 ||
        problem.nodes == nullptr) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "MFEM production GPU frequency response requires matching tangent layout and nodes",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }

    MfemProductionGpuOperatorAdapter adapter{};
    adapter.request = &request;
    adapter.stiffness_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.mass_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.demag_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    adapter.projected_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
    const bool floquet_phase_projection =
        can_solve_floquet_projected_no_demag_response(request);
    char projection_error[128]{};
    if (!build_static_periodic_representatives(
            problem,
            adapter.static_periodic_representative_node,
            adapter.static_periodic_representative_count,
            projection_error)) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            projection_error,
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }
    if (request.magnetic_periodic_constraint_set_count > 0 &&
        adapter.static_periodic_representative_node.empty() &&
        !floquet_phase_projection) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "static periodic GPU frequency response requires node pair constraints",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }
    constexpr double static_periodic_tolerance = 1.0e-10;
    const double static_periodic_frame_mismatch =
        max_static_periodic_frame_mismatch(
            adapter.static_periodic_representative_node,
            problem);
    if (static_periodic_frame_mismatch > static_periodic_tolerance) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "static periodic GPU response requires matching equilibrium tangent frames",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }

    std::vector<double> response_real(static_cast<std::size_t>(tangent_dof_count * request.solve_request.frequency_count));
    std::vector<double> response_imag(static_cast<std::size_t>(tangent_dof_count * request.solve_request.frequency_count));
    std::vector<double> residual_l2_norm(static_cast<std::size_t>(request.solve_request.frequency_count));
    std::vector<double> relative_residual_l2_norm(static_cast<std::size_t>(request.solve_request.frequency_count));
    std::vector<double> projected_drive_real;
    std::vector<double> projected_drive_imag;
    const double *drive_real = problem.drive_real;
    const double *drive_imag = problem.drive_imag;
    const bool static_periodic_projection =
        !adapter.static_periodic_representative_node.empty();
    double static_periodic_drive_max_mismatch = 0.0;
    if (static_periodic_projection) {
        static_periodic_drive_max_mismatch =
            max_static_periodic_tangent_mismatch(
                adapter.static_periodic_representative_node,
                problem.drive_real);
        if (problem.drive_imag != nullptr) {
            static_periodic_drive_max_mismatch = std::max(
                static_periodic_drive_max_mismatch,
                max_static_periodic_tangent_mismatch(
                    adapter.static_periodic_representative_node,
                    problem.drive_imag));
        }
        if (static_periodic_drive_max_mismatch > static_periodic_tolerance) {
            result.status = FrequencyDomainStatus::validation_error;
            assign_result_strings(
                result,
                "static periodic GPU driven response requires periodic tangent drive values",
                status_diagnostics_json(FrequencyDomainStatus::validation_error),
                status_result_json(FrequencyDomainStatus::validation_error),
                "");
            return result.status;
        }
        projected_drive_real.resize(static_cast<std::size_t>(tangent_dof_count));
        project_static_periodic_tangent(
            adapter.static_periodic_representative_node,
            adapter.static_periodic_representative_count,
            problem.drive_real,
            projected_drive_real.data());
        drive_real = projected_drive_real.data();
        if (problem.drive_imag != nullptr) {
            projected_drive_imag.resize(static_cast<std::size_t>(tangent_dof_count));
            project_static_periodic_tangent(
                adapter.static_periodic_representative_node,
                adapter.static_periodic_representative_count,
                problem.drive_imag,
                projected_drive_imag.data());
            drive_imag = projected_drive_imag.data();
        }
    }

    const double solver_relative_tolerance =
        production_frequency_response_relative_tolerance();
    const std::uint64_t solver_max_iterations =
        production_frequency_response_max_iterations();
    const std::uint64_t solver_restart_iterations =
        production_frequency_response_restart_iterations(solver_max_iterations);
    const std::uint64_t solver_progress_interval =
        production_frequency_response_progress_interval();
    ProductionCpuDrivenResponseResult production_result{};
    const FrequencyDomainStatus solve_status = solve_production_cpu_driven_response(
        ProductionCpuDrivenResponseProblem{
            tangent_dof_count,
            request.solve_request.frequencies_hz,
            request.solve_request.frequency_count,
            drive_real,
            apply_mfem_production_gpu_stiffness,
            apply_mfem_production_gpu_mass,
            &adapter,
            solver_relative_tolerance,
            solver_max_iterations,
            solver_restart_iterations,
            response_real.data(),
            response_imag.data(),
            tangent_dof_count * request.solve_request.frequency_count,
            residual_l2_norm.data(),
            relative_residual_l2_norm.data(),
            request.solve_request.frequency_count,
            request.cancel_requested,
            request.cancel_user_data,
            request.progress_callback,
            request.progress_user_data,
            drive_imag,
            angular_frequency_sign(request.phase_convention),
            floquet_phase_projection ? project_floquet_phase_block : nullptr,
            floquet_phase_projection ? &adapter : nullptr,
            solver_progress_interval,
        },
        &production_result);
    if (solve_status != FrequencyDomainStatus::ok) {
        char diagnostics_json[1024]{};
        char result_json[512]{};
        const int diagnostics_written = std::snprintf(
            diagnostics_json,
            sizeof(diagnostics_json),
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"status\":\"%s\","
            "\"complete\":false,"
            "\"requested_execution_lane\":\"production_gpu\","
            "\"resolved_execution_lane\":\"production_gpu\","
            "\"production_solver_requested\":true,"
            "\"production_solver_available\":true,"
            "\"validation_fallback_used\":false,"
            "\"matrix_free_solver\":true,"
            "\"gpu_operator_solver\":true,"
            "\"floquet_phase_projection\":%s,"
            "\"floquet_real_imag_mixing\":%s,"
            "\"dense_block_real_solver\":false,"
            "\"krylov_solver\":\"gmres\","
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":0}",
            status_to_string(solve_status),
            floquet_phase_projection ? "true" : "false",
            floquet_phase_projection ? "true" : "false",
            static_cast<unsigned long long>(production_result.completed_frequency_count));
        const int result_written = std::snprintf(
            result_json,
            sizeof(result_json),
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"status\":\"%s\","
            "\"completed_frequency_count\":%llu,"
            "\"written_frequency_point_artifacts\":0,"
            "\"requested_execution_lane\":\"production_gpu\","
            "\"resolved_execution_lane\":\"production_gpu\","
            "\"validation_fallback_used\":false,"
            "\"artifact_manifest_path\":\"\"}",
            status_to_string(solve_status),
            static_cast<unsigned long long>(production_result.completed_frequency_count));
        if (diagnostics_written < 0 ||
            result_written < 0 ||
            static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
            static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                "MFEM production GPU failure result JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }
        result.status = solve_status;
        assign_result_strings(result, production_result.error_message, diagnostics_json, result_json, "");
        return result.status;
    }

    MfemDrivenResponseValidationResult artifact_result{};
    artifact_result.completed_frequency_count = production_result.completed_frequency_count;
    artifact_result.response_dof_count = production_result.response_dof_count;
    artifact_result.response_frequency_count = production_result.completed_frequency_count;
    artifact_result.max_frequency_hz = production_result.max_frequency_hz;
    artifact_result.max_abs_response = production_result.max_abs_response;
    artifact_result.total_iteration_count = production_result.total_iteration_count;
    artifact_result.max_iterations_for_frequency =
        production_result.max_iterations_for_frequency;
    artifact_result.restart_iterations_for_frequency =
        production_result.restart_iterations_for_frequency;
    artifact_result.progress_interval_iterations =
        production_result.progress_interval_iterations;
    artifact_result.solver_relative_tolerance =
        production_result.solver_relative_tolerance;
    artifact_result.rhs_l2_norm = production_result.rhs_l2_norm;
    artifact_result.initial_residual_l2_norm =
        production_result.initial_residual_l2_norm;
    artifact_result.initial_relative_residual_l2_norm =
        production_result.initial_relative_residual_l2_norm;
    artifact_result.residual_l2_norm = production_result.residual_l2_norm;
    artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
    artifact_result.minimum_tracked_relative_residual_l2_norm =
        production_result.minimum_tracked_relative_residual_l2_norm;
    artifact_result.minimum_tracked_relative_residual_iteration =
        production_result.minimum_tracked_relative_residual_iteration;
    artifact_result.last_tracked_relative_residual_l2_norm =
        production_result.last_tracked_relative_residual_l2_norm;
    artifact_result.last_recomputed_relative_residual_l2_norm =
        production_result.last_recomputed_relative_residual_l2_norm;
    artifact_result.residual_growth_factor =
        production_result.residual_growth_factor;
    copy_production_cpu_preconditioner_diagnostics(production_result, artifact_result);
    char manifest_path[256]{};
    char artifact_error[128]{};
    DrivenFrequencyResponseSolveRequest artifact_request = request;
    artifact_request.mfem_validation_problem.drive_real = drive_real;
    artifact_request.mfem_validation_problem.drive_imag = drive_imag;
    const FrequencyDomainStatus artifact_status = write_mfem_validation_artifacts(
        artifact_request,
        artifact_result,
        response_real.data(),
        response_imag.data(),
        residual_l2_norm.data(),
        relative_residual_l2_norm.data(),
        "ok",
        true,
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }
    const std::uint64_t written_artifacts = has_output_directory(request.output_directory) ?
        production_result.completed_frequency_count :
        0;

    const std::string operator_terms = included_operator_terms_json(problem);
    const char *demag_tangent_operator_source =
        mfem_demag_tangent_operator_source(problem);
    char diagnostics_json[1400]{};
    char result_json[1200]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"requested_execution_lane\":\"production_gpu\","
        "\"resolved_execution_lane\":\"production_gpu\","
        "\"production_solver_requested\":true,"
        "\"production_solver_available\":true,"
        "\"validation_fallback_used\":false,"
        "\"matrix_free_solver\":true,"
        "\"gpu_operator_solver\":true,"
        "\"dense_block_real_solver\":false,"
        "\"assembled_mfem_operator_solver\":false,"
        "\"krylov_solver\":\"gmres\","
        "\"demag_tangent_operator_source\":\"%s\","
        "\"operator_terms_included\":%s,"
        "\"exchange_edge_count\":%llu,"
        "\"static_periodic_projection\":%s,"
        "\"floquet_phase_projection\":%s,"
        "\"floquet_real_imag_mixing\":%s,"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"tangent_dof_count\":%llu,"
        "\"total_iteration_count\":%llu,"
        "\"max_iterations_for_frequency\":%llu,"
        "\"relative_residual_l2_norm\":%.17g}",
        demag_tangent_operator_source,
        operator_terms.c_str(),
        static_cast<unsigned long long>(problem.exchange_edge_count),
        static_periodic_projection ? "true" : "false",
        floquet_phase_projection ? "true" : "false",
        floquet_phase_projection ? "true" : "false",
        static_cast<unsigned long long>(problem.static_periodic_node_pair_count),
        static_periodic_frame_mismatch,
        static_periodic_drive_max_mismatch,
        static_cast<unsigned long long>(production_result.completed_frequency_count),
        static_cast<unsigned long long>(written_artifacts),
        static_cast<unsigned long long>(tangent_dof_count),
        static_cast<unsigned long long>(production_result.total_iteration_count),
        static_cast<unsigned long long>(production_result.max_iterations_for_frequency),
        production_result.relative_residual_l2_norm);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"ok\","
        "\"completed_frequency_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"requested_execution_lane\":\"production_gpu\","
        "\"resolved_execution_lane\":\"production_gpu\","
        "\"max_frequency_hz\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g,"
        "\"demag_tangent_operator_source\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"artifact_manifest_path\":\"%s\"}",
        static_cast<unsigned long long>(production_result.completed_frequency_count),
        static_cast<unsigned long long>(written_artifacts),
        production_result.max_frequency_hz,
        production_result.max_abs_response,
        production_result.relative_residual_l2_norm,
        demag_tangent_operator_source,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "MFEM production GPU response result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }
    result.status = FrequencyDomainStatus::ok;
    result.completed_frequency_count = production_result.completed_frequency_count;
    result.written_frequency_point_artifacts = written_artifacts;
    assign_result_strings(result, "", diagnostics_json, result_json, manifest_path);
    return result.status;
}

FrequencyDomainStatus format_unavailable_result_json(
    const char *manifest_path,
    char result_json[384],
    char error_message[128]) noexcept
{
    const int result_written = std::snprintf(
        result_json,
        384,
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"unavailable\","
        "\"completed_frequency_count\":0,"
        "\"artifact_manifest_path\":\"%s\"}",
        manifest_path != nullptr ? manifest_path : "");
    if (result_written < 0 || static_cast<std::size_t>(result_written) >= 384) {
        std::snprintf(error_message, 128, "unavailable frequency response result JSON exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus solve_tiny_validation_problem(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const DrivenFrequencyResponseTinyValidationProblem &problem = request.tiny_validation_problem;
    const std::uint64_t tangent_dof_count = request.solve_request.operator_request.tangent_dof_count;
    if (problem.tangent_dof_count != tangent_dof_count ||
        problem.drive_real == nullptr) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "tiny driven response validation problem requires matching tangent DOFs and drive buffer",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }

    DenseDrivenResponseValidationResult validation_result{};
    const FrequencyDomainStatus validation_status = solve_dense_driven_response_validation_problem(
        DenseDrivenResponseValidationProblem{
            tangent_dof_count,
            request.solve_request.frequencies_hz,
            request.solve_request.frequency_count,
            problem.stiffness_matrix_row_major,
            problem.mass_matrix_row_major,
            problem.stiffness_diagonal,
            problem.mass_diagonal,
            problem.drive_real,
            nullptr,
            nullptr,
            0,
            nullptr,
            nullptr,
            0,
            nullptr,
            nullptr,
            problem.drive_imag,
        },
        &validation_result);
    if (validation_status != FrequencyDomainStatus::ok) {
        result.status = validation_status;
        assign_result_strings(
            result,
            validation_result.error_message,
            status_diagnostics_json(validation_status),
            status_result_json(validation_status),
            "");
        return result.status;
    }

    char diagnostics_json[384]{};
    char result_json[384]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"dense_block_real_solver\":true,"
        "\"completed_frequency_point_count\":%llu,"
        "\"tangent_dof_count\":%llu}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(tangent_dof_count));
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"ok\","
        "\"completed_frequency_count\":%llu,"
        "\"max_frequency_hz\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"artifact_manifest_path\":\"\"}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        validation_result.max_frequency_hz,
        validation_result.max_abs_response);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "tiny driven response validation result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::ok;
    result.completed_frequency_count = validation_result.completed_frequency_count;
    result.written_frequency_point_artifacts = 0;
    assign_result_strings(
        result,
        "",
        diagnostics_json,
        result_json,
        "");
    return result.status;
}

FrequencyDomainStatus solve_periodic_airbox_validation_error(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result,
    const char *validation_error,
    const char *message,
    const char *delta_phi_phase_validation_status = nullptr,
    double delta_phi_phase_max_residual = 0.0) noexcept;

FrequencyDomainStatus solve_periodic_airbox_dynamic_demag_coupled_block(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const DrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem &problem =
        request.periodic_airbox_coupled_block_problem;
    const std::uint64_t delta_m_tangent_dof_count =
        request.periodic_airbox_delta_m_tangent_dof_count;
    const std::uint64_t delta_phi_dof_count =
        request.periodic_airbox_delta_phi_dof_count;
    const std::uint64_t coupled_complex_dof_count =
        delta_m_tangent_dof_count + delta_phi_dof_count;

    if (problem.delta_m_tangent_dof_count != delta_m_tangent_dof_count ||
        problem.delta_phi_dof_count != delta_phi_dof_count) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_coupled_block_layout_mismatch",
            "periodic-airbox coupled block layout must match the requested delta_m/delta_phi DOFs");
    }

    const bool has_dense_operator =
        problem.stiffness_matrix_row_major != nullptr &&
        problem.mass_matrix_row_major != nullptr;
    const bool has_matrix_free_provider =
        problem.apply_stiffness != nullptr &&
        problem.apply_mass != nullptr;
    if (has_dense_operator && has_matrix_free_provider) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_ambiguous_coupled_block_operator_provider",
            "periodic-airbox dynamic demag requires exactly one periodic-airbox coupled-block operator provider");
    }
    if (!problem.enabled ||
        coupled_complex_dof_count == 0 ||
        (!has_dense_operator && !has_matrix_free_provider) ||
        problem.drive_real == nullptr) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "periodic-airbox coupled block requires matching delta_m/delta_phi DOFs and an operator provider",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }
    if (request.solve_request.operator_request.tangent_dof_count != delta_m_tangent_dof_count) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_delta_m_tangent_dof_mismatch",
            "periodic-airbox coupled block delta_m DOFs must match magnetic tangent DOFs");
    }

    const bool floquet_airbox =
        request.requires_floquet_airbox_dynamic_demag;
    const char *default_operator_source = floquet_airbox
        ? (has_dense_operator
            ? "explicit_floquet_airbox_coupled_block_payload"
            : "matrix_free_floquet_airbox_coupled_block_provider")
        : (has_dense_operator
            ? "explicit_coupled_block_payload"
            : "matrix_free_coupled_block_provider");
    const char *default_artifact_revision = floquet_airbox
        ? (has_dense_operator
            ? "floquet-airbox-explicit-coupled-block-v1"
            : "floquet-airbox-matrix-free-coupled-block-v1")
        : (has_dense_operator
            ? "periodic-airbox-explicit-coupled-block-v1"
            : "periodic-airbox-matrix-free-coupled-block-v1");
    const char *default_solver_kind = floquet_airbox
        ? (has_dense_operator
            ? "floquet_airbox_explicit_coupled_block"
            : "floquet_airbox_matrix_free_coupled_block")
        : (has_dense_operator
            ? "periodic_airbox_explicit_coupled_block"
            : "periodic_airbox_matrix_free_coupled_block");
    const char *operator_source =
        problem.operator_source != nullptr ? problem.operator_source : default_operator_source;
    const char *artifact_revision =
        problem.artifact_revision != nullptr ? problem.artifact_revision : default_artifact_revision;
    const char *solver_kind =
        problem.solver_kind != nullptr ? problem.solver_kind : default_solver_kind;
    const char *solver_model = solver_kind;
    const char *default_frequency_point_solver_model = floquet_airbox
        ? (has_dense_operator
            ? "explicit_floquet_airbox_coupled_block"
            : "matrix_free_floquet_airbox_coupled_block")
        : (has_dense_operator
            ? "explicit_periodic_airbox_coupled_block"
            : "matrix_free_periodic_airbox_coupled_block");
    const char *frequency_point_solver_model =
        problem.frequency_point_solver_model != nullptr
            ? problem.frequency_point_solver_model
            : default_frequency_point_solver_model;

    PeriodicAirboxPhiGaugeDiagnostics phi_gauge_diagnostics{};
    std::vector<double> gauged_stiffness_matrix;
    std::vector<double> gauged_mass_matrix;
    std::vector<double> gauged_drive_real;
    std::vector<double> gauged_drive_imag;
    const double *stiffness_matrix = problem.stiffness_matrix_row_major;
    const double *mass_matrix = problem.mass_matrix_row_major;
    const double *drive_real = problem.drive_real;
    const double *drive_imag = problem.drive_imag;
    if (has_matrix_free_provider) {
        phi_gauge_diagnostics.phi_gauge_policy =
            "matrix_free_provider_responsibility";
    }
    if (has_dense_operator &&
        delta_phi_dof_count > 0 &&
        detects_constant_phi_nullspace(
            problem.stiffness_matrix_row_major,
            coupled_complex_dof_count,
            delta_m_tangent_dof_count,
            delta_phi_dof_count) &&
        detects_constant_phi_nullspace(
            problem.mass_matrix_row_major,
            coupled_complex_dof_count,
            delta_m_tangent_dof_count,
            delta_phi_dof_count)) {
        const std::size_t matrix_value_count = static_cast<std::size_t>(
            coupled_complex_dof_count * coupled_complex_dof_count);
        gauged_stiffness_matrix.assign(
            problem.stiffness_matrix_row_major,
            problem.stiffness_matrix_row_major + matrix_value_count);
        gauged_mass_matrix.assign(
            problem.mass_matrix_row_major,
            problem.mass_matrix_row_major + matrix_value_count);
        gauged_drive_real.assign(
            problem.drive_real,
            problem.drive_real + static_cast<std::size_t>(coupled_complex_dof_count));
        if (problem.drive_imag != nullptr) {
            gauged_drive_imag.assign(
                problem.drive_imag,
                problem.drive_imag + static_cast<std::size_t>(coupled_complex_dof_count));
        }

        const std::uint64_t gauge_row = coupled_complex_dof_count - 1;
        for (std::uint64_t column = 0; column < coupled_complex_dof_count; ++column) {
            const std::size_t index = static_cast<std::size_t>(
                gauge_row * coupled_complex_dof_count + column);
            gauged_stiffness_matrix[index] = 0.0;
            gauged_mass_matrix[index] = 0.0;
        }
        const double mean_weight = 1.0 / static_cast<double>(delta_phi_dof_count);
        for (std::uint64_t phi = 0; phi < delta_phi_dof_count; ++phi) {
            gauged_stiffness_matrix[
                static_cast<std::size_t>(
                    gauge_row * coupled_complex_dof_count + delta_m_tangent_dof_count + phi)] =
                mean_weight;
        }
        gauged_drive_real[static_cast<std::size_t>(gauge_row)] = 0.0;
        if (!gauged_drive_imag.empty()) {
            gauged_drive_imag[static_cast<std::size_t>(gauge_row)] = 0.0;
        }
        stiffness_matrix = gauged_stiffness_matrix.data();
        mass_matrix = gauged_mass_matrix.data();
        drive_real = gauged_drive_real.data();
        drive_imag = gauged_drive_imag.empty() ? nullptr : gauged_drive_imag.data();
        phi_gauge_diagnostics.phi_nullspace_detected = true;
        phi_gauge_diagnostics.phi_gauge_constraint_applied = true;
        phi_gauge_diagnostics.phi_gauge_policy = "mean_zero";
    }

    std::vector<double> response_real(static_cast<std::size_t>(
        coupled_complex_dof_count * request.solve_request.frequency_count));
    std::vector<double> response_imag(static_cast<std::size_t>(
        coupled_complex_dof_count * request.solve_request.frequency_count));
    std::vector<double> residual_l2_norm(static_cast<std::size_t>(
        request.solve_request.frequency_count));
    std::vector<double> relative_residual_l2_norm(static_cast<std::size_t>(
        request.solve_request.frequency_count));

    DenseDrivenResponseValidationResult validation_result{};
    FrequencyDomainStatus validation_status = FrequencyDomainStatus::ok;
    if (has_dense_operator) {
        validation_status = solve_dense_driven_response_validation_problem(
            DenseDrivenResponseValidationProblem{
                coupled_complex_dof_count,
                request.solve_request.frequencies_hz,
                request.solve_request.frequency_count,
                stiffness_matrix,
                mass_matrix,
                nullptr,
                nullptr,
                drive_real,
                response_real.data(),
                response_imag.data(),
                coupled_complex_dof_count * request.solve_request.frequency_count,
                residual_l2_norm.data(),
                relative_residual_l2_norm.data(),
                request.solve_request.frequency_count,
                request.cancel_requested,
                request.cancel_user_data,
                drive_imag,
            },
            &validation_result);
    } else {
        ProductionCpuDrivenResponseResult production_result{};
        const double solver_relative_tolerance =
            production_frequency_response_relative_tolerance();
        const std::uint64_t solver_max_iterations =
            production_frequency_response_max_iterations();
        const std::uint64_t solver_restart_iterations =
            production_frequency_response_restart_iterations(solver_max_iterations);
        const std::uint64_t solver_progress_interval =
            production_frequency_response_progress_interval();
        validation_status = solve_production_cpu_driven_response(
            ProductionCpuDrivenResponseProblem{
                coupled_complex_dof_count,
                request.solve_request.frequencies_hz,
                request.solve_request.frequency_count,
                drive_real,
                problem.apply_stiffness,
                problem.apply_mass,
                problem.operator_user_data,
                solver_relative_tolerance,
                solver_max_iterations,
                solver_restart_iterations,
                response_real.data(),
                response_imag.data(),
                coupled_complex_dof_count * request.solve_request.frequency_count,
                residual_l2_norm.data(),
                relative_residual_l2_norm.data(),
                request.solve_request.frequency_count,
                request.cancel_requested,
                request.cancel_user_data,
                request.progress_callback,
                request.progress_user_data,
                drive_imag,
                angular_frequency_sign(request.phase_convention),
                nullptr,
                nullptr,
                solver_progress_interval,
                problem.apply_right_preconditioner,
                problem.right_preconditioner_user_data,
                problem.right_preconditioner_name,
                delta_m_tangent_dof_count,
                delta_phi_dof_count,
                "coupled_block",
            },
            &production_result);
        validation_result.completed_frequency_count = production_result.completed_frequency_count;
        validation_result.response_dof_count = production_result.response_dof_count;
        validation_result.response_frequency_count = production_result.completed_frequency_count;
        validation_result.max_frequency_hz = production_result.max_frequency_hz;
        validation_result.max_abs_response = production_result.max_abs_response;
        validation_result.residual_l2_norm = production_result.residual_l2_norm;
        validation_result.relative_residual_l2_norm =
            production_result.relative_residual_l2_norm;
        validation_result.rhs_delta_m_l2_norm = production_result.rhs_delta_m_l2_norm;
        validation_result.rhs_delta_phi_l2_norm = production_result.rhs_delta_phi_l2_norm;
        validation_result.residual_delta_m_l2_norm =
            production_result.residual_delta_m_l2_norm;
        validation_result.residual_delta_phi_l2_norm =
            production_result.residual_delta_phi_l2_norm;
        validation_result.relative_residual_delta_m_l2_norm =
            production_result.relative_residual_delta_m_l2_norm;
        validation_result.relative_residual_delta_phi_l2_norm =
            production_result.relative_residual_delta_phi_l2_norm;
        validation_result.response_delta_m_l2_norm =
            production_result.response_delta_m_l2_norm;
        validation_result.response_delta_phi_l2_norm =
            production_result.response_delta_phi_l2_norm;
        validation_result.coupled_block_norms_available =
            production_result.coupled_block_norms_available;
        std::strncpy(
            validation_result.coupled_residual_partition_status,
            production_result.coupled_residual_partition_status,
            63);
        validation_result.coupled_residual_partition_status[63] = '\0';
        copy_production_cpu_diagnostics(production_result, validation_result);
        std::snprintf(
            validation_result.error_message,
            sizeof(validation_result.error_message),
            "%s",
            production_result.error_message);
    }
    if (validation_status != FrequencyDomainStatus::ok) {
        result.status = validation_status;
        assign_result_strings(
            result,
            validation_result.error_message,
            status_diagnostics_json(validation_status),
            status_result_json(validation_status),
            "");
        return result.status;
    }
    if (floquet_airbox) {
        double delta_phi_phase_max_residual = 0.0;
        char phase_validation_error[128]{};
        if (!validate_floquet_airbox_delta_phi_phase_response(
                request,
                response_real.data(),
                response_imag.data(),
                validation_result.completed_frequency_count,
                coupled_complex_dof_count,
                delta_m_tangent_dof_count,
                delta_phi_dof_count,
                delta_phi_phase_max_residual,
                phase_validation_error)) {
            return solve_periodic_airbox_validation_error(
                request,
                result,
                "floquet_airbox_delta_phi_phase_mismatch",
                phase_validation_error,
                "mismatch",
                delta_phi_phase_max_residual);
        }
        phi_gauge_diagnostics.delta_phi_phase_validation_status = "ok";
        phi_gauge_diagnostics.delta_phi_phase_max_residual =
            delta_phi_phase_max_residual;
        phi_gauge_diagnostics.delta_phi_flux_validation_status = "not_evaluated";
        phi_gauge_diagnostics.delta_phi_flux_validation_reason =
            "floquet_airbox_flux_validation_geometry_unavailable";
    }

    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status = write_periodic_airbox_coupled_block_artifacts(
        request,
        validation_result,
        phi_gauge_diagnostics,
        artifact_revision,
        solver_kind,
        solver_model,
        frequency_point_solver_model,
        operator_source,
        "ok",
        true,
        "",
        response_real.data(),
        response_imag.data(),
        residual_l2_norm.data(),
        relative_residual_l2_norm.data(),
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }
    const std::uint64_t written_frequency_point_artifacts =
        has_output_directory(request.output_directory)
            ? validation_result.completed_frequency_count
            : 0;

    char direct_diagnostics_error[128]{};
    const std::string direct_coupled_block_norms_json =
        coupled_block_norms_diagnostics_json(validation_result, direct_diagnostics_error);
    std::string diagnostics_json;
    char result_json[512]{};
    const bool diagnostics_written = append_format(
        diagnostics_json,
        direct_diagnostics_error,
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"requested_execution_lane\":\"production_cpu\","
        "\"production_solver_requested\":true,"
        "\"production_solver_available\":true,"
        "\"validation_fallback_used\":false,"
        "\"periodic_airbox_coupled_block_solver\":true,"
        "\"mfem_coupled_block_assembly\":false,"
        "\"dynamic_demag_operator_source\":\"%s\","
        "\"requested_magnetic_bc\":\"%s\","
        "\"resolved_magnetic_bc\":\"%s\","
        "\"requested_magnetostatic_bc\":\"%s\","
        "\"resolved_magnetostatic_bc\":\"%s\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"delta_m_tangent_dof_count\":%llu,"
        "\"delta_phi_dof_count\":%llu,"
        "\"coupled_complex_dof_count\":%llu,"
        "%s"
        "\"phi_nullspace_detected\":%s,"
        "\"phi_gauge_policy\":\"%s\","
        "\"phi_gauge_constraint_applied\":%s,"
        "\"delta_phi_phase_validation_status\":\"%s\","
        "\"delta_phi_phase_max_residual\":%.17g,"
        "\"delta_phi_flux_validation_status\":\"%s\","
        "\"delta_phi_flux_validation_reason\":\"%s\","
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"max_abs_response\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g}",
        operator_source,
        floquet_airbox ? "floquet" : "periodic",
        floquet_airbox ? "floquet" : "periodic",
        floquet_airbox ? "floquet_airbox" : "periodic_airbox_k0",
        floquet_airbox ? "floquet_airbox" : "periodic_airbox_k0",
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(delta_m_tangent_dof_count),
        static_cast<unsigned long long>(delta_phi_dof_count),
        static_cast<unsigned long long>(coupled_complex_dof_count),
        direct_coupled_block_norms_json.c_str(),
        phi_gauge_diagnostics.phi_nullspace_detected ? "true" : "false",
        phi_gauge_diagnostics.phi_gauge_policy,
        phi_gauge_diagnostics.phi_gauge_constraint_applied ? "true" : "false",
        phi_gauge_diagnostics.delta_phi_phase_validation_status,
        phi_gauge_diagnostics.delta_phi_phase_max_residual,
        phi_gauge_diagnostics.delta_phi_flux_validation_status,
        phi_gauge_diagnostics.delta_phi_flux_validation_reason,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        validation_result.max_abs_response,
        validation_result.relative_residual_l2_norm);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"ok\","
        "\"completed_frequency_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"requested_execution_lane\":\"production_cpu\","
        "\"periodic_airbox_coupled_block_solver\":true,"
        "\"max_frequency_hz\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"artifact_manifest_path\":\"%s\"}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        validation_result.max_frequency_hz,
        validation_result.max_abs_response,
        manifest_path);
    if (!diagnostics_written ||
        result_written < 0 ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            !diagnostics_written
                ? direct_diagnostics_error
                : "periodic-airbox coupled block result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::ok;
    result.completed_frequency_count = validation_result.completed_frequency_count;
    result.written_frequency_point_artifacts = written_frequency_point_artifacts;
    assign_result_strings(
        result,
        "",
        diagnostics_json.c_str(),
        result_json,
        manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_periodic_airbox_dynamic_demag_mfem_phi_consistency_schur(
    DrivenFrequencyResponseSolveRequest request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    const std::uint64_t delta_m_tangent_dof_count =
        request.periodic_airbox_delta_m_tangent_dof_count;
    const std::uint64_t delta_phi_dof_count =
        request.periodic_airbox_delta_phi_dof_count;
    const std::uint64_t coupled_dof_count =
        delta_m_tangent_dof_count + delta_phi_dof_count;
    if (!problem.enabled ||
        problem.apply_demag_tangent_with_potential == nullptr ||
        problem.drive_real == nullptr ||
        problem.descriptor.tangent_dof_count != delta_m_tangent_dof_count ||
        problem.layout.tangent_dof_count != delta_m_tangent_dof_count ||
        request.solve_request.operator_request.tangent_dof_count != delta_m_tangent_dof_count ||
        delta_phi_dof_count == 0 ||
        coupled_dof_count == 0 ||
        problem.descriptor.node_count == 0 ||
        problem.nodes == nullptr) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_mfem_phi_consistency_schur_layout_mismatch",
            "periodic-airbox MFEM phi-consistency Schur provider requires matching delta_m/delta_phi layouts and a demag tangent-with-potential callback",
            "not_evaluated",
            0.0);
    }

    MfemPhiConsistencySchurProviderContext context{};
    context.delta_m_tangent_dof_count = delta_m_tangent_dof_count;
    context.delta_phi_dof_count = delta_phi_dof_count;
    context.adapter.request = &request;
    context.adapter.zeeman_blocks.resize(static_cast<std::size_t>(problem.descriptor.node_count));
    context.adapter.uniaxial_anisotropy_blocks.resize(static_cast<std::size_t>(problem.descriptor.node_count));
    context.adapter.exchange_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.zeeman_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.uniaxial_anisotropy_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.dmi_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.dmi_delta_xyz.resize(static_cast<std::size_t>(problem.descriptor.full_dof_count));
    context.adapter.dmi_residual_xyz.resize(static_cast<std::size_t>(problem.descriptor.full_dof_count));
    context.adapter.dmi_field_xyz.resize(static_cast<std::size_t>(problem.descriptor.full_dof_count));
    context.adapter.demag_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.effective_field_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.stiffness_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.mass_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.adapter.projected_tangent.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.demag_tangent_workspace.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
    context.delta_phi_workspace.resize(static_cast<std::size_t>(delta_phi_dof_count));

    char projection_error[128]{};
    if (!build_static_periodic_representatives(
            problem,
            context.adapter.static_periodic_representative_node,
            context.adapter.static_periodic_representative_count,
            projection_error)) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_static_periodic_projection_error",
            projection_error,
            "not_evaluated",
            0.0);
    }
    constexpr double static_periodic_tolerance = 1.0e-10;
    const double static_periodic_frame_mismatch =
        max_static_periodic_frame_mismatch(
            context.adapter.static_periodic_representative_node,
            problem);
    if (static_periodic_frame_mismatch > static_periodic_tolerance) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_static_periodic_frame_mismatch",
            "periodic-airbox MFEM phi-consistency Schur provider requires matching equilibrium tangent frames",
            "not_evaluated",
            0.0);
    }
    char preconditioner_setup_error[128]{};
    const FrequencyDomainStatus preconditioner_setup_status =
        setup_mfem_tangent_block_jacobi_preconditioner(
            context.adapter,
            preconditioner_setup_error);
    if (preconditioner_setup_status != FrequencyDomainStatus::ok) {
        return solve_periodic_airbox_validation_error(
            request,
            result,
            "periodic_airbox_mfem_phi_consistency_schur_preconditioner_setup_error",
            preconditioner_setup_error,
            "not_evaluated",
            0.0);
    }
    const char *preconditioner_variant =
        mfem_tangent_preconditioner_variant(context.adapter);

    std::vector<double> drive_real(static_cast<std::size_t>(coupled_dof_count), 0.0);
    std::vector<double> drive_imag;
    const double *magnetic_drive_real = problem.drive_real;
    const double *magnetic_drive_imag = problem.drive_imag;
    std::vector<double> projected_drive_real;
    std::vector<double> projected_drive_imag;
    const bool static_periodic_projection =
        !context.adapter.static_periodic_representative_node.empty();
    if (static_periodic_projection) {
        double static_periodic_drive_max_mismatch =
            max_static_periodic_tangent_mismatch(
                context.adapter.static_periodic_representative_node,
                problem.drive_real);
        if (problem.drive_imag != nullptr) {
            static_periodic_drive_max_mismatch = std::max(
                static_periodic_drive_max_mismatch,
                max_static_periodic_tangent_mismatch(
                    context.adapter.static_periodic_representative_node,
                    problem.drive_imag));
        }
        if (static_periodic_drive_max_mismatch > static_periodic_tolerance) {
            return solve_periodic_airbox_validation_error(
                request,
                result,
                "periodic_airbox_static_periodic_drive_mismatch",
                "periodic-airbox MFEM phi-consistency Schur provider requires periodic tangent drive values",
                "not_evaluated",
                0.0);
        }
        projected_drive_real.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
        project_static_periodic_tangent(
            context.adapter.static_periodic_representative_node,
            context.adapter.static_periodic_representative_count,
            problem.drive_real,
            projected_drive_real.data());
        magnetic_drive_real = projected_drive_real.data();
        if (problem.drive_imag != nullptr) {
            projected_drive_imag.resize(static_cast<std::size_t>(delta_m_tangent_dof_count));
            project_static_periodic_tangent(
                context.adapter.static_periodic_representative_node,
                context.adapter.static_periodic_representative_count,
                problem.drive_imag,
                projected_drive_imag.data());
            magnetic_drive_imag = projected_drive_imag.data();
        }
    }
    std::memcpy(
        drive_real.data(),
        magnetic_drive_real,
        static_cast<std::size_t>(delta_m_tangent_dof_count * sizeof(double)));
    if (magnetic_drive_imag != nullptr) {
        drive_imag.assign(static_cast<std::size_t>(coupled_dof_count), 0.0);
        std::memcpy(
            drive_imag.data(),
            magnetic_drive_imag,
            static_cast<std::size_t>(delta_m_tangent_dof_count * sizeof(double)));
    }

    std::vector<double> response_real(static_cast<std::size_t>(
        coupled_dof_count * request.solve_request.frequency_count));
    std::vector<double> response_imag(static_cast<std::size_t>(
        coupled_dof_count * request.solve_request.frequency_count));
    std::vector<double> residual_l2_norm(static_cast<std::size_t>(
        request.solve_request.frequency_count));
    std::vector<double> relative_residual_l2_norm(static_cast<std::size_t>(
        request.solve_request.frequency_count));

    const double solver_relative_tolerance =
        production_frequency_response_relative_tolerance();
    const std::uint64_t solver_max_iterations =
        production_frequency_response_max_iterations();
    const std::uint64_t solver_restart_iterations =
        production_frequency_response_restart_iterations(solver_max_iterations);
    const std::uint64_t solver_progress_interval =
        production_frequency_response_progress_interval();
    ProductionCpuDrivenResponseResult production_result{};
    const FrequencyDomainStatus solve_status = solve_production_cpu_driven_response(
        ProductionCpuDrivenResponseProblem{
            coupled_dof_count,
            request.solve_request.frequencies_hz,
            request.solve_request.frequency_count,
            drive_real.data(),
            apply_mfem_phi_consistency_schur_stiffness,
            apply_mfem_phi_consistency_schur_mass,
            &context,
            solver_relative_tolerance,
            solver_max_iterations,
            solver_restart_iterations,
            response_real.data(),
            response_imag.data(),
            coupled_dof_count * request.solve_request.frequency_count,
            residual_l2_norm.data(),
            relative_residual_l2_norm.data(),
            request.solve_request.frequency_count,
            request.cancel_requested,
            request.cancel_user_data,
            request.progress_callback,
            request.progress_user_data,
            drive_imag.empty() ? nullptr : drive_imag.data(),
            angular_frequency_sign(request.phase_convention),
            nullptr,
            nullptr,
            solver_progress_interval,
            apply_mfem_phi_consistency_schur_right_preconditioner,
            &context,
            "mfem_phi_consistency_schur_right",
            delta_m_tangent_dof_count,
            delta_phi_dof_count,
            "coupled_block",
        },
        &production_result);
    if (solve_status != FrequencyDomainStatus::ok) {
        DenseDrivenResponseValidationResult validation_result{};
        validation_result.completed_frequency_count =
            production_result.completed_frequency_count;
        validation_result.response_dof_count = coupled_dof_count;
        validation_result.response_frequency_count =
            production_result.completed_frequency_count;
        validation_result.max_frequency_hz = production_result.max_frequency_hz;
        validation_result.max_abs_response = production_result.max_abs_response;
        validation_result.residual_l2_norm = production_result.residual_l2_norm;
        validation_result.relative_residual_l2_norm =
            production_result.relative_residual_l2_norm;
        copy_production_cpu_diagnostics(production_result, validation_result);

        PeriodicAirboxPhiGaugeDiagnostics phi_gauge_diagnostics{};
        phi_gauge_diagnostics.phi_gauge_policy =
            "matrix_free_provider_responsibility";
        char failure_diagnostics_error[128]{};
        const std::string gmres_history_json =
            gmres_relative_residual_history_json(
                production_result,
                failure_diagnostics_error);
        std::string extra_diagnostics_json;
        if (!append_format(
                extra_diagnostics_json,
                failure_diagnostics_error,
                "\"matrix_free_solver\":true,"
                "\"krylov_solver\":\"gmres\","
                "\"krylov_preconditioner_kind\":\"%s\","
                "\"krylov_preconditioner_variant\":\"%s\","
                "\"exchange_edge_count\":%llu,"
                "\"krylov_preconditioner_applied\":%s,"
                "\"krylov_preconditioner_setup_status\":\"%s\","
                "\"gmres_relative_residual_history\":%s,"
                "\"total_iteration_count\":%llu,"
                "\"max_iterations_for_frequency\":%llu,"
                "\"restart_iterations_for_frequency\":%llu,"
                "\"progress_interval_iterations\":%llu,"
                "\"solver_relative_tolerance\":%.17g,"
                "\"rhs_l2_norm\":%.17g,"
                "\"initial_residual_l2_norm\":%.17g,"
                "\"initial_relative_residual_l2_norm\":%.17g,"
                "\"minimum_tracked_relative_residual_l2_norm\":%.17g,"
                "\"minimum_tracked_relative_residual_iteration\":%llu,"
                "\"last_tracked_relative_residual_l2_norm\":%.17g,"
                "\"last_recomputed_relative_residual_l2_norm\":%.17g,"
                "\"residual_growth_factor\":%.17g,",
                production_result.krylov_preconditioner,
                preconditioner_variant,
                static_cast<unsigned long long>(
                    request.mfem_validation_problem.exchange_edge_count),
                production_result.right_preconditioner_applied ? "true" : "false",
                production_result.right_preconditioner_applied ? "ok" : "not_configured",
                gmres_history_json.c_str(),
                static_cast<unsigned long long>(production_result.total_iteration_count),
                static_cast<unsigned long long>(
                    production_result.max_iterations_for_frequency),
                static_cast<unsigned long long>(
                    production_result.restart_iterations_for_frequency),
                static_cast<unsigned long long>(
                    production_result.progress_interval_iterations),
                production_result.solver_relative_tolerance,
                production_result.rhs_l2_norm,
                production_result.initial_residual_l2_norm,
                production_result.initial_relative_residual_l2_norm,
                production_result.minimum_tracked_relative_residual_l2_norm,
                static_cast<unsigned long long>(
                    production_result.minimum_tracked_relative_residual_iteration),
                production_result.last_tracked_relative_residual_l2_norm,
                production_result.last_recomputed_relative_residual_l2_norm,
                production_result.residual_growth_factor)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                failure_diagnostics_error,
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }

        char manifest_path[256]{};
        char artifact_error[128]{};
        const char *operator_source =
            "matrix_free_mfem_demag_phi_consistency_schur_provider";
        const FrequencyDomainStatus artifact_status =
            write_periodic_airbox_coupled_block_artifacts(
                request,
                validation_result,
                phi_gauge_diagnostics,
                "periodic-airbox-mfem-phi-consistency-schur-v1",
                "periodic_airbox_mfem_phi_consistency_schur",
                "periodic_airbox_mfem_phi_consistency_schur",
                "matrix_free_mfem_phi_consistency_schur",
                operator_source,
                status_to_string(solve_status),
                false,
                extra_diagnostics_json.c_str(),
                response_real.data(),
                response_imag.data(),
                residual_l2_norm.data(),
                relative_residual_l2_norm.data(),
                manifest_path,
                artifact_error);
        if (artifact_status != FrequencyDomainStatus::ok) {
            result.status = artifact_status;
            assign_result_strings(
                result,
                artifact_error,
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }

        char direct_diagnostics_json[2048]{};
        char result_json[512]{};
        const int diagnostics_written = std::snprintf(
            direct_diagnostics_json,
            sizeof(direct_diagnostics_json),
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"status\":\"%s\","
            "\"complete\":false,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"krylov_preconditioner_variant\":\"%s\","
            "\"exchange_edge_count\":%llu,"
            "\"total_iteration_count\":%llu,"
            "\"max_iterations_for_frequency\":%llu,"
            "\"relative_residual_l2_norm\":%.17g,"
            "\"artifact_manifest_path\":\"%s\"}",
            status_to_string(solve_status),
            operator_source,
            preconditioner_variant,
            static_cast<unsigned long long>(
                request.mfem_validation_problem.exchange_edge_count),
            static_cast<unsigned long long>(production_result.total_iteration_count),
            static_cast<unsigned long long>(
                production_result.max_iterations_for_frequency),
            production_result.relative_residual_l2_norm,
            manifest_path);
        const int result_written = std::snprintf(
            result_json,
            sizeof(result_json),
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"status\":\"%s\","
            "\"completed_frequency_count\":%llu,"
            "\"written_frequency_point_artifacts\":0,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"artifact_manifest_path\":\"%s\"}",
            status_to_string(solve_status),
            static_cast<unsigned long long>(
                production_result.completed_frequency_count),
            manifest_path);
        if (diagnostics_written < 0 ||
            static_cast<std::size_t>(diagnostics_written) >=
                sizeof(direct_diagnostics_json) ||
            result_written < 0 ||
            static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                "periodic-airbox Schur solve_error result JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }
        result.status = solve_status;
        result.completed_frequency_count =
            production_result.completed_frequency_count;
        result.written_frequency_point_artifacts = 0;
        assign_result_strings(
            result,
            production_result.error_message,
            direct_diagnostics_json,
            result_json,
            manifest_path);
        return result.status;
    }

    DenseDrivenResponseValidationResult validation_result{};
    validation_result.completed_frequency_count =
        production_result.completed_frequency_count;
    validation_result.response_dof_count = coupled_dof_count;
    validation_result.response_frequency_count =
        production_result.completed_frequency_count;
    validation_result.max_frequency_hz = production_result.max_frequency_hz;
    validation_result.max_abs_response = production_result.max_abs_response;
    for (std::uint64_t index = 0;
         index < coupled_dof_count * production_result.completed_frequency_count;
         ++index) {
        validation_result.max_abs_response = std::max(
            validation_result.max_abs_response,
            std::hypot(
                response_real[static_cast<std::size_t>(index)],
                response_imag[static_cast<std::size_t>(index)]));
    }
    validation_result.residual_l2_norm = production_result.residual_l2_norm;
    validation_result.relative_residual_l2_norm =
        production_result.relative_residual_l2_norm;
    copy_production_cpu_diagnostics(production_result, validation_result);

    PeriodicAirboxPhiGaugeDiagnostics phi_gauge_diagnostics{};
    phi_gauge_diagnostics.phi_gauge_policy =
        "matrix_free_provider_responsibility";
    char manifest_path[256]{};
    char artifact_error[128]{};
    const char *operator_source =
        "matrix_free_mfem_demag_phi_consistency_schur_provider";
    char artifact_extra_diagnostics_error[128]{};
    std::string artifact_extra_diagnostics_json;
    if (!append_format(
            artifact_extra_diagnostics_json,
            artifact_extra_diagnostics_error,
            "\"krylov_preconditioner_variant\":\"%s\","
            "\"exchange_edge_count\":%llu,"
            "\"total_iteration_count\":%llu,"
            "\"max_iterations_for_frequency\":%llu,"
            "\"restart_iterations_for_frequency\":%llu,"
            "\"progress_interval_iterations\":%llu,"
            "\"solver_relative_tolerance\":%.17g,"
            "\"rhs_l2_norm\":%.17g,"
            "\"initial_residual_l2_norm\":%.17g,"
            "\"initial_relative_residual_l2_norm\":%.17g,"
            "\"minimum_tracked_relative_residual_l2_norm\":%.17g,"
            "\"minimum_tracked_relative_residual_iteration\":%llu,"
            "\"last_tracked_relative_residual_l2_norm\":%.17g,"
            "\"last_recomputed_relative_residual_l2_norm\":%.17g,"
            "\"residual_growth_factor\":%.17g,",
            preconditioner_variant,
            static_cast<unsigned long long>(
                request.mfem_validation_problem.exchange_edge_count),
            static_cast<unsigned long long>(production_result.total_iteration_count),
            static_cast<unsigned long long>(production_result.max_iterations_for_frequency),
            static_cast<unsigned long long>(production_result.restart_iterations_for_frequency),
            static_cast<unsigned long long>(production_result.progress_interval_iterations),
            production_result.solver_relative_tolerance,
            production_result.rhs_l2_norm,
            production_result.initial_residual_l2_norm,
            production_result.initial_relative_residual_l2_norm,
            production_result.minimum_tracked_relative_residual_l2_norm,
            static_cast<unsigned long long>(
                production_result.minimum_tracked_relative_residual_iteration),
            production_result.last_tracked_relative_residual_l2_norm,
            production_result.last_recomputed_relative_residual_l2_norm,
            production_result.residual_growth_factor)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            artifact_extra_diagnostics_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }
    const FrequencyDomainStatus artifact_status =
        write_periodic_airbox_coupled_block_artifacts(
            request,
            validation_result,
            phi_gauge_diagnostics,
            "periodic-airbox-mfem-phi-consistency-schur-v1",
            "periodic_airbox_mfem_phi_consistency_schur",
            "periodic_airbox_mfem_phi_consistency_schur",
            "matrix_free_mfem_phi_consistency_schur",
            operator_source,
            "ok",
            true,
            artifact_extra_diagnostics_json.c_str(),
            response_real.data(),
            response_imag.data(),
            residual_l2_norm.data(),
            relative_residual_l2_norm.data(),
            manifest_path,
            artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    char direct_diagnostics_error[128]{};
    const std::string gmres_history_json =
        gmres_relative_residual_history_json(production_result, direct_diagnostics_error);
    const std::string coupled_block_norms_json =
        coupled_block_norms_diagnostics_json(validation_result, direct_diagnostics_error);
    std::string diagnostics_json;
    char result_json[512]{};
    const std::uint64_t written_frequency_point_artifacts =
        has_output_directory(request.output_directory)
            ? validation_result.completed_frequency_count
            : 0;
    const bool diagnostics_written = append_format(
        diagnostics_json,
        direct_diagnostics_error,
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"requested_execution_lane\":\"production_cpu\","
        "\"production_solver_requested\":true,"
        "\"production_solver_available\":true,"
        "\"validation_fallback_used\":false,"
        "\"periodic_airbox_coupled_block_solver\":true,"
        "\"mfem_coupled_block_assembly\":false,"
        "\"matrix_free_solver\":true,"
        "\"krylov_solver\":\"gmres\","
        "\"krylov_preconditioner_kind\":\"%s\","
        "\"dynamic_demag_operator_source\":\"%s\","
        "\"requested_magnetic_bc\":\"periodic\","
        "\"resolved_magnetic_bc\":\"periodic\","
        "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"krylov_preconditioner_variant\":\"%s\","
        "\"exchange_edge_count\":%llu,"
        "\"krylov_preconditioner_applied\":%s,"
        "\"krylov_preconditioner_setup_status\":\"%s\","
        "\"gmres_relative_residual_history\":%s,"
        "\"total_iteration_count\":%llu,"
        "\"max_iterations_for_frequency\":%llu,"
        "\"restart_iterations_for_frequency\":%llu,"
        "\"progress_interval_iterations\":%llu,"
        "\"solver_relative_tolerance\":%.17g,"
        "\"rhs_l2_norm\":%.17g,"
        "\"initial_residual_l2_norm\":%.17g,"
        "\"initial_relative_residual_l2_norm\":%.17g,"
        "\"minimum_tracked_relative_residual_l2_norm\":%.17g,"
        "\"minimum_tracked_relative_residual_iteration\":%llu,"
        "\"last_tracked_relative_residual_l2_norm\":%.17g,"
        "\"last_recomputed_relative_residual_l2_norm\":%.17g,"
        "\"residual_growth_factor\":%.17g,"
        "\"delta_m_tangent_dof_count\":%llu,"
        "\"delta_phi_dof_count\":%llu,"
        "\"coupled_complex_dof_count\":%llu,"
        "%s"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"max_abs_response\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g}",
        production_result.krylov_preconditioner,
        operator_source,
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        preconditioner_variant,
        static_cast<unsigned long long>(request.mfem_validation_problem.exchange_edge_count),
        production_result.right_preconditioner_applied ? "true" : "false",
        production_result.right_preconditioner_applied ? "ok" : "not_configured",
        gmres_history_json.c_str(),
        static_cast<unsigned long long>(production_result.total_iteration_count),
        static_cast<unsigned long long>(production_result.max_iterations_for_frequency),
        static_cast<unsigned long long>(production_result.restart_iterations_for_frequency),
        static_cast<unsigned long long>(production_result.progress_interval_iterations),
        production_result.solver_relative_tolerance,
        production_result.rhs_l2_norm,
        production_result.initial_residual_l2_norm,
        production_result.initial_relative_residual_l2_norm,
        production_result.minimum_tracked_relative_residual_l2_norm,
        static_cast<unsigned long long>(
            production_result.minimum_tracked_relative_residual_iteration),
        production_result.last_tracked_relative_residual_l2_norm,
        production_result.last_recomputed_relative_residual_l2_norm,
        production_result.residual_growth_factor,
        static_cast<unsigned long long>(delta_m_tangent_dof_count),
        static_cast<unsigned long long>(delta_phi_dof_count),
        static_cast<unsigned long long>(coupled_dof_count),
        coupled_block_norms_json.c_str(),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        validation_result.max_abs_response,
        validation_result.relative_residual_l2_norm);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"ok\","
        "\"completed_frequency_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"requested_execution_lane\":\"production_cpu\","
        "\"periodic_airbox_coupled_block_solver\":true,"
        "\"max_frequency_hz\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"artifact_manifest_path\":\"%s\"}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        validation_result.max_frequency_hz,
        validation_result.max_abs_response,
        manifest_path);
    if (!diagnostics_written ||
        result_written < 0 ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            !diagnostics_written
                ? direct_diagnostics_error
                : "periodic-airbox Schur result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::ok;
    result.completed_frequency_count = validation_result.completed_frequency_count;
    result.written_frequency_point_artifacts = written_frequency_point_artifacts;
    assign_result_strings(
        result,
        "",
        diagnostics_json.c_str(),
        result_json,
        manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_periodic_airbox_dynamic_demag_unavailable(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    char manifest_path[256]{};
    char artifact_error[128]{};
    const char *reason =
        "periodic-airbox dynamic demag requires the coupled delta_m/delta_phi block, which is not implemented yet";
    const FrequencyDomainStatus artifact_status = write_unavailable_response_artifacts(
        request,
        reason,
        "periodic_airbox_dynamic_demag_coupled_block_unimplemented",
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }

    char diagnostics_json[1200]{};
    char result_json[384]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"production_solver_available\":false,"
        "\"validation_fallback_used\":false,"
        "\"requested_execution_lane\":\"%s\","
        "\"requested_magnetic_bc\":\"periodic\","
        "\"resolved_magnetic_bc\":\"periodic\","
        "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"unsupported_reason\":\"periodic_airbox_dynamic_demag_coupled_block_unimplemented\","
        "\"completed_frequency_point_count\":0}",
        execution_lane_to_string(request.execution_lane),
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count));
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"unavailable\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"requested_execution_lane\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"artifact_manifest_path\":\"%s\"}",
        execution_lane_to_string(request.execution_lane),
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "periodic-airbox dynamic demag diagnostics JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::unavailable;
    result.completed_frequency_count = 0;
    result.written_frequency_point_artifacts = 0;
    assign_result_strings(
        result,
        reason,
        diagnostics_json,
        result_json,
        manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_periodic_airbox_validation_error(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result,
    const char *validation_error,
    const char *message,
    const char *delta_phi_phase_validation_status,
    double delta_phi_phase_max_residual) noexcept
{
    auto write_validation_error_artifacts = [&](
        char manifest_path[256],
        char error_message[128]) noexcept -> FrequencyDomainStatus {
        if (!has_output_directory(request.output_directory)) {
            manifest_path[0] = '\0';
            return FrequencyDomainStatus::ok;
        }
        if (!request.write_partial_artifacts) {
            manifest_path[0] = '\0';
            return FrequencyDomainStatus::ok;
        }

        char frequency_domain_dir[256]{};
        char response_dir[256]{};
        char diagnostics_dir[256]{};
        char manifest[256]{};
        char solver_diagnostics[256]{};
        char progress[256]{};
        if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
            std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
            std::snprintf(diagnostics_dir, sizeof(diagnostics_dir), "%s/diagnostics", response_dir) < 0 ||
            std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
            std::snprintf(solver_diagnostics, sizeof(solver_diagnostics), "%s/solver.v1.json", diagnostics_dir) < 0 ||
            std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0) {
            std::snprintf(error_message, 128, "failed to format periodic-airbox validation artifact paths");
            return FrequencyDomainStatus::artifact_error;
        }
        if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
            std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
            std::strlen(diagnostics_dir) >= sizeof(diagnostics_dir) - 1 ||
            std::strlen(manifest) >= sizeof(manifest) - 1 ||
            std::strlen(solver_diagnostics) >= sizeof(solver_diagnostics) - 1 ||
            std::strlen(progress) >= sizeof(progress) - 1) {
            std::snprintf(error_message, 128, "periodic-airbox validation artifact path exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }

        const std::uint64_t delta_m_tangent_dof_count =
            request.periodic_airbox_delta_m_tangent_dof_count > 0
                ? request.periodic_airbox_delta_m_tangent_dof_count
                : request.solve_request.operator_request.tangent_dof_count;
        const std::uint64_t delta_phi_dof_count =
            request.periodic_airbox_delta_phi_dof_count;
        const std::uint64_t coupled_complex_dof_count =
            delta_m_tangent_dof_count + delta_phi_dof_count;
        const bool floquet_airbox =
            request.requires_floquet_airbox_dynamic_demag;
        const char *spin_wave_bc = floquet_airbox ? "floquet" : "periodic";
        const char *magnetic_bc = floquet_airbox ? "floquet" : "periodic";
        const char *magnetostatic_bc = floquet_airbox
            ? "floquet_airbox"
            : "periodic_airbox_k0";
        const char *revision = floquet_airbox
            ? "floquet-airbox-validation-error-v1"
            : "periodic-airbox-validation-error-v1";

        std::string diagnostics_json;
        std::string manifest_json;
        std::string progress_json;
        std::string phase_validation_json;
        if (delta_phi_phase_validation_status != nullptr &&
            !append_format(
                phase_validation_json,
                error_message,
                ",\"delta_phi_phase_validation_status\":\"%s\","
                "\"delta_phi_phase_max_residual\":%.17g",
                delta_phi_phase_validation_status,
                delta_phi_phase_max_residual)) {
            return FrequencyDomainStatus::artifact_error;
        }
        if (!append_format(
                diagnostics_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
                "\"solver_engine\":\"native_fem_mfem_driven_response\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"validation_error\":\"%s\","
                "\"requested_execution_lane\":\"%s\","
                "\"requested_magnetic_bc\":\"%s\","
                "\"resolved_magnetic_bc\":\"%s\","
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"coupled_complex_dof_count\":%llu,"
                "\"periodic_airbox_coupled_block_solver\":false,"
                "\"validation_fallback_used\":false,"
                "\"dense_block_real_solver\":false,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0%s}",
                validation_error,
                execution_lane_to_string(request.execution_lane),
                magnetic_bc,
                magnetic_bc,
                magnetostatic_bc,
                magnetostatic_bc,
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                static_cast<unsigned long long>(coupled_complex_dof_count),
                phase_validation_json.c_str()) ||
            !append_format(
                manifest_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_manifest.v1\","
                "\"analysis_family\":\"magnetic_frequency_domain\","
                "\"study_product\":\"driven_response\","
                "\"revision\":\"%s\","
                "\"created_at\":\"1970-01-01T00:00:00Z\","
                "\"session_id\":\"native-validation\","
                "\"run_id\":\"native-validation\","
                "\"stage_id\":\"frequency-response-production\","
                "\"stage_kind\":\"frequency_response\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"validation_error\":\"%s\","
                "\"physics\":{\"requested_spin_wave_bc\":\"%s\","
                "\"resolved_spin_wave_bc\":\"%s\","
                "\"requested_magnetic_bc\":\"%s\","
                "\"resolved_magnetic_bc\":\"%s\","
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"coupled_complex_dof_count\":%llu%s},"
                "\"artifacts\":{\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
                "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
                "\"response_progress_v1_path\":\"response/progress.v1.json\","
                "\"frequency_point_paths\":[]},"
                "\"diagnostics\":{\"requested_frequency_count\":%llu,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0},"
                "\"capabilities\":{\"production_solver_available\":false,"
                "\"validation_fallback_used\":false,"
                "\"dynamic_demag_k_available\":false,"
                "\"floquet_response_available\":false,"
                "\"gpu_available\":false}}",
                revision,
                validation_error,
                spin_wave_bc,
                spin_wave_bc,
                magnetic_bc,
                magnetic_bc,
                magnetostatic_bc,
                magnetostatic_bc,
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                static_cast<unsigned long long>(coupled_complex_dof_count),
                phase_validation_json.c_str(),
                static_cast<unsigned long long>(request.solve_request.frequency_count)) ||
            !append_sweep_progress_artifact_json(
                progress_json,
                error_message,
                "validation_error",
                false,
                "validation_error",
                request.solve_request.frequency_count,
                0,
                0,
                "null",
                true,
                "frequency_domain/manifest.v1.json")) {
            return FrequencyDomainStatus::artifact_error;
        }

        FrequencyDomainStatus status = ensure_directory(request.output_directory, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(frequency_domain_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(response_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(diagnostics_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(manifest, manifest_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(progress, progress_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        std::snprintf(manifest_path, 256, "%s", manifest);
        return FrequencyDomainStatus::ok;
    };

    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status =
        write_validation_error_artifacts(manifest_path, artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    char diagnostics_json[2048]{};
    char result_json[512]{};
    const bool floquet_airbox =
        request.requires_floquet_airbox_dynamic_demag;
    const char *magnetic_bc = floquet_airbox ? "floquet" : "periodic";
    const char *magnetostatic_bc = floquet_airbox
        ? "floquet_airbox"
        : "periodic_airbox_k0";
    char phase_validation_json[160]{};
    if (delta_phi_phase_validation_status != nullptr) {
        const int phase_validation_written = std::snprintf(
            phase_validation_json,
            sizeof(phase_validation_json),
            ",\"delta_phi_phase_validation_status\":\"%s\","
            "\"delta_phi_phase_max_residual\":%.17g",
            delta_phi_phase_validation_status,
            delta_phi_phase_max_residual);
        if (phase_validation_written < 0 ||
            static_cast<std::size_t>(phase_validation_written) >= sizeof(phase_validation_json)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                "periodic-airbox phase validation JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }
    }
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"validation_error\":\"%s\","
        "\"requested_magnetic_bc\":\"%s\","
        "\"resolved_magnetic_bc\":\"%s\","
        "\"requested_magnetostatic_bc\":\"%s\","
        "\"resolved_magnetostatic_bc\":\"%s\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_node_pair_count\":%llu,"
        "\"periodic_airbox_coupled_block_solver\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"completed_frequency_point_count\":0%s}",
        validation_error,
        magnetic_bc,
        magnetic_bc,
        magnetostatic_bc,
        magnetostatic_bc,
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(
            request.periodic_airbox_magnetostatic_periodic_node_pair_count),
        phase_validation_json);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"validation_error\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"validation_error\":\"%s\","
        "\"artifact_manifest_path\":\"%s\"}",
        validation_error,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "periodic-airbox constraint-set validation JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::validation_error;
    assign_result_strings(
        result,
        message,
        diagnostics_json,
        result_json,
        manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_periodic_airbox_missing_constraint_sets(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    return solve_periodic_airbox_validation_error(
        request,
        result,
        "periodic_airbox_missing_periodic_constraint_sets",
        "periodic-airbox dynamic demag requires both magnetic delta_m and magnetostatic delta_phi periodic constraint sets");
}

FrequencyDomainStatus solve_periodic_airbox_missing_delta_phi_dofs(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    return solve_periodic_airbox_validation_error(
        request,
        result,
        "periodic_airbox_missing_delta_phi_dofs",
        "periodic-airbox dynamic demag requires at least one delta_phi scalar-potential DOF");
}

FrequencyDomainStatus solve_periodic_airbox_missing_magnetostatic_periodic_node_pairs(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    return solve_periodic_airbox_validation_error(
        request,
        result,
        "periodic_airbox_missing_magnetostatic_periodic_node_pairs",
        "periodic-airbox dynamic demag requires magnetostatic delta_phi periodic node pairs");
}

FrequencyDomainStatus solve_periodic_airbox_degenerate_magnetostatic_periodic_node_pair(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    return solve_periodic_airbox_validation_error(
        request,
        result,
        "periodic_airbox_degenerate_magnetostatic_periodic_node_pair",
        "periodic-airbox dynamic demag requires distinct magnetostatic delta_phi nodes in each periodic pair");
}

FrequencyDomainStatus solve_periodic_airbox_magnetostatic_periodic_node_pair_out_of_range(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    return solve_periodic_airbox_validation_error(
        request,
        result,
        "periodic_airbox_magnetostatic_periodic_node_pair_out_of_range",
        "periodic-airbox dynamic demag requires magnetostatic delta_phi periodic node pairs to be inside delta_phi DOFs");
}

FrequencyDomainStatus solve_mfem_validation_problem(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const DrivenFrequencyResponseMfemValidationProblem &problem = request.mfem_validation_problem;
    if (problem.drive_real == nullptr) {
        result.status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            result,
            "MFEM driven response validation problem requires drive buffer",
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return result.status;
    }

    constexpr std::uint64_t max_response_dof_count = 16;
    constexpr std::uint64_t max_response_frequency_count = 16;
    constexpr std::uint64_t max_response_value_count = max_response_dof_count * max_response_frequency_count;
    double response_real[max_response_value_count]{};
    double response_imag[max_response_value_count]{};
    double residual_l2_norm[max_response_frequency_count]{};
    double relative_residual_l2_norm[max_response_frequency_count]{};
    MfemDrivenResponseValidationResult validation_result{};
    const FrequencyDomainStatus validation_status = solve_mfem_driven_response_validation_problem(
        MfemDrivenResponseValidationProblem{
            problem.descriptor,
            problem.layout,
            problem.nodes,
            problem.exchange_edges,
            problem.exchange_edge_count,
            problem.h_ext_a_per_m,
            problem.uniaxial_anisotropy_axis,
            problem.uniaxial_anisotropy_field_a_per_m,
            problem.alpha_per_node,
            problem.dmi_elements,
            problem.dmi_element_count,
            problem.dmi_lumped_mass,
            problem.dmi_ms_field,
            problem.dmi_uniform_ms,
            request.solve_request.operator_request.gamma0,
            request.solve_request.operator_request.alpha,
            request.solve_request.frequencies_hz,
            request.solve_request.frequency_count,
            problem.drive_real,
            response_real,
            response_imag,
            max_response_value_count,
            residual_l2_norm,
            relative_residual_l2_norm,
            max_response_frequency_count,
            request.cancel_requested,
            request.cancel_user_data,
            problem.drive_imag,
        },
        &validation_result);
    if (validation_status == FrequencyDomainStatus::interrupted) {
        char diagnostics_json[512]{};
        char result_json[384]{};
        char manifest_path[256]{};
        char artifact_error[128]{};
        FrequencyDomainStatus artifact_status = write_mfem_validation_artifacts(
            request,
            validation_result,
            response_real,
            response_imag,
            residual_l2_norm,
            relative_residual_l2_norm,
            "interrupted",
            false,
            manifest_path,
            artifact_error);
        if (artifact_status != FrequencyDomainStatus::ok) {
            result.status = artifact_status;
            assign_result_strings(
                result,
                artifact_error,
                status_diagnostics_json(FrequencyDomainStatus::unavailable),
                status_result_json(FrequencyDomainStatus::unavailable),
                "");
            return result.status;
        }
        const std::uint64_t written_artifacts =
            has_output_directory(request.output_directory) && request.write_partial_artifacts ?
            validation_result.completed_frequency_count :
            0;
        const int diagnostics_written = std::snprintf(
            diagnostics_json,
            sizeof(diagnostics_json),
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"status\":\"interrupted\","
            "\"complete\":false,"
            "\"partial_artifacts_available\":%s,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu}",
            written_artifacts > 0 ? "true" : "false",
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(written_artifacts));
        const int result_written = std::snprintf(
            result_json,
            sizeof(result_json),
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"status\":\"interrupted\","
            "\"completed_frequency_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"partial_artifacts_available\":%s,"
            "\"artifact_manifest_path\":\"%s\"}",
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(written_artifacts),
            written_artifacts > 0 ? "true" : "false",
            manifest_path);
        if (diagnostics_written < 0 ||
            result_written < 0 ||
            static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
            static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
            result.status = FrequencyDomainStatus::artifact_error;
            assign_result_strings(
                result,
                "MFEM driven response interrupted result JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::unavailable),
                status_result_json(FrequencyDomainStatus::unavailable),
                "");
            return result.status;
        }

        result.status = FrequencyDomainStatus::interrupted;
        result.completed_frequency_count = validation_result.completed_frequency_count;
        result.written_frequency_point_artifacts = written_artifacts;
        assign_result_strings(
            result,
            validation_result.error_message,
            diagnostics_json,
            result_json,
            manifest_path);
        return result.status;
    }
    if (validation_status != FrequencyDomainStatus::ok) {
        result.status = validation_status;
        assign_result_strings(
            result,
            validation_result.error_message,
            status_diagnostics_json(validation_status),
            status_result_json(validation_status),
            "");
        return result.status;
    }

    char diagnostics_json[512]{};
    char result_json[384]{};
    char manifest_path[256]{};
    char artifact_error[128]{};
    FrequencyDomainStatus artifact_status = write_mfem_validation_artifacts(
        request,
        validation_result,
        response_real,
        response_imag,
        residual_l2_norm,
        relative_residual_l2_norm,
        "ok",
        true,
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"dense_block_real_solver\":true,"
        "\"assembled_mfem_operator_solver\":true,"
        "\"completed_frequency_point_count\":%llu,"
        "\"tangent_dof_count\":%llu,"
        "\"max_abs_stiffness_matrix\":%.17g,"
        "\"max_abs_mass_matrix\":%.17g}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(request.solve_request.operator_request.tangent_dof_count),
        validation_result.max_abs_stiffness_matrix,
        validation_result.max_abs_mass_matrix);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"ok\","
        "\"completed_frequency_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"max_frequency_hz\":%.17g,"
        "\"max_abs_response\":%.17g,"
        "\"artifact_manifest_path\":\"%s\"}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(has_output_directory(request.output_directory) ? validation_result.completed_frequency_count : 0),
        validation_result.max_frequency_hz,
        validation_result.max_abs_response,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "MFEM driven response validation result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::ok;
    result.completed_frequency_count = validation_result.completed_frequency_count;
    result.written_frequency_point_artifacts = has_output_directory(request.output_directory) ?
        validation_result.completed_frequency_count :
        0;
    assign_result_strings(
        result,
        "",
        diagnostics_json,
        result_json,
        manifest_path);
    return result.status;
}

double canonical_phase_residual_rad(double phase_rad)
{
    const double pi = std::acos(-1.0);
    const double two_pi = 2.0 * pi;
    double value = std::fmod(phase_rad + pi, two_pi);
    if (value < 0.0) {
        value += two_pi;
    }
    value -= pi;
    if (value <= -pi) {
        value += two_pi;
    }
    return value;
}

bool driven_response_request_has_nonzero_floquet_metadata(
    const DrivenFrequencyResponseSolveRequest &request)
{
    constexpr double tolerance = 1.0e-12;
    if (request.has_floquet_k_vector) {
        for (double component : request.floquet_k_vector_rad_per_m) {
            if (!std::isfinite(component) || std::abs(component) > tolerance) {
                return true;
            }
        }
    }
    if (request.floquet_periodic_pair_count > 0 &&
        request.floquet_periodic_pairs == nullptr) {
        return true;
    }
    for (std::uint64_t pair_index = 0;
         pair_index < request.floquet_periodic_pair_count;
         ++pair_index) {
        const FrequencyDomainFloquetPeriodicPair &pair =
            request.floquet_periodic_pairs[pair_index];
        if (pair.has_phase &&
            (!std::isfinite(pair.phase_rad) ||
             std::abs(canonical_phase_residual_rad(pair.phase_rad)) > tolerance)) {
            return true;
        }
    }
    return false;
}

bool validate_driven_response_floquet_phase_metadata(
    const DrivenFrequencyResponseSolveRequest &request,
    char error_message[128]) noexcept
{
    if (!request.has_floquet_k_vector ||
        request.floquet_periodic_pair_count == 0 ||
        request.floquet_periodic_pairs == nullptr) {
        return true;
    }
    constexpr double tolerance = 1.0e-10;
    for (std::uint64_t pair_index = 0;
         pair_index < request.floquet_periodic_pair_count;
         ++pair_index) {
        const FrequencyDomainFloquetPeriodicPair &pair =
            request.floquet_periodic_pairs[pair_index];
        if (!pair.has_phase || !pair.has_translation) {
            continue;
        }
        double k_dot_translation = 0.0;
        for (std::uint64_t axis = 0; axis < 3; ++axis) {
            const double k_component = request.floquet_k_vector_rad_per_m[axis];
            const double translation = pair.translation_m[axis];
            if (!std::isfinite(k_component) || !std::isfinite(translation)) {
                std::snprintf(
                    error_message,
                    128,
                    "Floquet phase metadata requires finite k vector and translation");
                return false;
            }
            k_dot_translation += k_component * translation;
        }
        const double expected_phase = -k_dot_translation;
        const double phase_residual =
            canonical_phase_residual_rad(pair.phase_rad - expected_phase);
        if (!std::isfinite(pair.phase_rad) ||
            std::abs(phase_residual) > tolerance) {
            std::snprintf(
                error_message,
                128,
                "Floquet phase metadata must satisfy phase_rad = -k dot translation");
            return false;
        }
    }
    return true;
}

bool can_solve_floquet_projected_no_demag_response(
    const DrivenFrequencyResponseSolveRequest &request) noexcept
{
    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    const bool no_exchange =
        !problem.descriptor.exchange_enabled &&
        problem.exchange_edge_count == 0 &&
        problem.exchange_edges == nullptr;
    const bool exchange_edge_slice =
        problem.descriptor.exchange_enabled &&
        problem.exchange_edge_count > 0 &&
        problem.exchange_edges != nullptr;
    return (request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu ||
            request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) &&
        problem.enabled &&
        problem.drive_real != nullptr &&
        problem.nodes != nullptr &&
        request.floquet_periodic_pair_count > 0 &&
        request.floquet_periodic_pairs != nullptr &&
        request.magnetostatic_periodic_constraint_set_count == 0 &&
        !request.requires_periodic_airbox_dynamic_demag &&
        !request.requires_floquet_airbox_dynamic_demag &&
        request.solve_request.operator_request.demag_kind == FrequencyDomainDemagKind::none &&
        !problem.descriptor.demag_enabled &&
        problem.apply_demag_tangent == nullptr &&
        problem.demag_tangent_matrix_row_major == nullptr &&
        (no_exchange || exchange_edge_slice) &&
        !problem.descriptor.dmi_enabled &&
        problem.dmi_element_count == 0;
}

struct FloquetPhaseConstraintValidation {
    const char *validation_error = "";
    const char *error_message = "";
    double max_phase_loop_residual = 0.0;
    double max_frame_mismatch = 0.0;
    double max_drive_mismatch = 0.0;
};

bool validate_driven_response_floquet_phase_constraints(
    const DrivenFrequencyResponseSolveRequest &request,
    FloquetPhaseConstraintValidation &validation) noexcept
{
    if (!driven_response_request_has_nonzero_floquet_metadata(request) ||
        request.floquet_periodic_pair_count == 0) {
        return true;
    }
    if (request.floquet_periodic_pairs == nullptr) {
        validation.validation_error = "floquet_periodic_pair_buffer_missing";
        validation.error_message =
            "nonzero-k Floquet driven response requires a Floquet periodic pair buffer";
        return false;
    }
    if (request.requires_floquet_airbox_dynamic_demag &&
        request.periodic_airbox_magnetostatic_periodic_node_pair_count > 0 &&
        request.periodic_airbox_magnetostatic_periodic_node_pairs == nullptr) {
        validation.validation_error = "floquet_airbox_missing_delta_phi_periodic_node_pairs";
        validation.error_message =
            "Floquet-airbox dynamic demag requires Floquet-airbox delta_phi periodic node pairs";
        return false;
    }
    if (request.requires_floquet_airbox_dynamic_demag &&
        request.periodic_airbox_magnetostatic_periodic_node_pair_count > 0) {
        const bool gpu_unavailable_boundary =
            request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu;
        for (std::uint64_t pair_index = 0;
             pair_index < request.periodic_airbox_magnetostatic_periodic_node_pair_count;
             ++pair_index) {
            const std::uint64_t node_a =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2];
            const std::uint64_t node_b =
                request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2 + 1];
            if (node_a >= request.periodic_airbox_delta_phi_dof_count ||
                node_b >= request.periodic_airbox_delta_phi_dof_count) {
                validation.validation_error =
                    "floquet_airbox_delta_phi_periodic_node_pair_out_of_range";
                validation.error_message =
                    "Floquet-airbox delta_phi periodic node pair is outside delta_phi DOFs";
                return false;
            }
            if (node_a == node_b) {
                validation.validation_error =
                    "floquet_airbox_degenerate_delta_phi_periodic_node_pair";
                validation.error_message =
                    "Floquet-airbox dynamic demag requires distinct Floquet-airbox delta_phi nodes";
                return false;
            }
            if (gpu_unavailable_boundary) {
                continue;
            }
            bool has_matching_phase_metadata = false;
            for (std::uint64_t floquet_pair_index = 0;
                 floquet_pair_index < request.floquet_periodic_pair_count;
                 ++floquet_pair_index) {
                const FrequencyDomainFloquetPeriodicPair &pair =
                    request.floquet_periodic_pairs[floquet_pair_index];
                if (pair.node_a == node_a &&
                    pair.node_b == node_b &&
                    pair.has_phase &&
                    pair.has_translation) {
                    has_matching_phase_metadata = true;
                    break;
                }
            }
            if (!has_matching_phase_metadata) {
                validation.validation_error =
                    "floquet_airbox_delta_phi_pair_missing_phase_metadata";
                validation.error_message =
                    "Floquet-airbox delta_phi pair requires matching Floquet phase metadata";
                return false;
            }
        }
    }

    const DrivenFrequencyResponseMfemValidationProblem &problem =
        request.mfem_validation_problem;
    if (!problem.enabled) {
        return true;
    }

    const std::uint64_t node_count = problem.descriptor.node_count;
    const std::uint64_t tangent_dof_count = problem.layout.tangent_dof_count;
    if (node_count == 0 || node_count > tangent_dof_count / 2) {
        validation.validation_error = "floquet_tangent_layout_mismatch";
        validation.error_message =
            "nonzero-k Floquet driven response requires a node-aligned tangent layout";
        return false;
    }

    constexpr double tolerance = 1.0e-10;
    std::vector<double> node_phase(static_cast<std::size_t>(node_count), 0.0);
    std::vector<unsigned char> node_phase_known(static_cast<std::size_t>(node_count), 0);
    for (std::uint64_t seed = 0; seed < node_count; ++seed) {
        if (node_phase_known[static_cast<std::size_t>(seed)] != 0) {
            continue;
        }
        node_phase_known[static_cast<std::size_t>(seed)] = 1;
        node_phase[static_cast<std::size_t>(seed)] = 0.0;
        bool changed = true;
        while (changed) {
            changed = false;
            for (std::uint64_t pair_index = 0;
                 pair_index < request.floquet_periodic_pair_count;
                 ++pair_index) {
                const FrequencyDomainFloquetPeriodicPair &pair =
                    request.floquet_periodic_pairs[pair_index];
                if (!pair.has_phase) {
                    continue;
                }
                if (pair.node_a >= node_count || pair.node_b >= node_count) {
                    validation.validation_error = "floquet_periodic_pair_node_out_of_range";
                    validation.error_message =
                        "nonzero-k Floquet driven response has an invalid periodic node pair";
                    return false;
                }
                if (!std::isfinite(pair.phase_rad)) {
                    validation.validation_error = "floquet_phase_loop_mismatch";
                    validation.error_message =
                        "nonzero-k Floquet phase loop validation requires finite pair phases";
                    return false;
                }
                const std::size_t node_a = static_cast<std::size_t>(pair.node_a);
                const std::size_t node_b = static_cast<std::size_t>(pair.node_b);
                const bool phase_a_known = node_phase_known[node_a] != 0;
                const bool phase_b_known = node_phase_known[node_b] != 0;
                if (phase_a_known && phase_b_known) {
                    const double phase_loop_residual = std::abs(
                        canonical_phase_residual_rad(
                            node_phase[node_b] - node_phase[node_a] - pair.phase_rad));
                    validation.max_phase_loop_residual = std::max(
                        validation.max_phase_loop_residual,
                        phase_loop_residual);
                    if (phase_loop_residual > tolerance) {
                        validation.validation_error = "floquet_phase_loop_mismatch";
                        validation.error_message =
                            "nonzero-k Floquet phase loop constraints are inconsistent";
                        return false;
                    }
                } else if (phase_a_known) {
                    node_phase[node_b] = node_phase[node_a] + pair.phase_rad;
                    node_phase_known[node_b] = 1;
                    changed = true;
                } else if (phase_b_known) {
                    node_phase[node_a] = node_phase[node_b] - pair.phase_rad;
                    node_phase_known[node_a] = 1;
                    changed = true;
                }
            }
        }
    }

    if (problem.nodes != nullptr) {
        for (std::uint64_t pair_index = 0;
             pair_index < request.floquet_periodic_pair_count;
             ++pair_index) {
            const FrequencyDomainFloquetPeriodicPair &pair =
                request.floquet_periodic_pairs[pair_index];
            if (pair.node_a >= node_count || pair.node_b >= node_count) {
                validation.validation_error = "floquet_periodic_pair_node_out_of_range";
                validation.error_message =
                    "nonzero-k Floquet driven response has an invalid periodic node pair";
                return false;
            }
            validation.max_frame_mismatch = std::max(
                validation.max_frame_mismatch,
                floquet_pair_frame_mismatch(
                    problem.nodes[static_cast<std::size_t>(pair.node_a)],
                    problem.nodes[static_cast<std::size_t>(pair.node_b)]));
        }
        if (validation.max_frame_mismatch > tolerance) {
            validation.validation_error = "floquet_tangent_frame_mismatch";
            validation.error_message =
                "nonzero-k Floquet tangent frames require matching equilibrium tangent frames on paired nodes";
            return false;
        }
    }

    if (problem.drive_real == nullptr) {
        return true;
    }
    for (std::uint64_t pair_index = 0;
         pair_index < request.floquet_periodic_pair_count;
         ++pair_index) {
        const FrequencyDomainFloquetPeriodicPair &pair =
            request.floquet_periodic_pairs[pair_index];
        if (!pair.has_phase) {
            continue;
        }
        if (pair.node_a >= node_count || pair.node_b >= node_count) {
            validation.validation_error = "floquet_periodic_pair_node_out_of_range";
            validation.error_message =
                "nonzero-k Floquet driven response has an invalid periodic node pair";
            return false;
        }
        const double c = std::cos(pair.phase_rad);
        const double s = std::sin(pair.phase_rad);
        for (std::uint64_t component = 0; component < 2; ++component) {
            const std::uint64_t source_dof = pair.node_a * 2 + component;
            const std::uint64_t destination_dof = pair.node_b * 2 + component;
            const double source_real = problem.drive_real[source_dof];
            const double source_imag =
                problem.drive_imag == nullptr ? 0.0 : problem.drive_imag[source_dof];
            const double destination_real = problem.drive_real[destination_dof];
            const double destination_imag =
                problem.drive_imag == nullptr ? 0.0 : problem.drive_imag[destination_dof];
            const double expected_real = c * source_real - s * source_imag;
            const double expected_imag = s * source_real + c * source_imag;
            validation.max_drive_mismatch = std::max(
                validation.max_drive_mismatch,
                std::abs(destination_real - expected_real));
            validation.max_drive_mismatch = std::max(
                validation.max_drive_mismatch,
                std::abs(destination_imag - expected_imag));
        }
    }
    if (validation.max_drive_mismatch > tolerance) {
        validation.validation_error = "floquet_drive_phase_mismatch";
        validation.error_message =
            "nonzero-k Floquet driven response requires Floquet-periodic tangent drive values";
        return false;
    }
    return true;
}

FrequencyDomainStatus solve_floquet_phase_constraint_validation_error(
    const DrivenFrequencyResponseSolveRequest &request,
    const FloquetPhaseConstraintValidation &validation,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    auto write_validation_error_artifacts = [&](
        char manifest_path[256],
        char error_message[128]) noexcept -> FrequencyDomainStatus {
        if (!has_output_directory(request.output_directory) ||
            !request.write_partial_artifacts) {
            manifest_path[0] = '\0';
            return FrequencyDomainStatus::ok;
        }

        char frequency_domain_dir[256]{};
        char response_dir[256]{};
        char diagnostics_dir[256]{};
        char manifest[256]{};
        char solver_diagnostics[256]{};
        char progress[256]{};
        if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
            std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
            std::snprintf(diagnostics_dir, sizeof(diagnostics_dir), "%s/diagnostics", response_dir) < 0 ||
            std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
            std::snprintf(solver_diagnostics, sizeof(solver_diagnostics), "%s/solver.v1.json", diagnostics_dir) < 0 ||
            std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0) {
            std::snprintf(error_message, 128, "failed to format Floquet validation artifact paths");
            return FrequencyDomainStatus::artifact_error;
        }
        if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
            std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
            std::strlen(diagnostics_dir) >= sizeof(diagnostics_dir) - 1 ||
            std::strlen(manifest) >= sizeof(manifest) - 1 ||
            std::strlen(solver_diagnostics) >= sizeof(solver_diagnostics) - 1 ||
            std::strlen(progress) >= sizeof(progress) - 1) {
            std::snprintf(error_message, 128, "Floquet validation artifact path exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }

        std::string diagnostics_json;
        std::string manifest_json;
        std::string progress_json;
        if (!append_format(
                diagnostics_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
                "\"solver_engine\":\"native_fem_mfem_driven_response\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"validation_error\":\"%s\","
                "\"requested_execution_lane\":\"%s\","
                "\"requested_spin_wave_bc\":\"floquet\","
                "\"resolved_spin_wave_bc\":\"floquet\","
                "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\","
                "\"floquet_phase_loop_max_residual\":%.17g,"
                "\"floquet_tangent_frame_max_mismatch\":%.17g,"
                "\"floquet_tangent_transport_max_nonunitarity\":0.0,"
                "\"floquet_drive_max_mismatch\":%.17g,"
                "\"basis_transport_policy\":\"rejected\","
                "\"production_solver_available\":false,"
                "\"validation_fallback_used\":false,"
                "\"dense_block_real_solver\":false,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0}",
                validation.validation_error,
                execution_lane_to_string(request.execution_lane),
                validation.max_phase_loop_residual,
                validation.max_frame_mismatch,
                validation.max_drive_mismatch) ||
            !append_format(
                manifest_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_manifest.v1\","
                "\"analysis_family\":\"magnetic_frequency_domain\","
                "\"study_product\":\"driven_response\","
                "\"revision\":\"floquet-validation-error-v1\","
                "\"created_at\":\"1970-01-01T00:00:00Z\","
                "\"session_id\":\"native-validation\","
                "\"run_id\":\"native-validation\","
                "\"stage_id\":\"frequency-response-floquet-validation\","
                "\"stage_kind\":\"frequency_response\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"validation_error\":\"%s\","
                "\"physics\":{\"requested_spin_wave_bc\":\"floquet\","
                "\"resolved_spin_wave_bc\":\"floquet\","
                "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\","
                "\"floquet_periodic_pair_count\":%llu},"
                "\"artifacts\":{\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
                "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
                "\"response_progress_v1_path\":\"response/progress.v1.json\","
                "\"frequency_point_paths\":[]},"
                "\"diagnostics\":{\"requested_frequency_count\":%llu,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0,"
                "\"floquet_phase_loop_max_residual\":%.17g,"
                "\"floquet_tangent_frame_max_mismatch\":%.17g,"
                "\"floquet_tangent_transport_max_nonunitarity\":0.0,"
                "\"floquet_drive_max_mismatch\":%.17g,"
                "\"basis_transport_policy\":\"rejected\"},"
                "\"capabilities\":{\"production_solver_available\":false,"
                "\"validation_fallback_used\":false,"
                "\"dynamic_demag_k_available\":false,"
                "\"floquet_response_available\":false}}",
                validation.validation_error,
                static_cast<unsigned long long>(request.floquet_periodic_pair_count),
                static_cast<unsigned long long>(request.solve_request.frequency_count),
                validation.max_phase_loop_residual,
                validation.max_frame_mismatch,
                validation.max_drive_mismatch) ||
            !append_sweep_progress_artifact_json(
                progress_json,
                error_message,
                "validation_error",
                false,
                "validation_error",
                request.solve_request.frequency_count,
                0,
                0,
                "null",
                true,
                "frequency_domain/manifest.v1.json")) {
            return FrequencyDomainStatus::artifact_error;
        }

        FrequencyDomainStatus status = ensure_directory(request.output_directory, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(frequency_domain_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(response_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(diagnostics_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(manifest, manifest_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(progress, progress_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        std::snprintf(manifest_path, 256, "%s", manifest);
        return FrequencyDomainStatus::ok;
    };

    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status =
        write_validation_error_artifacts(manifest_path, artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    char diagnostics_json[768]{};
    char result_json[512]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"validation_error\":\"%s\","
        "\"floquet_phase_loop_max_residual\":%.17g,"
        "\"floquet_tangent_frame_max_mismatch\":%.17g,"
        "\"floquet_tangent_transport_max_nonunitarity\":0.0,"
        "\"floquet_drive_max_mismatch\":%.17g,"
        "\"basis_transport_policy\":\"rejected\","
        "\"production_solver_available\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"completed_frequency_point_count\":0}",
        validation.validation_error,
        validation.max_phase_loop_residual,
        validation.max_frame_mismatch,
        validation.max_drive_mismatch);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"validation_error\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"validation_error\":\"%s\","
        "\"artifact_manifest_path\":\"%s\"}",
        validation.validation_error,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "Floquet phase-constraint validation JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::validation_error;
    result.completed_frequency_count = 0;
    result.written_frequency_point_artifacts = 0;
    assign_result_strings(
        result,
        validation.error_message,
        diagnostics_json,
        result_json,
        manifest_path);
    return result.status;
}

FrequencyDomainStatus solve_floquet_nonzero_k_unavailable(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    const bool floquet_airbox_dynamic_demag =
        request.requires_floquet_airbox_dynamic_demag;
    const bool floquet_airbox_gpu_request =
        floquet_airbox_dynamic_demag &&
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu;
    const char *unsupported_reason = floquet_airbox_gpu_request
        ? "floquet_airbox_dynamic_demag_gpu_unsupported"
        : floquet_airbox_dynamic_demag
            ? "floquet_airbox_dynamic_demag_k_unimplemented"
            : "floquet_bloch_nonzero_k";
    const char *message = floquet_airbox_gpu_request
        ? "native FEM frequency-domain production GPU does not implement Floquet-airbox dynamic demag-k"
        : floquet_airbox_dynamic_demag
            ? "native FEM driven frequency response does not implement Floquet-airbox dynamic demag-k"
            : "native FEM driven frequency response does not implement Floquet/Bloch nonzero-k solve";
    const char *requested_magnetostatic_bc = floquet_airbox_dynamic_demag
        ? "floquet_airbox"
        : "open";
    const char *resolved_magnetostatic_bc = requested_magnetostatic_bc;
    const char *requested_execution_lane = execution_lane_to_string(request.execution_lane);
    const char *lane_classification =
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu
            ? "fem_gpu_production"
            : request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu
                ? "fem_cpu_production"
                : "fem_validation_unavailable";
    const std::uint64_t delta_m_tangent_dof_count =
        request.periodic_airbox_delta_m_tangent_dof_count > 0
            ? request.periodic_airbox_delta_m_tangent_dof_count
            : request.solve_request.operator_request.tangent_dof_count;
    auto write_unavailable_artifacts = [&](
        char manifest_path[256],
        char error_message[128]) noexcept -> FrequencyDomainStatus {
        if (!has_output_directory(request.output_directory) ||
            !request.write_partial_artifacts) {
            manifest_path[0] = '\0';
            return FrequencyDomainStatus::ok;
        }

        char frequency_domain_dir[256]{};
        char response_dir[256]{};
        char mesh_dir[256]{};
        char diagnostics_dir[256]{};
        char manifest[256]{};
        char solver_diagnostics[256]{};
        char progress[256]{};
        char periodic_pairs[256]{};
        if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
            std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
            std::snprintf(mesh_dir, sizeof(mesh_dir), "%s/mesh", request.output_directory) < 0 ||
            std::snprintf(diagnostics_dir, sizeof(diagnostics_dir), "%s/diagnostics", response_dir) < 0 ||
            std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
            std::snprintf(solver_diagnostics, sizeof(solver_diagnostics), "%s/solver.v1.json", diagnostics_dir) < 0 ||
            std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0 ||
            std::snprintf(periodic_pairs, sizeof(periodic_pairs), "%s/periodic_pairs.v1.json", mesh_dir) < 0) {
            std::snprintf(error_message, 128, "failed to format Floquet unavailable artifact paths");
            return FrequencyDomainStatus::artifact_error;
        }
        if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
            std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
            std::strlen(mesh_dir) >= sizeof(mesh_dir) - 1 ||
            std::strlen(diagnostics_dir) >= sizeof(diagnostics_dir) - 1 ||
            std::strlen(manifest) >= sizeof(manifest) - 1 ||
            std::strlen(solver_diagnostics) >= sizeof(solver_diagnostics) - 1 ||
            std::strlen(progress) >= sizeof(progress) - 1 ||
            std::strlen(periodic_pairs) >= sizeof(periodic_pairs) - 1) {
            std::snprintf(error_message, 128, "Floquet unavailable artifact path exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }

        std::string diagnostics_json;
        std::string manifest_json;
        std::string progress_json;
        std::string periodic_pairs_json;
        const char *periodic_pairs_path_json = floquet_airbox_dynamic_demag
            ? "\"mesh/periodic_pairs.v1.json\""
            : "null";
        const char *delta_phi_flux_validation_status = floquet_airbox_dynamic_demag
            ? "not_evaluated"
            : "not_applicable";
        const char *delta_phi_flux_validation_reason = floquet_airbox_dynamic_demag
            ? unsupported_reason
            : "no_floquet_airbox_delta_phi_constraint";
        if (floquet_airbox_dynamic_demag) {
            const bool has_magnetostatic_pairs =
                request.periodic_airbox_magnetostatic_periodic_node_pair_count > 0 &&
                request.periodic_airbox_magnetostatic_periodic_node_pairs != nullptr;
            const std::uint64_t magnetostatic_pair_count = has_magnetostatic_pairs
                ? request.periodic_airbox_magnetostatic_periodic_node_pair_count
                : 0;
            if (!append_format(
                    periodic_pairs_json,
                    error_message,
                    "{\"schema_version\":\"periodic_pairs.v1\","
                    "\"source\":\"native_fem_frequency_domain_floquet_airbox_unavailable\","
                    "\"validation_status\":\"unavailable\","
                    "\"unsupported_reason\":\"%s\","
                    "\"pair_count\":%llu,"
                    "\"paired_node_count\":%llu,"
                    "\"unpaired_source_count\":0,"
                    "\"unpaired_destination_count\":0,"
                    "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\","
                    "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
                    "\"delta_phi_flux_validation_status\":\"%s\","
                    "\"delta_phi_flux_validation_reason\":\"%s\","
                    "\"magnetic_periodic_constraint_set_count\":%llu,"
                    "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                    "\"magnetostatic_periodic_node_pair_count\":%llu,"
                    "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0,"
                    "\"delta_phi_flux_validation_status\":\"%s\"},"
                    "\"pairs\":[",
                    unsupported_reason,
                    static_cast<unsigned long long>(magnetostatic_pair_count),
                    static_cast<unsigned long long>(magnetostatic_pair_count * 2),
                    request.floquet_k_vector_rad_per_m[0],
                    request.floquet_k_vector_rad_per_m[1],
                    request.floquet_k_vector_rad_per_m[2],
                    delta_phi_flux_validation_status,
                    delta_phi_flux_validation_reason,
                    static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                    static_cast<unsigned long long>(
                        request.magnetostatic_periodic_constraint_set_count),
                    static_cast<unsigned long long>(
                        request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                    delta_phi_flux_validation_status)) {
                return FrequencyDomainStatus::artifact_error;
            }
            if (has_magnetostatic_pairs) {
                for (std::uint64_t pair_index = 0;
                     pair_index < request.periodic_airbox_magnetostatic_periodic_node_pair_count;
                     ++pair_index) {
                    const std::uint64_t node_a =
                        request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2];
                    const std::uint64_t node_b =
                        request.periodic_airbox_magnetostatic_periodic_node_pairs[pair_index * 2 + 1];
                    const FrequencyDomainFloquetPeriodicPair *phase_metadata = nullptr;
                    for (std::uint64_t floquet_pair_index = 0;
                         floquet_pair_index < request.floquet_periodic_pair_count;
                         ++floquet_pair_index) {
                        const FrequencyDomainFloquetPeriodicPair &candidate =
                            request.floquet_periodic_pairs[floquet_pair_index];
                        if (candidate.node_a == node_a &&
                            candidate.node_b == node_b &&
                            candidate.has_phase &&
                            candidate.has_translation) {
                            phase_metadata = &candidate;
                            break;
                        }
                    }
                    const double phase_rad =
                        phase_metadata != nullptr ? phase_metadata->phase_rad : 0.0;
                    const double translation_x =
                        phase_metadata != nullptr ? phase_metadata->translation_m[0] : 0.0;
                    const double translation_y =
                        phase_metadata != nullptr ? phase_metadata->translation_m[1] : 0.0;
                    const double translation_z =
                        phase_metadata != nullptr ? phase_metadata->translation_m[2] : 0.0;
                    double expected_phase_rad = 0.0;
                    if (phase_metadata != nullptr) {
                        for (std::uint64_t axis = 0; axis < 3; ++axis) {
                            expected_phase_rad -=
                                request.floquet_k_vector_rad_per_m[axis] *
                                phase_metadata->translation_m[axis];
                        }
                    }
                    const double phase_residual_rad =
                        canonical_phase_residual_rad(phase_rad - expected_phase_rad);
                    if (!append_format(
                            periodic_pairs_json,
                            error_message,
                            "%s{\"pair_id\":\"floquet-airbox-delta-phi-%04llu\","
                            "\"pair_family\":\"magnetostatic_delta_phi\","
                            "\"unknown_family\":\"delta_phi\","
                            "\"source_marker\":\"delta_phi_node:%llu\","
                            "\"destination_marker\":\"delta_phi_node:%llu\","
                            "\"node_a\":%llu,"
                            "\"node_b\":%llu,"
                            "\"paired_node_count\":2,"
                            "\"unpaired_source_count\":0,"
                            "\"unpaired_destination_count\":0,"
                            "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\","
                            "\"phase_metadata_status\":\"%s\","
                            "\"phase_rad\":%.17g,"
                            "\"expected_phase_rad\":%.17g,"
                            "\"phase_residual_rad\":%.17g,"
                            "\"translation_m\":[%.17g,%.17g,%.17g],"
                            "\"delta_phi_flux_validation_status\":\"%s\","
                            "\"validation_status\":\"unavailable\","
                            "\"unsupported_reason\":\"%s\"}",
                            pair_index == 0 ? "" : ",",
                            static_cast<unsigned long long>(pair_index),
                            static_cast<unsigned long long>(node_a),
                            static_cast<unsigned long long>(node_b),
                            static_cast<unsigned long long>(node_a),
                            static_cast<unsigned long long>(node_b),
                            phase_metadata != nullptr ? "available" : "missing",
                            phase_rad,
                            expected_phase_rad,
                            phase_residual_rad,
                            translation_x,
                            translation_y,
                            translation_z,
                            delta_phi_flux_validation_status,
                            unsupported_reason)) {
                        return FrequencyDomainStatus::artifact_error;
                    }
                }
            }
            periodic_pairs_json += "]}";
        }
        if (!append_format(
                diagnostics_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
                "\"solver_engine\":\"native_fem_mfem_driven_response\","
                "\"status\":\"unavailable\","
                "\"complete\":false,"
                "\"unsupported_reason\":\"%s\","
                "\"requested_execution_lane\":\"%s\","
                "\"resolved_execution_lane\":\"unavailable\","
                "\"lane_classification\":\"%s\","
                "\"requested_spin_wave_bc\":\"floquet\","
                "\"resolved_spin_wave_bc\":\"floquet\","
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\","
                "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
                "\"floquet_periodic_pair_count\":%llu,"
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"delta_phi_flux_validation_status\":\"%s\","
                "\"delta_phi_flux_validation_reason\":\"%s\","
                "\"dynamic_demag_k_available\":false,"
                "\"production_solver_available\":false,"
                "\"validation_fallback_used\":false,"
                "\"dense_block_real_solver\":false,"
                "\"periodic_airbox_coupled_block_solver\":false,"
                "\"mfem_coupled_block_assembly\":false,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0}",
                unsupported_reason,
                requested_execution_lane,
                lane_classification,
                requested_magnetostatic_bc,
                resolved_magnetostatic_bc,
                request.floquet_k_vector_rad_per_m[0],
                request.floquet_k_vector_rad_per_m[1],
                request.floquet_k_vector_rad_per_m[2],
                static_cast<unsigned long long>(request.floquet_periodic_pair_count),
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                delta_phi_flux_validation_status,
                delta_phi_flux_validation_reason) ||
            !append_format(
                manifest_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_manifest.v1\","
                "\"analysis_family\":\"magnetic_frequency_domain\","
                "\"study_product\":\"driven_response\","
                "\"revision\":\"floquet-nonzero-k-unavailable-v1\","
                "\"created_at\":\"1970-01-01T00:00:00Z\","
                "\"session_id\":\"native-validation\","
                "\"run_id\":\"native-validation\","
                "\"stage_id\":\"frequency-response-floquet-unavailable\","
                "\"stage_kind\":\"frequency_response\","
                "\"status\":\"unavailable\","
                "\"complete\":false,"
                "\"unsupported_reason\":\"%s\","
                "\"requested_execution\":{\"solve_equation\":\"(i omega B - L) q = f\","
                "\"solve_kind\":\"direct_harmonic_response\","
                "\"study_kind\":\"frequency_response\","
                "\"frequency_count\":%llu,"
                "\"write_response_fields\":%s},"
                "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
                "\"engine\":\"native_fem_mfem_frequency_domain\","
                "\"native_backend\":\"native_mfem_unavailable\","
                "\"reference_or_production\":\"production\","
                "\"solver_library\":\"unavailable\","
                "\"solver_model\":\"production_unavailable\","
                "\"solve_kind\":\"direct_harmonic_response\","
                "\"solver_kind\":\"production_unavailable\","
                "\"requested_execution_lane\":\"%s\","
                "\"resolved_execution_lane\":\"unavailable\","
                "\"lane_classification\":\"%s\","
                "\"production_solver\":true},"
                "\"physics\":{\"spin_wave_bc\":{\"kind\":\"floquet\"},"
                "\"periodic_or_floquet\":true,"
                "\"requested_spin_wave_bc\":\"floquet\","
                "\"resolved_spin_wave_bc\":\"floquet\","
                "\"requested_magnetostatic_bc\":\"%s\","
                "\"resolved_magnetostatic_bc\":\"%s\","
                "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\","
                "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
                "\"floquet_periodic_pair_count\":%llu,"
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"delta_phi_flux_validation_status\":\"%s\","
                "\"delta_phi_flux_validation_reason\":\"%s\"},"
                "\"artifacts\":{\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
                "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
                "\"response_progress_v1_path\":\"response/progress.v1.json\","
                "\"periodic_pairs_v1_path\":%s,"
                "\"frequency_point_paths\":[]},"
                "\"diagnostics\":{\"requested_frequency_count\":%llu,"
                "\"requested_execution_lane\":\"%s\","
                "\"resolved_execution_lane\":\"unavailable\","
                "\"lane_classification\":\"%s\","
                "\"unsupported_reason\":\"%s\","
                "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
                "\"floquet_periodic_pair_count\":%llu,"
                "\"validation_fallback_used\":false,"
                "\"periodic_airbox_coupled_block_solver\":false,"
                "\"mfem_coupled_block_assembly\":false,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0,"
                "\"delta_phi_flux_validation_status\":\"%s\","
                "\"delta_phi_flux_validation_reason\":\"%s\"},"
                "\"capabilities\":{\"production_solver_available\":false,"
                "\"production_native_solver_available\":false,"
                "\"validation_artifact\":false,"
                "\"validation_fallback_used\":false,"
                "\"dynamic_demag_k_available\":false,"
                "\"floquet_response_available\":false}}",
                unsupported_reason,
                static_cast<unsigned long long>(request.solve_request.frequency_count),
                request.solve_request.write_response_fields ? "true" : "false",
                requested_execution_lane,
                lane_classification,
                requested_magnetostatic_bc,
                resolved_magnetostatic_bc,
                request.floquet_k_vector_rad_per_m[0],
                request.floquet_k_vector_rad_per_m[1],
                request.floquet_k_vector_rad_per_m[2],
                static_cast<unsigned long long>(request.floquet_periodic_pair_count),
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                delta_phi_flux_validation_status,
                delta_phi_flux_validation_reason,
                periodic_pairs_path_json,
                static_cast<unsigned long long>(request.solve_request.frequency_count),
                requested_execution_lane,
                lane_classification,
                unsupported_reason,
                request.floquet_k_vector_rad_per_m[0],
                request.floquet_k_vector_rad_per_m[1],
                request.floquet_k_vector_rad_per_m[2],
                static_cast<unsigned long long>(request.floquet_periodic_pair_count),
                delta_phi_flux_validation_status,
                delta_phi_flux_validation_reason) ||
            !append_sweep_progress_artifact_json(
                progress_json,
                error_message,
                "unavailable",
                false,
                "unavailable",
                request.solve_request.frequency_count,
                0,
                0,
                "null",
                true,
                "frequency_domain/manifest.v1.json")) {
            return FrequencyDomainStatus::artifact_error;
        }

        FrequencyDomainStatus status = ensure_directory(request.output_directory, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(frequency_domain_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = ensure_directory(response_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (floquet_airbox_dynamic_demag) {
            status = ensure_directory(mesh_dir, error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
        }
        status = ensure_directory(diagnostics_dir, error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (floquet_airbox_dynamic_demag) {
            status = write_text_artifact(periodic_pairs, periodic_pairs_json.c_str(), error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
        }
        status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(manifest, manifest_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        status = write_text_artifact(progress, progress_json.c_str(), error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        std::snprintf(manifest_path, 256, "%s", manifest);
        return FrequencyDomainStatus::ok;
    };

    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status =
        write_unavailable_artifacts(manifest_path, artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        result.status = artifact_status;
        assign_result_strings(
            result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    const char *result_delta_phi_flux_validation_status = floquet_airbox_dynamic_demag
        ? "not_evaluated"
        : "not_applicable";
    const char *result_delta_phi_flux_validation_reason = floquet_airbox_dynamic_demag
        ? unsupported_reason
        : "no_floquet_airbox_delta_phi_constraint";
    char diagnostics_json[2048]{};
    char result_json[1024]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"unsupported_reason\":\"%s\","
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"unavailable\","
        "\"lane_classification\":\"%s\","
        "\"requested_magnetostatic_bc\":\"%s\","
        "\"resolved_magnetostatic_bc\":\"%s\","
        "\"floquet_k_vector_rad_per_m\":[%.17g,%.17g,%.17g],"
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"delta_m_tangent_dof_count\":%llu,"
        "\"delta_phi_dof_count\":%llu,"
        "\"magnetostatic_periodic_node_pair_count\":%llu,"
        "\"delta_phi_flux_validation_status\":\"%s\","
        "\"delta_phi_flux_validation_reason\":\"%s\","
        "\"dynamic_demag_k_available\":false,"
        "\"production_solver_available\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"periodic_airbox_coupled_block_solver\":false,"
        "\"mfem_coupled_block_assembly\":false,"
        "\"completed_frequency_point_count\":0}",
        unsupported_reason,
        requested_execution_lane,
        lane_classification,
        requested_magnetostatic_bc,
        resolved_magnetostatic_bc,
        request.floquet_k_vector_rad_per_m[0],
        request.floquet_k_vector_rad_per_m[1],
        request.floquet_k_vector_rad_per_m[2],
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(delta_m_tangent_dof_count),
        static_cast<unsigned long long>(request.periodic_airbox_delta_phi_dof_count),
        static_cast<unsigned long long>(
            request.periodic_airbox_magnetostatic_periodic_node_pair_count),
        result_delta_phi_flux_validation_status,
        result_delta_phi_flux_validation_reason);
    const int result_written = std::snprintf(
        result_json,
        sizeof(result_json),
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"unavailable\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"unsupported_reason\":\"%s\","
        "\"artifact_manifest_path\":\"%s\"}",
        unsupported_reason,
        manifest_path);
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "Floquet unsupported result JSON exceeded fixed buffer",
            status_diagnostics_json(FrequencyDomainStatus::artifact_error),
            status_result_json(FrequencyDomainStatus::artifact_error),
            "");
        return result.status;
    }

    result.status = FrequencyDomainStatus::unavailable;
    result.completed_frequency_count = 0;
    result.written_frequency_point_artifacts = 0;
    assign_result_strings(result, message, diagnostics_json, result_json, manifest_path);
    return result.status;
}

} // namespace

FrequencyDomainStatus solve_driven_frequency_response(
    const DrivenFrequencyResponseSolveRequest &request,
    DrivenFrequencyResponseSolveResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }

    *out_result = DrivenFrequencyResponseSolveResult{};
    out_result->total_frequency_count = request.solve_request.frequency_count;

    DrivenFrequencyResponseRequest validation_request = request.solve_request;
    if (request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) {
        validation_request.operator_request.strict_gpu = false;
    }
    FrequencyDomainSolveRequestDiagnostics request_diagnostics{};
    const FrequencyDomainStatus validation_status =
        validate_driven_frequency_response_request(validation_request, &request_diagnostics);
    if (validation_status != FrequencyDomainStatus::ok) {
        out_result->status = validation_status;
        assign_result_strings(
            *out_result,
            request_diagnostics.error_message,
            status_diagnostics_json(validation_status),
            status_result_json(validation_status),
            "");
        return out_result->status;
    }

    char floquet_phase_error[128]{};
    if (!validate_driven_response_floquet_phase_metadata(
            request,
            floquet_phase_error)) {
        out_result->status = FrequencyDomainStatus::validation_error;
        assign_result_strings(
            *out_result,
            floquet_phase_error,
            status_diagnostics_json(FrequencyDomainStatus::validation_error),
            status_result_json(FrequencyDomainStatus::validation_error),
            "");
        return out_result->status;
    }

    FloquetPhaseConstraintValidation floquet_constraint_validation{};
    if (!validate_driven_response_floquet_phase_constraints(
            request,
            floquet_constraint_validation)) {
        return solve_floquet_phase_constraint_validation_error(
            request,
            floquet_constraint_validation,
            *out_result);
    }

    const bool nonzero_floquet_request =
        driven_response_request_has_nonzero_floquet_metadata(request);
    const bool floquet_airbox_explicit_coupled_block =
        nonzero_floquet_request &&
        request.requires_floquet_airbox_dynamic_demag &&
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu &&
        request.periodic_airbox_coupled_block_problem.enabled;
    if (nonzero_floquet_request &&
        !can_solve_floquet_projected_no_demag_response(request) &&
        !floquet_airbox_explicit_coupled_block) {
        return solve_floquet_nonzero_k_unavailable(request, *out_result);
    }

    DrivenFrequencyResponseSolveRequest execution_request = request;
    std::vector<std::uint64_t> gamma_static_periodic_node_pairs;
    const bool gamma_floquet_request =
        !nonzero_floquet_request &&
        request.floquet_periodic_pair_count > 0 &&
        request.floquet_periodic_pairs != nullptr;
    if (gamma_floquet_request) {
        gamma_static_periodic_node_pairs.reserve(
            static_cast<std::size_t>(request.floquet_periodic_pair_count * 2));
        for (std::uint64_t pair_index = 0;
             pair_index < request.floquet_periodic_pair_count;
             ++pair_index) {
            const FrequencyDomainFloquetPeriodicPair &pair =
                request.floquet_periodic_pairs[pair_index];
            gamma_static_periodic_node_pairs.push_back(pair.node_a);
            gamma_static_periodic_node_pairs.push_back(pair.node_b);
        }
        if (execution_request.mfem_validation_problem.static_periodic_node_pair_count == 0 ||
            execution_request.mfem_validation_problem.static_periodic_node_pairs == nullptr) {
            execution_request.mfem_validation_problem.static_periodic_node_pairs =
                gamma_static_periodic_node_pairs.data();
            execution_request.mfem_validation_problem.static_periodic_node_pair_count =
                request.floquet_periodic_pair_count;
        }
        execution_request.has_floquet_k_vector = false;
        execution_request.floquet_k_vector_rad_per_m[0] = 0.0;
        execution_request.floquet_k_vector_rad_per_m[1] = 0.0;
        execution_request.floquet_k_vector_rad_per_m[2] = 0.0;
        execution_request.floquet_periodic_pairs = nullptr;
        execution_request.floquet_periodic_pair_count = 0;
    }

    if (execution_request.requires_periodic_airbox_dynamic_demag &&
        execution_request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) {
        return solve_mfem_production_gpu_unavailable(
            execution_request,
            *out_result,
            "periodic_airbox_dynamic_demag_gpu_unsupported",
            "native FEM frequency-domain production GPU does not implement periodic-airbox dynamic demag");
    }

    if (execution_request.requires_floquet_airbox_dynamic_demag) {
        if (execution_request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) {
            return solve_floquet_nonzero_k_unavailable(execution_request, *out_result);
        }
        if (execution_request.magnetic_periodic_constraint_set_count == 0 ||
            execution_request.magnetostatic_periodic_constraint_set_count == 0) {
            return solve_periodic_airbox_missing_constraint_sets(execution_request, *out_result);
        }
        if (execution_request.periodic_airbox_delta_phi_dof_count == 0) {
            return solve_periodic_airbox_missing_delta_phi_dofs(execution_request, *out_result);
        }
        if (execution_request.periodic_airbox_magnetostatic_periodic_node_pair_count == 0 ||
            execution_request.periodic_airbox_magnetostatic_periodic_node_pairs == nullptr) {
            return solve_periodic_airbox_missing_magnetostatic_periodic_node_pairs(
                execution_request,
                *out_result);
        }
        if (has_periodic_node_pair_out_of_range(
                execution_request.periodic_airbox_magnetostatic_periodic_node_pairs,
                execution_request.periodic_airbox_magnetostatic_periodic_node_pair_count,
                execution_request.periodic_airbox_delta_phi_dof_count)) {
            return solve_periodic_airbox_magnetostatic_periodic_node_pair_out_of_range(
                execution_request,
                *out_result);
        }
        if (has_degenerate_periodic_node_pair(
                execution_request.periodic_airbox_magnetostatic_periodic_node_pairs,
                execution_request.periodic_airbox_magnetostatic_periodic_node_pair_count)) {
            return solve_periodic_airbox_degenerate_magnetostatic_periodic_node_pair(
                execution_request,
                *out_result);
        }
        if (execution_request.periodic_airbox_coupled_block_problem.enabled) {
            return solve_periodic_airbox_dynamic_demag_coupled_block(execution_request, *out_result);
        }
        return solve_floquet_nonzero_k_unavailable(execution_request, *out_result);
    }

    if (execution_request.requires_periodic_airbox_dynamic_demag) {
        if (execution_request.magnetic_periodic_constraint_set_count == 0 ||
            execution_request.magnetostatic_periodic_constraint_set_count == 0) {
            return solve_periodic_airbox_missing_constraint_sets(execution_request, *out_result);
        }
        if (execution_request.periodic_airbox_delta_phi_dof_count == 0) {
            return solve_periodic_airbox_missing_delta_phi_dofs(execution_request, *out_result);
        }
        if (execution_request.periodic_airbox_magnetostatic_periodic_node_pair_count == 0 ||
            execution_request.periodic_airbox_magnetostatic_periodic_node_pairs == nullptr) {
            return solve_periodic_airbox_missing_magnetostatic_periodic_node_pairs(
                execution_request,
                *out_result);
        }
        if (has_periodic_node_pair_out_of_range(
                execution_request.periodic_airbox_magnetostatic_periodic_node_pairs,
                execution_request.periodic_airbox_magnetostatic_periodic_node_pair_count,
                execution_request.periodic_airbox_delta_phi_dof_count)) {
            return solve_periodic_airbox_magnetostatic_periodic_node_pair_out_of_range(
                execution_request,
                *out_result);
        }
        if (has_degenerate_periodic_node_pair(
                execution_request.periodic_airbox_magnetostatic_periodic_node_pairs,
                execution_request.periodic_airbox_magnetostatic_periodic_node_pair_count)) {
            return solve_periodic_airbox_degenerate_magnetostatic_periodic_node_pair(
                execution_request,
                *out_result);
        }
        if (execution_request.periodic_airbox_coupled_block_problem.enabled) {
            return solve_periodic_airbox_dynamic_demag_coupled_block(execution_request, *out_result);
        }
        if (has_mfem_demag_tangent_operator(execution_request.mfem_validation_problem) &&
            execution_request.mfem_validation_problem.apply_demag_tangent_with_potential == nullptr) {
            return solve_periodic_airbox_validation_error(
                execution_request,
                *out_result,
                "periodic_airbox_missing_demag_tangent_potential_provider",
                "periodic-airbox dynamic demag provider artifacts require a demag tangent-with-potential callback",
                "not_evaluated",
                0.0);
        }
        if (has_mfem_demag_tangent_operator(execution_request.mfem_validation_problem)) {
            return solve_periodic_airbox_dynamic_demag_mfem_phi_consistency_schur(
                execution_request,
                *out_result);
        }
        return solve_periodic_airbox_dynamic_demag_unavailable(execution_request, *out_result);
    }

    if (execution_request.cancel_requested != nullptr &&
        execution_request.cancel_requested(execution_request.cancel_user_data)) {
        out_result->status = FrequencyDomainStatus::interrupted;
        assign_result_strings(
            *out_result,
            "frequency response solve was interrupted before the first frequency point",
            status_diagnostics_json(FrequencyDomainStatus::interrupted),
            status_result_json(FrequencyDomainStatus::interrupted),
            "");
        return out_result->status;
    }

    if (execution_request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu) {
        return solve_mfem_production_cpu_problem(execution_request, *out_result);
    }

    if (execution_request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) {
        return solve_mfem_production_gpu_problem(execution_request, *out_result);
    }

    if (execution_request.mfem_validation_problem.enabled) {
        return solve_mfem_validation_problem(execution_request, *out_result);
    }

    if (execution_request.tiny_validation_problem.enabled) {
        return solve_tiny_validation_problem(execution_request, *out_result);
    }

    constexpr const char *unavailable_reason =
        "native FEM driven frequency-response solver is not implemented";
    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status = write_unavailable_response_artifacts(
        execution_request,
        unavailable_reason,
        nullptr,
        manifest_path,
        artifact_error);
    if (artifact_status != FrequencyDomainStatus::ok) {
        out_result->status = artifact_status;
        assign_result_strings(
            *out_result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return out_result->status;
    }

    char result_json[384]{};
    const FrequencyDomainStatus result_json_status = format_unavailable_result_json(
        manifest_path,
        result_json,
        artifact_error);
    if (result_json_status != FrequencyDomainStatus::ok) {
        out_result->status = result_json_status;
        assign_result_strings(
            *out_result,
            artifact_error,
            status_diagnostics_json(FrequencyDomainStatus::unavailable),
            status_result_json(FrequencyDomainStatus::unavailable),
            "");
        return out_result->status;
    }

    out_result->status = FrequencyDomainStatus::unavailable;
    assign_result_strings(
        *out_result,
        unavailable_reason,
        status_diagnostics_json(FrequencyDomainStatus::unavailable),
        result_json,
        manifest_path);
    return out_result->status;
}

void release_driven_frequency_response_result(
    DrivenFrequencyResponseSolveResult *result) noexcept
{
    if (result == nullptr) {
        return;
    }
    delete[] result->error_message;
    delete[] result->diagnostics_json;
    delete[] result->result_json;
    delete[] result->artifact_manifest_path;
    *result = DrivenFrequencyResponseSolveResult{};
    result->error_message = nullptr;
    result->diagnostics_json = nullptr;
    result->result_json = nullptr;
    result->artifact_manifest_path = nullptr;
}

} // namespace fullmag::fem::frequency_domain
