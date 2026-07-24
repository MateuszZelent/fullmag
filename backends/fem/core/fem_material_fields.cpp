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

bool validate_elementwise_ms_values(const Context &ctx, std::string &error)
{
    const std::vector<double> &field = ctx.material_fields.Ms_element_field;
    if (field.empty()) {
        return true;
    }
    const std::vector<uint8_t> &magnetic_mask = ctx.mesh.magnetic_element_mask;
    if (!magnetic_mask.empty() && magnetic_mask.size() != field.size()) {
        error = "FEM mesh magnetic element mask does not match Ms_element_field extent";
        return false;
    }
    for (size_t i = 0; i < field.size(); ++i) {
        const double value = field[i];
        if (!std::isfinite(value)) {
            error = std::string("material field 'Ms_element_field'") +
                    " contains NaN/Inf at index " + std::to_string(i);
            return false;
        }
        const bool active = magnetic_mask.empty() || magnetic_mask[i] != 0u;
        if ((active && value <= 0.0) || (!active && value < 0.0)) {
            error = std::string("material field 'Ms_element_field'") +
                    " contains invalid value " + std::to_string(value) +
                    " at index " + std::to_string(i);
            return false;
        }
    }
    return true;
}

const char *first_unsupported_elementwise_ms_cpu_owner(const Context &ctx)
{
    // Keep this order aligned with the planner. Exchange, Poisson demag, and
    // Zeeman already consume the common CPU element/quadrature adapter, but
    // consistent-mass exchange is the required owner for DG0 Ms.
    if (!ctx.exchange.enabled) {
        return "exchange-disabled plan";
    }
    if (!ctx.exchange.mfem.use_consistent_mass) {
        return "lumped-mass exchange projection";
    }
    if (ctx.anisotropy.uniaxial_enabled) {
        return "uniaxial anisotropy";
    }
    if (ctx.anisotropy.cubic_enabled) {
        return "cubic anisotropy";
    }
    if (ctx.dmi.interfacial_enabled) {
        return "interfacial DMI";
    }
    if (ctx.dmi.bulk_enabled) {
        return "bulk DMI";
    }
    if (ctx.thermal_brown.temperature > 0.0) {
        return "thermal Brown interaction";
    }
    if (ctx.stt.zhang_li_enabled) {
        return "Zhang-Li STT";
    }
    if (ctx.stt.slonczewski_enabled) {
        return "Slonczewski STT";
    }
    if (ctx.oersted.has_cylinder || ctx.oersted.has_explicit_field) {
        return "Oersted interaction";
    }
    if (ctx.magnetoelastic.enabled) {
        return "magnetoelastic interaction";
    }
    return nullptr;
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
    if (!ctx.material_fields.Ms_field.empty() &&
        !ctx.material_fields.Ms_element_field.empty()) {
        error = "FEM material coefficient 'Ms' has conflicting nodal P1 'ms_field' and element DG0 'ms_element_field' realizations";
        return false;
    }
    if (!ctx.material_fields.A_field.empty() &&
        !ctx.material_fields.A_element_field.empty()) {
        error = "FEM material coefficient 'A' has conflicting nodal P1 'a_field' and element DG0 'a_element_field' realizations";
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
        !validate_elementwise_ms_values(ctx, error) ||
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

bool validate_elementwise_ms_runtime_support(const Context &ctx, std::string &error) {
    const bool has_ms = !ctx.material_fields.Ms_element_field.empty();
    const bool has_a = !ctx.material_fields.A_element_field.empty();
    if (!has_ms && !has_a) {
        return true;
    }

    const bool gpu = mfem_device_requests_gpu(ctx);
    const char *device = gpu ? "gpu" : "cpu";
    if (has_ms) {
        const char *owner = gpu ? "GPU material-state upload" :
            first_unsupported_elementwise_ms_cpu_owner(ctx);
        if (owner != nullptr) {
            error = std::string("Ms_element_field") + " is unsupported for " + owner +
                " on resolved device '" +
                device +
                "': this owner does not consume the common element/quadrature material accessor";
            return false;
        }
    }

    // A_e enters only the exchange weak form.  Unlike Ms_e it is not read by
    // the local-field, torque, thermal, or observable owners above.
    if (has_a && gpu) {
        error = std::string("A_element_field") + " is unsupported for GPU material-state upload" +
            " on resolved device '" + device +
            "': this runtime has no common element/quadrature material accessor";
        return false;
    }
    if (has_a && !ctx.exchange.enabled) {
        error = std::string("A_element_field") + " is unsupported for exchange-disabled plan" +
            " on resolved device '" + device +
            "': this runtime has no exchange weak form to consume the sharp coefficient";
        return false;
    }
    return true;
}

bool validate_elementwise_ms_relaxation_support(const Context &ctx, std::string &error) {
    if (ctx.material_fields.Ms_element_field.empty()) {
        return true;
    }
    error =
        "Ms_element_field is unsupported for native FEM relaxation: "
        "element-DG0 Ms is qualified only for ordinary explicit-RK time evolution";
    return false;
}

} // namespace fullmag::fem
