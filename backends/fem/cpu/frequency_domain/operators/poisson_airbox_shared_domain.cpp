#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "core/fem_mesh.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "frequency_domain/canonical_digest.hpp"
#include "frequency_domain/linearization_state.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <stdexcept>
#include <utility>
#include <vector>

namespace fullmag::fem::frequency_domain {
namespace {

constexpr std::uint32_t kInactiveMagneticClass = std::numeric_limits<std::uint32_t>::max();

struct SparseAccumulator {
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
    std::vector<std::map<std::uint32_t, double>> rows{};

    SparseAccumulator(std::uint64_t rows_in, std::uint64_t columns_in)
        : row_count(rows_in)
        , column_count(columns_in)
        , rows(static_cast<std::size_t>(rows_in))
    {
    }

    void add(std::uint64_t row, std::uint64_t column, double value)
    {
        if (value == 0.0) {
            return;
        }
        rows[static_cast<std::size_t>(row)][static_cast<std::uint32_t>(column)] += value;
    }

    void finish(PoissonAirboxSharedDomainCsrMatrix &out) const
    {
        out = PoissonAirboxSharedDomainCsrMatrix{};
        out.row_count = row_count;
        out.column_count = column_count;
        out.row_offsets.reserve(rows.size() + 1u);
        out.row_offsets.push_back(0u);
        for (const auto &row : rows) {
            for (const auto &[column, value] : row) {
                if (value == 0.0) {
                    continue;
                }
                if (!std::isfinite(value)) {
                    throw std::invalid_argument(
                        "shared-domain CSR assembly produced a non-finite value");
                }
                out.column_indices.push_back(column);
                out.values.push_back(value);
            }
            if (out.values.size() > std::numeric_limits<std::uint32_t>::max()) {
                throw std::overflow_error("shared-domain CSR nnz exceeds uint32 range");
            }
            out.row_offsets.push_back(static_cast<std::uint32_t>(out.values.size()));
        }
    }
};

void copy_error(char out[256], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message != nullptr ? message : "", 255);
    out[255] = '\0';
}

bool finite_positive(double value) noexcept
{
    return std::isfinite(value) && value > 0.0;
}

bool csr_is_valid(const CsrMatrixView &matrix, std::uint64_t expected_dimension) noexcept
{
    if (matrix.row_count != expected_dimension ||
        matrix.column_count != expected_dimension ||
        matrix.row_offsets == nullptr ||
        matrix.row_offsets_len != expected_dimension + 1u ||
        matrix.column_indices_len != matrix.values_len ||
        (matrix.values_len > 0 &&
         (matrix.column_indices == nullptr || matrix.values == nullptr)) ||
        matrix.row_offsets[0] != 0u ||
        matrix.row_offsets[expected_dimension] != matrix.values_len) {
        return false;
    }
    for (std::uint64_t row = 0; row < expected_dimension; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (matrix.column_indices[entry] >= expected_dimension ||
            !std::isfinite(matrix.values[entry])) {
            return false;
        }
    }
    return true;
}

bool validate_classes(
    const std::uint32_t *classes,
    std::uint64_t node_count,
    std::uint64_t class_count,
    bool allow_inactive,
    const char *name,
    std::string &error)
{
    if (classes == nullptr || class_count == 0 || class_count > node_count) {
        error = std::string(name) + " equivalence classes are missing";
        return false;
    }
    std::vector<bool> seen(static_cast<std::size_t>(class_count), false);
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const std::uint32_t value = classes[node];
        if (value == kInactiveMagneticClass && allow_inactive) {
            continue;
        }
        if (value >= class_count) {
            error = std::string(name) + " equivalence class index is out of range";
            return false;
        }
        seen[static_cast<std::size_t>(value)] = true;
    }
    if (std::find(seen.begin(), seen.end(), false) != seen.end()) {
        error = std::string(name) + " equivalence classes are not complete";
        return false;
    }
    return true;
}

double node_ms(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    std::uint64_t node) noexcept
{
    return request.saturation_magnetization_a_per_m != nullptr
        ? request.saturation_magnetization_a_per_m[node]
        : request.uniform_saturation_magnetization_a_per_m;
}

bool validate_materials(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    std::uint64_t node_count,
    std::string &error)
{
    if (request.saturation_magnetization_a_per_m != nullptr &&
        request.saturation_magnetization_count != node_count) {
        error = "shared-domain saturation magnetization count does not match the scalar mesh";
        return false;
    }
    if (request.saturation_magnetization_a_per_m == nullptr &&
        !finite_positive(request.uniform_saturation_magnetization_a_per_m)) {
        error = "shared-domain saturation magnetization must be finite and positive";
        return false;
    }
    for (std::uint64_t node = 0; node < node_count; ++node) {
        if (!finite_positive(node_ms(request, node))) {
            error = "shared-domain saturation magnetization contains a non-positive value";
            return false;
        }
    }
    return true;
}

void add_mfem_matrix(
    const mfem::SparseMatrix &matrix,
    const std::uint32_t *row_classes,
    std::uint64_t row_class_count,
    const std::uint32_t *column_classes,
    std::uint64_t column_class_count,
    std::uint32_t row_stride,
    std::uint32_t column_stride,
    SparseAccumulator &out)
{
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < matrix.Height(); ++row) {
        const std::uint64_t row_node = static_cast<std::uint64_t>(row) / row_stride;
        const std::uint32_t row_component = static_cast<std::uint32_t>(row) % row_stride;
        const std::uint32_t reduced_row_node = row_classes[row_node];
        if (reduced_row_node == kInactiveMagneticClass) {
            continue;
        }
        matrix.GetRow(row, columns, values);
        for (int entry = 0; entry < columns.Size(); ++entry) {
            const std::uint64_t column = static_cast<std::uint64_t>(columns[entry]);
            const std::uint64_t column_node = column / column_stride;
            const std::uint32_t column_component =
                static_cast<std::uint32_t>(column % column_stride);
            const std::uint32_t reduced_column_node = column_classes[column_node];
            if (reduced_column_node == kInactiveMagneticClass) {
                continue;
            }
            const std::uint64_t reduced_row =
                static_cast<std::uint64_t>(reduced_row_node) * row_stride + row_component;
            const std::uint64_t reduced_column =
                static_cast<std::uint64_t>(reduced_column_node) * column_stride + column_component;
            out.add(reduced_row, reduced_column, values[entry]);
        }
    }
}

