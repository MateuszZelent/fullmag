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
        return true;
    }
    return initialize_oersted_cylinder_field(ctx, error);
}

void add_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (ctx.oersted.has_cylinder) {
        add_oersted_cylinder_field(ctx, h_eff_xyz);
        return;
    }
    add_explicit_oersted_field(ctx, h_eff_xyz);
}

} // namespace fullmag::fem
