#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
#include "context.hpp"
#include "fem_common.hpp"
#include "core/fem_mesh.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "frequency_domain/mesh_symmetry_certificate.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_canonical_mesh_identity(
    const fullmag::fem::FemMeshRuntimeState &context_mesh,
    const fullmag::fem::FemMeshRuntimeState &modal_mesh)
{
    check(context_mesh.n_nodes == modal_mesh.n_nodes, "mesh import preserves node count");
    check(context_mesh.n_elements == modal_mesh.n_elements,
          "mesh import preserves element count");
    check(context_mesh.n_boundary_faces == modal_mesh.n_boundary_faces,
          "mesh import preserves boundary-face count");
    check(context_mesh.nodes_xyz == modal_mesh.nodes_xyz,
          "mesh import preserves ordered coordinates");
    check(context_mesh.cell_types == modal_mesh.cell_types,
          "mesh import preserves ordered cell types");
    check(context_mesh.cell_offsets == modal_mesh.cell_offsets,
          "mesh import preserves cell offsets");
    check(context_mesh.cell_nodes == modal_mesh.cell_nodes,
          "mesh import preserves ordered cell connectivity");
    check(context_mesh.cell_global_ordinals == modal_mesh.cell_global_ordinals,
          "mesh import preserves cell global ordinals");
    check(context_mesh.cell_markers == modal_mesh.cell_markers,
          "mesh import preserves cell markers");
    check(context_mesh.facet_types == modal_mesh.facet_types,
          "mesh import preserves ordered facet types");
    check(context_mesh.facet_roles == modal_mesh.facet_roles,
          "mesh import preserves facet roles");
    check(context_mesh.facet_offsets == modal_mesh.facet_offsets,
          "mesh import preserves facet offsets");
    check(context_mesh.facet_nodes == modal_mesh.facet_nodes,
          "mesh import preserves ordered facet connectivity");
    check(context_mesh.facet_global_ordinals == modal_mesh.facet_global_ordinals,
          "mesh import preserves facet global ordinals");
    check(context_mesh.facet_markers == modal_mesh.facet_markers,
          "mesh import preserves facet markers");
    check(context_mesh.periodic_node_pairs == modal_mesh.periodic_node_pairs,
          "mesh import preserves periodic node pairs");
    check(context_mesh.periodic_reduced_node == modal_mesh.periodic_reduced_node,
          "mesh import preserves periodic reduction classes");
    check(context_mesh.periodic_representative_nodes ==
              modal_mesh.periodic_representative_nodes,
          "mesh import preserves periodic representatives");
    check(context_mesh.periodic_reduced_node_count ==
              modal_mesh.periodic_reduced_node_count,
          "mesh import preserves periodic reduced-node count");
    check(context_mesh.periodic_boundary_marker_set ==
              modal_mesh.periodic_boundary_marker_set,
          "mesh import preserves periodic boundary markers");
}

void check_mfem_ordered_topology_identity(
    const fullmag::fem::FemMeshRuntimeState &context_mesh,
    const fullmag::fem::FemMeshRuntimeState &modal_mesh)
{
    std::unique_ptr<mfem::Mesh> context_mfem;
    std::unique_ptr<mfem::Mesh> modal_mfem;
    std::string context_error;
    std::string modal_error;
    check(fullmag::fem::build_mfem_mesh(context_mesh, context_mfem, context_error),
          context_error.c_str());
    check(fullmag::fem::build_mfem_mesh(modal_mesh, modal_mfem, modal_error),
          modal_error.c_str());
    check(context_mfem->GetNV() == modal_mfem->GetNV(),
          "MFEM import preserves vertex count");
    check(context_mfem->GetNE() == modal_mfem->GetNE(),
          "MFEM import preserves element count");
    check(context_mfem->GetNBE() == modal_mfem->GetNBE(),
          "MFEM import preserves boundary-element count");
    for (int vertex = 0; vertex < context_mfem->GetNV(); ++vertex) {
        const double *context_xyz = context_mfem->GetVertex(vertex);
        const double *modal_xyz = modal_mfem->GetVertex(vertex);
        check(context_xyz[0] == modal_xyz[0] && context_xyz[1] == modal_xyz[1] &&
                  context_xyz[2] == modal_xyz[2],
              "MFEM import preserves ordered vertex coordinates");
    }
    for (int element = 0; element < context_mfem->GetNE(); ++element) {
        mfem::Array<int> context_vertices;
        mfem::Array<int> modal_vertices;
        context_mfem->GetElementVertices(element, context_vertices);
        modal_mfem->GetElementVertices(element, modal_vertices);
        check(context_mfem->GetElementGeometry(element) ==
                  modal_mfem->GetElementGeometry(element),
              "MFEM import preserves ordered element geometry");
        check(context_mfem->GetAttribute(element) == modal_mfem->GetAttribute(element),
              "MFEM import preserves ordered element attributes");
        check(context_vertices == modal_vertices,
              "MFEM import preserves ordered element vertices");
    }
    for (int boundary = 0; boundary < context_mfem->GetNBE(); ++boundary) {
        mfem::Array<int> context_vertices;
        mfem::Array<int> modal_vertices;
        context_mfem->GetBdrElementVertices(boundary, context_vertices);
        modal_mfem->GetBdrElementVertices(boundary, modal_vertices);
        check(context_mfem->GetBdrElementGeometry(boundary) ==
                  modal_mfem->GetBdrElementGeometry(boundary),
              "MFEM import preserves ordered boundary geometry");
        check(context_mfem->GetBdrAttribute(boundary) ==
                  modal_mfem->GetBdrAttribute(boundary),
              "MFEM import preserves ordered boundary attributes");
        check(context_vertices == modal_vertices,
              "MFEM import preserves ordered boundary vertices");
    }
}

void check_context_modal_mesh_import_identity(const fullmag_fem_mesh_desc &mesh)
{
    fullmag::fem::Context context;
    std::string context_error;
    check(fullmag::fem::initialize_mesh_plan_fields(context, mesh, context_error),
          context_error.c_str());
    fullmag::fem::FemMeshRuntimeState modal_mesh;
    std::string modal_error;
    check(fd::import_modal_shared_domain_mesh(mesh, modal_mesh, modal_error),
          modal_error.c_str());
    check_canonical_mesh_identity(context.mesh, modal_mesh);
    check_mfem_ordered_topology_identity(context.mesh, modal_mesh);
}

void check_context_modal_mesh_rejection_identity(
    const fullmag_fem_mesh_desc &mesh,
    const char *message)
{
    fullmag::fem::Context context;
    std::string context_error;
    check(!fullmag::fem::initialize_mesh_plan_fields(context, mesh, context_error), message);
    fullmag::fem::FemMeshRuntimeState modal_mesh;
    std::string modal_error;
    check(!fd::import_modal_shared_domain_mesh(mesh, modal_mesh, modal_error), message);
    check(!context_error.empty() && context_error == modal_error,
          "Context and modal mesh import reject through the same admission contract");
}

double matrix_value(const fd::PoissonAirboxSharedDomainCsrMatrix &matrix,
                    std::uint64_t row,
                    std::uint64_t column)
{
    check(row < matrix.row_count && column < matrix.column_count,
          "matrix lookup is in range");
    for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
         entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
         ++entry) {
        if (matrix.column_indices[entry] == column) {
            return matrix.values[entry];
        }
    }
    return 0.0;
}

std::complex<double> complex_matrix_value(
    const fd::PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    std::uint64_t row,
    std::uint64_t column)
{
    check(row < matrix.row_count && column < matrix.column_count,
          "complex matrix lookup is in range");
    for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
         entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
         ++entry) {
        if (matrix.column_indices[entry] == column) {
            return matrix.values[entry];
        }
    }
    return std::complex<double>(0.0, 0.0);
}

double max_matrix_difference(const fd::PoissonAirboxSharedDomainCsrMatrix &left,
                             const fd::PoissonAirboxSharedDomainCsrMatrix &right)
{
    check(left.row_count == right.row_count && left.column_count == right.column_count,
          "matrix comparison requires matching dimensions");
    double maximum = 0.0;
    for (std::uint64_t row = 0; row < left.row_count; ++row) {
        for (std::uint64_t column = 0; column < left.column_count; ++column) {
            maximum = std::max(
                maximum,
                std::abs(matrix_value(left, row, column) - matrix_value(right, row, column)));
        }
    }
    return maximum;
}

std::size_t numerical_rank(std::vector<double> matrix, std::size_t dimension)
{
    check(matrix.size() == dimension * dimension,
          "numerical rank requires a square dense matrix");
    double scale = 0.0;
    for (const double value : matrix) {
        scale = std::max(scale, std::abs(value));
    }
    const double tolerance = 1.0e-10 * std::max(1.0, scale);
    std::size_t rank = 0u;
    for (std::size_t column = 0u; column < dimension && rank < dimension; ++column) {
        std::size_t pivot = rank;
        for (std::size_t row = rank + 1u; row < dimension; ++row) {
            if (std::abs(matrix[row * dimension + column]) >
                std::abs(matrix[pivot * dimension + column])) {
                pivot = row;
            }
        }
        if (std::abs(matrix[pivot * dimension + column]) <= tolerance) {
            continue;
        }
        if (pivot != rank) {
            for (std::size_t entry = 0u; entry < dimension; ++entry) {
                std::swap(matrix[rank * dimension + entry],
                           matrix[pivot * dimension + entry]);
            }
        }
        const double pivot_value = matrix[rank * dimension + column];
        for (std::size_t row = rank + 1u; row < dimension; ++row) {
            const double factor = matrix[row * dimension + column] / pivot_value;
            for (std::size_t entry = column; entry < dimension; ++entry) {
                matrix[row * dimension + entry] -=
                    factor * matrix[rank * dimension + entry];
            }
        }
        ++rank;
    }
    return rank;
}

double tetra_volume_from_vertices(const mfem::Mesh &mesh, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    check(vertices.Size() == 4, "independent B_qq oracle requires tetrahedral elements");
    const double *x0 = mesh.GetVertex(vertices[0]);
    const double *x1 = mesh.GetVertex(vertices[1]);
    const double *x2 = mesh.GetVertex(vertices[2]);
    const double *x3 = mesh.GetVertex(vertices[3]);
    const double a[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};
    const double b[3] = {x2[0] - x0[0], x2[1] - x0[1], x2[2] - x0[2]};
    const double c[3] = {x3[0] - x0[0], x3[1] - x0[1], x3[2] - x0[2]};
    const double determinant =
        a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
    const double volume = std::abs(determinant) / 6.0;
    check(std::isfinite(volume) && volume > 0.0,
          "independent B_qq oracle requires positive tetrahedron volume");
    return volume;
}

void tetra_barycentric_gradients(
    const mfem::Mesh &mesh,
    int element,
    double gradients[4][3])
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    check(vertices.Size() == 4,
          "independent exchange oracle requires four tetrahedron vertices");
    const double *x0 = mesh.GetVertex(vertices[0]);
    const double *x1 = mesh.GetVertex(vertices[1]);
    const double *x2 = mesh.GetVertex(vertices[2]);
    const double *x3 = mesh.GetVertex(vertices[3]);
    const double a[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};
    const double b[3] = {x2[0] - x0[0], x2[1] - x0[1], x2[2] - x0[2]};
    const double c[3] = {x3[0] - x0[0], x3[1] - x0[1], x3[2] - x0[2]};
    const double b_cross_c[3] = {
        b[1] * c[2] - b[2] * c[1],
        b[2] * c[0] - b[0] * c[2],
        b[0] * c[1] - b[1] * c[0],
    };
    const double c_cross_a[3] = {
        c[1] * a[2] - c[2] * a[1],
        c[2] * a[0] - c[0] * a[2],
        c[0] * a[1] - c[1] * a[0],
    };
    const double a_cross_b[3] = {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
    const double determinant = a[0] * b_cross_c[0] +
        a[1] * b_cross_c[1] + a[2] * b_cross_c[2];
    check(std::isfinite(determinant) && std::abs(determinant) > 0.0,
          "independent exchange oracle requires a non-degenerate tetrahedron");
    for (int axis = 0; axis < 3; ++axis) {
        gradients[1][axis] = b_cross_c[axis] / determinant;
        gradients[2][axis] = c_cross_a[axis] / determinant;
        gradients[3][axis] = a_cross_b[axis] / determinant;
        gradients[0][axis] = -gradients[1][axis] - gradients[2][axis] - gradients[3][axis];
    }
}

std::vector<double> independent_exchange_oracle(
    mfem::FiniteElementSpace &scalar_space,
    const std::vector<std::uint8_t> &magnetic_elements,
    const std::vector<double> &tangent_frames,
    double exchange_stiffness,
    std::uint64_t node_count)
{
    const std::uint64_t q_count = 2u * node_count;
    std::vector<double> oracle(static_cast<std::size_t>(q_count * q_count), 0.0);
    mfem::Mesh *mesh = scalar_space.GetMesh();
    check(mesh != nullptr, "exchange oracle requires an MFEM mesh");
    check(magnetic_elements.size() == static_cast<std::size_t>(mesh->GetNE()),
          "exchange oracle requires one mask entry per element");
    for (int element = 0; element < mesh->GetNE(); ++element) {
        if (magnetic_elements[static_cast<std::size_t>(element)] == 0u) {
            continue;
        }
        mfem::Array<int> dofs;
        scalar_space.GetElementDofs(element, dofs);
        check(dofs.Size() == 4, "exchange oracle requires P1 tetrahedra");
        const mfem::FiniteElement *finite_element = scalar_space.GetFE(element);
        check(finite_element != nullptr &&
                  finite_element->GetGeomType() == mfem::Geometry::TETRAHEDRON &&
                  finite_element->GetOrder() == 1,
              "exchange oracle requires P1 tetrahedral finite elements");
        double gradients[4][3]{};
        tetra_barycentric_gradients(*mesh, element, gradients);
        const double weight = tetra_volume_from_vertices(*mesh, element);
        for (int local_row = 0; local_row < dofs.Size(); ++local_row) {
                const std::uint64_t row_node = static_cast<std::uint64_t>(
                    dofs[local_row] >= 0 ? dofs[local_row] : -1 - dofs[local_row]);
                const double row_sign = dofs[local_row] >= 0 ? 1.0 : -1.0;
                for (int local_column = 0; local_column < dofs.Size(); ++local_column) {
                    const std::uint64_t column_node = static_cast<std::uint64_t>(
                        dofs[local_column] >= 0 ? dofs[local_column] : -1 - dofs[local_column]);
                    const double column_sign = dofs[local_column] >= 0 ? 1.0 : -1.0;
                    double gradient_dot = 0.0;
                    for (int axis = 0; axis < 3; ++axis) {
                        gradient_dot += gradients[local_row][axis] *
                            gradients[local_column][axis];
                    }
                    const double coefficient = row_sign * column_sign *
                        2.0 * exchange_stiffness * gradient_dot * weight;
                    for (std::uint32_t row_component = 0; row_component < 2u;
                         ++row_component) {
                        const double *row_frame = &tangent_frames[
                            static_cast<std::size_t>(6u * row_node + 3u * row_component)];
                        for (std::uint32_t column_component = 0; column_component < 2u;
                             ++column_component) {
                            const double *column_frame = &tangent_frames[
                                static_cast<std::size_t>(6u * column_node +
                                                         3u * column_component)];
                            const double frame_dot = row_frame[0] * column_frame[0] +
                                row_frame[1] * column_frame[1] +
                                row_frame[2] * column_frame[2];
                            oracle[static_cast<std::size_t>(
                                (2u * row_node + row_component) * q_count +
                                2u * column_node + column_component)] +=
                                coefficient * frame_dot;
                        }
                    }
                }
        }
    }
    return oracle;
}

struct NativeExchangeDescriptorFixture {
    explicit NativeExchangeDescriptorFixture(std::uint64_t node_count)
        : tangent_frame_xyz(static_cast<std::size_t>(6u * node_count), 0.0),
          equilibrium_m0_xyz(static_cast<std::size_t>(3u * node_count), 0.0),
          effective_field_h_eff0_xyz(static_cast<std::size_t>(3u * node_count), 0.0),
          alpha_per_node(static_cast<std::size_t>(node_count), 0.01),
          tangent_frames(static_cast<std::size_t>(node_count))
    {
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            equilibrium_m0_xyz[3u * node + 2u] = 1.0;
            tangent_frame_xyz[6u * node] = 1.0;
            tangent_frame_xyz[6u * node + 4u] = 1.0;
            tangent_frames[static_cast<std::size_t>(node)].m[2] = 1.0;
            tangent_frames[static_cast<std::size_t>(node)].e1[0] = 1.0;
            tangent_frames[static_cast<std::size_t>(node)].e2[1] = 1.0;
        }
        descriptor.abi_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION;
        descriptor.struct_size = sizeof(descriptor);
        descriptor.node_count = node_count;
        descriptor.tangent_dof_count = 2u * node_count;
        descriptor.tangent_frame_xyz = tangent_frame_xyz.data();
        descriptor.tangent_frame_xyz_count = tangent_frame_xyz.size();
        descriptor.equilibrium_m0_xyz = equilibrium_m0_xyz.data();
        descriptor.equilibrium_m0_xyz_count = equilibrium_m0_xyz.size();
        descriptor.effective_field_h_eff0_xyz = effective_field_h_eff0_xyz.data();
        descriptor.effective_field_h_eff0_xyz_count = effective_field_h_eff0_xyz.size();
        descriptor.alpha_per_node = alpha_per_node.data();
        descriptor.alpha_per_node_count = alpha_per_node.size();
        descriptor.uniform_saturation_magnetisation_a_per_m = 2.0;
        descriptor.schema_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA;
        descriptor.coordinate_unit = "m";
        descriptor.magnetisation_unit = "A/m";
        descriptor.time_unit = "s";
        descriptor.frequency_unit = "Hz";
        descriptor.angular_frequency_unit = "rad/s";
        descriptor.linearization_state_digest =
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        descriptor.equilibrium_digest = descriptor.linearization_state_digest;
        descriptor.operator_input_digest = descriptor.linearization_state_digest;
        descriptor.term_presence_mask = FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE;
        descriptor.exchange_term_digest = descriptor.linearization_state_digest;
        descriptor.exchange_edges = &exchange_edge;
        descriptor.exchange_edge_count = 1u;
    }

    fullmag_fem_frequency_domain_exchange_edge exchange_edge{0u, 1u, 2.0};
    std::vector<double> tangent_frame_xyz;
    std::vector<double> equilibrium_m0_xyz;
    std::vector<double> effective_field_h_eff0_xyz;
    std::vector<double> alpha_per_node;
    std::vector<fd::TangentFrameNode> tangent_frames;
    FullmagFemModalLinearizationDescriptor descriptor{};
};

void invert_3x3(const double matrix[3][3], double inverse[3][3], double *determinant)
{
    const double det =
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) -
        matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0]) +
        matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
    check(std::isfinite(det) && std::abs(det) > 0.0,
          "independent prism exchange oracle requires a non-degenerate Jacobian");
    inverse[0][0] = (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) / det;
    inverse[0][1] = (matrix[0][2] * matrix[2][1] - matrix[0][1] * matrix[2][2]) / det;
    inverse[0][2] = (matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1]) / det;
    inverse[1][0] = (matrix[1][2] * matrix[2][0] - matrix[1][0] * matrix[2][2]) / det;
    inverse[1][1] = (matrix[0][0] * matrix[2][2] - matrix[0][2] * matrix[2][0]) / det;
    inverse[1][2] = (matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2]) / det;
    inverse[2][0] = (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]) / det;
    inverse[2][1] = (matrix[0][1] * matrix[2][0] - matrix[0][0] * matrix[2][1]) / det;
    inverse[2][2] = (matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]) / det;
    *determinant = det;
}

std::vector<double> independent_prism_exchange_exact_affine_oracle(
    mfem::FiniteElementSpace &scalar_space,
    const std::vector<std::uint8_t> &magnetic_elements,
    const std::vector<double> &tangent_frames,
    double exchange_stiffness,
    std::uint64_t node_count)
{
    const std::uint64_t q_count = 2u * node_count;
    std::vector<double> oracle(static_cast<std::size_t>(q_count * q_count), 0.0);
    mfem::Mesh *mesh = scalar_space.GetMesh();
    check(mesh != nullptr, "independent prism exchange oracle requires an MFEM mesh");
    check(magnetic_elements.size() == static_cast<std::size_t>(mesh->GetNE()),
          "independent prism exchange oracle requires one mask entry per element");
    check(tangent_frames.size() == static_cast<std::size_t>(6u * node_count),
          "independent prism exchange oracle requires two three-vector frames per node");
    // Independent affine prism rule: three degree-two triangle points and two
    // degree-two Gauss points on the interval.  This is not read from MFEM and
    // exactly integrates the quadratic grad(N_i).grad(N_j) form on an affine
    // prism.  It therefore cannot reproduce the producer's old centroid rule.
    constexpr double kTrianglePoints[3][2] = {
        {1.0 / 6.0, 1.0 / 6.0},
        {2.0 / 3.0, 1.0 / 6.0},
        {1.0 / 6.0, 2.0 / 3.0},
    };
    constexpr double kTriangleWeight = 1.0 / 6.0;
    const double kSegmentPoints[2] = {
        0.5 - 1.0 / (2.0 * std::sqrt(3.0)),
        0.5 + 1.0 / (2.0 * std::sqrt(3.0)),
    };
    constexpr double kSegmentWeight = 0.5;
    for (int element = 0; element < mesh->GetNE(); ++element) {
        if (magnetic_elements[static_cast<std::size_t>(element)] == 0u) {
            continue;
        }
        mfem::Array<int> dofs;
        mfem::Array<int> vertices;
        scalar_space.GetElementDofs(element, dofs);
        mesh->GetElementVertices(element, vertices);
        const mfem::FiniteElement *finite_element = scalar_space.GetFE(element);
        check(dofs.Size() == 6 && vertices.Size() == 6 && finite_element != nullptr &&
                  finite_element->GetGeomType() == mfem::Geometry::PRISM &&
                  finite_element->GetOrder() == 1,
              "independent prism exchange oracle requires P1 prism6 elements");
        const double *x0 = mesh->GetVertex(vertices[0]);
        double jacobian[3][3]{};
        for (int column = 0; column < 3; ++column) {
            const double *vertex = mesh->GetVertex(vertices[column + 1]);
            for (int axis = 0; axis < 3; ++axis) {
                jacobian[axis][column] = vertex[axis] - x0[axis];
            }
        }
        double inverse_jacobian[3][3]{};
        double determinant = 0.0;
        invert_3x3(jacobian, inverse_jacobian, &determinant);
        for (const auto &triangle_point : kTrianglePoints) {
            for (const double segment_point : kSegmentPoints) {
                const double reference_point[3] = {
                    triangle_point[0], triangle_point[1], segment_point};
                const double reference_gradients[6][3] = {
                    {reference_point[2] - 1.0, reference_point[2] - 1.0,
                     reference_point[0] + reference_point[1] - 1.0},
                    {1.0 - reference_point[2], 0.0, -reference_point[0]},
                    {0.0, 1.0 - reference_point[2], -reference_point[1]},
                    {-reference_point[2], -reference_point[2],
                     1.0 - reference_point[0] - reference_point[1]},
                    {reference_point[2], 0.0, reference_point[0]},
                    {0.0, reference_point[2], reference_point[1]},
                };
                double physical_gradients[6][3]{};
                for (int local = 0; local < 6; ++local) {
                    for (int axis = 0; axis < 3; ++axis) {
                        for (int reference_axis = 0; reference_axis < 3;
                             ++reference_axis) {
                            physical_gradients[local][axis] +=
                                reference_gradients[local][reference_axis] *
                                inverse_jacobian[reference_axis][axis];
                        }
                    }
                }
                const double weight = std::abs(determinant) *
                    kTriangleWeight * kSegmentWeight;
                for (int local_row = 0; local_row < 6; ++local_row) {
                    const std::uint64_t row_node = static_cast<std::uint64_t>(
                        dofs[local_row] >= 0 ? dofs[local_row] : -1 - dofs[local_row]);
                    const double row_sign = dofs[local_row] >= 0 ? 1.0 : -1.0;
                    for (int local_column = 0; local_column < 6; ++local_column) {
                        const std::uint64_t column_node = static_cast<std::uint64_t>(
                            dofs[local_column] >= 0 ? dofs[local_column] :
                                                       -1 - dofs[local_column]);
                        const double column_sign = dofs[local_column] >= 0 ? 1.0 : -1.0;
                        double gradient_dot = 0.0;
                        for (int axis = 0; axis < 3; ++axis) {
                            gradient_dot += physical_gradients[local_row][axis] *
                                physical_gradients[local_column][axis];
                        }
                        const double coefficient = row_sign * column_sign * 2.0 *
                            exchange_stiffness * gradient_dot * weight;
                        for (std::uint32_t row_component = 0; row_component < 2u;
                             ++row_component) {
                            const double *row_frame = &tangent_frames[
                                static_cast<std::size_t>(
                                    6u * row_node + 3u * row_component)];
                            for (std::uint32_t column_component = 0; column_component < 2u;
                                 ++column_component) {
                                const double *column_frame = &tangent_frames[
                                    static_cast<std::size_t>(
                                        6u * column_node + 3u * column_component)];
                                const double frame_dot = row_frame[0] * column_frame[0] +
                                    row_frame[1] * column_frame[1] +
                                    row_frame[2] * column_frame[2];
                                oracle[static_cast<std::size_t>(
                                    (2u * row_node + row_component) * q_count +
                                    2u * column_node + column_component)] +=
                                    coefficient * frame_dot;
                            }
                        }
                    }
                }
            }
        }
    }
    return oracle;
}

