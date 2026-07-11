#include "cpu/frequency_domain/mfem_modal_operator_payload.hpp"
#include "frequency_domain/canonical_digest.hpp"
#include "frequency_domain/linearized_dynamic_pencil.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

void copy_text(char *out, std::size_t capacity, const char *message) noexcept
{
    if (out == nullptr || capacity == 0) {
        return;
    }
    std::strncpy(out, message != nullptr ? message : "", capacity - 1);
    out[capacity - 1] = '\0';
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

bool checked_square(std::uint64_t value, std::uint64_t &out) noexcept
{
    if (value != 0 &&
        value > std::numeric_limits<std::uint64_t>::max() / value) {
        return false;
    }
    out = value * value;
    return true;
}

std::uint64_t count_dense_csr_entries(
    const double *matrix,
    std::uint64_t row_count,
    std::uint64_t column_count,
    double drop_tolerance) noexcept
{
    if (matrix == nullptr) {
        return 0;
    }
    std::uint64_t count = 0;
    const double tolerance = std::max(0.0, drop_tolerance);
    for (std::uint64_t row = 0; row < row_count; ++row) {
        for (std::uint64_t column = 0; column < column_count; ++column) {
            if (std::abs(matrix[row * column_count + column]) > tolerance) {
                ++count;
            }
        }
    }
    return count;
}

bool csr_output_has_capacity(
    const MfemModalCsrOutputBuffer &buffer,
    std::uint64_t row_count,
    std::uint64_t nnz) noexcept
{
    return buffer.row_offsets != nullptr &&
        buffer.column_indices != nullptr &&
        buffer.values != nullptr &&
        buffer.row_offsets_capacity >= row_count + 1u &&
        buffer.column_indices_capacity >= nnz &&
        buffer.values_capacity >= nnz &&
        row_count <= std::numeric_limits<std::uint32_t>::max() &&
        nnz <= std::numeric_limits<std::uint32_t>::max();
}

void write_dense_csr(
    const double *matrix,
    std::uint64_t row_count,
    std::uint64_t column_count,
    double drop_tolerance,
    const MfemModalCsrOutputBuffer &buffer) noexcept
{
    const double tolerance = std::max(0.0, drop_tolerance);
    std::uint64_t cursor = 0;
    buffer.row_offsets[0] = 0;
    for (std::uint64_t row = 0; row < row_count; ++row) {
        for (std::uint64_t column = 0; column < column_count; ++column) {
            const double value = matrix[row * column_count + column];
            if (std::abs(value) <= tolerance) {
                continue;
            }
            buffer.column_indices[cursor] = static_cast<std::uint32_t>(column);
            buffer.values[cursor] = value;
            ++cursor;
        }
        buffer.row_offsets[row + 1u] = static_cast<std::uint32_t>(cursor);
    }
}

} // namespace

