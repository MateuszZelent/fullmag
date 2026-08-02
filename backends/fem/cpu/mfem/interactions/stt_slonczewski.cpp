/*
 * Slonczewski CPP STT source contract.
 *
 * This source owns CPP damping-like/field-like torque, current sign and
 * magnitude handling, spin-polarization geometry, free-layer thickness fallback,
 * per-node Ms fallback, and nonmagnetic-node masking. It does not import plan fields or compute Zhang-Li CIP torque.
 */
#include "cpu/mfem/interactions/stt_slonczewski.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace fullmag::fem {
namespace {

using Vec3 = std::array<double, 3>;

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

double effective_magnetic_thickness_along_axis(const Context &ctx, const Vec3 &axis)
{
    double min_proj = std::numeric_limits<double>::infinity();
    double max_proj = -std::numeric_limits<double>::infinity();
    bool any = false;
    for (size_t i = 0; i < static_cast<size_t>(ctx.mesh.n_nodes); ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const double proj = ctx.mesh.nodes_xyz[base + 0] * axis[0] +
                            ctx.mesh.nodes_xyz[base + 1] * axis[1] +
                            ctx.mesh.nodes_xyz[base + 2] * axis[2];
        min_proj = std::min(min_proj, proj);
        max_proj = std::max(max_proj, proj);
        any = true;
    }
    if (!any) {
        return std::max(ctx.base_plan.hmax, 1e-30);
    }
    return std::max(max_proj - min_proj, std::max(ctx.base_plan.hmax, 1e-30));
}

} // namespace

void add_slonczewski_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz)
{
    if (!ctx.stt.slonczewski_enabled) {
        return;
    }

    constexpr double HBAR = 1.054571817e-34;
    constexpr double E_CHARGE_LEGACY = 1.60217662e-19;
    constexpr double E_CHARGE_EXACT = 1.602176634e-19;

    const Vec3 current_density = {
        ctx.stt.current_density_am2[0],
        ctx.stt.current_density_am2[1],
        ctx.stt.current_density_am2[2],
    };
    const double j_mag = vector_norm3(
        current_density[0],
        current_density[1],
        current_density[2]);
    const bool canonical_v2 =
        ctx.stt.formula_version == FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2;
    const double signed_current = canonical_v2
        ? dot3(current_density, ctx.stt.stack_normal)
        : ctx.stt.current_sign * j_mag;
    if (signed_current == 0.0) {
        return;
    }
    const Vec3 axis = j_mag > 0.0
        ? scale3(current_density, 1.0 / j_mag)
        : ctx.stt.stack_normal;
    const double thickness = canonical_v2
        ? ctx.stt.free_layer_thickness
        : (ctx.stt.free_layer_thickness > 0.0
            ? ctx.stt.free_layer_thickness
            : effective_magnetic_thickness_along_axis(ctx, axis));
    const double lambda = ctx.stt.lambda;
    const double lambda_sq = lambda * lambda;
    const double degree = ctx.stt.degree > 0.0 ? ctx.stt.degree : 1.0;
    const Vec3 p = ctx.stt.spin_polarization;

    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        if (!ctx.stt.active_node_mask.empty() && ctx.stt.active_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
        const double ms = scalar_field_value(
            ctx.material_fields.Ms_field,
            i,
            ctx.material_fields.material.saturation_magnetisation);
        if (!(ms > 0.0)) {
            continue;
        }
        const double alpha = scalar_field_value(
            ctx.material_fields.alpha_field,
            i,
            ctx.material_fields.material.damping);
        const double omega_denominator_factor = canonical_v2 ? 1.0 : 2.0;
        const double prefactor =
            (signed_current * HBAR *
             ctx.material_fields.material.gyromagnetic_ratio) /
            (omega_denominator_factor * (canonical_v2 ? E_CHARGE_EXACT : E_CHARGE_LEGACY) * kMu0 * ms * thickness);
        const double m_dot_p = dot3(m, p);
        const double g = (degree * lambda_sq) /
            ((lambda_sq + 1.0) + (lambda_sq - 1.0) * m_dot_p);
        const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        const double damping_like = canonical_v2
            ? prefactor * (g + alpha * ctx.stt.epsilon_prime) * inv_gilbert
            : prefactor * g * (1.0 + alpha * ctx.stt.epsilon_prime) * inv_gilbert;
        const double field_like = canonical_v2
            ? prefactor * (ctx.stt.epsilon_prime - alpha * g) * inv_gilbert
            : prefactor * g * (ctx.stt.epsilon_prime - alpha) * inv_gilbert;

        const Vec3 m_cross_p = cross3(m, p);
        const Vec3 m_cross_m_cross_p = cross3(m, m_cross_p);
        const Vec3 torque = {
            damping_like * m_cross_m_cross_p[0] + field_like * m_cross_p[0],
            damping_like * m_cross_m_cross_p[1] + field_like * m_cross_p[1],
            damping_like * m_cross_m_cross_p[2] + field_like * m_cross_p[2],
        };
        rhs_xyz[base + 0] += torque[0];
        rhs_xyz[base + 1] += torque[1];
        rhs_xyz[base + 2] += torque[2];
    }
}

} // namespace fullmag::fem
