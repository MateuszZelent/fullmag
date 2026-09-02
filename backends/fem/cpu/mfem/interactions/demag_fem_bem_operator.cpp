/*
 * FEM/BEM demag dense-operator source contract (dense reference and
 * diagnostic ACA H-matrix operator).
 *
 * This source owns dense boundary-integral operator assembly, solid-angle
 * weights, and dense reference apply for extracted boundary surfaces.
 * It does not extract boundary surfaces, solve sparse systems, transfer boundary values, compute energy, or manage workspace.
 */

#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"

#include "context.hpp"
#include "fem_common.hpp"
#include "fem_geometry.hpp"
#include "frequency_domain/canonical_digest.hpp"
#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem {
namespace {

constexpr double kRelativeGeometryTolerance =
    128.0 * std::numeric_limits<double>::epsilon();

using Vec3 = fullmag::fem::Vec3;
inline Vec3 sub(const Vec3 &a, const Vec3 &b) { return vec3_sub(a, b); }
inline Vec3 scale(const Vec3 &a, double s) { return vec3_scale(a, s); }
inline double dot(const Vec3 &a, const Vec3 &b) { return vec3_dot(a, b); }
inline Vec3 cross(const Vec3 &a, const Vec3 &b) { return vec3_cross(a, b); }

double stable_norm(const Vec3 &value) {
    return std::hypot(
        std::hypot(std::abs(value[0]), std::abs(value[1])),
        std::abs(value[2]));
}

bool finite_vec3(const Vec3 &value) {
    return std::isfinite(value[0]) &&
           std::isfinite(value[1]) &&
           std::isfinite(value[2]);
}

Vec3 node_position(const Context &ctx, uint32_t node) {
    return mesh_node_position(ctx.mesh.nodes_xyz, node);
}

double solid_angle_magnitude(
    const Vec3 &x,
    const Vec3 &p0,
    const Vec3 &p1,
    const Vec3 &p2,
    bool &valid)
{
    valid = false;
    if (!finite_vec3(x) || !finite_vec3(p0) ||
        !finite_vec3(p1) || !finite_vec3(p2)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const Vec3 r0 = sub(p0, x);
    const Vec3 r1 = sub(p1, x);
    const Vec3 r2 = sub(p2, x);
    const double n0 = stable_norm(r0);
    const double n1 = stable_norm(r1);
    const double n2 = stable_norm(r2);
    if (!std::isfinite(n0) || !std::isfinite(n1) ||
        !std::isfinite(n2) || !(n0 > 0.0) ||
        !(n1 > 0.0) || !(n2 > 0.0)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const double det = dot(r0, cross(r1, r2));
    const double denom =
        n0 * n1 * n2 +
        dot(r0, r1) * n2 +
        dot(r1, r2) * n0 +
        dot(r2, r0) * n1;
    if (!std::isfinite(det) || !std::isfinite(denom)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const double angle = std::abs(2.0 * std::atan2(det, denom));
    if (!std::isfinite(angle)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    valid = true;
    return angle;
}

bool point_matches_vertex(
    const Vec3 &x,
    const Vec3 &p,
    double characteristic_length)
{
    const Vec3 distance = sub(x, p);
    const double tolerance = kRelativeGeometryTolerance * characteristic_length;
    const double distance_norm = stable_norm(distance);
    return std::isfinite(distance_norm) &&
           std::isfinite(tolerance) &&
           distance_norm <= tolerance;
}

std::array<double, 3> invalid_weights() {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    return {nan, nan, nan};
}

std::array<double, 3> lindholm_linear_triangle_weights(
    const Vec3 &x,
    const std::array<Vec3, 3> &p,
    double area,
    const Vec3 &unit_normal,
    double characteristic_length,
    bool &valid)
{
    valid = false;
    if (!finite_vec3(x) || !finite_vec3(p[0]) ||
        !finite_vec3(p[1]) || !finite_vec3(p[2]) ||
        !finite_vec3(unit_normal) ||
        !std::isfinite(area) || !(area > 0.0) ||
        !std::isfinite(characteristic_length) ||
        !(characteristic_length > 0.0) ||
        point_matches_vertex(x, p[0], characteristic_length) ||
        point_matches_vertex(x, p[1], characteristic_length) ||
        point_matches_vertex(x, p[2], characteristic_length)) {
        return invalid_weights();
    }

    std::array<Vec3, 3> rho_vec{};
    std::array<Vec3, 3> edge_unit{};
    std::array<Vec3, 3> eta{};
    std::array<double, 3> eta0{};
    std::array<double, 3> rho{};
    std::array<double, 3> edge_len{};
    std::array<double, 3> edge_log{};

    const double normal_norm = stable_norm(unit_normal);
    if (!std::isfinite(normal_norm) ||
        !(normal_norm > 0.0)) {
        return invalid_weights();
    }
    for (int i = 0; i < 3; ++i) {
        rho_vec[static_cast<size_t>(i)] =
            sub(p[static_cast<size_t>(i)], x);
        rho[static_cast<size_t>(i)] =
            stable_norm(rho_vec[static_cast<size_t>(i)]);
        if (!std::isfinite(rho[static_cast<size_t>(i)]) ||
            !(rho[static_cast<size_t>(i)] > 0.0)) {
            return invalid_weights();
        }
    }
    for (int i = 0; i < 3; ++i) {
        const int next = (i + 1) % 3;
        const Vec3 edge = sub(
            rho_vec[static_cast<size_t>(next)],
            rho_vec[static_cast<size_t>(i)]);
        edge_len[static_cast<size_t>(i)] = stable_norm(edge);
        if (!std::isfinite(edge_len[static_cast<size_t>(i)]) ||
            !(edge_len[static_cast<size_t>(i)] > 0.0)) {
            return invalid_weights();
        }
        edge_unit[static_cast<size_t>(i)] =
            scale(edge, 1.0 / edge_len[static_cast<size_t>(i)]);
        eta[static_cast<size_t>(i)] =
            cross(unit_normal, edge_unit[static_cast<size_t>(i)]);
        eta0[static_cast<size_t>(i)] =
            dot(eta[static_cast<size_t>(i)], rho_vec[static_cast<size_t>(i)]);
        const double numerator =
            rho[static_cast<size_t>(i)] +
            rho[static_cast<size_t>(next)] +
            edge_len[static_cast<size_t>(i)];
        const double denominator =
            rho[static_cast<size_t>(i)] +
            rho[static_cast<size_t>(next)] -
            edge_len[static_cast<size_t>(i)];
        if (!std::isfinite(eta0[static_cast<size_t>(i)]) ||
            !std::isfinite(numerator) ||
            !std::isfinite(denominator) ||
            !(numerator > 0.0) ||
            !(denominator > 0.0)) {
            return invalid_weights();
        }
        const double ratio = numerator / denominator;
        if (!std::isfinite(ratio) || !(ratio > 0.0)) {
            return invalid_weights();
        }
        edge_log[static_cast<size_t>(i)] = std::log(ratio);
        if (!std::isfinite(edge_log[static_cast<size_t>(i)])) {
            return invalid_weights();
        }
    }

    bool angle_valid = false;
    double omega = solid_angle_magnitude(
        x,
        p[0],
        p[1],
        p[2],
        angle_valid);
    if (!angle_valid || !std::isfinite(omega)) {
        return invalid_weights();
    }
    const double chi0 = dot(unit_normal, rho_vec[0]);
    if (!std::isfinite(chi0)) {
        return invalid_weights();
    }
    if (chi0 < 0.0) {
        omega = -omega;
    }

    double gamma_times_log[3] = {0.0, 0.0, 0.0};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            gamma_times_log[i] +=
                dot(
                    edge_unit[static_cast<size_t>((i + 1) % 3)],
                    edge_unit[static_cast<size_t>(j)]) *
                edge_log[static_cast<size_t>(j)];
        }
        if (!std::isfinite(gamma_times_log[i])) {
            return invalid_weights();
        }
    }

    std::array<double, 3> weights{};
    for (int i = 0; i < 3; ++i) {
        const int next = (i + 1) % 3;
        weights[static_cast<size_t>(i)] =
            edge_len[static_cast<size_t>(next)] / (8.0 * kPi * area) *
            (eta0[static_cast<size_t>(next)] * omega -
             chi0 * gamma_times_log[i]);
        if (!std::isfinite(weights[static_cast<size_t>(i)])) {
            return invalid_weights();
        }
    }
    valid = true;
    return weights;
}

std::vector<std::vector<uint32_t>> build_node_element_adjacency(
    const Context &ctx,
    bool &valid)
{
    valid = false;
    if (ctx.mesh.cell_types.size() !=
            static_cast<size_t>(ctx.mesh.n_elements) ||
        ctx.mesh.cell_offsets.size() !=
            static_cast<size_t>(ctx.mesh.n_elements) + 1u ||
        ctx.mesh.cell_offsets.empty() ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size() ||
        (!ctx.mesh.magnetic_element_mask.empty() &&
         ctx.mesh.magnetic_element_mask.size() !=
             static_cast<size_t>(ctx.mesh.n_elements))) {
        return {};
    }
    std::vector<std::vector<uint32_t>> adjacency(ctx.mesh.n_nodes);
    for (size_t elem = 0;
         elem < static_cast<size_t>(ctx.mesh.n_elements);
         ++elem) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[elem] == 0u) {
            continue;
        }
        if (ctx.mesh.cell_types[elem] != FULLMAG_FEM_CELL_TET4 ||
            ctx.mesh.cell_offsets[elem] >
                ctx.mesh.cell_offsets[elem + 1u] ||
            ctx.mesh.cell_offsets[elem + 1u] -
                    ctx.mesh.cell_offsets[elem] !=
                4u) {
            return {};
        }
        const size_t base = ctx.mesh.cell_offsets[elem];
        for (size_t i = 0; i < 4u; ++i) {
            const uint32_t node = ctx.mesh.cell_nodes[base + i];
            if (node >= ctx.mesh.n_nodes) {
                return {};
            }
            adjacency[static_cast<size_t>(node)].push_back(
                static_cast<uint32_t>(elem));
        }
    }
    valid = true;
    return adjacency;
}

double boundary_node_solid_angle_sum(
    const Context &ctx,
    uint32_t node,
    const std::vector<std::vector<uint32_t>> &node_adjacency,
    double characteristic_length,
    bool &valid,
    std::string &error)
{
    valid = false;
    if (node >= ctx.mesh.n_nodes ||
        node_adjacency.size() != ctx.mesh.n_nodes) {
        error = "FEM/BEM dense BEM received an invalid boundary-node adjacency";
        return std::numeric_limits<double>::quiet_NaN();
    }
    double sum = 0.0;
    const auto &elems = node_adjacency[static_cast<size_t>(node)];
    for (uint32_t elem : elems) {
        if (elem >= ctx.mesh.n_elements ||
            ctx.mesh.cell_offsets.size() <=
                static_cast<size_t>(elem) + 1u) {
            error = "FEM/BEM dense BEM adjacency references an invalid element";
            return std::numeric_limits<double>::quiet_NaN();
        }
        const size_t base = ctx.mesh.cell_offsets[elem];
        int local = -1;
        for (int i = 0; i < 4; ++i) {
            if (ctx.mesh.cell_nodes[base + static_cast<size_t>(i)] == node) {
                local = i;
                break;
            }
        }
        if (local < 0) {
            error = "FEM/BEM dense BEM adjacency lost its element-node relation";
            return std::numeric_limits<double>::quiet_NaN();
        }
        const Vec3 x = node_position(ctx, node);
        Vec3 other[3]{};
        int cursor = 0;
        for (int i = 0; i < 4; ++i) {
            if (i == local) {
                continue;
            }
            other[cursor++] = node_position(
                ctx,
                ctx.mesh.cell_nodes[base + static_cast<size_t>(i)]);
        }
        bool angle_valid = false;
        const double angle = solid_angle_magnitude(
            x,
            other[0],
            other[1],
            other[2],
            angle_valid);
        if (!angle_valid || !std::isfinite(angle)) {
            error = "FEM/BEM dense BEM solid-angle evaluation failed";
            return std::numeric_limits<double>::quiet_NaN();
        }
        sum += angle;
    }
    if (!std::isfinite(sum) ||
        !std::isfinite(characteristic_length) ||
        !(characteristic_length > 0.0)) {
        error = "FEM/BEM dense BEM solid-angle sum is non-finite";
        return std::numeric_limits<double>::quiet_NaN();
    }
    valid = true;
    return sum;
}

} // namespace

