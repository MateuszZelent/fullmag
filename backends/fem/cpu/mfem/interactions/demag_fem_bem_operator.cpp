/*
 * FEM/BEM demag dense-operator source contract.
 *
 * This source owns dense boundary-integral operator assembly, solid-angle
 * weights, and dense reference apply for extracted boundary surfaces.
 * It does not extract boundary surfaces, solve sparse systems, transfer boundary values, compute energy, or manage workspace.
 */

#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"

#include "context.hpp"
#include "fem_common.hpp"
#include "fem_geometry.hpp"
#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
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

} // namespace fullmag::fem
