#include "frequency_domain/frequency_domain_contract.hpp"

#include <array>
#include <cmath>
#include <sstream>
#include <string>
#include <utility>

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace fullmag::fem::frequency_domain {

namespace {

constexpr const char *kUnavailableDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":false,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":false,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":false,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":false}";

constexpr const char *kCpuDrivenResponseDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":true,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":true,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":false,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":false,"
    "\"execution_lane\":\"native_fem_mfem_frequency_domain_cpu\","
    "\"scope\":\"gamma_free_or_static_periodic_magnetic_response_with_provider_demag_and_dmi_slices\"}";

constexpr const char *kGpuDrivenResponseDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":true,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":false,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":false,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":true,"
    "\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\","
    "\"scope\":\"gamma_free_magnetic_response_with_provider_demag_and_dmi_slices\"}";

constexpr const char *kGpuStaticPeriodicDrivenResponseDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":true,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":true,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":false,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":true,"
    "\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\","
    "\"scope\":\"gamma_free_or_static_periodic_magnetic_response_with_provider_demag_and_dmi_slices\"}";

constexpr const char *kFloquetProjectedDrivenResponseDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":true,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":false,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":true,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":false,"
    "\"scope\":\"nonzero_k_floquet_no_demag_phase_projection\"}";

constexpr const char *kGpuFloquetProjectedDrivenResponseDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":true,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":false,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":true,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":true,"
    "\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\","
    "\"scope\":\"nonzero_k_floquet_no_demag_phase_projection\"}";

constexpr const char *kCpuModalEigenDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":false,"
    "\"modal_solver_available\":true,"
    "\"static_periodic_response_available\":false,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":false,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":false,"
    "\"execution_lane\":\"native_fem_modal_cpu\","
    "\"scope\":\"slepc_shift_invert_operator_payload\"}";

constexpr const char *kModalEigenNoSlepcDiagnosticsJson =
    "{\"schema_version\":\"frequency_domain_availability.v1\","
    "\"driven_response_available\":false,"
    "\"modal_solver_available\":false,"
    "\"static_periodic_response_available\":false,"
    "\"floquet_modal_available\":false,"
    "\"floquet_response_available\":false,"
    "\"dynamic_demag_k_available\":false,"
    "\"gpu_available\":false,"
    "\"scope\":\"modal_eigen_requires_slepc\"}";

bool floquet_k_vector_is_nonzero_or_invalid(const double (&k_vector)[3]) noexcept
{
    constexpr double tolerance = 1.0e-12;
    for (double component : k_vector) {
        if (!std::isfinite(component) || std::abs(component) > tolerance) {
            return true;
        }
    }
    return false;
}

std::string json_string(const char *value)
{
    std::string result = "\"";
    if (value != nullptr) {
        for (const char c : std::string(value)) {
            if (c == '"' || c == '\\') {
                result.push_back('\\');
            }
            result.push_back(c);
        }
    }
    result.push_back('"');
    return result;
}

std::string sweep_progress_json(
    const char *state,
    const char *status,
    const char *complete,
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    bool partial_artifacts_available,
    const char *latest_artifact_manifest_path)
{
    std::ostringstream json;
    json.precision(17);
    json << "{\"schema_version\":\"frequency_domain_sweep_progress.v1\""
         << ",\"state\":" << json_string(state);
    if (status != nullptr) {
        json << ",\"status\":" << json_string(status);
    }
    if (complete != nullptr) {
        json << ",\"complete\":" << complete;
    }
    json << ",\"total_frequency_points\":" << total_frequency_points
         << ",\"completed_frequency_points\":" << completed_frequency_points
         << ",\"written_frequency_point_artifacts\":"
         << written_frequency_point_artifacts
         << ",\"current_frequency_hz\":" << current_frequency_hz
         << ",\"partial_artifacts_available\":"
         << (partial_artifacts_available ? "true" : "false")
         << ",\"latest_artifact_manifest_path\":"
         << json_string(latest_artifact_manifest_path) << "}";
    return json.str();
}

const char *stored_sweep_progress_json(std::string json)
{
    static thread_local std::array<std::string, 8> storage{};
    static thread_local std::size_t next_index = 0;
    std::string &slot = storage[next_index % storage.size()];
    next_index += 1;
    slot = std::move(json);
    return slot.c_str();
}

} // namespace

