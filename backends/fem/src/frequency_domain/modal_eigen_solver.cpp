#include "frequency_domain/modal_eigen_solver.hpp"

#include "cpu/frequency_domain/contour_interval_solver.hpp"
#include "cpu/frequency_domain/mode_deduplication.hpp"
#include "cpu/frequency_domain/mode_filter.hpp"
#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
#include "cpu/frequency_domain/slepc_modal_eigen.hpp"
#include "frequency_domain/modal_gpu_krylov.hpp"
#include "cpu/frequency_domain/window_partition.hpp"
#include "frequency_domain/solver_progress.hpp"
#include "frequency_domain/linearized_dynamic_pencil.hpp"

#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <string>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
extern "C" int fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action(
    const fullmag::fem::frequency_domain::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    const double *v_q_real,
    const double *v_q_imag,
    unsigned long long v_q_count,
    double *out_q_real,
    double *out_q_imag,
    unsigned long long out_q_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len);
#endif

namespace fullmag::fem::frequency_domain {

namespace {

bool supported_frequency_domain_abi(std::uint32_t version) noexcept
{
    return version == kFrequencyDomainAbiVersion ||
        version == kFrequencyDomainV15AbiVersion ||
        version == kFrequencyDomainPreviousAbiVersion ||
        version == kFrequencyDomainPriorAbiVersion ||
        version == kFrequencyDomainLegacyAbiVersion;
}

bool valid_modal_request_enums(const ModalEigenRequest &request) noexcept
{
    const bool valid_execution_target =
        request.execution_target == ModalExecutionTarget::auto_select ||
        request.execution_target == ModalExecutionTarget::production_cpu ||
        request.execution_target == ModalExecutionTarget::production_gpu;
    const bool valid_scalar_representation =
        request.scalar_representation == ModalScalarRepresentation::real_split ||
        request.scalar_representation == ModalScalarRepresentation::complex_double;
    const bool valid_result_representation =
        request.result_field_representation == ModalResultFieldRepresentation::tangent_q ||
        request.result_field_representation == ModalResultFieldRepresentation::cartesian_delta_m ||
        request.result_field_representation ==
            ModalResultFieldRepresentation::tangent_q_and_cartesian_delta_m;
    return valid_execution_target && valid_scalar_representation && valid_result_representation;
}

std::string escape_json_string(const char *value)
{
    if (value == nullptr) {
        return "";
    }
    std::string escaped;
    for (const char *it = value; *it != '\0'; ++it) {
        switch (*it) {
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
            escaped += *it;
            break;
        }
    }
    return escaped;
}

std::string with_operator_diagnostics(
    std::string diagnostics_json,
    const char *operator_diagnostics_json)
{
    if (operator_diagnostics_json == nullptr || operator_diagnostics_json[0] == '\0') {
        return diagnostics_json;
    }
    if (diagnostics_json.empty() || diagnostics_json.back() != '}') {
        return diagnostics_json;
    }
    diagnostics_json.pop_back();
    diagnostics_json += ",\"operator_diagnostics\":";
    if (operator_diagnostics_json[0] == '{' || operator_diagnostics_json[0] == '[') {
        diagnostics_json += operator_diagnostics_json;
    } else {
        diagnostics_json += "\"";
        diagnostics_json += escape_json_string(operator_diagnostics_json);
        diagnostics_json += "\"";
    }
    diagnostics_json += "}";
    return diagnostics_json;
}

std::string format_double(double value) noexcept;

std::uint64_t required_modal_mode_vector_count(
    const PoissonAirboxModalEigenResult &result) noexcept
{
    const std::uint64_t max_count = std::numeric_limits<std::uint64_t>::max();
    if (result.q_dof_count > max_count - result.phi_dof_count) {
        return max_count;
    }
    const std::uint64_t base_count = result.q_dof_count + result.phi_dof_count;
    if (result.gauge_augmented && base_count == max_count) {
        return max_count;
    }
    return base_count + (result.gauge_augmented ? 1u : 0u);
}

bool accepted_modal_mode_vectors_valid(
    const PoissonAirboxModalEigenResult &result) noexcept
{
    const std::uint64_t required_count = required_modal_mode_vector_count(result);
    for (const PoissonAirboxModalEigenResult::AcceptedMode &mode : result.accepted_modes) {
        if (mode.full_vector.size() < required_count) {
            return false;
        }
    }
    return true;
}

DynamicPencilMetadata magnetic_pencil_metadata(
    const ModalEigenRequest &request) noexcept
{
    if (request.mfem_linearized_pencil_gamma0_m_per_a_s > 0.0) {
        return dynamic_pencil_metadata_from_legacy_gamma0(
            request.mfem_linearized_pencil_gamma0_m_per_a_s,
            request.phase_convention);
    }
    return dynamic_pencil_metadata_from_legacy_operator_request(
        request.operator_request, request.phase_convention);
}

std::string with_magnetic_pencil_digest(
    std::string json,
    const ModalEigenRequest &request,
    const char *field_name)
{
    if (!request.mfem_operator_enabled ||
        request.mfem_stiffness_matrix_row_major == nullptr ||
        request.mfem_gyrotropic_matrix_row_major == nullptr ||
        request.mfem_tangent_dof_count == 0 ||
        request.mfem_linearized_pencil_dependency_digest == nullptr ||
        json.empty() || json.back() != '}') {
        return json;
    }
    const std::uint64_t entry_count =
        request.mfem_tangent_dof_count * request.mfem_tangent_dof_count;
    std::vector<std::complex<double>> l(entry_count), b_alpha(entry_count);
    for (std::uint64_t i = 0; i < entry_count; ++i) {
        l[i] = {-request.mfem_stiffness_matrix_row_major[i], 0.0};
        b_alpha[i] = {-request.mfem_gyrotropic_matrix_row_major[i], 0.0};
    }
    DynamicPencilMetadata canonical_metadata{};
    char metadata_error[128]{};
    const DynamicPencilMetadata request_metadata =
        request.poisson_airbox_block_enabled != 0
        ? dynamic_pencil_metadata_from_legacy_operator_request(
              request.operator_request, request.phase_convention)
        : magnetic_pencil_metadata(request);
    if (canonicalize_dynamic_pencil_metadata(
            request_metadata,
            &canonical_metadata,
            metadata_error,
            sizeof(metadata_error)) != FrequencyDomainStatus::ok) {
        return json;
    }
    const LinearizedDynamicPencil pencil = LinearizedDynamicPencil::from_dense_row_major(
        canonical_metadata,
        request.mfem_tangent_dof_count, std::move(l), std::move(b_alpha),
        request.mfem_linearized_pencil_dependency_digest);
    json.pop_back();
    json += ",\"" + std::string(field_name) + "\":\"" + pencil.digest() + "\",";
    json += "\"linearized_dynamic_pencil_dependency_digest\":\"" +
        pencil.dependency_digest() + "\",";
    json += "\"linearized_dynamic_pencil_gamma0_m_per_a_s\":" +
        format_double(canonical_metadata.gamma0_m_per_a_s) + "}";
    return json;
}

FrequencyDomainContractResult validation_error_result(
    const char *study_product,
    const char *message,
    const char *reason,
    const char *operator_diagnostics_json = nullptr) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::validation_error;
    result.error_message = message != nullptr ? message : "";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
        "\"study_product\":\"" +
        std::string(study_product != nullptr ? study_product : "") +
        "\",\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"reason\":\"" +
        std::string(reason != nullptr ? reason : "validation_error") +
        "\"}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_contract_result.v1\","
        "\"study_product\":\"" +
        std::string(study_product != nullptr ? study_product : "") +
        "\",\"status\":\"validation_error\"}";
    result.modal_execution.execution_target =
        FULLMAG_FEM_MODAL_EXECUTION_VALIDATION;
    result.modal_execution.scalar_representation =
        static_cast<std::uint32_t>(ModalScalarRepresentation::complex_double);
    result.modal_execution.spectral_transform_kind =
        static_cast<std::uint32_t>(ModalSpectralTransformKind::auto_select);
    result.modal_execution.fallback_state = ModalResolvedFallbackState::none;
    result.modal_execution.engine_id = "validation_error";
    result.modal_execution.fallback_reason = "none";
    return result;
}

void set_modal_execution(
    FrequencyDomainContractResult &result,
    ModalExecutionTarget target,
    ModalSpectralTransformKind transform,
    const char *engine_id) noexcept
{
    result.modal_execution.execution_target = static_cast<std::uint32_t>(target);
    result.modal_execution.scalar_representation =
        static_cast<std::uint32_t>(ModalScalarRepresentation::complex_double);
    result.modal_execution.spectral_transform_kind = static_cast<std::uint32_t>(transform);
    result.modal_execution.fallback_state = ModalResolvedFallbackState::none;
    result.modal_execution.engine_id = engine_id != nullptr ? engine_id : "unavailable";
    result.modal_execution.fallback_reason = "none";
}

bool output_directory_required(int write_partial_artifacts, const char *output_directory) noexcept
{
    return write_partial_artifacts != 0 &&
           (output_directory == nullptr || output_directory[0] == '\0');
}

bool write_text_file(
    const std::filesystem::path &path,
    const char *text,
    std::string &error_message) noexcept
{
    std::error_code error_code;
    std::filesystem::create_directories(path.parent_path(), error_code);
    if (error_code) {
        error_message = "failed to create modal eigen artifact directory: ";
        error_message += error_code.message();
        return false;
    }

    std::ofstream file(path, std::ios::out | std::ios::trunc);
    if (!file) {
        error_message = "failed to open modal eigen artifact for writing";
        return false;
    }
    file << (text != nullptr ? text : "");
    file << "\n";
    if (!file) {
        error_message = "failed to write modal eigen artifact";
        return false;
    }
    return true;
}

bool cancel_requested(const ModalEigenRequest &request) noexcept
{
    return request.cancel_requested != nullptr &&
        request.cancel_requested(request.cancel_user_data) != 0;
}

std::string format_double(double value) noexcept
{
    char buffer[64]{};
    const int written = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        return "0";
    }
    return buffer;
}