bool DenseDemagBemOperator::build(
    const Context &ctx,
    const DemagBoundarySurface &surface,
    std::string &error)
{
    error.clear();
    const size_t boundary_size = surface.boundary_nodes.size();
    if (boundary_size == 0u) {
        error = "FEM/BEM dense BEM operator requires at least one boundary node";
        return false;
    }
    if (boundary_size > static_cast<size_t>(max_boundary_nodes_)) {
        error =
            "FEM/BEM dense reference exceeds dense_reference_max_boundary_nodes: requested=" +
            std::to_string(boundary_size) +
            ", limit=" + std::to_string(max_boundary_nodes_) +
            "; use Poisson airbox for larger surfaces";
        return false;
    }
    if (boundary_size >
        static_cast<size_t>(std::numeric_limits<uint32_t>::max())) {
        error = "FEM/BEM dense BEM boundary-node count exceeds uint32 capacity";
        return false;
    }
    if (surface.triangles.size() != surface.unit_normals.size() ||
        surface.triangles.size() != surface.triangle_areas.size() ||
        surface.global_to_boundary.size() != ctx.mesh.n_nodes ||
        !std::isfinite(surface.characteristic_length) ||
        !(surface.characteristic_length > 0.0)) {
        error = "FEM/BEM dense BEM received inconsistent surface geometry";
        return false;
    }
    for (size_t row = 0; row < boundary_size; ++row) {
        const uint32_t node = surface.boundary_nodes[row];
        if (node >= ctx.mesh.n_nodes ||
            surface.global_to_boundary[static_cast<size_t>(node)] !=
                static_cast<int32_t>(row)) {
            error = "FEM/BEM dense BEM received an invalid boundary-node map";
            return false;
        }
    }
    for (size_t face = 0; face < surface.triangles.size(); ++face) {
        const auto &tri = surface.triangles[face];
        if (tri[0] >= ctx.mesh.n_nodes ||
            tri[1] >= ctx.mesh.n_nodes ||
            tri[2] >= ctx.mesh.n_nodes ||
            !finite_vec3(surface.unit_normals[face]) ||
            !std::isfinite(surface.triangle_areas[face]) ||
            !(surface.triangle_areas[face] > 0.0)) {
            error = "FEM/BEM dense BEM received non-finite face geometry";
            return false;
        }
        for (uint32_t node : tri) {
            const int32_t col =
                surface.global_to_boundary[static_cast<size_t>(node)];
            if (col < 0 ||
                static_cast<size_t>(col) >= boundary_size ||
                surface.boundary_nodes[static_cast<size_t>(col)] != node) {
                error = "FEM/BEM dense BEM received an unmapped boundary node";
                return false;
            }
        }
    }
    if (ctx.mesh.nodes_xyz.size() !=
            static_cast<size_t>(ctx.mesh.n_nodes) * 3u ||
        ctx.mesh.cell_types.size() !=
            static_cast<size_t>(ctx.mesh.n_elements) ||
        ctx.mesh.cell_offsets.size() !=
            static_cast<size_t>(ctx.mesh.n_elements) + 1u ||
        ctx.mesh.cell_offsets.empty() ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size()) {
        error = "FEM/BEM dense BEM received inconsistent typed mesh buffers";
        return false;
    }

    bool adjacency_valid = false;
    const auto adjacency = build_node_element_adjacency(ctx, adjacency_valid);
    if (!adjacency_valid) {
        error = "FEM/BEM dense BEM could not build typed TET4 adjacency";
        return false;
    }
    if (boundary_size >
        std::numeric_limits<size_t>::max() / boundary_size) {
        error = "FEM/BEM dense BEM matrix dimension overflows size_t";
        return false;
    }
    const size_t matrix_entries = boundary_size * boundary_size;
    if (matrix_entries >
        std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FEM/BEM dense BEM matrix byte size overflows size_t";
        return false;
    }

    try {
        size_ = static_cast<uint32_t>(boundary_size);
        matrix_.assign(matrix_entries, 0.0);
    } catch (const std::bad_alloc &) {
        size_ = 0;
        matrix_.clear();
        error =
            "FEM/BEM dense BEM matrix allocation failed for " +
            std::to_string(boundary_size) + " boundary nodes";
        return false;
    } catch (const std::exception &exception) {
        size_ = 0;
        matrix_.clear();
        error =
            "FEM/BEM dense BEM matrix allocation failed: " +
            std::string(exception.what());
        return false;
    }

    for (uint32_t row = 0; row < size_; ++row) {
        const uint32_t global_node =
            surface.boundary_nodes[static_cast<size_t>(row)];
        bool angle_valid = false;
        std::string angle_error;
        const double omega_sum = boundary_node_solid_angle_sum(
            ctx,
            global_node,
            adjacency,
            surface.characteristic_length,
            angle_valid,
            angle_error);
        if (!angle_valid) {
            size_ = 0;
            matrix_.clear();
            error = angle_error.empty()
                        ? "FEM/BEM dense BEM solid-angle evaluation failed"
                        : angle_error;
            return false;
        }
        matrix_[static_cast<size_t>(row) * size_ + row] =
            omega_sum / (4.0 * kPi) - 1.0;
    }

    for (uint32_t row = 0; row < size_; ++row) {
        const Vec3 x = node_position(
            ctx,
            surface.boundary_nodes[static_cast<size_t>(row)]);
        for (size_t face = 0; face < surface.triangles.size(); ++face) {
            const auto &tri = surface.triangles[face];
            if (tri[0] == surface.boundary_nodes[row] ||
                tri[1] == surface.boundary_nodes[row] ||
                tri[2] == surface.boundary_nodes[row]) {
                continue;
            }
            const std::array<Vec3, 3> p = {
                node_position(ctx, tri[0]),
                node_position(ctx, tri[1]),
                node_position(ctx, tri[2])};
            bool weights_valid = false;
            const auto weights = lindholm_linear_triangle_weights(
                x,
                p,
                surface.triangle_areas[face],
                surface.unit_normals[face],
                surface.characteristic_length,
                weights_valid);
            if (!weights_valid) {
                size_ = 0;
                matrix_.clear();
                error =
                    "FEM/BEM dense BEM Lindholm geometry evaluation failed";
                return false;
            }
            for (int local = 0; local < 3; ++local) {
                const uint32_t tri_node = tri[static_cast<size_t>(local)];
                const int32_t col =
                    surface.global_to_boundary[static_cast<size_t>(tri_node)];
                if (col < 0 ||
                    static_cast<size_t>(col) >= boundary_size) {
                    size_ = 0;
                    matrix_.clear();
                    error =
                        "FEM/BEM dense BEM encountered an unmapped boundary node";
                    return false;
                }
                matrix_[static_cast<size_t>(row) * size_ +
                        static_cast<size_t>(col)] +=
                    weights[static_cast<size_t>(local)];
            }
        }
    }
    for (double entry : matrix_) {
        if (!std::isfinite(entry)) {
            size_ = 0;
            matrix_.clear();
            error = "FEM/BEM dense BEM assembly produced a non-finite entry";
            return false;
        }
    }
    return true;
}

