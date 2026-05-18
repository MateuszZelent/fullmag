/*
 * FEM Context facade source contract.
 *
 * This source owns high-level Context construction orchestration: sequencing
 * core plan import, interaction plan import, runtime setup, device metadata,
 * demag initialization, initial effective-field refresh, and GPU-state setup. It does not own base/core import helpers, runtime lifecycle, device policy, integrator stage mechanics, or interaction physics.
 */

#include "context.hpp"
#include "core/fem_field_buffers.hpp"
#include "core/fem_material_fields.hpp"
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
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/field_refresh.hpp"
#include "cpu/mfem/runtime/gpu_state_runtime.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"

namespace fullmag::fem {

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error) {
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
    if (!initialize_mesh_plan_fields(ctx, plan.mesh, error)) {
        return false;
    }
    initialize_anisotropy_plan_fields(ctx, plan);
    initialize_dmi_plan_fields(ctx, plan);
    initialize_material_plan_fields(ctx, plan);
    if (!initialize_stt_plan_fields(ctx, plan, error)) {
        return false;
    }

    if (!validate_material_fields(ctx, error)) {
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

    initialize_magnetic_masks(ctx);

    // Precompute per-node dual volumes for thermal noise (must come after
    // magnetic_element_mask and elements are populated).
    compute_node_volumes(ctx);

    initialize_uniform_zeeman_field(ctx);
    initialize_context_field_buffers(ctx);

    if (!initialize_oersted_plan_fields(ctx, plan, error)) {
        return false;
    }

    initialize_thermal_brown_plan_fields(ctx, plan);

    context_populate_device_info(ctx);

    initialize_magnetoelastic_plan_fields(ctx, plan);

    initialize_mfem_device_plan_fields(ctx, plan);

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
