#include "cpu/mfem/interactions/stt.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {
namespace {

/*
 * Aggregate spin-transfer torque entry point.
 *
 * Individual executable torque families live in dedicated modules. This file
 * combines enabled STT RHS contributions and refreshes max_rhs after a torque
 * changes the RHS.
 */

double vector_norm3(double x, double y, double z)
{
    return std::sqrt(x * x + y * y + z * z);
}

} // namespace

bool initialize_stt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (plan.has_zhang_li_stt != 0 && plan.has_slonczewski_stt != 0) {
        error = "native FEM plan supports only one executable STT family at a time";
        return false;
    }

    ctx.has_zhang_li_stt = plan.has_zhang_li_stt != 0;
    ctx.has_slonczewski_stt = plan.has_slonczewski_stt != 0;
    ctx.stt_current_density_am2 = {
        plan.stt_current_density_am2[0],
        plan.stt_current_density_am2[1],
        plan.stt_current_density_am2[2],
    };
    ctx.stt_degree = plan.stt_degree;
    ctx.stt_beta = plan.stt_beta;
    ctx.stt_spin_polarization = {
        plan.stt_spin_polarization[0],
        plan.stt_spin_polarization[1],
        plan.stt_spin_polarization[2],
    };
    ctx.stt_lambda = plan.stt_lambda;
    ctx.stt_epsilon_prime = plan.stt_epsilon_prime;
    ctx.stt_free_layer_thickness = plan.stt_free_layer_thickness;
    ctx.stt_current_sign = plan.stt_current_sign;

    if (ctx.has_slonczewski_stt) {
        const double len = vector_norm3(
            ctx.stt_spin_polarization[0],
            ctx.stt_spin_polarization[1],
            ctx.stt_spin_polarization[2]);
        if (!std::isfinite(len) || len <= 1e-30) {
            error = "stt_spin_polarization must be finite and non-zero";
            return false;
        }
        ctx.stt_spin_polarization[0] /= len;
        ctx.stt_spin_polarization[1] /= len;
        ctx.stt_spin_polarization[2] /= len;
    }
    return true;
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
