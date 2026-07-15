/*
 * STT aggregate source contract.
 *
 * This source owns executable STT plan import, single-family validation,
 * Slonczewski spin-polarization normalization, reusable workspace preparation,
 * family dispatch, and max_rhs refresh. It does not define Slonczewski CPP or Zhang-Li CIP torque physics.
 */
#include "cpu/mfem/interactions/stt.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace fullmag::fem {

void prepare_stt_workspace(
    SttWorkspace &workspace,
    std::size_t dof_len,
    std::size_t n_nodes)
{
    prepare_zhang_li_stt_workspace(workspace.zhang_li, dof_len, n_nodes);
}

bool initialize_stt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (plan.has_zhang_li_stt != 0 && plan.has_slonczewski_stt != 0) {
        error = "native FEM plan supports only one executable STT family at a time";
        return false;
    }

    ctx.stt.zhang_li_enabled = plan.has_zhang_li_stt != 0;
    ctx.stt.slonczewski_enabled = plan.has_slonczewski_stt != 0;
    const bool stt_enabled = ctx.stt.zhang_li_enabled || ctx.stt.slonczewski_enabled;
    if (stt_enabled) {
        for (double component : plan.stt_current_density_am2) {
            if (!std::isfinite(component)) {
                error = "stt_current_density_am2 components must be finite";
                return false;
            }
        }
        if (!std::isfinite(plan.stt_degree) || plan.stt_degree <= 0.0 || plan.stt_degree > 1.0) {
            error = "stt_degree must be finite and in (0, 1]";
            return false;
        }
        if (!std::isfinite(plan.stt_beta)) {
            error = "stt_beta must be finite";
            return false;
        }
        if (!std::isfinite(plan.stt_epsilon_prime)) {
            error = "stt_epsilon_prime must be finite";
            return false;
        }
        if (!std::isfinite(plan.stt_free_layer_thickness) || plan.stt_free_layer_thickness < 0.0) {
            error = "stt_free_layer_thickness must be finite and non-negative";
            return false;
        }
        if (!std::isfinite(plan.stt_current_sign)) {
            error = "stt_current_sign must be finite";
            return false;
        }
    }
    if (ctx.stt.slonczewski_enabled &&
        (!std::isfinite(plan.stt_lambda) || plan.stt_lambda < 1.0)) {
        error = "stt_lambda must be finite and >= 1 for Slonczewski STT";
        return false;
    }
    ctx.stt.current_density_am2 = {
        plan.stt_current_density_am2[0],
        plan.stt_current_density_am2[1],
        plan.stt_current_density_am2[2],
    };
    ctx.stt.degree = plan.stt_degree;
    ctx.stt.beta = plan.stt_beta;
    ctx.stt.spin_polarization = {
        plan.stt_spin_polarization[0],
        plan.stt_spin_polarization[1],
        plan.stt_spin_polarization[2],
    };
    ctx.stt.lambda = plan.stt_lambda;
    ctx.stt.epsilon_prime = plan.stt_epsilon_prime;
    ctx.stt.free_layer_thickness = plan.stt_free_layer_thickness;
    ctx.stt.current_sign = plan.stt_current_sign;
    ctx.stt.formula_version = plan.stt_formula_version;
    ctx.stt.realization_version = plan.stt_realization_version;
    ctx.stt.operator_version = plan.stt_operator_version;
    ctx.stt.stack_normal = {
        plan.stt_stack_normal[0], plan.stt_stack_normal[1], plan.stt_stack_normal[2],
    };
    ctx.stt.lande_g = plan.stt_lande_g;
    ctx.stt.active_node_mask.clear();
    ctx.stt.active_element_mask.clear();
    if (plan.stt_active_node_mask != nullptr || plan.stt_active_node_mask_len != 0) {
        if (plan.stt_active_node_mask == nullptr ||
            plan.stt_active_node_mask_len != static_cast<uint64_t>(ctx.mesh.n_nodes)) {
            error = "stt_active_node_mask length must match FEM node count";
            return false;
        }
        ctx.stt.active_node_mask.assign(
            plan.stt_active_node_mask,
            plan.stt_active_node_mask + plan.stt_active_node_mask_len);
    }
    if (plan.stt_active_element_mask != nullptr || plan.stt_active_element_mask_len != 0) {
        if (plan.stt_active_element_mask == nullptr ||
            plan.stt_active_element_mask_len != static_cast<uint64_t>(ctx.mesh.n_elements)) {
            error = "stt_active_element_mask length must match FEM element count";
            return false;
        }
        ctx.stt.active_element_mask.assign(
            plan.stt_active_element_mask,
            plan.stt_active_element_mask + plan.stt_active_element_mask_len);
    }

    if (ctx.stt.slonczewski_enabled &&
        ctx.stt.formula_version == FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V1) {
        if (ctx.stt.realization_version ==
            FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_INTERFACE_FLUX_V1) {
            error = "slonczewski_interface_flux.v1 requires a dedicated FEM oriented surface functional and is fail-closed";
            return false;
        }
        if (ctx.stt.realization_version !=
            FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_THIN_LAYER_V1) {
            error = "canonical Slonczewski requires thin-layer realization v1";
            return false;
        }
        if (!(ctx.stt.free_layer_thickness > 0.0)) {
            error = "canonical Slonczewski thin-layer realization requires explicit free-layer thickness";
            return false;
        }
        const double normal_len = vector_norm3(
            ctx.stt.stack_normal[0], ctx.stt.stack_normal[1], ctx.stt.stack_normal[2]);
        if (!std::isfinite(normal_len) || normal_len <= 1e-30) {
            error = "canonical Slonczewski stack normal must be finite and non-zero";
            return false;
        }
        for (double &component : ctx.stt.stack_normal) {
            component /= normal_len;
        }
    } else if (ctx.stt.zhang_li_enabled &&
               ctx.stt.formula_version == FULLMAG_FEM_STT_FORMULA_ZHANG_LI_V1) {
        if (ctx.stt.operator_version != FULLMAG_FEM_STT_OPERATOR_ZL_CENTRAL_REFERENCE_V1) {
            error = "canonical FEM Zhang-Li requires zl_central_reference_v1";
            return false;
        }
        if (!std::isfinite(ctx.stt.lande_g) || ctx.stt.lande_g <= 0.0) {
            error = "canonical Zhang-Li lande_g must be finite and positive";
            return false;
        }
    } else if (ctx.stt.formula_version != FULLMAG_FEM_STT_FORMULA_LEGACY_FULLMAG_V0) {
        error = "unsupported FEM STT formula version";
        return false;
    }

    if (ctx.stt.slonczewski_enabled) {
        const double len = vector_norm3(
            ctx.stt.spin_polarization[0],
            ctx.stt.spin_polarization[1],
            ctx.stt.spin_polarization[2]);
        if (!std::isfinite(len) || len <= 1e-30) {
            error = "stt_spin_polarization must be finite and non-zero";
            return false;
        }
        ctx.stt.spin_polarization[0] /= len;
        ctx.stt.spin_polarization[1] /= len;
        ctx.stt.spin_polarization[2] /= len;
    }
    return true;
}

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    SttWorkspace workspace;
    prepare_stt_workspace(workspace, rhs_xyz.size(), rhs_xyz.size() / 3u);
    add_stt_rhs_aos(ctx, m_xyz, rhs_xyz, max_rhs, workspace);
}

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs,
    SttWorkspace &workspace)
{
    if (!ctx.stt.slonczewski_enabled && !ctx.stt.zhang_li_enabled) {
        return;
    }

    add_slonczewski_stt_rhs_aos(ctx, m_xyz, rhs_xyz);
    if (ctx.stt.zhang_li_enabled) {
        add_zhang_li_stt_rhs_aos(ctx, m_xyz, rhs_xyz, workspace.zhang_li);
    }

    max_rhs = 0.0;
    const size_t n = rhs_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        max_rhs = std::max(
            max_rhs,
            vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
    }
}

} // namespace fullmag::fem