bool DenseDemagBemOperator::apply(
    const std::vector<double> &u1_boundary,
    std::vector<double> &u2_boundary,
    std::string &error) const
{
    if (size_ == 0u ||
        matrix_.size() != static_cast<size_t>(size_) * size_) {
        error = "FEM/BEM dense BEM operator is not assembled";
        return false;
    }
    if (u1_boundary.size() != static_cast<size_t>(size_)) {
        error = "FEM/BEM dense BEM operator input size mismatch";
        return false;
    }
    for (double value : u1_boundary) {
        if (!std::isfinite(value)) {
            error = "FEM/BEM dense BEM operator input contains a non-finite value";
            return false;
        }
    }
    u2_boundary.assign(static_cast<size_t>(size_), 0.0);

    for (uint32_t row = 0; row < size_; ++row) {
        double sum = 0.0;
        const size_t row_offset = static_cast<size_t>(row) * size_;
        for (uint32_t col = 0; col < size_; ++col) {
            sum += matrix_[row_offset + col] *
                   u1_boundary[static_cast<size_t>(col)];
        }
        if (!std::isfinite(sum)) {
            error = "FEM/BEM dense BEM operator apply produced a non-finite value";
            u2_boundary.clear();
            return false;
        }
        u2_boundary[static_cast<size_t>(row)] = sum;
    }
    return true;
}

namespace {

struct AcaHMatrixBemBox {
    Vec3 lower = {
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity(),
        std::numeric_limits<double>::infinity()};
    Vec3 upper = {
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity(),
        -std::numeric_limits<double>::infinity()};
};

struct AcaHMatrixBemCluster {
    uint32_t begin = 0;
    uint32_t end = 0;
    AcaHMatrixBemBox box;
    int left = -1;
    int right = -1;
};

struct AcaHMatrixBemNearBlock {
    uint32_t target_cluster = 0;
    uint32_t source_cluster = 0;
    std::vector<double> values;
};

struct AcaHMatrixBemFarBlock {
    uint32_t target_cluster = 0;
    uint32_t source_cluster = 0;
    uint32_t rank = 0;
    // Factors are stored column-major by factor: [rank][local index].
    std::vector<double> u;
    std::vector<double> v;
    double relative_error = 0.0;
};

double box_diameter(const AcaHMatrixBemBox &box) {
    return stable_norm(sub(box.upper, box.lower));
}

double box_distance(const AcaHMatrixBemBox &lhs, const AcaHMatrixBemBox &rhs) {
    double distance_squared = 0.0;
    for (int axis = 0; axis < 3; ++axis) {
        double gap = 0.0;
        if (lhs.upper[static_cast<size_t>(axis)] <
            rhs.lower[static_cast<size_t>(axis)]) {
            gap = rhs.lower[static_cast<size_t>(axis)] -
                  lhs.upper[static_cast<size_t>(axis)];
        } else if (rhs.upper[static_cast<size_t>(axis)] <
                   lhs.lower[static_cast<size_t>(axis)]) {
            gap = lhs.lower[static_cast<size_t>(axis)] -
                  rhs.upper[static_cast<size_t>(axis)];
        }
        distance_squared += gap * gap;
    }
    return std::sqrt(distance_squared);
}

void include_box_point(AcaHMatrixBemBox &box, const Vec3 &point) {
    for (int axis = 0; axis < 3; ++axis) {
        const size_t index = static_cast<size_t>(axis);
        box.lower[index] = std::min(box.lower[index], point[index]);
        box.upper[index] = std::max(box.upper[index], point[index]);
    }
}

class AcaHMatrixBemClusterBuilder {
public:
    AcaHMatrixBemClusterBuilder(
        const std::vector<Vec3> &coordinates,
        uint32_t leaf_size)
        : coordinates_(coordinates), leaf_size_(leaf_size) {}

    int build() {
        permutation_.resize(coordinates_.size());
        for (size_t index = 0; index < permutation_.size(); ++index) {
            permutation_[index] = static_cast<uint32_t>(index);
        }
        return build_range(0u, static_cast<uint32_t>(permutation_.size()));
    }

    std::vector<uint32_t> permutation_;
    std::vector<AcaHMatrixBemCluster> clusters_;

private:
    int build_range(uint32_t begin, uint32_t end) {
        const int cluster_id = static_cast<int>(clusters_.size());
        clusters_.push_back(AcaHMatrixBemCluster{begin, end, {}, -1, -1});
        for (uint32_t offset = begin; offset < end; ++offset) {
            include_box_point(
                clusters_[static_cast<size_t>(cluster_id)].box,
                coordinates_[static_cast<size_t>(permutation_[offset])]);
        }
        if (end - begin <= leaf_size_) {
            return cluster_id;
        }

        int split_axis = 0;
        double largest_extent =
            clusters_[static_cast<size_t>(cluster_id)].box.upper[0] -
            clusters_[static_cast<size_t>(cluster_id)].box.lower[0];
        for (int axis = 1; axis < 3; ++axis) {
            const double extent =
                clusters_[static_cast<size_t>(cluster_id)].box.upper[static_cast<size_t>(axis)] -
                clusters_[static_cast<size_t>(cluster_id)].box.lower[static_cast<size_t>(axis)];
            if (extent > largest_extent) {
                largest_extent = extent;
                split_axis = axis;
            }
        }
        const size_t axis_index = static_cast<size_t>(split_axis);
        std::stable_sort(
            permutation_.begin() + begin,
            permutation_.begin() + end,
            [&](uint32_t lhs, uint32_t rhs) {
                const double lhs_coordinate =
                    coordinates_[static_cast<size_t>(lhs)][axis_index];
                const double rhs_coordinate =
                    coordinates_[static_cast<size_t>(rhs)][axis_index];
                if (lhs_coordinate != rhs_coordinate) {
                    return lhs_coordinate < rhs_coordinate;
                }
                return lhs < rhs;
        });
        const uint32_t middle = begin + (end - begin) / 2u;
        const int left = build_range(begin, middle);
        const int right = build_range(middle, end);
        clusters_[static_cast<size_t>(cluster_id)].left = left;
        clusters_[static_cast<size_t>(cluster_id)].right = right;
        return cluster_id;
    }

