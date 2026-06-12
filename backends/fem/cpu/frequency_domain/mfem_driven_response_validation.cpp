#include "cpu/frequency_domain/mfem_driven_response_validation.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr std::uint64_t kMaxValidationTangentDofs = 16;
constexpr std::uint64_t kMaxValidationNodes = kMaxValidationTangentDofs / 2;

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

bool layout_matches_descriptor(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout) noexcept
{
    return layout.node_count == descriptor.node_count &&
        layout.full_dof_count == descriptor.full_dof_count &&
        layout.tangent_dof_count == descriptor.tangent_dof_count &&
        layout.tangent_components_per_node == 2 &&
        layout.tangent_stride == 2;
}

} // namespace

FrequencyDomainStatus solve_mfem_driven_response_validation_problem(
    const MfemDrivenResponseValidationProblem &problem,
    MfemDrivenResponseValidationResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }

    *out_result = MfemDrivenResponseValidationResult{};
    const std::uint64_t tangent_dof_count = problem.descriptor.tangent_dof_count;
    if (tangent_dof_count == 0 || tangent_dof_count > kMaxValidationTangentDofs) {
        copy_error(out_result->error_message, "MFEM driven response validation supports only small tangent spaces");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.descriptor.node_count == 0 || problem.descriptor.node_count > kMaxValidationNodes) {
        copy_error(out_result->error_message, "MFEM driven response validation supports only small node counts");
        return FrequencyDomainStatus::validation_error;
    }
    if (!layout_matches_descriptor(problem.descriptor, problem.layout)) {
        copy_error(out_result->error_message, "MFEM driven response validation layout does not match descriptor");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.nodes == nullptr ||
        problem.frequencies_hz == nullptr ||
        problem.frequency_count == 0 ||
        problem.drive_real == nullptr) {
        copy_error(out_result->error_message, "MFEM driven response validation requires nodes, frequencies, and drive");
        return FrequencyDomainStatus::validation_error;
    }

    double stiffness_matrix[kMaxValidationTangentDofs * kMaxValidationTangentDofs]{};
    double mass_matrix[kMaxValidationTangentDofs * kMaxValidationTangentDofs]{};
    double basis[kMaxValidationTangentDofs]{};
    double stiffness_column[kMaxValidationTangentDofs]{};
    double mass_column[kMaxValidationTangentDofs]{};
    TangentOperatorLocalBlock zeeman_blocks[kMaxValidationNodes]{};
    double exchange_workspace[kMaxValidationTangentDofs]{};
    double zeeman_workspace[kMaxValidationTangentDofs]{};
    double effective_field_workspace[kMaxValidationTangentDofs]{};

    for (std::uint64_t column = 0; column < tangent_dof_count; ++column) {
        std::fill(basis, basis + tangent_dof_count, 0.0);
        std::fill(stiffness_column, stiffness_column + tangent_dof_count, 0.0);
        std::fill(mass_column, mass_column + tangent_dof_count, 0.0);
        basis[column] = 1.0;
        MfemLinearizedOperatorDiagnostics operator_diagnostics{};
        const FrequencyDomainStatus operator_status = apply_mfem_linearized_cpu_operator(
            problem.descriptor,
            problem.layout,
            problem.nodes,
            problem.exchange_edges,
            problem.exchange_edge_count,
            problem.h_ext_a_per_m,
            problem.gamma0,
            problem.alpha,
            MfemLinearizedOperatorWorkspace{
                zeeman_blocks,
                exchange_workspace,
                zeeman_workspace,
                effective_field_workspace,
            },
            basis,
            stiffness_column,
            mass_column,
            &operator_diagnostics);
        if (operator_status != FrequencyDomainStatus::ok) {
            copy_error(out_result->error_message, operator_diagnostics.error_message);
            return operator_status;
        }

        for (std::uint64_t row = 0; row < tangent_dof_count; ++row) {
            const double stiffness_value = stiffness_column[row];
            const double mass_value = mass_column[row];
            stiffness_matrix[row * tangent_dof_count + column] = stiffness_value;
            mass_matrix[row * tangent_dof_count + column] = mass_value;
            out_result->max_abs_stiffness_matrix = std::max(
                out_result->max_abs_stiffness_matrix,
                std::abs(stiffness_value));
            out_result->max_abs_mass_matrix = std::max(
                out_result->max_abs_mass_matrix,
                std::abs(mass_value));
        }
    }

    DenseDrivenResponseValidationResult dense_result{};
    const FrequencyDomainStatus dense_status = solve_dense_driven_response_validation_problem(
        DenseDrivenResponseValidationProblem{
            tangent_dof_count,
            problem.frequencies_hz,
            problem.frequency_count,
            stiffness_matrix,
            mass_matrix,
            nullptr,
            nullptr,
            problem.drive_real,
            problem.out_response_real,
            problem.out_response_imag,
            problem.response_capacity,
            problem.out_residual_l2_norm,
            problem.out_relative_residual_l2_norm,
            problem.residual_capacity,
            problem.cancel_requested,
            problem.cancel_user_data,
        },
        &dense_result);
    if (dense_status != FrequencyDomainStatus::ok &&
        dense_status != FrequencyDomainStatus::interrupted) {
        copy_error(out_result->error_message, dense_result.error_message);
        return dense_status;
    }

    out_result->completed_frequency_count = dense_result.completed_frequency_count;
    out_result->response_dof_count = dense_result.response_dof_count;
    out_result->response_frequency_count = dense_result.response_frequency_count;
    out_result->max_frequency_hz = dense_result.max_frequency_hz;
    out_result->max_abs_response = dense_result.max_abs_response;
    out_result->residual_l2_norm = dense_result.residual_l2_norm;
    out_result->relative_residual_l2_norm = dense_result.relative_residual_l2_norm;
    if (dense_status == FrequencyDomainStatus::interrupted) {
        copy_error(out_result->error_message, dense_result.error_message);
    }
    return dense_status;
}

} // namespace fullmag::fem::frequency_domain