void add_csr_matrix(
    const CsrMatrixView &matrix,
    const std::uint32_t *row_classes,
    const std::uint32_t *column_classes,
    std::uint32_t row_stride,
    std::uint32_t column_stride,
    SparseAccumulator &out)
{
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        const std::uint64_t row_node = row / row_stride;
        const std::uint32_t row_component = static_cast<std::uint32_t>(row % row_stride);
        const std::uint32_t reduced_row_node = row_classes[row_node];
        if (reduced_row_node == kInactiveMagneticClass) {
            continue;
        }
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1u];
             ++entry) {
            const std::uint64_t column = matrix.column_indices[entry];
            const std::uint64_t column_node = column / column_stride;
            const std::uint32_t column_component =
                static_cast<std::uint32_t>(column % column_stride);
            const std::uint32_t reduced_column_node = column_classes[column_node];
            if (reduced_column_node == kInactiveMagneticClass) {
                continue;
            }
            out.add(
                static_cast<std::uint64_t>(reduced_row_node) * row_stride + row_component,
                static_cast<std::uint64_t>(reduced_column_node) * column_stride + column_component,
                matrix.values[entry]);
        }
    }
}

void add_csr_rectangular(
    const SparseAccumulator &source,
    const std::uint32_t *row_classes,
    const std::uint32_t *column_classes,
    std::uint32_t row_stride,
    std::uint32_t column_stride,
    SparseAccumulator &out)
{
    for (std::uint64_t row = 0; row < source.row_count; ++row) {
        const std::uint64_t row_node = row / row_stride;
        const std::uint32_t row_component = static_cast<std::uint32_t>(row % row_stride);
        const std::uint32_t reduced_row_node = row_classes[row_node];
        if (reduced_row_node == kInactiveMagneticClass) {
            continue;
        }
        for (const auto &[column_u32, value] : source.rows[static_cast<std::size_t>(row)]) {
            const std::uint64_t column = column_u32;
            const std::uint64_t column_node = column / column_stride;
            const std::uint32_t column_component =
                static_cast<std::uint32_t>(column % column_stride);
            const std::uint32_t reduced_column_node = column_classes[column_node];
            if (reduced_column_node == kInactiveMagneticClass) {
                continue;
            }
            out.add(
                static_cast<std::uint64_t>(reduced_row_node) * row_stride + row_component,
                static_cast<std::uint64_t>(reduced_column_node) * column_stride + column_component,
                value);
        }
    }
}

void eliminate_rows_and_columns(
    PoissonAirboxSharedDomainCsrMatrix &matrix,
    const std::set<std::uint32_t> &rows_to_eliminate,
    const std::set<std::uint32_t> &columns_to_eliminate)
{
    std::vector<std::uint32_t> row_offsets;
    std::vector<std::uint32_t> column_indices;
    std::vector<double> values;
    row_offsets.reserve(matrix.row_offsets.size());
    row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        if (rows_to_eliminate.find(static_cast<std::uint32_t>(row)) ==
            rows_to_eliminate.end()) {
            const std::uint32_t begin = matrix.row_offsets[static_cast<std::size_t>(row)];
            const std::uint32_t end = matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
            for (std::uint32_t entry = begin; entry < end; ++entry) {
                if (columns_to_eliminate.find(matrix.column_indices[entry]) !=
                    columns_to_eliminate.end()) {
                    continue;
                }
                column_indices.push_back(matrix.column_indices[entry]);
                values.push_back(matrix.values[entry]);
            }
        }
        if (values.size() > std::numeric_limits<std::uint32_t>::max()) {
            throw std::overflow_error("shared-domain constrained CSR nnz exceeds uint32 range");
        }
        row_offsets.push_back(static_cast<std::uint32_t>(values.size()));
    }
    matrix.row_offsets = std::move(row_offsets);
    matrix.column_indices = std::move(column_indices);
    matrix.values = std::move(values);
}

void add_digest_matrix(
    CanonicalDigestBuilder &digest,
    const char *name,
    const PoissonAirboxSharedDomainCsrMatrix &matrix)
{
    digest.add_u64(std::string(name) + ".rows", matrix.row_count);
    digest.add_u64(std::string(name) + ".columns", matrix.column_count);
    for (std::size_t index = 0; index < matrix.values.size(); ++index) {
        digest.add_u64(
            std::string(name) + ".column[" + std::to_string(index) + "]",
            matrix.column_indices[index]);
        digest.add_double(
            std::string(name) + ".value[" + std::to_string(index) + "]",
            matrix.values[index]);
    }
}

template <typename T>
bool copy_payload_span(
    const T *source,
    std::uint64_t count,
    std::vector<T> &destination,
    std::string &error,
    const char *name)
{
    if (count > 0u && source == nullptr) {
        error = std::string("shared-domain payload ") + name + " is null";
        return false;
    }
    if (count > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        error = std::string("shared-domain payload ") + name + " exceeds host size_t";
        return false;
    }
    if (count == 0u) {
        destination.clear();
        return true;
    }
    destination.assign(source, source + static_cast<std::size_t>(count));
    return true;
}

