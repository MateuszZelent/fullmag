/*
 * GPU RK facade source contract.
 *
 * This source owns GPU RK planning helpers, exchange-only device-resident
 * readiness checks, STT thickness fallback geometry, and GPU-side plan
 * metadata for stage execution. It does not own Context construction, CPU explicit RK stages, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints.
 */

#include "gpu_rk.hpp"

#include "context.hpp"
#include "gpu_exchange.hpp"
#include "gpu_state.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>

namespace fullmag::fem {

uint32_t gpu_rk_stage_count(fullmag_fem_integrator integrator)
{
    return gpu_state_stage_count(integrator);
}

double gpu_rk_resolve_slonczewski_thickness(const Context &ctx)
{
    if (ctx.stt.free_layer_thickness > 0.0 &&
        std::isfinite(ctx.stt.free_layer_thickness)) {
        return ctx.stt.free_layer_thickness;
    }

    const double jx = ctx.stt.current_density_am2[0];
    const double jy = ctx.stt.current_density_am2[1];
    const double jz = ctx.stt.current_density_am2[2];
    const double j_norm = std::sqrt(jx * jx + jy * jy + jz * jz);
    const size_t expected_coord_len = static_cast<size_t>(ctx.mesh.n_nodes) * 3u;
    if (!(j_norm > 0.0) || !std::isfinite(j_norm) ||
        ctx.mesh.nodes_xyz.size() != expected_coord_len) {
        return 0.0;
    }

    const double ax = jx / j_norm;
    const double ay = jy / j_norm;
    const double az = jz / j_norm;
    double min_proj = std::numeric_limits<double>::infinity();
    double max_proj = -std::numeric_limits<double>::infinity();
    bool any = false;
    for (size_t node = 0; node < static_cast<size_t>(ctx.mesh.n_nodes); ++node) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const size_t base = node * 3u;
        const double proj =
            ctx.mesh.nodes_xyz[base + 0u] * ax +
            ctx.mesh.nodes_xyz[base + 1u] * ay +
            ctx.mesh.nodes_xyz[base + 2u] * az;
        if (!std::isfinite(proj)) {
            return 0.0;
        }
        min_proj = std::min(min_proj, proj);
        max_proj = std::max(max_proj, proj);
        any = true;
    }

    const double hmax_floor =
        ctx.base_plan.hmax > 0.0 && std::isfinite(ctx.base_plan.hmax) ? ctx.base_plan.hmax : 1.0e-30;
    if (!any) {
        return std::max(hmax_floor, 1.0e-30);
    }
    return std::max(max_proj - min_proj, std::max(hmax_floor, 1.0e-30));
}

GpuRkPlan gpu_rk_plan_exchange_only(const Context &ctx, std::string &reason)
{
    GpuRkPlan plan{};
    plan.stage_count = gpu_rk_stage_count(ctx.base_plan.integrator);

    if (!ctx.gpu_state.allocated) {
        reason = "GPU RK exchange-only path requires allocated FemGpuState";
        return plan;
    }
    if (ctx.gpu_state.node_count != ctx.mesh.n_nodes ||
        ctx.gpu_state.dof_len != static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull) {
        reason = "GPU RK exchange-only path requires FemGpuState dimensions to match Context";
        return plan;
    }
    if (!ctx.exchange.enabled) {
        reason = "GPU RK exchange-only path requires enable_exchange=true";
        return plan;
    }
    if ((ctx.dmi.interfacial_enabled || ctx.dmi.bulk_enabled) &&
        (!ctx.gpu_state.mesh_geometry_uploaded ||
            ctx.gpu_state.mesh_element_count != ctx.mesh.n_elements)) {
        reason = "GPU RK exchange-only path requires device-resident mesh geometry for DMI";
        return plan;
    }
    if (ctx.magnetoelastic.enabled) {
        const uint64_t per_node_strain_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 6ull;
        if (ctx.magnetoelastic.uniform_strain && ctx.magnetoelastic.strain_voigt.size() < 6u) {
            reason = "GPU RK exchange-only path requires magnetoelastic strain data";
            return plan;
        }
        if (!ctx.magnetoelastic.uniform_strain &&
            static_cast<uint64_t>(ctx.magnetoelastic.strain_voigt.size()) != per_node_strain_len) {
            reason = "GPU RK exchange-only path requires 6 magnetoelastic strain Voigt values per node";
            return plan;
        }
        if (!ctx.magnetoelastic.uniform_strain &&
            (!ctx.gpu_state.mel_strain_uploaded ||
                ctx.gpu_state.mel_strain_voigt_len != per_node_strain_len)) {
            reason = "GPU RK exchange-only path requires device-resident per-node magnetoelastic strain";
            return plan;
        }
    }
    if ((ctx.oersted.has_cylinder || ctx.oersted.has_explicit_field) && ctx.oersted.h_xyz.empty()) {
        reason = "GPU RK exchange-only path requires precomputed Oersted field data";
        return plan;
    }
    if (ctx.thermal_brown.temperature > 0.0 && ctx.thermal_brown.seed == 0) {
        reason = "GPU RK exchange-only path requires deterministic thermal seed for device thermal field";
        return plan;
    }
    if (ctx.stt.zhang_li_enabled &&
        (!ctx.gpu_state.mesh_geometry_uploaded ||
            ctx.gpu_state.mesh_element_count != ctx.mesh.n_elements)) {
        reason = "GPU RK exchange-only path requires device-resident mesh geometry for Zhang-Li STT";
        return plan;
    }
    if (ctx.stt.slonczewski_enabled && gpu_rk_resolve_slonczewski_thickness(ctx) <= 0.0) {
        reason = "GPU RK exchange-only path requires explicit or geometry-derived Slonczewski free-layer thickness";
        return plan;
    }
    const bool integrator_supported =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_HEUN ||
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK4 ||
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS ||
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54;
    if (!integrator_supported) {
        reason = "GPU RK exchange-only path currently supports Heun, RK4, RK23, and RK45 only";
        return plan;
    }

    std::string exchange_reason;
    const auto exchange_plan = gpu_exchange_plan_stage_exchange(ctx, exchange_reason);
    plan.stage_exchange_device_resident = exchange_plan.stage_exchange_device_resident;
    plan.exchange_operator_mode = exchange_plan.operator_mode;
    if (!exchange_plan.stage_exchange_device_resident) {
#if FULLMAG_HAS_CUDA_RUNTIME
    plan.uses_cuda_kernels = true;
    plan.allows_exchange_host_sync = true;
    reason =
        "GPU RK exchange-only path has CUDA kernel call sites but is not enabled "
        "until stage H_ex is recomputed device-resident (" + exchange_reason +
        ") and CUDA/MFEM parity is verified";
#else
    reason = exchange_reason;
#endif
    return plan;
    }

    plan.enabled = true;
    plan.uses_cuda_kernels = true;
    plan.allows_exchange_host_sync = false;
    reason.clear();
    return plan;
}

#if !FULLMAG_HAS_CUDA_RUNTIME
bool gpu_rk_exchange_only_step(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    (void)ctx;
    (void)tableau;
    (void)dt_seconds;
    stats = {};
    reason = "GPU RK exchange-only step requires CUDA runtime support";
    return false;
}

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    (void)ctx;
    (void)stats;
    (void)reason;
    return true;
}
#endif

} // namespace fullmag::fem
