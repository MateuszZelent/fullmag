#include "context.hpp"
#include "core/fem_field_buffers.hpp"
#include "core/fem_material_fields.hpp"
#include "core/fem_mesh.hpp"
#include "core/fem_state.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/field_refresh.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem {

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error) {
    if (plan.mesh.n_nodes == 0) {
        error = "FEM mesh must contain at least one node";
        return false;
    }
    if (plan.mesh.n_elements == 0) {
        error = "FEM mesh must contain at least one tetrahedral element";
        return false;
    }
    if (plan.mesh.nodes_xyz == nullptr) {
        error = "FEM mesh nodes pointer is null";
        return false;
    }
    if (plan.mesh.elements == nullptr) {
        error = "FEM mesh elements pointer is null";
        return false;
    }
    if (plan.dt_seconds <= 0.0) {
        error = "FEM time step must be positive";
        return false;
    }
    if (plan.fe_order != 1) {
        error = "native FEM CPU backend supports P1 tetrahedral elements only (fe_order = 1). Requested fe_order = " +
                std::to_string(plan.fe_order);
        return false;
    }
    switch (plan.integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:
        case FULLMAG_FEM_INTEGRATOR_RK4:
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54:
            break;
        default:
            error = "native FEM plan requested an unsupported explicit RK integrator";
            return false;
    }
    if (!initialize_field_refresh_plan_fields(ctx, plan.field_refresh, error)) {
        return false;
    }
    if (!validate_relax_stop_config(plan.relax_stop, error)) {
        return false;
    }
    ctx.n_nodes = plan.mesh.n_nodes;
    ctx.n_elements = plan.mesh.n_elements;
    ctx.n_boundary_faces = plan.mesh.n_boundary_faces;
    ctx.fe_order = plan.fe_order;
    ctx.hmax = plan.hmax;
    ctx.dt_seconds = plan.dt_seconds;
    ctx.current_dt = plan.dt_seconds;
    ctx.air_box_factor = plan.air_box_factor;
    initialize_stage_completion_state(ctx, plan.relax_stop);
    ctx.precision = plan.precision;
    ctx.integrator = plan.integrator;
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

    // FND-013: read consistent-mass flag from plan.
    // ctx.use_consistent_mass = (plan.use_consistent_mass != 0);

    const bool consistent_mass_requested = plan.use_consistent_mass != 0;
    if (!validate_periodic_plan_compatibility(ctx, error)) {
        return false;
    }

#if FULLMAG_HAS_MFEM_STACK
    ctx.use_consistent_mass = consistent_mass_requested;
    if (!context_initialize_mfem(ctx, error)) {
        return false;
    }
    // Initialize the requested demag operator only after the shared MFEM mesh is ready.
    if (ctx.enable_demag &&
        (ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET ||
         ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN)) {
        if (!context_initialize_poisson(ctx, error)) {
            return false;
        }
    } else if (ctx.enable_demag &&
               ctx.demag_realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        if (!context_initialize_demag_fem_bem(ctx, error)) {
            return false;
        }
    } else if (ctx.enable_demag) {
        error = "unsupported native FEM demag realization";
        return false;
    }
    if (plan.eager_initial_effective_field != 0 &&
        (ctx.enable_exchange || ctx.enable_demag) &&
        !context_refresh_exchange_field_mfem(ctx, error)) {
        return false;
    }
    context_populate_device_info(ctx);
#endif
    bool allocate_gpu_state = false;
#if FULLMAG_HAS_CUDA_RUNTIME
    allocate_gpu_state = ctx.device_info_cache.is_gpu_enabled != 0;
#endif
    if (!gpu_state_initialize(
            ctx.gpu_state,
            ctx.n_nodes,
            ctx.integrator,
            allocate_gpu_state,
            ctx.m_xyz.data(),
            static_cast<uint64_t>(ctx.m_xyz.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    if (!gpu_state_upload_runtime_coefficients(
            ctx.gpu_state,
            ctx.node_volumes.data(),
            static_cast<uint64_t>(ctx.node_volumes.size()),
            ctx.Ms_field.data(),
            static_cast<uint64_t>(ctx.Ms_field.size()),
            ctx.material.saturation_magnetisation,
            ctx.A_field.data(),
            static_cast<uint64_t>(ctx.A_field.size()),
            ctx.material.exchange_stiffness,
            ctx.alpha_field.data(),
            static_cast<uint64_t>(ctx.alpha_field.size()),
            ctx.material.damping,
            ctx.Ku_field.data(),
            static_cast<uint64_t>(ctx.Ku_field.size()),
            ctx.Ku2_field.data(),
            static_cast<uint64_t>(ctx.Ku2_field.size()),
            ctx.Dind_field.data(),
            static_cast<uint64_t>(ctx.Dind_field.size()),
            ctx.Dbulk_field.data(),
            static_cast<uint64_t>(ctx.Dbulk_field.size()),
            ctx.Kc1_field.data(),
            static_cast<uint64_t>(ctx.Kc1_field.size()),
            ctx.Kc2_field.data(),
            static_cast<uint64_t>(ctx.Kc2_field.size()),
            ctx.Kc3_field.data(),
            static_cast<uint64_t>(ctx.Kc3_field.size()),
            ctx.magnetic_node_mask.data(),
            static_cast<uint64_t>(ctx.magnetic_node_mask.size()),
            ctx.periodic_reduced_node.data(),
            static_cast<uint64_t>(ctx.periodic_reduced_node.size()),
            ctx.periodic_representative_nodes.data(),
            static_cast<uint64_t>(ctx.periodic_representative_nodes.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    if (ctx.enable_magnetoelastic && !ctx.mel_uniform_strain) {
        if (!gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state,
                ctx.mel_strain_voigt.data(),
                static_cast<uint64_t>(ctx.mel_strain_voigt.size()),
                ctx.transfer_audit,
                error)) {
#if FULLMAG_HAS_MFEM_STACK
            context_destroy_mfem(ctx);
#endif
            return false;
        }
    }
    if (!gpu_state_upload_mesh_geometry(
            ctx.gpu_state,
            ctx.nodes_xyz.data(),
            static_cast<uint64_t>(ctx.nodes_xyz.size()),
            ctx.elements.data(),
            static_cast<uint64_t>(ctx.elements.size()),
            ctx.magnetic_element_mask.data(),
            static_cast<uint64_t>(ctx.magnetic_element_mask.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
#if FULLMAG_HAS_MFEM_STACK
    if (!context_upload_mfem_exchange_to_gpu_state(ctx, error)) {
        context_destroy_mfem(ctx);
        return false;
    }
#endif
    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.h_ex_xyz.data(),
            ctx.h_demag_xyz.data(),
            ctx.h_ext_xyz.data(),
            ctx.h_eff_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.h_ani_xyz.data(),
            ctx.h_cubic_ani_xyz.data(),
            ctx.h_dmi_xyz.data(),
            ctx.h_bulk_dmi_xyz.data(),
            ctx.h_oe_xyz.data(),
            ctx.h_therm_xyz.data(),
            ctx.h_mel_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    return true;
}

bool context_sync_gpu_magnetization_to_host(Context &ctx, std::string &error)
{
    if (!ctx.gpu_state.allocated ||
        ctx.gpu_state.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        ctx.gpu_state.host_state != FemGpuSyncState::HostStale) {
        return true;
    }
    if (!gpu_state_download_magnetization_aos(
            ctx.gpu_state,
            ctx.m_xyz,
            ctx.transfer_audit,
            error)) {
        error = "GPU magnetization readback failed: " + error;
        return false;
    }
    return true;
}

int context_copy_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error)
{
    if (out_xyz == nullptr) {
        error = "output field buffer pointer is null";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t expected_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (out_len != expected_len) {
        error = "output field length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const std::vector<double> *source = nullptr;
    switch (observable) {
        case FULLMAG_FEM_OBSERVABLE_M:
            source = &ctx.m_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EX:
            source = &ctx.h_ex_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DEMAG:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.h_demag_visual_xyz.empty() &&
                      ctx.h_demag_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.h_demag_visual_xyz
                         : &ctx.h_demag_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EXT:
            source = &ctx.h_ext_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EFF:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.h_eff_visual_xyz.empty() &&
                      ctx.h_eff_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.h_eff_visual_xyz
                         : &ctx.h_eff_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_ANI:
            source = &ctx.h_ani_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI:
            source = &ctx.h_dmi_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_MEL:
            source = &ctx.h_mel_xyz;
            break;
        // F-12 fix: added observables for cubic anisotropy, bulk DMI, Oersted, thermal
        case FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC:
            source = &ctx.h_cubic_ani_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI_BULK:
            source = &ctx.h_bulk_dmi_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_OE:
            source = &ctx.h_oe_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_THERM:
            source = &ctx.h_therm_xyz;
            break;
        default:
            error = "unsupported FEM observable";
            return FULLMAG_FEM_ERR_INVALID;
    }

    if (source == nullptr || source->size() != static_cast<size_t>(out_len)) {
        // Report an error instead of silently returning zeros when the field
        // has not been computed or has a mismatched size.
        if (source == nullptr || source->empty()) {
            error = "requested field has not been computed yet";
        } else {
            error = "field size mismatch: expected " +
                    std::to_string(out_len) + " but field has " +
                    std::to_string(source->size()) + " elements";
        }
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t bytes = sizeof(double) * out_len;
    record_device_to_host(ctx.transfer_audit, bytes);
    std::memcpy(out_xyz, source->data(), static_cast<size_t>(bytes));
    return FULLMAG_FEM_OK;
}

int context_upload_magnetization_f64(
    Context &ctx,
    const double *m_xyz,
    uint64_t len,
    std::string &error)
{
    if (m_xyz == nullptr) {
        error = "input magnetization pointer is null";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t expected_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (len != expected_len) {
        error = "input magnetization length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    ctx.m_xyz.assign(m_xyz, m_xyz + static_cast<size_t>(len));
    if (ctx.gpu_state.allocated) {
        if (!gpu_state_upload_magnetization_aos(
                ctx.gpu_state,
                ctx.m_xyz.data(),
                static_cast<uint64_t>(ctx.m_xyz.size()),
                ctx.transfer_audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    } else {
        record_host_to_device(ctx.transfer_audit, sizeof(double) * len);
    }
    ctx.stepper.fsal_valid = false;
    ctx.prev_error_norm = 1.0;
    ctx.demag_cache_valid = false;
    ctx.demag_last_refresh_time = -1.0;

#if FULLMAG_HAS_MFEM_STACK
    // FND-004 fix: delegate H_eff assembly to compute_effective_fields_for_magnetization
    // so that all terms (exchange, demag, external, anisotropy, cubic anisotropy,
    // interfacial DMI, bulk DMI, Oersted, magnetoelastic) are included after upload.
    // Thermal noise is intentionally excluded — it is refreshed in the RHS path.
    {
        std::string heff_error;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                ctx.h_ex_xyz,
                ctx.h_demag_xyz,
                ctx.h_eff_xyz,
                nullptr,   // exchange_energy — not needed on upload
                nullptr,   // demag_energy — not needed on upload
                false,     // allow_interrupt
                nullptr,   // timings
                heff_error)) {
            error = "upload_magnetization: H_eff refresh failed: " + heff_error;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }
#else
    if (!ctx.enable_exchange) {
        fill_zero_vector_field(ctx.h_ex_xyz, ctx.n_nodes);
    }
    if (!ctx.enable_demag) {
        fill_zero_vector_field(ctx.h_demag_xyz, ctx.n_nodes);
    }
    // Non-MFEM fallback: compose H_eff from available cached fields
    if (ctx.has_external_field) {
        ctx.h_eff_xyz = ctx.h_ext_xyz;
        for (size_t i = 0; i < ctx.h_eff_xyz.size(); ++i) {
            ctx.h_eff_xyz[i] += ctx.h_ex_xyz[i] + ctx.h_demag_xyz[i];
        }
    } else {
        ctx.h_eff_xyz = ctx.h_ex_xyz;
        for (size_t i = 0; i < ctx.h_eff_xyz.size(); ++i) {
            ctx.h_eff_xyz[i] += ctx.h_demag_xyz[i];
        }
    }
#endif

    // Thermal noise is refreshed in the RHS/effective-field path, not on upload.
    ctx.thermal_sigma = 0.0;
    std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
    ctx.last_thermal_refresh_time = -1.0;
    ctx.last_thermal_refresh_dt = -1.0;

    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.h_ex_xyz.data(),
            ctx.h_demag_xyz.data(),
            ctx.h_ext_xyz.data(),
            ctx.h_eff_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.h_ani_xyz.data(),
            ctx.h_cubic_ani_xyz.data(),
            ctx.h_dmi_xyz.data(),
            ctx.h_bulk_dmi_xyz.data(),
            ctx.h_oe_xyz.data(),
            ctx.h_therm_xyz.data(),
            ctx.h_mel_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    return FULLMAG_FEM_OK;
}

} // namespace fullmag::fem
