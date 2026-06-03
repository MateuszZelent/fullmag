/*
 * FEM state core source contract.
 *
 * This source owns initial magnetization pointer/length validation, state copy,
 * static-periodic magnetization projection, and time/step reset during native
 * FEM Context construction. It does not import mesh topology, material coefficients, field buffers, runtime devices, or interaction physics.
 */

#include "core/fem_state.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

#include <utility>
#include <vector>

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
    const uint64_t expected_m_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (plan.initial_magnetization_len != expected_m_len) {
        error = "initial magnetization length mismatch";
        return false;
    }

    std::vector<double> initial_m(
        plan.initial_magnetization_xyz,
        plan.initial_magnetization_xyz + static_cast<size_t>(plan.initial_magnetization_len));
    project_static_periodic_aos(ctx, initial_m);
    if (!normalize_active_magnetization_aos(ctx, initial_m, error)) {
        error = "initial magnetization normalization failed: " + error;
        return false;
    }
    ctx.state.step_count = 0;
    ctx.state.current_time = 0.0;
    ctx.state.m_xyz = std::move(initial_m);
    return true;
}

} // namespace fullmag::fem