bool append_shared_domain_cartesian_modes(
    const FullmagFemModalSharedDomainPayload &payload,
    const PoissonAirboxModalEigenResult &poisson_result,
    ModalEigenTypedResult *out_result,
    std::string &error_message)
{
    if (out_result == nullptr || payload.equilibrium_m0_xyz == nullptr ||
        payload.equilibrium_m0_xyz_count == 0u ||
        payload.magnetic_reduced_node == nullptr ||
        payload.magnetic_reduced_node_count == 0u) {
        error_message = "shared-domain modal result is missing the equilibrium or magnetic class payload";
        return false;
    }
    if (payload.equilibrium_m0_xyz_count % 3u != 0u) {
        error_message = "shared-domain equilibrium payload is not xyz-packed";
        return false;
    }
    const std::uint64_t node_count = payload.equilibrium_m0_xyz_count / 3u;
    if (payload.magnetic_reduced_node_count == 0u ||
        payload.magnetic_reduced_node_count > node_count ||
        poisson_result.q_dof_count != 2u * payload.magnetic_reduced_node_count) {
        error_message = "shared-domain modal q dimensions do not match the magnetic class map";
        return false;
    }

    const std::uint32_t inactive_class = std::numeric_limits<std::uint32_t>::max();
    std::vector<double> equilibrium_for_frames(
        payload.equilibrium_m0_xyz,
        payload.equilibrium_m0_xyz + payload.equilibrium_m0_xyz_count);
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const std::uint32_t reduced_node = payload.magnetic_reduced_node[node];
        if (reduced_node == inactive_class) {
            // Shared magnetic/airbox meshes carry zero magnetisation in airbox
            // nodes.  Use the same neutral frame as the operator assembly for
            // those nodes; their tangent amplitudes remain zero below.
            equilibrium_for_frames[3u * node] = 0.0;
            equilibrium_for_frames[3u * node + 1u] = 0.0;
            equilibrium_for_frames[3u * node + 2u] = 1.0;
        } else if (reduced_node >= payload.magnetic_reduced_node_count) {
            error_message = "shared-domain magnetic class map contains an out-of-range node";
            return false;
        }
    }

    std::vector<TangentFrameNode> frames(static_cast<std::size_t>(node_count));
    TangentFrameDiagnostics frame_diagnostics{};
    if (build_tangent_frame(
            equilibrium_for_frames.data(),
            node_count,
            frames.data(),
            &frame_diagnostics) != FrequencyDomainStatus::ok) {
        error_message = frame_diagnostics.error_message;
        return false;
    }

    const std::uint64_t q_dof_count = poisson_result.q_dof_count;
    out_result->mode_delta_m_xyz_complex.clear();
    out_result->mode_delta_m_xyz_complex.reserve(
        poisson_result.accepted_modes.size() * 3u * node_count);
    for (const PoissonAirboxModalEigenResult::AcceptedMode &mode :
         poisson_result.accepted_modes) {
        if (mode.full_vector.size() < q_dof_count + poisson_result.phi_dof_count) {
            error_message = "shared-domain accepted mode vector is shorter than q+phi dimensions";
            return false;
        }
        std::vector<double> tangent_real(static_cast<std::size_t>(2u * node_count), 0.0);
        std::vector<double> tangent_imag(static_cast<std::size_t>(2u * node_count), 0.0);
        for (std::uint64_t node = 0; node < node_count; ++node) {
            const std::uint32_t reduced_node = payload.magnetic_reduced_node[node];
            if (reduced_node == inactive_class) {
                continue;
            }
            if (reduced_node >= payload.magnetic_reduced_node_count) {
                error_message = "shared-domain magnetic class map contains an out-of-range node";
                return false;
            }
            const std::uint64_t reduced_offset = 2u * reduced_node;
            const std::uint64_t node_offset = 2u * node;
            tangent_real[node_offset] = mode.full_vector[reduced_offset].real();
            tangent_real[node_offset + 1u] = mode.full_vector[reduced_offset + 1u].real();
            tangent_imag[node_offset] = mode.full_vector[reduced_offset].imag();
            tangent_imag[node_offset + 1u] = mode.full_vector[reduced_offset + 1u].imag();
        }
        std::vector<double> cartesian_real(static_cast<std::size_t>(3u * node_count), 0.0);
        std::vector<double> cartesian_imag(static_cast<std::size_t>(3u * node_count), 0.0);
        lift_tangent_complex_to_cartesian(
            frames.data(),
            tangent_real.data(),
            tangent_imag.data(),
            node_count,
            cartesian_real.data(),
            cartesian_imag.data());
        for (std::uint64_t component = 0; component < 3u * node_count; ++component) {
            out_result->mode_delta_m_xyz_complex.emplace_back(
                cartesian_real[component], cartesian_imag[component]);
        }
    }
    return true;
}

std::string format_poisson_airbox_modes_json(
    const PoissonAirboxModalEigenResult &result)
{
    // Keep the serializer fail-closed even if a future caller bypasses the
    // contract-result validation below.  Never index an accepted mode vector
    // until the complete q+phi(+gauge) extent has been checked.
    if (!accepted_modal_mode_vectors_valid(result)) {
        return "[]";
    }
    std::string modes = "[";
    for (std::size_t mode_index = 0; mode_index < result.accepted_modes.size(); ++mode_index) {
        const PoissonAirboxModalEigenResult::AcceptedMode &mode =
            result.accepted_modes[mode_index];
        if (mode_index != 0) {
            modes += ",";
        }
        modes +=
            "{\"mode_index\":" + std::to_string(mode_index) +
            ",\"eigenpair_index\":" + std::to_string(mode.eigenpair_index) +
            ",\"eigenvalue_real\":" + format_double(mode.eigenvalue_real) +
            ",\"eigenvalue_imag\":" + format_double(mode.eigenvalue_imag) +
            ",\"omega_rad_s\":" + format_double(mode.omega_rad_s) +
            ",\"frequency_hz\":" + format_double(mode.frequency_hz) +
            ",\"relative_residual\":" + format_double(mode.relative_residual) +
            ",\"slepc_reported_backward_error\":" +
            format_double(mode.slepc_reported_backward_error) +
            ",\"full_residual_reconstruction_relative_error\":" +
            format_double(mode.full_residual_reconstruction_relative_error) +
            ",\"magnetic_block_backward_error\":" +
            format_double(mode.magnetic_block_backward_error) +
            ",\"poisson_block_backward_error\":" +
            format_double(mode.poisson_block_backward_error) +
            ",\"gauge_constraint_backward_error\":" +
            format_double(mode.gauge_constraint_backward_error) +
            ",\"magnetic_residual_l2\":" +
            format_double(mode.magnetic_residual_l2) +
            ",\"poisson_residual_l2\":" +
            format_double(mode.poisson_residual_l2) +
            ",\"gauge_residual_abs\":" +
            format_double(mode.gauge_residual_abs) +
            ",\"gauge_mean_abs\":" + format_double(mode.gauge_mean_abs);
        modes += ",\"q_layout\":\"" +
            std::string(result.q_layout_interleaved_node_component
                            ? "interleaved_node_component"
                            : "block_component_node") +
            "\"";
        const std::uint64_t q_count = result.q_dof_count;
        const std::uint64_t phi_count = result.phi_dof_count;
        modes += ",\"mode_vector_real\":[";
        for (std::uint64_t index = 0; index < q_count; ++index) {
            if (index != 0) {
                modes += ",";
            }
            modes += format_double(mode.full_vector[static_cast<std::size_t>(index)].real());
        }
        modes += "],\"mode_vector_imag\":[";
        for (std::uint64_t index = 0; index < q_count; ++index) {
            if (index != 0) {
                modes += ",";
            }
            modes += format_double(mode.full_vector[static_cast<std::size_t>(index)].imag());
        }
        modes += "],\"mode_q_real\":[";
        for (std::uint64_t index = 0; index < q_count; ++index) {
            if (index != 0) {
                modes += ",";
            }
            modes += format_double(mode.full_vector[static_cast<std::size_t>(index)].real());
        }
        modes += "],\"mode_q_imag\":[";
        for (std::uint64_t index = 0; index < q_count; ++index) {
            if (index != 0) {
                modes += ",";
            }
            modes += format_double(mode.full_vector[static_cast<std::size_t>(index)].imag());
        }
        modes += "],\"mode_phi_real\":[";
        for (std::uint64_t index = 0; index < phi_count; ++index) {
            if (index != 0) {
                modes += ",";
            }
            modes += format_double(mode.full_vector[static_cast<std::size_t>(q_count + index)].real());
        }
        modes += "],\"mode_phi_imag\":[";
        for (std::uint64_t index = 0; index < phi_count; ++index) {
            if (index != 0) {
                modes += ",";
            }
            modes += format_double(mode.full_vector[static_cast<std::size_t>(q_count + index)].imag());
        }
        modes += "]";
        if (result.gauge_augmented) {
            const std::size_t gauge_index = static_cast<std::size_t>(q_count + phi_count);
            modes += ",\"mode_gauge_real\":" +
                format_double(mode.full_vector[gauge_index].real()) +
                ",\"mode_gauge_imag\":" +
                format_double(mode.full_vector[gauge_index].imag());
        }
        modes += "}";
    }
    modes += "]";
    return modes;
}

void emit_progress(
    const ModalEigenRequest &request,
    double shift_frequency_hz,
    std::uint64_t candidate_mode_count,
    std::uint64_t accepted_mode_count,
    double relative_residual,
    const char *stop_reason = nullptr) noexcept
{
    if (request.progress_callback == nullptr) {
        return;
    }
    const std::string stop_reason_json = stop_reason == nullptr ?
        "null" :
        std::string("\"") + escape_json_string(stop_reason) + "\"";
    char progress_json[1024]{};
    const int written = std::snprintf(
        progress_json,
        sizeof(progress_json),
        "{\"schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_phase\":\"solving_shift_invert\","
        "\"execution_lane\":\"validation\","
        "\"requested_mode_count\":%d,"
        "\"accepted_mode_count\":%llu,"
        "\"candidate_mode_count\":%llu,"
        "\"current_shift_hz\":%.17g,"
        "\"shift_frequency_hz\":%.17g,"
        "\"shift_omega_rad_s\":%.17g,"
        "\"outer_iteration\":1,"
        "\"max_outer_iterations\":%d,"
        "\"linear_iteration\":1,"
        "\"max_linear_iterations\":%d,"
        "\"current_residual_relative_l2\":%.17g,"
        "\"target_residual_relative_l2\":%.17g,"
        "\"partial_artifacts_available\":false,"
        "\"latest_artifact_manifest_path\":\"\","
        "\"stop_reason\":%s}",
        request.requested_mode_count,
        static_cast<unsigned long long>(accepted_mode_count),
        static_cast<unsigned long long>(candidate_mode_count),
        shift_frequency_hz,
        shift_frequency_hz,
        2.0 * 3.14159265358979323846264338327950288 * shift_frequency_hz,
        request.max_outer_iterations,
        request.max_linear_iterations,
        relative_residual,
        request.residual_tolerance,
        stop_reason_json.c_str());
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(progress_json)) {
        return;
    }
    request.progress_callback(request.progress_user_data, progress_json);
}

void emit_contour_progress(
    const ModalEigenRequest &request,
    const ContourIntervalSolveResult &contour_result) noexcept
{
    if (request.progress_callback == nullptr) {
        return;
    }
    for (const ContourPointSolveDiagnostic &point : contour_result.contour_points) {
        SolverProgressState state{};
        state.study_product = "modal_eigen";
        state.solver_phase = "solving_contour_interval";
        state.execution_lane = "validation";
        state.stop_reason = nullptr;
        state.contour_point_index = static_cast<int>(point.index);
        state.contour_point_count = contour_result.contour_point_count;
        state.linear_iteration = point.linear_iterations;
        state.max_linear_iterations = request.max_linear_iterations;
        char progress_json[1024];
        if (solver_progress_json(state, progress_json, sizeof(progress_json)) == 0) {
            continue;
        }
        request.progress_callback(request.progress_user_data, progress_json);
    }
}

