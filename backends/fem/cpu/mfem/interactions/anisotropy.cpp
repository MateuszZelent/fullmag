/*
 * Anisotropy aggregate source contract.
 *
 * This source owns native FEM plan import for uniaxial/cubic constants and
 * anisotropy axis normalization/validation. It does not compute uniaxial or cubic H_eff/energy.
 */
#include "cpu/mfem/interactions/anisotropy.hpp"

#include "context.hpp"

#include <cmath>

namespace fullmag::fem {

namespace {

constexpr double kAxisZeroThreshold = 1e-30;
constexpr double kCubicAxisDotTolerance = 1e-3;
constexpr double kCubicAxisCrossMinNorm = 1e-6;

void normalize_axis_if_nonzero(std::array<double, 3> &axis)
{
    const double len = std::sqrt(
        axis[0] * axis[0] +
        axis[1] * axis[1] +
        axis[2] * axis[2]);
    if (len > kAxisZeroThreshold) {
        axis[0] /= len;
        axis[1] /= len;
        axis[2] /= len;
    }
}

void copy_field(std::vector<double> &dst, const double *src, uint64_t len)
{
    if (src == nullptr || len == 0) {
        dst.clear();
        return;
    }
    dst.assign(src, src + len);
}

} // namespace

void initialize_anisotropy_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.anisotropy.uniaxial_enabled = plan.has_uniaxial_anisotropy != 0;
    ctx.anisotropy.uniaxial_Ku = plan.uniaxial_anisotropy_constant;
    ctx.anisotropy.uniaxial_Ku2 = plan.uniaxial_anisotropy_k2;
    ctx.anisotropy.uniaxial_axis = {
        plan.anisotropy_axis[0],
        plan.anisotropy_axis[1],
        plan.anisotropy_axis[2],
    };
    copy_field(
        ctx.anisotropy.uniaxial_axis_x_field,
        plan.anisotropy_axis_x_field,
        plan.anisotropy_axis_x_field_len);
    copy_field(
        ctx.anisotropy.uniaxial_axis_y_field,
        plan.anisotropy_axis_y_field,
        plan.anisotropy_axis_y_field_len);
    copy_field(
        ctx.anisotropy.uniaxial_axis_z_field,
        plan.anisotropy_axis_z_field,
        plan.anisotropy_axis_z_field_len);

    ctx.anisotropy.cubic_enabled = plan.has_cubic_anisotropy != 0;
    ctx.anisotropy.cubic_Kc1 = plan.cubic_kc1;
    ctx.anisotropy.cubic_Kc2 = plan.cubic_kc2;
    ctx.anisotropy.cubic_Kc3 = plan.cubic_kc3;
    ctx.anisotropy.cubic_axis1 = {plan.cubic_axis1[0], plan.cubic_axis1[1], plan.cubic_axis1[2]};
    ctx.anisotropy.cubic_axis2 = {plan.cubic_axis2[0], plan.cubic_axis2[1], plan.cubic_axis2[2]};
}

bool normalize_anisotropy_axes(Context &ctx, std::string &error)
{
    if (ctx.anisotropy.uniaxial_enabled) {
        normalize_axis_if_nonzero(ctx.anisotropy.uniaxial_axis);
        const size_t n = ctx.mesh.n_nodes;
        const bool has_axis_field =
            !ctx.anisotropy.uniaxial_axis_x_field.empty() ||
            !ctx.anisotropy.uniaxial_axis_y_field.empty() ||
            !ctx.anisotropy.uniaxial_axis_z_field.empty();
        if (has_axis_field) {
            if (ctx.anisotropy.uniaxial_axis_x_field.size() != n ||
                ctx.anisotropy.uniaxial_axis_y_field.size() != n ||
                ctx.anisotropy.uniaxial_axis_z_field.size() != n) {
                error = "uniaxial anisotropy axis fields must all have length mesh.n_nodes";
                return false;
            }
            for (size_t i = 0; i < n; ++i) {
                std::array<double, 3> axis{
                    ctx.anisotropy.uniaxial_axis_x_field[i],
                    ctx.anisotropy.uniaxial_axis_y_field[i],
                    ctx.anisotropy.uniaxial_axis_z_field[i],
                };
                const double len = std::sqrt(
                    axis[0] * axis[0] +
                    axis[1] * axis[1] +
                    axis[2] * axis[2]);
                if (!std::isfinite(len) || len <= kAxisZeroThreshold) {
                    error = "uniaxial anisotropy axis fields must contain finite non-zero axes";
                    return false;
                }
                ctx.anisotropy.uniaxial_axis_x_field[i] = axis[0] / len;
                ctx.anisotropy.uniaxial_axis_y_field[i] = axis[1] / len;
                ctx.anisotropy.uniaxial_axis_z_field[i] = axis[2] / len;
            }
        }
    }
    if (!ctx.anisotropy.cubic_enabled) {
        return true;
    }

    normalize_axis_if_nonzero(ctx.anisotropy.cubic_axis1);
    normalize_axis_if_nonzero(ctx.anisotropy.cubic_axis2);
    const double dot =
        ctx.anisotropy.cubic_axis1[0] * ctx.anisotropy.cubic_axis2[0] +
        ctx.anisotropy.cubic_axis1[1] * ctx.anisotropy.cubic_axis2[1] +
        ctx.anisotropy.cubic_axis1[2] * ctx.anisotropy.cubic_axis2[2];
    const double cross_x =
        ctx.anisotropy.cubic_axis1[1] * ctx.anisotropy.cubic_axis2[2] -
        ctx.anisotropy.cubic_axis1[2] * ctx.anisotropy.cubic_axis2[1];
    const double cross_y =
        ctx.anisotropy.cubic_axis1[2] * ctx.anisotropy.cubic_axis2[0] -
        ctx.anisotropy.cubic_axis1[0] * ctx.anisotropy.cubic_axis2[2];
    const double cross_z =
        ctx.anisotropy.cubic_axis1[0] * ctx.anisotropy.cubic_axis2[1] -
        ctx.anisotropy.cubic_axis1[1] * ctx.anisotropy.cubic_axis2[0];
    const double cross_norm =
        std::sqrt(cross_x * cross_x + cross_y * cross_y + cross_z * cross_z);
    if (!std::isfinite(dot) ||
        !std::isfinite(cross_norm) ||
        std::abs(dot) > kCubicAxisDotTolerance ||
        cross_norm < kCubicAxisCrossMinNorm) {
        error = "cubic anisotropy axes must be finite, normalized and mutually orthogonal";
        return false;
    }
    return true;
}

} // namespace fullmag::fem