    const std::vector<Vec3> &coordinates_;
    uint32_t leaf_size_;
};

bool boundary_triangle_contains(
    const std::array<uint32_t, 3> &triangle,
    uint32_t node)
{
    return triangle[0] == node || triangle[1] == node || triangle[2] == node;
}

bool build_surface_node_face_adjacency(
    const DemagBoundarySurface &surface,
    uint32_t mesh_node_count,
    std::vector<std::vector<uint32_t>> &adjacency,
    std::string &error)
{
    const size_t boundary_size = surface.boundary_nodes.size();
    adjacency.assign(boundary_size, {});
    if (surface.global_to_boundary.size() != mesh_node_count) {
        error = "FEM/BEM ACA H-matrix BEM received an invalid boundary-node map";
        return false;
    }
    for (size_t face = 0; face < surface.triangles.size(); ++face) {
        const auto &triangle = surface.triangles[face];
        for (uint32_t node : triangle) {
            if (node >= mesh_node_count) {
                error = "FEM/BEM ACA H-matrix BEM received an out-of-range surface node";
                return false;
            }
            const int32_t boundary_node =
                surface.global_to_boundary[static_cast<size_t>(node)];
            if (boundary_node < 0 ||
                static_cast<size_t>(boundary_node) >= boundary_size ||
                surface.boundary_nodes[static_cast<size_t>(boundary_node)] != node) {
                error = "FEM/BEM ACA H-matrix BEM received an unmapped surface node";
                return false;
            }
            auto &faces = adjacency[static_cast<size_t>(boundary_node)];
            if (faces.empty() || faces.back() != static_cast<uint32_t>(face)) {
                faces.push_back(static_cast<uint32_t>(face));
            }
        }
    }
    return true;
}

struct AcaHMatrixBemEntryEvaluator {
    const Context &ctx;
    const DemagBoundarySurface &surface;
    const std::vector<std::vector<uint32_t>> &node_adjacency;
    const std::vector<std::vector<uint32_t>> &face_adjacency;
    std::vector<double> diagonal;

    bool build_diagonal(std::string &error) {
        diagonal.assign(surface.boundary_nodes.size(), 0.0);
        for (size_t row = 0; row < diagonal.size(); ++row) {
            bool valid = false;
            diagonal[row] = boundary_node_solid_angle_sum(
                ctx,
                surface.boundary_nodes[row],
                node_adjacency,
                surface.characteristic_length,
                valid,
                error);
            if (!valid || !std::isfinite(diagonal[row])) {
                if (error.empty()) {
                    error = "FEM/BEM ACA H-matrix BEM solid-angle evaluation failed";
                }
                return false;
            }
            diagonal[row] = diagonal[row] / (4.0 * kPi) - 1.0;
        }
        return true;
    }

    bool evaluate(uint32_t row, uint32_t col, double &value, std::string &error) const {
        if (row >= surface.boundary_nodes.size() ||
            col >= surface.boundary_nodes.size()) {
            error = "FEM/BEM ACA H-matrix BEM entry index is out of range";
            return false;
        }
        if (row == col) {
            value = diagonal[static_cast<size_t>(row)];
            return std::isfinite(value);
        }
        const uint32_t row_node = surface.boundary_nodes[static_cast<size_t>(row)];
        const uint32_t col_node = surface.boundary_nodes[static_cast<size_t>(col)];
        const Vec3 x = node_position(ctx, row_node);
        value = 0.0;
        for (uint32_t face : face_adjacency[static_cast<size_t>(col)]) {
            if (face >= surface.triangles.size()) {
                error = "FEM/BEM ACA H-matrix BEM face adjacency is out of range";
                return false;
            }
            const auto &triangle = surface.triangles[static_cast<size_t>(face)];
            if (boundary_triangle_contains(triangle, row_node)) {
                continue;
            }
            std::array<Vec3, 3> points = {
                node_position(ctx, triangle[0]),
                node_position(ctx, triangle[1]),
                node_position(ctx, triangle[2])};
            bool valid = false;
            const auto weights = lindholm_linear_triangle_weights(
                x,
                points,
                surface.triangle_areas[static_cast<size_t>(face)],
                surface.unit_normals[static_cast<size_t>(face)],
                surface.characteristic_length,
                valid);
            if (!valid) {
                error = "FEM/BEM ACA H-matrix BEM Lindholm geometry evaluation failed";
                return false;
            }
            for (int local = 0; local < 3; ++local) {
                if (triangle[static_cast<size_t>(local)] == col_node) {
                    value += weights[static_cast<size_t>(local)];
                    break;
                }
            }
        }
        if (!std::isfinite(value)) {
            error = "FEM/BEM ACA H-matrix BEM entry evaluation produced a non-finite value";
            return false;
        }
        return true;
    }
};

bool checked_product(uint64_t lhs, uint64_t rhs, uint64_t &result) {
    if (rhs != 0u && lhs > std::numeric_limits<uint64_t>::max() / rhs) {
        return false;
    }
    result = lhs * rhs;
    return true;
}

bool checked_sum(uint64_t lhs, uint64_t rhs, uint64_t &result) {
    if (lhs > std::numeric_limits<uint64_t>::max() - rhs) {
        return false;
    }
    result = lhs + rhs;
    return true;
}

struct AcaHMatrixBemCompressionResult {
    bool converged = false;
    uint32_t rank = 0;
    std::vector<double> u;
    std::vector<double> v;
    double relative_error = 0.0;
};

double aca_hmatrix_bem_approximation(
    uint32_t row,
    uint32_t col,
    uint32_t row_count,
    uint32_t col_count,
    uint32_t rank,
    const std::vector<double> &u,
    const std::vector<double> &v)
{
    double result = 0.0;
    for (uint32_t factor = 0; factor < rank; ++factor) {
        result +=
            u[static_cast<size_t>(factor) * row_count + row] *
            v[static_cast<size_t>(factor) * col_count + col];
    }
    return result;
}

class AcaHMatrixBemAssembler {
public:
    AcaHMatrixBemAssembler(
        AcaHMatrixBemEntryEvaluator &evaluator,
        const std::vector<Vec3> &coordinates,
        const AcaHMatrixDemagBemOptions &options)
        : evaluator_(evaluator),
          cluster_builder_(coordinates, options.leaf_size),
          options_(options) {}

    bool build(
        std::vector<uint32_t> &permutation,
        std::vector<AcaHMatrixBemCluster> &clusters,
        std::vector<AcaHMatrixBemNearBlock> &near_blocks,
        std::vector<AcaHMatrixBemFarBlock> &far_blocks,
        uint32_t &max_rank,
        double &relative_error,
        uint64_t &resident_bytes,
        std::string &error)
    {
        error.clear();
        if (!validate_options(error)) {
            return false;
        }
        const size_t boundary_size = evaluator_.surface.boundary_nodes.size();
        if (boundary_size == 0u ||
            boundary_size > static_cast<size_t>(std::numeric_limits<uint32_t>::max())) {
            error = "FEM/BEM ACA H-matrix BEM boundary-node count is invalid";
            return false;
        }
        uint64_t minimum_bytes = 0;
        if (!checked_product(
                static_cast<uint64_t>(boundary_size),
                static_cast<uint64_t>(sizeof(uint32_t)),
                minimum_bytes) ||
            options_.max_memory_bytes != 0u &&
                minimum_bytes > options_.max_memory_bytes) {
            error = "FEM/BEM ACA H-matrix BEM memory budget is too small for the boundary permutation";
            return false;
        }

        cluster_builder_.build();
        if (cluster_builder_.clusters_.empty()) {
            error = "FEM/BEM ACA H-matrix BEM cluster tree is empty";
            return false;
        }
        clusters = cluster_builder_.clusters_;
        if (!reserve_bytes(
                static_cast<uint64_t>(cluster_builder_.permutation_.capacity()) * sizeof(uint32_t) +
                    static_cast<uint64_t>(clusters.capacity()) * sizeof(AcaHMatrixBemCluster),
                error)) {
            return false;
        }
        near_blocks.clear();
        far_blocks.clear();
        max_rank = 0u;
        relative_error = 0.0;
        if (!build_block(
                0u,
                0u,
                clusters,
                near_blocks,
                far_blocks,
                max_rank,
                relative_error,
                error)) {
            return false;
        }
        permutation = std::move(cluster_builder_.permutation_);
        clusters = std::move(cluster_builder_.clusters_);
        resident_bytes = resident_bytes_;
        return true;
    }

private:
    bool validate_options(std::string &error) const {
        if (!std::isfinite(options_.admissibility_eta) ||
            !(options_.admissibility_eta > 0.0)) {
            error = "FEM/BEM ACA H-matrix BEM admissibility_eta must be finite and positive";
            return false;
        }
        if (options_.leaf_size == 0u || options_.max_rank == 0u ||
            options_.max_blocks == 0u ||
            !std::isfinite(options_.relative_tolerance) ||
            !(options_.relative_tolerance >= 0.0)) {
            error = "FEM/BEM ACA H-matrix BEM options are invalid";
            return false;
        }
        if (options_.max_exact_entries == 0u) {
            error = "FEM/BEM ACA H-matrix BEM max_exact_entries must be positive";
            return false;
        }
        return true;
    }

    bool reserve_bytes(uint64_t bytes, std::string &error) {
        uint64_t total = 0;
        if (!checked_sum(resident_bytes_, bytes, total) ||
            options_.max_memory_bytes != 0u &&
                total > options_.max_memory_bytes) {
            error = "FEM/BEM ACA H-matrix BEM memory budget exceeded";
            return false;
        }
        resident_bytes_ = total;
        return true;
    }

