#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::oersted {
namespace {

using Point = std::array<double, 3>;
constexpr double kPi = 3.141592653589793238462643383279502884;

Point subtract(const Point &left, const Point &right)
{
    return {left[0] - right[0], left[1] - right[1], left[2] - right[2]};
}

Point add(const Point &left, const Point &right)
{
    return {left[0] + right[0], left[1] + right[1], left[2] + right[2]};
}

Point scale(const Point &value, double factor)
{
    return {factor * value[0], factor * value[1], factor * value[2]};
}

double dot(const Point &left, const Point &right)
{
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

Point cross(const Point &left, const Point &right)
{
    return {left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0]};
}

double norm(const Point &value)
{
    return std::sqrt(dot(value, value));
}

double determinant(const Point &a, const Point &b, const Point &c)
{
    return dot(a, cross(b, c));
}

Point physical_barycentric(
    const std::array<Point, 4> &vertices,
    double b1,
    double b2,
    double b3)
{
    return add(vertices[0], add(scale(subtract(vertices[1], vertices[0]), b1),
        add(scale(subtract(vertices[2], vertices[0]), b2),
            scale(subtract(vertices[3], vertices[0]), b3))));
}

Point evaluate_current(
    const mfem::GridFunction &field,
    int parent_element,
    const Point &physical_point)
{
    auto *transformation = field.FESpace()->GetMesh()->
        GetElementTransformation(parent_element);
    mfem::InverseElementTransformation inverse(transformation);
    mfem::Vector physical(3);
    for (int component = 0; component < 3; ++component) {
        physical[component] = physical_point[component];
    }
    mfem::IntegrationPoint reference;
    const auto status = inverse.Transform(physical, reference);
    if (status != mfem::InverseElementTransformation::Inside) {
        throw std::runtime_error(
            "direct tetrahedral Oersted evaluation left its source element");
    }
    mfem::Vector value(3);
    field.GetVectorValue(parent_element, reference, value);
    Point result{value[0], value[1], value[2]};
    if (!std::all_of(result.begin(), result.end(),
            [](double component) { return std::isfinite(component); })) {
        throw std::runtime_error(
            "direct tetrahedral Oersted source current is non-finite");
    }
    return result;
}

Point integrate_once(
    const mfem::GridFunction &field,
    int parent_element,
    const std::array<Point, 4> &vertices,
    const Point &target,
    int order)
{
    const auto &rules = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, order);
    const double jacobian = std::abs(determinant(
        subtract(vertices[1], vertices[0]),
        subtract(vertices[2], vertices[0]),
        subtract(vertices[3], vertices[0])));
    if (!(std::isfinite(jacobian) && jacobian > 0.0)) {
        throw std::runtime_error(
            "direct tetrahedral Oersted source tetrahedron is degenerate");
    }
    Point integral{0.0, 0.0, 0.0};
    for (int point = 0; point < rules.GetNPoints(); ++point) {
        const auto &ip = rules.IntPoint(point);
        const Point physical = physical_barycentric(vertices,
            ip.x, ip.y, ip.z);
        const Point displacement = subtract(target, physical);
        const double distance = norm(displacement);
        if (!(std::isfinite(distance) && distance >
                64.0 * std::numeric_limits<double>::epsilon())) {
            // The source-target singularity is integrable, but the ordinary
            // embedded rule must not invent a cutoff.  Refinement will move
            // the point to a child rule; if it cannot converge, the caller
            // receives an explicit bounded failure.
            throw std::runtime_error(
                "direct tetrahedral Oersted quadrature sampled its singularity");
        }
        const Point current = evaluate_current(field, parent_element, physical);
        const Point kernel = scale(cross(current, displacement),
            1.0 / (4.0 * kPi * distance * distance * distance));
        const double weight = jacobian * rules.IntPoint(point).weight;
        integral = add(integral, scale(kernel, weight));
    }
    return integral;
}

std::array<std::array<int, 4>, 8> child_indices()
{
    return {{{0, 4, 5, 6}, {1, 4, 7, 8}, {2, 5, 7, 9},
        {3, 6, 8, 9}, {4, 5, 6, 7}, {4, 6, 8, 7},
        {6, 9, 8, 7}, {5, 6, 9, 7}}};
}

std::array<Point, 10> midpoint_vertices(const std::array<Point, 4> &v)
{
    return {v[0], v[1], v[2], v[3],
        scale(add(v[0], v[1]), 0.5), scale(add(v[0], v[2]), 0.5),
        scale(add(v[0], v[3]), 0.5), scale(add(v[1], v[2]), 0.5),
        scale(add(v[1], v[3]), 0.5), scale(add(v[2], v[3]), 0.5)};
}

struct PairAccumulator {
    Point value{0.0, 0.0, 0.0};
    Point compensation{0.0, 0.0, 0.0};

    void add(const Point &term)
    {
        for (int component = 0; component < 3; ++component) {
            const double corrected = term[component] - compensation[component];
            const double next = value[component] + corrected;
            compensation[component] = (next - value[component]) - corrected;
            value[component] = next;
        }
    }
};

