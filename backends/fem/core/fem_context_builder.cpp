/*
 * FEM Context builder source contract.
 *
 * This source owns the construction sequence for a native FEM Context from the
 * C ABI plan. It composes core plan import, interaction plan import, runtime
 * setup, device metadata, demag initialization, initial effective-field refresh,
 * and GPU-state bootstrap. It does not own the individual import helpers,
 * runtime lifecycle internals, device policy, integrator stage mechanics, or
 * interaction physics.
 */

#include "core/fem_context_builder.hpp"

#include "context.hpp"
#include "core/fem_field_buffers.hpp"
#include "core/fem_material_fields.hpp"
#include "core/fem_material_runtime.hpp"
#include "core/fem_mesh.hpp"
#include "core/fem_plan_fields.hpp"
#include "core/fem_state.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/interactions/sot.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/field_refresh.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {

bool build_context_from_plan(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (!initialize_base_plan_fields(ctx, plan, error)) {
        return false;
    }
    if (!initialize_field_refresh_plan_fields(ctx, plan.field_refresh, error)) {
        return false;
    }
    if (!validate_relax_stop_config(plan.relax_stop, error)) {
        return false;
    }
    initialize_stage_completion_state(ctx, plan.relax_stop);
    initialize_exchange_plan_fields(ctx, plan);
    initialize_demag_plan_fields(ctx, plan);
    initialize_zeeman_plan_fields(ctx, plan);
    if (!copy_regional_field_drive_plan(ctx, plan, error)) {
        return false;
    }
    if (!initialize_mesh_plan_fields(ctx, plan.mesh, error)) {
        return false;
    }
    if (!validate_supported_physics_topology(ctx, plan, error)) {
        return false;
    }
    initialize_magnetic_masks(ctx);
    if (!validate_magnetic_mesh_has_active_region(ctx, error)) {
        return false;
    }

    initialize_anisotropy_plan_fields(ctx, plan);
    initialize_dmi_plan_fields(ctx, plan);
    initialize_material_plan_fields(ctx, plan);
    if (!initialize_stt_plan_fields(ctx, plan, error)) {
        return false;
    }
    if (!initialize_sot_plan_fields(ctx, plan, error)) {
        return false;
    }

    initialize_mfem_device_plan_fields(ctx, plan);

    if (!validate_material_fields(ctx, error)) {
        return false;
    }

    if (!initialize_material_runtime(ctx, error)) {
        return false;
    }

    if (!normalize_anisotropy_axes(ctx, error)) {
        return false;
    }

    if (!initialize_adaptive_dt_plan_fields(ctx, plan, error)) {
        return false;
    }

    if (!initialize_state_plan_fields(ctx, plan, error)) {
        return false;
    }
    const std::size_t true_dofs = static_cast<std::size_t>(
        ctx.mesh.periodic_reduced_node_count > 0
            ? ctx.mesh.periodic_reduced_node_count
            : ctx.mesh.n_nodes);
    const std::size_t active_candidates = ctx.mesh.magnetic_node_mask.empty()
        ? true_dofs
        : static_cast<std::size_t>(std::count_if(
            ctx.mesh.magnetic_node_mask.begin(),
            ctx.mesh.magnetic_node_mask.end(),
            [](uint8_t v) { return v != 0; }));

    const char *fingerprint = "mesh_p1_v1";
    if (!ctx.frozen_spins.import_descriptor(
            plan.frozen_mask,
            plan.frozen_mask_len,
            plan.frozen_reference_xyz,
            plan.frozen_reference_len,
            true_dofs,
            active_candidates,
            fingerprint,
            error)) {
        return false;
    }
    if (ctx.frozen_spins.enabled()) {
        ctx.frozen_spins.project_onto_reference(ctx.state.m_xyz);
    }
    if (!std::isfinite(plan.stage_start_time_s) || plan.stage_start_time_s < 0.0) {
        error = "stage_start_time_s must be finite and non-negative";
        return false;
    }
    ctx.state.current_time = plan.stage_start_time_s;

    // Precompute per-node dual volumes for thermal noise after mesh masks exist.
    compute_node_volumes(ctx);

    if (!project_regional_field_drive_bases(ctx, error)) {
        return false;
    }

    initialize_uniform_zeeman_field(ctx);
    initialize_context_field_buffers(ctx);

    if (!initialize_oersted_plan_fields(ctx, plan, error)) {
        return false;
    }

    initialize_thermal_brown_plan_fields(ctx, plan);

    context_populate_device_info(ctx);

    initialize_magnetoelastic_plan_fields(ctx, plan);

    if (!validate_elementwise_ms_runtime_support(ctx, error)) {
        return false;
    }
    if (!ctx.base_plan.precession_enabled && has_relax_stop_criteria(ctx) &&
        !validate_elementwise_ms_relaxation_support(ctx, error)) {
        return false;
    }

    if (!validate_periodic_plan_compatibility(ctx, error)) {
        return false;
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!context_initialize_mfem(ctx, error)) {
        return false;
    }
    if (!initialize_demag_runtime(ctx, error)) {
        return false;
    }
    if (!refresh_initial_effective_field_from_plan(ctx, plan, error)) {
        return false;
    }
    context_populate_device_info(ctx);
#endif
    if (!initialize_context_gpu_state(ctx, error)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