    bool register_block(std::string &error) {
        if (block_count_ >= options_.max_blocks) {
            error = "FEM/BEM ACA H-matrix BEM max_blocks budget exceeded";
            return false;
        }
        ++block_count_;
        return true;
    }

    bool register_exact_entries(uint64_t entries, std::string &error) {
        uint64_t total = 0;
        if (!checked_sum(exact_entries_, entries, total) ||
            total > options_.max_exact_entries) {
            error = "FEM/BEM ACA H-matrix BEM max_exact_entries budget exceeded";
            return false;
        }
        exact_entries_ = total;
        return true;
    }

    bool is_admissible(
        const AcaHMatrixBemCluster &target,
        const AcaHMatrixBemCluster &source) const
    {
        const double distance = box_distance(target.box, source.box);
        const double diameter = std::max(
            box_diameter(target.box),
            box_diameter(source.box));
        return std::isfinite(distance) && std::isfinite(diameter) &&
               distance > 0.0 &&
               diameter <= options_.admissibility_eta * distance;
    }

    bool is_leaf(const AcaHMatrixBemCluster &cluster) const {
        return cluster.left < 0 && cluster.right < 0;
    }

    bool try_compress(
        const AcaHMatrixBemCluster &target,
        const AcaHMatrixBemCluster &source,
        AcaHMatrixBemCompressionResult &result,
        std::string &error) const
    {
        const uint32_t row_count = target.end - target.begin;
        const uint32_t col_count = source.end - source.begin;
        result = {};
        if (row_count == 0u || col_count == 0u) {
            error = "FEM/BEM ACA H-matrix BEM encountered an empty admissible block";
            return false;
        }
        std::vector<double> u;
        std::vector<double> v;
        uint32_t rank = 0u;
        uint32_t pivot_row = 0u;
        double scale = 0.0;

        auto evaluate_residual_row = [&](uint32_t local_row, std::vector<double> &row) {
            row.assign(col_count, 0.0);
            for (uint32_t local_col = 0; local_col < col_count; ++local_col) {
                double exact = 0.0;
                if (!evaluator_.evaluate(
                        cluster_builder_.permutation_[target.begin + local_row],
                        cluster_builder_.permutation_[source.begin + local_col],
                        exact,
                        error)) {
                    return false;
                }
                scale = std::max(scale, std::abs(exact));
                row[static_cast<size_t>(local_col)] =
                    exact - aca_hmatrix_bem_approximation(
                                local_row,
                                local_col,
                                row_count,
                                col_count,
                                rank,
                                u,
                                v);
                if (!std::isfinite(row[static_cast<size_t>(local_col)])) {
                    error = "FEM/BEM ACA H-matrix BEM ACA residual is non-finite";
                    return false;
                }
            }
            return true;
        };

        auto evaluate_residual_column = [&](uint32_t local_col, std::vector<double> &column) {
            column.assign(row_count, 0.0);
            for (uint32_t local_row = 0; local_row < row_count; ++local_row) {
                double exact = 0.0;
                if (!evaluator_.evaluate(
                        cluster_builder_.permutation_[target.begin + local_row],
                        cluster_builder_.permutation_[source.begin + local_col],
                        exact,
                        error)) {
                    return false;
                }
                scale = std::max(scale, std::abs(exact));
                column[static_cast<size_t>(local_row)] =
                    exact - aca_hmatrix_bem_approximation(
                                local_row,
                                local_col,
                                row_count,
                                col_count,
                                rank,
                                u,
                                v);
                if (!std::isfinite(column[static_cast<size_t>(local_row)])) {
                    error = "FEM/BEM ACA H-matrix BEM ACA residual is non-finite";
                    return false;
                }
            }
            return true;
        };

        std::vector<double> row_residual;
        std::vector<double> column_residual;
        for (uint32_t iteration = 0; iteration < options_.max_rank; ++iteration) {
            bool row_found = false;
            uint32_t probe_row = pivot_row;
            double probe_max = 0.0;
            for (uint32_t attempt = 0; attempt < row_count; ++attempt) {
                const uint32_t candidate =
                    (pivot_row + attempt) % row_count;
                if (!evaluate_residual_row(candidate, row_residual)) {
                    return false;
                }
                double candidate_max = 0.0;
                for (double value : row_residual) {
                    candidate_max = std::max(candidate_max, std::abs(value));
                }
                if (candidate_max > probe_max) {
                    probe_max = candidate_max;
                    probe_row = candidate;
                    row_found = true;
                }
                if (candidate_max >
                    options_.relative_tolerance * std::max(scale, 1.0e-300)) {
                    row_found = true;
                    probe_row = candidate;
                    probe_max = candidate_max;
                    break;
                }
            }
            if (!row_found ||
                probe_max <= options_.relative_tolerance *
                                 std::max(scale, 1.0e-300)) {
                result.converged = true;
                break;
            }
            pivot_row = probe_row;
            if (!evaluate_residual_row(pivot_row, row_residual)) {
                return false;
            }
            uint32_t pivot_col = 0u;
            double pivot_column_value = 0.0;
            for (uint32_t local_col = 0; local_col < col_count; ++local_col) {
                const double magnitude =
                    std::abs(row_residual[static_cast<size_t>(local_col)]);
                if (magnitude > pivot_column_value) {
                    pivot_column_value = magnitude;
                    pivot_col = local_col;
                }
            }
            if (!(pivot_column_value >
                  options_.relative_tolerance * std::max(scale, 1.0e-300))) {
                result.converged = true;
                break;
            }
            if (!evaluate_residual_column(pivot_col, column_residual)) {
                return false;
            }
            uint32_t selected_row = 0u;
            double pivot = 0.0;
            for (uint32_t local_row = 0; local_row < row_count; ++local_row) {
                const double magnitude =
                    std::abs(column_residual[static_cast<size_t>(local_row)]);
                if (magnitude > std::abs(pivot)) {
                    pivot = column_residual[static_cast<size_t>(local_row)];
                    selected_row = local_row;
                }
            }
            if (!(std::abs(pivot) >
                  options_.relative_tolerance * std::max(scale, 1.0e-300))) {
                result.converged = true;
                break;
            }
            if (!evaluate_residual_row(selected_row, row_residual)) {
                return false;
            }
            double selected_pivot = column_residual[static_cast<size_t>(selected_row)];
            if (!std::isfinite(selected_pivot) ||
                !(std::abs(selected_pivot) > 0.0)) {
                error = "FEM/BEM ACA H-matrix BEM ACA selected a zero pivot";
                return false;
            }
            u.insert(u.end(), column_residual.begin(), column_residual.end());
            for (double &value : row_residual) {
                value /= selected_pivot;
            }
            v.insert(v.end(), row_residual.begin(), row_residual.end());
            ++rank;
            pivot_row = selected_row;
        }

        if (rank > 0u) {
            double max_error = 0.0;
            const uint64_t block_entries =
                static_cast<uint64_t>(row_count) * col_count;
            const uint32_t sample_count = static_cast<uint32_t>(std::min<uint64_t>(
                64u,
                block_entries));
            for (uint32_t sample = 0; sample < sample_count; ++sample) {
                const uint32_t local_row =
                    row_count == 1u
                        ? 0u
                        : static_cast<uint32_t>(
                              (static_cast<uint64_t>(sample) * 37u + 11u) % row_count);
                const uint32_t local_col =
                    col_count == 1u
                        ? 0u
                        : static_cast<uint32_t>(
                              (static_cast<uint64_t>(sample) * 53u + 7u) % col_count);
                double exact = 0.0;
                if (!evaluator_.evaluate(
                        cluster_builder_.permutation_[target.begin + local_row],
                        cluster_builder_.permutation_[source.begin + local_col],
                        exact,
                        error)) {
                    return false;
                }
                scale = std::max(scale, std::abs(exact));
                const double residual = std::abs(
                    exact - aca_hmatrix_bem_approximation(
                                local_row,
                                local_col,
                                row_count,
                                col_count,
                                rank,
                                u,
                                v));
                max_error = std::max(max_error, residual);
            }
            result.relative_error =
                max_error / std::max(scale, 1.0e-300);
            result.converged =
                result.relative_error <= options_.relative_tolerance;
        } else {
            result.relative_error = 0.0;
        }
        result.rank = rank;
        result.u = std::move(u);
        result.v = std::move(v);
        return true;
    }

