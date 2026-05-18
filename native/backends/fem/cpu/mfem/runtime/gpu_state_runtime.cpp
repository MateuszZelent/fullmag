/*
 * GPU-state runtime source contract.
 *
 * This source owns GPU-state bootstrap, runtime coefficient upload, host-resident
 * fallback metadata, and teardown coordination when bootstrap fails. It does not choose MFEM devices, assemble exchange operators, execute RK stages, or own state I/O.
 */

#include "cpu/mfem/runtime/gpu_state_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu_state.hpp"

#include <cstdint>

namespace fullmag::fem {

namespace {

bool gpu_bootstrap_failed(Context &ctx) {
#if FULLMAG_HAS_MFEM_STACK
    context_destroy_mfem(ctx);
#else
    (void)ctx;
#endif
    return false;
}

} // namespace

bool initialize_context_gpu_state(Context &ctx, std::string &error) {
    bool allocate_gpu_state = false;
#if FULLMAG_HAS_CUDA_RUNTIME
    allocate_gpu_state = ctx.mfem_device.device_info_cache.is_gpu_enabled != 0;
#endif
    if (!gpu_state_initialize(
            ctx.gpu_state,
            ctx.mesh.n_nodes,
            ctx.base_plan.integrator,
            allocate_gpu_state,
            ctx.demag.enabled,
            ctx.state.m_xyz.data(),
            static_cast<uint64_t>(ctx.state.m_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
    if (!gpu_state_upload_runtime_coefficients(
            ctx.gpu_state,
            ctx.mesh.node_volumes.data(),
            static_cast<uint64_t>(ctx.mesh.node_volumes.size()),
            ctx.material_fields.Ms_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Ms_field.size()),
            ctx.material_fields.material.saturation_magnetisation,
            ctx.material_fields.A_field.data(),
            static_cast<uint64_t>(ctx.material_fields.A_field.size()),
            ctx.material_fields.material.exchange_stiffness,
            ctx.material_fields.alpha_field.data(),
            static_cast<uint64_t>(ctx.material_fields.alpha_field.size()),
            ctx.material_fields.material.damping,
            ctx.material_fields.Ku_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Ku_field.size()),
            ctx.material_fields.Ku2_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Ku2_field.size()),
            ctx.material_fields.Dind_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Dind_field.size()),
            ctx.material_fields.Dbulk_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Dbulk_field.size()),
            ctx.material_fields.Kc1_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Kc1_field.size()),
            ctx.material_fields.Kc2_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Kc2_field.size()),
            ctx.material_fields.Kc3_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Kc3_field.size()),
            ctx.mesh.magnetic_node_mask.data(),
            static_cast<uint64_t>(ctx.mesh.magnetic_node_mask.size()),
            ctx.mesh.periodic_reduced_node.data(),
            static_cast<uint64_t>(ctx.mesh.periodic_reduced_node.size()),
            ctx.mesh.periodic_representative_nodes.data(),
            static_cast<uint64_t>(ctx.mesh.periodic_representative_nodes.size()),
            ctx.transfer_audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
    if (ctx.magnetoelastic.enabled && !ctx.magnetoelastic.uniform_strain) {
        if (!gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state,
                ctx.magnetoelastic.strain_voigt.data(),
                static_cast<uint64_t>(ctx.magnetoelastic.strain_voigt.size()),
                ctx.transfer_audit,
                error)) {
            return gpu_bootstrap_failed(ctx);
        }
    }
    if (!gpu_state_upload_mesh_geometry(
            ctx.gpu_state,
            ctx.mesh.nodes_xyz.data(),
            static_cast<uint64_t>(ctx.mesh.nodes_xyz.size()),
            ctx.mesh.elements.data(),
            static_cast<uint64_t>(ctx.mesh.elements.size()),
            ctx.mesh.magnetic_element_mask.data(),
            static_cast<uint64_t>(ctx.mesh.magnetic_element_mask.size()),
            ctx.transfer_audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
#if FULLMAG_HAS_MFEM_STACK
    if (!context_upload_mfem_exchange_to_gpu_state(ctx, error)) {
        context_destroy_mfem(ctx);
        return false;
    }
#endif
    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.exchange.h_xyz.data(),
            ctx.demag.h_xyz.data(),
            ctx.zeeman.h_ext_xyz.data(),
            ctx.effective_field.h_xyz.data(),
            static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.anisotropy.h_uniaxial_xyz.data(),
            ctx.anisotropy.h_cubic_xyz.data(),
            ctx.dmi.h_interfacial_xyz.data(),
            ctx.dmi.h_bulk_xyz.data(),
            ctx.oersted.h_xyz.data(),
            ctx.thermal_brown.h_xyz.data(),
            ctx.magnetoelastic.h_xyz.data(),
            static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
    return true;
}

} // namespace fullmag::fem