const char *status_to_string(FrequencyDomainStatus status) noexcept
{
    switch (status) {
    case FrequencyDomainStatus::ok:
        return "ok";
    case FrequencyDomainStatus::unavailable:
        return "unavailable";
    case FrequencyDomainStatus::validation_error:
        return "validation_error";
    case FrequencyDomainStatus::operator_error:
        return "operator_error";
    case FrequencyDomainStatus::solve_error:
        return "solve_error";
    case FrequencyDomainStatus::artifact_error:
        return "artifact_error";
    case FrequencyDomainStatus::interrupted:
        return "interrupted";
    }
    return "unknown";
}

const char *study_kind_to_string(FrequencyDomainStudyKind study_kind) noexcept
{
    switch (study_kind) {
    case FrequencyDomainStudyKind::driven_frequency_response:
        return "frequency_response";
    case FrequencyDomainStudyKind::modal_dynamic_matrix:
        return "eigenmodes";
    }
    return "unknown";
}

bool status_is_error(FrequencyDomainStatus status) noexcept
{
    return status != FrequencyDomainStatus::ok;
}

FrequencyDomainSweepProgress initial_sweep_progress(
    std::uint64_t total_frequency_points) noexcept
{
    FrequencyDomainSweepProgress progress{};
    progress.total_frequency_points = total_frequency_points;
    progress.progress_json = stored_sweep_progress_json(sweep_progress_json(
        "not_started", "running", "false", total_frequency_points, 0, 0, 0.0, false, ""));
    return progress;
}

FrequencyDomainSweepProgress interrupted_sweep_progress(
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path) noexcept
{
    FrequencyDomainSweepProgress progress{};
    progress.total_frequency_points = total_frequency_points;
    progress.completed_frequency_points = completed_frequency_points;
    progress.written_frequency_point_artifacts = written_frequency_point_artifacts;
    progress.current_frequency_hz = current_frequency_hz;
    progress.partial_artifacts_available =
        completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
    progress.latest_artifact_manifest_path =
        latest_artifact_manifest_path != nullptr ? latest_artifact_manifest_path : "";
    progress.progress_json = stored_sweep_progress_json(sweep_progress_json(
        "interrupted",
        "interrupted",
        "false",
        total_frequency_points,
        completed_frequency_points,
        written_frequency_point_artifacts,
        current_frequency_hz,
        progress.partial_artifacts_available,
        progress.latest_artifact_manifest_path));
    return progress;
}

FrequencyDomainSweepProgress completed_sweep_progress(
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path) noexcept
{
    FrequencyDomainSweepProgress progress{};
    progress.total_frequency_points = total_frequency_points;
    progress.completed_frequency_points = completed_frequency_points;
    progress.written_frequency_point_artifacts = written_frequency_point_artifacts;
    progress.current_frequency_hz = current_frequency_hz;
    progress.partial_artifacts_available =
        completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
    progress.latest_artifact_manifest_path =
        latest_artifact_manifest_path != nullptr ? latest_artifact_manifest_path : "";
    progress.progress_json = stored_sweep_progress_json(sweep_progress_json(
        "completed",
        "ready",
        "true",
        total_frequency_points,
        completed_frequency_points,
        written_frequency_point_artifacts,
        current_frequency_hz,
        progress.partial_artifacts_available,
        progress.latest_artifact_manifest_path));
    return progress;
}

FrequencyDomainSweepProgress cancelling_sweep_progress(
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path) noexcept
{
    FrequencyDomainSweepProgress progress{};
    progress.total_frequency_points = total_frequency_points;
    progress.completed_frequency_points = completed_frequency_points;
    progress.written_frequency_point_artifacts = written_frequency_point_artifacts;
    progress.current_frequency_hz = current_frequency_hz;
    progress.partial_artifacts_available =
        completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
    progress.latest_artifact_manifest_path =
        latest_artifact_manifest_path != nullptr ? latest_artifact_manifest_path : "";
    progress.progress_json = stored_sweep_progress_json(sweep_progress_json(
        "cancel_requested",
        "cancel_requested",
        "false",
        total_frequency_points,
        completed_frequency_points,
        written_frequency_point_artifacts,
        current_frequency_hz,
        progress.partial_artifacts_available,
        progress.latest_artifact_manifest_path));
    return progress;
}