double target_shift_frequency_hz(const ModalEigenRequest &request) noexcept
{
    const char *target_kind = request.target_kind != nullptr ? request.target_kind : "";
    if (std::strcmp(target_kind, "nearest_frequency") == 0) {
        return request.target_frequency_hz;
    }
    if (std::strcmp(target_kind, "frequency_window") == 0) {
        return 0.5 * (request.frequency_min_hz + request.frequency_max_hz);
    }
    return 0.0;
}

bool is_frequency_window(const ModalEigenRequest &request) noexcept
{
    const char *target_kind = request.target_kind != nullptr ? request.target_kind : "";
    return std::strcmp(target_kind, "frequency_window") == 0;
}

FrequencyWindowPartitionRequest partition_request_from_modal_request(
    const ModalEigenRequest &request) noexcept
{
    FrequencyWindowPartitionRequest partition_request{};
    partition_request.frequency_min_hz = request.frequency_min_hz;
    partition_request.frequency_max_hz = request.frequency_max_hz;
    partition_request.requested_mode_count = request.requested_mode_count;
    partition_request.completeness_policy = request.completeness_policy;
    return partition_request;
}

std::string window_completeness_status(
    const FrequencyWindowPartition &partition,
    bool unresolved,
    bool truncated_by_requested_count) noexcept
{
    if (unresolved) {
        return "partial_convergence";
    }
    if (truncated_by_requested_count) {
        return "truncated_by_requested_count";
    }
    if (!partition.uncertified_subwindows.empty() ||
        std::strcmp(partition.certification_method, "none") == 0) {
        return "not_certified";
    }
    return "certified";
}

std::string window_diagnostics_json(
    const ModalEigenRequest &request,
    const FrequencyWindowPartition &partition,
    double accepted_frequency_hz,
    double residual,
    std::uint64_t accepted_mode_count,
    bool unresolved,
    bool truncated_by_requested_count)
{
    if (partition.subwindows.empty()) {
        return "";
    }
    const std::string completeness_status =
        window_completeness_status(partition, unresolved, truncated_by_requested_count);
    double resolved_min_hz = partition.subwindows.front().search_min_hz;
    double resolved_max_hz = partition.subwindows.front().search_max_hz;
    for (const FrequencySubwindow &subwindow : partition.subwindows) {
        resolved_min_hz = std::min(resolved_min_hz, subwindow.search_min_hz);
        resolved_max_hz = std::max(resolved_max_hz, subwindow.search_max_hz);
    }
    const char *additional_modes_may_exist =
        std::strcmp(partition.completeness_policy, "best_effort") == 0 ||
                unresolved || truncated_by_requested_count ?
            "true" :
            "false";

    std::string json =
        "\"requested_window_hz\":[" +
        format_double(request.frequency_min_hz) + "," +
        format_double(request.frequency_max_hz) + "],"
        "\"resolved_search_window_hz\":[" +
        format_double(resolved_min_hz) + "," +
        format_double(resolved_max_hz) + "],"
        "\"window_completeness\":{"
        "\"policy\":\"" +
        std::string(partition.completeness_policy) +
        "\",\"status\":\"" +
        completeness_status +
        "\",\"certification_method\":\"" +
        std::string(partition.certification_method) +
        "\",\"estimated_modes_in_window\":" +
        std::to_string(partition.estimated_modes_in_window) +
        ",\"certified_modes_in_window\":" +
        std::to_string(partition.certified_modes_in_window) +
        ",\"additional_modes_may_exist\":" +
        std::string(additional_modes_may_exist) +
        "},\"subwindows\":[";

    for (std::size_t i = 0; i < partition.subwindows.size(); ++i) {
        const FrequencySubwindow &subwindow = partition.subwindows[i];
        const bool candidate_in_search =
            std::isfinite(accepted_frequency_hz) &&
            accepted_frequency_hz >= subwindow.search_min_hz &&
            accepted_frequency_hz <= subwindow.search_max_hz;
        const bool accepted_in_requested =
            accepted_mode_count > 0 &&
            std::isfinite(accepted_frequency_hz) &&
            accepted_frequency_hz >= subwindow.requested_min_hz &&
            accepted_frequency_hz <= subwindow.requested_max_hz;
        const char *stop_reason = unresolved ?
            "max_iterations" :
            (accepted_in_requested ? "converged" : "window_exhausted");
        if (i > 0) {
            json += ",";
        }
        json +=
            "{\"index\":" +
            std::to_string(subwindow.index) +
            ",\"requested_hz\":[" +
            format_double(subwindow.requested_min_hz) + "," +
            format_double(subwindow.requested_max_hz) +
            "],\"search_hz\":[" +
            format_double(subwindow.search_min_hz) + "," +
            format_double(subwindow.search_max_hz) +
            "],\"shift_hz\":" +
            format_double(subwindow.shift_hz) +
            ",\"outer_iterations\":" +
            std::to_string(unresolved ? 0 : 1) +
            ",\"linear_iterations_total\":" +
            std::to_string(unresolved ? 0 : 1) +
            ",\"candidate_modes\":" +
            std::to_string(candidate_in_search ? 1 : 0) +
            ",\"accepted_modes\":" +
            std::to_string(accepted_in_requested ? 1 : 0) +
            ",\"residual_max\":" +
            format_double(candidate_in_search ? residual : 0.0) +
            ",\"stop_reason\":\"" +
            stop_reason +
            "\"}";
    }
    json += "]";
    return json;
}

void apply_contour_certification_to_partition(
    FrequencyWindowPartition &partition,
    const ContourIntervalSolveResult &contour_result) noexcept
{
    partition.certification_method =
        contour_result.count_certificate ?
            "contour_interval_count" :
            "contour_interval_best_effort";
    partition.estimated_modes_in_window = contour_result.estimated_mode_count;
    partition.certified_modes_in_window =
        contour_result.count_certificate ? contour_result.estimated_mode_count : 0;
    if (contour_result.count_certificate) {
        partition.uncertified_subwindows.clear();
    }
}

bool load_tiny_validation_matrix(
    const double *matrix_row_major,
    const double *diagonal,
    double out_matrix[4]) noexcept
{
    if (matrix_row_major != nullptr) {
        for (int i = 0; i < 4; ++i) {
            out_matrix[i] = matrix_row_major[i];
        }
        return true;
    }
    if (diagonal != nullptr) {
        out_matrix[0] = diagonal[0];
        out_matrix[1] = 0.0;
        out_matrix[2] = 0.0;
        out_matrix[3] = diagonal[1];
        return true;
    }
    return false;
}

double complex_vector_norm2(const std::complex<double> v[2]) noexcept
{
    return std::sqrt(std::norm(v[0]) + std::norm(v[1]));
}

FrequencyDomainContractResult unresolved_window_result(
    const ModalEigenRequest &request,
    const FrequencyWindowPartition &partition) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::solve_error;
    result.error_message =
        "native FEM modal_eigen frequency window did not resolve before max_outer_iterations";
    std::string diagnostics =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"solve_error\","
        "\"complete\":false,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"tiny_validation_solver\":true,"
        "\"stop_reason\":\"max_iterations\",";
    diagnostics += window_diagnostics_json(
        request,
        partition,
        std::numeric_limits<double>::quiet_NaN(),
        0.0,
        0,
        true,
        false);
    diagnostics += "}";
    result.diagnostics_json = with_operator_diagnostics(
        diagnostics,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"solve_error\","
        "\"accepted_mode_count\":0,"
        "\"window_completeness\":\"partial_convergence\"}";
    return result;
}

