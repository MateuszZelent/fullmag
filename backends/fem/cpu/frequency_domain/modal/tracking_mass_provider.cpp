#include "tracking_mass_provider.hpp"

#include <algorithm>
#include <cmath>
#include <exception>
#include <limits>
#include <map>
#include <set>
#include <utility>

namespace fullmag::fem::frequency_domain {

TrackingMassCsrSnapshot::TrackingMassCsrSnapshot(
    std::vector<std::size_t> row_offsets,
    std::vector<std::uint32_t> column_indices,
    std::vector<double> values_m3,
    std::vector<std::uint32_t> canonical_vertex_ids,
    std::vector<std::uint32_t> scalar_dof_ids,
    double magnetic_volume_m3)
    : row_offsets_(std::move(row_offsets)),
      column_indices_(std::move(column_indices)),
      values_m3_(std::move(values_m3)),
      canonical_vertex_ids_(std::move(canonical_vertex_ids)),
      scalar_dof_ids_(std::move(scalar_dof_ids)),
      magnetic_volume_m3_(magnetic_volume_m3)
{
}

namespace {

TrackingMassProviderResult failure(
    TrackingMassProviderStatus status,
    std::string diagnostic)
{
    TrackingMassProviderResult result;
    result.status = status;
    result.diagnostic = std::move(diagnostic);
    return result;
}

bool csr_value(
    const std::vector<std::size_t> &row_offsets,
    const std::vector<std::uint32_t> &column_indices,
    const std::vector<double> &values,
    std::size_t row,
    std::uint32_t column,
    double &value)
{
    const auto begin = column_indices.begin() + static_cast<std::ptrdiff_t>(row_offsets[row]);
    const auto end = column_indices.begin() + static_cast<std::ptrdiff_t>(row_offsets[row + 1u]);
    const auto found = std::lower_bound(begin, end, column);
    if (found == end || *found != column) {
        return false;
    }
    value = values[static_cast<std::size_t>(found - column_indices.begin())];
    return true;
}

bool has_positive_sampled_volume_jacobians(mfem::Mesh &mesh)
{
    if (mesh.GetNodes() != nullptr || mesh.CheckElementOrientation(false) != 0) {
        return false;
    }
    for (int element = 0; element < mesh.GetNE(); ++element) {
        const mfem::Geometry::Type geometry = mesh.GetElementGeometry(element);
        mfem::ElementTransformation *transformation = mesh.GetElementTransformation(element);
        if (transformation == nullptr) {
            return false;
        }
        const mfem::IntegrationRule &rule = mfem::IntRules.Get(geometry, 2);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            const mfem::IntegrationPoint &integration_point = rule.IntPoint(point);
            transformation->SetIntPoint(&integration_point);
            const double determinant = transformation->Jacobian().Det();
            if (!std::isfinite(determinant) || determinant <= 0.0) {
                return false;
            }
        }
    }
    return true;
}

} // namespace

