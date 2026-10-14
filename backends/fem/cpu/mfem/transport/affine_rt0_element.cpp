#include "cpu/mfem/transport/affine_rt0_element.hpp"

#include <mfem.hpp>
#include <boost/multiprecision/cpp_int.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace fullmag::fem::transport {
namespace {

using Exact = boost::multiprecision::cpp_rational;
using ExactPoint = std::array<Exact, 3>;

void require(bool condition, const char *message)
{
    if (!condition) throw std::invalid_argument(message);
}

ExactPoint exact_point(const AffineRt0Element::Point &point)
{
    ExactPoint result;
    for (int component = 0; component < 3; ++component) {
        require(std::isfinite(point[component]), "affine RT0 coordinate must be finite");
        result[component] = Exact(point[component]);
    }
    return result;
}

ExactPoint subtract(const ExactPoint &a, const ExactPoint &b)
{
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

ExactPoint cross(const ExactPoint &a, const ExactPoint &b)
{
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]};
}

Exact dot(const ExactPoint &a, const ExactPoint &b)
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Exact determinant(const std::array<ExactPoint, 4> &vertices)
{
    Exact result = dot(subtract(vertices[1], vertices[0]),
        cross(subtract(vertices[2], vertices[0]), subtract(vertices[3], vertices[0])));
    require(result != 0, "affine RT0 tetrahedron is degenerate");
    if (result < 0) result = -result;
    return result;
}

std::array<Exact, 4> geometric_face_weights(
    const std::array<AffineRt0Element::Point, 4> &vertices,
    const AffineRt0Element::Face &face_points)
{
    std::array<ExactPoint, 4> exact_vertices;
    std::array<ExactPoint, 3> exact_face;
    std::array<bool, 4> used{};
    for (int local = 0; local < 4; ++local) exact_vertices[local] = exact_point(vertices[local]);
    for (int vertex = 0; vertex < 3; ++vertex) {
        exact_face[vertex] = exact_point(face_points[vertex]);
        const auto found = std::find(vertices.begin(), vertices.end(), face_points[vertex]);
        require(found != vertices.end(), "affine RT0 moment face is not an element face");
        const auto local = static_cast<std::size_t>(found - vertices.begin());
        require(!used[local], "affine RT0 moment face repeats a vertex");
        used[local] = true;
    }
    auto area = cross(subtract(exact_face[1], exact_face[0]),
        subtract(exact_face[2], exact_face[0]));
    for (auto &component : area) component /= 2;
    const Exact denominator = 3 * determinant(exact_vertices);
    std::array<Exact, 4> weights;
    for (int local = 0; local < 4; ++local) {
        Exact integral = 0;
        for (int vertex = 0; vertex < 3; ++vertex) {
            integral += dot(subtract(exact_face[vertex], exact_vertices[local]), area);
        }
        weights[local] = integral / denominator;
    }
    return weights;
}

int decode(int dof) { return dof < 0 ? -1 - dof : dof; }
int sign(int dof) { return dof < 0 ? -1 : 1; }

const mfem::FiniteElementSpace &checked_space(const mfem::GridFunction &field)
{
    require(field.FESpace() != nullptr, "affine RT0 field has no finite element space");
    return *field.FESpace();
}

} // namespace