Point integrate_adaptive(
    const mfem::GridFunction &field,
    int parent_element,
    const std::array<Point, 4> &vertices,
    const Point &target,
    const DirectTetraQuadratureOptions &options,
    int depth,
    DirectTetraQuadratureDiagnostics *diagnostics)
{
    const int low_order = std::max(2, options.base_quadrature_order);
    const int high_order = low_order + 2;
    Point low{};
    Point high{};
    try {
        low = integrate_once(field, parent_element, vertices, target, low_order);
        high = integrate_once(field, parent_element, vertices, target, high_order);
    } catch (const std::runtime_error &) {
        if (depth >= options.maximum_subdivision_depth) {
            ++diagnostics->unconverged_pair_count;
            throw;
        }
        diagnostics->refined_pairs++;
        const auto midpoints = midpoint_vertices(vertices);
        PairAccumulator refined;
        for (const auto indices : child_indices()) {
            std::array<Point, 4> child{
                midpoints[indices[0]], midpoints[indices[1]],
                midpoints[indices[2]], midpoints[indices[3]]};
            refined.add(integrate_adaptive(field, parent_element, child,
                target, options, depth + 1, diagnostics));
        }
        return refined.value;
    }
    const Point difference = subtract(high, low);
    const double error = norm(difference);
    const double scale_value = std::max(norm(high), 1.0);
    diagnostics->maximum_pair_error_apm = std::max(
        diagnostics->maximum_pair_error_apm, error);
    if (std::isfinite(error) && error <= options.absolute_tolerance_apm +
            options.relative_tolerance * scale_value) {
        return high;
    }
    if (depth >= options.maximum_subdivision_depth) {
        ++diagnostics->unconverged_pair_count;
        throw std::runtime_error(
            "direct tetrahedral Oersted quadrature did not converge");
    }
    diagnostics->refined_pairs++;
    const auto midpoints = midpoint_vertices(vertices);
    PairAccumulator refined;
    for (const auto indices : child_indices()) {
        std::array<Point, 4> child{
            midpoints[indices[0]], midpoints[indices[1]],
            midpoints[indices[2]], midpoints[indices[3]]};
        refined.add(integrate_adaptive(field, parent_element, child,
            target, options, depth + 1, diagnostics));
    }
    return refined.value;
}

std::array<Point, 4> element_vertices(const mfem::Mesh &mesh, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    if (vertices.Size() != 4) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted requires tetrahedral sources");
    }
    std::array<Point, 4> result{};
    for (int local = 0; local < 4; ++local) {
        const auto *coordinate = mesh.GetVertex(vertices[local]);
        result[local] = {coordinate[0], coordinate[1], coordinate[2]};
    }
    return result;
}

} // namespace

DirectTetraQuadratureResult DirectTetraQuadrature::Evaluate(
    const fullmag::fem::transport::ConservativeCurrentView &source,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options)
{
    auto result = EvaluateField(*source.space().GetMesh(), source.field(),
        target_points, options);
    result.source_view_identity_digest = source.identity().view_identity_digest;
    return result;
}

DirectTetraQuadratureResult DirectTetraQuadrature::EvaluateField(
    const mfem::Mesh &mesh,
    const mfem::GridFunction &rt0_field,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options)
{
    if (options.base_quadrature_order < 2 ||
            options.maximum_subdivision_depth < 0 ||
            !(std::isfinite(options.absolute_tolerance_apm) &&
                options.absolute_tolerance_apm >= 0.0) ||
            !(std::isfinite(options.relative_tolerance) &&
                options.relative_tolerance >= 0.0) ||
            options.maximum_source_target_pairs == 0) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted options are invalid");
    }
    if (rt0_field.FESpace() == nullptr ||
            rt0_field.FESpace()->GetMesh() == nullptr ||
            rt0_field.FESpace()->FEColl() == nullptr ||
            rt0_field.FESpace()->FEColl()->Name() != std::string("RT_3D_P0")) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted requires an RT0 source field");
    }
    const auto source_count = static_cast<std::uint64_t>(mesh.GetNE());
    const auto target_count = static_cast<std::uint64_t>(target_points.size());
    if (target_count != 0 && source_count >
            options.maximum_source_target_pairs / target_count) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted source-target pair budget exceeded");
    }
    DirectTetraQuadratureResult result;
    result.operator_version = operator_version;
    result.h_xyz_apm.assign(target_points.size() * 3u, 0.0);
    result.diagnostics.source_target_pairs = source_count * target_count;
    for (std::size_t target_index = 0; target_index < target_points.size();
            ++target_index) {
        PairAccumulator total;
        for (int element = 0; element < mesh.GetNE(); ++element) {
            total.add(integrate_adaptive(rt0_field, element,
                element_vertices(mesh, element), target_points[target_index],
                options, 0, &result.diagnostics));
        }
        for (int component = 0; component < 3; ++component) {
            const double value = total.value[component];
            if (!std::isfinite(value)) {
                throw std::runtime_error(
                    "direct tetrahedral Oersted field is non-finite");
            }
            result.h_xyz_apm[3u * target_index +
                static_cast<std::size_t>(component)] = value;
        }
    }
    return result;
}

} // namespace fullmag::fem::oersted