bool copy_mesh_payload(
    const fullmag_fem_mesh_desc &mesh,
    fullmag::fem::FemMeshRuntimeState &out,
    std::string &error)
{
    if (mesh.abi_version != FULLMAG_FEM_MESH_DESC_ABI_VERSION ||
        mesh.struct_size != sizeof(fullmag_fem_mesh_desc) ||
        mesh.nodes_xyz_len == 0u || mesh.nodes_xyz_len % 3u != 0u ||
        mesh.cell_types_len == 0u ||
        mesh.nodes_xyz_len / 3u > std::numeric_limits<std::uint32_t>::max() ||
        mesh.cell_types_len > std::numeric_limits<std::uint32_t>::max() ||
        mesh.facet_types_len > std::numeric_limits<std::uint32_t>::max()) {
        error = "shared-domain payload carries an invalid mesh descriptor";
        return false;
    }
    out = fullmag::fem::FemMeshRuntimeState{};
    out.n_nodes = static_cast<std::uint32_t>(mesh.nodes_xyz_len / 3u);
    out.n_elements = static_cast<std::uint32_t>(mesh.cell_types_len);
    out.n_boundary_faces = static_cast<std::uint32_t>(mesh.facet_types_len);
    const bool copied =
        copy_payload_span(mesh.nodes_xyz, mesh.nodes_xyz_len, out.nodes_xyz, error, "nodes_xyz") &&
        copy_payload_span(mesh.cell_types, mesh.cell_types_len, out.cell_types, error, "cell_types") &&
        copy_payload_span(mesh.cell_offsets, mesh.cell_offsets_len, out.cell_offsets, error, "cell_offsets") &&
        copy_payload_span(mesh.cell_nodes, mesh.cell_nodes_len, out.cell_nodes, error, "cell_nodes") &&
        copy_payload_span(mesh.cell_global_ordinals, mesh.cell_global_ordinals_len,
                          out.cell_global_ordinals, error, "cell_global_ordinals") &&
        copy_payload_span(mesh.cell_markers, mesh.cell_markers_len, out.cell_markers, error, "cell_markers") &&
        copy_payload_span(mesh.facet_types, mesh.facet_types_len, out.facet_types, error, "facet_types") &&
        copy_payload_span(mesh.facet_roles, mesh.facet_roles_len, out.facet_roles, error, "facet_roles") &&
        copy_payload_span(mesh.facet_offsets, mesh.facet_offsets_len, out.facet_offsets, error, "facet_offsets") &&
        copy_payload_span(mesh.facet_nodes, mesh.facet_nodes_len, out.facet_nodes, error, "facet_nodes") &&
        copy_payload_span(mesh.facet_global_ordinals, mesh.facet_global_ordinals_len,
                          out.facet_global_ordinals, error, "facet_global_ordinals") &&
        copy_payload_span(mesh.facet_markers, mesh.facet_markers_len, out.facet_markers, error, "facet_markers") &&
        copy_payload_span(mesh.periodic_node_pairs, mesh.periodic_node_pairs_len,
                          out.periodic_node_pairs, error, "periodic_node_pairs");
    if (!copied) {
        return false;
    }
    if (mesh.periodic_boundary_pair_markers_len % 2u != 0u) {
        error = "shared-domain payload periodic boundary marker pairs must have even cardinality";
        return false;
    }
    out.periodic_boundary_marker_set.clear();
    for (std::uint64_t index = 0;
         index < mesh.periodic_boundary_pair_markers_len;
         ++index) {
        if (mesh.periodic_boundary_pair_markers == nullptr) {
            error = "shared-domain payload periodic boundary marker pairs are null";
            return false;
        }
        out.periodic_boundary_marker_set.insert(mesh.periodic_boundary_pair_markers[index]);
    }
    return true;
}

} // namespace