AffineRt0Element::AffineRt0Element(const mfem::FiniteElementSpace &space, int element)
{
    const auto *mesh = space.GetMesh();
    require(mesh != nullptr && mesh->Dimension() == 3 && mesh->SpaceDimension() == 3 &&
            mesh->GetNodes() == nullptr && !mesh->Nonconforming() &&
            element >= 0 && element < mesh->GetNE() && space.GetVDim() == 1,
        "affine RT0 requires a scalar-DOF straight conforming three-dimensional mesh");
#if defined(MFEM_USE_MPI) && !defined(FULLMAG_OET0_DISABLE_MPI)
    require(dynamic_cast<const mfem::ParMesh *>(mesh) == nullptr,
        "affine RT0 reconstruction requires a serial mesh");
#endif
    const auto *finite_element = space.GetFE(element);
    require(dynamic_cast<const mfem::RT_TetrahedronElement *>(finite_element) != nullptr &&
            finite_element->GetOrder() == 1 && finite_element->GetDof() == 4 &&
            finite_element->GetRangeType() == mfem::FiniteElement::VECTOR &&
            finite_element->GetMapType() == mfem::FiniteElement::H_DIV &&
            mesh->GetElementBaseGeometry(element) == mfem::Geometry::TETRAHEDRON,
        "affine RT0 requires the generic tetrahedral RT0 basis");
    mfem::Array<int> vertex_ids, dofs, faces, orientations;
    mesh->GetElementVertices(element, vertex_ids);
    const auto *dof_transform = space.GetElementDofs(element, dofs);
    mesh->GetElementFaces(element, faces, orientations);
    require(vertex_ids.Size() == 4 && dofs.Size() == 4 && faces.Size() == 4 &&
            dof_transform == nullptr,
        "affine RT0 local maps or DOF transformation are unsupported");
    std::array<ExactPoint, 4> exact_vertices;
    mfem::Array<int> face_vertices, face_dofs;
    for (int opposite = 0; opposite < 4; ++opposite) {
        const auto *coordinate = mesh->GetVertex(vertex_ids[opposite]);
        vertices_[opposite] = {coordinate[0], coordinate[1], coordinate[2]};
        exact_vertices[opposite] = exact_point(vertices_[opposite]);
        require(decode(dofs[opposite]) >= 0 && decode(dofs[opposite]) < space.GetVSize(),
            "affine RT0 degree of freedom is out of range");
        signed_dofs_[opposite] = dofs[opposite];
        mesh->GetFaceVertices(faces[opposite], face_vertices);
        space.GetFaceDofs(faces[opposite], face_dofs);
        require(face_vertices.Size() == 3 && face_dofs.Size() == 1 &&
                decode(face_dofs[0]) == decode(dofs[opposite]),
            "affine RT0 face and local basis DOF maps disagree");
        for (int local = 0; local < 4; ++local) {
            const bool present = std::find(face_vertices.begin(), face_vertices.end(),
                vertex_ids[local]) != face_vertices.end();
            require(present == (local != opposite),
                "affine RT0 basis row does not map to its opposite vertex");
        }
    }
    determinant_m3_ = determinant(exact_vertices).convert_to<long double>();
    require(std::isfinite(determinant_m3_) && determinant_m3_ > 0.0L,
        "affine RT0 determinant is not representable");

    // Check the selected generic reference element independently of face DOFs.
    const std::array<Point, 4> reference_vertices{{{0., 0., 0.}, {1., 0., 0.},
        {0., 1., 0.}, {0., 0., 1.}}};
    mfem::DenseMatrix reference_shape(4, 3);
    for (int vertex = 0; vertex < 4; ++vertex) {
        mfem::IntegrationPoint point;
        point.Set3(reference_vertices[vertex][0], reference_vertices[vertex][1],
            reference_vertices[vertex][2]);
        finite_element->CalcVShape(point, reference_shape);
        for (int local = 0; local < 4; ++local) {
            for (int component = 0; component < 3; ++component) {
                const double expected = reference_vertices[vertex][component] -
                    reference_vertices[local][component];
                const double actual = reference_shape(local, component);
                require(std::isfinite(actual) && std::abs(actual - expected) <=
                        64.0 * std::numeric_limits<double>::epsilon(),
                    "affine RT0 generic reference basis contract differs");
            }
        }
    }
}

AffineRt0Element::AffineRt0Element(const mfem::GridFunction &field, int element)
    : AffineRt0Element(checked_space(field), element)
{
    require(field.Size() == field.FESpace()->GetVSize(),
        "affine RT0 field size differs from its space");
    for (int local = 0; local < 4; ++local) {
        const double coefficient = field[decode(signed_dofs_[local])];
        require(std::isfinite(coefficient), "affine RT0 coefficient must be finite");
        signed_coefficients_[local] = sign(signed_dofs_[local]) * coefficient;
    }
    coefficients_frozen_ = true;
}

AffineRt0Element::Point AffineRt0Element::basis_value_at(const Point &physical_point, int local) const
{
    require(local >= 0 && local < 4, "affine RT0 basis index is invalid");
    Point result;
    for (int component = 0; component < 3; ++component) {
        require(std::isfinite(physical_point[component]), "affine RT0 evaluation point must be finite");
        const long double value = (static_cast<long double>(physical_point[component]) -
            vertices_[local][component]) / determinant_m3_;
        result[component] = static_cast<double>(value);
        require(std::isfinite(result[component]) && (value == 0.0L || result[component] != 0.0),
            "affine RT0 basis value is not representable");
    }
    return result;
}

AffineRt0Element::Point AffineRt0Element::current_at(const Point &physical_point) const
{
    require(coefficients_frozen_, "affine RT0 current requires frozen field coefficients");
    Point result;
    for (int component = 0; component < 3; ++component) {
        require(std::isfinite(physical_point[component]), "affine RT0 evaluation point must be finite");
        long double sum = 0.0L;
        for (int local = 0; local < 4; ++local) {
            sum += static_cast<long double>(signed_coefficients_[local]) *
                (static_cast<long double>(physical_point[component]) - vertices_[local][component]);
        }
        const long double value = sum / determinant_m3_;
        result[component] = static_cast<double>(value);
        require(std::isfinite(result[component]) && (value == 0.0L || result[component] != 0.0),
            "affine RT0 current is not representable");
    }
    return result;
}

double AffineRt0Element::face_moment(const Face &face_points) const
{
    require(coefficients_frozen_, "affine RT0 moment requires frozen field coefficients");
    const auto weights = geometric_face_weights(vertices_, face_points);
    Exact exact_sum = 0;
    for (int local = 0; local < 4; ++local) {
        exact_sum += Exact(signed_coefficients_[local]) * weights[local];
    }
    const double result = exact_sum.convert_to<double>();
    require(std::isfinite(result) && (exact_sum == 0 || result != 0.0),
        "affine RT0 normal moment is not representable");
    return result == 0.0 ? 0.0 : result;
}

double AffineRt0Element::signed_face_weight(const Face &face_points, int local) const
{
    require(local >= 0 && local < 4, "affine RT0 basis index is invalid");
    const Exact weight = sign(signed_dofs_[local]) * geometric_face_weights(vertices_, face_points)[local];
    const double result = weight.convert_to<double>();
    require(std::isfinite(result) && result != 0.0, "affine RT0 canonical face weight is invalid");
    return result;
}

} // namespace fullmag::fem::transport
