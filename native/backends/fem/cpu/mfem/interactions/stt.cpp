/*
 * STT aggregate source contract.
 *
 * This source owns executable STT plan import, single-family validation,
 * Slonczewski spin-polarization normalization, reusable workspace preparation,
 * family dispatch, and max_rhs refresh. It does not define Slonczewski CPP or Zhang-Li CIP torque physics.
 */
#include "cpu/mfem/interactions/stt.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace fullmag::fem {

void prepare_stt_workspace(
    SttWorkspace &workspace,
    std::size_t dof_len,
    std::size_t n_nodes)
{
    prepare_zhang_li_stt_workspace(workspace.zhang_li, dof_len, n_nodes);
}

bool initialize_stt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (plan.has_zhang_li_stt != 0 && plan.has_slonczewski_stt != 0) {
        error = "native FEM plan supports only one executable STT family at a time";
        return false;
    }

    ctx.stt.zhang_li_enabled = plan.has_zhang_li_stt != 0;
    ctx.stt.slonczewski_enabled = plan.has_slonczewski_stt != 0;
    ctx.stt.current_density_am2 = {
        plan.stt_current_density_am2[0],
        plan.stt_current_density_am2[1],
        plan.stt_current_density_am2[2],
    };
    ctx.stt.degree = plan.stt_degree;
    ctx.stt.beta = plan.stt_beta;
    ctx.stt.spin_polarization = {
        plan.stt_spin_polarization[0],
        plan.stt_spin_polarization[1],
        plan.stt_spin_polarization[2],
    };
    ctx.stt.lambda = plan.stt_lambda;
    ctx.stt.epsilon_prime = plan.stt_epsilon_prime;
    ctx.stt.free_layer_thickness = plan.stt_free_layer_thickness;
    ctx.stt.current_sign = plan.stt_current_sign;

    if (ctx.stt.slonczewski_enabled) {
        const double len = vector_norm3(
            ctx.stt.spin_polarization[0],
            ctx.stt.spin_polarization[1],
            ctx.stt.spin_polarization[2]);
        if (!std::isfinite(len) || len <= 1e-30) {
            error = "stt_spin_polarization must be finite and non-zero";
            return false;
        }
        ctx.stt.spin_polarization[0] /= len;
        ctx.stt.spin_polarization[1] /= len;
        ctx.stt.spin_polarization[2] /= len;
    }
    return true;
}

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    SttWorkspace workspace;
    prepare_stt_workspace(workspace, rhs_xyz.size(), rhs_xyz.size() / 3u);
    add_stt_rhs_aos(ctx, m_xyz, rhs_xyz, max_rhs, workspace);
}

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs,
    SttWorkspace &workspace)
{
    if (!ctx.stt.slonczewski_enabled && !ctx.stt.zhang_li_enabled) {
        return;
    }

    add_slonczewski_stt_rhs_aos(ctx, m_xyz, rhs_xyz);
    if (ctx.stt.zhang_li_enabled) {
        add_zhang_li_stt_rhs_aos(ctx, m_xyz, rhs_xyz, workspace.zhang_li);
    }

    max_rhs = 0.0;
    const size_t n = rhs_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        max_rhs = std::max(
            max_rhs,
            vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
    }
}

} // namespace fullmag::fem