FrequencyDomainContractResult contour_interval_error_result(
    const ModalEigenRequest &request,
    FrequencyWindowPartition partition,
    const ModalSolverSelection &selection,
    const ContourIntervalSolveResult &contour_result) noexcept
{
    apply_contour_certification_to_partition(partition, contour_result);
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::solve_error;
    const char *stop_reason = contour_result.stop_reason != nullptr ?
        contour_result.stop_reason :
        "partial_convergence";
    result.error_message =
        std::strcmp(stop_reason, "linear_solver_unavailable") == 0 ?
            "native FEM modal_eigen contour interval solver requires a positive linear iteration budget" :
            "native FEM modal_eigen contour interval solver did not certify the requested window";
    const bool unresolved =
        std::strcmp(stop_reason, "max_iterations") == 0;
    std::string diagnostics =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"solve_error\","
        "\"complete\":false,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_family\":\"contour_interval_validation\","
        "\"stop_reason\":\"" +
        std::string(stop_reason) +
        "\",";
    diagnostics += window_diagnostics_json(
        request,
        partition,
        std::numeric_limits<double>::quiet_NaN(),
        0.0,
        0,
        unresolved,
        false);
    diagnostics += ",";
    diagnostics += contour_interval_diagnostics_json(contour_result);
    diagnostics += "}";
    result.diagnostics_json = with_operator_diagnostics(
        diagnostics,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"solve_error\","
        "\"accepted_mode_count\":0,"
        "\"window_completeness\":\"" +
        window_completeness_status(partition, unresolved, false) +
        "\"}";
    return result;
}

FrequencyDomainContractResult contour_interval_ok_result(
    const ModalEigenRequest &request,
    FrequencyWindowPartition partition,
    const ModalSolverSelection &selection,
    const ContourIntervalSolveResult &contour_result) noexcept
{
    apply_contour_certification_to_partition(partition, contour_result);
    FrequencyDomainContractResult result{};
    const ContourIntervalMode &mode = contour_result.modes.front();
    emit_contour_progress(request, contour_result);
    const std::string window_diagnostics = window_diagnostics_json(
        request,
        partition,
        mode.frequency_hz,
        mode.relative_residual,
        static_cast<std::uint64_t>(contour_result.accepted_mode_count),
        false,
        false);
    const std::string completeness_status =
        window_completeness_status(partition, false, false);

    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"algebraic_form\":\"first_order_complex\","
        "\"resolved_solver_family\":\"" +
        std::string(selection.family) +
        "\",\"solver_selection_reason\":\"" +
        std::string(selection.reason) +
        "\",\"solver_family\":\"contour_interval_validation\","
        "\"slepc_problem_type\":\"validation_not_slepc\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(contour_result.accepted_mode_count) +
        ",\"candidate_mode_count\":" +
        std::to_string(contour_result.estimated_mode_count) +
        ",\"relative_residual_max\":" +
        format_double(mode.relative_residual) +
        ",";
    result.diagnostics_json += window_diagnostics;
    result.diagnostics_json += ",";
    result.diagnostics_json += contour_interval_diagnostics_json(contour_result);
    result.diagnostics_json += "}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"accepted_mode_count\":" +
        std::to_string(contour_result.accepted_mode_count) + ","
        "\"frequency_hz\":" +
        format_double(mode.frequency_hz) +
        ",\"omega_rad_s\":" +
        format_double(mode.omega_rad_s) +
        ",\"eigenvalue_real\":" +
        format_double(std::real(mode.eigenvalue)) +
        ",\"eigenvalue_imag\":" +
        format_double(std::imag(mode.eigenvalue)) + ","
        "\"relative_residual\":" +
        format_double(mode.relative_residual) +
        ",\"shift_frequency_hz\":" +
        format_double(target_shift_frequency_hz(request)) +
        ",\"window_completeness\":\"" +
        completeness_status +
        "\"}";
    result.artifact_manifest_path.clear();
    return result;
}

FrequencyDomainContractResult interrupted_result(
    const ModalEigenRequest &request,
    const char *message,
    const char *stop_reason) noexcept
{
    FrequencyDomainContractResult result{};
    result.status = FrequencyDomainStatus::interrupted;
    result.error_message = message != nullptr ? message : "";
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"interrupted\","
        "\"complete\":false,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"tiny_validation_solver\":true,"
        "\"stop_reason\":\"" +
        std::string(stop_reason != nullptr ? stop_reason : "cancel_requested") +
        "\"}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"interrupted\","
        "\"accepted_mode_count\":0}";
    return result;
}

FrequencyDomainContractResult slepc_tiny_validation_result(
    const ModalEigenRequest &request,
    const double stiffness[4],
    const double gyrotropic_mass[4]) noexcept
{
    constexpr double kTwoPi = 2.0 * 3.14159265358979323846264338327950288;
    const double shift_frequency_hz = target_shift_frequency_hz(request);
    SLEPcTinyGyrotropicModalEigenRequest slepc_request{};
    slepc_request.tangent_dof_count =
        static_cast<int>(request.tiny_validation_tangent_dof_count);
    slepc_request.stiffness_matrix_row_major = stiffness;
    slepc_request.gyrotropic_matrix_row_major = gyrotropic_mass;
    slepc_request.requested_mode_count = request.requested_mode_count;
    slepc_request.target_frequency_hz = shift_frequency_hz;
    slepc_request.frequency_min_hz = request.frequency_min_hz;
    slepc_request.frequency_max_hz = request.frequency_max_hz;
    slepc_request.residual_tolerance = request.residual_tolerance;
    slepc_request.max_outer_iterations = request.max_outer_iterations;
    slepc_request.max_linear_iterations = request.max_linear_iterations;
    slepc_request.phase_convention = request.phase_convention;

    const SLEPcTinyGyrotropicModalEigenResult slepc_result =
        solve_slepc_tiny_gyrotropic_modal_eigen(slepc_request);
    FrequencyDomainContractResult result{};
    const char *status = slepc_result.ok ? "ok" : "solve_error";
    result.status = slepc_result.ok ?
        FrequencyDomainStatus::ok :
        FrequencyDomainStatus::solve_error;
    result.error_message = slepc_result.ok ?
        "" :
        "native FEM modal_eigen validation SLEPc shift-invert solve failed";
    if (slepc_result.ok) {
        emit_progress(
            request,
            shift_frequency_hz,
            static_cast<std::uint64_t>(slepc_result.converged_eigenpair_count),
            static_cast<std::uint64_t>(slepc_result.accepted_mode_count),
            slepc_result.max_relative_residual);
    }
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"" +
        std::string(status) +
        "\",\"complete\":" +
        std::string(slepc_result.ok ? "true" : "false") +
        ",\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"solver_adapter\":\"" +
        std::string(slepc_result.solver_adapter) +
        "\",\"solver_family\":\"slepc_shift_invert_validation\","
        "\"eps_type\":\"" +
        std::string(slepc_result.eps_type) +
        "\",\"slepc_problem_type\":\"" +
        std::string(slepc_result.problem_type) +
        "\",\"spectral_transform\":\"" +
        std::string(slepc_result.spectral_transform) +
        "\",\"which_eigenpairs\":\"" +
        std::string(slepc_result.which_eigenpairs) +
        "\",\"ksp_type\":\"" +
        std::string(slepc_result.ksp_type) +
        "\",\"pc_type\":\"" +
        std::string(slepc_result.pc_type) +
        "\",\"ksp_rtol\":" +
        format_double(slepc_result.ksp_rtol) +
        ",\"ksp_atol\":" +
        format_double(slepc_result.ksp_atol) +
        ",\"ksp_max_iterations\":" +
        std::to_string(slepc_result.ksp_max_iterations) +
        ",\"ksp_final_residual\":" +
        format_double(slepc_result.ksp_final_residual) +
        ",\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, phase_convention), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_representation\":\"canonical_complex_lambda\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase_convention).frequency_hz\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count) +
        ",\"candidate_mode_count\":" +
        std::to_string(slepc_result.converged_eigenpair_count) +
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(kTwoPi * shift_frequency_hz) +
        ",\"outer_iteration\":" +
        std::to_string(slepc_result.outer_iterations) +
        ",\"linear_iteration\":1,"
        "\"relative_residual_max\":" +
        format_double(slepc_result.max_relative_residual);
    if (!slepc_result.ok) {
        result.diagnostics_json +=
            ",\"stop_reason\":\"" +
            std::string(
                slepc_result.unsupported_reason != nullptr &&
                        slepc_result.unsupported_reason[0] != '\0' ?
                    slepc_result.unsupported_reason :
                    "slepc_validation_solve_failed") +
            "\"";
    }
    result.diagnostics_json += "}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);

    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"" +
        std::string(status) +
        "\",\"solver_adapter\":\"" +
        std::string(slepc_result.solver_adapter) +
        "\",\"eigenvalue_representation\":\"canonical_complex_lambda\","
        "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase_convention).frequency_hz\","
        "\"accepted_mode_count\":" +
        std::to_string(slepc_result.accepted_mode_count);
    if (slepc_result.ok) {
        const ModeKinematics kinematics = map_eigenvalue(
            {slepc_result.lambda_real, slepc_result.lambda_imag},
            request.phase_convention);
        result.result_json +=
            ",\"frequency_hz\":" +
            format_double(kinematics.frequency_hz) +
            ",\"omega_rad_s\":" +
            format_double(kinematics.omega_rad_s) +
            ",\"eigenvalue_real\":" +
            format_double(slepc_result.lambda_real) +
            ",\"eigenvalue_imag\":" +
            format_double(slepc_result.lambda_imag) +
            ",\"relative_residual\":" +
            format_double(slepc_result.relative_residual);
    }
    result.result_json +=
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz) +
        ",\"shift_omega_rad_s\":" +
        format_double(kTwoPi * shift_frequency_hz) +
        "}";
    result.artifact_manifest_path.clear();
    set_modal_execution(
        result,
        ModalExecutionTarget::validation,
        ModalSpectralTransformKind::shift_invert,
        "slepc_tiny_validation");
    return result;
}

