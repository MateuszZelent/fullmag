#include "cpu/mfem/interactions/stt.hpp"

#include "context.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace fullmag::fem {
namespace {

/*
 * Spin-transfer torque interactions for the native FEM CPU backend.
 *
 * Physical contract
 * -----------------
 * Slonczewski and Zhang-Li STT are direct RHS contributions in dm/dt. They are
 * not effective fields and must not be added to H_eff. This module therefore
 * writes into RHS buffers after the ordinary LLG field RHS has been assembled.
 *
 * Discretization
 * --------------
 * Slonczewski CPP is local per node. Zhang-Li CIP uses one P1 tetrahedral
 * gradient per element and projects the element torque back to nodes with
 * lumped weights.
 */

using Vec3 = std::array<double, 3>;

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;
constexpr double kGeomEps = 1e-30;

double dot3(const Vec3 &a, const Vec3 &b)
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross3(const Vec3 &a, const Vec3 &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

Vec3 add3(const Vec3 &a, const Vec3 &b)
{
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

Vec3 sub3(const Vec3 &a, const Vec3 &b)
{
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vec3 scale3(const Vec3 &a, double s)
{
    return {a[0] * s, a[1] * s, a[2] * s};
}

double vector_norm3(double x, double y, double z)
{
    return std::sqrt(x * x + y * y + z * z);
}

Vec3 node_coords(const Context &ctx, uint32_t node)
{
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.nodes_xyz[base + 0],
        ctx.nodes_xyz[base + 1],
        ctx.nodes_xyz[base + 2],
    };
}

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

double effective_magnetic_thickness_along_axis(const Context &ctx, const Vec3 &axis)
{
    double min_proj = std::numeric_limits<double>::infinity();
    double max_proj = -std::numeric_limits<double>::infinity();
    bool any = false;
    for (size_t i = 0; i < static_cast<size_t>(ctx.n_nodes); ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const double proj = ctx.nodes_xyz[base + 0] * axis[0] +
                            ctx.nodes_xyz[base + 1] * axis[1] +
                            ctx.nodes_xyz[base + 2] * axis[2];
        min_proj = std::min(min_proj, proj);
        max_proj = std::max(max_proj, proj);
        any = true;
    }
    if (!any) {
        return std::max(ctx.hmax, 1e-30);
    }
    return std::max(max_proj - min_proj, std::max(ctx.hmax, 1e-30));
}

bool tetrahedron_gradients(
    const Vec3 &p0,
    const Vec3 &p1,
    const Vec3 &p2,
    const Vec3 &p3,
    Vec3 (&grads)[4],
    double &volume)
{
    const Vec3 d1 = sub3(p1, p0);
    const Vec3 d2 = sub3(p2, p0);
    const Vec3 d3 = sub3(p3, p0);
    const Vec3 c23 = cross3(d2, d3);
    const double det = dot3(d1, c23);
    if (!(std::abs(det) > kGeomEps) || !std::isfinite(det)) {
        volume = 0.0;
        return false;
    }
    volume = std::abs(det) / 6.0;

    const double inv_det = 1.0 / det;
    const double a00 =  (d2[1] * d3[2] - d2[2] * d3[1]) * inv_det;
    const double a01 = -(d2[0] * d3[2] - d2[2] * d3[0]) * inv_det;
    const double a02 =  (d2[0] * d3[1] - d2[1] * d3[0]) * inv_det;
    const double a10 = -(d1[1] * d3[2] - d1[2] * d3[1]) * inv_det;
    const double a11 =  (d1[0] * d3[2] - d1[2] * d3[0]) * inv_det;
    const double a12 = -(d1[0] * d3[1] - d1[1] * d3[0]) * inv_det;
    const double a20 =  (d1[1] * d2[2] - d1[2] * d2[1]) * inv_det;
    const double a21 = -(d1[0] * d2[2] - d1[2] * d2[0]) * inv_det;
    const double a22 =  (d1[0] * d2[1] - d1[1] * d2[0]) * inv_det;

    grads[1] = {a00, a10, a20};
    grads[2] = {a01, a11, a21};
    grads[3] = {a02, a12, a22};
    grads[0] = scale3(add3(add3(grads[1], grads[2]), grads[3]), -1.0);
    return true;
}

} // namespace

void add_slonczewski_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz)
{
    if (!ctx.has_slonczewski_stt) {
        return;
    }

    constexpr double HBAR = 1.054571817e-34;
    constexpr double E_CHARGE = 1.60217662e-19;

    const Vec3 current_density = {
        ctx.stt_current_density_am2[0],
        ctx.stt_current_density_am2[1],
        ctx.stt_current_density_am2[2],
    };
    const double j_mag = vector_norm3(
        current_density[0],
        current_density[1],
        current_density[2]);
    if (!(j_mag > 0.0)) {
        return;
    }
    const Vec3 axis = scale3(current_density, 1.0 / j_mag);
    const double thickness = ctx.stt_free_layer_thickness > 0.0
        ? ctx.stt_free_layer_thickness
        : effective_magnetic_thickness_along_axis(ctx, axis);
    const double lambda = ctx.stt_lambda;
    const double lambda_sq = lambda * lambda;
    const double degree = ctx.stt_degree > 0.0 ? ctx.stt_degree : 1.0;
    const Vec3 p = ctx.stt_spin_polarization;

    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
        const double ms = scalar_field_value(
            ctx.Ms_field,
            i,
            ctx.material.saturation_magnetisation);
        if (!(ms > 0.0)) {
            continue;
        }
        const double prefactor =
            (ctx.stt_current_sign * j_mag * HBAR) / (2.0 * E_CHARGE * kMu0 * ms * thickness);
        const double m_dot_p = dot3(m, p);
        const double g = (degree * lambda_sq) /
            ((lambda_sq + 1.0) + (lambda_sq - 1.0) * m_dot_p);
        const double beta_stt = prefactor * g;

        const Vec3 m_cross_p = cross3(m, p);
        const Vec3 m_cross_m_cross_p = cross3(m, m_cross_p);
        const Vec3 torque = {
            beta_stt * (m_cross_m_cross_p[0] + ctx.stt_epsilon_prime * m_cross_p[0]),
            beta_stt * (m_cross_m_cross_p[1] + ctx.stt_epsilon_prime * m_cross_p[1]),
            beta_stt * (m_cross_m_cross_p[2] + ctx.stt_epsilon_prime * m_cross_p[2]),
        };
        rhs_xyz[base + 0] += torque[0];
        rhs_xyz[base + 1] += torque[1];
        rhs_xyz[base + 2] += torque[2];
    }
}

