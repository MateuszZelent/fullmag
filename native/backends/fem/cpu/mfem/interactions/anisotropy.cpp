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

} // namespace

void initialize_anisotropy_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.enable_anisotropy = plan.has_uniaxial_anisotropy != 0;
    ctx.anisotropy_Ku = plan.uniaxial_anisotropy_constant;
    ctx.anisotropy_Ku2 = plan.uniaxial_anisotropy_k2;
    ctx.anisotropy_axis = {
        plan.anisotropy_axis[0],
        plan.anisotropy_axis[1],
        plan.anisotropy_axis[2],
    };

    ctx.enable_cubic_anisotropy = plan.has_cubic_anisotropy != 0;
    ctx.cubic_Kc1 = plan.cubic_kc1;
    ctx.cubic_Kc2 = plan.cubic_kc2;
    ctx.cubic_Kc3 = plan.cubic_kc3;
    ctx.cubic_axis1 = {plan.cubic_axis1[0], plan.cubic_axis1[1], plan.cubic_axis1[2]};
    ctx.cubic_axis2 = {plan.cubic_axis2[0], plan.cubic_axis2[1], plan.cubic_axis2[2]};
}

bool normalize_anisotropy_axes(Context &ctx, std::string &error)
{
    if (ctx.enable_anisotropy) {
        normalize_axis_if_nonzero(ctx.anisotropy_axis);
    }
    if (!ctx.enable_cubic_anisotropy) {
        return true;
    }

    normalize_axis_if_nonzero(ctx.cubic_axis1);
    normalize_axis_if_nonzero(ctx.cubic_axis2);
    const double dot =
        ctx.cubic_axis1[0] * ctx.cubic_axis2[0] +
        ctx.cubic_axis1[1] * ctx.cubic_axis2[1] +
        ctx.cubic_axis1[2] * ctx.cubic_axis2[2];
    const double cross_x =
        ctx.cubic_axis1[1] * ctx.cubic_axis2[2] -
        ctx.cubic_axis1[2] * ctx.cubic_axis2[1];
    const double cross_y =
        ctx.cubic_axis1[2] * ctx.cubic_axis2[0] -
        ctx.cubic_axis1[0] * ctx.cubic_axis2[2];
    const double cross_z =
        ctx.cubic_axis1[0] * ctx.cubic_axis2[1] -
        ctx.cubic_axis1[1] * ctx.cubic_axis2[0];
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

/*
 * Compatibility translation unit for the aggregate anisotropy include surface.
 * Executable anisotropy families live in anisotropy_uniaxial.cpp and
 * anisotropy_cubic.cpp.
 */

} // namespace fullmag::fem
