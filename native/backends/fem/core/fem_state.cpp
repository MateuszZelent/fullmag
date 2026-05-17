#include "core/fem_state.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

namespace fullmag::fem {

bool initialize_state_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (plan.initial_magnetization_xyz == nullptr) {
        error = "initial magnetization pointer is null";
        return false;
    }
    const uint64_t expected_m_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (plan.initial_magnetization_len != expected_m_len) {
        error = "initial magnetization length mismatch";
        return false;
    }

    ctx.step_count = 0;
    ctx.current_time = 0.0;
    ctx.m_xyz.assign(
        plan.initial_magnetization_xyz,
        plan.initial_magnetization_xyz + static_cast<size_t>(plan.initial_magnetization_len));
    project_static_periodic_aos(ctx, ctx.m_xyz);
    return true;
}

} // namespace fullmag::fem
