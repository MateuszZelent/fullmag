/*
 * FEM material-fields core source contract.
 *
 * This source owns scalar material import, optional per-node material field
 * copies, optional per-element coefficient copies, field length checks,
 * finite-value checks, and scalar material convention validation. It does not import mesh topology, initialize magnetization, size field buffers, choose runtime devices, or compute interaction fields.
 */

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
    const std::vector<double> &field,
    const char *name,
    uint64_t expected_len,
    const char *expected_name,
    std::string &error)
{
    if (!field.empty() && field.size() != static_cast<size_t>(expected_len)) {
        error = std::string("material field '") + name + "' has length " +
                std::to_string(field.size()) + " but " + expected_name + "=" +
                std::to_string(expected_len);
        return false;
    }
    return true;
}

bool check_node_field_len(
    const Context &ctx,
    const std::vector<double> &field,
    const char *name,
    std::string &error)
{
    return check_field_len(field, name, ctx.mesh.n_nodes, "n_nodes", error);
}

bool check_element_field_len(
    const Context &ctx,
    const std::vector<double> &field,
    const char *name,
    std::string &error)
{
    return check_field_len(field, name, ctx.mesh.n_elements, "n_elements", error);
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
            error = std::string("material field '") + name +
                    "' contains NaN/Inf at index " + std::to_string(i);
            return false;
        }
        if (require_positive) {
            const bool valid = allow_zero ? value >= 0.0 : value > 0.0;
            if (!valid) {
                error = std::string("material field '") + name +
                        "' contains invalid value " + std::to_string(value) +
                        " at index " + std::to_string(i);
                return false;
            }
        }
    }
    return true;
}

} // namespace

void initialize_material_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan) {
    ctx.material_fields.material = plan.material;
    copy_plan_material_fields(ctx, plan);
}

void copy_plan_material_fields(Context &ctx, const fullmag_fem_plan_desc &plan) {
    copy_field(ctx.material_fields.Ms_field, plan.ms_field, plan.ms_field_len);
    copy_field(ctx.material_fields.A_field, plan.a_field, plan.a_field_len);
    copy_field(ctx.material_fields.alpha_field, plan.alpha_field, plan.alpha_field_len);
    copy_field(ctx.material_fields.Ku_field, plan.ku_field, plan.ku_field_len);
    copy_field(ctx.material_fields.Ku2_field, plan.ku2_field, plan.ku2_field_len);
    copy_field(ctx.material_fields.Dind_field, plan.dind_field, plan.dind_field_len);
    copy_field(ctx.material_fields.Dbulk_field, plan.dbulk_field, plan.dbulk_field_len);
    copy_field(ctx.material_fields.Kc1_field, plan.kc1_field, plan.kc1_field_len);
    copy_field(ctx.material_fields.Kc2_field, plan.kc2_field, plan.kc2_field_len);
    copy_field(ctx.material_fields.Kc3_field, plan.kc3_field, plan.kc3_field_len);
    copy_field(
        ctx.material_fields.Ms_element_field,
        plan.ms_element_field,
        plan.ms_element_field_len);
    copy_field(
        ctx.material_fields.A_element_field,
        plan.a_element_field,
        plan.a_element_field_len);
}

bool validate_material_fields(const Context &ctx, std::string &error) {
    if (!check_node_field_len(ctx, ctx.material_fields.Ms_field, "Ms_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.A_field, "A_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.alpha_field, "alpha_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Ku_field, "Ku_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Ku2_field, "Ku2_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Dind_field, "Dind_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Dbulk_field, "Dbulk_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Kc1_field, "Kc1_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Kc2_field, "Kc2_field", error) ||
        !check_node_field_len(ctx, ctx.material_fields.Kc3_field, "Kc3_field", error) ||
        !check_element_field_len(
            ctx,
            ctx.material_fields.Ms_element_field,
            "Ms_element_field",
            error) ||
        !check_element_field_len(
            ctx,
            ctx.material_fields.A_element_field,
            "A_element_field",
            error)) {
        return false;
    }
    if (!validate_field_values(ctx.material_fields.Ms_field, "Ms_field", true, false, error) ||
        !validate_field_values(ctx.material_fields.A_field, "A_field", true, true, error) ||
        !validate_field_values(ctx.material_fields.alpha_field, "alpha_field", true, true, error) ||
        !validate_field_values(ctx.material_fields.Ku_field, "Ku_field", false, true, error) ||
        !validate_field_values(ctx.material_fields.Ku2_field, "Ku2_field", false, true, error) ||
        !validate_field_values(ctx.material_fields.Dind_field, "Dind_field", false, true, error) ||
        !validate_field_values(ctx.material_fields.Dbulk_field, "Dbulk_field", false, true, error) ||
        !validate_field_values(ctx.material_fields.Kc1_field, "Kc1_field", false, true, error) ||
        !validate_field_values(ctx.material_fields.Kc2_field, "Kc2_field", false, true, error) ||
        !validate_field_values(ctx.material_fields.Kc3_field, "Kc3_field", false, true, error) ||
        !validate_field_values(
            ctx.material_fields.Ms_element_field,
            "Ms_element_field",
            true,
            false,
            error) ||
        !validate_field_values(
            ctx.material_fields.A_element_field,
            "A_element_field",
            true,
            true,
            error)) {
        return false;
    }
    if (!std::isfinite(ctx.material_fields.material.saturation_magnetisation) ||
        ctx.material_fields.material.saturation_magnetisation <= 0.0) {
        error = "material.saturation_magnetisation must be finite and > 0";
        return false;
    }
    if (!std::isfinite(ctx.material_fields.material.exchange_stiffness) ||
        ctx.material_fields.material.exchange_stiffness < 0.0) {
        error = "material.exchange_stiffness must be finite and >= 0";
        return false;
    }
    if (!std::isfinite(ctx.material_fields.material.damping) || ctx.material_fields.material.damping < 0.0) {
        error = "material.damping must be finite and >= 0";
        return false;
    }
    if (!std::isfinite(ctx.material_fields.material.gyromagnetic_ratio) ||
        ctx.material_fields.material.gyromagnetic_ratio <= 0.0) {
        error = "material.gyromagnetic_ratio must be finite and > 0; native FEM expects gamma_mu0 in m/(A s), not gamma in rad/(T s)";
        return false;
    }
    return true;
}

} // namespace fullmag::fem
