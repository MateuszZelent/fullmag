#include "cpu/mfem/interactions/stt_slonczewski.hpp"

#include "context.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace fullmag::fem {
namespace {

using Vec3 = std::array<double, 3>;

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

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

Vec3 scale3(const Vec3 &a, double s)
{
    return {a[0] * s, a[1] * s, a[2] * s};
}

double vector_norm3(double x, double y, double z)
{
    return std::sqrt(x * x + y * y + z * z);
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

} // namespace fullmag::fem
