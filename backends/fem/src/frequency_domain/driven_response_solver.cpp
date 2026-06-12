#include "frequency_domain/driven_response_solver.hpp"

#include "cpu/frequency_domain/dense_driven_response.hpp"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

#include <sys/stat.h>
#include <sys/types.h>

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
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"validation_error\","
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::unavailable:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"unavailable\","
               "\"production_solver_available\":false}";
    case FrequencyDomainStatus::interrupted:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"interrupted\","
               "\"partial_artifacts_available\":false,"
               "\"production_solver_available\":false}";
    default:
        return "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
               "\"solver_engine\":\"native_fem_mfem_driven_response\","
               "\"status\":\"artifact_error\","
               "\"production_solver_available\":false}";
    }
}

bool has_output_directory(const char *output_directory) noexcept
{
    return output_directory != nullptr && output_directory[0] != '\0';
}

double canonical_phase(double phase_rad) noexcept
{
    constexpr double pi = 3.14159265358979323846;
    if (phase_rad <= -pi) {
        return pi;
    }
    return phase_rad;
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

FrequencyDomainStatus ensure_directory(const char *path, char error_message[128]) noexcept
{
    if (mkdir(path, 0777) == 0 || errno == EEXIST) {
        return FrequencyDomainStatus::ok;
    }
    std::snprintf(error_message, 128, "failed to create artifact directory: %s", path);
    return FrequencyDomainStatus::artifact_error;
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
    const bool write_field_payloads = request.solve_request.write_response_fields;

    char frequency_domain_dir[256]{};
    char response_dir[256]{};
    char frequency_points_dir[256]{};
    char field_payloads_dir[256]{};
    char manifest[256]{};
    char sweep[256]{};
    char sweep_v2[256]{};
    char progress[256]{};
    char diagnostics[256]{};
    if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
        std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
        std::snprintf(frequency_points_dir, sizeof(frequency_points_dir), "%s/frequency_points", response_dir) < 0 ||
        std::snprintf(field_payloads_dir, sizeof(field_payloads_dir), "%s/field_payloads", response_dir) < 0 ||
        std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
        std::snprintf(sweep, sizeof(sweep), "%s/magnetic_response_sweep.v1.json", response_dir) < 0 ||
        std::snprintf(sweep_v2, sizeof(sweep_v2), "%s/magnetic_response_sweep.v2.json", response_dir) < 0 ||
        std::snprintf(progress, sizeof(progress), "%s/progress.v1.json", response_dir) < 0 ||
        std::snprintf(diagnostics, sizeof(diagnostics), "%s/diagnostics.v1.json", response_dir) < 0) {
        std::snprintf(error_message, 128, "failed to format frequency response artifact paths");
        return FrequencyDomainStatus::artifact_error;
    }
    if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
        std::strlen(response_dir) >= sizeof(response_dir) - 1 ||
        std::strlen(frequency_points_dir) >= sizeof(frequency_points_dir) - 1 ||
        std::strlen(field_payloads_dir) >= sizeof(field_payloads_dir) - 1 ||
        std::strlen(manifest) >= sizeof(manifest) - 1 ||
        std::strlen(sweep) >= sizeof(sweep) - 1 ||
        std::strlen(sweep_v2) >= sizeof(sweep_v2) - 1 ||
        std::strlen(progress) >= sizeof(progress) - 1 ||
        std::strlen(diagnostics) >= sizeof(diagnostics) - 1) {
        std::snprintf(error_message, 128, "frequency response artifact path exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    char manifest_json[4096]{};
    char sweep_json[4096]{};
    char sweep_v2_json[4096]{};
    char progress_json[768]{};
    char diagnostics_json[768]{};
    char points_json[3072]{};
    char frequency_point_paths_json[1024]{};
    char field_payload_resources_json[1024]{};
    char sweep_v2_point_paths_json[1024]{};
    char sweep_v2_payload_paths_json[1024]{};
    std::size_t points_offset = 0;
    int points_written = std::snprintf(points_json, sizeof(points_json), "[");
    if (points_written < 0 || static_cast<std::size_t>(points_written) >= sizeof(points_json)) {
        std::snprintf(error_message, 128, "failed to format response points");
        return FrequencyDomainStatus::artifact_error;
    }
    points_offset = static_cast<std::size_t>(points_written);

    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.response_frequency_count;
         ++frequency_index) {
        char m_complex_json[512]{};
        char component_amplitude_json[512]{};
        char component_phase_json[512]{};
        double response_phase = 0.0;
        double response_amplitude = 0.0;
        std::size_t m_complex_offset = 0;
        int m_complex_written = std::snprintf(m_complex_json, sizeof(m_complex_json), "[");
        if (m_complex_written < 0 || static_cast<std::size_t>(m_complex_written) >= sizeof(m_complex_json)) {
            std::snprintf(error_message, 128, "failed to format response m_complex");
            return FrequencyDomainStatus::artifact_error;
        }
        m_complex_offset = static_cast<std::size_t>(m_complex_written);
        std::size_t component_amplitude_offset = 0;
        int component_amplitude_written = std::snprintf(
            component_amplitude_json,
            sizeof(component_amplitude_json),
            "[");
        if (component_amplitude_written < 0 ||
            static_cast<std::size_t>(component_amplitude_written) >= sizeof(component_amplitude_json)) {
            std::snprintf(error_message, 128, "failed to format response component amplitudes");
            return FrequencyDomainStatus::artifact_error;
        }
        component_amplitude_offset = static_cast<std::size_t>(component_amplitude_written);
        std::size_t component_phase_offset = 0;
        int component_phase_written = std::snprintf(component_phase_json, sizeof(component_phase_json), "[");
        if (component_phase_written < 0 ||
            static_cast<std::size_t>(component_phase_written) >= sizeof(component_phase_json)) {
            std::snprintf(error_message, 128, "failed to format response component phases");
            return FrequencyDomainStatus::artifact_error;
        }
        component_phase_offset = static_cast<std::size_t>(component_phase_written);
        for (std::uint64_t dof = 0; dof < validation_result.response_dof_count; ++dof) {
            const std::uint64_t response_index =
                frequency_index * validation_result.response_dof_count + dof;
            const double real_part = response_real[response_index];
            const double imag_part = response_imag[response_index];
            const double component_amplitude = std::hypot(real_part, imag_part);
            const double component_phase = canonical_phase(std::atan2(imag_part, real_part));
            if (component_amplitude > response_amplitude) {
                response_amplitude = component_amplitude;
                response_phase = component_phase;
            }
            m_complex_written = std::snprintf(
                m_complex_json + m_complex_offset,
                sizeof(m_complex_json) - m_complex_offset,
                "%s[%.17g,%.17g]",
                dof == 0 ? "" : ",",
                real_part,
                imag_part);
            if (m_complex_written < 0 ||
                static_cast<std::size_t>(m_complex_written) >= sizeof(m_complex_json) - m_complex_offset) {
                std::snprintf(error_message, 128, "response m_complex JSON exceeded fixed buffer");
                return FrequencyDomainStatus::artifact_error;
            }
            m_complex_offset += static_cast<std::size_t>(m_complex_written);
            component_amplitude_written = std::snprintf(
                component_amplitude_json + component_amplitude_offset,
                sizeof(component_amplitude_json) - component_amplitude_offset,
                "%s%.17g",
                dof == 0 ? "" : ",",
                component_amplitude);
            if (component_amplitude_written < 0 ||
                static_cast<std::size_t>(component_amplitude_written) >=
                    sizeof(component_amplitude_json) - component_amplitude_offset) {
                std::snprintf(error_message, 128, "response component amplitude JSON exceeded fixed buffer");
                return FrequencyDomainStatus::artifact_error;
            }
            component_amplitude_offset += static_cast<std::size_t>(component_amplitude_written);
            component_phase_written = std::snprintf(
                component_phase_json + component_phase_offset,
                sizeof(component_phase_json) - component_phase_offset,
                "%s%.17g",
                dof == 0 ? "" : ",",
                component_phase);
            if (component_phase_written < 0 ||
                static_cast<std::size_t>(component_phase_written) >=
                    sizeof(component_phase_json) - component_phase_offset) {
                std::snprintf(error_message, 128, "response component phase JSON exceeded fixed buffer");
                return FrequencyDomainStatus::artifact_error;
            }
            component_phase_offset += static_cast<std::size_t>(component_phase_written);
        }
        m_complex_written = std::snprintf(
            m_complex_json + m_complex_offset,
            sizeof(m_complex_json) - m_complex_offset,
            "]");
        component_amplitude_written = std::snprintf(
            component_amplitude_json + component_amplitude_offset,
            sizeof(component_amplitude_json) - component_amplitude_offset,
            "]");
        component_phase_written = std::snprintf(
            component_phase_json + component_phase_offset,
            sizeof(component_phase_json) - component_phase_offset,
            "]");
        if (m_complex_written < 0 ||
            component_amplitude_written < 0 ||
            component_phase_written < 0 ||
            static_cast<std::size_t>(m_complex_written) >= sizeof(m_complex_json) - m_complex_offset ||
            static_cast<std::size_t>(component_amplitude_written) >=
                sizeof(component_amplitude_json) - component_amplitude_offset ||
            static_cast<std::size_t>(component_phase_written) >=
                sizeof(component_phase_json) - component_phase_offset) {
            std::snprintf(error_message, 128, "response component JSON exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }

        points_written = std::snprintf(
            points_json + points_offset,
            sizeof(points_json) - points_offset,
            "%s{\"frequency_hz\":%.17g,"
            "\"angular_frequency_rad_per_s\":%.17g,"
            "\"m_complex\":%s,"
            "\"response_amplitude\":%.17g,"
            "\"response_phase\":%.17g,"
            "\"component_response_amplitude\":%s,"
            "\"component_response_phase\":%s,"
            "\"susceptibility_tensor\":[],"
            "\"absorbed_power_density\":0.0,"
            "\"residual_l2_norm\":%.17g,"
            "\"relative_residual_l2_norm\":%.17g,"
            "\"residual_source\":\"dense_block_real\","
            "\"tangent_leakage\":{\"status\":\"not_evaluated\"},"
            "\"excitation_provenance\":{\"source\":\"native_validation_drive\"}}",
            frequency_index == 0 ? "" : ",",
            request.solve_request.frequencies_hz[frequency_index],
            request.solve_request.frequencies_hz[frequency_index] * 6.28318530717958647692,
            m_complex_json,
            response_amplitude,
            response_phase,
            component_amplitude_json,
            component_phase_json,
            residual_l2_norm[frequency_index],
            relative_residual_l2_norm[frequency_index]);
        if (points_written < 0 ||
            static_cast<std::size_t>(points_written) >= sizeof(points_json) - points_offset) {
            std::snprintf(error_message, 128, "response points JSON exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        points_offset += static_cast<std::size_t>(points_written);
    }
    points_written = std::snprintf(points_json + points_offset, sizeof(points_json) - points_offset, "]");
    if (points_written < 0 ||
        static_cast<std::size_t>(points_written) >= sizeof(points_json) - points_offset) {
        std::snprintf(error_message, 128, "response points JSON exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    std::size_t frequency_point_paths_offset = 0;
    std::size_t field_payload_resources_offset = 0;
    std::size_t sweep_v2_point_paths_offset = 0;
    std::size_t sweep_v2_payload_paths_offset = 0;
    int list_written = std::snprintf(frequency_point_paths_json, sizeof(frequency_point_paths_json), "[");
    int field_list_written = std::snprintf(field_payload_resources_json, sizeof(field_payload_resources_json), "[");
    int sweep_point_list_written = std::snprintf(sweep_v2_point_paths_json, sizeof(sweep_v2_point_paths_json), "[");
    int sweep_payload_list_written = std::snprintf(sweep_v2_payload_paths_json, sizeof(sweep_v2_payload_paths_json), "[");
    if (list_written < 0 ||
        field_list_written < 0 ||
        sweep_point_list_written < 0 ||
        sweep_payload_list_written < 0 ||
        static_cast<std::size_t>(list_written) >= sizeof(frequency_point_paths_json) ||
        static_cast<std::size_t>(field_list_written) >= sizeof(field_payload_resources_json) ||
        static_cast<std::size_t>(sweep_point_list_written) >= sizeof(sweep_v2_point_paths_json) ||
        static_cast<std::size_t>(sweep_payload_list_written) >= sizeof(sweep_v2_payload_paths_json)) {
        std::snprintf(error_message, 128, "failed to format response artifact path lists");
        return FrequencyDomainStatus::artifact_error;
    }
    frequency_point_paths_offset = static_cast<std::size_t>(list_written);
    field_payload_resources_offset = static_cast<std::size_t>(field_list_written);
    sweep_v2_point_paths_offset = static_cast<std::size_t>(sweep_point_list_written);
    sweep_v2_payload_paths_offset = static_cast<std::size_t>(sweep_payload_list_written);
    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point_path[96]{};
        char field_payload_path[96]{};
        const int point_path_written = std::snprintf(
            frequency_point_path,
            sizeof(frequency_point_path),
            "response/frequency_points/frequency_%04llu.json",
            static_cast<unsigned long long>(frequency_index));
        int payload_path_written = 0;
        if (write_field_payloads) {
            payload_path_written = std::snprintf(
                field_payload_path,
                sizeof(field_payload_path),
                "response/field_payloads/frequency_%04llu/vector.bin",
                static_cast<unsigned long long>(frequency_index));
        }
        if (point_path_written < 0 ||
            static_cast<std::size_t>(point_path_written) >= sizeof(frequency_point_path) ||
            (write_field_payloads &&
                (payload_path_written < 0 ||
                    static_cast<std::size_t>(payload_path_written) >= sizeof(field_payload_path)))) {
            std::snprintf(error_message, 128, "failed to format response artifact relative paths");
            return FrequencyDomainStatus::artifact_error;
        }
        list_written = std::snprintf(
            frequency_point_paths_json + frequency_point_paths_offset,
            sizeof(frequency_point_paths_json) - frequency_point_paths_offset,
            "%s\"%s\"",
            frequency_index == 0 ? "" : ",",
            frequency_point_path);
        sweep_point_list_written = std::snprintf(
            sweep_v2_point_paths_json + sweep_v2_point_paths_offset,
            sizeof(sweep_v2_point_paths_json) - sweep_v2_point_paths_offset,
            "%s\"%s\"",
            frequency_index == 0 ? "" : ",",
            frequency_point_path);
        if (list_written < 0 ||
            sweep_point_list_written < 0 ||
            static_cast<std::size_t>(list_written) >= sizeof(frequency_point_paths_json) - frequency_point_paths_offset ||
            static_cast<std::size_t>(sweep_point_list_written) >= sizeof(sweep_v2_point_paths_json) - sweep_v2_point_paths_offset) {
            std::snprintf(error_message, 128, "response artifact path lists exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        frequency_point_paths_offset += static_cast<std::size_t>(list_written);
        sweep_v2_point_paths_offset += static_cast<std::size_t>(sweep_point_list_written);
        if (write_field_payloads) {
            field_list_written = std::snprintf(
                field_payload_resources_json + field_payload_resources_offset,
                sizeof(field_payload_resources_json) - field_payload_resources_offset,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                field_payload_path);
            sweep_payload_list_written = std::snprintf(
                sweep_v2_payload_paths_json + sweep_v2_payload_paths_offset,
                sizeof(sweep_v2_payload_paths_json) - sweep_v2_payload_paths_offset,
                "%s\"%s\"",
                frequency_index == 0 ? "" : ",",
                field_payload_path);
            if (field_list_written < 0 ||
                sweep_payload_list_written < 0 ||
                static_cast<std::size_t>(field_list_written) >=
                    sizeof(field_payload_resources_json) - field_payload_resources_offset ||
                static_cast<std::size_t>(sweep_payload_list_written) >=
                    sizeof(sweep_v2_payload_paths_json) - sweep_v2_payload_paths_offset) {
                std::snprintf(error_message, 128, "response artifact path lists exceeded fixed buffer");
                return FrequencyDomainStatus::artifact_error;
            }
            field_payload_resources_offset += static_cast<std::size_t>(field_list_written);
            sweep_v2_payload_paths_offset += static_cast<std::size_t>(sweep_payload_list_written);
        }
    }
    list_written = std::snprintf(
        frequency_point_paths_json + frequency_point_paths_offset,
        sizeof(frequency_point_paths_json) - frequency_point_paths_offset,
        "]");
    field_list_written = std::snprintf(
        field_payload_resources_json + field_payload_resources_offset,
        sizeof(field_payload_resources_json) - field_payload_resources_offset,
        "]");
    sweep_point_list_written = std::snprintf(
        sweep_v2_point_paths_json + sweep_v2_point_paths_offset,
        sizeof(sweep_v2_point_paths_json) - sweep_v2_point_paths_offset,
        "]");
    sweep_payload_list_written = std::snprintf(
        sweep_v2_payload_paths_json + sweep_v2_payload_paths_offset,
        sizeof(sweep_v2_payload_paths_json) - sweep_v2_payload_paths_offset,
        "]");
    if (list_written < 0 ||
        field_list_written < 0 ||
        sweep_point_list_written < 0 ||
        sweep_payload_list_written < 0 ||
        static_cast<std::size_t>(list_written) >= sizeof(frequency_point_paths_json) - frequency_point_paths_offset ||
        static_cast<std::size_t>(field_list_written) >= sizeof(field_payload_resources_json) - field_payload_resources_offset ||
        static_cast<std::size_t>(sweep_point_list_written) >= sizeof(sweep_v2_point_paths_json) - sweep_v2_point_paths_offset ||
        static_cast<std::size_t>(sweep_payload_list_written) >= sizeof(sweep_v2_payload_paths_json) - sweep_v2_payload_paths_offset) {
        std::snprintf(error_message, 128, "response artifact path lists exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    const int manifest_written = std::snprintf(
        manifest_json,
        sizeof(manifest_json),
        "{\"schema_version\":\"frequency_domain_manifest.v1\","
        "\"revision\":\"validation-assembled-v1\","
        "\"session_id\":\"native-validation\","
        "\"run_id\":\"native-validation\","
        "\"stage_id\":\"frequency-response-validation\","
        "\"stage_kind\":\"frequency_response\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"requested_execution\":{\"solve_equation\":\"(i omega B - L) q = f\"},"
        "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
        "\"engine\":\"runner.dense_block_real_validation\","
        "\"native_backend\":\"runner_validation\","
        "\"reference_or_production\":\"reference\","
        "\"solver_library\":\"nalgebra\","
        "\"solver_model\":\"dense_block_real_lu\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"solver_kind\":\"assembled_validation_dense_block_real\","
        "\"lane_classification\":\"fem_cpu_validation\","
        "\"production_solver\":false},"
        "\"artifacts\":{\"response_sweep_v1_path\":\"response/magnetic_response_sweep.v1.json\","
        "\"response_sweep_v2_path\":\"response/magnetic_response_sweep.v2.json\","
        "\"response_diagnostics_v1_path\":\"response/diagnostics.v1.json\","
        "\"response_progress_v1_path\":\"response/progress.v1.json\","
        "\"frequency_point_paths\":%s},"
        "\"resources\":{\"response_sweep_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep\","
        "\"response_progress_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/progress.v1\","
        "\"response_diagnostics_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1\","
        "\"response_field_resources\":%s},"
        "\"diagnostics\":{\"assembled_mfem_operator_solver\":true,"
        "\"point_count\":%llu,"
        "\"completed_frequency_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"max_abs_response\":%.17g},"
        "\"capabilities\":{\"validation_solver_available\":true,"
        "\"production_solver_available\":false,"
        "\"production_native_solver_available\":false,"
        "\"validation_artifact\":true,"
        "\"dynamic_demag_k_available\":false,"
        "\"floquet_response_available\":false,"
        "\"gpu_available\":false}}",
        run_status,
        complete ? "true" : "false",
        frequency_point_paths_json,
        field_payload_resources_json,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        validation_result.max_abs_response);
    const int sweep_written = std::snprintf(
        sweep_json,
        sizeof(sweep_json),
        "{\"schema_version\":\"magnetic_response_sweep.v1\","
        "\"backend_engine_id\":\"native_fem_mfem\","
        "\"solver_model\":\"assembled_validation_dense_block_real\","
        "\"damping_policy\":\"linearized_llg_tangent\","
        "\"lane_classification\":\"fem_cpu_validation\","
        "\"matrix_layout\":\"dense_block_real\","
        "\"excitation_kind\":\"uniform_field\","
        "\"si_units\":{\"frequency\":\"Hz\",\"angular_frequency\":\"rad/s\"},"
        "\"point_count\":%llu,"
        "\"points\":%s}",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        points_json);
    const char *first_payload_path = write_field_payloads && validation_result.completed_frequency_count > 0 ?
        "response/field_payloads/frequency_0000/vector.bin" :
        "";
    const int sweep_v2_written = std::snprintf(
        sweep_v2_json,
        sizeof(sweep_v2_json),
        "{\"schema_version\":\"magnetic_response_sweep.v2\","
        "\"solve_kind\":\"direct_harmonic_response\","
        "\"complete\":%s,"
        "\"completed_frequency_point_count\":%llu,"
        "\"point_count\":%llu,"
        "\"frequency_point_artifact_path\":\"response/frequency_points/frequency_0000.json\","
        "\"response_field_payload_path\":\"%s\","
        "\"frequency_point_artifact_paths\":%s,"
        "\"response_field_payload_paths\":%s,"
        "\"points\":%s}",
        complete ? "true" : "false",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        first_payload_path,
        sweep_v2_point_paths_json,
        sweep_v2_payload_paths_json,
        points_json);
    const int progress_written = std::snprintf(
        progress_json,
        sizeof(progress_json),
        "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"state\":\"%s\","
        "\"total_frequency_points\":%llu,"
        "\"completed_frequency_points\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"partial_artifacts_available\":%s,"
        "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\"}",
        complete ? "ready" : "interrupted",
        complete ? "true" : "false",
        complete ? "completed" : "interrupted",
        static_cast<unsigned long long>(request.solve_request.frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        validation_result.completed_frequency_count > 0 ? "true" : "false");
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"assembled_mfem_operator_solver\":true,"
        "\"dense_block_real_solver\":true,"
        "\"completed_frequency_point_count\":%llu,"
        "\"max_abs_response\":%.17g,"
        "\"residual_l2_norm\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g}",
        complete ? "ready" : "interrupted",
        complete ? "true" : "false",
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        validation_result.max_abs_response,
        validation_result.residual_l2_norm,
        validation_result.relative_residual_l2_norm);
    if (manifest_written < 0 ||
        sweep_written < 0 ||
        sweep_v2_written < 0 ||
        progress_written < 0 ||
        diagnostics_written < 0 ||
        static_cast<std::size_t>(manifest_written) >= sizeof(manifest_json) ||
        static_cast<std::size_t>(sweep_written) >= sizeof(sweep_json) ||
        static_cast<std::size_t>(sweep_v2_written) >= sizeof(sweep_v2_json) ||
        static_cast<std::size_t>(progress_written) >= sizeof(progress_json) ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json)) {
        std::snprintf(error_message, 128, "frequency response validation artifact JSON exceeded fixed buffer");
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
    }

    status = write_text_artifact(sweep, sweep_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(sweep_v2, sweep_v2_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(progress, progress_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(diagnostics, diagnostics_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    for (std::uint64_t frequency_index = 0;
         frequency_index < validation_result.completed_frequency_count;
         ++frequency_index) {
        char frequency_point[256]{};
        char field_payload_dir[256]{};
        char field_payload[256]{};
        char frequency_point_json[768]{};
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
                std::snprintf(field_payload, sizeof(field_payload), "%s/vector.bin", field_payload_dir) < 0)) {
            std::snprintf(error_message, 128, "failed to format frequency response point artifact path");
            return FrequencyDomainStatus::artifact_error;
        }
        if (std::strlen(frequency_point) >= sizeof(frequency_point) - 1 ||
            (write_field_payloads &&
                (std::strlen(field_payload_dir) >= sizeof(field_payload_dir) - 1 ||
                    std::strlen(field_payload) >= sizeof(field_payload) - 1))) {
            std::snprintf(error_message, 128, "frequency response point artifact path exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        int frequency_point_written = 0;
        if (write_field_payloads) {
            frequency_point_written = std::snprintf(
                frequency_point_json,
                sizeof(frequency_point_json),
                "{\"schema_version\":\"frequency_response_point.v1\","
                "\"frequency_index\":%llu,"
                "\"frequency_hz\":%.17g,"
                "\"field_payload_path\":\"response/field_payloads/frequency_%04llu/vector.bin\","
                "\"payload_encoding\":\"f64_interleaved_real_imag_tangent\","
                "\"binary_layout\":\"complex_f64_pairs_little_endian\"}",
                static_cast<unsigned long long>(frequency_index),
                request.solve_request.frequencies_hz[frequency_index],
                static_cast<unsigned long long>(frequency_index));
        } else {
            frequency_point_written = std::snprintf(
                frequency_point_json,
                sizeof(frequency_point_json),
                "{\"schema_version\":\"frequency_response_point.v1\","
                "\"frequency_index\":%llu,"
                "\"frequency_hz\":%.17g,"
                "\"field_payload_path\":null,"
                "\"payload_encoding\":\"not_written\","
                "\"binary_layout\":\"none\"}",
                static_cast<unsigned long long>(frequency_index),
                request.solve_request.frequencies_hz[frequency_index]);
        }
        if (frequency_point_written < 0 ||
            static_cast<std::size_t>(frequency_point_written) >= sizeof(frequency_point_json)) {
            std::snprintf(error_message, 128, "frequency response point JSON exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        status = write_text_artifact(frequency_point, frequency_point_json, error_message);
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
        const std::uint64_t payload_value_count = validation_result.response_dof_count * 2;
        double payload[32]{};
        if (payload_value_count > 32) {
            std::snprintf(error_message, 128, "frequency response field payload exceeded fixed buffer");
            return FrequencyDomainStatus::artifact_error;
        }
        for (std::uint64_t dof = 0; dof < validation_result.response_dof_count; ++dof) {
            const std::uint64_t response_index = frequency_index * validation_result.response_dof_count + dof;
            payload[dof * 2] = response_real[response_index];
            payload[dof * 2 + 1] = response_imag[response_index];
        }
        status = write_binary_artifact(
            field_payload,
            payload,
            static_cast<std::size_t>(payload_value_count * sizeof(double)),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
    }
    status = write_text_artifact(manifest, manifest_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::snprintf(manifest_path, 256, "%s", manifest);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus write_unavailable_response_artifacts(
    const DrivenFrequencyResponseSolveRequest &request,
    const char *unavailable_reason,
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
    char manifest[256]{};
    char diagnostics[256]{};
    if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
        std::snprintf(manifest, sizeof(manifest), "%s/manifest.v1.json", frequency_domain_dir) < 0 ||
        std::snprintf(diagnostics, sizeof(diagnostics), "%s/diagnostics.v1.json", frequency_domain_dir) < 0) {
        std::snprintf(error_message, 128, "failed to format unavailable frequency response artifact paths");
        return FrequencyDomainStatus::artifact_error;
    }
    if (std::strlen(frequency_domain_dir) >= sizeof(frequency_domain_dir) - 1 ||
        std::strlen(manifest) >= sizeof(manifest) - 1 ||
        std::strlen(diagnostics) >= sizeof(diagnostics) - 1) {
        std::snprintf(error_message, 128, "unavailable frequency response artifact path exceeded fixed buffer");
        return FrequencyDomainStatus::artifact_error;
    }

    char diagnostics_json[768]{};
    char manifest_json[1024]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_diagnostics.v1\","
        "\"status\":\"unavailable\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"solver_kind\":\"production_unavailable\","
        "\"error_message\":\"%s\","
        "\"requested_frequency_count\":%llu,"
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"production_solver_available\":false}",
        unavailable_reason,
        static_cast<unsigned long long>(request.solve_request.frequency_count));
    const int manifest_written = std::snprintf(
        manifest_json,
        sizeof(manifest_json),
        "{\"schema_version\":\"frequency_domain_manifest.v1\","
        "\"revision\":\"unavailable-v1\","
        "\"session_id\":\"native-validation\","
        "\"run_id\":\"native-validation\","
        "\"stage_id\":\"frequency-response-production\","
        "\"stage_kind\":\"frequency_response\","
        "\"status\":\"unavailable\","
        "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
        "\"solver_kind\":\"production_unavailable\","
        "\"lane_classification\":\"fem_cpu_production\","
        "\"production_solver\":true},"
        "\"artifacts\":{\"failure_diagnostics_path\":\"frequency_domain/diagnostics.v1.json\"},"
        "\"diagnostics\":{\"requested_frequency_count\":%llu,"
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0},"
        "\"capabilities\":{\"validation_solver_available\":true,"
        "\"production_solver_available\":false,"
        "\"dynamic_demag_k_available\":false,"
        "\"floquet_response_available\":false,"
        "\"gpu_available\":false}}",
        static_cast<unsigned long long>(request.solve_request.frequency_count));
    if (diagnostics_written < 0 ||
        manifest_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(manifest_written) >= sizeof(manifest_json)) {
        std::snprintf(error_message, 128, "unavailable frequency response artifact JSON exceeded fixed buffer");
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
    status = write_text_artifact(diagnostics, diagnostics_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(manifest, manifest_json, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::snprintf(manifest_path, 256, "%s", manifest);
    return FrequencyDomainStatus::ok;
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
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"dense_block_real_solver\":true,"
        "\"tangent_dof_count\":%llu}",
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
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"status\":\"interrupted\","
            "\"partial_artifacts_available\":%s,"
            "\"completed_frequency_count\":%llu,"
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
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"ok\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"dense_block_real_solver\":true,"
        "\"assembled_mfem_operator_solver\":true,"
        "\"tangent_dof_count\":%llu,"
        "\"max_abs_stiffness_matrix\":%.17g,"
        "\"max_abs_mass_matrix\":%.17g}",
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

    FrequencyDomainSolveRequestDiagnostics request_diagnostics{};
    const FrequencyDomainStatus validation_status =
        validate_driven_frequency_response_request(request.solve_request, &request_diagnostics);
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

    if (request.cancel_requested != nullptr &&
        request.cancel_requested(request.cancel_user_data)) {
        out_result->status = FrequencyDomainStatus::interrupted;
        assign_result_strings(
            *out_result,
            "frequency response solve was interrupted before the first frequency point",
            status_diagnostics_json(FrequencyDomainStatus::interrupted),
            status_result_json(FrequencyDomainStatus::interrupted),
            "");
        return out_result->status;
    }

    if (request.mfem_validation_problem.enabled) {
        return solve_mfem_validation_problem(request, *out_result);
    }

    if (request.tiny_validation_problem.enabled) {
        return solve_tiny_validation_problem(request, *out_result);
    }

    constexpr const char *unavailable_reason =
        "native FEM driven frequency-response solver is not implemented";
    char manifest_path[256]{};
    char artifact_error[128]{};
    const FrequencyDomainStatus artifact_status = write_unavailable_response_artifacts(
        request,
        unavailable_reason,
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
