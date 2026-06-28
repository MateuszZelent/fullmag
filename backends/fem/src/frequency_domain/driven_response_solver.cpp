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
};

struct MfemProductionGpuOperatorAdapter {
    const DrivenFrequencyResponseSolveRequest *request = nullptr;
    std::vector<double> stiffness_tangent;
    std::vector<double> mass_tangent;
    std::vector<double> projected_tangent;
    std::vector<std::uint64_t> static_periodic_representative_node;
    std::vector<std::uint64_t> static_periodic_representative_count;
    std::vector<double> static_periodic_projection_workspace;
};

struct PeriodicAirboxPhiGaugeDiagnostics {
    bool phi_nullspace_detected = false;
    bool phi_gauge_constraint_applied = false;
    const char *phi_gauge_policy = "not_required";
};

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
        apply_mfem_production_cpu_operator(adapter, in, error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::memcpy(
        out,
        adapter->mass_tangent.data(),
        static_cast<std::size_t>(adapter->request->solve_request.operator_request.tangent_dof_count * sizeof(double)));
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
    double angular_frequency_rad_per_s) noexcept
{
    double drive_norm_squared = 0.0;
    double projected_real = 0.0;
    double projected_imag = 0.0;
    for (std::uint64_t dof = 0; dof < tangent_dof_count; ++dof) {
        const double drive_re = drive_real == nullptr ? 0.0 : drive_real[dof];
        const double drive_im = drive_imag == nullptr ? 0.0 : drive_imag[dof];
        const double response_re = response_real == nullptr ? 0.0 : response_real[dof];
        const double response_im = response_imag == nullptr ? 0.0 : response_imag[dof];
        drive_norm_squared += drive_re * drive_re + drive_im * drive_im;
        projected_real += response_re * drive_re + response_im * drive_im;
        projected_imag += response_im * drive_re - response_re * drive_im;
    }

    const bool has_drive = drive_norm_squared > 0.0 && std::isfinite(drive_norm_squared);
    const double susceptibility_real = has_drive ? projected_real / drive_norm_squared : 0.0;
    const double susceptibility_imag = has_drive ? projected_imag / drive_norm_squared : 0.0;
    const double dof_scale = tangent_dof_count == 0 ? 1.0 : static_cast<double>(tangent_dof_count);
    const double absorbed_power_density = has_drive
        ? 0.5 * std::fabs(angular_frequency_rad_per_s) * std::fabs(projected_imag) / dof_scale
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
    out.susceptibility_provenance =
        "{\"kind\":\"drive_projected_scalar\","
        "\"basis\":\"local_tangent_drive\","
        "\"component_pair_count\":1,"
        "\"full_tensor\":false,"
        "\"normalization\":\"sum(response*conj(drive))/sum(abs(drive)^2)\"}";
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
        problem.demag_tangent_matrix_row_major != nullptr;
}

