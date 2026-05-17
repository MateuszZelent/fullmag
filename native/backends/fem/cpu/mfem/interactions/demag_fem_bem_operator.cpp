#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"

#include "context.hpp"

#include <array>
#include <cmath>

namespace fullmag::fem {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kVertexCoincidenceTol2 = 1e-48;

using Vec3 = std::array<double, 3>;

Vec3 sub(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vec3 scale(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

double dot(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm(const Vec3 &a) {
    return std::sqrt(dot(a, a));
}

Vec3 node_position(const Context &ctx, uint32_t node) {
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.nodes_xyz[base + 0u],
        ctx.nodes_xyz[base + 1u],
        ctx.nodes_xyz[base + 2u],
    };
}

double solid_angle_magnitude(const Vec3 &x, const Vec3 &p0, const Vec3 &p1, const Vec3 &p2) {
    const Vec3 r0 = sub(p0, x);
    const Vec3 r1 = sub(p1, x);
    const Vec3 r2 = sub(p2, x);
    const double n0 = norm(r0);
    const double n1 = norm(r1);
    const double n2 = norm(r2);
    if (!(n0 > 0.0) || !(n1 > 0.0) || !(n2 > 0.0)) {
        return 0.0;
    }
    const double det = dot(r0, cross(r1, r2));
    const double denom =
        n0 * n1 * n2 +
        dot(r0, r1) * n2 +
        dot(r1, r2) * n0 +
        dot(r2, r0) * n1;
    return std::abs(2.0 * std::atan2(det, denom));
}

bool point_matches_vertex(const Vec3 &x, const Vec3 &p) {
    const Vec3 d = sub(x, p);
    return dot(d, d) <= kVertexCoincidenceTol2;
}

std::array<double, 3> lindholm_linear_triangle_weights(
    const Vec3 &x,
    const std::array<Vec3, 3> &p,
    double area,
    const Vec3 &unit_normal)
{
    if (!(area > 0.0) ||
        point_matches_vertex(x, p[0]) ||
        point_matches_vertex(x, p[1]) ||
        point_matches_vertex(x, p[2])) {
        return {0.0, 0.0, 0.0};
    }

    std::array<Vec3, 3> rho_vec{};
    std::array<Vec3, 3> edge_unit{};
    std::array<Vec3, 3> eta{};
    std::array<double, 3> eta0{};
    std::array<double, 3> rho{};
    std::array<double, 3> edge_len{};
    std::array<double, 3> edge_log{};

    for (int i = 0; i < 3; ++i) {
        rho_vec[static_cast<size_t>(i)] = sub(p[static_cast<size_t>(i)], x);
        rho[static_cast<size_t>(i)] = norm(rho_vec[static_cast<size_t>(i)]);
    }
    for (int i = 0; i < 3; ++i) {
        const int next = (i + 1) % 3;
        const Vec3 edge = sub(rho_vec[static_cast<size_t>(next)], rho_vec[static_cast<size_t>(i)]);
        edge_len[static_cast<size_t>(i)] = norm(edge);
        if (!(edge_len[static_cast<size_t>(i)] > 0.0)) {
            return {0.0, 0.0, 0.0};
        }
        edge_unit[static_cast<size_t>(i)] = scale(edge, 1.0 / edge_len[static_cast<size_t>(i)]);
        eta[static_cast<size_t>(i)] = cross(unit_normal, edge_unit[static_cast<size_t>(i)]);
        eta0[static_cast<size_t>(i)] = dot(eta[static_cast<size_t>(i)], rho_vec[static_cast<size_t>(i)]);
        const double numerator =
            rho[static_cast<size_t>(i)] +
            rho[static_cast<size_t>(next)] +
            edge_len[static_cast<size_t>(i)];
        const double denominator =
            rho[static_cast<size_t>(i)] +
            rho[static_cast<size_t>(next)] -
            edge_len[static_cast<size_t>(i)];
        if (!(numerator > 0.0) || !(denominator > 0.0)) {
            return {0.0, 0.0, 0.0};
        }
        edge_log[static_cast<size_t>(i)] = std::log(numerator / denominator);
    }

    double omega = solid_angle_magnitude(x, p[0], p[1], p[2]);
    const double chi0 = dot(unit_normal, rho_vec[0]);
    if (chi0 < 0.0) {
        omega = -omega;
    }

    double gamma_times_log[3] = {0.0, 0.0, 0.0};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            gamma_times_log[i] +=
                dot(edge_unit[static_cast<size_t>((i + 1) % 3)], edge_unit[static_cast<size_t>(j)]) *
                edge_log[static_cast<size_t>(j)];
        }
    }

    std::array<double, 3> weights{};
    for (int i = 0; i < 3; ++i) {
        const int next = (i + 1) % 3;
        weights[static_cast<size_t>(i)] =
            edge_len[static_cast<size_t>(next)] / (8.0 * kPi * area) *
            (eta0[static_cast<size_t>(next)] * omega - chi0 * gamma_times_log[i]);
    }
    return weights;
}

double boundary_node_solid_angle_sum(
    const Context &ctx,
    uint32_t node)
{
    double sum = 0.0;
    for (uint32_t elem = 0; elem < ctx.n_elements; ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const size_t base = static_cast<size_t>(elem) * 4u;
        int local = -1;
        for (int i = 0; i < 4; ++i) {
            if (ctx.elements[base + static_cast<size_t>(i)] == node) {
                local = i;
                break;
            }
        }
        if (local < 0) {
            continue;
        }
        const Vec3 x = node_position(ctx, node);
        Vec3 other[3]{};
        int cursor = 0;
        for (int i = 0; i < 4; ++i) {
            if (i == local) {
                continue;
            }
            other[cursor++] = node_position(ctx, ctx.elements[base + static_cast<size_t>(i)]);
        }
        sum += solid_angle_magnitude(x, other[0], other[1], other[2]);
    }
    return sum;
}

} // namespace