    bool add_near_block(
        uint32_t target_cluster,
        uint32_t source_cluster,
        const std::vector<AcaHMatrixBemCluster> &clusters,
        std::vector<AcaHMatrixBemNearBlock> &near_blocks,
        std::string &error)
    {
        const auto &target = clusters[static_cast<size_t>(target_cluster)];
        const auto &source = clusters[static_cast<size_t>(source_cluster)];
        const uint64_t row_count = target.end - target.begin;
        const uint64_t col_count = source.end - source.begin;
        uint64_t entries = 0;
        if (!checked_product(row_count, col_count, entries) ||
            !register_exact_entries(entries, error)) {
            return false;
        }
        uint64_t value_bytes = 0;
        uint64_t block_bytes = 0;
        if (!checked_product(entries, sizeof(double), value_bytes) ||
            !checked_sum(value_bytes, sizeof(AcaHMatrixBemNearBlock), block_bytes) ||
            !reserve_bytes(
                block_bytes,
                error) ||
            !register_block(error)) {
            return false;
        }
        AcaHMatrixBemNearBlock block;
        block.target_cluster = target_cluster;
        block.source_cluster = source_cluster;
        block.values.resize(static_cast<size_t>(entries));
        for (uint32_t row = 0; row < row_count; ++row) {
            for (uint32_t col = 0; col < col_count; ++col) {
                double value = 0.0;
                if (!evaluator_.evaluate(
                        cluster_builder_.permutation_[target.begin + row],
                        cluster_builder_.permutation_[source.begin + col],
                        value,
                        error)) {
                    return false;
                }
                block.values[static_cast<size_t>(row) * col_count + col] = value;
            }
        }
        near_blocks.push_back(std::move(block));
        return true;
    }

    bool add_far_block(
        uint32_t target_cluster,
        uint32_t source_cluster,
        AcaHMatrixBemCompressionResult &compression,
        std::vector<AcaHMatrixBemFarBlock> &far_blocks,
        uint32_t &max_rank,
        double &relative_error,
        std::string &error)
    {
        uint64_t factor_values = 0u;
        uint64_t factor_bytes = 0u;
        uint64_t block_bytes = 0u;
        if (!checked_sum(
                static_cast<uint64_t>(compression.u.size()),
                static_cast<uint64_t>(compression.v.size()),
                factor_values) ||
            !checked_product(factor_values, sizeof(double), factor_bytes) ||
            !checked_sum(factor_bytes, sizeof(AcaHMatrixBemFarBlock), block_bytes)) {
            error = "FEM/BEM ACA H-matrix BEM factor storage size overflows uint64";
            return false;
        }
        if (!reserve_bytes(
                block_bytes,
                error) ||
            !register_block(error)) {
            return false;
        }
        AcaHMatrixBemFarBlock block;
        block.target_cluster = target_cluster;
        block.source_cluster = source_cluster;
        block.rank = compression.rank;
        block.u = std::move(compression.u);
        block.v = std::move(compression.v);
        block.relative_error = compression.relative_error;
        max_rank = std::max(max_rank, block.rank);
        relative_error = std::max(relative_error, block.relative_error);
        far_blocks.push_back(std::move(block));
        return true;
    }

    bool build_block(
        uint32_t target_cluster,
        uint32_t source_cluster,
        const std::vector<AcaHMatrixBemCluster> &clusters,
        std::vector<AcaHMatrixBemNearBlock> &near_blocks,
        std::vector<AcaHMatrixBemFarBlock> &far_blocks,
        uint32_t &max_rank,
        double &relative_error,
        std::string &error)
    {
        const auto &target = clusters[static_cast<size_t>(target_cluster)];
        const auto &source = clusters[static_cast<size_t>(source_cluster)];
        if (is_admissible(target, source)) {
            AcaHMatrixBemCompressionResult compression;
            if (!try_compress(target, source, compression, error)) {
                return false;
            }
            if (compression.converged) {
                return add_far_block(
                    target_cluster,
                    source_cluster,
                    compression,
                    far_blocks,
                    max_rank,
                    relative_error,
                    error);
            }
        }
        if (is_leaf(target) && is_leaf(source)) {
            return add_near_block(
                target_cluster,
                source_cluster,
                clusters,
                near_blocks,
                error);
        }

        const bool split_target =
            !is_leaf(target) &&
            (is_leaf(source) ||
             box_diameter(target.box) >= box_diameter(source.box));
        if (split_target) {
            if (!build_block(
                    static_cast<uint32_t>(target.left),
                    source_cluster,
                    clusters,
                    near_blocks,
                    far_blocks,
                    max_rank,
                    relative_error,
                    error) ||
                !build_block(
                    static_cast<uint32_t>(target.right),
                    source_cluster,
                    clusters,
                    near_blocks,
                    far_blocks,
                    max_rank,
                    relative_error,
                    error)) {
                return false;
            }
            return true;
        }
        if (!is_leaf(source)) {
            return build_block(
                       target_cluster,
                       static_cast<uint32_t>(source.left),
                       clusters,
                       near_blocks,
                       far_blocks,
                       max_rank,
                       relative_error,
                       error) &&
                   build_block(
                       target_cluster,
                       static_cast<uint32_t>(source.right),
                       clusters,
                       near_blocks,
                       far_blocks,
                       max_rank,
                       relative_error,
                       error);
        }
        error = "FEM/BEM ACA H-matrix BEM block partition reached an invalid leaf state";
        return false;
    }

    AcaHMatrixBemEntryEvaluator &evaluator_;
    AcaHMatrixBemClusterBuilder cluster_builder_;
    const AcaHMatrixDemagBemOptions &options_;
    uint64_t resident_bytes_ = 0;
    uint64_t exact_entries_ = 0;
    uint32_t block_count_ = 0;
};

} // namespace

struct AcaHMatrixDemagBemOperator::Impl {
    bool ready = false;
    uint32_t size = 0;
    uint32_t max_rank = 0;
    double relative_error = 0.0;
    uint64_t resident_bytes = 0;
    std::vector<uint32_t> permutation;
    std::vector<AcaHMatrixBemCluster> clusters;
    std::vector<AcaHMatrixBemNearBlock> near_blocks;
    std::vector<AcaHMatrixBemFarBlock> far_blocks;
    mutable std::vector<double> projected;
    std::string fingerprint;
};

AcaHMatrixDemagBemOperator::AcaHMatrixDemagBemOperator()
    : impl_(std::make_unique<Impl>()) {}

AcaHMatrixDemagBemOperator::~AcaHMatrixDemagBemOperator() = default;

AcaHMatrixDemagBemOperator::AcaHMatrixDemagBemOperator(
    AcaHMatrixDemagBemOperator &&) noexcept = default;

AcaHMatrixDemagBemOperator &AcaHMatrixDemagBemOperator::operator=(
    AcaHMatrixDemagBemOperator &&) noexcept = default;

