#include "frequency_domain/frequency_domain_contract.hpp"

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
    "\"scope\":\"gamma_free_or_static_periodic_magnetic_response\"}";

constexpr const char *kInitialProgressJson =
    "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
    "\"state\":\"not_started\","
    "\"partial_artifacts_available\":false}";

constexpr const char *kInterruptedWithArtifactsProgressJson =
    "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
    "\"state\":\"interrupted\","
    "\"partial_artifacts_available\":true}";

constexpr const char *kInterruptedWithoutArtifactsProgressJson =
    "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
    "\"state\":\"interrupted\","
    "\"partial_artifacts_available\":false}";

constexpr const char *kCancellingWithArtifactsProgressJson =
    "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
    "\"state\":\"cancel_requested\","
    "\"partial_artifacts_available\":true}";

constexpr const char *kCancellingWithoutArtifactsProgressJson =
    "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
    "\"state\":\"cancel_requested\","
    "\"partial_artifacts_available\":false}";

constexpr const char *kCompletedProgressJson =
    "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
    "\"state\":\"completed\","
    "\"partial_artifacts_available\":true}";

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
    progress.progress_json = kInitialProgressJson;
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
    progress.progress_json = progress.partial_artifacts_available
        ? kInterruptedWithArtifactsProgressJson
        : kInterruptedWithoutArtifactsProgressJson;
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
    progress.progress_json = kCompletedProgressJson;
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
    progress.progress_json = progress.partial_artifacts_available
        ? kCancellingWithArtifactsProgressJson
        : kCancellingWithoutArtifactsProgressJson;
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

    if (request.has_floquet_k_vector) {
        result.error_message =
            "native FEM frequency-domain Floquet/Bloch nonzero-k metadata is ABI-visible but not implemented for driven response";
        return result;
    }

    if (request.requires_gpu && request.strict_device) {
        result.error_message = "native FEM frequency-domain GPU lane is not implemented";
        return result;
    }

    if (request.requires_modal_solver ||
        request.study_kind == FrequencyDomainStudyKind::modal_dynamic_matrix) {
        result.error_message = "native FEM modal dynamic-matrix solver is not implemented";
        return result;
    }

    if (request.requires_floquet_boundary) {
        result.error_message =
            "native FEM frequency-domain Floquet/PBC enforcement is not implemented for driven response";
        return result;
    }

    result.status = FrequencyDomainStatus::ok;
    result.driven_response_available = true;
    result.static_periodic_response_available = true;
    result.error_message = "";
    result.diagnostics_json = kCpuDrivenResponseDiagnosticsJson;
    return result;
}

} // namespace fullmag::fem::frequency_domain