FrequencyDomainStatus assemble_mfem_modal_dense_operator_payload(
    const MfemModalDenseOperatorPayloadProblem &problem,
    MfemModalDenseOperatorPayloadResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }

    *out_result = MfemModalDenseOperatorPayloadResult{};
    copy_text(
        out_result->payload_kind,
        sizeof(out_result->payload_kind),
        "dense_linearized_mfem_operator");
    copy_text(
        out_result->algebraic_form,
        sizeof(out_result->algebraic_form),
        "first_order_complex");

    const std::uint64_t tangent_dof_count = problem.descriptor.tangent_dof_count;
    out_result->tangent_dof_count = tangent_dof_count;
    std::uint64_t matrix_entry_count = 0;
    if (tangent_dof_count == 0 || !checked_square(tangent_dof_count, matrix_entry_count)) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            "MFEM modal dense payload requires a finite non-zero tangent space");
        return FrequencyDomainStatus::validation_error;
    }
    out_result->matrix_entry_count = matrix_entry_count;
    if (!layout_matches_descriptor(problem.descriptor, problem.layout)) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            "MFEM modal dense payload layout does not match descriptor");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.nodes == nullptr ||
        problem.tangent_lumped_mass == nullptr ||
        problem.out_dynamic_matrix_row_major == nullptr ||
        problem.out_dynamic_mass_matrix_row_major == nullptr ||
        problem.out_tangent_mass_matrix_row_major == nullptr ||
        problem.matrix_capacity < matrix_entry_count) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            "MFEM modal dense payload requires tangent frame, lumped mass, and output matrices");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.descriptor.demag_enabled &&
        problem.descriptor.demag_kind != FrequencyDomainDemagKind::none &&
        (problem.demag_tangent_matrix_row_major == nullptr ||
            problem.demag_tangent_matrix_value_count != matrix_entry_count)) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            "MFEM modal dense payload requires a square dynamic-demag tangent matrix");
        return FrequencyDomainStatus::validation_error;
    }

    std::fill(
        problem.out_dynamic_matrix_row_major,
        problem.out_dynamic_matrix_row_major + matrix_entry_count,
        0.0);
    std::fill(
        problem.out_dynamic_mass_matrix_row_major,
        problem.out_dynamic_mass_matrix_row_major + matrix_entry_count,
        0.0);
    std::fill(
        problem.out_tangent_mass_matrix_row_major,
        problem.out_tangent_mass_matrix_row_major + matrix_entry_count,
        0.0);

    std::vector<double> basis(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> dynamic_column(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> dynamic_mass_column(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<TangentOperatorLocalBlock> zeeman_blocks(
        static_cast<std::size_t>(problem.descriptor.node_count));
    std::vector<TangentOperatorLocalBlock> anisotropy_blocks(
        static_cast<std::size_t>(problem.descriptor.node_count));
    std::vector<double> exchange_workspace(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> zeeman_workspace(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> anisotropy_workspace(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> effective_field_workspace(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> demag_workspace(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> dmi_workspace(static_cast<std::size_t>(tangent_dof_count), 0.0);
    std::vector<double> dmi_delta_xyz(static_cast<std::size_t>(problem.descriptor.node_count * 3), 0.0);
    std::vector<double> dmi_residual_xyz(static_cast<std::size_t>(problem.descriptor.node_count * 3), 0.0);
    std::vector<double> dmi_field_xyz(static_cast<std::size_t>(problem.descriptor.node_count * 3), 0.0);

    for (std::uint64_t column = 0; column < tangent_dof_count; ++column) {
        std::fill(basis.begin(), basis.end(), 0.0);
        std::fill(dynamic_column.begin(), dynamic_column.end(), 0.0);
        std::fill(dynamic_mass_column.begin(), dynamic_mass_column.end(), 0.0);
        basis[static_cast<std::size_t>(column)] = 1.0;
        if (problem.descriptor.demag_enabled &&
            problem.descriptor.demag_kind != FrequencyDomainDemagKind::none) {
            for (std::uint64_t row = 0; row < tangent_dof_count; ++row) {
                double value = 0.0;
                for (std::uint64_t input = 0; input < tangent_dof_count; ++input) {
                    value += problem.demag_tangent_matrix_row_major[
                        row * tangent_dof_count + input] * basis[static_cast<std::size_t>(input)];
                }
                demag_workspace[static_cast<std::size_t>(row)] = value;
            }
        }

        MfemLinearizedOperatorDiagnostics operator_diagnostics{};
        const FrequencyDomainStatus operator_status = apply_mfem_linearized_cpu_pencil(
            problem.descriptor,
            problem.layout,
            problem.nodes,
            problem.exchange_edges,
            problem.exchange_edge_count,
            problem.h_ext_a_per_m,
            problem.uniaxial_anisotropy_axis,
            problem.uniaxial_anisotropy_field_a_per_m,
            problem.alpha_per_node,
            problem.gamma0,
            problem.alpha,
            MfemLinearizedOperatorWorkspace{
                zeeman_blocks.data(),
                anisotropy_blocks.data(),
                exchange_workspace.data(),
                zeeman_workspace.data(),
                anisotropy_workspace.data(),
                effective_field_workspace.data(),
                nullptr,
                dmi_workspace.data(),
                problem.dmi_elements,
                problem.dmi_element_count,
                problem.dmi_lumped_mass,
                problem.dmi_ms_field,
                problem.dmi_uniform_ms,
                dmi_delta_xyz.data(),
                dmi_residual_xyz.data(),
                dmi_field_xyz.data(),
                problem.descriptor.demag_enabled &&
                    problem.descriptor.demag_kind != FrequencyDomainDemagKind::none ?
                    demag_workspace.data() :
                    nullptr,
            },
            basis.data(),
            dynamic_column.data(),
            dynamic_mass_column.data(),
            &operator_diagnostics);
        if (operator_status != FrequencyDomainStatus::ok) {
            copy_text(
                out_result->error_message,
                sizeof(out_result->error_message),
                operator_diagnostics.error_message);
            return operator_status;
        }

        for (std::uint64_t row = 0; row < tangent_dof_count; ++row) {
            // Preserve the public legacy S/M payload while materializing it
            // from the canonical L/B_alpha JVP action.
            const double dynamic_value = -dynamic_column[static_cast<std::size_t>(row)];
            const double mass_value = -dynamic_mass_column[static_cast<std::size_t>(row)];
            const double tangent_mass_value = row == column ?
                problem.tangent_lumped_mass[static_cast<std::size_t>(
                    column / problem.layout.tangent_stride)] :
                0.0;
            problem.out_dynamic_matrix_row_major[row * tangent_dof_count + column] =
                dynamic_value;
            problem.out_dynamic_mass_matrix_row_major[row * tangent_dof_count + column] =
                mass_value;
            problem.out_tangent_mass_matrix_row_major[row * tangent_dof_count + column] =
                tangent_mass_value;
            out_result->max_abs_dynamic_matrix = std::max(
                out_result->max_abs_dynamic_matrix,
                std::abs(dynamic_value));
            out_result->max_abs_dynamic_mass_matrix = std::max(
                out_result->max_abs_dynamic_mass_matrix,
                std::abs(mass_value));
            out_result->max_abs_tangent_mass_matrix = std::max(
                out_result->max_abs_tangent_mass_matrix,
                std::abs(tangent_mass_value));
        }
        out_result->assembled_column_count = column + 1;
    }

    // The dense modal payload is a materialization of the same canonical
    // pencil used by the matrix-free driven JVP: legacy RHS S,M map to
    // L=-S and B_alpha=-M, preserving S q=lambda M q.
    std::vector<std::complex<double>> l(matrix_entry_count);
    std::vector<std::complex<double>> b_alpha(matrix_entry_count);
    for (std::uint64_t index = 0; index < matrix_entry_count; ++index) {
        l[index] = {-problem.out_dynamic_matrix_row_major[index], 0.0};
        b_alpha[index] = {-problem.out_dynamic_mass_matrix_row_major[index], 0.0};
    }
    const std::string dependency_digest = mfem_linearized_pencil_dependency_digest(
        MfemLinearizedPencilDependency{
            problem.descriptor, problem.layout, problem.nodes,
            problem.exchange_edges, problem.exchange_edge_count,
            problem.h_ext_a_per_m, problem.h_ext_a_per_m == nullptr ? 0u : UINT64_C(3),
            problem.uniaxial_anisotropy_axis,
            problem.uniaxial_anisotropy_axis == nullptr ? 0u : UINT64_C(3),
            problem.uniaxial_anisotropy_field_a_per_m,
            problem.alpha_per_node,
            problem.alpha_per_node == nullptr ? 0 : problem.descriptor.node_count,
            problem.gamma0, problem.alpha,
            problem.dmi_elements, problem.dmi_element_count,
            problem.dmi_lumped_mass,
            problem.dmi_lumped_mass == nullptr ? 0 : problem.descriptor.node_count,
            problem.dmi_ms_field,
            problem.dmi_ms_field == nullptr ? 0 : problem.descriptor.node_count,
            problem.dmi_uniform_ms,
            problem.demag_tangent_matrix_row_major,
            problem.demag_tangent_matrix_value_count,
            problem.demag_provider_signature,
            problem.static_periodic_node_pairs,
            problem.static_periodic_node_pair_count,
            problem.periodic_airbox,
        });
    DynamicPencilMetadata canonical_metadata{};
    char metadata_error[128]{};
    if (canonicalize_dynamic_pencil_metadata(
            dynamic_pencil_metadata_from_legacy_gamma0(
                problem.gamma0, FrequencyDomainPhaseConvention::exp_i_omega_t),
            &canonical_metadata,
            metadata_error,
            sizeof(metadata_error)) != FrequencyDomainStatus::ok) {
        copy_text(out_result->error_message, sizeof(out_result->error_message), metadata_error);
        return FrequencyDomainStatus::validation_error;
    }
    const LinearizedDynamicPencil pencil = LinearizedDynamicPencil::from_dense_row_major(
        canonical_metadata,
        tangent_dof_count,
        std::move(l),
        std::move(b_alpha),
        dependency_digest);
    copy_text(out_result->operator_digest, sizeof(out_result->operator_digest), pencil.digest().c_str());
    copy_text(out_result->dependency_digest, sizeof(out_result->dependency_digest), dependency_digest.c_str());
    out_result->linearized_pencil_gamma0_m_per_a_s = canonical_metadata.gamma0_m_per_a_s;

    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus assemble_mfem_modal_sparse_operator_payload(
    const MfemModalSparseOperatorPayloadProblem &problem,
    MfemModalSparseOperatorPayloadResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }

    *out_result = MfemModalSparseOperatorPayloadResult{};
    copy_text(
        out_result->payload_kind,
        sizeof(out_result->payload_kind),
        "sparse_csr_from_dense_linearized_mfem_operator");
    copy_text(
        out_result->algebraic_form,
        sizeof(out_result->algebraic_form),
        "first_order_complex");

    const std::uint64_t tangent_dof_count =
        problem.dense_problem.descriptor.tangent_dof_count;
    out_result->tangent_dof_count = tangent_dof_count;
    std::uint64_t matrix_entry_count = 0;
    if (tangent_dof_count == 0 ||
        !checked_square(tangent_dof_count, matrix_entry_count)) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            "MFEM modal sparse payload requires a finite non-zero tangent space");
        return FrequencyDomainStatus::validation_error;
    }
    out_result->matrix_entry_count = matrix_entry_count;

    std::vector<double> dynamic_matrix(static_cast<std::size_t>(matrix_entry_count), 0.0);
    std::vector<double> dynamic_mass_matrix(static_cast<std::size_t>(matrix_entry_count), 0.0);
    std::vector<double> tangent_mass_matrix(static_cast<std::size_t>(matrix_entry_count), 0.0);
    MfemModalDenseOperatorPayloadProblem dense_problem = problem.dense_problem;
    dense_problem.out_dynamic_matrix_row_major = dynamic_matrix.data();
    dense_problem.out_dynamic_mass_matrix_row_major = dynamic_mass_matrix.data();
    dense_problem.out_tangent_mass_matrix_row_major = tangent_mass_matrix.data();
    dense_problem.matrix_capacity = matrix_entry_count;

    MfemModalDenseOperatorPayloadResult dense_result{};
    const FrequencyDomainStatus dense_status =
        assemble_mfem_modal_dense_operator_payload(dense_problem, &dense_result);
    if (dense_status != FrequencyDomainStatus::ok) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            dense_result.error_message);
        return dense_status;
    }

    out_result->assembled_column_count = dense_result.assembled_column_count;
    out_result->max_abs_dynamic_matrix = dense_result.max_abs_dynamic_matrix;
    out_result->max_abs_dynamic_mass_matrix = dense_result.max_abs_dynamic_mass_matrix;
    out_result->max_abs_tangent_mass_matrix = dense_result.max_abs_tangent_mass_matrix;
    out_result->linearized_pencil_gamma0_m_per_a_s =
        dense_result.linearized_pencil_gamma0_m_per_a_s;
    copy_text(out_result->operator_digest, sizeof(out_result->operator_digest), dense_result.operator_digest);
    copy_text(out_result->dependency_digest, sizeof(out_result->dependency_digest), dense_result.dependency_digest);
    out_result->dynamic_matrix_nnz = count_dense_csr_entries(
        dynamic_matrix.data(),
        tangent_dof_count,
        tangent_dof_count,
        problem.drop_tolerance);
    out_result->dynamic_mass_matrix_nnz = count_dense_csr_entries(
        dynamic_mass_matrix.data(),
        tangent_dof_count,
        tangent_dof_count,
        problem.drop_tolerance);
    out_result->tangent_mass_matrix_nnz = count_dense_csr_entries(
        tangent_mass_matrix.data(),
        tangent_dof_count,
        tangent_dof_count,
        problem.drop_tolerance);

    if (!csr_output_has_capacity(
            problem.out_dynamic_matrix_csr,
            tangent_dof_count,
            out_result->dynamic_matrix_nnz) ||
        !csr_output_has_capacity(
            problem.out_dynamic_mass_matrix_csr,
            tangent_dof_count,
            out_result->dynamic_mass_matrix_nnz) ||
        !csr_output_has_capacity(
            problem.out_tangent_mass_matrix_csr,
            tangent_dof_count,
            out_result->tangent_mass_matrix_nnz)) {
        copy_text(
            out_result->error_message,
            sizeof(out_result->error_message),
            "MFEM modal sparse payload CSR output buffers are too small");
        return FrequencyDomainStatus::validation_error;
    }

    write_dense_csr(
        dynamic_matrix.data(),
        tangent_dof_count,
        tangent_dof_count,
        problem.drop_tolerance,
        problem.out_dynamic_matrix_csr);
    write_dense_csr(
        dynamic_mass_matrix.data(),
        tangent_dof_count,
        tangent_dof_count,
        problem.drop_tolerance,
        problem.out_dynamic_mass_matrix_csr);
    write_dense_csr(
        tangent_mass_matrix.data(),
        tangent_dof_count,
        tangent_dof_count,
        problem.drop_tolerance,
        problem.out_tangent_mass_matrix_csr);

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