void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz)
{
    if (!ctx.has_zhang_li_stt) {
        return;
    }

    constexpr double MU_B = 9.274009994e-24;
    constexpr double E_CHARGE = 1.60217662e-19;

    std::vector<double> node_weight(static_cast<size_t>(ctx.n_nodes), 0.0);
    const double beta = ctx.stt_beta;

    for (size_t element_index = 0; element_index < static_cast<size_t>(ctx.n_elements); ++element_index) {
        if (!ctx.magnetic_element_mask.empty() && ctx.magnetic_element_mask[element_index] == 0u) {
            continue;
        }
        const size_t ebase = element_index * 4u;
        const uint32_t n0 = ctx.elements[ebase + 0];
        const uint32_t n1 = ctx.elements[ebase + 1];
        const uint32_t n2 = ctx.elements[ebase + 2];
        const uint32_t n3 = ctx.elements[ebase + 3];
        Vec3 grads[4];
        double volume = 0.0;
        if (!tetrahedron_gradients(
                node_coords(ctx, n0),
                node_coords(ctx, n1),
                node_coords(ctx, n2),
                node_coords(ctx, n3),
                grads,
                volume)) {
            continue;
        }

        const uint32_t nodes[4] = {n0, n1, n2, n3};
        double elem_ms = 0.0;
        for (int local = 0; local < 4; ++local) {
            elem_ms += scalar_field_value(
                ctx.Ms_field,
                nodes[local],
                ctx.material.saturation_magnetisation);
        }
        elem_ms /= 4.0;
        if (!(elem_ms > 0.0)) {
            continue;
        }

        const double drift_prefactor =
            (ctx.stt_degree * MU_B) / (E_CHARGE * elem_ms * (1.0 + beta * beta));
        const Vec3 u = scale3(ctx.stt_current_density_am2, drift_prefactor);

        Vec3 grad_m[3] = {};
        for (int local = 0; local < 4; ++local) {
            const size_t base = static_cast<size_t>(nodes[local]) * 3u;
            const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
            for (int component = 0; component < 3; ++component) {
                grad_m[component][0] += m[component] * grads[local][0];
                grad_m[component][1] += m[component] * grads[local][1];
                grad_m[component][2] += m[component] * grads[local][2];
            }
        }

        const Vec3 dm = {
            dot3(u, grad_m[0]),
            dot3(u, grad_m[1]),
            dot3(u, grad_m[2]),
        };

        const double nodal_weight = volume * 0.25;
        for (int local = 0; local < 4; ++local) {
            const uint32_t node = nodes[local];
            const size_t base = static_cast<size_t>(node) * 3u;
            const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
            const Vec3 c = cross3(m, dm);
            const Vec3 dc = cross3(m, c);
            rhs_xyz[base + 0] += nodal_weight * (-dc[0] - beta * c[0]);
            rhs_xyz[base + 1] += nodal_weight * (-dc[1] - beta * c[1]);
            rhs_xyz[base + 2] += nodal_weight * (-dc[2] - beta * c[2]);
            node_weight[node] += nodal_weight;
        }
    }

    for (size_t i = 0; i < static_cast<size_t>(ctx.n_nodes); ++i) {
        if (!(node_weight[i] > kGeomEps)) {
            continue;
        }
        const double inv_w = 1.0 / node_weight[i];
        const size_t base = i * 3u;
        rhs_xyz[base + 0] *= inv_w;
        rhs_xyz[base + 1] *= inv_w;
        rhs_xyz[base + 2] *= inv_w;
    }
}

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    const std::vector<double> llg_only = rhs_xyz;
    add_slonczewski_stt_rhs_aos(ctx, m_xyz, rhs_xyz);
    if (ctx.has_zhang_li_stt) {
        std::vector<double> zhang_li(rhs_xyz.size(), 0.0);
        add_zhang_li_stt_rhs_aos(ctx, m_xyz, zhang_li);
        for (size_t i = 0; i < rhs_xyz.size(); ++i) {
            rhs_xyz[i] += zhang_li[i];
        }
    }
    if (rhs_xyz != llg_only) {
        max_rhs = 0.0;
        const size_t n = rhs_xyz.size() / 3u;
        for (size_t i = 0; i < n; ++i) {
            const size_t base = i * 3u;
            max_rhs = std::max(
                max_rhs,
                vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
        }
    }
}

} // namespace fullmag::fem