bool AcaHMatrixDemagBemOperator::build(
    const Context &ctx,
    const DemagBoundarySurface &surface,
    const AcaHMatrixDemagBemOptions &options,
    std::string &error)
{
    error.clear();
    if (!impl_) {
        impl_ = std::make_unique<Impl>();
    }
    *impl_ = Impl{};
    const size_t boundary_size = surface.boundary_nodes.size();
    if (boundary_size == 0u ||
        boundary_size > static_cast<size_t>(std::numeric_limits<uint32_t>::max())) {
        error = "FEM/BEM ACA H-matrix BEM requires a non-empty uint32 boundary";
        return false;
    }
    uint64_t minimum_bytes = 0u;
    if (!checked_product(
            static_cast<uint64_t>(boundary_size),
            static_cast<uint64_t>(sizeof(uint32_t)),
            minimum_bytes) ||
        options.max_memory_bytes != 0u &&
            options.max_memory_bytes < minimum_bytes) {
        error = "FEM/BEM ACA H-matrix BEM memory budget is too small for the boundary permutation";
        return false;
    }
    if (surface.global_to_boundary.size() != ctx.mesh.n_nodes ||
        surface.triangles.size() != surface.unit_normals.size() ||
        surface.triangles.size() != surface.triangle_areas.size() ||
        !std::isfinite(surface.characteristic_length) ||
        !(surface.characteristic_length > 0.0) ||
        ctx.mesh.nodes_xyz.size() != static_cast<size_t>(ctx.mesh.n_nodes) * 3u ||
        ctx.mesh.cell_types.size() != static_cast<size_t>(ctx.mesh.n_elements) ||
        ctx.mesh.cell_offsets.size() != static_cast<size_t>(ctx.mesh.n_elements) + 1u ||
        ctx.mesh.cell_offsets.empty() ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size()) {
        error = "FEM/BEM ACA H-matrix BEM received inconsistent typed mesh or surface buffers";
        return false;
    }
    std::vector<Vec3> coordinates;
    coordinates.reserve(boundary_size);
    for (size_t row = 0; row < boundary_size; ++row) {
        const uint32_t node = surface.boundary_nodes[row];
        if (node >= ctx.mesh.n_nodes ||
            surface.global_to_boundary[static_cast<size_t>(node)] !=
                static_cast<int32_t>(row)) {
            error = "FEM/BEM ACA H-matrix BEM received an invalid boundary-node map";
            return false;
        }
        const Vec3 point = node_position(ctx, node);
        if (!finite_vec3(point)) {
            error = "FEM/BEM ACA H-matrix BEM received non-finite boundary coordinates";
            return false;
        }
        coordinates.push_back(point);
    }
    for (size_t face = 0; face < surface.triangles.size(); ++face) {
        const auto &triangle = surface.triangles[face];
        if (triangle[0] >= ctx.mesh.n_nodes ||
            triangle[1] >= ctx.mesh.n_nodes ||
            triangle[2] >= ctx.mesh.n_nodes ||
            !finite_vec3(surface.unit_normals[face]) ||
            !std::isfinite(surface.triangle_areas[face]) ||
            !(surface.triangle_areas[face] > 0.0)) {
            error = "FEM/BEM ACA H-matrix BEM received non-finite face geometry";
            return false;
        }
        for (uint32_t node : triangle) {
            const int32_t boundary_node =
                surface.global_to_boundary[static_cast<size_t>(node)];
            if (boundary_node < 0 ||
                static_cast<size_t>(boundary_node) >= boundary_size ||
                surface.boundary_nodes[static_cast<size_t>(boundary_node)] != node) {
                error = "FEM/BEM ACA H-matrix BEM received an unmapped face node";
                return false;
            }
        }
    }
    bool adjacency_valid = false;
    const auto node_adjacency = build_node_element_adjacency(ctx, adjacency_valid);
    if (!adjacency_valid) {
        error = "FEM/BEM ACA H-matrix BEM requires a typed active TET4 mesh";
        return false;
    }
    std::vector<std::vector<uint32_t>> face_adjacency;
    if (!build_surface_node_face_adjacency(
            surface,
            ctx.mesh.n_nodes,
            face_adjacency,
            error)) {
        return false;
    }
    AcaHMatrixBemEntryEvaluator evaluator{
        ctx,
        surface,
        node_adjacency,
        face_adjacency,
        {}};
    if (!evaluator.build_diagonal(error)) {
        return false;
    }

    try {
        AcaHMatrixBemAssembler assembler(evaluator, coordinates, options);
        uint32_t max_rank = 0;
        double relative_error = 0.0;
        uint64_t resident_bytes = 0;
        if (!assembler.build(
                impl_->permutation,
                impl_->clusters,
                impl_->near_blocks,
                impl_->far_blocks,
                max_rank,
                relative_error,
                resident_bytes,
                error)) {
            *impl_ = Impl{};
            return false;
        }
        impl_->size = static_cast<uint32_t>(boundary_size);
        impl_->max_rank = max_rank;
        uint64_t scratch_bytes = 0u;
        uint64_t total_resident_bytes = 0u;
        if (!checked_product(
                static_cast<uint64_t>(max_rank),
                static_cast<uint64_t>(sizeof(double)),
                scratch_bytes) ||
            !checked_sum(resident_bytes, scratch_bytes, total_resident_bytes) ||
            options.max_memory_bytes != 0u &&
                total_resident_bytes > options.max_memory_bytes) {
            *impl_ = Impl{};
            error = "FEM/BEM ACA H-matrix BEM memory budget is too small for apply scratch";
            return false;
        }
        impl_->projected.assign(static_cast<size_t>(max_rank), 0.0);
        impl_->relative_error = relative_error;
        impl_->resident_bytes = total_resident_bytes;
        impl_->ready = true;
        frequency_domain::CanonicalDigestBuilder digest(
            "fullmag.fem.bem.aca_hmatrix_operator.v1");
        digest.add_u64("boundary_node_count", boundary_size);
        digest.add_u64("boundary_triangle_count", surface.triangles.size());
        digest.add_double("characteristic_length", surface.characteristic_length);
        digest.add_double("admissibility_eta", options.admissibility_eta);
        digest.add_u64("leaf_size", options.leaf_size);
        digest.add_u64("max_rank", options.max_rank);
        digest.add_double("relative_tolerance", options.relative_tolerance);
        digest.add_u64("max_memory_bytes", options.max_memory_bytes);
        digest.add_u64("max_exact_entries", options.max_exact_entries);
        digest.add_u64("max_blocks", options.max_blocks);
        digest.add_u64("mesh_node_count", ctx.mesh.n_nodes);
        for (uint32_t node : surface.boundary_nodes) {
            digest.add_u64("boundary_node", node);
            const size_t base = 3u * static_cast<size_t>(node);
            digest.add_double("boundary_node_x", ctx.mesh.nodes_xyz[base]);
            digest.add_double("boundary_node_y", ctx.mesh.nodes_xyz[base + 1u]);
            digest.add_double("boundary_node_z", ctx.mesh.nodes_xyz[base + 2u]);
        }
        digest.add_u64("cell_type_count", ctx.mesh.cell_types.size());
        for (uint32_t value : ctx.mesh.cell_types) {
            digest.add_u64("cell_type", value);
        }
        digest.add_u64("cell_offset_count", ctx.mesh.cell_offsets.size());
        for (uint32_t value : ctx.mesh.cell_offsets) {
            digest.add_u64("cell_offset", value);
        }
        digest.add_u64("cell_node_count", ctx.mesh.cell_nodes.size());
        for (uint32_t value : ctx.mesh.cell_nodes) {
            digest.add_u64("cell_node", value);
        }
        for (const auto &triangle : surface.triangles) {
            digest.add_u64("surface_triangle_node_0", triangle[0]);
            digest.add_u64("surface_triangle_node_1", triangle[1]);
            digest.add_u64("surface_triangle_node_2", triangle[2]);
        }
        digest.add_u64("near_block_count", impl_->near_blocks.size());
        digest.add_u64("far_block_count", impl_->far_blocks.size());
        for (uint32_t value : impl_->permutation) {
            digest.add_u64("permutation", value);
        }
        for (const auto &cluster : impl_->clusters) {
            digest.add_u64("cluster_begin", cluster.begin);
            digest.add_u64("cluster_end", cluster.end);
            digest.add_u64("cluster_left", static_cast<uint64_t>(cluster.left + 1));
            digest.add_u64("cluster_right", static_cast<uint64_t>(cluster.right + 1));
            for (size_t axis = 0; axis < 3u; ++axis) {
                digest.add_double("cluster_box_lower", cluster.box.lower[axis]);
                digest.add_double("cluster_box_upper", cluster.box.upper[axis]);
            }
        }
        for (const auto &block : impl_->near_blocks) {
            digest.add_u64("near_target_cluster", block.target_cluster);
            digest.add_u64("near_source_cluster", block.source_cluster);
            digest.add_u64("near_entry_count", block.values.size());
            for (double value : block.values) {
                digest.add_double("near_value", value);
            }
        }
        for (const auto &block : impl_->far_blocks) {
            digest.add_u64("far_target_cluster", block.target_cluster);
            digest.add_u64("far_source_cluster", block.source_cluster);
            digest.add_u64("far_rank", block.rank);
            digest.add_u64("far_u_count", block.u.size());
            digest.add_u64("far_v_count", block.v.size());
            digest.add_double("far_relative_error", block.relative_error);
            for (double value : block.u) {
                digest.add_double("far_u_value", value);
            }
            for (double value : block.v) {
                digest.add_double("far_v_value", value);
            }
        }
        impl_->fingerprint = "sha256:" + digest.sha256_hex();
        return true;
    } catch (const std::bad_alloc &) {
        *impl_ = Impl{};
        error = "FEM/BEM ACA H-matrix BEM allocation failed";
        return false;
    } catch (const std::exception &exception) {
        *impl_ = Impl{};
        error = std::string("FEM/BEM ACA H-matrix BEM build failed: ") + exception.what();
        return false;
    }
}