bool DenseDemagBemOperator::build(
    const Context &ctx,
    const DemagBoundarySurface &surface,
    std::string &error)
{
    size_ = static_cast<uint32_t>(surface.boundary_nodes.size());
    matrix_.assign(static_cast<size_t>(size_) * static_cast<size_t>(size_), 0.0);
    if (size_ == 0) {
        error = "FEM/BEM dense BEM operator requires at least one boundary node";
        return false;
    }

    for (uint32_t row = 0; row < size_; ++row) {
        const uint32_t global_node = surface.boundary_nodes[static_cast<size_t>(row)];
        const double omega_sum = boundary_node_solid_angle_sum(ctx, global_node);
        matrix_[static_cast<size_t>(row) * size_ + row] =
            omega_sum / (4.0 * kPi) - 1.0;
    }

    for (uint32_t row = 0; row < size_; ++row) {
        const Vec3 x = node_position(ctx, surface.boundary_nodes[static_cast<size_t>(row)]);
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
                node_position(ctx, tri[2]),
            };
            const auto weights = lindholm_linear_triangle_weights(
                x,
                p,
                surface.triangle_areas[face],
                surface.unit_normals[face]);
            for (int local = 0; local < 3; ++local) {
                const int32_t col =
                    surface.global_to_boundary[static_cast<size_t>(tri[static_cast<size_t>(local)])];
                if (col < 0) {
                    error = "FEM/BEM dense BEM operator found a boundary face without a node map";
                    return false;
                }
                matrix_[static_cast<size_t>(row) * size_ + static_cast<size_t>(col)] +=
                    weights[static_cast<size_t>(local)];
            }
        }
    }
    return true;
}

bool DenseDemagBemOperator::apply(
    const std::vector<double> &u1_boundary,
    std::vector<double> &u2_boundary,
    std::string &error) const
{
    if (u1_boundary.size() != size_) {
        error = "FEM/BEM dense BEM operator input size mismatch";
        return false;
    }
    u2_boundary.assign(static_cast<size_t>(size_), 0.0);
    for (uint32_t row = 0; row < size_; ++row) {
        double sum = 0.0;
        for (uint32_t col = 0; col < size_; ++col) {
            sum += matrix_[static_cast<size_t>(row) * size_ + col] *
                   u1_boundary[static_cast<size_t>(col)];
        }
        u2_boundary[static_cast<size_t>(row)] = sum;
    }
    return true;
}

} // namespace fullmag::fem
