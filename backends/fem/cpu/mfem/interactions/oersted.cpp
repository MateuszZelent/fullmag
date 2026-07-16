/*
 * Oersted aggregate source contract.
 *
 * This compatibility source owns plan import, realization exclusivity, and
 * dispatch between analytical-cylinder and explicit nodal Oersted paths.
 * It does not sample analytical cylinders or add explicit nodal fields.
 */
#include "cpu/mfem/interactions/oersted.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool initialize_oersted_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    const uint64_t expected_field_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (plan.oersted_field_xyz != nullptr &&
        plan.oersted_field_len != expected_field_len) {
        error = "oersted_field_xyz length mismatch";
        return false;
    }
    if (plan.has_oersted_cylinder != 0 &&
        plan.oersted_field_xyz != nullptr &&
        plan.oersted_field_len > 0) {
        error = "oersted cylinder and explicit oersted_field_xyz are mutually exclusive";
        return false;
    }

    ctx.oersted.has_cylinder = plan.has_oersted_cylinder != 0;
    ctx.oersted.has_explicit_field = plan.oersted_field_xyz != nullptr && plan.oersted_field_len > 0;
    ctx.oersted.current = plan.oersted_current;
    ctx.oersted.radius = plan.oersted_radius;
    for (int i = 0; i < 3; ++i) {
        ctx.oersted.center[i] = plan.oersted_center[i];
        ctx.oersted.axis[i] = plan.oersted_axis[i];
    }
    if (!normalize_oersted_cylinder_axis(ctx, error)) {
        return false;
    }
    ctx.oersted.time_dep_kind = plan.oersted_time_dep_kind;
    ctx.oersted.time_dep_freq = plan.oersted_time_dep_freq;
    ctx.oersted.time_dep_phase = plan.oersted_time_dep_phase;
    ctx.oersted.time_dep_offset = plan.oersted_time_dep_offset;
    ctx.oersted.time_dep_t_on = plan.oersted_time_dep_t_on;
    ctx.oersted.time_dep_t_off = plan.oersted_time_dep_t_off;

    if (ctx.oersted.has_explicit_field) {
        ctx.oersted.h_xyz.assign(
            plan.oersted_field_xyz,
            plan.oersted_field_xyz + static_cast<size_t>(plan.oersted_field_len));
        ctx.oersted.h_basis_per_ampere_xyz.clear();
        return true;
    }
    if (!initialize_oersted_cylinder_field(ctx, error)) {
        return false;
    }
    materialize_oersted_field(ctx, ctx.state.current_time);
    return true;
}

const std::vector<double> &materialize_oersted_field(
    Context &ctx,
    double evaluation_time_s)
{
    if (!ctx.oersted.has_cylinder) {
        return ctx.oersted.h_xyz;
    }
    const double scale = oersted_current_scale(ctx, evaluation_time_s);
    ctx.oersted.h_xyz.resize(ctx.oersted.h_basis_per_ampere_xyz.size());
    for (size_t i = 0; i < ctx.oersted.h_xyz.size(); ++i) {
        ctx.oersted.h_xyz[i] = scale * ctx.oersted.h_basis_per_ampere_xyz[i];
    }
    return ctx.oersted.h_xyz;
}

void add_oersted_field(
    const Context &ctx,
    double evaluation_time_s,
    std::vector<double> &h_eff_xyz)
{
    const auto &h_oe_xyz = materialize_oersted_field(
        const_cast<Context &>(ctx), evaluation_time_s);
    const size_t count = std::min(h_eff_xyz.size(), h_oe_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += h_oe_xyz[i];
    }
}

} // namespace fullmag::fem