FrequencyDomainStatus assemble_poisson_airbox_shared_domain(
    const PoissonAirboxSharedDomainAssemblyRequest &request,
    PoissonAirboxSharedDomainAssemblyResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxSharedDomainAssemblyResult{};
    out_result->status = FrequencyDomainStatus::validation_error;

    try {
        if (request.scalar_space == nullptr || request.tangent_frames == nullptr ||
            request.tangent_frame_count == 0) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires one scalar FE space and tangent frames");
            return out_result->status;
        }
        const std::uint64_t node_count =
            static_cast<std::uint64_t>(request.scalar_space->GetVSize());
        if (node_count != request.tangent_frame_count ||
            request.scalar_space->GetMesh() == nullptr ||
            request.scalar_space->GetMesh()->Dimension() != 3 ||
            request.scalar_space->GetFE(0)->GetOrder() != 1) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires a three-dimensional nodal P1 FE space");
            return out_result->status;
        }
        if (!request.equivalence_classes_complete) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires complete scalar and magnetic equivalence classes");
            return out_result->status;
        }
        std::string error;
        if (!validate_classes(
                request.scalar_reduced_node,
                node_count,
                request.scalar_reduced_node_count,
                false,
                "scalar",
                error) ||
            !validate_classes(
                request.magnetic_reduced_node,
                node_count,
                request.magnetic_reduced_node_count,
                true,
                "magnetic",
                error)) {
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        if (request.magnetic_element_mask == nullptr ||
            request.magnetic_element_count !=
                static_cast<std::uint64_t>(request.scalar_space->GetMesh()->GetNE())) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires one magnetic mask entry per mesh element");
            return out_result->status;
        }
        for (std::uint64_t element = 0; element < request.magnetic_element_count; ++element) {
            if (request.magnetic_element_mask[element] > 1u) {
                copy_error(out_result->error_message,
                           "shared-domain magnetic element mask must contain only zero or one");
                return out_result->status;
            }
        }
        if (!validate_materials(request, node_count, error) ||
            !finite_positive(request.gamma0_m_per_a_s) ||
            !finite_positive(request.mu0_T_m_A)) {
            if (error.empty()) {
                error = "shared-domain gamma0 and mu0 must be finite and positive";
            }
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        const std::uint64_t full_q_count = 2u * node_count;
        if (request.magnetic_a_qq_csr == nullptr ||
            !csr_is_valid(*request.magnetic_a_qq_csr, full_q_count)) {
            copy_error(out_result->error_message,
                       "shared-domain assembly requires a finite full magnetic A_qq CSR block");
            return out_result->status;
        }

        switch (request.boundary_kind) {
        case PoissonAirboxBoundaryKind::robin:
            if (!finite_positive(request.robin_beta) || request.robin_boundary_marker == nullptr) {
                copy_error(out_result->error_message,
                           "Robin shared-domain assembly requires beta>0 and a boundary marker");
                return out_result->status;
            }
            break;
        case PoissonAirboxBoundaryKind::dirichlet:
            if (request.robin_beta != 0.0 || request.robin_boundary_marker == nullptr) {
                copy_error(out_result->error_message,
                           "Dirichlet shared-domain assembly requires beta=0 and a boundary marker");
                return out_result->status;
            }
            break;
        case PoissonAirboxBoundaryKind::pure_neumann:
            if (request.robin_beta != 0.0 || request.robin_boundary_marker != nullptr) {
                copy_error(out_result->error_message,
                           "pure-Neumann shared-domain assembly forbids Robin data");
                return out_result->status;
            }
            break;
        default:
            copy_error(out_result->error_message, "unknown shared-domain boundary kind");
            return out_result->status;
        }

        std::unique_ptr<mfem::ConstantCoefficient> robin_coefficient;
        mfem::BilinearForm scalar_form(request.scalar_space);
        scalar_form.AddDomainIntegrator(new mfem::DiffusionIntegrator());
        if (request.boundary_kind == PoissonAirboxBoundaryKind::robin) {
            robin_coefficient = std::make_unique<mfem::ConstantCoefficient>(request.robin_beta);
            scalar_form.AddBoundaryIntegrator(
                new mfem::BoundaryMassIntegrator(*robin_coefficient),
                *request.robin_boundary_marker);
        }
        scalar_form.Assemble();
        scalar_form.Finalize();
        std::unique_ptr<mfem::SparseMatrix> p_full(
            new mfem::SparseMatrix(scalar_form.SpMat()));

        mfem::Array<int> essential;
        if (request.boundary_kind == PoissonAirboxBoundaryKind::dirichlet) {
            request.scalar_space->GetEssentialTrueDofs(
                *request.robin_boundary_marker,
                essential);
            for (int index = 0; index < essential.Size(); ++index) {
                p_full->EliminateRowCol(essential[index]);
            }
        }

        SparseAccumulator p_reduced(
            request.scalar_reduced_node_count,
            request.scalar_reduced_node_count);
        add_mfem_matrix(
            *p_full,
            request.scalar_reduced_node,
            request.scalar_reduced_node_count,
            request.scalar_reduced_node,
            request.scalar_reduced_node_count,
            1u,
            1u,
            p_reduced);
        p_reduced.finish(out_result->p);

        SparseAccumulator a_qq_reduced(
            2u * request.magnetic_reduced_node_count,
            2u * request.magnetic_reduced_node_count);
        add_csr_matrix(
            *request.magnetic_a_qq_csr,
            request.magnetic_reduced_node,
            request.magnetic_reduced_node,
            2u,
            2u,
            a_qq_reduced);
        a_qq_reduced.finish(out_result->a_qq);

        SparseAccumulator a_phiq_full(node_count, full_q_count);
        SparseAccumulator a_qphi_full(full_q_count, node_count);
        SparseAccumulator b_qq_full(full_q_count, full_q_count);
        mfem::Mesh *mesh = request.scalar_space->GetMesh();
        for (int element = 0; element < mesh->GetNE(); ++element) {
            if (request.magnetic_element_mask[static_cast<std::size_t>(element)] == 0u) {
                continue;
            }
            mfem::Array<int> dofs;
            request.scalar_space->GetElementDofs(element, dofs);
            const mfem::FiniteElement *finite_element = request.scalar_space->GetFE(element);
            mfem::ElementTransformation *transformation =
                mesh->GetElementTransformation(element);
            const mfem::IntegrationRule &rule =
                mfem::IntRules.Get(finite_element->GetGeomType(), 4);
            for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
                const mfem::IntegrationPoint &point = rule.IntPoint(point_index);
                transformation->SetIntPoint(&point);
                mfem::Vector shape(dofs.Size());
                mfem::DenseMatrix physical_dshape(dofs.Size(), 3);
                finite_element->CalcShape(point, shape);
                finite_element->CalcPhysDShape(*transformation, physical_dshape);
                const double weight = transformation->Weight() * point.weight;
                double m0[3] = {0.0, 0.0, 0.0};
                double ms = 0.0;
                for (int local = 0; local < dofs.Size(); ++local) {
                    const std::uint64_t node = static_cast<std::uint64_t>(
                        dofs[local] >= 0 ? dofs[local] : -1 - dofs[local]);
                    for (int axis = 0; axis < 3; ++axis) {
                        m0[axis] += shape[local] * request.tangent_frames[node].m[axis];
                    }
                    ms += shape[local] * node_ms(request, node);
                }
                const double m0_norm = std::sqrt(
                    m0[0] * m0[0] + m0[1] * m0[1] + m0[2] * m0[2]);
                if (!finite_positive(m0_norm)) {
                    copy_error(out_result->error_message,
                               "shared-domain equilibrium interpolation is non-finite");
                    return out_result->status;
                }
                m0[0] /= m0_norm;
                m0[1] /= m0_norm;
                m0[2] /= m0_norm;
                for (int local_test = 0; local_test < dofs.Size(); ++local_test) {
                    const std::uint64_t test_node = static_cast<std::uint64_t>(
                        dofs[local_test] >= 0 ? dofs[local_test] : -1 - dofs[local_test]);
                    const double test_sign = dofs[local_test] >= 0 ? 1.0 : -1.0;
                    for (int local_trial = 0; local_trial < dofs.Size(); ++local_trial) {
                        const std::uint64_t trial_node = static_cast<std::uint64_t>(
                            dofs[local_trial] >= 0 ? dofs[local_trial] : -1 - dofs[local_trial]);
                        const double trial_sign = dofs[local_trial] >= 0 ? 1.0 : -1.0;
                        double grad_test[3] = {
                            physical_dshape(local_test, 0),
                            physical_dshape(local_test, 1),
                            physical_dshape(local_test, 2)};
                        double grad_trial[3] = {
                            physical_dshape(local_trial, 0),
                            physical_dshape(local_trial, 1),
                            physical_dshape(local_trial, 2)};
                        double h_phi[3] = {
                            -grad_trial[0], -grad_trial[1], -grad_trial[2]};
                        double m_cross_h[3] = {
                            m0[1] * h_phi[2] - m0[2] * h_phi[1],
                            m0[2] * h_phi[0] - m0[0] * h_phi[2],
                            m0[0] * h_phi[1] - m0[1] * h_phi[0]};
                        double torque[3] = {
                            -request.gamma0_m_per_a_s * m_cross_h[0],
                            -request.gamma0_m_per_a_s * m_cross_h[1],
                            -request.gamma0_m_per_a_s * m_cross_h[2]};
                        for (std::uint32_t component = 0; component < 2u; ++component) {
                            const double *test_frame = component == 0u
                                ? request.tangent_frames[test_node].e1
                                : request.tangent_frames[test_node].e2;
                            const double *trial_frame = component == 0u
                                ? request.tangent_frames[trial_node].e1
                                : request.tangent_frames[trial_node].e2;
                            const double source_projection =
                                trial_frame[0] * grad_test[0] +
                                trial_frame[1] * grad_test[1] +
                                trial_frame[2] * grad_test[2];
                            a_phiq_full.add(
                                test_node,
                                2u * trial_node + component,
                                -test_sign * trial_sign * ms * shape[local_trial] *
                                    source_projection * weight);
                            const double torque_projection =
                                test_frame[0] * torque[0] +
                                test_frame[1] * torque[1] +
                                test_frame[2] * torque[2];
                            a_qphi_full.add(
                                2u * test_node + component,
                                trial_node,
                                test_sign * trial_sign * shape[local_test] *
                                    (request.mu0_T_m_A * ms / request.gamma0_m_per_a_s) *
                                    torque_projection * weight);
                        }
                        // Assemble all four tangent-component entries.  The
                        // gyrotropic block is skew-symmetric only after the
                        // complete component pair is included.
                        for (std::uint32_t row_component = 0; row_component < 2u; ++row_component) {
                            for (std::uint32_t column_component = 0; column_component < 2u; ++column_component) {
                                const double *row_frame = row_component == 0u
                                    ? request.tangent_frames[test_node].e1
                                    : request.tangent_frames[test_node].e2;
                                const double *column_frame = column_component == 0u
                                    ? request.tangent_frames[trial_node].e1
                                    : request.tangent_frames[trial_node].e2;
                                const double cross_value[3] = {
                                    m0[1] * column_frame[2] - m0[2] * column_frame[1],
                                    m0[2] * column_frame[0] - m0[0] * column_frame[2],
                                    m0[0] * column_frame[1] - m0[1] * column_frame[0]};
                                const double gyrotropic =
                                    row_frame[0] * cross_value[0] +
                                    row_frame[1] * cross_value[1] +
                                    row_frame[2] * cross_value[2];
                                b_qq_full.add(
                                    2u * test_node + row_component,
                                    2u * trial_node + column_component,
                                    -test_sign * trial_sign * shape[local_test] *
                                        shape[local_trial] *
                                        (request.mu0_T_m_A * ms / request.gamma0_m_per_a_s) *
                                        gyrotropic * weight);
                            }
                        }
                    }
                }
            }
        }

        SparseAccumulator a_phiq_reduced(
            request.scalar_reduced_node_count,
            2u * request.magnetic_reduced_node_count);
        SparseAccumulator a_qphi_reduced(
            2u * request.magnetic_reduced_node_count,
            request.scalar_reduced_node_count);
        SparseAccumulator b_qq_reduced(
            2u * request.magnetic_reduced_node_count,
            2u * request.magnetic_reduced_node_count);
        add_csr_rectangular(
            a_phiq_full,
            request.scalar_reduced_node,
            request.magnetic_reduced_node,
            1u,
            2u,
            a_phiq_reduced);
        add_csr_rectangular(
            a_qphi_full,
            request.magnetic_reduced_node,
            request.scalar_reduced_node,
            2u,
            1u,
            a_qphi_reduced);
        add_csr_rectangular(
            b_qq_full,
            request.magnetic_reduced_node,
            request.magnetic_reduced_node,
            2u,
            2u,
            b_qq_reduced);
        a_phiq_reduced.finish(out_result->a_phiq);
        a_qphi_reduced.finish(out_result->a_qphi);
        b_qq_reduced.finish(out_result->b_qq);

        if (request.boundary_kind == PoissonAirboxBoundaryKind::pure_neumann) {
            mfem::ConstantCoefficient one(1.0);
            mfem::LinearForm mean_form(request.scalar_space);
            mean_form.AddDomainIntegrator(new mfem::DomainLFIntegrator(one));
            mean_form.Assemble();
            out_result->phi_mean_weights.assign(
                static_cast<std::size_t>(request.scalar_reduced_node_count), 0.0);
            for (std::uint64_t node = 0; node < node_count; ++node) {
                out_result->phi_mean_weights[
                    request.scalar_reduced_node[node]] += mean_form[static_cast<int>(node)];
            }
            long double weight_sum = 0.0L;
            for (double weight : out_result->phi_mean_weights) {
                if (!finite_positive(weight)) {
                    copy_error(out_result->error_message,
                               "pure-Neumann shared-domain gauge weights must be finite and positive");
                    return out_result->status;
                }
                weight_sum += static_cast<long double>(weight);
            }
            if (!(weight_sum > 0.0L) || !std::isfinite(static_cast<double>(weight_sum))) {
                copy_error(out_result->error_message,
                           "pure-Neumann shared-domain gauge weights have zero or non-finite measure");
                return out_result->status;
            }
            const double inverse_weight_sum = 1.0 / static_cast<double>(weight_sum);
            for (double &weight : out_result->phi_mean_weights) {
                weight *= inverse_weight_sum;
            }
        } else if (request.boundary_kind == PoissonAirboxBoundaryKind::dirichlet) {
            std::set<std::uint32_t> reduced_dofs;
            for (int index = 0; index < essential.Size(); ++index) {
                reduced_dofs.insert(request.scalar_reduced_node[
                    static_cast<std::size_t>(essential[index])]);
            }
            out_result->dirichlet_dofs.assign(reduced_dofs.begin(), reduced_dofs.end());
            eliminate_rows_and_columns(
                out_result->a_phiq,
                reduced_dofs,
                {});
            eliminate_rows_and_columns(
                out_result->a_qphi,
                {},
                reduced_dofs);
        }

        const char *boundary = request.boundary_kind == PoissonAirboxBoundaryKind::robin
            ? "poisson_robin"
            : request.boundary_kind == PoissonAirboxBoundaryKind::dirichlet
                ? "poisson_dirichlet"
                : "pure_neumann";
        const char *gauge = request.boundary_kind == PoissonAirboxBoundaryKind::pure_neumann
            ? "mean_zero_augmented"
            : "none";
        std::strncpy(out_result->boundary_kind, boundary, sizeof(out_result->boundary_kind) - 1u);
        std::strncpy(out_result->gauge_policy, gauge, sizeof(out_result->gauge_policy) - 1u);
        std::strncpy(out_result->assembly_kind, "mfem_weak_form_shared_domain",
                     sizeof(out_result->assembly_kind) - 1u);

        CanonicalDigestBuilder digest("poisson_airbox_shared_domain.assembly.v1");
        digest.add_u64("full_phi_dof_count", node_count);
        digest.add_u64("full_q_dof_count", full_q_count);
        digest.add_u64("phi_dof_count", request.scalar_reduced_node_count);
        digest.add_u64("q_dof_count", 2u * request.magnetic_reduced_node_count);
        digest.add_string("boundary_kind", boundary);
        digest.add_string("gauge_policy", gauge);
        digest.add_double("robin_beta", request.robin_beta);
        digest.add_double("gamma0_m_per_a_s", request.gamma0_m_per_a_s);
        digest.add_double("mu0_T_m_A", request.mu0_T_m_A);
        for (std::uint64_t node = 0; node < node_count; ++node) {
            digest.add_u64("scalar_class[" + std::to_string(node) + "]",
                           request.scalar_reduced_node[node]);
            digest.add_u64("magnetic_class[" + std::to_string(node) + "]",
                           request.magnetic_reduced_node[node]);
            digest.add_double("Ms[" + std::to_string(node) + "]", node_ms(request, node));
            for (int axis = 0; axis < 3; ++axis) {
                digest.add_double("m[" + std::to_string(node) + "][" + std::to_string(axis) + "]",
                                  request.tangent_frames[node].m[axis]);
            }
        }
        add_digest_matrix(digest, "A_qq", out_result->a_qq);
        add_digest_matrix(digest, "A_qphi", out_result->a_qphi);
        add_digest_matrix(digest, "A_phiq", out_result->a_phiq);
        add_digest_matrix(digest, "P", out_result->p);
        add_digest_matrix(digest, "B_qq", out_result->b_qq);
        const std::string hex = digest.sha256_hex();
        std::strncpy(out_result->operator_digest, hex.c_str(), sizeof(out_result->operator_digest) - 1u);

        out_result->full_q_dof_count = full_q_count;
        out_result->full_phi_dof_count = node_count;
        out_result->q_dof_count = 2u * request.magnetic_reduced_node_count;
        out_result->phi_dof_count = request.scalar_reduced_node_count;
        out_result->status = FrequencyDomainStatus::ok;
        return out_result->status;
    } catch (const std::exception &exception) {
        copy_error(out_result->error_message, exception.what());
    } catch (...) {
        copy_error(out_result->error_message, "shared-domain MFEM assembly failed");
    }
    out_result->status = FrequencyDomainStatus::operator_error;
    return out_result->status;
}

