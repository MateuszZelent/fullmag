/*
 * Oersted cylinder source contract.
 *
 * This source owns analytical infinite-cylinder axis normalization,
 * unit-current nodal field sampling, current/time-envelope scaling, and scaled
 * H_eff addition.
 * It does not import plan fields or add explicit nodal Oersted buffers.
 */
#include "cpu/mfem/interactions/oersted_cylinder.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {
namespace {

constexpr double kZeroThreshold = 1e-30;

} // namespace

bool normalize_oersted_cylinder_axis(Context &ctx, std::string &error)
{
    if (!ctx.oersted.has_cylinder) {
        return true;
    }

    const double axis_norm = std::sqrt(
        ctx.oersted.axis[0] * ctx.oersted.axis[0] +
        ctx.oersted.axis[1] * ctx.oersted.axis[1] +
        ctx.oersted.axis[2] * ctx.oersted.axis[2]);
    if (!(axis_norm > kZeroThreshold) || !std::isfinite(axis_norm)) {
        error = "oersted_axis must be finite and non-zero";
        return false;
    }

    for (double &value : ctx.oersted.axis) {
        value /= axis_norm;
    }
    return true;
}

bool initialize_oersted_cylinder_field(Context &ctx, std::string &error)
{
    (void) error;
    if (!ctx.oersted.has_cylinder || !(ctx.oersted.radius > 0.0)) {
        return true;
    }

    const double inv_2pi = 1.0 / (2.0 * kPi);
    const double radius = ctx.oersted.radius;
    const double radius_sq = radius * radius;
    const double cx = ctx.oersted.center[0];
    const double cy = ctx.oersted.center[1];
    const double cz = ctx.oersted.center[2];
    const double ax = ctx.oersted.axis[0];
    const double ay = ctx.oersted.axis[1];
    const double az = ctx.oersted.axis[2];

    ctx.oersted.h_basis_per_ampere_xyz.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
    const size_t available_nodes = std::min(
        static_cast<size_t>(ctx.mesh.n_nodes),
        ctx.mesh.nodes_xyz.size() / 3u);
    for (size_t i = 0; i < available_nodes; ++i) {
        const size_t base = i * 3u;
        const double px = ctx.mesh.nodes_xyz[base + 0] - cx;
        const double py = ctx.mesh.nodes_xyz[base + 1] - cy;
        const double pz = ctx.mesh.nodes_xyz[base + 2] - cz;

        const double p_dot_a = px * ax + py * ay + pz * az;
        const double rx = px - p_dot_a * ax;
        const double ry = py - p_dot_a * ay;
        const double rz = pz - p_dot_a * az;
        const double r_perp = std::sqrt(rx * rx + ry * ry + rz * rz);

        if (r_perp < kZeroThreshold) {
            continue;
        }

        const double h_mag =
            (r_perp < radius)
                ? inv_2pi * r_perp / radius_sq
                : inv_2pi / r_perp;
        const double inv_r = 1.0 / r_perp;
        const double rx_hat = rx * inv_r;
        const double ry_hat = ry * inv_r;
        const double rz_hat = rz * inv_r;

        ctx.oersted.h_basis_per_ampere_xyz[base + 0] = h_mag * (ay * rz_hat - az * ry_hat);
        ctx.oersted.h_basis_per_ampere_xyz[base + 1] = h_mag * (az * rx_hat - ax * rz_hat);
        ctx.oersted.h_basis_per_ampere_xyz[base + 2] = h_mag * (ax * ry_hat - ay * rx_hat);
    }

    return true;
}

double oersted_current_scale(const Context &ctx, double evaluation_time_s)
{
    if (!ctx.oersted.has_cylinder) {
        return 1.0;
    }

    double scale = ctx.oersted.current;
    switch (ctx.oersted.time_dep_kind) {
        case 1:
            scale *= std::sin(
                         2.0 * kPi * ctx.oersted.time_dep_freq * evaluation_time_s +
                         ctx.oersted.time_dep_phase) +
                     ctx.oersted.time_dep_offset;
            break;
        case 2:
            scale *= (evaluation_time_s >= ctx.oersted.time_dep_t_on &&
                      evaluation_time_s < ctx.oersted.time_dep_t_off)
                         ? 1.0
                         : 0.0;
            break;
        default:
            break;
    }
    return scale;
}

void add_oersted_cylinder_field(
    const Context &ctx,
    double evaluation_time_s,
    std::vector<double> &h_eff_xyz)
{
    if (!ctx.oersted.has_cylinder || ctx.oersted.h_basis_per_ampere_xyz.empty()) {
        return;
    }

    const double scale = oersted_current_scale(ctx, evaluation_time_s);
    const size_t count = std::min(h_eff_xyz.size(), ctx.oersted.h_basis_per_ampere_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += scale * ctx.oersted.h_basis_per_ampere_xyz[i];
    }
}

} // namespace fullmag::fem