FrequencyDomainContractResult solve_tiny_validation_modal_problem(
    const ModalEigenRequest &request) noexcept
{
    FrequencyDomainContractResult result{};
    if (request.tiny_validation_tangent_dof_count != 2) {
        return validation_error_result(
            "modal_eigen",
            "modal tiny validation currently requires exactly two tangent DOFs",
            "tiny_validation_requires_two_dofs",
            request.operator_request.operator_diagnostics_json);
    }
    if (cancel_requested(request)) {
        return interrupted_result(
            request,
            "native FEM modal_eigen validation solve was interrupted before shift-invert",
            "cancel_requested");
    }

    double stiffness[4]{};
    double gyrotropic_mass[4]{};
    if (!load_tiny_validation_matrix(
            request.tiny_validation_stiffness_matrix_row_major,
            request.tiny_validation_stiffness_diagonal,
            stiffness) ||
        !load_tiny_validation_matrix(
            request.tiny_validation_mass_matrix_row_major,
            request.tiny_validation_mass_diagonal,
            gyrotropic_mass)) {
        return validation_error_result(
            "modal_eigen",
            "modal tiny validation requires stiffness and gyrotropic mass matrices",
            "tiny_validation_missing_matrices",
            request.operator_request.operator_diagnostics_json);
    }
    FrequencyWindowPartition partition{};
    if (is_frequency_window(request)) {
        partition = partition_frequency_window(partition_request_from_modal_request(request));
        if (partition.subwindows.empty()) {
            return validation_error_result(
                "modal_eigen",
                "modal frequency_window requires finite ordered non-negative bounds",
                "invalid_frequency_window",
                request.operator_request.operator_diagnostics_json);
        }
        const ModalSolverSelection selection =
            select_modal_solver_for_frequency_window(
                request.frequency_min_hz,
                request.frequency_max_hz,
                request.eigensolver_family);
        if (std::strcmp(selection.family, "contour_interval") == 0) {
            ContourIntervalSolverRequest contour_request{};
            contour_request.frequency_min_hz = request.frequency_min_hz;
            contour_request.frequency_max_hz = request.frequency_max_hz;
            contour_request.requested_mode_count = request.requested_mode_count;
            contour_request.residual_tolerance = request.residual_tolerance;
            contour_request.max_outer_iterations = request.max_outer_iterations;
            contour_request.max_linear_iterations = request.max_linear_iterations;
            contour_request.eigensolver_family = request.eigensolver_family;
            contour_request.completeness_policy = request.completeness_policy;
            contour_request.contour_point_count = 16;
            contour_request.tangent_dof_count = request.tiny_validation_tangent_dof_count;
            contour_request.stiffness_matrix_row_major = stiffness;
            contour_request.gyrotropic_mass_matrix_row_major = gyrotropic_mass;
            const ContourIntervalSolveResult contour_result =
                solve_tiny_contour_interval(contour_request);
            if (!contour_result.ok || contour_result.modes.empty()) {
                return contour_interval_error_result(
                    request,
                    partition,
                    selection,
                    contour_result);
            }
            return contour_interval_ok_result(
                request,
                partition,
                selection,
                contour_result);
        }
        if (request.max_outer_iterations <= 0) {
            return unresolved_window_result(request, partition);
        }
    }

#if FULLMAG_FEM_WITH_SLEPC
    if (!is_frequency_window(request)) {
        return slepc_tiny_validation_result(request, stiffness, gyrotropic_mass);
    }
#endif

    const double det_g =
        gyrotropic_mass[0] * gyrotropic_mass[3] -
        gyrotropic_mass[1] * gyrotropic_mass[2];
    const double coeff_linear =
        -stiffness[0] * gyrotropic_mass[3] -
        stiffness[3] * gyrotropic_mass[0] +
        stiffness[1] * gyrotropic_mass[2] +
        stiffness[2] * gyrotropic_mass[1];
    const double det_k =
        stiffness[0] * stiffness[3] -
        stiffness[1] * stiffness[2];
    if (!std::isfinite(det_g) || std::abs(det_g) <= 1.0e-18) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation gyrotropic mass matrix is singular";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }

    const std::complex<double> discriminant(
        coeff_linear * coeff_linear - 4.0 * det_g * det_k,
        0.0);
    const std::complex<double> sqrt_discriminant = std::sqrt(discriminant);
    const std::complex<double> lambda_candidates[2] = {
        (-coeff_linear - sqrt_discriminant) / (2.0 * det_g),
        (-coeff_linear + sqrt_discriminant) / (2.0 * det_g),
    };
    const double shift_frequency_hz = target_shift_frequency_hz(request);
    const bool canonical_complex_lambda_representation =
        request.tiny_validation_stiffness_matrix_row_major != nullptr ||
        request.tiny_validation_mass_matrix_row_major != nullptr;
    const char *const eigenvalue_representation =
        canonical_complex_lambda_representation ?
            "canonical_complex_lambda" :
            "legacy_real_angular_frequency_diagonal";
    const char *const eigenvalue_to_frequency =
        canonical_complex_lambda_representation ?
            "map_eigenvalue(lambda, phase_convention).frequency_hz" :
            "legacy_real_angular_frequency_to_canonical_lambda_then_map_eigenvalue";
    std::complex<double> chosen_lambda(
        std::numeric_limits<double>::quiet_NaN(),
        std::numeric_limits<double>::quiet_NaN());
    double chosen_omega = std::numeric_limits<double>::quiet_NaN();
    double chosen_frequency_hz = std::numeric_limits<double>::quiet_NaN();
    double best_shift_distance = std::numeric_limits<double>::infinity();
    std::uint64_t candidate_mode_count = 0;
    for (std::complex<double> lambda_candidate : lambda_candidates) {
        if (!std::isfinite(lambda_candidate.real()) ||
            !std::isfinite(lambda_candidate.imag())) {
            continue;
        }
        const ComplexEigenvalue canonical_lambda =
            canonical_complex_lambda_representation ?
                ComplexEigenvalue{std::real(lambda_candidate), std::imag(lambda_candidate)} :
                ComplexEigenvalue{
                    0.0,
                    request.phase_convention == FrequencyDomainPhaseConvention::exp_i_omega_t ?
                        std::real(lambda_candidate) :
                        -std::real(lambda_candidate)};
        const ModeKinematics kinematics = map_eigenvalue(
            canonical_lambda,
            request.phase_convention);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        const double omega_candidate = kinematics.omega_rad_s;
        const double frequency_hz = kinematics.frequency_hz;
        ++candidate_mode_count;
        const char *target_kind = request.target_kind != nullptr ? request.target_kind : "";
        bool in_target = true;
        if (std::strcmp(target_kind, "frequency_window") == 0) {
            in_target =
                frequency_hz >= request.frequency_min_hz &&
                frequency_hz <= request.frequency_max_hz;
        }
        if (!in_target) {
            continue;
        }
        const double shift_distance = std::abs(frequency_hz - shift_frequency_hz);
        if (!std::isfinite(chosen_omega) || shift_distance < best_shift_distance) {
            best_shift_distance = shift_distance;
            chosen_lambda = lambda_candidate;
            chosen_omega = omega_candidate;
            chosen_frequency_hz = frequency_hz;
        }
    }
    if (!std::isfinite(chosen_omega)) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation found no positive-frequency mode in the requested target";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"eigenvalue_representation\":\"" +
            std::string(eigenvalue_representation) + "\","
            "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
            "\"eigenvalue_to_frequency\":\"" +
            std::string(eigenvalue_to_frequency) + "\","
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"eigenvalue_representation\":\"" +
            std::string(eigenvalue_representation) + "\","
            "\"accepted_mode_count\":0}";
        return result;
    }

    const std::complex<double> pencil[4] = {
        stiffness[0] - chosen_lambda * gyrotropic_mass[0],
        stiffness[1] - chosen_lambda * gyrotropic_mass[1],
        stiffness[2] - chosen_lambda * gyrotropic_mass[2],
        stiffness[3] - chosen_lambda * gyrotropic_mass[3],
    };
    std::complex<double> eigenvector[2] = {-pencil[1], pencil[0]};
    if (std::fmax(std::abs(eigenvector[0]), std::abs(eigenvector[1])) <= 1.0e-15) {
        eigenvector[0] = -pencil[3];
        eigenvector[1] = pencil[2];
    }
    const double eigenvector_norm = complex_vector_norm2(eigenvector);
    if (!(eigenvector_norm > 0.0) || !std::isfinite(eigenvector_norm)) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation failed to construct an eigenvector";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }
    eigenvector[0] /= eigenvector_norm;
    eigenvector[1] /= eigenvector_norm;

    const std::complex<double> k_phi[2] = {
        stiffness[0] * eigenvector[0] + stiffness[1] * eigenvector[1],
        stiffness[2] * eigenvector[0] + stiffness[3] * eigenvector[1],
    };
    const std::complex<double> g_phi[2] = {
        gyrotropic_mass[0] * eigenvector[0] + gyrotropic_mass[1] * eigenvector[1],
        gyrotropic_mass[2] * eigenvector[0] + gyrotropic_mass[3] * eigenvector[1],
    };
    const std::complex<double> residual[2] = {
        k_phi[0] - chosen_lambda * g_phi[0],
        k_phi[1] - chosen_lambda * g_phi[1],
    };
    const double residual_norm = complex_vector_norm2(residual);
    const double denom =
        complex_vector_norm2(k_phi) +
        std::abs(chosen_lambda) * complex_vector_norm2(g_phi);
    const double relative_residual =
        denom > 0.0 ? residual_norm / denom : std::numeric_limits<double>::infinity();
    if (!(relative_residual <= request.residual_tolerance)) {
        result.status = FrequencyDomainStatus::solve_error;
        result.error_message =
            "modal tiny validation found a mode but residual exceeded tolerance";
        result.diagnostics_json =
            "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"complete\":false,"
            "\"execution_lane\":\"validation\","
            "\"tiny_validation_solver\":true,"
            "\"stop_reason\":null}";
        result.diagnostics_json = with_operator_diagnostics(
            result.diagnostics_json,
            request.operator_request.operator_diagnostics_json);
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"solve_error\","
            "\"accepted_mode_count\":0}";
        return result;
    }

    std::uint64_t accepted_mode_count = 1;
    bool truncated_by_requested_count = false;
    if (is_frequency_window(request)) {
        ModalCandidate candidate{};
        candidate.frequency_hz = chosen_frequency_hz;
        candidate.relative_residual = relative_residual;
        candidate.mode = {eigenvector[0], eigenvector[1]};
        const std::vector<ModalCandidate> filtered = filter_modes_for_window(
            std::vector<ModalCandidate>{candidate},
            request.frequency_min_hz,
            request.frequency_max_hz,
            request.residual_tolerance);
        constexpr double identity_mass[4] = {
            1.0, 0.0,
            0.0, 1.0,
        };
        std::vector<ModalCandidate> deduplicated =
            deduplicate_modes_by_frequency_and_overlap(
                filtered,
                identity_mass,
                2,
                1.0e-6,
                1.0e3,
                0.90);
        if (request.requested_mode_count > 0 &&
            static_cast<int>(deduplicated.size()) > request.requested_mode_count) {
            deduplicated.resize(static_cast<std::size_t>(request.requested_mode_count));
            truncated_by_requested_count = true;
        }
        accepted_mode_count = deduplicated.size();
        if (deduplicated.empty()) {
            result.status = FrequencyDomainStatus::solve_error;
            result.error_message =
                "modal tiny validation found no accepted mode in the requested frequency window";
            result.diagnostics_json =
                "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
                "\"study_product\":\"modal_eigen\","
                "\"status\":\"solve_error\","
                "\"complete\":false,"
                "\"execution_lane\":\"validation\","
                "\"tiny_validation_solver\":true,"
                "\"stop_reason\":\"window_exhausted\",";
            result.diagnostics_json += window_diagnostics_json(
                request,
                partition,
                chosen_frequency_hz,
                relative_residual,
                0,
                false,
                false);
            result.diagnostics_json += "}";
            result.diagnostics_json = with_operator_diagnostics(
                result.diagnostics_json,
                request.operator_request.operator_diagnostics_json);
            result.result_json =
                "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                "\"study_product\":\"modal_eigen\","
                "\"status\":\"solve_error\","
                "\"accepted_mode_count\":0,"
                "\"window_completeness\":\"window_exhausted\"}";
            return result;
        }
    }

    if (cancel_requested(request)) {
        return interrupted_result(
            request,
            "native FEM modal_eigen validation solve was interrupted during shift-invert",
            "cancel_requested");
    }

    emit_progress(
        request,
        shift_frequency_hz,
        candidate_mode_count,
        accepted_mode_count,
        relative_residual);

    const std::string window_diagnostics =
        is_frequency_window(request) ?
            window_diagnostics_json(
                request,
                partition,
                chosen_frequency_hz,
                relative_residual,
                accepted_mode_count,
                false,
                truncated_by_requested_count) :
            "";
    const std::string completeness_status =
        is_frequency_window(request) ?
            window_completeness_status(partition, false, truncated_by_requested_count) :
            "";
    result.status = FrequencyDomainStatus::ok;
    result.error_message.clear();
    result.diagnostics_json =
        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"complete\":true,"
        "\"execution_lane\":\"validation\","
        "\"progress_schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"production_solver_available\":false,"
        "\"tiny_validation_solver\":true,"
        "\"algebraic_form\":\"first_order_complex\","
        "\"solver_family\":\"analytic_validation_shift_target\","
        "\"slepc_problem_type\":\"validation_not_slepc\","
        "\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, phase_convention), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"eigenvalue_representation\":\"" +
        std::string(eigenvalue_representation) + "\","
        "\"eigenvalue_to_frequency\":\"" +
        std::string(eigenvalue_to_frequency) + "\","
        "\"conjugate_pair_policy\":\"keep_positive_frequency_partner\","
        "\"requested_mode_count\":" +
        std::to_string(request.requested_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(accepted_mode_count) + ","
        "\"candidate_mode_count\":" +
        std::to_string(candidate_mode_count) +
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz) +
        ",\"outer_iteration\":1,"
        "\"linear_iteration\":1,"
        "\"relative_residual_max\":" +
        format_double(relative_residual);
    if (!window_diagnostics.empty()) {
        result.diagnostics_json += ",";
        result.diagnostics_json += window_diagnostics;
    }
    result.diagnostics_json += "}";
    result.diagnostics_json = with_operator_diagnostics(
        result.diagnostics_json,
        request.operator_request.operator_diagnostics_json);
    result.result_json =
        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
        "\"study_product\":\"modal_eigen\","
        "\"status\":\"ok\","
        "\"eigenvalue_representation\":\"" +
        std::string(eigenvalue_representation) + "\","
        "\"accepted_mode_count\":" +
        std::to_string(accepted_mode_count) + ","
        "\"frequency_hz\":" +
        format_double(chosen_frequency_hz) +
        ",\"omega_rad_s\":" +
        format_double(chosen_omega) +
        ",\"eigenvalue_real\":" +
        format_double(std::real(chosen_lambda)) +
        ",\"eigenvalue_imag\":" +
        format_double(std::imag(chosen_lambda)) + ","
        "\"relative_residual\":" +
        format_double(relative_residual) +
        ",\"shift_frequency_hz\":" +
        format_double(shift_frequency_hz);
    if (is_frequency_window(request)) {
        result.result_json += ",\"window_completeness\":\"";
        result.result_json += completeness_status;
        result.result_json += "\"";
    }
    result.result_json += "}";
    result.artifact_manifest_path.clear();
    return result;
}

} // namespace