FrequencyDomainAvailabilityResult frequency_domain_availability(
    const FrequencyDomainAvailabilityRequest &request) noexcept
{
    FrequencyDomainAvailabilityResult result{};
    result.status = FrequencyDomainStatus::unavailable;
    result.diagnostics_json = kUnavailableDiagnosticsJson;

    if (request.requires_nonzero_k_dynamic_demag) {
        result.error_message =
            "nonzero-k Floquet dynamic demag is not implemented for native FEM frequency-domain";
        return result;
    }

    if (request.requires_modal_solver ||
        request.study_kind == FrequencyDomainStudyKind::modal_dynamic_matrix) {
#if FULLMAG_FEM_WITH_SLEPC
        result.status = FrequencyDomainStatus::ok;
        result.modal_solver_available = true;
        result.error_message = "";
        result.diagnostics_json = kCpuModalEigenDiagnosticsJson;
#else
        result.error_message =
            "native FEM modal dynamic-matrix solver requires PETSc/SLEPc support";
        result.diagnostics_json = kModalEigenNoSlepcDiagnosticsJson;
#endif
        return result;
    }

    if (request.has_floquet_k_vector &&
        floquet_k_vector_is_nonzero_or_invalid(request.floquet_k_vector_rad_per_m)) {
        result.status = FrequencyDomainStatus::ok;
        result.driven_response_available = true;
        result.floquet_response_available = true;
        result.error_message = "";
#if FULLMAG_HAS_CUDA_RUNTIME
        if (request.requires_gpu) {
            result.gpu_available = true;
            result.diagnostics_json = kGpuFloquetProjectedDrivenResponseDiagnosticsJson;
        } else {
            result.diagnostics_json = kFloquetProjectedDrivenResponseDiagnosticsJson;
        }
#else
        if (request.requires_gpu && request.strict_device) {
            result.status = FrequencyDomainStatus::unavailable;
            result.driven_response_available = false;
            result.floquet_response_available = false;
            result.error_message =
                "native FEM frequency-domain Floquet response GPU slice requires FULLMAG_HAS_CUDA_RUNTIME=1";
            return result;
        }
        result.diagnostics_json = kFloquetProjectedDrivenResponseDiagnosticsJson;
#endif
        return result;
    }

    if (request.requires_gpu && request.strict_device) {
        if (request.requires_static_periodic_boundary ||
            request.requires_floquet_boundary) {
#if FULLMAG_HAS_CUDA_RUNTIME
            result.status = FrequencyDomainStatus::ok;
            result.driven_response_available = true;
            result.static_periodic_response_available = true;
            result.gpu_available = true;
            result.error_message = "";
            result.diagnostics_json = kGpuStaticPeriodicDrivenResponseDiagnosticsJson;
            return result;
#else
            result.error_message =
                "native FEM frequency-domain production GPU static-periodic projection requires FULLMAG_HAS_CUDA_RUNTIME=1";
            return result;
#endif
        }
#if FULLMAG_HAS_CUDA_RUNTIME
        result.status = FrequencyDomainStatus::ok;
        result.driven_response_available = true;
        result.gpu_available = true;
        result.error_message = "";
        result.diagnostics_json = kGpuDrivenResponseDiagnosticsJson;
        return result;
#else
        result.error_message =
            "native FEM frequency-domain production GPU requires FULLMAG_HAS_CUDA_RUNTIME=1";
        return result;
#endif
    }

    result.status = FrequencyDomainStatus::ok;
    result.driven_response_available = true;
    result.static_periodic_response_available = true;
    result.error_message = "";
    result.diagnostics_json = kCpuDrivenResponseDiagnosticsJson;
    return result;
}

} // namespace fullmag::fem::frequency_domain