bool AcaHMatrixDemagBemOperator::apply(
    const std::vector<double> &u1_boundary,
    std::vector<double> &u2_boundary,
    std::string &error) const
{
    error.clear();
    if (!impl_ || !impl_->ready || impl_->size == 0u) {
        error = "FEM/BEM ACA H-matrix BEM operator is not assembled";
        return false;
    }
    if (u1_boundary.size() != static_cast<size_t>(impl_->size)) {
        error = "FEM/BEM ACA H-matrix BEM operator input size mismatch";
        return false;
    }
    for (double value : u1_boundary) {
        if (!std::isfinite(value)) {
            error = "FEM/BEM ACA H-matrix BEM operator input contains a non-finite value";
            return false;
        }
    }
    if (impl_->projected.size() != static_cast<size_t>(impl_->max_rank)) {
        error = "FEM/BEM ACA H-matrix BEM scratch size mismatch";
        return false;
    }
    u2_boundary.assign(static_cast<size_t>(impl_->size), 0.0);
    for (const auto &block : impl_->near_blocks) {
        const auto &target = impl_->clusters[static_cast<size_t>(block.target_cluster)];
        const auto &source = impl_->clusters[static_cast<size_t>(block.source_cluster)];
        const uint32_t row_count = target.end - target.begin;
        const uint32_t col_count = source.end - source.begin;
        for (uint32_t row = 0; row < row_count; ++row) {
            double sum = 0.0;
            for (uint32_t col = 0; col < col_count; ++col) {
                sum += block.values[static_cast<size_t>(row) * col_count + col] *
                       u1_boundary[static_cast<size_t>(
                           impl_->permutation[source.begin + col])];
            }
            u2_boundary[static_cast<size_t>(impl_->permutation[target.begin + row])] += sum;
        }
    }
    for (const auto &block : impl_->far_blocks) {
        if (block.rank == 0u) {
            continue;
        }
        const auto &target = impl_->clusters[static_cast<size_t>(block.target_cluster)];
        const auto &source = impl_->clusters[static_cast<size_t>(block.source_cluster)];
        const uint32_t row_count = target.end - target.begin;
        const uint32_t col_count = source.end - source.begin;
        std::fill(impl_->projected.begin(), impl_->projected.end(), 0.0);
        for (uint32_t factor = 0; factor < block.rank; ++factor) {
            double sum = 0.0;
            const size_t factor_offset = static_cast<size_t>(factor) * col_count;
            for (uint32_t col = 0; col < col_count; ++col) {
                sum += block.v[factor_offset + col] *
                       u1_boundary[static_cast<size_t>(
                           impl_->permutation[source.begin + col])];
            }
            impl_->projected[static_cast<size_t>(factor)] = sum;
        }
        for (uint32_t row = 0; row < row_count; ++row) {
            double sum = 0.0;
            for (uint32_t factor = 0; factor < block.rank; ++factor) {
                sum += block.u[static_cast<size_t>(factor) * row_count + row] *
                       impl_->projected[static_cast<size_t>(factor)];
            }
            u2_boundary[static_cast<size_t>(impl_->permutation[target.begin + row])] += sum;
        }
    }
    for (double value : u2_boundary) {
        if (!std::isfinite(value)) {
            error = "FEM/BEM ACA H-matrix BEM operator apply produced a non-finite value";
            return false;
        }
    }
    return true;
}

uint32_t AcaHMatrixDemagBemOperator::size() const {
    return impl_ ? impl_->size : 0u;
}

uint32_t AcaHMatrixDemagBemOperator::near_block_count() const {
    return impl_ ? static_cast<uint32_t>(impl_->near_blocks.size()) : 0u;
}

uint32_t AcaHMatrixDemagBemOperator::far_block_count() const {
    return impl_ ? static_cast<uint32_t>(impl_->far_blocks.size()) : 0u;
}

uint64_t AcaHMatrixDemagBemOperator::near_entry_count() const {
    if (!impl_) {
        return 0u;
    }
    uint64_t count = 0u;
    for (const auto &block : impl_->near_blocks) {
        count += static_cast<uint64_t>(block.values.size());
    }
    return count;
}

uint64_t AcaHMatrixDemagBemOperator::far_row_count() const {
    if (!impl_) {
        return 0u;
    }
    uint64_t count = 0u;
    for (const auto &block : impl_->far_blocks) {
        const auto &target = impl_->clusters[static_cast<size_t>(block.target_cluster)];
        count += static_cast<uint64_t>(target.end - target.begin);
    }
    return count;
}

uint32_t AcaHMatrixDemagBemOperator::max_rank_observed() const {
    return impl_ ? impl_->max_rank : 0u;
}

double AcaHMatrixDemagBemOperator::relative_error_estimate() const {
    return impl_ ? impl_->relative_error : std::numeric_limits<double>::infinity();
}

uint64_t AcaHMatrixDemagBemOperator::resident_bytes() const {
    return impl_ ? impl_->resident_bytes : 0u;
}

const std::string &AcaHMatrixDemagBemOperator::fingerprint() const {
    static const std::string empty;
    return impl_ ? impl_->fingerprint : empty;
}

bool AcaHMatrixDemagBemOperator::export_device_data(
    AcaHMatrixDemagBemDeviceData &data,
    std::string &error) const
{
    error.clear();
    data = {};
    if (!impl_ || !impl_->ready || impl_->size == 0u) {
        error = "FEM/BEM ACA H-matrix BEM device export requires an assembled operator";
        return false;
    }
    try {
        const size_t boundary_size = static_cast<size_t>(impl_->size);
        std::vector<std::vector<uint32_t>> near_columns(boundary_size);
        std::vector<std::vector<double>> near_values(boundary_size);

        data.boundary_permutation = impl_->permutation;
        for (const auto &block : impl_->near_blocks) {
            const auto &target = impl_->clusters[static_cast<size_t>(block.target_cluster)];
            const auto &source = impl_->clusters[static_cast<size_t>(block.source_cluster)];
            const uint32_t row_count = target.end - target.begin;
            const uint32_t col_count = source.end - source.begin;
            for (uint32_t row = 0; row < row_count; ++row) {
                const size_t boundary_row = static_cast<size_t>(
                    impl_->permutation[target.begin + row]);
                for (uint32_t col = 0; col < col_count; ++col) {
                    near_columns[boundary_row].push_back(
                        impl_->permutation[source.begin + col]);
                    near_values[boundary_row].push_back(
                        block.values[static_cast<size_t>(row) * col_count + col]);
                }
            }
        }
        data.far_blocks.reserve(impl_->far_blocks.size());
        for (const auto &block : impl_->far_blocks) {
            const auto &target = impl_->clusters[static_cast<size_t>(block.target_cluster)];
            const auto &source = impl_->clusters[static_cast<size_t>(block.source_cluster)];
            uint64_t expected_u = 0u;
            uint64_t expected_v = 0u;
            if (!checked_product(
                    static_cast<uint64_t>(block.rank),
                    static_cast<uint64_t>(target.end - target.begin),
                    expected_u) ||
                !checked_product(
                    static_cast<uint64_t>(block.rank),
                    static_cast<uint64_t>(source.end - source.begin),
                    expected_v) ||
                block.u.size() != static_cast<size_t>(expected_u) ||
                block.v.size() != static_cast<size_t>(expected_v) ||
                data.far_blocks.size() >=
                    static_cast<size_t>(std::numeric_limits<uint32_t>::max())) {
                error = "FEM/BEM ACA H-matrix BEM device export has invalid far block storage";
                data = {};
                return false;
            }
            const uint64_t u_offset = static_cast<uint64_t>(data.far_u.size());
            const uint64_t v_offset = static_cast<uint64_t>(data.far_v.size());
            data.far_u.insert(data.far_u.end(), block.u.begin(), block.u.end());
            data.far_v.insert(data.far_v.end(), block.v.begin(), block.v.end());
            data.far_blocks.push_back(AcaHMatrixDemagBemFarBlock{
                source.begin,
                source.end,
                target.begin,
                target.end,
                block.rank,
                u_offset,
                v_offset});
        }

        data.near_row_offsets.assign(boundary_size + 1u, 0u);
        for (size_t row = 0; row < boundary_size; ++row) {
            const uint64_t near_end =
                static_cast<uint64_t>(data.near_column_indices.size()) +
                near_columns[row].size();
            if (near_end > std::numeric_limits<uint32_t>::max()) {
                error = "FEM/BEM ACA H-matrix BEM device export exceeds uint32 CSR capacity";
                data = {};
                return false;
            }
            data.near_column_indices.insert(
                data.near_column_indices.end(),
                near_columns[row].begin(),
                near_columns[row].end());
            data.near_values.insert(
                data.near_values.end(),
                near_values[row].begin(),
                near_values[row].end());
            data.near_row_offsets[row + 1u] = static_cast<uint32_t>(near_end);
        }
        if (data.near_values.size() != data.near_column_indices.size() ||
            data.boundary_permutation.size() != boundary_size) {
            error = "FEM/BEM ACA H-matrix BEM device export produced inconsistent arrays";
            data = {};
            return false;
        }
        for (const auto &block : data.far_blocks) {
            uint64_t u_size = 0u;
            uint64_t v_size = 0u;
            uint64_t u_end = 0u;
            uint64_t v_end = 0u;
            if (!checked_product(
                    static_cast<uint64_t>(block.rank),
                    static_cast<uint64_t>(block.target_end - block.target_begin),
                    u_size) ||
                !checked_product(
                    static_cast<uint64_t>(block.rank),
                    static_cast<uint64_t>(block.source_end - block.source_begin),
                    v_size) ||
                !checked_sum(block.u_offset, u_size, u_end) ||
                !checked_sum(block.v_offset, v_size, v_end) ||
                u_end > data.far_u.size() || v_end > data.far_v.size()) {
                error = "FEM/BEM ACA H-matrix BEM device export has invalid factor offsets";
                data = {};
                return false;
            }
        }
        return true;
    } catch (const std::bad_alloc &) {
        data = {};
        error = "FEM/BEM ACA H-matrix BEM device export allocation failed";
        return false;
    } catch (const std::exception &exception) {
        data = {};
        error = std::string("FEM/BEM ACA H-matrix BEM device export failed: ") + exception.what();
        return false;
    }
}

} // namespace fullmag::fem