struct IndependentPrismQuadraturePoint {
    double xi;
    double eta;
    double zeta;
    double weight;
};

std::vector<IndependentPrismQuadraturePoint> independent_prism_gauss_rule(
    int point_count_per_axis)
{
    // Duffy map of a tensor-product Gauss-Legendre rule onto the reference
    // triangle, then a second independent Gauss-Legendre rule on zeta.  The
    // switch values are point counts per axis (GL4/GL5/GL7), not MFEM
    // integration orders.  This deliberately does not consume mfem::IntRules
    // or CalcPhysDShape.
    static constexpr double kNodes4[] = {
        0.06943184420297371, 0.33000947820757187,
        0.66999052179242813, 0.93056815579702629};
    static constexpr double kWeights4[] = {
        0.17392742256872693, 0.32607257743127307,
        0.32607257743127307, 0.17392742256872693};
    static constexpr double kNodes5[] = {
        0.04691007703066802, 0.23076534494715845, 0.5,
        0.76923465505284155, 0.95308992296933198};
    static constexpr double kWeights5[] = {
        0.11846344252809454, 0.23931433524968324, 0.28444444444444444,
        0.23931433524968324, 0.11846344252809454};
    static constexpr double kNodes7[] = {
        0.02544604382862074, 0.12923440720030277, 0.29707742431130138,
        0.5, 0.70292257568869862, 0.87076559279969723,
        0.97455395617137926};
    static constexpr double kWeights7[] = {
        0.06474248308443485, 0.13985269574463834, 0.19091502525255947,
        0.20897959183673469, 0.19091502525255947, 0.13985269574463834,
        0.06474248308443485};

    const double *nodes = nullptr;
    const double *weights = nullptr;
    int point_count = 0;
    switch (point_count_per_axis) {
    case 4:
        nodes = kNodes4;
        weights = kWeights4;
        point_count = 4;
        break;
    case 5:
        nodes = kNodes5;
        weights = kWeights5;
        point_count = 5;
        break;
    case 7:
        nodes = kNodes7;
        weights = kWeights7;
        point_count = 7;
        break;
    default:
        check(false,
              "independent prism GL reference supports only 4, 5, and 7 points per axis");
    }

    std::vector<IndependentPrismQuadraturePoint> points;
    points.reserve(static_cast<std::size_t>(point_count * point_count * point_count));
    for (int xi_index = 0; xi_index < point_count; ++xi_index) {
        const double xi = nodes[xi_index];
        for (int eta_index = 0; eta_index < point_count; ++eta_index) {
            const double eta = (1.0 - xi) * nodes[eta_index];
            for (int zeta_index = 0; zeta_index < point_count; ++zeta_index) {
                points.push_back({
                    xi,
                    eta,
                    nodes[zeta_index],
                    weights[xi_index] * weights[eta_index] *
                        weights[zeta_index] * (1.0 - xi)});
            }
        }
    }
    return points;
}

void prism_reference_shape_gradients(
    double xi,
    double eta,
    double zeta,
    double gradients[6][3])
{
    gradients[0][0] = -(1.0 - zeta);
    gradients[0][1] = -(1.0 - zeta);
    gradients[0][2] = -(1.0 - xi - eta);
    gradients[1][0] = 1.0 - zeta;
    gradients[1][1] = 0.0;
    gradients[1][2] = -xi;
    gradients[2][0] = 0.0;
    gradients[2][1] = 1.0 - zeta;
    gradients[2][2] = -eta;
    gradients[3][0] = -zeta;
    gradients[3][1] = -zeta;
    gradients[3][2] = 1.0 - xi - eta;
    gradients[4][0] = zeta;
    gradients[4][1] = 0.0;
    gradients[4][2] = xi;
    gradients[5][0] = 0.0;
    gradients[5][1] = zeta;
    gradients[5][2] = eta;
}

void deformed_prism_jacobian(
    const mfem::Mesh &mesh,
    const mfem::Array<int> &vertices,
    const double shape_gradients[6][3],
    double jacobian[3][3])
{
    check(vertices.Size() == 6,
          "deformed prism oracle requires six ordered wedge vertices");
    for (int axis = 0; axis < 3; ++axis) {
        for (int reference_axis = 0; reference_axis < 3; ++reference_axis) {
            jacobian[axis][reference_axis] = 0.0;
        }
    }
    for (int local = 0; local < 6; ++local) {
        const double *vertex = mesh.GetVertex(vertices[local]);
        for (int axis = 0; axis < 3; ++axis) {
            for (int reference_axis = 0; reference_axis < 3; ++reference_axis) {
                jacobian[axis][reference_axis] +=
                    vertex[axis] * shape_gradients[local][reference_axis];
            }
        }
    }
}

std::vector<double> independent_deformed_prism_exchange_oracle(
    mfem::FiniteElementSpace &scalar_space,
    const std::vector<std::uint8_t> &magnetic_elements,
    const std::vector<double> &tangent_frames,
    double exchange_stiffness,
    std::uint64_t node_count,
    int gauss_points_per_axis)
{
    const std::uint64_t q_count = 2u * node_count;
    std::vector<double> oracle(static_cast<std::size_t>(q_count * q_count), 0.0);
    mfem::Mesh *mesh = scalar_space.GetMesh();
    check(mesh != nullptr, "deformed prism oracle requires an MFEM mesh");
    check(magnetic_elements.size() == static_cast<std::size_t>(mesh->GetNE()),
          "deformed prism oracle requires one mask entry per element");
    check(tangent_frames.size() == static_cast<std::size_t>(6u * node_count),
          "deformed prism oracle requires two three-vector frames per node");

    const std::vector<IndependentPrismQuadraturePoint> quadrature =
        independent_prism_gauss_rule(gauss_points_per_axis);
    for (int element = 0; element < mesh->GetNE(); ++element) {
        if (magnetic_elements[static_cast<std::size_t>(element)] == 0u) {
            continue;
        }
        mfem::Array<int> dofs;
        mfem::Array<int> vertices;
        scalar_space.GetElementDofs(element, dofs);
        mesh->GetElementVertices(element, vertices);
        const mfem::FiniteElement *finite_element = scalar_space.GetFE(element);
        check(dofs.Size() == 6 && vertices.Size() == 6 && finite_element != nullptr &&
                  finite_element->GetGeomType() == mfem::Geometry::PRISM &&
                  finite_element->GetOrder() == 1,
              "deformed prism oracle requires P1 prism6 elements");

        for (const IndependentPrismQuadraturePoint &point : quadrature) {
            double reference_gradients[6][3]{};
            prism_reference_shape_gradients(
                point.xi, point.eta, point.zeta, reference_gradients);
            double jacobian[3][3]{};
            deformed_prism_jacobian(*mesh, vertices, reference_gradients, jacobian);
            double inverse_jacobian[3][3]{};
            double determinant = 0.0;
            invert_3x3(jacobian, inverse_jacobian, &determinant);
            check(std::isfinite(determinant) && determinant > 0.0,
                  "deformed prism oracle requires positive Jacobian orientation");
            const double physical_weight = determinant * point.weight;
            check(std::isfinite(physical_weight) && physical_weight > 0.0,
                  "deformed prism oracle requires a finite positive physical weight");

            double physical_gradients[6][3]{};
            for (int local = 0; local < 6; ++local) {
                for (int axis = 0; axis < 3; ++axis) {
                    for (int reference_axis = 0; reference_axis < 3;
                         ++reference_axis) {
                        physical_gradients[local][axis] +=
                            reference_gradients[local][reference_axis] *
                            inverse_jacobian[reference_axis][axis];
                    }
                }
                for (int reference_axis = 0; reference_axis < 3; ++reference_axis) {
                    double reconstructed = 0.0;
                    for (int axis = 0; axis < 3; ++axis) {
                        reconstructed += physical_gradients[local][axis] *
                            jacobian[axis][reference_axis];
                    }
                    check(std::abs(reconstructed -
                                   reference_gradients[local][reference_axis]) <= 1.0e-11,
                          "deformed prism oracle must satisfy J-transpose gradient transform");
                }
            }

            for (int local_row = 0; local_row < 6; ++local_row) {
                const std::uint64_t row_node = static_cast<std::uint64_t>(
                    dofs[local_row] >= 0 ? dofs[local_row] : -1 - dofs[local_row]);
                const double row_sign = dofs[local_row] >= 0 ? 1.0 : -1.0;
                check(row_node < node_count,
                      "deformed prism oracle row dof must be in the node range");
                for (int local_column = 0; local_column < 6; ++local_column) {
                    const std::uint64_t column_node = static_cast<std::uint64_t>(
                        dofs[local_column] >= 0 ? dofs[local_column] : -1 - dofs[local_column]);
                    const double column_sign = dofs[local_column] >= 0 ? 1.0 : -1.0;
                    check(column_node < node_count,
                          "deformed prism oracle column dof must be in the node range");
                    double gradient_dot = 0.0;
                    for (int axis = 0; axis < 3; ++axis) {
                        gradient_dot += physical_gradients[local_row][axis] *
                            physical_gradients[local_column][axis];
                    }
                    const double coefficient = row_sign * column_sign * 2.0 *
                        exchange_stiffness * gradient_dot * physical_weight;
                    for (std::uint32_t row_component = 0; row_component < 2u;
                         ++row_component) {
                        const double *row_frame = &tangent_frames[
                            static_cast<std::size_t>(
                                6u * row_node + 3u * row_component)];
                        for (std::uint32_t column_component = 0; column_component < 2u;
                             ++column_component) {
                            const double *column_frame = &tangent_frames[
                                static_cast<std::size_t>(
                                    6u * column_node + 3u * column_component)];
                            const double frame_dot = row_frame[0] * column_frame[0] +
                                row_frame[1] * column_frame[1] +
                                row_frame[2] * column_frame[2];
                            oracle[static_cast<std::size_t>(
                                (2u * row_node + row_component) * q_count +
                                2u * column_node + column_component)] +=
                                coefficient * frame_dot;
                        }
                    }
                }
            }
        }
    }
    return oracle;
}

double dense_matrix_max_difference(
    const std::vector<double> &left,
    const std::vector<double> &right)
{
    check(left.size() == right.size(), "dense matrix comparison requires equal sizes");
    double maximum = 0.0;
    for (std::size_t index = 0u; index < left.size(); ++index) {
        maximum = std::max(maximum, std::abs(left[index] - right[index]));
    }
    return maximum;
}

