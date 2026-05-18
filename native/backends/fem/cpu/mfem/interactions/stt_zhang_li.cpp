/*
 * Zhang-Li CIP STT source contract.
 *
 * This source owns CIP drift/beta torque, tetrahedral magnetization gradients,
 * nodal projection, reusable RHS/weight scratch, per-element Ms fallback, and
 * additive RHS composition. It does not import plan fields or compute Slonczewski CPP torque.
 */
#include "cpu/mfem/interactions/stt_zhang_li.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>

namespace fullmag::fem {
namespace {

using Vec3 = std::array<double, 3>;

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

Vec3 node_coords(const Context &ctx, uint32_t node)
{
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.mesh.nodes_xyz[base + 0],
        ctx.mesh.nodes_xyz[base + 1],
        ctx.mesh.nodes_xyz[base + 2],
    };
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

void prepare_zhang_li_stt_workspace(
    ZhangLiSttWorkspace &workspace,
    std::size_t dof_len,
    std::size_t n_nodes)
{
    workspace.rhs_xyz.resize(dof_len, 0.0);
    workspace.node_weight.resize(n_nodes, 0.0);
}

void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz)
{
    ZhangLiSttWorkspace workspace;
    prepare_zhang_li_stt_workspace(workspace, rhs_xyz.size(), static_cast<size_t>(ctx.n_nodes));
    add_zhang_li_stt_rhs_aos(ctx, m_xyz, rhs_xyz, workspace);
}

void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    ZhangLiSttWorkspace &workspace)
{
    if (!ctx.has_zhang_li_stt) {
        return;
    }

    constexpr double MU_B = 9.274009994e-24;
    constexpr double E_CHARGE = 1.60217662e-19;

    if (workspace.rhs_xyz.size() != rhs_xyz.size() ||
        workspace.node_weight.size() != static_cast<size_t>(ctx.n_nodes)) {
        prepare_zhang_li_stt_workspace(
            workspace,
            rhs_xyz.size(),
            static_cast<size_t>(ctx.n_nodes));
    }
    std::fill(workspace.rhs_xyz.begin(), workspace.rhs_xyz.end(), 0.0);
    std::fill(workspace.node_weight.begin(), workspace.node_weight.end(), 0.0);

    const double beta = ctx.stt_beta;

    for (size_t element_index = 0; element_index < static_cast<size_t>(ctx.n_elements); ++element_index) {
        if (!ctx.mesh.magnetic_element_mask.empty() && ctx.mesh.magnetic_element_mask[element_index] == 0u) {
            continue;
        }
        const size_t ebase = element_index * 4u;
        const uint32_t n0 = ctx.mesh.elements[ebase + 0];
        const uint32_t n1 = ctx.mesh.elements[ebase + 1];
        const uint32_t n2 = ctx.mesh.elements[ebase + 2];
        const uint32_t n3 = ctx.mesh.elements[ebase + 3];
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
                ctx.material_fields.Ms_field,
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
            workspace.rhs_xyz[base + 0] += nodal_weight * (-dc[0] - beta * c[0]);
            workspace.rhs_xyz[base + 1] += nodal_weight * (-dc[1] - beta * c[1]);
            workspace.rhs_xyz[base + 2] += nodal_weight * (-dc[2] - beta * c[2]);
            workspace.node_weight[node] += nodal_weight;
        }
    }

    for (size_t i = 0; i < static_cast<size_t>(ctx.n_nodes); ++i) {
        if (!(workspace.node_weight[i] > kGeomEps)) {
            continue;
        }
        const double inv_w = 1.0 / workspace.node_weight[i];
        const size_t base = i * 3u;
        rhs_xyz[base + 0] += workspace.rhs_xyz[base + 0] * inv_w;
        rhs_xyz[base + 1] += workspace.rhs_xyz[base + 1] * inv_w;
        rhs_xyz[base + 2] += workspace.rhs_xyz[base + 2] * inv_w;
    }
}

} // namespace fullmag::fem
