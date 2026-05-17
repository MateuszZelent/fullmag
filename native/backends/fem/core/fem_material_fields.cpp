#include "core/fem_material_fields.hpp"

#include "context.hpp"

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {
namespace {

void copy_field(std::vector<double> &dst, const double *src, uint64_t len) {
    if (src != nullptr && len > 0) {
        dst.assign(src, src + len);
    }
}

bool check_field_len(
    const Context &ctx,
    const std::vector<double> &field,
    const char *name,
    std::string &error)
{
    if (!field.empty() && field.size() != static_cast<size_t>(ctx.n_nodes)) {
        error = std::string("per-node field '") + name + "' has length " +
                std::to_string(field.size()) + " but n_nodes=" +
                std::to_string(ctx.n_nodes);
        return false;
    }
    return true;
}

bool validate_field_values(
    const std::vector<double> &field,
    const char *name,
    bool require_positive,
    bool allow_zero,
    std::string &error)
{
    for (size_t i = 0; i < field.size(); ++i) {
        const double value = field[i];
        if (!std::isfinite(value)) {
            error = std::string("per-node field '") + name +
                    "' contains NaN/Inf at index " + std::to_string(i);
            return false;
        }
        if (require_positive) {
            const bool valid = allow_zero ? value >= 0.0 : value > 0.0;
            if (!valid) {
                error = std::string("per-node field '") + name +
                        "' contains invalid value " + std::to_string(value) +
                        " at index " + std::to_string(i);
                return false;
            }
        }
    }
    return true;
}

} // namespace

void copy_plan_material_fields(Context &ctx, const fullmag_fem_plan_desc &plan) {
    copy_field(ctx.Ms_field, plan.ms_field, plan.ms_field_len);
    copy_field(ctx.A_field, plan.a_field, plan.a_field_len);
    copy_field(ctx.alpha_field, plan.alpha_field, plan.alpha_field_len);
    copy_field(ctx.Ku_field, plan.ku_field, plan.ku_field_len);
    copy_field(ctx.Ku2_field, plan.ku2_field, plan.ku2_field_len);
    copy_field(ctx.Dind_field, plan.dind_field, plan.dind_field_len);
    copy_field(ctx.Dbulk_field, plan.dbulk_field, plan.dbulk_field_len);
    copy_field(ctx.Kc1_field, plan.kc1_field, plan.kc1_field_len);
    copy_field(ctx.Kc2_field, plan.kc2_field, plan.kc2_field_len);
    copy_field(ctx.Kc3_field, plan.kc3_field, plan.kc3_field_len);
}

bool validate_material_fields(const Context &ctx, std::string &error) {
    if (!check_field_len(ctx, ctx.Ms_field, "Ms_field", error) ||
        !check_field_len(ctx, ctx.A_field, "A_field", error) ||
        !check_field_len(ctx, ctx.alpha_field, "alpha_field", error) ||
        !check_field_len(ctx, ctx.Ku_field, "Ku_field", error) ||
        !check_field_len(ctx, ctx.Ku2_field, "Ku2_field", error) ||
        !check_field_len(ctx, ctx.Dind_field, "Dind_field", error) ||
        !check_field_len(ctx, ctx.Dbulk_field, "Dbulk_field", error) ||
        !check_field_len(ctx, ctx.Kc1_field, "Kc1_field", error) ||
        !check_field_len(ctx, ctx.Kc2_field, "Kc2_field", error) ||
        !check_field_len(ctx, ctx.Kc3_field, "Kc3_field", error)) {
        return false;
    }
    if (!validate_field_values(ctx.Ms_field, "Ms_field", true, false, error) ||
        !validate_field_values(ctx.A_field, "A_field", true, true, error) ||
        !validate_field_values(ctx.alpha_field, "alpha_field", true, true, error) ||
        !validate_field_values(ctx.Ku_field, "Ku_field", false, true, error) ||
        !validate_field_values(ctx.Ku2_field, "Ku2_field", false, true, error) ||
        !validate_field_values(ctx.Dind_field, "Dind_field", false, true, error) ||
        !validate_field_values(ctx.Dbulk_field, "Dbulk_field", false, true, error) ||
        !validate_field_values(ctx.Kc1_field, "Kc1_field", false, true, error) ||
        !validate_field_values(ctx.Kc2_field, "Kc2_field", false, true, error) ||
        !validate_field_values(ctx.Kc3_field, "Kc3_field", false, true, error)) {
        return false;
    }
    if (!std::isfinite(ctx.material.saturation_magnetisation) ||
        ctx.material.saturation_magnetisation <= 0.0) {
        error = "material.saturation_magnetisation must be finite and > 0";
        return false;
    }
    if (!std::isfinite(ctx.material.exchange_stiffness) ||
        ctx.material.exchange_stiffness < 0.0) {
        error = "material.exchange_stiffness must be finite and >= 0";
        return false;
    }
    if (!std::isfinite(ctx.material.damping) || ctx.material.damping < 0.0) {
        error = "material.damping must be finite and >= 0";
        return false;
    }
    if (!std::isfinite(ctx.material.gyromagnetic_ratio) ||
        ctx.material.gyromagnetic_ratio <= 0.0) {
        error = "material.gyromagnetic_ratio must be finite and > 0; native FEM expects gamma_mu0 in m/(A s), not gamma in rad/(T s)";
        return false;
    }
    return true;
}

} // namespace fullmag::fem