#if FULLMAG_HAS_MFEM_STACK
void floquet_positive_tangent_mass_matches_independent_phase_reduction()
{
    mfem::Mesh mesh(3, 10, 2, 0, 3);
    const double vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {1.0, 0.0, 1.0}, {0.0, 1.0, 1.0},
        {3.0, 0.0, 0.0}, {4.0, 0.0, 0.0}, {3.0, 1.0, 0.0},
        {3.0, 0.0, 1.0},
    };
    for (const auto &vertex : vertices) {
        mesh.AddVertex(vertex);
    }
    const int prism6[] = {0, 1, 2, 3, 4, 5};
    const int tet4[] = {6, 7, 8, 9};
    mesh.AddWedge(prism6, 1);
    mesh.AddTet(tet4, 2);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);

    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);
    const std::uint64_t node_count =
        static_cast<std::uint64_t>(scalar_space.GetVSize());
    check(node_count == 10u, "tangent-mass oracle fixture has ten P1 nodes");
    const std::uint64_t full_q_count = 2u * node_count;

    std::vector<fd::TangentFrameNode> frames(static_cast<std::size_t>(node_count));
    for (fd::TangentFrameNode &frame : frames) {
        frame.m[2] = 1.0;
        frame.e1[0] = 1.0;
        frame.e2[1] = 1.0;
    }
    constexpr std::uint32_t master_node = 0u;
    constexpr std::uint32_t member_node = 3u;
    constexpr double tangent_rotation_rad = 0.37;
    frames[member_node].e1[0] = std::cos(tangent_rotation_rad);
    frames[member_node].e1[1] = std::sin(tangent_rotation_rad);
    frames[member_node].e2[0] = -std::sin(tangent_rotation_rad);
    frames[member_node].e2[1] = std::cos(tangent_rotation_rad);

    const std::vector<std::uint8_t> magnetic_elements = {1u, 1u};
    const std::vector<std::uint32_t> magnetic_classes = {
        0u, 1u, 2u, 0u, 3u, 4u, 5u, 6u, 7u, 8u};
    constexpr std::uint64_t reduced_node_count = 9u;
    fd::FrequencyDomainFloquetPeriodicPair periodic_pair{};
    periodic_pair.pair_id = "prism-z-copy";
    periodic_pair.node_a = master_node;
    periodic_pair.node_b = member_node;
    periodic_pair.translation_m[2] = 1.0;
    periodic_pair.has_translation = true;
    periodic_pair.has_phase = true;
    periodic_pair.phase_rad = -0.4;

    mfem::Array<int> boundary_marker(mesh.bdr_attributes.Max());
    boundary_marker = 1;
    const std::array<double, 3> wavevector{{0.0, 0.0, 0.4}};
    fd::FloquetAirboxSharedDomainBlockRequest block_request{};
    block_request.scalar_space = &scalar_space;
    block_request.tangent_frames = frames.data();
    block_request.tangent_frame_count = node_count;
    block_request.magnetic_element_mask = magnetic_elements.data();
    block_request.magnetic_element_count = magnetic_elements.size();
    block_request.uniform_saturation_magnetization_a_per_m = 2.0;
    block_request.scalar_reduced_node = magnetic_classes.data();
    block_request.scalar_reduced_node_count = reduced_node_count;
    block_request.magnetic_reduced_node = magnetic_classes.data();
    block_request.magnetic_reduced_node_count = reduced_node_count;
    block_request.periodic_pairs = &periodic_pair;
    block_request.periodic_pair_count = 1u;
    block_request.k_rad_per_m = wavevector;
    block_request.boundary_kind = fd::FloquetAirboxBoundaryKind::robin;
    block_request.robin_beta = 1.0;
    block_request.robin_boundary_marker = &boundary_marker;
    fd::FloquetAirboxSharedDomainBlockResult floquet_blocks{};
    check(fd::assemble_floquet_airbox_shared_domain_blocks(
              block_request, &floquet_blocks) == fd::FrequencyDomainStatus::ok,
          floquet_blocks.error_message);
    check(floquet_blocks.tangent_constraint != nullptr,
          "tangent-mass oracle obtains the actual phase/frame constraint");

    std::vector<std::uint32_t> zero_row_offsets(
        static_cast<std::size_t>(full_q_count + 1u), 0u);
    const fd::CsrMatrixView zero_a_qq{
        full_q_count,
        full_q_count,
        zero_row_offsets.data(),
        zero_row_offsets.size(),
        nullptr,
        0u,
        nullptr,
        0u};
    fd::PoissonAirboxSharedDomainAssemblyRequest request{};
    request.scalar_space = &scalar_space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = node_count;
    request.magnetic_element_mask = magnetic_elements.data();
    request.magnetic_element_count = magnetic_elements.size();
    request.uniform_saturation_magnetization_a_per_m = 2.0;
    request.gamma0_m_per_a_s = 3.0;
    request.mu0_T_m_A = 4.0;
    request.magnetic_a_qq_csr = &zero_a_qq;
    request.magnetic_phase_constraint = floquet_blocks.tangent_constraint.get();
    request.scalar_reduced_node = magnetic_classes.data();
    request.scalar_reduced_node_count = reduced_node_count;
    request.magnetic_reduced_node = magnetic_classes.data();
    request.magnetic_reduced_node_count = reduced_node_count;
    request.equivalence_classes_complete = true;
    request.boundary_kind = fd::PoissonAirboxBoundaryKind::robin;
    request.robin_beta = 1.0;
    request.robin_boundary_marker = &boundary_marker;
    fd::PoissonAirboxSharedDomainAssemblyResult assembled{};
    check(fd::assemble_poisson_airbox_shared_domain(request, &assembled) ==
              fd::FrequencyDomainStatus::ok,
          assembled.error_message);

    const std::uint64_t reduced_q_count = 2u * reduced_node_count;
    check(assembled.floquet_full_positive_tangent_mass.row_count == full_q_count &&
              assembled.floquet_full_positive_tangent_mass.column_count == full_q_count,
          "Floquet assembly retains the full physical tangent P1 mass");
    check(assembled.floquet_positive_tangent_mass.row_count == reduced_q_count &&
              assembled.floquet_positive_tangent_mass.column_count == reduced_q_count &&
              !assembled.floquet_positive_tangent_mass.values.empty(),
          "Floquet assembly retains the phase-reduced complex tangent P1 mass");

    // Independent exact local mass formulas: tet4 uses V/20*(1+delta_ij);
    // prism6 uses the tensor product of the triangle and segment P1 masses.
    // Tangent-frame dot products lift each scalar entry into physical XYZ.
    std::vector<double> full_mass(
        static_cast<std::size_t>(full_q_count * full_q_count), 0.0);
    const auto dot3 = [](const double *left, const double *right) {
        return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
    };
    const auto tangent_component = [](const fd::TangentFrameNode &frame,
                                      std::uint32_t component) -> const double * {
        return component == 0u ? frame.e1 : frame.e2;
    };
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> dofs;
        scalar_space.GetElementDofs(element, dofs);
        const mfem::Geometry::Type geometry = mesh.GetElementGeometry(element);
        double volume = 0.0;
        if (geometry == mfem::Geometry::TETRAHEDRON) {
            volume = tetra_volume_from_vertices(mesh, element);
        } else {
            check(geometry == mfem::Geometry::PRISM && dofs.Size() == 6,
                  "independent tangent-mass oracle accepts tet4 and prism6 only");
            mfem::Array<int> element_vertices;
            mesh.GetElementVertices(element, element_vertices);
            check(element_vertices.Size() == 6,
                  "independent prism mass has six ordered vertices");
            const double *x0 = mesh.GetVertex(element_vertices[0]);
            const double *x1 = mesh.GetVertex(element_vertices[1]);
            const double *x2 = mesh.GetVertex(element_vertices[2]);
            const double *x3 = mesh.GetVertex(element_vertices[3]);
            const double edge_a[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};
            const double edge_b[3] = {x2[0] - x0[0], x2[1] - x0[1], x2[2] - x0[2]};
            const double extrusion[3] = {x3[0] - x0[0], x3[1] - x0[1], x3[2] - x0[2]};
            const double base_normal[3] = {
                edge_a[1] * edge_b[2] - edge_a[2] * edge_b[1],
                edge_a[2] * edge_b[0] - edge_a[0] * edge_b[2],
                edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0]};
            volume = 0.5 * std::abs(dot3(base_normal, extrusion));
        }
        check(std::isfinite(volume) && volume > 0.0,
              "independent tangent-mass element volume is positive");
        for (int local_row = 0; local_row < dofs.Size(); ++local_row) {
            const int raw_row = dofs[local_row];
            const std::uint64_t row_node = static_cast<std::uint64_t>(
                raw_row >= 0 ? raw_row : -1 - raw_row);
            const double row_sign = raw_row >= 0 ? 1.0 : -1.0;
            for (int local_column = 0; local_column < dofs.Size(); ++local_column) {
                const int raw_column = dofs[local_column];
                const std::uint64_t column_node = static_cast<std::uint64_t>(
                    raw_column >= 0 ? raw_column : -1 - raw_column);
                const double column_sign = raw_column >= 0 ? 1.0 : -1.0;
                double scalar_mass = 0.0;
                if (geometry == mfem::Geometry::TETRAHEDRON) {
                    scalar_mass = volume / 20.0 * (local_row == local_column ? 2.0 : 1.0);
                } else {
                    const int triangle_factor = local_row % 3 == local_column % 3 ? 2 : 1;
                    const int segment_factor = local_row / 3 == local_column / 3 ? 2 : 1;
                    scalar_mass = volume / 72.0 * triangle_factor * segment_factor;
                }
                scalar_mass *= row_sign * column_sign;
                for (std::uint32_t row_component = 0u; row_component < 2u; ++row_component) {
                    for (std::uint32_t column_component = 0u; column_component < 2u;
                         ++column_component) {
                        const double frame_dot = dot3(
                            tangent_component(frames[row_node], row_component),
                            tangent_component(frames[column_node], column_component));
                        full_mass[static_cast<std::size_t>(
                            (2u * row_node + row_component) * full_q_count +
                            2u * column_node + column_component)] += scalar_mass * frame_dot;
                    }
                }
            }
        }
    }

    double full_error = 0.0;
    double full_scale = 0.0;
    for (std::uint64_t row = 0u; row < full_q_count; ++row) {
        for (std::uint64_t column = 0u; column < full_q_count; ++column) {
            const double expected = full_mass[static_cast<std::size_t>(
                row * full_q_count + column)];
            const double actual = matrix_value(
                assembled.floquet_full_positive_tangent_mass, row, column);
            full_error = std::max(full_error, std::abs(actual - expected));
            full_scale = std::max(full_scale, std::max(std::abs(actual), std::abs(expected)));
        }
    }
    check(full_error <= 1.0e-12 * std::max(1.0, full_scale),
          "full tangent P1 CSR matches independent tet4/prism6 mass formulas");
    check(std::abs(full_mass[0] - full_mass[static_cast<std::size_t>(
              (2u * 6u) * full_q_count + 2u * 6u)]) > 1.0e-6,
          "full P1 mass retains nonuniform nodal diagonal weights");
    check(std::abs(matrix_value(
              assembled.floquet_full_positive_tangent_mass,
              2u * master_node,
              2u * member_node + 1u)) > 1.0e-6,
          "full tangent mass uses the nonuniform local tangent basis");

    const auto build_independent_constraint = [&](bool include_phase, bool include_member) {
        std::vector<std::complex<double>> constraint(
            static_cast<std::size_t>(full_q_count * reduced_q_count),
            std::complex<double>{});
        for (std::uint64_t node = 0u; node < node_count; ++node) {
            if (node == member_node && !include_member) {
                continue;
            }
            const std::uint32_t class_id = magnetic_classes[static_cast<std::size_t>(node)];
            const std::complex<double> phase = node == member_node && include_phase
                ? std::complex<double>(std::cos(0.4), -std::sin(0.4))
                : std::complex<double>(1.0, 0.0);
            for (std::uint32_t row_component = 0u; row_component < 2u; ++row_component) {
                for (std::uint32_t column_component = 0u; column_component < 2u;
                     ++column_component) {
                    const double tangent_rotation = node == member_node
                        ? dot3(
                              tangent_component(frames[node], row_component),
                              tangent_component(frames[master_node], column_component))
                        : (row_component == column_component ? 1.0 : 0.0);
                    constraint[static_cast<std::size_t>(
                        (2u * node + row_component) * reduced_q_count +
                        2u * class_id + column_component)] = phase * tangent_rotation;
                }
            }
        }
        return constraint;
    };
    const auto reduce_independently = [&](const std::vector<std::complex<double>> &constraint) {
        std::vector<std::complex<double>> reduced_mass(
            static_cast<std::size_t>(reduced_q_count * reduced_q_count),
            std::complex<double>{});
        for (std::uint64_t row = 0u; row < reduced_q_count; ++row) {
            for (std::uint64_t column = 0u; column < reduced_q_count; ++column) {
                std::complex<double> value{};
                for (std::uint64_t full_row = 0u; full_row < full_q_count; ++full_row) {
                    const auto row_map = std::conj(constraint[
                        static_cast<std::size_t>(full_row * reduced_q_count + row)]);
                    if (row_map == std::complex<double>{}) continue;
                    for (std::uint64_t full_column = 0u; full_column < full_q_count;
                         ++full_column) {
                        const double mass = full_mass[static_cast<std::size_t>(
                            full_row * full_q_count + full_column)];
                        if (mass == 0.0) continue;
                        value += row_map * mass * constraint[static_cast<std::size_t>(
                            full_column * reduced_q_count + column)];
                    }
                }
                reduced_mass[static_cast<std::size_t>(row * reduced_q_count + column)] = value;
            }
        }
        return reduced_mass;
    };
    const auto expected_reduced = reduce_independently(
        build_independent_constraint(true, true));
    const auto no_phase_reduced = reduce_independently(
        build_independent_constraint(false, true));
    const auto master_only_reduced = reduce_independently(
        build_independent_constraint(true, false));

    double reduced_error = 0.0;
    double reduced_scale = 0.0;
    double phase_effect = 0.0;
    for (std::uint64_t row = 0u; row < reduced_q_count; ++row) {
        for (std::uint64_t column = 0u; column < reduced_q_count; ++column) {
            const std::size_t offset = static_cast<std::size_t>(row * reduced_q_count + column);
            const std::complex<double> expected = expected_reduced[offset];
            const std::complex<double> actual = complex_matrix_value(
                assembled.floquet_positive_tangent_mass, row, column);
            reduced_error = std::max(reduced_error, std::abs(actual - expected));
            reduced_scale = std::max(
                reduced_scale, std::max(std::abs(actual), std::abs(expected)));
            phase_effect = std::max(
                phase_effect, std::abs(expected - no_phase_reduced[offset]));
            const std::complex<double> adjoint = std::conj(complex_matrix_value(
                assembled.floquet_positive_tangent_mass, column, row));
            check(std::abs(actual - adjoint) <= 1.0e-12 * std::max(1.0, reduced_scale),
                  "phase-reduced tangent P1 mass is Hermitian");
        }
    }
    check(reduced_error <= 1.0e-12 * std::max(1.0, reduced_scale),
          "reduced tangent mass equals independent C^H M_full C");
    check(phase_effect > 1.0e-5,
          "Floquet phase changes the mass contribution of periodic physical copies");
    check(std::abs(expected_reduced[0] - master_only_reduced[0]) > 1.0e-5,
          "both master and periodic member contribute to the reduced physical mass");

    std::complex<double> quadratic{};
    for (std::uint64_t row = 0u; row < reduced_q_count; ++row) {
        const std::complex<double> left(
            0.1 * static_cast<double>(row + 1u),
            -0.03 * static_cast<double>(row + 2u));
        std::complex<double> action{};
        for (std::uint64_t column = 0u; column < reduced_q_count; ++column) {
            const std::complex<double> right(
                0.1 * static_cast<double>(column + 1u),
                -0.03 * static_cast<double>(column + 2u));
            action += complex_matrix_value(
                assembled.floquet_positive_tangent_mass, row, column) * right;
        }
        quadratic += std::conj(left) * action;
    }
    check(quadratic.real() > 0.0 &&
              std::abs(quadratic.imag()) <= 1.0e-12 * std::max(1.0, quadratic.real()),
          "phase-reduced tangent mass has a positive real quadratic form");
}
#endif

} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK
    floquet_positive_tangent_mass_matches_independent_phase_reduction();
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1,
        1,
        1,
        mfem::Element::TETRAHEDRON,
        1.0,
        1.0,
        1.0);
    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);

    // MFEM v4.7's tetrahedron order-4 rule was not admissible for the native
    // exchange producer because it contained a negative weight.  Keep both
    // the diagnostic rule and the selected positive order5 rule available
    // beside the independent affine-tetrahedron gradient oracle below.  Do
    // not hardcode point counts here: MFEM 4.10 changed simplex rules.
    const mfem::IntegrationRule &tetra_order4 =
        mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
    check(tetra_order4.GetNPoints() > 0,
          "MFEM tetrahedron order4 rule must remain available for diagnostics");
    const mfem::IntegrationRule &tetra_order5 =
        mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 5);
    check(tetra_order5.GetNPoints() > 0,
          "native tet4 positive policy must provide an order5 rule");
    for (int point = 0; point < tetra_order5.GetNPoints(); ++point) {
        check(std::isfinite(tetra_order5.IntPoint(point).weight) &&
                  tetra_order5.IntPoint(point).weight > 0.0,
              "native tet4 order5 policy must have positive reference weights");
    }
    const mfem::IntegrationRule &prism_order4 =
        mfem::IntRules.Get(mfem::Geometry::PRISM, 4);
    check(prism_order4.GetNPoints() > 0,
          "native prism6 positive policy must provide an order4 rule");
    for (int point = 0; point < prism_order4.GetNPoints(); ++point) {
        check(std::isfinite(prism_order4.IntPoint(point).weight) &&
                  prism_order4.IntPoint(point).weight > 0.0,
              "native prism6 order4 policy must have positive reference weights");
    }

    const std::uint64_t node_count = static_cast<std::uint64_t>(scalar_space.GetVSize());
    check(node_count > 0, "manufactured mesh has scalar P1 nodes");
    std::vector<fd::TangentFrameNode> frames(static_cast<std::size_t>(node_count));
    for (fd::TangentFrameNode &frame : frames) {
        frame.m[0] = 0.0;
        frame.m[1] = 0.0;
        frame.m[2] = 1.0;
        frame.e1[0] = 1.0;
        frame.e1[1] = 0.0;
        frame.e1[2] = 0.0;
        frame.e2[0] = 0.0;
        frame.e2[1] = 1.0;
        frame.e2[2] = 0.0;
    }
    std::vector<std::uint8_t> magnetic_elements(
        static_cast<std::size_t>(mesh.GetNE()), 1u);
    std::vector<std::uint32_t> scalar_classes(static_cast<std::size_t>(node_count));
    std::vector<std::uint32_t> magnetic_classes(static_cast<std::size_t>(node_count));
    for (std::uint32_t node = 0; node < node_count; ++node) {
        scalar_classes[node] = node;
        magnetic_classes[node] = node;
    }

    const std::uint64_t q_count = 2u * node_count;

    // The native producer must own A_qq assembly.  Use rotated tangent frames
    // at one endpoint so a missing reciprocal transpose is observable; a
    // runner-side 2x2 identity fixture would not catch that error.
    std::vector<double> descriptor_frames(static_cast<std::size_t>(6u * node_count), 0.0);
    std::vector<double> descriptor_equilibrium(static_cast<std::size_t>(3u * node_count), 0.0);
    std::vector<double> descriptor_h_eff(static_cast<std::size_t>(3u * node_count), 0.0);
    std::vector<double> descriptor_external(static_cast<std::size_t>(3u * node_count), 0.0);
    std::vector<double> descriptor_alpha(static_cast<std::size_t>(node_count), 0.01);
    for (std::uint64_t node = 0; node < node_count; ++node) {
        descriptor_equilibrium[3u * node + 2u] = 1.0;
        descriptor_frames[6u * node] = 1.0;
        descriptor_frames[6u * node + 4u] = 1.0;
    }
    if (node_count > 1u) {
        descriptor_frames[6u + 0u] = 0.0;
        descriptor_frames[6u + 1u] = 1.0;
        descriptor_frames[6u + 3u] = -1.0;
        descriptor_frames[6u + 4u] = 0.0;
    }
    const fullmag_fem_frequency_domain_exchange_edge producer_edge{0u, 1u, 2.0};
    FullmagFemModalLinearizationDescriptor producer_descriptor{};
    producer_descriptor.abi_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION;
    producer_descriptor.struct_size = sizeof(producer_descriptor);
    producer_descriptor.node_count = node_count;
    producer_descriptor.tangent_dof_count = q_count;
    producer_descriptor.tangent_frame_xyz = descriptor_frames.data();
    producer_descriptor.tangent_frame_xyz_count = descriptor_frames.size();
    producer_descriptor.equilibrium_m0_xyz = descriptor_equilibrium.data();
    producer_descriptor.equilibrium_m0_xyz_count = descriptor_equilibrium.size();
    producer_descriptor.effective_field_h_eff0_xyz = descriptor_h_eff.data();
    producer_descriptor.effective_field_h_eff0_xyz_count = descriptor_h_eff.size();
    producer_descriptor.external_field_h_ext0_xyz = descriptor_external.data();
    producer_descriptor.external_field_h_ext0_xyz_count = descriptor_external.size();
    producer_descriptor.alpha_per_node = descriptor_alpha.data();
    producer_descriptor.alpha_per_node_count = descriptor_alpha.size();
    producer_descriptor.uniform_saturation_magnetisation_a_per_m = 2.0;
    producer_descriptor.schema_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA;
    producer_descriptor.coordinate_unit = "m";
    producer_descriptor.magnetisation_unit = "A/m";
    producer_descriptor.time_unit = "s";
    producer_descriptor.frequency_unit = "Hz";
    producer_descriptor.angular_frequency_unit = "rad/s";
    producer_descriptor.linearization_state_digest =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    producer_descriptor.equilibrium_digest = producer_descriptor.linearization_state_digest;
    producer_descriptor.operator_input_digest = producer_descriptor.linearization_state_digest;
    producer_descriptor.term_presence_mask =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE;
    producer_descriptor.exchange_term_digest = producer_descriptor.linearization_state_digest;
    std::vector<fd::TangentFrameNode> producer_frames(static_cast<std::size_t>(node_count));
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        for (int axis = 0; axis < 3; ++axis) {
            producer_frames[static_cast<std::size_t>(node)].m[axis] =
                descriptor_equilibrium[3u * node + axis];
            producer_frames[static_cast<std::size_t>(node)].e1[axis] =
                descriptor_frames[6u * node + axis];
            producer_frames[static_cast<std::size_t>(node)].e2[axis] =
                descriptor_frames[6u * node + 3u + axis];
        }
    }
    producer_descriptor.exchange_edges = &producer_edge;
    producer_descriptor.exchange_edge_count = 1u;
    fd::PoissonAirboxSharedDomainCsrMatrix produced_a_qq{};
    char producer_error[256]{};
    check(
        fd::assemble_native_magnetic_a_qq(
            producer_descriptor,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::ok,
        producer_error);
    check(produced_a_qq.row_count == q_count && produced_a_qq.column_count == q_count,
          "native A_qq producer publishes full tangent dimensions");
    check(produced_a_qq.values.size() > 0,
          "native A_qq producer publishes nonzero exchange entries");
    fd::PoissonAirboxSharedDomainCsrMatrix null_frame_a_qq{};
    check(fd::assemble_native_magnetic_a_qq(
              producer_descriptor,
              &scalar_space,
              magnetic_elements.data(),
              magnetic_elements.size(),
              &null_frame_a_qq,
              producer_error,
              nullptr,
              nullptr,
              0u) == fd::FrequencyDomainStatus::validation_error,
          "native A_qq must reject an unaccepted tangent-frame source");
    check(std::strstr(producer_error, "accepted tangent-frame") != nullptr,
          "null tangent-frame rejection must use a stable validation reason");
    if (node_count > 1u) {
        check(std::abs(matrix_value(produced_a_qq, 0u, 3u) -
                       matrix_value(produced_a_qq, 3u, 0u)) <= 1.0e-12,
              "native A_qq exchange coupling must use reciprocal frame transport");
    }

    // Static-field energy must be invariant under independent nodal basis changes.
    // Compare native assembly to a common-frame matrix transported in Cartesian space.
    std::vector<double> static_h_eff = descriptor_h_eff;
    std::vector<double> common_frame_values = descriptor_frames;
    std::vector<fd::TangentFrameNode> common_frames = producer_frames;
    for (std::uint64_t node = 0; node < node_count; ++node) {
        static_h_eff[3u * node + 2u] = 7.0;
        for (int axis = 0; axis < 3; ++axis) {
            common_frames[node].e1[axis] = axis == 0 ? 1.0 : 0.0;
            common_frames[node].e2[axis] = axis == 1 ? 1.0 : 0.0;
            common_frame_values[6u * node + axis] = common_frames[node].e1[axis];
            common_frame_values[6u * node + 3u + axis] = common_frames[node].e2[axis];
        }
    }
    FullmagFemModalLinearizationDescriptor static_descriptor = producer_descriptor;
    static_descriptor.term_presence_mask = FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD;
    static_descriptor.field_term_digest = producer_descriptor.linearization_state_digest;
    static_descriptor.exchange_term_digest = nullptr;
    static_descriptor.exchange_edges = nullptr;
    static_descriptor.exchange_edge_count = 0;
    static_descriptor.effective_field_h_eff0_xyz = static_h_eff.data();
    fd::PoissonAirboxSharedDomainCsrMatrix rotated_static{}, common_static{};
    check(fd::assemble_native_magnetic_a_qq(
              static_descriptor, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &rotated_static, producer_error, nullptr,
              producer_frames.data(), producer_frames.size()) == fd::FrequencyDomainStatus::ok,
          producer_error);
    static_descriptor.tangent_frame_xyz = common_frame_values.data();
    check(fd::assemble_native_magnetic_a_qq(
              static_descriptor, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &common_static, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::ok,
          producer_error);
    double covariance_error = 0.0, covariance_scale = 0.0;
    bool exercised_cross_frame_coupling = false;
    for (std::uint64_t i = 0; i < node_count; ++i) {
        for (std::uint64_t j = 0; j < node_count; ++j) {
            const double scalar_entry = matrix_value(common_static, 2u * i, 2u * j);
            for (std::uint64_t a = 0; a < 2; ++a) {
                for (std::uint64_t b = 0; b < 2; ++b) {
                    const double *left = a == 0 ? producer_frames[i].e1 : producer_frames[i].e2;
                    const double *right = b == 0 ? producer_frames[j].e1 : producer_frames[j].e2;
                    double projection = 0.0;
                    for (int axis = 0; axis < 3; ++axis) projection += left[axis] * right[axis];
                    const double expected = scalar_entry * projection;
                    exercised_cross_frame_coupling |= i != j && a != b && expected != 0.0;
                    covariance_error = std::max(covariance_error, std::abs(
                        matrix_value(rotated_static, 2u * i + a, 2u * j + b) - expected));
                    covariance_scale = std::max(covariance_scale, std::abs(expected));
                }
            }
        }
    }
    check(exercised_cross_frame_coupling,
          "static-field covariance fixture must couple nodes with different tangent frames");
    check(covariance_scale > 0.0 && covariance_error <= 1.0e-12 * covariance_scale,
          "static field Hessian must transform between independent nodal tangent bases");

    // Signed uniaxial derivatives use both nodal frames and subtract the
    // Cartesian field Jacobian from the total longitudinal curvature.
    std::vector<double> uniaxial_axes(static_cast<std::size_t>(3u * node_count), 0.0);
    for (std::uint64_t node = 0; node < node_count; ++node) uniaxial_axes[3u * node] = 2.0;
    double uniaxial_field = 3.0;
    FullmagFemModalLinearizationDescriptor uniaxial_descriptor = static_descriptor;
    uniaxial_descriptor.term_presence_mask |= FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY;
    uniaxial_descriptor.anisotropy_term_digest = producer_descriptor.linearization_state_digest;
    uniaxial_descriptor.tangent_frame_xyz = descriptor_frames.data();
    uniaxial_descriptor.uniaxial_axis_xyz = uniaxial_axes.data();
    uniaxial_descriptor.uniaxial_axis_xyz_count = uniaxial_axes.size();
    uniaxial_descriptor.uniaxial_anisotropy_field_a_per_m = &uniaxial_field;
    uniaxial_descriptor.uniaxial_anisotropy_field_count = 1u;
    fd::PoissonAirboxSharedDomainCsrMatrix uniaxial_a{};
    for (const double signed_field : {3.0, -3.0}) {
        uniaxial_field = signed_field;
        check(fd::assemble_native_magnetic_a_qq(
                  uniaxial_descriptor, &scalar_space, magnetic_elements.data(),
                  magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
                  producer_frames.data(), producer_frames.size()) == fd::FrequencyDomainStatus::ok,
              producer_error);
        double error = 0.0, scale = 0.0;
        for (std::uint64_t i = 0; i < node_count; ++i) {
            for (std::uint64_t j = 0; j < node_count; ++j) {
                const double integral = matrix_value(common_static, 2u * i, 2u * j) / 7.0;
                for (std::uint64_t a = 0; a < 2; ++a) {
                    for (std::uint64_t b = 0; b < 2; ++b) {
                        const double *left = a == 0 ? producer_frames[i].e1 : producer_frames[i].e2;
                        const double *right = b == 0 ? producer_frames[j].e1 : producer_frames[j].e2;
                        double inner = 0.0;
                        for (int axis = 0; axis < 3; ++axis) inner += left[axis] * right[axis];
                        const double expected = integral * (7.0 * inner - signed_field * left[0] * right[0]);
                        error = std::max(error, std::abs(matrix_value(uniaxial_a, 2u * i + a, 2u * j + b) - expected));
                        scale = std::max(scale, std::abs(expected));
                    }
                }
            }
        }
        check(scale > 0.0 && error <= 1.0e-12 * scale,
              "signed uniaxial weak form subtracts its Cartesian derivative with frame transport");
    }
    // An easy axis parallel to m0 has zero tangent field derivative, but
    // retains its positive constrained curvature even with no FIELD term.
    uniaxial_field = 3.0;
    for (std::uint64_t node = 0; node < node_count; ++node) {
        uniaxial_axes[3u * node] = 0.0;
        uniaxial_axes[3u * node + 2u] = 1.0;
        static_h_eff[3u * node + 2u] = 3.0;
    }
    uniaxial_descriptor.term_presence_mask = FULLMAG_FEM_MODAL_LINEARIZATION_TERM_ANISOTROPY;
    uniaxial_descriptor.field_term_digest = nullptr;
    uniaxial_descriptor.tangent_frame_xyz = common_frame_values.data();
    check(fd::assemble_native_magnetic_a_qq(
              uniaxial_descriptor, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::ok,
          producer_error);
    for (std::uint64_t row = 0; row < q_count; ++row) {
        for (std::uint64_t column = 0; column < q_count; ++column) {
            const double expected = matrix_value(common_static, row, column) * (3.0 / 7.0);
            check(std::abs(matrix_value(uniaxial_a, row, column) - expected) <=
                      1.0e-12 * covariance_scale,
                  "anisotropy-only easy-axis request retains total static curvature");
        }
    }
    std::fill(uniaxial_axes.begin(), uniaxial_axes.end(), 0.0);
    check(fd::assemble_native_magnetic_a_qq(
              uniaxial_descriptor, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::validation_error,
          "zero anisotropy axes must reject before assembly");
    for (std::uint64_t node = 0; node < node_count; ++node) uniaxial_axes[3u * node + 2u] = 1.0;
    uniaxial_axes[3u + 2u] = -1.0;
    check(fd::assemble_native_magnetic_a_qq(
              uniaxial_descriptor, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::ok,
          "opposite nodal axes define the same constant uniaxial energy");
    std::vector<double> nodal_uniaxial_fields(static_cast<std::size_t>(node_count), 3.0);
    auto unsupported_nodal_uniaxial = uniaxial_descriptor;
    unsupported_nodal_uniaxial.uniaxial_anisotropy_field_a_per_m = nodal_uniaxial_fields.data();
    unsupported_nodal_uniaxial.uniaxial_anisotropy_field_count = node_count;
    check(fd::assemble_native_magnetic_a_qq(
              unsupported_nodal_uniaxial, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::unavailable,
          "nodal uniaxial field views remain unsupported in this increment");
    auto unadvertised_uniaxial = uniaxial_descriptor;
    unadvertised_uniaxial.term_presence_mask = FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD;
    unadvertised_uniaxial.field_term_digest = producer_descriptor.linearization_state_digest;
    unadvertised_uniaxial.anisotropy_term_digest = nullptr;
    check(fd::assemble_native_magnetic_a_qq(
              unadvertised_uniaxial, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::validation_error,
          "uniaxial views without an advertised term must reject");
    uniaxial_axes[3u] = 1.0;
    uniaxial_axes[3u + 2u] = 0.0;
    check(fd::assemble_native_magnetic_a_qq(
              uniaxial_descriptor, &scalar_space, magnetic_elements.data(),
              magnetic_elements.size(), &uniaxial_a, producer_error, nullptr,
              common_frames.data(), common_frames.size()) == fd::FrequencyDomainStatus::unavailable,
          "spatial anisotropy axes remain unsupported in this increment");

    // The independent affine P1 oracle uses only the native MFEM gradients,
    // quadrature weight and the declared material scalar.  Every entry must
    // match 2 A_ex (e_c(i).e_d(j)) (grad N_i.grad N_j) w; no runner graph
    // endpoint can alter this matrix.
    const std::vector<double> exchange_oracle = independent_exchange_oracle(
        scalar_space,
        magnetic_elements,
        descriptor_frames,
        producer_edge.stiffness,
        node_count);
    double exchange_oracle_error = 0.0;
    double exchange_oracle_scale = 0.0;
    for (std::uint64_t row = 0; row < q_count; ++row) {
        for (std::uint64_t column = 0; column < q_count; ++column) {
            const double actual = matrix_value(produced_a_qq, row, column);
            const double expected = exchange_oracle[
                static_cast<std::size_t>(row * q_count + column)];
            exchange_oracle_error = std::max(exchange_oracle_error,
                                             std::abs(actual - expected));
            exchange_oracle_scale = std::max(
                exchange_oracle_scale, std::max(std::abs(actual), std::abs(expected)));
        }
    }
    check(exchange_oracle_scale > 0.0,
          "independent exchange oracle must exercise a nonzero block");
    check(exchange_oracle_error <=
              1.0e-12 * std::max(1.0, exchange_oracle_scale),
          "native exchange must match the independent affine-tetrahedron oracle");

    std::vector<double> random_vector(static_cast<std::size_t>(q_count), 0.0);
    for (std::uint64_t index = 0; index < q_count; ++index) {
        random_vector[static_cast<std::size_t>(index)] =
            std::sin(0.37 * static_cast<double>(index + 1u)) +
            0.23 * std::cos(0.11 * static_cast<double>(index + 3u));
    }
    double action_error = 0.0;
    double action_scale = 0.0;
    double energy = 0.0;
    for (std::uint64_t row = 0; row < q_count; ++row) {
        double actual_action = 0.0;
        double oracle_action = 0.0;
        for (std::uint64_t column = 0; column < q_count; ++column) {
            const double x = random_vector[static_cast<std::size_t>(column)];
            actual_action += matrix_value(produced_a_qq, row, column) * x;
            oracle_action += exchange_oracle[
                static_cast<std::size_t>(row * q_count + column)] * x;
        }
        action_error = std::max(action_error, std::abs(actual_action - oracle_action));
        action_scale = std::max(action_scale,
                                std::max(std::abs(actual_action), std::abs(oracle_action)));
        energy += random_vector[static_cast<std::size_t>(row)] * actual_action;
    }
    check(action_error <= 1.0e-12 * std::max(1.0, action_scale),
          "native exchange random-vector action must match the independent oracle");
    check(energy >= -1.0e-12 * std::max(1.0, action_scale),
          "native exchange energy must be positive semidefinite");

    // The N1a mixed-P1 contract contributes magnetic prism6 exchange exactly
    // once and must never leak an air tet4 into A_qq.  The prism oracle below
    // intentionally uses reference prism shape derivatives, an explicit
    // affine Jacobian inverse, and an independent exact order-two rule rather
    // than MFEM CalcPhysDShape or the assembled CSR as its expected value.
    mfem::Mesh mixed_mesh(3, 10, 2, 0, 3);
    const double mixed_vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {1.0, 0.0, 1.0}, {0.0, 1.0, 1.0},
        {3.0, 0.0, 0.0}, {4.0, 0.0, 0.0}, {3.0, 1.0, 0.0},
        {3.0, 0.0, 1.0},
    };
    for (const auto &vertex : mixed_vertices) {
        mixed_mesh.AddVertex(vertex);
    }
    const int prism6[] = {0, 1, 2, 3, 4, 5};
    const int air_tet4[] = {6, 7, 8, 9};
    mixed_mesh.AddWedge(prism6, 1);
    mixed_mesh.AddTet(air_tet4, 2);
    mixed_mesh.FinalizeTopology();
    mixed_mesh.Finalize(false, true);
    mfem::H1_FECollection mixed_collection(1, mixed_mesh.Dimension());
    mfem::FiniteElementSpace mixed_scalar_space(&mixed_mesh, &mixed_collection);
    const std::uint64_t mixed_node_count =
        static_cast<std::uint64_t>(mixed_scalar_space.GetVSize());
    check(mixed_node_count == 10u, "mixed prism-air fixture has ten scalar P1 nodes");
    NativeExchangeDescriptorFixture mixed_descriptor(mixed_node_count);
    const std::vector<std::uint8_t> mixed_magnetic_elements = {1u, 0u};
    fd::PoissonAirboxSharedDomainCsrMatrix mixed_a_qq{};
    check(fd::assemble_native_magnetic_a_qq(
              mixed_descriptor.descriptor,
              &mixed_scalar_space,
              mixed_magnetic_elements.data(),
              mixed_magnetic_elements.size(),
              &mixed_a_qq,
              producer_error,
              nullptr,
              mixed_descriptor.tangent_frames.data(),
              mixed_descriptor.tangent_frames.size()) == fd::FrequencyDomainStatus::ok,
          producer_error);
    const std::uint64_t mixed_q_count = 2u * mixed_node_count;
    check(mixed_a_qq.row_count == mixed_q_count && mixed_a_qq.column_count == mixed_q_count,
          "mixed prism A_qq publishes the full tangent block");
    check(std::abs(matrix_value(mixed_a_qq, 0u, 0u)) > 0.0 &&
              std::abs(matrix_value(mixed_a_qq, 1u, 1u)) > 0.0,
          "mixed prism A_qq publishes nonzero tangent components");
    const std::vector<double> prism_exchange_oracle =
        independent_prism_exchange_exact_affine_oracle(
        mixed_scalar_space,
        mixed_magnetic_elements,
        mixed_descriptor.tangent_frame_xyz,
        mixed_descriptor.exchange_edge.stiffness,
        mixed_node_count);
    double prism_oracle_error = 0.0;
    double prism_oracle_scale = 0.0;
    for (std::uint64_t row = 0u; row < mixed_q_count; ++row) {
        for (std::uint64_t column = 0u; column < mixed_q_count; ++column) {
            const double actual = matrix_value(mixed_a_qq, row, column);
            const double expected = prism_exchange_oracle[
                static_cast<std::size_t>(row * mixed_q_count + column)];
            prism_oracle_error = std::max(prism_oracle_error, std::abs(actual - expected));
            prism_oracle_scale = std::max(
                prism_oracle_scale, std::max(std::abs(actual), std::abs(expected)));
        }
    }
    check(prism_oracle_scale > 0.0,
          "independent prism exchange oracle exercises a nonzero tangent block");
    check(prism_oracle_error <= 1.0e-12 * std::max(1.0, prism_oracle_scale),
          "native mixed prism exchange matches the independent weak-form oracle");

    std::vector<std::uint32_t> mixed_scalar_classes(
        static_cast<std::size_t>(mixed_node_count));
    std::vector<std::uint32_t> mixed_magnetic_classes(
        static_cast<std::size_t>(mixed_node_count));
    for (std::uint32_t node = 0u; node < mixed_node_count; ++node) {
        mixed_scalar_classes[static_cast<std::size_t>(node)] = node;
        mixed_magnetic_classes[static_cast<std::size_t>(node)] = node;
    }
    mfem::Array<int> mixed_boundary_marker(mixed_mesh.bdr_attributes.Max());
    mixed_boundary_marker = 1;
    fd::CsrMatrixView mixed_a_qq_view = mixed_a_qq.view();
    fd::PoissonAirboxSharedDomainAssemblyRequest mixed_shared_request{};
    mixed_shared_request.scalar_space = &mixed_scalar_space;
    mixed_shared_request.tangent_frames = mixed_descriptor.tangent_frames.data();
    mixed_shared_request.tangent_frame_count = mixed_descriptor.tangent_frames.size();
    mixed_shared_request.magnetic_element_mask = mixed_magnetic_elements.data();
    mixed_shared_request.magnetic_element_count = mixed_magnetic_elements.size();
    mixed_shared_request.uniform_saturation_magnetization_a_per_m = 2.0;
    mixed_shared_request.gamma0_m_per_a_s = 3.0;
    mixed_shared_request.mu0_T_m_A = 4.0;
    mixed_shared_request.magnetic_a_qq_csr = &mixed_a_qq_view;
    mixed_shared_request.scalar_reduced_node = mixed_scalar_classes.data();
    mixed_shared_request.scalar_reduced_node_count = mixed_scalar_classes.size();
    mixed_shared_request.magnetic_reduced_node = mixed_magnetic_classes.data();
    mixed_shared_request.magnetic_reduced_node_count = mixed_magnetic_classes.size();
    mixed_shared_request.equivalence_classes_complete = true;
    mixed_shared_request.boundary_kind = fd::PoissonAirboxBoundaryKind::robin;
    mixed_shared_request.robin_beta = 1.0;
    mixed_shared_request.robin_boundary_marker = &mixed_boundary_marker;
    fd::PoissonAirboxSharedDomainAssemblyResult mixed_shared_result{};
    check(fd::assemble_poisson_airbox_shared_domain(
              mixed_shared_request, &mixed_shared_result) ==
              fd::FrequencyDomainStatus::ok,
          mixed_shared_result.error_message);
    check(mixed_shared_result.operator_digest[0] != '\0',
          "mixed prism shared-domain assembly publishes its digest");
    check(!mixed_shared_result.quadrature_provenance_json.empty(),
          "mixed prism shared-domain assembly publishes quadrature provenance");
    check(mixed_shared_result.quadrature_provenance_json.find("\"geometry\":\"prism6\"") !=
              std::string::npos,
          "quadrature provenance identifies the prism6 geometry");
    check(mixed_shared_result.quadrature_provenance_json.find(
              "\"requested_quadrature_order\":4") != std::string::npos,
          "quadrature provenance reports the requested prism order");
    check(mixed_shared_result.quadrature_provenance_json.find(
              "\"resolved_quadrature_order\":" +
              std::to_string(prism_order4.GetOrder())) != std::string::npos,
          "quadrature provenance reports MFEM's resolved prism order");
    check(mixed_shared_result.quadrature_provenance_json.find(
              "\"rule_npoints\":" +
              std::to_string(prism_order4.GetNPoints())) != std::string::npos,
          "quadrature provenance reports MFEM prism rule point count");
    check(mixed_shared_result.quadrature_provenance_json.find("\"element_count\":1") !=
              std::string::npos,
          "quadrature provenance reports one magnetic prism element");

    // The exact affine prism scalar block has one and only one null vector:
    // the constant field.  The former centroid rule had rank at most three
    // and therefore introduced hourglass modes.  Undo any MFEM local signs so
    // this check remains about the reference prism rather than DOF orientation.
    mfem::Array<int> mixed_prism_dofs;
    mixed_scalar_space.GetElementDofs(0, mixed_prism_dofs);
    check(mixed_prism_dofs.Size() == 6, "mixed prism rank check has six scalar P1 dofs");
    std::vector<double> prism_scalar_matrix(36u, 0.0);
    for (int local_row = 0; local_row < 6; ++local_row) {
        const std::uint64_t row_node = static_cast<std::uint64_t>(
            mixed_prism_dofs[local_row] >= 0 ? mixed_prism_dofs[local_row] :
                                               -1 - mixed_prism_dofs[local_row]);
        const double row_sign = mixed_prism_dofs[local_row] >= 0 ? 1.0 : -1.0;
        for (int local_column = 0; local_column < 6; ++local_column) {
            const std::uint64_t column_node = static_cast<std::uint64_t>(
                mixed_prism_dofs[local_column] >= 0 ? mixed_prism_dofs[local_column] :
                                                       -1 - mixed_prism_dofs[local_column]);
            const double column_sign = mixed_prism_dofs[local_column] >= 0 ? 1.0 : -1.0;
            prism_scalar_matrix[static_cast<std::size_t>(local_row * 6 + local_column)] =
                row_sign * column_sign *
                matrix_value(mixed_a_qq, 2u * row_node, 2u * column_node);
        }
    }
    check(numerical_rank(prism_scalar_matrix, 6u) == 5u,
          "exact prism6 exchange scalar block has rank five");
    double constant_action = 0.0;
    for (int row = 0; row < 6; ++row) {
        double action = 0.0;
        for (int column = 0; column < 6; ++column) {
            action += prism_scalar_matrix[static_cast<std::size_t>(row * 6 + column)];
        }
        constant_action = std::max(constant_action, std::abs(action));
    }
    check(constant_action <= 1.0e-12,
          "constant prism6 perturbation is the exchange nullspace");
    constexpr double kHourglass[6] = {0.0, 1.0, -1.0, 0.0, -1.0, 1.0};
    double hourglass_energy = 0.0;
    for (int row = 0; row < 6; ++row) {
        double action = 0.0;
        for (int column = 0; column < 6; ++column) {
            action += prism_scalar_matrix[static_cast<std::size_t>(row * 6 + column)] *
                kHourglass[column];
        }
        hourglass_energy += kHourglass[row] * action;
    }
    check(std::abs(hourglass_energy - 8.0 / 3.0) <= 1.0e-11,
          "prism6 hourglass field has the exact positive exchange energy");

    // Repeat the same affine prism with independently rotated nodal tangent
    // bases.  The result must agree with the Cartesian frame-dot oracle and
    // must differ from the identity-frame matrix, proving the prism path uses
    // the supplied local-to-Cartesian transport.
    NativeExchangeDescriptorFixture rotated_mixed_descriptor(mixed_node_count);
    std::vector<fd::TangentFrameNode> rotated_mixed_frames =
        rotated_mixed_descriptor.tangent_frames;
    std::vector<double> rotated_mixed_frame_xyz =
        rotated_mixed_descriptor.tangent_frame_xyz;
    for (std::uint64_t node = 0u; node < mixed_node_count; ++node) {
        const double angle = 0.13 * static_cast<double>(node + 1u);
        const double cosine = std::cos(angle);
        const double sine = std::sin(angle);
        rotated_mixed_frames[static_cast<std::size_t>(node)].e1[0] = cosine;
        rotated_mixed_frames[static_cast<std::size_t>(node)].e1[1] = sine;
        rotated_mixed_frames[static_cast<std::size_t>(node)].e2[0] = -sine;
        rotated_mixed_frames[static_cast<std::size_t>(node)].e2[1] = cosine;
        for (int axis = 0; axis < 3; ++axis) {
            rotated_mixed_frame_xyz[6u * node + static_cast<std::size_t>(axis)] =
                rotated_mixed_frames[static_cast<std::size_t>(node)].e1[axis];
            rotated_mixed_frame_xyz[
                6u * node + 3u + static_cast<std::size_t>(axis)] =
                rotated_mixed_frames[static_cast<std::size_t>(node)].e2[axis];
        }
    }
    rotated_mixed_descriptor.descriptor.tangent_frame_xyz =
        rotated_mixed_frame_xyz.data();
    fd::PoissonAirboxSharedDomainCsrMatrix rotated_mixed_a_qq{};
    check(fd::assemble_native_magnetic_a_qq(
              rotated_mixed_descriptor.descriptor,
              &mixed_scalar_space,
              mixed_magnetic_elements.data(),
              mixed_magnetic_elements.size(),
              &rotated_mixed_a_qq,
              producer_error,
              nullptr,
              rotated_mixed_frames.data(),
              rotated_mixed_frames.size()) == fd::FrequencyDomainStatus::ok,
          producer_error);
    const std::vector<double> rotated_prism_exchange_oracle =
        independent_prism_exchange_exact_affine_oracle(
            mixed_scalar_space,
            mixed_magnetic_elements,
            rotated_mixed_frame_xyz,
            rotated_mixed_descriptor.exchange_edge.stiffness,
            mixed_node_count);
    double rotated_oracle_error = 0.0;
    double rotated_oracle_scale = 0.0;
    for (std::uint64_t row = 0u; row < mixed_q_count; ++row) {
        for (std::uint64_t column = 0u; column < mixed_q_count; ++column) {
            const double actual = matrix_value(rotated_mixed_a_qq, row, column);
            const double expected = rotated_prism_exchange_oracle[
                static_cast<std::size_t>(row * mixed_q_count + column)];
            rotated_oracle_error = std::max(rotated_oracle_error,
                                            std::abs(actual - expected));
            rotated_oracle_scale = std::max(
                rotated_oracle_scale, std::max(std::abs(actual), std::abs(expected)));
        }
    }
    check(max_matrix_difference(mixed_a_qq, rotated_mixed_a_qq) > 1.0e-6,
          "rotated prism tangent bases change the tangent-coordinate matrix");
    check(rotated_oracle_scale > 0.0 &&
              rotated_oracle_error <= 1.0e-12 * rotated_oracle_scale,
          "prism exchange transports independently rotated tangent bases");

    std::vector<double> prism_random_vector(static_cast<std::size_t>(mixed_q_count), 0.0);
    for (std::uint64_t index = 0u; index < mixed_q_count; ++index) {
        prism_random_vector[static_cast<std::size_t>(index)] =
            std::sin(0.19 * static_cast<double>(index + 1u)) +
            0.31 * std::cos(0.43 * static_cast<double>(index + 2u));
    }
    double prism_action_error = 0.0;
    double prism_action_scale = 0.0;
    double prism_energy = 0.0;
    for (std::uint64_t row = 0u; row < mixed_q_count; ++row) {
        double actual_action = 0.0;
        double oracle_action = 0.0;
        for (std::uint64_t column = 0u; column < mixed_q_count; ++column) {
            const double x = prism_random_vector[static_cast<std::size_t>(column)];
            actual_action += matrix_value(mixed_a_qq, row, column) * x;
            oracle_action += prism_exchange_oracle[
                static_cast<std::size_t>(row * mixed_q_count + column)] * x;
        }
        prism_action_error = std::max(prism_action_error,
                                      std::abs(actual_action - oracle_action));
        prism_action_scale = std::max(prism_action_scale,
                                      std::max(std::abs(actual_action),
                                               std::abs(oracle_action)));
        prism_energy += prism_random_vector[static_cast<std::size_t>(row)] * actual_action;
    }
    check(prism_action_error <= 1.0e-12 * std::max(1.0, prism_action_scale),
          "native mixed prism random-vector action matches the independent oracle");
    check(prism_energy >= -1.0e-12 * std::max(1.0, prism_action_scale),
          "native mixed prism exchange energy is positive semidefinite");
    mfem::Array<int> air_dofs;
    mixed_scalar_space.GetElementDofs(1, air_dofs);
    for (int local_air_dof = 0; local_air_dof < air_dofs.Size(); ++local_air_dof) {
        const std::uint64_t air_node = static_cast<std::uint64_t>(
            air_dofs[local_air_dof] >= 0 ? air_dofs[local_air_dof] : -1 - air_dofs[local_air_dof]);
        for (std::uint64_t column = 0u; column < mixed_q_count; ++column) {
            check(std::abs(matrix_value(mixed_a_qq, 2u * air_node, column)) <= 1.0e-15 &&
                      std::abs(matrix_value(mixed_a_qq, 2u * air_node + 1u, column)) <= 1.0e-15 &&
                      std::abs(matrix_value(mixed_a_qq, column, 2u * air_node)) <= 1.0e-15 &&
                      std::abs(matrix_value(mixed_a_qq, column, 2u * air_node + 1u)) <= 1.0e-15,
                  "air tet4 nodes remain isolated from native magnetic A_qq");
        }
    }

    // A warped prism exercises the variable Jacobian of the isoparametric
    // wedge.  The independent oracle below uses analytic prism gradients and
    // its own Duffy/Gauss GL4/GL5/GL7 rule (points per axis); it never consumes
    // MFEM's integration rule or CalcPhysDShape.  The producer remains MFEM
    // order4, while GL7 is used only as a high-order independent reference.
    const double deformed_prism_vertices[][3] = {
        {0.0, 0.0, 0.0}, {2.0, 0.0, 0.0}, {0.2, 1.4, 0.0},
        {0.15, 0.10, 1.0}, {2.4, 0.2, 1.15}, {0.0, 1.6, 0.85},
    };
    const auto make_deformed_prism_mesh = [&](bool cyclic_local_order) {
        std::unique_ptr<mfem::Mesh> result(new mfem::Mesh(3, 6, 1, 0, 3));
        for (const auto &vertex : deformed_prism_vertices) {
            result->AddVertex(vertex);
        }
        const int standard_wedge[] = {0, 1, 2, 3, 4, 5};
        const int cyclic_wedge[] = {1, 2, 0, 4, 5, 3};
        result->AddWedge(cyclic_local_order ? cyclic_wedge : standard_wedge, 1);
        result->FinalizeTopology();
        result->Finalize(false, true);
        return result;
    };

    std::unique_ptr<mfem::Mesh> deformed_prism_mesh = make_deformed_prism_mesh(false);
    mfem::H1_FECollection deformed_prism_collection(1, deformed_prism_mesh->Dimension());
    mfem::FiniteElementSpace deformed_prism_scalar_space(
        deformed_prism_mesh.get(), &deformed_prism_collection);
    const std::uint64_t deformed_prism_node_count =
        static_cast<std::uint64_t>(deformed_prism_scalar_space.GetVSize());
    check(deformed_prism_node_count == 6u,
          "deformed prism fixture must contain six P1 scalar nodes");
    const std::vector<std::uint8_t> deformed_prism_elements = {1u};
    NativeExchangeDescriptorFixture deformed_prism_descriptor(
        deformed_prism_node_count);
    fd::PoissonAirboxSharedDomainCsrMatrix deformed_prism_a_qq{};
    check(fd::assemble_native_magnetic_a_qq(
              deformed_prism_descriptor.descriptor,
              &deformed_prism_scalar_space,
              deformed_prism_elements.data(),
              deformed_prism_elements.size(),
              &deformed_prism_a_qq,
              producer_error,
              nullptr,
              deformed_prism_descriptor.tangent_frames.data(),
              deformed_prism_descriptor.tangent_frames.size()) == fd::FrequencyDomainStatus::ok,
          producer_error);
    const std::uint64_t deformed_prism_q_count =
        2u * deformed_prism_node_count;
    std::vector<double> deformed_prism_native_dense(
        static_cast<std::size_t>(deformed_prism_q_count * deformed_prism_q_count), 0.0);
    for (std::uint64_t row = 0u; row < deformed_prism_q_count; ++row) {
        for (std::uint64_t column = 0u; column < deformed_prism_q_count; ++column) {
            deformed_prism_native_dense[static_cast<std::size_t>(
                row * deformed_prism_q_count + column)] =
                matrix_value(deformed_prism_a_qq, row, column);
        }
    }
    const std::vector<double> deformed_prism_gl4 =
        independent_deformed_prism_exchange_oracle(
            deformed_prism_scalar_space,
            deformed_prism_elements,
            deformed_prism_descriptor.tangent_frame_xyz,
            deformed_prism_descriptor.exchange_edge.stiffness,
            deformed_prism_node_count,
            4);
    const std::vector<double> deformed_prism_gl5 =
        independent_deformed_prism_exchange_oracle(
            deformed_prism_scalar_space,
            deformed_prism_elements,
            deformed_prism_descriptor.tangent_frame_xyz,
            deformed_prism_descriptor.exchange_edge.stiffness,
            deformed_prism_node_count,
            5);
    const std::vector<double> deformed_prism_gl7 =
        independent_deformed_prism_exchange_oracle(
            deformed_prism_scalar_space,
            deformed_prism_elements,
            deformed_prism_descriptor.tangent_frame_xyz,
            deformed_prism_descriptor.exchange_edge.stiffness,
            deformed_prism_node_count,
            7);

    const auto check_deformed_prism_matrix = [&](const std::vector<double> &matrix,
                                                 const char *label) {
        check(matrix.size() == static_cast<std::size_t>(
                                  deformed_prism_q_count * deformed_prism_q_count),
              "deformed prism matrix has the expected dense dimensions");
        double scale = 0.0;
        double symmetry_error = 0.0;
        for (std::uint64_t row = 0u; row < deformed_prism_q_count; ++row) {
            for (std::uint64_t column = 0u; column < deformed_prism_q_count; ++column) {
                const double value = matrix[static_cast<std::size_t>(
                    row * deformed_prism_q_count + column)];
                const double transpose = matrix[static_cast<std::size_t>(
                    column * deformed_prism_q_count + row)];
                check(std::isfinite(value), "deformed prism matrix must be finite");
                scale = std::max(scale, std::abs(value));
                symmetry_error = std::max(symmetry_error, std::abs(value - transpose));
            }
        }
        check(scale > 0.0, "deformed prism matrix must be nonzero");
        check(symmetry_error <= 1.0e-11 * scale,
              "deformed prism exchange matrix must be symmetric");
        check(numerical_rank(matrix, static_cast<std::size_t>(deformed_prism_q_count)) == 10u,
              label);
        double constant_residual = 0.0;
        for (std::uint64_t component = 0u; component < 2u; ++component) {
            for (std::uint64_t row = 0u; row < deformed_prism_q_count; ++row) {
                double action = 0.0;
                for (std::uint64_t node = 0u; node < deformed_prism_node_count; ++node) {
                    action += matrix[static_cast<std::size_t>(
                        row * deformed_prism_q_count + 2u * node + component)];
                }
                constant_residual = std::max(constant_residual, std::abs(action));
            }
        }
        check(constant_residual <= 1.0e-10 * scale,
              "deformed prism constant tangent perturbations must remain in the exchange nullspace");
        double energy = 0.0;
        for (std::uint64_t row = 0u; row < deformed_prism_q_count; ++row) {
            const double row_value = std::sin(0.17 * static_cast<double>(row + 1u)) +
                0.29 * std::cos(0.41 * static_cast<double>(row + 2u));
            for (std::uint64_t column = 0u; column < deformed_prism_q_count; ++column) {
                const double column_value = std::sin(0.17 * static_cast<double>(column + 1u)) +
                    0.29 * std::cos(0.41 * static_cast<double>(column + 2u));
                energy += row_value * matrix[static_cast<std::size_t>(
                    row * deformed_prism_q_count + column)] * column_value;
            }
        }
        check(energy >= -1.0e-10 * scale,
              "deformed prism exchange matrix must be positive semidefinite");
    };
    check_deformed_prism_matrix(deformed_prism_native_dense,
                                "native deformed prism exchange must have rank ten");
    check_deformed_prism_matrix(deformed_prism_gl4,
                                "independent deformed prism GL4 oracle must have rank ten");
    check_deformed_prism_matrix(deformed_prism_gl5,
                                "independent deformed prism GL5 oracle must have rank ten");
    check_deformed_prism_matrix(deformed_prism_gl7,
                                "independent deformed prism GL7 oracle must have rank ten");

    const double gl4_gl5_error = dense_matrix_max_difference(
        deformed_prism_gl4, deformed_prism_gl5);
    const double gl5_gl7_error = dense_matrix_max_difference(
        deformed_prism_gl5, deformed_prism_gl7);
    const double gl7_scale = *std::max_element(
        deformed_prism_gl7.begin(), deformed_prism_gl7.end(),
        [](double left, double right) { return std::abs(left) < std::abs(right); });
    check(gl4_gl5_error > 1.0e-10,
          "deformed prism fixture must exercise non-affine quadrature sensitivity");
    check(gl5_gl7_error < gl4_gl5_error,
          "deformed prism reference GL quadrature must converge from GL4 through GL5 to GL7");
    check(dense_matrix_max_difference(deformed_prism_native_dense, deformed_prism_gl7) <=
              5.0e-5 * std::max(1.0, std::abs(gl7_scale)),
          "native MFEM prism order4 must agree with the independent GL7 reference");

    // A cyclic local permutation preserves the wedge orientation.  It must
    // not change the global matrix because the global vertex IDs and physical
    // coordinates are unchanged; a reversed permutation is deliberately not
    // admitted because it would create a negative physical Jacobian.
    std::unique_ptr<mfem::Mesh> permuted_deformed_prism_mesh =
        make_deformed_prism_mesh(true);
    mfem::H1_FECollection permuted_deformed_prism_collection(
        1, permuted_deformed_prism_mesh->Dimension());
    mfem::FiniteElementSpace permuted_deformed_prism_scalar_space(
        permuted_deformed_prism_mesh.get(), &permuted_deformed_prism_collection);
    NativeExchangeDescriptorFixture permuted_deformed_prism_descriptor(
        deformed_prism_node_count);
    fd::PoissonAirboxSharedDomainCsrMatrix permuted_deformed_prism_a_qq{};
    check(fd::assemble_native_magnetic_a_qq(
              permuted_deformed_prism_descriptor.descriptor,
              &permuted_deformed_prism_scalar_space,
              deformed_prism_elements.data(),
              deformed_prism_elements.size(),
              &permuted_deformed_prism_a_qq,
              producer_error,
              nullptr,
              permuted_deformed_prism_descriptor.tangent_frames.data(),
              permuted_deformed_prism_descriptor.tangent_frames.size()) ==
              fd::FrequencyDomainStatus::ok,
          producer_error);
    std::vector<double> permuted_deformed_prism_dense(
        static_cast<std::size_t>(deformed_prism_q_count * deformed_prism_q_count), 0.0);
    for (std::uint64_t row = 0u; row < deformed_prism_q_count; ++row) {
        for (std::uint64_t column = 0u; column < deformed_prism_q_count; ++column) {
            permuted_deformed_prism_dense[static_cast<std::size_t>(
                row * deformed_prism_q_count + column)] =
                matrix_value(permuted_deformed_prism_a_qq, row, column);
        }
    }
    check(dense_matrix_max_difference(
              deformed_prism_native_dense, permuted_deformed_prism_dense) <= 1.0e-11,
          "orientation-preserving prism vertex permutation must preserve the global exchange matrix");
    const std::vector<double> permuted_deformed_prism_gl7 =
        independent_deformed_prism_exchange_oracle(
            permuted_deformed_prism_scalar_space,
            deformed_prism_elements,
            permuted_deformed_prism_descriptor.tangent_frame_xyz,
            permuted_deformed_prism_descriptor.exchange_edge.stiffness,
            deformed_prism_node_count,
            7);
    check(dense_matrix_max_difference(deformed_prism_gl7,
                                      permuted_deformed_prism_gl7) <= 1.0e-11,
          "independent GL7 oracle must preserve an orientation-safe prism permutation");

    // Magnetic P1 pyramid5 and every non-P1 magnetic geometry are outside
    // the bounded N1a exchange scope and must reject without conversion.
    mfem::Mesh pyramid_mesh(3, 5, 1, 0, 3);
    const double pyramid_vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {1.0, 1.0, 0.0},
        {0.0, 1.0, 0.0}, {0.5, 0.5, 1.0},
    };
    for (const auto &vertex : pyramid_vertices) {
        pyramid_mesh.AddVertex(vertex);
    }
    const int pyramid5[] = {0, 1, 2, 3, 4};
    pyramid_mesh.AddPyramid(pyramid5, 1);
    pyramid_mesh.FinalizeTopology();
    pyramid_mesh.Finalize(false, true);
    mfem::H1_FECollection pyramid_collection(1, pyramid_mesh.Dimension());
    mfem::FiniteElementSpace pyramid_scalar_space(&pyramid_mesh, &pyramid_collection);
    NativeExchangeDescriptorFixture pyramid_descriptor(
        static_cast<std::uint64_t>(pyramid_scalar_space.GetVSize()));
    const std::vector<std::uint8_t> one_magnetic_element = {1u};
    check(fd::assemble_native_magnetic_a_qq(
              pyramid_descriptor.descriptor,
              &pyramid_scalar_space,
              one_magnetic_element.data(),
              one_magnetic_element.size(),
              &mixed_a_qq,
              producer_error,
              nullptr,
              pyramid_descriptor.tangent_frames.data(),
              pyramid_descriptor.tangent_frames.size()) == fd::FrequencyDomainStatus::unavailable,
          "native A_qq must reject magnetic P1 pyramid5 without fallback");
    check(std::strstr(producer_error, "P1 tet4 or prism6") != nullptr,
          "magnetic pyramid5 rejection must use the stable topology reason");
    mfem::H1_FECollection non_p1_collection(2, mixed_mesh.Dimension());
    mfem::FiniteElementSpace non_p1_scalar_space(&mixed_mesh, &non_p1_collection);
    NativeExchangeDescriptorFixture non_p1_descriptor(
        static_cast<std::uint64_t>(non_p1_scalar_space.GetVSize()));
    check(fd::assemble_native_magnetic_a_qq(
              non_p1_descriptor.descriptor,
              &non_p1_scalar_space,
              mixed_magnetic_elements.data(),
              mixed_magnetic_elements.size(),
              &mixed_a_qq,
              producer_error,
              nullptr,
              non_p1_descriptor.tangent_frames.data(),
              non_p1_descriptor.tangent_frames.size()) == fd::FrequencyDomainStatus::unavailable,
          "native A_qq must reject non-P1 magnetic prism6 without fallback");
    check(std::strstr(producer_error, "P1 tet4 or prism6") != nullptr,
          "non-P1 prism6 rejection must use the stable topology reason");

    // Endpoint changes are allowed only as changes to the temporary material
    // carrier.  They must not change native element assembly.
    const fullmag_fem_frequency_domain_exchange_edge alternative_edge{0u, 2u, 2.0};
    FullmagFemModalLinearizationDescriptor alternative_endpoint = producer_descriptor;
    alternative_endpoint.exchange_edges = &alternative_edge;
    fd::PoissonAirboxSharedDomainCsrMatrix alternative_endpoint_a_qq{};
    check(
        fd::assemble_native_magnetic_a_qq(
            alternative_endpoint,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &alternative_endpoint_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::ok,
        producer_error);
    check(max_matrix_difference(produced_a_qq, alternative_endpoint_a_qq) <= 1.0e-12,
          "exchange material-carrier endpoints must not select graph matrix entries");

    const fullmag_fem_frequency_domain_exchange_edge heterogeneous_edges[] = {
        {0u, 1u, 2.0},
        {1u, 2u, 2.0 + 1.0e-12},
    };
    FullmagFemModalLinearizationDescriptor heterogeneous_material = producer_descriptor;
    heterogeneous_material.exchange_edges = heterogeneous_edges;
    heterogeneous_material.exchange_edge_count = 2u;
    fd::PoissonAirboxSharedDomainCsrMatrix rejected_a_qq{};
    check(
        fd::assemble_native_magnetic_a_qq(
            heterogeneous_material,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &rejected_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::validation_error,
        "native exchange must reject heterogeneous material-carrier stiffness");
    check(std::strstr(producer_error, "homogeneous") != nullptr,
          "heterogeneous exchange must use a stable validation reason");

    std::vector<double> nonzero_parallel_h_eff = descriptor_h_eff;
    for (std::uint64_t node = 0; node < node_count; ++node) {
        nonzero_parallel_h_eff[3u * node + 2u] = 7.0;
    }
    FullmagFemModalLinearizationDescriptor field_without_presence_bit = producer_descriptor;
    field_without_presence_bit.effective_field_h_eff0_xyz = nonzero_parallel_h_eff.data();
    fd::PoissonAirboxSharedDomainCsrMatrix field_without_presence_bit_a_qq{};
    check(
        fd::assemble_native_magnetic_a_qq(
            field_without_presence_bit,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &field_without_presence_bit_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::ok,
        producer_error);
    check(max_matrix_difference(produced_a_qq, field_without_presence_bit_a_qq) <= 1.0e-12,
          "nonzero h_eff0 must be ignored when FIELD is absent");

    const fullmag_fem_frequency_domain_exchange_edge negative_stiffness_edge{0u, 1u, -2.0};
    FullmagFemModalLinearizationDescriptor negative_stiffness = producer_descriptor;
    negative_stiffness.exchange_edges = &negative_stiffness_edge;
    check(
        fd::assemble_native_magnetic_a_qq(
            negative_stiffness,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::validation_error,
        "native A_qq producer must reject non-positive exchange stiffness");
    check(std::strstr(producer_error, "stiffness must be positive") != nullptr,
          "non-positive exchange stiffness must use a stable validation reason");

    std::vector<std::uint8_t> airbox_elements(magnetic_elements.size(), 0u);
    check(
        fd::assemble_native_magnetic_a_qq(
            producer_descriptor,
            &scalar_space,
            airbox_elements.data(),
            airbox_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::validation_error,
        "native A_qq producer must reject exchange endpoints outside magnetic elements");
    check(std::strstr(producer_error, "magnetic node set") != nullptr,
          "airbox exchange endpoint rejection must use a stable validation reason");

    std::vector<double> transverse_h_eff = descriptor_h_eff;
    for (std::uint64_t node = 0; node < node_count; ++node) {
        transverse_h_eff[3u * node] = 1.0;
    }
    FullmagFemModalLinearizationDescriptor transverse_static_field = producer_descriptor;
    transverse_static_field.term_presence_mask = FULLMAG_FEM_MODAL_LINEARIZATION_TERM_FIELD;
    transverse_static_field.exchange_term_digest = nullptr;
    transverse_static_field.field_term_digest = producer_descriptor.linearization_state_digest;
    transverse_static_field.exchange_edges = nullptr;
    transverse_static_field.exchange_edge_count = 0u;
    transverse_static_field.effective_field_h_eff0_xyz = transverse_h_eff.data();
    check(
        fd::assemble_native_magnetic_a_qq(
            transverse_static_field,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::unavailable,
        "native A_qq producer must reject transverse static fields outside the certified scope");
    check(std::strstr(producer_error, "accepted equilibrium torque threshold") != nullptr,
          "transverse static field rejection must use a stable unsupported reason");

    check(
        fd::assemble_native_magnetic_a_qq(
            transverse_static_field,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size(),
            1.0) == fd::FrequencyDomainStatus::ok,
        "a transverse residual within the user-accepted torque threshold must be accepted");

    FullmagFemModalLinearizationDescriptor missing_demag_provider = producer_descriptor;
    missing_demag_provider.term_presence_mask |=
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG;
    missing_demag_provider.demag_term_digest = producer_descriptor.linearization_state_digest;
    check(
        fd::assemble_native_magnetic_a_qq(
            missing_demag_provider,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::validation_error,
        "native A_qq producer must require demag provider provenance");
    const char *operator_input_identity =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    FullmagFemModalLinearizationDescriptor mismatched_demag_provider = producer_descriptor;
    mismatched_demag_provider.term_presence_mask |=
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_DEMAG;
    mismatched_demag_provider.demag_term_digest = producer_descriptor.linearization_state_digest;
    mismatched_demag_provider.operator_input_digest = operator_input_identity;
    mismatched_demag_provider.demag_provider_signature = "sha256:other-provider";
    check(
        fd::assemble_native_magnetic_a_qq(
            mismatched_demag_provider,
            &scalar_space,
            magnetic_elements.data(),
            magnetic_elements.size(),
            &produced_a_qq,
            producer_error,
            nullptr,
            producer_frames.data(),
            producer_frames.size()) == fd::FrequencyDomainStatus::validation_error,
        "native A_qq producer must bind DEMAG provider provenance to the operator input");
    check(std::strstr(producer_error, "operator input digest") != nullptr,
          "demag provider mismatch must use a stable validation reason");

    std::vector<std::uint32_t> zero_row_offsets(static_cast<std::size_t>(q_count + 1u), 0u);
    fd::CsrMatrixView zero_a_qq{
        q_count,
        q_count,
        zero_row_offsets.data(),
        zero_row_offsets.size(),
        nullptr,
        0,
        nullptr,
        0};
    mfem::Array<int> boundary_marker(mesh.bdr_attributes.Max());
    boundary_marker = 1;

    fd::PoissonAirboxSharedDomainAssemblyRequest request{};
    request.scalar_space = &scalar_space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = node_count;
    request.magnetic_element_mask = magnetic_elements.data();
    request.magnetic_element_count = magnetic_elements.size();
    request.uniform_saturation_magnetization_a_per_m = 2.0;
    request.gamma0_m_per_a_s = 3.0;
    request.mu0_T_m_A = 4.0;
    request.magnetic_a_qq_csr = &zero_a_qq;
    request.scalar_reduced_node = scalar_classes.data();
    request.scalar_reduced_node_count = node_count;
    request.magnetic_reduced_node = magnetic_classes.data();
    request.magnetic_reduced_node_count = node_count;
    request.equivalence_classes_complete = true;
    request.boundary_kind = fd::PoissonAirboxBoundaryKind::robin;
    request.robin_beta = 1.0;
    request.robin_boundary_marker = &boundary_marker;

    fd::PoissonAirboxSharedDomainAssemblyResult result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.q_dof_count == q_count, "shared-domain q count is canonical");
    check(result.phi_dof_count == node_count, "shared-domain phi count is canonical");
    check(result.p.row_count == node_count && result.p.column_count == node_count,
          "shared-domain P has scalar dimensions");
    check(result.p.values.size() > 0, "shared-domain P has assembled entries");
    check(matrix_value(result.p, 0, 0) > 0.0, "Robin P has positive diagonal");
    check(result.a_phiq.values.size() > 0, "shared-domain scalar coupling is nonzero");
    check(result.a_qphi.values.size() > 0, "shared-domain tangent feedback is nonzero");
    check(result.k0_demag_probe.q_global_y.size() == q_count &&
              result.k0_demag_probe.q_global_z.size() == q_count,
          "K0 demag probe vectors use the assembled reduced tangent layout");
    check(result.k0_demag_probe.global_y_observable &&
              !result.k0_demag_probe.global_z_observable,
          "K0 demag probe identifies transverse and longitudinal global directions");
    check(result.k0_demag_probe.h_functional_global_y.size() == node_count &&
              result.k0_demag_probe.h_functional_global_z.size() == node_count &&
              result.k0_demag_probe.magnetic_volume_m3 > 0.0,
          "K0 demag probe carries field functionals and magnetic measure");
    for (std::uint64_t node = 0; node < node_count; ++node) {
        check(result.k0_demag_probe.q_global_y[2u * node] == 0.0 &&
                  result.k0_demag_probe.q_global_y[2u * node + 1u] == 1.0 &&
                  result.k0_demag_probe.q_global_z[2u * node] == 0.0 &&
                  result.k0_demag_probe.q_global_z[2u * node + 1u] == 0.0,
              "K0 demag probe projects global directions into the local tangent frame");
    }
    long double field_integral_from_y = 0.0L;
    long double field_integral_from_z = 0.0L;
    for (std::uint64_t node = 0; node < node_count; ++node) {
        const double *vertex = mesh.GetVertex(static_cast<int>(node));
        field_integral_from_y +=
            result.k0_demag_probe.h_functional_global_y[node] * vertex[1];
        field_integral_from_z +=
            result.k0_demag_probe.h_functional_global_z[node] * vertex[2];
    }
    check(std::abs(static_cast<double>(field_integral_from_y) /
                        result.k0_demag_probe.magnetic_volume_m3 + 1.0) < 1.0e-12 &&
              std::abs(static_cast<double>(field_integral_from_z) /
                           result.k0_demag_probe.magnetic_volume_m3 + 1.0) < 1.0e-12,
          "K0 demag field functionals reconstruct minus the exact P1 gradient");

    std::vector<fd::TangentFrameNode> de_frames = frames;
    for (fd::TangentFrameNode &frame : de_frames) {
        frame.m[0] = 1.0;
        frame.m[1] = 0.0;
        frame.m[2] = 0.0;
        frame.e1[0] = 0.0;
        frame.e1[1] = 1.0;
        frame.e1[2] = 0.0;
        frame.e2[0] = 0.0;
        frame.e2[1] = 0.0;
        frame.e2[2] = 1.0;
    }
    fd::PoissonAirboxSharedDomainAssemblyRequest de_request = request;
    de_request.tangent_frames = de_frames.data();
    fd::PoissonAirboxSharedDomainAssemblyResult de_result{};
    check(fd::assemble_poisson_airbox_shared_domain(de_request, &de_result) ==
              fd::FrequencyDomainStatus::ok,
          de_result.error_message);
    check(de_result.k0_demag_probe.global_y_observable &&
              de_result.k0_demag_probe.global_z_observable,
          "DE equilibrium makes both global transverse demag probes observable");
    for (std::uint64_t node = 0; node < node_count; ++node) {
        check(de_result.k0_demag_probe.q_global_y[2u * node] == 1.0 &&
                  de_result.k0_demag_probe.q_global_y[2u * node + 1u] == 0.0 &&
                  de_result.k0_demag_probe.q_global_z[2u * node] == 0.0 &&
                  de_result.k0_demag_probe.q_global_z[2u * node + 1u] == 1.0,
              "DE global y/z perturbations map to their expected tangent components");
    }
    check(std::abs(
              de_result.k0_demag_probe.magnetization_integral_global_y_a_per_m_m3 /
                  de_result.k0_demag_probe.magnetic_volume_m3 - 2.0) < 1.0e-12 &&
              std::abs(
                  de_result.k0_demag_probe.magnetization_integral_global_z_a_per_m_m3 /
                      de_result.k0_demag_probe.magnetic_volume_m3 - 2.0) < 1.0e-12,
          "DE probe integrates the applied perturbation magnetization with SI Ms");

    // Independent P1 tetrahedron oracle for A_phiq.  The production path
    // integrates this block with MFEM quadrature; this reference uses the
    // affine tetrahedron identity integral(lambda_i)=|K|/4 and the physical
    // barycentric gradients, so a source/sign error cannot be hidden by
    // reusing the production integrator.
    std::vector<double> reference_a_phiq(
        static_cast<std::size_t>(node_count * q_count), 0.0);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        const mfem::FiniteElement *finite_element = scalar_space.GetFE(element);
        check(finite_element->GetGeomType() == mfem::Geometry::TETRAHEDRON,
              "independent A_phiq oracle requires tetrahedral elements");
        mfem::Array<int> dofs;
        scalar_space.GetElementDofs(element, dofs);
        check(dofs.Size() == 4, "independent A_phiq oracle requires P1 tetrahedra");
        mfem::ElementTransformation *transformation =
            mesh.GetElementTransformation(element);
        mfem::IntegrationPoint centroid;
        centroid.x = 0.25;
        centroid.y = 0.25;
        centroid.z = 0.25;
        transformation->SetIntPoint(&centroid);
        const double element_volume = transformation->Weight() / 6.0;
        check(std::isfinite(element_volume) && element_volume > 0.0,
              "independent A_phiq oracle requires positive tetrahedron volume");
        mfem::DenseMatrix physical_dshape(dofs.Size(), 3);
        finite_element->CalcPhysDShape(*transformation, physical_dshape);
        for (int local_test = 0; local_test < dofs.Size(); ++local_test) {
            const std::uint64_t test_node = static_cast<std::uint64_t>(
                dofs[local_test] >= 0 ? dofs[local_test] : -1 - dofs[local_test]);
            const double test_sign = dofs[local_test] >= 0 ? 1.0 : -1.0;
            for (int local_trial = 0; local_trial < dofs.Size(); ++local_trial) {
                const std::uint64_t trial_node = static_cast<std::uint64_t>(
                    dofs[local_trial] >= 0 ? dofs[local_trial] : -1 - dofs[local_trial]);
                const double trial_sign = dofs[local_trial] >= 0 ? 1.0 : -1.0;
                for (std::uint32_t component = 0; component < 2u; ++component) {
                    const double projected_gradient = component == 0u
                        ? physical_dshape(local_test, 0)
                        : physical_dshape(local_test, 1);
                    reference_a_phiq[
                        static_cast<std::size_t>(test_node * q_count +
                                                 2u * trial_node + component)] +=
                        -test_sign * trial_sign *
                        request.uniform_saturation_magnetization_a_per_m *
                        (element_volume / 4.0) * projected_gradient;
                }
            }
        }
    }
    double source_oracle_error = 0.0;
    double source_oracle_scale = 0.0;
    for (std::uint64_t row = 0; row < result.a_phiq.row_count; ++row) {
        for (std::uint64_t column = 0; column < result.a_phiq.column_count; ++column) {
            const double actual = matrix_value(result.a_phiq, row, column);
            const double expected = reference_a_phiq[
                static_cast<std::size_t>(row * q_count + column)];
            source_oracle_error = std::max(source_oracle_error, std::abs(actual - expected));
            source_oracle_scale = std::max(
                source_oracle_scale,
                std::max(std::abs(actual), std::abs(expected)));
        }
    }
    check(source_oracle_scale > 0.0,
          "independent A_phiq oracle must exercise a nonzero source block");
    check(source_oracle_error <= 1.0e-12 * std::max(1.0, source_oracle_scale),
          "A_phiq must match the independent affine-tetrahedron quadrature oracle");
    std::vector<double> sign_flipped_reference = reference_a_phiq;
    for (double &value : sign_flipped_reference) {
        value = -value;
    }
    double sign_flip_error = 0.0;
    for (std::uint64_t row = 0; row < result.a_phiq.row_count; ++row) {
        for (std::uint64_t column = 0; column < result.a_phiq.column_count; ++column) {
            sign_flip_error = std::max(
                sign_flip_error,
                std::abs(matrix_value(result.a_phiq, row, column) -
                         sign_flipped_reference[
                             static_cast<std::size_t>(row * q_count + column)]));
        }
    }
    check(sign_flip_error > 1.0e-6 * source_oracle_scale,
          "A_phiq sign-flip negative control must be rejected by the independent oracle");
    double reciprocal_sign_error = 0.0;
    double reciprocal_scale = 0.0;
    for (std::uint64_t q = 0; q < result.a_qphi.row_count; ++q) {
        for (std::uint64_t phi = 0; phi < result.a_qphi.column_count; ++phi) {
            const double feedback = matrix_value(result.a_qphi, q, phi);
            const double source = matrix_value(result.a_phiq, phi, q);
            reciprocal_sign_error = std::max(
                reciprocal_sign_error,
                std::abs(feedback + request.mu0_T_m_A * source));
            reciprocal_scale = std::max(
                reciprocal_scale,
                std::max(std::abs(feedback),
                         std::abs(request.mu0_T_m_A * source)));
        }
    }
    check(reciprocal_sign_error <= 1.0e-12 * std::max(1.0, reciprocal_scale),
          "demag feedback must be -mu0 times the transpose Poisson source so the Schur Hessian is positive");
    check(result.b_qq.values.size() > 0, "shared-domain gyrotropic mass is nonzero");
    check(std::abs(matrix_value(result.b_qq, 0, 1) +
                   matrix_value(result.b_qq, 1, 0)) < 1.0e-12,
          "B_qq is skew-symmetric for alpha-zero energy-Hessian form");

    // Independent P1 tetrahedron mass oracle for B_qq.  For m0=e3, e1=e1,
    // e2=e2 the gyrotropic coefficient is [[0,-1],[1,0]] and the affine
    // tetrahedron mass identities are int(lambda_i^2)=V/10 and
    // int(lambda_i lambda_j)=V/20.  This reference uses only mesh vertices,
    // not MFEM quadrature or the production assembly implementation.
    std::vector<double> reference_b_qq(
        static_cast<std::size_t>(q_count * q_count), 0.0);
    const double gyrotropic_scale =
        request.mu0_T_m_A * request.uniform_saturation_magnetization_a_per_m /
        request.gamma0_m_per_a_s;
    const double equilibrium_m[3] = {0.0, 0.0, 1.0};
    const double tangent[2][3] = {{1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}};
    for (int element = 0; element < mesh.GetNE(); ++element) {
        const double volume = tetra_volume_from_vertices(mesh, element);
        mfem::Array<int> dofs;
        scalar_space.GetElementDofs(element, dofs);
        check(dofs.Size() == 4, "independent B_qq oracle requires P1 tetrahedra");
        for (int local_row = 0; local_row < dofs.Size(); ++local_row) {
            const std::uint64_t row_node = static_cast<std::uint64_t>(
                dofs[local_row] >= 0 ? dofs[local_row] : -1 - dofs[local_row]);
            const double row_sign = dofs[local_row] >= 0 ? 1.0 : -1.0;
            for (int local_column = 0; local_column < dofs.Size(); ++local_column) {
                const std::uint64_t column_node = static_cast<std::uint64_t>(
                    dofs[local_column] >= 0 ? dofs[local_column] : -1 - dofs[local_column]);
                const double column_sign = dofs[local_column] >= 0 ? 1.0 : -1.0;
                const double mass = volume *
                    (local_row == local_column ? 1.0 / 10.0 : 1.0 / 20.0);
                for (std::uint32_t row_component = 0; row_component < 2u; ++row_component) {
                    for (std::uint32_t column_component = 0; column_component < 2u;
                         ++column_component) {
                        const double *column_frame = tangent[column_component];
                        const double cross_value[3] = {
                            equilibrium_m[1] * column_frame[2] -
                                equilibrium_m[2] * column_frame[1],
                            equilibrium_m[2] * column_frame[0] -
                                equilibrium_m[0] * column_frame[2],
                            equilibrium_m[0] * column_frame[1] -
                                equilibrium_m[1] * column_frame[0]};
                        const double gyrotropic =
                            tangent[row_component][0] * cross_value[0] +
                            tangent[row_component][1] * cross_value[1] +
                            tangent[row_component][2] * cross_value[2];
                        reference_b_qq[static_cast<std::size_t>(
                            (2u * row_node + row_component) * q_count +
                            2u * column_node + column_component)] +=
                            -row_sign * column_sign * gyrotropic_scale * gyrotropic * mass;
                    }
                }
            }
        }
    }
    double gyrotropic_oracle_error = 0.0;
    double gyrotropic_oracle_scale = 0.0;
    for (std::uint64_t row = 0; row < result.b_qq.row_count; ++row) {
        for (std::uint64_t column = 0; column < result.b_qq.column_count; ++column) {
            const double actual = matrix_value(result.b_qq, row, column);
            const double expected = reference_b_qq[
                static_cast<std::size_t>(row * q_count + column)];
            gyrotropic_oracle_error = std::max(
                gyrotropic_oracle_error, std::abs(actual - expected));
            gyrotropic_oracle_scale = std::max(
                gyrotropic_oracle_scale, std::max(std::abs(actual), std::abs(expected)));
        }
    }
    check(gyrotropic_oracle_scale > 0.0,
          "independent B_qq oracle must exercise a nonzero gyrotropic block");
    check(gyrotropic_oracle_error <=
              1.0e-12 * std::max(1.0, gyrotropic_oracle_scale),
          "B_qq must match the independent affine-tetrahedron mass oracle");
    std::vector<double> gyrotropic_sign_flipped = reference_b_qq;
    for (double &value : gyrotropic_sign_flipped) {
        value = -value;
    }
    double gyrotropic_sign_flip_error = 0.0;
    for (std::uint64_t row = 0; row < result.b_qq.row_count; ++row) {
        for (std::uint64_t column = 0; column < result.b_qq.column_count; ++column) {
            gyrotropic_sign_flip_error = std::max(
                gyrotropic_sign_flip_error,
                std::abs(matrix_value(result.b_qq, row, column) -
                         gyrotropic_sign_flipped[
                             static_cast<std::size_t>(row * q_count + column)]));
        }
    }
    check(gyrotropic_sign_flip_error > 1.0e-6 * gyrotropic_oracle_scale,
          "B_qq sign-flip negative control must be rejected by the independent oracle");
    check(result.operator_digest[0] != '\0', "shared-domain assembly publishes digest");
    check(!result.quadrature_provenance_json.empty(),
          "shared-domain assembly publishes readable quadrature provenance");
    check(result.quadrature_provenance_json.find("\"geometry\":\"tet4\"") !=
              std::string::npos,
          "quadrature provenance identifies the tetrahedron geometry");
    check(result.quadrature_provenance_json.find("\"finite_element_order\":1") !=
              std::string::npos,
          "quadrature provenance reports the P1 finite-element order");
    check(result.quadrature_provenance_json.find("\"requested_quadrature_order\":5") !=
              std::string::npos,
          "quadrature provenance reports the requested tetrahedron order");
    check(result.quadrature_provenance_json.find(
              "\"resolved_quadrature_order\":" +
              std::to_string(tetra_order5.GetOrder())) != std::string::npos,
          "quadrature provenance reports MFEM's resolved tetrahedron order");
    check(result.quadrature_provenance_json.find(
              "\"rule_npoints\":" +
              std::to_string(tetra_order5.GetNPoints())) != std::string::npos,
          "quadrature provenance reports MFEM tetrahedron rule point count");
    check(result.quadrature_provenance_json.find("\"element_count\":1") !=
              std::string::npos,
          "quadrature provenance reports the actual magnetic-element count");

    fd::PoissonAirboxSharedDomainAssemblyRequest pure_neumann = request;
    pure_neumann.boundary_kind = fd::PoissonAirboxBoundaryKind::pure_neumann;
    pure_neumann.robin_beta = 0.0;
    pure_neumann.robin_boundary_marker = nullptr;
    fd::PoissonAirboxSharedDomainAssemblyResult pure_neumann_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(pure_neumann, &pure_neumann_result) ==
            fd::FrequencyDomainStatus::ok,
        pure_neumann_result.error_message);
    check(pure_neumann_result.phi_mean_weights.size() == node_count,
          "pure-Neumann assembly publishes one mean weight per scalar class");
    double mean_weight_sum = 0.0;
    for (double value : pure_neumann_result.phi_mean_weights) {
        check(std::isfinite(value) && value > 0.0,
              "pure-Neumann mean weights are finite and positive");
        mean_weight_sum += value;
    }
    check(std::abs(mean_weight_sum - 1.0) <= 1.0e-12,
          "pure-Neumann gauge vector is normalized to unit measure");
    check(std::strcmp(pure_neumann_result.gauge_policy, "mean_zero_augmented") == 0,
          "pure-Neumann assembly publishes the mean-zero gauge policy");

    fd::PoissonAirboxSharedDomainAssemblyRequest floquet_gauge = pure_neumann;
    floquet_gauge.pure_neumann_gauge_policy =
        fd::PoissonAirboxPureNeumannGaugePolicy::require_invertible;
    fd::PoissonAirboxSharedDomainAssemblyResult floquet_gauge_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(floquet_gauge, &floquet_gauge_result) ==
            fd::FrequencyDomainStatus::ok,
        floquet_gauge_result.error_message);
    check(floquet_gauge_result.phi_mean_weights.empty(),
          "require-invertible pure-Neumann assembly must not publish a k=0 gauge vector");
    check(std::strcmp(floquet_gauge_result.gauge_policy, "require_invertible") == 0,
          "require-invertible pure-Neumann assembly publishes its explicit policy");

    fd::PoissonAirboxSharedDomainAssemblyRequest dirichlet = request;
    dirichlet.boundary_kind = fd::PoissonAirboxBoundaryKind::dirichlet;
    dirichlet.robin_beta = 0.0;
    fd::PoissonAirboxSharedDomainAssemblyResult dirichlet_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(dirichlet, &dirichlet_result) ==
            fd::FrequencyDomainStatus::ok,
        dirichlet_result.error_message);
    check(!dirichlet_result.dirichlet_dofs.empty(),
          "Dirichlet assembly publishes reduced essential DOFs");
    check(std::strcmp(dirichlet_result.gauge_policy, "none") == 0,
          "Dirichlet assembly does not publish a gauge constraint");
    for (std::uint64_t row = 0; row < dirichlet_result.a_phiq.row_count; ++row) {
        for (std::uint32_t entry =
                 dirichlet_result.a_phiq.row_offsets[static_cast<std::size_t>(row)];
             entry < dirichlet_result.a_phiq.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            check(std::find(
                      dirichlet_result.dirichlet_dofs.begin(),
                      dirichlet_result.dirichlet_dofs.end(),
                      static_cast<std::uint32_t>(row)) ==
                      dirichlet_result.dirichlet_dofs.end(),
                  "Dirichlet A_phiq rows must exclude essential potential DOFs");
        }
    }
    for (std::uint64_t row = 0; row < dirichlet_result.a_qphi.row_count; ++row) {
        for (std::uint32_t entry =
                 dirichlet_result.a_qphi.row_offsets[static_cast<std::size_t>(row)];
             entry < dirichlet_result.a_qphi.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            check(std::find(
                      dirichlet_result.dirichlet_dofs.begin(),
                      dirichlet_result.dirichlet_dofs.end(),
                      dirichlet_result.a_qphi.column_indices[entry]) ==
                      dirichlet_result.dirichlet_dofs.end(),
                  "Dirichlet A_qphi columns must exclude essential potential DOFs");
        }
    }

    std::vector<std::uint32_t> reduced_scalar_classes(static_cast<std::size_t>(node_count));
    std::vector<std::uint32_t> reduced_magnetic_classes(static_cast<std::size_t>(node_count));
    for (std::uint32_t node = 0; node < node_count; ++node) {
        reduced_scalar_classes[node] = node % 2u;
        reduced_magnetic_classes[node] = node % 2u;
    }
    fd::PoissonAirboxSharedDomainAssemblyRequest reduced = pure_neumann;
    reduced.scalar_reduced_node = reduced_scalar_classes.data();
    reduced.scalar_reduced_node_count = 2;
    reduced.magnetic_reduced_node = reduced_magnetic_classes.data();
    reduced.magnetic_reduced_node_count = 2;
    fd::PoissonAirboxSharedDomainAssemblyResult reduced_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(reduced, &reduced_result) ==
            fd::FrequencyDomainStatus::ok,
        reduced_result.error_message);
    check(reduced_result.phi_dof_count == 2 && reduced_result.q_dof_count == 4,
          "complete equivalence classes reduce scalar and tangent dimensions");
    check(reduced_result.p.row_count == 2 && reduced_result.p.column_count == 2,
          "reduced P has class dimensions");
    check(reduced_result.phi_mean_weights.size() == 2,
          "reduced pure-Neumann gauge vector follows scalar classes");

    fd::PoissonAirboxSharedDomainAssemblyRequest incomplete = request;
    incomplete.equivalence_classes_complete = false;
    fd::PoissonAirboxSharedDomainAssemblyResult rejected{};
    check(
        fd::assemble_poisson_airbox_shared_domain(incomplete, &rejected) ==
            fd::FrequencyDomainStatus::validation_error,
        "shared-domain assembly rejects incomplete equivalence classes");

    const std::vector<double> payload_nodes = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0};
    const std::vector<std::uint32_t> payload_cell_types = {FULLMAG_FEM_CELL_TET4};
    const std::vector<std::uint32_t> payload_cell_offsets = {0u, 4u};
    const std::vector<std::uint32_t> payload_cell_nodes = {0u, 1u, 2u, 3u};
    const std::vector<std::uint64_t> payload_cell_ordinals = {0u};
    const std::vector<std::uint32_t> payload_cell_markers = {1u};
    const std::vector<std::uint32_t> payload_facet_types(4u, FULLMAG_FEM_FACET_TRI3);
    const std::vector<std::uint32_t> payload_facet_roles(
        4u, FULLMAG_FEM_FACET_ROLE_EXTERIOR);
    const std::vector<std::uint32_t> payload_facet_offsets = {0u, 3u, 6u, 9u, 12u};
    const std::vector<std::uint32_t> payload_facet_nodes = {
        1u, 2u, 3u,
        0u, 3u, 2u,
        0u, 1u, 3u,
        0u, 2u, 1u};
    const std::vector<std::uint64_t> payload_facet_ordinals = {0u, 1u, 2u, 3u};
    const std::vector<std::uint32_t> payload_facet_markers(4u, 1u);
    const fullmag_fem_mesh_desc payload_mesh{
        FULLMAG_FEM_MESH_DESC_ABI_VERSION,
        sizeof(fullmag_fem_mesh_desc),
        payload_nodes.data(), payload_nodes.size(),
        payload_cell_types.data(), payload_cell_types.size(),
        payload_cell_offsets.data(), payload_cell_offsets.size(),
        payload_cell_nodes.data(), payload_cell_nodes.size(),
        payload_cell_ordinals.data(), payload_cell_ordinals.size(),
        payload_cell_markers.data(), payload_cell_markers.size(),
        payload_facet_types.data(), payload_facet_types.size(),
        payload_facet_roles.data(), payload_facet_roles.size(),
        payload_facet_offsets.data(), payload_facet_offsets.size(),
        payload_facet_nodes.data(), payload_facet_nodes.size(),
        payload_facet_ordinals.data(), payload_facet_ordinals.size(),
        payload_facet_markers.data(), payload_facet_markers.size(),
        nullptr, 0u,
        nullptr, 0u};
    const std::vector<double> payload_equilibrium = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0};
    const std::vector<double> payload_h_eff0 = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0};
    const std::vector<double> payload_h_demag0(12u, 0.0);
    const std::vector<double> payload_phi0(4u, 0.0);
    const std::vector<std::uint32_t> payload_scalar_classes = {0u, 1u, 2u, 3u};
    const std::vector<std::uint32_t> payload_magnetic_classes = {0u, 1u, 2u, 3u};
    const std::vector<std::uint32_t> payload_a_qq_offsets(9u, 0u);
    const char *payload_boundary = "robin";
    const char *payload_digest = "sha256:payload-test";
    const char *payload_equilibrium_id = "equilibrium_artifact.v7:payload-test";
    const char *payload_snapshot_id = "sha256:snapshot-test";
    const char *payload_producer = "test:poisson-airbox-shared-domain";
    const char *payload_demag_model = "poisson_robin";
    std::vector<double> payload_descriptor_frames(24u, 0.0);
    std::vector<double> payload_descriptor_m0 = payload_equilibrium;
    std::vector<double> payload_descriptor_h_eff = payload_h_eff0;
    for (std::uint64_t node = 0; node < 4u; ++node) {
        payload_descriptor_frames[6u * node] = 1.0;
        payload_descriptor_frames[6u * node + 4u] = 1.0;
    }
    FullmagFemModalLinearizationDescriptor payload_descriptor{};
    payload_descriptor.abi_version =
        FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION;
    payload_descriptor.struct_size = sizeof(payload_descriptor);
    payload_descriptor.node_count = 4u;
    payload_descriptor.tangent_dof_count = 8u;
    payload_descriptor.tangent_frame_xyz = payload_descriptor_frames.data();
    payload_descriptor.tangent_frame_xyz_count = payload_descriptor_frames.size();
    payload_descriptor.equilibrium_m0_xyz = payload_descriptor_m0.data();
    payload_descriptor.equilibrium_m0_xyz_count = payload_descriptor_m0.size();
    payload_descriptor.effective_field_h_eff0_xyz = payload_descriptor_h_eff.data();
    payload_descriptor.effective_field_h_eff0_xyz_count = payload_descriptor_h_eff.size();
    payload_descriptor.uniform_saturation_magnetisation_a_per_m = 2.0;
    payload_descriptor.schema_version = FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_SCHEMA;
    payload_descriptor.coordinate_unit = "m";
    payload_descriptor.magnetisation_unit = "A/m";
    payload_descriptor.time_unit = "s";
    payload_descriptor.frequency_unit = "Hz";
    payload_descriptor.angular_frequency_unit = "rad/s";
    payload_descriptor.linearization_state_digest =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    payload_descriptor.equilibrium_digest = payload_descriptor.linearization_state_digest;
    payload_descriptor.operator_input_digest = payload_descriptor.linearization_state_digest;
    payload_descriptor.term_presence_mask =
        FULLMAG_FEM_MODAL_LINEARIZATION_TERM_EXCHANGE;
    FullmagFemModalExchangeMaterialView payload_material_view{};
    payload_material_view.abi_version =
        FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION;
    payload_material_view.struct_size = sizeof(payload_material_view);
    payload_material_view.schema_version = FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_SCHEMA;
    payload_material_view.material_kind = FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX;
    payload_material_view.exchange_stiffness_j_per_m = 2.0;
    FullmagFemModalSharedDomainPayload payload{};
    payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    payload.struct_size = sizeof(FullmagFemModalSharedDomainPayload);
    payload.mesh = &payload_mesh;
    payload.equilibrium_m0_xyz = payload_equilibrium.data();
    payload.equilibrium_m0_xyz_count = payload_equilibrium.size();
    payload.linearization_m0_xyz = payload_equilibrium.data();
    payload.linearization_m0_xyz_count = payload_equilibrium.size();
    payload.linearization_h_eff0_xyz = payload_h_eff0.data();
    payload.linearization_h_eff0_xyz_count = payload_h_eff0.size();
    payload.linearization_h_demag0_xyz = payload_h_demag0.data();
    payload.linearization_h_demag0_xyz_count = payload_h_demag0.size();
    payload.linearization_phi0 = payload_phi0.data();
    payload.linearization_phi0_count = payload_phi0.size();
    payload.uniform_saturation_magnetisation_a_per_m = 2.0;
    payload.gamma0_m_per_a_s = 3.0;
    payload.magnetic_a_qq_csr = FullmagFemCsrMatrixView{
        8u, 8u, payload_a_qq_offsets.data(), payload_a_qq_offsets.size(),
        nullptr, 0u, nullptr, 0u};
    payload.scalar_reduced_node = payload_scalar_classes.data();
    payload.scalar_reduced_node_count = payload_scalar_classes.size();
    payload.magnetic_reduced_node = payload_magnetic_classes.data();
    payload.magnetic_reduced_node_count = payload_magnetic_classes.size();
    payload.magnetic_pair_count = 1u;
    payload.airbox_pair_count = 1u;
    payload.boundary_kind = payload_boundary;
    payload.robin_beta = 1.0;
    payload.boundary_marker = 1u;
    payload.equilibrium_digest = payload_digest;
    payload.mesh_certificate_digest = payload_digest;
    payload.mesh_certificate_schema = "periodic_mesh_certificate.v6";
    payload.linearization_state_digest = payload_digest;
    payload.equilibrium_id = payload_equilibrium_id;
    payload.mesh_snapshot_id = payload_snapshot_id;
    payload.material_snapshot_id = payload_snapshot_id;
    payload.physics_snapshot_id = payload_snapshot_id;
    payload.boundary_snapshot_id = payload_snapshot_id;
    payload.producer_run_id = payload_producer;
    payload.equilibrium_content_sha256 = payload_digest;
    payload.demag_model = payload_demag_model;
    payload.m0_norm_tolerance = 1.0e-8;
    payload.equilibrium_torque_relative_tolerance = 0.0;
    payload.mesh_certificate_map_binding_digest = payload_digest;
    payload.boundary_gauge_digest = payload_digest;
    payload.magnetic_part_identity = "part:magnetic";
    payload.airbox_part_identity = "part:airbox";
    payload.mesh_generation_identity = "mesh-generation:fixture";
    payload.linearization_descriptor = &payload_descriptor;
    payload.exchange_material_view = &payload_material_view;
    payload.acceptance_criterion = "energy";
    payload.acceptance_metric_kind = "total_energy_plateau_range_j";
    payload.acceptance_unit = "J";
    payload.acceptance_metric_value = 2.5e-19;
    payload.acceptance_threshold = 1.0e-18;
    payload.acceptance_certificate_sha256 =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    FullmagFemModalSharedDomainPayload missing_descriptor = payload;
    missing_descriptor.linearization_descriptor = nullptr;
    missing_descriptor.exchange_material_view = nullptr;
    fd::PoissonAirboxSharedDomainAssemblyResult missing_descriptor_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            missing_descriptor, &missing_descriptor_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "v19 payload must reject legacy A_qq without a linearization descriptor");
    check(std::strstr(missing_descriptor_result.error_message,
                      "linearization_descriptor_missing") != nullptr,
          "legacy A_qq rejection must use stable missing-descriptor reason");
    FullmagFemModalSharedDomainPayload v17_prefix_payload = payload;
    v17_prefix_payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_V17_ABI_VERSION;
    v17_prefix_payload.struct_size = static_cast<std::uint32_t>(
        offsetof(FullmagFemModalSharedDomainPayload, linearization_descriptor));
    fd::PoissonAirboxSharedDomainAssemblyResult v17_prefix_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            v17_prefix_payload, &v17_prefix_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "v17 payload must fail before any v19 tail read");
    check(std::strstr(v17_prefix_result.error_message,
                      "requires a full v19 acceptance-certificate prefix") != nullptr,
          "v17 prefix rejection must use a stable ABI reason");
    FullmagFemModalSharedDomainPayload v16_prefix_payload = payload;
    v16_prefix_payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_V16_ABI_VERSION;
    v16_prefix_payload.struct_size = static_cast<std::uint32_t>(
        offsetof(FullmagFemModalSharedDomainPayload, mesh_generation_identity));
    fd::PoissonAirboxSharedDomainAssemblyResult v16_prefix_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            v16_prefix_payload, &v16_prefix_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "v16 payload must fail before any v19 tail read");
    check(std::strstr(v16_prefix_result.error_message,
                      "requires a full v19 acceptance-certificate prefix") != nullptr,
          "v16 prefix rejection must use a stable ABI reason");
    fd::PoissonAirboxSharedDomainAssemblyResult payload_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(payload, &payload_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "single-region payload must fail closed before native assembly");
    check(std::strstr(payload_result.error_message,
                      "requires both magnetic and airbox cell regions") != nullptr,
          "single-region map rejection must use a stable reason");

    // Public importer fixture: one magnetic tetrahedral film element and one
    // adjacent airbox tetrahedron sharing a face.  The marker 1/0 split is
    // also the native region map used for exchange isolation.  The mesh
    // carries concrete x/y seam/corner node pairs and the v6 certificate views
    // below bind those relations to the magnetic and airbox part identities;
    // the pair counters remain a consistency check, not a topology source.
    const std::vector<double> film_air_nodes = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, -1.0};
    const std::vector<std::uint32_t> film_air_cell_types = {
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    const std::vector<std::uint32_t> film_air_cell_offsets = {0u, 4u, 8u};
    const std::vector<std::uint32_t> film_air_cell_nodes = {
        0u, 1u, 2u, 3u,
        0u, 2u, 1u, 4u};
    const std::vector<std::uint64_t> film_air_cell_ordinals = {0u, 1u};
    const std::vector<std::uint32_t> film_air_cell_markers = {1u, 0u};
    const std::vector<std::uint32_t> film_air_facet_types(
        6u, FULLMAG_FEM_FACET_TRI3);
    const std::vector<std::uint32_t> film_air_facet_roles = {
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    const std::vector<std::uint32_t> film_air_facet_offsets = {
        0u, 3u, 6u, 9u, 12u, 15u, 18u};
    const std::vector<std::uint32_t> film_air_facet_nodes = {
        1u, 2u, 3u,
        0u, 3u, 2u,
        0u, 1u, 3u,
        1u, 4u, 2u,
        0u, 2u, 4u,
        0u, 1u, 4u};
    const std::vector<std::uint64_t> film_air_facet_ordinals = {
        0u, 1u, 2u, 3u, 4u, 5u};
    const std::vector<std::uint32_t> film_air_facet_markers = {7u, 8u, 1u, 1u, 1u, 1u};
    const std::vector<std::uint32_t> film_air_periodic_node_pairs = {
        0u, 1u, 0u, 2u, 0u, 3u, 1u, 2u, 1u, 3u, 2u, 3u};
    const std::vector<std::uint32_t> film_air_periodic_boundary_markers = {
        7u, 8u, 9u, 10u};
    const fullmag_fem_mesh_desc film_air_mesh{
        FULLMAG_FEM_MESH_DESC_ABI_VERSION,
        sizeof(fullmag_fem_mesh_desc),
        film_air_nodes.data(), film_air_nodes.size(),
        film_air_cell_types.data(), film_air_cell_types.size(),
        film_air_cell_offsets.data(), film_air_cell_offsets.size(),
        film_air_cell_nodes.data(), film_air_cell_nodes.size(),
        film_air_cell_ordinals.data(), film_air_cell_ordinals.size(),
        film_air_cell_markers.data(), film_air_cell_markers.size(),
        film_air_facet_types.data(), film_air_facet_types.size(),
        film_air_facet_roles.data(), film_air_facet_roles.size(),
        film_air_facet_offsets.data(), film_air_facet_offsets.size(),
        film_air_facet_nodes.data(), film_air_facet_nodes.size(),
        film_air_facet_ordinals.data(), film_air_facet_ordinals.size(),
        film_air_facet_markers.data(), film_air_facet_markers.size(),
        film_air_periodic_node_pairs.data(), film_air_periodic_node_pairs.size(),
        film_air_periodic_boundary_markers.data(), film_air_periodic_boundary_markers.size()};
    check_context_modal_mesh_import_identity(film_air_mesh);
    fullmag_fem_mesh_desc invalid_global_ordinals_mesh = film_air_mesh;
    invalid_global_ordinals_mesh.cell_global_ordinals_len = 1u;
    check_context_modal_mesh_rejection_identity(
        invalid_global_ordinals_mesh,
        "Context and modal imports reject incomplete cell global ordinals");
    const std::vector<std::uint32_t> invalid_typed_cell_offsets = {0u, 4u, 7u};
    fullmag_fem_mesh_desc invalid_typed_csr_mesh = film_air_mesh;
    invalid_typed_csr_mesh.cell_offsets = invalid_typed_cell_offsets.data();
    check_context_modal_mesh_rejection_identity(
        invalid_typed_csr_mesh,
        "Context and modal imports reject invalid typed cell CSR");
    const std::vector<double> film_air_equilibrium = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0};
    const std::vector<double> film_air_linearization_m0 = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0};
    const std::vector<double> film_air_linearization_h_eff = film_air_linearization_m0;
    const std::vector<double> film_air_h_demag(15u, 0.0);
    const std::vector<double> film_air_phi0(5u, 0.0);
    const std::vector<std::uint32_t> film_air_scalar_classes = {0u, 0u, 0u, 0u, 1u};
    const std::vector<std::uint32_t> film_air_magnetic_classes = {
        0u, 0u, 0u, 0u, std::numeric_limits<std::uint32_t>::max()};
    const std::vector<std::uint32_t> film_air_a_qq_offsets(11u, 0u);
    std::vector<double> film_air_descriptor_frames(30u, 0.0);
    const std::vector<double> film_air_descriptor_external(15u, 0.0);
    const std::vector<double> film_air_descriptor_alpha(5u, 0.01);
    for (std::uint64_t node = 0; node < 5u; ++node) {
        film_air_descriptor_frames[6u * node] = 1.0;
        film_air_descriptor_frames[6u * node + 4u] = 1.0;
    }
    std::vector<double> film_air_descriptor_m0 = film_air_equilibrium;
    std::vector<double> film_air_descriptor_h_eff = film_air_equilibrium;
    const std::vector<std::uint32_t> magnetic_certificate_region_ids(4u, 1u);
    const std::vector<std::uint32_t> scalar_certificate_region_ids(5u, 2u);
    const std::vector<std::uint32_t> magnetic_certificate_boundary_axis_masks = {
        0u, 1u, 2u, 7u};
    const std::vector<std::uint32_t> scalar_certificate_boundary_axis_masks = {
        0u, 1u, 2u, 7u, 4u};
    const FullmagFemModalCertificateV6RegionRole magnetic_certificate_roles[] = {
        {1u, 1u}};
    const FullmagFemModalCertificateV6RegionRole scalar_certificate_roles[] = {
        {2u, 2u}};
    const FullmagFemModalCertificateV6Relation magnetic_generator_relations[] = {
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u}};
    const FullmagFemModalCertificateV6Relation magnetic_closure_relations[] = {
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u},
        {1u, 2u, 3u, 2u}, {1u, 3u, 6u, 2u}, {2u, 3u, 5u, 2u}};
    const FullmagFemModalCertificateV6Relation scalar_generator_relations[] = {
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u}};
    const FullmagFemModalCertificateV6Relation scalar_closure_relations[] = {
        {0u, 1u, 1u, 1u}, {0u, 2u, 2u, 1u}, {0u, 3u, 7u, 3u},
        {1u, 2u, 3u, 2u}, {1u, 3u, 6u, 2u}, {2u, 3u, 5u, 2u}};
    const auto make_certificate_view = [&](std::uint32_t view_kind,
                                           std::uint32_t part_role,
                                           const char *part_identity,
                                           const char *topology_fingerprint,
                                           const std::uint32_t *region_ids,
                                           const std::uint32_t *boundary_axis_masks,
                                           std::uint64_t view_node_count,
                                           const FullmagFemModalCertificateV6RegionRole *roles,
                                           std::uint64_t role_count,
                                           const FullmagFemModalCertificateV6Relation *generator,
                                           std::uint64_t generator_count,
                                           const FullmagFemModalCertificateV6Relation *closure,
                                           std::uint64_t closure_count) {
        FullmagFemModalCertificateV6View view{};
        view.view_kind = view_kind;
        view.part_role = part_role;
        view.part_identity = part_identity;
        view.topology_fingerprint = topology_fingerprint;
        view.node_count = view_node_count;
        view.region_ids = region_ids;
        view.boundary_axis_masks = boundary_axis_masks;
        view.region_roles = roles;
        view.region_role_count = role_count;
        view.generator_relations = generator;
        view.generator_relation_count = generator_count;
        view.closure_relations = closure;
        view.closure_relation_count = closure_count;
        view.require_complete_closure = 1u;
        return view;
    };
    FullmagFemModalCertificateV6BindingRequest film_air_certificate{};
    film_air_certificate.schema_version = "periodic_mesh_certificate.v6";
    film_air_certificate.mesh_magnetic = make_certificate_view(
        1u, 1u, "magnetic:film", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        magnetic_certificate_region_ids.data(), magnetic_certificate_boundary_axis_masks.data(),
        4u, magnetic_certificate_roles, 1u, magnetic_generator_relations, 3u,
        magnetic_closure_relations, 6u);
    film_air_certificate.payload_magnetic = make_certificate_view(
        2u, 1u, "magnetic:film", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        magnetic_certificate_region_ids.data(), magnetic_certificate_boundary_axis_masks.data(),
        4u, magnetic_certificate_roles, 1u, magnetic_generator_relations, 3u,
        magnetic_closure_relations, 6u);
    film_air_certificate.mesh_scalar = make_certificate_view(
        1u, 2u, "airbox:shared", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        scalar_certificate_region_ids.data(), scalar_certificate_boundary_axis_masks.data(),
        5u, scalar_certificate_roles, 1u, scalar_generator_relations, 3u,
        scalar_closure_relations, 6u);
    film_air_certificate.payload_scalar = make_certificate_view(
        2u, 2u, "airbox:shared", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        scalar_certificate_region_ids.data(), scalar_certificate_boundary_axis_masks.data(),
        5u, scalar_certificate_roles, 1u, scalar_generator_relations, 3u,
        scalar_closure_relations, 6u);
    const auto to_typed_certificate_view = [&](const FullmagFemModalCertificateV6View &source) {
        fd::MeshSymmetryCertificateV6View view{};
        view.schema_version = film_air_certificate.schema_version;
        view.view_kind = static_cast<fd::MeshSymmetryCertificateV6ViewKind>(source.view_kind);
        view.part_role = static_cast<fd::MeshSymmetryCertificatePartRole>(source.part_role);
        view.part_identity = source.part_identity;
        view.topology_fingerprint = source.topology_fingerprint;
        view.node_count = source.node_count;
        view.region_ids = source.region_ids;
        view.boundary_axis_masks = source.boundary_axis_masks;
        view.region_roles = reinterpret_cast<const fd::MeshSymmetryCertificateRegionRole *>(
            source.region_roles);
        view.region_role_count = source.region_role_count;
        view.generator_relations = reinterpret_cast<const fd::MeshSymmetryCertificateV6Relation *>(
            source.generator_relations);
        view.generator_relation_count = source.generator_relation_count;
        view.closure_relations = reinterpret_cast<const fd::MeshSymmetryCertificateV6Relation *>(
            source.closure_relations);
        view.closure_relation_count = source.closure_relation_count;
        view.require_complete_closure = source.require_complete_closure != 0u;
        view.expected_class_ids = source.expected_class_ids;
        view.expected_class_id_count = source.expected_class_id_count;
        view.expected_class_digests = reinterpret_cast<const fd::MeshSymmetryCertificateV6ClassDigest *>(
            source.expected_class_digests);
        view.expected_class_digest_count = source.expected_class_digest_count;
        return view;
    };
    fd::MeshSymmetryCertificateV6BindingRequest certificate_bootstrap_request{};
    certificate_bootstrap_request.schema_version = film_air_certificate.schema_version;
    certificate_bootstrap_request.mesh_generation_identity = "mesh-generation:fixture";
    certificate_bootstrap_request.mesh_magnetic = to_typed_certificate_view(
        film_air_certificate.mesh_magnetic);
    certificate_bootstrap_request.payload_magnetic = to_typed_certificate_view(
        film_air_certificate.payload_magnetic);
    certificate_bootstrap_request.mesh_scalar = to_typed_certificate_view(
        film_air_certificate.mesh_scalar);
    certificate_bootstrap_request.payload_scalar = to_typed_certificate_view(
        film_air_certificate.payload_scalar);
    const char *bootstrap_digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    certificate_bootstrap_request.payload_binding_digest = bootstrap_digest;
    fd::MeshSymmetryCertificateV6Binding certificate_bootstrap{};
    check(fd::verify_mesh_symmetry_certificate_v6(
              certificate_bootstrap_request, certificate_bootstrap) ==
              fd::FrequencyDomainStatus::validation_error,
          "certificate bootstrap must reject missing payload class metadata");
    check(certificate_bootstrap.magnetic_canonical_class_ids.size() == 4u &&
              certificate_bootstrap.scalar_canonical_class_ids.size() == 5u,
          "certificate bootstrap must expose canonical class IDs");
    std::vector<std::uint64_t> magnetic_expected_class_ids =
        certificate_bootstrap.magnetic_canonical_class_ids;
    std::vector<std::uint64_t> scalar_expected_class_ids =
        certificate_bootstrap.scalar_canonical_class_ids;
    std::vector<std::string> magnetic_expected_class_digest_strings =
        certificate_bootstrap.magnetic_class_digests;
    std::vector<std::string> scalar_expected_class_digest_strings =
        certificate_bootstrap.scalar_class_digests;
    std::vector<FullmagFemModalCertificateV6ClassDigest> magnetic_expected_class_digests;
    std::vector<FullmagFemModalCertificateV6ClassDigest> scalar_expected_class_digests;
    magnetic_expected_class_digests.reserve(magnetic_expected_class_digest_strings.size());
    scalar_expected_class_digests.reserve(scalar_expected_class_digest_strings.size());
    magnetic_expected_class_digests.push_back({
        0u, 4u, magnetic_expected_class_digest_strings.front().c_str()});
    scalar_expected_class_digests.push_back({
        0u, 4u, scalar_expected_class_digest_strings.front().c_str()});
    scalar_expected_class_digests.push_back({
        4u, 1u, scalar_expected_class_digest_strings.back().c_str()});
    film_air_certificate.payload_magnetic.expected_class_ids =
        magnetic_expected_class_ids.data();
    film_air_certificate.payload_magnetic.expected_class_id_count =
        magnetic_expected_class_ids.size();
    film_air_certificate.payload_magnetic.expected_class_digests =
        magnetic_expected_class_digests.data();
    film_air_certificate.payload_magnetic.expected_class_digest_count =
        magnetic_expected_class_digests.size();
    film_air_certificate.payload_scalar.expected_class_ids = scalar_expected_class_ids.data();
    film_air_certificate.payload_scalar.expected_class_id_count = scalar_expected_class_ids.size();
    film_air_certificate.payload_scalar.expected_class_digests = scalar_expected_class_digests.data();
    film_air_certificate.payload_scalar.expected_class_digest_count =
        scalar_expected_class_digests.size();
    certificate_bootstrap_request.payload_magnetic = to_typed_certificate_view(
        film_air_certificate.payload_magnetic);
    certificate_bootstrap_request.payload_scalar = to_typed_certificate_view(
        film_air_certificate.payload_scalar);
    fd::MeshSymmetryCertificateV6Binding certificate_final{};
    check(fd::verify_mesh_symmetry_certificate_v6(
              certificate_bootstrap_request, certificate_final) ==
              fd::FrequencyDomainStatus::validation_error,
          "certificate preimage bootstrap must reject the placeholder digest");
    check(!certificate_final.canonical_preimage.empty() &&
              certificate_final.canonical_preimage_sha256[0] != '\0',
          "certificate bootstrap must expose the canonical preimage and digest");
    const std::string film_air_canonical_preimage = certificate_final.canonical_preimage;
    const std::string film_air_canonical_preimage_digest =
        certificate_final.canonical_preimage_sha256;
    const std::string film_air_magnetic_class_digest =
        certificate_final.magnetic_class_digest_sha256;
    const std::string film_air_scalar_class_digest =
        certificate_final.scalar_class_digest_sha256;
    certificate_bootstrap_request.payload_binding_digest =
        film_air_canonical_preimage_digest.c_str();
    fd::MeshSymmetryCertificateV6Binding certificate_accepted{};
    check(fd::verify_mesh_symmetry_certificate_v6(
              certificate_bootstrap_request, certificate_accepted) ==
              fd::FrequencyDomainStatus::ok &&
              certificate_accepted.accepted,
          "certificate fixture must produce one accepted canonical v6 binding");
    FullmagFemModalLinearizationDescriptor film_air_descriptor = payload_descriptor;
    film_air_descriptor.node_count = 5u;
    film_air_descriptor.tangent_dof_count = 10u;
    film_air_descriptor.tangent_frame_xyz = film_air_descriptor_frames.data();
    film_air_descriptor.tangent_frame_xyz_count = film_air_descriptor_frames.size();
    film_air_descriptor.equilibrium_m0_xyz = film_air_descriptor_m0.data();
    film_air_descriptor.equilibrium_m0_xyz_count = film_air_descriptor_m0.size();
    film_air_descriptor.effective_field_h_eff0_xyz = film_air_descriptor_h_eff.data();
    film_air_descriptor.effective_field_h_eff0_xyz_count = film_air_descriptor_h_eff.size();
    film_air_descriptor.external_field_h_ext0_xyz = film_air_descriptor_external.data();
    film_air_descriptor.external_field_h_ext0_xyz_count = film_air_descriptor_external.size();
    film_air_descriptor.alpha_per_node = film_air_descriptor_alpha.data();
    film_air_descriptor.alpha_per_node_count = film_air_descriptor_alpha.size();
    film_air_descriptor.exchange_term_digest = film_air_descriptor.linearization_state_digest;
    FullmagFemModalExchangeMaterialView film_air_material = payload_material_view;
    FullmagFemModalSharedDomainPayload film_air_payload = payload;
    film_air_payload.mesh = &film_air_mesh;
    film_air_payload.equilibrium_m0_xyz = film_air_equilibrium.data();
    film_air_payload.equilibrium_m0_xyz_count = film_air_equilibrium.size();
    film_air_payload.linearization_m0_xyz = film_air_linearization_m0.data();
    film_air_payload.linearization_m0_xyz_count = film_air_linearization_m0.size();
    film_air_payload.linearization_h_eff0_xyz = film_air_linearization_h_eff.data();
    film_air_payload.linearization_h_eff0_xyz_count = film_air_linearization_h_eff.size();
    film_air_payload.linearization_h_demag0_xyz = film_air_h_demag.data();
    film_air_payload.linearization_h_demag0_xyz_count = film_air_h_demag.size();
    film_air_payload.linearization_phi0 = film_air_phi0.data();
    film_air_payload.linearization_phi0_count = film_air_phi0.size();
    film_air_payload.magnetic_a_qq_csr = FullmagFemCsrMatrixView{
        10u, 10u, film_air_a_qq_offsets.data(), film_air_a_qq_offsets.size(),
        nullptr, 0u, nullptr, 0u};
    film_air_payload.scalar_reduced_node = film_air_scalar_classes.data();
    film_air_payload.scalar_reduced_node_count = 2u;
    film_air_payload.magnetic_reduced_node = film_air_magnetic_classes.data();
    film_air_payload.magnetic_reduced_node_count = 1u;
    film_air_payload.magnetic_pair_count = 6u;
    film_air_payload.airbox_pair_count = 6u;
    const char *film_air_valid_digest =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    film_air_descriptor.linearization_state_digest = film_air_valid_digest;
    film_air_descriptor.equilibrium_digest = film_air_valid_digest;
    film_air_descriptor.operator_input_digest = film_air_valid_digest;
    film_air_descriptor.exchange_term_digest = film_air_valid_digest;
    film_air_payload.equilibrium_digest = film_air_valid_digest;
    film_air_payload.mesh_certificate_digest = film_air_valid_digest;
    film_air_payload.linearization_state_digest = film_air_valid_digest;
    film_air_payload.equilibrium_content_sha256 = film_air_valid_digest;
    film_air_payload.boundary_gauge_digest = film_air_valid_digest;
    film_air_payload.bias_field_sample_id = "bias-field-sample:fixture";
    film_air_payload.bias_field_sample_signature = film_air_valid_digest;
    film_air_payload.magnetic_part_identity = "magnetic:film";
    film_air_payload.airbox_part_identity = "airbox:shared";
    film_air_payload.mesh_generation_identity = "mesh-generation:fixture";
    film_air_payload.canonical_preimage = film_air_canonical_preimage.c_str();
    film_air_payload.canonical_preimage_len = film_air_canonical_preimage.size();
    film_air_payload.canonical_preimage_sha256 = film_air_canonical_preimage_digest.c_str();
    film_air_payload.magnetic_class_digest_sha256 = film_air_magnetic_class_digest.c_str();
    film_air_payload.scalar_class_digest_sha256 = film_air_scalar_class_digest.c_str();
    film_air_payload.certificate_binding_status =
        FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_ACCEPTED;
    film_air_payload.certificate_binding_reason = "none";
    film_air_payload.certificate_binding_v6 = &film_air_certificate;
    film_air_payload.linearization_descriptor = &film_air_descriptor;
    film_air_payload.exchange_material_view = &film_air_material;
    std::string film_air_map_binding_digest;
    char film_air_map_binding_error[256]{};
    check(fd::compute_modal_shared_domain_map_binding_digest(
              film_air_payload,
              certificate_accepted,
              4u,
              film_air_map_binding_digest,
              film_air_map_binding_error) == fd::FrequencyDomainStatus::ok,
          film_air_map_binding_error);
    film_air_payload.mesh_certificate_map_binding_digest =
        film_air_map_binding_digest.c_str();
    fd::PoissonAirboxSharedDomainAssemblyResult film_air_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            film_air_payload, &film_air_result) == fd::FrequencyDomainStatus::ok,
        film_air_result.error_message);
    check(film_air_result.k0_demag_probe.mu0_t_m_a == fullmag::fem::kMu0,
          "native importer demag probe must use the canonical model permeability");
    check(film_air_result.p.row_count == 2u,
          "magnetic+airbox importer compacts scalar Poisson to declared classes");
    check(film_air_result.a_qq.row_count == 2u && film_air_result.a_qq.values.size() > 0u,
          "magnetic+airbox importer compacts native magnetic exchange to declared classes");
    auto expect_acceptance_rejection = [&](FullmagFemModalSharedDomainPayload candidate,
                                           const char *reason,
                                           const char *message) {
        fd::PoissonAirboxSharedDomainAssemblyResult candidate_result{};
        check(fd::assemble_poisson_airbox_shared_domain_payload(
                  candidate, &candidate_result) == fd::FrequencyDomainStatus::validation_error,
              message);
        check(std::strstr(candidate_result.error_message, reason) != nullptr,
              "acceptance-certificate rejection must use the expected stable reason");
    };
    FullmagFemModalSharedDomainPayload missing_acceptance_digest = film_air_payload;
    missing_acceptance_digest.acceptance_certificate_sha256 = nullptr;
    expect_acceptance_rejection(
        missing_acceptance_digest,
        "equilibrium_acceptance_certificate_missing",
        "shared-domain payload must reject a missing acceptance digest");
    FullmagFemModalSharedDomainPayload invalid_acceptance_digest = film_air_payload;
    invalid_acceptance_digest.acceptance_certificate_sha256 = "sha256:forged";
    expect_acceptance_rejection(
        invalid_acceptance_digest,
        "equilibrium_acceptance_certificate_digest_invalid",
        "shared-domain payload must reject a malformed acceptance digest");
    FullmagFemModalSharedDomainPayload unsatisfied_acceptance = film_air_payload;
    unsatisfied_acceptance.acceptance_metric_value = 2.0e-18;
    expect_acceptance_rejection(
        unsatisfied_acceptance,
        "equilibrium_acceptance_certificate_metric_invalid",
        "shared-domain payload must reject an unsatisfied acceptance threshold");
    FullmagFemModalSharedDomainPayload incoherent_acceptance = film_air_payload;
    incoherent_acceptance.acceptance_unit = "A/m";
    expect_acceptance_rejection(
        incoherent_acceptance,
        "equilibrium_acceptance_certificate_incoherent",
        "shared-domain payload must reject an incoherent acceptance tuple");
    auto expect_linearization_rejection = [&](FullmagFemModalSharedDomainPayload candidate,
                                                const char *reason,
                                                const char *message) {
        fd::PoissonAirboxSharedDomainAssemblyResult candidate_result{};
        check(fd::assemble_poisson_airbox_shared_domain_payload(
                  candidate, &candidate_result) == fd::FrequencyDomainStatus::validation_error,
              message);
        check(std::strstr(candidate_result.error_message, reason) != nullptr,
              "linearization rejection must use the expected stable reason");
    };
    FullmagFemModalSharedDomainPayload short_linearization_m0_payload = film_air_payload;
    short_linearization_m0_payload.linearization_m0_xyz_count -= 3u;
    expect_linearization_rejection(
        short_linearization_m0_payload,
        "shared-domain linearization fields have inconsistent cardinalities",
        "shared-domain payload must reject compact magnetic-only m0");
    FullmagFemModalSharedDomainPayload short_linearization_h_eff_payload = film_air_payload;
    short_linearization_h_eff_payload.linearization_h_eff0_xyz_count -= 3u;
    expect_linearization_rejection(
        short_linearization_h_eff_payload,
        "shared-domain linearization fields have inconsistent cardinalities",
        "shared-domain payload must reject compact magnetic-only h_eff0");
    FullmagFemModalSharedDomainPayload short_linearization_h_demag_payload = film_air_payload;
    short_linearization_h_demag_payload.linearization_h_demag0_xyz_count -= 3u;
    expect_linearization_rejection(
        short_linearization_h_demag_payload,
        "shared-domain linearization fields have inconsistent cardinalities",
        "shared-domain payload must reject compact magnetic-only h_demag0");
    std::vector<double> mismatched_air_linearization_m0 = film_air_linearization_m0;
    mismatched_air_linearization_m0[12u] = 1.0;
    FullmagFemModalSharedDomainPayload mismatched_air_linearization_payload = film_air_payload;
    mismatched_air_linearization_payload.linearization_m0_xyz =
        mismatched_air_linearization_m0.data();
    expect_linearization_rejection(
        mismatched_air_linearization_payload,
        "linearization_descriptor_payload_state_mismatch",
        "descriptor and payload m0 must match on air-only nodes");
    check(film_air_mesh.periodic_node_pairs_len >= 6u &&
              film_air_mesh.periodic_boundary_pair_markers_len == 4u,
          "fixture carries concrete x/y seam and corner node relations");
    check(film_air_facet_roles[0] == FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM &&
              film_air_facet_roles[1] == FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM &&
              std::all_of(
                  film_air_facet_roles.begin() + 2u, film_air_facet_roles.end(),
                  [](std::uint32_t role) { return role == FULLMAG_FEM_FACET_ROLE_EXTERIOR; }),
          "fixture keeps x/y seam faces separate from the external open-z wall");
    check(std::find(film_air_result.dirichlet_dofs.begin(), film_air_result.dirichlet_dofs.end(),
                    0u) == film_air_result.dirichlet_dofs.end(),
          "periodic seam markers are excluded from essential boundary mass");
    auto expect_map_binding_rejection = [&](FullmagFemModalSharedDomainPayload candidate,
                                             const char *reason,
                                             const char *message) {
        fd::PoissonAirboxSharedDomainAssemblyResult candidate_result{};
        check(fd::assemble_poisson_airbox_shared_domain_payload(
                  candidate, &candidate_result) == fd::FrequencyDomainStatus::validation_error,
              message);
        check(std::strstr(candidate_result.error_message, reason) != nullptr,
              "map-binding rejection must use the expected stable reason");
        check(candidate_result.a_qq.row_count == 0u && candidate_result.a_qq.values.empty() &&
                  candidate_result.a_qphi.row_count == 0u && candidate_result.a_qphi.values.empty() &&
                  candidate_result.a_phiq.row_count == 0u && candidate_result.a_phiq.values.empty() &&
                  candidate_result.p.row_count == 0u && candidate_result.p.values.empty() &&
                  candidate_result.b_qq.row_count == 0u && candidate_result.b_qq.values.empty(),
              "rejected map binding must not publish any output matrix");
    };
    std::vector<std::uint32_t> permuted_scalar_classes = film_air_scalar_classes;
    for (std::uint32_t &value : permuted_scalar_classes) {
        value = value == 0u ? 1u : 0u;
    }
    FullmagFemModalSharedDomainPayload permuted_scalar_payload = film_air_payload;
    permuted_scalar_payload.scalar_reduced_node = permuted_scalar_classes.data();
    expect_map_binding_rejection(
        permuted_scalar_payload,
        "scalar_reduced_node_not_canonical",
        "permuted scalar reduction map must fail closed");
    std::vector<std::uint32_t> permuted_magnetic_classes = film_air_magnetic_classes;
    std::swap(permuted_magnetic_classes.front(), permuted_magnetic_classes.back());
    FullmagFemModalSharedDomainPayload permuted_magnetic_payload = film_air_payload;
    permuted_magnetic_payload.magnetic_reduced_node = permuted_magnetic_classes.data();
    expect_map_binding_rejection(
        permuted_magnetic_payload,
        "magnetic_reduced_node_not_canonical",
        "permuted magnetic reduction map must fail closed");
    std::vector<std::uint32_t> mismatched_marker_values = {0u, 1u};
    fullmag_fem_mesh_desc mismatched_marker_mesh = film_air_mesh;
    mismatched_marker_mesh.cell_markers = mismatched_marker_values.data();
    FullmagFemModalSharedDomainPayload mismatched_marker_payload = film_air_payload;
    mismatched_marker_payload.mesh = &mismatched_marker_mesh;
    expect_map_binding_rejection(
        mismatched_marker_payload,
        "magnetic node ordering is not bound to the marker map",
        "marker and reduction-map mismatch must fail closed");
    std::vector<std::uint32_t> interleaved_cell_nodes = film_air_cell_nodes;
    interleaved_cell_nodes[3u] = 4u;
    fullmag_fem_mesh_desc interleaved_mesh = film_air_mesh;
    interleaved_mesh.cell_nodes = interleaved_cell_nodes.data();
    FullmagFemModalSharedDomainPayload interleaved_payload = film_air_payload;
    interleaved_payload.mesh = &interleaved_mesh;
    expect_map_binding_rejection(
        interleaved_payload,
        "FEM mesh cell has non-positive Jacobian at order-two validation points",
        "invalid interleaved magnetic topology must fail before map binding");
    FullmagFemModalSharedDomainPayload altered_magnetic_part_payload = film_air_payload;
    altered_magnetic_part_payload.magnetic_part_identity = "magnetic:other";
    expect_map_binding_rejection(
        altered_magnetic_part_payload,
        "magnetic_part_identity_mismatch",
        "altered magnetic part identity must fail closed");
    FullmagFemModalSharedDomainPayload altered_airbox_part_payload = film_air_payload;
    altered_airbox_part_payload.airbox_part_identity = "airbox:other";
    expect_map_binding_rejection(
        altered_airbox_part_payload,
        "airbox_part_identity_mismatch",
        "altered airbox part identity must fail closed");
    FullmagFemModalSharedDomainPayload rejected_status_payload = film_air_payload;
    rejected_status_payload.certificate_binding_status = 0u;
    expect_map_binding_rejection(
        rejected_status_payload,
        "certificate_binding_status_not_accepted",
        "non-accepted certificate status must fail closed");
    FullmagFemModalSharedDomainPayload altered_reason_payload = film_air_payload;
    altered_reason_payload.certificate_binding_reason = "stale";
    expect_map_binding_rejection(
        altered_reason_payload,
        "certificate_binding_reason_not_none",
        "non-none certificate reason must fail closed");
    FullmagFemModalSharedDomainPayload stale_map_digest_payload = film_air_payload;
    stale_map_digest_payload.mesh_certificate_map_binding_digest =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    expect_map_binding_rejection(
        stale_map_digest_payload,
        "shared_domain_map_binding_digest_mismatch",
        "stale canonical map-binding digest must fail closed");
    FullmagFemModalCertificateV6BindingRequest short_magnetic_view = film_air_certificate;
    short_magnetic_view.mesh_magnetic.node_count = 3u;
    FullmagFemModalSharedDomainPayload short_magnetic_view_payload = film_air_payload;
    short_magnetic_view_payload.certificate_binding_v6 = &short_magnetic_view;
    expect_map_binding_rejection(
        short_magnetic_view_payload,
        "certificate view cardinalities do not match the marker map",
        "mismatched v6 magnetic view count must fail closed");
    FullmagFemModalCertificateV6BindingRequest short_scalar_view = film_air_certificate;
    short_scalar_view.mesh_scalar.node_count = 4u;
    FullmagFemModalSharedDomainPayload short_scalar_view_payload = film_air_payload;
    short_scalar_view_payload.certificate_binding_v6 = &short_scalar_view;
    expect_map_binding_rejection(
        short_scalar_view_payload,
        "certificate view cardinalities do not match the marker map",
        "mismatched v6 scalar view count must fail closed");
    FullmagFemModalSharedDomainPayload missing_certificate_payload = film_air_payload;
    missing_certificate_payload.certificate_binding_v6 = nullptr;
    fd::PoissonAirboxSharedDomainAssemblyResult missing_certificate_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            missing_certificate_payload, &missing_certificate_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "missing periodic certificate must fail closed");
    check(std::strstr(missing_certificate_result.error_message,
                      "missing the v6 periodic seam/corner certificate") != nullptr,
          "missing periodic certificate must use a stable reason");
    FullmagFemModalCertificateV6BindingRequest missing_corner_certificate = film_air_certificate;
    missing_corner_certificate.mesh_magnetic.generator_relation_count = 2u;
    FullmagFemModalSharedDomainPayload missing_corner_payload = film_air_payload;
    missing_corner_payload.certificate_binding_v6 = &missing_corner_certificate;
    fd::PoissonAirboxSharedDomainAssemblyResult missing_corner_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            missing_corner_payload, &missing_corner_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "periodic certificate without a corner relation must fail closed");
    check(std::strstr(missing_corner_result.error_message,
                      "periodic_mesh_certificate_v6_") != nullptr,
          "missing corner relation must use a stable validation reason");
    std::vector<FullmagFemModalCertificateV6Relation> bad_axis_relations(
        magnetic_generator_relations,
        magnetic_generator_relations + 3u);
    bad_axis_relations[1].axis_mask = 1u;
    FullmagFemModalCertificateV6BindingRequest bad_axis_certificate = film_air_certificate;
    bad_axis_certificate.mesh_magnetic.generator_relations = bad_axis_relations.data();
    FullmagFemModalSharedDomainPayload bad_axis_payload = film_air_payload;
    bad_axis_payload.certificate_binding_v6 = &bad_axis_certificate;
    fd::PoissonAirboxSharedDomainAssemblyResult bad_axis_result{};
    check(fd::assemble_poisson_airbox_shared_domain_payload(
              bad_axis_payload, &bad_axis_result) == fd::FrequencyDomainStatus::validation_error,
          "certificate axis mutation must fail closed");
    check(std::strstr(bad_axis_result.error_message, "periodic_mesh_certificate_v6_") != nullptr,
          "certificate axis mutation must use the v6 verifier reason");
    std::string bad_preimage = film_air_canonical_preimage;
    bad_preimage.back() = bad_preimage.back() == '0' ? '1' : '0';
    FullmagFemModalSharedDomainPayload bad_preimage_payload = film_air_payload;
    bad_preimage_payload.canonical_preimage = bad_preimage.c_str();
    bad_preimage_payload.canonical_preimage_len = bad_preimage.size();
    fd::PoissonAirboxSharedDomainAssemblyResult bad_preimage_result{};
    check(fd::assemble_poisson_airbox_shared_domain_payload(
              bad_preimage_payload, &bad_preimage_result) == fd::FrequencyDomainStatus::validation_error,
          "canonical certificate preimage mutation must fail closed");
    check(std::strstr(bad_preimage_result.error_message, "canonical_preimage") != nullptr,
          "canonical preimage mutation must use a stable reason");
    const char *bad_magnetic_class_digest =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    FullmagFemModalSharedDomainPayload bad_class_digest_payload = film_air_payload;
    bad_class_digest_payload.magnetic_class_digest_sha256 = bad_magnetic_class_digest;
    fd::PoissonAirboxSharedDomainAssemblyResult bad_class_digest_result{};
    check(fd::assemble_poisson_airbox_shared_domain_payload(
              bad_class_digest_payload, &bad_class_digest_result) == fd::FrequencyDomainStatus::validation_error,
          "class digest mutation must fail closed");
    check(std::strstr(bad_class_digest_result.error_message, "digest") != nullptr,
          "class digest mutation must use a stable reason");
    std::vector<double> mismatched_descriptor_h_eff = film_air_descriptor_h_eff;
    mismatched_descriptor_h_eff[0] = 0.5;
    FullmagFemModalLinearizationDescriptor mismatched_descriptor = film_air_descriptor;
    mismatched_descriptor.effective_field_h_eff0_xyz = mismatched_descriptor_h_eff.data();
    FullmagFemModalSharedDomainPayload mismatched_payload = film_air_payload;
    mismatched_payload.linearization_descriptor = &mismatched_descriptor;
    fd::PoissonAirboxSharedDomainAssemblyResult mismatched_payload_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            mismatched_payload, &mismatched_payload_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "descriptor and packed payload effective fields must match exactly");
    check(std::strstr(mismatched_payload_result.error_message,
                      "linearization_descriptor_payload_state_mismatch") != nullptr,
          "descriptor/payload state mismatch must use a stable reason");

    std::vector<double> mismatched_air_equilibrium = film_air_equilibrium;
    mismatched_air_equilibrium[12u] = -1.0;
    FullmagFemModalSharedDomainPayload mismatched_air_payload = film_air_payload;
    mismatched_air_payload.equilibrium_m0_xyz = mismatched_air_equilibrium.data();
    fd::PoissonAirboxSharedDomainAssemblyResult mismatched_air_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            mismatched_air_payload, &mismatched_air_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "full equilibrium mismatch on airbox node must fail closed");
    check(std::strstr(mismatched_air_result.error_message,
                      "linearization_descriptor_full_equilibrium_mismatch") != nullptr,
          "airbox equilibrium mismatch must use a stable reason");

    FullmagFemModalSharedDomainPayload missing_material_payload = film_air_payload;
    missing_material_payload.exchange_material_view = nullptr;
    fd::PoissonAirboxSharedDomainAssemblyResult missing_material_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            missing_material_payload, &missing_material_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "v18 exchange descriptor must reject a missing scalar material carrier");
    check(std::strstr(missing_material_result.error_message,
                      "linearization_descriptor_exchange_material_binding_invalid") != nullptr,
          "missing scalar material carrier must use the stable binding reason");

    auto expect_descriptor_rejection = [&](FullmagFemModalLinearizationDescriptor candidate,
                                            const char *reason) {
        FullmagFemModalSharedDomainPayload candidate_payload = film_air_payload;
        candidate_payload.linearization_descriptor = &candidate;
        fd::PoissonAirboxSharedDomainAssemblyResult candidate_result{};
        check(
            fd::assemble_poisson_airbox_shared_domain_payload(
                candidate_payload, &candidate_result) ==
                fd::FrequencyDomainStatus::validation_error,
            "partially populated descriptor must fail closed");
        check(std::strstr(candidate_result.error_message, reason) != nullptr,
              "descriptor rejection must use the shared contract reason");
    };
    FullmagFemModalLinearizationDescriptor bad_schema = film_air_descriptor;
    bad_schema.schema_version = "wrong.schema";
    expect_descriptor_rejection(bad_schema, "linearization_descriptor_contract_invalid");
    FullmagFemModalLinearizationDescriptor bad_units = film_air_descriptor;
    bad_units.coordinate_unit = "mm";
    expect_descriptor_rejection(bad_units, "linearization_descriptor_contract_invalid");
    FullmagFemModalLinearizationDescriptor bad_reserved = film_air_descriptor;
    bad_reserved.reserved_contract_flags = 1u;
    expect_descriptor_rejection(bad_reserved, "linearization_descriptor_contract_invalid");
    FullmagFemModalLinearizationDescriptor bad_reserved0 = film_air_descriptor;
    bad_reserved0.reserved0 = 1u;
    expect_descriptor_rejection(bad_reserved0, "linearization_descriptor_contract_invalid");
    FullmagFemModalLinearizationDescriptor bad_digest = film_air_descriptor;
    bad_digest.operator_input_digest = "sha256:bad";
    expect_descriptor_rejection(bad_digest, "linearization_descriptor_contract_invalid");
    FullmagFemModalLinearizationDescriptor short_descriptor = film_air_descriptor;
    short_descriptor.struct_size = offsetof(FullmagFemModalLinearizationDescriptor, dmi_uniform_ms);
    expect_descriptor_rejection(short_descriptor, "linearization_descriptor_contract_invalid");
    std::vector<double> bad_m0 = film_air_descriptor_m0;
    bad_m0[0] = 0.25;
    FullmagFemModalLinearizationDescriptor bad_m0_descriptor = film_air_descriptor;
    bad_m0_descriptor.equilibrium_m0_xyz = bad_m0.data();
    expect_descriptor_rejection(bad_m0_descriptor,
                                "linearization_descriptor_full_equilibrium_mismatch");
    std::vector<double> bad_e1 = film_air_descriptor_frames;
    bad_e1[0] = 0.0;
    FullmagFemModalLinearizationDescriptor bad_e1_descriptor = film_air_descriptor;
    bad_e1_descriptor.tangent_frame_xyz = bad_e1.data();
    expect_descriptor_rejection(bad_e1_descriptor,
                                "linearization_descriptor_frame_source_invalid");
    std::vector<double> bad_e2 = film_air_descriptor_frames;
    bad_e2[4] = -1.0;
    FullmagFemModalLinearizationDescriptor bad_e2_descriptor = film_air_descriptor;
    bad_e2_descriptor.tangent_frame_xyz = bad_e2.data();
    expect_descriptor_rejection(bad_e2_descriptor,
                                "linearization_descriptor_frame_source_invalid");
    FullmagFemModalLinearizationDescriptor inactive_terms = film_air_descriptor;
    inactive_terms.term_presence_mask = 0u;
    inactive_terms.exchange_term_digest = nullptr;
    inactive_terms.exchange_edges = nullptr;
    inactive_terms.exchange_edge_count = 0u;
    char inactive_terms_error[256]{};
    check(fd::validate_linearization_descriptor_contract(
              inactive_terms, inactive_terms.node_count, inactive_terms_error) ==
              fd::FrequencyDomainStatus::ok,
          "descriptor validator must accept an explicit inactive-term state");

    std::vector<std::uint32_t> invalid_marker_values = film_air_cell_markers;
    invalid_marker_values[1] = 2u;
    FullmagFemModalSharedDomainPayload invalid_marker_payload = film_air_payload;
    fullmag_fem_mesh_desc invalid_marker_mesh = film_air_mesh;
    invalid_marker_mesh.cell_markers = invalid_marker_values.data();
    invalid_marker_payload.mesh = &invalid_marker_mesh;
    fd::PoissonAirboxSharedDomainAssemblyResult invalid_marker_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            invalid_marker_payload, &invalid_marker_result) ==
            fd::FrequencyDomainStatus::validation_error,
        "magnetic+airbox importer rejects unknown region markers");
    check(std::strstr(invalid_marker_result.error_message, "unknown magnetic/airbox cell marker") != nullptr,
          "unknown region marker has a stable validation reason");

    auto expect_region_map_rejection = [&](const std::uint32_t *markers,
                                           std::uint64_t marker_count,
                                           const char *reason) {
        fullmag_fem_mesh_desc candidate_mesh = film_air_mesh;
        candidate_mesh.cell_markers = markers;
        candidate_mesh.cell_markers_len = marker_count;
        FullmagFemModalSharedDomainPayload candidate_payload = film_air_payload;
        candidate_payload.mesh = &candidate_mesh;
        fd::PoissonAirboxSharedDomainAssemblyResult candidate_result{};
        check(
            fd::assemble_poisson_airbox_shared_domain_payload(
                candidate_payload, &candidate_result) ==
                fd::FrequencyDomainStatus::validation_error,
            "untrusted magnetic/airbox region map must fail closed");
        check(std::strstr(candidate_result.error_message, reason) != nullptr,
              "region-map rejection must use a stable reason");
        check(candidate_result.a_qq.row_count == 0u && candidate_result.a_qq.values.empty(),
              "region-map rejection must not publish A_qq");
    };
    const std::vector<std::uint32_t> all_magnetic_markers = {1u, 1u};
    expect_region_map_rejection(
        all_magnetic_markers.data(), all_magnetic_markers.size(),
        "requires both magnetic and airbox cell regions");
    const std::vector<std::uint32_t> all_airbox_markers = {0u, 0u};
    expect_region_map_rejection(
        all_airbox_markers.data(), all_airbox_markers.size(),
        "requires both magnetic and airbox cell regions");
    expect_region_map_rejection(
        nullptr, 0u, "FEM mesh cell_markers length must equal type count");
    const std::vector<std::uint32_t> short_markers = {1u};
    expect_region_map_rejection(
        short_markers.data(), short_markers.size(),
        "FEM mesh cell_markers length must equal type count");

    FullmagFemModalSharedDomainPayload missing_linearization_digest = film_air_payload;
    missing_linearization_digest.linearization_state_digest = nullptr;
    fd::PoissonAirboxSharedDomainAssemblyResult rejected_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            missing_linearization_digest,
            &rejected_result) == fd::FrequencyDomainStatus::validation_error,
        "shared-domain payload rejects a missing LinearizationState.v6 identity");

    // Floquet sparse-lane regression (B1): A_qphi(k) must equal
    // -mu0 * A_phiq(k)^H, matching the k=0 lane's reciprocal sign so the
    // demag Schur complement D(k) = -A_qphi(k) P(k)^-1 A_phiq(k) remains a
    // positive-semidefinite representation of the magnetostatic self-energy.
    // The film_air fixture's mesh already carries the x/y/z periodic node
    // pairs the v6 certificate binds, so it can be driven through the
    // Floquet payload path with an explicit k vector.
    fd::FrequencyDomainFloquetPeriodicPair floquet_reciprocity_pairs[3]{};
    {
        const char *floquet_pair_ids[3] = {
            "x_periodic_pair_0", "y_periodic_pair_0", "z_periodic_pair_0"};
        const std::uint64_t floquet_pair_node_b[3] = {1u, 2u, 3u};
        const double floquet_pair_translations[3][3] = {
            {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0}};
        for (std::size_t index = 0u; index < 3u; ++index) {
            floquet_reciprocity_pairs[index].pair_id = floquet_pair_ids[index];
            floquet_reciprocity_pairs[index].node_a = 0u;
            floquet_reciprocity_pairs[index].node_b = floquet_pair_node_b[index];
            floquet_reciprocity_pairs[index].has_translation = true;
            for (std::size_t axis = 0u; axis < 3u; ++axis) {
                floquet_reciprocity_pairs[index].translation_m[axis] =
                    floquet_pair_translations[index][axis];
            }
        }
    }
    const std::array<double, 3> floquet_reciprocity_k{{0.5, 0.0, 0.0}};
    fd::PoissonAirboxSharedDomainAssemblyResult floquet_reciprocity_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            film_air_payload,
            &floquet_reciprocity_result,
            floquet_reciprocity_pairs,
            3u,
            &floquet_reciprocity_k,
            nullptr,
            false) == fd::FrequencyDomainStatus::ok,
        floquet_reciprocity_result.error_message);
    check(floquet_reciprocity_result.floquet_sparse_operator_ready,
          "Floquet sparse reciprocity fixture must publish the sparse operator");
    check(floquet_reciprocity_result.operator_digest[0] != '\0',
          "Floquet shared-domain assembly must retain its operator digest");
    check(!floquet_reciprocity_result.quadrature_provenance_json.empty(),
          "Floquet shared-domain assembly must retain quadrature provenance");
    check(floquet_reciprocity_result.quadrature_provenance_json.find(
              "\"geometry\":\"tet4\"") != std::string::npos,
          "Floquet quadrature provenance must identify the magnetic tetrahedron");
    check(floquet_reciprocity_result.quadrature_provenance_json.find(
              "\"element_count\":1") != std::string::npos,
          "Floquet quadrature provenance must retain the magnetic-element count");
    check(floquet_reciprocity_result.floquet_a_qq.row_count > 0u &&
              floquet_reciprocity_result.floquet_uniform_transverse_probe_q_y.size() ==
                  floquet_reciprocity_result.floquet_a_qq.row_count &&
              floquet_reciprocity_result.floquet_uniform_transverse_probe_q_z.size() ==
                  floquet_reciprocity_result.floquet_a_qq.row_count,
          "Floquet shared-domain assembly must retain probes matching its constrained tangent layout");
    check(floquet_reciprocity_result.floquet_a_qphi.values.size() > 0u &&
              floquet_reciprocity_result.floquet_a_phiq.values.size() > 0u,
          "Floquet sparse reciprocity fixture must exercise nonzero demag blocks");
    // For the unit tetrahedron and kx=0.5 rad/m, the positive weak source
    // S projects to a negative real (phi class 0, e1 class 0) entry. The
    // descriptor convention A_phiq q + P phi = 0 requires A_phiq=-S.
    check(
        complex_matrix_value(
            floquet_reciprocity_result.floquet_a_phiq, 0u, 0u).real() > 0.0,
        "Floquet A_phiq must use the descriptor sign opposite to the weak source");
    // The production payload and this reciprocity check share the model constant.
    const double floquet_vacuum_permeability = fullmag::fem::kMu0;
    double floquet_reciprocal_sign_error = 0.0;
    double floquet_reciprocal_scale = 0.0;
    for (std::uint64_t q = 0; q < floquet_reciprocity_result.floquet_a_qphi.row_count; ++q) {
        for (std::uint64_t phi = 0;
             phi < floquet_reciprocity_result.floquet_a_qphi.column_count;
             ++phi) {
            const std::complex<double> feedback = complex_matrix_value(
                floquet_reciprocity_result.floquet_a_qphi, q, phi);
            const std::complex<double> source = complex_matrix_value(
                floquet_reciprocity_result.floquet_a_phiq, phi, q);
            const std::complex<double> residual =
                feedback + floquet_vacuum_permeability * std::conj(source);
            floquet_reciprocal_sign_error =
                std::max(floquet_reciprocal_sign_error, std::abs(residual));
            floquet_reciprocal_scale = std::max(
                floquet_reciprocal_scale,
                std::max(
                    std::abs(feedback),
                    floquet_vacuum_permeability * std::abs(source)));
        }
    }
    check(floquet_reciprocal_scale > 0.0,
          "Floquet sparse reciprocity check must exercise nonzero feedback/source entries");
    check(
        floquet_reciprocal_sign_error <= 1.0e-9 * std::max(1.0, floquet_reciprocal_scale),
        "Floquet demag feedback A_qphi(k) must be -mu0 times the conjugate transpose "
        "of A_phiq(k) so the Schur Hessian is positive");

    // A pure-Neumann Floquet block has no k=0 mean-zero gauge unless the
    // assembled scalar operator actually retains that nullspace. Do not
    // reject nonzero k using a geometry-independent |k|*L proxy; the actual
    // scalar factorization and original potential residual own that decision.
    FullmagFemModalSharedDomainPayload floquet_pure_neumann_payload = film_air_payload;
    floquet_pure_neumann_payload.boundary_kind = "pure_neumann";
    // pure_neumann forbids Robin data in both the k=0 and Floquet block
    // assemblers, independent of the small-k gauge check under test here.
    floquet_pure_neumann_payload.robin_beta = 0.0;
    const std::array<double, 3> floquet_tiny_k{{1.0e-6, 0.0, 0.0}};
    fd::PoissonAirboxSharedDomainAssemblyResult floquet_pure_neumann_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(
            floquet_pure_neumann_payload,
            &floquet_pure_neumann_result,
            floquet_reciprocity_pairs,
            3u,
            &floquet_tiny_k,
            nullptr,
            false) == fd::FrequencyDomainStatus::ok,
        "nonzero pure_neumann Floquet assembly must not use a fixed k*L cutoff");
    check(
        floquet_pure_neumann_result.floquet_sparse_operator_ready,
        "pure_neumann small-k assembly must expose the actual scalar operator for factorization");
    check(
        floquet_pure_neumann_result.phi_mean_weights.empty(),
        "nonzero-k Floquet assembly must not carry the k=0 mean-zero gauge");
    check(
        std::strcmp(floquet_pure_neumann_result.gauge_policy, "require_invertible") == 0,
        "pure_neumann Floquet metadata must report the actual no-gauge factorization policy");
#endif
    return 0;
}