FrequencyDomainContractResult solve_modal_eigen_contract(
    const ModalEigenRequest &request) noexcept
{
    if (!supported_frequency_domain_abi(request.abi_version) ||
        !supported_frequency_domain_abi(request.operator_request.abi_version)) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen request uses an unsupported ABI version",
            "unsupported_abi_version",
            request.operator_request.operator_diagnostics_json);
    }
    if (!valid_modal_request_enums(request)) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen request uses an unknown enum value",
            "unknown_modal_enum",
            request.operator_request.operator_diagnostics_json);
    }
    const bool wants_cartesian_delta_m =
        request.result_field_representation != ModalResultFieldRepresentation::tangent_q;
    if (wants_cartesian_delta_m &&
        (request.poisson_airbox_shared_domain_enabled == 0 ||
         request.poisson_airbox_shared_domain_payload == nullptr)) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen Cartesian delta_m output requires an accepted tangent-to-Cartesian basis",
            "missing_tangent_to_cartesian_basis",
            request.operator_request.operator_diagnostics_json);
    }
    DynamicPencilMetadata canonical_metadata{};
    char metadata_error[128]{};
    if (canonicalize_dynamic_pencil_metadata(
            magnetic_pencil_metadata(request),
            &canonical_metadata,
            metadata_error,
            sizeof(metadata_error)) != FrequencyDomainStatus::ok) {
        const std::string message =
            "native FEM modal_eigen dynamic pencil metadata is invalid: " +
            std::string(metadata_error);
        return validation_error_result(
            "modal_eigen",
            message.c_str(),
            "invalid_dynamic_pencil_metadata",
            request.operator_request.operator_diagnostics_json);
    }
    if (output_directory_required(request.write_partial_artifacts, request.output_directory)) {
        return validation_error_result(
            "modal_eigen",
            "native FEM modal_eigen write_partial_artifacts requires output_directory",
            "missing_output_directory",
            request.operator_request.operator_diagnostics_json);
    }
    if (request.tiny_validation_enabled != 0) {
        FrequencyDomainContractResult result = solve_tiny_validation_modal_problem(request);
        set_modal_execution(
            result,
            ModalExecutionTarget::validation,
            ModalSpectralTransformKind::shift_invert,
            "tiny_validation_modal_eigen");
        return result;
    }
    ModalEigenRequest effective_request = request;
    PoissonAirboxSharedDomainAssemblyResult shared_domain_assembly{};
    if (request.poisson_airbox_shared_domain_enabled != 0) {
        if (request.poisson_airbox_shared_domain_payload == nullptr) {
            return validation_error_result(
                "modal_eigen",
                "native FEM modal_eigen shared-domain payload is missing",
                "missing_shared_domain_payload",
                request.operator_request.operator_diagnostics_json);
        }
        const FrequencyDomainStatus assembly_status =
            assemble_poisson_airbox_shared_domain_payload(
                *request.poisson_airbox_shared_domain_payload,
                &shared_domain_assembly);
        if (assembly_status != FrequencyDomainStatus::ok) {
            return validation_error_result(
                "modal_eigen",
                shared_domain_assembly.error_message,
                "shared_domain_assembly_failed",
                request.operator_request.operator_diagnostics_json);
        }
        const FullmagFemModalSharedDomainPayload &payload =
            *request.poisson_airbox_shared_domain_payload;
        effective_request.poisson_airbox_block_enabled = 1;
        effective_request.poisson_airbox_q_dof_count = shared_domain_assembly.q_dof_count;
        effective_request.poisson_airbox_phi_dof_count = shared_domain_assembly.phi_dof_count;
        effective_request.poisson_airbox_a_qq_csr = shared_domain_assembly.a_qq.view();
        effective_request.poisson_airbox_a_qphi_csr = shared_domain_assembly.a_qphi.view();
        effective_request.poisson_airbox_a_phiq_csr = shared_domain_assembly.a_phiq.view();
        effective_request.poisson_airbox_a_phiphi_csr = shared_domain_assembly.p.view();
        effective_request.poisson_airbox_b_qq_csr = shared_domain_assembly.b_qq.view();
        effective_request.poisson_airbox_phi_mean_weights =
            shared_domain_assembly.phi_mean_weights.empty()
                ? nullptr
                : shared_domain_assembly.phi_mean_weights.data();
        effective_request.poisson_airbox_phi_mean_weights_count =
            shared_domain_assembly.phi_mean_weights.size();
        effective_request.poisson_airbox_periodic_mesh_certificate_schema =
            payload.mesh_certificate_schema;
        effective_request.poisson_airbox_magnetic_pair_count = payload.magnetic_pair_count;
        effective_request.poisson_airbox_airbox_pair_count = payload.airbox_pair_count;
        effective_request.poisson_airbox_outer_boundary_kind =
            shared_domain_assembly.boundary_kind;
        effective_request.poisson_airbox_robin_beta = payload.robin_beta;
        effective_request.poisson_airbox_gauge_policy = shared_domain_assembly.gauge_policy;
        effective_request.poisson_airbox_gauge_reason =
            std::strcmp(shared_domain_assembly.gauge_policy, "none") == 0
                ? "coercive_outer_boundary"
                : "pure_neumann_nullspace";
        effective_request.poisson_airbox_assembly_kind =
            shared_domain_assembly.assembly_kind;
        effective_request.poisson_airbox_target_frequency_hz =
            request.target_frequency_hz;
    }
    {
    const ModalEigenRequest &request = effective_request;
    if (request.poisson_airbox_block_enabled != 0) {
        PoissonAirboxEigenBlockProblem problem{};
        problem.q_dof_count = request.poisson_airbox_q_dof_count;
        problem.phi_dof_count = request.poisson_airbox_phi_dof_count;
        problem.A_qq = request.poisson_airbox_a_qq_csr;
        problem.A_qphi = request.poisson_airbox_a_qphi_csr;
        problem.A_phiq = request.poisson_airbox_a_phiq_csr;
        problem.A_phiphi = request.poisson_airbox_a_phiphi_csr;
        problem.B_qq = request.poisson_airbox_b_qq_csr;
        problem.phi_mean_weights = request.poisson_airbox_phi_mean_weights;
        problem.phi_mean_weights_count =
            request.poisson_airbox_phi_mean_weights_count;
        problem.target_frequency_hz =
            request.poisson_airbox_target_frequency_hz;
        problem.target_kind = request.target_kind;
        problem.frequency_min_hz = request.frequency_min_hz;
        problem.frequency_max_hz = request.frequency_max_hz;
        problem.expected_reference_frequency_hz =
            request.poisson_airbox_expected_reference_frequency_hz;
        problem.periodic_mesh_certificate_schema =
            request.poisson_airbox_periodic_mesh_certificate_schema;
        problem.magnetic_pair_count =
            request.poisson_airbox_magnetic_pair_count;
        problem.airbox_pair_count =
            request.poisson_airbox_airbox_pair_count;
        problem.outer_boundary_kind =
            request.poisson_airbox_outer_boundary_kind;
        problem.robin_beta = request.poisson_airbox_robin_beta;
        problem.gauge_policy = request.poisson_airbox_gauge_policy;
        problem.gauge_reason = request.poisson_airbox_gauge_reason;
        problem.assembly_kind = request.poisson_airbox_assembly_kind;
        problem.solver_adapter =
            request.execution_target == ModalExecutionTarget::production_gpu ?
                "k0_poisson_airbox_gpu_petsc_slepc" :
                (std::strcmp(problem.assembly_kind, "mfem_weak_form_shared_domain") == 0
                     ? "k0_poisson_airbox_cpu_schur_slepc"
                     : "k0_poisson_airbox_cpu_full_coupled_slepc");
        problem.residual_tolerance = request.residual_tolerance;
        problem.requested_mode_count =
            static_cast<std::uint32_t>(request.requested_mode_count);
        problem.max_outer_iterations =
            static_cast<std::uint32_t>(request.max_outer_iterations);
        problem.max_linear_iterations =
            static_cast<std::uint32_t>(request.max_linear_iterations);
        problem.production_shared_domain =
            request.poisson_airbox_shared_domain_enabled != 0;
        problem.cancel_user_data = request.cancel_user_data;
        problem.cancel_requested = request.cancel_requested;
        problem.progress_user_data = request.progress_user_data;
        problem.progress_callback = request.progress_callback;

        if (request.poisson_airbox_shift_invert_action_enabled != 0) {
            if (request.poisson_airbox_shift_invert_action_device != 0 &&
                request.poisson_airbox_shift_invert_action_device != 1) {
                FrequencyDomainContractResult result{};
                result.status = FrequencyDomainStatus::validation_error;
                result.error_message =
                    "Poisson-airbox shift-invert action device must be 0=cpu or 1=gpu_hidden_action";
                result.diagnostics_json =
                    "{\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
                    "\"study_product\":\"modal_eigen\","
                    "\"status\":\"validation_error\","
                    "\"reason\":\"poisson_airbox_shift_invert_action_invalid_device\"}";
                result.result_json =
                    "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                    "\"study_product\":\"modal_eigen\","
                    "\"status\":\"validation_error\"}";
                set_modal_execution(
                    result,
                    request.execution_target,
                    ModalSpectralTransformKind::shift_invert,
                    "validation_error");
                return result;
            }
            if (request.poisson_airbox_shift_invert_action_device == 1) {
                std::vector<double> out_q_real(problem.q_dof_count, 0.0);
                std::vector<double> out_q_imag(problem.q_dof_count, 0.0);
                char diagnostics_json[4096]{};
                char error_message[256]{};
                FrequencyDomainContractResult result{};
                set_modal_execution(
                    result,
                    ModalExecutionTarget::production_gpu,
                    ModalSpectralTransformKind::shift_invert,
                    "gpu_device_dense_modal_shift_invert_action_contract");
#if FULLMAG_HAS_CUDA_RUNTIME
                const int gpu_status =
                    fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action(
                        &problem,
                        request.poisson_airbox_shift_sigma_real,
                        request.poisson_airbox_shift_sigma_imag,
                        request.poisson_airbox_shift_action_vector_real,
                        request.poisson_airbox_shift_action_vector_imag,
                        request.poisson_airbox_shift_action_vector_count,
                        out_q_real.data(),
                        out_q_imag.data(),
                        problem.q_dof_count,
                        diagnostics_json,
                        sizeof(diagnostics_json),
                        error_message,
                        sizeof(error_message));
                result.status =
                    gpu_status == 0 ? FrequencyDomainStatus::ok : FrequencyDomainStatus::solve_error;
                result.error_message = error_message;
                result.diagnostics_json = diagnostics_json;
#else
                result.status = FrequencyDomainStatus::unavailable;
                result.error_message =
                    "PA-G3 GPU modal shift-invert action requires CUDA runtime support";
                result.diagnostics_json =
                    "{\"schema_version\":\"gpu_modal_shift_invert_action.v1\","
                    "\"status\":\"unavailable\","
                    "\"study_product\":\"modal_eigen\","
                    "\"lane\":\"gpu_poisson_airbox_k0\","
                    "\"reason\":\"cuda_runtime_unavailable\","
                    "\"fallback_used\":false,"
                    "\"operator_family\":\"full_modal_shift_invert\","
                    "\"algebraic_action\":\"(A - sigma B)^-1 Bv\","
                    "\"rhs_family\":\"modal_mass_times_vector\","
                    "\"full_modal_shift_invert_claim\":false,"
                    "\"frequency_response_proxy\":false}";
#endif

                std::string artifact_path_string;
                if (result.status == FrequencyDomainStatus::ok &&
                    request.write_partial_artifacts != 0) {
                    const std::filesystem::path artifact_path =
                        std::filesystem::path(request.output_directory) /
                        "eigen" / "diagnostics" /
                        "gpu_modal_shift_invert_action.v1.json";
                    std::string artifact_error;
                    if (!write_text_file(
                            artifact_path,
                            result.diagnostics_json.c_str(),
                            artifact_error)) {
                        result.status = FrequencyDomainStatus::artifact_error;
                        result.error_message = artifact_error;
                        result.diagnostics_json =
                            "{\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
                            "\"study_product\":\"modal_eigen\","
                            "\"status\":\"artifact_error\","
                            "\"reason\":\"gpu_modal_shift_invert_action_artifact_write_failed\"}";
                        result.result_json =
                            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                            "\"study_product\":\"modal_eigen\","
                            "\"status\":\"artifact_error\"}";
                        result.artifact_manifest_path.clear();
                        return result;
                    }
                    artifact_path_string = artifact_path.string();
                    result.artifact_manifest_path = artifact_path_string;
                }

                const char *status_text =
                    result.status == FrequencyDomainStatus::ok ? "ok" :
                    (result.status == FrequencyDomainStatus::artifact_error ?
                         "artifact_error" :
                         (result.status == FrequencyDomainStatus::unavailable ?
                              "unavailable" :
                              "solve_error"));
                result.result_json =
                    "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                    "\"study_product\":\"modal_eigen\","
                    "\"status\":\"" +
                    std::string(status_text) +
                    "\",\"solver_adapter\":\"gpu_device_dense_modal_shift_invert_action_contract\","
                    "\"execution_lane\":\"gpu_operator_host_modal_eigen_compatibility\","
                    "\"demag_kind\":\"periodic_airbox_k0\","
                    "\"operator_family\":\"full_modal_shift_invert\","
                    "\"algebraic_action\":\"(A - sigma B)^-1 Bv\","
                    "\"rhs_family\":\"modal_mass_times_vector\","
                    "\"full_modal_shift_invert_claim\":" +
                    std::string(result.status == FrequencyDomainStatus::ok ? "true" : "false") +
                    ",\"frequency_response_proxy\":false,"
                    "\"gpu_device_resident_modal_eigensolver\":false,"
                    "\"artifact_manifest_path\":\"" +
                    escape_json_string(artifact_path_string.c_str()) +
                    "\"}";
                return result;
            }

            std::vector<double> out_q_real(problem.q_dof_count, 0.0);
            std::vector<double> out_q_imag(problem.q_dof_count, 0.0);
            PoissonAirboxModalShiftInvertActionResult action_result{};
            const FrequencyDomainStatus status =
                apply_poisson_airbox_modal_shift_invert_action_cpu_reference(
                    problem,
                    request.poisson_airbox_shift_sigma_real,
                    request.poisson_airbox_shift_sigma_imag,
                    request.poisson_airbox_shift_action_vector_real,
                    request.poisson_airbox_shift_action_vector_imag,
                    request.poisson_airbox_shift_action_vector_count,
                    out_q_real.data(),
                    out_q_imag.data(),
                    problem.q_dof_count,
                    &action_result);

            FrequencyDomainContractResult result{};
            set_modal_execution(
                result,
                ModalExecutionTarget::production_cpu,
                ModalSpectralTransformKind::shift_invert,
                "k0_poisson_airbox_cpu_full_coupled_shift_invert_reference");
            result.status = status;
            result.error_message = action_result.error_message;
            result.diagnostics_json = action_result.diagnostics_json;

            std::string artifact_path_string;
            if (status == FrequencyDomainStatus::ok &&
                request.write_partial_artifacts != 0) {
                const std::filesystem::path artifact_path =
                    std::filesystem::path(request.output_directory) /
                    "eigen" / "diagnostics" /
                    "poisson_airbox_modal_shift_invert_action.v1.json";
                std::string artifact_error;
                if (!write_text_file(
                        artifact_path,
                        action_result.diagnostics_json,
                        artifact_error)) {
                    result.status = FrequencyDomainStatus::artifact_error;
                    result.error_message = artifact_error;
                    result.diagnostics_json =
                        "{\"schema_version\":\"frequency_domain_contract_diagnostics.v1\","
                        "\"study_product\":\"modal_eigen\","
                        "\"status\":\"artifact_error\","
                        "\"reason\":\"poisson_airbox_shift_invert_action_artifact_write_failed\"}";
                    result.result_json =
                        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                        "\"study_product\":\"modal_eigen\","
                        "\"status\":\"artifact_error\"}";
                    result.artifact_manifest_path.clear();
                    return result;
                }
                artifact_path_string = artifact_path.string();
                result.artifact_manifest_path = artifact_path_string;
            }

            const char *status_text =
                result.status == FrequencyDomainStatus::ok ? "ok" :
                (result.status == FrequencyDomainStatus::artifact_error ?
                     "artifact_error" :
                     "validation_error");
            result.result_json =
                "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                "\"study_product\":\"modal_eigen\","
                "\"status\":\"" +
                std::string(status_text) +
                "\",\"solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_shift_invert_reference\","
                "\"demag_kind\":\"periodic_airbox_k0\","
                "\"operator_family\":\"full_modal_shift_invert\","
                "\"algebraic_action\":\"(A - sigma B)^-1 Bv\","
                "\"full_modal_shift_invert_claim\":" +
                std::string(action_result.full_modal_shift_invert_claim ? "true" : "false") +
                ",\"q_dof_count\":" +
                std::to_string(action_result.q_dof_count) +
                ",\"phi_dof_count\":" +
                std::to_string(action_result.phi_dof_count) +
                ",\"augmented_dof_count\":" +
                std::to_string(action_result.augmented_dof_count) +
                ",\"shifted_system_relative_residual\":" +
                format_double(action_result.shifted_system_relative_residual) +
                ",\"artifact_manifest_path\":\"" +
                escape_json_string(artifact_path_string.c_str()) +
                "\"}";
            return result;
        }

        PoissonAirboxModalEigenResult poisson_result{};
        FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_FEM_WITH_SLEPC
        if (request.execution_target == ModalExecutionTarget::production_gpu) {
            status = solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
                problem,
                &poisson_result);
        } else {
            status = solve_poisson_airbox_modal_eigen_cpu_slepc(
                problem,
                &poisson_result);
        }
#elif FULLMAG_HAS_CUDA_RUNTIME
        if (request.execution_target == ModalExecutionTarget::production_gpu) {
            poisson_result.status = FrequencyDomainStatus::unavailable;
            poisson_result.q_dof_count = problem.q_dof_count;
            poisson_result.phi_dof_count = problem.phi_dof_count;
            poisson_result.augmented_dof_count = problem.q_dof_count + problem.phi_dof_count;
            std::strncpy(
                poisson_result.error_message,
                "GPU modal K0 requires PETSc/SLEPc support",
                sizeof(poisson_result.error_message) - 1u);
            std::snprintf(
                poisson_result.diagnostics_json,
                sizeof(poisson_result.diagnostics_json),
                "{\"schema_version\":\"poisson_airbox_modal_eigen_gpu.v1\","
                "\"status\":\"unavailable\","
                "\"reason\":\"slepc_unavailable\","
                "\"execution_lane\":\"production_gpu\","
                "\"cpu_fallback\":\"disabled\",\"fallback_used\":false}");
            status = poisson_result.status;
        } else {
            status = solve_poisson_airbox_modal_eigen_cpu_slepc(
                problem,
                &poisson_result);
        }
#else
        if (request.execution_target == ModalExecutionTarget::production_gpu) {
            poisson_result.status = FrequencyDomainStatus::unavailable;
            poisson_result.q_dof_count = problem.q_dof_count;
            poisson_result.phi_dof_count = problem.phi_dof_count;
            poisson_result.augmented_dof_count = problem.q_dof_count + problem.phi_dof_count;
            std::strncpy(
                poisson_result.error_message,
                "GPU modal K0 requires CUDA runtime support",
                sizeof(poisson_result.error_message) - 1u);
            std::snprintf(
                poisson_result.diagnostics_json,
                sizeof(poisson_result.diagnostics_json),
                "{\"schema_version\":\"poisson_airbox_modal_eigen_gpu.v1\","
                "\"status\":\"unavailable\","
                "\"reason\":\"cuda_runtime_unavailable\","
                "\"execution_lane\":\"production_gpu\","
                "\"cpu_fallback\":\"disabled\",\"fallback_used\":false}");
            status = poisson_result.status;
        } else {
            status = solve_poisson_airbox_modal_eigen_cpu_slepc(
                problem,
                &poisson_result);
        }
#endif
        poisson_result.q_layout_interleaved_node_component =
            problem.assembly_kind != nullptr &&
            std::strcmp(problem.assembly_kind, "mfem_weak_form_shared_domain") == 0;
        const std::uint64_t augmented_phi_dof_count =
            poisson_result.augmented_dof_count >= poisson_result.q_dof_count
                ? (poisson_result.augmented_dof_count -
                   poisson_result.q_dof_count)
                : 0;

        FrequencyDomainContractResult result{};
        result.status = status;
        result.error_message = poisson_result.error_message;
        result.diagnostics_json = poisson_result.diagnostics_json;
        const char *modal_status_text =
            status == FrequencyDomainStatus::ok ? "ok" :
            status == FrequencyDomainStatus::interrupted ? "interrupted" :
            status == FrequencyDomainStatus::unavailable ? "unavailable" :
            status == FrequencyDomainStatus::validation_error ? "validation_error" :
            status == FrequencyDomainStatus::operator_error ? "operator_error" :
            status == FrequencyDomainStatus::artifact_error ? "artifact_error" :
            "solve_error";
        const bool requested_gpu = request.execution_target == ModalExecutionTarget::production_gpu;
        const char *requested_execution = requested_gpu ? "production_gpu" : "production_cpu";
        const char *requested_solver_adapter = requested_gpu
            ? "k0_poisson_airbox_gpu_petsc_slepc"
            : "k0_poisson_airbox_cpu_full_coupled_slepc";
        const bool resolves_to_cpu_schur =
            !requested_gpu &&
            (std::strcmp(problem.assembly_kind, "mfem_weak_form_shared_domain") == 0 ||
             (std::strcmp(problem.solver_adapter, "k0_poisson_airbox_cpu_full_coupled_slepc") == 0 &&
              std::strcmp(problem.gauge_policy, "mean_zero_augmented") == 0));
        const char *resolved_solver_adapter = requested_gpu || resolves_to_cpu_schur
            ? (requested_gpu
                   ? "k0_poisson_airbox_gpu_petsc_slepc"
                   : "k0_poisson_airbox_cpu_schur_slepc")
            : "k0_poisson_airbox_cpu_full_coupled_slepc";
        set_modal_execution(
            result,
            requested_gpu ? ModalExecutionTarget::production_gpu
                          : ModalExecutionTarget::production_cpu,
            request.spectral_transform_kind,
            resolved_solver_adapter);
        if (!accepted_modal_mode_vectors_valid(poisson_result)) {
            result.status = FrequencyDomainStatus::operator_error;
            result.error_message =
                "native FEM modal_eigen accepted mode vector is shorter than q+phi+gauge dimensions";
            result.diagnostics_json =
                "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
                "\"study_product\":\"modal_eigen\","
                "\"status\":\"operator_error\","
                "\"reason\":\"accepted_mode_vector_short\"}";
            result.result_json =
                "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                "\"study_product\":\"modal_eigen\","
                "\"status\":\"operator_error\","
                "\"accepted_mode_count\":0,\"modes\":[]}";
            return result;
        }
        result.result_json =
            "{\"schema_version\":\"frequency_domain_modal_result.v1\","
            "\"study_product\":\"modal_eigen\","
            "\"status\":\"" +
            std::string(modal_status_text) +
            "\",\"complete\":" +
            std::string(status == FrequencyDomainStatus::ok ? "true" : "false") +
            ","
            "\"requested_execution\":\"" +
            std::string(requested_execution) +
            "\",\"resolved_execution\":\"" +
            std::string(requested_execution) +
            "\","
            "\"requested_solver_adapter\":\"" +
            std::string(requested_solver_adapter) +
            "\","
            "\"solver_adapter\":\"" +
            std::string(resolved_solver_adapter) +
            "\","
            "\"execution_lane\":\"" +
            std::string(requested_gpu ?
                            "production_gpu" :
                            "production_cpu") +
            "\","
            "\"demag_kind\":\"periodic_airbox_k0\","
            "\"accepted_mode_count\":" +
            std::to_string(poisson_result.accepted_mode_count) +
            ",\"q_dof_count\":" +
            std::to_string(poisson_result.q_dof_count) +
            ",\"phi_dof_count\":" +
            std::to_string(poisson_result.phi_dof_count) +
            ",\"augmented_phi_dof_count\":" +
            std::to_string(augmented_phi_dof_count) +
            ",\"frequency_hz\":" +
            std::to_string(poisson_result.frequency_hz) +
            ",\"omega_rad_s\":" +
            std::to_string(poisson_result.omega_rad_s) +
            ",\"poisson_constraint_relative_residual\":" +
            std::to_string(poisson_result.poisson_constraint_relative_residual) +
            ",\"relative_reference_frequency_error\":" +
            std::to_string(poisson_result.relative_reference_frequency_error) +
            ",\"periodic_mesh_certificate\":{\"schema_version\":\"" +
            std::string(request.poisson_airbox_periodic_mesh_certificate_schema != nullptr
                            ? request.poisson_airbox_periodic_mesh_certificate_schema
                            : "periodic_mesh_certificate.v5") +
            "\",\"magnetic_pair_count\":" +
            std::to_string(poisson_result.magnetic_pair_count) +
            ",\"airbox_pair_count\":" +
            std::to_string(poisson_result.airbox_pair_count) +
            "},\"modes\":" +
            format_poisson_airbox_modes_json(poisson_result) +
            "}";
        if ((status == FrequencyDomainStatus::ok ||
             status == FrequencyDomainStatus::interrupted) &&
            !poisson_result.accepted_modes.empty()) {
            result.modal_eigen.q_dof_count = poisson_result.q_dof_count;
            result.modal_eigen.phi_dof_count = poisson_result.phi_dof_count;
            result.modal_eigen.mode_lambda.reserve(poisson_result.accepted_modes.size());
            result.modal_eigen.mode_residuals.reserve(poisson_result.accepted_modes.size());
            result.modal_eigen.mode_cluster_ids.reserve(poisson_result.accepted_modes.size());
            result.modal_eigen.mode_q_complex.reserve(
                poisson_result.accepted_modes.size() * poisson_result.q_dof_count);
            result.modal_eigen.mode_phi_complex.reserve(
                poisson_result.accepted_modes.size() * poisson_result.phi_dof_count);
            for (std::size_t mode_index = 0;
                 mode_index < poisson_result.accepted_modes.size();
                 ++mode_index) {
                const PoissonAirboxModalEigenResult::AcceptedMode &mode =
                    poisson_result.accepted_modes[mode_index];
                result.modal_eigen.mode_lambda.emplace_back(
                    mode.eigenvalue_real, mode.eigenvalue_imag);
                result.modal_eigen.mode_residuals.push_back(mode.relative_residual);
                result.modal_eigen.mode_cluster_ids.push_back(
                    static_cast<std::uint64_t>(mode_index));
                if (mode.full_vector.size() < required_modal_mode_vector_count(poisson_result)) {
                    result.modal_eigen = ModalEigenTypedResult{};
                    result.status = FrequencyDomainStatus::operator_error;
                    result.error_message =
                        "native FEM modal_eigen accepted mode vector is shorter than q+phi+gauge dimensions";
                    result.diagnostics_json =
                        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
                        "\"study_product\":\"modal_eigen\","
                        "\"status\":\"operator_error\","
                        "\"reason\":\"accepted_mode_vector_short\"}";
                    result.result_json =
                        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                        "\"study_product\":\"modal_eigen\","
                        "\"status\":\"operator_error\","
                        "\"accepted_mode_count\":0}";
                    return result;
                }
                result.modal_eigen.mode_q_complex.insert(
                    result.modal_eigen.mode_q_complex.end(),
                    mode.full_vector.begin(),
                    mode.full_vector.begin() +
                        static_cast<std::ptrdiff_t>(poisson_result.q_dof_count));
                result.modal_eigen.mode_phi_complex.insert(
                    result.modal_eigen.mode_phi_complex.end(),
                    mode.full_vector.begin() +
                        static_cast<std::ptrdiff_t>(poisson_result.q_dof_count),
                    mode.full_vector.begin() + static_cast<std::ptrdiff_t>(
                        poisson_result.q_dof_count + poisson_result.phi_dof_count));
            }
            if (request.poisson_airbox_shared_domain_enabled != 0) {
                std::string cartesian_error;
                if (!append_shared_domain_cartesian_modes(
                        *request.poisson_airbox_shared_domain_payload,
                        poisson_result,
                        &result.modal_eigen,
                        cartesian_error)) {
                    result.modal_eigen = ModalEigenTypedResult{};
                    result.status = FrequencyDomainStatus::operator_error;
                    result.error_message = cartesian_error;
                    result.diagnostics_json =
                        "{\"schema_version\":\"frequency_domain_modal_diagnostics.v1\","
                        "\"study_product\":\"modal_eigen\","
                        "\"status\":\"operator_error\","
                        "\"reason\":\"shared_domain_cartesian_mode_reconstruction_failed\"}";
                    result.result_json =
                        "{\"schema_version\":\"frequency_domain_modal_result.v1\","
                        "\"study_product\":\"modal_eigen\","
                        "\"status\":\"operator_error\","
                        "\"accepted_mode_count\":0}";
                    return result;
                }
            }
        }
        return result;
    }
    FrequencyDomainContractResult result = production_cpu_modal_eigen_unavailable(request);
    // Magnetic MFEM payloads consume and publish this pencil identity.  The
    // descriptor-Poisson branch above returns before this point deliberately.
    result.diagnostics_json = with_magnetic_pencil_digest(
        std::move(result.diagnostics_json), request, "linearized_dynamic_pencil_digest");
    result.result_json = with_magnetic_pencil_digest(
        std::move(result.result_json), request, "linearized_dynamic_pencil_digest");
    const ModalExecutionTarget unavailable_target =
        request.execution_target == ModalExecutionTarget::production_gpu
            ? ModalExecutionTarget::production_gpu
            : request.execution_target == ModalExecutionTarget::production_cpu
                ? ModalExecutionTarget::production_cpu
                : ModalExecutionTarget::auto_select;
    set_modal_execution(
        result,
        unavailable_target,
        request.spectral_transform_kind,
        unavailable_target == ModalExecutionTarget::production_gpu
            ? "production_gpu_modal_eigen_unavailable"
            : "production_cpu_modal_eigen_unavailable");
    return result;
    }
}

FrequencyDomainContractResult solve_driven_response_contract(
    const DrivenResponseContractRequest &request) noexcept
{
    if (!supported_frequency_domain_abi(request.abi_version) ||
        !supported_frequency_domain_abi(request.operator_request.abi_version)) {
        return validation_error_result(
            "driven_response",
            "native FEM driven_response request uses an unsupported ABI version",
            "unsupported_abi_version",
            request.operator_request.operator_diagnostics_json);
    }
    if (output_directory_required(request.write_partial_artifacts, request.output_directory)) {
        return validation_error_result(
            "driven_response",
            "native FEM driven_response write_partial_artifacts requires output_directory",
            "missing_output_directory",
            request.operator_request.operator_diagnostics_json);
    }

    return validation_error_result(
        "driven_response",
        "native FEM driven_response legacy contract does not carry the FEM operator payload required for solving; use DrivenFrequencyResponseSolveRequest v10",
        "legacy_driven_response_contract_without_operator_payload",
        request.operator_request.operator_diagnostics_json);
}

} // namespace fullmag::fem::frequency_domain