FrequencyDomainStatus assemble_poisson_airbox_shared_domain_payload(
    const FullmagFemModalSharedDomainPayload &payload,
    PoissonAirboxSharedDomainAssemblyResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxSharedDomainAssemblyResult{};
    out_result->status = FrequencyDomainStatus::validation_error;
    try {
        if (payload.abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION ||
            payload.struct_size != sizeof(FullmagFemModalSharedDomainPayload) ||
            payload.mesh == nullptr || payload.equilibrium_m0_xyz == nullptr ||
            payload.equilibrium_m0_xyz_count == 0u ||
            payload.scalar_reduced_node == nullptr ||
            payload.magnetic_reduced_node == nullptr ||
            payload.scalar_reduced_node_count == 0u ||
            payload.magnetic_reduced_node_count == 0u ||
            payload.magnetic_pair_count == 0u || payload.airbox_pair_count == 0u ||
            payload.boundary_kind == nullptr || payload.boundary_kind[0] == '\0' ||
            payload.equilibrium_digest == nullptr || payload.equilibrium_digest[0] == '\0' ||
            payload.mesh_certificate_digest == nullptr || payload.mesh_certificate_digest[0] == '\0' ||
            payload.mesh_certificate_schema == nullptr ||
            payload.linearization_state_digest == nullptr ||
            payload.linearization_state_digest[0] == '\0' ||
            payload.linearization_m0_xyz == nullptr ||
            payload.linearization_m0_xyz_count == 0u ||
            payload.linearization_h_eff0_xyz == nullptr ||
            payload.linearization_h_eff0_xyz_count == 0u ||
            payload.linearization_h_demag0_xyz == nullptr ||
            payload.linearization_h_demag0_xyz_count == 0u ||
            payload.linearization_phi0 == nullptr ||
            payload.linearization_phi0_count == 0u ||
            payload.equilibrium_id == nullptr || payload.equilibrium_id[0] == '\0' ||
            payload.mesh_snapshot_id == nullptr || payload.mesh_snapshot_id[0] == '\0' ||
            payload.material_snapshot_id == nullptr || payload.material_snapshot_id[0] == '\0' ||
            payload.physics_snapshot_id == nullptr || payload.physics_snapshot_id[0] == '\0' ||
            payload.boundary_snapshot_id == nullptr || payload.boundary_snapshot_id[0] == '\0' ||
            payload.producer_run_id == nullptr || payload.producer_run_id[0] == '\0' ||
            payload.equilibrium_content_sha256 == nullptr ||
            payload.equilibrium_content_sha256[0] == '\0' ||
            payload.demag_model == nullptr || payload.demag_model[0] == '\0' ||
            !std::isfinite(payload.m0_norm_tolerance) || payload.m0_norm_tolerance < 0.0 ||
            !std::isfinite(payload.equilibrium_torque_relative_tolerance) ||
            payload.equilibrium_torque_relative_tolerance < 0.0 ||
            std::strcmp(payload.mesh_certificate_schema, "periodic_mesh_certificate.v6") != 0) {
            copy_error(out_result->error_message,
                       "shared-domain modal payload is incomplete or uses an unsupported certificate");
            return out_result->status;
        }
        fullmag::fem::FemMeshRuntimeState source{};
        std::string error;
        if (!copy_mesh_payload(*payload.mesh, source, error)) {
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        const std::uint64_t node_count = source.n_nodes;
        if (payload.equilibrium_m0_xyz_count != 3u * node_count ||
            payload.scalar_reduced_node_count > node_count ||
            payload.magnetic_reduced_node_count > node_count) {
            copy_error(out_result->error_message,
                       "shared-domain modal payload cardinalities do not match the mesh");
            return out_result->status;
        }
        if (payload.linearization_m0_xyz_count % 3u != 0u ||
            payload.linearization_h_eff0_xyz_count != payload.linearization_m0_xyz_count ||
            payload.linearization_h_demag0_xyz_count != payload.linearization_m0_xyz_count ||
            payload.linearization_phi0_count != node_count) {
            copy_error(out_result->error_message,
                       "shared-domain linearization fields have inconsistent cardinalities");
            return out_result->status;
        }
        const std::uint64_t linearization_magnetic_node_count =
            payload.linearization_m0_xyz_count / 3u;
        std::vector<double> saturation_magnetization;
        if (payload.saturation_magnetisation_a_per_m != nullptr) {
            if (payload.saturation_magnetisation_count != node_count ||
                !copy_payload_span(payload.saturation_magnetisation_a_per_m,
                                   payload.saturation_magnetisation_count,
                                   saturation_magnetization,
                                   error,
                                   "saturation_magnetisation_a_per_m")) {
                copy_error(out_result->error_message, error.c_str());
                return out_result->status;
            }
        }
        std::unique_ptr<mfem::Mesh> mesh;
        if (!fullmag::fem::build_mfem_mesh(source, mesh, error)) {
            copy_error(out_result->error_message, error.c_str());
            return out_result->status;
        }
        mfem::H1_FECollection collection(1, mesh->Dimension());
        mfem::FiniteElementSpace scalar_space(mesh.get(), &collection);
        std::vector<std::uint8_t> magnetic_element_mask(source.n_elements, 1u);
        if (!source.cell_markers.empty()) {
            if (source.cell_markers.size() != source.n_elements) {
                copy_error(out_result->error_message,
                           "shared-domain payload cell marker count does not match the mesh");
                return out_result->status;
            }
            for (std::size_t index = 0; index < magnetic_element_mask.size(); ++index) {
                magnetic_element_mask[index] = source.cell_markers[index] == 0u ? 0u : 1u;
            }
        }
        std::vector<std::uint8_t> magnetic_node_mask(static_cast<std::size_t>(node_count), 0u);
        for (std::uint32_t element = 0; element < source.n_elements; ++element) {
            if (magnetic_element_mask[element] == 0u) {
                continue;
            }
            const std::uint32_t begin = source.cell_offsets[element];
            const std::uint32_t end = source.cell_offsets[element + 1u];
            for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                magnetic_node_mask[source.cell_nodes[cursor]] = 1u;
            }
        }
        const std::uint64_t magnetic_node_count = static_cast<std::uint64_t>(std::count(
            magnetic_node_mask.begin(), magnetic_node_mask.end(), static_cast<std::uint8_t>(1u)));
        if (linearization_magnetic_node_count != magnetic_node_count) {
            copy_error(out_result->error_message,
                       "shared-domain linearization fields do not cover exactly the magnetic nodes");
            return out_result->status;
        }
        std::vector<double> linearization_m0_x(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_m0_y(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_m0_z(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_h_eff0_x(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_h_eff0_y(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_h_eff0_z(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_h_demag0_x(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_h_demag0_y(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::vector<double> linearization_h_demag0_z(
            static_cast<std::size_t>(linearization_magnetic_node_count));
        std::uint64_t linearization_node = 0u;
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            if (magnetic_node_mask[static_cast<std::size_t>(node)] == 0u) {
                continue;
            }
            const std::size_t source_offset = static_cast<std::size_t>(3u * linearization_node);
            const std::size_t destination = static_cast<std::size_t>(linearization_node);
            linearization_m0_x[destination] = payload.linearization_m0_xyz[source_offset];
            linearization_m0_y[destination] = payload.linearization_m0_xyz[source_offset + 1u];
            linearization_m0_z[destination] = payload.linearization_m0_xyz[source_offset + 2u];
            linearization_h_eff0_x[destination] = payload.linearization_h_eff0_xyz[source_offset];
            linearization_h_eff0_y[destination] = payload.linearization_h_eff0_xyz[source_offset + 1u];
            linearization_h_eff0_z[destination] = payload.linearization_h_eff0_xyz[source_offset + 2u];
            linearization_h_demag0_x[destination] = payload.linearization_h_demag0_xyz[source_offset];
            linearization_h_demag0_y[destination] = payload.linearization_h_demag0_xyz[source_offset + 1u];
            linearization_h_demag0_z[destination] = payload.linearization_h_demag0_xyz[source_offset + 2u];
            ++linearization_node;
        }
        EquilibriumArtifactDescriptor equilibrium_artifact{};
        equilibrium_artifact.equilibrium_id = payload.equilibrium_id;
        equilibrium_artifact.mesh_snapshot_id = payload.mesh_snapshot_id;
        equilibrium_artifact.material_snapshot_id = payload.material_snapshot_id;
        equilibrium_artifact.physics_snapshot_id = payload.physics_snapshot_id;
        equilibrium_artifact.boundary_snapshot_id = payload.boundary_snapshot_id;
        equilibrium_artifact.producer_run_id = payload.producer_run_id;
        equilibrium_artifact.content_sha256 = payload.equilibrium_content_sha256;
        equilibrium_artifact.m0_unit = CartesianVectorFieldView{
            linearization_m0_x.data(),
            linearization_m0_y.data(),
            linearization_m0_z.data(),
            linearization_magnetic_node_count};
        equilibrium_artifact.h_eff0_a_per_m = CartesianVectorFieldView{
            linearization_h_eff0_x.data(),
            linearization_h_eff0_y.data(),
            linearization_h_eff0_z.data(),
            linearization_magnetic_node_count};
        equilibrium_artifact.h_demag0_a_per_m = CartesianVectorFieldView{
            linearization_h_demag0_x.data(),
            linearization_h_demag0_y.data(),
            linearization_h_demag0_z.data(),
            linearization_magnetic_node_count};
        equilibrium_artifact.phi0 = payload.linearization_phi0;
        equilibrium_artifact.magnetic_node_count = linearization_magnetic_node_count;
        equilibrium_artifact.airbox_node_count = payload.linearization_phi0_count;
        equilibrium_artifact.accepted_for_linearization = true;
        equilibrium_artifact.demag_model = payload.demag_model;
        LinearizationBuildOptions linearization_options{};
        linearization_options.m0_norm_tolerance = payload.m0_norm_tolerance;
        linearization_options.equilibrium_torque_relative_tolerance =
            payload.equilibrium_torque_relative_tolerance;
        linearization_options.allow_m0_renormalization = false;
        LinearizationStateNative linearization_state{};
        LinearizationDiagnostics linearization_diagnostics{};
        const FrequencyDomainStatus linearization_status =
            build_linearization_state_from_equilibrium(
                equilibrium_artifact,
                linearization_options,
                linearization_state,
                linearization_diagnostics);
        if (linearization_status != FrequencyDomainStatus::ok) {
            std::string message = "shared-domain equilibrium linearization rejected";
            if (linearization_diagnostics.reject_reason[0] != '\0') {
                message += ": ";
                message += linearization_diagnostics.reject_reason;
            }
            if (linearization_diagnostics.error_message[0] != '\0') {
                message += " (";
                message += linearization_diagnostics.error_message;
                message += ')';
            }
            copy_error(out_result->error_message, message.c_str());
            return out_result->status;
        }
        std::vector<double> equilibrium_for_frames(
            payload.equilibrium_m0_xyz,
            payload.equilibrium_m0_xyz + payload.equilibrium_m0_xyz_count);
        linearization_node = 0u;
        for (std::uint64_t node = 0; node < node_count; ++node) {
            if (magnetic_node_mask[node] != 0u) {
                equilibrium_for_frames[3u * node] =
                    linearization_state.m0_xyz[3u * linearization_node];
                equilibrium_for_frames[3u * node + 1u] =
                    linearization_state.m0_xyz[3u * linearization_node + 1u];
                equilibrium_for_frames[3u * node + 2u] =
                    linearization_state.m0_xyz[3u * linearization_node + 2u];
                ++linearization_node;
                continue;
            }
            equilibrium_for_frames[3u * node] = 0.0;
            equilibrium_for_frames[3u * node + 1u] = 0.0;
            equilibrium_for_frames[3u * node + 2u] = 1.0;
        }
        std::vector<TangentFrameNode> tangent_frames(static_cast<std::size_t>(node_count));
        TangentFrameDiagnostics tangent_diagnostics{};
        if (build_tangent_frame(equilibrium_for_frames.data(),
                                node_count,
                                tangent_frames.data(),
                                &tangent_diagnostics) != FrequencyDomainStatus::ok) {
            copy_error(out_result->error_message, tangent_diagnostics.error_message);
            return out_result->status;
        }
        mfem::Array<int> boundary_marker;
        if (std::strcmp(payload.boundary_kind, "pure_neumann") != 0) {
            if (payload.boundary_marker == 0u ||
                payload.boundary_marker > static_cast<std::uint32_t>(std::numeric_limits<int>::max())) {
                copy_error(out_result->error_message,
                           "shared-domain Robin/Dirichlet payload requires a positive boundary marker");
                return out_result->status;
            }
            const int maximum_marker = std::max(1, mesh->bdr_attributes.Max());
            if (payload.boundary_marker > static_cast<std::uint32_t>(maximum_marker)) {
                copy_error(out_result->error_message,
                           "shared-domain payload boundary marker is absent from the MFEM mesh");
                return out_result->status;
            }
            boundary_marker.SetSize(maximum_marker);
            boundary_marker = 0;
            boundary_marker[static_cast<int>(payload.boundary_marker) - 1] = 1;
            for (const std::uint32_t periodic_marker : source.periodic_boundary_marker_set) {
                if (periodic_marker >= 1u && periodic_marker <= static_cast<std::uint32_t>(maximum_marker)) {
                    boundary_marker[static_cast<int>(periodic_marker) - 1] = 0;
                }
            }
        }
        PoissonAirboxBoundaryKind boundary_kind;
        if (std::strcmp(payload.boundary_kind, "robin") == 0) {
            boundary_kind = PoissonAirboxBoundaryKind::robin;
        } else if (std::strcmp(payload.boundary_kind, "dirichlet") == 0) {
            boundary_kind = PoissonAirboxBoundaryKind::dirichlet;
        } else if (std::strcmp(payload.boundary_kind, "pure_neumann") == 0) {
            boundary_kind = PoissonAirboxBoundaryKind::pure_neumann;
        } else {
            copy_error(out_result->error_message,
                       "shared-domain payload uses an unknown boundary kind");
            return out_result->status;
        }
        PoissonAirboxSharedDomainAssemblyRequest request{};
        request.scalar_space = &scalar_space;
        request.tangent_frames = tangent_frames.data();
        request.tangent_frame_count = node_count;
        request.magnetic_element_mask = magnetic_element_mask.data();
        request.magnetic_element_count = magnetic_element_mask.size();
        request.saturation_magnetization_a_per_m = saturation_magnetization.empty()
            ? nullptr
            : saturation_magnetization.data();
        request.saturation_magnetization_count = saturation_magnetization.size();
        request.uniform_saturation_magnetization_a_per_m =
            payload.uniform_saturation_magnetisation_a_per_m;
        request.gamma0_m_per_a_s = payload.gamma0_m_per_a_s;
        request.mu0_T_m_A = 1.25663706212e-6;
        const CsrMatrixView magnetic_a_qq{
            payload.magnetic_a_qq_csr.row_count,
            payload.magnetic_a_qq_csr.column_count,
            payload.magnetic_a_qq_csr.row_offsets,
            payload.magnetic_a_qq_csr.row_offsets_len,
            payload.magnetic_a_qq_csr.column_indices,
            payload.magnetic_a_qq_csr.column_indices_len,
            payload.magnetic_a_qq_csr.values,
            payload.magnetic_a_qq_csr.values_len};
        request.magnetic_a_qq_csr = &magnetic_a_qq;
        request.scalar_reduced_node = payload.scalar_reduced_node;
        request.scalar_reduced_node_count = payload.scalar_reduced_node_count;
        request.magnetic_reduced_node = payload.magnetic_reduced_node;
        request.magnetic_reduced_node_count = payload.magnetic_reduced_node_count;
        request.equivalence_classes_complete = true;
        request.boundary_kind = boundary_kind;
        request.robin_beta = payload.robin_beta;
        request.robin_boundary_marker = boundary_marker.Size() > 0 ? &boundary_marker : nullptr;
        return assemble_poisson_airbox_shared_domain(request, out_result);
    } catch (const std::exception &exception) {
        copy_error(out_result->error_message, exception.what());
    } catch (...) {
        copy_error(out_result->error_message, "shared-domain modal payload import failed");
    }
    out_result->status = FrequencyDomainStatus::operator_error;
    return out_result->status;
}

} // namespace fullmag::fem::frequency_domain

#endif