const char *mfem_demag_tangent_operator_source(
    const DrivenFrequencyResponseMfemValidationProblem &problem) noexcept
{
    if (problem.apply_demag_tangent != nullptr) {
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
    const char *residual_source = production_lane ? "matrix_free_gmres" : "dense_block_real";
    const char *assembled_flag = production_lane ? "false" : "true";
    const char *dense_flag = production_lane ? "false" : "true";
    const char *production_solver_flag = production_lane ? "true" : "false";
    const char *response_cancel_requested_path_json =
        complete ? "null" : "\"response/cancel_requested.v1.json\"";
    const char *response_cancel_requested_resource_json =
        complete
            ? "null"
            : "\"/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1\"";
    const char *production_native_available = production_lane ? "true" : "false";
    const char *validation_artifact = production_lane ? "false" : "true";
    const double excitation_phase_rad = drive_global_phase_rad(
        request.mfem_validation_problem.drive_real,
        request.mfem_validation_problem.drive_imag,
        request.solve_request.operator_request.tangent_dof_count);
    const bool static_periodic_artifact =
        request.mfem_validation_problem.static_periodic_node_pair_count > 0 &&
        request.mfem_validation_problem.static_periodic_node_pairs != nullptr;
    const char *periodic_pairs_artifact_json =
        static_periodic_artifact ? "\"mesh/periodic_pairs.v1.json\"" : "null";
    const char *spin_wave_bc_kind =
        static_periodic_artifact ? "static_periodic" : "open";
    const char *demag_tangent_operator_source =
        mfem_demag_tangent_operator_source(request.mfem_validation_problem);
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
            angular_frequency_rad_per_s);

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
            "\"susceptibility_tensor\":%s,"
            "\"susceptibility_tensor_provenance\":%s,"
            "\"absorbed_power_density\":%.17g,"
            "\"absorbed_power_density_provenance\":{\"kind\":\"drive_projected_absorption_proxy\","
            "\"basis\":\"local_tangent_drive\","
            "\"normalization\":\"0.5*abs(omega)*abs(imag(sum(response*conj(drive))))/tangent_dof_count\","
            "\"full_power_density\":false},"
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
            observables.susceptibility_tensor.c_str(),
            observables.susceptibility_provenance.c_str(),
            observables.absorbed_power_density,
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
        "\"production_solver\":%s},"
        "\"physics\":{\"analysis_family\":\"frequency_domain\","
        "\"llg_gamma0_si\":%.17g,"
        "\"llg_alpha\":%.17g,"
        "\"phase_convention\":\"%s\","
        "\"frequency_units\":\"Hz\","
        "\"field_units\":\"A_per_m\","
        "\"normalization\":\"linear_response_tangent\","
        "\"spin_wave_bc\":{\"kind\":\"%s\"},"
        "\"periodic_or_floquet\":%s},"
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
        "\"demag_tangent_operator_source\":\"%s\","
        "\"static_periodic_projection\":%s,"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"point_count\":%llu,"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"max_abs_response\":%.17g},"
        "\"capabilities\":{\"validation_solver_available\":true,"
        "\"production_solver_available\":%s,"
        "\"production_native_solver_available\":%s,"
        "\"validation_artifact\":%s,"
        "\"dynamic_demag_k_available\":false,"
        "\"floquet_response_available\":false,"
        "\"gpu_available\":%s}}",
        revision,
        stage_id,
        complete ? "ready" : "interrupted",
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
        production_solver_flag,
        request.solve_request.operator_request.gamma0,
        request.solve_request.operator_request.alpha,
        phase_convention_to_string(request.phase_convention),
        spin_wave_bc_kind,
        static_periodic_artifact ? "true" : "false",
        response_cancel_requested_path_json,
        periodic_pairs_artifact_json,
        frequency_point_paths_json.c_str(),
        response_cancel_requested_resource_json,
        field_payload_resources_json.c_str(),
        requested_execution_lane,
        requested_execution_lane,
        assembled_flag,
        production_lane ? "true" : "false",
        demag_tangent_operator_source,
        static_periodic_artifact ? "true" : "false",
        static_cast<unsigned long long>(
            request.mfem_validation_problem.static_periodic_node_pair_count),
        artifact_static_periodic_frame_mismatch,
        artifact_static_periodic_drive_mismatch,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
        validation_result.max_abs_response,
        production_solver_flag,
        production_native_available,
        validation_artifact,
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
        !append_format(
        progress_json,
        error_message,
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
        validation_result.completed_frequency_count > 0 ? "true" : "false") ||
        !append_format(
        diagnostics_json,
        error_message,
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"requested_execution_lane\":\"%s\","
        "\"resolved_execution_lane\":\"%s\","
        "\"validation_fallback_used\":false,"
        "\"assembled_mfem_operator_solver\":%s,"
        "\"dense_block_real_solver\":%s,"
        "\"matrix_free_solver\":%s,"
        "\"demag_tangent_operator_source\":\"%s\","
        "\"krylov_solver\":\"%s\","
        "\"static_periodic_projection\":%s,"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"completed_frequency_point_count\":%llu,"
        "\"max_abs_response\":%.17g,"
        "\"residual_l2_norm\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g}",
        complete ? "ready" : "interrupted",
        complete ? "true" : "false",
        requested_execution_lane,
        requested_execution_lane,
        assembled_flag,
        dense_flag,
        production_lane ? "true" : "false",
        demag_tangent_operator_source,
        production_lane ? "gmres" : "none",
        static_periodic_artifact ? "true" : "false",
        static_cast<unsigned long long>(
            request.mfem_validation_problem.static_periodic_node_pair_count),
        artifact_static_periodic_frame_mismatch,
        artifact_static_periodic_drive_mismatch,
        static_cast<unsigned long long>(validation_result.completed_frequency_count),
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
    if (static_periodic_artifact) {
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
    status = write_text_artifact(diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    status = write_text_artifact(solver_diagnostics, diagnostics_json.c_str(), error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (static_periodic_artifact) {
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
            angular_frequency_rad_per_s);
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
                    "\"absorbed_power_density_provenance\":{\"kind\":\"drive_projected_absorption_proxy\","
                    "\"basis\":\"local_tangent_drive\","
                    "\"normalization\":\"0.5*abs(omega)*abs(imag(sum(response*conj(drive))))/tangent_dof_count\","
                    "\"full_power_density\":false},"
                    "\"residual_l2_norm\":%.17g,"
                    "\"relative_residual_l2_norm\":%.17g,"
                    "\"residual_source\":\"%s\","
                    "\"tangent_leakage\":%s,"
                    "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
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
                    residual_l2_norm[frequency_index],
                    relative_residual_l2_norm[frequency_index],
                    residual_source,
                    observables.tangent_leakage.c_str(),
                    excitation_phase_rad,
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
                    "\"absorbed_power_density_provenance\":{\"kind\":\"drive_projected_absorption_proxy\","
                    "\"basis\":\"local_tangent_drive\","
                    "\"normalization\":\"0.5*abs(omega)*abs(imag(sum(response*conj(drive))))/tangent_dof_count\","
                    "\"full_power_density\":false},"
                    "\"residual_l2_norm\":%.17g,"
                    "\"relative_residual_l2_norm\":%.17g,"
                    "\"residual_source\":\"%s\","
                    "\"tangent_leakage\":%s,"
                    "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
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
                    residual_l2_norm[frequency_index],
                    relative_residual_l2_norm[frequency_index],
                    residual_source,
                    observables.tangent_leakage.c_str(),
                    excitation_phase_rad,
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
                "\"absorbed_power_density_provenance\":{\"kind\":\"drive_projected_absorption_proxy\","
                "\"basis\":\"local_tangent_drive\","
                "\"normalization\":\"0.5*abs(omega)*abs(imag(sum(response*conj(drive))))/tangent_dof_count\","
                "\"full_power_density\":false},"
                "\"residual_l2_norm\":%.17g,"
                "\"relative_residual_l2_norm\":%.17g,"
                "\"residual_source\":\"%s\","
                "\"tangent_leakage\":%s,"
                "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":%.17g},"
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
                static_cast<unsigned long long>(validation_result.response_dof_count),
                observables.susceptibility_tensor.c_str(),
                observables.susceptibility_provenance.c_str(),
                observables.absorbed_power_density,
                residual_l2_norm[frequency_index],
                relative_residual_l2_norm[frequency_index],
                residual_source,
                observables.tangent_leakage.c_str(),
                excitation_phase_rad,
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
    if (magnetic_periodic) {
        const bool has_static_pairs =
            request.mfem_validation_problem.static_periodic_node_pair_count > 0 &&
            request.mfem_validation_problem.static_periodic_node_pairs != nullptr;
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
                "\"pairs\":[",
                unsupported_reason_json.c_str(),
                has_static_pairs
                    ? static_cast<unsigned long long>(
                          request.mfem_validation_problem.static_periodic_node_pair_count)
                    : 0ull,
                has_static_pairs
                    ? static_cast<unsigned long long>(
                          request.mfem_validation_problem.static_periodic_node_pair_count * 2)
                    : 0ull)) {
            return FrequencyDomainStatus::artifact_error;
        }
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
                        pair_index == 0 ? "" : ",",
                        static_cast<unsigned long long>(pair_index),
                        static_cast<unsigned long long>(node_a),
                        static_cast<unsigned long long>(node_b),
                        static_cast<unsigned long long>(node_a),
                        static_cast<unsigned long long>(node_b),
                        unsupported_reason_json.c_str())) {
                    return FrequencyDomainStatus::artifact_error;
                }
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
        static_cast<unsigned long long>(coupled_complex_dof_count)) ||
        !append_format(
        progress_json,
        error_message,
        "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"state\":\"unavailable\","
        "\"total_frequency_points\":%llu,"
        "\"completed_frequency_points\":0,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"partial_artifacts_available\":%s,"
        "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\"}",
        static_cast<unsigned long long>(request.solve_request.frequency_count),
        static_cast<unsigned long long>(written_frequency_point_artifacts),
        partial_artifacts_available) ||
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
        "\"unsupported_reason\":%s,"
        "\"validation_fallback_used\":false,"
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
        unsupported_reason_json.c_str(),
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
                "%s{\"real\":%.17g,\"imag\":%.17g}",
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
    char manifest[256]{};
    char diagnostics_dir[256]{};
    char solver_diagnostics[256]{};
    char progress[256]{};
    char mesh_dir[256]{};
    char periodic_pairs[256]{};
    if (std::snprintf(frequency_domain_dir, sizeof(frequency_domain_dir), "%s/frequency_domain", request.output_directory) < 0 ||
        std::snprintf(response_dir, sizeof(response_dir), "%s/response", request.output_directory) < 0 ||
        std::snprintf(frequency_points_dir, sizeof(frequency_points_dir), "%s/frequency_points", response_dir) < 0 ||
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
    if (!append_format(
            periodic_pairs_json,
            error_message,
            "{\"schema_version\":\"periodic_pairs.v1\","
            "\"source\":\"native_fem_frequency_domain_coupled_block\","
            "\"validation_status\":\"metadata_only\","
            "\"pair_count\":%llu,"
            "\"paired_node_count\":0,"
            "\"unpaired_source_count\":0,"
            "\"unpaired_destination_count\":0,"
            "\"tolerance_m\":0.0,"
            "\"max_translation_residual_m\":0.0,"
            "\"residual_diagnostics\":{\"max_translation_residual_m\":0.0},"
            "\"magnetic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_node_pair_count\":%llu,"
            "\"pairs\":[]}",
            static_cast<unsigned long long>(
                request.magnetic_periodic_constraint_set_count +
                request.magnetostatic_periodic_constraint_set_count),
            static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
            static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
            static_cast<unsigned long long>(
                request.periodic_airbox_magnetostatic_periodic_node_pair_count)) ||
        !append_format(
            diagnostics_json,
            error_message,
            "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
            "\"status\":\"ok\","
            "\"complete\":true,"
            "\"solver_engine\":\"native_fem_mfem_driven_response\","
            "\"solver_kind\":\"%s\","
            "\"requested_execution_lane\":\"production_cpu\","
            "\"production_solver_requested\":true,"
            "\"production_solver_available\":true,"
            "\"validation_fallback_used\":false,"
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"requested_magnetic_bc\":\"periodic\","
            "\"resolved_magnetic_bc\":\"periodic\","
            "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
            "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
            "\"magnetic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_constraint_set_count\":%llu,"
            "\"delta_m_tangent_dof_count\":%llu,"
            "\"delta_phi_dof_count\":%llu,"
            "\"magnetostatic_periodic_node_pair_count\":%llu,"
            "\"coupled_complex_dof_count\":%llu,"
            "\"phi_nullspace_detected\":%s,"
            "\"phi_gauge_policy\":\"%s\","
            "\"phi_gauge_constraint_applied\":%s,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"max_abs_response\":%.17g,"
            "\"relative_residual_l2_norm\":%.17g}",
            solver_kind,
            operator_source,
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
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            validation_result.max_abs_response,
            validation_result.relative_residual_l2_norm) ||
        !append_format(
            progress_json,
            error_message,
            "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
            "\"status\":\"ok\","
            "\"complete\":true,"
            "\"state\":\"completed\","
            "\"total_frequency_points\":%llu,"
            "\"completed_frequency_points\":%llu,"
            "\"written_frequency_point_artifacts\":%llu,"
            "\"partial_artifacts_available\":false,"
            "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\"}",
            static_cast<unsigned long long>(request.solve_request.frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count)) ||
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
            "\"status\":\"ok\","
            "\"complete\":true,"
            "\"resolved_execution\":{\"backend_engine_id\":\"native_fem_mfem\","
            "\"engine\":\"native_fem_mfem_frequency_domain\","
            "\"native_backend\":\"native_mfem\","
            "\"reference_or_production\":\"production\","
            "\"solver_model\":\"%s\","
            "\"requested_execution_lane\":\"production_cpu\","
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\"},"
            "\"physics\":{\"analysis_family\":\"frequency_domain\","
            "\"phase_convention\":\"%s\","
            "\"requested_spin_wave_bc\":\"periodic\","
            "\"resolved_spin_wave_bc\":\"periodic\","
            "\"requested_magnetic_bc\":\"periodic\","
            "\"resolved_magnetic_bc\":\"periodic\","
            "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
            "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
            "\"magnetic_periodic_constraint_set_count\":%llu,"
            "\"magnetostatic_periodic_constraint_set_count\":%llu,"
            "\"delta_m_tangent_dof_count\":%llu,"
            "\"delta_phi_dof_count\":%llu,"
            "\"magnetostatic_periodic_node_pair_count\":%llu,"
            "\"coupled_complex_dof_count\":%llu,"
            "\"phi_nullspace_detected\":%s,"
            "\"phi_gauge_policy\":\"%s\","
            "\"phi_gauge_constraint_applied\":%s},"
            "\"artifacts\":{\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\","
            "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\","
            "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\","
            "\"response_progress_v1_path\":\"response/progress.v1.json\","
            "\"frequency_point_paths\":%s},"
            "\"diagnostics\":{\"requested_frequency_count\":%llu,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu},"
            "\"capabilities\":{\"production_solver_available\":true,"
            "\"periodic_airbox_coupled_block_solver\":true,"
            "\"mfem_coupled_block_assembly\":false,"
            "\"dynamic_demag_operator_source\":\"%s\","
            "\"dynamic_demag_k_available\":false,"
            "\"floquet_response_available\":false,"
            "\"gpu_available\":false}}",
            revision,
            solver_model,
            operator_source,
            phase_convention_to_string(request.phase_convention),
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
            frequency_point_paths_json.c_str(),
            static_cast<unsigned long long>(request.solve_request.frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            static_cast<unsigned long long>(validation_result.completed_frequency_count),
            operator_source)) {
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
    status = ensure_directory(diagnostics_dir, error_message);
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
         frequency_index < validation_result.completed_frequency_count;
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
            std::snprintf(error_message, 128, "failed to format periodic-airbox coupled block frequency point artifact path");
            return FrequencyDomainStatus::artifact_error;
        }

        const std::uint64_t response_offset = frequency_index * coupled_complex_dof_count;
        std::string delta_m_complex;
        std::string delta_phi_complex;
        if (!append_complex_response_array(
                delta_m_complex,
                error_message,
                response_real,
                response_imag,
                response_offset,
                delta_m_tangent_dof_count) ||
            !append_complex_response_array(
                delta_phi_complex,
                error_message,
                response_real,
                response_imag,
                response_offset + delta_m_tangent_dof_count,
                delta_phi_dof_count)) {
            return FrequencyDomainStatus::artifact_error;
        }

        std::string frequency_point_json;
        if (!append_format(
                frequency_point_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_point.v1\","
                "\"frequency_index\":%llu,"
                "\"frequency_hz\":%.17g,"
                "\"status\":\"ok\","
                "\"complete\":true,"
                "\"requested_magnetic_bc\":\"periodic\","
                "\"resolved_magnetic_bc\":\"periodic\","
                "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"coupled_complex_dof_count\":%llu,"
                "\"m_complex\":%s,"
                "\"residual_l2_norm\":%.17g,"
                "\"relative_residual_l2_norm\":%.17g,"
                "\"demag_contribution\":{\"status\":\"solved\","
                "\"solver_model\":\"%s\","
                "\"operator_source\":\"%s\","
                "\"mfem_coupled_block_assembly\":false,"
                "\"phi_nullspace_detected\":%s,"
                "\"phi_gauge_policy\":\"%s\","
                "\"phi_gauge_constraint_applied\":%s,"
                "\"delta_phi_complex\":%s,"
                "\"h_demag_complex\":null,"
                "\"energy_density\":null}}",
                static_cast<unsigned long long>(frequency_index),
                request.solve_request.frequencies_hz[frequency_index],
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(coupled_complex_dof_count),
                delta_m_complex.c_str(),
                residual_l2_norm[frequency_index],
                relative_residual_l2_norm[frequency_index],
                frequency_point_solver_model,
                operator_source,
                phi_gauge_diagnostics.phi_nullspace_detected ? "true" : "false",
                phi_gauge_diagnostics.phi_gauge_policy,
                phi_gauge_diagnostics.phi_gauge_constraint_applied ? "true" : "false",
                delta_phi_complex.c_str())) {
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

    char diagnostics_json[768]{};
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
            1.0e-10,
            256,
            32,
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
        artifact_result.residual_l2_norm = production_result.residual_l2_norm;
        artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
        char diagnostics_json[1024]{};
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
            "\"krylov_solver\":\"gmres\","
            "\"assembled_mfem_operator_solver\":false,"
            "\"static_periodic_projection\":%s,"
            "\"static_periodic_node_pair_count\":%llu,"
            "\"static_periodic_frame_max_mismatch\":%.17g,"
            "\"static_periodic_drive_max_mismatch\":%.17g,"
            "\"partial_artifacts_available\":%s,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":%llu}",
            demag_tangent_operator_source,
            static_periodic_projection ? "true" : "false",
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
        char diagnostics_json[1024]{};
        char result_json[512]{};
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
            "\"krylov_solver\":\"gmres\","
            "\"assembled_mfem_operator_solver\":false,"
            "\"static_periodic_projection\":%s,"
            "\"static_periodic_node_pair_count\":%llu,"
            "\"static_periodic_frame_max_mismatch\":%.17g,"
            "\"static_periodic_drive_max_mismatch\":%.17g,"
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":0,"
            "\"tangent_dof_count\":%llu,"
            "\"total_iteration_count\":%llu,"
            "\"max_iterations_for_frequency\":%llu,"
            "\"relative_residual_l2_norm\":%.17g}",
            status_to_string(solve_status),
            demag_tangent_operator_source,
            static_periodic_projection ? "true" : "false",
            static_cast<unsigned long long>(problem.static_periodic_node_pair_count),
            static_periodic_frame_mismatch,
            static_periodic_drive_max_mismatch,
            static_cast<unsigned long long>(production_result.completed_frequency_count),
            static_cast<unsigned long long>(tangent_dof_count),
            static_cast<unsigned long long>(production_result.total_iteration_count),
            static_cast<unsigned long long>(production_result.max_iterations_for_frequency),
            production_result.relative_residual_l2_norm);
        const int result_written = std::snprintf(
            result_json,
            sizeof(result_json),
            "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
            "\"status\":\"%s\","
            "\"completed_frequency_count\":%llu,"
            "\"written_frequency_point_artifacts\":0,"
            "\"requested_execution_lane\":\"production_cpu\","
            "\"partial_artifacts_available\":false,"
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
                "MFEM production CPU failure result JSON exceeded fixed buffer",
                status_diagnostics_json(FrequencyDomainStatus::artifact_error),
                status_result_json(FrequencyDomainStatus::artifact_error),
                "");
            return result.status;
        }
        result.status = solve_status;
        assign_result_strings(
            result,
            production_result.error_message,
            diagnostics_json,
            result_json,
            "");
        return result.status;
    }

    MfemDrivenResponseValidationResult artifact_result{};
    artifact_result.completed_frequency_count = production_result.completed_frequency_count;
    artifact_result.response_dof_count = production_result.response_dof_count;
    artifact_result.response_frequency_count = production_result.completed_frequency_count;
    artifact_result.max_frequency_hz = production_result.max_frequency_hz;
    artifact_result.max_abs_response = production_result.max_abs_response;
    artifact_result.residual_l2_norm = production_result.residual_l2_norm;
    artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
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

    char diagnostics_json[1792]{};
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
        "\"krylov_solver\":\"gmres\","
        "\"assembled_mfem_operator_solver\":false,"
        "\"static_periodic_projection\":%s,"
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
        static_periodic_projection ? "true" : "false",
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
    char result_json[512]{};
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
    if (problem.descriptor.demag_enabled ||
        request.solve_request.operator_request.demag_kind != FrequencyDomainDemagKind::none ||
        problem.apply_demag_tangent != nullptr ||
        problem.demag_tangent_matrix_row_major != nullptr) {
        return solve_mfem_production_gpu_unavailable(
            request,
            result,
            "dynamic_demag_gpu_unsupported",
            "native FEM frequency-domain production GPU does not implement dynamic demag");
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
    adapter.projected_tangent.resize(static_cast<std::size_t>(tangent_dof_count));
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
        adapter.static_periodic_representative_node.empty()) {
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
            1.0e-10,
            256,
            32,
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
            "\"dense_block_real_solver\":false,"
            "\"krylov_solver\":\"gmres\","
            "\"completed_frequency_point_count\":%llu,"
            "\"written_frequency_point_artifacts\":0}",
            status_to_string(solve_status),
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
    artifact_result.residual_l2_norm = production_result.residual_l2_norm;
    artifact_result.relative_residual_l2_norm = production_result.relative_residual_l2_norm;
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
    char diagnostics_json[1024]{};
    char result_json[1024]{};
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
        "\"operator_terms_included\":%s,"
        "\"static_periodic_projection\":%s,"
        "\"static_periodic_node_pair_count\":%llu,"
        "\"static_periodic_frame_max_mismatch\":%.17g,"
        "\"static_periodic_drive_max_mismatch\":%.17g,"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"tangent_dof_count\":%llu,"
        "\"total_iteration_count\":%llu,"
        "\"max_iterations_for_frequency\":%llu,"
        "\"relative_residual_l2_norm\":%.17g}",
        operator_terms.c_str(),
        static_periodic_projection ? "true" : "false",
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
        "\"validation_fallback_used\":false,"
        "\"artifact_manifest_path\":\"%s\"}",
        static_cast<unsigned long long>(production_result.completed_frequency_count),
        static_cast<unsigned long long>(written_artifacts),
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
    const char *message) noexcept;

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

    const char *operator_source = has_dense_operator
        ? "explicit_coupled_block_payload"
        : "matrix_free_coupled_block_provider";
    const char *artifact_revision = has_dense_operator
        ? "periodic-airbox-explicit-coupled-block-v1"
        : "periodic-airbox-matrix-free-coupled-block-v1";
    const char *solver_kind = has_dense_operator
        ? "periodic_airbox_explicit_coupled_block"
        : "periodic_airbox_matrix_free_coupled_block";
    const char *solver_model = has_dense_operator
        ? "periodic_airbox_explicit_coupled_block"
        : "periodic_airbox_matrix_free_coupled_block";
    const char *frequency_point_solver_model = has_dense_operator
        ? "explicit_periodic_airbox_coupled_block"
        : "matrix_free_periodic_airbox_coupled_block";

    PeriodicAirboxPhiGaugeDiagnostics phi_gauge_diagnostics{};
    std::vector<double> gauged_stiffness_matrix;
    std::vector<double> gauged_mass_matrix;
    std::vector<double> gauged_drive_real;
    std::vector<double> gauged_drive_imag;
    const double *stiffness_matrix = problem.stiffness_matrix_row_major;
    const double *mass_matrix = problem.mass_matrix_row_major;
    const double *drive_real = problem.drive_real;
    const double *drive_imag = problem.drive_imag;
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
        validation_status = solve_production_cpu_driven_response(
            ProductionCpuDrivenResponseProblem{
                coupled_complex_dof_count,
                request.solve_request.frequencies_hz,
                request.solve_request.frequency_count,
                drive_real,
                problem.apply_stiffness,
                problem.apply_mass,
                problem.operator_user_data,
                1.0e-10,
                256,
                32,
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

    char diagnostics_json[1536]{};
    char result_json[512]{};
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
        "\"periodic_airbox_coupled_block_solver\":true,"
        "\"mfem_coupled_block_assembly\":false,"
        "\"dynamic_demag_operator_source\":\"%s\","
        "\"requested_magnetic_bc\":\"periodic\","
        "\"resolved_magnetic_bc\":\"periodic\","
        "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"delta_m_tangent_dof_count\":%llu,"
        "\"delta_phi_dof_count\":%llu,"
        "\"coupled_complex_dof_count\":%llu,"
        "\"phi_nullspace_detected\":%s,"
        "\"phi_gauge_policy\":\"%s\","
        "\"phi_gauge_constraint_applied\":%s,"
        "\"completed_frequency_point_count\":%llu,"
        "\"written_frequency_point_artifacts\":%llu,"
        "\"max_abs_response\":%.17g,"
        "\"relative_residual_l2_norm\":%.17g}",
        operator_source,
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(delta_m_tangent_dof_count),
        static_cast<unsigned long long>(delta_phi_dof_count),
        static_cast<unsigned long long>(coupled_complex_dof_count),
        phi_gauge_diagnostics.phi_nullspace_detected ? "true" : "false",
        phi_gauge_diagnostics.phi_gauge_policy,
        phi_gauge_diagnostics.phi_gauge_constraint_applied ? "true" : "false",
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
    if (diagnostics_written < 0 ||
        result_written < 0 ||
        static_cast<std::size_t>(diagnostics_written) >= sizeof(diagnostics_json) ||
        static_cast<std::size_t>(result_written) >= sizeof(result_json)) {
        result.status = FrequencyDomainStatus::artifact_error;
        assign_result_strings(
            result,
            "periodic-airbox coupled block result JSON exceeded fixed buffer",
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
        diagnostics_json,
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

    char diagnostics_json[1024]{};
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
    const char *message) noexcept
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
                "\"requested_magnetic_bc\":\"periodic\","
                "\"resolved_magnetic_bc\":\"periodic\","
                "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
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
                "\"written_frequency_point_artifacts\":0}",
                validation_error,
                execution_lane_to_string(request.execution_lane),
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                static_cast<unsigned long long>(coupled_complex_dof_count)) ||
            !append_format(
                manifest_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_manifest.v1\","
                "\"analysis_family\":\"magnetic_frequency_domain\","
                "\"study_product\":\"driven_response\","
                "\"revision\":\"periodic-airbox-validation-error-v1\","
                "\"created_at\":\"1970-01-01T00:00:00Z\","
                "\"session_id\":\"native-validation\","
                "\"run_id\":\"native-validation\","
                "\"stage_id\":\"frequency-response-production\","
                "\"stage_kind\":\"frequency_response\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"validation_error\":\"%s\","
                "\"physics\":{\"requested_spin_wave_bc\":\"periodic\","
                "\"resolved_spin_wave_bc\":\"periodic\","
                "\"requested_magnetic_bc\":\"periodic\","
                "\"resolved_magnetic_bc\":\"periodic\","
                "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
                "\"magnetic_periodic_constraint_set_count\":%llu,"
                "\"magnetostatic_periodic_constraint_set_count\":%llu,"
                "\"delta_m_tangent_dof_count\":%llu,"
                "\"delta_phi_dof_count\":%llu,"
                "\"magnetostatic_periodic_node_pair_count\":%llu,"
                "\"coupled_complex_dof_count\":%llu},"
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
                validation_error,
                static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
                static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
                static_cast<unsigned long long>(delta_m_tangent_dof_count),
                static_cast<unsigned long long>(delta_phi_dof_count),
                static_cast<unsigned long long>(
                    request.periodic_airbox_magnetostatic_periodic_node_pair_count),
                static_cast<unsigned long long>(coupled_complex_dof_count),
                static_cast<unsigned long long>(request.solve_request.frequency_count)) ||
            !append_format(
                progress_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"state\":\"validation_error\","
                "\"total_frequency_points\":%llu,"
                "\"completed_frequency_points\":0,"
                "\"written_frequency_point_artifacts\":0,"
                "\"partial_artifacts_available\":true,"
                "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\"}",
                static_cast<unsigned long long>(request.solve_request.frequency_count))) {
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

    char diagnostics_json[1024]{};
    char result_json[512]{};
    const int diagnostics_written = std::snprintf(
        diagnostics_json,
        sizeof(diagnostics_json),
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"validation_error\","
        "\"complete\":false,"
        "\"validation_error\":\"%s\","
        "\"requested_magnetic_bc\":\"periodic\","
        "\"resolved_magnetic_bc\":\"periodic\","
        "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\","
        "\"magnetic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_constraint_set_count\":%llu,"
        "\"magnetostatic_periodic_node_pair_count\":%llu,"
        "\"periodic_airbox_coupled_block_solver\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"completed_frequency_point_count\":0}",
        validation_error,
        static_cast<unsigned long long>(request.magnetic_periodic_constraint_set_count),
        static_cast<unsigned long long>(request.magnetostatic_periodic_constraint_set_count),
        static_cast<unsigned long long>(
            request.periodic_airbox_magnetostatic_periodic_node_pair_count));
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

struct FloquetPhaseConstraintValidation {
    const char *validation_error = "";
    const char *error_message = "";
    double max_frame_mismatch = 0.0;
    double max_drive_mismatch = 0.0;
};

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
                "\"floquet_tangent_frame_max_mismatch\":%.17g,"
                "\"floquet_drive_max_mismatch\":%.17g,"
                "\"production_solver_available\":false,"
                "\"validation_fallback_used\":false,"
                "\"dense_block_real_solver\":false,"
                "\"completed_frequency_point_count\":0,"
                "\"written_frequency_point_artifacts\":0}",
                validation.validation_error,
                execution_lane_to_string(request.execution_lane),
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
                "\"floquet_tangent_frame_max_mismatch\":%.17g,"
                "\"floquet_drive_max_mismatch\":%.17g},"
                "\"capabilities\":{\"production_solver_available\":false,"
                "\"validation_fallback_used\":false,"
                "\"dynamic_demag_k_available\":false,"
                "\"floquet_response_available\":false}}",
                validation.validation_error,
                static_cast<unsigned long long>(request.floquet_periodic_pair_count),
                static_cast<unsigned long long>(request.solve_request.frequency_count),
                validation.max_frame_mismatch,
                validation.max_drive_mismatch) ||
            !append_format(
                progress_json,
                error_message,
                "{\"schema_version\":\"frequency_domain_sweep_progress.v1\","
                "\"status\":\"validation_error\","
                "\"complete\":false,"
                "\"state\":\"validation_error\","
                "\"total_frequency_points\":%llu,"
                "\"completed_frequency_points\":0,"
                "\"written_frequency_point_artifacts\":0,"
                "\"partial_artifacts_available\":true,"
                "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\"}",
                static_cast<unsigned long long>(request.solve_request.frequency_count))) {
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
        "\"floquet_tangent_frame_max_mismatch\":%.17g,"
        "\"floquet_drive_max_mismatch\":%.17g,"
        "\"production_solver_available\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"completed_frequency_point_count\":0}",
        validation.validation_error,
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
    DrivenFrequencyResponseSolveResult &result) noexcept
{
    constexpr const char *message =
        "native FEM driven frequency response does not implement Floquet/Bloch nonzero-k solve";
    constexpr const char *diagnostics_json =
        "{\"schema_version\":\"frequency_domain_response_diagnostics.v1\","
        "\"solver_engine\":\"native_fem_mfem_driven_response\","
        "\"status\":\"unavailable\","
        "\"complete\":false,"
        "\"unsupported_reason\":\"floquet_bloch_nonzero_k\","
        "\"production_solver_available\":false,"
        "\"validation_fallback_used\":false,"
        "\"dense_block_real_solver\":false,"
        "\"completed_frequency_point_count\":0}";
    constexpr const char *result_json =
        "{\"schema_version\":\"frequency_domain_driven_response_result.v1\","
        "\"status\":\"unavailable\","
        "\"completed_frequency_count\":0,"
        "\"written_frequency_point_artifacts\":0,"
        "\"unsupported_reason\":\"floquet_bloch_nonzero_k\","
        "\"artifact_manifest_path\":\"\"}";
    result.status = FrequencyDomainStatus::unavailable;
    assign_result_strings(result, message, diagnostics_json, result_json, "");
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

    if (driven_response_request_has_nonzero_floquet_metadata(request)) {
        return solve_floquet_nonzero_k_unavailable(*out_result);
    }

    if (request.requires_periodic_airbox_dynamic_demag &&
        request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) {
        return solve_mfem_production_gpu_unavailable(
            request,
            *out_result,
            "periodic_airbox_dynamic_demag_gpu_unsupported",
            "native FEM frequency-domain production GPU does not implement periodic-airbox dynamic demag");
    }

    if (request.requires_periodic_airbox_dynamic_demag) {
        if (request.magnetic_periodic_constraint_set_count == 0 ||
            request.magnetostatic_periodic_constraint_set_count == 0) {
            return solve_periodic_airbox_missing_constraint_sets(request, *out_result);
        }
        if (request.periodic_airbox_delta_phi_dof_count == 0) {
            return solve_periodic_airbox_missing_delta_phi_dofs(request, *out_result);
        }
        if (request.periodic_airbox_magnetostatic_periodic_node_pair_count == 0 ||
            request.periodic_airbox_magnetostatic_periodic_node_pairs == nullptr) {
            return solve_periodic_airbox_missing_magnetostatic_periodic_node_pairs(
                request,
                *out_result);
        }
        if (request.periodic_airbox_coupled_block_problem.enabled) {
            return solve_periodic_airbox_dynamic_demag_coupled_block(request, *out_result);
        }
        return solve_periodic_airbox_dynamic_demag_unavailable(request, *out_result);
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

    if (request.execution_lane == DrivenFrequencyResponseExecutionLane::production_cpu) {
        return solve_mfem_production_cpu_problem(request, *out_result);
    }

    if (request.execution_lane == DrivenFrequencyResponseExecutionLane::production_gpu) {
        return solve_mfem_production_gpu_problem(request, *out_result);
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
