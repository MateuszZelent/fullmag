/*
 * Prescribed SOT source contract.
 *
 * This source owns the canonical prescribed_sot.fullmag.v1 local algebra and
 * its FEM node-mask/runtime import. It does not solve charge or spin
 * transport, and it does not define the SHE/iSHE transport equations.
 */

#include "cpu/mfem/interactions/sot.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>

namespace fullmag::fem {
namespace {

using Vec3 = std::array<double, 3>;

constexpr double kSotMu0 = 1.2566370614359173e-6;
constexpr double kHbar = 1.054571817e-34;
constexpr double kExactElectronCharge = 1.602176634e-19;

Vec3 cross3(const Vec3 &a, const Vec3 &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm3(const Vec3 &v)
{
    return vector_norm3(v[0], v[1], v[2]);
}

} // namespace

bool initialize_sot_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    ctx.sot = SotRuntimeState{};
    ctx.sot.enabled = plan.has_prescribed_sot != 0;
    if (!ctx.sot.enabled) {
        return true;
    }

    if (plan.sot_formula_version != FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1) {
        error = "native FEM supports only prescribed_sot.fullmag.v1";
        return false;
    }
    if (!std::isfinite(plan.sot_current_density_am2) ||
        !std::isfinite(plan.sot_xi_dl) ||
        !std::isfinite(plan.sot_xi_fl) ||
        !std::isfinite(plan.sot_thickness) ||
        !(plan.sot_thickness > 0.0)) {
        error = "prescribed FEM SOT current, efficiencies, and thickness must be finite; thickness must be positive";
        return false;
    }
    if (!std::isfinite(plan.sot_envelope_value)) {
        error = "prescribed FEM SOT envelope value must be finite";
        return false;
    }

    const Vec3 sigma = {plan.sot_sigma[0], plan.sot_sigma[1], plan.sot_sigma[2]};
    const double sigma_norm = norm3(sigma);
    if (!std::isfinite(sigma_norm) || sigma_norm <= 1e-30) {
        error = "prescribed FEM SOT sigma must be finite and non-zero";
        return false;
    }

    ctx.sot.formula_version = plan.sot_formula_version;
    ctx.sot.current_density_am2 = plan.sot_current_density_am2;
    ctx.sot.xi_dl = plan.sot_xi_dl;
    ctx.sot.xi_fl = plan.sot_xi_fl;
    ctx.sot.thickness = plan.sot_thickness;
    ctx.sot.envelope_value = plan.sot_envelope_value;
    ctx.sot.sigma = {
        sigma[0] / sigma_norm,
        sigma[1] / sigma_norm,
        sigma[2] / sigma_norm,
    };

    if (plan.sot_active_node_mask != nullptr || plan.sot_active_node_mask_len != 0) {
        if (plan.sot_active_node_mask == nullptr ||
            plan.sot_active_node_mask_len != static_cast<uint64_t>(ctx.mesh.n_nodes)) {
            error = "sot_active_node_mask length must match FEM node count";
            return false;
        }
        ctx.sot.active_node_mask.assign(
            plan.sot_active_node_mask,
            plan.sot_active_node_mask + plan.sot_active_node_mask_len);
        if (std::none_of(ctx.sot.active_node_mask.begin(), ctx.sot.active_node_mask.end(),
                         [](uint8_t selected) { return selected != 0u; })) {
            error = "sot_active_node_mask must select at least one FEM node";
            return false;
        }
    }
    return true;
}

void add_sot_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    if (!ctx.sot.enabled) {
        return;
    }

    const Vec3 sigma = ctx.sot.sigma;
    const double gamma_e = ctx.material_fields.material.gyromagnetic_ratio / kSotMu0;
    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        if (!ctx.sot.active_node_mask.empty() && ctx.sot.active_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
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
        const double omega_base = gamma_e * kHbar *
            (ctx.sot.current_density_am2 * ctx.sot.envelope_value) /
            (2.0 * kExactElectronCharge * ms * ctx.sot.thickness);
        const double omega_dl = omega_base * ctx.sot.xi_dl;
        const double omega_fl = omega_base * ctx.sot.xi_fl;
        const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        const double damping_like = (omega_dl - alpha * omega_fl) * inv_gilbert;
        const double field_like = (omega_fl + alpha * omega_dl) * inv_gilbert;

        const Vec3 m = {m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]};
        const Vec3 m_cross_sigma = cross3(m, sigma);
        const Vec3 m_cross_m_cross_sigma = cross3(m, m_cross_sigma);
        rhs_xyz[base + 0] += -damping_like * m_cross_m_cross_sigma[0] +
            field_like * m_cross_sigma[0];
        rhs_xyz[base + 1] += -damping_like * m_cross_m_cross_sigma[1] +
            field_like * m_cross_sigma[1];
        rhs_xyz[base + 2] += -damping_like * m_cross_m_cross_sigma[2] +
            field_like * m_cross_sigma[2];
    }

    max_rhs = 0.0;
    for (size_t i = 0; i < rhs_xyz.size() / 3u; ++i) {
        const size_t base = i * 3u;
        max_rhs = std::max(
            max_rhs,
            vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
    }
}

} // namespace fullmag::fem