TrackingMassProviderResult assemble_consistent_p1_tracking_mass(
    mfem::FiniteElementSpace &space,
    const std::vector<int> &magnetic_volume_attributes)
{
    if (magnetic_volume_attributes.empty()) {
        return failure(
            TrackingMassProviderStatus::invalid_argument,
            "at least one magnetic volume attribute is required");
    }

    mfem::Mesh *mesh = space.GetMesh();
    if (mesh == nullptr || mesh->Dimension() != 3 || mesh->SpaceDimension() != 3 ||
        mesh->GetNE() <= 0 ||
        mesh->GetNV() <= 0 || space.GetNE() != mesh->GetNE()) {
        return failure(
            TrackingMassProviderStatus::unsupported_space,
            "tracking mass requires a nonempty three-dimensional MFEM mesh and matching space");
    }
    if (!has_positive_sampled_volume_jacobians(*mesh)) {
        return failure(
            TrackingMassProviderStatus::invalid_matrix,
            "tracking mass requires an uncurved 3D mesh with positive sampled volume Jacobians");
    }

    const int vertex_count = mesh->GetNV();
    if (space.GetVDim() != 1 || space.GetNDofs() != vertex_count ||
        space.GetVSize() != vertex_count || space.GetTrueVSize() != vertex_count ||
        space.FEColl() == nullptr ||
        space.FEColl()->GetContType() != mfem::FiniteElementCollection::CONTINUOUS ||
        space.FEColl()->GetOrder() != 1) {
        return failure(
            TrackingMassProviderStatus::unsupported_space,
            "tracking mass requires a conforming scalar continuous P1 space with one true DOF per vertex");
    }

    std::vector<int> vertex_dofs(static_cast<std::size_t>(vertex_count), -1);
    mfem::Array<int> dofs;
    for (int vertex = 0; vertex < vertex_count; ++vertex) {
        space.GetVertexDofs(vertex, dofs);
        if (dofs.Size() != 1 || dofs[0] != vertex) {
            return failure(
                TrackingMassProviderStatus::unsupported_space,
                "scalar P1 vertex DOFs do not preserve canonical vertex ordering");
        }
        vertex_dofs[static_cast<std::size_t>(vertex)] = dofs[0];
    }

    if (mesh->attributes.Size() == 0) {
        return failure(
            TrackingMassProviderStatus::invalid_argument,
            "MFEM mesh has no volume attributes");
    }
    const int maximum_attribute = mesh->attributes.Max();
    if (maximum_attribute <= 0) {
        return failure(
            TrackingMassProviderStatus::invalid_argument,
            "MFEM mesh has no positive volume attribute");
    }

    std::set<int> present_attributes;
    for (int element = 0; element < mesh->GetNE(); ++element) {
        const int attribute = mesh->GetAttribute(element);
        if (attribute <= 0 || attribute > maximum_attribute) {
            return failure(
                TrackingMassProviderStatus::invalid_matrix,
                "MFEM mesh contains an invalid volume attribute");
        }
        present_attributes.insert(attribute);
    }

    std::vector<unsigned char> selected_attribute(
        static_cast<std::size_t>(maximum_attribute) + 1u, 0u);
    for (int attribute : magnetic_volume_attributes) {
        if (attribute <= 0 || attribute > maximum_attribute ||
            present_attributes.find(attribute) == present_attributes.end()) {
            return failure(
                TrackingMassProviderStatus::invalid_argument,
                "requested magnetic volume attribute is absent from the mesh");
        }
        if (selected_attribute[static_cast<std::size_t>(attribute)] != 0u) {
            return failure(
                TrackingMassProviderStatus::invalid_argument,
                "magnetic volume attributes must not contain duplicates");
        }
        selected_attribute[static_cast<std::size_t>(attribute)] = 1u;
    }

    mfem::Array<int> attribute_marker(maximum_attribute);
    attribute_marker = 0;
    for (int attribute : magnetic_volume_attributes) {
        attribute_marker[attribute - 1] = 1;
    }

    std::vector<unsigned char> active_vertex(static_cast<std::size_t>(vertex_count), 0u);
    int selected_element_count = 0;
    for (int element = 0; element < mesh->GetNE(); ++element) {
        if (selected_attribute[static_cast<std::size_t>(mesh->GetAttribute(element))] == 0u) {
            continue;
        }
        ++selected_element_count;

        const mfem::FiniteElement *finite_element = space.GetFE(element);
        mfem::Array<int> vertices;
        mfem::Array<int> element_dofs;
        mesh->GetElementVertices(element, vertices);
        space.GetElementDofs(element, element_dofs);
        const mfem::Geometry::Type geometry = mesh->GetElementGeometry(element);
        if ((geometry != mfem::Geometry::TETRAHEDRON && geometry != mfem::Geometry::PRISM) ||
            finite_element == nullptr || finite_element->GetOrder() != 1 ||
            finite_element->GetDof() != vertices.Size() ||
            element_dofs.Size() != vertices.Size()) {
            return failure(
                TrackingMassProviderStatus::unsupported_space,
                "selected magnetic cells must be linear Tet4 or Prism6 with scalar P1 vertex DOFs");
        }

        std::vector<int> expected_dofs;
        std::vector<int> observed_dofs;
        expected_dofs.reserve(static_cast<std::size_t>(vertices.Size()));
        observed_dofs.reserve(static_cast<std::size_t>(element_dofs.Size()));
        for (int local = 0; local < vertices.Size(); ++local) {
            const int vertex = vertices[local];
            if (vertex < 0 || vertex >= vertex_count) {
                return failure(
                    TrackingMassProviderStatus::invalid_matrix,
                    "selected volume element references an invalid canonical vertex");
            }
            expected_dofs.push_back(vertex_dofs[static_cast<std::size_t>(vertex)]);
            active_vertex[static_cast<std::size_t>(vertex)] = 1u;
            observed_dofs.push_back(element_dofs[local]);
        }
        std::sort(expected_dofs.begin(), expected_dofs.end());
        std::sort(observed_dofs.begin(), observed_dofs.end());
        if (expected_dofs != observed_dofs) {
            return failure(
                TrackingMassProviderStatus::unsupported_space,
                "selected element DOFs do not match its canonical P1 vertices");
        }
    }
    if (selected_element_count == 0) {
        return failure(
            TrackingMassProviderStatus::empty_magnetic_domain,
            "no MFEM volume element belongs to the requested magnetic attributes");
    }

    std::vector<std::uint32_t> canonical_vertices;
    std::vector<std::uint32_t> scalar_dof_ids;
    canonical_vertices.reserve(static_cast<std::size_t>(vertex_count));
    scalar_dof_ids.reserve(static_cast<std::size_t>(vertex_count));
    for (int vertex = 0; vertex < vertex_count; ++vertex) {
        const int dof = vertex_dofs[static_cast<std::size_t>(vertex)];
        canonical_vertices.push_back(static_cast<std::uint32_t>(vertex));
        scalar_dof_ids.push_back(static_cast<std::uint32_t>(dof));
    }

    try {
        mfem::BilinearForm form(&space);
        form.SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
        form.AddDomainIntegrator(new mfem::MassIntegrator(), attribute_marker);
        form.Assemble();
        form.Finalize();

        mfem::SparseMatrix &matrix = form.SpMat();
        const int matrix_rows = matrix.Height();
        const int nonzero_count = matrix.NumNonZeroElems();
        const int *row_begin = matrix.GetI();
        const int *column = matrix.GetJ();
        double *entry = matrix.GetData();
        if (matrix_rows != vertex_count || matrix.Width() != vertex_count ||
            nonzero_count < 0 || row_begin == nullptr ||
            (nonzero_count > 0 && (column == nullptr || entry == nullptr)) ||
            row_begin[0] != 0 || row_begin[matrix_rows] != nonzero_count) {
            return failure(
                TrackingMassProviderStatus::invalid_matrix,
                "MFEM did not produce a complete scalar P1 CSR matrix");
        }

        std::vector<std::size_t> row_offsets{0u};
        std::vector<std::uint32_t> column_indices;
        std::vector<double> values_m3;
        double magnetic_volume_m3 = 0.0;
        const double symmetry_tolerance = 128.0 * std::numeric_limits<double>::epsilon();

        for (int full_row = 0; full_row < matrix_rows; ++full_row) {
            if (row_begin[full_row] < 0 || row_begin[full_row] > row_begin[full_row + 1] ||
                row_begin[full_row + 1] > nonzero_count) {
                return failure(
                    TrackingMassProviderStatus::invalid_matrix,
                    "MFEM CSR row offsets are not monotonic and bounded");
            }
            const int row_dof = full_row;
            const bool active_row = active_vertex[static_cast<std::size_t>(full_row)] != 0u;
            std::map<std::uint32_t, double> row_entries;
            for (int offset = row_begin[full_row]; offset < row_begin[full_row + 1]; ++offset) {
                const int full_column = column[offset];
                const double value = entry[offset];
                if (full_column < 0 || full_column >= matrix_rows || !std::isfinite(value)) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "MFEM CSR contains an invalid column or nonfinite value");
                }
                if (value == 0.0) {
                    continue;
                }
                if (!active_row) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "assembled magnetic mass has a nonzero air-only row");
                }
                if (active_vertex[static_cast<std::size_t>(full_column)] == 0u) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "assembled magnetic mass couples to a DOF outside its selected domain");
                }
                double &combined = row_entries[static_cast<std::uint32_t>(full_column)];
                combined += value;
                if (!std::isfinite(combined)) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "coalesced tracking mass entry is nonfinite");
                }
            }

            double diagonal = 0.0;
            double row_sum = 0.0;
            for (const auto &item : row_entries) {
                if (item.first == static_cast<std::uint32_t>(row_dof)) {
                    diagonal = item.second;
                }
                row_sum += item.second;
                if (!std::isfinite(row_sum)) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "tracking mass row sum is nonfinite");
                }
                column_indices.push_back(item.first);
                values_m3.push_back(item.second);
            }
            if (active_row && (!(diagonal > 0.0) || !(row_sum > 0.0))) {
                return failure(
                    TrackingMassProviderStatus::invalid_matrix,
                    "magnetic P1 mass has a nonpositive diagonal or row sum");
            }
            if (active_row) {
                magnetic_volume_m3 += row_sum;
                if (!std::isfinite(magnetic_volume_m3)) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "total magnetic volume from the tracking mass is nonfinite");
                }
            } else if (row_sum != 0.0 || !row_entries.empty()) {
                return failure(
                    TrackingMassProviderStatus::invalid_matrix,
                    "air-only tracking mass rows must remain empty and zero");
            }
            row_offsets.push_back(column_indices.size());
        }

        if (!(magnetic_volume_m3 > 0.0) ||
            row_offsets.size() != static_cast<std::size_t>(vertex_count) + 1u) {
            return failure(
                TrackingMassProviderStatus::invalid_matrix,
                "tracking mass CSR does not cover every canonical physical vertex");
        }

        for (std::size_t row = 0; row < static_cast<std::size_t>(vertex_count); ++row) {
            for (std::size_t offset = row_offsets[row]; offset < row_offsets[row + 1u]; ++offset) {
                double reverse = 0.0;
                const std::uint32_t other_row = column_indices[offset];
                if (!csr_value(
                        row_offsets, column_indices, values_m3, other_row,
                        static_cast<std::uint32_t>(row), reverse)) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "tracking mass CSR is missing a symmetric entry");
                }
                const double value = values_m3[offset];
                const double scale = std::max(std::abs(value), std::abs(reverse));
                if (scale > 0.0 && std::abs(value - reverse) > symmetry_tolerance * scale) {
                    return failure(
                        TrackingMassProviderStatus::invalid_matrix,
                        "tracking mass CSR is not symmetric within assembly precision");
                }
            }
        }

        TrackingMassProviderResult result;
        result.status = TrackingMassProviderStatus::success;
        result.snapshot.reset(new TrackingMassCsrSnapshot(
            std::move(row_offsets),
            std::move(column_indices),
            std::move(values_m3),
            std::move(canonical_vertices),
            std::move(scalar_dof_ids),
            magnetic_volume_m3));
        result.diagnostic = "assembled unweighted consistent scalar P1 tracking mass";
        return result;
    } catch (const std::exception &exception) {
        return failure(
            TrackingMassProviderStatus::assembly_failed,
            std::string("MFEM tracking mass assembly failed: ") + exception.what());
    } catch (...) {
        return failure(
            TrackingMassProviderStatus::assembly_failed,
            "MFEM tracking mass assembly failed with a non-standard exception");
    }
}

} // namespace fullmag::fem::frequency_domain
